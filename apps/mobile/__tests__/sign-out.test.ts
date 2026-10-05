/**
 * Increment 16, ruling C3: sign-out invalidates this installation's tokens, with the session it
 * signs out of, before `authClient.signOut()`; offline the call is queued and retried on the next
 * launch before any registration, with the signed-out session's cookies and never the current
 * one's; then the device unregisters (src/lib/device-invalidation.ts, src/lib/sign-out.ts).
 *
 * The review fixes: registration is paused for the whole sign-out (A3); a queued call clears the
 * session on the phone without `/sign-out` (A4); the token deletion starts beside `forgetAccount`
 * and is owed until it succeeds (A1, N7); a tap waiting for a session goes (N2).
 * sign-out-lifecycle.test.tsx drives the retries while signed out and at the next session.
 */

import { getCookie } from '@better-auth/expo/client';
import * as Sentry from '@sentry/react-native';
import { onlineManager } from '@tanstack/react-query';
import type { ApiClient } from '../src/lib/api-client';
import { kv } from '../src/lib/db/kv';
import {
  DEVICE_INVALIDATION_MAX_FAILURES,
  DEVICE_INVALIDATION_PATH,
  DEVICE_INVALIDATION_TIMEOUT_MS,
  TOKEN_DELETION_KEY,
  TOKEN_DELETION_WAIT_MS,
  createDeviceInvalidation,
  createTokenDeletion,
  deviceInvalidation,
  type DeviceInvalidationDeps,
} from '../src/lib/device-invalidation';
import { registerDevice } from '../src/lib/devices';
import { usePendingTap } from '../src/lib/push-notifications';
import { signOut } from '../src/lib/sign-out';
import {
  fakeNotifications,
  pushNotification,
  resetFakeNotifications,
  tapOn,
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
  forgetAccount: (_store: unknown, options?: { endSession?: boolean }) => {
    mockLog.push(options?.endSession === false ? 'forgetAccount, no /sign-out' : 'forgetAccount');
    return Promise.resolve();
  },
}));
jest.mock('../src/lib/push-registration', () => ({
  pushRegistrar: () => ({
    pause: () => {
      mockLog.push('registrar.pause');
    },
    resume: () => {
      mockLog.push('registrar.resume');
    },
    idle: () => {
      mockLog.push('registrar.idle');
      return Promise.resolve();
    },
  }),
}));
jest.mock('../src/lib/db/kv', () =>
  jest.requireActual<typeof import('./support/memory-kv')>('./support/memory-kv').memoryKvModule(),
);

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
  kv.removeItemSync(TOKEN_DELETION_KEY);
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

  it('says whether it waits, without sending it (a network return with a session asks)', async () => {
    const { storage } = await queuedOffline();
    const relaunch = build(storage, [200]);
    await expect(relaunch.invalidation.queued()).resolves.toBe(true);
    expect(mockLog).toEqual([]);
    await relaunch.invalidation.settle();
    await expect(relaunch.invalidation.queued()).resolves.toBe(false);
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

  it('pauses registration, invalidates with the session, then deletes the token beside forgetAccount and clears the tray after', async () => {
    mockSession.cookies = cookieMap('tok-a.sig');
    onlineManager.setOnline(true);
    globalThis.fetch = endpoint([200]).fetch as unknown as typeof fetch;
    fakeNotifications.calls = mockLog;
    fakeNotifications.presented = [pushNotification('gate_change:AAL-100', { v: '1' })];
    await signOut(null);
    expect(mockLog).toEqual([
      'registrar.pause',
      'registrar.idle',
      'invalidate better-auth.session_token=tok-a.sig',
      'clearLastResponse',
      'unregister',
      'forgetAccount',
      'registrar.resume',
      'dismissAll',
    ]);
    expect(fakeNotifications.presented).toEqual([]);
    // The deletion succeeded: nothing is owed.
    expect(kv.getItemSync(TOKEN_DELETION_KEY)).toBeNull();
  });

  it('drops a tap waiting for a session, and the last response (review N2)', async () => {
    mockSession.cookies = cookieMap('tok-a.sig');
    globalThis.fetch = endpoint([200]).fetch as unknown as typeof fetch;
    const leaked = pushNotification('gate_change:AAL-100', { v: '1' });
    fakeNotifications.lastResponse = tapOn(leaked);
    usePendingTap.setState({ tap: { key: 'gate_change:AAL-100@1', flightId: 'flight-1' } });
    await signOut(null);
    expect(usePendingTap.getState().tap).toBeNull();
    expect(fakeNotifications.lastResponse).toBeNull();
  });

  it('a token deletion that fails (Android offline) stays owed, and is reported (review A1)', async () => {
    mockSession.cookies = cookieMap('tok-a.sig');
    globalThis.fetch = endpoint([200]).fetch as unknown as typeof fetch;
    const offline = new Error('SERVICE_NOT_AVAILABLE');
    fakeNotifications.unregister = offline;
    jest.mocked(Sentry.captureException).mockClear();
    await signOut(null);
    expect(kv.getItemSync(TOKEN_DELETION_KEY)).toBe('1');
    expect(Sentry.captureException).toHaveBeenCalledWith(offline);
  });

  it('queued online (a 503): forgets the session without /sign-out, for the queued call to end it (review A4)', async () => {
    mockSession.cookies = cookieMap('tok-a.sig');
    globalThis.fetch = endpoint([503, 200]).fetch as unknown as typeof fetch;
    await signOut(null);
    expect(mockLog).toEqual([
      'registrar.pause',
      'registrar.idle',
      'invalidate better-auth.session_token=tok-a.sig',
      'forgetAccount, no /sign-out',
      'registrar.resume',
    ]);
    // The session's end is the queued call, with its cookies.
    mockLog.length = 0;
    await deviceInvalidation().settle();
    expect(mockLog).toEqual(['invalidate better-auth.session_token=tok-a.sig']);
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
    expect(mockLog.slice(-3)).toEqual(['forgetAccount', 'registrar.resume', 'dismissAll']);
    expect(Sentry.captureException).toHaveBeenCalledTimes(outcome === 'pending' ? 0 : 1);
  });

  it('offline it signs out at once; the next launch sends the call before any registration', async () => {
    mockSession.cookies = cookieMap('tok-old.sig');
    onlineManager.setOnline(false);
    globalThis.fetch = endpoint([200]).fetch as unknown as typeof fetch;
    fakeNotifications.calls = mockLog;
    await signOut(null);
    expect(mockLog).toEqual([
      'registrar.pause',
      'registrar.idle',
      'clearLastResponse',
      'unregister',
      'forgetAccount, no /sign-out',
      'registrar.resume',
      'dismissAll',
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

describe('the token deletion (review A1)', () => {
  /** A deletion over a scripted unregister and an in-memory record. */
  function deletion(outcomes: ('ok' | 'fail' | 'hang')[]) {
    const record = { owed: false };
    const calls: boolean[] = [];
    const errors: unknown[] = [];
    let finish: () => void = () => undefined;
    const instance = createTokenDeletion({
      unregister: () => {
        // Whether the deletion was recorded as owed when it started.
        calls.push(record.owed);
        const outcome = outcomes.shift() ?? 'ok';
        if (outcome === 'hang') {
          return new Promise<void>((resolve) => {
            finish = resolve;
          });
        }
        return outcome === 'ok'
          ? Promise.resolve()
          : Promise.reject(new Error('SERVICE_NOT_AVAILABLE'));
      },
      owed: {
        read: () => record.owed,
        write: (owed) => {
          record.owed = owed;
        },
      },
      onError: (error) => {
        errors.push(error);
      },
    });
    return { instance, record, calls, errors, finish: () => finish() };
  }

  it('is owed from before it starts until it succeeds; one that never finishes stays owed', async () => {
    const done = deletion(['ok']);
    await done.instance.start();
    expect(done.calls).toEqual([true]);
    expect(done.record.owed).toBe(false);

    const unfinished = deletion(['hang']);
    void unfinished.instance.start();
    await Promise.resolve();
    expect(unfinished.record.owed).toBe(true);
    unfinished.finish();
  });

  it('a failure stays owed and is reported; a retry runs it again, and nothing once it is done', async () => {
    const { instance, record, calls, errors } = deletion(['fail', 'fail', 'ok']);
    await instance.start();
    expect(record.owed).toBe(true);
    await instance.retry();
    expect(record.owed).toBe(true);
    await instance.retry();
    expect(record.owed).toBe(false);
    await instance.retry();
    expect(calls).toHaveLength(3);
    expect(errors).toHaveLength(2);
  });

  it('runs one at a time: a retry or a start meanwhile joins it', async () => {
    const { instance, record, calls, finish } = deletion(['hang']);
    const joined = [instance.start(), instance.retry(), instance.start()];
    expect(calls).toHaveLength(1);
    finish();
    await Promise.all(joined);
    expect(record.owed).toBe(false);
  });

  it('before a read: nothing owed runs nothing; an owed one runs, and is forgotten even when it fails', async () => {
    const { instance, record, calls } = deletion(['fail', 'fail']);
    await instance.beforeRead();
    expect(calls).toHaveLength(0);
    await instance.start();
    await instance.beforeRead();
    expect(calls).toHaveLength(2);
    expect(record.owed).toBe(false);
    // From then on the token is the new session's: nothing deletes it.
    await instance.retry();
    await instance.beforeRead();
    expect(calls).toHaveLength(2);
  });

  it(`before a read: one still running is waited for, at most ${String(TOKEN_DELETION_WAIT_MS)} ms`, async () => {
    jest.useFakeTimers();
    try {
      const { instance, record, finish } = deletion(['hang']);
      void instance.start();
      let reading = false;
      void instance.beforeRead().then(() => {
        reading = true;
      });
      await jest.advanceTimersByTimeAsync(TOKEN_DELETION_WAIT_MS - 1);
      expect(reading).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(reading).toBe(true);
      expect(record.owed).toBe(false);
      finish();
    } finally {
      jest.useRealTimers();
    }
  });
});
