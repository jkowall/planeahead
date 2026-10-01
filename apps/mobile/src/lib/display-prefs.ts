/**
 * The account preferences every time and distance on the flight screens follows (increment 10),
 * read from the settings store: the time format, whether airport-local times are shown, and the
 * distance unit.
 */

import { useMemo } from 'react';
import type { DistanceUnit, TimeFormat } from './format';
import { useSettings } from './settings';

export interface DisplayPrefs {
  readonly timeFormat: TimeFormat;
  readonly distanceUnit: DistanceUnit;
  /**
   * The zone a time at an airport is shown in: the airport's own when `showLocalTimes` is on
   * (the default), else undefined, which the formatters read as the device's zone.
   */
  readonly zoneFor: (airportZone: string | null) => string | undefined;
}

export function displayPrefsOf(preferences: {
  readonly timeFormat: TimeFormat;
  readonly distanceUnit: DistanceUnit;
  readonly showLocalTimes: boolean;
}): DisplayPrefs {
  return {
    timeFormat: preferences.timeFormat,
    distanceUnit: preferences.distanceUnit,
    zoneFor: (airportZone) =>
      preferences.showLocalTimes && airportZone !== null ? airportZone : undefined,
  };
}

export function useDisplayPrefs(): DisplayPrefs {
  const preferences = useSettings((state) => state.preferences);
  // One object per change of the preferences, so a memoised board row keeps its props (R13).
  return useMemo(() => displayPrefsOf(preferences), [preferences]);
}
