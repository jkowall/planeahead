/**
 * The add-flight sheet (increment 10, ruling T2), end to end through the app's REAL services: the
 * sheet validates with the shared `parseDesignator` and `IsoDateSchema`, `addFlight` writes the
 * optimistic row and the outbox row in one immediate transaction, the real outbox drains
 * `POST /v1/flights` through the real API client (Idempotency-Key, X-Install-Id, the session
 * cookie) to a scripted `fetch`, and the settling hooks reconcile the store. Only the edges are
 * replaced: `fetch`, the store connection (the in-memory SQLite), the auth client's cookie, the
 * install id and the runtime config.
 *
 * The answers the increment 8 route gives: 201 with the server's row and the flight (the times
 * show at once, before any sync pull), 200 `created: false` under another id (the add was a no-op:
 * the optimistic row and anything queued for it go, the account's row stays; ruling X7), 403
 * `cap_exceeded` (the free-tier explanation from the payload, the row removed), 404
 * `flight_not_found` (the dates tried, the row removed), 410 `flight_archived`, 422
 * `date_out_of_range`, 400 `validation_failed` and a code this build does not know (a generic
 * sentence; the code goes to Sentry only), 422 `idempotency_payload_mismatch` (a fresh key,
 * reported to Sentry without the body), and no network (the row stays, queued).
 *
 * The re-review (rulings Y1, Y3, Y5): while the phone knows it is offline the sheet's own drain
 * neither stamps nor sends, so the add it queued is cancelled outright; online the stamp lands
 * before `fetch` is called; a name a card shows, re-typed, is answered locally; and
 * `forgetAccount` drops the records of where optimistic subscriptions went.
 *
 * The date field keeps the number pad: the sheet inserts the hyphens as the digits are typed and
 * the validation reads eight bare digits as a date (increment 10 review).
 */

import * as Sentry from '@sentry/react-native';
import {
  DesignatorInputSchema,
  IsoDateSchema,
  parseDesignator,
  type FlightKey,
} from '@planeahead/shared';
import { onlineManager } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import AddFlightSheet from '../src/app/(app)/add';
import { KV_KEYS, kv } from '../src/lib/db/kv';
import type { SqliteLike } from '../src/lib/db/sqlite-like';
import { useFlightNotices } from '../src/lib/flight-notices';
import { listFlights } from '../src/lib/flight-queries';
import { recordReplacement } from '../src/lib/flight-replacements';
import { addFlight, refusalMessage, removeFlight, validateAddFlight } from '../src/lib/flights';
import { formatDateInput } from '../src/lib/format';
import { forgetAccount, services } from '../src/lib/services';
import { useSettings } from '../src/lib/settings';
import { DARK, LIGHT } from '../src/theme/tokens';
import { compactTree } from './support/compact-tree';
import { createMemorySqlite, type MemorySqlite } from './support/memory-sqlite';
import {
  AA100_ID,
  AA100_KEY,
  NOW,
  aa100Snapshot,
  json,
  scriptedFetch,
  seedStore,
  type RecordedRequest,
} from './support/flight-fixtures';

const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn() };

/** The store and the network the real services are built over; each test swaps them. */
const mockEdge: { db: MemorySqlite; network: ReturnType<typeof scriptedFetch> } = {
  db: createMemorySqlite(),
  network: scriptedFetch(),
};

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({}),
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});

jest.mock('expo-network', () => ({
  addNetworkStateListener: jest.fn(() => ({ remove: jest.fn() })),
  getNetworkStateAsync: jest.fn(() => Promise.resolve({ isInternetReachable: true })),
}));

jest.mock('../src/lib/db/kv', () =>
  jest.requireActual<typeof import('./support/memory-kv')>('./support/memory-kv').memoryKvModule(),
);

jest.mock('../src/lib/config', () => ({
  runtimeConfig: () => ({
    variant: 'development',
    apiUrl: 'https://api.planeahead.test',
    universalLinkHosts: [],
    apnsEnvironment: 'development',
    googleIosClientId: 'ios-client.apps.googleusercontent.com',
    googleWebClientId: null,
    sentryDsn: null,
  }),
}));

/** The session the sheet reads (increment 18: the airport field is for signed-in users only). */
const mockSession: { current: unknown } = { current: null };

jest.mock('../src/lib/auth-client', () => ({
  authClient: {
    getCookie: () => 'better-auth.session_token=session-abc',
    signOut: jest.fn(() => Promise.resolve()),
    useSession: () => ({ data: mockSession.current, isPending: false }),
  },
}));

