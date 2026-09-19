#!/usr/bin/env node
/**
 * Toolchain guard.
 *
 * Fails if the lockfile resolves a version the project cannot run on:
 *   - typescript >= 7        (Expo SDK 57 expects ~6.0.3, typescript-eslint has no TS 7 support)
 *   - vitest >= 5            (@cloudflare/vitest-plugin 1.1.x peers on vitest ^4.1)
 *   - more than one wrangler (two wrangler versions means two workerd builds in one install)
 *   - .node-version not 24   (Corepack is gone from Node 25, the pin is deliberate)
 *
 * Deliberately dependency free: it parses the lockfile with a regex so it can run before install.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const failures = [];

function read(relativePath) {
  try {
    return readFileSync(join(repoRoot, relativePath), 'utf8');
  } catch {
    return null;
  }
}

// .node-version must pin Node 24.
const nodeVersion = read('.node-version');
if (nodeVersion === null) {
  failures.push('.node-version is missing');
} else if (!/^24(\.|\s*$)/.test(nodeVersion.trim())) {
  failures.push(`.node-version must pin Node 24, found "${nodeVersion.trim()}"`);
}

// Collect every resolved version per package name from the lockfile.
const lockfile = read('pnpm-lock.yaml');
if (lockfile === null) {
  failures.push('pnpm-lock.yaml is missing, run pnpm install first');
}

/** @type {Map<string, Set<string>>} */
const resolved = new Map();
if (lockfile !== null) {
  const entry = /^ {2}((?:@[^/\s]+\/)?[^@/\s]+)@(\d[^:\s(]*)(?:\([^)]*\))*:$/;
  for (const line of lockfile.split('\n')) {
    const match = entry.exec(line);
    if (match === null) {
      continue;
    }
    const [, name, version] = match;
    const versions = resolved.get(name) ?? new Set();
    versions.add(version);
    resolved.set(name, versions);
  }
}

function major(version) {
  return Number.parseInt(version.split('.')[0], 10);
}

function assertBelowMajor(name, limit, why) {
  for (const version of resolved.get(name) ?? []) {
    if (major(version) >= limit) {
      failures.push(`${name}@${version} is >= ${limit}: ${why}`);
    }
  }
}

assertBelowMajor('typescript', 7, 'Expo SDK 57 and typescript-eslint need TypeScript 6.x');
assertBelowMajor('vitest', 5, '@cloudflare/vitest-plugin 1.1.x peers on vitest ^4.1');

const wranglerVersions = [...(resolved.get('wrangler') ?? [])];
if (wranglerVersions.length > 1) {
  failures.push(
    `wrangler resolves to ${wranglerVersions.length} versions: ${wranglerVersions.join(', ')}`,
  );
}

const checked = ['typescript', 'vitest', 'wrangler']
  .map((name) => {
    const versions = [...(resolved.get(name) ?? [])];
    return `${name}=${versions.length > 0 ? versions.join(',') : 'not installed'}`;
  })
  .join('  ');

if (failures.length > 0) {
  console.error('toolchain-guard: FAIL');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log(`toolchain-guard: ok  node=${(nodeVersion ?? '').trim()}  ${checked}`);
