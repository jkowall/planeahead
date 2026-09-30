/**
 * Every workflow's job keys are unique, and the scheduled native-smoke workflow keeps its shape
 * (increment 11, ruling V7, ADR 0008).
 *
 * A duplicate job key is a YAML mapping with the same key twice: most parsers keep the last one
 * silently, and GitHub rejects the whole file without running anything. It happened once
 * (increment 9's merge left two `vitest-exit-guard` jobs in ci.yml, removed in #9), so it is
 * checked for every file here rather than by eye.
 *
 * Text based, like migration-hash-check.test.js: the repository has no YAML parser at the root,
 * and a job is a key at two spaces of indentation under `jobs:`.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '..', '..');
const workflowsDir = join(repoRoot, '.github', 'workflows');

/** The job keys of one workflow, in order, duplicates kept. */
function jobKeys(text) {
  const keys = [];
  let inJobs = false;
  for (const line of text.split('\n')) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (/^\S/.test(line)) {
      inJobs = false;
      continue;
    }
    const key = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (inJobs && key !== null) {
      keys.push(key[1]);
    }
  }
  return keys;
}

/** The lines of one job's block, comments dropped. */
function jobBlock(text, job) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === `  ${job}:`);
  expect(start, `job ${job} is missing`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((line, index) => index > start && /^ {2}\S/.test(line));
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

const workflows = readdirSync(workflowsDir)
  .filter((file) => file.endsWith('.yml'))
  .map((file) => ({ file, text: readFileSync(join(workflowsDir, file), 'utf8') }));

describe('workflow job keys', () => {
  it('finds the workflows, native-smoke included', () => {
    expect(workflows.map(({ file }) => file)).toContain('native-smoke.yml');
  });

  for (const { file, text } of workflows) {
    it(`${file} has at least one job and no job key twice`, () => {
      const keys = jobKeys(text);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.filter((key, index) => keys.indexOf(key) !== index)).toEqual([]);
    });
  }

  it('recognises a duplicate job key', () => {
    const keys = jobKeys('on: push\njobs:\n  a:\n    steps: []\n  b:\n    x: 1\n  a:\n    y: 2\n');
    expect(keys).toEqual(['a', 'b', 'a']);
  });
});

