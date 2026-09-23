/**
 * The magic link, app side (increment 5's server; docs/security/threat-model.md section 1.5).
 *
 * Requesting: `POST /api/auth/sign-in/magic-link` with `{ email }` only (no `callbackURL`, the
 * server's gate drops it anyway) and `X-Install-Id`, which keys the owner's own budget so a
 * stranger's requests do not silence it. The install records the address and the time locally.
 *
 * Verifying: the emailed URL is `https://<api host>/auth/magic-link?token=...`, a universal link
 * (iOS) and verified App Link (Android) that opens `src/app/auth/magic-link.tsx`. That screen
 * calls `magicLink.verify({ query: { token } })` over the Better Auth client's own fetch, so the
 * anonymous session cookie rides along and the server merges the anonymous account into the
 * signed-in one (only when this anonymous user requested the link: the server's requester
 * binding).
 *
 * The app's half of the binding (increment 9 review, finding auth-and-store-3; threat model 1.5):
 *
 * 1. A link is verified WITHOUT asking only when this install requested a link in the last
 *    fifteen minutes AND the link arrived as a universal link: an `https` URL on the host this
 *    variant claims (`runtimeConfig().universalLinkHosts`) whose token is the one on screen. The
 *    custom scheme (`planeahead://auth/magic-link?...`) routes to the same screen, and any app on
 *    the device, or a tapped web link, can open it without the user asking, so such a delivery,
 *    like a link this install never asked for, waits for an explicit tap.
 * 2. Whenever this install has a pending request, the account a verified link signed in to must
 *    carry one of the requested addresses (compared case-insensitively). If not, the app signs
 *    that session out and puts the pre-verify cookies back, so the phone is again the anonymous
 *    user it was, and nothing the user adds afterwards lands in someone else's account.
 * 3. The outbox is held while the verify and the check run (the apply gate), so no queued
 *    mutation is sent under a session that is about to be undone.
 *
 * The real binding (the emailed URL carrying a per-request tag the app matches) needs the server
 * and is an increment 12 amendment the orchestrator records.
 */

import { authClient, restoreAuthCookies, snapshotAuthCookies } from './auth-client';
import { KV_KEYS, kv } from './db/kv';
import { installId } from './identity';
import { services } from './services';

/** Better Auth mints `[a-zA-Z]{32}`; the API's `MAGIC_LINK_TOKEN_SHAPE` is kept this wide. */
export const MAGIC_LINK_TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,256}$/;

/** The link expires ten minutes after it is sent; fifteen covers a slow mail server. */
export const PENDING_REQUEST_WINDOW_MS = 15 * 60 * 1000;

/** How many recent requests are remembered (a typo corrected, a second address tried). */
export const MAX_PENDING_REQUESTS = 5;

/** apps/mobile/app.config.ts MAGIC_LINK_PATH, the path the app claims. */
export const MAGIC_LINK_PATH = '/auth/magic-link';

export interface PendingMagicLink {
  readonly email: string;
  readonly requestedAt: number;
}

function isPending(value: unknown, now: number): value is PendingMagicLink {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { email, requestedAt } = value as Partial<PendingMagicLink>;
  return (
    typeof email === 'string' &&
    typeof requestedAt === 'number' &&
    now >= requestedAt &&
    now - requestedAt <= PENDING_REQUEST_WINDOW_MS
  );
}

