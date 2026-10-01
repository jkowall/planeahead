/**
 * Ruling B7 (increment 18; R3 D7, D8, D13): what the Worker makes of a bucket's cached rows.
 * Nothing here enters a cache key, and nothing here reads a clock or the network.
 *
 *   - Codeshares are grouped server-side: rows of one direction with the same scheduled UTC
 *     time, the same counterpart airport and the same registration or the same callsign are one
 *     operated flight. The `IsOperator` row is primary (else the row whose marketing carrier
 *     operates it, else the provider's first); the others become `codeshares[]`. Rows with
 *     neither a registration nor a callsign are never merged (R3 D7's trade-off: a wrong merge
 *     hides a flight, a missed one only repeats it).
 *   - Filters run after grouping: the direction, the time range `[from, to)` on the home leg's
 *     scheduled time, and an airline matched against the operating carrier or any marketing
 *     carrier of the group, by IATA or ICAO code.
 *   - Rows leave as `BoardViewRow`, never as provider JSON, and every answer carries an ETag.
 */

import type { BoardBucketResponseV1, BoardRow, BoardViewRow } from '@planeahead/shared';

/** One operated flight: its primary row and the codeshare rows grouped under it. */
export interface BoardGroup {
  readonly primary: BoardRow;
  readonly others: readonly BoardRow[];
}

function groupKeys(row: BoardRow): string[] {
  const base = `${row.direction}|${String(Date.parse(row.scheduled))}|${row.counterpart.icao}`;
  const keys: string[] = [];
  if (row.registration !== undefined && row.registration !== '') {
    keys.push(`${base}|reg|${row.registration}`);
  }
  if (row.callSign !== undefined && row.callSign !== '') {
    keys.push(`${base}|cs|${row.callSign}`);
  }
  return keys;
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

/** The rows grouped into operated flights, in the order each flight first appears. */
export function groupCodeshares(rows: readonly BoardRow[]): BoardGroup[] {
  const parent = rows.map((_row, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) {
      root = parent[root] ?? root;
    }
    parent[index] = root;
    return root;
  };
  const firstByKey = new Map<string, number>();
  rows.forEach((row, index) => {
    for (const key of groupKeys(row)) {
      const first = firstByKey.get(key);
      if (first === undefined) {
        firstByKey.set(key, index);
        continue;
      }
      const [a, b] = [find(first), find(index)];
      parent[Math.max(a, b)] = Math.min(a, b);
    }
  });
  const byRoot = new Map<number, BoardRow[]>();
  rows.forEach((row, index) => {
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
  /** The window on the home leg's scheduled time, `[fromMs, toMs)`. */
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

/** The groups the filter keeps, by scheduled time, then designator. */
export function filterGroups(groups: readonly BoardGroup[], filter: BoardFilter): BoardGroup[] {
  return groups
    .filter((group) => {
      const at = Date.parse(group.primary.scheduled);
      return (
        group.primary.direction === filter.direction &&
        at >= filter.fromMs &&
        at < filter.toMs &&
        (filter.airline === undefined || flownBy(group, filter.airline))
      );
    })
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
 * some readable: their rows, the oldest `fetchedAt`, stale if any is, and `partial` when one is
 * missing. One `schedules_only` bucket makes the answer `schedules_only` (the badge).
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
    partial: ok.length < answers.length,
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
