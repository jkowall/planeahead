/**
 * Provider router (increment 6).
 *
 * `providerFor` is the one place that decides which provider answers a cadence window, and it
 * encodes two rules:
 *
 *   1. While `AEROAPI_MODE=mock` (the default and the only Phase 0 mode), AeroDataBox answers
 *      EVERY window, including the ones the cadence assigns to AeroAPI. The cadence's `source`
 *      says who SHOULD answer; the call record's `provider` says who DID, and cost attribution
 *      always reads the record, never the cadence.
 *   2. Zero AeroAPI calls before T-48 h, in every mode. AeroAPI cannot see a flight more than two
 *      days out and its `/schedules` carries no status at four times the price (facts sheet
 *      section 2), so a pre-48 h window, or an AeroAPI window asked for too early, goes to
 *      AeroDataBox. The guard is STRICT, with `AEROAPI_STANDARD.horizonMarginMs` of margin: at
 *      exactly T-48 h (the first slot of every cadence's AeroAPI window) the flight sits on
 *      AeroAPI's exclusive 2-day horizon and no window it accepts contains it, so that slot is
 *      AeroDataBox's too. `test/unit/router.test.ts` walks every cadence to prove it.
 *
 * The contract a caller (the FlightTracker, increment 7) can rely on for cost: `getFlight` is ONE
 * billed call per lookup on a tracker's own triggers (`alarm`, `reconcile`, `user_refresh`,
 * `provider_alert`). Only a person-supplied date (`user_search`, `import`) buys AeroDataBox's
 * plus or minus one day retry, up to three calls. A tracker alarm never pays for three.
 *
 * The router is also the composition root for the adapters: it reads the keys and settings from
 * the environment, and supplies the one wall clock (`now`) and the one `fetch`. Nothing else in
 * `src/providers` reads either.
 */

import type { CadenceSource, FlightDataProvider } from '@planeahead/shared';
import type { Env } from '../env';
import { AeroApiAdapter, bracketWindow } from './aeroapi.mock';
import { AeroDataBoxAdapter } from './aerodatabox.adapter';
import { ProviderBudgetGuard, type ProviderBudgetRpc } from './budget';
import {
  AEROAPI_STANDARD,
  providerSettings,
  type ProviderSettings,
  type ProviderSettingsEnv,
} from './config';
import type { ProviderFetch } from './http';
import { isWellFormedWebhookToken } from './webhook-token';

/**
 * AeroAPI's horizon in minutes before scheduled out (T-48 h), derived from its 2-day lookahead.
 * AeroAPI is asked only STRICTLY inside it, by at least `AEROAPI_STANDARD.horizonMarginMs`.
 */
export const AEROAPI_EARLIEST_MINUTES_BEFORE_OUT = AEROAPI_STANDARD.maxDaysAhead * 24 * 60;

export interface RouterEnv extends ProviderSettingsEnv {
  readonly AERODATABOX_API_KEY?: string | undefined;
  /** Test seam (increment 7): the adapter's base URL; unset in every deployment. */
  readonly AERODATABOX_BASE_URL?: string | undefined;
  readonly AEROAPI_API_KEY?: string | undefined;
  readonly WEBHOOK_TOKEN_AEROAPI?: string | undefined;
  readonly API_PUBLIC_URL?: string | undefined;
}

export class ProviderConfigError extends Error {
  override readonly name = 'ProviderConfigError';
}

export interface RouterDeps {
  /** Defaults to the Worker's global `fetch`. */
  readonly fetch?: ProviderFetch | undefined;
  /** Defaults to the wall clock; only `parseWebhook` reads it (calls read `ctx.now`). */
  readonly now?: (() => Date) | undefined;
  /** Test seams: replace an adapter outright. */
  readonly aerodatabox?: FlightDataProvider | undefined;
  readonly aeroapi?: FlightDataProvider | undefined;
}

/** When the call would happen, relative to the flight; enables the T-48 h guard. */
export interface RoutingInstant {
  readonly scheduledOut: Date;
  readonly now: Date;
}

function defaultFetch(): ProviderFetch {
  return (request) => fetch(request);
}

function defaultNow(): Date {
  return new Date();
}

/**
 * The per-alert `target_url` for this environment (also the account-wide endpoint the adapter
 * sets before its first alert), or undefined when it cannot be built. The token must have the
 * shape the receiver accepts (`isWellFormedWebhookToken`): a URL with any other token would have
 * every delivery, each billed, answered 404 by our own route, so the adapter is refused one and
 * `registerAlert` fails loudly instead.
 */
