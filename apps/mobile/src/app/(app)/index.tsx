/**
 * Home (increment 10, ruling T5): the next flight by scheduled departure (the first that has not
 * arrived, been cancelled or finished; a landed flight hands over 30 minutes after its arrival,
 * or sooner when a connection departs) with its status pill, gate and terminal and a countdown,
 * then the rest of the list. The empty state with the add button only when the store has no rows
 * at all; an add still being looked up fills the top slot as "Adding" when nothing live is ahead,
 * and a list of past flights only says there is nothing upcoming (increment 10 review).
 *
 * Every read is the increment 9 live query on `flight_subscriptions` (src/lib/flight-queries.ts),
 * so the list re-renders once per committed write: a 200-row sync page is one re-render
 * (__tests__/live-query-coalescing.test.ts). Pull to refresh here is a sync pull (outbox drain,
 * then `GET /v1/sync`), which costs no provider call; the per-flight provider refresh,
 * `POST /v1/flights/:id/refresh`, is the detail screen's gesture, because each one is charged to
 * the flight's daily refresh budget.
 */

import { useRouter } from 'expo-router';
import { RefreshControl, StyleSheet, View } from 'react-native';
import { EmptyState, NoUpcomingFlights } from '../../components/EmptyState';
import { FlightCard } from '../../components/FlightCard';
import { Body, Button, Loading, Notice, Screen, Section, Title } from '../../components/ui';
import { authClient, isAnonymousSession } from '../../lib/auth-client';
import { useDisplayPrefs } from '../../lib/display-prefs';
import { selectHome } from '../../lib/flight-model';
import { useFlightNotices } from '../../lib/flight-notices';
import { useFlightList } from '../../lib/flight-queries';
import { syncNow } from '../../lib/session';
import { useRefreshGesture } from '../../lib/use-refresh-gesture';
import { useTheme } from '../../theme/useTheme';

export default function HomeScreen() {
  const router = useRouter();
  const theme = useTheme();
  const prefs = useDisplayPrefs();
  const { data: session } = authClient.useSession();
  const { data: items, error } = useFlightList();
  const notices = useFlightNotices((state) => state.notices);
  const dismiss = useFlightNotices((state) => state.dismiss);
  const userId = session?.user.id ?? null;
  const pull = useRefreshGesture(async () => {
    if (userId !== null) {
      await syncNow(userId);
    }
  });

  if (items === undefined && error === undefined) {
    return <Loading label="Loading your flights" />;
  }

  const nowMs = Date.now();
  const { hero, rest } = selectHome(items ?? [], nowMs);
  const openFlight = (id: string) => {
    router.push({ pathname: '/flight/[id]', params: { id } });
  };
  const add = () => {
    router.push('/add');
  };

  return (
    <Screen
      testID="home-screen"
      refreshControl={
        <RefreshControl
          refreshing={pull.refreshing}
          onRefresh={() => {
            pull.onRefresh();
          }}
          tintColor={theme.color.accent}
          colors={[theme.color.accent]}
        />
      }
    >
      <View style={styles.header}>
        <Title>PlaneAhead</Title>
        <View style={[styles.actions, { gap: theme.space.sm }]}>
          <Button
            testID="home-settings"
            title="Settings"
            variant="secondary"
            onPress={() => {
              router.push('/settings');
            }}
          />
          <Button testID="home-add" title="Add" accessibilityLabel="Add a flight" onPress={add} />
        </View>
      </View>

      {notices.map((notice) => (
        <Notice
          key={notice.id}
          tone="danger"
          testID={`home-notice-${notice.id}`}
          onDismiss={() => {
            dismiss(notice.id);
          }}
        >
          {notice.message}
        </Notice>
      ))}

      {error === undefined ? null : (
        <Notice tone="danger" testID="home-error">
          Your flights could not be read from this phone. Pull down to try again.
        </Notice>
      )}

      {hero !== null ? (
        <FlightCard
          item={hero}
          prefs={prefs}
          variant="hero"
          nowMs={nowMs}
          onPress={() => {
            openFlight(hero.id);
          }}
        />
      ) : rest.length === 0 ? (
        <EmptyState onAdd={add} />
      ) : (
        <NoUpcomingFlights onAdd={add} />
      )}

      {rest.length === 0 ? null : (
        <Section title={hero === null ? 'Your flights' : 'Other flights'} testID="home-rest">
          {rest.map((item) => (
            <FlightCard
              key={item.id}
              item={item}
              prefs={prefs}
              variant="row"
              nowMs={nowMs}
              onPress={() => {
                openFlight(item.id);
              }}
            />
          ))}
        </Section>
      )}

      {isAnonymousSession(session) ? (
        <Section title="Account">
          <Body>Sign in to keep your flights on every device.</Body>
          <Button
            testID="home-sign-in"
            title="Sign in or create an account"
            variant="secondary"
            onPress={() => {
              router.push('/sign-in');
            }}
          />
        </Section>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  actions: { flexDirection: 'row' },
});
