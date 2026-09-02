import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { palette, radii, spacing, type } from '../../theme';
import { useAppDispatch, useAppSelector } from '../../store';
import {
  dateChanged,
  selectSuggestions,
  selectSuggestionsEnabled,
  selectSuggestionsError,
  selectSuggestionsStatus,
  suggestionDismissed,
  suggestionRestored,
  suggestionsDisabled,
  suggestionsFailed,
  suggestionsLoaded,
  suggestionsLoading,
} from '../../store/timeSuggestionsSlice';
import {
  getSuggestions,
  dismissSuggestion,
  undismissSuggestion,
  type TimeSuggestion,
} from '../../services/timeSuggestions';
import { classifyDrainOutcome, suggestionDedupeKey } from '../../services/timeSuggestionDrain';
import { enqueue } from '../../services/timeEntryQueue';
import { Toast } from '../../components/Toast';
import { reportInternalError } from '../../lib/errorReporting';
import { track } from '../../lib/analytics';

import { alreadyLoggedNote, precisionChip, rowSummary, ticketChipLabel } from './timeSuggestionCopy';
import { SuggestionConfirmSheet } from './SuggestionConfirmSheet';

function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function todayIn(timeZone: string): string {
  // en-CA renders YYYY-MM-DD, which is exactly the shape the API wants.
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
}

interface Props {
  route?: { params?: { date?: string } };
}

export function TimeSuggestionsScreen({ route }: Props): React.JSX.Element {
  const dispatch = useAppDispatch();
  const timeZone = useMemo(deviceTimeZone, []);
  const [date, setDate] = useState(() => route?.params?.date ?? todayIn(timeZone));
  const suggestions = useAppSelector(selectSuggestions);
  const enabled = useAppSelector(selectSuggestionsEnabled);
  const status = useAppSelector(selectSuggestionsStatus);
  const error = useAppSelector(selectSuggestionsError);
  const [toast, setToast] = useState<string | null>(null);
  const [toastKind, setToastKind] = useState<'success' | 'error'>('success');
  const [confirming, setConfirming] = useState<TimeSuggestion | null>(null);
  const [undo, setUndo] = useState<{ suggestion: TimeSuggestion; index: number } | null>(null);

  const load = useCallback(async () => {
    dispatch(suggestionsLoading());
    try {
      dispatch(suggestionsLoaded(await getSuggestions(date, timeZone)));
    } catch (err) {
      // F10: a 403 means the partner turned the feature off — collapse the day
      // rather than leaving stale rows the API will refuse.
      const status = (err as { status?: number }).status;
      if (status === 403) {
        dispatch(suggestionsDisabled());
        return;
      }
      dispatch(suggestionsFailed(err instanceof Error ? err.message : 'Could not load suggestions'));
    }
  }, [date, dispatch, timeZone]);

  useEffect(() => {
    dispatch(dateChanged(date));
    void load();
  }, [date, dispatch, load]);

  useEffect(() => {
    if (suggestions.length > 0) track('time_suggestion_shown', { count: suggestions.length });
  }, [suggestions.length]);

  const onDismiss = useCallback(
    async (suggestion: TimeSuggestion, index: number) => {
      dispatch(suggestionDismissed(suggestion.key));
      setUndo({ suggestion, index });
      track('time_suggestion_dismissed', {});
      const signals = suggestion.signals.map((signal) => ({ kind: signal.kind, id: signal.id }));
      try {
        await dismissSuggestion(signals);
      } catch (err) {
        const outcome = classifyDrainOutcome((err as { status?: number }).status);
        if (outcome === 'retry') {
          // Offline: hand it to the queue rather than losing the intent. The
          // row stays hidden — the technician has decided.
          await enqueue({
            kind: 'suggestion.dismiss',
            payload: { signals },
            dedupeKey: suggestionDedupeKey('dismiss', signals),
          }).catch((queueError: unknown) => reportInternalError(queueError, 'timeSuggestions.dismiss'));
          return;
        }
        if (outcome === 'dropAndDisable') {
          dispatch(suggestionsDisabled());
          return;
        }
        // The server refused for a reason a retry cannot fix. Put the row back
        // so the technician is not left believing a dismiss landed.
        dispatch(suggestionRestored({ suggestion, index }));
        setUndo(null);
        setToastKind('error');
        setToast('Could not dismiss that session');
      }
    },
    [dispatch]
  );

  const onUndo = useCallback(async () => {
    if (undo === null) return;
    const { suggestion, index } = undo;
    setUndo(null);
    dispatch(suggestionRestored({ suggestion, index }));
    try {
      await undismissSuggestion(suggestion.signals.map((s) => ({ kind: s.kind, id: s.id })));
    } catch (err) {
      reportInternalError(err, 'timeSuggestions.undismiss');
      setToastKind('error');
      setToast('Undo did not reach the server — pull to refresh');
    }
  }, [dispatch, undo]);

  if (!enabled && status === 'ready') {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>Session suggestions are off</Text>
        <Text style={styles.emptyBody}>
          A partner admin can turn them on under Settings → Time tracking.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable onPress={() => setDate(shiftDate(date, -1))} hitSlop={8}>
          <Text style={styles.navArrow}>‹</Text>
        </Pressable>
        <Text style={styles.headerTitle}>{headerLabel(date, timeZone)}</Text>
        <Pressable
          onPress={() => setDate(shiftDate(date, 1))}
          hitSlop={8}
          disabled={date >= todayIn(timeZone)}
        >
          <Text style={[styles.navArrow, date >= todayIn(timeZone) && styles.navArrowOff]}>›</Text>
        </Pressable>
      </View>

      {status === 'loading' && suggestions.length === 0 ? (
        <ActivityIndicator style={styles.spinner} color={palette.dark.textLo} />
      ) : null}

      {error !== null ? <Text style={styles.error}>{error}</Text> : null}

      <ScrollView contentContainerStyle={styles.list}>
        {suggestions.length === 0 && status === 'ready' ? (
          <Text style={styles.emptyBody}>Nothing unlogged for this day.</Text>
        ) : null}

        {suggestions.map((suggestion, index) => {
          const note = alreadyLoggedNote(suggestion.alreadyLoggedOverlapMinutes);
          const chip = precisionChip(suggestion.signals[0]?.precision ?? '');
          return (
            <View key={suggestion.key} style={styles.row}>
              <Text style={styles.rowSummary}>{rowSummary(suggestion, timeZone)}</Text>
              <View style={styles.chips}>
                {chip !== null ? <Text style={styles.chip}>{chip}</Text> : null}
                <Text style={styles.chip}>{ticketChipLabel(suggestion)}</Text>
              </View>
              {note !== null ? <Text style={styles.note}>{note}</Text> : null}
              <View style={styles.actions}>
                <Pressable style={styles.confirm} onPress={() => setConfirming(suggestion)}>
                  <Text style={styles.confirmText}>Log this</Text>
                </Pressable>
                <Pressable style={styles.dismiss} onPress={() => void onDismiss(suggestion, index)}>
                  <Text style={styles.dismissText}>Dismiss</Text>
                </Pressable>
              </View>
            </View>
          );
        })}
      </ScrollView>

      {confirming !== null ? (
        <SuggestionConfirmSheet
          suggestion={confirming}
          timeZone={timeZone}
          onClose={() => setConfirming(null)}
          onLogged={(message) => {
            setConfirming(null);
            setToastKind('success');
            setToast(message);
          }}
        />
      ) : null}

      {undo !== null ? (
        <Pressable style={styles.undo} onPress={() => void onUndo()}>
          <Text style={styles.undoText}>Session dismissed · Undo</Text>
        </Pressable>
      ) : null}

      <Toast
        visible={toast !== null}
        text={toast ?? ''}
        kind={toastKind}
        onHidden={() => setToast(null)}
      />
    </View>
  );
}

