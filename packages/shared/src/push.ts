import { z } from 'zod';
import { FlightKeySchema } from './flight-key';
import { IsoInstantSchema } from './flight-status';
import { RPC_SCHEMA_VERSION } from './rpc';

/**
 * The push transport's wire contracts (increment 14): the `push` queue's job, the outcome message
 * the `push` consumer sends to `persist`, the app data every push carries, and the Durable Object
 * RPC of `PushAuth`. Every schema is a `looseObject` for the reason `outbox.ts` gives: a consumer
 * one release behind a producer keeps the fields it does not know. Nothing here reads a clock or
 * names a provider host; the API owns both (apps/api/src/push/).
 *
 * The rules these encode (docs/increments/14-push-transport.md):
 *
 * - A job is one notification's text and routing for at most `PUSH_JOB_MAX_TARGETS` device tokens
 *   (ruling P4, plan section 4). Every target names its `push_tokens` row and the subject (user id)
 *   its delivery row is keyed by. A target without a `notificationId` belongs to a TEST job: the
 *   admin page's "Send a test push" (ruling P8) records it under the job id with the test marker
 *   (ruling P5).
 * - Each target carries the number of sends made for it so far (`attempt`), so a retried target
 *   re-enqueued by the consumer carries its own history and `persist` orders outcomes by it.
 * - The collapse identifier is `{kind}:{flightKey}` (APNs `apns-collapse-id`, the Android `tag`),
 *   at most `COLLAPSE_ID_MAX_BYTES`: the flight key is bounded to `PUSH_FLIGHT_KEY_MAX_LENGTH` so
 *   the longest kind still fits. A job without a flight (a test push) collapses on its job id.
 * - App data is flat strings on both platforms (ruling P2): the APNs `body` dictionary carries
 *   `v`, `kind` and `flightSubscriptionId`; FCM `data` carries the same plus `tag` and `channelId`,
 *   and never a `body` key (expo-notifications reads a `data.body` JSON string as its own format).
 */

export const PUSH_SCHEMA_VERSION = 1;
const pushVersion = z.int().min(1).default(PUSH_SCHEMA_VERSION);

/** The device-token kinds the `push` queue sends to: `push_tokens.kind` values of device tokens. */
export const PUSH_TARGET_KINDS = ['apns', 'fcm'] as const;
export const PushTargetKindSchema = z.enum(PUSH_TARGET_KINDS);
export type PushTargetKind = z.infer<typeof PushTargetKindSchema>;

/**
 * The APNs environment a token was minted for; mirrors `PUSH_ENVIRONMENTS` in `@planeahead/db` (a
 * db test compares). No name in this module starts with the APNs or FCM env-var prefixes that
 * `SECRET_PATTERNS` flags in a client bundle: this package ships inside the app.
 */
export const PUSH_ENVIRONMENTS = ['sandbox', 'production'] as const;
export const PushEnvironmentSchema = z.enum(PUSH_ENVIRONMENTS);
export type PushEnvironment = z.infer<typeof PushEnvironmentSchema>;

/** The notification kinds; mirrors `NOTIFICATION_KINDS` in `@planeahead/db` (a db test compares). */
export const NOTIFICATION_KINDS = [
  'schedule_change',
  'gate_change',
  'delay',
  'cancellation',
  'diversion',
  'boarding',
  'departure',
  'arrival',
  'baggage',
  'reminder',
  'trip_share',
  'system',
] as const;
export const NotificationKindSchema = z.enum(NOTIFICATION_KINDS);
export type NotificationKind = z.infer<typeof NotificationKindSchema>;

/**
 * The notification permission state a client reports with its token (`push_tokens.permission`,
 * ruling P6): iOS `granted`, `provisional` (delivered quietly to Notification Center only), and
 * both platforms' `denied` and `undetermined`. An old client reports none, which is unknown.
 */
