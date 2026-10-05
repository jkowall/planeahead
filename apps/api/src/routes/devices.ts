/**
 * `POST /v1/devices`: registers (or refreshes) the calling installation and, when the app has
 * one, its push token. `POST /v1/devices/current/invalidate` (increment 14): the sign-out half.
 *
 * `installId` is the per-installation id the app generates once and sends on every request as
 * `X-Install-Id` (the idempotency middleware scopes a caller WITHOUT a session by it; a keyed
 * request from a signed-in caller is scoped by the user id, increment 8 ruling K1). When both are present
 * they have to agree: a body naming a different install than the header is a client bug worth
 * a 400, not a silent second device row.
 *
 * Upserts: `devices` on `(user_id, install_id)`; `push_tokens` on `(kind, token)`. A token that
 * moves between the same user's devices (a reinstall) follows the device that registered it
 * last, with `invalidated_at` cleared. A token registered to ANOTHER user's device moves only
 * when this request comes from the SAME installation the token currently points at (the
 * `install_id` of the token's `devices` row equals the body's `installId`): that is the phone
 * itself, after an account switch (sign out, sign in as someone else) or after a cross-device
 * magic link whose merge was withheld, and a token that stayed on the old owner would keep
 * sending that owner's flight alerts to a phone they signed out of. From a DIFFERENT
 * installation the token is not re-pointed: there is no proof of possession in this request,
 * anonymous principals are free to create, and re-pointing would let anyone who learned a token
 * redirect the owner's alerts to themselves. The device row is still written, the token is
 * skipped, a warning is logged, and the response says so.
 *
 * Live Activity per-activity tokens are NOT device tokens and are not accepted here; Phase 0
 * stores push-to-start tokens only, and the accepted kinds are the `push_tokens.kind` check
 * constraint's. A U+0000 anywhere in the body is a 400 (Postgres would answer 500).
 *
 * Increment 14 (ruling P6). The token carries its routing and its state:
 *
 *   - `appId`, the bundle or package id that registered it (the APNs topic). Optional, so every
 *     client before increment 16 is still accepted: an absent `appId` is the production app's
 *     (`PRODUCTION_APP_ID`). A registration that names one replaces the stored one.
 *   - `pushPermission`, the notification permission the app holds (`granted`, `provisional`,
 *     `denied`, `undetermined`); optional, and when absent the stored state is kept. Ignored, like
 *     `appId`, when the body carries no token.
 *   - `registered_at` is written on every registration that stores the token: the APNs 410 guard
 *     compares Apple's timestamp with it (ruling P5). `last_used_at` is no longer written here:
 *     it is the time of the last send, which the persist consumer records.
 *   - A registration rotates: in the same transaction as the upsert, every OTHER live row of the
 *     same device and kind is invalidated, so one device holds one live token per kind and a
 *     rotated token stops receiving pushes (R2 design item 5; ADR 0008 item 7(b) for the
 *     push-to-start kind). A skipped registration (`owned_by_another_user`) rotates nothing. The
 *     transaction's first statement locks the device row (`select ... for update`, review ruling
 *     R4), so two registrations of the same device serialize and never leave two live rows.
 *
 * `POST /v1/devices/current/invalidate` needs a session and takes the installation's id (body
 * `installId`, which must agree with `X-Install-Id` when both are sent): it invalidates every
 * live token of every kind registered to the CALLER's device row for that installation, and
 * answers how many. In the same transaction it deletes the caller's session row, that session
 * only and never the user's others (increment 16 review, rulings A3 and A4): the sign-out is one
 * atomic server step; a write with that cookie whose session read comes after the commit gets
 * 401, a registration included (one that read its session just before can still land after it,
 * which the app's registrar prevents); and a call the app queued while offline ends, when it is
 * replayed, the session that sign-out left behind. The app's `authClient.signOut()` afterwards
 * only clears the client's half (Better Auth answers 200 for a session already gone). Only this
 * call ends a session here: a session that expires, or that the merge revokes, leaves the tokens
 * alone, since they belong to the device. What the invalidation guarantees (review ruling R1):
 * the push consumer reads every target's token row once per batch,
 * before the batch's first send (first attempts included), so nothing from a batch whose read
 * starts after the invalidation (or an account switch's re-point above) commits reaches the
 * phone; a batch already past its read can still finish its sends, usually within seconds and at
 * most about seven minutes (five jobs of 50 targets, six in flight, a 10-second timeout each).
 * What no server check can take back: a push APNs or FCM
 * accepted before it, which the provider holds until the job's `expiresAt` and delivers to a phone
 * that was offline at sign-out; and a sign-out made offline, until the app's call succeeds
 * (increment 16 builds the call, its retry, and the device-side half). Tokens registered to
 * another user's device row for the same installation are that user's and are not touched; the
 * install id is not a secret. A call for an installation the caller never registered answers 0
 * and still ends the session; a second call with the same cookie answers 401 (the session is
 * gone), no longer 0. A refused call (a 400) ends nothing.
 */

