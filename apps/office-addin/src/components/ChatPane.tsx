import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ChatController } from '../chat/chatController';
import { ChatThread } from './ChatThread';
import { ChatToolbar } from './ChatToolbar';
import { Composer } from './Composer';
import { TemplatePicker } from './TemplatePicker';
import { QuickActions } from './QuickActions';
import { BrandingFooter } from './BrandingFooter';
import { HistoryPanel } from './HistoryPanel';
import type { ClientSession } from '../auth/session';

export function ChatPane({ session }: { session: ClientSession }) {
  const controller = useMemo(() => new ChatController(), []);
  useEffect(() => () => controller.dispose(), [controller]);

  const [historyOpen, setHistoryOpen] = useState(false);

  const state = useSyncExternalStore(
    useCallback((cb: () => void) => controller.subscribe(cb), [controller]),
    () => controller.getState(),
  );
  const approvals = useSyncExternalStore(
    useCallback((cb: () => void) => controller.approvals.subscribe(cb), [controller]),
    () => controller.approvals.getPending(),
  );

  const empty = state.thread.length === 0 && !state.streamingText;
  // The flag action only makes sense once a conversation exists.
  const conversationStarted = state.thread.length > 0 || !!state.streamingText;

  const loadHistory = useCallback(() => controller.listSessions(), [controller]);
  const resume = useCallback(
    (sessionId: string) => {
      setHistoryOpen(false);
      void controller.resumeSession(sessionId);
    },
    [controller],
  );

  return (
    <div className="relative flex h-screen flex-col">
      <div className="flex items-center justify-between border-b border-gray-100 px-3 py-1.5">
        <button
          type="button"
          onClick={() => controller.startNewSession()}
          className="rounded-md px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100"
          data-testid="new-chat-button"
        >
          + New chat
        </button>
        <button
          type="button"
          onClick={() => setHistoryOpen(true)}
          className="rounded-md px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100"
          data-testid="history-button"
        >
          History
        </button>
      </div>
      <ChatToolbar
        writeApproval={state.writeApproval}
        autoApply={state.autoApply}
        flagged={state.flagged}
        canFlag={conversationStarted}
        onToggleAuto={(value) => controller.setAutoApply(value)}
        onFlag={() => void controller.flagConversation()}
      />
      {empty && (
        <>
          <QuickActions onSelect={(prompt) => void controller.send(prompt)} />
          <TemplatePicker onPick={(body) => controller.insertTemplate(body)} />
        </>
      )}
      <ChatThread
        state={state}
        approvals={approvals}
        onApply={(id) => void controller.approvals.apply(id)}
        onReject={(id) => void controller.approvals.reject(id)}
        onDismissBanner={() => controller.dismissBanner()}
      />
      <Composer
        draft={state.draft}
        busy={state.busy}
        contextKind={state.contextKind}
        onDraftChange={(text) => controller.setDraft(text)}
        onContextKindChange={(kind) => controller.setContextKind(kind)}
        onSend={() => void controller.send()}
      />
      <BrandingFooter branding={session.branding} />

      {historyOpen && (
        <HistoryPanel load={loadHistory} onResume={resume} onClose={() => setHistoryOpen(false)} />
      )}
    </div>
  );
}
