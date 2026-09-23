/**
 * Synchronous account deletion, `POST /v1/me/delete` (increment 8, ruling K8).
 *
 * Better Auth's `deleteUser` stays disabled: its `freshAge` gate cannot be met by a passwordless
 * user, it touches only three tables and it is not transactional. The order below is the one the
 * facts sheet derives from Hyperdrive ("it is not recommended to wrap multiple database operations
 * with a single transaction"): nothing slow happens while a transaction is open.
 *
 *   1. READ, outside any transaction: the live subscriptions (to unsubscribe), the Apple account
 *      and its envelope-encrypted refresh token (decrypted here, while `user_keys` still exists),
 *      the Google subject, the session tokens, the RevenueCat app user ids and the email.
 *   2. UNSUBSCRIBE every FlightTracker (idempotent; failures logged, never fatal). A crash between
 *      here and step 4 leaves subscriptions the trackers no longer count, which is benign: the
 *      next attempt unsubscribes again and a tracker's notifications are filtered by Postgres.
 *   3. REVOKE at Apple, best effort (TN3194: deletion completes without a usable token); RevenueCat
 *      through its flagged-off stub. Both outcomes go to `audit_log` in step 4.
 *   4. ONE short transaction whose FIRST statement is `select 1 from users where id = $1 for
 *      update`, then ordered, leaf-to-root DELETE statements, never one multi-CTE statement
 *      (sibling CTEs share a snapshot and run in unspecified order): every table that references
 *      `users` is emptied of the user's rows explicitly (the ON DELETE CASCADE foreign keys are a
 *      safety net, not the mechanism), then the tables that hold the user id or email without a
 *      foreign key (`usage_counters`, `verifications`, `rate_limits`), then the `deleted_subjects`
 *      rows (HMAC-SHA-256 of each Apple or Google subject for 400 days, and of each session token
 *      for 31 days so another device is told `account_deleted`), the `audit_log` row, and finally
 *      `delete from users`. The sessions are among the rows deleted, which revokes them.
 *   5. AFTER the commit, unsubscribe every subscription step 4 deleted that step 2 did not
 *      (ruling O14): a mutating request of another device still authenticates until step 4
 *      commits, so a subscribe can commit between the read and the delete; step 4's
 *      `delete ... returning` names it, and it is undone here, best effort like step 2.
 *
 * Why the lock comes first (re-review). A subscribe's INSERT holds FOR KEY SHARE on the user's
 * row (its foreign-key check) until it commits, and FOR UPDATE conflicts with that lock, so the
 * lock waits for every subscribe that has already inserted, and the `flight_subscriptions` DELETE
 * that follows (a fresh READ COMMITTED snapshot) returns the row for step 5; a subscribe that
 * inserts after the lock waits at its foreign-key check until step 4 commits, then fails 23503,
 * and the route's own compensation unsubscribes it. Without the lock the same wait happened at
 * `delete from users`, the last statement, which then CASCADED the freshly committed row past the
 * RETURNING, so step 5 never saw it and the tracker kept the deleted user (`me.delete.test.ts`
 * holds a subscribe open until the lock waits on it). A lock that finds no row means a concurrent
 * deletion finished first: the transaction does nothing and the route answers as for a replay.
 * The lock cannot deadlock with a subscribe: a subscribe waits on the user row only from its
 * INSERT, and at that point it holds no row lock the deletes need (its restore path, which locks
 * the tombstone, leaves `user_id` alone and so runs no foreign-key check).
 *
 * Step 4 also removes the magic-link counters keyed by the account's address (`usage_counters`,
 * scope `email`, subjects that start with the SHA-256 of the canonical mailbox, known from step
 * 1): an unkeyed hash of an email is reversible by dictionary. Once trips get writers, step 4 must
 * also append change rows for OTHER users' `trip_members` and `flight_subscriptions.trip_id` rows
 * it touches (docs/schema-review.md section 7); in Phase 0 no trip exists.
 *
 * `DELETION_ORDER` is the enumeration docs/schema-review.md section 7 records as a table;
 * test/workers/me.delete.test.ts compares it with every foreign key the database catalog says
 * references `users`, so a table added later without a line here fails the suite.
 */

