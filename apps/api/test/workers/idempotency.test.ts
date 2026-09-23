/**
 * The idempotency middleware (increment 4, reworked in increment 8 to the IETF draft's semantics,
 * ruling K1): the global slot's behaviour through `createApp()`, the memory and Postgres stores
 * directly, and the request hash. The `/v1` instance's behaviour on a real route (replay, 409,
 * 422, a stored 403) is asserted by flights.subscribe.test.ts through `exports.default.fetch()`.
 *
 * Every app in the first half comes from `createApp()` in `src/app.ts`, which is the same
 * function `src/index.ts` calls, so the middleware under test sits where the Worker puts it:
 * after request-id, sentry, cors and rate-limit, and BEFORE the auth middleware. The previous
 * version of this file built its own Hono app with the auth placeholder registered first and
 * claimed the order was "reproduced exactly"; it was the inverse, and that inversion let a chain
 * that 500s on every keyed POST ship with a green suite.
 *
 * Because the slot is ahead of auth, no request in the global slot ever has a user. The scope is
 * the `X-Install-Id` header, and the tests below pin the two properties that header was chosen
 * for and that the client IP (the previous scope) did not have: two installs never share a
 * bucket, and one install keeps replaying after its IP changes.
 */

import { env, exports } from 'cloudflare:workers';
import { sql } from 'drizzle-orm';
import { openDb } from '@planeahead/db';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createApp } from '../../src/app';
import type { AppBindings } from '../../src/env';
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_REPLAYED_HEADER,
  INSTALL_ID_HEADER,
  IN_FLIGHT_STATUS,
  type IdempotencyStore,
  canonicalJson,
  canonicalPath,
  createDbIdempotencyStore,
  createMemoryIdempotencyStore,
  hashValidatedRequest,
  idempotency,
  idempotencyGate,
  isStorableResponse,
  isValidIdempotencyKey,
  isValidInstallId,
  scopeFor,
  storeFor,
} from '../../src/middleware/idempotency';
import { signInAnonymously } from './helpers/auth';

const INSTALL_A = 'install-aaaa-0001';
const INSTALL_B = 'install-bbbb-0002';

let store: IdempotencyStore;
let handlerCalls = 0;
let releaseSlow: Promise<void> = Promise.resolve();

function app(): Hono<AppBindings> {
  const instance = createApp({ idempotencyStore: () => store });
  instance.post('/things', async (c) => {
    handlerCalls += 1;
    const body = await c.req.json<{ name?: string }>();
    return c.json({ created: handlerCalls, name: body.name ?? null }, 201);
  });
  instance.post('/boom', () => {
    handlerCalls += 1;
    throw new Error('handler exploded');
  });
  instance.post('/refuse', (c) => {
    handlerCalls += 1;
    return c.json({ error: 'cap_exceeded', created: handlerCalls }, 403);
  });
  instance.post('/slow', async (c) => {
    handlerCalls += 1;
    await releaseSlow;
    return c.json({ created: handlerCalls }, 201);
  });
  instance.get('/things', (c) => {
    handlerCalls += 1;
    return c.json({ read: handlerCalls });
  });
  return instance;
}

interface PostOptions {
  readonly path?: string;
  /** Defaults to `INSTALL_A`; `null` sends no `X-Install-Id` at all. */
  readonly installId?: string | null;
  readonly ip?: string;
}

