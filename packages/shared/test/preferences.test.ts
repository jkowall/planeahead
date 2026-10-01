import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NOTIFICATION_EVENTS,
  DEFAULT_NOTIFICATION_PREFERENCES,
  DEFAULT_USER_PREFERENCES,
  NOTIFICATION_EVENT_PREFERENCES,
  NotificationPreferencesPatchSchema,
  NotificationPreferencesSchema,
  PREFERENCE_SETTINGS_MAX_KEYS,
  PreferencesPatchSchema,
  effectiveNotificationEvents,
  effectiveNotificationPreferences,
  notificationEventPreferenceFor,
  UserPreferencesPatchSchema,
  UserPreferencesSchema,
} from '../src/preferences';

describe('UserPreferencesSchema', () => {
  it('accepts the defaults', () => {
    expect(UserPreferencesSchema.parse(DEFAULT_USER_PREFERENCES)).toEqual(DEFAULT_USER_PREFERENCES);
  });

  it('rejects a unit outside the enumeration', () => {
    expect(
      UserPreferencesSchema.safeParse({ ...DEFAULT_USER_PREFERENCES, distanceUnit: 'furlong' })
        .success,
    ).toBe(false);
  });
});

describe('UserPreferencesPatchSchema', () => {
  it('accepts a subset', () => {
    expect(UserPreferencesPatchSchema.parse({ timeFormat: '24h' })).toEqual({ timeFormat: '24h' });
  });

  it('rejects an empty patch, an unknown key and a non-primitive setting', () => {
    expect(UserPreferencesPatchSchema.safeParse({}).success).toBe(false);
    expect(UserPreferencesPatchSchema.safeParse({ colour: 'blue' }).success).toBe(false);
    expect(
      UserPreferencesPatchSchema.safeParse({ settings: { nested: { deep: true } } }).success,
    ).toBe(false);
    expect(UserPreferencesPatchSchema.safeParse({ settings: { 'Bad-Key': 1 } }).success).toBe(
      false,
    );
  });

  it('bounds the settings bag', () => {
    const settings: Record<string, number> = {};
    for (let index = 0; index <= PREFERENCE_SETTINGS_MAX_KEYS; index += 1) {
      settings[`key_${index}`] = index;
    }
    expect(UserPreferencesPatchSchema.safeParse({ settings }).success).toBe(false);
  });
});

describe('notification preferences (increment 15, N10)', () => {
  it('defaults every toggle on except the first gate assignment', () => {
    expect(DEFAULT_NOTIFICATION_PREFERENCES).toEqual({
      pushEnabled: true,
      events: {
        delay: true,
        gate_change: true,
        first_gate_assignment: false,
        cancellation: true,
        diversion: true,
      },
    });
    expect(Object.keys(DEFAULT_NOTIFICATION_EVENTS)).toEqual([...NOTIFICATION_EVENT_PREFERENCES]);
    expect(NotificationPreferencesSchema.parse(DEFAULT_NOTIFICATION_PREFERENCES)).toEqual(
      DEFAULT_NOTIFICATION_PREFERENCES,
    );
  });

  it('fills a stored row in from the defaults, ignoring unknown keys and non-booleans', () => {
    expect(effectiveNotificationPreferences(null)).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
    expect(
      effectiveNotificationPreferences({
        pushEnabled: false,
        events: { delay: false, first_gate_assignment: true, boarding: false, diversion: 'no' },
      }),
    ).toEqual({
      pushEnabled: false,
      events: { ...DEFAULT_NOTIFICATION_EVENTS, delay: false, first_gate_assignment: true },
    });
    expect(effectiveNotificationEvents(['delay'])).toEqual(DEFAULT_NOTIFICATION_EVENTS);
  });

  it('names the toggle an intent needs: a first assignment its own, a kind its own, others none', () => {
    const of = (kind: string, firstAssignment = false) =>
      notificationEventPreferenceFor({ kind, firstAssignment });
    expect(of('gate_change', true)).toBe('first_gate_assignment');
    expect(of('gate_change')).toBe('gate_change');
    expect(of('delay')).toBe('delay');
    expect(of('cancellation')).toBe('cancellation');
    expect(of('diversion')).toBe('diversion');
    expect(of('system')).toBeNull();
  });

  it('accepts a partial patch and refuses empty, unknown or mistyped ones', () => {
    expect(NotificationPreferencesPatchSchema.parse({ events: { delay: false } })).toEqual({
      events: { delay: false },
    });
    for (const bad of [{}, { events: {} }, { events: { boarding: true } }, { pushEnabled: 1 }]) {
      expect(NotificationPreferencesPatchSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('extends the preferences patch with notifications, keeping every display-only body valid', () => {
    expect(PreferencesPatchSchema.parse({ notifications: { pushEnabled: false } })).toEqual({
      notifications: { pushEnabled: false },
    });
    const display = { distanceUnit: 'km', settings: { dark_mode: true } };
    expect(PreferencesPatchSchema.parse(display)).toEqual(
      UserPreferencesPatchSchema.parse(display),
    );
    expect(PreferencesPatchSchema.safeParse({}).success).toBe(false);
    expect(PreferencesPatchSchema.safeParse({ pushEnabled: false }).success).toBe(false);
  });
});
