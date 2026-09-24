import { describe, expect, it } from 'vitest';
import {
  PRODUCT_EVENTS_MAX_BATCH,
  PRODUCT_EVENT_POINT_BLOBS,
  PRODUCT_EVENT_PROPS_MAX_KEYS,
  ProductEventV1,
  ProductEventsBatchV1,
  productEventPoint,
} from '../src/events';
import { ListSubscribersResponseV1 } from '../src/rpc';

const ANALYTICS_ID = '4f0c6b8e-2a7d-4c1b-9e3f-8a6d5c4b3a21';

describe('ProductEventsBatchV1 (the shape apps/mobile/src/lib/analytics.ts sends)', () => {
  it('accepts the mobile client batch as written', () => {
    const body = {
      analyticsId: ANALYTICS_ID,
      events: [
        { name: 'app_open', at: '2026-09-23T12:00:00.000Z', props: { variant: 'production' } },
        { name: 'app_foreground', at: '2026-09-23T12:05:00.000Z' },
      ],
    };
    const batch = ProductEventsBatchV1.parse(body);
    expect(batch.events.map((event) => ProductEventV1.safeParse(event).success)).toEqual([
      true,
      true,
    ]);
  });

  it('refuses an envelope without a uuid analytics id or with too many events', () => {
    expect(ProductEventsBatchV1.safeParse({ analyticsId: 'nope', events: [{}] }).success).toBe(
      false,
    );
    const many = Array.from({ length: PRODUCT_EVENTS_MAX_BATCH + 1 }, () => ({}));
    expect(
      ProductEventsBatchV1.safeParse({ analyticsId: ANALYTICS_ID, events: many }).success,
    ).toBe(false);
    expect(ProductEventsBatchV1.safeParse({ analyticsId: ANALYTICS_ID, events: [] }).success).toBe(
      false,
    );
  });

  it('refuses an unknown event name and a props bag over its caps, one event at a time', () => {
    expect(
      ProductEventV1.safeParse({ name: 'screen_view', at: '2026-09-23T12:00:00Z' }).success,
    ).toBe(false);
    const wide = Object.fromEntries(
      Array.from({ length: PRODUCT_EVENT_PROPS_MAX_KEYS + 1 }, (_, i) => [`k${String(i)}`, i]),
    );
    expect(
      ProductEventV1.safeParse({ name: 'app_open', at: '2026-09-23T12:00:00Z', props: wide })
        .success,
    ).toBe(false);
    expect(
      ProductEventV1.safeParse({
        name: 'app_open',
        at: '2026-09-23T12:00:00Z',
        props: { nested: { no: true } },
      }).success,
    ).toBe(false);
  });

  it('builds a point indexed by the analytics id with the name and environment as blobs', () => {
    const event = ProductEventV1.parse({
      name: 'app_open',
      at: '2026-09-23T12:00:00.000Z',
      props: { variant: 'preview' },
    });
    const point = productEventPoint(ANALYTICS_ID, event, 'staging');
    expect(point.indexes).toEqual([ANALYTICS_ID]);
    expect(point.blobs).toHaveLength(PRODUCT_EVENT_POINT_BLOBS.length);
    expect(point.blobs.slice(0, 2)).toEqual(['app_open', 'staging']);
    expect(JSON.parse(point.blobs[2] ?? '')).toEqual({ variant: 'preview' });
  });
});

describe('ListSubscribersResponseV1', () => {
  it('parses a list and tolerates unknown fields', () => {
    const parsed = ListSubscribersResponseV1.parse({
      rpcVersion: 1,
      flightKey: null,
      phase: 'absent',
      subscribers: [
        {
          subscriptionId: '01996a00-0000-7000-8000-000000000001',
          userId: 'u',
          createdAtMs: 1,
          extra: 'kept',
        },
      ],
      future: true,
    });
    expect(parsed.subscribers[0]?.userId).toBe('u');
  });
});
