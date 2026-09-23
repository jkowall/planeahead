/**
 * Idempotency keys.
 *
 * A client that retries `POST /v1/flights` after a timeout must not create a second subscription,
 * and the mobile outbox retries aggressively by design. The contract is the IETF one
 * (draft-ietf-httpapi-idempotency-key-header, increment 8 ruling K1): the caller sends
 * `Idempotency-Key`; the first request reserves the key and its response is stored; a retry of
 * the same request replays it with `Idempotent-Replayed: true`; a retry that arrives while the
 * first is still running answers 409 `in_flight`; the same key on a DIFFERENT request answers 422
 * `idempotency_payload_mismatch`. Terminal 4xx answers are stored too (the outbox replays
 * blindly, and a 403 `cap_exceeded` must not turn into a 201 on the retry); 5xx and 429 are not,
 * so a retry after a failure really runs again.
 *
 * There are two instances of this middleware and they own disjoint paths:
 *
 *   - The GLOBAL slot (`src/app.ts`, ruling E6) runs ahead of the auth middleware, so no user is
 *     ever resolved there. It covers the non-`/v1` surface only, scopes keys by `X-Install-Id`,
 *     hashes the raw body and stores in the per-isolate memory store. `/v1` and the Better Auth
 *     mount are skipped: the first has its own instance, the second its own replay semantics.
 *   - The `/v1` instance (`src/routes/v1.ts`, mounted behind auth and behind the per-principal
 *     burst limiter, so a 429 never consumes a key) scopes a key by the resolved user id, else by
 *     `X-Install-Id`, and stores a user's keys in Postgres (`idempotency_keys`). It does NOT
 *     reserve on its own: the request hash covers the VALIDATED body (method, canonical path,
 *     key-sorted canonical JSON), so the reservation is made by `idempotencyGate()`, which a route
 *     places after its validator. The instance then finalises what the gate reserved: stores the
 *     response, or releases the key. A request it cannot scope passes through with nothing set
 *     (ruling O10): the route's `requireScope` answers 401 (or 401 `account_deleted`) to a caller
 *     with no session, and only a request that got past auth without a scope reaches the gate,
 *     which answers 400 `idempotency_scope_missing`.
 *
 * Both instances answer a replay with `Idempotent-Replayed: true` and a mismatch with 422
 * `idempotency_payload_mismatch` (the global slot adopted the `/v1` semantics in increment 8). A
 * `/v1` route opts in by placing the gate: required on `POST /v1/flights`, optional (a key is
 * honoured when sent) on `POST /v1/devices`, `PATCH /v1/me/preferences` and
 * `DELETE /v1/flights/:id`; `POST /v1/flights/:id/refresh` has no gate and takes no key.
 *
 * The Postgres store reserves with `INSERT ... ON CONFLICT DO NOTHING RETURNING`: a returned row
 * means this caller executes; no row means read the existing one and answer replay, 409 or 422.
 * A reservation is a row whose `response_status` is `IN_FLIGHT_STATUS` (0, no HTTP status) written
 * with a short lease (`IN_FLIGHT_LEASE_SECONDS`, 60 s) as its expiry, so a
 * request that died mid-flight does not block its key for a day; completing it moves the expiry
 * to the 24 h TTL. An expired row (a dead lease, or a response older than the TTL that the
 * housekeeping purge has not reached yet) is taken over by one atomic UPDATE.
 */

