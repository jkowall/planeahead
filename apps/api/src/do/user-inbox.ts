/**
 * UserInbox Durable Object.
 *
 * One object per user. Phase 1 holds the per-device notification fan-out, the delivery
 * receipts and the Live Activity push-to-start tokens here. Phase 0 ships the class so the
 * namespace exists from the first deploy. Call sites pass `locationHint` on `getByName` for the
 * same reason FlightTracker does.
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

export class UserInbox extends DurableObject<Env> {
  /** Schema version this build expects. Reported by `GET /health` without touching an object. */
  static readonly SCHEMA_VERSION = 0;

  /** Append only, in order. Index 0 is migration id 1. Empty until the class gets real tables. */
  static readonly MIGRATIONS: SqlMigrations = [];

  #schema: MigrationResult = EMPTY_MIGRATION_RESULT;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    blockOnMigrations(ctx, UserInbox.MIGRATIONS, (result) => {
      this.#schema = result;
    });
  }

  /** Liveness and schema probe. Cheap, does no I/O, and creates the object if it did not exist. */
  ping(): DurableObjectPing {
    return {
      className: 'UserInbox',
      schemaVersion: UserInbox.SCHEMA_VERSION,
      appliedVersion: this.#schema.version,
      applied: this.#schema.applied,
    };
  }
}
