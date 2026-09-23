/**
 * Envelope encryption for secret columns (plan section 10, `docs/security/threat-model.md`).
 *
 * Two layers of keys:
 *
 *   - one 256-bit data-encryption key (DEK) per user, generated inside a handler (the CSPRNG
 *     throws at global scope on Workers), wrapped with AES-KW under the current KEK and stored in
 *     `user_keys (user_id, wrapped_dek, kek_version)`. Wrapping needs the DEK to be imported
 *     `extractable: true` (AES-KW exports the key first, and workerd throws otherwise); the DEK
 *     that comes back from `unwrapKey` on the read path is `extractable: false`.
 *   - AES-256-GCM with a fresh 12-byte IV per value and the AAD `table:column:row_id`, stored
 *     as `iv(12) || ciphertext || tag(16)`. The AAD binds a ciphertext to its cell, so a value
 *     moved between rows or columns fails to decrypt.
 *
 * `rotateKek` re-wraps the DEK only; ciphertexts never change. The `key_version` column beside
 * each secret records which KEK wrapped the owner's DEK when the value was written; decryption
 * checks that version is one the Worker still knows, then unwraps with whatever version the
 * `user_keys` row carries now. AAD deliberately excludes the key version (threat model).
 */

import { eq } from 'drizzle-orm';
import { type Db, userKeys } from '@planeahead/db';
import { utf8 } from './hash';
import type { KeyProvider } from './key-provider';

export const IV_BYTES = 12;
export const TAG_BYTES = 16;
export const DEK_BYTES = 32;
/** AES-KW adds exactly 8 bytes to a 32-byte key. Asserted on every wrap. */
export const WRAPPED_DEK_BYTES = DEK_BYTES + 8;
export const MIN_CIPHERTEXT_BYTES = IV_BYTES + TAG_BYTES;

export class EnvelopeError extends Error {
  override readonly name = 'EnvelopeError';
}

export interface EncryptedValue {
  /** `iv(12) || ciphertext || tag(16)`. */
  readonly ciphertext: Uint8Array;
  /** The KEK version that wrapped the owner's DEK when this value was written. */
  readonly keyVersion: number;
}

const AAD_COMPONENT = /^[a-z][a-z0-9_]*$/;

/**
 * `${table}:${column}:${rowId}`. Table and column are restricted to identifier characters and
 * the row id may not contain the separator, so no two cells can share an AAD.
 */
export function aadFor(table: string, column: string, rowId: string): Uint8Array<ArrayBuffer> {
  if (!AAD_COMPONENT.test(table) || !AAD_COMPONENT.test(column)) {
    throw new EnvelopeError(`invalid AAD table or column: ${table}:${column}`);
  }
  if (rowId === '' || rowId.includes(':')) {
    throw new EnvelopeError('invalid AAD row id');
  }
  return utf8(`${table}:${column}:${rowId}`);
}

/** A fresh DEK, extractable so it can be wrapped. Call inside a handler. */
export function generateDek(): Promise<CryptoKey> {
  const raw = crypto.getRandomValues(new Uint8Array(DEK_BYTES));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, true, [
    'encrypt',
    'decrypt',
  ]);
}

export async function wrapDek(dek: CryptoKey, kek: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  const wrapped = new Uint8Array(await crypto.subtle.wrapKey('raw', dek, kek, 'AES-KW'));
  if (wrapped.byteLength !== WRAPPED_DEK_BYTES) {
    throw new EnvelopeError(
      `wrapped DEK is ${wrapped.byteLength} bytes, expected ${WRAPPED_DEK_BYTES}`,
    );
  }
  return wrapped;
}

/** The read-path DEK: not extractable, usable only for AES-GCM. */
export function unwrapDek(wrapped: Uint8Array, kek: CryptoKey): Promise<CryptoKey> {
  if (wrapped.byteLength !== WRAPPED_DEK_BYTES) {
    return Promise.reject(
      new EnvelopeError(
        `wrapped DEK is ${wrapped.byteLength} bytes, expected ${WRAPPED_DEK_BYTES}`,
      ),
    );
  }
  return crypto.subtle.unwrapKey(
    'raw',
    wrapped,
    kek,
    'AES-KW',
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptWithDek(
  dek: CryptoKey,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad, tagLength: TAG_BYTES * 8 },
      dek,
      plaintext,
    ),
  );
  const out = new Uint8Array(IV_BYTES + sealed.byteLength);
  out.set(iv, 0);
  out.set(sealed, IV_BYTES);
  return out;
}

/**
 * Enforces the layout before touching WebCrypto: workerd accepts any non-empty IV length, so a
 * truncated or reshuffled value must be rejected here rather than decrypt to garbage or throw an
 * opaque OperationError.
 */
