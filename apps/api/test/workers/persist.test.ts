/**
 * The persist consumer against the real database: idempotent and monotonic under duplicate and
 * reordered delivery, an event that arrives before its instance is retried (not lost, not
 * acknowledged), a bad Analytics Engine point never fails a batch, the confirmation round trip
 * to a real FlightTracker drains its outbox, and the ProviderBudget's daily row lands in
 * `provider_call_daily`.
 *
 * Every flight key is unique (a 2100s date and a random number), so this file runs in parallel
 * with every other file against the one test database.
 */

import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test';
import { and, eq } from 'drizzle-orm';
import {
  flightEvents,
  flightInstances,
  openDb,
  providerCallDaily,
  providerCalls,
} from '@planeahead/db';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NotifyIntentV1,
  RPC_SCHEMA_VERSION,
  flightTrackerOrigin,
  uuidv7,
  type FlightInstanceOutboxPayloadV1,
  type FlightKey,
  type PersistMessageV1Input,
  type ProviderCallRecord,
} from '@planeahead/shared';
import { createLogger } from '../../src/observability/log';
import { handleNotifyBatch } from '../../src/queues/notify';
import { handlePersistBatch, type ConfirmingTracker } from '../../src/queues/persist';
import { makeStatus } from '../../../../packages/shared/test/fixtures';
import {
  HOUR_MS,
  adbOk,
  drainTouched,
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
const EPOCH = 4_102_444_800_000;

function instancePayload(
  flight: TestFlight,
  version: number,
  overrides: Partial<FlightInstanceOutboxPayloadV1> = {},
): FlightInstanceOutboxPayloadV1 {
  return {
    operatingCarrierIcao: 'AAL',
    flightNumber: flight.number,
    scheduledDepartureDate: flight.dateLocal,
    originIcao: 'KJFK',
    legSeq: 1,
    version,
    phase: 'scheduled',
    trackingState: 'tracking',
    refreshCadence: 'A2',
    nextRefreshAt: new Date(flight.scheduledOut.getTime() - HOUR_MS).toISOString(),
    lastRefreshedAt: null,
    doSchemaVersion: 1,
    snapshot: makeStatus({
      key: flight.flightKey,
      flightNumber: flight.number,
      times: {
        scheduledOut: flight.scheduledOut.toISOString(),
        scheduledIn: flight.scheduledIn.toISOString(),
      },
      fetchedAt: new Date(flight.scheduledOut.getTime() - 48 * HOUR_MS).toISOString(),
    }),
    providerCallCount: version,
    providerCostUnits: 2 * version,
    subscriberCount: 0,
    operatorSource: 'provider',
    finishedAt: null,
    eventsR2Key: null,
    ...overrides,
  };
}

function message(
  flight: TestFlight,
  seq: number,
  body: Omit<PersistMessageV1Input, 'seq' | 'origin'>,
): PersistMessageV1Input {
  return {
    ...body,
    seq,
    origin: flightTrackerOrigin(flight.flightKey, EPOCH),
  } as PersistMessageV1Input;
}

function callRecord(
  flightKey: FlightKey,
  overrides: Partial<ProviderCallRecord> = {},
): ProviderCallRecord {
  return {
    id: uuidv7(),
    provider: 'aerodatabox',
    operation: 'flight_status',
    trigger: 'alarm',
    flightKey,
    requestId: 'req-persist',
    startedAt: '2100-01-01T12:00:00.000Z',
    latencyMs: 120,
    httpStatus: 200,
    result: 'ok',
    costUnits: 2,
    pollEquivalents: 0.1,
    estCostUsdMicros: 500,
    ...overrides,
  };
}

async function run(
  bodies: readonly unknown[],
  options: {
    env?: typeof testEnv;
    capture?: (text: string, context: unknown) => void;
    trackerFor?: (flightKey: FlightKey) => ConfirmingTracker;
    notifyQueue?: { send(body: unknown): Promise<unknown> };
  } = {},
) {
  const batch = createMessageBatch(
    'planeahead-persist-local',
    bodies.map((body, index) => ({
      id: `m-${String(index)}`,
      timestamp: new Date(),
      attempts: 1,
      body,
    })),
  );
  const ctx = createExecutionContext();
  await handlePersistBatch(
    batch,
    { env: options.env ?? testEnv, ctx, log: quietLog },
    { capture: options.capture, trackerFor: options.trackerFor, notifyQueue: options.notifyQueue },
  );
  return getQueueResult(batch, ctx);
}

/** A FlightTracker's `notify_intent` outbox row (increment 15), as the tracker sends it. */
function notifyIntentMessage(flight: TestFlight, seq: number): PersistMessageV1Input {
  const flightKey = flight.flightKey;
  return message(flight, seq, {
    kind: 'notify_intent',
    flightKey,
    payload: {
      kind: 'notify_intent',
      flightKey,
      dedupeKey: `${flightKey}:gate_change:origin:B12:v7`,
      intent: {
        kind: 'gate_change',
        subject: 'origin',
        value: 'B12',
        previousValue: 'B10',
        correction: false,
        firstAssignment: false,
        timeSensitive: true,
        expiresAt: flight.scheduledOut.toISOString(),
        dedupeValue: 'origin:B12',
      },
      flight: {
        operatingCarrierIcao: 'AAL',
        flightNumber: flight.number,
        origin: { icao: 'KJFK', iata: 'JFK' },
        destination: { icao: 'EGLL', iata: 'LHR' },
        status: 'scheduled',
        times: { scheduledOut: flight.scheduledOut.toISOString() },
        originGate: 'B12',
      },
      producedAt: new Date(flight.scheduledOut.getTime() - HOUR_MS).toISOString(),
    },
  });
}

describe('persist consumer', () => {
  it('applies instance rows monotonically under duplicate and reordered delivery', async () => {
    const flight = uniqueFlight();
    const db = openDb(testEnv);
    const v1 = message(flight, 1, {
      kind: 'flight_instance',
      flightKey: flight.flightKey,
      payload: instancePayload(flight, 1),
    });
    const v2 = message(flight, 3, {
      kind: 'flight_instance',
      flightKey: flight.flightKey,
      payload: instancePayload(flight, 2, { phase: 'boarding', trackingState: 'tracking' }),
    });
    const v3 = message(flight, 5, {
      kind: 'flight_instance',
      flightKey: flight.flightKey,
      payload: instancePayload(flight, 3, { phase: 'en_route', trackingState: 'airborne' }),
    });

    // Out of order, with a duplicate: v2, v3, v1 (stale), v3 (dup).
    const result = await run([v2, v3, v1, v3]);

    expect(result.explicitAcks).toEqual(['m-0', 'm-1', 'm-2', 'm-3']);
    expect(result.retryMessages).toEqual([]);
    const [row] = await db
      .select({
        version: flightInstances.version,
        trackingState: flightInstances.trackingState,
        providerCallCount: flightInstances.providerCallCount,
        flightKey: flightInstances.flightKey,
      })
      .from(flightInstances)
      .where(eq(flightInstances.flightKey, flight.flightKey));
    expect(row).toEqual({
      version: 3,
      trackingState: 'airborne',
      providerCallCount: 3,
      flightKey: flight.flightKey,
    });
  });

  it('inserts events and provider calls once, and retries an event whose instance is not there yet', async () => {
    const flight = uniqueFlight();
    const db = openDb(testEnv);
    const event = message(flight, 2, {
      kind: 'flight_event',
      flightKey: flight.flightKey,
      payload: {
        occurredAt: '2100-01-01T12:00:00.000Z',
        type: 'status_changed',
        field: 'status',
        oldValue: 'scheduled',
        newValue: 'boarding',
        source: 'aerodatabox',
        providerCallId: null,
      },
    });
    const call = callRecord(flight.flightKey);
    const callMessage = message(flight, 4, {
      kind: 'provider_call',
      flightKey: flight.flightKey,
      payload: call,
    });

    // The event lands before its instance row: retried, not acknowledged, not lost.
    const early = await run([event, callMessage]);
    expect(early.retryMessages.map((m) => m.msgId)).toEqual(['m-0']);
    expect(early.explicitAcks).toEqual(['m-1']);

    const instance = message(flight, 1, {
      kind: 'flight_instance',
      flightKey: flight.flightKey,
      payload: instancePayload(flight, 1),
    });
    const later = await run([instance, event, event, callMessage, callMessage]);
    expect(later.explicitAcks).toEqual(['m-0', 'm-1', 'm-2', 'm-3', 'm-4']);

    const [row] = await db
      .select({ id: flightInstances.id })
      .from(flightInstances)
      .where(eq(flightInstances.flightKey, flight.flightKey));
    const events = await db
      .select({ seq: flightEvents.seq, type: flightEvents.type })
      .from(flightEvents)
      .where(eq(flightEvents.flightInstanceId, row?.id ?? ''));
    expect(events).toEqual([{ seq: 2, type: 'status_changed' }]);
    const calls = await db
      .select({ id: providerCalls.id, flightInstanceId: providerCalls.flightInstanceId })
      .from(providerCalls)
      .where(eq(providerCalls.id, call.id));
    // The first delivery came before the instance existed, so the row carries no instance id;
    // the record is stored once and the later delivery is a no-op.
    expect(calls).toEqual([{ id: call.id, flightInstanceId: null }]);
  });

  it('a bad Analytics Engine point never fails a batch', async () => {
    const flight = uniqueFlight();
    let attempted = 0;
    const throwing = {
      writeDataPoint: () => {
        attempted += 1;
        throw new Error('too many blobs');
      },
    } as unknown as AnalyticsEngineDataset;
    const bodies = [1, 2, 3].map((seq) =>
      message(flight, seq, {
        kind: 'provider_call',
        flightKey: flight.flightKey,
        payload: callRecord(flight.flightKey, { operation: 'x'.repeat(20_000) }),
      }),
    );

    const result = await run(bodies, { env: { ...testEnv, PROVIDER_CALLS: throwing } });

    expect(attempted).toBe(3);
    expect(result.explicitAcks).toEqual(['m-0', 'm-1', 'm-2']);
    expect(result.retryMessages).toEqual([]);
  });

  it('acknowledges a message it cannot read rather than retrying it for ever, and confirms it', async () => {
    const flight = uniqueFlight();
    const confirmed: unknown[] = [];
    const trackerFor = (flightKey: FlightKey): ConfirmingTracker => ({
      confirmPersisted: (input) => {
        confirmed.push({ flightKey, input });
        return Promise.resolve({
          rpcVersion: RPC_SCHEMA_VERSION,
          deleted: 1,
          remaining: 0,
          matched: true,
        });
      },
    });

    const result = await run(
      [
        { kind: 'flight_upsert', seq: 1, origin: flightTrackerOrigin(flight.flightKey, EPOCH) },
        'not even an object',
        { kind: 'flight_event', seq: 2, origin: 'nobody' },
      ],
      { trackerFor },
    );

    expect(result.explicitAcks).toEqual(['m-0', 'm-1', 'm-2']);
    // Only the envelope that names a tracker lifetime is confirmed; nothing will ever write that
    // row, and unconfirmed it would pin its finished tracker for ever.
    expect(confirmed).toEqual([
      {
        flightKey: flight.flightKey,
        input: { rpcVersion: RPC_SCHEMA_VERSION, epochMs: EPOCH, seqs: [1] },
      },
    ]);
  });

  it('forwards a notify_intent to the notify queue, and confirms it only after the send (N7)', async () => {
    const flight = uniqueFlight();
    const order: string[] = [];
    const trackerFor = (): ConfirmingTracker => ({
      confirmPersisted: (input) => {
        order.push(`confirm:${(input as { seqs: number[] }).seqs.join(',')}`);
        return Promise.resolve({
          rpcVersion: RPC_SCHEMA_VERSION,
          deleted: 1,
          remaining: 0,
          matched: true,
        });
      },
    });
    const intent = notifyIntentMessage(flight, 7);

    // A failed forward: the message is retried and nothing is confirmed.
    const failing = { send: () => Promise.reject(new Error('notify unavailable')) };
    const failed = await run([intent], { trackerFor, notifyQueue: failing });
    expect(failed.retryMessages.map((m) => m.msgId)).toEqual(['m-0']);
    expect(order).toEqual([]);

    // The redelivery: forwarded as it is, then confirmed.
    const forwarded: unknown[] = [];
    const working = {
      send: (body: unknown) => {
        order.push('send');
        forwarded.push(body);
        return Promise.resolve();
      },
    };
    const delivered = await run([intent], { trackerFor, notifyQueue: working });
    expect(delivered.retryMessages).toEqual([]);
    expect(delivered.explicitAcks).toEqual(['m-0']);
    expect(order).toEqual(['send', 'confirm:7']);
    expect(NotifyIntentV1.parse(forwarded[0])).toMatchObject({
      notifyVersion: 1,
      flightKey: flight.flightKey,
      intent: { kind: 'gate_change', value: 'B12' },
      test: false,
    });

    // The notify consumer reads the forwarded intent: nobody follows this flight in Postgres, so it
    // writes and sends nothing, and acknowledges (test/workers/notify.test.ts covers the work).
    const batch = createMessageBatch(
      'planeahead-notify-local',
      forwarded.map((body, index) => ({
        id: `n-${String(index)}`,
        timestamp: new Date(),
        attempts: 1,
        body,
      })),
    );
    const ctx = createExecutionContext();
    await handleNotifyBatch(batch, {
      env: testEnv,
      ctx,
      log: quietLog,
    });
    const notified = await getQueueResult(batch, ctx);
    expect(notified.retryMessages).toEqual([]);
    expect(notified.explicitAcks).toEqual(['n-0']);
  });

  it('confirms the seqs it wrote back to the tracker, which deletes them from its outbox', async () => {
    const flight = uniqueFlight();
    const clock = flight.scheduledOut.getTime() - 48 * HOUR_MS;
    await scriptAdb(flight, [adbOk(flight, { phase: 'expected' })]);
    const tracker = await trackerHarness(flight.flightKey, clock);
    await openBudgetFor(flight, clock);
    const resolver = await resolverHarness(flight, clock);
    await resolver.stub.resolve({
      rpcVersion: RPC_SCHEMA_VERSION,
      designator: flight.designator,
      dateLocal: flight.dateLocal,
    });
    await tracker.setClock(clock + HOUR_MS);
    expect(await tracker.runAlarm()).toBe(true);
    const before = await tracker.stub.health();
    expect(before.unconfirmedOutbox).toBeGreaterThan(0);
    const sent = tracker.outbox.sent.splice(0);
    // The alarm's flush re-sent the seed's rows too (unconfirmed, past the grace): distinct
    // seqs are what is outstanding.
    expect(new Set(sent.map((m) => m.seq)).size).toBe(before.unconfirmedOutbox);

    // Delivered twice, out of order: idempotent writes, one confirmation per tracker lifetime.
    const result = await run([...sent].reverse().concat(sent));

    expect(result.retryMessages).toEqual([]);
    expect(result.explicitAcks).toHaveLength(sent.length * 2);
    expect((await tracker.stub.health()).unconfirmedOutbox).toBe(0);
    // A confirmation for another lifetime of the same key is ignored.
    const foreign = await tracker.stub.confirmPersisted({
      rpcVersion: RPC_SCHEMA_VERSION,
      epochMs: 1,
      seqs: [1, 2, 3],
    });
    expect(foreign).toMatchObject({ matched: false, deleted: 0 });
    const db = openDb(testEnv);
    const [row] = await db
      .select({ version: flightInstances.version, trackingState: flightInstances.trackingState })
      .from(flightInstances)
      .where(eq(flightInstances.flightKey, flight.flightKey));
    expect(row?.trackingState).toBe('tracking');
    expect(row?.version ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('writes one Analytics Engine point per provider call, not per delivery', async () => {
    const flight = uniqueFlight();
    let points = 0;
    const counting: AnalyticsEngineDataset = {
      writeDataPoint: () => {
        points += 1;
      },
    };
    const call = callRecord(flight.flightKey);
    const body = message(flight, 7, {
      kind: 'provider_call',
      flightKey: flight.flightKey,
      payload: call,
    });

    // Delivered twice in one batch and once more in the next: one row, one point.
    const first = await run([body, body], { env: { ...testEnv, PROVIDER_CALLS: counting } });
    const second = await run([body], { env: { ...testEnv, PROVIDER_CALLS: counting } });

    expect(first.explicitAcks).toEqual(['m-0', 'm-1']);
    expect(second.explicitAcks).toEqual(['m-0']);
    expect(points).toBe(1);
    const db = openDb(testEnv);
    const rows = await db
      .select({ id: providerCalls.id })
      .from(providerCalls)
      .where(eq(providerCalls.id, call.id));
    expect(rows).toHaveLength(1);
  });

  it('keeps one provider_call_daily row per ProviderBudget shard, replaced on redelivery (L10)', async () => {
    const day = `21${String(Math.floor(Math.random() * 90)).padStart(2, '0')}-0${String(1 + Math.floor(Math.random() * 9))}-2${String(Math.floor(Math.random() * 8))}`;
    const daily = (shard: number, units: number, calls: number) => ({
      kind: 'provider_budget_daily',
      seq: 1,
      origin: `provider_budget:aerodatabox:${day}:${String(shard)}@1`,
      payload: {
        provider: 'aerodatabox',
        utcDate: day,
        shard,
        units,
        pollEquivalents: units / 20,
        calls,
        releasedUnits: 0,
        byTrigger: { alarm: { units, pe: units / 20, calls } },
        denials: {},
        dailyUnitCap: 1_666,
        finalised: true,
      },
    });

    // Shard 1 twice (a redelivery), shard 0 once, out of order.
    const result = await run([daily(1, 60, 30), daily(0, 40, 20), daily(1, 60, 30)]);

    expect(result.explicitAcks).toEqual(['m-0', 'm-1', 'm-2']);
    const db = openDb(testEnv);
    const rows = await db
      .select({
        operation: providerCallDaily.operation,
        calls: providerCallDaily.calls,
        costUnits: providerCallDaily.costUnits,
      })
      .from(providerCallDaily)
      .where(and(eq(providerCallDaily.day, day), eq(providerCallDaily.provider, 'aerodatabox')))
      .orderBy(providerCallDaily.operation);
    // Per shard, never summed: a summing upsert would have counted shard 1 twice.
    expect(rows).toEqual([
      { operation: 'budget_daily:0', calls: 20, costUnits: 40 },
      { operation: 'budget_daily:1', calls: 30, costUnits: 60 },
    ]);
  });

  it('ignores an older tracker lifetime and refuses a newer one for a finished instance (L9)', async () => {
    const flight = uniqueFlight();
    const db = openDb(testEnv);
    const lifetime = (
      epochMs: number,
      seq: number,
      body: Omit<PersistMessageV1Input, 'seq' | 'origin'>,
    ) =>
      ({
        ...body,
        seq,
        origin: flightTrackerOrigin(flight.flightKey, epochMs),
      }) as PersistMessageV1Input;
    const instance = (
      epochMs: number,
      version: number,
      overrides: Partial<FlightInstanceOutboxPayloadV1>,
    ) =>
      lifetime(epochMs, version, {
        kind: 'flight_instance',
        flightKey: flight.flightKey,
        payload: instancePayload(flight, version, overrides),
      });
    const event = (epochMs: number, seq: number) =>
      lifetime(epochMs, seq, {
        kind: 'flight_event',
        flightKey: flight.flightKey,
        payload: {
          occurredAt: '2100-01-01T12:00:00.000Z',
          type: 'created',
          field: 'trigger',
          newValue: 'user_search',
          source: 'system',
          providerCallId: null,
        },
      });
    const alerts: string[] = [];
    const capture = (text: string) => void alerts.push(text);

    // Lifetime 1000 lives and finishes.
    const lived = await run(
      [
        instance(1000, 1, {}),
        event(1000, 2),
        instance(1000, 3, { phase: 'finished', trackingState: 'finished', nextRefreshAt: null }),
      ],
      { capture },
    );
    expect(lived.explicitAcks).toEqual(['m-0', 'm-1', 'm-2']);
    expect(alerts).toEqual([]);

    // A straggler from lifetime 900 (older) is ignored; a lifetime 2000 (newer) for the finished
    // instance is refused, with one alert for the key; every message is acknowledged.
    const later = await run(
      [instance(900, 9, {}), instance(2000, 1, {}), event(2000, 2), event(2000, 3)],
      { capture },
    );
    expect(later.explicitAcks).toEqual(['m-0', 'm-1', 'm-2', 'm-3']);
    expect(later.retryMessages).toEqual([]);
    expect(alerts).toEqual(['flight_lifetime_rejected']);
    const [row] = await db
      .select({
        version: flightInstances.version,
        trackingState: flightInstances.trackingState,
        epoch: flightInstances.doLifetimeEpochMs,
        id: flightInstances.id,
      })
      .from(flightInstances)
      .where(eq(flightInstances.flightKey, flight.flightKey));
    expect(row).toMatchObject({ version: 3, trackingState: 'finished', epoch: 1000 });
    const events = await db
      .select({ seq: flightEvents.seq })
      .from(flightEvents)
      .where(eq(flightEvents.flightInstanceId, row?.id ?? ''));
    expect(events).toEqual([{ seq: 2 }]);
  });

  it('writes the ProviderBudget daily counters to provider_call_daily, replacing on redelivery', async () => {
    const day = `21${String(Math.floor(Math.random() * 90)).padStart(2, '0')}-0${String(1 + Math.floor(Math.random() * 9))}-1${String(Math.floor(Math.random() * 9))}`;
    const daily = (units: number, calls: number) => ({
      kind: 'provider_budget_daily',
      seq: 1,
      origin: `provider_budget:aerodatabox:${day}@1`,
      payload: {
        provider: 'aerodatabox',
        utcDate: day,
        shard: null,
        units,
        pollEquivalents: units / 20,
        calls,
        releasedUnits: 0,
        byTrigger: { alarm: { units, pe: units / 20, calls } },
        denials: {},
        dailyUnitCap: 13_333,
        finalised: false,
      },
    });
    const captured: string[] = [];
    const result = await run(
      [
        daily(40, 20),
        daily(44, 22),
        {
          kind: 'provider_budget_kill_switch',
          seq: 2,
          origin: `provider_budget:aerodatabox:${day}@1`,
          payload: { provider: 'aerodatabox', utcDate: day, reason: 'daily_cap', atMs: 1 },
        },
      ],
      { capture: (text) => void captured.push(text) },
    );
    expect(result.explicitAcks).toEqual(['m-0', 'm-1', 'm-2']);
    expect(captured).toEqual(['provider_kill_switch_tripped']);
    const db = openDb(testEnv);
    const rows = await db
      .select({
        calls: providerCallDaily.calls,
        costUnits: providerCallDaily.costUnits,
        costUsdMicros: providerCallDaily.costUsdMicros,
        operation: providerCallDaily.operation,
      })
      .from(providerCallDaily)
      .where(and(eq(providerCallDaily.day, day), eq(providerCallDaily.provider, 'aerodatabox')));
    expect(rows).toEqual([
      { calls: 22, costUnits: 44, costUsdMicros: 44 * 250, operation: 'budget_daily' },
    ]);
  });
});
