/**
 * Increment 16, rulings C1 and C4 (src/lib/push.ts): the permission flow (granted, provisional,
 * denied, asked once), the request that checks first and asks for alert and sound only, the token
 * read that never asks, and the two Android channels created before any prompt.
 *
 * The review round: both records written after their outcome (N5: a request that threw has not
 * asked; the pre-prompt offer counts once shown, and only once), one channel failing without
 * costing the other (N4), and the link to the app's own notification settings (N3).
 */

import * as Sentry from '@sentry/react-native';
import { ANDROID_CHANNEL_IDS } from '@planeahead/shared';
import { AndroidImportance } from 'expo-notifications';
import { Linking, Platform } from 'react-native';
import { KV_KEYS, kv } from '../src/lib/db/kv';
import {
  PUSH_TOKEN_TIMEOUT_MS,
  ensureAndroidChannels,
  openNotificationSettings,
  permissionOf,
  readDevicePushToken,
  readPushPermission,
  requestPushPermission,
  takePushPromptOffer,
} from '../src/lib/push';
import {
  fakeNotifications,
  permissionStatus,
  resetFakeNotifications,
} from './support/fake-notifications';

jest.mock('expo-notifications', () =>
  jest
    .requireActual<typeof import('./support/fake-notifications')>('./support/fake-notifications')
    .fakeNotificationsModule(),
);

jest.mock('../src/lib/db/kv', () =>
  jest.requireActual<typeof import('./support/memory-kv')>('./support/memory-kv').memoryKvModule(),
);

/** The build's config, as expo-constants hands it over: the Android package (review N3). */
const mockExpoConfig: { android?: { package?: string } } = {};
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    get expoConfig() {
      return mockExpoConfig;
    },
  },
}));

/** The fake module itself, for the calls a test makes fail. */
const notifications = jest.requireMock<typeof import('expo-notifications')>('expo-notifications');

// iOS `ios.status`: 0 not determined, 1 denied, 2 authorized, 3 provisional.
const IOS_GRANTED = permissionStatus({ status: 'granted', granted: true, iosStatus: 2 });
// Expo reports provisional as not granted (R2 fact 8).
const IOS_PROVISIONAL = permissionStatus({ status: 'undetermined', granted: false, iosStatus: 3 });
const IOS_DENIED = permissionStatus({ status: 'denied', canAskAgain: false, iosStatus: 1 });
const IOS_UNDETERMINED = permissionStatus({ iosStatus: 0 });

/** Android, at an API level (Android 14 unless said). */
function onAndroid(apiLevel = 34): () => void {
  const original = Platform.OS;
  const originalVersion = Platform.Version;
  Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'android' });
  Object.defineProperty(Platform, 'Version', { configurable: true, get: () => apiLevel });
  return () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => original });
    Object.defineProperty(Platform, 'Version', { configurable: true, get: () => originalVersion });
  };
}

beforeEach(() => {
  resetFakeNotifications();
  kv.removeItemSync(KV_KEYS.pushPromptOffered);
  kv.removeItemSync(KV_KEYS.pushPermissionRequested);
  delete mockExpoConfig.android;
});

describe('the permission state (ruling C1)', () => {
  it.each([
    ['authorized', IOS_GRANTED, { state: 'granted', canAsk: false }],
    [
      'provisional, a quiet grant and never prompted over',
      IOS_PROVISIONAL,
      { state: 'provisional', canAsk: false },
    ],
    ['denied', IOS_DENIED, { state: 'denied', canAsk: false }],
    ['not determined', IOS_UNDETERMINED, { state: 'undetermined', canAsk: true }],
  ])('iOS %s', async (_name, status, expected) => {
    fakeNotifications.permission = status;
    await expect(readPushPermission()).resolves.toEqual(expected);
  });

  it('Android: denied before the first request is undetermined, and denied after it', () => {
    // Android 13 and later answer `denied` while notifications are off, asked or not.
    const notYet = permissionStatus({ status: 'denied', canAskAgain: true });
    expect(permissionOf(notYet, false)).toEqual({ state: 'undetermined', canAsk: true });
    expect(permissionOf(notYet, true)).toEqual({ state: 'denied', canAsk: false });
    const blocked = permissionStatus({ status: 'denied', canAskAgain: false });
    expect(permissionOf(blocked, false)).toEqual({ state: 'denied', canAsk: false });
    const granted = permissionStatus({ status: 'granted', granted: true });
    expect(permissionOf(granted, true)).toEqual({ state: 'granted', canAsk: false });
  });
});

