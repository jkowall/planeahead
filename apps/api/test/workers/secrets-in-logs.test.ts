/**
 * Ruling F5, both halves.
 *
 *   1. Every secret the Worker reads (`WORKER_SECRET_NAMES` in src/env.ts) is listed in
 *      `.dev.vars.example` (so `wrangler secret put` has a checklist) and in `.dev.vars.test` (so
 *      the suite exercises the real code path with a dummy value). The example file's key names
 *      arrive through the `TEST_DEV_VARS_EXAMPLE_KEYS` binding test/globalSetup.ts injects; the
 *      test file's values are the bindings themselves.
 *   2. No secret value reaches a log line. Every flow of the increment is driven through the real
 *      Worker while the console is captured (the Worker runs in this isolate), including the
 *      failure paths that log the most, and every captured line is searched for every secret:
 *      the configured ones, and the per-request ones (the magic-link token, the Apple refresh
 *      token, the identity tokens, the authorization code, the session cookies).
 */

import { describe, expect, it } from 'vitest';
import { normalisePem } from '../../src/auth/apple-client-secret';
import { TEST_SEAM_NAMES, WORKER_SECRET_NAMES } from '../../src/env';
import {
  appleNativeSignIn,
  captureLogs,
  cookiesFrom,
  googleNativeSignIn,
  jsonRequest,
  magicLinkTokenFor,
  registerDevice,
  signInAnonymously,
  testEnv,
  uniqueEmail,
  uniqueInstallId,
  uniqueIp,
  worker,
} from './helpers/auth';

const exampleKeys = new Set((testEnv.TEST_DEV_VARS_EXAMPLE_KEYS ?? '').split(',').filter(Boolean));

describe('.dev.vars.example and .dev.vars.test', () => {
  it('list every secret the Worker reads', () => {
    expect(exampleKeys.size).toBeGreaterThan(0);
    for (const name of WORKER_SECRET_NAMES) {
      expect(exampleKeys, `${name} in .dev.vars.example`).toContain(name);
      // The value is a binding under test; `SENTRY_DSN` is deliberately empty.
      expect(typeof testEnv[name], `${name} in .dev.vars.test`).toBe('string');
    }
    for (const name of TEST_SEAM_NAMES) {
      expect(exampleKeys, `${name} documented as an optional seam`).toContain(name);
    }
  });

  it('gives every secret used by a flow a non-empty dummy value', () => {
    for (const name of WORKER_SECRET_NAMES) {
      if (name === 'SENTRY_DSN') {
        continue;
      }
      expect(testEnv[name]?.length ?? 0, name).toBeGreaterThan(8);
    }
  });
});

describe('no secret value reaches a log line', () => {
  it('across every flow, including the failure paths', async () => {
    const dynamicSecrets: string[] = [];
    const { lines } = await captureLogs(async () => {
      // Anonymous, then the account routes.
      const anonymous = await signInAnonymously();
      dynamicSecrets.push(anonymous.cookie);
      await registerDevice(anonymous, uniqueInstallId('logs'), {
        pushTokenKind: 'apns',
        pushToken: `apns-secret-${crypto.randomUUID()}`,
      });
      await worker(
        jsonRequest('/v1/me', 'GET', undefined, { ip: anonymous.ip, cookie: anonymous.cookie }),
      );

      // Magic link: request, cap overflow, verify with the anonymous cookie (merge path).
      const email = uniqueEmail('logs');
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await worker(
          jsonRequest(
            '/api/auth/sign-in/magic-link',
            'POST',
            { email },
            { ip: uniqueIp(), origin: null },
          ),
        );
      }
      const token = await magicLinkTokenFor(email);
      dynamicSecrets.push(token);
      const verified = await worker(
        jsonRequest(
          `/api/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
          'GET',
          undefined,
          {
            ip: anonymous.ip,
            cookie: anonymous.cookie,
            origin: null,
          },
        ),
      );
      const verifiedCookie = cookiesFrom(verified);
      if (verifiedCookie !== null) {
        dynamicSecrets.push(verifiedCookie);
      }
      // A replay of a consumed token: the error path.
      await worker(
        jsonRequest(
          `/api/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
          'GET',
          undefined,
          {
            ip: uniqueIp(),
            origin: null,
          },
        ),
      );

      // Apple: success, a rejected code, a nonce mismatch, a missing email.
      const apple = await appleNativeSignIn({ cookie: (await signInAnonymously()).cookie });
      dynamicSecrets.push(
        apple.identityToken,
        apple.authorizationCode,
        `rt_${apple.authorizationCode}_`,
      );
      const appleCookie = cookiesFrom(apple.response);
      if (appleCookie !== null) {
        dynamicSecrets.push(appleCookie);
      }
      const badCode = await appleNativeSignIn({ authorizationCode: 'invalid-code' });
      dynamicSecrets.push(badCode.identityToken);
      const badNonce = await appleNativeSignIn({ nonceClaim: 'wrong' });
      dynamicSecrets.push(badNonce.identityToken, badNonce.rawNonce);
      await appleNativeSignIn({ email: null });

      // Google: success with the merge path, and the two rejections.
      const google = await googleNativeSignIn({ cookie: (await signInAnonymously()).cookie });
      dynamicSecrets.push(google.identityToken, google.rawNonce);
      await googleNativeSignIn({ nonceClaim: null });
      await googleNativeSignIn({ audience: 'nobody' });

      // A rate-limited request and a forged cookie.
      const ip = uniqueIp();
      for (let attempt = 0; attempt < 7; attempt += 1) {
        await worker(jsonRequest('/api/auth/sign-in/anonymous', 'POST', {}, { ip, origin: null }));
      }
      await worker(
        jsonRequest('/v1/me', 'GET', undefined, { cookie: 'better-auth.session_token=forged.sig' }),
      );
    });

    // The suite produced log lines (otherwise this test proves nothing).
    expect(lines.length).toBeGreaterThan(10);

    const configured: [string, string][] = [];
    for (const name of WORKER_SECRET_NAMES) {
      const value = testEnv[name];
      if (typeof value === 'string' && value !== '') {
        configured.push([name, value]);
        if (name === 'APPLE_SIWA_P8') {
          // The key body without the PEM armour, in both newline encodings.
          const body = normalisePem(value)
            .split('\n')
            .filter((line) => !line.startsWith('-----'))
            .join('');
          configured.push([`${name} (body)`, body]);
          configured.push([`${name} (escaped)`, normalisePem(value).replaceAll('\n', '\\n')]);
        }
      }
    }
    const joined = lines.join('\n');
    for (const [name, value] of configured) {
      expect(joined.includes(value), `${name} appears in a log line`).toBe(false);
    }
    for (const secret of dynamicSecrets) {
      // Cookie header values are `name=value; name=value`; check each value.
      const values =
        secret.includes('=') && secret.includes('session_token')
          ? secret.split(';').map((pair) => pair.split('=').slice(1).join('=').trim())
          : [secret];
      for (const value of values) {
        if (value.length < 8) {
          continue;
        }
        expect(
          joined.includes(value),
          `a per-request secret starting ${value.slice(0, 6)} appears in a log line`,
        ).toBe(false);
        expect(
          joined.includes(encodeURIComponent(value)),
          `a per-request secret (url-encoded) appears in a log line`,
        ).toBe(false);
      }
    }
    // The raw email address never appears either (the cap hashes it, the sender logs a domain).
    expect(joined.includes('@example.test')).toBe(false);
  });
});
