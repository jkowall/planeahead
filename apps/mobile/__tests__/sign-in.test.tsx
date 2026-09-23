/**
 * Sign-in (ruling P7), proven with mocked transports because no local API is reachable from this
 * machine's simulator (apps/mobile/README.md, device acceptance): the sign-in screen offers the
 * providers, anonymous sign-in happens once on first launch, a magic link is requested with
 * `{ email }` only plus `X-Install-Id`, and the universal-link screen verifies in the app with
 * `magicLink.verify({ query: { token } })` (no `callbackURL`), automatically only for a link this
 * install asked for.
 */

import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react-native';
import SignInScreen from '../src/app/(auth)/sign-in';
import MagicLinkScreen from '../src/app/auth/magic-link';
import { authClient } from '../src/lib/auth-client';
import { KV_KEYS, kv } from '../src/lib/db/kv';
import { recordMagicLinkRequest } from '../src/lib/magic-link';
import { signInWithApple } from '../src/lib/native-signin/apple';
import { signInWithGoogle } from '../src/lib/native-signin/google';
import { useBootstrap, useFirstLaunchAnonymousSignIn } from '../src/lib/session';

const mockRouter = { replace: jest.fn(), push: jest.fn() };
let mockSearchParams: Record<string, string> = {};
let mockSession: unknown = null;

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockSearchParams,
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});

jest.mock('expo-apple-authentication', () => {
  const { Pressable, Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    AppleAuthenticationButtonType: { SIGN_IN: 0, CONTINUE: 1 },
    AppleAuthenticationButtonStyle: { WHITE: 0, BLACK: 2 },
    AppleAuthenticationButton: ({ onPress, testID }: { onPress: () => void; testID?: string }) => (
      <Pressable accessibilityRole="button" onPress={onPress} testID={testID}>
        <Text>Continue with Apple</Text>
      </Pressable>
    ),
  };
});

jest.mock('../src/lib/auth-client', () => ({
  isAnonymousSession:
    jest.requireActual<typeof import('../src/lib/auth-session')>('../src/lib/auth-session')
      .isAnonymousSession,
  authClient: {
    useSession: jest.fn(() => ({ data: mockSession, isPending: false })),
    signIn: {
      anonymous: jest.fn(() => Promise.resolve({ data: {}, error: null })),
      magicLink: jest.fn(() => Promise.resolve({ data: { status: true }, error: null })),
    },
    magicLink: { verify: jest.fn(() => Promise.resolve({ data: {}, error: null })) },
  },
}));

jest.mock('../src/lib/native-signin/apple', () => ({
  signInWithApple: jest.fn(() => Promise.resolve({ status: 'signed_in' })),
}));
jest.mock('../src/lib/native-signin/google', () => ({
  signInWithGoogle: jest.fn(() => Promise.resolve({ status: 'signed_in' })),
}));

jest.mock('../src/lib/config', () => ({
  runtimeConfig: () => ({
    variant: 'development',
    apiUrl: 'https://api.planeahead.test',
    universalLinkHosts: ['api.planeahead.app'],
    googleIosClientId: 'ios-client.apps.googleusercontent.com',
    googleWebClientId: 'web-client.apps.googleusercontent.com',
    sentryDsn: null,
  }),
}));

jest.mock('../src/lib/identity', () => ({ installId: () => 'install-test-0001' }));

// session.ts imports the services graph; nothing in these tests reaches it.
jest.mock('../src/lib/services', () => ({ services: jest.fn(), forgetAccount: jest.fn() }));

jest.mock('../src/lib/db/kv', () => {
  const store = new Map<string, string>();
  return {
    KV_KEYS: jest.requireActual<typeof import('../src/lib/db/kv')>('../src/lib/db/kv').KV_KEYS,
    kv: {
      getItemSync: (key: string) => store.get(key) ?? null,
      setItemSync: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItemSync: (key: string) => store.delete(key),
    },
    zustandKvStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    },
  };
});

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEf';

beforeEach(() => {
  mockSession = null;
  mockSearchParams = {};
  kv.removeItemSync(KV_KEYS.pendingMagicLink);
  kv.removeItemSync(KV_KEYS.firstLaunchDone);
});

