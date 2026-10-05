/**
 * The transport soak (increment 16, ruling C9; plan section 4, "Transport gate and soak"). On
 * staging, for the hours an operator chooses on `/admin/push/soak` (src/routes/admin-soak.ts), a
 * five-minute tick injects a synthetic event into one test flight the owner's test devices follow,
 * and once an hour a canary sends two test pushes whose provider tokens are asked of `PushAuth`
 * together. The admin page counts what the providers answered from the delivery attempt log
 * (src/queues/push-outcomes.ts): every 403 and 429 reason, edge 52x answers without an
 * `apns-id`, and the sends. What that measures (review M1): edge 52x without an `apns-id` over
 * the soak's hours (R1 U1); `UnrelatedKeyIdInToken` on the sandbox host at staging's volume; and
 * `TooManyProviderTokenUpdates` from `PushAuth`'s own rotation, which rotation with agreeing
 * clocks does not cause; an isolate's clock skew at a rotation, or an `ExpiredProviderToken`, can
 * (review M1's skeptics), so such a row points at rotation, clock skew or a `PushAuth` fault
 * before the relay. It
 * does not settle R1 U2: no canary built from one team's keys can provoke the cross-account
 * error, and this one sends one token twice. U2 stays open until Cloudflare answers. A failing
 * soak points at the relay (src/push/transport.ts).
 *
 * The record is one JSON value in `CONFIG` KV (`PUSH_SOAK_KV_KEY`), where the ProviderBudget's
 * manual kill switch already lives: the soak's id, test flight, hours, start and end, the stop if
 * any, who started and stopped it, and the canary's `push_tokens` row id (never a device token). A
 * Postgres table would carry a staging-only harness into production's schema. KV is eventually
 * consistent across locations (up to a minute), so a stop can let one more tick through
 * elsewhere; the consumer reads the record again before it acts.
 *
 * The schedule. `PUSH_SOAK_CRON` is declared in staging's `triggers` only (wrangler.jsonc), and
 * production refuses to start a soak; every step below refuses in production as well. A tick
 * inside the soak (from its start, before its end and any stop) plans and nothing else (ruling
 * W1): an `inject` message on the `housekeeping` queue, whose consumer already runs cron-planned
 * work one message at a time on one Neon connection, and on every twelfth tick from the start,
 * the first included, a `canary` message. Each step makes its own ids. The injection id is
 * derived from the soak id and the slot (`soakInjectionId`, review n2), so a redelivered step, or
 * a tick the cron delivered twice, injects once per slot: the tracker writes nothing for an
 * injection id it has seen, and the repeat leaves an audit row with nothing written. The canary's
 * job ids are minted when its step runs (review n6), so the result page's ten-minute window,
 * which starts at a job id's instant, starts at the send however long the step queued.
 *
 * The injection is increment 15's injector path (`injectSyntheticEvent`) as `system`, its audit
 * row naming the soak and the operator who started it: a departure delay of 30, 60, 90 or 120
 * minutes in turn. The policy pushes a delay at any distance from departure (a gate change counts
 * only from six hours before it), and it reads as routine on the test devices every five minutes,
 * as a cancellation or a diversion would not. The values are 30 minutes apart, so a real delay
 * pushed meanwhile blocks at most one value in four (the policy's 15-minute step); and for 15
 * minutes after each real delay intent the injected ones push nothing, up to three ticks (the
 * policy's interval between delay intents, review n3). Every run of a step leaves an audit row,
 * a refusal before the tracker call included, so the 409s a suspicion causes count.
 *
 * The canary is increment 14's test push (`testPushJob`) to the token the operator chose, sent
 * twice at once through the push consumer's own batch handler, each job a batch of one with an
 * empty token cache of its own, the first token request of each held at a gate until both arrive
 * (or `PUSH_SOAK_GATE_TIMEOUT_MS` after the first). What it checks is that concurrent cold asks
 * of `PushAuth` get one token; it cannot show connection pooling (review M1): both sends share
 * this invocation and one token, while R1 U2's canary needs two different tokens from two
 * isolates. Two queue messages would not even ask together: Queues raises consumer concurrency
 * only after a batch has finished (R1 F46), so they run one after the other, and the push queue
 * runs a batch's jobs one after the other, the second finding the isolate's token cache warm. Its
 * audit row records how the gate opened (`gate`: `together`, `timeout`, or `unused` when no send
 * asked) and whether the two sends' first asks got the same token (`tokens_matched`, a boolean,
 * null unless both asked; never a token). Retries go to the push queue like any job's, and the
 * outcomes to persist, so each canary job has its delivery row and its result page.
 */

