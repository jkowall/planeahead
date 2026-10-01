/**
 * The event injector (increment 15, ruling N11) in the Workers pool: the admin route behind
 * Cloudflare Access (its form, the link on `/admin`, its refusals: another origin, bad input, a
 * flight no tracker holds, production without an allow-listed follower), and the increment's
 * acceptance test end to end (plan section 8 row 15): through the real route, the real
 * FlightTracker (its policy, `notif_dedupe` and outbox flush, captured as the persist queue's
 * messages), the real persist consumer (forwarding `notify_intent` to a recorder standing in for
 * the notify queue, and confirming to the tracker), and the real `notify` consumer (the push
 * queue a recorder): an injected gate change makes one push job, a replay of the same injection
 * none, a 10-minute delay (under the 15-minute threshold) none; the tracker's stored snapshot and
 * policy state are what they were before; and every injection leaves an `audit_log` row naming
 * the operator.
 */

import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import {
  auditLog,
  devices,
  flightInstances,
  flightSubscriptions,
  notifications,
  pushTokens,
  users,
} from '@planeahead/db';
import {
  FlightStatusSchema,
  PushJobV1,
  RPC_SCHEMA_VERSION,
  uuidv7,
  type FlightKey,
  type FlightStatus,
  type PersistMessageV1,
} from '@planeahead/shared';
import { createApp } from '../../src/app';
import type { Env } from '../../src/env';
import { ACCESS_JWT_HEADER, accessCertsUrl } from '../../src/middleware/access';
import { createLogger } from '../../src/observability/log';
import { handleNotifyBatch } from '../../src/queues/notify';
import { handlePersistBatch } from '../../src/queues/persist';
import { createAdminRoutes, type AdminRoutesOptions } from '../../src/routes/admin';
import { ADMIN_INJECT_PATH, applyInjectedEvent } from '../../src/routes/admin-inject';
import { API_ORIGIN, testEnv, uniqueEmail, uniqueInstallId } from './helpers/auth';
import {
  HOUR_MS,
  adbOk,
  drainTouched,
  ofKind,
  openBudgetFor,
  resolverHarness,
  scriptAdb,
  trackerHarness,
  uniqueFlight,
  type TestFlight,
  type TrackerHarness,
} from './helpers/flights';
import { db } from './helpers/routes';

afterEach(drainTouched);

const quietLog = createLogger({}, () => undefined);

const TEAM = 'planeahead-inject.cloudflareaccess.com';
const AUD = 'inject0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a';
const OPERATOR = 'owner@planeahead.app';
const keyPair = generateKeyPair('RS256', { extractable: true });

/** A valid Access assertion for the operator, and the certs endpoint that verifies it. */
async function accessToken(): Promise<{ token: string; fetch: typeof fetch }> {
  const { privateKey, publicKey } = await keyPair;
  const jwk = { ...(await exportJWK(publicKey)), kid: 'inject-k1', alg: 'RS256', use: 'sig' };
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ email: OPERATOR, type: 'app' })
    .setProtectedHeader({ alg: 'RS256', kid: 'inject-k1' })
    .setIssuer(`https://${TEAM}`)
    .setAudience([AUD])
    .setSubject('access-owner')
    .setIssuedAt(now - 10)
    .setExpirationTime(now + 600)
    .sign(privateKey);
  const certs: typeof fetch = (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return Promise.resolve(
      url === accessCertsUrl(TEAM)
        ? Response.json({ keys: [jwk] })
        : new Response('not found', { status: 404 }),
    );
  };
  return { token, fetch: certs };
}

function adminEnv(overrides: Partial<Record<string, string>> = {}): Env {
  return {
    ...testEnv,
    API_PUBLIC_URL: API_ORIGIN,
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    CF_ACCOUNT_ID: '',
    CF_API_TOKEN: '',
    ...overrides,
  } as unknown as Env;
}

