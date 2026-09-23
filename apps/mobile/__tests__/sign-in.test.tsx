/**
 * Sign-in (ruling P7), proven with mocked transports because no local API is reachable from this
 * machine's simulator (apps/mobile/README.md, device acceptance): the sign-in screen offers the
 * providers, anonymous sign-in happens once on first launch, a magic link is requested with
 * `{ email }` only plus `X-Install-Id`, and the universal-link screen verifies in the app with
 * `magicLink.verify({ query: { token } })` (no `callbackURL`): automatically only for a link this
 * install asked for that arrived as a universal link on this build's host, and undone when it
 * signs in to an address this install did not ask for (ruling S9 item 3, threat model 1.5).
 * How a link arrived comes from the router's record of delivered URLs (src/lib/delivered-url.ts,
 * fed by src/app/+native-intent.tsx), which is real here: the tests deliver URLs the way the
 * router does, the launch URL first and later ones after it. `auth-transport.test.tsx` runs the
 * same flows on the real Better Auth client.
 */

import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react-native';
import SignInScreen from '../src/app/(auth)/sign-in';
import MagicLinkScreen from '../src/app/auth/magic-link';
import { authClient, restoreAuthCookies, snapshotAuthCookies } from '../src/lib/auth-client';
import { KV_KEYS, kv } from '../src/lib/db/kv';
import { recordDeliveredUrl, resetDeliveredUrls } from '../src/lib/delivered-url';
import { recordMagicLinkRequest } from '../src/lib/magic-link';
import { signInWithApple } from '../src/lib/native-signin/apple';
import { signInWithGoogle } from '../src/lib/native-signin/google';
import { useBootstrap, useFirstLaunchAnonymousSignIn } from '../src/lib/session';

const mockRouter = { replace: jest.fn(), push: jest.fn() };
let mockSearchParams: Record<string, string> = {};
let mockSession: unknown = null;
const mockGateOrder: string[] = [];

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
    magicLink: {
      verify: jest.fn(() =>
        Promise.resolve({ data: { user: { email: 'ada@example.com' } }, error: null }),
      ),
    },
    signOut: jest.fn(() => Promise.resolve({ data: { success: true }, error: null })),
  },
  snapshotAuthCookies: jest.fn(() => Promise.resolve('{"anonymous-cookie":{"value":"anon"}}')),
  restoreAuthCookies: jest.fn(() => Promise.resolve()),
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

// The services graph needs the store; the magic link only uses the apply gate, recorded here.
jest.mock('../src/lib/services', () => ({
  services: jest.fn(() =>
    Promise.resolve({
      gate: {
        async hold<T>(work: () => Promise<T>): Promise<T> {
          mockGateOrder.push('hold');
          try {
            return await work();
          } finally {
            mockGateOrder.push('release');
          }
        },
      },
    }),
  ),
  forgetAccount: jest.fn(),
}));

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
const UNIVERSAL_LINK = `https://api.planeahead.app/auth/magic-link?token=${TOKEN}`;
/** What every development build launches with on iOS (the dev client's own URL). */
const DEV_CLIENT_LAUNCH_URL =
  'planeahead://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** The link opened the app: the router records it before it navigates here. */
function openedWith(url: string | null): void {
  if (url !== null) {
    recordDeliveredUrl(url, true);
  }
}

