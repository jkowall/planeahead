/**
 * KV tombstones for the sessions of deleted accounts (increment 12, ruling W2 step 8).
 *
 * Increment 8 (ruling O5) made every `/v1` request read the `sessions` row, skipping Better
 * Auth's 300 s cookie cache, because the signed `session_data` cookie would otherwise let a deleted
 * account's other device keep acting (and reading) for up to five minutes. Increment 12 re-enables
 * the cache for GET and HEAD and closes the same hole with a tombstone: a KV key per deleted
 * session, `tombstone:session:{base64url HMAC}`, the same keyed hash `deleted_subjects` stores
 * (`provider_subject_hash`, kind `session`). The auth middleware checks it only when a request
 * resolved while presenting the cache cookie; a mutating request still reads the row.
 *
 * Writers: the deletion itself, right after its transaction commits and before the route answers
 * (the cache window is five minutes, so a nightly writer alone could never close it), and the
 * housekeeping step that re-writes any tombstone missing for an unexpired `deleted_subjects` row
 * (a KV write that failed at deletion time). A tombstone lives as long as its row
 * (`DELETED_SESSION_RETENTION_DAYS`), never less than KV's 60 s floor.
 *
 * KV is eventually consistent (a write is visible in its own location at once and elsewhere within
 * about 60 s, and a location that read the key before may serve its cached miss for up to 60 s).
 * That is the residual window of this design, recorded in docs/security/threat-model.md.
 */

import { errorFields, type Logger } from '../observability/log';

export const SESSION_TOMBSTONE_PREFIX = 'tombstone:';

/** KV's minimum `expirationTtl`. */
export const KV_MIN_TTL_SECONDS = 60;

/** The KV key for a `deleted_subjects.provider_subject_hash` of kind `session`. */
export function sessionTombstoneKey(sessionHash: string): string {
  return `${SESSION_TOMBSTONE_PREFIX}${sessionHash}`;
}

/** Seconds from `nowMs` to `expiresAtMs`, clamped to KV's floor. */
export function tombstoneTtlSeconds(expiresAtMs: number, nowMs: number): number {
  return Math.max(KV_MIN_TTL_SECONDS, Math.ceil((expiresAtMs - nowMs) / 1_000));
}

export interface TombstoneWrite {
  readonly hash: string;
  readonly expiresAtMs: number;
}

/** Writes one tombstone per hash; never throws, returns how many were written. */
export async function writeSessionTombstones(
  kv: Pick<KVNamespace, 'put'>,
  tombstones: readonly TombstoneWrite[],
  nowMs: number,
  log: Logger,
): Promise<{ written: number; failed: number }> {
  const results = await Promise.allSettled(
    tombstones.map((tombstone) =>
      kv.put(sessionTombstoneKey(tombstone.hash), '1', {
        expirationTtl: tombstoneTtlSeconds(tombstone.expiresAtMs, nowMs),
      }),
    ),
  );
  let written = 0;
  let failed = 0;
  for (const result of results) {
    if (result.status === 'fulfilled') {
      written += 1;
    } else {
      failed += 1;
      log.warn('session_tombstone_write_failed', errorFields(result.reason));
    }
  }
  return { written, failed };
}

/** `present`, `absent`, or `unknown` when the read failed (the caller then reads the row). */
export type TombstoneLookup = 'present' | 'absent' | 'unknown';

export async function lookupSessionTombstone(
  kv: Pick<KVNamespace, 'get'>,
  sessionHash: string,
  log: Logger,
): Promise<TombstoneLookup> {
  try {
    return (await kv.get(sessionTombstoneKey(sessionHash))) === null ? 'absent' : 'present';
  } catch (error) {
    log.warn('session_tombstone_read_failed', errorFields(error));
    return 'unknown';
  }
}
