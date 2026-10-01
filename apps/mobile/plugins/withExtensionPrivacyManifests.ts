/**
 * A privacy manifest in every bundle the project builds besides the app (increment 13, ruling S1;
 * docs/research/phase1/R5-store-distribution.md F11, F12, L2, L3).
 *
 * Apple: "For each executable or dynamic library in an app that uses a required reason API, the
 * bundle that includes the executable or dynamic library needs to include a privacy manifest
 * file", and since 2024-05-01 App Store Connect refuses an app whose required-reason API use is
 * not described (https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api).
 * Expo writes only the app target's manifest (`ios.privacyManifests` in app.config.ts); neither
 * expo-widgets 57.0.20 nor @bacons/apple-targets 5.0.0 writes one for its targets. So this plugin
 * writes `ios/<target>/PrivacyInfo.xcprivacy` for the widget extension and the two watchOS shells
 * and adds each to its own target's Resources build phase:
 *
 * - `ExpoWidgetsTarget` reads the App Group's defaults (expo-widgets' `WidgetsStorage` is
 *   `UserDefaults(suiteName:)`, and `_OBJC_CLASS_$_NSUserDefaults` is the one required-reason
 *   symbol its binary references), so it declares `NSPrivacyAccessedAPICategoryUserDefaults` with
 *   `1C8F.1`, Apple's reason for defaults "only accessible to the apps, app extensions, and App
 *   Clips that are members of the same App Group" (https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitype).
 * - `PlaneAheadWatch` and `PlaneAheadWatchWidget` call no required-reason API (their binaries
 *   reference none), so they declare none. A later use extends that target's entry below; the
 *   native smoke fails any executable whose required-reason symbols its manifest does not declare.
 * - Every one declares `NSPrivacyTracking` false and no collected data types: the extensions
 *   collect nothing, they read what the app wrote.
 *
 * The watch app did carry a manifest before this plugin, the wrong one: React Native's CocoaPods
 * privacy aggregation (react-native/scripts/cocoapods/privacy_manifest_utils.rb,
 * `ensure_reference`) adds the first `PrivacyInfo.xcprivacy` in the project, the app's, to every
 * application target without one, so `pod install` gave the watch app the phone app's aggregated
 * manifest, collected data types included. With a manifest in its own Resources phase it is left
 * alone.
 *
 * Mechanism. The watch targets do not exist in Expo's `xcodeproj` mod, where
 * withExpoWidgetsBuild edits the widget extension: @bacons/apple-targets creates them in a mod of
 * its own, `xcodeProjectBeta2`, which config-plugins runs after `xcodeproj` and which reads the
 * project file Expo's provider wrote, with a second parser (@bacons/xcode). This plugin registers
 * a base mod on that chain and edits on the way back out, like withExpoWidgetsBuild does on its
 * chain: after apple-targets created or rewrote the watch targets, before its provider writes the
 * file, with the widget extension already in it. The registration must come BEFORE apple-targets'
 * provider, so the plugin is listed before '@bacons/apple-targets' in app.config.ts; listed after
 * it, config-plugins refuses the mod (`INVALID_MOD_ORDER`) and the config does not evaluate. A
 * finalized mod fails the prebuild if that chain never ran (apple-targets gone from the plugins),
 * and the edit fails it if a target it expects is missing: a renamed target must not ship without
 * its manifest. Upstream generator behaviour under exact pins: a bump of either package re-checks
 * it (the generated-project test and the smoke).
 */

import { withBaseMod, withFinalizedMod, type ConfigPlugin } from 'expo/config-plugins';

/** @bacons/apple-targets 5.0.0's project mod (build/with-bacons-xcode.js `customModName`). */
export const APPLE_TARGETS_PROJECT_MOD = 'xcodeProjectBeta2';

export const PRIVACY_MANIFEST_FILE = 'PrivacyInfo.xcprivacy';

/** The file type Xcode records for a privacy manifest. */
const PRIVACY_MANIFEST_FILE_TYPE = 'text.xml';

export type RequiredReasonCategory =
  | 'NSPrivacyAccessedAPICategoryFileTimestamp'
  | 'NSPrivacyAccessedAPICategorySystemBootTime'
  | 'NSPrivacyAccessedAPICategoryDiskSpace'
  | 'NSPrivacyAccessedAPICategoryActiveKeyboards'
  | 'NSPrivacyAccessedAPICategoryUserDefaults';

