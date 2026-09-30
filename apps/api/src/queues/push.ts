/**
 * `push` queue consumer (increment 14, ruling P4): sends each job's targets through
 * `PushTransport` and reports every outcome to `persist`.
 *
 * No Postgres here: this stage is network bound, so it holds no database connection while it
 * waits on APNs and FCM (plan section 4, R1 section 4 item 6). `max_batch_size` 5 and
 * `max_batch_timeout` 0 in wrangler.jsonc, `max_concurrency` left to autoscale.
 *
 * Per job:
 *
 *   1. The job is validated (`PushJobV1`); one this build cannot read is acknowledged and logged,
 *      never retried (no build will ever send it).
 *   2. Each target is sent with at most `PUSH_MAX_IN_FLIGHT` (6) requests in flight across the
 *      invocation: Workers let six connections wait for response headers at once, and a seventh
 *      would only queue behind them (R1 F43). Jobs run one after another, so the six are shared.
 *      Every request has the transport's 10-second timeout and its body is read or cancelled.
 *   3. A target past the job's `expiresAt` is dropped unsent (`expired`, decision 7); so is a
 *      retry whose next attempt would land after it. A target whose platform has no credentials is
 *      held (`not_configured`, ruling P7): re-enqueued unsent every five minutes until it expires.
 *   4. The job is acknowledged ONCE, and only the retryable targets are re-enqueued, each group
 *      with its explicit `delaySeconds` and its attempt count raised by one: a sent target is never
 *      sent again by a retry of the whole message (`retry()` is never used for an outcome).
 *   5. The outcomes go to `persist` as one `push_outcome` message, so `persist` stays the only
 *      Postgres writer (it records the deliveries and invalidates dead tokens, ruling P5).
 *
 * If re-enqueueing fails, the message is retried whole (the sent targets may then be sent twice,
 * which `apns-collapse-id` and the Android tag make replace the first on screen); if only the
 * outcome message fails, twice, the job is still acknowledged and the loss is logged at error
 * level: the retries are safely queued, and a dead token will answer the same on its next send.
 * A job that exhausts the queue's retries goes to `push-dlq`, archived to R2 with an ops alert.
 */

import {
  PushJobV1,
  PushOutcomeMessageV1,
  type PushJobV1Input,
  type PushOutcome,
  type PushTargetKind,
  type PushTargetResultV1,
  type PushTargetV1,
} from '@planeahead/shared';
import type { Env } from '../env';
import { errorFields } from '../observability/log';
import { pushConfiguration, fcmServiceAccount, type PushConfiguration } from '../push/config';
import { durableCredentialSource, type PushCredentialSource } from '../push/credentials';
import {
  NOT_CONFIGURED_HOLD_SECONDS,
  createApnsTransport,
  createFcmTransport,
  type PushTransport,
  type TransportOutcome,
} from '../push/transport';
import type { QueueContext } from './index';

/** Workers: six connections may wait for response headers at once per invocation (R1 F43). */
export const PUSH_MAX_IN_FLIGHT = 6;
/** Queues' largest `delaySeconds` is held under, so a long `Retry-After` still enqueues. */
export const MAX_QUEUE_DELAY_SECONDS = 12 * 60 * 60;
/** The delay a whole message is retried with when its follow-ups could not be enqueued. */
export const PUSH_REQUEUE_FAILURE_DELAY_SECONDS = 30;

export interface PushConsumerDeps {
  /** The transports per platform; the defaults are built from the environment. */
  readonly transports?: Partial<Record<PushTargetKind, PushTransport>>;
  /** The platforms' configuration; the default reads the secrets. */
  readonly configuration?: PushConfiguration;
  /** Where the bearer tokens come from, for the default transports. */
  readonly credentials?: PushCredentialSource;
  /** The fetch the default transports use. */
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** Where retries and holds are re-enqueued; the default is `PUSH_QUEUE`. */
  readonly pushQueue?: Pick<Queue, 'send'>;
  /** Where outcomes go; the default is `PERSIST_QUEUE`. */
  readonly persistQueue?: Pick<Queue, 'send'>;
  /** The in-flight bound; 6 unless a test asks otherwise. */
  readonly maxInFlight?: number;
}

