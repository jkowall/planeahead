/**
 * Where an optimistic subscription went (increment 10 review, ruling X7 item 5). When the server
 * answers a queued add under ANOTHER id (200 `created: false`: the account already held the
 * flight; or a restored tombstone), the outbox's success hook removes the optimistic row, and a
 * detail screen opened on the optimistic id would read nothing and say "Flight not found". The
 * hook records `replaced:{optimisticId}` = serverId in the kv-store; `useFlight`
 * (src/lib/flight-queries.ts) follows it and clears it when it reads it.
 *
 * The kv-store is a separate file from the offline store, so the record is not part of the hook's
 * transaction: a failed write costs a "not found" on a screen that was open at that moment, never
 * the reconciliation itself, so it is swallowed.
 */

import { kv } from './db/kv';

export function replacedKey(optimisticId: string): string {
  return `replaced:${optimisticId}`;
}

export function recordReplacement(optimisticId: string, serverId: string): void {
  try {
    kv.setItemSync(replacedKey(optimisticId), serverId);
  } catch {
    // See the header.
  }
}

/** The id `id` was replaced by, once: the entry is cleared when read. */
export function takeReplacement(id: string): string | null {
  try {
    const key = replacedKey(id);
    const serverId = kv.getItemSync(key);
    if (serverId !== null) {
      kv.removeItemSync(key);
    }
    return serverId;
  } catch {
    return null;
  }
}
