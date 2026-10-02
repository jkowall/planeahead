/**
 * Increment 16, rulings C6 and C7 (src/lib/push-notifications.ts, src/lib/push-routing.ts): the
 * foreground handler's decisions, answered from memory; a foreground push syncing the store; tap
 * routing (a known id, an unknown id then one sync, no session yet); and the dismissal of a
 * flight's presented notifications when it opens, by data on iOS and by tag for what FCM
 * displayed on Android.
 */

import { act, renderHook } from '@testing-library/react-native';
import type { NotificationHandler } from 'expo-notifications';
import { AppState, type AppStateStatus } from 'react-native';
import { syncNow } from '../src/lib/session';
import {
  dismissFlightNotifications,
  foregroundBehavior,
  installForegroundHandler,
  pushFlightId,
  routeTap,
  takeResponse,
  useFlightInFront,
  useNotificationResponses,
  usePendingTap,
} from '../src/lib/push-notifications';
import { usePushRouting } from '../src/lib/push-routing';
import { AA100_ID, AA100_KEY, BA117_ID, BA117_KEY } from './support/flight-fixtures';
import {
  fakeNotifications,
  pushNotification,
  resetFakeNotifications,
  tapOn,
} from './support/fake-notifications';

jest.mock('expo-notifications', () =>
  jest
    .requireActual<typeof import('./support/fake-notifications')>('./support/fake-notifications')
    .fakeNotificationsModule(),
);

const mockRouter = { push: jest.fn(), navigate: jest.fn() };
const mockFocus = { focused: true };
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useIsFocused: () => mockFocus.focused,
}));

/** The local store: the ids it knows, and those the next sync brings. */
const mockStore = { known: new Set<string>(), arriving: [] as string[] };
jest.mock('../src/lib/session', () => ({
  syncNow: jest.fn(() => {
    for (const id of mockStore.arriving) {
      mockStore.known.add(id);
    }
    return Promise.resolve();
  }),
}));
jest.mock('../src/lib/services', () => ({
  services: () => Promise.resolve({ store: { sqlite: null } }),
}));
jest.mock('../src/lib/flight-queries', () => ({
  readFlight: (_db: unknown, id: string) => (mockStore.known.has(id) ? { id } : null),
}));

/** App data as the API sends it (`PushDataV1`): flat strings. */
function appData(flightSubscriptionId?: string, extra: Record<string, string> = {}) {
  return {
    v: '1',
    kind: 'gate_change',
    ...(flightSubscriptionId === undefined ? {} : { flightSubscriptionId }),
    ...extra,
  };
}

const SHOWN = {
  shouldShowBanner: true,
  shouldShowList: true,
  shouldPlaySound: true,
  shouldSetBadge: false,
};
const NOT_PRESENTED = {
  shouldShowBanner: false,
  shouldShowList: false,
  shouldPlaySound: false,
  shouldSetBadge: false,
};

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  });
}

let handler: NotificationHandler | null = null;
let installs = 0;

beforeAll(() => {
  installForegroundHandler();
  installForegroundHandler();
  handler = fakeNotifications.handler;
  installs = fakeNotifications.calls.filter((call) => call === 'setHandler').length;
});

beforeEach(() => {
  resetFakeNotifications();
  mockStore.known.clear();
  mockStore.arriving = [];
  mockFocus.focused = true;
  usePendingTap.setState({ tap: null });
});

describe('the foreground handler (ruling C6)', () => {
  it('reads the flight a push names, only from data it knows', () => {
    expect(pushFlightId(appData(AA100_ID))).toBe(AA100_ID);
    // A kind this build does not know still routes; a data version it does not know does not.
    expect(pushFlightId(appData(AA100_ID, { kind: 'boarding_soon' }))).toBe(AA100_ID);
    expect(pushFlightId({ ...appData(AA100_ID), v: '2' })).toBeNull();
    expect(pushFlightId(appData())).toBeNull();
    expect(pushFlightId(undefined)).toBeNull();
  });

  it.each([
    ['another flight', appData(BA117_ID), AA100_ID, SHOWN],
    ['the flight in front', appData(AA100_ID), AA100_ID, NOT_PRESENTED],
    ['a push naming no flight (a test push)', appData(), AA100_ID, SHOWN],
    ['a data version this build cannot read', { ...appData(AA100_ID), v: '2' }, AA100_ID, SHOWN],
    ['any flight, with no detail screen in front', appData(AA100_ID), null, SHOWN],
  ])('%s', (_name, data, inFront, expected) => {
    expect(foregroundBehavior(pushNotification('delay:k', data), inFront)).toEqual(expected);
  });

  it('is installed once, and answers from memory as the detail screen comes and goes', async () => {
    expect(installs).toBe(1);
    if (handler === null) {
      throw new Error('no handler was installed');
    }
    const push = pushNotification(`gate_change:${AA100_KEY}`, appData(AA100_ID));
    await expect(handler.handleNotification(push)).resolves.toEqual(SHOWN);

    // The detail screen of AA100, its key not loaded yet (so nothing to dismiss).
    const screen = await renderHook(() => {
      useFlightInFront(AA100_ID, null);
    });
    await expect(handler.handleNotification(push)).resolves.toEqual(NOT_PRESENTED);
    mockFocus.focused = false;
    await screen.rerender({});
    await expect(handler.handleNotification(push)).resolves.toEqual(SHOWN);
    mockFocus.focused = true;
    await screen.rerender({});
    await expect(handler.handleNotification(push)).resolves.toEqual(NOT_PRESENTED);
    await screen.unmount();
    await expect(handler.handleNotification(push)).resolves.toEqual(SHOWN);
    // No call to expo or anything else on the way: memory only.
    expect(fakeNotifications.calls).toEqual([]);
  });

  it('a push received in the foreground that names a flight syncs the store', async () => {
    const routing = await renderHook(() => {
      usePushRouting('user-1');
    });
    for (const listener of fakeNotifications.receivedListeners) {
      listener(pushNotification('delay:k', appData(AA100_ID)));
      listener(pushNotification('system:job', appData()));
    }
    expect(syncNow).toHaveBeenCalledTimes(1);
    expect(syncNow).toHaveBeenCalledWith('user-1');
    await routing.unmount();
    expect(fakeNotifications.receivedListeners).toHaveLength(0);
  });
});

