/**
 * `forceRefresh` and the fetch it shares with the alarm (rulings L3, L14, L15, L17):
 *
 *   - 500 refreshes from 500 users spread over 60 s of tracker clock cost ONE provider call: the
 *     in-flight promise coalesces the concurrent ones, the freshness window the sequential ones,
 *     and only the user whose refresh made the call is charged against the daily cap;
 *   - a user refresh is denied at the per-flight hard cap;
 *   - the alarm joins a user refresh already in flight and finds its slot satisfied: one call;
 *   - a refresh during the finish path is refused, never a second call after the archive;
 *   - every provider request carries the fetch timeout: a gateway that never answers is one
 *     billed transport record, not a hung alarm;
 *   - a hung in-flight handle older than `INFLIGHT_STALE_MS` is reported by `health()` and
 *     abandoned by a reconcile refresh;
 *   - a provider that is not configured is a zero-cost error record and ONE ops alert, and the
 *     schedule stands.
 */

import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import {
  INFLIGHT_STALE_MS,
  RPC_SCHEMA_VERSION,
  USER_REFRESH_FRESHNESS_MS,
  pollEquivalents,
} from '@planeahead/shared';
import type { FlightTracker } from '../../src/do/flight-tracker';
import type { Env } from '../../src/env';
import { eventsArchiveKey } from '../../src/r2/archive';
import {
  HOUR_MS,
  MINUTE_MS,
  adbCalls,
  adbOk,
  drainTouched,
  ofKind,
  onTimePhaseAt,
  openBudgetFor,
  resolverHarness,
  scriptAdb,
  testEnv,
  trackerHarness,
  uniqueFlight,
  type TestFlight,
  type TrackerHarness,
} from './helpers/flights';

afterEach(drainTouched);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function seeded(
  flight: TestFlight,
  clock: number,
  caps?: { softCapPe: number; hardCapPe: number },
): Promise<TrackerHarness> {
  await scriptAdb(flight, [adbOk(flight, { phase: onTimePhaseAt(flight, clock) })]);
  const tracker = await trackerHarness(flight.flightKey, clock);
  if (caps !== undefined) {
    await runInDurableObject(tracker.stub, (instance: FlightTracker) => {
      instance.caps = caps;
    });
  }
  await openBudgetFor(flight, clock);
  const resolver = await resolverHarness(flight, clock);
  const resolved = await resolver.stub.resolve({
    rpcVersion: RPC_SCHEMA_VERSION,
    designator: flight.designator,
    dateLocal: flight.dateLocal,
  });
  expect(resolved.outcome).toBe('resolved');
  return tracker;
}

function userRefresh(tracker: TrackerHarness, userId: string) {
  return tracker.stub.forceRefresh({
    rpcVersion: RPC_SCHEMA_VERSION,
    reason: 'user_refresh',
    userId,
  });
}

