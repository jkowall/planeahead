/**
 * Flight mutations (increment 10, ruling T2), and the one direct call, refresh (ruling T3).
 *
 * Every network WRITE goes through the outbox; no component mutates anything itself:
 *
 * - `addFlight` writes the optimistic `flight_subscriptions` row and its `POST /v1/flights`
 *   outbox row in ONE immediate transaction (`commitWrite`, which signals both tables after the
 *   COMMIT). The row's id is a client-minted uuidv7 and is the `subscriptionId` the POST sends, so
 *   the server's row carries the same id and the next sync page lands on it (the server's row wins
 *   on the same id). The outbox row names that id as `entityId`, so a snapshot replace keeps the
 *   row while the POST is queued (increment 9). The drain then sends it with `Idempotency-Key`
 *   and `X-Install-Id`. The row also records the designator the user typed (`added_as`, local
 *   only), which the card and the detail show. A flight the store already tracks is answered
 *   locally (`findTracked`): by flight key first, then by any name a live row is known by on that
 *   date (the one typed here, the operating designator, the snapshot's marketing designator and
 *   codeshares, IATA and ICAO; ruling Y3), so re-typing the name a card shows says so. A pending
 *   add that a pull later shows the store already holds (the flight arrived after the add was
 *   queued) is marked superseded and hidden (src/lib/sync/local-intent.ts), and its POST settles
 *   it.
 * - `reconcileSent` is the outbox's `onSent` hook. On the subscribe's 201 it writes the server's
 *   row and the flight snapshot from the answer, so the list shows the scheduled times at once
 *   rather than after the next pull. The answer's `created` decides the rest (ruling X7):
 *   - 200 `created: false` under ANOTHER id: the account already held the flight and the add
 *     was a no-op on the server. The optimistic row is deleted, and so is every queued mutation
 *     naming it (a DELETE queued while the add was in flight is dropped, never pointed at the
 *     server's row: the user removed the add, not the flight they already had), and its
 *     tombstone is never copied onto the server's row. The server's row and its flight are still
 *     written, so the list keeps one row for the flight between the answer and the next pull.
 *   - `created: true` under another id (a restored tombstone): the add really made that row live,
 *     so a DELETE queued for the optimistic id is pointed at it and the tombstone follows.
 *   Either way the replacement is recorded for an open detail screen
 *   (src/lib/flight-replacements.ts).
 *   A settled `DELETE /v1/flights/:id` removes its local tombstone for good.
 * - `reconcileRefused` is the `onRefused` hook: a refused subscribe (403 `cap_exceeded`, 404
 *   `flight_not_found`, 410, 422 `date_out_of_range`, 400) removes the optimistic row and any
 *   mutation queued behind it for that row, in the transaction that drops the outbox row; a
 *   DELETE refused with 404 (the server has no such subscription) removes the local tombstone.
 *   `refusalMessage` turns the answer into the text the add sheet (or the home screen) shows:
 *   the free-tier cap and limit from the payload, the dates the search tried, and a generic
 *   sentence for a code this build does not know (the code itself goes to Sentry only).
 * - 422 `idempotency_payload_mismatch` never reaches here: the outbox regenerates the key and
 *   services.ts reports it to Sentry without the body.
 * - `removeFlight` tombstones the row locally and queues `DELETE /v1/flights/:id`, except for an
 *   add whose POST has never left the phone (no `last_attempt_at`): that POST and the optimistic
 *   row are deleted in one transaction and nothing is queued, so a cancelled typo costs no tracker,
 *   no provider call and no daily add. The outbox never stamps while the phone knows it is
 *   offline (ruling Y1), so an add made offline stays cancellable.
 *
 * Refresh is not a write through the outbox: it carries no key and changes nothing locally until
 * it answers, and replaying a stale refresh later would spend a provider call for nothing. It is
 * called directly, at most once per gesture (the screen's hook), under the 8 s deadline UX; its
 * answer's flight snapshot is applied only when not null and not older than the stored one. A 410
 * `flight_archived` stamps `finished_at` on the subscription by its id, with or without a flight
 * in the answer; a 401 `account_deleted` runs the same `forgetAccount` path as the outbox and the
 * sync client.
 */

