import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ChatController } from '../chat/chatController';
import { ChatThread } from './ChatThread';
import { ChatToolbar } from './ChatToolbar';
import { Composer } from './Composer';
import { TemplatePicker } from './TemplatePicker';
import { QuickActions } from './QuickActions';
import { BrandingFooter } from './BrandingFooter';
import { HistoryPanel } from './HistoryPanel';
import { ChangesPanel } from './ChangesPanel';
import type { ClientHost } from '../api/types';
import type { ClientSession } from '../auth/session';
import type { HostAdapter } from '../host/types';

/**
 * The composition root: the single place the concrete host adapter is chosen and
 * injected into the host-neutral controller/components. `host` is the
 * object-model seam (Excel/Word/…); `clientHost` is the wire discriminant
 * threaded to the server so it serves the matching tool registry + prompt.
 */
export function ChatPane({
  session,
  host,
  clientHost,
}: {
  session: ClientSession;
  host: HostAdapter;
  clientHost: ClientHost;
}) {
  const controller = useMemo(() => new ChatController({ host, clientHost }), [host, clientHost]);
  useEffect(() => () => controller.dispose(), [controller]);

  const [historyOpen, setHistoryOpen] = useState(false);
  // Changelog: the client-facing "here's what the assistant changed" panel.
  const [changesOpen, setChangesOpen] = useState(false);

  const state = useSyncExternalStore(
    useCallback((cb: () => void) => controller.subscribe(cb), [controller]),
    () => controller.getState(),
  );
  const approvals = useSyncExternalStore(
    useCallback((cb: () => void) => controller.approvals.subscribe(cb), [controller]),
    () => controller.approvals.getPending(),
  );
  const appliedChanges = useSyncExternalStore(
    useCallback((cb: () => void) => controller.approvals.subscribe(cb), [controller]),
    () => controller.approvals.getAppliedChanges(),
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
      {/* pr-10: keep the right-side buttons clear of Office's pinned top-right pane button (Mac). */}
      <div className="flex items-center justify-between border-b border-gray-100 py-1.5 pl-3 pr-10">
        <button
          type="button"
          onClick={() => controller.startNewSession()}
          className="rounded-md px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100"
          data-testid="new-chat-button"
        >
          + New chat
        </button>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setChangesOpen(true)}
            className="rounded-md px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100"
            data-testid="changes-button"
          >
            Changes
            {appliedChanges.length > 0 && (
              <span
                className="ml-1 rounded-full bg-blue-100 px-1.5 text-blue-700"
                data-testid="changes-count"
              >
                {appliedChanges.length}
              </span>
            )}
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
          <QuickActions
            capture={host.captureContext.bind(null, 'selection')}
            onSelect={(prompt) => void controller.send(prompt)}
            {...(host.quickActions ? { compute: host.quickActions } : {})}
          />
          <TemplatePicker host={clientHost} onPick={(body) => controller.insertTemplate(body)} />
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
        captureSelectionAddress={host.captureSelectionAddress}
        subscribeSelectionChanged={host.subscribeSelectionChanged}
        onDraftChange={(text) => controller.setDraft(text)}
        onContextKindChange={(kind) => controller.setContextKind(kind)}
        onSend={() => void controller.send()}
        {...(host.contextOptions ? { contextOptions: host.contextOptions } : {})}
        {...(host.composerPlaceholder ? { composerPlaceholder: host.composerPlaceholder } : {})}
        {...(host.formatContextChip ? { formatContextChip: host.formatContextChip } : {})}
        {...(host.hideContextPicker ? { hideContextPicker: true } : {})}
      />
      <BrandingFooter branding={session.branding} />

      {historyOpen && (
        <HistoryPanel load={loadHistory} onResume={resume} onClose={() => setHistoryOpen(false)} />
      )}

      {changesOpen && (
        <ChangesPanel
          changes={appliedChanges}
          onRevert={(id) => void controller.approvals.revertChange(id)}
          onClose={() => setChangesOpen(false)}
        />
      )}
    </div>
  );
}
