/**
 * Native Google sign-in (react-native-nitro-google-signin 2.3.0) against
 * `POST /api/auth/sign-in/google-native` with `{ identityToken, rawNonce }` (increment 5).
 *
 * `configure()` runs before EVERY sign-in with a fresh nonce. The library documents the nonce as
 * rotating, but its native code keeps a configured nonce for the life of the process; a second
 * sign-in would carry the first one's nonce, and the API's identity-token replay marker and nonce
 * check both refuse that.
 *
 * Android walks the Credential Manager ladder a fresh emulator needs: `checkPlayServices`, then
 * the silent `signIn` (authorised accounts), then `createAccount` (every account on the device),
 * then `presentExplicitSignIn` (the explicit Sign in with Google sheet). iOS goes straight to the
 * interactive sheet: its `signIn` is `restorePreviousSignIn`, which returns a cached token that
 * does not carry this attempt's nonce.
 */

import {
  GoogleOneTapSignIn,
  isNoSavedCredentialFoundResponse,
  isSuccessResponse,
  type OneTapResponse,
} from 'react-native-nitro-google-signin';
import { Platform } from 'react-native';
import { authClient } from '../auth-client';
import { runtimeConfig } from '../config';
import { NativeSignInError, authErrorCode, randomNonce, type NativeSignInResult } from './nonce';

export const GOOGLE_NATIVE_PATH = '/sign-in/google-native';

export async function androidLadder(): Promise<OneTapResponse> {
  await GoogleOneTapSignIn.checkPlayServices(true);
  const silent = await GoogleOneTapSignIn.signIn();
  if (!isNoSavedCredentialFoundResponse(silent)) {
    return silent;
  }
  const created = await GoogleOneTapSignIn.createAccount();
  if (!isNoSavedCredentialFoundResponse(created)) {
    return created;
  }
  return GoogleOneTapSignIn.presentExplicitSignIn();
}

export async function signInWithGoogle(): Promise<NativeSignInResult> {
  const { googleWebClientId, googleIosClientId } = runtimeConfig();
  if (googleWebClientId === null) {
    throw new NativeSignInError('google', 'not_configured');
  }
  const rawNonce = randomNonce();
  GoogleOneTapSignIn.configure({
    webClientId: googleWebClientId,
    iosClientId: googleIosClientId,
    nonce: rawNonce,
  });
  const response =
    Platform.OS === 'android'
      ? await androidLadder()
      : await GoogleOneTapSignIn.presentExplicitSignIn();
  if (!isSuccessResponse(response)) {
    return { status: 'cancelled' };
  }

  const { error } = await authClient.$fetch(GOOGLE_NATIVE_PATH, {
    method: 'POST',
    body: { identityToken: response.data.idToken, rawNonce },
  });
  if (error) {
    throw new NativeSignInError('google', authErrorCode(error), error.status);
  }
  return { status: 'signed_in' };
}
