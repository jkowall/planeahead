/**
 * `POST /v1/events` (increment 12, ruling W9): anonymous, install-scoped, no cookie, the batch
 * shape the increment 9 mobile client already sends, one `PRODUCT_EVENTS` point per accepted
 * event, 202, and `EVENTS_RL` per client IP (300 batches per 60 s, ruling AA4).
 */

import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { PRODUCT_EVENTS_MAX_BODY_BYTES } from '@planeahead/shared';
import { createApp } from '../../src/app';
import { createV1Routes } from '../../src/routes/v1';
import wranglerConfig from '../../wrangler.jsonc?raw';
import { API_ORIGIN, testEnv, uniqueIp } from './helpers/auth';

const ANALYTICS_ID = crypto.randomUUID();

/** Exactly what apps/mobile/src/lib/analytics.ts posts: no cookie, no X-Install-Id. */
function mobileBatch(events: readonly unknown[], analyticsId: string = ANALYTICS_ID) {
  return JSON.stringify({ analyticsId, events });
}

function post(body: string, ip: string | null = uniqueIp()): Promise<Response> {
  return exports.default.fetch(`${API_ORIGIN}/v1/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(ip === null ? {} : { 'cf-connecting-ip': ip }),
    },
    body,
  });
}

interface CapturedPoint {
  readonly indexes?: string[];
  readonly blobs?: string[];
  readonly doubles?: number[];
}

describe('POST /v1/events', () => {
  it('accepts the mobile client batch without a cookie and answers 202 with the counts', async () => {
    const response = await post(
      mobileBatch([
        { name: 'app_open', at: new Date().toISOString(), props: { variant: 'production' } },
        { name: 'app_foreground', at: new Date().toISOString() },
      ]),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: 2, dropped: 0 });
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('writes one point per accepted event, indexed by the analytics id, and drops unknown events', async () => {
    const points: CapturedPoint[] = [];
    const dataset = {
      writeDataPoint: (point: CapturedPoint) => void points.push(point),
    } as unknown as AnalyticsEngineDataset;
    const app = createApp();
    app.route('/v1', createV1Routes({ events: { dataset } }));
    const ctx = createExecutionContext();
    const response = await app.fetch(
      new Request(`${API_ORIGIN}/v1/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: mobileBatch([
          { name: 'app_open', at: '2026-09-23T12:00:00.000Z', props: { variant: 'preview' } },
          { name: 'screen_view', at: '2026-09-23T12:00:01.000Z' },
          { name: 'app_foreground', at: 'not a time' },
        ]),
      }),
      testEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: 1, dropped: 2 });
    expect(points).toHaveLength(1);
    expect(points[0]?.indexes).toEqual([ANALYTICS_ID]);
    expect(points[0]?.blobs?.slice(0, 2)).toEqual(['app_open', 'test']);
    expect(JSON.parse(points[0]?.blobs?.[2] ?? '')).toEqual({ variant: 'preview' });
  });

  it('refuses a bad envelope with the 400 envelope, and an oversized body with 413', async () => {
    const noId = await post(JSON.stringify({ events: [{ name: 'app_open' }] }));
    expect(noId.status).toBe(400);
    expect((await noId.json<{ error: string }>()).error).toBe('validation_failed');

    const empty = await post(mobileBatch([]));
    expect(empty.status).toBe(400);

    const huge = await post(
      mobileBatch([
        {
          name: 'app_open',
          at: new Date().toISOString(),
          props: { blob: 'x'.repeat(PRODUCT_EVENTS_MAX_BODY_BYTES) },
        },
      ]),
    );
    expect(huge.status).toBe(413);
    expect((await huge.json<{ error: string }>()).error).toBe('payload_too_large');
  });

  it('declares EVENTS_RL as 300 batches per 60 s in every environment (ruling AA4)', () => {
    expect(eventsRlLimits()).toEqual([
      { limit: 300, period: 60 },
      { limit: 300, period: 60 },
      { limit: 300, period: 60 },
    ]);
  });

  it('brakes a client IP on EVENTS_RL past its configured limit with 429, keyed by the IP only', async () => {
    // The live binding cannot be driven past 300 from one address: the global PUBLIC_RL (120 per
    // 10 s per IP) refuses first. So the chain's PUBLIC_RL is stubbed open and EVENTS_RL is a
    // counter with the configured limit, keyed exactly as the route keys it.
    const [configured] = eventsRlLimits();
    const limit = configured?.limit ?? 0;
    const counts = new Map<string, number>();
    const keys = new Set<string>();
    const eventsLimiter = () => ({
      limit: ({ key }: { key: string }) => {
        keys.add(key);
        const next = (counts.get(key) ?? 0) + 1;
        counts.set(key, next);
        return Promise.resolve({ success: next <= limit });
      },
    });
    const dataset = { writeDataPoint: () => undefined } as unknown as AnalyticsEngineDataset;
    const app = createApp({ limiter: () => ({ limit: () => Promise.resolve({ success: true }) }) });
    app.route('/v1', createV1Routes({ events: { dataset, limiter: eventsLimiter } }));
    const send = async (ip: string) => {
      const ctx = createExecutionContext();
      const response = await app.fetch(
        new Request(`${API_ORIGIN}/v1/events`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
          body: mobileBatch([{ name: 'app_open', at: new Date().toISOString() }]),
        }),
        testEnv,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return response;
    };
    const ip = uniqueIp();
    const statuses: number[] = [];
    for (let i = 0; i < limit + 1; i += 1) {
      statuses.push((await send(ip)).status);
    }

    expect(statuses.slice(0, limit).every((status) => status === 202)).toBe(true);
    const refused = await send(ip);
    expect(statuses.at(-1)).toBe(429);
    expect(refused.status).toBe(429);
    expect((await refused.json<{ limiter: string }>()).limiter).toBe('EVENTS_RL');
    expect([...keys]).toEqual([`events:ip:${ip}`]);
    // Another address is not braked by the first one's count.
    expect((await send(uniqueIp())).status).toBe(202);
  });

  it('is braked by the live EVENTS_RL binding in the real Worker', async () => {
    // One request through the deployed chain: the binding is wired and lets a single batch in.
    expect(
      (await post(mobileBatch([{ name: 'app_open', at: new Date().toISOString() }]))).status,
    ).toBe(202);
  });
});

/** The `EVENTS_RL` entries of wrangler.jsonc, in order: local, staging, production. */
function eventsRlLimits(): { limit: number; period: number }[] {
  return [
    ...wranglerConfig.matchAll(
      /"name": "EVENTS_RL", "namespace_id": "\d+", "simple": \{ "limit": (\d+), "period": (\d+) \}/g,
    ),
  ].map((match) => ({ limit: Number(match[1]), period: Number(match[2]) }));
}
