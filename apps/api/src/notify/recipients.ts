/**
 * Who an intent reaches, and on which devices (increment 15, ruling N9). One read for the
 * flight's subscribers with their preferences, one insert (and one read back) for their
 * `notifications` rows, one read for their tokens; each statement is cut into runs so a flight
 * with thousands of subscribers stays under Postgres's 65,535 parameters.
 *
 * A subscriber is dropped when the subscription is muted, the user turned push off, or the
 * intent's toggle is off (`notificationEventPreferenceFor`: a first gate assignment needs
 * `first_gate_assignment`, off by default; the others default on). A test intent (an injection,
 * ruling N11) reaches on production only the user ids in `PUSH_INJECT_ALLOWED_USER_IDS`, and on
 * staging and locally every subscriber; the preferences apply to it as to any intent.
 *
 * Every subscriber left gets the `notifications` row, but only those whose subscription is
 * `live_tracked` are pushed (the orchestrator's ruling after part 3, from increment 8's O3 and the
 * Phase 0 free tier: the flag gates notifications and the Live Activity). A change detected
 * outside the live window, or for a subscription the free tier's cap refused, reaches that user's
 * inbox only; `docs/open-decisions.md` records it. The gate applies to test intents too, so an
 * injection exercises the real path.
 */

import { and, eq, inArray, isNull, notInArray, or } from 'drizzle-orm';
import {
  flightInstances,
  flightSubscriptions,
  notificationPreferences,
  notifications,
  pushTokens,
  userPreferences,
  type Db,
} from '@planeahead/db';
import {
  PUSH_TARGET_KINDS,
  effectiveNotificationPreferences,
  notificationEventPreferenceFor,
  uuidv7,
  type NotifyIntentV1,
  type PushEnvironment,
  type PushTargetKind,
} from '@planeahead/shared';
import { chunk, type Recipient, type RecipientToken } from './jobs';
import type { RenderedPush, TimeFormat } from './render';

/** Rows per statement: well under Postgres's parameter limit at ten columns a row. */
export const NOTIFY_STATEMENT_ROWS = 500;

/** A live subscription to the flight, with its user's preferences (null: no row). */
export interface SubscriberRow {
  readonly subscriptionId: string;
  readonly userId: string;
  readonly flightInstanceId: string;
  readonly muted: boolean;
  /** Whether the subscription holds a live-tracking slot: only then is it pushed. */
  readonly liveTracked: boolean;
  readonly pushEnabled: boolean | null;
  readonly events: unknown;
  readonly timeFormat: string | null;
}

export async function readSubscribers(db: Db, flightKey: string): Promise<SubscriberRow[]> {
  return db
    .select({
      subscriptionId: flightSubscriptions.id,
      userId: flightSubscriptions.userId,
      flightInstanceId: flightSubscriptions.flightInstanceId,
      muted: flightSubscriptions.muted,
      liveTracked: flightSubscriptions.liveTracked,
      pushEnabled: notificationPreferences.pushEnabled,
      events: notificationPreferences.events,
      timeFormat: userPreferences.timeFormat,
    })
    .from(flightSubscriptions)
    .innerJoin(flightInstances, eq(flightInstances.id, flightSubscriptions.flightInstanceId))
    .leftJoin(
      notificationPreferences,
      and(
        eq(notificationPreferences.userId, flightSubscriptions.userId),
        isNull(notificationPreferences.deletedAt),
      ),
    )
    .leftJoin(
      userPreferences,
      and(
        eq(userPreferences.userId, flightSubscriptions.userId),
        isNull(userPreferences.deletedAt),
      ),
    )
    .where(and(eq(flightInstances.flightKey, flightKey), isNull(flightSubscriptions.deletedAt)))
    .orderBy(flightSubscriptions.userId);
}

/** Why a subscriber does not hear of an intent. */
export type DropReason = 'not_allow_listed' | 'muted' | 'push_disabled' | 'preference_off';

export interface RecipientSelection {
  /** Every subscriber who hears of the intent: each gets a `notifications` row. */
  readonly recipients: Recipient[];
  /** Those of `recipients` whose subscription is `live_tracked`: only they are pushed. */
  readonly pushed: Recipient[];
  readonly dropped: Record<DropReason, number>;
}

export interface SelectionOptions {
  /** Production: a test intent reaches only `allowedTestUserIds`. */
  readonly production: boolean;
  /** `PUSH_INJECT_ALLOWED_USER_IDS`, lower case. */
  readonly allowedTestUserIds: ReadonlySet<string>;
}

