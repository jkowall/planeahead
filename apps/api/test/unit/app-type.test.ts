/**
 * `AppType` and `hcWithType` (increment 8, ruling K9): the RPC surface the mobile client is typed
 * from carries every `/v1` route this increment adds, the validators' failures are typed as the
 * PlaneAhead envelope, and Better Auth's catch-all stays out (its mount's return is discarded).
 * The type assertions are checked by `tsc` over `test/`; the run-time half builds real URLs.
 */

import type { InferRequestType, InferResponseType } from 'hono/client';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { FlightView, NotificationPreferences } from '@planeahead/shared';
import packageJsonText from '../../package.json?raw';
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

  it('carries the preferences routes with the shared notification contract (increment 15)', () => {
    expectTypeOf(client.v1.me.preferences.$get).toBeFunction();
    expectTypeOf(client.v1.me.preferences.$patch).toBeFunction();
    expect(client.v1.me.preferences.$url().pathname).toBe('/v1/me/preferences');
    type Patch = InferRequestType<typeof client.v1.me.preferences.$patch>['json'];
    type NotificationsPatch = NonNullable<Patch['notifications']>;
    expectTypeOf<NotificationsPatch['pushEnabled']>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<
      NonNullable<NotificationsPatch['events']>['first_gate_assignment']
    >().toEqualTypeOf<boolean | undefined>();
    type Patched = InferResponseType<typeof client.v1.me.preferences.$patch, 200>;
    expectTypeOf<Patched['notifications']>().toEqualTypeOf<NotificationPreferences>();
    expectTypeOf<Patched['preferences']['timeFormat']>().toEqualTypeOf<'12h' | '24h'>();
    type Read = InferResponseType<typeof client.v1.me.preferences.$get, 200>;
    expectTypeOf<Read['notifications']['events']['delay']>().toEqualTypeOf<boolean>();
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
    expectTypeOf<Sync['cursor']>().toEqualTypeOf<string>();
    expectTypeOf<Sync['hasMore']>().toEqualTypeOf<boolean>();
    expectTypeOf<Sync>().toHaveProperty('changes');
    expectTypeOf<Sync>().toHaveProperty('flights');
  });

  it('types every status the add-flight sheet and the store branch on (ruling O10)', () => {
    // POST /v1/flights: 201 created, 200 already, 403 capped. A plain `Response` anywhere in a
    // handler would collapse all of these to `{}`.
    type Created = InferResponseType<typeof client.v1.flights.$post, 201>;
    expectTypeOf<Created['subscription']['id']>().toEqualTypeOf<string>();
    expectTypeOf<Created['subscription']['liveTracked']>().toEqualTypeOf<boolean>();
    expectTypeOf<Created['created']>().toEqualTypeOf<true>();
    type Already = InferResponseType<typeof client.v1.flights.$post, 200>;
    expectTypeOf<Already['subscription']['flightKey']>().toBeString();
    expectTypeOf<Already['created']>().toEqualTypeOf<false>();
    type Capped = InferResponseType<typeof client.v1.flights.$post, 403>;
    expectTypeOf<Capped['error']>().toEqualTypeOf<'cap_exceeded'>();
    expectTypeOf<Capped['limit']>().toEqualTypeOf<number>();
    expectTypeOf<Capped>().toHaveProperty('cap');
    type NotFound = InferResponseType<typeof client.v1.flights.$post, 404>;
    expectTypeOf<
      Extract<NotFound, { triedDates: string[] }>['error']
    >().toEqualTypeOf<'flight_not_found'>();

    // GET /v1/flights/search: 200 the key, 404 the dates tried.
    type Found = InferResponseType<typeof client.v1.flights.search.$get, 200>;
    expectTypeOf<Found['flightKey']>().toBeString();
    expectTypeOf<Found['cached']>().toEqualTypeOf<boolean>();
    type Missing = InferResponseType<typeof client.v1.flights.search.$get, 404>;
    expectTypeOf<Missing['triedDates']>().toEqualTypeOf<string[]>();
    expectTypeOf<Missing['suggestions']>().toBeArray();

    // A status's type is that status's body alone: the sync envelope is never a 401.
    type SyncUnauthorized = InferResponseType<typeof client.v1.sync.$get, 401>;
    expectTypeOf<Extract<SyncUnauthorized, { cursor: string }>>().toBeNever();
    type SyncGone = InferResponseType<typeof client.v1.sync.$get, 410>;
    expectTypeOf<SyncGone['error']>().toEqualTypeOf<'resync_required'>();

    // POST /v1/me/delete: 401 is `account_deleted`, never the success body.
    type DeleteUnauthorized = InferResponseType<typeof client.v1.me.delete.$post, 401>;
    expectTypeOf<DeleteUnauthorized['error']>().toEqualTypeOf<'account_deleted'>();
    expectTypeOf<Extract<DeleteUnauthorized, { deleted: true }>>().toBeNever();

    // Refresh: success, 504 and 410 share one `flight` shape.
    type Refreshed = InferResponseType<(typeof client.v1.flights)[':id']['refresh']['$post'], 200>;
    type TimedOut = InferResponseType<(typeof client.v1.flights)[':id']['refresh']['$post'], 504>;
    type Archived = InferResponseType<(typeof client.v1.flights)[':id']['refresh']['$post'], 410>;
    expectTypeOf<Refreshed['flight']['key']>().toEqualTypeOf<FlightView['key']>();
    expectTypeOf<Refreshed['flight']['source']>().toEqualTypeOf<FlightView['source']>();
    expectTypeOf<TimedOut['flight']>().toEqualTypeOf<Refreshed['flight'] | null>();
    expectTypeOf<Archived['flight']>().toEqualTypeOf<Refreshed['flight'] | null>();
  });

  it('publishes the client as the emitted declaration, which a consumer without Workers types reads', () => {
    // `pnpm --filter @planeahead/api typecheck` compiles test/consumer against exactly this
    // path with `types: []` after `tsc -b` has emitted it (ruling O10).
    const packageJson = JSON.parse(packageJsonText) as {
      exports: Record<string, { types: string }>;
      scripts: Record<string, string>;
    };
    expect(packageJson.exports['./client']?.types).toBe('./dist/src/client.d.ts');
    expect(packageJson.scripts['typecheck']).toContain('tsc -p test/consumer/tsconfig.json');
  });

  it('keeps the Better Auth catch-all out of the typed surface', () => {
    expectTypeOf<'api' extends keyof Client ? true : false>().toEqualTypeOf<false>();
    expectTypeOf<'v1' extends keyof Client ? true : false>().toEqualTypeOf<true>();
  });
});
