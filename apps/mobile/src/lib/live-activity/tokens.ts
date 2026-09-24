/**
 * Live Activity tokens, as far as Phase 0 goes (increment 11, ruling V5, ADR 0008).
 *
 * Two kinds of ActivityKit push token exist, and they are stored differently:
 *
 * - The PUSH-TO-START token: one per installation (per `ActivityAttributes` type), rotating
 *   rarely. It lets the server START the flight Live Activity by push (Phase 1), so it is
 *   registered with `POST /v1/devices` under the kind `apns_live_activity_push_to_start`,
 *   through the same devices module as the device token (src/lib/devices.ts: the install id in
 *   the body and in `X-Install-Id`, the APNs environment from the build's signing, a direct call
 *   rather than the outbox, exactly like increment 9's registration). expo-widgets emits the
 *   current token as soon as the listener is added and again whenever it changes; each emission
 *   is posted, so a sign-in as another user re-registers it for that user.
 * - PER-ACTIVITY update tokens: N per device, rotating during an activity, with a server
 *   obligation to invalidate the old one. `push_tokens` cannot represent them; they belong to
 *   `live_activities` in Phase 1. Phase 0 logs that one arrived (the activity id, never the
 *   token) and discards it.
 *
 * iOS only: expo-widgets' Android side has no Live Activities. Importing `widgets/` also registers
 * the placeholder widget and the flight Live Activity layouts with the App Group, which a
 * push-started activity needs before it can render.
 *
 * No token value is ever logged: breadcrumbs carry the length (push-to-start) or the activity id
 * (per-activity), and __tests__/live-activity-tokens.test.ts asserts it.
 */

import * as Sentry from '@sentry/react-native';
import { addPushToStartTokenListener } from 'expo-widgets';
import { useEffect } from 'react';
import { Platform } from 'react-native';
import { FlightActivity } from '../../../widgets';
import type { ApiClient } from '../api-client';
import { LIVE_ACTIVITY_PUSH_TO_START_KIND, registerDevice } from '../devices';
import { services } from '../services';

interface Subscription {
  remove(): void;
}

/** The two expo-widgets token streams this module listens to; tests substitute their own. */
export interface LiveActivityTokenSource {
  addPushToStartTokenListener(
    listener: (event: { activityPushToStartToken: string }) => void,
  ): Subscription;
  /** The flight Live Activities currently running (started by a push, in Phase 1). */
  flightActivities(): readonly {
    addPushTokenListener(
      listener: (event: { activityId: string; pushToken: string }) => void,
    ): Subscription;
  }[];
}

export interface LiveActivityTokenDeps {
  readonly source: LiveActivityTokenSource;
  readonly api: () => Promise<ApiClient>;
  /** A log line without any token value. */
  readonly log: (event: LiveActivityTokenEvent, data: Record<string, string | number>) => void;
  readonly onError: (error: unknown) => void;
}

export type LiveActivityTokenEvent =
  | 'live_activity_push_to_start_token_received'
  | 'live_activity_push_to_start_token_registered'
  | 'live_activity_update_token_discarded';

/** Starts both listeners; `remove()` stops them. */
export function startLiveActivityTokenListeners(deps: LiveActivityTokenDeps): Subscription {
  const subscriptions: Subscription[] = [];

  subscriptions.push(
    deps.source.addPushToStartTokenListener(({ activityPushToStartToken: token }) => {
      deps.log('live_activity_push_to_start_token_received', { length: token.length });
      void (async () => {
        try {
          await registerDevice(await deps.api(), {
            kind: LIVE_ACTIVITY_PUSH_TO_START_KIND,
            token,
          });
          deps.log('live_activity_push_to_start_token_registered', { length: token.length });
        } catch (error) {
          deps.onError(error);
        }
      })();
    }),
  );

  let activities: ReturnType<LiveActivityTokenSource['flightActivities']> = [];
  try {
    activities = deps.source.flightActivities();
  } catch (error) {
    // `getInstances` throws below iOS 16.2, where there are no Live Activities to listen to.
    deps.onError(error);
  }
  for (const activity of activities) {
    subscriptions.push(
      activity.addPushTokenListener(({ activityId }) => {
        // Discarded in Phase 0: a per-activity token belongs to `live_activities` (Phase 1).
        deps.log('live_activity_update_token_discarded', { activityId });
      }),
    );
  }

  return {
    remove() {
      for (const subscription of subscriptions.splice(0)) {
        subscription.remove();
      }
    },
  };
}

const EXPO_WIDGETS_SOURCE: LiveActivityTokenSource = {
  addPushToStartTokenListener,
  flightActivities: () => FlightActivity.getInstances(),
};

function breadcrumb(event: LiveActivityTokenEvent, data: Record<string, string | number>): void {
  Sentry.addBreadcrumb({ category: 'live_activity', message: event, level: 'info', data });
  if (__DEV__) {
    console.info(`[live-activity] ${event}`, data);
  }
}

/** Runs the listeners for the signed-in (or anonymous) user `userId`, on iOS. */
export function useLiveActivityTokens(userId: string | null): void {
  useEffect(() => {
    if (userId === null || Platform.OS !== 'ios') {
      return undefined;
    }
    const listeners = startLiveActivityTokenListeners({
      source: EXPO_WIDGETS_SOURCE,
      api: async () => (await services()).api,
      log: breadcrumb,
      onError: (error) => {
        Sentry.captureException(error);
      },
    });
    return () => {
      listeners.remove();
    };
  }, [userId]);
}
