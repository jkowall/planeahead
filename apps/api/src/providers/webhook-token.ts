/**
 * Webhook path tokens (increment 6): 256 bits, as 43 base64url characters or 64 hex characters.
 * One definition for both sides of the contract: the receiver (src/routes/webhooks.ts) accepts
 * only a configured token of this shape, and the router (src/providers/router.ts) builds an
 * AeroAPI `target_url` only from one, so an alert can never be registered with a URL our own
 * receiver would answer 404. Dependency free, so the middleware can import it too.
 */

/**
 * The path prefix of every provider webhook receiver (`/v1/webhooks/{provider}/{token}`). The
 * public per-IP limiter skips it (orchestrator ruling I2) and the Sentry scrubber redacts the
 * segment after the provider.
 */
export const WEBHOOK_PATH_PREFIX = '/v1/webhooks/';

const TOKEN_RE = /^(?:[A-Za-z0-9_-]{43}|[0-9a-fA-F]{64})$/;

/** Whether a configured token has the 256-bit shape; a shorter secret disables the route. */
export function isWellFormedWebhookToken(token: string | undefined): token is string {
  return token !== undefined && TOKEN_RE.test(token);
}
