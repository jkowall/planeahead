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

/**
 * Notification preferences (increment 15, ruling N10): `notification_preferences.push_enabled`
 * and the per-kind toggles in its `events` jsonb, keyed by these names. Every toggle defaults on
 * except `first_gate_assignment`; a missing row, a missing key or a non-boolean value is the
 * default. Per-flight mute is the subscription's own flag, not a preference.
 */
export const NOTIFICATION_EVENT_PREFERENCES = [
  'delay',
  'gate_change',
  'first_gate_assignment',
  'cancellation',
  'diversion',
] as const;
export type NotificationEventPreference = (typeof NOTIFICATION_EVENT_PREFERENCES)[number];

export const DEFAULT_NOTIFICATION_EVENTS: Readonly<Record<NotificationEventPreference, boolean>> =
  Object.freeze({
    delay: true,
    gate_change: true,
    first_gate_assignment: false,
    cancellation: true,
    diversion: true,
  });

export const NotificationEventsSchema = z.object({
  delay: z.boolean(),
  gate_change: z.boolean(),
  first_gate_assignment: z.boolean(),
  cancellation: z.boolean(),
  diversion: z.boolean(),
});
export type NotificationEvents = z.infer<typeof NotificationEventsSchema>;

/** The effective notification preferences a client reads back. */
export const NotificationPreferencesSchema = z.object({
  pushEnabled: z.boolean(),
  events: NotificationEventsSchema,
});
export type NotificationPreferences = z.infer<typeof NotificationPreferencesSchema>;

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = Object.freeze({
  pushEnabled: true,
  events: { ...DEFAULT_NOTIFICATION_EVENTS },
});

const nonEmpty = (value: object): boolean => Object.keys(value).length > 0;

/** What a client may send: any subset, merged into the stored toggles; nothing unknown or empty. */
export const NotificationPreferencesPatchSchema = z
  .object({
    pushEnabled: z.boolean().optional(),
    events: NotificationEventsSchema.partial()
      .strict()
      .refine(nonEmpty, { message: 'events must change at least one toggle' })
      .optional(),
  })
  .strict()
  .refine(nonEmpty, { message: 'a notifications patch must change at least one field' });
export type NotificationPreferencesPatch = z.infer<typeof NotificationPreferencesPatchSchema>;

/**
 * The body of `PATCH /v1/me/preferences` from increment 15: the display fields of
 * `UserPreferencesPatchSchema` and, under `notifications`, a notification preferences patch. A
 * body of display fields alone is exactly what `UserPreferencesPatchSchema` accepts.
 */
export const PreferencesPatchSchema = UserPreferencesSchema.partial()
  .extend({ notifications: NotificationPreferencesPatchSchema.optional() })
  .strict()
  .refine(nonEmpty, { message: 'a preferences patch must change at least one field' });
export type PreferencesPatch = z.infer<typeof PreferencesPatchSchema>;

/** The stored toggles with the defaults filled in; unknown keys and non-booleans are ignored. */
export function effectiveNotificationEvents(stored: unknown): NotificationEvents {
  const bag =
    typeof stored === 'object' && stored !== null && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  const events = { ...DEFAULT_NOTIFICATION_EVENTS };
  for (const name of NOTIFICATION_EVENT_PREFERENCES) {
    const value = bag[name];
    if (typeof value === 'boolean') {
      events[name] = value;
    }
  }
  return events;
}

/** A user's effective notification preferences; no row (or a tombstoned one) is the defaults. */
export function effectiveNotificationPreferences(
  row: { readonly pushEnabled: boolean; readonly events: unknown } | null,
): NotificationPreferences {
  return row === null
    ? { pushEnabled: true, events: { ...DEFAULT_NOTIFICATION_EVENTS } }
    : { pushEnabled: row.pushEnabled, events: effectiveNotificationEvents(row.events) };
}

/**
 * The toggle that decides whether an intent reaches a user: `first_gate_assignment` for a first
 * gate assignment, otherwise its kind's own; null for a kind no toggle covers (always sent).
 */
export function notificationEventPreferenceFor(intent: {
  readonly kind: string;
  readonly firstAssignment: boolean;
}): NotificationEventPreference | null {
  if (intent.kind === 'gate_change' && intent.firstAssignment) {
    return 'first_gate_assignment';
  }
  return (NOTIFICATION_EVENT_PREFERENCES as readonly string[]).includes(intent.kind)
    ? (intent.kind as NotificationEventPreference)
    : null;
}
