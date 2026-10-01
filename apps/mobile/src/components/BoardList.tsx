/**
 * The rows of an airport board or a route search as one virtualised list (increment 18, R13): a
 * hub's twelve hours are 600 to 700 rows, so the screen scrolls a FlatList that mounts only the
 * rows near the screen, keyed by the row id, each a memoised `BoardRow`, instead of a ScrollView
 * that mounts them all. Everything above the rows is the list's header, spaced as `Screen` spaces
 * its children. The rows sit in the card a `Section` draws, built in three parts so the rows stay
 * list items: the card's top with the title (the header's end), one edge per row, and its bottom
 * (the footer).
 */

import type { BoardDirection, BoardViewRow } from '@planeahead/shared';
import { useCallback, useMemo, type ReactElement } from 'react';
import {
  FlatList,
  StyleSheet,
  Text,
  View,
  type ListRenderItem,
  type RefreshControlProps,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { DisplayPrefs } from '../lib/display-prefs';
import { useTheme } from '../theme/useTheme';
import { BoardRow } from './BoardRow';

export interface BoardListSection {
  readonly title: string;
  /** The card's test id. */
  readonly testID: string;
  readonly rows: readonly BoardViewRow[];
  /** What the card says when there are no rows. */
  readonly empty: ReactElement;
}

export interface BoardListProps {
  /** The list's test id: the screen's. */
  readonly testID: string;
  /** Everything above the rows. */
  readonly header: ReactElement;
  /** The answer's rows under their title, or null while there is no answer. */
  readonly section: BoardListSection | null;
  /** Under the header while there is no answer: offline, or loading. */
  readonly placeholder: ReactElement | null;
  readonly direction: BoardDirection;
  /** The answer's airport zone, which the rows' times are shown in. */
  readonly tz: string;
  readonly prefs: DisplayPrefs;
  /** The row whose add is running, or null: one add at a time. */
  readonly addingId: string | null;
  /** Kept stable by the screen, so a memoised row renders again only when its own props change. */
  readonly onAdd: (row: BoardViewRow) => void;
  readonly refreshControl: ReactElement<RefreshControlProps>;
}

const NO_ROWS: readonly BoardViewRow[] = [];

const rowKey = (row: BoardViewRow): string => row.id;

export function BoardList(props: BoardListProps) {
  const { testID, header, section, placeholder, direction, tz, prefs, addingId, onAdd } = props;
  const theme = useTheme();
  const edge = useMemo(
    () => [
      styles.edge,
      {
        backgroundColor: theme.color.surface,
        borderColor: theme.color.border,
        paddingHorizontal: theme.space.lg,
      },
    ],
    [theme],
  );
  const renderRow = useCallback<ListRenderItem<BoardViewRow>>(
    ({ item }) => (
      <View style={edge}>
        <BoardRow
          row={item}
          direction={direction}
          tz={tz}
          prefs={prefs}
          adding={addingId === item.id}
          disabled={addingId !== null}
          onAdd={onAdd}
        />
      </View>
    ),
    [edge, direction, tz, prefs, addingId, onAdd],
  );
  const radius = theme.radius.lg - 2;
  const top =
    section === null ? null : (
      <View
        testID={section.testID}
        style={[
          edge,
          styles.top,
          {
            borderTopLeftRadius: radius,
            borderTopRightRadius: radius,
            paddingTop: theme.space.lg,
            paddingBottom: theme.space.md,
          },
        ]}
      >
        <Text style={[styles.title, { color: theme.color.textMuted, fontSize: theme.font.small }]}>
          {section.title}
        </Text>
      </View>
    );
  const bottom = [
    edge,
    styles.bottom,
    {
      borderBottomLeftRadius: radius,
      borderBottomRightRadius: radius,
      paddingBottom: theme.space.lg,
    },
  ];
  return (
    <SafeAreaView style={[styles.fill, { backgroundColor: theme.color.background }]}>
      <FlatList
        testID={testID}
        data={section?.rows ?? NO_ROWS}
        keyExtractor={rowKey}
        renderItem={renderRow}
        refreshControl={props.refreshControl}
        contentContainerStyle={{ padding: theme.space.xl - 4 }}
        ListHeaderComponent={
          <View style={{ gap: theme.space.lg }}>
            {header}
            {top ?? placeholder}
          </View>
        }
        ListEmptyComponent={section === null ? null : <View style={edge}>{section.empty}</View>}
        ListFooterComponent={section === null ? null : <View style={bottom} />}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  edge: { borderLeftWidth: StyleSheet.hairlineWidth, borderRightWidth: StyleSheet.hairlineWidth },
  top: { borderTopWidth: StyleSheet.hairlineWidth },
  bottom: { borderBottomWidth: StyleSheet.hairlineWidth },
  title: { fontWeight: '600', textTransform: 'uppercase' },
});
