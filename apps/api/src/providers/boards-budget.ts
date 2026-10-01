/**
 * The limits only the `board` and `route_search` triggers meet (increment 18), as pure decisions
 * the ProviderBudget object takes inside its reservation transaction: the boards share and the
 * hourly airport cap (ruling B5), and the rate floor (ruling R2). A tracker's reservation never
 * meets them, but it does share the per-second token bucket with board calls, and the floor is
 * what keeps board traffic from spending the burst that clustered tracker alarms need:
 *
 *   - The share: `board` and `route_search` together may spend `ADB_BOARDS_SHARE` (35 percent)
 *     of the day's unit cap. A reservation that would pass it is refused with `boards_share`.
 *     Every board decision reports the share spent, from which `AirportState` degrades its
 *     freshness ladder (70, 90 and 100 percent, `BOARD_DEGRADE_STEPS` in shared).
 *   - The airports: at most `ADB_BOARD_AIRPORTS_PER_HOUR` distinct airports refreshed per UTC
 *     hour, all airports together, keyed by the airport the request names. A refresh of an
 *     airport already counted in the hour is free against the cap; a new one past the cap is
 *     refused with `board_airports_per_hour`. A board reservation that names no airport is
 *     refused (`routing_rule`): an uncounted board call is exactly what the cap exists to stop.
 *     The free `health` call (the coverage check) is no refresh: the object skips the share and
 *     the cap for it (ruling R5), so zero-cost checks alone can never fill the hour's cap.
 *   - The rate floor: a board call, the `health` one included, takes a token only while the
 *     bucket keeps `boardTokenFloor` more; otherwise it is refused with `board_rate_floor` and the
 *     wait until it would pass (`take`'s `keep` in `token-bucket.ts`, whose module comment says
 *     why the burst matters).
 */

import { BOARD_CALL_TRIGGERS, ICAO_AIRPORT_RE, type BudgetRequest } from '@planeahead/shared';
import { ADB_BOARDS_SHARE, ADB_BOARD_AIRPORTS_PER_HOUR } from './config';
import type { TokenBucketConfig } from './token-bucket';

const BOARD_TRIGGERS: ReadonlySet<string> = new Set(BOARD_CALL_TRIGGERS);

/** Whether a reservation is a board or route-search call, the only ones these limits govern. */
export function isBoardTrigger(trigger: string): boolean {
  return BOARD_TRIGGERS.has(trigger);
}

/**
 * The tokens a board call must leave in the bucket for the trackers: half the burst, rounded
 * down. Per plan: Starter (5 a second, burst 2) keeps 1, Growth (10, burst 5) keeps 2, Scale
 * (20, burst 10) keeps 5. Read from the bucket rather than the plan, so a per-second limit an
 * admin sets keeps a floor that fits it (a burst of 1 keeps none).
 */
export function boardTokenFloor(bucket: TokenBucketConfig): number {
  return Math.floor(bucket.burst / 2);
}

/** The boards share of a daily cap, in provider units. */
export function boardsCapUnits(dailyUnitCap: number): number {
  return Math.floor(Math.max(0, dailyUnitCap) * ADB_BOARDS_SHARE);
}

/** The share spent, 0 to 1 (a zero cap reads as spent). */
export function boardsShareSpent(spentUnits: number, capUnits: number): number {
  return capUnits > 0 ? Math.min(1, Math.max(0, spentUnits / capUnits)) : 1;
}

/** What the decision reads from the day's ledger. */
export interface BoardsLedger {
  /** Units the `board` and `route_search` rows have spent today. */
  readonly spentUnits: number;
  /** Whether the airport is already counted in the hour. */
  counted(hourUtc: number, airportIcao: string): boolean;
  /** Distinct airports counted in the hour. */
  airportsIn(hourUtc: number): number;
}

export type BoardsCheck =
  | {
      readonly allowed: true;
      /** The share spent once this reservation is debited. */
      readonly shareAfter: number;
      readonly hourUtc: number;
      readonly airportIcao: string;
      /** False when the airport is new to the hour: the caller records it with the debit. */
      readonly counted: boolean;
    }
  | {
      readonly allowed: false;
      readonly reason: 'boards_share' | 'board_airports_per_hour' | 'routing_rule';
      readonly shareSpent: number;
    };

export function checkBoards(
  request: Pick<BudgetRequest, 'airportIcao'>,
  units: number,
  dailyUnitCap: number,
  nowMs: number,
  ledger: BoardsLedger,
  airportsPerHour: number = ADB_BOARD_AIRPORTS_PER_HOUR,
): BoardsCheck {
  const capUnits = boardsCapUnits(dailyUnitCap);
  const shareSpent = boardsShareSpent(ledger.spentUnits, capUnits);
  if (ledger.spentUnits + units > capUnits) {
    return { allowed: false, reason: 'boards_share', shareSpent };
  }
  const airportIcao = request.airportIcao?.trim().toUpperCase();
  if (airportIcao === undefined || !ICAO_AIRPORT_RE.test(airportIcao)) {
    return { allowed: false, reason: 'routing_rule', shareSpent };
  }
  const hourUtc = new Date(nowMs).getUTCHours();
  const counted = ledger.counted(hourUtc, airportIcao);
  if (!counted && ledger.airportsIn(hourUtc) >= airportsPerHour) {
    return { allowed: false, reason: 'board_airports_per_hour', shareSpent };
  }
  return {
    allowed: true,
    shareAfter: boardsShareSpent(ledger.spentUnits + units, capUnits),
    hourUtc,
    airportIcao,
    counted,
  };
}
