/**
 * The write side of the offline store: mutations queued locally and drained, oldest first, to
 * the API with an `Idempotency-Key` (and, through the API client, `X-Install-Id`).
 *
 * "Oldest" is insertion order, the `seq` column (one more than the largest queued `seq`), never
 * the uuidv7 id: its monotonic counter lives in process memory, so a clock stepped backwards
 * between two launches (an NTP correction, a manual time change while travelling) would sort a
 * later mutation before an earlier one (increment 9 review, auth-and-store-7).
 *
 * Replay semantics are the API's (increment 8, IETF idempotency draft): the same key and body
 * answer the stored response with `Idempotent-Replayed: true`, which is success; the same key
 * with a different body answers 422 `idempotency_payload_mismatch`, a client bug, so the item gets
 * a FRESH key and is sent again at once (reported without its body); 409 `in_flight` means
 * the first attempt is still running and is retried later. Terminal 4xx answers are persisted by
 * the API too, so a replay of a refused request is refused again: any other 4xx is surfaced to
 * `onDropped` and the item is removed. 401 `account_deleted` wipes the store and the outbox.
 *
 * FIFO is strict: a retryable failure stops the drain, so a later mutation never overtakes an
 * earlier one it may depend on (a subscribe and its unsubscribe). The drain waits for the apply
 * gate before every item: it is suspended while a sync pull applies pages, and while a magic
 * link is verified and its account checked (src/lib/magic-link.ts).
 *
 * Every drain write signals `outbox` after it commits (src/lib/db/store-signal.ts). A caller that
 * queues a mutation runs `enqueueMutation` inside `commitWrite(db, ['outbox', ...], fn)` with its
 * optimistic row, so both commit and signal together, and names that row's id as `entityId`: a
 * snapshot that replaces the synced rows keeps every subscription a queued `POST /v1/flights`
 * names, because the server has not seen it yet (src/lib/sync/store.ts; increment 9 re-review,
 * auth-and-store-4).
 *
 * Settling hooks (increment 10, ruling T2). An item the server answered for good leaves the queue
 * in ONE immediate transaction together with what its writer needs done to the local rows:
 * `onSent(item, response)` for a 2xx (the add-flight writer replaces its optimistic row with the
 * server's, whose id differs when the account already held the flight) and
 * `onRefused(item, response)` for a terminal 4xx (the writer removes its optimistic row). Each
 * hook runs synchronously inside that transaction, never opens its own, and returns the tables
 * it wrote so the one signal after the COMMIT names them. A hook that throws rolls its writes
 * back; the item is then removed on its own (the server's answer stands, the next pull
 * reconciles the rows) and `onHookError` reports it, so a broken hook can never wedge the queue.
 * `onDropped` still fires after a refusal commits, for the user-facing message and the report.
 */

import { uuidv7 } from '@planeahead/shared';
import { errorCode, type RawRequest, type RawResponse } from '../api-client';
import type { SqliteLike, SqlValue } from '../db/sqlite-like';
import { notifyTablesChanged, type StoreTable } from '../db/store-signal';
import type { ApplyGate } from './gate';
import { wipeLocalStore } from './store';

export interface OutboxItem {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly idempotencyKey: string;
  readonly attempts: number;
  /** The id of the row the mutation creates or changes, or null (see the header). */
  readonly entityId: string | null;
}

interface OutboxDbRow {
  id: string;
  method: string;
  path: string;
  body: string | null;
  idempotency_key: string;
  attempts: number;
  next_attempt_at: number;
  entity_id: string | null;
}

export interface OutboxTransport {
  send(request: RawRequest): Promise<RawResponse>;
}

export interface DroppedMutation {
  readonly item: OutboxItem;
  readonly status: number;
  readonly code: string | null;
  /**
   * The refusal's body (the error envelope: `cap` and `limit`, `triedDates`), for the message the
   * user sees. Never sent to Sentry: a report names the method, path, status and code only.
   */
  readonly body: unknown;
}

/**
 * A settling hook: runs inside the transaction that removes the item and returns the tables it
 * wrote (or nothing). Synchronous; must not open a transaction of its own.
 */
export type SettleHook = (item: OutboxItem, response: RawResponse) => readonly StoreTable[] | void;

