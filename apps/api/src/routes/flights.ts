/**
 * `/v1/flights` (increment 8): search, subscribe, list, detail, unsubscribe and refresh.
 *
 *   GET    /v1/flights/search?number=&date=&origin=   designator and origin-local date to a key
 *   POST   /v1/flights                                 subscribe; `Idempotency-Key` required
 *   GET    /v1/flights                                 the caller's live subscriptions
 *   GET    /v1/flights/:id                             one subscription (`:id` is its row id)
 *   DELETE /v1/flights/:id                             unsubscribe (tombstone plus change row)
 *   POST   /v1/flights/:id/refresh                     a coalesced user refresh; no key
 *
 * Subscribe, in the order ruling K7 fixes: resolve the key (given, or number and date through the
 * resolver, which seeds the tracker, so a route never subscribes before the object exists); read
 * the tracker (`getState`: an absent tracker's typed `RpcRequestError` becomes 404
 * `flight_not_found` for a key never seeded and 410 `flight_archived` for a finished flight);
 * take the caps (`instances_created` only when this request created the tracker, during the
 * resolution; `active_subscriptions`; `live_tracked` only when the flight is inside its live
 * window, read from the same `getState` answer as the phase, not a separate `health` call; a
 * flight that enters its window later is charged by the persist consumer, ruling O3);
 * `subscribe` on the tracker; then ONE `db.transaction()` that registers the instance
 * row if the persist consumer has not yet, writes the `flight_subscriptions` row (restoring a
 * tombstoned one rather than inserting a second) and its `user_sync_changes` row. When the
 * tracker accepted the subscriber and the transaction fails, the route unsubscribes (best effort)
 * and releases the counters it took, so neither the tracker nor the caps keep a subscription
 * Postgres never recorded.
 *
 * Consistency between the tracker's subscriber list and Postgres (ruling O13). The subscription id
 * is stable across retries (a restored tombstone's id, or the client's own), so a compensation may
 * only ever remove a subscriber THIS request added and nobody recorded: it runs when the tracker
 * answered `subscribed` (not `already`) AND no live `flight_subscriptions` row has that id at that
 * moment. That covers the late compensation after a lost 8 s race (the outbox's retry with the
 * same key may have committed the row meanwhile) and the transaction failure. Every answer that
 * says "already subscribed" (the step-2 shortcut, a concurrent subscribe that won inside the
 * transaction, a unique violation from one that won at commit) re-sends the idempotent tracker
 * `subscribe` for the live row, so a client retry repairs any drift. A unique violation on either
 * constraint (the primary key: the same client id raced; `(user_id, flight_instance_id)`: two ids
 * raced) re-reads the live row and answers 200 `already` with it; this request's own id is
 * unsubscribed only when it differs from the winner's.
 *
 * Refresh (ruling O10): a subscription whose flight is over answers 410 `flight_archived` with the
 * last known flight before any budget is taken, and every refresh answer (success, 504
 * `refresh_timeout`, 410) carries the same `flight: FlightView`. The user's per-flight sub-budget
 * (`refresh:{flightKey}`) is charged per call, a coalesced one included: it bounds how often one
 * user may ask, while the tracker's own daily cap bounds what the asking costs.
 *
 * Every Durable Object call passes `locationHint` and is awaited under the route's own 8 s
 * deadline. The refresh is coalesced by the tracker's in-flight promise alone: the Cache API
 * cannot store a POST and KV is eventually consistent, so neither may deduplicate it.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { flightInstances, flightSubscriptions, type Db } from '@planeahead/db';
import {
  DO_CALL_DEADLINE_MS,
  DesignatorInputSchema,
  IsoDateSchema,
  OriginAirportInputSchema,
  SubscribeFlightBodySchema,
  isInLiveWindow,
  uuidv7,
  type FlightKey,
  type FlightNotFoundBody,
  type FlightSearchResponse,
  type FlightSubscriptionRowV1,
  type FlightView,
  type GetStateResponseV1,
  type SubscribeResponseV1,
} from '@planeahead/shared';
import * as z from 'zod';
import { authRuntime } from '../auth/runtime';
import type { AppBindings, Env } from '../env';
import { currentUser, requireScope } from '../middleware/auth';
import { idempotencyGate } from '../middleware/idempotency';
import { clientIp } from '../middleware/rate-limit';
import { errorFields, type Logger } from '../observability/log';
import {
  CapLedger,
  capExceededBody,
  releaseCap,
  takeCap,
  userCap,
  type CapSlot,
} from '../lib/caps';
import {
  DeadlineExceededError,
  callWithDeadline,
  withDeadline,
  type DeadlineResult,
} from '../lib/deadline';
import {
  ensureInstanceRegistered,
  instanceByKey,
  isTerminalTrackingState,
  type KnownInstance,
} from '../lib/flight-registry';
import { resolveFlight, type FlightResolution, type Resolver } from '../lib/flight-search';
import {
  lastKnownFlight,
  readKvSnapshot,
  readThroughSnapshots,
  type KnownFlight,
} from '../lib/flight-snapshots';

export type { FlightView };
import {
  appendUserChange,
  subscriptionSyncRow,
  type FlightSubscriptionRecord,
} from '../lib/sync-rows';
import {
  defaultTrackerFor,
  forceRefreshTracker,
  getTrackerState,
  isAbsentTrackerError,
  subscribeTracker,
  unsubscribeTracker,
  type TrackerFor,
} from '../lib/trackers';
import { queryValue, validate } from '../lib/validate';

export interface FlightRoutesOptions {
  /** Replaces `FLIGHT_TRACKER.getByName`; a test hands in a slow or failing tracker. */
  readonly trackerFor?: ((env: Env) => TrackerFor) | undefined;
  /** Replaces the Worker-side resolve helper. */
  readonly resolve?: Resolver | undefined;
  /** The deadline on every Durable Object call; `DO_CALL_DEADLINE_MS` (8 s) by default. */
  readonly deadlineMs?: number | undefined;
  /** Test seam: runs inside the subscribe transaction just before it commits. */
  readonly beforeSubscribeCommit?: ((userId: string) => Promise<void> | void) | undefined;
}

