/**
 * `forgetAccount` (src/lib/services.ts) over the REAL Better Auth Expo client and a recorded fetch
 * (increment 16 review):
 *
 * - N1: whichever way an account ends (sign-out, deletion, `401 account_deleted`), its
 *   notifications leave the tray and the registrar is reset;
 * - A4's client half: when a sign-out's invalidation was queued, the session is cleared on the
 *   phone and no `/sign-out` leaves it, nor anything else carrying the session, so the session
 *   lives on for the queued call to end it; otherwise `/sign-out` goes, with the session.
 *
 * The client hands better-fetch the global `fetch` it sees when it is created, so the recorded
 * fetch is installed first and the app modules are loaded after it (as auth-transport.test.tsx).
 */

import * as Sentry from '@sentry/react-native';
import {
  fakeNotifications,
  pushNotification,
  resetFakeNotifications,
} from './support/fake-notifications';

type AuthClientModule = typeof import('../src/lib/auth-client');
type ServicesModule = typeof import('../src/lib/services');
let auth: AuthClientModule;
let app: ServicesModule;

const COOKIE_NAME = '__Secure-better-auth.session_token';

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    getItemAsync: (key: string) => Promise.resolve(store.get(key) ?? null),
    setItemAsync: (key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    },
    deleteItemAsync: (key: string) => {
      store.delete(key);
      return Promise.resolve();
    },
  };
});
jest.mock('expo-linking', () => ({ createURL: (path: string) => `planeahead://${path}` }));
jest.mock('expo-network', () => ({
  addNetworkStateListener: () => ({ remove: () => undefined }),
  getNetworkStateAsync: () => Promise.resolve({}),
}));
jest.mock('expo-notifications', () =>
  jest
    .requireActual<typeof import('./support/fake-notifications')>('./support/fake-notifications')
    .fakeNotificationsModule(),
);
jest.mock('../src/lib/config', () => ({
  runtimeConfig: () => ({
    variant: 'development',
    apiUrl: 'https://api.planeahead.test',
    universalLinkHosts: [],
    sentryDsn: null,
  }),
}));
jest.mock('../src/lib/identity', () => ({
  installId: () => 'install-0123456789',
  analyticsId: () => 'analytics-0123456789',
}));
jest.mock('../src/lib/db/kv', () =>
  jest.requireActual<typeof import('./support/memory-kv')>('./support/memory-kv').memoryKvModule(),
);
// The store is never built here: `forgetAccount(null)` (its migrations are `.sql` imports).
jest.mock('../src/lib/db/client', () => ({ whenStoreReady: () => new Promise(() => undefined) }));
const mockRegistrar = { reset: jest.fn() };
jest.mock('../src/lib/push-registration', () => ({ pushRegistrar: () => mockRegistrar }));

/** Every request, with the session cookie it carried. */
const calls: { readonly pathname: string; readonly cookie: string | null }[] = [];

function json(body: unknown, setCookie?: string): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (setCookie !== undefined) {
    headers.append('set-cookie', setCookie);
  }
  return new Response(JSON.stringify(body), { status: 200, headers });
}

function recordedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const { pathname } = new URL(url);
  const cookie = new Headers(init?.headers).get('cookie');
  calls.push({ pathname, cookie });
  const at = '2026-10-01T12:00:00.000Z';
  const user = {
    id: 'anon-1',
    email: 'temp@anon.planeahead',
    name: '',
    emailVerified: false,
    isAnonymous: true,
    createdAt: at,
    updatedAt: at,
  };
  switch (pathname) {
    case '/api/auth/sign-in/anonymous':
      return Promise.resolve(
        json(
          { token: 'tokA', user },
          `${COOKIE_NAME}=tokA.sig; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax`,
        ),
      );
    case '/api/auth/get-session': {
      const session = {
        id: 's-1',
        token: 'tokA',
        userId: 'anon-1',
        expiresAt: '2099-01-01T00:00:00.000Z',
        createdAt: at,
        updatedAt: at,
      };
      return Promise.resolve(json(cookie === null ? null : { session, user }));
    }
    case '/api/auth/sign-out':
      return Promise.resolve(json({ success: true }));
    default:
      return Promise.resolve(new Response('{}', { status: 404 }));
  }
}

const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = recordedFetch;
  auth = jest.requireActual<AuthClientModule>('../src/lib/auth-client');
  app = jest.requireActual<ServicesModule>('../src/lib/services');
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  calls.length = 0;
  resetFakeNotifications();
});

/** Past the session signal's refetch, which the client starts 10 ms after a sign-in or out. */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 30);
  });
}

function sessionData(): unknown {
  const atom = auth.authClient.$store.atoms['session'] as { get(): { data: unknown } };
  return atom.get().data;
}

/** Signed in (anonymously): the cookie in SecureStore and the session in the atom. */
async function signedIn(): Promise<void> {
  await auth.authClient.signIn.anonymous();
  await settle();
  // The atom fetches only while something reads it: the app's own refresh does.
  await auth.refreshSession();
  expect(await auth.authClient.getCookie()).toBe(`${COOKIE_NAME}=tokA.sig`);
  expect(sessionData()).not.toBeNull();
  calls.length = 0;
}

describe('forgetAccount', () => {
  it('a queued sign-out: the session is cleared on the phone, and nothing carrying it leaves (A4)', async () => {
    await signedIn();
    await app.forgetAccount(null, { endSession: false });
    await settle();
    expect(calls.map(({ pathname }) => pathname)).not.toContain('/api/auth/sign-out');
    expect(calls.filter(({ cookie }) => cookie !== null)).toEqual([]);
    expect(await auth.authClient.getCookie()).toBe('');
    expect(sessionData()).toBeNull();
  });

  it('otherwise /sign-out goes, with the session, and the phone forgets it the same way', async () => {
    await signedIn();
    await app.forgetAccount(null);
    await settle();
    expect(calls.find(({ pathname }) => pathname === '/api/auth/sign-out')).toEqual({
      pathname: '/api/auth/sign-out',
      cookie: `${COOKIE_NAME}=tokA.sig`,
    });
    expect(await auth.authClient.getCookie()).toBe('');
    expect(sessionData()).toBeNull();
  });

  it('clears the tray and resets the registrar, whichever way the account ends (N1)', async () => {
    fakeNotifications.presented = [pushNotification('gate_change:AAL-100', { v: '1' })];
    await app.forgetAccount(null);
    expect(fakeNotifications.presented).toEqual([]);
    expect(mockRegistrar.reset).toHaveBeenCalledTimes(1);

    // A tray that cannot be cleared is reported, and holds nothing up.
    const gone = new Error('the presenter is gone');
    fakeNotifications.dismissAll = gone;
    await app.forgetAccount(null);
    expect(Sentry.captureException).toHaveBeenCalledWith(gone);
    expect(mockRegistrar.reset).toHaveBeenCalledTimes(2);
  });
});
