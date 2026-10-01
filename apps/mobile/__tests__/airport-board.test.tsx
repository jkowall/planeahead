/**
 * The airport board (increment 18, ruling B12), through the app's REAL services: the screen reads
 * `GET /v1/airports/{code}/board` with TanStack Query through the typed client, and a tapped row
 * is added through `addFlight` and the real outbox (`POST /v1/flights` with the row's designator,
 * origin-local date and origin) exactly as a typed add. Only the edges are replaced, as in
 * add-flight.test.tsx: `fetch`, the store connection, the session cookie, the install id and the
 * runtime config.
 *
 * Covered: both directions from mocked answers, the "as of" time, the stale, partial and
 * schedules-only states, light and dark, pull to refresh, offline (said, never an empty list,
 * no request), tap to add (and the row that cannot be added), the 403 `board_requires_account`
 * and 429 answers, and that nothing of the board reaches the offline store. The add sheet's
 * airport field is offered to signed-in users only.
 */

import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Alert, View } from 'react-native';
import AddFlightSheet from '../src/app/(app)/add';
import AirportBoardScreen from '../src/app/(app)/airport/[code]';
import { BoardRow } from '../src/components/BoardRow';
import type { SqliteLike } from '../src/lib/db/sqlite-like';
import { displayPrefsOf } from '../src/lib/display-prefs';
import { useFlightNotices } from '../src/lib/flight-notices';
import * as format from '../src/lib/format';
import { useSettings } from '../src/lib/settings';
import { DARK, LIGHT } from '../src/theme/tokens';
import { compactTree } from './support/compact-tree';
import { createMemorySqlite, type MemorySqlite } from './support/memory-sqlite';
import { NOW, json, scriptedFetch } from './support/flight-fixtures';
import { boardAnswer, boardRow, departedRow, unaddableRow } from './support/board-fixtures';

const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn() };
const mockParams: { code: string; direction?: string } = { code: 'JFK' };
const mockSession: { current: unknown } = { current: null };
const mockEdge: { db: MemorySqlite; network: ReturnType<typeof scriptedFetch> } = {
  db: createMemorySqlite(),
  network: scriptedFetch(),
};

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockParams,
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

const SIGNED_IN = { user: { id: 'user-1', isAnonymous: false } };
const ANONYMOUS = { user: { id: 'anon-1', isAnonymous: true } };

async function renderWithQueries(element: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 2, staleTime: 30_000, gcTime: Infinity } },
  });
  await render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
  return client;
}

async function openBoard(code = 'JFK', direction?: string) {
  mockParams.code = code;
  if (direction === undefined) {
    delete mockParams.direction;
  } else {
    mockParams.direction = direction;
  }
  return renderWithQueries(<AirportBoardScreen />);
}

function pull(testID: string): void {
  const scroll = screen.getByTestId(testID);
  const control = scroll.props.refreshControl as ReactElement<{ onRefresh: () => void }>;
  control.props.onRefresh();
}

/** The buttons of the last confirmation shown, and its title and message. */
function lastAlert() {
  const calls = jest.mocked(Alert.alert).mock.calls;
  const call = calls[calls.length - 1];
  return {
    title: call?.[0],
    message: call?.[1],
    buttons: call?.[2] ?? [],
  };
}

function requestLine(index: number): string {
  const request = mockEdge.network.requests[index];
  return `${request?.method ?? ''} ${request?.url ?? ''}`;
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
  mockSession.current = SIGNED_IN;
  mockRouter.push.mockClear();
  mockRouter.replace.mockClear();
  useFlightNotices.getState().clear();
  useSettings.getState().reset();
});

afterEach(() => {
  onlineManager.setOnline(true);
});

