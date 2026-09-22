/**
 * Global setup for the Workers suite. Runs once per `vitest run`, in Node, before the Workers
 * pool starts, and provides three things the pool cannot make for itself:
 *
 *   1. a migrated PostgreSQL 18 database, reached from inside the Worker through `env.DB`. The
 *      cluster comes from `@planeahead/db/test-harness`, the same embedded-postgres lifecycle
 *      the db package uses (CI points both at its `postgres:18` service container through
 *      `TEST_DATABASE_URL`). One database for the whole run: test files run in parallel against
 *      it, so every test that writes uses unique emails and install ids.
 *   2. the fake Apple, Google and Resend endpoints (`test/fake-providers.ts`) and their URLs.
 *   3. the secrets from `.dev.vars.test`, parsed here because the Workers plugin reads only
 *      `.dev.vars`, and that file is the developer's own and gitignored.
 *
 * Everything is handed to vitest.config.ts through `provide()`, where the Workers plugin's
 * `inject()` turns it into Miniflare options and bindings.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { provisionMigratedDatabase, provisionTestCluster } from '@planeahead/db/test-harness';
import type { TestProject } from 'vitest/node';
import { startFakeProviders } from './fake-providers';

export const DEV_VARS_TEST_FILE = resolve(import.meta.dirname, '..', '.dev.vars.test');
export const DEV_VARS_EXAMPLE_FILE = resolve(import.meta.dirname, '..', '.dev.vars.example');

/** The bindings the Worker sees under test that are neither in wrangler.jsonc nor secrets. */
export interface TestBindings extends Record<string, string> {
  readonly ENVIRONMENT: 'test';
  readonly APPLE_JWKS_URL: string;
  readonly APPLE_TOKEN_URL: string;
  readonly GOOGLE_JWKS_URL: string;
  readonly RESEND_API_URL: string;
  /** Private half of the fake JWKS key, so a test can mint identity tokens. */
  readonly TEST_IDP_PRIVATE_KEY_PEM: string;
  readonly TEST_FAKE_PROVIDERS_ORIGIN: string;
  /** The uncommented key names in `.dev.vars.example`, comma separated (ruling F5). */
  readonly TEST_DEV_VARS_EXAMPLE_KEYS: string;
  /** Where the database came from: `shell` (TEST_DATABASE_URL), `.env.test` or `embedded`. */
  readonly TEST_DATABASE_SOURCE: string;
}

/**
 * The harness must use the cluster the environment asked for. turbo runs the `test` task in
 * strict env mode, and a `TEST_DATABASE_URL` that turbo did not pass through would make CI
 * start embedded-postgres on the runner while its `postgres:18` service container sat idle,
 * silently. Throws when the shell set the variable and the harness did not use it; the CI job
 * additionally greps the `database source` line below so the check cannot regress quietly.
 */
export function assertDatabaseSource(
  shellUrl: string | undefined,
  source: 'shell' | '.env.test' | 'embedded',
): void {
  const shellSet = shellUrl !== undefined && shellUrl.trim() !== '';
  if (shellSet && source !== 'shell') {
    throw new Error(
      `[api test harness] TEST_DATABASE_URL is set but the database came from ${source}`,
    );
  }
  if (!shellSet && source === 'shell') {
    throw new Error('[api test harness] the harness reports TEST_DATABASE_URL but none is set');
  }
}

declare module 'vitest' {
  export interface ProvidedContext {
    /** URL of the migrated database the Hyperdrive binding points at. */
    apiDatabaseUrl: string;
    /** The secrets from `.dev.vars.test` plus the run-time test bindings. */
    apiTestBindings: Record<string, string>;
  }
}

/**
 * `KEY=VALUE` lines, `#` comments, optional matching quotes. A quoted value keeps the literal
 * two-character `\n` sequences the PEM is stored with; `apple-client-secret.ts` turns them back
 * into newlines, exactly as it does for a value set with `wrangler secret put`.
 */
export function parseDevVars(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export async function setup(project: TestProject): Promise<() => Promise<void>> {
  const cluster = await provisionTestCluster();
  assertDatabaseSource(process.env['TEST_DATABASE_URL'], cluster.source);
  process.stdout.write(`[api test harness] ${cluster.description}\n`);
  process.stdout.write(`[api test harness] database source: ${cluster.source}\n`);
  const database = await provisionMigratedDatabase(cluster.adminUrl, 'api');
  process.stdout.write(
    `[api test harness] database ${database.name}: ${database.migration.migrations} migration(s), ` +
      `hash ${database.migration.migrationHash.slice(0, 12)}\n`,
  );

  const providers = await startFakeProviders();
  process.stdout.write(`[api test harness] fake providers on ${providers.origin}\n`);

  const secrets = parseDevVars(readFileSync(DEV_VARS_TEST_FILE, 'utf8'));
  const exampleKeys = Object.keys(parseDevVars(readFileSync(DEV_VARS_EXAMPLE_FILE, 'utf8')));
  const bindings: TestBindings = {
    ...secrets,
    ENVIRONMENT: 'test',
    APPLE_JWKS_URL: `${providers.origin}/apple/keys`,
    APPLE_TOKEN_URL: `${providers.origin}/apple/token`,
    GOOGLE_JWKS_URL: `${providers.origin}/google/certs`,
    RESEND_API_URL: `${providers.origin}/resend/emails`,
    TEST_IDP_PRIVATE_KEY_PEM: providers.privateKeyPem,
    TEST_FAKE_PROVIDERS_ORIGIN: providers.origin,
    TEST_DEV_VARS_EXAMPLE_KEYS: exampleKeys.join(','),
    TEST_DATABASE_SOURCE: cluster.source,
  };

  project.provide('apiDatabaseUrl', database.url);
  project.provide('apiTestBindings', bindings);

  return async () => {
    await providers.close();
    // Drop before stopping: on an external cluster (CI) nothing else removes it, and on the
    // embedded one `stop()` deletes the data directory anyway.
    await database.drop().catch((error: unknown) => {
      process.stderr.write(
        `[api test harness] drop failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
    await cluster.stop();
  };
}
