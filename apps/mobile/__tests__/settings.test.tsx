/**
 * Settings persist across an OFFLINE relaunch through the expo-sqlite kv-store (docs/increments/09
 * acceptance). A "launch" is a fresh module registry, so the zustand store, the kv module and the
 * screen are all evaluated again, exactly as after a process restart; the SQLite database behind
 * the kv-store (Node's `node:sqlite`, through the `SqliteLike` fake) is the only thing that
 * survives, as the file on disk does. The second launch has no network at all.
 *
 * Increment 16 (ruling C11): the notification toggles persist with the rest, and a state written
 * before them (no `notifications`) still hydrates, with their defaults.
 */

import { DEFAULT_NOTIFICATION_PREFERENCES, DEFAULT_USER_PREFERENCES } from '@planeahead/shared';
import type * as RNTL from '@testing-library/react-native/pure';
import type * as ReactModule from 'react';
import type { ComponentType } from 'react';
import { createMemorySqlite } from './support/memory-sqlite';

// The "disk": one SQLite database for every launch in this file.
const mockDisk = createMemorySqlite({ migrate: false });
const mockNetwork = { online: true };

jest.mock('expo-sqlite/kv-store', () => ({
  Storage: jest
    .requireActual<typeof import('./support/kv-store')>('./support/kv-store')
    .sqliteKvStorage(mockDisk),
}));

jest.mock('expo-network', () => ({
  addNetworkStateListener: jest.fn(() => ({ remove: jest.fn() })),
  getNetworkStateAsync: jest.fn(() =>
    Promise.resolve({ isConnected: mockNetwork.online, isInternetReachable: mockNetwork.online }),
  ),
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn(), replace: jest.fn() }) }));

jest.mock('../src/lib/auth-client', () => ({
  isAnonymousSession: () => true,
  authClient: {
    // Offline the Expo client serves the session it cached in SecureStore.
    useSession: () => ({
      data: { user: { id: 'u1', isAnonymous: true, email: 'anon@planeahead.invalid' } },
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

jest.mock('../src/lib/services', () => ({ services: jest.fn(), forgetAccount: jest.fn() }));
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

interface Launch {
  readonly rntl: typeof RNTL;
  readonly React: typeof ReactModule;
  readonly SettingsScreen: ComponentType;
  readonly useSettings: typeof import('../src/lib/settings').useSettings;
}

/**
 * A process start: the app's modules (the settings store, the kv module, the screen) are
 * evaluated again from a fresh registry; only the SQLite "disk" carries over. React and the
 * testing library are shared with the test file (one renderer, one React), the way a real
 * relaunch has one of each.
 */
function launch(): Launch {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const rntl = require('@testing-library/react-native/pure') as typeof RNTL;
  const React = require('react') as typeof ReactModule;
  const jsxRuntime = require('react/jsx-runtime') as unknown;
  let loaded: Launch | null = null;
  jest.isolateModules(() => {
    jest.doMock('react', () => React);
    jest.doMock('react/jsx-runtime', () => jsxRuntime);
    // `require` inside the isolated registry is the point: a static import would share the
    // modules of the previous launch, and dynamic `import()` needs Node's VM modules.
    loaded = {
      rntl,
      React,
      SettingsScreen: (require('../src/app/(app)/settings') as { default: ComponentType }).default,
      useSettings: (require('../src/lib/settings') as typeof import('../src/lib/settings'))
        .useSettings,
    };
  });
  /* eslint-enable @typescript-eslint/no-require-imports */
  if (loaded === null) {
    throw new Error('the launch did not load');
  }
  return loaded;
}

function storedSettings(): unknown {
  const row = mockDisk.raw
    .prepare('SELECT value FROM storage WHERE key = ?')
    .get('planeahead.settings') as { value: string } | undefined;
  return row === undefined ? null : JSON.parse(row.value);
}

describe('settings', () => {
  const fetchMock = jest.fn(() => Promise.reject(new TypeError('Network request failed')));

  beforeAll(() => {
    globalThis.fetch = fetchMock;
  });

  it('persist across an offline relaunch through the expo-sqlite kv-store', async () => {
    // First launch, online: the user picks the dark appearance; a sync page brought preferences.
    const first = launch();
    expect(first.useSettings.getState().appearance).toBe('system');
    await first.rntl.render(first.React.createElement(first.SettingsScreen));
    await first.rntl.fireEvent.press(first.rntl.screen.getByTestId('settings-appearance-dark'));
    // The screen shows the units and time format since increment 10, so the page's preferences
    // re-render it: inside act, as React requires.
    await first.rntl.act(() => {
      first.useSettings.getState().applyServerPreferences({
        distanceUnit: 'km',
        temperatureUnit: 'c',
        timeFormat: '24h',
        showLocalTimes: false,
        settings: {},
      });
      // Increment 16 (ruling C11): a notification toggle, persisted the same way.
      first.useSettings.getState().updateNotifications({ events: { first_gate_assignment: true } });
    });
    expect(
      first.rntl.screen.getByTestId('settings-appearance-dark').props.accessibilityState,
    ).toMatchObject({ selected: true });
    await first.rntl.cleanup();

    // The value is in the SQLite table, not in memory.
    expect(storedSettings()).toMatchObject({
      state: {
        appearance: 'dark',
        preferences: { timeFormat: '24h', distanceUnit: 'km' },
        notifications: { pushEnabled: true, events: { first_gate_assignment: true } },
      },
    });

    // Relaunch with no network: hydration is synchronous, so the store has the values before
    // anything renders, and the first render already shows them.
    mockNetwork.online = false;
    fetchMock.mockClear();
    const second = launch();
    expect(second.useSettings.getState().appearance).toBe('dark');
    expect(second.useSettings.getState().preferences).toMatchObject({
      timeFormat: '24h',
      distanceUnit: 'km',
      showLocalTimes: false,
    });
    await second.rntl.render(second.React.createElement(second.SettingsScreen));
    expect(
      second.rntl.screen.getByTestId('settings-appearance-dark').props.accessibilityState,
    ).toMatchObject({ selected: true });
    expect(
      second.rntl.screen.getByTestId('settings-appearance-system').props.accessibilityState,
    ).toMatchObject({ selected: false });
    expect(
      second.rntl.screen.getByTestId('settings-notify-first_gate_assignment').props.value,
    ).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    await second.rntl.cleanup();
  });

  it('reset (sign-out, account deletion) goes back to the defaults and persists that too', () => {
    const third = launch();
    third.useSettings.getState().reset();
    expect(storedSettings()).toMatchObject({ state: { appearance: 'system' } });
    const fourth = launch();
    expect(fourth.useSettings.getState().appearance).toBe('system');
    expect(fourth.useSettings.getState().preferences.timeFormat).toBe('12h');
    expect(fourth.useSettings.getState().notifications).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
  });

  it('a state persisted before increment 16 keeps its values and takes the notification defaults', () => {
    mockDisk.run(
      'INSERT INTO storage (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;',
      [
        'planeahead.settings',
        JSON.stringify({
          state: {
            appearance: 'light',
            preferences: { ...DEFAULT_USER_PREFERENCES, timeFormat: '24h' },
          },
          version: 1,
        }),
      ],
    );
    const fifth = launch();
    expect(fifth.useSettings.getState().appearance).toBe('light');
    expect(fifth.useSettings.getState().preferences.timeFormat).toBe('24h');
    expect(fifth.useSettings.getState().notifications).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
  });
});
