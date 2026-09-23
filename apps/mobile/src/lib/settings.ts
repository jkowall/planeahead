/**
 * Local settings: the appearance choice (device only) and a mirror of the account's server
 * preferences (`user_preferences`, applied from the sync feed). zustand `persist` over the
 * kv-store, which hydrates synchronously when this module loads: the first render already has
 * the stored values, online or not.
 *
 * Preferences ONLY. Anything the server owns (subscriptions, flights) lives in the offline store
 * and reaches screens through live queries, never through here.
 */

import { DEFAULT_USER_PREFERENCES, type UserPreferences } from '@planeahead/shared';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { KV_KEYS, zustandKvStorage } from './db/kv';

export const APPEARANCES = ['system', 'light', 'dark'] as const;
export type Appearance = (typeof APPEARANCES)[number];

export interface SettingsState {
  readonly appearance: Appearance;
  readonly preferences: UserPreferences;
  readonly setAppearance: (appearance: Appearance) => void;
  /** Called after a sync page carrying `user_preferences` committed. */
  readonly applyServerPreferences: (preferences: UserPreferences) => void;
  /** Sign-out and account deletion: back to the defaults. */
  readonly reset: () => void;
}

type PersistedSettings = Pick<SettingsState, 'appearance' | 'preferences'>;

const INITIAL: PersistedSettings = {
  appearance: 'system',
  preferences: DEFAULT_USER_PREFERENCES,
};

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      ...INITIAL,
      setAppearance: (appearance) => {
        set({ appearance });
      },
      applyServerPreferences: (preferences) => {
        set({ preferences });
      },
      reset: () => {
        set(INITIAL);
      },
    }),
    {
      name: KV_KEYS.settings,
      version: 1,
      storage: createJSONStorage<PersistedSettings>(() => zustandKvStorage),
      partialize: (state): PersistedSettings => ({
        appearance: state.appearance,
        preferences: state.preferences,
      }),
    },
  ),
);
