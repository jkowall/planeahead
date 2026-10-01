/**
 * `push` queue consumer (increment 14, ruling P4, as the review round's rulings R1 to R3 amend
 * it): sends each job's targets through `PushTransport` and reports every outcome to `persist`.
 *
 * One Postgres read per batch, finished before the first send. This stage is network bound: no
 * database connection is in use while it waits on APNs and FCM (plan section 4, R1 section 4
 * item 6; Hyperdrive has the origin connection back once the read's statement ends), and
 * `persist` stays the only Postgres writer. What it reads is whether each token may still be sent
 * to (review ruling R1): a job is built before its sends, and a sign-out, an account switch or a
 * rotation can land in between (a retry or a hold waits minutes, and so can a first attempt
 * behind a backlog). `max_batch_size` 5 and `max_batch_timeout` 0 in wrangler.jsonc,
 * `max_concurrency` left to autoscale.
 *
 * Per batch:
 *
 *   1. Each job is validated (`PushJobV1`); one this build cannot read is acknowledged and logged,
 *      never retried (no build will ever send it).
 *   2. Token liveness, answered before the first provider request (ruling R1). ONE statement
 *      through `openDb` reads `id` and `user_id` of the `push_tokens` rows that are not
 *      invalidated, for every target the valid jobs could send (not past its job's window, its
 *      platform configured: at most 5 jobs of 50 targets). Its client is left to Hyperdrive like
 *      persist's and housekeeping's, not ended before the sends (`readLiveTokens` says why). A
 *      target is sent only when its row came back AND still belongs to the target's subject: an
 *      account switch keeps the row's id and moves the row to the new user (src/routes/devices.ts).
 *      Otherwise it is not requested: `failed`, reason `token_inactive`, its attempt count
 *      unchanged, which `persist` records like any failed delivery and which invalidates nothing.
 *      The same statement answers which of the targets' notifications a newer `notifications`
 *      row for the same user, kind and flight has superseded (increment 15 ruling Q16; newer by
 *      the intent's `producedAt`, then the row's `created_at` and id): such a
 *      target is not requested either (`failed`, reason `superseded`), so a retried first push
 *      cannot land after its correction. A target with no notification (the admin page's test
 *      push) is never superseded.
 *      If the read fails, NOTHING in the batch is sent: every target that needed it is re-enqueued
 *      unsent after `LIVENESS_RETRY_DELAY_SECONDS` (`retry`, reason `liveness_unavailable`), or
 *      dropped as `expired` when that would land past its window, and `push_liveness_failed` is
 *      logged at error level. Targets that are past their window or held (below) need no answer
 *      from the read and are decided as without it.
 *   3. Each target is sent with at most `PUSH_MAX_IN_FLIGHT` (6) requests in flight across the
 *      invocation: Workers let six connections wait for response headers at once, and a seventh
 *      would only queue behind them (R1 F43). Jobs run one after another, so the six are shared.
 *      Every request has the transport's 10-second timeout and its body is read or cancelled.
 *   4. A target past the job's `expiresAt` is dropped unsent (`expired`, decision 7); so is a retry
 *      whose next attempt would land after it. A target whose platform has no credentials is held
 *      (`not_configured`, ruling P7): re-enqueued unsent every five minutes until it expires. That
 *      hold is quiet in staging and locally, where the credentials may not exist yet; in
 *      production it means pushes are not going out, so `push_not_configured` is raised as an ops
 *      alert (an error line with the platform and the configuration's problem, never a value, and a
 *      Sentry event) at most once per platform per batch (ruling R3).
 *   5. The job is acknowledged ONCE, and only its retryable targets are re-enqueued, grouped by
 *      delay, each with its attempt count raised by one when it was requested: a sent target is
 *      never sent again by a retry of the whole message (`retry()` is never used for an outcome).
 *      All of a job's follow-ups, every delay group and every hold, go out in ONE `sendBatch`
 *      (ruling R2), each entry with its own `delaySeconds`; a job has at most 50 targets, so at
 *      most 50 entries, under the 100 a batch takes.
 *   6. The outcomes go to `persist` as one `push_outcome` message, so `persist` stays the only
 *      Postgres writer (it records the deliveries and invalidates dead tokens, ruling P5).
 *
 * If the `sendBatch` throws, the message is retried whole. Cloudflare documents only the success
 * case, that every message of a resolved `sendBatch` is written to disk, and says nothing about a
 * `sendBatch` that throws: neither that it wrote nothing nor that it may have written part of the
 * batch (https://developers.cloudflare.com/queues/configuration/javascript-apis/, read
 * 2026-09-30). So a throw is handled as if nothing was written; if some follow-ups were, their
 * targets are sent once more than planned. The whole-message retry also sends the job's already
 * sent targets again (the redelivery passes the liveness read like any other delivery);
 * `apns-collapse-id` and the Android tag make a second copy replace the first on screen. If only
 * the outcome message fails, twice, the job is still acknowledged and the loss is logged at error
 * level: the retries are safely queued, and a dead token will answer the same on its next send.
 * A job that exhausts the queue's retries goes to `push-dlq`, archived to R2 with an ops alert.
 */

