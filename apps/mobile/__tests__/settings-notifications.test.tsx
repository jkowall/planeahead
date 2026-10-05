/**
 * Increment 16, ruling C11: the Settings screen's notification toggles, the account's alerts
 * switch (`pushEnabled`) and its five per-kind toggles, first gate assignment off by default.
 * They are read from the sync feed's `notification_preferences` row, change the settings store at
 * once (persisted through the kv-store; settings.test.tsx proves the relaunch on the real
 * statements) and queue `PATCH /v1/me/preferences` with `{ notifications }` through the outbox.
 * A sync page carrying the account's older choices cannot flip a toggle back while its PATCH is
 * queued. The real services (sync client, outbox, settings store) over an in-memory SQLite and a
 * scripted network.
 */

import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_EVENT_PREFERENCES,
  type NotificationEvents,
} from '@planeahead/shared';
import { onlineManager } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import SettingsScreen from '../src/app/(app)/settings';
import { KV_KEYS, zustandKvStorage } from '../src/lib/db/kv';
import type { SqliteLike } from '../src/lib/db/sqlite-like';
import { services } from '../src/lib/services';
import { useSettings } from '../src/lib/settings';
import {
  fakeNotifications,
  permissionStatus,
  resetFakeNotifications,
} from './support/fake-notifications';
import { json, scriptedFetch } from './support/flight-fixtures';
import { createMemorySqlite, type MemorySqlite } from './support/memory-sqlite';
import { cursorAt, notificationPreferencesUpsert, page } from './support/sync-fixtures';

const API = 'https://api.planeahead.test';

/** The store and the network the real services are built over; each test swaps them. */
const mockEdge: { db: MemorySqlite; network: ReturnType<typeof scriptedFetch> } = {
  db: createMemorySqlite(),
  network: scriptedFetch(),
};

