/**
 * Idempotency keys.
 *
 * A client that retries `POST /v1/flights` after a timeout must not create a second subscription,
 * and the mobile outbox retries aggressively by design. The contract is the usual one: the caller
 * sends `Idempotency-Key`, the first request's response is stored, and a replay of the same key
 * with the same request returns the stored response instead of running the handler again.
 *
 * Where this middleware sits decides what it can see. Ruling E6 registers it in the global chain
 * AHEAD of the auth middleware (`src/app.ts`), and increment 5 keeps that slot ("Auth middleware
 * replaces the placeholder"), so in the global chain `c.var.user` is never assigned by the time
 * this code reads it. Two things follow:
 *
 *   - The caller has to identify itself. An anonymous request carrying `Idempotency-Key` must
 *     also carry `X-Install-Id`, the per-installation id the mobile app generates once and sends
 *     on every request (increment 5's `POST /v1/devices` registers the same value). The key is
 *     scoped by it. A keyed request with neither a user nor an install id is answered 400, not
 *     silently run: a client that asked for a guarantee and is not getting one should hear so.
 *     The client IP is NOT a scope. It changes when a phone moves from WiFi to LTE mid-retry,
 *     which is exactly the retry this middleware exists to serve, and behind a carrier NAT two
 *     phones share one.
 *   - The Postgres store is unreachable from the global slot. `idempotency_keys` is keyed by
 *     `(user_id, key)` with a foreign key to `users`, so it cannot hold anonymous traffic, and
 *     there is no user here. In the global slot the in-memory store is the only store: per
 *     isolate, lost on eviction, not shared between colos. A development convenience, not a
 *     guarantee, and increment 4 has no route that answers 2xx to a keyed request anyway.
 *
 * `storeFor` and `scopeFor` keep a resolved-user branch. It is never taken in the global slot,
 * in this increment or the next: it is for the second `idempotency()` instance that increment 8
 * (flight routes) mounts under `/v1` BEHIND auth, where plan section 10 puts idempotency last in
 * the chain, the user id is the scope and Postgres is the store. Until then both branches are
 * compiled and type-checked but never executed, and the tests say so rather than pretend.
 */

