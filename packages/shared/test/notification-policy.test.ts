import { describe, expect, it } from 'vitest';
import type { FlightStatus, FlightStatusValue } from '../src/flight-status';
import {
  evaluatePolicy,
  evaluateReread,
  initialPolicyState,
  POLICY_STATE_VERSION,
  readPolicyState,
  type PolicyIntent,
  type PolicyResult,
  type PolicyState,
} from '../src/notification-policy';
import { makeStatus } from './fixtures';

/**
 * Policy table tests (increment 15, N2 to N6). Every row walks one flight (AA100, scheduled out
 * 03:50Z, scheduled in 10:50Z) through a sequence of observations and compares the intents.
 */

const MIN = 60_000;
const OUT = Date.parse('2026-09-20T03:50:00Z');
const IN = Date.parse('2026-09-20T10:50:00Z');
/** Minutes after scheduled out, as epoch milliseconds. */
const t = (minutes: number): number => OUT + minutes * MIN;
const iso = (ms: number): string => new Date(ms).toISOString();

/** A snapshot by its delays and actuals, in minutes (departure ones from scheduled out). */
interface Shape {
  status?: FlightStatusValue;
  delay?: number;
  arrival?: number;
  out?: number;
  off?: number;
  in?: number;
  originGate?: string;
  destinationGate?: string;
  actualDestination?: string;
}

function snap(shape: Shape = {}): FlightStatus {
  const times: Record<string, string> = { scheduledOut: iso(OUT), scheduledIn: iso(IN) };
  const set = (field: string, value: number | undefined, base: number): void => {
    if (value !== undefined) {
      times[field] = iso(base + value * MIN);
    }
  };
  set('estimatedOut', shape.delay, OUT);
  set('estimatedIn', shape.arrival, IN);
  set('actualOut', shape.out, OUT);
  set('actualOff', shape.off, OUT);
  set('actualIn', shape.in, IN);
  const { originGate, destinationGate, actualDestination } = shape;
  return makeStatus({
    status: shape.status ?? 'scheduled',
    times,
    ...(originGate === undefined ? {} : { originGate }),
    ...(destinationGate === undefined ? {} : { destinationGate }),
    ...(actualDestination === undefined ? {} : { actualDestination: { icao: actualDestination } }),
  });
}

/** One observation: when, what it shows, and whether it is the re-read or an injection. */
interface Step {
  at: number;
  shape: Shape;
  reread?: boolean;
  confirmed?: boolean;
}

interface Walk {
  intents: (PolicyIntent & { at: number })[];
  last: PolicyResult;
  state: PolicyState;
}

/** Seeds the state from `start`, then evaluates every step against the snapshot before it. */
function walk(start: Shape, steps: Step[]): Walk {
  let previous = snap(start);
  let state = initialPolicyState(previous);
  const intents: Walk['intents'] = [];
  let last: PolicyResult = { intents: [], state, wants: null };
  for (const step of steps) {
    const next = snap(step.shape);
    const input = { previous, next, state, now: step.at, context: { confirmed: step.confirmed } };
    last = step.reread === true ? evaluateReread(input) : evaluatePolicy(input);
    intents.push(...last.intents.map((intent) => ({ ...intent, at: step.at })));
    ({ state } = last);
    previous = next;
  }
  return { intents, last, state };
}

/** The fields a row asserts: `kind subject value`, plus flags when set. */
function summary(intent: PolicyIntent): string {
  const flags = [intent.correction ? 'correction' : '', intent.firstAssignment ? 'first' : ''];
  return [intent.kind, intent.subject, intent.value, ...flags.filter(Boolean)].join(' ');
}

