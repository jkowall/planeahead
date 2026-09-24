/**
 * The Live Activity token listeners (increment 11, ruling V5, ADR 0008): the push-to-start
 * token is posted to `POST /v1/devices` under `apns_live_activity_push_to_start` through the
 * increment 9 devices module (install id, APNs environment from the signing, no outbox);
 * per-activity update tokens are logged without their value and discarded. A 200 that skipped
 * the token (`pushTokenSkipped`) is logged and reported as such, never as registered (review
 * ruling Z4).
 */

import { renderHook } from '@testing-library/react-native';
import { Platform } from 'react-native';
import type { ApiClient } from '../src/lib/api-client';
import {
  startLiveActivityTokenListeners,
  useLiveActivityTokens,
  type LiveActivityTokenSource,
} from '../src/lib/live-activity/tokens';

const mockConfig = { variant: 'production', apnsEnvironment: 'production' };
const mockWidgets = {
  pushToStartListeners: [] as ((event: { activityPushToStartToken: string }) => void)[],
  removed: 0,
};

jest.mock('../src/lib/config', () => ({ runtimeConfig: () => mockConfig }));
jest.mock('../src/lib/identity', () => ({ installId: () => 'install-test-0001' }));
jest.mock('expo-device', () => ({ isDevice: true, modelName: 'iPhone 17 Pro', osVersion: '27.0' }));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '0.1.0' } },
}));
jest.mock('../src/lib/services', () => ({ services: () => Promise.reject(new Error('unused')) }));
jest.mock('expo-widgets', () => ({
  createWidget: (name: string) => ({ name }),
  createLiveActivity: (name: string) => ({ name, getInstances: () => [] }),
  addPushToStartTokenListener: (
    listener: (event: { activityPushToStartToken: string }) => void,
  ) => {
    mockWidgets.pushToStartListeners.push(listener);
    return {
      remove: () => {
        mockWidgets.removed += 1;
      },
    };
  },
}));

const PUSH_TO_START_TOKEN = 'a1'.repeat(80);
const ACTIVITY_TOKEN = 'b2'.repeat(80);

function recordingApi(status = 200, response: Record<string, unknown> = {}) {
  const bodies: Record<string, unknown>[] = [];
  const api = {
    v1: {
      devices: {
        $post: ({ json }: { json: Record<string, unknown> }) => {
          bodies.push(json);
          return Promise.resolve({
            ok: status < 300,
            status,
            json: () => Promise.resolve(response),
          });
        },
      },
    },
  } as unknown as ApiClient;
  return { api, bodies };
}

type PushToStartListener = (event: { activityPushToStartToken: string }) => void;
type ActivityListener = (event: { activityId: string; pushToken: string }) => void;

function fakeSource() {
  const state = {
    pushToStart: [] as PushToStartListener[],
    activity: [] as ActivityListener[],
    removed: 0,
  };
  const subscription = {
    remove: () => {
      state.removed += 1;
    },
  };
  const source: LiveActivityTokenSource = {
    addPushToStartTokenListener: (listener) => {
      state.pushToStart.push(listener);
      return subscription;
    },
    flightActivities: () => [
      {
        addPushTokenListener: (listener) => {
          state.activity.push(listener);
          return subscription;
        },
      },
    ],
  };
  return { source, state };
}

