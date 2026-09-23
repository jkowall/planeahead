/**
 * The counter row is the serialization point (ruling K2): twenty concurrent subscribes from one
 * free account, each to a different seeded flight, and exactly five succeed. Each take is one
 * `INSERT ... ON CONFLICT DO UPDATE ... WHERE count < 5 RETURNING` statement; under Read
 * Committed a blocked update re-evaluates its WHERE against the row the winner committed, so no
 * sixth take can slip in, and no `count(*)` guard exists to race.
 */

import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { FREE_TIER_LIMITS } from '@planeahead/shared';
import { takeCap, userCap } from '../../src/lib/caps';
import { signInAnonymously } from './helpers/auth';
import { drainTouched } from './helpers/flights';
import {
  counterValue,
  db,
  seedTracker,
  seededFlightFor,
  subscribe,
  subscriberCount,
  type ErrorBody,
} from './helpers/routes';

afterEach(drainTouched);

describe('usage_counters as the serialization point', () => {
  it('lets exactly 5 of 20 concurrent subscribes through, and the 15 others answer 403 cap_exceeded', async () => {
    const session = await signInAnonymously();
    const flights = Array.from({ length: 20 }, () => seededFlightFor());
    for (const flight of flights) {
      await seedTracker(flight);
    }

    const responses = await Promise.all(
      flights.map((flight) => subscribe(session, { flightKey: flight.flightKey })),
    );
    const statuses = responses.map((response) => response.status);
    const refusals = await Promise.all(
      responses
        .filter((response) => response.status === 403)
        .map((response) => response.json<ErrorBody>()),
    );

    expect(statuses.filter((status) => status === 201)).toHaveLength(
      FREE_TIER_LIMITS.activeSubscriptions,
    );
    expect(statuses.filter((status) => status === 403)).toHaveLength(15);
    expect(new Set(refusals.map((body) => `${body.error}:${String(body.cap)}`))).toEqual(
      new Set(['cap_exceeded:active_subscriptions']),
    );
    expect(await counterValue('user', session.userId, 'active_subscriptions')).toBe(5);
    const [rows] = await db().execute<{ n: number }>(sql`
      select count(*)::int as n from flight_subscriptions
      where user_id = ${session.userId}::uuid and deleted_at is null
    `);
    expect(rows?.n).toBe(5);
    const counts = await Promise.all(flights.map((flight) => subscriberCount(flight.flightKey)));
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(5);
  });

  it('decides 50 concurrent takes of one counter with exactly the cap', async () => {
    const { userId } = await signInAnonymously();
    const handle = db();
    const slot = userCap('instances_created', userId, new Date());

    const outcomes = await Promise.all(Array.from({ length: 50 }, () => takeCap(handle, slot)));

    expect(outcomes.filter(Boolean)).toHaveLength(FREE_TIER_LIMITS.instancesCreatedPerDay);
    expect(await counterValue('user', userId, 'instances_created')).toBe(20);
  });
});
