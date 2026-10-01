/**
 * `notify` queue consumer (increment 15, ruling N9): stage 1 of the push path (plan section 4).
 * Each message is one `NotifyIntentV1` that `persist` forwarded from a FlightTracker's outbox.
 * `max_batch_size` 10, `max_batch_timeout` 1 s, `max_concurrency` 5 in wrangler.jsonc.
 *
 * Per intent (src/notify/recipients.ts and jobs.ts hold the steps):
 *
 *   1. The flight's live (not tombstoned) subscriptions with their users' preferences, less the
 *      muted, the users with push off, the users whose toggle for the intent is off, and, for a
 *      test intent on production, the users not in `PUSH_INJECT_ALLOWED_USER_IDS`.
 *   2. One `notifications` row per remaining user, unique per user and dedupe key (a redelivery
 *      inserts nothing and reads back the first delivery's rows), marked `is_test` for a test.
 *   3. The live device tokens of those whose subscription was `live_tracked` when the intent was
 *      produced (only they are pushed, the orchestrator's ruling after part 3; review ruling Q1:
 *      still flagged, or released at or after `producedAt`), less tokens whose permission is
 *      `denied` or `undetermined`, and less tokens that already have a `notification_deliveries`
 *      row for the recipient's notification (the duplicate guard, Q1).
 *   4. `push` jobs of at most 50 targets (src/notify/jobs.ts), sent in as few `sendBatch` calls as
 *      the queue's limits allow (100 messages, 256 KB), one after another.
 *
 * The intent is acknowledged only after its last `sendBatch` succeeded. Any failure (Postgres, a
 * `sendBatch`) retries it whole (`consumeBatch` with notify's own policy, review ruling Q2: persist
 * confirmed the intent once forwarded, so this message is its only copy). The delay is
 * `min(120, 2^attempts)` seconds and `max_retries` is 100, about three hours, so delivery follows
 * a recovery within two minutes; when the next attempt would land past the intent's `expiresAt`
 * the message is acknowledged and `notify_intent_expired` logged instead (nothing sent would be
 * relevant); the sixth failed attempt raises the `notify_intent_failing` ops alert once while the
 * retries continue; the dead letter queue keeps only poison. The redelivery re-sends ALL of
 * its jobs: a `sendBatch` that throws may have written part of its batch or none of it (Cloudflare
 * documents only the success case), so re-sending everything is the only way to lose no target.
 * The duplicate push that can cause is tolerated (plan section 4): the collapse id
 * `{kind}:{flightKey}` replaces the first on screen, and `persist` records the second send on the
 * same delivery row (unique per notification and token). An intent this build cannot read is
 * acknowledged and logged: no build will ever send it.
 *
 * It sends nothing itself: the `push` consumer (increment 14, src/queues/push.ts) holds the
 * transport, re-reads each token's liveness before sending, and reports outcomes to `persist`.
 * The Postgres client is opened once per batch and left to Hyperdrive, as persist's is.
 */

import { openDb, type Db } from '@planeahead/db';
import { NotifyIntentV1, PushJobV1, uuidv7 } from '@planeahead/shared';
import { environmentName } from '../env';
import { buildPushJobs, packSendBatches } from '../notify/jobs';
import {
  deliveryKey,
  insertNotifications,
  readDeliveredTargets,
  readSubscribers,
  readTokens,
  selectRecipients,
  type DropReason,
} from '../notify/recipients';
import { renderPush, type RenderedPush, type TimeFormat } from '../notify/render';
import { allowedTestPushUserIds } from '../lib/push-allow-list';
import { errorFields } from '../observability/log';
import { raiseOpsAlert, type CaptureMessage } from '../observability/ops-alert';
import { consumeBatch, type FailurePolicy } from './consume';
import type { QueueContext } from './index';

/** Notify's longest wait between attempts (ruling Q2): delivery follows a recovery in 2 minutes. */
export const NOTIFY_MAX_RETRY_DELAY_SECONDS = 120;
/** The attempt whose failure raises the `notify_intent_failing` ops alert, once (Q2). */
export const NOTIFY_ALERT_ATTEMPT = 6;

