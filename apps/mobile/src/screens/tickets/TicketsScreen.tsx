import { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { palette, radii, spacing, type } from '../../theme';
import { useAppDispatch, useAppSelector } from '../../store';
import {
  fetchTickets,
  selectTicketAssignee,
  selectTicketQueue,
  selectTickets,
  selectTicketsError,
  selectTicketsLoading,
  setAssignee,
  setQueue,
} from '../../store/ticketsSlice';
import type { TicketSummary } from '../../services/tickets';
import type { TicketsStackParamList } from '../../navigation/MainNavigator';
import { relativeTime } from '../../lib/relativeTime';

import {
  emptyStateCopy,
  emptyStateKind,
  isBreached,
  priorityColor,
  priorityLabel,
  statusLabel,
  ticketRef,
} from './ticketCopy';

type Nav = NativeStackNavigationProp<TicketsStackParamList, 'Tickets'>;

function Chip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={[styles.chip, active && styles.chipActive]}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

function TicketRow({ ticket, onPress }: { ticket: TicketSummary; onPress: () => void }) {
  const breached = isBreached(ticket);
  const ref = ticketRef(ticket);
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={styles.row}>
      <View style={styles.rowHeader}>
        {ref ? <Text style={styles.ref}>{ref}</Text> : null}
        <View style={[styles.priorityDot, { backgroundColor: priorityColor(ticket.priority) }]} />
        <Text style={styles.priority}>{priorityLabel(ticket.priority)}</Text>
        {breached ? <Text style={styles.breach}>SLA</Text> : null}
      </View>
      <Text style={styles.subject} numberOfLines={2}>
        {ticket.subject}
      </Text>
      <View style={styles.rowMeta}>
        <Text style={styles.meta} numberOfLines={1}>
          {statusLabel(ticket)}
          {ticket.orgName ? ` · ${ticket.orgName}` : ''}
        </Text>
        <Text style={styles.metaDim}>{relativeTime(ticket.updatedAt)}</Text>
      </View>
    </Pressable>
  );
}

export function TicketsScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const dispatch = useAppDispatch();

  const tickets = useAppSelector(selectTickets);
  const loading = useAppSelector(selectTicketsLoading);
  const error = useAppSelector(selectTicketsError);
  const queue = useAppSelector(selectTicketQueue);
  const assignee = useAppSelector(selectTicketAssignee);

  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(() => {
    return dispatch(fetchTickets({ statusGroup: queue, assignee }));
  }, [dispatch, queue, assignee]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  const empty = emptyStateCopy(queue, assignee);
  const emptyKind = emptyStateKind(loading, error);

  return (
    <View style={[styles.screen, { paddingTop: insets.top + spacing['3'] }]}>
      <Text style={styles.title}>Tickets</Text>

      <View style={styles.filters}>
        <Chip label="Open" active={queue === 'open'} onPress={() => dispatch(setQueue('open'))} />
        <Chip
          label="Closed"
          active={queue === 'closed'}
          onPress={() => dispatch(setQueue('closed'))}
        />
        <View style={styles.filterSpacer} />
        <Chip label="Mine" active={assignee === 'me'} onPress={() => dispatch(setAssignee('me'))} />
        <Chip label="All" active={assignee === 'all'} onPress={() => dispatch(setAssignee('all'))} />
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <FlatList
        data={tickets}
        keyExtractor={(t) => t.id}
        renderItem={({ item }) => (
          <TicketRow
            ticket={item}
            onPress={() => navigation.navigate('TicketDetail', { ticketId: item.id })}
          />
        )}
        contentContainerStyle={[
          styles.listContent,
          tickets.length === 0 && styles.listContentEmpty,
        ]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={palette.dark.textLo}
          />
        }
        ListEmptyComponent={
          // Gated on `error` as well as `loading`. A rejected fetch leaves
          // `tickets` empty, so gating on `loading` alone rendered the error
          // line and, directly beneath it, "The open queue is clear" — two
          // contradictory statements in one viewport, the reassuring one of
          // which is wrong. A tech skimming past the error acts on it.
          emptyKind === 'none' ? undefined : emptyKind === 'error' ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>Couldn&apos;t load tickets</Text>
              <Text style={styles.emptyBody}>
                The queue could not be reached, so this list is not a picture of what is open.
              </Text>
              <Pressable onPress={() => void load()} accessibilityRole="button" style={styles.retry}>
                <Text style={styles.retryText}>Try again</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>{empty.title}</Text>
              <Text style={styles.emptyBody}>{empty.body}</Text>
            </View>
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.dark.bg0 },
  title: { ...type.title, color: palette.dark.textHi, paddingHorizontal: spacing['4'] },
  filters: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing['2'],
    paddingHorizontal: spacing['4'],
    paddingVertical: spacing['3'],
  },
  filterSpacer: { flex: 1 },
  chip: {
    paddingHorizontal: spacing['3'],
    paddingVertical: spacing['1'],
    borderRadius: radii.full,
    borderWidth: 1,
    borderColor: palette.dark.border,
    backgroundColor: palette.dark.bg1,
  },
  chipActive: { backgroundColor: palette.brand.deep, borderColor: palette.brand.base },
  chipText: { ...type.meta, color: palette.dark.textMd },
  chipTextActive: { color: palette.dark.textHi },
  listContent: { paddingHorizontal: spacing['4'], paddingBottom: spacing['8'] },
  listContentEmpty: { flexGrow: 1, justifyContent: 'center' },
  row: {
    backgroundColor: palette.dark.bg1,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.dark.border,
    padding: spacing['3'],
    marginBottom: spacing['2'],
  },
  rowHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing['2'] },
  ref: { ...type.monoMd, color: palette.dark.textMd },
  priorityDot: { width: 8, height: 8, borderRadius: radii.full },
  priority: { ...type.meta, color: palette.dark.textMd },
  breach: { ...type.metaCaps, color: palette.deny.base },
  subject: { ...type.bodyMd, color: palette.dark.textHi, marginTop: spacing['2'] },
  rowMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing['2'],
    gap: spacing['2'],
  },
  meta: { ...type.meta, color: palette.dark.textMd, flexShrink: 1 },
  metaDim: { ...type.meta, color: palette.dark.textLo },
  error: {
    ...type.meta,
    color: palette.deny.base,
    paddingHorizontal: spacing['4'],
    paddingBottom: spacing['2'],
  },
  empty: { alignItems: 'center', paddingHorizontal: spacing['6'] },
  emptyTitle: { ...type.bodyMd, color: palette.dark.textHi },
  emptyBody: { ...type.meta, color: palette.dark.textLo, marginTop: spacing['1'], textAlign: 'center' },
  // Mirrors TicketDetailScreen's retry affordance so the two error states look
  // and behave the same.
  retry: {
    marginTop: spacing['4'],
    paddingHorizontal: spacing['4'],
    paddingVertical: spacing['2'],
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.dark.border,
  },
  retryText: { ...type.meta, color: palette.dark.textHi },
});
