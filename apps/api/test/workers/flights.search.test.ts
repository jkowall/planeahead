/**
 * `GET /v1/flights/search?number=&date=&origin=` (ruling K10) through the real Worker, the real
 * DesignatorResolver and the fake AeroDataBox gateway (whose call counter is the one assertions
 * trust).
 *
 * Cheapest answer first: the date must be inside the provider's lookahead (422 without a call
 * otherwise), then KV, then `flight_designators` (which supplies the origin the resolver's
 * existing-tracker probe needs), then the resolver. Anonymous callers pay `tracker_creations` per
 * salted client IP only when a tracker is created; the IP itself is never stored.
 */

import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiErrorSchema, uuidv7 } from '@planeahead/shared';
import {
  RESOLUTION_TTL_MS,
  searchKvKey,
  type DesignatorResolver,
} from '../../src/do/designator-resolver';
import { saltedIpSubject } from '../../src/lib/hmac';
import { normaliseClientIp } from '../../src/validation/client-ip';
import { signInAnonymously, uniqueIp, type AnonymousSession } from './helpers/auth';
import {
  adbCalls,
  adbOk,
  drainTouched,
  scriptAdb,
  testEnv,
  track,
  type TestFlight,
} from './helpers/flights';
import {
  DAY_MS,
  authed,
  counterValue,
  db,
  nearUniqueFlight,
  openTodaysBudget,
  subscribe,
  trackerStub,
  type ErrorBody,
} from './helpers/routes';

afterEach(drainTouched);

interface SearchBody {
  readonly flightKey: string;
  readonly status: { status: string } | null;
  readonly tracker: string | null;
  readonly cached: boolean;
}

interface NotFoundBody extends ErrorBody {
  readonly triedDates?: string[];
  readonly suggestions?: unknown[];
}

