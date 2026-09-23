/**
 * The envelope primitives, on the real runtime. Runs inside workerd (vitest.config.ts), which is
 * what settles the facts sheet's runtime questions: AES-KW wrapping needs an extractable DEK
 * and yields exactly 40 bytes, `unwrapKey` gives a non-extractable key back, and
 * `timingSafeEqual` throws on unequal lengths unless the caller checks first.
 */

import { describe, expect, it } from 'vitest';
import { sha256Hex, timingSafeEqualBytes, utf8 } from '../../src/crypto/hash';
import {
  IV_BYTES,
  MIN_CIPHERTEXT_BYTES,
  WRAPPED_DEK_BYTES,
  aadFor,
  decryptWithDek,
  encryptWithDek,
  generateDek,
  unwrapDek,
  wrapDek,
} from '../../src/crypto/envelope';
import {
  KekConfigError,
  UnknownKeyVersionError,
  configuredKekVersions,
  createStaticKeyProvider,
  createWorkersSecretKeyProvider,
  decodeKekBase64,
  importKek,
} from '../../src/crypto/key-provider';

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function randomKekBase64(): string {
  return base64(crypto.getRandomValues(new Uint8Array(32)));
}

describe('KEK decoding', () => {
  it('accepts standard padded base64 of 32 bytes', () => {
    expect(decodeKekBase64(randomKekBase64(), 'TOKEN_KEK_V1')).toHaveLength(32);
  });

  it('rejects the base64url alphabet with a message that names the cause', () => {
    const url = randomKekBase64().replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const withUrlChars = url.includes('-') || url.includes('_') ? url : `${url.slice(0, -1)}_`;
    expect(() => decodeKekBase64(withUrlChars, 'TOKEN_KEK_V1')).toThrow(KekConfigError);
    expect(() => decodeKekBase64(withUrlChars, 'TOKEN_KEK_V1')).toThrow(/base64url/);
  });

  it('rejects the wrong length, unpadded input and garbage', () => {
    expect(() => decodeKekBase64(base64(new Uint8Array(16)), 'TOKEN_KEK_V1')).toThrow(/32 bytes/);
    expect(() => decodeKekBase64(randomKekBase64().slice(0, -1), 'TOKEN_KEK_V1')).toThrow(
      KekConfigError,
    );
    expect(() => decodeKekBase64('not base64!', 'TOKEN_KEK_V1')).toThrow(KekConfigError);
    expect(() => decodeKekBase64('', 'TOKEN_KEK_V1')).toThrow(/empty/);
  });
});

describe('createWorkersSecretKeyProvider', () => {
  it('picks the highest configured version and memoises the import', async () => {
    const v1 = randomKekBase64();
    const v3 = randomKekBase64();
    const provider = createWorkersSecretKeyProvider({ TOKEN_KEK_V1: v1, TOKEN_KEK_V3: v3 });

    expect(provider.currentVersion).toBe(3);
    expect(configuredKekVersions({ TOKEN_KEK_V1: v1, TOKEN_KEK_V3: v3 })).toEqual([1, 3]);
    const first = await provider.getKek(3);
    const second = await provider.getKek(3);
    expect(second).toBe(first);
    expect(first.extractable).toBe(false);
    expect([...first.usages].sort()).toEqual(['unwrapKey', 'wrapKey']);
    await expect(provider.getKek(2)).rejects.toBeInstanceOf(UnknownKeyVersionError);
  });

  it('fails at construction when nothing or something malformed is configured', () => {
    expect(() => createWorkersSecretKeyProvider({})).toThrow(/TOKEN_KEK_V1/);
    expect(() => createWorkersSecretKeyProvider({ TOKEN_KEK_V1: 'short' })).toThrow(KekConfigError);
  });
});

