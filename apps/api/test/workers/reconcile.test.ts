/**
 * The reconcile path: the cron pages `flight_instances` for active rows more than twenty
 * minutes overdue and fans the keys out to the queue; the consumer re-arms a tracker whose
 * alarm is gone through `forceRefresh('reconcile')` and leaves a finished one alone.
 */

import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  runInDurableObject,
} from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { flightInstances, openDb } from '@planeahead/db';
import { afterEach, describe, expect, it } from 'vitest';
import { INFLIGHT_STALE_MS, RPC_SCHEMA_VERSION, type FlightKey } from '@planeahead/shared';
import { RECONCILE_OVERDUE_MS, runReconcileCron } from '../../src/cron/reconcile';
import { FINISH_ALARM_MS } from '../../src/do/flight-tracker';
import { createLogger } from '../../src/observability/log';
import { handlePersistBatch } from '../../src/queues/persist';
import {
  handleReconcileBatch,
  reconcileFlight,
  type ReconcilingTracker,
} from '../../src/queues/reconcile';
import {
  HOUR_MS,
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
} from './helpers/flights';

afterEach(drainTouched);

const quietLog = createLogger({}, () => undefined);

function fakeTracker(health: Partial<Awaited<ReturnType<ReconcilingTracker['health']>>>): {
  tracker: ReconcilingTracker;
  refreshes: unknown[];
} {
  const refreshes: unknown[] = [];
  return {
    refreshes,
    tracker: {
      health: () =>
        Promise.resolve({
          rpcVersion: 1,
          flightKey: 'AAL-1-2100-01-01-KJFK' as FlightKey,
          phase: 'scheduled',
          alarmAt: null,
          inflight: false,
          version: 3,
          doSchemaVersion: 1,
          unconfirmedOutbox: 0,
          subscriberCount: 1,
          ...health,
        }),
      forceRefresh: (input) => {
        refreshes.push(input);
        return Promise.resolve({
          rpcVersion: 1,
          outcome: 'refreshed',
          phase: 'scheduled',
          version: 4,
          snapshot: null,
        });
      },
    },
  };
}

async function seededTracker(flight: TestFlight, clock: number) {
  await scriptAdb(flight, [adbOk(flight, { phase: onTimePhaseAt(flight, clock) })]);
  const tracker = await trackerHarness(flight.flightKey, clock);
  await openBudgetFor(flight, clock);
  const resolver = await resolverHarness(flight, clock);
  await resolver.stub.resolve({
    rpcVersion: RPC_SCHEMA_VERSION,
    designator: flight.designator,
    dateLocal: flight.dateLocal,
  });
  return tracker;
}

describe('reconcileFlight', () => {
  it('re-arms only when the phase is not finished and no alarm is pending', async () => {
    const key = 'AAL-1-2100-01-01-KJFK' as FlightKey;
    const abandoned = fakeTracker({ alarmAt: null });
    expect(await reconcileFlight(abandoned.tracker, key)).toBe('rearmed');
    expect(abandoned.refreshes).toEqual([{ rpcVersion: 1, reason: 'reconcile' }]);

    const armed = fakeTracker({ alarmAt: '2100-01-01T13:00:00.000Z' });
    expect(await reconcileFlight(armed.tracker, key)).toBe('alarm_present');
    expect(armed.refreshes).toEqual([]);

    // A running alarm handler also reports a null alarm: the phase and the in-flight flag come
    // first, so a finished tracker and a busy one are both left alone.
    const finished = fakeTracker({ phase: 'finished', alarmAt: null });
    expect(await reconcileFlight(finished.tracker, key)).toBe('finished');
    expect(finished.refreshes).toEqual([]);
    const busy = fakeTracker({ inflight: true });
    expect(await reconcileFlight(busy.tracker, key)).toBe('inflight');
    expect(busy.refreshes).toEqual([]);
    const absent = fakeTracker({ phase: 'absent', flightKey: null });
    expect(await reconcileFlight(absent.tracker, key)).toBe('absent');
  });

  it('refreshes anyway when the in-flight fetch is older than INFLIGHT_STALE_MS (L3)', async () => {
    const key = 'AAL-1-2100-01-01-KJFK' as FlightKey;
    const young = fakeTracker({ inflight: true, inflightSinceMs: INFLIGHT_STALE_MS - 1 });
    expect(await reconcileFlight(young.tracker, key)).toBe('inflight');
    expect(young.refreshes).toEqual([]);
    // Every provider request times out at 30 s: five minutes in flight is a hung promise.
    const stale = fakeTracker({
      inflight: true,
      inflightSinceMs: INFLIGHT_STALE_MS,
      alarmAt: '2100-01-01T13:00:00.000Z',
    });
    expect(await reconcileFlight(stale.tracker, key)).toBe('rearmed');
    expect(stale.refreshes).toEqual([{ rpcVersion: 1, reason: 'reconcile' }]);
  });
});

