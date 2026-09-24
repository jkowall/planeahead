/**
 * `POST /v1/events` (increment 12, ruling W9): anonymous, install-scoped, no cookie, the batch
 * shape the increment 9 mobile client already sends, one `PRODUCT_EVENTS` point per accepted
 * event, 202, and `EVENTS_RL` per client IP.
 */

import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { PRODUCT_EVENTS_MAX_BODY_BYTES } from '@planeahead/shared';
import { createApp } from '../../src/app';
import { createV1Routes } from '../../src/routes/v1';
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

  it('brakes a client IP on EVENTS_RL (60 batches per 60 s) with 429', async () => {
    const ip = uniqueIp();
    const body = mobileBatch([{ name: 'app_open', at: new Date().toISOString() }]);
    const statuses: number[] = [];
    for (let i = 0; i < 75; i += 1) {
      statuses.push((await post(body, ip)).status);
    }
    expect(statuses.filter((status) => status === 202).length).toBeLessThanOrEqual(60);
    expect(statuses).toContain(429);
    // Another address is not braked by the first one's count.
    expect((await post(body, uniqueIp())).status).toBe(202);
  });
});
