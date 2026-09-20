/**
 * Email import, file imports, calendar sync and sharing. Invariant: no email bodies are ever
 * stored; `email_messages_processed` holds provider message ids only and extractions hold the
 * structured result. Every table is user-owned and cascades at deletion.
 */

import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  bytea,
  createdOnly,
  encrypted,
  id,
  inList,
  instant,
  timestamps,
  tokenHash,
} from './columns';
import { flightInstances } from './flights';
import { users } from './identity';
import { flightSubscriptions, trips } from './trips';

export const EMAIL_PROVIDERS = ['gmail', 'outlook', 'imap'] as const;
export const CONNECTION_STATUSES = ['active', 'paused', 'revoked', 'error'] as const;

export const emailAccounts = pgTable(
  'email_accounts',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    emailAddress: text('email_address').notNull(),
    externalAccountId: text('external_account_id'),
    scopes: jsonb('scopes')
      .notNull()
      .default(sql`'[]'::jsonb`),
    ...encrypted('accessToken', 'access_token'),
    ...encrypted('refreshToken', 'refresh_token'),
    tokenExpiresAt: instant('token_expires_at'),
    historyCursor: text('history_cursor'),
    status: text('status').notNull().default('active'),
    lastSyncedAt: instant('last_synced_at'),
    lastError: text('last_error'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('email_accounts_user_id_provider_email_address_key').on(
      t.userId,
      t.provider,
      t.emailAddress,
    ),
    check('email_accounts_provider_check', sql`${t.provider} in (${inList(EMAIL_PROVIDERS)})`),
    check('email_accounts_status_check', sql`${t.status} in (${inList(CONNECTION_STATUSES)})`),
  ],
);

export const MESSAGE_OUTCOMES = ['extracted', 'no_flight', 'skipped', 'error'] as const;

/** Ids only, never bodies or subjects: the dedupe ledger for the mailbox scan. */
export const emailMessagesProcessed = pgTable(
  'email_messages_processed',
  {
    id: id(),
    emailAccountId: uuid('email_account_id')
      .notNull()
      .references(() => emailAccounts.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    providerMessageId: text('provider_message_id').notNull(),
    outcome: text('outcome').notNull(),
    processedAt: instant('processed_at').notNull().defaultNow(),
    ...createdOnly(),
  },
  (t) => [
    uniqueIndex('email_messages_processed_account_message_key').on(
      t.emailAccountId,
      t.providerMessageId,
    ),
    check(
      'email_messages_processed_outcome_check',
      sql`${t.outcome} in (${inList(MESSAGE_OUTCOMES)})`,
    ),
  ],
);

export const EXTRACTORS = ['rules', 'llm'] as const;
export const EXTRACTION_STATUSES = ['pending', 'accepted', 'rejected', 'applied'] as const;

/** Structured flight data pulled from a message (mailbox scan or forwarded inbound mail). */
export const emailExtractions = pgTable(
  'email_extractions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    emailMessageProcessedId: uuid('email_message_processed_id'),
    inboundMessageId: uuid('inbound_message_id'),
    extractor: text('extractor').notNull(),
    modelVersion: text('model_version'),
    extracted: jsonb('extracted').notNull(),
    confidence: real('confidence'),
    status: text('status').notNull().default('pending'),
    flightSubscriptionId: uuid('flight_subscription_id'),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    ...timestamps(),
  },
  (t) => [
    foreignKey({
      name: 'email_extractions_message_fk',
      columns: [t.emailMessageProcessedId],
      foreignColumns: [emailMessagesProcessed.id],
    }).onDelete('set null'),
    foreignKey({
      name: 'email_extractions_subscription_fk',
      columns: [t.flightSubscriptionId],
      foreignColumns: [flightSubscriptions.id],
    }).onDelete('set null'),
    index('email_extractions_user_id_created_at_idx').on(t.userId, t.createdAt),
    check('email_extractions_extractor_check', sql`${t.extractor} in (${inList(EXTRACTORS)})`),
    check('email_extractions_status_check', sql`${t.status} in (${inList(EXTRACTION_STATUSES)})`),
  ],
);

export const INBOUND_ADDRESS_STATUSES = ['active', 'revoked'] as const;

/** Per-user forwarding address (`<local_part>@fwd.planeahead.app`). The local part routes mail. */
export const inboundAddresses = pgTable(
  'inbound_addresses',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    localPart: text('local_part').notNull(),
    status: text('status').notNull().default('active'),
    revokedAt: instant('revoked_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('inbound_addresses_local_part_key').on(t.localPart),
    index('inbound_addresses_user_id_idx').on(t.userId),
    check(
      'inbound_addresses_status_check',
      sql`${t.status} in (${inList(INBOUND_ADDRESS_STATUSES)})`,
    ),
  ],
);

