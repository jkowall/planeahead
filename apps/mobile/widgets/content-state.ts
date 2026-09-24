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
 * __tests__/content-state-size.test.ts measures a worst-case flight with both encodings counted.
 *
 * A push that starts or updates this activity in Phase 1 names `LiveActivityAttributes` as its
 * `attributes-type` and carries exactly `encodeContentState(state)` as its `content-state`.
 */

import type { LiveActivityContentStateV1 } from '@planeahead/shared';

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

/** The content state ActivityKit stores for `state`, exactly as `start` and `update` build it. */
export function encodeContentState(state: LiveActivityContentStateV1): EncodedContentState {
  return { name: FLIGHT_ACTIVITY_NAME, props: JSON.stringify(state) };
}

/** UTF-8 bytes of a value's JSON encoding. */
export function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** Static plus dynamic data, the quantity Apple's 4 KB limit applies to. */
export function activityDataBytes(
  attributes: FlightActivityAttributes,
  state: LiveActivityContentStateV1,
): number {
  return jsonBytes(attributes) + jsonBytes(encodeContentState(state));
}
