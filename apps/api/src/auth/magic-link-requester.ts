/**
 * Binds a magic link to the anonymous user who asked for it.
 *
 * A verified link signs the verifier in as the address owner, and the anonymous after-hook then
 * merges the VERIFIER'S anonymous account into that owner. Without a binding that is a login
 * CSRF with data movement: an attacker requests a link for their own address, forwards the
 * emailed URL, and the victim's app (which auto-verifies universal links with its anonymous
 * cookie attached) merges the victim's devices, push tokens, trips and subscriptions into the
 * attacker's account. So the request records who asked, and the merge runs only when the
 * anonymous user verifying the link is the one that requested it. The sign-in itself still
 * succeeds either way; only the merge is withheld (logged as `merge_skipped`,
 * `requester_mismatch`).
 *
 * The record is a second `verifications` row keyed by a hash of the token under its own
 * identifier prefix, with the same expiry as the link, so it needs no schema of its own and
 * Better Auth's expiry sweep clears it. The token is never stored: Better Auth stores
 * base64url(SHA-256) of it, this row stores hex SHA-256 of it under a different prefix, and
 * neither can be turned back into the link.
 */

import { and, eq } from 'drizzle-orm';
import { type Db, verifications } from '@planeahead/db';
import { uuidv7 } from '@planeahead/shared';
import { sha256Hex } from '../crypto/hash';

export const MAGIC_LINK_REQUESTER_PREFIX = 'magic-link-requester:';

export interface MagicLinkRequesterRecord {
  /** The anonymous user that carried a session when the link was requested, or null. */
  readonly anonymousUserId: string | null;
}

export async function magicLinkRequesterIdentifier(token: string): Promise<string> {
  return `${MAGIC_LINK_REQUESTER_PREFIX}${await sha256Hex(token)}`;
}

export async function recordMagicLinkRequester(
  db: Db,
  token: string,
  record: MagicLinkRequesterRecord,
  expiresAt: Date,
): Promise<void> {
  await db.insert(verifications).values({
    id: uuidv7(),
    identifier: await magicLinkRequesterIdentifier(token),
    value: JSON.stringify(record),
    expiresAt,
  });
}

/**
 * Reads and deletes the record for `token`. Null when there is none (expired and swept, or a
 * link this Worker did not issue), which the caller treats as a mismatch.
 */
export async function consumeMagicLinkRequester(
  db: Db,
  token: string,
): Promise<MagicLinkRequesterRecord | null> {
  const identifier = await magicLinkRequesterIdentifier(token);
  const [row] = await db
    .delete(verifications)
    .where(and(eq(verifications.identifier, identifier)))
    .returning({ value: verifications.value, expiresAt: verifications.expiresAt });
  if (row === undefined || row.expiresAt.getTime() < Date.now()) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(row.value);
    const anonymousUserId =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { anonymousUserId?: unknown }).anonymousUserId
        : null;
    return { anonymousUserId: typeof anonymousUserId === 'string' ? anonymousUserId : null };
  } catch {
    return null;
  }
}
