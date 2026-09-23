/**
 * The Expo app config for all three variants (ADR 0001, ADR 0005).
 *
 * `APP_VARIANT` picks one of `production` (the default), `preview` or `development`. Each variant
 * is a separate app on a device: its own bundle identifier and Android package, its own name and
 * icon, its own App Group. The three identifiers are immutable once a build reaches a store, so
 * they are spelled out once, here, and ADR 0005 records them.
 *
 * Nothing secret lives in this file or in `extra`: everything in `extra` ships inside the app.
 * The Google client ids, the Sentry DSN and the EAS project id are public identifiers read from
 * the build environment, with placeholders that keep `expo prebuild` and a local compile working
 * before the owner has created them (apps/mobile/README.md, owner tasks).
 *
 * Plugin order is load bearing (docs/increments/09-mobile-scaffold.md): `ios.entitlements` is
 * applied before every plugin, `expo-notifications` then writes `aps-environment` from its `mode`,
 * and increment 11's expo-widgets writes the literal `development` again, which is why the local
 * `withApsEnvironment` plugin is reserved as the LAST entry.
 */

import type { ConfigContext, ExpoConfig } from 'expo/config';
import type { ApsEnvironmentProps } from './plugins/withApsEnvironment';

export const APP_VARIANTS = ['production', 'preview', 'development'] as const;
export type AppVariant = (typeof APP_VARIANTS)[number];

interface VariantIdentity {
  readonly bundleIdentifier: string;
  readonly name: string;
  readonly icon: string;
  readonly adaptiveBackground: string;
  /** Where the app's API lives unless `PLANEAHEAD_API_URL` overrides it (a local wrangler dev). */
  readonly apiUrl: string;
}

export const VARIANT_IDENTITIES: Readonly<Record<AppVariant, VariantIdentity>> = {
  production: {
    bundleIdentifier: 'app.planeahead.mobile',
    name: 'PlaneAhead',
    icon: './assets/icon-production.png',
    adaptiveBackground: '#1C4FD6',
    apiUrl: 'https://api.planeahead.app',
  },
  preview: {
    bundleIdentifier: 'app.planeahead.mobile.preview',
    name: 'PlaneAhead Preview',
    icon: './assets/icon-preview.png',
    adaptiveBackground: '#6D28D9',
    apiUrl: 'https://api-staging.planeahead.app',
  },
  development: {
    bundleIdentifier: 'app.planeahead.mobile.dev',
    name: 'PlaneAhead Dev',
    icon: './assets/icon-development.png',
    adaptiveBackground: '#B45309',
    apiUrl: 'https://api-staging.planeahead.app',
  },
};

/** The hosts whose `/.well-known` files the API Worker serves (apps/api/src/routes/well-known.ts). */
export const UNIVERSAL_LINK_HOSTS = ['api.planeahead.app', 'api-staging.planeahead.app'] as const;

/**
 * The path the emailed magic link opens (apps/api/src/auth/paths.ts MAGIC_LINK_LANDING_PATH).
 * Effectively permanent: Apple's CDN caches the association file, so narrowing it later needs a
 * store release (docs/build-log.md, increment 5 ruling G3 moved it here from /api/auth).
 */
export const MAGIC_LINK_PATH = '/auth/magic-link';

/** Google's iOS URL scheme is the iOS client id reversed; the plugin refuses anything else. */
const PLACEHOLDER_GOOGLE_IOS_CLIENT_ID = '000000000000-placeholder.apps.googleusercontent.com';

export function appVariant(value: string | undefined): AppVariant {
  const variant = value === undefined || value === '' ? 'production' : value;
  if (!(APP_VARIANTS as readonly string[]).includes(variant)) {
    throw new Error(`APP_VARIANT must be one of ${APP_VARIANTS.join(', ')}; got "${variant}"`);
  }
  return variant as AppVariant;
}

export function reversedClientId(clientId: string): string {
  const suffix = '.apps.googleusercontent.com';
  if (!clientId.endsWith(suffix)) {
    throw new Error(`GOOGLE_IOS_CLIENT_ID must end with ${suffix}; got "${clientId}"`);
  }
  return `com.googleusercontent.apps.${clientId.slice(0, -suffix.length)}`;
}

/** The build environment. This file runs in Node, whose types the app's tsconfig does not load. */
const buildEnv = (process as unknown as { env: Record<string, string | undefined> }).env;

