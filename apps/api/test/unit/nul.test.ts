/**
 * The NUL guard (`src/validation/nul.ts`): the check walks parsed values, so the JSON escape
 * `\u0000` is caught (it parses to a NUL) while `\\u0000` is not (it parses to a backslash and
 * five ordinary characters), and `withoutNul` turns the check into a zod issue.
 */

import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { NUL, NUL_ISSUE_MESSAGE, containsNul, withoutNul } from '../../src/validation/nul';

describe('containsNul', () => {
  it('finds a NUL in a string, a nested value, an array element and a key', () => {
    expect(containsNul(`a${NUL}b`)).toBe(true);
    expect(containsNul({ a: { b: [1, `x${NUL}`] } })).toBe(true);
    expect(containsNul({ [`k${NUL}`]: 1 })).toBe(true);
    expect(containsNul([{ deep: { deeper: NUL } }])).toBe(true);
  });

  it('is false for clean values, numbers, null and the escaped-backslash form', () => {
    expect(containsNul('plain')).toBe(false);
    expect(containsNul({ a: 1, b: null, c: [true, 'x'] })).toBe(false);
    expect(containsNul(JSON.parse('{"a":"\\\\u0000"}'))).toBe(false);
    expect(containsNul(JSON.parse('{"a":"\\u0000"}'))).toBe(true);
    expect(containsNul(undefined)).toBe(false);
  });
});

describe('withoutNul', () => {
  const schema = withoutNul(
    z.object({ name: z.string().trim(), settings: z.record(z.string(), z.unknown()) }),
  );

  it('adds one custom issue for a NUL anywhere and leaves a clean value untouched', () => {
    const bad = schema.safeParse({ name: `iPhone${NUL}X`, settings: {} });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues.map((issue) => issue.message)).toContain(NUL_ISSUE_MESSAGE);
    }
    const nested = schema.safeParse({ name: 'ok', settings: { theme: [`d${NUL}`] } });
    expect(nested.success).toBe(false);

    const good = schema.safeParse({ name: ' ok ', settings: { theme: 'dark' } });
    expect(good.success).toBe(true);
    if (good.success) {
      expect(good.data.name).toBe('ok');
    }
  });
});
