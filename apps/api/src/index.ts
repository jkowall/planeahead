/**
 * PlaneAhead API Worker. Increment 4 replaces this with the Hono app, the AppType export and the
 * Durable Object class exports. For now it exports one function so the workspace link from
 * apps/api to @planeahead/shared is proven by a test.
 */

export interface Health {
  readonly ok: true;
  readonly name: 'planeahead';
}

export function health(): Health {
  return { ok: true, name: 'planeahead' };
}
