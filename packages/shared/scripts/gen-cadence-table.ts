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
  PRE_48H_RELAXATION_REASON,
  PRE_48H_WINDOWS,
  SLO_EVENTS,
  SLO_REPORT_LEAD_TIME_DAYS,
  SLO_TABLE,
  SLO_WINDOWS,
  expectedCalls,
  gapAcross,
  isIntervalWindow,
  sloRelaxations,
  type CadenceDefinition,
  type CadenceEdge,
  type CadenceTier,
  type CadenceWindow,
  type ExpectedCalls,
  type FixedSlot,
  type FixedSlotWindow,
  type RelaxedLeg,
  type SloEvent,
  type SloRelaxation,
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
  pre48h: 'Before 48 h',
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
    return d === 1 ? 'daily' : d === 7 ? 'weekly' : `every ${String(d)} d`;
  }
  return `${formatMinutes(minutes)} interval`;
}

/** `48h`, `40min`, `14d` for minutes before departure (days only from 3 d up, as the plan writes). */
function formatBefore(minutes: number): string {
  const text =
    minutes >= 3 * 1_440
      ? formatMinutes(minutes)
      : minutes % 60 === 0
        ? `${String(minutes / 60)} h`
        : `${String(minutes)} min`;
  return text.replace(' ', '');
}

/** `T-48h`, `T-40min`, `out`, `out+15min`, `in`, `in+60min` for a minute offset from departure. */
function formatFromDeparture(minutesAfterOut: number): string {
  if (minutesAfterOut < 0) {
    return `T-${formatBefore(-minutesAfterOut)}`;
  }
  if (minutesAfterOut === 0) {
    return 'out';
  }
  if (minutesAfterOut < BLOCK_MINUTES) {
    return `out+${String(minutesAfterOut)}min`;
  }
  if (minutesAfterOut === BLOCK_MINUTES) {
    return 'in';
  }
  return `in+${String(minutesAfterOut - BLOCK_MINUTES)}min`;
}

function edgeMinutesAfterOut(edge: CadenceEdge): number {
  if (typeof edge === 'number') {
    return -edge;
  }
  switch (edge) {
    case 'boarding':
      return -DEFAULT_CADENCE_PARAMS.boardingMinutesBefore;
    case 'departure':
      // On time, the departure anchor (N8) is scheduled out.
      return 0;
    case 'arrival':
      return BLOCK_MINUTES;
    case 'stop':
      return BLOCK_MINUTES + DEFAULT_CADENCE_PARAMS.postArrivalStopMinutes;
  }
}

function formatEdge(edge: CadenceEdge): string {
  return edge === Number.POSITIVE_INFINITY
    ? 'creation'
    : formatFromDeparture(edgeMinutesAfterOut(edge));
}

function formatSlot(slot: FixedSlot, window: FixedSlotWindow): string {
  const base =
    slot.edge === 'scheduledOut'
      ? 0
      : edgeMinutesAfterOut(slot.edge === 'from' ? window.from : window.to);
  return formatFromDeparture(base + slot.offsetMinutes);
}

