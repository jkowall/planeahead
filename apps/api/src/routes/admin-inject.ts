/**
 * The event injector (increment 15, ruling N11): an admin action behind the same Cloudflare
 * Access middleware as every `/admin` path (src/routes/admin.ts mounts it), linked from the push
 * section of `/admin`.
 *
 *   - `GET /admin/push/inject`: a form taking a flight key and one event: an origin or a
 *     destination gate change to a given gate, a departure delay of N minutes, a cancellation, or
 *     a diversion to an ICAO airport code.
 *   - `POST /admin/push/inject`: same origin only, like the account deletion and the test push.
 *     It reads the tracker's current snapshot (`getState`), applies the event to a copy
 *     (`applyInjectedEvent`), and calls the tracker's `injectPolicyEvent` with that copy and a
 *     fresh UUIDv7 injection id. The tracker classifies the copy against its stored snapshot and
 *     policy state with the real policy, confirmed by construction, and writes the intents through
 *     its outbox as tests (persist forwards them to `notify`, which renders and queues the push
 *     jobs); it stores neither the copy nor the policy state. The answer page lists each intent
 *     and whether it was written (false: a replay, whose dedupe key exists already), with a
 *     button that replays the same injection id, which must write nothing. An `audit_log` row
 *     names the operator.
 *
 * On staging and locally any tracker may be injected; on production only a flight one of whose
 * live (not unsubscribed) subscribers is in `PUSH_INJECT_ALLOWED_USER_IDS`, else the form says
 * why. `notify` then sends a test intent on production to those users alone, and on every
 * environment only to subscriptions flagged `live_tracked`; every subscriber who passes the
 * preferences gets the `notifications` row, marked `is_test`.
 *
 * The policy keeps its windows for an injection: an origin gate counts from six hours before
 * scheduled out until out, a destination gate from off to in, and a delay is measured on the
 * best estimate of out (an observed out wins over the injected estimate). An event the policy
 * finds nothing in answers "no intents", which is the policy's verdict, not a failure.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Context } from 'hono';
import { auditLog, flightInstances, flightSubscriptions, openDb, type Db } from '@planeahead/db';
import {
  DO_CALL_DEADLINE_MS,
  FlightStatusSchema,
  GetStateResponseV1,
  ICAO_AIRPORT_RE,
  InjectPolicyEventResponseV1,
  RPC_SCHEMA_VERSION,
  isFlightKey,
  isSyntheticIcao,
  isUuidv7,
  uuidv7,
  type FlightKey,
  type FlightStatus,
  type FlightStatusInput,
} from '@planeahead/shared';
import { environmentName, type AppBindings, type Env } from '../env';
import { DeadlineExceededError, callWithDeadline } from '../lib/deadline';
import { esc, renderPage, table } from '../lib/html';
import { allowedTestPushUserIds } from '../lib/push-allow-list';
import { TRACKER_LOCATION_HINT, isAbsentTrackerError, type TrackerRpc } from '../lib/trackers';
import { createLogger } from '../observability/log';

export const ADMIN_INJECT_PATH = '/admin/push/inject';

/** The events the form offers (ruling N11). */
export const INJECTED_EVENT_KINDS = [
  'origin_gate',
  'destination_gate',
  'departure_delay',
  'cancellation',
  'diversion',
] as const;
export type InjectedEventKind = (typeof INJECTED_EVENT_KINDS)[number];

export type InjectedEvent =
  | { readonly kind: 'origin_gate' | 'destination_gate'; readonly gate: string }
  | { readonly kind: 'departure_delay'; readonly minutes: number }
  | { readonly kind: 'cancellation' }
  | { readonly kind: 'diversion'; readonly airport: string };

/** A delay the form accepts: up to a day. */
export const INJECTED_DELAY_MAX_MINUTES = 1_440;
const GATE_RE = /^[A-Za-z0-9-]{1,8}$/;

/** The two tracker RPCs the injector calls, narrowed so a test can hand in a fake. */
export interface InjectorTracker extends Pick<TrackerRpc, 'getState'> {
  injectPolicyEvent(input: unknown): Promise<unknown>;
}

