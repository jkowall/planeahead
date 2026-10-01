import { describe, expect, it } from 'vitest';
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
  CADENCE_A1,
  CADENCE_A2,
  CADENCE_B,
  CADENCE_LITERAL,
  CadenceError,
  DAY_MS,
  DEFAULT_CADENCE_PARAMS,
  LIFETIME_AFTER_SCHEDULED_IN_MINUTES,
  LITERAL_EXPECTED_POLLS,
  MAX_LIFETIME,
  MINUTE_MS,
  PRE_48H_RELAXATION_REASON,
  PRE_48H_WINDOWS,
  SLO_EVENTS,
  SLO_REPORT_LEAD_TIME_DAYS,
  SLO_TABLE,
  SLO_WINDOWS,
  SLO_WINDOW_BOUNDS,
  days,
  expectedCalls,
  gapAcross,
  hours,
  isIntervalWindow,
  maxLifetime,
  nextSlot,
  pollGaps,
  refreshIntervalFor,
  resolveWindows,
  sloRelaxations,
  slotCount,
  strictestPollSlo,
  windowAt,
  type CadenceContext,
  type CadenceDefinition,
  type CadenceTier,
  type RefreshDecision,
  type SloWindow,
  type TrackerPhase,
} from '../src/cadence';
import { pollEquivalents } from '../src/cost';

const OUT = Date.UTC(2026, 8, 19, 12, 0, 0);
const BLOCK = 180;
const IN = OUT + BLOCK * MINUTE_MS;
const scheduledOut = new Date(OUT);
const scheduledIn = new Date(IN);

function at(minutesFromOut: number): Date {
  return new Date(OUT + minutesFromOut * MINUTE_MS);
}

/** An on-time flight observed `minutesFromOut` from scheduled departure, unless overridden. */
function ctx(minutesFromOut: number, overrides: Partial<CadenceContext> = {}): CadenceContext {
  const phase: TrackerPhase =
    minutesFromOut < -40
      ? 'scheduled'
      : minutesFromOut < 0
        ? 'boarding'
        : minutesFromOut < BLOCK
          ? 'en_route'
          : 'arrived';
  const onTime: CadenceContext = {
    now: at(minutesFromOut),
    scheduledOut,
    scheduledIn,
    phase,
    actualOut: minutesFromOut >= 0 ? scheduledOut : undefined,
    actualOff: minutesFromOut >= 0 ? scheduledOut : undefined,
    actualIn: minutesFromOut >= BLOCK ? scheduledIn : undefined,
  };
  return { ...onTime, ...overrides };
}

function decide(
  cadence: CadenceDefinition,
  minutesFromOut: number,
  overrides: Partial<CadenceContext> = {},
): RefreshDecision {
  const decision = refreshIntervalFor(cadence, ctx(minutesFromOut, overrides));
  expect(decision).not.toBeNull();
  return decision!;
}

function nextMinutes(decision: RefreshDecision): number {
  return (decision.nextRefreshAt.getTime() - OUT) / MINUTE_MS;
}

const TIER_ORDER: CadenceTier[] = ['pre48h', 'hourly', 'pre_boarding', 'in_flight', 'post_arrival'];

describe('derived constants', () => {
  it('derive A2 74 polls, 12 alerts, 122 PE; A1 84; literal 181; B 5 (the plan wrote 72 and 83 with a round() slot rule that left a 20-minute hole before boarding)', () => {
    expect(A2_EXPECTED_POLLS).toBe(74);
    expect(A2_EXPECTED_ALERTS).toBe(12);
    expect(ASSUMED_ALERTS_PER_FLIGHT).toBe(12);
    expect(A2_EXPECTED_PE).toBe(122);
    expect(A2_SOFT_CAP_PE).toBe(244);
    expect(A2_HARD_CAP_PE).toBe(488);
    expect(A1_EXPECTED_POLLS).toBe(84);
    expect(LITERAL_EXPECTED_POLLS).toBe(181);
    expect(B_EXPECTED_POLLS).toBe(5);
  });

  it('are computed from the simulation and the price table, not typed', () => {
    const a2 = expectedCalls(CADENCE_A2, { leadTimeDays: 2 });
    expect(A2_EXPECTED_POLLS).toBe(a2.polls);
    expect(A2_EXPECTED_ALERTS).toBe(a2.alerts);
    expect(A2_EXPECTED_PE).toBe(a2.pollEquivalents);
    expect(A2_EXPECTED_PE).toBe(
      A2_EXPECTED_POLLS * pollEquivalents('aeroapi', 'flight_by_id') +
        A2_EXPECTED_ALERTS * pollEquivalents('aeroapi', 'alert_delivery'),
    );
    expect(A2_SOFT_CAP_PE).toBe(2 * A2_EXPECTED_PE);
    expect(A2_HARD_CAP_PE).toBe(4 * A2_EXPECTED_PE);
    expect(A1_EXPECTED_POLLS).toBe(expectedCalls(CADENCE_A1, { leadTimeDays: 2 }).polls);
  });

  it('unit helpers', () => {
    expect(hours(2)).toBe(120);
    expect(days(1)).toBe(1_440);
    expect(MINUTE_MS).toBe(60_000);
    expect(DAY_MS).toBe(86_400_000);
    expect(LIFETIME_AFTER_SCHEDULED_IN_MINUTES).toBe(360);
    expect(Object.isFrozen(DEFAULT_CADENCE_PARAMS)).toBe(true);
    expect(DEFAULT_CADENCE_PARAMS).toEqual({
      boardingMinutesBefore: 40,
      postArrivalStopMinutes: 120,
    });
  });
});

