/**
 * The `/v1` client (increment 8 ruling O10, ADR 0004).
 *
 * Typed by the pre-compiled `Client` from `@planeahead/api/client`: its `types` condition is the
 * declaration `tsc -b` emits (apps/api/dist/src/client.d.ts), so type-checking the app never
 * instantiates the Worker's type graph. At run time only `hono/client` crosses into the bundle.
 *
 * Authentication is the Better Auth session cookie, which lives in SecureStore (the Expo client's
 * storage), NOT in React Native's cookie jar. So:
 *
 * - `headers` is an async function evaluated on EVERY request (verified for hono 4.13.8 by
 *   __tests__/api-client-headers.test.ts, spike 2), reading the cookie the auth client holds now:
 *   a session refreshed by `GET /api/auth/get-session` reaches the next `/v1` call without a
 *   rebuilt client.
 * - `credentials: 'omit'` keeps the platform cookie jar out of it. `include` would send whatever
 *   the jar holds (nothing useful) and could shadow the header.
 * - `X-Install-Id` rides on every request. The API reads it on mutating ones: it scopes the
 *   `Idempotency-Key` of an anonymous caller (increment 4) and names the installation for the
 *   magic-link owner budget; on a GET it is ignored.
 *
 * Every non-2xx `/v1` answer is the shared error envelope (`ApiErrorSchema`); callers branch on
 * its `error` code, never on the message.
 */

import { ApiErrorSchema, type ApiError as ApiErrorBody } from '@planeahead/shared';
import { hcWithType, type Client } from '@planeahead/api/client';

export const INSTALL_ID_HEADER = 'X-Install-Id';
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

export interface ApiClientDeps {
  /** The API origin, no trailing slash. */
  readonly baseUrl: string;
  /** The Better Auth session cookie as a `Cookie` header value; empty when signed out. */
  readonly getCookie: () => Promise<string>;
  /** The install id registered with `POST /v1/devices`, or null before it exists. */
  readonly getInstallId: () => string | null;
  readonly fetch?: typeof fetch;
}

export interface RawResponse {
  readonly status: number;
  readonly body: unknown;
  /** `Idempotent-Replayed: true`: the server answered from a stored response. */
  readonly replayed: boolean;
}

export interface RawRequest {
  readonly method: string;
  /** A path under the origin, starting with `/`. */
  readonly path: string;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
}

export interface ApiClient {
  /** The typed Hono RPC client for `/v1`. */
  readonly v1: Client['v1'];
  /** The outbox's untyped path (it replays stored requests by method and path). */
  readonly request: (request: RawRequest) => Promise<RawResponse>;
  readonly headers: () => Promise<Record<string, string>>;
}

/** A non-2xx answer, with the envelope's code when the body is one. */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly status: number;
  /** The envelope's `error`, or `http_<status>` when the body was not an envelope. */
  readonly code: string;
  readonly body: ApiErrorBody | null;

  constructor(status: number, body: unknown) {
    const parsed = ApiErrorSchema.safeParse(body);
    const code = parsed.success ? parsed.data.error : `http_${String(status)}`;
    super(`API answered ${String(status)} ${code}`);
    this.status = status;
    this.code = code;
    this.body = parsed.success ? parsed.data : null;
  }
}

/** The envelope code of an error body, or null when the body is not an envelope. */
export function errorCode(body: unknown): string | null {
  const parsed = ApiErrorSchema.safeParse(body);
  return parsed.success ? parsed.data.error : null;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function createApiClient(deps: ApiClientDeps): ApiClient {
  const doFetch = deps.fetch ?? fetch;

  const headers = async (): Promise<Record<string, string>> => {
    const result: Record<string, string> = {};
    const cookie = await deps.getCookie();
    if (cookie !== '') {
      result['Cookie'] = cookie;
    }
    const installId = deps.getInstallId();
    if (installId !== null) {
      result[INSTALL_ID_HEADER] = installId;
    }
    return result;
  };

  const client = hcWithType(deps.baseUrl, {
    headers,
    init: { credentials: 'omit' },
    fetch: (input: RequestInfo | URL, init?: RequestInit) => doFetch(input, init),
  });

  const request = async (raw: RawRequest): Promise<RawResponse> => {
    const requestHeaders: Record<string, string> = {
      ...(await headers()),
      Accept: 'application/json',
    };
    if (raw.body !== undefined) {
      requestHeaders['Content-Type'] = 'application/json';
    }
    if (raw.idempotencyKey !== undefined) {
      requestHeaders[IDEMPOTENCY_KEY_HEADER] = raw.idempotencyKey;
    }
    const response = await doFetch(`${deps.baseUrl}${raw.path}`, {
      method: raw.method,
      headers: requestHeaders,
      credentials: 'omit',
      ...(raw.body === undefined ? {} : { body: JSON.stringify(raw.body) }),
    });
    return {
      status: response.status,
      body: await readBody(response),
      replayed: response.headers.get(IDEMPOTENT_REPLAYED_HEADER) === 'true',
    };
  };

  return { v1: client.v1, request, headers };
}
