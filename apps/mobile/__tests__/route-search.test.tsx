/**
 * The route search (increment 18, ruling B12), through the app's REAL services, as
 * airport-board.test.tsx: `GET /v1/airports/{origin}/flights/to/{destination}?date=` with
 * TanStack Query through the typed client, and a tapped result added through `addFlight` and the
 * real outbox. Only the edges are replaced: `fetch`, the store connection, the session cookie,
 * the install id and the runtime config.
 *
 * Covered: the form's validation (nothing is asked for a form the route would refuse), results
 * from a mocked answer in light and dark, the 403 `cap_exceeded` and 429 answers said plainly,
 * offline (said, never an empty list, no request), tap to add with the row's origin, an anonymous
 * account searching (route search is open to it), and that the same search is asked again only
 * when its answer failed, since each answered search takes one of the day's slots.
 */

import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Alert } from 'react-native';
import RouteSearchScreen from '../src/app/(app)/route-search';
import type { SqliteLike } from '../src/lib/db/sqlite-like';
import { useFlightNotices } from '../src/lib/flight-notices';
import { useSettings } from '../src/lib/settings';
import { DARK, LIGHT } from '../src/theme/tokens';
import { compactTree } from './support/compact-tree';
import { createMemorySqlite, type MemorySqlite } from './support/memory-sqlite';
import { NOW, json, scriptedFetch } from './support/flight-fixtures';
import { boardRow, routeAnswer } from './support/board-fixtures';

const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn() };
const mockSession: { current: unknown } = { current: null };
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
    useSession: () => ({ data: mockSession.current, isPending: false }),
  },
}));

jest.mock('../src/lib/identity', () => ({
  installId: () => 'install-0123456789',
  analyticsId: () => 'analytics-0123456789',
}));

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

const SEARCH_URL = 'https://api.planeahead.test/v1/airports/JFK/flights/to/LHR?date=2026-09-23';
const AA100_ROW = 'board-row-dep:AA100:2026-09-23T22:00:00Z';

async function openSearch() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 2, staleTime: 30_000, gcTime: Infinity } },
  });
  await render(
    <QueryClientProvider client={client}>
      <RouteSearchScreen />
    </QueryClientProvider>,
  );
}

async function search(origin: string, destination: string, date = '2026-09-23') {
  await fireEvent.changeText(screen.getByTestId('route-search-origin'), origin);
  await fireEvent.changeText(screen.getByTestId('route-search-destination'), destination);
  await fireEvent.changeText(screen.getByTestId('route-search-date'), date);
  await fireEvent.press(screen.getByTestId('route-search-submit'));
}

function urls(): string[] {
  return mockEdge.network.requests.map((request) => `${request.method} ${request.url}`);
}

beforeAll(() => {
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) =>
    mockEdge.network.fetchMock(input, init);
});

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  mockEdge.db = createMemorySqlite();
  mockEdge.network = scriptedFetch();
  mockSession.current = { user: { id: 'anon-1', isAnonymous: true } };
  useFlightNotices.getState().clear();
  useSettings.getState().reset();
});

afterEach(() => {
  onlineManager.setOnline(true);
});

describe('the form', () => {
  it('asks nothing for codes or a date the route would refuse', async () => {
    await openSearch();
    await search('J', 'jfk', '2026-02-30');
    expect(screen.getByTestId('route-search-origin-error').props.children).toBe(
      'Use a 3-letter IATA or 4-letter ICAO airport code, e.g. JFK or KJFK.',
    );
    expect(screen.getByTestId('route-search-date-error').props.children).toBe(
      'Use a real date as YYYY-MM-DD, e.g. 2026-09-24.',
    );
    await search('JFK', ' jfk ');
    expect(screen.getByTestId('route-search-destination-error').props.children).toBe(
      'The destination cannot be the origin.',
    );
    expect(mockEdge.network.requests).toHaveLength(0);
  });
});

describe('the results', () => {
  it('searches as an anonymous account and shows the flights in the origin time', async () => {
    mockEdge.network.answer(() => json(200, routeAnswer()));
    await openSearch();
    await search('jfk', 'lhr', '20260923');
    await screen.findByTestId('route-search-results');
    expect(urls()).toEqual([`GET ${SEARCH_URL}`]);
    expect(screen.getByText('JFK to LHR on Wed 23 Sep')).toBeTruthy();
    expect(screen.getByTestId('route-search-as-of').props.children).toBe(
      'As of 9:58 AM (2 min ago)',
    );
    expect(screen.getByTestId(AA100_ROW).props.accessibilityLabel).toMatch(
      /^AA100, to LHR, scheduled 6:00 PM, expected 6:25 PM,/,
    );
  });

  it('says when no flight flies the route that day', async () => {
    mockEdge.network.answer(() => json(200, routeAnswer({ flights: [] })));
    await openSearch();
    await search('JFK', 'LHR');
    expect(await screen.findByText('No flights from JFK to LHR that day.')).toBeTruthy();
  });

  it.each([
    ['light', LIGHT],
    ['dark', DARK],
  ] as const)('renders from a mocked answer in %s', async (appearance, tokens) => {
    useSettings.getState().setAppearance(appearance);
    mockEdge.network.answer(() =>
      json(200, routeAnswer({ stale: true, coverage: 'schedules_only' })),
    );
    await openSearch();
    await search('JFK', 'LHR');
    await screen.findByTestId('route-search-results');
    expect(screen.getByTestId('route-search-stale')).toBeTruthy();
    expect(screen.getByTestId('route-search-schedules-only')).toBeTruthy();
    expect(compactTree(screen.toJSON())).toMatchSnapshot();
    expect(screen.getByTestId('route-search-origin').props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ borderColor: tokens.color.inputBorder })]),
    );
  });
});