describe('N2 the departure delay line and its settle re-read', () => {
  it.each<[string, Step[], string[]]>([
    ['under the line: nothing', [{ at: t(-120), shape: { delay: 14 } }], []],
    [
      'reaching the line records a pending delay and pushes nothing yet',
      [{ at: t(-120), shape: { delay: 15 } }],
      [],
    ],
    [
      'the settle re-read still at or over the line pushes the re-read value',
      [
        { at: t(-120), shape: { delay: 20 } },
        { at: t(-115), shape: { delay: 25 }, reread: true },
      ],
      ['delay departure 25'],
    ],
    [
      'the settle re-read back under the line clears the pending delay',
      [
        { at: t(-120), shape: { delay: 20 } },
        { at: t(-115), shape: { delay: 10 }, reread: true },
        { at: t(-100), shape: { delay: 10 } },
      ],
      [],
    ],
    [
      'an ordinary observation before the re-read leaves the delay pending',
      [
        { at: t(-120), shape: { delay: 20 } },
        { at: t(-118), shape: { delay: 40 } },
      ],
      [],
    ],
    [
      'after a cleared settle, the line again starts a new settle',
      [
        { at: t(-120), shape: { delay: 20 } },
        { at: t(-115), shape: { delay: 5 }, reread: true },
        { at: t(-90), shape: { delay: 30 } },
        { at: t(-85), shape: { delay: 30 }, reread: true },
      ],
      ['delay departure 30'],
    ],
    [
      'an injected snapshot is confirmed by construction: no settle',
      [{ at: t(-120), shape: { delay: 20 }, confirmed: true }],
      ['delay departure 20'],
    ],
  ])('%s', (_name, steps, expected) => {
    expect(walk({}, steps).intents.map(summary)).toEqual(expected);
  });

  it('asks for the settle re-read no later than 5 minutes after the line', () => {
    const { last } = walk({}, [{ at: t(-120), shape: { delay: 20 } }]);
    expect(last.wants).toEqual({ at: t(-115), reasons: ['settle'] });
    expect(last.state.delay.pending).toEqual({ since: t(-120), settleAt: t(-115), settled: false });
  });

  it('a settle re-read that cannot measure the delay clears it instead of asking again', () => {
    const { state } = walk({}, [{ at: t(-120), shape: { delay: 20 } }]);
    const unmeasurable = makeStatus({ times: { scheduledIn: iso(IN) } });
    const input = { previous: snap({ delay: 20 }), next: unmeasurable, state, now: t(-115) };
    const result = evaluateReread(input);
    expect(result.intents).toEqual([]);
    expect(result.state.delay.pending).toBeNull();
    expect(result.wants).toBeNull();
  });

  it('owes nothing once the settle is resolved', () => {
    const steps = [
      { at: t(-120), shape: { delay: 20 } },
      { at: t(-116), shape: { delay: 22 }, reread: true },
    ];
    expect(walk({}, steps).last.wants).toBeNull();
  });
});

