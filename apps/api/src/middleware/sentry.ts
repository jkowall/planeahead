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
import { setTag } from '@sentry/cloudflare';
import type { Breadcrumb, CloudflareOptions, ErrorEvent } from '@sentry/cloudflare';
import type { Hono, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { type AppBindings, type Env, environmentName } from '../env';

/** Breadcrumb data keys worth keeping on an HTTP breadcrumb. Everything else is dropped. */
const SAFE_HTTP_BREADCRUMB_KEYS = ['method', 'url', 'status_code', 'reason'] as const;

function stripQuery(url: string): string {
  const cut = Math.min(
    url.includes('?') ? url.indexOf('?') : url.length,
    url.includes('#') ? url.indexOf('#') : url.length,
  );
  return url.slice(0, cut);
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
 * Removes headers, cookies, bodies and query strings from an event before it leaves the Worker.
 *
 * Headers carry `Authorization`, `Cookie` and `Idempotency-Key`; request bodies carry magic link
 * tokens and Apple identity tokens; query strings carry whatever a client put there. None of it
 * is needed to debug a stack trace, and `sendDefaultPii: false` alone does not remove all of it.
 */
export function scrubSentryEvent(event: ErrorEvent): ErrorEvent {
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

  for (const breadcrumb of event.breadcrumbs ?? []) {
    scrubBreadcrumb(breadcrumb);
  }

  return event;
}

/**
 * `@sentry/hono` does not re-export its own `HonoCloudflareOptions`, and the extra members it
 * adds on top of `CloudflareOptions` are all optional, so the Cloudflare options type is what
 * both `sentry()` and `withSentry()` are given. Using one type for both is what keeps the two
 * registrations configured identically.
 */
export function sentryOptions(env: Env): CloudflareOptions {
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
    tracesSampleRate: environment === 'production' ? 0.1 : 1,
    beforeSend: (event: ErrorEvent) => scrubSentryEvent(event),
  };
}

/**
 * The Sentry middleware plus the request id tag, as one registration so the chain reads in the
 * order the plan states. The tag is set here rather than inside `beforeSend`, because
 * `beforeSend` runs on the event and has no access to the Hono context.
 */
export function sentryMiddleware(app: Hono<AppBindings>): MiddlewareHandler<AppBindings> {
  const inner = sentry(app, (env: Env) => sentryOptions(env));
  return createMiddleware<AppBindings>(async (c, next) => {
    setTag('request_id', c.var.requestId);
    return inner(c, next);
  });
}
