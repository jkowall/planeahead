/**
 * Registration on every launch and rotation (increment 16, ruling C2; R2 design 4 and 15).
 *
 * On each session start and each return to the foreground (src/lib/session.ts), and after a
 * permission request answers, the app reads its notification permission and its device token and
 * registers both with `POST /v1/devices` (src/lib/devices.ts adds the app id). Apple says to
 * register on every launch and never to cache a token (R2 fact 24); FCM rotates on its own.
 *
 * Every state registers the token, denied and undetermined included: the API keeps a permission
 * only on a token row and ignores one sent without a token (apps/api/src/routes/devices.ts), and
 * `notify` skips a token whose state is denied or undetermined (apps/api/src/notify/recipients.ts).
 * So a permission turned off in the system settings reaches the server at the next foreground,
 * instead of the row staying `granted` and being sent to (which Android deprioritizes, R2 fact
 * 20). Reading a token needs no permission on either platform (R2 facts 22 and 24). Without a
 * token (no Firebase config, a failed read) the device still registers, without one.
 *
 * `addPushTokenListener` re-registers on rotation. It also fires on every successful read (R2 fact
 * 23), and reading from inside it can loop, so: a token equal to the last one read or registered
 * is ignored, any other is debounced (`TOKEN_DEBOUNCE_MS`) and then registered as the listener
 * carried it, without a read. One registration runs at a time, and a trigger during it runs one
 * more after it (on iOS a second concurrent read rejects the first, R2 fact 21).
 *
 * Sign-out (review A3, src/lib/sign-out.ts). `reset()` starts a new epoch: a run that began before
 * it posts nothing of what it read, checked before it calls `registerDevice` (which first settles
 * a queued call, so a POST already under way is the server's to refuse: after the invalidation the
 * session is gone and it answers 401). `pause()` closes registration until the session is cleared:
 * nothing starts, and the token listener is ignored. And a run first settles a token deletion
 * that a sign-out left owed (`beforeRead`, src/lib/device-invalidation.ts `tokenDeletion`),
 * before it reads a token, so a deletion can never kill the token the new session registers.
 */

import * as Sentry from '@sentry/react-native';
import type { DevicePushToken } from 'expo-notifications';
import { tokenDeletion } from './device-invalidation';
import { registerDevice, type DeviceRegistrationResult, type PushRegistration } from './devices';
import {
  readDevicePushToken,
  readPushPermission,
  tokenRead,
  type PushPermission,
  type PushTokenRead,
} from './push';
import { services } from './services';

export const TOKEN_DEBOUNCE_MS = 1_000;

export type PushRegistrationNote = 'push_token_skipped' | 'push_token_unavailable';

export interface PushRegistrarDeps {
  readonly readPermission: () => Promise<PushPermission>;
  readonly readToken: () => Promise<PushTokenRead>;
  readonly register: (push?: PushRegistration) => Promise<DeviceRegistrationResult>;
  readonly onError: (error: unknown) => void;
  /** The API kept the device without the token (`pushTokenSkipped`), or there was no token. */
  readonly onNote?: (note: PushRegistrationNote, reason: string) => void;
  /** First in every run, before the permission and token reads (a sign-out's owed deletion). */
  readonly beforeRead?: () => Promise<void>;
  readonly debounceMs?: number;
}

export interface PushRegistrar {
  /** Registers the device with its token and permission; resolves when the runs are done. */
  register(): Promise<void>;
  /** The `addPushTokenListener` handler. */
  onToken(token: DevicePushToken): void;
  /**
   * Cancels a debounced token and a queued run, forgets the last token, and keeps a run in flight
   * from posting what it read (a user change, sign-out, `forgetAccount`).
   */
  reset(): void;
  /** Sign-out: resets, and refuses every registration until as many `resume()` calls. */
  pause(): void;
  resume(): void;
  /** Resolves when the run in flight, if any, has finished. */
  idle(): Promise<void>;
}

export function createPushRegistrar(deps: PushRegistrarDeps): PushRegistrar {
  const debounceMs = deps.debounceMs ?? TOKEN_DEBOUNCE_MS;
  let running: Promise<void> | null = null;
  let again = false;
  /** A token the listener carried: the next run registers it instead of reading one. */
  let carried: PushTokenRead | null = null;
  /** The token last read or registered, whose echo the listener ignores. */
  let lastToken: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped by `reset()`: a run posts only if none came since it began. */
  let epoch = 0;
  /** Open `pause()` calls: while any is, nothing registers. */
  let pauses = 0;

  async function once(): Promise<void> {
    const began = epoch;
    let push: PushRegistration | undefined;
    try {
      await deps.beforeRead?.();
      const permission = await deps.readPermission();
      // Taken before the read, so a token the listener carries meanwhile waits for the next run.
      const fromListener = carried;
      carried = null;
      const read = fromListener ?? (await deps.readToken());
      if (read.kind === 'token') {
        lastToken = read.token;
        push = { kind: read.tokenKind, token: read.token, permission: permission.state };
      } else {
        deps.onNote?.('push_token_unavailable', read.reason);
      }
    } catch (error) {
      deps.onError(error);
    }
    // A reset since this run began (a sign-out pauses with one): what it read is no one's now.
    if (began !== epoch) {
      return;
    }
    const result = await deps.register(push);
    if (!result.registered) {
      deps.onNote?.('push_token_skipped', result.reason);
    }
  }

  function reset(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    carried = null;
    lastToken = null;
    again = false;
    epoch += 1;
  }

  function register(): Promise<void> {
    if (pauses > 0) {
      return Promise.resolve();
    }
    if (running !== null) {
      again = true;
      return running;
    }
    running = (async () => {
      for (;;) {
        again = false;
        try {
          await once();
        } catch (error) {
          deps.onError(error);
        }
        // Cleared in the same turn as the check, so a trigger after it starts a new run.
        if (!again) {
          running = null;
          return;
        }
      }
    })();
    return running;
  }

  return {
    register,
    onToken(token) {
      const read = tokenRead(token);
      if (pauses > 0 || read.kind !== 'token' || read.token === lastToken) {
        return;
      }
      if (timer !== null) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        if (read.token !== lastToken) {
          carried = read;
          void register();
        }
      }, debounceMs);
    },
    reset,
    pause() {
      pauses += 1;
      reset();
    },
    resume() {
      pauses = Math.max(0, pauses - 1);
    },
    idle() {
      return running ?? Promise.resolve();
    },
  };
}

let app: PushRegistrar | null = null;

/** The app's registrar: expo's permission and token, `registerDevice` over the app's client. */
export function pushRegistrar(): PushRegistrar {
  app ??= createPushRegistrar({
    readPermission: readPushPermission,
    readToken: readDevicePushToken,
    register: async (push) => registerDevice((await services()).api, push),
    beforeRead: () => tokenDeletion().beforeRead(),
    onError: (error) => {
      Sentry.captureException(error);
    },
    onNote: (note, reason) => {
      // A skipped token is a device that cannot be reached: counted. No token is common in
      // builds without Firebase config: a breadcrumb.
      if (note === 'push_token_skipped') {
        Sentry.captureMessage(note, { level: 'warning', tags: { reason } });
      } else {
        Sentry.addBreadcrumb({ category: 'push', message: note, level: 'info', data: { reason } });
      }
    },
  });
  return app;
}
