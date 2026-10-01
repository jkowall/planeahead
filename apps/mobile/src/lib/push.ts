/**
 * Push on the device (increment 16): the notification permission (ruling C1), the raw device
 * token (C2) and the two Android channels (C4).
 *
 * Permission (C1; R2 design 2 and 17). Asked in context, once: the pre-prompt after the first
 * flight add (src/app/(app)/notifications.tsx), or Settings, never at launch. A request checks
 * first and asks for alert and sound only: no badge in Phase 1, no provisional. The state is one
 * of the API's four (`PushPermissionState`):
 *
 * - iOS reads `ios.status`, because expo reports only `.authorized` as granted: provisional (3)
 *   comes back `granted: false` (R2 fact 8). Here it is a quiet grant, registered as such and
 *   never prompted over. Only a not-determined state can still show the prompt (R2 fact 10).
 * - Android 13 and later report `denied` before the first request too (expo answers `denied`
 *   while the app's notifications are off, asked or not), so a state that is not granted is
 *   `undetermined` while `canAskAgain` holds and this installation has not asked, and `denied`
 *   after that: one ask, then the system settings.
 *
 * Token (C2). `getDevicePushTokenAsync` returns the raw APNs or FCM token, never an Expo push
 * token, and needs no permission on either platform (R2 facts 22 and 24). On Android the FCM token
 * comes from Firebase Messaging, which needs the app's `google-services.json` (spike 3, ADR 0001):
 * without it the read fails and this reports `unavailable`. A read also fires
 * `addPushTokenListener` (R2 fact 23); src/lib/push-registration.ts ignores that echo.
 *
 * Channels (C4). Created at every app start and before any permission request (the request
 * creates them again first), from `ANDROID_CHANNEL_IDS`, the ids every push job names. Importance
 * is frozen once a channel exists and a re-creation only renames it (R2 fact 48), so repeating it
 * is safe.
 */

import * as Sentry from '@sentry/react-native';
import { ANDROID_CHANNEL_IDS, type PushPermissionState } from '@planeahead/shared';
import {
  AndroidImportance,
  getDevicePushTokenAsync,
  getPermissionsAsync,
  IosAuthorizationStatus,
  requestPermissionsAsync,
  setNotificationChannelAsync,
  type DevicePushToken,
  type NotificationPermissionsStatus,
} from 'expo-notifications';
import { useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { KV_KEYS, kv } from './db/kv';

export type PushTokenKind = 'apns' | 'fcm';

export type PushTokenRead =
  | { readonly kind: 'token'; readonly tokenKind: PushTokenKind; readonly token: string }
  | { readonly kind: 'unavailable'; readonly reason: string };

export interface PushPermission {
  readonly state: PushPermissionState;
  /** True while a request can still show the system prompt. */
  readonly canAsk: boolean;
}

function iosPermission(status: IosAuthorizationStatus): PushPermission {
  switch (status) {
    case IosAuthorizationStatus.AUTHORIZED:
    case IosAuthorizationStatus.EPHEMERAL:
      return { state: 'granted', canAsk: false };
    case IosAuthorizationStatus.PROVISIONAL:
      return { state: 'provisional', canAsk: false };
    case IosAuthorizationStatus.NOT_DETERMINED:
      return { state: 'undetermined', canAsk: true };
    case IosAuthorizationStatus.DENIED:
    default:
      return { state: 'denied', canAsk: false };
  }
}

/** What expo answered, as this app's state; `asked` is this installation's own record. */
export function permissionOf(
  status: NotificationPermissionsStatus,
  asked: boolean,
): PushPermission {
  if (status.ios !== undefined) {
    return iosPermission(status.ios.status);
  }
  if (status.granted) {
    return { state: 'granted', canAsk: false };
  }
  return status.canAskAgain && !asked
    ? { state: 'undetermined', canAsk: true }
    : { state: 'denied', canAsk: false };
}

function askedBefore(): boolean {
  return kv.getItemSync(KV_KEYS.pushPermissionRequested) === '1';
}

/** The permission this app holds now, without asking. */
export async function readPushPermission(): Promise<PushPermission> {
  return permissionOf(await getPermissionsAsync(), askedBefore());
}

/**
 * C1's request: checks first and asks only while the system prompt can still show, for alert and
 * sound (no badge, no provisional). On Android the channels exist before it (C4).
 */
export async function requestPushPermission(): Promise<PushPermission> {
  await ensureAndroidChannels();
  const current = await readPushPermission();
  if (!current.canAsk) {
    return current;
  }
  kv.setItemSync(KV_KEYS.pushPermissionRequested, '1');
  const answer = await requestPermissionsAsync({
    ios: { allowAlert: true, allowSound: true, allowBadge: false, allowProvisional: false },
    android: {},
  });
  return permissionOf(answer, true);
}

/**
 * Whether a flight add that just succeeded shows the pre-prompt (C1): once per installation, and
 * only while the system prompt can still show. Taking the offer records it, so a later add never
 * shows it again; after "Not now", Settings is the way back.
 */
export async function takePushPromptOffer(): Promise<boolean> {
  if (kv.getItemSync(KV_KEYS.pushPromptOffered) === '1') {
    return false;
  }
  try {
    if (!(await readPushPermission()).canAsk) {
      return false;
    }
  } catch (error) {
    Sentry.captureException(error);
    return false;
  }
  kv.setItemSync(KV_KEYS.pushPromptOffered, '1');
  return true;
}

/**
 * The permission as Settings shows it: read on mount and on every return to the foreground (it
 * may have changed in the system settings meanwhile), null until read. The setter takes what a
 * request answered.
 */
export function usePushPermission(): readonly [
  PushPermission | null,
  (permission: PushPermission) => void,
] {
  const [permission, setPermission] = useState<PushPermission | null>(null);
  useEffect(() => {
    let live = true;
    const read = () => {
      readPushPermission().then(
        (next) => {
          if (live) {
            setPermission(next);
          }
        },
        (error: unknown) => {
          Sentry.captureException(error);
        },
      );
    };
    read();
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        read();
      }
    });
    return () => {
      live = false;
      subscription.remove();
    };
  }, []);
  return [permission, setPermission];
}

