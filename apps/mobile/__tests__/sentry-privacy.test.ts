/**
 * Sentry's privacy configuration (docs/increments/09 acceptance, ruling P8): `Sentry.init` gets
 * `sendDefaultPii: false` and no replay, and `beforeSend`, `beforeSendTransaction` and
 * `beforeBreadcrumb` strip the magic-link token from URLs, query strings and `Referer`.
 */

import * as Sentry from '@sentry/react-native';
import type { Breadcrumb, ErrorEvent, TransactionEvent } from '@sentry/react-native';
import { initSentry, scrubText, scrubUrl, sentryOptions } from '../src/lib/sentry';

const TOKEN = 'mAgIcLiNkToKeNmAgIcLiNkToKeN1234';
const LANDING = `https://api.planeahead.app/auth/magic-link?token=${TOKEN}`;
const VERIFY = `https://api.planeahead.app/api/auth/magic-link/verify?token=${TOKEN}`;
const APP_LINK = `planeahead://auth/magic-link?token=${TOKEN}#frag`;

type Options = ReturnType<typeof sentryOptions>;

function initialisedOptions(): Options {
  initSentry({ dsn: 'https://public@o0.ingest.sentry.io/0', environment: 'development' });
  const init = jest.mocked(Sentry.init);
  expect(init).toHaveBeenCalledTimes(1);
  const options = init.mock.calls[0]?.[0];
  if (options === undefined) {
    throw new Error('Sentry.init was not called with options');
  }
  return options;
}

function hint() {
  return {};
}

describe('Sentry.init', () => {
  const options = initialisedOptions();

  it('sends no default PII', () => {
    expect(options.sendDefaultPii).toBe(false);
  });

  it('configures no session replay at all', () => {
    // The SDK installs its replay integration when EITHER rate is a number, zero included.
    expect(options.replaysSessionSampleRate).toBeUndefined();
    expect(options.replaysOnErrorSampleRate).toBeUndefined();
    expect(options._experiments?.replaysSessionSampleRate).toBeUndefined();
    expect(options._experiments?.replaysOnErrorSampleRate).toBeUndefined();
    const integrations = options.integrations;
    expect(typeof integrations).toBe('function');
    if (typeof integrations !== 'function') {
      throw new Error('integrations must be a filter function');
    }
    const defaults = [{ name: 'Breadcrumbs' }, { name: 'MobileReplay' }, { name: 'Replay' }];
    expect(
      integrations(defaults as Parameters<typeof integrations>[0]).map((entry) => entry.name),
    ).toEqual(['Breadcrumbs']);
  });

  it('attaches no screenshots or view hierarchy and records no performance data', () => {
    expect(options.attachScreenshot).toBe(false);
    expect(options.attachViewHierarchy).toBe(false);
    expect(options.tracesSampleRate).toBeUndefined();
    expect(options.enableAutoPerformanceTracing).toBe(false);
  });

  it('stays disabled without a DSN', () => {
    expect(sentryOptions({ dsn: null, environment: 'development' }).enabled).toBe(false);
  });

  it('beforeSend strips the token from the request URL, query string, Referer and cookies', () => {
    const event: ErrorEvent = {
      type: undefined,
      message: `could not open ${LANDING}`,
      request: {
        url: VERIFY,
        query_string: `token=${TOKEN}`,
        cookies: { 'better-auth.session_token': 'secret-session' },
        headers: {
          Referer: LANDING,
          Cookie: 'better-auth.session_token=secret-session',
          Accept: 'application/json',
        },
      },
      exception: {
        values: [{ type: 'TypeError', value: `Network request failed for ${VERIFY}` }],
      },
      breadcrumbs: [
        { category: 'fetch', data: { url: VERIFY, method: 'GET', status_code: 200 } },
        { category: 'navigation', data: { from: '/', to: APP_LINK } },
      ],
      extra: { lastLink: APP_LINK, nested: { deeper: { token: TOKEN } } },
    };

    const scrubbed = options.beforeSend?.(event, hint());
    const serialised = JSON.stringify(scrubbed);
    expect(serialised).not.toContain(TOKEN);
    expect(serialised).not.toContain('secret-session');
    expect(scrubbed).toMatchObject({
      request: {
        url: 'https://api.planeahead.app/api/auth/magic-link/verify',
        headers: { Accept: 'application/json' },
      },
    });
    const request = (scrubbed as ErrorEvent).request;
    expect(request?.query_string).toBeUndefined();
    expect(request?.cookies).toBeUndefined();
    expect(request?.headers).not.toHaveProperty('Referer');
    expect(request?.headers).not.toHaveProperty('Cookie');
  });

  it('beforeSendTransaction scrubs the same way', () => {
    const transaction: TransactionEvent = {
      type: 'transaction',
      transaction: `GET ${VERIFY}`,
      request: { url: LANDING, headers: { referer: LANDING } },
      contexts: { trace: { trace_id: 'a', span_id: 'b', data: { 'url.full': VERIFY } } },
    };
    const scrubbed = options.beforeSendTransaction?.(transaction, hint());
    expect(JSON.stringify(scrubbed)).not.toContain(TOKEN);
  });

  it('beforeBreadcrumb strips the token from fetch URLs, navigation targets and console text', () => {
    const crumbs: Breadcrumb[] = [
      { category: 'fetch', type: 'http', data: { url: VERIFY, method: 'GET' } },
      { category: 'xhr', type: 'http', data: { url: LANDING } },
      {
        category: 'navigation',
        data: { from: '/sign-in', to: APP_LINK, params: { token: TOKEN } },
      },
      {
        category: 'console',
        message: `opened ${APP_LINK} from mail`,
        data: { arguments: [LANDING] },
      },
      { category: 'http', data: { url: VERIFY, request_headers: { Referer: LANDING } } },
    ];
    for (const crumb of crumbs) {
      const scrubbed = options.beforeBreadcrumb?.(crumb, hint());
      expect(JSON.stringify(scrubbed)).not.toContain(TOKEN);
    }
    expect(options.beforeBreadcrumb?.(crumbs[0] as Breadcrumb, hint())).toMatchObject({
      data: { url: 'https://api.planeahead.app/api/auth/magic-link/verify', method: 'GET' },
    });
  });
});

describe('the scrubbers', () => {
  it('scrubUrl drops the query and the fragment and nothing else', () => {
    expect(scrubUrl(APP_LINK)).toBe('planeahead://auth/magic-link');
    expect(scrubUrl('https://api.planeahead.app/v1/flights')).toBe(
      'https://api.planeahead.app/v1/flights',
    );
  });

  it('scrubText handles URLs inside prose and a bare token= pair', () => {
    expect(scrubText(`see ${LANDING} now`)).toBe(
      'see https://api.planeahead.app/auth/magic-link now',
    );
    expect(scrubText(`token=${TOKEN}&x=1`)).not.toContain(TOKEN);
  });
});
