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
 * Postgres, from increment 5 on. `test/globalSetup.ts` starts the embedded PostgreSQL 18 cluster
 * (or uses `TEST_DATABASE_URL`, which CI sets to its `postgres:18` service container), migrates a
 * database, starts the fake Apple, Google and Resend endpoints, and reads `.dev.vars.test`. The
 * plugin is given a FUNCTION so it can `inject()` those values after the setup has run: the
 * database URL becomes the Hyperdrive binding's local connection string through
 * `miniflare.hyperdrives` (the plugin ignores CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB,
 * and `localConnectionString` in wrangler.jsonc is a placeholder that never answers), and the
 * secrets plus the provider URLs become bindings, which is exactly how `wrangler secret put`
 * delivers them in staging.
 *
 * `test/unit` runs INSIDE the Workers pool too. Those files are pure (WebCrypto, jose, an
 * injected `fetch`) and running them in workerd is the point: several increment 5 facts about
 * the runtime (pkcs8 import for ECDSA P-256, AES-KW wrap length, timingSafeEqual throwing on
 * unequal lengths) are settled there rather than on Node's WebCrypto. Increment 6 adds a separate
 * Node project for the undici MockAgent provider tests, which cannot run in workerd.
 */
export default defineConfig({
  plugins: [
    cloudflareTest(({ inject }) => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        hyperdrives: { DB: inject('apiDatabaseUrl') },
        // Overrides the `local` value from wrangler.jsonc with ENVIRONMENT=test and adds every
        // secret and test URL. `wrangler types` only knows the three ENVIRONMENT values the config
        // file declares, so `environmentName()` in src/env.ts reads this through a widened
        // `string` rather than the generated literal union.
        bindings: inject('apiTestBindings'),
      },
    })),
  ],
  test: {
    globalSetup: ['test/globalSetup.ts'],
    include: ['test/workers/**/*.test.ts', 'test/unit/**/*.test.ts'],

    // Vitest's 5 second default is too tight for the FIRST request into the Worker in a test
    // file. That request is what makes workerd evaluate the whole bundle, and the bundle is a
    // megabyte, most of it the Sentry SDK; every later request in the same file costs
    // milliseconds, and tests that only import modules from `src/` never pay it at all.
    //
    // The number moves a great deal with what is cached, so treat it as a range rather than a
    // constant. With a warm Vite transform cache that first request costs tens of milliseconds
    // (measured: 33 ms). Cold, the bundle is built and evaluated on that call and the cost lands
    // on the test: a review run on an M-series Mac measured 20.9 seconds for it, 11.1 on a
    // repeat. An earlier version of this comment claimed "about 10 seconds" flat, which
    // understated the cold case by 2x and left the worst observed test consuming 69 percent of
    // a 30 second budget.
    //
    // GitHub's ubuntu-latest runners are slower than this machine and always start cold
    // (turbo.json configures no remote cache), so 30 seconds was around 1.4x headroom on the one
    // assertion that has to evaluate the bundle, and the failure mode is a bare timeout with no
    // useful message. 60 seconds restores the margin; it costs nothing on a run that passes.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
