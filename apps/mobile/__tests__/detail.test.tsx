/**
 * The flight detail (increment 10): the timeline from a seeded snapshot (ruling T4) in the user's
 * time format and units, the gates, baggage, aircraft, distance and the provider attribution; the
 * refresh (ruling T3) through the real typed client to a scripted `fetch`: at most one
 * `POST /v1/flights/:id/refresh` per gesture, the 504 that applies the last known flight and says
 * the refresh is still running, the 410 that marks the flight finished here (with or without a
 * flight in the answer), the 401 `account_deleted` that runs the app's `forgetAccount` path, a null
 * or older snapshot that never replaces the stored one, and the 8 s deadline UX; unsubscribe
 * through the outbox; the day cue on times past the departure date; the screen following an add
 * the server answered under its own id; role and name assertions; light and dark snapshots.
 */

import * as Sentry from '@sentry/react-native';
import { fireEvent, render, screen, waitFor, act, within } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Alert } from 'react-native';
import FlightDetailScreen from '../src/app/(app)/flight/[id]';
import { createApiClient } from '../src/lib/api-client';
import { StoreProvider } from '../src/lib/db/store-context';
import { listFlights, readFlight } from '../src/lib/flight-queries';
import { addFlight, flightOutboxHooks, REFRESH_GRACE_MS } from '../src/lib/flights';
import { useSettings } from '../src/lib/settings';
import { ApplyGate } from '../src/lib/sync/gate';
import { createOutbox } from '../src/lib/sync/outbox';
import { compactTree } from './support/compact-tree';
import { createMemorySqlite, type MemorySqlite } from './support/memory-sqlite';
import {
  AA100_ID,
  AA100_KEY,
  DL1_ID,
  NOW,
  aa100Snapshot,
  json,
  scriptedFetch,
  seedStore,
} from './support/flight-fixtures';

const mockRouter = { push: jest.fn(), back: jest.fn(), replace: jest.fn() };
const mockParams: { id: string } = { id: AA100_ID };
const mockServices: { current: unknown } = { current: null };

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockParams,
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});

jest.mock('../src/lib/db/kv', () =>
  jest.requireActual<typeof import('./support/memory-kv')>('./support/memory-kv').memoryKvModule(),
);

jest.mock('../src/lib/services', () => ({
  services: () => Promise.resolve(mockServices.current),
}));

interface Harness {
  readonly db: MemorySqlite;
  readonly network: ReturnType<typeof scriptedFetch>;
  readonly outbox: ReturnType<typeof createOutbox>;
  readonly onAccountDeleted: jest.Mock;
}

/** The services the screen uses, over this test's store and network, built like services.ts. */
function harness(aa100: Record<string, unknown> = {}): Harness {
  const db = createMemorySqlite();
  seedStore(db, aa100);
  const network = scriptedFetch();
  const api = createApiClient({
    baseUrl: 'https://api.planeahead.test',
    getCookie: () => Promise.resolve('better-auth.session_token=session-abc'),
    getInstallId: () => 'install-0123456789',
    fetch: network.fetchMock,
  });
  const onAccountDeleted = jest.fn(() => Promise.resolve());
  const outbox = createOutbox({
    db,
    gate: new ApplyGate(),
    transport: { send: (request) => api.request(request) },
    onAccountDeleted,
    ...flightOutboxHooks(db),
  });
  mockServices.current = { store: { sqlite: db }, api, outbox, onAccountDeleted };
  return { db, network, outbox, onAccountDeleted };
}

async function renderDetail(db: MemorySqlite, id: string = AA100_ID) {
  mockParams.id = id;
  await render(
    <StoreProvider value={db}>
      <FlightDetailScreen />
    </StoreProvider>,
  );
  await screen.findByTestId(/^flight-detail/);
}

function refreshView(snapshot: Record<string, unknown> | null) {
  return { key: AA100_KEY, phase: 'scheduled', version: 7, snapshot, source: 'tracker' };
}

function pull(): void {
  const scroll = screen.getByTestId('flight-detail');
  const control = scroll.props.refreshControl as ReactElement<{ onRefresh: () => void }>;
  control.props.onRefresh();
}

