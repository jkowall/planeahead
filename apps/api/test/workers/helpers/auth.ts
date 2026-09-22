/**
 * Helpers for driving sign-in through the real Worker (`exports.default.fetch`).
 *
 * Every request carries a unique, valid `cf-connecting-ip`: Better Auth's rate limiter is ON in
 * this configuration (that is the point of increment 5's config), keyed by that header, and its
 * built-in `/sign-in*` rule is 3 per 10 seconds per IP. Two tests sharing an address would
 * rate-limit each other, and a request with no address at all lands in one shared bucket.
 *
 * Every email and install id is unique too: the whole run shares one database and the test
 * files run in parallel.
 */

import { env, exports } from 'cloudflare:workers';
import type { Env } from '../../../src/env';
import type { TestBindings } from '../../globalSetup';
import { type FakeProviderIdp, fakeProviderIdp, sha256Hex } from './idp';

export const API_ORIGIN = 'https://api.planeahead.test';
/** An origin in the Worker's trusted list; required on any cookie-bearing POST (CSRF check). */
export const APP_ORIGIN = 'planeahead://';

/** The Worker's env plus the bindings test/globalSetup.ts adds for the suite alone. */
export type TestEnv = Env &
  Partial<
    Pick<
      TestBindings,
      'TEST_IDP_PRIVATE_KEY_PEM' | 'TEST_FAKE_PROVIDERS_ORIGIN' | 'TEST_DEV_VARS_EXAMPLE_KEYS'
    >
  >;

export const testEnv: TestEnv = env;

/**
 * Each test file runs in its own isolate and every file shares one Postgres-backed limiter, so
 * the address space has to be unique per isolate: a random /24 inside 10.0.0.0/8 per file
 * (65,536 blocks), rolling to a fresh random block after 250 hosts.
 */
let ipBlock = `10.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;
let ipHost = 0;

/** A fresh address for one logical client. */
export function uniqueIp(): string {
  ipHost += 1;
  if (ipHost > 250) {
    ipBlock = `10.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;
    ipHost = 1;
  }
  return `${ipBlock}.${ipHost}`;
}

export function uniqueEmail(label: string): string {
  return `${label}-${crypto.randomUUID()}@example.test`;
}

export function uniqueInstallId(label: string): string {
  return `${label}-${crypto.randomUUID()}`;
}

export interface ClientOptions {
  /** Reused across requests to act as one client; defaults to a fresh address per call. */
  readonly ip?: string;
  readonly cookie?: string | null;
  readonly origin?: string | null;
  readonly headers?: Record<string, string>;
}

