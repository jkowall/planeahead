/**
 * The outbox protocol's edges and the per-flight caps (rulings L1, L4, review findings
 * outbox-and-data-flow-9 and -11):
 *
 *   - a sent row unconfirmed for longer than `OUTBOX_RESEND_GRACE_MS` is re-sent by the next
 *     flush; one inside the grace is not;
 *   - a row over the single-message limit is never sent: dropped with an `outbox_oversize`
 *     event, while the rows around it go out;
 *   - a confirmation (or any other RPC) that reaches an object holding no flight arms the 60 s
 *     cleanup, so a Queues duplicate after the +22 h delete leaves no empty schema behind;
 *   - the soft cap stretches the cadence one tier and the hard cap stops polling, both reached
 *     through the real alarm debit path with the caps seam lowered.
 */

import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { RPC_SCHEMA_VERSION, parseFlightTrackerOrigin, pollEquivalents } from '@planeahead/shared';
import { OUTBOX_RESEND_GRACE_MS, type FlightTracker } from '../../src/do/flight-tracker';
import { OUTBOX_SINGLE_MESSAGE_LIMIT_BYTES } from '../../src/do/outbox';
import {
  HOUR_MS,
  adbCalls,
  adbOk,
  drainTouched,
  ofKind,
  onTimePhaseAt,
  openBudgetFor,
  resolverHarness,
  scriptAdb,
  testEnv,
  trackerHarness,
  uniqueFlight,
  type TestFlight,
  type TrackerHarness,
} from './helpers/flights';

afterEach(drainTouched);

async function seeded(
  flight: TestFlight,
  clock: number,
  caps?: { softCapPe: number; hardCapPe: number },
): Promise<TrackerHarness> {
  await scriptAdb(flight, [adbOk(flight, { phase: onTimePhaseAt(flight, clock) })]);
  const tracker = await trackerHarness(flight.flightKey, clock);
  if (caps !== undefined) {
    await runInDurableObject(tracker.stub, (instance: FlightTracker) => {
      instance.caps = caps;
    });
  }
  await openBudgetFor(flight, clock);
  const resolver = await resolverHarness(flight, clock);
  const resolved = await resolver.stub.resolve({
    rpcVersion: RPC_SCHEMA_VERSION,
    designator: flight.designator,
    dateLocal: flight.dateLocal,
  });
  expect(resolved.outcome).toBe('resolved');
  return tracker;
}

