/**
 * Every workflow's job keys are unique, and the scheduled native-smoke workflow keeps its shape
 * (increment 11, ruling V7, ADR 0008; increment 13 and its review round, rulings F1 to F13).
 *
 * A duplicate job key is a YAML mapping with the same key twice: most parsers keep the last one
 * silently, and GitHub rejects the whole file without running anything. It happened once
 * (increment 9's merge left two `vitest-exit-guard` jobs in ci.yml, removed in #9), so it is
 * checked for every file here rather than by eye.
 *
 * Text based, like migration-hash-check.test.js: the repository has no YAML parser at the root,
 * and a job is a key at two spaces of indentation under `jobs:`. The workflow's expressions are
 * evaluated (`evaluate` below), so what a scheduled or a manual run does is tested, not spelled.
 *
 * scripts/native-smoke.sh is tested by running it: its classifiers on stdin, and its steps in a
 * scratch repository with stand-ins for the tools they call. The Apple ones (plutil, PlistBuddy,
 * nm, vtool) are apple-tools-stub.mjs, so the iOS checks run on the Linux runner too; the cases
 * that need Apple's own tools or a real Mach-O binary run on macOS only (`onMac`).
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { crc32 } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { fakeExecutable, parsePlist, plistXml } from './apple-tools-stub.mjs';

const repoRoot = join(import.meta.dirname, '..', '..');
const workflowsDir = join(repoRoot, '.github', 'workflows');
/** Apple's own plutil, PlistBuddy, nm and clang exist on macOS only. */
const onMac = process.platform === 'darwin';

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

/** The steps of a job's block, each with its lines. */
function stepsOf(block) {
  const steps = [];
  for (const line of block.split('\n')) {
    if (/^ {6}- /.test(line)) {
      steps.push([line]);
    } else if (steps.length > 0 && /^ {8}/.test(line)) {
      steps.at(-1).push(line);
    }
  }
  return steps.map((lines) => lines.join('\n'));
}

/** The one step of `block` that runs `native-smoke.sh <step>`. */
function smokeStep(block, step) {
  const found = stepsOf(block).filter((lines) =>
    new RegExp(`run: scripts/native-smoke\\.sh ${step}$`, 'm').test(lines),
  );
  expect(found, step).toHaveLength(1);
  return found[0];
}

/**
 * Evaluates a GitHub Actions expression (`${{ }}` or bare, as `if:` allows) for what this
 * workflow uses: single-quoted literals, `==`, `!=`, `&&`, `||`, `!`, property access, fromJSON
 * and the status functions. JavaScript's operators agree with GitHub's on these operands: strings,
 * booleans and a scheduled run's missing input (null to GitHub, undefined here; both falsy, and
 * unequal to every string).
 */
function evaluate(expression, context) {
  const source = expression.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, '$1');
  const js = source.replace(/'((?:[^']|'')*)'/g, (_, text) =>
    JSON.stringify(text.replaceAll("''", "'")),
  );
  return new Function('context', `with (context) { return (${js}); }`)(context);
}

/**
 * Whether a step with this `if:` runs: GitHub puts `success() &&` in front of a condition that
 * calls no status function, so such a step never runs after a failed one.
 */
function stepRuns(condition, context) {
  const expression = condition.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, '$1');
  const full = /\b(?:success|failure|always|cancelled)\(\)/.test(expression)
    ? expression
    : `success() && (${expression})`;
  return Boolean(evaluate(full, context));
}

/** The context of one run: a scheduled one by default; `failed` means an earlier step failed. */
function runContext({
  event = 'schedule',
  inputs = {},
  xcode = '26.6',
  prebuild = 'success',
  failed = false,
  cancelled = false,
} = {}) {
  return {
    github: { event_name: event },
    inputs,
    matrix: { xcode },
    steps: { prebuild: { outcome: prebuild } },
    fromJSON: JSON.parse,
    cancelled: () => cancelled,
    failure: () => failed,
    success: () => !failed && !cancelled,
    always: () => true,
  };
}

