/**
 * The association files (increment 9, ruling P4): what Apple's CDN and Android's App Links
 * verifier read, built from the environment, served as JSON at the exact paths they fetch. Each
 * host names only the variants that claim it (ruling S2): production the production and preview
 * builds, staging (and a local Worker) the development build.
 */

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppBindings } from '../../src/env';
import {
  BUNDLE_IDS_BY_ENVIRONMENT,
  DEFAULT_APP_BUNDLE_IDS,
  androidFingerprints,
  appBundleIds,
  appleTeamId,
  wellKnownRoutes,
} from '../../src/routes/well-known';

const FP_A = Array.from({ length: 32 }, (_, index) => (index + 16).toString(16).toUpperCase()).join(
  ':',
);
const FP_B = Array.from({ length: 32 }, () => 'AB').join(':');

function app() {
  return new Hono<AppBindings>().route('/.well-known', wellKnownRoutes);
}

function request(path: string, env: Record<string, string>) {
  return app().request(`https://api.planeahead.test${path}`, {}, env);
}

describe('GET /.well-known/apple-app-site-association', () => {
  const env = { APPLE_TEAM_ID: 'A1B2C3D4E5', ENVIRONMENT: 'production' };

  it.each([
    '/.well-known/apple-app-site-association',
    '/.well-known/apple-app-site-association.json',
  ])("%s names production's app ids and the magic-link path, as JSON", async (path) => {
    const response = await request(path, env);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('location')).toBeNull();
    expect(await response.json()).toEqual({
      applinks: {
        details: [
          {
            appIDs: [
              'A1B2C3D4E5.app.planeahead.mobile',
              'A1B2C3D4E5.app.planeahead.mobile.preview',
            ],
            components: [
              {
                '/': '/auth/magic-link*',
                comment: 'The emailed magic link, verified inside the app',
              },
            ],
          },
        ],
      },
    });
  });

  it.each([
    ['staging', ['A1B2C3D4E5.app.planeahead.mobile.dev']],
    ['local', ['A1B2C3D4E5.app.planeahead.mobile.dev']],
  ])('on %s names the development build only', async (environment, appIDs) => {
    const response = await request('/.well-known/apple-app-site-association', {
      APPLE_TEAM_ID: 'A1B2C3D4E5',
      ENVIRONMENT: environment,
    });
    const body = await response.json<{ applinks: { details: { appIDs: string[] }[] } }>();
    expect(body.applinks.details[0]?.appIDs).toEqual(appIDs);
  });

  it('takes the bundle ids from APP_BUNDLE_IDS when set', async () => {
    const response = await request('/.well-known/apple-app-site-association', {
      ...env,
      APP_BUNDLE_IDS: 'app.planeahead.mobile, not a bundle id',
    });
    const body = await response.json<{ applinks: { details: { appIDs: string[] }[] } }>();
    expect(body.applinks.details[0]?.appIDs).toEqual(['A1B2C3D4E5.app.planeahead.mobile']);
  });

  it.each([
    {},
    { APPLE_TEAM_ID: '' },
    { APPLE_TEAM_ID: 'a1b2c3d4e5' },
    { APPLE_TEAM_ID: 'TOO-LONG-TEAM' },
  ])('answers 404, never an empty association, without a valid team id (%o)', async (badEnv) => {
    const response = await request('/.well-known/apple-app-site-association', badEnv);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'not_found' });
  });
});

describe('GET /.well-known/assetlinks.json', () => {
  const ALL_PACKAGES = `app.planeahead.mobile=${FP_A},${FP_B.toLowerCase()};app.planeahead.mobile.preview=${FP_A};app.planeahead.mobile.dev=${FP_B}`;

  it('names each package this host serves with its signing and upload fingerprints, as JSON', async () => {
    const response = await request('/.well-known/assetlinks.json', {
      ENVIRONMENT: 'production',
      ANDROID_SHA256_FINGERPRINTS: ALL_PACKAGES,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'app.planeahead.mobile',
          sha256_cert_fingerprints: [FP_A, FP_B],
        },
      },
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'app.planeahead.mobile.preview',
          sha256_cert_fingerprints: [FP_A],
        },
      },
    ]);
  });

  it('on staging names the development package only, whatever else is configured', async () => {
    const response = await request('/.well-known/assetlinks.json', {
      ENVIRONMENT: 'staging',
      ANDROID_SHA256_FINGERPRINTS: ALL_PACKAGES,
    });
    expect(await response.json()).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'app.planeahead.mobile.dev',
          sha256_cert_fingerprints: [FP_B],
        },
      },
    ]);
  });

  it('answers 404 when none of the configured packages claims this host', async () => {
    const response = await request('/.well-known/assetlinks.json', {
      ENVIRONMENT: 'staging',
      ANDROID_SHA256_FINGERPRINTS: `app.planeahead.mobile=${FP_A}`,
    });
    expect(response.status).toBe(404);
  });

  it('answers 404 when no fingerprint is configured', async () => {
    const response = await request('/.well-known/assetlinks.json', {});
    expect(response.status).toBe(404);
  });
});

describe('the parsers', () => {
  it('validate the team id', () => {
    expect(appleTeamId(' A1B2C3D4E5 ')).toBe('A1B2C3D4E5');
    expect(appleTeamId(undefined)).toBeNull();
  });

  it("default the bundle ids to the variants that claim the environment's host", () => {
    expect(appBundleIds(undefined, 'production')).toEqual([
      'app.planeahead.mobile',
      'app.planeahead.mobile.preview',
    ]);
    expect(appBundleIds('', 'staging')).toEqual(['app.planeahead.mobile.dev']);
    // Every variant is claimed by exactly one deployed host.
    expect(
      [...BUNDLE_IDS_BY_ENVIRONMENT.production, ...BUNDLE_IDS_BY_ENVIRONMENT.staging].sort(),
    ).toEqual([...DEFAULT_APP_BUNDLE_IDS].sort());
  });

  it('drop malformed fingerprint entries instead of publishing them', () => {
    expect(
      androidFingerprints(`app.planeahead.mobile=AB:CD;bad package=${FP_A};=${FP_A};nonsense`),
    ).toEqual(new Map());
  });
});
