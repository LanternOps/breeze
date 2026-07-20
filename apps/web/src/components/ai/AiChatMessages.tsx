import { useEffect, useRef } from "react";
import { shouldAutoScroll } from "./aiChatScroll";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot, User } from "lucide-react";
import AiToolCallCard from "./AiToolCallCard";
import AiApprovalDialog from "./AiApprovalDialog";
import AiPlanReviewCard from "./AiPlanReviewCard";
import AiPlanProgressBar from "./AiPlanProgressBar";
import type { ActionPlanStep } from "@breeze/shared";
import { isDocsUrl } from "@/lib/safeHref";
import { useHelpStore } from "@/stores/helpStore";
import { useTranslation } from "react-i18next";

interface Message {
  id: string;
  role: "user" | "assistant" | "tool_use" | "tool_result";
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
  deviceContext?: {
    hostname: string;
    displayName?: string;
    status: string;
    lastSeenAt?: string;
    activeSessions?: Array<{
      username: string;
      activityState?: string;
      idleMinutes?: number;
      sessionType: string;
    }>;
  };
  /** Tier-3 durable action-intent (spec §6.1) — see AiApprovalDialog's prop doc. */
  intentBacked?: boolean;
  /**
   * The requester's own fanned-out approval row, set only when the server
   * decided the requester is the sole eligible approver. Undefined in a
   * multi-approver org — that absence is what preserves four-eyes.
   */
  selfApprovalRequestId?: string;
}

interface PendingPlan {
  planId: string;
  steps: ActionPlanStep[];
}

interface ActivePlan {
  planId: string;
  steps: ActionPlanStep[];
  currentStepIndex: number;
  status: "executing" | "completed" | "aborted";
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
  /** Inline intent decide succeeded — drop the card (the SSE stream carries the outcome). */
  onIntentDecided?: () => void;
}

