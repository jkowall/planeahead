/**
 * Flight detail (increment 10): the timeline built from the snapshot on the subscription row
 * (ruling T4), the gates and terminals, baggage claim, aircraft and distance in the user's units,
 * the provider attribution (`source`), a refresh with the 8 s deadline UX and unsubscribe.
 *
 * Refresh (ruling T3): pull-to-refresh (or the button) calls `POST /v1/flights/:id/refresh`
 * directly, at most once per gesture: a pull while one is running is ignored. The route answers
 * within its own 8 s deadline, with a 504 `refresh_timeout` carrying the last known flight when
 * the tracker is slow; past 8 s the screen says it is still checking, and past the grace it stops
 * the spinner and says the flight updates when the refresh finishes. The answer's snapshot is
 * applied only when it is not null, a 410 `flight_archived` marks the flight finished here (with
 * or without a flight in the answer), and a 401 `account_deleted` runs the app's one
 * `forgetAccount` path.
 *
 * Unsubscribe tombstones the row at once and queues `DELETE /v1/flights/:id`, or cancels an add
 * that has not been sent yet (src/lib/flights.ts). The screen follows the flight when the server
 * answers an add under its own id (src/lib/flight-queries.ts `useFlight`), so the refresh and the
 * unsubscribe use the id of the row shown, not the route's.
 */

import { DO_CALL_DEADLINE_MS } from '@planeahead/shared';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { StatusPill } from '../../../components/StatusPill';
import { Timeline } from '../../../components/Timeline';
import { Body, Button, Loading, Notice, Screen, Section, Title } from '../../../components/ui';
import { useDisplayPrefs } from '../../../lib/display-prefs';
import { isOver, operatedAs, type FlightItem } from '../../../lib/flight-model';
import { useFlight } from '../../../lib/flight-queries';
import { refreshFlight, removeFlight, type RefreshOutcome } from '../../../lib/flights';
import {
  formatAge,
  formatDay,
  formatDelay,
  formatDistance,
  formatIsoDate,
  localDate,
  providerName,
} from '../../../lib/format';
import { services } from '../../../lib/services';
import { buildTimeline, terminalAndGate } from '../../../lib/timeline';
import { useRefreshGesture } from '../../../lib/use-refresh-gesture';
import { useTheme } from '../../../theme/useTheme';

interface Message {
  readonly text: string;
  readonly tone: 'info' | 'warning' | 'danger';
}

function toneOf(outcome: RefreshOutcome): Message['tone'] {
  switch (outcome.kind) {
    case 'refreshed':
    case 'archived':
      return 'info';
    case 'still_running':
    case 'deadline':
      return 'warning';
    case 'refused':
    case 'offline':
    case 'account_deleted':
      return 'danger';
  }
}

function Row({ label, value, testID }: { label: string; value: string; testID?: string }) {
  const theme = useTheme();
  return (
    <View style={styles.row}>
      <Text style={{ color: theme.color.textMuted, fontSize: theme.font.body }}>{label}</Text>
      <Text
        testID={testID}
        style={[styles.rowValue, { color: theme.color.text, fontSize: theme.font.body }]}
      >
        {value}
      </Text>
    </View>
  );
}

function Details({ item }: { item: FlightItem }) {
  const prefs = useDisplayPrefs();
  const distance = item.snapshot?.routeDistanceKm;
  const destination = terminalAndGate(item.destination.terminal, item.destination.gate);
  const origin = terminalAndGate(item.origin.terminal, item.origin.gate);
  const rows: { label: string; value: string; testID: string }[] = [];
  if (origin !== null) {
    rows.push({ label: 'Departs from', value: origin, testID: 'detail-origin-gate' });
  }
  if (destination !== null) {
    rows.push({ label: 'Arrives at', value: destination, testID: 'detail-destination-gate' });
  }
  if (item.baggageClaim !== null) {
    rows.push({ label: 'Baggage claim', value: item.baggageClaim, testID: 'detail-baggage' });
  }
  if (item.aircraftTypeIcao !== null) {
    rows.push({ label: 'Aircraft', value: item.aircraftTypeIcao, testID: 'detail-aircraft' });
  }
  if (distance !== undefined) {
    rows.push({
      label: 'Distance',
      value: formatDistance(distance, prefs.distanceUnit),
      testID: 'detail-distance',
    });
  }
  if (rows.length === 0) {
    return null;
  }
  return (
    <Section title="Details" testID="detail-details">
      {rows.map((row) => (
        <Row key={row.testID} {...row} />
      ))}
    </Section>
  );
}

