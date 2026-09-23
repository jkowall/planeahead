/** The home screen with nothing ahead: what the app does, and the add button. */

import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme/useTheme';
import { Button } from './ui';

export function EmptyState({
  onAdd,
  hasPastFlights = false,
}: {
  onAdd: () => void;
  hasPastFlights?: boolean;
}) {
  const theme = useTheme();
  return (
    <View
      testID="home-empty"
      style={[
        styles.box,
        {
          backgroundColor: theme.color.surface,
          borderColor: theme.color.border,
          borderRadius: theme.radius.lg,
          padding: theme.space.xl,
          gap: theme.space.md,
        },
      ]}
    >
      <Text style={[styles.title, { color: theme.color.text, fontSize: theme.font.heading }]}>
        {hasPastFlights ? 'No upcoming flights' : 'No flights yet'}
      </Text>
      <Text style={{ color: theme.color.textMuted, fontSize: theme.font.body, lineHeight: 22 }}>
        Add a flight by its number and date. Its times, gate and status appear here and stay up to
        date, even offline.
      </Text>
      <Button testID="home-empty-add" title="Add a flight" onPress={onAdd} />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: StyleSheet.hairlineWidth },
  title: { fontWeight: '700' },
});
