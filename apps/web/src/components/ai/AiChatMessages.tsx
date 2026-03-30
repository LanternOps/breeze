import { useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Bot, User } from 'lucide-react';
import AiToolCallCard from './AiToolCallCard';
import AiApprovalDialog from './AiApprovalDialog';
import AiPlanReviewCard from './AiPlanReviewCard';
import AiPlanProgressBar from './AiPlanProgressBar';
import type { ActionPlanStep } from '@breeze/shared';
import { DOCS_BASE_URL } from '@breeze/shared';
import { useHelpStore } from '@/stores/helpStore';

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
  { label: 'Check server health', prompt: 'Check the health status of all Windows servers — show CPU, RAM, disk usage and any alerts', dotColor: 'bg-success' },
  { label: 'Show critical alerts', prompt: 'List all critical and high severity alerts from the last 24 hours with device details', dotColor: 'bg-warning' },
  { label: 'Find offline devices', prompt: 'Show me all devices that are currently offline and when they were last seen', dotColor: 'bg-warning' },
  { label: 'Security overview', prompt: 'Give me a security overview — any active threats, recent scans, and devices needing attention', dotColor: 'bg-success' },
  { label: 'Disk space report', prompt: 'Which devices are running low on disk space? Show devices with over 80% disk usage', dotColor: 'bg-primary' },
  { label: 'Recent activity', prompt: 'Show me the most recent audit log entries — what actions were taken in the last few hours?', dotColor: 'bg-primary' }
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
        <Bot className="h-10 w-10 text-muted-foreground" />
        <h3 className="mt-3 text-sm font-medium text-foreground">Breeze AI Assistant</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Ask about your devices, alerts, metrics, or troubleshoot issues.
        </p>
        <div className="mt-4 w-full space-y-1.5">
          {QUICK_ACTIONS.map((action) => (
            <button
              key={action.label}
              onClick={() => onSendQuickAction?.(action.prompt)}
              className="flex items-center w-full rounded-md border border-border px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${action.dotColor} mr-2 flex-shrink-0`} />
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
                <p className="text-sm text-gray-900 whitespace-pre-wrap dark:text-gray-200">{msg.content}</p>
              </div>
            </div>
          );
        }

        if (msg.role === 'assistant') {
          return (
            <div key={msg.id} className="flex gap-2">
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary">
                <Bot className="h-3.5 w-3.5 text-white" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="prose prose-sm max-w-none text-sm text-gray-900 prose-headings:text-sm prose-headings:font-semibold prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0 prose-pre:my-2 prose-pre:overflow-x-auto prose-code:text-xs prose-code:before:content-none prose-code:after:content-none dark:prose-invert dark:text-gray-200">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      a: ({ href, children }) => {
                        if (href && DOCS_BASE_URL && href.startsWith(DOCS_BASE_URL)) {
                          return (
                            <a
                              href={href}
                              onClick={(e) => {
                                e.preventDefault();
                                useHelpStore.getState().open(href);
                              }}
                              className="cursor-pointer"
                            >
                              {children}
                            </a>
                          );
                        }
                        return (
                          <a
                            href={href && /^https?:\/\//.test(href) ? href : '#'}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {children}
                          </a>
                        );
                      },
                    }}
                  >
                    {msg.content}
                  </ReactMarkdown>
                  {msg.isStreaming && (
                    <span className="inline-block h-4 w-1 animate-pulse bg-gray-500 dark:bg-gray-400" />
                  )}
                </div>
              </div>
            </div>
          );
        }

        if (msg.role === 'tool_use') {
          // Find matching tool_result by toolUseId, or fall back to the immediately following tool_result
          const idx = messages.indexOf(msg);
          const nextMsg = idx >= 0 && idx + 1 < messages.length ? messages[idx + 1] : undefined;
          const hasResult = messages.some(m => m.role === 'tool_result' && m.toolUseId && m.toolUseId === msg.toolUseId)
            || (nextMsg?.role === 'tool_result');
          return (
            <AiToolCallCard
              key={msg.id}
              toolName={msg.toolName ?? 'Unknown tool'}
              input={msg.toolInput}
              isExecuting={!hasResult}
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