/** `min(120, 2^attempts)` seconds: with `max_retries` 100, a runway of about three hours. */
export function notifyRetryDelaySeconds(attempts: number): number {
  return Math.min(NOTIFY_MAX_RETRY_DELAY_SECONDS, 2 ** Math.max(0, Math.min(attempts, 7)));
}

export interface NotifyConsumerDeps {
  /** The database; the default opens this environment's (Hyperdrive). */
  readonly db?: Db;
  /** The clock the expiry decision reads (ruling Q2); `Date.now` by default. */
  readonly now?: () => number;
  /** The Sentry call behind the `notify_intent_failing` ops alert; the default is Sentry's. */
  readonly capture?: CaptureMessage | undefined;
  /** Where the jobs go; the default is `PUSH_QUEUE`. */
  readonly pushQueue?: Pick<Queue, 'sendBatch'>;
  /** Job ids; UUIDv7 by default. */
  readonly newJobId?: () => string;
}

/** What one intent came to, for the log line and the tests. */
export interface NotifyReport {
  readonly subscribers: number;
  readonly recipients: number;
  /** Recipients live-tracked when the intent was produced (ruling Q1), the only ones pushed. */
  readonly pushRecipients: number;
  readonly dropped: Record<DropReason, number>;
  readonly notifications: number;
  /** Live tokens skipped because a delivery of this intent already reached them (Q1). */
  readonly alreadyDelivered: number;
  readonly targets: number;
  readonly jobs: number;
  readonly sendBatches: number;
}

export interface NotifyIntentDeps {
  readonly db: Db;
  readonly pushQueue: Pick<Queue, 'sendBatch'>;
  readonly production: boolean;
  readonly allowedTestUserIds: ReadonlySet<string>;
  readonly newJobId: () => string;
}

/** One intent, end to end; throws on any failure so the message is retried whole. */
export async function notifyIntent(
  intent: NotifyIntentV1,
  deps: NotifyIntentDeps,
): Promise<NotifyReport> {
  const subscribers = await readSubscribers(deps.db, intent.flightKey);
  const { recipients, pushed, dropped } = selectRecipients(subscribers, intent, {
    production: deps.production,
    allowedTestUserIds: deps.allowedTestUserIds,
  });
  const rendered = new Map<TimeFormat, RenderedPush>();
  const render = (format: TimeFormat): RenderedPush => {
    const known = rendered.get(format);
    if (known !== undefined) {
      return known;
    }
    const text = renderPush(intent, format);
    rendered.set(format, text);
    return text;
  };
  const notificationIds =
    recipients.length === 0
      ? new Map<string, string>()
      : await insertNotifications(deps.db, intent, recipients, render);
  const liveTokens =
    pushed.length === 0
      ? []
      : await readTokens(
          deps.db,
          pushed.map((recipient) => recipient.userId),
        );
  // The duplicate guard (ruling Q1): a token an earlier delivery of this intent already reached.
  const delivered =
    liveTokens.length === 0
      ? new Set<string>()
      : await readDeliveredTargets(deps.db, [
          ...new Set(pushed.flatMap((recipient) => notificationIds.get(recipient.userId) ?? [])),
        ]);
  const tokens = liveTokens.filter((token) => {
    const notificationId = notificationIds.get(token.userId);
    return notificationId === undefined || !delivered.has(deliveryKey(notificationId, token.id));
  });
  // Validated as the push consumer will read them: a job this build builds wrong is a bug the
  // retries carry into the dead letter queue, where it is archived and alerted.
  const jobs = buildPushJobs({
    intent,
    recipients: pushed,
    notificationIds,
    tokens,
    render,
    newJobId: deps.newJobId,
  }).map((job) => PushJobV1.parse(job));
  const calls = packSendBatches(jobs);
  for (const call of calls) {
    await deps.pushQueue.sendBatch(call.map((job) => ({ body: job, contentType: 'json' })));
  }
  return {
    subscribers: subscribers.length,
    recipients: recipients.length,
    pushRecipients: pushed.length,
    dropped,
    notifications: notificationIds.size,
    alreadyDelivered: liveTokens.length - tokens.length,
    targets: jobs.reduce((sum, job) => sum + job.targets.length, 0),
    jobs: jobs.length,
    sendBatches: calls.length,
  };
}

