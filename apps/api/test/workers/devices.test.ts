/**
 * `POST /v1/devices` through the real Worker: the guard, the upsert on `(user_id, install_id)`,
 * the push token upsert on `(kind, token)` with its cross-user rule (a token moves between
 * users only when the registering installation is the one the token already points at), the
 * header-versus-body install id check, and (ruling F2) the increment 4 idempotency contract for
 * anonymous callers, which the route keeps: a keyed request replays under `X-Install-Id`, and
 * one without it is answered 400.
 */

import { eq } from 'drizzle-orm';
import { devices, pushTokens, withDb } from '@planeahead/db';
import { describe, expect, it } from 'vitest';
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_REPLAYED_HEADER,
  INSTALL_ID_HEADER,
} from '../../src/middleware/idempotency';
import {
  captureLogs,
  cookiesFrom,
  jsonRequest,
  logEvents,
  magicLinkTokenFor,
  registerDevice,
  signInAnonymously,
  testEnv,
  uniqueEmail,
  uniqueInstallId,
  uniqueIp,
  verifyMagicLink,
  worker,
} from './helpers/auth';

interface DeviceBody {
  readonly device?: { id: string; installId: string; platform: string };
  readonly pushToken?: { id: string; kind: string } | null;
  readonly error?: string;
}

