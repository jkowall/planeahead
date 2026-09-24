/**
 * The flight Live Activity's data against Apple's 4 KB budget (increment 11, ruling V4; review
 * ruling Z2; ADR 0008).
 *
 * ActivityKit caps a Live Activity's static plus dynamic data at 4 KB combined
 * (https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities).
 * expo-widgets stores the dynamic data as `{ name, props }` with the props JSON-encoded into a
 * STRING, so the shared `LiveActivityContentStateV1` is encoded twice: every escape of the inner
 * JSON is escaped again when the content state is serialised.
 *
 * Every field of the schema is bounded, so it has a real worst case: each field at its bound and
 * each free-text field filled with the character that costs the most once encoded twice. This
 * test proves that character is the costliest of all 65,536 UTF-16 code units, measures the
 * worst case through the real encoder, and checks the encoder's guard: unknown keys stripped, a
 * field over its bound or data over the budget refused.
 */

import {
  LIVE_ACTIVITY_FIELD_MAX_LENGTH as MAX,
  LIVE_ACTIVITY_PAYLOAD_LIMIT_BYTES,
  LiveActivityContentStateV1,
} from '@planeahead/shared';
import {
  ContentStateTooLargeError,
  FLIGHT_ACTIVITY_NAME,
  activityDataBytes,
  encodeContentState,
  jsonBytes,
  type FlightActivityAttributes,
} from '../widgets/content-state';
import {
  COSTLIEST_CHARACTER,
  LONGEST_PROGRESS,
  MINIMAL_CONTENT_STATE,
  QUOTE_HEAVY_CONTENT_STATE,
  WORST_CASE_CONTENT_STATE as WORST_CASE,
} from './support/live-activity-fixtures';

/** The static data: the deep link `start` would pass (planeahead://flight/<uuid v7>). */
const ATTRIBUTES: FlightActivityAttributes = {
  url: 'planeahead://flight/0199f1e2-3a4b-7c5d-8e6f-7a8b9c0d1e2f',
};

/** Bytes one piece of text adds to the stored content state (both encodings). */
function doubleEncodedCost(text: string): number {
  return jsonBytes(JSON.stringify(text)) - jsonBytes(JSON.stringify(''));
}

