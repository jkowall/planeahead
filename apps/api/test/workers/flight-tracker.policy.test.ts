/**
 * The notification policy inside the FlightTracker (increment 15, rulings N2, N4, N7, N8, N11):
 *
 *   - N4: a cancellation seen by a poll is only suspected; the tracker never finishes on it
 *     before the confirming re-read (at most 5 minutes later, by designator through the router),
 *     a failed re-read is retried rather than trusted, a confirmed one writes the intent and
 *     finishes, a cleared one keeps polling and writes nothing; an un-cancellation after a pushed
 *     cancellation is pushed only after its own re-read;
 *   - N2: a delay reaching the line moves the next alarm to at most 5 minutes out, and that
 *     settle re-read writes the intent only when it still shows the delay;
 *   - N11: the injector writes test intents and leaves the stored snapshot and policy state as
 *     they were, and a replayed injection writes nothing;
 *   - N8: a ground delay keeps the 15-minute band running past scheduled out until the flight
 *     actually leaves, which adds polls.
 */

import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { RPC_SCHEMA_VERSION, readPolicyState, type FlightStatusInput } from '@planeahead/shared';
import type { FlightTracker } from '../../src/do/flight-tracker';
import {
  HOUR_MS,
  MINUTE_MS,
  adbCalls,
  drainTouched,
  scriptAdb,
  uniqueFlight,
} from './helpers/flights';
import {
  answer,
  flightRow,
  eventsOf,
  instancesOf,
  intentsOf,
  nextAlarm,
  seeded,
} from './helpers/policy';

afterEach(drainTouched);

describe('N4: a cancellation is confirmed before it is pushed or finishes the tracker', () => {
  it('suspects, retries a failed re-read, then confirms: one intent, and the finish path', async () => {
    const flight = uniqueFlight();
    const tracker = await seeded(flight, flight.scheduledOut.getTime() - 2 * HOUR_MS);
    const cancelled = answer(flight, { phase: 'expected' }, { status: 'Canceled' });
    await scriptAdb(flight, [cancelled]);
    const seen = await nextAlarm(tracker);
    // Suspected: nothing pushed, the tracker alive, its next alarm the re-read 5 minutes out.
    // Review ruling Q11 (1) changed this on purpose: the suspicion is evidence, not state, so
    // the stored snapshot, its phase and the instance row stay the last confirmed ones (they
    // said `cancelled` with `cancelSuspect` before), and a `cancel_suspect` event records it.
    expect(await flightRow(tracker)).toMatchObject({ phase: 'scheduled', finish_reason: null });
    expect(intentsOf(tracker)).toEqual([]);
    expect(await tracker.alarmAt()).toBe(seen + 5 * MINUTE_MS);
    expect(instancesOf(tracker).at(-1)?.payload).toMatchObject({
      phase: 'scheduled',
      trackingState: 'tracking',
      nextRefreshAt: new Date(seen + 5 * MINUTE_MS).toISOString(),
    });
    expect(eventsOf(tracker, 'cancel_suspect')).toMatchObject([
      { field: 'cancellation', newValue: 'cancelled', source: 'aerodatabox' },
    ]);

    // The re-read fails (a provider error): the suspicion is neither trusted nor dropped, and
    // the policy counts the failed re-read (review ruling Q3 as Q11 bounds it): the next one is
    // a fast re-read 5 minutes later, never at once.
    await scriptAdb(flight, [{ status: 500, body: { message: 'unavailable' } }]);
    const failed = await nextAlarm(tracker);
    expect(failed).toBe(seen + 5 * MINUTE_MS);
    expect(await flightRow(tracker)).toMatchObject({ phase: 'scheduled', finish_reason: null });
    expect(intentsOf(tracker)).toEqual([]);
    expect(await tracker.alarmAt()).toBe(failed + 5 * MINUTE_MS);

    // The retried re-read confirms: one cancellation intent, then the finish path as before.
    await scriptAdb(flight, [cancelled]);
    await nextAlarm(tracker);
    const intents = intentsOf(tracker);
    expect(intents).toHaveLength(1);
    expect(intents[0]?.payload).toMatchObject({
      kind: 'notify_intent',
      flightKey: flight.flightKey,
      intent: { kind: 'cancellation', subject: 'flight', value: 'cancelled', correction: false },
      flight: { status: 'cancelled' },
      test: false,
    });
    expect(await flightRow(tracker)).toMatchObject({
      phase: 'finished',
      finish_reason: 'cancelled',
    });
    expect(instancesOf(tracker).at(-1)?.payload).toMatchObject({ trackingState: 'finished' });
    expect(instancesOf(tracker).some((m) => 'cancelSuspect' in m.payload)).toBe(false);
    expect(await adbCalls(flight)).toBe(4);
  });

  it('a re-read that is not cancelled clears the suspicion, pushes nothing and keeps polling', async () => {
    const flight = uniqueFlight();
    const tracker = await seeded(flight, flight.scheduledOut.getTime() - 2 * HOUR_MS);
    await scriptAdb(flight, [answer(flight, { phase: 'expected' }, { status: 'Canceled' })]);
    const seen = await nextAlarm(tracker);
    await scriptAdb(flight, [answer(flight, { phase: 'expected' })]);
    const reread = await nextAlarm(tracker);
    expect(reread).toBe(seen + 5 * MINUTE_MS);
    const row = await flightRow(tracker);
    expect(row).toMatchObject({ phase: 'scheduled', finish_reason: null });
    expect(JSON.parse(row?.policy_state ?? '{}')).toMatchObject({
      cancellation: { status: 'none' },
    });
    expect(intentsOf(tracker)).toEqual([]);
    // Back on the cadence's own grid.
    expect(await tracker.alarmAt()).toBe(seen + 15 * MINUTE_MS);
  });
});

