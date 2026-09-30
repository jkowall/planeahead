/**
 * PushAuth Durable Object (increment 14, ruling P3).
 *
 * One object per push credential, named `apns:sandbox`, `apns:production` or `fcm`, that every
 * isolate asks for its bearer token:
 *
 *   - APNs: an ES256 provider token signed with WebCrypto from the `.p8` (`APNS_KEY_P8`, key id
 *     `APNS_KEY_ID`, team id `APNS_TEAM_ID`), served for 30 minutes and never re-minted within 20
 *     minutes of the last mint (Apple: refresh no more than once every 20 minutes, reject an `iat`
 *     over an hour old; R1 F18). A token signed by a key the Worker no longer holds (a rotated
 *     secret, seen as a changed fingerprint) is replaced at once.
 *   - FCM: the service account's RS256 assertion exchanged at Google's token endpoint for an access
 *     token, served until five minutes before it expires.
 *
 * `minted_at_ms` and the token are persisted in SQLite, so a restarted object keeps both rules: it
 * serves what it minted rather than minting early. The rules themselves are pure functions in
 * src/push/credentials.ts. Concurrent calls that need a mint share one (`#minting`): the input gate
 * opens while the key is imported or the exchange is in flight, and two mints a few milliseconds
 * apart would be exactly what APNs refuses.
 *
 * RPCs: `current` (the token, or why there is none), `expire` (a provider refused this token:
 * stop serving it, and say when a new one may be minted), `status` (for the admin page: the last
 * mint and failure, never the token), `ping`. Test seams, set through `runInDurableObject`: the
 * `fetchImpl` the FCM exchange uses and `_setClock` (refused unless `TEST_CLOCK` is `true`).
 *
 * The object never opens Postgres and never logs a token, a key or an assertion.
 */

import { DurableObject } from 'cloudflare:workers';
import {
  PushCredentialExpireRequestV1,
  PushCredentialRequestV1,
  RpcRequestError,
  parseRpcRequest,
  type PushCredentialName,
} from '@planeahead/shared';
import type { Env } from '../env';
import { createLogger, errorFields, type Logger } from '../observability/log';
import {
  credentialDecision,
  credentialMaterial,
  exchangeFcmAccessToken,
  materialFingerprint,
  mintApnsProviderToken,
  mintFailureOf,
  notAfterFor,
  remintAtMs,
  type PushCredentialExpireResult,
  type PushCredentialResult,
  type PushCredentialStatus,
  type StoredCredential,
} from '../push/credentials';
import { type DurableObjectPing, blockOnMigrations } from './base';
import { EMPTY_MIGRATION_RESULT, type MigrationResult, type SqlMigrations } from './migrate';
import { PUSH_AUTH_MIGRATION_001 } from './migrations/push-auth/001';

interface CredentialRow {
  readonly token: string;
  readonly fingerprint: string;
  readonly minted_at_ms: number;
  readonly not_after_ms: number;
  readonly mint_count: number;
  readonly [key: string]: string | number | ArrayBuffer | null;
}

interface FailureRow {
  readonly failure: string;
  readonly at_ms: number;
  readonly [key: string]: string | number | ArrayBuffer | null;
}

export class PushAuth extends DurableObject<Env> {
  /** Schema version this build expects. Reported by `GET /health` without touching an object. */
  static readonly SCHEMA_VERSION = 1;

  /** Append only, in order. Index 0 is migration id 1. */
  static readonly MIGRATIONS: SqlMigrations = [PUSH_AUTH_MIGRATION_001];

  /** Test seam: the fetch the FCM token exchange uses. Production never touches it. */
  fetchImpl: typeof fetch = (input, init) => fetch(input, init);