import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { auditLog, type Db } from '@planeahead/db';
import {
  PUSH_TARGET_KINDS,
  createUuidv7Generator,
  isFlightKey,
  isUuidv7,
  uuidv7,
  uuidv7Timestamp,
  type FlightKey,
  type PushJobV1Input,
  type PushOutcomeMessageV1,
} from '@planeahead/shared';
import type { CronContext, CronHandler } from '../cron/index';
import { environmentName, type Env } from '../env';
import { errorFields } from '../observability/log';
import type { QueueContext } from '../queues/index';
import { handlePushBatch, type PushConsumerDeps } from '../queues/push';
import {
  defaultInjectorFor,
  injectSyntheticEvent,
  type InjectionResult,
  type InjectorTracker,
} from '../routes/admin-inject';
import { readTestPushToken, testPushJob } from '../routes/admin-push';
import {
  durableCredentialSource,
  type DurableCredentialSourceOptions,
  type PushCredentialSource,
} from './credentials';

/** The KV key of the soak record. */
export const PUSH_SOAK_KV_KEY = 'push-soak:v1';
/** The tick: `PUSH_SOAK_CRON`'s interval. */
export const PUSH_SOAK_TICK_MS = 5 * 60_000;
/** The canary runs on every twelfth tick from the start, the first included: once an hour. */
export const PUSH_SOAK_CANARY_EVERY_TICKS = 12;
/** The hours a soak may run; 24 to 48 is the plan's. */
export const PUSH_SOAK_MIN_HOURS = 1;
export const PUSH_SOAK_MAX_HOURS = 72;
/** The departure delays the ticks inject, in turn. */
export const PUSH_SOAK_DELAY_MINUTES = [30, 60, 90, 120] as const;
/** How long a canary send waits at the gate for the other before it asks alone. */
export const PUSH_SOAK_GATE_TIMEOUT_MS = 5_000;
/** The canary's sends; two is the plan's "two isolates at once". */
export const PUSH_SOAK_CANARY_SENDS = 2;

const OperatorSchema = z.object({ email: z.string().nullable(), subject: z.string() });
export type PushSoakOperator = z.output<typeof OperatorSchema>;

const Uuidv7Schema = z.string().refine(isUuidv7, 'not a UUIDv7');

export const PushSoakRecordSchema = z.object({
  v: z.literal(1),
  id: Uuidv7Schema,
  flightKey: z.string().refine(isFlightKey, 'not a flight key'),
  hours: z.int().min(PUSH_SOAK_MIN_HOURS).max(PUSH_SOAK_MAX_HOURS),
  startedAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  stoppedAt: z.iso.datetime().nullable(),
  startedBy: OperatorSchema,
  stoppedBy: OperatorSchema.nullable(),
  /** The `push_tokens` row the canary sends to, and its kind; never the device token. */
  canary: z.object({ pushTokenId: z.uuid(), kind: z.enum(PUSH_TARGET_KINDS) }),
});
export type PushSoakRecord = z.output<typeof PushSoakRecordSchema>;

/**
 * The soak record; null when there is none, or when it is not JSON or not a record (a start
 * replaces it). Read as text and parsed here: KV's own `'json'` read throws on a value that is not
 * JSON, which only a hand-written value can be, and that must not fail the page, a start and
 * every tick until someone deletes the key (review n4).
 */