function post(key: string | undefined, body: unknown, options: PostOptions = {}): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key !== undefined) {
    headers[IDEMPOTENCY_KEY_HEADER] = key;
  }
  const installId = options.installId === undefined ? INSTALL_A : options.installId;
  if (installId !== null) {
    headers[INSTALL_ID_HEADER] = installId;
  }
  if (options.ip !== undefined) {
    headers['CF-Connecting-IP'] = options.ip;
  }
  return new Request(`https://api.planeahead.test${options.path ?? '/things'}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  store = createMemoryIdempotencyStore();
  handlerCalls = 0;
});

describe('idempotency replay', () => {
  it('returns the stored response and does not run the handler again', async () => {
    const instance = app();
    const key = 'replay-key-0001';

    const first = await instance.fetch(post(key, { name: 'AA100' }), env);
    const second = await instance.fetch(post(key, { name: 'AA100' }), env);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await first.json()).toEqual({ created: 1, name: 'AA100' });
    expect(await second.json()).toEqual({ created: 1, name: 'AA100' });
    expect(handlerCalls).toBe(1);
  });

  it('marks the replay with a header so a client can tell', async () => {
    const instance = app();
    const key = 'replay-key-0002';

    const first = await instance.fetch(post(key, { name: 'AA100' }), env);
    const second = await instance.fetch(post(key, { name: 'AA100' }), env);

    expect(first.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBeNull();
    expect(second.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBe('true');
  });

  it('rejects the same key used for a different request body', async () => {
    const instance = app();
    const key = 'replay-key-0003';

    await instance.fetch(post(key, { name: 'AA100' }), env);
    const reused = await instance.fetch(post(key, { name: 'UA200' }), env);
    const body = await reused.json<{ error: string }>();

    expect(reused.status).toBe(422);
    expect(body.error).toBe('idempotency_payload_mismatch');
    expect(handlerCalls).toBe(1);
  });

  it('answers 409 in_flight to a duplicate that arrives while the first is still running', async () => {
    const instance = app();
    const key = 'in-flight-key-0001';
    let open: () => void = () => undefined;
    releaseSlow = new Promise<void>((resolve) => {
      open = resolve;
    });

    const first = instance.fetch(post(key, { name: 'AA100' }, { path: '/slow' }), env);
    // Let the first request reach its handler before the duplicate arrives.
    while (handlerCalls === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const duplicate = await instance.fetch(post(key, { name: 'AA100' }, { path: '/slow' }), env);
    open();
    const settled = await first;

    expect(duplicate.status).toBe(409);
    expect((await duplicate.json<{ error: string }>()).error).toBe('in_flight');
    expect(settled.status).toBe(201);
    expect(handlerCalls).toBe(1);
    // Completed now: the same request replays.
    const replay = await instance.fetch(post(key, { name: 'AA100' }, { path: '/slow' }), env);
    expect(replay.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBe('true');
  });

  it('stores a terminal 4xx, so the outbox replay gets the same refusal', async () => {
    const instance = app();
    const key = 'refusal-key-00001';

    const first = await instance.fetch(post(key, {}, { path: '/refuse' }), env);
    const second = await instance.fetch(post(key, {}, { path: '/refuse' }), env);

    expect(first.status).toBe(403);
    expect(second.status).toBe(403);
    expect(second.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBe('true');
    expect(await second.json()).toEqual(await first.json());
    expect(handlerCalls).toBe(1);
  });

  it('runs the handler for every request when no key is sent', async () => {
    const instance = app();

    await instance.fetch(post(undefined, { name: 'AA100' }), env);
    await instance.fetch(post(undefined, { name: 'AA100' }), env);

    expect(handlerCalls).toBe(2);
  });

  it('ignores the header on a safe method', async () => {
    const instance = app();
    const headers = {
      [IDEMPOTENCY_KEY_HEADER]: 'safe-method-key-1',
      [INSTALL_ID_HEADER]: INSTALL_A,
    };

    await instance.fetch(new Request('https://api.planeahead.test/things', { headers }), env);
    await instance.fetch(new Request('https://api.planeahead.test/things', { headers }), env);

    expect(handlerCalls).toBe(2);
  });

  it('rejects a malformed key before touching the store', async () => {
    const instance = app();

    const response = await instance.fetch(post('short', { name: 'AA100' }), env);
    const body = await response.json<{ error: string }>();

    expect(response.status).toBe(400);
    expect(body.error).toBe('invalid_idempotency_key');
    expect(handlerCalls).toBe(0);
  });

  it('does not store a 5xx, so a retry after a failure really retries', async () => {
    const instance = app();
    const key = 'failure-key-0001';

    const first = await instance.fetch(post(key, {}, { path: '/boom' }), env);
    const second = await instance.fetch(post(key, {}, { path: '/boom' }), env);

    expect(first.status).toBe(500);
    expect(second.status).toBe(500);
    expect(handlerCalls).toBe(2);
  });
});

describe('scope', () => {
  it('replays for the same install after the client IP changes', async () => {
    // The regression. The previous scope was the client IP, so a phone that retried after moving
    // from WiFi to LTE ran the handler a second time and created its resource twice, which is
    // the one case the mobile outbox's aggressive retry exists to make safe. The install id is
    // owned by the client and survives the network change.
    const instance = app();
    const key = 'roaming-key-00001';

    const first = await instance.fetch(post(key, { name: 'AA100' }, { ip: '203.0.113.1' }), env);
    const second = await instance.fetch(post(key, { name: 'AA100' }, { ip: '203.0.113.2' }), env);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBe('true');
    expect(await second.json()).toEqual(await first.json());
    expect(handlerCalls).toBe(1);
  });

  it('does not let two installs share one bucket', async () => {
    // The store is keyed by `(scope, key)`. Two clients that happen to send the same key must
    // neither read each other's stored response nor get a 422 for a request they never made.
    // Increment 5 mounts routes that answer 2xx while the caller is still anonymous, which is
    // when a shared bucket becomes a cross-caller data leak.
    const instance = app();
    const key = 'shared-key-00001';

    const first = await instance.fetch(
      post(key, { name: 'AA100' }, { installId: INSTALL_A, ip: '203.0.113.1' }),
      env,
    );
    const second = await instance.fetch(
      post(key, { name: 'UA200' }, { installId: INSTALL_B, ip: '203.0.113.1' }),
      env,
    );

    expect(first.status).toBe(201);
    // Not a 422: the second install's request is not a reuse of the first install's key.
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual({ created: 2, name: 'UA200' });
    expect(handlerCalls).toBe(2);
  });

  it('answers 400 to a keyed request with no X-Install-Id rather than running it unprotected', async () => {
    // No user is resolved in this slot and there is no install id, so there is nothing to scope
    // the key by. Running the handler anyway would hand the client a guarantee it is not getting.
    const instance = app();

    const response = await instance.fetch(
      post('unscoped-key-0001', { name: 'AA100' }, { installId: null }),
      env,
    );
    const body = await response.json<{ error: string; message: string }>();

    expect(response.status).toBe(400);
    expect(body.error).toBe('idempotency_scope_missing');
    expect(body.message).toContain(INSTALL_ID_HEADER);
    expect(handlerCalls).toBe(0);
  });

  it('answers the same 400 to a malformed X-Install-Id', async () => {
    const instance = app();

    const response = await instance.fetch(
      post('unscoped-key-0002', { name: 'AA100' }, { installId: 'has space' }),
      env,
    );
    const body = await response.json<{ error: string }>();

    expect(response.status).toBe(400);
    expect(body.error).toBe('idempotency_scope_missing');
    expect(handlerCalls).toBe(0);
  });

  it('does not need an install id when no key is sent', async () => {
    const instance = app();

    const response = await instance.fetch(
      post(undefined, { name: 'AA100' }, { installId: null }),
      env,
    );

    expect(response.status).toBe(201);
    expect(handlerCalls).toBe(1);
  });
});

describe('idempotency helpers', () => {
  it('accepts and rejects keys by the documented shape', () => {
    expect(isValidIdempotencyKey('0198f3c2-1f7a-7c4e-9a1b-2b3c4d5e6f70')).toBe(true);
    expect(isValidIdempotencyKey('a'.repeat(8))).toBe(true);
    expect(isValidIdempotencyKey('a'.repeat(7))).toBe(false);
    expect(isValidIdempotencyKey('a'.repeat(256))).toBe(false);
    expect(isValidIdempotencyKey('has space')).toBe(false);
    expect(isValidIdempotencyKey('has/slash/1')).toBe(false);
    // The in-memory store separates scope from key with U+0000, written as an escape in the
    // source. A raw NUL byte there made git classify the whole file as binary, which cost it its
    // diff and its three-way merge; `planeahead/no-literal-control-characters` now fails the lint
    // on the byte. The separator is only unambiguous because no valid key can contain it.
    expect(isValidIdempotencyKey(`abcdefgh\u0000ijkl`)).toBe(false);
  });

  it('holds the install id to the same shape, since it lands in the same store key', () => {
    expect(isValidInstallId('0198f3c2-1f7a-7c4e-9a1b-2b3c4d5e6f70')).toBe(true);
    expect(isValidInstallId('short')).toBe(false);
    expect(isValidInstallId(`abcdefgh\u0000ijkl`)).toBe(false);
  });

  it('stores only JSON responses that are not transient failures', () => {
    const json = { 'Content-Type': 'application/json' };
    expect(isStorableResponse(new Response('{}', { status: 201, headers: json }))).toBe(true);
    expect(isStorableResponse(new Response('{}', { status: 400, headers: json }))).toBe(true);
    expect(isStorableResponse(new Response('{}', { status: 429, headers: json }))).toBe(false);
    expect(isStorableResponse(new Response('{}', { status: 503, headers: json }))).toBe(false);
    expect(isStorableResponse(new Response('hello', { status: 200 }))).toBe(false);
  });

  it('bounds the in-memory store', async () => {
    const bounded = createMemoryIdempotencyStore(2);

    await bounded.reserve('scope', 'one', 'aa');
    await bounded.reserve('scope', 'two', 'aa');
    await bounded.reserve('scope', 'three', 'aa');

    expect(await bounded.reserve('scope', 'one', 'bb')).toEqual({ kind: 'reserved' });
    expect(await bounded.reserve('scope', 'three', 'bb')).toEqual({ kind: 'mismatch' });
  });

  it('keeps two scopes apart even when the key looks like a scope boundary', async () => {
    const memory = createMemoryIdempotencyStore();

    await memory.reserve('a', 'b:c', 'aa');
    await memory.complete('a', 'b:c', { status: 200, body: { ok: true } });

    expect(await memory.reserve('a:b', 'c', 'aa')).toEqual({ kind: 'reserved' });
    expect(await memory.reserve('a', 'b:c', 'aa')).toEqual({
      kind: 'replay',
      response: { status: 200, body: { ok: true } },
    });
  });

  it('frees a dead lease, and a released reservation, for the next caller', async () => {
    let now = 0;
    const memory = createMemoryIdempotencyStore(10, () => now);

    expect(await memory.reserve('s', 'lease', 'aa')).toEqual({ kind: 'reserved' });
    expect(await memory.reserve('s', 'lease', 'aa')).toEqual({ kind: 'in_flight' });
    now = 61_000;
    expect(await memory.reserve('s', 'lease', 'aa')).toEqual({ kind: 'reserved' });
    await memory.release('s', 'lease');
    expect(await memory.reserve('s', 'lease', 'bb')).toEqual({ kind: 'reserved' });
  });

  it('selects the memory store and an install scope in the global slot, never the database', async () => {
    // The Hyperdrive binding is present in the test pool with a connection string that is never
    // dialled. `storeFor` must still pick memory: ruling E6 puts this slot ahead of auth, so no
    // user is ever resolved here (in this increment or the next), and the database store is keyed
    // by user id. If this ever flips, increment 4's suite would start opening Postgres
    // connections.
    //
    // The memory store is a module singleton and the database store is built per request, so two
    // requests returning the same object reference is the proof that neither one built a client.
    // The probe runs in the REAL idempotency slot, where `c.var.user` is unset rather than null.
    const selected: IdempotencyStore[] = [];
    const scopes: (string | null)[] = [];
    const instance = createApp({
      idempotencyStore: (c) => {
        selected.push(storeFor(c));
        scopes.push(scopeFor(c));
        return store;
      },
    });
    instance.post('/probe', (c) => c.json({ ok: true }, 201));

    await instance.fetch(post('probe-key-000001', {}, { path: '/probe', ip: '203.0.113.9' }), env);
    await instance.fetch(post('probe-key-000002', {}, { path: '/probe', ip: '203.0.113.9' }), env);

    expect(selected).toHaveLength(2);
    expect(selected[0]).toBe(selected[1]);
    expect(scopes).toEqual([`install:${INSTALL_A}`, `install:${INSTALL_A}`]);
  });

  it('has no scope at all without a user or an install id, whatever the IP says', async () => {
    // The client IP is deliberately not a fallback: it is not something the client controls.
    const scopes: (string | null)[] = [];
    const instance = createApp({
      idempotencyStore: (c) => {
        scopes.push(scopeFor(c));
        return store;
      },
    });
    instance.post('/probe', (c) => c.json({ ok: true }, 201));

    await instance.fetch(
      post('probe-key-000003', {}, { path: '/probe', installId: null, ip: '203.0.113.9' }),
      env,
    );

    expect(scopes).toEqual([null]);
  });
});

describe('the middleware is still usable on its own', () => {
  it('exports a factory a later increment can mount under a sub-router', () => {
    // Increment 8 mounts a second idempotency instance behind auth under /v1, with the database
    // store and the user scope. The factory has to stay callable outside `registerChain` for
    // that, but nothing in this file builds a CHAIN by hand: the order is src/app.ts's business.
    expect(typeof idempotency).toBe('function');
    expect(typeof idempotency({ store: () => store })).toBe('function');
  });
});

describe('the request hash (ruling K1)', () => {
  it('is key-order independent and covers method, canonical path and the validated body', async () => {
    const url = 'https://api.planeahead.test/v1/flights';
    const a = await hashValidatedRequest('POST', url, { number: 'AA100', date: '2026-10-01' });
    const b = await hashValidatedRequest('post', `${url}/`, {
      date: '2026-10-01',
      number: 'AA100',
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await hashValidatedRequest('POST', url, { number: 'AA101', date: '2026-10-01' }),
    ).not.toBe(a);
    expect(
      await hashValidatedRequest('DELETE', url, { number: 'AA100', date: '2026-10-01' }),
    ).not.toBe(a);
  });

  it('canonicalises nested objects and drops undefined members', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { f: 1, e: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[3,{"e":2,"f":1}]},"b":1}',
    );
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalPath('https://x.test//v1//flights/')).toBe('/v1/flights');
    expect(canonicalPath('https://x.test/')).toBe('/');
  });
});

let fileDb: ReturnType<typeof openDb> | null = null;

/** One handle for the file: a client's sockets outlive the test that opened them. */
function handle(): ReturnType<typeof openDb> {
  fileDb ??= openDb(env);
  return fileDb;
}

describe('the Postgres store (the /v1 instance, a resolved user)', () => {
  it('reserves once, answers in_flight, mismatch and replay, and frees a released key', async () => {
    const { userId } = await signInAnonymously();
    const db = handle();
    const pg = createDbIdempotencyStore(db, userId);
    const scope = `user:${userId}`;
    const hash = 'ab'.repeat(32);

    expect(await pg.reserve(scope, 'pg-key-00000001', hash)).toEqual({ kind: 'reserved' });
    expect(await pg.reserve(scope, 'pg-key-00000001', hash)).toEqual({ kind: 'in_flight' });
    expect(await pg.reserve(scope, 'pg-key-00000001', 'cd'.repeat(32))).toEqual({
      kind: 'mismatch',
    });
    await pg.complete(scope, 'pg-key-00000001', { status: 201, body: { created: true } });
    expect(await pg.reserve(scope, 'pg-key-00000001', hash)).toEqual({
      kind: 'replay',
      response: { status: 201, body: { created: true } },
    });

    expect(await pg.reserve(scope, 'pg-key-00000002', hash)).toEqual({ kind: 'reserved' });
    await pg.release(scope, 'pg-key-00000002');
    expect(await pg.reserve(scope, 'pg-key-00000002', 'cd'.repeat(32))).toEqual({
      kind: 'reserved',
    });
  });

  it('lets exactly one of ten concurrent callers reserve a key (INSERT ... ON CONFLICT DO NOTHING)', async () => {
    const { userId } = await signInAnonymously();
    const pg = createDbIdempotencyStore(handle(), userId);
    const hash = 'ef'.repeat(32);

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => pg.reserve(`user:${userId}`, 'pg-race-0000001', hash)),
    );

    expect(outcomes.filter((outcome) => outcome.kind === 'reserved')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.kind === 'in_flight')).toHaveLength(9);
  });

  it('takes over a reservation whose lease expired (a request that died mid-flight)', async () => {
    const { userId } = await signInAnonymously();
    const db = handle();
    const pg = createDbIdempotencyStore(db, userId);
    const hash = '01'.repeat(32);

    expect(await pg.reserve(`user:${userId}`, 'pg-dead-0000001', hash)).toEqual({
      kind: 'reserved',
    });
    await db.execute(sql`
      update idempotency_keys set expires_at = now() - interval '1 second'
      where user_id = ${userId}::uuid and key = 'pg-dead-0000001'
    `);
    expect(await pg.reserve(`user:${userId}`, 'pg-dead-0000001', '02'.repeat(32))).toEqual({
      kind: 'reserved',
    });
    const [row] = await db.execute<{ status: number }>(sql`
      select response_status as status from idempotency_keys
      where user_id = ${userId}::uuid and key = 'pg-dead-0000001'
    `);
    expect(row?.status).toBe(IN_FLIGHT_STATUS);
  });
});

describe('the /v1 instance in the deployed Worker', () => {
  it('lets auth answer a keyed request with neither a session nor an install id: 401, not a scope error', async () => {
    // Ruling O10: the /v1 instance sets nothing when it cannot scope a key, so the route's
    // requireScope tells a signed-out caller to sign in (or that its account is gone) instead of
    // blaming the missing X-Install-Id.
    const response = await exports.default.fetch('https://api.planeahead.test/v1/flights', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [IDEMPOTENCY_KEY_HEADER]: 'v1-unscoped-001' },
      body: JSON.stringify({ flightKey: 'AAL-100-2026-10-01-KJFK' }),
    });

    expect(response.status).toBe(401);
    expect((await response.json<{ error: string }>()).error).toBe('unauthenticated');
  });

  it('leaves the scope error to the gate: a keyed request that reaches it unscoped answers 400', async () => {
    // A route with no requireScope ahead of its gate (none exists under /v1 today): the /v1
    // instance set nothing, so only the gate can say the key has no scope, and it does.
    const instance = createApp();
    instance.use('/v1/*', idempotency({ mode: 'v1' }));
    instance.post('/v1/probe-gate', idempotencyGate({ required: false }), (c) =>
      c.json({ ran: true }, 201),
    );

    const response = await instance.fetch(
      new Request('https://api.planeahead.test/v1/probe-gate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', [IDEMPOTENCY_KEY_HEADER]: 'v1-gate-000001' },
        body: '{}',
      }),
      env,
    );

    expect(response.status).toBe(400);
    expect((await response.json<{ error: string }>()).error).toBe('idempotency_scope_missing');
  });

  it('lets the global slot leave /v1 alone: an install-scoped keyed POST reaches the route', async () => {
    // Without a session the /v1 instance scopes by install id and the route answers its own 401;
    // the global slot, which would have replayed from its memory store, never saw the request.
    const response = await exports.default.fetch('https://api.planeahead.test/v1/flights', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [IDEMPOTENCY_KEY_HEADER]: 'v1-install-0001',
        [INSTALL_ID_HEADER]: 'install-v1-00001',
      },
      body: JSON.stringify({ flightKey: 'AAL-100-2026-10-01-KJFK' }),
    });

    expect(response.status).toBe(401);
    expect((await response.json<{ error: string }>()).error).toBe('unauthenticated');
  });
});
