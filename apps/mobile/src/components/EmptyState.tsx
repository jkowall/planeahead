/**
 * The home screen's top slot when it has no flight to show there (increment 10 review):
 *
 * - `EmptyState`: the store has no rows at all. What the app does, and the add button. Never
 *   shown next to a flight being added: a pending add fills the top slot as "Adding" instead
 *   (src/lib/flight-model.ts `selectHome`).
 * - `NoUpcomingFlights`: every flight in the list is behind the user; the list stays below it.
 */

import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme/useTheme';
import { Button } from './ui';

function Panel({
  testID,
  title,
  body,
  onAdd,
}: {
  testID: string;
  title: string;
  body: string;
  onAdd: () => void;
}) {
  const theme = useTheme();
  return (
    <View
      testID={testID}
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
      <Text
        accessibilityRole="header"
        style={[styles.title, { color: theme.color.text, fontSize: theme.font.heading }]}
      >
        {title}
      </Text>
      <Text style={{ color: theme.color.textMuted, fontSize: theme.font.body, lineHeight: 22 }}>
        {body}
      </Text>
      <Button testID={`${testID}-add`} title="Add a flight" onPress={onAdd} />
    </View>
  );
}

export function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <Panel
      testID="home-empty"
      title="No flights yet"
      body="Add a flight by its number and date. Its times, gate and status appear here and stay up to date, even offline."
      onAdd={onAdd}
    />
  );
}

export function NoUpcomingFlights({ onAdd }: { onAdd: () => void }) {
  return (
    <Panel
      testID="home-no-upcoming"
      title="No upcoming flights"
      body="Your past flights are below. Add your next one by its number and date."
      onAdd={onAdd}
    />
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: StyleSheet.hairlineWidth },
  title: { fontWeight: '700' },
});
