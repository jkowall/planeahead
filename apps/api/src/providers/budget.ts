/**
 * Budget guards (increment 6).
 *
 * Two `BudgetGuard` implementations gate every billable provider call:
 *
 *   - the per-flight ledger inside the FlightTracker (increment 7), whose decision rule is
 *     `perFlightLedgerDecision` below, with caps derived in `@planeahead/shared`
 *     (`A2_SOFT_CAP_PE`, `A2_HARD_CAP_PE`);
 *   - the provider-wide daily budget, one `ProviderBudget` Durable Object per provider per UTC
 *     day (src/do/provider-budget.ts), reached through `ProviderBudgetGuard`.
 *
 * `composeBudgets` chains them so a call needs both, and gives back what the first granted when
 * the second refuses.
 *
 * The provider-wide guard reads a 60 second KV copy of the object's state first
 * (`budget:{provider}:{date}` in `CACHE`), so a provider that is already over its cap or behind
 * its kill switch is refused without a billed Durable Object request and a cross-colo round trip.
 * The copy is only ever trusted to say NO: a missing, stale or unreadable copy falls through to
 * the object, which is the only authority (facts sheet section 5, decision 6).
 */

import {
  A2_HARD_CAP_PE,
  A2_SOFT_CAP_PE,
  type BudgetDecision,
  type BudgetGuard,
  type BudgetRequest,
  type ProviderId,
} from '@planeahead/shared';
import { type BudgetProvider, isBudgetProvider } from './config';

/** The rungs of the 70 / 90 / 100 percent ladder, as fractions of the daily cap. */
export const LADDER_THRESHOLDS = Object.freeze({ warn: 0.7, degraded: 0.9 });

export type Ladder = 'normal' | 'warn' | 'degraded';

/** The rung a provider is on after spending `spentUnits` of `capUnits` today. */
export function ladderFor(spentUnits: number, capUnits: number): Ladder {
  if (capUnits <= 0) {
    return 'degraded';
  }
  const share = spentUnits / capUnits;
  if (share >= LADDER_THRESHOLDS.degraded) {
    return 'degraded';
  }
  return share >= LADDER_THRESHOLDS.warn ? 'warn' : 'normal';
}

const UTC_DATE_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

/** `YYYY-MM-DD` of `now` in UTC. The budget day is a UTC day, not a local one. */
export function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * The object name `${provider}:${utcDate}`, for example `aerodatabox:2026-09-22`. A name is a
 * day: tomorrow's first call creates tomorrow's object with a fresh ledger.
 *
 * Sharding escape hatch (not used in Phase 0): `${provider}:${utcDate}:${shard}` with a shard of
 * 0 to 7 splits one day's debits over eight objects, each holding an eighth of the cap and the
 * rate. `parseProviderBudgetName` already accepts the suffix so the switch is a caller change.
 */
export function providerBudgetName(provider: BudgetProvider, now: Date): string {
  return providerBudgetNameFor(provider, utcDate(now));
}

/** The object name for a given UTC day (`YYYY-MM-DD`). */
export function providerBudgetNameFor(provider: BudgetProvider, date: string): string {
  return `${provider}:${date}`;
}

export interface ProviderBudgetIdentity {
  readonly provider: BudgetProvider;
  readonly utcDate: string;
  readonly shard?: number | undefined;
}

export function parseProviderBudgetName(name: string): ProviderBudgetIdentity | null {
  const [provider, date, shard, ...rest] = name.split(':');
  if (provider === undefined || date === undefined || rest.length > 0) {
    return null;
  }
  const match = UTC_DATE_RE.exec(date);
  if (!isBudgetProvider(provider) || match === null) {
    return null;
  }
  const probe = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(probe.getTime()) || probe.toISOString().slice(0, 10) !== date) {
    return null;
  }
  if (shard === undefined) {
    return { provider, utcDate: date };
  }
  if (!/^[0-7]$/.test(shard)) {
    return null;
  }
  return { provider, utcDate: date, shard: Number(shard) };
}

