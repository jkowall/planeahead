/**
 * PushAuth schema, migration 1 (increment 14). Append only: a later change is 002.
 *
 * One object per credential (`apns:sandbox`, `apns:production`, `fcm`), so each table holds at most
 * one row, keyed by the credential's name all the same so a row always says what it is:
 *
 *   - `credential`: the token this object serves, the fingerprint of the key material it was minted
 *     from, when it was minted (the 20-minute rule reads `minted_at_ms` after a restart, which is
 *     why it is stored rather than held in memory), when it stops being served, and how many
 *     tokens the object has minted.
 *   - `mint_failure`: the last mint or exchange that failed and why, for the admin page. Cleared
 *     by the next successful mint.
 */

export const PUSH_AUTH_MIGRATION_001: readonly string[] = [
  `CREATE TABLE credential (
    name TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    minted_at_ms INTEGER NOT NULL,
    not_after_ms INTEGER NOT NULL,
    mint_count INTEGER NOT NULL DEFAULT 0 CHECK (mint_count >= 0)
  )`,
  `CREATE TABLE mint_failure (
    name TEXT PRIMARY KEY,
    failure TEXT NOT NULL,
    at_ms INTEGER NOT NULL
  )`,
];
