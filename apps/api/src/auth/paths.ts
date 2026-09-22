/**
 * Where Better Auth is mounted, as one constant three modules agree on: `createAuth` hands it to
 * Better Auth as `basePath`, the auth middleware leaves everything under it to Better Auth, and
 * the idempotency middleware skips it (Better Auth's endpoints carry their own replay semantics,
 * and a replayed `Idempotency-Key` must never answer a magic-link request from the store ahead
 * of the per-address cap).
 */

export const AUTH_BASE_PATH = '/api/auth';
export const AUTH_PATH_PREFIX = `${AUTH_BASE_PATH}/`;

/**
 * The browser landing page for the emailed magic link, OUTSIDE the Better Auth mount. A GET
 * there never consumes the token (mail scanners follow links); its one button POSTs to the
 * consume route under the mount. Increment 9's universal link intercepts this path.
 */
export const MAGIC_LINK_LANDING_PATH = '/auth/magic-link';
export const MAGIC_LINK_CONSUME_PATH = `${AUTH_BASE_PATH}/magic-link/consume`;
