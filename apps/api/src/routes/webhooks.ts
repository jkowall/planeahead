/**
 * Provider webhook receivers (increment 6): `POST /v1/webhooks/aerodatabox/{token}` and
 * `POST /v1/webhooks/aeroapi/{token}`.
 *
 * Neither provider signs its deliveries. AeroDataBox subscriptions accept only a URL, which
 * "must not require additional authorization", and carry no secret and no HMAC; AeroAPI alerts
 * carry nothing either (facts sheet sections 1 and 2). The authentication is therefore an
 * unguessable path: a 256-bit token per provider and per environment (`WEBHOOK_TOKEN_AERODATABOX`,
 * `WEBHOOK_TOKEN_AEROAPI`), compared in constant time after a length check. The AeroAPI token
 * rides in each alert's `target_url`; the AeroDataBox token in the subscription URL.
 *
 * What a receiver does, in order, and nothing else:
 *
 *   1. AeroDataBox only: while `ADB_ALERTS_ENABLED` is not `true`, answer 404. No subscription
 *      exists in Phase 0; the parser is built and tested, the door is shut.
 *   2. Compare the token. A wrong, missing or unconfigured token answers the app's ordinary 404,
 *      never 401 or 403: the route does not confirm that a token exists to be guessed.
 *   3. Read at most 256 KB and validate the body strictly (required fields, types, bounds); a
 *      malformed body is 400. Unknown extra fields are tolerated so a provider adding one does
 *      not silently drop real deliveries; an unknown AeroAPI `event_code` maps to `unknown`.
 *   4. Enqueue the parsed `ProviderEventV1`s on the `provider-events` queue and answer 200.
 *
 * It never fetches, never opens Postgres and never touches a Durable Object: a provider that
 * times out on its own webhook retries it, and slow work here would turn one delivery into
 * several. The body is a hint, not data: the consumer (increment 7) routes it to the tracker,
 * which merges an AeroAPI patch onto its snapshot or re-reads the flight for an AeroDataBox hint.
 *
 * The token is part of the URL, so this module never logs a path, and the Sentry scrubber
 * redacts `/v1/webhooks/{provider}/{token}` (src/middleware/sentry.ts). Residual risk, recorded
 * in ADR 0010: Cloudflare's own invocation logs keep request URLs, so the token is readable by
 * anyone with account access to Workers Logs; rotate it if that access widens.
 */

import { Hono, type Context } from 'hono';
import {
  ProviderEventV1,
  RPC_SCHEMA_VERSION,
  type Exact,
  type ProviderEvent,
} from '@planeahead/shared';
import { utf8, timingSafeEqualBytes } from '../crypto/hash';
import type { AppBindings } from '../env';
import { createLogger, errorFields } from '../observability/log';
import { AeroApiAlertError, parseAeroApiAlert } from '../providers/aeroapi.mock';
import { WebhookPayloadError, parseAdbNotification } from '../providers/aerodatabox.adapter';
import { providerSettings } from '../providers/config';

export type WebhookProvider = 'aerodatabox' | 'aeroapi';

/** The most a delivery may carry. An AeroDataBox notification with many flights is ~2 KB each. */
export const WEBHOOK_BODY_LIMIT_BYTES = 256 * 1024;

/** Queue `sendBatch` accepts at most 100 messages. */
const SEND_BATCH_MAX = 100;

/** 256 bits: 43 base64url characters, or 64 hex characters. */
const TOKEN_RE = /^(?:[A-Za-z0-9_-]{43}|[0-9a-fA-F]{64})$/;

/** Whether a configured token has the 256-bit shape; a shorter secret disables the route. */
export function isWellFormedWebhookToken(token: string | undefined): token is string {
  return token !== undefined && TOKEN_RE.test(token);
}

export type ByteComparator = (a: Uint8Array, b: Uint8Array) => boolean;

