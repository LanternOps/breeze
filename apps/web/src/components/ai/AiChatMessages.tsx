import { Fragment, useEffect, useMemo, useRef, type ReactNode } from "react";
import { shouldAutoScroll } from "./aiChatScroll";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot } from "lucide-react";
import AiToolCallCard from "./AiToolCallCard";
import AiToolActivityGroup from "./AiToolActivityGroup";
import FlowDraftCard, { parseFlowToolResult } from "../flows/FlowDraftCard";
import { CallerVerificationRefusal } from "../callerVerification/CallerVerificationRefusal";
import AiApprovalDialog from "./AiApprovalDialog";
import AiPlanReviewCard from "./AiPlanReviewCard";
import AiPlanProgressBar from "./AiPlanProgressBar";
import type { ActionPlanStep } from "@breeze/shared";
import { isDocsUrl } from "@/lib/safeHref";
import { SafeMarkdownImage } from "@/lib/safeMarkdownImage";
import { useHelpStore } from "@/stores/helpStore";
import { useTranslation } from "react-i18next";
// Single source of truth: the store owns the shape the stream writes (incl.
// intentBacked / selfApprovalRequestId). Redeclaring it here meant both
// copies had to be edited in lockstep. Type-only import — no runtime edge to
// the store, so no cycle.
import type { ChatRunState, PendingApproval } from "@/stores/processStreamEvent";
import AiRunCard from "./AiRunCard";
import { dividerParts, groupChatUnits, type ChatRow, type ChatUnit, type ToolCall } from "./aiChatGrouping";

export { pairToolResults } from "./aiChatGrouping";

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
  messages: ChatRow[];
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
  /**
   * Execution plane W05 — analysis runs launched from this conversation, keyed
   * by run id. Defaulted to `{}` so every existing caller and test harness
   * keeps compiling; the run card polls regardless and treats this as a live
   * upgrade, so an empty map degrades to "poll only", never to a blank card.
   */
  chatRuns?: Record<string, ChatRunState>;
  /**
   * Wisp companion W01 (spec §4.2). `page` centers the thread at reading
   * width (the Wisp home, /ai/chat); `panel` (default) is the 400 px docked
   * panel's dense list.
   */
  layout?: "panel" | "page";
  /** The name over the first reply of each run ("Wisp"); defaults to "Breeze AI". */
  assistantLabel?: string;
  /** Time dividers from each message's createdAt (off by default; the docked panel keeps them off). */
  showTimeDividers?: boolean;
  /** Rendered inside the scroll container before the first message (the Wisp brief post). */
  leading?: ReactNode;
  /** Replaces the built-in quick-actions empty state. */
  emptyState?: ReactNode;
}