describe('the board, from the route', () => {
  it('reads the departures through the typed client and shows them in the airport time', async () => {
    mockEdge.network.answer(() => json(200, boardAnswer()));
    await openBoard('jfk');
    await screen.findByTestId('board-rows');

    expect(mockEdge.network.requests).toHaveLength(1);
    expect(requestLine(0)).toBe(
      'GET https://api.planeahead.test/v1/airports/JFK/board?direction=departures',
    );
    expect(mockEdge.network.requests[0]?.headers.get('Cookie')).toBe(
      'better-auth.session_token=session-abc',
    );
    expect(screen.getByText('John F Kennedy International')).toBeTruthy();
    expect(screen.getByTestId('board-codes').props.children).toBe('JFK (KJFK)');
    expect(screen.getByTestId('board-as-of').props.children).toBe('As of 9:58 AM (2 min ago)');
    expect(screen.getByText('Departures, 9:00 AM to 9:00 PM')).toBeTruthy();
    expect(screen.getByTestId('board-departures').props.accessibilityState).toMatchObject({
      selected: true,
    });

    const aa100 = screen.getByTestId('board-row-dep:AA100:2026-09-23T22:00:00Z');
    expect(aa100.props.accessibilityLabel).toBe(
      'AA100, to LHR, scheduled 6:00 PM, expected 6:25 PM, status Scheduled, Terminal 8, gate 12, also sold as BA1511, IB4218',
    );
    expect(aa100.props.accessibilityHint).toBe('Adds this flight to your list');
    expect(screen.getByText('Expected 6:25 PM')).toBeTruthy();
    expect(screen.getByText('Terminal 8, gate 12. Also BA1511, IB4218')).toBeTruthy();
    const dl1 = screen.getByTestId('board-row-dep:DL1:2026-09-23T15:00:00Z');
    expect(dl1.props.accessibilityLabel).toBe(
      'DL1, to LAX, scheduled 11:00 AM, departed 11:05 AM, status Departed, Terminal 4, gate B30',
    );
    expect(screen.queryByTestId('board-stale')).toBeNull();
    expect(screen.queryByTestId('board-partial')).toBeNull();
    expect(screen.queryByTestId('board-schedules-only')).toBeNull();
  });

  it('opens on arrivals when asked, and switches direction with the tabs', async () => {
    mockEdge.network.answer(() =>
      json(200, boardAnswer({ direction: 'arrivals', rows: [departedRow()] })),
    );
    await openBoard('KJFK', 'arrivals');
    await screen.findByTestId('board-rows');
    expect(requestLine(0)).toBe(
      'GET https://api.planeahead.test/v1/airports/KJFK/board?direction=arrivals',
    );
    // On an arrivals board the counterpart is where the flight comes from, and its actual time
    // is the in-block time: it arrived, not landed (R15).
    expect(
      screen.getByTestId('board-row-dep:DL1:2026-09-23T15:00:00Z').props.accessibilityLabel,
    ).toMatch(/^DL1, from LAX, scheduled 11:00 AM, arrived 11:05 AM,/);
    expect(screen.getByText('Arrived 11:05 AM')).toBeTruthy();
    expect(screen.queryByText(/Landed/)).toBeNull();

    mockEdge.network.answer(() => json(200, boardAnswer({ rows: [] })));
    await fireEvent.press(screen.getByTestId('board-departures'));
    await screen.findByTestId('board-empty');
    expect(requestLine(1)).toBe(
      'GET https://api.planeahead.test/v1/airports/KJFK/board?direction=departures',
    );
    expect(screen.getByTestId('board-empty').props.children).toBe(
      'No departures in this time range.',
    );
  });
});

describe('what the answer says about its data', () => {
  it('says a stale and partial board is so, and badges a schedules-only airport', async () => {
    mockEdge.network.answer(() =>
      json(
        200,
        boardAnswer({
          stale: true,
          partial: true,
          coverage: 'schedules_only',
          fetchedAt: '2026-09-23T12:40:00.000Z',
        }),
      ),
    );
    await openBoard();
    await screen.findByTestId('board-rows');
    expect(screen.getByTestId('board-as-of').props.children).toBe('As of 8:40 AM (1 h ago)');
    expect(screen.getByTestId('board-stale')).toBeTruthy();
    expect(screen.getByTestId('board-partial')).toBeTruthy();
    expect(screen.getByTestId('board-schedules-only').props.accessibilityLabel).toBe(
      'Schedules only: the times are the published schedule, with no live status',
    );
  });

  it('asks again on a pull, once per gesture', async () => {
    mockEdge.network.answer(() => json(200, boardAnswer({ stale: true })));
    await openBoard();
    await screen.findByTestId('board-stale');
    mockEdge.network.answer(() =>
      json(200, boardAnswer({ fetchedAt: '2026-09-23T14:00:00.000Z' })),
    );
    await act(() => {
      pull('airport-board');
      pull('airport-board');
    });
    await waitFor(() => {
      expect(screen.queryByTestId('board-stale')).toBeNull();
    });
    expect(mockEdge.network.requests).toHaveLength(2);
    expect(screen.getByTestId('board-as-of').props.children).toBe('As of 10:00 AM (just now)');
  });
});