describe('re-sending unconfirmed rows', () => {
  it('re-sends a row unconfirmed past the grace and leaves one inside it alone', async () => {
    const flight = uniqueFlight();
    const creation = flight.scheduledOut.getTime() - 48 * HOUR_MS;
    const tracker = await seeded(flight, creation);
    const seedSeqs = tracker.outbox.sent.map((message) => message.seq);
    expect(seedSeqs.length).toBeGreaterThan(0);
    tracker.outbox.sent.length = 0;

    // Inside the grace nothing is re-sent: a manual refresh's flush carries only its own rows.
    await tracker.setClock(creation + OUTBOX_RESEND_GRACE_MS - 1);
    await tracker.stub.forceRefresh({ rpcVersion: RPC_SCHEMA_VERSION, reason: 'manual' });
    const refreshSeqs = tracker.outbox.sent.map((message) => message.seq);
    expect(refreshSeqs.some((seq) => seedSeqs.includes(seq))).toBe(false);
    expect(refreshSeqs.length).toBeGreaterThan(0);
    tracker.outbox.sent.length = 0;

    // Past the grace the next flush re-sends every unconfirmed row, the seed's included. (The
    // manual refresh answered this slot, so the alarm reschedules without a call and flushes.)
    await tracker.setClock(creation + HOUR_MS);
    expect(await tracker.runAlarm()).toBe(true);
    expect(await adbCalls(flight)).toBe(2);
    const alarmSeqs = tracker.outbox.sent.map((message) => message.seq);
    for (const seq of [...seedSeqs, ...refreshSeqs]) {
      expect(alarmSeqs).toContain(seq);
    }
    // Confirmed rows are gone for good.
    const epochMs = parseFlightTrackerOrigin(tracker.outbox.sent[0]?.origin ?? '')?.epochMs ?? 0;
    const confirmed = await tracker.stub.confirmPersisted({
      rpcVersion: RPC_SCHEMA_VERSION,
      epochMs,
      seqs: seedSeqs,
    });
    expect(confirmed.matched).toBe(true);
    expect(confirmed.deleted).toBe(seedSeqs.length);
    tracker.outbox.sent.length = 0;
    await tracker.setClock(creation + 2 * HOUR_MS);
    expect(await tracker.runAlarm()).toBe(true);
    const later = tracker.outbox.sent.map((message) => message.seq);
    expect(later.some((seq) => seedSeqs.includes(seq))).toBe(false);
    expect(await adbCalls(flight)).toBe(3);
  });

  it('drops a row over the single-message limit with an outbox_oversize event and sends the rest', async () => {
    const flight = uniqueFlight();
    const creation = flight.scheduledOut.getTime() - 48 * HOUR_MS;
    const tracker = await seeded(flight, creation);
    tracker.outbox.sent.length = 0;
    // A row that can never fit one queue message, planted between ordinary ones.
    const oversizeSeq = await runInDurableObject(tracker.stub, (_instance, state) => {
      const seq = state.storage.sql
        .exec<{ outbox_next_seq: number }>('SELECT outbox_next_seq FROM flight WHERE id = 1')
        .one().outbox_next_seq;
      state.storage.sql.exec(
        'INSERT INTO outbox (seq, flight_id, kind, payload, created_at_ms) VALUES (?, 1, ?, ?, ?)',
        seq,
        'flight_event',
        JSON.stringify({
          kind: 'flight_event',
          flightKey: flight.flightKey,
          payload: {
            occurredAt: new Date(creation).toISOString(),
            type: 'note',
            field: 'blob',
            newValue: 'x'.repeat(OUTBOX_SINGLE_MESSAGE_LIMIT_BYTES + 1024),
            source: 'system',
            providerCallId: null,
          },
        }),
        creation,
      );
      state.storage.sql.exec('UPDATE flight SET outbox_next_seq = ? WHERE id = 1', seq + 1);
      return seq;
    });

    await tracker.setClock(creation + HOUR_MS);
    expect(await tracker.runAlarm()).toBe(true);

    const sentSeqs = tracker.outbox.sent.map((message) => message.seq);
    expect(sentSeqs).not.toContain(oversizeSeq);
    expect(sentSeqs.length).toBeGreaterThan(0);
    const remaining = await tracker.rows<{ seq: number; sent_at_ms: number | null }>(
      'SELECT seq, sent_at_ms FROM outbox ORDER BY seq',
    );
    expect(remaining.map((row) => row.seq)).not.toContain(oversizeSeq);
    // Every row that was sent carries sent_at; the event the drop appended waits for the next
    // flush, like any row written during a flush.
    for (const row of remaining) {
      expect(row.sent_at_ms !== null).toBe(sentSeqs.includes(row.seq));
    }
    const stored = await tracker.rows<{ type: string; new_value: string }>(
      "SELECT type, new_value FROM events WHERE type = 'outbox_oversize'",
    );
    expect(stored).toEqual([{ type: 'outbox_oversize', new_value: String(oversizeSeq) }]);
    tracker.outbox.sent.length = 0;
    await tracker.setClock(creation + 2 * HOUR_MS);
    expect(await tracker.runAlarm()).toBe(true);
    const events = ofKind(tracker.outbox.sent, 'flight_event').filter(
      (message) => message.payload.type === 'outbox_oversize',
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.newValue).toBe(oversizeSeq);
  });
});