export async function decryptWithDek(
  dek: CryptoKey,
  ciphertext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  if (ciphertext.byteLength < MIN_CIPHERTEXT_BYTES) {
    throw new EnvelopeError(
      `ciphertext is ${ciphertext.byteLength} bytes, below the minimum of ${MIN_CIPHERTEXT_BYTES}`,
    );
  }
  const iv = ciphertext.subarray(0, IV_BYTES);
  if (iv.byteLength !== IV_BYTES) {
    throw new EnvelopeError('IV must be 12 bytes');
  }
  const sealed = ciphertext.subarray(IV_BYTES);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: aad, tagLength: TAG_BYTES * 8 },
        dek,
        sealed,
      ),
    );
  } catch {
    // Wrong key, wrong AAD or a modified byte all surface as one OperationError; the message is
    // deliberately uniform so a caller cannot distinguish them either.
    throw new EnvelopeError('decryption failed');
  }
}

export interface UserDek {
  readonly dek: CryptoKey;
  readonly kekVersion: number;
}

/**
 * The envelope over a database handle and a key provider. One instance per request; it holds
 * nothing but the two references.
 */
export class Envelope {
  constructor(
    private readonly db: Db,
    private readonly keys: KeyProvider,
  ) {}

  /**
   * The user's DEK, creating and storing a wrapped one on first use. The insert is
   * `on conflict do nothing` followed by a re-read, so two concurrent first writes for the same
   * user converge on one row rather than one of them holding a DEK the database never saw.
   */
  async dekFor(userId: string): Promise<UserDek> {
    const existing = await this.readRow(userId);
    if (existing !== null) {
      return this.unwrapRow(existing);
    }
    const kekVersion = this.keys.currentVersion;
    const kek = await this.keys.getKek(kekVersion);
    const dek = await generateDek();
    const wrapped = await wrapDek(dek, kek);
    await this.db
      .insert(userKeys)
      .values({ userId, wrappedDek: wrapped, kekVersion })
      .onConflictDoNothing({ target: userKeys.userId });
    const row = await this.readRow(userId);
    if (row === null) {
      throw new EnvelopeError('user_keys row vanished after insert');
    }
    // Unwrap rather than reuse `dek`: if another request won the insert, its DEK is the one on
    // disk and the extractable key generated here must never be used.
    return this.unwrapRow(row);
  }

  async encrypt(
    userId: string,
    table: string,
    column: string,
    rowId: string,
    plaintext: Uint8Array | string,
  ): Promise<EncryptedValue> {
    const { dek, kekVersion } = await this.dekFor(userId);
    const bytes = typeof plaintext === 'string' ? utf8(plaintext) : plaintext;
    return {
      ciphertext: await encryptWithDek(dek, bytes, aadFor(table, column, rowId)),
      keyVersion: kekVersion,
    };
  }

  async decrypt(
    userId: string,
    table: string,
    column: string,
    rowId: string,
    value: EncryptedValue,
  ): Promise<Uint8Array<ArrayBuffer>> {
    if (!Number.isInteger(value.keyVersion) || value.keyVersion < 1) {
      throw new EnvelopeError(`invalid key version ${String(value.keyVersion)}`);
    }
    // The column's version must still be one this Worker knows: a value written under a KEK
    // that has since been retired is a rotation that was not finished, and the loud failure is
    // the point (rejects with UnknownKeyVersionError).
    await this.keys.getKek(value.keyVersion);
    const row = await this.readRow(userId);
    if (row === null) {
      throw new EnvelopeError('no user_keys row for this user');
    }
    const { dek } = await this.unwrapRow(row);
    return decryptWithDek(dek, value.ciphertext, aadFor(table, column, rowId));
  }

  /** Re-wraps the user's DEK under `toVersion`. Ciphertexts are untouched. */
  async rotateKek(userId: string, toVersion: number): Promise<void> {
    const row = await this.readRow(userId);
    if (row === null) {
      return;
    }
    if (row.kekVersion === toVersion) {
      return;
    }
    const [fromKek, toKek] = await Promise.all([
      this.keys.getKek(row.kekVersion),
      this.keys.getKek(toVersion),
    ]);
    // An extractable copy is needed for the re-wrap: unwrap with `extractable: true` here only.
    const dek = await crypto.subtle.unwrapKey(
      'raw',
      row.wrappedDek,
      fromKek,
      'AES-KW',
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    const wrapped = await wrapDek(dek, toKek);
    await this.db
      .update(userKeys)
      .set({ wrappedDek: wrapped, kekVersion: toVersion, rotatedAt: new Date().toISOString() })
      .where(eq(userKeys.userId, userId));
  }

  private async readRow(
    userId: string,
  ): Promise<{ wrappedDek: Uint8Array; kekVersion: number } | null> {
    const rows = await this.db
      .select({ wrappedDek: userKeys.wrappedDek, kekVersion: userKeys.kekVersion })
      .from(userKeys)
      .where(eq(userKeys.userId, userId))
      .limit(1);
    return rows[0] ?? null;
  }

  private async unwrapRow(row: { wrappedDek: Uint8Array; kekVersion: number }): Promise<UserDek> {
    const kek = await this.keys.getKek(row.kekVersion);
    return { dek: await unwrapDek(row.wrappedDek, kek), kekVersion: row.kekVersion };
  }
}
