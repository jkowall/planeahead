/**
 * The runtime view of app.config.ts `extra`: what this build talks to and which public client
 * ids it carries. Read once, validated, frozen. Nothing here is secret (it ships in the app).
 */

import Constants from 'expo-constants';

export type AppVariant = 'production' | 'preview' | 'development';
export type ApnsEnvironment = 'development' | 'production';

export interface AppRuntimeConfig {
  readonly variant: AppVariant;
  /** The API Worker's origin, no trailing slash: `/v1/*` and `/api/auth/*` hang off it. */
  readonly apiUrl: string;
  /**
   * The host this variant claims universal links on (the magic link's landing page); a link on
   * any other host, or on the custom scheme, is never verified without asking.
   */
  readonly universalLinkHosts: readonly string[];
  /**
   * The APNs environment this build's signing registers with (app.config.ts, from the EAS
   * profile): an ad hoc preview build is `production`, like a store build.
   */
  readonly apnsEnvironment: ApnsEnvironment;
  readonly googleIosClientId: string;
  readonly googleWebClientId: string | null;
  readonly sentryDsn: string | null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Validates the `extra` block; exported for the tests, which build their own. */
export function parseRuntimeConfig(extra: Record<string, unknown> | undefined): AppRuntimeConfig {
  const variant = asString(extra?.['variant']);
  const apiUrl = asString(extra?.['apiUrl']);
  if (variant !== 'production' && variant !== 'preview' && variant !== 'development') {
    throw new Error(`app config extra.variant is missing or unknown: ${String(variant)}`);
  }
  if (apiUrl === null || !/^https?:\/\/[^/]+$/.test(apiUrl.replace(/\/+$/, ''))) {
    throw new Error(`app config extra.apiUrl must be an origin; got ${String(apiUrl)}`);
  }
  const hosts = extra?.['universalLinkHosts'];
  const apnsEnvironment = asString(extra?.['apnsEnvironment']) ?? 'development';
  if (apnsEnvironment !== 'development' && apnsEnvironment !== 'production') {
    throw new Error(`app config extra.apnsEnvironment is unknown: ${apnsEnvironment}`);
  }
  return Object.freeze({
    variant,
    apiUrl: apiUrl.replace(/\/+$/, ''),
    universalLinkHosts: Object.freeze(
      Array.isArray(hosts) ? hosts.filter((host): host is string => typeof host === 'string') : [],
    ),
    apnsEnvironment,
    googleIosClientId: asString(extra?.['googleIosClientId']) ?? '',
    googleWebClientId: asString(extra?.['googleWebClientId']),
    sentryDsn: asString(extra?.['sentryDsn']),
  });
}

let cached: AppRuntimeConfig | null = null;

export function runtimeConfig(): AppRuntimeConfig {
  cached ??= parseRuntimeConfig(Constants.expoConfig?.extra);
  return cached;
}
