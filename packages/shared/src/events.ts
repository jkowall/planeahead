import { z } from 'zod';
import { IsoInstantSchema } from './flight-status';

/**
 * First-party product analytics, `POST /v1/events` (increment 12; ADR 0005 item 4).
 *
 * The wire shape is the one the increment 9 mobile client already sends
 * (apps/mobile/src/lib/analytics.ts): `{ analyticsId, events: [{ name, at, props? }] }`, with NO
 * session cookie and NO `X-Install-Id`. `analyticsId` is the install-scoped analytics id, a random
 * v4 UUID kept apart from the install id so an event can never be joined to an account on our
 * side. The API writes one Analytics Engine point per accepted event (`PRODUCT_EVENTS`, index =
 * the analytics id, blobs = name, environment, props, client time) and answers 202.
 *
 * Validation is two-level so an older API never refuses a newer app's whole batch: the envelope
 * (`ProductEventsBatchV1`) is validated as a unit and a bad envelope is 400 `validation_failed`;
 * each element is then validated on its own against `ProductEventV1`, whose `name` must be one of
 * `PRODUCT_EVENT_NAMES`, and an element that fails (an event this build does not know, a props
 * bag over its caps) is dropped and counted, never stored.
 */

/** The events the API accepts. Adding a name is additive; renaming one is a breaking change. */
export const PRODUCT_EVENT_NAMES = ['app_open', 'app_foreground'] as const;
export const ProductEventNameSchema = z.enum(PRODUCT_EVENT_NAMES);
export type ProductEventName = z.infer<typeof ProductEventNameSchema>;

/** The most events one batch may carry: the mobile client's own queue bound (`MAX_QUEUE`). */
export const PRODUCT_EVENTS_MAX_BATCH = 100;
/** Keys in one event's `props` bag. */
export const PRODUCT_EVENT_PROPS_MAX_KEYS = 16;
/** The props bag serialised as JSON, in UTF-8 bytes. */
export const PRODUCT_EVENT_PROPS_MAX_BYTES = 1_024;
/** One string value in the props bag, in characters. */
export const PRODUCT_EVENT_PROP_VALUE_MAX_LENGTH = 200;
/** The whole request body, in bytes (100 events at the props cap fit with room to spare). */
export const PRODUCT_EVENTS_MAX_BODY_BYTES = 256 * 1_024;

const PROP_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const encoder = new TextEncoder();

/** A flat bag of scalars under the key, count and size caps. */
export const ProductEventPropsSchema = z
  .record(
    z.string().regex(PROP_KEY_RE, 'prop keys are snake_case, at most 40 characters'),
    z.union([
      z.string().max(PRODUCT_EVENT_PROP_VALUE_MAX_LENGTH),
      z.number(),
      z.boolean(),
      z.null(),
    ]),
  )
  .refine((props) => Object.keys(props).length <= PRODUCT_EVENT_PROPS_MAX_KEYS, {
    message: `at most ${String(PRODUCT_EVENT_PROPS_MAX_KEYS)} props per event`,
  })
  .refine(
    (props) => encoder.encode(JSON.stringify(props)).length <= PRODUCT_EVENT_PROPS_MAX_BYTES,
    { message: `props must serialise to at most ${String(PRODUCT_EVENT_PROPS_MAX_BYTES)} bytes` },
  );
export type ProductEventProps = z.infer<typeof ProductEventPropsSchema>;

/** One event, validated on its own: an unknown name or an oversized bag drops only this event. */
export const ProductEventV1 = z.looseObject({
  name: ProductEventNameSchema,
  /** The client's clock, ISO-8601; Analytics Engine stamps its own receive time as well. */
  at: IsoInstantSchema,
  props: ProductEventPropsSchema.optional(),
});
export type ProductEventV1 = z.infer<typeof ProductEventV1>;

/** The envelope; `events` elements are checked one by one with `ProductEventV1`. */
export const ProductEventsBatchV1 = z.looseObject({
  /** The install-scoped analytics id (ADR 0005), never the install id or a user id. */
  analyticsId: z.uuid(),
  events: z.array(z.unknown()).min(1).max(PRODUCT_EVENTS_MAX_BATCH),
});
export type ProductEventsBatchV1 = z.infer<typeof ProductEventsBatchV1>;

/** The 202 body. */
export const ProductEventsAcceptedV1 = z.object({
  accepted: z.int().nonnegative(),
  dropped: z.int().nonnegative(),
});
export type ProductEventsAcceptedV1 = z.infer<typeof ProductEventsAcceptedV1>;

/** `blob1` to `blob4` of a `PRODUCT_EVENTS` point, in order (append only, like the call point). */
export const PRODUCT_EVENT_POINT_BLOBS = ['name', 'environment', 'props', 'client_at'] as const;

export interface ProductEventPoint {
  indexes: [string];
  blobs: string[];
  doubles: number[];
}

/** The Analytics Engine point for one accepted event. */
export function productEventPoint(
  analyticsId: string,
  event: ProductEventV1,
  environment: string,
): ProductEventPoint {
  return {
    indexes: [analyticsId],
    blobs: [
      event.name,
      environment,
      event.props === undefined ? '' : JSON.stringify(event.props),
      event.at,
    ],
    doubles: [1],
  };
}