describe('N2 after a pushed delay: moves, the rate limit and the correction', () => {
  /** A delay of 20 pushed at T-115 by its settle re-read. */
  const PUSHED_20: Step[] = [
    { at: t(-120), shape: { delay: 20 } },
    { at: t(-115), shape: { delay: 20 }, reread: true },
  ];
  it.each<[string, Step[], string[]]>([
    ['a move under 15 minutes: nothing', [{ at: t(-90), shape: { delay: 34 } }], []],
    [
      'a move of 15 minutes or more',
      [{ at: t(-90), shape: { delay: 35 } }],
      ['delay departure 35'],
    ],
    [
      'an improvement of 15 or more',
      [
        { at: t(-90), shape: { delay: 50 } },
        { at: t(-60), shape: { delay: 35 } },
      ],
      ['delay departure 50', 'delay departure 35'],
    ],
    [
      'moves are measured from the last pushed value, not the last seen',
      [
        { at: t(-90), shape: { delay: 30 } },
        { at: t(-80), shape: { delay: 36 } },
      ],
      ['delay departure 36'],
    ],
    [
      'back under 15: a correction',
      [{ at: t(-90), shape: { delay: 10 } }],
      ['delay departure 10 correction'],
    ],
    [
      'inside 15 minutes of the last delay intent: held back',
      [{ at: t(-105), shape: { delay: 60 } }],
      [],
    ],
    [
      'held back, then re-evaluated at the next observation after the window',
      [
        { at: t(-105), shape: { delay: 60 } },
        { at: t(-99), shape: { delay: 60 } },
      ],
      ['delay departure 60'],
    ],
    [
      'held back, then no longer a move: nothing',
      [
        { at: t(-105), shape: { delay: 60 } },
        { at: t(-99), shape: { delay: 25 } },
      ],
      [],
    ],
    [
      'a correction inside the window waits for the window too',
      [
        { at: t(-110), shape: { delay: 0 } },
        { at: t(-95), shape: { delay: 0 } },
      ],
      ['delay departure 0 correction'],
    ],
    [
      '20, then 10, then 20 again: a correction, then a new settle and push',
      [
        { at: t(-90), shape: { delay: 10 } },
        { at: t(-60), shape: { delay: 20 } },
        { at: t(-55), shape: { delay: 20 }, reread: true },
      ],
      ['delay departure 10 correction', 'delay departure 20'],
    ],
  ])('%s', (_name, steps, expected) => {
    const intents = walk({}, [...PUSHED_20, ...steps]).intents.map(summary);
    expect(intents).toEqual(['delay departure 20', ...expected]);
  });

  it('a settle the rate limit holds back is pushed at the next observation after the window', () => {
    const steps: Step[] = [
      ...PUSHED_20,
      { at: t(-100), shape: { delay: 5 } },
      { at: t(-99), shape: { delay: 30 } },
      { at: t(-95), shape: { delay: 30 }, reread: true },
      { at: t(-88), shape: { delay: 31 } },
      { at: t(-84), shape: { delay: 32 } },
    ];
    const { intents, last } = walk({}, steps);
    expect(intents.map((i) => [summary(i), i.at])).toEqual([
      ['delay departure 20', t(-115)],
      ['delay departure 5 correction', t(-100)],
      ['delay departure 32', t(-84)],
    ]);
    expect(last.state.delay).toMatchObject({
      pushedMinutes: 32,
      lastIntentAt: t(-84),
      pending: null,
    });
  });

  it('a delay present when the state is seeded is the baseline, not news', () => {
    const { intents } = walk({ delay: 40 }, [{ at: t(-90), shape: { delay: 50 } }]);
    expect(intents).toEqual([]);
    const later = walk({ delay: 40 }, [{ at: t(-90), shape: { delay: 55 } }]);
    expect(later.intents.map(summary)).toEqual(['delay departure 55']);
  });
});

describe('N2 arrival bands', () => {
  it.each<[string, Step[], string[]]>([
    [
      'an arrival delay inside the first band: nothing',
      [{ at: t(-60), shape: { arrival: 14 } }],
      [],
    ],
    [
      'an arrival delay crossing into a new band with no departure intent',
      [{ at: t(60), shape: { out: 0, off: 10, status: 'en_route', arrival: 20 } }],
      ['delay arrival 20'],
    ],
    [
      'a band the departure intent implied: nothing; the next band: an intent',
      [
        { at: t(-120), shape: { delay: 30, arrival: 30 } },
        { at: t(-115), shape: { delay: 30, arrival: 30 }, reread: true },
        { at: t(-90), shape: { delay: 30, arrival: 40 } },
        { at: t(-60), shape: { delay: 30, arrival: 45 } },
      ],
      ['delay departure 30', 'delay arrival 45'],
    ],
    [
      'the departure intent implies the arrival estimate it carried, not its own value',
      [
        { at: t(-120), shape: { delay: 20, arrival: 10 } },
        { at: t(-115), shape: { delay: 20, arrival: 10 }, reread: true },
        { at: t(-90), shape: { delay: 20, arrival: 12 } },
      ],
      ['delay departure 20'],
    ],
    [
      'back under the first band: a correction',
      [
        { at: t(60), shape: { out: 0, off: 10, status: 'en_route', arrival: 20 } },
        { at: t(90), shape: { out: 0, off: 10, status: 'en_route', arrival: 5 } },
      ],
      ['delay arrival 20', 'delay arrival 5 correction'],
    ],
    [
      'a pending departure delay holds the arrival rule until its settle',
      [
        { at: t(-120), shape: { delay: 20, arrival: 20 } },
        { at: t(-118), shape: { delay: 20, arrival: 20 } },
        { at: t(-115), shape: { delay: 20, arrival: 20 }, reread: true },
      ],
      ['delay departure 20'],
    ],
    [
      'one delay intent per 15 minutes covers arrival intents too',
      [
        { at: t(-120), shape: { delay: 20, arrival: 20 } },
        { at: t(-115), shape: { delay: 20, arrival: 20 }, reread: true },
        { at: t(-110), shape: { delay: 20, arrival: 31 } },
        { at: t(-100), shape: { delay: 20, arrival: 31 } },
      ],
      ['delay departure 20', 'delay arrival 31'],
    ],
  ])('%s', (_name, steps, expected) => {
    expect(walk({}, steps).intents.map(summary)).toEqual(expected);
  });
});