describe("the route's refusals, said plainly", () => {
  it('403 cap_exceeded: the day’s searches are used, from the payload', async () => {
    mockEdge.network.answer(() =>
      json(403, { error: 'cap_exceeded', cap: 'route_searches', limit: 30, message: 'm' }),
    );
    await openSearch();
    await search('JFK', 'LHR');
    expect(
      await screen.findByText(
        'Route searches are limited to 30 a day, and today’s are used up. Search again tomorrow, or add the flight by its number.',
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId('route-search-results')).toBeNull();
    expect(mockEdge.network.requests).toHaveLength(1);
  });

  it('429: says to wait for the seconds Retry-After gives', async () => {
    mockEdge.network.answer(() =>
      json(429, { error: 'rate_limited', message: 'm' }, { 'Retry-After': '20' }),
    );
    await openSearch();
    await search('JFK', 'LHR');
    expect(
      await screen.findByText(
        'Too many searches in a short time. Wait 20 seconds and search again.',
      ),
    ).toBeTruthy();
  });

  it.each([
    [404, { error: 'airport_not_found' }, 'No airport was found for JFK or LHR. Check the codes.'],
    [
      404,
      { error: 'board_not_covered' },
      'Flight data does not cover JFK, so its flights cannot be searched.',
    ],
    [
      422,
      { error: 'date_out_of_range', maxDaysAhead: 7 },
      'Flights can be searched up to 7 days ahead, and not long past.',
    ],
  ] as const)('%p %j: %s', async (status, body, text) => {
    mockEdge.network.answer(() => json(status, { ...body, message: 'm' }));
    await openSearch();
    await search('JFK', 'LHR');
    expect(await screen.findByText(text)).toBeTruthy();
  });

  it('asks the same search again only after a failure', async () => {
    mockEdge.network.answer(() => json(503, { error: 'board_unavailable', message: 'm' }));
    await openSearch();
    await search('JFK', 'LHR');
    await screen.findByText('Flight data is unavailable right now. Search again in a minute.');
    mockEdge.network.answer(() => json(200, routeAnswer()));
    await fireEvent.press(screen.getByTestId('route-search-submit'));
    await screen.findByTestId('route-search-results');
    expect(screen.queryByTestId('route-search-error')).toBeNull();
    // Answered and fresh: the same search again costs nothing.
    await fireEvent.press(screen.getByTestId('route-search-submit'));
    expect(urls()).toEqual([`GET ${SEARCH_URL}`, `GET ${SEARCH_URL}`]);
  });
});

describe('offline', () => {
  it('says the search waits for the network instead of an empty list, then runs it', async () => {
    onlineManager.setOnline(false);
    await openSearch();
    await search('JFK', 'LHR');
    expect(
      screen.getByText('You are offline. The search runs when the phone is back online.'),
    ).toBeTruthy();
    expect(screen.queryByTestId('route-search-results')).toBeNull();
    expect(screen.queryByTestId('route-search-empty')).toBeNull();
    expect(mockEdge.network.requests).toHaveLength(0);

    mockEdge.network.answer(() => json(200, routeAnswer()));
    await act(() => {
      onlineManager.setOnline(true);
    });
    await screen.findByTestId('route-search-results');
    expect(urls()).toEqual([`GET ${SEARCH_URL}`]);
  });
});

describe('tap to add', () => {
  it("confirms, then adds through the outbox with the row's origin", async () => {
    mockEdge.network.answer(() =>
      json(
        200,
        routeAnswer({
          flights: [boardRow({ add: { number: 'AA100', date: '2026-09-23', origin: 'KJFK' } })],
        }),
      ),
    );
    await openSearch();
    await search('JFK', 'LHR');
    await screen.findByTestId('route-search-results');
    mockEdge.network.answer(() => json(201, { created: true }));
    await fireEvent.press(screen.getByTestId(AA100_ROW));
    const calls = jest.mocked(Alert.alert).mock.calls;
    expect(calls[0]?.[0]).toBe('Add AA100?');
    expect(calls[0]?.[1]).toBe('Wed 23 Sep, JFK to LHR');
    const add = calls[0]?.[2]?.find((button) => button.text === 'Add');
    await act(() => {
      add?.onPress?.();
    });
    expect(await screen.findByText('Added AA100 on Wed 23 Sep to your flights.')).toBeTruthy();
    expect(mockEdge.network.requests[1]?.body).toEqual({
      subscriptionId: expect.any(String) as string,
      number: 'AA100',
      date: '2026-09-23',
      origin: 'KJFK',
    });
    expect(mockEdge.db.raw.prepare('SELECT added_as FROM flight_subscriptions').all()).toEqual([
      { added_as: 'AA100' },
    ]);
  });
});
