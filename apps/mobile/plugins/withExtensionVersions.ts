/**
 * Every embedded bundle carries the app's version and build number (increment 13, ruling S3, and
 * its review round, ruling F6; docs/research/phase1/R5-store-distribution.md L4, L5, C4 and the
 * errata).
 *
 * App Store Connect and Xcode's `ValidateEmbeddedBinary` expect an extension's and a watch app's
 * `CFBundleShortVersionString` and `CFBundleVersion` to equal the containing app's. The app's come
 * from its Info.plist: Expo writes `version` and `ios.buildNumber` (or 1) there, and the EAS
 * builder then writes the build's own build number over it (its `configure.ts` rewrites the
 * Info.plist of every provisioned target). That rewrite does not reach the embedded targets: the
 * widget extension and both watch shells build with `GENERATE_INFOPLIST_FILE = YES`, and their
 * build settings, `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION`, win over the Info.plist the
 * builder rewrote (the store review built one with an Info.plist `CFBundleVersion` of 7 and got
 * 1). So this plugin sets both build settings of every target other than the app, in every build
 * configuration, to the numbers the store build will carry: `EAS_BUILD_IOS_APP_VERSION` and
 * `EAS_BUILD_IOS_BUILD_NUMBER` when present, which EAS exports to the whole build, prebuild
 * included (eas-cli packages/worker/src/env.ts), and the config's (`IOSConfig.Version.getVersion`
 * and `getBuildNumber`) otherwise. Never through `ios.buildNumber`: @expo/fingerprint hashes the
 * config by default, so a build number there would change the runtime version on every build.
 *
 * @bacons/apple-targets 5.0.0 hard-codes `MARKETING_VERSION = 1.0` for its watch targets
 * (build/configuration-list.js) and then, at the end of its own mod, sets every target's
 * `MARKETING_VERSION` to the config's version (`syncMarketingVersions` in
 * build/with-xcode-changes.js), so the short version was right by that side effect; the build
 * number matched only while EAS's number was 1. The native smoke's ios-prebuild gives the build
 * number 4242 the way EAS does, and ios-archive and ios-device-archive fail unless every embedded
 * bundle's `CFBundleShortVersionString` and `CFBundleVersion` equal the app's.
 *
 * Mechanism: a base mod on @bacons/apple-targets' own project chain (`xcodeProjectBeta2`) that
 * edits on the way back out, listed before '@bacons/apple-targets' in app.config.ts, for the
 * reasons plugins/withExtensionPrivacyManifests.ts gives; a finalized mod fails the prebuild if
 * that chain never ran.
 */

import { IOSConfig, withBaseMod, withFinalizedMod, type ConfigPlugin } from 'expo/config-plugins';

/** @bacons/apple-targets 5.0.0's project mod (build/with-bacons-xcode.js `customModName`). */
export const APPLE_TARGETS_PROJECT_MOD = 'xcodeProjectBeta2';

/** The parts of @bacons/xcode's project model (1.0.0-alpha.32) this plugin uses. */
export interface VersionedProject {
  readonly rootObject: {
    readonly props: {
      readonly targets: readonly {
        readonly isa: string;
        readonly props: {
          readonly name: string;
          readonly buildConfigurationList?: {
            readonly props: {
              readonly buildConfigurations: readonly {
                readonly props: { buildSettings?: Record<string, unknown> };
              }[];
            };
          };
        };
      }[];
    };
  };
}

export interface BundleVersions {
  /** The app target's name, the one target left alone. */
  readonly appTarget: string;
  /** `CFBundleShortVersionString`, as the store build's app carries it. */
  readonly version: string;
  /** `CFBundleVersion`, likewise. */
  readonly buildNumber: string;
}

/** What EAS exports to a build (eas-cli packages/worker/src/env.ts), as far as versions go. */
export interface EasVersionEnvironment {
  readonly EAS_BUILD_IOS_APP_VERSION?: string | undefined;
  readonly EAS_BUILD_IOS_BUILD_NUMBER?: string | undefined;
}

