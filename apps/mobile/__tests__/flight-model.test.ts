/**
 * What the home and detail screens derive from a subscription row (src/lib/flight-model.ts and
 * src/lib/timeline.ts), on rows the real page apply wrote: the next flight by scheduled departure
 * (the first not arrived, cancelled or finished), the rest of the list, the countdown's target,
 * and the timeline from the snapshot's out, off, on and in.
 */

import { listFlights } from '../src/lib/flight-queries';
import {
  countdownFor,
  displayDesignator,
  isOver,
  OVER_AFTER_ARRIVAL_MS,
  pendingFlightKey,
  selectHome,
  type FlightItem,
} from '../src/lib/flight-model';
import { addFlight } from '../src/lib/flights';
import { buildTimeline, terminalAndGate } from '../src/lib/timeline';
import { createMemorySqlite } from './support/memory-sqlite';
import {
  AA100_ID,
  AA100_KEY,
  BA117_ID,
  DL1_ID,
  NOW,
  aa100Snapshot,
  seedStore,
} from './support/flight-fixtures';

const PENDING_ID = '0199b000-0000-7000-8000-000000000901';

function seeded(aa100: Record<string, unknown> = {}) {
  const db = createMemorySqlite();
  seedStore(db, aa100);
  return { db, items: listFlights(db) };
}

function byId(items: readonly FlightItem[], id: string): FlightItem {
  const found = items.find((item) => item.id === id);
  if (found === undefined) {
    throw new Error(`no item ${id}`);
  }
  return found;
}

describe('toFlightItem', () => {
  it('reads the denormalised snapshot and the key into what the screens show', () => {
    const { items } = seeded();
    const aa100 = byId(items, AA100_ID);
    expect(aa100).toMatchObject({
      pending: false,
      designator: 'AA100',
      dateLocal: '2026-09-23',
      status: 'scheduled',
      origin: { code: 'JFK', tz: 'America/New_York', terminal: '8', gate: 'B22' },
      destination: { code: 'LHR', tz: 'Europe/London', terminal: '3', gate: null },
      scheduledOut: '2026-09-23T22:00:00Z',
      estimatedOut: '2026-09-23T22:25:00Z',
      departureDelaySec: 1500,
      snapshotSource: 'aerodatabox',
    });
    expect(aa100.snapshot?.times.scheduledOff).toBe('2026-09-23T22:20:00Z');
  });

  it('prefers the marketing designator, and falls back to the ICAO code', () => {
    const { items } = seeded({ marketingCarrierIcao: 'BAW', marketingFlightNumber: '1511' });
    expect(byId(items, AA100_ID).designator).toBe('BA1511');
    expect(displayDesignator('XYZ', '12')).toBe('XYZ12');
  });

  it('reads a pending row from its placeholder key', () => {
    const { db } = seeded();
    addFlight(db, { designator: 'UA901', date: '2026-09-24' }, { newId: () => PENDING_ID });
    const item = byId(listFlights(db), PENDING_ID);
    expect(item.flightKey).toBe(pendingFlightKey('UA901', '2026-09-24'));
    expect(item).toMatchObject({ pending: true, designator: 'UA901', dateLocal: '2026-09-24' });
    expect(item.status).toBeNull();
    expect(item.snapshot).toBeNull();
  });

  it('reads a status this build does not know as unknown', () => {
    const { db } = seeded();
    db.run("UPDATE flight_subscriptions SET flight_status = 'taxiing' WHERE id = ?", [AA100_ID]);
    expect(byId(listFlights(db), AA100_ID).status).toBe('unknown');
  });
});

describe('selectHome', () => {
  it('puts the first flight not yet over first, then the rest, past flights last', () => {
    const { items } = seeded();
    const { next, rest } = selectHome(items, NOW);
    expect(next?.id).toBe(AA100_ID);
    expect(rest.map((item) => item.id)).toEqual([BA117_ID, DL1_ID]);
  });

  it('skips arrived, cancelled and finished flights for the next flight', () => {
    const cancelled = seeded({ status: 'cancelled' });
    expect(selectHome(cancelled.items, NOW).next?.id).toBe(BA117_ID);

    const finished = seeded();
    finished.db.run('UPDATE flight_subscriptions SET finished_at = ? WHERE id = ?', [
      '2026-09-23T13:00:00Z',
      AA100_ID,
    ]);
    expect(selectHome(listFlights(finished.db), NOW).next?.id).toBe(BA117_ID);
  });

  it('keeps a flight in the air as the next flight', () => {
    const { items } = seeded({ status: 'en_route' });
    expect(selectHome(items, Date.parse('2026-09-24T01:00:00Z')).next?.id).toBe(AA100_ID);
  });

  it('lists pending adds before the upcoming flights and never makes one the next flight', () => {
    const { db } = seeded();
    addFlight(db, { designator: 'UA901', date: '2026-09-22' }, { newId: () => PENDING_ID });
    const { next, rest } = selectHome(listFlights(db), NOW);
    expect(next?.id).toBe(AA100_ID);
    expect(rest.map((item) => item.id)).toEqual([PENDING_ID, BA117_ID, DL1_ID]);
  });

  it('answers no next flight for an empty list', () => {
    expect(selectHome([], NOW)).toEqual({ next: null, rest: [] });
  });
});

