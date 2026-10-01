/**
 * The server half of signing out, from the device (increment 16, ruling C3):
 * `POST /v1/devices/current/invalidate` before `authClient.signOut()`, and its queue when it cannot
 * be sent (src/lib/sign-out.ts runs the sequence).
 *
 * The route invalidates the CALLER's tokens for the installation (apps/api/src/routes/devices.ts),
 * so it has to go with the session being signed out of, never the one current at a retry: a
 * queued call keeps that session's cookie map, in SecureStore beside the session itself, and
 * replays it. One call is queued, the first: while it waits, every registration waits too
 * (`registerDevice` settles it first), so a later session has registered nothing from this
 * installation that a second entry would need, and the retry can never invalidate a token
 * registered after it (which it would if the same account signed back in).
 *
 * Retried on the next launch (src/app/_layout.tsx) and before every registration. A 2xx settles
 * it. It is dropped, and reported, on a 4xx other than 408 and 429 or once the cookies have all
 * expired (the session is gone, and a retry can do no more), and after three 408, 429 or 5xx
 * answers. A network failure or the timeout keeps it. The next online registration re-points the
 * token anyway (upserts are keyed by kind and token, plan section 5).
 */

import * as Sentry from '@sentry/react-native';
import { getCookie, storageAdapter } from '@better-auth/expo/client';
import { onlineManager } from '@tanstack/react-query';
import * as SecureStore from 'expo-secure-store';
import { z } from 'zod';
import { INSTALL_ID_HEADER } from './api-client';
import { runtimeConfig } from './config';

export const DEVICE_INVALIDATION_PATH = '/v1/devices/current/invalidate';
/** A sign-out waits at most this long for the call before queueing it. */
export const DEVICE_INVALIDATION_TIMEOUT_MS = 5_000;
/** 408, 429 and 5xx answers a queued call survives before it is dropped. */
export const DEVICE_INVALIDATION_MAX_FAILURES = 3;

const QueuedInvalidationSchema = z.object({
  installId: z.string().min(1),
  /** The signed-out session's cookie map as the Expo client stored it, expiries included. */
  cookies: z.string(),
  queuedAt: z.string(),
  failures: z.number().int().min(0),
});
export type QueuedInvalidation = z.infer<typeof QueuedInvalidationSchema>;

/** One value; an empty string is none. */
export interface InvalidationStorage {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
}

export interface DeviceInvalidationDeps {
  readonly baseUrl: () => string;
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly storage: InvalidationStorage;
  readonly isOnline: () => boolean;
  /** The `Cookie` header for a stored cookie map, expired cookies left out ('' for none). */
  readonly cookieHeader: (cookies: string) => string;
  readonly onDropped?: (reason: 'refused' | 'failures' | 'unreadable') => void;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

export type InvalidationOutcome = 'invalidated' | 'queued' | 'refused';

export interface DeviceInvalidation {
  /** At sign-out, with the session's cookie map: sent now, or queued (see the header). */
  invalidate(installId: string, cookies: string | null): Promise<InvalidationOutcome>;
  /** Sends a queued call; throws while it stays queued. Concurrent calls share one attempt. */
  settle(): Promise<void>;
}

type Answer = 'done' | 'refused' | 'retry';

export function createDeviceInvalidation(deps: DeviceInvalidationDeps): DeviceInvalidation {
  const timeoutMs = deps.timeoutMs ?? DEVICE_INVALIDATION_TIMEOUT_MS;
  const now = deps.now ?? (() => new Date());
  let settling: Promise<void> | null = null;

  /** One call with these cookies; throws on a network failure or the timeout. */
  async function send(installId: string, cookies: string): Promise<Answer> {
    const cookie = deps.cookieHeader(cookies);
    if (cookie === '') {
      return 'refused';
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      const response = await deps.fetch(`${deps.baseUrl()}${DEVICE_INVALIDATION_PATH}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Cookie: cookie,
          [INSTALL_ID_HEADER]: installId,
        },
        body: JSON.stringify({ installId }),
        credentials: 'omit',
        signal: controller.signal,
      });
      if (response.ok) {
        return 'done';
      }
      const { status } = response;
      return status === 408 || status === 429 || status >= 500 ? 'retry' : 'refused';
    } finally {
      clearTimeout(timer);
    }
  }

  async function read(): Promise<QueuedInvalidation | null> {
    const raw = await deps.storage.read();
    if (raw === null || raw === '') {
      return null;
    }
    try {
      const parsed = QueuedInvalidationSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        return parsed.data;
      }
    } catch {
      // Not JSON: dropped below, like a record of the wrong shape.
    }
    await deps.storage.write('');
    deps.onDropped?.('unreadable');
    return null;
  }

  async function attempt(): Promise<void> {
    const queued = await read();
    if (queued === null) {
      return;
    }
    const answer = await send(queued.installId, queued.cookies);
    if (answer === 'retry') {
      const failures = queued.failures + 1;
      if (failures < DEVICE_INVALIDATION_MAX_FAILURES) {
        await deps.storage.write(JSON.stringify({ ...queued, failures }));
        throw new Error(`the queued device invalidation failed (${String(failures)})`);
      }
      deps.onDropped?.('failures');
    } else if (answer === 'refused') {
      deps.onDropped?.('refused');
    }
    await deps.storage.write('');
  }

  return {
    async invalidate(installId, cookies) {
      if (cookies === null || deps.cookieHeader(cookies) === '') {
        return 'refused';
      }
      if (deps.isOnline()) {
        try {
          const answer = await send(installId, cookies);
          if (answer !== 'retry') {
            return answer === 'done' ? 'invalidated' : 'refused';
          }
        } catch {
          // Offline after all, or the timeout: queued below.
        }
      }
      if ((await read()) === null) {
        const queued: QueuedInvalidation = {
          installId,
          cookies,
          queuedAt: now().toISOString(),
          failures: 0,
        };
        await deps.storage.write(JSON.stringify(queued));
      }
      return 'queued';
    },
    settle() {
      settling ??= attempt().finally(() => {
        settling = null;
      });
      return settling;
    },
  };
}

/**
 * SecureStore through the Expo client's chunked adapter: a cookie map with Better Auth's cookie
 * cache can pass SecureStore's 2,048-byte value limit (src/lib/auth-client.ts keeps the session
 * the same way).
 */
const QUEUE_KEY = 'planeahead_device_invalidation';
const secureStorage = storageAdapter(SecureStore);

let app: DeviceInvalidation | null = null;

/** The app's instance: the API origin, the platform `fetch`, SecureStore, the online state. */
export function deviceInvalidation(): DeviceInvalidation {
  app ??= createDeviceInvalidation({
    baseUrl: () => runtimeConfig().apiUrl,
    fetch: (url, init) => fetch(url, init),
    storage: {
      read: () => secureStorage.getItemAsync(QUEUE_KEY),
      write: (value) => secureStorage.setItemAsync(QUEUE_KEY, value),
    },
    isOnline: () => onlineManager.isOnline(),
    cookieHeader: getCookie,
    onDropped: (reason) => {
      Sentry.captureMessage('device_invalidation_dropped', { level: 'warning', tags: { reason } });
    },
  });
  return app;
}

/** What every registration waits for first (src/lib/devices.ts). */
export function settleQueuedInvalidation(): Promise<void> {
  return deviceInvalidation().settle();
}
