/**
 * Server-rendered HTML for the two pages the API Worker serves to a browser in increment 12: the
 * admin page (`/admin`, behind Cloudflare Access) and the public account-deletion page
 * (`/account/delete`). No client framework and no script at all: every page is one document with
 * one inline `<style>` element, allowed by its SHA-256 in a strict Content Security Policy
 * (`default-src 'none'`, no script source, no framing, no form target, no base URI), so an
 * injected tag could neither run nor load anything. Every interpolated value goes through `esc`.
 */

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

/** The CSP for a page whose only active content is the given stylesheet. */
export async function contentSecurityPolicy(style: string): Promise<string> {
  return [
    "default-src 'none'",
    `style-src 'sha256-${await sha256Base64(style)}'`,
    "img-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export interface HtmlPage {
  readonly title: string;
  readonly style: string;
  readonly body: string;
  /** `Cache-Control`; `no-store` unless the page is public and static. */
  readonly cacheControl: string;
}

/** The document and its headers. */
export async function renderPage(page: HtmlPage): Promise<Response> {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(page.title)}</title>
<style>${page.style}</style>
</head>
<body>
${page.body}
</body>
</html>
`;
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': await contentSecurityPolicy(page.style),
      'cache-control': page.cacheControl,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
    },
  });
}