describe('cadence definitions', () => {
  it('are listed in plan order with unique ids', () => {
    expect(CADENCES.map((c) => c.id)).toEqual(['literal', 'A1', 'A2', 'B']);
    expect(CADENCES).toEqual([CADENCE_LITERAL, CADENCE_A1, CADENCE_A2, CADENCE_B]);
  });

  it.each(CADENCES.map((c) => [c.id, c] as const))(
    '%s: windows are contiguous, ordered by tier, ADB before T-48h and AeroAPI after',
    (_id, cadence) => {
      expect(cadence.windows.map((w) => w.tier)).toEqual(TIER_ORDER);
      expect(cadence.windows.slice(0, 1)).toEqual(PRE_48H_WINDOWS);
      expect(cadence.windows[0]?.from).toBe(Number.POSITIVE_INFINITY);
      expect(cadence.windows[cadence.windows.length - 1]?.to).toBe('stop');
      for (let i = 1; i < cadence.windows.length; i += 1) {
        expect(cadence.windows[i]?.from).toEqual(cadence.windows[i - 1]?.to);
      }
      for (const window of cadence.windows) {
        const pre48h = window.tier === 'pre48h';
        expect(window.source).toBe(pre48h ? 'aerodatabox' : 'aeroapi');
        expect(window.alerts).toBe(pre48h ? false : cadence.aeroapiAlerts !== null);
      }
    },
  );

  it('pre-48 h rule (increment 6): one weekly window from creation to T-48 h, end-anchored on T-48 h', () => {
    expect(PRE_48H_WINDOWS.map((w) => [w.from, w.to, w.intervalMinutes, w.anchor])).toEqual([
      [Number.POSITIVE_INFINITY, hours(48), days(7), 'end'],
    ]);
    expect(PRE_48H_WINDOWS[0]).toMatchObject({
      tier: 'pre48h',
      source: 'aerodatabox',
      alerts: false,
    });
  });

  it('A2 keeps the plan intervals: hourly, 15, 30, 60; A1: hourly, 15, 15, then fixed slots', () => {
    const intervals = (c: CadenceDefinition): (number | null)[] =>
      c.windows.slice(1).map((w) => (isIntervalWindow(w) ? w.intervalMinutes : null));
    expect(intervals(CADENCE_A2)).toEqual([60, 15, 30, 60]);
    expect(intervals(CADENCE_A1)).toEqual([60, 15, 15, null]);
    expect(intervals(CADENCE_LITERAL)).toEqual([60, 10, 2, 10]);
    expect(intervals(CADENCE_B)).toEqual([null, null, null, null]);
    expect(CADENCE_LITERAL.windows[1]?.to).toBe(hours(3));
    expect(CADENCE_A2.windows[1]?.to).toBe(hours(6));
  });

  it('A1 tail is fixed slots at in+0, in+15, in+30, in+45 and a final poll at in+120 (R2, revised)', () => {
    const tail = CADENCE_A1.windows[4];
    expect(tail !== undefined && !isIntervalWindow(tail) ? tail.slots : null).toEqual([
      { edge: 'from', offsetMinutes: 0 },
      { edge: 'from', offsetMinutes: 15 },
      { edge: 'from', offsetMinutes: 30 },
      { edge: 'from', offsetMinutes: 45 },
      { edge: 'to', offsetMinutes: 0 },
    ]);
    expect(tail).toMatchObject({ from: 'arrival', to: 'stop', source: 'aeroapi', alerts: false });
  });

  it('B names a late-flight interval on its fixed-slot in-flight window', () => {
    const inFlight = CADENCE_B.windows[3];
    expect(
      inFlight !== undefined && !isIntervalWindow(inFlight) ? inFlight.lateIntervalMinutes : null,
    ).toBe(15);
  });

  it('only A2 and B assume alert deliveries', () => {
    expect(CADENCE_LITERAL.aeroapiAlerts).toBeNull();
    expect(CADENCE_A1.aeroapiAlerts).toBeNull();
    expect(CADENCE_A2.aeroapiAlerts?.assumedDeliveriesPerFlight).toBe(12);
    expect(CADENCE_A2.aeroapiAlerts?.events).toContain('filed');
    expect(CADENCE_A2.aerodataboxAlerts).toBeNull();
    expect(CADENCE_B.aeroapiAlerts?.assumedDeliveriesPerFlight).toBe(8);
    expect(CADENCE_B.aerodataboxAlerts?.assumedItemsPerFlight).toBe(15);
  });
});

