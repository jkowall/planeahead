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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';

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

/** The native-smoke.sh step each `run:` of a workflow's code (comments dropped) names, in order. */
function workflowSteps(code) {
  return [...code.matchAll(/scripts\/native-smoke\.sh ([a-z-]+)/g)].map((m) => m[1]);
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

  it('prebuilds, builds, asserts the app, launches, then archives for a device (ruling S4)', () => {
    // Every one is dispatched by the script: the 'native-smoke.sh' tests below run each.
    expect(workflowSteps(code)).toEqual([
      'ios-prebuild',
      'ios-build',
      'ios-archive',
      'ios-launch',
      'ios-device-archive',
      'android-prebuild',
      'android-build',
      'android-archive',
      'disk-guard',
      'android-launch',
    ]);
  });

  it('gates iOS on the Xcode of the EAS image eas.json pins for store builds (ruling S6)', () => {
    const eas = JSON.parse(readFileSync(join(repoRoot, 'apps', 'mobile', 'eas.json'), 'utf8'));
    const xcode = /-xcode-(\d+\.\d+)$/.exec(eas.build.base.ios.image)?.[1];
    expect(xcode).toBe('26.6');
    const ios = jobBlock(text, 'ios');
    const matrix = /^ {8}xcode: \[(.+)\]$/m.exec(ios)?.[1] ?? '';
    expect(matrix.split(', ')).toContain(`'${xcode}'`);
    // The pinned Xcode is the leg that must pass: only another version may fail the run quietly.
    const lenient = /^ {4}continue-on-error: \$\{\{ matrix\.xcode == '([\d.]+)' \}\}$/m.exec(
      ios,
    )?.[1];
    expect(lenient).toBeDefined();
    expect(lenient).not.toBe(xcode);
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
    // One concurrency group per platform choice: a one-platform run never cancels the other's.
    expect(code).toMatch(
      /^ {2}group: native-smoke-\$\{\{ github\.ref \}\}-\$\{\{ inputs\.platforms \|\| 'all' \}\}$/m,
    );
  });

  it('selects Xcode before the checkout, so a missing Xcode fails in seconds', () => {
    const ios = jobBlock(text, 'ios');
    const select = ios.indexOf('- name: Select Xcode');
    expect(select).toBeGreaterThan(-1);
    expect(select).toBeLessThan(ios.indexOf('actions/checkout'));
    expect(ios.slice(0, select)).not.toMatch(/^ {6}- /m);
  });

  it('builds only the ABI the Android emulator runs, after freeing only unused toolchains', () => {
    const android = jobBlock(text, 'android');
    const abi = /^ {6}SMOKE_ANDROID_ABIS: (\S+)$/m.exec(android)?.[1];
    expect(abi).toBe('x86_64');
    expect(android).toMatch(new RegExp(`^ {10}arch: ${abi}$`, 'm'));
    expect(android).toMatch(/^ {6}SMOKE_BUILD_MIN_FREE_GB: '\d+'$/m);
    const free = android.indexOf('- name: Free disk space');
    const checkout = android.indexOf('actions/checkout');
    expect(free).toBeGreaterThan(-1);
    expect(free).toBeLessThan(checkout);
    // Exactly these paths: the Android SDK, the JDKs and the setup actions' tool cache all stay.
    const removed =
      /sudo rm -rf ((?:[^\n\\]|\\\n)+)/.exec(android.slice(free, checkout))?.[1] ?? '';
    expect(removed.split(/[\s\\]+/).filter(Boolean)).toEqual([
      '/usr/share/dotnet',
      '/usr/local/.ghcup',
      '/usr/share/swift',
      '/opt/hostedtoolcache/CodeQL',
    ]);
    // The emulator step downloads its system image before the script runs: the disk is checked
    // in a step of its own just before it.
    expect(android).toMatch(/run: scripts\/native-smoke\.sh disk-guard \d+ "the emulator"/);
  });
});