describe('the board in light and dark', () => {
  it.each([
    ['light', LIGHT],
    ['dark', DARK],
  ] as const)('renders from a mocked answer in %s', async (appearance, tokens) => {
    useSettings.getState().setAppearance(appearance);
    mockEdge.network.answer(() => json(200, boardAnswer({ coverage: 'schedules_only' })));
    await openBoard();
    await screen.findByTestId('board-rows');
    expect(compactTree(screen.toJSON())).toMatchSnapshot();
    expect(screen.getByTestId('board-schedules-only').props.style).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          backgroundColor: tokens.color.surface,
          borderColor: tokens.color.inputBorder,
        }),
      ]),
    );
    expect(screen.getByText('Expected 6:25 PM').props.style).toMatchObject({
      color: tokens.color.warning,
    });
  });
});

describe('offline', () => {
  it('says so instead of an empty list, asks nothing, and loads once back online', async () => {
    onlineManager.setOnline(false);
    await openBoard();
    expect(
      await screen.findByText('You are offline. The board loads when the phone is back online.'),
    ).toBeTruthy();
    expect(screen.getByTestId('board-offline')).toBeTruthy();
    expect(screen.queryByTestId('board-rows')).toBeNull();
    expect(screen.queryByTestId('board-empty')).toBeNull();
    expect(screen.queryByTestId('board-error')).toBeNull();
    expect(mockEdge.network.requests).toHaveLength(0);

    mockEdge.network.answer(() => json(200, boardAnswer()));
    await act(() => {
      onlineManager.setOnline(true);
    });
    await screen.findByTestId('board-rows');
    expect(mockEdge.network.requests).toHaveLength(1);
  });

  it('keeps a loaded board on screen offline, says so, and a pull asks nothing', async () => {
    mockEdge.network.answer(() => json(200, boardAnswer()));
    await openBoard();
    await screen.findByTestId('board-rows');
    await act(() => {
      onlineManager.setOnline(false);
    });
    expect(
      screen.getByText('You are offline. This is the last answer loaded, as of 9:58 AM.'),
    ).toBeTruthy();
    await act(() => {
      pull('airport-board');
    });
    expect(mockEdge.network.requests).toHaveLength(1);
    expect(screen.getByTestId('board-rows')).toBeTruthy();
  });

  it('says a request that got no answer could not reach PlaneAhead', async () => {
    mockEdge.network.answer(() => {
      throw new TypeError('Network request failed');
    });
    await openBoard();
    expect(
      await screen.findByText(
        'Could not reach PlaneAhead. Check your connection and pull down to try again.',
      ),
    ).toBeTruthy();
    // Never retried on its own: a pull asks again.
    expect(mockEdge.network.requests).toHaveLength(1);
  });
});

const AA100_ROW = 'board-row-dep:AA100:2026-09-23T22:00:00Z';

function storedRows(db: MemorySqlite) {
  return db.raw.prepare('SELECT flight_key, added_as FROM flight_subscriptions').all() as {
    flight_key: string;
    added_as: string | null;
  }[];
}

/** Presses a row, then the confirmation's `Add` (or `Cancel`). */
async function tapToAdd(testID: string, choice: 'Add' | 'Cancel' = 'Add') {
  await fireEvent.press(screen.getByTestId(testID));
  const button = lastAlert().buttons.find((candidate) => candidate.text === choice);
  await act(() => {
    button?.onPress?.();
  });
}

