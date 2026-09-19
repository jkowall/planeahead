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
import { A1_EXPECTED_POLLS, A2_EXPECTED_POLLS, LITERAL_EXPECTED_POLLS } from '../src/cadence';

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
    expect(rendered).toContain('fixed slots in+15min, in+30min, in+45min, in+60min, in+120min: 5');
    expect(rendered).toMatch(/\| literal +\| Hourly window +\| 1 h +\| 15 min/);
    expect(rendered).toContain('the SLO holds except on in+60min to in+120min');
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