beforeEach(() => {
  mockSession = null;
  mockSearchParams = {};
  resetDeliveredUrls();
  mockGateOrder.length = 0;
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
    expect(JSON.parse(kv.getItemSync(KV_KEYS.pendingMagicLink) ?? '[]')).toMatchObject([
      { email: 'ada@example.com' },
    ]);
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
    openedWith(UNIVERSAL_LINK);
    await render(<MagicLinkScreen />);
    await waitFor(() => {
      expect(mockRouter.replace).toHaveBeenCalledWith('/');
    });
    const verify = jest.mocked(authClient.magicLink.verify);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0]?.[0]).toEqual({ query: { token: TOKEN } });
    expect(kv.getItemSync(KV_KEYS.pendingMagicLink)).toBeNull();
    // The outbox was held around the verify and the account check.
    expect(mockGateOrder).toEqual(['hold', 'release']);
    expect(authClient.signOut).not.toHaveBeenCalled();
  });

  it.each([
    ['the custom scheme', `planeahead://auth/magic-link?token=${TOKEN}`],
    [
      'a host this build does not claim',
      `https://api-staging.planeahead.app/auth/magic-link?token=${TOKEN}`,
    ],
    ['plain http', `http://api.planeahead.app/auth/magic-link?token=${TOKEN}`],
    ['another path', `https://api.planeahead.app/api/auth/magic-link/verify?token=${TOKEN}`],
    [
      'a different token in the URL',
      UNIVERSAL_LINK.replace(TOKEN, 'ZyXwVuTsRqPoNmLkJiHgFeDcBaZyXwVu'),
    ],
    ['no linking URL at all', null],
  ])('asks first for a link delivered on %s, even with a request pending', async (_label, url) => {
    recordMagicLinkRequest('ada@example.com');
    mockSearchParams = { token: TOKEN };
    openedWith(url);
    await render(<MagicLinkScreen />);
    expect(screen.getByText('Sign in with this link?')).toBeOnTheScreen();
    expect(authClient.magicLink.verify).not.toHaveBeenCalled();
  });

  it('verifies a requested universal link that follows an earlier custom-scheme URL in the same process', async () => {
    // iOS: Linking.getLinkingURL() would still answer the dev client's launch URL here
    // (increment 9 re-review, auth-and-store-3); the router's record has the link itself.
    recordMagicLinkRequest('ada@example.com');
    recordDeliveredUrl(DEV_CLIENT_LAUNCH_URL, true);
    recordDeliveredUrl(UNIVERSAL_LINK, false);
    mockSearchParams = { token: TOKEN };
    await render(<MagicLinkScreen />);
    await waitFor(() => {
      expect(mockRouter.replace).toHaveBeenCalledWith('/');
    });
    expect(authClient.magicLink.verify).toHaveBeenCalledWith({ query: { token: TOKEN } });
    expect(screen.queryByText('Sign in with this link?')).toBeNull();
  });

  it('decides again when a later delivery arrives while the confirm screen is up', async () => {
    recordMagicLinkRequest('ada@example.com');
    openedWith(`planeahead://auth/magic-link?token=${TOKEN}`);
    mockSearchParams = { token: TOKEN };
    await render(<MagicLinkScreen />);
    expect(screen.getByText('Sign in with this link?')).toBeOnTheScreen();
    expect(authClient.magicLink.verify).not.toHaveBeenCalled();

    // The user now taps the emailed link: a genuine universal link, delivered to the same screen.
    await act(() => {
      recordDeliveredUrl(UNIVERSAL_LINK, false);
    });
    await waitFor(() => {
      expect(authClient.magicLink.verify).toHaveBeenCalledWith({ query: { token: TOKEN } });
    });
    expect(authClient.magicLink.verify).toHaveBeenCalledTimes(1);
  });

  it('runs one verify at a time when the same link is delivered twice', async () => {
    recordMagicLinkRequest('ada@example.com');
    const settle = deferred<{ data: unknown; error: null }>();
    jest.mocked(authClient.magicLink.verify).mockReturnValueOnce(settle.promise);
    openedWith(UNIVERSAL_LINK);
    mockSearchParams = { token: TOKEN };
    await render(<MagicLinkScreen />);
    await waitFor(() => {
      expect(authClient.magicLink.verify).toHaveBeenCalledTimes(1);
    });
    await act(() => {
      recordDeliveredUrl(UNIVERSAL_LINK, false);
    });
    expect(authClient.magicLink.verify).toHaveBeenCalledTimes(1);
    settle.resolve({ data: { user: { email: 'ada@example.com' } }, error: null });
    await waitFor(() => {
      expect(mockRouter.replace).toHaveBeenCalledWith('/');
    });
  });

  it('signs out of an account another address owns and restores the anonymous session', async () => {
    // The attacker's link for the attacker's own address, opened while the user waits for theirs.
    recordMagicLinkRequest('Ada@Example.com');
    jest.mocked(authClient.magicLink.verify).mockResolvedValueOnce({
      data: { user: { email: 'attacker@example.com' } },
      error: null,
    });
    mockSearchParams = { token: TOKEN };
    openedWith(UNIVERSAL_LINK);
    await render(<MagicLinkScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('magic-link-mismatch')).toBeOnTheScreen();
    });
    expect(authClient.signOut).toHaveBeenCalledTimes(1);
    expect(restoreAuthCookies).toHaveBeenCalledWith('{"anonymous-cookie":{"value":"anon"}}');
    expect(jest.mocked(snapshotAuthCookies).mock.invocationCallOrder[0]).toBeLessThan(
      jest.mocked(authClient.magicLink.verify).mock.invocationCallOrder[0] ?? 0,
    );
    expect(mockRouter.replace).not.toHaveBeenCalled();
    // The user's own link may still arrive.
    expect(kv.getItemSync(KV_KEYS.pendingMagicLink)).not.toBeNull();
    expect(mockGateOrder).toEqual(['hold', 'release']);
  });

  it('accepts the requested address in any letter case, and any of several requests', async () => {
    recordMagicLinkRequest('first@example.com');
    recordMagicLinkRequest('Ada@Example.COM');
    mockSearchParams = { token: TOKEN };
    openedWith(UNIVERSAL_LINK);
    await render(<MagicLinkScreen />);
    await waitFor(() => {
      expect(mockRouter.replace).toHaveBeenCalledWith('/');
    });
    expect(authClient.signOut).not.toHaveBeenCalled();
  });

  it('checks the address after a confirmed tap too, while a request is pending', async () => {
    recordMagicLinkRequest('ada@example.com');
    jest.mocked(authClient.magicLink.verify).mockResolvedValueOnce({
      data: { user: { email: 'attacker@example.com' } },
      error: null,
    });
    mockSearchParams = { token: TOKEN };
    openedWith(`planeahead://auth/magic-link?token=${TOKEN}`);
    await render(<MagicLinkScreen />);
    await fireEvent.press(screen.getByTestId('magic-link-confirm'));
    await waitFor(() => {
      expect(screen.getByTestId('magic-link-mismatch')).toBeOnTheScreen();
    });
    expect(authClient.signOut).toHaveBeenCalledTimes(1);
  });

  it('asks before verifying a link this install did not request', async () => {
    mockSearchParams = { token: TOKEN };
    openedWith(UNIVERSAL_LINK);
    await render(<MagicLinkScreen />);
    expect(screen.getByText('Sign in with this link?')).toBeOnTheScreen();
    expect(authClient.magicLink.verify).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId('magic-link-confirm'));
    await waitFor(() => {
      expect(authClient.magicLink.verify).toHaveBeenCalledWith({ query: { token: TOKEN } });
    });
  });

  it('asks when the request window has expired', async () => {
    recordMagicLinkRequest('ada@example.com', Date.now() - 16 * 60 * 1000);
    mockSearchParams = { token: TOKEN };
    openedWith(UNIVERSAL_LINK);
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
    openedWith(UNIVERSAL_LINK);
    await render(<MagicLinkScreen />);
    await waitFor(() => {
      expect(screen.getByText('This link does not work')).toBeOnTheScreen();
    });
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });
});
