/**
 * One flight on the home screen: the `hero` card for the top slot (the next flight: departure
 * time large, gate and terminal, the countdown, the delay; or, when nothing live is ahead, the
 * oldest add still being looked up, as "Adding") and the `row` for the rest of the list.
 * Everything it shows comes from the `FlightItem` (the subscription row and its denormalised
 * snapshot) and the account's display preferences; it reads nothing itself.
 *
 * Accessibility (increment 10 review): each card is one button whose label says what the card
 * shows, status, departure time, gate and terminal and (on the hero) the countdown included, in
 * the same words: an explicit label replaces the children's text for VoiceOver and TalkBack, so
 * it has to carry all of it. The hero owns the countdown's minute clock (`useCountdownText`), so
 * the label and the text on screen tick together.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { DisplayPrefs } from '../lib/display-prefs';
import {
  countdownFor,
  departureTime,
  hasDeparted,
  operatedAs,
  type FlightItem,
} from '../lib/flight-model';
import {
  dayShift,
  dayShiftWords,
  formatClock,
  formatDay,
  formatDelay,
  formatIsoDate,
} from '../lib/format';
import { terminalAndGate } from '../lib/timeline';
import { useTheme } from '../theme/useTheme';
import { CountdownText, useCountdownText } from './Countdown';
import { pillLabel, StatusPill } from './StatusPill';

function route(item: FlightItem): string | null {
  if (item.origin.code === null || item.destination.code === null) {
    return null;
  }
  return `${item.origin.code} → ${item.destination.code}`;
}

function dateText(item: FlightItem, prefs: DisplayPrefs): string {
  const out = item.scheduledOut;
  if (out !== null) {
    return formatDay(out, prefs.zoneFor(item.origin.tz));
  }
  return item.dateLocal === null ? '' : formatIsoDate(item.dateLocal);
}

function departureClockOf(item: FlightItem, prefs: DisplayPrefs): string | null {
  const departure = departureTime(item);
  return departure === null
    ? null
    : formatClock(departure, {
        timeFormat: prefs.timeFormat,
        timeZone: prefs.zoneFor(item.origin.tz),
      });
}

interface Arrival {
  /** `7:10 AM +1`. */
  readonly text: string;
  /** `7:10 AM the next day`. */
  readonly spoken: string;
}

function arrivalOf(item: FlightItem, prefs: DisplayPrefs): Arrival | null {
  const arrival = item.actualIn ?? item.estimatedIn ?? item.scheduledIn;
  if (arrival === null) {
    return null;
  }
  const clock = formatClock(arrival, {
    timeFormat: prefs.timeFormat,
    timeZone: prefs.zoneFor(item.destination.tz),
  });
  const shift = dayShift(
    departureTime(item),
    prefs.zoneFor(item.origin.tz),
    arrival,
    prefs.zoneFor(item.destination.tz),
  );
  const words = dayShiftWords(shift);
  return {
    text: shift > 0 ? `${clock} +${String(shift)}` : clock,
    spoken: words === null ? clock : `${clock} ${words}`,
  };
}

function join(parts: readonly (string | null)[]): string {
  return parts.filter((part): part is string => part !== null && part !== '').join(', ');
}

interface CardProps {
  readonly item: FlightItem;
  readonly prefs: DisplayPrefs;
  readonly nowMs: number;
  readonly onPress: () => void;
}

function RowCard({ item, prefs, nowMs, onPress }: CardProps) {
  const theme = useTheme();
  const routeText = route(item);
  const departureClock = departureClockOf(item, prefs);
  const date = dateText(item, prefs);
  const operated = operatedAs(item);
  const place = terminalAndGate(item.origin.terminal, item.origin.gate);
  const label = join([
    item.designator,
    operated === null ? null : operated.toLowerCase(),
    routeText,
    date,
    `status ${pillLabel(item.status, item.pending)}`,
    item.pending
      ? 'looking up the flight'
      : departureClock === null
        ? null
        : `${hasDeparted(item, nowMs) ? 'departed' : 'departs'} ${departureClock}`,
    item.pending ? null : place,
  ]);
  return (
    <Pressable
      testID={`flight-row-${item.id}`}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          borderColor: theme.color.border,
          paddingVertical: theme.space.md,
          gap: theme.space.xs,
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      <View style={styles.line}>
        <Text style={[styles.strong, { color: theme.color.text, fontSize: theme.font.body }]}>
          {routeText === null ? item.designator : `${item.designator}  ${routeText}`}
        </Text>
        <StatusPill
          status={item.status}
          pending={item.pending}
          testID={`flight-${item.id}-status`}
        />
      </View>
      <Text style={{ color: theme.color.textMuted, fontSize: theme.font.small + 1 }}>
        {item.pending
          ? `${date}, looking up the flight`
          : join([date, departureClock, operated === null ? null : operated.toLowerCase()])}
      </Text>
    </Pressable>
  );
}

