/**
 * Ruling B7 (increment 18; R3 D7, D8, D13): what the Worker makes of a bucket's cached rows.
 * Nothing here enters a cache key, and nothing here reads a clock or the network.
 *
 *   - Each flight once (ruling R12): a row repeating the direction, designator and scheduled
 *     minute of an earlier one (one flight in two buckets) is dropped first, so row ids are unique.
 *   - Codeshares are grouped server-side: rows of one direction with the same scheduled UTC
 *     minute, the same counterpart airport and the same registration or the same callsign are one
 *     operated flight. A row with neither key that the provider marks `IsCodeshared` joins the
 *     only `IsOperator` row of its direction, minute and counterpart (R12: days ahead the aircraft
 *     is rarely known); with none there, or several, it stays alone (R3 D7's trade-off: a wrong
 *     merge hides a flight, a missed one only repeats it). The `IsOperator` row is primary (else
 *     the row whose marketing carrier operates it, else the provider's first); the others become
 *     `codeshares[]`.
 *   - Filters run after grouping: the direction, the time range `[from, to)` (a flight is in it by
 *     its home leg's scheduled time or its best time, and an earlier one stays while it has not
 *     yet departed or arrived, ruling R14), and an airline matched against the operating carrier
 *     or any marketing carrier of the group, by IATA or ICAO code.
 *   - Rows leave as `BoardViewRow`, never as provider JSON, and every answer carries an ETag.
 */

import type { BoardBucketResponseV1, BoardRow, BoardViewRow } from '@planeahead/shared';

/** One operated flight: its primary row and the codeshare rows grouped under it. */
export interface BoardGroup {
  readonly primary: BoardRow;
  readonly others: readonly BoardRow[];
}

/** The UTC minute a row is scheduled at (FIDS times are minutes), however it is spelled. */
function minuteOf(row: BoardRow): number {
  return Math.floor(Date.parse(row.scheduled) / 60_000);
}

/** Where a flight sits on the board: its direction, scheduled minute and counterpart. */
function slotOf(row: BoardRow): string {
  return `${row.direction}|${String(minuteOf(row))}|${row.counterpart.icao}`;
}

function groupKeys(row: BoardRow): string[] {
  const slot = slotOf(row);
  const keys: string[] = [];
  if (row.registration !== undefined && row.registration !== '') {
    keys.push(`${slot}|reg|${row.registration}`);
  }
  if (row.callSign !== undefined && row.callSign !== '') {
    keys.push(`${slot}|cs|${row.callSign}`);
  }
  return keys;
}

/** The rows with each (direction, designator, scheduled minute) once, the first copy kept. */
function uniqueRows(rows: readonly BoardRow[]): BoardRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.direction}|${row.designator}|${String(minuteOf(row))}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function primaryOf(members: readonly BoardRow[]): BoardRow {
  return (
    members.find((row) => row.codeshareStatus === 'IsOperator') ??
    members.find(
      (row) =>
        row.operatingCarrierIcao !== undefined &&
        row.marketingCarrierIcao === row.operatingCarrierIcao,
    ) ??
    (members[0] as BoardRow)
  );
}

/** The rows, each flight once, grouped into operated flights in the order each first appears. */
export function groupCodeshares(rows: readonly BoardRow[]): BoardGroup[] {
  const unique = uniqueRows(rows);
  const parent = unique.map((_row, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) {
      root = parent[root] ?? root;
    }
    parent[index] = root;
    return root;
  };
  const join = (first: number, other: number): void => {
    const [a, b] = [find(first), find(other)];
    parent[Math.max(a, b)] = Math.min(a, b);
  };
  const firstByKey = new Map<string, number>();
  const operatorsBySlot = new Map<string, number[]>();
  unique.forEach((row, index) => {
    for (const key of groupKeys(row)) {
      const first = firstByKey.get(key);
      if (first === undefined) {
        firstByKey.set(key, index);
      } else {
        join(first, index);
      }
    }
    if (row.codeshareStatus === 'IsOperator') {
      const slot = slotOf(row);
      operatorsBySlot.set(slot, [...(operatorsBySlot.get(slot) ?? []), index]);
    }
  });
  unique.forEach((row, index) => {
    if (row.codeshareStatus === 'IsCodeshared' && groupKeys(row).length === 0) {
      const operators = operatorsBySlot.get(slotOf(row)) ?? [];
      const [only] = operators;
      if (operators.length === 1 && only !== undefined) {
        join(only, index);
      }
    }
  });
  const byRoot = new Map<number, BoardRow[]>();
  unique.forEach((row, index) => {
    const root = find(index);
    byRoot.set(root, [...(byRoot.get(root) ?? []), row]);
  });
  return [...byRoot.values()].map((members) => {
    const primary = primaryOf(members);
    return { primary, others: members.filter((row) => row !== primary) };
  });
}

