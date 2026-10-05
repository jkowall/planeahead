/**
 * Increment 16 review, A1 and A3: what a sign-out leaves undone, and what happens to it after.
 * The app's own instances (the device invalidation, the token deletion, the registrar, the hooks
 * of src/lib/session.ts) over an Android-like expo-notifications fake, a scripted invalidation
 * route and a recording `POST /v1/devices` that says which session it carries.
 *
 * - Signed out, a network return and a return to the foreground each retry the queued call (with
 *   the signed-out session's cookies) and the owed deletion, once, and nothing after both succeed;
 *   the foreground also clears the tray; the handler presents nothing (A1 (1), (3)).
 * - The next session deletes first, then reads, then settles and registers; a deletion that fails
 *   again is forgotten, and nothing deletes the token after (A1 (2)).
 * - Signed in with a call still queued, a network return registers, after it (A1 (1)).
 * - The race probe's two orderings send no registration after the invalidation (A3).
 */

import { act, renderHook } from '@testing-library/react-native';
import { onlineManager } from '@tanstack/react-query';
import type { NotificationHandler } from 'expo-notifications';
import { AppState, type AppStateStatus } from 'react-native';
import { kv } from '../src/lib/db/kv';
import {
  TOKEN_DELETION_KEY,
  deviceInvalidation,
  retrySignOutWork,
} from '../src/lib/device-invalidation';
import { installForegroundHandler, setSignedOut } from '../src/lib/push-notifications';
import { pushRegistrar } from '../src/lib/push-registration';
import { useSessionWork, useSignedOutWork } from '../src/lib/session';
import { signOut } from '../src/lib/sign-out';
import {
  fakeNotifications,
  pushNotification,
  resetFakeNotifications,
} from './support/fake-notifications';

/** FCM on Android: a read may take a while; a deletion that succeeds kills the token, and the
 * next read mints another (skeptic 2's probe). */
const mockAndroid = { minted: 1, readMs: 0 };
jest.mock('expo-notifications', () => {
  const support = jest.requireActual<typeof import('./support/fake-notifications')>(
    './support/fake-notifications',
  );
  const fake = support.fakeNotificationsModule();
  return {
    ...fake,
    getDevicePushTokenAsync: () =>
      mockAndroid.readMs === 0
        ? fake.getDevicePushTokenAsync()
        : new Promise((resolve) => {
            setTimeout(resolve, mockAndroid.readMs);
          }).then(() => fake.getDevicePushTokenAsync()),
    unregisterForNotificationsAsync: () =>
      fake.unregisterForNotificationsAsync().then(() => {
        mockAndroid.minted += 1;
        support.fakeNotifications.token = {
          type: 'android',
          data: `fcm-${String(mockAndroid.minted)}`,
        };
      }),
  };
});
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
    __store: store,
  };
});
jest.mock('../src/lib/db/kv', () =>
  jest.requireActual<typeof import('./support/memory-kv')>('./support/memory-kv').memoryKvModule(),
);

type NetworkListener = (state: { isInternetReachable?: boolean }) => void;
const mockNetwork = { listeners: [] as NetworkListener[] };
jest.mock('expo-network', () => ({
  addNetworkStateListener: (listener: NetworkListener) => {
    mockNetwork.listeners.push(listener);
    return {
      remove: () => {
        mockNetwork.listeners = mockNetwork.listeners.filter((each) => each !== listener);
      },
    };
  },
}));
jest.mock('expo-device', () => ({ isDevice: true, modelName: 'Pixel 9', osVersion: '16' }));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '1.0.0' } },
}));
jest.mock('../src/lib/config', () => ({
  runtimeConfig: () => ({ apiUrl: 'https://api.planeahead.test', apnsEnvironment: 'development' }),
}));
jest.mock('../src/lib/identity', () => ({ installId: () => 'install-0123456789' }));
jest.mock('../src/lib/native-signin/apple', () => ({
  checkAppleCredential: () => Promise.resolve('skipped'),
}));

