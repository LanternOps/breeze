import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type Dispatch, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { isPinnedLink } from '@/lib/wispLinksApi';
import { cancelWispCheckIn, listWispCheckIns } from '@/lib/wispCheckInsApi';
import { ActionError } from '@/lib/runAction';
import { showToast } from '@/components/shared/Toast';
import { AI_SESSION_IDLE_TIMEOUT_MS, AI_SESSION_MAX_AGE_MS, WISP_THREAD_LINK_LIMIT, type WispBriefSchedule, type WispCheckIn, type WispFirstLookProgress, type WispFirstLookState, type WispThreadLink, type WispTimelinePost } from '@breeze/shared';
import { useAiStore, type WispState } from '@/stores/aiStore';
import { fetchWithAuth } from '@/stores/auth';
import AiChatMessages from '../ai/AiChatMessages';
import AiChatInput from '../ai/AiChatInput';
import AiThinkingIndicator, { approvalWaitFromPending } from '../ai/AiThinkingIndicator';
import AiContinuationPrompt from '../ai/AiContinuationPrompt';
import AiModelPicker from '../ai/AiModelPicker';
import BuyCreditsLink from '../ai/BuyCreditsLink';
import { useWispInstructionCaptureStore } from '@/stores/wispInstructionCaptureStore';
import WispCheckInChip from './WispCheckInChip';
import WispInstructionChip from './WispInstructionChip';
import WispEntityPicker from './WispEntityPicker';
import WispPost from './WispPost';
import WispWelcome from './WispWelcome';
import { linkKey } from './wispEntitySources';
import { checkInIdFromHash, checkInIdFromLink } from './wispThreadHash';
import { useWispThreadTimeline, type TimelineTarget } from './useWispThreadTimeline';

type Wisp = NonNullable<WispState>;
/**
 * `not_configured`: the server has no model provider (503 `ai_not_configured`).
 * The column says that instead of the generic open failure and shows the thread
 * so far read-only, as for a paused grant; Try again rebinds once a key is added.
 */
type Binding = 'binding' | 'live' | 'failed' | 'not_configured';

/**
 * Past the server's chat-session lifetime (the shared AI_SESSION_* limits; a
 * send past either is refused with 410) by the session's own timestamps. An
 * unreadable timestamp is left to the status.
 */
function pastSessionLifetime(session: { createdAt?: unknown; lastActivityAt?: unknown }, now = Date.now()): boolean {
  const ageOf = (value: unknown) => (typeof value === 'string' ? now - Date.parse(value) : Number.NaN);
  return ageOf(session.createdAt) > AI_SESSION_MAX_AGE_MS || ageOf(session.lastActivityAt) > AI_SESSION_IDLE_TIMEOUT_MS;
}

/**
 * `thread.lastSessionId` is the last session stamped on the thread, not the
 * last live one: an idled-out (`expired`) or closed session would load its
 * transcript and then refuse the first send. Resume only an active session
 * that still runs under this grant and is within the server's lifetime: the
 * read reports a stale session as expired (#11430), and this check covers an
 * older API or a read that raced the expiry. A failed read is "not resumable".
 */
async function resumable(sessionId: string, grantId: string): Promise<boolean> {
  try {
    const res = await fetchWithAuth(`/ai/sessions/${encodeURIComponent(sessionId)}`);
    if (!res.ok) {
      console.warn('[WispHomeThread] checking the last Wisp session failed; starting a new one', res.status);
      return false;
    }
    const body = (await res.json().catch((err: unknown) => {
      console.warn('[WispHomeThread] the last Wisp session read was not JSON; starting a new one', err);
      return null;
    })) as { session?: { status?: unknown; wispGrantId?: unknown; createdAt?: unknown; lastActivityAt?: unknown } } | null;
    return body?.session?.status === 'active' && body.session.wispGrantId === grantId && !pastSessionLifetime(body.session);
  } catch (err) {
    console.warn('[WispHomeThread] could not check the last Wisp session; starting a new one', err);
    return false;
  }
}

