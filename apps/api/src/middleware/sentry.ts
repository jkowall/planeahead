/**
 * Sentry. Second middleware, immediately after request-id.
 *
 * Two pieces, both required and both documented by Sentry:
 *
 *   - `sentry(app, options)` from `@sentry/hono/cloudflare` gives parametrised transaction names
 *     ("GET /v1/flights/:id" rather than one transaction per id), middleware spans and Hono's
 *     error handler. Internally it calls `withSentry` on the Hono app, which replaces
 *     `app.fetch` with an instrumented proxy and patches `app.errorHandler`.
 *   - `withSentry(optionsCallback, handler)` on the default export covers `queue()` and
 *     `scheduled()`, which never go through Hono at all.
 *
 * Two things follow from that and are easy to get wrong:
 *
 *   1. `app.onError()` must be registered BEFORE this middleware. `withSentry` wraps whatever
 *      `app.errorHandler` is at the moment it runs; a later `app.onError()` overwrites the
 *      wrapper and Sentry stops seeing handled route errors.
 *   2. The default export's `fetch` must be `app.fetch` itself, not a wrapper and not
 *      `app.fetch.bind(app)`. Sentry keys "already instrumented" off the function identity in a
 *      WeakMap, so passing the same function object makes the outer `withSentry` a no-op for
 *      fetch. Wrapping or binding it produces a second `wrapRequestHandler`, which means two
 *      clients, two `http.server` spans and two flushes for every request.
 *
 * `beforeSend` scrubs the event. It mutates and returns the event: changing the scope inside
 * `beforeSend` is a documented no-op.
 */