import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import {
  accounts,
  auditLog,
  deletedSubjects,
  entitlements,
  flightInstances,
  flightSubscriptions,
  sessions,
  users,
  type Db,
} from '@planeahead/db';
import {
  DELETED_SESSION_RETENTION_DAYS,
  DELETED_SUBJECT_RETENTION_DAYS,
  type FlightKey,
} from '@planeahead/shared';
import { revokeAppleRefreshToken, type AppleRevokeOutcome } from '../auth/apple-revoke';
import { deleteRevenueCatCustomer, type RevenueCatDeletion } from '../billing/revenuecat';
import { sha256, sha256Hex } from '../crypto/hash';
import { MAGIC_LINK_SCOPE, canonicalMailbox } from '../middleware/magic-link-ceiling';
import type { Envelope } from '../crypto/envelope';
import type { Env } from '../env';
import { errorFields, type Logger } from '../observability/log';
import { callWithDeadline } from './deadline';
import { deletedSubjectHash, requireSecret, type DeletedSubjectKind } from './hmac';
import { unsubscribeTracker, type TrackerFor } from './trackers';

/** What a step's statement may use: the user id, the email, and its mailbox hash. */
export interface DeletionSubject {
  readonly userId: string;
  readonly email: string | null;
  /** SHA-256 hex of the canonical mailbox, the prefix of the magic-link counter subjects. */
  readonly mailboxHash: string | null;
}

export interface DeletionStep {
  readonly table: string;
  /** The statement, or null for a table whose rows die by cascade from an explicit parent. */
  readonly statement: ((subject: DeletionSubject) => SQL | null) | null;
  readonly note: string;
}

const byUserId =
  (table: string) =>
  ({ userId }: DeletionSubject): SQL =>
    sql`delete from ${sql.identifier(table)} where user_id = ${userId}::uuid`;

/**
 * Leaf to root. Every table with a foreign key to `users` appears with an explicit statement;
 * `share_link_views` (a child of `share_links`, no user column) is the one row set that dies by
 * cascade. The three tables after `sessions` hold the user without a foreign key.
 */
export const DELETION_ORDER: readonly DeletionStep[] = [
  { table: 'import_rows', statement: byUserId('import_rows'), note: 'before imports' },
  { table: 'imports', statement: byUserId('imports'), note: '' },
  { table: 'email_extractions', statement: byUserId('email_extractions'), note: '' },
  {
    table: 'email_messages_processed',
    statement: byUserId('email_messages_processed'),
    note: 'before email_accounts',
  },
  { table: 'email_accounts', statement: byUserId('email_accounts'), note: '' },
  {
    table: 'inbound_messages',
    statement: byUserId('inbound_messages'),
    note: 'before inbound_addresses',
  },
  { table: 'inbound_addresses', statement: byUserId('inbound_addresses'), note: '' },
  {
    table: 'calendar_events',
    statement: byUserId('calendar_events'),
    note: 'before calendar_connections',
  },
  { table: 'calendar_connections', statement: byUserId('calendar_connections'), note: '' },
  { table: 'ics_feed_tokens', statement: byUserId('ics_feed_tokens'), note: '' },
  {
    table: 'share_link_views',
    statement: null,
    note: 'no user column; cascades from share_links',
  },
  { table: 'share_links', statement: byUserId('share_links'), note: '' },
  { table: 'meet_me_sessions', statement: byUserId('meet_me_sessions'), note: '' },
  { table: 'live_activities', statement: byUserId('live_activities'), note: 'before devices' },
  { table: 'push_tokens', statement: byUserId('push_tokens'), note: 'before devices' },
  { table: 'notifications', statement: byUserId('notifications'), note: '' },
  { table: 'notification_preferences', statement: byUserId('notification_preferences'), note: '' },
  { table: 'logbook_entries', statement: byUserId('logbook_entries'), note: '' },
  { table: 'user_stats_yearly', statement: byUserId('user_stats_yearly'), note: '' },
  {
    table: 'flight_subscriptions',
    // RETURNING: every row deleted here is unsubscribed after the commit unless step 2 already
    // did (ruling O14), which covers a subscribe that committed after step 1 read the list.
    statement: ({ userId }) =>
      sql`delete from flight_subscriptions where user_id = ${userId}::uuid
            returning id::text as id, flight_instance_id::text as flight_instance_id,
                      deleted_at is null as live`,
    note: 'tombstones included; RETURNING feeds step 5',
  },
  {
    table: 'trip_members',
    statement: ({ userId }) =>
      sql`delete from trip_members where user_id = ${userId}::uuid
            or trip_id in (select id from trips where user_id = ${userId}::uuid)`,
    note: 'the user as a member, and every member of the user own trips',
  },
  { table: 'trips', statement: byUserId('trips'), note: '' },
  { table: 'entitlements', statement: byUserId('entitlements'), note: '' },
  { table: 'api_tokens', statement: byUserId('api_tokens'), note: '' },
  { table: 'data_export_jobs', statement: byUserId('data_export_jobs'), note: '' },
  { table: 'idempotency_keys', statement: byUserId('idempotency_keys'), note: '' },
  {
    table: 'user_sync_changes',
    statement: byUserId('user_sync_changes'),
    note: 'explicitly by user_id (ruling K8)',
  },
  { table: 'user_consents', statement: byUserId('user_consents'), note: '' },
  { table: 'user_preferences', statement: byUserId('user_preferences'), note: '' },
  { table: 'devices', statement: byUserId('devices'), note: '' },
  { table: 'user_keys', statement: byUserId('user_keys'), note: 'the DEK: ciphertexts die here' },
  { table: 'accounts', statement: byUserId('accounts'), note: '' },
  { table: 'sessions', statement: byUserId('sessions'), note: 'revokes every session' },
  {
    table: 'usage_counters',
    statement: ({ userId }) =>
      sql`delete from usage_counters where scope = 'user' and subject = ${userId}`,
    note: 'no FK: subject is the user id',
  },
  {
    table: 'usage_counters',
    // The magic-link counters (src/middleware/magic-link-cap.ts): the address ceiling
    // `{mailboxHash}:hour|day` and the owner budget `{mailboxHash}:{requesterHash}:hour|day`.
    statement: ({ mailboxHash }) =>
      mailboxHash === null
        ? null
        : sql`delete from usage_counters
              where scope = ${MAGIC_LINK_SCOPE} and left(subject, 65) = ${`${mailboxHash}:`}`,
    note: 'no FK: magic-link counters keyed by the SHA-256 of the canonical mailbox',
  },
  {
    table: 'verifications',
    statement: ({ email }) =>
      email === null
        ? null
        : sql`delete from verifications
              where lower(identifier) = lower(${email})
                 or position(${JSON.stringify(email)} in value) > 0`,
    note: 'no FK: magic-link rows name the email',
  },
  {
    table: 'rate_limits',
    statement: ({ email }) =>
      email === null
        ? null
        : sql`delete from rate_limits where position(lower(${email}) in lower(key)) > 0`,
    note: 'no FK: per-address limiter keys embed the email',
  },
];