const dispatch = (inputs) => ({
  event: 'workflow_dispatch',
  inputs: { platforms: 'all', release_check: false, ...inputs },
});

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
  const ios = jobBlock(text, 'ios');
  const android = jobBlock(text, 'android');
  const xcodeMatrix = /^ {8}xcode: (\$\{\{.+\}\})$/m.exec(ios)?.[1] ?? '';
  const archiveCondition = /^ {8}if: (.+)$/m.exec(smokeStep(ios, 'ios-device-archive'))?.[1];
  const legs = (context) => evaluate(xcodeMatrix, runContext(context));
  const archives = (context) => stepRuns(archiveCondition ?? 'false', runContext(context));
  const androidEnv = (name, context) =>
    evaluate(
      new RegExp(`^ {6}${name}: (.+)$`, 'm').exec(android)?.[1] ?? "''",
      runContext(context),
    );

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
    for (const job of [ios, android]) {
      expect(job).toMatch(/^ {4}timeout-minutes: \d+$/m);
    }
    expect(code).toMatch(/^concurrency:\n {2}group: .+\n {2}cancel-in-progress: true$/m);
    // A release check's archive comes on top of a build that took 14 minutes on the runner.
    expect(Number(/^ {4}timeout-minutes: (\d+)$/m.exec(ios)?.[1])).toBeGreaterThanOrEqual(60);
  });

  it('gates on Xcode 26.6 on macos-26, with the Xcode 27 leg on manual runs only (ruling F1)', () => {
    expect(ios).toMatch(/^ {4}runs-on: macos-26$/m);
    expect(legs()).toEqual(['26.6']);
    expect(legs(dispatch())).toEqual(['26.6', '27']);
    expect(legs(dispatch({ platforms: 'ios', release_check: true }))).toEqual(['26.6', '27']);
    // Only the Xcode 27 leg may fail without failing the run.
    const lenient = /^ {4}continue-on-error: (.+)$/m.exec(ios)?.[1] ?? 'false';
    expect(evaluate(lenient, runContext({ xcode: '27' }))).toBe(true);
    expect(evaluate(lenient, runContext({ xcode: '26.6' }))).toBe(false);
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
    // The pinned Xcode is the leg every run has and the leg that must pass.
    for (const context of [{}, dispatch(), dispatch({ release_check: true })]) {
      expect(legs(context)).toContain(xcode);
    }
    const lenient = /^ {4}continue-on-error: (.+)$/m.exec(ios)?.[1] ?? 'true';
    expect(evaluate(lenient, runContext({ xcode }))).toBe(false);
    // And the leg the device archive runs on.
    expect(archives({ ...dispatch({ release_check: true }), xcode })).toBe(true);
  });

  it('archives for a device on a release check only, on the gate leg only (rulings F1, F8)', () => {
    const input = /^ {6}release_check:\n((?: {8}.*\n)+)/m.exec(code)?.[1] ?? '';
    expect(input).toMatch(/^ {8}type: boolean$/m);
    expect(input).toMatch(/^ {8}default: false$/m);
    expect(smokeStep(ios, 'ios-prebuild')).toMatch(/^ {8}id: prebuild$/m);
    const release = dispatch({ release_check: true });
    // The weekly run never archives; a manual run archives only when asked to.
    expect(archives({ xcode: '26.6' })).toBe(false);
    expect(archives({ ...dispatch(), xcode: '26.6' })).toBe(false);
    expect(archives({ ...release, xcode: '26.6' })).toBe(true);
    expect(archives({ ...release, xcode: '27' })).toBe(false);
    // After a failed build or launch too, never after a failed prebuild or a cancellation.
    expect(archives({ ...release, xcode: '26.6', failed: true })).toBe(true);
    expect(archives({ ...release, xcode: '26.6', failed: true, prebuild: 'failure' })).toBe(false);
    expect(archives({ ...release, xcode: '26.6', prebuild: 'failure' })).toBe(false);
    expect(archives({ ...release, xcode: '26.6', prebuild: 'skipped' })).toBe(false);
    expect(archives({ ...release, xcode: '26.6', cancelled: true })).toBe(false);
    const launch = stepsOf(ios).findIndex((step) => step.includes('native-smoke.sh ios-launch'));
    const archive = stepsOf(ios).findIndex((step) => step.includes('ios-device-archive'));
    expect(archive).toBe(launch + 1);
  });

  it('proves 16 KB pages on x86_64 weekly and on arm64-v8a too on a release check (F1, F4)', () => {
    const release = dispatch({ release_check: true });
    expect(androidEnv('SMOKE_ANDROID_ABIS', {})).toBe('x86_64');
    expect(androidEnv('SMOKE_ANDROID_ABIS', dispatch())).toBe('x86_64');
    expect(androidEnv('SMOKE_ANDROID_ABIS', release)).toBe('arm64-v8a,x86_64');
    // The emulator's ABI is always built; each run keeps the room its ABIs need, above the
    // script's own default (10 GB and 5 an ABI), for the NDK and the emulator image after it.
    const arch = /^ {10}arch: (\S+)$/m.exec(android)?.[1];
    for (const context of [{}, dispatch(), release]) {
      const abis = androidEnv('SMOKE_ANDROID_ABIS', context).split(',');
      expect(abis).toContain(arch);
      expect(Number(androidEnv('SMOKE_BUILD_MIN_FREE_GB', context))).toBeGreaterThan(
        10 + 5 * abis.length,
      );
    }
    expect(Number(androidEnv('SMOKE_BUILD_MIN_FREE_GB', release))).toBeGreaterThan(
      Number(androidEnv('SMOKE_BUILD_MIN_FREE_GB', {})),
    );
    // The step says which ABIs it proved.
    expect(smokeStep(android, 'android-archive')).toMatch(
      /^ {6}- name: .*16 KB pages on x86_64 \(and arm64-v8a on a release check\)$/m,
    );
  });

  it('lets no step fail quietly and has no condition beyond the platform and archive ones (F9)', () => {
    expect([...code.matchAll(/^( *)continue-on-error: (.+)$/gm)].map((m) => m.slice(1))).toEqual([
      ['    ', "${{ matrix.xcode == '27' }}"],
    ]);
    expect([...code.matchAll(/^( *)if: (.+)$/gm)].map((m) => m.slice(1))).toEqual([
      ['    ', "inputs.platforms != 'android'"],
      ['        ', archiveCondition],
      ['    ', "inputs.platforms != 'ios'"],
    ]);
    expect(archiveCondition).toBe(
      "${{ !cancelled() && steps.prebuild.outcome == 'success' && inputs.release_check && matrix.xcode == '26.6' }}",
    );
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
    expect(script).toContain("grep -cx 'assets/index.android.bundle'");
    const launch = script.slice(script.indexOf('android_launch() {'));
    expect(launch).toMatch(/adb install -r "\$APK_RELEASE"/);
    expect(launch).not.toMatch(/app-debug\.apk|\$APK_DEBUG/);
    expect(launch).toContain('| logcat_errors)');
  });

  it('lets a manual run pick one platform, while a scheduled run runs both', () => {
    const on = /^on:\n((?: .*\n|\n)*?)(?=^\S)/m.exec(code)?.[1] ?? '';
    expect(on).toMatch(/^ {6}platforms:\n(?: {8}.*\n)*? {8}options: \[all, ios, android\]\n/m);
    expect(on).toMatch(/^ {8}default: all$/m);
    const runs = (job, context) =>
      Boolean(evaluate(/^ {4}if: (.+)$/m.exec(job)?.[1] ?? 'false', runContext(context)));
    // A scheduled run has no inputs, so `inputs.platforms` is empty and neither job is skipped.
    for (const job of [ios, android]) {
      expect(runs(job, {})).toBe(true);
      expect(runs(job, dispatch())).toBe(true);
    }
    expect(runs(ios, dispatch({ platforms: 'android' }))).toBe(false);
    expect(runs(android, dispatch({ platforms: 'ios' }))).toBe(false);
    // One concurrency group per platform choice: a one-platform run never cancels the other's
    // (review ruling F13; the runbook notes that it duplicates the weekly run's legs).
    const group = /^ {2}group: (.+)$/m.exec(code)?.[1] ?? '';
    const groupOf = (context) =>
      group.replace(/\$\{\{(.+?)\}\}/g, (_, expression) =>
        String(
          evaluate(expression, { ...runContext(context), github: { ref: 'refs/heads/main' } }),
        ),
      );
    expect(groupOf({})).toBe('native-smoke-refs/heads/main-all');
    expect(groupOf(dispatch({ release_check: true }))).toBe('native-smoke-refs/heads/main-all');
    expect(groupOf(dispatch({ platforms: 'ios' }))).toBe('native-smoke-refs/heads/main-ios');
  });

  it('selects Xcode before the checkout, so a missing Xcode fails in seconds', () => {
    const select = ios.indexOf('- name: Select Xcode');
    expect(select).toBeGreaterThan(-1);
    expect(select).toBeLessThan(ios.indexOf('actions/checkout'));
    expect(ios.slice(0, select)).not.toMatch(/^ {6}- /m);
  });

  it('frees only unused toolchains before the Android build, and checks before the emulator', () => {
    expect(android).toMatch(/^ {10}arch: x86_64$/m);
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

const scratch = [];

afterAll(() => {
  for (const dir of scratch) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A new scratch directory, removed after the tests; `name` shows in its path. */
function scratchDir(name) {
  const dir = mkdtempSync(join(tmpdir(), `smoke-${name}-`));
  scratch.push(dir);
  return dir;
}

const scriptPath = join(repoRoot, 'scripts', 'native-smoke.sh');
const script = readFileSync(scriptPath, 'utf8');

/** Runs the script with `args` (a step, or a step and its arguments) and `input` on stdin. */
function run(args, input) {
  const argv = Array.isArray(args) ? args : [args];
  const result = spawnSync('bash', [scriptPath, ...argv], { input, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runWith(args, env = {}, file = scriptPath) {
  const result = spawnSync('bash', [file, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** runWith, without blocking: the store-check cases start many runs at once. */
function runAsync(args, env = {}, file = scriptPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [file, ...args], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const lines = (output) => output.split('\n').filter((line) => line !== '');

/** A copy of the script in a scratch repository with an empty app, so no step reaches the real one. */
function scratchRepo(name = 'repo') {
  const root = scratchDir(name);
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'apps', 'mobile', 'android'), { recursive: true });
  const copy = join(root, 'scripts', 'native-smoke.sh');
  writeFileSync(copy, script);
  return { root, copy };
}

/** A directory of executable stubs, each `name: body` a shell script, to put first on PATH. */
function stubs(bodies) {
  const dir = scratchDir('bin');
  for (const [name, body] of Object.entries(bodies)) {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  return dir;
}

/** Writes `files` (a path, relative to `root`, to its contents; null writes nothing) under root. */
function writeTree(root, files) {
  for (const [path, contents] of Object.entries(files)) {
    if (contents !== null) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), contents);
    }
  }
}

/**
 * The environment that puts apple-tools-stub.mjs in place of plutil, nm and vtool (on PATH) and of
 * PlistBuddy (SMOKE_PLISTBUDDY); `only` limits it to some of them, the rest being Apple's own.
 */
function appleTools(only = ['plutil', 'PlistBuddy', 'nm', 'vtool'], path = process.env.PATH) {
  const stub = join(import.meta.dirname, 'apple-tools-stub.mjs');
  const bin = stubs(
    Object.fromEntries(
      only.map((tool) => [tool, `exec '${process.execPath}' '${stub}' ${tool} "$@"`]),
    ),
  );
  return {
    PATH: `${bin}:${path ?? ''}`,
    ...(only.includes('PlistBuddy') ? { SMOKE_PLISTBUDDY: join(bin, 'PlistBuddy') } : {}),
  };
}

/** A `df` first on PATH that reports `availableKb` free, in the POSIX layout. */
function stubDf(availableKb) {
  const line = `/dev/root 76026616 1 ${String(availableKb)} 79%% /`;
  const dir = stubs({
    df: `printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n${line}\\n'`,
  });
  return { PATH: `${dir}:${process.env.PATH ?? ''}` };
}

const GIB = 1048576;

describe('native-smoke.sh classifiers', () => {
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
    const { root, copy } = scratchRepo();
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
    expect(build({ ...plenty, SMOKE_ANDROID_ABIS: 'arm64-v8a,x86_64' }).status).toBe(0);
    expect(gradleArgs()).toContain('-PreactNativeArchitectures=arm64-v8a,x86_64');
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
    const expected = expectedPermissions();
    expect(expected).toContain('android.permission.INTERNET');
    expect(expected).toContain('app.planeahead.mobile.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION');
    expect(expected).not.toContain('android.permission.FOREGROUND_SERVICE');
    // `permissions-differ` succeeds (exit 0) only when the lists differ.
    expect(run('permissions-differ', permissionDump([...expected].reverse())).status).toBe(1);
    expect(
      run(
        'permissions-differ',
        permissionDump([...expected, 'android.permission.FOREGROUND_SERVICE']),
      ).status,
    ).toBe(0);
    expect(run('permissions-differ', permissionDump(expected.slice(1))).status).toBe(0);
    // A permission a dependency declares as <uses-permission-sdk-23> is as real as a plain one
    // on every device the app supports (minSdk 24); aapt2 prints it on its own line.
    const sdk23 =
      permissionDump(expected) +
      "uses-permission-sdk-23: name='android.permission.ACCESS_FINE_LOCATION'\n";
    expect(run('permissions-differ', sdk23).status).toBe(0);
    expect(run('permissions-differ', sdk23).stderr).toContain('ACCESS_FINE_LOCATION');
  });

  it('runs every step the workflow names, and prints its usage for anything else', () => {
    const workflow = readFileSync(join(workflowsDir, 'native-smoke.yml'), 'utf8');
    const steps = workflowSteps(workflow);
    expect(steps).toContain('ios-device-archive');
    // Every tool a step starts with fails at once, so each step stops at its first command:
    // anything but the usage's exit code 2 means the script dispatched the step.
    const failing = stubs(
      Object.fromEntries(
        ['xcodebuild', 'xcrun', 'pnpm', 'adb', 'plutil', 'nm', 'vtool', 'PlistBuddy'].map(
          (tool) => [tool, 'exit 97'],
        ),
      ),
    );
    const { root, copy } = scratchRepo();
    // Every path a step writes or removes points into the scratch repository, whatever the
    // caller's environment says.
    const env = {
      PATH: `${failing}:${process.env.PATH ?? ''}`,
      SMOKE_PLISTBUDDY: join(failing, 'PlistBuddy'),
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

  /**
   * The table REQUIRED_REASON_SYMBOLS must be, in its order (review ruling F10): Apple's
   * required-reason APIs by category (the page the script cites), the getattrlist family under
   * both of the categories Apple lists it in, and SwiftUI's @AppStorage by the prefix of its
   * mangled members (ruling F11).
   */
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
      '_getattrlist',
      '_fgetattrlist',
      '_getattrlistat',
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
      '_getattrlist',
      '_fgetattrlist',
      '_getattrlistat',
      '_NSFileSystemFreeSize',
      '_NSFileSystemSize',
      '_NSURLVolumeAvailableCapacityKey',
      '_NSURLVolumeAvailableCapacityForImportantUsageKey',
      '_NSURLVolumeAvailableCapacityForOpportunisticUsageKey',
      '_NSURLVolumeTotalCapacityKey',
    ],
    NSPrivacyAccessedAPICategoryUserDefaults: [
      '_OBJC_CLASS_$_NSUserDefaults',
      '_$s7SwiftUI10AppStorageV*',
    ],
  };

  it("holds the script's required-reason table to exactly this one (review ruling F10)", () => {
    const body = /^REQUIRED_REASON_SYMBOLS=\(\n([\s\S]*?)\n\)$/m.exec(script)?.[1] ?? '';
    const parsed = Object.fromEntries(
      [...body.matchAll(/'([^']*)'/g)].map(([, entry]) => {
        const [category, ...symbols] = entry.split(/\s+/).filter(Boolean);
        return [category, symbols];
      }),
    );
    expect(parsed).toEqual(REQUIRED_REASON_SYMBOLS);
  });

  it('maps each required-reason symbol to the categories Apple lists its API under (ruling S2)', () => {
    // One symbol for each entry (a member of the prefix for a prefix entry), then its categories.
    const categories = new Map();
    for (const [category, symbols] of Object.entries(REQUIRED_REASON_SYMBOLS)) {
      for (const entry of symbols) {
        const symbol = entry.endsWith('*') ? `${entry.slice(0, -1)}12wrappedValuexvg` : entry;
        categories.set(symbol, [...(categories.get(symbol) ?? []), category]);
      }
    }
    const input = `${[...categories.keys()].join('\n')}\n`;
    expect(lines(run('undeclared-reasons', input).stdout).sort()).toEqual(
      [...categories].map(([symbol, names]) => `${symbol} ${names.join(' ')}`).sort(),
    );
    // Declared, every one of them is covered.
    const all = Object.keys(REQUIRED_REASON_SYMBOLS);
    expect(run(['undeclared-reasons', ...all], input).stdout).toBe('');
  });

  it('names what a manifest leaves undeclared, once, whatever else the executable references', () => {
    // `nm -u -j -arch all` of a two-architecture executable: a header per slice, repeats.
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
      '_$s7SwiftUI10AppStorag',
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
    // @AppStorage is UserDefaults however many of its members the executable uses (ruling F11).
    const appStorage = [
      '_$s7SwiftUI10AppStorageV12wrappedValuexvg',
      '_$s7SwiftUI10AppStorageV12wrappedValuexvs',
      '_$s7SwiftUI10AppStorageVMn',
      '',
    ].join('\n');
    expect(run('undeclared-reasons', appStorage).stdout).toBe(
      '_$s7SwiftUI10AppStorageV12wrappedValuexvg NSPrivacyAccessedAPICategoryUserDefaults\n',
    );
    expect(
      run(['undeclared-reasons', 'NSPrivacyAccessedAPICategoryUserDefaults'], appStorage).stdout,
    ).toBe('');
  });

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

  it('checks an APK for 16 KB pages: zipalign, then every 64-bit library (ruling S5)', () => {
    const { root, copy } = scratchRepo();
    const sdk = androidSdk(root);
    const apk = (name, entries) => {
      const file = join(root, `${name}.apk`);
      writeFileSync(file, storedZip({ 'classes.dex': 'dex', ...entries }));
      return file;
    };
    const check = (file, env = {}) =>
      runWith(
        ['page-alignment', file],
        { ANDROID_HOME: sdk.home, SMOKE_ANDROID_ABIS: 'arm64-v8a,x86_64', ...env },
        copy,
      );

    const aligned = apk('aligned', {
      'lib/x86_64/libhermes.so': programHeaders('0x4000', '0x4000'),
      'lib/arm64-v8a/libhermes.so': programHeaders('0x10000'),
      // 32-bit libraries are exempt, however they are aligned.
      'lib/armeabi-v7a/libhermes.so': programHeaders('0x1000'),
    });
    const passed = check(aligned);
    expect(passed.status).toBe(0);
    expect(passed.stdout).toContain('all 2 64-bit libraries (arm64-v8a x86_64)');
    // The newest build-tools' zipalign, and the newest NDK's llvm-readelf (the older ones fail).
    expect(readFileSync(sdk.zipalignArgs, 'utf8').trim().split('\n')).toEqual([
      '-c',
      '-P',
      '16',
      '-v',
      '4',
      aligned,
    ]);
    // Every ABI of a build of every ABI (SMOKE_ANDROID_ABIS unset) is there too.
    expect(check(aligned, { SMOKE_ANDROID_ABIS: '' }).status).toBe(0);

    const zipFailed = check(aligned, { ZIPALIGN_EXIT: '1' });
    expect(zipFailed.status).toBe(1);
    expect(zipFailed.stderr).toContain('Verification FAILED');
    expect(zipFailed.stderr).toContain('is not aligned for 16 KB pages');

    const misaligned = check(
      apk('misaligned', {
        'lib/x86_64/libgood.so': programHeaders('0x4000'),
        'lib/x86_64/libplanted.so': programHeaders('0x4000', '0x1000'),
      }),
      { SMOKE_ANDROID_ABIS: 'x86_64' },
    );
    expect(misaligned.status).toBe(1);
    expect(misaligned.stderr).toContain('lib/x86_64/libplanted.so:');
    expect(misaligned.stderr).toMatch(
      /aligned below 16 KB \(0x4000\): lib\/x86_64\/libplanted\.so$/m,
    );
    expect(misaligned.stderr).not.toContain('libgood.so');

    // The weekly x86_64 build passes without arm64-v8a; a release check's build does not
    // (review ruling F4), nor a build of every ABI.
    const x86Only = apk('x86only', { 'lib/x86_64/libhermes.so': programHeaders('0x4000') });
    expect(check(x86Only, { SMOKE_ANDROID_ABIS: 'x86_64' }).status).toBe(0);
    for (const abis of ['arm64-v8a,x86_64', '']) {
      const missing = check(x86Only, { SMOKE_ANDROID_ABIS: abis });
      expect(missing.status, abis).toBe(1);
      expect(missing.stderr, abis).toContain(
        'carries no arm64-v8a library, although the build was asked for arm64-v8a',
      );
    }

    for (const [name, entries, message, abis] of [
      [
        'thirty-two',
        { 'lib/armeabi-v7a/libold.so': programHeaders('0x1000') },
        'carries no 64-bit native library',
        'armeabi-v7a',
      ],
      // A 64-bit library directory with no shared library in it has nothing aligned either.
      ['nolibs', { 'lib/x86_64/gdb.setup': 'x' }, 'carries no 64-bit native library', 'x86_64'],
      ['javaonly', {}, 'unzip found no native library in', 'x86_64'],
      [
        'unreadable',
        { 'lib/arm64-v8a/libbroken.so': 'x' },
        'llvm-readelf could not read lib/arm64-v8a/libbroken.so',
        'arm64-v8a',
      ],
    ]) {
      const result = check(apk(name, entries), { SMOKE_ANDROID_ABIS: abis });
      expect(result.status, name).toBe(1);
      expect(result.stderr, name).toContain(message);
    }
    expect(check(join(root, 'missing.apk')).stderr).toContain("no APK at '");
  }, 120_000);
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

/**
 * An Android SDK under `root`: two build-tools, the newest one's zipalign recording its arguments
 * (and exiting ZIPALIGN_EXIT) and its aapt2 answering from APP_PERMISSIONS, the older one's tools
 * failing; two NDKs, the newest one's llvm-readelf printing the "library", which holds its own
 * program headers, the older one's failing.
 */
function androidSdk(root) {
  const home = join(root, 'sdk');
  const zipalignArgs = join(root, 'zipalign-args');
  const tools = {
    '35.0.0': { zipalign: 'exit 42', aapt2: 'exit 42' },
    '36.1.0': {
      zipalign: `printf '%s\\n' "$@" > '${zipalignArgs}'\necho 'Verification FAILED' \nexit "\${ZIPALIGN_EXIT:-0}"`,
      aapt2: [
        'case "$1 $2" in',
        "  'dump xmltree') echo 'E: manifest (line=2)' ;;",
        '  \'dump permissions\') cat "$APP_PERMISSIONS" ;;',
        '  *) exit 3 ;;',
        'esac',
      ].join('\n'),
    },
  };
  for (const [version, bodies] of Object.entries(tools)) {
    for (const [tool, body] of Object.entries(bodies)) {
      mkdirSync(join(home, 'build-tools', version), { recursive: true });
      writeFileSync(join(home, 'build-tools', version, tool), `#!/bin/sh\n${body}\n`, {
        mode: 0o755,
      });
    }
  }
  for (const [version, body] of [
    ['26.3.11579264', 'exit 42'],
    ['27.1.12297006', '[ "$1" = -lW ] || exit 3\ncase "$2" in *broken*) exit 1 ;; esac\ncat "$2"'],
  ]) {
    const bin = join(home, 'ndk', version, 'toolchains', 'llvm', 'prebuilt', 'linux-x86_64', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'llvm-readelf'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  return { home, zipalignArgs };
}

/** EXPECTED_ANDROID_PERMISSIONS as the script lists it. */
function expectedPermissions() {
  const list = /^EXPECTED_ANDROID_PERMISSIONS=\(\n((?: {2}.+\n)+)\)$/m.exec(script)?.[1] ?? '';
  return list
    .trim()
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .map((line) =>
      line
        .trim()
        .replace(/^"\$BUNDLE_ID/, 'app.planeahead.mobile')
        .replace(/"$/, ''),
    );
}

/** `aapt2 dump permissions` of a release APK declaring `names`. */
function permissionDump(names) {
  return (
    [
      "package: name='app.planeahead.mobile'",
      ...names.map((name) => `uses-permission: name='${name}'`),
    ].join('\n') + '\n'
  );
}

const VERSION = '0.1.0';
/** The build number ios-prebuild gives the app, as EAS would (review ruling F6). */
const BUILD = '4242';
const FILE_TIMESTAMP = 'NSPrivacyAccessedAPICategoryFileTimestamp';
const DISK_SPACE = 'NSPrivacyAccessedAPICategoryDiskSpace';
const USER_DEFAULTS = 'NSPrivacyAccessedAPICategoryUserDefaults';
const WIDGETS = 'PlugIns/ExpoWidgetsTarget.appex';
const WATCH = 'Watch/PlaneAheadWatch.app';
const WATCH_WIDGET = `${WATCH}/PlugIns/PlaneAheadWatchWidget.appex`;

/** A bundle's Info.plist with the app's version and build number, unless `extra` says otherwise. */
function info(executable, extra = {}) {
  return plistXml({
    CFBundleExecutable: executable,
    CFBundleShortVersionString: VERSION,
    CFBundleVersion: BUILD,
    ...extra,
  });
}

/** A privacy manifest declaring each `[category, ...reasons]`. */
function manifest(...declared) {
  return plistXml({
    NSPrivacyAccessedAPITypes: declared.map(([category, ...reasons]) => ({
      NSPrivacyAccessedAPIType: category,
      NSPrivacyAccessedAPITypeReasons: reasons,
    })),
    NSPrivacyCollectedDataTypes: [],
    NSPrivacyTracking: false,
    NSPrivacyTrackingDomains: [],
  });
}

/**
 * The files of an app a store would take, laid out as Xcode builds it, by path under
 * PlaneAhead.app: the app, the widget extension, the watch app and its complication (both
 * universal, as the watchOS device slices are), and three frameworks: React Native's prebuilt
 * core (required-reason APIs, no manifest, allowed), one with no such API and one that declares
 * its own. `simulator` gives the platforms a simulator build has.
 */
function storeApp({ simulator = false } = {}) {
  const ios = simulator ? 'IOSSIMULATOR' : 'IOS';
  const watchos = simulator ? 'WATCHOSSIMULATOR' : 'WATCHOS';
  const watch = (symbols) => ({ arm64: symbols, arm64_32: symbols });
  return {
    'Info.plist': info('PlaneAhead', { CFBundleIdentifier: 'app.planeahead.mobile' }),
    'PrivacyInfo.xcprivacy': manifest(
      [USER_DEFAULTS, 'CA92.1', '1C8F.1'],
      [FILE_TIMESTAMP, 'C617.1'],
    ),
    PlaneAhead: fakeExecutable(ios, ['_objc_msgSend', '_OBJC_CLASS_$_NSUserDefaults', '_stat']),
    [`${WIDGETS}/Info.plist`]: info('ExpoWidgetsTarget', {
      CFBundleIdentifier: 'app.planeahead.mobile.widgets',
      ExpoWidgetsAppGroupIdentifier: 'group.app.planeahead.mobile',
    }),
    [`${WIDGETS}/PrivacyInfo.xcprivacy`]: manifest([USER_DEFAULTS, '1C8F.1']),
    [`${WIDGETS}/ExpoWidgetsTarget`]: fakeExecutable(ios, [
      '_objc_msgSend',
      '_OBJC_CLASS_$_NSUserDefaults',
    ]),
    [`${WIDGETS}/ExpoWidgets.bundle/ExpoWidgets.bundle`]: 'the widgets runtime',
    [`${WATCH}/Info.plist`]: info('PlaneAheadWatch', {
      CFBundleIcons: { CFBundlePrimaryIcon: { CFBundleIconName: 'AppIcon' } },
    }),
    [`${WATCH}/PrivacyInfo.xcprivacy`]: manifest(),
    [`${WATCH}/PlaneAheadWatch`]: fakeExecutable(watchos, watch(['_objc_msgSend'])),
    [`${WATCH}/Assets.car`]: 'the icon catalog',
    [`${WATCH_WIDGET}/Info.plist`]: info('PlaneAheadWatchWidget'),
    [`${WATCH_WIDGET}/PrivacyInfo.xcprivacy`]: manifest(),
    [`${WATCH_WIDGET}/PlaneAheadWatchWidget`]: fakeExecutable(watchos, watch(['_NSExtensionMain'])),
    'Frameworks/React.framework/Info.plist': plistXml({ CFBundleExecutable: 'React' }),
    'Frameworks/React.framework/React': fakeExecutable(ios, [
      '_objc_msgSend',
      '_stat',
      '_mach_absolute_time',
    ]),
    'Frameworks/hermesvm.framework/Info.plist': plistXml({ CFBundleExecutable: 'hermesvm' }),
    'Frameworks/hermesvm.framework/hermesvm': fakeExecutable(ios, ['_malloc']),
    'Frameworks/Declared.framework/Info.plist': plistXml({ CFBundleExecutable: 'Declared' }),
    'Frameworks/Declared.framework/PrivacyInfo.xcprivacy': manifest([DISK_SPACE, 'E174.1']),
    'Frameworks/Declared.framework/Declared': fakeExecutable(ios, ['_statfs']),
  };
}

/** `files` with some replaced (null removes one), each path under PlaneAhead.app. */
function withFiles(files, changes) {
  return { ...files, ...changes };
}

/** Each way a store build goes wrong that the store checks must catch (review ruling F2). */
const STORE_FAILURES = [
  [
    'a bundle without its manifest',
    { [`${WIDGETS}/PrivacyInfo.xcprivacy`]: null },
    'PlaneAhead.app/PlugIns/ExpoWidgetsTarget.appex carries no PrivacyInfo.xcprivacy',
  ],
  [
    'a manifest that does not parse',
    { [`${WATCH}/PrivacyInfo.xcprivacy`]: 'not a property list' },
    'PlaneAhead.app/Watch/PlaneAheadWatch.app: its PrivacyInfo.xcprivacy does not parse',
  ],
  [
    'a category declared without a reason',
    { [`${WIDGETS}/PrivacyInfo.xcprivacy`]: manifest([USER_DEFAULTS]) },
    'ExpoWidgetsTarget.appex declares NSPrivacyAccessedAPICategoryUserDefaults without a reason',
  ],
  [
    'an entry without a category',
    {
      [`${WIDGETS}/PrivacyInfo.xcprivacy`]: plistXml({
        NSPrivacyAccessedAPITypes: [{ NSPrivacyAccessedAPITypeReasons: ['1C8F.1'] }],
      }),
    },
    'entry 0 of its NSPrivacyAccessedAPITypes names no NSPrivacyAccessedAPIType',
  ],
  [
    'an NSPrivacyAccessedAPITypes that is not an array',
    { [`${WATCH}/PrivacyInfo.xcprivacy`]: plistXml({ NSPrivacyAccessedAPITypes: 'none' }) },
    'NSPrivacyAccessedAPITypes in its PrivacyInfo.xcprivacy is not an array',
  ],
  [
    "an undeclared API in the nested watch complication's arm64_32 slice",
    {
      [`${WATCH_WIDGET}/PlaneAheadWatchWidget`]: fakeExecutable('WATCHOS', {
        arm64: ['_NSExtensionMain'],
        arm64_32: ['_NSExtensionMain', '_stat'],
      }),
    },
    'PlaneAheadWatchWidget.appex calls required-reason APIs its privacy manifest does not declare',
    '_stat NSPrivacyAccessedAPICategoryFileTimestamp',
  ],
  [
    "SwiftUI's @AppStorage in the watch app",
    {
      [`${WATCH}/PlaneAheadWatch`]: fakeExecutable('WATCHOS', {
        arm64: ['_objc_msgSend', '_$s7SwiftUI10AppStorageV12wrappedValuexvg'],
        arm64_32: ['_objc_msgSend', '_$s7SwiftUI10AppStorageV12wrappedValuexvg'],
      }),
    },
    'PlaneAhead.app/Watch/PlaneAheadWatch.app calls required-reason APIs',
    '_$s7SwiftUI10AppStorageV12wrappedValuexvg NSPrivacyAccessedAPICategoryUserDefaults',
  ],
  [
    'a framework that uses a required-reason API and carries no manifest',
    {
      'Frameworks/ExpoFileSystem.framework/Info.plist': plistXml({
        CFBundleExecutable: 'ExpoFileSystem',
      }),
      'Frameworks/ExpoFileSystem.framework/ExpoFileSystem': fakeExecutable('IOS', [
        '_objc_msgSend',
        '_NSFileSystemSize',
      ]),
    },
    'ExpoFileSystem.framework calls required-reason APIs and carries no PrivacyInfo.xcprivacy of its own',
    '_NSFileSystemSize NSPrivacyAccessedAPICategoryDiskSpace',
  ],
  [
    'a framework whose manifest leaves one of its APIs undeclared',
    {
      'Frameworks/Declared.framework/Declared': fakeExecutable('IOS', [
        '_statfs',
        '_OBJC_CLASS_$_NSUserDefaults',
      ]),
    },
    'Declared.framework calls required-reason APIs its privacy manifest does not declare',
    '_OBJC_CLASS_$_NSUserDefaults NSPrivacyAccessedAPICategoryUserDefaults',
  ],
  [
    'an allowed framework whose own manifest leaves its APIs undeclared',
    { 'Frameworks/React.framework/PrivacyInfo.xcprivacy': manifest() },
    'React.framework calls required-reason APIs its privacy manifest does not declare',
  ],
  [
    'a framework manifest that does not parse',
    { 'Frameworks/hermesvm.framework/PrivacyInfo.xcprivacy': '<plist version="1.0">' },
    'hermesvm.framework: its PrivacyInfo.xcprivacy does not parse',
  ],
  [
    "a short version other than the app's",
    { [`${WATCH}/Info.plist`]: info('PlaneAheadWatch', { CFBundleShortVersionString: '1.0' }) },
    "PlaneAhead.app/Watch/PlaneAheadWatch.app CFBundleShortVersionString is '1.0', expected '0.1.0'",
  ],
  [
    "a build number other than the app's",
    { [`${WIDGETS}/Info.plist`]: info('ExpoWidgetsTarget', { CFBundleVersion: '1' }) },
    "PlaneAhead.app/PlugIns/ExpoWidgetsTarget.appex CFBundleVersion is '1', expected '4242'",
  ],
  [
    'an executable nm lists no symbol for',
    { PlaneAhead: fakeExecutable('IOS', []) },
    'nm lists no undefined symbol for PlaneAhead.app/PlaneAhead',
  ],
  [
    'an executable nm cannot read',
    { [`${WATCH_WIDGET}/PlaneAheadWatchWidget`]: 'not an executable' },
    'nm could not read PlaneAhead.app/Watch/PlaneAheadWatch.app/PlugIns/PlaneAheadWatchWidget.appex/PlaneAheadWatchWidget',
  ],
  [
    'an app without a build number',
    {
      'Info.plist': plistXml({
        CFBundleExecutable: 'PlaneAhead',
        CFBundleShortVersionString: VERSION,
      }),
    },
    'Info.plist has no version or build number',
  ],
];

describe('native-smoke.sh store checks (review ruling F2)', () => {
  const tools = appleTools();

  /** Writes `files` as PlaneAhead.app in a scratch directory and returns the app's path. */
  function app(files, name = 'app') {
    const root = scratchDir(name);
    writeTree(join(root, 'PlaneAhead.app'), files);
    return join(root, 'PlaneAhead.app');
  }

  it('passes a store-ready app, its frameworks each on their own (rulings F3, F5)', async () => {
    const result = await runAsync(['store-bundles', app(storeApp())], tools);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(lines(result.stdout)).toEqual(
      expect.arrayContaining([
        "native-smoke: ok: PlaneAhead.app's privacy manifest declares NSPrivacyAccessedAPICategoryUserDefaults NSPrivacyAccessedAPICategoryFileTimestamp, all its executable needs",
        "native-smoke: ok: PlaneAhead.app/Watch/PlaneAheadWatch.app/PlugIns/PlaneAheadWatchWidget.appex's privacy manifest declares no required-reason API, all its executable needs",
        'native-smoke: ok: PlaneAhead.app/Watch/PlaneAheadWatch.app/PlugIns/PlaneAheadWatchWidget.appex CFBundleVersion = 4242',
        'native-smoke: ok: PlaneAhead.app/Frameworks/hermesvm.framework references no required-reason API',
        "native-smoke: ok: PlaneAhead.app/Frameworks/Declared.framework's privacy manifest declares NSPrivacyAccessedAPICategoryDiskSpace, all its executable needs",
        '_stat NSPrivacyAccessedAPICategoryFileTimestamp',
        'native-smoke: ok: PlaneAhead.app/Frameworks/React.framework uses the required-reason APIs above without a manifest of its own, which FRAMEWORKS_WITHOUT_MANIFEST allows',
      ]),
    );
    // Each of the four bundles got the version checks.
    expect(result.stdout.match(/CFBundleShortVersionString = 0\.1\.0$/gm)).toHaveLength(4);
  }, 120_000);

  it.concurrent.for(STORE_FAILURES)(
    'fails %s',
    async ([, changes, message, printed], { expect: expectHere }) => {
      const result = await runAsync(['store-bundles', app(withFiles(storeApp(), changes))], tools);
      expectHere(result.status).toBe(1);
      expectHere(result.stderr).toContain(message);
      if (printed !== undefined) {
        expectHere(result.stderr).toContain(printed);
      }
    },
    120_000,
  );

  it('fails without an app', async () => {
    const result = await runAsync(
      ['store-bundles', join(scratchDir('none'), 'PlaneAhead.app')],
      tools,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no app at');
  });

  /** A scratch repository whose app has the watch shells, as app.config.ts lists them. */
  function watchRepo(name) {
    const repo = scratchRepo(name);
    writeTree(join(repo.root, 'apps', 'mobile', 'targets', 'watch'), {
      'expo-target.config.js': 'module.exports = {};\n',
    });
    return repo;
  }

  it('asserts the simulator app, then applies the store checks (ios-archive)', async () => {
    // A derived data path with "platform" in it, as vtool prints the path first (ruling F12).
    const cases = [
      ['as built', {}, 0],
      [
        'a manifest missing',
        { [`${WATCH_WIDGET}/PrivacyInfo.xcprivacy`]: null },
        1,
        'PlaneAheadWatchWidget.appex carries no PrivacyInfo.xcprivacy',
      ],
      [
        'a device slice',
        {
          [`${WATCH}/PlaneAheadWatch`]: fakeExecutable('WATCHOS', {
            arm64: ['_objc_msgSend'],
            arm64_32: ['_objc_msgSend'],
          }),
        },
        1,
        "watch app platform is 'WATCHOS', expected 'WATCHOSSIMULATOR'",
      ],
    ];
    const results = await Promise.all(
      cases.map(async ([, changes]) => {
        const { root, copy } = watchRepo('ios-archive');
        const derivedData = join(root, 'platform-derived-data');
        writeTree(
          join(derivedData, 'Build', 'Products', 'Release-iphonesimulator', 'PlaneAhead.app'),
          withFiles(storeApp({ simulator: true }), changes),
        );
        return runAsync(['ios-archive'], { ...tools, SMOKE_DERIVED_DATA: derivedData }, copy);
      }),
    );
    cases.forEach(([name, , status, message], index) => {
      expect(results[index].status, `${name}: ${results[index].stderr}`).toBe(status);
      if (message !== undefined) {
        expect(results[index].stderr, name).toContain(message);
      }
    });
    expect(results[0].stdout).toContain('native-smoke: ok: watch app platform = WATCHOSSIMULATOR');
    expect(results[0].stdout).toContain(
      "native-smoke: ok: PlaneAhead.app/PlugIns/ExpoWidgetsTarget.appex's privacy manifest declares",
    );
  }, 120_000);

  it('asserts the device archive: an app archive, device platforms, the store checks (F7)', async () => {
    const archiveInfo = plistXml({
      ApplicationProperties: {
        ApplicationPath: 'Applications/PlaneAhead.app',
        CFBundleIdentifier: 'app.planeahead.mobile',
      },
      ArchiveVersion: 2,
      Name: 'PlaneAhead',
    });
    const cases = [
      ['as archived', {}, {}, 0],
      [
        'a library installed beside the app',
        { 'Products/usr/local/lib/libExpoModulesCore.a': 'a static library' },
        {},
        1,
        "the archive's products is './Applications ./Applications/PlaneAhead.app ./usr ./usr/local'",
      ],
      [
        'a generic archive',
        { 'Info.plist': plistXml({ ArchiveVersion: 2, Name: 'PlaneAhead' }) },
        {},
        1,
        "the archive's ApplicationPath is '', expected 'Applications/PlaneAhead.app'",
      ],
      [
        'a simulator app',
        {},
        { PlaneAhead: fakeExecutable('IOSSIMULATOR', ['_objc_msgSend', '_stat']) },
        1,
        "archived app platform is 'IOSSIMULATOR', expected 'IOS'",
      ],
      [
        'a simulator watch app',
        {},
        {
          [`${WATCH}/PlaneAheadWatch`]: fakeExecutable('WATCHOSSIMULATOR', {
            arm64: ['_objc_msgSend'],
          }),
        },
        1,
        "archived watch app platform is 'WATCHOSSIMULATOR', expected 'WATCHOS'",
      ],
      [
        "an extension's build number",
        {},
        { [`${WIDGETS}/Info.plist`]: info('ExpoWidgetsTarget', { CFBundleVersion: '1' }) },
        1,
        "ExpoWidgetsTarget.appex CFBundleVersion is '1', expected '4242'",
      ],
    ];
    const results = await Promise.all(
      cases.map(async ([, archiveChanges, appChanges]) => {
        const { root, copy } = watchRepo('device-archive');
        // xcodebuild "archives" by copying a prepared archive to -archivePath.
        const template = join(root, 'template.xcarchive');
        writeTree(template, { 'Info.plist': archiveInfo, ...archiveChanges });
        writeTree(
          join(template, 'Products', 'Applications', 'PlaneAhead.app'),
          withFiles(storeApp(), appChanges),
        );
        const bin = stubs({
          xcodebuild: [
            'archive=""',
            'while [ $# -gt 0 ]; do [ "$1" = -archivePath ] && archive="$2"; shift; done',
            `mkdir -p "$archive" && cp -R '${template}/.' "$archive/"`,
          ].join('\n'),
        });
        return runAsync(
          ['ios-device-archive'],
          {
            ...tools,
            PATH: `${bin}:${tools.PATH}`,
            SMOKE_ARCHIVE_PATH: join(root, 'out', 'PlaneAhead.xcarchive'),
            SMOKE_DERIVED_DATA: join(root, 'out', 'derived-data'),
            SMOKE_ARCHIVE_MIN_FREE_GB: '0',
          },
          copy,
        );
      }),
    );
    cases.forEach(([name, , , status, message], index) => {
      expect(results[index].status, `${name}: ${results[index].stderr}`).toBe(status);
      if (message !== undefined) {
        expect(results[index].stderr, name).toContain(message);
      }
    });
    expect(results[0].stdout).toContain(
      "native-smoke: ok: the archive's ApplicationPath = Applications/PlaneAhead.app",
    );
    expect(results[0].stdout).toContain(
      'native-smoke: ok: archived watch widget platform = WATCHOS',
    );
    expect(results[0].stdout).toContain(
      'native-smoke: ok: PlaneAhead.app/Watch/PlaneAheadWatch.app CFBundleVersion = 4242',
    );
  }, 120_000);

  it("prebuilds with EAS's build number and writes it into the app as EAS does (F6)", async () => {
    const group = { 'com.apple.security.application-groups': ['group.app.planeahead.mobile'] };
    const appEntitlements = { 'aps-environment': 'production', ...group };
    const generated = {
      'ios/PlaneAhead/PlaneAhead.entitlements': plistXml({
        ...appEntitlements,
        'com.apple.developer.usernotifications.time-sensitive': true,
      }),
      'ios/PlaneAhead/Info.plist': plistXml({
        CFBundleShortVersionString: VERSION,
        CFBundleVersion: '1',
      }),
      'ios/ExpoWidgetsTarget/ExpoWidgetsTarget.entitlements': plistXml(group),
      'ios/.targets/PlaneAheadWatch/generated.entitlements': plistXml(group),
      'ios/.targets/PlaneAheadWatchWidget/generated.entitlements': plistXml(group),
      'ios/ExpoWidgetsTarget/PrivacyInfo.xcprivacy': manifest([USER_DEFAULTS, '1C8F.1']),
      'ios/PlaneAheadWatch/PrivacyInfo.xcprivacy': manifest(),
      'ios/PlaneAheadWatchWidget/PrivacyInfo.xcprivacy': manifest(),
    };
    const cases = [
      ['as generated', {}, 0],
      [
        'a watch manifest missing',
        { 'ios/PlaneAheadWatch/PrivacyInfo.xcprivacy': null },
        1,
        'ios/PlaneAheadWatch/PrivacyInfo.xcprivacy is missing or does not parse',
      ],
      [
        'the time-sensitive entitlement missing (increment 16, ruling C8)',
        { 'ios/PlaneAhead/PlaneAhead.entitlements': plistXml(appEntitlements) },
        1,
        "time-sensitive notifications (app) is '', expected 'true'",
      ],
    ];
    const runs = await Promise.all(
      cases.map(async ([, changes]) => {
        const { root, copy } = watchRepo('prebuild');
        const template = join(root, 'generated');
        writeTree(template, withFiles(generated, changes));
        const seen = join(root, 'pnpm-saw');
        const bin = stubs({
          // expo prebuild "generates" the project and records what it was given.
          pnpm: [
            `printf '%s\\n' "$*" "EAS_BUILD_IOS_BUILD_NUMBER=\${EAS_BUILD_IOS_BUILD_NUMBER:-}" "EAS_BUILD_IOS_APP_VERSION=\${EAS_BUILD_IOS_APP_VERSION:-}" "APP_VARIANT=$APP_VARIANT" "APNS_ENVIRONMENT=$APNS_ENVIRONMENT" > '${seen}'`,
            `cp -R '${template}/.' ./`,
          ].join('\n'),
          xcodebuild: [
            'case "$*" in',
            "  *-list*) printf '    Targets:\\n        PlaneAhead\\n        ExpoWidgetsTarget\\n        PlaneAheadWatch\\n        PlaneAheadWatchWidget\\n\\n' ;;",
            "  *-showBuildSettings*) printf '    ENABLE_DEBUG_DYLIB = NO\\n    SWIFT_OPTIMIZATION_LEVEL = -O\\n' ;;",
            '  *) exit 3 ;;',
            'esac',
          ].join('\n'),
        });
        // Whatever the caller's shell holds, the prebuild gets the smoke's own numbers.
        const result = await runAsync(
          ['ios-prebuild'],
          {
            ...tools,
            PATH: `${bin}:${tools.PATH}`,
            EAS_BUILD_IOS_BUILD_NUMBER: '1',
            EAS_BUILD_IOS_APP_VERSION: '9.9',
          },
          copy,
        );
        return { result, root, seen };
      }),
    );
    cases.forEach(([name, , status, message], index) => {
      expect(runs[index].result.status, `${name}: ${runs[index].result.stderr}`).toBe(status);
      if (message !== undefined) {
        expect(runs[index].result.stderr, name).toContain(message);
      }
    });
    const [{ root, seen }] = runs;
    expect(readFileSync(seen, 'utf8').trim().split('\n')).toEqual([
      'exec expo prebuild --platform ios',
      'EAS_BUILD_IOS_BUILD_NUMBER=4242',
      'EAS_BUILD_IOS_APP_VERSION=',
      'APP_VARIANT=production',
      'APNS_ENVIRONMENT=production',
    ]);
    const plist = parsePlist(
      readFileSync(join(root, 'apps', 'mobile', 'ios', 'PlaneAhead', 'Info.plist'), 'utf8'),
    );
    expect(plist.get('CFBundleVersion')).toBe(BUILD);
    expect(plist.get('CFBundleShortVersionString')).toBe(VERSION);
  }, 120_000);

  it('asserts the APKs and checks the release APK, not the debug one, for 16 KB pages', async () => {
    const release = (libs) =>
      storedZip({
        'classes.dex': 'dex',
        'assets/index.android.bundle': 'the JavaScript',
        ...libs,
      });
    const cases = [
      ['as built', {}, 'x86_64', 0],
      [
        'a misaligned release library',
        { 'lib/x86_64/libplanted.so': programHeaders('0x4000', '0x1000') },
        'x86_64',
        1,
        'aligned below 16 KB (0x4000): lib/x86_64/libplanted.so',
      ],
      [
        'a release check without arm64-v8a',
        {},
        'arm64-v8a,x86_64',
        1,
        'carries no arm64-v8a library, although the build was asked for arm64-v8a',
      ],
    ];
    const results = await Promise.all(
      cases.map(async ([, libs, abis]) => {
        const { root, copy } = scratchRepo('android-archive');
        const sdk = androidSdk(root);
        const permissions = join(root, 'permissions.txt');
        writeFileSync(permissions, permissionDump(expectedPermissions()));
        const apks = join(root, 'apps', 'mobile', 'android');
        writeTree(apks, {
          // The debug APK's library is misaligned: only the release APK is checked.
          'app/build/outputs/apk/debug/app-debug.apk': storedZip({
            'classes.dex': 'Lapp/planeahead/surfaces/OngoingNotificationModule;',
            'lib/x86_64/libhermes.so': programHeaders('0x1000'),
          }),
          'app/build/outputs/apk/release/app-release.apk': release({
            'lib/x86_64/libhermes.so': programHeaders('0x4000'),
            ...libs,
          }),
          'wear/build/outputs/apk/debug/wear-debug.apk': storedZip({
            'classes.dex': 'Lapp/planeahead/wear/NextFlightTileService;',
          }),
        });
        return runAsync(
          ['android-archive'],
          { ANDROID_HOME: sdk.home, APP_PERMISSIONS: permissions, SMOKE_ANDROID_ABIS: abis },
          copy,
        );
      }),
    );
    cases.forEach(([name, , , status, message], index) => {
      expect(results[index].status, `${name}: ${results[index].stderr}`).toBe(status);
      if (message !== undefined) {
        expect(results[index].stderr, name).toContain(message);
      }
    });
    expect(lines(results[0].stdout)).toEqual([
      'native-smoke: ok: app and Wear APKs built, stub module and Tile compiled in',
      'native-smoke: ok: the release APK embeds index.android.bundle',
      'native-smoke: ok: no WorkManager or Glance component in the merged manifests',
      'native-smoke: ok: the release APK declares exactly the expected permissions',
      'native-smoke: ok: zipalign -c -P 16 -v 4 verifies android/app/build/outputs/apk/release/app-release.apk',
      'native-smoke: ok: all 1 64-bit libraries (x86_64) in android/app/build/outputs/apk/release/app-release.apk align every LOAD segment to 16 KB',
    ]);
  }, 120_000);

  describe("with Apple's own tools (macOS only: it.runIf(onMac))", () => {
    /**
     * Irreducibly macOS: Apple's plutil and PlistBuddy, and nm on real Mach-O binaries. These keep
     * apple-tools-stub.mjs honest: the store checks give the same verdicts with the real tools.
     */
    const realPlist = {
      ...appleTools(['nm', 'vtool']),
      SMOKE_PLISTBUDDY: '/usr/libexec/PlistBuddy',
    };

    it.runIf(onMac)(
      'reads the fixtures with the real plutil and PlistBuddy as the stand-ins do',
      async () => {
        const cases = [
          [storeApp(), 0],
          ...STORE_FAILURES.map(([, changes, message]) => [
            withFiles(storeApp(), changes),
            1,
            message,
          ]),
        ];
        const results = await Promise.all(
          cases.map(([files]) => runAsync(['store-bundles', app(files, 'real-plist')], realPlist)),
        );
        cases.forEach(([, status, message], index) => {
          expect(results[index].status, `${message}: ${results[index].stderr}`).toBe(status);
          if (message !== undefined) {
            expect(results[index].stderr).toContain(message);
          }
        });
        // And tool by tool, on the same files: output and exit status alike.
        const dir = scratchDir('plist');
        writeTree(dir, {
          'manifest.plist': manifest([USER_DEFAULTS, 'CA92.1'], [DISK_SPACE, 'E174.1']),
          'info.plist': info('PlaneAhead', {
            CFBundleIcons: { CFBundlePrimaryIcon: { CFBundleIconName: 'AppIcon' } },
            'com.apple.security.application-groups': ['group.app.planeahead.mobile'],
            // ios-prebuild reads this boolean (increment 16, ruling C8).
            'com.apple.developer.usernotifications.time-sensitive': true,
          }),
          'bad.plist': 'not a property list',
        });
        const stub = join(import.meta.dirname, 'apple-tools-stub.mjs');
        const both = (tool, real, args) => [
          spawnSync(process.execPath, [stub, tool, ...args], { encoding: 'utf8' }),
          spawnSync(real, args, { encoding: 'utf8' }),
        ];
        for (const [tool, real, args] of [
          ['plutil', 'plutil', ['-lint', '-s', join(dir, 'manifest.plist')]],
          ['plutil', 'plutil', ['-lint', '-s', join(dir, 'bad.plist')]],
          [
            'plutil',
            'plutil',
            [
              '-extract',
              'NSPrivacyAccessedAPITypes',
              'raw',
              '-o',
              '-',
              join(dir, 'manifest.plist'),
            ],
          ],
          [
            'plutil',
            'plutil',
            [
              '-extract',
              'NSPrivacyAccessedAPITypes.1.NSPrivacyAccessedAPIType',
              'raw',
              '-o',
              '-',
              join(dir, 'manifest.plist'),
            ],
          ],
          [
            'plutil',
            'plutil',
            [
              '-extract',
              'NSPrivacyAccessedAPITypes.2.NSPrivacyAccessedAPIType',
              'raw',
              '-o',
              '-',
              join(dir, 'manifest.plist'),
            ],
          ],
          [
            'plutil',
            'plutil',
            ['-extract', 'NSPrivacyTracking', 'raw', '-o', '-', join(dir, 'manifest.plist')],
          ],
          [
            'PlistBuddy',
            '/usr/libexec/PlistBuddy',
            [
              '-c',
              'Print :CFBundleIcons:CFBundlePrimaryIcon:CFBundleIconName',
              join(dir, 'info.plist'),
            ],
          ],
          [
            'PlistBuddy',
            '/usr/libexec/PlistBuddy',
            ['-c', 'Print :com.apple.security.application-groups:0', join(dir, 'info.plist')],
          ],
          [
            'PlistBuddy',
            '/usr/libexec/PlistBuddy',
            [
              '-c',
              'Print :com.apple.developer.usernotifications.time-sensitive',
              join(dir, 'info.plist'),
            ],
          ],
          [
            'PlistBuddy',
            '/usr/libexec/PlistBuddy',
            ['-c', 'Print :NoSuchKey', join(dir, 'info.plist')],
          ],
          [
            'PlistBuddy',
            '/usr/libexec/PlistBuddy',
            ['-c', 'Print :CFBundleVersion', join(dir, 'bad.plist')],
          ],
        ]) {
          const [stand, apple] = both(tool, real, args);
          const label = `${tool} ${args.join(' ')}`;
          expect(stand.status, label).toBe(apple.status);
          expect(stand.stdout, label).toBe(apple.stdout);
        }
        // Set, as ios-prebuild uses it, then Print.
        const copy = join(dir, 'copy.plist');
        for (const tool of ['stand-in', 'Apple']) {
          cpSync(join(dir, 'info.plist'), copy);
          const buddy = (...args) =>
            tool === 'Apple'
              ? spawnSync('/usr/libexec/PlistBuddy', args, { encoding: 'utf8' })
              : spawnSync(process.execPath, [stub, 'PlistBuddy', ...args], { encoding: 'utf8' });
          expect(buddy('-c', 'Set :CFBundleVersion 4242', copy).status, tool).toBe(0);
          expect(buddy('-c', 'Print :CFBundleVersion', copy).stdout, tool).toBe('4242\n');
          expect(buddy('-c', 'Print :CFBundleExecutable', copy).stdout, tool).toBe('PlaneAhead\n');
        }
      },
      120_000,
    );

    it.runIf(onMac)(
      'reads every slice of a universal binary with the real nm (ruling F3)',
      () => {
        // A universal macOS binary whose x86_64 slice alone calls stat, like the watch shells'
        // arm64_32 slice beside their arm64 one: nm without -arch all reads the host's slice only.
        const dir = scratchDir('macho');
        writeTree(dir, {
          'plain.c': '#include <stdio.h>\nint main(void) { return puts("x"); }\n',
          'fat.c': [
            '#include <stdio.h>',
            '#include <sys/stat.h>',
            'int fat(const char *path) {',
            '#if defined(__x86_64__)',
            '  struct stat s;',
            '  return stat(path, &s);',
            '#else',
            '  return puts(path);',
            '#endif',
            '}',
            '',
          ].join('\n'),
        });
        const compile = (args) => {
          const result = spawnSync('xcrun', ['clang', ...args], { cwd: dir, encoding: 'utf8' });
          expect(result.status, result.stderr).toBe(0);
        };
        compile(['-o', 'plain', 'plain.c']);
        compile(['-arch', 'arm64', '-arch', 'x86_64', '-dynamiclib', '-o', 'Fat', 'fat.c']);
        const tree = (frameworkManifest) => ({
          'Info.plist': info('PlaneAhead'),
          'PrivacyInfo.xcprivacy': manifest(),
          PlaneAhead: readFileSync(join(dir, 'plain')),
          'Frameworks/Fat.framework/Info.plist': plistXml({ CFBundleExecutable: 'Fat' }),
          'Frameworks/Fat.framework/Fat': readFileSync(join(dir, 'Fat')),
          'Frameworks/Fat.framework/PrivacyInfo.xcprivacy': frameworkManifest,
        });
        const apple = { PATH: process.env.PATH, SMOKE_PLISTBUDDY: '/usr/libexec/PlistBuddy' };
        const undeclared = runWith(['store-bundles', app(tree(null), 'macho')], apple);
        expect(undeclared.status, undeclared.stderr).toBe(1);
        expect(undeclared.stderr).toContain('_stat NSPrivacyAccessedAPICategoryFileTimestamp');
        expect(undeclared.stderr).toContain(
          'PlaneAhead.app/Frameworks/Fat.framework calls required-reason APIs and carries no PrivacyInfo.xcprivacy of its own',
        );
        const declared = runWith(
          ['store-bundles', app(tree(manifest([FILE_TIMESTAMP, 'C617.1'])), 'macho')],
          apple,
        );
        expect(declared.status, declared.stderr).toBe(0);
        // Without -arch all, the real nm misses it.
        const hostOnly = spawnSync('nm', ['-u', '-j', join(dir, 'Fat')], { encoding: 'utf8' });
        expect(hostOnly.stdout).not.toMatch(/_stat/);
      },
      60_000,
    );
  });
});

describe('native-smoke.sh pipelines', () => {
  const script = readFileSync(join(repoRoot, 'scripts', 'native-smoke.sh'), 'utf8');

  it('ends no pipeline in `grep -q`, which pipefail reports as a failure on a match', () => {
    // `grep -q` exits at its first match; the command writing into it then dies of SIGPIPE, and
    // `set -o pipefail` reports the pipeline as failed (141). The release-bundle check did this on
    // a 1,343-line APK listing in increment 16's local smoke; a count (`grep -c`) reads to the end.
    const code = script.split('\n').filter((line) => !/^\s*#/.test(line));
    expect(code.filter((line) => /\|\s*grep\s+-[a-zA-Z]*q/.test(line))).toEqual([]);
  });
});