import { and, eq, lte, sql } from 'drizzle-orm';
import { idempotencyKeys } from '@planeahead/db';
import { IDEMPOTENCY_TTL_SECONDS as SHARED_IDEMPOTENCY_TTL_SECONDS } from '@planeahead/shared';
import type { Context, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { AUTH_PATH_PREFIX } from '../auth/paths';
import { authRuntime } from '../auth/runtime';
import { sha256Hex } from '../crypto/hash';
import type { AppBindings } from '../env';
import { createLogger } from '../observability/log';

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
/** Stripe's and the IETF draft's replay marker. */
export const IDEMPOTENCY_REPLAYED_HEADER = 'Idempotent-Replayed';

/**
 * The per-installation id an anonymous caller scopes its keys by. Generated once by the app,
 * kept for the life of the install, and the same value `POST /v1/devices` registers.
 */
export const INSTALL_ID_HEADER = 'X-Install-Id';

/** How long a stored response stays replayable (shared constant, ruling K3). */
export const IDEMPOTENCY_TTL_SECONDS = SHARED_IDEMPOTENCY_TTL_SECONDS;

/**
 * How long a reservation without a response holds its key. Longer than any `/v1` handler runs
 * (each Durable Object call is bounded by an 8 s deadline), short enough that a request which
 * died mid-flight frees its key for the outbox's next retry.
 */
export const IN_FLIGHT_LEASE_SECONDS = 60;

const V1_PATH_PREFIX = '/v1/';
const WEBHOOKS_PATH_PREFIX = '/v1/webhooks/';

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
}

/** What a reservation attempt found. */
export type ReserveOutcome =
  | { readonly kind: 'reserved' }
  | { readonly kind: 'replay'; readonly response: StoredResponse }
  | { readonly kind: 'in_flight' }
  | { readonly kind: 'mismatch' };

export interface IdempotencyStore {
  /** Reserves `(scope, key)` for a request with `requestHash`, or reports what holds it. */
  reserve(scope: string, key: string, requestHash: string): Promise<ReserveOutcome>;
  /** Stores the response of a request this caller reserved. */
  complete(scope: string, key: string, response: StoredResponse): Promise<void>;
  /** Frees a reservation whose response is not worth storing (a 5xx or a 429). */
  release(scope: string, key: string): Promise<void>;
}

/**
 * Per-isolate store: the global slot's only store, and the `/v1` store for a caller scoped by
 * install id (the Postgres table is keyed by user). Module scope on purpose and bounded on
 * purpose: an unbounded map in a long lived isolate is a memory leak, and the eviction order
 * does not matter because this store is never the source of truth.
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

interface MemoryEntry {
  readonly requestHash: string;
  readonly response: StoredResponse | null;
  readonly expiresAtMs: number;
}

export function createMemoryIdempotencyStore(
  limit: number = MEMORY_STORE_LIMIT,
  now: () => number = Date.now,
): IdempotencyStore {
  const entries = new Map<string, MemoryEntry>();
  const slot = (scope: string, key: string) => `${scope}${KEY_SEPARATOR}${key}`;
  return {
    reserve(scope, key, requestHash) {
      const id = slot(scope, key);
      const existing = entries.get(id);
      if (existing !== undefined && existing.expiresAtMs > now()) {
        if (existing.requestHash !== requestHash) {
          return Promise.resolve({ kind: 'mismatch' });
        }
        return Promise.resolve(
          existing.response === null
            ? { kind: 'in_flight' }
            : { kind: 'replay', response: existing.response },
        );
      }
      if (existing === undefined && entries.size >= limit) {
        const oldest = entries.keys().next();
        if (oldest.done !== true) {
          entries.delete(oldest.value);
        }
      }
      entries.set(id, {
        requestHash,
        response: null,
        expiresAtMs: now() + IN_FLIGHT_LEASE_SECONDS * 1000,
      });
      return Promise.resolve({ kind: 'reserved' });
    },
    complete(scope, key, response) {
      const id = slot(scope, key);
      const existing = entries.get(id);
      if (existing !== undefined) {
        entries.set(id, {
          requestHash: existing.requestHash,
          response,
          expiresAtMs: now() + IDEMPOTENCY_TTL_SECONDS * 1000,
        });
      }
      return Promise.resolve();
    },
    release(scope, key) {
      const id = slot(scope, key);
      if (entries.get(id)?.response === null) {
        entries.delete(id);
      }
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
 * `idempotency_keys.response_status` of a reservation that has no response yet. The column is
 * NOT NULL (increment 3) and no HTTP status is 0, so the sentinel cannot collide with a stored
 * answer.
 */
export const IN_FLIGHT_STATUS = 0;

type DbHandle = ReturnType<typeof authRuntime>['db'];

/**
 * Postgres-backed store for a resolved user; `scope` is `user:{id}` and the row is keyed by the
 * user id. The handle is the request's own (the auth runtime's), so a keyed request opens no
 * second client.
 */
