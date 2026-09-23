/**
 * U+0000 in request input.
 *
 * Postgres rejects a NUL byte in any `text` or `jsonb` value (`22021 invalid byte sequence for
 * encoding "UTF8": 0x00`), so a NUL that passes validation is a 500 from the database, on
 * demand, from any caller, and the failed statement's bound parameters (the rest of the request)
 * would ride into the error. The fix is to refuse it at the boundary: every JSON body the
 * Worker parses runs through `containsNul` and answers 400.
 *
 * The check walks the PARSED value rather than the raw text. `"\u0000"` in a JSON document is
 * the escape for a NUL and parses to one; `"\\u0000"` is a backslash followed by five ordinary
 * characters and parses to those. A raw-text search cannot tell them apart, and a literal NUL
 * byte in the text is already invalid JSON.
 */

import type * as z from 'zod';

/** Written as an escape on purpose: a raw NUL in a source file makes git treat it as binary. */
export const NUL = '\u0000';

/** Whether any string, key or nested value in `value` contains U+0000. */
export function containsNul(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.includes(NUL);
  }
  if (Array.isArray(value)) {
    return value.some(containsNul);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).some(([key, entry]) => key.includes(NUL) || containsNul(entry));
  }
  return false;
}

export const NUL_ISSUE_MESSAGE = 'NUL (U+0000) characters are not allowed';

/**
 * Adds the NUL check to a schema as a final refinement over the whole parsed value, so a route
 * that validates with `zValidator('json', withoutNul(schema))` answers 400 instead of letting
 * the database answer 500.
 */
export function withoutNul<T extends z.ZodType>(schema: T): T {
  return schema.superRefine((value, ctx) => {
    if (containsNul(value)) {
      ctx.addIssue({ code: 'custom', message: NUL_ISSUE_MESSAGE });
    }
  });
}
