/**
 * The FlightTracker alarm under failure: the retry ladder, the throwing provider, the hard
 * lifetime, the per-flight hard cap and a key drift that names another flight.
 *
 *   - A throwing provider (the router's adapter seam rejects) yields ONE error record at zero
 *     cost for the slot, and six simulated platform retries at the same clock add nothing: the
 *     first four find the slot's `attempts` row fresh and skip the provider, the fifth and
 *     sixth hit the ladder (`retryCount >= 5`: re-arm 30 s out and return).
 *   - A flight that never reports `in` is finished at `maxLifetime`.
 *   - Past the per-flight hard cap the alarm stops polling, records the event and schedules one
 *     reconciliation poll at scheduled arrival.
 *   - A provider answer that canonicalises to a different flight stops polling with a
 *     `key_drift` event; the key is never renamed.
 *
 * `runDurableObjectAlarm` never passes `alarmInfo`, so the retries call `alarm()` directly
 * through `runInDurableObject` with a simulated `{ isRetry, retryCount }`.
 */

import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RPC_SCHEMA_VERSION,
  maxLifetime,
  type FlightDataProvider,
  type FlightKey,
} from '@planeahead/shared';
import { RETRY_BACKSTOP_MS, type FlightTracker } from '../../src/do/flight-tracker';
import { ADB_PLANS } from '../../src/providers/config';
import {
  HOUR_MS,
  MINUTE_MS,
  adbCalls,
  adbFlightContract,
  adbOk,
  drainTouched,
  ofKind,
  onTimePhaseAt,
  openBudgetFor,
  resolverHarness,
  scriptAdb,
  trackerHarness,
  uniqueFlight,
  type TestFlight,
  type TrackerHarness,
} from './helpers/flights';

afterEach(drainTouched);

/** Creates the tracker through the resolver at `clock` with the gateway scripted `expected`. */
async function seeded(
  flight: TestFlight,
  clock: number,
): Promise<{ tracker: TrackerHarness; flightKey: FlightKey }> {
  await scriptAdb(flight, [adbOk(flight, { phase: 'expected' })]);
  const tracker = await trackerHarness(flight.flightKey, clock);
  await openBudgetFor(flight, clock);
  const resolver = await resolverHarness(flight, clock);
  const resolved = await resolver.stub.resolve({
    rpcVersion: RPC_SCHEMA_VERSION,
    designator: flight.designator,
    dateLocal: flight.dateLocal,
  });
  expect(resolved.outcome).toBe('resolved');
  return { tracker, flightKey: flight.flightKey };
}

function throwingProvider(): { provider: FlightDataProvider; calls: () => number } {
  let calls = 0;
  const provider: FlightDataProvider = {
    id: 'aerodatabox',
    capabilities: {
      alerts: false,
      alertFields: ['unknown'],
      boards: false,
      maxDaysAhead: ADB_PLANS.growth.maxDaysAhead,
      fidsWindowHours: ADB_PLANS.growth.fidsWindowHours,
      inboundLink: false,
    },
    getFlight: () => {
      calls += 1;
      return Promise.reject(new Error('adapter exploded before any HTTP call'));
    },
  };
  return { provider, calls: () => calls };
}

