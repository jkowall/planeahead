/**
 * Increment 15 review ruling Q1 (findings F1 and B1), the real path end to end: the FlightTracker's
 * alarm, its WHOLE flush through the persist consumer (the intent, then the instance rows that
 * release the live-tracking slot, as one persist batch applies them), then the notify consumer.
 * Before the ruling, persist cleared `live_tracked` milliseconds after forwarding the intent and
 * notify, reading a second later, pushed nobody: every confirmed cancellation and every arrival
 * delay produced on the landing observation reached the inbox only.
 */

import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { notifications } from '@planeahead/db';
import type { NotifyIntentV1, PersistMessageV1 } from '@planeahead/shared';
import { HOUR_MS, MINUTE_MS, drainTouched, scriptAdb, uniqueFlight } from './helpers/flights';
import {
  notify,
  pipeline,
  plantFollower,
  pushAndRecord,
  subjectsOf,
  subscriptionState,
  type Follower,
} from './helpers/pipeline';
import { answer, nextAlarm, seeded } from './helpers/policy';
import { db } from './helpers/routes';

afterEach(async () => {
  vi.restoreAllMocks();
  await drainTouched();
});

/** The intents a pipeline step forwarded. */
const intentsIn = (forwarded: readonly unknown[]) => forwarded as NotifyIntentV1[];

describe('Q1: a change produced in the alarm that releases the slot is still pushed', () => {
  it('a suspected, then confirmed cancellation: one push job, to the live-tracked subscriber only', async () => {
    const flight = uniqueFlight();
    const clock = flight.scheduledOut.getTime() - 2 * HOUR_MS;
    const tracker = await seeded(flight, clock);
    expect((await pipeline(tracker)).jobs).toEqual([]);
    const live = await plantFollower(flight.flightKey, { liveTracked: true });
    const releasedBefore = await plantFollower(flight.flightKey, {
      liveTracked: false,
      releasedAt: new Date(clock).toISOString(),
    });
    const capRefused = await plantFollower(flight.flightKey, { liveTracked: false });

    await scriptAdb(flight, [answer(flight, { phase: 'expected' }, { status: 'Canceled' })]);
    await nextAlarm(tracker);
    const suspected = await pipeline(tracker);
    expect(suspected.forwarded).toEqual([]);
    expect(await subscriptionState(live)).toEqual({ live: true, releasedAt: null });

    await nextAlarm(tracker);
    const confirmed = await pipeline(tracker);
    const [intent, ...more] = intentsIn(confirmed.forwarded);
    expect(more).toEqual([]);
    expect(intent?.intent.kind).toBe('cancellation');
    await expectReleasedBy(confirmed.persisted, live, intent);
    expect(confirmed.jobs).toHaveLength(1);
    expect(subjectsOf(confirmed.jobs)).toEqual([live.userId]);
    expect(await inboxOf([live, releasedBefore, capRefused], intent)).toEqual([true, true, true]);
  });

  it('the same when the confirming re-read differs from the suspected read', async () => {
    const flight = uniqueFlight();
    const out = flight.scheduledOut.getTime();
    const tracker = await seeded(flight, out - 2 * HOUR_MS);
    expect((await pipeline(tracker)).jobs).toEqual([]);
    const live = await plantFollower(flight.flightKey, { liveTracked: true });

    // The suspicion and its re-read disagree on everything but the status (the skeptics' case
    // D: the re-read is another provider's, or the airline moved the gate meanwhile).
    await scriptAdb(flight, [
      answer(flight, { phase: 'expected' }, { status: 'Canceled' }),
      answer(
        flight,
        { phase: 'expected', originGate: 'C7' },
        { status: 'Canceled', departureRevisedMs: out + 40 * MINUTE_MS },
      ),
    ]);
    await nextAlarm(tracker);
    expect((await pipeline(tracker)).forwarded).toEqual([]);
    await nextAlarm(tracker);
    const confirmed = await pipeline(tracker);

    const cancellation = intentsIn(confirmed.forwarded).find(
      (forwarded) => forwarded.intent.kind === 'cancellation',
    );
    expect(cancellation).toBeDefined();
    await expectReleasedBy(confirmed.persisted, live, cancellation);
    const pushed = confirmed.jobs.filter((job) => job.notificationKind === 'cancellation');
    expect(pushed).toHaveLength(1);
    expect(subjectsOf(confirmed.jobs)).toEqual(confirmed.jobs.map(() => live.userId));
  });

  it('an arrival delay produced on the observation that lands the flight is pushed', async () => {
    const flight = uniqueFlight();
    const landing = flight.scheduledIn.getTime() + 40 * MINUTE_MS;
    const tracker = await seeded(flight, flight.scheduledOut.getTime() - 2 * HOUR_MS);
    expect((await pipeline(tracker)).jobs).toEqual([]);
    const live = await plantFollower(flight.flightKey, { liveTracked: true });
    const capRefused = await plantFollower(flight.flightKey, { liveTracked: false });

    // The first poll after landing: arrived, 40 minutes late, and no delay pushed before.
    await scriptAdb(flight, [answer(flight, { phase: 'arrived' }, { arrivalRevisedMs: landing })]);
    await tracker.setClock(landing + 5 * MINUTE_MS);
    expect(await tracker.runAlarm()).toBe(true);
    const landed = await pipeline(tracker);

    const [intent, ...more] = intentsIn(landed.forwarded);
    expect(more).toEqual([]);
    expect(intent?.intent).toMatchObject({ kind: 'delay', subject: 'arrival', value: '40' });
    await expectReleasedBy(landed.persisted, live, intent);
    expect(landed.jobs).toHaveLength(1);
    expect(subjectsOf(landed.jobs)).toEqual([live.userId]);
    expect(await inboxOf([live, capRefused], intent)).toEqual([true, true]);
  });
});

