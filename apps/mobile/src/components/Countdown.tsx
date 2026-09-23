/**
 * "Departs in 3 h 5 min". The component owns its clock: one interval, once a minute, cleared on
 * unmount (ruling T5), so a screen re-renders only the countdown's text, and a list that is not
 * mounted runs no timer at all. The text rounds down to whole minutes (src/lib/format.ts).
 */

import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { formatCountdown } from '../lib/format';
import { useTheme } from '../theme/useTheme';

export const COUNTDOWN_TICK_MS = 60_000;

const TEXT = {
  departs: { running: 'Departs in', due: 'Departing now' },
  arrives: { running: 'Arrives in', due: 'Arriving now' },
} as const;

export function Countdown({
  at,
  kind,
  testID,
}: {
  /** The instant counted down to (ISO-8601). */
  at: string;
  kind: keyof typeof TEXT;
  testID?: string;
}) {
  const theme = useTheme();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
    }, COUNTDOWN_TICK_MS);
    return () => {
      clearInterval(id);
    };
  }, []);
  const remaining = Date.parse(at) - now;
  const text =
    remaining <= 0 ? TEXT[kind].due : `${TEXT[kind].running} ${formatCountdown(remaining)}`;
  return (
    <Text
      testID={testID}
      accessibilityLiveRegion="polite"
      style={{ color: theme.color.accent, fontSize: theme.font.body, fontWeight: '600' }}
    >
      {text}
    </Text>
  );
}
