#!/usr/bin/env node
/**
 * Toolchain guard.
 *
 * Fails if the lockfile resolves a version the project cannot run on:
 *   - typescript >= 7        (Expo SDK 57 expects ~6.0.3, typescript-eslint has no TS 7 support)
 *   - vitest >= 5            (@cloudflare/vitest-plugin 1.1.x peers on vitest ^4.1)
 *   - vitest major not 4     (the pool is built against the 4.1 line, both directions matter)
 *   - more than one wrangler (two wrangler versions means two workerd builds in one install)
 *   - a wrangler that is not the exact version @cloudflare/vitest-plugin depends on
 *   - .node-version not 24   (Corepack is gone from Node 25, the pin is deliberate)
 *
 * The wrangler assertion is a PAIR check, not a frozen constant. @cloudflare/vitest-plugin
 * declares `wrangler` as an ordinary dependency at an exact version (1.1.13 declares 4.135.0),
 * and the pool boots workerd through that copy. If the catalog moves wrangler without moving the
 * plugin, pnpm installs a second wrangler and a second workerd; if it moves the plugin without
 * the catalog, the plugin's own copy wins silently and the version in pnpm-workspace.yaml becomes
 * a lie. Comparing the two resolved versions catches both, and keeps working when the pair moves.
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
  // Scoped names are quoted in pnpm-lock.yaml ("'@cloudflare/vitest-plugin@1.1.13':"), unscoped
  // ones are not, so the quotes are optional on both ends.
  const entry = /^ {2}'?((?:@[^/\s]+\/)?[^@/\s]+)@(\d[^:\s(']*)(?:\([^)]*\))*'?:$/;
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

for (const version of resolved.get('vitest') ?? []) {
  if (major(version) !== 4) {
    failures.push(
      `vitest@${version} is not on the 4.x line: the Workers pool is built against vitest ^4.1`,
    );
  }
}

const wranglerVersions = [...(resolved.get('wrangler') ?? [])];
if (wranglerVersions.length > 1) {
  failures.push(
    `wrangler resolves to ${wranglerVersions.length} versions: ${wranglerVersions.join(', ')}`,
  );
}

/**
 * The version of wrangler that `@cloudflare/vitest-plugin` itself depends on, read out of the
 * plugin's snapshot in the lockfile rather than out of node_modules, so this still runs before
 * install.
 *
 * @returns {{ plugin: string, wrangler: string } | null}
 */
function readPluginWranglerPair(contents) {
  const header = /^ {2}'?@cloudflare\/vitest-plugin@(\d[^:'(\s]*)/;
  const dependency = /^ {6}wrangler: (\d[^(\s]*)/;
  let plugin = null;
  let inside = false;
  for (const line of contents.split('\n')) {
    const match = header.exec(line);
    if (match !== null) {
      plugin = match[1];
      inside = true;
      continue;
    }
    if (!inside) {
      continue;
    }
    if (line !== '' && !line.startsWith('    ')) {
      // Back out to a sibling entry without having seen a wrangler dependency.
      inside = false;
      continue;
    }
    const found = dependency.exec(line);
    if (found !== null && plugin !== null) {
      return { plugin, wrangler: found[1] };
    }
  }
  return null;
}

const pair = lockfile === null ? null : readPluginWranglerPair(lockfile);
if (pair === null) {
  if (resolved.has('@cloudflare/vitest-plugin')) {
    failures.push(
      'could not read the wrangler version @cloudflare/vitest-plugin depends on from pnpm-lock.yaml',
    );
  }
} else if (!wranglerVersions.includes(pair.wrangler)) {
  failures.push(
    `@cloudflare/vitest-plugin@${pair.plugin} depends on wrangler@${pair.wrangler}, but the ` +
      `workspace resolves wrangler to ${wranglerVersions.join(', ') || 'nothing'}: move both ` +
      'catalog pins together',
  );
}

const checked = ['typescript', 'vitest', 'wrangler', '@cloudflare/vitest-plugin']
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