export function createDbIdempotencyStore(db: DbHandle, userId: string): IdempotencyStore {
  const where = (key: string) =>
    and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key));
  const leaseExpiry = sql`now() + make_interval(secs => ${IN_FLIGHT_LEASE_SECONDS})`;
  const ttlExpiry = sql`now() + make_interval(secs => ${IDEMPOTENCY_TTL_SECONDS})`;
  return {
    async reserve(_scope, key, requestHash) {
      const hash = hexToBytes(requestHash);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const inserted = await db
          .insert(idempotencyKeys)
          .values({
            userId,
            key,
            requestHash: hash,
            responseStatus: IN_FLIGHT_STATUS,
            responseBody: sql`'null'::jsonb`,
            expiresAt: leaseExpiry,
          })
          .onConflictDoNothing()
          .returning({ key: idempotencyKeys.key });
        if (inserted.length > 0) {
          return { kind: 'reserved' };
        }
        // A dead lease or a response past its TTL: taken over by exactly one caller, because a
        // second concurrent UPDATE re-evaluates the WHERE against the row the first committed.
        const takenOver = await db
          .update(idempotencyKeys)
          .set({
            requestHash: hash,
            responseStatus: IN_FLIGHT_STATUS,
            responseBody: sql`'null'::jsonb`,
            expiresAt: leaseExpiry,
          })
          .where(and(where(key), lte(idempotencyKeys.expiresAt, sql`now()`)))
          .returning({ key: idempotencyKeys.key });
        if (takenOver.length > 0) {
          return { kind: 'reserved' };
        }
        const [row] = await db
          .select({
            status: idempotencyKeys.responseStatus,
            body: idempotencyKeys.responseBody,
            requestHash: idempotencyKeys.requestHash,
          })
          .from(idempotencyKeys)
          .where(where(key))
          .limit(1);
        if (row === undefined) {
          // Released between our insert and our read: try again.
          continue;
        }
        if (bytesToHex(row.requestHash) !== requestHash) {
          return { kind: 'mismatch' };
        }
        if (row.status === IN_FLIGHT_STATUS) {
          return { kind: 'in_flight' };
        }
        return { kind: 'replay', response: { status: row.status, body: row.body } };
      }
      return { kind: 'in_flight' };
    },
    async complete(_scope, key, response) {
      await db
        .update(idempotencyKeys)
        .set({ responseStatus: response.status, responseBody: response.body, expiresAt: ttlExpiry })
        .where(and(where(key), eq(idempotencyKeys.responseStatus, IN_FLIGHT_STATUS)));
    },
    async release(_scope, key) {
      await db
        .delete(idempotencyKeys)
        .where(and(where(key), eq(idempotencyKeys.responseStatus, IN_FLIGHT_STATUS)));
    },
  };
}

/**
 * The store for this request. A resolved user's keys live in Postgres; a caller scoped by install
 * id (no session) uses the memory store, since `idempotency_keys` is keyed by user. In the global
 * slot no user is ever resolved, so it always answers the memory store.
 */
export function storeFor(c: Context<AppBindings>): IdempotencyStore {
  const user = c.var.user ?? null;
  if (user !== null) {
    return createDbIdempotencyStore(authRuntime(c).db, user.id);
  }
  return memoryStore;
}

/**
 * The bucket a key is stored under, or null when the request cannot be scoped.
 *
 * A resolved user is scoped by id (only in the `/v1` instance, behind auth). An unauthenticated
 * caller is scoped by `X-Install-Id`, a value the CLIENT owns and keeps across a network change:
 * two installs that send the same key stay apart, and one install that retries from a new IP
 * replays. Neither property held for the client IP, which an earlier version used.
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

/** `/v1//flights/` and `/v1/flights` hash alike. */
export function canonicalPath(url: string): string {
  const collapsed = new URL(url).pathname.replace(/\/{2,}/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/$/, '') : collapsed;
}

