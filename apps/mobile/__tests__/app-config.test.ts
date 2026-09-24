/**
 * app.config.ts (ruling P8, fix-round rulings S2 and S8): the three variants, the entitlements
 * with the APNs environment from the EAS profile, one universal-link host per variant, the
 * privacy manifest, the blocked Android permissions, the plugin order with withApsEnvironment
 * LAST (increment 11 made it real; __tests__/entitlements.test.ts evaluates it) and no MapLibre
 * plugin, scene support in expo-build-properties, the fingerprint runtime version and the React
 * Compiler off. Also the files that must agree with it: eas.json, the preview update workflow,
 * react-native.config.js, fingerprint.config.js (the Google services file stays out of the
 * runtime version, re-review expo-correctness-1) and the package scripts.
 */

import type { ConfigContext, ExpoConfig } from 'expo/config';
import appConfig, {
  apnsEnvironment,
  appVariant,
  BLOCKED_ANDROID_PERMISSIONS,
  reversedClientId,
} from '../app.config';

// Jest's CommonJS wrapper provides them; the app's tsconfig carries no Node types.
declare const __dirname: string;
declare const require: ((id: string) => unknown) & { resolve(id: string): string };

const fs = jest.requireActual<{
  readFileSync(path: string, encoding: 'utf8'): string;
  realpathSync(path: string): string;
}>('fs');
const path = jest.requireActual<{
  resolve(...parts: string[]): string;
  relative(from: string, to: string): string;
  dirname(path: string): string;
}>('path');
const APP_ROOT = path.resolve(__dirname, '..');

const env = (process as unknown as { env: Record<string, string | undefined> }).env;

function configFor(variant: string | undefined, extra: Record<string, string> = {}): ExpoConfig {
  const names = ['APP_VARIANT', ...Object.keys(extra)];
  const previous = new Map(names.map((name) => [name, env[name]]));
  if (variant === undefined) {
    delete env['APP_VARIANT'];
  } else {
    env['APP_VARIANT'] = variant;
  }
  Object.assign(env, extra);
  try {
    return appConfig({ config: {} } as ConfigContext);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete env[name];
      } else {
        env[name] = value;
      }
    }
  }
}

interface EasJson {
  build: Record<string, { environment?: string; env?: Record<string, string> }>;
}

function easJson(): EasJson {
  return JSON.parse(fs.readFileSync(path.resolve(APP_ROOT, 'eas.json'), 'utf8')) as EasJson;
}

function pluginNames(config: ExpoConfig): string[] {
  return (config.plugins ?? []).map((plugin) =>
    typeof plugin === 'string' ? plugin : String((plugin as unknown[])[0]),
  );
}

