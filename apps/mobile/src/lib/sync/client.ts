/**
 * The pull side of the offline store: `GET /v1/sync` pages until `hasMore` is false.
 *
 * - Each page is validated against the shared `SyncEnvelopeV1` and applied in ONE immediate
 *   transaction with its cursor (src/lib/sync/apply.ts); a page that does not validate is not
 *   applied at all.
 * - 410 `resync_required`, whatever caused it, resets the synced tables and the cursor (the
 *   outbox stays) and pulls the no-cursor snapshot. The increment 8 cursor is bound to the user
 *   and to a database epoch, so an anonymous device that signs in to an existing account, a
 *   restored database and a purged retention window all land here; signing in is therefore also
 *   a reset, and nothing else needs to special-case it.
 * - 401 `account_deleted` wipes the store AND the outbox and hands control to
 *   `onAccountDeleted`, which signs out and returns to the sign-in group.
 * - The outbox is suspended for the whole pull (src/lib/sync/gate.ts).
 *
 * Concurrent calls share one pull: a foreground, a pull-to-refresh and a post-sign-in trigger
 * landing together make one request sequence.
 */

import { SyncEnvelopeV1, type UserPreferences } from '@planeahead/shared';
import { errorCode } from '../api-client';
import type { SqliteLike } from '../db/sqlite-like';
import { applySyncPage, type ApplyOutcome } from './apply';
import type { ApplyGate } from './gate';
import { readCursor, resetSyncedState, wipeLocalStore } from './store';

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
  readonly onSkipped?: (skipped: ApplyOutcome['skipped']) => void;
  readonly now?: () => Date;
  /** A runaway guard, far above any real feed: 1000 pages of 200 rows. */
  readonly maxPages?: number;
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

/** A 410 immediately after a reset means the server refuses the no-cursor pull too. */
const MAX_RESETS_PER_PULL = 2;

async function pull(deps: SyncDeps): Promise<SyncResult> {
  const maxPages = deps.maxPages ?? 1000;
  let pages = 0;
  let changes = 0;
  let resets = 0;

  while (pages < maxPages) {
    const cursor = readCursor(deps.db);
    const response = await deps.transport.pull(cursor);

    if (response.status === 410 && errorCode(response.body) === 'resync_required') {
      resets += 1;
      if (resets > MAX_RESETS_PER_PULL) {
        throw new SyncError(410, 'resync_required', 'resync_required answered to a reset store');
      }
      resetSyncedState(deps.db);
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

    const page = SyncEnvelopeV1.safeParse(response.body);
    if (!page.success) {
      throw new SyncError(200, null, 'GET /v1/sync answered a page that is not a SyncEnvelopeV1');
    }
    const outcome = applySyncPage(deps.db, page.data, deps.now);
    pages += 1;
    changes += outcome.changes;
    if (outcome.skipped.length > 0) {
      deps.onSkipped?.(outcome.skipped);
    }
    if (outcome.preferences !== null) {
      deps.onPreferences?.(outcome.preferences);
    }
    if (!page.data.hasMore) {
      return { kind: 'synced', pages, changes, resets };
    }
  }
  throw new SyncError(200, null, `GET /v1/sync still had more after ${String(maxPages)} pages`);
}

export interface SyncClient {
  /** Pulls until drained; concurrent callers share the pull in flight. */
  sync(): Promise<SyncResult>;
}

export function createSyncClient(deps: SyncDeps): SyncClient {
  let inFlight: Promise<SyncResult> | null = null;
  return {
    sync() {
      inFlight ??= deps.gate
        .hold(() => pull(deps))
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}