interface AdminCall {
  readonly path?: string;
  readonly method?: 'GET' | 'POST';
  readonly form?: Record<string, string>;
  /** The `Origin` header; the API's own by default on a POST. */
  readonly origin?: string | null;
  readonly env?: Env;
  readonly options?: AdminRoutesOptions;
}

/** Calls `/admin` behind a valid Access assertion, as the operator's browser would. */
async function admin(call: AdminCall = {}): Promise<Response> {
  const access = await accessToken();
  const app = createApp();
  app.route(
    '/admin',
    createAdminRoutes({
      access: { fetch: access.fetch, cache: new Map() },
      fetch: access.fetch,
      ...call.options,
    }),
  );
  const method = call.method ?? (call.form === undefined ? 'GET' : 'POST');
  const headers: Record<string, string> = { [ACCESS_JWT_HEADER]: access.token };
  const origin = call.origin === undefined ? (method === 'POST' ? API_ORIGIN : null) : call.origin;
  if (origin !== null) {
    headers['origin'] = origin;
  }
  if (call.form !== undefined) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
  }
  const ctx = createExecutionContext();
  const response = await app.fetch(
    new Request(`${API_ORIGIN}${call.path ?? ADMIN_INJECT_PATH}`, {
      method,
      headers,
      ...(call.form === undefined ? {} : { body: new URLSearchParams(call.form).toString() }),
    }),
    call.env ?? adminEnv(),
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

/** Runs captured outbox messages through the real persist consumer; returns what it forwarded. */
async function persist(messages: readonly PersistMessageV1[]): Promise<unknown[]> {
  const forwarded: unknown[] = [];
  const notifyQueue = {
    send: (body: unknown): Promise<void> => {
      forwarded.push(body);
      return Promise.resolve();
    },
  };
  for (let i = 0; i < messages.length; i += 100) {
    const batch = createMessageBatch(
      'planeahead-persist-local',
      messages.slice(i, i + 100).map((body, index) => ({
        id: `p-${String(i + index)}-${crypto.randomUUID()}`,
        timestamp: new Date(),
        attempts: 1,
        body,
      })),
    );
    const ctx = createExecutionContext();
    await handlePersistBatch(
      batch,
      { env: testEnv, ctx, log: quietLog },
      { db: db(), notifyQueue },
    );
    expect((await getQueueResult(batch, ctx)).retryMessages).toEqual([]);
  }
  return forwarded;
}

/** Runs forwarded intents through the real notify consumer; returns the push jobs it queued. */
async function notify(intents: readonly unknown[]): Promise<PushJobV1[]> {
  if (intents.length === 0) {
    return [];
  }
  const sent: unknown[] = [];
  const pushQueue: Pick<Queue, 'sendBatch'> = {
    sendBatch: (messages) => {
      for (const message of messages) {
        sent.push(message.body);
      }
      return Promise.resolve() as unknown as ReturnType<Queue['sendBatch']>;
    },
  };
  const batch = createMessageBatch(
    'planeahead-notify-local',
    intents.map((body, index) => ({
      id: `n-${String(index)}-${crypto.randomUUID()}`,
      timestamp: new Date(),
      attempts: 1,
      body,
    })),
  );
  const ctx = createExecutionContext();
  await handleNotifyBatch(batch, { env: testEnv, ctx, log: quietLog }, { pushQueue });
  const result = await getQueueResult(batch, ctx);
  expect(result.retryMessages).toEqual([]);
  return sent.map((body) => PushJobV1.parse(body));
}

/** What one step of the pipeline after the tracker came to. */
interface PipelineRun {
  readonly persisted: PersistMessageV1[];
  readonly forwarded: unknown[];
  readonly jobs: PushJobV1[];
}

/** The tracker's flushed messages since the last run, through persist and then notify. */
async function pipeline(tracker: TrackerHarness): Promise<PipelineRun> {
  const persisted = tracker.outbox.sent.splice(0);
  const forwarded = await persist(persisted);
  return { persisted, forwarded, jobs: await notify(forwarded) };
}

/**
 * A tracker created through the resolver at `clock` (origin gate B10, scheduled), its outbox and
 * the resolver's run through persist so Postgres holds the flight as production's would.
 */
async function trackedFlight(flight: TestFlight, clock: number): Promise<TrackerHarness> {
  await scriptAdb(flight, [adbOk(flight, { phase: 'expected', originGate: 'B10' })]);
  const tracker = await trackerHarness(flight.flightKey, clock);
  await openBudgetFor(flight, clock);
  const resolver = await resolverHarness(flight, clock);
  const resolved = await resolver.stub.resolve({
    rpcVersion: RPC_SCHEMA_VERSION,
    designator: flight.designator,
    dateLocal: flight.dateLocal,
  });
  expect(resolved.outcome).toBe('resolved');
  expect((await pipeline(tracker)).jobs).toEqual([]);
  await persist(resolver.outbox.sent.splice(0));
  return tracker;
}

/** A user following the flight with one sendable FCM token; returns the user id. */
async function plantFollower(flightKey: FlightKey, liveTracked: boolean): Promise<string> {
  const userId = uuidv7();
  await db()
    .insert(users)
    .values({ id: userId, name: '', email: uniqueEmail('inject') });
  const [instance] = await db()
    .select({ id: flightInstances.id })
    .from(flightInstances)
    .where(eq(flightInstances.flightKey, flightKey));
  expect(instance).toBeDefined();
  await db()
    .insert(flightSubscriptions)
    .values({ id: uuidv7(), userId, flightInstanceId: instance?.id ?? '', liveTracked });
  const deviceId = uuidv7();
  await db()
    .insert(devices)
    .values({ id: deviceId, userId, installId: uniqueInstallId('inject'), platform: 'android' });
  await db()
    .insert(pushTokens)
    .values({
      id: uuidv7(),
      userId,
      deviceId,
      kind: 'fcm',
      token: `tok-${userId}`,
      environment: 'production',
    });
  return userId;
}

/** The tracker's stored row: what an injection must leave as it was. */
async function storedRow(tracker: TrackerHarness): Promise<Record<string, unknown> | undefined> {
  const rows = await tracker.rows<Record<string, unknown>>(
    'SELECT snapshot, policy_state, version, next_refresh_at_ms, phase FROM flight',
  );
  return rows[0];
}

/** The injection id the answer page's replay button carries. */
function injectionIdOf(html: string): string {
  const match = /name="injection_id" value="([0-9a-f-]{36})"/.exec(html);
  expect(match).not.toBeNull();
  return match?.[1] ?? '';
}

async function auditRows(flightKey: FlightKey) {
  const rows = await db()
    .select({
      details: auditLog.details,
      targetId: auditLog.targetId,
      actorType: auditLog.actorType,
    })
    .from(auditLog)
    .where(eq(auditLog.action, 'notify.injected'));
  return rows.filter((row) => (row.details as { flight_key?: string }).flight_key === flightKey);
}

async function rowsFor(dedupeKey: string) {
  return db()
    .select({ userId: notifications.userId, isTest: notifications.isTest })
    .from(notifications)
    .where(eq(notifications.dedupeKey, dedupeKey));
}

describe('the injector end to end (acceptance, plan section 8 row 15)', () => {
  it('a gate change makes one push job, its replay none, a 10-minute delay none; the tracker keeps its state', async () => {
    const flight = uniqueFlight();
    const tracker = await trackedFlight(flight, flight.scheduledOut.getTime() - 2 * HOUR_MS);
    const live = await plantFollower(flight.flightKey, true);
    const notLive = await plantFollower(flight.flightKey, false);
    const before = await storedRow(tracker);
    expect(JSON.parse(String(before?.['snapshot']))).toMatchObject({ originGate: 'B10' });
    const form = { flight_key: flight.flightKey, event: 'origin_gate', gate: 'B12' };

    // The gate change: one intent, forwarded once, one push job, to the live-tracked follower.
    const gate = await admin({ form });
    expect(gate.status).toBe(200);
    const gateHtml = await gate.text();
    const injectionId = injectionIdOf(gateHtml);
    const dedupeKey = `${flight.flightKey}:gate_change:origin:B12:test:${injectionId}`;
    expect(gateHtml).toContain(dedupeKey);
    const first = await pipeline(tracker);
    expect(ofKind(first.persisted, 'notify_intent')).toHaveLength(1);
    expect(first.forwarded).toHaveLength(1);
    expect(first.forwarded[0]).toMatchObject({
      test: true,
      injectionId,
      dedupeKey,
      intent: { kind: 'gate_change', value: 'B12', previousValue: 'B10' },
    });
    expect(first.jobs).toHaveLength(1);
    expect(first.jobs[0]).toMatchObject({
      test: true,
      notificationKind: 'gate_change',
      flightKey: flight.flightKey,
      channelId: 'flight_changes',
    });
    expect(first.jobs[0]?.targets.map((target) => target.subjectId)).toEqual([live]);
    // Both followers get the inbox row, marked as a test; persist confirmed the intent.
    const rows = await rowsFor(dedupeKey);
    expect(new Set(rows.map((row) => row.userId))).toEqual(new Set([live, notLive]));
    expect(rows.every((row) => row.isTest)).toBe(true);
    expect((await tracker.stub.health()).unconfirmedOutbox).toBe(0);

    // The replay (the answer page's button: the same injection id): nothing written or sent.
    const replay = await admin({ form: { ...form, injection_id: injectionId } });
    expect(replay.status).toBe(200);
    expect(await replay.text()).toContain('no (replay)');
    const second = await pipeline(tracker);
    expect(ofKind(second.persisted, 'notify_intent')).toEqual([]);
    expect(second.jobs).toEqual([]);
    expect(await rowsFor(dedupeKey)).toHaveLength(2);

    // Jitter under the thresholds: a 10-minute departure delay is no intent, no push.
    const delay = await admin({
      form: { flight_key: flight.flightKey, event: 'departure_delay', minutes: '10' },
    });
    expect(delay.status).toBe(200);
    expect(await delay.text()).toContain('The policy produced no intents');
    const third = await pipeline(tracker);
    expect(ofKind(third.persisted, 'notify_intent')).toEqual([]);
    expect(third.jobs).toEqual([]);

    // The tracker's stored snapshot, policy state, version and next alarm are as they were.
    expect(await storedRow(tracker)).toEqual(before);
    // One audit row per injection, naming the operator.
    const audit = await auditRows(flight.flightKey);
    expect(audit).toHaveLength(3);
    for (const row of audit) {
      expect(row.actorType).toBe('admin');
      expect(row.details).toMatchObject({
        operator_email: OPERATOR,
        operator_subject: 'access-owner',
      });
    }
    expect(audit.map((row) => (row.details as { written: number }).written).sort()).toEqual([
      0, 0, 1,
    ]);
  });
});

describe('the injector route (N11)', () => {
  it('serves its form behind Access, linked from the push section of /admin', async () => {
    const page = await admin();
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("form-action 'self'");
    expect(page.headers.get('referrer-policy')).toBe('same-origin');
    expect(page.headers.get('cache-control')).toBe('no-store');
    const html = await page.text();
    for (const event of [
      'origin_gate',
      'destination_gate',
      'departure_delay',
      'cancellation',
      'diversion',
    ]) {
      expect(html).toContain(`<option value="${event}"`);
    }
    expect(html).toContain(`<form method="post" action="${ADMIN_INJECT_PATH}">`);
    expect(html).not.toMatch(/<script/i);
    const operations = await (await admin({ path: '/admin' })).text();
    expect(operations).toContain(`href="${ADMIN_INJECT_PATH}"`);
    expect(operations).toContain('the event injector');
  });

  it('refuses another origin, a malformed form, the planned destination and an untracked flight', async () => {
    const flight = uniqueFlight();
    const tracker = await trackedFlight(flight, flight.scheduledOut.getTime() - 2 * HOUR_MS);
    const before = await storedRow(tracker);
    const flightKey = flight.flightKey;
    for (const origin of ['https://evil.example', null]) {
      const refused = await admin({
        form: { flight_key: flightKey, event: 'cancellation' },
        origin,
      });
      expect(refused.status).toBe(403);
    }
    const cases: [Record<string, string>, string][] = [
      [{ flight_key: 'AA100', event: 'cancellation' }, 'That is not a flight key'],
      [{ flight_key: flightKey, event: 'teleport' }, 'Choose an event.'],
      [{ flight_key: flightKey, event: 'origin_gate', gate: 'B 12!' }, 'A gate is 1 to 8'],
      [
        { flight_key: flightKey, event: 'departure_delay', minutes: '-5' },
        'whole number of minutes',
      ],
      [
        { flight_key: flightKey, event: 'departure_delay', minutes: '1441' },
        'whole number of minutes',
      ],
      [{ flight_key: flightKey, event: 'diversion', airport: 'SFO' }, 'four-character ICAO'],
      [
        { flight_key: flightKey, event: 'diversion', airport: 'egll' },
        'EGLL is the planned destination.',
      ],
      [{ flight_key: flightKey, event: 'cancellation', injection_id: 'inj-1' }, 'is a UUIDv7'],
    ];
    for (const [form, message] of cases) {
      const refused = await admin({ form });
      expect(refused.status).toBe(400);
      const html = await refused.text();
      expect(html).toContain(`<p class="unavailable">`);
      expect(html).toContain(message);
    }
    // A flight no tracker holds: `getState` throws `invalid_request`, which Workers RPC carries
    // by name and message (a fake here: a real throw across the pool's RPC boundary is also
    // reported as an unhandled rejection of the run, as flight-tracker.outbox.test.ts notes).
    const injected: unknown[] = [];
    const absentTracker = () => () => ({
      getState: () => {
        const error = new Error('invalid_request: tracker is not seeded');
        error.name = 'RpcRequestError';
        return Promise.reject(error);
      },
      injectPolicyEvent: (input: unknown) => {
        injected.push(input);
        return Promise.resolve({});
      },
    });
    const absent = await admin({
      form: { flight_key: uniqueFlight().flightKey, event: 'cancellation' },
      options: { injectorFor: absentTracker },
    });
    expect(absent.status).toBe(404);
    expect(await absent.text()).toContain('No tracker holds that flight');
    expect(injected).toEqual([]);
    // Nothing reached the tracker, nothing was audited.
    expect(tracker.outbox.sent).toEqual([]);
    expect(await storedRow(tracker)).toEqual(before);
    expect(await auditRows(flightKey)).toEqual([]);
  });
});

describe('the injector on production (N11)', () => {
  it('injects only into a flight that a live subscriber in PUSH_INJECT_ALLOWED_USER_IDS follows', async () => {
    const flight = uniqueFlight();
    const tracker = await trackedFlight(flight, flight.scheduledOut.getTime() - 2 * HOUR_MS);
    const follower = await plantFollower(flight.flightKey, true);
    const gone = await plantFollower(flight.flightKey, true);
    await db()
      .update(flightSubscriptions)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(flightSubscriptions.userId, gone));
    const production = (allowed: string) =>
      adminEnv({ ENVIRONMENT: 'production', PUSH_INJECT_ALLOWED_USER_IDS: allowed });
    const form = { flight_key: flight.flightKey, event: 'cancellation' };

    // Unset, an allow-listed user who follows nothing, and one who unsubscribed: refused.
    for (const allowed of ['', uuidv7(), gone]) {
      const refused = await admin({ form, env: production(allowed) });
      expect(refused.status).toBe(403);
      expect(await refused.text()).toContain('PUSH_INJECT_ALLOWED_USER_IDS');
    }
    expect(tracker.outbox.sent).toEqual([]);
    const page = await (await admin({ env: production('') })).text();
    expect(page).toContain('Production: only a flight one of whose subscribers');

    // A live follower on the list (read as the test push reads it: trimmed, any case).
    const accepted = await admin({ form, env: production(` ${follower.toUpperCase()} ,x`) });
    expect(accepted.status).toBe(200);
    expect(await accepted.text()).toContain('<td>cancellation</td>');
    const intents = ofKind(tracker.outbox.sent, 'notify_intent');
    expect(intents).toHaveLength(1);
    expect(intents[0]?.payload).toMatchObject({ test: true, intent: { kind: 'cancellation' } });
    const [audit] = await auditRows(flight.flightKey);
    expect(audit?.details).toMatchObject({
      event: { kind: 'cancellation' },
      written: 1,
      outcome: 'injected',
    });
    expect(audit?.targetId).not.toBeNull();
  });
});

