import { useCallback, useEffect, useRef, useState } from 'react';
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
import type { RouteProp } from '@react-navigation/native';
import { useRoute } from '@react-navigation/native';

import { palette, radii, spacing, type } from '../../theme';
import { useAppDispatch, useAppSelector } from '../../store';
import { applyStatusChange, syncTicketFromDetail } from '../../store/ticketsSlice';
import {
  needsAttentionChanged,
  pendingWritesChanged,
  runningTimerAdopted,
  stoppedTimer,
  timeAccessDenied,
} from '../../store/timeSlice';
import { startTimer, stopTimer } from '../../services/timeEntries';
import {
  enqueue,
  parkNeedsAttention,
  readNeedsAttention,
  readQueue,
} from '../../services/timeEntryQueue';
import {
  clearLocalTimer,
  readLocalTimer,
  stampNow,
  writeLocalTimer,
} from '../../services/localTimer';
import { useNetworkConnected } from '../../lib/useNetworkConnected';
import {
  addTicketComment,
  allowedQuickStatuses,
  changeTicketStatus,
  getTicket,
  statusRequiresResolutionNote,
  SYSTEM_COMMENT_TYPES,
  type TicketDetail,
  type TicketStatus,
} from '../../services/tickets';
import type { TicketsStackParamList } from '../../navigation/MainNavigator';
import { Toast } from '../../components/Toast';
import { relativeTime } from '../../lib/relativeTime';
import { reportInternalError } from '../../lib/errorReporting';

import { priorityColor, priorityLabel, statusLabel, ticketRef } from './ticketCopy';
import { startForTicket, stopRunningTimer } from './timerActions';
import { startOutcomeEffects, stopOutcomeEffects } from './timerOutcomeEffects';

type DetailRoute = RouteProp<TicketsStackParamList, 'TicketDetail'>;

/**
 * Candidate quick actions for the phone — deliberately not the full status set.
 * Filtered per ticket through `allowedQuickStatuses`, because the API 409s on
 * an illegal transition (a closed ticket can only reopen to `open`, and a
 * resolved one cannot go back to `pending`).
 */
const QUICK_STATUS_CANDIDATES: readonly TicketStatus[] = ['open', 'pending', 'resolved'];