/** Tables that keep rows after a deletion: pseudonymous, no FK to users (GDPR Art. 17(3)). */
export const DELETION_SURVIVORS = [
  'audit_log',
  'notification_deliveries',
  'revenuecat_events',
  'subscriptions',
  'provider_calls',
  'provider_call_daily',
  'deleted_subjects',
] as const;

export interface DeletionDeps {
  readonly env: Env;
  readonly db: Db;
  readonly envelope: Envelope;
  readonly log: Logger;
  readonly trackerFor: TrackerFor;
  readonly deadlineMs: number;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly requestId: string;
  readonly fetch?: typeof fetch | undefined;
}

export interface DeletionReport {
  readonly subscriptions: number;
  readonly trackersUnsubscribed: number;
  readonly trackersFailed: number;
  /** Subscriptions that committed after step 1 and were unsubscribed after the commit. */
  readonly lateSubscriptions: number;
  readonly apple: AppleRevokeOutcome;
  readonly revenueCat: RevenueCatDeletion;
  readonly deletedSubjects: number;
}

interface AccountRead {
  readonly email: string | null;
  readonly subscriptions: readonly { id: string; flightKey: FlightKey }[];
  readonly appleRefreshToken: string | null;
  readonly subjects: readonly { kind: DeletedSubjectKind; value: string }[];
  readonly rcAppUserIds: readonly string[];
}

