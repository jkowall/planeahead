/**
 * Renders the refresh-cadence tables from `src/cadence.ts` into `docs/architecture.md`
 * between `<!-- cadence:start -->` and `<!-- cadence:end -->`. Run with
 * `pnpm --filter @planeahead/shared gen:cadence-table`. Idempotent: a second run is a no-op.
 * `test/cadence-table.test.ts` renders the same block in memory and fails when the committed
 * document differs, so the doc cannot drift from the code.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  A1_EXPECTED_POLLS,
  A2_EXPECTED_ALERTS,
  A2_EXPECTED_PE,
  A2_EXPECTED_POLLS,
  A2_HARD_CAP_PE,
  A2_SOFT_CAP_PE,
  ASSUMED_ALERTS_PER_FLIGHT,
  B_EXPECTED_POLLS,
  CADENCES,
  DEFAULT_CADENCE_PARAMS,
  LITERAL_EXPECTED_POLLS,
  SLO_EVENTS,
  SLO_TABLE,
  SLO_WINDOWS,
  TIER_SLO_WINDOWS,
  expectedCalls,
  isIntervalWindow,
  strictestPollSlo,
  type CadenceDefinition,
  type CadenceEdge,
  type CadenceTier,
  type CadenceWindow,
  type ExpectedCalls,
  type SloEvent,
  type SloWindow,
} from '../src/cadence';

export const CADENCE_START_MARKER = '<!-- cadence:start -->';
export const CADENCE_END_MARKER = '<!-- cadence:end -->';

export const ARCHITECTURE_DOC_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'docs',
  'architecture.md',
);

const ARCHITECTURE_STUB = `# Architecture

Phase 0 architecture notes. Increment 12 completes this document; until then it carries the
generated refresh-cadence tables that the FlightTracker lifecycle test and the cost model import
from \`@planeahead/shared\`.

## Refresh cadence

${CADENCE_START_MARKER}
${CADENCE_END_MARKER}
`;

const BLOCK_MINUTES = 180;
const LEAD_TIMES_DAYS = [3, 14, 30] as const;

const TIER_LABELS: Record<CadenceTier, string> = {
  pre48h_far: 'Beyond 14 d',
  pre48h_near: '14 d to 48 h',
  hourly: 'Hourly window',
  pre_boarding: 'Pre-boarding window',
  in_flight: 'In flight',
  post_arrival: 'Post-arrival tail',
};

const SLO_WINDOW_LABELS: Record<SloWindow, string> = {
  beyond_7d: '> 7 d',
  '7d_to_48h': '7 d to 48 h',
  '48h_to_6h': '48 h to 6 h',
  '6h_to_3h': '6 h to 3 h',
  '3h_to_arrival': '3 h to arrival',
  post_arrival: 'Post-arrival',
};

const SLO_EVENT_LABELS: Record<SloEvent, string> = {
  schedule_change: 'Schedule change / cancellation',
  gate_change: 'Gate change',
  eta_change: 'ETA / delay change',
  oooi: 'OOOI',
};

function formatMinutes(minutes: number): string {
  if (minutes % 1_440 === 0) {
    const d = minutes / 1_440;
    return d === 1 ? '1 d' : `${String(d)} d`;
  }
  if (minutes % 60 === 0) {
    return `${String(minutes / 60)} h`;
  }
  return `${String(minutes)} min`;
}

function formatInterval(minutes: number): string {
  if (minutes % 1_440 === 0) {
    const d = minutes / 1_440;
    return d === 1 ? 'daily' : `every ${String(d)} d`;
  }
  return `${formatMinutes(minutes)} interval`;
}

function formatEdge(edge: CadenceEdge): string {
  if (typeof edge === 'number') {
    if (edge === Number.POSITIVE_INFINITY) {
      return 'creation';
    }
    // Days only from 3 d up, so the 48 h boundary reads as the plan writes it.
    const text =
      edge >= 3 * 1_440
        ? formatMinutes(edge)
        : edge % 60 === 0
          ? `${String(edge / 60)} h`
          : `${String(edge)} min`;
    return `T-${text.replace(' ', '')}`;
  }
  switch (edge) {
    case 'boarding':
      return `T-${String(DEFAULT_CADENCE_PARAMS.boardingMinutesBefore)}min`;
    case 'arrival':
      return 'in';
    case 'stop':
      return `in+${String(DEFAULT_CADENCE_PARAMS.postArrivalStopMinutes)}min`;
  }
}

function describeWindow(window: CadenceWindow, polls: number): string {
  const range = `${formatEdge(window.from)} to ${formatEdge(window.to)}`;
  if (isIntervalWindow(window)) {
    const final = window.finalPoll === true ? ' + final' : '';
    return `${formatInterval(window.intervalMinutes)}${final}, ${range}: ${String(polls)}`;
  }
  return `fixed slots, ${range}: ${String(polls)}`;
}

function usd(micros: number): string {
  const dollars = micros / 1_000_000;
  const text = dollars.toFixed(5).replace(/0+$/, '').replace(/\.$/, '.0');
  return `$${text.length - text.indexOf('.') < 3 ? dollars.toFixed(2) : text}`;
}

function pe(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '');
}

/** Column-aligned Markdown table in the shape Prettier prints. */
export function markdownTable(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const widths = header.map((cell, i) =>
    Math.max(3, cell.length, ...rows.map((row) => (row[i] ?? '').length)),
  );
  const line = (cells: readonly string[]): string =>
    `| ${widths.map((width, i) => (cells[i] ?? '').padEnd(width)).join(' | ')} |`;
  const separator = `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`;
  return [line(header), separator, ...rows.map((row) => line(row))].join('\n');
}

