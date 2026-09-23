/**
 * The SQLSTATE of a failed statement, as the routes and the deletion read it (increment 8).
 *
 * drizzle-orm wraps the postgres.js error, which carries the code and the constraint name, in a
 * `DrizzleQueryError` whose `cause` it is; a transaction callback may wrap it once more. The code
 * is read off the first object in the chain that has one.
 */

export interface PgErrorCode {
  readonly code: string | undefined;
  readonly constraint: string | undefined;
}

/** The SQLSTATE and constraint name, read off whatever shape the driver threw. */
export function pgCode(error: unknown): PgErrorCode {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    const record = current as { code?: unknown; constraint_name?: unknown; cause?: unknown };
    if (typeof record.code === 'string') {
      return {
        code: record.code,
        constraint: typeof record.constraint_name === 'string' ? record.constraint_name : undefined,
      };
    }
    current = record.cause;
  }
  return { code: undefined, constraint: undefined };
}