describe('N4 (open question 8): an un-cancellation is confirmed before its correction', () => {
  it('pushes the un-cancellation only after its own re-read', async () => {
    const flight = uniqueFlight();
    const clock = flight.scheduledOut.getTime() - 2 * HOUR_MS;
    const tracker = await seeded(flight, clock);
    // A confirmed cancellation finishes the tracker, so a live tracker that holds a pushed
    // cancellation is set up directly: the state such a tracker would hold.
    await runInDurableObject(tracker.stub, (_instance: FlightTracker, state) => {
      const [row] = state.storage.sql
        .exec<{ policy_state: string }>('SELECT policy_state FROM flight')
        .toArray();
      const policy = JSON.parse(row?.policy_state ?? '{}') as Record<string, unknown>;
      policy['cancellation'] = { status: 'pushed', at: clock, value: 'cancelled' };
      state.storage.sql.exec('UPDATE flight SET policy_state = ?', JSON.stringify(policy));
    });
    // The flight shows as operating: suspected, nothing pushed, the re-read 5 minutes out.
    const seen = await nextAlarm(tracker);
    expect(intentsOf(tracker)).toEqual([]);
    expect(JSON.parse((await flightRow(tracker))?.policy_state ?? '{}')).toMatchObject({
      cancellation: { status: 'suspect', value: 'uncancelled', pushedAt: clock },
    });
    expect(await tracker.alarmAt()).toBe(seen + 5 * MINUTE_MS);
    // The re-read still shows it operating: the correction.
    await nextAlarm(tracker);
    const intents = intentsOf(tracker);
    expect(intents.map((m) => m.payload.intent)).toMatchObject([
      {
        kind: 'cancellation',
        value: 'uncancelled',
        previousValue: 'cancelled',
        correction: true,
      },
    ]);
  });
});

