/**
 * Shared fixtures for the push transport tests (increment 14): jobs and targets, a recording
 * `fetch` that answers from a script, a credential source that counts its calls, and the public
 * halves of the test keys in `.dev.vars.test` so a test can verify what the Worker signed.
 */

import { env } from 'cloudflare:workers';
import {
  PushJobV1,
  type FlightKey,
  type PushCredentialName,
  type PushJobV1Input,
  type PushTargetV1Input,
} from '@planeahead/shared';
import type { Env } from '../../../src/env';
import type { PushCredentialSource } from '../../../src/push/credentials';
import { pkcs8Der } from '../../../src/push/jwt';

export const testEnv = env as Env;

export function flightKey(value: string): FlightKey {
  return value as FlightKey;
}

export const APNS_TOKEN = 'a1b2c3d4'.repeat(8);
export const FCM_TOKEN = `fcm-token:${'x'.repeat(140)}`;

export function target(overrides: Partial<PushTargetV1Input> = {}): PushTargetV1Input {
  return {
    pushTokenId: crypto.randomUUID(),
    subjectId: crypto.randomUUID(),
    kind: 'apns',
    token: APNS_TOKEN,
    environment: 'sandbox',
    appId: 'app.planeahead.mobile.dev',
    notificationId: crypto.randomUUID(),
    flightSubscriptionId: crypto.randomUUID(),
    ...overrides,
  };
}

export function fcmTarget(overrides: Partial<PushTargetV1Input> = {}): PushTargetV1Input {
  return target({ kind: 'fcm', token: FCM_TOKEN, environment: 'production', ...overrides });
}

export function jobInput(overrides: Partial<PushJobV1Input> = {}): PushJobV1Input {
  return {
    kind: 'push_job',
    jobId: crypto.randomUUID(),
    notificationKind: 'gate_change',
    flightKey: flightKey('AAL-100-2026-10-02-KJFK'),
    title: 'Gate change',
    body: 'AA100 now departs from B31',
    channelId: 'flight_gate',
    expiresAt: '2026-10-02T14:00:00Z',
    targets: [target()],
    ...overrides,
  };
}

export function job(overrides: Partial<PushJobV1Input> = {}): PushJobV1 {
  return PushJobV1.parse(jobInput(overrides));
}

/** One request the fake fetch received. */
export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly signal: AbortSignal | null;
}

export type Responder = (request: RecordedRequest) => Response | Promise<Response>;

export interface FakeFetch {
  readonly fetch: typeof fetch;
  readonly requests: RecordedRequest[];
  /** The most requests that were ever waiting for an answer at once. */
  maxInFlight: number;
}

/** A `fetch` that records every request and answers with `respond`. */
export function fakeFetch(respond: Responder): FakeFetch {
  let inFlight = 0;
  const fake: FakeFetch = {
    requests: [],
    maxInFlight: 0,
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key] = value;
      });
      const request: RecordedRequest = {
        url,
        method: init?.method ?? 'GET',
        headers,
        body: typeof init?.body === 'string' ? init.body : '',
        signal: init?.signal ?? null,
      };
      fake.requests.push(request);
      inFlight += 1;
      fake.maxInFlight = Math.max(fake.maxInFlight, inFlight);
      try {
        return await respond(request);
      } finally {
        inFlight -= 1;
      }
    },
  };
  return fake;
}

/** An APNs answer: 200 with an `apns-id`, or an error with its JSON reason. */
export function apnsAnswer(
  status: number,
  body: Record<string, unknown> | null = null,
  apnsId: string | null = crypto.randomUUID(),
): Response {
  const headers: Record<string, string> = apnsId === null ? {} : { 'apns-id': apnsId };
  return new Response(body === null ? null : JSON.stringify(body), { status, headers });
}

/** An FCM error answer with the given `details[]`. */
export function fcmError(
  status: number,
  statusName: string,
  details: readonly Record<string, unknown>[] = [],
  headers: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({ error: { code: status, message: statusName, status: statusName, details } }),
    { status, headers: { 'content-type': 'application/json', ...headers } },
  );
}

export const FCM_ERROR_TYPE = 'type.googleapis.com/google.firebase.fcm.v1.FcmError';
export const BAD_REQUEST_TYPE = 'type.googleapis.com/google.rpc.BadRequest';

/** A credential source that hands out fixed tokens and records what it was asked. */
export interface FakeCredentials extends PushCredentialSource {
  readonly asked: PushCredentialName[];
  readonly expired: { name: PushCredentialName; token: string }[];
}

export function fakeCredentials(
  options: { remintAtMs?: number; fail?: Error } = {},
): FakeCredentials {
  const asked: PushCredentialName[] = [];
  const expired: { name: PushCredentialName; token: string }[] = [];
  return {
    asked,
    expired,
    token(name) {
      asked.push(name);
      if (options.fail !== undefined) {
        return Promise.reject(options.fail);
      }
      return Promise.resolve(`token-for-${name}`);
    },
    expire(name, token) {
      expired.push({ name, token });
      return Promise.resolve(options.remintAtMs ?? 0);
    },
  };
}

/** The verifying half of a PKCS8 key, for checking a signature the Worker made. */
export async function publicKeyOf(pem: string, algorithm: 'ES256' | 'RS256'): Promise<CryptoKey> {
  const params =
    algorithm === 'ES256'
      ? { name: 'ECDSA', namedCurve: 'P-256' }
      : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    pkcs8Der(pem, 'test key'),
    params,
    true,
    ['sign'],
  );
  const jwk = (await crypto.subtle.exportKey('jwk', privateKey)) as JsonWebKey;
  delete jwk.d;
  delete jwk.p;
  delete jwk.q;
  delete jwk.dp;
  delete jwk.dq;
  delete jwk.qi;
  jwk.key_ops = ['verify'];
  return crypto.subtle.importKey('jwk', jwk, params, true, ['verify']);
}

/** The FCM service account the suite's `.dev.vars.test` configures. */
export function testServiceAccount(): {
  project_id: string;
  client_email: string;
  private_key: string;
  private_key_id: string;
} {
  return JSON.parse(testEnv.FCM_SERVICE_ACCOUNT_JSON ?? '{}') as {
    project_id: string;
    client_email: string;
    private_key: string;
    private_key_id: string;
  };
}

/** A queue producer that keeps what it is sent (and its delay), for the consumers' seams. */
export interface CapturingQueue {
  readonly queue: Pick<Queue, 'send'>;
  readonly sent: { readonly body: unknown; readonly delaySeconds: number | undefined }[];
}

export function capturingQueue(fail = false): CapturingQueue {
  const sent: { body: unknown; delaySeconds: number | undefined }[] = [];
  const send = (body: unknown, options?: QueueSendOptions) => {
    if (fail) {
      return Promise.reject(new Error('queue unavailable'));
    }
    sent.push({ body, delaySeconds: options?.delaySeconds });
    return Promise.resolve();
  };
  return { sent, queue: { send } as unknown as Pick<Queue, 'send'> };
}
