/**
 * The global error handler's one database mapping (increment 12, ruling W4; increment 8's final
 * re-review nit): SQLSTATE 23503 on a foreign key to `users` for a principal whose `users` row is
 * gone answers 401 `account_deleted`, not 500.
 *
 * The race it closes: a request's session resolves, then the account deletion commits (the
 * sessions die with the user), then the request's first write fails its foreign key. For most
 * `/v1` requests that first write is the idempotency lease insert, so the test drives exactly
 * that: the real chain, the real `/v1` idempotency instance and gate, the real Postgres store,
 * and between the auth middleware and the gate the user row is deleted by another statement
 * that commits, the way the deletion's transaction would.
 */

import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createApp, isUserForeignKeyViolation } from '../../src/app';
import type { AppBindings } from '../../src/env';
import { requireScope } from '../../src/middleware/auth';
import {
  IDEMPOTENCY_KEY_HEADER,
  idempotency,
  idempotencyGate,
} from '../../src/middleware/idempotency';
import { API_ORIGIN, signInAnonymously, testEnv, uniqueInstallId } from './helpers/auth';
import { db } from './helpers/routes';

/** An app with the real chain and one keyed `/v1` route whose middleware can act mid-request. */
function appWithProbe(between: (userId: string) => Promise<void>) {
  const app = createApp();
  const v1 = new Hono<AppBindings>().use(idempotency({ mode: 'v1' })).post(
    '/probe',
    requireScope('user'),
    async (c, next) => {
      await between(c.var.user?.id ?? '');
      await next();
    },
    idempotencyGate({ required: true }),
    (c) => c.json({ ran: true }, 201),
  );
  app.route('/v1', v1);
  return app;
}

async function probe(app: Hono<AppBindings>, cookie: string, key: string) {
  const ctx = createExecutionContext();
  const response = await app.fetch(
    new Request(`${API_ORIGIN}/v1/probe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        [IDEMPOTENCY_KEY_HEADER]: key,
        'x-install-id': uniqueInstallId('fk'),
      },
      body: JSON.stringify({}),
    }),
    testEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

describe('23503 on a user foreign key', () => {
  it('answers 401 account_deleted when the account was deleted between auth and the lease insert', async () => {
    const session = await signInAnonymously();
    const app = appWithProbe(async (userId) => {
      // The deletion commits after the session resolved (its own statement, its own commit).
      await db().execute(sql`delete from users where id = ${userId}::uuid`);
    });

    const response = await probe(app, session.cookie, `fk-deleted-${crypto.randomUUID()}`);
    const body = await response.json<{ error: string; requestId: string }>();

    expect(response.status).toBe(401);
    expect(body.error).toBe('account_deleted');
    expect(body.requestId).toBe(response.headers.get('x-request-id'));
  });

  it('stays a 500 when the principal still exists (the violation is not a deletion)', async () => {
    const session = await signInAnonymously();
    const app = createApp();
    app.post('/v1/boom', requireScope('user'), () => {
      const error = Object.assign(new Error('insert or update violates foreign key constraint'), {
        code: '23503',
        constraint_name: 'idempotency_keys_user_id_users_id_fk',
      });
      throw new Error('Failed query', { cause: error });
    });
    const ctx = createExecutionContext();
    const response = await app.fetch(
      new Request(`${API_ORIGIN}/v1/boom`, {
        method: 'POST',
        headers: { cookie: session.cookie },
      }),
      testEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(500);
    expect((await response.json<{ error: string }>()).error).toBe('internal_error');
  });

  it('recognises both constraint namings and nothing else', () => {
    const violation = (constraint: string, code = '23503') => ({
      cause: { code, constraint_name: constraint },
    });
    expect(isUserForeignKeyViolation(violation('idempotency_keys_user_id_users_id_fk'))).toBe(true);
    expect(isUserForeignKeyViolation(violation('flight_subscriptions_user_id_fkey'))).toBe(true);
    expect(
      isUserForeignKeyViolation(violation('flight_subscriptions_flight_instance_id_fkey')),
    ).toBe(false);
    expect(
      isUserForeignKeyViolation(violation('idempotency_keys_user_id_users_id_fk', '23505')),
    ).toBe(false);
    expect(isUserForeignKeyViolation(new Error('no code'))).toBe(false);
  });
});
