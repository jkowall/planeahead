#!/usr/bin/env node
/**
 * The post-deploy smoke test (increment 12, ruling W6): `GET /health` on the deployed Worker must
 * answer 200 with the environment it was deployed as, the migration hash and count this commit
 * was built against, and the Durable Object schema version of every class this commit carries.
 *
 * A 200 alone proves the Worker is alive; it does not prove the deploy took (a failed upload
 * leaves the previous version serving a perfectly healthy 200). The build's own values come from
 * the repository at the checked-out commit: `apps/api/src/generated/migration-hash.ts` (the
 * workflow checks it is current before anything else) and the `static readonly SCHEMA_VERSION`
 * of each class in `apps/api/src/do/`, the same constants `/health` reports
 * (`DO_SCHEMA_VERSIONS`, apps/api/src/routes/health.ts).
 *
 * Usage: node scripts/health-smoke.mjs <base-url> <environment> [attempts] [delay-seconds]
 * Retries while the answer is not 200 or does not match yet (a new version takes a few seconds to
 * reach every location), then fails with a GitHub Actions error annotation naming the mismatch.
 *
 * Dependency free: Node 24's fetch.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The classes `/health` reports, by file. Must name exactly the keys of `DO_SCHEMA_VERSIONS` in
 * apps/api/src/routes/health.ts (tools/workflows/deploy-production.test.js compares them), or a
 * class added there would never be checked after a deploy.
 */
export const DO_FILES = {
  FlightTracker: 'flight-tracker.ts',
  DesignatorResolver: 'designator-resolver.ts',
  AirportState: 'airport-state.ts',
  UserInbox: 'user-inbox.ts',
  ProviderBudget: 'provider-budget.ts',
};

/** What this commit's build reports on `/health`. */
export function expectedHealth(root = repoRoot) {
  const generated = readFileSync(
    join(root, 'apps', 'api', 'src', 'generated', 'migration-hash.ts'),
    'utf8',
  );
  const hash = /MIGRATION_HASH = '([0-9a-f]{64})'/.exec(generated)?.[1];
  const count = /MIGRATION_COUNT = (\d+)/.exec(generated)?.[1];
  if (hash === undefined || count === undefined) {
    throw new Error('apps/api/src/generated/migration-hash.ts has no MIGRATION_HASH or COUNT');
  }
  const doDir = join(root, 'apps', 'api', 'src', 'do');
  const present = new Set(readdirSync(doDir));
  const doSchemaVersions = {};
  for (const [name, file] of Object.entries(DO_FILES)) {
    if (!present.has(file)) {
      throw new Error(`apps/api/src/do/${file} is missing`);
    }
    const version = /static readonly SCHEMA_VERSION = (\d+);/.exec(
      readFileSync(join(doDir, file), 'utf8'),
    )?.[1];
    if (version === undefined) {
      throw new Error(`apps/api/src/do/${file} declares no SCHEMA_VERSION`);
    }
    doSchemaVersions[name] = Number(version);
  }
  return { migrationHash: hash, migrationCount: Number(count), doSchemaVersions };
}

/** The mismatches between a `/health` body and the build, empty when it matches. */
export function compareHealth(expected, environment, body) {
  const problems = [];
  if (body === null || typeof body !== 'object') {
    return ['the body is not a JSON object'];
  }
  if (body.ok !== true) {
    problems.push('ok is not true');
  }
  if (body.environment !== environment) {
    problems.push(`environment is ${JSON.stringify(body.environment)}, expected ${environment}`);
  }
  if (body.migrationHash !== expected.migrationHash) {
    problems.push(
      `migrationHash is ${JSON.stringify(body.migrationHash)}, the build has ${expected.migrationHash}`,
    );
  }
  if (body.migrationCount !== expected.migrationCount) {
    problems.push(
      `migrationCount is ${JSON.stringify(body.migrationCount)}, the build has ${String(expected.migrationCount)}`,
    );
  }
  const versions = body.doSchemaVersions ?? {};
  for (const [name, version] of Object.entries(expected.doSchemaVersions)) {
    if (versions[name] !== version) {
      problems.push(
        `doSchemaVersions.${name} is ${JSON.stringify(versions[name])}, the build has ${String(version)}`,
      );
    }
  }
  return problems;
}

async function main() {
  const [base, environment, attemptsArg = '6', delayArg = '10'] = process.argv.slice(2);
  if (base === undefined || environment === undefined) {
    console.error(
      'usage: node scripts/health-smoke.mjs <base-url> <environment> [attempts] [delay]',
    );
    process.exit(2);
  }
  const expected = expectedHealth();
  const attempts = Number(attemptsArg);
  const delayMs = Number(delayArg) * 1000;
  let problems = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(new URL('/health', base), {
        signal: AbortSignal.timeout(20_000),
        headers: { 'cache-control': 'no-cache' },
      });
      if (response.status !== 200) {
        problems = [`/health answered ${String(response.status)}`];
      } else {
        const body = await response.json();
        problems = compareHealth(expected, environment, body);
        if (problems.length === 0) {
          console.log(JSON.stringify(body));
          console.log(`health-smoke: ${base} serves this build (${environment})`);
          return;
        }
      }
    } catch (error) {
      problems = [`request failed: ${error instanceof Error ? error.message : String(error)}`];
    }
    console.log(`attempt ${String(attempt)}: ${problems.join('; ')}`);
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  console.log(`::error title=Smoke test failed::${base}/health: ${problems.join('; ')}`);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