export interface AdminInjectOptions {
  readonly db?: ((env: Env) => Db) | undefined;
  /** The tracker of a flight key; the default is `FLIGHT_TRACKER.getByName` at `enam`. */
  readonly injectorFor?: ((env: Env) => (flightKey: FlightKey) => InjectorTracker) | undefined;
  readonly now?: (() => number) | undefined;
}

function defaultInjectorFor(env: Env): (flightKey: FlightKey) => InjectorTracker {
  return (flightKey) =>
    env.FLIGHT_TRACKER.getByName(flightKey, { locationHint: TRACKER_LOCATION_HINT });
}

export type AppliedEvent =
  | { readonly ok: true; readonly status: FlightStatusInput }
  | { readonly ok: false; readonly message: string };

const plusMinutes = (iso: string, minutes: number): string =>
  new Date(Date.parse(iso) + minutes * 60_000).toISOString();

/**
 * The synthetic next snapshot: a copy of `snapshot` with the event applied, observed at `now`
 * (pure; the tracker never stores it). A delay of N minutes puts the estimates of out and in N
 * minutes after their scheduled times, so the departure intent carries the arrival it implies;
 * a diversion names the airport as the actual destination and the status `diverted`.
 */
export function applyInjectedEvent(
  snapshot: FlightStatus,
  event: InjectedEvent,
  now: number,
): AppliedEvent {
  const base = {
    ...snapshot,
    times: { ...snapshot.times },
    fetchedAt: new Date(now).toISOString(),
  };
  switch (event.kind) {
    case 'origin_gate':
      return { ok: true, status: { ...base, originGate: event.gate } };
    case 'destination_gate':
      return { ok: true, status: { ...base, destinationGate: event.gate } };
    case 'cancellation':
      return { ok: true, status: { ...base, status: 'cancelled' } };
    case 'diversion': {
      if (event.airport === snapshot.destination.icao) {
        return { ok: false, message: `${event.airport} is the planned destination.` };
      }
      const synthetic = isSyntheticIcao(event.airport) ? { synthetic: true } : {};
      return {
        ok: true,
        status: {
          ...base,
          status: 'diverted',
          actualDestination: { icao: event.airport, ...synthetic },
        },
      };
    }
    case 'departure_delay': {
      const { scheduledOut, scheduledIn } = snapshot.times;
      if (scheduledOut === undefined) {
        return { ok: false, message: 'The snapshot has no scheduled out to measure a delay from.' };
      }
      const delaySec = event.minutes * 60;
      const times = {
        ...base.times,
        estimatedOut: plusMinutes(scheduledOut, event.minutes),
        ...(scheduledIn === undefined
          ? {}
          : { estimatedIn: plusMinutes(scheduledIn, event.minutes) }),
      };
      return {
        ok: true,
        status: {
          ...base,
          times,
          departureDelaySec: delaySec,
          ...(scheduledIn === undefined ? {} : { arrivalDelaySec: delaySec }),
        },
      };
    }
  }
}

/** The form's fields as typed (re-shown on a refusal). */
export interface InjectForm {
  readonly flightKey: string;
  readonly event: string;
  readonly gate: string;
  readonly minutes: string;
  readonly airport: string;
  /** Blank on the form; the replay button carries the id of the injection it repeats. */
  readonly injectionId: string;
}

function readForm(body: Record<string, unknown>): InjectForm {
  const field = (name: string): string => {
    const value = body[name];
    return typeof value === 'string' ? value.trim() : '';
  };
  return {
    flightKey: field('flight_key'),
    event: field('event'),
    gate: field('gate'),
    minutes: field('minutes'),
    airport: field('airport').toUpperCase(),
    injectionId: field('injection_id').toLowerCase(),
  };
}

export type ParsedInjection =
  | {
      readonly ok: true;
      readonly flightKey: FlightKey;
      readonly event: InjectedEvent;
      /** Null: mint a fresh one. */
      readonly injectionId: string | null;
    }
  | { readonly ok: false; readonly message: string };

