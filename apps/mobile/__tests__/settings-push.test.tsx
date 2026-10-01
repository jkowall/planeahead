/**
 * Increment 16, ruling C1 in Settings: the notification permission as it stands (read again on
 * every return to the foreground), "Turn on notifications" while the system prompt can still show
 * (alert and sound only, the answer registered at once), and the system settings once it is
 * denied. The real src/lib/push.ts over the expo-notifications fake.
 */

import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AppState, Linking, type AppStateStatus } from 'react-native';
import SettingsScreen from '../src/app/(app)/settings';
import {
  fakeNotifications,
  permissionStatus,
  resetFakeNotifications,
} from './support/fake-notifications';

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
  runtimeConfig: () => ({ variant: 'development', apiUrl: 'https://api.planeahead.test' }),
}));
jest.mock('../src/lib/services', () => ({ services: jest.fn(), forgetAccount: jest.fn() }));
jest.mock('../src/lib/sign-out', () => ({ signOut: jest.fn() }));
const mockRegister = jest.fn(() => Promise.resolve());
jest.mock('../src/lib/push-registration', () => ({
  pushRegistrar: () => ({ register: mockRegister }),
}));

const GRANTED = permissionStatus({ status: 'granted', granted: true, iosStatus: 2 });

function captureAppState() {
  const listeners: ((status: AppStateStatus) => void)[] = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
    listeners.push(listener);
    return { remove: jest.fn() };
  });
  return async (status: AppStateStatus) => {
    await act(async () => {
      for (const listener of listeners) {
        listener(status);
      }
      await Promise.resolve();
    });
  };
}

beforeEach(() => {
  resetFakeNotifications();
});

describe('Settings, notifications (ruling C1)', () => {
  it('granted: says so, and has nothing to press', async () => {
    fakeNotifications.permission = GRANTED;
    await render(<SettingsScreen />);
    expect(await screen.findByTestId('settings-notifications-state')).toHaveTextContent(
      'Notifications are on for this phone.',
    );
    expect(screen.queryByTestId('settings-notifications')).toBeNull();
    expect(screen.queryByTestId('settings-notifications-system')).toBeNull();
  });

  it('provisional: a quiet grant, never prompted over', async () => {
    fakeNotifications.permission = permissionStatus({ iosStatus: 3 });
    await render(<SettingsScreen />);
    expect(await screen.findByTestId('settings-notifications-state')).toHaveTextContent(
      'Notifications arrive quietly in Notification Center.',
    );
    expect(screen.queryByTestId('settings-notifications')).toBeNull();
  });

  it('not asked yet: "Turn on notifications" asks for alert and sound, and registers the answer', async () => {
    fakeNotifications.permission = permissionStatus({ iosStatus: 0 });
    fakeNotifications.answer = GRANTED;
    await render(<SettingsScreen />);
    await fireEvent.press(await screen.findByTestId('settings-notifications'));
    expect(await screen.findByText('Notifications are on for this phone.')).toBeTruthy();
    expect(fakeNotifications.requests).toEqual([
      {
        ios: { allowAlert: true, allowSound: true, allowBadge: false, allowProvisional: false },
        android: {},
      },
    ]);
    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('settings-notifications')).toBeNull();
  });

  it('denied: the system settings, and the state read again on the way back', async () => {
    const emit = captureAppState();
    const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue();
    fakeNotifications.permission = permissionStatus({ status: 'denied', iosStatus: 1 });
    await render(<SettingsScreen />);
    expect(await screen.findByTestId('settings-notifications-state')).toHaveTextContent(
      'Notifications are off for PlaneAhead in the system settings.',
    );
    expect(screen.queryByTestId('settings-notifications')).toBeNull();
    await fireEvent.press(screen.getByTestId('settings-notifications-system'));
    expect(openSettings).toHaveBeenCalledTimes(1);

    // Turned on in the system settings, then back to the app.
    fakeNotifications.permission = GRANTED;
    await emit('background');
    await emit('active');
    expect(await screen.findByText('Notifications are on for this phone.')).toBeTruthy();
    expect(screen.queryByTestId('settings-notifications-system')).toBeNull();
  });
});
