/**
 * Airport boards and the route search (increment 18, ruling B12): server data only. Both are read
 * with TanStack Query through the typed client and live in the query cache (memory) for as long as
 * a screen uses them; nothing here is written to the offline store, because the provider's cache
 * terms ask for as few copies as possible (R3 F13). Every answer is parsed with the shared
 * contract (`AirportBoardResponseSchema`, `RouteSearchResponseSchema`): it is data from the network.
 *
 * Neither query retries on its own (`retry: false`): every refusal the routes give is final for
 * the moment (403, 404, 422, 429), a 503 asks for 30 s, and each route search takes one of the
 * day's `route_searches` slots, so only a pull or a new search asks again. The route search is
 * also never refetched on focus or reconnect, for the same reason.
 *
 * Adding a row's flight is the app's one add path: `addFlight` (the optimistic row and the queued
 * `POST /v1/flights` with the row's `add`: designator, origin-local date, origin) and the same
 * drain and refusal handling as the add sheet (src/app/(app)/add.tsx).
 */

import {
  AirportBoardResponseSchema,
  FREE_TIER_LIMITS,
  IATA_AIRPORT_RE,
  ICAO_AIRPORT_RE,
  IsoDateSchema,
  RouteSearchResponseSchema,
  type AirportBoardResponse,
  type BoardDirection,
  type BoardViewRow,
  type RouteSearchResponse,
} from '@planeahead/shared';
import { onlineManager, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Alert } from 'react-native';
import * as z from 'zod';
import type { ApiClient } from './api-client';
import { useFlightNotices } from './flight-notices';
import { addFlight, drainFor, normaliseDateInput, validateAddFlight } from './flights';
import { formatIsoDate } from './format';
import { services } from './services';

/** Why a board or a route search could not be shown, from the route's status and code. */
export type BoardFailure =
  | 'offline'
  | 'signed_out'
  | 'requires_account'
  | 'cap_exceeded'
  | 'rate_limited'
  | 'airport_not_found'
  | 'not_covered'
  | 'out_of_range'
  | 'invalid'
  | 'unavailable'
  | 'timeout'
  | 'other';

export class BoardLoadError extends Error {
  override readonly name = 'BoardLoadError';
  readonly failure: BoardFailure;
  /** The HTTP status, or null when no answer arrived. */
  readonly status: number | null;
  /** The cap's limit (403 `cap_exceeded`) or the lookahead (422), when the answer gave one. */
  readonly limit: number | undefined;
  readonly maxDaysAhead: number | undefined;
  /** `Retry-After` in seconds (429, 503). */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    failure: BoardFailure,
    status: number | null,
    details: {
      readonly limit?: number | undefined;
      readonly maxDaysAhead?: number | undefined;
      readonly retryAfterSeconds?: number | undefined;
    } = {},
  ) {
    super(`board load failed: ${failure}${status === null ? '' : ` (${String(status)})`}`);
    this.failure = failure;
    this.status = status;
    this.limit = details.limit;
    this.maxDaysAhead = details.maxDaysAhead;
    this.retryAfterSeconds = details.retryAfterSeconds;
  }
}

const RefusalSchema = z.looseObject({
  error: z.string(),
  limit: z.number().optional(),
  maxDaysAhead: z.number().optional(),
});

