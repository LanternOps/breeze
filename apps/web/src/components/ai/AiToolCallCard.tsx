import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Wrench,
  CheckCircle,
  XCircle,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  AI_TOOL_APPROVED_COMPLETED,
  AI_TOOL_APPROVED_EXECUTING,
  AI_TOOL_APPROVED_FAILED,
  AI_TOOL_HANDOFF_STATUSES,
  aiToolHandoffIsError,
  aiToolLabel,
  isAiToolHandoffOutput,
  type AiToolHandoffStatus,
} from "@breeze/shared";

interface AiToolCallCardProps {
  toolName: string;
  input?: Record<string, unknown>;
  output?: unknown;
  isError?: boolean;
  isExecuting?: boolean;
  /**
   * Server-asserted approval handoff (#5107). Authoritative — `output` is only
   * a history-replay fallback, because the tool controls that payload.
   */
  handoff?: string;
}

const MAX_PREVIEW_CHARS = 20_000;

function stringifyForPreview(value: unknown): string {
  const raw =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!raw) return "";
  if (raw.length <= MAX_PREVIEW_CHARS) return raw;
  const omitted = raw.length - MAX_PREVIEW_CHARS;
  return `${raw.slice(0, MAX_PREVIEW_CHARS)}\n...[truncated ${omitted} chars]`;
}

