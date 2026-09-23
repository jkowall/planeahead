/**
 * `POST /v1/me/delete` (ruling K8) through the real Worker, the real FlightTrackers, the fake
 * Apple revocation endpoint and the embedded Postgres 18.
 *
 * Deleting the account leaves no row that references the user (checked against EVERY foreign key
 * the catalog says points at `users`, plus the user-keyed tables without one), keeps the
 * pseudonymous survivors (`audit_log`, `notification_deliveries`, `revenuecat_events`,
 * `subscriptions`, `provider_calls`, `deleted_subjects`), unsubscribes every FlightTracker,
 * completes when Apple's revoke answers 500, accepts an anonymous session, and tells another
 * device of the same user 401 `account_deleted` on its next call, GETs included, with the whole
 * cookie jar the real client sends (the `session_data` cache cookie too: ruling O5). A subscribe
 * another device commits while the deletion runs is undone after the commit (ruling O14), a
 * deadlock between the deletion's user lock and a writer holding one of the user's rows is retried,
 * and the magic-link counters keyed by the account's mailbox go with the account.
 */

import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@planeahead/shared';
import { createApp } from '../../src/app';
import { createAuthRuntime } from '../../src/auth/runtime';
import { sha256Hex } from '../../src/crypto/hash';
import {
  DELETION_ORDER,
  DELETION_SURVIVORS,
  deleteAccount as runDeletion,
} from '../../src/lib/account-deletion';
import { defaultTrackerFor, type TrackerRpc } from '../../src/lib/trackers';
import { canonicalMailbox } from '../../src/middleware/magic-link-ceiling';
import { createLogger } from '../../src/observability/log';
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
  eventually,
  seedTracker,
  seededFlightFor,
  subscribe,
  subscribeRequest,
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

/**
 * An Apple user with two devices (two sessions). The other device keeps the WHOLE cookie jar, the
 * `session_data` cache cookie included, exactly as the Expo client sends it (increment 9).
 */