/** When the day's object finalises: 00:05 UTC on the following day. */
export function finaliseAtMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) + 24 * 60 * 60 * 1_000 + 5 * 60 * 1_000;
}

/** Outbox kinds the ProviderBudget object writes; the persist consumer routes on them. */
export const PROVIDER_BUDGET_OUTBOX_KINDS = Object.freeze({
  killSwitch: 'provider_budget_kill_switch',
  daily: 'provider_budget_daily',
} as const);

/** The KV key of the fast-path copy. */
export function budgetKvKey(provider: BudgetProvider, date: string): string {
  return `budget:${provider}:${date}`;
}

/** Seconds the KV copy lives; the KV minimum `expirationTtl`. */
export const BUDGET_KV_TTL_SECONDS = 60;

/** What the object writes to KV and what the fast path reads back. */
export interface BudgetKvCopy {
  readonly provider: BudgetProvider;
  readonly utcDate: string;
  readonly units: number;
  readonly dailyUnitCap: number;
  readonly ladder: Ladder;
  readonly killSwitch: boolean;
  /** True when the object refuses every reservation right now (kill switch or cap reached). */
  readonly blocked: boolean;
  readonly writtenAtMs: number;
}

function isKvCopy(value: unknown): value is BudgetKvCopy {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const copy = value as Record<string, unknown>;
  return (
    typeof copy['provider'] === 'string' &&
    typeof copy['utcDate'] === 'string' &&
    typeof copy['blocked'] === 'boolean' &&
    typeof copy['killSwitch'] === 'boolean'
  );
}

/** The fast-path read. Null on a miss, a malformed value or a KV error (the object decides). */
export async function readBudgetCopy(
  kv: Pick<KVNamespace, 'get'>,
  provider: BudgetProvider,
  date: string,
): Promise<BudgetKvCopy | null> {
  try {
    const value: unknown = await kv.get(budgetKvKey(provider, date), 'json');
    return isKvCopy(value) ? value : null;
  } catch {
    return null;
  }
}

/** The RPC surface of the ProviderBudget object that the guard uses. */
export interface ProviderBudgetRpc {
  reserve(request: BudgetRequest): Promise<BudgetDecision>;
  release(request: BudgetRequest, unusedPollEquivalents: number): Promise<void>;
  backoff(retryAfterMs: number): Promise<void>;
}

export interface ProviderBudgetGuardOptions {
  /** Resolves an object name to its stub (`env.PROVIDER_BUDGET.getByName(name, ...)`). */
  readonly stubFor: (name: string) => ProviderBudgetRpc;
  /** The `CACHE` namespace holding the fast-path copies. */
  readonly kv: Pick<KVNamespace, 'get'>;
  /** The only clock; decides which day's object a call lands on. */
  readonly now: () => Date;
}

/**
 * The provider-wide daily budget as a `BudgetGuard`. Providers without a budget object (the free
 * feeds, the mock) are always allowed: they cost nothing and have no daily cap.
 */
export class ProviderBudgetGuard implements BudgetGuard {
  readonly #options: ProviderBudgetGuardOptions;

  constructor(options: ProviderBudgetGuardOptions) {
    this.#options = options;
  }