describe('tap to add, through the one add path', () => {
  beforeEach(async () => {
    mockEdge.network.answer(() => json(200, boardAnswer()));
    await openBoard();
    await screen.findByTestId('board-rows');
  });

  it("confirms, then sends POST /v1/flights with the row's add through the outbox", async () => {
    mockEdge.network.answer(() => json(201, { created: true }));
    await tapToAdd(AA100_ROW);
    expect(lastAlert().title).toBe('Add AA100?');
    expect(lastAlert().message).toBe('Wed 23 Sep, JFK to LHR');
    expect(await screen.findByText('Added AA100 on Wed 23 Sep to your flights.')).toBeTruthy();

    expect(requestLine(1)).toBe('POST https://api.planeahead.test/v1/flights');
    const post = mockEdge.network.requests[1];
    expect(post?.body).toEqual({
      subscriptionId: expect.any(String) as string,
      number: 'AA100',
      date: '2026-09-23',
      origin: 'KJFK',
    });
    expect(post?.headers.get('Idempotency-Key')).toEqual(expect.any(String));
    expect(post?.headers.get('X-Install-Id')).toBe('install-0123456789');
    // The optimistic row, as for a typed add; the board itself is never stored.
    expect(storedRows(mockEdge.db)).toEqual([
      { flight_key: expect.any(String) as string, added_as: 'AA100' },
    ]);
    expect(mockEdge.db.raw.prepare('SELECT COUNT(*) AS n FROM outbox').get()).toEqual({ n: 0 });

    await tapToAdd(AA100_ROW);
    expect(await screen.findByText('You already track AA100 on Wed 23 Sep.')).toBeTruthy();
    expect(mockEdge.network.requests).toHaveLength(2);
  });

  it('says a refusal in place, from the payload, and removes the optimistic row', async () => {
    mockEdge.network.answer(() =>
      json(403, { error: 'cap_exceeded', cap: 'active_subscriptions', limit: 3, message: 'm' }),
    );
    await tapToAdd(AA100_ROW);
    expect(
      await screen.findByText(
        'The free plan tracks up to 3 flights at a time. Remove a flight to add another.',
      ),
    ).toBeTruthy();
    expect(storedRows(mockEdge.db)).toEqual([]);
  });

  it('adds nothing on Cancel, and a row without a date cannot be pressed', async () => {
    await tapToAdd(AA100_ROW, 'Cancel');
    expect(storedRows(mockEdge.db)).toEqual([]);
    jest.mocked(Alert.alert).mockClear();
    const unaddable = screen.getByTestId(`board-row-${unaddableRow().id}`);
    expect(unaddable.props.accessibilityState).toMatchObject({ disabled: true });
    expect(unaddable.props.accessibilityLabel).toMatch(/cannot be added here$/);
    await fireEvent.press(unaddable);
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(mockEdge.network.requests).toHaveLength(1);
  });
});

describe("the route's refusals", () => {
  it('403 board_requires_account: says why, offers sign-in, and asks only once', async () => {
    mockSession.current = ANONYMOUS;
    mockEdge.network.answer(() =>
      json(403, { error: 'board_requires_account', message: 'm', requestId: 'r' }),
    );
    await openBoard('ATL');
    expect(
      await screen.findByText(
        'Without an account, boards open only for the airports of your flights. Sign in to open any airport’s board.',
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId('board-rows')).toBeNull();
    await fireEvent.press(screen.getByTestId('board-sign-in'));
    expect(mockRouter.push).toHaveBeenCalledWith('/sign-in');
    expect(mockEdge.network.requests).toHaveLength(1);
  });

  it('429: says to wait, from Retry-After', async () => {
    mockEdge.network.answer(() =>
      json(429, { error: 'rate_limited', message: 'm', requestId: 'r' }, { 'Retry-After': '60' }),
    );
    await openBoard();
    expect(
      await screen.findByText(
        'Too many boards opened in a short time. Wait a minute and pull down to try again.',
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId('board-sign-in')).toBeNull();
    expect(mockEdge.network.requests).toHaveLength(1);
  });

  it.each([
    [404, 'board_not_covered', 'Flight data does not cover JFK, so it has no board.'],
    [404, 'airport_not_found', 'No airport has the code JFK.'],
    [
      503,
      'board_unavailable',
      'Flight data is unavailable right now. Pull down to try again in a minute.',
    ],
    [504, 'upstream_timeout', 'The board took too long to load. Pull down to try again.'],
  ] as const)('%p %s: %s', async (status, error, text) => {
    mockEdge.network.answer(() => json(status, { error, message: 'm', requestId: 'r' }));
    await openBoard();
    expect(await screen.findByText(text)).toBeTruthy();
    expect(mockEdge.network.requests).toHaveLength(1);
  });
});

describe('while boards are off (R8)', () => {
  it('says boards are not available yet, as news and not as an error', async () => {
    mockEdge.network.answer(() =>
      json(404, {
        error: 'boards_disabled',
        message: 'airport boards are not available yet',
        requestId: 'r',
      }),
    );
    await openBoard();
    const notice = await screen.findByTestId('board-disabled');
    expect(screen.getByText('Airport boards are not available yet.')).toBeTruthy();
    expect(notice.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ borderColor: LIGHT.color.accent })]),
    );
    expect(screen.queryByTestId('board-error')).toBeNull();
    expect(screen.queryByTestId('board-rows')).toBeNull();
    expect(mockEdge.network.requests).toHaveLength(1);
  });
});

