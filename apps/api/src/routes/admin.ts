/**
 * `GET /admin`: the operator page (increment 12, ruling W5), behind Cloudflare Access
 * (src/middleware/access.ts) on every `/admin` path, read-only except ONE write action (below),
 * server-rendered HTML with no client framework and no script (src/lib/html.ts: a strict CSP,
 * `no-store`).
 *
 * One page, one section per question, each loaded on its own so a failing source shows as
 * unavailable instead of failing the page:
 *
 *   - provider calls per flight key, last 7 days, from `provider_calls` (the resolver's search
 *     records carry the resolved key since increment 12, so no join by request id is needed);
 *   - provider calls per provider per day, last 14 days, from `provider_call_daily` (the rollup's
 *     per-operation rows summed, the ProviderBudget object's `budget_daily` rows shown apart as the
 *     object's own daily total) and today so far from the Analytics Engine SQL API
 *     (`SUM(_sample_interval)`; unavailable without `CF_ACCOUNT_ID` and `CF_API_TOKEN`);
 *   - the Durable Object schema versions and the migration hash this build expects (the data
 *     `GET /health` answers);
 *   - the sync watermark and its lag: `now()` minus the start of the oldest in-progress
 *     transaction holding an xid (`pg_stat_activity`), the one number that says the feed is frozen;
 *     marked partial when the role lacks `pg_read_all_stats` (then `pg_stat_activity` hides other
 *     roles' backends; the runbook grants it, ruling AA5);
 *   - the queue depths from the Cloudflare Queues API (unavailable without the token);
 *   - `sync_horizon` and `sync_epoch`;
 *   - the last housekeeping `audit_log` rows.
 *
 * The one write action (ruling AA9): operator account deletion, for a request that reached the
 * support inbox the public `/account/delete` page names. `GET /admin/accounts/delete` takes a user
 * id and shows the account's status and creation date; its form posts the id again, typed a second
 * time, to `POST /admin/accounts/delete`, which runs `deleteAccount`, the very path
 * `POST /v1/me/delete` runs (tracker unsubscribes, the Apple revocation, the one transaction, the
 * `deleted_subjects` rows and the KV session tombstones), and its one `audit_log` row names the
 * operator (actor `admin`, the Access assertion's email and subject) and the user id. Same origin
 * only: the POST must carry an `Origin` equal to `API_PUBLIC_URL`'s (no cookie authorises it; the
 * Access assertion does, and a cross-site form would still carry the Access cookie). For the
 * browser to send that origin, the lookup and result pages alone are served with
 * `Referrer-Policy: same-origin` (`accountPage`); under the `no-referrer` every other admin page
 * keeps, a browser sends `Origin: null` on the page's own form POST and the check would refuse the
 * page's own button (re-review finding rr-ops-1). A confirmation that does not match changes
 * nothing.
 */

import { sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { openDb, type Db } from '@planeahead/db';
import { DO_CALL_DEADLINE_MS } from '@planeahead/shared';
import { Envelope } from '../crypto/envelope';
import { createWorkersSecretKeyProvider, readKekSecrets } from '../crypto/key-provider';
import { environmentName, type AppBindings, type Env, type EnvironmentName } from '../env';
import { deleteAccount } from '../lib/account-deletion';
import { MIGRATION_COUNT, MIGRATION_HASH } from '../generated/migration-hash';
import {
  analyticsSql,
  cloudflareApiAccess,
  numeric,
  queueDepths,
  type CloudflareApiAccess,
} from '../lib/cloudflare-api';
import { esc, renderPage, table } from '../lib/html';
import {
  BUDGET_DAILY_OPERATION_PATTERN,
  providerCallsDataset,
  todayStatement,
} from '../lib/provider-rollup';
import { defaultTrackerFor, type TrackerFor } from '../lib/trackers';
import { accessMiddleware, type AccessOptions } from '../middleware/access';
import { createLogger, errorFields, type Logger } from '../observability/log';
import { DO_SCHEMA_VERSIONS } from './health';

const STYLE = `
:root { color-scheme: light dark; font: 14px/1.4 system-ui, sans-serif; }
body { margin: 16px; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 16px; margin: 24px 0 8px; }
p.meta { color: #666; margin: 0 0 16px; }
table { border-collapse: collapse; width: 100%; max-width: 1100px; }
th, td { border-bottom: 1px solid #8884; padding: 4px 8px; text-align: left;
  font-variant-numeric: tabular-nums; vertical-align: top; }
td.empty, p.unavailable { color: #a60; }
code { font-size: 12px; }
form { margin: 8px 0 16px; }
label { display: block; margin: 8px 0; }
input { font: inherit; width: 100%; max-width: 420px; }
button { font: inherit; margin-top: 8px; }
p.done { color: #070; }
`;

/** The queues this environment consumes, as wrangler.jsonc names them. */
export function environmentQueueNames(environment: EnvironmentName): string[] {
  const suffix =
    environment === 'production' ? '' : environment === 'staging' ? '-staging' : '-local';
  const kinds = ['persist', 'notify', 'provider-events', 'imports', 'reconcile', 'housekeeping'];
  return kinds.flatMap((kind) => [
    `planeahead-${kind}${suffix}`,
    `planeahead-${kind}-dlq${suffix}`,
  ]);
}

export interface AdminRoutesOptions {
  readonly access?: AccessOptions | undefined;
  /** The Cloudflare API's fetch (Analytics Engine SQL, Queues). */
  readonly fetch?: typeof fetch | undefined;
  readonly db?: ((env: Env) => Db) | undefined;
  /** The FlightTracker resolver the account deletion unsubscribes through. */
  readonly trackerFor?: ((env: Env) => TrackerFor) | undefined;
}

/** The operator deletion's path (ruling AA9). */
export const ADMIN_ACCOUNT_DELETE_PATH = '/admin/accounts/delete';
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Section =
  { readonly ok: true; readonly html: string } | { readonly ok: false; readonly reason: string };

async function section(log: Logger, name: string, load: () => Promise<string>): Promise<Section> {
  try {
    return { ok: true, html: await load() };
  } catch (error) {
    log.warn('admin_section_failed', { section: name, ...errorFields(error) });
    return { ok: false, reason: 'unavailable (the read failed; see the log)' };
  }
}

function sectionHtml(title: string, result: Section): string {
  return `<h2>${esc(title)}</h2>${
    result.ok ? result.html : `<p class="unavailable">${esc(result.reason)}</p>`
  }`;
}

function usd(micros: unknown): string {
  return `$${(numeric(micros) / 1_000_000).toFixed(4)}`;
}

async function perFlight(db: Db): Promise<string> {
  const rows = await db.execute<{
    flight_key: string | null;
    provider: string;
    calls: number;
    units: string;
    micros: string;
    last_call: string;
  }>(sql`
    select flight_key, provider, count(*)::int as calls, sum(cost_units)::text as units,
           sum(cost_usd_micros)::text as micros, max(created_at)::text as last_call
    from provider_calls
    where created_at >= now() - interval '7 days'
    group by flight_key, provider
    order by calls desc, flight_key
    limit 50
  `);
  return table(
    ['Flight key', 'Provider', 'Calls', 'Units', 'Est. cost', 'Last call'],
    rows.map((row) => [
      row.flight_key ?? '(no key)',
      row.provider,
      row.calls,
      row.units,
      usd(row.micros),
      row.last_call,
    ]),
  );
}

async function perProviderDay(db: Db): Promise<string> {
  const rows = await db.execute<{
    day: string;
    provider: string;
    calls: string | null;
    units: string | null;
    micros: string | null;
    budget_calls: string | null;
    budget_units: string | null;
  }>(sql`
    select day::text as day, provider,
      sum(calls) filter (where operation not like ${BUDGET_DAILY_OPERATION_PATTERN})::text as calls,
      sum(cost_units) filter (where operation not like ${BUDGET_DAILY_OPERATION_PATTERN})::text
        as units,
      sum(cost_usd_micros) filter (where operation not like ${BUDGET_DAILY_OPERATION_PATTERN})::text
        as micros,
      sum(calls) filter (where operation like ${BUDGET_DAILY_OPERATION_PATTERN})::text
        as budget_calls,
      sum(cost_units) filter (where operation like ${BUDGET_DAILY_OPERATION_PATTERN})::text
        as budget_units
    from provider_call_daily
    where day >= (now() at time zone 'UTC')::date - 14
    group by day, provider
    order by day desc, provider
  `);
  return table(
    [
      'Day (UTC)',
      'Provider',
      'Calls (rollup)',
      'Units (rollup)',
      'Est. cost (rollup)',
      'ProviderBudget calls',
      'ProviderBudget units',
    ],
    rows.map((row) => [
      row.day,
      row.provider,
      row.calls ?? '',
      row.units ?? '',
      row.micros === null ? '' : usd(row.micros),
      row.budget_calls ?? '',
      row.budget_units ?? '',
    ]),
  );
}

async function todaySoFar(access: CloudflareApiAccess | null, env: Env): Promise<string> {
  if (access === null) {
    return '<p class="unavailable">unavailable: CF_ACCOUNT_ID or CF_API_TOKEN is not set</p>';
  }
  const environment = environmentName(env);
  const day = new Date().toISOString().slice(0, 10);
  const data = await analyticsSql(
    access,
    todayStatement(providerCallsDataset(environment), day, environment),
  );
  return table(
    ['Provider', 'Calls today (sampled, weighted)', 'Units', 'Est. cost'],
    data.map((row) => [
      typeof row['provider'] === 'string' ? row['provider'] : '',
      Math.round(numeric(row['calls'])),
      Math.round(numeric(row['cost_units'])),
      usd(row['cost_usd_micros']),
    ]),
  );
}

function schemaVersions(env: Env): string {
  return table(
    ['What', 'This build'],
    [
      ['Environment', environmentName(env)],
      ['Migration hash', MIGRATION_HASH],
      ['Migrations', MIGRATION_COUNT],
      ...Object.entries(DO_SCHEMA_VERSIONS).map(([name, version]) => [
        `${name} schema version`,
        version,
      ]),
    ],
  );
}

/** One row of the watermark query. */
export interface WatermarkRow extends Record<string, unknown> {
  readonly watermark: string;
  readonly lag_seconds: string | null;
  readonly writers: number;
  readonly oldest_start: string | null;
  /** Whether the role is a member of `pg_read_all_stats` (ruling AA5). */
  readonly full_stats: boolean;
}

/** The notice shown when the role cannot see other roles' backends in `pg_stat_activity`. */
export const PARTIAL_STATS_NOTICE = 'partial: the role lacks pg_read_all_stats';

/** The watermark section from its one row. */
export function watermarkHtml(row: WatermarkRow | undefined): string {
  const lag =
    row?.lag_seconds === null || row?.lag_seconds === undefined
      ? '0 s (no transaction holds an xid)'
      : `${numeric(row.lag_seconds).toFixed(1)} s`;
  const notice =
    row?.full_stats === false
      ? `<p class="unavailable">${esc(PARTIAL_STATS_NOTICE)} (pg_stat_activity shows only this role's backends, so the lag can read low; docs/runbooks/first-deploy.md step 7 grants it)</p>`
      : '';
  return `${notice}${table(
    ['Watermark (pg_snapshot_xmin)', 'Lag', 'Transactions holding an xid', 'Oldest started'],
    [[row?.watermark ?? '', lag, row?.writers ?? 0, row?.oldest_start ?? '']],
  )}`;
}

async function watermark(db: Db): Promise<string> {
  const [row] = await db.execute<WatermarkRow>(sql`
    select pg_snapshot_xmin(pg_current_snapshot())::text as watermark,
      (select extract(epoch from now() - min(xact_start))::text from pg_stat_activity
        where backend_xid is not null and pid <> pg_backend_pid()) as lag_seconds,
      (select count(*)::int from pg_stat_activity
        where backend_xid is not null and pid <> pg_backend_pid()) as writers,
      (select min(xact_start)::text from pg_stat_activity
        where backend_xid is not null and pid <> pg_backend_pid()) as oldest_start,
      pg_has_role(current_user, 'pg_read_all_stats', 'member') as full_stats
  `);
  return watermarkHtml(row);
}

async function queues(access: CloudflareApiAccess | null, env: Env): Promise<string> {
  if (access === null) {
    return '<p class="unavailable">unavailable: CF_ACCOUNT_ID or CF_API_TOKEN is not set</p>';
  }
  const depths = await queueDepths(access, environmentQueueNames(environmentName(env)));
  return table(
    ['Queue', 'Backlog (messages)', 'Backlog (bytes)', 'Oldest message'],
    depths.map((depth) =>
      depth.error === undefined
        ? [depth.name, depth.backlogCount, depth.backlogBytes, depth.oldestMessageAt ?? '']
        : [depth.name, `unavailable (${depth.error})`, '', ''],
    ),
  );
}

async function syncState(db: Db): Promise<string> {
  const [row] = await db.execute<{
    horizon: string | null;
    purged_at: string | null;
    epoch: string | null;
    bumped_at: string | null;
  }>(sql`
    select (select horizon_xid::text from sync_horizon where id = 1) as horizon,
           (select purged_at::text from sync_horizon where id = 1) as purged_at,
           (select epoch::text from sync_epoch where id = 1) as epoch,
           (select bumped_at::text from sync_epoch where id = 1) as bumped_at
  `);
  return table(
    ['sync_horizon', 'Last purge', 'sync_epoch', 'Epoch bumped'],
    [
      [
        row?.horizon ?? '(none yet)',
        row?.purged_at ?? '',
        row?.epoch ?? '',
        row?.bumped_at ?? '(never)',
      ],
    ],
  );
}

async function housekeeping(db: Db): Promise<string> {
  const rows = await db.execute<{ created_at: string; action: string; details: unknown }>(sql`
    select created_at::text as created_at, action, details
    from audit_log
    where action like 'housekeeping.%'
    order by created_at desc
    limit 20
  `);
  return table(
    ['When', 'Step', 'Details'],
    rows.map((row) => [row.created_at, row.action, JSON.stringify(row.details)]),
  );
}

/** The API's own origin, the only `Origin` the deletion POST accepts; null when unset. */
function apiOrigin(env: Env): string | null {
  try {
    return new URL(env.API_PUBLIC_URL).origin;
  } catch {
    return null;
  }
}

function normalisedUserId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const id = value.trim().toLowerCase();
  return UUID_SHAPE.test(id) ? id : null;
}

