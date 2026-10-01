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
 *   3. The live device tokens of those whose subscription is `live_tracked` (only they are pushed,
 *      the orchestrator's ruling after part 3), less tokens whose permission is `denied` or
 *      `undetermined`.
 *   4. `push` jobs of at most 50 targets (src/notify/jobs.ts), sent in as few `sendBatch` calls as
 *      the queue's limits allow (100 messages, 256 KB), one after another.
 *
 * The intent is acknowledged only after its last `sendBatch` succeeded. Any failure (Postgres, a
 * `sendBatch`) retries it whole with backoff (`consumeBatch`), and the redelivery re-sends ALL of
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
  insertNotifications,
  readSubscribers,
  readTokens,
  selectRecipients,
  type DropReason,
} from '../notify/recipients';
import { renderPush, type RenderedPush, type TimeFormat } from '../notify/render';
import { allowedTestPushUserIds } from '../lib/push-allow-list';
import { consumeBatch } from './consume';
import type { QueueContext } from './index';

export interface NotifyConsumerDeps {
  /** The database; the default opens this environment's (Hyperdrive). */
  readonly db?: Db;
  /** Where the jobs go; the default is `PUSH_QUEUE`. */
  readonly pushQueue?: Pick<Queue, 'sendBatch'>;
  /** Job ids; UUIDv7 by default. */
  readonly newJobId?: () => string;
}

/** What one intent came to, for the log line and the tests. */
export interface NotifyReport {
  readonly subscribers: number;
  readonly recipients: number;
  /** Recipients whose subscription is `live_tracked`, the only ones pushed. */
  readonly pushRecipients: number;
  readonly dropped: Record<DropReason, number>;
  readonly notifications: number;
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
  const tokens =
    pushed.length === 0
      ? []
      : await readTokens(
          deps.db,
          pushed.map((recipient) => recipient.userId),
        );
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
        targets: report.targets,
        jobs: report.jobs,
        send_batches: report.sendBatches,
      });
    },
    log,
  );
  log.info('notify_batch_done', {
    queue: batch.queue,
    size: batch.messages.length,
    ...outcome,
  });
}
