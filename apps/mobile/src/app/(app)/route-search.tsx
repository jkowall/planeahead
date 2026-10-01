/**
 * Find a flight by route (increment 18, ruling B12): origin, destination and the origin-local
 * date, answered from the origin's board buckets (`GET /v1/airports/{origin}/flights/to/
 * {destination}?date=`). Opened from the add sheet, beside it (a sheet over the sheet, so closing
 * it returns there), and open to anonymous accounts: every install starts anonymous and finding a
 * flight by route is the onboarding path. Each search takes one of the day's `route_searches`
 * (30 per account, and per network for an anonymous one); the 403 `cap_exceeded` answer is said
 * plainly with the limit from the payload, as is a 429.
 *
 * The results are server data only (TanStack Query, never the offline store), with the same "as
 * of", stale, partial and schedules-only states as the board. Tapping a result asks to confirm,
 * then adds the flight through the app's one add path (src/lib/boards.ts `addBoardRow`). A search
 * made offline waits for the network and says so instead of showing an empty list.
 */

import type { BoardViewRow } from '@planeahead/shared';
import { onlineManager } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, RefreshControl, StyleSheet, View } from 'react-native';
import { BoardFreshness } from '../../components/BoardFreshness';
import { BoardRow } from '../../components/BoardRow';
import { Body, Button, Notice, Screen, Section, TextField, Title } from '../../components/ui';
import {
  BoardLoadError,
  routeSearchFailureMessage,
  useIsOnline,
  useRouteSearch,
  useRowAdd,
  validateRouteSearch,
  type RouteSearchErrors,
  type RouteSearchInput,
} from '../../lib/boards';
import { useDisplayPrefs } from '../../lib/display-prefs';
import { addDays, formatDateInput, formatIsoDate, localDate } from '../../lib/format';
import { useRefreshGesture } from '../../lib/use-refresh-gesture';
import { useTheme } from '../../theme/useTheme';

function codeOf(airport: { readonly iata: string | null; readonly icao: string }): string {
  return airport.iata ?? airport.icao;
}