/** `count` departures a minute apart from 9:00 AM in New York, AA1000 onwards. */
function hubRows(count: number) {
  const start = Date.parse('2026-09-23T13:00:00Z');
  return Array.from({ length: count }, (_, index) => {
    const designator = `AA${String(1000 + index)}`;
    const scheduled = new Date(start + index * 60_000).toISOString().replace('.000Z', 'Z');
    return boardRow({
      id: `dep:${designator}:${scheduled}`,
      designator,
      codeshares: [],
      scheduled,
      estimated: scheduled,
      add: { number: designator, date: '2026-09-23', origin: 'KJFK' },
    });
  });
}

describe('a hub board (R13)', () => {
  it('renders a 700-row board as a list that mounts only the rows near the screen', async () => {
    const rows = hubRows(700);
    mockEdge.network.answer(() => json(200, boardAnswer({ rows })));
    await openBoard('ATL');
    await screen.findByTestId('board-rows');
    // The rows (not their status pills), in the board's order, from the first.
    const mounted = screen.getAllByTestId(/^board-row-dep:AA\d+:\S+Z$/);
    expect(mounted.length).toBeGreaterThanOrEqual(10);
    expect(mounted.length).toBeLessThan(100);
    expect(mounted.map((row) => row.props.testID as string)).toEqual(
      rows.slice(0, mounted.length).map((row) => `board-row-${row.id}`),
    );
    expect(screen.getByText('AA1000  to LHR')).toBeTruthy();
    expect(screen.queryByText('AA1699  to LHR')).toBeNull();
  });

  it('renders no row again when the screen renders for something else', async () => {
    mockEdge.network.answer(() => json(200, boardAnswer()));
    await openBoard();
    await screen.findByTestId('board-rows');
    // Going offline renders the screen again (the freshness says so); no row's props change, so
    // the screen's `onAdd` and display preferences must be the same objects as before.
    const label = jest.spyOn(format, 'statusLabel');
    await act(() => {
      onlineManager.setOnline(false);
    });
    expect(screen.getByTestId('board-offline-copy')).toBeTruthy();
    expect(label).not.toHaveBeenCalled();
    label.mockRestore();
  });

  it('renders a row again only when its own props change: it is memoised', async () => {
    // Each render of a row reads its status label; a parent's render with equal props must not.
    const label = jest.spyOn(format, 'statusLabel');
    const prefs = displayPrefsOf({ timeFormat: '12h', distanceUnit: 'km', showLocalTimes: true });
    const row = boardRow();
    const onAdd = jest.fn();
    const element = (adding: boolean) => (
      <View>
        <BoardRow
          row={row}
          direction="departures"
          tz="America/New_York"
          prefs={prefs}
          adding={adding}
          disabled={false}
          onAdd={onAdd}
        />
      </View>
    );
    const { rerender } = await render(element(false));
    const first = label.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    await rerender(element(false));
    expect(label.mock.calls.length).toBe(first);
    await rerender(element(true));
    expect(label.mock.calls.length).toBeGreaterThan(first);
    label.mockRestore();
  });
});

