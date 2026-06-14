import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { ChatController } from '../chat/chatController';
import { ChatThread } from './ChatThread';
import { ChatToolbar } from './ChatToolbar';
import { Composer } from './Composer';
import { TemplatePicker } from './TemplatePicker';
import { BrandingFooter } from './BrandingFooter';
import type { ClientSession } from '../auth/session';

export function ChatPane({ session }: { session: ClientSession }) {
  const controller = useMemo(() => new ChatController(), []);
  useEffect(() => () => controller.dispose(), [controller]);

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

  return (
    <div className="flex h-screen flex-col">
      <ChatToolbar
        writeApproval={state.writeApproval}
        autoApply={state.autoApply}
        flagged={state.flagged}
        canFlag={conversationStarted}
        onToggleAuto={(value) => controller.setAutoApply(value)}
        onFlag={() => void controller.flagConversation()}
      />
      {empty && <TemplatePicker onPick={(body) => controller.insertTemplate(body)} />}
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
    </div>
  );
}