describe('native-smoke.yml', () => {
  const text = readFileSync(join(workflowsDir, 'native-smoke.yml'), 'utf8');
  const code = text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  const script = readFileSync(join(repoRoot, 'scripts', 'native-smoke.sh'), 'utf8');

  it('runs on a schedule and on demand only, never on a push or a pull request', () => {
    const on = /^on:\n((?: .*\n|\n)*?)(?=^\S)/m.exec(code)?.[1] ?? '';
    expect(on).toMatch(/^ {2}schedule:\n {4}- cron: '[^']+'$/m);
    expect(on).toMatch(/^ {2}workflow_dispatch:/m);
    expect(on).not.toMatch(/pull_request|push:/);
  });

  it('never builds on EAS and holds no secrets', () => {
    expect(code).not.toMatch(/\beas (build|update)\b|expo-github-action|secrets\./);
  });

  it('has exactly the iOS and Android jobs, each with a timeout, under one concurrency group', () => {
    expect(jobKeys(text)).toEqual(['ios', 'android']);
    for (const job of ['ios', 'android']) {
      expect(jobBlock(text, job)).toMatch(/^ {4}timeout-minutes: \d+$/m);
    }
    expect(code).toMatch(/^concurrency:\n {2}group: .+\n {2}cancel-in-progress: true$/m);
  });

  it('gates on Xcode 26.6 on macos-26 and lets the Xcode 27 leg fail without failing the run', () => {
    const ios = jobBlock(text, 'ios');
    expect(ios).toMatch(/^ {4}runs-on: macos-26$/m);
    expect(ios).toMatch(/^ {8}xcode: \['26\.6', '27'\]$/m);
    expect(ios).toMatch(/^ {4}continue-on-error: \$\{\{ matrix\.xcode == '27' \}\}$/m);
    expect(ios).toMatch(/fail-fast: false/);
    expect(ios).toMatch(/xcode-select --switch/);
  });

  it('prebuilds, builds, asserts the app contents and launches on both platforms', () => {
    const steps = [...code.matchAll(/scripts\/native-smoke\.sh ([a-z-]+)/g)].map((m) => m[1]);
    expect(steps).toEqual([
      'ios-prebuild',
      'ios-build',
      'ios-archive',
      'ios-launch',
      'android-prebuild',
      'android-build',
      'android-archive',
      'android-launch',
    ]);
    for (const step of steps) {
      expect(script).toContain(`  ${step}) `);
    }
  });

  it('builds the watch shells for watchOS: the script never forces the iOS SDK', () => {
    expect(script).not.toMatch(/^\s*[^#\n]*-sdk iphonesimulator/m);
    expect(script).toMatch(/-destination "platform=iOS Simulator,id=\$simulator"/);
  });

  it('asserts the widget extension build settings, the watch icon and no debug dylib (Z10, Z11)', () => {
    expect(script).toMatch(
      /-showBuildSettings -project "ios\/\$PROJECT\.xcodeproj" \\\n\s+-target ExpoWidgetsTarget -configuration Release/,
    );
    expect(script).toMatch(/SWIFT_OPTIMIZATION_LEVEL <<<"\$settings"\)" -O$/m);
    expect(script).toMatch(/ENABLE_DEBUG_DYLIB <<<"\$settings"\)" NO$/m);
    expect(script).toContain(
      ':CFBundleIcons:CFBundlePrimaryIcon:CFBundleIconName)" \\\n      AppIcon',
    );
    expect(script).toContain('[ -f "$watch/Assets.car" ]');
    expect(script).toContain("-name '*.debug.dylib' -o -name '__preview.dylib'");
  });

  it('builds the release APK too and launches it, not the dev launcher (ruling Z5)', () => {
    expect(script).toMatch(/\.\/gradlew assembleDebug assembleRelease /);
    expect(script).toContain("grep -qx 'assets/index.android.bundle'");
    const launch = script.slice(script.indexOf('android_launch() {'));
    expect(launch).toMatch(/adb install -r "\$APK_RELEASE"/);
    expect(launch).not.toMatch(/app-debug\.apk|\$APK_DEBUG/);
    expect(launch).toContain('| logcat_errors)');
  });

  it('lets a manual run pick one platform, while a scheduled run runs every leg', () => {
    const on = /^on:\n((?: .*\n|\n)*?)(?=^\S)/m.exec(code)?.[1] ?? '';
    expect(on).toMatch(/^ {6}platforms:\n(?: {8}.*\n)*? {8}options: \[all, ios, android\]\n/m);
    expect(on).toMatch(/^ {8}default: all$/m);
    // A scheduled run has no inputs, so `inputs.platforms` is empty and neither job is skipped.
    expect(jobBlock(text, 'ios')).toMatch(/^ {4}if: inputs\.platforms != 'android'$/m);
    expect(jobBlock(text, 'android')).toMatch(/^ {4}if: inputs\.platforms != 'ios'$/m);
  });

  it('selects Xcode before the checkout, so a missing Xcode fails in seconds', () => {
    const ios = jobBlock(text, 'ios');
    const select = ios.indexOf('- name: Select Xcode');
    expect(select).toBeGreaterThan(-1);
    expect(select).toBeLessThan(ios.indexOf('actions/checkout'));
    expect(ios.slice(0, select)).not.toMatch(/^ {6}- /m);
  });

  it('builds only the ABI the Android emulator runs, after freeing disk, never the SDK', () => {
    const android = jobBlock(text, 'android');
    const abi = /^ {6}SMOKE_ANDROID_ABIS: (\S+)$/m.exec(android)?.[1];
    expect(abi).toBe('x86_64');
    expect(android).toMatch(new RegExp(`^ {10}arch: ${abi}$`, 'm'));
    const free = android.indexOf('- name: Free disk space');
    const checkout = android.indexOf('actions/checkout');
    expect(free).toBeGreaterThan(-1);
    expect(free).toBeLessThan(checkout);
    const freeStep = android.slice(free, checkout);
    expect(freeStep).toContain('sudo rm -rf');
    // The Android SDK, the JDKs and the tool cache the setup actions install into all stay.
    expect(freeStep).not.toMatch(/android|jvm|hostedtoolcache(?!\/CodeQL)/);
  });

  it('refuses to start the Android build without room, and reports the room left', () => {
    const build = script.slice(
      script.indexOf('android_build() {'),
      script.indexOf('# The newest build-tools'),
    );
    const guard = build.indexOf('[ "$room" -ge "$MIN_FREE_GB" ]');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(build.indexOf('./gradlew'));
    expect(build).toContain('free after the Android build');
    expect(script).toMatch(/^MIN_FREE_GB="\$\{SMOKE_MIN_FREE_GB:-\d+\}"$/m);
  });
});

describe('native-smoke.sh classifiers', () => {
  const scriptPath = join(repoRoot, 'scripts', 'native-smoke.sh');
  const script = readFileSync(scriptPath, 'utf8');

  function run(step, input) {
    const result = spawnSync('bash', [scriptPath, step], { input, encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it('fails the launch on a fatal in the app process or a ReactNativeJS error, not elsewhere', () => {
    const logcat = [
      'E/AndroidRuntime( 123): FATAL EXCEPTION: main',
      'E/AndroidRuntime( 123): Process: com.android.systemui, PID: 123',
      'E/AndroidRuntime( 124): FATAL EXCEPTION: main',
      'E/AndroidRuntime( 124): Process: app.planeahead.mobile.preview, PID: 124',
      'E/AndroidRuntime( 456): FATAL EXCEPTION: mqt_v_js',
      'E/AndroidRuntime( 456): Process: app.planeahead.mobile, PID: 456',
      'E/AndroidRuntime( 456): com.facebook.react.common.JavascriptException: boom',
      'E/ReactNativeJS( 456): TypeError: undefined is not a function',
      '',
    ].join('\n');
    expect(run('logcat-errors', logcat).stdout.trim().split('\n')).toEqual([
      'E/AndroidRuntime( 456): FATAL EXCEPTION: mqt_v_js',
      'E/AndroidRuntime( 456): Process: app.planeahead.mobile, PID: 456',
      'E/ReactNativeJS( 456): TypeError: undefined is not a function',
    ]);
    const quiet =
      'E/AndroidRuntime( 123): FATAL EXCEPTION: main\nE/AndroidRuntime( 123): Process: com.android.phone, PID: 123\n';
    expect(run('logcat-errors', quiet).stdout).toBe('');
  });

  it('holds the release APK to exactly the expected permissions (rulings Z3, Z11)', () => {
    const list = /^EXPECTED_ANDROID_PERMISSIONS=\(\n((?: {2}.+\n)+)\)$/m.exec(script)?.[1] ?? '';
    const expected = list
      .trim()
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .map((line) =>
        line
          .trim()
          .replace(/^"\$BUNDLE_ID/, 'app.planeahead.mobile')
          .replace(/"$/, ''),
      );
    expect(expected).toContain('android.permission.INTERNET');
    expect(expected).toContain('app.planeahead.mobile.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION');
    expect(expected).not.toContain('android.permission.FOREGROUND_SERVICE');
    const dump = (names) =>
      [
        "package: name='app.planeahead.mobile'",
        ...names.map((name) => `uses-permission: name='${name}'`),
      ].join('\n') + '\n';
    // `permissions-differ` succeeds (exit 0) only when the lists differ.
    expect(run('permissions-differ', dump([...expected].reverse())).status).toBe(1);
    expect(
      run('permissions-differ', dump([...expected, 'android.permission.FOREGROUND_SERVICE']))
        .status,
    ).toBe(0);
    expect(run('permissions-differ', dump(expected.slice(1))).status).toBe(0);
    // A permission a dependency declares as <uses-permission-sdk-23> is as real as a plain one
    // on every device the app supports (minSdk 24); aapt2 prints it on its own line.
    const sdk23 =
      dump(expected) + "uses-permission-sdk-23: name='android.permission.ACCESS_FINE_LOCATION'\n";
    expect(run('permissions-differ', sdk23).status).toBe(0);
    expect(run('permissions-differ', sdk23).stderr).toContain('ACCESS_FINE_LOCATION');
  });
});