describe('POST /v1/devices', () => {
  it('answers 401 without a session', async () => {
    const response = await worker(
      jsonRequest('/v1/devices', 'POST', { installId: uniqueInstallId('nobody'), platform: 'ios' }),
    );

    expect(response.status).toBe(401);
    expect((await response.json<DeviceBody>()).error).toBe('unauthenticated');
  });

  it('creates the device, then updates the same row on a second registration', async () => {
    const session = await signInAnonymously();
    const installId = uniqueInstallId('device');

    const first = await registerDevice(session, installId, {
      osVersion: '18.0',
      appVersion: '1.0.0',
    });
    const firstBody = await first.json<DeviceBody>();
    const second = await registerDevice(session, installId, {
      osVersion: '18.1',
      appVersion: '1.0.1',
    });
    const secondBody = await second.json<DeviceBody>();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(firstBody.device?.installId).toBe(installId);
    expect(secondBody.device?.id).toBe(firstBody.device?.id);
    expect(firstBody.pushToken).toBeNull();

    const rows = await withDb(testEnv, (db) =>
      db
        .select({
          userId: devices.userId,
          osVersion: devices.osVersion,
          appVersion: devices.appVersion,
        })
        .from(devices)
        .where(eq(devices.installId, installId)),
    );
    expect(rows).toEqual([{ userId: session.userId, osVersion: '18.1', appVersion: '1.0.1' }]);
  });

  it('upserts the push token on (kind, token) and moves it to the device that registered it last', async () => {
    const session = await signInAnonymously();
    const token = `apns-${crypto.randomUUID()}`;
    const installA = uniqueInstallId('token-a');
    const installB = uniqueInstallId('token-b');

    const a = await registerDevice(session, installA, { pushTokenKind: 'apns', pushToken: token });
    const aBody = await a.json<DeviceBody>();
    const b = await registerDevice(session, installB, {
      pushTokenKind: 'apns',
      pushToken: token,
      pushEnvironment: 'sandbox',
    });
    const bBody = await b.json<DeviceBody>();

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(aBody.pushToken?.kind).toBe('apns');
    expect(bBody.pushToken?.id).toBe(aBody.pushToken?.id);

    const rows = await withDb(testEnv, (db) =>
      db
        .select({
          deviceId: pushTokens.deviceId,
          environment: pushTokens.environment,
          invalidatedAt: pushTokens.invalidatedAt,
        })
        .from(pushTokens)
        .where(eq(pushTokens.token, token)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deviceId).toBe(bBody.device?.id);
    expect(rows[0]?.environment).toBe('sandbox');
    expect(rows[0]?.invalidatedAt).toBeNull();
  });

  it('stores a Live Activity push-to-start token under its own kind, next to the device token (increment 11)', async () => {
    const session = await signInAnonymously();
    const installId = uniqueInstallId('push-to-start');
    const deviceToken = `apns-${crypto.randomUUID()}`;
    const pushToStartToken = `p2s-${crypto.randomUUID()}`;

    const device = await registerDevice(session, installId, {
      pushTokenKind: 'apns',
      pushToken: deviceToken,
      pushEnvironment: 'production',
    });
    const pushToStart = await registerDevice(session, installId, {
      pushTokenKind: 'apns_live_activity_push_to_start',
      pushToken: pushToStartToken,
      pushEnvironment: 'production',
    });
    const pushToStartBody = await pushToStart.json<DeviceBody>();
    const again = await registerDevice(session, installId, {
      pushTokenKind: 'apns_live_activity_push_to_start',
      pushToken: pushToStartToken,
      pushEnvironment: 'production',
    });
    const againBody = await again.json<DeviceBody>();

    expect(device.status).toBe(200);
    expect(pushToStart.status).toBe(200);
    expect(pushToStartBody.pushToken?.kind).toBe('apns_live_activity_push_to_start');
    expect(againBody.pushToken?.id).toBe(pushToStartBody.pushToken?.id);
    const rows = await withDb(testEnv, (db) =>
      db
        .select({ kind: pushTokens.kind, environment: pushTokens.environment })
        .from(pushTokens)
        .where(eq(pushTokens.deviceId, pushToStartBody.device?.id ?? '')),
    );
    expect(rows.map((row) => row.kind).sort()).toEqual([
      'apns',
      'apns_live_activity_push_to_start',
    ]);
    expect(rows.every((row) => row.environment === 'production')).toBe(true);
  });

  it('rejects a body whose installId disagrees with X-Install-Id, an unknown platform, and a token without a kind', async () => {
    const session = await signInAnonymously();
    const installId = uniqueInstallId('validate');

    const mismatch = await registerDevice(
      session,
      installId,
      {},
      { [INSTALL_ID_HEADER]: uniqueInstallId('other') },
    );
    const platform = await registerDevice(session, installId, { platform: 'windows' });
    const tokenOnly = await registerDevice(session, installId, { pushToken: 'x'.repeat(32) });
    const liveActivity = await registerDevice(session, installId, {
      pushTokenKind: 'apns_live_activity_update',
      pushToken: 'x'.repeat(32),
    });

    expect(mismatch.status).toBe(400);
    expect((await mismatch.json<DeviceBody>()).error).toBe('install_id_mismatch');
    expect(platform.status).toBe(400);
    expect(tokenOnly.status).toBe(400);
    expect(liveActivity.status).toBe(400);
  });

  it('replays a keyed registration, scoped by the signed-in user (ruling K1)', async () => {
    const session = await signInAnonymously();
    const installId = uniqueInstallId('idem');
    const key = `devices-${crypto.randomUUID()}`;

    const first = await registerDevice(
      session,
      installId,
      {},
      {
        [IDEMPOTENCY_KEY_HEADER]: key,
        [INSTALL_ID_HEADER]: installId,
      },
    );
    const firstBody = await first.json<DeviceBody>();
    const replay = await registerDevice(
      session,
      installId,
      {},
      {
        [IDEMPOTENCY_KEY_HEADER]: key,
        [INSTALL_ID_HEADER]: installId,
      },
    );
    const replayBody = await replay.json<DeviceBody>();
    const unscoped = await registerDevice(
      session,
      installId,
      {},
      { [IDEMPOTENCY_KEY_HEADER]: key },
    );

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBe('true');
    expect(replayBody).toEqual(firstBody);
    // Increment 8 (ruling K1): `/v1` has its own idempotency instance behind auth, so a signed-in
    // caller's key is scoped by the user id and the install id header is not needed to replay.
    expect(unscoped.status).toBe(200);
    expect(unscoped.headers.get(IDEMPOTENCY_REPLAYED_HEADER)).toBe('true');
    expect(await unscoped.json<DeviceBody>()).toEqual(firstBody);
  });

  it('moves a push token to the account that signs in on the SAME installation (account switch)', async () => {
    // Sign out, sign in as someone else on the same phone: the token must follow, or the first
    // account's flight alerts keep reaching a phone it signed out of.
    const first = await signInAnonymously();
    const second = await signInAnonymously();
    const installId = uniqueInstallId('switch');
    const token = `apns-${crypto.randomUUID()}`;

    const owned = await registerDevice(first, installId, {
      pushTokenKind: 'apns',
      pushToken: token,
    });
    const { lines, result: moved } = await captureLogs(() =>
      registerDevice(second, installId, { pushTokenKind: 'apns', pushToken: token }),
    );
    const movedBody = await moved.json<DeviceBody & { pushTokenSkipped?: string }>();

    expect(owned.status).toBe(200);
    expect(moved.status).toBe(200);
    expect(movedBody.pushToken).not.toBeNull();
    expect(movedBody.pushTokenSkipped).toBeUndefined();
    expect(logEvents(lines, 'push_token_conflict')).toHaveLength(0);
    const rows = await withDb(testEnv, (db) =>
      db
        .select({ userId: pushTokens.userId, deviceId: pushTokens.deviceId })
        .from(pushTokens)
        .where(eq(pushTokens.token, token)),
    );
    expect(rows).toEqual([{ userId: second.userId, deviceId: movedBody.device?.id }]);
  });

  it('moves a push token after a cross-device magic link whose merge was withheld', async () => {
    // The link is requested on the phone and opened on the iPad: the iPad's anonymous user is
    // signed in as the address owner but nothing of it is merged (requester mismatch). The
    // signed-in user then registers the iPad again, same installation, same token.
    const phone = await signInAnonymously();
    const ipad = await signInAnonymously();
    const email = uniqueEmail('cross-device');
    const ipadInstall = uniqueInstallId('ipad');
    const ipadToken = `apns-${crypto.randomUUID()}`;
    expect(
      (await registerDevice(ipad, ipadInstall, { pushTokenKind: 'apns', pushToken: ipadToken }))
        .status,
    ).toBe(200);
    expect(
      (
        await worker(
          jsonRequest(
            '/api/auth/sign-in/magic-link',
            'POST',
            { email },
            { ip: phone.ip, cookie: phone.cookie },
          ),
        )
      ).status,
    ).toBe(200);
    const { result: verified, lines } = await captureLogs(async () =>
      verifyMagicLink(await magicLinkTokenFor(email), { ip: ipad.ip, cookie: ipad.cookie }),
    );
    expect(verified.status).toBe(200);
    expect(logEvents(lines, 'merge_skipped')).toHaveLength(1);
    const signedIn = { cookie: cookiesFrom(verified) ?? '', ip: ipad.ip };
    const signedInUserId = (await verified.json<{ user: { id: string } }>()).user.id;

    const again = await registerDevice(signedIn, ipadInstall, {
      pushTokenKind: 'apns',
      pushToken: ipadToken,
    });
    const againBody = await again.json<DeviceBody & { pushTokenSkipped?: string }>();

    expect(again.status).toBe(200);
    expect(againBody.pushToken).not.toBeNull();
    expect(againBody.pushTokenSkipped).toBeUndefined();
    const rows = await withDb(testEnv, (db) =>
      db
        .select({ userId: pushTokens.userId, deviceId: pushTokens.deviceId })
        .from(pushTokens)
        .where(eq(pushTokens.token, ipadToken)),
    );
    expect(rows).toEqual([{ userId: signedInUserId, deviceId: againBody.device?.id }]);
  });

  it("does not re-point a push token that belongs to another user's device on a DIFFERENT installation", async () => {
    // No proof of possession in the request, and anonymous principals are free to create: a
    // token learned from someone else must not redirect their alerts. The device row is still
    // written; the token is skipped and the response says so.
    const victim = await signInAnonymously();
    const attacker = await signInAnonymously();
    const token = `apns-${crypto.randomUUID()}`;
    const victimInstall = uniqueInstallId('victim');
    const attackerInstall = uniqueInstallId('attacker');

    const owned = await registerDevice(victim, victimInstall, {
      pushTokenKind: 'apns',
      pushToken: token,
    });
    const { lines, result: stolen } = await captureLogs(() =>
      registerDevice(attacker, attackerInstall, { pushTokenKind: 'apns', pushToken: token }),
    );
    const stolenBody = await stolen.json<DeviceBody & { pushTokenSkipped?: string }>();

    expect(owned.status).toBe(200);
    expect(stolen.status).toBe(200);
    expect(stolenBody.device?.installId).toBe(attackerInstall);
    expect(stolenBody.pushToken).toBeNull();
    expect(stolenBody.pushTokenSkipped).toBe('owned_by_another_user');
    const warnings = logEvents(lines, 'push_token_conflict');
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings)).not.toContain(token);

    const rows = await withDb(testEnv, (db) =>
      db.select({ userId: pushTokens.userId }).from(pushTokens).where(eq(pushTokens.token, token)),
    );
    expect(rows).toEqual([{ userId: victim.userId }]);
  });

  it('answers 400, not 500, to a NUL byte anywhere in the body', async () => {
    const session = await signInAnonymously();
    const installId = uniqueInstallId('nul');

    const inModel = await registerDevice(session, installId, { model: 'iPhone\u0000X' });
    const inToken = await registerDevice(session, installId, {
      pushTokenKind: 'apns',
      pushToken: `apns-\u0000-${crypto.randomUUID()}`,
    });

    expect(inModel.status).toBe(400);
    expect(inToken.status).toBe(400);
    const rows = await withDb(testEnv, (db) =>
      db.select({ id: devices.id }).from(devices).where(eq(devices.installId, installId)),
    );
    expect(rows).toHaveLength(0);
  });

  it('is behind the principal limiter, keyed by user id', async () => {
    // The limiter binding does not enforce in the pool (increment 4 spike); what can be checked
    // here is that the route is reachable behind it for a resolved user and unreachable without
    // one, which the two cases above already do. This case pins that a second user's request is
    // independent: a fresh session on a fresh address still registers.
    const session = await signInAnonymously(uniqueIp());
    const response = await registerDevice(session, uniqueInstallId('limiter'));

    expect(response.status).toBe(200);
  });
});