function windowsTable(results: Map<CadenceDefinition, ExpectedCalls>): string {
  const header = ['Window', ...CADENCES.map((c) => c.label)];
  const tiers: CadenceTier[] = ['hourly', 'pre_boarding', 'in_flight', 'post_arrival'];
  const rows: string[][] = tiers.map((tier) => [
    TIER_LABELS[tier],
    ...CADENCES.map((cadence) => {
      const window = cadence.windows.find((w) => w.tier === tier);
      const count = results.get(cadence)?.byWindow.find((w) => w.tier === tier)?.polls ?? 0;
      return window === undefined ? 'n/a' : describeWindow(window, count);
    }),
  ]);
  const totals = (label: string, pick: (r: ExpectedCalls) => string): string[] => [
    label,
    ...CADENCES.map((cadence) => {
      const r = results.get(cadence);
      return r === undefined ? 'n/a' : pick(r);
    }),
  ];
  rows.push(
    totals('AeroAPI polls inside 48 h', (r) => String(r.polls)),
    totals('AeroAPI alert deliveries (assumed)', (r) => String(r.alerts)),
    totals('AeroDataBox alert items (assumed)', (r) => String(r.adbAlertItems)),
    totals('Poll-equivalents inside 48 h', (r) => pe(r.pollEquivalents)),
    totals('List cost inside 48 h', (r) => usd(r.listCostUsdMicros)),
  );
  return markdownTable(header, rows);
}

function leadTimeTable(): string {
  const header = [
    'Lead time',
    'ADB status calls',
    'ADB units',
    'ADB cost (Growth)',
    ...CADENCES.map((c) => `${c.id} list cost (PE)`),
  ];
  const rows = LEAD_TIMES_DAYS.map((leadTimeDays) => {
    const perCadence = CADENCES.map((cadence) =>
      expectedCalls(cadence, { leadTimeDays, blockMinutes: BLOCK_MINUTES }),
    );
    const reference = perCadence[1];
    if (reference === undefined) {
      throw new Error('no cadence to report');
    }
    const adbStatusUnits = reference.adbCalls * 2;
    return [
      `${String(leadTimeDays)} days`,
      String(reference.adbCalls),
      String(adbStatusUnits),
      usd(adbStatusUnits * 250),
      ...perCadence.map((r) => `${usd(r.listCostUsdMicros)} (${pe(r.pollEquivalents)})`),
    ];
  });
  return markdownTable(header, rows);
}

