/**
 * `POST /v1/devices`: registers (or refreshes) the calling installation and, when the app has
 * one, its push token.
 *
 * `installId` is the per-installation id the app generates once and sends on every request as
 * `X-Install-Id` (the idempotency middleware scopes anonymous keys by it). When both are present
 * they have to agree: a body naming a different install than the header is a client bug worth
 * a 400, not a silent second device row.
 *
 * Upserts: `devices` on `(user_id, install_id)`, `push_tokens` on `(kind, token)`, so a token
 * that moves between users or devices (a reinstall, a merged account) ends up on the row that
 * registered it last, with `invalidated_at` cleared. Live Activity per-activity tokens are NOT
 * device tokens and are not accepted here; Phase 0 stores push-to-start tokens only, and the
 * accepted kinds are the `push_tokens.kind` check constraint's.
 */

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import {
  DEVICE_PLATFORMS,
  PUSH_ENVIRONMENTS,
  PUSH_TOKEN_KINDS,
  devices,
  pushTokens,
} from '@planeahead/db';
import { uuidv7 } from '@planeahead/shared';
import { z } from 'zod';
import { authRuntime } from '../auth/runtime';
import type { AppBindings } from '../env';
import { currentUser, requireScope } from '../middleware/auth';
import { INSTALL_ID_HEADER, isValidInstallId } from '../middleware/idempotency';

const shortText = (max: number) => z.string().trim().min(1).max(max);

export const DeviceRegistrationSchema = z
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
  })
  .strict()
  .refine((body) => (body.pushToken === undefined) === (body.pushTokenKind === undefined), {
    message: 'pushToken and pushTokenKind go together',
  });

export type DeviceRegistration = z.infer<typeof DeviceRegistrationSchema>;

export const devicesRoutes = new Hono<AppBindings>().post(
  '/',
  requireScope('user'),
  zValidator('json', DeviceRegistrationSchema),
  async (c) => {
    const user = currentUser(c.var.user);
    const body = c.req.valid('json');
    const headerInstallId = c.req.header(INSTALL_ID_HEADER);
    if (headerInstallId !== undefined && headerInstallId !== body.installId) {
      return c.json(
        {
          error: 'install_id_mismatch',
          message: `${INSTALL_ID_HEADER} and installId name different installations`,
          requestId: c.var.requestId,
        },
        400,
      );
    }

    const { db } = authRuntime(c);
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
    if (body.pushToken !== undefined && body.pushTokenKind !== undefined) {
      const tokenFields = {
        userId: user.id,
        deviceId: device.id,
        environment: body.pushEnvironment ?? 'production',
        invalidatedAt: null,
        lastUsedAt: now,
      };
      const [row] = await db
        .insert(pushTokens)
        .values({ id: uuidv7(), kind: body.pushTokenKind, token: body.pushToken, ...tokenFields })
        .onConflictDoUpdate({ target: [pushTokens.kind, pushTokens.token], set: tokenFields })
        .returning({ id: pushTokens.id, kind: pushTokens.kind });
      pushToken = row ?? null;
    }

    return c.json({ device, pushToken });
  },
);
