/**
 * The pushes of the session user, in the `(app)` layout (increment 16, rulings C6 and C7): a push
 * received in the foreground that names a flight syncs the store, so whatever shows that flight
 * updates in place; and the tap the root layout took (src/lib/push-notifications.ts) is routed
 * once there is a session, then cleared. Apart from src/lib/push-notifications.ts so the detail
 * screen, which uses that module, does not load the session's.
 */

import * as Sentry from '@sentry/react-native';
import { addNotificationReceivedListener, clearLastNotificationResponse } from 'expo-notifications';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { readFlight } from './flight-queries';
import { flightInFrontId, pushFlightId, routeTap, usePendingTap } from './push-notifications';
import { services } from './services';
import { syncNow } from './session';

export function usePushRouting(userId: string | null): void {
  const router = useRouter();
  const tap = usePendingTap((state) => state.tap);

  useEffect(() => {
    if (userId === null) {
      return undefined;
    }
    const subscription = addNotificationReceivedListener((notification) => {
      if (pushFlightId(notification.request.content.data) !== null) {
        void syncNow(userId);
      }
    });
    return () => {
      subscription.remove();
    };
  }, [userId]);

  useEffect(() => {
    if (userId === null || tap === null) {
      return;
    }
    usePendingTap.setState({ tap: null });
    clearLastNotificationResponse();
    routeTap(tap.flightId, {
      knows: async (id) => readFlight((await services()).store.sqlite, id) !== null,
      sync: () => syncNow(userId),
      open: (id) => {
        if (flightInFrontId() === id) {
          // Already in front: the sync refreshes it in place.
          void syncNow(userId);
          return;
        }
        router.push({ pathname: '/flight/[id]', params: { id } });
      },
      home: () => {
        router.navigate('/');
      },
    }).catch((error: unknown) => {
      Sentry.captureException(error);
    });
  }, [userId, tap, router]);
}
