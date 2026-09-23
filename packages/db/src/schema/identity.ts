/**
 * Identity and auth. The first five tables (users, sessions, accounts, verifications,
 * rate_limits) are Better Auth 1.7.5's, addressed by the Drizzle adapter through these exact
 * export keys (`usePlural: true`) and the camelCase TS property names. Rules that follow from
 * Better Auth's runtime `validateSchema` (docs/increments/03-db-schema.facts.md section 1):
 *   - every column we add to those five tables is nullable or has a DB default;
 *   - timestamps on them use `mode: 'date'`;
 *   - `sessions.token` is plaintext, unique text: Better Auth looks it up by equality and offers
 *     no hashed mode for sessions (documented exception to the token_hash convention);
 *   - `accounts.access_token`, `refresh_token` and `id_token` are Better Auth-owned plaintext
 *     columns; our Apple refresh token lives only in `accounts.refresh_token_enc`.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  authInstant,
  authTimestamps,
  bytea,
  createdOnly,
  encrypted,
  id,
  inList,
  instant,
  softDelete,
  timestamps,
  xid8,
} from './columns';
import { airports } from './reference';

export const USER_STATUSES = ['active', 'suspended', 'deleting', 'deleted'] as const;
export const USER_PLANS = ['free', 'premium'] as const;

export const users = pgTable(
  'users',
  {
    id: id(),
    // Better Auth core
    name: text('name').notNull(),
    email: text('email').notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text('image'),
    ...authTimestamps(),
    // anonymous plugin
    isAnonymous: boolean('is_anonymous').default(false),
    // PlaneAhead extras: all nullable or defaulted (validateSchema)
    status: text('status').notNull().default('active'),
    plan: text('plan').notNull().default('free'),
    locale: text('locale'),
    homeAirportId: uuid('home_airport_id').references(() => airports.id, { onDelete: 'set null' }),
    lastSeenAt: authInstant('last_seen_at'),
    deletionRequestedAt: authInstant('deletion_requested_at'),
  },
  (t) => [
    uniqueIndex('users_email_key').on(sql`lower(${t.email})`),
    index('users_status_idx').on(t.status),
    check('users_status_check', sql`${t.status} in (${inList(USER_STATUSES)})`),
    check('users_plan_check', sql`${t.plan} in (${inList(USER_PLANS)})`),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    expiresAt: authInstant('expires_at').notNull(),
    token: text('token').notNull(),
    ...authTimestamps(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [
    uniqueIndex('sessions_token_key').on(t.token),
    index('sessions_user_id_idx').on(t.userId),
    index('sessions_expires_at_idx').on(t.expiresAt),
  ],
);

export const accounts = pgTable(
  'accounts',
  {
    id: id(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: authInstant('access_token_expires_at'),
    refreshTokenExpiresAt: authInstant('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    ...authTimestamps(),
    // PlaneAhead: Apple refresh token captured by POST /api/auth/apple/native, envelope-encrypted.
    ...encrypted('refreshToken', 'refresh_token'),
  },
  (t) => [
    uniqueIndex('accounts_provider_id_account_id_key').on(t.providerId, t.accountId),
    index('accounts_user_id_idx').on(t.userId),
  ],
);

export const verifications = pgTable(
  'verifications',
  {
    id: id(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: authInstant('expires_at').notNull(),
    ...authTimestamps(),
  },
  (t) => [
    index('verifications_identifier_idx').on(t.identifier),
    index('verifications_expires_at_idx').on(t.expiresAt),
  ],
);

/**
 * Better Auth `rateLimit.storage = 'database'`; `last_request` is epoch milliseconds. `key` is
 * the client IP or, for per-account limits, the email address: personal data (PII class 2).
 * Better Auth rewrites rows in place and never deletes them, so the housekeeping cron purges
 * rows idle for more than 24 h through `rate_limits_last_request_idx`, and the deletion job
 * removes rows whose key embeds the deleted user's email (docs/schema-review.md section 5).
 */
export const rateLimits = pgTable(
  'rate_limits',
  {
    id: id(),
    key: text('key').notNull(),
    count: integer('count').notNull(),
    lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
  },
  (t) => [
    uniqueIndex('rate_limits_key_key').on(t.key),
    index('rate_limits_last_request_idx').on(t.lastRequest),
  ],
);

export const KEY_WRAP_ALGORITHMS = ['A256KW'] as const;

/** Per-user data-encryption key, wrapped by the versioned KEK from a Workers Secret. */
export const userKeys = pgTable(
  'user_keys',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    wrappedDek: bytea('wrapped_dek').notNull(),
    kekVersion: smallint('kek_version').notNull(),
    wrapAlgorithm: text('wrap_algorithm').notNull().default('A256KW'),
    rotatedAt: instant('rotated_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('user_keys_user_id_key').on(t.userId),
    check(
      'user_keys_wrap_algorithm_check',
      sql`${t.wrapAlgorithm} in (${inList(KEY_WRAP_ALGORITHMS)})`,
    ),
    check('user_keys_kek_version_check', sql`${t.kekVersion} >= 1`),
  ],
);