describe('what a row says (R15)', () => {
  it('draws a row that cannot be added muted, and a cancelled one with no expected time', async () => {
    const cancelled = boardRow({
      id: 'dep:AA200:2026-09-23T20:00:00Z',
      designator: 'AA200',
      codeshares: [],
      status: 'cancelled',
      scheduled: '2026-09-23T20:00:00Z',
      estimated: '2026-09-23T20:30:00Z',
      add: { number: 'AA200', date: '2026-09-23', origin: 'KJFK' },
    });
    mockEdge.network.answer(() =>
      json(200, boardAnswer({ rows: [unaddableRow(), cancelled, boardRow()] })),
    );
    await openBoard();
    await screen.findByTestId('board-rows');
    const colorOf = (text: string) =>
      (screen.getByText(text).props.style as { color?: string }[]).find(
        (part) => part.color !== undefined,
      )?.color;
    expect([colorOf('12:00 PM'), colorOf('ZZ999  to KBOS')]).toEqual([
      LIGHT.color.textMuted,
      LIGHT.color.textMuted,
    ]);
    expect([colorOf('6:00 PM'), colorOf('AA100  to LHR')]).toEqual([
      LIGHT.color.text,
      LIGHT.color.text,
    ]);
    expect(screen.getByTestId(`board-row-${unaddableRow().id}-unaddable`).props.children).toBe(
      'Cannot be added here. Add it by its flight number.',
    );
    expect(screen.queryByTestId(`board-row-${boardRow().id}-unaddable`)).toBeNull();
    // The cancelled flight kept an estimate of 4:30 PM; it is not shown or said.
    expect(screen.queryByText('Expected 4:30 PM')).toBeNull();
    expect(screen.getByTestId(`board-row-${cancelled.id}`).props.accessibilityLabel).toBe(
      'AA200, to LHR, scheduled 4:00 PM, status Cancelled, Terminal 8, gate 12',
    );
  });
});

describe("the add sheet's airport field (signed-in users only)", () => {
  it('opens the board of the code typed, in place of the sheet', async () => {
    await renderWithQueries(<AddFlightSheet />);
    await fireEvent.changeText(screen.getByTestId('add-flight-airport'), ' katl ');
    await fireEvent.press(screen.getByTestId('add-flight-open-board'));
    expect(mockRouter.replace).toHaveBeenCalledWith({
      pathname: '/airport/[code]',
      params: { code: 'KATL' },
    });
    expect(mockEdge.network.requests).toHaveLength(0);
  });

  it('refuses a code that is not an airport code, in place', async () => {
    await renderWithQueries(<AddFlightSheet />);
    await fireEvent.changeText(screen.getByTestId('add-flight-airport'), 'JF');
    await fireEvent.press(screen.getByTestId('add-flight-open-board'));
    expect(screen.getByTestId('add-flight-airport-error').props.children).toBe(
      'Use a 3-letter IATA or 4-letter ICAO airport code, e.g. JFK or KJFK.',
    );
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it.each([
    ['an anonymous account', ANONYMOUS],
    ['a session still being read', null],
  ])('is not offered to %s, while the route search is', async (_name, session) => {
    mockSession.current = session;
    await renderWithQueries(<AddFlightSheet />);
    expect(screen.queryByTestId('add-flight-airport')).toBeNull();
    expect(screen.queryByTestId('add-flight-open-board')).toBeNull();
    await fireEvent.press(screen.getByTestId('add-flight-route-search'));
    expect(mockRouter.push).toHaveBeenCalledWith('/route-search');
  });

  it('is offered with the route search to a signed-in user', async () => {
    await renderWithQueries(<AddFlightSheet />);
    expect(screen.getByTestId('add-flight-airport')).toBeTruthy();
    expect(screen.getByTestId('add-flight-route-search').props.accessibilityLabel).toBe(
      'Find a flight by route',
    );
  });
});
