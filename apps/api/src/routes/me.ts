/**
 * `GET /v1/me`, `GET` and `PATCH /v1/me/preferences`, and `POST /v1/me/delete`.
 *
 * `me` returns the user and their preferences (the defaults when no row exists yet; a row is
 * only written by a PATCH, so a user who never changed anything has no row to sync). An
 * anonymous user's email is a Better Auth placeholder and is reported as null.
 *
 * The PATCH body is validated with the shared `PreferencesPatchSchema` so the mobile client
 * and the API agree on one contract; `settings` is replaced as a whole when present. The row and
 * its `user_sync_changes` row are written in one transaction (increment 8, ruling K4), so the
 * sync feed carries every preference change.
 *
 * Increment 15 (ruling N10): the body may also carry `notifications`, the shared
 * `NotificationPreferencesPatchSchema` (`pushEnabled` and the per-kind toggles), merged into the
 * user's `notification_preferences` row in the same transaction
 * (src/lib/notification-preferences.ts). Both the PATCH and `GET /v1/me/preferences` answer the
 * effective display and notification preferences, defaults filled in; a part a patch leaves out
 * is read, not written.
 *
 * `POST /v1/me/delete` (increment 8, ruling K8) deletes the account synchronously and accepts an
 * anonymous session (Apple requires guest accounts to be deletable); src/lib/account-deletion.ts
 * holds the order. The answer tells the client to wipe its local store; any other device of the
 * user gets 401 `account_deleted` on its next call.
 */

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { userPreferences, users } from '@planeahead/db';
import {
  DEFAULT_USER_PREFERENCES,
  DO_CALL_DEADLINE_MS,
  PreferencesPatchSchema,
  type UserPreferences,
  UserPreferencesSchema,
  uuidv7,
} from '@planeahead/shared';
import { authRuntime } from '../auth/runtime';
import type { AppBindings } from '../env';
import { deleteAccount } from '../lib/account-deletion';
import type { DbOrTx } from '../lib/flight-registry';
import {
  patchNotificationPreferences,
  readNotificationPreferences,
} from '../lib/notification-preferences';
import { appendUserChange, preferencesSyncRow } from '../lib/sync-rows';
import { defaultTrackerFor } from '../lib/trackers';
import { validate } from '../lib/validate';
import { currentUser, requireScope } from '../middleware/auth';
import { idempotencyGate } from '../middleware/idempotency';
import { withoutNul } from '../validation/nul';

/** The shared contract plus the NUL refinement (`settings` is a jsonb bag Postgres would 500 on). */
const PreferencesPatchBody = withoutNul(PreferencesPatchSchema);

function toPreferences(row: {
  distanceUnit: string;
  temperatureUnit: string;
  timeFormat: string;
  showLocalTimes: boolean;
  settings: unknown;
}): UserPreferences {
  const parsed = UserPreferencesSchema.safeParse(row);
  // A row that fails the shared schema (a value added by migration but not yet to the
  // contract) degrades to the defaults for that field rather than failing the read.
  return parsed.success ? parsed.data : { ...DEFAULT_USER_PREFERENCES };
}

/** The user's display preferences as `GET /v1/me` reports them (the defaults without a row). */
async function readUserPreferences(db: DbOrTx, userId: string): Promise<UserPreferences> {
  const [row] = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  return row === undefined ? { ...DEFAULT_USER_PREFERENCES } : toPreferences(row);
}