describe('Live Activity content state size', () => {
  it('fills the worst case with the costliest character there is', () => {
    const cost = doubleEncodedCost(COSTLIEST_CHARACTER);
    expect(cost).toBe(7);
    expect(doubleEncodedCost('"')).toBe(4);
    let costliest = 0;
    for (let unit = 0; unit <= 0xffff; unit += 1) {
      costliest = Math.max(costliest, doubleEncodedCost(String.fromCharCode(unit)));
    }
    expect(costliest).toBe(cost);
    // And every other field is at its bound.
    expect(WORST_CASE.flightKey).toHaveLength(MAX.flightKey);
    expect(WORST_CASE.designator).toHaveLength(MAX.designator);
    expect(WORST_CASE.gate).toHaveLength(MAX.gate);
    expect(WORST_CASE.destinationGate).toHaveLength(MAX.gate);
    expect(WORST_CASE.terminal).toHaveLength(MAX.terminal);
    expect(WORST_CASE.destinationTerminal).toHaveLength(MAX.terminal);
    expect(WORST_CASE.baggageClaim).toHaveLength(MAX.baggageClaim);
    for (const instant of [WORST_CASE.scheduledOut, WORST_CASE.updatedAt]) {
      expect(instant).toHaveLength(MAX.instant);
    }
    expect(JSON.stringify(LONGEST_PROGRESS)).toHaveLength(24);
    const keys = Object.keys(LiveActivityContentStateV1.shape).sort();
    expect(Object.keys(WORST_CASE).sort()).toEqual(keys);
  });

  it('encodes as expo-widgets stores it: the layout name and the state as a JSON string', () => {
    const encoded = encodeContentState(WORST_CASE, ATTRIBUTES);
    expect(encoded.name).toBe(FLIGHT_ACTIVITY_NAME);
    expect(typeof encoded.props).toBe('string');
    expect(LiveActivityContentStateV1.parse(JSON.parse(encoded.props))).toEqual(WORST_CASE);
  });

  it('counts the double encoding: the stored state is larger than the state itself', () => {
    const state = QUOTE_HEAVY_CONTENT_STATE;
    const once = jsonBytes(state);
    const twice = jsonBytes(encodeContentState(state, ATTRIBUTES));
    const escapes = JSON.stringify(state).match(/["\\]/g)?.length ?? 0;
    // Each quote and backslash of the inner JSON gains a backslash; the wrapper adds the name and
    // the outer quotes.
    expect(twice).toBe(once + escapes + jsonBytes({ name: FLIGHT_ACTIVITY_NAME, props: '' }));
  });

  it("keeps static plus dynamic data of the schema's worst case under 4 KB", () => {
    const bytes = activityDataBytes(ATTRIBUTES, WORST_CASE);
    expect(LIVE_ACTIVITY_PAYLOAD_LIMIT_BYTES).toBe(4_096);
    // 1,659 bytes when written (ADR 0008): 1,355 for the state, 1,593 once stored, 66 static.
    // The quote-heavy shape of the review's probe comes to 1,251.
    expect(bytes).toBeLessThan(LIVE_ACTIVITY_PAYLOAD_LIMIT_BYTES / 2);
    expect(activityDataBytes(ATTRIBUTES, QUOTE_HEAVY_CONTENT_STATE)).toBeLessThan(bytes);
  });

  it('fits the Phase 1 push-to-start payload that carries the same state, alert included', () => {
    const push = {
      aps: {
        timestamp: 1_798_761_599,
        event: 'start',
        'attributes-type': 'LiveActivityAttributes',
        attributes: ATTRIBUTES,
        'content-state': encodeContentState(WORST_CASE, ATTRIBUTES),
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

  it('strips keys the schema does not know, which the loose parse keeps', () => {
    const spread = LiveActivityContentStateV1.parse({
      ...MINIMAL_CONTENT_STATE,
      providerRefs: { aeroapi: 'x'.repeat(3_000) },
      fieldQuality: {},
    });
    expect(spread).toHaveProperty('providerRefs');
    const props = JSON.parse(encodeContentState(spread, ATTRIBUTES).props) as object;
    expect(props).not.toHaveProperty('providerRefs');
    expect(props).not.toHaveProperty('fieldQuality');
    expect(props).toEqual(JSON.parse(JSON.stringify(MINIMAL_CONTENT_STATE)));
  });

  it('refuses a field over its bound and data that would reach the 4 KB limit', () => {
    const tooLong = {
      ...MINIMAL_CONTENT_STATE,
      baggageClaim: 'B'.repeat(MAX.baggageClaim + 1),
    } as LiveActivityContentStateV1;
    expect(() => encodeContentState(tooLong, ATTRIBUTES)).toThrow(/baggageClaim|32/);

    const hugeAttributes = { url: `planeahead://flight/${'x'.repeat(4_000)}` };
    expect(() => encodeContentState(MINIMAL_CONTENT_STATE, hugeAttributes)).toThrow(
      ContentStateTooLargeError,
    );
    // Exactly at the limit is already too much: ActivityKit wants less than 4 KB.
    const room =
      LIVE_ACTIVITY_PAYLOAD_LIMIT_BYTES - activityDataBytes({ url: '' }, MINIMAL_CONTENT_STATE);
    expect(() => encodeContentState(MINIMAL_CONTENT_STATE, { url: 'x'.repeat(room) })).toThrow(
      ContentStateTooLargeError,
    );
    expect(() =>
      encodeContentState(MINIMAL_CONTENT_STATE, { url: 'x'.repeat(room - 1) }),
    ).not.toThrow();
  });
});
