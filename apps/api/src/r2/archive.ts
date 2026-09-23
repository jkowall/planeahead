/**
 * R2 archives (increment 7). Two things land in `PRIVATE_BUCKET`:
 *
 *   - `events/{flightKey}@{epochMs}.json`: a finished FlightTracker's timeline, one single-part
 *     put (a sub-5 MB object cannot use multipart, whose minimum part is 5 MiB). The key is per
 *     tracker LIFETIME (the object's `created_at_ms`, the same epoch its outbox origin carries)
 *     and the put is conditional on the key not existing, so an archive is never overwritten,
 *     whatever a later lifetime of the same key does (ruling L9, ADR 0011).
 *   - `dlq/{queue}/{messageId}.json`: the raw body of a message that exhausted its retries,
 *     written by the dead letter consumer before it acknowledges.
 */

import type { FlightKey } from '@planeahead/shared';

export function eventsArchiveKey(flightKey: FlightKey, epochMs: number): string {
  return `events/${flightKey}@${String(epochMs)}.json`;
}

export function deadLetterArchiveKey(queueKind: string, messageId: string): string {
  return `dlq/${queueKind}/${messageId}.json`;
}

/** One put of a JSON document. Throws on failure; callers decide what that means. */
export async function putJsonArchive(
  bucket: Pick<R2Bucket, 'put'>,
  key: string,
  value: unknown,
): Promise<void> {
  await bucket.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: 'application/json' },
  });
}

/**
 * One put of a JSON document that never overwrites: `onlyIf: { etagDoesNotMatch: '*' }` is R2's
 * `If-None-Match: *`, and a put whose precondition fails resolves to null rather than throwing.
 * Returns `stored` when this call wrote the object and `exists` when one was already there.
 * Throws on any other failure.
 */
export async function putJsonArchiveIfAbsent(
  bucket: Pick<R2Bucket, 'put'>,
  key: string,
  value: unknown,
): Promise<'stored' | 'exists'> {
  const result = await bucket.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: 'application/json' },
    onlyIf: { etagDoesNotMatch: '*' },
  });
  return result === null ? 'exists' : 'stored';
}
