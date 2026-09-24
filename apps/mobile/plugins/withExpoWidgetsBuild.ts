/**
 * Two build-level corrections to what expo-widgets 57.0.20 generates, under its exact pin
 * (increment 11 review, rulings Z11 and Z3; ADR 0008). Listed right after `expo-widgets` in
 * app.config.ts; both are upstream generator behaviour, recorded rather than patched in the
 * package.
 *
 * iOS: the widget extension's Release configuration. expo-widgets writes the same build settings
 * into Debug and Release of `ExpoWidgetsTarget` (plugin/build/ios/xcode/addXCConfigurationList.js),
 * `SWIFT_OPTIMIZATION_LEVEL = "-Onone"` included, and Xcode then defaults `ENABLE_DEBUG_DYLIB` to
 * YES for it, so a Release product carried an unoptimised extension split into a 40 KB stub,
 * `ExpoWidgetsTarget.debug.dylib` (8 MB) and `__preview.dylib`: the preview layout, inside a
 * WidgetKit extension that runs under a tight memory limit. This plugin sets `-O` and
 * `ENABLE_DEBUG_DYLIB = NO` on that one configuration. It is a base mod that runs the rest of the
 * `xcodeproj` chain FIRST and edits on the way back out, like withApsEnvironment, so it edits the
 * project after expo-widgets created the target whatever order the plugins registered in (a plain
 * `withXcodeProject` here would run before expo-widgets' own mod: mods registered later run
 * first). @bacons/apple-targets rewrites the project after that in its own mod
 * (`xcodeProjectBeta2`), which keeps build settings. The nightly's ios-archive step fails on any
 * debug dylib in the Release app.
 *
 * Android: expo-widgets out of autolinking while its Android widgets are off. expo-widgets'
 * Android module is autolinked into every Android build whatever `enableAndroid` says, and it
 * brings `androidx.glance` 1.2.0-rc01 and, through it, `androidx.work` 2.7.1: the
 * `FOREGROUND_SERVICE` permission, WorkManager's startup initializer (its database opened on
 * every launch), its foreground and job services, and Glance's receivers, in a production
 * manifest that uses none of them. The app's JavaScript does not need the native module on
 * Android: expo-widgets resolves `build/ExpoWidgets.js` there, a pure stub that never calls
 * `requireNativeModule`. So while `enableAndroid` is off, settings.gradle tells Expo's autolinking
 * to exclude the package (`expoAutolinking.exclude`, read by `useExpoModules()` for the Gradle
 * projects and the generated package list alike). The `PLANEAHEAD_ANDROID_WIDGETS=1` trial turns
 * `enableAndroid` on and this exclusion off with the same flag, so the trial needs no hand edit.
 * The nightly's android-archive step asserts the manifest carries no WorkManager or Glance
 * component and exactly the expected permissions.
 */

import { withBaseMod, withSettingsGradle, type ConfigPlugin } from 'expo/config-plugins';

export interface ExpoWidgetsBuildProps {
  /** expo-widgets' `enableAndroid`, from the same `PLANEAHEAD_ANDROID_WIDGETS` flag. */
  readonly enableAndroid: boolean;
}

/** The target expo-widgets 57.0.20 creates (its name is fixed in the plugin). */
export const WIDGETS_TARGET = 'ExpoWidgetsTarget';

/** The Release build settings the extension gets; values as they are written into the pbxproj. */
export const WIDGETS_RELEASE_SETTINGS = {
  SWIFT_OPTIMIZATION_LEVEL: '"-O"',
  ENABLE_DEBUG_DYLIB: 'NO',
} as const;

/** The package kept out of Android autolinking while its Android widgets are off. */
export const ANDROID_EXCLUDED_PACKAGES = ['expo-widgets'] as const;