import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import {
  DEVICE_PLATFORMS,
  PUSH_ENVIRONMENTS,
  PUSH_TOKEN_KINDS,
  devices,
  pushTokens,
  sessions,
} from '@planeahead/db';
import {
  AppIdSchema,
  PRODUCTION_APP_ID,
  PushPermissionStateSchema,
  uuidv7,
} from '@planeahead/shared';
import { z } from 'zod';
import { authRuntime } from '../auth/runtime';
import type { AppBindings } from '../env';
import { currentUser, requireScope } from '../middleware/auth';
import { validate } from '../lib/validate';
import { INSTALL_ID_HEADER, idempotencyGate, isValidInstallId } from '../middleware/idempotency';
import { withoutNul } from '../validation/nul';

const shortText = (max: number) => z.string().trim().min(1).max(max);

export const DeviceRegistrationSchema = withoutNul(
  z
    .object({
      installId: z.string().refine(isValidInstallId, {
        message: 'installId must be 8 to 255 characters of [A-Za-z0-9_.:-]',
      }),
      platform: z.enum(DEVICE_PLATFORMS),
      osVersion: shortText(64).optional(),
      appVersion: shortText(64).optional(),
      appBuild: shortText(64).optional(),
      model: shortText(128).optional(),
      locale: shortText(32).optional(),
      timezone: shortText(64).optional(),
      pushTokenKind: z.enum(PUSH_TOKEN_KINDS).optional(),
      pushToken: z.string().trim().min(8).max(4096).optional(),
      pushEnvironment: z.enum(PUSH_ENVIRONMENTS).optional(),
      /** Increment 14: the bundle or package id; absent means the production app. */
      appId: AppIdSchema.optional(),
      /** Increment 14: the notification permission the app holds. */
      pushPermission: PushPermissionStateSchema.optional(),
    })
    .strict()
    .refine((body) => (body.pushToken === undefined) === (body.pushTokenKind === undefined), {
      message: 'pushToken and pushTokenKind go together',
    }),
);

export type DeviceRegistration = z.infer<typeof DeviceRegistrationSchema>;

/** `POST /v1/devices/current/invalidate` (increment 14): the installation signing out. */
export const DeviceInvalidationSchema = withoutNul(
  z
    .object({
      installId: z.string().refine(isValidInstallId, {
        message: 'installId must be 8 to 255 characters of [A-Za-z0-9_.:-]',
      }),
    })
    .strict(),
);

/** Why a supplied push token was not registered. */
export type PushTokenSkipReason = 'owned_by_another_user';

