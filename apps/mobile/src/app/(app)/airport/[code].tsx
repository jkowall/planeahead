/**
 * An airport's board (increment 18, ruling B12): departures and arrivals from an hour ago for
 * twelve hours (the route's default window), served from the per-airport cache. The answer's
 * `fetchedAt` is the board's "as of" time; a stale or partial answer says so, and an airport the
 * provider covers by schedule only shows the badge (src/components/BoardFreshness.tsx). Pull to
 * refresh asks the route again (at most once per gesture); the server decides whether that costs
 * a provider call.
 *
 * Opened from a flight's origin and destination on the detail screen (everyone: an anonymous
 * account may open the boards of its own flights' airports) and from the add sheet's airport
 * field (signed-in users only: any other airport answers an anonymous account 403
 * `board_requires_account`, which is said here with a way to sign in).
 *
 * Tapping a row asks to confirm, then adds the flight through the app's one add path
 * (src/lib/boards.ts `addBoardRow`: `addFlight` with the row's designator, origin-local date and
 * origin, the outbox and the optimistic row as for a typed add). The board itself is server data
 * only: TanStack Query, never the offline store. Offline with nothing loaded, the screen says so
 * instead of showing an empty list.
 */

import type { BoardDirection, BoardViewRow } from '@planeahead/shared';
import { onlineManager } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { BoardFreshness } from '../../../components/BoardFreshness';
import { BoardRow } from '../../../components/BoardRow';
import { Body, Button, Notice, Screen, Section, Title } from '../../../components/ui';
import {
  BoardLoadError,
  boardFailureMessage,
  useAirportBoard,
  useIsOnline,
  useRowAdd,
} from '../../../lib/boards';
import { useDisplayPrefs } from '../../../lib/display-prefs';
import { formatClock, formatIsoDate } from '../../../lib/format';
import { useRefreshGesture } from '../../../lib/use-refresh-gesture';
import { useTheme } from '../../../theme/useTheme';

const DIRECTION_TITLES: Readonly<Record<BoardDirection, string>> = {
  departures: 'Departures',
  arrivals: 'Arrivals',
};

function directionOf(value: unknown): BoardDirection {
  return value === 'arrivals' ? 'arrivals' : 'departures';
}

function paramOf(value: string | string[] | undefined): string {
  return (typeof value === 'string' ? value : '').trim().toUpperCase();
}

/** The list's title: `Departures, 13:00 to 01:00`, in the airport's time. */
function windowTitle(
  direction: BoardDirection,
  from: string,
  to: string,
  clock: (iso: string) => string,
): string {
  return `${DIRECTION_TITLES[direction]}, ${clock(from)} to ${clock(to)}`;
}

/** The confirmation's second line: `Thu 1 Oct, LHR to JFK`. */
function addSummary(row: BoardViewRow, direction: BoardDirection, airport: string): string {
  const other = row.counterpart.iata ?? row.counterpart.icao;
  const [from, to] = direction === 'departures' ? [airport, other] : [other, airport];
  return `${row.add === undefined ? '' : `${formatIsoDate(row.add.date)}, `}${from} to ${to}`;
}

export default function AirportBoardScreen() {
  const params = useLocalSearchParams<{ code: string; direction?: string }>();
  const code = paramOf(params.code);
  const router = useRouter();
  const theme = useTheme();
  const prefs = useDisplayPrefs();
  const online = useIsOnline();
  const [direction, setDirection] = useState<BoardDirection>(() => directionOf(params.direction));
  const board = useAirportBoard(code, direction);
  const rowAdd = useRowAdd();
  const pull = useRefreshGesture(async () => {
    // A refetch while offline would wait for the network with the spinner up; say offline instead.
    if (onlineManager.isOnline()) {
      await board.refetch();
    }
  });

  const data = board.data;
  const airport = data?.airport;
  const shownCode = airport?.iata ?? airport?.icao ?? code;
  const failure = board.error instanceof BoardLoadError ? board.error : null;
  const failureText =
    board.error === null
      ? null
      : failure === null
        ? 'The board could not be loaded right now. Pull down to try again later.'
        : boardFailureMessage(failure, shownCode);
  const needsAccount = failure?.failure === 'requires_account';
  // Offline with nothing loaded, the offline state says it all.
  const shownFailure = online || data !== undefined ? failureText : null;
  const nowMs = Date.now();
  const clockIn = (tz: string) => (iso: string) =>
    formatClock(iso, { timeFormat: prefs.timeFormat, timeZone: prefs.zoneFor(tz) });

  return (
    <Screen
      testID="airport-board"
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
      <Button
        testID="board-back"
        title="Back"
        variant="secondary"
        style={styles.back}
        onPress={() => {
          router.back();
        }}
      />
      <View style={{ gap: theme.space.xs }}>
        <Title>{airport?.name ?? code}</Title>
        {airport === undefined ? null : (
          <Text
            testID="board-codes"
            style={{ color: theme.color.textMuted, fontSize: theme.font.body }}
          >
            {airport.iata === null ? airport.icao : `${airport.iata} (${airport.icao})`}
          </Text>
        )}
      </View>
      <View style={[styles.tabs, { gap: theme.space.sm }]}>
        {(['departures', 'arrivals'] as const).map((value) => (
          <Button
            key={value}
            testID={`board-${value}`}
            title={DIRECTION_TITLES[value]}
            variant="secondary"
            selected={direction === value}
            style={styles.tab}
            onPress={() => {
              setDirection(value);
            }}
          />
        ))}
      </View>

      {rowAdd.outcome === null ? null : (
        <Notice tone={rowAdd.outcome.tone} testID="board-add-message" onDismiss={rowAdd.dismiss}>
          {rowAdd.outcome.text}
        </Notice>
      )}
      {shownFailure === null ? null : (
        <Notice tone="danger" testID="board-error">
          {shownFailure}
        </Notice>
      )}
      {needsAccount ? (
        <Button
          testID="board-sign-in"
          title="Sign in or create an account"
          variant="secondary"
          onPress={() => {
            router.push('/sign-in');
          }}
        />
      ) : null}

      {data !== undefined ? (
        <>
          <BoardFreshness
            fetchedAt={data.fetchedAt}
            stale={data.stale}
            partial={data.partial}
            coverage={data.coverage}
            tz={data.airport.tz}
            prefs={prefs}
            offline={!online}
            nowMs={nowMs}
            testID="board"
          />
          <Section
            title={windowTitle(direction, data.from, data.to, clockIn(data.airport.tz))}
            testID="board-rows"
          >
            {data.rows.length === 0 ? (
              <Body muted testID="board-empty">
                {`No ${direction} in this time range.`}
              </Body>
            ) : (
              data.rows.map((row) => (
                <BoardRow
                  key={row.id}
                  row={row}
                  direction={direction}
                  tz={data.airport.tz}
                  prefs={prefs}
                  adding={rowAdd.addingId === row.id}
                  disabled={rowAdd.addingId !== null}
                  onAdd={(picked) => {
                    rowAdd.confirm(picked, addSummary(picked, direction, shownCode));
                  }}
                />
              ))
            )}
          </Section>
        </>
      ) : !online ? (
        <Notice tone="warning" testID="board-offline">
          You are offline. The board loads when the phone is back online.
        </Notice>
      ) : board.isFetching ? (
        <ActivityIndicator
          testID="board-loading"
          accessibilityLabel="Loading the board"
          color={theme.color.accent}
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  back: { alignSelf: 'flex-start', minHeight: 40 },
  tabs: { flexDirection: 'row' },
  tab: { flexGrow: 1 },
});
