/**
 * Development only: whether this launch asked for the seeded home screen (src/app/dev/
 * seeded-home.tsx) through a launch argument, so the simulator check needs no deep link. A
 * `planeahead://` link opened with `xcrun simctl openurl` stops at iOS's "Open in ...?" prompt,
 * which nothing on the command line can answer; a launch argument lands in NSUserDefaults'
 * argument domain, which React Native's `Settings` reads:
 *
 *   xcrun simctl launch "iPhone 17 Pro" app.planeahead.mobile.dev \
 *     --initialUrl http://127.0.0.1:8081 -planeaheadSeededHome YES
 *
 * Always false outside a development build of the development variant on iOS.
 */

import { Platform, Settings } from 'react-native';
import { runtimeConfig } from '../lib/config';

export const SEEDED_HOME_ARGUMENT = 'planeaheadSeededHome';

export function seededHomeRequested(): boolean {
  if (!__DEV__ || Platform.OS !== 'ios' || runtimeConfig().variant !== 'development') {
    return false;
  }
  const value: unknown = Settings.get(SEEDED_HOME_ARGUMENT);
  return value === true || value === 1 || value === 'YES' || value === '1' || value === 'true';
}