export const INBOUND_MESSAGE_STATUSES = ['received', 'processed', 'rejected'] as const;

/** Envelope of a forwarded message; the body is processed in memory and never stored. */
export const inboundMessages = pgTable(
  'inbound_messages',
  {
    id: id(),
    inboundAddressId: uuid('inbound_address_id')
      .notNull()
      .references(() => inboundAddresses.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    messageId: text('message_id'),
    fromDomain: text('from_domain'),
    sizeBytes: integer('size_bytes'),
    receivedAt: instant('received_at').notNull().defaultNow(),
    status: text('status').notNull().default('received'),
    rejectReason: text('reject_reason'),
    ...createdOnly(),
  },
  (t) => [
    uniqueIndex('inbound_messages_inbound_address_id_message_id_key')
      .on(t.inboundAddressId, t.messageId)
      .where(sql`${t.messageId} is not null`),
    index('inbound_messages_user_id_received_at_idx').on(t.userId, t.receivedAt),
    check(
      'inbound_messages_status_check',
      sql`${t.status} in (${inList(INBOUND_MESSAGE_STATUSES)})`,
    ),
  ],
);

export const IMPORT_KINDS = [
  'csv',
  'ics',
  'tripit',
  'app_in_the_air',
  'flighty',
  'manual',
] as const;
export const IMPORT_STATUSES = ['uploaded', 'parsing', 'review', 'applied', 'failed'] as const;

export const imports = pgTable(
  'imports',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    fileName: text('file_name'),
    r2Key: text('r2_key'),
    rowCount: integer('row_count'),
    status: text('status').notNull().default('uploaded'),
    error: text('error'),
    ...timestamps(),
  },
  (t) => [
    index('imports_user_id_created_at_idx').on(t.userId, t.createdAt),
    check('imports_kind_check', sql`${t.kind} in (${inList(IMPORT_KINDS)})`),
    check('imports_status_check', sql`${t.status} in (${inList(IMPORT_STATUSES)})`),
  ],
);

export const IMPORT_ROW_STATUSES = [
  'pending',
  'matched',
  'unmatched',
  'applied',
  'skipped',
  'error',
] as const;