describe('tap routing (ruling C7)', () => {
  /** The root layout's observer and the `(app)` layout's routing, as the app mounts them. */
  async function mount(userId: string | null) {
    const root = await renderHook(() => {
      useNotificationResponses();
    });
    const app = await renderHook(
      (props: { userId: string | null }) => {
        usePushRouting(props.userId);
      },
      { initialProps: { userId } },
    );
    await flush();
    return { root, app };
  }

  async function tap(identifier: string, data: Record<string, string>, date = 1_790_000_000_000) {
    await act(async () => {
      for (const listener of fakeNotifications.responseListeners) {
        listener(tapOn(pushNotification(identifier, data, date)));
      }
      await Promise.resolve();
    });
  }

  it('a cold start: the last response waits for a session, then opens the flight once', async () => {
    mockStore.known.add(AA100_ID);
    fakeNotifications.lastResponse = tapOn(
      pushNotification(`gate_change:${AA100_KEY}`, appData(AA100_ID), 1_790_000_000_001),
    );
    const { app } = await mount(null);
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(fakeNotifications.lastResponse).not.toBeNull();

    await app.rerender({ userId: 'user-1' });
    await flush();
    expect(mockRouter.push).toHaveBeenCalledTimes(1);
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/flight/[id]',
      params: { id: AA100_ID },
    });
    expect(fakeNotifications.lastResponse).toBeNull();
    expect(syncNow).not.toHaveBeenCalled();
    // The same tap again, from the listener this time: already taken.
    await tap(`gate_change:${AA100_KEY}`, appData(AA100_ID), 1_790_000_000_001);
    await flush();
    expect(mockRouter.push).toHaveBeenCalledTimes(1);
  });

  it('an id the store does not know: one sync, then the flight', async () => {
    mockStore.arriving = [BA117_ID];
    await mount('user-1');
    await tap(`delay:${BA117_KEY}`, appData(BA117_ID), 1_790_000_000_002);
    await flush();
    expect(syncNow).toHaveBeenCalledTimes(1);
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/flight/[id]',
      params: { id: BA117_ID },
    });
    expect(mockRouter.navigate).not.toHaveBeenCalled();
  });

  it('an id still unknown after the sync: the home screen', async () => {
    await mount('user-1');
    await tap(`delay:${BA117_KEY}`, appData(BA117_ID), 1_790_000_000_003);
    await flush();
    expect(syncNow).toHaveBeenCalledTimes(1);
    expect(mockRouter.navigate).toHaveBeenCalledWith('/');
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it('the flight already in front refreshes in place rather than opening again', async () => {
    mockStore.known.add(AA100_ID);
    await mount('user-1');
    await renderHook(() => {
      useFlightInFront(AA100_ID, null);
    });
    await tap(`gate_change:${AA100_KEY}`, appData(AA100_ID), 1_790_000_000_004);
    await flush();
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(syncNow).toHaveBeenCalledTimes(1);
  });

  it('a tap naming no flight is cleared and routes nowhere', async () => {
    await mount('user-1');
    await act(async () => {
      takeResponse(tapOn(pushNotification('system:job-1', appData(), 1_790_000_000_005)));
      await Promise.resolve();
    });
    await flush();
    expect(fakeNotifications.calls).toContain('clearLastResponse');
    expect(usePendingTap.getState().tap).toBeNull();
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(mockRouter.navigate).not.toHaveBeenCalled();
  });

  it('routeTap answers what it did', async () => {
    const routes = {
      knows: (id: string) => Promise.resolve(mockStore.known.has(id)),
      sync: () => syncNow('user-1'),
      open: jest.fn(),
      home: jest.fn(),
    };
    mockStore.known.add(AA100_ID);
    await expect(routeTap(AA100_ID, routes)).resolves.toBe('opened');
    mockStore.arriving = [BA117_ID];
    await expect(routeTap(BA117_ID, routes)).resolves.toBe('opened_after_sync');
    await expect(routeTap('0199a000-0000-7000-8000-000000000099', routes)).resolves.toBe('home');
  });
});

