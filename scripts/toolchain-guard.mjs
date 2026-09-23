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
 * And the mobile pins (increment 9, docs/increments/09-11-mobile.facts.md "Pins"), each chosen
 * because the failure it prevents is silent until a device build or a test run:
 *   - more than one version of react, react-native, expo or a native module Expo's manifest pins
 *     (reanimated, worklets, gesture-handler): two copies mean two renderers or a native build
 *     that links the wrong one
 *   - expo not on the SDK 57 line, or jest-expo not on the same major as expo
 *   - @react-native/jest-preset not exactly the react-native version (jest-expo peers on it)
 *   - jest not on 29 (jest-expo 57 is Jest 29 throughout; Jest 30 is unverified with it)
 *   - react-reconciler (test-renderer's) not the line of the installed React: 0.(31 + minor)
 *   - @better-auth/expo not exactly better-auth (the server plugin and client move together)
 *   - @sentry/react-native off the 7.x line Expo SDK 57 pins, or an @sentry/cli that is not the
 *     exact version @sentry/react-native depends on (its Xcode phase resolves it from apps/mobile)
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

// ---------------------------------------------------------------------------------------------
// Mobile pins (increment 9).
// ---------------------------------------------------------------------------------------------

/**
 * The version `parent` (any snapshot of it) declares for `dependency`, read from the lockfile's
 * snapshots section. Same approach as the wrangler pair above, generalised.
 *
 * @returns {string | null}
 */
function lockedDependencyOf(contents, parent, dependency) {
  const escaped = parent.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const header = new RegExp(`^ {2}'?${escaped}@\\d`);
  const quoted = dependency.startsWith('@') ? `'${dependency}'` : dependency;
  const line = new RegExp(`^ {6}${quoted.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}: (\\d[^(\\s]*)`);
  let inside = false;
  for (const text of contents.split('\n')) {
    if (header.test(text)) {
      inside = true;
      continue;
    }
    if (!inside) {
      continue;
    }
    if (text !== '' && !text.startsWith('    ')) {
      inside = false;
      continue;
    }
    const found = line.exec(text);
    if (found !== null) {
      return found[1];
    }
  }
  return null;
}

function versionsOf(name) {
  return [...(resolved.get(name) ?? [])];
}

function minor(version) {
  return Number.parseInt(version.split('.')[1] ?? '', 10);
}

if (resolved.has('expo')) {
  for (const name of [
    'react',
    'react-native',
    'expo',
    'react-native-reanimated',
    'react-native-worklets',
    'react-native-gesture-handler',
  ]) {
    const versions = versionsOf(name);
    if (versions.length > 1) {
      failures.push(`${name} resolves to ${versions.length} versions: ${versions.join(', ')}`);
    }
  }

  for (const version of versionsOf('expo')) {
    if (major(version) !== 57) {
      failures.push(`expo@${version} is not on the SDK 57 line the mobile pins are verified for`);
    }
  }
  for (const version of versionsOf('jest-expo')) {
    if (!versionsOf('expo').some((expo) => major(expo) === major(version))) {
      failures.push(`jest-expo@${version} is not on the same major as expo`);
    }
  }

  const reactNative = versionsOf('react-native');
  for (const version of versionsOf('@react-native/jest-preset')) {
    if (!reactNative.includes(version)) {
      failures.push(
        `@react-native/jest-preset@${version} is not the react-native version (${reactNative.join(', ')})`,
      );
    }
  }

  assertBelowMajor('jest', 30, 'jest-expo 57 is Jest 29 throughout; Jest 30 is unverified with it');

  const react = versionsOf('react');
  for (const version of versionsOf('react-reconciler')) {
    if (
      !react.some(
        (reactVersion) => major(version) === 0 && minor(version) === 31 + minor(reactVersion),
      )
    ) {
      failures.push(
        `react-reconciler@${version} does not match React ${react.join(', ')} (0.(31 + minor)): pin test-renderer to the line that depends on it`,
      );
    }
  }

  const betterAuth = versionsOf('better-auth');
  for (const version of versionsOf('@better-auth/expo')) {
    if (!betterAuth.includes(version)) {
      failures.push(
        `@better-auth/expo@${version} is not the better-auth version (${betterAuth.join(', ')})`,
      );
    }
  }

  for (const version of versionsOf('@sentry/react-native')) {
    if (major(version) !== 7) {
      failures.push(`@sentry/react-native@${version} is off the 7.x line Expo SDK 57 pins`);
    }
  }
  const sentryCli =
    lockfile === null ? null : lockedDependencyOf(lockfile, '@sentry/react-native', '@sentry/cli');
  if (sentryCli !== null && !versionsOf('@sentry/cli').every((version) => version === sentryCli)) {
    failures.push(
      `@sentry/react-native depends on @sentry/cli@${sentryCli}, but the workspace resolves ${versionsOf('@sentry/cli').join(', ')}`,
    );
  }
}

const checked = [
  'typescript',
  'vitest',
  'wrangler',
  '@cloudflare/vitest-plugin',
  'expo',
  'react-native',
  'react',
  'jest',
  'jest-expo',
]
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
