/**
 * Free-tier caps in `usage_counters` (increment 8, ruling K2).
 *
 * One statement decides a take:
 *
 *   insert into usage_counters (...) values (..., 1)
 *   on conflict (scope, subject, counter, window_start)
 *   do update set count = usage_counters.count + 1 where usage_counters.count < $cap
 *   returning count
 *
 * A returned row means the slot was taken; zero rows means the cap was hit. The counter row is the
 * serialization point: `ON CONFLICT DO UPDATE` is atomic, and under Read Committed a blocked
 * UPDATE re-evaluates its WHERE against the row the winner committed, so twenty concurrent takes
 * against a cap of five yield exactly five rows. A `count(*) < cap` guard inside an INSERT would
 * not (an insert creates no row to lock), which is why no such guard exists anywhere. The rate
 * limit binding is never used for a cap: it is per colo and documented as not an accounting
 * system.
 *
 * Windows: the UTC day for the monotonic caps (`instances_created`, `tracker_creations`,
 * `refresh:{flightKey}`), the epoch for the two that go down again (`active_subscriptions`,
 * `live_tracked`), which are decremented on unsubscribe and never below zero. Drift between those
 * two and `flight_subscriptions` (a crash between a take and its compensating release) is repaired
 * by the nightly reconciliation the increment 12 housekeeping cron adds.
 */

import { sql } from 'drizzle-orm';
import type { Db } from '@planeahead/db';
import { type CapName, type FlightKey, freeTierLimit, uuidv7 } from '@planeahead/shared';

/** Anything that can run a statement: the request's handle or a transaction on it. */
export type SqlExecutor = Pick<Db, 'execute'>;

export type CapScope = 'user' | 'ip';

/** One counter slot: which row, and the limit a take is checked against. */
export interface CapSlot {
  readonly cap: CapName;
  readonly scope: CapScope;
  readonly subject: string;
  readonly counter: string;
  readonly windowStart: string;
  readonly limit: number;
}

/** The window of the counters that never go down: the UTC day of `now`. */
export function utcDayStart(now: Date): string {
  return `${now.toISOString().slice(0, 10)}T00:00:00Z`;
}

/** The fixed window of the non-monotonic counters. */
export const EPOCH_WINDOW = '1970-01-01T00:00:00Z';

const NON_MONOTONIC: ReadonlySet<CapName> = new Set(['active_subscriptions', 'live_tracked']);

/** A per-user slot. `refresh` needs the flight key: its counter is `refresh:{flightKey}`. */
export function userCap(cap: CapName, userId: string, now: Date, flightKey?: FlightKey): CapSlot {
  if (cap === 'refresh' && flightKey === undefined) {
    throw new Error('the refresh cap is per flight: pass the flight key');
  }
  return {
    cap,
    scope: 'user',
    subject: userId,
    counter: cap === 'refresh' ? `refresh:${String(flightKey)}` : cap,
    windowStart: NON_MONOTONIC.has(cap) ? EPOCH_WINDOW : utcDayStart(now),
    limit: freeTierLimit(cap),
  };
}

/** The anonymous per-IP slot; `subject` is the salted HMAC of the address (src/lib/hmac.ts). */
export function ipTrackerCreationCap(saltedSubject: string, now: Date): CapSlot {
  return {
    cap: 'tracker_creations',
    scope: 'ip',
    subject: saltedSubject,
    counter: 'tracker_creations',
    windowStart: utcDayStart(now),
    limit: freeTierLimit('tracker_creations'),
  };
}

/** Takes one unit of `slot`; false when the cap is already reached. */
export async function takeCap(db: SqlExecutor, slot: CapSlot): Promise<boolean> {
  if (slot.limit <= 0) {
    return false;
  }
  const rows = await db.execute<{ count: number }>(sql`
    insert into usage_counters (id, scope, subject, counter, window_start, count)
    values (${uuidv7()}, ${slot.scope}, ${slot.subject}, ${slot.counter},
            ${slot.windowStart}::timestamptz, 1)
    on conflict (scope, subject, counter, window_start)
    do update set count = usage_counters.count + 1
    where usage_counters.count < ${slot.limit}
    returning count
  `);
  return rows.length > 0;
}

/** Gives one unit of `slot` back, never below zero. Used on unsubscribe and on compensation. */
export async function releaseCap(db: SqlExecutor, slot: CapSlot): Promise<void> {
  await db.execute(sql`
    update usage_counters set count = count - 1
    where scope = ${slot.scope} and subject = ${slot.subject} and counter = ${slot.counter}
      and window_start = ${slot.windowStart}::timestamptz and count > 0
  `);
}

/** The slots a request has taken, released together when a later step fails. */
export class CapLedger {
  readonly #taken: CapSlot[] = [];

  constructor(private readonly db: SqlExecutor) {}

  /** Takes `slot`; on refusal returns the slot that was hit and takes nothing. */
  async take(slot: CapSlot): Promise<CapSlot | null> {
    if (await takeCap(this.db, slot)) {
      this.#taken.push(slot);
      return null;
    }
    return slot;
  }

  has(cap: CapName): boolean {
    return this.#taken.some((slot) => slot.cap === cap);
  }

  /** Releases `cap` if it was taken (best effort per slot); returns whether it was. */
  async release(cap: CapName): Promise<boolean> {
    const index = this.#taken.findIndex((slot) => slot.cap === cap);
    const slot = index < 0 ? undefined : this.#taken[index];
    if (slot === undefined) {
      return false;
    }
    this.#taken.splice(index, 1);
    await releaseCap(this.db, slot);
    return true;
  }

  /** Releases every slot taken, except those named in `keep`. */
  async releaseAll(keep: readonly CapName[] = []): Promise<void> {
    const toRelease = this.#taken.filter((slot) => !keep.includes(slot.cap));
    this.#taken.splice(0, this.#taken.length, ...this.#taken.filter((s) => keep.includes(s.cap)));
    for (const slot of toRelease) {
      await releaseCap(this.db, slot);
    }
  }
}

/** The 403 body for a cap that was hit. */
export function capExceededBody(slot: CapSlot, requestId: string) {
  return {
    error: 'cap_exceeded' as const,
    cap: slot.cap,
    limit: slot.limit,
    message: `the free plan allows ${String(slot.limit)} (${slot.cap.replaceAll('_', ' ')})`,
    requestId,
  };
}
