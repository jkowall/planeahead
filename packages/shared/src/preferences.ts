import { z } from 'zod';

/**
 * User preferences as the API presents them (`GET /v1/me`) and accepts them
 * (`PATCH /v1/me/preferences`). The enumerations are mirrored by the `user_preferences` check
 * constraints in @planeahead/db; a test there asserts the two lists agree, so a value added
 * here without a migration fails the db suite rather than a request.
 *
 * `settings` is the open extension bag the mobile app owns (feature toggles it does not need
 * the server to understand). It is bounded so a client cannot turn a preferences row into a
 * blob store: at most 64 keys, primitive values only.
 */

export const DISTANCE_UNITS = ['km', 'mi'] as const;
export const TEMPERATURE_UNITS = ['c', 'f'] as const;
export const TIME_FORMATS = ['12h', '24h'] as const;

export const DistanceUnitSchema = z.enum(DISTANCE_UNITS);
export const TemperatureUnitSchema = z.enum(TEMPERATURE_UNITS);
export const TimeFormatSchema = z.enum(TIME_FORMATS);

export const PREFERENCE_SETTINGS_MAX_KEYS = 64;
export const PREFERENCE_SETTINGS_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;

export const PreferenceSettingsSchema = z
  .record(
    z.string().regex(PREFERENCE_SETTINGS_KEY_RE),
    z.union([z.string().max(256), z.number().finite(), z.boolean(), z.null()]),
  )
  .refine((value) => Object.keys(value).length <= PREFERENCE_SETTINGS_MAX_KEYS, {
    message: `settings may hold at most ${PREFERENCE_SETTINGS_MAX_KEYS} keys`,
  });
export type PreferenceSettings = z.infer<typeof PreferenceSettingsSchema>;

/** The full preferences object a client reads back. */
export const UserPreferencesSchema = z.object({
  distanceUnit: DistanceUnitSchema,
  temperatureUnit: TemperatureUnitSchema,
  timeFormat: TimeFormatSchema,
  showLocalTimes: z.boolean(),
  settings: PreferenceSettingsSchema,
});
export type UserPreferences = z.infer<typeof UserPreferencesSchema>;

/** What a client may send: any subset of the fields, nothing unknown, nothing empty. */
export const UserPreferencesPatchSchema = UserPreferencesSchema.partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'a preferences patch must change at least one field',
  });
export type UserPreferencesPatch = z.infer<typeof UserPreferencesPatchSchema>;

export const DEFAULT_USER_PREFERENCES: UserPreferences = Object.freeze({
  distanceUnit: 'mi',
  temperatureUnit: 'f',
  timeFormat: '12h',
  showLocalTimes: true,
  settings: {},
});
