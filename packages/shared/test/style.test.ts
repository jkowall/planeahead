import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Two house rules that a reviewer would otherwise have to check by hand: no em dashes anywhere
 * this increment writes, and no wall-clock reads in `src/` outside the `uuidv7` default clock.
 */

const EM_DASH = new RegExp(String.fromCharCode(0x20_14));
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..');

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.turbo') {
      continue;
    }
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      walk(path, out);
    } else {
      out.push(path);
    }
  }
  return out;
}

const PACKAGE_FILES = walk(PACKAGE_ROOT).filter((path) => /\.(ts|json|md)$/.test(path));
const DOC_FILES = [
  'docs/architecture.md',
  'docs/adr/0003-flight-key.md',
  'docs/adr/0006-uuidv7.md',
  'docs/adr/README.md',
].map((path) => resolve(REPO_ROOT, path));

describe('house style', () => {
  it('scans a meaningful set of files', () => {
    expect(PACKAGE_FILES.length).toBeGreaterThan(20);
  });

  it.each([...PACKAGE_FILES, ...DOC_FILES].map((path) => [relative(REPO_ROOT, path), path]))(
    '%s has no em dash',
    (_label, path) => {
      expect(readFileSync(path, 'utf8')).not.toMatch(EM_DASH);
    },
  );

  it('reads the wall clock only in the uuidv7 default clock', () => {
    const offenders = walk(join(PACKAGE_ROOT, 'src'))
      .filter((path) => path.endsWith('.ts'))
      .filter((path) => {
        const source = stripComments(readFileSync(path, 'utf8'));
        return /\bDate\.now\b|new Date\(\)/.test(source);
      })
      .map((path) => relative(PACKAGE_ROOT, path));
    expect(offenders).toEqual(['src/ids.ts']);
    const ids = stripComments(readFileSync(join(PACKAGE_ROOT, 'src', 'ids.ts'), 'utf8'));
    expect(ids.match(/Date\.now/g)).toHaveLength(1);
    expect(ids).not.toMatch(/new Date\(\)/);
  });
});
