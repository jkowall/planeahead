/**
 * `POST /v1/flights/:id/refresh` (ruling K6).
 *
 * The FlightTracker's in-flight promise (and its 60 s freshness rule) is the only coalescer: the
 * Cache API cannot store a POST and KV is eventually consistent. 500 refreshes inside 60 seconds
 * from 50 users, ten each (each user's own daily sub-budget), make ONE provider call, counted by
 * the fake gateway, never by a counter inside the isolate. A refresh whose tracker does not answer
 * within the route's 8 s deadline is 504 `refresh_timeout` with the last known state, and the
 * tracker keeps working after the answer has gone.
 */

import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import { FREE_TIER_LIMITS, DO_CALL_DEADLINE_MS } from '@planeahead/shared';
import { createApp } from '../../src/app';
import { defaultTrackerFor, type TrackerRpc } from '../../src/lib/trackers';
import { createV1Routes } from '../../src/routes/v1';
import { jsonRequest, signInAnonymously, type AnonymousSession } from './helpers/auth';
import { adbCalls, adbOk, drainTouched, scriptAdb } from './helpers/flights';
import {
  DAY_MS,
  authed,
  counterValue,
  seedTracker,
  seededFlightFor,
  subscribe,
  type ErrorBody,
  type SubscribeBody,
} from './helpers/routes';

afterEach(drainTouched);

/**
 * A flight inside the AeroDataBox lookahead (30 days out): a 2100s flight is refused by the
 * adapter before any request (`beyond_max_days_ahead`), which would make every refresh a
 * zero-cost error and prove nothing about coalescing.
 */
function refreshableFlight() {
  return seededFlightFor(30 * DAY_MS);
}

interface RefreshBody {
  readonly flightKey: string;
  readonly outcome: string;
  readonly reason: string | null;
  readonly snapshot: unknown;
}

async function subscribed(
  flightKey: string,
): Promise<{ session: AnonymousSession; subscriptionId: string }> {
  const session = await signInAnonymously();
  const response = await subscribe(session, { flightKey });
  if (response.status !== 201) {
    throw new Error(`subscribe failed: ${String(response.status)} ${await response.text()}`);
  }
  return { session, subscriptionId: (await response.json<SubscribeBody>()).subscription.id };
}

function refresh(session: AnonymousSession, subscriptionId: string): Promise<Response> {
  return authed(session, `/v1/flights/${subscriptionId}/refresh`, 'POST');
}

