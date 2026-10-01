#!/usr/bin/env node
/**
 * The AeroDataBox boards probe (increment 18, ruling B13; R3 U1 to U7): the test calls that settle
 * what the board design could not measure without a key. Run it once, by hand, on the day the
 * Growth key arrives (docs/runbooks/first-deploy.md), then copy its answers into
 * docs/increments/18-verification.md.
 *
 *   node scripts/probe-adb-boards.mjs --dry-run                 # the plan and its units, no network
 *   AERODATABOX_API_KEY=... node scripts/probe-adb-boards.mjs --date 2026-10-02 \
 *     --out docs/increments/18-probe-findings.json [--page-hours 24] [--no-prompt] [--pause-ms 300]
 *
 * It SPENDS REAL UNITS (about 40: 2 per FIDS call, the coverage checks are free; the dry run
 * prints the exact plan) and is never run by CI or by the test suite, which only runs the dry run.
 *
 * What it answers:
 *   U1  whether FIDS selects a flight by its scheduled or its revised time (a window around a
 *       delayed departure's revised time that excludes its scheduled time, and the reverse);
 *   U2  whether `direction=Both` bills as one call or as two;
 *   U3  whether `withLeg` or `withLocation` add a surcharge;
 *   U4  a hub bucket's payload size (raw and gzip, against the 1 MB chunk and the 2 MB value
 *       limit) and latency at KATL, EGLL and KJFK, for both 12-hour buckets and a 24-hour window;
 *   U5  whether FIDS answers a date 180 days out;
 *   U6  whether a 204 (no flights) or a 400 (a window wider than the plan's page) bills units;
 *   U7  whether a window of exactly the page size is accepted, and whether `toLocal` is inclusive.
 *
 * Billing (U2, U3, U6) is read from the account's unit counter. The direct API has no endpoint for
 * it (only the webhook credit balance), so at each checkpoint the script asks for the counter as
 * the AeroDataBox dashboard shows it (Enter skips; `--no-prompt` skips all), and it records every
 * response header that looks like a quota counter in case the gateway sends one.
 *
 * What it keeps: measurements only (status, latency, sizes, row counts, the times of the flights
 * U1 and U7 compare, quota-like headers). No response body is written, the key is sent only as
 * the X-Api-Key header and the findings are checked for it before they are written.
 */

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';

export const BASE_URL = 'https://api.aerodatabox.com/';
export const HUBS = ['KATL', 'EGLL', 'KJFK'];
/** Units per call by the endpoint's tier (R3 F3): FIDS is Tier 2, the coverage check free. */
export const FIDS_UNITS = 2;
/** The chunk size AirportState stores (ruling B3) and the Durable Object value limit (R3 F37). */
export const CHUNK_BYTES = 1_000_000;
export const VALUE_LIMIT_BYTES = 2_000_000;
/** A small airport with no departures in the night window U6 asks for (override with a flag). */
export const DEFAULT_EMPTY_AIRPORT = 'EGPU';
/** Growth 10 requests a second (R3 F5): one call at a time, this pause between them by default. */
const PAUSE_MS = 300;

/** The production fetch shape (ruling B1), on which U4 measures sizes. */
export const BOARD_SHAPE =
  'direction=Both&withLeg=true&withCodeshared=true&withCancelled=true&withCargo=false&withPrivate=false';
/** A single direction with no leg, the base U2 and U3 compare against. */
const DEPARTURES_SHAPE =
  'direction=Departure&withLeg=false&withCodeshared=true&withCancelled=true&withCargo=false&withPrivate=false';

/** `YYYY-MM-DD` plus `days`. */
export function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** A local wall-clock time `minutes` after `date` 00:00, as FIDS takes it (`YYYY-MM-DDTHH:mm`). */
export function wallClock(date, minutes) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + minutes * 60_000).toISOString().slice(0, 16);
}

function fids(icao, from, to, shape) {
  return `flights/airports/Icao/${icao}/${from}/${to}?${shape}`;
}

function call(id, item, purpose, path, units, options = {}) {
  return {
    id,
    item,
    purpose,
    path,
    units,
    unitsIfBothBillsTwice: options.both === true ? units * 2 : units,
    errorProbe: options.errorProbe === true,
    checkpoint: options.checkpoint ?? null,
  };
}

/**
 * Every call the probe makes, in order. U1's two windows depend on an earlier answer (a delayed
 * departure in `u2-departure`), so their path is null here and chosen at run time.
 */