  #schema: MigrationResult = EMPTY_MIGRATION_RESULT;
  readonly #log: Logger;
  #testClockMs: number | null = null;
  readonly #minting = new Map<PushCredentialName, Promise<PushCredentialResult>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#log = createLogger({ durable_object: 'PushAuth', name: ctx.id.name ?? 'unnamed' });
    blockOnMigrations(ctx, PushAuth.MIGRATIONS, (result) => {
      this.#schema = result;
    });
  }

  /** Liveness and schema probe. Cheap, does no I/O, and creates the object if it did not exist. */
  ping(): DurableObjectPing {
    return {
      className: 'PushAuth',
      schemaVersion: PushAuth.SCHEMA_VERSION,
      appliedVersion: this.#schema.version,
      applied: this.#schema.applied,
    };
  }

  /**
   * Test seam: replaces the clock every decision reads. Refused unless the `TEST_CLOCK` binding
   * is `true`, which only test/globalSetup.ts sets.
   */
  _setClock(ms: number | null): void {
    if (this.env.TEST_CLOCK !== 'true') {
      throw new RpcRequestError(
        'invalid_request',
        '_setClock is a test seam (TEST_CLOCK is not set)',
      );
    }
    this.#testClockMs = ms;
  }

  /** The token to send with, minted or exchanged when the rules allow; or why there is none. */
  async current(input: unknown): Promise<PushCredentialResult> {
    const { name } = parseRpcRequest(PushCredentialRequestV1, input);
    this.#assertOwnName(name);
    const material = credentialMaterial(this.env, name);
    if (!material.ok) {
      return {
        ok: false,
        failure: 'not_configured',
        retryable: false,
        problems: material.problems,
      };
    }
    const fingerprint = await materialFingerprint(material.value);
    const row = this.#load(name);
    if (credentialDecision(name, row, fingerprint, this.#now()) === 'serve' && row !== null) {
      return {
        ok: true,
        token: row.token,
        mintedAtMs: row.mintedAtMs,
        notAfterMs: row.notAfterMs,
        fingerprint: row.fingerprint,
      };
    }
    const inFlight = this.#minting.get(name);
    if (inFlight !== undefined) {
      return inFlight;
    }
    const minting = this.#mint(name, fingerprint).finally(() => {
      this.#minting.delete(name);
    });
    this.#minting.set(name, minting);
    return minting;
  }

  /**
   * A provider refused `token` (APNs `ExpiredProviderToken`, FCM 401): it stops being served now,
   * unless a newer token already replaced it. Answers when a new one may be minted: never within
   * the credential's floor of the last mint.
   */
  expire(input: unknown): PushCredentialExpireResult {
    const { name, token } = parseRpcRequest(PushCredentialExpireRequestV1, input);
    this.#assertOwnName(name);
    const now = this.#now();
    const row = this.#load(name);
    if (row === null || row.token !== token) {
      return { remintAtMs: now };
    }
    this.ctx.storage.sql.exec(
      'UPDATE credential SET not_after_ms = MIN(not_after_ms, ?) WHERE name = ?',
      now,
      name,
    );
    this.#log.warn('push_auth_token_expired', { credential: name, minted_at_ms: row.mintedAtMs });
    return { remintAtMs: remintAtMs(name, row.mintedAtMs, now) };
  }

  /** The last mint and failure, for the admin page. Never the token. */
  status(input: unknown): PushCredentialStatus {
    const { name } = parseRpcRequest(PushCredentialRequestV1, input);
    const row = this.#load(name);
    const failure =
      this.ctx.storage.sql
        .exec<FailureRow>('SELECT failure, at_ms FROM mint_failure WHERE name = ?', name)
        .toArray()[0] ?? null;
    return {
      name,
      mintedAtMs: row?.mintedAtMs ?? null,
      notAfterMs: row?.notAfterMs ?? null,
      mintCount: row?.mintCount ?? 0,
      lastFailure: failure === null ? null : { failure: failure.failure, atMs: failure.at_ms },
    };
  }

  async #mint(name: PushCredentialName, fingerprint: string): Promise<PushCredentialResult> {
    const material = credentialMaterial(this.env, name);
    if (!material.ok) {
      return {
        ok: false,
        failure: 'not_configured',
        retryable: false,
        problems: material.problems,
      };
    }
    const now = this.#now();
    let token: string;
    let notAfterMs: number;
    try {
      if (material.value.kind === 'apns') {
        token = await mintApnsProviderToken(material.value.value, now);
        notAfterMs = notAfterFor('apns', now);
      } else {
        const exchanged = await exchangeFcmAccessToken(material.value.value, now, this.fetchImpl);
        if (!exchanged.ok) {
          this.#recordFailure(name, exchanged.failure, now);
          this.#log.warn('push_auth_exchange_failed', {
            credential: name,
            failure: exchanged.failure,
            http_status: exchanged.httpStatus,
          });
          return {
            ok: false,
            failure: exchanged.failure,
            retryable: exchanged.failure === 'exchange_unavailable',
            problems: [],
          };
        }
        token = exchanged.accessToken;
        notAfterMs = notAfterFor('fcm', now, exchanged.expiresInSeconds);
      }
    } catch (error) {
      const failure = mintFailureOf(error);
      this.#recordFailure(name, failure, now);
      this.#log.error('push_auth_mint_failed', {
        credential: name,
        failure,
        ...errorFields(error),
      });
      return { ok: false, failure, retryable: failure === 'exchange_unavailable', problems: [] };
    }
    const previous = this.#load(name);
    const mintCount = (previous?.mintCount ?? 0) + 1;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO credential (name, token, fingerprint, minted_at_ms, not_after_ms, mint_count)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET token = excluded.token,
           fingerprint = excluded.fingerprint, minted_at_ms = excluded.minted_at_ms,
           not_after_ms = excluded.not_after_ms, mint_count = excluded.mint_count`,
        name,
        token,
        fingerprint,
        now,
        notAfterMs,
        mintCount,
      );
      this.ctx.storage.sql.exec('DELETE FROM mint_failure WHERE name = ?', name);
    });
    this.#log.info('push_auth_minted', {
      credential: name,
      minted_at_ms: now,
      not_after_ms: notAfterMs,
      mint_count: mintCount,
      previous_minted_at_ms: previous?.mintedAtMs ?? null,
    });
    return { ok: true, token, mintedAtMs: now, notAfterMs, fingerprint };
  }

  /** One credential per object (ruling P3): an object named for another credential refuses. */
  #assertOwnName(name: PushCredentialName): void {
    const own = this.ctx.id.name;
    if (own !== undefined && own !== name) {
      throw new RpcRequestError('invalid_request', `this object holds ${own}, not ${name}`);
    }
  }

  #recordFailure(name: PushCredentialName, failure: string, atMs: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO mint_failure (name, failure, at_ms) VALUES (?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET failure = excluded.failure, at_ms = excluded.at_ms`,
      name,
      failure,
      atMs,
    );
  }

  #load(name: PushCredentialName): StoredCredential | null {
    const row = this.ctx.storage.sql
      .exec<CredentialRow>(
        'SELECT token, fingerprint, minted_at_ms, not_after_ms, mint_count FROM credential WHERE name = ?',
        name,
      )
      .toArray()[0];
    return row === undefined
      ? null
      : {
          token: row.token,
          fingerprint: row.fingerprint,
          mintedAtMs: row.minted_at_ms,
          notAfterMs: row.not_after_ms,
          mintCount: row.mint_count,
        };
  }

  #now(): number {
    if (this.#testClockMs !== null && this.env.TEST_CLOCK === 'true') {
      return this.#testClockMs;
    }
    return Date.now();
  }
}
