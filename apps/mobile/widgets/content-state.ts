/**
 * The flight Live Activity's data as ActivityKit stores it (ADR 0008).
 *
 * expo-widgets 57.0.20 declares ONE `ActivityAttributes` type for every Live Activity an app
 * has, `LiveActivityAttributes` (ios/Widgets/WidgetLiveActivity.swift):
 *
 * - static data (the attributes): `{ url?: string }`, the deep link passed to `start`;
 * - dynamic data (the content state): `{ name, props }`, where `name` picks the layout that
 *   `createLiveActivity(name, ...)` registered and `props` is the layout's props object
 *   JSON-encoded as a STRING (`LiveActivity.update` calls `JSON.stringify(props)`).
 *
 * So the shared `LiveActivityContentStateV1` is encoded twice on the wire: once into the `props`
 * string, and again when the content state itself is serialised (an APNs payload escapes every
 * quote of the inner JSON). Apple caps static plus dynamic data at 4 KB combined;
 * __tests__/content-state-size.test.ts measures the schema's worst case with both encodings
 * counted.
 *
 * A push that starts or updates this activity in Phase 1 names `LiveActivityAttributes` as its
 * `attributes-type` and carries exactly `encodeContentState(state, attributes)` as its
 * `content-state`. The encoder is the guard (increment 11 review, ruling Z2): it keeps only the
 * schema's own fields (the shared schema parses loosely, so a producer that spread a whole
 * `FlightStatus` into the state would otherwise ship its extra keys), validates every bound,
 * and throws rather than build a state ActivityKit would drop.
 */

import { LIVE_ACTIVITY_PAYLOAD_LIMIT_BYTES, LiveActivityContentStateV1 } from '@planeahead/shared';
import { z } from 'zod';

/** The layout name: `createLiveActivity`'s first argument and every content state's `name`. */
export const FLIGHT_ACTIVITY_NAME = 'FlightActivity';

/** expo-widgets' `LiveActivityAttributes`: the static data, fixed for the activity's life. */
export interface FlightActivityAttributes {
  readonly url?: string;
}

/** expo-widgets' `LiveActivityAttributes.ContentState`: the dynamic data. */
export interface EncodedContentState {
  readonly name: string;
  readonly props: string;
}

/** Static plus dynamic data that would reach ActivityKit's 4 KB limit. */
export class ContentStateTooLargeError extends Error {
  override readonly name = 'ContentStateTooLargeError';

  constructor(readonly bytes: number) {
    super(
      `Live Activity data is ${String(bytes)} bytes; ActivityKit accepts less than ` +
        `${String(LIVE_ACTIVITY_PAYLOAD_LIMIT_BYTES)}`,
    );
  }
}

/**
 * The shared schema's fields and nothing else: `z.object` strips unknown keys where the shared
 * `z.looseObject` keeps them. Parsing stays loose everywhere else.
 */
const EncodableContentState = z.object(LiveActivityContentStateV1.shape);

function encode(state: LiveActivityContentStateV1): EncodedContentState {
  return { name: FLIGHT_ACTIVITY_NAME, props: JSON.stringify(EncodableContentState.parse(state)) };
}

/** UTF-8 bytes of a value's JSON encoding. */
export function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** Static plus dynamic data, the quantity Apple's 4 KB limit applies to, as the encoder counts. */
export function activityDataBytes(
  attributes: FlightActivityAttributes,
  state: LiveActivityContentStateV1,
): number {
  return jsonBytes(attributes) + jsonBytes(encode(state));
}

/**
 * The content state ActivityKit stores for `state`, exactly as `start` and `update` build it,
 * with unknown keys stripped. `attributes` are the activity's static data, counted against the
 * same budget. Throws a ZodError for a field outside its bound and `ContentStateTooLargeError`
 * when static plus dynamic data would reach `LIVE_ACTIVITY_PAYLOAD_LIMIT_BYTES`.
 */
export function encodeContentState(
  state: LiveActivityContentStateV1,
  attributes: FlightActivityAttributes,
): EncodedContentState {
  const encoded = encode(state);
  const bytes = jsonBytes(attributes) + jsonBytes(encoded);
  if (bytes >= LIVE_ACTIVITY_PAYLOAD_LIMIT_BYTES) {
    throw new ContentStateTooLargeError(bytes);
  }
  return encoded;
}
