/**
 * Shared column helpers. Every SQL identifier is written out in snake_case at the call site or
 * inside these helpers; nothing relies on Drizzle's `casing` option (it moves in 1.0).
 *
 * Conventions (docs/increments/03-db-schema.md, docs/schema-review.md section 2):
 *   - `id` is a uuid primary key with the PG18 `uuidv7()` default as a fallback; application code
 *     supplies ids from `@planeahead/shared` (ADR 0006);
 *   - every instant is `timestamptz`, read and written as a string. `instant()` normalises the
 *     text Postgres renders (`2026-09-19 22:30:00+00`, in the session time zone) to an ISO-8601
 *     UTC string (`2026-09-19T22:30:00Z`) that satisfies `IsoInstantSchema` in @planeahead/shared,
 *     so no read path depends on the session `TimeZone` and nothing has to remember a mapper;
 *     the five Better Auth tables use Drizzle's `mode: 'date'` because Better Auth writes
 *     JavaScript `Date` objects and the spike showed a string column rejects a Date on INSERT;
 *   - `updated_at` is maintained by the `set_updated_at()` trigger (custom migration), not by
 *     `$onUpdate`, so an UPDATE issued by raw SQL or a queue consumer also bumps it;
 *   - secrets are `<name>_enc bytea` plus `<name>_key_version smallint`; presented tokens are a
 *     SHA-256 `token_hash bytea` plus `token_prefix text` for lookup;
 *   - codes (ICAO, IATA, flight numbers, Mode S hex) carry a format check wherever they are
 *     stored, so a lower-case or padded value can never fork a lookup or a KV key.
 */

import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  smallint,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

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

/**
 * A timestamptz rendering as Postgres emits it (`2026-09-19 22:30:00.123456+00`,
 * `2026-09-19 18:30:00-04`, historic `+00:53:28` offsets) or an ISO-8601 string with a zone
 * designator. Seconds are optional on input; the zone is not.
 */
const INSTANT_RE =
  /^(\d{4,6})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}(?::?\d{2})?(?::?\d{2})?)$/;

export class InstantFormatError extends TypeError {
  override readonly name = 'InstantFormatError';
}

/**
 * Normalises a Postgres timestamptz text value to an ISO-8601 UTC instant that satisfies
 * `IsoInstantSchema` in @planeahead/shared (`2026-09-19T22:30:00.123456Z`). Fractional seconds
 * are copied verbatim, so the value round-trips through Postgres without losing microseconds.
 * Idempotent on an ISO `Z` string. Use it on raw SQL reads (`sql<string>`, `db.execute`);
 * `instant()` columns apply it on every Drizzle read.
 */
export function toIsoInstant(value: string): string {
  const match = INSTANT_RE.exec(value);
  if (match === null) {
    throw new InstantFormatError(`not a timestamptz value with a zone designator: ${value}`);
  }
  const year = match[1] ?? '';
  const month = match[2] ?? '';
  const day = match[3] ?? '';
  const hour = match[4] ?? '';
  const minute = match[5] ?? '';
  const second = match[6] ?? '00';
  const fraction = match[7] ?? '';
  const zone = match[8] ?? 'Z';
  if (zone === 'Z' || /^[+-]00(?::?00)?(?::?00)?$/.test(zone)) {
    return `${year}-${month}-${day}T${hour}:${minute}:${second}${fraction}Z`;
  }
  const sign = zone.startsWith('-') ? -1 : 1;
  const digits = zone.slice(1).replaceAll(':', '');
  const offsetSeconds =
    Number(digits.slice(0, 2)) * 3600 +
    Number(digits.slice(2, 4) || '0') * 60 +
    Number(digits.slice(4, 6) || '0');
  const utc = new Date(0);
  utc.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  utc.setUTCHours(Number(hour), Number(minute), Number(second), 0);
  utc.setTime(utc.getTime() - sign * offsetSeconds * 1000);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return (
    `${pad(utc.getUTCFullYear(), 4)}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())}` +
    `T${pad(utc.getUTCHours())}:${pad(utc.getUTCMinutes())}:${pad(utc.getUTCSeconds())}${fraction}Z`
  );
}