/**
 * Bind the global chat (aiStore) to this thread's Wisp session without
 * minting a session per visit: reuse the live one, else resume the thread's
 * last session when it is still active (the store keeps Wisp mode when the
 * session runs under the same grant), else start a new one. Only for an
 * active grant — a paused or ended one cannot run a turn, so nothing is
 * created for it.
 */
async function bindWispSession(wisp: Wisp, lastSessionId: string | null): Promise<boolean> {
  const store = useAiStore.getState();
  if (store.wisp?.threadId === wisp.threadId && store.sessionId) return true;
  if (lastSessionId && (await resumable(lastSessionId, wisp.grantId))) {
    useAiStore.setState({ wisp });
    await store.switchSession(lastSessionId);
    const after = useAiStore.getState();
    if (after.sessionId === lastSessionId && after.wisp?.grantId === wisp.grantId) return true;
  }
  await useAiStore.getState().enterWispMode(wisp);
  return boundTo(wisp);
}

function boundTo(wisp: Wisp): boolean {
  const bound = useAiStore.getState();
  return bound.wisp?.threadId === wisp.threadId && bound.sessionId !== null;
}

/**
 * What the welcome says about the first look (#11145). The grant's state covers a
 * post that is not on this page of the timeline; the timeline covers a post newer
 * than the last poll. A real first look outranks the couldn't-look post it follows.
 */
function welcomeFirstLookState(posts: WispTimelinePost[], known: WispFirstLookState | undefined): WispFirstLookState {
  const firstLooks = posts.filter((p) => p.kind === 'first_look');
  if (known === 'done' || firstLooks.some((p) => p.variant !== 'couldnt_look')) return 'done';
  return known === 'couldnt_look' || firstLooks.length > 0 ? 'couldnt_look' : 'looking';
}

/** The column's reading width, shared by the message list (AiChatMessages `layout="page"`) and everything under it. */
const COLUMN = 'mx-auto w-full max-w-3xl';

/** A paused thread is read-only: nothing to approve or reject from its history. */
const noop = () => {};

/**
 * The Wisp conversation, the page's main column (W08 Task 9; W01 #10211 spec
 * §4.1–4.2): the same store the docked panel uses, so leaving the page leaves
 * the session for the panel to continue (unmount touches nothing).
 *
 * W02b (#10213, spec §6): the column is the whole thread. The live session's
 * messages come from the store; every older session's messages and Wisp's
 * posts (briefs, nudges, digests) come from the thread timeline, read without
 * the live session and paged backwards with Load earlier. `refreshKey` (the
 * page's poll signal) re-reads the newest page so new posts appear. A paused
 * grant shows its history read-only; an ended one reads nothing. There is no
 * "New conversation": one thread per grant, so rotating the session would
 * change nothing on screen (the closed session's turns stay in the timeline).
 *
 * `leading` (the thread page's summary) opens the thread; an empty thread
 * shows Wisp's welcome and suggestion chips above the composer; a paused or
 * ended grant shows its notice where the composer would be. `links` null
 * hides the composer's Link an item button (the thread page lists no links).
 *
 * Check-in timers (W05 #10996, spec §5), live thread only: the thread's
 * pending check-ins load on bind, on every `refreshKey` and when a turn
 * finishes streaming (so the chip appears as soon as the reply that scheduled
 * it ends). Scheduled ones show as a chip above the composer with cancel; a
 * `check_in` post whose row is still `fired` gets **Run now**, which sends the
 * check-in message. The server prepends every fired check-in of the grant
 * (oldest first, at most 5) to that turn and consumes them, so the button runs
 * all that are due, not only the one clicked. A paused grant shows its check-in posts read-only. A bell
 * deep link (`#checkin=<id>`) scrolls its post into view once.
 */
