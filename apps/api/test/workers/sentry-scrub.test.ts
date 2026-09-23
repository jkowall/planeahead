/**
 * What leaves the Worker for Sentry.
 *
 * Not in the increment 4 spec's test list, and here anyway: this is the boundary where a mistake
 * ships user data to a third party, and `sendDefaultPii: false` does not close it on its own.
 *
 * Two layers, and the second one exists because the first is not enough:
 *
 *   - unit tests over `scrubSentryEvent` and `sentryOptions`, on events the test builds by hand.
 *     Cheap, exhaustive over the shapes the scrubber knows about, and blind to every shape it
 *     does not. That blindness was a real defect: `beforeSend` receives ERROR events only,
 *     Sentry's client dispatches transaction events to `beforeSendTransaction`, and the request
 *     body rode out on the transaction while these tests stayed green.
 *   - an end-to-end test that drives a real request through the real chain with a capturing
 *     transport and asserts on the SERIALISED envelope bytes. Asserting on bytes rather than on
 *     named fields is what makes it survive an SDK upgrade that moves where headers are attached.
 *
 * `beforeSend` must MUTATE and return the event; changing the scope inside it is a documented
 * no-op. The unit tests assert on the returned object and on identity.
 */

import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { CloudflareOptions, ErrorEvent, Event } from '@sentry/cloudflare';
import { createApp } from '../../src/app';
import { scrubSentryEvent, sentryOptions } from '../../src/middleware/sentry';
import type { Env } from '../../src/env';
import { REQUEST_ID_HEADER } from '../../src/middleware/request-id';

function eventWith(overrides: Partial<ErrorEvent>): ErrorEvent {
  return { type: undefined, ...overrides };
}

describe('scrubSentryEvent', () => {
  it('removes request headers, cookies, body and query string', () => {
    const event = eventWith({
      request: {
        url: 'https://api.planeahead.app/v1/flights?token=secret&number=AA100',
        method: 'POST',
        headers: { authorization: 'Bearer abc', cookie: 'session=xyz' },
        cookies: { session: 'xyz' },
        data: { email: 'someone@example.com' },
        query_string: 'token=secret',
      },
    });

    const scrubbed = scrubSentryEvent(event);

    expect(scrubbed.request?.headers).toBeUndefined();
    expect(scrubbed.request?.cookies).toBeUndefined();
    expect(scrubbed.request?.data).toBeUndefined();
    expect(scrubbed.request?.query_string).toBeUndefined();
    expect(scrubbed.request?.url).toBe('https://api.planeahead.app/v1/flights');
    // The method survives: it is not sensitive and it is the whole point of the event.
    expect(scrubbed.request?.method).toBe('POST');
  });

  it('mutates and returns the same object', () => {
    const event = eventWith({ request: { url: 'https://api.planeahead.app/health' } });

    expect(scrubSentryEvent(event)).toBe(event);
  });

  it('removes response headers, cookies and body', () => {
    const event = eventWith({
      contexts: {
        response: {
          status_code: 500,
          headers: { 'set-cookie': 'session=xyz' },
          cookies: { session: 'xyz' },
          body: { error: 'internal_error' },
        },
      },
    });

    const scrubbed = scrubSentryEvent(event);

    expect(scrubbed.contexts?.response?.headers).toBeUndefined();
    expect(scrubbed.contexts?.response?.cookies).toBeUndefined();
    expect(scrubbed.contexts?.response?.body).toBeUndefined();
    expect(scrubbed.contexts?.response?.['status_code']).toBe(500);
  });

  it('removes request body, header and query attributes from the segment span', () => {
    // @sentry/core's request-data integration hardcodes `data: true` and writes the serialised
    // body to `http.request.body.data` on the segment span, and
    // `getHttpSpanDetailsFromUrlObject` writes `url.query` and a `url.full` that still carries
    // the query string. A transaction event carries the segment span's attributes in
    // `contexts.trace.data`, which is a place `event.request` never reaches, so the scrubber has
    // to know about it too.
    const event: Event = {
      type: 'transaction',
      contexts: {
        trace: {
          span_id: 'abc',
          trace_id: 'def',
          data: {
            'http.request.body.data': '{"identityToken":"APPLE_IDENTITY_TOKEN"}',
            'http.request.header.authorization': 'Bearer abc',
            'http.request.header.cookie': 'session=xyz',
            'url.query': '?token=secret',
            'url.full': 'https://api.planeahead.app/v1/flights?token=secret',
            'http.request.method': 'POST',
            'http.response.status_code': 500,
          },
        },
      },
    };

    const traceData = scrubSentryEvent(event).contexts?.trace?.data;

    expect(traceData).toEqual({
      'url.full': 'https://api.planeahead.app/v1/flights',
      'http.request.method': 'POST',
      'http.response.status_code': 500,
    });
  });

  it('scrubs child span attributes as well as the segment span', () => {
    const event = {
      type: 'transaction',
      spans: [
        {
          span_id: 'child',
          trace_id: 'def',
          start_timestamp: 0,
          timestamp: 1,
          data: {
            'url.full': 'https://aerodatabox.example/flights/AA100?key=secret',
            'http.request.header.x-rapidapi-key': 'secret',
            'sentry.op': 'http.client',
          },
        },
      ],
    } as unknown as Event;

    const scrubbed = scrubSentryEvent(event);

    expect(scrubbed.spans?.[0]?.data).toEqual({
      'url.full': 'https://aerodatabox.example/flights/AA100',
      'sentry.op': 'http.client',
    });
  });

  it('keeps only the safe keys on an http breadcrumb and strips its query string', () => {
    const event = eventWith({
      breadcrumbs: [
        {
          category: 'fetch',
          data: {
            method: 'GET',
            url: 'https://aerodatabox.p.rapidapi.com/flights/AA100?key=secret',
            status_code: 200,
            reason: 'OK',
            request_body: 'do not send me',
            'X-RapidAPI-Key': 'secret',
          },
        },
      ],
    });

    const scrubbed = scrubSentryEvent(event);
    const data = scrubbed.breadcrumbs?.[0]?.data;

    expect(data).toEqual({
      method: 'GET',
      url: 'https://aerodatabox.p.rapidapi.com/flights/AA100',
      status_code: 200,
      reason: 'OK',
    });
  });

  it('drops the data of a console or custom breadcrumb entirely', () => {
    const event = eventWith({
      breadcrumbs: [
        { category: 'console', data: { arguments: ['token', 'abc123'] } },
        { category: 'custom.provider', data: { apiKey: 'abc123' } },
        { category: 'navigation' },
      ],
    });

    const scrubbed = scrubSentryEvent(event);

    expect(scrubbed.breadcrumbs?.[0]?.data).toBeUndefined();
    expect(scrubbed.breadcrumbs?.[1]?.data).toBeUndefined();
    expect(scrubbed.breadcrumbs?.[2]?.data).toBeUndefined();
  });

  it('handles an event with nothing to scrub', () => {
    const event = eventWith({ message: 'something happened' });

    expect(scrubSentryEvent(event)).toEqual({ type: undefined, message: 'something happened' });
  });
});

