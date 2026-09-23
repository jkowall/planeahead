/**
 * The status pill: one of the shared `FLIGHT_STATUS_VALUES` (a status this build does not know
 * already parses as `unknown`), or `pending` for an add the server has not answered yet. Colours
 * from the theme's status tokens, which clear WCAG AA in both schemes.
 */

import type { FlightStatusValue } from '@planeahead/shared';
import { StyleSheet, Text, View } from 'react-native';
import { statusLabel } from '../lib/format';
import { useTheme } from '../theme/useTheme';
import type { PillTone } from '../theme/tokens';

export function StatusPill({
  status,
  pending = false,
  testID,
}: {
  status: FlightStatusValue | null;
  pending?: boolean;
  testID?: string;
}) {
  const theme = useTheme();
  const tone: PillTone = pending ? 'pending' : (status ?? 'scheduled');
  const label = pending ? 'Adding' : status === null ? 'Waiting for data' : statusLabel(status);
  const colors = theme.status[tone];
  return (
    <View
      testID={testID}
      accessibilityLabel={`Status: ${label}`}
      style={[
        styles.pill,
        {
          backgroundColor: colors.background,
          borderRadius: theme.radius.pill,
          paddingHorizontal: theme.space.md - 2,
          paddingVertical: theme.space.xs - 1,
        },
      ]}
    >
      <Text style={[styles.label, { color: colors.text, fontSize: theme.font.small }]}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: { alignSelf: 'flex-start' },
  label: { fontWeight: '700' },
});
