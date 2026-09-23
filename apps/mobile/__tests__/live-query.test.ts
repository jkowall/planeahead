/**
 * The live query re-runs once per COMMITTED write, not once per changed row (ruling S9 item 2,
 * increment 9 review finding auth-and-store-2).
 *
 * On a device expo-sqlite reports every changed row as its own event, and React Native's runtime
 * scheduler delivers each as its own task with a microtask checkpoint after it, so a coalescer on a
 * trailing microtask collapses nothing. These tests deliver everything the way a device would, one
 * macrotask per event, and assert one re-run (and one render) per committed page. Increment 10
 * asserts the list's single re-render on a seeded store on top of this.
 */

import { act, renderHook } from '@testing-library/react-native';
import { addDatabaseChangeListener } from 'expo-sqlite';
import { applySyncPage } from '../src/lib/sync/apply';
import { createSyncClient } from '../src/lib/sync/client';
import { ApplyGate } from '../src/lib/sync/gate';
import { createCoalescer, useLiveQuery } from '../src/lib/db/live-query';
import { flightSubscriptions } from '../src/lib/db/schema';
import { notifyTablesChanged, tableVersion } from '../src/lib/db/store-signal';
import { createMemorySqlite, type MemorySqlite } from './support/memory-sqlite';
import { AA100, BA117, cursorAt, page, subscriptionUpsert } from './support/sync-fixtures';

/** expo-sqlite's update-hook listener, as a device delivers it: whoever subscribes gets every row. */
const mockRowListeners = new Set<(event: { tableName: string }) => void>();
jest.mock('expo-sqlite', () => ({
  addDatabaseChangeListener: jest.fn((listener: (event: { tableName: string }) => void) => {
    mockRowListeners.add(listener);
    return { remove: () => mockRowListeners.delete(listener) };
  }),
}));

/** One macrotask, as the runtime scheduler would run the next event. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function rows(from: number, count: number) {
  return Array.from({ length: count }, (_, n) =>
    subscriptionUpsert(from + n, n % 2 === 0 ? AA100 : BA117),
  );
}

function mountList(db: MemorySqlite) {
  const runs = { query: 0, renders: 0 };
  const query = () => {
    runs.query += 1;
    const row = db.raw
      .prepare('SELECT count(*) AS n FROM flight_subscriptions WHERE deleted_at IS NULL')
      .get() as { n: number };
    return Promise.resolve(row.n);
  };
  return {
    runs,
    render: () =>
      renderHook(() => {
        runs.renders += 1;
        return useLiveQuery(flightSubscriptions, query, -1);
      }),
  };
}

describe('useLiveQuery', () => {
  it('re-runs ONCE for a 200-row page, however the per-row events are delivered', async () => {
    const db = createMemorySqlite();
    const list = mountList(db);
    const hook = await list.render();
    await act(async () => {
      await nextTask();
    });
    expect(hook.result.current.data).toBe(0);
    const settled = { ...list.runs };

    await act(async () => {
      // The commit, then what the update hook would have sent on a device: 200 row events, each
      // in its own task. The hook does not listen to them at all.
      applySyncPage(db, page({ changes: rows(1, 200), cursor: cursorAt(1) }) as never);
      for (let row = 0; row < 200; row += 1) {
        await nextTask();
        for (const listener of mockRowListeners) {
          listener({ tableName: 'flight_subscriptions' });
        }
      }
    });

    expect(hook.result.current.data).toBe(200);
    expect(list.runs.query - settled.query).toBe(1);
    expect(list.runs.renders - settled.renders).toBe(1);
    expect(addDatabaseChangeListener).not.toHaveBeenCalled();
    await hook.unmount();
  });

  it('re-runs once per page of a multi-page pull, each page arriving in its own task', async () => {
    const db = createMemorySqlite();
    const list = mountList(db);
    const hook = await list.render();
    await act(async () => {
      await nextTask();
    });
    const settled = list.runs.query;

    const responses = [
      page({ changes: rows(1, 200), cursor: cursorAt(1), hasMore: true }),
      page({ changes: rows(201, 200), cursor: cursorAt(2), hasMore: true }),
      page({ changes: rows(401, 100), cursor: cursorAt(3) }),
    ];
    const client = createSyncClient({
      db,
      gate: new ApplyGate(),
      onAccountDeleted: jest.fn(),
      transport: {
        async pull() {
          await nextTask();
          return { status: 200, body: responses.shift() };
        },
      },
    });
    await act(async () => {
      await client.sync('user-1');
      await nextTask();
    });

    expect(hook.result.current.data).toBe(500);
    expect(list.runs.query - settled).toBe(3);
    await hook.unmount();
  });

  it('ignores signals for other tables and stops listening on unmount', async () => {
    const db = createMemorySqlite();
    const list = mountList(db);
    const hook = await list.render();
    await act(async () => {
      await nextTask();
    });
    const settled = list.runs.query;

    await act(async () => {
      notifyTablesChanged(['outbox', 'sync_state']);
      await nextTask();
    });
    expect(list.runs.query).toBe(settled);

    await hook.unmount();
    const version = tableVersion('flight_subscriptions');
    notifyTablesChanged(['flight_subscriptions']);
    await nextTask();
    expect(tableVersion('flight_subscriptions')).toBe(version + 1);
    expect(list.runs.query).toBe(settled);
  });
});

describe('createCoalescer', () => {
  it('collapses the signals of one task into one run, after the current synchronous work', async () => {
    const run = jest.fn();
    const refresh = createCoalescer(run);
    refresh();
    refresh();
    expect(run).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runs again for a signal in a later task', async () => {
    const run = jest.fn();
    const refresh = createCoalescer(run);
    refresh();
    await nextTask();
    refresh();
    await nextTask();
    expect(run).toHaveBeenCalledTimes(2);
  });
});