describe('N3 gates', () => {
  const B10 = { originGate: 'B10' } as const;
  const AIRBORNE = { out: 0, off: 10, status: 'en_route' } as const;
  it.each<[string, Shape, Step[], string[]]>([
    [
      'origin change before T-6 h: nothing',
      B10,
      [{ at: t(-361), shape: { originGate: 'B12' } }],
      [],
    ],
    [
      'origin change from T-6 h',
      B10,
      [{ at: t(-360), shape: { originGate: 'B12' } }],
      ['gate_change origin B12'],
    ],
    [
      'origin change after out: nothing',
      B10,
      [{ at: t(5), shape: { originGate: 'B12', out: 2, status: 'departed' } }],
      [],
    ],
    [
      'first origin assignment inside the window',
      {},
      [{ at: t(-90), shape: { originGate: 'B12' } }],
      ['gate_change origin B12 first'],
    ],
    [
      'first assignment outside the window, then a change inside it',
      {},
      [
        { at: t(-400), shape: { originGate: 'B12' } },
        { at: t(-90), shape: { originGate: 'C1' } },
      ],
      ['gate_change origin C1'],
    ],
    [
      'A to B to A seen by no evaluation: both dropped',
      B10,
      [{ at: t(-60), shape: { originGate: 'B10' } }],
      [],
    ],
    [
      'A to B pushed, back to A within 10 minutes: a correction',
      B10,
      [
        { at: t(-60), shape: { originGate: 'B12' } },
        { at: t(-50), shape: { originGate: 'B10' } },
      ],
      ['gate_change origin B12', 'gate_change origin B10 correction'],
    ],
    [
      'A to B pushed, back to A after 10 minutes: a plain change',
      B10,
      [
        { at: t(-60), shape: { originGate: 'B12' } },
        { at: t(-49), shape: { originGate: 'B10' } },
      ],
      ['gate_change origin B12', 'gate_change origin B10'],
    ],
    [
      'A to B to C: two plain changes',
      B10,
      [
        { at: t(-60), shape: { originGate: 'B12' } },
        { at: t(-55), shape: { originGate: 'C1' } },
      ],
      ['gate_change origin B12', 'gate_change origin C1'],
    ],
    [
      'a gate that disappears and comes back unchanged: nothing',
      B10,
      [
        { at: t(-60), shape: {} },
        { at: t(-45), shape: { originGate: 'B10' } },
      ],
      [],
    ],
    [
      'a gate that disappears and comes back changed: a change, not a first',
      B10,
      [
        { at: t(-60), shape: {} },
        { at: t(-45), shape: { originGate: 'B11' } },
      ],
      ['gate_change origin B11'],
    ],
    [
      'destination change before off: nothing',
      { destinationGate: 'D1' },
      [{ at: t(-30), shape: { destinationGate: 'D2' } }],
      [],
    ],
    [
      'destination change from off',
      { destinationGate: 'D1' },
      [{ at: t(60), shape: { ...AIRBORNE, destinationGate: 'D2' } }],
      ['gate_change destination D2'],
    ],
    [
      'first destination assignment from off',
      {},
      [{ at: t(60), shape: { ...AIRBORNE, destinationGate: 'D2' } }],
      ['gate_change destination D2 first'],
    ],
    [
      'destination change after in: nothing',
      { destinationGate: 'D1' },
      [{ at: t(430), shape: { ...AIRBORNE, in: 0, status: 'arrived', destinationGate: 'D2' } }],
      [],
    ],
  ])('%s', (_name, start, steps, expected) => {
    expect(walk(start, steps).intents.map(summary)).toEqual(expected);
  });

  it('names the gate it replaces and dedupes on side and gate', () => {
    const [intent] = walk(B10, [{ at: t(-60), shape: { originGate: 'B12' } }]).intents;
    expect(intent).toMatchObject({ previousValue: 'B10', dedupeValue: 'origin:B12' });
  });
});