function env(name: string): string | undefined {
  const value = buildEnv[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const variant = appVariant(env('APP_VARIANT'));
  const identity = VARIANT_IDENTITIES[variant];
  const appGroup = `group.${identity.bundleIdentifier}`;
  const apsEnvironment = variant === 'production' ? 'production' : 'development';
  const googleIosClientId = env('GOOGLE_IOS_CLIENT_ID') ?? PLACEHOLDER_GOOGLE_IOS_CLIENT_ID;
  const easProjectId = env('EAS_PROJECT_ID');
  const sentryOrganization = env('SENTRY_ORG');
  const sentryProject = env('SENTRY_PROJECT');

  return {
    ...config,
    name: identity.name,
    slug: 'planeahead',
    // No web target: react-dom is installed only to satisfy peers in expo-router's tree.
    platforms: ['ios', 'android'],
    scheme: 'planeahead',
    version: '0.1.0',
    orientation: 'portrait',
    icon: identity.icon,
    userInterfaceStyle: 'automatic',
    // The fingerprint policy notices every native change, including the four native surface
    // families increment 11 adds, so an update never reaches a build it cannot run on.
    runtimeVersion: { policy: 'fingerprint' },
    ...(easProjectId === undefined
      ? {}
      : { updates: { url: `https://u.expo.dev/${easProjectId}` } }),
    ios: {
      bundleIdentifier: identity.bundleIdentifier,
      supportsTablet: false,
      usesAppleSignIn: true,
      associatedDomains: UNIVERSAL_LINK_HOSTS.map((host) => `applinks:${host}`),
      entitlements: {
        // Declared explicitly per variant: increment 11's expo-widgets and apple-targets read
        // the group at config-evaluation time, and the owner registers all three with Apple.
        'com.apple.security.application-groups': [appGroup],
        'aps-environment': apsEnvironment,
      },
      infoPlist: {
        NSSupportsLiveActivities: true,
        ITSAppUsesNonExemptEncryption: false,
      },
      // Declared by hand: Expo writes only what is listed here, into the main app target, and
      // never scans node_modules (facts section 2). Pod manifests are aggregated separately by
      // expo-build-properties' privacyManifestAggregationEnabled below.
      privacyManifests: {
        NSPrivacyTracking: false,
        NSPrivacyTrackingDomains: [],
        NSPrivacyAccessedAPITypes: [
          {
            NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults',
            // CA92.1: the app's own defaults; 1C8F.1: the App Group shared with the widgets.
            NSPrivacyAccessedAPITypeReasons: ['CA92.1', '1C8F.1'],
          },
          {
            NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp',
            NSPrivacyAccessedAPITypeReasons: ['C617.1'],
          },
          {
            NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryDiskSpace',
            NSPrivacyAccessedAPITypeReasons: ['E174.1'],
          },
          {
            NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime',
            NSPrivacyAccessedAPITypeReasons: ['35F9.1'],
          },
        ],
        NSPrivacyCollectedDataTypes: [
          {
            // The install-scoped analytics id (src/lib/analytics.ts): a Device ID, never joined
            // to the account, used for first-party analytics only; no ATT prompt.
            NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeDeviceID',
            NSPrivacyCollectedDataTypeLinked: false,
            NSPrivacyCollectedDataTypeTracking: false,
            NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAnalytics'],
          },
          {
            NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeCrashData',
            NSPrivacyCollectedDataTypeLinked: false,
            NSPrivacyCollectedDataTypeTracking: false,
            NSPrivacyCollectedDataTypePurposes: [
              'NSPrivacyCollectedDataTypePurposeAppFunctionality',
            ],
          },
        ],
      },
    },
    android: {
      package: identity.bundleIdentifier,
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-foreground.png',
        backgroundColor: identity.adaptiveBackground,
      },
      predictiveBackGestureEnabled: false,
      intentFilters: [
        {
          action: 'VIEW',
          // Android verifies every host in a filter with autoVerify against its assetlinks.json.
          autoVerify: true,
          data: UNIVERSAL_LINK_HOSTS.map((host) => ({
            scheme: 'https',
            host,
            pathPrefix: MAGIC_LINK_PATH,
          })),
          category: ['BROWSABLE', 'DEFAULT'],
        },
      ],
    },
    plugins: [
      'expo-router',
      [
        'expo-build-properties',
        {
          ios: {
            // A build-properties option, not an `ios.*` key: apps built with the iOS 27 SDK do
            // not launch on iOS 27 without the scene lifecycle (Expo SDK 57 changelog).
            enableSceneSupport: true,
            privacyManifestAggregationEnabled: true,
          },
        },
      ],
      'expo-sqlite',
      'expo-secure-store',
      'expo-apple-authentication',
      ['react-native-nitro-google-signin', { iosUrlScheme: reversedClientId(googleIosClientId) }],
      [
        '@sentry/react-native/expo',
        {
          url: 'https://sentry.io/',
          ...(sentryOrganization === undefined ? {} : { organization: sentryOrganization }),
          ...(sentryProject === undefined ? {} : { project: sentryProject }),
        },
      ],
      ['expo-notifications', { mode: apsEnvironment }],
      // Not in the spec's list, placed here so that list's relative order is unchanged: without
      // it the MapLibre pod has no MapLibre SDK to compile against (it adds the SDK's Swift
      // package in a Podfile post_install) and the iOS build fails, although Phase 0 only pins
      // the dependency (spike 1, ADR 0001).
      '@maplibre/maplibre-react-native',
      // Reserved last (increment 11 makes it real): it will force `aps-environment` after
      // expo-widgets writes its literal `development`. Named by path with its extension: Expo's
      // plugin resolver transpiles a TypeScript plugin file, while an `import` from this config
      // file is not followed by the config loader.
      ['./plugins/withApsEnvironment.ts', { apsEnvironment } satisfies ApsEnvironmentProps],
    ],
    experiments: {
      // Off for Phase 0: it changes memoisation for every component, the live-query list
      // included, and nothing here has been profiled with it (facts decision 15).
      reactCompiler: false,
      typedRoutes: false,
    },
    extra: {
      variant,
      apiUrl: env('PLANEAHEAD_API_URL') ?? identity.apiUrl,
      universalLinkHosts: [...UNIVERSAL_LINK_HOSTS],
      appGroup,
      googleIosClientId,
      googleWebClientId: env('GOOGLE_WEB_CLIENT_ID') ?? null,
      sentryDsn: env('SENTRY_DSN') ?? null,
      ...(easProjectId === undefined ? {} : { eas: { projectId: easProjectId } }),
    },
  };
};