/** The subscribers an intent reaches (pure). */
export function selectRecipients(
  rows: readonly SubscriberRow[],
  intent: NotifyIntentV1,
  options: SelectionOptions,
): RecipientSelection {
  const dropped: Record<DropReason, number> = {
    not_allow_listed: 0,
    muted: 0,
    push_disabled: 0,
    preference_off: 0,
  };
  const toggle = notificationEventPreferenceFor(intent.intent);
  const recipients: Recipient[] = [];
  const pushed: Recipient[] = [];
  for (const row of rows) {
    const preferences = effectiveNotificationPreferences(
      row.pushEnabled === null ? null : { pushEnabled: row.pushEnabled, events: row.events },
    );
    let reason: DropReason | null = null;
    if (
      intent.test &&
      options.production &&
      !options.allowedTestUserIds.has(row.userId.toLowerCase())
    ) {
      reason = 'not_allow_listed';
    } else if (row.muted) {
      reason = 'muted';
    } else if (!preferences.pushEnabled) {
      reason = 'push_disabled';
    } else if (toggle !== null && !preferences.events[toggle]) {
      reason = 'preference_off';
    }
    if (reason !== null) {
      dropped[reason] += 1;
      continue;
    }
    const recipient: Recipient = {
      userId: row.userId,
      subscriptionId: row.subscriptionId,
      flightInstanceId: row.flightInstanceId,
      timeFormat: row.timeFormat === '24h' ? '24h' : '12h',
    };
    recipients.push(recipient);
    if (row.liveTracked) {
      pushed.push(recipient);
    }
  }
  return { recipients, pushed, dropped };
}

/** What a `notifications` row keeps of its intent (`data`), for the inbox. */
function notificationData(intent: NotifyIntentV1): Record<string, unknown> {
  const { kind, subject, value, previousValue, correction, firstAssignment } = intent.intent;
  return {
    v: 1,
    flightKey: intent.flightKey,
    kind,
    subject,
    value,
    previousValue,
    correction,
    firstAssignment,
    ...(intent.injectionId === undefined ? {} : { injectionId: intent.injectionId }),
  };
}

/**
 * Inserts each recipient's row, unique per user and dedupe key: a redelivered intent inserts
 * nothing and reads back the rows its first delivery wrote. Returns `notifications.id` per user.
 */
export async function insertNotifications(
  db: Db,
  intent: NotifyIntentV1,
  recipients: readonly Recipient[],
  render: (format: TimeFormat) => RenderedPush,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  const data = notificationData(intent);
  for (const run of chunk(recipients, NOTIFY_STATEMENT_ROWS)) {
    await db
      .insert(notifications)
      .values(
        run.map((recipient) => ({
          id: uuidv7(),
          userId: recipient.userId,
          flightInstanceId: recipient.flightInstanceId,
          flightSubscriptionId: recipient.subscriptionId,
          kind: intent.intent.kind,
          dedupeKey: intent.dedupeKey,
          ...render(recipient.timeFormat),
          data,
          isTest: intent.test,
        })),
      )
      .onConflictDoNothing({ target: [notifications.userId, notifications.dedupeKey] });
    const rows = await db
      .select({ id: notifications.id, userId: notifications.userId })
      .from(notifications)
      .where(
        and(
          eq(notifications.dedupeKey, intent.dedupeKey),
          inArray(
            notifications.userId,
            run.map((recipient) => recipient.userId),
          ),
        ),
      );
    for (const row of rows) {
      ids.set(row.userId, row.id);
    }
  }
  return ids;
}

/** Permission states that mean the device will not show a push (ruling P6). */
const SILENT_PERMISSIONS = ['denied', 'undetermined'] as const;

/**
 * The recipients' live device tokens: not invalidated, an `apns` or `fcm` token, and a permission
 * that is null (a client before increment 16 reports none, and is sent), `granted` or
 * `provisional`.
 */
export async function readTokens(db: Db, userIds: readonly string[]): Promise<RecipientToken[]> {
  const tokens: RecipientToken[] = [];
  for (const run of chunk(userIds, NOTIFY_STATEMENT_ROWS)) {
    const rows = await db
      .select({
        id: pushTokens.id,
        userId: pushTokens.userId,
        kind: pushTokens.kind,
        token: pushTokens.token,
        environment: pushTokens.environment,
        appId: pushTokens.appId,
      })
      .from(pushTokens)
      .where(
        and(
          inArray(pushTokens.userId, run),
          isNull(pushTokens.invalidatedAt),
          inArray(pushTokens.kind, [...PUSH_TARGET_KINDS]),
          or(
            isNull(pushTokens.permission),
            notInArray(pushTokens.permission, [...SILENT_PERMISSIONS]),
          ),
        ),
      )
      .orderBy(pushTokens.userId, pushTokens.id);
    for (const row of rows) {
      tokens.push({
        id: row.id,
        userId: row.userId,
        kind: row.kind as PushTargetKind,
        token: row.token,
        environment: row.environment as PushEnvironment,
        appId: row.appId,
      });
    }
  }
  return tokens;
}
