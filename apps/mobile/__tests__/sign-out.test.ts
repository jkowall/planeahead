/**
 * Increment 16, ruling C3: sign-out invalidates this installation's tokens, with the session it
 * signs out of, before `authClient.signOut()`; offline the call is queued and retried on the next
 * launch before any registration, with the signed-out session's cookies and never the current
 * one's; then the device unregisters (src/lib/device-invalidation.ts, src/lib/sign-out.ts).
 */

import { getCookie } from '@better-auth/expo/client';
import * as Sentry from '@sentry/react-native';
import { onlineManager } from '@tanstack/react-query';
import type { ApiClient } from '../src/lib/api-client';
import {
  DEVICE_INVALIDATION_MAX_FAILURES,
  DEVICE_INVALIDATION_PATH,
  DEVICE_INVALIDATION_TIMEOUT_MS,
  createDeviceInvalidation,
  type DeviceInvalidationDeps,
} from '../src/lib/device-invalidation';
import { registerDevice } from '../src/lib/devices';
import { signOut } from '../src/lib/sign-out';
import {
  fakeNotifications,
  pushNotification,
  resetFakeNotifications,
} from './support/fake-notifications';

jest.mock('expo-notifications', () =>
  jest
    .requireActual<typeof import('./support/fake-notifications')>('./support/fake-notifications')
    .fakeNotificationsModule(),
);
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
  };
});
jest.mock('expo-linking', () => ({ createURL: (path: string) => `planeahead://${path}` }));
jest.mock('expo-device', () => ({ isDevice: true, modelName: 'iPhone 17 Pro', osVersion: '27.0' }));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '1.0.0' } },
}));
jest.mock('../src/lib/config', () => ({
  runtimeConfig: () => ({ apiUrl: 'https://api.planeahead.test', apnsEnvironment: 'development' }),
}));
jest.mock('../src/lib/identity', () => ({ installId: () => 'install-0123456789' }));

/** Every step of the sign-out and every request, in order. */
const mockLog: string[] = [];
const mockSession = { cookies: null as string | null };
jest.mock('../src/lib/auth-client', () => ({
  snapshotAuthCookies: () => Promise.resolve(mockSession.cookies),
}));
jest.mock('../src/lib/services', () => ({
  forgetAccount: () => {
    mockLog.push('forgetAccount');
    return Promise.resolve();
  },
}));
jest.mock('../src/lib/push-registration', () => ({
  pushRegistrar: () => ({
    reset: () => {
      mockLog.push('registrar.reset');
    },
    idle: () => {
      mockLog.push('registrar.idle');
      return Promise.resolve();
    },
  }),
}));

const API = 'https://api.planeahead.test';
const INSTALL = 'install-0123456789';

/** A cookie map as the Expo client stores it. */
function cookieMap(token: string, expires = '2099-01-01T00:00:00.000Z'): string {
  return JSON.stringify({ 'better-auth.session_token': { value: token, expires } });
}

function memoryStorage() {
  const box = { value: null as string | null };
  return {
    box,
    storage: {
      read: () => Promise.resolve(box.value),
      write: (value: string) => {
        box.value = value;
        return Promise.resolve();
      },
    },
  };
}

type Answer = number | 'network' | 'hang';

/** The invalidation route, answering from a script; every call is logged with its cookie. */
function endpoint(answers: Answer[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = jest.fn((url: string, init: RequestInit) => {
    calls.push({ url, init });
    mockLog.push(`invalidate ${(init.headers as Record<string, string>)['Cookie'] ?? ''}`);
    const answer = answers.shift() ?? 200;
    if (answer === 'network') {
      return Promise.reject(new TypeError('Network request failed'));
    }
    if (answer === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new Error('Aborted'));
        });
      });
    }
    return Promise.resolve({ ok: answer < 300, status: answer } as Response);
  });
  return { fetch, calls };
}

/** One installation's invalidation over `storage` (a relaunch builds a new one over the same). */
function build(
  storage: DeviceInvalidationDeps['storage'],
  answers: Answer[] = [],
  network = { online: true },
) {
  const { fetch, calls } = endpoint(answers);
  const dropped: string[] = [];
  const invalidation = createDeviceInvalidation({
    baseUrl: () => API,
    fetch,
    storage,
    isOnline: () => network.online,
    cookieHeader: getCookie,
    onDropped: (reason) => {
      dropped.push(reason);
    },
    now: () => new Date('2026-10-01T12:00:00.000Z'),
  });
  return { invalidation, calls, dropped };
}

beforeEach(() => {
  mockLog.length = 0;
  resetFakeNotifications();
});

