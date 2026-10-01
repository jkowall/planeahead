import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import {
  A2_EXPECTED_POLLS,
  CADENCE_A2,
  FlightStatusSchema,
  GetStateResponseV1,
  ProviderEventSchema,
  UnknownOperationError,
  buildFlightKey,
  expectedCalls,
  flightNumberToken,
  listPriceUsdMicros,
  pollEquivalents,
  type AdbDateTime,
  type AdbMovement,
  type AdbStatus,
  type AdbTimeKind,
  type AeroApiEventCode,
  type AeroApiOperation,
  type AeroDataBoxOperation,
  type AircraftPosition,
  type AircraftPositionProvider,
  type AircraftPositionQuery,
  type AirlineCallsign,
  type AirportRef,
  type AirportRefInput,
  type AlertEvent,
  type AlertRegistrationOptions,
  type AnyProviderOperation,
  type BoardRow,
  type BoardWindow,
  type BoardBucketBounds,
  type BoardBucketRequestV1,
  type BoardBucketResponseV1,
  type BoardCallTrigger,
  type BoardCoverage,
  type BoardFreshness,
  type BoardKvMetaV1,
  type BoardLadderRung,
  type BoardPosition,
  type BudgetDecision,
  type BudgetDenialReason,
  type BudgetGuard,
  type BudgetRequest,
  type CadenceContext,
  type CadenceDefinition,
  type CadenceEdge,
  type CadenceId,
  type CadenceParams,
  type CadenceSource,
  type CadenceTier,
  type CadenceWindow,
  type CarrierIataToIcaoTable,
  type CarrierRef,
  type Codeshare,
  type CodeshareStatus,
  type CostLogger,
  type DeriveStatusInput,
  type Exact,
  type ExpectedCalls,
  type ExpectedCallsParams,
  type FieldQuality,
  type FieldQualityKey,
  type FixedSlot,
  type FixedSlotWindow,
  type FlightDataProvider,
  type FlightKey,
  type FlightKeyErrorCode,
  type FlightKeyParts,
  type FlightLookup,
  type FlightRef,
  type FlightStatus,
  type FlightStatusInput,
  type FlightStatusValue,
  type FlightTimeField,
  type FlightTimes,
  type ForceRefreshRequestV1,
  type ForceRefreshResponseV1,
  type GetCostLedgerResponseV1,
  type HealthResponseV1,
  type IngestProviderEventResponseV1,
  type ConfirmPersistedRequestV1,
  type ConfirmPersistedResponseV1,
  type SeedRequestV1,
  type SeedResponseV1,
  type ResolveRequestV1,
  type ResolveResponseV1,
  type RpcRequestErrorCode,
  type TrackerHealthPhase,
  type UnsubscribeResponseV1,
  type OutboxKind,
  type FlightTrackingState,
  type FlightTrackerOrigin,
  type FlightInstanceOutboxPayloadV1,
  type FlightEventOutboxPayloadV1,
  type FlightInstanceMessageV1,
  type FlightEventMessageV1,
  type ProviderCallMessageV1,
  type ProviderBudgetKillSwitchMessageV1,
  type ProviderBudgetDailyMessageV1,
  type PersistMessageIdentityV1,
  type PersistMessageV1,
  type PersistMessageV1Input,
  type ReconcileMessageV1,
  type Instant,
  type IntervalWindow,
  type KeyDrift,
  type KeyReconciliation,
  type LiveActivityContentStateV1,
  type DisruptionState,
  type GateSideState,
  type PolicyContext,
  type PolicyInput,
  type PolicyIntent,
  type PolicyIntentKind,
  type PolicyIntentSubject,
  type PolicyRereadReason,
  type PolicyResult,
  type PolicyState,
  type PolicyWants,
  type PreferenceSettings,
  type UserPreferences,
  type UserPreferencesPatch,
  type NextSlot,
  type NormalizedFlightNumber,
  type OperationOf,
  type OperatorSource,
  type ParsedAdbDateTime,
  type ParsedDesignator,
  type ParsedFlightKey,
  type ProviderCallContext,
  type ProviderCallPoint,
  type ProviderCallRecord,
  type ProviderCallResult,
  type ProviderCallTrigger,
  type ProviderCapabilities,
  type ProviderEvent,
  type ProviderEventKind,
  type ProviderEventV1,
  type ProviderId,
  type ProviderOperation,
  type ProviderRef,
  type ProviderResult,
  type RefreshDecision,
  type RegionalOperatorRule,
  type RelaxedLeg,
  type ResolveOperatorInput,
  type ResolvedOperator,
  type ResolvedWindow,
  type RevisedTime,
  type SimulationParams,
  type SloEvent,
  type SloRelaxation,
  type SloRelaxationParams,
  type SloTarget,
  type SloWindow,
  type SubscribeRequestV1,
  type SubscribeResponseV1,
  type ApiError,
  type ApiErrorCode,
  type CapName,
  type FlightSubscriptionRowV1,
  type FreeTierLimits,
  type LiveWindowInput,
  type SubscribeFlightBody,
  type SyncChangeV1,
  type SyncCursor,
  type SyncEntity,
  type SyncEnvelopeV1,
  type SyncFlightV1,
  type SyncOp,
  type ValidationIssue,
  type TrackerPhase,
  type UnsubscribeRequestV1,
  type ListSubscribersRequestV1,
  type ListSubscribersResponseV1,
  type TrackerSubscriberV1,
  type ProductEventName,
  type ProductEventPoint,
  type ProductEventProps,
  type ProductEventV1,
  type ProductEventsAcceptedV1,
  type ProductEventsBatchV1,
  type Uuidv7Generator,
  type WindowCallCount,
  type NotificationKind,
  type PushCredentialExpireRequestV1,
  type PushCredentialFailure,
  type PushCredentialName,
  type PushCredentialRequestV1,
  type PushDataV1,
  type PushEnvironment,
  type PushJobV1,
  type PushJobV1Input,
  type PushOutcome,
  type PushOutcomeMessageV1,
  type PushPermissionState,
  type PushTargetKind,
  type PushTargetResultV1,
  type PushTargetV1,
  type PushTargetV1Input,
} from '../src/index';
import { AA100_INPUT } from './fixtures';