describe('SLO table', () => {
  it('has every event for every window', () => {
    expect(SLO_WINDOWS).toHaveLength(6);
    expect(SLO_EVENTS).toEqual(['schedule_change', 'gate_change', 'eta_change', 'oooi']);
    for (const event of SLO_EVENTS) {
      for (const window of SLO_WINDOWS) {
        expect(SLO_TABLE[event][window]).toBeDefined();
      }
    }
  });

  it('matches the dossier', () => {
    expect(SLO_TABLE.schedule_change.beyond_7d.pollMinutes).toBe(hours(48));
    expect(SLO_TABLE.schedule_change['7d_to_48h'].pollMinutes).toBe(hours(24));
    expect(SLO_TABLE.schedule_change['48h_to_6h'].pollMinutes).toBe(60);
    expect(SLO_TABLE.gate_change['6h_to_3h'].pollMinutes).toBe(15);
    expect(SLO_TABLE.gate_change.beyond_7d.pollMinutes).toBeNull();
    expect(SLO_TABLE.oooi['3h_to_arrival']).toEqual({ pollMinutes: 15, alertMinutes: 2 });
    expect(SLO_TABLE.eta_change.post_arrival.pollMinutes).toBe(15);
  });

  it('strictestPollSlo takes the tightest applicable target', () => {
    expect(SLO_WINDOWS.map((w) => strictestPollSlo(w))).toEqual([2_880, 1_440, 60, 15, 15, 15]);
  });

  it('bounds every SLO window, contiguous from creation to the tail stop', () => {
    expect(SLO_WINDOWS.map((w) => [SLO_WINDOW_BOUNDS[w].from, SLO_WINDOW_BOUNDS[w].to])).toEqual([
      [Number.POSITIVE_INFINITY, days(7)],
      [days(7), hours(48)],
      [hours(48), hours(6)],
      [hours(6), hours(3)],
      [hours(3), 'arrival'],
      ['arrival', 'stop'],
    ]);
  });

  it('documents exactly the relaxations the plan accepts, measured from the simulated polls (R10)', () => {
    const summary = (c: CadenceDefinition): [SloWindow, number, number][] =>
      sloRelaxations(c).map((r) => [r.sloWindow, r.maxGapMinutes, r.strictestSloMinutes]);
    // Increment 6: the weekly pre-48 h grid is slower than both pre-48 h SLO targets, on every
    // cadence, deliberately (PRE_48H_RELAXATION_REASON).
    const pre48h: [SloWindow, number, number][] = [
      ['beyond_7d', days(7), hours(48)],
      ['7d_to_48h', days(7), hours(24)],
    ];
    expect(summary(CADENCE_LITERAL)).toEqual([...pre48h, ['6h_to_3h', 60, 15]]);
    expect(summary(CADENCE_A1)).toEqual([...pre48h, ['post_arrival', 75, 15]]);
    expect(summary(CADENCE_A2)).toEqual([
      ...pre48h,
      ['3h_to_arrival', 30, 15],
      ['post_arrival', 60, 15],
    ]);
    expect(summary(CADENCE_B)).toEqual([
      ...pre48h,
      ['48h_to_6h', hours(45), 60],
      ['6h_to_3h', hours(45), 15],
      ['3h_to_arrival', 195, 15],
      ['post_arrival', 180, 15],
    ]);
  });

  it('holds the literal hourly polls to the 6 h to 3 h target they run into', () => {
    // A lookup by tier name mapped `hourly` to `48h_to_6h` only and reported no relaxation.
    const hourly = sloRelaxations(CADENCE_LITERAL).find((r) => r.sloWindow === '6h_to_3h');
    expect(hourly).toMatchObject({ sloWindow: '6h_to_3h', tiers: ['hourly'], alerts: false });
    expect(hourly?.relaxedLegs).toEqual([
      { fromMinutes: -hours(6), toMinutes: -hours(5) },
      { fromMinutes: -hours(5), toMinutes: -hours(4) },
      { fromMinutes: -hours(4), toMinutes: -hours(3) },
    ]);
    expect(sloRelaxations(CADENCE_A2).map((r) => [r.tiers, r.alerts])).toEqual([
      [['pre48h'], false],
      [['pre48h'], false],
      [['pre_boarding', 'in_flight'], true],
      [['post_arrival'], true],
    ]);
  });

  it('charges a gap that crosses an SLO boundary to both windows (R10)', () => {
    // B polls at T-48 h and then at T-3 h: the 45 h between them cross T-6 h, so the 48 h to
    // 6 h and the 6 h to 3 h windows both carry that gap. Measuring each cadence window from
    // its own start edge reported 42 h and 3 h instead.
    const [hourly, preBoarding, inFlight, tail] = sloRelaxations(CADENCE_B).slice(2);
    const leg = { fromMinutes: -hours(48), toMinutes: -hours(3) };
    expect(hourly).toMatchObject({
      sloWindow: '48h_to_6h',
      maxGapMinutes: hours(45),
      relaxedLegs: [leg],
    });
    expect(preBoarding).toMatchObject({
      sloWindow: '6h_to_3h',
      maxGapMinutes: hours(45),
      relaxedLegs: [leg],
    });
    // B's out+15 to in+15 poll pair crosses the landing instant and reaches both rows.
    const acrossLanding = { fromMinutes: 15, toMinutes: BLOCK + 15 };
    expect(inFlight?.relaxedLegs).toEqual([
      { fromMinutes: -hours(3), toMinutes: 15 },
      acrossLanding,
    ]);
    expect(tail?.relaxedLegs).toEqual([
      acrossLanding,
      { fromMinutes: BLOCK + 15, toMinutes: BLOCK + 120 },
    ]);
  });

  it('charges a gap that ends on an SLO boundary to the earlier window only', () => {
    // The literal brief's T-7 h to T-6 h poll pair ends on T-6 h: the 48 h to 6 h window sees
    // a 60-minute gap that meets its 60-minute target, and the 6 h to 3 h window never sees it.
    expect(sloRelaxations(CADENCE_LITERAL).map((r) => r.sloWindow)).toEqual([
      'beyond_7d',
      '7d_to_48h',
      '6h_to_3h',
    ]);
    // A1's in-10 to in poll pair ends on the landing instant, so the post-arrival row starts at
    // in and holds the 15-minute target until in+45.
    const tail = sloRelaxations(CADENCE_A1).find((r) => r.sloWindow === 'post_arrival');
    expect(tail?.relaxedLegs).toEqual([{ fromMinutes: BLOCK + 45, toMinutes: BLOCK + 120 }]);
  });

  it('A1 tail meets the 15-minute post-arrival SLO for the first 45 minutes; only in+45 to in+120 is relaxed (R2)', () => {
    const tail = sloRelaxations(CADENCE_A1).find((r) => r.sloWindow === 'post_arrival');
    expect(tail).toMatchObject({
      cadence: 'A1',
      tiers: ['post_arrival'],
      alerts: false,
      strictestSloMinutes: 15,
      maxGapMinutes: 75,
    });
    expect(tail?.relaxedLegs).toEqual([{ fromMinutes: BLOCK + 45, toMinutes: BLOCK + 120 }]);
  });

  it('leaves no hole before departure: A1 polls to T-45 then T-40, A2 every 15 minutes to out', () => {
    // A1: 320 minutes of 15-minute slots ceil to 22 (a round() rule gave 21 and a 20-minute hole
    // from T-60 to T-40, which a 15-minute gate SLO does not allow on a polls-only cadence).
    // A2 (N8): the 15-minute grid runs to the departure anchor and the 30-minute one opens there.
    const around = (c: CadenceDefinition): number[] =>
      expectedCalls(c, { leadTimeDays: 2 }).pollInstants.filter((m) => m >= -120 && m <= 0);
    expect(around(CADENCE_A1)).toEqual([-120, -105, -90, -75, -60, -45, -40, -25, -10]);
    expect(around(CADENCE_A2)).toEqual([-120, -105, -90, -75, -60, -45, -30, -15, 0]);
    expect(sloRelaxations(CADENCE_A1).some((r) => r.sloWindow === '3h_to_arrival')).toBe(false);
  });

  it('measures the hole across the landing instant from the simulated polls (R2, R10)', () => {
    const across = (c: CadenceDefinition): [number, number] | null => {
      const gap = gapAcross(expectedCalls(c, { leadTimeDays: 2 }).pollInstants, BLOCK);
      return gap === null ? null : [gap.fromMinutes, gap.toMinutes];
    };
    // Before R2 was revised, A1's first tail slot at in+15 left 25 minutes from the in-10 poll.
    expect(across(CADENCE_A1)).toEqual([BLOCK - 10, BLOCK]);
    // N8 moved A2's in-flight grid to out, so its last slot is in-30 (R4 D3's stated trade-off).
    expect(across(CADENCE_A2)).toEqual([BLOCK - 30, BLOCK]);
    expect(across(CADENCE_LITERAL)).toEqual([BLOCK - 2, BLOCK]);
    expect(across(CADENCE_B)).toEqual([15, BLOCK + 15]);
    expect(gapAcross([10, 20], 30)).toBeNull();
    expect(gapAcross([10, 20], 5)).toBeNull();
    expect(gapAcross([10, 20, 30], 20)).toEqual({ fromMinutes: 10, toMinutes: 20 });
    expect(pollGaps([1, 4, 9])).toEqual([
      { fromMinutes: 1, toMinutes: 4 },
      { fromMinutes: 4, toMinutes: 9 },
    ]);
    expect(pollGaps([7])).toEqual([]);
  });

  it('charges the silence between the last poll and the tail stop', () => {
    // A2 polls at in and in+60 and stops at in+120: the last hour is unpolled and counts.
    const tail = sloRelaxations(CADENCE_A2).find((r) => r.sloWindow === 'post_arrival');
    expect(tail?.relaxedLegs).toEqual([
      { fromMinutes: BLOCK, toMinutes: BLOCK + 60 },
      { fromMinutes: BLOCK + 60, toMinutes: BLOCK + 120 },
    ]);
    // Stopping at in+30 leaves A2 one tail poll at in and 30 silent minutes to the stop.
    const short = sloRelaxations(CADENCE_A2, { postArrivalStopMinutes: 30 });
    expect(short.find((r) => r.sloWindow === 'post_arrival')).toMatchObject({
      maxGapMinutes: 30,
      relaxedLegs: [{ fromMinutes: BLOCK, toMinutes: BLOCK + 30 }],
    });
  });

  it('flags both pre-48 h SLO windows with the weekly gap, and nothing else before T-48 h (increment 6)', () => {
    // The daily and 2-day grids sat exactly on the 24 h and 48 h targets; the weekly grid is
    // relaxed on purpose, because AeroDataBox's schedule layer only refreshes every two weeks.
    expect(SLO_REPORT_LEAD_TIME_DAYS).toBe(30);
    expect(PRE_48H_RELAXATION_REASON).toBe(
      "AeroDataBox schedule layer refreshes biweekly; a weekly poll is the data source's own resolution",
    );
    const PRE_48H_SLO_WINDOWS: readonly SloWindow[] = ['beyond_7d', '7d_to_48h'];
    for (const cadence of CADENCES) {
      const report = sloRelaxations(cadence, { leadTimeDays: SLO_REPORT_LEAD_TIME_DAYS });
      const pre48h = report.filter((r) => PRE_48H_SLO_WINDOWS.includes(r.sloWindow));
      expect(pre48h).toEqual([
        {
          cadence: cadence.id,
          sloWindow: 'beyond_7d',
          tiers: ['pre48h'],
          alerts: false,
          strictestSloMinutes: hours(48),
          maxGapMinutes: days(7),
          relaxedLegs: [
            { fromMinutes: -days(30), toMinutes: -days(23) },
            { fromMinutes: -days(23), toMinutes: -days(16) },
            { fromMinutes: -days(16), toMinutes: -days(9) },
            // Crosses T-7 d, so it is charged to both windows (R10).
            { fromMinutes: -days(9), toMinutes: -hours(48) },
          ],
        },
        {
          cadence: cadence.id,
          sloWindow: '7d_to_48h',
          tiers: ['pre48h'],
          alerts: false,
          strictestSloMinutes: hours(24),
          maxGapMinutes: days(7),
          relaxedLegs: [{ fromMinutes: -days(9), toMinutes: -hours(48) }],
        },
      ]);
      // A tracker created at T-48 h never polls AeroDataBox, so nothing pre-48 h is relaxed and
      // the inside-48 h rows are the same as the 30-day report's.
      expect(sloRelaxations(cadence, { leadTimeDays: 2 })).toEqual(
        report.filter((r) => !PRE_48H_SLO_WINDOWS.includes(r.sloWindow)),
      );
    }
  });
});