describe('the invalidation at sign-out', () => {
  it('is sent with the session being signed out of; nothing is queued', async () => {
    const { box, storage } = memoryStorage();
    const { invalidation, calls } = build(storage, [200]);
    await expect(invalidation.invalidate(INSTALL, cookieMap('tok-a.sig'))).resolves.toBe(
      'invalidated',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${API}${DEVICE_INVALIDATION_PATH}`);
    expect(calls[0]?.init).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      body: JSON.stringify({ installId: INSTALL }),
      headers: { Cookie: 'better-auth.session_token=tok-a.sig', 'X-Install-Id': INSTALL },
    });
    expect(box.value).toBeNull();
  });

  it('is queued, without a request, while the phone knows it is offline', async () => {
    const { box, storage } = memoryStorage();
    const { invalidation, calls } = build(storage, [], { online: false });
    await expect(invalidation.invalidate(INSTALL, cookieMap('tok-a.sig'))).resolves.toBe('queued');
    expect(calls).toHaveLength(0);
    expect(JSON.parse(box.value ?? 'null')).toEqual({
      installId: INSTALL,
      cookies: cookieMap('tok-a.sig'),
      queuedAt: '2026-10-01T12:00:00.000Z',
      failures: 0,
    });
  });

  it.each([
    ['a network failure', 'network' as const],
    ['a 503', 503],
    ['a 429', 429],
  ])('is queued after %s', async (_name, answer) => {
    const { box, storage } = memoryStorage();
    const { invalidation } = build(storage, [answer]);
    await expect(invalidation.invalidate(INSTALL, cookieMap('tok-a.sig'))).resolves.toBe('queued');
    expect(box.value).toContain('tok-a.sig');
  });

  it('is queued when the route has not answered within the timeout', async () => {
    jest.useFakeTimers();
    try {
      const { box, storage } = memoryStorage();
      const { invalidation } = build(storage, ['hang']);
      const outcome = invalidation.invalidate(INSTALL, cookieMap('tok-a.sig'));
      await jest.advanceTimersByTimeAsync(DEVICE_INVALIDATION_TIMEOUT_MS);
      await expect(outcome).resolves.toBe('queued');
      expect(box.value).toContain('tok-a.sig');
    } finally {
      jest.useRealTimers();
    }
  });

  it('is refused, not queued, on any other 4xx or with no session cookies left', async () => {
    const { box, storage } = memoryStorage();
    const { invalidation, calls } = build(storage, [401]);
    await expect(invalidation.invalidate(INSTALL, cookieMap('tok-a.sig'))).resolves.toBe('refused');
    await expect(invalidation.invalidate(INSTALL, null)).resolves.toBe('refused');
    const expired = cookieMap('tok-b.sig', '2020-01-01T00:00:00.000Z');
    await expect(invalidation.invalidate(INSTALL, expired)).resolves.toBe('refused');
    expect(calls).toHaveLength(1);
    expect(box.value).toBeNull();
  });

  it('keeps the first queued call when a second sign-out cannot be sent either', async () => {
    const { box, storage } = memoryStorage();
    const { invalidation } = build(storage, [], { online: false });
    await invalidation.invalidate(INSTALL, cookieMap('tok-a.sig'));
    await expect(invalidation.invalidate(INSTALL, cookieMap('tok-b.sig'))).resolves.toBe('queued');
    expect(box.value).toContain('tok-a.sig');
    expect(box.value).not.toContain('tok-b.sig');
  });
});

describe('the queued call', () => {
  /** A sign-out made offline: its call is in `storage`, as on disk after a relaunch. */
  async function queuedOffline() {
    const disk = memoryStorage();
    await build(disk.storage, [], { online: false }).invalidation.invalidate(
      INSTALL,
      cookieMap('tok-old.sig'),
    );
    mockLog.length = 0;
    return disk;
  }

  it("is sent on the next launch with the signed-out session's cookies, then forgotten", async () => {
    const { box, storage } = await queuedOffline();
    const relaunch = build(storage, [200]);
    await relaunch.invalidation.settle();
    expect(mockLog).toEqual(['invalidate better-auth.session_token=tok-old.sig']);
    expect(box.value).toBe('');
    await relaunch.invalidation.settle();
    expect(mockLog).toHaveLength(1);
  });

  it('stays queued, and settling throws, through a network failure', async () => {
    const { box, storage } = await queuedOffline();
    const relaunch = build(storage, ['network', 200]);
    await expect(relaunch.invalidation.settle()).rejects.toThrow('Network request failed');
    expect(box.value).toContain('tok-old.sig');
    await relaunch.invalidation.settle();
    expect(box.value).toBe('');
  });

  it(`is dropped, and reported, after ${String(DEVICE_INVALIDATION_MAX_FAILURES)} 5xx answers`, async () => {
    const { box, storage } = await queuedOffline();
    const relaunch = build(storage, [500, 502, 503, 200]);
    await expect(relaunch.invalidation.settle()).rejects.toThrow();
    await expect(relaunch.invalidation.settle()).rejects.toThrow();
    expect(JSON.parse(box.value ?? 'null')).toMatchObject({ failures: 2 });
    await relaunch.invalidation.settle();
    expect(box.value).toBe('');
    expect(relaunch.dropped).toEqual(['failures']);
    expect(mockLog).toHaveLength(DEVICE_INVALIDATION_MAX_FAILURES);
  });

  it('is settled by a 401 (the session is gone) and by cookies that have all expired', async () => {
    const answered = await queuedOffline();
    const relaunch = build(answered.storage, [401]);
    await relaunch.invalidation.settle();
    expect(answered.box.value).toBe('');
    expect(relaunch.dropped).toEqual(['refused']);

    // Queued while the session was valid; it has expired since.
    const expired = memoryStorage();
    expired.box.value = JSON.stringify({
      installId: INSTALL,
      cookies: cookieMap('tok-old.sig', '2020-01-01T00:00:00.000Z'),
      queuedAt: '2019-12-01T00:00:00.000Z',
      failures: 0,
    });
    mockLog.length = 0;
    const later = build(expired.storage, [200]);
    await later.invalidation.settle();
    expect(expired.box.value).toBe('');
    expect(later.dropped).toEqual(['refused']);
    expect(mockLog).toEqual([]);
  });

  it('is sent once for concurrent settles', async () => {
    const { storage } = await queuedOffline();
    const relaunch = build(storage, [200]);
    await Promise.all([relaunch.invalidation.settle(), relaunch.invalidation.settle()]);
    expect(mockLog).toHaveLength(1);
  });

  it('is dropped when unreadable', async () => {
    const { box, storage } = memoryStorage();
    box.value = '{"installId":';
    const relaunch = build(storage, [200]);
    await relaunch.invalidation.settle();
    expect(box.value).toBe('');
    expect(relaunch.dropped).toEqual(['unreadable']);
    expect(mockLog).toHaveLength(0);
  });
});

describe('signOut', () => {
  function recordingApi(): ApiClient {
    const post = () => {
      mockLog.push('register');
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    };
    return { v1: { devices: { $post: post } } } as unknown as ApiClient;
  }

  afterEach(() => {
    onlineManager.setOnline(true);
  });

  it('stops registration, invalidates with the session, clears the tray, forgets the account, then unregisters', async () => {
    mockSession.cookies = cookieMap('tok-a.sig');
    onlineManager.setOnline(true);
    globalThis.fetch = endpoint([200]).fetch as unknown as typeof fetch;
    fakeNotifications.calls = mockLog;
    fakeNotifications.presented = [pushNotification('gate_change:AAL-100', { v: '1' })];
    await signOut(null);
    expect(mockLog).toEqual([
      'registrar.reset',
      'registrar.idle',
      'invalidate better-auth.session_token=tok-a.sig',
      'dismissAll',
      'forgetAccount',
      'unregister',
    ]);
    expect(fakeNotifications.presented).toEqual([]);
  });

  it.each([
    ['fails', new Error('the presenter is gone')],
    ['never settles', 'pending' as const],
  ])('signs out at once when clearing the tray %s', async (_case, outcome) => {
    mockSession.cookies = cookieMap('tok-a.sig');
    onlineManager.setOnline(true);
    globalThis.fetch = endpoint([200]).fetch as unknown as typeof fetch;
    fakeNotifications.calls = mockLog;
    fakeNotifications.dismissAll = outcome;
    jest.mocked(Sentry.captureException).mockClear();
    await signOut(null);
    expect(mockLog.slice(-3)).toEqual(['dismissAll', 'forgetAccount', 'unregister']);
    expect(Sentry.captureException).toHaveBeenCalledTimes(outcome === 'pending' ? 0 : 1);
  });

  it('offline it signs out at once; the next launch sends the call before any registration', async () => {
    mockSession.cookies = cookieMap('tok-old.sig');
    onlineManager.setOnline(false);
    globalThis.fetch = endpoint([200]).fetch as unknown as typeof fetch;
    fakeNotifications.calls = mockLog;
    await signOut(null);
    expect(mockLog).toEqual([
      'registrar.reset',
      'registrar.idle',
      'dismissAll',
      'forgetAccount',
      'unregister',
    ]);

    // Online again, a new session registers: the signed-out session's call goes first, once.
    mockLog.length = 0;
    onlineManager.setOnline(true);
    mockSession.cookies = cookieMap('tok-new.sig');
    const api = recordingApi();
    await registerDevice(api, { kind: 'apns', token: 'a1b2c3d4', permission: 'granted' });
    await registerDevice(api);
    expect(mockLog).toEqual([
      'invalidate better-auth.session_token=tok-old.sig',
      'register',
      'register',
    ]);
  });
});
