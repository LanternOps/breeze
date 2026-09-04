import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';

import { palette, radii, spacing, type } from '../../theme';
import { useAppDispatch, useAppSelector } from '../../store';
import { timeAccessDenied } from '../../store/timeSlice';
import {
  getTimesheet,
  updateTimeEntry,
  type TimeEntry,
  type TimesheetWeek,
} from '../../services/timeEntries';
import { classifyTimeEntryDenial, isAccountLevelDenial } from '../../services/timeEntryAccess';
import { Toast } from '../../components/Toast';
import { formatMinutes } from '../../lib/timeFormat';
import { reportInternalError } from '../../lib/errorReporting';
import { ticketRef } from '../tickets/ticketCopy';

import { dayLabel, daysOfWeek, shiftWeek, weekRangeLabel, weekStartFor } from './timesheetWeek';
import { entryLock } from './entryLock';
import { bannerLabel, entryPointVisible } from './timeSuggestionCopy';
import { getSuggestions } from '../../services/timeSuggestions';
import { suggestionsLoaded } from '../../store/timeSuggestionsSlice';
import { selectSuggestionsEnabled, selectUnloggedCount } from '../../store/timeSuggestionsSlice';
import { track } from '../../lib/analytics';
import { buildLocalWeek, neighbourWeekOffsets } from './timesheetLocalDays';
import { entriesForWeek, timesheetPhase, type LoadedWeek } from './timesheetLoadState';

function flattenWeek(week: TimesheetWeek | null): TimeEntry[] {
  return week?.days.flatMap((day) => day.entries) ?? [];
}

function startTimeLabel(startedAt: string): string {
  const date = new Date(startedAt);
  if (Number.isNaN(date.getTime())) return '';
  const hours = date.getHours();
  const minutes = date.getMinutes();
  return `${hours < 10 ? `0${hours}` : hours}:${minutes < 10 ? `0${minutes}` : minutes}`;
}

interface TimesheetProps {
  navigation?: { navigate: (screen: string, params?: Record<string, unknown>) => void };
}

