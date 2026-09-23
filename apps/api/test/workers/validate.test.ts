/**
 * The shared validator helper (increment 8, ruling K9). An un-hooked `zValidator` answers a
 * failure with the raw Zod `safeParse` object; every route now validates through
 * `src/lib/validate.ts`, whose hook answers 400 `validation_failed` with flattened issues and
 * the request id. The two increment 5 routes moved onto it are checked through the real Worker.
 */

import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { queryValue } from '../../src/lib/validate';
import { REQUEST_ID_HEADER } from '../../src/middleware/request-id';
import { jsonRequest, registerDevice, signInAnonymously, worker } from './helpers/auth';

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
