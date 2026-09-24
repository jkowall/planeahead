/**
 * Every workflow's job keys are unique, and the nightly native-smoke workflow keeps its shape
 * (increment 11, ruling V7, ADR 0008).
 *
 * A duplicate job key is a YAML mapping with the same key twice: most parsers keep the last one
 * silently, and GitHub rejects the whole file without running anything. It happened once
 * (increment 9's merge left two `vitest-exit-guard` jobs in ci.yml, removed in #9), so it is
 * checked for every file here rather than by eye.
 *
 * Text based, like migration-hash-check.test.js: the repository has no YAML parser at the root,
 * and a job is a key at two spaces of indentation under `jobs:`.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '..', '..');
const workflowsDir = join(repoRoot, '.github', 'workflows');

/** The job keys of one workflow, in order, duplicates kept. */
function jobKeys(text) {
  const keys = [];
  let inJobs = false;
  for (const line of text.split('\n')) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (/^\S/.test(line)) {
      inJobs = false;
      continue;
    }
    const key = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (inJobs && key !== null) {
      keys.push(key[1]);
    }
  }
  return keys;
}

/** The lines of one job's block, comments dropped. */
function jobBlock(text, job) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === `  ${job}:`);
  expect(start, `job ${job} is missing`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((line, index) => index > start && /^ {2}\S/.test(line));
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

const workflows = readdirSync(workflowsDir)
  .filter((file) => file.endsWith('.yml'))
  .map((file) => ({ file, text: readFileSync(join(workflowsDir, file), 'utf8') }));

describe('workflow job keys', () => {
  it('finds the workflows, native-smoke included', () => {
    expect(workflows.map(({ file }) => file)).toContain('native-smoke.yml');
  });

  for (const { file, text } of workflows) {
    it(`${file} has at least one job and no job key twice`, () => {
      const keys = jobKeys(text);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.filter((key, index) => keys.indexOf(key) !== index)).toEqual([]);
    });
  }

  it('recognises a duplicate job key', () => {
    const keys = jobKeys('on: push\njobs:\n  a:\n    steps: []\n  b:\n    x: 1\n  a:\n    y: 2\n');
    expect(keys).toEqual(['a', 'b', 'a']);
  });
});

describe('native-smoke.yml', () => {
  const text = readFileSync(join(workflowsDir, 'native-smoke.yml'), 'utf8');
  const code = text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  const script = readFileSync(join(repoRoot, 'scripts', 'native-smoke.sh'), 'utf8');

  it('runs nightly and on demand only, never on a push or a pull request', () => {
    const on = /^on:\n((?: .*\n|\n)*?)(?=^\S)/m.exec(code)?.[1] ?? '';
    expect(on).toMatch(/^ {2}schedule:\n {4}- cron: '[^']+'$/m);
    expect(on).toMatch(/^ {2}workflow_dispatch:/m);
    expect(on).not.toMatch(/pull_request|push:/);
  });

  it('never builds on EAS and holds no secrets', () => {
    expect(code).not.toMatch(/\beas (build|update)\b|expo-github-action|secrets\./);
  });

  it('has exactly the iOS and Android jobs, each with a timeout, under one concurrency group', () => {
    expect(jobKeys(text)).toEqual(['ios', 'android']);
    for (const job of ['ios', 'android']) {
      expect(jobBlock(text, job)).toMatch(/^ {4}timeout-minutes: \d+$/m);
    }
    expect(code).toMatch(/^concurrency:\n {2}group: .+\n {2}cancel-in-progress: true$/m);
  });

  it('gates on Xcode 26.6 on macos-26 and lets the Xcode 27 leg fail without failing the run', () => {
    const ios = jobBlock(text, 'ios');
    expect(ios).toMatch(/^ {4}runs-on: macos-26$/m);
    expect(ios).toMatch(/^ {8}xcode: \['26\.6', '27'\]$/m);
    expect(ios).toMatch(/^ {4}continue-on-error: \$\{\{ matrix\.xcode == '27' \}\}$/m);
    expect(ios).toMatch(/fail-fast: false/);
    expect(ios).toMatch(/xcode-select --switch/);
  });

  it('prebuilds, builds, asserts the app contents and launches on both platforms', () => {
    const steps = [...code.matchAll(/scripts\/native-smoke\.sh ([a-z-]+)/g)].map((m) => m[1]);
    expect(steps).toEqual([
      'ios-prebuild',
      'ios-build',
      'ios-archive',
      'ios-launch',
      'android-prebuild',
      'android-build',
      'android-archive',
      'android-launch',
    ]);
    for (const step of steps) {
      expect(script).toContain(`  ${step}) `);
    }
  });

  it('builds the watch shells for watchOS: the script never forces the iOS SDK', () => {
    expect(script).not.toMatch(/^\s*[^#\n]*-sdk iphonesimulator/m);
    expect(script).toMatch(/-destination "platform=iOS Simulator,id=\$simulator"/);
  });
});
