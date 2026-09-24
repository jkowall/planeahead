/**
 * `POST /v1/devices` records the APNs environment the build's signing registers with, not one
 * guessed from the variant: an ad hoc preview build is `production`, like a store build, and a
 * development-signed build is the sandbox (increment 9 review, expo-correctness-4).
 */

import type { ApiClient } from '../src/lib/api-client';
import { registerDevice, registrationResult } from '../src/lib/devices';

const mockConfig = { variant: 'preview', apnsEnvironment: 'production' };

jest.mock('../src/lib/config', () => ({ runtimeConfig: () => mockConfig }));
jest.mock('../src/lib/identity', () => ({ installId: () => 'install-test-0001' }));
jest.mock('expo-device', () => ({ isDevice: true, modelName: 'iPhone 17 Pro', osVersion: '27.0' }));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '0.1.0' } },
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
});