function retryAfter(header: string | null): number | undefined {
  if (header === null) {
    return undefined;
  }
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/** The failure a non-200 answer names: by status and envelope code, never by the message. */
export function failureOf(status: number, body: unknown, retryAfterHeader: string | null) {
  const envelope = RefusalSchema.safeParse(body);
  const code = envelope.success ? envelope.data.error : null;
  const details = {
    limit: envelope.data?.limit,
    maxDaysAhead: envelope.data?.maxDaysAhead,
    retryAfterSeconds: retryAfter(retryAfterHeader),
  };
  const failure = ((): BoardFailure => {
    switch (status) {
      case 400:
        return 'invalid';
      case 401:
        return 'signed_out';
      case 403:
        return code === 'board_requires_account'
          ? 'requires_account'
          : code === 'cap_exceeded'
            ? 'cap_exceeded'
            : 'other';
      case 404:
        return code === 'board_not_covered' ? 'not_covered' : 'airport_not_found';
      case 422:
        return code === 'date_out_of_range' ? 'out_of_range' : 'invalid';
      case 429:
        return 'rate_limited';
      case 503:
        return 'unavailable';
      case 504:
        return 'timeout';
      default:
        return 'other';
    }
  })();
  return new BoardLoadError(failure, status, details);
}

interface Answer {
  readonly status: number;
  readonly headers: Headers;
  json(): Promise<unknown>;
}

/** The answer's body when it is a 200 the schema accepts; otherwise the failure, thrown. */
async function read<T>(
  call: () => Promise<Answer>,
  schema: { safeParse(body: unknown): { success: true; data: T } | { success: false } },
): Promise<T> {
  let response: Answer;
  try {
    response = await call();
  } catch {
    // No answer at all: no connection, or the request never left the phone.
    throw new BoardLoadError('offline', null);
  }
  const body = await response.json().catch(() => null);
  if (response.status !== 200) {
    throw failureOf(response.status, body, response.headers.get('Retry-After'));
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new BoardLoadError('other', response.status);
  }
  return parsed.data;
}

/** `GET /v1/airports/{code}/board?direction=`: the default window (an hour ago, for 12 hours). */
export function fetchBoard(
  api: Pick<ApiClient, 'v1'>,
  code: string,
  direction: BoardDirection,
): Promise<AirportBoardResponse> {
  return read(
    () => api.v1.airports[':code'].board.$get({ param: { code }, query: { direction } }),
    AirportBoardResponseSchema,
  );
}

export interface RouteSearchInput {
  readonly origin: string;
  readonly destination: string;
  /** The origin-local date, `YYYY-MM-DD`. */
  readonly date: string;
}

/** `GET /v1/airports/{origin}/flights/to/{destination}?date=`. */
export function fetchRouteSearch(
  api: Pick<ApiClient, 'v1'>,
  search: RouteSearchInput,
): Promise<RouteSearchResponse> {
  return read(
    () =>
      api.v1.airports[':origin'].flights.to[':destination'].$get({
        param: { origin: search.origin, destination: search.destination },
        query: { date: search.date },
      }),
    RouteSearchResponseSchema,
  );
}

function waitPhrase(seconds: number | undefined): string {
  return seconds === undefined || seconds >= 60
    ? 'Wait a minute'
    : `Wait ${String(Math.max(1, Math.ceil(seconds)))} seconds`;
}

/** What the board screen says when a board cannot be shown. */
export function boardFailureMessage(error: BoardLoadError, airport: string): string {
  switch (error.failure) {
    case 'offline':
      return 'Could not reach PlaneAhead. Check your connection and pull down to try again.';
    case 'signed_out':
      return 'Sign in again to open airport boards.';
    case 'requires_account':
      return 'Without an account, boards open only for the airports of your flights. Sign in to open any airport’s board.';
    case 'rate_limited':
      return `Too many boards opened in a short time. ${waitPhrase(error.retryAfterSeconds)} and pull down to try again.`;
    case 'airport_not_found':
      return `No airport has the code ${airport}.`;
    case 'not_covered':
      return `Flight data does not cover ${airport}, so it has no board.`;
    case 'out_of_range':
      return 'This board is outside the dates flight data covers.';
    case 'unavailable':
      return 'Flight data is unavailable right now. Pull down to try again in a minute.';
    case 'timeout':
      return 'The board took too long to load. Pull down to try again.';
    case 'cap_exceeded':
    case 'invalid':
    case 'other':
      return 'The board could not be loaded right now. Pull down to try again later.';
  }
}

/** What the route-search screen says when a search cannot be answered. */
export function routeSearchFailureMessage(error: BoardLoadError, search: RouteSearchInput): string {
  switch (error.failure) {
    case 'offline':
      return 'Could not reach PlaneAhead. Check your connection and search again.';
    case 'signed_out':
      return 'Sign in again to search by route.';
    case 'cap_exceeded':
      return `Route searches are limited to ${String(error.limit ?? FREE_TIER_LIMITS.routeSearchesPerDay)} a day, and today’s are used up. Search again tomorrow, or add the flight by its number.`;
    case 'rate_limited':
      return `Too many searches in a short time. ${waitPhrase(error.retryAfterSeconds)} and search again.`;
    case 'airport_not_found':
      return `No airport was found for ${search.origin} or ${search.destination}. Check the codes.`;
    case 'not_covered':
      return `Flight data does not cover ${search.origin}, so its flights cannot be searched.`;
    case 'out_of_range':
      return error.maxDaysAhead === undefined
        ? 'That date is outside the dates flight data covers.'
        : `Flights can be searched up to ${String(error.maxDaysAhead)} days ahead, and not long past.`;
    case 'invalid':
      return 'Check the airports and the date: the destination cannot be the origin.';
    case 'unavailable':
      return 'Flight data is unavailable right now. Search again in a minute.';
    case 'timeout':
      return 'The search took too long. Search again.';
    case 'requires_account':
    case 'other':
      return 'The search could not be answered right now. Try again later.';
  }
}

/** TanStack's online state (fed by expo-network, src/lib/query.ts), as a render value. */
export function useIsOnline(): boolean {
  return useSyncExternalStore(
    (listener) => onlineManager.subscribe(listener),
    () => onlineManager.isOnline(),
  );
}

/** A route search answer stays usable this long before a pull asks again. */
export const ROUTE_SEARCH_STALE_MS = 5 * 60_000;

export const boardQueryKey = (code: string, direction: BoardDirection) =>
  ['airport-board', code, direction] as const;

export const routeSearchQueryKey = (search: RouteSearchInput | null) =>
  ['route-search', search?.origin ?? '', search?.destination ?? '', search?.date ?? ''] as const;

export function useAirportBoard(code: string, direction: BoardDirection) {
  return useQuery<AirportBoardResponse, BoardLoadError>({
    queryKey: boardQueryKey(code, direction),
    queryFn: async () => fetchBoard((await services()).api, code, direction),
    enabled: code !== '',
    retry: false,
  });
}

export function useRouteSearch(search: RouteSearchInput | null) {
  return useQuery<RouteSearchResponse, BoardLoadError>({
    queryKey: routeSearchQueryKey(search),
    queryFn: async () => {
      if (search === null) {
        throw new BoardLoadError('invalid', null);
      }
      return fetchRouteSearch((await services()).api, search);
    },
    enabled: search !== null,
    retry: false,
    staleTime: ROUTE_SEARCH_STALE_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export interface BoardAddOutcome {
  readonly tone: 'info' | 'danger';
  readonly text: string;
}

/**
 * Adds a row's flight through `addFlight` with the row's `add` (designator, origin-local date and
 * origin), then drains as the add sheet does, so a refusal is said in place. A screen closed
 * while the add was in flight gets null, and the refusal goes to the home screen instead.
 */
export async function addBoardRow(
  row: BoardViewRow,
  isMounted: () => boolean = () => true,
): Promise<BoardAddOutcome | null> {
  const validation =
    row.add === undefined
      ? null
      : validateAddFlight({ number: row.add.number, date: row.add.date });
  if (row.add === undefined || validation === null || !validation.ok) {
    return {
      tone: 'danger',
      text: `${row.designator} cannot be added from here. Add it by its flight number instead.`,
    };
  }
  const { designator, date } = validation.value;
  const on = `${designator} on ${formatIsoDate(date)}`;
  try {
    const { store, outbox } = await services();
    const added = addFlight(store.sqlite, { designator, date, origin: row.add.origin });
    if (added.kind === 'already_tracked') {
      return { tone: 'info', text: `You already track ${on}.` };
    }
    const drained = await drainFor(outbox, store.sqlite, added.outboxId);
    const refused = useFlightNotices.getState().take(added.subscriptionId);
    if (!isMounted()) {
      if (refused !== null) {
        useFlightNotices.getState().push(refused);
      }
      return null;
    }
    if (refused !== null) {
      return { tone: 'danger', text: refused.message };
    }
    return drained === 'queued'
      ? {
          tone: 'info',
          text: `${on} is in your flights. It is added as soon as PlaneAhead can be reached.`,
        }
      : { tone: 'info', text: `Added ${on} to your flights.` };
  } catch {
    return { tone: 'danger', text: 'The flight could not be saved on this phone. Try again.' };
  }
}

export interface RowAdd {
  /** The id of the row whose add is running, or null. */
  readonly addingId: string | null;
  /** What the last add came to, until dismissed. */
  readonly outcome: BoardAddOutcome | null;
  readonly dismiss: () => void;
  /** Asks to confirm (`Add BA117?` with the summary), then adds. One add at a time. */
  readonly confirm: (row: BoardViewRow, summary: string) => void;
}

/**
 * Tap to add, for the board and the route search: a confirmation first (an add takes one of the
 * free plan's few tracked flights, and a list of hundreds is easy to mis-tap), then `addBoardRow`.
 */
export function useRowAdd(): RowAdd {
  const [addingId, setAddingId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<BoardAddOutcome | null>(null);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = async (row: BoardViewRow) => {
    running.current = true;
    setOutcome(null);
    setAddingId(row.id);
    const result = await addBoardRow(row, () => mounted.current);
    running.current = false;
    if (mounted.current) {
      setAddingId(null);
      setOutcome(result);
    }
  };

  const confirm = (row: BoardViewRow, summary: string) => {
    if (row.add === undefined || running.current) {
      return;
    }
    Alert.alert(`Add ${row.designator}?`, summary, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Add',
        onPress: () => {
          void run(row);
        },
      },
    ]);
  };

  return {
    addingId,
    outcome,
    dismiss: () => {
      setOutcome(null);
    },
    confirm,
  };
}

const AIRPORT_CODE_HELP = 'Use a 3-letter IATA or 4-letter ICAO airport code, e.g. JFK or KJFK.';

/** An airport code as the routes take it (IATA or ICAO), upper-cased, or the field's error. */
export function validateAirportCode(
  input: string,
): { readonly ok: true; readonly code: string } | { readonly ok: false; readonly error: string } {
  const code = input.trim().toUpperCase();
  if (code === '') {
    return { ok: false, error: 'Enter an airport code, e.g. JFK.' };
  }
  return IATA_AIRPORT_RE.test(code) || ICAO_AIRPORT_RE.test(code)
    ? { ok: true, code }
    : { ok: false, error: AIRPORT_CODE_HELP };
}

export type RouteSearchErrors = Partial<Record<keyof RouteSearchInput, string>>;

/** The route-search form: two airport codes that differ and a real date, as the route checks. */
export function validateRouteSearch(
  input: RouteSearchInput,
):
  | { readonly ok: true; readonly value: RouteSearchInput }
  | { readonly ok: false; readonly errors: RouteSearchErrors } {
  const errors: RouteSearchErrors = {};
  const origin = validateAirportCode(input.origin);
  const destination = validateAirportCode(input.destination);
  const date = normaliseDateInput(input.date);
  if (!origin.ok) {
    errors.origin = origin.error;
  }
  if (!destination.ok) {
    errors.destination = destination.error;
  } else if (origin.ok && origin.code === destination.code) {
    errors.destination = 'The destination cannot be the origin.';
  }
  if (date === '') {
    errors.date = 'Enter the departure date.';
  } else if (!IsoDateSchema.safeParse(date).success) {
    errors.date = 'Use a real date as YYYY-MM-DD, e.g. 2026-09-24.';
  }
  if (!origin.ok || !destination.ok || Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value: { origin: origin.code, destination: destination.code, date } };
}
