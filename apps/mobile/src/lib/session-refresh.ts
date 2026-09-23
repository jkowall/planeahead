/**
 * Keeps the 30-day sliding session alive.
 *
 * The API's `/v1` middleware reads the session with `disableRefresh` and never sends `Set-Cookie`
 * (increment 5 ruling G7): the only request that extends the session is
 * `GET /api/auth/get-session`, whose cookies the Better Auth Expo client stores. A user who only
 * ever triggered `/v1` calls would therefore be signed out 30 days after sign-in however often
 * they opened the app. So: `getSession()` on every launch, and on every transition to the
 * foreground, throttled to once per hour (the server extends at most once a day anyway).
 */

import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

export const SESSION_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

export type RefreshReason = 'launch' | 'foreground';

export interface SessionRefresher {
  /** Calls `getSession` unless a foreground refresh already ran within the interval. */
  refresh(reason: RefreshReason): Promise<boolean>;
}

export function createSessionRefresher(
  getSession: () => Promise<unknown>,
  now: () => number = Date.now,
  intervalMs: number = SESSION_REFRESH_INTERVAL_MS,
): SessionRefresher {
  let last: number | null = null;
  return {
    async refresh(reason) {
      const at = now();
      if (reason === 'foreground' && last !== null && at - last < intervalMs) {
        return false;
      }
      last = at;
      try {
        await getSession();
      } catch {
        // Offline: the Expo client serves the cached session; the next foreground tries again.
        last = null;
      }
      return true;
    },
  };
}

/** Launch refresh on mount, then a throttled refresh on every background-to-active change. */
export function useSessionRefresh(refresher: SessionRefresher): void {
  const previous = useRef<AppStateStatus>(AppState.currentState);
  useEffect(() => {
    void refresher.refresh('launch');
    const subscription = AppState.addEventListener('change', (next) => {
      const wasActive = previous.current === 'active';
      previous.current = next;
      if (next === 'active' && !wasActive) {
        void refresher.refresh('foreground');
      }
    });
    return () => {
      subscription.remove();
    };
  }, [refresher]);
}