describe('N4 cancellation and diversion', () => {
  const CANCELLED = { status: 'cancelled' } as const;
  const AIRBORNE = { out: 0, off: 10, status: 'en_route' } as const;
  const DIVERTED = { ...AIRBORNE, status: 'diverted', actualDestination: 'EINN' } as const;
  it.each<[string, Shape, Step[], string[]]>([
    [
      'a cancelled snapshot alone: suspected, nothing pushed',
      {},
      [{ at: t(-90), shape: CANCELLED }],
      [],
    ],
    [
      'suspected, then confirmed by the re-read',
      {},
      [
        { at: t(-90), shape: CANCELLED },
        { at: t(-85), shape: CANCELLED, reread: true },
      ],
      ['cancellation flight cancelled'],
    ],
    [
      'suspected, then cleared by the re-read',
      {},
      [
        { at: t(-90), shape: CANCELLED },
        { at: t(-85), shape: {}, reread: true },
        { at: t(-60), shape: {} },
      ],
      [],
    ],
    [
      'suspected: an ordinary observation neither confirms nor clears',
      {},
      [
        { at: t(-90), shape: CANCELLED },
        { at: t(-88), shape: CANCELLED },
        { at: t(-87), shape: {} },
      ],
      [],
    ],
    [
      'un-cancelled after a pushed cancellation: a correction',
      {},
      [
        { at: t(-90), shape: CANCELLED },
        { at: t(-85), shape: CANCELLED, reread: true },
        { at: t(-60), shape: {} },
      ],
      ['cancellation flight cancelled', 'cancellation flight uncancelled correction'],
    ],
    [
      'a pushed cancellation then an unknown status: nothing',
      {},
      [
        { at: t(-90), shape: CANCELLED },
        { at: t(-85), shape: CANCELLED, reread: true },
        { at: t(-60), shape: { status: 'unknown' } },
      ],
      ['cancellation flight cancelled'],
    ],
    [
      'an injected cancellation is confirmed by construction',
      {},
      [{ at: t(-90), shape: CANCELLED, confirmed: true }],
      ['cancellation flight cancelled'],
    ],
    [
      'while suspected, gate changes wait; cleared, they are pushed',
      { originGate: 'B10' },
      [
        { at: t(-90), shape: { ...CANCELLED, originGate: 'B12' } },
        { at: t(-85), shape: { originGate: 'B12' }, reread: true },
      ],
      ['gate_change origin B12'],
    ],
    ['a diversion alone: suspected, nothing pushed', {}, [{ at: t(120), shape: DIVERTED }], []],
    [
      'a diversion confirmed by the re-read',
      {},
      [
        { at: t(120), shape: DIVERTED },
        { at: t(125), shape: DIVERTED, reread: true },
      ],
      ['diversion flight EINN'],
    ],
    [
      'a diversion cleared by the re-read',
      {},
      [
        { at: t(120), shape: DIVERTED },
        { at: t(125), shape: AIRBORNE, reread: true },
      ],
      [],
    ],
    [
      'an actual destination other than planned is a diversion too',
      {},
      [
        { at: t(120), shape: { ...AIRBORNE, actualDestination: 'EINN' } },
        { at: t(124), shape: { ...AIRBORNE, actualDestination: 'EINN' }, reread: true },
      ],
      ['diversion flight EINN'],
    ],
    [
      'a bare diverted status, then the airport named: both pushed',
      {},
      [
        { at: t(120), shape: { ...AIRBORNE, status: 'diverted' } },
        { at: t(125), shape: { ...AIRBORNE, status: 'diverted' }, reread: true },
        { at: t(150), shape: DIVERTED },
        { at: t(155), shape: DIVERTED, reread: true },
      ],
      ['diversion flight diverted', 'diversion flight EINN'],
    ],
    [
      'a confirmed diversion is not pushed twice',
      {},
      [
        { at: t(120), shape: DIVERTED },
        { at: t(125), shape: DIVERTED, reread: true },
        { at: t(180), shape: DIVERTED },
      ],
      ['diversion flight EINN'],
    ],
    [
      'diverted: the planned destination gate is not pushed',
      { destinationGate: 'D1' },
      [
        { at: t(120), shape: { ...DIVERTED, destinationGate: 'D2' } },
        { at: t(125), shape: { ...DIVERTED, destinationGate: 'D3' }, reread: true },
      ],
      ['diversion flight EINN'],
    ],
  ])('%s', (_name, start, steps, expected) => {
    expect(walk(start, steps).intents.map(summary)).toEqual(expected);
  });

  it('a suspected cancellation keeps the tracker reading, never finishing on it', () => {
    const { last } = walk({}, [{ at: t(-90), shape: CANCELLED }]);
    expect(last.state.cancellation).toEqual({
      status: 'suspect',
      since: t(-90),
      value: 'cancelled',
    });
    expect(last.wants).toEqual({ at: t(-85), reasons: ['cancellation'] });
  });

  it('a suspected diversion asks for its confirming re-read', () => {
    const { last } = walk({}, [{ at: t(120), shape: DIVERTED }]);
    expect(last.wants).toEqual({ at: t(125), reasons: ['diversion'] });
  });
});