export function planProbe({ date, pageHours = 24, emptyAirport = DEFAULT_EMPTY_AIRPORT }) {
  const day = (hours) => wallClock(date, hours * 60);
  const both = DEPARTURES_SHAPE.replace('direction=Departure', 'direction=Both');
  const plan = HUBS.map((icao) =>
    call(
      `coverage-${icao}`,
      'B6',
      `coverage check at ${icao} (free tier)`,
      `health/services/airports/${icao}/feeds`,
      0,
    ),
  );
  plan.push(
    call(
      'u2-both',
      'U2',
      'direction=Both, 06:00 to 18:00 at KJFK',
      fids('KJFK', day(6), day(18), both),
      FIDS_UNITS,
      { both: true, checkpoint: 'after-u2-both' },
    ),
    call(
      'u2-departure',
      'U2',
      'direction=Departure, the same window',
      fids('KJFK', day(6), day(18), DEPARTURES_SHAPE),
      FIDS_UNITS,
      { checkpoint: 'after-u2-departure' },
    ),
    call(
      'u3-withleg',
      'U3',
      'withLeg=true, the same window',
      fids('KJFK', day(6), day(18), DEPARTURES_SHAPE.replace('withLeg=false', 'withLeg=true')),
      FIDS_UNITS,
      { checkpoint: 'after-u3-withleg' },
    ),
    call(
      'u3-withlocation',
      'U3',
      'withLocation=true, the same window',
      fids('KJFK', day(6), day(18), `${DEPARTURES_SHAPE}&withLocation=true`),
      FIDS_UNITS,
      { checkpoint: 'after-u3-withlocation' },
    ),
    call(
      'u6-empty',
      'U6',
      `a night hour at ${emptyAirport}, expected 204`,
      fids(emptyAirport, day(2), day(3), DEPARTURES_SHAPE),
      FIDS_UNITS,
      { errorProbe: true, checkpoint: 'after-u6-empty' },
    ),
    call(
      'u6-too-wide',
      'U6',
      `${String(pageHours + 6)} hours at KJFK, wider than the page: expected 400`,
      fids('KJFK', day(0), day(pageHours + 6), DEPARTURES_SHAPE),
      FIDS_UNITS,
      { errorProbe: true, checkpoint: 'after-u6-too-wide' },
    ),
    call(
      'u7-exact-page',
      'U7',
      `exactly ${String(pageHours)} hours at KATL (the page size)`,
      fids('KATL', day(0), day(pageHours), DEPARTURES_SHAPE),
      FIDS_UNITS,
    ),
    call(
      'u7-to-1159',
      'U7',
      '00:00 to 11:59 at KATL',
      fids('KATL', day(0), wallClock(date, 719), DEPARTURES_SHAPE),
      FIDS_UNITS,
    ),
    call(
      'u7-to-1200',
      'U7',
      '00:00 to 12:00 at KATL: a 12:00 departure only here means toLocal is inclusive',
      fids('KATL', day(0), day(12), DEPARTURES_SHAPE),
      FIDS_UNITS,
    ),
    call(
      'u5-180-days',
      'U5',
      `06:00 to 18:00 at KJFK on ${addDays(date, 180)}, 180 days out`,
      fids(
        'KJFK',
        wallClock(addDays(date, 180), 360),
        wallClock(addDays(date, 180), 1080),
        DEPARTURES_SHAPE,
      ),
      FIDS_UNITS,
    ),
  );
  for (const icao of HUBS) {
    plan.push(
      call(
        `u4-${icao}-am`,
        'U4',
        `the 00:00 to 11:59 bucket at ${icao}, production shape`,
        fids(icao, day(0), wallClock(date, 719), BOARD_SHAPE),
        FIDS_UNITS,
        { both: true },
      ),
      call(
        `u4-${icao}-pm`,
        'U4',
        `the 12:00 to 23:59 bucket at ${icao}, production shape`,
        fids(icao, day(12), wallClock(date, 1439), BOARD_SHAPE),
        FIDS_UNITS,
        { both: true },
      ),
    );
    if (pageHours >= 24) {
      plan.push(
        call(
          `u4-${icao}-24h`,
          'U4',
          `00:00 to 23:59 at ${icao}, one 24-hour call`,
          fids(icao, day(0), wallClock(date, 1439), BOARD_SHAPE),
          FIDS_UNITS,
          { both: true },
        ),
      );
    }
  }
  plan.push(
    call(
      'u1-revised-window',
      'U1',
      'a window around a delayed departure’s revised time, excluding its scheduled time',
      null,
      FIDS_UNITS,
    ),
    call(
      'u1-scheduled-window',
      'U1',
      'a window around the same departure’s scheduled time, excluding its revised time',
      null,
      FIDS_UNITS,
    ),
  );
  return plan;
}

