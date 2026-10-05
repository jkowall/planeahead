/**
 * app.config.ts (ruling P8, fix-round rulings S2 and S8): the three variants, the entitlements
 * with the APNs environment from the EAS profile, one universal-link host per variant, the
 * privacy manifest, the blocked Android permissions, the plugin order with withApsEnvironment
 * LAST (increment 11 made it real; __tests__/entitlements.test.ts evaluates it) and no MapLibre
 * plugin, scene support in expo-build-properties, the fingerprint runtime version and the React
 * Compiler off. Also the files that must agree with it: eas.json, the preview update workflow,
 * react-native.config.js, fingerprint.config.js (the Google services file stays out of the
 * runtime version, re-review expo-correctness-1) and the package scripts. Increment 13's review
 * round: `IOS_DEVELOPMENT_TEAM` (G6), the Google iOS client id a store build must carry (G5) and
 * ExpoFileSystem built from source until SDK 58 (F5). Increment 16: the time-sensitive
 * entitlement in every variant (C8), and the expo-notifications plugin's Android icon, colour and
 * default channel (C4, C5), the icon a white-on-transparent PNG that
 * scripts/gen-notification-icon.mjs draws.
 */

import { ANDROID_CHANNEL_IDS } from '@planeahead/shared';
import type { ConfigContext, ExpoConfig } from 'expo/config';
import appConfig, {
  apnsEnvironment,
  appVariant,
  BLOCKED_ANDROID_PERMISSIONS,
  googleIosClientId,
  iosDevelopmentTeam,
  reversedClientId,
} from '../app.config';

// Jest's CommonJS wrapper provides them; the app's tsconfig carries no Node types.
declare const __dirname: string;
declare const require: ((id: string) => unknown) & {
  resolve(id: string, options?: { paths: string[] }): string;
};

const fs = jest.requireActual<{
  readFileSync(path: string, encoding: 'utf8'): string;
  readFileSync(path: string): Uint8Array;
  realpathSync(path: string): string;
}>('fs');
const zlib = jest.requireActual<{ inflateSync(data: Uint8Array): Uint8Array }>('zlib');
const path = jest.requireActual<{
  resolve(...parts: string[]): string;
  relative(from: string, to: string): string;
  dirname(path: string): string;
}>('path');
const childProcess = jest.requireActual<{
  execFileSync(
    file: string,
    args: readonly string[],
    options: { cwd: string; encoding: 'utf8' },
  ): string;
}>('child_process');
const nodeBinary = (process as unknown as { execPath: string }).execPath;
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

/**
 * The size and pixels of an 8-bit RGBA PNG that is not interlaced, whichever of the five row
 * filters its encoder chose (PNG specification, section 9), so the icon checks below hold for
 * any such file, the owner's own icon included.
 */
function decodeRgbaPng(png: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let [width, height] = [0, 0];
  const parts: Uint8Array[] = [];
  for (let offset = 8; offset < png.length; offset += 12 + view.getUint32(offset)) {
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    if (type === 'IHDR') {
      [width, height] = [view.getUint32(offset + 8), view.getUint32(offset + 12)];
      // Bit depth 8, colour type 6 (RGBA), deflate, the standard filters, not interlaced.
      expect([...png.subarray(offset + 16, offset + 21)]).toEqual([8, 6, 0, 0, 0]);
    } else if (type === 'IDAT') {
      parts.push(png.subarray(offset + 8, offset + 8 + view.getUint32(offset)));
    }
  }
  const compressed = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let written = 0;
  for (const part of parts) {
    compressed.set(part, written);
    written += part.length;
  }
  const scanlines = zlib.inflateSync(compressed);
  const byte = (array: Uint8Array, index: number): number => array[index] ?? 0;
  const stride = width * 4;
  const rgba = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = byte(scanlines, y * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const left = x >= 4 ? byte(rgba, y * stride + x - 4) : 0;
      const up = y > 0 ? byte(rgba, (y - 1) * stride + x) : 0;
      const upLeft = x >= 4 && y > 0 ? byte(rgba, (y - 1) * stride + x - 4) : 0;
      const estimate = left + up - upLeft;
      const toLeft = Math.abs(estimate - left);
      const toUp = Math.abs(estimate - up);
      const toUpLeft = Math.abs(estimate - upLeft);
      const paeth = toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft;
      const predictor = [0, left, up, (left + up) >> 1, paeth][filter];
      if (predictor === undefined) {
        throw new Error(`row ${y} has filter type ${filter}, which PNG does not define`);
      }
      rgba[y * stride + x] = (byte(scanlines, y * (stride + 1) + 1 + x) + predictor) & 0xff;
    }
  }
  return { width, height, rgba };
}