describe('the sign-in screen', () => {
  it('offers Apple, Google, a magic link and carrying on without an account', async () => {
    await render(<SignInScreen />);
    expect(screen.getByText('Sign in to PlaneAhead')).toBeOnTheScreen();
    expect(screen.getByTestId('sign-in-apple')).toBeOnTheScreen();
    expect(screen.getByTestId('sign-in-google')).toBeOnTheScreen();
    expect(screen.getByTestId('sign-in-email')).toBeOnTheScreen();
    expect(screen.getByTestId('sign-in-email-send')).toBeOnTheScreen();
    expect(screen.getByTestId('sign-in-anonymous')).toBeOnTheScreen();
  });

  it('signs in anonymously when asked and goes home', async () => {
    await render(<SignInScreen />);
    await fireEvent.press(screen.getByTestId('sign-in-anonymous'));
    await waitFor(() => {
      expect(mockRouter.replace).toHaveBeenCalledWith('/');
    });
    expect(authClient.signIn.anonymous).toHaveBeenCalledTimes(1);
  });

  it('requests a magic link with the address only (no callbackURL) and X-Install-Id', async () => {
    await render(<SignInScreen />);
    await fireEvent.changeText(screen.getByTestId('sign-in-email'), '  ada@example.com ');
    await fireEvent.press(screen.getByTestId('sign-in-email-send'));
    await waitFor(() => {
      expect(screen.getByTestId('sign-in-message')).toHaveTextContent(/a link is on its way/);
    });

    const magicLink = jest.mocked(authClient.signIn.magicLink);
    expect(magicLink).toHaveBeenCalledTimes(1);
    const [body, options] = magicLink.mock.calls[0] as unknown as [
      Record<string, unknown>,
      { headers: Record<string, string> },
    ];
    expect(body).toEqual({ email: 'ada@example.com' });
    expect(body).not.toHaveProperty('callbackURL');
    expect(options.headers).toEqual({ 'X-Install-Id': 'install-test-0001' });
    // This install now expects the link: the universal-link screen will verify it at once.
    expect(JSON.parse(kv.getItemSync(KV_KEYS.pendingMagicLink) ?? '{}')).toMatchObject({
      email: 'ada@example.com',
    });
  });

  it('does not send a link for something that is not an address', async () => {
    await render(<SignInScreen />);
    await fireEvent.changeText(screen.getByTestId('sign-in-email'), 'not-an-address');
    await fireEvent.press(screen.getByTestId('sign-in-email-send'));
    expect(authClient.signIn.magicLink).not.toHaveBeenCalled();
    expect(screen.getByTestId('sign-in-message')).toHaveTextContent(/Enter the email address/);
  });

  it('runs the native Apple and Google paths and goes home on success', async () => {
    await render(<SignInScreen />);
    await fireEvent.press(screen.getByTestId('sign-in-apple'));
    await waitFor(() => {
      expect(signInWithApple).toHaveBeenCalledTimes(1);
    });
    await fireEvent.press(screen.getByTestId('sign-in-google'));
    await waitFor(() => {
      expect(signInWithGoogle).toHaveBeenCalledTimes(1);
    });
    expect(mockRouter.replace).toHaveBeenCalledWith('/');
  });

  it('presents an upgrade to an anonymous user, without the anonymous option', async () => {
    mockSession = { user: { id: 'u1', isAnonymous: true }, session: { id: 's1' } };
    await render(<SignInScreen />);
    expect(screen.getByText('Keep your flights')).toBeOnTheScreen();
    expect(screen.queryByTestId('sign-in-anonymous')).toBeNull();
    expect(screen.getByTestId('sign-in-not-now')).toBeOnTheScreen();
  });
});

describe('first launch', () => {
  it('signs in anonymously exactly once per installation', async () => {
    useBootstrap.setState({ anonymousPending: true });
    const first = await renderHook(() => {
      useFirstLaunchAnonymousSignIn(false, false);
    });
    await waitFor(() => {
      expect(useBootstrap.getState().anonymousPending).toBe(false);
    });
    expect(authClient.signIn.anonymous).toHaveBeenCalledTimes(1);
    expect(kv.getItemSync(KV_KEYS.firstLaunchDone)).toBe('1');
    await first.unmount();

    // A later launch without a session (signed out) goes to the sign-in screen instead.
    useBootstrap.setState({ anonymousPending: kv.getItemSync(KV_KEYS.firstLaunchDone) !== '1' });
    await renderHook(() => {
      useFirstLaunchAnonymousSignIn(false, false);
    });
    expect(authClient.signIn.anonymous).toHaveBeenCalledTimes(1);
  });

  it('waits for the stored session to load before deciding', async () => {
    useBootstrap.setState({ anonymousPending: true });
    await renderHook(() => {
      useFirstLaunchAnonymousSignIn(false, true);
    });
    expect(authClient.signIn.anonymous).not.toHaveBeenCalled();
    expect(useBootstrap.getState().anonymousPending).toBe(true);
  });
});

describe('the magic-link universal link', () => {
  it('verifies in the app, with the token only, when this install asked for the link', async () => {
    recordMagicLinkRequest('ada@example.com');
    mockSearchParams = { token: TOKEN };
    await render(<MagicLinkScreen />);
    await waitFor(() => {
      expect(mockRouter.replace).toHaveBeenCalledWith('/');
    });
    const verify = jest.mocked(authClient.magicLink.verify);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0]?.[0]).toEqual({ query: { token: TOKEN } });
    expect(kv.getItemSync(KV_KEYS.pendingMagicLink)).toBeNull();
  });

  it('asks before verifying a link this install did not request', async () => {
    mockSearchParams = { token: TOKEN };
    await render(<MagicLinkScreen />);
    expect(screen.getByText('Sign in with this link?')).toBeOnTheScreen();
    expect(authClient.magicLink.verify).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId('magic-link-confirm'));
    await waitFor(() => {
      expect(authClient.magicLink.verify).toHaveBeenCalledWith({ query: { token: TOKEN } });
    });
  });

  it('does not ask for an expired request window either', async () => {
    recordMagicLinkRequest('ada@example.com', Date.now() - 16 * 60 * 1000);
    mockSearchParams = { token: TOKEN };
    await render(<MagicLinkScreen />);
    expect(screen.getByTestId('magic-link-confirm')).toBeOnTheScreen();
    expect(authClient.magicLink.verify).not.toHaveBeenCalled();
  });

  it('refuses a malformed token without calling the API', async () => {
    recordMagicLinkRequest('ada@example.com');
    mockSearchParams = { token: 'short' };
    await render(<MagicLinkScreen />);
    expect(screen.getByText('This link does not work')).toBeOnTheScreen();
    expect(authClient.magicLink.verify).not.toHaveBeenCalled();
  });

  it('shows the failure when the server refuses the token (expired or used)', async () => {
    recordMagicLinkRequest('ada@example.com');
    jest.mocked(authClient.magicLink.verify).mockResolvedValueOnce({
      data: null,
      error: { status: 400, statusText: 'Bad Request', code: 'INVALID_TOKEN' },
    });
    mockSearchParams = { token: TOKEN };
    await render(<MagicLinkScreen />);
    await waitFor(() => {
      expect(screen.getByText('This link does not work')).toBeOnTheScreen();
    });
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });
});
