import { Fragment, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { aiToolLabel } from "@breeze/shared";
import type { ChatUnit, ToolCall } from "./aiChatGrouping";

type ToolsUnit = Extract<ChatUnit, { kind: "tools" }>;

/**
 * Wisp companion W01 (#10211, spec §4.2): consecutive tool calls between two
 * messages fold into one quiet line ("Searched devices · Listed sites · 3 s").
 * Expanding shows each call's existing card (`renderCall`), so nothing about a
 * call is lost. A failure or an approval handoff opens the group by itself —
 * also when it arrives mid-stream — unless the user has toggled it.
 */
export default function AiToolActivityGroup({
  group,
  renderCall,
  defaultExpanded = false,
}: {
  group: ToolsUnit;
  renderCall: (call: ToolCall) => ReactNode;
  defaultExpanded?: boolean;
}) {
  const { t, i18n } = useTranslation("ai");
  // null = the user has not chosen; the group follows its own state.
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const expanded = userExpanded ?? (defaultExpanded || group.failed > 0 || group.handoff);
  const state = group.failed > 0 ? "failed" : group.executing ? "executing" : "done";

  const labelOf = (call: ToolCall) =>
    call.toolName
      ? aiToolLabel(call.toolName, call.use && !call.result ? "running" : "completed", call.input)
      : t("aiChatMessages.toolResult");

  const current = group.executing
    ? [...group.calls].reverse().find((c) => c.use !== null && c.result === null)
    : undefined;
  const finishedCount = group.calls.filter((c) => c.result !== null).length;
  const summary = current ? labelOf(current) : joinLabels(group.calls.map(labelOf));
  const elapsedSeconds =
    !group.executing && group.startedAt && group.finishedAt
      ? Math.round((group.finishedAt.getTime() - group.startedAt.getTime()) / 1000)
      : 0;

  return (
    <div data-testid="ai-tool-group" data-state={state} className="text-xs">
      <button
        type="button"
        onClick={() => setUserExpanded(!expanded)}
        aria-expanded={expanded}
        title={expanded ? t("aiChatMessages.toolGroup.collapse") : t("aiChatMessages.toolGroup.expand")}
        className="flex w-full min-w-0 items-center gap-1.5 rounded py-0.5 text-left text-muted-foreground transition-colors hover:text-foreground"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        )}
        {current && (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" data-testid="ai-tool-group-spinner" />
        )}
        <span className="min-w-0 truncate" title={summary}>
          {summary}
        </span>
        {current && finishedCount > 0 && (
          <span className="shrink-0">{t("aiChatMessages.toolGroup.done", { count: finishedCount })}</span>
        )}
        {elapsedSeconds >= 1 && (
          <span className="shrink-0 tabular-nums">
            {new Intl.NumberFormat(i18n.language, { style: "unit", unit: "second", unitDisplay: "narrow" }).format(elapsedSeconds)}
          </span>
        )}
        {group.failed > 0 && (
          <span className="shrink-0 font-medium text-destructive" data-testid="ai-tool-group-failed">
            {t("aiChatMessages.toolGroup.failed", { count: group.failed })}
          </span>
        )}
      </button>
      {expanded && (
        <div className="mt-2 space-y-2">
          {group.calls.map((call) => (
            <Fragment key={call.key}>{renderCall(call)}</Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

/** "Searched devices ×2 · Listed sites": repeated labels collapse into a count, first-seen order kept. */
function joinLabels(labels: string[]): string {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return [...counts].map(([label, n]) => (n > 1 ? `${label} ×${n}` : label)).join(" · ");
}