describe('reconcile consumer against real trackers', () => {
  it('re-arms an abandoned tracker with one poll and leaves a finished one alone', async () => {
    const flight = uniqueFlight();
    const clock = flight.scheduledOut.getTime() - 47 * HOUR_MS;
    const tracker = await seededTracker(flight, clock);
    // The alarm dies (six failed retries, and workerd clears it).
    await runInDurableObject(tracker.stub, (_instance, state) => state.storage.deleteAlarm());
    expect(await tracker.alarmAt()).toBeNull();
    await tracker.setClock(clock + 3 * HOUR_MS);

    const finishedFlight = uniqueFlight();
    // Seeded half an hour after it arrived (one tail poll left), then walked to finished.
    const finishedTracker = await seededTracker(
      finishedFlight,
      finishedFlight.scheduledIn.getTime() + HOUR_MS / 2,
    );
    await finishedTracker.setClock(finishedFlight.scheduledIn.getTime() + HOUR_MS);
    expect(await finishedTracker.runAlarm()).toBe(true);
    expect((await finishedTracker.stub.health()).phase).toBe('finished');
    const finishedCallsBefore = await adbCalls(finishedFlight);

    const batch = createMessageBatch('planeahead-reconcile-local', [
      {
        id: 'r-1',
        timestamp: new Date(),
        attempts: 1,
        body: { kind: 'reconcile_flight', flightKey: flight.flightKey },
      },
      {
        id: 'r-2',
        timestamp: new Date(),
        attempts: 1,
        body: { kind: 'reconcile_flight', flightKey: finishedFlight.flightKey },
      },
      { id: 'r-3', timestamp: new Date(), attempts: 1, body: { kind: 'nonsense' } },
    ]);
    const ctx = createExecutionContext();
    await handleReconcileBatch(batch, { env: testEnv, ctx, log: quietLog });
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toEqual(['r-1', 'r-2', 'r-3']);
    // One provider call, and the cadence resumes from the tracker's clock.
    expect(await adbCalls(flight)).toBe(2);
    expect(await tracker.alarmAt()).toBe(clock + 4 * HOUR_MS);
    expect((await tracker.stub.getCostLedger()).byTrigger['reconcile']?.calls).toBe(1);
    expect(await adbCalls(finishedFlight)).toBe(finishedCallsBefore);
  });

  it('finishes a tracker abandoned at its last slot, +22 h alarm included (L12)', async () => {
    const flight = uniqueFlight();
    // Seeded half an hour after arrival: one tail poll left, whose alarm then dies.
    const tracker = await seededTracker(flight, flight.scheduledIn.getTime() + HOUR_MS / 2);
    await runInDurableObject(tracker.stub, (_instance, state) => state.storage.deleteAlarm());
    expect(await tracker.alarmAt()).toBeNull();
    const late = flight.scheduledIn.getTime() + 3 * HOUR_MS;
    await tracker.setClock(late);
    await scriptAdb(flight, [adbOk(flight, { phase: 'arrived' })]);

    const batch = createMessageBatch('planeahead-reconcile-local', [
      {
        id: 'r-last',
        timestamp: new Date(),
        attempts: 1,
        body: { kind: 'reconcile_flight', flightKey: flight.flightKey },
      },
    ]);
    const ctx = createExecutionContext();
    await handleReconcileBatch(batch, { env: testEnv, ctx, log: quietLog });

    expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(['r-last']);
    expect(await adbCalls(flight)).toBe(2);
    const health = await tracker.stub.health();
    expect(health.phase).toBe('finished');
    expect(health.alarmAt).toBe(new Date(late + FINISH_ALARM_MS).toISOString());
    // Postgres sees a finished registry row, never a landed one with no refresh due.
    const db = openDb(testEnv);
    for (let i = 0; i < tracker.outbox.sent.length; i += 100) {
      await handlePersistBatch(
        createMessageBatch(
          'planeahead-persist-local',
          tracker.outbox.sent.slice(i, i + 100).map((body, index) => ({
            id: `p-${String(i + index)}`,
            timestamp: new Date(),
            attempts: 1,
            body,
          })),
        ),
        { env: testEnv, ctx: createExecutionContext(), log: quietLog },
        { db },
      );
    }
    const [row] = await db
      .select({ trackingState: flightInstances.trackingState })
      .from(flightInstances)
      .where(eq(flightInstances.flightKey, flight.flightKey));
    expect(row).toEqual({ trackingState: 'finished' });
  });
});