/** Every invalidation, registration and `forgetAccount`, in order (with times in the races). */
const mockLog: string[] = [];
const mockClock = { start: null as number | null };
function mockStamp(entry: string): string {
  return mockClock.start === null ? entry : `${entry} t=${String(Date.now() - mockClock.start)}`;
}
/** The session's cookie map in SecureStore, as the requests read it; null once forgotten. */
const mockSession = { cookies: null as string | null };
function mockSessionToken(): string {
  const map = JSON.parse(mockSession.cookies ?? '{}') as Record<string, { value: string }>;
  return map['better-auth.session_token']?.value ?? 'nobody';
}
jest.mock('../src/lib/auth-client', () => ({
  authClient: {},
  snapshotAuthCookies: () => Promise.resolve(mockSession.cookies),
}));
/** `POST /v1/devices` over the app's client: it carries the session current when it is sent. */
const mockApi = {
  v1: {
    devices: {
      $post: ({ json }: { json: { pushToken?: string } }) => {
        mockLog.push(
          mockStamp(`POST /v1/devices ${json.pushToken ?? 'no token'} as ${mockSessionToken()}`),
        );
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
      },
    },
  },
};
jest.mock('../src/lib/services', () => ({
  services: () =>
    Promise.resolve({
      api: mockApi,
      store: { sqlite: null },
      sync: { sync: () => Promise.resolve() },
      outbox: { drain: () => Promise.resolve({ sent: 0 }) },
    }),
  forgetAccount: (_store: unknown, options?: { endSession?: boolean }) => {
    mockLog.push(
      mockStamp(options?.endSession === false ? 'forgetAccount, no /sign-out' : 'forgetAccount'),
    );
    mockSession.cookies = null;
    return Promise.resolve();
  },
}));

/** The invalidation route: offline it fails at once; online it answers 200 after `delayMs`. */
const server = { online: true, delayMs: 0 };
function invalidationRoute(_url: string, init: RequestInit): Promise<Response> {
  mockLog.push(mockStamp(`invalidate ${(init.headers as Record<string, string>)['Cookie'] ?? ''}`));
  if (!server.online) {
    return Promise.reject(new TypeError('Network request failed'));
  }
  const answer = { ok: true, status: 200 } as Response;
  return server.delayMs === 0
    ? Promise.resolve(answer)
    : new Promise((resolve) => {
        setTimeout(() => {
          resolve(answer);
        }, server.delayMs);
      });
}

function cookieMap(token: string): string {
  return JSON.stringify({
    'better-auth.session_token': { value: token, expires: '2099-01-01T00:00:00.000Z' },
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 5; turn += 1) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
  });
}

function captureAppState() {
  const listeners: ((status: AppStateStatus) => void)[] = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
    listeners.push(listener);
    return {
      remove: () => {
        listeners.splice(listeners.indexOf(listener), 1);
      },
    };
  });
  return (status: AppStateStatus) => {
    for (const listener of [...listeners]) {
      listener(status);
    }
  };
}

function networkReturns(): void {
  for (const listener of [...mockNetwork.listeners]) {
    listener({ isInternetReachable: true });
  }
}

const owed = () => kv.getItemSync(TOKEN_DELETION_KEY) === '1';

/** A sign-out with no network at all: the call is queued and the token deletion fails. */
async function offlineSignOut(deletion: 'fails' | 'succeeds' = 'fails'): Promise<void> {
  mockSession.cookies = cookieMap('tok-old.sig');
  server.online = false;
  onlineManager.setOnline(false);
  fakeNotifications.unregister = deletion === 'fails' ? new Error('SERVICE_NOT_AVAILABLE') : 'ok';
  await signOut(null);
  expect(mockLog).toEqual(['forgetAccount, no /sign-out']);
  mockLog.length = 0;
}

function goOnline(): void {
  server.online = true;
  onlineManager.setOnline(true);
  fakeNotifications.unregister = 'ok';
}

let handler: NotificationHandler | null = null;

beforeAll(() => {
  globalThis.fetch = invalidationRoute as unknown as typeof fetch;
  installForegroundHandler();
  handler = fakeNotifications.handler;
});