export const importRows = pgTable(
  'import_rows',
  {
    id: id(),
    importId: uuid('import_id')
      .notNull()
      .references(() => imports.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    rowNumber: integer('row_number').notNull(),
    raw: jsonb('raw').notNull(),
    parsed: jsonb('parsed'),
    status: text('status').notNull().default('pending'),
    flightSubscriptionId: uuid('flight_subscription_id').references(() => flightSubscriptions.id, {
      onDelete: 'set null',
    }),
    error: text('error'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('import_rows_import_id_row_number_key').on(t.importId, t.rowNumber),
    check('import_rows_status_check', sql`${t.status} in (${inList(IMPORT_ROW_STATUSES)})`),
  ],
);

export const CALENDAR_PROVIDERS = ['google', 'microsoft', 'apple_caldav'] as const;

export const calendarConnections = pgTable(
  'calendar_connections',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    externalAccountId: text('external_account_id').notNull(),
    calendarId: text('calendar_id'),
    ...encrypted('accessToken', 'access_token'),
    ...encrypted('refreshToken', 'refresh_token'),
    tokenExpiresAt: instant('token_expires_at'),
    syncToken: text('sync_token'),
    status: text('status').notNull().default('active'),
    lastSyncedAt: instant('last_synced_at'),
    lastError: text('last_error'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('calendar_connections_user_id_provider_external_account_id_key').on(
      t.userId,
      t.provider,
      t.externalAccountId,
    ),
    check(
      'calendar_connections_provider_check',
      sql`${t.provider} in (${inList(CALENDAR_PROVIDERS)})`,
    ),
    check(
      'calendar_connections_status_check',
      sql`${t.status} in (${inList(CONNECTION_STATUSES)})`,
    ),
  ],
);

/** Calendar events we wrote for a subscription, so updates and deletes are idempotent. */
export const calendarEvents = pgTable(
  'calendar_events',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    calendarConnectionId: uuid('calendar_connection_id').notNull(),
    flightSubscriptionId: uuid('flight_subscription_id'),
    externalEventId: text('external_event_id').notNull(),
    etag: text('etag'),
    contentHash: bytea('content_hash'),
    lastWrittenAt: instant('last_written_at'),
    ...timestamps(),
  },
  (t) => [
    foreignKey({
      name: 'calendar_events_connection_fk',
      columns: [t.calendarConnectionId],
      foreignColumns: [calendarConnections.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'calendar_events_subscription_fk',
      columns: [t.flightSubscriptionId],
      foreignColumns: [flightSubscriptions.id],
    }).onDelete('cascade'),
    uniqueIndex('calendar_events_connection_event_key').on(
      t.calendarConnectionId,
      t.externalEventId,
    ),
    index('calendar_events_flight_subscription_id_idx').on(t.flightSubscriptionId),
  ],
);

/** Secret ICS feed URLs (`/ics/<token>`); the token is hashed, only the prefix is readable. */
export const icsFeedTokens = pgTable(
  'ics_feed_tokens',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    ...tokenHash(),
    name: text('name'),
    lastFetchedAt: instant('last_fetched_at'),
    fetchCount: integer('fetch_count').notNull().default(0),
    revokedAt: instant('revoked_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('ics_feed_tokens_token_hash_key').on(t.tokenHash),
    index('ics_feed_tokens_user_id_idx')
      .on(t.userId)
      .where(sql`${t.revokedAt} is null`),
  ],
);

export const SHARE_KINDS = ['flight', 'trip'] as const;

export const shareLinks = pgTable(
  'share_links',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    flightSubscriptionId: uuid('flight_subscription_id').references(() => flightSubscriptions.id, {
      onDelete: 'cascade',
    }),
    flightInstanceId: uuid('flight_instance_id').references(() => flightInstances.id, {
      onDelete: 'cascade',
    }),
    tripId: uuid('trip_id').references(() => trips.id, { onDelete: 'cascade' }),
    ...tokenHash(),
    ogImageKey: text('og_image_key'),
    viewCount: integer('view_count').notNull().default(0),
    expiresAt: instant('expires_at'),
    revokedAt: instant('revoked_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('share_links_token_hash_key').on(t.tokenHash),
    index('share_links_user_id_idx')
      .on(t.userId)
      .where(sql`${t.revokedAt} is null`),
    check('share_links_kind_check', sql`${t.kind} in (${inList(SHARE_KINDS)})`),
    check(
      'share_links_target_check',
      sql`(${t.kind} = 'flight' and ${t.flightInstanceId} is not null and ${t.tripId} is null) or (${t.kind} = 'trip' and ${t.tripId} is not null and ${t.flightInstanceId} is null)`,
    ),
  ],
);

/** Abuse evidence for share pages; hashes only, no raw IP or user agent. */
export const shareLinkViews = pgTable(
  'share_link_views',
  {
    id: id(),
    shareLinkId: uuid('share_link_id')
      .notNull()
      .references(() => shareLinks.id, { onDelete: 'cascade' }),
    viewedAt: instant('viewed_at').notNull().defaultNow(),
    ipHash: bytea('ip_hash'),
    userAgentHash: bytea('user_agent_hash'),
    country: text('country'),
    ...createdOnly(),
  },
  (t) => [index('share_link_views_share_link_id_viewed_at_idx').on(t.shareLinkId, t.viewedAt)],
);

export const MEET_ME_STATUSES = ['active', 'expired', 'revoked'] as const;

/** "Meet me at the airport" live-tracking sessions shared with a non-user by token. */
export const meetMeSessions = pgTable(
  'meet_me_sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    flightInstanceId: uuid('flight_instance_id')
      .notNull()
      .references(() => flightInstances.id, { onDelete: 'cascade' }),
    flightSubscriptionId: uuid('flight_subscription_id'),
    ...tokenHash(),
    guestLabel: text('guest_label'),
    status: text('status').notNull().default('active'),
    lastGuestSeenAt: instant('last_guest_seen_at'),
    expiresAt: instant('expires_at').notNull(),
    revokedAt: instant('revoked_at'),
    ...timestamps(),
  },
  (t) => [
    foreignKey({
      name: 'meet_me_sessions_subscription_fk',
      columns: [t.flightSubscriptionId],
      foreignColumns: [flightSubscriptions.id],
    }).onDelete('set null'),
    uniqueIndex('meet_me_sessions_token_hash_key').on(t.tokenHash),
    index('meet_me_sessions_user_id_idx').on(t.userId),
    index('meet_me_sessions_flight_instance_id_idx').on(t.flightInstanceId),
    check('meet_me_sessions_status_check', sql`${t.status} in (${inList(MEET_ME_STATUSES)})`),
  ],
);