import * as Sentry from '@sentry/react-native';
import {
  CARRIER_IATA_TO_ICAO_FALLBACK,
  DO_CALL_DEADLINE_MS,
  FREE_TIER_LIMITS,
  FlightKeySchema,
  FlightStatusSchema,
  FlightSubscriptionRowV1,
  IsoDateSchema,
  SubscribeFlightBodySchema,
  SyncFlightV1,
  parseDesignator,
  parseFlightKey,
  resolveCarrierIcao,
  uuidv7,
  type CapName,
} from '@planeahead/shared';
import { z } from 'zod';
import type { ApiClient, RawResponse } from './api-client';
import type { SqliteLike } from './db/sqlite-like';
import { commitWrite, type StoreTable } from './db/store-signal';
import {
  liveRowNamed,
  PENDING_KEY_PREFIX,
  pendingFlightKey,
  toFlightItem,
  type FlightRowRecord,
} from './flight-model';
import { recordReplacement } from './flight-replacements';
import { formatDateList, formatIsoDate } from './format';
import { applySnapshot, upsertSubscription } from './sync/apply';
import { useFlightNotices } from './flight-notices';
import { markSupersededPending, reapplyQueuedUnsubscribes } from './sync/local-intent';
import {
  enqueueMutation,
  type DrainResult,
  type DroppedMutation,
  type OutboxDeps,
  type OutboxItem,
} from './sync/outbox';
import { isUnsubscribe, SUBSCRIBE_MUTATION, wipeLocalStore } from './sync/store';

// ---------------------------------------------------------------------------------------------
// Validation (the shared `parseDesignator` and `IsoDateSchema`, the API's own rules).
// ---------------------------------------------------------------------------------------------

export interface AddFlightInput {
  readonly number: string;
  readonly date: string;
}

export interface AddFlightRequest {
  /** Normalised marketing designator, e.g. `AA100` for `aa 0100`. */
  readonly designator: string;
  /** Origin-local departure date `YYYY-MM-DD`. */
  readonly date: string;
}

export type AddFlightErrors = Partial<Record<keyof AddFlightInput, string>>;

export type AddFlightValidation =
  | { readonly ok: true; readonly value: AddFlightRequest }
  | { readonly ok: false; readonly errors: AddFlightErrors };

function normaliseDesignator(input: string): string | null {
  try {
    const parsed = parseDesignator(input);
    const carrier = parsed.carrier.iata ?? parsed.carrier.icao ?? '';
    return `${carrier}${parsed.number}${parsed.suffix ?? ''}`;
  } catch {
    return null;
  }
}

/**
 * The date as the sheet's number pad types it: eight digits (`20260926`) read as `YYYY-MM-DD`.
 * Anything else is left as it is for `IsoDateSchema` to judge.
 */
export function normaliseDateInput(input: string): string {
  const date = input.trim();
  const digits = /^([0-9]{4})([0-9]{2})([0-9]{2})$/.exec(date);
  return digits === null ? date : `${digits[1] ?? ''}-${digits[2] ?? ''}-${digits[3] ?? ''}`;
}

/** The add-flight sheet's validation: the same designator and date rules the API applies. */
export function validateAddFlight(input: AddFlightInput): AddFlightValidation {
  const errors: AddFlightErrors = {};
  const number = input.number.trim();
  const date = normaliseDateInput(input.date);
  const designator = number === '' ? null : normaliseDesignator(number);
  if (number === '') {
    errors.number = 'Enter the flight number, e.g. AA100.';
  } else if (designator === null) {
    errors.number = 'That is not a flight number. Use the airline code and number, e.g. AA100.';
  }
  if (date === '') {
    errors.date = 'Enter the departure date.';
  } else if (!IsoDateSchema.safeParse(date).success) {
    errors.date = 'Use a real date as YYYY-MM-DD, e.g. 2026-09-24.';
  }
  if (designator === null || errors.date !== undefined) {
    return { ok: false, errors };
  }
  return { ok: true, value: { designator, date } };
}

