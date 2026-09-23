/**
 * The Better Auth client (increment 5's server, `@better-auth/expo` 1.7.5).
 *
 * The session lives in SecureStore: the Expo plugin keeps the cookies Better Auth sets in one
 * JSON map under `planeahead_cookie` (chunked above 1800 bytes) and replays them itself on every
 * `/api/auth/*` request it makes, with `credentials: 'omit'`. `getCookie()` hands the same value
 * to the `/v1` client (src/lib/api-client.ts).
 *
 * Two rules the server relies on:
 * - Native sign-in bodies say `identityToken`, never `idToken`. The Expo plugin strips the stored
 *   cookie from any request whose body has an `idToken` key, and the anonymous-to-account merge
 *   needs that cookie to find the account being upgraded.
 * - A magic link is requested with no `callbackURL`, and verified IN THE APP with
 *   `magicLink.verify({ query: { token } })` (src/app/auth/magic-link.tsx; the 1.7.5 client takes
 *   the token under `query`, the spec's `{ token }` is the endpoint's own shape), so the verify
 *   call carries the anonymous cookie (the merge fires) and answers JSON plus `Set-Cookie`
 *   instead of a redirect with the cookie in its URL.
 *
 * One owner for `GET /get-session` on foreground: `sessionOptions.refetchOnWindowFocus` is off,
 * because the Expo plugin's focus manager fires on EVERY AppState change (background included,
 * rate limited to 5 s), which made the app refetch twice per foreground whatever the hourly
 * throttle said. The hourly refresher (src/lib/session-refresh.ts) refetches the session atom
 * itself, so its launch call and the atom's own mount fetch are one request (ADR 0001).
 * `__tests__/auth-transport.test.tsx` runs this real client over a recorded fetch.
 */

import { expoClient, storageAdapter } from '@better-auth/expo/client';
import { anonymousClient, magicLinkClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import * as SecureStore from 'expo-secure-store';
import { runtimeConfig } from './config';

export const AUTH_SCHEME = 'planeahead';
export const AUTH_STORAGE_PREFIX = 'planeahead';

export const authClient = createAuthClient({
  baseURL: runtimeConfig().apiUrl,
  sessionOptions: { refetchOnWindowFocus: false },
  plugins: [
    expoClient({ scheme: AUTH_SCHEME, storagePrefix: AUTH_STORAGE_PREFIX, storage: SecureStore }),
    anonymousClient(),
    magicLinkClient(),
  ],
});

export type AuthClient = typeof authClient;
export type SessionData = NonNullable<AuthClient['$Infer']['Session']>;

/** Where the Expo plugin keeps the cookie map (`${storagePrefix}_cookie`). */
export const AUTH_COOKIE_KEY = `${AUTH_STORAGE_PREFIX}_cookie`;

/**
 * The same chunked, serialised storage the Expo plugin wraps around SecureStore. Its queue is
 * keyed by the SecureStore object, so reads and writes here are ordered with the plugin's own.
 */
const cookieStorage = storageAdapter(SecureStore);

/** The stored cookie map, exactly as stored (null when there is none). */
export function snapshotAuthCookies(): Promise<string | null> {
  return cookieStorage.getItemAsync(AUTH_COOKIE_KEY);
}

/**
 * Puts a snapshot back (an empty map for none) and makes the session atom read the session it
 * names. Used to return to the anonymous session when a magic link signed this phone in to an
 * address it did not ask for (src/lib/magic-link.ts).
 */
export async function restoreAuthCookies(snapshot: string | null): Promise<void> {
  await cookieStorage.setItemAsync(AUTH_COOKIE_KEY, snapshot ?? '{}');
  authClient.$store.notify('$sessionSignal');
}

interface SessionAtomState {
  readonly error: unknown;
  readonly isRefetching: boolean;
  readonly refetch: () => Promise<void>;
}

interface SessionAtom {
  get(): SessionAtomState;
  listen(listener: (state: SessionAtomState) => void): () => void;
}

/**
 * `GET /api/auth/get-session` through the session atom, so it updates what `useSession` shows
 * and is shared with the atom's own mount fetch: a fetch already in flight is joined, never
 * cancelled and repeated (the atom's `refetch` aborts the one before it), and the atom's mount
 * fetch joins ours. Throws when the request failed (offline), so the refresher tries again on
 * the next foreground.
 */
export async function refreshSession(): Promise<void> {
  const atom = authClient.$store.atoms['session'] as SessionAtom | undefined;
  if (atom === undefined) {
    await authClient.getSession();
    return;
  }
  if (atom.get().isRefetching) {
    await new Promise<void>((resolve) => {
      const stop = atom.listen((state) => {
        if (!state.isRefetching) {
          stop();
          resolve();
        }
      });
    });
  } else {
    await atom.get().refetch();
  }
  const { error } = atom.get();
  if (error !== null && error !== undefined) {
    throw error instanceof Error ? error : new Error('get-session failed');
  }
}

export { isAnonymousSession } from './auth-session';
