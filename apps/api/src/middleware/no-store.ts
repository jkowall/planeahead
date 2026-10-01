/**
 * The `/v1` default `Cache-Control: no-store` (increment 18, ruling R1).
 *
 * The phone's HTTP stack keeps a disk cache: `expo/fetch` builds OkHttp's 10 MB cache on Android
 * and uses the default `URLSession` (a persistent `NSURLCache`) on iOS. Both store any cacheable
 * GET that does not say `no-store`, `private` and `no-cache` included, and the stored copy
 * outlives sign-out and account deletion (`forgetAccount` clears SQLite and the query cache, not
 * the HTTP cache). Every `/v1` answer is the caller's own data (the sync feed, the designator
 * search, the boards), so none may be stored: the first middleware of the `/v1` chain adds
 * `no-store` to every answer that does not already name its own `Cache-Control`, after the route
 * and the error handler have run, so a 401, a 404 and a 500 carry it too. A request-side
 * `cache: 'no-store'` is no substitute: `expo/fetch` drops the option.
 */

import { createMiddleware } from 'hono/factory';
import type { AppBindings } from '../env';

export const NO_STORE = 'no-store';

export function noStoreByDefault() {
  return createMiddleware<AppBindings>(async (c, next) => {
    await next();
    if (!c.res.headers.has('Cache-Control')) {
      c.res.headers.set('Cache-Control', NO_STORE);
    }
  });
}