describe('sentryOptions', () => {
  function optionsFor(environment: string, dsn?: string): CloudflareOptions {
    return sentryOptions({
      ENVIRONMENT: environment,
      ...(dsn === undefined ? {} : { SENTRY_DSN: dsn }),
    } as Env);
  }

  it('keeps sendDefaultPii explicitly false', () => {
    expect(optionsFor('production').sendDefaultPii).toBe(false);
  });

  it('omits the dsn entirely when the secret is unset, rather than passing undefined', () => {
    expect('dsn' in optionsFor('local')).toBe(false);
    expect(optionsFor('local', 'https://key@sentry.example/1').dsn).toBe(
      'https://key@sentry.example/1',
    );
  });

  it('samples traces at 10 percent in production and fully everywhere else', () => {
    expect(optionsFor('production').tracesSampleRate).toBe(0.1);
    expect(optionsFor('staging').tracesSampleRate).toBe(1);
    expect(optionsFor('test').tracesSampleRate).toBe(1);
  });

  it('falls back to local for an environment name nothing recognises', () => {
    expect(optionsFor('nonsense').environment).toBe('local');
  });

  it('wires the scrubber in as beforeSend', () => {
    const event = { request: { url: 'https://api.planeahead.app/x?token=1' } } as ErrorEvent;

    const result = optionsFor('staging').beforeSend?.(event, {});

    expect(result).toBe(event);
    expect(event.request?.url).toBe('https://api.planeahead.app/x');
  });

  it('wires the same scrubber in as beforeSendTransaction', () => {
    // The half that was missing. `beforeSend` is only ever called for ERROR events; a transaction
    // event carrying the same request data goes to `beforeSendTransaction`, and with that unset
    // it left the Worker untouched.
    const event = {
      type: 'transaction',
      request: { url: 'https://api.planeahead.app/x?token=1', data: 'secret body' },
    } as Event;

    const result = optionsFor('staging').beforeSendTransaction?.(
      event as Parameters<NonNullable<CloudflareOptions['beforeSendTransaction']>>[0],
      {},
    );

    expect(result).toBe(event);
    expect(event.request?.data).toBeUndefined();
    expect(event.request?.url).toBe('https://api.planeahead.app/x');
  });

  it('turns request body capture off at the source', () => {
    // `sendDefaultPii: false` does NOT stop it: @sentry/cloudflare puts `httpServerIntegration()`
    // in its defaults with `maxRequestBodySize: 'medium'`, and `wrapRequestHandler` reads the
    // body of every non-GET request into the isolation scope before the handler runs. Scrubbing
    // afterwards only covers the event shapes the scrubber knows about; not capturing covers all
    // of them.
    const build = optionsFor('staging').integrations;
    expect(typeof build).toBe('function');
    if (typeof build !== 'function') {
      return;
    }

    const defaults = [
      { name: 'HttpServer', options: { maxRequestBodySize: 'medium' } },
      { name: 'RequestData' },
    ] as unknown as Parameters<typeof build>[0];
    const result = build(defaults);
    const httpServer = result.filter((integration) => integration.name === 'HttpServer');

    expect(httpServer).toHaveLength(1);
    // The default instance is replaced, not kept alongside a second one.
    expect(httpServer[0]).not.toBe(defaults[0]);
    expect(result.some((integration) => integration.name === 'RequestData')).toBe(true);
  });
});