/**
 * The type half of the public surface. `index.test.ts` pins the value exports at run time;
 * type-only exports never reach the module namespace object, so they are pinned here instead:
 * renaming or deleting one fails `tsc`, which CI runs over `test/`. The compile-time contracts
 * the review asked for (`Exact`, `| undefined` on optional properties, provider-checked cost
 * helpers, closed enum inputs) live here for the same reason.
 */
interface TypeSurface {
  // adb-time
  adbDateTime: AdbDateTime;
  parsedAdbDateTime: ParsedAdbDateTime;
  // airports
  airportRef: AirportRef;
  airportRefInput: AirportRefInput;
  // carriers
  carrierRef: CarrierRef;
  carrierIataToIcaoTable: CarrierIataToIcaoTable;
  // cost
  aeroApiOperation: AeroApiOperation;
  aeroDataBoxOperation: AeroDataBoxOperation;
  providerOperation: ProviderOperation<'aeroapi'>;
  anyProviderOperation: AnyProviderOperation;
  operationOf: OperationOf<ProviderId>;
  // cadence
  cadenceId: CadenceId;
  cadenceSource: CadenceSource;
  cadenceTier: CadenceTier;
  cadenceEdge: CadenceEdge;
  intervalWindow: IntervalWindow;
  fixedSlot: FixedSlot;
  fixedSlotWindow: FixedSlotWindow;
  cadenceWindow: CadenceWindow;
  cadenceDefinition: CadenceDefinition;
  sloWindow: SloWindow;
  sloEvent: SloEvent;
  sloTarget: SloTarget;
  trackerPhase: TrackerPhase;
  cadenceContext: CadenceContext;
  cadenceParams: CadenceParams;
  refreshDecision: RefreshDecision;
  resolvedWindow: ResolvedWindow;
  nextSlot: NextSlot;
  simulationParams: SimulationParams;
  expectedCallsParams: ExpectedCallsParams;
  windowCallCount: WindowCallCount;
  expectedCalls: ExpectedCalls;
  relaxedLeg: RelaxedLeg;
  sloRelaxation: SloRelaxation;
  sloRelaxationParams: SloRelaxationParams;
  // flight-key
  flightKey: FlightKey;
  flightKeyErrorCode: FlightKeyErrorCode;
  normalizedFlightNumber: NormalizedFlightNumber;
  parsedDesignator: ParsedDesignator;
  flightKeyParts: FlightKeyParts;
  parsedFlightKey: ParsedFlightKey;
  keyDrift: KeyDrift;
  keyReconciliation: KeyReconciliation;
  regionalOperatorRule: RegionalOperatorRule;
  // flight-status
  aeroApiEventCode: AeroApiEventCode;
  operatorSource: OperatorSource;
  exact: Exact<FlightStatus>;
  providerId: ProviderId;
  flightStatusValue: FlightStatusValue;
  alertEvent: AlertEvent;
  providerCallTrigger: ProviderCallTrigger;
  providerCallResult: ProviderCallResult;
  flightTimeField: FlightTimeField;
  flightTimes: FlightTimes;
  fieldQuality: FieldQuality;
  fieldQualityKey: FieldQualityKey;
  codeshare: Codeshare;
  providerRef: ProviderRef;
  flightStatus: FlightStatus;
  flightStatusInput: FlightStatusInput;
  boardRow: BoardRow;
  aircraftPosition: AircraftPosition;
  providerEventKind: ProviderEventKind;
  flightRef: FlightRef;
  providerEvent: ProviderEvent;
  providerCallRecord: ProviderCallRecord;
  // ids
  uuidv7Generator: Uuidv7Generator;
  // live-activity
  liveActivityContentStateV1: LiveActivityContentStateV1;
  // notification-policy (increment 15)
  disruptionState: DisruptionState;
  gateSideState: GateSideState;
  policyContext: PolicyContext;
  policyInput: PolicyInput;
  policyIntent: PolicyIntent;
  policyIntentKind: PolicyIntentKind;
  policyIntentSubject: PolicyIntentSubject;
  policyRereadReason: PolicyRereadReason;
  policyResult: PolicyResult;
  policyState: PolicyState;
  policyWants: PolicyWants;
  // operator
  codeshareStatus: CodeshareStatus;
  airlineCallsign: AirlineCallsign;
  resolveOperatorInput: ResolveOperatorInput;
  resolvedOperator: ResolvedOperator;
  // outbox
  outboxKind: OutboxKind;
  flightTrackingState: FlightTrackingState;
  flightTrackerOrigin: FlightTrackerOrigin;
  flightInstanceOutboxPayloadV1: FlightInstanceOutboxPayloadV1;
  flightEventOutboxPayloadV1: FlightEventOutboxPayloadV1;
  flightInstanceMessageV1: FlightInstanceMessageV1;
  flightEventMessageV1: FlightEventMessageV1;
  providerCallMessageV1: ProviderCallMessageV1;
  providerBudgetKillSwitchMessageV1: ProviderBudgetKillSwitchMessageV1;
  providerBudgetDailyMessageV1: ProviderBudgetDailyMessageV1;
  persistMessageIdentityV1: PersistMessageIdentityV1;
  persistMessageV1: PersistMessageV1;
  persistMessageV1Input: PersistMessageV1Input;
  reconcileMessageV1: ReconcileMessageV1;
  // preferences
  preferenceSettings: PreferenceSettings;
  userPreferences: UserPreferences;
  userPreferencesPatch: UserPreferencesPatch;
  // providers
  flightLookup: FlightLookup;
  boardWindow: BoardWindow;
  // boards (increment 18)
  boardBucketBounds: BoardBucketBounds;
  boardBucketRequest: BoardBucketRequestV1;
  boardBucketResponse: BoardBucketResponseV1;
  boardCallTrigger: BoardCallTrigger;
  boardCoverage: BoardCoverage;
  boardFreshness: BoardFreshness;
  boardKvMeta: BoardKvMetaV1;
  boardLadderRung: BoardLadderRung;
  boardPosition: BoardPosition;
  providerCapabilities: ProviderCapabilities;
  budgetDenialReason: BudgetDenialReason;
  budgetDecision: BudgetDecision;
  budgetRequest: BudgetRequest;
  budgetGuard: BudgetGuard;
  costLogger: CostLogger;
  providerCallContext: ProviderCallContext;
  providerResult: ProviderResult<FlightStatus[]>;
  alertRegistrationOptions: AlertRegistrationOptions;
  flightDataProvider: FlightDataProvider;
  aircraftPositionQuery: AircraftPositionQuery;
  aircraftPositionProvider: AircraftPositionProvider;
  // provider-call-point
  providerCallPoint: ProviderCallPoint;
  // push (increment 14)
  notificationKind: NotificationKind;
  pushCredentialExpireRequestV1: PushCredentialExpireRequestV1;
  pushCredentialFailure: PushCredentialFailure;
  pushCredentialName: PushCredentialName;
  pushCredentialRequestV1: PushCredentialRequestV1;
  pushDataV1: PushDataV1;
  pushEnvironment: PushEnvironment;
  pushJobV1: PushJobV1;
  pushJobV1Input: PushJobV1Input;
  pushOutcome: PushOutcome;
  pushOutcomeMessageV1: PushOutcomeMessageV1;
  pushPermissionState: PushPermissionState;
  pushTargetKind: PushTargetKind;
  pushTargetResultV1: PushTargetResultV1;
  pushTargetV1: PushTargetV1;
  pushTargetV1Input: PushTargetV1Input;
  // rpc
  subscribeRequestV1: SubscribeRequestV1;
  subscribeResponseV1: SubscribeResponseV1;
  unsubscribeRequestV1: UnsubscribeRequestV1;
  getStateResponseV1: GetStateResponseV1;
  forceRefreshRequestV1: ForceRefreshRequestV1;
  forceRefreshResponseV1: ForceRefreshResponseV1;
  getCostLedgerResponseV1: GetCostLedgerResponseV1;
  healthResponseV1: HealthResponseV1;
  ingestProviderEventResponseV1: IngestProviderEventResponseV1;
  confirmPersistedRequestV1: ConfirmPersistedRequestV1;
  confirmPersistedResponseV1: ConfirmPersistedResponseV1;
  seedRequestV1: SeedRequestV1;
  seedResponseV1: SeedResponseV1;
  resolveRequestV1: ResolveRequestV1;
  resolveResponseV1: ResolveResponseV1;
  rpcRequestErrorCode: RpcRequestErrorCode;
  trackerHealthPhase: TrackerHealthPhase;
  unsubscribeResponseV1: UnsubscribeResponseV1;
  providerEventV1: ProviderEventV1;
  listSubscribersRequestV1: ListSubscribersRequestV1;
  listSubscribersResponseV1: ListSubscribersResponseV1;
  trackerSubscriberV1: TrackerSubscriberV1;
  // events (increment 12)
  productEventName: ProductEventName;
  productEventPoint: ProductEventPoint;
  productEventProps: ProductEventProps;
  productEventV1: ProductEventV1;
  productEventsAcceptedV1: ProductEventsAcceptedV1;
  productEventsBatchV1: ProductEventsBatchV1;
  // status-derivation
  adbStatus: AdbStatus;
  adbMovement: AdbMovement;
  adbTimeKind: AdbTimeKind;
  instant: Instant;
  deriveStatusInput: DeriveStatusInput;
  revisedTime: RevisedTime;
  // sync
  syncEntity: SyncEntity;
  syncOp: SyncOp;
  syncCursor: SyncCursor;
  syncChangeV1: SyncChangeV1;
  syncFlightV1: SyncFlightV1;
  syncEnvelopeV1: SyncEnvelopeV1;
  flightSubscriptionRowV1: FlightSubscriptionRowV1;
  // api, errors, limits (increment 8)
  subscribeFlightBody: SubscribeFlightBody;
  apiError: ApiError;
  apiErrorCode: ApiErrorCode;
  validationIssue: ValidationIssue;
  capName: CapName;
  freeTierLimits: FreeTierLimits;
  liveWindowInput: LiveWindowInput;
}