  /**
   * Debits the day the request names (`utcDate`, set when the request was built), or today by
   * this guard's clock when it names none. Either way the day travels with the request into the
   * object, so `release` finds the same one.
   */
  async reserve(request: BudgetRequest): Promise<BudgetDecision> {
    if (!isBudgetProvider(request.provider)) {
      return { allowed: true, granted: request.pollEquivalents, ladder: 'normal' };
    }
    const date = request.utcDate ?? utcDate(this.#options.now());
    const copy = await readBudgetCopy(this.#options.kv, request.provider, date);
    if (copy !== null && copy.blocked) {
      return {
        allowed: false,
        reason: copy.killSwitch ? 'provider_kill_switch' : 'provider_daily_cap',
      };
    }
    return this.#stub(request.provider, date).reserve({ ...request, utcDate: date });
  }

  /**
   * Refunds the day the reservation was DEBITED on (`request.utcDate`), not the day it is when
   * the refund arrives: a 429 answered at 00:00:00.3 for a reservation made at 23:59:59.9 gives
   * yesterday's units back to yesterday.
   */
  async release(request: BudgetRequest, unusedPollEquivalents: number): Promise<void> {
    if (!isBudgetProvider(request.provider) || unusedPollEquivalents <= 0) {
      return;
    }
    const date = request.utcDate ?? utcDate(this.#options.now());
    await this.#stub(request.provider, date).release(
      { ...request, utcDate: date },
      unusedPollEquivalents,
    );
  }

  /** A push-back slows the NEXT reservations, so it goes to today's object. */
  async backoff(provider: ProviderId, retryAfterMs: number): Promise<void> {
    if (!isBudgetProvider(provider)) {
      return;
    }
    await this.#stub(provider, utcDate(this.#options.now())).backoff(retryAfterMs);
  }

  #stub(provider: BudgetProvider, date: string): ProviderBudgetRpc {
    return this.#options.stubFor(providerBudgetNameFor(provider, date));
  }
}

/**
 * Two or more guards that must all allow a call. They are asked in order; when one refuses,
 * everything the earlier ones granted is released, so a refused call never leaves a debit behind.
 * `release` and `backoff` fan out to every guard.
 */
export function composeBudgets(...guards: readonly BudgetGuard[]): BudgetGuard {
  return {
    async reserve(request) {
      const granted: BudgetGuard[] = [];
      let ladder: 'normal' | 'warn' | 'degraded' = 'normal';
      for (const guard of guards) {
        const decision = await guard.reserve(request);
        if (!decision.allowed) {
          for (const earlier of granted) {
            await earlier.release?.(request, request.pollEquivalents);
          }
          return decision;
        }
        granted.push(guard);
        if (decision.ladder === 'degraded' || (decision.ladder === 'warn' && ladder === 'normal')) {
          ladder = decision.ladder;
        }
      }
      return { allowed: true, granted: request.pollEquivalents, ladder };
    },
    async release(request, unused) {
      for (const guard of guards) {
        await guard.release?.(request, unused);
      }
    },
    async backoff(provider, retryAfterMs) {
      for (const guard of guards) {
        await guard.backoff?.(provider, retryAfterMs);
      }
    },
  };
}

export type PerFlightDecision = 'ok' | 'soft_cap' | 'hard_cap';

export interface PerFlightLedgerInput {
  /** Poll-equivalents this flight has spent so far. */
  readonly spentPe: number;
  /** Poll-equivalents the next call would add. */
  readonly requestPe: number;
  readonly softCapPe?: number | undefined;
  readonly hardCapPe?: number | undefined;
}

/**
 * The per-flight rule the FlightTracker applies inside its alarm transaction (increment 7):
 * `hard_cap` when the call would take the flight past `A2_HARD_CAP_PE` (4x the expected spend:
 * delete alerts, stop polling, one reconciliation poll at scheduled arrival), `soft_cap` past
 * `A2_SOFT_CAP_PE` (2x: log a metric and stretch the cadence one tier), `ok` otherwise.
 */
export function perFlightLedgerDecision(input: PerFlightLedgerInput): PerFlightDecision {
  const soft = input.softCapPe ?? A2_SOFT_CAP_PE;
  const hard = input.hardCapPe ?? A2_HARD_CAP_PE;
  const after = input.spentPe + input.requestPe;
  if (after > hard) {
    return 'hard_cap';
  }
  return after > soft ? 'soft_cap' : 'ok';
}