export interface AccessedApiType {
  readonly category: RequiredReasonCategory;
  /** Apple's reason codes, at least one. */
  readonly reasons: readonly [string, ...string[]];
}

/**
 * The required-reason APIs each target's executable uses: the whole of what its manifest says
 * beyond tracking (none) and collected data (none). The targets are the ones expo-widgets and
 * the two target configs in targets/ create; each is the name of a native target and of the
 * directory under ios/ its manifest is written to.
 */
export const EXTENSION_PRIVACY_MANIFESTS = {
  ExpoWidgetsTarget: [
    { category: 'NSPrivacyAccessedAPICategoryUserDefaults', reasons: ['1C8F.1'] },
  ],
  PlaneAheadWatch: [],
  PlaneAheadWatchWidget: [],
} as const satisfies Readonly<Record<string, readonly AccessedApiType[]>>;

export type ExtensionTarget = keyof typeof EXTENSION_PRIVACY_MANIFESTS;

export const EXTENSION_TARGETS = Object.keys(EXTENSION_PRIVACY_MANIFESTS) as ExtensionTarget[];

function plistEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The manifest as an XML property list, keys in Apple's sorted order. */
export function privacyManifestPlist(accessed: readonly AccessedApiType[]): string {
  const stringElement = (text: string, indent: string): string =>
    `${indent}<string>${plistEscape(text)}</string>`;
  const types = accessed.map(({ category, reasons }) =>
    [
      '\t\t<dict>',
      '\t\t\t<key>NSPrivacyAccessedAPIType</key>',
      stringElement(category, '\t\t\t'),
      '\t\t\t<key>NSPrivacyAccessedAPITypeReasons</key>',
      '\t\t\t<array>',
      ...reasons.map((reason) => stringElement(reason, '\t\t\t\t')),
      '\t\t\t</array>',
      '\t\t</dict>',
    ].join('\n'),
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>NSPrivacyAccessedAPITypes</key>',
    ...(types.length === 0 ? ['\t<array/>'] : ['\t<array>', ...types, '\t</array>']),
    '\t<key>NSPrivacyCollectedDataTypes</key>',
    '\t<array/>',
    '\t<key>NSPrivacyTracking</key>',
    '\t<false/>',
    '\t<key>NSPrivacyTrackingDomains</key>',
    '\t<array/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/**
 * The parts of @bacons/xcode's project model (1.0.0-alpha.32, the parser apple-targets reads and
 * writes the project with) this plugin uses. Structural, because the package is apple-targets'
 * dependency, not the app's.
 */
export interface AppleProjectObject {
  readonly isa: string;
}

export interface AppleFileReference extends AppleProjectObject {
  readonly props: { readonly path?: string };
}

export interface AppleBuildFile extends AppleProjectObject {
  readonly props: { readonly fileRef?: AppleProjectObject };
}

export interface AppleBuildPhase extends AppleProjectObject {
  readonly props: { readonly files: AppleBuildFile[] };
}

export interface AppleGroup extends AppleProjectObject {
  readonly props: { readonly path?: string; readonly children: AppleProjectObject[] };
  createGroup(opts: { name: string; path: string; sourceTree: '<group>' }): AppleGroup;
  createFile(opts: {
    path: string;
    lastKnownFileType: string;
    sourceTree: '<group>';
  }): AppleFileReference;
}

export interface AppleNativeTarget extends AppleProjectObject {
  readonly props: { readonly name: string };
  getResourcesBuildPhase(): AppleBuildPhase;
}

export interface AppleProject {
  readonly rootObject: {
    readonly props: { readonly targets: AppleProjectObject[]; readonly mainGroup: AppleGroup };
  };
  createModel(opts: { isa: 'PBXBuildFile'; fileRef: AppleFileReference }): AppleBuildFile;
}

function isNativeTarget(object: AppleProjectObject): object is AppleNativeTarget {
  return object.isa === 'PBXNativeTarget';
}

function isGroup(object: AppleProjectObject): object is AppleGroup {
  return object.isa === 'PBXGroup';
}

function isManifestReference(object: AppleProjectObject | undefined): boolean {
  return (
    object?.isa === 'PBXFileReference' &&
    (object as AppleFileReference).props.path?.split('/').pop() === PRIVACY_MANIFEST_FILE
  );
}

/** The native target named `name`, or a thrown error naming it: a renamed target must fail. */
export function nativeTarget(project: AppleProject, name: string): AppleNativeTarget {
  const target = project.rootObject.props.targets
    .filter(isNativeTarget)
    .find((candidate) => candidate.props.name === name);
  if (target === undefined) {
    throw new Error(
      `withExtensionPrivacyManifests: no ${name} target in the Xcode project, so its bundle ` +
        'would ship without a privacy manifest',
    );
  }
  return target;
}

/** The main group's child group at `path`, created when missing (the watch targets have none). */
function groupAt(project: AppleProject, path: string): AppleGroup {
  const mainGroup = project.rootObject.props.mainGroup;
  const existing = mainGroup.props.children
    .filter(isGroup)
    .find((child) => child.props.path === path);
  return existing ?? mainGroup.createGroup({ name: path, path, sourceTree: '<group>' });
}

/**
 * Adds `<target>/PrivacyInfo.xcprivacy` to each target's Resources build phase, in a group of that
 * name under the main group, and returns the files to write (relative to the ios/ directory).
 * Checks every target before changing any, and leaves a target whose Resources phase already
 * holds a manifest as it is, so a second run changes nothing.
 */
export function addExtensionPrivacyManifests(
  project: AppleProject,
  manifests: Readonly<Record<string, readonly AccessedApiType[]>> = EXTENSION_PRIVACY_MANIFESTS,
): { path: string; contents: string }[] {
  const targets = Object.keys(manifests).map((name) => nativeTarget(project, name));
  return targets.map((target) => {
    const name = target.props.name;
    const phase = target.getResourcesBuildPhase();
    if (!phase.props.files.some((file) => isManifestReference(file.props.fileRef))) {
      const group = groupAt(project, name);
      const fileRef =
        (group.props.children.find(isManifestReference) as AppleFileReference | undefined) ??
        group.createFile({
          path: PRIVACY_MANIFEST_FILE,
          lastKnownFileType: PRIVACY_MANIFEST_FILE_TYPE,
          sourceTree: '<group>',
        });
      phase.props.files.push(project.createModel({ isa: 'PBXBuildFile', fileRef }));
    }
    return {
      path: `${name}/${PRIVACY_MANIFEST_FILE}`,
      contents: privacyManifestPlist(manifests[name] ?? []),
    };
  });
}

/** Node's fs and path, typed here: the app's tsconfig loads no Node types (app.config.ts too). */
interface NodeFs {
  mkdirSync(path: string, options: { recursive: true }): void;
  writeFileSync(path: string, contents: string): void;
}
interface NodePath {
  join(...parts: string[]): string;
  dirname(path: string): string;
}
declare const require: (id: 'fs' | 'path') => unknown;

export const withExtensionPrivacyManifests: ConfigPlugin = (config) => {
  let edited = false;
  const withEdit = withBaseMod<AppleProject>(config, {
    platform: 'ios',
    mod: APPLE_TARGETS_PROJECT_MOD,
    isProvider: false,
    async action({ modRequest: { nextMod, ...modRequest }, ...rest }) {
      if (nextMod === undefined) {
        throw new Error(
          `withExtensionPrivacyManifests: the ${APPLE_TARGETS_PROJECT_MOD} mod chain has no next mod`,
        );
      }
      const results = await nextMod({ ...rest, modRequest });
      const fs = require('fs') as NodeFs;
      const path = require('path') as NodePath;
      for (const file of addExtensionPrivacyManifests(results.modResults)) {
        const target = path.join(modRequest.platformProjectRoot, file.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, file.contents);
      }
      edited = true;
      return results;
    },
  });
  return withFinalizedMod(withEdit, [
    'ios',
    (mod) => {
      if (!edited) {
        throw new Error(
          `withExtensionPrivacyManifests: @bacons/apple-targets' ${APPLE_TARGETS_PROJECT_MOD} ` +
            'mod never ran, so no extension got its privacy manifest; list the plugin before ' +
            "'@bacons/apple-targets' in app.config.ts, or move this edit to the chain that now " +
            'creates the targets',
        );
      }
      return Promise.resolve(mod);
    },
  ]);
};

export default withExtensionPrivacyManifests;