describe('reconcile cron', () => {
  it('pages overdue active rows to the queue and skips the current and the finished ones', async () => {
    const db = openDb(testEnv);
    const now = Date.now();
    const overdue = uniqueFlight();
    const current = uniqueFlight();
    const finished = uniqueFlight();
    const nullStale = uniqueFlight();
    const nullFresh = uniqueFlight();
    const rowFor = (
      flight: TestFlight,
      trackingState: string,
      nextRefreshAt: string | null,
      updatedAt?: string,
    ) => ({
      operatingCarrierIcao: 'AAL',
      flightNumber: flight.number,
      scheduledDepartureDate: flight.dateLocal,
      originIcao: 'KJFK',
      trackingState,
      nextRefreshAt,
      version: 1,
      ...(updatedAt === undefined ? {} : { updatedAt }),
    });
    const stale = new Date(now - RECONCILE_OVERDUE_MS - 60_000).toISOString();
    await db.insert(flightInstances).values([
      rowFor(overdue, 'tracking', stale),
      rowFor(current, 'airborne', new Date(now - RECONCILE_OVERDUE_MS + 60_000).toISOString()),
      rowFor(finished, 'finished', new Date(now - 2 * RECONCILE_OVERDUE_MS).toISOString()),
      // A NULL next_refresh_at on an active row (ruling L12): selected once its updated_at is
      // old, never while it is fresh. (The set_updated_at trigger only stamps UPDATEs, so an
      // INSERT may carry the old instant.)
      rowFor(nullStale, 'landed', null, stale),
      rowFor(nullFresh, 'landed', null),
    ]);
    const sent: { flightKey: string }[] = [];
    const sink = {
      sendBatch: (messages: Iterable<MessageSendRequest<unknown>>) => {
        for (const message of messages) {
          sent.push(message.body as { flightKey: string });
        }
        return Promise.resolve();
      },
    } as unknown as Pick<Queue, 'sendBatch'>;

    const result = await runReconcileCron(
      { env: testEnv, ctx: createExecutionContext(), log: quietLog },
      { db, sink, now: () => now },
    );

    expect(result.truncated).toBe(false);
    expect(result.sent).toBe(result.candidates);
    const keys = sent.map((m) => m.flightKey);
    expect(keys).toContain(overdue.flightKey);
    expect(keys).toContain(nullStale.flightKey);
    expect(keys).not.toContain(nullFresh.flightKey);
    expect(keys).not.toContain(current.flightKey);
    expect(keys).not.toContain(finished.flightKey);
  });

  it('stops at the wall budget and reports the scan as truncated', async () => {
    let calls = 0;
    const result = await runReconcileCron(
      { env: testEnv, ctx: createExecutionContext(), log: quietLog },
      {
        db: openDb(testEnv),
        sink: { sendBatch: () => Promise.resolve() } as unknown as Pick<Queue, 'sendBatch'>,
        // The clock leaps past the budget on the second read.
        now: () => {
          calls += 1;
          return calls === 1 ? 1_000 : 1_000 + 26_000;
        },
      },
    );
    expect(result).toMatchObject({ truncated: true, pages: 0, sent: 0 });
  });
});
