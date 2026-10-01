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
 * injection exercises the real path. Review ruling Q1 reads the gate at the intent's
 * `producedAt` rather than now: a subscription whose slot persist released at or after it is
 * pushed too (`liveTrackedAt`), and a token that already has a `notification_deliveries` row for
 * the recipient's notification is not pushed again (`readDeliveredTargets`).
 */

import { and, eq, inArray, isNotNull, isNull, notInArray, or } from 'drizzle-orm';
import {
  flightInstances,
  flightSubscriptions,
  notificationDeliveries,
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
  /** Whether the subscription holds a live-tracking slot now. */
  readonly liveTracked: boolean;
  /**
   * When persist released the slot because the flight was over (ruling Q1): the releasing row's
   * Durable Object instant; null while held, never held, or taken again.
   */
  readonly liveTrackedReleasedAt: string | null;
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
      liveTrackedReleasedAt: flightSubscriptions.liveTrackedReleasedAt,
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
  /** Those of `recipients` live-tracked when the intent was produced: only they are pushed. */
  readonly pushed: Recipient[];
  readonly dropped: Record<DropReason, number>;
}

export interface SelectionOptions {
  /** Production: a test intent reaches only `allowedTestUserIds`. */
  readonly production: boolean;
  /** `PUSH_INJECT_ALLOWED_USER_IDS`, lower case. */
  readonly allowedTestUserIds: ReadonlySet<string>;
}

/**
 * Whether the subscription was live-tracked when the intent was produced (ruling Q1): it holds
 * its slot, or persist released the slot at or after `producedAt`. The confirming alarm writes a
 * cancellation's intent and the rows that release the slot in one flush, and an arrival delay
 * can be produced on the observation that lands the flight; persist applies the release before
 * this consumer reads, so the flag alone would push neither. A subscription the cap refused
 * never held a slot and is never stamped, so it stays inbox only.
 */
export function liveTrackedAt(
  row: Pick<SubscriberRow, 'liveTracked' | 'liveTrackedReleasedAt'>,
  producedAt: string,
): boolean {
  if (row.liveTracked) {
    return true;
  }
  return (
    row.liveTrackedReleasedAt !== null &&
    Date.parse(row.liveTrackedReleasedAt) >= Date.parse(producedAt)
  );
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
    if (liveTrackedAt(row, intent.producedAt)) {
      pushed.push(recipient);
    }
  }
  return { recipients, pushed, dropped };
}

/**
 * What a `notifications` row keeps of its intent (`data`), for the inbox. `producedAt` orders a
 * user's rows for the push consumer's supersession (ruling Q16): an intent notify reaches late
 * (after an outage) is inserted after a newer one, but was produced before it.
 */
function notificationData(intent: NotifyIntentV1): Record<string, unknown> {
  const { kind, subject, value, previousValue, correction, firstAssignment } = intent.intent;
  return {
    v: 1,
    flightKey: intent.flightKey,
    producedAt: intent.producedAt,
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

/** The key of one notification's delivery to one token, lower case. */
export function deliveryKey(notificationId: string, pushTokenId: string): string {
  return `${notificationId.toLowerCase()}:${pushTokenId.toLowerCase()}`;
}

/**
 * The duplicate guard (ruling Q1, review finding F6): which of these notifications already have a
 * `notification_deliveries` row for a token, whatever its status (`deliveryKey`). A token with one
 * was handed to the push consumer by an earlier delivery of the same intent, which persist then
 * recorded, so the finished tracker's re-send of an intent whose confirmation was lost pushes
 * nothing again; a retry after a failed `sendBatch` finds no row and still sends.
 */
export async function readDeliveredTargets(
  db: Db,
  notificationIds: readonly string[],
): Promise<Set<string>> {
  const delivered = new Set<string>();
  for (const run of chunk(notificationIds, NOTIFY_STATEMENT_ROWS)) {
    const rows = await db
      .select({
        notificationId: notificationDeliveries.notificationId,
        pushTokenId: notificationDeliveries.pushTokenId,
      })
      .from(notificationDeliveries)
      .where(
        and(
          inArray(notificationDeliveries.notificationId, run),
          isNotNull(notificationDeliveries.pushTokenId),
        ),
      );
    for (const row of rows) {
      if (row.pushTokenId !== null) {
        delivered.add(deliveryKey(row.notificationId, row.pushTokenId));
      }
    }
  }
  return delivered;
}
