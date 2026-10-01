/**
 * A stand-in for expo-notifications (increment 16): the permission, the device token, the
 * channels, the presented notifications and the three event streams, driven by the test, with
 * every call logged in order. Use it from a `jest.mock` factory:
 *
 *   jest.mock('expo-notifications', () =>
 *     jest
 *       .requireActual<typeof import('./support/fake-notifications')>('./support/fake-notifications')
 *       .fakeNotificationsModule(),
 *   );
 *
 * then drive `fakeNotifications` (call `resetFakeNotifications()` in `beforeEach`). The enums are
 * expo's own, from the modules that define them (importing the package itself warns about Expo Go
 * under jest-expo).
 */

import type {
  DevicePushToken,
  Notification,
  NotificationChannelInput,
  NotificationHandler,
  NotificationPermissionsRequest,
  NotificationPermissionsStatus,
  NotificationResponse,
} from 'expo-notifications';

type Listener<T> = (event: T) => void;

export interface FakeNotifications {
  /** What `getPermissionsAsync` answers. */
  permission: NotificationPermissionsStatus;
  /** What `requestPermissionsAsync` answers; it also becomes `permission`. */
  answer: NotificationPermissionsStatus;
  /** What `getDevicePushTokenAsync` resolves with, or rejects with; `pending` never settles. */
  token: DevicePushToken | Error | 'pending';
  presented: Notification[];
  /** How `dismissAllNotificationsAsync` ends: it empties `presented`, rejects, or never settles. */
  dismissAll: 'ok' | Error | 'pending';
  lastResponse: NotificationResponse | null;
  /** Every call, in order: `getPermissions`, `request`, `channel:<id>`, `getToken`, ... */
  calls: string[];
  requests: (NotificationPermissionsRequest | undefined)[];
  channels: { readonly id: string; readonly channel: NotificationChannelInput }[];
  handler: NotificationHandler | null;
  tokenListeners: Listener<DevicePushToken>[];
  receivedListeners: Listener<Notification>[];
  responseListeners: Listener<NotificationResponse>[];
}

/**
 * A permission answer in expo's shape: `status` is expo's `PermissionStatus`, whose values are
 * these strings; `iosStatus` is iOS's `ios.status`, and its absence means Android.
 */
export function permissionStatus(overrides: {
  readonly status?: 'granted' | 'denied' | 'undetermined';
  readonly granted?: boolean;
  readonly canAskAgain?: boolean;
  readonly iosStatus?: number;
}): NotificationPermissionsStatus {
  const { iosStatus, ...rest } = overrides;
  return {
    status: 'undetermined',
    granted: false,
    canAskAgain: true,
    expires: 'never',
    ...(iosStatus === undefined ? {} : { ios: { status: iosStatus } }),
    ...rest,
  } as unknown as NotificationPermissionsStatus;
}

function initial(): FakeNotifications {
  return {
    permission: permissionStatus({ iosStatus: 0 }),
    answer: permissionStatus({ status: 'granted', granted: true, iosStatus: 2 }),
    token: { type: 'ios', data: 'a1'.repeat(32) },
    presented: [],
    dismissAll: 'ok',
    lastResponse: null,
    calls: [],
    requests: [],
    channels: [],
    handler: null,
    tokenListeners: [],
    receivedListeners: [],
    responseListeners: [],
  };
}

export const fakeNotifications: FakeNotifications = initial();

export function resetFakeNotifications(): void {
  Object.assign(fakeNotifications, initial());
}

function subscribe<T>(listeners: Listener<T>[], listener: Listener<T>) {
  listeners.push(listener);
  return {
    remove: () => {
      const at = listeners.indexOf(listener);
      if (at >= 0) {
        listeners.splice(at, 1);
      }
    },
  };
}

export function fakeNotificationsModule() {
  const permissionTypes = jest.requireActual<
    typeof import('expo-notifications/build/NotificationPermissions.types')
  >('expo-notifications/build/NotificationPermissions.types');
  const channelTypes = jest.requireActual<
    typeof import('expo-notifications/build/NotificationChannelManager.types')
  >('expo-notifications/build/NotificationChannelManager.types');
  const f = fakeNotifications;
  return {
    __esModule: true,
    IosAuthorizationStatus: permissionTypes.IosAuthorizationStatus,
    AndroidImportance: channelTypes.AndroidImportance,
    getPermissionsAsync: () => {
      f.calls.push('getPermissions');
      return Promise.resolve(f.permission);
    },
    requestPermissionsAsync: (request?: NotificationPermissionsRequest) => {
      f.calls.push('request');
      f.requests.push(request);
      f.permission = f.answer;
      return Promise.resolve(f.answer);
    },
    // Like expo, a successful read also reaches the token listeners (R2 fact 23), here before
    // the caller's `await` resumes.
    getDevicePushTokenAsync: () => {
      f.calls.push('getToken');
      const token = f.token;
      if (token === 'pending') {
        return new Promise<never>(() => undefined);
      }
      if (token instanceof Error) {
        return Promise.reject(token);
      }
      const read = Promise.resolve(token);
      for (const listener of [...f.tokenListeners]) {
        listener(token);
      }
      return read;
    },
    unregisterForNotificationsAsync: () => {
      f.calls.push('unregister');
      return Promise.resolve();
    },
    setNotificationChannelAsync: (id: string, channel: NotificationChannelInput) => {
      f.calls.push(`channel:${id}`);
      f.channels.push({ id, channel });
      return Promise.resolve(null);
    },
    getPresentedNotificationsAsync: () => {
      f.calls.push('getPresented');
      return Promise.resolve([...f.presented]);
    },
    dismissNotificationAsync: (identifier: string) => {
      f.calls.push(`dismiss:${identifier}`);
      f.presented = f.presented.filter(({ request }) => request.identifier !== identifier);
      return Promise.resolve();
    },
    dismissAllNotificationsAsync: () => {
      f.calls.push('dismissAll');
      if (f.dismissAll === 'pending') {
        return new Promise<never>(() => undefined);
      }
      if (f.dismissAll instanceof Error) {
        return Promise.reject(f.dismissAll);
      }
      f.presented = [];
      return Promise.resolve();
    },
    getLastNotificationResponse: () => f.lastResponse,
    clearLastNotificationResponse: () => {
      f.calls.push('clearLastResponse');
      f.lastResponse = null;
    },
    setNotificationHandler: (handler: NotificationHandler | null) => {
      f.calls.push('setHandler');
      f.handler = handler;
    },
    addPushTokenListener: (listener: Listener<DevicePushToken>) =>
      subscribe(f.tokenListeners, listener),
    addNotificationReceivedListener: (listener: Listener<Notification>) =>
      subscribe(f.receivedListeners, listener),
    addNotificationResponseReceivedListener: (listener: Listener<NotificationResponse>) =>
      subscribe(f.responseListeners, listener),
  };
}

/** A presented or received push as expo hands it over. */
export function pushNotification(
  identifier: string,
  data: Record<string, unknown>,
  date = 1_790_000_000_000,
): Notification {
  return {
    date,
    request: {
      identifier,
      content: { title: 'Gate change', subtitle: null, body: 'Now B12.', data, sound: 'default' },
      trigger: { type: 'push' },
    },
  } as unknown as Notification;
}

/** A tap on `notification`. */
export function tapOn(notification: Notification): NotificationResponse {
  return { notification, actionIdentifier: 'expo.modules.notifications.actions.DEFAULT' };
}
