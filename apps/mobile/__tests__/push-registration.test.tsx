/**
 * Increment 16, ruling C2: registration on each session start and each return to the foreground,
 * with the token and the permission state (denied and undetermined included, since the API keeps
 * a state only on a token), and again on a token rotation: debounced, the read's echo ignored, one
 * run at a time (src/lib/push-registration.ts, its wiring in src/lib/session.ts).
 */

import { act, renderHook } from '@testing-library/react-native';
import type { PushPermissionState } from '@planeahead/shared';
import { AppState, type AppStateStatus } from 'react-native';
import type { PushRegistration } from '../src/lib/devices';
import type { PushPermission, PushTokenRead } from '../src/lib/push';
import {
  TOKEN_DEBOUNCE_MS,
  createPushRegistrar,
  type PushRegistrar,
} from '../src/lib/push-registration';
import { useSessionWork } from '../src/lib/session';
import { fakeNotifications, resetFakeNotifications } from './support/fake-notifications';

jest.mock('expo-notifications', () =>
  jest
    .requireActual<typeof import('./support/fake-notifications')>('./support/fake-notifications')
    .fakeNotificationsModule(),
);
jest.mock('../src/lib/db/kv', () =>
  jest.requireActual<typeof import('./support/memory-kv')>('./support/memory-kv').memoryKvModule(),
);
jest.mock('expo-network', () => ({
  addNetworkStateListener: jest.fn(() => ({ remove: jest.fn() })),
}));
jest.mock('../src/lib/auth-client', () => ({ authClient: {} }));
jest.mock('../src/lib/sign-out', () => ({ signOut: jest.fn(() => Promise.resolve()) }));
jest.mock('../src/lib/native-signin/apple', () => ({
  checkAppleCredential: jest.fn(() => Promise.resolve('skipped')),
}));

const mockRegistrar = {
  register: jest.fn(() => Promise.resolve()),
  onToken: jest.fn(),
  reset: jest.fn(),
  idle: jest.fn(() => Promise.resolve()),
};
jest.mock('../src/lib/push-registration', () => ({
  ...jest.requireActual<typeof import('../src/lib/push-registration')>(
    '../src/lib/push-registration',
  ),
  pushRegistrar: () => mockRegistrar,
}));

const mockSync = jest.fn(() => Promise.resolve());
jest.mock('../src/lib/services', () => ({
  services: () =>
    Promise.resolve({
      store: { sqlite: null },
      sync: { sync: mockSync },
      outbox: { drain: () => Promise.resolve({ sent: 0 }) },
    }),
}));

const TOKEN_A = 'a1'.repeat(32);
const TOKEN_B = 'b2'.repeat(32);
const TOKEN_C = 'c3'.repeat(32);

function apns(token: string): PushTokenRead {
  return { kind: 'token', tokenKind: 'apns', token };
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  });
}

/** A registrar over scripted reads, recording what it registers. */
function harness(options: { state?: PushPermissionState; token?: PushTokenRead } = {}) {
  const registered: (PushRegistration | undefined)[] = [];
  const permission: PushPermission = { state: options.state ?? 'granted', canAsk: false };
  const deps = {
    readPermission: jest.fn(() => Promise.resolve(permission)),
    readToken: jest.fn(() => Promise.resolve(options.token ?? apns(TOKEN_A))),
    register: jest.fn((push?: PushRegistration) => {
      registered.push(push);
      return Promise.resolve({ registered: true as const });
    }),
    onError: jest.fn(),
    onNote: jest.fn(),
  };
  const registrar: PushRegistrar = createPushRegistrar(deps);
  return { registrar, deps, registered };
}

