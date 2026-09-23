/**
 * Native Sign in with Apple against `POST /api/auth/sign-in/apple-native` (increment 5).
 *
 * The body is exactly `{ identityToken, authorizationCode, rawNonce, fullName? }`. `identityToken`,
 * never `idToken`: the Expo client strips the stored session cookie from any request whose body
 * has an `idToken` key, and the anonymous-to-account merge needs that cookie. Apple returns the
 * name (and the email) only on the FIRST authorization for this app; the API looks a returning
 * user up by the token's `sub`, so a missing `fullName` is normal, not an error.
 *
 * The credential-state check runs on launch on a real device only: `getCredentialStateAsync`
 * always throws on the iOS Simulator, so it is skipped there (docs/increments/09, acceptance).
 */

import {
  AppleAuthenticationCredentialState,
  AppleAuthenticationScope,
  getCredentialStateAsync,
  signInAsync,
  type AppleAuthenticationCredential,
} from 'expo-apple-authentication';
import { isDevice } from 'expo-device';
import { Platform } from 'react-native';
import { authClient } from '../auth-client';
import { KV_KEYS, kv } from '../db/kv';
import {
  NativeSignInError,
  authErrorCode,
  randomNonce,
  sha256Hex,
  type NativeSignInResult,
} from './nonce';

export const APPLE_NATIVE_PATH = '/sign-in/apple-native';

export interface AppleNativeBody {
  readonly identityToken: string;
  readonly authorizationCode: string;
  readonly rawNonce: string;
  readonly fullName?: {
    readonly givenName: string | null;
    readonly middleName: string | null;
    readonly familyName: string | null;
  };
}

/** The request body for a credential; pure, so the key set is testable. */
export function appleNativeBody(
  credential: AppleAuthenticationCredential,
  rawNonce: string,
): AppleNativeBody {
  if (credential.identityToken === null || credential.authorizationCode === null) {
    throw new NativeSignInError('apple', 'incomplete_credential');
  }
  const name = credential.fullName;
  const hasName =
    name !== null &&
    [name.givenName, name.middleName, name.familyName].some((part) => part !== null && part !== '');
  return {
    identityToken: credential.identityToken,
    authorizationCode: credential.authorizationCode,
    rawNonce,
    ...(hasName
      ? {
          fullName: {
            givenName: name.givenName,
            middleName: name.middleName,
            familyName: name.familyName,
          },
        }
      : {}),
  };
}

function isCancel(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ERR_REQUEST_CANCELED'
  );
}

export async function signInWithApple(): Promise<NativeSignInResult> {
  const rawNonce = randomNonce();
  let credential: AppleAuthenticationCredential;
  try {
    credential = await signInAsync({
      requestedScopes: [AppleAuthenticationScope.FULL_NAME, AppleAuthenticationScope.EMAIL],
      nonce: await sha256Hex(rawNonce),
    });
  } catch (error) {
    if (isCancel(error)) {
      return { status: 'cancelled' };
    }
    throw error;
  }

  const { error } = await authClient.$fetch(APPLE_NATIVE_PATH, {
    method: 'POST',
    body: appleNativeBody(credential, rawNonce),
  });
  if (error) {
    throw new NativeSignInError('apple', authErrorCode(error), error.status);
  }
  kv.setItemSync(KV_KEYS.appleUserId, credential.user);
  return { status: 'signed_in' };
}

export type AppleCredentialCheck = 'skipped' | 'authorized' | 'revoked';

/**
 * Whether the Apple credential behind this session still stands (the user can revoke it in
 * Settings). Skipped when the session did not come from Apple, off iOS, and on the Simulator.
 */
export async function checkAppleCredential(): Promise<AppleCredentialCheck> {
  const user = kv.getItemSync(KV_KEYS.appleUserId);
  if (user === null || Platform.OS !== 'ios' || !isDevice) {
    return 'skipped';
  }
  const state = await getCredentialStateAsync(user);
  return state === AppleAuthenticationCredentialState.REVOKED ||
    state === AppleAuthenticationCredentialState.NOT_FOUND
    ? 'revoked'
    : 'authorized';
}
