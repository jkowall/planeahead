/**
 * The 2-concurrently-live-tracked cap where flights actually enter and leave their live window
 * (ruling O3), through the real persist consumer against the embedded Postgres 18.
 *
 * A subscribe takes `live_tracked` only for a flight ALREADY inside its window; a flight that
 * enters it later is charged by the persist consumer on the first instance row that puts it there,
 * and released on the row that says it is over. The crossing is driven here by the consumer's
 * clock (`PersistDeps.now`, two hours after the subscribes) over instance rows from a tracker
 * lifetime later than the seeds', so neither the seeds' own deliveries nor a replay can undo it.
 */

import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  flightTrackerOrigin,
  type FlightInstanceOutboxPayloadV1,
  type FlightKey,
  type PersistMessageV1Input,
} from '@planeahead/shared';
import { createLogger } from '../../src/observability/log';
import { handlePersistBatch, type ConfirmingTracker } from '../../src/queues/persist';
import { signInAnonymously } from './helpers/auth';
import { drainTouched, testEnv, type TestFlight } from './helpers/flights';
import {
  HOUR,
  counterValue,
  db,
  seedTracker,
  seededFlightFor,
  statusFor,
  subscribe,
  type ErrorBody,
  type SubscribeBody,
} from './helpers/routes';

afterEach(drainTouched);

const quietLog = createLogger({}, () => undefined);
/** A tracker lifetime later than any seed's (2100-01-01), so these rows win the lifetime rule. */
const LATER_LIFETIME = 4_102_444_800_000;
/** Confirmations go nowhere: the rows below are not a real tracker's outbox. */
const noConfirm = (): ConfirmingTracker => ({
  confirmPersisted: () =>
    Promise.resolve({ rpcVersion: 1, deleted: 0, remaining: 0, matched: false }),
});

function instanceMessage(
  flight: TestFlight,
  version: number,
  overrides: Partial<Parameters<typeof statusFor>[1]> = {},
  payload: Partial<FlightInstanceOutboxPayloadV1> = {},
): PersistMessageV1Input {
  return {
    kind: 'flight_instance',
    flightKey: flight.flightKey,
    seq: version,
    origin: flightTrackerOrigin(flight.flightKey, LATER_LIFETIME),
    payload: {
      operatingCarrierIcao: 'AAL',
      flightNumber: flight.number,
      scheduledDepartureDate: flight.dateLocal,
      originIcao: 'KJFK',
      legSeq: 1,
      version,
      phase: 'scheduled',
      trackingState: 'tracking',
      refreshCadence: 'A2',
      nextRefreshAt: null,
      lastRefreshedAt: null,
      doSchemaVersion: 2,
      snapshot: statusFor(flight, overrides),
      providerCallCount: 1,
      providerCostUnits: 2,
      subscriberCount: 1,
      operatorSource: 'provider',
      finishedAt: null,
      eventsR2Key: null,
      ...payload,
    },
  };
}

async function deliver(bodies: readonly PersistMessageV1Input[], nowMs: number): Promise<void> {
  const batch = createMessageBatch(
    'planeahead-persist-local',
    bodies.map((body, index) => ({
      id: `live-${String(index)}`,
      timestamp: new Date(),
      attempts: 1,
      body,
    })),
  );
  const ctx = createExecutionContext();
  await handlePersistBatch(
    batch,
    { env: testEnv, ctx, log: quietLog },
    { trackerFor: noConfirm, now: () => nowMs },
  );
  const result = await getQueueResult(batch, ctx);
  expect(result.retryMessages).toEqual([]);
}

async function flags(userId: string): Promise<{ key: FlightKey; live: boolean }[]> {
  return db().execute<{ key: FlightKey; live: boolean }>(sql`
    select fi.flight_key as key, s.live_tracked as live
    from flight_subscriptions s join flight_instances fi on fi.id = s.flight_instance_id
    where s.user_id = ${userId}::uuid and s.deleted_at is null
    order by s.created_at
  `);
}

async function liveTrackedChanges(userId: string): Promise<boolean[]> {
  const rows = await db().execute<{ live: boolean }>(sql`
    select (row->>'liveTracked')::boolean as live from user_sync_changes
    where user_id = ${userId}::uuid and entity = 'flight_subscriptions' and op = 'upsert'
    order by xid, seq
  `);
  return rows.map((row) => row.live);
}

