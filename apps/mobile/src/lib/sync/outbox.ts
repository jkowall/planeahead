/**
 * The write side of the offline store: mutations queued locally and drained, oldest first, to
 * the API with an `Idempotency-Key` (and, through the API client, `X-Install-Id`).
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
 * gate before every item: it is suspended while a sync pull applies pages.
 */

import { uuidv7 } from '@planeahead/shared';
import { errorCode, type RawRequest, type RawResponse } from '../api-client';
import type { SqliteLike, SqlValue } from '../db/sqlite-like';
import type { ApplyGate } from './gate';
import { wipeLocalStore } from './store';

export interface OutboxItem {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly idempotencyKey: string;
  readonly attempts: number;
}

interface OutboxDbRow {
  id: string;
  method: string;
  path: string;
  body: string | null;
  idempotency_key: string;
  attempts: number;
  next_attempt_at: number;
}

export interface OutboxTransport {
  send(request: RawRequest): Promise<RawResponse>;
}

export interface DroppedMutation {
  readonly item: OutboxItem;
  readonly status: number;
  readonly code: string | null;
}

export interface OutboxDeps {
  readonly db: SqliteLike;
  readonly transport: OutboxTransport;
  readonly gate: ApplyGate;
  readonly onAccountDeleted: () => Promise<void> | void;
  /** A terminal refusal: shown to the user and reported, never retried. */
  readonly onDropped?: (dropped: DroppedMutation) => void;
  /** A 422 key/body mismatch: reported without the body; the item is re-keyed. */
  readonly onKeyRegenerated?: (item: OutboxItem) => void;
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
}

const MAX_BACKOFF_MS = 5 * 60_000;

/** 1 s, 2 s, 4 s ... capped at five minutes. */
export function backoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempts, 16));
}

/** Queues a mutation; the caller writes its optimistic local row in the same transaction. */
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
  };
  const params: SqlValue[] = [
    item.id,
    item.method,
    item.path,
    mutation.body === undefined ? null : JSON.stringify(mutation.body),
    item.idempotencyKey,
    (options.now ?? new Date()).toISOString(),
  ];
  db.run(
    'INSERT INTO outbox (id, method, path, body, idempotency_key, attempts, next_attempt_at, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, 0, 0, ?)',
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
  };
}

/**
 * The oldest item after `after`, due or not: an item still in its backoff blocks everything
 * queued behind it, so a later mutation can never overtake an earlier one.
 */
function oldest(
  db: SqliteLike,
  after: string | null,
): { readonly item: OutboxItem; readonly nextAttemptAt: number } | null {
  const row = db.get<OutboxDbRow>(
    'SELECT id, method, path, body, idempotency_key, attempts, next_attempt_at FROM outbox ' +
      'WHERE id > ? ORDER BY id LIMIT 1',
    [after ?? ''],
  );
  return row === null ? null : { item: toItem(row), nextAttemptAt: row.next_attempt_at };
}

export function pendingCount(db: SqliteLike): number {
  return db.get<{ n: number }>('SELECT count(*) AS n FROM outbox WHERE id IS NOT NULL')?.n ?? 0;
}

function remove(db: SqliteLike, id: string): void {
  db.run('DELETE FROM outbox WHERE id = ?', [id]);
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
    let after: string | null = null;
    const rekeyed = new Set<string>();
    for (;;) {
      await deps.gate.idle();
      const head = oldest(deps.db, after);
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
        deps.onKeyRegenerated?.({ ...item, idempotencyKey: fresh });
        // Not advancing `after`: the same item goes again, now, with the fresh key, so nothing
        // queued behind it overtakes it.
        continue;
      }
      after = item.id;
      if (response.status >= 200 && response.status < 300) {
        remove(deps.db, item.id);
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
      remove(deps.db, item.id);
      dropped += 1;
      deps.onDropped?.({ item, status: response.status, code });
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