describe('the request (ruling C1)', () => {
  it.each([
    ['granted', IOS_GRANTED],
    ['provisional', IOS_PROVISIONAL],
    ['denied', IOS_DENIED],
  ])('checks first, and does not ask when %s', async (_name, status) => {
    fakeNotifications.permission = status;
    await requestPushPermission();
    expect(fakeNotifications.calls).toEqual(['getPermissions']);
    expect(kv.getItemSync(KV_KEYS.pushPermissionRequested)).toBeNull();
  });

  it('asks for alert and sound only (no badge, no provisional) when not determined', async () => {
    fakeNotifications.permission = IOS_UNDETERMINED;
    fakeNotifications.answer = IOS_GRANTED;
    await expect(requestPushPermission()).resolves.toEqual({ state: 'granted', canAsk: false });
    expect(fakeNotifications.calls).toEqual(['getPermissions', 'request']);
    expect(fakeNotifications.requests).toEqual([
      {
        ios: { allowAlert: true, allowSound: true, allowBadge: false, allowProvisional: false },
        android: {},
      },
    ]);
  });

  it('answers what the prompt answered, and a refusal is not asked again', async () => {
    fakeNotifications.permission = IOS_UNDETERMINED;
    fakeNotifications.answer = IOS_DENIED;
    await expect(requestPushPermission()).resolves.toEqual({ state: 'denied', canAsk: false });
    await requestPushPermission();
    expect(fakeNotifications.calls.filter((call) => call === 'request')).toHaveLength(1);
  });

  it('Android asks once: after a refusal it is denied, though the system would ask again', async () => {
    const restore = onAndroid();
    try {
      fakeNotifications.permission = permissionStatus({ status: 'denied', canAskAgain: true });
      fakeNotifications.answer = permissionStatus({ status: 'denied', canAskAgain: true });
      await expect(requestPushPermission()).resolves.toEqual({ state: 'denied', canAsk: false });
      await expect(readPushPermission()).resolves.toEqual({ state: 'denied', canAsk: false });
      await requestPushPermission();
      expect(fakeNotifications.calls.filter((call) => call === 'request')).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it('records the ask once the request has answered: one that threw can ask again (N5)', async () => {
    const restore = onAndroid();
    try {
      fakeNotifications.permission = permissionStatus({ status: 'denied', canAskAgain: true });
      jest
        .spyOn(notifications, 'requestPermissionsAsync')
        .mockRejectedValueOnce(new Error('no current activity'));
      await expect(requestPushPermission()).rejects.toThrow('no current activity');
      expect(kv.getItemSync(KV_KEYS.pushPermissionRequested)).toBeNull();
      // Still undetermined: Settings and the pre-prompt can still ask.
      await expect(readPushPermission()).resolves.toEqual({ state: 'undetermined', canAsk: true });
      await requestPushPermission();
      expect(fakeNotifications.calls.filter((call) => call === 'request')).toHaveLength(1);
      expect(kv.getItemSync(KV_KEYS.pushPermissionRequested)).toBe('1');
    } finally {
      restore();
    }
  });
});

describe('the pre-prompt is offered once (ruling C1)', () => {
  it('while the system prompt can still show, and never again', async () => {
    fakeNotifications.permission = IOS_UNDETERMINED;
    const show = jest.fn(() => true);
    await expect(takePushPromptOffer(show)).resolves.toBe(true);
    await expect(takePushPromptOffer(show)).resolves.toBe(false);
    expect(show).toHaveBeenCalledTimes(1);
    // The second answer comes from the record alone.
    expect(fakeNotifications.calls).toEqual(['getPermissions']);
  });

  it('counts only once shown: a screen gone before it leaves it for the next add (N5)', async () => {
    fakeNotifications.permission = IOS_UNDETERMINED;
    await expect(takePushPromptOffer(() => false)).resolves.toBe(false);
    expect(kv.getItemSync(KV_KEYS.pushPromptOffered)).toBeNull();
    await expect(takePushPromptOffer(() => true)).resolves.toBe(true);
    expect(kv.getItemSync(KV_KEYS.pushPromptOffered)).toBe('1');
  });

  it('two adds that succeed at once show it once', async () => {
    fakeNotifications.permission = IOS_UNDETERMINED;
    const show = jest.fn(() => true);
    await expect(
      Promise.all([takePushPromptOffer(show), takePushPromptOffer(show)]),
    ).resolves.toEqual([true, false]);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['granted', IOS_GRANTED],
    ['provisional', IOS_PROVISIONAL],
    ['denied', IOS_DENIED],
  ])('not when %s, which records nothing', async (_name, status) => {
    fakeNotifications.permission = status;
    const show = jest.fn(() => true);
    await expect(takePushPromptOffer(show)).resolves.toBe(false);
    expect(show).not.toHaveBeenCalled();
    expect(kv.getItemSync(KV_KEYS.pushPromptOffered)).toBeNull();
  });
});

describe('the token read (ruling C2)', () => {
  it('reads the raw APNs or FCM token, and never asks for permission', async () => {
    fakeNotifications.permission = IOS_UNDETERMINED;
    fakeNotifications.token = { type: 'ios', data: 'ab12cd34' };
    await expect(readDevicePushToken()).resolves.toEqual({
      kind: 'token',
      tokenKind: 'apns',
      token: 'ab12cd34',
    });
    fakeNotifications.token = { type: 'android', data: 'fcm-token' };
    await expect(readDevicePushToken()).resolves.toEqual({
      kind: 'token',
      tokenKind: 'fcm',
      token: 'fcm-token',
    });
    expect(fakeNotifications.calls).toEqual(['getToken', 'getToken']);
  });

  it('is unavailable when the read fails or has not answered in time', async () => {
    fakeNotifications.token = new Error('Unable to get Firebase Messaging instance');
    await expect(readDevicePushToken()).resolves.toEqual({
      kind: 'unavailable',
      reason: 'Unable to get Firebase Messaging instance',
    });
    jest.useFakeTimers();
    try {
      fakeNotifications.token = 'pending';
      const read = readDevicePushToken();
      await jest.advanceTimersByTimeAsync(PUSH_TOKEN_TIMEOUT_MS);
      await expect(read).resolves.toEqual({
        kind: 'unavailable',
        reason: `no token after ${String(PUSH_TOKEN_TIMEOUT_MS)} ms`,
      });
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('the Android channels (ruling C4)', () => {
  const CHANNELS = [
    {
      id: ANDROID_CHANNEL_IDS.flightChanges,
      channel: { name: 'Flight changes', importance: AndroidImportance.HIGH },
    },
    {
      id: ANDROID_CHANNEL_IDS.flightDelays,
      channel: { name: 'Delays', importance: AndroidImportance.HIGH },
    },
  ];

  it('are created at start-up, HIGH, from ANDROID_CHANNEL_IDS', async () => {
    const restore = onAndroid();
    try {
      await ensureAndroidChannels();
      expect(fakeNotifications.channels).toEqual(CHANNELS);
      expect(fakeNotifications.calls).toEqual(['channel:flight_changes', 'channel:flight_delays']);
    } finally {
      restore();
    }
  });

  it('exist before the permission request asks', async () => {
    const restore = onAndroid();
    try {
      fakeNotifications.permission = permissionStatus({ status: 'denied', canAskAgain: true });
      await requestPushPermission();
      expect(fakeNotifications.calls).toEqual([
        'channel:flight_changes',
        'channel:flight_delays',
        'getPermissions',
        'request',
      ]);
    } finally {
      restore();
    }
  });

  it('are not created on iOS', async () => {
    await ensureAndroidChannels();
    fakeNotifications.permission = IOS_UNDETERMINED;
    await requestPushPermission();
    expect(fakeNotifications.channels).toEqual([]);
  });

  it('one that fails does not cost the other, and is reported (N4)', async () => {
    const restore = onAndroid();
    try {
      const failure = new Error('channel refused');
      jest.spyOn(notifications, 'setNotificationChannelAsync').mockRejectedValueOnce(failure);
      await expect(ensureAndroidChannels()).resolves.toBeUndefined();
      expect(fakeNotifications.channels).toEqual([CHANNELS[1]]);
      expect(Sentry.captureException).toHaveBeenCalledWith(failure);
    } finally {
      restore();
    }
  });
});

describe("the link to the app's notification settings (review N3)", () => {
  it('iOS opens them through UIKit’s notification settings URL', async () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue();
    await openNotificationSettings();
    expect(openURL).toHaveBeenCalledWith('app-settings:notifications');
    expect(openSettings).not.toHaveBeenCalled();
  });

  it('Android 8 and later send the app notification settings intent, naming the package', async () => {
    const restore = onAndroid(26);
    try {
      mockExpoConfig.android = { package: 'app.planeahead.mobile.preview' };
      const sendIntent = jest.spyOn(Linking, 'sendIntent').mockResolvedValue();
      const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue();
      await openNotificationSettings();
      expect(sendIntent).toHaveBeenCalledWith('android.settings.APP_NOTIFICATION_SETTINGS', [
        { key: 'android.provider.extra.APP_PACKAGE', value: 'app.planeahead.mobile.preview' },
      ]);
      expect(openSettings).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it.each([
    ['Android 7 (API 25)', 25, 'app.planeahead.mobile', false],
    ['no package in the config', 34, undefined, false],
    ['an intent the system refuses', 34, 'app.planeahead.mobile', true],
  ] as const)(
    'opens the app settings page instead: %s',
    async (_name, api, appPackage, refused) => {
      const restore = onAndroid(api);
      try {
        mockExpoConfig.android = appPackage === undefined ? {} : { package: appPackage };
        const sendIntent = jest
          .spyOn(Linking, 'sendIntent')
          .mockImplementation(() =>
            refused ? Promise.reject(new Error('Could not launch Intent')) : Promise.resolve(),
          );
        const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue();
        await openNotificationSettings();
        expect(sendIntent).toHaveBeenCalledTimes(refused ? 1 : 0);
        expect(openSettings).toHaveBeenCalledTimes(1);
      } finally {
        restore();
      }
    },
  );

  it('never throws: the iOS link refused, then the settings page too, each reported', async () => {
    jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('refused'));
    jest.spyOn(Linking, 'openSettings').mockRejectedValue(new Error('also refused'));
    await expect(openNotificationSettings()).resolves.toBeUndefined();
    expect(Sentry.captureException).toHaveBeenCalledTimes(2);
  });
});