export function TicketDetailScreen() {
  const route = useRoute<DetailRoute>();
  const { ticketId } = route.params;
  const dispatch = useAppDispatch();

  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [resolutionNote, setResolutionNote] = useState('');
  const [pendingStatus, setPendingStatus] = useState<TicketStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [timerNotice, setTimerNotice] = useState<string | null>(null);
  const [timerBusy, setTimerBusy] = useState(false);

  const connected = useNetworkConnected();
  const running = useAppSelector((state) => state.time.running);
  // Sticky for the session: once the server has refused this account the
  // control is withdrawn rather than re-offered and failing (see timeSlice).
  const timeDenial = useAppSelector((state) => state.time.denial);
  const timerInFlight = useRef(false);

  // `busy` is render-captured, so two taps before React commits can both see
  // false and fire duplicate requests. This ref is the synchronous lock.
  const inFlight = useRef(false);
  // Only the newest load() may publish; an earlier GET finishing later must not
  // replace a fresher ticket. Also gates writes after unmount.
  const loadGeneration = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * Returns true when the ticket was refreshed. Callers that just mutated
   * something use the result to decide whether they can honestly report
   * success: a POST that succeeded followed by a GET that failed leaves the
   * screen showing stale data, and silently toasting "done" hides that.
   */
  const load = useCallback(async (): Promise<boolean> => {
    const generation = ++loadGeneration.current;
    const isCurrent = () => mounted.current && loadGeneration.current === generation;
    setLoading(true);
    setLoadError(null);
    try {
      const fetched = await getTicket(ticketId);
      // A superseded or unmounted load reports failure rather than writing:
      // callers use the boolean to decide whether they may claim success, and
      // this one's data is no longer the freshest.
      if (!isCurrent()) return false;
      setTicket(fetched);
      // Keep the queue in step with what this screen now displays, so Redux and
      // the detail view cannot hold two different authoritative statuses. This
      // is the PASSIVE path: update in place, never drop the row.
      dispatch(
        syncTicketFromDetail({
          id: ticketId,
          status: fetched.status,
          statusName: fetched.statusName,
          statusColor: fetched.statusColor,
        })
      );
      return true;
    } catch (err: unknown) {
      if (!isCurrent()) return false;
      const apiError = err as { message?: string };
      setLoadError(apiError.message || 'Could not load this ticket.');
      return false;
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [ticketId, dispatch]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitComment = useCallback(async () => {
    const trimmed = comment.trim();
    if (!trimmed || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const created = await addTicketComment(ticketId, trimmed, true);
      setComment('');
      const refreshed = await load();
      if (!refreshed) {
        // The POST succeeded but the re-read did not. Append the comment the
        // server returned so the user sees their own text, and say plainly
        // that the rest of the view may be stale.
        setTicket((prev) => (prev ? { ...prev, comments: [...prev.comments, created] } : prev));
        setToast({ kind: 'error', text: 'Comment added, but the ticket could not be refreshed.' });
      } else {
        setToast({ kind: 'success', text: 'Comment added' });
      }
    } catch (err: unknown) {
      const apiError = err as { message?: string };
      reportInternalError(err, 'ticket-comment');
      if (mounted.current) {
        setToast({ kind: 'error', text: apiError.message || 'Could not add comment.' });
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [comment, ticketId, load]);

  const submitStatus = useCallback(
    async (status: TicketStatus) => {
      if (inFlight.current) return;
      // Resolving without a note is rejected by the API, so collect it first
      // rather than firing a request that always 400s.
      if (statusRequiresResolutionNote(status) && !resolutionNote.trim()) {
        setPendingStatus(status);
        setToast({ kind: 'error', text: 'A resolution note is required to resolve.' });
        return;
      }
      inFlight.current = true;
      setBusy(true);
      try {
        const updated = await changeTicketStatus(
          ticketId,
          status,
          resolutionNote.trim() || undefined
        );
        setPendingStatus(null);
        setResolutionNote('');
        // Trust the server's status, not the one we asked for.
        const applied = updated?.status ?? status;
        dispatch(
          applyStatusChange({
            id: ticketId,
            status: applied,
            // These are always null here, and that is not an oversight to
            // tidy away: POST /tickets/:id/status returns the raw `tickets`
            // row (`changeTicketStatus` in services/ticketService.ts ends in a
            // bare `.returning()`), while statusName/statusColor exist only via
            // the join in the list and detail GET routes. Writing them keeps
            // the optimistic row shape consistent; the CORRECT labels come from
            // the `load()` below.
            //
            // So that refetch is load-bearing, not a wasted round trip.
            // Removing it reintroduces blank status labels.
            statusName: updated?.statusName ?? null,
            statusColor: updated?.statusColor ?? null,
          })
        );
        const refreshed = await load();
        if (!mounted.current) return;
        const label = statusLabel({ status: applied, statusName: updated?.statusName ?? null });
        if (!refreshed) {
          setTicket((prev) => (prev ? { ...prev, ...updated } : prev));
          setToast({ kind: 'error', text: `Marked ${label}, but the ticket could not be refreshed.` });
        } else {
          setToast({ kind: 'success', text: `Marked ${label}` });
        }
      } catch (err: unknown) {
        const apiError = err as { message?: string };
        reportInternalError(err, 'ticket-status');
        if (mounted.current) {
          setToast({ kind: 'error', text: apiError.message || 'Could not change status.' });
        }
      } finally {
        inFlight.current = false;
        if (mounted.current) setBusy(false);
      }
    },
    [resolutionNote, ticketId, dispatch, load]
  );

  /**
   * The queue is the source of truth for "how much is unsent", so the depth is
   * re-read from storage rather than incremented locally. On a storage failure
   * the previous depth is kept: reporting zero pending writes would tell a
   * technician their billable minutes are safe when they may not be.
   */
  const refreshQueueDepth = useCallback(async () => {
    try {
      const queued = await readQueue();
      if (mounted.current) dispatch(pendingWritesChanged(queued.length));
    } catch {
      // QueueStorageError — leave the last known depth in place.
    }
  }, [dispatch]);

  const onStartTimer = useCallback(async () => {
    if (timerInFlight.current) return;
    timerInFlight.current = true;
    setTimerBusy(true);
    setTimerNotice(null);
    try {
      const outcome = await startForTicket(ticketId, {
        startTimer,
        writeLocalTimer,
        clearLocalTimer,
        isConnected: () => connected,
        stamp: stampNow,
      });
      if (!mounted.current) return;
      // One decision table, shared with the TimerBar — see timerOutcomeEffects.ts.
      const effects = startOutcomeEffects(outcome);
      // `startRunning` may carry a null id: a timer started offline exists only
      // on this device until its span is created, and it still has to tick.
      if (effects.startRunning !== null) dispatch(runningTimerAdopted(effects.startRunning));
      if (effects.accountDenial !== null) dispatch(timeAccessDenied(effects.accountDenial));
      if (effects.refreshQueueDepth) await refreshQueueDepth();
      if (!mounted.current) return;
      setTimerNotice(effects.notice);
      setToast(effects.toast);
    } finally {
      timerInFlight.current = false;
      if (mounted.current) setTimerBusy(false);
    }
  }, [ticketId, connected, dispatch, refreshQueueDepth]);

  const onStopTimer = useCallback(async () => {
    if (timerInFlight.current) return;
    timerInFlight.current = true;
    setTimerBusy(true);
    setTimerNotice(null);
    try {
      const outcome = await stopRunningTimer(
        { running },
        {
          stopTimer,
          enqueue,
          readLocalTimer,
          clearLocalTimer,
          parkNeedsAttention,
          isConnected: () => connected,
          stamp: stampNow,
        }
      );
      if (!mounted.current) return;
      const effects = stopOutcomeEffects(outcome);
      // A QUEUED stop clears the local timer too: the technician has said the
      // timer is over and the queued write is what makes the server agree.
      if (effects.clearRunning) dispatch(stoppedTimer());
      if (effects.accountDenial !== null) dispatch(timeAccessDenied(effects.accountDenial));
      if (effects.reload) {
        // The stop writes a time-entry activity comment server-side, so the
        // activity list below is stale until this lands.
        void load();
      }
      if (effects.refreshQueueDepth) await refreshQueueDepth();
      // A stop whose clock ran backwards parks a row from THIS screen, so the
      // standing count has to be updated here — not at the next reconnect.
      if (effects.refreshNeedsAttention) {
        const parked = await readNeedsAttention().catch(() => null);
        if (parked !== null && mounted.current) dispatch(needsAttentionChanged(parked.length));
      }
      if (!mounted.current) return;
      setTimerNotice(effects.notice);
      setToast(effects.toast);
    } finally {
      timerInFlight.current = false;
      if (mounted.current) setTimerBusy(false);
    }
  }, [connected, dispatch, refreshQueueDepth, load, running]);

  if (loading && !ticket) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={palette.brand.soft} />
      </View>
    );
  }

  if (loadError && !ticket) {
    return (
      <View style={styles.centered}>
        <Text style={styles.error}>{loadError}</Text>
        <Pressable onPress={() => void load()} accessibilityRole="button" style={styles.retry}>
          <Text style={styles.retryText}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  if (!ticket) return null;

  // Only while a resolve is pending. A ticket that is ALREADY resolved offers
  // no Resolve action (transitions allow only open/closed from there) and
  // `changeTicketStatus` discards the note on non-resolving moves, so rendering
  // the input then produces a field whose contents can never be submitted.
  const showResolutionInput = pendingStatus === 'resolved';
  const quickStatuses = allowedQuickStatuses(ticket.status, QUICK_STATUS_CANDIDATES);
  // Only person-authored entries are "comments"; the rest of the array is
  // activity (status changes, assignments, time entries).
  const commentCount = ticket.comments.filter(
    (c) => !c.commentType || !SYSTEM_COMMENT_TYPES.has(c.commentType)
  ).length;

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Text style={styles.ref}>{ticketRef(ticket)}</Text>
          <View style={[styles.priorityDot, { backgroundColor: priorityColor(ticket.priority) }]} />
          <Text style={styles.priority}>{priorityLabel(ticket.priority)}</Text>
        </View>
        <Text style={styles.subject}>{ticket.subject}</Text>
        <Text style={styles.meta}>
          {statusLabel(ticket)}
          {ticket.orgName ? ` · ${ticket.orgName}` : ''}
          {ticket.deviceHostname ? ` · ${ticket.deviceHostname}` : ''}
        </Text>
        {ticket.assigneeName ? (
          <Text style={styles.metaDim}>Assigned to {ticket.assigneeName}</Text>
        ) : (
          <Text style={styles.metaDim}>Unassigned</Text>
        )}

        {ticket.description ? (
          <View style={styles.card}>
            <Text style={styles.body}>{ticket.description}</Text>
          </View>
        ) : null}

        <Text style={styles.sectionHeader}>STATUS</Text>
        {quickStatuses.length === 0 ? (
          <Text style={styles.metaDim}>No status changes available from here.</Text>
        ) : (
          <View style={styles.statusRow}>
            {quickStatuses.map((status) => (
              <Pressable
                key={status}
                onPress={() => void submitStatus(status)}
                disabled={busy}
                accessibilityRole="button"
                accessibilityState={{ disabled: busy }}
                style={styles.statusChip}
              >
                <Text style={styles.statusChipText}>
                  {statusLabel({ status, statusName: null })}
                </Text>
              </Pressable>
            ))}
          </View>
        )}

        {showResolutionInput ? (
          <TextInput
            value={resolutionNote}
            onChangeText={setResolutionNote}
            placeholder="Resolution note (required to resolve)"
            placeholderTextColor={palette.dark.textLo}
            multiline
            style={styles.input}
            accessibilityLabel="Resolution note"
          />
        ) : null}

        <Text style={styles.sectionHeader}>TIME</Text>
        {timeDenial ? (
          // Not a generic failure: the technician is told which wall they hit
          // and whether an administrator can move it.
          <Text style={styles.timeDenied} accessibilityRole="text">
            {timeDenial.message}
          </Text>
        ) : (
          <>
            <Pressable
              onPress={() => (running ? void onStopTimer() : void onStartTimer())}
              disabled={timerBusy}
              accessibilityRole="button"
              accessibilityLabel={running ? 'Stop timer' : 'Start timer on this ticket'}
              accessibilityState={{ disabled: timerBusy }}
              style={[styles.timerButton, timerBusy && styles.submitDisabled]}
            >
              <Text style={styles.timerButtonText}>
                {timerBusy ? 'Working…' : running ? 'Stop timer' : 'Start timer'}
              </Text>
            </Pressable>
            {running && running.ticketId !== ticketId ? (
              // `startTimer` auto-stops the caller's previous timer before
              // inserting (timeEntryService.ts), so starting here silently
              // closes the other ticket's entry. Say so before the tap.
              <Text style={styles.metaDim}>
                A timer is running on another ticket. Starting here stops that one.
              </Text>
            ) : null}
            {running && running.ticketId === ticketId ? (
              <Text style={styles.metaDim}>
                {running.id === null
                  ? 'Timer running on this ticket — not yet synced.'
                  : 'Timer running on this ticket.'}
              </Text>
            ) : null}
            {!connected ? (
              <Text style={styles.metaDim}>Offline — time is saved and synced later.</Text>
            ) : null}
            {timerNotice ? <Text style={styles.timerNotice}>{timerNotice}</Text> : null}
          </>
        )}

        <Text style={styles.sectionHeader}>
          ACTIVITY{commentCount ? ` (${commentCount})` : ''}
        </Text>
        {ticket.comments.length === 0 ? (
          <Text style={styles.metaDim}>No comments yet.</Text>
        ) : (
          ticket.comments.map((c) => {
            const isSystem = Boolean(c.commentType && SYSTEM_COMMENT_TYPES.has(c.commentType));
            if (isSystem) {
              // Activity entries are not comments: no author chip, no INTERNAL
              // badge (they are non-public by nature), and dimmed.
              return (
                <View key={c.id} style={styles.activityRow}>
                  <Text style={styles.activityText}>{c.content}</Text>
                  <Text style={styles.metaDim}>{relativeTime(c.createdAt)}</Text>
                </View>
              );
            }
            return (
            <View key={c.id} style={styles.card}>
              <View style={styles.commentHeader}>
                <Text style={styles.commentAuthor}>{c.authorName || 'Unknown'}</Text>
                <Text style={styles.metaDim}>{relativeTime(c.createdAt)}</Text>
              </View>
              {c.deleted ? (
                // The API blanks `content` for soft-deleted comments and flags
                // them instead of omitting the row. Without this branch the
                // card renders as an empty bubble, which reads as a bug.
                <Text style={styles.deletedComment}>Comment deleted</Text>
              ) : (
                <>
                  {!c.isPublic ? <Text style={styles.internal}>INTERNAL</Text> : null}
                  <Text style={styles.body}>{c.content}</Text>
                </>
              )}
            </View>
            );
          })
        )}

        <TextInput
          value={comment}
          onChangeText={setComment}
          placeholder="Add a comment"
          placeholderTextColor={palette.dark.textLo}
          multiline
          style={styles.input}
          accessibilityLabel="Add a comment"
        />
        <Pressable
          onPress={() => void submitComment()}
          disabled={busy || !comment.trim()}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy || !comment.trim() }}
          style={[styles.submit, (busy || !comment.trim()) && styles.submitDisabled]}
        >
          <Text style={styles.submitText}>{busy ? 'Working…' : 'Post comment'}</Text>
        </Pressable>
      </ScrollView>

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
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing['2'] },
  ref: { ...type.monoMd, color: palette.dark.textMd },
  priorityDot: { width: 8, height: 8, borderRadius: radii.full },
  priority: { ...type.meta, color: palette.dark.textMd },
  subject: { ...type.title, color: palette.dark.textHi, marginTop: spacing['2'] },
  meta: { ...type.meta, color: palette.dark.textMd, marginTop: spacing['2'] },
  metaDim: { ...type.meta, color: palette.dark.textLo, marginTop: spacing['1'] },
  sectionHeader: {
    ...type.metaCaps,
    color: palette.dark.textLo,
    marginTop: spacing['6'],
    marginBottom: spacing['2'],
  },
  card: {
    backgroundColor: palette.dark.bg1,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.dark.border,
    padding: spacing['3'],
    marginTop: spacing['2'],
  },
  body: { ...type.body, color: palette.dark.textHi },
  commentHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  commentAuthor: { ...type.meta, color: palette.dark.textMd },
  internal: { ...type.metaCaps, color: palette.warning.base, marginTop: spacing['1'] },
  deletedComment: { ...type.body, color: palette.dark.textLo, fontStyle: 'italic' },
  activityRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing['2'],
    paddingVertical: spacing['2'],
    paddingHorizontal: spacing['1'],
  },
  activityText: { ...type.meta, color: palette.dark.textLo, flexShrink: 1 },
  statusRow: { flexDirection: 'row', gap: spacing['2'], flexWrap: 'wrap' },
  statusChip: {
    paddingHorizontal: spacing['3'],
    paddingVertical: spacing['2'],
    borderRadius: radii.full,
    borderWidth: 1,
    borderColor: palette.dark.border,
    backgroundColor: palette.dark.bg1,
  },
  statusChipActive: { backgroundColor: palette.brand.deep, borderColor: palette.brand.base },
  statusChipText: { ...type.meta, color: palette.dark.textMd },
  statusChipTextActive: { color: palette.dark.textHi },
  input: {
    ...type.body,
    color: palette.dark.textHi,
    backgroundColor: palette.dark.bg1,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.dark.border,
    padding: spacing['3'],
    marginTop: spacing['2'],
    minHeight: 88,
    textAlignVertical: 'top',
  },
  submit: {
    marginTop: spacing['3'],
    paddingVertical: spacing['3'],
    borderRadius: radii.md,
    backgroundColor: palette.brand.base,
    alignItems: 'center',
  },
  submitDisabled: { opacity: 0.5 },
  timerButton: {
    marginTop: spacing['2'],
    paddingVertical: spacing['3'],
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.brand.base,
    backgroundColor: palette.brand.deep,
    alignItems: 'center',
  },
  timerButtonText: { ...type.bodyMd, color: palette.dark.textHi },
  timerNotice: { ...type.meta, color: palette.deny.base, marginTop: spacing['2'] },
  timeDenied: { ...type.meta, color: palette.warning.base, marginTop: spacing['1'] },
  submitText: { ...type.bodyMd, color: palette.dark.textHi },
  error: { ...type.body, color: palette.deny.base, textAlign: 'center' },
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
