/**
 * Home placeholder (increment 10 builds the next-flight screen). It already reads the offline
 * store through the coalescing live query, so a device run shows sync reaching the store.
 */

import { count, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/expo-sqlite';
import { useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useMemo } from 'react';
import { Body, Button, Screen, Section, Title } from '../../components/ui';
import { authClient, isAnonymousSession } from '../../lib/auth-client';
import { useLiveQuery } from '../../lib/db/live-query';
import { flightSubscriptions, schema } from '../../lib/db/schema';

export default function HomeScreen() {
  const router = useRouter();
  const db = useSQLiteContext();
  const orm = useMemo(() => drizzle(db, { schema }), [db]);
  const { data: session } = authClient.useSession();
  const { data } = useLiveQuery(
    flightSubscriptions,
    () =>
      orm
        .select({ tracked: count() })
        .from(flightSubscriptions)
        .where(isNull(flightSubscriptions.deletedAt)),
    [{ tracked: 0 }],
    [orm],
  );
  const tracked = data[0]?.tracked ?? 0;

  return (
    <Screen testID="home-screen">
      <Title>PlaneAhead</Title>
      <Body muted>Your next flight will show here.</Body>
      <Body testID="home-tracked-count">
        {tracked === 1 ? '1 flight tracked' : `${String(tracked)} flights tracked`}
      </Body>
      {isAnonymousSession(session) ? (
        <Section title="Account">
          <Body>Sign in to keep your flights on every device.</Body>
          <Button
            testID="home-sign-in"
            title="Sign in or create an account"
            onPress={() => {
              router.push('/sign-in');
            }}
          />
        </Section>
      ) : null}
      <Button
        testID="home-settings"
        title="Settings"
        variant="secondary"
        onPress={() => {
          router.push('/settings');
        }}
      />
    </Screen>
  );
}
