/**
 * The authenticated caller as the rest of the Worker sees it.
 *
 * Deliberately minimal. It carries what authorisation decisions need and nothing else: no email,
 * no name, no provider tokens. Anything richer is a database read behind `GET /v1/me`.
 *
 * `scopes` is what `requireScope` checks. A Better Auth session is a `user` principal (the
 * person, on their own device); `api_tokens` (Phase 5 share links and MCP tokens) will carry
 * explicit scopes and land here through the same interface, which is why the field exists now
 * rather than being bolted on with a second guard later.
 */

export const AUTH_SCOPES = ['user'] as const;
export type AuthScope = (typeof AUTH_SCOPES)[number];

export interface AuthenticatedUser {
  /** `users.id`, a UUIDv7 (ADR 0006). */
  readonly id: string;
  /** True while the account came from anonymous sign-in and has not been upgraded. */
  readonly isAnonymous: boolean;
  /** Better Auth session id, for revocation and for correlating logs with a sign-in. */
  readonly sessionId: string;
  /** What this principal may do. A session principal has exactly `user`. */
  readonly scopes: readonly AuthScope[];
}