function HeroCard({ item, prefs, nowMs, onPress }: CardProps) {
  const theme = useTheme();
  const countdown = countdownFor(item, nowMs);
  const countdownLine = useCountdownText(countdown);
  const routeText = route(item);
  const departureClock = departureClockOf(item, prefs);
  const date = dateText(item, prefs);
  const operated = operatedAs(item);
  const place = terminalAndGate(item.origin.terminal, item.origin.gate);
  const delay = formatDelay(item.departureDelaySec);
  const lateOrEarly = delay === null || delay === 'on time' ? null : `Departure ${delay}`;
  const arrival = arrivalOf(item, prefs);
  const status = pillLabel(item.status, item.pending);
  const label = item.pending
    ? join([`New flight: ${item.designator}`, date, `status ${status}`, 'looking up the flight'])
    : join([
        `Next flight: ${item.designator}`,
        operated === null ? null : operated.toLowerCase(),
        routeText,
        date,
        `status ${status}`,
        departureClock === null
          ? null
          : `${hasDeparted(item, nowMs) ? 'departed' : 'departs'} ${departureClock}`,
        arrival === null ? null : `arrives ${arrival.spoken}`,
        place,
        lateOrEarly === null ? null : lateOrEarly.toLowerCase(),
        countdownLine,
      ]);
  return (
    <Pressable
      testID="home-next-flight"
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.hero,
        {
          backgroundColor: theme.color.surface,
          borderColor: theme.color.border,
          borderRadius: theme.radius.lg,
          padding: theme.space.lg + 2,
          gap: theme.space.sm,
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      <View style={styles.line}>
        <Text style={[styles.strong, { color: theme.color.textMuted, fontSize: theme.font.small }]}>
          {item.pending ? 'NEW FLIGHT' : 'NEXT FLIGHT'}
        </Text>
        <StatusPill
          status={item.status}
          pending={item.pending}
          testID={`flight-${item.id}-status`}
        />
      </View>
      <Text style={[styles.strong, { color: theme.color.text, fontSize: theme.font.heading + 2 }]}>
        {routeText === null ? item.designator : `${item.designator}  ${routeText}`}
      </Text>
      {operated === null ? null : (
        <Text
          testID="home-next-operated-as"
          style={{ color: theme.color.textMuted, fontSize: theme.font.small + 1 }}
        >
          {operated}
        </Text>
      )}
      <Text style={{ color: theme.color.textMuted, fontSize: theme.font.body }}>{date}</Text>
      {item.pending ? (
        <Text
          testID="home-next-pending"
          style={{ color: theme.color.text, fontSize: theme.font.body }}
        >
          Looking up the flight. Its times appear here once it has been found.
        </Text>
      ) : (
        <View style={styles.times}>
          <Text
            testID="home-next-departure"
            style={[styles.display, { color: theme.color.text, fontSize: theme.font.display }]}
          >
            {departureClock ?? '--:--'}
          </Text>
          {arrival === null ? null : (
            <Text
              testID="home-next-arrival"
              style={{ color: theme.color.textMuted, fontSize: theme.font.heading }}
            >
              {`→ ${arrival.text}`}
            </Text>
          )}
        </View>
      )}
      {place === null ? null : (
        <Text
          testID="home-next-gate"
          style={{ color: theme.color.text, fontSize: theme.font.body }}
        >
          {place}
        </Text>
      )}
      {lateOrEarly === null ? null : (
        <Text style={{ color: theme.color.warning, fontSize: theme.font.body, fontWeight: '600' }}>
          {lateOrEarly}
        </Text>
      )}
      <CountdownText text={countdownLine} testID="home-countdown" />
    </Pressable>
  );
}

export function FlightCard({
  variant,
  ...props
}: CardProps & {
  variant: 'hero' | 'row';
}) {
  return variant === 'hero' ? <HeroCard {...props} /> : <RowCard {...props} />;
}

const styles = StyleSheet.create({
  row: { borderBottomWidth: StyleSheet.hairlineWidth },
  hero: { borderWidth: StyleSheet.hairlineWidth },
  line: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  strong: { fontWeight: '700', flexShrink: 1 },
  times: { flexDirection: 'row', alignItems: 'baseline', gap: 12 },
  display: { fontWeight: '700', fontVariant: ['tabular-nums'] },
});