function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('startLiveActivityTokenListeners', () => {
  it.each([
    ['production', 'production'],
    ['development', 'sandbox'],
  ])(
    'posts the push-to-start token with its kind, the install id and the %s APNs environment',
    async (apnsEnvironment, expected) => {
      mockConfig.apnsEnvironment = apnsEnvironment;
      const { api, bodies } = recordingApi();
      const { source, state } = fakeSource();
      const log = jest.fn();
      const warn = jest.fn();
      const onError = jest.fn();
      startLiveActivityTokenListeners({
        source,
        api: () => Promise.resolve(api),
        log,
        warn,
        onError,
      });

      state.pushToStart[0]?.({ activityPushToStartToken: PUSH_TO_START_TOKEN });
      await flush();

      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toMatchObject({
        installId: 'install-test-0001',
        platform: 'ios',
        pushTokenKind: 'apns_live_activity_push_to_start',
        pushToken: PUSH_TO_START_TOKEN,
        pushEnvironment: expected,
      });
      expect(onError).not.toHaveBeenCalled();
      expect(log.mock.calls.map(([event]) => event as string)).toEqual([
        'live_activity_push_to_start_token_received',
        'live_activity_push_to_start_token_registered',
      ]);
      expect(JSON.stringify(log.mock.calls)).not.toContain(PUSH_TO_START_TOKEN);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it('logs and reports a 200 that skipped the token, never as registered', async () => {
    const { api, bodies } = recordingApi(200, {
      device: { id: 'device-1', installId: 'install-test-0001', platform: 'ios' },
      pushToken: null,
      pushTokenSkipped: 'owned_by_another_user',
    });
    const { source, state } = fakeSource();
    const log = jest.fn();
    const warn = jest.fn();
    const onError = jest.fn();
    startLiveActivityTokenListeners({
      source,
      api: () => Promise.resolve(api),
      log,
      warn,
      onError,
    });

    state.pushToStart[0]?.({ activityPushToStartToken: PUSH_TO_START_TOKEN });
    await flush();

    expect(bodies).toHaveLength(1);
    const expected = { reason: 'owned_by_another_user', length: PUSH_TO_START_TOKEN.length };
    expect(log.mock.calls).toEqual([
      ['live_activity_push_to_start_token_received', { length: PUSH_TO_START_TOKEN.length }],
      ['live_activity_push_to_start_token_skipped', expected],
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('live_activity_push_to_start_token_skipped', expected);
    expect(onError).not.toHaveBeenCalled();
    expect(JSON.stringify([log.mock.calls, warn.mock.calls])).not.toContain(PUSH_TO_START_TOKEN);
  });

  it('posts each new push-to-start token the system hands out', async () => {
    const { api, bodies } = recordingApi();
    const { source, state } = fakeSource();
    startLiveActivityTokenListeners({
      source,
      api: () => Promise.resolve(api),
      log: jest.fn(),
      warn: jest.fn(),
      onError: jest.fn(),
    });

    state.pushToStart[0]?.({ activityPushToStartToken: PUSH_TO_START_TOKEN });
    state.pushToStart[0]?.({ activityPushToStartToken: 'c3'.repeat(80) });
    await flush();

    expect(bodies.map((body) => body['pushToken'])).toEqual([PUSH_TO_START_TOKEN, 'c3'.repeat(80)]);
  });

  it('logs a per-activity token update without its value and never posts it', async () => {
    const { api, bodies } = recordingApi();
    const { source, state } = fakeSource();
    const log = jest.fn();
    startLiveActivityTokenListeners({
      source,
      api: () => Promise.resolve(api),
      log,
      warn: jest.fn(),
      onError: jest.fn(),
    });

    state.activity[0]?.({ activityId: 'activity-1', pushToken: ACTIVITY_TOKEN });
    await flush();

    expect(bodies).toHaveLength(0);
    expect(log).toHaveBeenCalledWith('live_activity_update_token_discarded', {
      activityId: 'activity-1',
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(ACTIVITY_TOKEN);
  });

  it('reports a refused registration to onError instead of throwing', async () => {
    const { api } = recordingApi(401);
    const { source, state } = fakeSource();
    const onError = jest.fn();
    startLiveActivityTokenListeners({
      source,
      api: () => Promise.resolve(api),
      log: jest.fn(),
      warn: jest.fn(),
      onError,
    });

    state.pushToStart[0]?.({ activityPushToStartToken: PUSH_TO_START_TOKEN });
    await flush();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(onError.mock.calls)).not.toContain(PUSH_TO_START_TOKEN);
  });

  it('survives an OS without Live Activities and stops every listener on remove()', () => {
    const { source, state } = fakeSource();
    const onError = jest.fn();
    const listeners = startLiveActivityTokenListeners({
      source: {
        ...source,
        flightActivities: () => {
          throw new Error('Live Activities are not supported');
        },
      },
      api: () => Promise.resolve(recordingApi().api),
      log: jest.fn(),
      warn: jest.fn(),
      onError,
    });

    expect(onError).toHaveBeenCalledTimes(1);
    listeners.remove();
    listeners.remove();
    expect(state.removed).toBe(1);
  });
});

describe('useLiveActivityTokens', () => {
  beforeEach(() => {
    mockWidgets.pushToStartListeners.length = 0;
    mockWidgets.removed = 0;
  });

  it('listens on iOS for a signed-in user, again for the next user, and stops on unmount', async () => {
    const { rerender, unmount } = await renderHook(
      ({ userId }: { userId: string | null }) => {
        useLiveActivityTokens(userId);
      },
      { initialProps: { userId: null as string | null } },
    );
    expect(mockWidgets.pushToStartListeners).toHaveLength(0);

    await rerender({ userId: 'user-1' });
    expect(mockWidgets.pushToStartListeners).toHaveLength(1);
    await rerender({ userId: 'user-2' });
    expect(mockWidgets.pushToStartListeners).toHaveLength(2);
    expect(mockWidgets.removed).toBe(1);

    await unmount();
    expect(mockWidgets.removed).toBe(2);
  });

  it('does nothing on Android, which has no Live Activities', async () => {
    const original = Platform.OS;
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    try {
      await renderHook(() => {
        useLiveActivityTokens('user-1');
      });
      expect(mockWidgets.pushToStartListeners).toHaveLength(0);
    } finally {
      Object.defineProperty(Platform, 'OS', { value: original, configurable: true });
    }
  });
});
