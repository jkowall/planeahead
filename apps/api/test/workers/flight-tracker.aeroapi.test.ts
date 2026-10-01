/**
 * The FlightTracker with `AEROAPI_MODE=live` and a fake AeroAPI (helpers/aeroapi.ts), the case
 * increment 15's review finding M3 found latent while every deployment runs in mock mode
 * (ruling Q11): a cancellation AeroAPI suspects is evidence, not state, so the tracker keeps its
 * operating phase and the cadence's AeroAPI window; the confirming re-read is an AeroAPI read by
 * designator, never AeroDataBox; only AeroAPI's own repeated answer confirms it, an alert merge
 * never does (Q11 (6)); nothing shows `cancelled` before the intent; and failing re-reads cost at
 * most the fast re-reads on top of the cadence.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { RPC_SCHEMA_VERSION } from '@planeahead/shared';
import { goLive, type FakeAeroApi } from './helpers/aeroapi';
import {
  HOUR_MS,
  MINUTE_MS,
  adbCalls,
  drainTouched,
  scriptAdb,
  uniqueFlight,
  type TestFlight,
} from './helpers/flights';
import {
  answer,
  captureKv,
  eventsOf,
  expectOnePayloadPerVersion,
  flightRow,
  instancesOf,
  intentsOf,
  kvSettled,
  nextAlarm,
  policyState,
  seeded,
} from './helpers/policy';

afterEach(drainTouched);

/** Created two hours before departure (AeroDataBox, through the resolver), then live. */
async function liveAt(flight: TestFlight, answers: Parameters<typeof goLive>[2]) {
  const tracker = await seeded(flight, flight.scheduledOut.getTime() - 2 * HOUR_MS);
  // AeroDataBox would clear the suspicion if it were asked: it says the flight operates.
  await scriptAdb(flight, [answer(flight, { phase: 'expected' })]);
  const fake = await goLive(tracker, flight, answers);
  return { tracker, fake };
}

/** Every AeroAPI request was a read by the searched designator (`AA123`), never by id. */
function expectDesignatorReads(fake: FakeAeroApi, flight: TestFlight, count: number): void {
  expect(fake.requests).toHaveLength(count);
  for (const url of fake.requests) {
    expect(url.pathname).toBe(`/aeroapi/flights/${flight.designator}`);
    expect(url.searchParams.get('ident_type')).toBe('designator');
  }
}

describe('Q11 in live mode: the raising provider re-reads, by designator', () => {
  it('re-reads a suspicion raised in an AeroAPI window through AeroAPI, never AeroDataBox', async () => {
    const flight = uniqueFlight();
    const { tracker, fake } = await liveAt(flight, [{ cancelled: true }]);
    const seen = await nextAlarm(tracker);
    expect(await policyState(tracker)).toMatchObject({
      cancellation: { status: 'suspect', provider: 'aeroapi', fastLeft: 3 },
    });
    expect((await flightRow(tracker))?.phase).toBe('scheduled');
    expect(eventsOf(tracker, 'cancel_suspect')).toMatchObject([{ source: 'aeroapi' }]);
    expect(await tracker.alarmAt()).toBe(seen + 5 * MINUTE_MS);
    await nextAlarm(tracker);
    expectDesignatorReads(fake, flight, 2);
    // The seed's read is the only AeroDataBox call.
    expect(await adbCalls(flight)).toBe(1);
    expect(intentsOf(tracker).map((m) => m.payload.intent.value)).toEqual(['cancelled']);
    expect(await flightRow(tracker)).toMatchObject({
      phase: 'finished',
      finish_reason: 'cancelled',
    });
  });
});