export const PUSH_PERMISSION_STATES = ['granted', 'provisional', 'denied', 'undetermined'] as const;
export const PushPermissionStateSchema = z.enum(PUSH_PERMISSION_STATES);
export type PushPermissionState = z.infer<typeof PushPermissionStateSchema>;

/**
 * The production bundle and package id (`app.planeahead.mobile` on both platforms): the app id of
 * a registration that names none, which is every client before increment 16 (ruling P6).
 */
export const PRODUCTION_APP_ID = 'app.planeahead.mobile';

/**
 * A bundle id or Android package name, the APNs topic of a token: dot-separated labels of
 * letters, digits, `-` and `_`, at least two labels. Apple allows 155 characters in a bundle id.
 */
export const APP_ID_RE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/;
export const APP_ID_MAX_LENGTH = 155;
export const AppIdSchema = z.string().max(APP_ID_MAX_LENGTH).regex(APP_ID_RE, {
  message: 'appId must be a bundle id or package name (e.g. app.planeahead.mobile)',
});

/**
 * APNs refuses a notification payload over 4 KB (4,096 bytes of uncompressed JSON), and FCM a
 * message over 4,096 bytes (`INVALID_ARGUMENT`); one bound serves both.
 */
export const PUSH_PAYLOAD_LIMIT_BYTES = 4096;
/** APNs: `apns-collapse-id` "must not exceed 64 bytes"; the Android tag uses the same value. */
export const COLLAPSE_ID_MAX_BYTES = 64;
/** Up to 50 targets per job (about 13 KB), so at most 18 jobs fit one 256 KB `sendBatch`. */
export const PUSH_JOB_MAX_TARGETS = 50;
/** Bounds that keep every job's payloads under 4,096 bytes on both platforms, escapes included. */
export const PUSH_TITLE_MAX_LENGTH = 100;
export const PUSH_BODY_MAX_LENGTH = 400;
/** The longest flight key a push names: the longest kind plus `:` plus this is 64 bytes. */
export const PUSH_FLIGHT_KEY_MAX_LENGTH = 48;
/** An Android notification channel id as the app creates it (increment 16 fixes the names). */
export const ANDROID_CHANNEL_ID_RE = /^[a-z][a-z0-9_]{0,39}$/;
/** A reason on an outcome: a provider's reason or error code, or one of the consumer's own. */
export const PUSH_REASON_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** One device token a job sends to. */
export const PushTargetV1 = z.looseObject({
  /** `push_tokens.id`: the row an outcome records against and may invalidate. */
  pushTokenId: z.uuid(),
  /** The token owner's user id: `notification_deliveries.subject_id`. */
  subjectId: z.uuid(),
  kind: PushTargetKindSchema,
  /** Opaque: lowercase hex for APNs; an FCM registration token (a FID later, R1 F34). */
  token: z.string().min(8).max(4096),
  /** The APNs environment the token was minted for (the host); FCM ignores it. */
  environment: PushEnvironmentSchema,
  /** The bundle or package id: the `apns-topic`. */
  appId: AppIdSchema,
  /** `notifications.id` of the user's inbox row; absent only on a test job. */
  notificationId: z.uuid().optional(),
  /** The user's subscription, the id the app routes a tap to (plan section 4). */
  flightSubscriptionId: z.uuid().optional(),
  /** Sends already made for this target, before this delivery of the job. */
  attempt: z.int().min(0).max(1000).default(0),
});
export type PushTargetV1 = z.infer<typeof PushTargetV1>;
export type PushTargetV1Input = z.input<typeof PushTargetV1>;

export const PUSH_PRIORITIES = ['high', 'normal'] as const;

/**
 * One `push` queue message. `notify` builds these from 15 on; the admin page builds a test job.
 * `expiresAt` ends the relevance window (decision 7): it is the APNs `apns-expiration` and the
 * FCM `ttl`, and a target is dropped once it passes. `timeSensitive` asks for the time-sensitive
 * interruption level, which increment 15 decides (decision 6); the default is `active`.
 */
