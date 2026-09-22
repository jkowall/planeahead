/**
 * The middleware chain, driven through the real Worker.
 *
 * This file exists because of what its absence cost. Increment 4 shipped with 74 green tests and
 * a Worker that answered 500 to the first mutating request the mobile outbox would ever send:
 * `idempotency()` runs BEFORE `authPlaceholder()` (ruling E6), so `c.var.user` is `undefined`
 * rather than `null` when the idempotency middleware reads it, and `undefined !== null` sent both
 * `storeFor` and `scopeFor` into `user.id`. Every middleware test built its own Hono app with the
 * auth placeholder registered FIRST, which is the inverse of the Worker, so the suite proved a
 * chain that does not exist.
 *
 * Two rules follow, and this file is where they are enforced:
 *
 *   1. Nothing may test the chain by hand-rolling it. `createApp()` in `src/app.ts` is the single
 *      definition, and every test that needs middleware order calls it.
 *   2. The shapes the deployed Worker actually answers are asserted through
 *      `exports.default.fetch()`, not through a locally assembled app, because only the loopback
 *      binding runs the registration `src/index.ts` performs.
 */

import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { MIDDLEWARE_ORDER, createApp, registerChain } from '../../src/app';
import type { AuthenticatedUser } from '../../src/auth/user';
import type { AppBindings } from '../../src/env';
import {
  IDEMPOTENCY_KEY_HEADER,
  INSTALL_ID_HEADER,
  createMemoryIdempotencyStore,
} from '../../src/middleware/idempotency';
import { REQUEST_ID_HEADER } from '../../src/middleware/request-id';

/** A keyed request the way the mobile outbox sends one: key and install id together. */
function postInit(key?: string, installId: string | null = 'chain-install-0001'): RequestInit {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key !== undefined) {
    headers[IDEMPOTENCY_KEY_HEADER] = key;
  }
  if (installId !== null) {
    headers[INSTALL_ID_HEADER] = installId;
  }
  return { method: 'POST', headers, body: JSON.stringify({ number: 'AA100' }) };
}