export async function readPushSoak(kv: Pick<KVNamespace, 'get'>): Promise<PushSoakRecord | null> {
  const text = await kv.get(PUSH_SOAK_KV_KEY, 'text');
  if (text === null) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = PushSoakRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function writePushSoak(
  kv: Pick<KVNamespace, 'put'>,
  record: PushSoakRecord,
): Promise<void> {
  await kv.put(PUSH_SOAK_KV_KEY, JSON.stringify(PushSoakRecordSchema.parse(record)));
}

/** Where an instant falls: before the start, inside, or after the end or a stop. */
export type PushSoakState = 'none' | 'not_started' | 'running' | 'stopped' | 'ended';

export interface PushSoakPosition {
  readonly state: PushSoakState;
  /** The tick's index from the start (0 for the first five minutes); null outside the soak. */
  readonly slot: number | null;
  /** Whether the tick sends the canary. */
  readonly canary: boolean;
}

/** The soak's state at `at`, and for a tick inside it, its slot and whether it sends the canary. */
export function pushSoakPosition(record: PushSoakRecord | null, at: number): PushSoakPosition {
  const outside = (state: PushSoakState): PushSoakPosition => ({
    state,
    slot: null,
    canary: false,
  });
  if (record === null) {
    return outside('none');
  }
  if (record.stoppedAt !== null && at >= Date.parse(record.stoppedAt)) {
    return outside('stopped');
  }
  if (at >= Date.parse(record.endsAt)) {
    return outside('ended');
  }
  const start = Date.parse(record.startedAt);
  if (at < start) {
    return outside('not_started');
  }
  const slot = Math.floor((at - start) / PUSH_SOAK_TICK_MS);
  return { state: 'running', slot, canary: slot % PUSH_SOAK_CANARY_EVERY_TICKS === 0 };
}

const SoakMessageBase = {
  kind: z.literal('push_soak'),
  soakId: Uuidv7Schema,
  slot: z.int().nonnegative(),
  /** The tick's scheduled time, ISO-8601. */
  runId: z.string().min(1).max(64),
};

/**
 * One step of one tick, on the `housekeeping` queue. It carries no ids: the inject step derives
 * its injection id from the soak and the slot, and the canary step mints its job ids when it runs
 * (reviews n2 and n6). A message queued before that still parses; the ids it carries are dropped.
 */
export const PushSoakMessageV1 = z.discriminatedUnion('step', [
  z.object({ ...SoakMessageBase, step: z.literal('inject') }),
  z.object({ ...SoakMessageBase, step: z.literal('canary') }),
]);
export type PushSoakMessageV1 = z.input<typeof PushSoakMessageV1>;

/**
 * A slot's injection id (review n2): a UUIDv7 that depends on the soak id and the slot alone, so
 * every run of the slot's inject step, a redelivery or a tick delivered twice, names the same
 * injection and the tracker writes it once. Its instant is the slot's (the soak id's own plus
 * the slot's ticks); the rest is SHA-256 of `push_soak:{soak id}:{slot}`, version and variant set.
 */
export async function soakInjectionId(soakId: string, slot: number): Promise<string> {
  const seed = `push_soak:${soakId}:${String(slot)}`;
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed)),
  ).slice(0, 16);
  const view = new DataView(bytes.buffer);
  const ms = uuidv7Timestamp(soakId) + slot * PUSH_SOAK_TICK_MS;
  view.setUint32(0, Math.floor(ms / 0x10000));
  view.setUint16(4, ms % 0x10000);
  view.setUint8(6, 0x70 | (view.getUint8(6) & 0x0f));
  view.setUint8(8, 0x80 | (view.getUint8(8) & 0x3f));
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Whether a `housekeeping` queue message is the soak's (src/queues/housekeeping.ts). */
export function isPushSoakMessage(body: unknown): boolean {
  return (
    typeof body === 'object' && body !== null && (body as { kind?: unknown }).kind === 'push_soak'
  );
}

