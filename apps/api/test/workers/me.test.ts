/**
 * `GET /v1/me` and `PATCH /v1/me/preferences` through the real Worker, plus the `requireScope`
 * guard on a local app (no route in this increment carries a principal without the `user`
 * scope, so the 403 branch is exercised directly).
 */

import { sql } from 'drizzle-orm';
import { DEFAULT_NOTIFICATION_PREFERENCES, DEFAULT_USER_PREFERENCES } from '@planeahead/shared';
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
import { db } from './helpers/routes';

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
              kind: 'session',
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

interface PreferencesBody {
  readonly preferences?: Record<string, unknown>;
  readonly notifications?: { pushEnabled: boolean; events: Record<string, boolean> };
  readonly error?: string;
}

describe('notification preferences on /v1/me/preferences (increment 15, N10)', () => {
  it('reads the defaults: push on, every toggle on except the first gate assignment', async () => {
    const session = await signInAnonymously();
    const client = { ip: session.ip, cookie: session.cookie };
    const response = await worker(jsonRequest('/v1/me/preferences', 'GET', undefined, client));
    expect(response.status).toBe(200);
    expect(await response.json<PreferencesBody>()).toEqual({
      preferences: DEFAULT_USER_PREFERENCES,
      notifications: DEFAULT_NOTIFICATION_PREFERENCES,
    });
    expect(DEFAULT_NOTIFICATION_PREFERENCES.events).toEqual({
      delay: true,
      gate_change: true,
      first_gate_assignment: false,
      cancellation: true,
      diversion: true,
    });
  });

  it('merges a partial patch into the stored toggles, records each write, and GET agrees', async () => {
    const session = await signInAnonymously();
    const client = { ip: session.ip, cookie: session.cookie };
    const patch = (body: unknown) =>
      worker(jsonRequest('/v1/me/preferences', 'PATCH', body, client));

    const first = await patch({ notifications: { events: { first_gate_assignment: true } } });
    expect(first.status).toBe(200);
    expect(await first.json<PreferencesBody>()).toEqual({
      preferences: DEFAULT_USER_PREFERENCES,
      notifications: {
        pushEnabled: true,
        events: { ...DEFAULT_NOTIFICATION_PREFERENCES.events, first_gate_assignment: true },
      },
    });
    // A second patch changes other fields; the first's toggle stays.
    const second = await patch({
      distanceUnit: 'km',
      notifications: { pushEnabled: false, events: { delay: false } },
    });
    const expected = {
      preferences: { ...DEFAULT_USER_PREFERENCES, distanceUnit: 'km' },
      notifications: {
        pushEnabled: false,
        events: {
          ...DEFAULT_NOTIFICATION_PREFERENCES.events,
          first_gate_assignment: true,
          delay: false,
        },
      },
    };
    expect(await second.json<PreferencesBody>()).toEqual(expected);
    const read = await worker(jsonRequest('/v1/me/preferences', 'GET', undefined, client));
    expect(await read.json<PreferencesBody>()).toEqual(expected);

    const changes = await db().execute<{ push: boolean; events: Record<string, boolean> }>(sql`
      select (row->>'pushEnabled')::boolean as push, row->'events' as events from user_sync_changes
      where user_id = ${session.userId}::uuid and entity = 'notification_preferences'
      order by xid, seq
    `);
    expect(changes.map((change) => change.push)).toEqual([true, false]);
    expect(changes[1]?.events).toEqual({ first_gate_assignment: true, delay: false });
  });
});

describe('notification preferences validation', () => {
  it('refuses an empty, unknown or mistyped notifications patch with the envelope', async () => {
    const session = await signInAnonymously();
    const client = { ip: session.ip, cookie: session.cookie };
    const patch = (body: unknown) =>
      worker(jsonRequest('/v1/me/preferences', 'PATCH', body, client));
    const refused = [
      { notifications: {} },
      { notifications: { events: {} } },
      { notifications: { events: { boarding: true } } },
      { notifications: { pushEnabled: 'yes' } },
      { notifications: { events: { delay: 1 } } },
      { notifications: { quietHours: true } },
      // The toggles live under `notifications`, never beside the display fields.
      { pushEnabled: false },
    ];
    for (const body of refused) {
      const response = await patch(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect((await response.json<PreferencesBody>()).error).toBe('validation_failed');
    }
    // Nothing was written by any of them.
    const read = await worker(jsonRequest('/v1/me/preferences', 'GET', undefined, client));
    expect((await read.json<PreferencesBody>()).notifications).toEqual(
      DEFAULT_NOTIFICATION_PREFERENCES,
    );
  });

  it('answers 401 without a session', async () => {
    const read = await worker(jsonRequest('/v1/me/preferences', 'GET', undefined));
    const write = await worker(
      jsonRequest('/v1/me/preferences', 'PATCH', { notifications: { pushEnabled: false } }),
    );
    expect(read.status).toBe(401);
    expect(write.status).toBe(401);
  });
});
