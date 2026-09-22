import { describe, expect, it } from 'vitest';
import {
  DEFAULT_USER_PREFERENCES,
  PREFERENCE_SETTINGS_MAX_KEYS,
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