export async function handleNotifyBatch(
  batch: MessageBatch<unknown>,
  { env, log }: QueueContext,
  deps: NotifyConsumerDeps = {},
): Promise<void> {
  const intentDeps: NotifyIntentDeps = {
    db: deps.db ?? openDb(env),
    pushQueue: deps.pushQueue ?? env.PUSH_QUEUE,
    production: environmentName(env) === 'production',
    allowedTestUserIds: allowedTestPushUserIds(env),
    newJobId: deps.newJobId ?? uuidv7,
  };
  const now = deps.now ?? Date.now;
  /** Messages whose sixth attempt failed in this batch: one alert names them all (Q2). */
  const alerting: string[] = [];
  const policy: FailurePolicy<unknown> = (message, error) => {
    const delaySeconds = notifyRetryDelaySeconds(message.attempts);
    if (message.attempts === NOTIFY_ALERT_ATTEMPT) {
      alerting.push(message.id);
    }
    const parsed = NotifyIntentV1.safeParse(message.body);
    if (!parsed.success) {
      return { action: 'retry', delaySeconds };
    }
    const { intent } = parsed.data;
    if (now() + delaySeconds * 1000 < Date.parse(intent.expiresAt)) {
      return { action: 'retry', delaySeconds };
    }
    // The next attempt would land past the relevance window: nothing it could send would be
    // shown, and a late inbox row would only mislead, so the intent is dropped here, not
    // dead-lettered.
    log.error('notify_intent_expired', {
      message_id: message.id,
      attempts: message.attempts,
      flight_key: parsed.data.flightKey,
      kind: intent.kind,
      expires_at: intent.expiresAt,
      ...errorFields(error),
    });
    return { action: 'ack' };
  };
  const outcome = await consumeBatch(
    batch,
    async (message) => {
      const parsed = NotifyIntentV1.safeParse(message.body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        log.error('notify_intent_invalid', {
          message_id: message.id,
          attempts: message.attempts,
          issue: issue?.message,
          path: issue?.path.map(String).join('.'),
        });
        return;
      }
      const intent = parsed.data;
      const report = await notifyIntent(intent, intentDeps);
      log.info('notify_intent_done', {
        message_id: message.id,
        attempts: message.attempts,
        flight_key: intent.flightKey,
        kind: intent.intent.kind,
        subject: intent.intent.subject,
        correction: intent.intent.correction,
        test: intent.test,
        subscribers: report.subscribers,
        recipients: report.recipients,
        push_recipients: report.pushRecipients,
        dropped_not_allow_listed: report.dropped.not_allow_listed,
        dropped_muted: report.dropped.muted,
        dropped_push_disabled: report.dropped.push_disabled,
        dropped_preference_off: report.dropped.preference_off,
        notifications: report.notifications,
        already_delivered: report.alreadyDelivered,
        targets: report.targets,
        jobs: report.jobs,
        send_batches: report.sendBatches,
      });
    },
    log,
    policy,
  );
  if (alerting.length > 0) {
    // Raised once per intent, at its sixth failed attempt, while its retries continue (Q2).
    raiseOpsAlert(
      'notify_intent_failing',
      {
        queue: batch.queue,
        attempts: NOTIFY_ALERT_ATTEMPT,
        intents: alerting.length,
        message_ids: alerting.slice(0, 10),
      },
      log,
      deps.capture,
    );
  }
  log.info('notify_batch_done', {
    queue: batch.queue,
    size: batch.messages.length,
    ...outcome,
  });
}