/** The units the plan spends: as expected, if 204 and 400 are free, and if Both bills twice. */
export function estimateUnits(plan) {
  const sum = (pick) => plan.reduce((total, planned) => total + pick(planned), 0);
  return {
    calls: plan.length,
    expected: sum((planned) => planned.units),
    ifErrorsAreFree: sum((planned) => (planned.errorProbe ? 0 : planned.units)),
    ifBothBillsTwice: sum((planned) => planned.unitsIfBothBillsTwice),
  };
}

/** The dry run's text: every planned call, its units, the checkpoints and the total. */
export function describePlan(plan, { date, pageHours }) {
  const estimate = estimateUnits(plan);
  const lines = [
    `AeroDataBox boards probe, dry run: no network call is made.`,
    `Date ${date}, page size ${String(pageHours)} hours, base ${BASE_URL}`,
    '',
  ];
  for (const planned of plan) {
    const target = planned.path ?? '(chosen at run time from the u2-departure answer)';
    lines.push(
      `${planned.item.padEnd(3)} ${planned.id.padEnd(20)} ${String(planned.units)} units  GET ${target}`,
    );
    lines.push(`    ${planned.purpose}`);
    if (planned.checkpoint !== null) {
      lines.push(`    then read the unit counter (${planned.checkpoint})`);
    }
  }
  lines.push(
    '',
    `Planned: ${String(estimate.calls)} calls, ${String(estimate.expected)} units expected ` +
      `(${String(estimate.ifErrorsAreFree)} if 204 and 400 are free, ` +
      `${String(estimate.ifBothBillsTwice)} if direction=Both bills both directions).`,
    'Counter readings: before the first billed call, then at each checkpoint above.',
  );
  return `${lines.join('\n')}\n`;
}

function fail(message) {
  process.stderr.write(`probe-adb-boards: ${message}\n`);
  process.exit(1);
}

export function readOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'dry-run': { type: 'boolean', default: false },
      date: { type: 'string' },
      'page-hours': { type: 'string', default: '24' },
      'empty-airport': { type: 'string', default: DEFAULT_EMPTY_AIRPORT },
      out: { type: 'string' },
      'no-prompt': { type: 'boolean', default: false },
      'pause-ms': { type: 'string', default: String(PAUSE_MS) },
    },
  });
  const date = values.date ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    fail(`--date must be YYYY-MM-DD, got "${date}"`);
  }
  const pageHours = Number(values['page-hours']);
  if (!Number.isInteger(pageHours) || pageHours < 1 || pageHours > 48) {
    fail(
      `--page-hours must be a whole number of hours from 1 to 48, got "${values['page-hours']}"`,
    );
  }
  const emptyAirport = values['empty-airport'].trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(emptyAirport)) {
    fail(`--empty-airport must be an ICAO code, got "${values['empty-airport']}"`);
  }
  const pauseMs = Number(values['pause-ms']);
  if (!Number.isInteger(pauseMs) || pauseMs < 0) {
    fail(`--pause-ms must be a whole number of milliseconds, got "${values['pause-ms']}"`);
  }
  return {
    dryRun: values['dry-run'],
    pauseMs,
    date,
    pageHours,
    emptyAirport,
    out: resolve(values.out ?? join(tmpdir(), `adb-board-probe-${date}.json`)),
    prompt: !values['no-prompt'],
  };
}

const QUOTA_HEADER = /quota|ratelimit|rate-limit|units|credits|remaining|usage/i;

/** The response headers that look like a quota or unit counter, lower-cased. */
export function quotaHeaders(headers) {
  const kept = {};
  for (const [name, value] of headers) {
    if (QUOTA_HEADER.test(name)) {
      kept[name.toLowerCase()] = value;
    }
  }
  return kept;
}

/**
 * One GET, timed and measured. The body is returned for the in-memory comparisons (U1, U7) and is
 * never written; a response that echoes the key stops the probe before anything is written.
 */
async function measure(path, apiKey) {
  const url = new URL(path, BASE_URL);
  const started = performance.now();
  let response;
  try {
    response = await fetch(url, { headers: { 'X-Api-Key': apiKey, Accept: 'application/json' } });
  } catch (error) {
    return { measurement: { status: null, error: String(error?.message ?? error) }, body: null };
  }
  const text = response.status === 204 ? '' : await response.text();
  const latencyMs = Math.round(performance.now() - started);
  if (text.includes(apiKey)) {
    fail(`the response to ${url.pathname} echoes the key; nothing was written`);
  }
  let body = null;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  return {
    measurement: {
      status: response.status,
      latencyMs,
      bytes: Buffer.byteLength(text),
      gzipBytes: text === '' ? 0 : gzipSync(text).length,
      departures: Array.isArray(body?.departures) ? body.departures.length : null,
      arrivals: Array.isArray(body?.arrivals) ? body.arrivals.length : null,
      quotaHeaders: quotaHeaders(response.headers),
    },
    body,
  };
}

