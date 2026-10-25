import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageSquare } from 'lucide-react';
import { useAiStore, type WispState } from '@/stores/aiStore';
import AiChatMessages from '../ai/AiChatMessages';
import AiChatInput from '../ai/AiChatInput';
import AiThinkingIndicator from '../ai/AiThinkingIndicator';
import AiContinuationPrompt from '../ai/AiContinuationPrompt';
import BuyCreditsLink from '../ai/BuyCreditsLink';

type Wisp = NonNullable<WispState>;
type Binding = 'binding' | 'live' | 'failed';

/**
 * Bind the global chat (aiStore) to this thread's Wisp session without
 * minting a session per visit: reuse the live one, else resume the thread's
 * last session (the store keeps Wisp mode when the session runs under the same
 * grant), else start the first one. Only for an active grant — a paused or
 * ended one cannot run a turn, so nothing is created for it.
 */
async function bindWispSession(wisp: Wisp, lastSessionId: string | null): Promise<boolean> {
  const store = useAiStore.getState();
  if (store.wisp?.threadId === wisp.threadId && store.sessionId) return true;
  if (lastSessionId) {
    useAiStore.setState({ wisp });
    await store.switchSession(lastSessionId);
    const after = useAiStore.getState();
    if (after.sessionId === lastSessionId && after.wisp?.grantId === wisp.grantId) return true;
  }
  await useAiStore.getState().enterWispMode(wisp);
  const bound = useAiStore.getState();
  return bound.wisp?.threadId === wisp.threadId && bound.sessionId !== null;
}

/**
 * The Wisp conversation inline on the home (W08 Task 9): the same store the
 * docked panel uses, so leaving the page leaves the session for the panel to
 * continue (unmount touches nothing).
 */
export default function WispHomeThread({ wisp, lastSessionId }: { wisp: Wisp; lastSessionId: string | null }) {
  const { t } = useTranslation('ai');
  const active = wisp.status === 'active';
  const [binding, setBinding] = useState<Binding>('binding');
  const attempt = useRef(0);

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
    bindWispSession(wisp, lastSessionId)
      .then((ok) => { if (token === attempt.current) setBinding(ok ? 'live' : 'failed'); })
      .catch((err: unknown) => {
        console.error('[WispHomeThread] opening the Wisp session failed', err);
        if (token === attempt.current) setBinding('failed');
      });
    // The grant id and thread id identify the session; other Wisp fields (spend, summary) changing must not rebind.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, wisp.grantId, wisp.threadId, lastSessionId]);

  // The panel (or another tab of the store) moved the chat to another conversation: say so rather than show it here.
  const showingThisThread = storeThreadId === wisp.threadId;

  return (
    <section id="thread" className="flex min-h-[28rem] flex-col overflow-hidden rounded-lg border bg-card" data-testid="wisp-home-thread" aria-labelledby="wisp-home-thread-title">
      <h2 id="wisp-home-thread-title" className="flex items-center gap-1.5 border-b px-4 py-2 text-sm font-semibold">
        <MessageSquare className="h-4 w-4 text-primary" aria-hidden="true" />
        {t('wisp.home.threadTitle')}
      </h2>

      {!active ? (
        <p className="p-4 text-sm text-muted-foreground" data-testid="wisp-home-thread-inactive">
          {wisp.status === 'paused' ? t('wisp.home.threadPaused') : t('wisp.home.threadEnded')}
        </p>
      ) : binding === 'binding' ? (
        <p className="p-4 text-sm text-muted-foreground" data-testid="wisp-home-thread-binding" aria-busy="true">{t('wisp.home.threadOpening')}</p>
      ) : binding === 'failed' || !showingThisThread ? (
        <div className="space-y-2 p-4 text-sm" data-testid="wisp-home-thread-failed">
          <p className="text-destructive">{t('wisp.home.threadOpenFailed')}</p>
          <button
            type="button"
            data-testid="wisp-home-thread-retry"
            onClick={() => {
              const token = ++attempt.current;
              setBinding('binding');
              void bindWispSession(wisp, null)
                .then((ok) => { if (token === attempt.current) setBinding(ok ? 'live' : 'failed'); })
                .catch((err: unknown) => {
                  console.error('[WispHomeThread] opening the Wisp session failed', err);
                  if (token === attempt.current) setBinding('failed');
                });
            }}
            className="rounded border px-3 py-1 hover:bg-muted"
          >
            {t('wisp.thread.retry')}
          </button>
        </div>
      ) : (
        <>
          {error && (
            <div className="flex items-center justify-between gap-2 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-xs text-destructive" data-testid="wisp-home-thread-error">
              <span>{error}</span>
              {errorCode === 'credits_exhausted' && <BuyCreditsLink className="shrink-0 font-medium underline underline-offset-2" />}
              <button type="button" onClick={clearError} className="shrink-0 hover:underline">{t('wisp.home.threadDismissError')}</button>
            </div>
          )}
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
          />
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
          />
        </>
      )}
    </section>
  );
}
