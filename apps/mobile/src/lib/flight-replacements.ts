/**
 * Where an optimistic subscription went (increment 10 review, ruling X7 item 5). When the server
 * answers a queued add under ANOTHER id (200 `created: false`: the account already held the
 * flight; or a restored tombstone), the outbox's success hook removes the optimistic row, and a
 * detail screen opened on the optimistic id would read nothing and say "Flight not found". The
 * hook records `replaced:{optimisticId}` = `{ serverId, at }` in the kv-store; `useFlight`
 * (src/lib/flight-queries.ts) follows it.
 *
 * The entries are bounded (increment 10 re-review, ruling Y5): an entry goes once the server row
 * it points at has been read (`forgetReplacement`), every entry older than a day goes whenever one
 * is read or written, and signing out (or a deleted account) clears them all (services.ts
 * `forgetAccount`).
 *
 * The kv-store is a separate file from the offline store, so the record is not part of the hook's
 * transaction: a failed write costs a "not found" on a screen that was open at that moment, never
 * the reconciliation itself, so every error here is swallowed.
 */

import { kv } from './db/kv';

const PREFIX = 'replaced:';

/** How long an entry is kept when nothing reads the row it points at. */
export const REPLACEMENT_TTL_MS = 24 * 60 * 60_000;

interface Replacement {
  readonly serverId: string;
  /** When it was recorded, in epoch ms. */
  readonly at: number;
}

export function replacedKey(optimisticId: string): string {
  return `${PREFIX}${optimisticId}`;
}

function parse(value: string | null): Replacement | null {
  if (value === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as { serverId?: unknown; at?: unknown } | null;
    return typeof parsed?.serverId === 'string' && typeof parsed.at === 'number'
      ? { serverId: parsed.serverId, at: parsed.at }
      : null;
  } catch {
    return null;
  }
}

function replacementKeys(): string[] {
  return kv.getAllKeysSync().filter((key) => key.startsWith(PREFIX));
}

/** Drops every entry older than a day, or unreadable (one written before entries had a time). */
function dropStale(now: number): void {
  for (const key of replacementKeys()) {
    const entry = parse(kv.getItemSync(key));
    if (entry === null || now - entry.at > REPLACEMENT_TTL_MS) {
      kv.removeItemSync(key);
    }
  }
}

export function recordReplacement(optimisticId: string, serverId: string, now = Date.now()): void {
  try {
    dropStale(now);
    const entry: Replacement = { serverId, at: now };
    kv.setItemSync(replacedKey(optimisticId), JSON.stringify(entry));
  } catch {
    // See the header.
  }
}

/** The id `id` was replaced by, or null. The entry stays until `forgetReplacement`. */
export function readReplacement(id: string, now = Date.now()): string | null {
  try {
    dropStale(now);
    return parse(kv.getItemSync(replacedKey(id)))?.serverId ?? null;
  } catch {
    return null;
  }
}

/** The server row the entry for `id` points at has been read: the entry has done its job. */
export function forgetReplacement(id: string): void {
  try {
    kv.removeItemSync(replacedKey(id));
  } catch {
    // See the header.
  }
}

/** Every entry, with the rows they named (services.ts `forgetAccount`). */
export function clearReplacements(): void {
  try {
    for (const key of replacementKeys()) {
      kv.removeItemSync(key);
    }
  } catch {
    // See the header.
  }
}
