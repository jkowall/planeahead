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
  /** Every key; the replacement records are found by their prefix (src/lib/flight-replacements.ts). */
  getAllKeysSync(): string[];
}

export const kv: SyncKv = Storage;

export const KV_KEYS = {
  /** Per installation, registered with POST /v1/devices, sent as X-Install-Id. */
  installId: 'planeahead.install_id',
  /** Per installation, a DIFFERENT random value, never sent with a session (ADR 0005). */
  analyticsId: 'planeahead.analytics_id',
  /** The zustand settings store (src/lib/settings.ts). */
  settings: 'planeahead.settings',
  /** The addresses and times of the magic links THIS install asked for (a short JSON list). */
  pendingMagicLink: 'planeahead.magic_link_pending',
  /** Set once the first-launch anonymous sign-in has been attempted. */
  firstLaunchDone: 'planeahead.first_launch_done',
  /** The Apple `user` of a native Apple sign-in, for the launch credential-state check. */
  appleUserId: 'planeahead.apple_user_id',
  /** Per installation: the notification pre-prompt was offered (src/lib/push.ts, ruling C1). */
  pushPromptOffered: 'planeahead.push_prompt_offered',
  /** Per installation: this app has asked for notification permission (src/lib/push.ts). */
  pushPermissionRequested: 'planeahead.push_permission_requested',
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
