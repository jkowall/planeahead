import { IsoInstantSchema, uuidv7 } from '@planeahead/shared';
import { Table, eq, getTableName, is } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { destinationColumns, originColumns, resolveAirportEndpoint } from '../src/queries/airports';
import { InstantFormatError } from '../src/schema/columns';
import * as schema from '../src/schema/index';
import { createMigratedDatabase, sqlState, type TestDatabase } from './helpers';

/**
 * Applies every migration to a fresh PG18 database, then inserts one row per domain through
 * Drizzle and reads it back, covering the driver-sensitive types: bytea, bigint mode number,
 * xid8, timestamptz in both modes, jsonb and the generated flight_key. Every instant read back
 * through an `instant()` column must satisfy `IsoInstantSchema`, the type of every instant that
 * crosses a package boundary (`FlightTimes`, `SyncUpsertV1.updatedAt`, `TrackerStateV1`).
 */

let tdb: TestDatabase;
const ids = {
  user: uuidv7(),
  user2: uuidv7(),
  airport: uuidv7(),
  destination: uuidv7(),
  flight: uuidv7(),
  trip: uuidv7(),
  subscription: uuidv7(),
  device: uuidv7(),
  notification: uuidv7(),
  btsRun: uuidv7(),
};

function expectIso(value: unknown): void {
  expect(typeof value).toBe('string');
  expect(IsoInstantSchema.safeParse(value).success, `not an ISO instant: ${String(value)}`).toBe(
    true,
  );
}

beforeAll(async () => {
  tdb = await createMigratedDatabase('roundtrip');
});

afterAll(async () => {
  await tdb.drop();
});