function shift(dateLocal: string, days: number): string {
  return new Date(Date.parse(`${dateLocal}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function search(session: AnonymousSession, query: string): Promise<Response> {
  return authed(session, `/v1/flights/search?${query}`);
}

function queryFor(flight: TestFlight, extra = ''): string {
  return `number=${flight.designator}&date=${flight.dateLocal}${extra}`;
}

function resolverOf(flight: TestFlight): DurableObjectStub<DesignatorResolver> {
  return track(testEnv.DESIGNATOR_RESOLVER.getByName(`${flight.designator}-${flight.dateLocal}`));
}

describe('GET /v1/flights/search', () => {
  it('resolves a designator and date to the canonical key through the resolver, then answers from KV', async () => {
    await openTodaysBudget();
    const flight = nearUniqueFlight();
    await scriptAdb(flight, [adbOk(flight, { phase: 'expected' })]);
    resolverOf(flight);
    trackerStub(flight.flightKey);
    const session = await signInAnonymously();

    const first = await search(session, queryFor(flight));
    const firstBody = await first.json<SearchBody>();

    expect(first.status).toBe(200);
    expect(firstBody.flightKey).toBe(flight.flightKey);
    expect(firstBody.status?.status).toBe('scheduled');
    expect(firstBody.tracker).toBe('seeded');
    expect(firstBody.cached).toBe(false);
    expect(await adbCalls(flight)).toBe(1);
    const designators = await db().execute<{ origin_icao: string; kind: string }>(sql`
      select fd.origin_icao, fd.kind from flight_designators fd
      join flight_instances fi on fi.id = fd.flight_instance_id
      where fi.flight_key = ${flight.flightKey}
    `);
    expect(designators).toEqual([{ origin_icao: 'KJFK', kind: 'operating' }]);

    // KV is written by the resolver with waitUntil.
    const key = searchKvKey(flight.designator, flight.dateLocal);
    for (let attempt = 0; attempt < 50 && (await env.CACHE.get(key)) === null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const second = await search(session, queryFor(flight));
    const secondBody = await second.json<SearchBody>();
    expect(second.status).toBe(200);
    expect(secondBody.flightKey).toBe(flight.flightKey);
    expect(secondBody.cached).toBe(true);
    expect(await adbCalls(flight)).toBe(1);
  });

  it('passes the origin flight_designators knows, so the resolver adopts the existing tracker without a call', async () => {
    await openTodaysBudget();
    const flight = nearUniqueFlight();
    await scriptAdb(flight, [adbOk(flight, { phase: 'expected' })]);
    const resolver = resolverOf(flight);
    trackerStub(flight.flightKey);
    const session = await signInAnonymously();
    expect((await search(session, queryFor(flight))).status).toBe(200);
    expect(await adbCalls(flight)).toBe(1);

    // The resolver's 24 h resolution and the 900 s KV entry have both expired.
    await runInDurableObject(resolver, async (instance: DesignatorResolver) => {
      await instance.kvSettled();
      instance._setClock(Date.now() + RESOLUTION_TTL_MS + 60_000);
    });
    await env.CACHE.delete(searchKvKey(flight.designator, flight.dateLocal));

    const again = await search(session, queryFor(flight));
    const againBody = await again.json<SearchBody>();

    expect(again.status).toBe(200);
    expect(againBody.flightKey).toBe(flight.flightKey);
    expect(againBody.tracker).toBe('adopted');
    expect(await adbCalls(flight)).toBe(1);
  });

  it('answers 404 flight_not_found with the dates tried when the provider has no such flight', async () => {
    await openTodaysBudget();
    const flight = nearUniqueFlight();
    const byNumber = nearUniqueFlight();
    resolverOf(flight);
    resolverOf(byNumber);
    const session = await signInAnonymously();

    const response = await search(session, queryFor(flight));
    const body = await response.json<NotFoundBody>();
    const subscribed = await subscribe(session, {
      number: byNumber.designator,
      date: byNumber.dateLocal,
    });
    const subscribedBody = await subscribed.json<NotFoundBody>();
    const unknownRoute = await authed(session, '/nowhere-at-all');

    // Ruling O4: `flight_not_found`, never the unknown-route `not_found`, naming the origin-local
    // dates the adapter asked for (the date and its neighbours) and the reserved suggestions.
    expect(response.status).toBe(404);
    expect(body).toMatchObject({
      error: 'flight_not_found',
      triedDates: [flight.dateLocal, shift(flight.dateLocal, -1), shift(flight.dateLocal, 1)],
      suggestions: [],
    });
    expect(ApiErrorSchema.safeParse(body).success).toBe(true);
    expect(subscribed.status).toBe(404);
    expect(subscribedBody).toMatchObject({
      error: 'flight_not_found',
      triedDates: [byNumber.dateLocal, shift(byNumber.dateLocal, -1), shift(byNumber.dateLocal, 1)],
      suggestions: [],
    });
    expect(unknownRoute.status).toBe(404);
    expect((await unknownRoute.json<ErrorBody>()).error).toBe('not_found');
    // A person-supplied date is tried with its neighbours (increment 6's user_search rule).
    expect(await adbCalls(flight)).toBeGreaterThanOrEqual(1);
    expect(await counterValue('user', session.userId, 'instances_created')).toBe(0);
  });

  it('answers 422 date_out_of_range beyond the lookahead, without a provider call', async () => {
    const flight = nearUniqueFlight();
    const beyond = new Date(Date.now() + 400 * DAY_MS).toISOString().slice(0, 10);
    const session = await signInAnonymously();

    const response = await search(session, `number=${flight.designator}&date=${beyond}`);
    const body = await response.json<ErrorBody & { maxDaysAhead?: number }>();

    expect(response.status).toBe(422);
    expect(body.error).toBe('date_out_of_range');
    expect(body.maxDaysAhead).toBe(365);
  });

  it('charges an anonymous creation to the salted IP and never stores the address', async () => {
    await openTodaysBudget();
    const flight = nearUniqueFlight();
    await scriptAdb(flight, [adbOk(flight, { phase: 'expected' })]);
    resolverOf(flight);
    trackerStub(flight.flightKey);
    const session = await signInAnonymously();
    const secret = testEnv.IP_SALT_SECRET ?? '';
    const day = new Date().toISOString().slice(0, 10);
    const subject = await saltedIpSubject(secret, normaliseClientIp(session.ip) ?? '', day);

    expect((await search(session, queryFor(flight))).status).toBe(200);

    expect(await counterValue('ip', subject, 'tracker_creations')).toBe(1);
    expect(await counterValue('user', session.userId, 'instances_created')).toBe(1);
    expect(subject).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const leaked = await db().execute<{ n: number }>(sql`
      select count(*)::int as n from usage_counters where subject like ${`%${session.ip}%`}
    `);
    expect(leaked[0]?.n).toBe(0);
  });

  it('refuses an anonymous caller at 10 creations per salted IP per day, before any provider call', async () => {
    const flight = nearUniqueFlight();
    await scriptAdb(flight, [adbOk(flight, { phase: 'expected' })]);
    resolverOf(flight);
    const ip = uniqueIp();
    const session = await signInAnonymously(ip);
    const day = new Date().toISOString().slice(0, 10);
    const subject = await saltedIpSubject(testEnv.IP_SALT_SECRET ?? '', ip, day);
    await db().execute(sql`
      insert into usage_counters (id, scope, subject, counter, window_start, count)
      values (${uuidv7()}, 'ip', ${subject}, 'tracker_creations', ${`${day}T00:00:00Z`}::timestamptz, 10)
    `);

    const refused = await search(session, queryFor(flight));
    const fromElsewhere = await search({ ...session, ip: uniqueIp() }, queryFor(flight));

    expect(refused.status).toBe(403);
    expect(await refused.json<ErrorBody>()).toMatchObject({
      error: 'cap_exceeded',
      cap: 'tracker_creations',
      limit: 10,
    });
    // The refusal gave back the per-user slot it had taken first.
    expect(fromElsewhere.status).toBe(200);
    expect(await adbCalls(flight)).toBe(1);
  });

  it('validates the query with the envelope, repeated and malformed parameters included', async () => {
    const session = await signInAnonymously();

    const repeated = await search(session, 'number=AA1&number=AA2&date=2026-12-01');
    const malformed = await search(session, 'number=banana&date=someday');
    const badOrigin = await search(session, 'number=AA100&date=2026-12-01&origin=12');
    const unknownIata = await search(session, 'number=AA100&date=2026-12-01&origin=QQQ');
    const repeatedBody = await repeated.json<ErrorBody>();

    expect(repeated.status).toBe(400);
    expect(repeatedBody.error).toBe('validation_failed');
    expect(repeatedBody.issues?.[0]?.path).toEqual(['number']);
    expect(malformed.status).toBe(400);
    expect((await malformed.json<ErrorBody>()).issues?.map((i) => i.path[0]).sort()).toEqual([
      'date',
      'number',
    ]);
    expect(badOrigin.status).toBe(400);
    expect(unknownIata.status).toBe(400);
    expect((await unknownIata.json<ErrorBody>()).issues?.[0]?.path).toEqual(['origin']);
  });

  it('answers 401 without a session', async () => {
    const response = await authed(
      { cookie: '', ip: uniqueIp() },
      '/v1/flights/search?number=AA1&date=2026-12-01',
    );

    expect(response.status).toBe(401);
  });
});
