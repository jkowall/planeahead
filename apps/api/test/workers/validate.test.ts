/**
 * The shared validator helper (increment 8, ruling K9). An un-hooked `zValidator` answers a
 * failure with the raw Zod `safeParse` object; every route now validates through
 * `src/lib/validate.ts`, whose hook answers 400 `validation_failed` with flattened issues and
 * the request id. The two increment 5 routes moved onto it are checked through the real Worker.
 */

import { env } from 'cloudflare:workers';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { ApiErrorSchema } from '@planeahead/shared';
import { createApp } from '../../src/app';
import { queryValue } from '../../src/lib/validate';
import { REQUEST_ID_HEADER } from '../../src/middleware/request-id';
import {
  API_ORIGIN,
  APP_ORIGIN,
  jsonRequest,
  registerDevice,
  signInAnonymously,
  worker,
} from './helpers/auth';

interface Envelope {
  readonly error: string;
  readonly message: string;
  readonly issues: { path: (string | number)[]; message: string; code?: string }[];
  readonly requestId: string;
  readonly success?: unknown;
}

describe('validation failures answer the PlaneAhead envelope', () => {
  it('on PATCH /v1/me/preferences', async () => {
    const session = await signInAnonymously();

    const response = await worker(
      jsonRequest('/v1/me/preferences', 'PATCH', { distanceUnit: 'furlongs' }, session),
    );
    const body = await response.json<Envelope>();

    expect(response.status).toBe(400);
    expect(body.error).toBe('validation_failed');
    expect(body.success).toBeUndefined();
    expect(body.issues[0]?.path).toEqual(['distanceUnit']);
    expect(body.requestId).toBe(response.headers.get(REQUEST_ID_HEADER));
  });

  it('on POST /v1/devices', async () => {
    const session = await signInAnonymously();

    const response = await registerDevice(session, 'install-validate-0001', { platform: 'palm' });
    const body = await response.json<Envelope>();

    expect(response.status).toBe(400);
    expect(body.error).toBe('validation_failed');
    expect(body.issues.map((issue) => issue.path.join('.'))).toContain('platform');
  });
});

describe('a malformed JSON body answers the envelope too (ruling O10)', () => {
  // @hono/zod-validator throws HTTPException(400) for a body that is not JSON BEFORE the hook
  // runs; `handleError` turns it into the envelope under /v1 instead of Hono's text/plain answer.
  for (const [method, path, key] of [
    ['POST', '/v1/flights', 'malformed-json-flights'],
    ['PATCH', '/v1/me/preferences', null],
    ['POST', '/v1/devices', null],
  ] as const) {
    it(`on ${method} ${path}`, async () => {
      const session = await signInAnonymously();
      const response = await worker(
        new Request(`${API_ORIGIN}${path}`, {
          method,
          headers: {
            'content-type': 'application/json',
            'cf-connecting-ip': session.ip,
            cookie: session.cookie,
            origin: APP_ORIGIN,
            ...(key === null ? {} : { 'Idempotency-Key': `${key}-${crypto.randomUUID()}` }),
          },
          body: '{"flightKey":',
        }),
      );
      const body = await response.json<Envelope>();

      expect(response.status).toBe(400);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(body.error).toBe('validation_failed');
      expect(body.issues).toEqual([{ path: [], message: 'malformed JSON', code: 'invalid_json' }]);
      expect(body.requestId).toBe(response.headers.get(REQUEST_ID_HEADER));
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
    });
  }

  it('keeps an HTTPException outside /v1 as Hono answers it', async () => {
    const app = createApp();
    app.get('/throws', () => {
      throw new HTTPException(418, { message: 'teapot' });
    });
    const response = await app.fetch(new Request(`${API_ORIGIN}/throws`), env);

    expect(response.status).toBe(418);
    expect(await response.text()).toBe('teapot');
  });

  it('answers a 413 under /v1 as payload_too_large with the request id', async () => {
    const app = createApp();
    app.post('/v1/too-big', () => {
      throw new HTTPException(413, { message: 'too big' });
    });
    const response = await app.fetch(
      new Request(`${API_ORIGIN}/v1/too-big`, { method: 'POST', body: '{}' }),
      env,
    );
    const body = await response.json<Envelope>();

    expect(response.status).toBe(413);
    expect(body.error).toBe('payload_too_large');
    expect(body.requestId).toBe(response.headers.get(REQUEST_ID_HEADER));
  });
});

describe('queryValue', () => {
  const schema = z.object({ n: queryValue(z.string().regex(/^[0-9]+$/)) });

  it('accepts a string and a one-element array, refuses a repeated parameter', () => {
    expect(schema.parse({ n: '12' })).toEqual({ n: '12' });
    expect(schema.parse({ n: ['12'] })).toEqual({ n: '12' });
    const repeated = schema.safeParse({ n: ['1', '2'] });
    expect(repeated.success).toBe(false);
    expect(repeated.error?.issues[0]?.message).toBe('the parameter may appear only once');
    expect(schema.safeParse({ n: 'x' }).success).toBe(false);
  });
});
