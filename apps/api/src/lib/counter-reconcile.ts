/**
 * `usage_counters` reconciliation (increment 12, housekeeping step 5; increment 8 ruling O3).
 *
 * The two non-monotonic caps, `active_subscriptions` and `live_tracked`, are counter rows (the
 * serialization point of every take) kept in step with `flight_subscriptions` by the routes and
 * the persist consumer: a subscribe takes, an unsubscribe releases, the persist consumer takes
 * `live_tracked` where a flight enters its window and releases it where the flight is over, each
 * idempotent through the row's `live_tracked` flag. That is the path; this is the repair, for the
 * drift a crash between a take and its compensating release leaves.
 *
 * Truth, per user: the live (not tombstoned) subscriptions, and of those the ones flagged
 * `live_tracked`. A counter that disagrees is set to the truth and the drift is logged per user;
 * a user with live subscriptions and no counter row gets one. Race safety: the subscribe route
 * takes its caps (committed) BEFORE its tracker call and its transaction, so a request in flight
 * is a counter ahead of its rows for up to its deadline, and a repair in that window would undo
 * a take the route is about to justify. So a user is repaired only when BOTH the counter row and
 * the user's subscriptions have been quiet for `COUNTER_QUIET_MS` (the `set_updated_at` trigger
 * stamps every change to either), and the UPDATE re-checks the count it read, so a take that
 * lands between the read and the write wins and the repair waits for the next night.
 *
 * Also removed: user-scoped counters of every kind whose user no longer exists and that are just
 * as quiet (the account deletion removes them in its transaction; a request that raced the
 * deletion through the cookie cache can leave one behind, since `usage_counters` has no foreign
 * key).
 */

import { sql } from 'drizzle-orm';
import type { Db } from '@planeahead/db';
import type { Logger } from '../observability/log';
import { EPOCH_WINDOW } from './caps';

/** A user whose counter or subscriptions changed this recently is not repaired tonight. */
export const COUNTER_QUIET_MS = 10 * 60_000;

/** At most this many drifted counters are logged one by one; the audit row carries the total. */
const DRIFT_LOG_LIMIT = 200;

export interface CounterDrift {
  readonly subject: string;
  readonly counter: string;
  readonly before: number;
  readonly after: number;
}

export interface CounterReconcileResult {
  /** Counters set to the truth. */
  readonly repaired: number;
  /** Counter rows created for users with live subscriptions and none. */
  readonly created: number;
  /** User-scoped counters of users that no longer exist. */
  readonly orphansDeleted: number;
  readonly drift: readonly CounterDrift[];
}

export async function reconcileUsageCounters(
  db: Db,
  log: Logger,
  quietMs: number = COUNTER_QUIET_MS,
): Promise<CounterReconcileResult> {
  const quiet = sql`now() - make_interval(secs => ${quietMs / 1_000})`;
  const truth = sql`
    select s.user_id::text as subject,
           count(*) filter (where s.deleted_at is null)::int as active,
           count(*) filter (where s.deleted_at is null and s.live_tracked)::int as live,
           max(s.updated_at) as last_change
    from flight_subscriptions s
    group by s.user_id
  `;
  const repaired = await db.execute<{
    subject: string;
    counter: string;
    before: number;
    after: number;
  }>(sql`
    with truth as (${truth}),
    target as (
      select c.id, c.subject, c.counter, c.count as before,
             case c.counter
               when 'active_subscriptions' then coalesce(t.active, 0)
               else coalesce(t.live, 0)
             end as after
      from usage_counters c
      left join truth t on t.subject = c.subject
      where c.scope = 'user'
        and c.counter in ('active_subscriptions', 'live_tracked')
        and c.window_start = ${EPOCH_WINDOW}::timestamptz
        and c.updated_at < ${quiet}
        and (t.last_change is null or t.last_change < ${quiet})
        and exists (select 1 from users u where u.id::text = c.subject)
    )
    update usage_counters u
    set count = target.after
    from target
    where u.id = target.id and u.count = target.before and target.before <> target.after
    returning target.subject, target.counter, target.before, target.after
  `);
  const created = await db.execute<{ subject: string; counter: string; after: number }>(sql`
    with truth as (${truth}),
    wanted as (
      select t.subject, k.counter,
             case k.counter when 'active_subscriptions' then t.active else t.live end as after
      from truth t
      cross join (values ('active_subscriptions'), ('live_tracked')) as k(counter)
      where t.last_change < ${quiet}
        and exists (select 1 from users u where u.id::text = t.subject)
    )
    insert into usage_counters (id, scope, subject, counter, window_start, count)
    select uuidv7(), 'user', w.subject, w.counter, ${EPOCH_WINDOW}::timestamptz, w.after
    from wanted w
    where w.after > 0
    on conflict (scope, subject, counter, window_start) do nothing
    returning subject, counter, count as after
  `);
  const [orphans] = await db.execute<{ n: number }>(sql`
    with gone as (
      delete from usage_counters c
      where c.scope = 'user'
        and c.updated_at < ${quiet}
        and not exists (select 1 from users u where u.id::text = c.subject)
      returning 1
    )
    select count(*)::int as n from gone
  `);
  const drift: CounterDrift[] = [
    ...repaired.map((row) => ({
      subject: row.subject,
      counter: row.counter,
      before: row.before,
      after: row.after,
    })),
    ...created.map((row) => ({
      subject: row.subject,
      counter: row.counter,
      before: 0,
      after: row.after,
    })),
  ];
  for (const entry of drift.slice(0, DRIFT_LOG_LIMIT)) {
    log.warn('usage_counter_drift_repaired', {
      user_id: entry.subject,
      counter: entry.counter,
      before: entry.before,
      after: entry.after,
    });
  }
  return {
    repaired: repaired.length,
    created: created.length,
    orphansDeleted: orphans?.n ?? 0,
    drift,
  };
}
