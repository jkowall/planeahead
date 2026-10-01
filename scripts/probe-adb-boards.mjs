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
 * It SPENDS REAL UNITS (about 44: 2 per FIDS call, the coverage checks are free; the dry run
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
 *   U7  whether a window of exactly the page size is accepted, and whether `toLocal` is inclusive;
 *   the bill of ONE production call (review ruling R7): `u4-KATL-am` is the adapter's exact query
 *       on a 12-hour bucket, read between two counter readings, so `ADB_UNITS.fids` can be set
 *       to what AeroDataBox charges for it once that figure is settled (2, 4, or what U2 and U3
 *       imply; the re-review's M4); a last reading gives the whole run's bill;
 *   B7  whether codeshare rows days ahead carry a callsign or a registration, the keys the board
 *       groups codeshares by (review ruling R12; a row with neither joins the only row of its
 *       direction, minute and counterpart that is not a codeshare, when that row is `IsOperator`),
 *       and how many rows are of unknown status (the re-review's M5).
 *
 * Billing (U2, U3, U6, the production call) is read from the account's unit counter. The direct
 * API has no endpoint for it (only the webhook credit balance), so at each checkpoint the script
 * asks for the counter as the AeroDataBox dashboard shows it once it has stopped moving (Enter
 * skips; `--no-prompt` skips all; the dry run prints the running total each reading should
 * reach), and it records every response header that looks like a quota counter in case the
 * gateway sends one.
 *
 * What it keeps: booleans and counts only (status, latency, sizes, row counts, the counter
 * readings, quota-like headers), never a flight number, a time or a path (U1's windows are cut
 * around a real flight's times; the dry run reprints every other path from the recorded date).
 * No response body is written, the key is sent only as the X-Api-Key header, a redirect is
 * refused rather than followed with it, and the findings are checked for the key before they are
 * written.
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

/**
 * The production fetch shape (ruling B1), byte for byte the adapter's `FIDS_QUERY`
 * (apps/api/src/providers/aerodatabox.adapter.ts; a test compares the two), on which U4 measures
 * sizes and the production call its bill.
 */
export const BOARD_SHAPE =
  'direction=Both&withLeg=true&withCancelled=true&withCodeshared=true&withCargo=false&withPrivate=false';
/** The one production call read between two counter readings (R7): KATL's 00:00 to 11:59. */
export const PRODUCTION_CALL = 'u4-KATL-am';
/** How far ahead B7 reads a bucket for codeshare keys (R12): the board's own 72-hour reach. */
export const CODESHARE_DAYS_AHEAD = 3;
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
    checkpointBefore: options.checkpointBefore ?? null,
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
      // Its own reading (the re-review's M4): the four calls since `after-u6-too-wide` are read
      // here, so `before-production` follows a counter that has settled, not one still moving.
      { checkpoint: 'after-u5-180-days' },
    ),
  );
  for (const icao of HUBS) {
    const production = `u4-${icao}-am` === PRODUCTION_CALL;
    plan.push(
      call(
        `u4-${icao}-am`,
        'U4',
        production
          ? `the 00:00 to 11:59 bucket at ${icao}, the production call: its bill alone is ADB_UNITS.fids`
          : `the 00:00 to 11:59 bucket at ${icao}, production shape`,
        fids(icao, day(0), wallClock(date, 719), BOARD_SHAPE),
        FIDS_UNITS,
        production
          ? { both: true, checkpointBefore: 'before-production', checkpoint: 'after-production' }
          : { both: true },
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
  const ahead = addDays(date, CODESHARE_DAYS_AHEAD);
  plan.push(
    call(
      'b7-days-ahead',
      'B7',
      `the 00:00 to 11:59 bucket at KATL on ${ahead}, production shape: do codeshare rows carry a callsign or a registration`,
      fids('KATL', wallClock(ahead, 0), wallClock(ahead, 719), BOARD_SHAPE),
      FIDS_UNITS,
      { both: true },
    ),
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

/** What the calls made so far spend: as planned, then from errors free to Both billed twice. */
function runningTotal(made) {
  const sofar = estimateUnits(made);
  return `running total ${String(sofar.expected)} units (${String(sofar.ifErrorsAreFree)} to ${String(sofar.ifBothBillsTwice)})`;
}

/**
 * The dry run's text: every planned call and its units, each counter reading in the order the run
 * asks for it with its running total, the units the counter should have moved by since `before`
 * (the re-review's M4: a counter short of it has not caught up), and the total.
 */
export function describePlan(plan, { date, pageHours }) {
  const estimate = estimateUnits(plan);
  const lines = [
    `AeroDataBox boards probe, dry run: no network call is made.`,
    `Date ${date}, page size ${String(pageHours)} hours, base ${BASE_URL}`,
    '',
  ];
  const made = [];
  for (const planned of plan) {
    const target = planned.path ?? '(chosen at run time from the u2-departure answer)';
    lines.push(
      `${planned.item.padEnd(3)} ${planned.id.padEnd(20)} ${String(planned.units)} units  GET ${target}`,
    );
    lines.push(`    ${planned.purpose}`);
    // As the run reads them: `before` ahead of the first billed call, then the checkpoints.
    if (planned.units > 0 && !made.some((earlier) => earlier.units > 0)) {
      lines.push('    read the unit counter before this call (before)');
    }
    if (planned.checkpointBefore !== null) {
      lines.push(
        `    read the unit counter before this call (${planned.checkpointBefore}), ${runningTotal(made)}`,
      );
    }
    made.push(planned);
    if (planned.checkpoint !== null) {
      lines.push(`    then read the unit counter (${planned.checkpoint}), ${runningTotal(made)}`);
    }
  }
  lines.push(
    `Last, read the unit counter (end), ${runningTotal(made)}`,
    '',
    `Planned: ${String(estimate.calls)} calls, ${String(estimate.expected)} units expected ` +
      `(${String(estimate.ifErrorsAreFree)} if 204 and 400 are free, ` +
      `${String(estimate.ifBothBillsTwice)} if direction=Both bills both directions).`,
    'Counter readings: before the first billed call (before), at each checkpoint above, and ' +
      'after the last call (end).',
    'A running total counts the units spent since (before): as planned, then the range from 204 ' +
      'and 400 billing nothing to direction=Both billing both directions. At each prompt, type ' +
      'the counter once it has stopped moving; one still short of the range has not caught up.',
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
 * One GET, timed and measured. The body is returned for the in-memory comparisons (U1, U7, B7)
 * and is never written; a response that echoes the key stops the probe before anything is
 * written. A redirect is an error, not followed: following one would send the key to wherever
 * it points (review A's nit), and a FIDS answer is never a redirect.
 */
async function measure(path, apiKey) {
  const url = new URL(path, BASE_URL);
  const started = performance.now();
  let response;
  try {
    response = await fetch(url, {
      headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
      redirect: 'error',
    });
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
  PRODUCTION_CALL,
  'b7-days-ahead',
  'u5-180-days',
]);

function pause(ms) {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

/**
 * The question at a counter reading. Once it has stopped moving (the re-review's M4): a counter
 * typed while it still takes in earlier calls folds their units into the next difference, the
 * production call's included.
 */
export function counterQuestion(name) {
  return `[${name}] the API unit counter on the AeroDataBox dashboard, once it has stopped moving (Enter skips): `;
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
    const typed = await prompts.question(counterQuestion(name));
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
    if (planned.checkpointBefore !== null) {
      await read(planned.checkpointBefore);
    }
    // The path goes to the terminal only: U1's windows are cut around a real flight's times.
    process.stdout.write(`${planned.id}: GET ${path}\n`);
    const { measurement, body } = await measure(path, apiKey);
    calls.push({ id: planned.id, item: planned.item, ...measurement });
    if (KEPT_BODIES.has(planned.id)) {
      bodies.set(planned.id, body);
    }
    if (planned.checkpoint !== null) {
      await read(planned.checkpoint);
    }
    await pause(options.pauseMs);
  }
  await read('end');
  prompts?.close();
  return { calls, bodies, readings, delayed: delayed ?? null };
}

/** Units spent between two counter readings (a counter of units used or of units left). */
function spent(readings, from, to) {
  const a = readings[from];
  const b = readings[to];
  return a === null || a === undefined || b === null || b === undefined ? null : Math.abs(b - a);
}

/**
 * B7 (review ruling R12): how many of an answer's codeshare rows carry the keys the board groups
 * by, a callsign or a registration, and how many operator rows and rows of unknown status do.
 * Counts only; null when the call was not made or answered no JSON.
 */
export function codeshareKeys(body) {
  if (body === null || body === undefined) {
    return null;
  }
  const rows = [body.departures, body.arrivals].flatMap((side) =>
    Array.isArray(side) ? side : [],
  );
  const filled = (value) => typeof value === 'string' && value.trim() !== '';
  const count = (matches) => {
    const kept = rows.filter((row) => matches(row?.codeshareStatus));
    const callSign = kept.filter((row) => filled(row.callSign));
    const registration = kept.filter((row) => filled(row.aircraft?.reg));
    const neither = kept.filter((row) => !filled(row.callSign) && !filled(row.aircraft?.reg));
    return {
      rows: kept.length,
      withCallSign: callSign.length,
      withRegistration: registration.length,
      withNeither: neither.length,
    };
  };
  const codeshared = count((status) => status === 'IsCodeshared');
  const any = (n) => (codeshared.rows === 0 ? null : n > 0);
  return {
    rows: rows.length,
    operator: count((status) => status === 'IsOperator'),
    codeshared,
    // The rows the board reads as `Unknown` (that status or any other string outside the enum):
    // one in a keyless codeshare's slot is a second candidate operator (the re-review's M5).
    unknownStatus: count(
      (status) =>
        typeof status === 'string' && status !== 'IsOperator' && status !== 'IsCodeshared',
    ),
    codesharedCarryCallSign: any(codeshared.withCallSign),
    codesharedCarryRegistration: any(codeshared.withRegistration),
  };
}

/**
 * What the run settles, item by item; null where a reading or an answer is missing. Booleans and
 * counts only (review ruling R7): no flight number, time or path reaches the findings file.
 */
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
  const u2 = {
    bothUnits: spent(readings, 'before', 'after-u2-both'),
    departureUnits: spent(readings, 'after-u2-both', 'after-u2-departure'),
  };
  const u3 = {
    withLegUnits: spent(readings, 'after-u2-departure', 'after-u3-withleg'),
    withLocationUnits: spent(readings, 'after-u3-withleg', 'after-u3-withlocation'),
  };
  // What U2 and U3 say the production query bills: `direction=Both`, plus what `withLeg` adds to
  // the same single-direction call.
  const implied =
    u2.bothUnits === null || u2.departureUnits === null || u3.withLegUnits === null
      ? null
      : u2.bothUnits + u3.withLegUnits - u2.departureUnits;
  const production = spent(readings, 'before-production', 'after-production');
  return {
    U1:
      delayed === null
        ? { settled: false, reason: 'no departure revised 90 minutes or more in u2-departure' }
        : {
            settled: true,
            inRevisedWindow: hasDeparture(bodies.get('u1-revised-window'), delayed.number),
            inScheduledWindow: hasDeparture(bodies.get('u1-scheduled-window'), delayed.number),
          },
    U2: u2,
    U3: u3,
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
      departuresAt1200: twelve.length,
      at1200InTo1200: inTo1200.length,
      toLocalInclusive: twelve.length === 0 ? null : inTo1200.length > 0,
    },
    // R7: what one production call bills, which `ADB_UNITS.fids` (packages/shared) must equal,
    // and the whole run, first reading to last, against the plan's estimate. Settled only at a
    // figure one call can bill (the re-review's M4): one Tier 2 call, `direction=Both` billed
    // twice, or what U2 and U3 imply. Anything else, or no reading, is no figure to set
    // `ADB_UNITS.fids` from: a counter that lagged folds another call's units into it.
    bill: {
      productionCallUnits: production,
      productionCallSettled:
        production === FIDS_UNITS ||
        production === 2 * FIDS_UNITS ||
        (implied !== null && implied > 0 && production === implied),
      impliedByU2AndU3: implied,
      runUnits: spent(readings, 'before', 'end'),
    },
    // R12: the same day's production call, the bucket days ahead, and the date 180 days out.
    codeshares: {
      sameDay: codeshareKeys(bodies.get(PRODUCTION_CALL)),
      daysAhead: codeshareKeys(bodies.get('b7-days-ahead')),
      days180Ahead: codeshareKeys(bodies.get('u5-180-days')),
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