/** The first intent a walk produces. */
function first(start: Shape, steps: Step[]): PolicyIntent {
  const [intent] = walk(start, steps).intents;
  if (intent === undefined) {
    throw new Error('the walk produced no intent');
  }
  return intent;
}

const gateTo = (at: number, shape: Shape = {}): Step[] => [
  { at, shape: { ...shape, originGate: 'B12' } },
];

describe('N5 time-sensitive', () => {
  const AIRBORNE = { out: 0, off: 10, status: 'en_route' } as const;
  it.each<[string, Shape, Step[], boolean]>([
    [
      '61 minutes before the departure estimate: active',
      { originGate: 'B10' },
      gateTo(t(-61)),
      false,
    ],
    ['60 minutes before: time-sensitive', { originGate: 'B10' }, gateTo(t(-60)), true],
    ['held at the gate past the estimate, before out', { originGate: 'B10' }, gateTo(t(10)), true],
    [
      'measured from the best estimate: 90 minutes before a 60-minute delay is active',
      { originGate: 'B10', delay: 60 },
      gateTo(t(-30), { delay: 60 }),
      false,
    ],
    [
      'inside the hour before a delayed estimate',
      { originGate: 'B10', delay: 60 },
      gateTo(t(5), { delay: 60 }),
      true,
    ],
    [
      'after out: active',
      { destinationGate: 'D1' },
      [{ at: t(15), shape: { ...AIRBORNE, destinationGate: 'D2' } }],
      false,
    ],
    [
      'any kind: a cancellation inside the hour',
      {},
      [{ at: t(-30), shape: { status: 'cancelled' }, confirmed: true }],
      true,
    ],
    [
      'any kind: a delay outside the hour',
      {},
      [{ at: t(-120), shape: { delay: 20 }, confirmed: true }],
      false,
    ],
  ])('%s', (_name, start, steps, expected) => {
    expect(first(start, steps).timeSensitive).toBe(expected);
  });
});

