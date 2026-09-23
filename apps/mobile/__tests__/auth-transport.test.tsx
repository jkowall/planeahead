/**
 * The REAL Better Auth Expo client (`@better-auth/expo` 1.7.5) over an in-memory SecureStore and
 * a recorded fetch (increment 9 review, findings auth-and-store-8 and auth-and-store-9; ruling S9
 * item 8). The other auth tests mock the client wholesale; this one pins the wire shape the
 * server relies on, so a Better Auth bump that changes it fails here:
 *
 * - anonymous sign-in stores the session cookie in SecureStore, with `credentials: 'omit'`;
 * - the in-app magic-link verify is `GET /api/auth/magic-link/verify?token=...` with NO
 *   `callbackURL` and WITH the anonymous cookie (the merge needs it);
 * - native Apple posts `identityToken` (never `idToken`) with the cookie it holds now;
 * - the `/v1` client reads the cookie `get-session` refreshed, per request, with `X-Install-Id`;
 * - `get-session` runs once at launch (the atom's mount fetch and the refresher's launch call are
 *   one request), not on background/foreground churn within the hour, and again after an hour.
 */

import { act, render } from '@testing-library/react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import { AppState, Text, type AppStateStatus } from 'react-native';

// The client passes the global `fetch` it sees WHEN IT IS CREATED to better-fetch
// (`customFetchImpl: fetch`), so the recorded fetch is installed first and the app modules are
// loaded after it, in beforeAll.
type AuthClientModule = typeof import('../src/lib/auth-client');
type MagicLinkModule = typeof import('../src/lib/magic-link');
type AppleModule = typeof import('../src/lib/native-signin/apple');
type RefreshModule = typeof import('../src/lib/session-refresh');
type ApiClientModule = typeof import('../src/lib/api-client');
let auth: AuthClientModule;
let magicLink: MagicLinkModule;
let appleSignIn: AppleModule;
let refresh: RefreshModule;
let apiClient: ApiClientModule;

const API = 'https://api.planeahead.test';
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEf';
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
    __store: store,
  };
});

jest.mock('expo-linking', () => ({
  createURL: (path: string, options?: { scheme?: string }) =>
    `${options?.scheme ?? 'planeahead'}://${path}`,
  useLinkingURL: () => null,
}));

jest.mock('expo-network', () => ({
  addNetworkStateListener: () => ({ remove: () => undefined }),
}));

jest.mock('../src/lib/config', () => ({
  runtimeConfig: () => ({
    variant: 'development',
    apiUrl: 'https://api.planeahead.test',
    universalLinkHosts: ['api.planeahead.test'],
    apnsEnvironment: 'development',
    googleIosClientId: 'ios-client.apps.googleusercontent.com',
    googleWebClientId: 'web-client.apps.googleusercontent.com',
    sentryDsn: null,
  }),
}));

jest.mock('../src/lib/identity', () => ({ installId: () => 'install-test-0001' }));

jest.mock('../src/lib/services', () => ({
  services: () =>
    Promise.resolve({ gate: { hold: <T,>(work: () => Promise<T>): Promise<T> => work() } }),
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
  };
});

jest.mock('expo-device', () => ({ isDevice: false }));

jest.mock('expo-crypto', () => {
  const { createHash } = jest.requireActual<{
    createHash: (algorithm: string) => {
      update(value: string): { digest(encoding: 'hex'): string };
    };
  }>('crypto');
  return {
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    CryptoEncoding: { HEX: 'hex' },
    getRandomBytes: (count: number) => new Uint8Array(count).fill(7),
    digestStringAsync: (_algorithm: string, value: string) =>
      Promise.resolve(createHash('sha256').update(value).digest('hex')),
  };
});

jest.mock('expo-apple-authentication', () => ({
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
  AppleAuthenticationCredentialState: { REVOKED: 0, AUTHORIZED: 1 },
  signInAsync: jest.fn(),
  getCredentialStateAsync: jest.fn(),
}));

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly credentials: RequestCredentials | undefined;
  readonly body: string | null;
}

const calls: Recorded[] = [];
let sessionToken = 'none';

