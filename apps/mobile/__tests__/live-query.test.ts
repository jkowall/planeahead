/**
 * The coalescing wrapper around live queries: a burst of change events (one per row of a
 * 200-row sync page) collapses into ONE re-run, on a trailing microtask, so it can never run
 * inside the synchronous transaction that produced the events. Increment 10 asserts the list's
 * single re-render on a seeded store.
 */

import { createCoalescer } from '../src/lib/db/live-query';

describe('createCoalescer', () => {
  it('runs once for a burst, after the current synchronous work', async () => {
    const run = jest.fn();
    const refresh = createCoalescer(run);
    for (let row = 0; row < 200; row += 1) {
      refresh();
    }
    expect(run).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runs again for a later burst', async () => {
    const run = jest.fn();
    const refresh = createCoalescer(run);
    refresh();
    await Promise.resolve();
    refresh();
    refresh();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(2);
  });
});