/** A value a caller holds as optional, typed `T | undefined` rather than narrowed. */
function maybe<T>(value: T | undefined): T | undefined {
  return value;
}

const CALL: ProviderCallRecord = {
  id: '019968a7-4e00-7000-8000-000000000000',
  provider: 'aeroapi',
  operation: 'flight_by_id',
  trigger: 'alarm',
  requestId: 'req-1',
  startedAt: '2026-09-19T12:00:00Z',
  latencyMs: 210,
  result: 'ok',
  costUnits: 1,
  pollEquivalents: 1,
  estCostUsdMicros: 5_000,
};

const EXACT_STATUS: Exact<FlightStatus> = {
  operatingCarrierIcao: 'AAL',
  flightNumber: '100',
  legSeq: 1,
  codeshares: [],
  origin: { icao: 'KJFK', tz: 'America/New_York' },
  destination: { icao: 'EGLL' },
  status: 'scheduled',
  times: { scheduledOut: '2026-09-20T03:50:00Z' },
  originGate: 'B12',
  providerRefs: {},
  fetchedAt: '2026-09-19T12:00:00Z',
  source: 'aeroapi',
  fieldQuality: {},
};

describe('exported types', () => {
  it('are all still exported under their documented names', () => {
    expectTypeOf<TypeSurface>().toBeObject();
    expectTypeOf<keyof TypeSurface>().toBeString();
  });
});

