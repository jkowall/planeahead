/**
 * `POST /v1/devices`: registers this installation under the current (possibly anonymous) user.
 * Called after every sign-in and on launch; the API upserts on `(user_id, install_id)`, so a
 * repeat is cheap. The same install id rides on every request as `X-Install-Id`.
 *
 * A 200 does not always mean the push token was stored: the API refuses to re-point a token
 * whose row belongs to another user's device from a different installation, and says so with
 * `pushTokenSkipped` (apps/api/src/routes/devices.ts). `registerDevice` returns that outcome
 * (increment 11 review, ruling Z4); increment 9's callers, which send no token or report nothing,
 * may ignore it.
 *
 * Increment 16. A token goes with the app id of this variant (its bundle or package id, the APNs
 * topic; ruling C2), and a device token with the notification permission the app holds, which
 * the API stores on the token and sends by. Every registration first settles a sign-out's queued
 * invalidation (ruling C3, src/lib/device-invalidation.ts), so none can precede it.
 */

import { AppIdSchema, type PushPermissionState } from '@planeahead/shared';
import { isDevice, modelName, osVersion } from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import type { ApiClient } from './api-client';
import { ApiError } from './api-client';
import { runtimeConfig } from './config';
import { settleQueuedInvalidation } from './device-invalidation';
import { installId } from './identity';
import type { PushTokenKind } from './push';

/**
 * The ActivityKit push-to-start token's kind (increment 11, ADR 0008), registered by
 * src/lib/live-activity/tokens.ts. `push_tokens` keeps one row per `(kind, token)`, so a rotated
 * token is a new row; the newest row of a device is its current token. Per-activity update
 * tokens are never sent here.
 */
export const LIVE_ACTIVITY_PUSH_TO_START_KIND = 'apns_live_activity_push_to_start';

export type DeviceTokenKind = PushTokenKind | typeof LIVE_ACTIVITY_PUSH_TO_START_KIND;

export interface PushRegistration {
  readonly kind: DeviceTokenKind;
  readonly token: string;
  /** A device token's notification permission (src/lib/push.ts); none for push-to-start. */
  readonly permission?: PushPermissionState;
}

/**
 * What `POST /v1/devices` did with the registration: `registered: false` when the API kept the
 * device row but skipped the push token, with the API's reason (`owned_by_another_user` today;
 * any newer reason is passed through as it came).
 */
export type DeviceRegistrationResult =
  { readonly registered: true } | { readonly registered: false; readonly reason: string };

/** Reads `pushTokenSkipped` from a 200 body; anything else is a stored registration. */
export function registrationResult(body: unknown): DeviceRegistrationResult {
  if (typeof body === 'object' && body !== null && 'pushTokenSkipped' in body) {
    const reason = body.pushTokenSkipped;
    if (typeof reason === 'string' && reason !== '') {
      return { registered: false, reason };
    }
  }
  return { registered: true };
}

/** Tokens minted by APNs, whose environment follows the build's `aps-environment`. */
function isApnsKind(kind: DeviceTokenKind): boolean {
  return kind === 'apns' || kind === LIVE_ACTIVITY_PUSH_TO_START_KIND;
}

/**
 * This variant's bundle id (iOS) or package name (Android), from the build's own config; absent
 * when unreadable, which the API takes as the production app's.
 */
function readAppId(): string | undefined {
  const config = Constants.expoConfig;
  const id = Platform.OS === 'ios' ? config?.ios?.bundleIdentifier : config?.android?.package;
  return AppIdSchema.safeParse(id).success ? id : undefined;
}

function text(value: string | null | undefined, max: number): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed.slice(0, max);
}

export async function registerDevice(
  api: ApiClient,
  push?: PushRegistration,
): Promise<DeviceRegistrationResult> {
  await settleQueuedInvalidation();
  const platform = Platform.OS === 'ios' ? 'ios' : 'android';
  const osVersionText = text(osVersion ?? String(Platform.Version), 64);
  const appVersion = text(Constants.expoConfig?.version, 64);
  const model = text(isDevice ? modelName : `${modelName ?? 'unknown'} (simulator)`, 128);
  const locale = text(Intl.DateTimeFormat().resolvedOptions().locale, 32);
  const timezone = text(Intl.DateTimeFormat().resolvedOptions().timeZone, 64);
  const variantAppId = readAppId();
  const response = await api.v1.devices.$post({
    json: {
      installId: installId(),
      platform,
      ...(osVersionText === undefined ? {} : { osVersion: osVersionText }),
      ...(appVersion === undefined ? {} : { appVersion }),
      ...(model === undefined ? {} : { model }),
      ...(locale === undefined ? {} : { locale }),
      ...(timezone === undefined ? {} : { timezone }),
      ...(push === undefined ? {} : { pushTokenKind: push.kind, pushToken: push.token }),
      ...(push === undefined || variantAppId === undefined ? {} : { appId: variantAppId }),
      ...(push?.permission === undefined ? {} : { pushPermission: push.permission }),
      // APNs tokens only (the device token and the Live Activity push-to-start token), from the
      // build's `aps-environment` entitlement, which follows its signing: development builds
      // register with the sandbox, ad hoc preview and store builds with production
      // (app.config.ts, plugins/withApsEnvironment.ts). FCM has no environment.
      ...(push !== undefined && isApnsKind(push.kind)
        ? {
            pushEnvironment:
              runtimeConfig().apnsEnvironment === 'production' ? 'production' : 'sandbox',
          }
        : {}),
    },
  });
  if (!response.ok) {
    throw new ApiError(response.status, await response.json().catch(() => null));
  }
  return registrationResult(await response.json().catch(() => null));
}
