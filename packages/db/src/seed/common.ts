import { fileURLToPath } from 'node:url';

/** Default location of the committed derived files. */
export const SEED_DATA_DIR = fileURLToPath(new URL('../../seed/data/', import.meta.url));

export interface SeedOptions {
  readonly dataDir?: string;
  readonly log?: (line: string) => void;
}

export interface SeedResult {
  /** Rows read from the file. */
  readonly read: number;
  /** Rows written with an upsert (inserted or updated). */
  readonly upserted: number;
  /** Rows deliberately not written, with the reason counted. */
  readonly skipped: Readonly<Record<string, number>>;
}

export const BATCH_SIZE = 500;

export function count(skipped: Record<string, number>, reason: string): void {
  skipped[reason] = (skipped[reason] ?? 0) + 1;
}
