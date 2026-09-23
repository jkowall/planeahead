import { z } from 'zod';
import { CAP_NAMES } from './limits';

/**
 * The PlaneAhead error envelope and its codes (increment 8, ruling K14).
 *
 * Every non-2xx JSON answer from the API Worker has this shape: `error` is a stable machine code
 * from `API_ERROR_CODES`, `message` is for a human and may change, `requestId` is the correlation
 * id also sent as `X-Request-Id`. Some codes carry extra fields (`issues` on
 * `validation_failed`, `cap` and `limit` on `cap_exceeded`, `flight` on `refresh_timeout`), so
 * the schema is loose. The mobile client branches on `error`, never on `message` or the status
 * alone: 401 `account_deleted` wipes the local store, 401 `unauthenticated` signs in again.
 */

export const API_ERROR_CODES = [
  // Chain and generic
  'internal_error',
  'not_found',
  'not_implemented',
  'rate_limited',
  'unavailable',
  'payload_too_large',
  'invalid_payload',
  'validation_failed',
  // Principal
  'unauthenticated',
  'account_deleted',
  'insufficient_scope',
  'install_id_mismatch',
  // Idempotency (IETF draft-ietf-httpapi-idempotency-key-header semantics)
  'invalid_idempotency_key',
  'idempotency_key_required',
  'idempotency_scope_missing',
  'idempotency_payload_mismatch',
  'in_flight',
  // Caps
  'cap_exceeded',
  // Flights
  'flight_not_found',
  'flight_archived',
  'subscription_not_found',
  'date_out_of_range',
  'refresh_timeout',
  'upstream_timeout',
  'provider_unavailable',
  'provider_error',
  // Sync
  'resync_required',
  'invalid_cursor',
] as const;
export const ApiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ValidationIssueSchema = z.looseObject({
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string(),
  code: z.string().optional(),
});
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;

export const ApiErrorSchema = z.looseObject({
  /** A code from `API_ERROR_CODES`; parsed as a string so a newer server's code still reads. */
  error: z.string(),
  message: z.string().optional(),
  requestId: z.string(),
  /** `validation_failed`: what the validator rejected. */
  issues: z.array(ValidationIssueSchema).optional(),
  /** `cap_exceeded`: which cap and its limit. */
  cap: z.enum(CAP_NAMES).optional(),
  limit: z.int().nonnegative().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/** Whether a parsed error body names this code. */
export function isApiError(body: unknown, code: ApiErrorCode): boolean {
  const parsed = ApiErrorSchema.safeParse(body);
  return parsed.success && parsed.data.error === code;
}