export default function AiToolCallCard({
  toolName,
  input,
  output,
  isError,
  isExecuting,
  handoff,
}: AiToolCallCardProps) {
  const { t } = useTranslation("ai");
  const [expanded, setExpanded] = useState(false);
  const inputPreview = useMemo(() => stringifyForPreview(input), [input]);
  const outputPreview = useMemo(() => stringifyForPreview(output), [output]);

  // #5107 / #6022 — the post-approval outcome of an action the durable
  // approval worker owns: still running, completed, or FAILED.
  //
  // TRUST ORDER: `handoff` comes from the server's own pre-tool-use gate. The
  // `output` shape is only a fallback for rows replayed from history, where
  // the SSE-level field is not persisted — and it is cross-checked against
  // `isError` because a tool owns its output payload: an ungated check would
  // let any tool emit `{ error: 'restart failed', status: 'approved_executing' }`
  // and have the collapsed row (the one techs scan by) read as an approved,
  // in-flight action. The check is now two-way: a replayed payload is trusted
  // only when the failure it claims MATCHES the server's own `isError`, so a
  // tool can neither forge a success nor forge a failure.
  const handoffStatus: AiToolHandoffStatus | null = useMemo(() => {
    if (handoff && (AI_TOOL_HANDOFF_STATUSES as readonly string[]).includes(handoff)) {
      return handoff as AiToolHandoffStatus;
    }
    if (isAiToolHandoffOutput(output) && aiToolHandoffIsError(output.status) === Boolean(isError)) {
      return output.status;
    }
    return null;
  }, [handoff, output, isError]);

  const isApprovedExecuting = handoffStatus === AI_TOOL_APPROVED_EXECUTING;
  const isApprovedCompleted = handoffStatus === AI_TOOL_APPROVED_COMPLETED;
  // #6022: the whole point of this issue. An approved action the worker then
  // REFUSED must read as failed at a glance, not as "Approved · running".
  const isApprovedFailed = handoffStatus === AI_TOOL_APPROVED_FAILED;

  // The worker's own reason, shown WITHOUT expanding the card — an operator
  // who has to click to discover the platform refused their action is the bug.
  const handoffMessage = isAiToolHandoffOutput(output) ? output.message : undefined;

  // #6500: the same "don't make them click to find out" rule applies to a
  // PLAIN refusal — a guardrail/RBAC/rate-limit denial, or an immediate
  // Tier-1 check like "device is not online" — none of which go through the
  // durable-approval handoff above. Those results are `isError: true` with a
  // conventional `{ error: string }` payload (every AI tool's error shape in
  // this codebase), and until now the only outcome shown for them was a red
  // icon in the collapsed header — no reason unless you expanded. Gated on
  // `!handoffStatus` so a handoff-failed call keeps using its own message.
  const plainErrorMessage =
    !handoffStatus &&
    isError &&
    output !== null &&
    typeof output === "object" &&
    !Array.isArray(output) &&
    typeof (output as Record<string, unknown>).error === "string"
      ? ((output as Record<string, unknown>).error as string)
      : undefined;

  const StatusIcon = isApprovedFailed
    ? () => <XCircle className="h-3.5 w-3.5 text-red-400" />
    : isApprovedExecuting
      ? () => <ShieldCheck className="h-3.5 w-3.5 text-amber-400" />
      : isApprovedCompleted
        ? () => <ShieldCheck className="h-3.5 w-3.5 text-green-400" />
        : isExecuting
          ? () => <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400" />
          : isError
            ? () => <XCircle className="h-3.5 w-3.5 text-red-400" />
            : output !== undefined
              ? () => <CheckCircle className="h-3.5 w-3.5 text-green-400" />
              : () => <Wrench className="h-3.5 w-3.5 text-gray-400" />;

  return (
    <div className="my-1 rounded-md border border-gray-200 bg-gray-50/50 dark:border-gray-700 dark:bg-gray-800/50">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 text-gray-500" />
        ) : (
          <ChevronRight className="h-3 w-3 text-gray-500" />
        )}
        <StatusIcon />
        <span className="font-medium text-gray-700 dark:text-gray-300">
          {aiToolLabel(toolName, isExecuting ? "running" : "completed", input)}
        </span>
        {isApprovedFailed ? (
          <span className="text-red-400" data-testid="ai-tool-approved-failed">
            {t("aiToolCallCard.approvedFailed")}
          </span>
        ) : isApprovedCompleted ? (
          <span className="text-green-400" data-testid="ai-tool-approved-completed">
            {t("aiToolCallCard.approvedCompleted")}
          </span>
        ) : isApprovedExecuting ? (
          <span className="text-amber-400" data-testid="ai-tool-approved-running">
            {t("aiToolCallCard.approvedRunning")}
          </span>
        ) : isExecuting ? (
          <span className="text-gray-500">{t("aiToolCallCard.running")}</span>
        ) : plainErrorMessage ? (
          <span className="text-red-400" data-testid="ai-tool-failed">
            {t("aiToolCallCard.failed")}
          </span>
        ) : null}
      </button>

      {/* #6022: a refusal the operator must not have to expand to find. */}
      {isApprovedFailed && handoffMessage ? (
        <p
          className="border-t border-red-200 px-3 py-1.5 text-xs text-red-500 dark:border-red-900/50 dark:text-red-400"
          data-testid="ai-tool-approved-failed-reason"
        >
          {handoffMessage}
        </p>
      ) : null}

      {/* #6500: same rule for a plain (non-handoff) server refusal. */}
      {plainErrorMessage ? (
        <p
          className="border-t border-red-200 px-3 py-1.5 text-xs text-red-500 dark:border-red-900/50 dark:text-red-400"
          data-testid="ai-tool-failed-reason"
        >
          {plainErrorMessage}
        </p>
      ) : null}

      {expanded && (
        <div className="border-t border-gray-200 px-3 py-2 text-xs dark:border-gray-700">
          {input && (
            <div className="mb-2">
              <span className="font-medium text-gray-500 dark:text-gray-400">
                {t("aiToolCallCard.input")}
              </span>
              <pre className="mt-1 max-h-32 overflow-auto rounded bg-gray-100 p-2 text-gray-700 dark:bg-gray-900 dark:text-gray-300">
                {inputPreview}
              </pre>
            </div>
          )}
          {output !== undefined && (
            <div>
              <span
                className={`font-medium ${isError ? "text-red-400" : "text-gray-500 dark:text-gray-400"}`}
              >
                {isError
                  ? t("aiToolCallCard.error")
                  : t("aiToolCallCard.output")}
              </span>
              <pre className="mt-1 max-h-40 overflow-auto rounded bg-gray-100 p-2 text-gray-700 dark:bg-gray-900 dark:text-gray-300">
                {outputPreview}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
