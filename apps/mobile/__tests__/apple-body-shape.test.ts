/**
 * The native sign-in request bodies (increment 5's contract, ruling P7).
 *
 * Apple: `{ identityToken, authorizationCode, rawNonce, fullName? }` and NEVER an `idToken` key
 * (the Expo client strips the session cookie from any request whose body has one, and the
 * anonymous merge needs that cookie); the nonce Apple receives is `sha256hex(rawNonce)`; and
 * `getCredentialStateAsync`, which always throws on the Simulator, is not called there.
 *
 * Google: `configure({ webClientId, iosClientId, nonce })` with a FRESH raw nonce before every
 * sign-in (a configured nonce is sticky for the process), `{ identityToken, rawNonce }` on the
 * wire, and on Android the checkPlayServices, signIn, createAccount, presentExplicitSignIn ladder.
 */

import * as AppleAuthentication from 'expo-apple-authentication';
import { Platform } from 'react-native';
import { GoogleOneTapSignIn } from 'react-native-nitro-google-signin';
import { authClient } from '../src/lib/auth-client';
import { KV_KEYS, kv } from '../src/lib/db/kv';
import {
  APPLE_NATIVE_PATH,
  appleNativeBody,
  checkAppleCredential,
  signInWithApple,
} from '../src/lib/native-signin/apple';
import { GOOGLE_NATIVE_PATH, signInWithGoogle } from '../src/lib/native-signin/google';

const mockDevice = { isDevice: false };

jest.mock('expo-device', () => ({
  get isDevice() {
    return mockDevice.isDevice;
  },
}));

jest.mock('expo-crypto', () => {
  const { createHash } = jest.requireActual<{
    createHash: (algorithm: string) => {
      update(value: string): { digest(encoding: 'hex'): string };
    };
  }>('crypto');
  let counter = 0;
  return {
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    CryptoEncoding: { HEX: 'hex' },
    getRandomBytes: (count: number) => {
      counter += 1;
      return new Uint8Array(count).fill(counter);
    },
    digestStringAsync: (_algorithm: string, value: string) =>
      Promise.resolve(createHash('sha256').update(value).digest('hex')),
  };
});

jest.mock('expo-apple-authentication', () => ({
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
  AppleAuthenticationCredentialState: { REVOKED: 0, AUTHORIZED: 1, NOT_FOUND: 2, TRANSFERRED: 3 },
  signInAsync: jest.fn(),
  getCredentialStateAsync: jest.fn(),
}));

jest.mock('react-native-nitro-google-signin', () => {
  const noSaved = { type: 'noSavedCredentialFound', data: null };
  return {
    GoogleOneTapSignIn: {
      configure: jest.fn(),
      checkPlayServices: jest.fn(() => Promise.resolve()),
      signIn: jest.fn(() => Promise.resolve(noSaved)),
      createAccount: jest.fn(() => Promise.resolve(noSaved)),
      presentExplicitSignIn: jest.fn(),
    },
    isSuccessResponse: (response: { type: string; data: unknown }) =>
      response.type === 'success' && response.data !== null,
    isNoSavedCredentialFoundResponse: (response: { type: string }) =>
      response.type === 'noSavedCredentialFound',
  };
});

jest.mock('../src/lib/auth-client', () => ({
  authClient: { $fetch: jest.fn(() => Promise.resolve({ data: {}, error: null })) },
}));

