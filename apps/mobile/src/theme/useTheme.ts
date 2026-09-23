/**
 * The theme a screen renders with: the settings store's appearance override (increment 9), and
 * the system scheme when the override is `system`.
 *
 * The root layout also hands the override to `Appearance.setColorScheme`, so on a device
 * `useColorScheme()` already follows it. Reading the store here as well makes the choice take
 * effect in the same render that changed it, and keeps the screens correct wherever
 * `Appearance` is not driven (Jest, a screen rendered outside the root layout).
 */

import { useColorScheme } from 'react-native';
import { useSettings, type Appearance } from '../lib/settings';
import { tokensFor, type ColorScheme, type ThemeTokens } from './tokens';

export function resolveScheme(
  appearance: Appearance,
  system: string | null | undefined,
): ColorScheme {
  if (appearance !== 'system') {
    return appearance;
  }
  return system === 'dark' ? 'dark' : 'light';
}

export function useTheme(): ThemeTokens {
  const appearance = useSettings((state) => state.appearance);
  const system = useColorScheme();
  return tokensFor(resolveScheme(appearance, system));
}
