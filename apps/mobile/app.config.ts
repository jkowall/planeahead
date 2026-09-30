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
 * Plugin order is load bearing (docs/increments/09-mobile-scaffold.md, ADR 0008):
 * `ios.entitlements` is applied before every plugin, `expo-notifications` then writes
 * `aps-environment` from its `mode`, and expo-widgets writes the literal `development` again,
 * which is why the local `withApsEnvironment` plugin is the LAST entry and runs its entitlements
 * mod after all others.
 *
 * Which API each variant talks to, and which host's universal links it claims (ruling S2, ADR
 * 0005): each host is claimed by exactly one kind of build, so a link opens a predictable app.
 * The development variant owns staging (`api-staging.planeahead.app`: its links, its AASA entry
 * and its single `APPLE_BUNDLE_ID`, so Sign in with Apple against staging is the development
 * build's). Production and preview share `api.planeahead.app`: preview is the pre-release build
 * of the store app, talks to the production API, and a tester with both installed gets whichever
 * app iOS picks for a link. Preview's Sign in with Apple waits for increment 12, which makes the
 * API's `APPLE_BUNDLE_ID` a list.
 *
 * The APNs environment follows the build's SIGNING, not the variant: an internal (ad hoc) preview
 * build registers with production APNs like a store build. `APNS_ENVIRONMENT` comes from the EAS
 * profile (eas.json: `development` for the development profile, `production` for preview and
 * production); local builds, which are development signed, default to `development`.
 *
 * `@maplibre/maplibre-react-native` is a pinned dependency that is NOT linked in Phase 0
 * (react-native.config.js disables its native platforms, and its config plugin is not listed):
 * linked, it merged ACCESS_FINE_LOCATION and ACCESS_COARSE_LOCATION into the Android manifest and
 * a location-requesting pod into iOS, which the privacy answers deny (increment 9 review,
 * expo-correctness-2). The maps increment links it and declares location honestly.
 */

import type { ConfigContext, ExpoConfig } from 'expo/config';
import type { ApsEnvironmentProps } from './plugins/withApsEnvironment';
import type { ExpoWidgetsBuildProps } from './plugins/withExpoWidgetsBuild';

export const APP_VARIANTS = ['production', 'preview', 'development'] as const;
export type AppVariant = (typeof APP_VARIANTS)[number];

export const PRODUCTION_API_HOST = 'api.planeahead.app';
export const STAGING_API_HOST = 'api-staging.planeahead.app';

interface VariantIdentity {
  readonly bundleIdentifier: string;
  readonly name: string;
  readonly icon: string;
  readonly adaptiveBackground: string;
  /**
   * The API host this variant talks to and whose magic links it claims (applinks, the App Link
   * intent filter, and the AASA/assetlinks entry that host's Worker serves). `PLANEAHEAD_API_URL`
   * overrides the API origin for a local wrangler dev, never the claimed host.
   */
  readonly apiHost: string;
}

export const VARIANT_IDENTITIES: Readonly<Record<AppVariant, VariantIdentity>> = {
  production: {
    bundleIdentifier: 'app.planeahead.mobile',
    name: 'PlaneAhead',
    icon: './assets/icon-production.png',
    adaptiveBackground: '#1C4FD6',
    apiHost: PRODUCTION_API_HOST,
  },
  preview: {
    bundleIdentifier: 'app.planeahead.mobile.preview',
    name: 'PlaneAhead Preview',
    icon: './assets/icon-preview.png',
    adaptiveBackground: '#6D28D9',
    apiHost: PRODUCTION_API_HOST,
  },
  development: {
    bundleIdentifier: 'app.planeahead.mobile.dev',
    name: 'PlaneAhead Dev',
    icon: './assets/icon-development.png',
    adaptiveBackground: '#B45309',
    apiHost: STAGING_API_HOST,
  },
};

export const APNS_ENVIRONMENTS = ['development', 'production'] as const;
export type ApnsEnvironment = (typeof APNS_ENVIRONMENTS)[number];

/**
 * Android permissions the template or a dependency adds and the app never uses: the overlay and
 * external-storage entries of the template, and the biometric ones androidx.biometric brings in
 * through expo-secure-store (the app never asks for `requireAuthentication`).
 */
export const BLOCKED_ANDROID_PERMISSIONS = [
  'android.permission.SYSTEM_ALERT_WINDOW',
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.USE_BIOMETRIC',
  'android.permission.USE_FINGERPRINT',
] as const;

/**
 * The path the emailed magic link opens (apps/api/src/auth/paths.ts MAGIC_LINK_LANDING_PATH).
 * Effectively permanent: Apple's CDN caches the association file, so narrowing it later needs a
 * store release (docs/build-log.md, increment 5 ruling G3 moved it here from /api/auth).
 */
export const MAGIC_LINK_PATH = '/auth/magic-link';

/**
 * The one `widgets[]` entry (ADR 0008). `name` is also `createWidget`'s first argument in
 * widgets/placeholder.tsx, which this file cannot import (the config loader would evaluate the
 * widget's native bindings); __tests__/widgets.test.ts holds the two equal.
 */
export const PLACEHOLDER_WIDGET = {
  name: 'PlaneAheadPlaceholder',
  displayName: 'PlaneAhead',
  description: 'Your next flight at a glance.',
  supportedFamilies: ['systemSmall', 'systemMedium'],
} as const;

/**
 * The widget extension's bundle identifier: the app's plus `.widgets`, explicit rather than
 * expo-widgets' `.ExpoWidgetsTarget` fallback, because it is permanent once a build ships (ADR
 * 0005's rule) and the owner registers it with Apple next to the app's (README, owner tasks).
 */
export function widgetsBundleIdentifier(appBundleIdentifier: string): string {
  return `${appBundleIdentifier}.widgets`;
}

/** Google's iOS URL scheme is the iOS client id reversed; the plugin refuses anything else. */
const PLACEHOLDER_GOOGLE_IOS_CLIENT_ID = '000000000000-placeholder.apps.googleusercontent.com';

export function appVariant(value: string | undefined): AppVariant {
  const variant = value === undefined || value === '' ? 'production' : value;
  if (!(APP_VARIANTS as readonly string[]).includes(variant)) {
    throw new Error(`APP_VARIANT must be one of ${APP_VARIANTS.join(', ')}; got "${variant}"`);
  }
  return variant as AppVariant;
}

/**
 * `APNS_ENVIRONMENT`, set by every EAS profile. Unset means a local, development-signed build; on
 * an EAS builder (`EAS_BUILD`) it must be set, or a store build could ship a sandbox entitlement.
 */
export function apnsEnvironment(value: string | undefined, onEasBuilder: boolean): ApnsEnvironment {
  if (value === undefined || value === '') {
    if (onEasBuilder) {
      throw new Error('APNS_ENVIRONMENT must be set by the EAS build profile (eas.json)');
    }
    return 'development';
  }
  if (!(APNS_ENVIRONMENTS as readonly string[]).includes(value)) {
    throw new Error(
      `APNS_ENVIRONMENT must be one of ${APNS_ENVIRONMENTS.join(', ')}; got "${value}"`,
    );
  }
  return value as ApnsEnvironment;
}

/**
 * `IOS_DEVELOPMENT_TEAM` (increment 13, ruling S7, renamed by review ruling G6): the
 * ten-character team id, for `ios.appleTeamId`, which Expo, expo-widgets and @bacons/apple-targets
 * write into every target's `DEVELOPMENT_TEAM` for a LOCAL device build (apple-targets warns
 * while it is missing). Unset, nothing is written. Never in an EAS environment: an EAS build signs
 * each target with its provisioning profile's team anyway (R5 C13), and `ios.appleTeamId` is part
 * of the config @expo/fingerprint hashes, so a build carrying it would have a runtime version no
 * update made without it matches (README, owner tasks). Not `APPLE_TEAM_ID`: the API Worker has a
 * variable of that name (the association files), which must not reach the app's config.
 */
export function iosDevelopmentTeam(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^[A-Z0-9]{10}$/.test(value)) {
    throw new Error(`IOS_DEVELOPMENT_TEAM must be the ten-character Apple team id; got "${value}"`);
  }
  return value;
}

