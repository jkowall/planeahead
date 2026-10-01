/**
 * What every HTTP provider adapter shares (increment 6): the injected `fetch`, the budget gate
 * in front of each attempt, the `ProviderCallRecord` each attempt produces, and a body reader
 * that never calls `.json()` blind.
 *
 * Adapters never read the wall clock: every timestamp and the latency come from `ctx.now()`
 * (`@planeahead/shared` providers rule 2), and the record id is a UUIDv7 on that same clock.
 * Adapters never create a `fetch` either; the router hands them one, and the tests hand them a
 * stub that serves fixtures, so no test ever reaches a real provider.
 */

import {
  costUnits,
  estimateCostUsdMicros,
  pollEquivalents,
  uuidv7,
  type BudgetDecision,
  type BudgetDenialReason,
  type BudgetRequest,
  type ProviderCallContext,
  type ProviderCallRecord,
  type ProviderCallResult,
  type ProviderId,
} from '@planeahead/shared';

/** The fetch an adapter is given. Tests pass a stub; the router passes the Worker's `fetch`. */
export type ProviderFetch = (request: Request) => Promise<Response>;

/** Longest error text kept on a record; provider bodies can be whole HTML pages. */
const ERROR_MAX_LENGTH = 200;

export function truncateError(message: string): string {
  const flat = message.replace(/\s+/g, ' ').trim();
  return flat.length <= ERROR_MAX_LENGTH ? flat : `${flat.slice(0, ERROR_MAX_LENGTH)}...`;
}

export interface Reservation {
  readonly request: BudgetRequest;
  readonly decision: BudgetDecision;
}

/**
 * Asks the context's budget for one attempt at `operation`. The request names its budget day
 * (`utcDate`, from `ctx.now()`) once, here, so a release after midnight refunds the day that was
 * debited.
 */
export async function reserve(
  ctx: ProviderCallContext,
  provider: ProviderId,
  operation: string,
): Promise<Reservation> {
  const request: BudgetRequest = {
    provider,
    operation,
    pollEquivalents: pollEquivalents(provider, operation),
    trigger: ctx.trigger,
    flightKey: ctx.flightKey,
    airportIcao: ctx.airportIcao,
    utcDate: ctx.now().toISOString().slice(0, 10),
  };
  return { request, decision: await ctx.budget.reserve(request) };
}

export interface RecordInput {
  readonly ctx: ProviderCallContext;
  readonly provider: ProviderId;
  readonly operation: string;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly result: ProviderCallResult;
  /** Whether the provider bills this attempt; an unbilled attempt records zero cost. */
  readonly billed: boolean;
  readonly httpStatus?: number | undefined;
  readonly responseBytes?: number | undefined;
  readonly error?: string | undefined;
}

/** One record per HTTP attempt, priced from `cost.ts`. */
export function callRecord(input: RecordInput): ProviderCallRecord {
  const { ctx, provider, operation, billed } = input;
  const record: ProviderCallRecord = {
    id: uuidv7(() => input.startedAt.getTime()),
    provider,
    operation,
    trigger: ctx.trigger,
    requestId: ctx.requestId,
    startedAt: input.startedAt.toISOString(),
    latencyMs: Math.max(0, Math.round(input.finishedAt.getTime() - input.startedAt.getTime())),
    result: input.result,
    costUnits: billed ? costUnits(provider, operation) : 0,
    pollEquivalents: billed ? pollEquivalents(provider, operation) : 0,
    estCostUsdMicros: billed ? estimateCostUsdMicros(provider, operation) : 0,
  };
  if (ctx.flightKey !== undefined) {
    record.flightKey = ctx.flightKey;
  }
  if (ctx.airportIcao !== undefined) {
    record.airportIcao = ctx.airportIcao;
  }
  if (input.httpStatus !== undefined) {
    record.httpStatus = input.httpStatus;
  }
  if (input.responseBytes !== undefined) {
    record.responseBytes = input.responseBytes;
  }
  if (input.error !== undefined) {
    record.error = truncateError(input.error);
  }
  return record;
}