describe('native-smoke.sh classifiers', () => {
  const scriptPath = join(repoRoot, 'scripts', 'native-smoke.sh');
  const script = readFileSync(scriptPath, 'utf8');

  /** Runs the script with `args` (a step, or a step and its arguments) and `input` on stdin. */
  function run(args, input) {
    const argv = Array.isArray(args) ? args : [args];
    const result = spawnSync('bash', [scriptPath, ...argv], { input, encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  const lines = (output) => output.split('\n').filter((line) => line !== '');

  const scratch = [];

  afterAll(() => {
    for (const dir of scratch) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function runWith(args, env = {}, file = scriptPath) {
    const result = spawnSync('bash', [file, ...args], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  /** A `df` first on PATH that reports `availableKb` free, in the POSIX layout. */
  function stubDf(availableKb) {
    const dir = mkdtempSync(join(tmpdir(), 'smoke-df-'));
    scratch.push(dir);
    const line = `/dev/root 76026616 1 ${String(availableKb)} 79%% /`;
    writeFileSync(
      join(dir, 'df'),
      `#!/bin/sh\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n${line}\\n'\n`,
      { mode: 0o755 },
    );
    return { PATH: `${dir}:${process.env.PATH ?? ''}` };
  }

  const GIB = 1048576;

  it('checks the disk on the fourth df column, in whole gigabytes, against the need', () => {
    const sixteen = stubDf(16 * GIB);
    const enough = runWith(['disk-guard', '16', 'the test'], sixteen);
    expect(enough.status).toBe(0);
    expect(enough.stdout).toContain('16 GB free before the test');
    const refused = runWith(['disk-guard', '17', 'the test'], sixteen);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('only 16 GB free before the test, which needs about 17 GB');
    expect(runWith(['disk-guard', '0', 'the test'], stubDf(0)).status).toBe(0);
    const fraction = runWith(['disk-guard', '7.5', 'the test'], sixteen);
    expect(fraction.status).toBe(1);
    expect(fraction.stderr).toContain('whole gigabytes');
    expect(runWith(['disk-guard', '', 'the test'], sixteen).status).toBe(1);
  });

  it('builds with the ABI list, checks the disk first and keeps a failed build exit code', () => {
    // A copy of the script in a scratch repository, whose gradlew records its arguments.
    const root = mkdtempSync(join(tmpdir(), 'smoke-repo-'));
    scratch.push(root);
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'apps', 'mobile', 'android'), { recursive: true });
    const copy = join(root, 'scripts', 'native-smoke.sh');
    writeFileSync(copy, script);
    const argsFile = join(root, 'gradlew-args');
    writeFileSync(
      join(root, 'apps', 'mobile', 'android', 'gradlew'),
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nexit "\${STUB_EXIT:-0}"\n`,
      { mode: 0o755 },
    );
    const gradleArgs = () => readFileSync(argsFile, 'utf8').trim().split('\n');
    const build = (env) => runWith(['android-build'], env, copy);
    const plenty = stubDf(100 * GIB);

    expect(build({ ...plenty, SMOKE_ANDROID_ABIS: 'x86_64' }).status).toBe(0);
    expect(gradleArgs()).toEqual(
      expect.arrayContaining([
        'assembleDebug',
        'assembleRelease',
        '-PreactNativeArchitectures=x86_64',
      ]),
    );
    expect(build({ ...plenty, SMOKE_ANDROID_ABIS: '' }).status).toBe(0);
    expect(gradleArgs().some((arg) => arg.startsWith('-PreactNativeArchitectures'))).toBe(false);

    // The default need grows with the ABIs (15 GB for one, 30 for all four); 0 skips the check.
    const twenty = stubDf(20 * GIB);
    expect(build({ ...twenty, SMOKE_ANDROID_ABIS: 'x86_64' }).status).toBe(0);
    const allAbis = build({ ...twenty, SMOKE_ANDROID_ABIS: '' });
    expect(allAbis.status).toBe(1);
    expect(allAbis.stderr).toContain('needs about 30 GB');
    expect(build({ ...twenty, SMOKE_ANDROID_ABIS: '', SMOKE_BUILD_MIN_FREE_GB: '0' }).status).toBe(
      0,
    );

    const failed = build({ ...plenty, SMOKE_ANDROID_ABIS: 'x86_64', STUB_EXIT: '3' });
    expect(failed.status).toBe(3);
    expect(failed.stdout).toContain('GB free after the Android build');
  });

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

  /** A copy of the script in a scratch repository with an empty app, so no step reaches the real one. */
  function scratchRepo() {
    const root = mkdtempSync(join(tmpdir(), 'smoke-repo-'));
    scratch.push(root);
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'apps', 'mobile', 'android'), { recursive: true });
    const copy = join(root, 'scripts', 'native-smoke.sh');
    writeFileSync(copy, script);
    return { root, copy };
  }

  /** A directory of executable stubs, each `name: body` a shell script, to put first on PATH. */
  function stubs(bodies) {
    const dir = mkdtempSync(join(tmpdir(), 'smoke-bin-'));
    scratch.push(dir);
    for (const [name, body] of Object.entries(bodies)) {
      writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    }
    return dir;
  }

  it('runs every step the workflow names, and prints its usage for anything else', () => {
    const workflow = readFileSync(join(workflowsDir, 'native-smoke.yml'), 'utf8');
    const steps = workflowSteps(workflow);
    expect(steps).toContain('ios-device-archive');
    // Every tool a step starts with fails at once, so each step stops at its first command:
    // anything but the usage's exit code 2 means the script dispatched the step.
    const failing = stubs(
      Object.fromEntries(
        ['xcodebuild', 'xcrun', 'pnpm', 'adb', 'plutil', 'nm', 'vtool'].map((tool) => [
          tool,
          'exit 97',
        ]),
      ),
    );
    const { root, copy } = scratchRepo();
    // Every path a step writes or removes points into the scratch repository, whatever the
    // caller's environment says.
    const env = {
      PATH: `${failing}:${process.env.PATH ?? ''}`,
      SMOKE_SIMULATOR: 'stub',
      SMOKE_DERIVED_DATA: join(root, 'derived-data'),
      SMOKE_ARCHIVE_PATH: join(root, 'PlaneAhead.xcarchive'),
    };
    for (const step of steps) {
      const result = runWith([step], env, copy);
      expect(result.status, step).not.toBe(2);
      expect(result.status, step).not.toBe(0);
      expect(result.stdout, step).not.toContain('Native smoke (increment 11');
    }
    const usage = runWith(['no-such-step'], {}, copy);
    expect(usage.status).toBe(2);
    for (const step of steps) {
      expect(usage.stdout).toContain(`scripts/native-smoke.sh ${step}`);
    }
  });

  it('archives an unsigned Release build for a generic iOS device, over any stale archive', () => {
    const { root, copy } = scratchRepo();
    const argsFile = join(root, 'xcodebuild-args');
    const bin = stubs({
      xcodebuild: `printf '%s\\n' "$@" > '${argsFile}'\nexit "\${STUB_EXIT:-0}"`,
    });
    const archive = join(root, 'out', 'PlaneAhead.xcarchive');
    const derivedData = join(root, 'out', 'derived-data');
    mkdirSync(join(archive, 'stale'), { recursive: true });
    const env = {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      SMOKE_ARCHIVE_PATH: archive,
      SMOKE_DERIVED_DATA: derivedData,
      SMOKE_ARCHIVE_MIN_FREE_GB: '0',
    };

    // xcodebuild "succeeded" without writing an archive: the step refuses to pass.
    const empty = runWith(['ios-device-archive'], env, copy);
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain('the archive holds no app');
    expect(existsSync(archive)).toBe(false);
    expect(readFileSync(argsFile, 'utf8').trim().split('\n')).toEqual([
      'archive',
      '-workspace',
      'ios/PlaneAhead.xcworkspace',
      '-scheme',
      'PlaneAhead',
      '-configuration',
      'Release',
      '-destination',
      'generic/platform=iOS',
      '-archivePath',
      archive,
      '-derivedDataPath',
      derivedData,
      'CODE_SIGNING_ALLOWED=NO',
    ]);
    // A failed archive keeps xcodebuild's exit code.
    expect(runWith(['ios-device-archive'], { ...env, STUB_EXIT: '65' }, copy).status).toBe(65);

    // Without the room it needs (5 GB by default), it stops before xcodebuild, with the reason.
    rmSync(argsFile);
    const { PATH: dfPath } = stubDf(GIB);
    const cramped = runWith(
      ['ios-device-archive'],
      { ...env, PATH: `${bin}:${dfPath}`, SMOKE_ARCHIVE_MIN_FREE_GB: '' },
      copy,
    );
    expect(cramped.status).toBe(1);
    expect(cramped.stderr).toContain('only 1 GB free before the device archive');
    expect(existsSync(argsFile)).toBe(false);
  });

  /** The categories Apple lists each symbol's API under (the page cited above the table). */
  const REQUIRED_REASON_SYMBOLS = {
    NSPrivacyAccessedAPICategoryFileTimestamp: [
      '_stat',
      '_stat64',
      '_fstat',
      '_fstat64',
      '_lstat',
      '_lstat64',
      '_fstatat',
      '_fstatat64',
      '_getattrlistbulk',
      '_NSFileCreationDate',
      '_NSFileModificationDate',
      '_NSURLContentModificationDateKey',
      '_NSURLCreationDateKey',
    ],
    NSPrivacyAccessedAPICategorySystemBootTime: ['_mach_absolute_time'],
    NSPrivacyAccessedAPICategoryDiskSpace: [
      '_statfs',
      '_statfs64',
      '_statvfs',
      '_fstatfs',
      '_fstatfs64',
      '_fstatvfs',
      '_NSFileSystemFreeSize',
      '_NSFileSystemSize',
      '_NSURLVolumeAvailableCapacityKey',
      '_NSURLVolumeAvailableCapacityForImportantUsageKey',
      '_NSURLVolumeAvailableCapacityForOpportunisticUsageKey',
      '_NSURLVolumeTotalCapacityKey',
    ],
    NSPrivacyAccessedAPICategoryUserDefaults: ['_OBJC_CLASS_$_NSUserDefaults'],
  };
  const BOTH = 'NSPrivacyAccessedAPICategoryFileTimestamp NSPrivacyAccessedAPICategoryDiskSpace';

  it('maps each required-reason symbol to the categories Apple lists its API under (ruling S2)', () => {
    const expected = [
      ...Object.entries(REQUIRED_REASON_SYMBOLS).flatMap(([category, symbols]) =>
        symbols.map((symbol) => `${symbol} ${category}`),
      ),
      // getattrlist and two relatives are in the file timestamp and the disk space lists.
      ...['_getattrlist', '_fgetattrlist', '_getattrlistat'].map((symbol) => `${symbol} ${BOTH}`),
    ];
    const symbols = expected.map((line) => line.split(' ')[0]);
    expect(lines(run('undeclared-reasons', `${symbols.join('\n')}\n`).stdout).sort()).toEqual(
      expected.sort(),
    );
    // Declared, every one of them is covered.
    const all = [...Object.keys(REQUIRED_REASON_SYMBOLS)];
    expect(run(['undeclared-reasons', ...all], `${symbols.join('\n')}\n`).stdout).toBe('');
  });

  it('names what a manifest leaves undeclared, once, whatever else the executable references', () => {
    // `nm -u` of a two-architecture executable: a header per slice, symbols repeated.
    const nm = [
      '',
      '/Build/PlaneAhead.app/PlaneAhead (for architecture arm64_32):',
      '_OBJC_CLASS_$_NSUserDefaults',
      '_fstat$INODE64',
      '_objc_msgSend',
      '_status',
      '_statx_np',
      '_mach_continuous_time',
      '_NSFileSize',
      '_OBJC_CLASS_$_NSUserDefaultsController',
      '',
      '/Build/PlaneAhead.app/PlaneAhead (for architecture arm64):',
      '_OBJC_CLASS_$_NSUserDefaults',
      '_fstat',
      '',
    ].join('\n');
    expect(lines(run('undeclared-reasons', nm).stdout)).toEqual([
      '_OBJC_CLASS_$_NSUserDefaults NSPrivacyAccessedAPICategoryUserDefaults',
      '_fstat NSPrivacyAccessedAPICategoryFileTimestamp',
    ]);
    expect(
      lines(run(['undeclared-reasons', 'NSPrivacyAccessedAPICategoryUserDefaults'], nm).stdout),
    ).toEqual(['_fstat NSPrivacyAccessedAPICategoryFileTimestamp']);
    // The widget extension's case: UserDefaults referenced, UserDefaults declared.
    expect(
      run(
        ['undeclared-reasons', 'NSPrivacyAccessedAPICategoryUserDefaults'],
        '_OBJC_CLASS_$_NSUserDefaults\n_objc_msgSend\n',
      ).stdout,
    ).toBe('');
    // Either list covers getattrlist; a declared category covers nothing outside it.
    expect(
      run(['undeclared-reasons', 'NSPrivacyAccessedAPICategoryDiskSpace'], '_getattrlist\n').stdout,
    ).toBe('');
    expect(
      lines(
        run(
          ['undeclared-reasons', 'NSPrivacyAccessedAPICategoryFileTimestamp'],
          '_getattrlist\n_statfs\n',
        ).stdout,
      ),
    ).toEqual(['_statfs NSPrivacyAccessedAPICategoryDiskSpace']);
    expect(run('undeclared-reasons', '').stdout).toBe('');
    // An x86_64 slice names the 64-bit-inode variant, which is the same API.
    expect(run('undeclared-reasons', '_stat$INODE64\n').stdout).toBe(
      '_stat NSPrivacyAccessedAPICategoryFileTimestamp\n',
    );
  });

  /** `llvm-readelf -lW` of a shared library whose LOAD segments have these alignments. */
  function programHeaders(...aligns) {
    return [
      '',
      'Elf file type is DYN (Shared object file)',
      'Entry point 0x0',
      'There are 9 program headers, starting at offset 64',
      '',
      'Program Headers:',
      '  Type           Offset   VirtAddr           PhysAddr           FileSiz  MemSiz   Flg Align',
      '  PHDR           0x000040 0x0000000000000040 0x0000000000000040 0x0001f8 0x0001f8 R   0x8',
      ...aligns.map(
        (align, index) =>
          `  LOAD           0x0${index}0000 0x00000000000${index}0000 0x00000000000${index}0000 0x001000 0x001000 ${index === 0 ? 'R  ' : 'R E'} ${align}`,
      ),
      '  GNU_STACK      0x000000 0x0000000000000000 0x0000000000000000 0x000000 0x000000 RW  0x0',
      '',
    ].join('\n');
  }

  it('flags each LOAD segment aligned below 16 KB, and output that has none (ruling S5)', () => {
    expect(run('elf-load-misaligned', programHeaders('0x4000', '0x4000')).stdout).toBe('');
    expect(run('elf-load-misaligned', programHeaders('0x10000', '0x4000')).stdout).toBe('');
    expect(
      lines(run('elf-load-misaligned', programHeaders('0x4000', '0x1000', '0x2000')).stdout),
    ).toEqual([
      '  LOAD           0x010000 0x0000000000010000 0x0000000000010000 0x001000 0x001000 R E 0x1000',
      '  LOAD           0x020000 0x0000000000020000 0x0000000000020000 0x001000 0x001000 R E 0x2000',
    ]);
    // An alignment that is not a hex number is not taken for a large one.
    expect(
      lines(run('elf-load-misaligned', programHeaders('0x4000', 'bogus')).stdout),
    ).toHaveLength(1);
    // Nothing readable is not a pass.
    expect(
      lines(run('elf-load-misaligned', 'llvm-readelf: error: not an ELF file\n').stdout),
    ).toEqual(['no LOAD segment']);
  });

  /** A zip archive of stored (uncompressed) entries, which is what unzip needs to read an APK. */
  function storedZip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const [name, text] of Object.entries(entries)) {
      const nameBytes = Buffer.from(name);
      const data = Buffer.from(text);
      const checksum = crc32(data);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt32LE(checksum, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBytes.length, 26);
      locals.push(local, nameBytes, data);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt32LE(checksum, 16);
      central.writeUInt32LE(data.length, 20);
      central.writeUInt32LE(data.length, 24);
      central.writeUInt16LE(nameBytes.length, 28);
      central.writeUInt32LE(offset, 42);
      centrals.push(central, nameBytes);
      offset += local.length + nameBytes.length + data.length;
    }
    const directory = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Object.keys(entries).length, 8);
    end.writeUInt16LE(Object.keys(entries).length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, directory, end]);
  }

  it('checks an APK for 16 KB pages: zipalign, then every 64-bit library (ruling S5)', () => {
    const { root, copy } = scratchRepo();
    // An SDK whose newest build-tools' zipalign records its arguments, an older one that must not
    // be used, and an NDK whose llvm-readelf prints the "library", which holds its own headers.
    const sdk = join(root, 'sdk');
    const zipalignArgs = join(root, 'zipalign-args');
    for (const [version, body] of [
      ['35.0.0', 'exit 42'],
      [
        '36.1.0',
        `printf '%s\\n' "$@" > '${zipalignArgs}'\necho 'Verification FAILED' \nexit "\${ZIPALIGN_EXIT:-0}"`,
      ],
    ]) {
      mkdirSync(join(sdk, 'build-tools', version), { recursive: true });
      writeFileSync(join(sdk, 'build-tools', version, 'zipalign'), `#!/bin/sh\n${body}\n`, {
        mode: 0o755,
      });
    }
    const readelf = join(
      sdk,
      'ndk',
      '27.1.12297006',
      'toolchains',
      'llvm',
      'prebuilt',
      'linux-x86_64',
      'bin',
    );
    mkdirSync(readelf, { recursive: true });
    writeFileSync(
      join(readelf, 'llvm-readelf'),
      '#!/bin/sh\n[ "$1" = -lW ] || exit 3\ncase "$2" in *broken*) exit 1 ;; esac\ncat "$2"\n',
      { mode: 0o755 },
    );
    const apk = (name, entries) => {
      const file = join(root, `${name}.apk`);
      writeFileSync(file, storedZip({ 'classes.dex': 'dex', ...entries }));
      return file;
    };
    const check = (file, env = {}) =>
      runWith(['page-alignment', file], { ANDROID_HOME: sdk, ...env }, copy);

    const aligned = apk('aligned', {
      'lib/x86_64/libhermes.so': programHeaders('0x4000', '0x4000'),
      'lib/arm64-v8a/libhermes.so': programHeaders('0x10000'),
      // 32-bit libraries are exempt, however they are aligned.
      'lib/armeabi-v7a/libhermes.so': programHeaders('0x1000'),
    });
    const passed = check(aligned);
    expect(passed.status).toBe(0);
    expect(passed.stdout).toContain('all 2 64-bit libraries');
    expect(readFileSync(zipalignArgs, 'utf8').trim().split('\n')).toEqual([
      '-c',
      '-P',
      '16',
      '-v',
      '4',
      aligned,
    ]);

    const zipFailed = check(aligned, { ZIPALIGN_EXIT: '1' });
    expect(zipFailed.status).toBe(1);
    expect(zipFailed.stderr).toContain('Verification FAILED');
    expect(zipFailed.stderr).toContain('is not aligned for 16 KB pages');

    const misaligned = check(
      apk('misaligned', {
        'lib/x86_64/libgood.so': programHeaders('0x4000'),
        'lib/x86_64/libplanted.so': programHeaders('0x4000', '0x1000'),
      }),
    );
    expect(misaligned.status).toBe(1);
    expect(misaligned.stderr).toContain('lib/x86_64/libplanted.so:');
    expect(misaligned.stderr).toMatch(
      /aligned below 16 KB \(0x4000\): lib\/x86_64\/libplanted\.so$/m,
    );
    expect(misaligned.stderr).not.toContain('libgood.so');

    for (const [name, entries, message] of [
      [
        'thirty-two',
        { 'lib/armeabi-v7a/libold.so': programHeaders('0x1000') },
        'carries no 64-bit native library',
      ],
      // A 64-bit library directory with no shared library in it has nothing aligned either.
      ['nolibs', { 'lib/x86_64/gdb.setup': 'x' }, 'carries no 64-bit native library'],
      ['javaonly', {}, 'unzip found no native library in'],
      [
        'unreadable',
        { 'lib/arm64-v8a/libbroken.so': 'x' },
        'llvm-readelf could not read lib/arm64-v8a/libbroken.so',
      ],
    ]) {
      const result = check(apk(name, entries));
      expect(result.status, name).toBe(1);
      expect(result.stderr, name).toContain(message);
    }
    expect(check(join(root, 'missing.apk')).stderr).toContain("no APK at '");
  });
});
