/**
 * Settings: appearance (a device preference, persisted in the kv-store and so available offline
 * on the next launch), the account (upgrade, sign out, delete), notifications and what this build
 * talks to.
 *
 * Increment 10 (ruling T6): the units (metric, imperial) and time-format (12 h, 24 h) toggles.
 * They are the account's preferences: the settings store changes at once and persists through the
 * kv-store, and a `PATCH /v1/me/preferences` is queued through the outbox for the account and
 * its other devices (src/lib/preference-mutations.ts).
 *
 * Increment 16. Notifications show the permission state, read again on every return to the
 * foreground; "Turn on notifications" while the system prompt can still show, and the system
 * settings once it is denied (ruling C1). Registration no longer waits for this screen: it runs on
 * every launch and foreground (ruling C2). Sign out invalidates this installation's push tokens
 * first (ruling C3, src/lib/sign-out.ts).
 *
 * Ruling C11: the account's alerts switch (`pushEnabled`) and its five per-kind toggles, first gate
 * assignment off by default, taking the units' path: the settings store at once, then
 * `PATCH /v1/me/preferences` with `{ notifications }` through the outbox. They are the account's,
 * not this phone's, so they stay editable whatever the permission, beside the system settings link
 * while it is denied; with alerts off the five are greyed out and keep their values.
 */

import * as Sentry from '@sentry/react-native';
import {
  NOTIFICATION_EVENT_PREFERENCES,
  type NotificationEventPreference,
  type NotificationPreferencesPatch,
  type PushPermissionState,
} from '@planeahead/shared';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Alert, Linking } from 'react-native';
import { Body, Button, Screen, Section, Title, Toggle } from '../../components/ui';
import { errorCode } from '../../lib/api-client';
import { authClient, isAnonymousSession } from '../../lib/auth-client';
import { runtimeConfig } from '../../lib/config';
import type { SqliteLike } from '../../lib/db/sqlite-like';
import { unitSystemOf, unitSystemPatch, type TimeFormat, type UnitSystem } from '../../lib/format';
import {
  queueNotificationsPatch,
  queuePreferencesPatch,
  type PreferencesPatch,
} from '../../lib/preference-mutations';
import { requestPushPermission, usePushPermission } from '../../lib/push';
import { pushRegistrar } from '../../lib/push-registration';
import { forgetAccount, services } from '../../lib/services';
import { APPEARANCES, useSettings, type Appearance } from '../../lib/settings';
import { signOut } from '../../lib/sign-out';
import { pendingCount } from '../../lib/sync/outbox';

const APPEARANCE_LABELS: Readonly<Record<Appearance, string>> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

const UNIT_SYSTEMS: readonly { readonly value: UnitSystem; readonly label: string }[] = [
  { value: 'metric', label: 'Metric (km)' },
  { value: 'imperial', label: 'Imperial (mi)' },
];

const TIME_FORMAT_CHOICES: readonly { readonly value: TimeFormat; readonly label: string }[] = [
  { value: '12h', label: '12-hour (3:50 PM)' },
  { value: '24h', label: '24-hour (15:50)' },
];

const NOTIFICATION_STATES: Readonly<Record<PushPermissionState, string>> = {
  granted: 'Notifications are on for this phone.',
  provisional: 'Notifications arrive quietly in Notification Center.',
  denied: 'Notifications are off for PlaneAhead in the system settings.',
  undetermined: 'Notifications are not turned on yet.',
};

/** The per-kind toggles (ruling C11), in the order increment 15 names them. */
const NOTIFICATION_EVENT_LABELS: Readonly<Record<NotificationEventPreference, string>> = {
  delay: 'Delays',
  gate_change: 'Gate changes',
  first_gate_assignment: 'First gate assignment',
  cancellation: 'Cancellations',
  diversion: 'Diversions',
};

/** Queues a choice for the account through the outbox, and starts a drain. */
function queueForAccount(queue: (db: SqliteLike) => void): void {
  void services()
    .then(({ store, outbox }) => {
      queue(store.sqlite);
      return outbox.drain();
    })
    .catch((error: unknown) => {
      Sentry.captureException(error);
    });
}

/** Applies a preferences choice here now, and queues it for the account through the outbox. */
function choosePreferences(patch: PreferencesPatch): void {
  useSettings.getState().updatePreferences(patch);
  queueForAccount((db) => {
    queuePreferencesPatch(db, patch);
  });
}

/** The same for a notification toggle: `{ notifications: patch }` (ruling C11). */
function chooseNotifications(patch: NotificationPreferencesPatch): void {
  useSettings.getState().updateNotifications(patch);
  queueForAccount((db) => {
    queueNotificationsPatch(db, patch);
  });
}

