/**
 * Every embedded bundle carries the app's version and build number (increment 13, ruling S3;
 * docs/research/phase1/R5-store-distribution.md L4, L5, C4).
 *
 * App Store Connect and Xcode's `ValidateEmbeddedBinary` expect an extension's and a watch app's
 * `CFBundleShortVersionString` and `CFBundleVersion` to equal the containing app's. EAS rewrites
 * only `CFBundleVersion` (its builder writes the remote build number into each provisioned
 * target's Info.plist, R5 L5), so the short version is the project's to get right. The app's
 * comes from `version` in app.config.ts; the targets' from their `MARKETING_VERSION` (the watch
 * shells' generated Info.plist) or from what expo-widgets writes into its Info.plist from the same
 * config. @bacons/apple-targets 5.0.0 hard-codes `MARKETING_VERSION = 1.0` for its watch targets
 * (build/configuration-list.js) and then, at the end of its own mod, sets every target's
 * `MARKETING_VERSION` to the config's version (`syncMarketingVersions` in
 * build/with-xcode-changes.js): the prebuild measured on 2026-09-30 has `0.1.0` everywhere, so
 * the mismatch R5 C4 feared does not occur with this pin. This plugin makes the rule the
 * project's own rather than a side effect of that function: after apple-targets' mod, it sets
 * `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` of every target other than the app to the
 * values Expo writes into the app's Info.plist (`IOSConfig.Version.getVersion` and
 * `getBuildNumber`: `ios.version` or `version`, and `ios.buildNumber` or 1), in every build
 * configuration. The native smoke's ios-archive and ios-device-archive steps fail unless every
 * embedded bundle's `CFBundleShortVersionString` and `CFBundleVersion` equal the app's.
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
  /** `CFBundleShortVersionString`, as Expo writes it into the app's Info.plist. */
  readonly version: string;
  /** `CFBundleVersion`, likewise. */
  readonly buildNumber: string;
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
        version: IOSConfig.Version.getVersion(results),
        buildNumber: IOSConfig.Version.getBuildNumber(results),
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
