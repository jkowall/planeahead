/**
 * The FlightTracker's whole life on cadence A2: created by a search at T-48 h (the resolver's
 * one AeroDataBox call), walked alarm by alarm through the hourly, 15-minute, 30-minute and tail
 * windows with an injected clock and the fake gateway answering an on-time flight, to `finished`
 * and `deleteAll()`.
 *
 * What is asserted, and why each one is the point of increment 7:
 *
 *   - the provider call count, read from the fake gateway (never from a counter inside the
 *     isolate), equals `A2_EXPECTED_POLLS` from `@planeahead/shared`: the creation fetch plus
 *     every alarm poll, so the cadence module and the tracker agree to the call;
 *   - two subscribers cause no extra call: the invariant this object exists for;
 *   - a repeated alarm at the same clock is a no-op (no call, no version change);
 *   - the version only ever increases, and the persist consumer applies the rows monotonically
 *     into Postgres, confirming each batch back to the tracker so the outbox drains;
 *   - rows written over the whole life stay under `ROWS_WRITTEN_BUDGET_PER_FLIGHT`, with the
 *     per-alarm numbers stored on the `attempts` rows;
 *   - the finish path archives the events to R2, sets `finished`, and the +22 h alarm deletes
 *     everything.
 *
 * The persist consumer runs after every alarm against the real database with one client for the
 * whole test (a batch would otherwise open a client each, and 74 lingering connections would
 * crowd the embedded cluster).
 */

import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  runInDurableObject,
} from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { flightEvents, flightInstances, openDb } from '@planeahead/db';
import { afterEach, describe, expect, it } from 'vitest';
import {
  A2_EXPECTED_POLLS,
  CADENCE_A2,
  NotifyIntentV1,
  RPC_SCHEMA_VERSION,
  expectedCalls,
  parseFlightTrackerOrigin,
  type ConfirmPersistedRequestV1,
} from '@planeahead/shared';
import {
  FINISH_ALARM_MS,
  FINISH_RETRY_MS,
  ROWS_WRITTEN_BUDGET_PER_FLIGHT,
  type FlightTracker,
} from '../../src/do/flight-tracker';
import { createLogger } from '../../src/observability/log';
import { handlePersistBatch, type ConfirmingTracker } from '../../src/queues/persist';
import { eventsArchiveKey } from '../../src/r2/archive';
import {
  HOUR_MS,
  adbCalls,
  adbFlightContract,
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
  type OnTimePhase,
  type TestFlight,
  type TrackerHarness,
} from './helpers/flights';

afterEach(drainTouched);

const quietLog = createLogger({}, () => undefined);

interface Walk {
  versions: number[];
  phases: string[];
  alarmsRun: number;
  maxBatchMessages: number;
  maxMessageBytes: number;
  instanceBytes: number[];
}

/** Scripts the gateway for the on-time phase at `clock` when it changed. */
async function scriptFor(
  flight: TestFlight,
  clock: number,
  last: { phase: OnTimePhase | null },
): Promise<void> {
  const phase = onTimePhaseAt(flight, clock);
  if (phase !== last.phase) {
    await scriptAdb(flight, [adbOk(flight, { phase })]);
    last.phase = phase;
  }
}

