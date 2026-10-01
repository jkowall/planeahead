/**
 * @jest-environment node
 *
 * The iOS entitlements after EVERY config plugin ran, per EAS profile (increment 11, ruling V3,
 * ADR 0008).
 *
 * `aps-environment` has two writers: `ios.entitlements` in app.config.ts and expo-widgets, which
 * writes the literal `development` unconditionally (`expo-notifications` writes its `mode` only
 * where the key is absent, R2 conflict 9). Only the whole chain says which one wins, so this test
 * runs Expo's own evaluation of it, `expo config --type introspect` (getPrebuildConfigAsync plus
 * compileModsAsync in introspection mode, the CLI in @expo/cli), with each profile's `env` from
 * eas.json and `EAS_BUILD=true` as a builder has it, and parses the entitlements the chain
 * produced. The nightly native-smoke workflow asserts the same values on the files a real `expo
 * prebuild` writes.
 *
 * Also asserted: the App Group is the variant's, and every extension (the expo-widgets extension
 * and the two watchOS shells, as EAS provisions them) carries exactly the app's group; the app
 * keeps the time-sensitive entitlement (increment 16, ruling C8); and, from the same evaluation,
 * the Android manifest carries what expo-notifications writes from its icon, colour and default
 * channel (rulings C4 and C5), which proves the plugin read them.
 */

import { ANDROID_CHANNEL_IDS } from '@planeahead/shared';
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
  readonly 'com.apple.developer.usernotifications.time-sensitive'?: boolean;
}

/** An Android resource element as the mods hold it (xml2js): attributes in `$`, text in `_`. */
interface XmlElement {
  readonly $: Record<string, string | undefined>;
  readonly _?: string;
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
      readonly android: {
        readonly manifest: {
          readonly manifest: { readonly application: { readonly 'meta-data'?: XmlElement[] }[] };
        };
        readonly colors: { readonly resources: { readonly color?: XmlElement[] } };
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

  it.each(PROFILES)('the %s profile keeps the time-sensitive entitlement (C8)', (profile) => {
    const config = configOf(profile);
    const key = 'com.apple.developer.usernotifications.time-sensitive';
    expect(config._internal.modResults.ios.entitlements[key]).toBe(true);
    expect(config.ios.entitlements[key]).toBe(true);
  });

  it.each(PROFILES)(
    'the %s profile gives Android the notification icon, colour and channel (C4, C5)',
    (profile) => {
      const { manifest, colors } = configOf(profile)._internal.modResults.android;
      const metaData = Object.fromEntries(
        (manifest.manifest.application[0]?.['meta-data'] ?? []).map(({ $ }) => [
          $['android:name'] ?? '',
          $['android:resource'] ?? $['android:value'],
        ]),
      );
      // FCM's keys serve a notification FCM displays itself (the app in the background), expo's
      // one the app presents; the plugin writes both from the same props (R2 fact 41).
      expect(metaData).toMatchObject({
        'com.google.firebase.messaging.default_notification_icon': '@drawable/notification_icon',
        'com.google.firebase.messaging.default_notification_color':
          '@color/notification_icon_color',
        'com.google.firebase.messaging.default_notification_channel_id':
          ANDROID_CHANNEL_IDS.flightChanges,
        'expo.modules.notifications.default_notification_icon': '@drawable/notification_icon',
        'expo.modules.notifications.default_notification_color': '@color/notification_icon_color',
      });
      const accent = (colors.resources.color ?? []).find(
        ({ $ }) => $['name'] === 'notification_icon_color',
      );
      expect(accent?._).toBe(VARIANT_IDENTITIES[profile].adaptiveBackground);
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