export interface PushSoakPlanDeps {
  readonly kv?: Pick<KVNamespace, 'get'> | undefined;
  /** Where the steps go; the default is `HOUSEKEEPING_QUEUE`. */
  readonly sink?: Pick<Queue, 'sendBatch'> | undefined;
  /** The tick's instant when the cron gave none (a test driving the handler directly). */
  readonly now?: (() => number) | undefined;
}

/** The tick (`PUSH_SOAK_CRON`): plans the steps of a tick inside the soak, nothing otherwise. */
export async function planPushSoak(
  context: CronContext,
  deps: PushSoakPlanDeps = {},
): Promise<PushSoakPosition> {
  const { env, log } = context;
  if (environmentName(env) === 'production') {
    log.warn('cron_push_soak_refused', { reason: 'production' });
    return { state: 'none', slot: null, canary: false };
  }
  const at = context.scheduledTime ?? (deps.now ?? Date.now)();
  const record = await readPushSoak(deps.kv ?? env.CONFIG);
  const position = pushSoakPosition(record, at);
  if (record === null || position.slot === null) {
    log.info('cron_push_soak_idle', { state: position.state, soak_id: record?.id ?? null });
    return position;
  }
  const base = { kind: 'push_soak', soakId: record.id, slot: position.slot } as const;
  const runId = new Date(at).toISOString();
  const steps: PushSoakMessageV1[] = [{ ...base, runId, step: 'inject' }];
  if (position.canary) {
    steps.push({ ...base, runId, step: 'canary' });
  }
  await (deps.sink ?? env.HOUSEKEEPING_QUEUE).sendBatch(steps.map((body) => ({ body })));
  log.info('cron_push_soak_planned', {
    soak_id: record.id,
    slot: position.slot,
    canary: position.canary,
  });
  return position;
}

export interface PushSoakDeps {
  readonly kv?: Pick<KVNamespace, 'get'> | undefined;
  readonly now?: (() => number) | undefined;
  /** The test flight's tracker; the default is the injector's (`FLIGHT_TRACKER` at `enam`). */
  readonly injectorFor?: ((env: Env) => (flightKey: FlightKey) => InjectorTracker) | undefined;
  readonly canary?: PushSoakCanaryDeps | undefined;
}

type SoakStep = z.output<typeof PushSoakMessageV1>;
type SoakContext = Pick<QueueContext, 'env' | 'ctx' | 'log'>;

/** What every audit row of a step names: the soak, the tick, the operator who started it. */
function soakDetails(record: PushSoakRecord, message: SoakStep): Record<string, unknown> {
  return {
    soak_id: record.id,
    soak_slot: message.slot,
    operator_email: record.startedBy.email,
    operator_subject: record.startedBy.subject,
  };
}

/**
 * One step of one tick, from the `housekeeping` queue. Acknowledged unless a write it must make
 * first fails (then retried: an injection names its slot's id again, a canary mints new job ids):
 * a step of a soak since stopped or replaced does nothing, and neither does any step in
 * production.
 */
export async function runPushSoakMessage(
  body: unknown,
  context: SoakContext,
  db: Db,
  deps: PushSoakDeps = {},
): Promise<void> {
  const parsed = PushSoakMessageV1.safeParse(body);
  if (!parsed.success) {
    context.log.error('push_soak_message_invalid', { issue: parsed.error.issues[0]?.message });
    return;
  }
  const message = parsed.data;
  const log = context.log.child({
    soak_id: message.soakId,
    soak_step: message.step,
    soak_slot: message.slot,
  });
  if (environmentName(context.env) === 'production') {
    log.error('push_soak_refused', { reason: 'production' });
    return;
  }
  const record = await readPushSoak(deps.kv ?? context.env.CONFIG);
  const skip =
    record === null
      ? 'none'
      : record.id !== message.soakId
        ? 'replaced'
        : record.stoppedAt !== null
          ? 'stopped'
          : null;
  if (record === null || skip !== null) {
    log.info('push_soak_skipped', { reason: skip });
    return;
  }
  const step = { ...context, log };
  if (message.step === 'inject') {
    await soakInject(record, message, step, db, deps);
  } else {
    await soakCanary(record, message, step, db, deps);
  }
}

