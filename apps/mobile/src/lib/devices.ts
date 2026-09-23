/**
 * `POST /v1/devices`: registers this installation under the current (possibly anonymous) user.
 * Called after every sign-in and on launch; the API upserts on `(user_id, install_id)`, so a
 * repeat is cheap. The same install id rides on every request as `X-Install-Id`.
 */

import { isDevice, modelName, osVersion } from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import type { ApiClient } from './api-client';
import { ApiError } from './api-client';
import { runtimeConfig } from './config';
import { installId } from './identity';
import type { PushTokenKind } from './push';

export interface PushRegistration {
  readonly kind: PushTokenKind;
  readonly token: string;
}

function text(value: string | null | undefined, max: number): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed.slice(0, max);
}

export async function registerDevice(api: ApiClient, push?: PushRegistration): Promise<void> {
  const platform = Platform.OS === 'ios' ? 'ios' : 'android';
  const osVersionText = text(osVersion ?? String(Platform.Version), 64);
  const appVersion = text(Constants.expoConfig?.version, 64);
  const model = text(isDevice ? modelName : `${modelName ?? 'unknown'} (simulator)`, 128);
  const locale = text(Intl.DateTimeFormat().resolvedOptions().locale, 32);
  const timezone = text(Intl.DateTimeFormat().resolvedOptions().timeZone, 64);
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
      // APNs only, from the build's `aps-environment` entitlement, which follows its signing:
      // development builds register with the sandbox, ad hoc preview and store builds with
      // production (app.config.ts). FCM has no environment.
      ...(push?.kind === 'apns'
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
}
