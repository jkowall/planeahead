/**
 * AirportState Durable Object.
 *
 * One object per airport. Phase 1 holds the FIDS board cache, the delay picture and the
 * per-airport subscriber fan-out here. Phase 0 ships the class so the Durable Object namespace
 * exists from the first deploy: adding a class later is a configuration change on a live Worker,
 * and this one is free to carry.
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

export class AirportState extends DurableObject<Env> {
  /** Schema version this build expects. Reported by `GET /health` without touching an object. */
  static readonly SCHEMA_VERSION = 0;

  /** Append only, in order. Index 0 is migration id 1. Empty until the class gets real tables. */
  static readonly MIGRATIONS: SqlMigrations = [];

  #schema: MigrationResult = EMPTY_MIGRATION_RESULT;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    blockOnMigrations(ctx, AirportState.MIGRATIONS, (result) => {
      this.#schema = result;
    });
  }

  /** Liveness and schema probe. Cheap, does no I/O, and creates the object if it did not exist. */
  ping(): DurableObjectPing {
    return {
      className: 'AirportState',
      schemaVersion: AirportState.SCHEMA_VERSION,
      appliedVersion: this.#schema.version,
      applied: this.#schema.applied,
    };
  }
}