async function soakInject(
  record: PushSoakRecord,
  message: Extract<SoakStep, { step: 'inject' }>,
  { env, ctx, log }: SoakContext,
  db: Db,
  deps: PushSoakDeps,
): Promise<void> {
  const minutes =
    PUSH_SOAK_DELAY_MINUTES[message.slot % PUSH_SOAK_DELAY_MINUTES.length] ??
    PUSH_SOAK_DELAY_MINUTES[0];
  const { flightKey } = record;
  const result: InjectionResult = await injectSyntheticEvent({
    db,
    tracker: (deps.injectorFor ?? defaultInjectorFor)(env)(flightKey),
    flightKey,
    event: { kind: 'departure_delay', minutes },
    injectionId: await soakInjectionId(record.id, message.slot),
    now: deps.now ?? Date.now,
    waitUntil: (promise) => {
      ctx.waitUntil(promise);
    },
    log,
    audit: {
      actorType: 'system',
      requestId: `push_soak:${record.id}:${String(message.slot)}`,
      details: soakDetails(record, message),
    },
    recordRefusals: true,
  });
  log.info('push_soak_injected', {
    outcome: result.outcome,
    minutes,
    ...(result.outcome === 'refused' ? { refusal: result.refusal } : {}),
    ...(result.outcome === 'ignored' ? { reason: result.reason } : {}),
    ...(result.outcome === 'written'
      ? {
          intents: result.response.intents.length,
          written: result.response.intents.filter((intent) => intent.written).length,
        }
      : {}),
  });
}

/** The `outcome` of a canary's `push.soak_canary` audit row, like the injector's. */
export type PushSoakCanaryOutcome = 'pending' | 'sent' | 'refused' | 'error';

async function soakCanary(
  record: PushSoakRecord,
  message: Extract<SoakStep, { step: 'canary' }>,
  context: SoakContext,
  db: Db,
  deps: PushSoakDeps,
): Promise<void> {
  const { env, log } = context;
  const row = await readTestPushToken(db, { id: record.canary.pushTokenId });
  const refusal =
    row === undefined
      ? 'token_missing'
      : row.invalidated_at !== null
        ? 'token_invalidated'
        : row.kind !== record.canary.kind
          ? 'token_kind_changed'
          : null;
  const auditId = uuidv7();
  const refusedDetails = { ...soakDetails(record, message), kind: record.canary.kind };
  const audit = {
    id: auditId,
    subjectId: row?.user_id ?? null,
    actorType: 'system',
    action: 'push.soak_canary',
    targetType: 'push_token',
    targetId: record.canary.pushTokenId,
    requestId: `push_soak:${record.id}:${String(message.slot)}`,
  } as const;
  if (row === undefined || refusal !== null) {
    // Nothing is sent: the operator registers the token again, or starts a soak with another.
    await db.insert(auditLog).values({
      ...audit,
      details: { ...refusedDetails, outcome: 'refused' satisfies PushSoakCanaryOutcome, refusal },
    });
    log.warn('push_soak_canary_refused', { refusal });
    return;
  }
  // Review n6: the job ids are minted here, at the send, from the instant `expiresAt` counts
  // from, so the result page's window (from a job id's instant) is the job's. A generator of its
  // own: the shared one would carry a later instant over from its last id.
  const now = (deps.now ?? Date.now)();
  const mint = createUuidv7Generator(() => now);
  const jobIds = Array.from({ length: PUSH_SOAK_CANARY_SENDS }, () => mint());
  const details = { ...refusedDetails, job_ids: jobIds };
  const at = new Date(now).toISOString().slice(11, 19);
  const jobs = jobIds.map((jobId, index) =>
    testPushJob({
      row,
      jobId,
      now,
      appId: row.app_id,
      title: 'PlaneAhead soak canary',
      body: `Canary ${String(index + 1)} of ${String(jobIds.length)} from the ${environmentName(env)} transport soak at ${at} UTC (job ${jobId.slice(-8)}).`,
    }),
  );
  // Like the injector's (Q6): the row goes in before anything is sent, and is settled after.
  await db.insert(auditLog).values({
    ...audit,
    details: { ...details, outcome: 'pending' satisfies PushSoakCanaryOutcome },
  });
  const settle = async (outcome: PushSoakCanaryOutcome, extra: Record<string, unknown>) => {
    try {
      await db
        .update(auditLog)
        .set({ details: { ...details, outcome, ...extra } })
        .where(eq(auditLog.id, auditId));
    } catch (error) {
      log.error('push_soak_audit_unsettled', { outcome, ...errorFields(error) });
    }
  };
  const { gateTimeoutMs, ...canaryDeps } = deps.canary ?? {};
  const round = canaryRound(jobs.length, gateTimeoutMs ?? PUSH_SOAK_GATE_TIMEOUT_MS);
  try {
    const sends = await sendCanary(jobs, context, round, canaryDeps);
    await settle('sent', { sends, ...round.summary() });
    log.info('push_soak_canary_sent', { sends, ...round.summary() });
  } catch (error) {
    // Not retried: a later copy would not be two sends at once, and the next canary is due in
    // an hour. The pushes already sent were reported to persist as they went.
    await settle('error', {
      error_name: error instanceof Error ? error.name : 'unknown',
      ...round.summary(),
    });
    log.error('push_soak_canary_failed', errorFields(error));
  }
}