/** Step 1. Outside any transaction; decrypts the Apple refresh token while its DEK exists. */
async function readAccount(deps: DeletionDeps, userId: string): Promise<AccountRead | null> {
  const [user] = await deps.db
    .select({ email: users.email, isAnonymous: users.isAnonymous })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (user === undefined) {
    return null;
  }
  const subscriptions = await deps.db
    .select({ id: flightSubscriptions.id, flightKey: flightInstances.flightKey })
    .from(flightSubscriptions)
    .innerJoin(flightInstances, eq(flightInstances.id, flightSubscriptions.flightInstanceId))
    .where(and(eq(flightSubscriptions.userId, userId), isNull(flightSubscriptions.deletedAt)));
  const linked = await deps.db
    .select({
      id: accounts.id,
      providerId: accounts.providerId,
      accountId: accounts.accountId,
      refreshTokenEnc: accounts.refreshTokenEnc,
      refreshTokenKeyVersion: accounts.refreshTokenKeyVersion,
    })
    .from(accounts)
    .where(eq(accounts.userId, userId));
  const sessionRows = await deps.db
    .select({ token: sessions.token })
    .from(sessions)
    .where(eq(sessions.userId, userId));
  const rcRows = await deps.db
    .selectDistinct({ rcAppUserId: entitlements.rcAppUserId })
    .from(entitlements)
    .where(eq(entitlements.userId, userId));

  let appleRefreshToken: string | null = null;
  const subjects: { kind: DeletedSubjectKind; value: string }[] = [];
  for (const account of linked) {
    if (account.providerId === 'apple' || account.providerId === 'google') {
      subjects.push({ kind: account.providerId, value: account.accountId });
    }
    if (
      account.providerId === 'apple' &&
      account.refreshTokenEnc !== null &&
      account.refreshTokenKeyVersion !== null
    ) {
      try {
        const plain = await deps.envelope.decrypt(userId, 'accounts', 'refresh_token', account.id, {
          ciphertext: account.refreshTokenEnc,
          keyVersion: account.refreshTokenKeyVersion,
        });
        appleRefreshToken = new TextDecoder().decode(plain);
      } catch (error) {
        // Deletion must complete without a usable token (TN3194); the audit row says why.
        deps.log.warn('apple_refresh_token_decrypt_failed', errorFields(error));
      }
    }
  }
  for (const session of sessionRows) {
    subjects.push({ kind: 'session', value: session.token });
  }
  return {
    // An anonymous user's email is a Better Auth placeholder, not an address anyone owns.
    email: user.isAnonymous === true ? null : user.email,
    subscriptions: subscriptions.map((row) => ({ ...row, flightKey: row.flightKey as FlightKey })),
    appleRefreshToken,
    subjects,
    rcAppUserIds: rcRows.map((row) => row.rcAppUserId),
  };
}

/** Steps 2 and 5. Every tracker, in parallel, each under the deadline; never throws. */
async function unsubscribeAll(
  deps: DeletionDeps,
  subscriptions: AccountRead['subscriptions'],
): Promise<{ ok: number; failed: number }> {
  const results = await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await callWithDeadline(
          'unsubscribe',
          unsubscribeTracker(deps.trackerFor(subscription.flightKey), {
            subscriptionId: subscription.id,
          }),
          deps.deadlineMs,
          { waitUntil: deps.waitUntil },
        );
        return true;
      } catch (error) {
        deps.log.error('account_deletion_unsubscribe_failed', {
          flight_key: subscription.flightKey,
          ...errorFields(error),
        });
        return false;
      }
    }),
  );
  const ok = results.filter(Boolean).length;
  return { ok, failed: results.length - ok };
}

/** The flight keys of subscriptions step 4 deleted (their instances outlive them: RESTRICT). */
async function flightKeysOf(
  db: Db,
  rows: readonly { id: string; flight_instance_id: string }[],
): Promise<{ id: string; flightKey: FlightKey }[]> {
  const keys = await db
    .select({ id: flightInstances.id, flightKey: flightInstances.flightKey })
    .from(flightInstances)
    .where(inArray(flightInstances.id, [...new Set(rows.map((row) => row.flight_instance_id))]));
  const byInstance = new Map(keys.map((row) => [row.id, row.flightKey as FlightKey]));
  return rows.flatMap((row) => {
    const flightKey = byInstance.get(row.flight_instance_id);
    return flightKey === undefined ? [] : [{ id: row.id, flightKey }];
  });
}

function daysFromNow(days: number): SQL {
  return sql`now() + make_interval(days => ${days})`;
}

/**
 * Deletes the account. Returns null when the user row is already gone (a replay of a completed
 * deletion that still carried a cached session). Throws only for a configuration error (the HMAC
 * key) before anything is touched, or when the final transaction fails, in which case nothing of
 * step 4 happened and the request can simply be retried.
 */
