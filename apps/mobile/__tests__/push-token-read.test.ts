/**
 * Increment 16 review, A2: one failed token read must not fail every later one. expo-notifications
 * 57.0.20's `getDevicePushTokenAsync` kept a rejected native read cached for the life of the JS
 * runtime (in the field, an Android FCM fetch that failed offline), and
 * patches/expo-notifications@57.0.20.patch clears it in a `finally`. These load the REAL wrapper
 * through the package's index, as the app imports it, with only its native module faked, so an
 * expo upgrade that brings the cache back fails here; the shared fake
 * (support/fake-notifications.ts) answers every call afresh and cannot see it.
 *
 * Covered: a read that rejected is asked again; concurrent reads share one native call, whether it
 * resolves or rejects, and the next read asks again; the app's `readDevicePushToken` (`unavailable`,
 * then the token); and C1 through the real registrar (the grant reaches the server with the token).
 */

import type { PushPermissionState } from '@planeahead/shared';
import type { PushRegistration } from '../src/lib/devices';

type Step = 'reject' | 'resolve' | 'hold';

interface Held {
  readonly resolve: (token: string) => void;
  readonly reject: (error: Error) => void;
}

/** The native module's reads: what each one does, in order, and those held open. */
const mockNative = { calls: 0, script: [] as Step[], held: [] as Held[] };

jest.mock('expo-notifications/build/PushTokenManager', () => ({
  __esModule: true,
  default: {
    // The package's index loads DevicePushTokenAutoRegistration.fx, which subscribes.
    addListener: () => ({ remove: () => undefined }),
    removeListeners: () => undefined,
    getDevicePushTokenAsync: () => {
      const step = mockNative.script[mockNative.calls] ?? 'resolve';
      mockNative.calls += 1;
      if (step === 'reject') {
        return Promise.reject(new Error('SERVICE_NOT_AVAILABLE'));
      }
      if (step === 'hold') {
        return new Promise<string>((resolve, reject) => {
          mockNative.held.push({ resolve, reject });
        });
      }
      return Promise.resolve(`token-${String(mockNative.calls)}`);
    },
  },
}));
jest.mock('../src/lib/db/kv', () =>
  jest.requireActual<typeof import('./support/memory-kv')>('./support/memory-kv').memoryKvModule(),
);
jest.mock('../src/lib/services', () => ({ services: jest.fn() }));
jest.mock('../src/lib/devices', () => ({ registerDevice: jest.fn() }));

/** A fresh wrapper (its cache is module state; `jest.resetModules` runs before each test). */
function freshWrapper() {
  return jest.requireActual<typeof import('expo-notifications')>('expo-notifications')
    .getDevicePushTokenAsync;
}

async function outcome(read: Promise<{ readonly data: unknown }>): Promise<string> {
  try {
    return `ok ${String((await read).data)}`;
  } catch (error) {
    return `rejected ${error instanceof Error ? error.message : String(error)}`;
  }
}

beforeEach(() => {
  mockNative.calls = 0;
  mockNative.script = [];
  mockNative.held = [];
  jest.resetModules();
});

describe('the patched wrapper (expo-notifications 57.0.20)', () => {
  it('asks the native side again after a read that rejected', async () => {
    mockNative.script = ['reject'];
    const read = freshWrapper();
    expect(await outcome(read())).toBe('rejected SERVICE_NOT_AVAILABLE');
    expect(await outcome(read())).toBe('ok token-2');
    expect(await outcome(read())).toBe('ok token-3');
    expect(mockNative.calls).toBe(3);
  });

  it.each([
    ['resolves', (held: Held) => held.resolve('token-held'), 'ok token-held'],
    ['rejects', (held: Held) => held.reject(new Error('TIMEOUT')), 'rejected TIMEOUT'],
  ] as const)(
    'concurrent reads share one native call when it %s, and the next read asks again',
    async (_name, settle, expected) => {
      mockNative.script = ['hold'];
      const read = freshWrapper();
      const both = Promise.all([outcome(read()), outcome(read())]);
      expect(mockNative.calls).toBe(1);
      const held = mockNative.held[0];
      if (held === undefined) {
        throw new Error('the native read was not held');
      }
      settle(held);
      await expect(both).resolves.toEqual([expected, expected]);
      expect(await outcome(read())).toBe('ok token-2');
      expect(mockNative.calls).toBe(2);
    },
  );
});

describe("the app's read (src/lib/push.ts readDevicePushToken)", () => {
  it('is unavailable after a read that rejected, then reads the token', async () => {
    mockNative.script = ['reject'];
    const { readDevicePushToken } =
      jest.requireActual<typeof import('../src/lib/push')>('../src/lib/push');
    await expect(readDevicePushToken()).resolves.toEqual({
      kind: 'unavailable',
      reason: 'SERVICE_NOT_AVAILABLE',
    });
    await expect(readDevicePushToken()).resolves.toEqual({
      kind: 'token',
      tokenKind: 'apns',
      token: 'token-2',
    });
    expect(mockNative.calls).toBe(2);
  });
});

describe('C1 through the real registrar (src/lib/push-registration.ts)', () => {
  it('a launch read that failed, then the grant: the next run registers the token as granted', async () => {
    mockNative.script = ['reject'];
    const { createPushRegistrar } = jest.requireActual<
      typeof import('../src/lib/push-registration')
    >('../src/lib/push-registration');
    const { readDevicePushToken } =
      jest.requireActual<typeof import('../src/lib/push')>('../src/lib/push');
    let state: PushPermissionState = 'undetermined';
    const posts: (PushRegistration | 'no token')[] = [];
    const onError = jest.fn();
    const registrar = createPushRegistrar({
      readPermission: () => Promise.resolve({ state, canAsk: state === 'undetermined' }),
      readToken: readDevicePushToken,
      register: (push) => {
        posts.push(push ?? 'no token');
        return Promise.resolve({ registered: true });
      },
      onError,
    });
    // The launch: the read fails, and the device registers without a token.
    await registrar.register();
    // The pre-prompt's "Turn on notifications" answers, and registers at once.
    state = 'granted';
    await registrar.register();
    expect(posts).toEqual(['no token', { kind: 'apns', token: 'token-2', permission: 'granted' }]);
    expect(mockNative.calls).toBe(2);
    expect(onError).not.toHaveBeenCalled();
  });
});