jest.mock('expo-notifications', () =>
  jest
    .requireActual<typeof import('./support/fake-notifications')>('./support/fake-notifications')
    .fakeNotificationsModule(),
);
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn(), replace: jest.fn() }) }));
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
  runtimeConfig: () => ({ variant: 'development', apiUrl: 'https://api.planeahead.test' }),
}));
jest.mock('../src/lib/auth-client', () => ({
  isAnonymousSession: () => false,
  authClient: {
    useSession: () => ({
      data: { user: { id: 'u1', isAnonymous: false, email: 'ada@example.com' } },
      isPending: false,
    }),
    getCookie: () => 'better-auth.session_token=session-abc',
    signOut: jest.fn(() => Promise.resolve()),
  },
}));
jest.mock('../src/lib/identity', () => ({
  installId: () => 'install-0123456789',
  analyticsId: () => 'analytics-0123456789',
}));
jest.mock('../src/lib/sign-out', () => ({ signOut: jest.fn() }));
jest.mock('../src/lib/push-registration', () => ({
  pushRegistrar: () => ({ register: jest.fn(() => Promise.resolve()) }),
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

/** What the five per-kind switches show. */
function shown(): Record<string, unknown> {
  return Object.fromEntries(
    NOTIFICATION_EVENT_PREFERENCES.map((name) => [
      name,
      screen.getByTestId(`settings-notify-${name}`).props.value,
    ]),
  );
}

function events(overrides: Partial<NotificationEvents>): NotificationEvents {
  return { ...DEFAULT_NOTIFICATION_PREFERENCES.events, ...overrides };
}

async function toggle(testID: string, on: boolean): Promise<void> {
  await fireEvent(screen.getByTestId(testID), 'valueChange', on);
}

function queuedBodies(): unknown[] {
  return mockEdge.db
    .all<{ body: string }>('SELECT body FROM outbox ORDER BY seq')
    .map((row) => JSON.parse(row.body) as unknown);
}

function persisted(): unknown {
  const raw = zustandKvStorage.getItem(KV_KEYS.settings);
  return typeof raw === 'string' ? JSON.parse(raw) : null;
}

/** One `GET /v1/sync` answered with a snapshot carrying the account's notification row. */
async function syncNotifications(row: Record<string, unknown>): Promise<void> {
  mockEdge.network.answer(() =>
    json(200, page({ changes: [notificationPreferencesUpsert(row)], cursor: cursorAt(1) })),
  );
  const { sync } = await services();
  await act(async () => {
    await sync.sync('u1');
  });
}

beforeAll(() => {
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) =>
    mockEdge.network.fetchMock(input, init);
});

beforeEach(() => {
  mockEdge.db = createMemorySqlite();
  mockEdge.network = scriptedFetch();
  useSettings.getState().reset();
  resetFakeNotifications();
  fakeNotifications.permission = permissionStatus({
    status: 'granted',
    granted: true,
    iosStatus: 2,
  });
});

afterEach(() => {
  onlineManager.setOnline(true);
});

describe('the notification toggles (ruling C11)', () => {
  it('start from the defaults: alerts on, every kind on but the first gate assignment', async () => {
    await render(<SettingsScreen />);
    expect(screen.getByTestId('settings-notify-push').props.value).toBe(true);
    expect(shown()).toEqual({
      delay: true,
      gate_change: true,
      first_gate_assignment: false,
      cancellation: true,
      diversion: true,
    });
    for (const name of ['push', ...NOTIFICATION_EVENT_PREFERENCES]) {
      expect(screen.getByTestId(`settings-notify-${name}`).props.disabled).toBe(false);
    }
  });

  it("read: show the account's choices from the sync feed, the defaults for what it leaves out", async () => {
    await render(<SettingsScreen />);
    await syncNotifications({ events: { delay: false, first_gate_assignment: true } });
    expect(shown()).toEqual(events({ delay: false, first_gate_assignment: true }));
    expect(useSettings.getState().notifications.pushEnabled).toBe(true);
    expect(
      mockEdge.network.requests.map(({ method, url }) => [method, new URL(url).pathname]),
    ).toEqual([['GET', '/v1/sync']]);

    // The account turned alerts off on another phone: the five grey out and keep their values.
    await syncNotifications({ pushEnabled: false, events: { delay: false } });
    expect(screen.getByTestId('settings-notify-push').props.value).toBe(false);
    expect(shown()).toEqual(events({ delay: false }));
    for (const name of NOTIFICATION_EVENT_PREFERENCES) {
      expect(screen.getByTestId(`settings-notify-${name}`).props.disabled).toBe(true);
    }
  });

  it('a change applies at once, persists, and is sent as PATCH /v1/me/preferences through the outbox', async () => {
    mockEdge.network.answer(() => json(200, {}));
    mockEdge.network.answer(() => json(200, {}));
    await render(<SettingsScreen />);

    await toggle('settings-notify-first_gate_assignment', true);
    expect(useSettings.getState().notifications.events.first_gate_assignment).toBe(true);
    expect(shown()).toEqual(events({ first_gate_assignment: true }));
    await toggle('settings-notify-push', false);
    expect(useSettings.getState().notifications.pushEnabled).toBe(false);
    expect(persisted()).toMatchObject({
      state: { notifications: { pushEnabled: false, events: { first_gate_assignment: true } } },
    });

    await waitFor(() => {
      expect(mockEdge.network.requests).toHaveLength(2);
    });
    expect(mockEdge.network.requests.map(({ method, url, body }) => [method, url, body])).toEqual([
      [
        'PATCH',
        `${API}/v1/me/preferences`,
        { notifications: { events: { first_gate_assignment: true } } },
      ],
      ['PATCH', `${API}/v1/me/preferences`, { notifications: { pushEnabled: false } }],
    ]);
    for (const request of mockEdge.network.requests) {
      expect(request.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
    }
    await waitFor(() => {
      expect(queuedBodies()).toEqual([]);
    });
  });

  it('a change queued offline holds over the older choices a sync page brings', async () => {
    onlineManager.setOnline(false);
    await render(<SettingsScreen />);
    await toggle('settings-notify-delay', false);
    await waitFor(() => {
      expect(queuedBodies()).toEqual([{ notifications: { events: { delay: false } } }]);
    });
    expect(mockEdge.network.requests).toEqual([]);

    // Pulled before the PATCH reached the account: delays still on there, cancellations off.
    await syncNotifications({ events: { delay: true, cancellation: false } });
    expect(shown()).toEqual(events({ delay: false, cancellation: false }));
    expect(queuedBodies()).toHaveLength(1);
  });

  it('stay editable while the permission is denied, beside the system settings link', async () => {
    fakeNotifications.permission = permissionStatus({ status: 'denied', iosStatus: 1 });
    mockEdge.network.answer(() => json(200, {}));
    await render(<SettingsScreen />);
    expect(await screen.findByTestId('settings-notifications-system')).toBeTruthy();
    for (const name of ['push', ...NOTIFICATION_EVENT_PREFERENCES]) {
      expect(screen.getByTestId(`settings-notify-${name}`).props.disabled).toBe(false);
    }
    await toggle('settings-notify-gate_change', false);
    expect(shown()).toEqual(events({ gate_change: false }));
    await waitFor(() => {
      expect(mockEdge.network.requests.map(({ body }) => body)).toEqual([
        { notifications: { events: { gate_change: false } } },
      ]);
    });
  });
});