export default function RouteSearchScreen() {
  const router = useRouter();
  const theme = useTheme();
  const prefs = useDisplayPrefs();
  const online = useIsOnline();
  const [today] = useState(() => localDate(Date.now()));
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [date, setDate] = useState(today);
  const [errors, setErrors] = useState<RouteSearchErrors>({});
  const [search, setSearch] = useState<RouteSearchInput | null>(null);
  const results = useRouteSearch(search);
  const rowAdd = useRowAdd();
  const pull = useRefreshGesture(async () => {
    if (search !== null && onlineManager.isOnline()) {
      await results.refetch();
    }
  });

  const quickDates = [0, 1, 2].map((offset) => addDays(today, offset));
  const clearError = (field: keyof RouteSearchErrors) => {
    setErrors((current) => {
      const next = { ...current };
      delete next[field];
      return next;
    });
  };
  const submit = () => {
    const validation = validateRouteSearch({ origin, destination, date });
    if (!validation.ok) {
      setErrors(validation.errors);
      return;
    }
    setErrors({});
    rowAdd.dismiss();
    const next = validation.value;
    const same =
      search !== null &&
      search.origin === next.origin &&
      search.destination === next.destination &&
      search.date === next.date;
    if (!same) {
      setSearch(next);
    } else if (results.error !== null || results.isStale) {
      // The same search again: asked only when the last answer failed or has gone stale, since
      // each search the route answers takes one of the day's slots.
      void results.refetch();
    }
  };

  const data = results.data;
  const failure = results.error instanceof BoardLoadError ? results.error : null;
  const failureText =
    results.error === null || search === null
      ? null
      : failure === null
        ? 'The search could not be answered right now. Try again later.'
        : routeSearchFailureMessage(failure, search);
  const shownFailure = online || data !== undefined ? failureText : null;
  const nowMs = Date.now();
  const routeText =
    data === undefined
      ? ''
      : `${codeOf(data.origin)} to ${codeOf(data.destination)} on ${formatIsoDate(data.date)}`;
  const summary = (row: BoardViewRow) =>
    data === undefined
      ? ''
      : `${row.add === undefined ? formatIsoDate(data.date) : formatIsoDate(row.add.date)}, ${codeOf(data.origin)} to ${codeOf(data.destination)}`;

  return (
    <Screen
      testID="route-search"
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
      <Title>Find a flight by route</Title>
      <Body muted>The airports it flies between and the date it departs, in local time.</Body>
      <View style={[styles.pair, { gap: theme.space.sm }]}>
        <View style={styles.field}>
          <TextField
            testID="route-search-origin"
            label="From"
            placeholder="LHR"
            autoCapitalize="characters"
            autoCorrect={false}
            autoComplete="off"
            maxLength={4}
            value={origin}
            onChangeText={(value) => {
              setOrigin(value);
              clearError('origin');
            }}
            error={errors.origin}
          />
        </View>
        <View style={styles.field}>
          <TextField
            testID="route-search-destination"
            label="To"
            placeholder="JFK"
            autoCapitalize="characters"
            autoCorrect={false}
            autoComplete="off"
            maxLength={4}
            value={destination}
            onChangeText={(value) => {
              setDestination(value);
              clearError('destination');
            }}
            error={errors.destination}
          />
        </View>
      </View>
      <TextField
        testID="route-search-date"
        label="Departure date"
        placeholder="YYYY-MM-DD"
        autoCorrect={false}
        autoComplete="off"
        inputMode="numeric"
        maxLength={10}
        value={date}
        onChangeText={(value) => {
          setDate(formatDateInput(value));
          clearError('date');
        }}
        error={errors.date}
      />
      <View style={[styles.pair, { gap: theme.space.sm }]}>
        {quickDates.map((value, index) => (
          <Button
            key={value}
            testID={`route-search-date-${String(index)}`}
            title={index === 0 ? 'Today' : index === 1 ? 'Tomorrow' : formatIsoDate(value)}
            variant="secondary"
            selected={date === value}
            style={styles.field}
            onPress={() => {
              setDate(value);
              clearError('date');
            }}
          />
        ))}
      </View>
      <Button
        testID="route-search-submit"
        title="Search"
        accessibilityLabel="Search flights on this route"
        busy={results.isFetching}
        onPress={submit}
      />
      <Button
        testID="route-search-close"
        title="Close"
        variant="secondary"
        onPress={() => {
          router.back();
        }}
      />

      {rowAdd.outcome === null ? null : (
        <Notice
          tone={rowAdd.outcome.tone}
          testID="route-search-add-message"
          onDismiss={rowAdd.dismiss}
        >
          {rowAdd.outcome.text}
        </Notice>
      )}
      {shownFailure === null ? null : (
        <Notice tone="danger" testID="route-search-error">
          {shownFailure}
        </Notice>
      )}

      {search === null ? null : data !== undefined ? (
        <>
          <BoardFreshness
            fetchedAt={data.fetchedAt}
            stale={data.stale}
            partial={data.partial}
            coverage={data.coverage}
            tz={data.origin.tz}
            prefs={prefs}
            offline={!online}
            nowMs={nowMs}
            testID="route-search"
          />
          <Section title={routeText} testID="route-search-results">
            {data.flights.length === 0 ? (
              <Body muted testID="route-search-empty">
                {`No flights from ${codeOf(data.origin)} to ${codeOf(data.destination)} that day.`}
              </Body>
            ) : (
              data.flights.map((row) => (
                <BoardRow
                  key={row.id}
                  row={row}
                  direction="departures"
                  tz={data.origin.tz}
                  prefs={prefs}
                  adding={rowAdd.addingId === row.id}
                  disabled={rowAdd.addingId !== null}
                  onAdd={(picked) => {
                    rowAdd.confirm(picked, summary(picked));
                  }}
                />
              ))
            )}
          </Section>
        </>
      ) : !online ? (
        <Notice tone="warning" testID="route-search-offline">
          You are offline. The search runs when the phone is back online.
        </Notice>
      ) : results.isFetching ? (
        <ActivityIndicator
          testID="route-search-loading"
          accessibilityLabel="Searching"
          color={theme.color.accent}
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  pair: { flexDirection: 'row', flexWrap: 'wrap' },
  field: { flexGrow: 1, flexBasis: 0 },
});