/** Runs `work` over `items` with at most `limit` in flight; results keep the input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

function defaultTransports(
  env: Env,
  deps: PushConsumerDeps,
): Record<PushTargetKind, PushTransport> {
  const credentials = deps.credentials ?? durableCredentialSource(env, { now: deps.now });
  const fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
  const account = fcmServiceAccount(env);
  return {
    apns: createApnsTransport({ fetch: fetchImpl, credentials, now: deps.now }),
    fcm: createFcmTransport({
      fetch: fetchImpl,
      credentials,
      now: deps.now,
      projectId: account.ok ? account.value.projectId : '',
    }),
  };
}

interface TargetDecision {
  readonly result: PushTargetResultV1;
  /** Re-enqueue this target after this many seconds, with its attempt count as given. */
  readonly requeue: { readonly delaySeconds: number; readonly target: PushTargetV1 } | null;
}

function baseResult(target: PushTargetV1, at: string) {
  return {
    pushTokenId: target.pushTokenId,
    subjectId: target.subjectId,
    kind: target.kind,
    environment: target.environment,
    appId: target.appId,
    ...(target.notificationId === undefined ? {} : { notificationId: target.notificationId }),
    at,
  };
}

function unsent(
  target: PushTargetV1,
  outcome: Extract<PushOutcome, 'expired' | 'not_configured'>,
  reason: string,
  at: string,
): PushTargetResultV1 {
  return {
    ...baseResult(target, at),
    attempt: target.attempt,
    requested: false,
    outcome,
    reason,
    httpStatus: null,
    providerId: null,
    apnsTimestampMs: null,
    fcmErrorDetail: null,
    retryDelaySeconds: null,
  };
}

/** Folds one transport outcome into the target's result and, for a retry, its re-enqueue. */
export function decideTarget(
  target: PushTargetV1,
  outcome: TransportOutcome,
  expiresAtMs: number,
  nowMs: number,
): TargetDecision {
  const at = new Date(nowMs).toISOString();
  const attempt = target.attempt + (outcome.requested ? 1 : 0);
  const common = {
    ...baseResult(target, at),
    attempt,
    requested: outcome.requested,
    httpStatus: outcome.httpStatus,
  };
  switch (outcome.outcome) {
    case 'sent':
      return {
        result: {
          ...common,
          outcome: 'sent',
          reason: null,
          providerId: outcome.providerId,
          apnsTimestampMs: null,
          fcmErrorDetail: null,
          retryDelaySeconds: null,
        },
        requeue: null,
      };
    case 'invalid_token':
      return {
        result: {
          ...common,
          outcome: 'invalid_token',
          reason: outcome.reason,
          providerId: null,
          apnsTimestampMs: outcome.apnsTimestampMs,
          fcmErrorDetail: outcome.fcmErrorDetail,
          retryDelaySeconds: null,
        },
        requeue: null,
      };
    case 'failed':
      return {
        result: {
          ...common,
          outcome: 'failed',
          reason: outcome.reason,
          providerId: null,
          apnsTimestampMs: null,
          fcmErrorDetail: outcome.fcmErrorDetail,
          retryDelaySeconds: null,
        },
        requeue: null,
      };
    case 'retry': {
      const delaySeconds = Math.min(MAX_QUEUE_DELAY_SECONDS, Math.max(0, outcome.delaySeconds));
      const late = nowMs + delaySeconds * 1000 >= expiresAtMs;
      return {
        result: {
          ...common,
          // Past the relevance window by the time it could be sent again: dropped now (decision 7).
          outcome: late ? 'expired' : 'retry',
          reason: outcome.reason,
          providerId: null,
          apnsTimestampMs: null,
          fcmErrorDetail: null,
          retryDelaySeconds: late ? null : delaySeconds,
        },
        requeue: late ? null : { delaySeconds, target: { ...target, attempt } },
      };
    }
  }
}

interface JobReport {
  readonly results: PushTargetResultV1[];
  readonly requeues: Map<number, PushTargetV1[]>;
}