export interface BoardFilter {
  readonly direction: BoardRow['direction'];
  /** The window, `[fromMs, toMs)`; `inWindow` says which flights it holds. */
  readonly fromMs: number;
  readonly toMs: number;
  /** A carrier code, IATA (2) or ICAO (3), upper case; absent for every airline. */
  readonly airline?: string | undefined;
}

function flownBy(group: BoardGroup, airline: string): boolean {
  return [group.primary, ...group.others].some(
    (row) =>
      row.operatingCarrierIcao === airline ||
      row.marketingCarrierIcao === airline ||
      row.marketingCarrierIata === airline,
  );
}

/** The statuses short of the home movement: not yet departed, or not yet arrived. */
const BEFORE_HOME_MOVEMENT: Readonly<
  Record<BoardRow['direction'], ReadonlySet<BoardRow['status']>>
> = {
  dep: new Set(['scheduled', 'boarding']),
  arr: new Set(['scheduled', 'boarding', 'departed', 'en_route']),
};

/**
 * Whether the provider's live data says a flight has not yet made its home movement: no actual
 * time, a status short of it, and something live behind that status, an estimate or (for an
 * arrival) its departure from the origin. A row with only its timetable says nothing either way:
 * a schedules-only airport's rows read `boarding` from the schedule alone.
 */
function notYetMoved(row: BoardRow): boolean {
  if (row.actual !== undefined || !BEFORE_HOME_MOVEMENT[row.direction].has(row.status)) {
    return false;
  }
  return row.estimated !== undefined || row.status === 'departed' || row.status === 'en_route';
}

/**
 * Whether a flight is in the window (ruling R14): by its home leg's scheduled time, by its best
 * time (actual, else estimated), or, scheduled before the window, while it has not yet departed
 * or arrived (a delayed flight stays on the board). Only the buckets already read are searched.
 */
function inWindow(row: BoardRow, filter: BoardFilter): boolean {
  const within = (at: number): boolean => at >= filter.fromMs && at < filter.toMs;
  const scheduled = Date.parse(row.scheduled);
  const best = row.actual ?? row.estimated;
  return (
    within(scheduled) ||
    (best !== undefined && within(Date.parse(best))) ||
    (scheduled < filter.fromMs && notYetMoved(row))
  );
}

/** The groups the filter keeps, by scheduled time, then designator. */
export function filterGroups(groups: readonly BoardGroup[], filter: BoardFilter): BoardGroup[] {
  return groups
    .filter(
      (group) =>
        group.primary.direction === filter.direction &&
        inWindow(group.primary, filter) &&
        (filter.airline === undefined || flownBy(group, filter.airline)),
    )
    .sort(
      (a, b) =>
        Date.parse(a.primary.scheduled) - Date.parse(b.primary.scheduled) ||
        a.primary.designator.localeCompare(b.primary.designator),
    );
}

