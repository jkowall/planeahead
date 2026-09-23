/**
 * The anonymous-to-account merge as the sync feed and the FlightTrackers see it (ruling O2),
 * end to end through the real Worker: a magic-link upgrade, the real `mergeUsers`, the real
 * persist queue consumer of the `merge` message, and the real trackers.
 *
 *   - account B holds F1 and F3 and has drained its feed on device 2;
 *   - anonymous A holds F2 and a newer F3;
 *   - A signs in as B (the merge);
 *   - device 2 pulls from the cursor it already holds and receives F2 and F3 (A's rows, now B's)
 *     and the delete of B's old F3;
 *   - every tracker's subscriber list names B only;
 *   - a replayed merge message changes nothing;
 *   - device 1, still holding the cursor it drained as A, is told 410 `resync_required` under B's
 *     session (the cursor is bound to A, ruling O12), and its snapshot carries B's older rows.
 */

import { runInDurableObject } from 'cloudflare:test';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SyncEnvelopeV1,
  decodeSyncCursor,
  type FlightKey,
  type SyncEnvelopeV1 as SyncEnvelope,
} from '@planeahead/shared';
import { defaultTrackerFor } from '../../src/lib/trackers';
import { createLogger } from '../../src/observability/log';
import { handleMergeMessage } from '../../src/queues/merge';
import {
  signInAnonymously,
  signInWithMagicLink,
  testEnv,
  uniqueEmail,
  uniqueIp,
} from './helpers/auth';
import { drainTouched } from './helpers/flights';
import {
  authed,
  counterValue,
  db,
  eventually,
  seedTracker,
  seededFlightFor,
  subscribe,
  trackerStub,
  type SubscribeBody,
} from './helpers/routes';

afterEach(drainTouched);

interface Session {
  readonly cookie: string;
  readonly ip: string;
}

async function pull(session: Session, cursor?: string): Promise<SyncEnvelope> {
  const response = await authed(
    session,
    cursor === undefined ? '/v1/sync' : `/v1/sync?cursor=${encodeURIComponent(cursor)}`,
  );
  if (response.status !== 200) {
    throw new Error(`sync failed: ${String(response.status)} ${await response.text()}`);
  }
  return SyncEnvelopeV1.parse(await response.json());
}

async function subscriptionId(session: Session, flightKey: FlightKey): Promise<string> {
  const response = await subscribe(session, { flightKey });
  expect(response.status).toBe(201);
  return (await response.json<SubscribeBody>()).subscription.id;
}

/** The tracker's own subscriber rows, read from its SQLite storage. */
async function subscribers(flightKey: FlightKey): Promise<{ id: string; user: string }[]> {
  return runInDurableObject(trackerStub(flightKey), (_instance, state) =>
    state.storage.sql
      .exec<{ id: string; user: string }>(
        'SELECT subscription_id AS id, user_id AS user FROM subscribers ORDER BY subscription_id',
      )
      .toArray(),
  );
}

describe('the anonymous-to-account merge (ruling O2)', () => {
  it("reaches the account's other device through the feed and re-points every tracker to the account", async () => {
    const [f1, f2, f3] = [seededFlightFor(), seededFlightFor(), seededFlightFor()];
    if (f1 === undefined || f2 === undefined || f3 === undefined) {
      throw new Error('three flights expected');
    }
    for (const flight of [f1, f2, f3]) {
      await seedTracker(flight);
    }

    // Account B on device 2, with F1 and F3, fully drained.
    const email = uniqueEmail('merge-sync');
    const device2 = await signInWithMagicLink(email, { ip: uniqueIp() });
    const b = device2.userId;
    const bSession = { cookie: device2.cookie, ip: uniqueIp() };
    const bF1 = await subscriptionId(bSession, f1.flightKey);
    const bF3 = await subscriptionId(bSession, f3.flightKey);
    const [latest] = await db().execute<{ xid: string }>(sql`
      select max(xid)::text as xid from user_sync_changes where user_id = ${b}::uuid
    `);
    const drained = await eventually(
      () => pull(bSession),
      (page) =>
        page.changes.length === 2 &&
        BigInt(decodeSyncCursor(page.cursor).xid) > BigInt(latest?.xid ?? '0'),
    );

    // Anonymous A on device 1, with F2 and a NEWER F3.
    const anonymous = await signInAnonymously();
    const a = anonymous.userId;
    const aF2 = await subscriptionId(anonymous, f2.flightKey);
    const aF3 = await subscriptionId(anonymous, f3.flightKey);
    const anonymousCursor = (await pull(anonymous)).cursor;

    // A signs in as B: the merge.
    const upgraded = await signInWithMagicLink(email, {
      ip: anonymous.ip,
      cookie: anonymous.cookie,
    });
    expect(upgraded.userId).toBe(b);

    // Device 2 pulls from the cursor it already holds.
    const delivered: SyncEnvelope['changes'] = [];
    let cursor = drained.cursor;
    await eventually(
      async () => {
        const page = await pull(bSession, cursor);
        delivered.push(...page.changes);
        cursor = page.cursor;
        return delivered.length;
      },
      (count) => count >= 3,
    );
    expect(delivered.map((change) => [change.op, change.id]).sort()).toEqual(
      [
        ['upsert', aF2],
        ['upsert', aF3],
        ['delete', bF3],
      ].sort(),
    );
    expect(delivered.find((change) => change.id === aF3)?.row?.['flightKey']).toBe(f3.flightKey);
    // The counters follow the live rows: three live subscriptions after the merge.
    expect(await counterValue('user', b, 'active_subscriptions')).toBe(3);

    // The persist consumer re-points the trackers: B's ids and A's moved ids, all naming B.
    const expected = {
      [f1.flightKey]: [{ id: bF1, user: b }],
      [f2.flightKey]: [{ id: aF2, user: b }],
      [f3.flightKey]: [{ id: aF3, user: b }],
    };
    const lists = async () => ({
      [f1.flightKey]: await subscribers(f1.flightKey),
      [f2.flightKey]: await subscribers(f2.flightKey),
      [f3.flightKey]: await subscribers(f3.flightKey),
    });
    await eventually(lists, (current) => JSON.stringify(current) === JSON.stringify(expected));

    // A replayed merge message changes nothing.
    const report = await handleMergeMessage(
      {
        kind: 'merge',
        from: a,
        to: b,
        moved: [
          { id: aF2, flightKey: f2.flightKey },
          { id: aF3, flightKey: f3.flightKey },
        ],
        tombstoned: [{ id: bF3, flightKey: f3.flightKey }],
      },
      { db: db(), trackerFor: defaultTrackerFor(testEnv), log: createLogger({}, () => undefined) },
    );
    expect(report).toEqual({ repointed: 2, unsubscribed: 1, skipped: 0 });
    expect(await lists()).toEqual(expected);
    const idle = await pull(bSession, cursor);
    expect(idle.changes).toEqual([]);

    // Device 1: A's cursor under B's session is refused, and the resync brings B's older F1.
    const device1 = { cookie: upgraded.cookie, ip: anonymous.ip };
    const stale = await authed(device1, `/v1/sync?cursor=${encodeURIComponent(anonymousCursor)}`);
    expect(stale.status).toBe(410);
    expect((await stale.json<{ error: string }>()).error).toBe('resync_required');
    const resynced = await pull(device1);
    expect(
      resynced.changes
        .filter((change) => change.entity === 'flight_subscriptions')
        .map((change) => change.id)
        .sort(),
    ).toEqual([bF1, aF2, aF3].sort());
  });
});
