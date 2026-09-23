/**
 * The provider webhook receivers through the real middleware chain: a wrong token is the app's
 * ordinary 404, the token comparison is constant time after a length check, bodies are
 * validated strictly, and a valid delivery is ENQUEUED on provider-events and nothing else (no
 * fetch, no database, no Durable Object). The AeroDataBox receiver stays shut while
 * ADB_ALERTS_ENABLED is false. The receivers are exempt from the public IP limiter (ruling I2),
 * survive a delivery that carries `Idempotency-Key`, and never let the token reach a log line or
 * a Sentry envelope, not even through an unexpected error. None of this needs the database, so
 * no test touches env.DB.
 */

import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderEventV1, RPC_SCHEMA_VERSION } from '@planeahead/shared';
import { createApp, type ChainOptions } from '../../src/app';
import type { Env } from '../../src/env';
import type { IdempotencyStore, StoredResponse } from '../../src/middleware/idempotency';
import { scrubSentryEvent } from '../../src/middleware/sentry';
import { v1Routes } from '../../src/routes/v1';
import {
  WEBHOOK_BODY_LIMIT_BYTES,
  isWellFormedWebhookToken,
  verifyPathToken,
} from '../../src/routes/webhooks';
import alertOut from '../../src/providers/fixtures/aeroapi/alert-delivery-out.json';
import alertUnknown from '../../src/providers/fixtures/aeroapi/alert-delivery-unknown-code.json';
import notification from '../../src/providers/fixtures/aerodatabox/notification.json';
import { captureLogs, logEvents } from './helpers/auth';

/** `expect.objectContaining`, typed: the matcher is `any`, which the lint rules forbid assigning. */
function containing(value: object): unknown {
  return expect.objectContaining(value) as unknown;
}

const testEnv = env as Env;
const ORIGIN = 'https://api.planeahead.test';
const AEROAPI_TOKEN = testEnv.WEBHOOK_TOKEN_AEROAPI ?? '';
const ADB_TOKEN = testEnv.WEBHOOK_TOKEN_AERODATABOX ?? '';
const OUT_BODY = JSON.stringify(alertOut.response.body);
const NOTIFICATION_BODY = JSON.stringify(notification.response.body);

/** Flips a character but keeps the length, so the length check passes and the bytes differ. */
function tamper(token: string): string {
  const last = token.at(-1) === 'A' ? 'B' : 'A';
  return `${token.slice(0, -1)}${last}`;
}

