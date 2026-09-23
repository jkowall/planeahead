/**
 * The magic link, app side (increment 5's server; docs/security/threat-model.md section 1.5).
 *
 * Requesting: `POST /api/auth/sign-in/magic-link` with `{ email }` only (no `callbackURL`, the
 * server's gate drops it anyway) and `X-Install-Id`, which keys the owner's own budget so a
 * stranger's requests do not silence it. The install records the address and time locally.
 *
 * Verifying: the emailed URL is `https://api.planeahead.app/auth/magic-link?token=...`, a
 * universal link (iOS) and verified App Link (Android) that opens `src/app/auth/magic-link.tsx`.
 * That screen calls `magicLink.verify({ query: { token } })` over the Better Auth client's own
 * fetch, so the anonymous session cookie rides along and the server merges the anonymous account
 * into the signed-in one (only when this anonymous user requested the link: the server's
 * requester binding). A link this install did NOT ask for in the last fifteen minutes is never
 * verified automatically: the screen asks first, because a forwarded link would otherwise sign
 * the phone into someone else's account.
 */

import { authClient } from './auth-client';
import { KV_KEYS, kv } from './db/kv';
import { installId } from './identity';

/** Better Auth mints `[a-zA-Z]{32}`; the API's `MAGIC_LINK_TOKEN_SHAPE` is kept this wide. */
export const MAGIC_LINK_TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,256}$/;

/** The link expires ten minutes after it is sent; fifteen covers a slow mail server. */
export const PENDING_REQUEST_WINDOW_MS = 15 * 60 * 1000;

export interface PendingMagicLink {
  readonly email: string;
  readonly requestedAt: number;
}

export function recordMagicLinkRequest(email: string, now: number = Date.now()): void {
  kv.setItemSync(KV_KEYS.pendingMagicLink, JSON.stringify({ email, requestedAt: now }));
}

export function pendingMagicLink(now: number = Date.now()): PendingMagicLink | null {
  const raw = kv.getItemSync(KV_KEYS.pendingMagicLink);
  if (raw === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PendingMagicLink>;
    if (
      typeof parsed.email === 'string' &&
      typeof parsed.requestedAt === 'number' &&
      now - parsed.requestedAt <= PENDING_REQUEST_WINDOW_MS &&
      now >= parsed.requestedAt
    ) {
      return { email: parsed.email, requestedAt: parsed.requestedAt };
    }
  } catch {
    // Unreadable: treat as absent.
  }
  kv.removeItemSync(KV_KEYS.pendingMagicLink);
  return null;
}

export function clearPendingMagicLink(): void {
  kv.removeItemSync(KV_KEYS.pendingMagicLink);
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

export async function verifyMagicLink(token: string): Promise<AuthOutcome> {
  if (!MAGIC_LINK_TOKEN_SHAPE.test(token)) {
    return { ok: false, code: 'INVALID_TOKEN' };
  }
  const { error } = await authClient.magicLink.verify({ query: { token } });
  const result = outcome(error);
  if (result.ok) {
    clearPendingMagicLink();
  }
  return result;
}