/**
 * Write guard: an instant must carry a zone designator. A bare `2026-09-19 22:30:00` would be
 * interpreted in the session time zone and silently shift the stored instant.
 */
export function assertZonedInstant(value: string): string {
  if (typeof value !== 'string' || !INSTANT_RE.test(value)) {
    throw new InstantFormatError(
      `an instant must be an ISO-8601 string with a zone designator (Z or an offset), got ${String(value)}`,
    );
  }
  return value;
}

/**
 * A `timestamptz` column read as an ISO-8601 UTC string and written as a zoned ISO string.
 * Nullable; chain `.notNull()` and `.default(sql\`now()\`)` as needed.
 */
export const instant = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'timestamp with time zone';
  },
  fromDriver: toIsoInstant,
  toDriver: assertZonedInstant,
});

/** Better Auth tables only: timestamptz as a JavaScript Date. */
export const authInstant = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const timestamps = () => ({
  createdAt: instant('created_at')
    .notNull()
    .default(sql`now()`),
  updatedAt: instant('updated_at')
    .notNull()
    .default(sql`now()`),
});

export const createdOnly = () => ({
  createdAt: instant('created_at')
    .notNull()
    .default(sql`now()`),
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

/** Case-sensitive ICAO airline designator, e.g. `AAL` (ICAO_CARRIER_RE in shared). */
export const ICAO_CARRIER_SQL_RE = '^[A-Z]{3}$';
/** IATA airline designator, e.g. `AA` or `9W` (IATA_CARRIER_RE in shared). */
export const IATA_CARRIER_SQL_RE = '^[A-Z0-9]{2}$';
/** A real four-character ICAO airport code, e.g. `KJFK` (ICAO_AIRPORT_RE in shared). */
export const ICAO_AIRPORT_SQL_RE = '^[A-Z0-9]{4}$';
/** IATA airport code, e.g. `JFK` (IATA_AIRPORT_RE in shared). */
export const IATA_AIRPORT_SQL_RE = '^[A-Z0-9]{3}$';
/**
 * Anything `airports.icao` may hold: a real ICAO code or an OurAirports ident kept as a pseudo
 * code (`03N`, `ID-0004`). Columns that store "the airport as the user knows it" (logbook) use
 * this; columns that name a flight's airports use the strict four-character form.
 */
export const AIRPORT_CODE_SQL_RE = '^[A-Z0-9-]{3,8}$';
/** ICAO aircraft type designator (Doc 8643), two to four characters, e.g. `A1`, `B738`. */
export const ICAO_AIRCRAFT_TYPE_SQL_RE = '^[A-Z0-9]{2,4}$';
/** Mode S transponder address, upper-case hex (ICAO_HEX_RE in shared is case-insensitive). */
export const ICAO_HEX_SQL_RE = '^[0-9A-F]{6}$';
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

/** `check()` that a text column, when not null, matches a POSIX regular expression. */
export function formatCheck(name: string, column: AnyPgColumn, pattern: string) {
  return check(name, sql`${column} is null or ${column} ~ ${literal(pattern)}`);
}

/**
 * `check()` that a jsonb column, when not null, is an array whose every element is one of
 * `values` (jsonb containment; Postgres forbids a subquery in a check constraint).
 */
export function jsonbArrayOfCheck(name: string, column: AnyPgColumn, values: readonly string[]) {
  const allowed = sql.raw(`'${JSON.stringify(values).replaceAll("'", "''")}'::jsonb`);
  return check(
    name,
    sql`${column} is null or (jsonb_typeof(${column}) = 'array' and ${column} <@ ${allowed})`,
  );
}
