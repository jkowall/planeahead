/**
 * The pure half of the `notify` consumer (increment 15, ruling N9): which push jobs an intent
 * becomes, and how they are packed into `sendBatch` calls. No clock, no I/O.
 *
 * One target per live token of each recipient, each target's `subjectId` the token owner's user
 * id (the `push` consumer sends only while the token row still belongs to it, increment 14's
 * ruling R1) and `notificationId` that user's `notifications` row. Users who read a 12 hour clock
 * and users who read a 24 hour one get their own jobs (the text differs); each group is cut into
 * jobs of at most `PUSH_JOB_MAX_TARGETS`. Every job carries the intent's `timeSensitive` and
 * `expiresAt`, its kind's Android channel, and the flight key the collapse id is built from
 * (`pushCollapseId`: `{kind}:{flightKey}`), so a redelivered intent's push replaces the first.
 */

import {
  PUSH_JOB_MAX_TARGETS,
  androidChannelFor,
  type NotifyIntentV1,
  type PushEnvironment,
  type PushJobV1Input,
  type PushTargetKind,
  type PushTargetV1Input,
} from '@planeahead/shared';
import type { RenderedPush, TimeFormat } from './render';

/** A user the intent reaches, through their live subscription to the flight. */
export interface Recipient {
  readonly userId: string;
  readonly subscriptionId: string;
  readonly flightInstanceId: string;
  readonly timeFormat: TimeFormat;
}

/** A `push_tokens` row the intent may be sent to (live, a device kind, permission allowing). */
export interface RecipientToken {
  readonly id: string;
  readonly userId: string;
  readonly kind: PushTargetKind;
  readonly token: string;
  readonly environment: PushEnvironment;
  readonly appId: string;
}

export interface JobInput {
  readonly intent: NotifyIntentV1;
  readonly recipients: readonly Recipient[];
  /** `notifications.id` per user id. A recipient without one gets no target. */
  readonly notificationIds: ReadonlyMap<string, string>;
  readonly tokens: readonly RecipientToken[];
  readonly render: (format: TimeFormat) => RenderedPush;
  readonly newJobId: () => string;
}

/** Splits `items` into runs of at most `size`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const runs: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    runs.push(items.slice(start, start + size));
  }
  return runs;
}

/** The push jobs of one intent: per time format, its targets in runs of at most 50. */
export function buildPushJobs(input: JobInput): PushJobV1Input[] {
  const { intent } = input;
  const recipients = new Map(input.recipients.map((recipient) => [recipient.userId, recipient]));
  const targetsByFormat = new Map<TimeFormat, PushTargetV1Input[]>();
  for (const token of input.tokens) {
    const recipient = recipients.get(token.userId);
    const notificationId = input.notificationIds.get(token.userId);
    if (recipient === undefined || notificationId === undefined) {
      continue;
    }
    const targets = targetsByFormat.get(recipient.timeFormat) ?? [];
    targets.push({
      pushTokenId: token.id,
      subjectId: token.userId,
      kind: token.kind,
      token: token.token,
      environment: token.environment,
      appId: token.appId,
      notificationId,
      flightSubscriptionId: recipient.subscriptionId,
      attempt: 0,
    });
    targetsByFormat.set(recipient.timeFormat, targets);
  }
  const jobs: PushJobV1Input[] = [];
  for (const [format, targets] of targetsByFormat) {
    const { title, body } = input.render(format);
    for (const run of chunk(targets, PUSH_JOB_MAX_TARGETS)) {
      jobs.push({
        kind: 'push_job',
        jobId: input.newJobId(),
        test: intent.test,
        notificationKind: intent.intent.kind,
        flightKey: intent.flightKey,
        title,
        body,
        priority: 'high',
        timeSensitive: intent.intent.timeSensitive,
        channelId: androidChannelFor(intent.intent.kind),
        expiresAt: intent.intent.expiresAt,
        targets: run,
      });
    }
  }
  return jobs;
}

/** Queues: at most 100 messages in one `sendBatch`. */
export const SEND_BATCH_MAX_MESSAGES = 100;
/** Queues: at most 256 KB (Cloudflare counts 1 KB as 1,000 bytes) in one `sendBatch`. */
export const SEND_BATCH_MAX_BYTES = 256_000;
/**
 * What each message is counted as beyond its JSON body. Cloudflare documents about 100 bytes of
 * internal metadata per message; ten times that keeps the measure on the safe side, and costs at
 * most one 50-target job (about 13 KB) per call.
 */
export const SEND_BATCH_MESSAGE_OVERHEAD_BYTES = 1_024;

const encoder = new TextEncoder();

/** The bytes a job counts for in a `sendBatch`: its JSON (it is sent as `json`) plus overhead. */
export function sendBatchBytes(job: unknown): number {
  return encoder.encode(JSON.stringify(job)).byteLength + SEND_BATCH_MESSAGE_OVERHEAD_BYTES;
}

/**
 * Packs jobs, in order, into as few `sendBatch` calls as the limits allow: a call takes jobs
 * while it stays within 100 messages and 256 KB. A job too large for any call goes alone (the
 * queue then refuses it, and the intent retries into its dead letter queue, where it is seen).
 */
export function packSendBatches<T>(
  jobs: readonly T[],
  bytesOf: (job: T) => number = sendBatchBytes,
): T[][] {
  const calls: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const job of jobs) {
    const size = bytesOf(job);
    const full = current.length >= SEND_BATCH_MAX_MESSAGES || bytes + size > SEND_BATCH_MAX_BYTES;
    if (current.length > 0 && full) {
      calls.push(current);
      current = [];
      bytes = 0;
    }
    current.push(job);
    bytes += size;
  }
  if (current.length > 0) {
    calls.push(current);
  }
  return calls;
}
