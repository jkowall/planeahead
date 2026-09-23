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
 *   `magicLink.verify({ query: { token } })` (src/app/auth/magic-link.tsx), so the verify call
 *   carries the anonymous cookie (the merge fires) and answers JSON plus `Set-Cookie` instead of
 *   a redirect with the cookie in its URL.
 */

import { expoClient } from '@better-auth/expo/client';
import { anonymousClient, magicLinkClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import * as SecureStore from 'expo-secure-store';
import { runtimeConfig } from './config';

export const AUTH_SCHEME = 'planeahead';
export const AUTH_STORAGE_PREFIX = 'planeahead';

export const authClient = createAuthClient({
  baseURL: runtimeConfig().apiUrl,
  plugins: [
    expoClient({ scheme: AUTH_SCHEME, storagePrefix: AUTH_STORAGE_PREFIX, storage: SecureStore }),
    anonymousClient(),
    magicLinkClient(),
  ],
});

export type AuthClient = typeof authClient;
export type SessionData = NonNullable<AuthClient['$Infer']['Session']>;

export { isAnonymousSession } from './auth-session';
