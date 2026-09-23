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
 * show at once, before any sync pull), 200 `created: false` under another id (the optimistic row
 * is replaced, a queued unsubscribe follows the server's id), 403 `cap_exceeded` (the free-tier
 * explanation from the payload, the row removed), 404 `flight_not_found` (the dates tried, the row
 * removed), 422 `idempotency_payload_mismatch` (a fresh key, reported to Sentry without the
 * body), and no network (the row stays, queued).
 */

import * as Sentry from '@sentry/react-native';
import {
  DesignatorInputSchema,
  IsoDateSchema,
  parseDesignator,
  type FlightKey,
} from '@planeahead/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import AddFlightSheet from '../src/app/(app)/add';
import type { SqliteLike } from '../src/lib/db/sqlite-like';
import { useFlightNotices } from '../src/lib/flight-notices';
import { listFlights } from '../src/lib/flight-queries';
import { addFlight, removeFlight, validateAddFlight } from '../src/lib/flights';
import { services } from '../src/lib/services';
import { useSettings } from '../src/lib/settings';
import { compactTree } from './support/compact-tree';
import { createMemorySqlite, type MemorySqlite } from './support/memory-sqlite';
import {
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

jest.mock('../src/lib/auth-client', () => ({
  authClient: {
    getCookie: () => 'better-auth.session_token=session-abc',
    signOut: jest.fn(() => Promise.resolve()),
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
  useFlightNotices.getState().clear();
  useSettings.getState().reset();
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

  it('200 created false under another id: the server row replaces the optimistic one', async () => {
    const db = mockEdge.db;
    const { outbox } = await services();
    const added = addFlight(db, { designator: 'AA100', date: '2026-09-23' });
    if (added.kind !== 'queued') {
      throw new Error('expected a queued add');
    }
    // Removed on this phone before the POST answered: the DELETE must follow the server's id.
    removeFlight(db, added.subscriptionId);
    mockEdge.network.answer(() =>
      json(200, { subscription: serverRow(SERVER_ID), flight: flightView(), created: false }),
    );
    mockEdge.network.answer(() =>
      json(200, { deleted: true, subscription: { ...serverRow(SERVER_ID), deletedAt: 'x' } }),
    );

    await outbox.drain();

    const paths = mockEdge.network.requests.map((request) => `${request.method} ${request.url}`);
    expect(paths).toEqual([
      'POST https://api.planeahead.test/v1/flights',
      `DELETE https://api.planeahead.test/v1/flights/${SERVER_ID}`,
    ]);
    const rows = db.raw
      .prepare('SELECT id, flight_key, deleted_at FROM flight_subscriptions')
      .all() as { id: string; flight_key: string; deleted_at: string | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: SERVER_ID, flight_key: AA100_KEY });
    expect(rows[0]?.deleted_at).not.toBeNull();
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

  it('offline: the flight stays on this phone as pending and the sheet closes', async () => {
    mockEdge.network.answer(() => {
      throw new TypeError('Network request failed');
    });
    await openSheet();
    await submit('AA100');
    await waitFor(() => {
      expect(mockRouter.back).toHaveBeenCalled();
    });
    expect(listFlights(mockEdge.db).map((item) => [item.designator, item.pending])).toEqual([
      ['AA100', true],
    ]);
    expect(outboxRows(mockEdge.db).map((row) => `${row.method} ${row.path}`)).toEqual([
      'POST /v1/flights',
    ]);
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

  it('says so when the flight is already tracked', async () => {
    seedStore(mockEdge.db);
    await openSheet();
    await submit('AA100');
    expect(await screen.findByTestId('add-flight-message')).toHaveTextContent(
      'You already track AA100 on Wed 23 Sep.',
    );
    expect(mockEdge.network.requests).toEqual([]);
  });
});

describe('the sheet in light and dark', () => {
  it.each(['light', 'dark'] as const)('renders with its validation errors in %s', async (theme) => {
    useSettings.getState().setAppearance(theme);
    await openSheet();
    await submit('', '');
    expect(compactTree(screen.toJSON())).toMatchSnapshot();
  });
});
