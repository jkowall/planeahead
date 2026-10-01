/**
 * The root layout: Sentry (initialised at module scope, before anything can throw), the offline
 * store (SQLiteProvider renders nothing until `onInitDatabase` has set WAL and run the bundled
 * migrations, so no screen ever sees an unmigrated database), TanStack Query, the session refresh
 * on launch and foreground, and the first-launch anonymous sign-in.
 *
 * The session gate itself is in the group layouts: `(app)` redirects to `(auth)` without a
 * session, `(auth)` redirects to `(app)` once the session is a real account. `auth/magic-link`
 * sits outside both, because the universal link can arrive in either state.
 *
 * Increment 16, at every start: the foreground notification handler, installed once at module
 * scope (ruling C6); the two Android channels, before any permission request can run (ruling C4);
 * a sign-out's invalidation queued offline, retried before anything registers (ruling C3); and
 * the tap that launched the app, plus every tap after, held until there is a session (ruling C7,
 * routed by the `(app)` layout). src/lib/push-notifications.ts has the details.
 */

import * as Sentry from '@sentry/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { SQLiteProvider } from 'expo-sqlite';
import { useEffect } from 'react';
import { Appearance } from 'react-native';
import { authClient, refreshSession } from '../lib/auth-client';
import { runtimeConfig } from '../lib/config';
import { DATABASE_NAME, DATABASE_OPTIONS, onInitDatabase } from '../lib/db/client';
import { settleQueuedInvalidation } from '../lib/device-invalidation';
import { ensureAndroidChannels } from '../lib/push';
import { installForegroundHandler, useNotificationResponses } from '../lib/push-notifications';
import { queryClient, wireQueryManagers } from '../lib/query';
import { initSentry } from '../lib/sentry';
import { useAppAnalytics, useFirstLaunchAnonymousSignIn } from '../lib/session';
import { createSessionRefresher, useSessionRefresh } from '../lib/session-refresh';
import { useSettings } from '../lib/settings';

initSentry({ dsn: runtimeConfig().sentryDsn, environment: runtimeConfig().variant });
wireQueryManagers();
installForegroundHandler();
void ensureAndroidChannels();
// Offline it stays queued, and the next registration tries it again first.
settleQueuedInvalidation().catch(() => undefined);

/**
 * Module scope: one throttle for the life of the process. It refetches the session atom, so the
 * launch call shares the atom's own mount request (src/lib/auth-client.ts).
 */
const sessionRefresher = createSessionRefresher(refreshSession);

function RootLayout() {
  const { data: session, isPending } = authClient.useSession();
  const appearance = useSettings((state) => state.appearance);

  useSessionRefresh(sessionRefresher);
  useFirstLaunchAnonymousSignIn(session !== null, isPending);
  useAppAnalytics();
  useNotificationResponses();

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
