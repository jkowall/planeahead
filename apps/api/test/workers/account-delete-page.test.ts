/**
 * `GET /account/delete` (increment 12, ruling W8): Google Play's public account-deletion URL,
 * served by the API Worker. Static, no script, a strict CSP whose one style hash matches the one
 * inline stylesheet, cached publicly, the support inbox from `SUPPORT_EMAIL`, the in-app path,
 * and the deletion disclosure (what is deleted, what survives, the 24 hour history window).
 */

import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SUPPORT_EMAIL,
  accountDeletePageBody,
  supportEmail,
} from '../../src/routes/account-delete-page';
import { API_ORIGIN, testEnv } from './helpers/auth';

async function styleHash(html: string): Promise<string> {
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(style));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

describe('GET /account/delete', () => {
  it('serves the static page with a strict CSP, no script and a public cache', async () => {
    const response = await exports.default.fetch(`${API_ORIGIN}/account/delete`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600');
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('script-src');
    expect(csp).toContain(`style-src 'sha256-${await styleHash(html)}'`);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });

  it('names the in-app path, what is deleted, what survives and the inbox from the var', async () => {
    const html = await (await exports.default.fetch(`${API_ORIGIN}/account/delete`)).text();

    expect(testEnv.SUPPORT_EMAIL).toBe('support@planeahead.app');
    expect(html).toContain('mailto:support@planeahead.app');
    expect(html).toContain('<strong>Settings</strong>');
    expect(html).toContain('<strong>Delete account</strong>');
    expect(html).toContain('What is deleted');
    expect(html).toContain('What is kept, and why');
    expect(html).toContain('up to 24 hours');
    expect(html).toContain('400 days');
  });

  it('escapes the inbox and falls back to the default for a malformed one', () => {
    expect(supportEmail('help@example.test')).toBe('help@example.test');
    expect(supportEmail('not an address')).toBe(DEFAULT_SUPPORT_EMAIL);
    expect(supportEmail(undefined)).toBe(DEFAULT_SUPPORT_EMAIL);
    expect(accountDeletePageBody('a&b@example.test')).toContain('a&amp;b@example.test');
  });
});
