/**
 * Ruling B2's Worker half (increment 18): a board request's airport is resolved from Postgres
 * through KV `ref:airport:{code}` (a day for a known airport, an hour for an unknown code) before
 * any AirportState object is touched. The API test database has no reference data, so each test
 * inserts its own synthetic airport.
 */

import { describe, expect, it } from 'vitest';
import { airports, withDb } from '@planeahead/db';
import {
  AIRPORT_REF_NEGATIVE_TTL_SECONDS,
  resolveBoardAirportCached,
} from '../../src/boards/airport-ref';
import { uniqueAirport } from './helpers/airports';
import { testEnv } from './helpers/flights';

/** A KV that keeps values in memory and records every write's options. */
function memoryKv() {
  const values = new Map<string, string>();
  const puts: { key: string; ttl: number | undefined }[] = [];
  const kv = {
    get: (key: string) =>
      Promise.resolve(values.has(key) ? (JSON.parse(values.get(key) ?? '') as unknown) : null),
    put: (key: string, value: string, options?: KVNamespacePutOptions) => {
      values.set(key, value);
      puts.push({ key, ttl: options?.expirationTtl });
      return Promise.resolve();
    },
  } as unknown as Pick<KVNamespace, 'get' | 'put'>;
  return { kv, puts };
}

async function insertAirport(icao: string, iata: string): Promise<void> {
  await withDb(testEnv, async (db) => {
    await db.insert(airports).values({
      ourairportsId: 900_000_000 + Math.floor(Math.random() * 99_000_000),
      ident: icao,
      icao,
      icaoSource: 'icao_code',
      iata,
      name: `Test Field ${icao}`,
      type: 'large_airport',
      latitude: 40,
      longitude: -73,
      isoCountry: 'US',
      tz: 'America/New_York',
      tzSource: 'override',
    });
  });
}

describe('resolveBoardAirportCached (ruling B2)', () => {
  it('resolves by ICAO or IATA, any case, and keeps the answer a day', async () => {
    const icao = uniqueAirport();
    const iata = icao.slice(1);
    await insertAirport(icao, iata);
    const { kv, puts } = memoryKv();
    const env = { DB: testEnv.DB, CACHE: kv };
    const expected = { icao, iata, name: `Test Field ${icao}`, tz: 'America/New_York' };
    expect(await resolveBoardAirportCached(env, icao.toLowerCase())).toEqual(expected);
    expect(await resolveBoardAirportCached(env, iata)).toEqual(expected);
    expect(puts).toEqual([
      { key: `ref:airport:${icao}`, ttl: 86_400 },
      { key: `ref:airport:${iata}`, ttl: 86_400 },
    ]);
    // Served from KV: a second read writes nothing.
    expect(await resolveBoardAirportCached(env, icao)).toEqual(expected);
    expect(puts).toHaveLength(2);
  });

  it('answers null for an unknown code (remembered an hour) and for a malformed one (no lookup)', async () => {
    const { kv, puts } = memoryKv();
    const env = { DB: testEnv.DB, CACHE: kv };
    const unknown = uniqueAirport();
    expect(await resolveBoardAirportCached(env, unknown)).toBeNull();
    expect(puts).toEqual([
      { key: `ref:airport:${unknown}`, ttl: AIRPORT_REF_NEGATIVE_TTL_SECONDS },
    ]);
    expect(await resolveBoardAirportCached(env, unknown)).toBeNull();
    expect(puts).toHaveLength(1);
    expect(await resolveBoardAirportCached(env, 'NOT-A-CODE')).toBeNull();
    expect(await resolveBoardAirportCached(env, 'K')).toBeNull();
    expect(puts).toHaveLength(1);
  });
});
