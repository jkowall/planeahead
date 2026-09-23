/**
 * Sentry for the app (`@sentry/react-native` ~7.11.0, Expo SDK 57's own pin).
 *
 * The opposite of Sentry's Expo quickstart on purpose (facts section 4): `sendDefaultPii: false`
 * and NO session replay. Replay is off by leaving both replay sample rates unset: the SDK adds its
 * mobile replay integration whenever either rate is a NUMBER, zero included, so `0` would still
 * install it. Any replay integration is also filtered out by name.
 *
 * With PII off the SDK still sends full outgoing URLs, query strings, `Referer` and console
 * output as breadcrumbs. The concrete exposure is the magic link: its token rides in the query of
 * `/auth/magic-link?token=...` (the universal link the app opens) and of
 * `/api/auth/magic-link/verify?token=...` (the fetch that consumes it). `beforeSend`,
 * `beforeSendTransaction` and `beforeBreadcrumb` therefore strip query strings and fragments
 * from every URL, drop `Referer`, `Cookie` and `Authorization`, and mask any `token=` left in
 * free text. `__tests__/sentry-privacy.test.ts` proves it on hand-built events.
 *
 * Source maps are uploaded by a separate CI step after `eas update`
 * (.github/workflows/mobile-preview.yml), never from the app.
 */

import * as Sentry from '@sentry/react-native';
import type { Breadcrumb, ErrorEvent, Event, TransactionEvent } from '@sentry/react-native';

const FILTERED = '[Filtered]';

/** Keys whose value is dropped wherever they appear. */
const DROPPED_KEYS: ReadonlySet<string> = new Set([
  'cookie',
  'cookies',
  'authorization',
  'referer',
  'referrer',
  'query_string',
  'set-cookie',
  'x-install-id',
  'idempotency-key',
]);

/** Keys whose value is masked wherever they appear. */
const MASKED_KEYS: ReadonlySet<string> = new Set(['token', 'rawnonce', 'identitytoken', 'nonce']);

/** Keys that carry a URL: their query and fragment are removed. */
const URL_KEYS: ReadonlySet<string> = new Set(['url', 'from', 'to', 'href', 'uri', 'referer']);

const REPLAY_INTEGRATIONS: ReadonlySet<string> = new Set([
  'MobileReplay',
  'Replay',
  'ReplayCanvas',
]);

const MAX_DEPTH = 10;

/** `https://host/path?token=x#y` becomes `https://host/path`. */
export function scrubUrl(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

/** Free text: every URL loses its query and fragment, and any `token=...` is masked. */
export function scrubText(text: string): string {
  return text
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>]*)[?#][^\s"'<>]*/gi, '$1')
    .replace(/(token|nonce)=[^&\s"'<>]+/gi, `$1=${FILTERED}`);
}

function scrubValue(value: unknown, key: string | null, depth: number): unknown {
  if (typeof value === 'string') {
    if (key !== null && URL_KEYS.has(key.toLowerCase())) {
      return scrubText(scrubUrl(value));
    }
    return scrubText(value);
  }
  if (depth >= MAX_DEPTH || value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubValue(item, null, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [entryKey, entry] of Object.entries(value)) {
    const lower = entryKey.toLowerCase();
    if (DROPPED_KEYS.has(lower)) {
      continue;
    }
    out[entryKey] = MASKED_KEYS.has(lower) ? FILTERED : scrubValue(entry, entryKey, depth + 1);
  }
  return out;
}

function scrubRecord<T extends object>(value: T): T {
  return scrubValue(value, null, 0) as T;
}

export function scrubEvent<T extends Event>(event: T): T {
  const scrubbed = scrubRecord(event);
  if (scrubbed.request !== undefined) {
    const { url, headers } = scrubbed.request;
    delete scrubbed.request.query_string;
    delete scrubbed.request.cookies;
    delete scrubbed.request.data;
    if (url !== undefined) {
      scrubbed.request.url = scrubUrl(url);
    }
    if (headers !== undefined) {
      scrubbed.request.headers = Object.fromEntries(
        Object.entries(headers).filter(([name]) => !DROPPED_KEYS.has(name.toLowerCase())),
      );
    }
  }
  return scrubbed;
}

export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  return scrubRecord(breadcrumb);
}

export interface SentryConfig {
  readonly dsn: string | null;
  readonly environment: string;
}

/** The exact options passed to `Sentry.init`; exported so the privacy test can inspect them. */
export function sentryOptions(config: SentryConfig): Sentry.ReactNativeOptions {
  return {
    ...(config.dsn === null ? { enabled: false } : { dsn: config.dsn }),
    environment: config.environment,
    sendDefaultPii: false,
    // replaysSessionSampleRate and replaysOnErrorSampleRate stay UNSET: see the file header.
    attachScreenshot: false,
    attachViewHierarchy: false,
    // No performance data in Phase 0 (no traces sample rate, no automatic spans): a transaction
    // would be a second copy of every URL. beforeSendTransaction scrubs anyway.
    enableAutoPerformanceTracing: false,
    integrations: (defaults) =>
      defaults.filter((integration) => !REPLAY_INTEGRATIONS.has(integration.name)),
    beforeSend: (event: ErrorEvent) => scrubEvent(event),
    beforeSendTransaction: (event: TransactionEvent) => scrubEvent(event),
    beforeBreadcrumb: (breadcrumb: Breadcrumb) => scrubBreadcrumb(breadcrumb),
  };
}

let initialised = false;

/** Called once at module scope of the root layout. Without a DSN the SDK stays disabled. */
export function initSentry(config: SentryConfig): void {
  if (initialised) {
    return;
  }
  initialised = true;
  Sentry.init(sentryOptions(config));
}