describe('createPushRegistrar', () => {
  it('registers the device token with the permission the app holds', async () => {
    const { registrar, registered } = harness();
    await registrar.register();
    expect(registered).toEqual([{ kind: 'apns', token: TOKEN_A, permission: 'granted' }]);
  });

  it.each(['provisional', 'denied', 'undetermined'] as const)(
    'registers the token with %s too: the API keeps a state only on a token',
    async (state) => {
      const { registrar, registered } = harness({ state });
      await registrar.register();
      expect(registered).toEqual([{ kind: 'apns', token: TOKEN_A, permission: state }]);
    },
  );

  it('registers the device without a token when there is none, and notes why', async () => {
    const { registrar, registered, deps } = harness({
      token: { kind: 'unavailable', reason: 'no google-services.json' },
    });
    await registrar.register();
    expect(registered).toEqual([undefined]);
    expect(deps.onNote).toHaveBeenCalledWith('push_token_unavailable', 'no google-services.json');
  });

  it('registers without a token when the permission cannot be read', async () => {
    const { registrar, registered, deps } = harness();
    const failure = new Error('module unavailable');
    deps.readPermission.mockImplementationOnce(() => Promise.reject(failure));
    await registrar.register();
    expect(registered).toEqual([undefined]);
    expect(deps.onError).toHaveBeenCalledWith(failure);
  });

  it('notes a registration the API kept without its token', async () => {
    const { registrar, deps } = harness();
    deps.register.mockImplementationOnce(() =>
      Promise.resolve({ registered: false, reason: 'owned_by_another_user' } as never),
    );
    await registrar.register();
    expect(deps.onNote).toHaveBeenCalledWith('push_token_skipped', 'owned_by_another_user');
  });

  it('runs one registration at a time: triggers during one make one more run, not one each', async () => {
    const { registrar, deps } = harness();
    let release: () => void = () => undefined;
    deps.readToken.mockImplementationOnce(
      () =>
        new Promise<PushTokenRead>((resolve) => {
          release = () => {
            resolve(apns(TOKEN_A));
          };
        }),
    );
    const first = registrar.register();
    await flush();
    const second = registrar.register();
    const third = registrar.register();
    expect(deps.readToken).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second, third]);
    expect(deps.readToken).toHaveBeenCalledTimes(2);
    expect(deps.register).toHaveBeenCalledTimes(2);
    // Done: the next trigger starts a run of its own.
    await registrar.register();
    expect(deps.register).toHaveBeenCalledTimes(3);
  });
});

describe('the token listener (rotation)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("ignores the echo of the registrar's own read, even one that arrives first", async () => {
    const { registrar, deps } = harness();
    // expo emits the token a read returns, here before the read resolves (R2 fact 23).
    deps.readToken.mockImplementationOnce(() => {
      registrar.onToken({ type: 'ios', data: TOKEN_A });
      return Promise.resolve(apns(TOKEN_A));
    });
    await registrar.register();
    registrar.onToken({ type: 'ios', data: TOKEN_A });
    await jest.advanceTimersByTimeAsync(TOKEN_DEBOUNCE_MS * 2);
    expect(deps.register).toHaveBeenCalledTimes(1);
    expect(deps.readToken).toHaveBeenCalledTimes(1);
  });

  it('registers a rotation once, debounced, as the listener carried it (no read)', async () => {
    const { registrar, deps, registered } = harness();
    await registrar.register();
    registrar.onToken({ type: 'ios', data: TOKEN_B });
    await jest.advanceTimersByTimeAsync(TOKEN_DEBOUNCE_MS / 2);
    registrar.onToken({ type: 'ios', data: TOKEN_C });
    await jest.advanceTimersByTimeAsync(TOKEN_DEBOUNCE_MS - 1);
    expect(deps.register).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(registered).toEqual([
      { kind: 'apns', token: TOKEN_A, permission: 'granted' },
      { kind: 'apns', token: TOKEN_C, permission: 'granted' },
    ]);
    expect(deps.readToken).toHaveBeenCalledTimes(1);
  });

  it('a late echo of the registered token does not cancel a rotation waiting to register', async () => {
    const { registrar, registered } = harness();
    await registrar.register();
    registrar.onToken({ type: 'ios', data: TOKEN_B });
    registrar.onToken({ type: 'ios', data: TOKEN_A });
    await jest.advanceTimersByTimeAsync(TOKEN_DEBOUNCE_MS);
    expect(registered.map((push) => push?.token)).toEqual([TOKEN_A, TOKEN_B]);
  });

  it('reset drops a debounced token, a queued run and what the run in flight read; idle waits for it', async () => {
    const { registrar, deps } = harness();
    registrar.onToken({ type: 'android', data: 'fcm-rotated-token' });
    registrar.reset();
    await jest.advanceTimersByTimeAsync(TOKEN_DEBOUNCE_MS * 2);
    expect(deps.register).not.toHaveBeenCalled();

    let release: () => void = () => undefined;
    deps.readToken.mockImplementationOnce(
      () =>
        new Promise<PushTokenRead>((resolve) => {
          release = () => {
            resolve(apns(TOKEN_A));
          };
        }),
    );
    void registrar.register();
    await jest.advanceTimersByTimeAsync(0);
    void registrar.register();
    registrar.reset();
    let idle = false;
    void registrar.idle().then(() => {
      idle = true;
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(idle).toBe(false);
    release();
    await jest.advanceTimersByTimeAsync(0);
    expect(idle).toBe(true);
    // Its read began before the reset, so it posts nothing (review A3).
    expect(deps.register).not.toHaveBeenCalled();
    // The next run registers.
    await registrar.register();
    expect(deps.register).toHaveBeenCalledTimes(1);
  });
});