describe('a real request through the real chain', () => {
  /** The chain, with a DSN and a transport that keeps every envelope instead of sending it. */
  function capturingApp(): { app: ReturnType<typeof createApp>; envelopes: unknown[] } {
    const envelopes: unknown[] = [];
    const app = createApp({
      sentry: {
        dsn: 'https://publickey@o0.ingest.sentry.example/0',
        transport: () => ({
          send: (envelope: unknown) => {
            envelopes.push(envelope);
            return Promise.resolve({});
          },
          flush: () => Promise.resolve(true),
        }),
      },
    });
    return { app, envelopes };
  }

  const AUTH_SECRET = 'SENTRY_TEST_BEARER_VALUE';
  const COOKIE_SECRET = 'SENTRY_TEST_COOKIE_VALUE';
  const BODY_SECRET = 'SENTRY_TEST_APPLE_IDENTITY_TOKEN';
  const BODY_EMAIL = 'sentry-test-caller@example.invalid';

  async function driveAThrowingRoute(message: string): Promise<{
    requestId: string | null;
    status: number;
    serialised: string;
    envelopes: unknown[];
  }> {
    const { app, envelopes } = capturingApp();
    app.post('/explode', () => {
      throw new Error(message);
    });

    const ctx = createExecutionContext();
    const response = await app.fetch(
      new Request('https://api.planeahead.test/explode?token=QUERY_SECRET', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${AUTH_SECRET}`,
          cookie: `session=${COOKIE_SECRET}`,
          'content-type': 'application/json',
          'idempotency-key': 'sentry-key-00001',
          'x-install-id': 'sentry-install-00001',
        },
        body: JSON.stringify({ email: BODY_EMAIL, identityToken: BODY_SECRET }),
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    return {
      requestId: response.headers.get(REQUEST_ID_HEADER),
      status: response.status,
      serialised: JSON.stringify(envelopes),
      envelopes,
    };
  }

  it('reports the error at all, tagged with the request id the caller was given', async () => {
    const { status, requestId, serialised, envelopes } = await driveAThrowingRoute('kaboom-one');

    expect(status).toBe(500);
    expect(envelopes.length).toBeGreaterThan(0);
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    // The tag is set by `sentryMiddleware`, not by `beforeSend`, and nothing else proves the two
    // registrations (the Hono middleware and `withSentry` on the default export) are talking to
    // the same client.
    expect(serialised).toContain(`"request_id":"${requestId ?? ''}"`);
    expect(serialised).toContain('kaboom-one');
  });

  it('sends both an error event and a transaction, so the transaction path is covered', async () => {
    // If the SDK ever stops emitting one of these, the assertions below would pass vacuously.
    const { serialised } = await driveAThrowingRoute('kaboom-two');

    expect(serialised).toContain('{"type":"event"}');
    expect(serialised).toContain('{"type":"transaction"}');
  });

  it('carries no header, cookie, body or query value in any envelope', async () => {
    const { serialised } = await driveAThrowingRoute('kaboom-three');

    for (const secret of [AUTH_SECRET, COOKIE_SECRET, BODY_SECRET, BODY_EMAIL, 'QUERY_SECRET']) {
      expect(serialised).not.toContain(secret);
    }
    expect(serialised.toLowerCase()).not.toContain('sentry-key-00001');
    // Named fields as well as the raw bytes, so a failure says which mechanism regressed.
    expect(serialised).not.toContain('http.request.body.data');
    expect(serialised).not.toContain('http.request.header.');
    expect(serialised).not.toContain('url.query');
  });
});