/**
 * `GOOGLE_IOS_CLIENT_ID` (review ruling G5). A preview or production build on an EAS builder
 * (`EAS_BUILD`) must carry the variant's real iOS client id, or it ships the placeholder's URL
 * scheme and Google sign-in fails for every tester; so there, unset is an error, as it is for
 * `APNS_ENVIRONMENT`. Elsewhere (a local prebuild, a development build, a test) the placeholder
 * keeps prebuild working.
 */
export function googleIosClientId(
  value: string | undefined,
  variant: AppVariant,
  onEasBuilder: boolean,
): string {
  if (value !== undefined) {
    return value;
  }
  if (onEasBuilder && variant !== 'development') {
    throw new Error(
      `GOOGLE_IOS_CLIENT_ID must be set in the EAS ${variant} environment for a ${variant} build`,
    );
  }
  return PLACEHOLDER_GOOGLE_IOS_CLIENT_ID;
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
  const onEasBuilder = env('EAS_BUILD') === 'true';
  const apsEnvironment = apnsEnvironment(env('APNS_ENVIRONMENT'), onEasBuilder);
  const iosClientId = googleIosClientId(env('GOOGLE_IOS_CLIENT_ID'), variant, onEasBuilder);
  const teamId = iosDevelopmentTeam(env('IOS_DEVELOPMENT_TEAM'));
  const easProjectId = env('EAS_PROJECT_ID');
  const sentryOrganization = env('SENTRY_ORG');
  const sentryProject = env('SENTRY_PROJECT');
  // expo-widgets' Android widgets: a trial flag, off in every EAS profile (ADR 0008). While it is
  // off, plugins/withExpoWidgetsBuild.ts also keeps the package out of Android autolinking.
  const androidWidgets = env('PLANEAHEAD_ANDROID_WIDGETS') === '1';
  // An FCM device token needs the Firebase config even in a development build (spike 3, ADR
  // 0001): expo-notifications asks FirebaseMessaging for it, which has no default app without
  // google-services.json. A path, set as an EAS file variable per variant; unset, the token read
  // fails and src/lib/push.ts reports it unavailable.
  const googleServicesFile = env('GOOGLE_SERVICES_JSON');

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
    // The fingerprint policy notices native changes, so an update never reaches a build it cannot
    // run on. It finds the config, the plugins and the autolinked modules itself; the watchOS
    // shells' sources (targets/) and the Wear OS module's (wear/), which only a plugin points
    // at, are added as extra sources by fingerprint.config.js (increment 11 review, ruling Z9).
    runtimeVersion: { policy: 'fingerprint' },
    ...(easProjectId === undefined
      ? {}
      : { updates: { url: `https://u.expo.dev/${easProjectId}` } }),
    ios: {
      bundleIdentifier: identity.bundleIdentifier,
      ...(teamId === undefined ? {} : { appleTeamId: teamId }),
      supportsTablet: false,
      usesAppleSignIn: true,
      // One host per variant (see the file header).
      associatedDomains: [`applinks:${identity.apiHost}`],
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
      // expo-build-properties' privacyManifestAggregationEnabled below. The widget extension and
      // the watch shells get their own (plugins/withExtensionPrivacyManifests.ts).
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
        // What the app collects, as the App Privacy label will say it (ADR 0005). Nothing is
        // used for tracking, so no ATT prompt.
        NSPrivacyCollectedDataTypes: [
          {
            // Two per-install random ids (src/lib/identity.ts): the install id is registered under
            // the account with POST /v1/devices (App Functionality), the analytics id goes to
            // POST /v1/events alone (Analytics). One entry, because the label shows a data type
            // in one section: the install id makes it Linked.
            NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeDeviceID',
            NSPrivacyCollectedDataTypeLinked: true,
            NSPrivacyCollectedDataTypeTracking: false,
            NSPrivacyCollectedDataTypePurposes: [
              'NSPrivacyCollectedDataTypePurposeAppFunctionality',
              'NSPrivacyCollectedDataTypePurposeAnalytics',
            ],
          },
          {
            // The magic-link address and the account's address from Apple or Google.
            NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeEmailAddress',
            NSPrivacyCollectedDataTypeLinked: true,
            NSPrivacyCollectedDataTypeTracking: false,
            NSPrivacyCollectedDataTypePurposes: [
              'NSPrivacyCollectedDataTypePurposeAppFunctionality',
            ],
          },
          {
            // The account's user id (the session, every /v1 request).
            NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeUserID',
            NSPrivacyCollectedDataTypeLinked: true,
            NSPrivacyCollectedDataTypeTracking: false,
            NSPrivacyCollectedDataTypePurposes: [
              'NSPrivacyCollectedDataTypePurposeAppFunctionality',
            ],
          },
          {
            // The name Apple sends on the first native sign-in (`fullName`), kept on the account.
            NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeName',
            NSPrivacyCollectedDataTypeLinked: true,
            NSPrivacyCollectedDataTypeTracking: false,
            NSPrivacyCollectedDataTypePurposes: [
              'NSPrivacyCollectedDataTypePurposeAppFunctionality',
            ],
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
      ...(googleServicesFile === undefined ? {} : { googleServicesFile }),
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-foreground.png',
        backgroundColor: identity.adaptiveBackground,
      },
      predictiveBackGestureEnabled: false,
      blockedPermissions: [...BLOCKED_ANDROID_PERMISSIONS],
      intentFilters: [
        {
          action: 'VIEW',
          // Android verifies the host against its assetlinks.json; one host per variant.
          autoVerify: true,
          data: [{ scheme: 'https', host: identity.apiHost, pathPrefix: MAGIC_LINK_PATH }],
          category: ['BROWSABLE', 'DEFAULT'],
        },
      ],
    },
    plugins: [
      'expo-router',
      // SDK 57 links most Expo modules as prebuilt frameworks. ExpoFileSystem's prebuilt
      // framework carries no privacy manifest although its code reads file dates and free disk
      // space, and App Store Connect rejects the upload for it (ITMS-91053; expo/expo#50503,
      // fixed only in expo-file-system 58.0.2), so package.json builds that one module from
      // source (`expo.autolinking.ios.buildFromSource`): linked into the app's binary, its
      // manifest is aggregated into the app's by the option below. Drop the override at SDK 58
      // (__tests__/app-config.test.ts fails once expo-file-system reaches 58). React Native's own
      // prebuilt core stays (scripts/native-smoke.sh FRAMEWORKS_WITHOUT_MANIFEST); its fallback
      // is `ios.buildReactNativeFromSource: true` here.
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
      // No Face ID purpose string: the app never stores an item with `requireAuthentication`.
      ['expo-secure-store', { faceIDPermission: false }],
      'expo-apple-authentication',
      ['react-native-nitro-google-signin', { iosUrlScheme: reversedClientId(iosClientId) }],
      [
        '@sentry/react-native/expo',
        {
          url: 'https://sentry.io/',
          ...(sentryOrganization === undefined ? {} : { organization: sentryOrganization }),
          ...(sentryProject === undefined ? {} : { project: sentryProject }),
        },
      ],
      ['expo-notifications', { mode: apsEnvironment }],
      // The widget extension (ADR 0008): ONE `widgets[]` entry, the placeholder home-screen widget
      // (widgets/placeholder.tsx). The flight Live Activity is created with `createLiveActivity`
      // (widgets/live-activity.tsx) and must not be listed: an entry without families generates
      // an invalid target. The App Group is the one `ios.entitlements` declares above, so the app
      // and the extension share storage and the owner registers one group per variant.
      // `enablePushNotifications` turns on the push-to-start and per-activity token observers
      // (src/lib/live-activity/tokens.ts); it also writes `aps-environment: development`, which
      // withApsEnvironment overrides. Android widgets stay behind a flag (ADR 0008).
      [
        'expo-widgets',
        {
          bundleIdentifier: widgetsBundleIdentifier(identity.bundleIdentifier),
          groupIdentifier: appGroup,
          enablePushNotifications: true,
          enableAndroid: androidWidgets,
          widgets: [
            {
              name: PLACEHOLDER_WIDGET.name,
              displayName: PLACEHOLDER_WIDGET.displayName,
              description: PLACEHOLDER_WIDGET.description,
              supportedFamilies: [...PLACEHOLDER_WIDGET.supportedFamilies],
            },
          ],
        },
      ],
      // Corrections to what expo-widgets generates (ADR 0008, review rulings Z11 and Z3): the
      // extension's Release build settings (optimised, no debug dylib), and the package kept out
      // of Android autolinking while `enableAndroid` is off (no Glance, no WorkManager).
      [
        './plugins/withExpoWidgetsBuild.ts',
        { enableAndroid: androidWidgets } satisfies ExpoWidgetsBuildProps,
      ],
      // What the first store upload needs of the bundles the app embeds (increment 13, rulings S1
      // and S3): a privacy manifest in the widget extension and each watch shell, and the app's
      // version and build number in every one of them. Both edit @bacons/apple-targets' own
      // project mod, after it created the watch targets, so both must stay BEFORE it:
      // config-plugins refuses a mod added to that chain once apple-targets' provider is in place.
      './plugins/withExtensionPrivacyManifests.ts',
      './plugins/withExtensionVersions.ts',
      // The watchOS shells (targets/watch, targets/watch-widget), kept after the coexistence
      // spike passed on Xcode 27 (ADR 0008). Its pbxproj parser rewrites the project expo-widgets
      // wrote; the spike found the result independent of the order of the two entries.
      '@bacons/apple-targets',
      // The Wear OS module (compile only, ADR 0008).
      './plugins/withWearApp.ts',
      // LAST, and it must stay last (ADR 0008): it registers the entitlements mod that runs after
      // every other one and writes `aps-environment` from the EAS profile, over the literal
      // `development` expo-widgets writes. Named by path with its extension: Expo's plugin
      // resolver transpiles a TypeScript plugin file, while an `import` from this config file is
      // not followed by the config loader.
      ['./plugins/withApsEnvironment.ts', { apsEnvironment } satisfies ApsEnvironmentProps],
    ],
    experiments: {
      // Off for Phase 0: it changes memoisation for every component, the live-query list
      // included, and nothing here has been profiled with it (facts decision 15).
      reactCompiler: false,
      // Still beta and opt-in in SDK 57; the app's few routes are named by hand (ADR 0001).
      typedRoutes: false,
    },
    extra: {
      variant,
      apiUrl: env('PLANEAHEAD_API_URL') ?? `https://${identity.apiHost}`,
      // The magic-link screen verifies automatically only for a link that arrived on this host.
      universalLinkHosts: [identity.apiHost],
      apnsEnvironment: apsEnvironment,
      appGroup,
      googleIosClientId: iosClientId,
      googleWebClientId: env('GOOGLE_WEB_CLIENT_ID') ?? null,
      sentryDsn: env('SENTRY_DSN') ?? null,
      ...(easProjectId === undefined ? {} : { eas: { projectId: easProjectId } }),
    },
  };
};