describe('Exact producer types', () => {
  it('reject a misspelled field at compile time while the wire stays loose', () => {
    const typo: Exact<FlightStatus> = {
      ...EXACT_STATUS,
      // @ts-expect-error originGaet is a misspelling of originGate; the loose type would accept it
      originGaet: 'B12',
    };
    const nested: Exact<FlightStatus> = {
      ...EXACT_STATUS,
      // @ts-expect-error scheduledOutt is a misspelling inside a nested loose object
      times: { scheduledOutt: '2026-09-20T03:50:00Z' },
    };
    // Both directions stay assignable; only the excess-property check differs.
    const loose: FlightStatus = EXACT_STATUS;
    const exact: Exact<FlightStatus> = loose;
    expect(FlightStatusSchema.parse(typo)).toHaveProperty('originGaet', 'B12');
    expect(FlightStatusSchema.parse(nested).times).toEqual({
      scheduledOutt: '2026-09-20T03:50:00Z',
    });
    expect(exact.originGate).toBe('B12');
    expectTypeOf<Exact<FlightStatus>['status']>().toEqualTypeOf<FlightStatusValue>();
    expectTypeOf<Exact<FlightStatus>['key']>().toEqualTypeOf<FlightKey | undefined>();
  });

  it('leave open-keyed records readable and writable by any string key (R12)', () => {
    const status: Exact<FlightStatus> = {
      ...EXACT_STATUS,
      providerRefs: { aeroapi: 'AAL100-1758253800-airline-0' },
      fieldQuality: { originGate: 'live' },
    };
    status.providerRefs['aerodatabox'] = 'adb-aa100-20260919';
    status.fieldQuality.scheduledOut = 'schedule';
    // Adapters return Exact<FlightStatus>[]; the tracker reads the refs and qualities back.
    const result: ProviderResult<Exact<FlightStatus>[]> = { data: [status], call: CALL };
    expect(result.data[0]?.providerRefs['aeroapi']).toBe('AAL100-1758253800-airline-0');
    expect(result.data[0]?.providerRefs.aerodatabox).toBe('adb-aa100-20260919');
    expect(result.data[0]?.fieldQuality['originGate']).toBe('live');
    expect(result.data[0]?.fieldQuality.scheduledOut).toBe('schedule');
    expectTypeOf<Exact<FlightStatus>['providerRefs']>().toEqualTypeOf<Record<string, string>>();
    expectTypeOf<Exact<FlightStatus>['fieldQuality']>().toEqualTypeOf<
      Record<string, FieldQuality>
    >();
    expectTypeOf<Exact<Record<string, string>>>().toEqualTypeOf<Record<string, string>>();
    // A looseObject shape still loses its index signature.
    expectTypeOf<keyof Exact<FlightTimes>>().toEqualTypeOf<FlightTimeField>();
    expectTypeOf<keyof Exact<FlightStatus>>().toExtend<keyof FlightStatus>();
    expectTypeOf<string>().not.toExtend<keyof Exact<FlightStatus>>();
  });

  it('cover BoardRow, AircraftPosition and ProviderEvent, which adapters also hand-map', () => {
    const row: Exact<BoardRow> = {
      direction: 'dep',
      designator: 'AA100',
      flightNumber: '100',
      counterpart: { icao: 'EGLL' },
      scheduled: '2026-09-20T03:50:00Z',
      status: 'scheduled',
      codeshares: [],
      source: 'aerodatabox',
      // @ts-expect-error gaet is a misspelling of gate
      gaet: 'B12',
    };
    const position: Exact<AircraftPosition> = {
      icaoHex: 'A0B1C2',
      lat: 40.64,
      lon: -73.78,
      seenAt: '2026-09-20T04:05:00Z',
      source: 'adsb_lol',
      // @ts-expect-error altitudeFt is a misspelling of altFt
      altitudeFt: 30_000,
    };
    const event: Exact<ProviderEvent> = {
      provider: 'aeroapi',
      externalId: 'evt-1',
      receivedAt: '2026-09-20T03:55:00Z',
      kind: 'out',
      flightRef: { flightKey: 'AAL-100-2026-09-19-KJFK' as FlightKey },
      payload: { anything: true },
      // @ts-expect-error recievedAt is a misspelling of receivedAt
      recievedAt: '2026-09-20T03:55:00Z',
    };
    expect([row.designator, position.icaoHex, event.externalId]).toEqual([
      'AA100',
      'A0B1C2',
      'evt-1',
    ]);
  });
});