export const FlightSearchQuerySchema = z.object({
  number: queryValue(DesignatorInputSchema),
  date: queryValue(IsoDateSchema),
  origin: queryValue(OriginAirportInputSchema).optional(),
});

const SubscriptionIdParam = z.object({ id: z.uuid() });

function flightView(known: KnownFlight | null | undefined, key: FlightKey): FlightView | null {
  if (known === null || known === undefined) {
    return null;
  }
  return {
    key,
    phase: known.phase,
    version: known.version,
    snapshot: known.snapshot,
    source: known.source,
  };
}

interface RouteContext {
  readonly db: Db;
  readonly log: Logger;
  readonly trackerFor: TrackerFor;
  readonly deadlineMs: number;
  readonly waitUntil: (promise: Promise<unknown>) => void;
}

function routeContext(c: Context<AppBindings>, options: FlightRoutesOptions): RouteContext {
  const { db, log } = authRuntime(c);
  return {
    db,
    log,
    trackerFor: options.trackerFor?.(c.env) ?? defaultTrackerFor(c.env),
    deadlineMs: options.deadlineMs ?? DO_CALL_DEADLINE_MS,
    waitUntil: (promise) => {
      c.executionCtx.waitUntil(promise);
    },
  };
}

function errorBody<Code extends string>(c: Context<AppBindings>, error: Code, message: string) {
  return { error, message, requestId: c.var.requestId };
}

/** The answer to every resolution that is not a flight key. */
function resolutionFailure(
  c: Context<AppBindings>,
  resolution: Exclude<FlightResolution, { kind: 'resolved' }>,
) {
  switch (resolution.kind) {
    case 'not_found': {
      const body: FlightNotFoundBody = {
        ...errorBody(c, 'flight_not_found', 'the provider knows no such flight on those dates'),
        triedDates: [...resolution.triedDates],
        suggestions: [],
      };
      return c.json(body, 404);
    }
    case 'cap_exceeded':
      return c.json(capExceededBody(resolution.slot, c.var.requestId), 403);
    case 'date_out_of_range':
      return c.json(
        {
          ...errorBody(
            c,
            'date_out_of_range',
            `the date must be at most ${String(resolution.maxDaysAhead)} days ahead`,
          ),
          maxDaysAhead: resolution.maxDaysAhead,
        },
        422,
      );
    case 'unknown_origin':
      return c.json(
        {
          ...errorBody(c, 'validation_failed', 'the request query is invalid'),
          issues: [{ path: ['origin'], message: 'unknown airport', code: 'custom' }],
        },
        400,
      );
    case 'overloaded':
      c.header('Retry-After', String(resolution.retryAfterSeconds));
      return c.json(errorBody(c, 'unavailable', 'the search is overloaded; retry shortly'), 503);
    case 'provider_unavailable':
      return c.json(
        errorBody(c, 'provider_unavailable', 'flight data is temporarily unavailable'),
        503,
      );
    case 'provider_error':
      return c.json(errorBody(c, 'provider_error', 'the flight data provider failed'), 502);
    case 'timeout':
      return c.json(
        errorBody(c, 'upstream_timeout', 'the flight search did not finish in time; retry'),
        504,
      );
  }
}

