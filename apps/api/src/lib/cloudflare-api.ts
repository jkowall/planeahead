/**
 * The Cloudflare REST API calls the operational surface makes (increment 12): the Workers
 * Analytics Engine SQL API (the nightly provider-call rollup and the admin page's "today so far")
 * and the Queues API (the admin page's queue depths). Every call goes through an injected `fetch`
 * so the suite answers them without a network, and every call needs `CF_ACCOUNT_ID` (a var) and
 * `CF_API_TOKEN` (an optional secret with Account Analytics Read and Queues Read); without them
 * the callers report the figures as unavailable rather than failing.
 *
 * Facts (docs, 2026-09-23): the SQL API is `POST /accounts/{account_id}/analytics_engine/sql`
 * with the raw SQL as the body and `Authorization: Bearer`, answering `FORMAT JSON` by default as
 * `{ meta, data, rows }` (https://developers.cloudflare.com/analytics/analytics-engine/sql-api/,
 * .../sql-reference/statements/); sampled rows are weighted by `_sample_interval`. Queue depth is
 * `GET /accounts/{account_id}/queues/{queue_id}/metrics` (`backlog_count`, `backlog_bytes`,
 * `oldest_message_timestamp_ms`), and the ids come from `GET /accounts/{account_id}/queues`
 * (`queue_id`, `queue_name`), both accepting a Queues Read token
 * (https://developers.cloudflare.com/api/resources/queues/). How 64-bit integers are encoded in
 * the SQL API's JSON is not documented, so every number is read from a number or a numeric string.
 */

import * as z from 'zod';

export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

/** What an API call needs; null when the environment does not configure it. */
export interface CloudflareApiAccess {
  readonly accountId: string;
  readonly apiToken: string;
  readonly fetch: typeof fetch;
}

const ACCOUNT_ID_SHAPE = /^[0-9a-f]{32}$/;

/** The access, or null when either half is missing or malformed. */
export function cloudflareApiAccess(
  accountId: string | undefined,
  apiToken: string | undefined,
  doFetch: typeof fetch = fetch,
): CloudflareApiAccess | null {
  const id = accountId?.trim() ?? '';
  const token = apiToken?.trim() ?? '';
  if (!ACCOUNT_ID_SHAPE.test(id) || token === '') {
    return null;
  }
  return { accountId: id, apiToken: token, fetch: doFetch };
}

export class CloudflareApiError extends Error {
  override readonly name = 'CloudflareApiError';

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A number or a numeric string (the SQL API quotes 64-bit integers in some formats). */
const Numeric = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i)]);

/**
 * A figure for DISPLAY: anything that is not a number reads as 0. Never for a value something
 * is decided on or stored (the rollup uses `strictNumeric`: a coerced 0 there once let the
 * `provider_calls` purge delete the exact ledger against a row that said nothing was called).
 */
export function numeric(value: unknown): number {
  return strictNumeric(value) ?? 0;
}

/** A finite number or numeric string as a number; null for anything else (null, '', 'n/a'). */
export function strictNumeric(value: unknown): number | null {
  const parsed = Numeric.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const number = Number(parsed.data);
  return Number.isFinite(number) ? number : null;
}

const SqlJsonResponse = z.looseObject({
  data: z.array(z.record(z.string(), z.unknown())),
});

/** Runs one SQL statement against the Analytics Engine SQL API; throws on a non-2xx answer. */
export async function analyticsSql(
  access: CloudflareApiAccess,
  statement: string,
): Promise<Record<string, unknown>[]> {
  const response = await access.fetch(
    `${CLOUDFLARE_API_BASE}/accounts/${access.accountId}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${access.apiToken}`, 'content-type': 'text/plain' },
      body: statement,
    },
  );
  if (!response.ok) {
    // The body may echo the statement; only the status leaves this function.
    throw new CloudflareApiError(
      response.status,
      `Analytics Engine SQL API answered ${String(response.status)}`,
    );
  }
  return SqlJsonResponse.parse(await response.json()).data;
}

/**
 * A literal safe to splice into Analytics Engine SQL (which takes no bind parameters): only the
 * characters our dataset names, provider ids, ISO dates and environment names use.
 */
export function sqlLiteral(value: string): string {
  if (!/^[A-Za-z0-9_:. -]{1,64}$/.test(value)) {
    throw new Error(`refusing to splice ${JSON.stringify(value)} into Analytics Engine SQL`);
  }
  return `'${value}'`;
}

const QueueList = z.looseObject({
  result: z.array(z.looseObject({ queue_id: z.string(), queue_name: z.string() })),
});

const QueueMetrics = z.looseObject({
  result: z.looseObject({
    backlog_count: z.unknown().optional(),
    backlog_bytes: z.unknown().optional(),
    oldest_message_timestamp_ms: z.unknown().optional(),
  }),
});

export interface QueueDepth {
  readonly name: string;
  readonly backlogCount: number | null;
  readonly backlogBytes: number | null;
  readonly oldestMessageAt: string | null;
  /** Set when this queue's figures could not be read. */
  readonly error?: string;
}

async function getJson(access: CloudflareApiAccess, path: string): Promise<unknown> {
  const response = await access.fetch(`${CLOUDFLARE_API_BASE}${path}`, {
    headers: { authorization: `Bearer ${access.apiToken}` },
  });
  if (!response.ok) {
    throw new CloudflareApiError(
      response.status,
      `Cloudflare API answered ${String(response.status)}`,
    );
  }
  return response.json();
}

/** The backlog of each named queue (this environment's), in the order given. */
export async function queueDepths(
  access: CloudflareApiAccess,
  names: readonly string[],
): Promise<QueueDepth[]> {
  const listed = QueueList.parse(
    await getJson(access, `/accounts/${access.accountId}/queues?per_page=100`),
  );
  const ids = new Map(listed.result.map((queue) => [queue.queue_name, queue.queue_id]));
  return Promise.all(
    names.map(async (name): Promise<QueueDepth> => {
      const id = ids.get(name);
      if (id === undefined) {
        return {
          name,
          backlogCount: null,
          backlogBytes: null,
          oldestMessageAt: null,
          error: 'not found',
        };
      }
      try {
        const metrics = QueueMetrics.parse(
          await getJson(
            access,
            `/accounts/${access.accountId}/queues/${encodeURIComponent(id)}/metrics`,
          ),
        ).result;
        const oldest = numeric(metrics.oldest_message_timestamp_ms);
        return {
          name,
          backlogCount: numeric(metrics.backlog_count),
          backlogBytes: numeric(metrics.backlog_bytes),
          oldestMessageAt: oldest > 0 ? new Date(oldest).toISOString() : null,
        };
      } catch (error) {
        return {
          name,
          backlogCount: null,
          backlogBytes: null,
          oldestMessageAt: null,
          error: error instanceof CloudflareApiError ? `HTTP ${String(error.status)}` : 'failed',
        };
      }
    }),
  );
}
