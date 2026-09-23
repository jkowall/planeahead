/** No em dashes anywhere increment 9 writes (house rule; packages/shared has the same test). */

// Jest's CommonJS wrapper provides it; the app's tsconfig carries no Node types.
declare const __dirname: string;

const fs = jest.requireActual<{
  readdirSync(path: string): string[];
  readFileSync(path: string, encoding: 'utf8'): string;
  statSync(path: string): { isDirectory(): boolean };
}>('fs');
const path = jest.requireActual<{
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
}>('path');

const EM_DASH = String.fromCharCode(0x2014);
const APP_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..');
const SKIP = new Set(['node_modules', 'ios', 'android', '.expo', 'dist', 'assets', '.turbo']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir)) {
    if (SKIP.has(entry)) {
      continue;
    }
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx|js|json|md|sql)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const FILES = [
  ...walk(APP_ROOT),
  path.join(REPO_ROOT, 'docs', 'adr', '0001-expo.md'),
  path.join(REPO_ROOT, 'docs', 'adr', '0005-identifiers.md'),
  path.join(REPO_ROOT, 'docs', 'adr', 'README.md'),
  path.join(REPO_ROOT, 'apps', 'api', 'src', 'routes', 'well-known.ts'),
  path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'),
  path.join(REPO_ROOT, '.github', 'workflows', 'mobile-preview.yml'),
];

describe('house style', () => {
  it('scans a meaningful set of files', () => {
    expect(FILES.length).toBeGreaterThan(40);
  });

  it.each(FILES.map((file) => [file.slice(REPO_ROOT.length + 1), file]))(
    '%s has no em dash',
    (_label, file) => {
      expect(fs.readFileSync(file, 'utf8').includes(EM_DASH)).toBe(false);
    },
  );
});
