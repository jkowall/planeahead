/**
 * `PushTransport` (increment 14, ruling P1): one interface, two implementations behind an injected
 * `fetch`, APNs and FCM HTTP v1. Every provider response maps to exactly one outcome:
 *
 *   - `sent`, with the `apns-id` or the FCM message name;
 *   - `retry`, with the delay the `push` consumer re-enqueues the target with (ruling P4): FCM never
 *     sooner than 10 s; FCM 429 honours `Retry-After`, and without one backs off exponentially
 *     from Google's one-minute minimum initial delay with up to 20 percent jitter,
 *     `min(900, 60 * 2^n * (1 + 0.2 * r))` seconds for a target with `n` sends before (review
 *     ruling R10, https://firebase.google.com/docs/reference/fcm/rest/v1/ErrorCode); APNs
 *     `TooManyRequests` 60 s (Apple states no backoff); APNs 5xx Apple's 15 minutes (decision 7);
 *   - `invalid_token`, with the reason `persist` judges the invalidation by (ruling P5): APNs 410
 *     `Unregistered` and `ExpiredToken` (with Apple's timestamp), 400 `BadDeviceToken` and
 *     `DeviceTokenNotForTopic`; FCM `UNREGISTERED`, `SENDER_ID_MISMATCH`, and `INVALID_ARGUMENT`
 *     only when its detail is an `FcmError`;
 *   - `failed`, with the reason: a request that can never succeed as sent (a payload, topic,
 *     credential or permission error). Nothing retries it.
 *
 * Every request has a 10-second timeout (FCM asks for at least 10 s, R1 F36), and every response
 * body is read or cancelled (`body.cancel()`), so a connection is never held by an unread stream.
 * Neither the token nor the bearer token ever reaches a log line or an outcome.
 *
 * APNs answers from APNs carry an `apns-id` header. A non-200 answer without one came from
 * something in between (a Cloudflare edge 52x, R1 U7), and is retried and counted as `edge_{status}`
 * for the transport soak (plan section 4).
 *
 * An answer from the sandbox also carries `apns-unique-id`: Apple documents it as available in the
 * Development environment only, and as the key to the notification's Delivery Log in the Push
 * Notifications Console
 * (https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns).
 * The transport keeps it, for a sandbox target only, as the outcome's `apnsUniqueId` (review
 * ruling R11): persist stores it in the attempt log and the admin page's test result shows it, so
 * the staging send can be followed into Apple's console. A production answer has none.
 *
 * THE RELAY (decision 8, designed here and not built). APNs needs HTTP/2, which Workers' `fetch`
 * speaks to origins only by the undocumented behaviour of Cloudflare's proxy (R1 F1 to F7). If the
 * staging send or the 24 to 48 hour soak fails (403 `UnrelatedKeyIdInToken`, 429
 * `TooManyProviderTokenUpdates` from pooled connections, edge 52x without an `apns-id`), a third
 * implementation replaces `createApnsTransport` and nothing above this interface changes:
 *
 *   - `createRelayTransport({ relay, credentials, now })`, `kind: 'apns'`. `relay` is a Cloudflare
 *     Container (the `lite` instance, about $1.71 a month always on, R1 section 5.5) behind its own
 *     Durable Object binding, reached with `containerFetch` over the binding: no public ingress, so
 *     no relay credential exists to leak. The container runs a small HTTP/2 client (Go's
 *     `net/http` or Node's `http2`) that keeps one long-lived connection per APNs host.
 *   - The Worker still builds the request (`buildApnsRequest`) and still mints the provider token
 *     through `PushAuth`, so the 20-minute rule and the payload contract stay in one place; the
 *     relay forwards `{ url, headers, body }` with the `authorization` header and answers APNs's
 *     status, its `apns-id` header and its body verbatim, so `mapApnsResponse` below is reused
 *     unchanged and every outcome keeps its meaning.
 *   - The relay adds nothing to retry: it answers 502 for a failed or timed-out APNs request
 *     without an `apns-id`, which maps to `edge_502`, a retry. Its image builds in CI (Docker is
 *     there); its cold start (1 to 3 s after 10 idle minutes, R1 F13) is kept off the path by a
 *     `sleepAfter` of a day.
 *   - Choosing it is configuration: an `APNS_TRANSPORT=relay` setting read where the consumer
 *     builds its transports. The fallbacks after it, in order, are FCM for iOS (the Firebase iOS SDK
 *     in the app) and Expo's push service for plain alerts, each another `PushTransport`.
 */

