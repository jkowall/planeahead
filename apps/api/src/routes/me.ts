/**
 * `GET /v1/me` and `PATCH /v1/me/preferences`.
 *
 * `me` returns the user and their preferences (the defaults when no row exists yet; a row is
 * only written by a PATCH, so a user who never changed anything has no row to sync). An
 * anonymous user's email is a Better Auth placeholder and is reported as null.
 *
 * The PATCH body is validated with the shared `UserPreferencesPatchSchema` so the mobile client
 * and the API agree on one contract; `settings` is replaced as a whole when present.
 */

import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { userPreferences, users } from '@planeahead/db';
import {
  DEFAULT_USER_PREFERENCES,
  type UserPreferences,
  UserPreferencesPatchSchema,
  UserPreferencesSchema,
  uuidv7,
} from '@planeahead/shared';
import { authRuntime } from '../auth/runtime';
import type { AppBindings } from '../env';
import { currentUser, requireScope } from '../middleware/auth';
import { withoutNul } from '../validation/nul';

/** The shared contract plus the NUL refinement (`settings` is a jsonb bag Postgres would 500 on). */
const PreferencesPatchBody = withoutNul(UserPreferencesPatchSchema);

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
      // The session outlived the row (deletion in flight). Not a 500: the caller is simply not
      // a user any more.
      return c.json(
        { error: 'unauthenticated', message: 'user no longer exists', requestId: c.var.requestId },
        401,
      );
    }
    const isAnonymous = row.isAnonymous === true;
    return c.json({
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
    });
  })
  .patch(
    '/preferences',
    requireScope('user'),
    zValidator('json', PreferencesPatchBody),
    async (c) => {
      const principal = currentUser(c.var.user);
      const patch = c.req.valid('json');
      const { db } = authRuntime(c);

      const changes = {
        ...(patch.distanceUnit === undefined ? {} : { distanceUnit: patch.distanceUnit }),
        ...(patch.temperatureUnit === undefined ? {} : { temperatureUnit: patch.temperatureUnit }),
        ...(patch.timeFormat === undefined ? {} : { timeFormat: patch.timeFormat }),
        ...(patch.showLocalTimes === undefined ? {} : { showLocalTimes: patch.showLocalTimes }),
        ...(patch.settings === undefined ? {} : { settings: patch.settings }),
        deletedAt: null,
      };
      const [row] = await db
        .insert(userPreferences)
        .values({ id: uuidv7(), userId: principal.id, ...changes })
        .onConflictDoUpdate({ target: userPreferences.userId, set: changes })
        .returning({
          distanceUnit: userPreferences.distanceUnit,
          temperatureUnit: userPreferences.temperatureUnit,
          timeFormat: userPreferences.timeFormat,
          showLocalTimes: userPreferences.showLocalTimes,
          settings: userPreferences.settings,
        });
      if (row === undefined) {
        throw new Error('preferences upsert returned no row');
      }
      return c.json({ preferences: toPreferences(row) });
    },
  );