/** A token as expo hands it over (a read, or the token listener), in this app's kinds. */
export function tokenRead(token: DevicePushToken): PushTokenRead {
  if (token.type !== 'ios' && token.type !== 'android') {
    return { kind: 'unavailable', reason: `unexpected token type ${token.type}` };
  }
  return {
    kind: 'token',
    tokenKind: token.type === 'ios' ? 'apns' : 'fcm',
    token: String(token.data),
  };
}

/**
 * How long a token read may take. iOS answers only once APNs registration completes, and on some
 * Simulator builds never does (R2 fact 60), so a read that takes longer counts as no token.
 */
export const PUSH_TOKEN_TIMEOUT_MS = 10_000;

/** Reads the raw device token. Never asks for permission. */
export async function readDevicePushToken(): Promise<PushTokenRead> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const token = await Promise.race([
      getDevicePushTokenAsync(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`no token after ${String(PUSH_TOKEN_TIMEOUT_MS)} ms`));
        }, PUSH_TOKEN_TIMEOUT_MS);
      }),
    ]);
    return tokenRead(token);
  } catch (error) {
    return {
      kind: 'unavailable',
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The two channels (C4). The ids, names and importance are the owner's to confirm before the first
 * Android build (docs/open-decisions.md section 8): HIGH, so both sound and show heads-up by
 * default and the user can lower either; no description yet (one can be added at any time).
 */
export const ANDROID_CHANNELS: readonly { readonly id: string; readonly name: string }[] = [
  { id: ANDROID_CHANNEL_IDS.flightChanges, name: 'Flight changes' },
  { id: ANDROID_CHANNEL_IDS.flightDelays, name: 'Delays' },
];

/**
 * Creates the channels, on Android: at every app start (src/app/_layout.tsx), and again before a
 * permission request, so the order holds even if the start-up call failed. Never throws.
 */
export async function ensureAndroidChannels(): Promise<void> {
  if (Platform.OS !== 'android') {
    return;
  }
  try {
    for (const { id, name } of ANDROID_CHANNELS) {
      await setNotificationChannelAsync(id, { name, importance: AndroidImportance.HIGH });
    }
  } catch (error) {
    Sentry.captureException(error);
  }
}