import {
  PUSH_REASON_RE,
  pushCredentialName,
  type PushJobV1,
  type PushTargetKind,
  type PushTargetV1,
} from '@planeahead/shared';
import { PushCredentialError, type PushCredentialSource } from './credentials';
import {
  buildApnsRequest,
  buildFcmRequest,
  withinPayloadLimit,
  type PushHttpRequest,
} from './payload';

/** Every provider request's timeout. */
export const PUSH_REQUEST_TIMEOUT_MS = 10_000;
/** APNs 429 `TooManyRequests` (too many for one device) and `TooManyProviderTokenUpdates`. */
export const APNS_THROTTLED_DELAY_SECONDS = 60;
/** Apple: after a 5xx, "After 15 minutes, you can retry" (decision 7). */
export const APNS_SERVER_ERROR_DELAY_SECONDS = 15 * 60;
/** A network failure, a timeout or an answer without an `apns-id`. */
export const APNS_TRANSIENT_DELAY_SECONDS = 60;
/** FCM: "never retry sooner than 10 s" (R1 F36). */
export const FCM_MIN_RETRY_DELAY_SECONDS = 10;
/**
 * FCM 429 without `Retry-After`: the first step of its exponential backoff, Google's minimum
 * initial delay of one minute (review ruling R10).
 */
export const FCM_QUOTA_DEFAULT_DELAY_SECONDS = 60;
/** The jitter on each step of FCM's 429 backoff: up to 20 percent on top (review ruling R10). */
export const FCM_QUOTA_BACKOFF_JITTER = 0.2;
/** The cap of FCM's exponential backoffs, on 5xx and on 429. */
export const FCM_MAX_BACKOFF_SECONDS = 15 * 60;
/** A credential that could not be had right now (the token exchange, the object). */
export const CREDENTIAL_RETRY_DELAY_SECONDS = 60;
/** How long a job waits for credentials that are not configured (ruling P7). */
export const NOT_CONFIGURED_HOLD_SECONDS = 5 * 60;

/**
 * What one send came to (ruling P1). `requested` says whether a request left the Worker: a local
 * verdict (a payload over the limit, a token that is not hex, no credential) sends nothing and
 * does not count as an attempt. `apnsUniqueId` is Apple's `apns-unique-id` from a sandbox answer
 * (review ruling R11), whatever the outcome; absent everywhere else.
 */
export type TransportOutcome = (
  | {
      readonly outcome: 'sent';
      readonly requested: true;
      readonly providerId: string | null;
      readonly httpStatus: number;
    }
  | {
      readonly outcome: 'retry';
      readonly requested: boolean;
      readonly reason: string;
      readonly delaySeconds: number;
      readonly httpStatus: number | null;
    }
  | {
      readonly outcome: 'invalid_token';
      readonly requested: boolean;
      readonly reason: string;
      readonly httpStatus: number | null;
      readonly apnsTimestampMs: number | null;
      readonly fcmErrorDetail: 'FcmError' | null;
    }
  | {
      readonly outcome: 'failed';
      readonly requested: boolean;
      readonly reason: string;
      readonly httpStatus: number | null;
      readonly fcmErrorDetail: 'FcmError' | 'BadRequest' | null;
    }
) & { readonly apnsUniqueId?: string | undefined };

export interface PushTransport {
  readonly kind: PushTargetKind;
  /** Sends one job to one target. Never throws: every failure is an outcome. */
  send(job: PushJobV1, target: PushTargetV1): Promise<TransportOutcome>;
}

export interface TransportDeps {
  readonly fetch: typeof fetch;
  readonly credentials: PushCredentialSource;
  readonly now?: (() => number) | undefined;
  readonly timeoutMs?: number | undefined;
}

/** A provider reason as an outcome may carry it: a plain identifier, or `unrecognised_reason`. */
export function safeReason(value: unknown): string | null {
  return typeof value === 'string' && PUSH_REASON_RE.test(value) ? value : null;
}

/** An answer the provider gave. */
function failed(
  reason: string,
  httpStatus: number | null,
  fcmErrorDetail: 'FcmError' | 'BadRequest' | null = null,
): TransportOutcome {
  return { outcome: 'failed', requested: true, reason, httpStatus, fcmErrorDetail };
}

function retry(reason: string, delaySeconds: number, httpStatus: number | null): TransportOutcome {
  return { outcome: 'retry', requested: true, reason, delaySeconds, httpStatus };
}

/** A verdict reached without sending. */
function localFailure(reason: string): TransportOutcome {
  return { outcome: 'failed', requested: false, reason, httpStatus: null, fcmErrorDetail: null };
}