export async function deleteAccount(
  deps: DeletionDeps,
  userId: string,
): Promise<DeletionReport | null> {
  const hmacKey = requireSecret(deps.env.DELETED_SUBJECT_HMAC_KEY, 'DELETED_SUBJECT_HMAC_KEY');
  const read = await readAccount(deps, userId);
  if (read === null) {
    return null;
  }

  const trackers = await unsubscribeAll(deps, read.subscriptions);
  const unsubscribed = new Set(read.subscriptions.map((subscription) => subscription.id));
  const apple = await revokeAppleRefreshToken(deps.env, read.appleRefreshToken, {
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
  });
  if (apple.outcome === 'failed') {
    deps.log.warn('apple_revoke_failed', { status: apple.status, reason: apple.reason });
  }
  const revenueCat = await deleteRevenueCatCustomer(deps.env, read.rcAppUserIds);

  const subjectRows = await Promise.all(
    read.subjects.map(async (subject) => ({
      subjectId: userId,
      reason: 'user_request',
      providerSubjectHash: await deletedSubjectHash(hmacKey, subject.kind, subject.value),
      expiresAt: daysFromNow(
        subject.kind === 'session'
          ? DELETED_SESSION_RETENTION_DAYS
          : DELETED_SUBJECT_RETENTION_DAYS,
      ),
    })),
  );
  const rcHashes = await Promise.all(read.rcAppUserIds.map((id) => sha256(id)));
  const rcRows = rcHashes.map((hash) => ({
    subjectId: userId,
    reason: 'user_request',
    rcAppUserIdHash: hash,
    expiresAt: daysFromNow(DELETED_SUBJECT_RETENTION_DAYS),
  }));

  const subject: DeletionSubject = {
    userId,
    email: read.email,
    mailboxHash: read.email === null ? null : await sha256Hex(canonicalMailbox(read.email)),
  };
  const deletedSubscriptions = await deps.db.transaction(async (tx) => {
    // First: the user row, FOR UPDATE. A subscribe that has inserted holds FOR KEY SHARE on it
    // until it commits, so this waits for it and the flight_subscriptions DELETE below (a fresh
    // snapshot) returns its row; a later subscribe blocks at its foreign-key check, then fails.
    const locked = await tx.execute(sql`select 1 from users where id = ${userId}::uuid for update`);
    if (locked.length === 0) {
      // A concurrent deletion committed while this one waited: nothing left to delete.
      return null;
    }
    let deleted: { id: string; flight_instance_id: string; live: boolean }[] = [];
    for (const step of DELETION_ORDER) {
      const statement = step.statement?.(subject) ?? null;
      if (statement === null) {
        continue;
      }
      const rows = await tx.execute<{ id: string; flight_instance_id: string; live: boolean }>(
        statement,
      );
      if (step.table === 'flight_subscriptions') {
        deleted = [...rows];
      }
    }
    if (subjectRows.length + rcRows.length > 0) {
      await tx.insert(deletedSubjects).values([...subjectRows, ...rcRows]);
    }
    await tx.insert(auditLog).values({
      subjectId: userId,
      actorType: 'user',
      actorId: userId,
      action: 'account.deleted',
      targetType: 'user',
      targetId: userId,
      requestId: deps.requestId,
      details: {
        subscriptions: read.subscriptions.length,
        trackers_unsubscribed: trackers.ok,
        trackers_failed: trackers.failed,
        late_subscriptions: deleted.filter((row) => row.live && !unsubscribed.has(row.id)).length,
        apple_revoke: apple,
        revenuecat: revenueCat,
        deleted_subjects: subjectRows.length + rcRows.length,
      },
    });
    await tx.delete(users).where(eq(users.id, userId));
    return deleted;
  });
  if (deletedSubscriptions === null) {
    return null;
  }

  // Step 5: a live subscription that committed after step 1 (another device's subscribe while
  // this deletion ran) still sits in its tracker; step 4 named it.
  const late = deletedSubscriptions.filter((row) => row.live && !unsubscribed.has(row.id));
  const lateTrackers =
    late.length === 0
      ? { ok: 0, failed: 0 }
      : await unsubscribeAll(deps, await flightKeysOf(deps.db, late));
  if (late.length > 0) {
    deps.log.warn('account_deletion_late_subscriptions', {
      count: late.length,
      failed: lateTrackers.failed,
    });
  }

  return {
    subscriptions: read.subscriptions.length,
    trackersUnsubscribed: trackers.ok + lateTrackers.ok,
    trackersFailed: trackers.failed + lateTrackers.failed,
    lateSubscriptions: late.length,
    apple,
    revenueCat,
    deletedSubjects: subjectRows.length + rcRows.length,
  };
}
