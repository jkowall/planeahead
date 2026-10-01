/**
 * Local settings: the appearance choice (device only) and a mirror of the account's server
 * preferences (`user_preferences`, applied from the sync feed). zustand `persist` over the
 * kv-store, which hydrates synchronously when this module loads: the first render already has
 * the stored values, online or not.
 *
 * Preferences ONLY. Anything the server owns (subscriptions, flights) lives in the offline store
 * and reaches screens through live queries, never through here.
 *
 * Increment 10: the units (metric or imperial) and time-format (12 h or 24 h) toggles change the
 * mirrored preferences here at once (`updatePreferences`) and queue the account's
 * `PATCH /v1/me/preferences` through the outbox (src/lib/preference-mutations.ts); the flight
 * screens read `preferences` for every time and distance they show (src/lib/format.ts).
 *
 * Increment 16 (ruling C11): `notifications` mirrors the account's notification preferences
 * (`notification_preferences`, applied from the sync feed, the defaults filled in) the same way:
 * the push switch and the five per-kind toggles change here at once (`updateNotifications`) and
 * queue `PATCH /v1/me/preferences` with `{ notifications }` through the outbox.
 */

import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  DEFAULT_USER_PREFERENCES,
  NOTIFICATION_EVENT_PREFERENCES,
  type NotificationPreferences,
  type NotificationPreferencesPatch,
  type UserPreferences,
} from '@planeahead/shared';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { KV_KEYS, zustandKvStorage } from './db/kv';

export const APPEARANCES = ['system', 'light', 'dark'] as const;
export type Appearance = (typeof APPEARANCES)[number];

export interface SettingsState {
  readonly appearance: Appearance;
  readonly preferences: UserPreferences;
  readonly notifications: NotificationPreferences;
  readonly setAppearance: (appearance: Appearance) => void;
  /** A local choice (the settings toggles): applied now, sent to the account by the caller. */
  readonly updatePreferences: (patch: Partial<UserPreferences>) => void;
  /** A notification toggle: applied now, sent to the account by the caller. */
  readonly updateNotifications: (patch: NotificationPreferencesPatch) => void;
  /** Called after a sync page carrying `user_preferences` committed. */
  readonly applyServerPreferences: (preferences: UserPreferences) => void;
  /** Called after a sync page carrying `notification_preferences` committed. */
  readonly applyServerNotifications: (notifications: NotificationPreferences) => void;
  /** Sign-out and account deletion: back to the defaults. */
  readonly reset: () => void;
}

type PersistedSettings = Pick<SettingsState, 'appearance' | 'preferences' | 'notifications'>;

const INITIAL: PersistedSettings = {
  appearance: 'system',
  preferences: DEFAULT_USER_PREFERENCES,
  notifications: DEFAULT_NOTIFICATION_PREFERENCES,
};

/**
 * `patch` laid over `current` as the API merges it: `pushEnabled` only when the patch names it,
 * and the named toggles into the rest (src/lib/notification-preferences.ts in the API).
 */
export function withNotificationsPatch(
  current: NotificationPreferences,
  patch: NotificationPreferencesPatch,
): NotificationPreferences {
  const events = { ...current.events };
  for (const name of NOTIFICATION_EVENT_PREFERENCES) {
    const value = patch.events?.[name];
    if (value !== undefined) {
      events[name] = value;
    }
  }
  return { pushEnabled: patch.pushEnabled ?? current.pushEnabled, events };
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      ...INITIAL,
      setAppearance: (appearance) => {
        set({ appearance });
      },
      updatePreferences: (patch) => {
        set((state) => ({ preferences: { ...state.preferences, ...patch } }));
      },
      updateNotifications: (patch) => {
        set((state) => ({ notifications: withNotificationsPatch(state.notifications, patch) }));
      },
      applyServerPreferences: (preferences) => {
        set({ preferences });
      },
      applyServerNotifications: (notifications) => {
        set({ notifications });
      },
      reset: () => {
        set(INITIAL);
      },
    }),
    {
      name: KV_KEYS.settings,
      // Still 1: a state persisted before increment 16 has no `notifications`, and the shallow
      // merge on hydration keeps the defaults for it.
      version: 1,
      storage: createJSONStorage<PersistedSettings>(() => zustandKvStorage),
      partialize: (state): PersistedSettings => ({
        appearance: state.appearance,
        preferences: state.preferences,
        notifications: state.notifications,
      }),
    },
  ),
);
