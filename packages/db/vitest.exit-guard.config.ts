/**
 * The ordinary configuration with ONE change: the only file it runs is the deliberately failing
 * fixture under test/exit-guard. scripts/vitest-exit-guard.mjs runs it and asserts a non-zero
 * exit code, proving that the harness (the global setup with its embedded PostgreSQL cluster)
 * lets a failure fail the run. Spread rather than `mergeConfig`, which would concatenate the
 * `include` arrays and run the whole suite.
 */

import { defineConfig } from 'vitest/config';
import base from './vitest.config';

export default defineConfig({
  ...base,
  test: { ...base.test, include: ['test/exit-guard/**/*.guard.ts'] },
});