import { and, eq, sql } from 'drizzle-orm';
import { idempotencyKeys, withDb } from '@planeahead/db';
import type { Context, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { type AppBindings, type Env, environmentName } from '../env';
import { createLogger } from '../observability/log';

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
export const IDEMPOTENCY_REPLAYED_HEADER = 'Idempotency-Replayed';

/**
 * The per-installation id an anonymous caller scopes its keys by. Generated once by the app,
 * kept for the life of the install, and the same value `POST /v1/devices` registers.
 */
export const INSTALL_ID_HEADER = 'X-Install-Id';

/** How long a stored response stays replayable. */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

const MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Bounded and printable: the value is echoed into storage and into log lines. One shape for the
 * key and for the install id, because both end up in the same store key and the same scope
 * string, and `KEY_SEPARATOR` below relies on neither containing a control character.
 */
const VALID_TOKEN = /^[A-Za-z0-9_.:-]{8,255}$/;
const TOKEN_SHAPE = '8 to 255 characters of [A-Za-z0-9_.:-]';

export function isValidIdempotencyKey(value: string): boolean {
  return VALID_TOKEN.test(value);
}

export function isValidInstallId(value: string): boolean {
  return VALID_TOKEN.test(value);
}

export interface StoredResponse {
  readonly status: number;
  readonly body: unknown;
  /** Hex SHA-256 of method, path and body, so the same key on a different request is caught. */
  readonly requestHash: string;
}

export interface IdempotencyStore {
  get(scope: string, key: string): Promise<StoredResponse | null>;
  put(scope: string, key: string, response: StoredResponse): Promise<void>;
}

/**
 * Per-isolate fallback store. Module scope on purpose and bounded on purpose: an unbounded map in
 * a long lived isolate is a memory leak, and the eviction order does not matter because this
 * store is never the source of truth.
 */
const MEMORY_STORE_LIMIT = 500;

/**
 * Separates the scope from the key in the in-memory map, so `("a", "b:c")` and `("a:b", "c")`
 * cannot collide. U+0000 is written as an escape rather than as a literal byte: a raw NUL in a
 * source file makes git classify the blob as binary, which costs the file its diff, its
 * line-level review comments and its three-way merge. `VALID_TOKEN` above guarantees the
 * separator can never appear inside a key or an install id.
 */
const KEY_SEPARATOR = '\u0000';

export function createMemoryIdempotencyStore(limit: number = MEMORY_STORE_LIMIT): IdempotencyStore {
  const entries = new Map<string, StoredResponse>();
  return {
    get(scope, key) {
      return Promise.resolve(entries.get(`${scope}${KEY_SEPARATOR}${key}`) ?? null);
    },
    put(scope, key, response) {
      if (entries.size >= limit) {
        const oldest = entries.keys().next();
        if (oldest.done !== true) {
          entries.delete(oldest.value);
        }
      }
      entries.set(`${scope}${KEY_SEPARATOR}${key}`, response);
      return Promise.resolve();
    },
  };
}

const memoryStore = createMemoryIdempotencyStore();

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Postgres-backed store for a known user. `scope` is the user id and is not read again here.
 *
 * Not reachable from the global chain (see the file header). It exists for the `/v1` mount
 * behind auth in increment 8, and is kept here so that mount is one `idempotency({ store })`
 * call rather than storage code written under time pressure.
 */
export function createDbIdempotencyStore(env: Env, userId: string): IdempotencyStore {
  return {
    async get(_scope, key) {
      return withDb(env, async (db) => {
        const rows = await db
          .select({
            status: idempotencyKeys.responseStatus,
            body: idempotencyKeys.responseBody,
            requestHash: idempotencyKeys.requestHash,
          })
          .from(idempotencyKeys)
          .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)))
          .limit(1);
        const row = rows[0];
        if (row === undefined) {
          return null;
        }
        return {
          status: row.status,
          body: row.body,
          requestHash: bytesToHex(row.requestHash),
        };
      });
    },
    async put(_scope, key, response) {
      await withDb(env, async (db) => {
        await db
          .insert(idempotencyKeys)
          .values({
            userId,
            key,
            requestHash: hexToBytes(response.requestHash),
            responseStatus: response.status,
            responseBody: response.body,
            expiresAt: sql`now() + interval '${sql.raw(String(IDEMPOTENCY_TTL_SECONDS))} seconds'`,
          })
          .onConflictDoNothing();
      });
    },
  };
}

function hasHyperdriveBinding(env: Env): boolean {
  const binding: unknown = env.DB;
  return (
    typeof binding === 'object' &&
    binding !== null &&
    typeof (binding as { connectionString?: unknown }).connectionString === 'string'
  );
}

/**
 * Picks the store for this request.
 *
 * In the global chain this always returns the memory store. The database branch needs a resolved
 * user, and ruling E6 puts this middleware ahead of auth, so `c.var.user` is unset there: hence
 * the `?? null`, without which `undefined !== null` read `user.id` off `undefined` and answered
 * 500 to the first keyed request. The branch is live only where the factory is mounted behind
 * auth, which increment 8 does for `/v1`. The `test` and Hyperdrive guards are what keep the
 * Workers suite from dialling Postgres if that mount is ever tested here.
 */
export function storeFor(c: Context<AppBindings>): IdempotencyStore {
  const user = c.var.user ?? null;
  if (user !== null && environmentName(c.env) !== 'test' && hasHyperdriveBinding(c.env)) {
    return createDbIdempotencyStore(c.env, user.id);
  }
  return memoryStore;
}

