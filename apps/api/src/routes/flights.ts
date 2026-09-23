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
 * window); `subscribe` on the tracker; then ONE `db.transaction()` that registers the instance
 * row if the persist consumer has not yet, writes the `flight_subscriptions` row (restoring a
 * tombstoned one rather than inserting a second) and its `user_sync_changes` row. When the
 * tracker accepted the subscriber and the transaction fails, the route unsubscribes (best effort)
 * and releases the counters it took, so neither the tracker nor the caps keep a subscription
 * Postgres never recorded.
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
  type FlightStatus,
  type FlightSubscriptionRowV1,
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

/** What a route reports about a flight next to a subscription. */
export interface FlightView {
  readonly key: FlightKey;
  readonly phase: string;
  readonly version: number;
  readonly snapshot: FlightStatus | null;
  readonly source: KnownFlight['source'];
}

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

function errorBody(c: Context<AppBindings>, error: string, message: string) {
  return { error, message, requestId: c.var.requestId };
}

/** The answer to every resolution that is not a flight key. */
function resolutionFailure(
  c: Context<AppBindings>,
  resolution: Exclude<FlightResolution, { kind: 'resolved' }>,
): Response {
  switch (resolution.kind) {
    case 'not_found':
      return c.json(
        errorBody(c, 'not_found', 'the provider knows no such flight on that date'),
        404,
      );
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

function notFoundOrArchived(c: Context<AppBindings>, instance: KnownInstance | null): Response {
  if (instance !== null && isTerminalTrackingState(instance.trackingState)) {
    return c.json(
      errorBody(c, 'flight_archived', 'this flight is over and no longer tracked'),
      410,
    );
  }
  return c.json(errorBody(c, 'flight_not_found', 'no tracked flight has this key'), 404);
}

function upstreamTimeout(c: Context<AppBindings>): Response {
  return c.json(errorBody(c, 'upstream_timeout', 'the flight tracker did not answer in time'), 504);
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
          return c.json({
            flightKey: resolution.flightKey,
            status,
            tracker: resolution.tracker,
            cached: resolution.cached,
          });
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
              return c.json(
                errorBody(c, 'flight_archived', 'this flight is over and no longer tracked'),
                410,
              );
            }
            flightKey = resolution.flightKey;
          }

          // 2. Already subscribed: the existing row, no caps, no tracker call.
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
            const known = await lastKnownFlight(c.env, ctx.db, flightKey, ctx.log);
            return c.json(
              {
                subscription: subscriptionSyncRow(live, flightKey),
                flight: flightView(known, flightKey),
                created: false,
              },
              200,
            );
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
            return c.json(
              errorBody(c, 'flight_archived', 'this flight is over and no longer tracked'),
              410,
            );
          }

          // 4. The caps, in order; the counter row is the serialization point.
          const refuse = async (slot: CapSlot): Promise<Response> => {
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
            // The call may still land: undo it when it does, so the tracker never keeps a
            // subscriber this request did not record.
            ctx.waitUntil(
              subscribeCall.then(
                () => unsubscribeQuietly(ctx, flightKey, subscriptionId),
                () => undefined,
              ),
            );
            await ledger.releaseAll([...CREATION_CAPS]);
            return upstreamTimeout(c);
          }
          if (subscribed.value.status === 'archived') {
            await ledger.releaseAll([...CREATION_CAPS]);
            return c.json(
              errorBody(c, 'flight_archived', 'this flight is over and no longer tracked'),
              410,
            );
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
            // The tracker has the subscriber and Postgres does not: undo both halves.
            ctx.log.error('flight_subscribe_transaction_failed', {
              flight_key: flightKey,
              ...errorFields(error),
            });
            await unsubscribeQuietly(ctx, flightKey, subscriptionId);
            await ledger.releaseAll([...CREATION_CAPS]);
            const { code, constraint } = pgCode(error);
            if (code === '23505' && constraint === 'flight_subscriptions_pkey') {
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
            if (outcome.row.id !== subscriptionId) {
              await unsubscribeQuietly(ctx, flightKey, subscriptionId);
            }
            await ledger.releaseAll([...CREATION_CAPS]);
          }
          const subscription: FlightSubscriptionRowV1 = subscriptionSyncRow(outcome.row, flightKey);
          return c.json(
            {
              subscription,
              flight: {
                key: flightKey,
                phase: state.phase,
                version: subscribed.value.version ?? state.version ?? 0,
                snapshot: subscribed.value.snapshot ?? state.snapshot,
                source: 'tracker' as const,
              },
              created: outcome.kind !== 'already',
            },
            outcome.kind === 'already' ? 200 : 201,
          );
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
        return c.json({
          flights: rows.map((entry) => {
            const key = entry.flightKey as FlightKey;
            return {
              subscription: subscriptionSyncRow(entry.row, key),
              flight: flightView(flights.get(key), key),
            };
          }),
        });
      })
      .get('/:id', requireScope('user'), validate('param', SubscriptionIdParam), async (c) => {
        const user = currentUser(c.var.user);
        const { id } = c.req.valid('param');
        const ctx = routeContext(c, options);
        const found = await liveSubscription(ctx.db, user.id, id);
        if (found === null) {
          return c.json(errorBody(c, 'subscription_not_found', 'no such subscription'), 404);
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
        return c.json({
          subscription: subscriptionSyncRow(found.row, found.flightKey),
          flight: flightView(flights.get(found.flightKey), found.flightKey),
        });
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
            const [tombstoned] = await tx
              .update(flightSubscriptions)
              .set({ deletedAt: sql`now()` })
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
            return c.json(errorBody(c, 'subscription_not_found', 'no such subscription'), 404);
          }
          // After the commit: Postgres is the record, the tracker's list follows it (idempotent).
          await unsubscribeQuietly(ctx, removed.flightKey, id);
          return c.json({
            deleted: true,
            subscription: subscriptionSyncRow(removed.row, removed.flightKey),
          });
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
            return c.json(errorBody(c, 'subscription_not_found', 'no such subscription'), 404);
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
          return c.json({
            flightKey: found.flightKey,
            outcome: refreshed.outcome,
            reason: refreshed.reason ?? null,
            phase: refreshed.phase,
            version: refreshed.version,
            snapshot: refreshed.snapshot,
          });
        },
      )
  );
}

export const flightRoutes = createFlightRoutes();
