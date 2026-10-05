/**
 * Session bootstrap and the work that follows a session.
 *
 * First launch signs in anonymously (a lazy server-side anonymous user, Phase 0 plan section 20)
 * once, so the app opens straight onto the home screen. After that, a launch without a session
 * (signed out, account deleted, first launch offline) lands on the sign-in group, which offers
 * "continue without an account" again.
 *
 * With a session: register this installation (`POST /v1/devices`), pull the sync feed, drain the
 * outbox, and on iOS devices check that an Apple credential behind the session still stands. All
 * of it again when the user changes (an anonymous user signing in is a new user id: the store's
 * owner no longer matches, so the synced rows go and the snapshot is pulled), on every
 * foreground, and when the network returns.
 *
 * Increment 16 (ruling C2): the registration carries the device token and the notification
 * permission, on each session start and each return to the foreground, and again when the token
 * listener reports a rotation (src/lib/push-registration.ts). A revoked Apple credential signs
 * out the way the Sign out button does (src/lib/sign-out.ts, ruling C3). A network return
 * registers too while a sign-out's invalidation is queued, since a registration settles it first
 * (review A1).
 *
 * Without a session (`useSignedOutWork`, review A1): what a sign-out left undone is retried on
 * every return to the foreground and every network return, the foreground handler presents
 * nothing, and opening the app clears the tray.
 */

import * as Sentry from '@sentry/react-native';
import { addNetworkStateListener } from 'expo-network';
import { addPushTokenListener, dismissAllNotificationsAsync } from 'expo-notifications';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { create } from 'zustand';
import { authClient } from './auth-client';
import { runtimeConfig } from './config';
import { KV_KEYS, kv } from './db/kv';
import { deviceInvalidation, retrySignOutWork } from './device-invalidation';
import { checkAppleCredential } from './native-signin/apple';
import { setSignedOut } from './push-notifications';
import { pushRegistrar } from './push-registration';
import { services } from './services';
import { signOut } from './sign-out';

interface BootstrapState {
  /** True until the first-launch anonymous sign-in has been attempted. */
  readonly anonymousPending: boolean;
}

export const useBootstrap = create<BootstrapState>(() => ({
  anonymousPending: kv.getItemSync(KV_KEYS.firstLaunchDone) !== '1',
}));

/** Signs in anonymously exactly once per installation, on first launch. */
export function useFirstLaunchAnonymousSignIn(hasSession: boolean, sessionPending: boolean): void {
  useEffect(() => {
    if (sessionPending || !useBootstrap.getState().anonymousPending) {
      return;
    }
    kv.setItemSync(KV_KEYS.firstLaunchDone, '1');
    if (hasSession) {
      useBootstrap.setState({ anonymousPending: false });
      return;
    }
    authClient.signIn
      .anonymous()
      .catch(() => undefined)
      .finally(() => {
        useBootstrap.setState({ anonymousPending: false });
      });
  }, [hasSession, sessionPending]);
}

/**
 * First-party analytics for the process: one `app_open` per launch and per return to the
 * foreground, flushed when the app goes to the background. Independent of the session: the
 * analytics id is never joined to the account (src/lib/analytics.ts).
 */
export function useAppAnalytics(): void {
  useEffect(() => {
    const track = (name: string) => {
      void services().then(({ analytics }) => {
        analytics.track(name, { variant: runtimeConfig().variant });
      });
    };
    track('app_open');
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        track('app_foreground');
      } else if (next === 'background') {
        void services().then(({ analytics }) => analytics.flush());
      }
    });
    return () => {
      subscription.remove();
    };
  }, []);
}

/** One round of background work for the session user `userId`. */
export async function syncNow(userId: string): Promise<void> {
  const { sync, outbox } = await services();
  try {
    await outbox.drain();
    await sync.sync(userId);
    await outbox.drain();
  } catch (error) {
    Sentry.captureException(error);
  }
}

/**
 * Device registration (with the push token, ruling C2), the Apple credential check and background
 * sync, keyed by user id.
 */
export function useSessionWork(userId: string | null): void {
  useEffect(() => {
    if (userId === null) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        if ((await checkAppleCredential()) === 'revoked') {
          const { store } = await services();
          await signOut(store);
          return;
        }
      } catch (error) {
        Sentry.captureException(error);
      }
      if (cancelled) {
        return;
      }
      // Beside the pull, not before it: a token read can take seconds. Never rejects.
      void pushRegistrar().register();
      await syncNow(userId);
    })();

    const appState = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        void pushRegistrar().register();
        void syncNow(userId);
      }
    });
    const network = addNetworkStateListener((state) => {
      if (state.isInternetReachable === true) {
        void syncNow(userId);
        // Only then: every foreground registers already, and a bare settle would invalidate this
        // account's own token with nothing to register it again.
        deviceInvalidation()
          .queued()
          .then((queued) => (queued ? pushRegistrar().register() : undefined))
          .catch((error: unknown) => {
            Sentry.captureException(error);
          });
      }
    });
    const tokens = addPushTokenListener((token) => {
      pushRegistrar().onToken(token);
    });
    return () => {
      cancelled = true;
      appState.remove();
      network.remove();
      tokens.remove();
      pushRegistrar().reset();
    };
  }, [userId]);
}

function clearTray(): void {
  dismissAllNotificationsAsync().catch((error: unknown) => {
    Sentry.captureException(error);
  });
}

/**
 * The root layout, while the session is known to be null (review A1). A sign-out that could not
 * finish (src/lib/sign-out.ts) left a queued invalidation, an owed token deletion, or both, and
 * the old account's alerts keep arriving until they are done: both are tried again on every
 * return to the foreground and every network return (once each at a time, so repeats are cheap).
 * The foreground handler presents nothing meanwhile, and the tray is cleared whenever the app
 * opens signed out. Only while the app runs: JavaScript does not run in a killed, suspended or
 * frozen app, so a phone never opened again keeps receiving until it is.
 */
export function useSignedOutWork(signedOut: boolean): void {
  useEffect(() => {
    setSignedOut(signedOut);
    if (!signedOut) {
      return undefined;
    }
    // Opened signed out, or just signed out (which tried both already, and the launch does too).
    clearTray();
    const appState = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        clearTray();
        retrySignOutWork();
      }
    });
    const network = addNetworkStateListener((state) => {
      if (state.isInternetReachable === true) {
        retrySignOutWork();
      }
    });
    return () => {
      appState.remove();
      network.remove();
    };
  }, [signedOut]);
}
