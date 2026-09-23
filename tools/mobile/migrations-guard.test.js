/**
 * scripts/mobile-migrations-guard.mjs: a committed mobile migration never changes, and the journal,
 * the SQL files and the bundled migrations.js agree.
 */

import { describe, expect, it } from 'vitest';
import {
  MIGRATIONS_DIR,
  checkConsistency,
  checkImmutability,
} from '../../scripts/mobile-migrations-guard.mjs';

const JOURNAL_ONE = { entries: [{ idx: 0, tag: '0000_init', when: 1, breakpoints: true }] };
const JOURNAL_TWO = {
  entries: [...JOURNAL_ONE.entries, { idx: 1, tag: '0001_more', when: 2, breakpoints: true }],
};
const JS_ONE =
  "import journal from './meta/_journal.json';\nimport m0000 from './0000_init.sql';\n";
const JS_TWO = `${JS_ONE}import m0001 from './0001_more.sql';\n`;

function tree(files) {
  return new Map(
    Object.entries(files).map(([name, contents]) => [`${MIGRATIONS_DIR}/${name}`, contents]),
  );
}

describe('checkConsistency', () => {
  it('accepts a journal, its SQL, its snapshots and matching imports', () => {
    expect(
      checkConsistency({
        journal: JOURNAL_TWO,
        sqlFiles: ['0000_init.sql', '0001_more.sql'],
        snapshotFiles: ['0000_snapshot.json', '0001_snapshot.json'],
        migrationsJs: JS_TWO,
      }),
    ).toEqual([]);
  });

  it('refuses a hand-written SQL file the journal does not name, and a missing import', () => {
    const failures = checkConsistency({
      journal: JOURNAL_ONE,
      sqlFiles: ['0000_init.sql', '0001_by_hand.sql'],
      snapshotFiles: ['0000_snapshot.json'],
      migrationsJs: "import journal from './meta/_journal.json';\n",
    });
    expect(failures.join('\n')).toMatch(/0001_by_hand\.sql is not in the journal/);
    expect(failures.join('\n')).toMatch(/does not import m0000/);
  });
});

describe('checkImmutability', () => {
  const base = tree({
    '0000_init.sql': 'CREATE TABLE a (id text);',
    'meta/0000_snapshot.json': '{}',
    'meta/_journal.json': JSON.stringify(JOURNAL_ONE),
    'migrations.js': JS_ONE,
  });

  it('allows appending a migration', () => {
    const now = tree({
      '0000_init.sql': 'CREATE TABLE a (id text);',
      '0001_more.sql': 'CREATE TABLE b (id text);',
      'meta/0000_snapshot.json': '{}',
      'meta/0001_snapshot.json': '{}',
      'meta/_journal.json': JSON.stringify(JOURNAL_TWO),
      'migrations.js': JS_TWO,
    });
    expect(checkImmutability(base, now)).toEqual([]);
  });

  it('fails when a committed migration is edited, deleted or its journal entry rewritten', () => {
    const now = tree({
      '0000_init.sql': 'CREATE TABLE a (id text, extra text);',
      'meta/_journal.json': JSON.stringify({ entries: [{ ...JOURNAL_ONE.entries[0], when: 99 }] }),
      'migrations.js': JS_ONE,
    });
    const failures = checkImmutability(base, now).join('\n');
    expect(failures).toMatch(/0000_init\.sql changed after it was committed/);
    expect(failures).toMatch(/0000_snapshot\.json was committed and is now deleted/);
    expect(failures).toMatch(/committed journal entries changed/);
  });
});
