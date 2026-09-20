import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

/**
 * Workers pool configuration.
 *
 * `defineWorkersConfig` and `defineWorkersProject` were removed in the Vitest 4 plugin. The only
 * supported shape is `cloudflareTest()` as a plugin inside the ordinary `defineConfig` from
 * `vitest/config`. `isolatedStorage` and `singleWorker` are gone too: storage isolation is per
 * test file and automatic, which is why every Durable Object test still uses a unique object name
 * (isolation is per file, not per test).
 *
 * `experimental.newConfig` with a `cloudflare.config.ts` is deliberately not used. It is
 * experimental, may change without a major version bump, and does not support wrangler
 * environments, which this Worker depends on for staging and production. ADR 0004 records it as a
 * rejected option so it is not relitigated.
 *
 * No `miniflare.hyperdrives` override, and no Postgres anywhere. Increment 4's tests never open a
 * database connection: `/health` reports a build-time constant, the Durable Objects never touch
 * Postgres (ADR 0007), and the idempotency middleware falls back to its in-memory store because
 * `ENVIRONMENT` is `test` below. The CI job for this package runs without a service container.
 * Increments 5 and 8 add the override when auth and route tests need a Neon branch.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // Overrides the `local` value from wrangler.jsonc. `wrangler types` only knows the three
        // values the config file declares, so `environmentName()` in src/env.ts reads this
        // through a widened `string` rather than the generated literal union.
        bindings: { ENVIRONMENT: 'test' },
      },
    }),
  ],
  test: {
    // Only `test/workers`. Increments 5 and 6 add `test/unit`, which is Node-side (undici
    // MockAgent for provider adapters, since `fetchMock` was removed from `cloudflare:test`) and
    // cannot run inside the Workers pool. Scoping the include now means that increment adds a
    // second Vitest project rather than discovering that its unit tests are being loaded into
    // workerd.
    include: ['test/workers/**/*.test.ts'],

    // Vitest's 5 second default is too tight for the FIRST request into the Worker in a test
    // file. Measured on an M-series Mac: `exports.default.fetch()` costs about 10 seconds the
    // first time and 10 milliseconds afterwards, because that request is what makes workerd
    // evaluate the whole bundle, and the bundle is a megabyte, most of it the Sentry SDK.
    // Tests that only import modules from `src/` do not pay it. CI runners are slower than this
    // machine, hence 30 seconds rather than 15.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
