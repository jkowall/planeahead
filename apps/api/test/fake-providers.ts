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
 *   POST /apple/token           the authorization-code exchange; `code=invalid-code` answers 400
 *   GET  /apple/token/requests  what the exchange received, so a test can assert on the form
 *   GET  /google/certs          Google's JWKS, the same key under a different kid
 *   POST /resend/emails         Resend's send endpoint; records the message and answers { id }
 *   GET  /resend/sent?to=       the recorded messages for one recipient
 *
 * The private half of the RSA key is handed to the Worker as `TEST_IDP_PRIVATE_KEY_PEM` so tests
 * can mint identity tokens that the JWKS above validates. Everything is generated per run and
 * nothing is persisted.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { exportJWK, exportPKCS8, generateKeyPair } from 'jose';

export const APPLE_TEST_KID = 'planeahead-test-apple-kid';
export const GOOGLE_TEST_KID = 'planeahead-test-google-kid';
export const APPLE_INVALID_CODE = 'invalid-code';

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
  const sent: RecordedEmail[] = [];

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://fake.invalid');
      const method = request.method ?? 'GET';

      if (method === 'GET' && url.pathname === '/apple/keys') {
        return json(response, 200, appleJwks);
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
        return json(response, 200, {
          access_token: `at_${randomUUID()}`,
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: `rt_${form['code'] ?? ''}_${randomUUID()}`,
          id_token: 'not-inspected',
        });
      }
      if (method === 'GET' && url.pathname === '/apple/token/requests') {
        return json(response, 200, tokenRequests);
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