describe('refreshIntervalFor (A2 unless stated)', () => {
  it('polls AeroDataBox weekly before T-48 h, counting back from T-48 h (increment 6)', () => {
    const d = decide(CADENCE_A2, -days(30));
    expect(nextMinutes(d)).toBe(-days(23));
    expect(d.intervalMs).toBe(7 * DAY_MS);
    expect(d.source).toBe('aerodatabox');
    expect(d.tier).toBe('pre48h');
    expect(d.nominalIntervalMinutes).toBe(days(7));
    expect(d.alerts).toBe(false);
    expect(nextMinutes(decide(CADENCE_A2, -days(16)))).toBe(-days(9));
    expect(nextMinutes(decide(CADENCE_A2, -days(14)))).toBe(-days(9));
    expect(nextMinutes(decide(CADENCE_A2, -days(13.5)))).toBe(-days(9));
    expect(nextMinutes(decide(CADENCE_A2, -days(9) - 1))).toBe(-days(9));
    expect(decide(CADENCE_A2, -days(14)).tier).toBe('pre48h');
  });

  it('makes T-48 h the first AeroAPI poll: nothing else fires between T-9 d and T-48 h', () => {
    for (const minutes of [-days(9), -days(4), -days(3), -hours(60), -hours(49)]) {
      const d = decide(CADENCE_A2, minutes);
      expect(nextMinutes(d)).toBe(-hours(48));
      expect(d.source).toBe('aeroapi');
      expect(d.tier).toBe('hourly');
      expect(d.alerts).toBe(true);
    }
  });

  it('never schedules an AeroAPI call before T-48 h, from any lead time', () => {
    let t = -days(30);
    for (let i = 0; i < 200; i += 1) {
      const d = refreshIntervalFor(CADENCE_A2, ctx(t));
      if (d === null) {
        break;
      }
      const next = nextMinutes(d);
      if (d.source === 'aeroapi') {
        expect(next).toBeGreaterThanOrEqual(-hours(48));
      } else {
        expect(next).toBeLessThan(-hours(48));
      }
      t = next;
    }
    expect(t).toBeGreaterThan(BLOCK);
  });

  it('hourly from T-48 h to T-6 h, then the 15-minute window opens at T-6 h', () => {
    const d = decide(CADENCE_A2, -hours(48));
    expect(nextMinutes(d)).toBe(-hours(47));
    expect(d.intervalMs).toBe(60 * MINUTE_MS);
    expect(d.nominalIntervalMinutes).toBe(60);
    expect(nextMinutes(decide(CADENCE_A2, -hours(7)))).toBe(-hours(6));
    const opening = decide(CADENCE_A2, -hours(7));
    expect(opening.tier).toBe('pre_boarding');
    expect(opening.nominalIntervalMinutes).toBe(15);
    expect(nextMinutes(decide(CADENCE_A2, -hours(6)))).toBe(-hours(6) + 15);
    expect(nextMinutes(decide(CADENCE_A2, -hours(6) + 1))).toBe(-hours(6) + 15);
  });

  it('switches to the in-flight interval at the departure anchor, not at boarding (N8)', () => {
    const last = decide(CADENCE_A2, -30);
    expect(nextMinutes(last)).toBe(-15);
    expect(last.tier).toBe('pre_boarding');
    const d = decide(CADENCE_A2, -15);
    expect(nextMinutes(d)).toBe(0);
    expect(d.tier).toBe('in_flight');
    expect(d.nominalIntervalMinutes).toBe(30);
    expect(d.intervalMs).toBe(15 * MINUTE_MS);
    expect(nextMinutes(decide(CADENCE_A2, 0))).toBe(30);
    expect(nextMinutes(decide(CADENCE_A2, 140))).toBe(150);
    expect(decide(CADENCE_A2, 140).tier).toBe('in_flight');
    expect(nextMinutes(decide(CADENCE_A2, 150))).toBe(180);
    expect(decide(CADENCE_A2, 150).tier).toBe('post_arrival');
  });

  it('runs the tail from arrival and stops at in + 2 h', () => {
    const d = decide(CADENCE_A2, 180);
    expect(nextMinutes(d)).toBe(240);
    expect(d.tier).toBe('post_arrival');
    expect(d.nominalIntervalMinutes).toBe(60);
    expect(refreshIntervalFor(CADENCE_A2, ctx(240))).toBeNull();
    expect(refreshIntervalFor(CADENCE_A2, ctx(300))).toBeNull();
  });

  it('A1 tail fires at in, in+15, in+30, in+45 and in+120, then stops (R2, revised)', () => {
    const slots: number[] = [];
    let t = 170;
    for (let i = 0; i < 10; i += 1) {
      const d = refreshIntervalFor(CADENCE_A1, ctx(t));
      if (d === null) {
        break;
      }
      t = nextMinutes(d);
      slots.push(t);
    }
    expect(slots).toEqual([180, 195, 210, 225, 300]);
    // The last in-flight poll at in-10 hands over to the tail's in+0 slot: 10 minutes, not 25.
    const landing = decide(CADENCE_A1, 170);
    expect(landing.tier).toBe('post_arrival');
    expect(landing.intervalMs).toBe(10 * MINUTE_MS);
    expect(landing.nominalIntervalMinutes).toBeNull();
    expect(decide(CADENCE_A1, 180).tier).toBe('post_arrival');
    expect(refreshIntervalFor(CADENCE_A1, ctx(300))).toBeNull();
  });

  it('A1 polls every 15 minutes in flight', () => {
    expect(nextMinutes(decide(CADENCE_A1, -40))).toBe(-25);
    expect(decide(CADENCE_A1, -40).nominalIntervalMinutes).toBe(15);
  });

  it('the literal brief keeps hourly polls until T-3 h, then 10 and 2 minutes', () => {
    expect(nextMinutes(decide(CADENCE_LITERAL, -hours(5)))).toBe(-hours(4));
    expect(decide(CADENCE_LITERAL, -hours(5)).tier).toBe('hourly');
    expect(nextMinutes(decide(CADENCE_LITERAL, -hours(4)))).toBe(-hours(3));
    expect(decide(CADENCE_LITERAL, -hours(4)).tier).toBe('pre_boarding');
    expect(nextMinutes(decide(CADENCE_LITERAL, -hours(3) - 1))).toBe(-hours(3));
    expect(decide(CADENCE_LITERAL, -hours(3) - 1).tier).toBe('pre_boarding');
    expect(nextMinutes(decide(CADENCE_LITERAL, -hours(3)))).toBe(-170);
    expect(nextMinutes(decide(CADENCE_LITERAL, -40))).toBe(-38);
    expect(nextMinutes(decide(CADENCE_LITERAL, 180))).toBe(190);
  });

  it('B fires five fixed slots: T-48 h, T-3 h, out + 15, in + 15, in + 120', () => {
    expect(windowAt(CADENCE_B, ctx(-hours(48)))?.tier).toBe('hourly');
    const first = decide(CADENCE_B, -hours(48));
    expect(nextMinutes(first)).toBe(-hours(3));
    expect(first.nominalIntervalMinutes).toBeNull();
    expect(first.intervalMs).toBe(45 * 60 * MINUTE_MS);
    expect(nextMinutes(decide(CADENCE_B, -hours(3)))).toBe(15);
    expect(nextMinutes(decide(CADENCE_B, 15))).toBe(195);
    expect(nextMinutes(decide(CADENCE_B, 195))).toBe(300);
    expect(refreshIntervalFor(CADENCE_B, ctx(300))).toBeNull();
  });

  it('returns null for cancelled and finished flights at any time', () => {
    for (const minutes of [-days(10), -hours(10), -20, 100, 250]) {
      expect(refreshIntervalFor(CADENCE_A2, ctx(minutes, { phase: 'cancelled' }))).toBeNull();
      expect(refreshIntervalFor(CADENCE_A2, ctx(minutes, { phase: 'finished' }))).toBeNull();
    }
  });

  it('keeps the in-flight cadence while a late flight has not reported in', () => {
    const late = decide(CADENCE_A2, 200, { phase: 'en_route', actualIn: undefined });
    expect(nextMinutes(late)).toBe(210);
    expect(late.tier).toBe('in_flight');
    const landed = decide(CADENCE_A2, 200, {
      phase: 'landed',
      actualOn: at(190),
      actualIn: undefined,
    });
    expect(landed.tier).toBe('in_flight');
    expect(nextMinutes(landed)).toBe(210);
  });

  it('B polls a late flight every 15 minutes from the planned arrival until the lifetime', () => {
    // Before the fix, B's only in-flight slot (out + 15) was in the past and the tail had been
    // dropped, so the tracker finished at the planned arrival with the aircraft still airborne.
    const late = { phase: 'en_route' as const, actualIn: undefined };
    expect(nextMinutes(decide(CADENCE_B, 179))).toBe(195);
    const atArrival = decide(CADENCE_B, 180, late);
    expect(nextMinutes(atArrival)).toBe(195);
    expect(atArrival.tier).toBe('in_flight');
    expect(atArrival.nominalIntervalMinutes).toBeNull();
    expect(nextMinutes(decide(CADENCE_B, 200, late))).toBe(210);
    const landed = { phase: 'landed' as const, actualOn: at(190), actualIn: undefined };
    expect(nextMinutes(decide(CADENCE_B, 200, landed))).toBe(210);
    const polls: number[] = [];
    let t = 200;
    for (let i = 0; i < 100; i += 1) {
      const d = refreshIntervalFor(CADENCE_B, ctx(t, late));
      if (d === null) {
        break;
      }
      t = nextMinutes(d);
      polls.push(t);
    }
    expect(polls[0]).toBe(210);
    expect(polls[polls.length - 1]).toBe(360);
    expect(polls).toHaveLength(11);
    expect(maxLifetime(scheduledIn, scheduledOut, BLOCK)).toEqual(at(360));
    expect(refreshIntervalFor(CADENCE_B, ctx(360, late))).toBeNull();
  });

  it('lets a provider arrival estimate move the tail', () => {
    const d = decide(CADENCE_A2, 140, { estimatedIn: at(210) });
    expect(nextMinutes(d)).toBe(150);
    expect(d.tier).toBe('in_flight');
    // On time the slot at in belongs to the tail; a later estimate keeps it in flight.
    expect(decide(CADENCE_A2, 160).tier).toBe('post_arrival');
    const later = decide(CADENCE_A2, 160, { estimatedIn: at(210) });
    expect([nextMinutes(later), later.tier]).toEqual([180, 'in_flight']);
    const early = decide(CADENCE_A2, 140, { estimatedIn: at(150) });
    expect(nextMinutes(early)).toBe(150);
    expect(early.tier).toBe('post_arrival');
  });

  it('stops at the hard lifetime', () => {
    // Lifetime min(in + 6 h, off + 2 x block) = 360; the in-flight grid from out lands on it.
    expect(nextMinutes(decide(CADENCE_A2, 340, { phase: 'en_route', actualIn: undefined }))).toBe(
      360,
    );
    expect(
      refreshIntervalFor(CADENCE_A2, ctx(360, { phase: 'en_route', actualIn: undefined })),
    ).toBeNull();
    // Out at +50 anchors the grid (+50, +80, ... +410); off at +60 moves the lifetime to 420.
    const lateOff = {
      phase: 'en_route' as const,
      actualOut: at(50),
      actualOff: at(60),
      actualIn: undefined,
    };
    expect(nextMinutes(decide(CADENCE_A2, 400, lateOff))).toBe(410);
    expect(refreshIntervalFor(CADENCE_A2, ctx(410, lateOff))).toBeNull();
  });

  it('honours custom boarding and stop parameters', () => {
    const params = { boardingMinutesBefore: 30, postArrivalStopMinutes: 60 };
    // A1 still opens its in-flight grid at boarding; A2 no longer does (N8).
    const d = refreshIntervalFor(CADENCE_A1, ctx(-45), params);
    expect(d !== null && [nextMinutes(d), d.tier]).toEqual([-30, 'in_flight']);
    expect(refreshIntervalFor(CADENCE_A2, ctx(240), params)).toBeNull();
  });
});

