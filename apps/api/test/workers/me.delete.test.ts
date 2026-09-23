/**
 * `POST /v1/me/delete` (ruling K8) through the real Worker, the real FlightTrackers, the fake
 * Apple revocation endpoint and the embedded Postgres 18.
 *
 * Deleting the account leaves no row that references the user (checked against EVERY foreign key
 * the catalog says points at `users`, plus the user-keyed tables without one), keeps the
 * pseudonymous survivors (`audit_log`, `notification_deliveries`, `revenuecat_events`,
 * `subscriptions`, `provider_calls`, `deleted_subjects`), unsubscribes every FlightTracker,
 * completes when Apple's revoke answers 500, accepts an anonymous session, and tells another
 * device of the same user 401 `account_deleted` on its next call.
 */

import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@planeahead/shared';
import { createApp } from '../../src/app';
import { DELETION_ORDER, DELETION_SURVIVORS } from '../../src/lib/account-deletion';
import { createV1Routes } from '../../src/routes/v1';
import {
  appleNativeSignIn,
  cookiesFrom,
  jsonRequest,
  registerDevice,
  sessionTokenOnly,
  signInAnonymously,
  testEnv,
  uniqueInstallId,
  uniqueIp,
  worker,
  type AnonymousSession,
} from './helpers/auth';
import { drainTouched } from './helpers/flights';
import {
  authed,
  db,
  seedTracker,
  seededFlightFor,
  subscribe,
  subscriberCount,
  type ErrorBody,
} from './helpers/routes';

afterEach(drainTouched);

interface ForeignKeyToUsers extends Record<string, unknown> {
  readonly table: string;
  readonly column: string;
}

async function foreignKeysToUsers(): Promise<ForeignKeyToUsers[]> {
  return db().execute<ForeignKeyToUsers>(sql`
    select c.conrelid::regclass::text as "table", a.attname as "column"
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
    where c.contype = 'f' and c.confrelid = 'public.users'::regclass
    order by 1, 2
  `);
}

/** Rows that still name the user, per referencing table and column, plus the unkeyed ones. */
async function remainingRows(userId: string): Promise<Record<string, number>> {
  const handle = db();
  const remaining: Record<string, number> = {};
  for (const { table, column } of await foreignKeysToUsers()) {
    const [row] = await handle.execute<{ n: number }>(
      sql`select count(*)::int as n from ${sql.identifier(table)} where ${sql.identifier(column)} = ${userId}::uuid`,
    );
    if ((row?.n ?? 0) > 0) {
      remaining[`${table}.${column}`] = row?.n ?? 0;
    }
  }
  const [counters] = await handle.execute<{ n: number }>(sql`
    select count(*)::int as n from usage_counters where scope = 'user' and subject = ${userId}
  `);
  if ((counters?.n ?? 0) > 0) {
    remaining['usage_counters.subject'] = counters?.n ?? 0;
  }
  const [user] = await handle.execute<{ n: number }>(
    sql`select count(*)::int as n from users where id = ${userId}::uuid`,
  );
  if ((user?.n ?? 0) > 0) {
    remaining['users.id'] = 1;
  }
  return remaining;
}

function deleteAccount(session: Pick<AnonymousSession, 'cookie' | 'ip'>): Promise<Response> {
  return worker(
    jsonRequest('/v1/me/delete', 'POST', undefined, { ip: session.ip, cookie: session.cookie }),
  );
}

interface RevokeRequest {
  readonly form: Record<string, string>;
}

async function revokeRequestsFor(tokenPrefix: string): Promise<RevokeRequest[]> {
  const response = await fetch(`${testEnv.TEST_FAKE_PROVIDERS_ORIGIN ?? ''}/apple/revoke/requests`);
  const all = await response.json<RevokeRequest[]>();
  return all.filter((request) => (request.form['token'] ?? '').startsWith(tokenPrefix));
}

async function auditDetails(userId: string): Promise<Record<string, unknown> | null> {
  const [row] = await db().execute<{ details: Record<string, unknown> }>(sql`
    select details from audit_log
    where subject_id = ${userId}::uuid and action = 'account.deleted'
  `);
  return row?.details ?? null;
}

