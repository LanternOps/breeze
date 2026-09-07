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
  AI_TOOL_APPROVED_EXECUTING,
  aiToolLabel,
  isAiToolHandoffOutput,
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

  // #5107 — a human approved this and the durable approval worker is running
  // it; this session declined to run it twice.
  //
  // TRUST ORDER: `handoff` comes from the server's own pre-tool-use gate. The
  // `output` shape is only a fallback for rows replayed from history, where
  // the SSE-level field is not persisted — and it is gated on `!isError`
  // because a tool owns its output payload: an ungated check would let any
  // tool emit `{ error: 'restart failed', status: 'approved_executing' }` and
  // have the collapsed row (the one techs scan by) read as an approved,
  // in-flight action.
  const isApprovedExecuting =
    handoff === AI_TOOL_APPROVED_EXECUTING || (!isError && isAiToolHandoffOutput(output));

  const StatusIcon = isApprovedExecuting
    ? () => <ShieldCheck className="h-3.5 w-3.5 text-amber-400" />
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
          {aiToolLabel(toolName, isExecuting ? "running" : "completed")}
        </span>
        {isApprovedExecuting ? (
          <span className="text-amber-400">
            {t("aiToolCallCard.approvedRunning")}
          </span>
        ) : isExecuting ? (
          <span className="text-gray-500">{t("aiToolCallCard.running")}</span>
        ) : null}
      </button>

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