describe('FlightTracker lifecycle (A2, created at T-48 h)', () => {
  it('walks creation to deleteAll with exactly A2_EXPECTED_POLLS provider calls', async () => {
    const flight = uniqueFlight();
    const creation = flight.scheduledOut.getTime() - 48 * HOUR_MS;
    const last: { phase: OnTimePhase | null } = { phase: null };
    await scriptFor(flight, creation, last);

    // The tracker's clock and outbox seam go in BEFORE the search creates it (the resolver's
    // seed lands on this same in-memory object), and the daily budget's per-second limit is
    // lifted for the days the walk touches.
    const tracker = await trackerHarness(flight.flightKey, creation);
    await openBudgetFor(flight, creation);

    // Creation: the search resolves through the DesignatorResolver (one provider call) and
    // seeds the tracker; the tracker's first alarm is the next cadence slot, T-47 h.
    const resolver = await resolverHarness(flight, creation);
    const resolved = await resolver.stub.resolve({
      rpcVersion: RPC_SCHEMA_VERSION,
      designator: flight.designator,
      dateLocal: flight.dateLocal,
    });
    expect(resolved.outcome).toBe('resolved');
    expect(resolved.flightKey).toBe(flight.flightKey);
    expect(resolved.created).toBe(true);
    expect(await adbCalls(flight)).toBe(1);

    expect(await tracker.alarmAt()).toBe(creation + HOUR_MS);
    const initial = await tracker.stub.getState();
    expect(initial.phase).toBe('scheduled');
    expect(initial.version).toBe(1);
    const epochMs =
      (await tracker.rows<{ created_at_ms: number }>('SELECT created_at_ms FROM flight'))[0]
        ?.created_at_ms ?? 0;

    // Two subscribers: one flight, one object, one call per refresh.
    for (const user of ['user-a', 'user-b']) {
      const response = await tracker.stub.subscribe({
        rpcVersion: RPC_SCHEMA_VERSION,
        subscriptionId: crypto.randomUUID(),
        userId: user,
      });
      expect(response.status).toBe('subscribed');
    }
    expect((await tracker.stub.health()).subscriberCount).toBe(2);

    // The persist consumer, fed from the captured outbox after every alarm with one database
    // client for the whole walk; its confirmations drain the tracker's outbox.
    const db = openDb(testEnv);
    const persistCaptured = async (harness: TrackerHarness): Promise<void> => {
      const pending = harness.outbox.sent.splice(0);
      for (let i = 0; i < pending.length; i += 100) {
        const batch = createMessageBatch(
          'planeahead-persist-local',
          pending.slice(i, i + 100).map((body, index) => ({
            id: `m-${String(i + index)}-${crypto.randomUUID()}`,
            timestamp: new Date(),
            attempts: 1,
            body,
          })),
        );
        const ctx = createExecutionContext();
        await handlePersistBatch(batch, { env: testEnv, ctx, log: quietLog }, { db });
        // The instance row precedes the events of its transaction, so nothing is ever retried
        // for want of an instance (review finding outbox-and-data-flow-7).
        expect((await getQueueResult(batch, ctx)).retryMessages).toEqual([]);
      }
    };
    // The resolver's own call record goes the same way.
    for (let i = 0; i < resolver.outbox.sent.length; i += 100) {
      await handlePersistBatch(
        createMessageBatch(
          'planeahead-persist-local',
          resolver.outbox.sent.slice(i, i + 100).map((body, index) => ({
            id: `r-${String(index)}-${crypto.randomUUID()}`,
            timestamp: new Date(),
            attempts: 1,
            body,
          })),
        ),
        { env: testEnv, ctx: {} as ExecutionContext, log: quietLog },
        { db },
      );
    }
    await persistCaptured(tracker);

    // A repeated alarm at the same clock: the pool runs the handler again although the next
    // slot is an hour away. No call, no version change, the schedule kept.
    expect(await tracker.runAlarm()).toBe(true);
    expect(await adbCalls(flight)).toBe(1);
    expect((await tracker.stub.getState()).version).toBe(1);
    expect(await tracker.alarmAt()).toBe(creation + HOUR_MS);

    // The walk.
    const walk: Walk = {
      versions: [initial.version ?? 0],
      phases: [initial.phase],
      alarmsRun: 0,
      maxBatchMessages: 0,
      maxMessageBytes: 0,
      instanceBytes: [],
    };
    let finishedAt: number | null = null;
    let clock = creation;
    for (let guard = 0; guard < 200; guard += 1) {
      const alarmAt = await tracker.alarmAt();
      if (alarmAt === null) {
        break;
      }
      clock = alarmAt;
      await tracker.setClock(clock);
      await scriptFor(flight, clock, last);
      expect(await tracker.runAlarm()).toBe(true);
      walk.alarmsRun += 1;
      // The +22 h alarm deletes everything; a `health()` on the deleted object would recreate
      // the empty schema (and arm its own cleanup), so the raw table list is checked first.
      if ((await tracker.tables()).length === 0) {
        break;
      }
      const health = await tracker.stub.health();
      const stats = await runInDurableObject(
        tracker.stub,
        (instance: FlightTracker) => instance.flushStats,
      );
      walk.maxBatchMessages = Math.max(walk.maxBatchMessages, stats.maxMessagesPerBatch);
      walk.maxMessageBytes = Math.max(walk.maxMessageBytes, stats.maxMessageBytes);
      for (const message of ofKind(tracker.outbox.sent, 'flight_instance')) {
        walk.instanceBytes.push(JSON.stringify(message).length);
      }
      if (health.phase !== 'absent') {
        walk.versions.push(health.version);
        walk.phases.push(health.phase);
        if (health.phase === 'finished' && finishedAt === null) {
          finishedAt = clock;
        }
      }
      await persistCaptured(tracker);
    }

    // 1. The call count, from the gateway: creation plus every alarm poll.
    const polls = await adbCalls(flight);
    expect(polls).toBe(A2_EXPECTED_POLLS);
    expect(expectedCalls(CADENCE_A2, { leadTimeDays: 2 }).polls).toBe(polls);

    // 2. Monotonic version, the phases in order, finished then deleted.
    for (let i = 1; i < walk.versions.length; i += 1) {
      expect(walk.versions[i] ?? 0).toBeGreaterThanOrEqual(walk.versions[i - 1] ?? 0);
    }
    const distinctPhases = walk.phases.filter(
      (phase, i) => i === 0 || phase !== walk.phases[i - 1],
    );
    expect(distinctPhases).toEqual(['scheduled', 'boarding', 'en_route', 'arrived', 'finished']);
    expect(finishedAt).toBe(flight.scheduledIn.getTime() + HOUR_MS);
    // The last alarm run was the +22 h one: it found the outbox confirmed and deleted everything.
    expect(await tracker.tables()).toEqual([]);
    expect(await tracker.alarmAt()).toBeNull();

    // 3. The events archive landed in R2, under this lifetime's key, with the whole timeline.
    const archiveKey = eventsArchiveKey(flight.flightKey, epochMs);
    const archive = await testEnv.PRIVATE_BUCKET.get(archiveKey);
    expect(archive).not.toBeNull();
    const archived = (await archive?.json()) as { flightKey: string; events: { type: string }[] };
    expect(archived.flightKey).toBe(flight.flightKey);
    expect(archived.events.map((e) => e.type)).toContain('created');
    expect(archived.events.map((e) => e.type)).toContain('finished');
    // scheduled to boarding, boarding to en_route (off and out arrive together), en_route to arrived.
    expect(archived.events.filter((e) => e.type === 'status_changed')).toHaveLength(3);

    // 4. Postgres: the instance row is the final one, monotonic by version, events persisted.
    const [row] = await db
      .select()
      .from(flightInstances)
      .where(eq(flightInstances.flightKey, flight.flightKey));
    expect(row).toBeDefined();
    expect(row?.trackingState).toBe('finished');
    expect(row?.status).toBe('arrived');
    expect(row?.version).toBe(walk.versions.at(-1));
    expect(row?.eventsR2Key).toBe(archiveKey);
    expect(row?.doLifetimeEpochMs).toBe(epochMs);
    expect(row?.actualIn).toBe(flight.scheduledIn.toISOString().replace('.000Z', 'Z'));
    const events = await db
      .select({ seq: flightEvents.seq, type: flightEvents.type })
      .from(flightEvents)
      .where(eq(flightEvents.flightInstanceId, row?.id ?? ''));
    expect(events.length).toBe(archived.events.length);
    expect(tracker.outbox.sent).toEqual([]);

    // 5. Rows written: the budgeted number (ruling J5), from the instance's lifetime counter
    //    (every entry point: seed, subscribes, alarms, confirmations, the finish path).
    const lifetime = await runInDurableObject(tracker.stub, (instance: FlightTracker) => ({
      written: instance.rowsWrittenLifetime,
      read: instance.rowsReadLifetime,
    }));
    expect(lifetime.written).toBeLessThan(ROWS_WRITTEN_BUDGET_PER_FLIGHT);
    // A touch after deletion recreates the empty schema, answers `absent`, and arms its own
    // cleanup alarm (drained by afterEach).
    expect((await tracker.stub.health()).phase).toBe('absent');
    console.log(
      `[lifecycle] polls=${String(polls)} alarms=${String(walk.alarmsRun)} rows_written_lifetime=${String(lifetime.written)} ` +
        `rows_read_lifetime=${String(lifetime.read)} per_alarm_avg=${(lifetime.written / walk.alarmsRun).toFixed(1)} ` +
        `max_batch_messages=${String(walk.maxBatchMessages)} max_message_bytes=${String(walk.maxMessageBytes)} ` +
        `instance_message_bytes_median=${String(walk.instanceBytes.sort((a, b) => a - b)[Math.floor(walk.instanceBytes.length / 2)] ?? 0)}`,
    );
    // 74 alarms, each an RPC round trip into the object plus a fake-gateway call: past the 60 s
    // file default under full host parallelism, so the walk carries its own budget.
  }, 180_000);

  it('stores the per-alarm row counters on the attempts rows and holds them under budget', async () => {
    const flight = uniqueFlight();
    const creation = flight.scheduledOut.getTime() - 48 * HOUR_MS;
    await scriptAdb(flight, [adbOk(flight, { phase: 'expected' })]);
    const tracker = await trackerHarness(flight.flightKey, creation);
    await openBudgetFor(flight, creation);
    const resolver = await resolverHarness(flight, creation);
    await resolver.stub.resolve({
      rpcVersion: RPC_SCHEMA_VERSION,
      designator: flight.designator,
      dateLocal: flight.dateLocal,
    });
    // Confirms every sent row straight back, as the persist consumer would.
    const confirm = async (): Promise<void> => {
      const pending = tracker.outbox.sent.splice(0);
      const epochMs = pending
        .map((message) => parseFlightTrackerOrigin(message.origin)?.epochMs)
        .find((epoch): epoch is number => epoch !== undefined);
      if (epochMs !== undefined) {
        const result = await tracker.stub.confirmPersisted({
          rpcVersion: RPC_SCHEMA_VERSION,
          epochMs,
          seqs: pending.map((message) => message.seq),
        });
        expect(result.matched).toBe(true);
      }
    };
    await confirm();
    let clock = creation;
    for (let i = 0; i < 5; i += 1) {
      clock += HOUR_MS;
      await tracker.setClock(clock);
      expect(await tracker.runAlarm()).toBe(true);
      await confirm();
    }
    const attempts = await tracker.rows<{
      slot_ms: number;
      outcome: string;
      rows_written: number;
      rows_read: number;
    }>('SELECT slot_ms, outcome, rows_written, rows_read FROM attempts ORDER BY slot_ms');
    expect(attempts).toHaveLength(5);
    expect(attempts.map((a) => a.outcome)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(attempts.map((a) => a.slot_ms)).toEqual(
      [1, 2, 3, 4, 5].map((h) => creation + h * HOUR_MS),
    );
    for (const attempt of attempts) {
      expect(attempt.rows_written).toBeGreaterThan(0);
      expect(attempt.rows_written).toBeLessThan(ROWS_WRITTEN_BUDGET_PER_FLIGHT / A2_EXPECTED_POLLS);
    }
    console.log(
      `[lifecycle] attempts rows_written: ${attempts.map((a) => a.rows_written).join(',')}`,
    );
  });
});

describe('a notify intent through the outbox (increment 15, N7)', () => {
  it('is written once under alarm retries, and the finished tracker deletes only once it is confirmed', async () => {
    const flight = uniqueFlight();
    const creation = flight.scheduledOut.getTime() - 2 * HOUR_MS;
    await scriptAdb(flight, [adbOk(flight, { phase: 'expected' })]);
    const tracker = await trackerHarness(flight.flightKey, creation);
    await openBudgetFor(flight, creation);
    const resolver = await resolverHarness(flight, creation);
    await resolver.stub.resolve({
      rpcVersion: RPC_SCHEMA_VERSION,
      designator: flight.designator,
      dateLocal: flight.dateLocal,
    });
    const contract = adbFlightContract(flight, { phase: 'expected' }) as Record<string, unknown>;
    await scriptAdb(flight, [{ status: 200, body: [{ ...contract, status: 'Canceled' }] }]);
    // The suspicion and then its confirming re-read, each alarm delivered again by the platform
    // at once and past the resend grace: neither retry reads the provider or writes an intent.
    let confirmedAt = 0;
    for (let alarm = 0; alarm < 2; alarm += 1) {
      confirmedAt = (await tracker.alarmAt()) ?? 0;
      await tracker.setClock(confirmedAt);
      expect(await tracker.runAlarm()).toBe(true);
      await tracker.retryAlarm(1);
      await tracker.setClock(confirmedAt + 20_000);
      await tracker.retryAlarm(2);
    }
    expect(await adbCalls(flight)).toBe(3);
    expect((await tracker.stub.health()).phase).toBe('finished');
    const intents = ofKind(tracker.outbox.sent, 'notify_intent');
    expect(new Set(intents.map((m) => m.seq)).size).toBe(1);
    expect(await tracker.rows('SELECT dedupe_key FROM notif_dedupe')).toHaveLength(1);
    const intentSeq = intents[0]?.seq;

    // The persist consumer, its notify forward failing: every other row is written and
    // confirmed, the intent is retried and confirmed by nobody.
    const db = openDb(testEnv);
    const forwarded: unknown[] = [];
    let notifyUp = false;
    const notifyQueue = {
      send: (body: unknown): Promise<void> => {
        if (!notifyUp) {
          return Promise.reject(new Error('notify unavailable'));
        }
        forwarded.push(body);
        return Promise.resolve();
      },
    };
    const confirmations: ConfirmPersistedRequestV1[] = [];
    const trackerFor = (): ConfirmingTracker => ({
      confirmPersisted: (input) => {
        confirmations.push(input as ConfirmPersistedRequestV1);
        return tracker.stub.confirmPersisted(input);
      },
    });
    const persistSent = async () => {
      const pending = tracker.outbox.sent.splice(0);
      const batch = createMessageBatch(
        'planeahead-persist-local',
        pending.map((body, index) => ({
          id: `n-${String(index)}-${crypto.randomUUID()}`,
          timestamp: new Date(),
          attempts: 1,
          body,
        })),
      );
      const ctx = createExecutionContext();
      const env = { env: testEnv, ctx, log: quietLog };
      await handlePersistBatch(batch, env, { db, notifyQueue, trackerFor });
      const result = await getQueueResult(batch, ctx);
      const byId = new Map(batch.messages.map((m) => [m.id, m.body as { kind: string }]));
      return result.retryMessages.map((m) => byId.get(m.msgId)?.kind);
    };
    const retried = await persistSent();
    expect(retried.length).toBeGreaterThan(0);
    expect(new Set(retried)).toEqual(new Set(['notify_intent']));
    expect((await tracker.stub.health()).unconfirmedOutbox).toBe(1);
    expect(confirmations.flatMap((c) => c.seqs)).not.toContain(intentSeq);

    // The +22 h alarm finds the intent unconfirmed: it defers, it does not delete.
    await tracker.setClock(confirmedAt + FINISH_ALARM_MS);
    expect(await tracker.runAlarm()).toBe(true);
    expect((await tracker.tables()).length).toBeGreaterThan(0);
    expect(await tracker.alarmAt()).toBe(confirmedAt + FINISH_ALARM_MS + FINISH_RETRY_MS);

    // The notify queue is back: the re-sent row is forwarded, then confirmed, once.
    notifyUp = true;
    expect(await persistSent()).toEqual([]);
    expect(forwarded).toHaveLength(1);
    expect(NotifyIntentV1.parse(forwarded[0])).toMatchObject({
      flightKey: flight.flightKey,
      intent: { kind: 'cancellation', value: 'cancelled' },
      test: false,
    });
    expect(confirmations.flatMap((c) => c.seqs).filter((seq) => seq === intentSeq)).toHaveLength(1);
    expect((await tracker.stub.health()).unconfirmedOutbox).toBe(0);

    // The deferred finish alarm now deletes everything.
    await tracker.setClock(confirmedAt + FINISH_ALARM_MS + FINISH_RETRY_MS);
    expect(await tracker.runAlarm()).toBe(true);
    expect(await tracker.tables()).toEqual([]);
  });
});
