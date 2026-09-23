/**
 * The idempotency middleware, in its real slot.
 *
 * Every app in this file comes from `createApp()` in `src/app.ts`, which is the same function
 * `src/index.ts` calls, so the middleware under test sits where the Worker puts it: after
 * request-id, sentry, cors and rate-limit, and BEFORE the auth placeholder. The previous version
 * of this file built its own Hono app with `authPlaceholder()` registered first and claimed in its
 * docstring that the order was "reproduced exactly". It was the inverse, and that inversion is
 * what let a chain that 500s on every keyed POST ship with a green suite: with auth first,
 * `c.var.user` is `null` and the `=== null` tests in `storeFor` and `scopeFor` hold; in the real
 * chain it is `undefined` and they read `user.id` off it.
 *
 * Because the slot is ahead of auth, no request in this file ever has a user. The scope is the
 * `X-Install-Id` header, and the tests below pin the two properties that header was chosen for
 * and that the client IP (the previous scope) did not have: two installs never share a bucket,
 * and one install keeps replaying after its IP changes.
 *
 * Routes are added to the app returned by `createApp()` rather than to a hand-built instance. The
 * store is injected through the chain's own seam, so no test needs Postgres.
 */

import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createApp } from '../../src/app';
import type { AppBindings } from '../../src/env';
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_REPLAYED_HEADER,
  INSTALL_ID_HEADER,
  type IdempotencyStore,
  createMemoryIdempotencyStore,
  idempotency,
  isStorableResponse,
  isValidIdempotencyKey,
  isValidInstallId,
  scopeFor,
  storeFor,
} from '../../src/middleware/idempotency';

const INSTALL_A = 'install-aaaa-0001';
const INSTALL_B = 'install-bbbb-0002';

let store: IdempotencyStore;
let handlerCalls = 0;

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
    expect(body.error).toBe('idempotency_key_reuse');
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
    const entry = { status: 200, body: { ok: true }, requestHash: 'aa' };

    await bounded.put('scope', 'one', entry);
    await bounded.put('scope', 'two', entry);
    await bounded.put('scope', 'three', entry);

    expect(await bounded.get('scope', 'one')).toBeNull();
    expect(await bounded.get('scope', 'three')).not.toBeNull();
  });

  it('keeps two scopes apart even when the key looks like a scope boundary', async () => {
    const bounded = createMemoryIdempotencyStore();
    const entry = { status: 200, body: { ok: true }, requestHash: 'aa' };

    await bounded.put('a', 'b:c', entry);

    expect(await bounded.get('a:b', 'c')).toBeNull();
    expect(await bounded.get('a', 'b:c')).not.toBeNull();
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
