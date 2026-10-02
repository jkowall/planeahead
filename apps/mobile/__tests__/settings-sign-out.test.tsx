/**
 * Increment 16 review, N6: Sign out in Settings runs one sign-out at a time. A tap while its
 * confirmation is up, or while it runs, does nothing; the button is disabled while it runs; and
 * Cancel, or a sign-out that ends, lets the next tap through.
 */

import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Alert, type AlertButton } from 'react-native';
import SettingsScreen from '../src/app/(app)/settings';
import { signOut } from '../src/lib/sign-out';
import { resetFakeNotifications } from './support/fake-notifications';

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
/** Changes that have not reached the server: with any, Sign out asks first. */
const mockOutbox = { pending: 0 };
jest.mock('../src/lib/sync/outbox', () => ({
  ...jest.requireActual<typeof import('../src/lib/sync/outbox')>('../src/lib/sync/outbox'),
  pendingCount: () => mockOutbox.pending,
}));
jest.mock('../src/lib/services', () => ({
  services: () => Promise.resolve({ store: { sqlite: null } }),
  forgetAccount: jest.fn(),
}));
jest.mock('../src/lib/sign-out', () => ({ signOut: jest.fn() }));
jest.mock('../src/lib/push-registration', () => ({
  pushRegistrar: () => ({ register: jest.fn() }),
}));

/** Lets a sign-out run until `finish()`. */
function holdSignOut(): () => void {
  let finish: () => void = () => undefined;
  jest.mocked(signOut).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  return () => {
    finish();
  };
}

async function press(): Promise<void> {
  await fireEvent.press(screen.getByTestId('settings-sign-out'));
}

beforeEach(() => {
  resetFakeNotifications();
  mockOutbox.pending = 0;
});

describe('Settings, Sign out (review N6)', () => {
  it('a tap while the confirmation is up does nothing; Cancel lets the next one through', async () => {
    mockOutbox.pending = 2;
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const finish = holdSignOut();
    await render(<SettingsScreen />);
    await press();
    // Still enabled while the question is up: only the guard stops a second tap.
    expect(screen.getByTestId('settings-sign-out')).toBeEnabled();
    await press();
    expect(alert).toHaveBeenCalledTimes(1);

    const buttons = (): AlertButton[] => alert.mock.calls.at(-1)?.[2] ?? [];
    await act(async () => {
      buttons()
        .find(({ text }) => text === 'Cancel')
        ?.onPress?.();
      await Promise.resolve();
    });
    await press();
    expect(alert).toHaveBeenCalledTimes(2);
    await act(async () => {
      buttons()
        .find(({ text }) => text === 'Sign out')
        ?.onPress?.();
      await Promise.resolve();
    });
    expect(signOut).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish();
      await Promise.resolve();
    });
  });

  it('a tap while it runs does nothing, the button disabled; after it, the next tap signs out', async () => {
    const finish = holdSignOut();
    await render(<SettingsScreen />);
    await press();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('settings-sign-out')).toBeDisabled();
    await press();
    expect(signOut).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish();
      await Promise.resolve();
    });
    expect(screen.getByTestId('settings-sign-out')).toBeEnabled();
    holdSignOut();
    await press();
    expect(signOut).toHaveBeenCalledTimes(2);
  });
});
