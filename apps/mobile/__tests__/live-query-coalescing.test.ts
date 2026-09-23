/**
 * The home list re-renders ONCE, not 200 times, when a 200-row sync page is applied (increment 10
 * acceptance, ruling T1). The page goes through the real apply path (`applySyncPage`, one
 * immediate transaction, one store signal after the COMMIT) into the in-memory SQLite, the real
 * home screen reads it through the increment 9 live query, and a React Profiler counts the
 * commits of the screen's tree. On a device expo-sqlite would also report 200 per-row events,
 * each as its own task; they are delivered here the same way, and the screen does not listen to
 * them (live-query.test.ts proves the hook itself; this proves the screen built on it).
 */

import { act, render, screen } from '@testing-library/react-native';
import { createElement, Profiler, type ProfilerOnRenderCallback } from 'react';
import HomeScreen from '../src/app/(app)/index';
import { StoreProvider } from '../src/lib/db/store-context';
import { LIST_FLIGHTS_SQL } from '../src/lib/flight-queries';
import { applySyncPage, SyncPageShell } from '../src/lib/sync/apply';
import { createSyncClient } from '../src/lib/sync/client';
import { ApplyGate } from '../src/lib/sync/gate';
import { notifyTablesChanged } from '../src/lib/db/store-signal';
import { NOW, seedStore } from './support/flight-fixtures';
import { createMemorySqlite, type MemorySqlite } from './support/memory-sqlite';
import { cursorAt, flight, page, subscriptionUpsert, AA100, BA117 } from './support/sync-fixtures';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});

jest.mock('../src/lib/db/kv', () =>
  jest.requireActual<typeof import('./support/memory-kv')>('./support/memory-kv').memoryKvModule(),
);

jest.mock('../src/lib/auth-client', () => ({
  isAnonymousSession: () => false,
  authClient: {
    useSession: () => ({ data: { user: { id: 'user-1', isAnonymous: false } }, isPending: false }),
  },
}));

jest.mock('../src/lib/session', () => ({ syncNow: jest.fn(() => Promise.resolve()) }));

/** One macrotask, as the runtime scheduler would run the next per-row event. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** `count` subscription upserts starting at `from`, alternating two flights, with their snapshots. */
function bigPage(from: number, count: number, cursor: string, hasMore = false): SyncPageShell {
  return SyncPageShell.parse(
    page({
      changes: Array.from({ length: count }, (_, n) =>
        subscriptionUpsert(from + n, n % 2 === 0 ? AA100 : BA117),
      ),
      flights: [flight(AA100), flight(BA117)],
      cursor,
      hasMore,
    }),
  );
}

async function mountHome(db: MemorySqlite) {
  const commits: string[] = [];
  const onRender: ProfilerOnRenderCallback = (_id, phase) => {
    commits.push(phase);
  };
  await render(
    createElement(StoreProvider, {
      value: db,
      children: createElement(Profiler, { id: 'home', onRender }, createElement(HomeScreen)),
    }),
  );
  await screen.findByTestId('home-screen');
  await act(async () => {
    await nextTask();
  });
  return commits;
}

/** How many times the home list's live query has read the store (src/lib/flight-queries.ts). */
function listQueries(db: MemorySqlite): number {
  // The list's own statement: the page apply's local-intent reads select from the same table.
  return db.statements.filter((sql) => sql === LIST_FLIGHTS_SQL).length;
}

function rowCount(): number {
  return (
    screen.queryAllByTestId(/^flight-row-/).length +
    screen.queryAllByTestId('home-next-flight').length
  );
}

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
});

/**
 * Runs `work` the way a device does, outside React's act() batching: each state update is
 * scheduled by React's own scheduler and commits in its own task, so the Profiler sees every
 * commit a re-run would cause. Inside one act() React would fold them all into one commit and the
 * count would prove nothing (the control below shows the count is sensitive).
 */
async function asOnDevice(work: () => Promise<void>): Promise<void> {
  const flags = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean | undefined };
  const previous = flags.IS_REACT_ACT_ENVIRONMENT;
  flags.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await work();
    // Let the scheduler run whatever the last update queued.
    for (let task = 0; task < 5; task += 1) {
      await nextTask();
    }
  } finally {
    flags.IS_REACT_ACT_ENVIRONMENT = previous;
  }
}

describe('the home list and a 200-row page', () => {
  it('re-renders once when a 200-row page is applied through the real apply path', async () => {
    const db = createMemorySqlite();
    seedStore(db);
    const commits = await mountHome(db);
    expect(rowCount()).toBe(3);
    const settled = commits.length;
    const queriesBefore = listQueries(db);

    await asOnDevice(async () => {
      applySyncPage(db, bigPage(100, 200, cursorAt(2)));
      // What the update hook would have delivered on a device: one task per changed row.
      for (let row = 0; row < 200; row += 1) {
        await nextTask();
      }
    });

    expect(rowCount()).toBe(203);
    expect(listQueries(db) - queriesBefore).toBe(1);
    expect(commits.length - settled).toBe(1);
    expect(commits.at(-1)).toBe('update');
  });

  it('control: a writer that signalled once per row WOULD cost a commit per row', async () => {
    const db = createMemorySqlite();
    seedStore(db);
    const commits = await mountHome(db);
    const settled = commits.length;

    await asOnDevice(async () => {
      for (let row = 0; row < 200; row += 1) {
        notifyTablesChanged(['flight_subscriptions']);
        await nextTask();
        await nextTask();
      }
    });

    // The harness counts every commit it is given: this is what one-signal-per-commit prevents.
    expect(commits.length - settled).toBeGreaterThan(100);
  });

  it('re-renders once per page of a multi-page pull, not once per row', async () => {
    const db = createMemorySqlite();
    const commits = await mountHome(db);
    expect(screen.getByTestId('home-empty')).toBeOnTheScreen();
    const settled = commits.length;
    const queriesBefore = listQueries(db);

    const pages = [
      bigPage(1, 200, cursorAt(1), true),
      bigPage(201, 200, cursorAt(2), true),
      bigPage(401, 100, cursorAt(3)),
    ];
    const client = createSyncClient({
      db,
      gate: new ApplyGate(),
      onAccountDeleted: jest.fn(),
      transport: {
        async pull() {
          // A network round trip per page: the previous page's re-render commits meanwhile.
          for (let task = 0; task < 5; task += 1) {
            await nextTask();
          }
          return { status: 200, body: pages.shift() };
        },
      },
    });
    await asOnDevice(async () => {
      await client.sync('user-1');
    });

    expect(rowCount()).toBe(500);
    expect(listQueries(db) - queriesBefore).toBe(3);
    expect(commits.length - settled).toBe(3);
  });
});