function post(path: string, body: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

interface Recorded {
  readonly sent: unknown[];
  /** Every binding or global the route touched other than the provider-events queue. */
  readonly touched: string[];
  readonly response: Response;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * The same chain the Worker runs (createApp + /v1), with an environment in which only the
 * provider-events queue works: the database, the other queues, the Durable Object namespaces and
 * `fetch` record any use, and the tests assert there was none.
 */
async function isolated(
  request: Request,
  overrides: Partial<Env> = {},
  chain: ChainOptions = {},
): Promise<Recorded> {
  const sent: unknown[] = [];
  const touched: string[] = [];
  const queue = (name: string) => ({
    send: () => {
      touched.push(`${name}.send`);
      return Promise.resolve();
    },
    sendBatch: () => {
      touched.push(`${name}.sendBatch`);
      return Promise.resolve();
    },
  });
  const namespace = (name: string) => ({
    getByName: () => {
      touched.push(`${name}.getByName`);
      throw new Error(`the webhook route touched ${name}`);
    },
    idFromName: () => {
      touched.push(`${name}.idFromName`);
      throw new Error(`the webhook route touched ${name}`);
    },
  });
  const isolatedEnv = {
    ...testEnv,
    DB: {
      get connectionString(): string {
        touched.push('DB');
        throw new Error('the webhook route opened the database');
      },
    },
    PERSIST_QUEUE: queue('PERSIST_QUEUE'),
    NOTIFY_QUEUE: queue('NOTIFY_QUEUE'),
    FLIGHT_TRACKER: namespace('FLIGHT_TRACKER'),
    DESIGNATOR_RESOLVER: namespace('DESIGNATOR_RESOLVER'),
    PROVIDER_BUDGET: namespace('PROVIDER_BUDGET'),
    PROVIDER_EVENTS_QUEUE: {
      send: () => {
        touched.push('PROVIDER_EVENTS_QUEUE.send');
        return Promise.resolve();
      },
      sendBatch: (messages: Iterable<MessageSendRequest<unknown>>) => {
        for (const message of messages) {
          sent.push(message.body);
        }
        return Promise.resolve();
      },
    },
    ...overrides,
  } as unknown as Env;
  globalThis.fetch = (input: RequestInfo | URL) => {
    touched.push(`fetch ${String(input instanceof Request ? input.url : input)}`);
    return Promise.reject(new Error('the webhook route called fetch'));
  };
  try {
    const app = createApp(chain).route('/v1', v1Routes);
    const ctx = createExecutionContext();
    const response = await app.fetch(request, isolatedEnv, ctx);
    await waitOnExecutionContext(ctx);
    return { sent, touched, response };
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe('path tokens', () => {
  it('are configured under test as 256-bit tokens', () => {
    expect(isWellFormedWebhookToken(AEROAPI_TOKEN)).toBe(true);
    expect(isWellFormedWebhookToken(ADB_TOKEN)).toBe(true);
    expect(AEROAPI_TOKEN).not.toBe(ADB_TOKEN);
    expect(isWellFormedWebhookToken('a'.repeat(64))).toBe(true);
    expect(isWellFormedWebhookToken('short')).toBe(false);
    expect(isWellFormedWebhookToken(undefined)).toBe(false);
  });

  it('are compared in constant time, and only after the lengths agree', () => {
    const calls: [Uint8Array, Uint8Array][] = [];
    const spy = (a: Uint8Array, b: Uint8Array): boolean => {
      calls.push([a, b]);
      return a.every((byte, index) => byte === b[index]);
    };
    expect(verifyPathToken(AEROAPI_TOKEN, AEROAPI_TOKEN, spy)).toBe(true);
    expect(verifyPathToken(tamper(AEROAPI_TOKEN), AEROAPI_TOKEN, spy)).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls.every(([a, b]) => a.byteLength === b.byteLength)).toBe(true);
    // A different length never reaches the comparison (crypto.subtle.timingSafeEqual would throw).
    expect(verifyPathToken(`${AEROAPI_TOKEN}x`, AEROAPI_TOKEN, spy)).toBe(false);
    expect(verifyPathToken('', AEROAPI_TOKEN, spy)).toBe(false);
    // An unconfigured or malformed configured token never matches, not even itself.
    expect(verifyPathToken('short', 'short', spy)).toBe(false);
    expect(verifyPathToken('', undefined, spy)).toBe(false);
    expect(calls).toHaveLength(2);
    // The default comparator is crypto.subtle.timingSafeEqual.
    expect(verifyPathToken(AEROAPI_TOKEN, AEROAPI_TOKEN)).toBe(true);
    expect(verifyPathToken(tamper(AEROAPI_TOKEN), AEROAPI_TOKEN)).toBe(false);
  });
});

describe('POST /v1/webhooks/aeroapi/{token}', () => {
  it('a wrong token is the ordinary 404, never 401 or 403, and nothing is enqueued', async () => {
    const unknownRoute = await exports.default.fetch(post('/no-such-route', OUT_BODY));
    const unknownBody = await unknownRoute.json<Record<string, unknown>>();
    for (const path of [
      `/v1/webhooks/aeroapi/${tamper(AEROAPI_TOKEN)}`,
      `/v1/webhooks/aeroapi/${AEROAPI_TOKEN}x`,
      '/v1/webhooks/aeroapi/short',
      '/v1/webhooks/aeroapi',
      `/v1/webhooks/aerodatabox/${AEROAPI_TOKEN}`,
      `/v1/webhooks/flightradar/${AEROAPI_TOKEN}`,
    ]) {
      const { response, sent } = await isolated(post(path, OUT_BODY));
      expect(response.status, path).toBe(404);
      const body = await response.json<Record<string, unknown>>();
      expect(Object.keys(body).sort(), path).toEqual(Object.keys(unknownBody).sort());
      expect(body['error']).toBe('not_found');
      expect(sent).toEqual([]);
    }
    expect(unknownRoute.status).toBe(404);
    // The right token on the wrong method is a 404 too.
    const { response } = await isolated(
      new Request(`${ORIGIN}/v1/webhooks/aeroapi/${AEROAPI_TOKEN}`, { method: 'GET' }),
    );
    expect(response.status).toBe(404);
  });

  it('the right token enqueues the parsed event on provider-events, and touches nothing else', async () => {
    const { response, sent, touched } = await isolated(
      post(`/v1/webhooks/aeroapi/${AEROAPI_TOKEN}`, OUT_BODY),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: 1 });
    expect(touched).toEqual([]);
    expect(sent).toHaveLength(1);
    const event = ProviderEventV1.parse(sent[0]);
    expect(event).toMatchObject({
      rpcVersion: RPC_SCHEMA_VERSION,
      provider: 'aeroapi',
      kind: 'out',
      flightRef: {
        providerRef: { provider: 'aeroapi', providerId: 'AAL100-1758341600-schedule-0391' },
      },
      payload: {
        source: 'aeroapi_alert',
        eventCode: 'out',
        times: containing({ actualOut: '2026-09-22T22:04:00.000Z' }),
      },
    });
    expect(event.externalId).toMatch(/^28754391:[0-9a-f]{32}$/);
  });

  it('works through the real Worker too (the route is mounted under /v1)', async () => {
    const response = await exports.default.fetch(
      post(`/v1/webhooks/aeroapi/${AEROAPI_TOKEN}`, OUT_BODY),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: 1 });
  });

  it('tolerates an event_code the spec does not list: accepted as kind unknown', async () => {
    const { response, sent } = await isolated(
      post(`/v1/webhooks/aeroapi/${AEROAPI_TOKEN}`, JSON.stringify(alertUnknown.response.body)),
    );
    expect(response.status).toBe(200);
    expect(ProviderEventV1.parse(sent[0]).kind).toBe('unknown');
  });

  it.each([
    ['not JSON', 'nope'],
    ['an empty body', ''],
    ['no alert_id', JSON.stringify({ ...alertOut.response.body, alert_id: undefined })],
    ['no flight', JSON.stringify({ ...alertOut.response.body, flight: null })],
    ['a numeric event_code', JSON.stringify({ ...alertOut.response.body, event_code: 3 })],
  ])('validates strictly: %s is 400 and nothing is enqueued', async (_label, body) => {
    const { response, sent } = await isolated(post(`/v1/webhooks/aeroapi/${AEROAPI_TOKEN}`, body));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_payload' });
    expect(sent).toEqual([]);
  });

  it('refuses a body over the limit with 413', async () => {
    const big = 'x'.repeat(WEBHOOK_BODY_LIMIT_BYTES + 1);
    const { response, sent } = await isolated(post(`/v1/webhooks/aeroapi/${AEROAPI_TOKEN}`, big));
    expect(response.status).toBe(413);
    expect(sent).toEqual([]);
  });

  it('a receiver with no well-formed token configured is shut', async () => {
    for (const token of [undefined, '', 'short']) {
      const { response } = await isolated(post(`/v1/webhooks/aeroapi/${token ?? 'x'}`, OUT_BODY), {
        WEBHOOK_TOKEN_AEROAPI: token,
      } as Partial<Env>);
      expect(response.status).toBe(404);
    }
  });

  it('a queue failure answers 503 so the provider may retry', async () => {
    const { response } = await isolated(post(`/v1/webhooks/aeroapi/${AEROAPI_TOKEN}`, OUT_BODY), {
      PROVIDER_EVENTS_QUEUE: {
        sendBatch: () => Promise.reject(new Error('queue down')),
      } as unknown as Queue,
    });
    expect(response.status).toBe(503);
  });
});

describe('the receivers in the chain', () => {
  it('are exempt from the public IP limiter (ruling I2); every other route is not', async () => {
    const limited: string[] = [];
    const refuseAll = {
      limiter: () => ({
        limit: ({ key }: { key: string }) => {
          limited.push(key);
          return Promise.resolve({ success: false });
        },
      }),
    };
    const fromProvider = { 'CF-Connecting-IP': '203.0.113.7' };
    const delivery = await isolated(
      post(`/v1/webhooks/aeroapi/${AEROAPI_TOKEN}`, OUT_BODY, fromProvider),
      {},
      refuseAll,
    );
    expect(delivery.response.status).toBe(200);
    expect(delivery.sent).toHaveLength(1);
    // A wrong token is still the plain 404, not a 429 that would confirm anything.
    const wrong = await isolated(
      post(`/v1/webhooks/aeroapi/${tamper(AEROAPI_TOKEN)}`, OUT_BODY, fromProvider),
      {},
      refuseAll,
    );
    expect(wrong.response.status).toBe(404);
    expect(limited).toEqual([]);
    const other = await isolated(post('/v1/me', '{}', fromProvider), {}, refuseAll);
    expect(other.response.status).toBe(429);
    expect(limited).toEqual(['ip:203.0.113.7']);
  });

  it('accept a delivery that carries Idempotency-Key (the middleware read the body first)', async () => {
    const stored = new Map<string, StoredResponse>();
    const store: IdempotencyStore = {
      get: (scope, key) => Promise.resolve(stored.get(`${scope}|${key}`) ?? null),
      put: (scope, key, response) => {
        stored.set(`${scope}|${key}`, response);
        return Promise.resolve();
      },
    };
    const { lines, result } = await captureLogs(() =>
      isolated(
        post(`/v1/webhooks/aeroapi/${AEROAPI_TOKEN}`, OUT_BODY, {
          'Idempotency-Key': 'delivery-key-00001',
          'X-Install-Id': 'install-id-00001',
        }),
        {},
        { idempotencyStore: () => store },
      ),
    );
    expect(result.response.status).toBe(200);
    expect(await result.response.json()).toEqual({ accepted: 1 });
    expect(result.sent).toHaveLength(1);
    expect(lines.join('\n').includes(AEROAPI_TOKEN)).toBe(false);
  });

  it('answer an unexpected failure themselves: a path-free log line, never the app error handler', async () => {
    // A mistyped binding makes the receiver's first step throw (a TypeError from the settings
    // parser), the kind of failure that used to reach app.onError and log the token-bearing path.
    const hostile = { AEROAPI_MODE: 42 } as unknown as Partial<Env>;
    const { lines, result } = await captureLogs(() =>
      isolated(post(`/v1/webhooks/aerodatabox/${ADB_TOKEN}`, NOTIFICATION_BODY), hostile),
    );
    expect(result.response.status).toBe(500);
    expect(await result.response.json()).toMatchObject({ error: 'internal_error' });
    expect(logEvents(lines, 'webhook_failed')).toHaveLength(1);
    expect(logEvents(lines, 'unhandled_error')).toEqual([]);
    expect(lines.join('\n').includes(ADB_TOKEN)).toBe(false);
  });
});

describe('POST /v1/webhooks/aerodatabox/{token}', () => {
  it('is shut while ADB_ALERTS_ENABLED is false, even with the right token', async () => {
    expect(testEnv.ADB_ALERTS_ENABLED).toBe('false');
    const response = await exports.default.fetch(
      post(`/v1/webhooks/aerodatabox/${ADB_TOKEN}`, NOTIFICATION_BODY),
    );
    expect(response.status).toBe(404);
  });

  it('when enabled, enqueues one re-read hint per notified flight', async () => {
    const enabled = { ADB_ALERTS_ENABLED: 'true' } as Partial<Env>;
    const { response, sent, touched } = await isolated(
      post(`/v1/webhooks/aerodatabox/${ADB_TOKEN}`, NOTIFICATION_BODY),
      enabled,
    );
    expect(response.status).toBe(200);
    expect(touched).toEqual([]);
    expect(sent.map((body) => ProviderEventV1.parse(body))).toEqual([
      containing({
        provider: 'aerodatabox',
        kind: 'update',
        externalId: '4d1f6c52-2d0b-4c9b-9a55-0c1f5b8e2a71:0',
        flightRef: { designator: 'AA100', dateLocal: '2026-09-22' },
        payload: containing({ hint: 'reread' }),
      }),
    ]);
    const wrong = await isolated(
      post(`/v1/webhooks/aerodatabox/${tamper(ADB_TOKEN)}`, NOTIFICATION_BODY),
      enabled,
    );
    expect(wrong.response.status).toBe(404);
    const invalid = await isolated(
      post(`/v1/webhooks/aerodatabox/${ADB_TOKEN}`, '{"id":"x"}'),
      enabled,
    );
    expect(invalid.response.status).toBe(400);
    // The AeroAPI token does not open the AeroDataBox receiver.
    const crossed = await isolated(
      post(`/v1/webhooks/aerodatabox/${AEROAPI_TOKEN}`, NOTIFICATION_BODY),
      enabled,
    );
    expect(crossed.response.status).toBe(404);
  });
});

describe('the token stays out of logs and Sentry', () => {
  it('no log line carries a presented or configured token', async () => {
    const { lines } = await captureLogs(async () => {
      await exports.default.fetch(post(`/v1/webhooks/aeroapi/${AEROAPI_TOKEN}`, OUT_BODY));
      await exports.default.fetch(post(`/v1/webhooks/aeroapi/${tamper(AEROAPI_TOKEN)}`, OUT_BODY));
      await exports.default.fetch(post(`/v1/webhooks/aeroapi/${AEROAPI_TOKEN}`, 'not json'));
      await exports.default.fetch(post(`/v1/webhooks/aerodatabox/${ADB_TOKEN}`, NOTIFICATION_BODY));
      return null;
    });
    const joined = lines.join('\n');
    expect(joined).toContain('webhook_accepted');
    expect(joined).toContain('webhook_rejected');
    for (const token of [AEROAPI_TOKEN, tamper(AEROAPI_TOKEN), ADB_TOKEN]) {
      expect(joined.includes(token)).toBe(false);
    }
  });

  it('a real delivery through the real chain sends Sentry no token, in any attribute', async () => {
    // @sentry/core writes the raw pathname to the span attribute `url.path`; a scrubber that knew
    // only `url.full` shipped the token on every sampled delivery. Assert on the serialised bytes.
    const envelopes: unknown[] = [];
    const { response } = await isolated(
      post(`/v1/webhooks/aeroapi/${AEROAPI_TOKEN}`, OUT_BODY),
      {},
      {
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
      },
    );
    expect(response.status).toBe(200);
    const serialised = JSON.stringify(envelopes);
    // Not vacuous: a transaction for this very request was sent, and it names the route.
    expect(envelopes.length).toBeGreaterThan(0);
    expect(serialised).toContain('/v1/webhooks/aeroapi/[redacted]');
    expect(serialised).toContain('url.path');
    expect(serialised.includes(AEROAPI_TOKEN)).toBe(false);
  });

  it('the Sentry scrubber redacts the path token from every string an event can carry', () => {
    const event = scrubSentryEvent({
      type: 'transaction',
      transaction: `POST /v1/webhooks/aeroapi/${AEROAPI_TOKEN}`,
      tags: { route: `/v1/webhooks/aeroapi/${AEROAPI_TOKEN}` },
      contexts: {
        trace: {
          span_id: 'a',
          trace_id: 'b',
          data: {
            'url.path': `/v1/webhooks/aeroapi/${AEROAPI_TOKEN}`,
            'http.target': `/v1/webhooks/aerodatabox/${ADB_TOKEN}?x=1`,
          },
        },
      },
      spans: [
        {
          span_id: 'c',
          trace_id: 'b',
          start_timestamp: 0,
          timestamp: 1,
          description: `POST /v1/webhooks/aeroapi/${AEROAPI_TOKEN}`,
          data: { 'url.path': `/v1/webhooks/aeroapi/${AEROAPI_TOKEN}` },
        },
      ],
    } as never);
    const serialised = JSON.stringify(event);
    expect(serialised.includes(AEROAPI_TOKEN)).toBe(false);
    expect(serialised.includes(ADB_TOKEN)).toBe(false);
    expect(
      (event as { contexts: { trace: { data: Record<string, string> } } }).contexts.trace.data[
        'url.path'
      ],
    ).toBe('/v1/webhooks/aeroapi/[redacted]');
  });

  it('the Sentry scrubber redacts the path token from URLs and the transaction name', () => {
    const event = scrubSentryEvent({
      transaction: `POST /v1/webhooks/aeroapi/${AEROAPI_TOKEN}`,
      request: { url: `${ORIGIN}/v1/webhooks/aeroapi/${AEROAPI_TOKEN}?x=1` },
      contexts: {
        trace: { data: { 'url.full': `${ORIGIN}/v1/webhooks/aerodatabox/${ADB_TOKEN}` } },
      },
    } as never) as {
      transaction: string;
      request: { url: string };
      contexts: { trace: { data: Record<string, string> } };
    };
    expect(event.transaction).toBe('POST /v1/webhooks/aeroapi/[redacted]');
    expect(event.request.url).toBe(`${ORIGIN}/v1/webhooks/aeroapi/[redacted]`);
    expect(event.contexts.trace.data['url.full']).toBe(
      `${ORIGIN}/v1/webhooks/aerodatabox/[redacted]`,
    );
  });
});
