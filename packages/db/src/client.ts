/**
 * Database clients. Two entry points, one driver (postgres.js, ADR 0009):
 *
 *   - `withDb(env, fn)` for Workers. Creates the client inside the handler from the Hyperdrive
 *     binding's connection string with `{ max: 5, fetch_types: false, prepare: true }` (the
 *     options Cloudflare's Hyperdrive example uses) and never calls `end()`: Hyperdrive cleans
 *     up at the end of the invocation. `max: 5` stays under the six-connection per-invocation
 *     limit on outstanding requests; `fetch_types: false` skips a round-trip and is safe because
 *     the schema has no Postgres array columns; `prepare: true` keeps Hyperdrive's statement
 *     cache working.
 *   - `createNodeDb(url)` for CI, scripts and tests: the same options plus an explicit
 *     `close()` because there is no Hyperdrive to reclaim the socket.
 *
 * No client is created at module scope (ESLint `planeahead/no-module-scope-drizzle`).
 */

import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import * as schema from './schema/index';

export type Db = PostgresJsDatabase<typeof schema>;

/** The subset of a Hyperdrive binding this package reads. */
export interface HyperdriveBinding {
  readonly connectionString: string;
}

export interface DbEnv {
  readonly DB: HyperdriveBinding;
}

export const WORKER_CLIENT_OPTIONS = Object.freeze({
  max: 5,
  fetch_types: false,
  prepare: true,
});

/**
 * Opens a client on the Hyperdrive binding and returns the Drizzle handle. Does not call
 * `end()`: Hyperdrive closes connections when the fetch, queue or Workflow invocation ends.
 *
 * Call it inside a handler, never at module scope (the ESLint rule enforces the call site). It
 * exists for code that has to hold ONE client for the life of a request across several callers,
 * such as the auth middleware, which resolves the session and then hands the same handle to the
 * route so a request does not open a second pool. Everything else uses `withDb`.
 */
export function openDb(env: DbEnv): Db {
  const client = postgres(env.DB.connectionString, WORKER_CLIENT_OPTIONS);
  return drizzle(client, { schema });
}

/**
 * Opens a client on the Hyperdrive binding, runs `fn`, and returns its result. Does not call
 * `end()`: Hyperdrive closes connections when the fetch, queue or Workflow invocation ends.
 */
export async function withDb<T>(env: DbEnv, fn: (db: Db) => Promise<T>): Promise<T> {
  return fn(openDb(env));
}

export interface NodeDb {
  readonly db: Db;
  /** The raw postgres.js client for tagged-template SQL in tests and scripts. */
  readonly sql: Sql;
  close(): Promise<void>;
}

export interface NodeDbOptions {
  /** Pool size; tests use 1 so session-level state such as advisory locks is predictable. */
  readonly max?: number;
}

/** A client for a plain URL (CI, drizzle-kit, migrate.ts, seed scripts, tests). Close it. */
export function createNodeDb(url: string, options: NodeDbOptions = {}): NodeDb {
  const client = postgres(url, { ...WORKER_CLIENT_OPTIONS, max: options.max ?? 5 });
  const db = drizzle(client, { schema });
  return {
    db,
    sql: client,
    close: () => client.end(),
  };
}