describe('maxLifetime', () => {
  it('is min(scheduledIn + 6 h, actualOff + 2 x block)', () => {
    expect(maxLifetime(scheduledIn, undefined, BLOCK)).toEqual(at(BLOCK + 360));
    expect(maxLifetime(scheduledIn, scheduledOut, BLOCK)).toEqual(at(360));
    expect(maxLifetime(scheduledIn, at(120), BLOCK)).toEqual(at(480));
    expect(maxLifetime(scheduledIn, at(240), BLOCK)).toEqual(at(540));
    expect(maxLifetime(scheduledIn, scheduledOut, 60)).toEqual(at(120));
  });

  it('is exported under the plan name too', () => {
    expect(MAX_LIFETIME).toBe(maxLifetime);
  });
});

describe('expectedCalls', () => {
  it('per-window polls inside 48 h reproduce the plan table', () => {
    const polls = (c: CadenceDefinition): number[] =>
      expectedCalls(c, { leadTimeDays: 2 }).byWindow.map((w) => w.polls);
    expect(polls(CADENCE_LITERAL)).toEqual([0, 45, 14, 110, 12]);
    expect(polls(CADENCE_A1)).toEqual([0, 42, 22, 15, 5]);
    // N8: 24 + 6 around the departure anchor instead of 22 + 8 around boarding; still 74.
    expect(polls(CADENCE_A2)).toEqual([0, 42, 24, 6, 2]);
    expect(polls(CADENCE_B)).toEqual([0, 1, 1, 1, 2]);
  });

  it('exposes the poll instants the counts are made of, the creation fetch first', () => {
    const a1 = expectedCalls(CADENCE_A1, { leadTimeDays: 2 });
    expect(a1.pollInstants).toHaveLength(a1.polls + a1.adbCalls);
    expect(a1.pollInstants[0]).toBe(-hours(48));
    expect(a1.pollInstants.filter((m) => m >= BLOCK)).toEqual([
      BLOCK,
      BLOCK + 15,
      BLOCK + 30,
      BLOCK + 45,
      BLOCK + 120,
    ]);
    const lead30 = expectedCalls(CADENCE_A2, { leadTimeDays: 30 });
    expect(lead30.pollInstants.slice(0, 5)).toEqual([
      -days(30),
      -days(23),
      -days(16),
      -days(9),
      -hours(48),
    ]);
    expect(lead30.pollInstants).toHaveLength(lead30.polls + lead30.adbCalls);
    for (const cadence of CADENCES) {
      const { pollInstants } = expectedCalls(cadence, { leadTimeDays: 14 });
      expect(pollGaps(pollInstants).every((g) => g.toMinutes > g.fromMinutes)).toBe(true);
    }
  });

  it('totals, poll-equivalents and list cost per cadence inside 48 h', () => {
    const a2 = expectedCalls(CADENCE_A2, { leadTimeDays: 2 });
    expect(a2).toMatchObject({
      polls: 74,
      alerts: 12,
      adbCalls: 0,
      adbUnits: 0,
      adbAlertItems: 0,
      pollEquivalents: 122,
      listCostUsdMicros: 610_000,
    });
    expect(expectedCalls(CADENCE_A1, { leadTimeDays: 2 })).toMatchObject({
      polls: 84,
      alerts: 0,
      pollEquivalents: 84,
      listCostUsdMicros: 420_000,
    });
    expect(expectedCalls(CADENCE_LITERAL, { leadTimeDays: 2 })).toMatchObject({
      polls: 181,
      pollEquivalents: 181,
      listCostUsdMicros: 905_000,
    });
    expect(expectedCalls(CADENCE_B, { leadTimeDays: 2 })).toMatchObject({
      polls: 5,
      alerts: 8,
      adbAlertItems: 15,
      adbUnits: 15,
      pollEquivalents: 37.75,
      listCostUsdMicros: 188_750,
    });
  });

  it('sums the AeroAPI windows into polls and the AeroDataBox windows into adbCalls', () => {
    for (const cadence of CADENCES) {
      for (const lead of [2, 3, 14, 30]) {
        const r = expectedCalls(cadence, { leadTimeDays: lead });
        const aeroapi = r.byWindow.filter((w) => w.source === 'aeroapi');
        const adb = r.byWindow.filter((w) => w.source === 'aerodatabox');
        expect(r.polls).toBe(aeroapi.reduce((sum, w) => sum + w.polls, 0));
        expect(r.adbCalls).toBe(adb.reduce((sum, w) => sum + w.polls, 0));
        expect(r.adbUnits).toBe(2 * r.adbCalls + r.adbAlertItems);
      }
    }
  });

  it('AeroDataBox calls by lead time (increment 6, weekly): 1 / 2 / 4 calls, 2 / 4 / 8 units', () => {
    // The creation fetch plus the weekly slots at T-9 d, T-16 d and T-23 d that follow it. The
    // plan's daily and 2-day grids gave 1 / 12 / 20.
    const byLead = [3, 14, 30].map((leadTimeDays) => expectedCalls(CADENCE_A2, { leadTimeDays }));
    expect(byLead.map((r) => r.adbCalls)).toEqual([1, 2, 4]);
    expect(byLead.map((r) => r.adbUnits)).toEqual([2, 4, 8]);
    expect(byLead.map((r) => r.polls)).toEqual([74, 74, 74]);
    expect(byLead.map((r) => r.pollEquivalents)).toEqual([122.1, 122.2, 122.4]);
    expect(byLead.map((r) => r.listCostUsdMicros)).toEqual([610_500, 611_000, 612_000]);
    expect(byLead.map((r) => r.byWindow.slice(0, 1).map((w) => w.polls))).toEqual([[1], [2], [4]]);
  });

  it('the pre-48 h share is the same for every cadence', () => {
    for (const lead of [3, 14, 30]) {
      const calls = CADENCES.map((c) => expectedCalls(c, { leadTimeDays: lead }).adbCalls);
      expect(new Set(calls).size).toBe(1);
    }
  });

  it('responds to the block, boarding and stop assumptions', () => {
    expect(expectedCalls(CADENCE_A2, { leadTimeDays: 2, blockMinutes: 120 }).polls).toBe(72);
    // A2 is anchored on departure since N8, so only A1 still responds to the boarding assumption.
    expect(expectedCalls(CADENCE_A2, { leadTimeDays: 2, boardingMinutesBefore: 30 }).polls).toBe(
      74,
    );
    expect(expectedCalls(CADENCE_A1, { leadTimeDays: 2, boardingMinutesBefore: 30 }).polls).toBe(
      83,
    );
    expect(expectedCalls(CADENCE_A2, { leadTimeDays: 2, postArrivalStopMinutes: 60 }).polls).toBe(
      73,
    );
    expect(expectedCalls(CADENCE_A2, { leadTimeDays: 1 }).polls).toBe(50);
    expect(expectedCalls(CADENCE_A2, { leadTimeDays: 2, blockMinutes: 180 })).toEqual(
      expectedCalls(CADENCE_A2, { leadTimeDays: 2 }),
    );
  });
});

