import { Redirect, Stack } from 'expo-router';
import { authClient, isAnonymousSession } from '../../lib/auth-client';

/**
 * Signed-out screens. A real account has nothing to do here and goes home; an anonymous session
 * may be here on purpose, to upgrade (settings links to it), so it stays.
 */
export default function AuthLayout() {
  const { data: session } = authClient.useSession();
  if (session !== null && !isAnonymousSession(session)) {
    return <Redirect href="/" />;
  }
  return <Stack screenOptions={{ headerShown: false }} />;
}