describe('N2: the settle re-read', () => {
  it('runs at most 5 minutes after the line and pushes the re-read value when confirmed', async () => {
    const flight = uniqueFlight();
    const out = flight.scheduledOut.getTime();
    const tracker = await seeded(flight, out - 2 * HOUR_MS);
    const delayed = (minutes: number) =>
      answer(flight, { phase: 'expected' }, { departureRevisedMs: out + minutes * MINUTE_MS });
    await scriptAdb(flight, [delayed(30)]);
    const seen = await nextAlarm(tracker);
    expect(intentsOf(tracker)).toEqual([]);
    const settle = await tracker.alarmAt();
    expect(settle).toBe(seen + 5 * MINUTE_MS);
    await scriptAdb(flight, [delayed(35)]);
    await nextAlarm(tracker);
    expect(intentsOf(tracker).map((m) => m.payload.intent)).toMatchObject([
      { kind: 'delay', subject: 'departure', value: '35', previousValue: '0', correction: false },
    ]);
    expect(await tracker.alarmAt()).toBe(seen + 15 * MINUTE_MS);
  });

  it('clears a delay that is back under the line on the re-read, pushing nothing', async () => {
    const flight = uniqueFlight();
    const out = flight.scheduledOut.getTime();
    const tracker = await seeded(flight, out - 2 * HOUR_MS);
    await scriptAdb(flight, [
      answer(flight, { phase: 'expected' }, { departureRevisedMs: out + 20 * MINUTE_MS }),
    ]);
    const seen = await nextAlarm(tracker);
    await scriptAdb(flight, [
      answer(flight, { phase: 'expected' }, { departureRevisedMs: out + 5 * MINUTE_MS }),
    ]);
    expect(await nextAlarm(tracker)).toBe(seen + 5 * MINUTE_MS);
    expect(intentsOf(tracker)).toEqual([]);
    expect(JSON.parse((await flightRow(tracker))?.policy_state ?? '{}')).toMatchObject({
      delay: { pending: null },
    });
    expect(await tracker.alarmAt()).toBe(seen + 15 * MINUTE_MS);
  });
});

describe('N8: a ground delay keeps the 15-minute band until the flight leaves', () => {
  it('polls every 15 minutes past scheduled out while the flight is held, then every 30', async () => {
    const flight = uniqueFlight();
    const out = flight.scheduledOut.getTime();
    const heldMs = 60 * MINUTE_MS;
    const held = answer(flight, { phase: 'expected' }, { departureRevisedMs: out + heldMs });
    const gone = answer(
      flight,
      { phase: 'en_route' },
      {
        departureRevisedMs: out + heldMs,
        departureRunwayMs: out + heldMs + 10 * MINUTE_MS,
        arrivalRevisedMs: flight.scheduledIn.getTime() + heldMs,
      },
    );
    // Created with the delay already known: it is the policy's baseline, so no settle re-read
    // joins the walk and every alarm below is a cadence slot.
    const tracker = await seeded(flight, out - 30 * MINUTE_MS, held);
    const slots: number[] = [];
    while (slots.length === 0 || (slots.at(-1) ?? 0) < 90) {
      const at = await tracker.alarmAt();
      await scriptAdb(flight, [(at ?? 0) >= out + heldMs ? gone : held]);
      slots.push(((await nextAlarm(tracker)) - out) / MINUTE_MS);
    }
    // Minutes after scheduled out. Anchored on scheduled out (before N8) the 30-minute band
    // would have started at 0 (30, 60, 90): held at the gate, the flight is read every 15.
    expect(slots).toEqual([-15, 0, 15, 30, 45, 60, 90]);
    expect(intentsOf(tracker)).toEqual([]);
    expect(await adbCalls(flight)).toBe(1 + slots.length);
  });
});

