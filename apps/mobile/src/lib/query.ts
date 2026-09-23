/**
 * TanStack Query wired to the platform: online state from `expo-network` (TanStack's React
 * Native recipe, no `@react-native-community/netinfo`), focus from `AppState`. No query
 * persistence: the offline store is the persisted state, the query cache is only request state.
 *
 * The outbox reads the same online state before it stamps or sends a mutation (services.ts;
 * ruling Y1). expo-network's listener hears changes only, and on Android none arrives while the
 * phone starts offline, so the state is also read once when the listener is set: a KNOWN offline
 * answer is applied unless a change was heard first. An unknown one leaves TanStack's default
 * (online), so a missing answer can never hold the queue back.
 *
 * Offline means neither `isConnected` nor `isInternetReachable` is true. On Android expo-network
 * computes the two separately (the transport class and the VALIDATED capability), so a validated
 * network on a transport it does not classify reports `isConnected: false` with
 * `isInternetReachable: true`. session.ts drains on `isInternetReachable`, so the gate must not
 * count that phone as offline or its queued writes would never leave (increment 10 re-review 2).
 */

import { focusManager, onlineManager, QueryClient } from '@tanstack/react-query';
import { addNetworkStateListener, getNetworkStateAsync } from 'expo-network';
import { AppState, type AppStateStatus } from 'react-native';

let wired = false;

function connected(state: { isConnected?: boolean; isInternetReachable?: boolean }): boolean {
  return state.isConnected === true || state.isInternetReachable === true;
}

/** TanStack's online-state listener, fed by expo-network (see the header). */
export function watchNetwork(setOnline: (online: boolean) => void): () => void {
  let heard = false;
  const subscription = addNetworkStateListener((state) => {
    heard = true;
    setOnline(connected(state));
  });
  void getNetworkStateAsync().then(
    (state) => {
      if (!heard && state.isConnected === false && !connected(state)) {
        setOnline(false);
      }
    },
    () => undefined,
  );
  return () => {
    subscription.remove();
  };
}

export function wireQueryManagers(): void {
  if (wired) {
    return;
  }
  wired = true;
  onlineManager.setEventListener(watchNetwork);
  focusManager.setEventListener((setFocused) => {
    const subscription = AppState.addEventListener('change', (status: AppStateStatus) => {
      setFocused(status === 'active');
    });
    return () => {
      subscription.remove();
    };
  });
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 2, staleTime: 30_000 },
    mutations: { retry: 0 },
  },
});
