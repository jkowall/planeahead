#!/usr/bin/env node
/**
 * Mobile migrations guard (increment 9, ruling P6).
 *
 * The offline store's migrations ship inside every app build (`migrations.js` bundles the SQL) and
 * run on devices that already applied the earlier ones: Drizzle's migrator records what it applied
 * and never re-runs it, so editing a migration that has shipped does nothing on those devices and
 * something different on new ones. A committed migration therefore never changes; a schema change
 * is a new migration from `pnpm --filter @planeahead/mobile db:generate`.
 *
 * Two checks:
 *
 *   1. Consistency, always: every journal entry has its `NNNN_tag.sql` and its snapshot,
 *      `migrations.js` imports exactly the journal's migrations, and no `.sql` file exists that
 *      the journal does not name.
 *   2. Immutability, with `--base <git ref>` (CI passes the pull request's base, or the pushed
 *      range's `before`): every migration file that exists at the base is byte-for-byte the same
 *      now, except the journal and `migrations.js`, which may only APPEND entries.
 *
 * Dependency free, like scripts/toolchain-guard.mjs. The pure checks are exported for
 * tools/mobile/migrations-guard.test.js.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const MIGRATIONS_DIR = 'apps/mobile/src/lib/db/migrations';

/** `m0000` for journal index 0. */
export function migrationKey(idx) {
  return `m${String(idx).padStart(4, '0')}`;
}

/**
 * @param {{ journal: { entries: { idx: number, tag: string }[] }, sqlFiles: string[],
 *   snapshotFiles: string[], migrationsJs: string }} state
 * @returns {string[]} failures
 */
export function checkConsistency(state) {
  const failures = [];
  const entries = state.journal.entries ?? [];
  const expectedSql = new Set();
  entries.forEach((entry, position) => {
    if (entry.idx !== position) {
      failures.push(
        `journal entry ${entry.tag} has idx ${String(entry.idx)}, expected ${String(position)}`,
      );
    }
    const sql = `${entry.tag}.sql`;
    expectedSql.add(sql);
    if (!state.sqlFiles.includes(sql)) {
      failures.push(`journal names ${sql}, which does not exist`);
    }
    const snapshot = `${String(entry.idx).padStart(4, '0')}_snapshot.json`;
    if (!state.snapshotFiles.includes(snapshot)) {
      failures.push(`journal entry ${entry.tag} has no meta/${snapshot}`);
    }
    const key = migrationKey(entry.idx);
    const importLine = new RegExp(`^import ${key} from '\\./${entry.tag}\\.sql';$`, 'm');
    if (!importLine.test(state.migrationsJs)) {
      failures.push(`migrations.js does not import ${key} from ./${sql}`);
    }
  });
  for (const file of state.sqlFiles) {
    if (!expectedSql.has(file)) {
      failures.push(`${file} is not in the journal (hand-written or orphaned migration)`);
    }
  }
  const imports = state.migrationsJs.match(/^import m\d{4} from /gm) ?? [];
  if (imports.length !== entries.length) {
    failures.push(
      `migrations.js imports ${String(imports.length)} migrations, the journal has ${String(entries.length)}`,
    );
  }
  return failures;
}

/**
 * @param {Map<string, string>} before files at the base, path -> contents
 * @param {Map<string, string>} after files now, path -> contents
 * @returns {string[]} failures
 */
export function checkImmutability(before, after) {
  const failures = [];
  for (const [path, contents] of before) {
    const now = after.get(path);
    if (now === undefined) {
      failures.push(`${path} was committed and is now deleted`);
      continue;
    }
    if (path.endsWith('/meta/_journal.json')) {
      const was = JSON.parse(contents).entries ?? [];
      const is = JSON.parse(now).entries ?? [];
      const prefix = is.slice(0, was.length);
      if (JSON.stringify(prefix) !== JSON.stringify(was)) {
        failures.push(`${path}: committed journal entries changed (only appending is allowed)`);
      }
      continue;
    }
    if (path.endsWith('/migrations.js')) {
      const imports = contents.match(/^import m\d{4} from .*$/gm) ?? [];
      for (const line of imports) {
        if (!now.includes(line)) {
          failures.push(`${path}: the committed import "${line}" changed or disappeared`);
        }
      }
      continue;
    }
    if (now !== contents) {
      failures.push(`${path} changed after it was committed: add a new migration instead`);
    }
  }
  return failures;
}

function readTree(root) {
  const files = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        files.set(relative(repoRoot, full).split('\\').join('/'), readFileSync(full, 'utf8'));
      }
    }
  };
  walk(root);
  return files;
}

function git(args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function readTreeAt(ref) {
  const files = new Map();
  const listing = git(['ls-tree', '-r', '--name-only', ref, '--', MIGRATIONS_DIR]);
  for (const path of listing.split('\n').filter((line) => line !== '')) {
    files.set(path, git(['show', `${ref}:${path}`]));
  }
  return files;
}

function main() {
  const baseIndex = process.argv.indexOf('--base');
  const base =
    baseIndex === -1
      ? (process.env.MOBILE_MIGRATIONS_BASE ?? '')
      : (process.argv[baseIndex + 1] ?? '');
  const dir = join(repoRoot, MIGRATIONS_DIR);
  const failures = [];

  if (!existsSync(dir)) {
    console.error(`mobile-migrations-guard: FAIL\n  - ${MIGRATIONS_DIR} is missing`);
    process.exit(1);
  }
  const current = readTree(dir);
  const journalPath = `${MIGRATIONS_DIR}/meta/_journal.json`;
  failures.push(
    ...checkConsistency({
      journal: JSON.parse(current.get(journalPath) ?? '{"entries":[]}'),
      sqlFiles: readdirSync(dir).filter((file) => file.endsWith('.sql')),
      snapshotFiles: readdirSync(join(dir, 'meta')).filter((file) =>
        file.endsWith('_snapshot.json'),
      ),
      migrationsJs: current.get(`${MIGRATIONS_DIR}/migrations.js`) ?? '',
    }),
  );

  let compared = 'no base given, immutability not checked';
  if (base !== '' && !/^0+$/.test(base)) {
    try {
      git(['rev-parse', '--verify', `${base}^{commit}`]);
      const before = readTreeAt(base);
      failures.push(...checkImmutability(before, current));
      compared = `${String(before.size)} committed file(s) compared with ${base.slice(0, 12)}`;
    } catch (error) {
      compared = `base ${base} is not available (${error instanceof Error ? error.message.split('\n')[0] : 'git error'}), immutability not checked`;
      console.warn(`mobile-migrations-guard: warning: ${compared}`);
    }
  }

  if (failures.length > 0) {
    console.error('mobile-migrations-guard: FAIL');
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }
  const count = (JSON.parse(current.get(journalPath) ?? '{"entries":[]}').entries ?? []).length;
  console.log(`mobile-migrations-guard: ok  ${String(count)} migration(s); ${compared}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