describe('refresh coalescing', () => {
  it('turns 500 refreshes inside 60 seconds from 50 users into one provider call', async () => {
    const flight = refreshableFlight();
    await scriptAdb(flight, [adbOk(flight, { phase: 'expected' })]);
    await seedTracker(flight);
    const users = [];
    for (let index = 0; index < 50; index += 1) {
      users.push(await subscribed(flight.flightKey));
    }
    const calls = users.flatMap((user) =>
      Array.from({ length: FREE_TIER_LIMITS.refreshesPerFlightPerDay }, () => user),
    );
    expect(calls).toHaveLength(500);

    const started = Date.now();
    const statuses: number[] = [];
    const outcomes: string[] = [];
    // Twenty at a time: the pool shares one Postgres (and its connection limit) with every other
    // test file running in parallel.
    for (let index = 0; index < calls.length; index += 20) {
      const batch = await Promise.all(
        calls.slice(index, index + 20).map((user) => refresh(user.session, user.subscriptionId)),
      );
      for (const response of batch) {
        statuses.push(response.status);
        outcomes.push((await response.json<RefreshBody>()).outcome);
      }
    }
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(60_000);
    expect(statuses.every((status) => status === 200)).toBe(true);
    expect(outcomes.filter((outcome) => outcome === 'refreshed')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'coalesced')).toHaveLength(499);
    expect(await adbCalls(flight)).toBe(1);
  }, 180_000);

  it('refuses the eleventh refresh of one flight by one user with 403 cap_exceeded', async () => {
    const flight = refreshableFlight();
    await scriptAdb(flight, [adbOk(flight, { phase: 'expected' })]);
    await seedTracker(flight);
    const { session, subscriptionId } = await subscribed(flight.flightKey);

    for (let index = 0; index < FREE_TIER_LIMITS.refreshesPerFlightPerDay; index += 1) {
      expect((await refresh(session, subscriptionId)).status).toBe(200);
    }
    const eleventh = await refresh(session, subscriptionId);

    expect(eleventh.status).toBe(403);
    expect(await eleventh.json<ErrorBody>()).toMatchObject({
      error: 'cap_exceeded',
      cap: 'refresh',
      limit: 10,
    });
    expect(await counterValue('user', session.userId, `refresh:${flight.flightKey}`)).toBe(10);
  });

  it('takes no Idempotency-Key: a keyed refresh runs every time', async () => {
    const flight = refreshableFlight();
    await scriptAdb(flight, [adbOk(flight, { phase: 'expected' })]);
    await seedTracker(flight);
    const { session, subscriptionId } = await subscribed(flight.flightKey);
    const headers = { 'Idempotency-Key': 'refresh-key-0000001' };

    const first = await authed(session, `/v1/flights/${subscriptionId}/refresh`, 'POST', headers);
    const second = await authed(session, `/v1/flights/${subscriptionId}/refresh`, 'POST', headers);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers.get('Idempotent-Replayed')).toBeNull();
    expect(await counterValue('user', session.userId, `refresh:${flight.flightKey}`)).toBe(2);
  });

  it('answers 404 for a subscription that is not the caller live one', async () => {
    const session = await signInAnonymously();

    const response = await refresh(session, crypto.randomUUID());

    expect(response.status).toBe(404);
    expect((await response.json<ErrorBody>()).error).toBe('subscription_not_found');
  });
});

describe('the 8 s deadline', () => {
  it('answers 504 refresh_timeout with the last known state when the tracker is slow, and the tracker finishes anyway', async () => {
    const flight = refreshableFlight();
    await scriptAdb(flight, [adbOk(flight, { phase: 'expected' })]);
    await seedTracker(flight);
    const { session, subscriptionId } = await subscribed(flight.flightKey);
    // The injected tracker delays the real one past the deadline, then lets it run.
    const slowBy = DO_CALL_DEADLINE_MS + 1_000;
    const app = createApp();
    app.route(
      '/v1',
      createV1Routes({
        flights: {
          trackerFor: (workerEnv) => {
            const real = defaultTrackerFor(workerEnv);
            return (key): TrackerRpc => {
              const tracker = real(key);
              return {
                getState: () => tracker.getState(),
                subscribe: (input) => tracker.subscribe(input),
                unsubscribe: (input) => tracker.unsubscribe(input),
                forceRefresh: async (input) => {
                  await new Promise((resolve) => setTimeout(resolve, slowBy));
                  return tracker.forceRefresh(input);
                },
              };
            };
          },
        },
      }),
    );

    const ctx = createExecutionContext();
    const started = Date.now();
    const response = await app.fetch(
      jsonRequest(`/v1/flights/${subscriptionId}/refresh`, 'POST', undefined, {
        ip: session.ip,
        cookie: session.cookie,
      }),
      env,
      ctx,
    );
    const elapsed = Date.now() - started;
    const body = await response.json<
      ErrorBody & { flight: { key: string; snapshot: unknown } | null }
    >();

    expect(response.status).toBe(504);
    expect(body.error).toBe('refresh_timeout');
    expect(elapsed).toBeGreaterThanOrEqual(DO_CALL_DEADLINE_MS - 50);
    expect(elapsed).toBeLessThan(slowBy);
    expect(body.flight?.key).toBe(flight.flightKey);
    expect(body.flight?.snapshot).not.toBeNull();
    expect(await adbCalls(flight)).toBe(0);

    // The call was not cancelled: waitUntil kept it alive, and the tracker made its provider call.
    await waitOnExecutionContext(ctx);
    expect(await adbCalls(flight)).toBe(1);
  }, 60_000);
});
