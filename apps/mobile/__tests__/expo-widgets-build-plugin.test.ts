/**
 * plugins/withExpoWidgetsBuild.ts (increment 11 review, rulings Z11 and Z3; ADR 0008): the widget
 * extension's Release configuration is optimised and has no debug dylib, written AFTER
 * expo-widgets created the target, and expo-widgets is excluded from Android autolinking while
 * its Android widgets are off. The generated project is proven by a real prebuild
 * (`xcodebuild -showBuildSettings`, the nightly's ios-archive and android-archive steps); this
 * pins the edits and the order they run in.
 */

import type { ExpoConfig } from 'expo/config';
import {
  ANDROID_EXCLUDED_PACKAGES,
  WIDGETS_RELEASE_SETTINGS,
  WIDGETS_TARGET,
  excludeFromExpoAutolinking,
  setWidgetsReleaseSettings,
  withExpoWidgetsBuild,
  type XcodeProjectLike,
} from '../plugins/withExpoWidgetsBuild';

/** A project with expo-widgets' target as it writes it: the same settings in Debug and Release. */
function widgetsProject(): XcodeProjectLike & {
  settings(name: string): Record<string, unknown> | undefined;
} {
  const generated = { SWIFT_OPTIMIZATION_LEVEL: '"-Onone"', PRODUCT_NAME: '"$(TARGET_NAME)"' };
  const configurations: Record<string, unknown> = {
    D1: { isa: 'XCBuildConfiguration', name: 'Debug', buildSettings: { ...generated } },
    D1_comment: 'Debug',
    R1: { isa: 'XCBuildConfiguration', name: 'Release', buildSettings: { ...generated } },
    R1_comment: 'Release',
    APP_RELEASE: { isa: 'XCBuildConfiguration', name: 'Release', buildSettings: {} },
  };
  const lists: Record<string, unknown> = {
    L1: {
      buildConfigurations: [
        { value: 'D1', comment: 'Debug' },
        { value: 'R1', comment: 'Release' },
      ],
    },
  };
  return {
    pbxTargetByName: (name) => (name === WIDGETS_TARGET ? { buildConfigurationList: 'L1' } : null),
    pbxXCConfigurationList: () => lists,
    pbxXCBuildConfigurationSection: () => configurations,
    settings: (id) =>
      (configurations[id] as { buildSettings?: Record<string, unknown> }).buildSettings,
  };
}

const SETTINGS_GRADLE = `plugins {
  id("com.facebook.react.settings")
  id("expo-autolinking-settings")
}

expoAutolinking.useExpoModules()

rootProject.name = 'PlaneAhead'
include ':app'
`;

type Mod = (config: Record<string, unknown>) => Promise<Record<string, unknown>>;

function modsOf(config: ExpoConfig): Record<string, Record<string, Mod>> {
  return (config as unknown as { mods: Record<string, Record<string, Mod>> }).mods;
}

describe('withExpoWidgetsBuild', () => {
  it('optimises the extension Release configuration and drops its debug dylib', () => {
    const project = widgetsProject();
    setWidgetsReleaseSettings(project);
    expect(project.settings('R1')).toEqual({
      SWIFT_OPTIMIZATION_LEVEL: '"-O"',
      ENABLE_DEBUG_DYLIB: 'NO',
      PRODUCT_NAME: '"$(TARGET_NAME)"',
    });
    expect(WIDGETS_RELEASE_SETTINGS).toEqual({
      SWIFT_OPTIMIZATION_LEVEL: '"-O"',
      ENABLE_DEBUG_DYLIB: 'NO',
    });
    // Debug keeps what expo-widgets wrote; nothing else is touched.
    expect(project.settings('D1')?.['SWIFT_OPTIMIZATION_LEVEL']).toBe('"-Onone"');
    expect(project.settings('APP_RELEASE')).toEqual({});
  });

  it('fails the prebuild when the target it corrects is missing', () => {
    const project = widgetsProject();
    expect(() => {
      setWidgetsReleaseSettings({ ...project, pbxTargetByName: () => null });
    }).toThrow(/ExpoWidgetsTarget/);
  });

  it('edits the project after the mods registered before it, expo-widgets included', async () => {
    const project = widgetsProject();
    // expo-widgets' mod as the chain holds it when this plugin registers: it (re)writes -Onone,
    // so the result shows -O only if the correction ran after it.
    const expoWidgetsMod: Mod = (config) => {
      const release = project.settings('R1');
      if (release !== undefined) {
        release['SWIFT_OPTIMIZATION_LEVEL'] = '"-Onone"';
      }
      return Promise.resolve({ ...config, modResults: project });
    };
    const config = withExpoWidgetsBuild(
      {
        name: 'PlaneAhead',
        slug: 'planeahead',
        mods: { ios: { xcodeproj: expoWidgetsMod } },
      } as ExpoConfig,
      { enableAndroid: false },
    );
    const results = await modsOf(config)['ios']?.['xcodeproj']?.({
      modRequest: { platform: 'ios', modName: 'xcodeproj' },
      modResults: project,
    });
    expect(results?.['modResults']).toBe(project);
    expect(project.settings('R1')?.['SWIFT_OPTIMIZATION_LEVEL']).toBe('"-O"');
    expect(project.settings('R1')?.['ENABLE_DEBUG_DYLIB']).toBe('NO');
  });

  it('excludes expo-widgets from Android autolinking before useExpoModules, once', () => {
    expect(ANDROID_EXCLUDED_PACKAGES).toEqual(['expo-widgets']);
    const once = excludeFromExpoAutolinking(SETTINGS_GRADLE, ANDROID_EXCLUDED_PACKAGES);
    const lines = once.split('\n');
    const exclude = lines.indexOf("expoAutolinking.exclude = ['expo-widgets']");
    expect(exclude).toBeGreaterThan(0);
    expect(lines[exclude + 1]).toBe('expoAutolinking.useExpoModules()');
    expect(excludeFromExpoAutolinking(once, ANDROID_EXCLUDED_PACKAGES)).toBe(once);
    expect(() => excludeFromExpoAutolinking("include ':app'\n", ['expo-widgets'])).toThrow(
      /useExpoModules/,
    );
  });

  it('registers the Android exclusion only while enableAndroid is off', () => {
    const off = withExpoWidgetsBuild(
      { name: 'PlaneAhead', slug: 'planeahead' },
      {
        enableAndroid: false,
      },
    );
    expect(Object.keys(modsOf(off)['android'] ?? {})).toEqual(['settingsGradle']);
    const on = withExpoWidgetsBuild(
      { name: 'PlaneAhead', slug: 'planeahead' },
      {
        enableAndroid: true,
      },
    );
    expect(modsOf(on)['android']).toBeUndefined();
    // The iOS correction applies either way.
    expect(Object.keys(modsOf(on)['ios'] ?? {})).toEqual(['xcodeproj']);
  });
});