describe('live_tracked where the flight enters and leaves its window (ruling O3)', () => {
  it('charges five flights subscribed 49 h out as they cross the 48 h lead: two live-tracked, three refused', async () => {
    const session = await signInAnonymously();
    const flights = Array.from({ length: 5 }, () => seededFlightFor(49 * HOUR));
    for (const flight of flights) {
      await seedTracker(flight);
      expect((await subscribe(session, { flightKey: flight.flightKey })).status).toBe(201);
    }
    expect(await counterValue('user', session.userId, 'live_tracked')).toBe(0);
    const before = (await liveTrackedChanges(session.userId)).length;

    // Two hours later the tracker's next rows put every flight inside its window.
    const later = Date.now() + 2 * HOUR;
    await deliver(
      flights.map((flight) => instanceMessage(flight, 100)),
      later,
    );

    expect(await counterValue('user', session.userId, 'live_tracked')).toBe(2);
    const decided = await flags(session.userId);
    expect(decided.filter((row) => row.live)).toHaveLength(2);
    expect(decided.filter((row) => !row.live)).toHaveLength(3);
    // Every decision reached the feed, so the client can show which flights are live-tracked.
    const changes = (await liveTrackedChanges(session.userId)).slice(before);
    expect(changes.filter(Boolean)).toHaveLength(2);
    expect(changes.filter((live) => !live)).toHaveLength(3);

    // A replayed delivery changes no row, so it decides nothing again.
    await deliver(
      flights.map((flight) => instanceMessage(flight, 100)),
      later,
    );
    expect(await counterValue('user', session.userId, 'live_tracked')).toBe(2);
    expect((await liveTrackedChanges(session.userId)).slice(before)).toHaveLength(5);
  });

  it('decides once, on the first row inside the window: a later row inside it decides nothing', async () => {
    // Driven by the data rather than the clock (a schedule change moves the departure 2 h
    // earlier), so the stored row and the consumer read one clock.
    const session = await signInAnonymously();
    const flights = Array.from({ length: 3 }, () => seededFlightFor(49 * HOUR));
    for (const flight of flights) {
      await seedTracker(flight);
      expect((await subscribe(session, { flightKey: flight.flightKey })).status).toBe(201);
    }
    const before = (await liveTrackedChanges(session.userId)).length;
    const earlier = (flight: TestFlight, version: number, gate: string) => {
      const scheduledOut = new Date(flight.scheduledOut.getTime() - 2 * HOUR);
      const scheduledIn = new Date(flight.scheduledIn.getTime() - 2 * HOUR);
      return instanceMessage(flight, version, {
        originGate: gate,
        times: { scheduledOut: scheduledOut.toISOString(), scheduledIn: scheduledIn.toISOString() },
      });
    };

    await deliver(
      flights.map((flight) => earlier(flight, 100, 'A1')),
      Date.now(),
    );
    await deliver(
      flights.map((flight) => earlier(flight, 101, 'B2')),
      Date.now(),
    );

    expect(await counterValue('user', session.userId, 'live_tracked')).toBe(2);
    expect((await liveTrackedChanges(session.userId)).slice(before)).toHaveLength(3);
  });

  it('releases the slot where the flight lands: two live flights arrive, and a third live subscribe succeeds', async () => {
    const session = await signInAnonymously();
    const [a, b, c] = [6, 7, 8].map((hours) => seededFlightFor(hours * HOUR));
    if (a === undefined || b === undefined || c === undefined) {
      throw new Error('three flights expected');
    }
    for (const flight of [a, b, c]) {
      await seedTracker(flight);
    }
    const first = await subscribe(session, { flightKey: a.flightKey });
    expect(first.status).toBe(201);
    expect((await first.json<SubscribeBody>()).subscription).toMatchObject({ liveTracked: true });
    expect((await subscribe(session, { flightKey: b.flightKey })).status).toBe(201);
    const refused = await subscribe(session, { flightKey: c.flightKey });
    expect(refused.status).toBe(403);
    expect(await refused.json<ErrorBody>()).toMatchObject({ cap: 'live_tracked', limit: 2 });

    const landed = (flight: TestFlight) =>
      instanceMessage(
        flight,
        100,
        {
          status: 'arrived',
          times: {
            scheduledOut: flight.scheduledOut.toISOString(),
            actualOut: flight.scheduledOut.toISOString(),
            scheduledIn: flight.scheduledIn.toISOString(),
            actualIn: flight.scheduledIn.toISOString(),
          },
        },
        { phase: 'arrived', trackingState: 'landed' },
      );
    await deliver([landed(a), landed(b)], Date.now());

    expect(await counterValue('user', session.userId, 'live_tracked')).toBe(0);
    expect((await flags(session.userId)).map((row) => row.live)).toEqual([false, false]);
    // Idempotent through the flag: the same rows again release nothing more.
    await deliver([landed(a), landed(b)], Date.now());
    expect(await counterValue('user', session.userId, 'live_tracked')).toBe(0);

    const third = await subscribe(session, { flightKey: c.flightKey });
    expect(third.status).toBe(201);
    expect(await counterValue('user', session.userId, 'live_tracked')).toBe(1);
  });

  it('keeps the slot through a suspected cancellation and releases it once confirmed (N4)', async () => {
    const session = await signInAnonymously();
    const [suspected, cleared] = [6, 7].map((hours) => seededFlightFor(hours * HOUR));
    if (suspected === undefined || cleared === undefined) {
      throw new Error('two flights expected');
    }
    for (const flight of [suspected, cleared]) {
      await seedTracker(flight);
      expect((await subscribe(session, { flightKey: flight.flightKey })).status).toBe(201);
    }
    expect(await counterValue('user', session.userId, 'live_tracked')).toBe(2);
    const cancelled = (flight: TestFlight, version: number, cancelSuspect: boolean) =>
      instanceMessage(
        flight,
        version,
        { status: 'cancelled' },
        { phase: 'cancelled', cancelSuspect },
      );

    // The tracker suspects both: the confirming re-read is pending, so the flights are not over.
    await deliver([cancelled(suspected, 100, true), cancelled(cleared, 100, true)], Date.now());
    expect(await counterValue('user', session.userId, 'live_tracked')).toBe(2);
    expect((await flags(session.userId)).map((row) => row.live)).toEqual([true, true]);

    // One re-read confirms (the same status, no longer suspected); the other clears.
    await deliver([cancelled(suspected, 101, false), instanceMessage(cleared, 101)], Date.now());
    expect(await counterValue('user', session.userId, 'live_tracked')).toBe(1);
    expect((await flags(session.userId)).map((row) => row.live)).toEqual([false, true]);
  });
});
