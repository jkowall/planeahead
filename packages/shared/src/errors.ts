import { z } from 'zod';
import { FlightSearchSuggestionSchema } from './api';
import { IsoDateSchema } from './flight-status';
import { CAP_NAMES } from './limits';

/**
 * The PlaneAhead error envelope and its codes (increment 8, rulings K14 and O10).
 *
 * Every non-2xx JSON answer from the API Worker has this shape, including the ones a framework
 * layer raises under `/v1` (a malformed JSON body is 400 `validation_failed` with an
 * `invalid_json` issue, an oversized one 413 `payload_too_large`): `error` is a stable machine code
 * from `API_ERROR_CODES`, `message` is for a human and may change, `requestId` is the correlation
 * id also sent as `X-Request-Id`. Some codes carry extra fields (`issues` on
 * `validation_failed`, `cap` and `limit` on `cap_exceeded`, `flight` on `refresh_timeout` and on
 * the refresh route's `flight_archived`, `triedDates` and `suggestions` on `flight_not_found` from
 * the search and subscribe-by-number routes), so the schema is loose. The mobile client branches
 * on `error`, never on `message` or the status alone: 401 `account_deleted` wipes the local store,
 * 401 `unauthenticated` signs in again.
 *
 * A REPLAYED answer (`Idempotent-Replayed: true`, a stored response to an `Idempotency-Key` sent
 * again) carries the ORIGINAL request's `requestId` in its body, since the body is stored and
 * replayed byte for byte, while its `X-Request-Id` header names the replay. Correlate a replayed
 * error by the body's id.
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
  // Boards and route search (increment 18): an airport code no `airports` row with a real ICAO
  // code answers; an airport AeroDataBox covers neither live nor by schedule (no provider call
  // was made); no copy of a bucket exists and the provider could not fill it; an anonymous
  // account asked for the board of an airport none of its live subscriptions touches.
  'airport_not_found',
  'board_not_covered',
  'board_unavailable',
  'board_requires_account',
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
  /** `flight_not_found` from a search: the origin-local dates the provider was asked for. */
  triedDates: z.array(IsoDateSchema).optional(),
  /** `flight_not_found` from a search: reserved, always empty in Phase 0 (ruling O4). */
  suggestions: z.array(FlightSearchSuggestionSchema).optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/** Whether a parsed error body names this code. */
export function isApiError(body: unknown, code: ApiErrorCode): boolean {
  const parsed = ApiErrorSchema.safeParse(body);
  return parsed.success && parsed.data.error === code;
}
