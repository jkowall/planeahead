/**
 * The authenticated caller as the rest of the Worker sees it.
 *
 * Increment 4 never produces one: the auth middleware sets `c.var.user = null` on every request.
 * The type exists now so route handlers, the principal rate limiter and the idempotency store can
 * be written against it, and so increment 5 replaces one middleware rather than every call site.
 *
 * Deliberately minimal. It carries what authorisation decisions need and nothing else: no email,
 * no name, no provider tokens. Anything richer is a database read behind `GET /v1/me`.
 */

export interface AuthenticatedUser {
  /** `users.id`, a UUIDv7 (ADR 0006). */
  readonly id: string;
  /** True while the account came from anonymous sign-in and has not been upgraded. */
  readonly isAnonymous: boolean;
  /** Better Auth session id, for revocation and for correlating logs with a sign-in. */
  readonly sessionId: string;
}