describe('Q1 duplicate guard (F6): a re-sent intent pushes no device twice', () => {
  it('pushes again before its deliveries are recorded, and nothing once they are', async () => {
    const flight = uniqueFlight();
    const out = flight.scheduledOut.getTime();
    const tracker = await seeded(flight, out - 2 * HOUR_MS);
    expect((await pipeline(tracker)).jobs).toEqual([]);
    const live = await plantFollower(flight.flightKey, { liveTracked: true });
    await scriptAdb(flight, [answer(flight, { phase: 'expected' }, { status: 'Canceled' })]);
    await nextAlarm(tracker);
    await pipeline(tracker);
    await nextAlarm(tracker);
    const confirmed = await pipeline(tracker);
    expect(subjectsOf(confirmed.jobs)).toEqual([live.userId]);

    // A redelivery after a failed `sendBatch`: no delivery row yet, so it sends again.
    expect(subjectsOf(await notify(confirmed.forwarded))).toEqual([live.userId]);

    // The push consumer sends and persist records the outcome; then the finished tracker's
    // +22 h re-send of the intent (its confirmation lost) reaches notify once more.
    await pushAndRecord(confirmed.jobs);
    expect(await notify(confirmed.forwarded)).toEqual([]);
    expect(await inboxOf([live], intentsIn(confirmed.forwarded)[0])).toEqual([true]);
  });
});

/**
 * The flush carried a row that is over (persist released the slot in the same batch that
 * forwarded the intent), and the release is stamped with that row's instant, the intent's own.
 */
async function expectReleasedBy(
  persisted: readonly PersistMessageV1[],
  follower: Follower,
  intent: NotifyIntentV1 | undefined,
): Promise<void> {
  const over = persisted.filter(
    (message) =>
      message.kind === 'flight_instance' &&
      (['cancelled', 'arrived'].includes(message.payload.snapshot?.status ?? '') ||
        message.payload.trackingState === 'finished'),
  );
  expect(over.length).toBeGreaterThan(0);
  const state = await subscriptionState(follower);
  expect(state.live).toBe(false);
  expect(Date.parse(state.releasedAt ?? '')).toBe(Date.parse(intent?.producedAt ?? ''));
}

/** Whether each follower has the intent's `notifications` row. */
async function inboxOf(
  followers: readonly Follower[],
  intent: NotifyIntentV1 | undefined,
): Promise<boolean[]> {
  const rows = await db()
    .select({ userId: notifications.userId })
    .from(notifications)
    .where(eq(notifications.dedupeKey, intent?.dedupeKey ?? ''));
  const users = new Set(rows.map((row) => row.userId));
  return followers.map((follower) => users.has(follower.userId));
}