import { sentry } from '@sentry/hono/cloudflare';
import { httpServerIntegration, setTag } from '@sentry/cloudflare';
import type { Breadcrumb, CloudflareOptions, ErrorEvent, Event } from '@sentry/cloudflare';
import type { Hono, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { type AppBindings, type Env, environmentName } from '../env';
import { safeErrorMessage, stripQueryParams } from '../observability/log';

/** Breadcrumb data keys worth keeping on an HTTP breadcrumb. Everything else is dropped. */
const SAFE_HTTP_BREADCRUMB_KEYS = ['method', 'url', 'status_code', 'reason'] as const;

/**
 * The webhook receivers authenticate by a token in the PATH (`/v1/webhooks/{provider}/{token}`,
 * src/routes/webhooks.ts), so a URL can carry a secret even without a query string.
 */
const WEBHOOK_TOKEN_PATH_RE = /(\/v1\/webhooks\/[a-z]+\/)[^/?#]+/g;

export function redactWebhookToken(url: string): string {
  return url.replace(WEBHOOK_TOKEN_PATH_RE, '$1[redacted]');
}

function stripQuery(url: string): string {
  const cut = Math.min(
    url.includes('?') ? url.indexOf('?') : url.length,
    url.includes('#') ? url.indexOf('#') : url.length,
  );
  return redactWebhookToken(url.slice(0, cut));
}

/**
 * Span attributes that carry request content rather than request shape.
 *
 * `http.request.body.data` comes from @sentry/core's request-data integration, which hardcodes
 * `data: true` ("Always attach body data that's already on the scope"). `url.query` and the query
 * half of `url.full` come from `getHttpSpanDetailsFromUrlObject`, and neither is gated on
 * `sendDefaultPii`. Every `http.request.header.*` attribute is dropped by prefix.
 */
const SENSITIVE_SPAN_ATTRIBUTES: ReadonlySet<string> = new Set([
  'http.request.body.data',
  'url.query',
]);

/** Attributes that hold a whole URL, and therefore a query string. */
const URL_SPAN_ATTRIBUTES: ReadonlySet<string> = new Set(['url.full', 'http.url']);

function scrubSpanAttributes(data: Record<string, unknown>): void {
  for (const key of Object.keys(data)) {
    if (SENSITIVE_SPAN_ATTRIBUTES.has(key) || key.startsWith('http.request.header.')) {
      delete data[key];
      continue;
    }
    const value: unknown = data[key];
    if (URL_SPAN_ATTRIBUTES.has(key) && typeof value === 'string') {
      data[key] = stripQuery(value);
    }
  }
}

function scrubBreadcrumb(breadcrumb: Breadcrumb): void {
  if (breadcrumb.data === undefined) {
    return;
  }
  if (breadcrumb.category !== 'http' && breadcrumb.category !== 'fetch') {
    // Console and custom breadcrumbs can carry anything the call site passed.
    delete breadcrumb.data;
    return;
  }
  const kept: Record<string, unknown> = {};
  for (const key of SAFE_HTTP_BREADCRUMB_KEYS) {
    const value: unknown = breadcrumb.data[key];
    if (value !== undefined) {
      kept[key] = typeof value === 'string' && key === 'url' ? stripQuery(value) : value;
    }
  }
  breadcrumb.data = kept;
}

/**
 * Removes headers, cookies, bodies, query strings and bound query parameters from an event
 * before it leaves the Worker.
 *
 * Headers carry `Authorization`, `Cookie` and `Idempotency-Key`; request bodies carry magic link
 * tokens and Apple identity tokens; query strings carry whatever a client put there; a failed
 * statement's message carries every value the request bound into it. None of it is needed to
 * debug a stack trace, and `sendDefaultPii: false` alone does not remove any of it.
 *
 * Generic over the event type on purpose. `beforeSend` only ever sees ERROR events: Sentry's
 * client dispatches transaction events to `beforeSendTransaction` instead, so a scrubber wired
 * only to `beforeSend` never sees the transaction that carries the same request data. Both
 * callbacks in `sentryOptions` call this one function.
 */
export function scrubSentryEvent<T extends Event>(event: T): T {
  if (typeof event.transaction === 'string') {
    event.transaction = redactWebhookToken(event.transaction);
  }
  const request = event.request;
  if (request !== undefined) {
    delete request.headers;
    delete request.cookies;
    delete request.data;
    delete request.query_string;
    if (typeof request.url === 'string') {
      request.url = stripQuery(request.url);
    }
  }

  const response = event.contexts?.response;
  if (response !== undefined) {
    delete response.headers;
    delete response.cookies;
    delete response.body;
  }

  // Span attributes, which are a second copy of the request that `event.request` never covers. A
  // transaction event carries the SEGMENT span's attributes in `contexts.trace.data` and every
  // child span's in `spans[].data`. Scrubbing only `event.request` left the query string (and,
  // before `maxRequestBodySize: 'none'`, the body) on the transaction: an end-to-end test through
  // the real chain is what found it, because a hand-built event does not have these fields.
  const traceData = event.contexts?.trace?.data;
  if (traceData !== undefined) {
    scrubSpanAttributes(traceData);
  }
  for (const span of event.spans ?? []) {
    if (span.data !== undefined) {
      scrubSpanAttributes(span.data);
    }
  }

  for (const breadcrumb of event.breadcrumbs ?? []) {
    // A console breadcrumb's message is whatever was logged, which for a failed query written
    // by anything outside `errorFields` (a library's own console.error) is the statement AND
    // its bound values. The values go; the statement stays.
    if (typeof breadcrumb.message === 'string') {
      breadcrumb.message = stripQueryParams(breadcrumb.message);
    }
    scrubBreadcrumb(breadcrumb);
  }

  // The exception value is `error.message` as the SDK serialised it, not what `errorFields`
  // logged, so a DrizzleQueryError's `params:` tail would ride out here untouched. Same cut and
  // the same length cap as the log line; the stack frames are unaffected.
  for (const exception of event.exception?.values ?? []) {
    if (typeof exception.value === 'string') {
      exception.value = safeErrorMessage(exception.value);
    }
  }

  return event;
}

/**
 * `@sentry/hono` does not re-export its own `HonoCloudflareOptions`, and the extra members it
 * adds on top of `CloudflareOptions` are all optional, so the Cloudflare options type is what
 * both `sentry()` and `withSentry()` are given. Using one type for both is what keeps the two
 * registrations configured identically.
 */
export function sentryOptions(
  env: Env,
  /** Test seam. The suite injects a capturing transport and a DSN so events are observable. */
  overrides: Partial<CloudflareOptions> = {},
): CloudflareOptions {
  const environment = environmentName(env);
  return {
    // No DSN means the SDK initialises and drops every event, which is what local and test want.
    ...(env.SENTRY_DSN === undefined ? {} : { dsn: env.SENTRY_DSN }),
    environment,
    // Already the default, and deprecated in favour of `dataCollection`. Kept explicit so that an
    // auditor reading this file does not have to know Sentry's defaults, and so that a future
    // upgrade that flips the default is a visible diff rather than a silent change of behaviour.
    // The `dataCollection` shape is not documented on the Cloudflare options page yet; ADR 0004
    // records that the migration target is unsettled.
    sendDefaultPii: false,
    // `sendDefaultPii: false` does NOT stop request body capture. @sentry/cloudflare puts
    // `httpServerIntegration()` in its defaults with `maxRequestBodySize: 'medium'`, and
    // `wrapRequestHandler` reads the body of every non-GET request into the isolation scope
    // before the handler runs. Turning the capture off at the source is the only fix that holds
    // for every event type; scrubbing afterwards only covers the shapes the scrubber knows about.
    // Increment 4 has no use for a request body in Sentry, and increments 5 and 6 post Apple
    // identity tokens and magic link tokens through these routes.
    integrations: (defaults) => [
      ...defaults.filter((integration) => integration.name !== 'HttpServer'),
      httpServerIntegration({ maxRequestBodySize: 'none' }),
    ],
    tracesSampleRate: environment === 'production' ? 0.1 : 1,
    // Two callbacks, one scrubber. Sentry's client routes ERROR events to `beforeSend` and
    // TRANSACTION events to `beforeSendTransaction`; with only the first one configured, every
    // transaction event left the Worker unscrubbed.
    beforeSend: (event: ErrorEvent) => scrubSentryEvent(event),
    beforeSendTransaction: (event) => scrubSentryEvent(event),
    ...overrides,
  };
}

/**
 * The Sentry middleware plus the request id tag, as one registration so the chain reads in the
 * order the plan states. The tag is set here rather than inside `beforeSend`, because
 * `beforeSend` runs on the event and has no access to the Hono context.
 */
export function sentryMiddleware(
  app: Hono<AppBindings>,
  /** Test seam, forwarded to `sentryOptions`. */
  overrides: Partial<CloudflareOptions> = {},
): MiddlewareHandler<AppBindings> {
  const inner = sentry(app, (env: Env) => sentryOptions(env, overrides));
  return createMiddleware<AppBindings>(async (c, next) => {
    setTag('request_id', c.var.requestId);
    return inner(c, next);
  });
}