describe('optional contract properties', () => {
  it('accept an explicitly undefined value under exactOptionalPropertyTypes', () => {
    const lookup: FlightLookup = {
      carrier: { iata: 'AA' },
      flightNumber: '100',
      dateLocal: '2026-09-19',
      originIcao: maybe<string>(undefined),
      providerRef: maybe<{ provider: ProviderId; id: string }>(undefined),
      scheduledOut: maybe<string>(undefined),
      window: maybe<{ start: string; end: string }>(undefined),
    };
    const context: ProviderCallContext = {
      trigger: 'alarm',
      flightKey: maybe<FlightKey>(undefined),
      airportIcao: maybe<string>(undefined),
      requestId: 'req-1',
      budget: { reserve: () => Promise.resolve({ allowed: false, reason: 'routing_rule' }) },
      log: { record: () => undefined },
      now: () => new Date('2026-09-19T12:00:00Z'),
    };
    const request: BudgetRequest = {
      provider: 'aeroapi',
      operation: 'flight_by_id',
      pollEquivalents: 1,
      trigger: 'alarm',
      flightKey: maybe<FlightKey>(undefined),
      utcDate: maybe<string>(undefined),
    };
    const query: AircraftPositionQuery = {
      icaoHexes: maybe<readonly string[]>(undefined),
      callsigns: maybe<readonly string[]>(undefined),
    };
    const parts: FlightKeyParts = {
      operatingCarrierIcao: 'AAL',
      flightNumber: '100',
      scheduledDepartureDateLocal: '2026-09-19',
      originIcao: 'KJFK',
      legSeq: maybe<number>(undefined),
    };
    const designator: ParsedDesignator = {
      carrier: { iata: 'AA' },
      number: '100',
      suffix: maybe<string>(undefined),
    };
    const normalized: NormalizedFlightNumber = { number: '100', suffix: maybe<string>(undefined) };
    const params: ExpectedCallsParams = {
      leadTimeDays: 2,
      blockMinutes: maybe<number>(undefined),
      boardingMinutesBefore: maybe<number>(undefined),
      postArrivalStopMinutes: maybe<number>(undefined),
    };
    expect(buildFlightKey(parts)).toBe('AAL-100-2026-09-19-KJFK');
    expect(flightNumberToken(normalized)).toBe('100');
    expect(expectedCalls(CADENCE_A2, params).polls).toBe(A2_EXPECTED_POLLS);
    expect([
      lookup.originIcao,
      context.flightKey,
      request.flightKey,
      query.icaoHexes,
      designator.suffix,
    ]).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });
});

