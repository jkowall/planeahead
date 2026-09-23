/**
 * Webhook path tokens (increment 6): 256 bits, as 43 base64url characters or 64 hex characters.
 * One definition for both sides of the contract: the receiver (src/routes/webhooks.ts) accepts
 * only a configured token of this shape, and the router (src/providers/router.ts) builds an
 * AeroAPI `target_url` only from one, so an alert can never be registered with a URL our own
 * receiver would answer 404. Dependency free, so the middleware can import it too.
 */

/**
 * The path prefix of every webhook route (`/v1/webhooks/{provider}/{token}` and the reserved
 * stubs). The Sentry scrubber redacts the segment after the provider; the public per-IP limiter
 * skips only the provider receivers below (orchestrator rulings I2 and K12).
 */
export const WEBHOOK_PATH_PREFIX = '/v1/webhooks/';

/**
 * The provider receivers' own prefixes (`/v1/webhooks/{provider}/{token}`). Only these are exempt
 * from the public per-IP limiter (ruling I2); the reserved Apple and RevenueCat stubs under
 * `/v1/webhooks/` (increment 8, ruling K12) carry no path token and stay inside it.
 */
export const PROVIDER_WEBHOOK_PATH_PREFIXES = [
  '/v1/webhooks/aerodatabox/',
  '/v1/webhooks/aeroapi/',
] as const;

export function isProviderWebhookPath(path: string): boolean {
  return PROVIDER_WEBHOOK_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

const TOKEN_RE = /^(?:[A-Za-z0-9_-]{43}|[0-9a-fA-F]{64})$/;

/** Whether a configured token has the 256-bit shape; a shorter secret disables the route. */
export function isWellFormedWebhookToken(token: string | undefined): token is string {
  return token !== undefined && TOKEN_RE.test(token);
}