describe('isOver and countdownFor', () => {
  it('counts down to the estimated departure, then to the arrival once it has left', () => {
    const { items } = seeded();
    const aa100 = byId(items, AA100_ID);
    expect(countdownFor(aa100, NOW)).toEqual({ kind: 'departs', at: '2026-09-23T22:25:00Z' });

    const airborne = byId(seeded({ status: 'en_route' }).items, AA100_ID);
    expect(countdownFor(airborne, Date.parse('2026-09-24T01:00:00Z'))).toEqual({
      kind: 'arrives',
      at: '2026-09-24T06:10:00Z',
    });
    expect(countdownFor(byId(items, DL1_ID), NOW)).toBeNull();
  });

  it('treats a flight long past its arrival as over even without an arrival report', () => {
    const { items } = seeded({ status: 'en_route' });
    const aa100 = byId(items, AA100_ID);
    const arrival = Date.parse('2026-09-24T06:10:00Z');
    expect(isOver(aa100, arrival + OVER_AFTER_ARRIVAL_MS - 1)).toBe(false);
    expect(isOver(aa100, arrival + OVER_AFTER_ARRIVAL_MS + 1)).toBe(true);
  });
});

describe('buildTimeline', () => {
  it('builds out, off, on, in from the snapshot with the gates and the state of each step', () => {
    const { items } = seeded();
    const steps = buildTimeline(byId(items, AA100_ID));
    expect(steps.map((step) => [step.key, step.state])).toEqual([
      ['out', 'next'],
      ['off', 'upcoming'],
      ['on', 'upcoming'],
      ['in', 'upcoming'],
    ]);
    expect(steps[0]).toMatchObject({
      title: 'Gate departure',
      scheduled: '2026-09-23T22:00:00Z',
      estimated: '2026-09-23T22:25:00Z',
      actual: null,
      timeZone: 'America/New_York',
      place: 'Terminal 8, gate B22',
      deltaMinutes: 25,
    });
    expect(steps[3]).toMatchObject({ timeZone: 'Europe/London', place: 'Terminal 3' });
  });

  it('marks the steps a status has passed as done, adds the baggage claim, drops empty off and on', () => {
    const { items } = seeded();
    const steps = buildTimeline(byId(items, DL1_ID));
    expect(steps.map((step) => [step.key, step.state])).toEqual([
      ['out', 'done'],
      ['in', 'done'],
      ['baggage', 'done'],
    ]);
    expect(steps[1]).toMatchObject({ actual: '2026-09-22T16:41:00Z', deltaMinutes: -9 });
    expect(steps[2]?.place).toBe('Baggage claim 4');
  });

  it('shows every step as cancelled for a cancelled flight', () => {
    const { items } = seeded({ status: 'cancelled' });
    expect(new Set(buildTimeline(byId(items, AA100_ID)).map((step) => step.state))).toEqual(
      new Set(['cancelled']),
    );
  });

  it('falls back to the row columns when the snapshot is unreadable', () => {
    const { db } = seeded();
    db.run("UPDATE flight_subscriptions SET snapshot_json = '{broken' WHERE id = ?", [AA100_ID]);
    const item = byId(listFlights(db), AA100_ID);
    expect(item.snapshot).toBeNull();
    expect(buildTimeline(item).map((step) => step.key)).toEqual(['out', 'in']);
  });

  it('names a terminal and a gate together or alone', () => {
    expect(terminalAndGate('8', 'B22')).toBe('Terminal 8, gate B22');
    expect(terminalAndGate(null, 'B22')).toBe('Gate B22');
    expect(terminalAndGate('5', null)).toBe('Terminal 5');
    expect(terminalAndGate(null, null)).toBeNull();
  });

  it('keys the seeded flight by its canonical key', () => {
    expect(aa100Snapshot()['key']).toBe(AA100_KEY);
  });
});