function snapshotRow(db: MemorySqlite): {
  origin_gate: string | null;
  snapshot_fetched_at: string;
} {
  return db.raw
    .prepare('SELECT origin_gate, snapshot_fetched_at FROM flight_subscriptions WHERE id = ?')
    .get(AA100_ID) as { origin_gate: string | null; snapshot_fetched_at: string };
}

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  useSettings.getState().reset();
});

describe('the detail timeline, from a seeded snapshot', () => {
  it('shows out, off, on and in with their best times, the scheduled time and the delay', async () => {
    const { db } = harness();
    await renderDetail(db);
    const timeline = within(screen.getByTestId('flight-timeline'));
    expect(timeline.getByTestId('timeline-out-time')).toHaveTextContent('6:25 PM');
    expect(timeline.getByTestId('timeline-off-time')).toHaveTextContent('6:20 PM');
    // Landing and gate arrival are on Thursday in London: the day cue, as on the home card.
    expect(timeline.getByTestId('timeline-on-time')).toHaveTextContent('6:55 AM +1');
    expect(timeline.getByTestId('timeline-in-time')).toHaveTextContent('7:10 AM +1');
    expect(timeline.getByTestId('timeline-out')).toHaveTextContent(
      /estimated, scheduled 6:00 PM, 25 min late, Terminal 8, gate B22/,
    );
    expect(timeline.getByTestId('timeline-in')).toHaveTextContent(/Terminal 3/);
    expect(timeline.queryByTestId('timeline-baggage')).toBeNull();
  });

  it('follows the 24 h format and the metric units from the settings store', async () => {
    useSettings.getState().updatePreferences({ timeFormat: '24h', distanceUnit: 'km' });
    const { db } = harness();
    await renderDetail(db);
    expect(screen.getByTestId('timeline-out-time')).toHaveTextContent('18:25');
    expect(screen.getByTestId('timeline-in-time')).toHaveTextContent('07:10 +1');
    expect(screen.getByTestId('detail-distance')).toHaveTextContent('5,540 km');
  });

  it('shows the header, the details and the provider attribution', async () => {
    const { db } = harness();
    await renderDetail(db);
    expect(screen.getByText('AA100')).toBeOnTheScreen();
    expect(screen.getByText('JFK → LHR')).toBeOnTheScreen();
    expect(screen.getByTestId('detail-status')).toHaveProp(
      'accessibilityLabel',
      'Status: Scheduled',
    );
    expect(screen.getByTestId('detail-origin-gate')).toHaveTextContent('Terminal 8, gate B22');
    expect(screen.getByTestId('detail-destination-gate')).toHaveTextContent('Terminal 3');
    expect(screen.getByTestId('detail-aircraft')).toHaveTextContent('B77W');
    expect(screen.getByTestId('detail-distance')).toHaveTextContent('3,442 mi');
    expect(screen.getByTestId('detail-attribution')).toHaveTextContent(
      'Flight data: AeroDataBox, updated 4 min ago. Times are 12-hour, local to each airport.',
    );
  });

  it('shows a finished trip with its baggage claim and every step done', async () => {
    const { db } = harness();
    await renderDetail(db, DL1_ID);
    expect(screen.getByTestId('timeline-baggage')).toHaveTextContent(/Baggage claim 4/);
    expect(screen.getByTestId('timeline-in-time')).toHaveTextContent('9:41 AM');
    expect(screen.getByTestId('timeline-in')).toHaveTextContent(
      /actual, scheduled 9:50 AM, 9 min early/,
    );
    expect(screen.getByTestId('detail-baggage')).toHaveTextContent('4');
    expect(screen.getByTestId('detail-over')).toHaveTextContent('This flight is over.');
  });

  it('names each step for a screen reader, the day cue and the state in words', async () => {
    const { db } = harness();
    await renderDetail(db);
    expect(screen.getByTestId('timeline-on')).toHaveProp(
      'accessibilityLabel',
      'Landing, 6:55 AM the next day, scheduled, still ahead',
    );
    expect(screen.getByTestId('timeline-out')).toHaveProp(
      'accessibilityLabel',
      'Gate departure, 6:25 PM, estimated, Terminal 8, gate B22, next',
    );
    // The pill is one accessibility element with its own name; the title is a header.
    expect(screen.getByRole('text', { name: 'Status: Scheduled' })).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'AA100' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeOnTheScreen();
  });

  it('puts the day cue on a departure a delay pushed past midnight', async () => {
    // Scheduled 23:30 in New York, estimated 00:40 the next morning.
    const { db } = harness({
      times: {
        scheduledOut: '2026-09-24T03:30:00Z',
        estimatedOut: '2026-09-24T04:40:00Z',
        scheduledIn: '2026-09-24T10:40:00Z',
      },
    });
    await renderDetail(db);
    expect(screen.getByTestId('timeline-out-time')).toHaveTextContent('12:40 AM +1');
    expect(screen.getByTestId('timeline-out')).toHaveTextContent(/scheduled 11:30 PM, 70 min late/);
  });

  it('shows the designator typed on this phone, with the operating one beside it', async () => {
    const { db } = harness({ marketingCarrierIcao: 'BAW', marketingFlightNumber: '1512' });
    db.run("UPDATE flight_subscriptions SET added_as = 'BA1511' WHERE id = ?", [AA100_ID]);
    await renderDetail(db);
    expect(screen.getByRole('header', { name: 'BA1511' })).toBeOnTheScreen();
    expect(screen.getByTestId('detail-operated-as')).toHaveTextContent('Operated as AA100');
    // The snapshot's marketing designator (whoever searched first) is never the name.
    expect(screen.queryByText(/BA1512/)).toBeNull();
  });

  it('follows an add the server answered under its own id instead of saying "not found"', async () => {
    // The snapshot lists no codeshares, so nothing here names BA1511 (ruling Y3): it is queued.
    const { db, network, outbox } = harness({ codeshares: [] });
    // Added here as a codeshare of the tracked AA100, and opened on its own id.
    const added = addFlight(db, { designator: 'BA1511', date: '2026-09-23' });
    expect(added.kind).toBe('queued');
    await renderDetail(db, added.subscriptionId);
    expect(screen.getByTestId('detail-pending')).toBeOnTheScreen();

    network.answer(() =>
      json(200, {
        subscription: {
          id: AA100_ID,
          flightKey: AA100_KEY,
          flightInstanceId: '0199a000-0000-7000-8000-000000000901',
          tripId: null,
          label: null,
          seat: null,
          cabin: null,
          muted: false,
          notificationOverrides: {},
          source: 'app',
          liveTracked: true,
          createdAt: '2026-09-19T12:00:00.000Z',
          updatedAt: '2026-09-19T12:00:00.000Z',
          deletedAt: null,
        },
        flight: refreshView(aa100Snapshot()),
        created: false,
      }),
    );
    await act(async () => {
      await outbox.drain();
    });
    await waitFor(() => {
      expect(screen.queryByTestId('detail-pending')).toBeNull();
    });
    expect(screen.queryByText('Flight not found')).toBeNull();
    expect(screen.getByRole('header', { name: 'AA100' })).toBeOnTheScreen();
    expect(screen.getByText('JFK → LHR')).toBeOnTheScreen();
    expect(listFlights(db).filter((item) => item.flightKey === AA100_KEY)).toHaveLength(1);
  });

  it('says so for a flight that is no longer in the list', async () => {
    const { db } = harness();
    await renderDetail(db, '0199a000-0000-7000-8000-00000000dead');
    expect(screen.getByText('Flight not found')).toBeOnTheScreen();
  });

  it('shows a pending add without a refresh', async () => {
    const { db } = harness();
    const added = addFlight(db, { designator: 'UA901', date: '2026-09-24' });
    await renderDetail(db, added.subscriptionId);
    expect(screen.getByTestId('detail-pending')).toBeOnTheScreen();
    expect(screen.queryByTestId('detail-refresh')).toBeNull();
    expect(screen.getByTestId('flight-detail').props.refreshControl).toBeUndefined();
    // A step without a time is not called "scheduled".
    expect(screen.getByTestId('timeline-out')).toHaveProp(
      'accessibilityLabel',
      'Gate departure, next',
    );
  });
});

