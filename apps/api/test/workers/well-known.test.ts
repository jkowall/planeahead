/**
 * The association files through the real Worker and its whole middleware chain (increment 9):
 * mounted at `/.well-known`, reachable without a session, and in an environment without an Apple
 * team id (this suite's) a 404 that names the file rather than the unknown-route 404.
 */

import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('/.well-known through the Worker', () => {
  it.each([
    ['/.well-known/apple-app-site-association', 'apple-app-site-association'],
    ['/.well-known/assetlinks.json', 'assetlinks.json'],
  ])('%s is mounted and answers without a session', async (path, file) => {
    const response = await exports.default.fetch(`https://api.planeahead.test${path}`);
    expect(response.status).toBe(404);
    const body = await response.json<{ error: string; message: string }>();
    expect(body.error).toBe('not_found');
    expect(body.message).toBe(`${file} is not configured in this environment`);
  });

  it('does not add the association files to the unknown-route surface', async () => {
    const response = await exports.default.fetch(
      'https://api.planeahead.test/.well-known/security.txt',
    );
    expect(response.status).toBe(404);
    expect(await response.json()).not.toHaveProperty('message');
  });
});
