/**
 * The request builders (increment 14, rulings P1 and P2): one job and one target in, the provider
 * request out, minus the bearer token the transport adds. Pure; unit-tested for shape and size.
 *
 * APNs (`POST /3/device/{token}`, HTTP/2, R1 F21 and F22):
 *
 *   headers  apns-topic (the target's app id), apns-push-type alert, apns-priority 10 or 5,
 *            apns-expiration (the job's `expiresAt` in epoch seconds), apns-collapse-id
 *            (`{kind}:{flightKey}`, at most 64 bytes)
 *   body     { aps: { alert: { title, body }, sound, thread-id, interruption-level },
 *              body: { v, kind, flightSubscriptionId } }
 *
 * App data rides in the top-level `body` dictionary beside `aps`, never as peers of `aps`:
 * expo-notifications exposes `userInfo.body` as `content.data` and nothing else (R2 fact 36).
 * `thread-id` is the flight key. `interruption-level` is `time-sensitive` only when the job says so
 * (decision 6, increment 15 decides) and `active` otherwise.
 *
 * FCM HTTP v1 (`POST /v1/projects/{id}/messages:send`, R1 F31 and F33):
 *
 *   { message: { token, notification: { title, body },
 *                data: { v, kind, flightSubscriptionId, tag, channelId },
 *                android: { priority, ttl, notification: { channel_id, tag } } } }
 *
 * `data` is flat strings with no `body` key (expo-notifications would read a `data.body` JSON
 * string as its own format, R2 fact 37) and repeats `tag` and `channelId` for its foreground path
 * (R2 fact 39). The tag is the APNs collapse id, so a redelivered push replaces the first on both
 * platforms. `ttl` runs to `expiresAt`.
 *
 * Every payload is at most 4,096 bytes: the schema bounds the text (100 and 400 UTF-16 units, six
 * bytes each at worst once JSON-escaped), and the transport refuses anything larger without
 * sending it (`PayloadTooLarge`).
 */

import {
  PUSH_DATA_VERSION,
  PUSH_PAYLOAD_LIMIT_BYTES,
  pushCollapseId,
  type PushEnvironment,
  type PushJobV1,
  type PushTargetV1,
} from '@planeahead/shared';

export const APNS_HOSTS: Readonly<Record<PushEnvironment, string>> = Object.freeze({
  sandbox: 'api.sandbox.push.apple.com',
  production: 'api.push.apple.com',
});

export const FCM_SEND_ORIGIN = 'https://fcm.googleapis.com';

/** FCM caps `ttl` at four weeks (R1 F33). */
export const FCM_MAX_TTL_SECONDS = 2_419_200;

/** A provider request without its bearer token. */
export interface PushHttpRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /**
   * The payload's size in bytes, the figure the 4,096-byte limits are about: the whole body for
   * APNs (the token rides in the path), the `notification` and `data` objects for FCM (the token
   * and the Android options are not payload).
   */
  readonly payloadBytes: number;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The app data of a target, every value a string (the APNs `body` dictionary). */
export function appData(job: PushJobV1, target: PushTargetV1): Record<string, string> {
  return {
    v: PUSH_DATA_VERSION,
    kind: job.notificationKind,
    ...(target.flightSubscriptionId === undefined
      ? {}
      : { flightSubscriptionId: target.flightSubscriptionId }),
  };
}

/** The APNs JSON payload. */
export function apnsPayload(job: PushJobV1, target: PushTargetV1): Record<string, unknown> {
  return {
    aps: {
      alert: { title: job.title, body: job.body },
      sound: 'default',
      ...(job.flightKey === undefined ? {} : { 'thread-id': job.flightKey }),
      'interruption-level': job.timeSensitive ? 'time-sensitive' : 'active',
    },
    body: appData(job, target),
  };
}

export function buildApnsRequest(job: PushJobV1, target: PushTargetV1): PushHttpRequest {
  const body = JSON.stringify(apnsPayload(job, target));
  return {
    url: `https://${APNS_HOSTS[target.environment]}/3/device/${encodeURIComponent(target.token)}`,
    headers: {
      'apns-topic': target.appId,
      'apns-push-type': 'alert',
      'apns-priority': job.priority === 'high' ? '10' : '5',
      'apns-expiration': String(Math.floor(Date.parse(job.expiresAt) / 1000)),
      'apns-collapse-id': pushCollapseId(job),
      'content-type': 'application/json',
    },
    body,
    payloadBytes: byteLength(body),
  };
}

/** Seconds from `nowMs` to the job's `expiresAt`, clamped to FCM's range. */
export function fcmTtlSeconds(job: PushJobV1, nowMs: number): number {
  const remaining = Math.floor((Date.parse(job.expiresAt) - nowMs) / 1000);
  return Math.min(FCM_MAX_TTL_SECONDS, Math.max(0, remaining));
}

/** The FCM HTTP v1 request body (`{ message }`). */
export function fcmMessage(
  job: PushJobV1,
  target: PushTargetV1,
  nowMs: number,
): Record<string, unknown> {
  const tag = pushCollapseId(job);
  return {
    message: {
      token: target.token,
      notification: { title: job.title, body: job.body },
      data: { ...appData(job, target), tag, channelId: job.channelId },
      android: {
        priority: job.priority,
        ttl: `${String(fcmTtlSeconds(job, nowMs))}s`,
        notification: { channel_id: job.channelId, tag },
      },
    },
  };
}

export function buildFcmRequest(
  job: PushJobV1,
  target: PushTargetV1,
  projectId: string,
  nowMs: number,
): PushHttpRequest {
  const message = fcmMessage(job, target, nowMs);
  const { notification, data } = message['message'] as { notification: unknown; data: unknown };
  return {
    url: `${FCM_SEND_ORIGIN}/v1/projects/${encodeURIComponent(projectId)}/messages:send`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message),
    payloadBytes: byteLength(JSON.stringify({ notification, data })),
  };
}

/** Whether a built request is within the provider's payload limit. */
export function withinPayloadLimit(request: PushHttpRequest): boolean {
  return request.payloadBytes <= PUSH_PAYLOAD_LIMIT_BYTES;
}
