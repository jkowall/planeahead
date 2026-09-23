/**
 * `POST /v1/flights`, `GET /v1/flights[/:id]` and `DELETE /v1/flights/:id` through the real
 * Worker (`exports.default.fetch()`), the real FlightTracker and the embedded Postgres 18.
 *
 * Idempotency (ruling K1): a replay of the same key and body answers the stored response with
 * `Idempotent-Replayed: true` and writes nothing; the same key with a different body is 422
 * `idempotency_payload_mismatch`; a duplicate that arrives while the first is still running is
 * 409 `in_flight`. Subscribe (ruling K7): the order resolve, tracker, caps, subscribe, one
 * transaction, and the compensation when the transaction fails after the tracker accepted the
 * subscriber. The two cases that need a request held open or a transaction broken on purpose use
 * the Worker's own chain (`createApp()`) with the flight routes built by `createV1Routes()` and
 * one injected hook; everything else is the deployed Worker.
 */

import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { snapshotKvKey } from '../../src/kv/snapshot';
import { IDEMPOTENCY_REPLAYED_HEADER } from '../../src/middleware/idempotency';
import { createV1Routes } from '../../src/routes/v1';
import { jsonRequest, signInAnonymously, uniqueIp, worker } from './helpers/auth';
import { adbCalls, adbOk, drainTouched, scriptAdb, track, testEnv } from './helpers/flights';
import {
  HOUR,
  authed,
  counterValue,
  db,
  eventually,
  idempotencyKey,
  nearUniqueFlight,
  openTodaysBudget,
  seedTracker,
  seededFlightFor,
  subscribe,
  subscribeRequest,
  subscriberCount,
  type ErrorBody,
  type SubscribeBody,
} from './helpers/routes';

afterEach(drainTouched);

async function subscriptionRows(userId: string): Promise<{ id: string; deleted: boolean }[]> {
  return db().execute<{ id: string; deleted: boolean }>(sql`
    select id, deleted_at is not null as deleted from flight_subscriptions
    where user_id = ${userId}::uuid order by created_at
  `);
}

async function changeRows(
  userId: string,
): Promise<{ entity: string; op: string; entity_id: string; row: { id?: string } }[]> {
  return db().execute(sql`
    select entity, op, entity_id, row from user_sync_changes
    where user_id = ${userId}::uuid order by xid, seq
  `);
}

