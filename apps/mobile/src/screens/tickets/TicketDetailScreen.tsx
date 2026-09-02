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
import type { NavigationProp, RouteProp } from '@react-navigation/native';
import { useNavigation, useRoute } from '@react-navigation/native';

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
import {
  openAttachmentExternally,
  pickDocument,
  pickFromCamera,
  pickFromLibrary,
  prepareImage,
  toAttachmentError,
  uploadTicketAttachment,
  type PickOutcome,
  type TicketAttachmentMeta,
} from '../../services/ticketAttachments';
import type { TicketsStackParamList } from '../../navigation/MainNavigator';
import { AttachmentChip } from '../../components/AttachmentChip';
import { Toast } from '../../components/Toast';
import { relativeTime } from '../../lib/relativeTime';
import { reportInternalError } from '../../lib/errorReporting';

import { priorityColor, priorityLabel, statusLabel, ticketRef } from './ticketCopy';
import {
  buildCommentSubmission,
  COMMENT_MODES,
  composerPlaceholder,
  DEFAULT_COMMENT_MODE,
  internalBannerText,
  isPublicForMode,
  modeTabLabel,
  submitLabel,
  type CommentMode,
} from './commentMode';
import { startForTicket, stopRunningTimer } from './timerActions';
import { startOutcomeEffects, stopOutcomeEffects } from './timerOutcomeEffects';
import { CommentAttachments } from './CommentAttachments';
import {
  addPickedFiles,
  attachDisabledReason,
  canSend,
  claimableIds,
  markFailed,
  markUploaded,
  markUploading,
  remainingSlots,
  removeChip,
  sendButtonLabel,
  type AttachmentChip as Chip,
} from './attachmentComposer';

type DetailRoute = RouteProp<TicketsStackParamList, 'TicketDetail'>;

/**
 * Candidate quick actions for the phone — deliberately not the full status set.
 * Filtered per ticket through `allowedQuickStatuses`, because the API 409s on
 * an illegal transition (a closed ticket can only reopen to `open`, and a
 * resolved one cannot go back to `pending`).
 */
const QUICK_STATUS_CANDIDATES: readonly TicketStatus[] = ['open', 'pending', 'resolved'];

/**
 * The three attach sources, rendered as a visible row rather than hidden behind
 * an action sheet.
 *
 * The plan called for an action sheet; a row is what actually works on both
 * platforms without a new dependency. `ActionSheetIOS` is iOS-only, and
 * `Alert.alert` — the cross-platform stand-in — silently degrades past three
 * buttons on Android, which is exactly the count this needs plus Cancel. The
 * row also costs one tap instead of two.
 */
const ATTACH_ACTIONS: readonly {
  key: string;
  label: string;
  pick: (remaining: number) => Promise<PickOutcome>;
}[] = [
  { key: 'camera', label: 'Camera', pick: () => pickFromCamera() },
  { key: 'library', label: 'Library', pick: (remaining) => pickFromLibrary(remaining) },
  { key: 'file', label: 'File', pick: () => pickDocument() },
];

