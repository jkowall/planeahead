/**
 * The browser side of the magic link, OUTSIDE the Better Auth mount.
 *
 * The emailed URL is `GET /auth/magic-link?token=...`. That GET never consumes the token: mail
 * security gateways (Safe Links, Mimecast, Proofpoint) fetch every link in inbound mail before
 * the recipient sees it, and a consuming link would be burned by the scanner, sign the scanner
 * in, and leave the app's own verify with nothing. On a phone with the app installed the
 * universal link opens the app instead (increment 9), which never loads this page. In a browser
 * the page shows one button that POSTs the token to `/api/auth/magic-link/consume`
 * (src/routes/auth.ts), which calls Better Auth's verify server side and answers with the
 * session cookie plus a page that says to open the app.
 *
 * The page carries the token in a hidden field, so it is built to leak nothing: no external
 * resources, no script, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, a CSP that
 * allows only inline styles and same-origin form posts, and the token HTML-escaped on the way in.
 */

import type { Context } from 'hono';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { MAGIC_LINK_CONSUME_PATH } from '../auth/paths';
import type { AppBindings } from '../env';

/** Better Auth mints `[a-zA-Z]{32}`; the shape is kept wide enough for a custom generator. */
export const MAGIC_LINK_TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,256}$/;

export type MagicLinkPageKind = 'confirm' | 'signed_in' | 'invalid' | 'forbidden';

const PAGE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex',
  'x-content-type-options': 'nosniff',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const STYLE =
  'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
  'max-width:28rem;margin:4rem auto;padding:0 1.5rem;color:#1a1a1a;line-height:1.5}' +
  'button{font:inherit;padding:.75rem 1.5rem;border:0;border-radius:.5rem;background:#1c4fd6;' +
  'color:#fff;cursor:pointer}p.small{color:#555;font-size:.9rem}';

function shell(title: string, body: string): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="referrer" content="no-referrer">' +
    `<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>` +
    `<body><h1>${escapeHtml(title)}</h1>${body}</body></html>`
  );
}

/** The HTML for one of the four states. `token` is only used by the confirm page. */
export function magicLinkPage(kind: MagicLinkPageKind, token: string = ''): string {
  switch (kind) {
    case 'confirm':
      return shell(
        'Sign in to PlaneAhead',
        `<form method="post" action="${escapeHtml(MAGIC_LINK_CONSUME_PATH)}">` +
          `<input type="hidden" name="token" value="${escapeHtml(token)}">` +
          '<p>Press the button to finish signing in. The link works once and expires ten ' +
          'minutes after it was sent.</p>' +
          '<button type="submit">Sign in</button></form>' +
          '<p class="small">If you did not ask for this link, close this page; nothing ' +
          'happens without the button.</p>',
      );
    case 'signed_in':
      return shell(
        'You are signed in',
        '<p>Open the PlaneAhead app on your phone to continue.</p>' +
          '<p class="small">You can close this page.</p>',
      );
    case 'forbidden':
      return shell(
        'Sign-in refused',
        '<p>This request did not come from the sign-in page. Open the link from your email ' +
          'again.</p>',
      );
    default:
      return shell(
        'This link is not valid',
        '<p>The link is invalid, expired or already used. Request a new one from the app.</p>',
      );
  }
}

export function magicLinkPageResponse(
  c: Context<AppBindings>,
  kind: MagicLinkPageKind,
  status: ContentfulStatusCode,
  token?: string,
): Response {
  return c.body(magicLinkPage(kind, token), status, { ...PAGE_HEADERS });
}

export const magicLinkLanding = new Hono<AppBindings>().get('/', (c) => {
  const token = c.req.query('token');
  if (token === undefined || !MAGIC_LINK_TOKEN_SHAPE.test(token)) {
    return magicLinkPageResponse(c, 'invalid', 400);
  }
  return magicLinkPageResponse(c, 'confirm', 200, token);
});