describe('applyInjectedEvent (pure)', () => {
  const snapshot: FlightStatus = FlightStatusSchema.parse({
    operatingCarrierIcao: 'AAL',
    flightNumber: '100',
    origin: { icao: 'KJFK' },
    destination: { icao: 'KLAX' },
    status: 'scheduled',
    times: { scheduledOut: '2100-03-04T15:00:00.000Z', scheduledIn: '2100-03-04T21:10:00.000Z' },
    originGate: 'A4',
    fetchedAt: '2100-03-04T12:00:00.000Z',
    source: 'aerodatabox',
  });
  const now = Date.parse('2100-03-04T13:00:00.000Z');

  it('applies each event to a copy observed now, leaving the snapshot as it was', () => {
    const copy = structuredClone(snapshot);
    const gate = applyInjectedEvent(snapshot, { kind: 'origin_gate', gate: 'B12' }, now);
    expect(gate).toMatchObject({
      ok: true,
      status: { originGate: 'B12', fetchedAt: '2100-03-04T13:00:00.000Z' },
    });
    expect(
      applyInjectedEvent(snapshot, { kind: 'destination_gate', gate: '52' }, now),
    ).toMatchObject({
      ok: true,
      status: { destinationGate: '52', originGate: 'A4' },
    });
    expect(
      applyInjectedEvent(snapshot, { kind: 'departure_delay', minutes: 45 }, now),
    ).toMatchObject({
      ok: true,
      status: {
        times: {
          estimatedOut: '2100-03-04T15:45:00.000Z',
          estimatedIn: '2100-03-04T21:55:00.000Z',
        },
        departureDelaySec: 2_700,
        arrivalDelaySec: 2_700,
      },
    });
    expect(applyInjectedEvent(snapshot, { kind: 'cancellation' }, now)).toMatchObject({
      ok: true,
      status: { status: 'cancelled' },
    });
    expect(applyInjectedEvent(snapshot, { kind: 'diversion', airport: 'KSFO' }, now)).toMatchObject(
      {
        ok: true,
        status: { status: 'diverted', actualDestination: { icao: 'KSFO' } },
      },
    );
    // A placeholder code is marked synthetic, as the airport schema requires.
    const placeholder = applyInjectedEvent(snapshot, { kind: 'diversion', airport: 'ZZAB' }, now);
    expect(placeholder.ok && FlightStatusSchema.safeParse(placeholder.status).success).toBe(true);
    expect(snapshot).toEqual(copy);
  });

  it('refuses a diversion to the planned destination and a delay with no scheduled out', () => {
    expect(applyInjectedEvent(snapshot, { kind: 'diversion', airport: 'KLAX' }, now)).toEqual({
      ok: false,
      message: 'KLAX is the planned destination.',
    });
    const unscheduled = { ...snapshot, times: {} };
    expect(
      applyInjectedEvent(unscheduled, { kind: 'departure_delay', minutes: 30 }, now),
    ).toMatchObject({
      ok: false,
    });
  });
});