function shiftDate(date: string, days: number): string {
  const shifted = new Date(`${date}T12:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function headerLabel(date: string, timeZone: string): string {
  const today = todayIn(timeZone);
  if (date === today) return 'Today';
  if (date === shiftDate(today, -1)) return 'Yesterday';
  return date;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.dark.bg0 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing['4'],
    paddingVertical: spacing['3'],
    borderBottomWidth: 1,
    borderBottomColor: palette.dark.border,
  },
  headerTitle: { ...type.bodyMd, color: palette.dark.textHi },
  navArrow: { ...type.title, color: palette.dark.textHi, paddingHorizontal: spacing['3'] },
  navArrowOff: { color: palette.dark.textLo, opacity: 0.4 },
  spinner: { marginTop: spacing['8'] },
  error: { ...type.meta, color: palette.deny.base, paddingHorizontal: spacing['4'], paddingTop: spacing['2'] },
  list: { padding: spacing['4'], gap: spacing['3'], paddingBottom: spacing['10'] },
  row: {
    backgroundColor: palette.dark.bg1,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.dark.border,
    padding: spacing['3'],
    gap: spacing['2'],
  },
  rowSummary: { ...type.bodyMd, color: palette.dark.textHi },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing['2'] },
  chip: {
    ...type.meta,
    color: palette.dark.textMd,
    borderWidth: 1,
    borderColor: palette.dark.border,
    borderRadius: radii.full,
    paddingHorizontal: spacing['3'],
    paddingVertical: spacing['1'],
  },
  note: { ...type.meta, color: palette.warning.base },
  actions: { flexDirection: 'row', gap: spacing['2'], marginTop: spacing['1'] },
  confirm: {
    backgroundColor: palette.brand.deep,
    borderWidth: 1,
    borderColor: palette.brand.base,
    borderRadius: radii.full,
    paddingHorizontal: spacing['4'],
    paddingVertical: spacing['2'],
  },
  confirmText: { ...type.meta, color: palette.dark.textHi },
  dismiss: {
    borderWidth: 1,
    borderColor: palette.dark.border,
    borderRadius: radii.full,
    paddingHorizontal: spacing['4'],
    paddingVertical: spacing['2'],
  },
  dismissText: { ...type.meta, color: palette.dark.textMd },
  undo: {
    position: 'absolute',
    left: spacing['4'],
    right: spacing['4'],
    bottom: spacing['8'],
    backgroundColor: palette.dark.bg1,
    borderWidth: 1,
    borderColor: palette.dark.border,
    borderRadius: radii.md,
    padding: spacing['3'],
    alignItems: 'center',
  },
  undoText: { ...type.meta, color: palette.dark.textHi },
  empty: {
    flex: 1,
    backgroundColor: palette.dark.bg0,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing['6'],
    gap: spacing['2'],
  },
  emptyTitle: { ...type.bodyMd, color: palette.dark.textHi },
  emptyBody: { ...type.meta, color: palette.dark.textLo, textAlign: 'center' },
});