/** A FIDS row's scheduled and revised local times at the home airport, `YYYY-MM-DDTHH:mm`. */
export function homeTimes(row) {
  const leg = row?.movement ?? row?.departure ?? null;
  const wall = (time) =>
    typeof time?.local === 'string' ? time.local.slice(0, 16).replace(' ', 'T') : null;
  return { scheduled: wall(leg?.scheduledTime), revised: wall(leg?.revisedTime) };
}

function wallMinutes(wall) {
  return Date.parse(`${wall}:00Z`) / 60_000;
}

function shiftWall(wall, minutes) {
  return new Date(Date.parse(`${wall}:00Z`) + minutes * 60_000).toISOString().slice(0, 16);
}

/** A departure revised at least 90 minutes after its schedule, for U1; null when there is none. */
export function delayedDeparture(body) {
  for (const row of Array.isArray(body?.departures) ? body.departures : []) {
    const { scheduled, revised } = homeTimes(row);
    if (
      scheduled !== null &&
      revised !== null &&
      wallMinutes(revised) - wallMinutes(scheduled) >= 90
    ) {
      return { number: String(row.number ?? ''), scheduled, revised };
    }
  }
  return null;
}

function hasDeparture(body, number) {
  const wanted = number.replace(/\s+/g, '');
  return (Array.isArray(body?.departures) ? body.departures : []).some(
    (row) => String(row.number ?? '').replace(/\s+/g, '') === wanted,
  );
}

/**
 * The departures scheduled at exactly `HH:mm` local in an answer and not revised later, by number
 * (a later revised time could keep one out of a window for U1's reason rather than U7's).
 */
function departuresAt(body, hhmm) {
  return (Array.isArray(body?.departures) ? body.departures : [])
    .filter((row) => {
      const { scheduled, revised } = homeTimes(row);
      return scheduled?.slice(11) === hhmm && (revised === null || revised <= scheduled);
    })
    .map((row) => String(row.number ?? '').replace(/\s+/g, ''));
}

/** The answers the comparisons need, held in memory for the run only. */
const KEPT_BODIES = new Set([
  'u2-departure',
  'u7-to-1159',
  'u7-to-1200',
  'u4-KATL-24h',
  'u4-KATL-pm',
  'u1-revised-window',
  'u1-scheduled-window',
]);

