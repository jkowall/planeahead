/**
 * Signing out (increment 16, ruling C3; plan section 5; R2 design 6): the user's own, and the one
 * a revoked Apple credential forces (src/lib/session.ts).
 *
 * 1. Registration stops until the session is cleared (review A3, src/lib/push-registration.ts):
 *    nothing starts, a run that has not posted yet posts nothing, and a debounced token or a
 *    queued run is dropped. A `POST /v1/devices` already sent is waited for, at most the
 *    invalidation's timeout; one that reaches the server after step 2 gets 401, since the
 *    invalidation also ends the session there (review A4, apps/api/src/routes/devices.ts).
 * 2. `POST /v1/devices/current/invalidate` with this installation's id and the session's cookies,
 *    before anything forgets them. Offline, past its 5-second timeout, or on a 408, 429 or 5xx,
 *    it is queued and retried: at launch, while signed out on every return to the foreground and
 *    every network return, and before anything registers (src/lib/device-invalidation.ts).
 *    Sign-out never waits on it beyond that.
 * 3. A tap waiting for a session goes, with the last response (review N2), and
 *    `unregisterForNotificationsAsync()` starts on both platforms: Android deletes the FCM token,
 *    and Apple names logout as a reason to unregister (R2 facts 61 and 62). On Android that is a
 *    network call, which fails offline with the token still live at FCM: it stays owed until it
 *    succeeds, retried like step 2 and, at the next session, before its first token read
 *    (`tokenDeletion`, review A1).
 * 4. `forgetAccount` beside it: the tray, the registrar and the local half, `authClient.signOut()`
 *    included (src/lib/services.ts). When step 2 was queued it clears the session on the phone
 *    alone, without `/sign-out`, so the session lives on for the queued call to end, with its
 *    tokens: a `/sign-out` that landed while the invalidation never did would leave the tokens
 *    live and the queued call refused (review A4).
 * 5. The deletion is waited for, a bounded time, then the tray is cleared once more, for a push
 *    that arrived meanwhile (review N7). The next session's registration reads a token again.
 *
 * What none of this recalls is a push the provider accepted before step 2 reached the server
 * (docs/increments/14-push-transport.md, ruling R1), which no device can test here.
 *
 * An account deletion and `401 account_deleted` end in `forgetAccount` alone, the tray and the
 * registrar included: the account is gone server-side, with its tokens, and no session is left to
 * invalidate with.
 */

import * as Sentry from '@sentry/react-native';
import { clearLastNotificationResponse, dismissAllNotificationsAsync } from 'expo-notifications';
import { snapshotAuthCookies } from './auth-client';
import type { Store } from './db/client';
import {
  DEVICE_INVALIDATION_TIMEOUT_MS,
  deviceInvalidation,
  tokenDeletion,
  type InvalidationOutcome,
} from './device-invalidation';
import { installId } from './identity';
import { usePendingTap } from './push-notifications';
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
  registrar.pause();
  try {
    await atMost(registrar.idle(), DEVICE_INVALIDATION_TIMEOUT_MS);
    let outcome: InvalidationOutcome | null = null;
    try {
      outcome = await deviceInvalidation().invalidate(installId(), await snapshotAuthCookies());
    } catch (error) {
      Sentry.captureException(error);
    }
    usePendingTap.setState({ tap: null });
    clearLastNotificationResponse();
    const deletion = tokenDeletion().start();
    await forgetAccount(store, { endSession: outcome !== 'queued' });
    // Android's token deletion is a network call: the sign-out waits for it a bounded time.
    await atMost(deletion, DEVICE_INVALIDATION_TIMEOUT_MS);
    dismissAllNotificationsAsync().catch((error: unknown) => {
      Sentry.captureException(error);
    });
  } finally {
    registrar.resume();
  }
}
