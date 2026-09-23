/**
 * The offline store's schema version, as this build reads and writes it (increment 9 review,
 * finding auth-and-store-5).
 *
 * The page apply skips any element this build cannot parse (a provider id, an entity or an op a
 * newer server added) and still advances the cursor past it, so the row would never come back by
 * itself. `sync_state.store_version` records the version of the build that wrote the rows; a
 * build whose version differs clears the cursor on its first pull and takes the no-cursor
 * snapshot, which replaces the rows and brings back everything the older build skipped.
 *
 * Derived, not hand-maintained, so nobody has to remember to bump it: the number of bundled
 * migrations (a new column may hold a field older builds dropped) plus a fingerprint of the JSON
 * Schema of every sync shape the apply parses. Widening an enum in `@planeahead/shared` changes
 * the fingerprint; a zod upgrade that prints its JSON Schema differently only costs one snapshot.
 */

import {
  FlightSubscriptionRowV1,
  PreferenceSettingsSchema,
  SyncChangeV1,
  SyncFlightV1,
  UserPreferencesSchema,
} from '@planeahead/shared';
import { z } from 'zod';
import journal from '../db/migrations/meta/_journal.json';

/** FNV-1a, 32 bit, as eight hex digits: a fingerprint, not a security boundary. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function schemaText(schema: z.ZodType): string {
  return JSON.stringify(z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }));
}

/** The shapes the page apply parses, in a fixed order. */
const PARSED_SHAPES: readonly z.ZodType[] = [
  SyncChangeV1,
  SyncFlightV1,
  FlightSubscriptionRowV1,
  UserPreferencesSchema,
  PreferenceSettingsSchema,
];

export function storeSchemaVersion(
  migrationCount: number = journal.entries.length,
  shapes: readonly z.ZodType[] = PARSED_SHAPES,
): string {
  return `m${String(migrationCount)}-${fnv1a(shapes.map(schemaText).join('\n'))}`;
}

/** This build's version, computed once. */
export const STORE_SCHEMA_VERSION = storeSchemaVersion();