function constantsTable(): string {
  return markdownTable(
    ['Constant', 'Value', 'Meaning'],
    [
      [
        '`A2_EXPECTED_POLLS`',
        String(A2_EXPECTED_POLLS),
        'AeroAPI status polls per flight inside 48 h',
      ],
      [
        '`A2_EXPECTED_ALERTS`',
        String(A2_EXPECTED_ALERTS),
        `assumed alert deliveries (\`ASSUMED_ALERTS_PER_FLIGHT\` = ${String(ASSUMED_ALERTS_PER_FLIGHT)}, unverified)`,
      ],
      [
        '`A2_EXPECTED_PE`',
        pe(A2_EXPECTED_PE),
        'expected poll-equivalents per flight, budget baseline',
      ],
      ['`A2_SOFT_CAP_PE`', pe(A2_SOFT_CAP_PE), '2x: metric and stretch cadence one tier'],
      [
        '`A2_HARD_CAP_PE`',
        pe(A2_HARD_CAP_PE),
        '4x: delete alerts, stop polling, one reconciliation poll',
      ],
      ['`A1_EXPECTED_POLLS`', String(A1_EXPECTED_POLLS), 'fallback cadence when alerts are silent'],
      [
        '`LITERAL_EXPECTED_POLLS`',
        String(LITERAL_EXPECTED_POLLS),
        'the brief as written, for comparison',
      ],
      ['`B_EXPECTED_POLLS`', String(B_EXPECTED_POLLS), 'Phase 1 target, unverified'],
      [
        '`MAX_LIFETIME`',
        'min(scheduledIn + 6 h, actualOff + 2 x block)',
        'hard stop for a flight that never reports in',
      ],
    ],
  );
}

function sloTable(): string {
  const header = ['Event', ...SLO_WINDOWS.map((w) => SLO_WINDOW_LABELS[w])];
  const rows = SLO_EVENTS.map((event) => [
    SLO_EVENT_LABELS[event],
    ...SLO_WINDOWS.map((window) => {
      const target = SLO_TABLE[event][window];
      if (target.pollMinutes === null) {
        return 'n/a';
      }
      const alerts =
        target.alertMinutes === undefined
          ? ''
          : ` (${formatMinutes(target.alertMinutes)} with alerts)`;
      return `${formatMinutes(target.pollMinutes)}${alerts}`;
    }),
  ]);
  return markdownTable(header, rows);
}

function relaxationsTable(): string {
  const rows: string[][] = [];
  for (const cadence of CADENCES) {
    for (const window of cadence.windows) {
      const strictest = Math.min(
        ...TIER_SLO_WINDOWS[window.tier]
          .map((w) => strictestPollSlo(w))
          .filter((v): v is number => v !== null),
      );
      if (!Number.isFinite(strictest)) {
        continue;
      }
      if (!isIntervalWindow(window)) {
        rows.push([
          cadence.id,
          TIER_LABELS[window.tier],
          'fixed slots',
          formatMinutes(strictest),
          'webhooks and alerts carry the SLO (unverified)',
        ]);
        continue;
      }
      if (window.intervalMinutes > strictest) {
        const why = window.alerts
          ? 'alerts carry OOOI and ETA; polls only need gates'
          : 'plan choice, polls are the only source';
        rows.push([
          cadence.id,
          TIER_LABELS[window.tier],
          formatMinutes(window.intervalMinutes),
          formatMinutes(strictest),
          why,
        ]);
      }
    }
  }
  return markdownTable(
    ['Cadence', 'Window', 'Poll interval', 'Strictest poll SLO', 'Why it is accepted'],
    rows,
  );
}