async function accountPage(
  body: string,
  options: { status?: number; form?: boolean } = {},
): Promise<Response> {
  return renderPage({
    title: 'PlaneAhead admin: delete an account',
    style: STYLE,
    body: `<h1>Delete an account</h1>
<p class="meta">The one write action on this page. Use it for a deletion request that reached the
support inbox and was confirmed from the account's own address (docs/runbooks/first-deploy.md);
it runs the same deletion as the app's Delete account. <a href="/admin">Back to the operations
page</a>.</p>
${body}`,
    cacheControl: 'no-store',
    status: options.status,
    formAction: options.form === true ? "'self'" : "'none'",
    // The one policy under which the browser sends this origin on the form's POST (rr-ops-1).
    referrerPolicy: 'same-origin',
  });
}

function lookupForm(value = ''): string {
  return `<form method="get" action="${ADMIN_ACCOUNT_DELETE_PATH}">
<label>User id <input name="user_id" value="${esc(value)}" required autocomplete="off" spellcheck="false"></label>
<button type="submit">Look up</button>
</form>`;
}

interface AccountRow extends Record<string, unknown> {
  readonly id: string;
  readonly status: string;
  readonly is_anonymous: boolean;
  readonly created_at: string;
}

async function lookUpAccount(db: Db, userId: string): Promise<AccountRow | undefined> {
  const [row] = await db.execute<AccountRow>(sql`
    select id::text as id, status, coalesce(is_anonymous, false) as is_anonymous,
           created_at::text as created_at
    from users where id = ${userId}::uuid
  `);
  return row;
}

