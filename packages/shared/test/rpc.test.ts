import { describe, expect, it } from 'vitest';
import { FLIGHT_STATUS_VALUES, ProviderEventSchema } from '../src/flight-status';
import {
  ConfirmPersistedRequestV1,
  ConfirmPersistedResponseV1,
  ForceRefreshRequestV1,
  ForceRefreshResponseV1,
  GetCostLedgerResponseV1,
  GetStateResponseV1,
  HealthResponseV1,
  IngestProviderEventResponseV1,
  ProviderEventV1,
  RPC_SCHEMA_VERSION,
  ResolveRequestV1,
  ResolveResponseV1,
  RpcRequestError,
  SeedRequestV1,
  SeedResponseV1,
  SubscribeRequestV1,
  SubscribeResponseV1,
  TRACKER_HEALTH_PHASES,
  TRACKER_PHASES,
  TrackerHealthPhaseSchema,
  TrackerPhaseSchema,
  UnsubscribeRequestV1,
  UnsubscribeResponseV1,
  parseRpcRequest,
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

  it('the phase stays required: absent, null and a number are rejected (R11)', () => {
    expect(TrackerPhaseSchema.safeParse(undefined).success).toBe(false);
    expect(TrackerPhaseSchema.safeParse(null).success).toBe(false);
    expect(TrackerPhaseSchema.safeParse(2).success).toBe(false);
    const state = {
      flightKey: KEY,
      snapshot: null,
      nextRefreshAt: null,
      doSchemaVersion: 3,
      subscriberCount: 0,
    };
    expect(GetStateResponseV1.safeParse(state).success).toBe(false);
    expect(GetStateResponseV1.safeParse({ ...state, phase: null }).success).toBe(false);
    expect(GetStateResponseV1.safeParse({ ...state, phase: 2 }).success).toBe(false);
    expect(GetStateResponseV1.parse({ ...state, phase: 'merged' }).phase).toBe('unknown');
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

  it('ProviderEventV1 is the shared provider event plus rpcVersion (R13)', () => {
    const event = {
      provider: 'aeroapi',
      externalId: 'evt-1',
      receivedAt: '2026-09-20T03:55:00Z',
      kind: 'out',
      flightRef: { flightKey: KEY },
      payload: { anything: true },
      futureField: 1,
    };
    const parsed = ProviderEventV1.parse(event);
    expect(parsed.rpcVersion).toBe(RPC_SCHEMA_VERSION);
    expect(parsed).toEqual({ ...ProviderEventSchema.parse(event), rpcVersion: 1 });
    expect(parsed).toHaveProperty('futureField', 1);
    expect(ProviderEventV1.parse({ ...event, rpcVersion: 2 }).rpcVersion).toBe(2);
    expect(ProviderEventV1.safeParse({ ...event, rpcVersion: 0 }).success).toBe(false);
    expect(Object.keys(ProviderEventV1.shape)).toEqual([
      ...Object.keys(ProviderEventSchema.shape),
      'rpcVersion',
    ]);
    expect(ProviderEventV1.safeParse({ ...event, kind: undefined }).success).toBe(false);
  });
});

describe('parseRpcRequest (increment 7)', () => {
  it('serves a V1 payload, with or without an explicit rpcVersion', () => {
    expect(parseRpcRequest(ForceRefreshRequestV1, { reason: 'manual' })).toEqual({
      rpcVersion: 1,
      reason: 'manual',
    });
    expect(parseRpcRequest(ForceRefreshRequestV1, { rpcVersion: 1, reason: 'manual' }).reason).toBe(
      'manual',
    );
  });

  it('refuses an unknown rpcVersion with a typed error before the schema runs', () => {
    let caught: unknown;
    try {
      parseRpcRequest(ForceRefreshRequestV1, { rpcVersion: 2, reason: 'manual' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RpcRequestError);
    expect((caught as RpcRequestError).code).toBe('unsupported_rpc_version');
    // The code survives the RPC boundary as the first token of the message.
    expect((caught as RpcRequestError).message).toMatch(/^unsupported_rpc_version: /);
    // The schema alone would have accepted it: refusing is the receiver's job.
    expect(ForceRefreshRequestV1.parse({ rpcVersion: 2, reason: 'manual' }).rpcVersion).toBe(2);
  });

  it('refuses an invalid payload with invalid_request and names the field', () => {
    let caught: unknown;
    try {
      parseRpcRequest(SubscribeRequestV1, { subscriptionId: 'nope', userId: 'u' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RpcRequestError);
    expect((caught as RpcRequestError).code).toBe('invalid_request');
    expect((caught as RpcRequestError).message).toContain('subscriptionId');
  });
});

describe('increment 7 schemas', () => {
  it('health phases are the tracker phases plus absent', () => {
    expect(TRACKER_HEALTH_PHASES).toEqual([...TRACKER_PHASES, 'absent']);
    expect(TrackerHealthPhaseSchema.parse('absent')).toBe('absent');
    expect(TrackerHealthPhaseSchema.parse('merged')).toBe('unknown');
  });

  it('SeedRequestV1 defaults the cadence to A2 and the trigger to user_search', () => {
    const parsed = SeedRequestV1.parse({ flightKey: KEY, status: AA100_INPUT });
    expect(parsed.cadence).toBe('A2');
    expect(parsed.trigger).toBe('user_search');
    expect(SeedRequestV1.safeParse({ flightKey: 'AA100', status: AA100_INPUT }).success).toBe(
      false,
    );
    expect(
      SeedResponseV1.parse({
        status: 'seeded',
        flightKey: KEY,
        version: 1,
        phase: 'scheduled',
        nextRefreshAt: null,
      }).rpcVersion,
    ).toBe(1);
  });

  it('ConfirmPersistedRequestV1 names a lifetime, at most 1000 seqs and an optional dead-letter flag', () => {
    expect(ConfirmPersistedRequestV1.parse({ epochMs: 5, seqs: [1, 2] }).seqs).toEqual([1, 2]);
    // A confirmation leaves the flag out; the dead-letter consumer's notice sets it.
    expect(ConfirmPersistedRequestV1.parse({ epochMs: 5, seqs: [1] }).deadLettered).toBeUndefined();
    expect(
      ConfirmPersistedRequestV1.parse({ epochMs: 5, seqs: [1], deadLettered: true }).deadLettered,
    ).toBe(true);
    expect(ConfirmPersistedRequestV1.safeParse({ epochMs: 5, seqs: [-1] }).success).toBe(false);
    expect(
      ConfirmPersistedRequestV1.safeParse({
        epochMs: 5,
        seqs: Array.from({ length: 1_001 }, (_v, i) => i),
      }).success,
    ).toBe(false);
    expect(
      ConfirmPersistedResponseV1.parse({ deleted: 2, remaining: 0, matched: true }).rpcVersion,
    ).toBe(1);
  });

  it('HealthResponseV1 allows a null key and a null alarm', () => {
    const parsed = HealthResponseV1.parse({
      flightKey: null,
      phase: 'absent',
      alarmAt: null,
      inflight: false,
      version: 0,
      doSchemaVersion: 1,
      unconfirmedOutbox: 0,
      subscriberCount: 0,
    });
    expect(parsed.phase).toBe('absent');
    expect(
      HealthResponseV1.safeParse({
        flightKey: KEY,
        phase: 'scheduled',
        alarmAt: 'soon',
        inflight: false,
        version: 0,
        doSchemaVersion: 1,
        unconfirmedOutbox: 0,
        subscriberCount: 0,
      }).success,
    ).toBe(false);
  });

  it('ResolveRequestV1 and ResolveResponseV1 carry the search and its outcome', () => {
    expect(ResolveRequestV1.parse({ designator: 'AA100', dateLocal: '2026-09-19' })).toEqual({
      rpcVersion: 1,
      designator: 'AA100',
      dateLocal: '2026-09-19',
    });
    expect(
      ResolveRequestV1.safeParse({ designator: 'AA100', dateLocal: '2026-02-30' }).success,
    ).toBe(false);
    const found = ResolveResponseV1.parse({
      outcome: 'resolved',
      flightKey: KEY,
      status: AA100_INPUT,
      created: true,
      cached: false,
      resolvedAt: '2026-09-19T12:00:00Z',
      expiresAt: '2026-09-20T12:00:00Z',
    });
    expect(found.status?.legSeq).toBe(1);
    expect(
      ResolveResponseV1.safeParse({
        outcome: 'found',
        cached: false,
        resolvedAt: '2026-09-19T12:00:00Z',
        expiresAt: null,
      }).success,
    ).toBe(false);
  });

  it('ForceRefreshResponseV1, GetCostLedgerResponseV1 and the smaller responses parse', () => {
    expect(
      ForceRefreshResponseV1.parse({
        outcome: 'coalesced',
        phase: 'boarding',
        version: 4,
        snapshot: null,
      }).rpcVersion,
    ).toBe(1);
    expect(
      ForceRefreshResponseV1.safeParse({
        outcome: 'later',
        phase: 'boarding',
        version: 4,
        snapshot: null,
      }).success,
    ).toBe(false);
    expect(
      GetCostLedgerResponseV1.parse({
        flightKey: KEY,
        scheduledPe: 3,
        userRefreshPe: 0.2,
        calls: 5,
        softCapPe: 244,
        hardCapPe: 488,
        stretched: false,
        hardCapHit: false,
        byTrigger: { alarm: { pe: 3, calls: 3 }, user_refresh: { pe: 0.2, calls: 2 } },
      }).byTrigger['alarm']?.calls,
    ).toBe(3);
    expect(IngestProviderEventResponseV1.parse({ outcome: 'merged', version: 2 }).outcome).toBe(
      'merged',
    );
    expect(
      UnsubscribeResponseV1.parse({ status: 'unsubscribed', subscriberCount: 0 }).rpcVersion,
    ).toBe(1);
    expect(ForceRefreshRequestV1.parse({ reason: 'user_refresh', userId: 'u1' }).userId).toBe('u1');
  });
});
