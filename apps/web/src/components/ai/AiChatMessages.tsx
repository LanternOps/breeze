import { useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Bot, User } from 'lucide-react';
import AiToolCallCard from './AiToolCallCard';
import AiApprovalDialog from './AiApprovalDialog';
import AiPlanReviewCard from './AiPlanReviewCard';
import AiPlanProgressBar from './AiPlanProgressBar';
import type { ActionPlanStep } from '@breeze/shared';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool_use' | 'tool_result';
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
  toolUseId?: string;
  isError?: boolean;
  isStreaming?: boolean;
}

interface PendingApproval {
  executionId: string;
  toolName: string;
  input: Record<string, unknown>;
  description: string;
  deviceContext?: { hostname: string; displayName?: string; status: string; lastSeenAt?: string; activeSessions?: Array<{ username: string; activityState?: string; idleMinutes?: number; sessionType: string }> };
}

const QUICK_ACTIONS = [
  { label: 'Check server health', prompt: 'Check the health status of all Windows servers — show CPU, RAM, disk usage and any alerts' },
  { label: 'Show critical alerts', prompt: 'List all critical and high severity alerts from the last 24 hours with device details' },
  { label: 'Find offline devices', prompt: 'Show me all devices that are currently offline and when they were last seen' },
  { label: 'Security overview', prompt: 'Give me a security overview — any active threats, recent scans, and devices needing attention' },
  { label: 'Disk space report', prompt: 'Which devices are running low on disk space? Show devices with over 80% disk usage' },
  { label: 'Recent activity', prompt: 'Show me the most recent audit log entries — what actions were taken in the last few hours?' }
];

interface PendingPlan {
  planId: string;
  steps: ActionPlanStep[];
}

interface ActivePlan {
  planId: string;
  steps: ActionPlanStep[];
  currentStepIndex: number;
  status: 'executing' | 'completed' | 'aborted';
}

interface AiChatMessagesProps {
  messages: Message[];
  pendingApproval: PendingApproval | null;
  pendingPlan?: PendingPlan | null;
  activePlan?: ActivePlan | null;
  approvalMode?: string;
  isPaused?: boolean;
  onApprove: (executionId: string) => void;
  onReject: (executionId: string) => void;
  onApprovePlan?: (approved: boolean) => void;
  onAbortPlan?: () => void;
  onPauseAi?: (paused: boolean) => void;
  onSendQuickAction?: (prompt: string) => void;
}

export default function AiChatMessages({
  messages, pendingApproval, pendingPlan, activePlan, approvalMode, isPaused,
  onApprove, onReject, onApprovePlan, onAbortPlan, onPauseAi, onSendQuickAction,
}: AiChatMessagesProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, pendingApproval]);

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-6">
        <Bot className="h-10 w-10 text-gray-600" />
        <h3 className="mt-3 text-sm font-medium text-gray-300">Breeze AI Assistant</h3>
        <p className="mt-1 text-xs text-gray-500">
          Ask about your devices, alerts, metrics, or troubleshoot issues.
        </p>
        <div className="mt-4 w-full space-y-1.5">
          {QUICK_ACTIONS.map((action) => (
            <button
              key={action.label}
              onClick={() => onSendQuickAction?.(action.prompt)}
              className="w-full rounded-md border border-gray-700 bg-gray-800/50 px-3 py-2 text-left text-xs text-gray-400 transition-colors hover:border-purple-600/50 hover:bg-gray-800 hover:text-gray-200"
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-3">
      {messages.map((msg) => {
        if (msg.role === 'user') {
          return (
            <div key={msg.id} className="flex gap-2">
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-600">
                <User className="h-3.5 w-3.5 text-white" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-gray-200 whitespace-pre-wrap">{msg.content}</p>
              </div>
            </div>
          );
        }

        if (msg.role === 'assistant') {
          return (
            <div key={msg.id} className="flex gap-2">
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-purple-600">
                <Bot className="h-3.5 w-3.5 text-white" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="prose prose-sm prose-invert max-w-none text-sm text-gray-200 prose-headings:text-sm prose-headings:font-semibold prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0 prose-pre:my-2 prose-pre:overflow-x-auto prose-code:text-xs prose-code:before:content-none prose-code:after:content-none">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      a: ({ href, children }) => (
                        <a
                          href={href && /^https?:\/\//.test(href) ? href : '#'}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {children}
                        </a>
                      ),
                    }}
                  >
                    {msg.content}
                  </ReactMarkdown>
                  {msg.isStreaming && (
                    <span className="inline-block h-4 w-1 animate-pulse bg-gray-400" />
                  )}
                </div>
              </div>
            </div>
          );
        }

        if (msg.role === 'tool_use') {
          return (
            <AiToolCallCard
              key={msg.id}
              toolName={msg.toolName ?? 'Unknown tool'}
              input={msg.toolInput}
              isExecuting={!messages.some(m => m.role === 'tool_result' && m.toolUseId === msg.toolUseId)}
            />
          );
        }

        if (msg.role === 'tool_result') {
          return (
            <AiToolCallCard
              key={msg.id}
              toolName={msg.toolName ?? 'Tool result'}
              output={msg.toolOutput ?? msg.content}
              isError={msg.isError}
            />
          );
        }

        return null;
      })}

      {pendingApproval && (
        <AiApprovalDialog
          toolName={pendingApproval.toolName}
          description={pendingApproval.description}
          input={pendingApproval.input}
          deviceContext={pendingApproval.deviceContext}
          onApprove={() => onApprove(pendingApproval.executionId)}
          onReject={() => onReject(pendingApproval.executionId)}
        />
      )}

      {pendingPlan && onApprovePlan && (
        <AiPlanReviewCard
          steps={pendingPlan.steps}
          onApprove={() => onApprovePlan(true)}
          onReject={() => onApprovePlan(false)}
        />
      )}

      {activePlan && (
        <AiPlanProgressBar
          steps={activePlan.steps}
          currentStepIndex={activePlan.currentStepIndex}
          status={activePlan.status}
          onAbort={onAbortPlan}
        />
      )}

      {approvalMode === 'auto_approve' && !isPaused && onPauseAi && (
        <div className="sticky bottom-0 flex justify-center py-2">
          <button
            onClick={() => onPauseAi(true)}
            className="rounded-full bg-red-600/90 px-4 py-1.5 text-xs font-medium text-white shadow-lg transition-colors hover:bg-red-500"
          >
            Pause AI
          </button>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
