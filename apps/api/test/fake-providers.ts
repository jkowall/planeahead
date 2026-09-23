/**
 * The external endpoints increment 5 talks to, served by the test run itself. Node only; started
 * once per run by `test/globalSetup.ts` on a free loopback port, and reached from inside the
 * Workers pool through the URLs the global setup injects as bindings (`APPLE_JWKS_URL`,
 * `APPLE_TOKEN_URL`, `GOOGLE_JWKS_URL`, `RESEND_API_URL`).
 *
 * There is no Apple, Google or Resend account behind this repository and the suite must never
 * dial a real one, so every host the Worker would call is a route here:
 *
 *   GET  /apple/keys            Apple's JWKS, serving the run's own RSA key
 *   POST /apple/token           the authorization-code exchange; `code=invalid-code` answers 400.
 *                               Like Apple, it returns an `id_token` for the authorization the
 *                               code came from: a test mints codes as `code_<hex(sub)>_<uuid>`
 *                               (helpers/auth.ts `appleAuthorizationCode`), and the token names
 *                               that subject, or `unknown-subject` for a code without one, so
 *                               the exchange binding can be tested in both directions
 *   GET  /apple/token/requests  what the exchange received, so a test can assert on the form
 *   POST /apple/revoke          token revocation (increment 8). Records the form and answers 200,
 *                               like Apple, whatever the token; a refresh token whose authorization
 *                               code names a subject containing `revoke-500` answers 500 instead,
 *                               so a test picks the failure path by its own subject
 *   GET  /apple/revoke/requests what the revocation endpoint received
 *   GET  /google/certs          Google's JWKS, the same key under a different kid
 *   POST /resend/emails         Resend's send endpoint; records the message and answers { id }
 *   GET  /resend/sent?to=       the recorded messages for one recipient
 *
 * Increment 7 adds AeroDataBox, so a FlightTracker alarm under test fetches through the real
 * router and the real adapter (`AERODATABOX_BASE_URL` is this origin plus `/aerodatabox`):
 *
 *   GET  /aerodatabox/flights/Number/{designator}/{dateLocal}
 *                               the flight status route. Answers from the responses a test
 *                               scripted for that designator and date (the last one repeats),
 *                               or 204 (the gateway's miss) when nothing is scripted. A scripted
 *                               `reset: true` destroys the socket so the adapter's fetch rejects.
 *   PUT  /control/aerodatabox/flights/{designator}/{dateLocal}
 *                               `{ responses: [{ status, body?, contentType?, reset?, delayMs? }] }`
 *   DELETE /control/aerodatabox/flights/{designator}/{dateLocal}
 *   GET  /control/aerodatabox/calls?designator=&date=
 *                               `{ calls }`: how many status requests that flight has received.
 *                               The lifecycle test takes its provider call count from here,
 *                               never from a counter inside the isolate.
 *
 * A test owns its own designator and date (unique per test), so files running in parallel never
 * share a script or a counter.
 *
 * The private half of the RSA key is handed to the Worker as `TEST_IDP_PRIVATE_KEY_PEM` so tests
 * can mint identity tokens that the JWKS above validates. Everything is generated per run and
 * nothing is persisted.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { SignJWT, exportJWK, exportPKCS8, generateKeyPair } from 'jose';

export const APPLE_TEST_KID = 'planeahead-test-apple-kid';
export const GOOGLE_TEST_KID = 'planeahead-test-google-kid';
export const APPLE_INVALID_CODE = 'invalid-code';
export const APPLE_UNKNOWN_SUBJECT = 'unknown-subject';

/** The subject a test embedded in an authorization code (`code_<hex(sub)>_<uuid>`), if any. */
export function subjectFromAuthorizationCode(code: string): string {
  const match = /^code_([0-9a-f]+)_[0-9a-f-]{36}$/.exec(code);
  if (match?.[1] === undefined) {
    return APPLE_UNKNOWN_SUBJECT;
  }
  return Buffer.from(match[1], 'hex').toString('utf8');
}

