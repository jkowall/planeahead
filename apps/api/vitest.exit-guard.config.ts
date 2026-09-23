/**
 * The ordinary Workers configuration with ONE change: the only file it runs is the deliberately
 * failing fixture under test/exit-guard. scripts/vitest-exit-guard.mjs runs it and asserts a
 * non-zero exit code, proving that the harness (the global setup with its embedded PostgreSQL
 * cluster, the Workers pool) lets a failure fail the run. Same plugin, same global setup, same
 * timeouts: it takes the path the suite takes. Spread rather than `mergeConfig`, which would
 * concatenate the `include` arrays and run the whole suite.
 */

import { defineConfig } from 'vitest/config';
import base from './vitest.config';

export default defineConfig({
  ...base,
  test: { ...base.test, include: ['test/exit-guard/**/*.guard.ts'] },
});