export const DEVICE_PLATFORMS = ['ios', 'android', 'web'] as const;

export const devices = pgTable(
  'devices',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    installId: text('install_id').notNull(),
    platform: text('platform').notNull(),
    osVersion: text('os_version'),
    appVersion: text('app_version'),
    appBuild: text('app_build'),
    model: text('model'),
    locale: text('locale'),
    timezone: text('timezone'),
    /** Reserved for App Attest / Play Integrity; null until those roll out. */
    attestation: jsonb('attestation'),
    attestationVerifiedAt: instant('attestation_verified_at'),
    lastSeenAt: instant('last_seen_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('devices_user_id_install_id_key').on(t.userId, t.installId),
    check('devices_platform_check', sql`${t.platform} in (${inList(DEVICE_PLATFORMS)})`),
  ],
);

export const DISTANCE_UNITS = ['km', 'mi'] as const;
export const TEMPERATURE_UNITS = ['c', 'f'] as const;
export const TIME_FORMATS = ['12h', '24h'] as const;

/** Sync entity (tombstoned). One row per user. */
export const userPreferences = pgTable(
  'user_preferences',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    distanceUnit: text('distance_unit').notNull().default('mi'),
    temperatureUnit: text('temperature_unit').notNull().default('f'),
    timeFormat: text('time_format').notNull().default('12h'),
    showLocalTimes: boolean('show_local_times').notNull().default(true),
    settings: jsonb('settings')
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [
    uniqueIndex('user_preferences_user_id_key').on(t.userId),
    check(
      'user_preferences_distance_unit_check',
      sql`${t.distanceUnit} in (${inList(DISTANCE_UNITS)})`,
    ),
    check(
      'user_preferences_temperature_unit_check',
      sql`${t.temperatureUnit} in (${inList(TEMPERATURE_UNITS)})`,
    ),
    check('user_preferences_time_format_check', sql`${t.timeFormat} in (${inList(TIME_FORMATS)})`),
  ],
);

export const CONSENT_KINDS = [
  'terms',
  'privacy',
  'marketing_email',
  'analytics',
  'email_import',
  'calendar_sync',
] as const;
export const CONSENT_SOURCES = ['app', 'web', 'api', 'admin'] as const;

export const userConsents = pgTable(
  'user_consents',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    version: text('version').notNull(),
    granted: boolean('granted').notNull(),
    source: text('source').notNull(),
    recordedAt: instant('recorded_at')
      .notNull()
      .default(sql`now()`),
    ...createdOnly(),
  },
  (t) => [
    index('user_consents_user_id_kind_idx').on(t.userId, t.kind, t.recordedAt),
    check('user_consents_kind_check', sql`${t.kind} in (${inList(CONSENT_KINDS)})`),
    check('user_consents_source_check', sql`${t.source} in (${inList(CONSENT_SOURCES)})`),
  ],
);

/** Mirrors SYNC_ENTITIES in @planeahead/shared; a test asserts the two lists agree. */
export const SYNC_CHANGE_ENTITIES = [
  'flight_subscriptions',
  'trips',
  'trip_members',
  'user_preferences',
  'notification_preferences',
  'logbook_entries',
] as const;
export const SYNC_OPS = ['upsert', 'delete'] as const;

/**
 * Change feed for GET /v1/sync. `xid` is the writing transaction's xid8, defaulted by the
 * database, so the reader can exclude in-flight transactions with
 * `xid < pg_snapshot_xmin(pg_current_snapshot())`. `seq` is an identity, the one non-uuid key
 * in the schema, because the cursor needs a total order inside a transaction.
 */
