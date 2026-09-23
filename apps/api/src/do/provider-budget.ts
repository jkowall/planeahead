/**
 * ProviderBudget Durable Object.
 *
 * One object per provider per UTC day, for example `aerodatabox:2026-09-19`.
 * Holds the daily unit ledger, the per-second token bucket and the kill switch that stops polling
 * when the hard cap is hit.
 *
 * Increment 6 fills this in. The Rules of Durable Objects call a global counter in one object an
 * anti-pattern, so the module comment there carries the arithmetic (roughly 3.4 debits per second
 * average, 14 per second at peak) and the 8-way sharding escape hatch.
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

export class ProviderBudget extends DurableObject<Env> {
  /** Schema version this build expects. Reported by `GET /health` without touching an object. */
  static readonly SCHEMA_VERSION = 0;

  /** Append only, in order. Index 0 is migration id 1. Empty until the class gets real tables. */
  static readonly MIGRATIONS: SqlMigrations = [];

  #schema: MigrationResult = EMPTY_MIGRATION_RESULT;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    blockOnMigrations(ctx, ProviderBudget.MIGRATIONS, (result) => {
      this.#schema = result;
    });
  }

  /** Liveness and schema probe. Cheap, does no I/O, and creates the object if it did not exist. */
  ping(): DurableObjectPing {
    return {
      className: 'ProviderBudget',
      schemaVersion: ProviderBudget.SCHEMA_VERSION,
      appliedVersion: this.#schema.version,
      applied: this.#schema.applied,
    };
  }
}