describe('forceRefresh coalescing (L15)', () => {
  it('500 refreshes from 500 users over 60 s of tracker clock make one provider call', async () => {
    const flight = uniqueFlight();
    const clock = flight.scheduledOut.getTime() - 2 * HOUR_MS;
    const tracker = await seeded(flight, clock);
    expect(await adbCalls(flight)).toBe(1);

    // The loop runs on the instance (one round trip, not a thousand): the same `forceRefresh`
    // the stub would call, driven by the same clock seam.
    const outcomes = await runInDurableObject(
      tracker.stub,
      async (instance: FlightTracker): Promise<Record<string, number>> => {
        const counts: Record<string, number> = {};
        for (let i = 0; i < 500; i += 1) {
          instance._setClock(clock + i * 120);
          const response = await instance.forceRefresh({
            rpcVersion: RPC_SCHEMA_VERSION,
            reason: 'user_refresh',
            userId: `user-${String(i)}`,
          });
          const label = `${response.outcome}:${response.reason ?? ''}`;
          counts[label] = (counts[label] ?? 0) + 1;
        }
        return counts;
      },
    );

    expect(await adbCalls(flight)).toBe(2);
    expect(outcomes).toEqual({ 'refreshed:': 1, 'coalesced:fresh': 499 });
    // The cap is charged only to the user whose refresh made the call.
    const charged = await tracker.rows<{ user_id: string; count: number }>(
      'SELECT user_id, count FROM user_refresh ORDER BY user_id',
    );
    expect(charged).toEqual([{ user_id: 'user-0', count: 1 }]);
    expect((await tracker.stub.getCostLedger()).userRefreshPe).toBe(
      pollEquivalents('aerodatabox', 'flight_status'),
    );
    // Past the window the next refresh polls again.
    await tracker.setClock(clock + USER_REFRESH_FRESHNESS_MS);
    expect((await userRefresh(tracker, 'user-late')).outcome).toBe('refreshed');
    expect(await adbCalls(flight)).toBe(3);
  });

  it('twenty concurrent refreshes join one fetch', async () => {
    const flight = uniqueFlight();
    const clock = flight.scheduledOut.getTime() - 2 * HOUR_MS;
    const tracker = await seeded(flight, clock);
    const answers = await Promise.all(
      Array.from({ length: 20 }, (_, i) => userRefresh(tracker, `burst-${String(i)}`)),
    );
    expect(await adbCalls(flight)).toBe(2);
    expect(answers.filter((a) => a.outcome === 'refreshed')).toHaveLength(1);
    expect(
      answers.filter((a) => a.outcome === 'coalesced' && a.reason === 'inflight'),
    ).toHaveLength(19);
  });

  it('denies a user refresh at the per-flight hard cap', async () => {
    const flight = uniqueFlight();
    const clock = flight.scheduledOut.getTime() - 2 * HOUR_MS;
    const pe = pollEquivalents('aerodatabox', 'flight_status');
    const tracker = await seeded(flight, clock, { softCapPe: pe, hardCapPe: pe * 1.5 });

    expect((await userRefresh(tracker, 'user-a')).outcome).toBe('refreshed');
    await tracker.setClock(clock + USER_REFRESH_FRESHNESS_MS + 1);
    const denied = await userRefresh(tracker, 'user-b');
    expect(denied).toMatchObject({ outcome: 'denied', reason: 'hard_cap' });
    expect(await adbCalls(flight)).toBe(2);
    // A denial charges nothing.
    const charged = await tracker.rows<{ user_id: string }>('SELECT user_id FROM user_refresh');
    expect(charged).toEqual([{ user_id: 'user-a' }]);
  });
});

