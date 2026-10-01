/**
 * What a board or route-search answer says about its own data (increment 18, rulings B7, B12):
 * "as of" the oldest bucket's `fetchedAt` (FIDS rows carry no update time of their own, R3 D13),
 * the stale state (a bucket past its freshness: a refresh runs, or none can), the partial state
 * (part of the range could not be read), and the schedules-only badge (the provider has no live
 * data for the airport: the times are the published schedule). Offline with an answer already on
 * screen, it says the answer is the last one loaded.
 */

import type { BoardCoverage } from '@planeahead/shared';
import { StyleSheet, Text, View } from 'react-native';
import type { DisplayPrefs } from '../lib/display-prefs';
import { formatAge, formatClock } from '../lib/format';
import { useTheme } from '../theme/useTheme';
import { Notice } from './ui';

export interface BoardFreshnessProps {
  readonly fetchedAt: string | null;
  readonly stale: boolean;
  readonly partial: boolean;
  readonly coverage: BoardCoverage;
  /** The airport's IANA zone. */
  readonly tz: string;
  readonly prefs: DisplayPrefs;
  readonly offline: boolean;
  readonly nowMs: number;
  /** `board` or `route-search`: the test id prefix. */
  readonly testID: string;
}

export function BoardFreshness(props: BoardFreshnessProps) {
  const { fetchedAt, stale, partial, coverage, tz, prefs, offline, nowMs, testID } = props;
  const theme = useTheme();
  const clock =
    fetchedAt === null
      ? null
      : formatClock(fetchedAt, { timeFormat: prefs.timeFormat, timeZone: prefs.zoneFor(tz) });
  const age = formatAge(fetchedAt, nowMs);
  const asOf = clock === null ? null : `As of ${clock}${age === null ? '' : ` (${age})`}`;
  return (
    <View style={{ gap: theme.space.sm }}>
      <View style={[styles.line, { gap: theme.space.sm }]}>
        {asOf === null ? null : (
          <Text
            testID={`${testID}-as-of`}
            style={{ color: theme.color.textMuted, fontSize: theme.font.body, flexShrink: 1 }}
          >
            {asOf}
          </Text>
        )}
        {coverage === 'schedules_only' ? (
          <SchedulesOnlyBadge testID={`${testID}-schedules-only`} />
        ) : null}
      </View>
      {offline ? (
        <Notice tone="warning" testID={`${testID}-offline-copy`}>
          {`You are offline. This is the last answer loaded${clock === null ? '' : `, as of ${clock}`}.`}
        </Notice>
      ) : stale ? (
        <Notice tone="warning" testID={`${testID}-stale`}>
          These times may be out of date. Pull down in a minute to check for newer ones.
        </Notice>
      ) : null}
      {partial ? (
        <Notice tone="info" testID={`${testID}-partial`}>
          Part of this time range could not be loaded. Pull down to try again.
        </Notice>
      ) : null}
    </View>
  );
}

/** The schedules-only badge: one accessibility element that says what it means. */
export function SchedulesOnlyBadge({ testID }: { testID: string }) {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="text"
      accessibilityLabel="Schedules only: the times are the published schedule, with no live status"
      style={[
        styles.badge,
        {
          backgroundColor: theme.color.surface,
          borderColor: theme.color.inputBorder,
          borderRadius: theme.radius.pill,
          paddingHorizontal: theme.space.md - 2,
          paddingVertical: theme.space.xs - 1,
        },
      ]}
    >
      <Text style={[styles.badgeText, { color: theme.color.text, fontSize: theme.font.small }]}>
        Schedules only
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  badge: { borderWidth: 1, alignSelf: 'flex-start' },
  badgeText: { fontWeight: '700' },
});