function parseEvent(form: InjectForm): InjectedEvent | string {
  switch (form.event as InjectedEventKind) {
    case 'origin_gate':
    case 'destination_gate':
      return GATE_RE.test(form.gate)
        ? { kind: form.event as 'origin_gate' | 'destination_gate', gate: form.gate }
        : 'A gate is 1 to 8 letters, digits or hyphens.';
    case 'departure_delay': {
      const minutes = /^\d{1,4}$/.test(form.minutes) ? Number(form.minutes) : NaN;
      return Number.isInteger(minutes) && minutes <= INJECTED_DELAY_MAX_MINUTES
        ? { kind: 'departure_delay', minutes }
        : `A delay is a whole number of minutes from 0 to ${String(INJECTED_DELAY_MAX_MINUTES)}.`;
    }
    case 'cancellation':
      return { kind: 'cancellation' };
    case 'diversion':
      return ICAO_AIRPORT_RE.test(form.airport)
        ? { kind: 'diversion', airport: form.airport }
        : 'A diversion names a four-character ICAO airport code, like KSFO.';
    default:
      return 'Choose an event.';
  }
}

/** Validates the form (pure). */
export function parseInjection(form: InjectForm): ParsedInjection {
  if (!isFlightKey(form.flightKey)) {
    return { ok: false, message: 'That is not a flight key (like AAL-100-2026-09-19-KJFK).' };
  }
  const event = parseEvent(form);
  if (typeof event === 'string') {
    return { ok: false, message: event };
  }
  if (form.injectionId !== '' && !isUuidv7(form.injectionId)) {
    return { ok: false, message: 'A replayed injection id is a UUIDv7.' };
  }
  return {
    ok: true,
    flightKey: form.flightKey,
    event,
    injectionId: form.injectionId === '' ? null : form.injectionId,
  };
}

const EVENT_LABELS: Record<InjectedEventKind, string> = {
  origin_gate: 'Origin gate change (to the gate below)',
  destination_gate: 'Destination gate change (to the gate below)',
  departure_delay: 'Departure delay (of the minutes below)',
  cancellation: 'Cancellation',
  diversion: 'Diversion (to the airport below)',
};

function injectForm(values: Partial<InjectForm> = {}): string {
  const options = INJECTED_EVENT_KINDS.map(
    (kind) =>
      `<option value="${kind}"${values.event === kind ? ' selected' : ''}>${esc(EVENT_LABELS[kind])}</option>`,
  ).join('');
  const input = (name: string, value: string | undefined, extra = '') =>
    `<input name="${name}" value="${esc(value ?? '')}" autocomplete="off" spellcheck="false"${extra}>`;
  return `<form method="post" action="${ADMIN_INJECT_PATH}">
<label>Flight key ${input('flight_key', values.flightKey, ' required placeholder="AAL-100-2026-09-19-KJFK"')}</label>
<label>Event <select name="event">${options}</select></label>
<label>Gate ${input('gate', values.gate, ' placeholder="B12"')}</label>
<label>Delay in minutes ${input('minutes', values.minutes, ' inputmode="numeric" placeholder="45"')}</label>
<label>Diversion airport (ICAO) ${input('airport', values.airport, ' placeholder="KSFO"')}</label>
<button type="submit">Inject</button>
</form>`;
}

/** The same event under the same injection id: the tracker's dedupe must write nothing. */
function replayForm(form: InjectForm, injectionId: string): string {
  const hidden = (name: string, value: string) =>
    `<input type="hidden" name="${name}" value="${esc(value)}">`;
  return `<form method="post" action="${ADMIN_INJECT_PATH}">
${hidden('flight_key', form.flightKey)}${hidden('event', form.event)}${hidden('gate', form.gate)}${hidden('minutes', form.minutes)}${hidden('airport', form.airport)}${hidden('injection_id', injectionId)}
<button type="submit">Replay this injection (same id; writes nothing)</button>
</form>`;
}