function describeWindow(window: CadenceWindow, polls: number): string {
  if (isIntervalWindow(window)) {
    const range = `${formatEdge(window.from)} to ${formatEdge(window.to)}`;
    return `${formatInterval(window.intervalMinutes)}, ${range}: ${String(polls)}`;
  }
  const slots = window.slots.map((slot) => formatSlot(slot, window)).join(', ');
  return `fixed slots ${slots}: ${String(polls)}`;
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

function formatLeg(leg: RelaxedLeg): string {
  return `${formatFromDeparture(leg.fromMinutes)} to ${formatFromDeparture(leg.toMinutes)}`;
}

/**
 * The recorded decision behind each relaxation. Anything without a decision prints as OPEN so
 * the document never presents a rounding artefact as an accepted trade-off.
 */
function whyAccepted(cadence: CadenceDefinition, relaxation: SloRelaxation): string {
  const legs = relaxation.relaxedLegs.map(formatLeg).join(', ');
  if (relaxation.sloWindow === 'beyond_7d' || relaxation.sloWindow === '7d_to_48h') {
    return PRE_48H_RELAXATION_REASON;
  }
  if (cadence.id === 'literal') {
    return 'the brief as written, kept for comparison only';
  }
  if (cadence.id === 'B') {
    return 'webhooks and alerts are assumed to carry the SLO (unverified, Phase 1 decision)';
  }
  if (cadence.id === 'A2' && relaxation.sloWindow === '3h_to_arrival') {
    return 'plan section 8: OOOI and ETA arrive by alert; in-flight gate changes are accepted at 30-minute latency';
  }
  if (cadence.id === 'A2' && relaxation.sloWindow === 'post_arrival') {
    return 'plan section 8: alerts carry in; the tail only refreshes baggage claim';
  }
  if (cadence.id === 'A1' && relaxation.sloWindow === 'post_arrival') {
    return 'plan section 8: the fallback tail is five fixed polls, 15-minute cover for the first 45 minutes then a final poll';
  }
  return `OPEN: no recorded decision for ${legs}`;
}

/** The single widest gap behind a relaxation row, as a span. */
function widestLeg(relaxation: SloRelaxation): string {
  let widest: RelaxedLeg | undefined;
  for (const leg of relaxation.relaxedLegs) {
    if (
      widest === undefined ||
      leg.toMinutes - leg.fromMinutes > widest.toMinutes - widest.fromMinutes
    ) {
      widest = leg;
    }
  }
  return widest === undefined ? 'n/a' : formatLeg(widest);
}

function relaxationsTable(): string {
  const rows: string[][] = [];
  for (const cadence of CADENCES) {
    for (const relaxation of sloRelaxations(cadence, { blockMinutes: BLOCK_MINUTES })) {
      rows.push([
        cadence.id,
        SLO_WINDOW_LABELS[relaxation.sloWindow],
        widestLeg(relaxation),
        formatMinutes(relaxation.maxGapMinutes),
        formatMinutes(relaxation.strictestSloMinutes),
        whyAccepted(cadence, relaxation),
      ]);
    }
  }
  return markdownTable(
    [
      'Cadence',
      'SLO window',
      'Widest gap span',
      'Widest poll gap',
      'Strictest poll SLO',
      'Why it is accepted',
    ],
    rows,
  );
}

/** The hole across the landing instant per cadence, from the same simulated poll sequence. */
function landingGapLine(): string {
  const parts = CADENCES.map((cadence) => {
    const { pollInstants } = expectedCalls(cadence, {
      leadTimeDays: SLO_REPORT_LEAD_TIME_DAYS,
      blockMinutes: BLOCK_MINUTES,
    });
    const gap = gapAcross(pollInstants, BLOCK_MINUTES);
    return gap === null
      ? `${cadence.id} none`
      : `${cadence.id} ${formatMinutes(gap.toMinutes - gap.fromMinutes)} (${formatLeg(gap)})`;
  });
  return `Gap across the landing instant, from the last poll before \`in\` to the first at or after it: ${parts.join('; ')}.`;
}

/** The pre-48 h window as one sentence, rendered from `PRE_48H_WINDOWS`. */
function pre48hRule(): string {
  const parts = PRE_48H_WINDOWS.map(
    (window) =>
      `${formatInterval(window.intervalMinutes)} from ${formatEdge(window.from)} to ${formatEdge(window.to)}, end-anchored on ${formatEdge(window.to)}`,
  );
  return `Before T-48 h every cadence polls AeroDataBox ${parts.join('; ')} (increment 6: ${PRE_48H_RELAXATION_REASON}).`;
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
    `Assumptions: block ${String(BLOCK_MINUTES)} min, boarding at T-${String(params.boardingMinutesBefore)} min, tail stops at in+${String(params.postArrivalStopMinutes)} min, on-time flight, one creation fetch at the lead time. Slot rule: start-anchored windows yield \`ceil(duration / interval)\` polls, so a trailing partial slot always earns a poll and no window ends with a gap longer than its interval; the pre-48 h AeroDataBox window counts back from T-48 h (weekly: T-9 d, T-16 d, T-23 d, ...) and yields \`floor(duration / interval)\`; the instant on a boundary belongs to the later window; fixed-slot windows list their slots. A flight that passes its planned arrival without \`in\` keeps polling until \`in\` or \`MAX_LIFETIME\`: interval windows continue their grid, fixed-slot windows poll every \`lateIntervalMinutes\` from the planned arrival. Prices are list prices from \`cost.ts\` (AeroAPI status $0.005, alert delivery $0.020; AeroDataBox 2 units per status call at $0.00025 per unit on Growth).`,
    '',
    '### Windows inside 48 h (AeroAPI)',
    '',
    windowsTable(results),
    '',
    '### Pre-48 h AeroDataBox calls and per-flight totals by lead time',
    '',
    `${pre48hRule()} AeroDataBox status calls are the same for every cadence: the creation fetch plus every weekly slot after it, so 1 / 2 / 4 calls at 3 / 14 / 30 days (the plan's daily-inside-14-days and every-2-days-beyond grids gave 1 / 12 / 20). The poll at exactly T-48 h opens the AeroAPI window, but the router serves that one slot from AeroDataBox in every mode: at T-48 h the flight sits on AeroAPI's exclusive 2-day horizon, so no window AeroAPI accepts contains it (increment 6 review); in \`live\` mode a flight therefore makes one more AeroDataBox call and one fewer AeroAPI poll than these columns show. The per-cadence columns add the inside-48 h figures (and, for B, the assumed AeroDataBox alert items).`,
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
    `Measured from the simulated poll sequence (one creation fetch ${String(SLO_REPORT_LEAD_TIME_DAYS)} days out, then every slot \`refreshIntervalFor\` schedules, with the tail stop closing the last gap): each SLO window is charged the widest gap between consecutive polls that lies inside it or crosses one of its edges. A gap that crosses a window boundary counts against both windows; a gap that ends on the boundary counts against the earlier window only. A row appears when the widest gap exceeds the strictest poll SLO of the window.`,
    '',
    relaxationsTable(),
    '',
    landingGapLine(),
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
