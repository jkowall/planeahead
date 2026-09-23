#!/usr/bin/env node
/**
 * Vitest exit-code guard.
 *
 * Runs one deliberately failing test file in each package whose suite starts the embedded
 * PostgreSQL harness (apps/api and packages/db) and asserts two things from each run: the fixture
 * ran and failed (one test, one failure, in the JSON report), and Vitest exited non-zero.
 *
 * Why it exists: embedded-postgres registers async-exit-hook at import, and that library hooks
 * `beforeExit` with exit code 0, which overrode the exit code Vitest sets on a failure. Both
 * packages' suites reported failures and exited 0, so `turbo run test`, the full check and both
 * CI test jobs were green whatever failed. packages/db/test/embedded.ts removes that handler; this
 * script is the proof that it stays removed, and CI runs it after the test jobs because a green
 * test job means nothing until this one is green too.
 *
 * Each package has a vitest.exit-guard.config.ts (its ordinary config with only the fixture
 * included) and test/exit-guard/deliberate-failure.guard.ts. The runs use the embedded cluster
 * (TEST_DATABASE_URL is cleared): that is the case in which the hook had a server to guard, and
 * the one every developer runs. The apps/api run bundles the Worker, so the generated migration
 * hash has to exist (`node scripts/gen-migration-hash.mjs`; every api script runs it first).
 *
 * Dependency free: Node and the installed vitest only.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGES = ['apps/api', 'packages/db'];
const CONFIG = 'vitest.exit-guard.config.ts';

/** The tail of a run's output, for a failure message. */
function tail(text, lines = 40) {
  return text.split('\n').slice(-lines).join('\n');
}

function runGuard(relativeDir, reportDir) {
  const packageDir = join(repoRoot, relativeDir);
  // The package's own vitest, through its manifest: the bin file is not in vitest's `exports`.
  const manifestPath = createRequire(pathToFileURL(join(packageDir, 'package.json'))).resolve(
    'vitest/package.json',
  );
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.vitest;
  const vitest = join(dirname(manifestPath), bin);
  const report = join(reportDir, `${relativeDir.replaceAll('/', '-')}.json`);
  const env = { ...process.env };
  delete env.TEST_DATABASE_URL;
  const run = spawnSync(
    process.execPath,
    [
      vitest,
      'run',
      '--config',
      CONFIG,
      '--reporter=default',
      '--reporter=json',
      `--outputFile.json=${report}`,
    ],
    { cwd: packageDir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
  let summary = null;
  try {
    const parsed = JSON.parse(readFileSync(report, 'utf8'));
    summary = { total: parsed.numTotalTests, failed: parsed.numFailedTests };
  } catch {
    summary = null;
  }
  const problems = [];
  if (summary === null || summary.total !== 1 || summary.failed !== 1) {
    problems.push(
      `the fixture did not run as one failing test (report: ${summary === null ? 'missing' : JSON.stringify(summary)})`,
    );
  }
  if (run.status === 0) {
    problems.push('vitest exited 0 with a failing test');
  }
  if (run.error !== undefined) {
    problems.push(`vitest could not be started: ${run.error.message}`);
  }
  return { relativeDir, status: run.status, signal: run.signal, summary, problems, output };
}

const reportDir = mkdtempSync(join(tmpdir(), 'planeahead-exit-guard-'));
let failed = false;
try {
  for (const relativeDir of PACKAGES) {
    const result = runGuard(relativeDir, reportDir);
    const exit =
      result.status === null ? `signal ${result.signal ?? 'unknown'}` : `exit ${result.status}`;
    if (result.problems.length === 0) {
      console.log(`[exit guard] ${relativeDir}: one failing test, vitest ${exit}: OK`);
      continue;
    }
    failed = true;
    console.error(`[exit guard] ${relativeDir}: FAILED (vitest ${exit})`);
    for (const problem of result.problems) {
      console.error(`  - ${problem}`);
    }
    console.error(tail(result.output));
  }
} finally {
  rmSync(reportDir, { recursive: true, force: true });
}

if (failed) {
  console.error(
    '[exit guard] a failing test does not fail the run; see packages/db/test/embedded.ts',
  );
  process.exit(1);
}
console.log('[exit guard] OK: a failing test fails the run in both packages');