export default function FlightDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = typeof params.id === 'string' ? params.id : '';
  const router = useRouter();
  const theme = useTheme();
  const prefs = useDisplayPrefs();
  const { data: item, error } = useFlight(id);
  const [message, setMessage] = useState<Message | null>(null);
  const [slow, setSlow] = useState(false);

  const shownId = item?.id ?? id;
  const gesture = useRefreshGesture(async () => {
    setMessage(null);
    const { store, api, onAccountDeleted } = await services();
    const outcome = await refreshFlight({ db: store.sqlite, api, onAccountDeleted }, shownId);
    setMessage({ text: outcome.message, tone: toneOf(outcome) });
  });

  // The 8 s deadline UX: past the route's deadline, say it is still checking.
  useEffect(() => {
    if (!gesture.refreshing) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => {
      setSlow(true);
    }, DO_CALL_DEADLINE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [gesture.refreshing]);

  if (item === undefined && error === undefined) {
    return <Loading label="Loading the flight" />;
  }
  if (item === null || item === undefined) {
    return (
      <Screen testID="flight-detail-missing">
        <Title>Flight not found</Title>
        <Body muted>This flight is no longer in your list.</Body>
        <Button
          testID="detail-back"
          title="Back"
          variant="secondary"
          onPress={() => {
            router.back();
          }}
        />
      </Screen>
    );
  }

  const nowMs = Date.now();
  const over = isOver(item, nowMs);
  const canRefresh = !item.pending && item.finishedAt === null;
  const steps = buildTimeline(item);
  const route =
    item.origin.code !== null && item.destination.code !== null
      ? `${item.origin.code} → ${item.destination.code}`
      : null;
  const date =
    item.scheduledOut !== null
      ? formatDay(item.scheduledOut, prefs.zoneFor(item.origin.tz))
      : item.dateLocal === null
        ? ''
        : formatIsoDate(item.dateLocal);
  const source = providerName(item.snapshotSource);
  const age = formatAge(item.snapshotFetchedAt, nowMs);
  const departureDelay = formatDelay(item.departureDelaySec);
  const arrivalDelay = formatDelay(item.arrivalDelaySec);
  const operated = operatedAs(item);
  // The header's date, as the timeline's day cues count from it.
  const scheduledOutMs = item.scheduledOut === null ? Number.NaN : Date.parse(item.scheduledOut);
  const departureDate = Number.isNaN(scheduledOutMs)
    ? item.dateLocal
    : localDate(scheduledOutMs, prefs.zoneFor(item.origin.tz));

  const confirmRemove = () => {
    Alert.alert(
      `Stop tracking ${item.designator}?`,
      'It is removed from your list on every device.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Stop tracking',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              const { store, outbox } = await services();
              removeFlight(store.sqlite, item.id);
              router.back();
              await outbox.drain();
            })();
          },
        },
      ],
    );
  };

  return (
    <Screen
      testID="flight-detail"
      {...(canRefresh
        ? {
            refreshControl: (
              <RefreshControl
                refreshing={gesture.refreshing}
                onRefresh={() => {
                  gesture.onRefresh();
                }}
                tintColor={theme.color.accent}
                colors={[theme.color.accent]}
              />
            ),
          }
        : {})}
    >
      <Button
        testID="detail-back"
        title="Back"
        variant="secondary"
        style={styles.back}
        onPress={() => {
          router.back();
        }}
      />
      <View style={[styles.header, { gap: theme.space.xs }]}>
        <View style={styles.titleLine}>
          <Title>{item.designator}</Title>
          <StatusPill status={item.status} pending={item.pending} testID="detail-status" />
        </View>
        {operated === null ? null : (
          <Text
            testID="detail-operated-as"
            style={{ color: theme.color.textMuted, fontSize: theme.font.body }}
          >
            {operated}
          </Text>
        )}
        <Text style={{ color: theme.color.text, fontSize: theme.font.heading }}>
          {route ?? 'Looking up the flight'}
        </Text>
        <Text style={{ color: theme.color.textMuted, fontSize: theme.font.body }}>
          {[date, item.label].filter((part) => part !== null && part !== '').join(', ')}
        </Text>
        {departureDelay === null || departureDelay === 'on time' ? null : (
          <Text
            style={{ color: theme.color.warning, fontSize: theme.font.body, fontWeight: '600' }}
          >
            {`Departure ${departureDelay}`}
            {arrivalDelay === null ? '' : `, arrival ${arrivalDelay}`}
          </Text>
        )}
      </View>

      {item.pending ? (
        <Notice tone="info" testID="detail-pending">
          Adding this flight. Its times appear here once it has been found.
        </Notice>
      ) : null}
      {over ? (
        <Notice tone="info" testID="detail-over">
          {item.finishedAt !== null
            ? 'This flight is over and no longer tracked.'
            : 'This flight is over.'}
        </Notice>
      ) : null}
      {gesture.refreshing ? (
        <Notice tone="info" testID="detail-refreshing">
          {slow ? 'Still checking with the flight data provider…' : 'Refreshing…'}
        </Notice>
      ) : message === null ? null : (
        <Notice
          tone={message.tone}
          testID="detail-message"
          onDismiss={() => {
            setMessage(null);
          }}
        >
          {message.text}
        </Notice>
      )}

      <Section title="Timeline" testID="detail-timeline-section">
        <Timeline steps={steps} prefs={prefs} departureDate={departureDate} />
      </Section>

      <Details item={item} />

      {source === null ? null : (
        <Body muted testID="detail-attribution">
          {`Flight data: ${source}${age === null ? '' : `, updated ${age}`}. Times are ${
            prefs.timeFormat === '24h' ? '24-hour' : '12-hour'
          }, ${
            item.origin.tz !== null && prefs.zoneFor(item.origin.tz) !== undefined
              ? 'local to each airport'
              : 'in this phone’s time zone'
          }.`}
        </Body>
      )}
      {item.snapshot === null && !item.pending ? (
        <Body muted testID="detail-no-snapshot">
          No flight data yet. It appears after the next sync.
        </Body>
      ) : null}

      {canRefresh ? (
        <Button
          testID="detail-refresh"
          title="Refresh"
          variant="secondary"
          busy={gesture.refreshing}
          onPress={() => {
            gesture.onRefresh();
          }}
        />
      ) : null}
      <Button
        testID="detail-remove"
        title="Stop tracking this flight"
        variant="danger"
        onPress={confirmRemove}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  back: { alignSelf: 'flex-start', minHeight: 40 },
  header: { flexShrink: 0 },
  titleLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  rowValue: { fontWeight: '600', flexShrink: 1, textAlign: 'right' },
});