jest.mock('../src/lib/identity', () => ({
  installId: () => 'install-0123456789',
  analyticsId: () => 'analytics-0123456789',
}));

/** The app's one connection, as services.ts sees it: every call goes to this test's database. */
jest.mock('../src/lib/db/client', () => {
  const delegate: SqliteLike = {
    exec: (source) => {
      mockEdge.db.exec(source);
    },
    run: (source, params) => mockEdge.db.run(source, params),
    all: (source, params) => mockEdge.db.all(source, params),
    get: (source, params) => mockEdge.db.get(source, params),
    transaction: (fn, options) => mockEdge.db.transaction(fn, options),
  };
  const store = { db: null, orm: null, sqlite: delegate };
  return {
    whenStoreReady: () => Promise.resolve(store),
    currentStore: () => store,
  };
});

const SERVER_ID = '0199c000-0000-7000-8000-00000000abcd';

function serverRow(id: string, flightKey: FlightKey = AA100_KEY) {
  return {
    id,
    flightKey,
    flightInstanceId: '0199c000-0000-7000-8000-00000000f001',
    tripId: null,
    label: null,
    seat: null,
    cabin: null,
    muted: false,
    notificationOverrides: {},
    source: 'manual',
    liveTracked: true,
    createdAt: '2026-09-23T14:00:01.000Z',
    updatedAt: '2026-09-23T14:00:01.000Z',
    deletedAt: null,
  };
}

function flightView() {
  return {
    key: AA100_KEY,
    phase: 'scheduled',
    version: 1,
    snapshot: aa100Snapshot(),
    source: 'tracker',
  };
}

function subscriptionIdOf(request: RecordedRequest): string {
  return (request.body as { subscriptionId: string }).subscriptionId;
}

function stamps(db: MemorySqlite) {
  return db.raw.prepare('SELECT last_attempt_at, attempts FROM outbox ORDER BY seq').all() as {
    last_attempt_at: number | null;
    attempts: number;
  }[];
}

function outboxRows(db: MemorySqlite) {
  return db.raw.prepare('SELECT method, path, idempotency_key FROM outbox ORDER BY seq').all() as {
    method: string;
    path: string;
    idempotency_key: string;
  }[];
}

async function openSheet() {
  await render(<AddFlightSheet />);
}

async function submit(number: string, date = '2026-09-23') {
  await fireEvent.changeText(screen.getByTestId('add-flight-number'), number);
  await fireEvent.changeText(screen.getByTestId('add-flight-date'), date);
  await fireEvent.press(screen.getByTestId('add-flight-submit'));
}

beforeAll(() => {
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) =>
    mockEdge.network.fetchMock(input, init);
});

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  mockEdge.db = createMemorySqlite();
  mockEdge.network = scriptedFetch();
  mockSession.current = { user: { id: 'user-1', isAnonymous: false } };
  useFlightNotices.getState().clear();
  useSettings.getState().reset();
});

afterEach(() => {
  onlineManager.setOnline(true);
});