async function appleUser(sub: string) {
  const ip = uniqueIp();
  const first = await appleNativeSignIn({ sub, ip });
  expect(first.response.status).toBe(200);
  const userId = (await first.response.json<{ user: { id: string } }>()).user.id;
  const cookie = sessionTokenOnly(cookiesFrom(first.response) ?? '');
  const second = await appleNativeSignIn({ sub, email: null, ip: uniqueIp() });
  expect(second.response.status).toBe(200);
  const otherDevice = cookiesFrom(second.response) ?? '';
  expect(otherDevice).toContain('session_data=');
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
    // The magic-link counters keyed by the account's mailbox (ruling O14), and a stranger's.
    const [account] = await handle.execute<{ email: string }>(
      sql`select email from users where id = ${userId}::uuid`,
    );
    const mailbox = await sha256Hex(canonicalMailbox(account?.email ?? ''));
    const strangerMailbox = await sha256Hex(
      canonicalMailbox(`stranger-${crypto.randomUUID()}@x.test`),
    );
    await handle.execute(sql`
      insert into usage_counters (id, scope, subject, counter, window_start, count) values
        (uuidv7(), 'email', ${`${mailbox}:day`}, 'magic_links', date_trunc('day', now()), 2),
        (uuidv7(), 'email', ${`${mailbox}:${'0'.repeat(64)}:hour`}, 'magic_links', date_trunc('hour', now()), 1),
        (uuidv7(), 'email', ${`${strangerMailbox}:day`}, 'magic_links', date_trunc('day', now()), 1)
    `);
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

    const counters = await handle.execute<{ subject: string }>(sql`
      select subject from usage_counters
      where scope = 'email' and (left(subject, 64) = ${mailbox} or left(subject, 64) = ${strangerMailbox})
    `);
    expect(counters.map((row) => row.subject)).toEqual([`${strangerMailbox}:day`]);

    // The other device, still holding the 300 s cookie cache: 401 account_deleted (wipe the store)
    // on every /v1 call, GETs included, and a search that would write writes nothing.
    const other = flights[0];
    for (const path of [
      '/v1/me',
      '/v1/flights',
      '/v1/sync',
      `/v1/flights/search?number=${other?.designator ?? 'AA1'}&date=${other?.dateLocal ?? '2100-01-01'}`,
    ]) {
      const response = await authed(otherDevice, path);
      expect(response.status, path).toBe(401);
      expect((await response.json<ErrorBody>()).error, path).toBe('account_deleted');
    }
    const [afterwards] = await handle.execute<{ n: number }>(sql`
      select count(*)::int as n from usage_counters where subject = ${userId}
    `);
    expect(afterwards?.n).toBe(0);
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

  it('undoes a subscribe another device commits while the deletion runs (ruling O14)', async () => {
    const session = await signInAnonymously();
    const first = seededFlightFor();
    const raced = seededFlightFor();
    await seedTracker(first);
    await seedTracker(raced);
    expect((await subscribe(session, { flightKey: first.flightKey })).status).toBe(201);
    const otherDevice = { cookie: session.cookie, ip: uniqueIp() };
    let racedStatus = 0;
    const real = defaultTrackerFor(env);
    const log = createLogger({}, () => undefined);
    const ctx = createExecutionContext();

    // Step 2 unsubscribes the flight step 1 read; while it runs, the other device (whose session
    // lives until step 4 commits) subscribes to a second flight, and that commits.
    const report = await runDeletion(
      {
        env,
        db: db(),
        envelope: createAuthRuntime(env, log).envelope,
        log,
        trackerFor: (key): TrackerRpc => {
          const tracker = real(key);
          return {
            getState: () => tracker.getState(),
            subscribe: (input) => tracker.subscribe(input),
            forceRefresh: (input) => tracker.forceRefresh(input),
            unsubscribe: async (input) => {
              if (key === first.flightKey && racedStatus === 0) {
                racedStatus = (await subscribe(otherDevice, { flightKey: raced.flightKey })).status;
              }
              return tracker.unsubscribe(input);
            },
          };
        },
        deadlineMs: 8_000,
        waitUntil: (promise) => {
          ctx.waitUntil(promise);
        },
        requestId: 'delete-race',
      },
      session.userId,
    );
    await waitOnExecutionContext(ctx);

    expect(racedStatus).toBe(201);
    expect(report?.subscriptions).toBe(1);
    expect(report?.lateSubscriptions).toBe(1);
    expect(await remainingRows(session.userId)).toEqual({});
    expect(await subscriberCount(first.flightKey)).toBe(0);
    expect(await subscriberCount(raced.flightKey)).toBe(0);
    expect(await auditDetails(session.userId)).toMatchObject({ late_subscriptions: 1 });
  });

  it('undoes a subscribe that commits after step 4 has started (the user row is locked first)', async () => {
    // The subscribe's INSERT holds FOR KEY SHARE on the user row until it commits. Step 4's first
    // statement locks that row FOR UPDATE, so it waits for the commit and the DELETE ... RETURNING
    // that follows names the row for step 5. Before the lock, the wait happened at the last
    // statement (`delete from users`), which cascaded the row past RETURNING: the tracker kept
    // the deleted user. The subscribe is held open until the lock is seen waiting on it.
    const session = await signInAnonymously();
    const raced = seededFlightFor();
    await seedTracker(raced);
    const otherDevice = { cookie: session.cookie, ip: uniqueIp() };
    let entered = false;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = createApp();
    app.route(
      '/v1',
      createV1Routes({
        flights: {
          beforeSubscribeCommit: async () => {
            entered = true;
            await gate;
          },
        },
      }),
    );

    const subscribeCtx = createExecutionContext();
    const subscribing = app.fetch(
      subscribeRequest(otherDevice, { flightKey: raced.flightKey }),
      env,
      subscribeCtx,
    );
    await eventually(
      () => Promise.resolve(entered),
      (value) => value,
    );
    const deleting = deleteAccount(session);
    // Step 4 has started: its lock waits on the subscribe's uncommitted row.
    await eventually(
      () =>
        db().execute<{ n: number }>(sql`
          select count(*)::int as n from pg_stat_activity
          where wait_event_type = 'Lock' and query ilike 'select 1 from users%for update%'
        `),
      (rows) => (rows[0]?.n ?? 0) > 0,
    );
    release();
    const subscribed = await subscribing;
    const deleted = await deleting;
    await waitOnExecutionContext(subscribeCtx);

    expect(subscribed.status).toBe(201);
    expect(deleted.status).toBe(200);
    expect(await remainingRows(session.userId)).toEqual({});
    expect(await subscriberCount(raced.flightKey)).toBe(0);
    expect(await auditDetails(session.userId)).toMatchObject({
      subscriptions: 0,
      late_subscriptions: 1,
    });
  });

  it('retries step 4 when it deadlocks with a writer that holds one of the user rows (final re-review)', async () => {
    // The lock order is inverted against every writer that locks one of the user's rows and then
    // appends a change row. `DELETE /v1/flights/:id` is held open inside its row lock; step 4
    // takes the user row FOR UPDATE and its flight_subscriptions DELETE waits on that row lock.
    // Released, the route's change row waits at its foreign-key check on the user row: a
    // deadlock. Step 4 began waiting first, so after deadlock_timeout Postgres aborts it with
    // 40P01; the retry waits for the route's commit and its DELETE ... RETURNING names the row.
    const session = await signInAnonymously();
    const flight = seededFlightFor();
    await seedTracker(flight);
    const created = await subscribe(session, { flightKey: flight.flightKey });
    expect(created.status).toBe(201);
    const id = (await created.json<{ subscription: { id: string } }>()).subscription.id;
    let entered = false;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = createApp();
    app.route(
      '/v1',
      createV1Routes({
        flights: {
          afterUnsubscribeLock: async () => {
            entered = true;
            await gate;
          },
        },
      }),
    );

    const unsubscribeCtx = createExecutionContext();
    const unsubscribing = app.fetch(
      jsonRequest(`/v1/flights/${id}`, 'DELETE', undefined, {
        ip: uniqueIp(),
        cookie: session.cookie,
      }),
      env,
      unsubscribeCtx,
    );
    await eventually(
      () => Promise.resolve(entered),
      (value) => value,
    );
    const log = createLogger({}, () => undefined);
    const deletionCtx = createExecutionContext();
    const deleting = runDeletion(
      {
        env,
        db: db(),
        envelope: createAuthRuntime(env, log).envelope,
        log,
        trackerFor: defaultTrackerFor(env),
        deadlineMs: 8_000,
        waitUntil: (promise) => {
          deletionCtx.waitUntil(promise);
        },
        requestId: 'delete-deadlock',
      },
      session.userId,
    );
    // Step 4 holds the user row and waits on the route's subscription row.
    await eventually(
      () =>
        db().execute<{ n: number }>(sql`
          select count(*)::int as n from pg_stat_activity
          where wait_event_type = 'Lock' and query ilike 'delete from flight_subscriptions%'
        `),
      (rows) => (rows[0]?.n ?? 0) > 0,
    );
    release();
    const unsubscribed = await unsubscribing;
    const report = await deleting;
    await waitOnExecutionContext(unsubscribeCtx);
    await waitOnExecutionContext(deletionCtx);

    expect(unsubscribed.status).toBe(200);
    expect(report).not.toBeNull();
    expect(report?.transactionRetries).toBe(1);
    // The retry's RETURNING saw the route's tombstone, which the route unsubscribed itself.
    expect(report?.lateSubscriptions).toBe(0);
    expect(await remainingRows(session.userId)).toEqual({});
    expect(await subscriberCount(flight.flightKey)).toBe(0);
    expect(await auditDetails(session.userId)).toMatchObject({
      subscriptions: 1,
      transaction_retries: 1,
    });
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
