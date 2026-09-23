/**
 * `/.well-known`: the two association files that let the mobile app open the emailed magic link
 * (increment 9; the link is `${API_PUBLIC_URL}/auth/magic-link?token=...`, MAGIC_LINK_LANDING_PATH).
 *
 * - `apple-app-site-association` (no extension, as Apple fetches it; the `.json` spelling is
 *   served too) names the iOS app ids `<team id>.<bundle id>` that claim this host, and the path.
 *   Apple's CDN caches this file, so the path is effectively permanent once a build ships; it is
 *   the prefix `/auth/magic-link*`, and a narrower one needs a store release.
 * - `assetlinks.json` names each Android package that claims this host with the SHA-256
 *   fingerprints of the certificates that sign it (Play's app signing key AND the upload key), for
 *   App Links verification (`autoVerify` on the app's intent filter).
 *
 * Each host is claimed by exactly one kind of build, so a link opens a predictable app (ruling
 * S2, ADR 0005, apps/mobile/app.config.ts): staging (and a local or test Worker) names the
 * development build, production names the production build and the preview build (its pre-release
 * build). Both files list only the environment's app ids, whatever else the variables hold.
 *
 * Everything comes from the environment; none of it is secret (both files are public by design):
 *
 *   APPLE_TEAM_ID                 ten characters, e.g. `A1B2C3D4E5`
 *   APP_BUNDLE_IDS                comma separated; defaults to the environment's ids (above)
 *   ANDROID_SHA256_FINGERPRINTS   `package=FP,FP;package=FP`, FP as `AB:CD:...` (32 bytes)
 *
 * An environment without a valid team id (or without a single valid fingerprint) answers 404 with
 * the envelope: Apple and Google cache a success, and an empty association served by mistake
 * would be cached as "this domain opens no app". Both answer with `application/json`, a one hour
 * `Cache-Control`, and never a redirect (Apple refuses redirected association files).
 */

import type { Context } from 'hono';
import { Hono } from 'hono';
import { MAGIC_LINK_LANDING_PATH } from '../auth/paths';
import { environmentName, type AppBindings, type EnvironmentName } from '../env';

/** The bundle identifiers (and Android package names) of the three APP_VARIANTs (ADR 0005). */
export const DEFAULT_APP_BUNDLE_IDS = [
  'app.planeahead.mobile',
  'app.planeahead.mobile.preview',
  'app.planeahead.mobile.dev',
] as const;

/** Which variants claim each environment's host (ruling S2). */
export const BUNDLE_IDS_BY_ENVIRONMENT: Readonly<Record<EnvironmentName, readonly string[]>> = {
  production: ['app.planeahead.mobile', 'app.planeahead.mobile.preview'],
  staging: ['app.planeahead.mobile.dev'],
  local: ['app.planeahead.mobile.dev'],
  test: ['app.planeahead.mobile.dev'],
};

/** The universal-link path the app claims (apps/mobile/app.config.ts MAGIC_LINK_PATH). */
export const UNIVERSAL_LINK_PATH_PATTERN = `${MAGIC_LINK_LANDING_PATH}*`;

/** The variables this module reads; declared here rather than widening the Worker's `Env`. */
interface WellKnownVars {
  readonly APPLE_TEAM_ID?: string;
  readonly APP_BUNDLE_IDS?: string;
  readonly ANDROID_SHA256_FINGERPRINTS?: string;
}

const TEAM_ID_SHAPE = /^[A-Z0-9]{10}$/;
const BUNDLE_ID_SHAPE = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$/;
const FINGERPRINT_SHAPE = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

const HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/json',
  'cache-control': 'public, max-age=3600',
  'x-content-type-options': 'nosniff',
};

export function appleTeamId(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return TEAM_ID_SHAPE.test(trimmed) ? trimmed : null;
}

export function appBundleIds(
  value: string | undefined,
  environment: EnvironmentName = 'production',
): string[] {
  if (value === undefined || value.trim() === '') {
    return [...BUNDLE_IDS_BY_ENVIRONMENT[environment]];
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => BUNDLE_ID_SHAPE.test(entry));
}

/** `package=FP,FP;package=FP` to package -> fingerprints; malformed entries are dropped. */
export function androidFingerprints(value: string | undefined): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const entry of (value ?? '').split(';')) {
    const eq = entry.indexOf('=');
    if (eq < 0) {
      continue;
    }
    const packageName = entry.slice(0, eq).trim();
    if (!BUNDLE_ID_SHAPE.test(packageName)) {
      continue;
    }
    const fingerprints = entry
      .slice(eq + 1)
      .split(',')
      .map((fingerprint) => fingerprint.trim().toUpperCase())
      .filter((fingerprint) => FINGERPRINT_SHAPE.test(fingerprint));
    if (fingerprints.length > 0) {
      result.set(packageName, [...(result.get(packageName) ?? []), ...fingerprints]);
    }
  }
  return result;
}

export function appleAppSiteAssociation(teamId: string, bundleIds: readonly string[]) {
  return {
    applinks: {
      details: [
        {
          appIDs: bundleIds.map((bundleId) => `${teamId}.${bundleId}`),
          components: [
            {
              '/': UNIVERSAL_LINK_PATH_PATTERN,
              comment: 'The emailed magic link, verified inside the app',
            },
          ],
        },
      ],
    },
  };
}

export function assetLinks(fingerprints: ReadonlyMap<string, readonly string[]>) {
  return [...fingerprints].map(([packageName, sha256]) => ({
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: packageName,
      sha256_cert_fingerprints: [...sha256],
    },
  }));
}

function vars(c: Context<AppBindings>): WellKnownVars {
  return c.env as AppBindings['Bindings'] & WellKnownVars;
}

function notConfigured(c: Context<AppBindings>, file: string): Response {
  return c.json(
    {
      error: 'not_found' as const,
      message: `${file} is not configured in this environment`,
      requestId: c.var.requestId ?? 'unknown',
    },
    404,
  );
}

function bundleIdsFor(c: Context<AppBindings>): string[] {
  return appBundleIds(vars(c).APP_BUNDLE_IDS, environmentName(c.env));
}

function appleAssociation(c: Context<AppBindings>): Response {
  const env = vars(c);
  const teamId = appleTeamId(env.APPLE_TEAM_ID);
  const bundleIds = bundleIdsFor(c);
  if (teamId === null || bundleIds.length === 0) {
    return notConfigured(c, 'apple-app-site-association');
  }
  return c.body(JSON.stringify(appleAppSiteAssociation(teamId, bundleIds)), 200, { ...HEADERS });
}

function androidAssociation(c: Context<AppBindings>): Response {
  const claimed = new Set(bundleIdsFor(c));
  const fingerprints = new Map(
    [...androidFingerprints(vars(c).ANDROID_SHA256_FINGERPRINTS)].filter(([packageName]) =>
      claimed.has(packageName),
    ),
  );
  if (fingerprints.size === 0) {
    return notConfigured(c, 'assetlinks.json');
  }
  return c.body(JSON.stringify(assetLinks(fingerprints)), 200, { ...HEADERS });
}

/** Mounted at `/.well-known` by src/index.ts, outside `AppType` (no client calls it). */
export const wellKnownRoutes = new Hono<AppBindings>()
  .get('/apple-app-site-association', appleAssociation)
  .get('/apple-app-site-association.json', appleAssociation)
  .get('/assetlinks.json', androidAssociation);