export const PushJobV1 = z
  .looseObject({
    pushVersion,
    kind: z.literal('push_job'),
    jobId: z.uuid(),
    /** A test job (ruling P8): recorded under the job id, marked as a test. */
    test: z.boolean().default(false),
    notificationKind: NotificationKindSchema,
    flightKey: FlightKeySchema.refine((key) => key.length <= PUSH_FLIGHT_KEY_MAX_LENGTH, {
      message: `a pushed flight key has at most ${String(PUSH_FLIGHT_KEY_MAX_LENGTH)} characters`,
    }).optional(),
    title: z.string().min(1).max(PUSH_TITLE_MAX_LENGTH),
    body: z.string().min(1).max(PUSH_BODY_MAX_LENGTH),
    priority: z.enum(PUSH_PRIORITIES).default('high'),
    timeSensitive: z.boolean().default(false),
    channelId: z.string().regex(ANDROID_CHANNEL_ID_RE),
    expiresAt: IsoInstantSchema,
    targets: z.array(PushTargetV1).min(1).max(PUSH_JOB_MAX_TARGETS),
  })
  .superRefine((job, ctx) => {
    const seen = new Set<string>();
    for (const [index, target] of job.targets.entries()) {
      if (seen.has(target.pushTokenId)) {
        ctx.addIssue({
          code: 'custom',
          message: 'a job names each push token once',
          path: ['targets', index, 'pushTokenId'],
        });
      }
      seen.add(target.pushTokenId);
      if (!job.test && target.notificationId === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'only a test job may carry a target without a notificationId',
          path: ['targets', index, 'notificationId'],
        });
      }
    }
  });
export type PushJobV1 = z.infer<typeof PushJobV1>;
/** What a producer builds; the defaults (`pushVersion`, `test`, `priority`, ...) may be left out. */
export type PushJobV1Input = z.input<typeof PushJobV1>;

/**
 * What the consumer decided for one target in one delivery of a job. The first four are the
 * transport's mapping of a provider response (ruling P1); `not_configured` is a hold because the
 * platform's credentials are absent (ruling P7), and `expired` a drop past the job's `expiresAt`
 * (ruling P4, decision 7), before a send or instead of a retry that would land after it.
 */
export const PUSH_OUTCOMES = [
  'sent',
  'retry',
  'invalid_token',
  'failed',
  'not_configured',
  'expired',
] as const;
export const PushOutcomeSchema = z.enum(PUSH_OUTCOMES);
export type PushOutcome = z.infer<typeof PushOutcomeSchema>;

/** Which `details[]` entry an FCM error carried (R1 F35): an FCM error or a payload violation. */
export const PUSH_ERROR_DETAILS = ['FcmError', 'BadRequest'] as const;

/** One target's result, as the outcome message carries it to `persist`. */
export const PushTargetResultV1 = z.looseObject({
  pushTokenId: z.uuid(),
  subjectId: z.uuid(),
  kind: PushTargetKindSchema,
  environment: PushEnvironmentSchema,
  appId: AppIdSchema,
  notificationId: z.uuid().optional(),
  /** Sends made for this target so far, this delivery's own included when `requested`. */
  attempt: z.int().min(0).max(1000),
  /** Whether this delivery of the job sent a request for the target. */
  requested: z.boolean(),
  outcome: PushOutcomeSchema,
  /** The provider's reason or error code, or the consumer's own (`timeout`, `expired`, ...). */
  reason: z.string().regex(PUSH_REASON_RE).nullable(),
  httpStatus: z.int().min(100).max(599).nullable(),
  /** `sent`: the `apns-id` or the FCM message name. */
  providerId: z.string().min(1).max(256).nullable(),
  /** APNs 410 only: when APNs confirmed the token was no longer valid for the topic. */
  apnsTimestampMs: z.int().nonnegative().nullable(),
  fcmErrorDetail: z.enum(PUSH_ERROR_DETAILS).nullable(),
  /** `retry` only: the delay the consumer re-enqueued the target with. */
  retryDelaySeconds: z.int().nonnegative().nullable(),
  at: IsoInstantSchema,
});
export type PushTargetResultV1 = z.infer<typeof PushTargetResultV1>;

