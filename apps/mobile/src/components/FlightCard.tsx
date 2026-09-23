/**
 * One flight on the home screen: the `hero` card for the next flight (departure time large, gate
 * and terminal, the countdown, the delay) and the `row` for the rest of the list. Everything it
 * shows comes from the `FlightItem` (the subscription row and its denormalised snapshot) and the
 * account's display preferences; it reads nothing itself.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { DisplayPrefs } from '../lib/display-prefs';
import { countdownFor, departureTime, type FlightItem } from '../lib/flight-model';
import { dayShift, formatClock, formatDay, formatDelay, formatIsoDate } from '../lib/format';
import { terminalAndGate } from '../lib/timeline';
import { useTheme } from '../theme/useTheme';
import { Countdown } from './Countdown';
import { StatusPill } from './StatusPill';

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

function arrivalText(item: FlightItem, prefs: DisplayPrefs): string | null {
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
  return shift > 0 ? `${clock} +${String(shift)}` : clock;
}

export function FlightCard({
  item,
  prefs,
  variant,
  nowMs,
  onPress,
}: {
  item: FlightItem;
  prefs: DisplayPrefs;
  variant: 'hero' | 'row';
  nowMs: number;
  onPress: () => void;
}) {
  const theme = useTheme();
  const departure = departureTime(item);
  const departureClock =
    departure === null
      ? null
      : formatClock(departure, {
          timeFormat: prefs.timeFormat,
          timeZone: prefs.zoneFor(item.origin.tz),
        });
  const routeText = route(item);
  const pill = (
    <StatusPill status={item.status} pending={item.pending} testID={`flight-${item.id}-status`} />
  );
  const label = [item.designator, routeText, dateText(item, prefs)]
    .filter((part) => part !== null && part !== '')
    .join(', ');

  if (variant === 'row') {
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
          {pill}
        </View>
        <Text style={{ color: theme.color.textMuted, fontSize: theme.font.small + 1 }}>
          {item.pending
            ? `${dateText(item, prefs)}, looking up the flight`
            : [dateText(item, prefs), departureClock].filter((part) => part !== null).join(', ')}
        </Text>
      </Pressable>
    );
  }

  const countdown = countdownFor(item, nowMs);
  const place = terminalAndGate(item.origin.terminal, item.origin.gate);
  const delay = formatDelay(item.departureDelaySec);
  const arrival = arrivalText(item, prefs);
  return (
    <Pressable
      testID="home-next-flight"
      accessibilityRole="button"
      accessibilityLabel={`Next flight: ${label}`}
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
          NEXT FLIGHT
        </Text>
        {pill}
      </View>
      <Text style={[styles.strong, { color: theme.color.text, fontSize: theme.font.heading + 2 }]}>
        {routeText === null ? item.designator : `${item.designator}  ${routeText}`}
      </Text>
      <Text style={{ color: theme.color.textMuted, fontSize: theme.font.body }}>
        {dateText(item, prefs)}
      </Text>
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
            {`→ ${arrival}`}
          </Text>
        )}
      </View>
      {place === null ? null : (
        <Text
          testID="home-next-gate"
          style={{ color: theme.color.text, fontSize: theme.font.body }}
        >
          {place}
        </Text>
      )}
      {delay === null || delay === 'on time' ? null : (
        <Text style={{ color: theme.color.warning, fontSize: theme.font.body, fontWeight: '600' }}>
          {`Departure ${delay}`}
        </Text>
      )}
      {countdown === null ? null : (
        <Countdown testID="home-countdown" at={countdown.at} kind={countdown.kind} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { borderBottomWidth: StyleSheet.hairlineWidth },
  hero: { borderWidth: StyleSheet.hairlineWidth },
  line: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  strong: { fontWeight: '700', flexShrink: 1 },
  times: { flexDirection: 'row', alignItems: 'baseline', gap: 12 },
  display: { fontWeight: '700', fontVariant: ['tabular-nums'] },
});