export const meRoutes = new Hono<AppBindings>()
  .get('/', requireScope('user'), async (c) => {
    const principal = currentUser(c.var.user);
    const { db } = authRuntime(c);
    const [row] = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        emailVerified: users.emailVerified,
        isAnonymous: users.isAnonymous,
        status: users.status,
        plan: users.plan,
        locale: users.locale,
        homeAirportId: users.homeAirportId,
        createdAt: users.createdAt,
        distanceUnit: userPreferences.distanceUnit,
        temperatureUnit: userPreferences.temperatureUnit,
        timeFormat: userPreferences.timeFormat,
        showLocalTimes: userPreferences.showLocalTimes,
        settings: userPreferences.settings,
      })
      .from(users)
      .leftJoin(userPreferences, eq(userPreferences.userId, users.id))
      .where(eq(users.id, principal.id))
      .limit(1);
    if (row === undefined) {
      // The session outlived the row (a cached session after a deletion). Not a 500: the caller
      // is simply not a user any more.
      return c.json(
        {
          error: 'account_deleted' as const,
          message: 'this account was deleted; clear the data stored on this device',
          requestId: c.var.requestId,
        },
        401,
      );
    }
    const isAnonymous = row.isAnonymous === true;
    return c.json(
      {
        user: {
          id: row.id,
          email: isAnonymous ? null : row.email,
          name: row.name,
          emailVerified: row.emailVerified,
          isAnonymous,
          status: row.status,
          plan: row.plan,
          locale: row.locale,
          homeAirportId: row.homeAirportId,
          createdAt: row.createdAt.toISOString(),
        },
        preferences:
          row.distanceUnit === null
            ? { ...DEFAULT_USER_PREFERENCES }
            : toPreferences({
                distanceUnit: row.distanceUnit,
                temperatureUnit: row.temperatureUnit ?? '',
                timeFormat: row.timeFormat ?? '',
                showLocalTimes: row.showLocalTimes ?? true,
                settings: row.settings,
              }),
      },
      200,
    );
  })
  .get('/preferences', requireScope('user'), async (c) => {
    const principal = currentUser(c.var.user);
    const { db } = authRuntime(c);
    return c.json(
      {
        preferences: await readUserPreferences(db, principal.id),
        notifications: await readNotificationPreferences(db, principal.id),
      },
      200,
    );
  })
  .patch(
    '/preferences',
    requireScope('user'),
    validate('json', PreferencesPatchBody),
    idempotencyGate({ required: false }),
    async (c) => {
      const principal = currentUser(c.var.user);
      const { notifications: notificationsPatch, ...patch } = c.req.valid('json');
      const { db } = authRuntime(c);

      const display = {
        ...(patch.distanceUnit === undefined ? {} : { distanceUnit: patch.distanceUnit }),
        ...(patch.temperatureUnit === undefined ? {} : { temperatureUnit: patch.temperatureUnit }),
        ...(patch.timeFormat === undefined ? {} : { timeFormat: patch.timeFormat }),
        ...(patch.showLocalTimes === undefined ? {} : { showLocalTimes: patch.showLocalTimes }),
        ...(patch.settings === undefined ? {} : { settings: patch.settings }),
      };
      const changes = { ...display, deletedAt: null };
      const writeDisplay = async (tx: DbOrTx): Promise<UserPreferences> => {
        const [written] = await tx
          .insert(userPreferences)
          .values({ id: uuidv7(), userId: principal.id, ...changes })
          .onConflictDoUpdate({ target: userPreferences.userId, set: changes })
          .returning();
        if (written === undefined) {
          throw new Error('preferences upsert returned no row');
        }
        await appendUserChange(tx, {
          userId: principal.id,
          entity: 'user_preferences',
          entityId: written.id,
          op: 'upsert',
          row: preferencesSyncRow(written),
        });
        return toPreferences(written);
      };
      // One transaction for both rows and their sync changes; a part the patch leaves out is read.
      const body = await db.transaction(async (tx) => ({
        preferences:
          Object.keys(display).length === 0
            ? await readUserPreferences(tx, principal.id)
            : await writeDisplay(tx),
        notifications:
          notificationsPatch === undefined
            ? await readNotificationPreferences(tx, principal.id)
            : await patchNotificationPreferences(tx, principal.id, notificationsPatch),
      }));
      return c.json(body, 200);
    },
  )
  .post('/delete', requireScope('user'), async (c) => {
    const principal = currentUser(c.var.user);
    const { db, envelope, log } = authRuntime(c);
    const report = await deleteAccount(
      {
        env: c.env,
        db,
        envelope,
        log,
        trackerFor: defaultTrackerFor(c.env),
        deadlineMs: DO_CALL_DEADLINE_MS,
        waitUntil: (promise) => {
          c.executionCtx.waitUntil(promise);
        },
        requestId: c.var.requestId,
      },
      principal.id,
    );
    if (report === null) {
      return c.json(
        {
          error: 'account_deleted' as const,
          message: 'this account was deleted; clear the data stored on this device',
          requestId: c.var.requestId,
        },
        401,
      );
    }
    log.info('account_deleted', {
      subscriptions: report.subscriptions,
      trackers_failed: report.trackersFailed,
      transaction_retries: report.transactionRetries,
      apple_revoke: report.apple.outcome,
    });
    return c.json({ deleted: true as const, wipeLocalStore: true as const }, 200);
  });
