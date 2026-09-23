/**
 * The development-only seeded home route (src/app/dev/seeded-home.tsx) and the launch-argument
 * redirect to it in the sign-in group's layout (src/dev/seeded-launch.ts) are inert outside
 * `__DEV__` and outside the development variant (increment 10 review, ruling X2): in such an
 * evaluation the route seeds nothing, opens no store, renders none of its own content (only the
 * redirect home), and the sign-in layout never sends anyone to it, whatever the launch argument.
 * Both exist for the one device check increment 10 runs without an API
 * (docs/increments/10-verification.md).
 */

import { render, screen, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';
import AuthLayout from '../src/app/(auth)/_layout';
import SeededHome from '../src/app/dev/seeded-home';
import { seedDemoFlights } from '../src/dev/demo-flights';
import { seededHomeRequested } from '../src/dev/seeded-launch';
import { whenStoreReady } from '../src/lib/db/client';

const mockConfig = { variant: 'development' as string };
/** NSUserDefaults' argument domain, as React Native's `Settings` reads it on iOS. */
const mockDefaults: { value: unknown } = { value: 'YES' };

jest.mock('react-native/Libraries/Settings/Settings', () => ({
  __esModule: true,
  default: {
    get: (key: string) =>
      key ===
      jest.requireActual<typeof import('../src/dev/seeded-launch')>('../src/dev/seeded-launch')
        .SEEDED_HOME_ARGUMENT
        ? mockDefaults.value
        : undefined,
    set: jest.fn(),
    watchKeys: jest.fn(),
    clearWatch: jest.fn(),
  },
}));

jest.mock('expo-router', () => {
  const { Text: MockText } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Redirect: ({ href }: { href: string }) => (
      <MockText testID={`redirect:${href}`}>{href}</MockText>
    ),
    Stack: () => <MockText testID="auth-stack">stack</MockText>,
  };
});

jest.mock('../src/lib/config', () => ({
  runtimeConfig: () => ({ ...mockConfig, apiUrl: 'https://api.planeahead.test' }),
}));

jest.mock('../src/lib/db/client', () => ({
  whenStoreReady: jest.fn(() =>
    Promise.resolve({ sqlite: { get: () => ({ n: 0 }) }, db: null, orm: null }),
  ),
}));

jest.mock('../src/dev/demo-flights', () => ({ seedDemoFlights: jest.fn() }));

jest.mock('../src/app/(app)/index', () => {
  const { Text: MockText } = jest.requireActual<typeof import('react-native')>('react-native');
  return () => <MockText testID="home">home</MockText>;
});

jest.mock('../src/lib/auth-client', () => ({
  authClient: { useSession: () => ({ data: null, isPending: false }) },
  isAnonymousSession: () => false,
}));

const globals = globalThis as unknown as { __DEV__: boolean };
const devBefore = globals.__DEV__;

function launchArgument(value: unknown): void {
  mockDefaults.value = value;
}

beforeEach(() => {
  globals.__DEV__ = true;
  mockConfig.variant = 'development';
  (Platform as { OS: string }).OS = 'ios';
  launchArgument('YES');
});

afterAll(() => {
  globals.__DEV__ = devBefore;
});

describe('the launch-argument redirect (src/dev/seeded-launch.ts)', () => {
  it('fires only in a development build of the development variant on iOS, when asked', () => {
    expect(seededHomeRequested()).toBe(true);
    launchArgument(undefined);
    expect(seededHomeRequested()).toBe(false);
  });

  it('never fires when __DEV__ is false, whatever the launch argument says', () => {
    globals.__DEV__ = false;
    for (const value of ['YES', 1, true, '1', 'true']) {
      launchArgument(value);
      expect(seededHomeRequested()).toBe(false);
    }
  });

  it('never fires on Android (the emulator check opens the route by an explicit intent)', () => {
    (Platform as { OS: string }).OS = 'android';
    expect(seededHomeRequested()).toBe(false);
  });

  it.each(['preview', 'production'])('never fires in the %s variant', (variant) => {
    mockConfig.variant = variant;
    expect(seededHomeRequested()).toBe(false);
  });

  it('the sign-in layout redirects to the seeded route only in development', async () => {
    await render(<AuthLayout />);
    expect(screen.getByTestId('redirect:/dev/seeded-home')).toBeOnTheScreen();
  });

  it('the sign-in layout never redirects there when __DEV__ is false', async () => {
    globals.__DEV__ = false;
    await render(<AuthLayout />);
    expect(screen.queryByTestId('redirect:/dev/seeded-home')).toBeNull();
    expect(screen.getByTestId('auth-stack')).toBeOnTheScreen();
  });

  it('nor in the production variant of a development build', async () => {
    mockConfig.variant = 'production';
    await render(<AuthLayout />);
    expect(screen.queryByTestId('redirect:/dev/seeded-home')).toBeNull();
    expect(screen.getByTestId('auth-stack')).toBeOnTheScreen();
  });
});

describe('the seeded home route (src/app/dev/seeded-home.tsx)', () => {
  it('seeds an empty store and shows the home screen in development', async () => {
    await render(<SeededHome />);
    await waitFor(() => {
      expect(screen.getByTestId('home')).toBeOnTheScreen();
    });
    expect(seedDemoFlights).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['__DEV__ is false', () => (globals.__DEV__ = false)],
    ['the variant is production', () => (mockConfig.variant = 'production')],
    ['the variant is preview', () => (mockConfig.variant = 'preview')],
  ])('renders nothing of its own and touches no store when %s', async (_name, arrange) => {
    arrange();
    const view = await render(<SeededHome />);
    // Only the redirect home: no loading state, no home screen, no seed, no store opened.
    expect(screen.getByTestId('redirect:/')).toBeOnTheScreen();
    expect(screen.queryByTestId('home')).toBeNull();
    expect(screen.queryByLabelText('Seeding demo flights')).toBeNull();
    // The whole rendered tree is the redirect.
    const tree = view.toJSON() as { props: Record<string, unknown> } | null;
    expect(tree?.props['testID']).toBe('redirect:/');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(whenStoreReady).not.toHaveBeenCalled();
    expect(seedDemoFlights).not.toHaveBeenCalled();
  });
});
