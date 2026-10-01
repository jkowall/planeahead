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
 * out the way the Sign out button does (src/lib/sign-out.ts, ruling C3).
 */

import * as Sentry from '@sentry/react-native';
import { addNetworkStateListener } from 'expo-network';
import { addPushTokenListener } from 'expo-notifications';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { create } from 'zustand';
import { authClient } from './auth-client';
import { runtimeConfig } from './config';
import { KV_KEYS, kv } from './db/kv';
import { checkAppleCredential } from './native-signin/apple';
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
