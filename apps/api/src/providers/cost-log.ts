/**
 * Cost logging (increment 6). Every `ProviderCallRecord` goes to a `CostLogger` exactly once
 * (`@planeahead/shared` providers rule 4), and where it goes depends on where the call ran:
 *
 *   - Inside a Durable Object (a FlightTracker alarm, a DesignatorResolver search) the logger
 *     APPENDS TO THE OBJECT'S OUTBOX, synchronously, because Durable Objects never open Postgres
 *     (ADR 0007). The persist consumer (increment 7) turns each outbox row into a
 *     `provider_calls` row and one Analytics Engine point (`providerCallPoint` in shared).
 *   - In a Worker (a route, a cron, a queue consumer) there is no outbox, so the logger WRITES
 *     `provider_calls` DIRECTLY through `withDb` and writes the same Analytics Engine point.
 *
 * `createCostLogger` picks by what it is given: an outbox, or an environment with a database.
 * The row insert is idempotent on the record id (a UUIDv7), so a retried write or a record that
 * reaches the table by both paths is stored once.
 */

import { providerCallPoint, type CostLogger, type ProviderCallRecord } from '@planeahead/shared';
import { providerCalls, withDb, type DbEnv } from '@planeahead/db';
import { AnalyticsBudget } from '../queues/analytics';
import { createLogger, type Logger } from '../observability/log';

/** Outbox kind of a provider call record. */
export const PROVIDER_CALL_OUTBOX_KIND = 'provider_call';

/** What a Durable Object hands the logger: an append into its own SQLite outbox. */
export interface OutboxAppender {
  append(kind: typeof PROVIDER_CALL_OUTBOX_KIND, payload: ProviderCallRecord): void;
}

/** The logger inside a Durable Object: a synchronous outbox append, no I/O. */
export class DurableObjectCostLogger implements CostLogger {
  readonly #outbox: OutboxAppender;

  constructor(outbox: OutboxAppender) {
    this.#outbox = outbox;
  }

  record(call: ProviderCallRecord): void {
    this.#outbox.append(PROVIDER_CALL_OUTBOX_KIND, call);
  }
}

/** Longest `error_code` kept in `provider_calls`. */
const ERROR_CODE_MAX_LENGTH = 200;

/** The `provider_calls` row for a record. `flight_instance_id` is resolved by the persist path. */
export function providerCallRow(record: ProviderCallRecord): typeof providerCalls.$inferInsert {
  return {
    id: record.id,
    provider: record.provider,
    operation: record.operation,
    trigger: record.trigger,
    result: record.result,
    httpStatus: record.httpStatus ?? null,
    durationMs: record.latencyMs,
    costUnits: Math.round(record.costUnits),
    costUsdMicros: record.estCostUsdMicros,
    flightKey: record.flightKey ?? null,
    requestId: record.requestId,
    errorCode: record.error === undefined ? null : record.error.slice(0, ERROR_CODE_MAX_LENGTH),
  };
}

export interface WorkerCostLoggerEnv extends DbEnv {
  readonly PROVIDER_CALLS?: AnalyticsEngineDataset | undefined;
}

export interface WorkerCostLoggerOptions {
  /** `ENVIRONMENT`, the fifth blob of the Analytics Engine point. */
  readonly environment: string;
  readonly log?: Logger | undefined;
  /**
   * The INVOCATION's Analytics Engine budget (built at the top of `queue()`, `scheduled()` or
   * `alarm()`, src/queues/analytics.ts), so every writer in one invocation counts against one
   * 200-point budget under the platform's 250. Pass it wherever one exists; the logger builds its
   * own only for a one-off call from a route, where it is the invocation's only writer.
   */
  readonly analytics?: AnalyticsBudget | undefined;
}

/**
 * The logger in a Worker. The Analytics Engine point is written first (synchronous, never
 * throws, counted against the invocation's budget); the row insert may throw, and the caller
 * decides whether a lost ledger row fails its request.
 */
export class WorkerCostLogger implements CostLogger {
  readonly #env: WorkerCostLoggerEnv;
  readonly #environment: string;
  readonly #analytics: AnalyticsBudget;

  constructor(env: WorkerCostLoggerEnv, options: WorkerCostLoggerOptions) {
    this.#env = env;
    this.#environment = options.environment;
    this.#analytics =
      options.analytics ?? new AnalyticsBudget(env.PROVIDER_CALLS, options.log ?? createLogger());
  }

  async record(call: ProviderCallRecord): Promise<void> {
    this.#analytics.write(providerCallPoint(call, this.#environment));
    await withDb(this.#env, async (db) => {
      await db.insert(providerCalls).values(providerCallRow(call)).onConflictDoNothing();
    });
  }

  /** The Analytics Engine counters of this logger's invocation. */
  get analytics(): AnalyticsBudget {
    return this.#analytics;
  }
}

export type CostLoggerScope =
  | { readonly outbox: OutboxAppender }
  | {
      readonly env: WorkerCostLoggerEnv;
      readonly environment: string;
      readonly log?: Logger;
      /** The invocation's shared budget; see `WorkerCostLoggerOptions.analytics`. */
      readonly analytics?: AnalyticsBudget;
    };

/** The logger for where the code runs: an outbox inside a Durable Object, the database outside. */
export function createCostLogger(scope: CostLoggerScope): CostLogger {
  if ('outbox' in scope) {
    return new DurableObjectCostLogger(scope.outbox);
  }
  return new WorkerCostLogger(scope.env, {
    environment: scope.environment,
    log: scope.log,
    analytics: scope.analytics,
  });
}