/**
 * The bucket a key is stored under, or null when the request cannot be scoped.
 *
 * A resolved user is scoped by id (only when mounted behind auth, never in the global slot; see
 * the file header). An unauthenticated caller is scoped by `X-Install-Id`, a value the CLIENT
 * owns and keeps across a network change: two installs that send the same key stay apart, and
 * one install that retries from a new IP replays. Neither property held for the client IP, which
 * an earlier version used, and a phone that moved from WiFi to LTE mid-retry created its resource
 * twice.
 *
 * `null` means the guarantee cannot be given. The middleware answers 400 rather than running the
 * handler as if no key had been sent.
 */
export function scopeFor(c: Context<AppBindings>): string | null {
  const user = c.var.user ?? null;
  if (user !== null) {
    return `user:${user.id}`;
  }
  const installId = c.req.header(INSTALL_ID_HEADER);
  if (installId === undefined || !isValidInstallId(installId)) {
    return null;
  }
  return `install:${installId}`;
}

async function hashRequest(c: Context<AppBindings>): Promise<string> {
  // Reading the body caches it on the Hono request, so route handlers can still call
  // `c.req.json()` afterwards.
  const body = await c.req.arrayBuffer();
  const header = new TextEncoder().encode(`${c.req.method} ${new URL(c.req.url).pathname}\n`);
  const payload = new Uint8Array(header.length + body.byteLength);
  payload.set(header, 0);
  payload.set(new Uint8Array(body), header.length);
  const digest = await crypto.subtle.digest('SHA-256', payload);
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Whether a response is worth replaying. A 5xx or a 429 is a transient failure the client should
 * be allowed to retry for real, so those are not stored.
 */
export function isStorableResponse(response: Response): boolean {
  if (response.status >= 500 || response.status === 429) {
    return false;
  }
  return (response.headers.get('Content-Type') ?? '').includes('application/json');
}

export interface IdempotencyOptions {
  /** Test seam. Defaults to `storeFor`. */
  readonly store?: (c: Context<AppBindings>) => IdempotencyStore;
}

export function idempotency(options: IdempotencyOptions = {}): MiddlewareHandler<AppBindings> {
  const selectStore = options.store ?? storeFor;
  return createMiddleware<AppBindings>(async (c, next) => {
    if (!MUTATING_METHODS.has(c.req.method)) {
      return next();
    }
    const key = c.req.header(IDEMPOTENCY_KEY_HEADER);
    if (key === undefined) {
      return next();
    }
    if (!isValidIdempotencyKey(key)) {
      return c.json(
        {
          error: 'invalid_idempotency_key',
          message: `${IDEMPOTENCY_KEY_HEADER} must be ${TOKEN_SHAPE}`,
          requestId: c.var.requestId,
        },
        400,
      );
    }

    const log = createLogger({ request_id: c.var.requestId });
    const store = selectStore(c);
    const scope = scopeFor(c);
    if (scope === null) {
      log.info('idempotency_scope_missing');
      return c.json(
        {
          error: 'idempotency_scope_missing',
          message: `an unauthenticated request with ${IDEMPOTENCY_KEY_HEADER} must also send ${INSTALL_ID_HEADER} (${TOKEN_SHAPE})`,
          requestId: c.var.requestId,
        },
        400,
      );
    }
    const requestHash = await hashRequest(c);

    const existing = await store.get(scope, key);
    if (existing !== null) {
      if (existing.requestHash !== requestHash) {
        log.info('idempotency_key_reuse', { key_length: key.length });
        return c.json(
          {
            error: 'idempotency_key_reuse',
            message: 'this Idempotency-Key was used for a different request',
            requestId: c.var.requestId,
          },
          422,
        );
      }
      log.info('idempotency_replay', { status: existing.status });
      c.header(IDEMPOTENCY_REPLAYED_HEADER, 'true');
      return c.json(existing.body, existing.status as ContentfulStatusCode);
    }

    await next();

    const response = c.res;
    if (!isStorableResponse(response)) {
      return;
    }
    try {
      const body: unknown = await response.clone().json();
      await store.put(scope, key, { status: response.status, body, requestHash });
    } catch (error) {
      // Never fail a request that already succeeded because the replay record could not be
      // written. The client's retry will simply run the handler again.
      log.warn('idempotency_store_failed', {
        error_message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
