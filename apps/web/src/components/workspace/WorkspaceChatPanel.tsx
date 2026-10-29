import { useState } from "react";
import { Sparkles } from "lucide-react";
import WispWelcome from "../wisp/WispWelcome";
import { useWispScopeLabel } from "../wisp/useWispScopeLabel";

import AiChatMessages from "../ai/AiChatMessages";
import AiChatInput from "../ai/AiChatInput";
import AiContextBadge from "../ai/AiContextBadge";
import AiCostIndicator from "../ai/AiCostIndicator";
import WorkspaceSessionChips from "./WorkspaceSessionChips";
import CreateTicketFromChatModal, {
  type CreateTicketFromChatModalProps,
} from "../ai/CreateTicketFromChatModal";
import { showToast } from "../shared/Toast";
import { ActionError, handleActionError } from "@/lib/runAction";
import { useWorkspaceStore } from "@/stores/workspaceStore";
import type { AiTicketDraft } from "@breeze/shared";
import type { TabState } from "@/stores/workspaceStore";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";

interface WorkspaceChatPanelProps {
  tab: TabState;
  /** #9427 W3: move this tab's conversation to the side panel (WorkspacePage owns the flow). */
  onContinueInPanel?: () => void;
}

export default function WorkspaceChatPanel({ tab, onContinueInPanel }: WorkspaceChatPanelProps) {
  const { t } = useTranslation("ai");
  const {
    sendMessage,
    approveExecution,
    clearPendingApproval,
    approvePlan,
    abortPlan,
    pauseAi,
    interruptResponse,
    clearError,
    draftTicketFromChat,
    saveTicketFromChat,
    setComposerDraft,
  } = useWorkspaceStore();

  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState<AiTicketDraft | null>(null);
  const [busy, setBusy] = useState(false);

  // #10195: a tab under a Wisp grant speaks as Wisp throughout — its replies,
  // its empty state and its composer — not only in the mode label above.
  const tabWisp = tab.wisp?.kind === "wisp" ? tab.wisp : null;
  const wispScopeLabel = useWispScopeLabel(tabWisp?.orgId ?? null);

  const hasAssistantMsg = tab.messages.some((m) => m.role === "assistant");
  const canCreateTicket = !!tab.sessionId && hasAssistantMsg;

  const openTicketModal = async () => {
    setBusy(true);
    setModalOpen(true);
    try {
      setDraft(await draftTicketFromChat(tab.id));
    } catch (err) {
      console.error(
        "[Workspace] Ticket draft failed; falling back to manual entry:",
        err,
      );
      setDraft(null);
      showToast({
        type: "warning",
        message: t("workspaceChatPanel.errors.autoDraft"),
      });
    } finally {
      setBusy(false);
    }
  };

  const submitTicket: CreateTicketFromChatModalProps["onSubmit"] = async (
    payload,
  ) => {
    setBusy(true);
    try {
      await saveTicketFromChat(tab.id, { ...payload, priority: undefined });
      setModalOpen(false);
      setDraft(null);
    } catch (err) {
      if (err instanceof ActionError) return; // already toasted by runAction
      handleActionError(err, t("workspaceChatPanel.errors.createTicket"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-end gap-2 border-b border-gray-200/50 px-4 py-1.5 dark:border-gray-700/50">
        <div className="mr-auto flex min-w-0 items-center gap-2">
          {/* #10142: say which assistant this tab is — Wisp only when its
              session runs (or will be created) under a grant. Nothing while
              the tab is still finding out. */}
          {tab.wisp && (
            <span
              data-testid="workspace-chat-mode"
              data-mode={tab.wisp.kind}
              className={`inline-flex shrink-0 items-center gap-1 text-xs font-semibold ${
                tab.wisp.kind === "wisp" ? "text-primary" : "text-gray-600 dark:text-gray-300"
              }`}
            >
              {tab.wisp.kind === "wisp" && <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />}
              {tab.wisp.kind === "wisp" ? t("wisp.title") : t("aiChatSidebar.title")}
            </span>
          )}
          <WorkspaceSessionChips
            orgId={tab.orgId}
            deviceLabel={tab.deviceLabel}
            m365ConnectionId={tab.m365ConnectionId}
          />
        </div>
        {tab.sessionId && onContinueInPanel && (
          <button
            type="button"
            onClick={onContinueInPanel}
            data-testid="workspace-continue-in-panel"
            className="rounded px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            {t("aiConversationMove.continueInPanel")}
          </button>
        )}
        <button
          type="button"
          onClick={openTicketModal}
          disabled={!canCreateTicket}
          className="rounded px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-40 dark:text-blue-400 dark:hover:bg-blue-950/40"
        >
          {t("workspaceChatPanel.createTicket")}
        </button>
      </div>

      {/* Cost indicator */}
      <AiCostIndicator enabled isStreaming={tab.isStreaming} />

      {/* Context badge */}
      {tab.pageContext && (
        <div className="border-b border-gray-200/50 px-4 py-2 dark:border-gray-700/50">
          <AiContextBadge context={tab.pageContext} />
        </div>
      )}

      {/* Error banner */}
      {tab.error && (
        <div
          className="flex items-center justify-between gap-2 border-b border-red-300/50 bg-red-100/50 px-4 py-2 dark:border-red-800/50 dark:bg-red-900/20"
          data-testid="workspace-error-banner"
        >
          <span className="text-xs text-red-400">
            {tab.errorAction === "continue_in_panel" ? t("aiConversationMove.chooseModelInPanel") : tab.error}
          </span>
          {tab.errorAction === "continue_in_panel" && onContinueInPanel && (
            <button
              type="button"
              onClick={onContinueInPanel}
              data-testid="workspace-error-continue-in-panel"
              className="ml-auto shrink-0 text-xs font-medium text-red-400 underline underline-offset-2 hover:text-red-300"
            >
              {t("aiConversationMove.continueInPanel")}
            </button>
          )}
          <button
            onClick={() => clearError(tab.id)}
            className="text-xs text-red-400 hover:text-red-300"
          >
            {t("workspaceChatPanel.dismiss")}
          </button>
        </div>
      )}

      {/* #9427: attached to a running turn whose replay was too large to send. */}
      {tab.joinedMidResponse && (
        <div
          className="border-b border-gray-200/50 px-4 py-1.5 text-xs text-gray-500 dark:border-gray-700/50 dark:text-gray-400"
          data-testid="workspace-joined-mid-response"
        >
          {t("aiConversationMove.joinedMidResponse")}
        </div>
      )}

      {/* Messages */}
      <AiChatMessages
        messages={tab.messages}
        chatRuns={tab.chatRuns}
        pendingApproval={tab.pendingApproval}
        pendingPlan={tab.pendingPlan}
        activePlan={tab.activePlan}
        approvalMode={tab.approvalMode}
        isPaused={tab.isPaused}
        onApprove={(id) => approveExecution(tab.id, id, true)}
        onReject={(id) => approveExecution(tab.id, id, false)}
        onApprovePlan={(approved) => approvePlan(tab.id, approved)}
        onAbortPlan={() => abortPlan(tab.id)}
        onPauseAi={(paused) => pauseAi(tab.id, paused)}
        onSendQuickAction={(prompt) => sendMessage(tab.id, prompt)}
        onIntentDecided={() => clearPendingApproval(tab.id)}
        layout="page"
        showTimeDividers
        assistantLabel={tabWisp ? t("wisp.title") : undefined}
        emptyState={
          tabWisp ? (
            <WispWelcome
              scopeLabel={wispScopeLabel}
              onSuggest={(prompt) => sendMessage(tab.id, prompt)}
              briefNote={false}
            />
          ) : undefined
        }
      />

      {/* Input, in the thread's reading-width column (W01 #10211) */}
      <div className="mx-auto w-full max-w-3xl" data-testid="workspace-composer">
        <AiChatInput
          onSend={(content) => sendMessage(tab.id, content)}
          value={tab.composerDraft}
          onValueChange={(value) => setComposerDraft(tab.id, value)}
          onInterrupt={() => interruptResponse(tab.id)}
          disabled={tab.isLoading}
          isStreaming={tab.isStreaming}
          isInterrupting={tab.isInterrupting}
          placeholder={tabWisp ? t("wisp.composer.placeholder") : undefined}
        />
      </div>

      {modalOpen && (
        <CreateTicketFromChatModal
          key={draft ? "draft" : "manual"}
          draft={draft}
          orgName={draft?.orgName ?? null}
          deviceHostname={draft?.deviceHostname ?? null}
          busy={busy}
          onCancel={() => {
            if (!busy) {
              setModalOpen(false);
              setDraft(null);
            }
          }}
          onSubmit={submitTicket}
        />
      )}
    </div>
  );
}
