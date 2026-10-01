/**
 * Settings gains the units (metric, imperial) and time-format (12 h, 24 h) toggles (increment 10,
 * ruling T6). A toggle changes the zustand settings store at once (persisted through the kv
 * store, so it holds offline and across a relaunch; settings.test.tsx proves the persistence
 * itself on the real kv-store statements) and queues `PATCH /v1/me/preferences` through the
 * outbox. A sync page carrying the account's older preferences cannot flip the choice back while
 * that PATCH is still queued. Light and dark snapshots of the screen.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import SettingsScreen from '../src/app/(app)/settings';
import { createApiClient } from '../src/lib/api-client';
import { KV_KEYS, zustandKvStorage } from '../src/lib/db/kv';
import { queuePreferencesPatch, withPendingPatches } from '../src/lib/preference-mutations';
import { useSettings } from '../src/lib/settings';
import { ApplyGate } from '../src/lib/sync/gate';
import { createOutbox } from '../src/lib/sync/outbox';
import { DEFAULT_USER_PREFERENCES } from '@planeahead/shared';
import { compactTree } from './support/compact-tree';
import { json, scriptedFetch } from './support/flight-fixtures';
import { createMemorySqlite, type MemorySqlite } from './support/memory-sqlite';

const mockServices: { current: unknown } = { current: null };

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

jest.mock('../src/lib/auth-client', () => ({
  isAnonymousSession: () => false,
  authClient: {
    useSession: () => ({
      data: { user: { id: 'u1', isAnonymous: false, email: 'ada@example.com' } },
      isPending: false,
    }),
  },
}));

jest.mock('../src/lib/config', () => ({
  runtimeConfig: () => ({
    variant: 'development',
    apiUrl: 'https://api.planeahead.test',
    universalLinkHosts: [],
    googleIosClientId: 'ios-client.apps.googleusercontent.com',
    googleWebClientId: null,
    sentryDsn: null,
  }),
}));

jest.mock('../src/lib/services', () => ({
  services: () => Promise.resolve(mockServices.current),
  forgetAccount: jest.fn(),
}));
// Increment 16: the permission as a phone that has not been asked yet (settings-push.test.tsx
// covers the section itself).
jest.mock('../src/lib/push', () => ({
  usePushPermission: () => [{ state: 'undetermined', canAsk: true }, jest.fn()],
  requestPushPermission: jest.fn(),
}));
jest.mock('../src/lib/push-registration', () => ({
  pushRegistrar: () => ({ register: jest.fn() }),
}));
jest.mock('../src/lib/sign-out', () => ({ signOut: jest.fn() }));

function harness(): { db: MemorySqlite; network: ReturnType<typeof scriptedFetch> } {
  const db = createMemorySqlite();
  const network = scriptedFetch();
  const api = createApiClient({
    baseUrl: 'https://api.planeahead.test',
    getCookie: () => Promise.resolve('better-auth.session_token=session-abc'),
    getInstallId: () => 'install-0123456789',
    fetch: network.fetchMock,
  });
  const outbox = createOutbox({
    db,
    gate: new ApplyGate(),
    transport: { send: (request) => api.request(request) },
    onAccountDeleted: jest.fn(),
  });
  mockServices.current = { store: { sqlite: db }, api, outbox };
  return { db, network };
}

function persisted(): unknown {
  const raw = zustandKvStorage.getItem(KV_KEYS.settings);
  return typeof raw === 'string' ? JSON.parse(raw) : null;
}

beforeEach(() => {
  useSettings.getState().reset();
});

describe('the units and time-format toggles', () => {
  it('apply at once, persist, and send PATCH /v1/me/preferences through the outbox', async () => {
    const { db, network } = harness();
    network.answer(() => json(200, { preferences: {} }));
    network.answer(() => json(200, { preferences: {} }));
    await render(<SettingsScreen />);
    expect(screen.getByTestId('settings-units-imperial')).toHaveProp('accessibilityState', {
      disabled: false,
      selected: true,
    });
    expect(screen.getByTestId('settings-time-12h')).toHaveProp('accessibilityState', {
      disabled: false,
      selected: true,
    });

    await fireEvent.press(screen.getByTestId('settings-units-metric'));
    expect(useSettings.getState().preferences).toMatchObject({
      distanceUnit: 'km',
      temperatureUnit: 'c',
    });
    expect(screen.getByTestId('settings-units-metric')).toHaveProp('accessibilityState', {
      disabled: false,
      selected: true,
    });
    await fireEvent.press(screen.getByTestId('settings-time-24h'));
    expect(useSettings.getState().preferences.timeFormat).toBe('24h');
    expect(persisted()).toMatchObject({
      state: { preferences: { distanceUnit: 'km', temperatureUnit: 'c', timeFormat: '24h' } },
    });

    await waitFor(() => {
      expect(network.requests).toHaveLength(2);
    });
    expect(network.requests.map((request) => [request.method, request.url, request.body])).toEqual([
      [
        'PATCH',
        'https://api.planeahead.test/v1/me/preferences',
        { distanceUnit: 'km', temperatureUnit: 'c' },
      ],
      ['PATCH', 'https://api.planeahead.test/v1/me/preferences', { timeFormat: '24h' }],
    ]);
    for (const request of network.requests) {
      expect(request.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
      expect(request.headers.get('x-install-id')).toBe('install-0123456789');
    }
    await waitFor(() => {
      expect(db.raw.prepare('SELECT count(*) AS n FROM outbox').get()).toEqual({ n: 0 });
    });
  });

  it('pressing the current choice queues nothing', async () => {
    const { db } = harness();
    await render(<SettingsScreen />);
    await fireEvent.press(screen.getByTestId('settings-units-imperial'));
    await fireEvent.press(screen.getByTestId('settings-time-12h'));
    expect(db.raw.prepare('SELECT count(*) AS n FROM outbox').get()).toEqual({ n: 0 });
  });
});

describe('withPendingPatches', () => {
  it('keeps a queued choice over the older preferences a sync page carries', () => {
    const db = createMemorySqlite();
    queuePreferencesPatch(db, { distanceUnit: 'km', temperatureUnit: 'c' });
    queuePreferencesPatch(db, { timeFormat: '24h' });
    expect(withPendingPatches(db, DEFAULT_USER_PREFERENCES)).toEqual({
      ...DEFAULT_USER_PREFERENCES,
      distanceUnit: 'km',
      temperatureUnit: 'c',
      timeFormat: '24h',
    });
  });

  it('is the server value once nothing is queued', () => {
    const db = createMemorySqlite();
    expect(withPendingPatches(db, DEFAULT_USER_PREFERENCES)).toEqual(DEFAULT_USER_PREFERENCES);
  });

  it('refuses a patch the API would refuse, before it is queued', () => {
    const db = createMemorySqlite();
    expect(() => {
      queuePreferencesPatch(db, {});
    }).toThrow();
    expect(db.raw.prepare('SELECT count(*) AS n FROM outbox').get()).toEqual({ n: 0 });
  });
});

describe('settings in light and dark', () => {
  it.each(['light', 'dark'] as const)('renders in %s', async (appearance) => {
    harness();
    useSettings.getState().setAppearance(appearance);
    await render(<SettingsScreen />);
    expect(compactTree(screen.toJSON())).toMatchSnapshot();
  });
});
