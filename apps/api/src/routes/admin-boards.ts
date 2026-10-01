/**
 * The admin page's boards section (increment 18, ruling B11; plan section 4's "airports kept
 * live" and section 9 item 6). Three reads, each failing on its own:
 *
 *   - today's AeroDataBox `ProviderBudget` object (`snapshot().boards`): the boards share spent
 *     against its cap and the degrade step it puts the freshness ladder on, and the distinct
 *     airports refreshed this UTC hour against their cap;
 *   - `provider_calls`, last hour: the airports with a bucket refreshed (a FIDS call that
 *     answered), the airports kept live;
 *   - `provider_calls`, today (UTC): board and route-search calls by trigger and result.
 *
 * `provider_calls` rows arrive through the persist queue, so the last two trail the budget by the
 * queue's delay.
 */

import { sql } from 'drizzle-orm';
import type { Db } from '@planeahead/db';
import { BOARD_STALE_ONLY_SHARE, boardDegradeMultiplier } from '@planeahead/shared';
import type { BudgetSnapshot } from '../do/provider-budget';
import type { Env } from '../env';
import { esc, table } from '../lib/html';
import { createLogger } from '../observability/log';
import { providerBudgetNameFor, utcDate } from '../providers/budget';

export interface AdminBoardsOptions {
  /** The page's clock in ms (the push section's too); the budget day and "today" read it. */
  readonly now?: (() => number) | undefined;
  /** Replaces the budget object's stub (`PROVIDER_BUDGET.getByName`). */
  readonly budgetFor?:
    ((env: Env, name: string) => { snapshot(): Promise<BudgetSnapshot> }) | undefined;
}

function percent(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

/** What the share spent does to the ladder (ruling B5). */
export function degradeStep(shareSpent: number): string {
  if (shareSpent >= BOARD_STALE_ONLY_SHARE) {
    return 'stale copies only (share spent)';
  }
  const multiplier = boardDegradeMultiplier(shareSpent);
  return multiplier === 1 ? 'normal ladder' : `ladder times ${String(multiplier)}`;
}

async function budgetHtml(env: Env, now: Date, options: AdminBoardsOptions): Promise<string> {
  const name = providerBudgetNameFor('aerodatabox', utcDate(now));
  const stub =
    options.budgetFor?.(env, name) ?? env.PROVIDER_BUDGET.getByName(name, { locationHint: 'enam' });
  const { boards } = await stub.snapshot();
  return table(
    ['Limit', 'Used', 'Cap', 'Share', 'Effect'],
    [
      [
        'Boards share of the AeroDataBox day (board, route_search)',
        `${String(boards.spentUnits)} units`,
        `${String(boards.capUnits)} units`,
        percent(boards.shareSpent),
        degradeStep(boards.shareSpent),
      ],
      [
        'Distinct airports refreshed this UTC hour',
        boards.airportsThisHour.length,
        boards.airportsPerHourCap,
        percent(
          boards.airportsPerHourCap > 0
            ? boards.airportsThisHour.length / boards.airportsPerHourCap
            : 1,
        ),
        boards.airportsThisHour.join(' ') || 'none',
      ],
    ],
  );
}

/** The airports kept live: a bucket refreshed (a FIDS call that answered) in the last hour. */
async function keptLiveHtml(db: Db, now: Date): Promise<string> {
  const since = new Date(now.getTime() - 60 * 60_000).toISOString();
  const rows = await db.execute<{ airport_icao: string; calls: number; last_call: string }>(sql`
    select airport_icao, count(*)::int as calls, max(created_at)::text as last_call
    from provider_calls
    where trigger in ('board', 'route_search') and operation = 'fids' and result = 'ok'
      and airport_icao is not null and created_at >= ${since}::timestamptz
    group by airport_icao
    order by calls desc, airport_icao
    limit 100
  `);
  return table(
    ['Airport', 'Bucket refreshes', 'Last refresh'],
    rows.map((row) => [row.airport_icao, row.calls, row.last_call]),
  );
}

/** Board and route-search calls today (UTC), by trigger and result. */
async function callsByResultHtml(db: Db, now: Date): Promise<string> {
  const dayStart = `${utcDate(now)}T00:00:00Z`;
  const rows = await db.execute<{ trigger: string; result: string; calls: number; units: string }>(
    sql`
      select trigger, result, count(*)::int as calls, sum(cost_units)::text as units
      from provider_calls
      where trigger in ('board', 'route_search') and created_at >= ${dayStart}::timestamptz
      group by trigger, result
      order by trigger, result
    `,
  );
  return table(
    ['Trigger', 'Result', 'Calls', 'Units'],
    rows.map((row) => [row.trigger, row.result, row.calls, row.units]),
  );
}

/** The section's HTML; a read that fails shows as unavailable without hiding the others. */
export async function boardsSection(
  env: Env,
  db: Db,
  options: AdminBoardsOptions = {},
): Promise<string> {
  const log = createLogger({ admin: true, section: 'boards' });
  const now = new Date(options.now?.() ?? Date.now());
  const part = async (name: string, load: () => Promise<string>): Promise<string> => {
    try {
      return await load();
    } catch (error) {
      log.warn('admin_section_failed', {
        section: `boards_${name}`,
        error_name: error instanceof Error ? error.name : 'unknown',
      });
      return '<p class="unavailable">unavailable (the read failed; see the log)</p>';
    }
  };
  const [budget, keptLive, byResult] = await Promise.all([
    part('budget', () => budgetHtml(env, now, options)),
    part('kept_live', () => keptLiveHtml(db, now)),
    part('by_result', () => callsByResultHtml(db, now)),
  ]);
  return `<p>AeroDataBox day ${esc(utcDate(now))}. Boards stay out of share pages, public tokens and MCP until AeroDataBox confirms End Use.</p>
${budget}
<h3>Airports kept live (a bucket refreshed in the last hour)</h3>${keptLive}
<h3>Board and route-search calls today (UTC), by result</h3>${byResult}`;
}
