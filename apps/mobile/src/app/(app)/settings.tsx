/**
 * Settings: appearance (a device preference, persisted in the kv-store and so available offline
 * on the next launch), the account (upgrade, sign out, delete), notifications (permission and
 * the raw device token only; no push service in Phase 0) and what this build talks to.
 *
 * Increment 10 (ruling T6): the units (metric, imperial) and time-format (12 h, 24 h) toggles.
 * They are the account's preferences: the settings store changes at once and persists through the
 * kv-store, and a `PATCH /v1/me/preferences` is queued through the outbox for the account and
 * its other devices (src/lib/preference-mutations.ts).
 */

import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert } from 'react-native';
import { Body, Button, Screen, Section, Title } from '../../components/ui';
import { errorCode } from '../../lib/api-client';
import { authClient, isAnonymousSession } from '../../lib/auth-client';
import { runtimeConfig } from '../../lib/config';
import { registerDevice } from '../../lib/devices';
import { unitSystemOf, unitSystemPatch, type TimeFormat, type UnitSystem } from '../../lib/format';
import { queuePreferencesPatch, type PreferencesPatch } from '../../lib/preference-mutations';
import { readDevicePushToken } from '../../lib/push';
import { forgetAccount, services } from '../../lib/services';
import { APPEARANCES, useSettings, type Appearance } from '../../lib/settings';
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

/** Applies a preferences choice here now, and queues it for the account through the outbox. */
function choosePreferences(patch: PreferencesPatch): void {
  useSettings.getState().updatePreferences(patch);
  void services()
    .then(({ store, outbox }) => {
      queuePreferencesPatch(store.sqlite, patch);
      return outbox.drain();
    })
    .catch((error: unknown) => {
      Sentry.captureException(error);
    });
}

export default function SettingsScreen() {
  const router = useRouter();
  const { data: session } = authClient.useSession();
  const appearance = useSettings((state) => state.appearance);
  const setAppearance = useSettings((state) => state.setAppearance);
  const preferences = useSettings((state) => state.preferences);
  const unitSystem = unitSystemOf(preferences);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const anonymous = isAnonymousSession(session);
  const config = runtimeConfig();

  const signOut = async () => {
    const { store } = await services();
    const pending = pendingCount(store.sqlite);
    const go = async () => {
      await forgetAccount(store);
    };
    if (pending === 0) {
      await go();
      return;
    }
    Alert.alert(
      'Sign out?',
      `${String(pending)} change(s) have not reached the server yet and will be lost.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign out', style: 'destructive', onPress: () => void go() },
      ],
    );
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

  const enableNotifications = async () => {
    setBusy(true);
    try {
      const read = await readDevicePushToken();
      if (read.kind === 'token') {
        await registerDevice((await services()).api, { kind: read.tokenKind, token: read.token });
        setNotice('Notifications are allowed on this device.');
      } else if (read.kind === 'denied') {
        setNotice('Notifications are off for PlaneAhead in the system settings.');
      } else {
        setNotice(`This build cannot receive notifications yet (${read.reason}).`);
      }
    } catch {
      setNotice('Notifications could not be set up. Try again when you are online.');
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
            void signOut();
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

      <Section title="Notifications">
        <Button
          testID="settings-notifications"
          title="Allow notifications"
          variant="secondary"
          disabled={busy}
          onPress={() => {
            void enableNotifications();
          }}
        />
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
