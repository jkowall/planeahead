#!/usr/bin/env node
/**
 * Records AeroDataBox fixtures from the real direct gateway, and measures what increment 6 could
 * not measure without a key: the lookahead a plan really allows and the p50 / p95 latency of a
 * flight status call. Results go in the build log; the fixtures replace the synthetic ones in
 * apps/api/src/providers/fixtures/aerodatabox once reviewed.
 *
 *   AERODATABOX_API_KEY=... node scripts/record-adb-fixtures.mjs --date 2026-10-01 \
 *     --designators AA100,BA1512,AA3456 --airport KJFK [--probe-lookahead] [--samples 20]
 *
 * It SPENDS REAL UNITS (2 per flight status call, 2 per FIDS call, 1 per airport lookup; the
 * health check is free) and is never run by CI or by the test suite, which only ever sees the
 * fixtures. A Starter key may be used for recording only if the recorded data is not retained:
 * the Starter caching term is 7 days (facts sheet section 1).
 *
 * What it guarantees about the files it writes:
 *   - the key never appears: it is sent only as the X-Api-Key header, no header is stored, and
 *     every body is checked for the key string before it is written (the script aborts if found);
 *   - the date is pinned: every request uses `--date`, and the fixture records it, so a re-run on
 *     another day asks the same question;
 *   - `withFlightPlan`, `withAircraftImage` and `withLocation` are never sent;
 *   - each fixture uses the same envelope as the synthetic ones, with `synthetic: false`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const BASE_URL = 'https://api.aerodatabox.com/';
const SPEC = 'specs/aerodatabox-direct-v1.15.3.yaml';
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_OUT = join(repoRoot, 'apps/api/src/providers/fixtures/aerodatabox/recorded');

const { values } = parseArgs({
  options: {
    date: { type: 'string' },
    designators: { type: 'string', default: 'AA100' },
    airport: { type: 'string', default: 'KJFK' },
    out: { type: 'string', default: DEFAULT_OUT },
    samples: { type: 'string', default: '0' },
    'probe-lookahead': { type: 'boolean', default: false },
  },
});

function fail(message) {
  process.stderr.write(`record-adb-fixtures: ${message}\n`);
  process.exit(1);
}

const apiKey = process.env['AERODATABOX_API_KEY'];
if (apiKey === undefined || apiKey.trim() === '') {
  fail('AERODATABOX_API_KEY is not set; this script calls the real gateway and needs a key');
}
const date = values.date;
if (date === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  fail('--date YYYY-MM-DD is required: the recording is pinned to one local date');
}
const airport = values.airport.trim().toUpperCase();
if (!/^[A-Z0-9]{4}$/.test(airport)) {
  fail(`--airport must be an ICAO code, got "${values.airport}"`);
}
const designators = values.designators
  .split(',')
  .map((value) => value.trim().toUpperCase().replace(/\s+/g, ''))
  .filter((value) => value !== '');

/** One GET, timed. Returns the envelope a fixture needs; never keeps a header but the type. */
async function get(path) {
  const url = new URL(path, BASE_URL);
  for (const forbidden of ['withFlightPlan', 'withAircraftImage', 'withLocation']) {
    if (url.searchParams.has(forbidden)) {
      fail(`refusing to send ${forbidden}`);
    }
  }
  const started = performance.now();
  const response = await fetch(url, {
    headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
  });
  const text = response.status === 204 ? '' : await response.text();
  const latencyMs = Math.round(performance.now() - started);
  if (text.includes(apiKey)) {
    fail(`the response to ${url.pathname} echoes the key; nothing was written`);
  }
  const contentType = response.headers.get('content-type') ?? undefined;
  let body;
  if (text !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return {
    latencyMs,
    status: response.status,
    envelope: {
      synthetic: false,
      recordedAt: new Date().toISOString(),
      pinnedDate: date,
      spec: SPEC,
      request: { method: 'GET', path: `${url.pathname}${url.search}` },
      response: {
        status: response.status,
        ...(body === undefined ? {} : { contentType, body }),
      },
    },
  };
}

function write(name, envelope, schema, note) {
  mkdirSync(values.out, { recursive: true });
  const file = join(values.out, name);
  const text = `${JSON.stringify({ ...envelope, schema, note }, null, 2)}\n`;
  if (text.includes(apiKey)) {
    fail(`refusing to write ${name}: the key would be in it`);
  }
  writeFileSync(file, text);
  process.stdout.write(`wrote ${file} (${String(envelope.response.status)})\n`);
}

function percentile(sorted, p) {
  if (sorted.length === 0) {
    return null;
  }
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

async function main() {
  const latencies = [];
  for (const designator of designators) {
    const result = await get(`flights/Number/${encodeURIComponent(designator)}/${date}`);
    latencies.push(result.latencyMs);
    write(
      `flight-${designator.toLowerCase()}-${date}.json`,
      result.envelope,
      result.status === 200 ? 'FlightContract[]' : null,
      `Recorded ${designator} on ${date}.`,
    );
  }
  const health = await get(`health/services/airports/${airport}/feeds`);
  write(
    `health-${airport.toLowerCase()}.json`,
    health.envelope,
    'AirportFeedServiceStatusContract',
    'Recorded (free tier).',
  );
  const airportLookup = await get(`airports/Icao/${airport}`);
  write(
    `airport-${airport.toLowerCase()}.json`,
    airportLookup.envelope,
    'AirportContract',
    'Recorded.',
  );
  const fids = await get(
    `flights/airports/Icao/${airport}/${date}T12:00/${date}T18:00?direction=Departure&withLeg=false&withCancelled=true&withCodeshared=true&withCargo=false&withPrivate=false`,
  );
  write(
    `fids-${airport.toLowerCase()}-${date}.json`,
    fids.envelope,
    'AirportFidsContract',
    'Recorded, 6 hours.',
  );

  const extra = Number(values.samples);
  const first = designators[0];
  for (let i = 0; first !== undefined && i < extra; i += 1) {
    latencies.push((await get(`flights/Number/${encodeURIComponent(first)}/${date}`)).latencyMs);
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  process.stdout.write(
    `flight status latency over ${String(sorted.length)} calls: p50 ${String(percentile(sorted, 50))} ms, p95 ${String(percentile(sorted, 95))} ms\n`,
  );

  if (values['probe-lookahead'] && first !== undefined) {
    // The largest number of days ahead the plan answers (200 or 204) rather than refusing (400).
    let low = 0;
    let high = 400;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const probe = new Date(Date.now() + mid * 86_400_000).toISOString().slice(0, 10);
      const { status } = await get(`flights/Number/${encodeURIComponent(first)}/${probe}`);
      if (status === 200 || status === 204) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    process.stdout.write(`measured lookahead: ${String(low)} days (record in the build log)\n`);
  }
}

await main();