describe('FlightTracker retries', () => {
  it('a throwing provider yields one error record at zero cost per slot across six retries', async () => {
    const flight = uniqueFlight();
    const creation = flight.scheduledOut.getTime() - 48 * HOUR_MS;
    const { tracker } = await seeded(flight, creation);
    const throwing = throwingProvider();
    await runInDurableObject(tracker.stub, (instance: FlightTracker) => {
      instance.providerDeps = { aerodatabox: throwing.provider };
    });
    tracker.outbox.sent.length = 0;

    const slot = creation + HOUR_MS;
    await tracker.setClock(slot);
    expect(await tracker.runAlarm()).toBe(true);
    expect(throwing.calls()).toBe(1);
    const records = ofKind(tracker.outbox.sent, 'provider_call');
    expect(records).toHaveLength(1);
    expect(records[0]?.payload).toMatchObject({
      result: 'error',
      costUnits: 0,
      pollEquivalents: 0,
      estCostUsdMicros: 0,
      trigger: 'alarm',
      flightKey: flight.flightKey,
    });
    expect(records[0]?.payload.error).toMatch(/^thrown:/);
    // The pre-debited expected cost came back: nothing was spent.
    expect((await tracker.stub.getCostLedger()).scheduledPe).toBe(0);
    // The schedule stands: the next slot is armed.
    expect(await tracker.alarmAt()).toBe(slot + HOUR_MS);

    // Six platform retries of the same slot, same clock.
    for (let retryCount = 1; retryCount <= 6; retryCount += 1) {
      await tracker.retryAlarm(retryCount);
      expect(throwing.calls()).toBe(1);
      expect(ofKind(tracker.outbox.sent, 'provider_call')).toHaveLength(1);
    }
    const attempts = await tracker.rows<{
      slot_ms: number;
      outcome: string;
      retry_count: number;
    }>('SELECT slot_ms, outcome, retry_count FROM attempts ORDER BY slot_ms');
    expect(attempts).toEqual([
      { slot_ms: slot, outcome: 'retry_ladder_exhausted', retry_count: 6 },
    ]);
    expect(await adbCalls(flight)).toBe(1);
  });

  it('retryCount >= 5 re-arms 30 s out and returns, never set-then-throw', async () => {
    const flight = uniqueFlight();
    const creation = flight.scheduledOut.getTime() - 48 * HOUR_MS;
    const { tracker } = await seeded(flight, creation);
    const slot = creation + HOUR_MS;
    await tracker.setClock(slot);
    expect(await tracker.runAlarm()).toBe(true);
    expect(await adbCalls(flight)).toBe(2);

    await tracker.retryAlarm(5);

    expect(await tracker.alarmAt()).toBe(slot + RETRY_BACKSTOP_MS);
    expect(await adbCalls(flight)).toBe(2);
    const state = await tracker.stub.getState();
    expect(state.nextRefreshAt).toBe(new Date(slot + RETRY_BACKSTOP_MS).toISOString());
    // The backstop alarm is an ordinary slot: it polls and the cadence resumes.
    await tracker.setClock(slot + RETRY_BACKSTOP_MS);
    expect(await tracker.runAlarm()).toBe(true);
    expect(await adbCalls(flight)).toBe(3);
    expect(await tracker.alarmAt()).toBe(slot + HOUR_MS);
  });

  it('a retry that finds its slot attempted skips the provider and re-sends the outbox', async () => {
    const flight = uniqueFlight();
    const creation = flight.scheduledOut.getTime() - 48 * HOUR_MS;
    const { tracker } = await seeded(flight, creation);
    const slot = creation + HOUR_MS;
    await tracker.setClock(slot);
    // The queue is down for the first attempt: rows stay unsent.
    tracker.outbox.failSends = true;
    expect(await tracker.runAlarm()).toBe(true);
    expect(await adbCalls(flight)).toBe(2);
    expect((await tracker.stub.health()).unconfirmedOutbox).toBeGreaterThan(0);
    tracker.outbox.failSends = false;
    tracker.outbox.sent.length = 0;

    await tracker.retryAlarm(1);

    expect(await adbCalls(flight)).toBe(2);
    expect(tracker.outbox.sent.length).toBeGreaterThan(0);
    const [attempt] = await tracker.rows<{ outcome: string; retry_count: number }>(
      'SELECT outcome, retry_count FROM attempts WHERE slot_ms = ?',
      slot,
    );
    expect(attempt).toEqual({ outcome: 'ok', retry_count: 1 });
  });

  it('a flight that never reports in is finished at the hard lifetime', async () => {
    const flight = uniqueFlight();
    const creation = flight.scheduledOut.getTime() - 2 * HOUR_MS;
    const { tracker } = await seeded(flight, creation);
    const lifetime = maxLifetime(flight.scheduledIn, flight.scheduledOut, 180).getTime();
    expect(lifetime).toBe(flight.scheduledOut.getTime() + 6 * HOUR_MS);

    let clock = creation;
    let lastPhase = '';
    for (let guard = 0; guard < 200; guard += 1) {
      const alarmAt = await tracker.alarmAt();
      if (alarmAt === null) {
        break;
      }
      clock = alarmAt;
      await tracker.setClock(clock);
      // Departs on time and then never lands: `en_route` for ever.
      const phase = onTimePhaseAt(flight, clock) === 'expected' ? 'expected' : 'en_route';
      if (phase !== lastPhase) {
        await scriptAdb(flight, [adbOk(flight, { phase })]);
        lastPhase = phase;
      }
      expect(await tracker.runAlarm()).toBe(true);
      const [row] = await tracker.rows<{ phase: string }>('SELECT phase FROM flight');
      if (row?.phase === 'finished') {
        break;
      }
    }

    const [row] = await tracker.rows<{
      phase: string;
      finish_reason: string;
      finished_at_ms: number;
      actual_in_ms: number | null;
    }>('SELECT phase, finish_reason, finished_at_ms, actual_in_ms FROM flight');
    expect(row).toMatchObject({ phase: 'finished', finish_reason: 'lifetime', actual_in_ms: null });
    expect(row?.finished_at_ms ?? 0).toBeLessThanOrEqual(lifetime);
    expect(row?.finished_at_ms ?? 0).toBeGreaterThan(flight.scheduledIn.getTime());
    expect(await tracker.alarmAt()).toBe((row?.finished_at_ms ?? 0) + 22 * HOUR_MS);
  });

  it('past the hard cap the alarm stops polling and schedules one reconciliation poll', async () => {
    const flight = uniqueFlight();
    const creation = flight.scheduledOut.getTime() - 48 * HOUR_MS;
    const { tracker } = await seeded(flight, creation);
    await runInDurableObject(tracker.stub, (_instance, state) => {
      state.storage.sql.exec('UPDATE budget SET scheduled_pe = hard_cap_pe WHERE id = 1');
    });
    tracker.outbox.sent.length = 0;
    const slot = creation + HOUR_MS;
    await tracker.setClock(slot);

    expect(await tracker.runAlarm()).toBe(true);

    expect(await adbCalls(flight)).toBe(1);
    const ledger = await tracker.stub.getCostLedger();
    expect(ledger.hardCapHit).toBe(true);
    const [attempt] = await tracker.rows<{ outcome: string }>(
      'SELECT outcome FROM attempts WHERE slot_ms = ?',
      slot,
    );
    expect(attempt?.outcome).toBe('budget_stop');
    expect(ofKind(tracker.outbox.sent, 'flight_event').map((m) => m.payload.type)).toContain(
      'budget_hard_cap',
    );
    expect(await tracker.alarmAt()).toBe(flight.scheduledIn.getTime());

    // The reconciliation poll at scheduled arrival: one call, then the flight finishes.
    await tracker.setClock(flight.scheduledIn.getTime());
    await scriptAdb(flight, [adbOk(flight, { phase: 'arrived' })]);
    expect(await tracker.runAlarm()).toBe(true);
    expect(await adbCalls(flight)).toBe(2);
    expect(ledger.hardCapHit).toBe(true);
    const [row] = await tracker.rows<{ phase: string; finish_reason: string }>(
      'SELECT phase, finish_reason FROM flight',
    );
    expect(row).toEqual({ phase: 'finished', finish_reason: 'arrived' });
    expect((await tracker.stub.getCostLedger()).byTrigger['reconcile']?.calls).toBe(1);
  });

  it('a different_flight drift stops polling with an event and never renames the key', async () => {
    const flight = uniqueFlight();
    const creation = flight.scheduledOut.getTime() - 48 * HOUR_MS;
    const { tracker } = await seeded(flight, creation);
    tracker.outbox.sent.length = 0;
    const slot = creation + HOUR_MS;
    await tracker.setClock(slot);
    // The gateway now says the flight leaves from Boston.
    await scriptAdb(flight, [
      {
        status: 200,
        body: [
          adbFlightContract(flight, {
            phase: 'expected',
            origin: {
              icao: 'KBOS',
              iata: 'BOS',
              name: 'Boston Logan',
              timeZone: 'America/New_York',
            },
          }),
        ],
      },
    ]);

    expect(await tracker.runAlarm()).toBe(true);

    const drift = ofKind(tracker.outbox.sent, 'flight_event').find(
      (m) => m.payload.type === 'key_drift',
    );
    expect(drift?.payload).toMatchObject({
      field: 'different_flight',
      oldValue: flight.flightKey,
      newValue: `AAL-${flight.number}-${flight.dateLocal}-KBOS`,
    });
    const [row] = await tracker.rows<{ key: string; phase: string; finish_reason: string }>(
      'SELECT key, phase, finish_reason FROM flight',
    );
    expect(row).toEqual({ key: flight.flightKey, phase: 'finished', finish_reason: 'key_drift' });
    expect(await tracker.alarmAt()).toBe(slot + 22 * HOUR_MS);
    void MINUTE_MS;
  });
});
