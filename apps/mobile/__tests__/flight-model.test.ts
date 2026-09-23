/**
 * What the home and detail screens derive from a subscription row (src/lib/flight-model.ts and
 * src/lib/timeline.ts), on rows the real page apply wrote: the next flight by scheduled departure
 * (the first not arrived, cancelled or finished), the rest of the list, the countdown's target,
 * and the timeline from the snapshot's out, off, on and in.
 */

import { listFlights } from '../src/lib/flight-queries';
import {
  countdownFor,
  designatorSpellings,
  displayDesignator,
  isOver,
  LANDED_GRACE_MS,
  operatedAs,
  operatedAsPhrase,
  OVER_AFTER_ARRIVAL_MS,
  pendingFlightKey,
  pendingMatchesLive,
  selectHome,
  type FlightItem,
} from '../src/lib/flight-model';
import { addFlight } from '../src/lib/flights';
import { toFlightItem as toFlightItemRow } from '../src/lib/flight-model';
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

  it("shows the operating designator, never the shared snapshot's marketing one", () => {
    // BAW 1511 is what the FIRST searcher of this flight typed; every subscriber shares the
    // snapshot, so it names nobody's add in particular (increment 10 review).
    const { items } = seeded({ marketingCarrierIcao: 'BAW', marketingFlightNumber: '1511' });
    expect(byId(items, AA100_ID)).toMatchObject({
      designator: 'AA100',
      operatingDesignator: 'AA100',
    });
    expect(operatedAs(byId(items, AA100_ID))).toBeNull();
    expect(displayDesignator('XYZ', '12')).toBe('XYZ12');
  });

  it('shows the designator typed on this phone, with the operating one beside it', () => {
    const { db } = seeded();
    db.run("UPDATE flight_subscriptions SET added_as = 'BA1511' WHERE id = ?", [AA100_ID]);
    const item = byId(listFlights(db), AA100_ID);
    expect(item).toMatchObject({ designator: 'BA1511', operatingDesignator: 'AA100' });
    expect(operatedAs(item)).toBe('Operated as AA100');
    // Mid-sentence the designator keeps its case (ruling Y2).
    expect(operatedAsPhrase(item)).toBe('operated as AA100');
  });

  it('never says an ICAO spelling of the flight is operated as itself (ruling Y4)', () => {
    const { db } = seeded();
    db.run("UPDATE flight_subscriptions SET added_as = 'AAL100' WHERE id = ?", [AA100_ID]);
    const item = byId(listFlights(db), AA100_ID);
    expect(item).toMatchObject({ designator: 'AAL100', operatingDesignator: 'AA100' });
    expect(operatedAs(item)).toBeNull();
    expect(operatedAsPhrase(item)).toBeNull();
    // Another number of the same carrier is another flight, still shown.
    expect(operatedAs({ ...item, designator: 'AAL6139' })).toBe('Operated as AA100');
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
    expect(selectHome([], NOW)).toEqual({ next: null, hero: null, rest: [] });
  });

  it('fills the top slot with the oldest pending add when nothing live is ahead', () => {
    const db = createMemorySqlite();
    addFlight(db, { designator: 'UA901', date: '2026-09-24' }, { newId: () => PENDING_ID });
    const { next, hero, rest } = selectHome(listFlights(db), NOW);
    expect(next).toBeNull();
    expect(hero).toMatchObject({ id: PENDING_ID, pending: true });
    expect(rest).toEqual([]);
  });

  it('keeps the top slot empty when only past flights remain (they stay in the list)', () => {
    const { db } = seeded({ status: 'cancelled' });
    db.run('DELETE FROM flight_subscriptions WHERE id = ?', [BA117_ID]);
    const { hero, rest } = selectHome(listFlights(db), NOW);
    expect(hero).toBeNull();
    expect(rest.map((item) => item.id)).toEqual([AA100_ID, DL1_ID]);
  });
});

describe('selectHome: a landed flight and its connection (increment 10 review)', () => {
  // AA100 landed at 06:00Z (no gate arrival yet); the connection, BA117, is rescheduled below.
  const LANDED = {
    status: 'landed',
    times: {
      scheduledOut: '2026-09-23T22:00:00Z',
      actualOut: '2026-09-23T22:20:00Z',
      scheduledIn: '2026-09-24T06:10:00Z',
      estimatedIn: '2026-09-24T06:15:00Z',
      actualOn: '2026-09-24T06:00:00Z',
    },
  };
  const ARRIVAL = Date.parse('2026-09-24T06:15:00Z');

  function withConnection(connectionOut: string) {
    const { db } = seeded(LANDED);
    db.run('UPDATE flight_subscriptions SET scheduled_out = ?, estimated_out = NULL WHERE id = ?', [
      connectionOut,
      BA117_ID,
    ]);
    return listFlights(db);
  }

  it('stays next through the gate walk while nothing departs sooner', () => {
    const items = withConnection('2026-09-24T09:00:00Z');
    expect(selectHome(items, ARRIVAL + 10 * 60_000).next?.id).toBe(AA100_ID);
  });

  it('hands over 30 minutes after its best arrival, and stays in the list', () => {
    const items = withConnection('2026-09-24T09:00:00Z');
    const { next, rest } = selectHome(items, ARRIVAL + LANDED_GRACE_MS + 60_000);
    expect(next?.id).toBe(BA117_ID);
    expect(countdownFor(next as FlightItem, ARRIVAL + LANDED_GRACE_MS + 60_000)).toEqual({
      kind: 'departs',
      at: '2026-09-24T09:00:00Z',
    });
    expect(rest.map((item) => item.id)).toEqual([AA100_ID, DL1_ID]);
  });

  it('hands over at once to a connection that departs before the grace ends', () => {
    const items = withConnection('2026-09-24T06:40:00Z');
    const { next, rest } = selectHome(items, ARRIVAL + 5 * 60_000);
    expect(next?.id).toBe(BA117_ID);
    expect(rest.map((item) => item.id)).toContain(AA100_ID);
  });
});

describe('pending adds against live rows (ruling X7)', () => {
  it('reads AA100 and AAL100 as the same designator', () => {
    expect(designatorSpellings('AA100').sort()).toEqual(['AA100', 'AAL100']);
    expect(designatorSpellings('AAL100').sort()).toEqual(['AA100', 'AAL100']);
    expect(designatorSpellings('U21234').sort()).toEqual(['EZY1234', 'U21234']);
    // A carrier the offline table does not know keeps its one spelling.
    expect(designatorSpellings('ZZ100')).toEqual(['ZZ100']);
  });

  it('matches by designator and date: the operating one, a codeshare, the one typed here', () => {
    // Queued before this store knew AA100 (a known codeshare is answered locally, ruling Y3).
    const db = createMemorySqlite();
    addFlight(db, { designator: 'BA1511', date: '2026-09-23' }, { newId: () => PENDING_ID });
    seedStore(db);
    const all = db.all<Parameters<typeof toFlightItemRow>[0]>('SELECT * FROM flight_subscriptions');
    const items = all.map(toFlightItemRow);
    const pending = byId(items, PENDING_ID);
    // BA1511 is AA100's codeshare on the same date.
    expect(pendingMatchesLive(pending, byId(items, AA100_ID))).toBe(true);
    expect(pendingMatchesLive(pending, byId(items, BA117_ID))).toBe(false);
    // Another date never matches.
    expect(pendingMatchesLive({ ...pending, dateLocal: '2026-09-24' }, byId(items, AA100_ID))).toBe(
      false,
    );
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