async function injectPage(
  style: string,
  body: string,
  options: { status?: number } = {},
): Promise<Response> {
  return renderPage({
    title: 'PlaneAhead admin: inject a flight event',
    style,
    body: `<h1>Inject a flight event</h1>
<p class="meta">A synthetic change classified by the tracker's real notification policy and sent
through the real outbox, persist, notify and push queues as a test (ruling N11). The tracker keeps
its real snapshot. Pushes go to live-tracked subscriptions only. <a href="/admin">Back to the
operations page</a>.</p>
${body}`,
    cacheControl: 'no-store',
    status: options.status,
    // Every page here carries a form posting to this origin: the browser must send the real
    // Origin on it (rr-ops-1).
    formAction: "'self'",
    referrerPolicy: 'same-origin',
  });
}

export async function injectFormPage(c: Context<AppBindings>, style: string): Promise<Response> {
  const note =
    environmentName(c.env) === 'production'
      ? '<p class="meta">Production: only a flight one of whose subscribers is in PUSH_INJECT_ALLOWED_USER_IDS, and the pushes go to those users alone.</p>'
      : '<p class="meta">Here any tracked flight may be injected; the pushes go to every live-tracked subscriber who has the event turned on.</p>';
  return injectPage(style, `${note}${injectForm()}`);
}

/** `flight_instances.id` of the key, for the audit row; null when Postgres has no such flight. */
async function flightInstanceId(db: Db, flightKey: FlightKey): Promise<string | null> {
  const [row] = await db
    .select({ id: flightInstances.id })
    .from(flightInstances)
    .where(eq(flightInstances.flightKey, flightKey))
    .limit(1);
  return row?.id ?? null;
}