describe('cost helpers', () => {
  it('check the operation against a statically known provider', () => {
    expectTypeOf<ProviderOperation<'aeroapi'>>().toEqualTypeOf<AeroApiOperation>();
    expectTypeOf<ProviderOperation<'aerodatabox'>>().toEqualTypeOf<AeroDataBoxOperation>();
    expectTypeOf<ProviderOperation<'nws'>>().toEqualTypeOf<'alerts' | 'forecast'>();
    expectTypeOf<OperationOf<ProviderId>>().toEqualTypeOf<string>();
    expectTypeOf<OperationOf<'nws'>>().toEqualTypeOf<'alerts' | 'forecast'>();
    expectTypeOf<AnyProviderOperation>().toExtend<string>();
    const union: ProviderOperation<'aeroapi' | 'adsb_lol'> = 'positions';
    const any: AnyProviderOperation = 'metar';
    // @ts-expect-error flight_status is an AeroDataBox operation, not an AeroAPI one
    expect(() => pollEquivalents('aeroapi', 'flight_status')).toThrow(UnknownOperationError);
    // @ts-expect-error schedules is not priced for adsb_lol
    expect(() => listPriceUsdMicros('adsb_lol', 'schedules')).toThrow(UnknownOperationError);
    expect(pollEquivalents('aeroapi', 'flight_by_id')).toBe(1);
    expect([union, any]).toEqual(['positions', 'metar']);
  });
});

describe('tolerant enums', () => {
  it('keep the closed union as their input type, so producers are still checked', () => {
    const input: FlightStatusInput = {
      ...AA100_INPUT,
      // @ts-expect-error taxiing is not a status a producer on this build may write
      status: 'taxiing',
    };
    expect(FlightStatusSchema.parse(input).status).toBe('unknown');
    expectTypeOf<FlightStatusInput['status']>().toEqualTypeOf<FlightStatusValue>();
    expectTypeOf<TrackerPhase>().toEqualTypeOf<GetStateResponseV1['phase']>();
    // The runtime accepts any string (R11) but the declared input stays the closed union.
    expectTypeOf<z.input<typeof ProviderEventSchema>['kind']>().toEqualTypeOf<ProviderEventKind>();
    expectTypeOf<z.input<typeof GetStateResponseV1>['phase']>().toEqualTypeOf<TrackerPhase>();
    expectTypeOf<ProviderEventV1['rpcVersion']>().toEqualTypeOf<number>();
    expectTypeOf<ProviderEventV1>().toExtend<ProviderEvent>();
  });
});