function localRetry(reason: string, delaySeconds: number): TransportOutcome {
  return { outcome: 'retry', requested: false, reason, delaySeconds, httpStatus: null };
}

/**
 * A credential failure: a rejected key or account fails (nothing to retry until an operator acts),
 * an exchange that could not complete retries, and `not_configured` (which the consumer's own
 * check normally catches first) is held like the consumer holds it.
 */
function credentialOutcome(error: unknown): TransportOutcome {
  if (error instanceof PushCredentialError) {
    if (error.failure === 'not_configured') {
      return localRetry('not_configured', NOT_CONFIGURED_HOLD_SECONDS);
    }
    return error.retryable
      ? localRetry(error.failure, CREDENTIAL_RETRY_DELAY_SECONDS)
      : localFailure(error.failure);
  }
  return localRetry('credentials_unavailable', CREDENTIAL_RETRY_DELAY_SECONDS);
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

async function post(
  deps: TransportDeps,
  request: PushHttpRequest,
  authorization: string,
): Promise<Response | { readonly error: 'timeout' | 'network_error' }> {
  try {
    return await deps.fetch(request.url, {
      method: 'POST',
      headers: { ...request.headers, authorization },
      body: request.body,
      signal: AbortSignal.timeout(deps.timeoutMs ?? PUSH_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return { error: isTimeout(error) ? 'timeout' : 'network_error' };
  }
}

/** Reads a JSON body, or null; the body is consumed either way. */
async function jsonBody(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    return text === '' ? null : (JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

/**
 * The outcome of an APNs answer (R1 F23, F24). `apnsId` is the response's `apns-id` header;
 * `body` its parsed JSON (`{ reason, timestamp? }`), or null.
 */
export function mapApnsResponse(
  status: number,
  apnsId: string | null,
  body: unknown,
): TransportOutcome {
  if (status === 200) {
    return { outcome: 'sent', requested: true, providerId: apnsId, httpStatus: 200 };
  }
  if (apnsId === null) {
    // Not an APNs answer: something between the Worker and Apple spoke instead.
    return retry(`edge_${String(status)}`, APNS_TRANSIENT_DELAY_SECONDS, status);
  }
  const fields = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const reason = safeReason(fields['reason']);
  const timestamp = fields['timestamp'];
  switch (reason) {
    case 'Unregistered':
    case 'ExpiredToken':
      return {
        outcome: 'invalid_token',
        requested: true,
        reason,
        httpStatus: status,
        apnsTimestampMs:
          typeof timestamp === 'number' && Number.isSafeInteger(timestamp) && timestamp >= 0
            ? timestamp
            : null,
        fcmErrorDetail: null,
      };
    case 'BadDeviceToken':
    case 'DeviceTokenNotForTopic':
      return {
        outcome: 'invalid_token',
        requested: true,
        reason,
        httpStatus: status,
        apnsTimestampMs: null,
        fcmErrorDetail: null,
      };
    case 'TooManyProviderTokenUpdates':
    case 'TooManyRequests':
      return retry(reason, APNS_THROTTLED_DELAY_SECONDS, status);
    case 'ExpiredProviderToken':
      // The transport expires the token in PushAuth and replaces this delay (see below).
      return retry(reason, APNS_THROTTLED_DELAY_SECONDS, status);
    case 'IdleTimeout':
    case 'UnrelatedKeyIdInToken':
      // Both are about the connection, not the request: another connection can take it.
      return retry(reason, APNS_TRANSIENT_DELAY_SECONDS, status);
    default:
      if (status >= 500) {
        return retry(reason ?? `http_${String(status)}`, APNS_SERVER_ERROR_DELAY_SECONDS, status);
      }
      return failed(reason ?? `http_${String(status)}`, status);
  }
}

export function createApnsTransport(deps: TransportDeps): PushTransport {
  const now = deps.now ?? Date.now;
  return {
    kind: 'apns',
    async send(job, target) {
      const request = buildApnsRequest(job, target);
      if (!withinPayloadLimit(request)) {
        return localFailure('PayloadTooLarge');
      }
      if (!/^[0-9a-fA-F]+$/.test(target.token)) {
        // An APNs device token is hex; sending anything else earns a BadDeviceToken that counts
        // toward the connection's error budget (R1 F24). The same verdict, without the request.
        return {
          outcome: 'invalid_token',
          requested: false,
          reason: 'BadDeviceToken',
          httpStatus: null,
          apnsTimestampMs: null,
          fcmErrorDetail: null,
        };
      }
      const name = pushCredentialName('apns', target.environment);
      let bearer: string;
      try {
        bearer = await deps.credentials.token(name);
      } catch (error) {
        return credentialOutcome(error);
      }
      // APNs writes the scheme in lower case (R1 F21).
      const response = await post(deps, request, `bearer ${bearer}`);
      if ('error' in response) {
        return retry(response.error, APNS_TRANSIENT_DELAY_SECONDS, null);
      }
      const apnsId = headerValue(response, 'apns-id');
      // Sandbox only: the Push Notifications Console's key to this notification (ruling R11).
      const uniqueId =
        target.environment === 'sandbox' ? headerValue(response, 'apns-unique-id') : null;
      let body: unknown = null;
      if (response.status === 200 || apnsId === null) {
        await response.body?.cancel();
      } else {
        body = await jsonBody(response);
      }
      const outcome = withUniqueId(mapApnsResponse(response.status, apnsId, body), uniqueId);
      if (outcome.outcome === 'retry' && outcome.reason === 'ExpiredProviderToken') {
        // The token is too old for Apple: drop it, and retry once PushAuth may mint again.
        try {
          const remintAt = await deps.credentials.expire(name, bearer);
          const wait = Math.ceil((remintAt - now()) / 1000);
          return withUniqueId(
            retry(outcome.reason, Math.max(APNS_THROTTLED_DELAY_SECONDS, wait), outcome.httpStatus),
            uniqueId,
          );
        } catch {
          return outcome;
        }
      }
      return outcome;
    },
  };
}

/** A response header as an outcome may carry it: trimmed, at most 256 characters, or null. */
function headerValue(response: Response, name: string): string | null {
  const value = response.headers.get(name)?.trim() ?? '';
  return value === '' ? null : value.slice(0, 256);
}

function withUniqueId(outcome: TransportOutcome, uniqueId: string | null): TransportOutcome {
  return uniqueId === null ? outcome : { ...outcome, apnsUniqueId: uniqueId };
}

/** `Retry-After` as seconds (a number of seconds or an HTTP date), or null. */
export function retryAfterSeconds(header: string | null, nowMs: number): number | null {
  if (header === null) {
    return null;
  }
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - nowMs) / 1000));
}

/** FCM's exponential backoff on 5xx: 10 s, 20 s, 40 s, ... capped at 15 minutes. */
export function fcmBackoffSeconds(sendsBefore: number): number {
  const exponent = Math.max(0, Math.min(sendsBefore, 10));
  return Math.min(FCM_MAX_BACKOFF_SECONDS, FCM_MIN_RETRY_DELAY_SECONDS * 2 ** exponent);
}

/**
 * FCM's backoff on a 429 without `Retry-After` (review ruling R10): `min(900, 60 * 2^n *
 * (1 + 0.2 * r))` seconds, `n` the sends made for the target before this one and `r` uniform in
 * [0, 1), rounded to whole seconds (a queue delay is an integer). The jitter only adds, so the
 * first retry is never under Google's one-minute minimum; it spreads the targets one quota
 * refusal throttled, so they do not all come back in the same second.
 */
export function fcmQuotaBackoffSeconds(sendsBefore: number, random: () => number): number {
  const exponent = Math.max(0, Math.min(sendsBefore, 10));
  const jitter = Math.min(Math.max(random(), 0), 1);
  const seconds =
    FCM_QUOTA_DEFAULT_DELAY_SECONDS * 2 ** exponent * (1 + FCM_QUOTA_BACKOFF_JITTER * jitter);
  return Math.min(FCM_MAX_BACKOFF_SECONDS, Math.round(seconds));
}

interface FcmErrorDetail {
  readonly '@type'?: unknown;
  readonly errorCode?: unknown;
}

interface FcmErrorBody {
  readonly error?: { readonly status?: unknown; readonly details?: unknown };
}

/**
 * The outcome of an FCM answer (R1 F35, F36). `sendsBefore` is how many sends the target had
 * before this one, for the 5xx and 429 backoffs; `random` is the 429 backoff's jitter source.
 */
export function mapFcmResponse(
  status: number,
  body: unknown,
  retryAfter: number | null,
  sendsBefore: number,
  random: () => number = Math.random,
): TransportOutcome {
  if (status >= 200 && status < 300) {
    const name = (body as { name?: unknown } | null)?.name;
    return {
      outcome: 'sent',
      requested: true,
      providerId: typeof name === 'string' && name !== '' ? name.slice(0, 256) : null,
      httpStatus: status,
    };
  }
  const error = (body as FcmErrorBody | null)?.error;
  const rawDetails: unknown = error?.details;
  const details: readonly FcmErrorDetail[] = Array.isArray(rawDetails)
    ? (rawDetails as unknown[]).filter(
        (entry): entry is FcmErrorDetail => typeof entry === 'object' && entry !== null,
      )
    : [];
  const typeOf = (detail: FcmErrorDetail) =>
    typeof detail['@type'] === 'string' ? detail['@type'] : '';
  const fcmError = details.find((detail) =>
    typeOf(detail).endsWith('google.firebase.fcm.v1.FcmError'),
  );
  const badRequest = details.some((detail) => typeOf(detail).endsWith('google.rpc.BadRequest'));
  const code = safeReason(fcmError?.errorCode) ?? safeReason(error?.status);
  const detail: 'FcmError' | 'BadRequest' | null =
    fcmError !== undefined ? 'FcmError' : badRequest ? 'BadRequest' : null;
  const invalid = (reason: string): TransportOutcome => ({
    outcome: 'invalid_token',
    requested: true,
    reason,
    httpStatus: status,
    apnsTimestampMs: null,
    fcmErrorDetail: 'FcmError',
  });

  if (fcmError !== undefined && (code === 'UNREGISTERED' || code === 'SENDER_ID_MISMATCH')) {
    return invalid(code);
  }
  if (code === 'INVALID_ARGUMENT') {
    // A token FCM calls invalid carries an FcmError; a payload it refuses carries a BadRequest
    // with field violations. Only the first is the token's fault (ruling P5).
    return fcmError !== undefined && !badRequest ? invalid(code) : failed(code, status, detail);
  }
  if (status === 401) {
    // UNAUTHENTICATED: our access token expired or was revoked (THIRD_PARTY_AUTH_ERROR is the
    // APNs or web push credential inside Firebase, not ours, and fails below).
    if (code !== 'THIRD_PARTY_AUTH_ERROR') {
      return retry(code ?? 'UNAUTHENTICATED', FCM_MIN_RETRY_DELAY_SECONDS, status);
    }
  }
  if (status === 429) {
    // `Retry-After` wins (never under 10 s; the consumer caps it at the queue's maximum delay).
    return retry(
      code ?? 'QUOTA_EXCEEDED',
      retryAfter === null
        ? fcmQuotaBackoffSeconds(sendsBefore, random)
        : Math.max(FCM_MIN_RETRY_DELAY_SECONDS, retryAfter),
      status,
    );
  }
  if (status >= 500) {
    return retry(
      code ?? `http_${String(status)}`,
      Math.max(FCM_MIN_RETRY_DELAY_SECONDS, retryAfter ?? fcmBackoffSeconds(sendsBefore)),
      status,
    );
  }
  return failed(code ?? `http_${String(status)}`, status, detail);
}

export interface FcmTransportDeps extends TransportDeps {
  /** The Firebase project id, from the service account. */
  readonly projectId: string;
  /** The jitter source of the 429 backoff, uniform in [0, 1); `Math.random` unless a test asks. */
  readonly random?: (() => number) | undefined;
}

export function createFcmTransport(deps: FcmTransportDeps): PushTransport {
  const now = deps.now ?? Date.now;
  return {
    kind: 'fcm',
    async send(job, target) {
      const request = buildFcmRequest(job, target, deps.projectId, now());
      if (!withinPayloadLimit(request)) {
        return localFailure('PayloadTooLarge');
      }
      let bearer: string;
      try {
        bearer = await deps.credentials.token('fcm');
      } catch (error) {
        return credentialOutcome(error);
      }
      const response = await post(deps, request, `Bearer ${bearer}`);
      if ('error' in response) {
        return retry(response.error, fcmBackoffSeconds(target.attempt), null);
      }
      const body = await jsonBody(response);
      const outcome = mapFcmResponse(
        response.status,
        body,
        retryAfterSeconds(response.headers.get('retry-after'), now()),
        target.attempt,
        deps.random ?? Math.random,
      );
      if (outcome.outcome === 'retry' && response.status === 401) {
        // Drop the refused access token here and in PushAuth; the retry exchanges a new one.
        try {
          const remintAt = await deps.credentials.expire('fcm', bearer);
          const wait = Math.ceil((remintAt - now()) / 1000);
          return retry(outcome.reason, Math.max(FCM_MIN_RETRY_DELAY_SECONDS, wait), 401);
        } catch {
          return outcome;
        }
      }
      return outcome;
    },
  };
}