/** JSON with every object's keys sorted, recursively; `undefined` members are dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([name, member]) => `${JSON.stringify(name)}:${canonicalJson(member)}`).join(',')}}`;
}

/** SHA-256 over method, canonical path and the canonical JSON of the (validated) body. */
export function hashValidatedRequest(method: string, url: string, body: unknown): Promise<string> {
  return sha256Hex(`${method.toUpperCase()}\n${canonicalPath(url)}\n${canonicalJson(body)}`);
}

/** The global slot's hash: the raw body bytes, since nothing has validated them there. */
async function hashRawRequest(c: Context<AppBindings>): Promise<string> {
  // Reading the body caches it on the Hono request, so route handlers can still call
  // `c.req.json()` afterwards.
  const body = await c.req.arrayBuffer();
  const header = new TextEncoder().encode(`${c.req.method} ${canonicalPath(c.req.url)}\n`);
  const payload = new Uint8Array(header.length + body.byteLength);
  payload.set(header, 0);
  payload.set(new Uint8Array(body), header.length);
  const digest = await crypto.subtle.digest('SHA-256', payload);
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Whether a response is worth replaying. A 5xx or a 429 is a transient failure the client should
 * be allowed to retry for real, so those are not stored; every other JSON answer, 4xx included,
 * is terminal and is.
 */
export function isStorableResponse(response: Response): boolean {
  if (response.status >= 500 || response.status === 429) {
    return false;
  }
  return (response.headers.get('Content-Type') ?? '').includes('application/json');
}

/** What the `/v1` instance hands its route gate. */
export interface IdempotencyContext {
  readonly key: string;
  readonly scope: string;
  readonly store: IdempotencyStore;
  /** Set by the gate once this request holds the reservation. */
  reserved: boolean;
}

export interface IdempotencyOptions {
  /** Test seam. Defaults to `storeFor`. */
  readonly store?: (c: Context<AppBindings>) => IdempotencyStore;
  /**
   * `global` (default): the pre-auth slot, raw-body hash, every non-`/v1` path. `v1`: the
   * instance under `/v1`, which resolves scope and store and leaves the reservation to
   * `idempotencyGate()` after the route's validator.
   */
  readonly mode?: 'global' | 'v1';
}

function invalidKey(c: Context<AppBindings>): Response {
  return c.json(
    {
      error: 'invalid_idempotency_key',
      message: `${IDEMPOTENCY_KEY_HEADER} must be ${TOKEN_SHAPE}`,
      requestId: c.var.requestId,
    },
    400,
  );
}

function scopeMissing(c: Context<AppBindings>): Response {
  createLogger({ request_id: c.var.requestId }).info('idempotency_scope_missing');
  return c.json(
    {
      error: 'idempotency_scope_missing',
      message: `an unauthenticated request with ${IDEMPOTENCY_KEY_HEADER} must also send ${INSTALL_ID_HEADER} (${TOKEN_SHAPE})`,
      requestId: c.var.requestId,
    },
    400,
  );
}

/** Answers a reservation that this request does not own: replay, 409 or 422. */
function answerHeld(c: Context<AppBindings>, outcome: ReserveOutcome): Response | null {
  const log = createLogger({ request_id: c.var.requestId });
  switch (outcome.kind) {
    case 'reserved':
      return null;
    case 'replay':
      log.info('idempotency_replay', { status: outcome.response.status });
      c.header(IDEMPOTENCY_REPLAYED_HEADER, 'true');
      return c.json(outcome.response.body, outcome.response.status as ContentfulStatusCode);
    case 'in_flight':
      log.info('idempotency_in_flight');
      return c.json(
        {
          error: 'in_flight',
          message: 'a request with this Idempotency-Key is still being processed; retry later',
          requestId: c.var.requestId,
        },
        409,
      );
    case 'mismatch':
      log.info('idempotency_payload_mismatch');
      return c.json(
        {
          error: 'idempotency_payload_mismatch',
          message: 'this Idempotency-Key was used for a different request',
          requestId: c.var.requestId,
        },
        422,
      );
  }
}

/** Stores the response of a reserved request, or frees the key; never fails the request. */
async function finalise(
  c: Context<AppBindings>,
  store: IdempotencyStore,
  scope: string,
  key: string,
): Promise<void> {
  const response = c.res;
  try {
    if (!isStorableResponse(response)) {
      await store.release(scope, key);
      return;
    }
    const body: unknown = await response.clone().json();
    await store.complete(scope, key, { status: response.status, body });
  } catch (error) {
    // Never fail a request that already ran because the replay record could not be written. The
    // lease expires and the client's retry runs the handler again.
    createLogger({ request_id: c.var.requestId }).warn('idempotency_store_failed', {
      error_message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function idempotency(options: IdempotencyOptions = {}): MiddlewareHandler<AppBindings> {
  const selectStore = options.store ?? storeFor;
  const mode = options.mode ?? 'global';
  return createMiddleware<AppBindings>(async (c, next) => {
    if (!MUTATING_METHODS.has(c.req.method)) {
      return next();
    }
    const path = new URL(c.req.url).pathname;
    // Better Auth's mount is left alone. Its endpoints have their own replay semantics (a
    // single-use token, a session cookie), a stored 200 replayed for `/sign-in/magic-link`
    // would answer ahead of the per-address cap and never count, and reading the body here
    // would consume it ahead of the handler that has to parse it. The provider webhook
    // receivers authenticate by path token and are not the outbox's to retry.
    if (path.startsWith(AUTH_PATH_PREFIX) || path.startsWith(WEBHOOKS_PATH_PREFIX)) {
      return next();
    }
    // The global slot leaves `/v1` to the instance mounted there.
    if (mode === 'global' && (path.startsWith(V1_PATH_PREFIX) || path === '/v1')) {
      return next();
    }
    const key = c.req.header(IDEMPOTENCY_KEY_HEADER);
    if (key === undefined) {
      return next();
    }
    if (!isValidIdempotencyKey(key)) {
      return invalidKey(c);
    }
    // The store is chosen before the scope is checked so a test seam sees every keyed request.
    const store = selectStore(c);
    const scope = scopeFor(c);
    if (scope === null) {
      // Under `/v1` the route decides: `requireScope` answers a caller without a session 401
      // before anything could be reserved, and `idempotencyGate` answers the rest.
      return mode === 'v1' ? next() : scopeMissing(c);
    }

    if (mode === 'v1') {
      const context: IdempotencyContext = { key, scope, store, reserved: false };
      c.set('idempotency', context);
      await next();
      if (context.reserved) {
        await finalise(c, store, scope, key);
      }
      return;
    }

    const held = answerHeld(c, await store.reserve(scope, key, await hashRawRequest(c)));
    if (held !== null) {
      return held;
    }
    await next();
    await finalise(c, store, scope, key);
  });
}

export interface IdempotencyGateOptions {
  /** Answer 400 `idempotency_key_required` to a request without the header. */
  readonly required: boolean;
}

/** Reads what a validator stored on the request, whatever the route's input type says. */
function validated(c: Context<AppBindings>, target: 'json'): unknown {
  return (c.req as unknown as { valid(t: string): unknown }).valid(target);
}

/**
 * The reservation, placed AFTER the route's validator so the hash covers the validated body.
 * Needs the `/v1` instance ahead of it (which resolved the scope and the store).
 */
export function idempotencyGate(options: IdempotencyGateOptions): MiddlewareHandler<AppBindings> {
  return createMiddleware<AppBindings>(async (c, next) => {
    const context = c.var.idempotency;
    if (context === undefined) {
      if (c.req.header(IDEMPOTENCY_KEY_HEADER) !== undefined) {
        // A key the `/v1` instance could not scope (no session, no valid install id).
        return scopeMissing(c);
      }
      if (options.required) {
        return c.json(
          {
            error: 'idempotency_key_required',
            message: `this route needs an ${IDEMPOTENCY_KEY_HEADER} header (${TOKEN_SHAPE})`,
            requestId: c.var.requestId,
          },
          400,
        );
      }
      return next();
    }
    const hash = await hashValidatedRequest(c.req.method, c.req.url, validated(c, 'json') ?? null);
    const held = answerHeld(c, await context.store.reserve(context.scope, context.key, hash));
    if (held !== null) {
      return held;
    }
    context.reserved = true;
    await next();
  });
}