export interface OutboxDeps {
  readonly db: SqliteLike;
  readonly transport: OutboxTransport;
  readonly gate: ApplyGate;
  readonly onAccountDeleted: () => Promise<void> | void;
  /** A terminal refusal: shown to the user and reported, never retried. */
  readonly onDropped?: (dropped: DroppedMutation) => void;
  /** A 422 key/body mismatch: reported without the body; the item is re-keyed. */
  readonly onKeyRegenerated?: (item: OutboxItem) => void;
  /** A 2xx: runs in the transaction that removes the item (see the header). */
  readonly onSent?: SettleHook;
  /** A terminal refusal: runs in the transaction that removes the item (see the header). */
  readonly onRefused?: SettleHook;
  /** A settling hook threw; its writes rolled back and the item was removed without it. */
  readonly onHookError?: (item: OutboxItem, error: unknown) => void;
  readonly now?: () => number;
  readonly newKey?: () => string;
}

export type DrainResult =
  | { readonly kind: 'drained'; readonly sent: number; readonly dropped: number }
  | { readonly kind: 'deferred'; readonly sent: number; readonly dropped: number }
  | { readonly kind: 'account_deleted' }
  | { readonly kind: 'unauthenticated' };

export interface NewMutation {
  readonly method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly path: string;
  readonly body?: unknown;
  /**
   * The id of the local row this mutation creates or changes (a subscribe's client-minted
   * `subscriptionId`). A queued subscribe's row survives a snapshot replace by this id.
   */
  readonly entityId?: string;
}

const MAX_BACKOFF_MS = 5 * 60_000;

/** 1 s, 2 s, 4 s ... capped at five minutes. */
export function backoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempts, 16));
}

/**
 * Queues a mutation at the tail. The caller writes its optimistic local row in the same
 * transaction (`commitWrite`), which also signals the tables after the commit.
 */
export function enqueueMutation(
  db: SqliteLike,
  mutation: NewMutation,
  options: { readonly id?: string; readonly key?: string; readonly now?: Date } = {},
): OutboxItem {
  const item: OutboxItem = {
    id: options.id ?? uuidv7(),
    method: mutation.method,
    path: mutation.path,
    body: mutation.body,
    idempotencyKey: options.key ?? uuidv7(),
    attempts: 0,
    entityId: mutation.entityId ?? null,
  };
  const params: SqlValue[] = [
    item.id,
    item.method,
    item.path,
    mutation.body === undefined ? null : JSON.stringify(mutation.body),
    item.idempotencyKey,
    (options.now ?? new Date()).toISOString(),
    item.entityId,
  ];
  db.run(
    'INSERT INTO outbox (id, method, path, body, idempotency_key, attempts, next_attempt_at, created_at, entity_id, seq) ' +
      'VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, (SELECT coalesce(max(seq), 0) + 1 FROM outbox))',
    params,
  );
  return item;
}

function toItem(row: OutboxDbRow): OutboxItem {
  return {
    id: row.id,
    method: row.method,
    path: row.path,
    body: row.body === null ? undefined : (JSON.parse(row.body) as unknown),
    idempotencyKey: row.idempotency_key,
    attempts: row.attempts,
    entityId: row.entity_id,
  };
}

/**
 * The head of the queue, due or not: an item still in its backoff blocks everything queued
 * behind it, so a later mutation can never overtake an earlier one. Rows queued before `seq`
 * existed all hold 0 and go first, in rowid (insertion) order.
 */
function oldest(
  db: SqliteLike,
): { readonly item: OutboxItem; readonly nextAttemptAt: number } | null {
  const row = db.get<OutboxDbRow>(
    'SELECT id, method, path, body, idempotency_key, attempts, next_attempt_at, entity_id ' +
      'FROM outbox ORDER BY seq, rowid LIMIT 1',
  );
  return row === null ? null : { item: toItem(row), nextAttemptAt: row.next_attempt_at };
}

export function pendingCount(db: SqliteLike): number {
  return db.get<{ n: number }>('SELECT count(*) AS n FROM outbox WHERE id IS NOT NULL')?.n ?? 0;
}

/**
 * Removes a settled item and runs its hook in the same immediate transaction, then signals the
 * outbox and whatever the hook wrote, once. A throwing hook rolls back; the item goes on its own.
 */
