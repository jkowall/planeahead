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
 * Routes are added to the app returned by `createApp()` rather than to a hand-built instance. The
 * store is injected through the chain's own seam, so no test needs Postgres.
 *
 * No Postgres. `ENVIRONMENT` is `test` in vitest.config.ts and no user is ever resolved, so
 * `storeFor()` returns the in-memory store on every request, which is the increment 4 contract:
 * the database path exists but is unreachable until increment 5 resolves a session.
 */

import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createApp } from '../../src/app';
import type { AppBindings } from '../../src/env';
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_REPLAYED_HEADER,
  type IdempotencyStore,
  createMemoryIdempotencyStore,
  idempotency,
  isStorableResponse,
  isValidIdempotencyKey,
  scopeFor,
  storeFor,
} from '../../src/middleware/idempotency';

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

function post(key: string | undefined, body: unknown, path = '/things', ip?: string): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key !== undefined) {
    headers[IDEMPOTENCY_KEY_HEADER] = key;
  }
  if (ip !== undefined) {
    headers['CF-Connecting-IP'] = ip;
  }
  return new Request(`https://api.planeahead.test${path}`, {
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
    const headers = { [IDEMPOTENCY_KEY_HEADER]: 'safe-method-key-1' };

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

    const first = await instance.fetch(post(key, {}, '/boom'), env);
    const second = await instance.fetch(post(key, {}, '/boom'), env);

    expect(first.status).toBe(500);
    expect(second.status).toBe(500);
    expect(handlerCalls).toBe(2);
  });
});

describe('scope isolation', () => {
  it('does not let two anonymous callers share one bucket', async () => {
    // `scopeFor` used to return the literal string `anonymous` for every unauthenticated caller,
    // so two clients that happened to send the same Idempotency-Key read each other's stored
    // response, or got a 422 for a request they never made. Increment 5 mounts routes that answer
    // 2xx while the caller is still anonymous (`POST /api/auth/sign-in/anonymous` is exactly
    // that), which is the moment a shared bucket becomes a cross-caller data leak.
    const instance = app();
    const key = 'shared-key-00001';

    const first = await instance.fetch(post(key, { name: 'AA100' }, '/things', '203.0.113.1'), env);
    const second = await instance.fetch(
      post(key, { name: 'UA200' }, '/things', '203.0.113.2'),
      env,
    );

    expect(first.status).toBe(201);
    // Not a 422: the second caller's request is not a reuse of the first caller's key.
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual({ created: 2, name: 'UA200' });
    expect(handlerCalls).toBe(2);
  });

  it('still replays for the same caller', async () => {
    const instance = app();
    const key = 'same-caller-0001';

    await instance.fetch(post(key, { name: 'AA100' }, '/things', '203.0.113.3'), env);
    const replay = await instance.fetch(
      post(key, { name: 'AA100' }, '/things', '203.0.113.3'),
      env,
    );

    expect(replay.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBe('true');
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

  it('never selects the database store while the request is anonymous', async () => {
    // The Hyperdrive binding is present in the test pool with a connection string that is never
    // dialled. `storeFor` must still pick memory, because no user is resolved in this slot and
    // ENVIRONMENT is `test`. If this ever flips, increment 4's suite would start opening Postgres
    // connections.
    //
    // The memory store is a module singleton and the database store is built per request, so two
    // requests returning the same object reference is the proof that neither one built a client.
    // The probe runs in the REAL idempotency slot, where `c.var.user` is unset rather than null.
    const selected: IdempotencyStore[] = [];
    const scopes: string[] = [];
    const instance = createApp({
      idempotencyStore: (c) => {
        selected.push(storeFor(c));
        scopes.push(scopeFor(c));
        return store;
      },
    });
    instance.post('/probe', (c) => c.json({ ok: true }, 201));

    await instance.fetch(post('probe-key-000001', {}, '/probe', '203.0.113.9'), env);
    await instance.fetch(post('probe-key-000002', {}, '/probe', '203.0.113.9'), env);

    expect(selected).toHaveLength(2);
    expect(selected[0]).toBe(selected[1]);
    expect(scopes).toEqual(['anonymous:ip:203.0.113.9', 'anonymous:ip:203.0.113.9']);
  });

  it('falls back to one bucket only when there is no client IP at all', async () => {
    // `wrangler dev` and the test pool set no CF-Connecting-IP, so anonymous callers collapse
    // together locally. That is documented at the call site and is why the memory store is a
    // convenience rather than a guarantee.
    const scopes: string[] = [];
    const instance = createApp({
      idempotencyStore: (c) => {
        scopes.push(scopeFor(c));
        return store;
      },
    });
    instance.post('/probe', (c) => c.json({ ok: true }, 201));

    await instance.fetch(post('probe-key-000003', {}, '/probe'), env);

    expect(scopes).toEqual(['anonymous:unknown']);
  });
});

describe('the middleware is still usable on its own', () => {
  it('exports a factory a later increment can mount under a sub-router', () => {
    // Increment 8 mounts a second idempotency instance with a different store under /v1. The
    // factory has to stay callable outside `registerChain` for that, but nothing in this file
    // builds a CHAIN by hand: the order is src/app.ts's business.
    expect(typeof idempotency).toBe('function');
    expect(typeof idempotency({ store: () => store })).toBe('function');
  });
});