describe('N6 expiresAt', () => {
  const AIRBORNE = { out: 0, off: 10, status: 'en_route' } as const;
  const H = 60;
  it.each<[string, Shape, Step[], number]>([
    ['origin gate: the departure estimate', { originGate: 'B10' }, gateTo(t(-90)), OUT],
    [
      'origin gate: a delayed departure estimate',
      { originGate: 'B10', delay: 60 },
      gateTo(t(-90), { delay: 60 }),
      t(60),
    ],
    [
      'destination gate: the arrival estimate',
      { destinationGate: 'D1' },
      [{ at: t(60), shape: { ...AIRBORNE, arrival: 20, destinationGate: 'D2' } }],
      IN + 20 * MIN,
    ],
    [
      'a departure delay: the arrival estimate',
      {},
      [{ at: t(-120), shape: { delay: 30, arrival: 25 }, confirmed: true }],
      IN + 25 * MIN,
    ],
    [
      'a delay with no arrival estimate: scheduled in',
      {},
      [{ at: t(-120), shape: { delay: 30 }, confirmed: true }],
      IN,
    ],
    [
      'an arrival delay: the arrival estimate',
      {},
      [{ at: t(60), shape: { ...AIRBORNE, arrival: 40 } }],
      IN + 40 * MIN,
    ],
    [
      'a cancellation: scheduled out plus 24 hours',
      {},
      [{ at: t(-90), shape: { status: 'cancelled' }, confirmed: true }],
      OUT + 24 * H * MIN,
    ],
    [
      'an un-cancellation: the same window',
      {},
      [
        { at: t(-90), shape: { status: 'cancelled' }, confirmed: true },
        { at: t(-60), shape: {} },
      ],
      OUT + 24 * H * MIN,
    ],
    [
      'a diversion: the arrival estimate plus 6 hours',
      {},
      [{ at: t(120), shape: { ...AIRBORNE, status: 'diverted', arrival: 40 }, confirmed: true }],
      IN + (40 + 6 * H) * MIN,
    ],
    [
      'a stale anchor already past: floored at 15 minutes after production',
      { originGate: 'B10' },
      gateTo(t(10)),
      t(25),
    ],
  ])('%s', (_name, start, steps, expected) => {
    const { intents } = walk(start, steps);
    expect(intents.at(-1)?.expiresAt).toBe(iso(expected));
  });
});

describe('the policy state', () => {
  it('is JSON that reads back as itself, versioned', () => {
    const { state } = walk({ originGate: 'B10' }, [
      { at: t(-120), shape: { delay: 20, originGate: 'B12' } },
      { at: t(-110), shape: { status: 'cancelled' } },
    ]);
    const stored: unknown = JSON.parse(JSON.stringify(state));
    expect(readPolicyState(stored)).toEqual(state);
    expect(state.v).toBe(POLICY_STATE_VERSION);
  });

  it('reads a layout it does not know as null, so the tracker seeds a fresh one', () => {
    const state = initialPolicyState(snap());
    expect(readPolicyState({ ...state, v: POLICY_STATE_VERSION + 1 })).toBeNull();
    expect(readPolicyState(null)).toBeNull();
    expect(readPolicyState({ v: POLICY_STATE_VERSION })).toBeNull();
  });

  it('seeds from a snapshot without pushing anything', () => {
    expect(initialPolicyState(snap({ delay: 30, arrival: 31, originGate: 'B10' }))).toEqual({
      v: POLICY_STATE_VERSION,
      delay: { pushedMinutes: 30, lastIntentAt: null, arrivalBand: 2, pending: null },
      gates: {
        origin: { seen: 'B10', pushed: null },
        destination: { seen: null, pushed: null },
      },
      cancellation: { status: 'none' },
      diversion: { status: 'none' },
    });
  });

  it('never mutates the state it is given', () => {
    const previous = snap({ originGate: 'B10' });
    const state = initialPolicyState(previous);
    const before = JSON.stringify(state);
    const next = snap({ originGate: 'B12', delay: 25 });
    evaluatePolicy({ previous, next, state, now: t(-60) });
    evaluateReread({ previous, next, state, now: t(-60) });
    expect(JSON.stringify(state)).toBe(before);
  });

  it('returns every intent one observation produces', () => {
    const steps: Step[] = [
      { at: t(-60), shape: { originGate: 'B12', delay: 30 } },
      { at: t(-55), shape: { originGate: 'B12', delay: 30 }, reread: true },
    ];
    expect(walk({ originGate: 'B10' }, steps).intents.map(summary)).toEqual([
      'gate_change origin B12',
      'delay departure 30',
    ]);
  });
});
