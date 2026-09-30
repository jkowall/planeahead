/**
 * The `push_outcome` message on the `persist` queue (increment 14, rulings P4 and P5): what the
 * `push` consumer sends after each job, written here because `persist` is the only Postgres writer.
 *
 * Deliveries. One `notification_deliveries` row per notification and push token, upserted on the
 * unique key `(notification_id, push_token_id)`, so a redelivered outcome is a no-op (the update's
 * WHERE finds nothing new and writes no row version). A test job's targets carry no notification
 * id: their row is keyed by the job id and marked `is_test` (ruling P8). Outcomes arrive at least
 * once and out of order, so the row follows the NEWEST attempt: a higher attempt count wins, a
 * final status (`sent`, `failed`, `invalid_token`) replaces a `queued` one at the same count, and
 * `sent` is never replaced (the user has the notification; a later attempt could only come from a
 * redelivered job). Every attempt's outcome and reason are merged into `attempt_log` whatever the
 * order, which is what the admin page counts by reason (ruling P9) and increment 16's soak reads.
 *
 * Status per outcome: `sent`; `invalid_token`; `failed` for `failed` and `expired` (dropped past the
 * relevance window, the reason saying why; a token the push consumer found signed out, invalidated
 * or moved to another user is `failed` with `token_inactive`, review ruling R1, and invalidates
 * nothing); `queued` for `retry` and `not_configured` (still in flight). `error` is the reason;
 * `provider_message_id` the `apns-id` or FCM message name. An attempt's `attempt_log` entry also
 * keeps Apple's `apns-unique-id` (`u`) when a sandbox answer carried one (ruling R11), the key to
 * the notification in the Push Notifications Console.
 *
 * Dead tokens (ruling P5). A token is invalidated only by the answers listed in
 * `invalidationRule`: APNs `Unregistered` and `ExpiredToken` only when the row's `registered_at` is
 * at or before Apple's 410 timestamp (a token the app registered again after APNs saw it die is
 * live again), and not at all without a timestamp; `BadDeviceToken` and `DeviceTokenNotForTopic`
 * always; FCM `UNREGISTERED` and `SENDER_ID_MISMATCH` always, `INVALID_ARGUMENT` only when the
 * error's detail was an `FcmError` (a `BadRequest` is our payload's fault, not the token's).
 * An APNs answer is about the topic and environment it was sent with, so the invalidation also
 * requires the row's `app_id` and `environment` to be the ones the target was sent with: a test
 * push to a hand-typed app id, or a row the app re-registered with another app id since, is not
 * invalidated by an answer about a different topic. `invalidated_at` is set once; a later
 * registration of the same token clears it (`POST /v1/devices`).
 *
 * `last_used_at` is the time of the token's newest send that reached the provider and was
 * accepted: each sent token gets its own result's `at`, in one statement for the message (review
 * ruling R6), never moved back, and never written on a row that is already invalidated (ruling R1:
 * a push accepted just before a sign-out does not touch the signed-out row).
 */

import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { notificationDeliveries, pushTokens, type Db } from '@planeahead/db';
import type { PushOutcome, PushOutcomeMessageV1, PushTargetResultV1 } from '@planeahead/shared';

export function isPushOutcomeMessage(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { kind?: unknown }).kind === 'push_outcome'
  );
}

/** Whether an outcome invalidates its token, and on which condition (ruling P5). */
export type InvalidationRule = 'none' | 'always' | 'guarded';

export function invalidationRule(result: PushTargetResultV1): InvalidationRule {
  if (result.outcome !== 'invalid_token' || result.reason === null) {
    return 'none';
  }
  if (result.kind === 'apns') {
    switch (result.reason) {
      case 'Unregistered':
      case 'ExpiredToken':
        return result.apnsTimestampMs === null ? 'none' : 'guarded';
      case 'BadDeviceToken':
      case 'DeviceTokenNotForTopic':
        return 'always';
      default:
        return 'none';
    }
  }
  switch (result.reason) {
    case 'UNREGISTERED':
    case 'SENDER_ID_MISMATCH':
      return 'always';
    case 'INVALID_ARGUMENT':
      return result.fcmErrorDetail === 'FcmError' ? 'always' : 'none';
    default:
      return 'none';
  }
}

export type DeliveryStatus = 'queued' | 'sent' | 'failed' | 'invalid_token';

export function deliveryStatus(outcome: PushOutcome): DeliveryStatus {
  switch (outcome) {
    case 'sent':
      return 'sent';
    case 'invalid_token':
      return 'invalid_token';
    case 'failed':
    case 'expired':
      return 'failed';
    case 'retry':
    case 'not_configured':
      return 'queued';
  }
}

/** The `attempt_log` key of one result: the attempt count and the outcome. */
export function attemptLogKey(result: PushTargetResultV1): string {
  return `${String(result.attempt)}:${result.outcome}`;
}

export interface PushOutcomeReport {
  readonly deliveries: number;
  readonly invalidated: number;
  readonly lastUsed: number;
}

