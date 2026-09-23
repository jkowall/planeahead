/**
 * A test that fails on purpose, and is NOT part of the suite: vitest.config.ts includes only the
 * `*.test.ts` files under test/. scripts/vitest-exit-guard.mjs runs this file through
 * vitest.exit-guard.config.ts (the ordinary configuration with only this file included) and
 * asserts that Vitest exits non-zero, which is what proves a failing test fails the run:
 * embedded-postgres once turned every failure into exit 0 (test/embedded.ts).
 */

import { expect, it } from 'vitest';

it('fails on purpose, so the exit-code guard can see it', () => {
  expect(1).toBe(2);
});