describe('migrations', () => {
  it('records every migration and creates every table', async () => {
    expect(tdb.migration.migrations).toBe(3);
    expect(tdb.migration.serverVersionNum).toBeGreaterThanOrEqual(180000);
    const [applied] = await tdb.sql<{ n: string }[]>`
      select count(*)::text as n from drizzle.__drizzle_migrations
    `;
    expect(Number(applied?.n)).toBe(3);
    const tables = await tdb.sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name
    `;
    const expected = Object.values(schema)
      .filter((value) => is(value, Table))
      .map((table) => getTableName(table))
      .sort();
    expect(tables.map((row) => row.table_name)).toEqual(expected);
    expect(expected).toHaveLength(70);
  });

  it('is idempotent: a second migrate run applies nothing', async () => {
    const { migrateDatabase } = await import('../src/migrate');
    const again = await migrateDatabase(tdb.url);
    expect(again.migrations).toBe(3);
    const [applied] = await tdb.sql<{ n: string }[]>`
      select count(*)::text as n from drizzle.__drizzle_migrations
    `;
    expect(Number(applied?.n)).toBe(3);
  });
});

describe('reference domain', () => {
  it('round-trips an airport and enforces the type and code checks', async () => {
    const { db } = tdb;
    await db
      .insert(schema.airports)
      .values([
        airport(ids.airport, 'KJFK', 'JFK', 'America/New_York'),
        airport(ids.destination, 'EGLL', 'LHR', 'Europe/London'),
      ]);
    const [row] = await db.select().from(schema.airports).where(eq(schema.airports.icao, 'KJFK'));
    expect(row?.id).toBe(ids.airport);
    expect(row?.tz).toBe('America/New_York');
    expect(row?.latitude).toBeCloseTo(40.6413);
    expectIso(row?.createdAt);
    expectIso(row?.updatedAt);
    await expect(
      db.insert(schema.airports).values(airport(uuidv7(), 'ZZZZ', null, 'UTC', 'spaceport')),
    ).rejects.toSatisfy((error) => sqlState(error) === '23514');
    await expect(
      db.insert(schema.airports).values(airport(uuidv7(), 'KLAX', 'lax', 'UTC')),
    ).rejects.toSatisfy((error) => sqlState(error) === '23514');
  });

  it('round-trips airlines, aircraft types and a regional operator hint', async () => {
    const { db } = tdb;
    await db.insert(schema.airlines).values({
      icao: 'AAL',
      iata: 'AA',
      vrsCode: 'AA',
      name: 'American Airlines',
      alliance: 'oneworld',
      allianceStatus: 'member',
      validFrom: '1934-04-15',
    });
    await db.insert(schema.aircraftTypes).values({
      icao: 'A388',
      manufacturer: 'Airbus',
      model: 'A380-800',
      engines: '4',
      wakeTurbulence: 'J',
      wakeSource: 'coltjd45',
    });
    await db.insert(schema.regionalOperators).values({
      marketingIata: 'AA',
      numberFrom: 3200,
      numberTo: 4299,
      operatingIcao: 'ENY',
      confidence: 'hint',
      source: 'https://example.test',
      sourceConfidence: 'observed',
      sourceAsOf: '2026-09-19',
    });
    const [airline] = await db.select().from(schema.airlines);
    expect(airline?.validFrom).toBe('1934-04-15');
    expectIso(airline?.createdAt);
    const [type] = await db.select().from(schema.aircraftTypes);
    expect(type?.wakeTurbulence).toBe('J');
    await expect(
      db.insert(schema.aircraftTypes).values({ icao: 'XXXX', model: 'x', wakeTurbulence: 'X' }),
    ).rejects.toSatisfy((error) => sqlState(error) === '23514');
    await expect(
      db.insert(schema.aircraftTypes).values({ icao: 'b738x', model: 'x' }),
    ).rejects.toSatisfy((error) => sqlState(error) === '23514');
    await expect(
      db.insert(schema.aircraft).values({
        registration: 'N12345',
        icaoHex: 'A1B2C3',
        operatorIcao: 'american',
        validFrom: '2020-01-01',
      }),
    ).rejects.toSatisfy((error) => sqlState(error) === '23514');
  });
});

describe('identity domain', () => {
  it('round-trips Better Auth rows with Date timestamps, bytea and bigint mode number', async () => {
    const { db } = tdb;
    const now = new Date('2026-09-20T12:00:00.000Z');
    await db.insert(schema.users).values([
      {
        id: ids.user,
        name: 'Test',
        email: 'Test@Example.com',
        createdAt: now,
        updatedAt: now,
        homeAirportId: ids.airport,
      },
      { id: ids.user2, name: 'Second', email: 'second@example.com' },
    ]);
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, ids.user));
    expect(user?.createdAt).toBeInstanceOf(Date);
    expect(user?.createdAt.getTime()).toBe(now.getTime());
    expect(user?.status).toBe('active');
    expect(user?.isAnonymous).toBe(false);
    await expect(
      db.insert(schema.users).values({ id: uuidv7(), name: 'Dup', email: 'test@example.com' }),
    ).rejects.toSatisfy((error) => sqlState(error) === '23505');

    await db.insert(schema.sessions).values({
      token: 'plaintext-session-token',
      expiresAt: new Date(now.getTime() + 86_400_000),
      userId: ids.user,
      ipAddress: '203.0.113.9',
    });
    const secret = new Uint8Array([0, 1, 2, 3, 255, 254, 253, 10, 13, 39, 92, 0]);
    await db.insert(schema.accounts).values({
      accountId: 'apple-sub',
      providerId: 'apple',
      userId: ids.user,
      refreshTokenEnc: secret,
      refreshTokenKeyVersion: 1,
    });
    const [account] = await db.select().from(schema.accounts);
    expect(account?.refreshTokenEnc).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(account?.refreshTokenEnc ?? []).equals(Buffer.from(secret))).toBe(true);
    expect(account?.refreshToken).toBeNull();

    await db.insert(schema.verifications).values({
      identifier: 'magic:hash',
      value: 'v',
      expiresAt: now,
    });
    const lastRequest = 1_758_369_600_123;
    await db.insert(schema.rateLimits).values({ key: 'ip:203.0.113.9', count: 1, lastRequest });
    const [limit] = await db.select().from(schema.rateLimits);
    expect(limit?.lastRequest).toBe(lastRequest);
    expect(typeof limit?.lastRequest).toBe('number');
  });

  it('round-trips user keys, devices, preferences, consents, sync changes and idempotency keys', async () => {
    const { db } = tdb;
    await db.insert(schema.userKeys).values({
      userId: ids.user,
      wrappedDek: new Uint8Array(40).fill(7),
      kekVersion: 1,
    });
    await db.insert(schema.devices).values({
      id: ids.device,
      userId: ids.user,
      installId: 'install-1',
      platform: 'ios',
      attestation: { reserved: true },
    });
    await db.insert(schema.userPreferences).values({ userId: ids.user, distanceUnit: 'km' });
    await db.insert(schema.userConsents).values({
      userId: ids.user,
      kind: 'terms',
      version: '2026-09',
      granted: true,
      source: 'app',
    });
    const [change] = await db
      .insert(schema.userSyncChanges)
      .values({ userId: ids.user, entity: 'user_preferences', entityId: uuidv7(), op: 'upsert' })
      .returning();
    expect(typeof change?.seq).toBe('number');
    expect(change?.xid).toMatch(/^[0-9]+$/);
    expect(BigInt(change?.xid ?? '0')).toBeGreaterThan(0n);
    expectIso(change?.createdAt);
    await db.insert(schema.idempotencyKeys).values({
      userId: ids.user,
      key: 'idem-1',
      requestHash: new Uint8Array(32),
      responseStatus: 201,
      responseBody: { ok: true },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await expect(
      db.insert(schema.idempotencyKeys).values({
        userId: ids.user,
        key: 'idem-1',
        requestHash: new Uint8Array(32),
        responseStatus: 201,
        responseBody: {},
        expiresAt: new Date().toISOString(),
      }),
    ).rejects.toSatisfy((error) => sqlState(error) === '23505');
    const [deleted] = await db
      .insert(schema.deletedSubjects)
      .values({ subjectId: uuidv7(), reason: 'user_request' })
      .returning();
    expectIso(deleted?.subjectDeletedAt);
    const [prefs] = await db.select().from(schema.userPreferences);
    expectIso(prefs?.updatedAt);
    expect(prefs?.deletedAt).toBeNull();
  });
});

describe('flight core domain', () => {
  it('computes flight_key from the natural key, reads instants as ISO, and rejects a duplicate', async () => {
    const { db } = tdb;
    const origin = await resolveAirportEndpoint(db, 'KJFK');
    const destination = await resolveAirportEndpoint(db, 'EGLL');
    expect(origin).toEqual({ airportId: ids.airport, icao: 'KJFK', tz: 'America/New_York' });
    const [flight] = await db
      .insert(schema.flightInstances)
      .values({
        id: ids.flight,
        operatingCarrierIcao: 'AAL',
        flightNumber: '100',
        scheduledDepartureDate: '2026-09-19',
        ...originColumns(origin!),
        ...destinationColumns(destination!),
        scheduledOut: '2026-09-19T22:30:00.000Z',
        actualIn: '2026-09-20 10:05:00.5+00',
        timelineSummary: { events: 0 },
      })
      .returning();
    expect(flight?.flightKey).toBe('AAL-100-2026-09-19-KJFK');
    expect(flight?.originTz).toBe('America/New_York');
    // Postgres renders `2026-09-19 22:30:00+00`; the instant() column normalises it to the
    // ISO-8601 UTC form the shared contracts require, whatever the session time zone.
    expect(flight?.scheduledOut).toBe('2026-09-19T22:30:00Z');
    expect(flight?.actualIn).toBe('2026-09-20T10:05:00.5Z');
    expectIso(flight?.scheduledOut);
    expectIso(flight?.createdAt);
    expect(flight?.estimatedOut).toBeNull();

    const [leg2] = await db
      .insert(schema.flightInstances)
      .values({
        operatingCarrierIcao: 'AAL',
        flightNumber: '100',
        scheduledDepartureDate: '2026-09-19',
        originIcao: 'KJFK',
        legSeq: 2,
      })
      .returning();
    expect(leg2?.flightKey).toBe('AAL-100-2026-09-19-KJFK-L2');
    await expect(
      db.insert(schema.flightInstances).values({
        operatingCarrierIcao: 'AAL',
        flightNumber: '100',
        scheduledDepartureDate: '2026-09-19',
        originIcao: 'KJFK',
      }),
    ).rejects.toSatisfy((error) => sqlState(error) === '23505');
    await expect(
      db.insert(schema.flightInstances).values({
        operatingCarrierIcao: 'AA',
        flightNumber: '0100',
        scheduledDepartureDate: '2026-09-19',
        originIcao: 'KJFK',
      }),
    ).rejects.toSatisfy((error) => sqlState(error) === '23514');
  });

  it('keeps the airport triple consistent and every code well formed', async () => {
    const { db } = tdb;
    const base = {
      operatingCarrierIcao: 'AAL',
      flightNumber: '101',
      scheduledDepartureDate: '2026-09-19',
    };
    // The code and the airport row disagree: composite FK (23503).
    await expect(
      db.insert(schema.flightInstances).values({
        ...base,
        originIcao: 'EGLL',
        originAirportId: ids.airport,
        originTz: 'America/New_York',
      }),
    ).rejects.toSatisfy((error) => sqlState(error) === '23503');
    // The airport is known but its zone was not carried over (23514).
    await expect(
      db.insert(schema.flightInstances).values({
        ...base,
        originIcao: 'KJFK',
        originAirportId: ids.airport,
      }),
    ).rejects.toSatisfy((error) => sqlState(error) === '23514');
    // A destination row without its code (23514).
    await expect(
      db.insert(schema.flightInstances).values({
        ...base,
        originIcao: 'KJFK',
        destinationAirportId: ids.destination,
      }),
    ).rejects.toSatisfy((error) => sqlState(error) === '23514');
    for (const junk of [
      { destinationIcao: 'not-an-icao' },
      { divertedToIcao: 'kbos' },
      { aircraftTypeIcao: 'b738x' },
      { icaoHex: 'a1b2c3' },
    ]) {
      await expect(
        db.insert(schema.flightInstances).values({ ...base, originIcao: 'KJFK', ...junk }),
      ).rejects.toSatisfy((error) => sqlState(error) === '23514');
    }
    // A bare timestamp without a zone designator never reaches Postgres.
    await expect(
      (async () => {
        await db
          .insert(schema.flightInstances)
          .values({ ...base, originIcao: 'KJFK', scheduledOut: '2026-09-19 22:30:00' });
      })(),
    ).rejects.toThrow(InstantFormatError);
  });

  it('round-trips designators, events, merges and tracks', async () => {
    const { db } = tdb;
    await db.insert(schema.flightDesignators).values({
      marketingCarrierIcao: 'BAW',
      marketingCarrierIata: 'BA',
      flightNumber: '1512',
      scheduledDepartureDate: '2026-09-19',
      originIcao: 'KJFK',
      flightInstanceId: ids.flight,
      kind: 'codeshare',
      source: 'aerodatabox',
    });
    await expect(
      db.insert(schema.flightDesignators).values({
        marketingCarrierIcao: 'BAW',
        flightNumber: '1513',
        scheduledDepartureDate: '2026-09-19',
        originIcao: 'jfk',
        flightInstanceId: ids.flight,
        source: 'aerodatabox',
      }),
    ).rejects.toSatisfy((error) => sqlState(error) === '23514');
    await db.insert(schema.flightEvents).values([
      {
        flightInstanceId: ids.flight,
        seq: 0,
        occurredAt: '2026-09-19T20:00:00Z',
        type: 'schedule_change',
        field: 'scheduled_out',
        oldValue: null,
        newValue: '2026-09-19T22:30:00Z',
        source: 'aeroapi',
      },
      {
        flightInstanceId: ids.flight,
        seq: 1,
        occurredAt: '2026-09-19T21:00:00Z',
        type: 'gate_change',
        newValue: { gate: 'B31' },
        source: 'system',
      },
    ]);
    await expect(
      db.insert(schema.flightEvents).values({
        flightInstanceId: ids.flight,
        seq: 1,
        occurredAt: '2026-09-19T21:00:00Z',
        type: 'dup',
        source: 'system',
      }),
    ).rejects.toSatisfy((error) => sqlState(error) === '23505');
    const events = await db
      .select()
      .from(schema.flightEvents)
      .where(eq(schema.flightEvents.flightInstanceId, ids.flight));
    expect(events).toHaveLength(2);
    expect(events[1]?.newValue).toEqual({ gate: 'B31' });
    expect(events[0]?.occurredAt).toBe('2026-09-19T20:00:00Z');
    expectIso(events[0]?.occurredAt);
    await db.insert(schema.flightTracks).values({
      flightInstanceId: ids.flight,
      r2Key: 'tracks/2026/09/AAL-100-2026-09-19-KJFK.jsonl.gz',
      sampleCount: 200,
      source: 'adsb_lol',
    });
  });
});

describe('trips and subscriptions domain', () => {
  it('round-trips trips, members, subscriptions with encrypted PNR, logbook, stats, counters', async () => {
    const { db } = tdb;
    await db.insert(schema.trips).values({ id: ids.trip, userId: ids.user, name: 'London' });
    await db
      .insert(schema.tripMembers)
      .values({ tripId: ids.trip, userId: ids.user, role: 'owner' });
    await db.insert(schema.flightSubscriptions).values({
      id: ids.subscription,
      userId: ids.user,
      flightInstanceId: ids.flight,
      tripId: ids.trip,
      confirmationCodeEnc: new Uint8Array([1, 2, 3]),
      confirmationCodeKeyVersion: 1,
      notificationOverrides: { gate_change: false },
    });
    await expect(
      db.insert(schema.flightSubscriptions).values({
        userId: ids.user,
        flightInstanceId: ids.flight,
      }),
    ).rejects.toSatisfy((error) => sqlState(error) === '23505');
    // Restrict: the subscribed instance cannot be deleted from under the user (SQLSTATE 23001,
    // restrict_violation, which Postgres raises for ON DELETE RESTRICT rather than 23503).
    await expect(
      db.delete(schema.flightInstances).where(eq(schema.flightInstances.id, ids.flight)),
    ).rejects.toSatisfy((error) => sqlState(error) === '23001');
    await db.insert(schema.logbookEntries).values([
      {
        userId: ids.user,
        flightInstanceId: ids.flight,
        flightDate: '2026-09-19',
        operatingCarrierIcao: 'AAL',
        flightNumber: '100',
        originIcao: 'KJFK',
        destinationIcao: 'EGLL',
        aircraftTypeIcao: 'B772',
        cabin: 'business',
      },
      // A manual entry at an airport whose code is an ident-derived pseudo code.
      {
        userId: ids.user,
        flightDate: '2026-09-20',
        originIcao: '03N',
        destinationIcao: 'PKMJ',
        source: 'manual',
      },
    ]);
    for (const junk of [
      { originIcao: 'kjfk', destinationIcao: 'EGLL' },
      { originIcao: 'KJFK', destinationIcao: 'yy' },
      { originIcao: 'KJFK', destinationIcao: 'EGLL', operatingCarrierIcao: 'american airlines' },
      { originIcao: 'KJFK', destinationIcao: 'EGLL', flightNumber: 'AA 0100' },
    ]) {
      await expect(
        db
          .insert(schema.logbookEntries)
          .values({ userId: ids.user, flightDate: '2026-09-19', source: 'manual', ...junk }),
      ).rejects.toSatisfy((error) => sqlState(error) === '23514');
    }
    await db.insert(schema.userStatsYearly).values({ userId: ids.user, year: 2026, flights: 1 });
    await db.insert(schema.usageCounters).values({
      scope: 'user',
      subject: ids.user,
      counter: 'active_subscriptions',
      windowStart: '2026-09-20T00:00:00Z',
      count: 1,
    });
    const [sub] = await db
      .select()
      .from(schema.flightSubscriptions)
      .where(eq(schema.flightSubscriptions.id, ids.subscription));
    expect(sub?.notificationOverrides).toEqual({ gate_change: false });
    expect(sub?.deletedAt).toBeNull();
    expectIso(sub?.updatedAt);
    const [counter] = await db.select().from(schema.usageCounters);
    expect(counter?.windowStart).toBe('2026-09-20T00:00:00Z');
  });
});

describe('providers domain', () => {
  it('round-trips calls, daily rollups, budgets, alerts, webhooks, models, weather and BTS', async () => {
    const { db } = tdb;
    await db.insert(schema.providerCalls).values({
      provider: 'aeroapi',
      operation: 'flight_status',
      trigger: 'alarm',
      result: 'ok',
      httpStatus: 200,
      durationMs: 120,
      costUnits: 1,
      costUsdMicros: 5000,
      flightInstanceId: ids.flight,
      flightKey: 'AAL-100-2026-09-19-KJFK',
    });
    const [call] = await db.select().from(schema.providerCalls);
    expectIso(call?.createdAt);
    await db.insert(schema.providerCallDaily).values({
      day: '2026-09-19',
      provider: 'aeroapi',
      operation: 'flight_status',
      result: 'ok',
      calls: 1,
      costUsdMicros: 5_000_000_000,
    });
    const [daily] = await db.select().from(schema.providerCallDaily);
    expect(daily?.costUsdMicros).toBe(5_000_000_000);
    await db
      .insert(schema.providerBudgetConfig)
      .values({ provider: 'aeroapi', dailyCapUnits: 10_000 });
    const [registration] = await db
      .insert(schema.providerAlertRegistrations)
      .values({
        provider: 'aeroapi',
        externalAlertId: 'alert-1',
        flightInstanceId: ids.flight,
        events: ['departure', 'arrival', 'cancelled'],
        maxWeekly: 50,
      })
      .returning();
    expect(registration?.events).toEqual(['departure', 'arrival', 'cancelled']);
    expectIso(registration?.registeredAt);
    for (const events of [['departure', 'bogus'], { departure: true }, 'departure']) {
      await expect(
        db.insert(schema.providerAlertRegistrations).values({
          provider: 'aeroapi',
          externalAlertId: `alert-bad-${JSON.stringify(events)}`,
          flightInstanceId: ids.flight,
          events,
        }),
      ).rejects.toSatisfy((error) => sqlState(error) === '23514');
    }
    await db.insert(schema.providerWebhookEvents).values({
      provider: 'aeroapi',
      externalId: 'evt-1',
      signatureValid: true,
      payload: { hello: 'world' },
    });
    await db.insert(schema.delayPredictions).values({
      flightInstanceId: ids.flight,
      modelVersion: 'baseline-1',
      pDelay15: 0.2,
    });
    await db
      .insert(schema.delayOutcomes)
      .values({ flightInstanceId: ids.flight, departureDelayMinutes: 5 });
    await db.insert(schema.airportWxObservations).values({
      icao: 'KJFK',
      kind: 'metar',
      observedAt: '2026-09-19T20:51:00Z',
      raw: 'KJFK 192051Z 18010KT 10SM FEW250 27/18 A3001',
    });
    // The KV key is `wx:metar:{ICAO}`; a lower-case row would fork the namespace.
    await expect(
      db.insert(schema.airportWxObservations).values({
        icao: 'kjfk',
        kind: 'metar',
        observedAt: '2026-09-19T20:51:00Z',
        raw: 'x',
      }),
    ).rejects.toSatisfy((error) => sqlState(error) === '23514');
    await db.insert(schema.airportNasEvents).values({
      airportIata: 'JFK',
      airportIcao: 'KJFK',
      kind: 'ground_stop',
      startedAt: '2026-09-19T20:00:00Z',
    });
    await db.insert(schema.airportDelaySnapshots).values({
      icao: 'KJFK',
      capturedAt: '2026-09-19T20:00:00Z',
      source: 'aerodatabox',
    });
    await expect(
      db.insert(schema.airportDelaySnapshots).values({
        icao: ' KJFK ',
        capturedAt: '2026-09-19T20:00:00Z',
        source: 'aerodatabox',
      }),
    ).rejects.toSatisfy((error) => sqlState(error) === '23514');
    await db
      .insert(schema.airportDelayHourly)
      .values({ icao: 'KJFK', hourStart: '2026-09-19T20:00:00Z' });
    await expect(
      db
        .insert(schema.airportDelayHourly)
        .values({ icao: 'kjfk', hourStart: '2026-09-19T21:00:00Z' }),
    ).rejects.toSatisfy((error) => sqlState(error) === '23514');
    await db.insert(schema.btsImportRuns).values({
      id: ids.btsRun,
      year: 2026,
      month: 6,
      sourceUrl: 'https://transtats.bts.gov/example',
      sourceSha256: new Uint8Array(32).fill(1),
      sourceBytes: 3_000_000_000,
      status: 'succeeded',
    });
    const [run] = await db.select().from(schema.btsImportRuns);
    expect(run?.sourceBytes).toBe(3_000_000_000);
    expectIso(run?.startedAt);
    await db.insert(schema.btsCarrierFlightMonthly).values({
      year: 2026,
      month: 6,
      marketingCarrier: 'AA',
      operatingCarrier: 'MQ',
      flightNumber: '3450',
      originIata: 'ORD',
      destinationIata: 'HPN',
      flights: 30,
      importRunId: ids.btsRun,
    });
    await db.insert(schema.btsRouteMonthly).values({
      year: 2026,
      month: 6,
      operatingCarrier: 'MQ',
      originIata: 'ORD',
      destinationIata: 'HPN',
      importRunId: ids.btsRun,
    });
    await db.insert(schema.btsAirportHourly).values({
      year: 2026,
      month: 6,
      airportIata: 'ORD',
      hourLocal: 7,
      direction: 'dep',
      importRunId: ids.btsRun,
    });
  });
});

describe('notifications domain', () => {
  it('round-trips preferences, push tokens, live activities, notifications and deliveries', async () => {
    const { db } = tdb;
    await db.insert(schema.notificationPreferences).values({
      userId: ids.user,
      quietHoursStartMinutes: 1380,
      quietHoursEndMinutes: 420,
      quietHoursTz: 'America/New_York',
    });
    const [token] = await db
      .insert(schema.pushTokens)
      .values({ userId: ids.user, deviceId: ids.device, kind: 'apns', token: 'abc' })
      .returning();
    await db.insert(schema.liveActivities).values({
      userId: ids.user,
      deviceId: ids.device,
      flightSubscriptionId: ids.subscription,
      flightInstanceId: ids.flight,
      activityId: 'activity-1',
      pushToken: 'la-token',
      contentStateHash: new Uint8Array(32),
    });
    await db.insert(schema.notifications).values({
      id: ids.notification,
      userId: ids.user,
      flightInstanceId: ids.flight,
      kind: 'gate_change',
      dedupeKey: `${ids.flight}:gate_change:B31`,
      title: 'Gate change',
      body: 'AA100 now departs from B31',
    });
    await db.insert(schema.notificationDeliveries).values({
      notificationId: ids.notification,
      subjectId: ids.user,
      channel: 'apns',
      pushTokenId: token?.id,
      status: 'sent',
      sentAt: '2026-09-19T21:00:05Z',
    });
    const [delivery] = await db.select().from(schema.notificationDeliveries);
    expect(delivery?.sentAt).toBe('2026-09-19T21:00:05Z');
    expectIso(delivery?.createdAt);
    await expect(
      db.insert(schema.notificationPreferences).values({
        userId: uuidv7(),
        quietHoursStartMinutes: 1500,
      }),
    ).rejects.toSatisfy((error) => sqlState(error) === '23514' || sqlState(error) === '23503');
  });

  it('dedupes notifications per user: a fan-out of one event reaches every subscriber once', async () => {
    const { db } = tdb;
    const dedupeKey = `${ids.flight}:gate_change:B31`;
    // The same logical event for a second subscriber is a new row for that user.
    await db.insert(schema.notifications).values({
      userId: ids.user2,
      flightInstanceId: ids.flight,
      kind: 'gate_change',
      dedupeKey,
      title: 'Gate change',
      body: 'AA100 now departs from B31',
    });
    // A replay for a user who already has it is rejected.
    await expect(
      db.insert(schema.notifications).values({
        userId: ids.user2,
        flightInstanceId: ids.flight,
        kind: 'gate_change',
        dedupeKey,
        title: 'Gate change',
        body: 'replay',
      }),
    ).rejects.toSatisfy((error) => sqlState(error) === '23505');
    const rows = await db
      .select({ userId: schema.notifications.userId })
      .from(schema.notifications)
      .where(eq(schema.notifications.dedupeKey, dedupeKey));
    expect(rows.map((r) => r.userId).sort()).toEqual([ids.user, ids.user2].sort());
  });
});

describe('import, calendar and sharing domain', () => {
  it('round-trips email, inbound, imports, calendar, ICS, share links and meet-me sessions', async () => {
    const { db } = tdb;
    const [emailAccount] = await db
      .insert(schema.emailAccounts)
      .values({
        userId: ids.user,
        provider: 'gmail',
        emailAddress: 'test@example.com',
        accessTokenEnc: new Uint8Array([9]),
        accessTokenKeyVersion: 1,
        scopes: ['gmail.metadata'],
      })
      .returning();
    expectIso(emailAccount?.createdAt);
    const [processed] = await db
      .insert(schema.emailMessagesProcessed)
      .values({
        emailAccountId: emailAccount!.id,
        userId: ids.user,
        providerMessageId: 'msg-1',
        outcome: 'extracted',
      })
      .returning();
    await db.insert(schema.emailExtractions).values({
      userId: ids.user,
      emailMessageProcessedId: processed!.id,
      extractor: 'llm',
      modelVersion: 'x',
      extracted: { flights: [] },
      confidence: 0.9,
      tokensIn: 100,
      tokensOut: 20,
    });
    const [address] = await db
      .insert(schema.inboundAddresses)
      .values({ userId: ids.user, localPart: 'abc123' })
      .returning();
    await db.insert(schema.inboundMessages).values({
      inboundAddressId: address!.id,
      userId: ids.user,
      messageId: '<m@example.com>',
      fromDomain: 'aa.com',
    });
    const [imp] = await db
      .insert(schema.imports)
      .values({ userId: ids.user, kind: 'csv', fileName: 'flights.csv' })
      .returning();
    await db.insert(schema.importRows).values({
      importId: imp!.id,
      userId: ids.user,
      rowNumber: 1,
      raw: { a: 1 },
    });
    const [connection] = await db
      .insert(schema.calendarConnections)
      .values({ userId: ids.user, provider: 'google', externalAccountId: 'g-1' })
      .returning();
    await db.insert(schema.calendarEvents).values({
      userId: ids.user,
      calendarConnectionId: connection!.id,
      flightSubscriptionId: ids.subscription,
      externalEventId: 'evt-1',
      contentHash: new Uint8Array(32),
    });
    await db.insert(schema.icsFeedTokens).values({
      userId: ids.user,
      tokenHash: new Uint8Array(32).fill(2),
      tokenPrefix: 'pa_ics_a',
    });
    const [link] = await db
      .insert(schema.shareLinks)
      .values({
        userId: ids.user,
        kind: 'flight',
        flightInstanceId: ids.flight,
        flightSubscriptionId: ids.subscription,
        tokenHash: new Uint8Array(32).fill(3),
        tokenPrefix: 'pa_shr_a',
      })
      .returning();
    await expect(
      db.insert(schema.shareLinks).values({
        userId: ids.user,
        kind: 'trip',
        flightInstanceId: ids.flight,
        tokenHash: new Uint8Array(32).fill(4),
        tokenPrefix: 'pa_shr_b',
      }),
    ).rejects.toSatisfy((error) => sqlState(error) === '23514');
    await db.insert(schema.shareLinkViews).values({ shareLinkId: link!.id, country: 'US' });
    const [session] = await db
      .insert(schema.meetMeSessions)
      .values({
        userId: ids.user,
        flightInstanceId: ids.flight,
        tokenHash: new Uint8Array(32).fill(5),
        tokenPrefix: 'pa_mtm_a',
        expiresAt: '2026-09-20T02:00:00Z',
      })
      .returning();
    expect(session?.expiresAt).toBe('2026-09-20T02:00:00Z');
  });
});

describe('billing, API and GDPR domain', () => {
  it('round-trips entitlements, RevenueCat events, subscriptions, tokens, audit, jobs', async () => {
    const { db } = tdb;
    await db.insert(schema.entitlements).values({
      userId: ids.user,
      rcAppUserId: 'rc-random-1',
      entitlementId: 'premium',
      status: 'active',
      store: 'app_store',
    });
    await db.insert(schema.revenuecatEvents).values({
      eventId: 'evt-1',
      type: 'INITIAL_PURCHASE',
      rcAppUserId: 'rc-random-1',
      occurredAt: '2026-09-19T00:00:00Z',
      payload: {},
    });
    await db.insert(schema.subscriptions).values({
      rcAppUserId: 'rc-random-1',
      store: 'app_store',
      productId: 'premium_monthly',
      originalTransactionId: 'tx-1',
      status: 'active',
      priceMicros: 4_990_000,
      currency: 'USD',
    });
    await db.insert(schema.apiTokens).values({
      userId: ids.user,
      kind: 'pat',
      tokenHash: new Uint8Array(32).fill(6),
      tokenPrefix: 'pa_pat_a',
      scopes: ['flights:read'],
    });
    const [audit] = await db
      .insert(schema.auditLog)
      .values({
        subjectId: ids.user,
        actorType: 'user',
        actorId: ids.user,
        action: 'flight.subscribe',
        targetType: 'flight_subscription',
        targetId: ids.subscription,
      })
      .returning();
    expectIso(audit?.createdAt);
    await db.insert(schema.dataExportJobs).values({ userId: ids.user });
    await db.insert(schema.accountDeletionRequests).values({ subjectId: ids.user, source: 'app' });
    const [token] = await db.select().from(schema.apiTokens);
    expect(token?.scopes).toEqual(['flights:read']);
    const [event] = await db.select().from(schema.revenuecatEvents);
    expect(event?.occurredAt).toBe('2026-09-19T00:00:00Z');
  });

  it('keeps audit, delivery and billing rows when the user is deleted', async () => {
    const { db } = tdb;
    await db.delete(schema.users).where(eq(schema.users.id, ids.user));
    expect(await db.select().from(schema.flightSubscriptions)).toHaveLength(0);
    expect(await db.select().from(schema.apiTokens)).toHaveLength(0);
    expect(await db.select().from(schema.auditLog)).toHaveLength(1);
    expect(await db.select().from(schema.notificationDeliveries)).toHaveLength(1);
    expect(await db.select().from(schema.revenuecatEvents)).toHaveLength(1);
    expect(await db.select().from(schema.subscriptions)).toHaveLength(1);
    expect(await db.select().from(schema.providerCalls)).toHaveLength(1);
    expect(await db.select().from(schema.accountDeletionRequests)).toHaveLength(1);
    // The flight itself survives: it belongs to nobody.
    expect(await db.select().from(schema.flightInstances)).toHaveLength(2);
    // Better Auth's rate_limits and verifications rows have no FK and survive too: the
    // deletion job must purge them by key and identifier (docs/schema-review.md section 5).
    expect(await db.select().from(schema.rateLimits)).toHaveLength(1);
    expect(await db.select().from(schema.verifications)).toHaveLength(1);
  });
});

function airport(
  id: string,
  icao: string,
  iata: string | null,
  tz: string,
  type = 'large_airport',
): typeof schema.airports.$inferInsert {
  return {
    id,
    ourairportsId: Math.floor(Math.random() * 1_000_000),
    ident: icao,
    icao,
    icaoSource: 'icao_code',
    iata,
    name: `${icao} test airport`,
    type,
    latitude: 40.6413,
    longitude: -73.7781,
    isoCountry: 'US',
    scheduledService: true,
    tz,
    tzSource: 'mwgg',
  };
}