describe('the deployed chain answers the shape it documents', () => {
  it('answers 501, not 500, for a mutating request carrying an Idempotency-Key', async () => {
    // The regression. `POST /v1/flights` with this header is the request shape the mobile
    // outbox retries aggressively; increments 7 and 8 own the route, so the stub still answers.
    const response = await exports.default.fetch(
      'https://api.planeahead.test/v1/flights',
      postInit('chain-key-00000001'),
    );
    const body = await response.json<{ error: string; increment: string }>();

    expect(response.status).toBe(501);
    expect(body.error).toBe('not_implemented');
    expect(body.increment).toContain('08');
  });

  it('answers the same 501 without the header, so the header is not what routes', async () => {
    const response = await exports.default.fetch(
      'https://api.planeahead.test/v1/flights',
      postInit(),
    );

    expect(response.status).toBe(501);
  });

  it('answers 400, not 500, for a keyed request that carries no X-Install-Id', async () => {
    // No user can be resolved ahead of auth and there is no install id, so the key has no scope.
    // The Worker says so instead of running the handler as if the key had not been sent.
    const response = await exports.default.fetch(
      'https://api.planeahead.test/v1/flights',
      postInit('chain-key-00000005', null),
    );
    const body = await response.json<{ error: string; requestId: string }>();

    expect(response.status).toBe(400);
    expect(body.error).toBe('idempotency_scope_missing');
    expect(body.requestId).toBe(response.headers.get(REQUEST_ID_HEADER));
  });

  it('reaches Better Auth for a keyed POST to the auth mount and gets its validation answer', async () => {
    // The idempotency middleware skips the auth mount (a replayed key must never answer ahead
    // of the magic-link gate), and the body has no `email`, so the gate forwards it uncounted
    // and Better Auth's own schema rejects it: a 400 from the handler, never a 500 from the
    // chain. The address keeps the request out of the shared no-IP rate-limit bucket that
    // other files could be filling.
    const init = postInit('chain-key-00000002');
    const response = await exports.default.fetch(
      'https://api.planeahead.test/api/auth/sign-in/magic-link',
      {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          'cf-connecting-ip': '198.51.249.2',
        },
      },
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('answers 404, not 500, for a keyed POST to a path nothing mounts', async () => {
    const response = await exports.default.fetch(
      'https://api.planeahead.test/nope/unrouted',
      postInit('chain-key-00000003'),
    );
    const body = await response.json<{ error: string; requestId: string }>();

    expect(response.status).toBe(404);
    expect(body.error).toBe('not_found');
    expect(body.requestId).not.toBe('unknown');
  });

  it('rejects a malformed key before it can reach a route', async () => {
    const response = await exports.default.fetch(
      'https://api.planeahead.test/v1/flights',
      postInit('short'),
    );
    const body = await response.json<{ error: string }>();

    expect(response.status).toBe(400);
    expect(body.error).toBe('invalid_idempotency_key');
  });
});

describe('registration order', () => {
  it('pins MIDDLEWARE_ORDER to the order ruling E6 fixes', () => {
    // The constant against the ruling's text. On its own this is a list compared to a copy of
    // itself; the case below is what ties the constant to the code.
    expect([...MIDDLEWARE_ORDER]).toEqual([
      'request-id',
      'sentry',
      'cors',
      'rate-limit',
      'idempotency',
      'auth',
    ]);
  });

  it('registers the slots in the order MIDDLEWARE_ORDER documents', () => {
    // `registerChain` returns the names of the slots it registered, in the order it called
    // `app.use()`. The list comes from the same tuples the registrations do, so swapping two
    // `use()` calls swaps two entries here and this fails, which a comparison of the constant to
    // a literal never could. An earlier version of this file only did the comparison above, and
    // the whole suite stayed green with cors and rate-limit swapped in the code.
    const registered = registerChain(new Hono<AppBindings>());

    expect(registered).toEqual([...MIDDLEWARE_ORDER]);
  });

  it('reaches the idempotency slot with c.var.user still unset', async () => {
    // The proof that the ordering above is real at run time rather than only in a comment, and
    // the reason every reader of `c.var.user` ahead of the auth slot uses `?? null`. If a future
    // change moves auth earlier, this test fails and the `?? null` guards can be revisited on
    // purpose rather than discovered by a 500 in staging.
    const seen: (AuthenticatedUser | null | undefined)[] = [];
    const store = createMemoryIdempotencyStore();
    const app = createApp({
      idempotencyStore: (c) => {
        seen.push(c.var.user);
        return store;
      },
    });
    app.post('/things', (c) => c.json({ created: true }, 201));

    const response = await app.fetch(
      new Request('https://api.planeahead.test/things', postInit('chain-key-00000004')),
      env,
    );

    expect(response.status).toBe(201);
    expect(seen).toEqual([undefined]);
  });

  it('leaves c.var.user null by the time a route handler runs', async () => {
    const app = createApp();
    app.get('/probe', (c) => c.json({ user: c.var.user }));

    const response = await app.fetch(new Request('https://api.planeahead.test/probe'), env);

    expect(await response.json()).toEqual({ user: null });
  });
});

describe('error translation', () => {
  it('keeps the status of a thrown HTTPException instead of flattening it to 500', async () => {
    // Hono's default error handler returns `err.getResponse()` for an HTTPException, which is how
    // `hono/body-limit`, `hono/bearer-auth` and Better Auth's handler signal 4xx. Replacing
    // `onError` without that branch turns all of them into opaque 500s that a client retries and
    // that Sentry groups as unhandled errors. Increment 5 mounts the first thrower.
    const app = createApp();
    app.get('/unauthorized', () => {
      throw new HTTPException(401, { message: 'nope' });
    });
    app.post('/too-large', () => {
      throw new HTTPException(413);
    });

    const unauthorized = await app.fetch(
      new Request('https://api.planeahead.test/unauthorized'),
      env,
    );
    const tooLarge = await app.fetch(
      new Request('https://api.planeahead.test/too-large', { method: 'POST' }),
      env,
    );

    expect(unauthorized.status).toBe(401);
    expect(tooLarge.status).toBe(413);
  });

  it('answers 500 with the request id for an error that really is unhandled', async () => {
    const app = createApp();
    app.get('/boom', () => {
      throw new Error('handler exploded');
    });

    const response = await app.fetch(new Request('https://api.planeahead.test/boom'), env);
    const body = await response.json<{ error: string; requestId: string }>();

    expect(response.status).toBe(500);
    expect(body.error).toBe('internal_error');
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.requestId).toBe(response.headers.get(REQUEST_ID_HEADER));
  });

  it('keeps the status of an HTTPException thrown inside a mounted sub-router', async () => {
    // `/v1` and `/api/auth` are mounted the same way, so a sub-router is the shape that matters.
    const app = createApp();
    const sub = createApp();
    sub.get('/forbidden', () => {
      throw new HTTPException(403);
    });
    app.route('/sub', sub);

    const ctx = createExecutionContext();
    const response = await app.fetch(
      new Request('https://api.planeahead.test/sub/forbidden'),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(403);
  });
});

describe('the default export', () => {
  it('exposes all three handlers, so queue and cron stay instrumented', async () => {
    // A smoke test on the shape `withSentry` was handed. The request assertions above already
    // prove `fetch` works end to end; this catches a `queue` or `scheduled` that was dropped from
    // the object, which nothing else in the suite drives through `exports.default`.
    const source = await import('../../src/index');

    expect(typeof source.default.fetch).toBe('function');
    expect(typeof source.default.queue).toBe('function');
    expect(typeof source.default.scheduled).toBe('function');
  });
});
