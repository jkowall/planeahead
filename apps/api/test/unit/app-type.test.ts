/**
 * `AppType` and `hcWithType` (increment 8, ruling K9): the RPC surface the mobile client is typed
 * from carries every `/v1` route this increment adds, the validators' failures are typed as the
 * PlaneAhead envelope, and Better Auth's catch-all stays out (its mount's return is discarded).
 * The type assertions are checked by `tsc` over `test/`; the run-time half builds real URLs.
 */

import type { InferRequestType, InferResponseType } from 'hono/client';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { hcWithType, type Client } from '../../src/client';

const client = hcWithType('https://api.planeahead.test');

describe('AppType', () => {
  it('carries every /v1 route of increment 8', () => {
    expectTypeOf(client.v1.flights.search.$get).toBeFunction();
    expectTypeOf(client.v1.flights.$post).toBeFunction();
    expectTypeOf(client.v1.flights.$get).toBeFunction();
    expectTypeOf(client.v1.flights[':id'].$get).toBeFunction();
    expectTypeOf(client.v1.flights[':id'].$delete).toBeFunction();
    expectTypeOf(client.v1.flights[':id'].refresh.$post).toBeFunction();
    expectTypeOf(client.v1.sync.$get).toBeFunction();
    expectTypeOf(client.v1.me.delete.$post).toBeFunction();
    expectTypeOf(client.v1.webhooks.apple.$post).toBeFunction();
    expectTypeOf(client.v1.webhooks.revenuecat.$post).toBeFunction();

    expect(client.v1.flights[':id'].refresh.$url({ param: { id: 'abc' } }).pathname).toBe(
      '/v1/flights/abc/refresh',
    );
    expect(client.v1.sync.$url().pathname).toBe('/v1/sync');
    expect(client.v1.me.delete.$url().pathname).toBe('/v1/me/delete');
  });

  it('types the request inputs from the shared schemas, query values included', () => {
    type Search = InferRequestType<typeof client.v1.flights.search.$get>['query'];
    expectTypeOf<Search['number']>().toEqualTypeOf<string | string[]>();
    type Subscribe = InferRequestType<typeof client.v1.flights.$post>['json'];
    expectTypeOf<Subscribe>().toHaveProperty('flightKey');
    expectTypeOf<Subscribe>().toHaveProperty('number');
  });

  it('types a validation failure as the PlaneAhead envelope, never the raw Zod result', () => {
    type Failed = InferResponseType<typeof client.v1.flights.$post, 400>;
    type Envelope = Extract<Failed, { error: 'validation_failed' }>;
    expectTypeOf<Envelope['issues']>().toBeArray();
    expectTypeOf<Extract<Failed, { success: false }>>().toBeNever();
  });

  it('types the success bodies the mobile client reads', () => {
    type Deleted = InferResponseType<typeof client.v1.me.delete.$post, 200>;
    expectTypeOf<Deleted>().toEqualTypeOf<{ deleted: true; wipeLocalStore: true }>();
    type Sync = InferResponseType<typeof client.v1.sync.$get, 200>;
    expectTypeOf<Sync>().toHaveProperty('cursor');
    expectTypeOf<Sync>().toHaveProperty('hasMore');
    expectTypeOf<Sync>().toHaveProperty('changes');
    expectTypeOf<Sync>().toHaveProperty('flights');
  });

  it('keeps the Better Auth catch-all out of the typed surface', () => {
    expectTypeOf<'api' extends keyof Client ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<'v1' extends keyof Client ? true : false>().toEqualTypeOf<true>();
  });
});
