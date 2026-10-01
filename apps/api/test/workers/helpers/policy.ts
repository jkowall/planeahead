/**
 * Helpers for the tests of the notification policy inside the FlightTracker (increment 15 and its
 * review rulings): scripted AeroDataBox answers with fields replaced, a tracker created through
 * the resolver, the next alarm run at its own time, and the outbox rows a test asserts on.
 */

import { runInDurableObject } from 'cloudflare:test';
import { expect } from 'vitest';
import { RPC_SCHEMA_VERSION } from '@planeahead/shared';
import {
  adbDateTime,
  adbFlightContract,
  ofKind,
  openBudgetFor,
  resolverHarness,
  scriptAdb,
  trackerHarness,
  type AdbFlightOptions,
  type TestFlight,
  type TrackerHarness,
} from './flights';
import type { FlightTracker } from '../../../src/do/flight-tracker';
import type { SnapshotKvValue } from '../../../src/kv/snapshot';

/** Fields of the on-time contract a scripted answer replaces (instants in epoch ms). */
export interface AnswerPatch {
  status?: string;
  departureRevisedMs?: number;
  departureRunwayMs?: number;
  arrivalRevisedMs?: number;
}

/** A scripted AeroDataBox answer: the on-time contract with fields replaced. */
export function answer(flight: TestFlight, options: AdbFlightOptions, patch: AnswerPatch = {}) {
  const body = adbFlightContract(flight, options) as Record<string, unknown>;
  const departure = { ...(body['departure'] as Record<string, unknown>) };
  const arrival = { ...(body['arrival'] as Record<string, unknown>) };
  const at = (ms: number, tz: string) => adbDateTime(new Date(ms), tz);
  if (patch.departureRevisedMs !== undefined) {
    departure['revisedTime'] = at(patch.departureRevisedMs, flight.originTz);
  }
  if (patch.departureRunwayMs !== undefined) {
    departure['runwayTime'] = at(patch.departureRunwayMs, flight.originTz);
  }
  if (patch.arrivalRevisedMs !== undefined) {
    arrival['revisedTime'] = at(patch.arrivalRevisedMs, 'Europe/London');
  }
  const status = patch.status ?? body['status'];
  return { status: 200, body: [{ ...body, departure, arrival, status }] };
}

/** Creates the tracker through the resolver at `clock`, the gateway answering `first`. */
export async function seeded(
  flight: TestFlight,
  clock: number,
  first = answer(flight, { phase: 'expected' }),
): Promise<TrackerHarness> {
  await scriptAdb(flight, [first]);
  const tracker = await trackerHarness(flight.flightKey, clock);
  await openBudgetFor(flight, clock);
  const resolver = await resolverHarness(flight, clock);
  const resolved = await resolver.stub.resolve({
    rpcVersion: RPC_SCHEMA_VERSION,
    designator: flight.designator,
    dateLocal: flight.dateLocal,
  });
  expect(resolved.outcome).toBe('resolved');
  return tracker;
}

/** Runs the pending alarm at its own time; returns that time. */
export async function nextAlarm(tracker: TrackerHarness): Promise<number> {
  const at = await tracker.alarmAt();
  expect(at).not.toBeNull();
  await tracker.setClock(at ?? 0);
  expect(await tracker.runAlarm()).toBe(true);
  return at ?? 0;
}

export interface FlightRowView {
  phase: string;
  version: number;
  finish_reason: string | null;
  policy_state: string | null;
}

export async function flightRow(tracker: TrackerHarness): Promise<FlightRowView | undefined> {
  const rows = await tracker.rows<Record<string, unknown>>(
    'SELECT phase, version, finish_reason, policy_state FROM flight',
  );
  return rows[0] as FlightRowView | undefined;
}

/** The stored policy state, parsed (the raw JSON the tracker keeps). */
export async function policyState(tracker: TrackerHarness): Promise<Record<string, unknown>> {
  return JSON.parse((await flightRow(tracker))?.policy_state ?? '{}') as Record<string, unknown>;
}

export const intentsOf = (tracker: TrackerHarness) => ofKind(tracker.outbox.sent, 'notify_intent');
export const instancesOf = (tracker: TrackerHarness) =>
  ofKind(tracker.outbox.sent, 'flight_instance');

/** The distinct `flight_event` payloads of one type the tracker sent (a re-send counts once). */
export function eventsOf(tracker: TrackerHarness, type: string) {
  const bySeq = new Map(
    ofKind(tracker.outbox.sent, 'flight_event').map((m) => [m.seq, m.payload] as const),
  );
  return [...bySeq.values()].filter((payload) => payload.type === type);
}

/**
 * Review ruling Q1: the tracker never sends two different instance payloads under one version
 * (persist keeps the first it sees). Re-sends of one outbox row (the same seq) are the same row.
 */
export function expectOnePayloadPerVersion(tracker: TrackerHarness): void {
  const byVersion = new Map<number, Set<string>>();
  const seen = new Set<number>();
  for (const message of instancesOf(tracker)) {
    if (seen.has(message.seq)) {
      continue;
    }
    seen.add(message.seq);
    const payloads = byVersion.get(message.payload.version) ?? new Set<string>();
    payloads.add(JSON.stringify(message.payload));
    byVersion.set(message.payload.version, payloads);
  }
  for (const [version, payloads] of byVersion) {
    expect({ version, payloads: payloads.size }).toEqual({ version, payloads: 1 });
  }
}

/**
 * Installs a KV seam that records every snapshot value the tracker writes, in order (the real
 * namespace would keep only the last). Returns the list it fills.
 */
export async function captureKv(tracker: TrackerHarness): Promise<SnapshotKvValue[]> {
  const written: SnapshotKvValue[] = [];
  await runInDurableObject(tracker.stub, (instance: FlightTracker) => {
    const kv: Pick<KVNamespace, 'put'> = {
      put: (_key: string, value: unknown) => {
        written.push(JSON.parse(String(value)) as SnapshotKvValue);
        return Promise.resolve();
      },
    };
    instance.kv = kv;
  });
  return written;
}

/** Settles the tracker's KV write in flight, so `captureKv`'s list is complete. */
export async function kvSettled(tracker: TrackerHarness): Promise<void> {
  await runInDurableObject(tracker.stub, (instance: FlightTracker) => instance.kvSettled());
}