export function renderCadenceSection(): string {
  const results = new Map<CadenceDefinition, ExpectedCalls>();
  for (const cadence of CADENCES) {
    results.set(cadence, expectedCalls(cadence, { leadTimeDays: 2, blockMinutes: BLOCK_MINUTES }));
  }
  const params = DEFAULT_CADENCE_PARAMS;
  return [
    CADENCE_START_MARKER,
    '<!-- prettier-ignore-start -->',
    '',
    '_Generated from `packages/shared/src/cadence.ts` by `pnpm --filter @planeahead/shared gen:cadence-table`. Do not edit between the markers; `packages/shared/test/cadence-table.test.ts` fails when this block drifts from the code._',
    '',
    `Assumptions: block ${String(BLOCK_MINUTES)} min, boarding at T-${String(params.boardingMinutesBefore)} min, tail stops at in+${String(params.postArrivalStopMinutes)} min, on-time flight, one creation fetch at the lead time. Slot rule: start-anchored windows yield \`round(duration / interval)\` polls, so a trailing partial slot of at least half an interval earns a poll; the pre-48 h AeroDataBox windows count back from T-48 h (daily inside 14 d, every 2 d beyond) and yield \`floor(duration / interval)\`; the instant on a boundary belongs to the later window; \`+ final\` adds one poll at the tail's end. Prices are list prices from \`cost.ts\` (AeroAPI status $0.005, alert delivery $0.020; AeroDataBox 2 units per status call at $0.00025 per unit on Growth).`,
    '',
    '### Windows inside 48 h (AeroAPI)',
    '',
    windowsTable(results),
    '',
    '### Pre-48 h AeroDataBox calls and per-flight totals by lead time',
    '',
    'AeroDataBox status calls are the same for every cadence; the per-cadence columns add the inside-48 h figures (and, for B, the assumed AeroDataBox alert items). The plan quoted 4 / 26 / 42 units; the simulation gives one call less per lead time because the poll at exactly T-48 h is the AeroAPI bracketed fetch, not a second AeroDataBox call.',
    '',
    leadTimeTable(),
    '',
    '### Constants exported by `@planeahead/shared`',
    '',
    constantsTable(),
    '',
    '### Detection-latency SLOs the cadence is derived from',
    '',
    sloTable(),
    '',
    '### Where a cadence polls slower than the SLO',
    '',
    relaxationsTable(),
    '',
    '<!-- prettier-ignore-end -->',
    CADENCE_END_MARKER,
  ].join('\n');
}

/**
 * Splices `rendered` into `existing` between the markers. A missing document gets the stub;
 * a document without markers gets a cadence section appended.
 */
export function applyCadenceSection(existing: string | null, rendered: string): string {
  const doc = existing ?? ARCHITECTURE_STUB;
  const start = doc.indexOf(CADENCE_START_MARKER);
  const end = doc.indexOf(CADENCE_END_MARKER);
  if (start === -1 || end === -1 || end < start) {
    const trimmed = doc.replace(/\s+$/, '');
    return `${trimmed}\n\n## Refresh cadence\n\n${rendered}\n`;
  }
  return `${doc.slice(0, start)}${rendered}${doc.slice(end + CADENCE_END_MARKER.length)}`;
}

export function main(): void {
  const existing = existsSync(ARCHITECTURE_DOC_PATH)
    ? readFileSync(ARCHITECTURE_DOC_PATH, 'utf8')
    : null;
  const next = applyCadenceSection(existing, renderCadenceSection());
  if (next === existing) {
    console.log(`gen-cadence-table: ${ARCHITECTURE_DOC_PATH} is up to date`);
    return;
  }
  mkdirSync(dirname(ARCHITECTURE_DOC_PATH), { recursive: true });
  writeFileSync(ARCHITECTURE_DOC_PATH, next);
  console.log(`gen-cadence-table: wrote ${ARCHITECTURE_DOC_PATH}`);
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main();
}