describe('add-flight validation (the shared parseDesignator and IsoDateSchema)', () => {
  const NUMBERS = [
    ['AA100', 'AA100'],
    ['aa 0100', 'AA100'],
    ['AAL100', 'AAL100'],
    ['BA1512', 'BA1512'],
    ['U2 1234', 'U21234'],
    ['aa100a', 'AA100A'],
    ['', null],
    ['100', null],
    ['AA', null],
    ['AA 0', null],
    ['AA12345', null],
    ['A-100', null],
  ] as const;

  it.each(NUMBERS)('reads flight number %p as %p', (input, expected) => {
    const result = validateAddFlight({ number: input, date: '2026-09-24' });
    expect(result.ok ? result.value.designator : null).toBe(expected);
  });

  it.each(NUMBERS)('agrees with the API on %p', (input) => {
    let parses: boolean;
    try {
      parseDesignator(input);
      parses = input.trim() !== '';
    } catch {
      parses = false;
    }
    const api = DesignatorInputSchema.safeParse(input).success;
    expect(validateAddFlight({ number: input, date: '2026-09-24' }).ok).toBe(parses && api);
  });

  it.each([
    ['2026-09-24', true],
    ['2028-02-29', true],
    ['2026-02-30', false],
    ['2026-9-24', false],
    ['24/09/2026', false],
    ['', false],
  ])('reads date %p as valid: %p, as the API does', (date, valid) => {
    expect(validateAddFlight({ number: 'AA100', date }).ok).toBe(valid);
    expect(IsoDateSchema.safeParse(date).success).toBe(valid);
  });

  it.each([
    ['20260926', '2026-09-26'],
    ['2026-09-26', '2026-09-26'],
    [' 20280229 ', '2028-02-29'],
  ])('reads the number pad form %p as %p', (typed, date) => {
    expect(validateAddFlight({ number: 'AA100', date: typed })).toEqual({
      ok: true,
      value: { designator: 'AA100', date },
    });
  });

  it.each(['20260230', '2026092', '202609261', '26092026'])(
    'still refuses %p when its digits are not a real YYYYMMDD date',
    (typed) => {
      expect(validateAddFlight({ number: 'AA100', date: typed }).ok).toBe(false);
    },
  );

  it('inserts the hyphens as the digits are typed, and deleting never sticks on one', () => {
    const typed = ['2', '20', '202', '2026', '20260', '202609', '2026092', '20260926'];
    expect(typed.map(formatDateInput)).toEqual([
      '2',
      '20',
      '202',
      '2026',
      '2026-0',
      '2026-09',
      '2026-09-2',
      '2026-09-26',
    ]);
    // Backspace over "2026-0" leaves "2026-", which reads as the four digits.
    expect(formatDateInput('2026-')).toBe('2026');
    expect(formatDateInput('2026-09-')).toBe('2026-09');
    // A pasted date, and anything past eight digits.
    expect(formatDateInput('2026-09-26')).toBe('2026-09-26');
    expect(formatDateInput('2026-09-261')).toBe('2026-09-26');
    expect(formatDateInput('2026/09/26')).toBe('2026-09-26');
  });

  it('the sheet formats the date as it is typed on the number pad', async () => {
    await openSheet();
    const field = screen.getByTestId('add-flight-date');
    await fireEvent.changeText(field, '');
    for (const text of ['2', '20', '202', '2026', '20260', '2026-01', '2026-011', '2026-01-05']) {
      await fireEvent.changeText(field, text);
    }
    expect(screen.getByTestId('add-flight-date')).toHaveProp('value', '2026-01-05');
    expect(screen.getByTestId('add-flight-date')).toHaveProp('inputMode', 'numeric');
  });

  it('says what is wrong with each field', () => {
    expect(validateAddFlight({ number: '', date: '' })).toEqual({
      ok: false,
      errors: {
        number: 'Enter the flight number, e.g. AA100.',
        date: 'Enter the departure date.',
      },
    });
    expect(validateAddFlight({ number: 'hello', date: '2026-13-01' })).toEqual({
      ok: false,
      errors: {
        number: 'That is not a flight number. Use the airline code and number, e.g. AA100.',
        date: 'Use a real date as YYYY-MM-DD, e.g. 2026-09-24.',
      },
    });
  });

  it('shows the errors in the sheet and writes nothing', async () => {
    await openSheet();
    await submit('hello', '2026-02-30');
    expect(screen.getByTestId('add-flight-number-error')).toHaveTextContent(/not a flight number/);
    expect(screen.getByTestId('add-flight-date-error')).toHaveTextContent(/real date/);
    expect(outboxRows(mockEdge.db)).toEqual([]);
    expect(listFlights(mockEdge.db)).toEqual([]);
    expect(mockEdge.network.requests).toEqual([]);
  });
});