beforeEach(() => {
  mockLog.length = 0;
  mockClock.start = null;
  mockSession.cookies = null;
  mockNetwork.listeners = [];
  Object.assign(server, { online: true, delayMs: 0 });
  Object.assign(mockAndroid, { minted: 1, readMs: 0 });
  onlineManager.setOnline(true);
  resetFakeNotifications();
  fakeNotifications.token = { type: 'android', data: 'fcm-1' };
  jest.requireMock<{ __store: Map<string, string> }>('expo-secure-store').__store.clear();
  kv.removeItemSync(TOKEN_DELETION_KEY);
  pushRegistrar().reset();
  setSignedOut(false);
});

describe('signed out (review A1)', () => {
  it('a network return sends the queued call and the owed deletion, once each; then nothing', async () => {
    captureAppState();
    await offlineSignOut();
    expect(owed()).toBe(true);
    fakeNotifications.calls = mockLog;
    await renderHook(() => {
      useSignedOutWork(true);
    });
    await flush();
    // Opened signed out: the tray goes; the launch and the sign-out have just tried the rest.
    expect(mockLog).toEqual(['dismissAll']);

    mockLog.length = 0;
    goOnline();
    networkReturns();
    networkReturns();
    await flush();
    expect(mockLog).toEqual(['unregister', 'invalidate better-auth.session_token=tok-old.sig']);
    expect(owed()).toBe(false);
    await expect(deviceInvalidation().queued()).resolves.toBe(false);

    mockLog.length = 0;
    networkReturns();
    await flush();
    expect(mockLog).toEqual([]);
  });

  it('a return to the foreground does the same, and clears the tray', async () => {
    const emit = captureAppState();
    await offlineSignOut();
    await renderHook(() => {
      useSignedOutWork(true);
    });
    await flush();
    goOnline();
    fakeNotifications.presented = [pushNotification('gate_change:AAL-100', { v: '1' })];
    fakeNotifications.calls = mockLog;
    emit('background');
    emit('active');
    await flush();
    expect(mockLog).toEqual([
      'dismissAll',
      'unregister',
      'invalidate better-auth.session_token=tok-old.sig',
    ]);
    expect(fakeNotifications.presented).toEqual([]);
    expect(owed()).toBe(false);
  });

  it('a launch tries both again too (the root layout, at module scope)', async () => {
    await offlineSignOut();
    goOnline();
    fakeNotifications.calls = mockLog;
    retrySignOutWork();
    await flush();
    expect(mockLog).toEqual(['unregister', 'invalidate better-auth.session_token=tok-old.sig']);
    expect(owed()).toBe(false);
  });

  it('the handler presents nothing while the session is known to be null, and as before while it loads', async () => {
    const emit = captureAppState();
    if (handler === null) {
      throw new Error('no handler was installed');
    }
    const push = pushNotification('gate_change:AAL-100', {
      v: '1',
      kind: 'gate_change',
      flightSubscriptionId: '0199a000-0000-7000-8000-000000000001',
    });
    const shown = { shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true };
    const view = await renderHook(
      (props: { signedOut: boolean }) => {
        useSignedOutWork(props.signedOut);
      },
      { initialProps: { signedOut: false } },
    );
    // Loading (or signed in): as before, and nothing retried on a foreground.
    await expect(handler.handleNotification(push)).resolves.toMatchObject(shown);
    fakeNotifications.calls = mockLog;
    emit('active');
    await flush();
    expect(mockLog).toEqual([]);

    await view.rerender({ signedOut: true });
    await expect(handler.handleNotification(push)).resolves.toEqual({
      shouldShowBanner: false,
      shouldShowList: false,
      shouldPlaySound: false,
      shouldSetBadge: false,
    });
    await view.rerender({ signedOut: false });
    await expect(handler.handleNotification(push)).resolves.toMatchObject(shown);
  });
});

