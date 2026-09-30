/**
 * A generated iOS project (increment 13): a real `expo prebuild --platform ios --no-install` of
 * this app, run on a temporary copy of what prebuild reads (the config, the plugins, the target
 * configs and the icons) with the app's own node_modules linked in, so the whole plugin chain
 * runs as app.config.ts lists it without touching apps/mobile/ios. About two seconds; no
 * CocoaPods, no Xcode, so it runs on the Linux CI runner too.
 *
 * `edit` changes the copy before the prebuild, which is how a test plants a failure (a target
 * directory removed, a plugin entry moved). The project is read back with @bacons/xcode, the
 * parser @bacons/apple-targets and the increment 13 plugins edit it with, resolved through
 * apple-targets because the app does not depend on it directly.
 */

// Jest's CommonJS wrapper provides them; the app's tsconfig carries no Node types.
declare const __dirname: string;
declare const require: { resolve(id: string, options?: { paths: string[] }): string };

interface SpawnResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const childProcess = jest.requireActual<{
  spawnSync(
    file: string,
    args: readonly string[],
    options: { cwd: string; env: Record<string, string | undefined>; encoding: 'utf8' },
  ): SpawnResult;
}>('child_process');
const fs = jest.requireActual<{
  cpSync(from: string, to: string, options: { recursive: true }): void;
  existsSync(path: string): boolean;
  mkdtempSync(prefix: string): string;
  readFileSync(path: string, encoding: 'utf8'): string;
  rmSync(path: string, options: { recursive: true; force: true }): void;
  symlinkSync(target: string, path: string, type: 'dir'): void;
  writeFileSync(path: string, contents: string): void;
}>('fs');
const os = jest.requireActual<{ tmpdir(): string }>('os');
const path = jest.requireActual<{
  dirname(path: string): string;
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
}>('path');

export const APP_ROOT = path.resolve(__dirname, '..', '..');

/** What `expo prebuild --platform ios` reads from the app. */
const PREBUILD_INPUTS = ['app.config.ts', 'package.json', 'plugins', 'targets', 'assets'];

const processEnv = (process as unknown as { env: Record<string, string | undefined> }).env;
const nodeBinary = (process as unknown as { execPath: string }).execPath;

export interface GeneratedProject {
  /** The temporary project root; `ios/` is the generated project. */
  readonly root: string;
  readonly status: number | null;
  /** The prebuild's stdout and stderr, for the failure message a planted failure expects. */
  readonly output: string;
  readFile(relativePath: string): string;
  exists(relativePath: string): boolean;
  remove(): void;
}

/** Runs the prebuild of the production variant as the production EAS profile has it. */
export function prebuildIos(edit?: (root: string) => void): GeneratedProject {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'planeahead-prebuild-'));
  for (const input of PREBUILD_INPUTS) {
    fs.cpSync(path.join(APP_ROOT, input), path.join(root, input), { recursive: true });
  }
  // The icon catalog apple-targets generated in a local prebuild is output, not input.
  for (const target of ['watch', 'watch-widget']) {
    fs.rmSync(path.join(root, 'targets', target, 'Assets.xcassets'), {
      recursive: true,
      force: true,
    });
  }
  fs.symlinkSync(path.join(APP_ROOT, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  edit?.(root);
  const cli = require.resolve('expo/bin/cli', { paths: [APP_ROOT] });
  const result = childProcess.spawnSync(
    nodeBinary,
    [cli, 'prebuild', '--platform', 'ios', '--no-install'],
    {
      cwd: root,
      env: {
        ...processEnv,
        APP_VARIANT: 'production',
        APNS_ENVIRONMENT: 'production',
        APPLE_TEAM_ID: '',
        CI: '1',
        EXPO_NO_GIT_STATUS: '1',
        EXPO_NO_TELEMETRY: '1',
        PLANEAHEAD_ANDROID_WIDGETS: '',
      },
      encoding: 'utf8',
    },
  );
  return {
    root,
    status: result.status,
    output: `${result.stdout}\n${result.stderr}`,
    readFile: (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8'),
    exists: (relativePath) => fs.existsSync(path.join(root, relativePath)),
    remove: () => {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Replaces `from` with `to` in a file of the copy, and fails the test if `from` is absent. */
export function replaceInFile(root: string, relativePath: string, from: string, to: string): void {
  const file = path.join(root, relativePath);
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes(from)) {
    throw new Error(`${relativePath} no longer contains ${JSON.stringify(from)}`);
  }
  fs.writeFileSync(file, text.replace(from, to));
}

/** The parts of @bacons/xcode's model the tests read (the plugins type what they edit). */
export interface XcodeModel {
  readonly isa: string;
  readonly uuid: string;
  readonly props: Record<string, unknown>;
  getResourcesBuildPhase?(): XcodeModel;
  removeFromProject?(): void;
}

export interface BaconsProject {
  readonly rootObject: {
    readonly props: { readonly targets: XcodeModel[]; readonly mainGroup: XcodeModel };
  };
  values(): IterableIterator<XcodeModel>;
}

/** The generated project, parsed by @bacons/xcode. */
export function openProject(project: GeneratedProject): BaconsProject {
  const appleTargets = path.dirname(
    require.resolve('@bacons/apple-targets/package.json', { paths: [APP_ROOT] }),
  );
  const { XcodeProject } = jest.requireActual<{
    XcodeProject: { open(file: string): BaconsProject };
  }>(require.resolve('@bacons/xcode', { paths: [appleTargets] }));
  return XcodeProject.open(
    path.join(project.root, 'ios', 'PlaneAhead.xcodeproj', 'project.pbxproj'),
  );
}
