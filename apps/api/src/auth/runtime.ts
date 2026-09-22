/**
 * Everything auth needs for ONE request, built once per request and shared between the auth
 * middleware and the routes: the database handle (one Hyperdrive client, not one per caller),
 * the Better Auth instance over it, the envelope, the key provider and the mail sender.
 *
 * Built lazily through `authRuntime(c)` so a request that never presents a cookie and never
 * touches an auth route (a `/health` probe) opens no database client at all.
 */

import type { Context } from 'hono';
import { type Db, openDb } from '@planeahead/db';
import { Envelope } from '../crypto/envelope';
import {
  type KeyProvider,
  createWorkersSecretKeyProvider,
  readKekSecrets,
} from '../crypto/key-provider';
import type { AppBindings, Env } from '../env';
import { type MailSender, selectMailSender } from '../mail/index';
import { type Logger, createLogger } from '../observability/log';
import { type PlaneaheadAuth, createAuth } from './create-auth';

export interface AuthRuntime {
  readonly db: Db;
  readonly auth: PlaneaheadAuth;
  readonly envelope: Envelope;
  readonly keys: KeyProvider;
  readonly mail: MailSender;
  readonly log: Logger;
}

export function createAuthRuntime(env: Env, log: Logger): AuthRuntime {
  const db = openDb(env);
  const keys = createWorkersSecretKeyProvider(readKekSecrets(env));
  const envelope = new Envelope(db, keys);
  const mail = selectMailSender(env, log);
  const auth = createAuth(env, { db, envelope, mail, log, queue: env.PERSIST_QUEUE });
  return { db, auth, envelope, keys, mail, log };
}

/** The request's runtime, created on first use and kept on the context. */
export function authRuntime(c: Context<AppBindings>): AuthRuntime {
  const existing = c.var.authRuntime ?? null;
  if (existing !== null) {
    return existing;
  }
  const runtime = createAuthRuntime(c.env, createLogger({ request_id: c.var.requestId }));
  c.set('authRuntime', runtime);
  return runtime;
}
