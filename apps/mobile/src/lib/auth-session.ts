/** Pure helpers over a Better Auth session, kept apart from the client so tests can use them. */

/** Anonymous users carry `isAnonymous: true` (the anonymous plugin's user field). */
export function isAnonymousSession(session: unknown): boolean {
  if (typeof session !== 'object' || session === null || !('user' in session)) {
    return false;
  }
  const user: unknown = (session as { user?: unknown }).user;
  return (
    typeof user === 'object' &&
    user !== null &&
    'isAnonymous' in user &&
    (user as { isAnonymous?: unknown }).isAnonymous === true
  );
}