describe('window helpers', () => {
  it('windowAt gives the boundary instant to the later window and the closing instant to the tail', () => {
    expect(windowAt(CADENCE_A2, ctx(-days(30)))?.tier).toBe('pre48h');
    expect(windowAt(CADENCE_A2, ctx(-days(14)))?.tier).toBe('pre48h');
    expect(windowAt(CADENCE_A2, ctx(-hours(48) - 1))?.tier).toBe('pre48h');
    expect(windowAt(CADENCE_A2, ctx(-hours(48)))?.tier).toBe('hourly');
    expect(windowAt(CADENCE_A2, ctx(-hours(6)))?.tier).toBe('pre_boarding');
    expect(windowAt(CADENCE_A2, ctx(-40))?.tier).toBe('pre_boarding');
    expect(windowAt(CADENCE_A2, ctx(-1))?.tier).toBe('pre_boarding');
    expect(windowAt(CADENCE_A2, ctx(0))?.tier).toBe('in_flight');
    expect(windowAt(CADENCE_A1, ctx(-40))?.tier).toBe('in_flight');
    expect(windowAt(CADENCE_A2, ctx(180))?.tier).toBe('post_arrival');
    expect(windowAt(CADENCE_A2, ctx(300))?.tier).toBe('post_arrival');
    expect(windowAt(CADENCE_A2, ctx(301))).toBeNull();
    expect(windowAt(CADENCE_A2, ctx(100, { phase: 'cancelled' }))).toBeNull();
  });

  it('nextSlot returns null once the schedule is exhausted', () => {
    expect(nextSlot(CADENCE_A2, ctx(240))).toBeNull();
    expect(nextSlot(CADENCE_A2, ctx(10, { phase: 'finished' }))).toBeNull();
    expect(nextSlot(CADENCE_A2, ctx(10))?.window.tier).toBe('in_flight');
  });

  it('resolveWindows drops the tail and opens the in-flight window while arrival is unobserved', () => {
    const normal = resolveWindows(CADENCE_A2, ctx(-60));
    expect(normal.windows).toHaveLength(5);
    expect(normal.windows[1]).toMatchObject({
      start: OUT - 48 * 60 * MINUTE_MS,
      end: OUT - 6 * 60 * MINUTE_MS,
    });
    expect(normal.windows[4]?.end).toBe(IN + 120 * MINUTE_MS);
    expect(normal.windows.some((w) => w.extended)).toBe(false);
    expect(normal.bounds).toEqual({
      scheduledOut: OUT,
      boarding: OUT - 40 * MINUTE_MS,
      departure: OUT,
      arrival: IN,
      stop: IN + 120 * MINUTE_MS,
    });
    const late = resolveWindows(CADENCE_A2, ctx(200, { phase: 'en_route', actualIn: undefined }));
    expect(late.windows).toHaveLength(4);
    expect(late.windows[3]?.window.tier).toBe('in_flight');
    expect(late.windows[3]?.end).toBe(Number.POSITIVE_INFINITY);
    expect(late.windows[3]?.extended).toBe(true);
    expect(resolveWindows(CADENCE_A2, ctx(10, { phase: 'cancelled' })).windows).toEqual([]);
  });

  it('slotCount ceils start-anchored windows and floors end-anchored ones', () => {
    const base = {
      tier: 'in_flight' as const,
      from: 'boarding' as const,
      to: 'arrival' as const,
      source: 'aeroapi' as const,
      alerts: true,
    };
    expect(slotCount({ ...base, intervalMinutes: 30 }, 0, 220 * MINUTE_MS)).toBe(8);
    expect(slotCount({ ...base, intervalMinutes: 15 }, 0, 220 * MINUTE_MS)).toBe(15);
    expect(slotCount({ ...base, intervalMinutes: 60 }, 0, 120 * MINUTE_MS)).toBe(2);
    expect(slotCount({ ...base, intervalMinutes: 60 }, 0, 61 * MINUTE_MS)).toBe(2);
    expect(slotCount({ ...base, intervalMinutes: 60 }, 0, 60 * MINUTE_MS)).toBe(1);
    expect(slotCount({ ...base, intervalMinutes: 15 }, 0, 320 * MINUTE_MS)).toBe(22);
    expect(slotCount({ ...base, intervalMinutes: days(1), anchor: 'end' }, 0, 12.9 * DAY_MS)).toBe(
      12,
    );
    expect(slotCount({ ...base, intervalMinutes: days(2), anchor: 'end' }, 0, 16 * DAY_MS)).toBe(8);
    expect(slotCount({ ...base, intervalMinutes: 60 }, Number.NEGATIVE_INFINITY, 0)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it('rejects a fixed-slot in-flight window with no late-flight interval, only once it is needed', () => {
    const noLateInterval: CadenceDefinition = {
      ...CADENCE_B,
      windows: CADENCE_B.windows.map((w) =>
        w.tier === 'in_flight' && !isIntervalWindow(w)
          ? {
              tier: w.tier,
              from: w.from,
              to: w.to,
              slots: w.slots,
              source: w.source,
              alerts: w.alerts,
            }
          : w,
      ),
    };
    expect(nextMinutes(decide(noLateInterval, 100))).toBe(195);
    expect(() =>
      refreshIntervalFor(noLateInterval, ctx(200, { phase: 'en_route', actualIn: undefined })),
    ).toThrow(CadenceError);
  });

  it('rejects windows whose anchor has no finite edge', () => {
    const unboundedStart: CadenceDefinition = {
      id: 'A2',
      label: 'broken',
      windows: [
        {
          tier: 'hourly',
          from: Number.POSITIVE_INFINITY,
          to: 'stop',
          intervalMinutes: 60,
          source: 'aeroapi',
          alerts: false,
        },
      ],
      aeroapiAlerts: null,
      aerodataboxAlerts: null,
    };
    expect(() => refreshIntervalFor(unboundedStart, ctx(-hours(10)))).toThrow(CadenceError);
    const endAnchoredInFlight: CadenceDefinition = {
      ...CADENCE_A2,
      windows: CADENCE_A2.windows.map((w) =>
        w.tier === 'in_flight' && isIntervalWindow(w) ? { ...w, anchor: 'end' } : w,
      ),
    };
    expect(() =>
      refreshIntervalFor(endAnchoredInFlight, ctx(200, { phase: 'en_route', actualIn: undefined })),
    ).toThrow(CadenceError);
  });
});

describe('N8: the 15-minute band anchored on departure', () => {
  /** A2 as it was before increment 15: the 30-minute band opened at boarding. */
  const A2_BOARDING_ANCHORED: CadenceDefinition = {
    ...CADENCE_A2,
    windows: CADENCE_A2.windows.map((w) =>
      w.to === 'departure'
        ? { ...w, to: 'boarding' }
        : w.from === 'departure'
          ? { ...w, from: 'boarding' }
          : w,
    ),
  };

  /** AeroAPI polls inside 48 h for a flight held D minutes on the ground (out and in both late). */
  function groundDelayPolls(cadence: CadenceDefinition, delay: number): number {
    const outAt = delay;
    const inAt = BLOCK + delay;
    const context = (m: number): CadenceContext => ({
      now: at(m),
      scheduledOut,
      scheduledIn,
      phase: m < outAt ? 'scheduled' : m < inAt ? 'en_route' : 'arrived',
      estimatedOut: at(outAt),
      estimatedIn: at(inAt),
      actualOut: m >= outAt ? at(outAt) : undefined,
      actualOff: m >= outAt ? at(outAt) : undefined,
      actualIn: m >= inAt ? at(inAt) : undefined,
    });
    let m = -hours(48);
    let polls = 1; // the creation fetch at T-48 h
    for (let i = 0; i < 500; i += 1) {
      const decision = refreshIntervalFor(cadence, context(m));
      if (decision === null) {
        return polls;
      }
      m = nextMinutes(decision);
      polls += 1;
    }
    throw new Error('the walk did not finish');
  }

  it('resolves the anchor: actual out, else actual off, else the later of scheduled and estimated out', () => {
    const departure = (overrides: Partial<CadenceContext>): number =>
      (resolveWindows(CADENCE_A2, ctx(-120, overrides)).bounds.departure - OUT) / MINUTE_MS;
    expect(departure({})).toBe(0);
    expect(departure({ estimatedOut: at(45) })).toBe(45);
    expect(departure({ estimatedOut: at(-10) })).toBe(0);
    expect(departure({ estimatedOut: at(45), actualOut: at(30) })).toBe(30);
    expect(departure({ actualOut: at(-5) })).toBe(-5);
    // Review ruling Q7: runway times only (no actual out) anchor on actual off.
    expect(departure({ estimatedOut: at(45), actualOff: at(20) })).toBe(20);
    expect(departure({ actualOff: at(10) })).toBe(10);
    expect(departure({ actualOut: at(5), actualOff: at(20) })).toBe(5);
  });

  it('keeps 15-minute polls through a ground delay, then 30 from out', () => {
    const held = { phase: 'boarding' as const, estimatedOut: at(60), estimatedIn: at(240) };
    const onHold = decide(CADENCE_A2, 15, { ...held, actualOut: undefined, actualOff: undefined });
    expect([nextMinutes(onHold), onHold.tier, onHold.nominalIntervalMinutes]).toEqual([
      30,
      'pre_boarding',
      15,
    ]);
    const opening = decide(CADENCE_A2, 45, { ...held, actualOut: undefined, actualOff: undefined });
    expect([nextMinutes(opening), opening.tier]).toEqual([60, 'in_flight']);
    const airborne = decide(CADENCE_A2, 60, { ...held, phase: 'en_route', actualOut: at(60) });
    expect([nextMinutes(airborne), airborne.tier]).toEqual([90, 'in_flight']);
  });

  it('keeps 74 polls on time and costs about D/30 more on a D-minute ground delay', () => {
    expect(groundDelayPolls(CADENCE_A2, 0)).toBe(A2_EXPECTED_POLLS);
    expect(A2_EXPECTED_POLLS).toBe(74);
    expect(groundDelayPolls(A2_BOARDING_ANCHORED, 0)).toBe(74);
    expect(groundDelayPolls(CADENCE_A2, 60)).toBe(78);
    expect(groundDelayPolls(A2_BOARDING_ANCHORED, 60)).toBe(76);
    expect(groundDelayPolls(CADENCE_A2, 120)).toBe(82);
    expect(groundDelayPolls(A2_BOARDING_ANCHORED, 120)).toBe(78);
    for (const delay of [15, 30, 45, 90, 180]) {
      const extra =
        groundDelayPolls(CADENCE_A2, delay) - groundDelayPolls(A2_BOARDING_ANCHORED, delay);
      expect(Math.abs(extra - delay / 30)).toBeLessThanOrEqual(1);
    }
  });
});