describe('opening a flight dismisses its presented notifications (ruling C7)', () => {
  /** How expo names a notification it did not present itself (Android, displayed by FCM). */
  function foreign(tag: string | null, id = 0): string {
    const query = tag === null ? '' : `tag=${encodeURIComponent(tag)}&`;
    return `expo-notifications://foreign_notifications?${query}id=${String(id)}`;
  }

  it('those whose data names it, and those FCM displayed, by their tag', async () => {
    fakeNotifications.presented = [
      // iOS: the identifier is the collapse id, and the data names the flight.
      pushNotification(`gate_change:${AA100_KEY}`, appData(AA100_ID)),
      pushNotification(`delay:${BA117_KEY}`, appData(BA117_ID, { kind: 'delay' })),
      // Android, presented by expo in the foreground: its own identifier, the FCM data.
      pushNotification(
        '0f9c2a54-6c41-4c55-9d7f-4cbd8c2a3d10',
        appData(AA100_ID, { tag: `cancellation:${AA100_KEY}`, channelId: 'flight_changes' }),
      ),
      // Android, displayed by FCM in the background: expo sees no app data, only the tag.
      pushNotification(foreign(`diversion:${AA100_KEY}`), { 'android.title': 'Diverted' }),
      pushNotification(foreign(`delay:${BA117_KEY}`), { 'android.title': 'Delayed' }),
      pushNotification(foreign(null, 7), {}),
    ];
    await expect(dismissFlightNotifications({ id: AA100_ID, flightKey: AA100_KEY })).resolves.toBe(
      3,
    );
    expect(fakeNotifications.presented.map(({ request }) => request.identifier)).toEqual([
      `delay:${BA117_KEY}`,
      foreign(`delay:${BA117_KEY}`),
      foreign(null, 7),
    ]);
  });

  it('the detail screen does it when it opens, once the flight key is loaded', async () => {
    fakeNotifications.presented = [
      pushNotification(`gate_change:${AA100_KEY}`, appData(AA100_ID)),
      pushNotification(`gate_change:${BA117_KEY}`, appData(BA117_ID)),
    ];
    const screen = await renderHook(
      (props: { flightKey: string | null }) => {
        useFlightInFront(AA100_ID, props.flightKey);
      },
      { initialProps: { flightKey: null as string | null } },
    );
    await flush();
    expect(fakeNotifications.calls).toEqual([]);
    await screen.rerender({ flightKey: AA100_KEY });
    await flush();
    expect(fakeNotifications.calls).toEqual(['getPresented', `dismiss:gate_change:${AA100_KEY}`]);
    // Not again while it stays open; again when it comes back into focus.
    await screen.rerender({ flightKey: AA100_KEY });
    await flush();
    expect(fakeNotifications.calls).toHaveLength(2);
    mockFocus.focused = false;
    await screen.rerender({ flightKey: AA100_KEY });
    mockFocus.focused = true;
    await screen.rerender({ flightKey: AA100_KEY });
    await flush();
    expect(fakeNotifications.calls).toEqual([
      'getPresented',
      `dismiss:gate_change:${AA100_KEY}`,
      'getPresented',
    ]);
    await screen.unmount();
  });

  it('and when the app returns to the foreground on it, while it is focused (review A6)', async () => {
    const listeners = new Set<(status: AppStateStatus) => void>();
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      listeners.add(listener);
      return {
        remove: () => {
          listeners.delete(listener);
        },
      };
    });
    const emit = async (status: AppStateStatus) => {
      await act(() => {
        for (const listener of [...listeners]) {
          listener(status);
        }
      });
      await flush();
    };
    /** A delay about AA100 that the OS displayed while the app was in the background. */
    const delay = () =>
      pushNotification(`delay:${AA100_KEY}`, appData(AA100_ID, { kind: 'delay' }));
    const screen = await renderHook(
      (props: { flightKey: string | null }) => {
        useFlightInFront(AA100_ID, props.flightKey);
      },
      { initialProps: { flightKey: AA100_KEY } },
    );
    await flush();
    expect(fakeNotifications.calls).toEqual(['getPresented']);
    await emit('background');
    fakeNotifications.presented = [delay()];
    await emit('active');
    expect(fakeNotifications.calls).toEqual([
      'getPresented',
      'getPresented',
      `dismiss:delay:${AA100_KEY}`,
    ]);
    expect(fakeNotifications.presented).toEqual([]);

    // Another screen in front: coming back to the app leaves the tray alone.
    mockFocus.focused = false;
    await screen.rerender({ flightKey: AA100_KEY });
    fakeNotifications.presented = [delay()];
    await emit('active');
    expect(fakeNotifications.calls).toHaveLength(3);
    expect(listeners.size).toBe(0);
    await screen.unmount();
  });
});