function flightArchived(c: Context<AppBindings>) {
  return c.json(errorBody(c, 'flight_archived', 'this flight is over and no longer tracked'), 410);
}

function notFoundOrArchived(c: Context<AppBindings>, instance: KnownInstance | null) {
  if (instance !== null && isTerminalTrackingState(instance.trackingState)) {
    return flightArchived(c);
  }
  return c.json(errorBody(c, 'flight_not_found', 'no tracked flight has this key'), 404);
}

function upstreamTimeout(c: Context<AppBindings>) {
  return c.json(errorBody(c, 'upstream_timeout', 'the flight tracker did not answer in time'), 504);
}

function subscriptionNotFound(c: Context<AppBindings>) {
  return c.json(errorBody(c, 'subscription_not_found', 'no such subscription'), 404);
}

interface SubscriptionWithKey {
  readonly row: FlightSubscriptionRecord;
  readonly flightKey: FlightKey;
  readonly trackingState: string;
}

/** One of the caller's LIVE subscriptions by row id, with its flight key. */
async function liveSubscription(
  db: Db,
  userId: string,
  id: string,
): Promise<SubscriptionWithKey | null> {
  const [found] = await db
    .select({
      row: flightSubscriptions,
      flightKey: flightInstances.flightKey,
      trackingState: flightInstances.trackingState,
    })
    .from(flightSubscriptions)
    .innerJoin(flightInstances, eq(flightInstances.id, flightSubscriptions.flightInstanceId))
    .where(
      and(
        eq(flightSubscriptions.id, id),
        eq(flightSubscriptions.userId, userId),
        isNull(flightSubscriptions.deletedAt),
      ),
    )
    .limit(1);
  return found === undefined
    ? null
    : {
        row: found.row,
        flightKey: found.flightKey as FlightKey,
        trackingState: found.trackingState,
      };
}

/** Best-effort compensation: the tracker drops a subscriber Postgres never recorded. */
async function unsubscribeQuietly(
  ctx: RouteContext,
  flightKey: FlightKey,
  subscriptionId: string,
): Promise<void> {
  try {
    await callWithDeadline(
      'unsubscribe',
      unsubscribeTracker(ctx.trackerFor(flightKey), { subscriptionId }),
      ctx.deadlineMs,
      { waitUntil: ctx.waitUntil },
    );
  } catch (error) {
    ctx.log.error('flight_unsubscribe_failed', {
      flight_key: flightKey,
      subscription_id: subscriptionId,
      ...errorFields(error),
    });
  }
}

/** Whether a live `flight_subscriptions` row (anyone's) carries `id`. */
async function liveRowExists(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .select({ id: flightSubscriptions.id })
    .from(flightSubscriptions)
    .where(and(eq(flightSubscriptions.id, id), isNull(flightSubscriptions.deletedAt)))
    .limit(1);
  return rows.length > 0;
}

/**
 * The only compensation a subscribe ever makes (ruling O13): remove `subscriptionId` from the
 * tracker when THIS request's call added it (`subscribed`) and no live row records it now. A
 * request whose call answered `already` added nothing and removes nothing; a live row means a
 * retry (or a concurrent request with the same client id) recorded the subscriber and it stays.
 */
async function compensateSubscribe(
  ctx: RouteContext,
  flightKey: FlightKey,
  subscriptionId: string,
  landed: SubscribeResponseV1['status'],
): Promise<void> {
  if (landed !== 'subscribed') {
    return;
  }
  try {
    if (await liveRowExists(ctx.db, subscriptionId)) {
      return;
    }
  } catch (error) {
    // Unknown: leave the subscriber. A tracker notification is filtered by Postgres, and the
    // increment 12 reconciliation repairs a stray subscriber; a wrong unsubscribe loses one.
    ctx.log.error('flight_subscribe_compensation_check_failed', {
      flight_key: flightKey,
      subscription_id: subscriptionId,
      ...errorFields(error),
    });
    return;
  }
  await unsubscribeQuietly(ctx, flightKey, subscriptionId);
}

