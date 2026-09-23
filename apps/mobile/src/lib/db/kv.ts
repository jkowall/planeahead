/**
 * Small synchronous key-value state: `expo-sqlite/kv-store`, a separate SQLite file from the
 * offline store. Synchronous reads are what give the settings store its synchronous hydration
 * (no first-render gate). Never the sync cursor: the cursor has to commit in the SAME
 * transaction as the page it follows, which only the app database can do.
 *
 * No `@react-native-async-storage/async-storage` anywhere in the app.
 */

import { Storage } from 'expo-sqlite/kv-store';
import type { StateStorage } from 'zustand/middleware';

export interface SyncKv {
  getItemSync(key: string): string | null;
  setItemSync(key: string, value: string): void;
  removeItemSync(key: string): boolean;
}

export const kv: SyncKv = Storage;

export const KV_KEYS = {
  /** Per installation, registered with POST /v1/devices, sent as X-Install-Id. */
  installId: 'planeahead.install_id',
  /** Per installation, a DIFFERENT random value, never sent with a session (ADR 0005). */
  analyticsId: 'planeahead.analytics_id',
  /** The zustand settings store (src/lib/settings.ts). */
  settings: 'planeahead.settings',
  /** The address and time of the last magic link THIS install asked for. */
  pendingMagicLink: 'planeahead.magic_link_pending',
  /** Set once the first-launch anonymous sign-in has been attempted. */
  firstLaunchDone: 'planeahead.first_launch_done',
  /** The Apple `user` of a native Apple sign-in, for the launch credential-state check. */
  appleUserId: 'planeahead.apple_user_id',
} as const;

/** zustand `persist` over the kv-store, synchronous both ways. */
export const zustandKvStorage: StateStorage = {
  getItem: (name) => kv.getItemSync(name),
  setItem: (name, value) => {
    kv.setItemSync(name, value);
  },
  removeItem: (name) => {
    kv.removeItemSync(name);
  },
};