describe('addFlight writes through the outbox', () => {
  it('writes the optimistic row and the POST in ONE immediate transaction, with the same id', () => {
    const db = createMemorySqlite();
    const added = addFlight(db, { designator: 'AA100', date: '2026-09-23' });
    expect(added.kind).toBe('queued');
    expect(db.transactions).toHaveLength(1);
    expect(db.transactions[0]).toMatchObject({ behavior: 'immediate', outcome: 'committed' });
    const outbox = db.raw.prepare('SELECT method, path, body, entity_id FROM outbox').all() as {
      method: string;
      path: string;
      body: string;
      entity_id: string;
    }[];
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ method: 'POST', path: '/v1/flights' });
    expect(JSON.parse(outbox[0]?.body ?? '{}')).toEqual({
      subscriptionId: added.subscriptionId,
      number: 'AA100',
      date: '2026-09-23',
    });
    expect(outbox[0]?.entity_id).toBe(added.subscriptionId);
    expect(listFlights(db).map((item) => [item.id, item.pending])).toEqual([
      [added.subscriptionId, true],
    ]);
  });

  it('does not queue a flight the store already tracks', () => {
    const db = createMemorySqlite();
    seedStore(db);
    expect(addFlight(db, { designator: 'AA100', date: '2026-09-23' })).toEqual({
      kind: 'already_tracked',
      subscriptionId: '0199a000-0000-7000-8000-000000000001',
    });
    expect(outboxRows(db)).toEqual([]);
  });

  it('compares flight keys first, then every name a live row is known by (ruling Y3)', () => {
    const db = createMemorySqlite();
    // The shared snapshot names BA1512 (whoever searched first typed it) and lists BA1511.
    seedStore(db, { marketingCarrierIcao: 'BAW', marketingFlightNumber: '1512' });
    const tracked = { kind: 'already_tracked', subscriptionId: AA100_ID };
    // By key: the operating designator, in either spelling.
    expect(addFlight(db, { designator: 'AA100', date: '2026-09-23' })).toEqual(tracked);
    expect(addFlight(db, { designator: 'AAL100', date: '2026-09-23' })).toEqual(tracked);
    // By name: the snapshot's marketing designator and its codeshare, in IATA and ICAO spelling.
    for (const designator of ['BA1512', 'BA1511', 'BAW1511']) {
      expect(addFlight(db, { designator, date: '2026-09-23' })).toEqual(tracked);
    }
    expect(outboxRows(db)).toEqual([]);
    // Another date is another flight, and the same add again is answered by its pending key.
    const tomorrow = addFlight(db, { designator: 'AA100', date: '2026-09-24' });
    expect(tomorrow.kind).toBe('queued');
    expect(addFlight(db, { designator: 'AA100', date: '2026-09-24' })).toEqual({
      kind: 'already_tracked',
      subscriptionId: tomorrow.subscriptionId,
    });
    // A codeshare no row here is known by is queued and shown; the server's answer settles it.
    expect(addFlight(db, { designator: 'IB4218', date: '2026-09-23' }).kind).toBe('queued');
    expect(
      listFlights(db)
        .map((item) => `${item.designator}${item.pending ? ' (adding)' : ''}`)
        .sort(),
    ).toEqual(['AA100', 'AA100 (adding)', 'BA117', 'DL1', 'IB4218 (adding)']);
  });

  it('adds a second leg of the same number from a board: only its origin matches (R9)', () => {
    const db = createMemorySqlite();
    seedStore(db);
    const day = '2026-09-23';
    const tracked = { kind: 'already_tracked', subscriptionId: AA100_ID };
    // A synced first leg: AA100 departs KJFK, by key and by its codeshare's name.
    expect(addFlight(db, { designator: 'AA100', date: day, origin: 'KJFK' })).toEqual(tracked);
    expect(addFlight(db, { designator: 'BA1511', date: day, origin: 'KJFK' })).toEqual(tracked);
    // A typed add names no leg: any leg that day is the flight, as before.
    expect(addFlight(db, { designator: 'AA100', date: day })).toEqual(tracked);
    // Its KLAX leg is another flight, and the same add again is answered by its pending key.
    const lax = addFlight(db, { designator: 'AA100', date: day, origin: 'KLAX' });
    expect(lax.kind).toBe('queued');
    expect(addFlight(db, { designator: 'BA1511', date: day, origin: 'KLAX' }).kind).toBe('queued');
    expect(addFlight(db, { designator: 'AA100', date: day, origin: 'KLAX' })).toEqual({
      kind: 'already_tracked',
      subscriptionId: lax.subscriptionId,
    });

    // A pending first leg: WN1234 from KMDW, its POST not answered yet; then its KBNA leg.
    const mdw = addFlight(db, { designator: 'WN1234', date: day, origin: 'KMDW' });
    const bna = addFlight(db, { designator: 'WN1234', date: day, origin: 'KBNA' });
    expect([mdw.kind, bna.kind]).toEqual(['queued', 'queued']);
    expect(addFlight(db, { designator: 'WN1234', date: day, origin: 'KBNA' })).toEqual({
      kind: 'already_tracked',
      subscriptionId: bna.subscriptionId,
    });
    expect(addFlight(db, { designator: 'WN1234', date: day }).kind).toBe('already_tracked');

    const bodies = db.raw.prepare('SELECT body FROM outbox ORDER BY seq').all() as {
      body: string;
    }[];
    expect(bodies.map((row) => (JSON.parse(row.body) as { origin?: string }).origin)).toEqual([
      'KLAX',
      'KLAX',
      'KMDW',
      'KBNA',
    ]);
    expect(listFlights(db).filter((item) => item.pending)).toHaveLength(4);
  });

  it('queues a board leg over a typed pending add, which names no leg (R9)', () => {
    const db = createMemorySqlite();
    expect(addFlight(db, { designator: 'WN1234', date: '2026-09-23' }).kind).toBe('queued');
    // If the typed add resolves to this leg, the server's `created: false` settles it.
    const bna = addFlight(db, { designator: 'WN1234', date: '2026-09-23', origin: 'KBNA' });
    expect(bna.kind).toBe('queued');
    expect(
      db.raw.prepare('SELECT flight_key FROM flight_subscriptions ORDER BY flight_key').all(),
    ).toEqual([
      { flight_key: 'pending:WN1234:2026-09-23' },
      { flight_key: 'pending:WN1234:2026-09-23:KBNA' },
    ]);
  });
});

