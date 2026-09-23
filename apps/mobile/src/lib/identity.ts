/**
 * The two per-installation identifiers (ADR 0005). Both are random v4 UUIDs created on first use
 * and kept in the kv-store until the app is deleted; neither is derived from the device.
 *
 * - `installId` names this installation to the API: `POST /v1/devices` registers it under the
 *   signed-in (or anonymous) user, and it rides on every request as `X-Install-Id`, where it
 *   scopes an anonymous caller's idempotency keys.
 * - `analyticsId` is the install-scoped id of `POST /v1/events`. It is a separate value on
 *   purpose: the install id is joined to the account in `devices`, and an analytics id equal to it
 *   would make every event linkable to a person. Declared in App Privacy as Device ID, not linked,
 *   purpose Analytics.
 */

import { randomUUID } from 'expo-crypto';
import { KV_KEYS, kv } from './db/kv';

function stableRandomId(key: string): string {
  const existing = kv.getItemSync(key);
  if (existing !== null && existing !== '') {
    return existing;
  }
  const created = randomUUID();
  kv.setItemSync(key, created);
  return created;
}

export function installId(): string {
  return stableRandomId(KV_KEYS.installId);
}

export function analyticsId(): string {
  return stableRandomId(KV_KEYS.analyticsId);
}