describe('the alarm and the in-flight fetch (L14)', () => {
  it('joins a user refresh already in flight, and a slot a refresh just answered polls nothing', async () => {
    const flight = uniqueFlight();
    const creation = flight.scheduledOut.getTime() - 48 * HOUR_MS;
    const tracker = await seeded(flight, creation);
    const slot = creation + HOUR_MS;
    await tracker.setClock(slot);
    // The gateway holds the refresh's answer for a moment, so the alarm arrives mid-fetch.
    await scriptAdb(flight, [
      { ...adbOk(flight, { phase: 'expected', originGate: 'B7' }), delayMs: 800 },
      adbOk(flight, { phase: 'expected', originGate: 'B9' }),
    ]);

    const refresh = userRefresh(tracker, 'user-mid-fetch');
    await sleep(150);
    expect((await tracker.stub.health()).inflight).toBe(true);
    const ran = tracker.runAlarm();
    const [refreshed] = await Promise.all([refresh, ran]);

    // One call: the alarm joined the refresh, whose answer moved the schedule to the next slot.
    expect(refreshed.outcome).toBe('refreshed');
    expect(await adbCalls(flight)).toBe(2);
    expect(refreshed.snapshot?.originGate).toBe('B7');
    expect(await tracker.alarmAt()).toBe(slot + HOUR_MS);

    // A refresh five minutes before the next slot answers that slot too: the alarm reschedules
    // without a call and records the slot as satisfied.
    await tracker.setClock(slot + HOUR_MS - 5 * MINUTE_MS);
    expect((await userRefresh(tracker, 'user-early')).outcome).toBe('refreshed');
    expect(await adbCalls(flight)).toBe(3);
    await tracker.setClock(slot + HOUR_MS);
    expect(await tracker.runAlarm()).toBe(true);
    expect(await adbCalls(flight)).toBe(3);
    const [attempt] = await tracker.rows<{ outcome: string }>(
      'SELECT outcome FROM attempts WHERE slot_ms = ?',
      slot + HOUR_MS,
    );
    expect(attempt).toEqual({ outcome: 'satisfied' });
    expect(await tracker.alarmAt()).toBe(slot + 2 * HOUR_MS);
    // The scheduled poll that follows is not fooled by its own predecessor: it polls.
    await tracker.setClock(slot + 2 * HOUR_MS);
    expect(await tracker.runAlarm()).toBe(true);
    expect(await adbCalls(flight)).toBe(4);
  });

  it('refuses a user refresh during the finish path, so nothing follows the archive', async () => {
    const flight = uniqueFlight();
    const creation = flight.scheduledIn.getTime() + 30 * MINUTE_MS;
    const tracker = await seeded(flight, creation);
    const tail = await tracker.alarmAt();
    expect(tail).not.toBeNull();
    if (tail === null) {
      return;
    }
    await tracker.setClock(tail);
    // The archive write takes a while: the refresh lands while the finish path holds the object.
    const puts: string[] = [];
    await runInDurableObject(tracker.stub, (instance: FlightTracker) => {
      const bucket = instance.bucket;
      instance.bucket = {
        put: async (key: string, ...rest: unknown[]) => {
          await scheduler.wait(600);
          puts.push(key);
          return (bucket.put as (...args: unknown[]) => Promise<R2Object | null>)(key, ...rest);
        },
      } as unknown as Pick<R2Bucket, 'put'>;
    });

    const ran = tracker.runAlarm();
    await sleep(200);
    const refresh = await userRefresh(tracker, 'user-during-finish');
    expect(await ran).toBe(true);

    expect(refresh).toMatchObject({ outcome: 'skipped', reason: 'finished', phase: 'finished' });
    expect(await adbCalls(flight)).toBe(2);
    const epochMs =
      (await tracker.rows<{ created_at_ms: number }>('SELECT created_at_ms FROM flight'))[0]
        ?.created_at_ms ?? 0;
    expect(puts).toEqual([eventsArchiveKey(flight.flightKey, epochMs)]);
    const events = await tracker.rows<{ type: string }>('SELECT type FROM events ORDER BY seq');
    expect(events.at(-1)).toEqual({ type: 'finished' });
  });
});