import { and, eq, exists, inArray, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { notifications, openDb, pushTokens, type Db } from '@planeahead/db';
import {
  PushJobV1,
  PushOutcomeMessageV1,
  type PushJobV1Input,
  type PushOutcome,
  type PushTargetKind,
  type PushTargetResultV1,
  type PushTargetV1,
} from '@planeahead/shared';
import { environmentName, type Env } from '../env';
import { errorFields, type Logger } from '../observability/log';
import { raiseOpsAlert, type CaptureMessage } from '../observability/ops-alert';
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
/** How long a target waits, unsent, when its token's liveness could not be read (ruling R1). */
export const LIVENESS_RETRY_DELAY_SECONDS = 60;

/**
 * `push_tokens.id` to `user_id`, both in lower case (as Postgres prints a uuid), for the rows that
 * exist and are not invalidated.
 */
export type LiveTokens = ReadonlyMap<string, string>;

/**
 * What the batch's one liveness read answers: the live tokens (ruling R1) and, of the targets'
 * `notifications.id`s, those a newer row for the same user, kind and flight has superseded
 * (increment 15 ruling Q16), all in lower case.
 */
export interface LivenessAnswer {
  readonly tokens: LiveTokens;
  readonly superseded: ReadonlySet<string>;
}

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
  /** Where retries and holds are re-enqueued, one `sendBatch` per job; the default is `PUSH_QUEUE`. */
  readonly pushQueue?: Pick<Queue, 'sendBatch'>;
  /** Where outcomes go; the default is `PERSIST_QUEUE`. */
  readonly persistQueue?: Pick<Queue, 'send'>;
  /** The in-flight bound; 6 unless a test asks otherwise. */
  readonly maxInFlight?: number;
  /**
   * The liveness read (ruling R1): which of these `push_tokens` ids are live, and whose, and which
   * of these `notifications` ids are superseded (Q16). The default is `readLiveTokens` on this
   * environment's database.
   */
  readonly liveTokens?: (
    ids: readonly string[],
    notificationIds: readonly string[],
  ) => Promise<LivenessAnswer>;
  /** The Sentry call behind the `push_not_configured` ops alert; the default is Sentry's. */
  readonly capture?: CaptureMessage | undefined;
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

/**
 * The liveness read (ruling R1): ONE statement for the batch, `id` and `user_id` of the rows that
 * exist and are not invalidated, on a client `openDb` opens for it.
 *
 * The client is not ended before the sends, which ruling R1 asked for so that the read would not
 * take one of the six connections the sends use. It does not: Cloudflare counts a `connect()`
 * socket toward that limit only while the connection is being established, and says a Worker may
 * have many connections open as long as no more than six are waiting
 * (https://developers.cloudflare.com/workers/platform/limits/, read 2026-09-30). Nor does the idle
 * client hold a database connection while the sends wait: Hyperdrive returns the origin
 * connection to its pool when the statement's transaction completes
 * (https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/). And ending a
 * postgres.js client on Workers is not clean: its socket polyfill's pending read rejects after the
 * connection has dropped the socket's listeners, an unhandled rejection ("This socket has been
 * closed.") on every batch, which the review round's test run showed. So, like persist and
 * housekeeping, the client is left to Hyperdrive, which closes it when the invocation ends.
 */
export async function readLiveTokens(
  env: Env,
  ids: readonly string[],
  notificationIds: readonly string[] = [],
): Promise<LivenessAnswer> {
  const db: Db = openDb(env);
  const live = db
    .select({ what: sql<string>`'token'`.as('what'), id: pushTokens.id, userId: pushTokens.userId })
    .from(pushTokens)
    .where(and(inArray(pushTokens.id, [...ids]), isNull(pushTokens.invalidatedAt)));
  const rows =
    notificationIds.length === 0
      ? await live
      : await live.unionAll(supersededNotifications(db, notificationIds));
  const tokens = new Map<string, string>();
  const superseded = new Set<string>();
  for (const row of rows) {
    if (row.what === 'token') {
      tokens.set(row.id.toLowerCase(), row.userId.toLowerCase());
    } else {
      superseded.add(row.id.toLowerCase());
    }
  }
  return { tokens, superseded };
}

/**
 * Ruling Q16: the rows among `ids` that a newer `notifications` row for the same user, kind and
 * flight has superseded. Newer is ordered by the intent's `producedAt` (kept in `data`), then
 * `created_at`, then the uuidv7 id: notify inserts an intent when it gets to it, so an older
 * intent that waited out an outage in notify's retries is inserted after a newer one, and must
 * never supersede it (the orchestrator's ruling on part A2's caveat). A row without `producedAt`
 * (none since that ruling) is placed at its `created_at`. A test row never supersedes a real one,
 * so an injection cannot cancel a user's pending real push.
 */
function supersededNotifications(db: Db, ids: readonly string[]) {
  const newer = alias(notifications, 'newer');
  const newerAt = sql`coalesce((${newer.data} ->> 'producedAt')::timestamptz, ${newer.createdAt})`;
  const rowAt = sql`coalesce((${notifications.data} ->> 'producedAt')::timestamptz, ${notifications.createdAt})`;
  const correction = db
    .select({ one: sql`1` })
    .from(newer)
    .where(
      and(
        eq(newer.userId, notifications.userId),
        eq(newer.kind, notifications.kind),
        eq(newer.flightInstanceId, notifications.flightInstanceId),
        or(eq(newer.isTest, false), eq(notifications.isTest, true)),
        sql`(${newerAt}, ${newer.createdAt}, ${newer.id}) > (${rowAt}, ${notifications.createdAt}, ${notifications.id})`,
      ),
    );
  return db
    .select({
      what: sql<string>`'superseded'`.as('what'),
      id: notifications.id,
      userId: notifications.userId,
    })
    .from(notifications)
    .where(and(inArray(notifications.id, [...ids]), exists(correction)));
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

/** The token's row is gone, invalidated, or now another user's (ruling R1): nothing is sent. */
const TOKEN_INACTIVE: TransportOutcome = {
  outcome: 'failed',
  requested: false,
  reason: 'token_inactive',
  httpStatus: null,
  fcmErrorDetail: null,
};

/**
 * A newer notification for the same user, kind and flight exists (increment 15 ruling Q16): this
 * one, a retry or a first attempt behind a backlog, would land after its correction and put the
 * old value back on screen, so it is not sent. The newer row's own targets carry the news.
 */
const SUPERSEDED: TransportOutcome = {
  outcome: 'failed',
  requested: false,
  reason: 'superseded',
  httpStatus: null,
  fcmErrorDetail: null,
};

/** The liveness read failed (ruling R1): the target waits, unsent. */
const LIVENESS_UNAVAILABLE: TransportOutcome = {
  outcome: 'retry',
  requested: false,
  reason: 'liveness_unavailable',
  delaySeconds: LIVENESS_RETRY_DELAY_SECONDS,
  httpStatus: null,
};

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
    // Apple's sandbox delivery-log key, whatever the outcome (ruling R11).
    ...(outcome.apnsUniqueId === undefined ? {} : { apnsUniqueId: outcome.apnsUniqueId }),
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

/** The liveness read's answer for the batch; `null` when the read failed. */
type Liveness = LivenessAnswer | null;

/**
 * Step 2 of the header: the ids of every target the batch could send, and of their notifications
 * (Q16), read once. A batch with nothing to send (every target past its window or held) reads
 * nothing.
 */
async function readLiveness(
  jobs: readonly PushJobV1[],
  configuration: PushConfiguration,
  nowMs: number,
  liveTokens: NonNullable<PushConsumerDeps['liveTokens']>,
  log: Logger,
): Promise<Liveness> {
  const ids = new Set<string>();
  const notificationIds = new Set<string>();
  for (const job of jobs) {
    if (nowMs >= Date.parse(job.expiresAt)) {
      continue;
    }
    for (const target of job.targets) {
      if (configuration[target.kind].configured) {
        ids.add(target.pushTokenId);
        if (target.notificationId !== undefined) {
          notificationIds.add(target.notificationId);
        }
      }
    }
  }
  if (ids.size === 0) {
    return { tokens: new Map(), superseded: new Set() };
  }
  try {
    return await liveTokens([...ids], [...notificationIds]);
  } catch (error) {
    // Nothing in the batch is sent: a token that might have signed out must not get a push.
    log.error('push_liveness_failed', {
      jobs: jobs.length,
      targets: ids.size,
      delay_seconds: LIVENESS_RETRY_DELAY_SECONDS,
      ...errorFields(error),
    });
    return null;
  }
}

interface JobReport {
  readonly results: PushTargetResultV1[];
  readonly requeues: Map<number, PushTargetV1[]>;
  /** The platforms a target was held for, or dropped for, having no usable credentials. */
  readonly unconfigured: ReadonlySet<PushTargetKind>;
}

async function sendJob(
  job: PushJobV1,
  transports: Record<PushTargetKind, PushTransport>,
  configuration: PushConfiguration,
  liveness: Liveness,
  now: () => number,
  maxInFlight: number,
): Promise<JobReport> {
  const expiresAtMs = Date.parse(job.expiresAt);
  const requeues = new Map<number, PushTargetV1[]>();
  const unconfigured = new Set<PushTargetKind>();
  const requeue = (delaySeconds: number, target: PushTargetV1): void => {
    const group = requeues.get(delaySeconds) ?? [];
    group.push(target);
    requeues.set(delaySeconds, group);
  };
  const results = await mapWithConcurrency(job.targets, maxInFlight, async (target) => {
    const startedAt = now();
    const at = new Date(startedAt).toISOString();
    if (startedAt >= expiresAtMs) {
      return unsent(target, 'expired', 'expired', at);
    }
    if (!configuration[target.kind].configured) {
      unconfigured.add(target.kind);
      if (startedAt + NOT_CONFIGURED_HOLD_SECONDS * 1000 >= expiresAtMs) {
        return unsent(target, 'expired', 'not_configured', at);
      }
      requeue(NOT_CONFIGURED_HOLD_SECONDS, target);
      return unsent(target, 'not_configured', 'not_configured', at);
    }
    let outcome: TransportOutcome;
    if (liveness === null) {
      outcome = LIVENESS_UNAVAILABLE;
    } else if (
      liveness.tokens.get(target.pushTokenId.toLowerCase()) !== target.subjectId.toLowerCase()
    ) {
      outcome = TOKEN_INACTIVE;
    } else if (
      target.notificationId !== undefined &&
      liveness.superseded.has(target.notificationId.toLowerCase())
    ) {
      outcome = SUPERSEDED;
    } else {
      outcome = await transports[target.kind].send(job, target);
    }
    const decision = decideTarget(target, outcome, expiresAtMs, now());
    if (decision.requeue !== null) {
      requeue(decision.requeue.delaySeconds, decision.requeue.target);
    }
    return decision.result;
  });
  return { results, requeues, unconfigured };
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
  const liveTokens =
    deps.liveTokens ?? ((ids, notificationIds) => readLiveTokens(env, ids, notificationIds));
  const production = environmentName(env) === 'production';
  /** Platforms already alerted as not configured in this batch (ruling R3). */
  const alerted = new Set<PushTargetKind>();
  let acked = 0;
  let retried = 0;

  const jobs: { readonly message: Message<unknown>; readonly job: PushJobV1 }[] = [];
  for (const message of batch.messages) {
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
    jobs.push({ message, job: parsed.data });
  }

  // Answered before the first provider request (ruling R1).
  const liveness = await readLiveness(
    jobs.map(({ job }) => job),
    configuration,
    now(),
    liveTokens,
    log,
  );

  for (const { message, job } of jobs) {
    try {
      const report = await sendJob(job, transports, configuration, liveness, now, maxInFlight);

      if (production) {
        for (const kind of report.unconfigured) {
          if (!alerted.has(kind)) {
            alerted.add(kind);
            raiseOpsAlert(
              'push_not_configured',
              { platform: kind, reason: configuration[kind].problems.join('; ') },
              log,
              deps.capture,
            );
          }
        }
      }

      // Every follow-up of the job in one batch, each with its own delay (ruling R2).
      const followUps = [...report.requeues].map(([delaySeconds, targets]) => ({
        body: { ...job, targets } satisfies PushJobV1Input,
        delaySeconds,
      }));
      if (followUps.length > 0) {
        try {
          await pushQueue.sendBatch(followUps);
        } catch (error) {
          log.error('push_requeue_failed', {
            message_id: message.id,
            job_id: job.jobId,
            attempts: message.attempts,
            follow_ups: followUps.length,
            ...errorFields(error),
          });
          message.retry({ delaySeconds: PUSH_REQUEUE_FAILURE_DELAY_SECONDS });
          retried += 1;
          continue;
        }
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