describe('Q11: AeroAPI cancelled on every read, AeroDataBox operating', () => {
  it('one intent, one change of the stored status, and cancelled shown only with it', async () => {
    const flight = uniqueFlight();
    const { tracker, fake } = await liveAt(flight, [{ cancelled: true }]);
    const kv = await captureKv(tracker);
    const seen = await nextAlarm(tracker);
    // A `cancelled` alert inside the suspicion window raises nothing new and decides nothing.
    await tracker.setClock(seen + MINUTE_MS);
    const merged = await tracker.stub.ingestProviderEvent({
      rpcVersion: RPC_SCHEMA_VERSION,
      provider: 'aeroapi',
      kind: 'update',
      externalId: `alert-${crypto.randomUUID()}`,
      receivedAt: new Date(seen + MINUTE_MS).toISOString(),
      flightRef: { flightKey: flight.flightKey },
      payload: {
        source: 'aeroapi_alert',
        faFlightId: 'x',
        eventCode: 'cancelled',
        times: {},
        cancelled: true,
      },
    });
    expect(merged.outcome).toBe('merged');
    expect(intentsOf(tracker)).toEqual([]);
    expect(await policyState(tracker)).toMatchObject({
      cancellation: { status: 'suspect', provider: 'aeroapi', since: seen, reads: 0 },
    });
    expect((await flightRow(tracker))?.phase).toBe('scheduled');
    await nextAlarm(tracker);
    await kvSettled(tracker);

    const [intent, ...more] = intentsOf(tracker);
    expect(more).toEqual([]);
    const version = Number(/:v(\d+)$/.exec(intent?.payload.dedupeKey ?? '')?.[1]);
    // The rows in seq order: the status changes once, to cancelled, at the intent's version.
    const rows = [...new Map(instancesOf(tracker).map((m) => [m.seq, m])).values()];
    rows.sort((a, b) => a.seq - b.seq);
    const statuses = rows.map((m) => m.payload.snapshot?.status);
    const first = statuses.indexOf('cancelled');
    expect(statuses.slice(0, first).includes('cancelled')).toBe(false);
    expect(statuses.slice(first).every((status) => status === 'cancelled')).toBe(true);
    expect(rows[first]?.payload.version).toBe(version);
    expect(rows[first]?.seq).toBeGreaterThan(intent?.seq ?? Infinity);
    const kvStatuses = kv.map((value) => value.snapshot?.status);
    const kvFirst = kvStatuses.indexOf('cancelled');
    expect(kvFirst).toBeGreaterThan(0);
    expect(kvStatuses.slice(kvFirst).every((status) => status === 'cancelled')).toBe(true);
    expect(kv.slice(kvFirst).every((value) => value.version >= version)).toBe(true);
    expect(await flightRow(tracker)).toMatchObject({
      phase: 'finished',
      finish_reason: 'cancelled',
    });
    expectDesignatorReads(fake, flight, 2);
    expect(await adbCalls(flight)).toBe(1);
    expectOnePayloadPerVersion(tracker);
  });

  it('re-reads that fail cost the fast re-reads on top of the cadence, no more (F3)', async () => {
    const flight = uniqueFlight();
    const { tracker, fake } = await liveAt(flight, [{ cancelled: true }, { httpStatus: 500 }]);
    const seen = await nextAlarm(tracker);
    const alarms: number[] = [];
    while ((alarms.at(-1) ?? 0) < 60 && alarms.length < 20) {
      alarms.push(((await nextAlarm(tracker)) - seen) / MINUTE_MS);
    }
    // The 15-minute band: two fast re-reads between slots, the third on a slot, then the slots.
    expect(alarms).toEqual([5, 10, 15, 30, 45, 60]);
    const cadencePolls = 1 + alarms.filter((minutes) => minutes % 15 === 0).length;
    expect(fake.requests.length).toBe(cadencePolls + 2);
    expectDesignatorReads(fake, flight, 7);
    expect(await adbCalls(flight)).toBe(1);
    expect(await policyState(tracker)).toMatchObject({
      cancellation: { status: 'suspect', provider: 'aeroapi', reads: 6, fastLeft: 0 },
      fastRereadsLeft: 3,
    });
    expect(intentsOf(tracker)).toEqual([]);
  });
});