/** An Apple user with two devices (two sessions), subscriptions, a device, preferences. */
async function appleUser(sub: string) {
  const ip = uniqueIp();
  const first = await appleNativeSignIn({ sub, ip });
  expect(first.response.status).toBe(200);
  const userId = (await first.response.json<{ user: { id: string } }>()).user.id;
  const cookie = sessionTokenOnly(cookiesFrom(first.response) ?? '');
  const second = await appleNativeSignIn({ sub, email: null, ip: uniqueIp() });
  expect(second.response.status).toBe(200);
  const otherDevice = sessionTokenOnly(cookiesFrom(second.response) ?? '');
  return { userId, session: { cookie, ip }, otherDevice: { cookie: otherDevice, ip: uniqueIp() } };
}

describe('POST /v1/me/delete', () => {
  it('deletes every user-owned row, keeps the survivors, unsubscribes every tracker and revokes at Apple', async () => {
    const sub = `00${crypto.randomUUID().replaceAll('-', '')}.delete`;
    const { userId, session, otherDevice } = await appleUser(sub);
    const flights = [seededFlightFor(), seededFlightFor()];
    for (const flight of flights) {
      await seedTracker(flight);
      expect((await subscribe(session, { flightKey: flight.flightKey })).status).toBe(201);
    }
    expect((await registerDevice(session, uniqueInstallId('delete'))).status).toBe(200);
    const patched = await worker(
      jsonRequest('/v1/me/preferences', 'PATCH', { distanceUnit: 'km' }, session),
    );
    expect(patched.status).toBe(200);
    // Rows that must survive, keyed pseudonymously, and a user-owned entitlement that must not.
    const rcAppUserId = `rc_${crypto.randomUUID()}`;
    const handle = db();
    await handle.execute(sql`
      insert into entitlements (user_id, rc_app_user_id, entitlement_id, status)
      values (${userId}::uuid, ${rcAppUserId}, 'pro', 'active')
    `);
    await handle.execute(sql`
      insert into audit_log (subject_id, actor_type, action) values (${userId}::uuid, 'system', 'test.before')
    `);
    await handle.execute(sql`
      insert into notification_deliveries (id, notification_id, subject_id, channel, status)
      values (${uuidv7()}::uuid, ${uuidv7()}::uuid, ${userId}::uuid, 'apns', 'sent')
    `);
    await handle.execute(sql`
      insert into revenuecat_events (event_id, type, rc_app_user_id, occurred_at, payload)
      values (${`evt_${crypto.randomUUID()}`}, 'INITIAL_PURCHASE', ${rcAppUserId}, now(), '{}'::jsonb)
    `);
    await handle.execute(sql`
      insert into subscriptions (rc_app_user_id, subject_id, store, product_id, status)
      values (${rcAppUserId}, ${userId}::uuid, 'app_store', 'pro_monthly', 'active')
    `);
    expect(Object.keys(await remainingRows(userId)).length).toBeGreaterThan(5);

    const response = await deleteAccount(session);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true, wipeLocalStore: true });
    expect(await remainingRows(userId)).toEqual({});
    for (const flight of flights) {
      expect(await subscriberCount(flight.flightKey)).toBe(0);
    }
    const [survivors] = await handle.execute<{
      audit: number;
      revenuecat: number;
      ledger: number;
      deliveries: number;
      subjects: number;
    }>(sql`
      select
        (select count(*)::int from audit_log where subject_id = ${userId}::uuid) as audit,
        (select count(*)::int from revenuecat_events where rc_app_user_id = ${rcAppUserId}) as revenuecat,
        (select count(*)::int from subscriptions where subject_id = ${userId}::uuid) as ledger,
        (select count(*)::int from notification_deliveries where subject_id = ${userId}::uuid)
          as deliveries,
        (select count(*)::int from deleted_subjects where subject_id = ${userId}::uuid) as subjects
    `);
    expect(survivors).toEqual({ audit: 2, revenuecat: 1, ledger: 1, deliveries: 1, subjects: 4 });
    const kinds = await handle.execute<{ kind: string }>(sql`
      select coalesce(split_part(provider_subject_hash, ':', 1), 'revenuecat') as kind
      from deleted_subjects where subject_id = ${userId}::uuid order by 1
    `);
    // One Apple subject, the two devices' sessions, one RevenueCat app user id; no raw value.
    expect(kinds.map((row) => row.kind)).toEqual(['apple', 'revenuecat', 'session', 'session']);
    const [raw] = await handle.execute<{ n: number }>(sql`
      select count(*)::int as n from deleted_subjects
      where provider_subject_hash like ${`%${sub}%`}
    `);
    expect(raw?.n).toBe(0);

    const revoked = await revokeRequestsFor('rt_code_');
    const mine = revoked.filter((request) =>
      (request.form['token'] ?? '').includes(
        [...new TextEncoder().encode(sub)].map((b) => b.toString(16).padStart(2, '0')).join(''),
      ),
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]?.form['token_type_hint']).toBe('refresh_token');
    expect(mine[0]?.form['client_id']).toBe(testEnv.APPLE_BUNDLE_ID);
    expect(await auditDetails(userId)).toMatchObject({
      subscriptions: 2,
      trackers_unsubscribed: 2,
      trackers_failed: 0,
      apple_revoke: { outcome: 'revoked', status: 200 },
      revenuecat: { attempted: false, reason: 'disabled' },
    });

    // The other device: 401 account_deleted (wipe the store), not unauthenticated.
    for (const path of ['/v1/me', '/v1/flights', '/v1/sync']) {
      const other = await authed(otherDevice, path);
      expect(other.status, path).toBe(401);
      expect((await other.json<ErrorBody>()).error, path).toBe('account_deleted');
    }
    const retried = await deleteAccount(session);
    expect(retried.status).toBe(401);
    expect((await retried.json<ErrorBody>()).error).toBe('account_deleted');
  });

  it('completes when Apple revoke answers 500, and records the failure', async () => {
    const sub = `00${crypto.randomUUID().replaceAll('-', '')}.revoke-500`;
    const { userId, session } = await appleUser(sub);

    const response = await deleteAccount(session);

    expect(response.status).toBe(200);
    expect(await remainingRows(userId)).toEqual({});
    expect(await auditDetails(userId)).toMatchObject({
      apple_revoke: { outcome: 'failed', status: 500 },
    });
  });

  it('accepts an anonymous session (guest accounts must be deletable)', async () => {
    const session = await signInAnonymously();
    const flight = seededFlightFor();
    await seedTracker(flight);
    expect((await subscribe(session, { flightKey: flight.flightKey })).status).toBe(201);

    const response = await deleteAccount(session);

    expect(response.status).toBe(200);
    expect(await remainingRows(session.userId)).toEqual({});
    expect(await subscriberCount(flight.flightKey)).toBe(0);
    expect(await auditDetails(session.userId)).toMatchObject({
      apple_revoke: { outcome: 'skipped', reason: 'no_token' },
    });
  });

  it('refuses with 500 and touches nothing when the subject HMAC key is not configured', async () => {
    const session = await signInAnonymously();
    const app = createApp();
    app.route('/v1', createV1Routes());
    const ctx = createExecutionContext();

    const response = await app.fetch(
      jsonRequest('/v1/me/delete', 'POST', undefined, { ip: session.ip, cookie: session.cookie }),
      { ...env, DELETED_SUBJECT_HMAC_KEY: undefined },
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(500);
    expect((await remainingRows(session.userId))['users.id']).toBe(1);
  });

  it('answers 401 without a session', async () => {
    const response = await deleteAccount({ cookie: '', ip: uniqueIp() });

    expect(response.status).toBe(401);
  });
});

describe('the deletion order (docs/schema-review.md section 7)', () => {
  it('names every table the catalog says references users, and nothing that must survive', async () => {
    const referencing = new Set((await foreignKeysToUsers()).map((fk) => fk.table));
    const explicit = new Set(
      DELETION_ORDER.filter((step) => step.statement !== null).map((step) => step.table),
    );
    const withoutForeignKey = ['usage_counters', 'verifications', 'rate_limits'];

    expect([...referencing].filter((table) => !explicit.has(table))).toEqual([]);
    expect(
      [...explicit].filter(
        (table) => !referencing.has(table) && !withoutForeignKey.includes(table),
      ),
    ).toEqual([]);
    for (const survivor of DELETION_SURVIVORS) {
      expect(explicit.has(survivor), survivor).toBe(false);
      expect(referencing.has(survivor), survivor).toBe(false);
    }
  });
});