async function accountLookup(c: Context<AppBindings>, options: AdminRoutesOptions) {
  const raw = c.req.query('user_id');
  if (raw === undefined || raw.trim() === '') {
    return accountPage(lookupForm(), { form: true });
  }
  const userId = normalisedUserId(raw);
  if (userId === null) {
    return accountPage(`<p class="unavailable">That is not a user id.</p>${lookupForm(raw)}`, {
      status: 400,
      form: true,
    });
  }
  const row = await lookUpAccount((options.db ?? openDb)(c.env), userId);
  if (row === undefined) {
    return accountPage(
      `<p class="unavailable">No account has the id ${esc(userId)} (already deleted?).</p>${lookupForm()}`,
      { status: 404, form: true },
    );
  }
  return accountPage(
    `${table(
      ['User id', 'Status', 'Created', 'Guest account'],
      [[row.id, row.status, row.created_at, row.is_anonymous ? 'yes' : 'no']],
    )}
<form method="post" action="${ADMIN_ACCOUNT_DELETE_PATH}">
<input type="hidden" name="user_id" value="${esc(row.id)}">
<label>Type the user id again to confirm <input name="confirm_user_id" required autocomplete="off" spellcheck="false"></label>
<button type="submit">Delete this account now</button>
</form>`,
    { form: true },
  );
}