describe('Q11 (6): an alert merge raises a suspicion as its provider and never decides it', () => {
  it('a cancelled alert onto an AeroDataBox snapshot is AeroAPI evidence, confirmed by AeroAPI', async () => {
    const flight = uniqueFlight();
    const { tracker, fake } = await liveAt(flight, [{ cancelled: true }]);
    const at = flight.scheduledOut.getTime() - 2 * HOUR_MS + MINUTE_MS;
    await tracker.setClock(at);
    // The stored snapshot is the seed's (`source: aerodatabox`); the alert is AeroAPI's.
    const merged = await tracker.stub.ingestProviderEvent({
      rpcVersion: RPC_SCHEMA_VERSION,
      provider: 'aeroapi',
      kind: 'update',
      externalId: `alert-${crypto.randomUUID()}`,
      receivedAt: new Date(at).toISOString(),
      flightRef: { flightKey: flight.flightKey },
      payload: {
        source: 'aeroapi_alert',
        faFlightId: 'x',
        eventCode: 'cancelled',
        times: {},
        cancelled: true,
      },
    });
    expect(merged.outcome).toBe('merged');
    expect(intentsOf(tracker)).toEqual([]);
    expect(await policyState(tracker)).toMatchObject({
      cancellation: { status: 'suspect', provider: 'aeroapi', since: at },
    });
    expect((await flightRow(tracker))?.phase).toBe('scheduled');
    expect(await tracker.alarmAt()).toBeLessThanOrEqual(at + 5 * MINUTE_MS);
    // AeroAPI's own reads decide it: one intent, then the finish.
    for (let i = 0; i < 3 && (await flightRow(tracker))?.phase !== 'finished'; i += 1) {
      await nextAlarm(tracker);
    }
    expect(intentsOf(tracker).map((m) => m.payload.intent.value)).toEqual(['cancelled']);
    expect(await flightRow(tracker)).toMatchObject({
      phase: 'finished',
      finish_reason: 'cancelled',
    });
    expectDesignatorReads(fake, flight, fake.requests.length);
    expect(await adbCalls(flight)).toBe(1);
  });
});

describe('Q19 in live mode: a diverted alert, then AeroAPI says cancelled on the poll', () => {
  it('the cancellation supersedes the diversion: one intent, finished cancelled, reads bounded', async () => {
    const flight = uniqueFlight();
    const { tracker, fake } = await liveAt(flight, [{ cancelled: true }]);
    const at = flight.scheduledOut.getTime() - 2 * HOUR_MS + MINUTE_MS;
    await tracker.setClock(at);
    const merged = await tracker.stub.ingestProviderEvent({
      rpcVersion: RPC_SCHEMA_VERSION,
      provider: 'aeroapi',
      kind: 'update',
      externalId: `alert-${crypto.randomUUID()}`,
      receivedAt: new Date(at).toISOString(),
      flightRef: { flightKey: flight.flightKey },
      payload: {
        source: 'aeroapi_alert',
        faFlightId: 'x',
        eventCode: 'diverted',
        times: {},
        diverted: true,
      },
    });
    expect(merged.outcome).toBe('merged');
    expect(await policyState(tracker)).toMatchObject({
      cancellation: { status: 'none' },
      diversion: { status: 'suspect', provider: 'aeroapi', value: 'diverted', since: at },
    });
    expect((await flightRow(tracker))?.phase).toBe('scheduled');
    expect(await tracker.alarmAt()).toBe(at + 5 * MINUTE_MS);
    // The re-read (AeroAPI, by designator) says cancelled: the diversion suspicion is dropped
    // and the cancellation's own re-read is 5 minutes on, never an alarm at the read itself.
    const polled = await nextAlarm(tracker);
    expect(await policyState(tracker)).toMatchObject({
      cancellation: { status: 'suspect', provider: 'aeroapi', value: 'cancelled', fastLeft: 3 },
      diversion: { status: 'none' },
      fastRereadsLeft: 6,
    });
    expect(await tracker.alarmAt()).toBe(polled + 5 * MINUTE_MS);
    expect(intentsOf(tracker)).toEqual([]);
    expect((await flightRow(tracker))?.phase).toBe('scheduled');
    await nextAlarm(tracker);
    expect(intentsOf(tracker).map((m) => m.payload.intent.value)).toEqual(['cancelled']);
    expect(await flightRow(tracker)).toMatchObject({
      phase: 'finished',
      finish_reason: 'cancelled',
    });
    expectDesignatorReads(fake, flight, 2);
    expect(await adbCalls(flight)).toBe(1);
    expectOnePayloadPerVersion(tracker);
  });
});