describe('an object that holds no flight', () => {
  it('arms its cleanup on a confirmation, an unsubscribe or a ledger read', async () => {
    const absent = uniqueFlight();
    const clock = absent.scheduledOut.getTime();
    const tracker = await trackerHarness(absent.flightKey, clock);
    const confirmed = await tracker.stub.confirmPersisted({
      rpcVersion: RPC_SCHEMA_VERSION,
      epochMs: 1,
      seqs: [1, 2, 3],
    });
    expect(confirmed).toEqual({
      rpcVersion: RPC_SCHEMA_VERSION,
      deleted: 0,
      remaining: 0,
      matched: false,
    });
    expect(await tracker.alarmAt()).toBe(clock + 60_000);
    // The cleanup alarm deletes the empty schema.
    await tracker.setClock(clock + 60_000);
    expect(await tracker.runAlarm()).toBe(true);
    expect(await tracker.tables()).toEqual([]);

    const unsub = await tracker.stub.unsubscribe({
      rpcVersion: RPC_SCHEMA_VERSION,
      subscriptionId: crypto.randomUUID(),
    });
    expect(unsub.status).toBe('absent');
    expect(await tracker.alarmAt()).toBe(clock + 120_000);
    // Called on the instance: a throw across the pool's RPC boundary is also reported as an
    // unhandled rejection of the run, which is the plugin's doing, not the object's.
    await expect(
      runInDurableObject(tracker.stub, (instance: FlightTracker) => instance.getCostLedger()),
    ).rejects.toThrow(/^invalid_request/);
    void testEnv;
  });
});

describe('the per-flight caps through the alarm debit path (L4)', () => {
  it('stretches one tier at the soft cap and stops polling at the hard cap', async () => {
    const flight = uniqueFlight();
    const creation = flight.scheduledOut.getTime() - 48 * HOUR_MS;
    const pe = pollEquivalents('aerodatabox', 'flight_status');
    // Soft cap after two polls, hard cap after four.
    const tracker = await seeded(flight, creation, { softCapPe: pe * 2, hardCapPe: pe * 4 });
    tracker.outbox.sent.length = 0;

    // Polls one and two spend to the soft cap exactly; poll three passes it: stretched.
    let clock = creation;
    for (let i = 0; i < 2; i += 1) {
      clock += HOUR_MS;
      await tracker.setClock(clock);
      expect(await tracker.runAlarm()).toBe(true);
      expect((await tracker.stub.getCostLedger()).stretched).toBe(false);
      expect(await tracker.alarmAt()).toBe(clock + HOUR_MS);
    }
    clock += HOUR_MS;
    await tracker.setClock(clock);
    expect(await tracker.runAlarm()).toBe(true);
    const stretched = await tracker.stub.getCostLedger();
    expect(stretched.stretched).toBe(true);
    expect(stretched.hardCapHit).toBe(false);
    // One grid slot skipped from here on: the next alarm is two hours out, not one.
    expect(await tracker.alarmAt()).toBe(clock + 2 * HOUR_MS);
    expect(
      ofKind(tracker.outbox.sent, 'flight_event').map((message) => message.payload.type),
    ).toContain('budget_soft_cap');

    // Poll four spends to the hard cap exactly; poll five would pass it: polling stops.
    clock += 2 * HOUR_MS;
    await tracker.setClock(clock);
    expect(await tracker.runAlarm()).toBe(true);
    expect((await tracker.stub.getCostLedger()).hardCapHit).toBe(false);
    clock = (await tracker.alarmAt()) ?? 0;
    await tracker.setClock(clock);
    expect(await tracker.runAlarm()).toBe(true);
    const capped = await tracker.stub.getCostLedger();
    expect(capped.hardCapHit).toBe(true);
    expect(capped.scheduledPe).toBe(pe * 4);
    expect(await adbCalls(flight)).toBe(5);
    expect(
      ofKind(tracker.outbox.sent, 'flight_event').map((message) => message.payload.type),
    ).toContain('budget_hard_cap');
    // The one reconciliation poll at scheduled arrival, then the flight finishes.
    expect(await tracker.alarmAt()).toBe(flight.scheduledIn.getTime());
    await tracker.setClock(flight.scheduledIn.getTime());
    await scriptAdb(flight, [adbOk(flight, { phase: 'arrived' })]);
    expect(await tracker.runAlarm()).toBe(true);
    expect(await adbCalls(flight)).toBe(6);
    const [row] = await tracker.rows<{ phase: string; finish_reason: string }>(
      'SELECT phase, finish_reason FROM flight',
    );
    expect(row).toEqual({ phase: 'finished', finish_reason: 'arrived' });
  });
});
