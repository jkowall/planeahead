/**
 * Remote JWKS resolvers, one per URL, memoised at module scope.
 *
 * jose's `createRemoteJWKSet` performs no I/O at construction, keeps its own in-memory cache
 * (10 minutes, with a 30 second cooldown between refetches on a cache miss) and jose's own
 * documentation says not to use the external `jwksCache` on runtimes that hold in-memory state.
 * So the right lifetime for a resolver is the isolate, and this Map is the documented exception
 * to the module-scope rule that `planeahead/no-module-scope-drizzle` enforces for clients: it
 * holds no request-scoped state and opens nothing until the first verification asks for a key.
 * Keyed by URL because the URL is a test seam (`APPLE_JWKS_URL`, `GOOGLE_JWKS_URL`).
 *
 * Never put a JWKS in KV: the cache must be per isolate so a key rotation at the provider is
 * seen by a refetch, not served stale from a shared store.
 */

import { type JWTVerifyGetKey, createRemoteJWKSet } from 'jose';

const resolvers = new Map<string, JWTVerifyGetKey>();

export function remoteJwks(url: string): JWTVerifyGetKey {
  let resolver = resolvers.get(url);
  if (resolver === undefined) {
    resolver = createRemoteJWKSet(new URL(url));
    resolvers.set(url, resolver);
  }
  return resolver;
}
