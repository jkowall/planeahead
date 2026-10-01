/**
 * The boards share and the hourly airport cap (increment 18, ruling B5), as a pure decision the
 * ProviderBudget object takes inside its reservation transaction. Only the `board` and
 * `route_search` triggers reach it: a tracker's reservation never sees these limits.
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
 */

import { BOARD_CALL_TRIGGERS, ICAO_AIRPORT_RE, type BudgetRequest } from '@planeahead/shared';
import { ADB_BOARDS_SHARE, ADB_BOARD_AIRPORTS_PER_HOUR } from './config';

const BOARD_TRIGGERS: ReadonlySet<string> = new Set(BOARD_CALL_TRIGGERS);

/** Whether a reservation is a board or route-search call, the only ones these limits govern. */
export function isBoardTrigger(trigger: string): boolean {
  return BOARD_TRIGGERS.has(trigger);
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
