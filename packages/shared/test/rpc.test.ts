import { describe, expect, it } from 'vitest';
import { FLIGHT_STATUS_VALUES, ProviderEventSchema } from '../src/flight-status';
import {
  ForceRefreshRequestV1,
  GetStateResponseV1,
  ProviderEventV1,
  RPC_SCHEMA_VERSION,
  SubscribeRequestV1,
  SubscribeResponseV1,
  TRACKER_PHASES,
  TrackerPhaseSchema,
  UnsubscribeRequestV1,
} from '../src/rpc';
import { AA100_INPUT } from './fixtures';

const SUBSCRIPTION_ID = '019968a7-4e00-7000-8000-000000000001';
const KEY = 'AAL-100-2026-09-19-KJFK';

describe('rpc schemas', () => {
  it('is at schema version 1', () => {
    expect(RPC_SCHEMA_VERSION).toBe(1);
  });

  it('tracker phases are the flight statuses plus finished; an unknown phase degrades to unknown', () => {
    expect(TRACKER_PHASES).toEqual([...FLIGHT_STATUS_VALUES, 'finished']);
    expect(TrackerPhaseSchema.parse('finished')).toBe('finished');
    expect(TrackerPhaseSchema.parse('merged')).toBe('unknown');
  });

  it('every request and response carries rpcVersion, defaulting to RPC_SCHEMA_VERSION', () => {
    expect(
      SubscribeRequestV1.parse({ subscriptionId: SUBSCRIPTION_ID, userId: 'u' }).rpcVersion,
    ).toBe(RPC_SCHEMA_VERSION);
    expect(UnsubscribeRequestV1.parse({ subscriptionId: SUBSCRIPTION_ID }).rpcVersion).toBe(1);
    expect(SubscribeResponseV1.parse({ status: 'already', flightKey: KEY }).rpcVersion).toBe(1);
    expect(ForceRefreshRequestV1.parse({ reason: 'manual', rpcVersion: 2 }).rpcVersion).toBe(2);
    expect(ForceRefreshRequestV1.safeParse({ reason: 'manual', rpcVersion: 0 }).success).toBe(
      false,
    );
    expect(
      GetStateResponseV1.parse({
        flightKey: KEY,
        phase: 'finished',
        snapshot: null,
        nextRefreshAt: null,
        doSchemaVersion: 3,
        subscriberCount: 0,
      }).rpcVersion,
    ).toBe(1);
  });

  it('SubscribeRequestV1 needs a UUID subscription id and a user id', () => {
    const parsed = SubscribeRequestV1.parse({
      subscriptionId: SUBSCRIPTION_ID,
      userId: 'user-1',
      muted: true,
      overrides: { events: ['gate_change'], extra: true },
      futureField: 1,
    });
    expect(parsed.muted).toBe(true);
    expect(parsed).toHaveProperty('futureField', 1);
    expect(parsed.overrides).toHaveProperty('extra', true);
    expect(SubscribeRequestV1.safeParse({ subscriptionId: 'sub-1', userId: 'u' }).success).toBe(
      false,
    );
    expect(
      SubscribeRequestV1.safeParse({ subscriptionId: SUBSCRIPTION_ID, userId: '' }).success,
    ).toBe(false);
  });

  it('SubscribeResponseV1 constrains the status and validates the key', () => {
    expect(
      SubscribeResponseV1.parse({ status: 'already', flightKey: KEY }).snapshotEtag,
    ).toBeUndefined();
    expect(SubscribeResponseV1.safeParse({ status: 'ok', flightKey: KEY }).success).toBe(false);
    expect(
      SubscribeResponseV1.safeParse({ status: 'subscribed', flightKey: 'AA100' }).success,
    ).toBe(false);
  });

  it('UnsubscribeRequestV1 needs the subscription id', () => {
    expect(UnsubscribeRequestV1.safeParse({ subscriptionId: SUBSCRIPTION_ID }).success).toBe(true);
    expect(UnsubscribeRequestV1.safeParse({}).success).toBe(false);
  });

  it('GetStateResponseV1 allows a null snapshot and next refresh, and counts subscribers', () => {
    const empty = GetStateResponseV1.parse({
      flightKey: KEY,
      phase: 'finished',
      snapshot: null,
      nextRefreshAt: null,
      doSchemaVersion: 3,
      subscriberCount: 0,
    });
    expect(empty.snapshot).toBeNull();
    const full = GetStateResponseV1.parse({
      flightKey: KEY,
      phase: 'scheduled',
      snapshot: AA100_INPUT,
      nextRefreshAt: '2026-09-19T13:00:00Z',
      doSchemaVersion: 3,
      subscriberCount: 2,
    });
    expect(full.snapshot?.legSeq).toBe(1);
    // A tracker one release ahead may report a phase this build has no name for.
    expect(GetStateResponseV1.parse({ ...empty, phase: 'merged' }).phase).toBe('unknown');
    expect(
      GetStateResponseV1.safeParse({
        flightKey: KEY,
        phase: 'scheduled',
        snapshot: null,
        nextRefreshAt: null,
        doSchemaVersion: 3,
        subscriberCount: -1,
      }).success,
    ).toBe(false);
    expect(
      GetStateResponseV1.safeParse({
        flightKey: KEY,
        phase: 'scheduled',
        snapshot: null,
        nextRefreshAt: null,
        doSchemaVersion: 1.5,
        subscriberCount: 0,
      }).success,
    ).toBe(false);
  });

  it('ForceRefreshRequestV1 constrains the reason', () => {
    expect(ForceRefreshRequestV1.parse({ reason: 'reconcile' }).reason).toBe('reconcile');
    expect(ForceRefreshRequestV1.safeParse({ reason: 'bored' }).success).toBe(false);
  });

  it('ProviderEventV1 is the shared provider event schema', () => {
    expect(ProviderEventV1).toBe(ProviderEventSchema);
  });
});
