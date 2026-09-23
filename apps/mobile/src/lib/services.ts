/**
 * The app's long-lived services, built once the offline store has migrated: the `/v1` client,
 * the sync client, the outbox and analytics, sharing one apply gate. Screens reach them through
 * `services()`; tests build their own from the factories.
 */

import * as Sentry from '@sentry/react-native';
import { createAnalytics, type Analytics } from './analytics';
import { createApiClient, type ApiClient } from './api-client';
import { authClient } from './auth-client';
import { runtimeConfig } from './config';
import { whenStoreReady, type Store } from './db/client';
import { KV_KEYS, kv } from './db/kv';
import { useFlightNotices } from './flight-notices';
import { flightOutboxHooks } from './flights';
import { analyticsId, installId } from './identity';
import { withPendingPatches } from './preference-mutations';
import { queryClient } from './query';
import { useSettings } from './settings';
import { createSyncClient, type SyncClient } from './sync/client';
import { ApplyGate } from './sync/gate';
import { createOutbox, type DrainResult } from './sync/outbox';
import { wipeLocalStore } from './sync/store';

export interface Services {
  readonly store: Store;
  readonly api: ApiClient;
  readonly gate: ApplyGate;
  readonly sync: SyncClient;
  readonly outbox: { drain(): Promise<DrainResult> };
  readonly analytics: Analytics;
}

/**
 * The local half of signing out, and what `401 account_deleted` ends in: the store and the
 * outbox are gone (the caller wiped them, or this does), the Better Auth client forgets its
 * cookies (its `/sign-out` hook clears SecureStore before the request is even sent, so it works
 * against a deleted account), and the settings fall back to the defaults. The root layout then
 * sees no session and routes to the sign-in group.
 */
export async function forgetAccount(store: Store | null): Promise<void> {
  if (store !== null) {
    wipeLocalStore(store.sqlite);
  }
  await authClient.signOut().catch(() => undefined);
  useSettings.getState().reset();
  useFlightNotices.getState().clear();
  kv.removeItemSync(KV_KEYS.appleUserId);
  kv.removeItemSync(KV_KEYS.pendingMagicLink);
  queryClient.clear();
}

let built: Promise<Services> | null = null;

function build(store: Store): Services {
  const config = runtimeConfig();
  const api = createApiClient({
    baseUrl: config.apiUrl,
    getCookie: () => authClient.getCookie(),
    getInstallId: installId,
  });
  const gate = new ApplyGate();
  const onAccountDeleted = () => forgetAccount(store);
  const sync = createSyncClient({
    db: store.sqlite,
    gate,
    transport: {
      async pull(cursor) {
        const response = await api.v1.sync.$get({ query: cursor === null ? {} : { cursor } });
        return { status: response.status, body: await response.json().catch(() => null) };
      },
    },
    onAccountDeleted,
    onPreferences: (preferences) => {
      // A toggle whose PATCH is still queued stays as the user set it (preference-mutations.ts).
      useSettings.getState().applyServerPreferences(withPendingPatches(store.sqlite, preferences));
    },
    onSkipped: (skipped) => {
      // Entity, id (a uuid, or a flight's position in the page) and the failing field: never a
      // value, never a flight key (it names an itinerary).
      Sentry.captureMessage('sync_rows_skipped', {
        level: 'warning',
        extra: { skipped: skipped.map(({ entity, id, field }) => `${entity}:${id}:${field}`) },
      });
    },
  });
  const flightHooks = flightOutboxHooks(store.sqlite);
  const outbox = createOutbox({
    db: store.sqlite,
    gate,
    transport: { send: (request) => api.request(request) },
    onAccountDeleted,
    onSent: flightHooks.onSent,
    onRefused: flightHooks.onRefused,
    onHookError: (item, error) => {
      Sentry.captureException(error, {
        extra: { hook: 'outbox_settle', method: item.method, path: item.path },
      });
    },
    onDropped: (dropped) => {
      // Method, path, status and code only: never the body (it names the flight).
      const { item, status, code } = dropped;
      Sentry.captureMessage('outbox_mutation_dropped', {
        level: 'warning',
        extra: { method: item.method, path: item.path, status, code },
      });
      flightHooks.notifyDropped(dropped);
    },
    onKeyRegenerated: (item) => {
      // A client bug by definition (the same key was sent with a different body); no body here.
      Sentry.captureMessage('outbox_idempotency_key_regenerated', {
        level: 'warning',
        extra: { method: item.method, path: item.path, attempts: item.attempts },
      });
    },
  });
  const analytics = createAnalytics({ baseUrl: config.apiUrl, analyticsId });
  return { store, api, gate, sync, outbox, analytics };
}

export function services(): Promise<Services> {
  built ??= whenStoreReady().then(build);
  return built;
}
