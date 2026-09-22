import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ARCHITECTURE_DOC_PATH,
  CADENCE_END_MARKER,
  CADENCE_START_MARKER,
  applyCadenceSection,
  markdownTable,
  renderCadenceSection,
} from '../scripts/gen-cadence-table';
import {
  A1_EXPECTED_POLLS,
  A2_EXPECTED_POLLS,
  LITERAL_EXPECTED_POLLS,
  PRE_48H_RELAXATION_REASON,
} from '../src/cadence';

function committedBlock(doc: string): string {
  const start = doc.indexOf(CADENCE_START_MARKER);
  const end = doc.indexOf(CADENCE_END_MARKER);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return doc.slice(start, end + CADENCE_END_MARKER.length);
}

describe('docs/architecture.md cadence block', () => {
  const doc = readFileSync(ARCHITECTURE_DOC_PATH, 'utf8');
  const rendered = renderCadenceSection();

  it('matches what the code renders (run gen:cadence-table if this fails)', () => {
    expect(committedBlock(doc)).toBe(rendered);
  });

  it('is a fixed point of the generator', () => {
    expect(applyCadenceSection(doc, rendered)).toBe(doc);
    expect(applyCadenceSection(applyCadenceSection(doc, rendered), rendered)).toBe(doc);
  });

  it('carries the derived totals and the drift warning', () => {
    expect(rendered).toContain(`| ${String(A2_EXPECTED_POLLS)} `);
    expect(rendered).toContain(`| ${String(A1_EXPECTED_POLLS)} `);
    expect(rendered).toContain(`| ${String(LITERAL_EXPECTED_POLLS)} `);
    expect(rendered).toContain('fixed slots in, in+15min, in+30min, in+45min, in+120min: 5');
    expect(rendered).toMatch(/\| literal +\| 6 h to 3 h +\| T-6h to T-5h +\| 1 h +\| 15 min/);
    expect(rendered).toMatch(
      /\| A1 +\| Post-arrival +\| in\+45min to in\+120min +\| 75 min +\| 15 min/,
    );
    expect(rendered).toContain('the fallback tail is five fixed polls');
    // No A1 row for 3 h to arrival: the pre-boarding grid runs to T-45, so there is no hole.
    expect(rendered).not.toMatch(/\| A1 +\| 3 h to arrival/);
    expect(rendered).toMatch(
      /\| A2 +\| 3 h to arrival +\| T-40min to T-10min +\| 30 min +\| 15 min/,
    );
    // A gap that crosses T-6 h is charged to both SLO windows (R10); the span column names the gap.
    expect(rendered).toMatch(/\| B +\| 48 h to 6 h +\| T-48h to T-3h +\| 45 h +\| 1 h/);
    expect(rendered).toMatch(/\| B +\| 6 h to 3 h +\| T-48h to T-3h +\| 45 h +\| 15 min/);
    // Every relaxation row carries a recorded decision; nothing prints as OPEN.
    expect(rendered).not.toContain('OPEN:');
    expect(rendered).toContain(
      'literal 2 min (out+178min to in); A1 10 min (out+170min to in); A2 10 min (out+170min to in); B 3 h (out+15min to in+15min)',
    );
    // Increment 6: the weekly pre-48 h window and its recorded relaxation on every cadence.
    expect(rendered).toContain('weekly from creation to T-48h, end-anchored on T-48h');
    expect(rendered).toContain('1 / 2 / 4 calls at 3 / 14 / 30 days');
    expect(rendered).toMatch(/\| A2 +\| > 7 d +\| T-30d to T-23d +\| 7 d +\| 2 d/);
    expect(rendered).toMatch(/\| B +\| 7 d to 48 h +\| T-9d to T-48h +\| 7 d +\| 1 d/);
    expect(rendered.split(PRE_48H_RELAXATION_REASON).length - 1).toBe(9);
    expect(rendered).toContain('Do not edit between the markers');
    expect(rendered).toContain('<!-- prettier-ignore-start -->');
    expect(rendered).toContain('<!-- prettier-ignore-end -->');
    expect(rendered).not.toMatch(new RegExp(String.fromCharCode(0x20_14)));
  });
});

describe('applyCadenceSection', () => {
  const rendered = `${CADENCE_START_MARKER}\nBLOCK\n${CADENCE_END_MARKER}`;

  it('creates the stub document when none exists', () => {
    const created = applyCadenceSection(null, rendered);
    expect(created.startsWith('# Architecture\n')).toBe(true);
    expect(created).toContain('## Refresh cadence');
    expect(created).toContain(rendered);
    expect(applyCadenceSection(created, rendered)).toBe(created);
  });

  it('replaces only the block between the markers', () => {
    const before = `# Architecture\n\nintro\n\n${CADENCE_START_MARKER}\nold\n${CADENCE_END_MARKER}\n\n## After\n\ntail\n`;
    const after = applyCadenceSection(before, rendered);
    expect(after).toBe(`# Architecture\n\nintro\n\n${rendered}\n\n## After\n\ntail\n`);
  });

  it('appends a cadence section to a document without markers', () => {
    const after = applyCadenceSection('# Architecture\n\nintro\n', rendered);
    expect(after).toBe(`# Architecture\n\nintro\n\n## Refresh cadence\n\n${rendered}\n`);
    expect(applyCadenceSection(after, rendered)).toBe(after);
  });
});

describe('markdownTable', () => {
  it('pads every column to its widest cell, at least three wide', () => {
    expect(markdownTable(['a', 'bb'], [['ccc', 'd']])).toBe(
      ['| a   | bb  |', '| --- | --- |', '| ccc | d   |'].join('\n'),
    );
  });

  it('tolerates short rows', () => {
    expect(markdownTable(['x', 'y'], [['1']])).toBe(
      ['| x   | y   |', '| --- | --- |', '| 1   |     |'].join('\n'),
    );
  });
});