async function sendJob(
  job: PushJobV1,
  transports: Record<PushTargetKind, PushTransport>,
  configuration: PushConfiguration,
  now: () => number,
  maxInFlight: number,
): Promise<JobReport> {
  const expiresAtMs = Date.parse(job.expiresAt);
  const requeues = new Map<number, PushTargetV1[]>();
  const results = await mapWithConcurrency(job.targets, maxInFlight, async (target) => {
    const startedAt = now();
    const at = new Date(startedAt).toISOString();
    if (startedAt >= expiresAtMs) {
      return unsent(target, 'expired', 'expired', at);
    }
    if (!configuration[target.kind].configured) {
      if (startedAt + NOT_CONFIGURED_HOLD_SECONDS * 1000 >= expiresAtMs) {
        return unsent(target, 'expired', 'not_configured', at);
      }
      const held = requeues.get(NOT_CONFIGURED_HOLD_SECONDS) ?? [];
      held.push(target);
      requeues.set(NOT_CONFIGURED_HOLD_SECONDS, held);
      return unsent(target, 'not_configured', 'not_configured', at);
    }
    const outcome = await transports[target.kind].send(job, target);
    const decision = decideTarget(target, outcome, expiresAtMs, now());
    if (decision.requeue !== null) {
      const group = requeues.get(decision.requeue.delaySeconds) ?? [];
      group.push(decision.requeue.target);
      requeues.set(decision.requeue.delaySeconds, group);
    }
    return decision.result;
  });
  return { results, requeues };
}

function tally(results: readonly PushTargetResultV1[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const result of results) {
    const key = result.reason === null ? result.outcome : `${result.outcome}:${result.reason}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export async function handlePushBatch(
  batch: MessageBatch<unknown>,
  { env, log }: QueueContext,
  deps: PushConsumerDeps = {},
): Promise<void> {
  const now = deps.now ?? Date.now;
  const configuration = deps.configuration ?? pushConfiguration(env);
  const transports = { ...defaultTransports(env, deps), ...deps.transports };
  const pushQueue = deps.pushQueue ?? env.PUSH_QUEUE;
  const persistQueue = deps.persistQueue ?? env.PERSIST_QUEUE;
  const maxInFlight = deps.maxInFlight ?? PUSH_MAX_IN_FLIGHT;
  let acked = 0;
  let retried = 0;

  for (const message of batch.messages) {
    try {
      const parsed = PushJobV1.safeParse(message.body);
      if (!parsed.success) {
        // No build will ever send it; the body is not logged (it carries device tokens).
        const issue = parsed.error.issues[0];
        log.error('push_job_invalid', {
          message_id: message.id,
          attempts: message.attempts,
          issue: issue?.message,
          path: issue?.path.map(String).join('.'),
        });
        message.ack();
        acked += 1;
        continue;
      }
      const job = parsed.data;
      const report = await sendJob(job, transports, configuration, now, maxInFlight);

      try {
        for (const [delaySeconds, targets] of report.requeues) {
          const next: PushJobV1Input = { ...job, targets };
          await pushQueue.send(next, { delaySeconds });
        }
      } catch (error) {
        log.error('push_requeue_failed', {
          message_id: message.id,
          job_id: job.jobId,
          attempts: message.attempts,
          ...errorFields(error),
        });
        message.retry({ delaySeconds: PUSH_REQUEUE_FAILURE_DELAY_SECONDS });
        retried += 1;
        continue;
      }

      const outcome = PushOutcomeMessageV1.safeParse({
        kind: 'push_outcome',
        jobId: job.jobId,
        test: job.test,
        results: report.results,
      });
      if (!outcome.success) {
        // A bug, not a transient: the pushes went out, so the job must not be sent again.
        log.error('push_outcome_invalid', {
          job_id: job.jobId,
          issue: outcome.error.issues[0]?.message,
          path: outcome.error.issues[0]?.path.map(String).join('.'),
        });
      }
      let recorded = false;
      for (let attempt = 1; attempt <= 2 && !recorded && outcome.success; attempt += 1) {
        try {
          await persistQueue.send(outcome.data);
          recorded = true;
        } catch (error) {
          log.error('push_outcome_send_failed', {
            job_id: job.jobId,
            attempt,
            targets: report.results.length,
            ...errorFields(error),
          });
        }
      }
      log.info('push_job_done', {
        job_id: job.jobId,
        test: job.test,
        kind: job.notificationKind,
        targets: job.targets.length,
        requeued: [...report.requeues.values()].reduce((sum, group) => sum + group.length, 0),
        outcomes: tally(report.results),
        recorded,
      });
      message.ack();
      acked += 1;
    } catch (error) {
      // Nothing above should throw; if it does, the whole message comes back after a pause.
      log.error('push_job_failed', {
        message_id: message.id,
        attempts: message.attempts,
        ...errorFields(error),
      });
      message.retry({ delaySeconds: PUSH_REQUEUE_FAILURE_DELAY_SECONDS });
      retried += 1;
    }
  }

  log.info('push_batch_done', { queue: batch.queue, size: batch.messages.length, acked, retried });
}