export interface FakeProviders {
  readonly origin: string;
  /** PKCS8 PEM of the RSA key both fake JWKS endpoints publish. */
  readonly privateKeyPem: string;
  close(): Promise<void>;
}

export interface RecordedTokenRequest {
  readonly form: Record<string, string>;
  readonly contentType: string | null;
}

export interface RecordedEmail {
  readonly authorization: string | null;
  readonly idempotencyKey: string | null;
  readonly body: Record<string, unknown>;
}

/** One scripted AeroDataBox answer (increment 7). */
export interface ScriptedAdbResponse {
  readonly status: number;
  readonly body?: unknown;
  readonly contentType?: string;
  /** Destroy the socket instead of answering, so the adapter's `fetch` rejects. */
  readonly reset?: boolean;
  /** Hold the answer this long first (a slow gateway, for the fetch timeout and in-flight tests). */
  readonly delayMs?: number;
}

/** The AeroDataBox flight-status path the adapter builds, with the designator upper-cased. */
const ADB_FLIGHT_RE = /^\/aerodatabox\/flights\/Number\/([^/]+)\/([0-9]{4}-[0-9]{2}-[0-9]{2})$/;
const ADB_CONTROL_RE = /^\/control\/aerodatabox\/flights\/([^/]+)\/([0-9]{4}-[0-9]{2}-[0-9]{2})$/;

