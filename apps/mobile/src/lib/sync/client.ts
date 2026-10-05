/**
 * The pull side of the offline store: `GET /v1/sync` pages until `hasMore` is false.
 *
 * - Each page's shell (`rpcVersion`, `serverTime`, `cursor`, `hasMore`) is validated strictly; a
 *   page whose shell does not validate is not applied at all. Its `changes[]` and `flights[]`
 *   are parsed element by element and an unreadable element is skipped and reported
 *   (src/lib/sync/apply.ts), so a value a newer server adds never stalls the feed.
 * - Each page is applied in ONE immediate transaction with its cursor. A page pulled without a
 *   cursor is the snapshot and replaces the synced rows in that same transaction.
 * - 410 `resync_required`, whatever caused it, and 400 `invalid_cursor` (a cursor this server
 *   cannot decode, e.g. after a format change) clear the cursor, keep the rows and pull the
 *   no-cursor snapshot, at most MAX_RESETS_PER_PULL times per pull. The increment 8 cursor is
 *   bound to the user and to a database epoch, so an anonymous device that signs in to an existing
 *   account, a restored database and a purged retention window all land here.
 * - A session user who is not the store's owner empties the synced rows before the first request
 *   (the owner is recorded with every page), and a build with a different store schema version
 *   (src/lib/sync/version.ts) pulls the snapshot again.
 * - 401 `account_deleted` wipes the store AND the outbox and hands control to
 *   `onAccountDeleted`, which signs out and returns to the sign-in group.
 * - The outbox is suspended for the whole pull (src/lib/sync/gate.ts).
 *
 * Concurrent calls for the same user share one pull: a foreground, a pull-to-refresh and a
 * post-sign-in trigger landing together make one request sequence. A call for another user
 * waits for the pull in flight, then starts its own.
 */

import type { NotificationPreferences, UserPreferences } from '@planeahead/shared';
import { errorCode } from '../api-client';
import type { SqliteLike } from '../db/sqlite-like';
import { applySyncPage, SyncPageShell, type ApplyOutcome } from './apply';
import type { ApplyGate } from './gate';
import { readSyncState, requestSnapshot, wipeLocalStore, wipeSyncedRows } from './store';
import { STORE_SCHEMA_VERSION } from './version';

export interface SyncTransport {
  /** `GET /v1/sync`, with `?cursor=` when one is given. */
  pull(cursor: string | null): Promise<{ readonly status: number; readonly body: unknown }>;
}

export interface SyncDeps {
  readonly db: SqliteLike;
  readonly transport: SyncTransport;
  readonly gate: ApplyGate;
  readonly onAccountDeleted: () => Promise<void> | void;
  readonly onPreferences?: (preferences: UserPreferences) => void;
  /** A page carried `notification_preferences` (its last upsert, the defaults filled in). */
  readonly onNotifications?: (notifications: NotificationPreferences) => void;
  readonly onSkipped?: (skipped: ApplyOutcome['skipped']) => void;
  readonly now?: () => Date;
  /** A runaway guard, far above any real feed: 1000 pages of 200 rows. */
  readonly maxPages?: number;
  /** This build's store schema version; tests pass another to simulate an app update. */
  readonly storeVersion?: string;
}

export type SyncResult =
  | {
      readonly kind: 'synced';
      readonly pages: number;
      readonly changes: number;
      readonly resets: number;
    }
  | { readonly kind: 'account_deleted' }
  | { readonly kind: 'unauthenticated' };

export class SyncError extends Error {
  override readonly name = 'SyncError';
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** A refusal right after a reset means the server refuses the no-cursor pull too. */
export const MAX_RESETS_PER_PULL = 2;

/**
 * The server refused the cursor itself: 410 `resync_required`, or a 400 that can only be about
 * the cursor (the pull's one query parameter), `invalid_cursor` or the validator's
 * `validation_failed` (a cursor longer than the server now accepts).
 */
function cursorRefused(
  response: { readonly status: number; readonly body: unknown },
  cursor: string | null,
): boolean {
  const code = errorCode(response.body);
  if (response.status === 410) {
    return code === 'resync_required';
  }
  return (
    response.status === 400 &&
    cursor !== null &&
    (code === 'invalid_cursor' || code === 'validation_failed')
  );
}

async function pull(deps: SyncDeps, userId: string): Promise<SyncResult> {
  const maxPages = deps.maxPages ?? 1000;
  const storeVersion = deps.storeVersion ?? STORE_SCHEMA_VERSION;
  let pages = 0;
  let changes = 0;
  let resets = 0;

  const state = readSyncState(deps.db);
  if (state !== null && state.ownerUserId !== null && state.ownerUserId !== userId) {
    wipeSyncedRows(deps.db);
  } else if (state?.cursor != null && state.storeVersion !== storeVersion) {
    requestSnapshot(deps.db);
  }

  while (pages < maxPages) {
    const cursor = readSyncState(deps.db)?.cursor ?? null;
    const response = await deps.transport.pull(cursor);

    if (cursorRefused(response, cursor)) {
      resets += 1;
      const code = errorCode(response.body);
      if (resets > MAX_RESETS_PER_PULL) {
        throw new SyncError(response.status, code, `${String(code)} answered to a reset store`);
      }
      requestSnapshot(deps.db);
      continue;
    }
    if (response.status === 401) {
      if (errorCode(response.body) === 'account_deleted') {
        wipeLocalStore(deps.db);
        await deps.onAccountDeleted();
        return { kind: 'account_deleted' };
      }
      return { kind: 'unauthenticated' };
    }
    if (response.status !== 200) {
      const code = errorCode(response.body);
      throw new SyncError(
        response.status,
        code,
        `GET /v1/sync answered ${String(response.status)}`,
      );
    }

    const page = SyncPageShell.safeParse(response.body);
    if (!page.success) {
      throw new SyncError(200, null, 'GET /v1/sync answered a page that is not a SyncEnvelopeV1');
    }
    const outcome = applySyncPage(deps.db, page.data, {
      replace: cursor === null,
      ownerUserId: userId,
      storeVersion,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    });
    pages += 1;
    changes += outcome.changes;
    if (outcome.skipped.length > 0) {
      deps.onSkipped?.(outcome.skipped);
    }
    if (outcome.preferences !== null) {
      deps.onPreferences?.(outcome.preferences);
    }
    if (outcome.notifications !== null) {
      deps.onNotifications?.(outcome.notifications);
    }
    if (!page.data.hasMore) {
      return { kind: 'synced', pages, changes, resets };
    }
  }
  throw new SyncError(200, null, `GET /v1/sync still had more after ${String(maxPages)} pages`);
}

export interface SyncClient {
  /** Pulls for `userId` (the session user) until drained; callers for that user share it. */
  sync(userId: string): Promise<SyncResult>;
}

export function createSyncClient(deps: SyncDeps): SyncClient {
  let inFlight: { readonly userId: string; readonly promise: Promise<SyncResult> } | null = null;
  return {
    sync(userId) {
      if (inFlight?.userId === userId) {
        return inFlight.promise;
      }
      const run = () => deps.gate.hold(() => pull(deps, userId));
      // With nothing in flight the gate is taken NOW, synchronously, so an outbox drain started
      // right after this call already finds it held.
      const started = inFlight === null ? run() : inFlight.promise.then(run, run);
      const promise: Promise<SyncResult> = started.finally(() => {
        if (inFlight?.promise === promise) {
          inFlight = null;
        }
      });
      inFlight = { userId, promise };
      return promise;
    },
  };
}
