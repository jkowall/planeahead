/**
 * app.config.ts (ruling P8): the three variants, the entitlements and associated domains, the
 * magic-link intent filter, the privacy manifest, the plugin order with the reserved
 * withApsEnvironment slot LAST, scene support in expo-build-properties, the fingerprint runtime
 * version, and the React Compiler off.
 */

import type { ConfigContext, ExpoConfig } from 'expo/config';
import appConfig, { appVariant, reversedClientId } from '../app.config';

const env = (process as unknown as { env: Record<string, string | undefined> }).env;

function configFor(variant: string | undefined): ExpoConfig {
  const previous = env['APP_VARIANT'];
  if (variant === undefined) {
    delete env['APP_VARIANT'];
  } else {
    env['APP_VARIANT'] = variant;
  }
  try {
    return appConfig({ config: {} } as ConfigContext);
  } finally {
    if (previous === undefined) {
      delete env['APP_VARIANT'];
    } else {
      env['APP_VARIANT'] = previous;
    }
  }
}

function pluginNames(config: ExpoConfig): string[] {
  return (config.plugins ?? []).map((plugin) =>
    typeof plugin === 'string' ? plugin : String((plugin as unknown[])[0]),
  );
}

describe('app.config.ts', () => {
  it.each([
    ['production', 'app.planeahead.mobile', 'PlaneAhead', 'production'],
    ['preview', 'app.planeahead.mobile.preview', 'PlaneAhead Preview', 'development'],
    ['development', 'app.planeahead.mobile.dev', 'PlaneAhead Dev', 'development'],
  ])('builds the %s variant', (variant, bundleId, name, aps) => {
    const config = configFor(variant);
    expect(config.name).toBe(name);
    expect(config.ios?.bundleIdentifier).toBe(bundleId);
    expect(config.android?.package).toBe(bundleId);
    expect(config.ios?.entitlements).toEqual({
      'com.apple.security.application-groups': [`group.${bundleId}`],
      'aps-environment': aps,
    });
    expect(config.extra?.['variant']).toBe(variant);
  });

  it('defaults to production and refuses an unknown variant', () => {
    expect(configFor(undefined).ios?.bundleIdentifier).toBe('app.planeahead.mobile');
    expect(appVariant('')).toBe('production');
    expect(() => appVariant('staging')).toThrow(/APP_VARIANT/);
  });

  it('claims the magic-link path on both API hosts, as universal links and verified App Links', () => {
    const config = configFor('development');
    expect(config.ios?.associatedDomains).toEqual([
      'applinks:api.planeahead.app',
      'applinks:api-staging.planeahead.app',
    ]);
    expect(config.android?.intentFilters).toEqual([
      {
        action: 'VIEW',
        autoVerify: true,
        data: [
          { scheme: 'https', host: 'api.planeahead.app', pathPrefix: '/auth/magic-link' },
          { scheme: 'https', host: 'api-staging.planeahead.app', pathPrefix: '/auth/magic-link' },
        ],
        category: ['BROWSABLE', 'DEFAULT'],
      },
    ]);
  });

  it('keeps the plugin order with withApsEnvironment last and scene support in build properties', () => {
    const config = configFor('production');
    expect(pluginNames(config)).toEqual([
      'expo-router',
      'expo-build-properties',
      'expo-sqlite',
      'expo-secure-store',
      'expo-apple-authentication',
      'react-native-nitro-google-signin',
      '@sentry/react-native/expo',
      'expo-notifications',
      '@maplibre/maplibre-react-native',
      './plugins/withApsEnvironment.ts',
    ]);
    const buildProperties = config.plugins?.[1] as [string, { ios: Record<string, unknown> }];
    expect(buildProperties[1].ios).toMatchObject({
      enableSceneSupport: true,
      privacyManifestAggregationEnabled: true,
    });
    expect(config.plugins?.[7]).toEqual(['expo-notifications', { mode: 'production' }]);
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

  it('declares the required-reason APIs and the install id in the privacy manifest', () => {
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
    expect(manifest?.NSPrivacyCollectedDataTypes).toContainEqual({
      NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeDeviceID',
      NSPrivacyCollectedDataTypeLinked: false,
      NSPrivacyCollectedDataTypeTracking: false,
      NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAnalytics'],
    });
  });

  it('reverses the Google iOS client id into the URL scheme the plugin requires', () => {
    expect(reversedClientId('123-abc.apps.googleusercontent.com')).toBe(
      'com.googleusercontent.apps.123-abc',
    );
    expect(() => reversedClientId('not-a-client-id')).toThrow(/GOOGLE_IOS_CLIENT_ID/);
  });
});