describe('refresh (ruling T3)', () => {
  it('calls the refresh route at most once per gesture and applies the answer', async () => {
    const { db, network } = harness();
    let answer: (response: Response) => void = () => undefined;
    network.answer(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    await renderDetail(db);
    await act(async () => {
      pull();
      pull();
      await fireEvent.press(screen.getByTestId('detail-refresh'));
    });
    await waitFor(() => {
      expect(network.requests).toHaveLength(1);
    });
    expect(network.requests[0]).toMatchObject({
      method: 'POST',
      url: `https://api.planeahead.test/v1/flights/${AA100_ID}/refresh`,
    });
    expect(network.requests[0]?.headers.get('idempotency-key')).toBeNull();
    expect(screen.getByTestId('detail-refreshing')).toHaveTextContent('Refreshing…');
    // Busy, the button keeps its name (its title is a spinner now) and says it is busy.
    expect(screen.getByRole('button', { name: 'Refresh', busy: true })).toBeOnTheScreen();

    await act(async () => {
      answer(
        json(200, {
          outcome: 'refreshed',
          reason: null,
          flight: refreshView(
            aa100Snapshot({ originGate: 'C5', fetchedAt: '2026-09-23T14:00:00Z' }),
          ),
        }),
      );
      await Promise.resolve();
    });
    expect(await screen.findByTestId('detail-message')).toHaveTextContent(/^Updated\./);
    expect(screen.getByTestId('detail-origin-gate')).toHaveTextContent('Terminal 8, gate C5');

    // The gesture is over: the next pull is a new request.
    network.answer(() =>
      json(200, { outcome: 'coalesced', reason: 'fresh', flight: refreshView(aa100Snapshot()) }),
    );
    await act(async () => {
      pull();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(network.requests).toHaveLength(2);
    });
    expect(await screen.findByText('Already up to date.')).toBeOnTheScreen();
  });

  it('504: applies the last known flight from the payload and says the refresh is still running', async () => {
    const { db, network } = harness();
    network.answer(() =>
      json(504, {
        error: 'refresh_timeout',
        message: 'the refresh is still running; showing the last known state',
        requestId: 'req-1',
        flight: refreshView(
          aa100Snapshot({ originGate: 'B30', fetchedAt: '2026-09-23T13:59:00Z' }),
        ),
      }),
    );
    await renderDetail(db);
    await act(async () => {
      pull();
      await Promise.resolve();
    });
    expect(await screen.findByTestId('detail-message')).toHaveTextContent(
      /The refresh is still running\. Showing the last known state/,
    );
    expect(snapshotRow(db).origin_gate).toBe('B30');
    expect(screen.getByTestId('detail-origin-gate')).toHaveTextContent('Terminal 8, gate B30');
  });

  it('504 upstream_timeout with a null snapshot never replaces the stored one', async () => {
    const { db, network } = harness();
    network.answer(() =>
      json(504, { error: 'upstream_timeout', requestId: 'req-2', flight: refreshView(null) }),
    );
    await renderDetail(db);
    const before = snapshotRow(db);
    await act(async () => {
      pull();
      await Promise.resolve();
    });
    expect(await screen.findByTestId('detail-message')).toHaveTextContent(/still running/);
    expect(snapshotRow(db)).toEqual(before);
    expect(readFlight(db, AA100_ID)?.snapshot).not.toBeNull();
  });

  it('never rolls the row back to an older snapshot than it holds', async () => {
    const { db, network } = harness();
    network.answer(() =>
      json(200, {
        outcome: 'coalesced',
        reason: 'inflight',
        flight: refreshView(
          aa100Snapshot({ originGate: 'OLD', fetchedAt: '2026-09-23T10:00:00Z' }),
        ),
      }),
    );
    await renderDetail(db);
    await act(async () => {
      pull();
      await Promise.resolve();
    });
    await screen.findByTestId('detail-message');
    expect(snapshotRow(db).origin_gate).toBe('B22');
  });

  it('410 flight_archived: marks the flight finished here and stops offering a refresh', async () => {
    const { db, network } = harness();
    network.answer(() =>
      json(410, {
        error: 'flight_archived',
        message: 'this flight is over and no longer tracked',
        requestId: 'req-3',
        flight: refreshView(
          aa100Snapshot({ status: 'arrived', fetchedAt: '2026-09-23T14:00:00Z' }),
        ),
      }),
    );
    await renderDetail(db);
    await act(async () => {
      pull();
      await Promise.resolve();
    });
    expect(await screen.findByTestId('detail-over')).toHaveTextContent(
      'This flight is over and no longer tracked.',
    );
    expect(readFlight(db, AA100_ID)).toMatchObject({ status: 'arrived' });
    expect(readFlight(db, AA100_ID)?.finishedAt).toBe(new Date(NOW).toISOString());
    expect(screen.queryByTestId('detail-refresh')).toBeNull();
  });

  it('410 flight_archived with no flight in the answer: still marks this subscription finished', async () => {
    const { db, network } = harness();
    network.answer(() =>
      json(410, { error: 'flight_archived', message: 'over', requestId: 'req-3b', flight: null }),
    );
    await renderDetail(db);
    const before = snapshotRow(db);
    await act(async () => {
      pull();
      await Promise.resolve();
    });
    expect(await screen.findByTestId('detail-over')).toHaveTextContent(
      'This flight is over and no longer tracked.',
    );
    expect(readFlight(db, AA100_ID)?.finishedAt).toBe(new Date(NOW).toISOString());
    // The stored snapshot stays: a null never replaces it.
    expect(snapshotRow(db)).toEqual(before);
    expect(screen.queryByTestId('detail-refresh')).toBeNull();
  });

  it('401 account_deleted: wipes the store and runs the one forgetAccount path', async () => {
    const { db, network, onAccountDeleted } = harness();
    network.answer(() => json(401, { error: 'account_deleted', requestId: 'req-8' }));
    await renderDetail(db);
    await act(async () => {
      pull();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(onAccountDeleted).toHaveBeenCalledTimes(1);
    });
    expect(listFlights(db)).toEqual([]);
    expect(db.raw.prepare('SELECT count(*) AS n FROM flight_subscriptions').get()).toEqual({
      n: 0,
    });
  });

  it('401 unauthenticated: asks to sign in again and keeps the store', async () => {
    const { db, network, onAccountDeleted } = harness();
    network.answer(() => json(401, { error: 'unauthenticated', requestId: 'req-9' }));
    await renderDetail(db);
    await act(async () => {
      pull();
      await Promise.resolve();
    });
    expect(await screen.findByTestId('detail-message')).toHaveTextContent(
      /^Sign in again to refresh flights\./,
    );
    expect(onAccountDeleted).not.toHaveBeenCalled();
    expect(listFlights(db)).toHaveLength(3);
  });

  it('a refusal this build does not know: a generic sentence, the code to Sentry only', async () => {
    const { db, network } = harness();
    network.answer(() => json(429, { error: 'rate_limited', requestId: 'req-10' }));
    await renderDetail(db);
    await act(async () => {
      pull();
      await Promise.resolve();
    });
    const message = await screen.findByTestId('detail-message');
    expect(message).toHaveTextContent(/^Could not refresh right now\. Try again later\./);
    expect(message).not.toHaveTextContent(/rate_limited|429/);
    expect(Sentry.captureMessage).toHaveBeenCalledWith('flight_refresh_refused', {
      level: 'warning',
      extra: { method: 'POST', path: '/v1/flights/:id/refresh', status: 429, code: 'rate_limited' },
    });
  });

  it('403 refresh cap: says the free-tier limit', async () => {
    const { db, network } = harness();
    network.answer(() =>
      json(403, { error: 'cap_exceeded', cap: 'refresh', limit: 10, requestId: 'req-4' }),
    );
    await renderDetail(db);
    await act(async () => {
      pull();
      await Promise.resolve();
    });
    expect(await screen.findByTestId('detail-message')).toHaveTextContent(
      /^The free plan refreshes a flight up to 10 times a day\. It keeps updating on its own\./,
    );
  });

  it('the 8 s deadline UX: still checking past 8 s, then gives up waiting after the grace', async () => {
    jest.restoreAllMocks();
    jest.useFakeTimers({ now: NOW, doNotFake: ['queueMicrotask', 'nextTick', 'setImmediate'] });
    try {
      const { db, network } = harness();
      network.answer(
        (request) =>
          new Promise<Response>((_resolve, reject) => {
            request.signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          }),
      );
      await renderDetail(db);
      await act(async () => {
        pull();
        await Promise.resolve();
      });
      await act(async () => {
        await Promise.resolve();
        jest.advanceTimersByTime(7_999);
      });
      expect(screen.getByTestId('detail-refreshing')).toHaveTextContent('Refreshing…');
      await act(async () => {
        jest.advanceTimersByTime(1);
        await Promise.resolve();
      });
      expect(screen.getByTestId('detail-refreshing')).toHaveTextContent(
        'Still checking with the flight data provider…',
      );
      await act(async () => {
        jest.advanceTimersByTime(REFRESH_GRACE_MS);
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(screen.getByTestId('detail-message')).toHaveTextContent(/taking longer than usual/);
      });
      expect(screen.queryByTestId('detail-refreshing')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('unsubscribe', () => {
  it('tombstones the row now, queues DELETE /v1/flights/:id and drains it', async () => {
    const { db, network } = harness();
    network.answer(() => json(200, { deleted: true }));
    const alert = jest.spyOn(Alert, 'alert');
    await renderDetail(db);
    await fireEvent.press(screen.getByTestId('detail-remove'));
    const buttons = alert.mock.calls[0]?.[2] ?? [];
    const confirm = buttons.find((button) => button.style === 'destructive');
    await act(async () => {
      confirm?.onPress?.();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(network.requests).toHaveLength(1);
    });
    expect(mockRouter.back).toHaveBeenCalled();
    expect(readFlight(db, AA100_ID)).toBeNull();
    expect(`${network.requests[0]?.method ?? ''} ${network.requests[0]?.url ?? ''}`).toBe(
      `DELETE https://api.planeahead.test/v1/flights/${AA100_ID}`,
    );
    expect(network.requests[0]?.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('the detail in light and dark', () => {
  it.each(['light', 'dark'] as const)('renders the seeded timeline in %s', async (appearance) => {
    useSettings.getState().setAppearance(appearance);
    const { db } = harness();
    await renderDetail(db);
    expect(compactTree(screen.toJSON())).toMatchSnapshot();
  });
});

describe('the airport boards (increment 18, ruling B12)', () => {
  it("opens the origin's departures and the destination's arrivals", async () => {
    const { db } = harness();
    await renderDetail(db);
    expect(screen.getByTestId('detail-origin-board').props.accessibilityLabel).toBe(
      'Open the departures board at JFK',
    );
    await fireEvent.press(screen.getByTestId('detail-origin-board'));
    expect(mockRouter.push).toHaveBeenLastCalledWith({
      pathname: '/airport/[code]',
      params: { code: 'JFK', direction: 'departures' },
    });
    await fireEvent.press(screen.getByTestId('detail-destination-board'));
    expect(mockRouter.push).toHaveBeenLastCalledWith({
      pathname: '/airport/[code]',
      params: { code: 'LHR', direction: 'arrivals' },
    });
  });

  it('offers no board while an add is still being looked up', async () => {
    const { db } = harness();
    const added = addFlight(db, { designator: 'UA901', date: '2026-09-24' });
    await renderDetail(db, added.kind === 'queued' ? added.subscriptionId : '');
    expect(screen.getByTestId('detail-pending')).toBeTruthy();
    expect(screen.queryByTestId('detail-boards')).toBeNull();
  });
});
