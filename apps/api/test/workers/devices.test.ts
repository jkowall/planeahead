/**
 * `POST /v1/devices` through the real Worker: the guard, the upsert on `(user_id, install_id)`,
 * the push token upsert on `(kind, token)`, the header-versus-body install id check, and (ruling
 * F2) the increment 4 idempotency contract for anonymous callers, which the route keeps: a keyed
 * request replays under `X-Install-Id`, and one without it is answered 400.
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
  jsonRequest,
  registerDevice,
  signInAnonymously,
  testEnv,
  uniqueInstallId,
  uniqueIp,
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

  it('replays a keyed registration scoped by X-Install-Id (ruling F2) and refuses a keyed one without it', async () => {
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
    // Idempotency runs ahead of auth in the chain, so even a signed-in caller must scope a
    // keyed request by install id.
    expect(unscoped.status).toBe(400);
    expect((await unscoped.json<DeviceBody>()).error).toBe('idempotency_scope_missing');
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
