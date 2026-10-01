/**
 * @jest-environment node
 *
 * The iOS entitlements after EVERY config plugin ran, per EAS profile (increment 11, ruling V3,
 * ADR 0008).
 *
 * `aps-environment` has three writers: `ios.entitlements` in app.config.ts, `expo-notifications`
 * and expo-widgets, which writes the literal `development` unconditionally. Only the whole chain
 * says which one wins, so this test runs Expo's own evaluation of it, `expo config --type
 * introspect` (getPrebuildConfigAsync plus compileModsAsync in introspection mode, the CLI in
 * @expo/cli), with each profile's `env` from eas.json and `EAS_BUILD=true` as a builder has it,
 * and parses the entitlements the chain produced. The nightly native-smoke workflow asserts the
 * same values on the files a real `expo prebuild` writes.
 *
 * Also asserted: the App Group is the variant's, and every extension (the expo-widgets extension
 * and the two watchOS shells, as EAS provisions them) carries exactly the app's group.
 */

import { PLACEHOLDER_WIDGET, VARIANT_IDENTITIES, type AppVariant } from '../app.config';

// Jest's CommonJS wrapper provides them; the app's tsconfig carries no Node types.
declare const __dirname: string;
declare const require: { resolve(id: string, options?: { paths: string[] }): string };

const childProcess = jest.requireActual<{
  execFileSync(
    file: string,
    args: readonly string[],
    options: { cwd: string; env: Record<string, string | undefined>; encoding: 'utf8' },
  ): string;
}>('child_process');
const fs = jest.requireActual<{ readFileSync(path: string, encoding: 'utf8'): string }>('fs');
const path = jest.requireActual<{ resolve(...parts: string[]): string }>('path');

const APP_ROOT = path.resolve(__dirname, '..');
const processEnv = (process as unknown as { env: Record<string, string | undefined> }).env;
const nodeBinary = (process as unknown as { execPath: string }).execPath;

interface Entitlements {
  readonly 'aps-environment'?: string;
  readonly 'com.apple.security.application-groups'?: string[];
}

interface AppExtension {
  readonly targetName: string;
  readonly bundleIdentifier: string;
  readonly entitlements: Entitlements;
}

interface IntrospectedConfig {
  readonly ios: { readonly entitlements: Entitlements };
  readonly plugins: unknown[];
  readonly extra: {
    readonly eas?: { build?: { experimental?: { ios?: { appExtensions?: AppExtension[] } } } };
  };
  readonly _internal: {
    readonly modResults: {
      readonly ios: {
        readonly entitlements: Entitlements;
        readonly infoPlist: Record<string, unknown>;
      };
    };
  };
}

function easProfileEnv(profile: AppVariant): Record<string, string> {
  const eas = JSON.parse(fs.readFileSync(path.resolve(APP_ROOT, 'eas.json'), 'utf8')) as {
    build: Record<string, { env?: Record<string, string> }>;
  };
  return eas.build[profile]?.env ?? {};
}

function introspect(profile: AppVariant): IntrospectedConfig {
  const cli = require.resolve('expo/bin/cli', { paths: [APP_ROOT] });
  const output = childProcess.execFileSync(
    nodeBinary,
    [cli, 'config', '--type', 'introspect', '--json'],
    {
      cwd: APP_ROOT,
      env: {
        ...processEnv,
        ...easProfileEnv(profile),
        EAS_BUILD: 'true',
        // From the EAS environment on a builder; a preview or production build refuses to
        // evaluate without it (review ruling G5).
        GOOGLE_IOS_CLIENT_ID: '123-abc.apps.googleusercontent.com',
        EXPO_NO_GIT_STATUS: '1',
        EXPO_NO_TELEMETRY: '1',
        PLANEAHEAD_ANDROID_WIDGETS: '',
      },
      encoding: 'utf8',
    },
  );
  return JSON.parse(output) as IntrospectedConfig;
}

const PROFILES: readonly [AppVariant, 'production' | 'development'][] = [
  ['production', 'production'],
  ['preview', 'production'],
  ['development', 'development'],
];

describe('iOS entitlements after the whole plugin chain', () => {
  const configs = new Map<AppVariant, IntrospectedConfig>();
  beforeAll(() => {
    for (const [profile] of PROFILES) {
      configs.set(profile, introspect(profile));
    }
  }, 120_000);

  function configOf(profile: AppVariant): IntrospectedConfig {
    const config = configs.get(profile);
    if (config === undefined) {
      throw new Error(`no introspected config for ${profile}`);
    }
    return config;
  }

  it.each(PROFILES)(
    'the %s profile ends with aps-environment %s, whatever expo-widgets wrote',
    (profile, expected) => {
      const config = configOf(profile);
      expect(easProfileEnv(profile)['APNS_ENVIRONMENT']).toBe(expected);
      expect(config._internal.modResults.ios.entitlements['aps-environment']).toBe(expected);
      // The provider writes the entitlements file from the chain's result and mirrors it here.
      expect(config.ios.entitlements['aps-environment']).toBe(expected);
    },
  );

  it.each(PROFILES)(
    'the %s profile gives the app, the widget extension and the watch shells one App Group',
    (profile) => {
      const config = configOf(profile);
      const bundleId = VARIANT_IDENTITIES[profile].bundleIdentifier;
      const group = `group.${bundleId}`;
      expect(
        config._internal.modResults.ios.entitlements['com.apple.security.application-groups'],
      ).toEqual([group]);

      const extensions = config.extra.eas?.build?.experimental?.ios?.appExtensions ?? [];
      expect(extensions.map((extension) => extension.targetName).sort()).toEqual([
        'ExpoWidgetsTarget',
        'PlaneAheadWatch',
        'PlaneAheadWatchWidget',
      ]);
      for (const extension of extensions) {
        expect(extension.bundleIdentifier.startsWith(`${bundleId}.`)).toBe(true);
        expect(extension.entitlements).toEqual({
          'com.apple.security.application-groups': [group],
        });
      }
      expect(extensions.find((e) => e.targetName === 'ExpoWidgetsTarget')?.bundleIdentifier).toBe(
        `${bundleId}.widgets`,
      );

      // The group expo-widgets' runtime reads from the app's Info.plist, and the token observers.
      const infoPlist = config._internal.modResults.ios.infoPlist;
      expect(infoPlist['ExpoWidgetsAppGroupIdentifier']).toBe(group);
      expect(infoPlist['ExpoWidgets_EnablePushNotifications']).toBe(true);
      expect(infoPlist['NSSupportsLiveActivities']).toBe(true);
    },
  );

  it('keeps the placeholder widget the only widgets[] entry the chain saw', () => {
    const plugins = configOf('production').plugins;
    const widgets = plugins.find(
      (plugin): plugin is [string, { widgets: { name: string }[] }] =>
        Array.isArray(plugin) && plugin[0] === 'expo-widgets',
    );
    expect(widgets?.[1].widgets.map((widget) => widget.name)).toEqual([PLACEHOLDER_WIDGET.name]);
  });
});