/**
 * Re-sends the idempotent tracker `subscribe` for a live row, so any answer that says "already
 * subscribed" also repairs a tracker that lost the subscriber. Best effort under the deadline.
 */
async function resubscribeQuietly(
  ctx: RouteContext,
  flightKey: FlightKey,
  row: FlightSubscriptionRecord,
): Promise<void> {
  const overrides = row.notificationOverrides;
  try {
    await callWithDeadline(
      'subscribe',
      subscribeTracker(ctx.trackerFor(flightKey), {
        subscriptionId: row.id,
        userId: row.userId,
        muted: row.muted,
        ...(typeof overrides === 'object' && overrides !== null && !Array.isArray(overrides)
          ? { overrides }
          : {}),
      }),
      ctx.deadlineMs,
      { waitUntil: ctx.waitUntil },
    );
  } catch (error) {
    // A finished or purged tracker refuses; nothing to repair there.
    if (!isAbsentTrackerError(error)) {
      ctx.log.warn('flight_resubscribe_failed', {
        flight_key: flightKey,
        subscription_id: row.id,
        ...errorFields(error),
      });
    }
  }
}

/** The caller's live row for one instance, if any. */
async function liveRowFor(
  db: Db,
  userId: string,
  instanceId: string,
): Promise<FlightSubscriptionRecord | null> {
  const [row] = await db
    .select()
    .from(flightSubscriptions)
    .where(
      and(
        eq(flightSubscriptions.userId, userId),
        eq(flightSubscriptions.flightInstanceId, instanceId),
        isNull(flightSubscriptions.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

const SUBSCRIPTION_UNIQUE_CONSTRAINTS: ReadonlySet<string> = new Set([
  'flight_subscriptions_pkey',
  'flight_subscriptions_user_id_flight_instance_id_key',
]);

/** Postgres error codes, read off whatever shape the driver threw. */
function pgCode(error: unknown): { code: string | undefined; constraint: string | undefined } {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    const record = current as { code?: unknown; constraint_name?: unknown; cause?: unknown };
    if (typeof record.code === 'string') {
      return {
        code: record.code,
        constraint: typeof record.constraint_name === 'string' ? record.constraint_name : undefined,
      };
    }
    current = record.cause;
  }
  return { code: undefined, constraint: undefined };
}

type SubscribeOutcome =
  | { readonly kind: 'created' | 'restored'; readonly row: FlightSubscriptionRecord }
  | { readonly kind: 'already'; readonly row: FlightSubscriptionRecord };

const CREATION_CAPS = ['instances_created', 'tracker_creations'] as const;

export function createFlightRoutes(options: FlightRoutesOptions = {}) {
  return (
    new Hono<AppBindings>()
      // -----------------------------------------------------------------------------------------
      // Search.
      // -----------------------------------------------------------------------------------------
      .get(
        '/search',
        requireScope('user'),
        validate('query', FlightSearchQuerySchema),
        async (c) => {
          const user = currentUser(c.var.user);
          const query = c.req.valid('query');
          const ctx = routeContext(c, options);
          const resolution = await resolveFlight(
            {
              env: c.env,
              db: ctx.db,
              user,
              clientIp: clientIp(c),
              now: new Date(),
              log: ctx.log,
              requestId: c.var.requestId,
              deadlineMs: ctx.deadlineMs,
              waitUntil: ctx.waitUntil,
              ledger: new CapLedger(ctx.db),
              resolve: options.resolve,
            },
            { designator: query.number, dateLocal: query.date, origin: query.origin },
          );
          if (resolution.kind !== 'resolved') {
            return resolutionFailure(c, resolution);
          }
          const status =
            resolution.status ??
            (await readKvSnapshot(c.env.CACHE, resolution.flightKey, ctx.log))?.snapshot ??
            null;
          const body: FlightSearchResponse = {
            flightKey: resolution.flightKey,
            status,
            tracker: resolution.tracker,
            cached: resolution.cached,
          };
          return c.json(body, 200);
        },
      )

      // -----------------------------------------------------------------------------------------
      // Subscribe.
      // -----------------------------------------------------------------------------------------
      .post(
        '/',
        requireScope('user'),
        validate('json', SubscribeFlightBodySchema),
        idempotencyGate({ required: true }),
        async (c) => {
          const user = currentUser(c.var.user);
          const body = c.req.valid('json');
          const ctx = routeContext(c, options);
          const now = new Date();
          const ledger = new CapLedger(ctx.db);

          // 1. The key: given, or resolved (which seeds the tracker and may take the creation caps).
          let flightKey: FlightKey;
          if (body.flightKey !== undefined) {
            flightKey = body.flightKey;
          } else {
            const resolution = await resolveFlight(
              {
                env: c.env,
                db: ctx.db,
                user,
                clientIp: clientIp(c),
                now,
                log: ctx.log,
                requestId: c.var.requestId,
                deadlineMs: ctx.deadlineMs,
                waitUntil: ctx.waitUntil,
                ledger,
                resolve: options.resolve,
              },
              { designator: body.number ?? '', dateLocal: body.date ?? '', origin: body.origin },
            );
            if (resolution.kind !== 'resolved') {
              return resolutionFailure(c, resolution);
            }
            if (resolution.tracker === 'none') {
              return flightArchived(c);
            }
            flightKey = resolution.flightKey;
          }

          /** The 200 `already` answer for a live row, after re-sending the tracker subscribe. */
          const alreadySubscribed = async (row: FlightSubscriptionRecord) => {
            await resubscribeQuietly(ctx, flightKey, row);
            const known = await lastKnownFlight(c.env, ctx.db, flightKey, ctx.log);
            const subscription: FlightSubscriptionRowV1 = subscriptionSyncRow(row, flightKey);
            return c.json(
              { subscription, flight: flightView(known, flightKey), created: false },
              200,
            );
          };

          // 2. Already subscribed: the existing row, no caps; the tracker is told again.
          const instance = await instanceByKey(ctx.db, flightKey);
          const existing =
            instance === null
              ? []
              : await ctx.db
                  .select()
                  .from(flightSubscriptions)
                  .where(
                    and(
                      eq(flightSubscriptions.userId, user.id),
                      eq(flightSubscriptions.flightInstanceId, instance.id),
                    ),
                  )
                  .orderBy(desc(flightSubscriptions.updatedAt));
          const live = existing.find((row) => row.deletedAt === null);
          if (live !== undefined) {
            return alreadySubscribed(live);
          }

          // 3. The tracker: never subscribe to an object the resolver has not seeded.
          let state: GetStateResponseV1;
          try {
            state = await callWithDeadline(
              'getState',
              getTrackerState(ctx.trackerFor(flightKey)),
              ctx.deadlineMs,
              { waitUntil: ctx.waitUntil },
            );
          } catch (error) {
            if (isAbsentTrackerError(error)) {
              return notFoundOrArchived(c, instance);
            }
            if (error instanceof DeadlineExceededError) {
              return upstreamTimeout(c);
            }
            throw error;
          }
          if (state.phase === 'finished') {
            return flightArchived(c);
          }

          // 4. The caps, in order; the counter row is the serialization point.
          const refuse = async (slot: CapSlot) => {
            await ledger.releaseAll([...CREATION_CAPS]);
            return c.json(capExceededBody(slot, c.var.requestId), 403);
          };
          const activeRefused = await ledger.take(userCap('active_subscriptions', user.id, now));
          if (activeRefused !== null) {
            return refuse(activeRefused);
          }
          const live48h = isInLiveWindow(
            { phase: state.phase, scheduledOut: state.snapshot?.times.scheduledOut },
            now.getTime(),
          );
          if (live48h) {
            const liveRefused = await ledger.take(userCap('live_tracked', user.id, now));
            if (liveRefused !== null) {
              return refuse(liveRefused);
            }
          }

          // 5. The tracker learns the subscriber. A tombstoned row is restored under its own id.
          const tombstone = existing.find((row) => row.deletedAt !== null);
          const subscriptionId = tombstone?.id ?? body.subscriptionId ?? uuidv7();
          const subscribeCall = subscribeTracker(ctx.trackerFor(flightKey), {
            subscriptionId,
            userId: user.id,
            ...(body.muted === undefined ? {} : { muted: body.muted }),
            ...(body.notificationOverrides === undefined
              ? {}
              : { overrides: body.notificationOverrides }),
          });
          let subscribed: DeadlineResult<SubscribeResponseV1>;
          try {
            subscribed = await withDeadline(subscribeCall, ctx.deadlineMs, {
              waitUntil: ctx.waitUntil,
            });
          } catch (error) {
            await ledger.releaseAll([...CREATION_CAPS]);
            if (isAbsentTrackerError(error)) {
              return notFoundOrArchived(c, instance);
            }
            throw error;
          }
          if (subscribed.kind === 'timeout') {
            // The call may still land. When it does, undo it only if it added the subscriber and
            // nothing recorded it by then: the outbox's retry (same key, same id, since a 5xx is
            // never stored) may have committed the row in the meantime.
            ctx.waitUntil(
              subscribeCall.then(
                (landed) => compensateSubscribe(ctx, flightKey, subscriptionId, landed.status),
                () => undefined,
              ),
            );
            await ledger.releaseAll([...CREATION_CAPS]);
            return upstreamTimeout(c);
          }
          const landed = subscribed.value.status;
          if (landed === 'archived') {
            await ledger.releaseAll([...CREATION_CAPS]);
            return flightArchived(c);
          }

          // 6. One transaction: registry row, subscription row, change row.
          let outcome: SubscribeOutcome;
          try {
            outcome = await ctx.db.transaction(async (tx): Promise<SubscribeOutcome> => {
              const instanceId = await ensureInstanceRegistered(tx, flightKey);
              const rows = await tx
                .select()
                .from(flightSubscriptions)
                .where(
                  and(
                    eq(flightSubscriptions.userId, user.id),
                    eq(flightSubscriptions.flightInstanceId, instanceId),
                  ),
                )
                .for('update');
              const winner = rows.find((row) => row.deletedAt === null);
              if (winner !== undefined) {
                return { kind: 'already', row: winner };
              }
              const prefs = {
                label: body.label ?? null,
                seat: body.seat ?? null,
                cabin: body.cabin ?? null,
                muted: body.muted ?? false,
                notificationOverrides: body.notificationOverrides ?? {},
                liveTracked: ledger.has('live_tracked'),
              };
              const restore = rows.find((row) => row.id === subscriptionId);
              let written: FlightSubscriptionRecord | undefined;
              let kind: 'created' | 'restored';
              if (restore === undefined) {
                [written] = await tx
                  .insert(flightSubscriptions)
                  .values({
                    id: subscriptionId,
                    userId: user.id,
                    flightInstanceId: instanceId,
                    source: 'manual',
                    ...prefs,
                  })
                  .returning();
                kind = 'created';
              } else {
                [written] = await tx
                  .update(flightSubscriptions)
                  .set({ ...prefs, deletedAt: null })
                  .where(eq(flightSubscriptions.id, restore.id))
                  .returning();
                kind = 'restored';
              }
              if (written === undefined) {
                throw new Error('flight_subscriptions write returned no row');
              }
              await appendUserChange(tx, {
                userId: user.id,
                entity: 'flight_subscriptions',
                entityId: written.id,
                op: 'upsert',
                row: subscriptionSyncRow(written, flightKey),
              });
              await options.beforeSubscribeCommit?.(user.id);
              return { kind, row: written };
            });
          } catch (error) {
            const { code, constraint } = pgCode(error);
            if (code === '23505' && SUBSCRIPTION_UNIQUE_CONSTRAINTS.has(constraint ?? '')) {
              // A concurrent subscribe committed first. The live row it wrote is the answer.
              const instanceId = (await instanceByKey(ctx.db, flightKey))?.id;
              const winner =
                instanceId === undefined ? null : await liveRowFor(ctx.db, user.id, instanceId);
              if (winner !== null) {
                ctx.log.info('flight_subscribe_conflict', {
                  flight_key: flightKey,
                  constraint,
                  same_id: winner.id === subscriptionId,
                });
                await ledger.releaseAll([...CREATION_CAPS]);
                if (winner.id !== subscriptionId) {
                  await compensateSubscribe(ctx, flightKey, subscriptionId, landed);
                }
                return alreadySubscribed(winner);
              }
            }
            // The tracker has the subscriber and Postgres does not: undo both halves.
            ctx.log.error('flight_subscribe_transaction_failed', {
              flight_key: flightKey,
              ...errorFields(error),
            });
            await compensateSubscribe(ctx, flightKey, subscriptionId, landed);
            await ledger.releaseAll([...CREATION_CAPS]);
            if (code === '23505' && constraint === 'flight_subscriptions_pkey') {
              // The client's id belongs to a row that is not this user's live subscription here.
              return c.json(
                {
                  ...errorBody(c, 'validation_failed', 'the request json is invalid'),
                  issues: [{ path: ['subscriptionId'], message: 'already in use', code: 'custom' }],
                },
                400,
              );
            }
            throw error;
          }
          if (outcome.kind === 'already') {
            // A concurrent subscribe for the same flight committed first: ours is redundant.
            await ledger.releaseAll([...CREATION_CAPS]);
            if (outcome.row.id !== subscriptionId) {
              await compensateSubscribe(ctx, flightKey, subscriptionId, landed);
            }
            return alreadySubscribed(outcome.row);
          }
          const subscription: FlightSubscriptionRowV1 = subscriptionSyncRow(outcome.row, flightKey);
          const flight: FlightView = {
            key: flightKey,
            phase: state.phase,
            version: subscribed.value.version ?? state.version ?? 0,
            snapshot: subscribed.value.snapshot ?? state.snapshot,
            source: 'tracker',
          };
          return c.json({ subscription, flight, created: true }, 201);
        },
      )

      // -----------------------------------------------------------------------------------------
      // List and detail.
      // -----------------------------------------------------------------------------------------
      .get('/', requireScope('user'), async (c) => {
        const user = currentUser(c.var.user);
        const ctx = routeContext(c, options);
        const rows = await ctx.db
          .select({
            row: flightSubscriptions,
            flightKey: flightInstances.flightKey,
            trackingState: flightInstances.trackingState,
          })
          .from(flightSubscriptions)
          .innerJoin(flightInstances, eq(flightInstances.id, flightSubscriptions.flightInstanceId))
          .where(
            and(eq(flightSubscriptions.userId, user.id), isNull(flightSubscriptions.deletedAt)),
          )
          .orderBy(flightSubscriptions.createdAt);
        const flights = await readThroughSnapshots(
          rows.map((entry) => entry.flightKey as FlightKey),
          {
            env: c.env,
            db: ctx.db,
            trackerFor: ctx.trackerFor,
            deadlineMs: ctx.deadlineMs,
            waitUntil: ctx.waitUntil,
            log: ctx.log,
            finished: new Set(
              rows
                .filter((entry) => isTerminalTrackingState(entry.trackingState))
                .map((entry) => entry.flightKey as FlightKey),
            ),
          },
        );
        return c.json(
          {
            flights: rows.map((entry) => {
              const key = entry.flightKey as FlightKey;
              const subscription: FlightSubscriptionRowV1 = subscriptionSyncRow(entry.row, key);
              return { subscription, flight: flightView(flights.get(key), key) };
            }),
          },
          200,
        );
      })
      .get('/:id', requireScope('user'), validate('param', SubscriptionIdParam), async (c) => {
        const user = currentUser(c.var.user);
        const { id } = c.req.valid('param');
        const ctx = routeContext(c, options);
        const found = await liveSubscription(ctx.db, user.id, id);
        if (found === null) {
          return subscriptionNotFound(c);
        }
        const flights = await readThroughSnapshots([found.flightKey], {
          env: c.env,
          db: ctx.db,
          trackerFor: ctx.trackerFor,
          deadlineMs: ctx.deadlineMs,
          waitUntil: ctx.waitUntil,
          log: ctx.log,
          finished: new Set(isTerminalTrackingState(found.trackingState) ? [found.flightKey] : []),
        });
        const subscription: FlightSubscriptionRowV1 = subscriptionSyncRow(
          found.row,
          found.flightKey,
        );
        return c.json(
          { subscription, flight: flightView(flights.get(found.flightKey), found.flightKey) },
          200,
        );
      })

      // -----------------------------------------------------------------------------------------
      // Unsubscribe.
      // -----------------------------------------------------------------------------------------
      .delete(
        '/:id',
        requireScope('user'),
        validate('param', SubscriptionIdParam),
        idempotencyGate({ required: false }),
        async (c) => {
          const user = currentUser(c.var.user);
          const { id } = c.req.valid('param');
          const ctx = routeContext(c, options);
          const now = new Date();
          const removed = await ctx.db.transaction(async (tx) => {
            const [found] = await tx
              .select({ row: flightSubscriptions, flightKey: flightInstances.flightKey })
              .from(flightSubscriptions)
              .innerJoin(
                flightInstances,
                eq(flightInstances.id, flightSubscriptions.flightInstanceId),
              )
              .where(
                and(
                  eq(flightSubscriptions.id, id),
                  eq(flightSubscriptions.userId, user.id),
                  isNull(flightSubscriptions.deletedAt),
                ),
              )
              .for('update', { of: flightSubscriptions });
            if (found === undefined) {
              return null;
            }
            // The flag goes with the slot, so the persist consumer's release when the flight lands
            // (ruling O3) can never give the same slot back a second time.
            const [tombstoned] = await tx
              .update(flightSubscriptions)
              .set({ deletedAt: sql`now()`, liveTracked: false })
              .where(eq(flightSubscriptions.id, id))
              .returning();
            if (tombstoned === undefined) {
              throw new Error('flight_subscriptions tombstone returned no row');
            }
            const flightKey = found.flightKey as FlightKey;
            await appendUserChange(tx, {
              userId: user.id,
              entity: 'flight_subscriptions',
              entityId: id,
              op: 'delete',
              row: subscriptionSyncRow(tombstoned, flightKey),
            });
            await releaseCap(tx, userCap('active_subscriptions', user.id, now));
            if (found.row.liveTracked) {
              await releaseCap(tx, userCap('live_tracked', user.id, now));
            }
            return { row: tombstoned, flightKey };
          });
          if (removed === null) {
            return subscriptionNotFound(c);
          }
          // After the commit: Postgres is the record, the tracker's list follows it (idempotent).
          await unsubscribeQuietly(ctx, removed.flightKey, id);
          const subscription: FlightSubscriptionRowV1 = subscriptionSyncRow(
            removed.row,
            removed.flightKey,
          );
          return c.json({ deleted: true as const, subscription }, 200);
        },
      )

      // -----------------------------------------------------------------------------------------
      // Refresh.
      // -----------------------------------------------------------------------------------------
      .post(
        '/:id/refresh',
        requireScope('user'),
        validate('param', SubscriptionIdParam),
        async (c) => {
          const user = currentUser(c.var.user);
          const { id } = c.req.valid('param');
          const ctx = routeContext(c, options);
          const found = await liveSubscription(ctx.db, user.id, id);
          if (found === null) {
            return subscriptionNotFound(c);
          }
          /** 410 with what is known: the flight is over, so there is nothing left to refresh. */
          const archived = async () => {
            const known = await lastKnownFlight(c.env, ctx.db, found.flightKey, ctx.log);
            return c.json(
              {
                ...errorBody(c, 'flight_archived', 'this flight is over and no longer tracked'),
                flight: flightView(known, found.flightKey),
              },
              410,
            );
          };
          if (isTerminalTrackingState(found.trackingState)) {
            // Before any budget: a finished tracker would only be woken as an empty object.
            return archived();
          }
          const slot = userCap('refresh', user.id, new Date(), found.flightKey);
          if (!(await takeCap(ctx.db, slot))) {
            return c.json(capExceededBody(slot, c.var.requestId), 403);
          }
          let result;
          try {
            result = await withDeadline(
              forceRefreshTracker(ctx.trackerFor(found.flightKey), {
                reason: 'user_refresh',
                userId: user.id,
              }),
              ctx.deadlineMs,
              { waitUntil: ctx.waitUntil },
            );
          } catch (error) {
            await releaseCap(ctx.db, slot);
            throw error;
          }
          if (result.kind === 'timeout') {
            // The tracker keeps working (its promise is in waitUntil); the client gets what is
            // known now and the sync feed carries the result.
            const known = await lastKnownFlight(c.env, ctx.db, found.flightKey, ctx.log);
            return c.json(
              {
                ...errorBody(
                  c,
                  'refresh_timeout',
                  'the refresh is still running; showing the last known state',
                ),
                flight: flightView(known, found.flightKey),
              },
              504,
            );
          }
          const refreshed = result.value;
          if (refreshed.outcome === 'denied' && refreshed.reason === 'user_refresh_cap') {
            return c.json(capExceededBody(slot, c.var.requestId), 403);
          }
          if (
            refreshed.outcome === 'skipped' &&
            (refreshed.reason === 'finished' || refreshed.reason === 'absent')
          ) {
            // Postgres has not caught up with the tracker's end yet; nothing was fetched.
            await releaseCap(ctx.db, slot);
            return archived();
          }
          const flight: FlightView = {
            key: found.flightKey,
            phase: refreshed.phase,
            version: refreshed.version,
            snapshot: refreshed.snapshot,
            source: 'tracker',
          };
          return c.json(
            { outcome: refreshed.outcome, reason: refreshed.reason ?? null, flight },
            200,
          );
        },
      )
  );
}

export const flightRoutes = createFlightRoutes();
