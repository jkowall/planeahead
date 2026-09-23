/**
 * "Departs in 3 h 5 min". The component that shows it owns its clock: one interval, once a
 * minute, cleared on unmount (ruling T5), so a screen re-renders only what shows the countdown,
 * and a list that is not mounted runs no timer at all. The text rounds down to whole minutes
 * (src/lib/format.ts).
 *
 * `useCountdownText` is that clock as a hook, for the next-flight card, which needs the same text
 * in its accessibility label as on screen (a label computed from the home's render time would go
 * stale while the text ticks on). `Countdown` is the hook plus its text.
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

export type CountdownKind = keyof typeof TEXT;

export interface CountdownTarget {
  /** The instant counted down to (ISO-8601). */
  readonly at: string;
  readonly kind: CountdownKind;
}

/** The countdown's text at `nowMs`, or null for an instant that does not parse. */
export function countdownText(target: CountdownTarget, nowMs: number): string | null {
  const remaining = Date.parse(target.at) - nowMs;
  if (!Number.isFinite(remaining)) {
    return null;
  }
  return remaining <= 0
    ? TEXT[target.kind].due
    : `${TEXT[target.kind].running} ${formatCountdown(remaining)}`;
}

/** The countdown's text, re-read once a minute by an interval the caller owns; null for none. */
export function useCountdownText(target: CountdownTarget | null): string | null {
  const [now, setNow] = useState(() => Date.now());
  const active = target !== null;
  useEffect(() => {
    if (!active) {
      return;
    }
    // A card that had nothing to count (an add being looked up) starts from now, not its mount.
    setNow(Date.now());
    const id = setInterval(() => {
      setNow(Date.now());
    }, COUNTDOWN_TICK_MS);
    return () => {
      clearInterval(id);
    };
  }, [active]);
  return target === null ? null : countdownText(target, now);
}

/** The countdown's text in the accent style; `text` null renders nothing. */
export function CountdownText({ text, testID }: { text: string | null; testID?: string }) {
  const theme = useTheme();
  if (text === null) {
    return null;
  }
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

export function Countdown({ at, kind, testID }: CountdownTarget & { testID?: string }) {
  const text = useCountdownText({ at, kind });
  return <CountdownText text={text} {...(testID === undefined ? {} : { testID })} />;
}
