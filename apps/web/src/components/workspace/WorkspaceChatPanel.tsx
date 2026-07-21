import { useState } from "react";

import AiChatMessages from "../ai/AiChatMessages";
import AiChatInput from "../ai/AiChatInput";
import AiContextBadge from "../ai/AiContextBadge";
import AiCostIndicator from "../ai/AiCostIndicator";
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
}

export default function WorkspaceChatPanel({ tab }: WorkspaceChatPanelProps) {
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
  } = useWorkspaceStore();

  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState<AiTicketDraft | null>(null);
  const [busy, setBusy] = useState(false);

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
      <div className="flex items-center justify-end border-b border-gray-200/50 px-4 py-1.5 dark:border-gray-700/50">
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
      <AiCostIndicator enabled />

      {/* Context badge */}
      {tab.pageContext && (
        <div className="border-b border-gray-200/50 px-4 py-2 dark:border-gray-700/50">
          <AiContextBadge context={tab.pageContext} />
        </div>
      )}

      {/* Error banner */}
      {tab.error && (
        <div className="flex items-center justify-between border-b border-red-300/50 bg-red-100/50 px-4 py-2 dark:border-red-800/50 dark:bg-red-900/20">
          <span className="text-xs text-red-400">{tab.error}</span>
          <button
            onClick={() => clearError(tab.id)}
            className="text-xs text-red-400 hover:text-red-300"
          >
            {t("workspaceChatPanel.dismiss")}
          </button>
        </div>
      )}

      {/* Messages */}
      <AiChatMessages
        messages={tab.messages}
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
      />

      {/* Input */}
      <AiChatInput
        onSend={(content) => sendMessage(tab.id, content)}
        onInterrupt={() => interruptResponse(tab.id)}
        disabled={tab.isLoading}
        isStreaming={tab.isStreaming}
        isInterrupting={tab.isInterrupting}
      />

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
