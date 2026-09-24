/**
 * Increment 10's provider-call acceptance, proven here rather than on a device (orchestrator
 * ruling T1): no API is deployed and `wrangler dev` needs a Neon branch, so the assertion the
 * spec puts on the simulator ("adding tomorrow's AA100 produces exactly one AeroDataBox call in
 * `provider_calls`, `cost_units = 2`; adding the same flight from a second account produces no
 * further provider call") runs against the real Worker, the real subscribe route, the real
 * DesignatorResolver and FlightTracker, the persist queue consumer and the embedded Postgres,
 * with the fake AeroDataBox gateway standing in for the provider.
 *
 * Both accounts subscribe exactly as the mobile outbox does (`POST /v1/flights { subscriptionId,
 * number, date }` with an `Idempotency-Key` and the caller's own `X-Request-Id`). The increment 8
 * suite asserts one provider call for ONE account (flights.subscribe.test.ts, "subscribes by
 * number and date"); nothing asserted the second account or the `provider_calls` row, hence this
 * file.
 *
 * The resolver's `user_search` record is appended after resolution and carries the resolved
 * flight key (increment 12; increment 7 wrote it before the key was known, with a NULL key). The
 * row is still found by the request id the first subscribe carried, as the owner's staging query in
 * docs/increments/10-verification.md does, and the test asserts the key it now carries.
 */

import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { signInAnonymously } from './helpers/auth';
import { adbCalls, adbOk, drainTouched, scriptAdb, testEnv, track } from './helpers/flights';
import {
  counterValue,
  db,
  eventually,
  nearUniqueFlight,
  openTodaysBudget,
  subscribe,
  subscriberCount,
  type SubscribeBody,
} from './helpers/routes';

afterEach(drainTouched);

// A type alias, not an interface: `execute<T>` wants a `Record<string, unknown>`.
type ProviderCallRow = {
  readonly provider: string;
  readonly operation: string;
  readonly trigger: string;
  readonly result: string;
  readonly cost_units: number;
  readonly request_id: string;
  readonly flight_key: string | null;
};

function providerCalls(requestIds: readonly string[]): Promise<ProviderCallRow[]> {
  return db().execute<ProviderCallRow>(sql`
    select provider, operation, trigger, result, cost_units, request_id, flight_key
    from provider_calls
    where request_id in (${sql.join(
      requestIds.map((id) => sql`${id}`),
      sql`, `,
    )})
    order by created_at
  `);
}

describe('one provider call for a flight added by two accounts', () => {
  it("adding tomorrow's flight costs one AeroDataBox call (cost_units 2); a second account adds nothing", async () => {
    await openTodaysBudget();
    // Tomorrow, like the acceptance's AA100: inside the live window, so both accounts also take a
    // live-tracked slot.
    const flight = nearUniqueFlight(1, 1);
    await scriptAdb(flight, [adbOk(flight, { phase: 'expected' })]);
    track(testEnv.DESIGNATOR_RESOLVER.getByName(`${flight.designator}-${flight.dateLocal}`));
    const first = await signInAnonymously();
    const second = await signInAnonymously();
    const firstRequest = `inc10-first-${crypto.randomUUID()}`;
    const secondRequest = `inc10-second-${crypto.randomUUID()}`;

    const a = await subscribe(
      first,
      { subscriptionId: crypto.randomUUID(), number: flight.designator, date: flight.dateLocal },
      { headers: { 'X-Request-Id': firstRequest } },
    );
    const b = await subscribe(
      second,
      { subscriptionId: crypto.randomUUID(), number: flight.designator, date: flight.dateLocal },
      { headers: { 'X-Request-Id': secondRequest } },
    );
    const aBody = await a.json<SubscribeBody>();
    const bBody = await b.json<SubscribeBody>();

    // Two accounts, two subscriptions, one flight key, one tracker with both subscribers.
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.headers.get('X-Request-Id')).toBe(firstRequest);
    expect(aBody.subscription.flightKey).toBe(flight.flightKey);
    expect(bBody.subscription.flightKey).toBe(flight.flightKey);
    expect(aBody.subscription.id).not.toBe(bBody.subscription.id);
    expect(bBody.flight?.snapshot).not.toBeNull();
    expect(await subscriberCount(flight.flightKey)).toBe(2);
    expect(await counterValue('user', first.userId, 'live_tracked')).toBe(1);
    expect(await counterValue('user', second.userId, 'live_tracked')).toBe(1);

    // Exactly one call reached the provider, made for the first account's request.
    expect(await adbCalls(flight)).toBe(1);
    const rows = await eventually(
      () => providerCalls([firstRequest, secondRequest]),
      (found) => found.length >= 1,
    );
    expect(rows).toEqual([
      {
        provider: 'aerodatabox',
        operation: 'flight_status',
        trigger: 'user_search',
        result: 'ok',
        cost_units: 2,
        request_id: firstRequest,
        flight_key: flight.flightKey,
      },
    ]);
    // The second account's subscribe was answered from the resolution and the seeded tracker.
    expect(await counterValue('user', second.userId, 'instances_created')).toBe(0);
    expect(await counterValue('user', first.userId, 'instances_created')).toBe(1);
  });
});