describe('the sheet, through the real outbox', () => {
  it('201: sends Idempotency-Key and X-Install-Id, shows the scheduled times at once, closes', async () => {
    mockEdge.network.answer((request) =>
      json(201, {
        subscription: serverRow(subscriptionIdOf(request)),
        flight: flightView(),
        created: true,
      }),
    );
    await openSheet();
    await submit('aa 100');
    await waitFor(() => {
      expect(mockRouter.back).toHaveBeenCalled();
    });

    const [request] = mockEdge.network.requests;
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe('https://api.planeahead.test/v1/flights');
    expect(request?.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(request?.headers.get('x-install-id')).toBe('install-0123456789');
    expect(request?.headers.get('cookie')).toBe('better-auth.session_token=session-abc');
    // The client-minted id is a uuidv7 (ADR 0006), the same id the optimistic row carries.
    expect(request?.body).toEqual({
      subscriptionId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ) as unknown,
      number: 'AA100',
      date: '2026-09-23',
    });

    // The server's row under the SAME id, with the flight snapshot, before any sync pull.
    const [item, ...others] = listFlights(mockEdge.db);
    expect(others).toEqual([]);
    expect(item).toMatchObject({
      id: subscriptionIdOf(request as RecordedRequest),
      flightKey: AA100_KEY,
      pending: false,
      scheduledOut: '2026-09-23T22:00:00Z',
      scheduledIn: '2026-09-24T06:10:00Z',
      origin: { code: 'JFK', gate: 'B22' },
    });
    expect(outboxRows(mockEdge.db)).toEqual([]);
  });

  it('200 created false under another id: a DELETE queued for the add is dropped, never re-pointed', async () => {
    const db = mockEdge.db;
    const { outbox } = await services();
    // The POST leaves and its answer is lost; the user then stops tracking the "Adding" row.
    mockEdge.network.answer(() => {
      throw new TypeError('Network request failed');
    });
    const added = addFlight(db, { designator: 'AA100', date: '2026-09-23' });
    if (added.kind !== 'queued') {
      throw new Error('expected a queued add');
    }
    await outbox.drain();
    expect(removeFlight(db, added.subscriptionId)).toBe('queued');
    db.run('UPDATE outbox SET next_attempt_at = 0');
    // The account already held the flight under SERVER_ID: the add was a no-op on the server.
    mockEdge.network.answer(() =>
      json(200, { subscription: serverRow(SERVER_ID), flight: flightView(), created: false }),
    );

    await outbox.drain();

    const paths = mockEdge.network.requests.map((request) => `${request.method} ${request.url}`);
    expect(paths).toEqual([
      'POST https://api.planeahead.test/v1/flights',
      'POST https://api.planeahead.test/v1/flights',
    ]);
    const rows = db.raw
      .prepare('SELECT id, flight_key, deleted_at FROM flight_subscriptions')
      .all() as { id: string; flight_key: string; deleted_at: string | null }[];
    // The account's own row stays live: the user removed the add, not the flight they had.
    expect(rows).toEqual([{ id: SERVER_ID, flight_key: AA100_KEY, deleted_at: null }]);
    expect(outboxRows(db)).toEqual([]);
  });

  it('200 created false: one row for the flight between the answer and the next pull', async () => {
    mockEdge.network.answer(() =>
      json(200, { subscription: serverRow(SERVER_ID), flight: flightView(), created: false }),
    );
    await openSheet();
    await submit('AA100');
    await waitFor(() => {
      expect(mockRouter.back).toHaveBeenCalled();
    });
    expect(listFlights(mockEdge.db).map((item) => [item.id, item.flightKey])).toEqual([
      [SERVER_ID, AA100_KEY],
    ]);
  });

  it('403 cap_exceeded: says the free-tier limit from the payload and removes the row', async () => {
    mockEdge.network.answer(() =>
      json(403, {
        error: 'cap_exceeded',
        cap: 'active_subscriptions',
        limit: 5,
        message: 'the free plan allows 5 (active subscriptions)',
        requestId: 'req-1',
      }),
    );
    await openSheet();
    await submit('AA100');
    const message = await screen.findByTestId('add-flight-message');
    expect(message).toHaveTextContent(
      'The free plan tracks up to 5 flights at a time. Remove a flight to add another.',
    );
    expect(mockRouter.back).not.toHaveBeenCalled();
    expect(listFlights(mockEdge.db)).toEqual([]);
    expect(outboxRows(mockEdge.db)).toEqual([]);
    // Said in the sheet, so not again on the home screen.
    expect(useFlightNotices.getState().notices).toEqual([]);
    // Reported by method, path, status and code: never the body.
    expect(Sentry.captureMessage).toHaveBeenCalledWith('outbox_mutation_dropped', {
      level: 'warning',
      extra: { method: 'POST', path: '/v1/flights', status: 403, code: 'cap_exceeded' },
    });
  });

  it('403 for the live-tracked cap uses that cap and its own limit', async () => {
    mockEdge.network.answer(() =>
      json(403, { error: 'cap_exceeded', cap: 'live_tracked', limit: 2, requestId: 'req-2' }),
    );
    await openSheet();
    await submit('AA100');
    expect(await screen.findByTestId('add-flight-message')).toHaveTextContent(
      /follows up to 2 flights live at once/,
    );
  });

  it('404 flight_not_found: names the dates the search tried and removes the row', async () => {
    mockEdge.network.answer(() =>
      json(404, {
        error: 'flight_not_found',
        message: 'the provider knows no such flight on those dates',
        requestId: 'req-3',
        triedDates: ['2026-09-24', '2026-09-23', '2026-09-25'],
        suggestions: [],
      }),
    );
    await openSheet();
    await submit('AA9999', '2026-09-24');
    expect(await screen.findByTestId('add-flight-message')).toHaveTextContent(
      'No flight AA9999 was found on Wed 23 Sep, Thu 24 Sep or Fri 25 Sep. Check the number and the departure date.',
    );
    expect(listFlights(mockEdge.db)).toEqual([]);
    expect(outboxRows(mockEdge.db)).toEqual([]);
  });

  it('422 idempotency_payload_mismatch: a fresh key, sent again, reported without the body', async () => {
    mockEdge.network.answer(() =>
      json(422, { error: 'idempotency_payload_mismatch', requestId: 'req-4' }),
    );
    mockEdge.network.answer((request) =>
      json(201, {
        subscription: serverRow(subscriptionIdOf(request)),
        flight: flightView(),
        created: true,
      }),
    );
    await openSheet();
    await submit('AA100');
    await waitFor(() => {
      expect(mockRouter.back).toHaveBeenCalled();
    });

    const [first, second] = mockEdge.network.requests;
    expect(first?.headers.get('idempotency-key')).not.toBe(second?.headers.get('idempotency-key'));
    expect(second?.body).toEqual(first?.body);
    expect(Sentry.captureMessage).toHaveBeenCalledWith('outbox_idempotency_key_regenerated', {
      level: 'warning',
      extra: { method: 'POST', path: '/v1/flights', attempts: 0 },
    });
    expect(JSON.stringify(jest.mocked(Sentry.captureMessage).mock.calls)).not.toMatch(/AA100/);
    expect(listFlights(mockEdge.db).map((item) => item.pending)).toEqual([false]);
  });

  it('no answer: stamped before fetch was called, the flight stays pending and the sheet closes', async () => {
    const stampedAtFetch: (number | null)[] = [];
    mockEdge.network.answer(() => {
      stampedAtFetch.push(stamps(mockEdge.db)[0]?.last_attempt_at ?? null);
      throw new TypeError('Network request failed');
    });
    await openSheet();
    await submit('AA100');
    await waitFor(() => {
      expect(mockRouter.back).toHaveBeenCalled();
    });
    // Online as far as the phone knew: the stamp landed before the request existed (ruling Y1).
    expect(stampedAtFetch).toEqual([expect.any(Number)]);
    const [pending] = listFlights(mockEdge.db);
    expect([pending?.designator, pending?.pending]).toEqual(['AA100', true]);
    expect(outboxRows(mockEdge.db).map((row) => `${row.method} ${row.path}`)).toEqual([
      'POST /v1/flights',
    ]);
    // The server may have it, so stopping it now needs the DELETE.
    expect(removeFlight(mockEdge.db, pending?.id ?? '')).toBe('queued');
  });

  it('known offline: the sheet queues the add unstamped and unsent, and removing it cancels it (ruling Y1)', async () => {
    const { outbox } = await services();
    const drain = jest.spyOn(outbox, 'drain');
    onlineManager.setOnline(false);
    await openSheet();
    await submit('AA100');
    await waitFor(() => {
      expect(mockRouter.back).toHaveBeenCalled();
    });
    // The sheet's own drain ran, and stopped before the stamp: nothing sent, no attempt.
    expect(drain).toHaveBeenCalled();
    await expect(drain.mock.results[0]?.value).resolves.toEqual({
      kind: 'deferred',
      sent: 0,
      dropped: 0,
    });
    expect(mockEdge.network.requests).toEqual([]);
    expect(stamps(mockEdge.db)).toEqual([{ last_attempt_at: null, attempts: 0 }]);

    const [pending] = listFlights(mockEdge.db);
    expect(pending?.pending).toBe(true);
    expect(removeFlight(mockEdge.db, pending?.id ?? '')).toBe('cancelled');
    expect(listFlights(mockEdge.db)).toEqual([]);
    expect(outboxRows(mockEdge.db)).toEqual([]);

    // Back online, nothing is left to send.
    onlineManager.setOnline(true);
    await expect(outbox.drain()).resolves.toEqual({ kind: 'drained', sent: 0, dropped: 0 });
    expect(mockEdge.network.requests).toEqual([]);
  });

  it('a refusal that lands after the sheet closed is shown on the home screen instead', async () => {
    let answer: (response: Response) => void = () => undefined;
    mockEdge.network.answer(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    const view = await render(<AddFlightSheet />);
    await submit('AA100');
    await waitFor(() => {
      expect(mockEdge.network.requests).toHaveLength(1);
    });
    await fireEvent.press(screen.getByTestId('add-flight-close'));
    expect(mockRouter.back).toHaveBeenCalledTimes(1);
    await view.unmount();
    answer(
      json(403, { error: 'cap_exceeded', cap: 'instances_created', limit: 20, requestId: 'r' }),
    );
    await waitFor(() => {
      expect(useFlightNotices.getState().notices).toHaveLength(1);
    });
    expect(useFlightNotices.getState().notices[0]?.message).toMatch(/up to 20 new flights a day/);
  });

  it('410 flight_archived: says the flight is over and removes the row', async () => {
    mockEdge.network.answer(() =>
      json(410, { error: 'flight_archived', message: 'over', requestId: 'req-5' }),
    );
    await openSheet();
    await submit('AA100', '20260924');
    expect(await screen.findByTestId('add-flight-message')).toHaveTextContent(
      'AA100 on Thu 24 Sep is over and can no longer be tracked.',
    );
    expect(mockEdge.network.requests[0]?.body).toMatchObject({ date: '2026-09-24' });
    expect(listFlights(mockEdge.db)).toEqual([]);
    expect(outboxRows(mockEdge.db)).toEqual([]);
  });

  it('422 date_out_of_range: says how far ahead flights can be added, and removes the row', async () => {
    mockEdge.network.answer(() =>
      json(422, { error: 'date_out_of_range', maxDaysAhead: 330, requestId: 'req-6' }),
    );
    await openSheet();
    await submit('AA100', '2027-09-24');
    expect(await screen.findByTestId('add-flight-message')).toHaveTextContent(
      'Flights can be added up to 330 days ahead.',
    );
    expect(listFlights(mockEdge.db)).toEqual([]);
  });

  it('a code this build does not know: a generic sentence, the code to Sentry only', async () => {
    mockEdge.network.answer(() =>
      json(403, { error: 'insufficient_scope', message: 'nope', requestId: 'req-7' }),
    );
    await openSheet();
    await submit('AA100', '2026-09-24');
    const message = await screen.findByTestId('add-flight-message');
    expect(message).toHaveTextContent(
      'AA100 on Thu 24 Sep could not be added right now. Try again later.',
    );
    expect(message).not.toHaveTextContent(/insufficient_scope|403/);
    expect(Sentry.captureMessage).toHaveBeenCalledWith('outbox_mutation_dropped', {
      level: 'warning',
      extra: { method: 'POST', path: '/v1/flights', status: 403, code: 'insufficient_scope' },
    });
    expect(listFlights(mockEdge.db)).toEqual([]);
  });

  it('says so when the flight is already tracked', async () => {
    seedStore(mockEdge.db);
    await openSheet();
    await submit('AA100');
    expect(await screen.findByTestId('add-flight-message')).toHaveTextContent(
      'You already track AA100 on Wed 23 Sep.',
    );
    expect(mockEdge.network.requests).toEqual([]);
  });

  it('re-typing the name a card shows says so too, from this phone alone (ruling Y3)', async () => {
    // BA1511 added here lands on AA100's key; the provider lists no codeshares for it.
    mockEdge.network.answer((request) =>
      json(201, {
        subscription: serverRow(subscriptionIdOf(request)),
        flight: { ...flightView(), snapshot: aa100Snapshot({ codeshares: [] }) },
        created: true,
      }),
    );
    const first = await render(<AddFlightSheet />);
    await submit('BA1511');
    await waitFor(() => {
      expect(mockRouter.back).toHaveBeenCalled();
    });
    // The card shows the name typed here (added_as), operated as AA100.
    expect(
      listFlights(mockEdge.db).map((item) => [item.designator, item.operatingDesignator]),
    ).toEqual([['BA1511', 'AA100']]);
    await first.unmount();

    await openSheet();
    await submit('BA1511');
    expect(await screen.findByTestId('add-flight-message')).toHaveTextContent(
      'You already track BA1511 on Wed 23 Sep.',
    );
    expect(mockEdge.network.requests).toHaveLength(1);
    expect(outboxRows(mockEdge.db)).toEqual([]);
  });
});

describe('signing out (ruling Y5)', () => {
  it('forgetAccount drops every record of where an optimistic subscription went', async () => {
    kv.setItemSync(KV_KEYS.installId, 'install-0123456789');
    recordReplacement('0199c000-0000-7000-8000-000000000001', AA100_ID);
    recordReplacement('0199c000-0000-7000-8000-000000000002', AA100_ID);
    expect(kv.getAllKeysSync()).toEqual(
      expect.arrayContaining([
        'replaced:0199c000-0000-7000-8000-000000000001',
        'replaced:0199c000-0000-7000-8000-000000000002',
      ]),
    );
    await forgetAccount(null);
    expect(kv.getAllKeysSync().filter((key) => key.startsWith('replaced:'))).toEqual([]);
    // The installation's own keys stay.
    expect(kv.getItemSync(KV_KEYS.installId)).toBe('install-0123456789');
  });
});

describe('refusalMessage', () => {
  const item = {
    id: 'o',
    method: 'POST',
    path: '/v1/flights',
    body: { subscriptionId: 's', number: 'UA901', date: '2026-09-24' },
    idempotencyKey: 'k',
    attempts: 0,
    entityId: 's',
  };

  it.each([
    [
      400,
      { error: 'validation_failed' },
      'UA901 on Thu 24 Sep could not be added. Check the flight number and date.',
    ],
    [422, { error: 'date_out_of_range' }, 'UA901 on Thu 24 Sep is too far ahead to add yet.'],
    [
      413,
      { error: 'payload_too_large' },
      'UA901 on Thu 24 Sep could not be added right now. Try again later.',
    ],
    [
      403,
      { error: 'install_id_mismatch' },
      'UA901 on Thu 24 Sep could not be added right now. Try again later.',
    ],
    [418, 'not json', 'UA901 on Thu 24 Sep could not be added right now. Try again later.'],
  ] as const)('answers %p %j with %p', (status, body, text) => {
    expect(refusalMessage(item, status, body)).toBe(text);
  });
});

describe('the sheet in light and dark', () => {
  it.each(['light', 'dark'] as const)('renders with its validation errors in %s', async (theme) => {
    useSettings.getState().setAppearance(theme);
    await openSheet();
    await submit('', '');
    expect(compactTree(screen.toJSON())).toMatchSnapshot();
  });

  it.each([
    ['light', LIGHT],
    ['dark', DARK],
  ] as const)('draws the fields with the 3:1 input border in %s', async (theme, tokens) => {
    useSettings.getState().setAppearance(theme);
    await openSheet();
    for (const id of ['add-flight-number', 'add-flight-date']) {
      expect(StyleSheet.flatten(screen.getByTestId(id).props.style)).toMatchObject({
        borderColor: tokens.color.inputBorder,
        backgroundColor: tokens.color.surfaceRaised,
        borderWidth: 1,
      });
    }
  });
});
