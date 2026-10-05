/**
 * The transport soak on the admin page (increment 16, ruling C9), behind the same Cloudflare
 * Access middleware as every `/admin` path (src/routes/admin.ts mounts it), linked from the push
 * section of `/admin`. The soak itself, its schedule and its steps are src/push/soak.ts.
 *
 *   - `GET /admin/push/soak`: the soak's state (running, stopped, ended, or none yet) and its
 *     counts. The delivery attempts made while it ran, by channel, outcome, HTTP status and
 *     reason, from each delivery's attempt log (src/queues/push-outcomes.ts), with the ones the
 *     plan names drawn out: every 403 and 429 reason, edge 52x answers without an `apns-id`, and
 *     the sends. Its injections by outcome (the injector's `notify.injected` rows: a 409 for a
 *     suspicion is `ignored`, `suspected`), and its canaries. Then a form to start a soak, or to
 *     stop the running one.
 *   - `POST /admin/push/soak`: same origin only, like every admin write. `action=start` takes the
 *     test flight's key, the hours (1 to 72) and the canary's device token and kind, a registered
 *     live token as "Send a test push" takes it (the record keeps its row id); the flight needs a
 *     running tracker whose snapshot has a scheduled out, which every injected delay is measured
 *     from. Refused while a soak runs (409). `action=stop` stops the running one, named by its
 *     id. Production refuses both (403): a soak runs on staging only. Each write puts an
 *     `audit_log` row naming the operator in before the KV record changes, `pending`, and settles
 *     it after (`written` or `error`), like the injector's (Q6).
 */