/** `{ [key]: value }` when the value is present, else nothing: optional fields stay absent. */
function present<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/** The UI row of a group at the board of `homeIcao`. */
export function boardViewRow(group: BoardGroup, homeIcao: string): BoardViewRow {
  const row = group.primary;
  const codeshares = [
    ...new Set(group.others.map((other) => other.designator).filter((d) => d !== row.designator)),
  ];
  const date = row.scheduledDepartureDateLocal;
  const origin = row.direction === 'dep' ? homeIcao : row.counterpart.icao;
  return {
    id: `${row.direction}:${row.designator}:${row.scheduled}`,
    designator: row.designator,
    ...present('airlineIata', row.marketingCarrierIata),
    ...present('airlineIcao', row.marketingCarrierIcao),
    ...present('operatingCarrierIcao', row.operatingCarrierIcao),
    operatingFlightNumber: row.flightNumber,
    codeshares,
    counterpart: { icao: row.counterpart.icao, ...present('iata', row.counterpart.iata) },
    status: row.status,
    scheduled: row.scheduled,
    ...present('estimated', row.estimated),
    ...present('actual', row.actual),
    ...present('terminal', row.terminal),
    ...present('gate', row.gate),
    ...present('baggageClaim', row.baggageClaim),
    ...present('counterpartScheduled', row.counterpartScheduled),
    ...present('counterpartEstimated', row.counterpartEstimated),
    ...present('counterpartActual', row.counterpartActual),
    ...present('counterpartTerminal', row.counterpartTerminal),
    ...present('counterpartGate', row.counterpartGate),
    ...present('aircraftModel', row.aircraftModel),
    ...(date === undefined ? {} : { add: { number: row.designator, date, origin } }),
  };
}

/** What the routes make of the buckets a request read (one to three of them). */
export type CombinedBuckets =
  | {
      readonly kind: 'ok';
      readonly rows: readonly BoardRow[];
      readonly coverage: 'live' | 'schedules_only' | 'unknown';
      readonly fetchedAt: string | null;
      readonly stale: boolean;
      readonly partial: boolean;
    }
  | { readonly kind: 'not_covered' | 'unavailable' | 'out_of_range' };

/**
 * The buckets as one answer. Coverage is per airport, so one `not_covered` bucket makes the
 * whole answer `not_covered`. With no bucket readable: `out_of_range` when every bucket is out
 * of range (never fetched: ended over 24 h ago or past the lookahead), else `unavailable`. With
 * some readable: their rows, the oldest `fetchedAt`, stale if any is, and `partial` when one
 * could not be read (`unavailable`: its fetch failed or was refused, or the Worker's read failed
 * or timed out; a state this build does not know counts the same). Never for a bucket out of
 * range, which no refresh can fill, so a range past the lookahead is not partial (R10, R15).
 * One `schedules_only` bucket makes the answer `schedules_only` (the badge).
 */
export function combineBuckets(answers: readonly BoardBucketResponseV1[]): CombinedBuckets {
  if (answers.some((answer) => answer.state === 'not_covered')) {
    return { kind: 'not_covered' };
  }
  const ok = answers.filter((answer) => answer.state === 'ok');
  if (ok.length === 0) {
    const allOut = answers.every((answer) => answer.state === 'out_of_range');
    return { kind: allOut && answers.length > 0 ? 'out_of_range' : 'unavailable' };
  }
  const fetched = ok
    .map((answer) => answer.fetchedAt)
    .filter((at): at is string => at !== undefined)
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  const coverages = ok.map((answer) => answer.coverage);
  return {
    kind: 'ok',
    rows: ok.flatMap((answer) => answer.rows),
    coverage: coverages.includes('schedules_only')
      ? 'schedules_only'
      : coverages.every((coverage) => coverage === 'live')
        ? 'live'
        : 'unknown',
    fetchedAt: fetched[0] ?? null,
    stale: ok.some((answer) => answer.stale),
    partial: answers.some((answer) => answer.state !== 'ok' && answer.state !== 'out_of_range'),
  };
}

/**
 * The ETag of an answer: a SHA-256 of its JSON, weak (`W/`) because Cloudflare may compress the
 * body on the way out. The body carries `fetchedAt`, `stale` and the window, so a refreshed
 * bucket, a copy turning stale or another window is another tag.
 */
export async function boardEtag(body: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(body)),
  );
  const bytes = new Uint8Array(digest).slice(0, 16);
  const base64 = btoa(String.fromCharCode(...bytes));
  return `W/"${base64.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}"`;
}

/** Whether `If-None-Match` names `etag` (weak comparison, RFC 9110 section 13.1.2), or is `*`. */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (ifNoneMatch === undefined) {
    return false;
  }
  const opaque = (tag: string): string => tag.trim().replace(/^W\//, '');
  const wanted = opaque(etag);
  return ifNoneMatch.split(',').some((tag) => tag.trim() === '*' || opaque(tag) === wanted);
}
