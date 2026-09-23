/**
 * The detail screen's timeline (ruling T4): gate departure, takeoff, landing, gate arrival and the
 * baggage claim, each with its best known time (actual, else estimated, else scheduled), the
 * scheduled time beside it when they differ, the minutes early or late, and the place. The steps
 * come from `buildTimeline` (src/lib/timeline.ts), from the snapshot on the subscription row.
 *
 * A time on another local day than the flight's departure date (the header's date) carries the
 * day cue, `+1` as on the home card (`the next day` for a screen reader): an overnight arrival,
 * or a delay that pushes the departure past midnight (increment 10 review). A step's marker
 * colour is repeated in its accessibility label as words (done, next, still ahead, cancelled).
 */

import { StyleSheet, Text, View } from 'react-native';
import type { DisplayPrefs } from '../lib/display-prefs';
import { dayShiftSuffix, dayShiftWords, daysAfter, formatClock } from '../lib/format';
import type { TimelineStep } from '../lib/timeline';
import { useTheme } from '../theme/useTheme';

function deltaText(minutes: number | null): string | null {
  if (minutes === null || minutes === 0) {
    return null;
  }
  return minutes > 0 ? `${String(minutes)} min late` : `${String(-minutes)} min early`;
}

function qualifier(step: TimelineStep): string {
  if (step.actual !== null) {
    return 'actual';
  }
  if (step.estimated !== null) {
    return 'estimated';
  }
  return 'scheduled';
}

const STATE_WORDS: Readonly<Record<TimelineStep['state'], string>> = {
  done: 'done',
  next: 'next',
  upcoming: 'still ahead',
  cancelled: 'cancelled',
};

export function Timeline({
  steps,
  prefs,
  departureDate = null,
}: {
  steps: readonly TimelineStep[];
  prefs: DisplayPrefs;
  /** The departure date `YYYY-MM-DD` as the header shows it; the day cues count from it. */
  departureDate?: string | null;
}) {
  const theme = useTheme();
  const clockOf = (iso: string, zone: string | undefined): { text: string; days: number } => ({
    text: formatClock(iso, { timeFormat: prefs.timeFormat, timeZone: zone }),
    days: daysAfter(departureDate, iso, zone),
  });
  return (
    <View testID="flight-timeline" accessibilityRole="list" style={{ gap: 0 }}>
      {steps.map((step, index) => {
        const zone = prefs.zoneFor(step.timeZone);
        const best = step.actual ?? step.estimated ?? step.scheduled;
        const bestClock = best === null ? null : clockOf(best, zone);
        const clock =
          bestClock === null ? null : `${bestClock.text}${dayShiftSuffix(bestClock.days)}`;
        const scheduled =
          step.scheduled === null || best === step.scheduled ? null : clockOf(step.scheduled, zone);
        const scheduledClock =
          scheduled === null ? null : `${scheduled.text}${dayShiftSuffix(scheduled.days)}`;
        const spokenDay = bestClock === null ? null : dayShiftWords(bestClock.days);
        const delta = deltaText(step.deltaMinutes);
        const done = step.state === 'done';
        const marker =
          step.state === 'cancelled'
            ? theme.color.danger
            : done
              ? theme.color.success
              : step.state === 'next'
                ? theme.color.accent
                : theme.color.rail;
        const last = index === steps.length - 1;
        return (
          <View
            key={step.key}
            testID={`timeline-${step.key}`}
            accessibilityLabel={[
              step.title,
              bestClock === null
                ? null
                : spokenDay === null
                  ? bestClock.text
                  : `${bestClock.text} ${spokenDay}`,
              bestClock === null ? null : qualifier(step),
              step.place,
              STATE_WORDS[step.state],
            ]
              .filter((part) => part !== null)
              .join(', ')}
            style={styles.step}
          >
            <View style={styles.railColumn}>
              <View
                style={[
                  styles.dot,
                  {
                    backgroundColor:
                      done || step.state === 'cancelled' ? marker : theme.color.background,
                    borderColor: marker,
                  },
                ]}
              />
              {last ? null : <View style={[styles.rail, { backgroundColor: theme.color.rail }]} />}
            </View>
            <View style={[styles.body, { paddingBottom: last ? 0 : theme.space.lg }]}>
              <View style={styles.line}>
                <Text
                  style={[
                    styles.title,
                    { color: theme.color.text, fontSize: theme.font.body },
                    step.state === 'cancelled' ? styles.struck : null,
                  ]}
                >
                  {step.title}
                </Text>
                {clock === null ? null : (
                  <Text
                    testID={`timeline-${step.key}-time`}
                    style={[styles.time, { color: theme.color.text, fontSize: theme.font.body }]}
                  >
                    {clock}
                  </Text>
                )}
              </View>
              <Text style={{ color: theme.color.textMuted, fontSize: theme.font.small }}>
                {[
                  clock === null ? null : qualifier(step),
                  scheduledClock === null ? null : `scheduled ${scheduledClock}`,
                  delta,
                  step.place,
                ]
                  .filter((part) => part !== null)
                  .join(', ')}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  step: { flexDirection: 'row', gap: 12 },
  railColumn: { width: 14, alignItems: 'center' },
  dot: { width: 14, height: 14, borderRadius: 7, borderWidth: 2, marginTop: 3 },
  rail: { width: 2, flex: 1, marginTop: 2 },
  body: { flex: 1, gap: 2 },
  line: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  title: { fontWeight: '600' },
  time: { fontWeight: '700', fontVariant: ['tabular-nums'] },
  struck: { textDecorationLine: 'line-through' },
});
