/**
 * Development only: seeds the offline store with demo flights (src/dev/demo-flights.ts, through
 * the real page apply) and shows the home screen over it. It exists for the one device check the
 * increment runs without an API (docs/increments/10-verification.md): with no API reachable the
 * first-launch anonymous sign-in fails, so the session-gated `(app)` group redirects to sign-in,
 * and this route, outside the group, is how the development build reaches the home screen.
 *
 * Reach it with the launch argument `-planeaheadSeededHome YES` (src/dev/seeded-launch.ts; a
 * `planeahead://dev/seeded-home` link works too, after iOS's "Open in ...?" prompt). In any build
 * that is not a development build of the development variant it seeds nothing and redirects home.
 */

import { Redirect } from 'expo-router';
import { useEffect, useState } from 'react';
import { Loading } from '../../components/ui';
import { runtimeConfig } from '../../lib/config';
import { whenStoreReady } from '../../lib/db/client';
import { seedDemoFlights } from '../../dev/demo-flights';
import HomeScreen from '../(app)/index';

export default function SeededHome() {
  const allowed = __DEV__ && runtimeConfig().variant === 'development';
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!allowed) {
      return;
    }
    let active = true;
    void whenStoreReady().then((store) => {
      const rows = store.sqlite.get<{ n: number }>(
        'SELECT count(*) AS n FROM flight_subscriptions WHERE deleted_at IS NULL',
      );
      if ((rows?.n ?? 0) === 0) {
        seedDemoFlights(store.sqlite, Date.now());
      }
      if (active) {
        setReady(true);
      }
    });
    return () => {
      active = false;
    };
  }, [allowed]);

  if (!allowed) {
    return <Redirect href="/" />;
  }
  return ready ? <HomeScreen /> : <Loading label="Seeding demo flights" />;
}
