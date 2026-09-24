/**
 * `GET /account/delete`: the public account-deletion page (increment 12, ruling W8). Google Play
 * requires a web URL where a user can request deletion without installing the app, next to the
 * in-app path, and a disclosure of what is kept (https://support.google.com/googleplay/
 * android-developer/answer/13327111); this is the URL the Play Console's Data safety form names.
 *
 * Static and public: no session, no script, one inline stylesheet allowed by its hash in a strict
 * CSP (src/lib/html.ts), cached for an hour. The support inbox comes from the `SUPPORT_EMAIL` var.
 * The text is the deletion disclosure docs/schema-review.md section 7 records and ADR 0012 relies
 * on: everything the account owns is deleted at once by `POST /v1/me/delete` (the synchronous
 * cascade, increment 8); pseudonymous records survive (the audit log, delivery and billing
 * records, provider-call counts, the keyed hashes that let a later webhook or another device be
 * told the account is gone, the latter 400 days for sign-in identifiers and 31 for sessions);
 * Neon's history window keeps encrypted change history for up to 24 hours.
 */

import { Hono } from 'hono';
import type { AppBindings } from '../env';
import { esc, renderPage } from '../lib/html';

export const ACCOUNT_DELETE_PATH = '/account/delete';
export const DEFAULT_SUPPORT_EMAIL = 'support@planeahead.app';
const EMAIL_SHAPE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

const STYLE = `
:root { color-scheme: light dark; font: 16px/1.5 system-ui, sans-serif; }
body { margin: 0 auto; max-width: 680px; padding: 24px 16px; }
h1 { font-size: 24px; }
h2 { font-size: 18px; margin-top: 28px; }
li { margin: 4px 0; }
`;

export function supportEmail(value: unknown): string {
  return typeof value === 'string' && EMAIL_SHAPE.test(value.trim())
    ? value.trim()
    : DEFAULT_SUPPORT_EMAIL;
}

export function accountDeletePageBody(email: string): string {
  const mail = esc(email);
  const subject = encodeURIComponent('Delete my PlaneAhead account');
  return `<main>
<h1>Delete your PlaneAhead account</h1>
<p>You can delete your account, and everything it holds, at any time. Deleting it from the app
is immediate and cannot be undone.</p>

<h2>In the app</h2>
<ol>
<li>Open PlaneAhead and go to <strong>Settings</strong>.</li>
<li>Under <strong>Account</strong>, tap <strong>Delete account</strong>.</li>
<li>Confirm. Your account is deleted at once, on every device it is signed in on.</li>
</ol>
<p>This works for guest accounts too.</p>

<h2>Without the app</h2>
<p>Email <a href="mailto:${mail}?subject=${subject}">${mail}</a> from the address your account
uses and ask for the account to be deleted. We confirm by replying to that address before
anything is deleted, then delete the account within 30 days.</p>

<h2>What is deleted</h2>
<ul>
<li>Your profile, email address, name and sign-in methods (Apple, Google, email link), and every
session, on all devices.</li>
<li>The flights you follow, your trips, preferences, notification settings, devices and push
tokens, and your sync history.</li>
<li>Your encryption key, which makes anything encrypted for you unreadable.</li>
<li>Usage counters and sign-in rate-limit records tied to you or your email address.</li>
</ul>

<h2>What is kept, and why</h2>
<ul>
<li>A pseudonymous audit record that the account existed and was deleted, keyed by a random id
that is not linked to you once the account is gone (up to two years, for security and legal
obligations).</li>
<li>Records of purchases and subscriptions, keyed by a random billing id (as long as tax and
accounting law requires).</li>
<li>Delivery records of notifications we sent, keyed by the same random id (90 days).</li>
<li>Keyed, one-way hashes of your Apple or Google account id (400 days) and of your sessions (31
days), so a late message from Apple, Google or our billing provider, or another device still
signed in, is recognised as belonging to a deleted account rather than creating a new one.</li>
<li>Flight data and provider-call counts, which are about flights, not about you.</li>
</ul>
<p>Our database keeps an encrypted change history for disaster recovery for up to 24 hours, after
which deleted data cannot be restored.</p>

<p>Questions: <a href="mailto:${mail}">${mail}</a>.</p>
</main>`;
}

export const accountDeletePage = new Hono<AppBindings>().get('/delete', (c) =>
  renderPage({
    title: 'Delete your PlaneAhead account',
    style: STYLE,
    body: accountDeletePageBody(supportEmail(c.env.SUPPORT_EMAIL)),
    cacheControl: 'public, max-age=3600',
  }),
);