describe('the next session (review A1)', () => {
  it('deletes the owed token first, then reads one, then settles the queued call and registers', async () => {
    await offlineSignOut();
    goOnline();
    mockSession.cookies = cookieMap('tok-new.sig');
    fakeNotifications.calls = mockLog;
    await pushRegistrar().register();
    expect(mockLog).toEqual([
      'unregister',
      'getPermissions',
      'getToken',
      'invalidate better-auth.session_token=tok-old.sig',
      'POST /v1/devices fcm-2 as tok-new.sig',
    ]);
    expect(owed()).toBe(false);
  });

  it('a deletion that fails again is forgotten: the token goes to the new session, and stays', async () => {
    await offlineSignOut();
    goOnline();
    fakeNotifications.unregister = new Error('SERVICE_NOT_AVAILABLE');
    mockSession.cookies = cookieMap('tok-new.sig');
    fakeNotifications.calls = mockLog;
    await pushRegistrar().register();
    expect(mockLog).toEqual([
      'unregister',
      'getPermissions',
      'getToken',
      'invalidate better-auth.session_token=tok-old.sig',
      'POST /v1/devices fcm-1 as tok-new.sig',
    ]);
    expect(owed()).toBe(false);

    // A later foreground, and a later launch: nothing deletes the token now the session has it.
    mockLog.length = 0;
    fakeNotifications.unregister = 'ok';
    await pushRegistrar().register();
    retrySignOutWork();
    await flush();
    expect(mockLog).toEqual([
      'getPermissions',
      'getToken',
      'POST /v1/devices fcm-1 as tok-new.sig',
    ]);
  });

  it('signed in with a call still queued, a network return registers, after the call', async () => {
    captureAppState();
    await offlineSignOut('succeeds');
    mockSession.cookies = cookieMap('tok-new.sig');
    const view = await renderHook(() => {
      useSessionWork('user-2');
    });
    await flush();
    // Still offline: the session's first run cannot settle the call, so it registers nothing.
    expect(mockLog).toEqual(['invalidate better-auth.session_token=tok-old.sig']);
    await expect(deviceInvalidation().queued()).resolves.toBe(true);

    mockLog.length = 0;
    goOnline();
    networkReturns();
    await flush();
    expect(mockLog).toEqual([
      'invalidate better-auth.session_token=tok-old.sig',
      'POST /v1/devices fcm-2 as tok-new.sig',
    ]);

    // None queued now: a network return registers nothing (the foreground does that).
    mockLog.length = 0;
    networkReturns();
    await flush();
    expect(mockLog).toEqual([]);
    await view.unmount();
  });
});

describe('a registration racing sign-out (review A3; the race probe, the invalidation answering in 800 ms)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockClock.start = Date.now();
    mockSession.cookies = cookieMap('tok-a.sig');
    server.delayMs = 800;
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('a token read of 5.5 s, begun just before: sign-out waits 5 s for it, and it posts nothing after', async () => {
    mockAndroid.readMs = 5_500;
    void pushRegistrar().register();
    const done = signOut(null);
    await jest.advanceTimersByTimeAsync(10_000);
    await done;
    expect(mockLog).toEqual([
      'invalidate better-auth.session_token=tok-a.sig t=5000',
      'forgetAccount t=5800',
    ]);
  });

  it('a foreground 200 ms into the invalidation registers nothing; the next session does', async () => {
    const done = signOut(null);
    await jest.advanceTimersByTimeAsync(200);
    // What the foreground listener calls (src/lib/session.ts), while the session is still there.
    void pushRegistrar().register();
    await jest.advanceTimersByTimeAsync(10_000);
    await done;
    expect(mockLog).toEqual([
      'invalidate better-auth.session_token=tok-a.sig t=0',
      'forgetAccount t=800',
    ]);

    mockSession.cookies = cookieMap('tok-b.sig');
    const next = pushRegistrar().register();
    await jest.advanceTimersByTimeAsync(0);
    await next;
    expect(mockLog.slice(2)).toEqual(['POST /v1/devices fcm-2 as tok-b.sig t=10200']);
  });

  it('a session started while the token deletion still runs registers: the pause ends with the old session (re-review R1)', async () => {
    fakeNotifications.unregister = 'pending';
    const done = signOut(null);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(mockLog).toEqual([
      'invalidate better-auth.session_token=tok-a.sig t=0',
      'forgetAccount t=800',
    ]);
    // A quick next session ("continue without an account"), 200 ms after the old one was cleared.
    mockSession.cookies = cookieMap('tok-b.sig');
    const next = pushRegistrar().register();
    await jest.advanceTimersByTimeAsync(15_000);
    await next;
    await done;
    expect(mockLog.slice(2)).toEqual([
      expect.stringMatching(/^POST \/v1\/devices .* as tok-b\.sig/),
    ]);
  });
});
