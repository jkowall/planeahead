/**
 * A Map-backed stand-in for src/lib/db/kv.ts (the expo-sqlite kv-store), for tests that render
 * screens reading the settings store. Use it from a `jest.mock` factory:
 *
 *   jest.mock('../src/lib/db/kv', () =>
 *     jest.requireActual<typeof import('./support/memory-kv')>('./support/memory-kv').memoryKvModule(),
 *   );
 *
 * settings.test.tsx keeps the real kv-store statements over SQLite; this is for everything else.
 */

import type * as KvModule from '../../src/lib/db/kv';

export function memoryKvModule(): typeof KvModule {
  const store = new Map<string, string>();
  const actual = jest.requireActual<typeof KvModule>('../../src/lib/db/kv');
  return {
    KV_KEYS: actual.KV_KEYS,
    kv: {
      getItemSync: (key) => store.get(key) ?? null,
      setItemSync: (key, value) => {
        store.set(key, value);
      },
      removeItemSync: (key) => store.delete(key),
      getAllKeysSync: () => [...store.keys()],
    },
    zustandKvStorage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => {
        store.set(key, value);
      },
      removeItem: (key) => {
        store.delete(key);
      },
    },
  };
}
