import AiChatMessages from '../ai/AiChatMessages';
import AiChatInput from '../ai/AiChatInput';
import AiContextBadge from '../ai/AiContextBadge';
import AiCostIndicator from '../ai/AiCostIndicator';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import type { TabState } from '@/stores/workspaceStore';

interface WorkspaceChatPanelProps {
  tab: TabState;
}

export default function WorkspaceChatPanel({ tab }: WorkspaceChatPanelProps) {
  const {
    sendMessage,
    approveExecution,
    approvePlan,
    abortPlan,
    pauseAi,
    interruptResponse,
    clearError,
  } = useWorkspaceStore();

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
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
            Dismiss
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
      />

      {/* Input */}
      <AiChatInput
        onSend={(content) => sendMessage(tab.id, content)}
        onInterrupt={() => interruptResponse(tab.id)}
        disabled={tab.isLoading}
        isStreaming={tab.isStreaming}
        isInterrupting={tab.isInterrupting}
      />
    </div>
  );
}