async function accountDeletion(c: Context<AppBindings>, options: AdminRoutesOptions) {
  const log = createLogger({ request_id: c.var.requestId, admin: true });
  const expected = apiOrigin(c.env);
  const origin = c.req.header('origin') ?? null;
  if (expected === null || origin !== expected) {
    log.warn('admin_account_delete_refused', { reason: 'cross_origin' });
    return new Response(null, { status: 403, headers: { 'cache-control': 'no-store' } });
  }
  const form = await c.req.parseBody();
  const userId = normalisedUserId(form['user_id']);
  const confirmation = normalisedUserId(form['confirm_user_id']);
  if (userId === null || confirmation !== userId) {
    log.warn('admin_account_delete_refused', { reason: 'confirmation_mismatch' });
    return accountPage(
      `<p class="unavailable">The confirmation did not match the user id. Nothing was deleted.</p>${lookupForm(
        userId ?? '',
      )}`,
      { status: 400, form: true },
    );
  }
  const identity = c.var.accessIdentity;
  const env = c.env;
  const db = (options.db ?? openDb)(env);
  const report = await deleteAccount(
    {
      env,
      db,
      envelope: new Envelope(db, createWorkersSecretKeyProvider(readKekSecrets(env))),
      log,
      trackerFor: (options.trackerFor ?? defaultTrackerFor)(env),
      deadlineMs: DO_CALL_DEADLINE_MS,
      waitUntil: (promise) => {
        c.executionCtx.waitUntil(promise);
      },
      requestId: c.var.requestId,
      actor: {
        type: 'admin',
        email: identity?.email ?? null,
        subject: identity?.subject ?? 'unknown',
      },
    },
    userId,
  );
  if (report === null) {
    return accountPage(
      `<p class="unavailable">No account has the id ${esc(userId)} (already deleted?). Nothing was deleted.</p>`,
      { status: 404 },
    );
  }
  log.info('admin_account_deleted', {
    access_subject: identity?.subject,
    subscriptions: report.subscriptions,
    trackers_failed: report.trackersFailed,
    apple_revoke: report.apple.outcome,
  });
  return accountPage(
    `<p class="done">Account ${esc(userId)} was deleted.</p>${table(
      [
        'Subscriptions',
        'Trackers unsubscribed',
        'Trackers failed',
        'Session tombstones',
        'Apple revocation',
      ],
      [
        [
          report.subscriptions,
          report.trackersUnsubscribed,
          report.trackersFailed,
          report.sessionTombstones,
          report.apple.outcome,
        ],
      ],
    )}<p>Reply to the requester from the support inbox that the account is deleted.</p>`,
  );
}

export function createAdminRoutes(options: AdminRoutesOptions = {}) {
  const app = new Hono<AppBindings>();
  app.use('*', accessMiddleware(options.access));
  app.get('/accounts/delete', (c) => accountLookup(c, options));
  app.post('/accounts/delete', (c) => accountDeletion(c, options));
  app.get('/', async (c) => {
    const log = createLogger({ request_id: c.var.requestId, admin: true });
    const env = c.env;
    const db = (options.db ?? openDb)(env);
    const access = cloudflareApiAccess(env.CF_ACCOUNT_ID, env.CF_API_TOKEN, options.fetch ?? fetch);
    const [flights, days, today, watermarkSection, queueSection, sync, audit] = await Promise.all([
      section(log, 'per_flight', () => perFlight(db)),
      section(log, 'per_provider_day', () => perProviderDay(db)),
      section(log, 'today', () => todaySoFar(access, env)),
      section(log, 'watermark', () => watermark(db)),
      section(log, 'queues', () => queues(access, env)),
      section(log, 'sync_state', () => syncState(db)),
      section(log, 'housekeeping', () => housekeeping(db)),
    ]);
    const identity = c.var.accessIdentity;
    const body = [
      '<h1>PlaneAhead operations</h1>',
      `<p class="meta">${esc(environmentName(env))}, read-only except the account deletion below. Signed in through Cloudflare Access as ${esc(
        identity?.email ?? identity?.subject ?? 'unknown',
      )}. Generated ${esc(new Date().toISOString())}.</p>`,
      sectionHtml('Provider calls per flight key (last 7 days, provider_calls)', flights),
      sectionHtml(
        'Provider calls per provider per day (provider_call_daily; ProviderBudget totals apart)',
        days,
      ),
      sectionHtml('Today so far (Analytics Engine SQL API)', today),
      sectionHtml('Durable Object schema versions (as /health reports them)', {
        ok: true,
        html: schemaVersions(env),
      }),
      sectionHtml('Sync watermark lag', watermarkSection),
      sectionHtml('Queue depths (Cloudflare Queues API)', queueSection),
      sectionHtml('Sync horizon and epoch', sync),
      sectionHtml('Last housekeeping runs (audit_log)', audit),
      sectionHtml('Operator account deletion', {
        ok: true,
        html: `<p>For a deletion request that reached the support inbox: <a href="${ADMIN_ACCOUNT_DELETE_PATH}">look up the account and delete it</a> (the one write action).</p>`,
      }),
    ].join('\n');
    return renderPage({ title: 'PlaneAhead admin', style: STYLE, body, cacheControl: 'no-store' });
  });
  return app;
}

export const adminRoutes = createAdminRoutes();