describe('app.config.ts', () => {
  it.each([
    ['production', 'app.planeahead.mobile', 'PlaneAhead', 'production'],
    ['preview', 'app.planeahead.mobile.preview', 'PlaneAhead Preview', 'production'],
    ['development', 'app.planeahead.mobile.dev', 'PlaneAhead Dev', 'development'],
  ])('builds the %s variant as its EAS profile does', (variant, bundleId, name, aps) => {
    const profileEnv = easJson().build[variant]?.env ?? {};
    const config = configFor(variant, { ...profileEnv, EAS_BUILD: 'true' });
    expect(config.name).toBe(name);
    expect(config.ios?.bundleIdentifier).toBe(bundleId);
    expect(config.android?.package).toBe(bundleId);
    expect(config.ios?.entitlements).toEqual({
      'com.apple.security.application-groups': [`group.${bundleId}`],
      'aps-environment': aps,
    });
    expect(config.extra?.['variant']).toBe(variant);
    expect(config.extra?.['apnsEnvironment']).toBe(aps);
    const plugins = config.plugins ?? [];
    expect(plugins).toContainEqual(['expo-notifications', { mode: aps }]);
    expect(plugins.at(-1)).toEqual(['./plugins/withApsEnvironment.ts', { apsEnvironment: aps }]);
  });

  it('takes the APNs environment from the signing, not the variant', () => {
    // A local build is development signed, whatever the variant.
    expect(configFor('production').ios?.entitlements?.['aps-environment']).toBe('development');
    // An ad hoc preview build registers with production APNs.
    expect(
      configFor('preview', { APNS_ENVIRONMENT: 'production' }).ios?.entitlements?.[
        'aps-environment'
      ],
    ).toBe('production');
    // On an EAS builder the profile must say which.
    expect(() => apnsEnvironment(undefined, true)).toThrow(/APNS_ENVIRONMENT/);
    expect(() => apnsEnvironment('sandbox', false)).toThrow(/APNS_ENVIRONMENT/);
    expect(apnsEnvironment(undefined, false)).toBe('development');
  });

  it('gives every EAS profile its EAS environment and APNS_ENVIRONMENT by distribution', () => {
    const { build } = easJson();
    expect(build['development']).toMatchObject({
      environment: 'development',
      env: { APP_VARIANT: 'development', APNS_ENVIRONMENT: 'development' },
    });
    expect(build['preview']).toMatchObject({
      environment: 'preview',
      env: { APP_VARIANT: 'preview', APNS_ENVIRONMENT: 'production' },
    });
    expect(build['production']).toMatchObject({
      environment: 'production',
      env: { APP_VARIANT: 'production', APNS_ENVIRONMENT: 'production' },
    });
  });

  it('publishes preview updates with the preview build inputs, to the preview branch', () => {
    const workflow = fs.readFileSync(
      path.resolve(APP_ROOT, '..', '..', '.github', 'workflows', 'mobile-preview.yml'),
      'utf8',
    );
    for (const [name, value] of Object.entries(easJson().build['preview']?.env ?? {})) {
      expect(workflow).toMatch(new RegExp(`^ {6}${name}: '?${value}'?$`, 'm'));
    }
    expect(workflow).toMatch(
      /run: eas update --auto --branch preview --environment preview --non-interactive/,
    );
  });

  it('runs the development variant from the local package scripts', () => {
    const { scripts } = JSON.parse(
      fs.readFileSync(path.resolve(APP_ROOT, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    for (const name of ['start', 'ios', 'android', 'prebuild']) {
      expect(scripts[name]).toMatch(/^APP_VARIANT=development expo /);
    }
  });

  it('defaults to production and refuses an unknown variant', () => {
    expect(configFor(undefined).ios?.bundleIdentifier).toBe('app.planeahead.mobile');
    expect(appVariant('')).toBe('production');
    expect(() => appVariant('staging')).toThrow(/APP_VARIANT/);
  });

  it.each([
    ['production', 'api.planeahead.app'],
    ['preview', 'api.planeahead.app'],
    ['development', 'api-staging.planeahead.app'],
  ])(
    'the %s variant claims the magic-link path on %s only, and talks to that API',
    (variant, host) => {
      const config = configFor(variant);
      expect(config.ios?.associatedDomains).toEqual([`applinks:${host}`]);
      expect(config.android?.intentFilters).toEqual([
        {
          action: 'VIEW',
          autoVerify: true,
          data: [{ scheme: 'https', host, pathPrefix: '/auth/magic-link' }],
          category: ['BROWSABLE', 'DEFAULT'],
        },
      ]);
      expect(config.extra?.['universalLinkHosts']).toEqual([host]);
      expect(config.extra?.['apiUrl']).toBe(`https://${host}`);
    },
  );

  it('blocks the Android permissions the app never uses and drops the Face ID string', () => {
    const config = configFor('production');
    expect(config.android?.blockedPermissions).toEqual([...BLOCKED_ANDROID_PERMISSIONS]);
    expect(BLOCKED_ANDROID_PERMISSIONS).toEqual([
      'android.permission.SYSTEM_ALERT_WINDOW',
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.USE_BIOMETRIC',
      'android.permission.USE_FINGERPRINT',
    ]);
    expect(config.plugins).toContainEqual(['expo-secure-store', { faceIDPermission: false }]);
  });

  it('keeps MapLibre a dependency that is not linked (no location permission, no pod)', () => {
    const rnConfig = require(path.resolve(APP_ROOT, 'react-native.config.js')) as {
      dependencies: Record<string, { platforms: Record<string, null> }>;
    };
    expect(rnConfig.dependencies['@maplibre/maplibre-react-native']).toEqual({
      platforms: { ios: null, android: null },
    });
    expect(pluginNames(configFor('production'))).not.toContain('@maplibre/maplibre-react-native');
  });

  it('keeps the spec plugin order with withApsEnvironment last and scene support in build properties', () => {
    const config = configFor('production', { APNS_ENVIRONMENT: 'production' });
    expect(pluginNames(config)).toEqual([
      'expo-router',
      'expo-build-properties',
      'expo-sqlite',
      'expo-secure-store',
      'expo-apple-authentication',
      'react-native-nitro-google-signin',
      '@sentry/react-native/expo',
      'expo-notifications',
      // Increment 11 (ADR 0008): the widget extension, the watchOS shells, the Wear OS module.
      'expo-widgets',
      '@bacons/apple-targets',
      './plugins/withWearApp.ts',
      './plugins/withApsEnvironment.ts',
    ]);
    const buildProperties = config.plugins?.[1] as [string, { ios: Record<string, unknown> }];
    expect(buildProperties[1].ios).toMatchObject({
      enableSceneSupport: true,
      privacyManifestAggregationEnabled: true,
    });
    expect(config.plugins?.[7]).toEqual(['expo-notifications', { mode: 'production' }]);
  });

  it('leaves the Google services file out of the runtime fingerprint, wherever the build put it', () => {
    const { googleServicesIgnorePaths, ignorePaths } = require(
      path.resolve(APP_ROOT, 'fingerprint.config.js'),
    ) as {
      ignorePaths: string[];
      googleServicesIgnorePaths(env: Record<string, string>, projectRoot?: string): string[];
    };
    // The matcher @expo/fingerprint applies to every file source, reached through expo's own
    // re-export (the package is not a direct dependency under the isolated linker).
    const { isIgnoredPath } = jest.requireActual<{
      isIgnoredPath(filePath: string, ignorePaths: string[]): boolean;
    }>(
      path.resolve(
        fs.realpathSync(path.dirname(require.resolve('expo/fingerprint'))),
        '..',
        '@expo',
        'fingerprint',
        'build',
        'utils',
        'Path.js',
      ),
    );

    // On an EAS builder the file variable is an absolute path outside the project, which the
    // sourcer records relative to the project root (`../../...`).
    const builderRoot = '/home/expo/workingdir/build/apps/mobile';
    const builderFile = '/home/expo/workingdir/environment-secrets/GOOGLE_SERVICES_JSON';
    const onBuilder = googleServicesIgnorePaths({ GOOGLE_SERVICES_JSON: builderFile }, builderRoot);
    expect(onBuilder).toContain('**/environment-secrets/GOOGLE_SERVICES_JSON');
    expect(isIgnoredPath(path.relative(builderRoot, builderFile), onBuilder)).toBe(true);
    // A file kept in the project for a local build, by its own name or the conventional one.
    const local = googleServicesIgnorePaths({ GOOGLE_SERVICES_JSON: './firebase.dev.json' });
    expect(isIgnoredPath('firebase.dev.json', local)).toBe(true);
    expect(isIgnoredPath('google-services.dev.json', googleServicesIgnorePaths({}))).toBe(true);
    // Nothing else the config names.
    for (const kept of ['app.config.ts', 'assets/icon-production.png', 'eas.json']) {
      expect(isIgnoredPath(kept, onBuilder)).toBe(false);
    }
    // Under `eas update` the variable is unset: the static entries alone, and the same list the
    // config exports for this process.
    expect(googleServicesIgnorePaths({})).toEqual([
      '**/google-services*.json',
      '**/GoogleService-Info*.plist',
    ]);
    expect(ignorePaths).toEqual(googleServicesIgnorePaths(process.env));
  });

  it('adds the Firebase config for FCM only when GOOGLE_SERVICES_JSON names one', () => {
    expect(configFor('development').android).not.toHaveProperty('googleServicesFile');
    env['GOOGLE_SERVICES_JSON'] = './google-services.dev.json';
    try {
      expect(configFor('development').android?.googleServicesFile).toBe(
        './google-services.dev.json',
      );
    } finally {
      delete env['GOOGLE_SERVICES_JSON'];
    }
  });

  it('uses the fingerprint runtime version, the React Compiler off, NSSupportsLiveActivities on', () => {
    const config = configFor('production');
    expect(config.runtimeVersion).toEqual({ policy: 'fingerprint' });
    expect(config.experiments?.reactCompiler).toBe(false);
    expect(config.ios?.infoPlist?.['NSSupportsLiveActivities']).toBe(true);
    expect(config.scheme).toBe('planeahead');
  });

  it('declares the required-reason APIs and the collected data in the privacy manifest', () => {
    const manifest = configFor('production').ios?.privacyManifests;
    const reasons = Object.fromEntries(
      (manifest?.NSPrivacyAccessedAPITypes ?? []).map((entry) => [
        entry.NSPrivacyAccessedAPIType,
        entry.NSPrivacyAccessedAPITypeReasons,
      ]),
    );
    expect(reasons).toEqual({
      NSPrivacyAccessedAPICategoryUserDefaults: ['CA92.1', '1C8F.1'],
      NSPrivacyAccessedAPICategoryFileTimestamp: ['C617.1'],
      NSPrivacyAccessedAPICategoryDiskSpace: ['E174.1'],
      NSPrivacyAccessedAPICategorySystemBootTime: ['35F9.1'],
    });
    expect(manifest?.NSPrivacyTracking).toBe(false);
    const collected = Object.fromEntries(
      (manifest?.NSPrivacyCollectedDataTypes ?? []).map((entry) => [
        entry.NSPrivacyCollectedDataType.replace('NSPrivacyCollectedDataType', ''),
        {
          linked: entry.NSPrivacyCollectedDataTypeLinked,
          tracking: entry.NSPrivacyCollectedDataTypeTracking,
          purposes: entry.NSPrivacyCollectedDataTypePurposes.map((purpose) =>
            purpose.replace('NSPrivacyCollectedDataTypePurpose', ''),
          ),
        },
      ]),
    );
    const functionality = { linked: true, tracking: false, purposes: ['AppFunctionality'] };
    expect(collected).toEqual({
      // The install id is registered under the account: the Device ID type is Linked.
      DeviceID: { linked: true, tracking: false, purposes: ['AppFunctionality', 'Analytics'] },
      EmailAddress: functionality,
      UserID: functionality,
      Name: functionality,
      CrashData: { linked: false, tracking: false, purposes: ['AppFunctionality'] },
    });
  });

  it('reverses the Google iOS client id into the URL scheme the plugin requires', () => {
    expect(reversedClientId('123-abc.apps.googleusercontent.com')).toBe(
      'com.googleusercontent.apps.123-abc',
    );
    expect(() => reversedClientId('not-a-client-id')).toThrow(/GOOGLE_IOS_CLIENT_ID/);
  });
});