function adbKey(designator: string, date: string): string {
  return `${decodeURIComponent(designator).toUpperCase().replace(/\s+/g, '')}/${date}`;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

export async function startFakeProviders(): Promise<FakeProviders> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const privateKeyPem = await exportPKCS8(privateKey);
  const publicJwk = await exportJWK(publicKey);
  const appleJwks = { keys: [{ ...publicJwk, kid: APPLE_TEST_KID, use: 'sig', alg: 'RS256' }] };
  const googleJwks = { keys: [{ ...publicJwk, kid: GOOGLE_TEST_KID, use: 'sig', alg: 'RS256' }] };

  const tokenRequests: RecordedTokenRequest[] = [];
  const revokeRequests: RecordedTokenRequest[] = [];
  const sent: RecordedEmail[] = [];
  const adbScripts = new Map<string, ScriptedAdbResponse[]>();
  const adbCalls = new Map<string, number>();

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://fake.invalid');
      const method = request.method ?? 'GET';

      if (method === 'GET' && url.pathname === '/apple/keys') {
        return json(response, 200, appleJwks);
      }

      const adbFlight = ADB_FLIGHT_RE.exec(url.pathname);
      if (method === 'GET' && adbFlight?.[1] !== undefined && adbFlight[2] !== undefined) {
        const key = adbKey(adbFlight[1], adbFlight[2]);
        adbCalls.set(key, (adbCalls.get(key) ?? 0) + 1);
        const queue = adbScripts.get(key);
        const scripted =
          queue === undefined ? undefined : queue.length > 1 ? queue.shift() : queue[0];
        if (scripted === undefined) {
          response.writeHead(204);
          return response.end();
        }
        if (scripted.delayMs !== undefined && scripted.delayMs > 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, scripted.delayMs);
            // A pending delay must not hold the run open past teardown.
            timer.unref();
          });
        }
        if (scripted.reset === true) {
          request.socket.destroy();
          return undefined;
        }
        if (scripted.body === undefined) {
          response.writeHead(scripted.status);
          return response.end();
        }
        const text =
          typeof scripted.body === 'string' ? scripted.body : JSON.stringify(scripted.body);
        response.writeHead(scripted.status, {
          'content-type': scripted.contentType ?? 'application/json',
        });
        return response.end(text);
      }
      const control = ADB_CONTROL_RE.exec(url.pathname);
      if (control?.[1] !== undefined && control[2] !== undefined) {
        const key = adbKey(control[1], control[2]);
        if (method === 'PUT') {
          const body = JSON.parse(await readBody(request)) as { responses?: ScriptedAdbResponse[] };
          adbScripts.set(key, [...(body.responses ?? [])]);
          return json(response, 200, { scripted: adbScripts.get(key)?.length ?? 0 });
        }
        if (method === 'DELETE') {
          adbScripts.delete(key);
          adbCalls.delete(key);
          return json(response, 200, { cleared: true });
        }
      }
      if (method === 'GET' && url.pathname === '/control/aerodatabox/calls') {
        const key = adbKey(
          url.searchParams.get('designator') ?? '',
          url.searchParams.get('date') ?? '',
        );
        return json(response, 200, { calls: adbCalls.get(key) ?? 0 });
      }
      if (method === 'GET' && url.pathname === '/google/certs') {
        return json(response, 200, googleJwks);
      }
      if (method === 'POST' && url.pathname === '/apple/token') {
        const raw = await readBody(request);
        const form = Object.fromEntries(new URLSearchParams(raw));
        tokenRequests.push({ form, contentType: request.headers['content-type'] ?? null });
        if (form['code'] === APPLE_INVALID_CODE || form['grant_type'] !== 'authorization_code') {
          return json(response, 400, { error: 'invalid_grant' });
        }
        // Apple returns an id_token for the authorization the code belongs to, signed with the
        // same keys as the identity token. No nonce claim here: Apple does not repeat it on the
        // exchange, and the binding check skips the nonce when it is absent.
        const idToken = await new SignJWT({ nonce_supported: true })
          .setProtectedHeader({ alg: 'RS256', kid: APPLE_TEST_KID })
          .setIssuer('https://appleid.apple.com')
          .setAudience(form['client_id'] ?? '')
          .setSubject(subjectFromAuthorizationCode(form['code'] ?? ''))
          .setIssuedAt()
          .setExpirationTime('10m')
          .sign(privateKey);
        return json(response, 200, {
          access_token: `at_${randomUUID()}`,
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: `rt_${form['code'] ?? ''}_${randomUUID()}`,
          id_token: idToken,
        });
      }
      if (method === 'GET' && url.pathname === '/apple/token/requests') {
        return json(response, 200, tokenRequests);
      }
      if (method === 'POST' && url.pathname === '/apple/revoke') {
        const raw = await readBody(request);
        const form = Object.fromEntries(new URLSearchParams(raw));
        revokeRequests.push({ form, contentType: request.headers['content-type'] ?? null });
        // The refresh token the fake exchange minted is `rt_<code>_<uuid>`; its code names the
        // subject the test chose.
        const code = /^rt_(code_[0-9a-f]+_[0-9a-f-]{36})_/.exec(form['token'] ?? '')?.[1] ?? '';
        if (subjectFromAuthorizationCode(code).includes('revoke-500')) {
          return json(response, 500, { error: 'server_error' });
        }
        response.writeHead(200);
        return response.end();
      }
      if (method === 'GET' && url.pathname === '/apple/revoke/requests') {
        return json(response, 200, revokeRequests);
      }
      if (method === 'POST' && url.pathname === '/resend/emails') {
        const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
        sent.push({
          authorization: request.headers['authorization'] ?? null,
          idempotencyKey: (request.headers['idempotency-key'] as string | undefined) ?? null,
          body,
        });
        return json(response, 200, { id: randomUUID() });
      }
      if (method === 'GET' && url.pathname === '/resend/sent') {
        const to = url.searchParams.get('to');
        return json(
          response,
          200,
          sent.filter((entry) => {
            const recipients = entry.body['to'];
            return (
              to === null ||
              (Array.isArray(recipients) && recipients.includes(to)) ||
              recipients === to
            );
          }),
        );
      }
      return json(response, 404, { error: 'fake_provider_route_missing', path: url.pathname });
    })().catch((error: unknown) => {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fake providers: could not determine the listening port');
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    privateKeyPem,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