// ---------------------------------------------------------------------------------------------
// Add and remove.
// ---------------------------------------------------------------------------------------------

export interface AddFlightResult {
  readonly kind: 'queued';
  readonly subscriptionId: string;
  readonly outboxId: string;
}

export interface AlreadyTracked {
  readonly kind: 'already_tracked';
  readonly subscriptionId: string;
}

export interface MutationOptions {
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/**
 * The operating carrier (ICAO), number and date a typed designator keys as when it is not a
 * codeshare, or null when this build cannot resolve the carrier offline.
 */
function probableKeyParts(
  request: AddFlightRequest,
): { readonly carrierIcao: string; readonly number: string; readonly date: string } | null {
  try {
    const parsed = parseDesignator(request.designator);
    const carrierIcao = resolveCarrierIcao(parsed.carrier, CARRIER_IATA_TO_ICAO_FALLBACK);
    return carrierIcao === undefined
      ? null
      : { carrierIcao, number: `${parsed.number}${parsed.suffix ?? ''}`, date: request.date };
  } catch {
    return null;
  }
}

/**
 * A live row that already tracks this add. First by FLIGHT KEY (increment 10 review): a pending
 * row with the same placeholder key, or a synced row whose key has the designator's operating
 * carrier, number and date. Then by name (ruling Y3): a synced row that `pendingMatchesLive` would
 * match, known on that date by the typed designator (the one typed here, the operating one, the
 * snapshot's marketing designator or a codeshare, in IATA or ICAO spelling). A codeshare no row
 * here is known by is queued, and the server's 200 `created: false` settles it (see the header).
 */
export function findTracked(db: SqliteLike, request: AddFlightRequest): string | null {
  const placeholder = pendingFlightKey(request.designator, request.date);
  const wanted = probableKeyParts(request);
  const rows = db.all<FlightRowRecord>(
    'SELECT * FROM flight_subscriptions WHERE deleted_at IS NULL AND id IS NOT NULL',
  );
  for (const row of rows) {
    if (row.flight_key === placeholder) {
      return row.id;
    }
    if (wanted === null || row.flight_key.startsWith(PENDING_KEY_PREFIX)) {
      continue;
    }
    try {
      const key = parseFlightKey(row.flight_key);
      if (
        key.operatingCarrierIcao === wanted.carrierIcao &&
        key.flightNumber === wanted.number &&
        key.scheduledDepartureDateLocal === wanted.date
      ) {
        return row.id;
      }
    } catch {
      // A key this build cannot read tracks nothing it could compare.
    }
  }
  const named = rows
    .map(toFlightItem)
    .find((item) => liveRowNamed(item, request.designator, request.date));
  return named?.id ?? null;
}

/**
 * Writes the optimistic row and queues `POST /v1/flights { subscriptionId, number, date }` in one
 * immediate transaction (see the header). A flight the store already tracks is not queued again.
 */
export function addFlight(
  db: SqliteLike,
  request: AddFlightRequest,
  options: MutationOptions = {},
): AddFlightResult | AlreadyTracked {
  const existing = findTracked(db, request);
  if (existing !== null) {
    return { kind: 'already_tracked', subscriptionId: existing };
  }
  const subscriptionId = (options.newId ?? uuidv7)();
  const now = (options.now ?? (() => new Date(Date.now())))();
  const stamp = now.toISOString();
  // The API's own contract, so a body the route would refuse with 400 never reaches the queue.
  const body = SubscribeFlightBodySchema.parse({
    subscriptionId,
    number: request.designator,
    date: request.date,
  });
  const item = commitWrite(db, ['flight_subscriptions', 'outbox'], (): OutboxItem => {
    db.run(
      `INSERT INTO flight_subscriptions (
         id, flight_key, muted, notification_overrides, source, live_tracked, created_at,
         updated_at, added_as
       ) VALUES (?, ?, 0, '{}', 'app', 0, ?, ?, ?)`,
      [
        subscriptionId,
        pendingFlightKey(request.designator, request.date),
        stamp,
        stamp,
        request.designator,
      ],
    );
    return enqueueMutation(db, { ...SUBSCRIBE_MUTATION, body, entityId: subscriptionId }, { now });
  });
  return { kind: 'queued', subscriptionId, outboxId: item.id };
}

export type RemoveResult = 'cancelled' | 'queued';

/**
 * Stops tracking a flight, in one transaction. An add whose POST has never been sent is cancelled
 * outright (the POST and the optimistic row go, nothing is queued); anything else is tombstoned
 * now and `DELETE /v1/flights/:id` is queued (see the header).
 */
export function removeFlight(
  db: SqliteLike,
  id: string,
  options: MutationOptions = {},
): RemoveResult {
  const now = (options.now ?? (() => new Date(Date.now())))();
  return commitWrite(db, ['flight_subscriptions', 'outbox'], (): RemoveResult => {
    const unsent = db.get<{ id: string }>(
      `SELECT id FROM outbox
         WHERE entity_id = ? AND method = ? AND path = ? AND last_attempt_at IS NULL AND attempts = 0`,
      [id, SUBSCRIBE_MUTATION.method, SUBSCRIBE_MUTATION.path],
    );
    if (unsent !== null) {
      db.run('DELETE FROM outbox WHERE entity_id = ?', [id]);
      db.run('DELETE FROM flight_subscriptions WHERE id = ?', [id]);
      return 'cancelled';
    }
    db.run(
      'UPDATE flight_subscriptions SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
      [now.toISOString(), now.toISOString(), id],
    );
    enqueueMutation(db, { method: 'DELETE', path: `/v1/flights/${id}`, entityId: id }, { now });
    return 'queued';
  });
}

/** Whether a mutation is still queued (not yet answered for good). */
export function isQueued(db: SqliteLike, outboxId: string): boolean {
  return db.get<{ id: string }>('SELECT id FROM outbox WHERE id = ?', [outboxId]) !== null;
}

/**
 * Drains until `outboxId` has been answered for good or the queue has to wait (offline, a
 * backoff). A drain already in flight is shared (src/lib/sync/outbox.ts), and one that had just
 * found the queue empty may resolve without having seen an item queued a moment later, so a
 * second pass runs when the first drained everything but this item is still there.
 */
export async function drainFor(
  outbox: { drain(): Promise<DrainResult> },
  db: SqliteLike,
  outboxId: string,
): Promise<'settled' | 'queued'> {
  for (let pass = 0; pass < 2; pass += 1) {
    const result = await outbox.drain();
    if (!isQueued(db, outboxId)) {
      return 'settled';
    }
    if (result.kind !== 'drained') {
      return 'queued';
    }
  }
  return isQueued(db, outboxId) ? 'queued' : 'settled';
}

// ---------------------------------------------------------------------------------------------
// Route answers.
// ---------------------------------------------------------------------------------------------

/** `FlightView` from @planeahead/shared, as a parser: the answers are data from the network. */
export const FlightViewSchema = z.looseObject({
  key: FlightKeySchema,
  phase: z.string(),
  version: z.number(),
  snapshot: FlightStatusSchema.nullable(),
  source: z.string(),
});
export type ParsedFlightView = z.infer<typeof FlightViewSchema>;

const SubscribeAnswerSchema = z.looseObject({
  subscription: FlightSubscriptionRowV1,
  flight: FlightViewSchema.nullable(),
  created: z.boolean(),
});

const FlightViewCarrierSchema = z.looseObject({ flight: FlightViewSchema.nullable() });

function isSubscribe(item: OutboxItem): boolean {
  return item.method === SUBSCRIBE_MUTATION.method && item.path === SUBSCRIBE_MUTATION.path;
}

/**
 * Writes a route answer's flight onto the rows naming its key: the snapshot when it is not null
 * and not older than the stored one (never a null over a known snapshot), and `finished_at` when
 * the tracker says the flight is over. Returns whether anything was written. Caller holds the
 * transaction.
 */
export function applyFlightView(
  db: SqliteLike,
  view: ParsedFlightView | null,
  options: { readonly finished?: boolean; readonly now?: Date } = {},
): boolean {
  let wrote = false;
  if (view !== null && view.snapshot !== null) {
    const flight = SyncFlightV1.safeParse({ ...view.snapshot, key: view.key });
    if (flight.success) {
      wrote = applySnapshot(db, flight.data, { onlyIfNewer: true }) > 0 || wrote;
    }
  }
  const finished = options.finished === true || view?.phase === 'finished';
  if (view !== null && finished) {
    const changed = db.run(
      'UPDATE flight_subscriptions SET finished_at = ? WHERE flight_key = ? AND finished_at IS NULL',
      [(options.now ?? new Date(Date.now())).toISOString(), view.key],
    ).changes;
    wrote = changed > 0 || wrote;
  }
  return wrote;
}

/** A settled unsubscribe: its local tombstone goes for good (see the header). */
function forgetTombstone(db: SqliteLike, item: OutboxItem): readonly StoreTable[] {
  if (item.entityId === null) {
    return [];
  }
  const removed = db.run(
    'DELETE FROM flight_subscriptions WHERE id = ? AND deleted_at IS NOT NULL',
    [item.entityId],
  ).changes;
  return removed > 0 ? ['flight_subscriptions'] : [];
}

/** The outbox's `onSent` hook (see the header). Runs inside the outbox's transaction. */
export function reconcileSent(
  db: SqliteLike,
  item: OutboxItem,
  response: RawResponse,
): readonly StoreTable[] {
  if (isUnsubscribe(item)) {
    return forgetTombstone(db, item);
  }
  if (!isSubscribe(item) || item.entityId === null) {
    return [];
  }
  const answer = SubscribeAnswerSchema.safeParse(response.body);
  if (!answer.success) {
    // Unreadable success: the next pull brings the server's row under the same id.
    return [];
  }
  const server = answer.data.subscription;
  const optimisticId = item.entityId;
  const now = new Date(Date.now());
  const local = db.get<{ deleted_at: string | null; added_as: string | null }>(
    'SELECT deleted_at, added_as FROM flight_subscriptions WHERE id = ?',
    [optimisticId],
  );
  const noOp = server.id !== optimisticId && !answer.data.created;
  const heldAlready =
    noOp &&
    db.get<{ id: string }>('SELECT id FROM flight_subscriptions WHERE id = ?', [server.id]) !==
      null;
  if (server.id !== optimisticId) {
    db.run('DELETE FROM flight_subscriptions WHERE id = ?', [optimisticId]);
    if (noOp) {
      // The account already held the flight: whatever was queued for the add goes with it.
      db.run('DELETE FROM outbox WHERE entity_id = ?', [optimisticId]);
    } else {
      // A restored tombstone: the add made the server's row live, so a queued DELETE follows it.
      const queued = db.all<{ id: string; path: string }>(
        'SELECT id, path FROM outbox WHERE entity_id = ?',
        [optimisticId],
      );
      for (const row of queued) {
        db.run('UPDATE outbox SET entity_id = ?, path = ? WHERE id = ?', [
          server.id,
          row.path.split(optimisticId).join(server.id),
          row.id,
        ]);
      }
    }
    recordReplacement(optimisticId, server.id, now.getTime());
  }
  upsertSubscription(db, server);
  // The designator typed on this phone names the row the add became. On a no-op the account's
  // row keeps the name this phone already showed for it, and a cancelled add names nothing.
  if (local !== null && !(noOp && (heldAlready || local.deleted_at !== null))) {
    db.run('UPDATE flight_subscriptions SET added_as = ? WHERE id = ?', [
      local.added_as,
      server.id,
    ]);
  }
  // A server row is never superseded (only a pending add is); the optimistic row it replaced
  // under the same id may have been.
  db.run('UPDATE flight_subscriptions SET superseded = 0 WHERE id = ?', [server.id]);
  if (!noOp && local !== null && local.deleted_at !== null) {
    // Removed on this phone while the add was in flight: the queued DELETE follows.
    db.run('UPDATE flight_subscriptions SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL', [
      local.deleted_at,
      server.id,
    ]);
  }
  // The server's row may be one this phone has an unsubscribe queued for.
  reapplyQueuedUnsubscribes(db, now);
  applyFlightView(db, answer.data.flight);
  markSupersededPending(db);
  return ['flight_subscriptions', 'outbox'];
}

/** The outbox's `onRefused` hook (see the header). Runs inside the outbox's transaction. */
export function reconcileRefused(
  db: SqliteLike,
  item: OutboxItem,
  response?: RawResponse,
): readonly StoreTable[] {
  if (isUnsubscribe(item)) {
    // 404: the server has no such subscription (another device removed it first).
    return response?.status === 404 ? forgetTombstone(db, item) : [];
  }
  if (!isSubscribe(item) || item.entityId === null) {
    return [];
  }
  db.run('DELETE FROM flight_subscriptions WHERE id = ? AND substr(flight_key, 1, ?) = ?', [
    item.entityId,
    PENDING_KEY_PREFIX.length,
    PENDING_KEY_PREFIX,
  ]);
  // A queued unsubscribe of a flight that was never added has nothing left to do.
  db.run('DELETE FROM outbox WHERE entity_id = ? AND id <> ?', [item.entityId, item.id]);
  return ['flight_subscriptions', 'outbox'];
}

/**
 * The outbox wiring the flight mutations need (services.ts builds the app's outbox with it; the
 * tests build theirs the same way): both settling hooks, and the notice for a refused add.
 */
export function flightOutboxHooks(db: SqliteLike): Required<
  Pick<OutboxDeps, 'onSent' | 'onRefused'>
> & {
  readonly notifyDropped: (dropped: DroppedMutation) => void;
} {
  return {
    onSent: (item, response) => reconcileSent(db, item, response),
    onRefused: (item, response) => reconcileRefused(db, item, response),
    notifyDropped: ({ item, status, body }) => {
      if (isSubscribe(item) && item.entityId !== null) {
        useFlightNotices
          .getState()
          .push({ id: item.entityId, message: refusalMessage(item, status, body) });
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// What the user reads.
// ---------------------------------------------------------------------------------------------

const RefusalBodySchema = z.looseObject({
  error: z.string(),
  cap: z.string().optional(),
  limit: z.number().optional(),
  triedDates: z.array(z.string()).optional(),
  maxDaysAhead: z.number().optional(),
});

const QueuedSubscribeBodySchema = z.looseObject({
  number: z.string().optional(),
  date: z.string().optional(),
});

/** The free-tier explanation for a cap and its limit (the payload's own numbers). */
export function capMessage(cap: string | undefined, limit: number | undefined): string {
  const known = cap as CapName | undefined;
  switch (known) {
    case 'active_subscriptions':
      return `The free plan tracks up to ${String(limit ?? FREE_TIER_LIMITS.activeSubscriptions)} flights at a time. Remove a flight to add another.`;
    case 'live_tracked':
      return `The free plan follows up to ${String(limit ?? FREE_TIER_LIMITS.liveTracked)} flights live at once, and this one departs within two days. Remove a flight departing soon to add it.`;
    case 'instances_created':
      return `The free plan adds up to ${String(limit ?? FREE_TIER_LIMITS.instancesCreatedPerDay)} new flights a day. Try again tomorrow.`;
    case 'tracker_creations':
      return `Without an account, up to ${String(limit ?? FREE_TIER_LIMITS.anonymousTrackerCreationsPerDayPerIp)} new flights a day can be added from this network. Sign in to add more.`;
    case 'refresh':
      return `The free plan refreshes a flight up to ${String(limit ?? FREE_TIER_LIMITS.refreshesPerFlightPerDay)} times a day. It keeps updating on its own.`;
    default:
      return limit === undefined
        ? 'The free plan limit is reached.'
        : `The free plan limit (${String(limit)}) is reached.`;
  }
}

/**
 * The text for a refused subscribe, from its request and the answer's envelope. The status is
 * not shown: a code this build does not know gets a generic sentence, and the code and the status
 * go to Sentry with the drop (services.ts), never into the text.
 */
export function refusalMessage(item: OutboxItem, _status: number, body: unknown): string {
  const request = QueuedSubscribeBodySchema.safeParse(item.body);
  const designator = request.success ? (request.data.number ?? 'This flight') : 'This flight';
  const date = request.success && request.data.date !== undefined ? request.data.date : null;
  const on = date === null ? '' : ` on ${formatIsoDate(date)}`;
  const envelope = RefusalBodySchema.safeParse(body);
  const code = envelope.success ? envelope.data.error : null;
  switch (code) {
    case 'cap_exceeded':
      return capMessage(envelope.data?.cap, envelope.data?.limit);
    case 'flight_not_found': {
      const tried = (envelope.data?.triedDates ?? []).filter(
        (value) => IsoDateSchema.safeParse(value).success,
      );
      const dates =
        tried.length > 0 ? formatDateList(tried) : date === null ? null : formatIsoDate(date);
      return dates === null
        ? `No flight ${designator} was found.`
        : `No flight ${designator} was found on ${dates}. Check the number and the departure date.`;
    }
    case 'flight_archived':
      return `${designator}${on} is over and can no longer be tracked.`;
    case 'date_out_of_range':
      return envelope.data?.maxDaysAhead === undefined
        ? `${designator}${on} is too far ahead to add yet.`
        : `Flights can be added up to ${String(envelope.data.maxDaysAhead)} days ahead.`;
    case 'validation_failed':
      return `${designator}${on} could not be added. Check the flight number and date.`;
    default:
      return `${designator}${on} could not be added right now. Try again later.`;
  }
}

// ---------------------------------------------------------------------------------------------
// Refresh (ruling T3): direct, once per gesture, the 8 s deadline UX.
// ---------------------------------------------------------------------------------------------

/**
 * How long past the route's own 8 s deadline the app waits before it stops the spinner. The
 * route answers 504 `refresh_timeout` with the last known state at 8 s; the grace covers the
 * request's own time (auth, Postgres, KV) so the app does not cut off the answer that carries it.
 */
export const REFRESH_GRACE_MS = 4_000;

export type RefreshOutcome =
  | { readonly kind: 'refreshed'; readonly message: string }
  | { readonly kind: 'still_running'; readonly message: string }
  | { readonly kind: 'archived'; readonly message: string }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'deadline'; readonly message: string }
  | { readonly kind: 'offline'; readonly message: string }
  | { readonly kind: 'account_deleted'; readonly message: string };

export interface RefreshDeps {
  readonly db: SqliteLike;
  readonly api: Pick<ApiClient, 'v1'>;
  /**
   * 401 `account_deleted`: after the store is wiped, the same local sign-out the outbox and the
   * sync client run (services.ts `forgetAccount`).
   */
  readonly onAccountDeleted: () => Promise<void> | void;
  /** The route's deadline; the app waits this plus `REFRESH_GRACE_MS`. */
  readonly deadlineMs?: number;
  readonly now?: () => Date;
}

const RefreshAnswerSchema = z.looseObject({
  outcome: z.string(),
  reason: z.string().nullable().optional(),
  flight: FlightViewSchema,
});

function applyAnswer(
  db: SqliteLike,
  view: ParsedFlightView | null,
  options: { readonly finished?: boolean; readonly now: Date },
): void {
  commitWrite(db, ['flight_subscriptions'], () => applyFlightView(db, view, options));
}

/**
 * 410 `flight_archived`: the answer's flight (when it carries one) by key, and `finished_at` on
 * THIS subscription by its id whether or not it does, in one commit (ruling X6).
 */
function applyArchived(
  db: SqliteLike,
  subscriptionId: string,
  view: ParsedFlightView | null,
  now: Date,
): void {
  commitWrite(db, ['flight_subscriptions'], () => {
    applyFlightView(db, view, { finished: true, now });
    db.run('UPDATE flight_subscriptions SET finished_at = ? WHERE id = ? AND finished_at IS NULL', [
      now.toISOString(),
      subscriptionId,
    ]);
  });
}

function refreshedMessage(outcome: string, reason: string | null | undefined): string {
  if (outcome === 'denied') {
    return 'This flight has been refreshed as often as it can be today. It keeps updating on its own.';
  }
  if (outcome === 'skipped') {
    return 'Nothing to refresh right now.';
  }
  if (outcome === 'coalesced' && reason === 'fresh') {
    return 'Already up to date.';
  }
  return 'Updated.';
}

/**
 * `POST /v1/flights/:id/refresh` for one subscription, applied to the store. Never throws: every
 * outcome is a message the screen shows.
 */
export async function refreshFlight(
  deps: RefreshDeps,
  subscriptionId: string,
): Promise<RefreshOutcome> {
  const now = deps.now ?? (() => new Date(Date.now()));
  const controller = new AbortController();
  const timer = setTimeout(
    () => {
      controller.abort();
    },
    (deps.deadlineMs ?? DO_CALL_DEADLINE_MS) + REFRESH_GRACE_MS,
  );
  let status: number;
  let body: unknown;
  try {
    const response = await deps.api.v1.flights[':id'].refresh.$post(
      { param: { id: subscriptionId } },
      { init: { signal: controller.signal } },
    );
    status = response.status;
    body = await response.json().catch(() => null);
  } catch {
    return controller.signal.aborted
      ? {
          kind: 'deadline',
          message:
            'The refresh is taking longer than usual. The flight updates here when it finishes.',
        }
      : { kind: 'offline', message: 'Could not refresh. Check your connection and try again.' };
  } finally {
    clearTimeout(timer);
  }

  if (status >= 200 && status < 300) {
    const answer = RefreshAnswerSchema.safeParse(body);
    if (answer.success) {
      applyAnswer(deps.db, answer.data.flight, { now: now() });
      return {
        kind: 'refreshed',
        message: refreshedMessage(answer.data.outcome, answer.data.reason),
      };
    }
    return { kind: 'refreshed', message: 'Updated.' };
  }
  const carrier = FlightViewCarrierSchema.safeParse(body);
  const view = carrier.success ? carrier.data.flight : null;
  const envelope = RefusalBodySchema.safeParse(body);
  const code = envelope.success ? envelope.data.error : null;
  if (status === 504) {
    // `refresh_timeout` (the route's deadline) or `upstream_timeout`: the tracker keeps working.
    applyAnswer(deps.db, view, { now: now() });
    return {
      kind: 'still_running',
      message:
        'The refresh is still running. Showing the last known state; it updates here when it finishes.',
    };
  }
  if (status === 410 && code === 'flight_archived') {
    applyArchived(deps.db, subscriptionId, view, now());
    return { kind: 'archived', message: 'This flight is over and is no longer tracked.' };
  }
  if (status === 403 && code === 'cap_exceeded') {
    return { kind: 'refused', message: capMessage(envelope.data?.cap, envelope.data?.limit) };
  }
  if (status === 404) {
    return {
      kind: 'refused',
      message: 'This flight is not on the server yet. It can be refreshed once it has been added.',
    };
  }
  if (status === 401 && code === 'account_deleted') {
    // As the outbox does: nothing local survives, then the local sign-out.
    wipeLocalStore(deps.db);
    await deps.onAccountDeleted();
    return {
      kind: 'account_deleted',
      message: 'This account has been deleted. Its flights are gone from this phone.',
    };
  }
  if (status === 401) {
    return { kind: 'refused', message: 'Sign in again to refresh flights.' };
  }
  // Method, status and code only, like the outbox's drops: never the body (it names the flight).
  Sentry.captureMessage('flight_refresh_refused', {
    level: 'warning',
    extra: { method: 'POST', path: '/v1/flights/:id/refresh', status, code },
  });
  return { kind: 'refused', message: 'Could not refresh right now. Try again later.' };
}
