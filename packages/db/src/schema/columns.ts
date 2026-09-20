/**
 * Shared column helpers. Every SQL identifier is written out in snake_case at the call site or
 * inside these helpers; nothing relies on Drizzle's `casing` option (it moves in 1.0).
 *
 * Conventions (docs/increments/03-db-schema.md):
 *   - `id` is a uuid primary key with the PG18 `uuidv7()` default as a fallback; application code
 *     supplies ids from `@planeahead/shared` (ADR 0006);
 *   - every instant is `timestamptz`; `mode: 'string'` everywhere except the five Better Auth
 *     tables, which use `mode: 'date'` because Better Auth writes JavaScript `Date` objects and
 *     the spike showed `mode: 'string'` rejects a Date on INSERT;
 *   - `updated_at` is maintained by the `set_updated_at()` trigger (custom migration), not by
 *     `$onUpdate`, so an UPDATE issued by raw SQL or a queue consumer also bumps it;
 *   - secrets are `<name>_enc bytea` plus `<name>_key_version smallint`; presented tokens are a
 *     SHA-256 `token_hash bytea` plus `token_prefix text` for lookup.
 */

import { sql } from 'drizzle-orm';
import { customType, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** drizzle-orm 0.45 has no built-in bytea column; postgres.js returns a Buffer (a Uint8Array). */
export const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return 'bytea';
  },
});

/** 64-bit transaction id. Read as a decimal string; it does not fit a JavaScript number. */
export const xid8 = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'xid8';
  },
  fromDriver(value) {
    return String(value);
  },
});

export const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`uuidv7()`);

/** A nullable timestamptz read and written as an ISO string. */
export const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });

/** Better Auth tables only: timestamptz as a JavaScript Date. */
export const authInstant = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const timestamps = () => ({
  createdAt: instant('created_at').notNull().defaultNow(),
  updatedAt: instant('updated_at').notNull().defaultNow(),
});

export const createdOnly = () => ({
  createdAt: instant('created_at').notNull().defaultNow(),
});

/** Better Auth's own `createdAt`/`updatedAt`, `mode: 'date'`. */
export const authTimestamps = () => ({
  createdAt: authInstant('created_at').notNull().defaultNow(),
  updatedAt: authInstant('updated_at').notNull().defaultNow(),
});

/** Tombstone. Only on sync entities (the mobile app replays deletes from it). */
export const softDelete = () => ({
  deletedAt: instant('deleted_at'),
});

type EncryptedColumns<TName extends string> = Record<`${TName}Enc`, ReturnType<typeof bytea>> &
  Record<`${TName}KeyVersion`, ReturnType<typeof smallint>>;

/**
 * Envelope-encrypted secret: `<sql>_enc bytea` (AES-256-GCM ciphertext with IV and tag, AAD
 * `table:column:row_id`) and `<sql>_key_version smallint` (which KEK wrapped the row owner's
 * DEK). Both nullable: a row may exist before the secret is captured.
 */
export function encrypted<TName extends string>(
  tsName: TName,
  sqlName: string,
): EncryptedColumns<TName> {
  return {
    [`${tsName}Enc`]: bytea(`${sqlName}_enc`),
    [`${tsName}KeyVersion`]: smallint(`${sqlName}_key_version`),
  } as EncryptedColumns<TName>;
}

/** Presented token: SHA-256 of the secret plus its first 8 characters for lookups and support. */
export const tokenHash = () => ({
  tokenHash: bytea('token_hash').notNull(),
  tokenPrefix: text('token_prefix').notNull(),
});

/** Case-sensitive ICAO airline designator, e.g. `AAL`. */
export const ICAO_CARRIER_SQL_RE = '^[A-Z]{3}$';
/** ICAO airport code or an OurAirports ident used as one, e.g. `KJFK`. */
export const ICAO_AIRPORT_SQL_RE = '^[A-Z0-9]{4}$';
/** Flight number as `@planeahead/shared` normalises it: no leading zeros, optional suffix. */
export const FLIGHT_NUMBER_SQL_RE = '^[1-9][0-9]{0,3}[A-Z]?$';

/**
 * A single-quoted SQL string literal for `check()` expressions. A JavaScript string interpolated
 * into a `sql` template becomes a bind parameter, which drizzle-kit renders as `$1` inside
 * CREATE TABLE and Postgres rejects; `sql.raw` keeps it inline.
 */
export function literal(value: string) {
  return sql.raw(`'${value.replaceAll("'", "''")}'`);
}

/** Renders a list of allowed values for a `check()` expression. */
export function inList(values: readonly string[]) {
  return sql.raw(values.map((value) => `'${value.replaceAll("'", "''")}'`).join(', '));
}
