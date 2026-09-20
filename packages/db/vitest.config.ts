import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/globalSetup.ts'],
    // Migrating 70 tables into a fresh database per file is fast, but a cold embedded cluster on a
    // CI runner is not; keep the per-test ceiling generous.
    testTimeout: 30_000,
    hookTimeout: 90_000,
  },
});
