/**
 * R2 archives (increment 7). Two things land in `PRIVATE_BUCKET`:
 *
 *   - `events/{flightKey}.json`: a finished FlightTracker's timeline, one single-part put (a
 *     sub-5 MB object cannot use multipart, whose minimum part is 5 MiB).
 *   - `dlq/{queue}/{messageId}.json`: the raw body of a message that exhausted its retries,
 *     written by the dead letter consumer before it acknowledges.
 */

import type { FlightKey } from '@planeahead/shared';

export function eventsArchiveKey(flightKey: FlightKey): string {
  return `events/${flightKey}.json`;
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