describe('N11: the event injector', () => {
  it('writes test intents and stores neither the synthetic snapshot nor the policy state', async () => {
    const flight = uniqueFlight();
    const out = flight.scheduledOut.getTime();
    const tracker = await seeded(
      flight,
      out - 2 * HOUR_MS,
      answer(flight, { phase: 'expected', originGate: 'B10' }),
    );
    const stored = async () =>
      (
        await tracker.rows<Record<string, unknown>>(
          'SELECT snapshot, policy_state, version, next_refresh_at_ms FROM flight',
        )
      )[0];
    const before = await stored();
    const snapshot = JSON.parse(String(before?.['snapshot'])) as FlightStatusInput;
    const inject = (injectionId: string, status: FlightStatusInput) =>
      tracker.stub.injectPolicyEvent({ rpcVersion: RPC_SCHEMA_VERSION, injectionId, status });

    const gate = await inject('inj-gate', { ...snapshot, originGate: 'B12' });
    expect(gate).toMatchObject({
      outcome: 'injected',
      intents: [{ kind: 'gate_change', subject: 'origin', value: 'B12', written: true }],
    });
    expect(gate.intents[0]?.dedupeKey).toBe(
      `${flight.flightKey}:gate_change:origin:B12:test:inj-gate`,
    );
    expect(intentsOf(tracker).map((m) => m.payload)).toMatchObject([
      {
        test: true,
        injectionId: 'inj-gate',
        intent: { kind: 'gate_change', value: 'B12', previousValue: 'B10' },
        flight: { originGate: 'B12' },
      },
    ]);
    // Nothing of the synthetic observation was stored.
    expect(await stored()).toEqual(before);

    // A replay of the same injection writes nothing; a cancellation is confirmed by construction
    // (pushed at once) and, never stored, finishes nothing.
    expect((await inject('inj-gate', { ...snapshot, originGate: 'B12' })).intents).toMatchObject([
      { written: false },
    ]);
    const cancel = await inject('inj-cancel', { ...snapshot, status: 'cancelled' });
    expect(cancel.intents).toMatchObject([{ kind: 'cancellation', written: true }]);
    expect(intentsOf(tracker)).toHaveLength(2);
    expect(await stored()).toEqual(before);
    expect(await flightRow(tracker)).toMatchObject({ phase: 'scheduled', finish_reason: null });

    // The next real poll diffs against real data: no change back, no intent (its flush re-sends
    // the two unconfirmed rows, so distinct seqs are what is counted).
    await nextAlarm(tracker);
    expect(new Set(intentsOf(tracker).map((m) => m.seq)).size).toBe(2);
    expect(await adbCalls(flight)).toBe(2);
  });
});

describe('the stored policy state (migration 003)', () => {
  it('is seeded at creation, and from the stored snapshot when absent or unreadable', async () => {
    for (const stored of [null, '{"v":99}', 'not json']) {
      const flight = uniqueFlight();
      const out = flight.scheduledOut.getTime();
      const first = answer(flight, { phase: 'expected', originGate: 'B10' });
      const tracker = await seeded(flight, out - 2 * HOUR_MS, first);
      const created = (await flightRow(tracker))?.policy_state ?? 'null';
      expect(readPolicyState(JSON.parse(created))).toMatchObject({
        gates: { origin: { seen: 'B10', pushed: null } },
      });
      await runInDurableObject(tracker.stub, (_instance: FlightTracker, state) => {
        state.storage.sql.exec('UPDATE flight SET policy_state = ?', stored);
      });
      await scriptAdb(flight, [answer(flight, { phase: 'expected', originGate: 'B12' })]);
      await nextAlarm(tracker);
      // The stored snapshot is the baseline: the change against it is pushed, nothing else.
      expect(intentsOf(tracker).map((m) => m.payload.intent)).toMatchObject([
        { kind: 'gate_change', value: 'B12', previousValue: 'B10' },
      ]);
      const after = (await flightRow(tracker))?.policy_state ?? 'null';
      expect(readPolicyState(JSON.parse(after))).toMatchObject({
        gates: { origin: { seen: 'B12' } },
      });
    }
  });
});
