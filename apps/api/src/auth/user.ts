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

/**
 * How the principal authenticated. Only `session` (a Better Auth session) is issued today;
 * `api_token` is reserved for the Phase 5 tokens, so a route that must stay session-only says so
 * now (`requireSession`, increment 18 R15) instead of resting on those tokens never carrying the
 * `user` scope.
 */
export const PRINCIPAL_KINDS = ['session', 'api_token'] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

export interface AuthenticatedUser {
  /** `users.id`, a UUIDv7 (ADR 0006). */
  readonly id: string;
  /** True while the account came from anonymous sign-in and has not been upgraded. */
  readonly isAnonymous: boolean;
  /** How it authenticated: `session` for every principal issued today. */
  readonly kind: PrincipalKind;
  /** Better Auth session id, for revocation and for correlating logs with a sign-in. */
  readonly sessionId: string;
  /** What this principal may do. A session principal has exactly `user`. */
  readonly scopes: readonly AuthScope[];
}