/** The requests this install made in the last fifteen minutes, oldest first. */
export function pendingMagicLinks(now: number = Date.now()): PendingMagicLink[] {
  const raw = kv.getItemSync(KV_KEYS.pendingMagicLink);
  if (raw === null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const entries = (Array.isArray(parsed) ? parsed : [parsed]).filter(
    (entry): entry is PendingMagicLink => isPending(entry, now),
  );
  if (entries.length === 0) {
    kv.removeItemSync(KV_KEYS.pendingMagicLink);
  }
  return entries.map(({ email, requestedAt }) => ({ email, requestedAt }));
}

export function recordMagicLinkRequest(email: string, now: number = Date.now()): void {
  const others = pendingMagicLinks(now).filter(
    (entry) => entry.email.toLowerCase() !== email.toLowerCase(),
  );
  const next = [...others, { email, requestedAt: now }].slice(-MAX_PENDING_REQUESTS);
  kv.setItemSync(KV_KEYS.pendingMagicLink, JSON.stringify(next));
}

export function clearPendingMagicLink(): void {
  kv.removeItemSync(KV_KEYS.pendingMagicLink);
}

export type LinkDelivery = 'universal_link' | 'other';

function queryValue(query: string, name: string): string | null {
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    const key = eq === -1 ? pair : pair.slice(0, eq);
    if (key === name) {
      try {
        return decodeURIComponent(eq === -1 ? '' : pair.slice(eq + 1).replace(/\+/g, ' '));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * How the link on screen reached the app: `universal_link` only for an `https` URL on one of
 * `hosts`, on the magic-link path, carrying exactly `token`. Parsed by hand: the check must not
 * depend on how complete the runtime's URL implementation is.
 */
export function magicLinkDelivery(
  url: string | null,
  token: string,
  hosts: readonly string[],
): LinkDelivery {
  if (url === null) {
    return 'other';
  }
  const match = /^https:\/\/([^/?#@:]+)(?::\d+)?([^?#]*)(?:\?([^#]*))?/i.exec(url);
  if (match === null) {
    return 'other';
  }
  const [, host = '', path = '', query = ''] = match;
  const known = hosts.some((candidate) => candidate.toLowerCase() === host.toLowerCase());
  const onPath = path.replace(/\/+$/, '') === MAGIC_LINK_PATH;
  return known && onPath && queryValue(query, 'token') === token ? 'universal_link' : 'other';
}

export type AuthOutcome = { readonly ok: true } | { readonly ok: false; readonly code: string };

function outcome(error: { readonly message?: string | undefined } | null): AuthOutcome {
  if (error === null) {
    return { ok: true };
  }
  const code: unknown = (error as { code?: unknown }).code;
  return { ok: false, code: typeof code === 'string' ? code : 'request_failed' };
}

export async function requestMagicLink(email: string): Promise<AuthOutcome> {
  const { error } = await authClient.signIn.magicLink(
    { email: email.trim() },
    { headers: { 'X-Install-Id': installId() } },
  );
  const result = outcome(error);
  if (result.ok) {
    recordMagicLinkRequest(email.trim());
  }
  return result;
}

/** The code a verify answers when the link signed in to an address this install did not ask for. */
export const ACCOUNT_MISMATCH = 'account_mismatch';

function signedInEmail(data: unknown): string | null {
  const user: unknown =
    typeof data === 'object' && data !== null ? (data as { user?: unknown }).user : null;
  const email: unknown =
    typeof user === 'object' && user !== null ? (user as { email?: unknown }).email : null;
  return typeof email === 'string' ? email : null;
}

async function verifyAndCheck(token: string): Promise<AuthOutcome> {
  const pending = pendingMagicLinks();
  // Taken before the verify replaces the anonymous cookie, to put it back on a mismatch.
  const before = pending.length > 0 ? await snapshotAuthCookies() : null;
  const { data, error } = await authClient.magicLink.verify({ query: { token } });
  const result = outcome(error);
  if (!result.ok) {
    return result;
  }
  if (pending.length > 0) {
    const email = signedInEmail(data)?.toLowerCase() ?? null;
    if (email === null || !pending.some((entry) => entry.email.toLowerCase() === email)) {
      // Revokes the session the link created (the phone never keeps it) and forgets its cookie;
      // then the anonymous user's cookie comes back. The requests stay pending: the user's own
      // link may still arrive.
      await authClient.signOut().catch(() => undefined);
      await restoreAuthCookies(before);
      return { ok: false, code: ACCOUNT_MISMATCH };
    }
  }
  clearPendingMagicLink();
  return result;
}

/** Verifies `token` in the app, with the outbox held and the account checked (see the header). */
export async function verifyMagicLink(token: string): Promise<AuthOutcome> {
  if (!MAGIC_LINK_TOKEN_SHAPE.test(token)) {
    return { ok: false, code: 'INVALID_TOKEN' };
  }
  const { gate } = await services();
  return gate.hold(() => verifyAndCheck(token));
}
