/**
 * What every PlaneAhead Durable Object class shares in increment 4: the schema runner call in the
 * constructor and the `ping()` contract that `test/workers/do-ping.test.ts` and the staging smoke
 * step use to prove the class is wired and its storage is SQLite backed.
 *
 * Deliberately not a base class. Increment 6 (ProviderBudget) and increment 7 (FlightTracker,
 * DesignatorResolver) give these classes real fields and real constructors, and a base class that
 * runs migrations inside its own constructor would run them before the subclass's field
 * initializers, which is exactly the kind of ordering bug that is invisible until it is not.
 * Each class calls `blockOnMigrations` itself as the last statement of its constructor.
 */

import { type MigrationResult, type SqlMigrations, runSqlMigrations } from './migrate';

/** Shape returned by every class's `ping()` RPC. */
export interface DurableObjectPing {
  /** The class name, so a caller can tell which binding answered. */
  readonly className: string;
  /** The compiled-in `static SCHEMA_VERSION`: what this build expects. */
  readonly schemaVersion: number;
  /** `MAX(id)` in `_sql_schema_migrations` for this object: what this object actually has. */
  readonly appliedVersion: number;
  /** Migration ids applied when this instance was constructed. Empty on a warm object. */
  readonly applied: readonly number[];
}

/**
 * Runs the class's migrations under `ctx.blockConcurrencyWhile`, which delays every incoming
 * request (including the RPC that caused the object to be created) until the schema is current.
 *
 * `assign` is called synchronously inside the callback. A throw inside `blockConcurrencyWhile`
 * terminates and resets the object, which is the behaviour we want for a migration failure: the
 * next request reconstructs the object and retries from the last committed migration.
 */
export function blockOnMigrations(
  ctx: DurableObjectState,
  migrations: SqlMigrations,
  assign: (result: MigrationResult) => void,
): void {
  // The callback is synchronous on purpose: `runSqlMigrations` uses `transactionSync`, whose
  // callback must complete synchronously, and an `await` anywhere in this path would be a bug
  // waiting to happen. `blockConcurrencyWhile` wants a Promise, so one is handed back directly.
  void ctx.blockConcurrencyWhile(() => {
    assign(runSqlMigrations(ctx, migrations));
    return Promise.resolve();
  });
}