/** The push consumer's seams the canary passes through (tests fake the providers and queues). */
export interface PushSoakCanaryDeps extends Pick<
  PushConsumerDeps,
  'fetch' | 'configuration' | 'pushQueue' | 'persistQueue' | 'liveTokens' | 'now'
> {
  /** The `PushAuth` object of a credential, each send asking it through an empty cache. */
  readonly pushAuth?: DurableCredentialSourceOptions['stubFor'];
  readonly gateTimeoutMs?: number | undefined;
}

/** What one canary send's first attempt came to, as its outcome message reported it. */
export interface PushSoakCanarySend {
  readonly job_id: string;
  readonly outcome: string;
  readonly reason: string | null;
  readonly http_status: number | null;
  /** Whether the consumer acknowledged the one-message batch, or asked for a retry it never gets. */
  readonly settled: 'acked' | 'retried' | 'unsettled';
}

/** How a canary's gate opened: every send arrived, the wait ran out, or no send asked at all. */
export type PushSoakGateOpening = 'together' | 'timeout' | 'unused';

export interface PushSoakGate {
  /** Waits until every party has arrived, or `timeoutMs` after the first. */
  pass(): Promise<void>;
  /** How the gate opened; `unused` while no party has come. */
  opening(): PushSoakGateOpening;
}

/**
 * A gate `parties` callers pass together: once the last has arrived, or `timeoutMs` after the
 * first (a send that never asks, its token found inactive, must not hold the other for ever).
 * It remembers which of the two opened it.
 */
export function gateTogether(parties: number, timeoutMs: number): PushSoakGate {
  let arrived = 0;
  let opening: PushSoakGateOpening = 'unused';
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const openAs = (how: PushSoakGateOpening) => {
    if (opening === 'unused') {
      opening = how;
    }
    open();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    async pass() {
      arrived += 1;
      if (arrived >= parties) {
        clearTimeout(timer);
        openAs('together');
      } else {
        timer ??= setTimeout(() => {
          openAs('timeout');
        }, timeoutMs);
      }
      await opened;
    },
    opening: () => opening,
  };
}

