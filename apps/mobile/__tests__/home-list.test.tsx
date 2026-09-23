/**
 * The home screen from a seeded store (increment 10 acceptance, ruling T5): the store is filled by
 * the real page apply over the in-memory SQLite, the screen reads it through the increment 9 live
 * query, and the tests assert what a person sees. The next flight by scheduled departure with its
 * status pill, gate and terminal, times in the user's format, and a countdown that ticks once a
 * minute on its own interval; then the rest of the list; the empty state with the add button; a
 * pending add; a refused add's notice; pull to refresh at most once per gesture; light and dark
 * snapshots through the theme tokens.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import HomeScreen from '../src/app/(app)/index';
import { Countdown } from '../src/components/Countdown';
import { StoreProvider } from '../src/lib/db/store-context';
import { useFlightNotices } from '../src/lib/flight-notices';
import { addFlight } from '../src/lib/flights';
import { syncNow } from '../src/lib/session';
import { useSettings } from '../src/lib/settings';
import { DARK, LIGHT } from '../src/theme/tokens';
import { compactTree } from './support/compact-tree';
import { createMemorySqlite, type MemorySqlite } from './support/memory-sqlite';
import { AA100_ID, BA117_ID, DL1_ID, NOW, seedStore } from './support/flight-fixtures';

const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn() };
let mockSession: unknown = {
  user: { id: 'user-1', isAnonymous: false, email: 'ada@example.com' },
};

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({}),
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});

jest.mock('../src/lib/db/kv', () =>
  jest.requireActual<typeof import('./support/memory-kv')>('./support/memory-kv').memoryKvModule(),
);

jest.mock('../src/lib/auth-client', () => ({
  isAnonymousSession:
    jest.requireActual<typeof import('../src/lib/auth-session')>('../src/lib/auth-session')
      .isAnonymousSession,
  authClient: { useSession: () => ({ data: mockSession, isPending: false }) },
}));

jest.mock('../src/lib/session', () => ({ syncNow: jest.fn(() => Promise.resolve()) }));

async function renderHome(db: MemorySqlite) {
  await render(
    <StoreProvider value={db}>
      <HomeScreen />
    </StoreProvider>,
  );
}

function seeded(aa100: Record<string, unknown> = {}): MemorySqlite {
  const db = createMemorySqlite();
  seedStore(db, aa100);
  return db;
}

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  useSettings.getState().reset();
  useFlightNotices.getState().clear();
  mockSession = { user: { id: 'user-1', isAnonymous: false, email: 'ada@example.com' } };
});

describe('home, from a seeded store', () => {
  it('shows the next flight with its status pill, gate, times and countdown', async () => {
    await renderHome(seeded());
    const hero = await screen.findByTestId('home-next-flight');
    const card = within(hero);

    expect(card.getByText('AA100  JFK → LHR')).toBeOnTheScreen();
    expect(card.getByText('Wed 23 Sep')).toBeOnTheScreen();
    // Estimated 22:25Z is 6:25 PM in New York; the arrival 06:10Z is 7:10 AM in London, next day.
    expect(card.getByTestId('home-next-departure')).toHaveTextContent('6:25 PM');
    expect(card.getByTestId('home-next-arrival')).toHaveTextContent('→ 7:10 AM +1');
    expect(card.getByTestId('home-next-gate')).toHaveTextContent('Terminal 8, gate B22');
    expect(card.getByText('Departure 25 min late')).toBeOnTheScreen();
    expect(card.getByTestId('home-countdown')).toHaveTextContent('Departs in 8 h 25 min');
    expect(card.getByTestId(`flight-${AA100_ID}-status`)).toHaveProp(
      'accessibilityLabel',
      'Status: Scheduled',
    );
  });

  it('lists the rest after it: upcoming first, past flights last', async () => {
    await renderHome(seeded());
    const rest = within(await screen.findByTestId('home-rest'));
    const rows = rest.getAllByTestId(/^flight-row-/).map((row) => String(row.props.testID));
    expect(rows).toEqual([`flight-row-${BA117_ID}`, `flight-row-${DL1_ID}`]);
    expect(rest.getByText('BA117  LHR → JFK')).toBeOnTheScreen();
    expect(rest.getByText('Fri 25 Sep, 12:20 PM')).toBeOnTheScreen();
    expect(rest.getByTestId(`flight-${DL1_ID}-status`)).toHaveProp(
      'accessibilityLabel',
      'Status: Arrived',
    );
  });

  it('renders from the store alone: no network request at all (an offline relaunch)', async () => {
    const offline = jest.fn(() => Promise.reject(new TypeError('Network request failed')));
    globalThis.fetch = offline;
    await renderHome(seeded());
    expect(await screen.findByTestId('home-next-flight')).toBeOnTheScreen();
    expect(within(screen.getByTestId('home-rest')).getAllByTestId(/^flight-row-/)).toHaveLength(2);
    expect(offline).not.toHaveBeenCalled();
  });

  it('shows the times in the 24 h format when the settings store says so', async () => {
    useSettings.getState().updatePreferences({ timeFormat: '24h' });
    await renderHome(seeded());
    const hero = within(await screen.findByTestId('home-next-flight'));
    expect(hero.getByTestId('home-next-departure')).toHaveTextContent('18:25');
    expect(hero.getByTestId('home-next-arrival')).toHaveTextContent('→ 07:10 +1');
  });

  it('opens a flight, the add sheet and settings', async () => {
    await renderHome(seeded());
    await fireEvent.press(await screen.findByTestId('home-next-flight'));
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/flight/[id]',
      params: { id: AA100_ID },
    });
    await fireEvent.press(screen.getByTestId('home-add'));
    expect(mockRouter.push).toHaveBeenCalledWith('/add');
    await fireEvent.press(screen.getByTestId('home-settings'));
    expect(mockRouter.push).toHaveBeenCalledWith('/settings');
  });

  it('shows the empty state with the add button when there is no flight', async () => {
    await renderHome(createMemorySqlite());
    expect(await screen.findByTestId('home-empty')).toHaveTextContent(/No flights yet/);
    expect(screen.queryByTestId('home-next-flight')).toBeNull();
    await fireEvent.press(screen.getByTestId('home-empty-add'));
    expect(mockRouter.push).toHaveBeenCalledWith('/add');
  });

  it('says "no upcoming flights" when only past flights remain', async () => {
    const db = createMemorySqlite();
    seedStore(db, { status: 'cancelled' });
    db.run('DELETE FROM flight_subscriptions WHERE id = ?', [BA117_ID]);
    await renderHome(db);
    expect(await screen.findByTestId('home-empty')).toHaveTextContent(/No upcoming flights/);
  });

  it('shows an add the outbox has not sent yet as "Adding", live from the store signal', async () => {
    const db = seeded();
    await renderHome(db);
    await screen.findByTestId('home-next-flight');
    let id = '';
    await act(async () => {
      const added = addFlight(db, { designator: 'UA901', date: '2026-09-24' });
      id = added.subscriptionId;
      await Promise.resolve();
    });
    const row = await screen.findByTestId(`flight-row-${id}`);
    expect(row).toHaveTextContent(/UA901/);
    expect(row).toHaveTextContent(/Thu 24 Sep, looking up the flight/);
    expect(within(row).getByTestId(`flight-${id}-status`)).toHaveProp(
      'accessibilityLabel',
      'Status: Adding',
    );
  });

  it('shows a refused add as a notice until it is dismissed', async () => {
    useFlightNotices.getState().push({
      id: 'sub-1',
      message: 'The free plan tracks up to 5 flights at a time. Remove a flight to add another.',
    });
    await renderHome(seeded());
    const notice = await screen.findByTestId('home-notice-sub-1');
    expect(notice).toHaveTextContent(/up to 5 flights/);
    await fireEvent.press(screen.getByTestId('home-notice-sub-1-dismiss'));
    expect(screen.queryByTestId('home-notice-sub-1')).toBeNull();
  });

  it('offers sign-in to an anonymous session', async () => {
    mockSession = { user: { id: 'anon-1', isAnonymous: true, email: 'x@planeahead.invalid' } };
    await renderHome(seeded());
    await fireEvent.press(await screen.findByTestId('home-sign-in'));
    expect(mockRouter.push).toHaveBeenCalledWith('/sign-in');
  });

  it('runs one sync per pull gesture: a second pull while the first runs is ignored', async () => {
    let finish: () => void = () => undefined;
    jest.mocked(syncNow).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await renderHome(seeded());
    await screen.findByTestId('home-next-flight');
    const scroll = screen.getByTestId('home-screen');
    const refreshControl = scroll.props.refreshControl as ReactElement<{ onRefresh: () => void }>;
    await act(async () => {
      refreshControl.props.onRefresh();
      refreshControl.props.onRefresh();
      await Promise.resolve();
    });
    expect(syncNow).toHaveBeenCalledTimes(1);
    expect(syncNow).toHaveBeenCalledWith('user-1');
    await act(async () => {
      finish();
      await Promise.resolve();
    });
    const again = screen.getByTestId('home-screen').props.refreshControl as ReactElement<{
      onRefresh: () => void;
    }>;
    await act(async () => {
      again.props.onRefresh();
      await Promise.resolve();
    });
    expect(syncNow).toHaveBeenCalledTimes(2);
  });
});

describe('home, light and dark (theme tokens)', () => {
  it.each([
    ['light', LIGHT.color.background],
    ['dark', DARK.color.background],
  ] as const)('renders the seeded list in %s', async (appearance, background) => {
    useSettings.getState().setAppearance(appearance);
    await renderHome(seeded());
    await screen.findByTestId('home-next-flight');
    expect(compactTree(screen.toJSON())).toMatchSnapshot();
    const safeArea = screen.getByTestId('home-screen').parent;
    expect(safeArea?.props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ backgroundColor: background })]),
    );
  });

  it.each(['light', 'dark'] as const)('renders the empty state in %s', async (appearance) => {
    useSettings.getState().setAppearance(appearance);
    await renderHome(createMemorySqlite());
    await screen.findByTestId('home-empty');
    expect(compactTree(screen.toJSON())).toMatchSnapshot();
  });
});

describe('Countdown', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('ticks once a minute on its own interval and clears it on unmount', async () => {
    jest.restoreAllMocks();
    jest.useFakeTimers({ now: NOW });
    const setIntervalSpy = jest.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = jest.spyOn(globalThis, 'clearInterval');
    const view = await render(<Countdown at="2026-09-23T14:02:00Z" kind="departs" />);
    expect(screen.getByText('Departs in 2 min')).toBeOnTheScreen();
    const ticks = setIntervalSpy.mock.calls
      .map((call, index) => ({
        ms: call[1],
        id: setIntervalSpy.mock.results[index]?.value as unknown,
      }))
      .filter((call) => call.ms === 60_000);
    expect(ticks).toHaveLength(1);

    await act(async () => {
      jest.advanceTimersByTime(59_000);
      await Promise.resolve();
    });
    expect(screen.getByText('Departs in 2 min')).toBeOnTheScreen();

    await act(async () => {
      jest.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    expect(screen.getByText('Departs in 1 min')).toBeOnTheScreen();

    await act(async () => {
      jest.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    expect(screen.getByText('Departing now')).toBeOnTheScreen();

    await view.unmount();
    expect(clearIntervalSpy).toHaveBeenCalledWith(ticks[0]?.id);
  });
});