export function TimesheetScreen({ navigation }: TimesheetProps = {}) {
  // TimeStack mounts this screen with `headerShown: false`, so nothing above it
  // reserves the status bar: without this the week bar draws at y=0 and the
  // Dynamic Island bisects the week title while the clock and the battery icons
  // sit on top of the two week chevrons. Same inset and same gap as
  // TicketsScreen so the Time tab starts on the line the Tickets tab does.
  const insets = useSafeAreaInsets();
  const dispatch = useAppDispatch();
  const suggestionsEnabled = useAppSelector(selectSuggestionsEnabled);
  const unloggedCount = useAppSelector(selectUnloggedCount);
  // W06 (#3900). `entryPointVisible` is the single rule for whether any
  // suggestion surface shows at all — a disabled partner or an empty day must
  // not advertise a screen whose actions the API refuses.
  const suggestionsBannerVisible = entryPointVisible({
    enabled: suggestionsEnabled,
    count: unloggedCount,
  });

  // Cheap: one call per mount, only to decide whether the banner shows. A
  // failure is deliberately silent — the banner is an affordance, and a red
  // error on the timesheet because an optional count did not load would be
  // worse than simply not offering the shortcut.
  useEffect(() => {
    let cancelled = false;
    const timeZone = (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      } catch {
        return 'UTC';
      }
    })();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
    void getSuggestions(today, timeZone)
      .then((result) => {
        if (!cancelled) dispatch(suggestionsLoaded(result));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [dispatch]);
  const tickets = useAppSelector((state) => state.tickets.tickets);
  // Set once by whichever time surface hit the wall first; a denied account
  // should never see an empty timesheet that looks like "no work logged".
  const denial = useAppSelector((state) => state.time.denial);

  const [weekStart, setWeekStart] = useState(() => weekStartFor(new Date()));
  /**
   * Raw entries rather than the server's day buckets (those are keyed by UTC
   * while this screen's week, day rows and start-time labels are all local),
   * TAGGED with the week they were loaded for.
   *
   * The tag is what makes a failed load visible: without it, entries from the
   * previously-shown week survived a failure on the new one, `entries !== null`
   * kept the error branch unreachable, and `buildLocalWeek` filtered every row
   * out — rendering a confident empty week with a 0m total for what was
   * actually a network failure.
   */
  const [loaded, setLoaded] = useState<LoadedWeek | null>(null);
  /** The overlapping neighbour week could not be fetched; boundary rows are missing. */
  const [boundaryIncomplete, setBoundaryIncomplete] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftDescription, setDraftDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const mounted = useRef(true);
  const saveInFlight = useRef(false);
  // Only the newest load may publish: two week changes in quick succession can
  // land out of order and leave the header and the rows describing different weeks.
  const loadGeneration = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(
    async (target: string) => {
      const generation = ++loadGeneration.current;
      const isCurrent = () => mounted.current && loadGeneration.current === generation;
      setLoading(true);
      setLoadError(null);
      setBoundaryIncomplete(false);
      try {
        const fetched = await getTimesheet(target);
        // `getTimesheet` windows on [weekStartUTC, +7d) and buckets by
        // toISOString(), so one edge of the technician's LOCAL week always
        // falls in the neighbouring server week: in New York a Sunday 20:00
        // callout is 00:00Z Monday and is missing from both the rows and the
        // weekly total. The endpoint takes no timezone, so the overlap is
        // fetched and re-filed locally. Which neighbour overlaps is derived
        // from THIS week's own boundaries — reading today's UTC offset gives
        // the wrong answer for any week across a DST change.
        const overlaps: TimesheetWeek[] = [];
        let missedBoundary = false;
        for (const offset of neighbourWeekOffsets(target)) {
          try {
            overlaps.push(await getTimesheet(shiftWeek(target, offset)));
          } catch (error: unknown) {
            // A correction, not the payload: losing it must not fail the whole
            // week — but it must not be silent either. Degrading quietly here
            // reintroduces the exact local-day bug this fetch exists to fix,
            // and the timesheet is then simply wrong with no sign of it.
            missedBoundary = true;
            reportInternalError(error, 'timesheet-neighbour-week');
          }
        }
        if (!isCurrent()) return;
        setBoundaryIncomplete(missedBoundary);
        setLoaded({
          week: target,
          entries: [...flattenWeek(fetched), ...overlaps.flatMap((week) => flattenWeek(week))],
        });
      } catch (error: unknown) {
        const denied = classifyTimeEntryDenial(error);
        if (denied !== null && isAccountLevelDenial(denied)) {
          dispatch(timeAccessDenied(denied));
          if (isCurrent()) setLoaded(null);
          return;
        }
        reportInternalError(error, 'timesheet-load');
        if (!isCurrent()) return;
        const apiError = error as { message?: string };
        setLoadError(denied?.message ?? apiError.message ?? 'Could not load your timesheet.');
      } finally {
        if (isCurrent()) setLoading(false);
      }
    },
    [dispatch]
  );

  // Reload on every focus, not just on mount or week change: a timer stopped on
  // a ticket and then the Time tab opened is the reviewer's exact path, and the
  // tab used to keep the week it fetched the first time, so the new entry was
  // simply not there until the week was paged away and back. The screen has no
  // pull-to-refresh either, so focus is the only natural refresh point.
  useFocusEffect(
    useCallback(() => {
      void load(weekStart);
    }, [load, weekStart])
  );

  const days = useMemo(() => daysOfWeek(weekStart), [weekStart]);
  // Only data actually loaded FOR the displayed week counts. Anything else is
  // "no data yet", which is what keeps the error branch reachable.
  const entries = entriesForWeek(loaded, weekStart);
  // Every entry re-filed onto the local calendar, with totals recomputed from
  // exactly the rows on screen so the header cannot disagree with them.
  const view = useMemo(() => buildLocalWeek(entries ?? [], days), [entries, days]);

  const beginEdit = useCallback((entry: TimeEntry) => {
    setEditingId(entry.id);
    setDraftDescription(entry.description ?? '');
  }, []);

  const applyEdit = useCallback(
    async (entry: TimeEntry, patch: { description?: string | null; isBillable?: boolean }) => {
      if (saveInFlight.current) return;
      saveInFlight.current = true;
      setSaving(true);
      try {
        await updateTimeEntry(entry.id, patch);
        if (!mounted.current) return;
        setEditingId(null);
        // Re-read rather than patching in place: the server recomputes
        // durations and day totals, and a locally-edited row would disagree
        // with the weekly total sitting right above it.
        await load(weekStart);
        if (mounted.current) setToast({ kind: 'success', text: 'Time entry updated' });
      } catch (error: unknown) {
        const denied = classifyTimeEntryDenial(error);
        if (denied !== null) {
          // Only an account-shaped verdict is a wall. APPROVED_IMMUTABLE and
          // NOT_OWN_ENTRY are 403s about ONE ROW: recorded as a sticky denial
          // they replace the whole Time tab and strip the Stop button off a
          // running timer, for a manager having approved a week from the web.
          if (isAccountLevelDenial(denied)) dispatch(timeAccessDenied(denied));
          if (mounted.current) setToast({ kind: 'error', text: denied.message });
          // Our copy of the row is stale — that is how the tap was offered at
          // all — so re-read rather than leaving the chips inviting a retry.
          if (!isAccountLevelDenial(denied)) await load(weekStart);
          return;
        }
        reportInternalError(error, 'timesheet-edit');
        if (mounted.current) {
          // ENTRY_BILLED is a 409, so it never reaches the classifier above.
          const apiError = error as { message?: string; code?: string };
          const text =
            apiError.code === 'ENTRY_BILLED'
              ? 'That entry is on an invoice; only its description can still be changed.'
              : apiError.message || 'Could not update the time entry.';
          setToast({ kind: 'error', text });
        }
      } finally {
        saveInFlight.current = false;
        if (mounted.current) setSaving(false);
      }
    },
    [dispatch, load, weekStart]
  );

  if (denial !== null) {
    // Explicit, non-generic, and never an empty week.
    return (
      <View style={styles.centered}>
        <Text style={styles.deniedHeadline}>Time tracking unavailable</Text>
        <Text style={styles.deniedBody}>{denial.message}</Text>
      </View>
    );
  }

  const renderEntry = (entry: TimeEntry) => {
    const lock = entryLock(entry);
    const ticket = entry.ticketId
      ? tickets.find((candidate) => candidate.id === entry.ticketId)
      : undefined;
    const isEditing = editingId === entry.id;

    return (
      <View key={entry.id} style={styles.entry}>
        <View style={styles.entryHeader}>
          <Text style={styles.entryRef}>
            {entry.ticketId
              ? (ticketRef({ internalNumber: entry.ticketNumber ?? ticket?.internalNumber ?? null }) ??
                entry.ticketSubject ??
                ticket?.subject ??
                'Ticket')
              : 'No ticket'}
          </Text>
          <Text style={styles.entryDuration}>{formatMinutes(entry.durationMinutes)}</Text>
        </View>
        <Text style={styles.entryMeta}>
          {startTimeLabel(entry.startedAt)}
          {entry.isBillable ? ' · Billable' : ' · Non-billable'}
          {lock.badge !== null ? ` · ${lock.badge}` : ''}
        </Text>

        {isEditing ? (
          <>
            <TextInput
              value={draftDescription}
              onChangeText={setDraftDescription}
              placeholder="What did you do?"
              placeholderTextColor={palette.dark.textLo}
              multiline
              style={styles.input}
              accessibilityLabel="Time entry description"
            />
            <View style={styles.editRow}>
              <Pressable
                onPress={() => void applyEdit(entry, { description: draftDescription.trim() || null })}
                disabled={saving}
                accessibilityRole="button"
                accessibilityState={{ disabled: saving }}
                style={[styles.chip, styles.chipPrimary, saving && styles.disabled]}
              >
                <Text style={styles.chipTextPrimary}>{saving ? 'Saving…' : 'Save'}</Text>
              </Pressable>
              <Pressable
                onPress={() => setEditingId(null)}
                accessibilityRole="button"
                style={styles.chip}
              >
                <Text style={styles.chipText}>Cancel</Text>
              </Pressable>
            </View>
          </>
        ) : (
          <>
            <Text style={styles.entryBody}>{entry.description || 'No description'}</Text>
            {lock.canEditDescription || lock.canToggleBillable ? (
              <View style={styles.editRow}>
                {lock.canEditDescription ? (
                  <Pressable
                    onPress={() => beginEdit(entry)}
                    accessibilityRole="button"
                    accessibilityLabel="Edit description"
                    style={styles.chip}
                  >
                    <Text style={styles.chipText}>Edit</Text>
                  </Pressable>
                ) : null}
                {lock.canToggleBillable ? (
                  <Pressable
                    onPress={() => void applyEdit(entry, { isBillable: !entry.isBillable })}
                    disabled={saving}
                    accessibilityRole="button"
                    accessibilityLabel={entry.isBillable ? 'Mark non-billable' : 'Mark billable'}
                    accessibilityState={{ disabled: saving }}
                    style={[styles.chip, saving && styles.disabled]}
                  >
                    <Text style={styles.chipText}>
                      {entry.isBillable ? 'Mark non-billable' : 'Mark billable'}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
            {lock.note !== null ? <Text style={styles.lockNote}>{lock.note}</Text> : null}
          </>
        )}
      </View>
    );
  };

  return (
    <KeyboardAvoidingView
      style={[styles.screen, { paddingTop: insets.top + spacing['3'] }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {suggestionsBannerVisible ? (
        <Pressable
          style={styles.suggestionBanner}
          accessibilityRole="button"
          onPress={() => {
            track('time_suggestion_entry_point', { surface: 'timesheet' });
            navigation?.navigate('TimeSuggestions');
          }}
        >
          <Text style={styles.suggestionBannerText}>{bannerLabel(unloggedCount)}</Text>
          <Text style={styles.suggestionBannerCta}>Review</Text>
        </Pressable>
      ) : null}
      <View style={styles.weekBar}>
        <Pressable
          onPress={() => setWeekStart((current) => shiftWeek(current, -1))}
          accessibilityRole="button"
          accessibilityLabel="Previous week"
          style={styles.chip}
        >
          <Text style={styles.chipText}>‹</Text>
        </Pressable>
        <View style={styles.weekLabels}>
          <Text style={styles.weekRange}>{weekRangeLabel(weekStart)}</Text>
          <Text style={styles.weekTotal}>
            {formatMinutes(view.totals.totalMinutes)} total ·{' '}
            {formatMinutes(view.totals.billableMinutes)} billable
          </Text>
        </View>
        <Pressable
          onPress={() => setWeekStart((current) => shiftWeek(current, 1))}
          accessibilityRole="button"
          accessibilityLabel="Next week"
          style={styles.chip}
        >
          <Text style={styles.chipText}>›</Text>
        </Pressable>
      </View>

      {timesheetPhase({ loading, loadError, entries }) === 'spinner' ? (
        <View style={styles.centered}>
          <ActivityIndicator color={palette.brand.soft} />
        </View>
      ) : timesheetPhase({ loading, loadError, entries }) === 'error' ? (
        <View style={styles.centered}>
          <Text style={styles.error}>{loadError}</Text>
          <Pressable
            onPress={() => void load(weekStart)}
            accessibilityRole="button"
            style={styles.retry}
          >
            <Text style={styles.chipText}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {boundaryIncomplete ? (
            // The overlap fetch is what re-files entries that the server filed
            // under the neighbouring UTC week. Without it the week is missing
            // rows AND minutes, so saying nothing would leave a wrong timesheet
            // looking authoritative.
            <Text style={styles.warning}>
              Some entries at the edges of this week could not be loaded. The total may be low.
            </Text>
          ) : null}
          {loadError !== null ? (
            <Text style={styles.warning}>{loadError}</Text>
          ) : null}
          {days.map((day) => {
            const dayEntries = view.byDay.get(day) ?? [];
            return (
              <View key={day} style={styles.day}>
                <View style={styles.dayHeader}>
                  <Text style={styles.dayLabel}>{dayLabel(day)}</Text>
                  <Text style={styles.dayTotal}>{formatMinutes(view.dayTotals.get(day) ?? 0)}</Text>
                </View>
                {dayEntries.length === 0 ? (
                  <Text style={styles.dayEmpty}>No time logged.</Text>
                ) : (
                  dayEntries.map(renderEntry)
                )}
              </View>
            );
          })}
        </ScrollView>
      )}

      <Toast
        visible={toast !== null}
        text={toast?.text ?? ''}
        kind={toast?.kind ?? 'success'}
        onHidden={() => setToast(null)}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.dark.bg0 },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.dark.bg0,
    padding: spacing['6'],
  },
  content: { padding: spacing['4'], paddingBottom: spacing['8'] },
  suggestionBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: palette.brand.deep,
    borderBottomWidth: 1,
    borderBottomColor: palette.brand.base,
    paddingHorizontal: spacing['4'],
    paddingVertical: spacing['3'],
  },
  suggestionBannerText: { ...type.meta, color: palette.dark.textHi },
  suggestionBannerCta: { ...type.metaCaps, color: palette.dark.textHi },
  weekBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing['3'],
    paddingHorizontal: spacing['4'],
    paddingVertical: spacing['3'],
    borderBottomWidth: 1,
    borderBottomColor: palette.dark.border,
  },
  weekLabels: { flex: 1, alignItems: 'center' },
  weekRange: { ...type.bodyMd, color: palette.dark.textHi },
  weekTotal: { ...type.meta, color: palette.dark.textMd, marginTop: spacing['1'] },
  day: { marginBottom: spacing['5'] },
  dayHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing['2'],
  },
  dayLabel: { ...type.metaCaps, color: palette.dark.textLo },
  dayTotal: { ...type.meta, color: palette.dark.textMd },
  dayEmpty: { ...type.meta, color: palette.dark.textLo },
  entry: {
    backgroundColor: palette.dark.bg1,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.dark.border,
    padding: spacing['3'],
    marginBottom: spacing['2'],
  },
  entryHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  entryRef: { ...type.monoMd, color: palette.dark.textMd },
  entryDuration: { ...type.bodyMd, color: palette.dark.textHi },
  entryMeta: { ...type.meta, color: palette.dark.textLo, marginTop: spacing['1'] },
  entryBody: { ...type.body, color: palette.dark.textHi, marginTop: spacing['2'] },
  lockNote: { ...type.meta, color: palette.warning.base, marginTop: spacing['2'] },
  editRow: { flexDirection: 'row', gap: spacing['2'], marginTop: spacing['2'], flexWrap: 'wrap' },
  chip: {
    paddingHorizontal: spacing['3'],
    paddingVertical: spacing['2'],
    borderRadius: radii.full,
    borderWidth: 1,
    borderColor: palette.dark.border,
    backgroundColor: palette.dark.bg1,
  },
  chipPrimary: { backgroundColor: palette.brand.deep, borderColor: palette.brand.base },
  chipText: { ...type.meta, color: palette.dark.textMd },
  chipTextPrimary: { ...type.meta, color: palette.dark.textHi },
  disabled: { opacity: 0.5 },
  input: {
    ...type.body,
    color: palette.dark.textHi,
    backgroundColor: palette.dark.bg0,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.dark.border,
    padding: spacing['3'],
    marginTop: spacing['2'],
    minHeight: 72,
    textAlignVertical: 'top',
  },
  deniedHeadline: { ...type.title, color: palette.dark.textHi, textAlign: 'center' },
  deniedBody: {
    ...type.body,
    color: palette.dark.textMd,
    textAlign: 'center',
    marginTop: spacing['3'],
  },
  warning: {
    ...type.meta,
    color: palette.warning.base,
    marginBottom: spacing['3'],
  },
  error: { ...type.body, color: palette.deny.base, textAlign: 'center' },
  retry: {
    marginTop: spacing['4'],
    paddingHorizontal: spacing['4'],
    paddingVertical: spacing['2'],
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.dark.border,
  },
});
