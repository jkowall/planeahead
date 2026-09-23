/**
 * FlightTracker Durable Object.
 *
 * One object per canonical flight key (ADR 0003), for example `AAL-100-2026-09-19-KJFK`.
 * This is where the shared-flight invariant becomes structural: every subscriber to a flight
 * talks to this one object, so a refresh costs one provider call no matter how many users are
 * watching.
 *
 * Increment 7 fills this in: the nine SQLite tables, the idempotent alarm handler, the per-flight
 * budget ledger, the outbox to the `persist` queue and the `deleteAll()` finish path. Call sites
 * pass `locationHint: 'enam'` to `getByName`, because only the first touch of an object honours
 * the hint and there is no separate create call.
 *
 * It never opens Postgres (ADR 0007). Every write leaves through the outbox.
 *
 * Increment 4 ships the shell: SQLite storage declared through the `exports` field in
 * wrangler.jsonc, the schema runner in the constructor under `blockConcurrencyWhile`, and a
 * `ping()` RPC. `MIGRATIONS` is empty, so `SCHEMA_VERSION` is 0 and a fresh object applies
 * nothing. Adding the first migration means appending to `MIGRATIONS` and bumping
 * `SCHEMA_VERSION` to match its id.
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import { type DurableObjectPing, blockOnMigrations } from './base';
import { EMPTY_MIGRATION_RESULT, type MigrationResult, type SqlMigrations } from './migrate';

export class FlightTracker extends DurableObject<Env> {
  /** Schema version this build expects. Reported by `GET /health` without touching an object. */
  static readonly SCHEMA_VERSION = 0;

  /** Append only, in order. Index 0 is migration id 1. Empty until the class gets real tables. */
  static readonly MIGRATIONS: SqlMigrations = [];

  #schema: MigrationResult = EMPTY_MIGRATION_RESULT;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    blockOnMigrations(ctx, FlightTracker.MIGRATIONS, (result) => {
      this.#schema = result;
    });
  }

  /** Liveness and schema probe. Cheap, does no I/O, and creates the object if it did not exist. */
  ping(): DurableObjectPing {
    return {
      className: 'FlightTracker',
      schemaVersion: FlightTracker.SCHEMA_VERSION,
      appliedVersion: this.#schema.version,
      applied: this.#schema.applied,
    };
  }
}