jest.mock('../src/lib/config', () => ({
  runtimeConfig: () => ({
    variant: 'development',
    apiUrl: 'https://api.planeahead.test',
    universalLinkHosts: [],
    googleIosClientId: 'ios-client.apps.googleusercontent.com',
    googleWebClientId: 'web-client.apps.googleusercontent.com',
    sentryDsn: null,
  }),
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

jest.mock('expo-sqlite/kv-store', () => ({ Storage: {} }));

const signInAsync = jest.mocked(AppleAuthentication.signInAsync);
const getCredentialStateAsync = jest.mocked(AppleAuthentication.getCredentialStateAsync);
const $fetch = jest.mocked(authClient.$fetch);

function appleCredential(
  overrides: Partial<AppleAuthentication.AppleAuthenticationCredential> = {},
): AppleAuthentication.AppleAuthenticationCredential {
  return {
    user: '001234.apple-user.0001',
    state: null,
    fullName: {
      namePrefix: null,
      givenName: 'Ada',
      middleName: null,
      familyName: 'Lovelace',
      nameSuffix: null,
      nickname: null,
    },
    email: 'ada@example.com',
    realUserStatus: 1,
    identityToken: 'header.apple-identity.signature',
    authorizationCode: 'c0de',
    ...overrides,
  };
}

function sentBody(call = 0): Record<string, unknown> {
  const options = $fetch.mock.calls[call]?.[1] as { body?: Record<string, unknown> } | undefined;
  return options?.body ?? {};
}

function sha256(value: string): string {
  const { createHash } = jest.requireActual<{
    createHash: (algorithm: string) => { update(v: string): { digest(e: 'hex'): string } };
  }>('crypto');
  return createHash('sha256').update(value).digest('hex');
}

beforeEach(() => {
  mockDevice.isDevice = false;
  kv.removeItemSync(KV_KEYS.appleUserId);
});

describe('native Apple sign-in', () => {
  it('posts exactly identityToken, authorizationCode, rawNonce and fullName, never idToken', async () => {
    signInAsync.mockResolvedValueOnce(appleCredential());

    await expect(signInWithApple()).resolves.toEqual({ status: 'signed_in' });

    expect($fetch).toHaveBeenCalledTimes(1);
    expect($fetch.mock.calls[0]?.[0]).toBe(APPLE_NATIVE_PATH);
    expect($fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
    const body = sentBody();
    expect(Object.keys(body).sort()).toEqual(
      ['authorizationCode', 'fullName', 'identityToken', 'rawNonce'].sort(),
    );
    expect(body).not.toHaveProperty('idToken');
    expect(body['fullName']).toEqual({
      givenName: 'Ada',
      middleName: null,
      familyName: 'Lovelace',
    });
    expect(body['rawNonce']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives Apple sha256hex(rawNonce) and the API the raw nonce', async () => {
    signInAsync.mockResolvedValueOnce(appleCredential());
    await signInWithApple();
    const rawNonce = sentBody()['rawNonce'] as string;
    expect(signInAsync).toHaveBeenCalledWith({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
      nonce: sha256(rawNonce),
    });
  });

  it('omits fullName for a returning user (Apple sends the name only the first time)', () => {
    const body = appleNativeBody(appleCredential({ fullName: null, email: null }), 'n'.repeat(64));
    expect(Object.keys(body).sort()).toEqual(['authorizationCode', 'identityToken', 'rawNonce']);
  });

  it('never calls getCredentialStateAsync on the Simulator, at sign-in or at launch', async () => {
    signInAsync.mockResolvedValueOnce(appleCredential());
    await signInWithApple();
    expect(kv.getItemSync(KV_KEYS.appleUserId)).toBe('001234.apple-user.0001');
    await expect(checkAppleCredential()).resolves.toBe('skipped');
    expect(getCredentialStateAsync).not.toHaveBeenCalled();
  });

  it('checks the credential state on a real device and reports a revoked credential', async () => {
    mockDevice.isDevice = true;
    kv.setItemSync(KV_KEYS.appleUserId, '001234.apple-user.0001');
    getCredentialStateAsync.mockResolvedValueOnce(
      AppleAuthentication.AppleAuthenticationCredentialState.REVOKED,
    );
    await expect(checkAppleCredential()).resolves.toBe('revoked');
    expect(getCredentialStateAsync).toHaveBeenCalledWith('001234.apple-user.0001');
  });

  it('treats a cancelled sheet as a cancel, not an error, and posts nothing', async () => {
    signInAsync.mockRejectedValueOnce(
      Object.assign(new Error('cancel'), { code: 'ERR_REQUEST_CANCELED' }),
    );
    await expect(signInWithApple()).resolves.toEqual({ status: 'cancelled' });
    expect($fetch).not.toHaveBeenCalled();
  });
});

describe('native Google sign-in', () => {
  const success = (idToken: string) => ({
    type: 'success',
    data: {
      idToken,
      serverAuthCode: null,
      scopes: [],
      user: {
        id: 'g-1',
        email: 'ada@example.com',
        name: null,
        givenName: null,
        familyName: null,
        photo: null,
      },
    },
  });
  const configure = jest.mocked(GoogleOneTapSignIn.configure);
  const presentExplicitSignIn = jest.mocked(GoogleOneTapSignIn.presentExplicitSignIn);

  it('configures a fresh nonce before EVERY sign-in and posts { identityToken, rawNonce }', async () => {
    presentExplicitSignIn
      .mockResolvedValueOnce(success('google.token.1') as never)
      .mockResolvedValueOnce(success('google.token.2') as never);

    await signInWithGoogle();
    await signInWithGoogle();

    expect(configure).toHaveBeenCalledTimes(2);
    const nonces = configure.mock.calls.map(([params]) => params.nonce);
    expect(nonces[0]).not.toEqual(nonces[1]);
    expect(configure.mock.calls[0]?.[0]).toEqual({
      webClientId: 'web-client.apps.googleusercontent.com',
      iosClientId: 'ios-client.apps.googleusercontent.com',
      nonce: nonces[0],
    });
    expect($fetch.mock.calls[0]?.[0]).toBe(GOOGLE_NATIVE_PATH);
    // Google compares the RAW nonce: the configured value is what the API receives.
    expect(sentBody(0)).toEqual({ identityToken: 'google.token.1', rawNonce: nonces[0] });
    expect(sentBody(1)).toEqual({ identityToken: 'google.token.2', rawNonce: nonces[1] });
    for (const call of [0, 1]) {
      expect(sentBody(call)).not.toHaveProperty('idToken');
    }
  });

  it('walks the Android ladder in order on a fresh emulator', async () => {
    const original = Platform.OS;
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'android' });
    try {
      presentExplicitSignIn.mockResolvedValueOnce(success('google.token.3') as never);
      await expect(signInWithGoogle()).resolves.toEqual({ status: 'signed_in' });
      const order = [
        jest.mocked(GoogleOneTapSignIn.checkPlayServices),
        jest.mocked(GoogleOneTapSignIn.signIn),
        jest.mocked(GoogleOneTapSignIn.createAccount),
        presentExplicitSignIn,
      ].map((mock) => mock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(order.every(Number.isFinite)).toBe(true);
      expect(configure.mock.invocationCallOrder[0]).toBeLessThan(order[0] ?? 0);
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, get: () => original });
    }
  });

  it('reports a dismissed sheet as a cancel and posts nothing', async () => {
    presentExplicitSignIn.mockResolvedValueOnce({ type: 'cancelled', data: null } as never);
    await expect(signInWithGoogle()).resolves.toEqual({ status: 'cancelled' });
    expect($fetch).not.toHaveBeenCalled();
  });
});
