/**
 * Retention deletes in bounded batches (increment 12, the housekeeping queue).
 *
 * One `DELETE` over a large table can run past Hyperdrive's 60 s statement limit and holds its
 * row locks for as long as it runs, so every housekeeping purge deletes at most `batch` rows per
 * statement, by `ctid`, and stops when a batch comes back short (nothing left) or when the
 * message's wall budget is spent (the step then enqueues a continuation of itself). The batch is
 * named by `ctid = any(array(...))`, which the planner answers with a TID scan, so the delete
 * never rescans the table for the rows the select just found. Each batch is
 * its own statement and commits on its own: a purge is idempotent, so a batch that is retried
 * after a crash deletes whatever is still there and nothing else.
 */

import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '@planeahead/db';

/** Rows per statement: small enough to stay far below the statement limit, big enough to matter. */
export const DELETE_BATCH_ROWS = 5_000;

/** A wall-clock budget for one queue message's work, measured on an injectable clock. */
export class WallBudget {
  readonly #now: () => number;
  readonly #deadline: number;

  constructor(now: () => number, budgetMs: number) {
    this.#now = now;
    this.#deadline = now() + budgetMs;
  }

  /** True once the budget is gone: stop, and hand the rest to a continuation. */
  get spent(): boolean {
    return this.#now() >= this.#deadline;
  }
}

export interface BatchedDeleteResult {
  readonly deleted: number;
  /** False when the budget ran out with rows possibly left: continue in another message. */
  readonly done: boolean;
}

/**
 * Deletes rows of `table` matching `where` in batches of `batch`. `where` is a SQL fragment over
 * the bare table (no alias); `table` is a trusted identifier from this codebase, never input.
 */
export async function deleteInBatches(
  db: Pick<Db, 'execute'>,
  table: string,
  where: SQL,
  budget: WallBudget,
  batch: number = DELETE_BATCH_ROWS,
): Promise<BatchedDeleteResult> {
  let deleted = 0;
  const target = sql.identifier(table);
  for (;;) {
    const [row] = await db.execute<{ n: number }>(sql`
      with doomed as (select ctid from ${target} where ${where} limit ${batch}),
           gone as (delete from ${target}
                    where ctid = any(array(select ctid from doomed)) returning 1)
      select count(*)::int as n from gone
    `);
    const n = row?.n ?? 0;
    deleted += n;
    if (n < batch) {
      return { deleted, done: true };
    }
    if (budget.spent) {
      return { deleted, done: false };
    }
  }
}
