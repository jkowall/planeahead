/**
 * `GET /v1/me` and `PATCH /v1/me/preferences` through the real Worker, plus the `requireScope`
 * guard on a local app (no route in this increment carries a principal without the `user`
 * scope, so the 403 branch is exercised directly).
 */

import { DEFAULT_USER_PREFERENCES } from '@planeahead/shared';
import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppBindings } from '../../src/env';
import { requireScope, requireUser } from '../../src/middleware/auth';
import {
  jsonRequest,
  signInAnonymously,
  signInWithMagicLink,
  uniqueEmail,
  worker,
} from './helpers/auth';

interface MeBody {
  readonly user?: {
    id: string;
    email: string | null;
    name: string;
    emailVerified: boolean;
    isAnonymous: boolean;
    status: string;
    plan: string;
    createdAt: string;
  };
  readonly preferences?: Record<string, unknown>;
  readonly error?: string;
}

describe('GET /v1/me', () => {
  it('answers 401 without a session', async () => {
    const response = await worker(jsonRequest('/v1/me', 'GET', undefined));

    expect(response.status).toBe(401);
    expect((await response.json<MeBody>()).error).toBe('unauthenticated');
  });

  it('returns the user with the default preferences when nothing was ever saved', async () => {
    const session = await signInAnonymously();
    const response = await worker(
      jsonRequest('/v1/me', 'GET', undefined, { ip: session.ip, cookie: session.cookie }),
    );
    const body = await response.json<MeBody>();

    expect(response.status).toBe(200);
    expect(body.user?.id).toBe(session.userId);
    expect(body.user?.isAnonymous).toBe(true);
    expect(body.user?.email).toBeNull();
    expect(body.user?.status).toBe('active');
    expect(body.user?.plan).toBe('free');
    expect(body.user?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.preferences).toEqual(DEFAULT_USER_PREFERENCES);
  });

  it('reports the email of a signed-in (non-anonymous) user', async () => {
    const email = uniqueEmail('me');
    const session = await signInWithMagicLink(email);
    const response = await worker(
      jsonRequest('/v1/me', 'GET', undefined, { cookie: session.cookie }),
    );
    const body = await response.json<MeBody>();

    expect(body.user?.email).toBe(email);
    expect(body.user?.emailVerified).toBe(true);
    expect(body.user?.isAnonymous).toBe(false);
  });
});

describe('PATCH /v1/me/preferences', () => {
  it('validates with the shared schema, upserts, and GET reflects the change', async () => {
    const session = await signInAnonymously();
    const client = { ip: session.ip, cookie: session.cookie };

    const patch = await worker(
      jsonRequest(
        '/v1/me/preferences',
        'PATCH',
        { distanceUnit: 'km', settings: { dark_mode: true } },
        client,
      ),
    );
    const patchBody = await patch.json<MeBody>();
    const again = await worker(
      jsonRequest('/v1/me/preferences', 'PATCH', { timeFormat: '24h' }, client),
    );
    const me = await worker(jsonRequest('/v1/me', 'GET', undefined, client));
    const meBody = await me.json<MeBody>();

    expect(patch.status).toBe(200);
    expect(patchBody.preferences).toEqual({
      ...DEFAULT_USER_PREFERENCES,
      distanceUnit: 'km',
      settings: { dark_mode: true },
    });
    expect(again.status).toBe(200);
    expect(meBody.preferences).toEqual({
      ...DEFAULT_USER_PREFERENCES,
      distanceUnit: 'km',
      timeFormat: '24h',
      settings: { dark_mode: true },
    });
  });

  it('rejects an empty patch, an unknown field, a bad value and an oversized settings bag', async () => {
    const session = await signInAnonymously();
    const client = { ip: session.ip, cookie: session.cookie };
    const bigSettings = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`key_${index}`, true]),
    );

    const empty = await worker(jsonRequest('/v1/me/preferences', 'PATCH', {}, client));
    const unknown = await worker(
      jsonRequest('/v1/me/preferences', 'PATCH', { theme: 'dark' }, client),
    );
    const bad = await worker(
      jsonRequest('/v1/me/preferences', 'PATCH', { distanceUnit: 'furlongs' }, client),
    );
    const big = await worker(
      jsonRequest('/v1/me/preferences', 'PATCH', { settings: bigSettings }, client),
    );
    // A NUL inside the jsonb bag: Postgres would refuse it with a 500; the boundary says 400.
    const nul = await worker(
      jsonRequest('/v1/me/preferences', 'PATCH', { settings: { note: 'a\u0000b' } }, client),
    );

    expect(empty.status).toBe(400);
    expect(unknown.status).toBe(400);
    expect(bad.status).toBe(400);
    expect(big.status).toBe(400);
    expect(nul.status).toBe(400);
  });

  it('answers 401 without a session', async () => {
    const response = await worker(
      jsonRequest('/v1/me/preferences', 'PATCH', { distanceUnit: 'km' }),
    );
    expect(response.status).toBe(401);
  });
});

describe('requireScope and requireUser', () => {
  function probe(scopes: readonly string[] | null) {
    const app = new Hono<AppBindings>();
    app.use(async (c, next) => {
      c.set('requestId', 'probe');
      c.set(
        'user',
        scopes === null
          ? null
          : {
              id: 'user-1',
              isAnonymous: false,
              sessionId: 'session-1',
              scopes: scopes as ['user'],
            },
      );
      await next();
    });
    app.get('/scoped', requireScope('user'), (c) => c.json({ ok: true }));
    app.get('/any', requireUser(), (c) => c.json({ ok: true }));
    return app;
  }

  it('answers 401 with no principal, 403 without the scope, 200 with it', async () => {
    const none = await probe(null).fetch(new Request('https://api.planeahead.test/scoped'), env);
    const wrong = await probe([]).fetch(new Request('https://api.planeahead.test/scoped'), env);
    const right = await probe(['user']).fetch(
      new Request('https://api.planeahead.test/scoped'),
      env,
    );
    const anyPrincipal = await probe([]).fetch(new Request('https://api.planeahead.test/any'), env);

    expect(none.status).toBe(401);
    expect(wrong.status).toBe(403);
    expect((await wrong.json<{ error: string }>()).error).toBe('insufficient_scope');
    expect(right.status).toBe(200);
    expect(anyPrincipal.status).toBe(200);
  });
});
