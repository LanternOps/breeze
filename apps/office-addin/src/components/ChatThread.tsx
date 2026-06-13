import type { ChatState, ThreadMessage } from '../chat/chatController';
import type { PendingApproval } from '../approval/approvalStore';
import { WritePreviewCard } from './WritePreviewCard';

const TOOL_STATUS_LABEL: Record<string, string> = {
  success: 'ran',
  error: 'failed',
  rejected: 'rejected',
  timeout: 'timed out',
};

function ToolRow({ item }: { item: Extract<ThreadMessage, { kind: 'tool' }> }) {
  return (
    <div className="my-1 flex items-center gap-2 text-xs text-gray-500" data-testid="tool-activity">
      <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono">{item.toolName}</span>
      <span>{TOOL_STATUS_LABEL[item.status] ?? item.status}</span>
      {item.redactions > 0 && (
        <span
          className="rounded bg-purple-100 px-1.5 py-0.5 text-purple-700"
          data-testid="redaction-badge"
        >
          {item.redactions} redacted
        </span>
      )}
    </div>
  );
}

export function ChatThread({
  state,
  approvals,
  onApply,
  onReject,
  onDismissBanner,
}: {
  state: ChatState;
  approvals: readonly PendingApproval[];
  onApply: (toolUseId: string) => void;
  onReject: (toolUseId: string) => void;
  onDismissBanner: () => void;
}) {
  return (
    <div className="flex-1 space-y-2 overflow-y-auto p-3">
      {state.thread.map((item) =>
        item.kind === 'user' ? (
          <div key={item.id} className="ml-6 whitespace-pre-wrap rounded-lg bg-blue-600 p-2 text-sm text-white">
            {item.text}
          </div>
        ) : item.kind === 'assistant' ? (
          <div key={item.id} className="mr-6 whitespace-pre-wrap rounded-lg bg-gray-100 p-2 text-sm text-gray-900">
            {item.text}
          </div>
        ) : (
          <ToolRow key={item.id} item={item} />
        ),
      )}
      {state.streamingText && (
        <div
          className="mr-6 whitespace-pre-wrap rounded-lg bg-gray-100 p-2 text-sm text-gray-900"
          data-testid="streaming-message"
        >
          {state.streamingText}
          <span className="animate-pulse">▍</span>
        </div>
      )}
      {approvals.map((approval) => (
        <WritePreviewCard
          key={approval.toolUseId}
          approval={approval}
          onApply={() => onApply(approval.toolUseId)}
          onReject={() => onReject(approval.toolUseId)}
        />
      ))}
      {state.banner && (
        <div
          className={`flex items-start justify-between gap-2 rounded-md border p-2 text-xs ${
            state.banner.kind === 'blocked'
              ? 'border-purple-300 bg-purple-50 text-purple-800'
              : 'border-red-300 bg-red-50 text-red-700'
          }`}
          data-testid="chat-banner"
        >
          <span>{state.banner.text}</span>
          <button type="button" onClick={onDismissBanner} className="font-semibold" aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
    </div>
  );
}
