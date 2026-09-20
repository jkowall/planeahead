/**
 * `gen-migration-hash.mjs --check` has to run BEFORE anything that regenerates the constant.
 *
 * The api package's `typecheck`, `test` and `dev` scripts all start with
 * `node ../../scripts/gen-migration-hash.mjs`, which rewrites apps/api/src/generated/migration-hash.ts
 * on disk. `--check` only compares the file on disk with the journal, so a check step placed
 * after one of those compares the file they just wrote and can never fail. deploy-staging.yml
 * shipped that way once: a stale committed constant turned ci.yml red while the staging deploy
 * went green with a silently corrected hash. This test pins the ordering in every job that
 * checks, and requires the jobs that exist to check to keep doing so.
 *
 * Text based on purpose. The repository has no YAML parser at the root, and the two shapes this
 * needs are stable: a job is a key at two spaces of indentation under `jobs:`, and a step's
 * command is a line. Comments are skipped so prose about the generator cannot trip it.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflowsDir = join(import.meta.dirname, '..', '..', '.github', 'workflows');

const CHECK = /gen-migration-hash\.mjs --check\b/;

/** Jobs that must run the check at all, so the guard cannot be deleted quietly. */
const MUST_CHECK = {
  'ci.yml': ['test-workers', 'wrangler-dry-run'],
  'deploy-staging.yml': ['deploy'],
};

/** Whether one non-comment line runs something that rewrites the generated constant. */
function regenerates(line) {
  if (CHECK.test(line)) {
    return false;
  }
  if (/gen-migration-hash\.mjs|gen:migration-hash/.test(line)) {
    return true;
  }
  if (/turbo run (typecheck|test)\b/.test(line)) {
    // `--filter=!@planeahead/api` runs every package EXCEPT the one with the generator.
    return !line.includes('--filter=!@planeahead/api');
  }
  return /@planeahead\/api\b.*\b(typecheck|test|dev)\b/.test(line);
}

/** @returns {{ name: string, lines: { number: number, text: string }[] }[]} */
function jobsOf(text) {
  const jobs = [];
  let current = null;
  let inJobs = false;
  text.split('\n').forEach((line, index) => {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      return;
    }
    if (!inJobs || /^\s*#/.test(line)) {
      return;
    }
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header !== null) {
      current = { name: header[1], lines: [] };
      jobs.push(current);
      return;
    }
    if (current !== null) {
      current.lines.push({ number: index + 1, text: line });
    }
  });
  return jobs;
}

const workflows = readdirSync(workflowsDir)
  .filter((file) => file.endsWith('.yml'))
  .map((file) => ({ file, jobs: jobsOf(readFileSync(join(workflowsDir, file), 'utf8')) }));

describe('gen-migration-hash.mjs --check runs before anything regenerates the constant', () => {
  for (const { file, jobs } of workflows) {
    for (const job of jobs) {
      it(`${file}: job ${job.name}`, () => {
        const check = job.lines.find((line) => CHECK.test(line.text));
        const regenerating = job.lines.filter((line) => regenerates(line.text));

        if ((MUST_CHECK[file] ?? []).includes(job.name)) {
          expect(check, `${file} job ${job.name} no longer runs --check`).toBeDefined();
        }
        if (check === undefined) {
          return;
        }
        for (const line of regenerating) {
          expect(
            line.number,
            `${file}:${line.number} regenerates the constant before the --check on line ${check.number}: ${line.text.trim()}`,
          ).toBeGreaterThan(check.number);
        }
      });
    }
  }

  it('names only jobs that exist, so a renamed job cannot slip out of the list', () => {
    for (const [file, jobNames] of Object.entries(MUST_CHECK)) {
      const workflow = workflows.find((entry) => entry.file === file);
      expect(workflow, `${file} is missing`).toBeDefined();
      for (const jobName of jobNames) {
        expect(
          workflow.jobs.map((job) => job.name),
          `${file} has no job named ${jobName}`,
        ).toContain(jobName);
      }
    }
  });

  it('recognises the commands that regenerate, and the ones that do not', () => {
    expect(regenerates('      - run: pnpm turbo run typecheck lint')).toBe(true);
    expect(regenerates('        run: pnpm turbo run test --filter=@planeahead/api')).toBe(true);
    expect(regenerates('      - run: pnpm turbo run test --filter=!@planeahead/api')).toBe(false);
    expect(regenerates('      - run: node scripts/gen-migration-hash.mjs --check')).toBe(false);
    expect(regenerates('      - run: node scripts/gen-migration-hash.mjs')).toBe(true);
    expect(
      regenerates('        run: pnpm --filter @planeahead/api exec wrangler deploy --dry-run'),
    ).toBe(false);
    expect(regenerates('          pnpm --filter @planeahead/db run db:migrate')).toBe(false);
  });
});
