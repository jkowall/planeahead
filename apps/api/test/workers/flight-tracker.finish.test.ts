/**
 * The finish path and what comes after it (rulings L2, L9, L11, L12):
 *
 *   - the +22 h alarm never `deleteAll()`s while outbox rows remain: six failed flushes defer
 *     it hourly with ONE ops alert, a successful flush still waits for the confirmation, and
 *     only a confirmed outbox lets the object delete itself;
 *   - the KV snapshot holds the `finished` phase after the finish alarm, and a merge suppressed
 *     by the debounce reaches KV on the next entry point;
 *   - a user refresh whose answer says the flight is over finishes it there and then, +22 h
 *     alarm included, replacing the cadence alarm;
 *   - a finished flight never gets a second lifetime: a re-seed after `deleteAll()` archives
 *     under its own key and leaves the first archive untouched, and the persist consumer
 *     refuses its rows with the `flight_lifetime_rejected` alert.
 */

import { createExecutionContext, createMessageBatch, runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { flightEvents, flightInstances, openDb } from '@planeahead/db';
import { afterEach, describe, expect, it } from 'vitest';
import { RPC_SCHEMA_VERSION, parseFlightTrackerOrigin } from '@planeahead/shared';
import {
  FINISH_ALARM_MS,
  FINISH_ALERT_AFTER_ATTEMPTS,
  FINISH_RETRY_MS,
  type FlightTracker,
} from '../../src/do/flight-tracker';
import { snapshotKvKey, type SnapshotKvValue } from '../../src/kv/snapshot';
import { createLogger } from '../../src/observability/log';
import { handlePersistBatch } from '../../src/queues/persist';
import { eventsArchiveKey } from '../../src/r2/archive';
import {
  HOUR_MS,
  MINUTE_MS,
  adbCalls,
  adbOk,
  drainTouched,
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

const quietLog = createLogger({}, () => undefined);

async function seeded(flight: TestFlight, clock: number): Promise<TrackerHarness> {
  await scriptAdb(flight, [adbOk(flight, { phase: onTimePhaseAt(flight, clock) })]);
  const tracker = await trackerHarness(flight.flightKey, clock);
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

/** Seeds half an hour after arrival and walks the one tail poll to `finished`. */
async function finished(flight: TestFlight): Promise<{ tracker: TrackerHarness; at: number }> {
  const tracker = await seeded(flight, flight.scheduledIn.getTime() + 30 * MINUTE_MS);
  const tail = await tracker.alarmAt();
  expect(tail).not.toBeNull();
  await tracker.setClock(tail ?? 0);
  expect(await tracker.runAlarm()).toBe(true);
  expect((await tracker.stub.health()).phase).toBe('finished');
  return { tracker, at: tail ?? 0 };
}

async function confirmAll(tracker: TrackerHarness): Promise<void> {
  const pending = tracker.outbox.sent.splice(0);
  const epochMs = pending
    .map((message) => parseFlightTrackerOrigin(message.origin)?.epochMs)
    .find((epoch): epoch is number => epoch !== undefined);
  if (epochMs !== undefined) {
    await tracker.stub.confirmPersisted({
      rpcVersion: RPC_SCHEMA_VERSION,
      epochMs,
      seqs: [...new Set(pending.map((message) => message.seq))],
    });
  }
}

async function persist(
  bodies: readonly unknown[],
  capture?: (message: string) => void,
): Promise<void> {
  const db = openDb(testEnv);
  for (let i = 0; i < bodies.length; i += 100) {
    const batch = createMessageBatch(
      'planeahead-persist-local',
      bodies.slice(i, i + 100).map((body, index) => ({
        id: `m-${String(i + index)}-${crypto.randomUUID()}`,
        timestamp: new Date(),
        attempts: 1,
        body,
      })),
    );
    await handlePersistBatch(
      batch,
      { env: testEnv, ctx: createExecutionContext(), log: quietLog },
      { db, capture: capture === undefined ? undefined : (message) => void capture(message) },
    );
  }
}

describe('the +22 h alarm never discards an outbox row (L2)', () => {
  it('defers hourly with one alert while rows remain, and deletes only once they are confirmed', async () => {
    const flight = uniqueFlight();
    const alerts: string[] = [];
    // Seeded half an hour after arrival; the queue is down from the first row on.
    const clock = flight.scheduledIn.getTime() + 30 * MINUTE_MS;
    await scriptAdb(flight, [adbOk(flight, { phase: 'arrived' })]);
    const tracker = await trackerHarness(flight.flightKey, clock);
    tracker.outbox.failSends = true;
    await runInDurableObject(tracker.stub, (instance: FlightTracker) => {
      instance.capture = (message) => void alerts.push(message);
    });
    await openBudgetFor(flight, clock);
    const resolver = await resolverHarness(flight, clock);
    await resolver.stub.resolve({
      rpcVersion: RPC_SCHEMA_VERSION,
      designator: flight.designator,
      dateLocal: flight.dateLocal,
    });
    const tail = await tracker.alarmAt();
    await tracker.setClock(tail ?? 0);
    expect(await tracker.runAlarm()).toBe(true);
    const health = await tracker.stub.health();
    expect(health.phase).toBe('finished');
    expect(health.unconfirmedOutbox).toBeGreaterThan(0);
    const finishedAt = tail ?? 0;
    expect(await tracker.alarmAt()).toBe(finishedAt + FINISH_ALARM_MS);

    // Six finish alarms with the queue still down: deferred an hour each, one alert at the sixth.
    let at = finishedAt + FINISH_ALARM_MS;
    for (let attempt = 1; attempt <= FINISH_ALERT_AFTER_ATTEMPTS; attempt += 1) {
      await tracker.setClock(at);
      expect(await tracker.runAlarm()).toBe(true);
      expect(await tracker.alarmAt()).toBe(at + FINISH_RETRY_MS);
      expect((await tracker.tables()).length).toBeGreaterThan(0);
      expect(alerts).toEqual(
        attempt < FINISH_ALERT_AFTER_ATTEMPTS ? [] : ['flight_tracker_outbox_stuck'],
      );
      at += FINISH_RETRY_MS;
    }
    const [row] = await tracker.rows<{ finish_alarm_attempts: number }>(
      'SELECT finish_alarm_attempts FROM flight',
    );
    expect(row?.finish_alarm_attempts).toBe(FINISH_ALERT_AFTER_ATTEMPTS);

    // The queue is back: the seventh alarm sends every row, but sent is not confirmed.
    tracker.outbox.failSends = false;
    await tracker.setClock(at);
    expect(await tracker.runAlarm()).toBe(true);
    expect(tracker.outbox.sent.length).toBeGreaterThan(0);
    expect(await tracker.alarmAt()).toBe(at + FINISH_RETRY_MS);
    expect(alerts).toHaveLength(1);
    const unsent = await tracker.rows<{ n: number }>(
      'SELECT COUNT(*) AS n FROM outbox WHERE sent_at_ms IS NULL',
    );
    expect(unsent[0]?.n).toBe(0);

    // Confirmed: the next alarm deletes everything.
    await confirmAll(tracker);
    expect((await tracker.stub.health()).unconfirmedOutbox).toBe(0);
    at += FINISH_RETRY_MS;
    await tracker.setClock(at);
    expect(await tracker.runAlarm()).toBe(true);
    expect(await tracker.tables()).toEqual([]);
    expect(await tracker.alarmAt()).toBeNull();
    expect(await adbCalls(flight)).toBe(2);
  });
});

describe('the KV snapshot (L11)', () => {
  it('holds the finished phase after the finish alarm', async () => {
    const flight = uniqueFlight();
    const { tracker } = await finished(flight);
    await runInDurableObject(tracker.stub, (instance: FlightTracker) => instance.kvSettled());
    const value = await testEnv.CACHE.get<SnapshotKvValue>(snapshotKvKey(flight.flightKey), 'json');
    const health = await tracker.stub.health();
    expect(value?.phase).toBe('finished');
    expect(value?.version).toBe(health.version);
    expect(value?.nextRefreshAt).toBeNull();
  });

  it('writes a merge suppressed by the debounce on the next entry point', async () => {
    const flight = uniqueFlight();
    const clock = flight.scheduledOut.getTime() - 2 * HOUR_MS;
    const tracker = await seeded(flight, clock);
    await runInDurableObject(tracker.stub, (instance: FlightTracker) => instance.kvSettled());
    const before = await testEnv.CACHE.get<SnapshotKvValue>(
      snapshotKvKey(flight.flightKey),
      'json',
    );
    expect(before?.version).toBe(1);

    // A gate change one second after the seed's write: merged, versioned, and suppressed by
    // the two-second debounce.
    await tracker.setClock(clock + 1_000);
    const merged = await tracker.stub.ingestProviderEvent({
      rpcVersion: RPC_SCHEMA_VERSION,
      provider: 'aeroapi',
      kind: 'update',
      externalId: `alert-${crypto.randomUUID()}`,
      receivedAt: new Date(clock + 1_000).toISOString(),
      flightRef: { flightKey: flight.flightKey },
      payload: {
        source: 'aeroapi_alert',
        faFlightId: 'AAL100-1-2100',
        eventCode: 'change',
        times: {},
        originGate: 'K12',
      },
    });
    expect(merged.outcome).toBe('merged');
    expect(merged.version).toBe(2);
    await runInDurableObject(tracker.stub, (instance: FlightTracker) => instance.kvSettled());
    const suppressed = await testEnv.CACHE.get<SnapshotKvValue>(
      snapshotKvKey(flight.flightKey),
      'json',
    );
    expect(suppressed?.version).toBe(1);
    const [pending] = await tracker.rows<{ pending: number }>('SELECT pending FROM kv_debounce');
    expect(pending).toEqual({ pending: 1 });

    // The next entry point after the gap: a confirmation from the persist consumer.
    await tracker.setClock(clock + 3_000);
    await confirmAll(tracker);
    await runInDurableObject(tracker.stub, (instance: FlightTracker) => instance.kvSettled());
    const written = await testEnv.CACHE.get<SnapshotKvValue>(
      snapshotKvKey(flight.flightKey),
      'json',
    );
    expect(written?.version).toBe(2);
    expect(written?.snapshot?.originGate).toBe('K12');
    const [cleared] = await tracker.rows<{ pending: number }>('SELECT pending FROM kv_debounce');
    expect(cleared).toEqual({ pending: 0 });
  });
});

describe('a refresh that learns the flight is over finishes it (L12)', () => {
  it('finishes from a user refresh, +22 h alarm included, with no further poll', async () => {
    const flight = uniqueFlight();
    const clock = flight.scheduledOut.getTime() - 2 * HOUR_MS;
    const tracker = await seeded(flight, clock);
    const cadenceAlarm = await tracker.alarmAt();
    expect(cadenceAlarm).not.toBeNull();
    // The tracker slept through the flight; a user looks three hours after it arrived.
    const late = flight.scheduledIn.getTime() + 3 * HOUR_MS;
    await tracker.setClock(late);
    await scriptAdb(flight, [adbOk(flight, { phase: 'arrived' })]);

    const refreshed = await tracker.stub.forceRefresh({
      rpcVersion: RPC_SCHEMA_VERSION,
      reason: 'user_refresh',
      userId: 'user-late',
    });

    expect(refreshed).toMatchObject({ outcome: 'refreshed', phase: 'finished' });
    expect(await adbCalls(flight)).toBe(2);
    const [row] = await tracker.rows<{
      phase: string;
      finish_reason: string;
      events_r2_key: string | null;
    }>('SELECT phase, finish_reason, events_r2_key FROM flight');
    expect(row).toMatchObject({ phase: 'finished', finish_reason: 'arrived' });
    expect(row?.events_r2_key).not.toBeNull();
    expect(await tracker.alarmAt()).toBe(late + FINISH_ALARM_MS);
    // The old cadence alarm is gone with it: running what is pending is the finish alarm, which
    // finds the outbox unconfirmed and defers.
    expect(await tracker.runAlarm()).toBe(true);
    expect(await adbCalls(flight)).toBe(2);
    expect(await tracker.alarmAt()).toBe(late + FINISH_RETRY_MS);
  });

  it('finishes from a cancellation seen by a user refresh', async () => {
    const flight = uniqueFlight();
    const clock = flight.scheduledOut.getTime() - 2 * HOUR_MS;
    const tracker = await seeded(flight, clock);
    await tracker.setClock(clock + 10 * MINUTE_MS);
    const cancelled = adbOk(flight, { phase: 'expected' });
    const body = (cancelled.body as Record<string, unknown>[])[0] ?? {};
    await scriptAdb(flight, [{ status: 200, body: [{ ...body, status: 'Canceled' }] }]);

    const refreshed = await tracker.stub.forceRefresh({
      rpcVersion: RPC_SCHEMA_VERSION,
      reason: 'user_refresh',
      userId: 'user-cancel',
    });

    expect(refreshed).toMatchObject({ outcome: 'refreshed', phase: 'finished' });
    const [row] = await tracker.rows<{ finish_reason: string }>('SELECT finish_reason FROM flight');
    expect(row).toEqual({ finish_reason: 'cancelled' });
    expect(await tracker.alarmAt()).toBe(clock + 10 * MINUTE_MS + FINISH_ALARM_MS);
    expect(await adbCalls(flight)).toBe(2);
  });
});

describe('a finished flight never gets a second lifetime (L9)', () => {
  it('re-seeding after deleteAll leaves the first archive and the Postgres rows intact and alerts', async () => {
    const flight = uniqueFlight();
    const { tracker, at } = await finished(flight);
    const snapshot = (await tracker.stub.getState()).snapshot;
    const epoch1 =
      (await tracker.rows<{ created_at_ms: number }>('SELECT created_at_ms FROM flight'))[0]
        ?.created_at_ms ?? 0;
    const alerts: string[] = [];
    // Lifetime 1 lands in Postgres and R2, and its object deletes itself.
    await persist(tracker.outbox.sent.splice(0), (message) => alerts.push(message));
    expect(alerts).toEqual([]);
    await tracker.setClock(at + FINISH_ALARM_MS);
    expect(await tracker.runAlarm()).toBe(true);
    expect(await tracker.tables()).toEqual([]);
    const key1 = eventsArchiveKey(flight.flightKey, epoch1);
    const archive1 = await (await testEnv.PRIVATE_BUCKET.get(key1))?.text();
    expect(archive1).toBeDefined();
    const db = openDb(testEnv);
    const [before] = await db
      .select({
        id: flightInstances.id,
        version: flightInstances.version,
        trackingState: flightInstances.trackingState,
        epoch: flightInstances.doLifetimeEpochMs,
      })
      .from(flightInstances)
      .where(eq(flightInstances.flightKey, flight.flightKey));
    expect(before).toMatchObject({ trackingState: 'finished', epoch: epoch1 });
    const eventsBefore = await db
      .select({ seq: flightEvents.seq })
      .from(flightEvents)
      .where(eq(flightEvents.flightInstanceId, before?.id ?? ''));

    // A day later something seeds the same key again (the bug this rule exists for): a second
    // lifetime, which finishes at once.
    const reborn = at + FINISH_ALARM_MS + 2 * HOUR_MS;
    await tracker.setClock(reborn);
    const seededAgain = await tracker.stub.seed({
      rpcVersion: RPC_SCHEMA_VERSION,
      flightKey: flight.flightKey,
      status: { ...snapshot, fetchedAt: new Date(reborn).toISOString() },
      designator: flight.designator,
    });
    expect(seededAgain).toMatchObject({ status: 'seeded', phase: 'finished' });
    const epoch2 =
      (await tracker.rows<{ created_at_ms: number }>('SELECT created_at_ms FROM flight'))[0]
        ?.created_at_ms ?? 0;
    expect(epoch2).toBeGreaterThan(epoch1);

    // Its archive is its own; the first is byte for byte what it was.
    const key2 = eventsArchiveKey(flight.flightKey, epoch2);
    expect(key2).not.toBe(key1);
    expect(await testEnv.PRIVATE_BUCKET.get(key2)).not.toBeNull();
    expect(await (await testEnv.PRIVATE_BUCKET.get(key1))?.text()).toBe(archive1);

    // Postgres refuses the whole lifetime, once, loudly; every message is still acknowledged.
    await persist(tracker.outbox.sent.splice(0), (message) => alerts.push(message));
    expect(alerts).toEqual(['flight_lifetime_rejected']);
    const [after] = await db
      .select({
        version: flightInstances.version,
        trackingState: flightInstances.trackingState,
        epoch: flightInstances.doLifetimeEpochMs,
      })
      .from(flightInstances)
      .where(eq(flightInstances.flightKey, flight.flightKey));
    expect(after).toEqual({
      version: before?.version,
      trackingState: 'finished',
      epoch: epoch1,
    });
    const eventsAfter = await db
      .select({ seq: flightEvents.seq })
      .from(flightEvents)
      .where(eq(flightEvents.flightInstanceId, before?.id ?? ''));
    expect(eventsAfter).toEqual(eventsBefore);
  });

  it('a resolve for a flight that is over makes one provider call and creates nothing', async () => {
    const flight = uniqueFlight();
    const late = flight.scheduledIn.getTime() + 3 * HOUR_MS;
    await scriptAdb(flight, [adbOk(flight, { phase: 'arrived' })]);
    const tracker = await trackerHarness(flight.flightKey, late);
    await openBudgetFor(flight, late);
    const resolver = await resolverHarness(flight, late);

    const resolved = await resolver.stub.resolve({
      rpcVersion: RPC_SCHEMA_VERSION,
      designator: flight.designator,
      dateLocal: flight.dateLocal,
    });

    expect(resolved).toMatchObject({
      outcome: 'resolved',
      flightKey: flight.flightKey,
      created: false,
      tracker: 'none',
    });
    expect(resolved.status?.status).toBe('arrived');
    expect(await adbCalls(flight)).toBe(1);
    expect((await tracker.stub.health()).phase).toBe('absent');
    const [row] = await tracker.rows<{ n: number }>('SELECT COUNT(*) AS n FROM flight');
    expect(row).toEqual({ n: 0 });
    // Cached like any answer: the next search costs nothing.
    const again = await resolver.stub.resolve({
      rpcVersion: RPC_SCHEMA_VERSION,
      designator: flight.designator,
      dateLocal: flight.dateLocal,
    });
    expect(again).toMatchObject({ cached: true, tracker: 'none' });
    expect(await adbCalls(flight)).toBe(1);
  });
});