/** Apple's form of both keys: one to three period-separated integers. */
const APPLE_VERSION = /^\d+(\.\d+){0,2}$/;

/**
 * The version and build number the embedded targets get: EAS's when the build exports them, the
 * config's otherwise (an empty variable counts as unset). Throws on a value Apple would refuse.
 */
export function embeddedVersions(
  config: { readonly version: string; readonly buildNumber: string },
  env: EasVersionEnvironment,
): { version: string; buildNumber: string } {
  const pick = (name: keyof EasVersionEnvironment, fallback: string): string => {
    const value = env[name]?.trim();
    if (value === undefined || value === '') {
      return fallback;
    }
    if (!APPLE_VERSION.test(value)) {
      throw new Error(
        `withExtensionVersions: ${name} must be one to three period-separated integers; got "${value}"`,
      );
    }
    return value;
  };
  return {
    version: pick('EAS_BUILD_IOS_APP_VERSION', config.version),
    buildNumber: pick('EAS_BUILD_IOS_BUILD_NUMBER', config.buildNumber),
  };
}

/**
 * Sets `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` on every build configuration of every
 * native target other than the app, in place; returns the names of the targets it set. Throws
 * when the app target is missing (the project is not the one this plugin was written for) or a
 * target has no build configuration.
 */
export function alignExtensionVersions(
  project: VersionedProject,
  versions: BundleVersions,
): string[] {
  const targets = project.rootObject.props.targets.filter(({ isa }) => isa === 'PBXNativeTarget');
  if (!targets.some((target) => target.props.name === versions.appTarget)) {
    throw new Error(
      `withExtensionVersions: no ${versions.appTarget} app target in the Xcode project`,
    );
  }
  const embedded = targets.filter((target) => target.props.name !== versions.appTarget);
  for (const target of embedded) {
    const configurations = target.props.buildConfigurationList?.props.buildConfigurations ?? [];
    if (configurations.length === 0) {
      throw new Error(`withExtensionVersions: ${target.props.name} has no build configuration`);
    }
    for (const configuration of configurations) {
      configuration.props.buildSettings = {
        ...configuration.props.buildSettings,
        MARKETING_VERSION: versions.version,
        CURRENT_PROJECT_VERSION: versions.buildNumber,
      };
    }
  }
  return embedded.map((target) => target.props.name);
}

/** The build environment. This file runs in Node, whose types the app's tsconfig does not load. */
const buildEnv = (process as unknown as { env: EasVersionEnvironment }).env;

export const withExtensionVersions: ConfigPlugin = (config) => {
  let aligned = false;
  const withEdit = withBaseMod<VersionedProject>(config, {
    platform: 'ios',
    mod: APPLE_TARGETS_PROJECT_MOD,
    isProvider: false,
    async action({ modRequest: { nextMod, ...modRequest }, ...rest }) {
      if (nextMod === undefined) {
        throw new Error(
          `withExtensionVersions: the ${APPLE_TARGETS_PROJECT_MOD} mod chain has no next mod`,
        );
      }
      const results = await nextMod({ ...rest, modRequest });
      const appTarget = modRequest.projectName;
      if (appTarget === undefined) {
        throw new Error('withExtensionVersions: the mod request names no project');
      }
      alignExtensionVersions(results.modResults, {
        appTarget,
        ...embeddedVersions(
          {
            version: IOSConfig.Version.getVersion(results),
            buildNumber: IOSConfig.Version.getBuildNumber(results),
          },
          buildEnv,
        ),
      });
      aligned = true;
      return results;
    },
  });
  return withFinalizedMod(withEdit, [
    'ios',
    (mod) => {
      if (!aligned) {
        throw new Error(
          `withExtensionVersions: @bacons/apple-targets' ${APPLE_TARGETS_PROJECT_MOD} mod never ` +
            "ran, so the embedded targets' versions were not aligned; list the plugin before " +
            "'@bacons/apple-targets' in app.config.ts",
        );
      }
      return Promise.resolve(mod);
    },
  ]);
};

export default withExtensionVersions;
