/**
 * The replay markers for native identity tokens (`src/auth/used-tokens.ts`): keyed by `jti` or
 * the token's digest, never the token; a TTL that follows the token's expiry and never drops
 * under KV's 60 second floor; and best-effort on a failing store (logged, never thrown).
 */

import { describe, expect, it } from 'vitest';
import {
  KV_MIN_TTL_SECONDS,
  type ReplayMarkerStore,
  identityTokenReplayKey,
  markIdentityTokenUsed,
  wasIdentityTokenUsed,
} from '../../src/auth/used-tokens';
import { sha256Hex } from '../../src/crypto/hash';
import { type LogLine, createLogger } from '../../src/observability/log';

function memoryStore() {
  const entries = new Map<string, { value: string; ttl: number | undefined }>();
  const store: ReplayMarkerStore = {
    get: (key) => Promise.resolve(entries.get(key)?.value ?? null),
    put: (key, value, options) => {
      entries.set(key, { value, ttl: options?.expirationTtl });
      return Promise.resolve();
    },
  };
  return { store, entries };
}

function failingStore(): ReplayMarkerStore {
  return {
    get: () => Promise.reject(new Error('kv unavailable')),
    put: () => Promise.reject(new Error('kv unavailable')),
  };
}

function capturingLogger() {
  const lines: LogLine[] = [];
  return { log: createLogger({}, (line) => lines.push(line)), lines };
}

describe('identityTokenReplayKey', () => {
  it('uses jti when there is one and the token digest otherwise, never the token', async () => {
    const token = 'eyJ.header.payload.signature';
    expect(await identityTokenReplayKey('google', token, 'jti-1')).toBe(
      'used_id_tokens:google:jti-1',
    );
    const byDigest = await identityTokenReplayKey('apple', token, null);
    expect(byDigest).toBe(`used_id_tokens:apple:${await sha256Hex(token)}`);
    expect(byDigest).not.toContain(token);
    expect(await identityTokenReplayKey('apple', token, '')).toBe(byDigest);
  });
});

describe('wasIdentityTokenUsed and markIdentityTokenUsed', () => {
  it('answers false before the mark and true after it, with a TTL to the token expiry', async () => {
    const { store, entries } = memoryStore();
    const { log } = capturingLogger();
    const now = Date.now();
    const key = 'used_id_tokens:google:k';

    expect(await wasIdentityTokenUsed(store, key, log)).toBe(false);
    await markIdentityTokenUsed(store, key, Math.floor(now / 1000) + 3600, log, now);
    expect(await wasIdentityTokenUsed(store, key, log)).toBe(true);
    expect(entries.get(key)?.ttl).toBe(3600);
  });

  it('never asks KV for a TTL under its 60 second floor', async () => {
    const { store, entries } = memoryStore();
    const { log } = capturingLogger();
    const now = Date.now();
    await markIdentityTokenUsed(store, 'k1', Math.floor(now / 1000) + 5, log, now);
    await markIdentityTokenUsed(store, 'k2', Math.floor(now / 1000) - 100, log, now);
    expect(entries.get('k1')?.ttl).toBe(KV_MIN_TTL_SECONDS);
    expect(entries.get('k2')?.ttl).toBe(KV_MIN_TTL_SECONDS);
  });

  it('logs and does not throw when the store fails, so sign-in continues', async () => {
    const { log, lines } = capturingLogger();
    const store = failingStore();

    await expect(wasIdentityTokenUsed(store, 'k', log)).resolves.toBe(false);
    await expect(markIdentityTokenUsed(store, 'k', 0, log)).resolves.toBeUndefined();
    expect(lines.map((line) => line.event)).toEqual([
      'used_id_token_check_failed',
      'used_id_token_mark_failed',
    ]);
    expect(lines.every((line) => line.level === 'warn')).toBe(true);
  });
});
