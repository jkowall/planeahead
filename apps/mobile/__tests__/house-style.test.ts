/**
 * No em dashes anywhere increments 9 to 11 write (house rule; packages/shared has the same test).
 * Increment 11 adds the native sources (Kotlin, Swift, Gradle, XML, plists), ADR 0008, the
 * nightly workflow and its script, and its review round the verification record.
 */

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
const SKIP = new Set([
  'node_modules',
  '.expo',
  'dist',
  'assets',
  '.turbo',
  // Gradle output of modules/android-surfaces (its project directory is modules/*/android).
  'build',
  '.gradle',
]);
/** The generated native projects, by path: modules/android-surfaces/android is source. */
const SKIP_PATHS = new Set([path.join(APP_ROOT, 'ios'), path.join(APP_ROOT, 'android')]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir)) {
    if (SKIP.has(entry) || SKIP_PATHS.has(path.join(dir, entry))) {
      continue;
    }
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx|js|json|md|sql|kt|swift|gradle|xml|plist)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const FILES = [
  ...walk(APP_ROOT),
  path.join(REPO_ROOT, 'docs', 'adr', '0001-expo.md'),
  path.join(REPO_ROOT, 'docs', 'adr', '0005-identifiers.md'),
  path.join(REPO_ROOT, 'docs', 'adr', '0008-expo-widgets.md'),
  path.join(REPO_ROOT, 'docs', 'adr', 'README.md'),
  path.join(REPO_ROOT, 'docs', 'increments', '11-verification.md'),
  path.join(REPO_ROOT, 'apps', 'api', 'src', 'routes', 'well-known.ts'),
  path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'),
  path.join(REPO_ROOT, '.github', 'workflows', 'mobile-preview.yml'),
  path.join(REPO_ROOT, '.github', 'workflows', 'native-smoke.yml'),
  path.join(REPO_ROOT, 'scripts', 'native-smoke.sh'),
  path.join(REPO_ROOT, 'packages', 'db', 'migrations', '0004_push_to_start_token_kind.sql'),
];

describe('house style', () => {
  it('scans a meaningful set of files, the native sources included', () => {
    expect(FILES.length).toBeGreaterThan(40);
    for (const source of [
      'OngoingNotificationModule.kt',
      'NextFlightTileService.kt',
      'PlaneAheadWatchApp.swift',
      'live-activity.tsx',
    ]) {
      expect(FILES.some((file) => file.endsWith(source))).toBe(true);
    }
  });

  it.each(FILES.map((file) => [file.slice(REPO_ROOT.length + 1), file]))(
    '%s has no em dash',
    (_label, file) => {
      expect(fs.readFileSync(file, 'utf8').includes(EM_DASH)).toBe(false);
    },
  );
});
