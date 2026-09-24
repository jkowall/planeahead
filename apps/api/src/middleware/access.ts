/**
 * Cloudflare Access in front of `/admin` (increment 12, ruling W5).
 *
 * Access sits in front of the hostname path and adds `Cf-Access-Jwt-Assertion` to every request it
 * lets through; the Worker must still validate it, because a request that reaches the Worker any
 * other way (a misconfigured Access policy, a route added later, the workers.dev hostname) carries
 * no assertion or a forged one. The token is an RS256 JWT signed by the team's keys, published at
 * `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, issued by that origin, with the
 * Access application's AUD tag in `aud` (https://developers.cloudflare.com/cloudflare-one/
 * identity/authorization-cookie/validating-json/).
 *
 * `ACCESS_TEAM_DOMAIN` (the `<team>.cloudflareaccess.com` host, nothing else is accepted) and
 * `ACCESS_AUD` are vars. Either one empty, the header missing, a bad signature, a wrong issuer,
 * a wrong audience, an expired token or an unreachable certs endpoint: 403 with an empty body and
 * `no-store`, and the reason only in the log. The certs are fetched through the injected `fetch`
 * and cached per isolate for `ACCESS_CERTS_TTL_MS`; a token signed by a key the cache does not
 * hold (Access rotates its keys) refetches once, at most every `ACCESS_CERTS_REFETCH_MS`.
 */

import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import type { Context, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AppBindings } from '../env';
import { createLogger } from '../observability/log';

export const ACCESS_JWT_HEADER = 'Cf-Access-Jwt-Assertion';
export const ACCESS_CERTS_TTL_MS = 10 * 60_000;
export const ACCESS_CERTS_REFETCH_MS = 30_000;

const TEAM_DOMAIN_SHAPE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;

export function accessCertsUrl(teamDomain: string): string {
  return `https://${teamDomain}/cdn-cgi/access/certs`;
}

interface CachedCerts {
  readonly jwks: JSONWebKeySet;
  readonly fetchedAtMs: number;
}

/**
 * The certs cache: team domain to the last JWKS fetched. Module scope on purpose, like the JWKS
 * resolvers in src/auth/jwks.ts: public keys, no I/O object, no request state.
 */
export type AccessCertsCache = Map<string, CachedCerts>;
const isolateCache: AccessCertsCache = new Map();

export interface AccessOptions {
  readonly fetch?: typeof fetch | undefined;
  readonly now?: (() => number) | undefined;
  readonly cache?: AccessCertsCache | undefined;
}

/** The verified identity, for the log line and the page header. */
export interface AccessIdentity {
  readonly subject: string;
  readonly email: string | null;
}

async function fetchCerts(doFetch: typeof fetch, teamDomain: string): Promise<JSONWebKeySet> {
  const response = await doFetch(accessCertsUrl(teamDomain), {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Access certs endpoint answered ${String(response.status)}`);
  }
  const body = await response.json<{ keys?: unknown }>();
  if (!Array.isArray(body.keys)) {
    throw new Error('Access certs endpoint returned no keys');
  }
  return { keys: body.keys as JSONWebKeySet['keys'] };
}

interface ResolvedAccessOptions {
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly cache: AccessCertsCache;
}

async function certsFor(
  options: ResolvedAccessOptions,
  teamDomain: string,
  force: boolean,
): Promise<CachedCerts> {
  const cached = options.cache.get(teamDomain);
  const now = options.now();
  const fresh = cached !== undefined && now - cached.fetchedAtMs < ACCESS_CERTS_TTL_MS;
  const mayRefetch = cached === undefined || now - cached.fetchedAtMs >= ACCESS_CERTS_REFETCH_MS;
  if (cached !== undefined && ((fresh && !force) || !mayRefetch)) {
    return cached;
  }
  const entry = { jwks: await fetchCerts(options.fetch, teamDomain), fetchedAtMs: now };
  options.cache.set(teamDomain, entry);
  return entry;
}

function isNoMatchingKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ERR_JWKS_NO_MATCHING_KEY'
  );
}

/** Verifies an assertion; throws with the reason (never shown to the caller). */
export async function verifyAccessAssertion(
  token: string,
  config: { teamDomain: string; audience: string },
  options: AccessOptions = {},
): Promise<AccessIdentity> {
  const resolved: ResolvedAccessOptions = {
    fetch: options.fetch ?? fetch,
    now: options.now ?? Date.now,
    cache: options.cache ?? isolateCache,
  };
  const verify = async (force: boolean) => {
    const certs = await certsFor(resolved, config.teamDomain, force);
    return jwtVerify(token, createLocalJWKSet(certs.jwks), {
      algorithms: ['RS256'],
      issuer: `https://${config.teamDomain}`,
      audience: config.audience,
      currentDate: new Date(resolved.now()),
    });
  };
  let verified;
  try {
    verified = await verify(false);
  } catch (error) {
    if (!isNoMatchingKey(error)) {
      throw error;
    }
    verified = await verify(true);
  }
  const { payload } = verified;
  const subject = typeof payload.sub === 'string' && payload.sub !== '' ? payload.sub : null;
  if (subject === null) {
    throw new Error('the Access assertion carries no subject');
  }
  const email = typeof payload['email'] === 'string' ? payload['email'] : null;
  return { subject, email };
}

function forbidden(): Response {
  return new Response(null, { status: 403, headers: { 'cache-control': 'no-store' } });
}

/** Reads a var through a widened type (the generated literal type of an empty var is `""`). */
function varOf(c: Context<AppBindings>, name: 'ACCESS_TEAM_DOMAIN' | 'ACCESS_AUD'): string {
  const value: unknown = (c.env as unknown as Record<string, unknown>)[name];
  return typeof value === 'string' ? value.trim() : '';
}

export function accessMiddleware(options: AccessOptions = {}): MiddlewareHandler<AppBindings> {
  return createMiddleware<AppBindings>(async (c, next) => {
    const log = createLogger({ request_id: c.var.requestId });
    const teamDomain = varOf(c, 'ACCESS_TEAM_DOMAIN');
    const audience = varOf(c, 'ACCESS_AUD');
    if (!TEAM_DOMAIN_SHAPE.test(teamDomain) || audience === '') {
      log.warn('admin_access_denied', { reason: 'access_not_configured' });
      return forbidden();
    }
    const token = c.req.header(ACCESS_JWT_HEADER);
    if (token === undefined || token === '') {
      log.warn('admin_access_denied', { reason: 'assertion_missing' });
      return forbidden();
    }
    let identity: AccessIdentity;
    try {
      identity = await verifyAccessAssertion(token, { teamDomain, audience }, options);
    } catch (error) {
      log.warn('admin_access_denied', {
        reason: 'assertion_invalid',
        detail: error instanceof Error ? error.name : 'unknown',
      });
      return forbidden();
    }
    log.info('admin_access_granted', { subject: identity.subject });
    c.set('accessIdentity', identity);
    await next();
  });
}