export default function SettingsScreen() {
  const router = useRouter();
  const { data: session } = authClient.useSession();
  const appearance = useSettings((state) => state.appearance);
  const setAppearance = useSettings((state) => state.setAppearance);
  const preferences = useSettings((state) => state.preferences);
  const notifications = useSettings((state) => state.notifications);
  const unitSystem = unitSystemOf(preferences);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signingOut = useRef(false);
  const [permission, setPermission] = usePushPermission();
  const anonymous = isAnonymousSession(session);
  const config = runtimeConfig();

  const confirmSignOut = async () => {
    // One sign-out at a time (review N6): a tap while one runs, or while its confirmation is up,
    // does nothing.
    if (signingOut.current) {
      return;
    }
    signingOut.current = true;
    const release = () => {
      signingOut.current = false;
    };
    try {
      const { store } = await services();
      const pending = pendingCount(store.sqlite);
      const go = () => {
        setBusy(true);
        return signOut(store).finally(() => {
          setBusy(false);
          release();
        });
      };
      if (pending === 0) {
        await go();
        return;
      }
      Alert.alert(
        'Sign out?',
        `${String(pending)} change(s) have not reached the server yet and will be lost.`,
        [
          { text: 'Cancel', style: 'cancel', onPress: release },
          { text: 'Sign out', style: 'destructive', onPress: () => void go() },
        ],
      );
    } catch (error) {
      release();
      throw error;
    }
  };

  const deleteAccount = () => {
    Alert.alert(
      'Delete your account?',
      'Your flights, preferences and devices are deleted from PlaneAhead now. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setBusy(true);
              try {
                const { api, store } = await services();
                const response = await api.v1.me.delete.$post();
                if (
                  response.ok ||
                  errorCode(await response.json().catch(() => null)) === 'account_deleted'
                ) {
                  await forgetAccount(store);
                  return;
                }
                setNotice('The account could not be deleted. Try again when you are online.');
              } catch {
                setNotice('The account could not be deleted. Try again when you are online.');
              } finally {
                setBusy(false);
              }
            })();
          },
        },
      ],
    );
  };

  const turnOnNotifications = async () => {
    setBusy(true);
    try {
      setPermission(await requestPushPermission());
      // The answer reaches the server now, not at the next foreground.
      void pushRegistrar().register();
    } catch (error) {
      Sentry.captureException(error);
      setNotice('Notifications could not be turned on. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen testID="settings-screen">
      <Title>Settings</Title>

      <Section title="Appearance">
        {APPEARANCES.map((value) => (
          <Button
            key={value}
            testID={`settings-appearance-${value}`}
            title={APPEARANCE_LABELS[value]}
            variant="secondary"
            selected={appearance === value}
            onPress={() => {
              setAppearance(value);
            }}
          />
        ))}
      </Section>

      <Section title="Units" testID="settings-units">
        {UNIT_SYSTEMS.map(({ value, label }) => (
          <Button
            key={value}
            testID={`settings-units-${value}`}
            title={label}
            variant="secondary"
            selected={unitSystem === value}
            onPress={() => {
              if (unitSystem !== value) {
                choosePreferences(unitSystemPatch(value));
              }
            }}
          />
        ))}
      </Section>

      <Section title="Time format" testID="settings-time-format">
        {TIME_FORMAT_CHOICES.map(({ value, label }) => (
          <Button
            key={value}
            testID={`settings-time-${value}`}
            title={label}
            variant="secondary"
            selected={preferences.timeFormat === value}
            onPress={() => {
              if (preferences.timeFormat !== value) {
                choosePreferences({ timeFormat: value });
              }
            }}
          />
        ))}
      </Section>

      <Section title="Account">
        <Body testID="settings-account-status">
          {session === null
            ? 'Not signed in.'
            : anonymous
              ? 'Using PlaneAhead without an account on this phone.'
              : `Signed in as ${session.user.email}.`}
        </Body>
        {anonymous ? (
          <Button
            testID="settings-sign-in"
            title="Sign in or create an account"
            onPress={() => {
              router.push('/sign-in');
            }}
          />
        ) : null}
        <Button
          testID="settings-sign-out"
          title="Sign out"
          variant="secondary"
          disabled={busy}
          onPress={() => {
            void confirmSignOut();
          }}
        />
        <Button
          testID="settings-delete-account"
          title="Delete account"
          variant="danger"
          busy={busy}
          onPress={deleteAccount}
        />
      </Section>

      <Section title="Notifications" testID="settings-notifications-section">
        {permission === null ? null : (
          <Body testID="settings-notifications-state">{NOTIFICATION_STATES[permission.state]}</Body>
        )}
        {permission?.canAsk === true ? (
          <Button
            testID="settings-notifications"
            title="Turn on notifications"
            variant="secondary"
            disabled={busy}
            onPress={() => {
              void turnOnNotifications();
            }}
          />
        ) : null}
        {permission?.state === 'denied' ? (
          <Button
            testID="settings-notifications-system"
            title="Open system settings"
            variant="secondary"
            onPress={() => {
              void Linking.openSettings();
            }}
          />
        ) : null}
        <Toggle
          testID="settings-notify-push"
          label="Flight alerts"
          value={notifications.pushEnabled}
          onValueChange={(pushEnabled) => {
            chooseNotifications({ pushEnabled });
          }}
        />
        {NOTIFICATION_EVENT_PREFERENCES.map((name) => (
          <Toggle
            key={name}
            testID={`settings-notify-${name}`}
            label={NOTIFICATION_EVENT_LABELS[name]}
            value={notifications.events[name]}
            // Alerts off: what each kind would do is kept, and is moot until they are back on.
            disabled={!notifications.pushEnabled}
            onValueChange={(on) => {
              chooseNotifications({ events: { [name]: on } });
            }}
          />
        ))}
      </Section>

      {notice === null ? null : <Body testID="settings-notice">{notice}</Body>}

      <Section title="About">
        <Body muted>
          {`Version ${Constants.expoConfig?.version ?? 'unknown'} (${config.variant}), ${config.apiUrl}`}
        </Body>
      </Section>
    </Screen>
  );
}
