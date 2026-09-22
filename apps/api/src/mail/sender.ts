/**
 * Outbound mail. One interface, three implementations (`resend.ts`, `cloudflare-email.ts`,
 * `noop.ts`), and the magic-link message itself.
 *
 * A send never throws into a request handler: every failure is a result value, logged where it
 * happened, and the caller decides what the user sees (for a magic link: always 200, so a
 * missing account and a broken mail provider look the same from outside).
 */

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
  /** The API origin the verify link points at (`API_PUBLIC_URL`). */
  readonly apiPublicUrl: string;
}

export interface MagicLinkEmail {
  readonly url: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** `magic-link/<prefix>`: the provider idempotency key, carrying 8 characters of the token. */
  readonly idempotencyKey: string;
}

export const MAGIC_LINK_TOKEN_PREFIX_LENGTH = 8;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * The link is `${API_PUBLIC_URL}/api/auth/magic-link/verify?token=...` with NO `callbackURL`.
 * Verification completes in the app: the universal link opens it, the app extracts the token and
 * calls `GET /magic-link/verify` over its own fetch with the anonymous cookie attached, and with
 * no `callbackURL` Better Auth answers JSON plus `Set-Cookie` instead of a redirect. The redirect
 * form is what the Expo server plugin decorates with `?cookie=<set-cookie>`, which would put the
 * session cookie into a URL (docs/security/threat-model.md).
 */
export function buildMagicLinkEmail(input: MagicLinkEmailInput): MagicLinkEmail {
  const url = new URL('/api/auth/magic-link/verify', input.apiPublicUrl);
  url.searchParams.set('token', input.token);
  const link = url.toString();
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
    idempotencyKey: `magic-link/${input.token.slice(0, MAGIC_LINK_TOKEN_PREFIX_LENGTH)}`,
  };
}