/**
 * Constant-time comparison of a presented path token against the configured one. The lengths
 * are compared first (`crypto.subtle.timingSafeEqual` throws on unequal lengths, and the length
 * of the configured token is public: it is fixed by the format), then the bytes in constant time.
 * An unconfigured or malformed configured token never matches anything.
 */
export function verifyPathToken(
  presented: string,
  expected: string | undefined,
  equal: ByteComparator = timingSafeEqualBytes,
): boolean {
  if (!isWellFormedWebhookToken(expected)) {
    return false;
  }
  const a = utf8(presented);
  const b = utf8(expected);
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  return equal(a, b);
}

/** Reads the body, refusing more than `limit` bytes; null when it is too large. */
async function readLimited(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    return null;
  }
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > limit) {
    return null;
  }
  return new TextDecoder().decode(buffer);
}

function expectedToken(c: Context<AppBindings>, provider: WebhookProvider): string | undefined {
  return provider === 'aerodatabox' ? c.env.WEBHOOK_TOKEN_AERODATABOX : c.env.WEBHOOK_TOKEN_AEROAPI;
}

async function parseDelivery(
  provider: WebhookProvider,
  text: string,
  receivedAt: Date,
): Promise<Exact<ProviderEvent>[]> {
  if (provider === 'aeroapi') {
    return [await parseAeroApiAlert(text, receivedAt)];
  }
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    throw new WebhookPayloadError('body is not JSON');
  }
  return parseAdbNotification(body, receivedAt);
}

async function receive(c: Context<AppBindings>, provider: WebhookProvider): Promise<Response> {
  // Never the path: it carries the token.
  const log = createLogger({ request_id: c.var.requestId, webhook: provider });
  if (provider === 'aerodatabox' && !providerSettings(c.env).adbAlertsEnabled) {
    return c.notFound();
  }
  const expected = expectedToken(c, provider);
  if (!verifyPathToken(c.req.param('token') ?? '', expected)) {
    log.info('webhook_rejected', {
      reason: isWellFormedWebhookToken(expected) ? 'token' : 'token_not_configured',
    });
    return c.notFound();
  }
  const text = await readLimited(c.req.raw, WEBHOOK_BODY_LIMIT_BYTES);
  if (text === null) {
    return c.json({ error: 'payload_too_large', requestId: c.var.requestId }, 413);
  }
  let events: Exact<ProviderEvent>[];
  try {
    events = await parseDelivery(provider, text, new Date());
  } catch (error) {
    if (error instanceof WebhookPayloadError || error instanceof AeroApiAlertError) {
      log.info('webhook_invalid_payload', { error_message: error.message });
      return c.json({ error: 'invalid_payload', requestId: c.var.requestId }, 400);
    }
    log.error('webhook_parse_failed', errorFields(error));
    return c.json({ error: 'internal_error', requestId: c.var.requestId }, 500);
  }
  const messages = events.map((event) => ({
    body: ProviderEventV1.parse({ ...event, rpcVersion: RPC_SCHEMA_VERSION }),
  }));
  try {
    for (let index = 0; index < messages.length; index += SEND_BATCH_MAX) {
      await c.env.PROVIDER_EVENTS_QUEUE.sendBatch(messages.slice(index, index + SEND_BATCH_MAX));
    }
  } catch (error) {
    // 503 so the provider may retry; logged without the path.
    log.error('webhook_enqueue_failed', { events: messages.length, ...errorFields(error) });
    return c.json({ error: 'unavailable', requestId: c.var.requestId }, 503);
  }
  log.info('webhook_accepted', { events: messages.length });
  return c.json({ accepted: messages.length }, 200);
}

/**
 * Mounted at `/v1/webhooks`. Anything under it that is not one of the two POST receivers is the
 * app's ordinary 404, so a wrong provider, method or token all read the same.
 */
export const webhookRoutes = new Hono<AppBindings>()
  .post('/aerodatabox/:token', (c) => receive(c, 'aerodatabox'))
  .post('/aeroapi/:token', (c) => receive(c, 'aeroapi'))
  .all('/*', (c) => c.notFound());
