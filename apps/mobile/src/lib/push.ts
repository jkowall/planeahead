/**
 * Push, as far as Phase 0 goes: ask for permission and read the raw device token. No push
 * service is wired (Phase 1 builds the Workers `PushSender`); the token is only registered with
 * `POST /v1/devices` so it exists server-side when that lands.
 *
 * `getDevicePushTokenAsync` returns the raw APNs or FCM token, never an Expo push token. On Android
 * the FCM token comes from Firebase Messaging, which needs the app's `google-services.json`
 * (spike 3, ADR 0001): without it the read fails and this reports `unavailable`.
 */

import { getDevicePushTokenAsync, requestPermissionsAsync } from 'expo-notifications';

export type PushTokenKind = 'apns' | 'fcm';

export type PushTokenRead =
  | { readonly kind: 'token'; readonly tokenKind: PushTokenKind; readonly token: string }
  | { readonly kind: 'denied' }
  | { readonly kind: 'unavailable'; readonly reason: string };

export async function readDevicePushToken(): Promise<PushTokenRead> {
  const permission = await requestPermissionsAsync();
  if (!permission.granted) {
    return { kind: 'denied' };
  }
  try {
    const token = await getDevicePushTokenAsync();
    if (token.type !== 'ios' && token.type !== 'android') {
      return { kind: 'unavailable', reason: `unexpected token type ${token.type}` };
    }
    return {
      kind: 'token',
      tokenKind: token.type === 'ios' ? 'apns' : 'fcm',
      token: String(token.data),
    };
  } catch (error) {
    return {
      kind: 'unavailable',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