describe('POST /v1/flights', () => {
  it('subscribes by number and date: the resolver seeds the tracker, one provider call, one transaction', async () => {
    await openTodaysBudget();
    const flight = nearUniqueFlight();
    await scriptAdb(flight, [adbOk(flight, { phase: 'expected' })]);
    const session = await signInAnonymously();
    track(testEnv.DESIGNATOR_RESOLVER.getByName(`${flight.designator}-${flight.dateLocal}`));

    const response = await subscribe(session, {
      number: flight.designator,
      date: flight.dateLocal,
      label: 'Home',
    });
    const body = await response.json<SubscribeBody>();

    expect(response.status).toBe(201);
    expect(body.created).toBe(true);
    expect(body.subscription.flightKey).toBe(flight.flightKey);
    expect(body.flight?.key).toBe(flight.flightKey);
    expect(await adbCalls(flight)).toBe(1);
    expect(await subscriberCount(flight.flightKey)).toBe(1);
    expect(await subscriptionRows(session.userId)).toEqual([
      { id: body.subscription.id, deleted: false },
    ]);
    const changes = await changeRows(session.userId);
    expect(changes.map((c) => [c.entity, c.op, c.entity_id])).toEqual([
      ['flight_subscriptions', 'upsert', body.subscription.id],
    ]);
    expect(changes[0]?.row.id).toBe(body.subscription.id);
    expect(await counterValue('user', session.userId, 'active_subscriptions')).toBe(1);
    expect(await counterValue('user', session.userId, 'instances_created')).toBe(1);
  });

  it('replays the same key with Idempotent-Replayed and answers 422 to the same key on another body', async () => {
    const flight = seededFlightFor();
    await seedTracker(flight);
    const session = await signInAnonymously();
    const key = idempotencyKey('replay');

    const first = await subscribe(session, { flightKey: flight.flightKey }, { key });
    const firstBody = await first.json<SubscribeBody>();
    const second = await subscribe(session, { flightKey: flight.flightKey }, { key });
    const secondBody = await second.json<SubscribeBody>();
    const reused = await subscribe(session, { flightKey: flight.flightKey, label: 'x' }, { key });

    expect(first.status).toBe(201);
    expect(first.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBeNull();
    expect(second.status).toBe(201);
    expect(second.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBe('true');
    expect(secondBody).toEqual(firstBody);
    expect(reused.status).toBe(422);
    expect((await reused.json<ErrorBody>()).error).toBe('idempotency_payload_mismatch');
    expect(await subscriptionRows(session.userId)).toHaveLength(1);
    expect(await changeRows(session.userId)).toHaveLength(1);
    expect(await subscriberCount(flight.flightKey)).toBe(1);
  });

  it('hashes the validated body: the same request with its keys in another order replays', async () => {
    const flight = seededFlightFor();
    await seedTracker(flight);
    const session = await signInAnonymously();
    const key = idempotencyKey('order');

    await subscribe(session, { flightKey: flight.flightKey, label: 'A', muted: true }, { key });
    const reordered = await subscribe(
      session,
      { muted: true, label: 'A', flightKey: flight.flightKey },
      { key },
    );

    expect(reordered.status).toBe(201);
    expect(reordered.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBe('true');
  });

  it('answers 409 in_flight to a duplicate that arrives while the first is still running', async () => {
    const flight = seededFlightFor();
    await seedTracker(flight);
    const session = await signInAnonymously();
    const key = idempotencyKey('inflight');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const app = createApp();
    app.route(
      '/v1',
      createV1Routes({
        flights: {
          beforeSubscribeCommit: async () => {
            entered = true;
            await gate;
          },
        },
      }),
    );

    const ctx = createExecutionContext();
    const first = app.fetch(
      subscribeRequest(session, { flightKey: flight.flightKey }, { key }),
      env,
      ctx,
    );
    await eventually(
      () => Promise.resolve(entered),
      (value) => value,
    );
    const duplicate = await app.fetch(
      subscribeRequest(session, { flightKey: flight.flightKey }, { key }),
      env,
      createExecutionContext(),
    );
    release();
    const settled = await first;
    await waitOnExecutionContext(ctx);

    expect(duplicate.status).toBe(409);
    expect((await duplicate.json<ErrorBody>()).error).toBe('in_flight');
    expect(settled.status).toBe(201);
    const replay = await subscribe(session, { flightKey: flight.flightKey }, { key });
    expect(replay.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBe('true');
    expect(await subscriptionRows(session.userId)).toHaveLength(1);
  });

  it('requires an Idempotency-Key', async () => {
    const flight = seededFlightFor();
    await seedTracker(flight);
    const session = await signInAnonymously();

    const response = await subscribe(session, { flightKey: flight.flightKey }, { key: null });

    expect(response.status).toBe(400);
    expect((await response.json<ErrorBody>()).error).toBe('idempotency_key_required');
    expect(await subscriptionRows(session.userId)).toEqual([]);
  });

  it('answers 404 flight_not_found for a key no resolver ever seeded', async () => {
    const flight = seededFlightFor();
    track(testEnv.FLIGHT_TRACKER.getByName(flight.flightKey, { locationHint: 'enam' }));
    const session = await signInAnonymously();

    const response = await subscribe(session, { flightKey: flight.flightKey });

    expect(response.status).toBe(404);
    expect((await response.json<ErrorBody>()).error).toBe('flight_not_found');
    expect(await counterValue('user', session.userId, 'active_subscriptions')).toBe(0);
  });

  it('answers 410 flight_archived for a flight that is over', async () => {
    const flight = seededFlightFor(-3 * 24 * HOUR);
    await seedTracker(flight, {
      status: 'arrived',
      times: {
        scheduledOut: flight.scheduledOut.toISOString(),
        actualOut: flight.scheduledOut.toISOString(),
        scheduledIn: flight.scheduledIn.toISOString(),
        actualIn: flight.scheduledIn.toISOString(),
      },
    });
    const session = await signInAnonymously();

    const response = await subscribe(session, { flightKey: flight.flightKey });

    expect(response.status).toBe(410);
    expect((await response.json<ErrorBody>()).error).toBe('flight_archived');
    expect(await counterValue('user', session.userId, 'active_subscriptions')).toBe(0);
  });

  it('answers 200 with the existing subscription to a second subscribe under another key', async () => {
    const flight = seededFlightFor();
    await seedTracker(flight);
    const session = await signInAnonymously();

    const first = await subscribe(session, { flightKey: flight.flightKey });
    const again = await subscribe(session, { flightKey: flight.flightKey });
    const againBody = await again.json<SubscribeBody>();

    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(againBody.created).toBe(false);
    expect(await subscriptionRows(session.userId)).toHaveLength(1);
    expect(await counterValue('user', session.userId, 'active_subscriptions')).toBe(1);
    expect(await subscriberCount(flight.flightKey)).toBe(1);
  });

  it('unsubscribes the tracker and releases the counters when the transaction fails after subscribe', async () => {
    const flight = seededFlightFor(6 * HOUR);
    await seedTracker(flight);
    const session = await signInAnonymously();
    const key = idempotencyKey('compensate');
    const app = createApp();
    app.route(
      '/v1',
      createV1Routes({
        flights: {
          beforeSubscribeCommit: () => {
            throw new Error('injected subscribe transaction failure');
          },
        },
      }),
    );

    const ctx = createExecutionContext();
    const failed = await app.fetch(
      subscribeRequest(session, { flightKey: flight.flightKey }, { key }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(failed.status).toBe(500);
    expect(await subscriberCount(flight.flightKey)).toBe(0);
    expect(await subscriptionRows(session.userId)).toEqual([]);
    expect(await changeRows(session.userId)).toEqual([]);
    expect(await counterValue('user', session.userId, 'active_subscriptions')).toBe(0);
    expect(await counterValue('user', session.userId, 'live_tracked')).toBe(0);

    // A 5xx is not stored: the outbox's retry with the same key really runs, and succeeds.
    const retry = await subscribe(session, { flightKey: flight.flightKey }, { key });
    expect(retry.status).toBe(201);
    expect(retry.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBeNull();
    expect(await subscriberCount(flight.flightKey)).toBe(1);
    expect(await counterValue('user', session.userId, 'live_tracked')).toBe(1);
  });

  it('refuses the sixth active subscription with 403 cap_exceeded and stores the refusal', async () => {
    const session = await signInAnonymously();
    const flights = Array.from({ length: 6 }, () => seededFlightFor());
    for (const flight of flights) {
      await seedTracker(flight);
    }
    for (const flight of flights.slice(0, 5)) {
      expect((await subscribe(session, { flightKey: flight.flightKey })).status).toBe(201);
    }
    const sixth = flights[5];
    if (sixth === undefined) {
      throw new Error('six flights expected');
    }
    const key = idempotencyKey('sixth');

    const refused = await subscribe(session, { flightKey: sixth.flightKey }, { key });
    const body = await refused.json<ErrorBody>();
    const replay = await subscribe(session, { flightKey: sixth.flightKey }, { key });

    expect(refused.status).toBe(403);
    expect(body).toMatchObject({ error: 'cap_exceeded', cap: 'active_subscriptions', limit: 5 });
    expect(replay.status).toBe(403);
    expect(replay.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBe('true');
    expect(await subscriberCount(sixth.flightKey)).toBe(0);
    expect(await counterValue('user', session.userId, 'active_subscriptions')).toBe(5);
  });

  it('allows two live-tracked flights, refuses a third, and frees the slot on unsubscribe', async () => {
    const session = await signInAnonymously();
    const live = [6, 7, 8].map((hours) => seededFlightFor(hours * HOUR));
    const later = seededFlightFor();
    for (const flight of [...live, later]) {
      await seedTracker(flight);
    }
    const [a, b, c] = live;
    if (a === undefined || b === undefined || c === undefined) {
      throw new Error('three flights expected');
    }

    const first = await subscribe(session, { flightKey: a.flightKey });
    expect((await subscribe(session, { flightKey: b.flightKey })).status).toBe(201);
    const third = await subscribe(session, { flightKey: c.flightKey });
    const farAway = await subscribe(session, { flightKey: later.flightKey });

    expect(third.status).toBe(403);
    expect(await third.json<ErrorBody>()).toMatchObject({ cap: 'live_tracked', limit: 2 });
    expect(farAway.status).toBe(201);
    expect(await counterValue('user', session.userId, 'live_tracked')).toBe(2);
    // The refused subscribe gave its active slot back.
    expect(await counterValue('user', session.userId, 'active_subscriptions')).toBe(3);

    const firstId = (await first.json<SubscribeBody>()).subscription.id;
    expect((await authed(session, `/v1/flights/${firstId}`, 'DELETE')).status).toBe(200);
    expect(await counterValue('user', session.userId, 'live_tracked')).toBe(1);
    expect((await subscribe(session, { flightKey: c.flightKey })).status).toBe(201);
  });

  it('answers a malformed body with the PlaneAhead envelope, not the raw Zod result', async () => {
    const session = await signInAnonymously();

    const response = await subscribe(session, { number: 'banana', date: 'tomorrow' });
    const body = await response.json<ErrorBody & { success?: unknown }>();

    expect(response.status).toBe(400);
    expect(body.error).toBe('validation_failed');
    expect(body.success).toBeUndefined();
    expect(body.issues?.map((issue) => issue.path.join('.')).sort()).toEqual(['date', 'number']);
  });
});

describe('GET and DELETE /v1/flights', () => {
  it('lists the live subscriptions with the snapshot, reading through to the tracker on a KV miss', async () => {
    const flight = seededFlightFor();
    await seedTracker(flight);
    const session = await signInAnonymously();
    const created = await (
      await subscribe(session, { flightKey: flight.flightKey })
    ).json<SubscribeBody>();
    await env.CACHE.delete(snapshotKvKey(flight.flightKey));

    const list = await authed(session, '/v1/flights');
    const listBody = await list.json<{ flights: SubscribeBody[] }>();
    const detail = await authed(session, `/v1/flights/${created.subscription.id}`);
    const detailBody = await detail.json<SubscribeBody>();

    expect(list.status).toBe(200);
    expect(listBody.flights).toHaveLength(1);
    expect(listBody.flights[0]?.subscription.id).toBe(created.subscription.id);
    expect(listBody.flights[0]?.flight?.snapshot).not.toBeNull();
    expect(detail.status).toBe(200);
    expect(detailBody.flight?.key).toBe(flight.flightKey);
    // The read-through wrote KV with waitUntil.
    await eventually(
      () => env.CACHE.get(snapshotKvKey(flight.flightKey)),
      (value) => value !== null,
    );
  });

  it('answers 404 for another user subscription, and for a malformed id with the envelope', async () => {
    const flight = seededFlightFor();
    await seedTracker(flight);
    const owner = await signInAnonymously();
    const stranger = await signInAnonymously();
    const created = await (
      await subscribe(owner, { flightKey: flight.flightKey })
    ).json<SubscribeBody>();

    const theirs = await authed(stranger, `/v1/flights/${created.subscription.id}`);
    const malformed = await authed(owner, '/v1/flights/not-a-uuid');

    expect(theirs.status).toBe(404);
    expect((await theirs.json<ErrorBody>()).error).toBe('subscription_not_found');
    expect(malformed.status).toBe(400);
    expect((await malformed.json<ErrorBody>()).error).toBe('validation_failed');
  });

  it('tombstones on DELETE, writes the delete change, unsubscribes, and a new subscribe restores the row', async () => {
    const flight = seededFlightFor();
    await seedTracker(flight);
    const session = await signInAnonymously();
    const created = await (
      await subscribe(session, { flightKey: flight.flightKey })
    ).json<SubscribeBody>();
    const id = created.subscription.id;

    const removed = await authed(session, `/v1/flights/${id}`, 'DELETE');
    const again = await authed(session, `/v1/flights/${id}`, 'DELETE');

    expect(removed.status).toBe(200);
    expect(again.status).toBe(404);
    expect(await subscriptionRows(session.userId)).toEqual([{ id, deleted: true }]);
    expect(await subscriberCount(flight.flightKey)).toBe(0);
    expect(await counterValue('user', session.userId, 'active_subscriptions')).toBe(0);

    const restored = await subscribe(session, { flightKey: flight.flightKey });
    const restoredBody = await restored.json<SubscribeBody>();
    expect(restored.status).toBe(201);
    expect(restoredBody.subscription.id).toBe(id);
    expect(restoredBody.subscription.deletedAt).toBeNull();
    expect(await subscriptionRows(session.userId)).toEqual([{ id, deleted: false }]);
    expect((await changeRows(session.userId)).map((c) => c.op)).toEqual([
      'upsert',
      'delete',
      'upsert',
    ]);
    expect(await subscriberCount(flight.flightKey)).toBe(1);
  });
});

describe('the burst limiter runs before idempotency (ruling K11)', () => {
  it('refuses a flood through the real PUBLIC_RL binding, and the 429 does not consume the key', async () => {
    const flight = seededFlightFor();
    await seedTracker(flight);
    const session = await signInAnonymously();
    const floodedIp = uniqueIp();
    const key = idempotencyKey('burst');

    // Spend the address's window on a route that costs nothing. A vacuous pass is impossible:
    // the loop must observe the binding refuse, or the test fails here.
    let limited = false;
    for (let attempt = 0; attempt < 400 && !limited; attempt += 1) {
      const response = await worker(jsonRequest('/health', 'GET', undefined, { ip: floodedIp }));
      limited = response.status === 429;
    }
    expect(limited).toBe(true);

    const refused = await subscribe(
      { cookie: session.cookie, ip: floodedIp },
      { flightKey: flight.flightKey },
      { key },
    );
    expect(refused.status).toBe(429);
    expect((await refused.json<ErrorBody>()).error).toBe('rate_limited');

    const accepted = await subscribe(session, { flightKey: flight.flightKey }, { key });
    expect(accepted.status).toBe(201);
    expect(accepted.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBeNull();
  });
});

describe('reserved webhook stubs (ruling K12)', () => {
  it('answer 501 naming the phase, and sit inside the per-IP limiter', async () => {
    for (const path of ['/v1/webhooks/apple', '/v1/webhooks/revenuecat']) {
      const response = await worker(
        jsonRequest(path, 'POST', { signedPayload: 'x' }, { origin: null }),
      );
      const body = await response.json<{ error: string; phase: string }>();
      expect(response.status, path).toBe(501);
      expect(body.error).toBe('not_implemented');
      expect(body.phase).toBe('Phase 1');
    }
    const ip = uniqueIp();
    let limited = false;
    for (let attempt = 0; attempt < 400 && !limited; attempt += 1) {
      const response = await worker(
        jsonRequest('/v1/webhooks/apple', 'POST', {}, { ip, origin: null }),
      );
      limited = response.status === 429;
    }
    expect(limited).toBe(true);
  });
});
