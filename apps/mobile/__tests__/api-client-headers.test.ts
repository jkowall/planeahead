/**
 * Spike 2 (docs/increments/09): is the Hono client's async `headers` function evaluated per
 * request, or once per client instance?
 *
 * It matters because the session cookie is refreshed by `GET /api/auth/get-session` and read by
 * the `/v1` client through `authClient.getCookie()`. Evaluated once, a refreshed or upgraded
 * session would never reach `/v1` until the app restarted, and every call would answer 401.
 * Observed with hono 4.13.8: once per request (this test), so no custom fetch wrapper is needed.
 */

import { createApiClient } from '../src/lib/api-client';

function recordingFetch() {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: input instanceof Request ? input.url : String(input), init });
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  return { calls, fetchMock };
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

describe('the typed /v1 client', () => {
  it('evaluates the async headers function on every request (spike 2)', async () => {
    let cookieVersion = 0;
    const getCookie = jest.fn(() => {
      cookieVersion += 1;
      return Promise.resolve(`better-auth.session_token=v${String(cookieVersion)}`);
    });
    const { calls, fetchMock } = recordingFetch();
    const api = createApiClient({
      baseUrl: 'https://api.planeahead.test',
      getCookie,
      getInstallId: () => 'install-0123456789',
      fetch: fetchMock,
    });

    await api.v1.me.$get();
    await api.v1.me.$get();
    await api.v1.sync.$get({ query: {} });

    expect(getCookie).toHaveBeenCalledTimes(3);
    expect(calls.map((call) => headerOf(call.init, 'cookie'))).toEqual([
      'better-auth.session_token=v1',
      'better-auth.session_token=v2',
      'better-auth.session_token=v3',
    ]);
  });

  it("sends X-Install-Id and uses credentials 'omit', never the platform cookie jar", async () => {
    const { calls, fetchMock } = recordingFetch();
    const api = createApiClient({
      baseUrl: 'https://api.planeahead.test',
      getCookie: () => Promise.resolve('better-auth.session_token=abc'),
      getInstallId: () => 'install-0123456789',
      fetch: fetchMock,
    });

    await api.v1.me.$get();
    await api.request({
      method: 'POST',
      path: '/v1/flights',
      body: {},
      idempotencyKey: 'key-0123456789',
    });

    for (const call of calls) {
      expect(call.init?.credentials).toBe('omit');
      expect(headerOf(call.init, 'x-install-id')).toBe('install-0123456789');
    }
    expect(headerOf(calls[1]?.init, 'idempotency-key')).toBe('key-0123456789');
    expect(calls[0]?.url).toBe('https://api.planeahead.test/v1/me');
  });

  it('omits the Cookie header when signed out rather than sending an empty one', async () => {
    const { calls, fetchMock } = recordingFetch();
    const api = createApiClient({
      baseUrl: 'https://api.planeahead.test',
      getCookie: () => Promise.resolve(''),
      getInstallId: () => null,
      fetch: fetchMock,
    });
    await api.v1.me.$get();
    expect(headerOf(calls[0]?.init, 'cookie')).toBeNull();
    expect(headerOf(calls[0]?.init, 'x-install-id')).toBeNull();
  });
});
