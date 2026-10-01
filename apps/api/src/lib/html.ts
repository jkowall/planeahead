/**
 * Server-rendered HTML for the two pages the API Worker serves to a browser in increment 12: the
 * admin page (`/admin`, behind Cloudflare Access) and the public account-deletion page
 * (`/account/delete`). No client framework and no script at all: every page is one document with
 * one inline `<style>` element, allowed by its SHA-256 in a strict Content Security Policy
 * (`default-src 'none'`, no script source, no framing, no base URI, and no form target except
 * `'self'` on the admin page's account-deletion and test-push forms), so an injected tag could
 * neither run nor load anything. Every interpolated value goes through `esc`.
 *
 * The referrer policy is `no-referrer` unless the page says otherwise, in the header and in the
 * document's `<meta name="referrer">` (the meta wins in a browser, so the two always agree). A page
 * that carries a form to its own origin needs `same-origin`: under `no-referrer` a browser sends
 * `Origin: null` on the form's POST (the Fetch standard's "append a request Origin header"), and a
 * route that requires the page's own origin then refuses the page's own button, which is what the
 * first landing page of increment 5 ran into (docs/build-log.md). Under `same-origin` the POST
 * carries the real origin, and a cross-site form still sends `null` or its own origin.
 */

/** The referrer policies a page may declare: `no-referrer` unless it carries a same-origin form. */
export type ReferrerPolicy = 'no-referrer' | 'same-origin';

/** Escapes text for an HTML text node or a double-quoted attribute. */
export function esc(value: string | number | boolean | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value);
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** What a table cell may hold; anything else is formatted by the caller first. */
export type Cell = string | number | boolean | null | undefined;

/** A table from a header row and body rows; cells are escaped. */
export function table(headers: readonly string[], rows: readonly (readonly Cell[])[]): string {
  const head = headers.map((cell) => `<th scope="col">${esc(cell)}</th>`).join('');
  const body =
    rows.length === 0
      ? `<tr><td colspan="${String(headers.length)}" class="empty">no rows</td></tr>`
      : rows
          .map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`)
          .join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  let binary = '';
  for (const byte of new Uint8Array(digest)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * The CSP for a page whose only active content is the given stylesheet. `formAction` is `'none'`
 * unless the page carries a form, which may then submit to its own origin only (the admin page's
 * account deletion, ruling AA9).
 */
export async function contentSecurityPolicy(
  style: string,
  formAction: "'none'" | "'self'" = "'none'",
): Promise<string> {
  return [
    "default-src 'none'",
    `style-src 'sha256-${await sha256Base64(style)}'`,
    "img-src 'none'",
    "base-uri 'none'",
    `form-action ${formAction}`,
    "frame-ancestors 'none'",
  ].join('; ');
}

export interface HtmlPage {
  readonly title: string;
  readonly style: string;
  readonly body: string;
  /** `Cache-Control`; `no-store` unless the page is public and static. */
  readonly cacheControl: string;
  /** The HTTP status; 200 unless given. */
  readonly status?: number | undefined;
  /** `'self'` for a page with a form; `'none'` otherwise. */
  readonly formAction?: "'none'" | "'self'" | undefined;
  /**
   * `same-origin` for a page whose form posts to this origin, so the browser sends the real
   * `Origin` on the POST; `no-referrer` (the default) everywhere else.
   */
  readonly referrerPolicy?: ReferrerPolicy | undefined;
  /**
   * Reload the page after this many seconds (`<meta http-equiv="refresh">`, which needs no
   * script): the admin page's test-push result while the outcome is still on its way.
   */
  readonly refreshSeconds?: number | undefined;
}

/** The document and its headers. */
export async function renderPage(page: HtmlPage): Promise<Response> {
  const referrerPolicy: ReferrerPolicy = page.referrerPolicy ?? 'no-referrer';
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="${referrerPolicy}">${
    page.refreshSeconds === undefined
      ? ''
      : `\n<meta http-equiv="refresh" content="${String(Math.max(1, Math.floor(page.refreshSeconds)))}">`
  }
<title>${esc(page.title)}</title>
<style>${page.style}</style>
</head>
<body>
${page.body}
</body>
</html>
`;
  return new Response(html, {
    status: page.status ?? 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': await contentSecurityPolicy(page.style, page.formAction),
      'cache-control': page.cacheControl,
      'x-content-type-options': 'nosniff',
      'referrer-policy': referrerPolicy,
      'x-frame-options': 'DENY',
    },
  });
}