export default function AiChatMessages({
  messages,
  pendingApproval,
  pendingPlan,
  activePlan,
  approvalMode,
  isPaused,
  onApprove,
  onReject,
  onApprovePlan,
  onAbortPlan,
  onPauseAi,
  onSendQuickAction,
  onIntentDecided,
}: AiChatMessagesProps) {
  const { t } = useTranslation("ai");
  const quickActions = [
    {
      label: t("aiChatMessages.quickActions.serverHealth.label"),
      prompt: t("aiChatMessages.quickActions.serverHealth.prompt"),
      dotColor: "bg-success",
    },
    {
      label: t("aiChatMessages.quickActions.criticalAlerts.label"),
      prompt: t("aiChatMessages.quickActions.criticalAlerts.prompt"),
      dotColor: "bg-warning",
    },
    {
      label: t("aiChatMessages.quickActions.offlineDevices.label"),
      prompt: t("aiChatMessages.quickActions.offlineDevices.prompt"),
      dotColor: "bg-warning",
    },
    {
      label: t("aiChatMessages.quickActions.securityOverview.label"),
      prompt: t("aiChatMessages.quickActions.securityOverview.prompt"),
      dotColor: "bg-success",
    },
    {
      label: t("aiChatMessages.quickActions.diskSpace.label"),
      prompt: t("aiChatMessages.quickActions.diskSpace.prompt"),
      dotColor: "bg-primary",
    },
    {
      label: t("aiChatMessages.quickActions.recentActivity.label"),
      prompt: t("aiChatMessages.quickActions.recentActivity.prompt"),
      dotColor: "bg-primary",
    },
  ];
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // Whether the viewport is currently pinned near the bottom. Seeded `true` so
  // the first render (and a freshly opened panel) auto-scrolls. We only flip it
  // off when the user deliberately scrolls up to read history.
  const pinnedToBottomRef = useRef(true);
  // Holds the pending rAF id so a burst of streaming re-renders coalesces into a
  // single post-paint scroll instead of issuing a redundant scroll per delta.
  const scrollFrameRef = useRef<number | null>(null);

  // #1713: keep the conversation anchored to the bottom on submit + streaming.
  // The previous implementation called `scrollIntoView({ behavior: 'smooth' })`
  // on every `messages` change. During streaming the messages array is recreated
  // on each content delta, so many smooth-scroll animations were issued and
  // interrupted mid-flight — leaving the viewport stranded at the top. The fix:
  // (1) only auto-scroll when the user is already pinned to the bottom, so we
  // don't yank someone reading history; (2) defer to after paint via rAF so the
  // scroll resolves against the final DOM; (3) set scrollTop directly (instant)
  // rather than re-issuing interruptible smooth animations.
  // Re-runs on any state that changes panel height — the messages array plus the
  // pending-approval / pending-plan / active-plan cards — so the anchor tracks
  // every content growth, not just streamed text.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || !pinnedToBottomRef.current) return;

    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current);
    }
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const el = scrollContainerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });

    return () => {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [messages, pendingApproval, pendingPlan, activePlan]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedToBottomRef.current = shouldAutoScroll(distanceFromBottom);
  };

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-6">
        <Bot className="h-10 w-10 text-muted-foreground" />
        <h3 className="mt-3 text-sm font-medium text-foreground">
          {t("aiChatMessages.title")}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("aiChatMessages.description")}
        </p>
        <div className="mt-4 w-full space-y-1.5">
          {quickActions.map((action) => (
            <button
              key={action.label}
              onClick={() => onSendQuickAction?.(action.prompt)}
              className="flex items-center w-full rounded-md border border-border px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <span
                className={`inline-block h-1.5 w-1.5 rounded-full ${action.dotColor} mr-2 shrink-0`}
              />
              {action.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={scrollContainerRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto p-3 space-y-3"
    >
      {messages.map((msg) => {
        if (msg.role === "user") {
          return (
            <div key={msg.id} className="flex gap-2">
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-600">
                <User className="h-3.5 w-3.5 text-white" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-gray-900 whitespace-pre-wrap dark:text-gray-200">
                  {msg.content}
                </p>
              </div>
            </div>
          );
        }

        if (msg.role === "assistant") {
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
                        // Origin check (not a string prefix): a docs-lookalike host
                        // (e.g. docs.breezermm.com.evil.com) is NOT treated as a
                        // trusted in-app docs link and instead falls through to the
                        // safe external-link branch below.
                        if (isDocsUrl(href)) {
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
                            href={
                              href && /^https?:\/\//.test(href) ? href : "#"
                            }
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

        if (msg.role === "tool_use") {
          // Find matching tool_result by toolUseId, or fall back to the immediately following tool_result
          const idx = messages.indexOf(msg);
          const nextMsg =
            idx >= 0 && idx + 1 < messages.length
              ? messages[idx + 1]
              : undefined;
          const hasResult =
            messages.some(
              (m) =>
                m.role === "tool_result" &&
                m.toolUseId &&
                m.toolUseId === msg.toolUseId,
            ) || nextMsg?.role === "tool_result";
          return (
            <AiToolCallCard
              key={msg.id}
              toolName={msg.toolName ?? t("aiChatMessages.unknownTool")}
              input={msg.toolInput}
              isExecuting={!hasResult}
            />
          );
        }

        if (msg.role === "tool_result") {
          return (
            <AiToolCallCard
              key={msg.id}
              toolName={msg.toolName ?? t("aiChatMessages.toolResult")}
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
          intentBacked={pendingApproval.intentBacked}
          selfApprovalRequestId={pendingApproval.selfApprovalRequestId}
          onIntentDecided={onIntentDecided}
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

      {approvalMode === "auto_approve" && !isPaused && onPauseAi && (
        <div className="sticky bottom-0 flex justify-center py-2">
          <button
            onClick={() => onPauseAi(true)}
            className="rounded-full bg-red-600/90 px-4 py-1.5 text-xs font-medium text-white shadow-lg transition-colors hover:bg-red-500"
          >
            {t("aiChatMessages.pauseAi")}
          </button>
        </div>
      )}
    </div>
  );
}
