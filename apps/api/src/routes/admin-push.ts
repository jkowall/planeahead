/**
 * The push transport on the admin page (increment 14, rulings P8 and P9), behind the same
 * Cloudflare Access middleware as every `/admin` path (src/routes/admin.ts mounts these).
 *
 * The section on `/admin` (ruling P9): the transport's configuration in this environment (which
 * platforms have their credentials, which secret is missing or malformed, never a value), the
 * three `PushAuth` objects' last mint and last failure (never a token), and two counts for the
 * last 24 hours, both from `notification_deliveries`: every attempt's outcome by reason (the
 * `attempt_log` the persist consumer merges from the push outcome messages, what increment 16's
 * soak reads: 403 and 429 reasons, `edge_52x` answers without an `apns-id`), and the deliveries
 * by their current status.
 *
 * "Send a test push" (ruling P8), the plan's staging smoke as an admin action rather than a
 * GitHub workflow (which would need Access service tokens and Actions minutes):
 *
 *   - `GET /admin/push/test`: a form taking a token, its kind and optionally the app id to send
 *     with (the registered one when blank: every client before increment 16 registered without
 *     one, so a development build's row says the production app until then).
 *   - `POST /admin/push/test`: same origin only, like the account deletion. The token must be a
 *     registered, live `push_tokens` row of that kind, which names the user, the APNs environment
 *     and the registration time the job carries; an invalidated row is refused with a note to
 *     register the token again from the app (review ruling R1: the consumer would only drop it as
 *     `token_inactive`, and a token is then only ever dropped for dying after its job was queued).
 *     In production only a row of a user id in `PUSH_INJECT_ALLOWED_USER_IDS` is accepted. One
 *     test job (`test: true`, kind `system`, a ten-minute relevance window, its UUIDv7 job id
 *     minted at the same instant) goes onto the real `push` queue, so the real consumer, the real
 *     `PushAuth` and the real transport send it; an `audit_log` row names the operator. The
 *     answer is a redirect to the result page.
 *   - `GET /admin/push/test/result?job=...`: the job's delivery row, which the persist consumer
 *     writes from the outcome message (keyed by the job id, marked `is_test`): the status, the
 *     `apns-id` or FCM message name, Apple's `apns-unique-id` for a sandbox send (the key to the
 *     notification in the Push Notifications Console's delivery log, ruling R11), the reason, and
 *     every attempt. It reloads itself every three seconds while the job is in flight, but not
 *     for ever (ruling R7 and the re-review): once the job id's embedded time plus
 *     `TEST_PUSH_TTL_MS` has passed with no delivery row, or with a row still `queued`, the page
 *     stops reloading and says the outcome was not recorded, pointing at
 *     `push_outcome_send_failed` in the logs.
 *
 * A test push invalidates a dead token like any send, but only when it was sent with the row's
 * own app id and environment (src/queues/push-outcomes.ts): a hand-typed app id that earns
 * `DeviceTokenNotForTopic` says nothing about the registered row.
 */

import { sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { auditLog, openDb, type Db } from '@planeahead/db';
import {
  AppIdSchema,
  PUSH_CREDENTIAL_NAMES,
  PUSH_TARGET_KINDS,
  PushJobV1,
  RPC_SCHEMA_VERSION,
  isUuidv7,
  uuidv7,
  uuidv7Timestamp,
  type PushCredentialName,
  type PushJobV1Input,
  type PushTargetKind,
} from '@planeahead/shared';
import { environmentName, type AppBindings, type Env } from '../env';
import { esc, renderPage, table } from '../lib/html';
import { createLogger } from '../observability/log';
import { pushConfiguration } from '../push/config';
import type { PushCredentialStatus } from '../push/credentials';
import { APNS_HOSTS } from '../push/payload';

export const ADMIN_PUSH_TEST_PATH = '/admin/push/test';
export const ADMIN_PUSH_RESULT_PATH = '/admin/push/test/result';
/** A test push is worth sending for ten minutes; then the consumer drops it (`expired`). */
export const TEST_PUSH_TTL_MS = 10 * 60_000;
/**
 * The Android channel a test push names. Increment 16 creates the app's channels; until one with
 * this id exists, Android shows the push on the manifest's default channel (R1 F33).
 */
export const TEST_PUSH_CHANNEL_ID = 'test_push';
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The `status` RPC of a `PushAuth` object, narrowed so a test can hand in a fake. */
export interface PushAuthStatusStub {
  status(input: unknown): Promise<PushCredentialStatus>;
}

export interface AdminPushOptions {
  readonly db?: ((env: Env) => Db) | undefined;
  /** Where the test job goes; the default is `PUSH_QUEUE`. */
  readonly pushQueue?: ((env: Env) => Pick<Queue, 'send'>) | undefined;
  /** The `PushAuth` object of a credential; the default is `PUSH_AUTH.getByName` at `enam`. */
  readonly pushAuth?: ((env: Env) => (name: PushCredentialName) => PushAuthStatusStub) | undefined;
  readonly now?: (() => number) | undefined;
}

/** The user ids a production test push may target (`PUSH_INJECT_ALLOWED_USER_IDS`). */
export function allowedTestPushUserIds(env: Env): ReadonlySet<string> {
  return new Set(
    (env.PUSH_INJECT_ALLOWED_USER_IDS ?? '')
      .split(',')
      .map((id) => id.trim().toLowerCase())
      .filter((id) => UUID_SHAPE.test(id)),
  );
}

function iso(ms: number | null): string {
  return ms === null ? '' : new Date(ms).toISOString();
}

function defaultPushAuth(env: Env): (name: PushCredentialName) => PushAuthStatusStub {
  return (name) => env.PUSH_AUTH.getByName(name, { locationHint: 'enam' });
}

function configurationHtml(env: Env): string {
  const configuration = pushConfiguration(env);
  const allowed = allowedTestPushUserIds(env).size;
  const rows = [
    [
      'APNs',
      configuration.apns.configured ? 'yes' : 'no',
      configuration.apns.problems.join('; '),
      `sandbox tokens to ${APNS_HOSTS.sandbox}, production tokens to ${APNS_HOSTS.production}`,
    ],
    [
      'FCM HTTP v1',
      configuration.fcm.configured ? 'yes' : 'no',
      configuration.fcm.problems.join('; '),
      configuration.fcm.projectId === null ? '' : `project ${configuration.fcm.projectId}`,
    ],
  ];
  const unconfigured =
    configuration.apns.configured && configuration.fcm.configured
      ? ''
      : '<p class="unavailable">A platform without credentials is not configured: its push jobs are held (not_configured) and retried every five minutes until they expire.</p>';
  const inject =
    environmentName(env) === 'production'
      ? `<p class="meta">Test pushes in production: tokens of ${String(allowed)} allow-listed user id(s) (PUSH_INJECT_ALLOWED_USER_IDS).</p>`
      : '';
  return `${table(['Platform', 'Configured', 'Missing or malformed', 'Detail'], rows)}${unconfigured}${inject}`;
}

async function credentialsHtml(env: Env, options: AdminPushOptions): Promise<string> {
  const stubFor = (options.pushAuth ?? defaultPushAuth)(env);
  const statuses = await Promise.all(
    PUSH_CREDENTIAL_NAMES.map((name) =>
      stubFor(name).status({ rpcVersion: RPC_SCHEMA_VERSION, name }),
    ),
  );
  return table(
    ['Credential', 'Last mint', 'Served until', 'Mints', 'Last failure'],
    statuses.map((status) => [
      status.name,
      status.mintedAtMs === null ? '(never)' : iso(status.mintedAtMs),
      iso(status.notAfterMs),
      status.mintCount,
      status.lastFailure === null
        ? ''
        : `${status.lastFailure.failure} at ${iso(status.lastFailure.atMs)}`,
    ]),
  );
}

async function outcomesHtml(db: Db): Promise<string> {
  const attempts = await db.execute<{
    channel: string;
    is_test: boolean;
    outcome: string;
    reason: string;
    n: number;
  }>(sql`
    select d.channel, d.is_test, split_part(e.key, ':', 2) as outcome,
           coalesce(e.value->>'r', '') as reason, count(*)::int as n
    from notification_deliveries d cross join lateral jsonb_each(d.attempt_log) e
    where d.created_at >= now() - interval '2 days'
      and (e.value->>'at')::timestamptz >= now() - interval '24 hours'
    group by 1, 2, 3, 4
    order by n desc, 1, 3, 4
    limit 100
  `);
  const statuses = await db.execute<{
    channel: string;
    is_test: boolean;
    status: string;
    n: number;
  }>(sql`
    select channel, is_test, status, count(*)::int as n
    from notification_deliveries
    where created_at >= now() - interval '24 hours'
    group by 1, 2, 3
    order by 1, 2, 3
  `);
  return `<p>Every attempt's outcome by reason (the push outcome messages, as the persist consumer
merged them into each delivery's attempt log):</p>${table(
    ['Channel', 'Test', 'Outcome', 'Reason', 'Attempts'],
    attempts.map((row) => [
      row.channel,
      row.is_test ? 'yes' : 'no',
      row.outcome,
      row.reason,
      row.n,
    ]),
  )}<p>Deliveries by current status (one row per notification and token):</p>${table(
    ['Channel', 'Test', 'Status', 'Deliveries'],
    statuses.map((row) => [row.channel, row.is_test ? 'yes' : 'no', row.status, row.n]),
  )}`;
}

/** The `/admin` section (ruling P9); each part fails on its own. */
export async function pushTransportSection(
  env: Env,
  db: Db,
  options: AdminPushOptions,
): Promise<string> {
  const log = createLogger({ admin: true, section: 'push' });
  const part = async (name: string, load: () => Promise<string>): Promise<string> => {
    try {
      return await load();
    } catch (error) {
      log.warn('admin_section_failed', {
        section: `push_${name}`,
        error_name: error instanceof Error ? error.name : 'unknown',
      });
      return '<p class="unavailable">unavailable (the read failed; see the log)</p>';
    }
  };
  const [credentials, outcomes] = await Promise.all([
    part('credentials', () => credentialsHtml(env, options)),
    part('outcomes', () => outcomesHtml(db)),
  ]);
  return `${configurationHtml(env)}
<h3>Credentials (PushAuth)</h3>${credentials}
<h3>Outcomes, last 24 hours</h3>${outcomes}
<p><a href="${ADMIN_PUSH_TEST_PATH}">Send a test push</a> through the real push queue and consumer.</p>`;
}

async function pushPage(
  style: string,
  body: string,
  options: { status?: number; form?: boolean; refreshSeconds?: number } = {},
): Promise<Response> {
  return renderPage({
    title: 'PlaneAhead admin: send a test push',
    style,
    body: `<h1>Send a test push</h1>
<p class="meta">One push through the real push queue, consumer, PushAuth and transport, to a
registered token. <a href="/admin">Back to the operations page</a>.</p>
${body}`,
    cacheControl: 'no-store',
    status: options.status,
    formAction: options.form === true ? "'self'" : "'none'",
    // The form posts to this origin: the browser must send the real Origin (rr-ops-1).
    referrerPolicy: options.form === true ? 'same-origin' : 'no-referrer',
    refreshSeconds: options.refreshSeconds,
  });
}

function testForm(values: { token?: string; kind?: string; appId?: string } = {}): string {
  const options = PUSH_TARGET_KINDS.map(
    (kind) =>
      `<option value="${kind}"${values.kind === kind ? ' selected' : ''}>${kind === 'apns' ? 'APNs (iOS)' : 'FCM (Android)'}</option>`,
  ).join('');
  return `<form method="post" action="${ADMIN_PUSH_TEST_PATH}">
<label>Device token <input name="token" value="${esc(values.token ?? '')}" required autocomplete="off" spellcheck="false"></label>
<label>Kind <select name="kind">${options}</select></label>
<label>App id (blank: the app id the token was registered with) <input name="app_id" value="${esc(values.appId ?? '')}" autocomplete="off" spellcheck="false" placeholder="app.planeahead.mobile.dev"></label>
<button type="submit">Send a test push</button>
</form>`;
}

export async function pushTestPage(c: Context<AppBindings>, style: string): Promise<Response> {
  const configuration = pushConfiguration(c.env);
  const notes = [
    configuration.apns.configured
      ? ''
      : `<p class="unavailable">APNs is not configured here (${esc(configuration.apns.problems.join('; '))}): an APNs test push is held as not_configured until it expires.</p>`,
    configuration.fcm.configured
      ? ''
      : `<p class="unavailable">FCM is not configured here (${esc(configuration.fcm.problems.join('; '))}): an FCM test push is held as not_configured until it expires.</p>`,
    environmentName(c.env) === 'production'
      ? '<p class="meta">Production: only tokens of the user ids in PUSH_INJECT_ALLOWED_USER_IDS.</p>'
      : '',
  ].join('');
  return pushPage(style, `${notes}${testForm()}`, { form: true });
}

interface TokenRow extends Record<string, unknown> {
  readonly id: string;
  readonly user_id: string;
  readonly kind: string;
  readonly token: string;
  readonly environment: string;
  readonly app_id: string;
  readonly invalidated_at: string | null;
}

export async function pushTestSend(
  c: Context<AppBindings>,
  options: AdminPushOptions,
  style: string,
  expectedOrigin: string | null,
): Promise<Response> {
  const log = createLogger({ request_id: c.var.requestId, admin: true });
  const origin = c.req.header('origin') ?? null;
  if (expectedOrigin === null || origin !== expectedOrigin) {
    log.warn('admin_push_test_refused', { reason: 'cross_origin' });
    return new Response(null, { status: 403, headers: { 'cache-control': 'no-store' } });
  }
  const form = await c.req.parseBody();
  const token = typeof form['token'] === 'string' ? form['token'].trim() : '';
  const kind = typeof form['kind'] === 'string' ? form['kind'] : '';
  const appIdInput = typeof form['app_id'] === 'string' ? form['app_id'].trim() : '';
  const again = (message: string, status: number) =>
    pushPage(
      style,
      `<p class="unavailable">${esc(message)}</p>${testForm({ token, kind, appId: appIdInput })}`,
      { status, form: true },
    );
  if (!(PUSH_TARGET_KINDS as readonly string[]).includes(kind)) {
    return again('Choose APNs or FCM.', 400);
  }
  if (token.length < 8 || token.length > 4096) {
    return again('That is not a device token.', 400);
  }
  const appId = appIdInput === '' ? null : AppIdSchema.safeParse(appIdInput);
  if (appId !== null && !appId.success) {
    return again('That is not a bundle id or package name.', 400);
  }

  const env = c.env;
  const db = (options.db ?? openDb)(env);
  const [row] = await db.execute<TokenRow>(sql`
    select id::text as id, user_id::text as user_id, kind, token, environment, app_id,
           invalidated_at::text as invalidated_at
    from push_tokens where kind = ${kind} and token = ${token}
  `);
  if (row === undefined) {
    return again(
      'No registered token of that kind. Register the device first (the app registers its token with POST /v1/devices).',
      404,
    );
  }
  if (row.invalidated_at !== null) {
    // Ruling R1: the consumer would drop it unsent (`token_inactive`).
    log.warn('admin_push_test_refused', { reason: 'token_invalidated' });
    return again(
      `That token was invalidated at ${row.invalidated_at} (a sign-out, a rotation or a provider's answer). Register the token again from the app (the app registers its token with POST /v1/devices), then send the test.`,
      409,
    );
  }
  const environment = environmentName(env);
  if (environment === 'production' && !allowedTestPushUserIds(env).has(row.user_id)) {
    log.warn('admin_push_test_refused', { reason: 'not_allow_listed' });
    return again(
      'In production a test push may only go to a token of a user id in PUSH_INJECT_ALLOWED_USER_IDS.',
      403,
    );
  }

  const now = (options.now ?? Date.now)();
  // The id embeds the instant the ten-minute window starts from (the result page reads it back).
  const jobId = uuidv7(() => now);
  const sendAppId = appId?.data ?? row.app_id;
  const job: PushJobV1Input = {
    kind: 'push_job',
    jobId,
    test: true,
    notificationKind: 'system',
    title: 'PlaneAhead test push',
    body: `Sent from the ${environment} admin page at ${new Date(now).toISOString().slice(11, 19)} UTC (job ${jobId.slice(-8)}).`,
    channelId: TEST_PUSH_CHANNEL_ID,
    expiresAt: new Date(now + TEST_PUSH_TTL_MS).toISOString(),
    targets: [
      {
        pushTokenId: row.id,
        subjectId: row.user_id,
        kind: kind as PushTargetKind,
        token: row.token,
        environment: row.environment === 'sandbox' ? 'sandbox' : 'production',
        appId: sendAppId,
        attempt: 0,
      },
    ],
  };
  const parsed = PushJobV1.safeParse(job);
  if (!parsed.success) {
    return again(
      `The job would not validate: ${parsed.error.issues[0]?.message ?? 'invalid'}.`,
      400,
    );
  }
  await (options.pushQueue ?? ((e: Env) => e.PUSH_QUEUE))(env).send(parsed.data);
  const identity = c.var.accessIdentity;
  await db.insert(auditLog).values({
    subjectId: row.user_id,
    actorType: 'admin',
    action: 'push.test_sent',
    targetType: 'push_token',
    targetId: row.id,
    requestId: c.var.requestId,
    details: {
      job_id: jobId,
      kind,
      app_id: sendAppId,
      environment: parsed.data.targets[0]?.environment,
      operator_email: identity?.email ?? null,
      operator_subject: identity?.subject ?? 'unknown',
    },
  });
  log.info('admin_push_test_sent', { job_id: jobId, kind, access_subject: identity?.subject });
  return new Response(null, {
    status: 303,
    headers: {
      location: `${ADMIN_PUSH_RESULT_PATH}?job=${jobId}`,
      'cache-control': 'no-store',
    },
  });
}

interface DeliveryRow extends Record<string, unknown> {
  readonly channel: string;
  readonly status: string;
  readonly attempts: number;
  readonly provider_message_id: string | null;
  readonly error: string | null;
  readonly sent_at: string | null;
  readonly created_at: string;
  readonly attempt_log: Record<
    string,
    { r?: string | null; s?: number | null; p?: string | null; at?: string; u?: string | null }
  > | null;
}

export async function pushTestResult(
  c: Context<AppBindings>,
  options: AdminPushOptions,
  style: string,
): Promise<Response> {
  const job = (c.req.query('job') ?? '').trim().toLowerCase();
  // Every test job id is a UUIDv7 (`pushTestSend`), whose embedded time starts its window.
  if (!isUuidv7(job)) {
    return pushPage(style, '<p class="unavailable">That is not a test job id.</p>', {
      status: 400,
    });
  }
  const db = (options.db ?? openDb)(c.env);
  const [row] = await db.execute<DeliveryRow>(sql`
    select channel, status, attempts::int as attempts, provider_message_id, error,
           sent_at::text as sent_at, created_at::text as created_at, attempt_log
    from notification_deliveries
    where notification_id = ${job}::uuid and is_test
  `);
  const windowEndsMs = uuidv7Timestamp(job) + TEST_PUSH_TTL_MS;
  const windowEnded = (options.now ?? Date.now)() >= windowEndsMs;
  if (row === undefined) {
    if (windowEnded) {
      // Ruling R7: the consumer reports every delivery it takes, and a job's first one normally
      // comes well inside its window; nothing recorded once the window has passed means the
      // report was most likely lost, and reloading every three seconds would never end.
      return pushPage(
        style,
        `<p class="unavailable">No outcome was recorded for job ${esc(job)}, and its ten-minute window ended at ${esc(new Date(windowEndsMs).toISOString())}. The push consumer's outcome message may have been lost: look for push_outcome_send_failed with this job id in the Workers logs. This page no longer reloads itself; reload it to look again.</p><p><a href="${ADMIN_PUSH_TEST_PATH}">Send another</a></p>`,
      );
    }
    return pushPage(
      style,
      `<p>Job ${esc(job)} is queued. The push consumer has not reported its outcome yet; this page reloads every three seconds.</p>`,
      { refreshSeconds: 3 },
    );
  }
  const entries = Object.entries(row.attempt_log ?? {})
    .map(([key, value]) => {
      const [attempt = '', outcome = ''] = key.split(':');
      return { attempt, outcome, ...value };
    })
    .sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
  // Apple's sandbox key to the notification's delivery log, from the newest attempt with one.
  const uniqueId = entries.filter((entry) => typeof entry.u === 'string').at(-1)?.u ?? '';
  const pending = row.status === 'queued';
  // A row still `queued` after the window: the consumer drops a target once its window has
  // passed, so the last retry's outcome was most likely not recorded, and reloading would never
  // end (the same failure ruling R7 covers for a job with no row at all).
  const stuck = pending && windowEnded;
  const footer = stuck
    ? `<p class="unavailable">Still queued after the job's ten-minute window ended at ${esc(new Date(windowEndsMs).toISOString())}. The consumer drops a target past its window, so the outcome of its last retry was most likely not recorded: look for push_outcome_send_failed with this job id in the Workers logs. This page no longer reloads itself; reload it to look again.</p>`
    : pending
      ? '<p>Still in flight (a retry or a hold is queued); this page reloads every three seconds.</p>'
      : '';
  return pushPage(
    style,
    `${table(
      [
        'Job',
        'Channel',
        'Status',
        'apns-id or message name',
        'apns-unique-id',
        'Reason',
        'Attempts',
        'Sent at',
      ],
      [
        [
          job,
          row.channel,
          row.status,
          row.provider_message_id ?? '',
          uniqueId,
          row.error ?? '',
          row.attempts,
          row.sent_at ?? '',
        ],
      ],
    )}${uniqueId === '' ? '' : '<p class="meta">The apns-unique-id is the key to this notification in the delivery log of Apple\'s Push Notifications Console (sandbox sends only).</p>'}<h2>Attempts</h2>${table(
      ['Attempt', 'Outcome', 'Reason', 'HTTP status', 'Provider id', 'apns-unique-id', 'At'],
      entries.map((entry) => [
        entry.attempt,
        entry.outcome,
        entry.r ?? '',
        entry.s ?? '',
        entry.p ?? '',
        entry.u ?? '',
        entry.at ?? '',
      ]),
    )}${footer}<p><a href="${ADMIN_PUSH_TEST_PATH}">Send another</a></p>`,
    pending && !stuck ? { refreshSeconds: 3 } : {},
  );
}