describe('sign-out and the registrar (review A1, A3)', () => {
  /** A registrar whose steps log in order; its `beforeRead` (an owed deletion) waits for `finish`. */
  function ordered() {
    const log: string[] = [];
    let finish: () => void = () => undefined;
    const registrar = createPushRegistrar({
      beforeRead: () => {
        log.push('beforeRead');
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
      readPermission: () => {
        log.push('readPermission');
        return Promise.resolve({ state: 'granted', canAsk: false });
      },
      readToken: () => {
        log.push('readToken');
        return Promise.resolve(apns(TOKEN_A));
      },
      register: (push) => {
        log.push(`register ${push?.token ?? 'none'}`);
        return Promise.resolve({ registered: true as const });
      },
      onError: jest.fn(),
    });
    return { registrar, log, finish: () => finish() };
  }

  it('a run settles an owed token deletion before it reads anything', async () => {
    const { registrar, log, finish } = ordered();
    const run = registrar.register();
    await flush();
    expect(log).toEqual(['beforeRead']);
    finish();
    await run;
    expect(log).toEqual(['beforeRead', 'readPermission', 'readToken', `register ${TOKEN_A}`]);
  });

  it('pause refuses every registration and the listener, until as many resumes', async () => {
    const { registrar, log, finish } = ordered();
    const run = registrar.register();
    await flush();
    // Sign-out begins while the run waits: it reads, and posts nothing.
    registrar.pause();
    registrar.pause();
    await registrar.register();
    finish();
    await run;
    expect(log).toEqual(['beforeRead', 'readPermission', 'readToken']);

    jest.useFakeTimers();
    try {
      registrar.onToken({ type: 'ios', data: TOKEN_B });
      await jest.advanceTimersByTimeAsync(TOKEN_DEBOUNCE_MS * 2);
      registrar.resume();
      await registrar.register();
      expect(log).toHaveLength(3);
      registrar.resume();
      const next = registrar.register();
      await jest.advanceTimersByTimeAsync(0);
      finish();
      await next;
    } finally {
      jest.useRealTimers();
    }
    expect(log.slice(3)).toEqual([
      'beforeRead',
      'readPermission',
      'readToken',
      `register ${TOKEN_A}`,
    ]);
  });
});

describe('useSessionWork: when registration runs', () => {
  type Listener = (status: AppStateStatus) => void;

  function captureAppState() {
    const listeners: Listener[] = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      listeners.push(listener);
      return { remove: jest.fn() };
    });
    return {
      emit(status: AppStateStatus) {
        for (const listener of listeners) {
          listener(status);
        }
      },
    };
  }

  beforeEach(() => {
    resetFakeNotifications();
  });

  it('on session start and every return to the foreground, and on a token rotation', async () => {
    const appState = captureAppState();
    const hook = await renderHook(() => {
      useSessionWork('user-1');
    });
    await flush();
    expect(mockRegistrar.register).toHaveBeenCalledTimes(1);
    expect(mockSync).toHaveBeenCalledWith('user-1');

    appState.emit('background');
    appState.emit('active');
    await flush();
    expect(mockRegistrar.register).toHaveBeenCalledTimes(2);

    const rotated = { type: 'ios' as const, data: TOKEN_B };
    for (const listener of fakeNotifications.tokenListeners) {
      listener(rotated);
    }
    expect(mockRegistrar.onToken).toHaveBeenCalledWith(rotated);

    await hook.unmount();
    expect(fakeNotifications.tokenListeners).toHaveLength(0);
    expect(mockRegistrar.reset).toHaveBeenCalled();
  });

  it('not without a session', async () => {
    captureAppState();
    await renderHook(() => {
      useSessionWork(null);
    });
    await flush();
    expect(mockRegistrar.register).not.toHaveBeenCalled();
    expect(fakeNotifications.tokenListeners).toHaveLength(0);
  });

  it('not after a revoked Apple credential, which signs out the way the button does', async () => {
    const { checkAppleCredential } = jest.requireMock<
      typeof import('../src/lib/native-signin/apple')
    >('../src/lib/native-signin/apple');
    const { signOut } =
      jest.requireMock<typeof import('../src/lib/sign-out')>('../src/lib/sign-out');
    jest.mocked(checkAppleCredential).mockResolvedValueOnce('revoked');
    captureAppState();
    await renderHook(() => {
      useSessionWork('user-1');
    });
    await flush();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(mockRegistrar.register).not.toHaveBeenCalled();
  });
});
