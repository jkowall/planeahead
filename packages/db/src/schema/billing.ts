/**
 * Billing, API tokens, audit and GDPR jobs. `revenuecat_events`, `subscriptions`, `audit_log`
 * and `account_deletion_requests` have no FK to users: they must survive account deletion and
 * are keyed by RevenueCat's random app user id or a pseudonymous `subject_id`.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, createdOnly, id, inList, instant, timestamps, tokenHash } from './columns';
import { users } from './identity';

export const ENTITLEMENT_STATUSES = ['active', 'grace', 'paused', 'expired', 'revoked'] as const;
export const STORES = ['app_store', 'play_store', 'stripe', 'promo'] as const;

/** RevenueCat entitlement cache. `rc_app_user_id` is random, never users.id. */
export const entitlements = pgTable(
  'entitlements',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    rcAppUserId: text('rc_app_user_id').notNull(),
    entitlementId: text('entitlement_id').notNull(),
    productId: text('product_id'),
    store: text('store'),
    status: text('status').notNull(),
    willRenew: boolean('will_renew'),
    expiresAt: instant('expires_at'),
    syncedAt: instant('synced_at').notNull().defaultNow(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('entitlements_user_id_entitlement_id_key').on(t.userId, t.entitlementId),
    index('entitlements_rc_app_user_id_idx').on(t.rcAppUserId),
    check('entitlements_status_check', sql`${t.status} in (${inList(ENTITLEMENT_STATUSES)})`),
    check('entitlements_store_check', sql`${t.store} is null or ${t.store} in (${inList(STORES)})`),
  ],
);

/** Raw RevenueCat webhook events, inserted `on conflict do nothing` on event_id. No FK. */
export const revenuecatEvents = pgTable(
  'revenuecat_events',
  {
    id: id(),
    eventId: text('event_id').notNull(),
    type: text('type').notNull(),
    rcAppUserId: text('rc_app_user_id').notNull(),
    environment: text('environment'),
    occurredAt: instant('occurred_at').notNull(),
    payload: jsonb('payload').notNull(),
    processedAt: instant('processed_at'),
    error: text('error'),
    ...createdOnly(),
  },
  (t) => [
    uniqueIndex('revenuecat_events_event_id_key').on(t.eventId),
    index('revenuecat_events_rc_app_user_id_occurred_at_idx').on(t.rcAppUserId, t.occurredAt),
    index('revenuecat_events_unprocessed_idx')
      .on(t.createdAt)
      .where(sql`${t.processedAt} is null`),
  ],
);

export const SUBSCRIPTION_STATUSES = [
  'trial',
  'active',
  'grace',
  'cancelled',
  'expired',
  'refunded',
] as const;

/** Store subscription ledger for finance; pseudonymous, survives deletion. No FK. */
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: id(),
    rcAppUserId: text('rc_app_user_id').notNull(),
    subjectId: uuid('subject_id'),
    store: text('store').notNull(),
    productId: text('product_id').notNull(),
    originalTransactionId: text('original_transaction_id'),
    status: text('status').notNull(),
    purchasedAt: instant('purchased_at'),
    expiresAt: instant('expires_at'),
    renewedAt: instant('renewed_at'),
    cancelledAt: instant('cancelled_at'),
    priceMicros: bigint('price_micros', { mode: 'number' }),
    currency: text('currency'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('subscriptions_store_original_transaction_id_key')
      .on(t.store, t.originalTransactionId)
      .where(sql`${t.originalTransactionId} is not null`),
    index('subscriptions_rc_app_user_id_idx').on(t.rcAppUserId),
    index('subscriptions_subject_id_idx').on(t.subjectId),
    check('subscriptions_store_check', sql`${t.store} in (${inList(STORES)})`),
    check('subscriptions_status_check', sql`${t.status} in (${inList(SUBSCRIPTION_STATUSES)})`),
  ],
);

export const API_TOKEN_KINDS = ['pat', 'mcp', 'device', 'service'] as const;

/** `pa_<kind>_<base64url32>` tokens: SHA-256 lookup, scopes, expiry, revocation. */
export const apiTokens = pgTable(
  'api_tokens',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    ...tokenHash(),
    name: text('name'),
    scopes: jsonb('scopes')
      .notNull()
      .default(sql`'[]'::jsonb`),
    expiresAt: instant('expires_at'),
    lastUsedAt: instant('last_used_at'),
    revokedAt: instant('revoked_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('api_tokens_token_hash_key').on(t.tokenHash),
    index('api_tokens_user_id_idx')
      .on(t.userId)
      .where(sql`${t.revokedAt} is null`),
    check('api_tokens_kind_check', sql`${t.kind} in (${inList(API_TOKEN_KINDS)})`),
  ],
);

export const ACTOR_TYPES = ['user', 'admin', 'system', 'api_token', 'webhook'] as const;

/** Append-only, pseudonymous. No FK; BRIN on created_at. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    subjectId: uuid('subject_id'),
    actorType: text('actor_type').notNull(),
    actorId: uuid('actor_id'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: uuid('target_id'),
    requestId: text('request_id'),
    ipHash: bytea('ip_hash'),
    details: jsonb('details'),
    ...createdOnly(),
  },
  (t) => [
    index('audit_log_created_at_brin_idx').using('brin', t.createdAt),
    index('audit_log_subject_id_created_at_idx').on(t.subjectId, t.createdAt),
    index('audit_log_action_created_at_idx').on(t.action, t.createdAt),
    check('audit_log_actor_type_check', sql`${t.actorType} in (${inList(ACTOR_TYPES)})`),
  ],
);

export const EXPORT_STATUSES = ['queued', 'running', 'ready', 'failed', 'expired'] as const;

export const dataExportJobs = pgTable(
  'data_export_jobs',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('queued'),
    r2Key: text('r2_key'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    requestedAt: instant('requested_at').notNull().defaultNow(),
    completedAt: instant('completed_at'),
    expiresAt: instant('expires_at'),
    error: text('error'),
    ...timestamps(),
  },
  (t) => [
    index('data_export_jobs_user_id_requested_at_idx').on(t.userId, t.requestedAt),
    check('data_export_jobs_status_check', sql`${t.status} in (${inList(EXPORT_STATUSES)})`),
  ],
);

export const DELETION_SOURCES = ['app', 'web', 'admin', 'apple_s2s'] as const;
export const DELETION_STATUSES = ['pending', 'processing', 'completed', 'failed'] as const;

/** PII-free record of a deletion request and each step's outcome. Keyed by subject, no FK. */
export const accountDeletionRequests = pgTable(
  'account_deletion_requests',
  {
    id: id(),
    subjectId: uuid('subject_id').notNull(),
    source: text('source').notNull(),
    status: text('status').notNull().default('pending'),
    requestedAt: instant('requested_at').notNull().defaultNow(),
    completedAt: instant('completed_at'),
    steps: jsonb('steps')
      .notNull()
      .default(sql`'{}'::jsonb`),
    error: text('error'),
    ...timestamps(),
  },
  (t) => [
    index('account_deletion_requests_subject_id_idx').on(t.subjectId),
    index('account_deletion_requests_status_idx')
      .on(t.status, t.requestedAt)
      .where(sql`${t.status} in ('pending', 'processing')`),
    check(
      'account_deletion_requests_source_check',
      sql`${t.source} in (${inList(DELETION_SOURCES)})`,
    ),
    check(
      'account_deletion_requests_status_check',
      sql`${t.status} in (${inList(DELETION_STATUSES)})`,
    ),
  ],
);