export function jsonRequest(
  path: string,
  method: string,
  body: unknown,
  options: ClientOptions = {},
): Request {
  const headers: Record<string, string> = {
    'cf-connecting-ip': options.ip ?? uniqueIp(),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...options.headers,
  };
  if (options.cookie !== undefined && options.cookie !== null) {
    headers['cookie'] = options.cookie;
  }
  const origin = options.origin === undefined ? APP_ORIGIN : options.origin;
  if (origin !== null) {
    headers['origin'] = origin;
  }
  return new Request(`${API_ORIGIN}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export function worker(request: Request): Promise<Response> {
  return exports.default.fetch(request);
}

/**
 * The session token cookie alone, without the `session_data` cookie cache. A request that
 * carries the cache cookie is answered from it for up to 300 s without a database read (the
 * documented revocation lag of `session.cookieCache`); a request with the token alone hits the
 * `sessions` table and sees a revocation immediately.
 */
export function sessionTokenOnly(cookie: string): string {
  return cookie
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair.includes('session_token='))
    .join('; ');
}

/** Turns a response's Set-Cookie headers into one Cookie header value for the next request. */
export function cookiesFrom(response: Response): string | null {
  const pairs = response.headers
    .getSetCookie()
    .map((line) => line.split(';')[0] ?? '')
    .filter((pair) => pair.includes('='));
  return pairs.length === 0 ? null : pairs.join('; ');
}

export interface AnonymousSession {
  readonly userId: string;
  readonly cookie: string;
  readonly ip: string;
}

/** `POST /api/auth/sign-in/anonymous` through the Worker; returns the cookie to replay. */
export async function signInAnonymously(ip: string = uniqueIp()): Promise<AnonymousSession> {
  const response = await worker(
    jsonRequest('/api/auth/sign-in/anonymous', 'POST', {}, { ip, origin: null }),
  );
  if (response.status !== 200) {
    throw new Error(`anonymous sign-in failed: ${response.status} ${await response.text()}`);
  }
  const body = await response.json<{ user: { id: string } }>();
  const cookie = cookiesFrom(response);
  if (cookie === null) {
    throw new Error('anonymous sign-in set no cookie');
  }
  return { userId: body.user.id, cookie, ip };
}

export interface RecordedEmail {
  readonly authorization: string | null;
  readonly idempotencyKey: string | null;
  readonly body: { to?: string[] | string; subject?: string; text?: string; html?: string };
}

/** What the fake Resend endpoint recorded for one recipient. */
export async function sentEmails(to: string): Promise<RecordedEmail[]> {
  const origin = testEnv.TEST_FAKE_PROVIDERS_ORIGIN;
  if (origin === undefined) {
    throw new Error('TEST_FAKE_PROVIDERS_ORIGIN is not bound');
  }
  const response = await fetch(`${origin}/resend/sent?to=${encodeURIComponent(to)}`);
  return response.json<RecordedEmail[]>();
}

/** The `token` query parameter of the magic link in the last email sent to `to`. */
export async function magicLinkTokenFor(to: string): Promise<string> {
  const emails = await sentEmails(to);
  const last = emails.at(-1);
  const match = /[?&]token=([^&\s"]+)/.exec(last?.body.text ?? '');
  if (match?.[1] === undefined) {
    throw new Error(`no magic link token in the mail sent to ${to}`);
  }
  return decodeURIComponent(match[1]);
}

/** Requests a magic link and completes it in the app's way (JSON verify, cookie attached). */
export async function signInWithMagicLink(
  email: string,
  options: { readonly ip?: string; readonly cookie?: string | null } = {},
): Promise<{ readonly userId: string; readonly cookie: string; readonly response: Response }> {
  const ip = options.ip ?? uniqueIp();
  const requested = await worker(
    jsonRequest('/api/auth/sign-in/magic-link', 'POST', { email }, { ip, origin: null }),
  );
  if (requested.status !== 200) {
    throw new Error(`magic link request failed: ${requested.status} ${await requested.text()}`);
  }
  const token = await magicLinkTokenFor(email);
  const verified = await worker(
    jsonRequest(
      `/api/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
      'GET',
      undefined,
      { ip, cookie: options.cookie ?? null, origin: null },
    ),
  );
  if (verified.status !== 200) {
    throw new Error(`magic link verify failed: ${verified.status} ${await verified.text()}`);
  }
  const body = await verified.json<{ user: { id: string } }>();
  const cookie = cookiesFrom(verified);
  if (cookie === null) {
    throw new Error('magic link verify set no cookie');
  }
  return { userId: body.user.id, cookie, response: verified };
}