export const userSyncChanges = pgTable(
  'user_sync_changes',
  {
    seq: bigint('seq', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    xid: xid8('xid')
      .notNull()
      .default(sql`pg_current_xact_id()`),
    entity: text('entity').notNull(),
    entityId: uuid('entity_id').notNull(),
    op: text('op').notNull(),
    /**
     * The entity as of this change (migration 0003, increment 8): the feed replays exactly what
     * the writing transaction wrote, never a later state read at pull time. The tombstone for a
     * `delete`. Nullable only because rows written before the column existed have none.
     */
    row: jsonb('row'),
    ...createdOnly(),
  },
  (t) => [
    index('user_sync_changes_user_id_xid_seq_idx').on(t.userId, t.xid, t.seq),
    check('user_sync_changes_entity_check', sql`${t.entity} in (${inList(SYNC_CHANGE_ENTITIES)})`),
    check('user_sync_changes_op_check', sql`${t.op} in (${inList(SYNC_OPS)})`),
  ],
);

/**
 * The sync feed's database timeline (migration 0003, increment 8, ADR 0012, ruling O12): one row,
 * seeded `1` by the migration. Every sync cursor carries the epoch it was issued under, and a
 * cursor from another epoch answers 410 `resync_required`. The restore runbook
 * (docs/schema-review.md section 6) bumps it after any point-in-time restore or branch reset,
 * because a restored cluster REUSES the xids the lost timeline had issued: a cursor from that
 * timeline would otherwise pass every xid check once the new timeline catches up and skip rows.
 * `id` is a smallint pinned to 1 (a documented exception to the uuid key convention); there is no
 * `updated_at` because nothing but the runbook writes it.
 */
export const syncEpoch = pgTable(
  'sync_epoch',
  {
    id: smallint('id').primaryKey().default(1),
    epoch: bigint('epoch', { mode: 'number' }).notNull().default(1),
    bumpedAt: instant('bumped_at'),
    ...createdOnly(),
  },
  (t) => [
    check('sync_epoch_singleton_check', sql`${t.id} = 1`),
    check('sync_epoch_epoch_check', sql`${t.epoch} >= 1`),
  ],
);

/**
 * The sync feed's retention horizon (migration 0003, increment 8, ADR 0012, ruling O9): one row,
 * `horizon_xid` null until the first purge. The increment 12 purge picks one H below the watermark,
 * deletes `where xid < H` from BOTH change tables and writes H here, all in one transaction;
 * `GET /v1/sync` answers 410 `resync_required` exactly when a cursor's xid is below H. Exact by
 * construction, unlike "the oldest retained row": a row's xid is fixed at its transaction's first
 * write and its seq at the change-row insert, so neither a seq-ordered purge nor the lowest-seq
 * row's xid bounds what was removed. Same singleton convention as `sync_epoch`.
 */
export const syncHorizon = pgTable(
  'sync_horizon',
  {
    id: smallint('id').primaryKey().default(1),
    horizonXid: xid8('horizon_xid'),
    purgedAt: instant('purged_at'),
    ...createdOnly(),
  },
  (t) => [check('sync_horizon_singleton_check', sql`${t.id} = 1`)],
);

/** Idempotency-Key replay store for mutating routes; purged after 24 h by housekeeping. */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    requestHash: bytea('request_hash').notNull(),
    responseStatus: smallint('response_status').notNull(),
    responseBody: jsonb('response_body').notNull(),
    expiresAt: instant('expires_at').notNull(),
    ...createdOnly(),
  },
  (t) => [
    primaryKey({ name: 'idempotency_keys_pkey', columns: [t.userId, t.key] }),
    index('idempotency_keys_expires_at_idx').on(t.expiresAt),
  ],
);

export const DELETION_REASONS = ['user_request', 'admin', 'inactivity', 'apple_revoke'] as const;

/**
 * Pseudonymous record that a subject was deleted, kept so webhooks and audit rows that arrive
 * later can be matched and dropped. No PII, no FK to users (the row must outlive the user).
 * The column is `subject_deleted_at`, not `deleted_at`: that name is reserved for the sync
 * entities' tombstone, which the mobile client replays deletes from.
 *
 * Migration 0003 (increment 8, ruling K8): one row PER deleted identifier rather than one per
 * user, so `subject_id` (the deleted `users.id`) is no longer unique. `provider_subject_hash` is
 * `{kind}:{base64url HMAC-SHA-256}` under the `DELETED_SUBJECT_HMAC_KEY` Workers secret of an
 * Apple or Google subject (`apple:`, `google:`) or of a session token the account held
 * (`session:`, which is how the auth middleware answers a second device 401 `account_deleted`
 * rather than `unauthenticated`); a keyed hash because the inputs are identifiers, not secrets.
 * `expires_at` is when the housekeeping cron (increment 12) purges the row: 400 days for a
 * provider subject, 31 days for a session.
 */
export const deletedSubjects = pgTable(
  'deleted_subjects',
  {
    id: id(),
    subjectId: uuid('subject_id').notNull(),
    rcAppUserIdHash: bytea('rc_app_user_id_hash'),
    reason: text('reason').notNull(),
    subjectDeletedAt: instant('subject_deleted_at')
      .notNull()
      .default(sql`now()`),
    providerSubjectHash: text('provider_subject_hash'),
    expiresAt: instant('expires_at')
      .notNull()
      .default(sql`now() + interval '400 days'`),
    ...createdOnly(),
  },
  (t) => [
    index('deleted_subjects_subject_id_idx').on(t.subjectId),
    index('deleted_subjects_provider_subject_hash_idx')
      .on(t.providerSubjectHash)
      .where(sql`${t.providerSubjectHash} is not null`),
    index('deleted_subjects_expires_at_idx').on(t.expiresAt),
    check('deleted_subjects_reason_check', sql`${t.reason} in (${inList(DELETION_REASONS)})`),
    check(
      'deleted_subjects_provider_subject_hash_check',
      sql`${t.providerSubjectHash} is null or ${t.providerSubjectHash} ~ '^(apple|google|session):[A-Za-z0-9_-]{43}$'`,
    ),
  ],
);