describe('the provider fetch timeout and a stale in-flight handle (L3)', () => {
  it('times out a gateway that never answers into one billed transport record', async () => {
    const flight = uniqueFlight();
    const clock = flight.scheduledOut.getTime() - 2 * HOUR_MS;
    const tracker = await seeded(flight, clock);
    await runInDurableObject(tracker.stub, (instance: FlightTracker) => {
      instance.providerFetchTimeoutMs = 300;
    });
    await scriptAdb(flight, [{ ...adbOk(flight, { phase: 'expected' }), delayMs: 3_000 }]);
    tracker.outbox.sent.length = 0;

    const started = Date.now();
    const response = await tracker.stub.forceRefresh({
      rpcVersion: RPC_SCHEMA_VERSION,
      reason: 'manual',
    });

    expect(Date.now() - started).toBeLessThan(2_500);
    expect(response.outcome).toBe('refreshed');
    const records = ofKind(tracker.outbox.sent, 'provider_call');
    expect(records).toHaveLength(1);
    expect(records[0]?.payload).toMatchObject({ result: 'error', trigger: 'manual' });
    expect(records[0]?.payload.error).toMatch(/^transport_unknown_billing:/);
    // Billed: the request may have been served. The schedule stands.
    expect(records[0]?.payload.costUnits).toBeGreaterThan(0);
    expect(await tracker.alarmAt()).not.toBeNull();
    expect((await tracker.stub.health()).inflight).toBe(false);
  });

  it('reports a hung fetch as inflightSinceMs and lets a reconcile refresh abandon it', async () => {
    const flight = uniqueFlight();
    const clock = flight.scheduledOut.getTime() - 2 * HOUR_MS;
    const tracker = await seeded(flight, clock);
    await runInDurableObject(tracker.stub, (instance: FlightTracker) => {
      instance.providerFetchTimeoutMs = 30_000;
    });
    await scriptAdb(flight, [
      { ...adbOk(flight, { phase: 'expected' }), delayMs: 2_500 },
      adbOk(flight, { phase: 'expected', originGate: 'C1' }),
    ]);

    const hung = userRefresh(tracker, 'user-hung');
    await sleep(150);
    const young = await tracker.stub.health();
    expect(young.inflight).toBe(true);
    expect(young.inflightSinceMs).toBe(0);
    // Five minutes of tracker clock later the handle is stale.
    await tracker.setClock(clock + INFLIGHT_STALE_MS);
    const stale = await tracker.stub.health();
    expect(stale.inflightSinceMs).toBe(INFLIGHT_STALE_MS);
    // A user refresh still joins it; a reconcile refresh abandons it and polls.
    const joinedPromise = userRefresh(tracker, 'user-joins');
    const reconciled = await tracker.stub.forceRefresh({
      rpcVersion: RPC_SCHEMA_VERSION,
      reason: 'reconcile',
    });
    expect(reconciled.outcome).toBe('refreshed');
    expect(reconciled.snapshot?.originGate).toBe('C1');
    expect(await adbCalls(flight)).toBe(3);
    const [joined, first] = await Promise.all([joinedPromise, hung]);
    expect(joined.outcome).toBe('coalesced');
    expect(first.outcome).toBe('refreshed');
    expect((await tracker.stub.health()).inflight).toBe(false);
  });
});

describe('a provider that is not configured (L17)', () => {
  it('records a zero-cost error, alerts once, and keeps the schedule', async () => {
    const flight = uniqueFlight();
    const creation = flight.scheduledOut.getTime() - 48 * HOUR_MS;
    const tracker = await seeded(flight, creation);
    const alerts: string[] = [];
    await runInDurableObject(tracker.stub, (instance: FlightTracker) => {
      // The Worker's env, minus the key: the router refuses to build the adapter.
      const holder = instance as unknown as { env: Env };
      holder.env = { ...holder.env, AERODATABOX_API_KEY: '' };
      instance.capture = (message) => void alerts.push(message);
    });
    tracker.outbox.sent.length = 0;

    const slot = creation + HOUR_MS;
    await tracker.setClock(slot);
    expect(await tracker.runAlarm()).toBe(true);
    await tracker.setClock(slot + HOUR_MS);
    expect(await tracker.runAlarm()).toBe(true);

    expect(await adbCalls(flight)).toBe(1);
    // Two records (the second alarm's flush re-sends the first one, unconfirmed past the grace).
    const records = ofKind(tracker.outbox.sent, 'provider_call');
    expect(new Set(records.map((record) => record.payload.id)).size).toBe(2);
    for (const record of records) {
      expect(record.payload).toMatchObject({ result: 'error', costUnits: 0, pollEquivalents: 0 });
      expect(record.payload.error).toMatch(/^config:AERODATABOX_API_KEY/);
    }
    expect(alerts).toEqual(['provider_config_error']);
    expect((await tracker.stub.getCostLedger()).scheduledPe).toBe(0);
    expect(await tracker.alarmAt()).toBe(slot + 2 * HOUR_MS);
    const attempts = await tracker.rows<{ outcome: string }>(
      'SELECT outcome FROM attempts ORDER BY slot_ms',
    );
    expect(attempts).toEqual([{ outcome: 'error' }, { outcome: 'error' }]);
    void testEnv;
  });
});
