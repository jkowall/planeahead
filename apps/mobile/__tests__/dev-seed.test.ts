/**
 * The development build's demo seed (the one device check increment 10 runs without an API,
 * docs/increments/10-verification.md): a well-formed sync page applied through the real page apply,
 * whose next flight is the one the simulator screenshot shows.
 */

import { seedDemoFlights, demoSyncPage } from '../src/dev/demo-flights';
import { selectHome } from '../src/lib/flight-model';
import { listFlights } from '../src/lib/flight-queries';
import { createMemorySqlite } from './support/memory-sqlite';

const NOW = Date.parse('2026-09-23T14:00:00Z');

describe('the demo seed', () => {
  it('is a valid sync page with three flights', () => {
    const page = demoSyncPage(NOW);
    expect(page.changes).toHaveLength(3);
    expect(page.flights).toHaveLength(3);
  });

  it('seeds through the real apply in one transaction, with AA100 next', () => {
    const db = createMemorySqlite();
    const outcome = seedDemoFlights(db, NOW);
    expect(outcome).toMatchObject({ changes: 3, flights: 3, skipped: [] });
    expect(db.transactions).toHaveLength(1);
    const { next, rest } = selectHome(listFlights(db), NOW);
    expect(next).toMatchObject({
      designator: 'AA100',
      origin: { code: 'JFK', gate: 'B22', terminal: '8' },
      scheduledOut: '2026-09-23T17:05:00Z',
    });
    expect(rest.map((item) => item.designator)).toEqual(['BA117', 'DL1']);
  });
});
