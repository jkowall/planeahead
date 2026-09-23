/**
 * Outbound mail. One interface, three implementations (`resend.ts`, `cloudflare-email.ts`,
 * `noop.ts`), and the magic-link message itself.
 *
 * A send never throws into a request handler: every failure is a result value, logged where it
 * happened, and the caller decides what the user sees (for a magic link: always 200, so a
 * missing account and a broken mail provider look the same from outside).
 */

import { sha256Hex } from '../crypto/hash';
import { MAGIC_LINK_LANDING_PATH } from '../auth/paths';

export const MAIL_FROM = 'PlaneAhead <sign-in@planeahead.app>';

export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /**
   * Provider-side idempotency key. A retried send with the same key is a no-op at the provider
   * instead of a second email in the inbox.
   */
  readonly idempotencyKey?: string;
}

export type MailSendResult =
  | { readonly ok: true; readonly id: string | null }
  | {
      readonly ok: false;
      /**
       * `configuration`: the account or the domain is misconfigured (an unverified sender, a
       * spent quota, a bad key); nothing about retrying will help and someone has to act.
       * `rate_limited`: the provider asked for a pause and the single retry did not clear it.
       * `transport`: the network or the provider failed in a way that says nothing about setup.
       */
      readonly reason: 'configuration' | 'rate_limited' | 'transport';
    };

export interface MailSender {
  send(message: MailMessage): Promise<MailSendResult>;
}

export interface MagicLinkEmailInput {
  readonly token: string;
  /** The API origin the landing link points at (`API_PUBLIC_URL`). */
  readonly apiPublicUrl: string;
}

export interface MagicLinkEmail {
  readonly url: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /**
   * `magic-link/<digest>`: the provider idempotency key, the first 32 hex characters of the
   * token's SHA-256. As unique as the token, and it carries no token material into a header
   * the provider retains for 24 hours and shows in its API logs.
   */
  readonly idempotencyKey: string;
}

export const MAGIC_LINK_IDEMPOTENCY_DIGEST_LENGTH = 32;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** The emailed URL: the landing page on the API host with the token as its query parameter. */
export function magicLinkLandingUrl(apiPublicUrl: string, token: string): string {
  const url = new URL(MAGIC_LINK_LANDING_PATH, apiPublicUrl);
  url.searchParams.set('token', token);
  return url.toString();
}

/**
 * The link is `${API_PUBLIC_URL}/auth/magic-link?token=...`, a NON-consuming landing page, never
 * the verify endpoint itself. Mail security gateways (Safe Links, Mimecast, Proofpoint) fetch
 * every link in inbound mail before the recipient sees it; a link that consumed the single-use
 * token on GET would be burned by the scanner, sign the scanner in, and leave the app's own
 * verify with nothing (docs/security/threat-model.md).
 *
 * On a phone with the app installed the universal link opens the app, which extracts the token
 * and calls `GET /api/auth/magic-link/verify` over its own fetch with the anonymous cookie
 * attached (JSON plus Set-Cookie, no `callbackURL`, so the merge fires and no cookie rides in a
 * redirect). In a browser the page shows one button that POSTs the token to the consume route.
 */
export async function buildMagicLinkEmail(input: MagicLinkEmailInput): Promise<MagicLinkEmail> {
  const link = magicLinkLandingUrl(input.apiPublicUrl, input.token);
  const digest = (await sha256Hex(input.token)).slice(0, MAGIC_LINK_IDEMPOTENCY_DIGEST_LENGTH);
  return {
    url: link,
    subject: 'Your PlaneAhead sign-in link',
    text:
      'Open this link on your phone to sign in to PlaneAhead:\n\n' +
      `${link}\n\n` +
      'The link works once and expires in 10 minutes. If you did not ask for it, ignore this ' +
      'email; nothing happens without the link.\n',
    html:
      '<p>Open this link on your phone to sign in to PlaneAhead:</p>' +
      `<p><a href="${escapeHtml(link)}">Sign in to PlaneAhead</a></p>` +
      '<p>The link works once and expires in 10 minutes. If you did not ask for it, ignore this ' +
      'email; nothing happens without the link.</p>',
    idempotencyKey: `magic-link/${digest}`,
  };
}
