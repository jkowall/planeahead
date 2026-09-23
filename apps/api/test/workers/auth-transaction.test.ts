/**
 * A new native sign-in is one atomic write (ruling G4).
 *
 * `handleOAuthUserInfo` creates the user and then the account inside Better Auth's
 * `runWithTransaction`. With the Drizzle adapter's `transaction` flag off (its default) that is
 * a pass-through and the two INSERTs autocommit separately: a failure between them leaves a
 * user row with the provider's email and no account, and every retry then finds that row,
 * takes the implicit-link path and answers 403 ACCOUNT_NOT_LINKED for good. With the flag on
 * the user INSERT rolls back and the retry succeeds.
 *
 * The failure is injected through the `databaseHooks` test seam on `createAuth`: an
 * `account.create.before` hook that throws for one marked subject. The sign-in is driven over
 * HTTP through the instance's own handler, exactly as the Worker would, so the hook runs where
 * Better Auth runs it (inside the transaction, after the user INSERT).
 */

import { eq } from 'drizzle-orm';
import { accounts, openDb, users, withDb } from '@planeahead/db';
import { describe, expect, it } from 'vitest';
import { createAuth } from '../../src/auth/create-auth';
import { Envelope } from '../../src/crypto/envelope';
import { createWorkersSecretKeyProvider, readKekSecrets } from '../../src/crypto/key-provider';
import { NoopSender } from '../../src/mail/index';
import { createLogger } from '../../src/observability/log';
import { API_ORIGIN, idp, testEnv, uniqueEmail, uniqueIp } from './helpers/auth';

const FAIL_SUFFIX = '.fail-account-insert';

function buildAuth(failFor: (accountId: string) => boolean) {
  const db = openDb(testEnv);
  const log = createLogger({}, () => undefined);
  return createAuth(testEnv, {
    db,
    envelope: new Envelope(db, createWorkersSecretKeyProvider(readKekSecrets(testEnv))),
    mail: new NoopSender(log),
    log,
    queue: { send: () => Promise.resolve() },
    databaseHooks: {
      account: {
        create: {
          before: (account) => {
            if (failFor(account.accountId)) {
              throw new Error('injected: account insert failed after the user insert');
            }
            return Promise.resolve();
          },
        },
      },
    },
  });
}

async function googleSignIn(
  auth: ReturnType<typeof buildAuth>,
  sub: string,
  email: string,
): Promise<Response> {
  const keys = await idp();
  const rawNonce = `nonce-${crypto.randomUUID()}`;
  const identityToken = await keys.mintGoogle({
    audience: testEnv.GOOGLE_CLIENT_ID_IOS ?? '',
    subject: sub,
    claims: { nonce: rawNonce, email, email_verified: true, name: 'Tx Person' },
  });
  return auth.handler(
    new Request(`${API_ORIGIN}/api/auth/sign-in/google-native`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': uniqueIp() },
      body: JSON.stringify({ identityToken, rawNonce }),
    }),
  );
}

describe('a failure inside the sign-in transaction', () => {
  it('leaves no user and no account row, and the retry then succeeds', async () => {
    const sub = `1${Date.now()}${Math.floor(Math.random() * 1e6)}${FAIL_SUFFIX}`;
    const email = uniqueEmail('tx');
    let failures = 0;
    const auth = buildAuth((accountId) => {
      if (accountId.endsWith(FAIL_SUFFIX) && failures === 0) {
        failures += 1;
        return true;
      }
      return false;
    });

    const first = await googleSignIn(auth, sub, email);
    const afterFailure = await withDb(testEnv, async (db) => ({
      users: await db.select({ id: users.id }).from(users).where(eq(users.email, email)),
      accounts: await db
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.accountId, sub)),
    }));

    expect(first.status).toBe(500);
    expect((await first.json<{ code?: string }>()).code).toBe('SIGN_IN_FAILED');
    // Both rows gone: the user INSERT rolled back with the account INSERT that threw.
    expect(afterFailure.users).toHaveLength(0);
    expect(afterFailure.accounts).toHaveLength(0);

    // Nothing is left to block the retry.
    const retry = await googleSignIn(auth, sub, email);
    const body = await retry.json<{ isRegister?: boolean; code?: string }>();
    expect(retry.status).toBe(200);
    expect(body.isRegister).toBe(true);
    expect(failures).toBe(1);
  });
});
