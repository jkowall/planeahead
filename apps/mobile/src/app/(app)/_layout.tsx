import { Redirect, Stack } from 'expo-router';
import { Loading } from '../../components/ui';
import { authClient } from '../../lib/auth-client';
import { useLiveActivityTokens } from '../../lib/live-activity/tokens';
import { usePushRouting } from '../../lib/push-routing';
import { useBootstrap, useSessionWork } from '../../lib/session';

/**
 * Everything behind a session, anonymous included. No session means the sign-in group; while the
 * session is still being read from SecureStore, or the first-launch anonymous sign-in is in
 * flight, a spinner rather than a flash of the sign-in screen.
 */
export default function AppLayout() {
  const { data: session, isPending } = authClient.useSession();
  const anonymousPending = useBootstrap((state) => state.anonymousPending);
  const userId = session?.user.id ?? null;
  useSessionWork(userId);
  // Increment 11: the Live Activity push-to-start token, registered per user (iOS only).
  useLiveActivityTokens(userId);
  // Increment 16: a tapped push opens its flight once there is a session, and a push received in
  // the foreground refreshes the store (rulings C6 and C7).
  usePushRouting(userId);

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
      {/* Increment 16: the notification pre-prompt, in the add sheet's place (ruling C1). */}
      <Stack.Screen name="notifications" options={{ presentation: 'modal' }} />
    </Stack>
  );
}
