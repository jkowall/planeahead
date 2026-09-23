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

/**
 * Two source rows claim one value of a column the table keeps unique. Raised before any write,
 * because the upsert's ON CONFLICT names only the natural key and a collision on a secondary
 * unique index would otherwise abort the run half way with SQLSTATE 23505.
 */
export class SeedCollisionError extends Error {
  override readonly name = 'SeedCollisionError';

  constructor(
    readonly loader: string,
    readonly column: string,
    readonly value: string,
    readonly first: string,
    readonly second: string,
  ) {
    super(`${loader}: ${column} "${value}" is claimed by both source rows ${first} and ${second}`);
  }
}

/** Tracks one unique column across source rows and throws on the first collision. */
export class UniqueTracker {
  private readonly seen = new Map<string, string>();

  constructor(
    private readonly loader: string,
    private readonly column: string,
  ) {}

  claim(value: string, sourceRow: string): void {
    const first = this.seen.get(value);
    if (first !== undefined) {
      throw new SeedCollisionError(this.loader, this.column, value, first, sourceRow);
    }
    this.seen.set(value, sourceRow);
  }
}