export const devicesRoutes = new Hono<AppBindings>()
  .post(
    '/',
    requireScope('user'),
    validate('json', DeviceRegistrationSchema),
    idempotencyGate({ required: false }),
    async (c) => {
      const user = currentUser(c.var.user);
      const body = c.req.valid('json');
      const headerInstallId = c.req.header(INSTALL_ID_HEADER);
      if (headerInstallId !== undefined && headerInstallId !== body.installId) {
        return installIdMismatch(c);
      }

      const { db, log } = authRuntime(c);
      const now = new Date().toISOString();
      const deviceFields = {
        platform: body.platform,
        osVersion: body.osVersion ?? null,
        appVersion: body.appVersion ?? null,
        appBuild: body.appBuild ?? null,
        model: body.model ?? null,
        locale: body.locale ?? null,
        timezone: body.timezone ?? null,
        lastSeenAt: now,
      };
      const [device] = await db
        .insert(devices)
        .values({ id: uuidv7(), userId: user.id, installId: body.installId, ...deviceFields })
        .onConflictDoUpdate({ target: [devices.userId, devices.installId], set: deviceFields })
        .returning({ id: devices.id, installId: devices.installId, platform: devices.platform });
      if (device === undefined) {
        throw new Error('device upsert returned no row');
      }

      let pushToken: { id: string; kind: string } | null = null;
      let pushTokenSkipped: PushTokenSkipReason | null = null;
      if (body.pushToken !== undefined && body.pushTokenKind !== undefined) {
        const kind = body.pushTokenKind;
        const token = body.pushToken;
        const tokenFields = {
          userId: user.id,
          deviceId: device.id,
          environment: body.pushEnvironment ?? 'production',
          appId: body.appId ?? PRODUCTION_APP_ID,
          registeredAt: now,
          invalidatedAt: null,
          // Absent keeps the stored state (an old client knows nothing of it).
          ...(body.pushPermission === undefined ? {} : { permission: body.pushPermission }),
        };
        const stored = await db.transaction(async (tx) => {
          // Ruling R4: the device row is locked first, so two registrations of one device run one
          // after the other and the second one's rotation sees the first one's committed row.
          // Without it each rotation misses the other's uncommitted insert, and both stay live.
          await tx
            .select({ id: devices.id })
            .from(devices)
            .where(eq(devices.id, device.id))
            .for('update');
          // `setWhere` limits the DO UPDATE to a row this user already owns, or one whose device is
          // this same installation (`push_tokens` here is the EXISTING row, as Postgres names it in
          // an ON CONFLICT DO UPDATE ... WHERE); any other row is left untouched and the statement
          // returns nothing.
          const [row] = await tx
            .insert(pushTokens)
            .values({ id: uuidv7(), kind, token, ...tokenFields })
            .onConflictDoUpdate({
              target: [pushTokens.kind, pushTokens.token],
              set: tokenFields,
              setWhere: sql`${pushTokens.userId} = ${user.id} or exists (
              select 1 from ${devices}
              where ${devices.id} = ${pushTokens.deviceId} and ${devices.installId} = ${body.installId}
            )`,
            })
            .returning({ id: pushTokens.id, kind: pushTokens.kind });
          if (row === undefined) {
            return null;
          }
          // Rotation (ruling P6): the device's other live rows of this kind stop receiving pushes.
          const rotated = await tx
            .update(pushTokens)
            .set({ invalidatedAt: now })
            .where(
              and(
                eq(pushTokens.deviceId, device.id),
                eq(pushTokens.kind, kind),
                ne(pushTokens.id, row.id),
                isNull(pushTokens.invalidatedAt),
              ),
            )
            .returning({ id: pushTokens.id });
          return { row, rotated: rotated.length };
        });
        if (stored === null) {
          pushTokenSkipped = 'owned_by_another_user';
          log.warn('push_token_conflict', { kind, device_id: device.id });
        } else {
          pushToken = stored.row;
          if (stored.rotated > 0) {
            log.info('push_token_rotated', {
              kind,
              device_id: device.id,
              invalidated: stored.rotated,
            });
          }
        }
      }

      return c.json(
        {
          device,
          pushToken,
          ...(pushTokenSkipped === null ? {} : { pushTokenSkipped }),
        },
        200,
      );
    },
  )
  .post(
    '/current/invalidate',
    requireScope('user'),
    validate('json', DeviceInvalidationSchema),
    idempotencyGate({ required: false }),
    async (c) => {
      const user = currentUser(c.var.user);
      const body = c.req.valid('json');
      const headerInstallId = c.req.header(INSTALL_ID_HEADER);
      if (headerInstallId !== undefined && headerInstallId !== body.installId) {
        return installIdMismatch(c);
      }
      const { db, log } = authRuntime(c);
      const ownDevices = db
        .select({ id: devices.id })
        .from(devices)
        .where(and(eq(devices.userId, user.id), eq(devices.installId, body.installId)));
      const { invalidated, sessionEnded } = await db.transaction(async (tx) => {
        const rows = await tx
          .update(pushTokens)
          .set({ invalidatedAt: new Date().toISOString() })
          .where(
            and(
              eq(pushTokens.userId, user.id),
              inArray(pushTokens.deviceId, ownDevices),
              isNull(pushTokens.invalidatedAt),
            ),
          )
          .returning({ id: pushTokens.id, kind: pushTokens.kind });
        // Review rulings A3 and A4: the sign-out's server half ends the caller's session too, and
        // only that one. Tokens first, then the session, the merge's order (src/auth/merge.ts),
        // so the two transactions never wait on each other in a cycle.
        const ended =
          user.kind === 'session'
            ? await tx
                .delete(sessions)
                .where(eq(sessions.id, user.sessionId))
                .returning({ id: sessions.id })
            : [];
        return { invalidated: rows, sessionEnded: ended.length > 0 };
      });
      log.info('push_tokens_invalidated', {
        reason: 'sign_out',
        count: invalidated.length,
        session_ended: sessionEnded,
      });
      return c.json({ invalidated: invalidated.length }, 200);
    },
  );

/** The 400 for a body whose `installId` disagrees with `X-Install-Id`. */
function installIdMismatch(c: Context<AppBindings>) {
  return c.json(
    {
      error: 'install_id_mismatch' as const,
      message: `${INSTALL_ID_HEADER} and installId name different installations`,
      requestId: c.var.requestId,
    },
    400,
  );
}