/** What a canary round's audit row adds besides its sends (review M1). */
export interface PushSoakCanaryRound {
  readonly gate: PushSoakGateOpening;
  /** Whether every send's first token request got the same token; null unless every one asked. */
  readonly tokens_matched: boolean | null;
}

/**
 * A canary round: its gate, and the token each send's first request got, kept only to compare
 * them and never recorded or logged.
 */
export function canaryRound(parties: number, timeoutMs: number) {
  const gate = gateTogether(parties, timeoutMs);
  const firsts: (string | null)[] = Array.from({ length: parties }, () => null);
  return {
    /** Send `index`'s credentials: `source`, its first token request held at the gate. */
    credentials(index: number, source: PushCredentialSource): PushCredentialSource {
      let waited = false;
      return {
        async token(name) {
          if (waited) {
            return source.token(name);
          }
          waited = true;
          await gate.pass();
          const token = await source.token(name);
          firsts[index] = token;
          return token;
        },
        expire: (name, token) => source.expire(name, token),
      };
    },
    summary(): PushSoakCanaryRound {
      const asked = firsts.filter((token): token is string => token !== null);
      return {
        gate: gate.opening(),
        tokens_matched:
          asked.length === parties ? asked.every((token) => token === asked[0]) : null,
      };
    },
  };
}
export type PushSoakCanaryRoundState = ReturnType<typeof canaryRound>;

/** One job as the push queue delivers it, to the consumer's own batch handler. */
function batchOfOne(body: PushJobV1Input) {
  let settled: PushSoakCanarySend['settled'] = 'unsettled';
  const message: Message<unknown> = {
    id: `push-soak-canary-${body.jobId}`,
    timestamp: new Date(),
    body,
    attempts: 1,
    ack: () => {
      settled = 'acked';
    },
    retry: () => {
      settled = 'retried';
    },
  };
  const batch: MessageBatch<unknown> = {
    queue: 'push-soak-canary',
    messages: [message],
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    ackAll: () => {
      settled = 'acked';
    },
    retryAll: () => {
      settled = 'retried';
    },
  };
  return { batch, settled: () => settled };
}

/**
 * The canary's sends, all at once: each job a batch of one through `handlePushBatch` with its own
 * empty token cache, the first token request of each held at the round's gate, so the sends ask
 * `PushAuth` together. The outcome messages go on to persist as the consumer sends them; the
 * first attempt of each is read off on the way.
 */
async function sendCanary(
  jobs: readonly PushJobV1Input[],
  context: SoakContext,
  round: PushSoakCanaryRoundState,
  deps: Omit<PushSoakCanaryDeps, 'gateTimeoutMs'>,
): Promise<PushSoakCanarySend[]> {
  const { env } = context;
  const { pushAuth, ...consumer } = deps;
  // Never the isolate's cache: each send asks `PushAuth` as a cold isolate would.
  const coldSource = () => durableCredentialSource(env, { cache: new Map(), stubFor: pushAuth });
  const persistQueue = consumer.persistQueue ?? env.PERSIST_QUEUE;
  return Promise.all(
    jobs.map(async (job, index): Promise<PushSoakCanarySend> => {
      const reported: PushOutcomeMessageV1[] = [];
      const { batch, settled } = batchOfOne(job);
      await handlePushBatch(batch, context, {
        ...consumer,
        credentials: round.credentials(index, coldSource()),
        persistQueue: {
          send: (body, options) => {
            reported.push(body as PushOutcomeMessageV1);
            return persistQueue.send(body, options);
          },
        },
      });
      const first = reported[0]?.results[0];
      return {
        job_id: job.jobId,
        outcome: first?.outcome ?? 'unreported',
        reason: first?.reason ?? null,
        http_status: first?.httpStatus ?? null,
        settled: settled(),
      };
    }),
  );
}

/** `PUSH_SOAK_CRON`'s handler (src/cron/index.ts). */
export const pushSoakCron: CronHandler = async (context) => {
  await planPushSoak(context);
};
