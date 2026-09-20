/**
 * DesignatorResolver Durable Object.
 *
 * One object per marketing designator and local date, for example `AA100-2026-09-19`.
 * Serialises the first provider call for an unresolved designator so that fifty concurrent
 * searches for the same flight cost one AeroDataBox call, then canonicalises the flight key and
 * creates or adopts the FlightTracker.
 *
 * Increment 7 fills this in, including the 24 hour resolution cache and the alarm driven
 * `deleteAll()` at expiry.
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

export class DesignatorResolver extends DurableObject<Env> {
  /** Schema version this build expects. Reported by `GET /health` without touching an object. */
  static readonly SCHEMA_VERSION = 0;

  /** Append only, in order. Index 0 is migration id 1. Empty until the class gets real tables. */
  static readonly MIGRATIONS: SqlMigrations = [];

  #schema: MigrationResult = EMPTY_MIGRATION_RESULT;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    blockOnMigrations(ctx, DesignatorResolver.MIGRATIONS, (result) => {
      this.#schema = result;
    });
  }

  /** Liveness and schema probe. Cheap, does no I/O, and creates the object if it did not exist. */
  ping(): DurableObjectPing {
    return {
      className: 'DesignatorResolver',
      schemaVersion: DesignatorResolver.SCHEMA_VERSION,
      appliedVersion: this.#schema.version,
      applied: this.#schema.applied,
    };
  }
}