/** The newest of each notification and token (a job names each token once; this is defence). */
function newestPerKey(
  message: PushOutcomeMessageV1,
): Map<string, { readonly notificationId: string; readonly result: PushTargetResultV1 }> {
  const rows = new Map<string, { notificationId: string; result: PushTargetResultV1 }>();
  for (const result of message.results) {
    const notificationId = result.notificationId ?? message.jobId;
    rows.set(`${notificationId}|${result.pushTokenId}`, { notificationId, result });
  }
  return rows;
}

export async function recordPushOutcomes(
  db: Db,
  message: PushOutcomeMessageV1,
): Promise<PushOutcomeReport> {
  const rows = [...newestPerKey(message).values()].map(({ notificationId, result }) => ({
    notificationId,
    subjectId: result.subjectId,
    channel: result.kind,
    pushTokenId: result.pushTokenId,
    status: deliveryStatus(result.outcome),
    attempts: result.attempt,
    providerMessageId: result.outcome === 'sent' ? result.providerId : null,
    error: result.outcome === 'sent' ? null : result.reason,
    sentAt: result.outcome === 'sent' ? result.at : null,
    isTest: message.test,
    attemptLog: {
      [attemptLogKey(result)]: {
        r: result.reason,
        s: result.httpStatus,
        p: result.providerId,
        at: result.at,
        ...(result.apnsUniqueId === undefined ? {} : { u: result.apnsUniqueId }),
      },
    },
  }));

  const existing = notificationDeliveries;
  // Whether the incoming row is newer than the stored one (the ordering rule in the header).
  const newer: SQL = sql`(${existing.status} <> 'sent' and (excluded.status = 'sent'
    or excluded.attempts > ${existing.attempts}
    or (excluded.attempts = ${existing.attempts} and ${existing.status} = 'queued'
        and excluded.status <> 'queued')))`;
  const written = await db
    .insert(notificationDeliveries)
    .values(rows)
    .onConflictDoUpdate({
      target: [existing.notificationId, existing.pushTokenId],
      set: {
        status: sql`case when ${newer} then excluded.status else ${existing.status} end`,
        attempts: sql`greatest(${existing.attempts}, excluded.attempts)`,
        providerMessageId: sql`case when ${newer} then excluded.provider_message_id
          else ${existing.providerMessageId} end`,
        error: sql`case when ${newer} then excluded.error else ${existing.error} end`,
        sentAt: sql`case when ${newer} then excluded.sent_at else ${existing.sentAt} end`,
        attemptLog: sql`${existing.attemptLog} || excluded.attempt_log`,
      },
      // A redelivery changes nothing: no row version is written.
      setWhere: sql`${newer} or not (${existing.attemptLog} @> excluded.attempt_log)`,
    })
    .returning({ id: existing.id });

  let invalidated = 0;
  for (const result of message.results) {
    const rule = invalidationRule(result);
    if (rule === 'none') {
      continue;
    }
    const conditions: SQL[] = [
      eq(pushTokens.id, result.pushTokenId),
      isNull(pushTokens.invalidatedAt),
      eq(pushTokens.kind, result.kind),
    ];
    if (result.kind === 'apns') {
      conditions.push(
        eq(pushTokens.appId, result.appId),
        eq(pushTokens.environment, result.environment),
      );
    }
    if (rule === 'guarded') {
      conditions.push(
        sql`${pushTokens.registeredAt} <= to_timestamp(${result.apnsTimestampMs}::double precision / 1000)`,
      );
    }
    const updated = await db
      .update(pushTokens)
      .set({ invalidatedAt: sql`now()` })
      .where(and(...conditions))
      .returning({ id: pushTokens.id });
    invalidated += updated.length;
  }

  // Each sent token its own newest send (ruling R6); a job names a token once, this is defence.
  const newestSend = new Map<string, { readonly at: string; readonly ms: number }>();
  for (const result of message.results) {
    if (result.outcome !== 'sent') {
      continue;
    }
    const ms = Date.parse(result.at);
    const previous = newestSend.get(result.pushTokenId);
    if (previous === undefined || ms > previous.ms) {
      newestSend.set(result.pushTokenId, { at: result.at, ms });
    }
  }
  let lastUsed = 0;
  if (newestSend.size > 0) {
    const sends = sql.join(
      [...newestSend].map(([id, send]) => sql`(${id}::uuid, ${send.at}::timestamptz)`),
      sql`, `,
    );
    const updated = await db.execute<{ id: string }>(sql`
      update ${pushTokens} set last_used_at = sends.at
      from (values ${sends}) as sends(id, at)
      where ${pushTokens.id} = sends.id
        and ${pushTokens.invalidatedAt} is null
        and (${pushTokens.lastUsedAt} is null or ${pushTokens.lastUsedAt} < sends.at)
      returning ${pushTokens.id}
    `);
    lastUsed = updated.length;
  }

  return { deliveries: written.length, invalidated, lastUsed };
}