/**
 * The record for an attempt the budget refused: nothing was sent, nothing is billed. A refusal
 * by the per-second bucket (its rate, or the floor it keeps for the trackers against a board
 * call) reads as `rate_limited`, any other refusal as `error`.
 */
export function deniedRecord(
  ctx: ProviderCallContext,
  provider: ProviderId,
  operation: string,
  reason: BudgetDenialReason,
): ProviderCallRecord {
  const at = ctx.now();
  const perSecond = reason === 'provider_rate_limit' || reason === 'board_rate_floor';
  return callRecord({
    ctx,
    provider,
    operation,
    startedAt: at,
    finishedAt: at,
    result: perSecond ? 'rate_limited' : 'error',
    billed: false,
    error: `budget_denied:${reason}`,
  });
}

/**
 * The record for an attempt whose `fetch` rejected (a network error, a reset, a timeout).
 *
 * BILLED, and the reservation is KEPT: a rejection can arrive after the request reached the
 * provider (a connection reset while the response head was on its way), and the provider may have
 * served and billed it. The same conservative rule as a 451 or an unexplained error status:
 * over-counting in our own ledger is the safe direction for a budget, and the daily cap only
 * bounds the real bill if every possibly billed call is in it. The `transport_unknown_billing`
 * prefix marks these rows so the daily reconciliation against the provider's own usage report
 * can tell them apart. Only a failure that provably happened before the request left the Worker
 * is unbilled, and the adapters build the `Request` before reserving so that such a failure
 * never holds a reservation at all.
 */
export function transportErrorRecord(
  ctx: ProviderCallContext,
  provider: ProviderId,
  operation: string,
  startedAt: Date,
  error: unknown,
): ProviderCallRecord {
  return callRecord({
    ctx,
    provider,
    operation,
    startedAt,
    finishedAt: ctx.now(),
    result: 'error',
    billed: true,
    error: `transport_unknown_billing:${error instanceof Error ? error.message : String(error)}`,
  });
}

export type ReadBody =
  | { readonly kind: 'empty'; readonly bytes: number }
  | { readonly kind: 'json'; readonly value: unknown; readonly bytes: number }
  | { readonly kind: 'non_json'; readonly text: string; readonly bytes: number };

/**
 * Reads a response body without trusting it. A 204 (or any empty body) is `empty` and the body
 * is never parsed, so `.json()` is never called on a 204. Anything whose content type is not
 * JSON, or that does not parse, is `non_json`: a Cloudflare challenge page answers 403 with
 * HTML, and a gateway under load can answer 200 with one.
 */
export async function readBody(response: Response): Promise<ReadBody> {
  if (response.status === 204 || response.status === 205 || response.status === 304) {
    // Drain without parsing so the connection is released.
    await response.body?.cancel();
    return { kind: 'empty', bytes: 0 };
  }
  const text = await response.text();
  const bytes = new TextEncoder().encode(text).length;
  if (text.trim() === '') {
    return { kind: 'empty', bytes };
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('json')) {
    return { kind: 'non_json', text, bytes };
  }
  try {
    return { kind: 'json', value: JSON.parse(text) as unknown, bytes };
  } catch {
    return { kind: 'non_json', text, bytes };
  }
}

/** The `message` of a provider's JSON error body, if it has one. */
export function errorMessageOf(body: ReadBody): string | undefined {
  if (body.kind === 'json' && typeof body.value === 'object' && body.value !== null) {
    const value = body.value as Record<string, unknown>;
    for (const key of ['message', 'detail', 'title', 'reason']) {
      const field = value[key];
      if (typeof field === 'string' && field !== '') {
        return field;
      }
    }
  }
  if (body.kind === 'non_json') {
    return body.text;
  }
  return undefined;
}

/**
 * Thrown by an operation whose result type has no room for "nothing" (an alert id, a deletion)
 * when the provider refuses it. It carries the attempt's record, so the caller still records
 * the call: a failed call without a record would be a billed call the ledger never saw.
 */
export class ProviderCallError extends Error {
  override readonly name = 'ProviderCallError';
  readonly call: ProviderCallRecord;

  constructor(message: string, call: ProviderCallRecord) {
    super(message);
    this.call = call;
  }
}
