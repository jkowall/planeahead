/**
 * RevenueCat customer deletion (increment 8, ruling K8): a typed stub behind a flag that is OFF.
 *
 * `DELETE /v1/subscribers/{app_user_id}` is sufficient for erasure but not mandated, and it does
 * not cancel the store subscription (facts sheet section 3). Phase 0 has no RevenueCat project, so
 * account deletion calls this and records the answer in `audit_log`; with
 * `REVENUECAT_DELETE_ENABLED` unset or anything but `true` the answer is `disabled`, and with it
 * set the answer is still `not_implemented` until the Phase 1 billing increment supplies the
 * secret key and the HTTP call. The function never throws.
 */

import type { Env } from '../env';

export type RevenueCatDeletion =
  | {
      readonly attempted: false;
      readonly reason: 'disabled' | 'no_app_user_id' | 'not_implemented';
    }
  | { readonly attempted: true; readonly status: number };

export function revenueCatDeleteEnabled(env: Pick<Env, 'REVENUECAT_DELETE_ENABLED'>): boolean {
  return env.REVENUECAT_DELETE_ENABLED?.trim().toLowerCase() === 'true';
}

export function deleteRevenueCatCustomer(
  env: Pick<Env, 'REVENUECAT_DELETE_ENABLED'>,
  appUserIds: readonly string[],
): Promise<RevenueCatDeletion> {
  if (!revenueCatDeleteEnabled(env)) {
    return Promise.resolve({ attempted: false, reason: 'disabled' });
  }
  if (appUserIds.length === 0) {
    return Promise.resolve({ attempted: false, reason: 'no_app_user_id' });
  }
  return Promise.resolve({ attempted: false, reason: 'not_implemented' });
}