/** Whether a live subscription of an allow-listed user follows the flight (production). */
async function followedByAllowListed(
  db: Db,
  flightKey: FlightKey,
  allowed: ReadonlySet<string>,
): Promise<boolean> {
  if (allowed.size === 0) {
    return false;
  }
  const rows = await db
    .select({ userId: flightSubscriptions.userId })
    .from(flightSubscriptions)
    .innerJoin(flightInstances, eq(flightInstances.id, flightSubscriptions.flightInstanceId))
    .where(
      and(
        eq(flightInstances.flightKey, flightKey),
        isNull(flightSubscriptions.deletedAt),
        inArray(flightSubscriptions.userId, [...allowed]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

function resultHtml(
  flightKey: FlightKey,
  event: InjectedEvent,
  injectionId: string,
  response: InjectPolicyEventResponseV1,
): string {
  const what = `<p>${esc(EVENT_LABELS[event.kind].replace(/ \(.*\)$/, ''))} injected into <code>${esc(flightKey)}</code> as injection <code>${esc(injectionId)}</code>.</p>`;
  if (response.outcome === 'ignored') {
    return `${what}<p class="unavailable">The tracker ignored it (${esc(response.reason ?? 'unknown')}): it holds no running flight.</p>`;
  }
  if (response.intents.length === 0) {
    return `${what}<p class="meta">The policy produced no intents: the event is not a change it pushes here (outside its window, under its thresholds, or no change from the stored snapshot).</p>`;
  }
  const written = response.intents.filter((intent) => intent.written).length;
  const summary =
    written === response.intents.length
      ? `<p class="done">${String(written)} intent(s) written to the tracker's outbox; persist forwards them to notify.</p>`
      : `<p class="meta">${String(response.intents.length - written)} intent(s) not written: their dedupe key exists already (a replay), so nothing more is sent.</p>`;
  return `${what}${summary}${table(
    ['Kind', 'Subject', 'Value', 'Dedupe key', 'Written'],
    response.intents.map((intent) => [
      intent.kind,
      intent.subject,
      intent.value,
      intent.dedupeKey,
      intent.written ? 'yes' : 'no (replay)',
    ]),
  )}`;
}

export async function injectSend(
  c: Context<AppBindings>,
  options: AdminInjectOptions,
  style: string,
  expectedOrigin: string | null,
): Promise<Response> {
  const log = createLogger({ request_id: c.var.requestId, admin: true });
  const origin = c.req.header('origin') ?? null;
  if (expectedOrigin === null || origin !== expectedOrigin) {
    log.warn('admin_inject_refused', { reason: 'cross_origin' });
    return new Response(null, { status: 403, headers: { 'cache-control': 'no-store' } });
  }
  const form = readForm(await c.req.parseBody());
  const again = (message: string, status: number, extra = '') =>
    injectPage(style, `<p class="unavailable">${esc(message)}</p>${extra}${injectForm(form)}`, {
      status,
    });
  const parsed = parseInjection(form);
  if (!parsed.ok) {
    return again(parsed.message, 400);
  }
  const { flightKey, event } = parsed;
  const env = c.env;
  const db = (options.db ?? openDb)(env);
  if (
    environmentName(env) === 'production' &&
    !(await followedByAllowListed(db, flightKey, allowedTestPushUserIds(env)))
  ) {
    log.warn('admin_inject_refused', { reason: 'not_allow_listed', flight_key: flightKey });
    return again(
      'In production an injection needs a flight followed by a user id in PUSH_INJECT_ALLOWED_USER_IDS.',
      403,
    );
  }
  const tracker = (options.injectorFor ?? defaultInjectorFor)(env)(flightKey);
  const deadline = {
    waitUntil: (promise: Promise<unknown>) => {
      c.executionCtx.waitUntil(promise);
    },
  };
  let state;
  try {
    state = await callWithDeadline(
      'getState',
      tracker.getState().then((answer) => GetStateResponseV1.parse(answer)),
      DO_CALL_DEADLINE_MS,
      deadline,
    );
  } catch (error) {
    if (isAbsentTrackerError(error)) {
      return again('No tracker holds that flight: it was never tracked, or it finished.', 404);
    }
    if (error instanceof DeadlineExceededError) {
      return again('The tracker did not answer in time. Try again.', 504);
    }
    throw error;
  }
  if (state.snapshot === null || state.phase === 'finished') {
    return again('The tracker holds no running flight to inject into.', 409);
  }

  const now = (options.now ?? Date.now)();
  const applied = applyInjectedEvent(state.snapshot, event, now);
  if (!applied.ok) {
    return again(applied.message, 400);
  }
  const status = FlightStatusSchema.safeParse(applied.status);
  if (!status.success) {
    const issue = status.error.issues[0];
    return again(
      `The synthetic snapshot would not validate: ${issue?.path.map(String).join('.') ?? ''} ${issue?.message ?? 'invalid'}.`,
      400,
    );
  }
  const injectionId = parsed.injectionId ?? uuidv7(() => now);
  let response: InjectPolicyEventResponseV1;
  try {
    response = InjectPolicyEventResponseV1.parse(
      await callWithDeadline(
        'injectPolicyEvent',
        tracker.injectPolicyEvent({
          rpcVersion: RPC_SCHEMA_VERSION,
          injectionId,
          status: status.data,
        }),
        DO_CALL_DEADLINE_MS,
        deadline,
      ),
    );
  } catch (error) {
    if (error instanceof DeadlineExceededError) {
      // The call still completes: a replay of the same id shows what it wrote, and writes nothing.
      return again(
        `The tracker did not answer in time; injection ${injectionId} may still be written.`,
        504,
        replayForm(form, injectionId),
      );
    }
    throw error;
  }
  const written = response.intents.filter((intent) => intent.written).length;
  const identity = c.var.accessIdentity;
  await db.insert(auditLog).values({
    actorType: 'admin',
    action: 'notify.injected',
    targetType: 'flight_instance',
    targetId: await flightInstanceId(db, flightKey),
    requestId: c.var.requestId,
    details: {
      flight_key: flightKey,
      injection_id: injectionId,
      replay: parsed.injectionId !== null,
      event,
      outcome: response.outcome,
      intents: response.intents.length,
      written,
      operator_email: identity?.email ?? null,
      operator_subject: identity?.subject ?? 'unknown',
    },
  });
  log.info('admin_inject_done', {
    flight_key: flightKey,
    injection_id: injectionId,
    event: event.kind,
    outcome: response.outcome,
    intents: response.intents.length,
    written,
    access_subject: identity?.subject,
  });
  return injectPage(
    style,
    `${resultHtml(flightKey, event, injectionId, response)}${replayForm(form, injectionId)}
<h2>Inject another event</h2>${injectForm(form)}`,
  );
}
