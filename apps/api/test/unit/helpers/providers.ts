/**
 * Test doubles for the provider layer: a `ProviderCallContext` whose budget and cost logger
 * record what the adapter asked of them, a clock the test controls, and a `fetch` that serves
 * fixtures and records every request. No test reaches a real provider: the adapters only ever
 * see the `fetch` given here.
 */

import type {
  BudgetDecision,
  BudgetGuard,
  BudgetRequest,
  FlightKey,
  ProviderCallContext,
  ProviderCallRecord,
  ProviderCallTrigger,
  ProviderId,
} from '@planeahead/shared';
import type { ProviderFetch } from '../../../src/providers/http';

export interface Fixture {
  readonly synthetic?: boolean;
  readonly schema: string | null;
  readonly note?: string;
  readonly request: { readonly method: string; readonly path: string };
  readonly response: {
    readonly status: number;
    readonly contentType?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: unknown;
  };
}

/** The fixture's response as a real `Response`. */
export function fixtureResponse(fixture: Fixture): Response {
  const { status, contentType, headers, body } = fixture.response;
  const init: ResponseInit = { status, headers: { ...headers } };
  if (body === undefined) {
    return new Response(null, init);
  }
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, {
    ...init,
    headers: { ...headers, 'content-type': contentType ?? 'application/json' },
  });
}

export interface RecordedFetch {
  readonly fetch: ProviderFetch;
  readonly requests: Request[];
  /** The request URLs, for assertions. */
  readonly urls: () => URL[];
}

/** A fetch that answers every request with `respond(request, index)` and records it. */
export function fetchStub(
  respond: (request: Request, index: number) => Response | Promise<Response>,
): RecordedFetch {
  const requests: Request[] = [];
  return {
    requests,
    urls: () => requests.map((request) => new URL(request.url)),
    fetch: async (request) => {
      requests.push(request.clone());
      return respond(request, requests.length - 1);
    },
  };
}

/** A fetch that answers with the fixtures in order (the last one repeats). */
export function fixtureFetch(...fixtures: Fixture[]): RecordedFetch {
  return fetchStub((_request, index) => {
    const fixture = fixtures[Math.min(index, fixtures.length - 1)];
    if (fixture === undefined) {
      throw new Error('fixtureFetch needs at least one fixture');
    }
    return fixtureResponse(fixture);
  });
}

export interface ContextRecorder {
  readonly ctx: ProviderCallContext;
  /** Every record the adapter logged itself (the attempts it does not return). */
  readonly logged: ProviderCallRecord[];
  readonly reservations: BudgetRequest[];
  readonly releases: { request: BudgetRequest; unused: number }[];
  readonly backoffs: { provider: ProviderId; retryAfterMs: number }[];
  /** Moves the clock the adapter reads. */
  setNow(date: Date | string): void;
}

export interface ContextOptions {
  readonly now?: Date | string;
  readonly trigger?: ProviderCallTrigger;
  readonly flightKey?: FlightKey;
  /** Decides each reservation; allows everything by default. */
  readonly decide?: (request: BudgetRequest, index: number) => BudgetDecision;
}

export function providerContext(options: ContextOptions = {}): ContextRecorder {
  let now = new Date(options.now ?? '2026-09-22T20:00:00Z');
  const logged: ProviderCallRecord[] = [];
  const reservations: BudgetRequest[] = [];
  const releases: { request: BudgetRequest; unused: number }[] = [];
  const backoffs: { provider: ProviderId; retryAfterMs: number }[] = [];
  const budget: BudgetGuard = {
    reserve: (request) => {
      reservations.push(request);
      const decision = options.decide?.(request, reservations.length - 1) ?? {
        allowed: true,
        granted: request.pollEquivalents,
        ladder: 'normal',
      };
      return Promise.resolve(decision);
    },
    release: (request, unused) => {
      releases.push({ request, unused });
      return Promise.resolve();
    },
    backoff: (provider, retryAfterMs) => {
      backoffs.push({ provider, retryAfterMs });
      return Promise.resolve();
    },
  };
  const ctx: ProviderCallContext = {
    trigger: options.trigger ?? 'alarm',
    flightKey: options.flightKey,
    requestId: 'req-provider-test',
    budget,
    log: {
      record: (call) => {
        logged.push(call);
      },
    },
    now: () => now,
  };
  return {
    ctx,
    logged,
    reservations,
    releases,
    backoffs,
    setNow: (date) => {
      now = new Date(date);
    },
  };
}
