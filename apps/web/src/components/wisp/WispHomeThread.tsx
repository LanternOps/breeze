import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { WISP_THREAD_LINK_LIMIT, type WispThreadLink } from '@breeze/shared';
import { useAiStore, type WispState } from '@/stores/aiStore';
import { fetchWithAuth } from '@/stores/auth';
import AiChatMessages from '../ai/AiChatMessages';
import AiChatInput from '../ai/AiChatInput';
import AiThinkingIndicator from '../ai/AiThinkingIndicator';
import AiContinuationPrompt from '../ai/AiContinuationPrompt';
import BuyCreditsLink from '../ai/BuyCreditsLink';
import WispEntityPicker from './WispEntityPicker';
import WispWelcome from './WispWelcome';
import { linkKey } from './wispEntitySources';

type Wisp = NonNullable<WispState>;
type Binding = 'binding' | 'live' | 'failed';

/**
 * `thread.lastSessionId` is the last session stamped on the thread, not the
 * last live one: an idled-out (`expired`) or closed session would load its
 * transcript and then refuse the first send. Resume only an active session
 * that still runs under this grant. A failed read is "not resumable".
 */
async function resumable(sessionId: string, grantId: string): Promise<boolean> {
  try {
    const res = await fetchWithAuth(`/ai/sessions/${encodeURIComponent(sessionId)}`);
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { session?: { status?: unknown; wispGrantId?: unknown } } | null;
    return body?.session?.status === 'active' && body.session.wispGrantId === grantId;
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
  const bound = useAiStore.getState();
  return bound.wisp?.threadId === wisp.threadId && bound.sessionId !== null;
}

/** The column's reading width, shared by the message list (AiChatMessages `layout="page"`) and everything under it. */
const COLUMN = 'mx-auto w-full max-w-3xl';

/**
 * The Wisp conversation, the page's main column (W08 Task 9; W01 #10211 spec
 * §4.1–4.2): the same store the docked panel uses, so leaving the page leaves
 * the session for the panel to continue (unmount touches nothing). `leading`
 * (the morning brief post) opens the thread; an empty thread shows Wisp's
 * welcome and suggestion chips above the composer; a paused or ended grant
 * shows its notice where the composer would be. `links` null hides the
 * composer's Link an item button (the thread page lists no links).
 */
export default function WispHomeThread({
  wisp,
  lastSessionId,
  leading = null,
  scopeLabel,
  links,
  onLinksChange,
}: {
  wisp: Wisp;
  lastSessionId: string | null;
  leading?: ReactNode;
  scopeLabel: string;
  links: WispThreadLink[] | null;
  onLinksChange: (links: WispThreadLink[]) => void;
}) {
  const { t } = useTranslation('ai');
  const active = wisp.status === 'active';
  const [binding, setBinding] = useState<Binding>('binding');
  const [pickerOpen, setPickerOpen] = useState(false);
  const attempt = useRef(0);
  // Read at bind time only: a poll reporting a newer last session must not rebind a live thread.
  const lastSessionRef = useRef(lastSessionId);
  lastSessionRef.current = lastSessionId;
  const linkedKeys = useMemo(() => new Set((links ?? []).map((l) => linkKey(l.ref.kind, l.ref.id))), [links]);

  // The whole store, as AiChatSidebar binds it (a selector returning a fresh object would never settle).
  const {
    messages, chatRuns, isStreaming, thinking, isLoading, error, errorCode,
    pendingApproval, pendingPlan, activePlan, approvalMode, isPaused,
    sendMessage, approveExecution, clearPendingApproval, approvePlan, abortPlan, pauseAi,
    interruptResponse, isInterrupting, composerDraft, setComposerDraft, clearError,
    wisp: storeWisp,
  } = useAiStore();
  const storeThreadId = storeWisp?.threadId ?? null;

  useEffect(() => {
    if (!active) return;
    const token = ++attempt.current;
    setBinding('binding');
    bindWispSession(wisp, lastSessionRef.current)
      .then((ok) => { if (token === attempt.current) setBinding(ok ? 'live' : 'failed'); })
      .catch((err: unknown) => {
        console.error('[WispHomeThread] opening the Wisp session failed', err);
        if (token === attempt.current) setBinding('failed');
      });
    // The grant id and thread id identify the session; other Wisp fields (spend, summary) changing must not rebind.
  },[active, wisp.grantId, wisp.threadId]);

  // The panel (or another tab of the store) moved the chat to another conversation: say so rather than show it here.
  const showingThisThread = storeThreadId === wisp.threadId;

  const onLinked = (link: WispThreadLink) => {
    // As WispLinksPanel: the add is idempotent server-side (a re-add returns
    // the existing row with a refreshed label), so replace by id, never append twice.
    const current = links ?? [];
    const exists = current.some((l) => l.id === link.id);
    onLinksChange(exists ? current.map((l) => (l.id === link.id ? link : l)) : [...current, link]);
    setPickerOpen(false);
  };

  const retry = () => {
    const token = ++attempt.current;
    setBinding('binding');
    void bindWispSession(wisp, null)
      .then((ok) => { if (token === attempt.current) setBinding(ok ? 'live' : 'failed'); })
      .catch((err: unknown) => {
        console.error('[WispHomeThread] opening the Wisp session failed', err);
        if (token === attempt.current) setBinding('failed');
      });
  };

  /** Not live yet (or not live at all): the brief still opens the column, the state line stands where the composer goes. */
  const withoutChat = (footer: ReactNode) => (
    <>
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className={`${COLUMN} flex min-h-full flex-col justify-end space-y-5`}>{leading}</div>
      </div>
      <div className={`${COLUMN} px-3 pb-3`}>{footer}</div>
    </>
  );

  return (
    <section id="thread" className="flex min-h-0 flex-1 flex-col" data-testid="wisp-home-thread" aria-label={t('wisp.title')}>
      {!active ? (
        withoutChat(
          <p className="rounded-2xl border px-4 py-3 text-sm text-muted-foreground" data-testid="wisp-home-thread-inactive">
            {wisp.status === 'paused' ? t('wisp.home.threadPaused') : t('wisp.home.threadEnded')}
          </p>,
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
              onClick={retry}
              className="rounded border px-3 py-1 hover:bg-muted"
            >
              {t('wisp.thread.retry')}
            </button>
          </div>,
        )
      ) : (
        <>
          <AiChatMessages
            messages={messages}
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
            leading={leading}
            emptyState={<WispWelcome scopeLabel={scopeLabel} onSuggest={sendMessage} intro={!leading} />}
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
            <AiThinkingIndicator thinking={isStreaming && !!thinking} />
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
                  disabled={links.length >= WISP_THREAD_LINK_LIMIT}
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
