import { Redirect, Stack } from 'expo-router';
import { Loading } from '../../components/ui';
import { authClient } from '../../lib/auth-client';
import { useLiveActivityTokens } from '../../lib/live-activity/tokens';
import { useBootstrap, useSessionWork } from '../../lib/session';

/**
 * Everything behind a session, anonymous included. No session means the sign-in group; while the
 * session is still being read from SecureStore, or the first-launch anonymous sign-in is in
 * flight, a spinner rather than a flash of the sign-in screen.
 */
export default function AppLayout() {
  const { data: session, isPending } = authClient.useSession();
  const anonymousPending = useBootstrap((state) => state.anonymousPending);
  useSessionWork(session?.user.id ?? null);
  // Increment 11: the Live Activity push-to-start token, registered per user (iOS only).
  useLiveActivityTokens(session?.user.id ?? null);

  if (session === null && (isPending || anonymousPending)) {
    return <Loading label="Loading" />;
  }
  if (session === null) {
    return <Redirect href="/sign-in" />;
  }
  return (
    <Stack screenOptions={{ headerShown: false }}>
      {/* The add-flight sheet (increment 10): a modal is a swipe-to-dismiss page sheet on iOS. */}
      <Stack.Screen name="add" options={{ presentation: 'modal' }} />
      {/*
        The route search (increment 18) opens from the add sheet as a sheet over it, so closing
        it returns to the sheet. The airport board (`airport/[code]`) is a pushed screen: the add
        sheet replaces itself with it, so it never lands behind the sheet.
      */}
      <Stack.Screen name="route-search" options={{ presentation: 'modal' }} />
    </Stack>
  );
}
