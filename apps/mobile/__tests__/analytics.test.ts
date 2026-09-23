/**
 * First-party analytics (ADR 0005): `POST /v1/events` carries the install-scoped analytics id and
 * NOTHING that joins it to an account: no session cookie, no `X-Install-Id`, no platform cookie
 * jar. The endpoint is still the API's 501 stub, which turns the client off instead of retrying.
 */

import { createAnalytics } from '../src/lib/analytics';

function recorder(status: number) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchMock = jest.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(new Response(null, { status }));
  });
  return { calls, fetchMock: fetchMock as unknown as typeof fetch };
}

describe('analytics', () => {
  it('posts batched events with the analytics id only', async () => {
    const { calls, fetchMock } = recorder(202);
    const analytics = createAnalytics({
      baseUrl: 'https://api.planeahead.test',
      analyticsId: () => 'analytics-0001',
      fetch: fetchMock,
      now: () => new Date('2026-09-23T10:00:00.000Z'),
    });
    analytics.track('app_open', { variant: 'development' });
    analytics.track('app_foreground');
    await analytics.flush();

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe('https://api.planeahead.test/v1/events');
    expect(call?.init.credentials).toBe('omit');
    const headers = new Headers(call?.init.headers);
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('x-install-id')).toBeNull();
    expect(JSON.parse(call?.init.body as string)).toEqual({
      analyticsId: 'analytics-0001',
      events: [
        { name: 'app_open', at: '2026-09-23T10:00:00.000Z', props: { variant: 'development' } },
        { name: 'app_foreground', at: '2026-09-23T10:00:00.000Z' },
      ],
    });
    expect(analytics.queued).toBe(0);
  });

  it('stops for the process when the endpoint answers 501 (not wired yet)', async () => {
    const { calls, fetchMock } = recorder(501);
    const analytics = createAnalytics({
      baseUrl: 'https://api.planeahead.test',
      analyticsId: () => 'analytics-0001',
      fetch: fetchMock,
    });
    analytics.track('app_open');
    await analytics.flush();
    analytics.track('app_foreground');
    await analytics.flush();
    expect(calls).toHaveLength(1);
    expect(analytics.queued).toBe(0);
  });

  it('keeps a bounded queue while offline and sends it on the next flush', async () => {
    let online = false;
    const calls: string[] = [];
    const fetchMock = jest.fn((_url: string, init?: RequestInit) => {
      if (!online) {
        return Promise.reject(new TypeError('Network request failed'));
      }
      calls.push(init?.body as string);
      return Promise.resolve(new Response(null, { status: 202 }));
    }) as unknown as typeof fetch;
    const analytics = createAnalytics({
      baseUrl: 'https://api.planeahead.test',
      analyticsId: () => 'analytics-0001',
      fetch: fetchMock,
      batchSize: 1000,
    });
    for (let index = 0; index < 150; index += 1) {
      analytics.track('tick');
    }
    await analytics.flush();
    expect(analytics.queued).toBe(100);
    online = true;
    await analytics.flush();
    expect(calls).toHaveLength(1);
    expect(analytics.queued).toBe(0);
  });
});
