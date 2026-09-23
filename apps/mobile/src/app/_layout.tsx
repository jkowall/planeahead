/**
 * The root layout: Sentry (initialised at module scope, before anything can throw), the offline
 * store (SQLiteProvider renders nothing until `onInitDatabase` has set WAL and run the bundled
 * migrations, so no screen ever sees an unmigrated database), TanStack Query, the session refresh
 * on launch and foreground, and the first-launch anonymous sign-in.
 *
 * The session gate itself is in the group layouts: `(app)` redirects to `(auth)` without a
 * session, `(auth)` redirects to `(app)` once the session is a real account. `auth/magic-link`
 * sits outside both, because the universal link can arrive in either state.
 */

import * as Sentry from '@sentry/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { SQLiteProvider } from 'expo-sqlite';
import { useEffect } from 'react';
import { Appearance } from 'react-native';
import { authClient } from '../lib/auth-client';
import { runtimeConfig } from '../lib/config';
import { DATABASE_NAME, DATABASE_OPTIONS, onInitDatabase } from '../lib/db/client';
import { queryClient, wireQueryManagers } from '../lib/query';
import { initSentry } from '../lib/sentry';
import { useAppAnalytics, useFirstLaunchAnonymousSignIn } from '../lib/session';
import { createSessionRefresher, useSessionRefresh } from '../lib/session-refresh';
import { useSettings } from '../lib/settings';

initSentry({ dsn: runtimeConfig().sentryDsn, environment: runtimeConfig().variant });
wireQueryManagers();

/** Module scope: one throttle for the life of the process. */
const sessionRefresher = createSessionRefresher(() => authClient.getSession());

function RootLayout() {
  const { data: session, isPending } = authClient.useSession();
  const appearance = useSettings((state) => state.appearance);

  useSessionRefresh(sessionRefresher);
  useFirstLaunchAnonymousSignIn(session !== null, isPending);
  useAppAnalytics();

  useEffect(() => {
    Appearance.setColorScheme(appearance === 'system' ? 'unspecified' : appearance);
  }, [appearance]);

  return (
    <SQLiteProvider databaseName={DATABASE_NAME} options={DATABASE_OPTIONS} onInit={onInitDatabase}>
      <QueryClientProvider client={queryClient}>
        <Stack screenOptions={{ headerShown: false }} />
      </QueryClientProvider>
    </SQLiteProvider>
  );
}

export default Sentry.wrap(RootLayout);
