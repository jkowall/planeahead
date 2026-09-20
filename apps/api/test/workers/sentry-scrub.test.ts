/**
 * `beforeSend` scrubbing.
 *
 * Not in the increment 4 spec's test list, and added anyway: this is the function that decides
 * what leaves the Worker for a third party. `sendDefaultPii: false` does not remove request
 * headers, cookies or bodies on its own, so if this scrubber quietly stops working, Authorization
 * headers, session cookies, Idempotency-Key values and magic-link tokens start arriving in
 * Sentry, and nothing else in the system would notice.
 *
 * `beforeSend` must MUTATE and return the event; changing the scope inside it is a documented
 * no-op. The tests assert on the returned object and on identity.
 */

import { describe, expect, it } from 'vitest';
import type { ErrorEvent } from '@sentry/cloudflare';
import { scrubSentryEvent, sentryOptions } from '../../src/middleware/sentry';
import type { Env } from '../../src/env';

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
  function optionsFor(environment: string, dsn?: string) {
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
});
