/**
 * One flight on an airport board or in the route-search results (increment 18, ruling B12): the
 * home leg's scheduled time in the airport's zone, the expected or actual time when there is one
 * (labelled cautiously: the provider's revised time may be a gate or a runway time, R3 F8 and
 * D13), the designator and the other designators it is sold as, the other airport, the status, and
 * the terminal and gate. As FlightCard's rows, each row is one button whose label carries all of
 * it; a row without an origin-local date (no `add`) cannot be added and is disabled.
 */

import type { BoardDirection, BoardViewRow } from '@planeahead/shared';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { DisplayPrefs } from '../lib/display-prefs';
import { formatClock, statusLabel } from '../lib/format';
import { terminalAndGate } from '../lib/timeline';
import { useTheme } from '../theme/useTheme';
import { StatusPill } from './StatusPill';

export interface BoardRowText {
  /** `14:05`: the home leg's scheduled time. */
  readonly scheduled: string;
  /** `Expected 14:20`, `Departed 14:22`, `Landed 06:58`, or null when there is nothing else. */
  readonly later: string | null;
  /** The best time is after the scheduled one. */
  readonly late: boolean;
  /** `to JFK` on departures, `from JFK` on arrivals. */
  readonly counterpart: string;
  /** `Terminal 5, gate B32. Also IB4218, AA6135`, or empty. */
  readonly detail: string;
  readonly label: string;
}

function join(parts: readonly (string | null)[], separator = ', '): string {
  return parts.filter((part): part is string => part !== null && part !== '').join(separator);
}

function minuteOf(iso: string | undefined): number | null {
  if (iso === undefined) {
    return null;
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : Math.floor(ms / 60_000);
}

export function boardRowText(
  row: BoardViewRow,
  direction: BoardDirection,
  tz: string,
  prefs: DisplayPrefs,
): BoardRowText {
  const clock = (iso: string) =>
    formatClock(iso, { timeFormat: prefs.timeFormat, timeZone: prefs.zoneFor(tz) });
  const scheduledMinute = minuteOf(row.scheduled);
  const actualWord = direction === 'departures' ? 'Departed' : 'Landed';
  const estimatedDiffers =
    row.estimated !== undefined && minuteOf(row.estimated) !== scheduledMinute;
  const best = row.actual ?? (estimatedDiffers ? row.estimated : undefined);
  const laterWord = row.actual !== undefined ? actualWord : 'Expected';
  const later = best === undefined ? null : `${laterWord} ${clock(best)}`;
  const bestMinute = minuteOf(best);
  const late = bestMinute !== null && scheduledMinute !== null && bestMinute > scheduledMinute;
  const airport = row.counterpart.iata ?? row.counterpart.icao;
  const counterpart = `${direction === 'departures' ? 'to' : 'from'} ${airport}`;
  const place = terminalAndGate(row.terminal ?? null, row.gate ?? null);
  const also = row.codeshares.length === 0 ? null : `Also ${row.codeshares.join(', ')}`;
  const label = join([
    row.designator,
    counterpart,
    `scheduled ${clock(row.scheduled)}`,
    best === undefined ? null : `${laterWord.toLowerCase()} ${clock(best)}`,
    `status ${statusLabel(row.status)}`,
    place,
    also === null ? null : `also sold as ${row.codeshares.join(', ')}`,
    row.add === undefined ? 'cannot be added here' : null,
  ]);
  return {
    scheduled: clock(row.scheduled),
    later,
    late,
    counterpart,
    detail: join([place, also], '. '),
    label,
  };
}

export interface BoardRowProps {
  readonly row: BoardViewRow;
  readonly direction: BoardDirection;
  /** The board airport's IANA zone: the home leg's times are shown in it. */
  readonly tz: string;
  readonly prefs: DisplayPrefs;
  /** This row's add is running. */
  readonly adding: boolean;
  /** Another add is running: one at a time per screen. */
  readonly disabled: boolean;
  readonly onAdd: (row: BoardViewRow) => void;
}

export function BoardRow({ row, direction, tz, prefs, adding, disabled, onAdd }: BoardRowProps) {
  const theme = useTheme();
  const text = boardRowText(row, direction, tz, prefs);
  const inert = row.add === undefined || disabled || adding;
  return (
    <Pressable
      testID={`board-row-${row.id}`}
      accessibilityRole="button"
      accessibilityLabel={text.label}
      {...(row.add === undefined ? {} : { accessibilityHint: 'Adds this flight to your list' })}
      accessibilityState={{ disabled: inert, ...(adding ? { busy: true } : {}) }}
      disabled={inert}
      onPress={() => {
        onAdd(row);
      }}
      style={({ pressed }) => [
        styles.row,
        {
          borderColor: theme.color.border,
          paddingVertical: theme.space.md,
          gap: theme.space.xs,
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      <View style={[styles.line, { gap: theme.space.md }]}>
        <Text style={[styles.time, { color: theme.color.text, fontSize: theme.font.heading }]}>
          {text.scheduled}
        </Text>
        <Text style={[styles.strong, { color: theme.color.text, fontSize: theme.font.body }]}>
          {`${row.designator}  ${text.counterpart}`}
        </Text>
        <StatusPill status={row.status} testID={`board-row-${row.id}-status`} />
      </View>
      {text.later === null && !adding ? null : (
        <Text
          style={{
            color: text.late ? theme.color.warning : theme.color.textMuted,
            fontSize: theme.font.small + 1,
            fontWeight: '600',
          }}
        >
          {adding ? 'Adding…' : text.later}
        </Text>
      )}
      {text.detail === '' ? null : (
        <Text style={{ color: theme.color.textMuted, fontSize: theme.font.small + 1 }}>
          {text.detail}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { borderBottomWidth: StyleSheet.hairlineWidth },
  line: { flexDirection: 'row', alignItems: 'center' },
  time: { fontWeight: '700', fontVariant: ['tabular-nums'] },
  strong: { fontWeight: '700', flex: 1, flexShrink: 1 },
});