describe('DEK wrapping', () => {
  it('wraps a DEK to exactly 40 bytes and unwraps it non-extractable', async () => {
    const kek = await importKek(randomKekBase64(), 'TOKEN_KEK_V1');
    const dek = await generateDek();

    expect(dek.extractable).toBe(true);
    const wrapped = await wrapDek(dek, kek);
    expect(wrapped).toHaveLength(WRAPPED_DEK_BYTES);

    const unwrapped = await unwrapDek(wrapped, kek);
    expect(unwrapped.extractable).toBe(false);
    expect(unwrapped.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
  });

  it('refuses to unwrap under a different KEK or a wrong-length blob', async () => {
    const kekA = await importKek(randomKekBase64(), 'TOKEN_KEK_V1');
    const kekB = await importKek(randomKekBase64(), 'TOKEN_KEK_V2');
    const wrapped = await wrapDek(await generateDek(), kekA);

    await expect(unwrapDek(wrapped, kekB)).rejects.toThrow();
    await expect(unwrapDek(wrapped.subarray(0, 32), kekA)).rejects.toThrow(/40/);
  });

  it('cannot wrap a non-extractable DEK, which is why the write path imports extractable', async () => {
    const kek = await importKek(randomKekBase64(), 'TOKEN_KEK_V1');
    const locked = await crypto.subtle.importKey(
      'raw',
      crypto.getRandomValues(new Uint8Array(32)),
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );

    await expect(wrapDek(locked, kek)).rejects.toThrow();
  });
});

describe('AES-GCM with AAD', () => {
  it('round-trips and lays the value out as iv || ct || tag', async () => {
    const dek = await generateDek();
    const aad = aadFor('accounts', 'refresh_token', 'row-1');
    const plaintext = utf8('rt_secret_value');

    const sealed = await encryptWithDek(dek, plaintext, aad);
    expect(sealed).toHaveLength(IV_BYTES + plaintext.length + 16);
    expect(await decryptWithDek(dek, sealed, aad)).toEqual(plaintext);
  });

  it('fails on an AAD mismatch, so a value cannot be moved between cells', async () => {
    const dek = await generateDek();
    const sealed = await encryptWithDek(dek, utf8('x'), aadFor('accounts', 'refresh_token', 'a'));

    await expect(
      decryptWithDek(dek, sealed, aadFor('accounts', 'refresh_token', 'b')),
    ).rejects.toThrow(/decryption failed/);
    await expect(
      decryptWithDek(dek, sealed, aadFor('accounts', 'access_token', 'a')),
    ).rejects.toThrow(/decryption failed/);
  });

  it('fails under a different DEK and on a flipped byte', async () => {
    const aad = aadFor('t', 'c', 'r');
    const sealed = await encryptWithDek(await generateDek(), utf8('x'), aad);
    await expect(decryptWithDek(await generateDek(), sealed, aad)).rejects.toThrow();

    const dek = await generateDek();
    const sealedB = await encryptWithDek(dek, utf8('hello'), aad);
    sealedB[IV_BYTES] = (sealedB[IV_BYTES] ?? 0) ^ 0x01;
    await expect(decryptWithDek(dek, sealedB, aad)).rejects.toThrow();
  });

  it('rejects a value shorter than iv plus tag before touching WebCrypto', async () => {
    const dek = await generateDek();
    await expect(
      decryptWithDek(dek, new Uint8Array(MIN_CIPHERTEXT_BYTES - 1), aadFor('t', 'c', 'r')),
    ).rejects.toThrow(/below the minimum/);
  });

  it('never repeats an IV across 10k values (RNG sanity, not a security bound)', async () => {
    const dek = await generateDek();
    const aad = aadFor('t', 'c', 'r');
    const seen = new Set<string>();
    for (let index = 0; index < 10_000; index += 1) {
      const sealed = await encryptWithDek(dek, utf8('v'), aad);
      seen.add(await sha256Hex(sealed.subarray(0, IV_BYTES)));
    }
    expect(seen.size).toBe(10_000);
  });

  it('validates AAD components', () => {
    expect(() => aadFor('Accounts', 'c', 'r')).toThrow(/AAD/);
    expect(() => aadFor('t', 'c', 'a:b')).toThrow(/row id/);
    expect(() => aadFor('t', 'c', '')).toThrow(/row id/);
  });
});

describe('timingSafeEqualBytes', () => {
  it('returns false on unequal lengths instead of throwing like the primitive does', () => {
    expect(timingSafeEqualBytes(utf8('abc'), utf8('abcd'))).toBe(false);
    expect(() => crypto.subtle.timingSafeEqual(utf8('abc'), utf8('abcd'))).toThrow(TypeError);
    expect(timingSafeEqualBytes(utf8('abc'), utf8('abc'))).toBe(true);
    expect(timingSafeEqualBytes(utf8('abc'), utf8('abd'))).toBe(false);
  });
});

describe('createStaticKeyProvider', () => {
  it('serves the keys it was given and rejects the rest', async () => {
    const kek = await importKek(randomKekBase64(), 'TOKEN_KEK_V1');
    const provider = createStaticKeyProvider(new Map([[1, kek]]), 1);
    expect(await provider.getKek(1)).toBe(kek);
    await expect(provider.getKek(2)).rejects.toBeInstanceOf(UnknownKeyVersionError);
  });
});
