/**
 * The pushes the app receives (increment 16): foreground presentation (ruling C6), tap routing and
 * the dismissal of a flight's presented notifications when it opens (ruling C7).
 *
 * The app data of a push is flat strings (`PushDataV1`, packages/shared/src/push.ts): on iOS the
 * APNs `body` dictionary, which expo exposes as `content.data` (R2 fact 36); on Android the FCM
 * data map (R2 fact 37). Only `v` and `flightSubscriptionId` are read here, so a push of a kind
 * this build does not know still routes.
 *
 * Foreground (C6; R2 design 12). `setNotificationHandler` is installed once, at module scope of the
 * root layout: banner, list and sound, except for a push about the flight whose detail screen is
 * in front, which is not presented; its arrival syncs the store instead, as every foreground push
 * naming a flight does (src/lib/push-routing.ts), and the screen's live query shows the change in
 * place. The handler answers synchronously from memory, never the network: well inside expo's 3
 * seconds (R2 fact 33). While the session is known to be null it presents nothing (review A1): a
 * push still sent to a signed-out phone never banners over the sign-in screen.
 *
 * Taps (C7; R2 design 13). The root layout takes `getLastNotificationResponse()` at mount (a cold
 * start from a tap) and every response after; a tap waits in memory until a session exists, then
 * the `(app)` layout routes it to `/flight/{flightSubscriptionId}` (src/lib/push-routing.ts). A
 * flight the local store does not know triggers one sync, then opens, or the home screen if it is
 * still unknown. The response is cleared as it is taken, so a tap routes once.
 *
 * Dismissal (C7). Opening a flight removes its presented notifications: those whose data names it,
 * and those whose identifier is one of its collapse ids (`{kind}:{flightKey}`, one per kind). The
 * second is for Android, where a push FCM displayed itself (the app in the background) keeps its
 * data in the tap intent only: expo rebuilds it from the notification's own extras, without
 * `flightSubscriptionId`, and names it `expo-notifications://foreign_notifications?tag=...` after
 * its tag, the collapse id. On iOS a push's identifier is its collapse id (R2 fact 45).
 */

import * as Sentry from '@sentry/react-native';
import { NOTIFICATION_KINDS, PUSH_DATA_VERSION, pushCollapseId } from '@planeahead/shared';
import {
  addNotificationResponseReceivedListener,
  clearLastNotificationResponse,
  dismissNotificationAsync,
  getLastNotificationResponse,
  getPresentedNotificationsAsync,
  setNotificationHandler,
  type Notification,
  type NotificationBehavior,
  type NotificationResponse,
} from 'expo-notifications';
import { useIsFocused } from 'expo-router';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { z } from 'zod';
import { create } from 'zustand';

const RoutableData = z.looseObject({
  v: z.literal(PUSH_DATA_VERSION),
  flightSubscriptionId: z.uuid(),
});

/** The flight a push names, or null (none, or a data version this build does not read). */
export function pushFlightId(data: unknown): string | null {
  const parsed = RoutableData.safeParse(data);
  return parsed.success ? parsed.data.flightSubscriptionId : null;
}

/** The flight whose detail screen is in front (C6), set and released by that screen. */
let flightInFront: string | null = null;

export function flightInFrontId(): string | null {
  return flightInFront;
}

/** C6: what a push received in the foreground shows. Pure and synchronous. */
export function foregroundBehavior(
  notification: Notification,
  inFront: string | null,
): NotificationBehavior {
  const id = pushFlightId(notification.request.content.data);
  const show = id === null || id !== inFront;
  return {
    shouldShowBanner: show,
    shouldShowList: show,
    shouldPlaySound: show,
    shouldSetBadge: false,
  };
}

const NOT_PRESENTED: NotificationBehavior = {
  shouldShowBanner: false,
  shouldShowList: false,
  shouldPlaySound: false,
  shouldSetBadge: false,
};

/** True while the session is known to be null (not while it loads), from the root layout. */
let signedOut = false;

/** The root layout's word on the session (src/lib/session.ts `useSignedOutWork`). */
export function setSignedOut(value: boolean): void {
  signedOut = value;
}

let handlerInstalled = false;

/** Installs the foreground handler, once (the root layout calls it at module scope). */
export function installForegroundHandler(): void {
  if (handlerInstalled) {
    return;
  }
  handlerInstalled = true;
  setNotificationHandler({
    handleNotification: (notification) =>
      Promise.resolve(signedOut ? NOT_PRESENTED : foregroundBehavior(notification, flightInFront)),
  });
}

