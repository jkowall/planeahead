/**
 * `POST /v1/devices` records the APNs environment the build's signing registers with, not one
 * guessed from the variant: an ad hoc preview build is `production`, like a store build, and a
 * development-signed build is the sandbox (increment 9 review, expo-correctness-4).
 *
 * Increment 16: a token goes with the variant's app id (ruling C2) and a device token with its
 * permission state, and no registration is sent before a sign-out's queued invalidation has
 * settled (ruling C3).
 */

import type { ApiClient } from '../src/lib/api-client';
import { registerDevice, registrationResult } from '../src/lib/devices';

const mockConfig = { variant: 'preview', apnsEnvironment: 'production' };

jest.mock('../src/lib/config', () => ({ runtimeConfig: () => mockConfig }));
jest.mock('../src/lib/identity', () => ({ installId: () => 'install-test-0001' }));
jest.mock('expo-device', () => ({ isDevice: true, modelName: 'iPhone 17 Pro', osVersion: '27.0' }));
const mockExpoConfig: {
  version: string;
  ios?: { bundleIdentifier?: string };
  android?: { package?: string };
} = { version: '0.1.0' };
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    get expoConfig() {
      return mockExpoConfig;
    },
  },
}));

const mockGate = { settle: jest.fn(() => Promise.resolve()) };
jest.mock('../src/lib/device-invalidation', () => ({
  settleQueuedInvalidation: () => mockGate.settle(),
}));

function recordingApi(response: Record<string, unknown> = {}) {
  const bodies: Record<string, unknown>[] = [];
  const api = {
    v1: {
      devices: {
        $post: ({ json }: { json: Record<string, unknown> }) => {
          bodies.push(json);
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(response) });
        },
      },
    },
  } as unknown as ApiClient;
  return { api, bodies };
}

describe('registerDevice', () => {
  it.each([
    ['preview', 'production', 'production'],
    ['production', 'production', 'production'],
    ['development', 'development', 'sandbox'],
    // A local debug build of the production variant is development signed.
    ['production', 'development', 'sandbox'],
  ])(
    'a %s build signed for %s APNs registers its token as %s',
    async (variant, apnsEnvironment, expected) => {
      mockConfig.variant = variant;
      mockConfig.apnsEnvironment = apnsEnvironment;
      const { api, bodies } = recordingApi();
      await registerDevice(api, { kind: 'apns', token: 'a1b2c3' });
      expect(bodies[0]).toMatchObject({
        installId: 'install-test-0001',
        pushTokenKind: 'apns',
        pushToken: 'a1b2c3',
        pushEnvironment: expected,
      });
    },
  );

  it('sends no environment for an FCM token', async () => {
    const { api, bodies } = recordingApi();
    await registerDevice(api, { kind: 'fcm', token: 'fcm-token' });
    expect(bodies[0]).not.toHaveProperty('pushEnvironment');
  });

  it('returns what the API did with the token: stored, or skipped with its reason (ruling Z4)', async () => {
    const stored = recordingApi({ device: { id: 'd1' }, pushToken: { id: 't1', kind: 'apns' } });
    await expect(registerDevice(stored.api, { kind: 'apns', token: 'a1b2c3' })).resolves.toEqual({
      registered: true,
    });
    const skipped = recordingApi({
      device: { id: 'd1' },
      pushToken: null,
      pushTokenSkipped: 'owned_by_another_user',
    });
    await expect(registerDevice(skipped.api, { kind: 'apns', token: 'a1b2c3' })).resolves.toEqual({
      registered: false,
      reason: 'owned_by_another_user',
    });
    // No token sent, nothing skipped; an unreadable body is not a refusal.
    await expect(registerDevice(recordingApi().api)).resolves.toEqual({ registered: true });
    expect(registrationResult(null)).toEqual({ registered: true });
    expect(registrationResult({ pushTokenSkipped: '' })).toEqual({ registered: true });
  });

  it("sends the variant's app id with a token, and a device token's permission (ruling C2)", async () => {
    mockExpoConfig.ios = { bundleIdentifier: 'app.planeahead.mobile.preview' };
    const { api, bodies } = recordingApi();
    await registerDevice(api, { kind: 'apns', token: 'a1b2c3d4', permission: 'denied' });
    await registerDevice(api, { kind: 'apns_live_activity_push_to_start', token: 'b2c3d4e5' });
    await registerDevice(api);
    expect(bodies[0]).toMatchObject({
      appId: 'app.planeahead.mobile.preview',
      pushPermission: 'denied',
    });
    // Push-to-start: the app id (the topic's base), no notification permission.
    expect(bodies[1]).toMatchObject({ appId: 'app.planeahead.mobile.preview' });
    expect(bodies[1]).not.toHaveProperty('pushPermission');
    // No token: neither, as the API would ignore both.
    expect(bodies[2]).not.toHaveProperty('appId');
    expect(bodies[2]).not.toHaveProperty('pushPermission');
  });

  it('leaves out an app id it cannot read, which the API takes as the production app', async () => {
    mockExpoConfig.ios = { bundleIdentifier: 'not a bundle id' };
    const { api, bodies } = recordingApi();
    await registerDevice(api, { kind: 'apns', token: 'a1b2c3d4', permission: 'granted' });
    delete mockExpoConfig.ios;
    await registerDevice(api, { kind: 'apns', token: 'a1b2c3d4', permission: 'granted' });
    expect(bodies[0]).not.toHaveProperty('appId');
    expect(bodies[1]).not.toHaveProperty('appId');
  });

  it("waits for a sign-out's queued invalidation, and sends nothing while it stays queued (ruling C3)", async () => {
    const { api, bodies } = recordingApi();
    let settle: () => void = () => undefined;
    mockGate.settle.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    const registering = registerDevice(api, { kind: 'fcm', token: 'fcm-token' });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(bodies).toHaveLength(0);
    settle();
    await registering;
    expect(bodies).toHaveLength(1);

    mockGate.settle.mockImplementationOnce(() => Promise.reject(new Error('still queued')));
    await expect(registerDevice(api, { kind: 'fcm', token: 'fcm-token' })).rejects.toThrow(
      'still queued',
    );
    expect(bodies).toHaveLength(1);
  });
});
