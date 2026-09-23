/**
 * The success and refusal hooks increment 10 adds to the increment 9 outbox (ruling T2): an item
 * the server answered for good leaves the queue in ONE immediate transaction with its writer's
 * reconciliation, the tables the hook wrote are signalled once after the COMMIT, a hook that
 * throws rolls its own writes back without wedging the queue, and a refusal hands its body to
 * `onDropped` for the message (never to a report).
 */

import type { RawRequest, RawResponse } from '../src/lib/api-client';
import { subscribeToTable, tableVersion } from '../src/lib/db/store-signal';
import { listFlights } from '../src/lib/flight-queries';
import { addFlight, flightOutboxHooks, reconcileSent } from '../src/lib/flights';
import { ApplyGate } from '../src/lib/sync/gate';
import { createOutbox, type DroppedMutation, type OutboxDeps } from '../src/lib/sync/outbox';
import { AA100_KEY, aa100Snapshot } from './support/flight-fixtures';
import { createMemorySqlite, type MemorySqlite } from './support/memory-sqlite';

function answering(responses: RawResponse[]) {
  const sent: RawRequest[] = [];
  return {
    sent,
    transport: {
      send(request: RawRequest): Promise<RawResponse> {
        sent.push(request);
        const next = responses.shift();
        return next === undefined
          ? Promise.reject(new TypeError('offline'))
          : Promise.resolve(next);
      },
    },
  };
}

function outboxFor(db: MemorySqlite, responses: RawResponse[], extra: Partial<OutboxDeps> = {}) {
  const network = answering(responses);
  const outbox = createOutbox({
    db,
    gate: new ApplyGate(),
    transport: network.transport,
    onAccountDeleted: jest.fn(),
    ...flightOutboxHooks(db),
    ...extra,
  });
  return { outbox, sent: network.sent };
}

function created(id: string): RawResponse {
  return {
    status: 201,
    replayed: false,
    body: {
      subscription: {
        id,
        flightKey: AA100_KEY,
        flightInstanceId: '0199c000-0000-7000-8000-00000000f001',
        tripId: null,
        label: null,
        seat: null,
        cabin: null,
        muted: false,
        notificationOverrides: {},
        source: 'manual',
        liveTracked: true,
        createdAt: '2026-09-23T14:00:01.000Z',
        updatedAt: '2026-09-23T14:00:01.000Z',
        deletedAt: null,
      },
      flight: {
        key: AA100_KEY,
        phase: 'scheduled',
        version: 1,
        snapshot: aa100Snapshot(),
        source: 'tracker',
      },
      created: true,
    },
  };
}

describe('the outbox settling hooks', () => {
  it('remove the item and reconcile the row in ONE immediate transaction, then signal once', async () => {
    const db = createMemorySqlite();
    const added = addFlight(db, { designator: 'AA100', date: '2026-09-23' });
    if (added.kind !== 'queued') {
      throw new Error('expected a queued add');
    }
    const { outbox } = outboxFor(db, [created(added.subscriptionId)]);
    const before = db.transactions.length;
    const signals: string[] = [];
    const stops = [
      subscribeToTable('flight_subscriptions', () => signals.push('flight_subscriptions')),
      subscribeToTable('outbox', () => signals.push('outbox')),
    ];
    const version = tableVersion('flight_subscriptions');

    await outbox.drain();
    stops.forEach((stop) => {
      stop();
    });

    const settled = db.transactions.slice(before);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ behavior: 'immediate', outcome: 'committed' });
    expect(settled[0]?.statements[0]).toMatch(/^DELETE FROM outbox WHERE id = \?/);
    expect(settled[0]?.statements.some((sql) => /INSERT INTO flight_subscriptions/.test(sql))).toBe(
      true,
    );
    expect(
      settled[0]?.statements.some((sql) =>
        /UPDATE flight_subscriptions SET\s+flight_status/.test(sql),
      ),
    ).toBe(true);
    expect(tableVersion('flight_subscriptions')).toBe(version + 1);
    expect(signals.sort()).toEqual(['flight_subscriptions', 'outbox']);
    expect(listFlights(db)[0]).toMatchObject({ id: added.subscriptionId, flightKey: AA100_KEY });
  });

  it('a hook that throws rolls its writes back, the item still leaves, the queue moves on', async () => {
    const db = createMemorySqlite();
    const first = addFlight(db, { designator: 'AA100', date: '2026-09-23' });
    const second = addFlight(db, { designator: 'BA117', date: '2026-09-25' });
    if (first.kind !== 'queued' || second.kind !== 'queued') {
      throw new Error('expected queued adds');
    }
    const onHookError = jest.fn();
    const { outbox, sent } = outboxFor(
      db,
      [created(first.subscriptionId), created(second.subscriptionId)],
      {
        onSent: (item) => {
          db.run("UPDATE flight_subscriptions SET label = 'half-written' WHERE id = ?", [
            item.entityId,
          ]);
          throw new Error('hook bug');
        },
        onHookError,
      },
    );

    const result = await outbox.drain();

    expect(result).toMatchObject({ kind: 'drained', sent: 2 });
    expect(sent).toHaveLength(2);
    expect(onHookError).toHaveBeenCalledTimes(2);
    expect(db.raw.prepare('SELECT count(*) AS n FROM outbox').get()).toEqual({ n: 0 });
    const labels = db.raw.prepare('SELECT label FROM flight_subscriptions').all();
    expect(labels).toEqual([{ label: null }, { label: null }]);
  });

  it('hands a refusal body to onDropped and removes the optimistic row in the same transaction', async () => {
    const db = createMemorySqlite();
    const added = addFlight(db, { designator: 'AA100', date: '2026-09-23' });
    const dropped: DroppedMutation[] = [];
    const body = { error: 'cap_exceeded', cap: 'active_subscriptions', limit: 5, requestId: 'r' };
    const { outbox } = outboxFor(db, [{ status: 403, replayed: false, body }], {
      onDropped: (mutation) => dropped.push(mutation),
    });
    const before = db.transactions.length;

    await outbox.drain();

    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ status: 403, code: 'cap_exceeded', body });
    expect(dropped[0]?.item.entityId).toBe(added.subscriptionId);
    const settled = db.transactions.slice(before);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.statements.some((sql) => /DELETE FROM flight_subscriptions/.test(sql))).toBe(
      true,
    );
    expect(listFlights(db)).toEqual([]);
  });

  it('an unreadable success changes nothing but still settles the item', () => {
    const db = createMemorySqlite();
    const added = addFlight(db, { designator: 'AA100', date: '2026-09-23' });
    if (added.kind !== 'queued') {
      throw new Error('expected a queued add');
    }
    const tables = db.transaction(
      () =>
        reconcileSent(
          db,
          {
            id: added.outboxId,
            method: 'POST',
            path: '/v1/flights',
            body: {},
            idempotencyKey: 'k',
            attempts: 0,
            entityId: added.subscriptionId,
          },
          { status: 201, replayed: false, body: { surprise: true } },
        ),
      { behavior: 'immediate' },
    );
    expect(tables).toEqual([]);
    expect(listFlights(db).map((item) => item.pending)).toEqual([true]);
  });
});
