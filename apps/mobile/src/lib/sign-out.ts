/**
 * Signing out (increment 16, ruling C3; plan section 5; R2 design 6): the user's own, and the one
 * a revoked Apple credential forces (src/lib/session.ts).
 *
 * 1. Registration stops: a debounced token or a queued run is dropped, and a registration in
 *    flight is waited for (at most the invalidation's timeout), so none lands after step 2.
 * 2. `POST /v1/devices/current/invalidate` with this installation's id and the session's cookies,
 *    before anything forgets them. Offline, past its 5-second timeout, or on a 408, 429 or 5xx,
 *    it is queued and retried on the next launch before anything registers
 *    (src/lib/device-invalidation.ts). Sign-out never waits on it beyond that.
 * 3. `forgetAccount`, the local half, `authClient.signOut()` included (src/lib/services.ts).
 * 4. `unregisterForNotificationsAsync()` on both platforms: Android deletes the FCM token, and
 *    Apple names logout as a reason to unregister (R2 facts 61 and 62). The next session's
 *    registration reads a token again.
 *
 * What none of this recalls is a push the provider accepted before step 2 reached the server
 * (docs/increments/14-push-transport.md, ruling R1), which no device can test here.
 *
 * An account deletion and `401 account_deleted` end in `forgetAccount` alone: the account is gone
 * server-side, with its tokens, and no session is left to invalidate with.
 */

import * as Sentry from '@sentry/react-native';
import { unregisterForNotificationsAsync } from 'expo-notifications';
import { snapshotAuthCookies } from './auth-client';
import type { Store } from './db/client';
import { DEVICE_INVALIDATION_TIMEOUT_MS, deviceInvalidation } from './device-invalidation';
import { installId } from './identity';
import { pushRegistrar } from './push-registration';
import { forgetAccount } from './services';

/** Resolves with `work` or after `ms`, whichever comes first; never rejects. */
async function atMost(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } catch (error) {
    Sentry.captureException(error);
  } finally {
    clearTimeout(timer);
  }
}

export async function signOut(store: Store | null): Promise<void> {
  const registrar = pushRegistrar();
  registrar.reset();
  await atMost(registrar.idle(), DEVICE_INVALIDATION_TIMEOUT_MS);
  try {
    await deviceInvalidation().invalidate(installId(), await snapshotAuthCookies());
  } catch (error) {
    Sentry.captureException(error);
  }
  await forgetAccount(store);
  // Android's token deletion is a network call: the sign-out waits for it a bounded time.
  await atMost(unregisterForNotificationsAsync(), DEVICE_INVALIDATION_TIMEOUT_MS);
}