export function aeroApiAlertTargetUrl(env: RouterEnv): string | undefined {
  const base = env.API_PUBLIC_URL;
  const token = env.WEBHOOK_TOKEN_AEROAPI;
  if (base === undefined || !isWellFormedWebhookToken(token)) {
    return undefined;
  }
  return `${base.replace(/\/+$/, '')}/v1/webhooks/aeroapi/${token}`;
}

/** The AeroDataBox adapter for this environment. Throws when the key is not configured. */
export function aerodataboxFor(
  env: RouterEnv,
  deps: RouterDeps = {},
  settings: ProviderSettings = providerSettings(env),
): FlightDataProvider {
  if (deps.aerodatabox !== undefined) {
    return deps.aerodatabox;
  }
  const apiKey = env.AERODATABOX_API_KEY;
  if (apiKey === undefined || apiKey === '') {
    throw new ProviderConfigError('AERODATABOX_API_KEY is not set');
  }
  const baseUrl = env.AERODATABOX_BASE_URL;
  return new AeroDataBoxAdapter({
    apiKey,
    fetch: deps.fetch ?? defaultFetch(),
    plan: settings.adbPlan,
    alertsEnabled: settings.adbAlertsEnabled,
    // Increment 7: the Workers suite serves AeroDataBox from test/fake-providers.ts; a deployment
    // never sets the variable and gets the adapter's own default.
    baseUrl: baseUrl === undefined || baseUrl === '' ? undefined : baseUrl,
    now: deps.now ?? defaultNow,
  });
}

/** The AeroAPI adapter. Throws when the key is not configured; never used in `mock` mode. */
export function aeroapiFor(env: RouterEnv, deps: RouterDeps = {}): FlightDataProvider {
  if (deps.aeroapi !== undefined) {
    return deps.aeroapi;
  }
  const apiKey = env.AEROAPI_API_KEY;
  if (apiKey === undefined || apiKey === '') {
    throw new ProviderConfigError('AEROAPI_API_KEY is not set but AEROAPI_MODE is live');
  }
  return new AeroApiAdapter({
    apiKey,
    fetch: deps.fetch ?? defaultFetch(),
    alertTargetUrl: aeroApiAlertTargetUrl(env),
    now: deps.now ?? defaultNow,
  });
}

/**
 * True when AeroAPI may be asked about a flight at `at`: strictly inside T-48 h, by at least
 * `AEROAPI_STANDARD.horizonMarginMs` (to the whole second AeroAPI's `end` is sent in). At T-48 h
 * itself the flight is on AeroAPI's exclusive horizon and outside every window it accepts; asked
 * then, it would answer with the previous day's instance at the window's inclusive start.
 * Defined as "the adapter's first fetch would contain the flight" (`bracketWindow`), so the guard
 * and the bracket cannot disagree at any instant.
 */
export function aeroApiAllowedAt(at: RoutingInstant): boolean {
  return bracketWindow(at.scheduledOut, at.now) !== null;
}

/**
 * The provider that answers a window whose cadence source is `source`. Pass `at` from every
 * tracker call site: without it the T-48 h guard cannot run, and a caller that routes an
 * AeroAPI window without saying when is refused in `live` mode.
 */
export function providerFor(
  source: CadenceSource,
  env: RouterEnv,
  deps: RouterDeps = {},
  at?: RoutingInstant,
): FlightDataProvider {
  const settings = providerSettings(env);
  if (source === 'aerodatabox' || settings.aeroapiMode === 'mock') {
    return aerodataboxFor(env, deps, settings);
  }
  if (at === undefined) {
    throw new ProviderConfigError(
      'an AeroAPI window needs the routing instant so the T-48 h guard can run',
    );
  }
  if (!aeroApiAllowedAt(at)) {
    return aerodataboxFor(env, deps, settings);
  }
  return aeroapiFor(env, deps);
}

/**
 * The provider-wide daily budget for this environment: the KV fast path in `CACHE` in front of
 * the day's ProviderBudget object. `locationHint: 'enam'` because a fresh object is created each
 * UTC day wherever the first call of the day happens to come from, and pinning it removes that
 * daily lottery on the latency of every debit (the FlightTracker call sites use the same hint).
 */
export function budgetGuardFor(
  env: Pick<Env, 'PROVIDER_BUDGET' | 'CACHE'>,
  now: () => Date = defaultNow,
): ProviderBudgetGuard {
  return new ProviderBudgetGuard({
    stubFor: (name): ProviderBudgetRpc =>
      env.PROVIDER_BUDGET.getByName(name, { locationHint: 'enam' }),
    kv: env.CACHE,
    now,
  });
}
