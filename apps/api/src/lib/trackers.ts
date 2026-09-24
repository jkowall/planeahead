/**
 * How a route talks to a FlightTracker (increment 8).
 *
 * Three rules, all from the facts sheet:
 *
 *   - `locationHint` on EVERY `getByName`: it is honoured only on the first call that creates the
 *     object and ignored afterwards, so a call site that omits it could be the one that places a
 *     tracker for good. Every tracker call site in the Worker uses `enam` (ADR 0007).
 *   - Every call is awaited under the route's own deadline (`src/lib/deadline.ts`): there is no
 *     platform timeout on a Durable Object RPC while the caller stays connected.
 *   - Every answer is parsed with its versioned shared schema before it is read, so a Worker and a
 *     tracker one deploy apart still understand each other (increment 7, ruling J8).
 *
 * `subscribe` and `getState` on a tracker that holds no flight throw the typed
 * `RpcRequestError('invalid_request')`. Workers RPC serialises an error by name and message only,
 * so it is recognised here by the code the message starts with.
 */

import {
  ForceRefreshResponseV1,
  GetStateResponseV1,
  ListSubscribersResponseV1,
  RPC_SCHEMA_VERSION,
  SubscribeResponseV1,
  UnsubscribeResponseV1,
  type FlightKey,
  type ForceRefreshRequestV1,
  type SubscribeRequestV1,
  type UnsubscribeRequestV1,
} from '@planeahead/shared';
import type { Env } from '../env';

/** The one location hint every FlightTracker call site passes (persist, reconcile, resolver). */
export const TRACKER_LOCATION_HINT = 'enam' as const;

/** The tracker RPCs a route uses, narrowed so a test can hand in a slow or failing fake. */
export interface TrackerRpc {
  getState(): Promise<unknown>;
  subscribe(input: unknown): Promise<unknown>;
  unsubscribe(input: unknown): Promise<unknown>;
  forceRefresh(input: unknown): Promise<unknown>;
}

export type TrackerFor = (flightKey: FlightKey) => TrackerRpc;

/** `FLIGHT_TRACKER.getByName(key, { locationHint })`, the production resolver. */
export function defaultTrackerFor(env: Pick<Env, 'FLIGHT_TRACKER'>): TrackerFor {
  return (flightKey) =>
    env.FLIGHT_TRACKER.getByName(flightKey, { locationHint: TRACKER_LOCATION_HINT });
}

/** Whether a thrown RPC error is the tracker saying "I hold no flight". */
export function isAbsentTrackerError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.startsWith('invalid_request:') ||
      (error.name === 'RpcRequestError' && error.message.includes('not seeded')))
  );
}

export async function getTrackerState(tracker: TrackerRpc): Promise<GetStateResponseV1> {
  return GetStateResponseV1.parse(await tracker.getState());
}

export async function subscribeTracker(
  tracker: Pick<TrackerRpc, 'subscribe'>,
  request: Omit<SubscribeRequestV1, 'rpcVersion'>,
): Promise<SubscribeResponseV1> {
  return SubscribeResponseV1.parse(
    await tracker.subscribe({ ...request, rpcVersion: RPC_SCHEMA_VERSION }),
  );
}

export async function unsubscribeTracker(
  tracker: Pick<TrackerRpc, 'unsubscribe'>,
  request: Omit<UnsubscribeRequestV1, 'rpcVersion'>,
): Promise<UnsubscribeResponseV1> {
  return UnsubscribeResponseV1.parse(
    await tracker.unsubscribe({ ...request, rpcVersion: RPC_SCHEMA_VERSION }),
  );
}

export async function forceRefreshTracker(
  tracker: TrackerRpc,
  request: Omit<ForceRefreshRequestV1, 'rpcVersion'>,
): Promise<ForceRefreshResponseV1> {
  return ForceRefreshResponseV1.parse(
    await tracker.forceRefresh({ ...request, rpcVersion: RPC_SCHEMA_VERSION }),
  );
}

/**
 * The tracker RPCs the housekeeping subscriber reconciliation uses (increment 12): the new
 * `listSubscribers`, and the existing idempotent `subscribe` and `unsubscribe`. Separate from
 * `TrackerRpc` so the route fakes need no new method.
 */
export interface SubscriberListingTracker {
  listSubscribers(input: unknown): Promise<unknown>;
  subscribe(input: unknown): Promise<unknown>;
  unsubscribe(input: unknown): Promise<unknown>;
}

export async function listTrackerSubscribers(
  tracker: Pick<SubscriberListingTracker, 'listSubscribers'>,
): Promise<ListSubscribersResponseV1> {
  return ListSubscribersResponseV1.parse(
    await tracker.listSubscribers({ rpcVersion: RPC_SCHEMA_VERSION }),
  );
}