function settle(
  deps: OutboxDeps,
  item: OutboxItem,
  response: RawResponse,
  hook: SettleHook | undefined,
): void {
  let tables: readonly StoreTable[] = [];
  try {
    tables = deps.db.transaction(
      (): readonly StoreTable[] => {
        deps.db.run('DELETE FROM outbox WHERE id = ?', [item.id]);
        return hook?.(item, response) ?? [];
      },
      { behavior: 'immediate' },
    );
  } catch (error) {
    deps.onHookError?.(item, error);
    deps.db.run('DELETE FROM outbox WHERE id = ?', [item.id]);
    tables = [];
  }
  notifyTablesChanged(['outbox', ...tables]);
}

function defer(
  db: SqliteLike,
  item: OutboxItem,
  now: number,
  status: number | null,
  error: string,
): void {
  db.run(
    'UPDATE outbox SET attempts = attempts + 1, next_attempt_at = ?, last_status = ?, last_error = ? ' +
      'WHERE id = ?',
    [now + backoffMs(item.attempts), status, error, item.id],
  );
  notifyTablesChanged(['outbox']);
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

/** One pass, oldest first, until the queue is empty or its head must wait. Calls share a pass. */
export function createOutbox(deps: OutboxDeps): { drain(): Promise<DrainResult> } {
  let inFlight: Promise<DrainResult> | null = null;
  const now = deps.now ?? Date.now;
  const newKey = deps.newKey ?? uuidv7;

  const pass = async (): Promise<DrainResult> => {
    let sent = 0;
    let dropped = 0;
    const rekeyed = new Set<string>();
    // Every path that goes round again has removed the head, except the 422 re-key, which sends
    // the same head once more (and only once: `rekeyed`).
    for (;;) {
      await deps.gate.idle();
      const head = oldest(deps.db);
      if (head === null) {
        return { kind: 'drained', sent, dropped };
      }
      if (head.nextAttemptAt > now()) {
        return { kind: 'deferred', sent, dropped };
      }
      const { item } = head;

      let response: RawResponse;
      try {
        response = await deps.transport.send({
          method: item.method,
          path: item.path,
          body: item.body,
          idempotencyKey: item.idempotencyKey,
        });
      } catch (error) {
        // Offline or the request died: keep the item and its key, try again later.
        defer(deps.db, item, now(), null, error instanceof Error ? error.name : 'network_error');
        return { kind: 'deferred', sent, dropped };
      }

      const code = errorCode(response.body);
      if (response.status === 422 && code === 'idempotency_payload_mismatch') {
        if (rekeyed.has(item.id)) {
          // A fresh key cannot mismatch; if it did, stop rather than loop.
          defer(deps.db, item, now(), 422, 'idempotency_payload_mismatch');
          return { kind: 'deferred', sent, dropped };
        }
        rekeyed.add(item.id);
        const fresh = newKey();
        deps.db.run(
          'UPDATE outbox SET idempotency_key = ?, attempts = attempts + 1, last_status = 422, ' +
            "last_error = 'idempotency_payload_mismatch' WHERE id = ?",
          [fresh, item.id],
        );
        notifyTablesChanged(['outbox']);
        deps.onKeyRegenerated?.({ ...item, idempotencyKey: fresh });
        // The same item goes again, now, with the fresh key, so nothing queued behind it
        // overtakes it.
        continue;
      }
      if (response.status >= 200 && response.status < 300) {
        settle(deps, item, response, deps.onSent);
        sent += 1;
        continue;
      }
      if (response.status === 401) {
        if (code === 'account_deleted') {
          wipeLocalStore(deps.db);
          await deps.onAccountDeleted();
          return { kind: 'account_deleted' };
        }
        return { kind: 'unauthenticated' };
      }
      if (isRetryable(response.status)) {
        defer(deps.db, item, now(), response.status, code ?? `http_${String(response.status)}`);
        return { kind: 'deferred', sent, dropped };
      }
      settle(deps, item, response, deps.onRefused);
      dropped += 1;
      deps.onDropped?.({ item, status: response.status, code, body: response.body });
    }
  };

  return {
    drain() {
      inFlight ??= pass().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}
