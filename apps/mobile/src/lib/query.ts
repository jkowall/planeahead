/**
 * TanStack Query wired to the platform: online state from `expo-network` (TanStack's React
 * Native recipe, no `@react-native-community/netinfo`), focus from `AppState`. No query
 * persistence: the offline store is the persisted state, the query cache is only request state.
 */

import { focusManager, onlineManager, QueryClient } from '@tanstack/react-query';
import { addNetworkStateListener } from 'expo-network';
import { AppState, type AppStateStatus } from 'react-native';

let wired = false;

export function wireQueryManagers(): void {
  if (wired) {
    return;
  }
  wired = true;
  onlineManager.setEventListener((setOnline) => {
    const subscription = addNetworkStateListener((state) => {
      setOnline(state.isConnected === true);
    });
    return () => {
      subscription.remove();
    };
  });
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