interface PendingTap {
  /** The notification's identifier and date: the same tap can come from both sources. */
  readonly key: string;
  readonly flightId: string;
}

/** The tap waiting for a session (C7). */
export const usePendingTap = create<{ readonly tap: PendingTap | null }>(() => ({ tap: null }));

let lastTapKey: string | null = null;

/** Takes a response: its flight waits for routing; one that names no flight is only cleared. */
export function takeResponse(response: NotificationResponse | null): void {
  if (response === null) {
    return;
  }
  const { request, date } = response.notification;
  const key = `${request.identifier}@${String(date)}`;
  if (key === lastTapKey) {
    return;
  }
  lastTapKey = key;
  const flightId = pushFlightId(request.content.data);
  if (flightId === null) {
    clearLastNotificationResponse();
    return;
  }
  usePendingTap.setState({ tap: { key, flightId } });
}

/** C7, in the root layout: the tap that launched the app, then every tap while it runs. */
export function useNotificationResponses(): void {
  useEffect(() => {
    takeResponse(getLastNotificationResponse());
    const subscription = addNotificationResponseReceivedListener(takeResponse);
    return () => {
      subscription.remove();
    };
  }, []);
}

export interface TapRoutes {
  /** Whether the local store has the flight. */
  readonly knows: (flightId: string) => Promise<boolean>;
  /** One sync for the session user. */
  readonly sync: () => Promise<void>;
  readonly open: (flightId: string) => void;
  readonly home: () => void;
}

export type TapOutcome = 'opened' | 'opened_after_sync' | 'home';

/** C7: a known flight opens; an unknown one gets one sync, then opens or goes home. */
export async function routeTap(flightId: string, routes: TapRoutes): Promise<TapOutcome> {
  if (await routes.knows(flightId)) {
    routes.open(flightId);
    return 'opened';
  }
  await routes.sync();
  if (await routes.knows(flightId)) {
    routes.open(flightId);
    return 'opened_after_sync';
  }
  routes.home();
  return 'home';
}

const FOREIGN_TAG = /^expo-notifications:\/\/foreign_notifications\?(?:[^#]*&)?tag=([^&#]*)/;

/** The tag of a notification expo did not present itself (Android), else the identifier. */
function tagOf(identifier: string): string {
  const encoded = FOREIGN_TAG.exec(identifier)?.[1];
  if (encoded === undefined) {
    return identifier;
  }
  try {
    return decodeURIComponent(encoded);
  } catch {
    return identifier;
  }
}

export interface PresentedNotifications {
  readonly list: () => Promise<Notification[]>;
  readonly dismiss: (identifier: string) => Promise<void>;
}

const EXPO_PRESENTED: PresentedNotifications = {
  list: getPresentedNotificationsAsync,
  dismiss: dismissNotificationAsync,
};

/** C7: removes the presented notifications of one flight (see the header); answers how many. */
export async function dismissFlightNotifications(
  flight: { readonly id: string; readonly flightKey: string },
  presented: PresentedNotifications = EXPO_PRESENTED,
): Promise<number> {
  const collapseIds = new Set(
    NOTIFICATION_KINDS.map((kind) =>
      pushCollapseId({ notificationKind: kind, flightKey: flight.flightKey, jobId: '' }),
    ),
  );
  const mine = (await presented.list()).filter(
    ({ request }) =>
      pushFlightId(request.content.data) === flight.id ||
      collapseIds.has(tagOf(request.identifier)),
  );
  await Promise.all(mine.map(({ request }) => presented.dismiss(request.identifier)));
  return mine.length;
}

/**
 * The flight detail screen (C6, C7): its flight is in front while the screen is focused, and its
 * presented notifications go when it opens or comes back into focus (once its key is loaded), and
 * when the app returns to the foreground on it: what the OS displayed meanwhile is in the tray,
 * and the screen already shows the change (review A6).
 */
export function useFlightInFront(id: string, flightKey: string | null): void {
  const focused = useIsFocused();

  useEffect(() => {
    if (!focused || id === '') {
      return undefined;
    }
    flightInFront = id;
    return () => {
      if (flightInFront === id) {
        flightInFront = null;
      }
    };
  }, [focused, id]);

  useEffect(() => {
    if (!focused || id === '' || flightKey === null) {
      return undefined;
    }
    const dismiss = () => {
      dismissFlightNotifications({ id, flightKey }).catch((error: unknown) => {
        Sentry.captureException(error);
      });
    };
    dismiss();
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        dismiss();
      }
    });
    return () => {
      subscription.remove();
    };
  }, [focused, id, flightKey]);
}