export default function WispHomeThread({
  wisp,
  lastSessionId,
  leading = null,
  scopeLabel,
  links,
  onLinksChange,
  refreshKey = 0,
  briefSchedule = null,
  firstLookProgress = null,
}: {
  wisp: Wisp;
  lastSessionId: string | null;
  leading?: ReactNode;
  scopeLabel: string;
  links: WispThreadLink[] | null;
  onLinksChange: Dispatch<SetStateAction<WispThreadLink[]>>;
  refreshKey?: number;
  /** The home's brief time and resolved zone, for the welcome; the thread page has none. */
  briefSchedule?: WispBriefSchedule | null;
  /** The home's live "N of M orgs looked at" (#11146); the thread page has none. */
  firstLookProgress?: WispFirstLookProgress | null;
}) {
  const { t } = useTranslation('ai');
  const active = wisp.status === 'active';
  const [binding, setBinding] = useState<Binding>('binding');
  const [pickerOpen, setPickerOpen] = useState(false);
  const attempt = useRef(0);
  // Read at bind time only: a poll reporting a newer last session must not rebind a live thread.
  const lastSessionRef = useRef(lastSessionId);
  lastSessionRef.current = lastSessionId;
  const linkedKeys = useMemo(() => new Set((links ?? []).filter((l) => l.id !== null).map((l) => linkKey(l.ref.kind, l.ref.id))), [links]);

  // The whole store, as AiChatSidebar binds it (a selector returning a fresh object would never settle).
  const {
    messages, chatRuns, isStreaming, thinking, isLoading, error, errorCode,
    pendingApproval, pendingPlan, activePlan, approvalMode, isPaused,
    sendMessage, approveExecution, clearPendingApproval, approvePlan, abortPlan, pauseAi,
    interruptResponse, isInterrupting, composerDraft, setComposerDraft, clearError,
    wisp: storeWisp, sessionId: storeSessionId,
  } = useAiStore();
  const storeThreadId = storeWisp?.threadId ?? null;
  const [checkIns, setCheckIns] = useState<WispCheckIn[]>([]);
  const checkInsToken = useRef(0);

  /** Run one (re)bind; only the latest attempt may set the outcome. */
  const rebind = (bind: () => Promise<boolean>) => {
    const token = ++attempt.current;
    setBinding('binding');
    void bind()
      .then((ok) => {
        if (token !== attempt.current) return;
        // Read the refusal now: the shared store's error is cleared by other surfaces (Dismiss in the panel).
        setBinding(ok ? 'live' : useAiStore.getState().errorCode === 'ai_not_configured' ? 'not_configured' : 'failed');
      })
      .catch((err: unknown) => {
        console.error('[WispHomeThread] opening the Wisp session failed', err);
        if (token === attempt.current) setBinding('failed');
      });
  };

  useEffect(() => {
    if (!active) return;
    rebind(() => bindWispSession(wisp, lastSessionRef.current));
    // The grant id and thread id identify the session; other Wisp fields (spend, summary) changing must not rebind.
  },[active, wisp.grantId, wisp.threadId]);

  // The panel (or another tab of the store) moved the chat to another conversation: say so rather than show it here.
  const showingThisThread = storeThreadId === wisp.threadId;

  // Live: everything but the store's session. Paused or no model provider: the whole history, read-only.
  // Ended or not bound: nothing.
  const live = active && binding === 'live' && showingThisThread;
  const readOnly = wisp.status === 'paused' || (active && binding === 'not_configured');
  const target = useMemo<TimelineTarget>(() => {
    if (readOnly) return { threadId: wisp.threadId, excludeSessionId: null };
    return live ? { threadId: wisp.threadId, excludeSessionId: storeSessionId ?? null } : null;
  }, [readOnly, wisp.threadId, live, storeSessionId]);
  const timeline = useWispThreadTimeline(target, refreshKey);
  const threadMessages = useMemo(
    () => (timeline.messages.length === 0 ? messages : [...timeline.messages, ...messages]),
    [timeline.messages, messages],
  );

  /** Only the latest read may land; a failed one keeps what is shown. */
  const loadCheckIns = useCallback(() => {
    const token = ++checkInsToken.current;
    listWispCheckIns(wisp.threadId)
      .then((list) => { if (token === checkInsToken.current) setCheckIns(list); })
      .catch((err: unknown) => console.warn('[WispHomeThread] reading the thread\'s check-ins failed', err));
  }, [wisp.threadId]);

  // Another thread's check-ins never show here, not even until the first read lands.
  useEffect(() => {
    checkInsToken.current++;
    setCheckIns([]);
  }, [wisp.threadId]);

  useEffect(() => {
    if (!live) {
      checkInsToken.current++;
      setCheckIns([]);
      return;
    }
    loadCheckIns();
  }, [live, loadCheckIns, refreshKey]);

  // A turn that just ended may have scheduled (or consumed) a check-in.
  const wasStreaming = useRef(isStreaming);
  useEffect(() => {
    if (wasStreaming.current && !isStreaming && live) loadCheckIns();
    wasStreaming.current = isStreaming;
  }, [isStreaming, live, loadCheckIns]);

  const dropCheckIn = (checkInId: string) => setCheckIns((prev) => prev.filter((c) => c.id !== checkInId));
  const onCancelCheckIn = async (checkInId: string) => {
    try {
      await cancelWispCheckIn(wisp.threadId, checkInId);
      // Gone now, even if the reload below fails: the toast already said so.
      dropCheckIn(checkInId);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (!(err instanceof ActionError)) {
        console.error('[WispHomeThread] cancelling a check-in failed', err);
        showToast({ type: 'error', message: t('wisp.checkIn.cancelFailed') });
      } else if (err.status === 404) {
        // Already consumed or cancelled (toasted by runAction): it is not pending any more.
        dropCheckIn(checkInId);
      }
    }
    loadCheckIns();
  };

  const firedIds = useMemo(
    () => new Set(checkIns.filter((c) => c.status === 'fired').map((c) => c.id)),
    [checkIns],
  );
  const runNowMessage = t('wisp.checkIn.runNowMessage');
  // Standing instructions Wisp remembered from this session's turns (chip under the reply).
  const loadSessionCaptures = useWispInstructionCaptureStore((s) => s.loadSessionCaptures);
  const sessionInstructions = useWispInstructionCaptureStore((s) => (storeSessionId ? s.bySession[storeSessionId] : undefined));
  useEffect(() => {
    if (live && storeSessionId) void loadSessionCaptures(storeSessionId);
  }, [live, storeSessionId, loadSessionCaptures]);
  const extras = useMemo(
    () => [...timeline.posts.map((post) => {
      const checkInId = post.kind === 'check_in' && live ? checkInIdFromLink(post.link) : null;
      const runnable = checkInId !== null && firedIds.has(checkInId);
      return {
        id: post.id,
        at: new Date(post.createdAt),
        render: () => (
          <WispPost
            post={post}
            onRunNow={runnable ? () => sendMessage(runNowMessage) : undefined}
            runNowDisabled={isStreaming || isLoading}
          />
        ),
      };
    }),
    ...(storeSessionId ? (sessionInstructions ?? []) : []).map((instruction) => ({
      id: `wisp-instruction-${instruction.instructionId}`,
      at: new Date(instruction.capturedAt),
      render: () => <WispInstructionChip sessionId={storeSessionId as string} instruction={instruction} />,
    }))],
    [timeline.posts, live, firedIds, sendMessage, runNowMessage, isStreaming, isLoading, storeSessionId, sessionInstructions],
  );

  // The bell's deep link (`#checkin=<id>`): bring its post into view once, the
  // first time it is on screen. After AiChatMessages' own bottom anchor, which
  // also runs in an animation frame, so this one wins.
  // A bell clicked while this page is open only changes the hash.
  const [hashCheckIn, setHashCheckIn] = useState<string | null>(null);
  useEffect(() => {
    const read = () => setHashCheckIn(checkInIdFromHash(window.location.hash));
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);
  const scrolledToCheckIn = useRef<string | null>(null);
  useEffect(() => {
    const wanted = hashCheckIn;
    if (!wanted || scrolledToCheckIn.current === wanted) return;
    if (!timeline.posts.some((p) => p.kind === 'check_in' && checkInIdFromLink(p.link) === wanted)) return;
    const frame = requestAnimationFrame(() => {
      const el = Array.from(document.querySelectorAll<HTMLElement>('[data-check-in-id]'))
        .find((node) => node.dataset.checkInId === wanted && node.dataset.testid === 'wisp-post');
      if (!el) return;
      scrolledToCheckIn.current = wanted;
      el.scrollIntoView({ block: 'center' });
    });
    return () => cancelAnimationFrame(frame);
  }, [timeline.posts, hashCheckIn]);
  const hasBrief = timeline.posts.some((p) => p.kind === 'brief');
  const firstLookState = welcomeFirstLookState(timeline.posts, wisp.firstLookState);
  const historyNotice = timeline.failed ? (
    <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="wisp-home-thread-history-failed" role="status">
      <span className="text-destructive">
        {timeline.failed === 'earlier'
          ? t('wisp.home.earlierFailed')
          : timeline.failed === 'refresh'
            ? t('wisp.home.refreshFailed')
            : t('wisp.home.historyFailed')}
      </span>
      <button
        type="button"
        data-testid="wisp-home-thread-history-retry"
        onClick={timeline.retry}
        className="font-medium underline underline-offset-2"
      >
        {t('wisp.thread.retry')}
      </button>
    </div>
  ) : null;
  const threadLeading = historyNotice || leading ? <>{historyNotice}{leading}</> : null;

  const onLinked = (link: WispThreadLink) => {
    // Derived concerns have null row ids; the entity key identifies what was pinned.
    const key = linkKey(link.ref.kind, link.ref.id);
    onLinksChange((prev) => prev.some((l) => linkKey(l.ref.kind, l.ref.id) === key)
      ? prev.map((l) => (linkKey(l.ref.kind, l.ref.id) === key ? link : l))
      : [...prev, link]);
    setPickerOpen(false);
  };

  /** Not live yet (or not live at all): `leading` still opens the column, the state line stands where the composer goes. */
  const withoutChat = (footer: ReactNode) => (
    <>
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className={`${COLUMN} flex min-h-full flex-col justify-end space-y-5`}>{leading}</div>
      </div>
      <div className={`${COLUMN} px-3 pb-3`}>{footer}</div>
    </>
  );

  /** A paused grant (or no model provider): the thread so far, read-only, with the notice where the composer would be. */
  const historyOnly = (footer: ReactNode) => (
    <>
      <AiChatMessages
        messages={timeline.messages}
        extras={extras}
        pendingApproval={null}
        onApprove={noop}
        onReject={noop}
        layout="page"
        assistantLabel={t('wisp.title')}
        showTimeDividers
        leading={threadLeading}
        emptyState={<span />}
        hasEarlier={timeline.hasEarlier}
        onLoadEarlier={timeline.loadEarlier}
        loadingEarlier={timeline.loadingEarlier}
      />
      <div className={`${COLUMN} px-3 pb-3`}>{footer}</div>
    </>
  );

  return (
    <section id="thread" className="flex min-h-0 flex-1 flex-col" data-testid="wisp-home-thread" aria-label={t('wisp.title')}>
      {!active ? (
        (wisp.status === 'paused' ? historyOnly : withoutChat)(
          <p className="rounded-2xl border px-4 py-3 text-sm text-muted-foreground" data-testid="wisp-home-thread-inactive">
            {wisp.status === 'paused' ? t('wisp.home.threadPaused') : t('wisp.home.threadEnded')}
          </p>,
        )
      ) : binding === 'not_configured' ? (
        historyOnly(
          <div className="space-y-2 rounded-2xl border px-4 py-3 text-sm" data-testid="wisp-home-thread-not-configured" role="status">
            <p className="text-muted-foreground">{t('errors:ai_not_configured')}</p>
            <button
              type="button"
              data-testid="wisp-home-thread-not-configured-retry"
              onClick={() => rebind(() => bindWispSession(wisp, null))}
              className="rounded border px-3 py-1 hover:bg-muted"
            >
              {t('wisp.thread.retry')}
            </button>
          </div>,
        )
      ) : binding === 'binding' ? (
        withoutChat(
          <p className="px-1 py-3 text-sm text-muted-foreground" data-testid="wisp-home-thread-binding" aria-busy="true">{t('wisp.home.threadOpening')}</p>,
        )
      ) : binding === 'failed' || !showingThisThread ? (
        withoutChat(
          <div className="space-y-2 rounded-2xl border px-4 py-3 text-sm" data-testid="wisp-home-thread-failed">
            <p className="text-destructive">{t('wisp.home.threadOpenFailed')}</p>
            <button
              type="button"
              data-testid="wisp-home-thread-retry"
              onClick={() => rebind(() => bindWispSession(wisp, null))}
              className="rounded border px-3 py-1 hover:bg-muted"
            >
              {t('wisp.thread.retry')}
            </button>
          </div>,
        )
      ) : (
        <>
          <AiChatMessages
            messages={threadMessages}
            extras={extras}
            hasEarlier={timeline.hasEarlier}
            onLoadEarlier={timeline.loadEarlier}
            loadingEarlier={timeline.loadingEarlier}
            chatRuns={chatRuns}
            pendingApproval={pendingApproval}
            pendingPlan={pendingPlan}
            activePlan={activePlan}
            approvalMode={approvalMode}
            isPaused={isPaused}
            onApprove={(id) => approveExecution(id, true)}
            onReject={(id) => approveExecution(id, false)}
            onApprovePlan={approvePlan}
            onAbortPlan={abortPlan}
            onPauseAi={pauseAi}
            onSendQuickAction={sendMessage}
            onIntentDecided={clearPendingApproval}
            layout="page"
            assistantLabel={t('wisp.title')}
            showTimeDividers
            leading={threadLeading}
            emptyState={timeline.settled
              ? <WispWelcome scopeLabel={scopeLabel} onSuggest={sendMessage} intro={!leading && !hasBrief} firstLookState={firstLookState} firstLookProgress={firstLookProgress} briefSchedule={briefSchedule} />
              : <div data-testid="wisp-home-thread-history-loading" aria-busy="true" />}
          />
          <div className={COLUMN}>
            {error && (
              <div className="mx-3 flex items-center justify-between gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2 text-xs text-destructive" data-testid="wisp-home-thread-error">
                <span>{error}</span>
                {errorCode === 'credits_exhausted' && <BuyCreditsLink className="shrink-0 font-medium underline underline-offset-2" />}
                <button type="button" onClick={clearError} className="shrink-0 hover:underline">{t('wisp.home.threadDismissError')}</button>
              </div>
            )}
            <AiContinuationPrompt />
            <AiThinkingIndicator thinking={isStreaming && !!thinking} approvalWait={isStreaming ? approvalWaitFromPending(pendingApproval) : null} />
            {/* The docked panel's model menu (registry W05): the store loads it for the bound session. */}
            <AiModelPicker disabled={isStreaming} />
            <WispCheckInChip checkIns={checkIns} onCancel={(id) => void onCancelCheckIn(id)} />
            <AiChatInput
              onSend={sendMessage}
              value={composerDraft}
              onValueChange={setComposerDraft}
              onInterrupt={interruptResponse}
              disabled={isLoading}
              isStreaming={isStreaming}
              isInterrupting={isInterrupting}
              placeholder={t('wisp.composer.placeholder')}
              leftSlot={links === null ? undefined : (
                <button
                  type="button"
                  data-testid="wisp-composer-link"
                  aria-label={t('wisp.composer.link')}
                  title={t('wisp.composer.link')}
                  onClick={() => setPickerOpen(true)}
                  disabled={links.filter(isPinnedLink).length >= WISP_THREAD_LINK_LIMIT}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
            />
          </div>
          {links !== null && (
            <WispEntityPicker
              open={pickerOpen}
              threadId={wisp.threadId}
              linkedKeys={linkedKeys}
              onClose={() => setPickerOpen(false)}
              onLinked={onLinked}
            />
          )}
        </>
      )}
    </section>
  );
}
