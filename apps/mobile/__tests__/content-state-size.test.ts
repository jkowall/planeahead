/**
 * The flight Live Activity's data against Apple's 4 KB budget (increment 11, ruling V4, ADR
 * 0008).
 *
 * ActivityKit caps a Live Activity's static plus dynamic data at 4 KB combined
 * (https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities).
 * expo-widgets stores the dynamic data as `{ name, props }` with the props JSON-encoded into a
 * STRING, so the shared `LiveActivityContentStateV1` is encoded twice: every quote of the inner
 * JSON is escaped again when the content state is serialised. This measures a worst-case flight
 * (every field set, the longest flight key the key grammar allows, generous gate, terminal and
 * baggage strings, millisecond instants, a long float) through the real encoder, and the push
 * that would carry it in Phase 1.
 */

import { LIVE_ACTIVITY_PAYLOAD_LIMIT_BYTES, LiveActivityContentStateV1 } from '@planeahead/shared';
import {
  FLIGHT_ACTIVITY_NAME,
  activityDataBytes,
  encodeContentState,
  jsonBytes,
  type FlightActivityAttributes,
} from '../widgets/content-state';
import { WORST_CASE_CONTENT_STATE as WORST_CASE } from './support/live-activity-fixtures';

/** The static data: the deep link `start` would pass (planeahead://flight/<uuid v7>). */
const ATTRIBUTES: FlightActivityAttributes = {
  url: 'planeahead://flight/0199f1e2-3a4b-7c5d-8e6f-7a8b9c0d1e2f',
};

describe('Live Activity content state size', () => {
  it('encodes as expo-widgets stores it: the layout name and the state as a JSON string', () => {
    const encoded = encodeContentState(WORST_CASE);
    expect(encoded.name).toBe(FLIGHT_ACTIVITY_NAME);
    expect(typeof encoded.props).toBe('string');
    expect(LiveActivityContentStateV1.parse(JSON.parse(encoded.props))).toEqual(WORST_CASE);
  });

  it('counts the double encoding: the stored state is larger than the state itself', () => {
    const once = jsonBytes(WORST_CASE);
    const twice = jsonBytes(encodeContentState(WORST_CASE));
    const quotes = JSON.stringify(WORST_CASE).split('"').length - 1;
    // Each inner quote gains a backslash; the wrapper adds the name and the outer quotes.
    expect(twice).toBe(once + quotes + jsonBytes({ name: FLIGHT_ACTIVITY_NAME, props: '' }));
  });

  it('keeps static plus dynamic data of a worst-case flight under 4 KB, with room to spare', () => {
    const bytes = activityDataBytes(ATTRIBUTES, WORST_CASE);
    expect(LIVE_ACTIVITY_PAYLOAD_LIMIT_BYTES).toBe(4_096);
    expect(bytes).toBeLessThan(LIVE_ACTIVITY_PAYLOAD_LIMIT_BYTES);
    // 693 bytes when written (ADR 0008): 533 for the state, 627 once stored, 66 static.
    expect(bytes).toBeLessThan(LIVE_ACTIVITY_PAYLOAD_LIMIT_BYTES / 4);
  });

  it('fits the Phase 1 push-to-start payload that carries the same state, alert included', () => {
    const push = {
      aps: {
        timestamp: 1_798_761_599,
        event: 'start',
        'attributes-type': 'LiveActivityAttributes',
        attributes: ATTRIBUTES,
        'content-state': encodeContentState(WORST_CASE),
        'stale-date': 1_798_765_199,
        'relevance-score': 100,
        alert: {
          title: 'AAL9999A is cancelled',
          body: 'Your flight from JFK to SIN on 31 December is cancelled.',
        },
      },
    };
    expect(jsonBytes(push)).toBeLessThan(LIVE_ACTIVITY_PAYLOAD_LIMIT_BYTES);
  });
});