export function TicketDetailScreen() {
  const route = useRoute<DetailRoute>();
  const navigation = useNavigation<NavigationProp<TicketsStackParamList>>();
  const { ticketId } = route.params;
  const dispatch = useAppDispatch();

  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  /**
   * Not reset after a successful send — mirroring the web composer, which also
   * leaves `mode` alone and only clears the text and chips. A reply is rarely a
   * single message, and silently snapping the composer back to a different
   * visibility between two sends is its own surprise. The mode stays legible
   * the whole time (selected tab, wash, button label), and the screen unmounts
   * on navigate-away, so `DEFAULT_COMMENT_MODE` reasserts itself every time a
   * ticket is opened fresh.
   */
  const [commentMode, setCommentMode] = useState<CommentMode>(DEFAULT_COMMENT_MODE);
  const [resolutionNote, setResolutionNote] = useState('');
  const [pendingStatus, setPendingStatus] = useState<TicketStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [timerNotice, setTimerNotice] = useState<string | null>(null);
  const [timerBusy, setTimerBusy] = useState(false);
  const [chips, setChips] = useState<Chip[]>([]);
  /**
   * Mirror of `chips` readable synchronously.
   *
   * Same reason as `inFlight` below: `chips` is render-captured, so two picks
   * dispatched before React commits would both compute their free slots from
   * the same stale array and overrun the five-per-comment cap. Every write goes
   * through `applyChips`, which keeps the two in step.
   */
  const chipsRef = useRef<Chip[]>([]);
  const applyChips = useCallback((next: (prev: Chip[]) => Chip[]): Chip[] => {
    const value = next(chipsRef.current);
    chipsRef.current = value;
    setChips(value);
    return value;
  }, []);

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

  /**
   * Prepare and upload ONE chip's file.
   *
   * `prepareImage` runs here rather than at pick time so a Retry re-derives
   * from the ORIGINAL local file: a resized temp file can be purged from the
   * cache between the failure and the retry, and re-manipulating is cheap
   * next to losing the photo.
   */
  const uploadChip = useCallback(
    async (chip: Chip) => {
      try {
        const prepared = await prepareImage(chip.file);
        const meta = await uploadTicketAttachment(ticketId, prepared);
        if (mounted.current) applyChips((prev) => markUploaded(prev, chip.localId, meta.id));
      } catch (err: unknown) {
        reportInternalError(err, 'ticket-attachment-upload');
        const failure = toAttachmentError(err);
        if (mounted.current) {
          applyChips((prev) => markFailed(prev, chip.localId, failure.message, failure.retryable));
        }
      }
    },
    [ticketId, applyChips]
  );

  const handlePick = useCallback(
    async (pick: () => Promise<PickOutcome>) => {
      // Total by contract — `runPicker` converts a native throw into a
      // `failed` outcome, so this never rejects into the `void` at the tap site.
      const outcome = await pick();
      if (!outcome.ok) {
        if (!mounted.current) return;
        // A cancel is the user's own choice and gets no toast; the other two
        // are failures they cannot otherwise see.
        if (outcome.reason === 'permission-denied') {
          setToast({
            kind: 'error',
            text: 'Breeze needs permission to use that. Enable it in Settings.',
          });
        } else if (outcome.reason === 'failed') {
          setToast({ kind: 'error', text: outcome.message });
        }
        return;
      }
      if (!mounted.current) return;

      const before = chipsRef.current.length;
      const added = addPickedFiles(chipsRef.current, outcome.files);
      applyChips(() => added.chips);
      const started = added.chips.slice(before);

      if (added.rejected > 0) {
        setToast({
          kind: 'error',
          text: `Only 5 files per comment — ${added.rejected} not added.`,
        });
      }
      // Sequential, not Promise.all: the server rate-limits uploads at 30/min
      // per user and a phone's uplink is the bottleneck anyway.
      for (const chip of started) await uploadChip(chip);
    },
    [uploadChip, applyChips]
  );

  const retryChip = useCallback(
    (localId: string) => {
      const target = chipsRef.current.find((c) => c.localId === localId);
      if (!target) return;
      applyChips((prev) => markUploading(prev, localId));
      void uploadChip(target);
    },
    [uploadChip, applyChips]
  );

  const openAttachment = useCallback(
    async (attachment: TicketAttachmentMeta) => {
      try {
        await openAttachmentExternally(
          ticketId,
          attachment.id,
          attachment.originalFilename,
          attachment.contentType
        );
      } catch (err: unknown) {
        reportInternalError(err, 'ticket-attachment-open');
        const failure = toAttachmentError(err);
        if (mounted.current) setToast({ kind: 'error', text: failure.message });
      }
    },
    [ticketId]
  );

  const submitComment = useCallback(async () => {
    // `isPublic` is derived, never a literal: a hardcoded `true` here is what
    // made every comment from a phone email the requester, and a hardcoded
    // boolean is invisible to a test. `buildCommentSubmission` is the one
    // place the mode becomes a visibility flag, and it is covered by
    // commentMode.test.ts.
    const submission = buildCommentSubmission({
      mode: commentMode,
      text: comment,
      attachmentIds: claimableIds(chips),
    });
    // Not `!content`: the API accepts a comment carrying only attachments
    // (`addTicketCommentSchema` refines "text OR at least one attachment"), so
    // gating on text alone would block a photo-only reply.
    if ((!submission.content && submission.attachmentIds.length === 0) || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const created = await addTicketComment(
        ticketId,
        submission.content,
        submission.isPublic,
        submission.attachmentIds
      );
      setComment('');
      // Only clear once the claim succeeded — a failed POST leaves the pending
      // rows claimable, and dropping the chips would strand them until the
      // server's 24h reaper runs.
      applyChips(() => []);
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
      reportInternalError(err, 'ticket-comment');
      if (mounted.current) {
        // A failed claim (ATTACHMENT_NOT_CLAIMABLE) has its own copy; anything
        // else falls back to the server's message. The chips are deliberately
        // NOT cleared here — the pending rows are still claimable, so a retry
        // can still post them.
        const code = (err as { code?: unknown } | null)?.code;
        const text = code === 'ATTACHMENT_NOT_CLAIMABLE'
          ? toAttachmentError(err).message
          : (err as { message?: string }).message || 'Could not add comment.';
        setToast({ kind: 'error', text });
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [comment, commentMode, chips, ticketId, load]);

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
  const attachBlocked = attachDisabledReason({ connected, chips });
  const sendable = canSend({ chips, text: comment, busy });
  const isInternal = !isPublicForMode(commentMode);
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
                  {/* An attachment-only comment arrives with empty content; the
                      Text renders nothing rather than an empty line. */}
                  {c.content ? <Text style={styles.body}>{c.content}</Text> : null}
                  <CommentAttachments
                    ticketId={ticketId}
                    attachments={c.attachments}
                    onOpenImage={(attachment) =>
                      navigation.navigate('AttachmentViewer', {
                        ticketId,
                        attachmentId: attachment.id,
                        contentType: attachment.contentType,
                        filename: attachment.originalFilename,
                      })
                    }
                    onOpenDocument={(attachment) => void openAttachment(attachment)}
                  />
                </>
              )}
            </View>
            );
          })
        )}

        {/* The whole composer is wrapped so the internal wash covers every
            control that belongs to the pending comment — a tint on the text
            field alone reads as a styling quirk, a tinted panel reads as a
            mode. */}
        <View style={[styles.composer, isInternal && styles.composerInternal]}>
          <View style={styles.modeTabs} accessibilityRole="tablist">
            {COMMENT_MODES.map((mode) => {
              const active = commentMode === mode;
              return (
                <Pressable
                  key={mode}
                  onPress={() => setCommentMode(mode)}
                  accessibilityRole="tab"
                  accessibilityLabel={modeTabLabel(mode)}
                  accessibilityState={{ selected: active }}
                  style={[
                    styles.modeTab,
                    active && (mode === 'internal' ? styles.modeTabInternal : styles.modeTabReply),
                  ]}
                >
                  <Text
                    style={[
                      styles.modeTabText,
                      active &&
                        (mode === 'internal'
                          ? styles.modeTabTextInternal
                          : styles.modeTabTextReply),
                    ]}
                  >
                    {modeTabLabel(mode)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {/* Spelled out rather than implied by colour: the wash is invisible
              to a technician who cannot distinguish it, the sentence is not. */}
          {isInternal ? <Text style={styles.internalBanner}>{internalBannerText}</Text> : null}

          <TextInput
            value={comment}
            onChangeText={setComment}
            placeholder={composerPlaceholder(commentMode)}
            placeholderTextColor={palette.dark.textLo}
            multiline
            style={[styles.input, styles.composerInput]}
            accessibilityLabel={composerPlaceholder(commentMode)}
          />

          <View style={styles.attachRow}>
            {ATTACH_ACTIONS.map(({ key, label, pick }) => (
              <Pressable
                key={key}
                onPress={() => void handlePick(() => pick(remainingSlots(chips)))}
                disabled={attachBlocked !== null}
                accessibilityRole="button"
                accessibilityLabel={label}
                accessibilityState={{ disabled: attachBlocked !== null }}
                style={[styles.attachButton, attachBlocked !== null && styles.submitDisabled]}
              >
                <Text style={styles.attachButtonText}>{label}</Text>
              </Pressable>
            ))}
          </View>
          {/* Says WHY, not just that it is unavailable — "Attachments need a
              connection" is actionable, a greyed button is not. */}
          {attachBlocked ? <Text style={styles.metaDim}>{attachBlocked}</Text> : null}

          {chips.map((chip) => (
            <AttachmentChip
              key={chip.localId}
              chip={chip}
              onRetry={retryChip}
              onRemove={(localId) => applyChips((prev) => removeChip(prev, localId))}
            />
          ))}

          <Pressable
            onPress={() => void submitComment()}
            disabled={!sendable}
            accessibilityRole="button"
            accessibilityState={{ disabled: !sendable }}
            style={[styles.submit, isInternal && styles.submitInternal, !sendable && styles.submitDisabled]}
          >
            {/* The idle label names the consequence ("Send reply" / "Add
                internal note"); the in-flight labels stay generic because at
                that point the visibility is already decided. */}
            <Text style={[styles.submitText, isInternal && styles.submitTextInternal]}>
              {sendButtonLabel({ chips, busy, idleLabel: submitLabel(commentMode) })}
            </Text>
          </Pressable>
        </View>
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
  // The composer panel. In reply mode it is a plain card; in internal mode the
  // amber wash and border make the whole pending comment read as private, the
  // same signal `styles.internal` already gives a posted internal note.
  composer: {
    marginTop: spacing['4'],
    padding: spacing['3'],
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.dark.border,
    backgroundColor: palette.dark.bg1,
  },
  composerInternal: {
    borderColor: palette.warning.base,
    // Same amber as palette.warning.base at low alpha; RN has no colour-mix,
    // so the wash is written out rather than derived.
    backgroundColor: 'rgba(219,168,74,0.12)',
  },
  // One step lighter than the panel so the field still reads as a field once
  // the composer has a surface of its own.
  composerInput: { backgroundColor: palette.dark.bg2, marginTop: 0 },
  modeTabs: { flexDirection: 'row', gap: spacing['2'], marginBottom: spacing['3'] },
  modeTab: {
    paddingHorizontal: spacing['3'],
    paddingVertical: spacing['2'],
    borderRadius: radii.full,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  modeTabReply: { backgroundColor: palette.brand.deep, borderColor: palette.brand.base },
  modeTabInternal: {
    backgroundColor: 'rgba(219,168,74,0.20)',
    borderColor: palette.warning.base,
  },
  modeTabText: { ...type.meta, color: palette.dark.textMd },
  modeTabTextReply: { color: palette.dark.textHi },
  modeTabTextInternal: { color: palette.warning.base },
  internalBanner: { ...type.meta, color: palette.warning.base, marginBottom: spacing['2'] },
  submit: {
    marginTop: spacing['3'],
    paddingVertical: spacing['3'],
    borderRadius: radii.md,
    backgroundColor: palette.brand.base,
    alignItems: 'center',
  },
  submitInternal: { backgroundColor: palette.warning.base },
  submitTextInternal: { color: palette.warning.onBase },
  submitDisabled: { opacity: 0.5 },
  attachRow: { flexDirection: 'row', gap: spacing['2'], marginTop: spacing['2'] },
  attachButton: {
    flex: 1,
    paddingVertical: spacing['2'],
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.dark.border,
    backgroundColor: palette.dark.bg1,
    alignItems: 'center',
  },
  attachButtonText: { ...type.meta, color: palette.dark.textMd },
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