/**
 * The `persist` message kind the `push` consumer sends after each job (ruling P4), so `persist`
 * stays the only Postgres writer: one delivery row per notification and token, and the dead-token
 * invalidations of ruling P5.
 */
export const PushOutcomeMessageV1 = z.looseObject({
  pushVersion,
  kind: z.literal('push_outcome'),
  jobId: z.uuid(),
  test: z.boolean(),
  results: z.array(PushTargetResultV1).min(1).max(PUSH_JOB_MAX_TARGETS),
});
export type PushOutcomeMessageV1 = z.infer<typeof PushOutcomeMessageV1>;

/** The app data a push carries (APNs `body` dictionary, FCM `data`), every value a string. */
export const PUSH_DATA_VERSION = '1';
export const PushDataV1 = z.looseObject({
  v: z.literal(PUSH_DATA_VERSION),
  kind: NotificationKindSchema,
  flightSubscriptionId: z.uuid().optional(),
  /** FCM only: the tag, repeated for expo-notifications' foreground path (R2 fact 39). */
  tag: z.string().optional(),
  /** FCM only: the channel, repeated for the same reason. */
  channelId: z.string().optional(),
});
export type PushDataV1 = z.infer<typeof PushDataV1>;

/**
 * The collapse identifier of a job: `{kind}:{flightKey}`, or `{kind}:{jobId}` for a job that names
 * no flight. Pure; the schema bounds keep it within `COLLAPSE_ID_MAX_BYTES`.
 */
export function pushCollapseId(job: {
  readonly notificationKind: NotificationKind;
  readonly flightKey?: string | undefined;
  readonly jobId: string;
}): string {
  return `${job.notificationKind}:${job.flightKey ?? job.jobId}`;
}

/** The three `PushAuth` objects (ruling P3): one per APNs environment, one for FCM. */
export const PUSH_CREDENTIAL_NAMES = ['apns:sandbox', 'apns:production', 'fcm'] as const;
export const PushCredentialNameSchema = z.enum(PUSH_CREDENTIAL_NAMES);
export type PushCredentialName = z.infer<typeof PushCredentialNameSchema>;

/** The `PushAuth` object that holds a target's credential. */
export function pushCredentialName(
  kind: PushTargetKind,
  environment: PushEnvironment,
): PushCredentialName {
  return kind === 'fcm' ? 'fcm' : environment === 'sandbox' ? 'apns:sandbox' : 'apns:production';
}

const rpcVersion = z.int().min(1).default(RPC_SCHEMA_VERSION);

/** `PushAuth.current` and `PushAuth.status`: the credential an object holds. */
export const PushCredentialRequestV1 = z.looseObject({
  rpcVersion,
  name: PushCredentialNameSchema,
});
export type PushCredentialRequestV1 = z.infer<typeof PushCredentialRequestV1>;

/** `PushAuth.expire`: a provider refused this token; drop it unless a newer one replaced it. */
export const PushCredentialExpireRequestV1 = z.looseObject({
  rpcVersion,
  name: PushCredentialNameSchema,
  token: z.string().min(1),
});
export type PushCredentialExpireRequestV1 = z.infer<typeof PushCredentialExpireRequestV1>;

/**
 * Why `PushAuth.current` has no token: the secrets are absent or malformed (`not_configured`),
 * the key or the service account is unusable or refused (`credentials_rejected`), or the FCM token
 * exchange could not complete (`exchange_unavailable`, worth a retry).
 */
export const PUSH_CREDENTIAL_FAILURES = [
  'not_configured',
  'credentials_rejected',
  'exchange_unavailable',
] as const;
export type PushCredentialFailure = (typeof PUSH_CREDENTIAL_FAILURES)[number];
