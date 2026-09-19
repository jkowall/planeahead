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

const TIER_ORDER: CadenceTier[] = [
  'pre48h_far',
  'pre48h_near',
  'hourly',
  'pre_boarding',
  'in_flight',
  'post_arrival',
];

describe('derived constants', () => {
  it('reproduce the plan: A2 72 polls, 12 alerts, 120 PE; A1 83; literal 181; B 5', () => {
    expect(A2_EXPECTED_POLLS).toBe(72);
    expect(A2_EXPECTED_ALERTS).toBe(12);
    expect(ASSUMED_ALERTS_PER_FLIGHT).toBe(12);
    expect(A2_EXPECTED_PE).toBe(120);
    expect(A2_SOFT_CAP_PE).toBe(240);
    expect(A2_HARD_CAP_PE).toBe(480);
    expect(A1_EXPECTED_POLLS).toBe(83);
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
      expect(cadence.windows.slice(0, 2)).toEqual(PRE_48H_WINDOWS);
      expect(cadence.windows[0]?.from).toBe(Number.POSITIVE_INFINITY);
      expect(cadence.windows[cadence.windows.length - 1]?.to).toBe('stop');
      for (let i = 1; i < cadence.windows.length; i += 1) {
        expect(cadence.windows[i]?.from).toEqual(cadence.windows[i - 1]?.to);
      }
      for (const window of cadence.windows) {
        const pre48h = window.tier === 'pre48h_far' || window.tier === 'pre48h_near';
        expect(window.source).toBe(pre48h ? 'aerodatabox' : 'aeroapi');
        expect(window.alerts).toBe(pre48h ? false : cadence.aeroapiAlerts !== null);
      }
    },
  );

  it('pre-48 h rules: daily inside 14 d, every 2 d beyond, end-anchored on T-48 h', () => {
    expect(PRE_48H_WINDOWS.map((w) => [w.from, w.to, w.intervalMinutes, w.anchor])).toEqual([
      [Number.POSITIVE_INFINITY, days(14), days(2), 'end'],
      [days(14), hours(48), days(1), 'end'],
    ]);
  });

  it('A2 keeps the plan intervals: hourly, 15, 30, 60; A1: hourly, 15, 15, then fixed slots', () => {
    const intervals = (c: CadenceDefinition): (number | null)[] =>
      c.windows.slice(2).map((w) => (isIntervalWindow(w) ? w.intervalMinutes : null));
    expect(intervals(CADENCE_A2)).toEqual([60, 15, 30, 60]);
    expect(intervals(CADENCE_A1)).toEqual([60, 15, 15, null]);
    expect(intervals(CADENCE_LITERAL)).toEqual([60, 10, 2, 10]);
    expect(intervals(CADENCE_B)).toEqual([null, null, null, null]);
    expect(CADENCE_LITERAL.windows[2]?.to).toBe(hours(3));
    expect(CADENCE_A2.windows[2]?.to).toBe(hours(6));
  });

  it('A1 tail is fixed slots at in+0, in+15, in+30, in+45 and a final poll at in+120 (R2, revised)', () => {
    const tail = CADENCE_A1.windows[5];
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
    const inFlight = CADENCE_B.windows[4];
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
    expect(summary(CADENCE_LITERAL)).toEqual([['6h_to_3h', 60, 15]]);
    expect(summary(CADENCE_A1)).toEqual([
      ['3h_to_arrival', 20, 15],
      ['post_arrival', 75, 15],
    ]);
    expect(summary(CADENCE_A2)).toEqual([
      ['3h_to_arrival', 40, 15],
      ['post_arrival', 60, 15],
    ]);
    expect(summary(CADENCE_B)).toEqual([
      ['48h_to_6h', hours(45), 60],
      ['6h_to_3h', hours(45), 15],
      ['3h_to_arrival', 195, 15],
      ['post_arrival', 180, 15],
    ]);
  });

  it('holds the literal hourly polls to the 6 h to 3 h target they run into', () => {
    // A lookup by tier name mapped `hourly` to `48h_to_6h` only and reported no relaxation.
    const [hourly] = sloRelaxations(CADENCE_LITERAL);
    expect(hourly).toMatchObject({ sloWindow: '6h_to_3h', tiers: ['hourly'], alerts: false });
    expect(hourly?.relaxedLegs).toEqual([
      { fromMinutes: -hours(6), toMinutes: -hours(5) },
      { fromMinutes: -hours(5), toMinutes: -hours(4) },
      { fromMinutes: -hours(4), toMinutes: -hours(3) },
    ]);
    expect(sloRelaxations(CADENCE_A2).map((r) => [r.tiers, r.alerts])).toEqual([
      [['pre_boarding', 'in_flight'], true],
      [['post_arrival'], true],
    ]);
  });

  it('charges a gap that crosses an SLO boundary to both windows (R10)', () => {
    // B polls at T-48 h and then at T-3 h: the 45 h between them cross T-6 h, so the 48 h to
    // 6 h and the 6 h to 3 h windows both carry that gap. Measuring each cadence window from
    // its own start edge reported 42 h and 3 h instead.
    const [hourly, preBoarding, inFlight, tail] = sloRelaxations(CADENCE_B);
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
    expect(sloRelaxations(CADENCE_LITERAL).map((r) => r.sloWindow)).toEqual(['6h_to_3h']);
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

  it('surfaces the 20-minute hole the round() slot rule leaves before boarding on A1', () => {
    // 320 minutes of 15-minute slots round to 21, so the last pre-boarding poll is at T-60 and
    // the in-flight grid opens at T-40. Alerts cover it on A2; on A1 it is a real relaxation.
    const [preBoarding] = sloRelaxations(CADENCE_A1);
    expect(preBoarding).toMatchObject({
      sloWindow: '3h_to_arrival',
      tiers: ['pre_boarding', 'in_flight'],
      alerts: false,
      maxGapMinutes: 20,
    });
    expect(preBoarding?.relaxedLegs).toEqual([{ fromMinutes: -60, toMinutes: -40 }]);
  });

  it('measures the hole across the landing instant from the simulated polls (R2, R10)', () => {
    const across = (c: CadenceDefinition): [number, number] | null => {
      const gap = gapAcross(expectedCalls(c, { leadTimeDays: 2 }).pollInstants, BLOCK);
      return gap === null ? null : [gap.fromMinutes, gap.toMinutes];
    };
    // Before R2 was revised, A1's first tail slot at in+15 left 25 minutes from the in-10 poll.
    expect(across(CADENCE_A1)).toEqual([BLOCK - 10, BLOCK]);
    expect(across(CADENCE_A2)).toEqual([BLOCK - 40, BLOCK]);
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

  it('never flags the pre-48 h grids: the daily and 2-day polls sit exactly on their targets', () => {
    expect(SLO_REPORT_LEAD_TIME_DAYS).toBe(30);
    for (const cadence of CADENCES) {
      const flagged = sloRelaxations(cadence, { leadTimeDays: SLO_REPORT_LEAD_TIME_DAYS }).map(
        (r) => r.sloWindow,
      );
      expect(flagged).not.toContain('beyond_7d');
      expect(flagged).not.toContain('7d_to_48h');
      expect(sloRelaxations(cadence, { leadTimeDays: 2 })).toEqual(sloRelaxations(cadence));
    }
  });
});

describe('refreshIntervalFor (A2 unless stated)', () => {
  it('polls AeroDataBox every 2 days beyond 14 d, counting back from T-48 h', () => {
    const d = decide(CADENCE_A2, -days(30));
    expect(nextMinutes(d)).toBe(-days(28));
    expect(d.intervalMs).toBe(2 * DAY_MS);
    expect(d.source).toBe('aerodatabox');
    expect(d.tier).toBe('pre48h_far');
    expect(d.nominalIntervalMinutes).toBe(days(2));
    expect(d.alerts).toBe(false);
    expect(nextMinutes(decide(CADENCE_A2, -days(16)))).toBe(-days(14));
  });

  it('polls AeroDataBox daily inside 14 d', () => {
    const d = decide(CADENCE_A2, -days(14));
    expect(nextMinutes(d)).toBe(-days(13));
    expect(d.tier).toBe('pre48h_near');
    expect(d.source).toBe('aerodatabox');
    expect(nextMinutes(decide(CADENCE_A2, -days(13.5)))).toBe(-days(13));
    expect(nextMinutes(decide(CADENCE_A2, -days(4)))).toBe(-days(3));
  });

  it('makes T-48 h the first AeroAPI poll: nothing else fires between T-3 d and T-48 h', () => {
    for (const minutes of [-days(3), -hours(60), -hours(49)]) {
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

  it('switches to the in-flight interval at boarding', () => {
    const d = decide(CADENCE_A2, -60);
    expect(nextMinutes(d)).toBe(-40);
    expect(d.tier).toBe('in_flight');
    expect(d.nominalIntervalMinutes).toBe(30);
    expect(d.intervalMs).toBe(20 * MINUTE_MS);
    expect(nextMinutes(decide(CADENCE_A2, -40))).toBe(-10);
    expect(nextMinutes(decide(CADENCE_A2, -10))).toBe(20);
    expect(nextMinutes(decide(CADENCE_A2, 140))).toBe(180);
    expect(decide(CADENCE_A2, 140).tier).toBe('post_arrival');
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
    expect(nextMinutes(late)).toBe(230);
    expect(late.tier).toBe('in_flight');
    const landed = decide(CADENCE_A2, 200, {
      phase: 'landed',
      actualOn: at(190),
      actualIn: undefined,
    });
    expect(landed.tier).toBe('in_flight');
    expect(nextMinutes(landed)).toBe(230);
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
    expect(nextMinutes(d)).toBe(170);
    expect(d.tier).toBe('in_flight');
    const early = decide(CADENCE_A2, 140, { estimatedIn: at(150) });
    expect(nextMinutes(early)).toBe(150);
    expect(early.tier).toBe('post_arrival');
  });

  it('stops at the hard lifetime', () => {
    expect(nextMinutes(decide(CADENCE_A2, 340, { phase: 'en_route', actualIn: undefined }))).toBe(
      350,
    );
    expect(
      refreshIntervalFor(CADENCE_A2, ctx(350, { phase: 'en_route', actualIn: undefined })),
    ).toBeNull();
    const lateOff = { phase: 'en_route' as const, actualOff: at(60), actualIn: undefined };
    expect(nextMinutes(decide(CADENCE_A2, 400, lateOff))).toBe(410);
    expect(refreshIntervalFor(CADENCE_A2, ctx(410, lateOff))).toBeNull();
  });

  it('honours custom boarding and stop parameters', () => {
    const params = { boardingMinutesBefore: 30, postArrivalStopMinutes: 60 };
    const d = refreshIntervalFor(CADENCE_A2, ctx(-45), params);
    expect(d !== null && nextMinutes(d)).toBe(-30);
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
    expect(polls(CADENCE_LITERAL)).toEqual([0, 0, 45, 14, 110, 12]);
    expect(polls(CADENCE_A1)).toEqual([0, 0, 42, 21, 15, 5]);
    expect(polls(CADENCE_A2)).toEqual([0, 0, 42, 21, 7, 2]);
    expect(polls(CADENCE_B)).toEqual([0, 0, 1, 1, 1, 2]);
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
    expect(lead30.pollInstants.slice(0, 3)).toEqual([-days(30), -days(28), -days(26)]);
    expect(lead30.pollInstants).toHaveLength(lead30.polls + lead30.adbCalls);
    for (const cadence of CADENCES) {
      const { pollInstants } = expectedCalls(cadence, { leadTimeDays: 14 });
      expect(pollGaps(pollInstants).every((g) => g.toMinutes > g.fromMinutes)).toBe(true);
    }
  });

  it('totals, poll-equivalents and list cost per cadence inside 48 h', () => {
    const a2 = expectedCalls(CADENCE_A2, { leadTimeDays: 2 });
    expect(a2).toMatchObject({
      polls: 72,
      alerts: 12,
      adbCalls: 0,
      adbUnits: 0,
      adbAlertItems: 0,
      pollEquivalents: 120,
      listCostUsdMicros: 600_000,
    });
    expect(expectedCalls(CADENCE_A1, { leadTimeDays: 2 })).toMatchObject({
      polls: 83,
      alerts: 0,
      pollEquivalents: 83,
      listCostUsdMicros: 415_000,
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

  it('AeroDataBox calls by lead time: 1 / 12 / 20 calls, 2 / 24 / 40 units', () => {
    const byLead = [3, 14, 30].map((leadTimeDays) => expectedCalls(CADENCE_A2, { leadTimeDays }));
    expect(byLead.map((r) => r.adbCalls)).toEqual([1, 12, 20]);
    expect(byLead.map((r) => r.adbUnits)).toEqual([2, 24, 40]);
    expect(byLead.map((r) => r.polls)).toEqual([72, 72, 72]);
    expect(byLead.map((r) => r.pollEquivalents)).toEqual([120.1, 121.2, 122]);
    expect(byLead.map((r) => r.listCostUsdMicros)).toEqual([600_500, 606_000, 610_000]);
    expect(byLead.map((r) => r.byWindow.slice(0, 2).map((w) => w.polls))).toEqual([
      [0, 1],
      [0, 12],
      [8, 12],
    ]);
  });

  it('the pre-48 h share is the same for every cadence', () => {
    for (const lead of [3, 14, 30]) {
      const calls = CADENCES.map((c) => expectedCalls(c, { leadTimeDays: lead }).adbCalls);
      expect(new Set(calls).size).toBe(1);
    }
  });

  it('responds to the block, boarding and stop assumptions', () => {
    expect(expectedCalls(CADENCE_A2, { leadTimeDays: 2, blockMinutes: 120 }).polls).toBe(70);
    expect(expectedCalls(CADENCE_A2, { leadTimeDays: 2, boardingMinutesBefore: 30 }).polls).toBe(
      73,
    );
    expect(expectedCalls(CADENCE_A2, { leadTimeDays: 2, postArrivalStopMinutes: 60 }).polls).toBe(
      71,
    );
    expect(expectedCalls(CADENCE_A2, { leadTimeDays: 1 }).polls).toBe(48);
    expect(expectedCalls(CADENCE_A2, { leadTimeDays: 2, blockMinutes: 180 })).toEqual(
      expectedCalls(CADENCE_A2, { leadTimeDays: 2 }),
    );
  });
});

describe('window helpers', () => {
  it('windowAt gives the boundary instant to the later window and the closing instant to the tail', () => {
    expect(windowAt(CADENCE_A2, ctx(-days(30)))?.tier).toBe('pre48h_far');
    expect(windowAt(CADENCE_A2, ctx(-days(14)))?.tier).toBe('pre48h_near');
    expect(windowAt(CADENCE_A2, ctx(-hours(48) - 1))?.tier).toBe('pre48h_near');
    expect(windowAt(CADENCE_A2, ctx(-hours(48)))?.tier).toBe('hourly');
    expect(windowAt(CADENCE_A2, ctx(-hours(6)))?.tier).toBe('pre_boarding');
    expect(windowAt(CADENCE_A2, ctx(-40))?.tier).toBe('in_flight');
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
    expect(normal.windows).toHaveLength(6);
    expect(normal.windows[2]).toMatchObject({
      start: OUT - 48 * 60 * MINUTE_MS,
      end: OUT - 6 * 60 * MINUTE_MS,
    });
    expect(normal.windows[5]?.end).toBe(IN + 120 * MINUTE_MS);
    expect(normal.windows.some((w) => w.extended)).toBe(false);
    expect(normal.bounds).toEqual({
      scheduledOut: OUT,
      boarding: OUT - 40 * MINUTE_MS,
      arrival: IN,
      stop: IN + 120 * MINUTE_MS,
    });
    const late = resolveWindows(CADENCE_A2, ctx(200, { phase: 'en_route', actualIn: undefined }));
    expect(late.windows).toHaveLength(5);
    expect(late.windows[4]?.window.tier).toBe('in_flight');
    expect(late.windows[4]?.end).toBe(Number.POSITIVE_INFINITY);
    expect(late.windows[4]?.extended).toBe(true);
    expect(resolveWindows(CADENCE_A2, ctx(10, { phase: 'cancelled' })).windows).toEqual([]);
  });

  it('slotCount rounds start-anchored windows and floors end-anchored ones', () => {
    const base = {
      tier: 'in_flight' as const,
      from: 'boarding' as const,
      to: 'arrival' as const,
      source: 'aeroapi' as const,
      alerts: true,
    };
    expect(slotCount({ ...base, intervalMinutes: 30 }, 0, 220 * MINUTE_MS)).toBe(7);
    expect(slotCount({ ...base, intervalMinutes: 15 }, 0, 220 * MINUTE_MS)).toBe(15);
    expect(slotCount({ ...base, intervalMinutes: 60 }, 0, 120 * MINUTE_MS)).toBe(2);
    expect(slotCount({ ...base, intervalMinutes: 60 }, 0, 89 * MINUTE_MS)).toBe(1);
    expect(slotCount({ ...base, intervalMinutes: 60 }, 0, 90 * MINUTE_MS)).toBe(2);
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