/** The parts of the `xcode` package's project model this plugin reads. */
export interface XcodeProjectLike {
  pbxTargetByName(name: string): { buildConfigurationList?: string } | null | undefined;
  pbxXCConfigurationList(): Record<string, unknown>;
  pbxXCBuildConfigurationSection(): Record<string, unknown>;
}

interface BuildConfiguration {
  name?: string;
  buildSettings?: Record<string, unknown>;
}

function unquote(value: string | undefined): string | undefined {
  return value?.replace(/^"(.*)"$/, '$1');
}

/**
 * Sets `WIDGETS_RELEASE_SETTINGS` on the Release configuration of `WIDGETS_TARGET`, in place.
 * Throws when the target or its Release configuration is missing: a renamed target must fail the
 * prebuild, not silently ship the debug layout again.
 */
export function setWidgetsReleaseSettings(project: XcodeProjectLike): void {
  const target = project.pbxTargetByName(WIDGETS_TARGET);
  const listId = target?.buildConfigurationList;
  if (listId === undefined) {
    throw new Error(`withExpoWidgetsBuild: no ${WIDGETS_TARGET} target in the Xcode project`);
  }
  const list = project.pbxXCConfigurationList()[listId] as
    { buildConfigurations?: { value: string }[] } | undefined;
  const configurations = project.pbxXCBuildConfigurationSection();
  const release = (list?.buildConfigurations ?? [])
    .map(({ value }) => configurations[value])
    .find(
      (configuration): configuration is BuildConfiguration =>
        typeof configuration === 'object' &&
        configuration !== null &&
        unquote((configuration as BuildConfiguration).name) === 'Release',
    );
  if (release === undefined) {
    throw new Error(`withExpoWidgetsBuild: ${WIDGETS_TARGET} has no Release configuration`);
  }
  release.buildSettings = { ...release.buildSettings, ...WIDGETS_RELEASE_SETTINGS };
}

/** The line in the template's settings.gradle that runs Expo's autolinking. */
const USE_EXPO_MODULES = 'expoAutolinking.useExpoModules()';

/**
 * Inserts `expoAutolinking.exclude = [...]` before `useExpoModules()`, once. Throws when the
 * template no longer has that call, rather than silently linking the package again.
 */
export function excludeFromExpoAutolinking(
  settingsGradle: string,
  packages: readonly string[],
): string {
  const exclude = `expoAutolinking.exclude = [${packages.map((name) => `'${name}'`).join(', ')}]`;
  if (settingsGradle.includes(exclude)) {
    return settingsGradle;
  }
  if (!settingsGradle.includes(USE_EXPO_MODULES)) {
    throw new Error(`withExpoWidgetsBuild: settings.gradle has no ${USE_EXPO_MODULES}`);
  }
  const comment =
    '// plugins/withExpoWidgetsBuild.ts: expo-widgets stays unlinked on Android while its ' +
    'Android widgets are off (ADR 0008)';
  return settingsGradle.replace(USE_EXPO_MODULES, `${comment}\n${exclude}\n${USE_EXPO_MODULES}`);
}

export const withExpoWidgetsBuild: ConfigPlugin<ExpoWidgetsBuildProps> = (config, props) => {
  const withRelease = withBaseMod<XcodeProjectLike>(config, {
    platform: 'ios',
    mod: 'xcodeproj',
    isProvider: false,
    async action({ modRequest: { nextMod, ...modRequest }, ...rest }) {
      if (nextMod === undefined) {
        throw new Error('withExpoWidgetsBuild: the xcodeproj mod chain has no next mod');
      }
      const results = await nextMod({ ...rest, modRequest });
      setWidgetsReleaseSettings(results.modResults);
      return results;
    },
  });
  if (props.enableAndroid) {
    return withRelease;
  }
  return withSettingsGradle(withRelease, (mod) => {
    mod.modResults.contents = excludeFromExpoAutolinking(
      mod.modResults.contents,
      ANDROID_EXCLUDED_PACKAGES,
    );
    return mod;
  });
};

export default withExpoWidgetsBuild;