function pause(ms) {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

async function runPlan(options, apiKey) {
  const plan = planProbe(options);
  const readings = {};
  const prompts =
    options.prompt && process.stdin.isTTY
      ? createInterface({ input: process.stdin, output: process.stdout })
      : null;
  const read = async (name) => {
    if (prompts === null) {
      readings[name] = null;
      return;
    }
    const typed = await prompts.question(
      `[${name}] the API unit counter on the AeroDataBox dashboard (wait for it to update; Enter skips): `,
    );
    const value = Number(typed.replace(/[\s,]/g, ''));
    readings[name] = typed.trim() === '' || !Number.isFinite(value) ? null : value;
  };
  const calls = [];
  const bodies = new Map();
  let delayed;
  let readBefore = false;
  for (const planned of plan) {
    let path = planned.path;
    if (path === null) {
      delayed ??= delayedDeparture(bodies.get('u2-departure'));
      if (delayed === null) {
        calls.push({ id: planned.id, item: planned.item, skipped: 'no delayed departure found' });
        continue;
      }
      const around = planned.id === 'u1-revised-window' ? delayed.revised : delayed.scheduled;
      path = fids('KJFK', shiftWall(around, -15), shiftWall(around, 15), DEPARTURES_SHAPE);
    }
    if (!readBefore && planned.units > 0) {
      await read('before');
      readBefore = true;
    }
    process.stdout.write(`${planned.id}: GET ${path}\n`);
    const { measurement, body } = await measure(path, apiKey);
    calls.push({
      id: planned.id,
      item: planned.item,
      purpose: planned.purpose,
      path,
      ...measurement,
    });
    if (KEPT_BODIES.has(planned.id)) {
      bodies.set(planned.id, body);
    }
    if (planned.checkpoint !== null) {
      await read(planned.checkpoint);
    }
    await pause(options.pauseMs);
  }
  prompts?.close();
  return { calls, bodies, readings, delayed: delayed ?? null };
}

/** Units spent between two counter readings (a counter of units used or of units left). */
function spent(readings, from, to) {
  const a = readings[from];
  const b = readings[to];
  return a === null || a === undefined || b === null || b === undefined ? null : Math.abs(b - a);
}

/** What the run settles, item by item; null where a reading or an answer is missing. */
export function findingsOf({ calls, bodies, readings, delayed }) {
  const byId = new Map(calls.map((measured) => [measured.id, measured]));
  const status = (id) => byId.get(id)?.status ?? null;
  const size = (id) => {
    const measured = byId.get(id);
    return measured === undefined || measured.status === undefined
      ? null
      : {
          status: measured.status,
          latencyMs: measured.latencyMs ?? null,
          bytes: measured.bytes ?? null,
          gzipBytes: measured.gzipBytes ?? null,
          rows: (measured.departures ?? 0) + (measured.arrivals ?? 0),
          chunksOf1Mb: Math.max(1, Math.ceil((measured.gzipBytes ?? 0) / CHUNK_BYTES)),
          overValueLimit: (measured.gzipBytes ?? 0) > VALUE_LIMIT_BYTES,
        };
  };
  const twelve = [
    ...new Set([
      ...departuresAt(bodies.get('u4-KATL-24h'), '12:00'),
      ...departuresAt(bodies.get('u4-KATL-pm'), '12:00'),
    ]),
  ];
  const inTo1200 = twelve.filter((number) => hasDeparture(bodies.get('u7-to-1200'), number));
  return {
    U1:
      delayed === null
        ? { settled: false, reason: 'no departure revised 90 minutes or more in u2-departure' }
        : {
            settled: true,
            flight: delayed,
            inRevisedWindow: hasDeparture(bodies.get('u1-revised-window'), delayed.number),
            inScheduledWindow: hasDeparture(bodies.get('u1-scheduled-window'), delayed.number),
          },
    U2: {
      bothUnits: spent(readings, 'before', 'after-u2-both'),
      departureUnits: spent(readings, 'after-u2-both', 'after-u2-departure'),
    },
    U3: {
      withLegUnits: spent(readings, 'after-u2-departure', 'after-u3-withleg'),
      withLocationUnits: spent(readings, 'after-u3-withleg', 'after-u3-withlocation'),
    },
    U4: Object.fromEntries(
      HUBS.map((icao) => [
        icao,
        { am: size(`u4-${icao}-am`), pm: size(`u4-${icao}-pm`), h24: size(`u4-${icao}-24h`) },
      ]),
    ),
    U5: { status: status('u5-180-days'), departures: byId.get('u5-180-days')?.departures ?? null },
    U6: {
      emptyStatus: status('u6-empty'),
      emptyUnits: spent(readings, 'after-u3-withlocation', 'after-u6-empty'),
      tooWideStatus: status('u6-too-wide'),
      tooWideUnits: spent(readings, 'after-u6-empty', 'after-u6-too-wide'),
    },
    U7: {
      exactPageStatus: status('u7-exact-page'),
      departuresAt1200: twelve,
      at1200InTo1200: inTo1200,
      toLocalInclusive: twelve.length === 0 ? null : inTo1200.length > 0,
    },
  };
}

async function main(argv) {
  const options = readOptions(argv);
  const plan = planProbe(options);
  if (options.dryRun) {
    process.stdout.write(describePlan(plan, options));
    return;
  }
  const apiKey = process.env['AERODATABOX_API_KEY'];
  if (apiKey === undefined || apiKey.trim() === '') {
    fail(
      'AERODATABOX_API_KEY is not set; the probe calls the real gateway (use --dry-run to see the plan)',
    );
  }
  const estimate = estimateUnits(plan);
  process.stdout.write(
    `Spending about ${String(estimate.expected)} units (${String(estimate.ifErrorsAreFree)} to ${String(estimate.ifBothBillsTwice)}) on ${String(estimate.calls)} calls.\n`,
  );
  const run = await runPlan(options, apiKey);
  const findings = {
    probe: 'adb-board-probe',
    ranAt: new Date().toISOString(),
    date: options.date,
    pageHours: options.pageHours,
    emptyAirport: options.emptyAirport,
    estimate,
    counterReadings: run.readings,
    answers: findingsOf(run),
    calls: run.calls,
  };
  const text = `${JSON.stringify(findings, null, 2)}\n`;
  if (text.includes(apiKey)) {
    fail('refusing to write the findings: the key would be in them');
  }
  writeFileSync(options.out, text);
  process.stdout.write(`wrote ${options.out}\n${JSON.stringify(findings.answers, null, 2)}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
