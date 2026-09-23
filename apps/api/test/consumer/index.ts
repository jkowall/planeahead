/**
 * A consumer of the typed client with no Workers globals (see tsconfig.json beside this file).
 * It compiles only if `@planeahead/api/client` resolves to the emitted declaration and that
 * declaration needs nothing but `hono` and `@planeahead/shared`; the statements below also pin
 * the response types the mobile app reads, as seen from outside the Worker.
 */

import type { InferResponseType } from 'hono/client';
import { hcWithType, type Client } from '@planeahead/api/client';

const client: Client = hcWithType('https://api.planeahead.test', {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
});

type Created = InferResponseType<typeof client.v1.flights.$post, 201>;
type Capped = InferResponseType<typeof client.v1.flights.$post, 403>;
type Sync = InferResponseType<typeof client.v1.sync.$get, 200>;
type Deleted = InferResponseType<typeof client.v1.me.delete.$post, 200>;

export const subscriptionId = (body: Created): string => body.subscription.id;
export const capName = (body: Capped): string => body.cap;
export const cursor = (body: Sync): string => body.cursor;
export const wiped = (body: Deleted): true => body.wipeLocalStore;
export const searchUrl: URL = client.v1.flights.search.$url();