describe('app.config.ts', () => {
  it.each([
    ['production', 'app.planeahead.mobile', 'PlaneAhead', 'production', '#1C4FD6'],
    ['preview', 'app.planeahead.mobile.preview', 'PlaneAhead Preview', 'production', '#6D28D9'],
    ['development', 'app.planeahead.mobile.dev', 'PlaneAhead Dev', 'development', '#B45309'],
  ])('builds the %s variant as its EAS profile does', (variant, bundleId, name, aps, accent) => {
    const profileEnv = easJson().build[variant]?.env ?? {};
    // GOOGLE_IOS_CLIENT_ID comes from the EAS environment, which every store build has.
    const config = configFor(variant, {
      ...profileEnv,
      EAS_BUILD: 'true',
      GOOGLE_IOS_CLIENT_ID: '123-abc.apps.googleusercontent.com',
    });
    expect(config.name).toBe(name);
    expect(config.ios?.bundleIdentifier).toBe(bundleId);
    expect(config.android?.package).toBe(bundleId);
    expect(config.ios?.entitlements).toEqual({
      'com.apple.security.application-groups': [`group.${bundleId}`],
      'aps-environment': aps,
      // Ruling C8: a time-sensitive push breaks through Focus and the summary in every variant.
      'com.apple.developer.usernotifications.time-sensitive': true,
    });
    expect(config.extra?.['variant']).toBe(variant);
    expect(config.extra?.['apnsEnvironment']).toBe(aps);
    const plugins = config.plugins ?? [];
    // Rulings C4 and C5: the Android icon, the variant's own colour as the accent, and the
    // channel FCM falls back to, which is one of the two the app creates (packages/shared).
    expect(plugins).toContainEqual([
      'expo-notifications',
      {
        mode: aps,
        icon: './assets/notification-icon.png',
        color: accent,
        defaultChannel: ANDROID_CHANNEL_IDS.flightChanges,
      },
    ]);
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

  it('pins the EAS images and CocoaPods and holds the Sentry upload in every build profile', () => {
    // As eas-cli resolves `extends` (packages/eas-json/src/build/resolver.ts, mergeProfiles):
    // the later profile's keys win, and `env`, `android` and `ios` are merged a level down.
    type Profile = Record<string, unknown> & {
      extends?: string;
      env?: Record<string, string>;
      ios?: Record<string, unknown>;
      android?: Record<string, unknown>;
    };
    const profiles = (
      JSON.parse(fs.readFileSync(path.resolve(APP_ROOT, 'eas.json'), 'utf8')) as {
        build: Record<string, Profile>;
      }
    ).build;
    const merge = (base: Profile, update: Profile): Profile => ({
      ...base,
      ...update,
      ...(base.env && update.env ? { env: { ...base.env, ...update.env } } : {}),
      ...(base.ios && update.ios ? { ios: { ...base.ios, ...update.ios } } : {}),
      ...(base.android && update.android
        ? { android: { ...base.android, ...update.android } }
        : {}),
    });
    const resolve = (name: string): Profile => {
      const profile = profiles[name];
      if (profile === undefined) {
        throw new Error(`no build profile ${name}`);
      }
      return profile.extends === undefined ? profile : merge(resolve(profile.extends), profile);
    };
    for (const name of ['development', 'preview', 'production']) {
      const profile = resolve(name);
      // The SDK 57 images by full name, not the moving `sdk-57` or `latest` aliases, and the
      // CocoaPods the native smoke and every spike used (R5 E3, E4, C3).
      expect(profile.ios).toMatchObject({
        image: 'macos-tahoe-26.5-xcode-26.6',
        cocoapods: '1.17.0',
      });
      expect(profile.android).toMatchObject({ image: 'ubuntu-26.04-jdk-17-ndk-r27b-sdk-57' });
      // The Sentry build phases fail a Release build whose upload fails, and no Sentry project
      // exists yet (R5 L6, C11; runbook step 18 says when to drop it).
      expect(profile.env).toMatchObject({ SENTRY_DISABLE_AUTO_UPLOAD: 'true' });
    }
    expect(resolve('development').ios).toMatchObject({ simulator: true });
  });

  it('submits production builds to the Play internal track and waits for the App Store id', () => {
    const { submit } = JSON.parse(fs.readFileSync(path.resolve(APP_ROOT, 'eas.json'), 'utf8')) as {
      submit: Record<string, { android?: Record<string, unknown>; ios?: Record<string, unknown> }>;
    };
    expect(submit['production']?.android).toEqual({
      track: 'internal',
      releaseStatus: 'completed',
    });
    // `ascAppId` is the App Store Connect record's Apple ID, which only exists once the owner
    // creates the record (runbook step 18); a placeholder would send uploads to no app.
    expect(submit['production']?.ios?.['ascAppId'] ?? null).toBeNull();
  });

  it('writes ios.appleTeamId from IOS_DEVELOPMENT_TEAM only, for local device builds', () => {
    expect(configFor('production', { IOS_DEVELOPMENT_TEAM: 'ABCDE12345' }).ios?.appleTeamId).toBe(
      'ABCDE12345',
    );
    expect(configFor('production', { IOS_DEVELOPMENT_TEAM: '' }).ios).not.toHaveProperty(
      'appleTeamId',
    );
    // The API Worker's variable of the old name never reaches the app's (fingerprinted) config
    // (review ruling G6).
    expect(configFor('production', { APPLE_TEAM_ID: 'ABCDE12345' }).ios).not.toHaveProperty(
      'appleTeamId',
    );
    expect(iosDevelopmentTeam(undefined)).toBeUndefined();
    expect(() => iosDevelopmentTeam('abcde12345')).toThrow(/IOS_DEVELOPMENT_TEAM/);
    expect(() => iosDevelopmentTeam('ABCDE1234')).toThrow(/IOS_DEVELOPMENT_TEAM/);
  });

  it("keeps EAS's build number and version out of the fingerprinted config (ruling F6)", () => {
    // plugins/withExtensionVersions.ts reads EAS_BUILD_IOS_* at prebuild; the config itself must
    // not, because @expo/fingerprint hashes ios.buildNumber and version by default, so routing
    // them through the config would give every EAS build a new runtime version.
    const local = configFor('production');
    const onEas = configFor('production', {
      EAS_BUILD_IOS_BUILD_NUMBER: '7',
      EAS_BUILD_IOS_APP_VERSION: '9.9.9',
    });
    expect(onEas.ios?.buildNumber).toBeUndefined();
    expect(onEas.version).toBe(local.version);
    expect(JSON.stringify(onEas)).toBe(JSON.stringify(local));
  });

  it('refuses a preview or production build on EAS without the Google iOS client id (G5)', () => {
    for (const variant of ['production', 'preview']) {
      const profileEnv = easJson().build[variant]?.env ?? {};
      expect(() => configFor(variant, { ...profileEnv, EAS_BUILD: 'true' })).toThrow(
        `GOOGLE_IOS_CLIENT_ID must be set in the EAS ${variant} environment`,
      );
      // Anywhere else the placeholder keeps prebuild working.
      expect(configFor(variant).extra?.['googleIosClientId']).toBe(
        '000000000000-placeholder.apps.googleusercontent.com',
      );
    }
    // A development build may use the placeholder on EAS too.
    const development = easJson().build['development']?.env ?? {};
    expect(
      configFor('development', { ...development, EAS_BUILD: 'true' }).extra?.['googleIosClientId'],
    ).toBe('000000000000-placeholder.apps.googleusercontent.com');
    // The real id reaches the URL scheme.
    const real = configFor('production', {
      ...(easJson().build['production']?.env ?? {}),
      EAS_BUILD: 'true',
      GOOGLE_IOS_CLIENT_ID: '123-abc.apps.googleusercontent.com',
    });
    expect(real.extra?.['googleIosClientId']).toBe('123-abc.apps.googleusercontent.com');
    expect(real.plugins).toContainEqual([
      'react-native-nitro-google-signin',
      { iosUrlScheme: 'com.googleusercontent.apps.123-abc' },
    ]);
    expect(googleIosClientId(undefined, 'production', false)).toMatch(/placeholder/);
    expect(() => googleIosClientId(undefined, 'preview', true)).toThrow(/GOOGLE_IOS_CLIENT_ID/);
  });

  it('builds ExpoFileSystem from source until expo-file-system ships its manifest (F5)', () => {
    // SDK 57's prebuilt ExpoFileSystem.framework lacks its privacy manifest, which App Store
    // Connect rejects (ITMS-91053; expo/expo#50503, fixed in expo-file-system 58.0.2). The
    // override in package.json links it into the app, under the app's aggregated manifest; drop it
    // at SDK 58, which this test then demands.
    const { expo } = JSON.parse(
      fs.readFileSync(path.resolve(APP_ROOT, 'package.json'), 'utf8'),
    ) as { expo?: { autolinking?: { ios?: { buildFromSource?: string[] } } } };
    const fileSystem = JSON.parse(
      fs.readFileSync(
        require.resolve('expo-file-system/package.json', {
          paths: [path.dirname(require.resolve('expo/package.json'))],
        }),
        'utf8',
      ),
    ) as { version: string };
    const major = Number(fileSystem.version.split('.')[0]);
    if (major < 58) {
      expect(expo).toEqual({ autolinking: { ios: { buildFromSource: ['ExpoFileSystem'] } } });
    } else {
      expect(expo?.autolinking?.ios?.buildFromSource ?? []).not.toContain('ExpoFileSystem');
    }
    // What the Podfile's autolinking reads: the option, and the module it names.
    const autolinking = path.dirname(
      require.resolve('expo-modules-autolinking/package.json', {
        paths: [path.dirname(require.resolve('expo/package.json'))],
      }),
    );
    const resolved = JSON.parse(
      childProcess.execFileSync(
        nodeBinary,
        [
          path.resolve(autolinking, 'bin', 'expo-modules-autolinking.js'),
          'resolve',
          '--platform',
          'apple',
          '--json',
        ],
        { cwd: APP_ROOT, encoding: 'utf8' },
      ),
    ) as {
      configuration?: { buildFromSource?: string[] };
      modules: { packageName: string; pods: { podName: string }[] }[];
    };
    if (major < 58) {
      expect(resolved.configuration?.buildFromSource).toEqual(['ExpoFileSystem']);
      expect(
        resolved.modules
          .find((module) => module.packageName === 'expo-file-system')
          ?.pods.map((pod) => pod.podName),
      ).toEqual(['ExpoFileSystem']);
    }
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
      // Increment 11 (ADR 0008): the widget extension (and its build corrections), the watchOS
      // shells, the Wear OS module.
      'expo-widgets',
      './plugins/withExpoWidgetsBuild.ts',
      // Increment 13: the extensions' privacy manifests and versions, which edit apple-targets'
      // own project mod and so must come before it (__tests__/store-bundles.test.ts).
      './plugins/withExtensionPrivacyManifests.ts',
      './plugins/withExtensionVersions.ts',
      '@bacons/apple-targets',
      './plugins/withWearApp.ts',
      './plugins/withApsEnvironment.ts',
    ]);
    const buildProperties = config.plugins?.[1] as [string, { ios: Record<string, unknown> }];
    expect(buildProperties[1].ios).toMatchObject({
      enableSceneSupport: true,
      privacyManifestAggregationEnabled: true,
    });
    expect(config.plugins?.[7]).toEqual([
      'expo-notifications',
      {
        mode: 'production',
        icon: './assets/notification-icon.png',
        color: '#1C4FD6',
        defaultChannel: 'flight_changes',
      },
    ]);
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
    // config exports for this process (after the generated watch icon catalog, below).
    expect(googleServicesIgnorePaths({})).toEqual([
      '**/google-services*.json',
      '**/GoogleService-Info*.plist',
    ]);
    expect(ignorePaths).toEqual([
      'targets/*/Assets.xcassets/**/*',
      ...googleServicesIgnorePaths(process.env),
    ]);
  });

  it('hashes the watchOS shells and the Wear OS module into the runtime fingerprint (ruling Z9)', () => {
    const { extraSources, ignorePaths } = require(
      path.resolve(APP_ROOT, 'fingerprint.config.js'),
    ) as {
      extraSources: { type: string; filePath: string; reasons: string[] }[];
      ignorePaths: string[];
    };
    // Hand-written native code that only a config plugin points at: @expo/fingerprint does not
    // find it on its own, so a Swift or Kotlin change would otherwise keep the runtime version.
    expect(extraSources.map(({ type, filePath }) => ({ type, filePath }))).toEqual([
      { type: 'dir', filePath: 'targets' },
      { type: 'dir', filePath: 'wear' },
    ]);
    for (const source of extraSources) {
      expect(source.reasons.length).toBeGreaterThan(0);
      expect(fs.realpathSync(path.resolve(APP_ROOT, source.filePath))).toBeTruthy();
    }
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
    for (const source of [
      'targets/watch/PlaneAheadWatchApp.swift',
      'targets/watch/Info.plist',
      'targets/watch-widget/PlaneAheadWatchWidget.swift',
      'wear/src/main/java/app/planeahead/wear/MainActivity.kt',
      'wear/src/main/AndroidManifest.xml',
    ]) {
      expect(isIgnoredPath(source, ignorePaths)).toBe(false);
    }
    // The icon catalog apple-targets writes into targets/watch on every prebuild exists on a
    // builder and never under `eas update`: hashing it would split the runtime version.
    expect(
      isIgnoredPath('targets/watch/Assets.xcassets/AppIcon.appiconset/Contents.json', ignorePaths),
    ).toBe(true);
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

  it('gives Android notifications a white icon on transparent, drawn by the committed script (C5)', () => {
    const notifications = configFor('production').plugins?.find(
      (plugin): plugin is [string, { icon: string }] =>
        Array.isArray(plugin) && plugin[0] === 'expo-notifications',
    );
    const icon = path.resolve(APP_ROOT, notifications?.[1].icon ?? 'no icon named');
    const { width, height, rgba } = decodeRgbaPng(fs.readFileSync(icon));
    // The xxxhdpi size of the 24 dp status-bar icon; the plugin scales it to the other densities.
    expect([width, height]).toEqual([96, 96]);
    // Android draws the alpha channel alone, tinted with the plugin's colour: white wherever the
    // icon is not transparent, an empty 1 dp edge, and a glyph, neither empty nor a filled block.
    const notWhite: string[] = [];
    const onTheEdge: string[] = [];
    let opaque = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const at = (y * width + x) * 4;
        const [red, green, blue, alpha] = rgba.subarray(at, at + 4);
        if (alpha !== 0 && (red !== 255 || green !== 255 || blue !== 255)) {
          notWhite.push(`${x},${y}`);
        }
        if (alpha !== 0 && Math.min(x, y, width - 1 - x, height - 1 - y) < 4) {
          onTheEdge.push(`${x},${y}`);
        }
        opaque += alpha === 255 ? 1 : 0;
      }
    }
    expect(notWhite).toEqual([]);
    expect(onTheEdge).toEqual([]);
    expect(opaque / (width * height)).toBeGreaterThan(0.05);
    expect(opaque / (width * height)).toBeLessThan(0.5);
    // And it is what scripts/gen-notification-icon.mjs draws, until the owner's own icon replaces
    // it (R2 owner action 5).
    const script = path.resolve(APP_ROOT, '..', '..', 'scripts', 'gen-notification-icon.mjs');
    expect(
      childProcess.execFileSync(nodeBinary, [script, '--check'], {
        cwd: APP_ROOT,
        encoding: 'utf8',
      }),
    ).toMatch(/^gen-notification-icon: up to date/);
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