function cookieHeader(value: string): string {
  return `${COOKIE_NAME}=${value}; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function json(body: unknown, setCookie?: string): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (setCookie !== undefined) {
    headers.append('set-cookie', setCookie);
  }
  return new Response(JSON.stringify(body), { status: 200, headers });
}

function user(id: string, email: string, isAnonymous = false) {
  return {
    id,
    email,
    name: '',
    emailVerified: true,
    isAnonymous,
    createdAt: '2026-09-23T12:00:00.000Z',
    updatedAt: '2026-09-23T12:00:00.000Z',
  };
}

function session(token: string) {
  return {
    id: `session-${token}`,
    token,
    userId: 'user-2',
    expiresAt: '2026-10-23T12:00:00.000Z',
    createdAt: '2026-09-23T12:00:00.000Z',
    updatedAt: '2026-09-23T12:00:00.000Z',
  };
}

/** The API, as far as these flows reach it. Every request is recorded. */
function recordedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const method = (init?.method ?? 'GET').toUpperCase();
  calls.push({
    method,
    url,
    headers: new Headers(init?.headers),
    credentials: init?.credentials,
    body: typeof init?.body === 'string' ? init.body : null,
  });
  const { pathname } = new URL(url);
  switch (pathname) {
    case '/api/auth/sign-in/anonymous':
      return Promise.resolve(
        json(
          { token: 'tokA', user: user('anon-1', 'temp@anon.planeahead', true) },
          cookieHeader('tokA.sig'),
        ),
      );
    case '/api/auth/magic-link/verify':
      return Promise.resolve(
        json(
          { token: 'tokB', user: user('user-2', 'ada@example.com'), session: session('tokB') },
          cookieHeader('tokB.sig'),
        ),
      );
    case '/api/auth/sign-in/apple-native':
      return Promise.resolve(
        json({ token: 'tokC', user: user('user-2', 'ada@example.com') }, cookieHeader('tokC.sig')),
      );
    case '/api/auth/get-session':
      return Promise.resolve(
        json(
          { session: session(sessionToken), user: user('user-2', 'ada@example.com') },
          sessionToken === 'none' ? undefined : cookieHeader(`${sessionToken}.sig`),
        ),
      );
    case '/v1/sync':
      return Promise.resolve(
        json({
          rpcVersion: 1,
          serverTime: '2026-09-23T12:00:00.000Z',
          cursor: 'x',
          hasMore: false,
          changes: [],
          flights: [],
        }),
      );
    default:
      return Promise.resolve(new Response('{}', { status: 404 }));
  }
}

function last(pathname: string): Recorded {
  const found = [...calls].reverse().find((call) => new URL(call.url).pathname === pathname);
  if (found === undefined) {
    throw new Error(`no request to ${pathname}`);
  }
  return found;
}

const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = recordedFetch;
  auth = jest.requireActual<AuthClientModule>('../src/lib/auth-client');
  magicLink = jest.requireActual<MagicLinkModule>('../src/lib/magic-link');
  appleSignIn = jest.requireActual<AppleModule>('../src/lib/native-signin/apple');
  refresh = jest.requireActual<RefreshModule>('../src/lib/session-refresh');
  apiClient = jest.requireActual<ApiClientModule>('../src/lib/api-client');
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  calls.length = 0;
});

// First, on a client nothing has touched yet: nanostores keeps the session atom mounted for a
// second after any read, so a launch measured after other requests would count their refetches.
describe('get-session on launch and foreground (the hourly refresher is the one owner)', () => {
  type Listener = (status: AppStateStatus) => void;

  function Root({ refresher }: { refresher: ReturnType<RefreshModule['createSessionRefresher']> }) {
    const { data } = auth.authClient.useSession();
    refresh.useSessionRefresh(refresher);
    return <Text>{data?.user.email ?? 'none'}</Text>;
  }

  async function settle(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    });
  }

  it('fetches once at launch, not on background churn within the hour, and again after an hour', async () => {
    const listeners: Listener[] = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      listeners.push(listener);
      return { remove: () => undefined };
    });
    const emit = (status: AppStateStatus) => {
      for (const listener of listeners) {
        listener(status);
      }
    };
    let clock = 1_000_000;
    const refresher = refresh.createSessionRefresher(auth.refreshSession, () => clock);
    const getSessions = () =>
      calls.filter((call) => new URL(call.url).pathname === '/api/auth/get-session').length;

    const view = await render(<Root refresher={refresher} />);
    await settle();
    expect(getSessions()).toBe(1);

    for (let cycle = 0; cycle < 3; cycle += 1) {
      clock += 5 * 60 * 1000;
      emit('inactive');
      emit('background');
      await settle();
      emit('active');
      await settle();
    }
    expect(getSessions()).toBe(1);

    clock += 60 * 60 * 1000;
    emit('background');
    emit('active');
    await settle();
    expect(getSessions()).toBe(2);
    await view.unmount();
  });

  it('joins a get-session already in flight instead of cancelling and repeating it', async () => {
    const atom = auth.authClient.$store.atoms['session'] as {
      get(): { isRefetching: boolean; refetch: () => Promise<void> };
    };
    const before = calls.length;
    const first = atom.get().refetch();
    // Let the first request start (the atom marks itself refetching before it sends).
    await Promise.resolve();
    await Promise.resolve();
    expect(atom.get().isRefetching).toBe(true);
    await Promise.all([first, auth.refreshSession()]);
    const sessions = calls
      .slice(before)
      .filter((call) => new URL(call.url).pathname === '/api/auth/get-session');
    expect(sessions).toHaveLength(1);
  });
});

describe('the Better Auth Expo client on the wire', () => {
  it('carries the SecureStore session through anonymous sign-in, the magic link, Apple and /v1', async () => {
    // 1. Anonymous sign-in: no cookie yet, the Expo origin, credentials omit.
    const { authClient } = auth;
    await authClient.signIn.anonymous();
    const anonymous = last('/api/auth/sign-in/anonymous');
    expect(anonymous.method).toBe('POST');
    expect(anonymous.credentials).toBe('omit');
    expect(anonymous.headers.get('cookie')).toBeNull();
    expect(anonymous.headers.get('expo-origin')).toBe('planeahead://');
    expect(await authClient.getCookie()).toBe(`${COOKIE_NAME}=tokA.sig`);

    // 2. The magic link, verified in the app: the token only, no callbackURL, the anonymous cookie.
    magicLink.recordMagicLinkRequest('ada@example.com');
    await expect(magicLink.verifyMagicLink(TOKEN)).resolves.toEqual({ ok: true });
    const verify = last('/api/auth/magic-link/verify');
    expect(verify.method).toBe('GET');
    expect(verify.url).toBe(`${API}/api/auth/magic-link/verify?token=${TOKEN}`);
    expect(new URL(verify.url).searchParams.has('callbackURL')).toBe(false);
    expect(verify.headers.get('cookie')).toBe(`${COOKIE_NAME}=tokA.sig`);
    expect(verify.credentials).toBe('omit');
    expect(await authClient.getCookie()).toBe(`${COOKIE_NAME}=tokB.sig`);

    // 3. Native Apple: the body keys, never idToken, and the cookie the client holds now.
    jest.mocked(AppleAuthentication.signInAsync).mockResolvedValueOnce({
      user: '001234.apple-user.0001',
      state: null,
      fullName: null,
      email: null,
      realUserStatus: 1,
      identityToken: 'header.apple-identity.signature',
      authorizationCode: 'c0de',
    });
    await expect(appleSignIn.signInWithApple()).resolves.toEqual({ status: 'signed_in' });
    const apple = last('/api/auth/sign-in/apple-native');
    expect(apple.method).toBe('POST');
    const body = JSON.parse(apple.body ?? '{}') as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['authorizationCode', 'identityToken', 'rawNonce']);
    expect(body).not.toHaveProperty('idToken');
    expect(apple.headers.get('cookie')).toBe(`${COOKIE_NAME}=tokB.sig`);
    expect(apple.credentials).toBe('omit');

    // 4. get-session refreshes the cookie; the /v1 client reads the refreshed one, per request.
    sessionToken = 'tokD';
    await authClient.getSession();
    const api = apiClient.createApiClient({
      baseUrl: API,
      getCookie: () => authClient.getCookie(),
      getInstallId: () => 'install-test-0001',
    });
    await api.v1.sync.$get({ query: {} });
    const sync = last('/v1/sync');
    expect(sync.headers.get('cookie')).toBe(`${COOKIE_NAME}=tokD.sig`);
    expect(sync.headers.get('x-install-id')).toBe('install-test-0001');
    expect(sync.credentials).toBe('omit');
    sessionToken = 'none';
  });
});
