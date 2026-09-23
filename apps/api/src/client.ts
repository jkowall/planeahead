/**
 * The typed RPC client for the mobile app (increment 8, ruling K9; ADR 0004).
 *
 * `hcWithType` is `hc<AppType>` with its type computed HERE, once, where the server types live,
 * so a consumer that imports a pre-compiled declaration of this module does not instantiate the
 * whole server type graph in its own type checker (Hono's RPC guide). The mobile app calls it
 * with the API origin and its own `fetch`/`headers` options (increment 9). Only types cross into
 * the app: this module imports nothing from the Worker at run time but `hono/client`.
 */

import { hc } from 'hono/client';
import type { AppType } from './index';

export type { AppType };

export type Client = ReturnType<typeof hc<AppType>>;

export const hcWithType = (...args: Parameters<typeof hc>): Client => hc<AppType>(...args);