/** `POST /v1/devices` for a signed-in client. */
export function registerDevice(
  session: { readonly cookie: string; readonly ip: string },
  installId: string,
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<Response> {
  return worker(
    jsonRequest(
      '/v1/devices',
      'POST',
      { installId, platform: 'ios', ...body },
      { ip: session.ip, cookie: session.cookie, headers },
    ),
  );
}

let idpPromise: Promise<FakeProviderIdp> | null = null;

/** The run's identity-provider keys, imported once per test file. */
export function idp(): Promise<FakeProviderIdp> {
  idpPromise ??= fakeProviderIdp(testEnv);
  return idpPromise;
}

export interface AppleSignInOptions {
  readonly sub?: string;
  /** `null` mints a token with no email claim (a returning user or a managed Apple ID). */
  readonly email?: string | null;
  readonly rawNonce?: string;
  /** Overrides the `nonce` claim; defaults to sha256hex(rawNonce). */
  readonly nonceClaim?: string | null;
  /** Omits `rawNonce` from the body when false. */
  readonly sendRawNonce?: boolean;
  readonly authorizationCode?: string;
  readonly fullName?: unknown;
  readonly claims?: Record<string, unknown>;
  /** Overrides the token's `aud`; defaults to the bundle id. */
  readonly audience?: string;
  readonly issuedAt?: number;
  readonly lifetime?: number;
  readonly cookie?: string | null;
  readonly ip?: string;
}

export interface NativeSignInResult {
  readonly response: Response;
  readonly rawNonce: string;
  readonly authorizationCode: string;
  readonly identityToken: string;
}

/** `POST /api/auth/sign-in/apple-native` with a token the fake Apple JWKS validates. */
export async function appleNativeSignIn(
  options: AppleSignInOptions = {},
): Promise<NativeSignInResult> {
  const keys = await idp();
  const rawNonce = options.rawNonce ?? `nonce-${crypto.randomUUID()}`;
  const nonceClaim =
    options.nonceClaim === undefined ? await sha256Hex(rawNonce) : options.nonceClaim;
  const email = options.email === undefined ? uniqueEmail('apple') : options.email;
  const authorizationCode = options.authorizationCode ?? `code-${crypto.randomUUID()}`;
  const identityToken = await keys.mintApple({
    audience: options.audience ?? testEnv.APPLE_BUNDLE_ID ?? '',
    subject: options.sub ?? `00${crypto.randomUUID().replaceAll('-', '')}.apple`,
    ...(options.issuedAt === undefined ? {} : { issuedAt: options.issuedAt }),
    ...(options.lifetime === undefined ? {} : { lifetime: options.lifetime }),
    claims: {
      ...(nonceClaim === null ? {} : { nonce: nonceClaim }),
      ...(email === null ? {} : { email, email_verified: 'true' }),
      ...options.claims,
    },
  });
  const body: Record<string, unknown> = {
    identityToken,
    authorizationCode,
    ...(options.sendRawNonce === false ? {} : { rawNonce }),
    ...(options.fullName === undefined ? {} : { fullName: options.fullName }),
  };
  const response = await worker(
    jsonRequest('/api/auth/sign-in/apple-native', 'POST', body, {
      ip: options.ip ?? uniqueIp(),
      cookie: options.cookie ?? null,
    }),
  );
  return { response, rawNonce, authorizationCode, identityToken };
}

export interface GoogleSignInOptions {
  readonly sub?: string;
  readonly email?: string | null;
  readonly rawNonce?: string;
  /** Overrides the `nonce` claim; `null` omits it. Defaults to rawNonce. */
  readonly nonceClaim?: string | null;
  readonly sendRawNonce?: boolean;
  readonly audience?: string;
  readonly issuer?: string;
  readonly issuedAt?: number;
  readonly lifetime?: number;
  readonly claims?: Record<string, unknown>;
  readonly cookie?: string | null;
  readonly ip?: string;
}

/** `POST /api/auth/sign-in/google-native` with a token the fake Google JWKS validates. */
export async function googleNativeSignIn(
  options: GoogleSignInOptions = {},
): Promise<Omit<NativeSignInResult, 'authorizationCode'>> {
  const keys = await idp();
  const rawNonce = options.rawNonce ?? `nonce-${crypto.randomUUID()}`;
  const nonceClaim = options.nonceClaim === undefined ? rawNonce : options.nonceClaim;
  const email = options.email === undefined ? uniqueEmail('google') : options.email;
  const identityToken = await keys.mintGoogle({
    audience: options.audience ?? testEnv.GOOGLE_CLIENT_ID_IOS ?? '',
    subject: options.sub ?? `1${Date.now()}${Math.floor(Math.random() * 1e6)}`,
    ...(options.issuer === undefined ? {} : { issuer: options.issuer }),
    ...(options.issuedAt === undefined ? {} : { issuedAt: options.issuedAt }),
    ...(options.lifetime === undefined ? {} : { lifetime: options.lifetime }),
    claims: {
      ...(nonceClaim === null ? {} : { nonce: nonceClaim }),
      ...(email === null ? {} : { email, email_verified: true }),
      name: 'Google Person',
      ...options.claims,
    },
  });
  const body: Record<string, unknown> = {
    identityToken,
    ...(options.sendRawNonce === false ? {} : { rawNonce }),
  };
  const response = await worker(
    jsonRequest('/api/auth/sign-in/google-native', 'POST', body, {
      ip: options.ip ?? uniqueIp(),
      cookie: options.cookie ?? null,
    }),
  );
  return { response, rawNonce, identityToken };
}

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

/**
 * Captures every console line written while `fn` runs. The Worker under `exports.default.fetch`
 * runs in this isolate, so its structured log lines (and Better Auth's, routed through the same
 * logger) land here rather than on the runner's stdout.
 */
export async function captureLogs<T>(
  fn: () => Promise<T>,
): Promise<{ readonly result: T; readonly lines: readonly string[] }> {
  const lines: string[] = [];
  const originals = CONSOLE_METHODS.map(
    (method) => [method, console[method].bind(console) as (...args: unknown[]) => void] as const,
  );
  for (const method of CONSOLE_METHODS) {
    console[method] = (...args: unknown[]) => {
      lines.push(
        args.map((arg) => (typeof arg === 'string' ? arg : (JSON.stringify(arg) ?? ''))).join(' '),
      );
    };
  }
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    for (const [method, original] of originals) {
      console[method] = original;
    }
  }
}

/** The structured lines whose `event` is `event`, parsed. */
export function logEvents(lines: readonly string[], event: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as { event?: unknown }).event === event
      ) {
        out.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Not a JSON line; the runner's own output.
    }
  }
  return out;
}
