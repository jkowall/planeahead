/**
 * Find a flight by route (increment 18, ruling B12): origin, destination and the origin-local
 * date, answered from the origin's board buckets (`GET /v1/airports/{origin}/flights/to/
 * {destination}?date=`). Opened from the add sheet, beside it (a sheet over the sheet, so closing
 * it returns there), and open to anonymous accounts: every install starts anonymous and finding a
 * flight by route is the onboarding path. Each search takes one of the day's `route_searches`
 * (30 per account, and per network for an anonymous one); the 403 `cap_exceeded` answer is said
 * plainly with the limit from the payload, as is a 429. When the network's allowance ran out
 * (`scope: 'ip'`, R11), the anonymous user is told to sign in, with the way to.
 *
 * The results are server data only (TanStack Query, never the offline store), with the same "as
 * of", stale, partial and schedules-only states as the board, in the same virtualised list (R13).
 * Tapping a result asks to confirm, then adds the flight through the app's one add path
 * (src/lib/boards.ts `addBoardRow`); the first add that succeeds offers the notification
 * pre-prompt over the search (increment 16, ruling C1; review O1). A search made offline waits for
 * the network and says so instead of showing an empty list. A pull, or the same search again, asks
 * the route only for a failed or aged answer, and nothing on the screen invites a pull (R10): every
 * search the route answers costs a slot. While boards are off (404 `boards_disabled`, R8) the
 * screen says route search is not available yet, as news rather than as an error.
 */

import type { BoardViewRow, RouteSearchResponse } from '@planeahead/shared';
import { onlineManager } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, RefreshControl, StyleSheet, View } from 'react-native';
import { BoardFreshness } from '../../components/BoardFreshness';
import { BoardList } from '../../components/BoardList';
import { Body, Button, Notice, TextField, Title } from '../../components/ui';
import {
  BoardLoadError,
  routeSearchAsksAgain,
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

/** The confirmation's second line: `Wed 23 Sep, JFK to LHR`. */
function addSummary(row: BoardViewRow, answer: RouteSearchResponse): string {
  const date = row.add === undefined ? answer.date : row.add.date;
  return `${formatIsoDate(date)}, ${codeOf(answer.origin)} to ${codeOf(answer.destination)}`;
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
    // A fresh answer is kept: a pull asks again only when the answer failed or has aged (R10).
    if (search !== null && onlineManager.isOnline() && routeSearchAsksAgain(results, Date.now())) {
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
    } else if (routeSearchAsksAgain(results, Date.now())) {
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
  // Route search is off until boards launch (R8): said as news, not as an error.
  const disabled = failure?.failure === 'boards_disabled';
  // The network's allowance ran out, which signing in lifts (R11).
  const needsAccount = failure?.failure === 'cap_exceeded' && failure.scope === 'ip';
  const nowMs = Date.now();
  const { confirm } = rowAdd;
  const onAdd = useCallback(
    (picked: BoardViewRow) => {
      if (data !== undefined) {
        confirm(picked, addSummary(picked, data));
      }
    },
    [confirm, data],
  );

  const header = (
    <>
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
        <Notice
          tone={disabled ? 'info' : 'danger'}
          testID={disabled ? 'route-search-disabled' : 'route-search-error'}
        >
          {shownFailure}
        </Notice>
      )}
      {needsAccount ? (
        <Button
          testID="route-search-sign-in"
          title="Sign in or create an account"
          variant="secondary"
          onPress={() => {
            router.push('/sign-in');
          }}
        />
      ) : null}
      {search === null || data === undefined ? null : (
        <BoardFreshness
          fetchedAt={data.fetchedAt}
          stale={data.stale}
          partial={data.partial}
          coverage={data.coverage}
          tz={data.origin.tz}
          prefs={prefs}
          offline={!online}
          nowMs={nowMs}
          invitePull={false}
          testID="route-search"
        />
      )}
    </>
  );

  return (
    <BoardList
      testID="route-search"
      header={header}
      section={
        search === null || data === undefined
          ? null
          : {
              title: `${codeOf(data.origin)} to ${codeOf(data.destination)} on ${formatIsoDate(data.date)}`,
              testID: 'route-search-results',
              rows: data.flights,
              empty: (
                <Body muted testID="route-search-empty">
                  {`No flights from ${codeOf(data.origin)} to ${codeOf(data.destination)} that day.`}
                </Body>
              ),
            }
      }
      placeholder={
        search === null ? null : !online ? (
          <Notice tone="warning" testID="route-search-offline">
            You are offline. The search runs when the phone is back online.
          </Notice>
        ) : results.isFetching ? (
          <ActivityIndicator
            testID="route-search-loading"
            accessibilityLabel="Searching"
            color={theme.color.accent}
          />
        ) : null
      }
      direction="departures"
      // Rows exist only with an answer, which names its origin's zone.
      tz={data?.origin.tz ?? 'UTC'}
      prefs={prefs}
      addingId={rowAdd.addingId}
      onAdd={onAdd}
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
    />
  );
}

const styles = StyleSheet.create({
  pair: { flexDirection: 'row', flexWrap: 'wrap' },
  field: { flexGrow: 1, flexBasis: 0 },
});