import { eq, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { auditLog, openDb, type Db } from '@planeahead/db';
import {
  DO_CALL_DEADLINE_MS,
  GetStateResponseV1,
  PUSH_TARGET_KINDS,
  isFlightKey,
  uuidv7,
  type FlightKey,
} from '@planeahead/shared';
import { environmentName, type AppBindings, type Env } from '../env';
import { DeadlineExceededError, callWithDeadline } from '../lib/deadline';
import { esc, renderPage, table } from '../lib/html';
import { isAbsentTrackerError } from '../lib/trackers';
import { createLogger, errorFields } from '../observability/log';
import {
  PUSH_SOAK_CANARY_EVERY_TICKS,
  PUSH_SOAK_DELAY_MINUTES,
  PUSH_SOAK_MAX_HOURS,
  PUSH_SOAK_MIN_HOURS,
  PUSH_SOAK_TICK_MS,
  pushSoakPosition,
  readPushSoak,
  writePushSoak,
  type PushSoakOperator,
  type PushSoakPosition,
  type PushSoakRecord,
} from '../push/soak';
import { applyInjectedEvent, defaultInjectorFor, type AdminInjectOptions } from './admin-inject';
import { ADMIN_PUSH_RESULT_PATH, readTestPushToken } from './admin-push';

export const ADMIN_SOAK_PATH = '/admin/push/soak';

export interface AdminSoakOptions extends Pick<AdminInjectOptions, 'injectorFor'> {
  readonly db?: ((env: Env) => Db) | undefined;
  /** Where the soak record lives; the default is `CONFIG`. */
  readonly soakKv?: ((env: Env) => Pick<KVNamespace, 'get' | 'put'>) | undefined;
  readonly now?: (() => number) | undefined;
}

const PRODUCTION_NOTE =
  'Production: the transport soak runs on staging only, and this environment refuses to start one.';

async function soakPage(
  style: string,
  body: string,
  options: { status?: number } = {},
): Promise<Response> {
  return renderPage({
    title: 'PlaneAhead admin: transport soak',
    style,
    body: `<h1>Transport soak</h1>
<p class="meta">Staging only (ruling C9). For the hours chosen, every five minutes a synthetic
departure delay is injected into the test flight through the injector, and once an hour a canary
sends two test pushes whose provider tokens are asked of PushAuth at the same instant. The counts
below are every provider answer while the soak ran. <a href="/admin">Back to the operations
page</a>.</p>
${body}`,
    cacheControl: 'no-store',
    status: options.status,
    // Both forms post to this origin: the browser must send the real Origin (rr-ops-1).
    formAction: "'self'",
    referrerPolicy: 'same-origin',
  });
}

/** The start form's fields as typed (re-shown on a refusal). */
interface StartForm {
  readonly flightKey: string;
  readonly hours: string;
  readonly token: string;
  readonly kind: string;
}

function startForm(values: Partial<StartForm> = {}): string {
  const kinds = PUSH_TARGET_KINDS.map(
    (kind) =>
      `<option value="${kind}"${values.kind === kind ? ' selected' : ''}>${kind === 'apns' ? 'APNs (iOS)' : 'FCM (Android)'}</option>`,
  ).join('');
  const input = (name: string, value: string | undefined, extra = '') =>
    `<input name="${name}" value="${esc(value ?? '')}" autocomplete="off" spellcheck="false"${extra}>`;
  return `<h2>Start a soak</h2>
<p class="meta">The test flight is one the owner's test devices follow with live tracking on, and
whose tracker runs past the soak's end (a flight departing after it). The canary token is a
registered device token, as on the test push page; APNs is the transport under test.</p>
<form method="post" action="${ADMIN_SOAK_PATH}">
<input type="hidden" name="action" value="start">
<label>Test flight key ${input('flight_key', values.flightKey, ' required placeholder="AAL-100-2026-10-20-KJFK"')}</label>
<label>Hours (${String(PUSH_SOAK_MIN_HOURS)} to ${String(PUSH_SOAK_MAX_HOURS)}; the plan's soak is 24 to 48) ${input('hours', values.hours ?? '24', ' inputmode="numeric" required')}</label>
<label>Canary device token ${input('token', values.token, ' required')}</label>
<label>Kind <select name="kind">${kinds}</select></label>
<button type="submit">Start the soak</button>
</form>`;
}

function stopForm(record: PushSoakRecord): string {
  return `<form method="post" action="${ADMIN_SOAK_PATH}">
<input type="hidden" name="action" value="stop">
<input type="hidden" name="soak_id" value="${esc(record.id)}">
<button type="submit">Stop the soak</button>
</form>`;
}

function operator(who: PushSoakOperator | null): string {
  return who === null ? '' : (who.email ?? who.subject);
}

/** The ticks a soak has had by `at` (one injection each), and the canaries among them. */
export function ticksDue(record: PushSoakRecord, at: number): { ticks: number; canaries: number } {
  const start = Date.parse(record.startedAt);
  const end = Math.min(at, Date.parse(record.stoppedAt ?? record.endsAt));
  const first = Math.ceil(start / PUSH_SOAK_TICK_MS) * PUSH_SOAK_TICK_MS;
  const ticks = end <= first ? 0 : Math.floor((end - 1 - first) / PUSH_SOAK_TICK_MS) + 1;
  return { ticks, canaries: Math.ceil(ticks / PUSH_SOAK_CANARY_EVERY_TICKS) };
}

function stateHtml(record: PushSoakRecord | null, position: PushSoakPosition, now: number): string {
  if (record === null) {
    return '<p>No soak has run here yet.</p>';
  }
  const due = ticksDue(record, now);
  return table(
    ['Soak', 'State', 'Test flight', 'Hours', 'Started', 'Ends', 'Stopped', 'Canary token'],
    [
      [
        record.id,
        position.state,
        record.flightKey,
        record.hours,
        `${record.startedAt} by ${operator(record.startedBy)}`,
        record.endsAt,
        record.stoppedAt === null ? '' : `${record.stoppedAt} by ${operator(record.stoppedBy)}`,
        `${record.canary.kind} (push_tokens ${record.canary.pushTokenId})`,
      ],
    ],
  ).concat(
    `<p class="meta">Ticks so far: ${String(due.ticks)} (an injection each: departure delays of ${PUSH_SOAK_DELAY_MINUTES.join(', ')} minutes in turn); canaries due: ${String(due.canaries)} (two sends each).</p>`,
  );
}

/** One group of attempt log entries: what one provider answer (or unsent verdict) came to. */
export interface SoakAttemptRow extends Record<string, unknown> {
  readonly channel: string;
  readonly is_test: boolean;
  readonly outcome: string;
  readonly reason: string;
  /** The HTTP status as text; empty for an attempt that made no request. */
  readonly http_status: string;
  readonly n: number;
}

/** An APNs answer without an `apns-id` is `edge_{status}` (src/push/transport.ts); 52x is the edge. */
const EDGE_52X = /^edge_52\d$/;

/** The window the counts cover: the start until now, the stop or the end, whichever is first. */
export function soakWindow(record: PushSoakRecord, now: number): { from: string; until: string } {
  const end = Math.min(now, Date.parse(record.stoppedAt ?? record.endsAt));
  return { from: record.startedAt, until: new Date(end).toISOString() };
}

/** Every attempt log entry made inside the window, grouped (src/queues/push-outcomes.ts). */
export async function soakAttempts(db: Db, from: string, until: string): Promise<SoakAttemptRow[]> {
  // A delivery row is created at its first outcome; one created a day before the window can still
  // log a retry inside it, and the BRIN index wants a lower bound.
  return db.execute<SoakAttemptRow>(sql`
    select d.channel, d.is_test, split_part(e.key, ':', 2) as outcome,
           coalesce(e.value->>'r', '') as reason, coalesce(e.value->>'s', '') as http_status,
           count(*)::int as n
    from notification_deliveries d cross join lateral jsonb_each(d.attempt_log) e
    where d.created_at >= ${from}::timestamptz - interval '1 day'
      and (e.value->>'at')::timestamptz >= ${from}::timestamptz
      and (e.value->>'at')::timestamptz < ${until}::timestamptz
    group by 1, 2, 3, 4, 5
    order by n desc, 1, 3, 4, 5
  `);
}

/** Sums `n` over the rows by `key`, largest first. */
function totals(
  rows: readonly SoakAttemptRow[],
  key: (row: SoakAttemptRow) => readonly string[],
): (string | number)[][] {
  const sums = new Map<string, { cells: readonly string[]; n: number }>();
  for (const row of rows) {
    const cells = key(row);
    const id = JSON.stringify(cells);
    sums.set(id, { cells, n: (sums.get(id)?.n ?? 0) + row.n });
  }
  return [...sums.values()].sort((a, b) => b.n - a.n).map(({ cells, n }) => [...cells, n]);
}

/** The attempts, the answers the plan names drawn out first. */
export function attemptsHtml(rows: readonly SoakAttemptRow[]): string {
  const sent = totals(
    rows.filter((row) => row.outcome === 'sent'),
    (row) => [row.channel],
  );
  const refusals = totals(
    rows.filter((row) => row.http_status === '403' || row.http_status === '429'),
    (row) => [row.http_status, row.channel, row.reason],
  );
  const edge = totals(
    rows.filter((row) => EDGE_52X.test(row.reason)),
    (row) => [row.channel, row.reason],
  );
  return `<h3>Sent</h3>${table(['Channel', 'Attempts sent'], sent)}
<h3>403 and 429 answers, by reason</h3>
<p class="meta">UnrelatedKeyIdInToken and TooManyProviderTokenUpdates are the pooling errors R1 U2 asks about (an APNs 403 or 429 without an apns-id is edge_403 or edge_429). A clean soak has no rows here.</p>
${table(['HTTP status', 'Channel', 'Reason', 'Attempts'], refusals)}
<h3>Edge 52x answers without an apns-id</h3>${table(['Channel', 'Reason', 'Attempts'], edge)}
<h3>Every attempt</h3>${table(
    ['Channel', 'Test', 'Outcome', 'HTTP status', 'Reason', 'Attempts'],
    rows.map((row) => [
      row.channel,
      row.is_test ? 'yes' : 'no',
      row.outcome,
      row.http_status,
      row.reason,
      row.n,
    ]),
  )}`;
}

interface InjectionRow extends Record<string, unknown> {
  readonly outcome: string;
  readonly reason: string;
  readonly n: number;
}

interface CanaryRow extends Record<string, unknown> {
  readonly outcome: string;
  readonly refusal: string;
  readonly sends: readonly { outcome?: string; reason?: string | null }[] | null;
  readonly job_ids: readonly string[] | null;
}

/** The soak's injections by outcome: its `notify.injected` rows (a 409 is `ignored`). */
async function injectionsHtml(db: Db, record: PushSoakRecord): Promise<string> {
  const rows = await db.execute<InjectionRow>(sql`
    select coalesce(details->>'outcome', '') as outcome,
           coalesce(details->>'refusal', details->>'reason', '') as reason, count(*)::int as n
    from audit_log
    where action = 'notify.injected' and created_at >= ${record.startedAt}::timestamptz
      and details->>'soak_id' = ${record.id}
    group by 1, 2
    order by n desc, 1, 2
  `);
  return `<p class="meta">One audit row per run of a tick's injection, so the rows can outnumber the ticks: a step the queue delivers again names its slot's injection again, which the tracker writes once, and adds a written row with nothing written. ignored with suspected or cancelled is the tracker's 409 (a suspicion open, or a cancelled snapshot); refused is no tracker call at all; written with no intents is the policy's verdict.</p>${table(
    ['Outcome', 'Reason or refusal', 'Rows'],
    rows.map((row) => [row.outcome, row.reason, row.n]),
  )}`;
}

/** The soak's canaries: each round's outcome, each send's first answer, the last round's jobs. */
async function canariesHtml(db: Db, record: PushSoakRecord): Promise<string> {
  const rows = await db.execute<CanaryRow>(sql`
    select coalesce(details->>'outcome', '') as outcome,
           coalesce(details->>'refusal', '') as refusal,
           details->'sends' as sends, details->'job_ids' as job_ids
    from audit_log
    where action = 'push.soak_canary' and created_at >= ${record.startedAt}::timestamptz
      and details->>'soak_id' = ${record.id}
    order by created_at
  `);
  const count = (keys: readonly string[]) => {
    const sums = new Map<string, number>();
    for (const key of keys) {
      sums.set(key, (sums.get(key) ?? 0) + 1);
    }
    return [...sums].sort((a, b) => b[1] - a[1]);
  };
  const rounds = count(rows.map((row) => [row.outcome, row.refusal].filter(Boolean).join(' ')));
  const sends = count(
    rows.flatMap((row) =>
      (row.sends ?? []).map((send) =>
        [send.outcome ?? '', send.reason ?? ''].filter(Boolean).join(' '),
      ),
    ),
  );
  const last = rows.at(-1)?.job_ids ?? [];
  const links = last
    .map((job) => `<a href="${ADMIN_PUSH_RESULT_PATH}?job=${esc(job)}">${esc(job)}</a>`)
    .join(', ');
  return `${table(['Round outcome', 'Rounds'], rounds)}${table(['First answer of each send', 'Sends'], sends)}${
    links === '' ? '' : `<p>The last round's jobs: ${links}.</p>`
  }`;
}

/** The three counts; each fails on its own. */
async function countsHtml(db: Db, record: PushSoakRecord, now: number): Promise<string> {
  const log = createLogger({ admin: true, section: 'push_soak' });
  const part = async (name: string, load: () => Promise<string>): Promise<string> => {
    try {
      return await load();
    } catch (error) {
      log.warn('admin_section_failed', { section: `push_soak_${name}`, ...errorFields(error) });
      return '<p class="unavailable">unavailable (the read failed; see the log)</p>';
    }
  };
  const { from, until } = soakWindow(record, now);
  const [attempts, injections, canaries] = await Promise.all([
    part('attempts', async () => attemptsHtml(await soakAttempts(db, from, until))),
    part('injections', () => injectionsHtml(db, record)),
    part('canaries', () => canariesHtml(db, record)),
  ]);
  return `<h2>Provider answers while the soak ran</h2>
<p class="meta">Every delivery attempt from ${esc(from)} until ${esc(until)}, from the deliveries' attempt logs: the soak's pushes and any other sent in that window.</p>
${attempts}<h2>Injections</h2>${injections}<h2>Canaries</h2>${canaries}`;
}

export async function soakPageGet(
  c: Context<AppBindings>,
  options: AdminSoakOptions,
  style: string,
): Promise<Response> {
  const env = c.env;
  if (environmentName(env) === 'production') {
    return soakPage(style, `<p class="unavailable">${esc(PRODUCTION_NOTE)}</p>`);
  }
  const now = (options.now ?? Date.now)();
  const record = await readPushSoak((options.soakKv ?? defaultSoakKv)(env));
  const position = pushSoakPosition(record, now);
  const counts = record === null ? '' : await countsHtml((options.db ?? openDb)(env), record, now);
  const form = record !== null && position.state === 'running' ? stopForm(record) : startForm();
  return soakPage(style, `${stateHtml(record, position, now)}${form}${counts}`);
}

function defaultSoakKv(env: Env): Pick<KVNamespace, 'get' | 'put'> {
  return env.CONFIG;
}

/** Whether the test flight's tracker runs a flight a departure delay can be injected into. */
async function testFlightRefusal(
  c: Context<AppBindings>,
  options: AdminSoakOptions,
  flightKey: FlightKey,
  now: number,
): Promise<{ readonly status: number; readonly message: string } | null> {
  const tracker = (options.injectorFor ?? defaultInjectorFor)(c.env)(flightKey);
  let state;
  try {
    state = await callWithDeadline(
      'getState',
      tracker.getState().then((answer) => GetStateResponseV1.parse(answer)),
      DO_CALL_DEADLINE_MS,
      {
        waitUntil: (promise) => {
          c.executionCtx.waitUntil(promise);
        },
      },
    );
  } catch (error) {
    if (isAbsentTrackerError(error)) {
      return {
        status: 404,
        message: 'No tracker holds that flight: it was never tracked, or it finished.',
      };
    }
    if (error instanceof DeadlineExceededError) {
      return { status: 504, message: 'The tracker did not answer in time. Try again.' };
    }
    throw error;
  }
  if (state.snapshot === null || state.phase === 'finished') {
    return { status: 409, message: 'The tracker holds no running flight to inject into.' };
  }
  const minutes = PUSH_SOAK_DELAY_MINUTES[0];
  const applied = applyInjectedEvent(state.snapshot, { kind: 'departure_delay', minutes }, now);
  return applied.ok ? null : { status: 400, message: applied.message };
}

/**
 * A write to the soak record, audited like the injector's (Q6): the `audit_log` row `pending`
 * first, then the write, then the row settled `written` or `error`. Answers whether it was written.
 */
async function auditedWrite(
  db: Db,
  log: ReturnType<typeof createLogger>,
  row: {
    readonly action: 'push.soak_started' | 'push.soak_stopped';
    readonly soakId: string;
    readonly subjectId: string | null;
    readonly requestId: string;
    readonly details: Readonly<Record<string, unknown>>;
  },
  write: () => Promise<void>,
): Promise<boolean> {
  const auditId = uuidv7();
  await db.insert(auditLog).values({
    id: auditId,
    subjectId: row.subjectId,
    actorType: 'admin',
    action: row.action,
    targetType: 'push_soak',
    targetId: row.soakId,
    requestId: row.requestId,
    details: { ...row.details, outcome: 'pending' },
  });
  let settled: Record<string, unknown> = { outcome: 'written' };
  try {
    await write();
  } catch (error) {
    settled = { outcome: 'error', error_name: error instanceof Error ? error.name : 'unknown' };
    log.error('admin_push_soak_write_failed', { action: row.action, ...errorFields(error) });
  }
  try {
    await db
      .update(auditLog)
      .set({ details: { ...row.details, ...settled } })
      .where(eq(auditLog.id, auditId));
  } catch (error) {
    log.error('admin_push_soak_audit_unsettled', { action: row.action, ...errorFields(error) });
  }
  return settled['outcome'] === 'written';
}

const iso = (ms: number): string => new Date(ms).toISOString();

export async function soakAction(
  c: Context<AppBindings>,
  options: AdminSoakOptions,
  style: string,
  expectedOrigin: string | null,
): Promise<Response> {
  const log = createLogger({ request_id: c.var.requestId, admin: true });
  const origin = c.req.header('origin') ?? null;
  if (expectedOrigin === null || origin !== expectedOrigin) {
    log.warn('admin_push_soak_refused', { reason: 'cross_origin' });
    return new Response(null, { status: 403, headers: { 'cache-control': 'no-store' } });
  }
  const env = c.env;
  if (environmentName(env) === 'production') {
    log.warn('admin_push_soak_refused', { reason: 'production' });
    return soakPage(style, `<p class="unavailable">${esc(PRODUCTION_NOTE)}</p>`, { status: 403 });
  }
  const body = await c.req.parseBody();
  const field = (name: string): string => {
    const value = body[name];
    return typeof value === 'string' ? value.trim() : '';
  };
  const identity = c.var.accessIdentity;
  const who: PushSoakOperator = {
    email: identity?.email ?? null,
    subject: identity?.subject ?? 'unknown',
  };
  const db = (options.db ?? openDb)(env);
  const kv = (options.soakKv ?? defaultSoakKv)(env);
  const now = (options.now ?? Date.now)();
  const current = await readPushSoak(kv);
  const running = pushSoakPosition(current, now).state === 'running' ? current : null;
  const done = () =>
    new Response(null, {
      status: 303,
      headers: { location: ADMIN_SOAK_PATH, 'cache-control': 'no-store' },
    });
  const operatorDetails = { operator_email: who.email, operator_subject: who.subject };

  if (field('action') === 'stop') {
    if (running === null || running.id !== field('soak_id')) {
      return soakPage(
        style,
        `<p class="unavailable">That soak is not running (it ended, was stopped, or another started). Nothing changed.</p>${running === null ? startForm() : stopForm(running)}`,
        { status: 409 },
      );
    }
    const stopped: PushSoakRecord = { ...running, stoppedAt: iso(now), stoppedBy: who };
    const written = await auditedWrite(
      db,
      log,
      {
        action: 'push.soak_stopped',
        soakId: running.id,
        subjectId: null,
        requestId: c.var.requestId,
        details: {
          soak_id: running.id,
          flight_key: running.flightKey,
          stopped_at: stopped.stoppedAt,
          ...operatorDetails,
        },
      },
      () => writePushSoak(kv, stopped),
    );
    if (!written) {
      return soakPage(
        style,
        `<p class="unavailable">The soak record could not be written, so the soak was not stopped. Try again.</p>${stopForm(running)}`,
        { status: 503 },
      );
    }
    log.info('admin_push_soak_stopped', { soak_id: running.id, access_subject: identity?.subject });
    return done();
  }

  if (field('action') !== 'start') {
    return soakPage(style, `<p class="unavailable">Choose start or stop.</p>${startForm()}`, {
      status: 400,
    });
  }
  const form: StartForm = {
    flightKey: field('flight_key'),
    hours: field('hours'),
    token: field('token'),
    kind: field('kind'),
  };
  const again = (message: string, status: number) =>
    soakPage(style, `<p class="unavailable">${esc(message)}</p>${startForm(form)}`, { status });
  if (running !== null) {
    return soakPage(
      style,
      `<p class="unavailable">Soak ${esc(running.id)} runs until ${esc(running.endsAt)}; stop it first.</p>${stopForm(running)}`,
      { status: 409 },
    );
  }
  if (!isFlightKey(form.flightKey)) {
    return again('That is not a flight key (like AAL-100-2026-10-20-KJFK).', 400);
  }
  const hours = /^\d{1,2}$/.test(form.hours) ? Number(form.hours) : NaN;
  if (!(hours >= PUSH_SOAK_MIN_HOURS && hours <= PUSH_SOAK_MAX_HOURS)) {
    return again(
      `A soak runs ${String(PUSH_SOAK_MIN_HOURS)} to ${String(PUSH_SOAK_MAX_HOURS)} whole hours.`,
      400,
    );
  }
  const kind = PUSH_TARGET_KINDS.find((candidate) => candidate === form.kind);
  if (kind === undefined) {
    return again('Choose APNs or FCM.', 400);
  }
  if (form.token.length < 8 || form.token.length > 4096) {
    return again('That is not a device token.', 400);
  }
  const row = await readTestPushToken(db, { kind, token: form.token });
  if (row === undefined) {
    return again(
      'No registered token of that kind. Register the device first (the app registers its token with POST /v1/devices).',
      404,
    );
  }
  if (row.invalidated_at !== null) {
    return again(
      `That token was invalidated at ${row.invalidated_at}. Register it again from the app, then start the soak.`,
      409,
    );
  }
  const refusal = await testFlightRefusal(c, options, form.flightKey, now);
  if (refusal !== null) {
    return again(refusal.message, refusal.status);
  }
  const record: PushSoakRecord = {
    v: 1,
    id: uuidv7(() => now),
    flightKey: form.flightKey,
    hours,
    startedAt: iso(now),
    endsAt: iso(now + hours * 3_600_000),
    stoppedAt: null,
    startedBy: who,
    stoppedBy: null,
    canary: { pushTokenId: row.id, kind },
  };
  const written = await auditedWrite(
    db,
    log,
    {
      action: 'push.soak_started',
      soakId: record.id,
      // The user whose device the canaries go to, as a test push's row names it.
      subjectId: row.user_id,
      requestId: c.var.requestId,
      details: {
        soak_id: record.id,
        flight_key: record.flightKey,
        hours,
        started_at: record.startedAt,
        ends_at: record.endsAt,
        canary_push_token_id: row.id,
        canary_kind: kind,
        ...operatorDetails,
      },
    },
    () => writePushSoak(kv, record),
  );
  if (!written) {
    return again('The soak record could not be written, so no soak started. Try again.', 503);
  }
  log.info('admin_push_soak_started', {
    soak_id: record.id,
    flight_key: record.flightKey,
    hours,
    access_subject: identity?.subject,
  });
  return done();
}
