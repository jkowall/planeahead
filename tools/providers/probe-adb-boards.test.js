/**
 * scripts/probe-adb-boards.mjs (increment 18, ruling B13): the AeroDataBox boards probe. Its dry
 * run prints the planned calls and their units with no key and no network call (every child here
 * runs with `fetch` replaced by a tripwire that exits 97); without a key it refuses before any
 * call; the plan covers R3 U1 to U7 at about 44 units, with the review round's two additions: one
 * call in the adapter's exact production query between two counter readings and a last reading
 * at the end (ruling R7), and the codeshare keys of a bucket days ahead (ruling R12). The
 * re-review's M4 and M5 added a reading after the last billed call before the production call,
 * the running total each reading should reach, a bill settled only at a figure one call can
 * bill, and the count of rows of unknown codeshare status. One run against a stubbed gateway
 * (never the real one) checks the findings file: booleans and counts only, no flight number, time
 * or path, never the key, and no redirect followed.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BOARD_SHAPE,
  PRODUCTION_CALL,
  codeshareKeys,
  counterQuestion,
  estimateUnits,
  findingsOf,
  planProbe,
} from '../../scripts/probe-adb-boards.mjs';

const repoRoot = join(import.meta.dirname, '..', '..');
const script = join(repoRoot, 'scripts', 'probe-adb-boards.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'probe-adb-boards-'));
const tripwire = join(scratch, 'no-network.mjs');
writeFileSync(
  tripwire,
  "globalThis.fetch = () => { process.stderr.write('NETWORK CALLED\\n'); process.exit(97); };\n",
);

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Runs the script with `preload` imported first and no AeroDataBox key unless `env` sets one. */
function run(args, { env = {}, preload = tripwire } = {}) {
  const childEnv = { ...process.env };
  delete childEnv.AERODATABOX_API_KEY;
  const result = spawnSync(
    process.execPath,
    ['--import', pathToFileURL(preload).href, script, ...args],
    { env: { ...childEnv, ...env }, encoding: 'utf8', input: '' },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('the dry run', () => {
  it('prints every planned call and its units, with no key and no network call', () => {
    const result = run(['--dry-run', '--date', '2026-10-02']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^AeroDataBox boards probe, dry run: no network call is made\./);
    for (const expected of [
      'GET health/services/airports/KATL/feeds',
      'flights/airports/Icao/KJFK/2026-10-02T06:00/2026-10-02T18:00?direction=Both&withLeg=false',
      '&withLocation=true',
      'flights/airports/Icao/EGPU/2026-10-02T02:00/2026-10-02T03:00',
      'flights/airports/Icao/KJFK/2026-10-02T00:00/2026-10-03T06:00',
      'flights/airports/Icao/KATL/2026-10-02T00:00/2026-10-03T00:00',
      'flights/airports/Icao/KJFK/2027-03-31T06:00/2027-03-31T18:00',
      'flights/airports/Icao/EGLL/2026-10-02T12:00/2026-10-02T23:59?direction=Both&withLeg=true',
      '(chosen at run time from the u2-departure answer)',
      `GET flights/airports/Icao/KATL/2026-10-02T00:00/2026-10-02T11:59?${BOARD_SHAPE}\n` +
        '    the 00:00 to 11:59 bucket at KATL, the production call: its bill alone is ADB_UNITS.fids\n' +
        '    read the unit counter before this call (before-production), running total 20 units (16 to 22)\n' +
        '    then read the unit counter (after-production), running total 22 units (18 to 26)\n',
      `B7  b7-days-ahead        2 units  GET flights/airports/Icao/KATL/2026-10-05T00:00/2026-10-05T11:59?${BOARD_SHAPE}`,
    ]) {
      expect(result.stdout).toContain(expected);
    }
    // Every prompt in the run's order, with the units the counter should have moved by then since
    // `before` (the re-review's M4): as planned, then 204 and 400 free to Both billed twice.
    expect(
      result.stdout.split('\n').filter((line) => line.includes('read the unit counter')),
    ).toEqual([
      '    read the unit counter before this call (before)',
      '    then read the unit counter (after-u2-both), running total 2 units (2 to 4)',
      '    then read the unit counter (after-u2-departure), running total 4 units (4 to 6)',
      '    then read the unit counter (after-u3-withleg), running total 6 units (6 to 8)',
      '    then read the unit counter (after-u3-withlocation), running total 8 units (8 to 10)',
      '    then read the unit counter (after-u6-empty), running total 10 units (8 to 12)',
      '    then read the unit counter (after-u6-too-wide), running total 12 units (8 to 14)',
      '    then read the unit counter (after-u5-180-days), running total 20 units (16 to 22)',
      '    read the unit counter before this call (before-production), running total 20 units (16 to 22)',
      '    then read the unit counter (after-production), running total 22 units (18 to 26)',
      'Last, read the unit counter (end), running total 44 units (40 to 66)',
    ]);
    expect(result.stdout).toContain(
      'Planned: 25 calls, 44 units expected (40 if 204 and 400 are free, 66 if direction=Both bills both directions).\n' +
        'Counter readings: before the first billed call (before), at each checkpoint above, and after the last call (end).\n' +
        'A running total counts the units spent since (before): as planned, then the range from 204 and 400 billing nothing to direction=Both billing both directions. ' +
        'At each prompt, type the counter once it has stopped moving; one still short of the range has not caught up.\n',
    );
  });

  it('calls nothing even with a key set', () => {
    const result = run(['--dry-run'], { env: { AERODATABOX_API_KEY: 'dummy-key-123' } });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain('dummy-key-123');
  });

  it('refuses to run for real without a key, before any call', () => {
    const result = run(['--no-prompt']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('AERODATABOX_API_KEY is not set');
    expect(result.stderr).not.toContain('NETWORK CALLED');
  });

  it.each([
    [['--dry-run', '--date', '2026-13-45'], '--date must be YYYY-MM-DD'],
    [['--dry-run', '--page-hours', '0'], '--page-hours must be a whole number'],
    [['--dry-run', '--empty-airport', 'XX'], '--empty-airport must be an ICAO code'],
  ])('refuses %j', (args, message) => {
    const result = run(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });
});

describe('the plan', () => {
  it('covers R3 U1 to U7 and B7 at about 44 units, one FIDS call at a time', () => {
    const plan = planProbe({ date: '2026-10-02' });
    expect(new Set(plan.map((planned) => planned.item))).toEqual(
      new Set(['B6', 'B7', 'U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7']),
    );
    expect(estimateUnits(plan)).toEqual({
      calls: 25,
      expected: 44,
      ifErrorsAreFree: 40,
      ifBothBillsTwice: 66,
    });
  });

  it("bills one call in the adapter's exact production query between two readings (R7)", () => {
    // The adapter's `FIDS_QUERY`, read from its source: the probe must bill what production sends.
    const adapter = readFileSync(
      join(repoRoot, 'apps', 'api', 'src', 'providers', 'aerodatabox.adapter.ts'),
      'utf8',
    );
    const block = /const FIDS_QUERY = new URLSearchParams\(\{([^}]*)\}\)\.toString\(\);/.exec(
      adapter,
    )?.[1];
    expect(block).toBeDefined();
    const pairs = [...(block ?? '').matchAll(/(\w+): '([^']*)'/g)].map(([, key, value]) => [
      key,
      value,
    ]);
    expect(pairs).toHaveLength(6);
    expect(BOARD_SHAPE).toBe(new URLSearchParams(pairs).toString());

    const plan = planProbe({ date: '2026-10-02' });
    const production = plan.find((planned) => planned.id === PRODUCTION_CALL);
    expect(production).toMatchObject({
      path: `flights/airports/Icao/KATL/2026-10-02T00:00/2026-10-02T11:59?${BOARD_SHAPE}`,
      units: 2,
      checkpointBefore: 'before-production',
      checkpoint: 'after-production',
    });
    // No other call reads the counter between the two, so their difference is this call alone.
    const readings = plan.flatMap((planned) =>
      [planned.checkpointBefore, planned.checkpoint].filter((name) => name !== null),
    );
    expect(readings.filter((name) => name.endsWith('-production'))).toEqual([
      'before-production',
      'after-production',
    ]);
  });

  it('reads the counter after the last billed call before the production call (M4)', () => {
    // So `before-production` follows a counter that has settled after every earlier call, not
    // one still taking in the calls since the last reading (the re-review's M4).
    const plan = planProbe({ date: '2026-10-02' });
    const production = plan.findIndex((planned) => planned.id === PRODUCTION_CALL);
    const billedBefore = plan.slice(0, production).filter((planned) => planned.units > 0);
    expect(billedBefore.at(-1)).toMatchObject({
      id: 'u5-180-days',
      checkpoint: 'after-u5-180-days',
    });
    // And every reading asks for a counter that has stopped moving.
    expect(counterQuestion('before-production')).toBe(
      '[before-production] the API unit counter on the AeroDataBox dashboard, once it has stopped moving (Enter skips): ',
    );
  });

  it('reads codeshare keys in the production query days ahead (R12)', () => {
    const ahead = planProbe({ date: '2026-12-30' }).find(
      (planned) => planned.id === 'b7-days-ahead',
    );
    expect(ahead).toMatchObject({
      item: 'B7',
      path: `flights/airports/Icao/KATL/2027-01-02T00:00/2027-01-02T11:59?${BOARD_SHAPE}`,
      units: 2,
    });
  });

  it('follows a smaller page: no 24-hour windows, and "too wide" is page plus 6 hours', () => {
    const plan = planProbe({ date: '2026-10-02', pageHours: 12 });
    expect(plan.some((planned) => planned.id.endsWith('-24h'))).toBe(false);
    expect(plan.find((planned) => planned.id === 'u6-too-wide')?.path).toContain(
      '/2026-10-02T00:00/2026-10-02T18:00?',
    );
  });
});

describe('the findings', () => {
  const row = (number, scheduled, revised) => ({
    number,
    movement: {
      scheduledTime: { local: `2026-10-02 ${scheduled}-04:00` },
      ...(revised === undefined ? {} : { revisedTime: { local: `2026-10-02 ${revised}-04:00` } }),
    },
  });

  it('reads units from the counter readings and settles U1 and U7 from the answers', () => {
    const late = { number: 'AA 1', scheduled: '2026-10-02T10:00', revised: '2026-10-02T12:00' };
    const findings = findingsOf({
      calls: [{ id: 'u6-empty', status: 204 }],
      bodies: new Map([
        ['u1-revised-window', { departures: [row('AA 1', '10:00', '12:00')] }],
        ['u1-scheduled-window', { departures: [] }],
        ['u4-KATL-24h', { departures: [row('DL 100', '12:00'), row('DL 7', '12:00', '12:40')] }],
        ['u7-to-1200', { departures: [row('DL 100', '12:00')] }],
      ]),
      readings: {
        before: 1000,
        'after-u2-both': 998,
        'after-u2-departure': 996,
        'before-production': 970,
        'after-production': 966,
        end: 954,
      },
      delayed: late,
    });
    // Booleans only: neither the flight's number nor its times (R7).
    expect(findings.U1).toEqual({ settled: true, inRevisedWindow: true, inScheduledWindow: false });
    expect(findings.U2).toEqual({ bothUnits: 2, departureUnits: 2 });
    expect(findings.U3).toEqual({ withLegUnits: null, withLocationUnits: null });
    expect(findings.U6.emptyStatus).toBe(204);
    // DL 7 was revised past 12:00, so it says nothing about the bound; counts, not numbers.
    expect(findings.U7).toMatchObject({
      departuresAt1200: 1,
      at1200InTo1200: 1,
      toLocalInclusive: true,
    });
    // One production call billed 4 units here, a figure one call can bill: `ADB_UNITS.fids` would
    // become 4.
    expect(findings.bill).toEqual({
      productionCallUnits: 4,
      productionCallSettled: true,
      impliedByU2AndU3: null,
      runUnits: 46,
    });
    expect(JSON.stringify(findings)).not.toMatch(/AA ?1\b|DL ?100|DL ?7\b|\d{2}:\d{2}/);
  });

  it('settles the production bill only at 2, 4 or what U2 and U3 imply (M4)', () => {
    const bill = (readings) =>
      findingsOf({ calls: [], bodies: new Map(), readings, delayed: null }).bill;
    // Both 2 units, a single direction 2, with `withLeg` 3: U2 and U3 imply 3 for the production
    // query (Both plus withLeg's surcharge of 1).
    const u2u3 = {
      before: 1000,
      'after-u2-both': 998,
      'after-u2-departure': 996,
      'after-u3-withleg': 993,
    };
    const production = (units) =>
      bill({ ...u2u3, 'before-production': 950, 'after-production': 950 - units });
    expect(production(3)).toMatchObject({
      productionCallUnits: 3,
      productionCallSettled: true,
      impliedByU2AndU3: 3,
    });
    expect(production(2).productionCallSettled).toBe(true);
    expect(production(4).productionCallSettled).toBe(true);
    // A straggler of the calls before it, folded in by a counter that lagged: not a figure.
    expect(production(6)).toMatchObject({ productionCallUnits: 6, productionCallSettled: false });
    expect(production(5).productionCallSettled).toBe(false);
    // Without U2 and U3 only 2 and 4 settle it.
    expect(bill({ 'before-production': 950, 'after-production': 947 })).toMatchObject({
      productionCallUnits: 3,
      productionCallSettled: false,
      impliedByU2AndU3: null,
    });
    // A counter that never moved settles nothing, even where U2 and U3 imply 0 too.
    const still = Object.fromEntries(
      [
        'before',
        'after-u2-both',
        'after-u2-departure',
        'after-u3-withleg',
        'before-production',
        'after-production',
      ].map((name) => [name, 1000]),
    );
    expect(bill(still)).toMatchObject({
      productionCallUnits: 0,
      productionCallSettled: false,
      impliedByU2AndU3: 0,
    });
    // A skipped reading leaves no figure, and nothing settled.
    expect(bill({ ...u2u3, 'before-production': null, 'after-production': 947 })).toMatchObject({
      productionCallUnits: null,
      productionCallSettled: false,
    });
  });

  it('counts the codeshare rows that carry a callsign or a registration (R12)', () => {
    const flight = (codeshareStatus, callSign, reg) => ({
      number: 'XX 1',
      codeshareStatus,
      ...(callSign === undefined ? {} : { callSign }),
      ...(reg === undefined ? {} : { aircraft: { reg } }),
    });
    const keys = codeshareKeys({
      departures: [
        flight('IsOperator', 'AAL100', 'N101NN'),
        flight('IsCodeshared', 'AAL100', undefined),
        flight('IsCodeshared', ' ', ' '),
        flight('IsCodeshared'),
        // A status outside the enum reads as `Unknown` (M5); a row with none never parses.
        flight('IsWetLeased', undefined, 'N202NN'),
        { number: 'XX 2' },
      ],
      arrivals: [flight('IsCodeshared', undefined, 'G-EUPT'), flight('Unknown', 'BAW1')],
    });
    expect(keys).toEqual({
      rows: 8,
      operator: { rows: 1, withCallSign: 1, withRegistration: 1, withNeither: 0 },
      codeshared: { rows: 4, withCallSign: 1, withRegistration: 1, withNeither: 2 },
      unknownStatus: { rows: 2, withCallSign: 1, withRegistration: 1, withNeither: 0 },
      codesharedCarryCallSign: true,
      codesharedCarryRegistration: true,
    });
    expect(codeshareKeys({ departures: [flight('IsCodeshared')] })).toMatchObject({
      codesharedCarryCallSign: false,
      codesharedCarryRegistration: false,
    });
    expect(codeshareKeys({ departures: [] })).toMatchObject({ codesharedCarryCallSign: null });
    expect(codeshareKeys(null)).toBeNull();
    expect(JSON.stringify(keys)).not.toMatch(/AAL100|N101NN|N202NN|G-EUPT|BAW1|XX ?[12]/);
  });
});

describe('a run against a stubbed gateway', () => {
  /**
   * Answers like the gateway would: free coverage, a 204, a 400 and FIDS rows with a codeshare
   * (keyed by callsign and registration on the run's date, keyless days ahead) and an arrival of
   * unknown codeshare status; never the key. A fetch that would follow a redirect exits 96
   * instead (R7: the key must not follow one).
   */
  const stub = join(scratch, 'stub-gateway.mjs');
  writeFileSync(
    stub,
    `const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const leg = (scheduled, revised) => ({
  scheduledTime: { local: '2026-10-02 ' + scheduled + '-04:00' },
  ...(revised === undefined ? {} : { revisedTime: { local: '2026-10-02 ' + revised + '-04:00' } }),
});
globalThis.fetch = async (url, init) => {
  const href = String(url);
  if (init?.redirect !== 'error') {
    process.stderr.write('A REDIRECT WOULD BE FOLLOWED WITH THE KEY\\n');
    process.exit(96);
  }
  if (new Headers(init?.headers).get('X-Api-Key') !== 'dummy-key-123') return json(401, {});
  if (href.includes('/health/')) return json(200, { flightSchedulesFeed: { status: 'OK' } });
  if (href.includes('/EGPU/')) return new Response(null, { status: 204 });
  if (href.includes('/2026-10-03T06:00')) return json(400, { message: 'range too wide' });
  const keys = /\\/(2026-10-05|2027-03-31)T/.test(href) ? {} : { callSign: 'DAL100', aircraft: { reg: 'N100DN' } };
  return json(
    200,
    {
      departures: [
        { number: 'DL 100', codeshareStatus: 'IsOperator', ...keys, movement: leg('12:00') },
        { number: 'KL 6100', codeshareStatus: 'IsCodeshared', ...keys, movement: leg('12:00') },
        { number: 'AA 1', codeshareStatus: 'IsOperator', movement: leg('09:00', '11:00') },
      ],
      arrivals: [
        { number: 'BA 117', codeshareStatus: 'IsOperator', movement: leg('13:00') },
        { number: 'VS 3', codeshareStatus: 'Unknown', movement: leg('13:00') },
      ],
    },
    { 'x-ratelimit-remaining': '9', 'x-request-id': 'r-1' },
  );
};
`,
  );

  it('writes booleans and counts only, never the key, a flight, a time or a path', () => {
    const out = join(scratch, 'findings.json');
    const result = run(['--date', '2026-10-02', '--out', out, '--no-prompt', '--pause-ms', '0'], {
      env: { AERODATABOX_API_KEY: 'dummy-key-123' },
      preload: stub,
    });
    // An empty stderr and exit 0 also mean no fetch would have followed a redirect (the stub).
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const text = readFileSync(out, 'utf8');
    expect(text).not.toContain('dummy-key-123');
    // No body, no flight number, callsign or registration, no path (U1's are cut around a flight).
    expect(text).not.toContain('movement');
    expect(text).not.toContain('scheduledTime');
    expect(text).not.toMatch(
      /DL ?100|KL ?6100|AA ?1\b|BA ?117|VS ?3\b|DAL100|N100DN|flights\/airports/,
    );
    const { ranAt, ...findings } = JSON.parse(text);
    // The run's own timestamp is the only clock time in the file.
    expect(ranAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(JSON.stringify(findings)).not.toMatch(/\d{2}:\d{2}/);
    expect(findings.calls).toHaveLength(25);
    expect(Object.keys(findings.calls[3]).sort()).toEqual([
      'arrivals',
      'bytes',
      'departures',
      'gzipBytes',
      'id',
      'item',
      'latencyMs',
      'quotaHeaders',
      'status',
    ]);
    // Every reading is taken, in the dry run's order: U5's (M4), the production call's two, then
    // the last one.
    expect(Object.keys(findings.counterReadings)).toEqual([
      'before',
      'after-u2-both',
      'after-u2-departure',
      'after-u3-withleg',
      'after-u3-withlocation',
      'after-u6-empty',
      'after-u6-too-wide',
      'after-u5-180-days',
      'before-production',
      'after-production',
      'end',
    ]);
    expect(Object.values(findings.counterReadings).every((value) => value === null)).toBe(true);
    // No reading, no figure: the bill is not settled.
    expect(findings.answers.bill).toEqual({
      productionCallUnits: null,
      productionCallSettled: false,
      impliedByU2AndU3: null,
      runUnits: null,
    });
    expect(findings.answers.U6).toMatchObject({ emptyStatus: 204, tooWideStatus: 400 });
    expect(findings.answers.U1).toMatchObject({ settled: true, inRevisedWindow: true });
    expect(findings.answers.U4.EGLL.am).toMatchObject({ status: 200, rows: 5, chunksOf1Mb: 1 });
    expect(findings.answers.U7).toMatchObject({ departuresAt1200: 2, toLocalInclusive: true });
    expect(findings.answers.codeshares.sameDay).toMatchObject({
      codeshared: { rows: 1, withCallSign: 1, withRegistration: 1, withNeither: 0 },
      unknownStatus: { rows: 1, withCallSign: 0, withRegistration: 0, withNeither: 1 },
      codesharedCarryCallSign: true,
    });
    expect(findings.answers.codeshares.daysAhead).toMatchObject({
      codeshared: { rows: 1, withCallSign: 0, withRegistration: 0, withNeither: 1 },
      codesharedCarryCallSign: false,
      codesharedCarryRegistration: false,
    });
    expect(findings.answers.codeshares.days180Ahead).toMatchObject({
      codesharedCarryRegistration: false,
    });
    const measured = findings.calls.find((entry) => entry.id === 'u2-both');
    expect(measured.quotaHeaders).toEqual({ 'x-ratelimit-remaining': '9' });
  });
});
