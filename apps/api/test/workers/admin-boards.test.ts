/**
 * Ruling B11 (increment 18, part 2): the admin page's boards section shows the boards share spent
 * today against its cap, the distinct airports refreshed this hour against theirs, the airports
 * kept live (a bucket refreshed in the last hour) and the board and route-search calls by
 * result. A day in the 22nd century keeps other files' rows and budget out of the numbers.
 */

import { runInDurableObject } from 'cloudflare:test';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { uuidv7, type BudgetRequest } from '@planeahead/shared';
import type { ProviderBudget } from '../../src/do/provider-budget';
import { boardsSection, degradeStep } from '../../src/routes/admin-boards';
import { uniqueAirport, uniqueDay } from './helpers/airports';
import { HOUR_MS, MINUTE_MS, drainTouched, testEnv, track } from './helpers/flights';
import { db } from './helpers/routes';

afterEach(drainTouched);

async function recordCall(
  trigger: string,
  result: string,
  airportIcao: string | null,
  atMs: number,
  operation = 'fids',
): Promise<void> {
  await db().execute(sql`
    insert into provider_calls (id, provider, operation, trigger, result, cost_units,
                                cost_usd_micros, airport_icao, created_at)
    values (${uuidv7()}::uuid, 'aerodatabox', ${operation}, ${trigger}, ${result}, 2, 500,
            ${airportIcao}, ${new Date(atMs).toISOString()}::timestamptz)
  `);
}

describe('the admin boards section (ruling B11)', () => {
  it('renders the share, the airports this hour, the airports kept live and the calls by result', async () => {
    const day = uniqueDay();
    const now = Date.parse(`${day}T12:30:00Z`);
    const [kept, alsoKept, earlier] = [uniqueAirport(), uniqueAirport(), uniqueAirport()];
    const budget = track(
      testEnv.PROVIDER_BUDGET.getByName(`aerodatabox:${day}`, { locationHint: 'enam' }),
    );
    await runInDurableObject(budget, (instance: ProviderBudget) => {
      instance.clock = () => now;
    });
    await budget.configure({ dailyUnitCap: 60, perSecondLimit: 1_000 });
    const reserve = (airportIcao: string, trigger: 'board' | 'route_search'): BudgetRequest => ({
      provider: 'aerodatabox',
      operation: 'fids',
      pollEquivalents: 0.1,
      trigger,
      airportIcao,
      utcDate: day,
    });
    for (const request of [
      reserve(kept, 'board'),
      reserve(kept, 'board'),
      reserve(alsoKept, 'route_search'),
    ]) {
      expect((await budget.reserve(request)).allowed).toBe(true);
    }
    await recordCall('board', 'ok', kept, now - 10 * MINUTE_MS);
    await recordCall('board', 'ok', kept, now - 5 * MINUTE_MS);
    await recordCall('route_search', 'ok', alsoKept, now - 30 * MINUTE_MS);
    await recordCall('board', 'error', kept, now - 20 * MINUTE_MS);
    await recordCall('board', 'ok', earlier, now - 2 * HOUR_MS);
    await recordCall('alarm', 'ok', null, now - MINUTE_MS, 'flight_status');

    const html = await boardsSection(testEnv, db(), { now: () => now });

    expect(html).toContain(`AeroDataBox day ${day}`);
    // Three FIDS reservations of 2 units against 35 percent of 60.
    expect(html).toContain(
      '<td>Boards share of the AeroDataBox day (board, route_search)</td><td>6 units</td><td>21 units</td><td>28.6%</td><td>normal ladder</td>',
    );
    expect(html).toContain(
      `<td>Distinct airports refreshed this UTC hour</td><td>2</td><td>60</td><td>3.3%</td><td>${kept} ${alsoKept}</td>`,
    );
    expect(html).toContain(`<td>${kept}</td><td>2</td>`);
    expect(html).toContain(`<td>${alsoKept}</td><td>1</td>`);
    expect(html).not.toContain(`<td>${earlier}</td>`);
    expect(html).toContain('<td>board</td><td>error</td><td>1</td><td>2</td>');
    expect(html).toContain('<td>board</td><td>ok</td><td>3</td><td>6</td>');
    expect(html).toContain('<td>route_search</td><td>ok</td><td>1</td><td>2</td>');
    expect(html).not.toContain('<td>alarm</td>');
    expect(html).not.toContain('class="unavailable"');
  });

  it('names the degrade step of the share spent (ruling B5)', () => {
    expect(degradeStep(0.69)).toBe('normal ladder');
    expect(degradeStep(0.7)).toBe('ladder times 2');
    expect(degradeStep(0.95)).toBe('ladder times 4');
    expect(degradeStep(1)).toBe('stale copies only (share spent)');
  });

  it('shows a failed read as unavailable without hiding the others', async () => {
    const html = await boardsSection(testEnv, db(), {
      now: () => Date.parse(`${uniqueDay()}T12:00:00Z`),
      budgetFor: () => ({ snapshot: () => Promise.reject(new Error('down')) }),
    });
    expect(html.match(/class="unavailable"/g)).toHaveLength(1);
    expect(html).toContain('Airports kept live');
    expect(html).toContain('Board and route-search calls today');
  });
});
