/**
 * The typed RPC client for the mobile app (increment 8, rulings K9 and O10; ADR 0004).
 *
 * Hono's RPC guide pattern: `hc<AppType>('')` is instantiated ONCE here, where the server types
 * live, and `Client` is `typeof` that value, so the declaration `tsc -b` emits for this module
 * (`dist/src/client.d.ts`, the `types` of the package's `./client` export) spells the whole client
 * surface out instead of naming `AppType`. A consumer that imports it therefore never
 * instantiates the server type graph, and never needs the Worker's globals (`KVNamespace`,
 * `DurableObjectState`, `cloudflare:workers`): the only imports left in the emitted declaration
 * are `hono` and leaf types from `@planeahead/shared`. `test/consumer/` type-checks exactly that
 * with `types: []` (the `typecheck` script runs it after `tsc -b`).
 *
 * Nothing here re-exports `AppType`: a re-export would put `import('./index')` back into the
 * declaration. The mobile app calls `hcWithType(origin, { fetch, headers })` (increment 9); only
 * `hono/client` crosses into the app at run time.
 */

import { hc } from 'hono/client';
import type { AppType } from './index';

// Only its type is used, and that is the point: the declaration emitter spells `typeof client`
// out in full (Hono's RPC guide pattern), so the emitted client never names `AppType`.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const client = hc<AppType>('');

/** The typed client: every `/v1` route of `AppType`, with its request and response types. */
export type Client = typeof client;

export const hcWithType = (...args: Parameters<typeof hc>): Client => hc<AppType>(...args);