const SCRIPT_PROPOSAL_TOOLS = new Set(["run_script", "propose_script", "get_script_proposal"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Results that render as their own card and never fold into a tool-activity group. */
const CARD_TOOLS = new Set(["workspace_launch_analysis", "unattended_release"]);

/**
 * #7918: the proposal page (`/approvals#proposal-<id>`) shows a script
 * proposal's runs and, once verified, offers "Save to library". In chat the
 * approval card disappears as soon as the run is decided, so after a run —
 * finished, failed, or cut off — nothing linked to it. The id comes from the
 * tool call's input (`run_script`, `get_script_proposal`) or its result
 * (`propose_script`), and must be a UUID before it goes into an href.
 */
export function scriptProposalHref(
  toolName: string | undefined,
  input: Record<string, unknown> | undefined,
  output: unknown,
): string | null {
  if (!toolName || !SCRIPT_PROPOSAL_TOOLS.has(toolName)) return null;
  let parsed = output;
  if (typeof output === "string") {
    try { parsed = JSON.parse(output); } catch { parsed = undefined; }
  }
  const fromOutput = parsed && typeof parsed === "object"
    ? (parsed as { proposalId?: unknown }).proposalId
    : undefined;
  const id = input?.proposalId ?? fromOutput;
  return typeof id === "string" && UUID_RE.test(id) ? `/approvals#proposal-${id.toLowerCase()}` : null;
}

/**
 * Flow, run, unattended-release and script-proposal results never fold: each
 * carries an affordance (a review link, a live run, a proposal link) that
 * must stay visible without a click.
 */
function isCardCall(call: ToolCall): boolean {
  if (CARD_TOOLS.has(call.toolName)) return true;
  const output = call.result?.toolOutput ?? call.result?.content;
  if (call.result && parseFlowToolResult(call.toolName, output)) return true;
  return scriptProposalHref(call.toolName, call.input, output) !== null;
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
  chatRuns = {},
  layout = "panel",
  assistantLabel,
  showTimeDividers = false,
  leading,
  emptyState,
}: AiChatMessagesProps) {
  const { t, i18n } = useTranslation("ai");
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
  const units = useMemo(
    () => groupChatUnits(messages, { dividers: showTimeDividers, isCard: isCardCall }),
    [messages, showTimeDividers],
  );
  const label = assistantLabel ?? t("aiChatMessages.title");
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

  /**
   * The card for a finished tool call. `key` is the tool_use row's id when the
   * result renders in that row's place (#9534), so React reconciles it with
   * the pending card; `input` is that row's toolInput (sweep E6: the label
   * needs `input.action` to tell a read from a write, and the result row
   * carries no input of its own).
   */
  const renderToolResult = (
    msg: ChatRow,
    key: string,
    input: Record<string, unknown> | undefined,
  ) => {
    // Execution plane W05 (spec §5.5): the launch tool's result is a run
    // id, not content, so it renders as a run card rather than a
    // tool-output panel. `toolName` is present on a replayed history row
    // and on the live event alike.
    //
    // `workspace_launch_analysis` is fully deregistered (#6086) — no
    // tool declaration, no handler — so this branch is DEAD for any
    // session started after that change: nothing can produce a
    // `tool_result` with this name going forward. It is retained
    // specifically to replay chat history from sessions recorded before
    // #6086 shipped, which still contain rows with this toolName.
    if (msg.toolName === "workspace_launch_analysis") {
      const output = msg.toolOutput as { runId?: string; status?: string } | undefined;
      if (output?.runId) {
        return (
          <AiRunCard
            key={key}
            runId={output.runId}
            initialStatus={(output.status as "queued" | "running") ?? "queued"}
            run={chatRuns[output.runId]}
          />
        );
      }
    }
    // #5612 W05: a script released by the unattended lane never had an
    // approval card, so rendering it through AiToolCallCard's generic
    // tool-output chrome would misdescribe it as an executed tool call.
    // A small inline note instead — just enough to say what happened.
    if (msg.toolName === "unattended_release") {
      return (
        <p
          key={key}
          className="text-xs italic text-muted-foreground"
          data-testid="ai-unattended-release-note"
        >
          {t("aiChatMessages.unattendedRelease")}
        </p>
      );
    }
    const proposalHref = scriptProposalHref(msg.toolName, input, msg.toolOutput ?? msg.content);
    // Tool Catalog W3 (#5218): a saved draft_flow / get_flow result gets a
    // Flow card; failures and anything unparsable fall through to the
    // default card below so errors stay visible.
    const flowResult = parseFlowToolResult(msg.toolName, msg.toolOutput ?? msg.content);
    if (flowResult) {
      return (
        <Fragment key={key}>
          <FlowDraftCard flow={flowResult.flow} validation={flowResult.validation} />
        </Fragment>
      );
    }
    return (
      <Fragment key={key}>
        <AiToolCallCard
          toolName={msg.toolName ?? t("aiChatMessages.toolResult")}
          input={input}
          output={msg.toolOutput ?? msg.content}
          isError={msg.isError}
          handoff={msg.handoff}
        />
        {/* #6354: a tool refused for caller verification offers an
            inline verification workflow (never a retry). Renders
            nothing unless the error carries the structured payload
            and the feature is enabled. */}
        <CallerVerificationRefusal output={msg.toolOutput ?? msg.content} isError={msg.isError} />
        {proposalHref && (
          <a
            href={proposalHref}
            className="text-xs text-primary underline-offset-2 hover:underline"
            data-testid="ai-script-proposal-link"
          >
            {t("aiChatMessages.openScriptProposal")}
          </a>
        )}
      </Fragment>
    );
  };

  /**
   * One tool call: its finished card in the tool_use row's place (#9534), or
   * the pending card. Both are wrapped in a Fragment under the call's key, so
   * the card instance (and its expanded state) survives the swap.
   */
  const renderCall = (call: ToolCall) => {
    if (call.result) return renderToolResult(call.result, call.key, call.input);
    return (
      <Fragment key={call.key}>
        <AiToolCallCard
          toolName={call.toolName || t("aiChatMessages.unknownTool")}
          input={call.input}
          isExecuting
        />
      </Fragment>
    );
  };

  const renderUnit = (unit: ChatUnit, now: Date): ReactNode => {
    switch (unit.kind) {
      case "divider": {
        const parts = dividerParts(unit.at, now, i18n.language);
        const text =
          parts.day === "today"
            ? t("aiChatMessages.divider.today", { time: parts.time })
            : parts.day === "yesterday"
              ? t("aiChatMessages.divider.yesterday", { time: parts.time })
              : parts.dateTime;
        return (
          <div
            key={`divider-${unit.at.getTime()}`}
            role="separator"
            aria-label={text}
            data-testid="ai-chat-divider"
            className="py-1 text-center text-[11px] text-muted-foreground"
          >
            {text}
          </div>
        );
      }
      case "user":
        return (
          <div
            key={unit.msg.id}
            data-testid="ai-msg-user"
            className="ml-auto w-fit max-w-[75%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary/10 px-4 py-2.5 text-sm text-foreground dark:bg-primary/20"
          >
            {unit.msg.content}
          </div>
        );
      case "assistant":
        return (
          <div key={unit.msg.id} data-testid="ai-msg-assistant" className="min-w-0">
            {unit.firstOfRun && (
              <p data-testid="ai-msg-label" className="mb-1 text-xs font-medium text-muted-foreground">
                {label}
              </p>
            )}
            <AssistantMarkdown content={unit.msg.content} isStreaming={unit.msg.isStreaming} />
          </div>
        );
      case "tools":
        return <AiToolActivityGroup key={unit.id} group={unit} renderCall={renderCall} />;
      case "card":
        return renderCall(unit.call);
      case "specialists":
        return (
          <div key={unit.id} className="space-y-2" data-testid="ai-specialist-runs">
            {unit.runs.length > 1 && (
              <p className="text-xs font-medium text-muted-foreground">
                {t("aiChatMessages.specialists.heading", { count: unit.runs.length })}
              </p>
            )}
            {unit.runs.map((run) => (
              <AiRunCard key={run.key} runId={run.runId} initialStatus="queued" run={chatRuns[run.runId]} />
            ))}
          </div>
        );
      default:
        return null;
    }
  };

  if (messages.length === 0 && !leading) {
    if (emptyState) {
      return (
        <div className={layout === "page" ? "flex flex-1 flex-col justify-end px-4 py-6" : "flex flex-1 flex-col justify-end p-3"}>
          <div className={layout === "page" ? "mx-auto w-full max-w-3xl" : undefined}>{emptyState}</div>
        </div>
      );
    }
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-6">
        <Bot className="h-10 w-10 text-muted-foreground" />
        {/*
          h2 (not h3) so the drawer heading follows the page <h1> without
          skipping a level — screen-reader outline navigation depends on it.
          Styling is intentionally unchanged; the visual size comes from the
          text-sm/font-medium classes, not the tag. See issue #2381.
        */}
        <h2 className="mt-3 text-sm font-medium text-foreground">
          {t("aiChatMessages.title")}
        </h2>
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

  const now = new Date();
  const body = (
    <>
      {leading}
      {units.map((unit) => renderUnit(unit, now))}
      {messages.length === 0 && emptyState}

      {pendingApproval && (
        <AiApprovalDialog
          // Each approval_required event REPLACES pendingApproval in place; without
          // a key React reconciles the same instance and the previous card's decide
          // state (needs_device / error / decided) leaks into an unrelated approval —
          // e.g. a card that renders with no Approve button after the user registered
          // an authenticator in response to the previous one.
          key={pendingApproval.executionId}
          toolName={pendingApproval.toolName}
          description={pendingApproval.description}
          input={pendingApproval.input}
          deviceContext={pendingApproval.deviceContext}
          onApprove={() => onApprove(pendingApproval.executionId)}
          onReject={() => onReject(pendingApproval.executionId)}
          intentBacked={pendingApproval.intentBacked}
          selfApprovalRequestId={pendingApproval.selfApprovalRequestId}
          approvalScope={pendingApproval.approvalScope}
          intentExpiresAt={pendingApproval.intentExpiresAt}
          approvalWindowMs={pendingApproval.approvalWindowMs}
          approvalExpiresAt={pendingApproval.approvalExpiresAt}
          scriptRunContext={pendingApproval.scriptRunContext}
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
    </>
  );

  if (layout === "page") {
    return (
      <div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-4 py-6">
        {/* Short threads sit just above the composer; long ones scroll. */}
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-end space-y-5">{body}</div>
      </div>
    );
  }
  return (
    <div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-3 space-y-3">
      {body}
    </div>
  );
}

/** An assistant reply: prose, no avatar, no bubble (spec D2). */
function AssistantMarkdown({ content, isStreaming }: { content: string; isStreaming?: boolean }) {
  return (
    <div className="prose prose-sm max-w-none text-sm text-foreground prose-headings:text-sm prose-headings:font-semibold prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0 prose-pre:my-2 prose-pre:overflow-x-auto prose-code:text-xs prose-code:before:content-none prose-code:after:content-none dark:prose-invert">
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
                href={href && /^https?:\/\//.test(href) ? href : "#"}
                target="_blank"
                rel="noopener noreferrer"
              >
                {children}
              </a>
            );
          },
          // AI-authored markdown images must never auto-load —
          // see safeMarkdownImage.tsx for why.
          img: ({ src, alt }) => <SafeMarkdownImage src={src} alt={alt} />,
        }}
      >
        {content}
      </ReactMarkdown>
      {isStreaming && (
        <span
          data-testid="ai-msg-caret"
          className="inline-block h-4 w-1 animate-pulse bg-muted-foreground"
        />
      )}
    </div>
  );
}
