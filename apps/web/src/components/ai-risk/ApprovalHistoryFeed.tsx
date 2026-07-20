import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { useState } from "react";
import {
  CheckCircle,
  XCircle,
  Clock,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  Loader2,
} from "lucide-react";
import { formatRelativeTime, formatToolName } from "../../lib/utils";
import { fetchWithAuth } from "../../stores/auth";
import { ActionError, handleActionError, runAction } from "../../lib/runAction";
import type { ToolExecution } from "./AiRiskDashboard";
interface Props {
  executions: ToolExecution[];
  loading: boolean;
}
type FilterStatus = "all" | "pending" | "approved" | "rejected";
const TIER3_TOOLS = new Set([
  "execute_command",
  "run_script",
  "manage_services",
  "security_scan",
  "file_operations",
  "disk_cleanup",
  "create_automation",
  "network_discovery",
  "m365_reset_password",
]);
const STATUS_BADGE: Record<
  string,
  {
    icon: typeof CheckCircle;
    className: string;
  }
> = {
  approved: {
    icon: CheckCircle,
    className: "bg-green-500/15 text-green-700 border-green-500/30",
  },
  completed: {
    icon: CheckCircle,
    className: "bg-green-500/15 text-green-700 border-green-500/30",
  },
  rejected: {
    icon: XCircle,
    className: "bg-red-500/15 text-red-700 border-red-500/30",
  },
  pending: {
    icon: Clock,
    className: "bg-amber-500/15 text-amber-700 border-amber-500/30",
  },
};
export function ApprovalHistoryFeed({ executions, loading }: Props) {
  const { t } = useTranslation("security");
  const [filter, setFilter] = useState<FilterStatus>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Filter to Tier 3 tools only
  const tier3Execs = executions.filter((e) => TIER3_TOOLS.has(e.toolName));
  const filtered =
    filter === "all"
      ? tier3Execs
      : tier3Execs.filter((e) => {
          if (filter === "approved")
            return e.status === "approved" || e.status === "completed";
          return e.status === filter;
        });
  const filters: {
    label: string;
    value: FilterStatus;
  }[] = [
    { label: t("aiRiskApprovalHistoryFeed.all2"), value: "all" },
    { label: t("aiRiskApprovalHistoryFeed.pending"), value: "pending" },
    { label: t("aiRiskApprovalHistoryFeed.approved"), value: "approved" },
    { label: t("aiRiskApprovalHistoryFeed.rejected"), value: "rejected" },
  ];
  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">
          {t("aiRiskApprovalHistoryFeed.tier3ApprovalHistory")}
        </h2>
        <div className="flex gap-1">
          {filters.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                filter === f.value
                  ? "border-primary bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-16 animate-pulse rounded-lg border bg-muted/30"
            />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground shadow-xs">
          {t("aiRiskApprovalHistoryFeed.noTier3ToolExecutionsFound")}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((exec) => {
            const badge = STATUS_BADGE[exec.status] ?? STATUS_BADGE.pending;
            const BadgeIcon = badge.icon;
            const isExpanded = expandedId === exec.id;
            const waitMs =
              exec.approvedAt && exec.createdAt
                ? new Date(exec.approvedAt).getTime() -
                  new Date(exec.createdAt).getTime()
                : null;
            return (
              <div
                key={exec.id}
                className="rounded-lg border bg-card shadow-xs"
              >
                <button
                  onClick={() => setExpandedId(isExpanded ? null : exec.id)}
                  className="flex w-full items-center gap-3 p-4 text-left"
                >
                  <div className="shrink-0">
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">
                        {formatToolName(exec.toolName)}
                      </span>
                      <span
                        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${badge.className}`}
                      >
                        <BadgeIcon className="h-3 w-3" />
                        {exec.status}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-3 text-xs text-muted-foreground">
                      <span>
                        {formatRelativeTime(new Date(exec.createdAt))}
                      </span>
                      {waitMs !== null && (
                        <span>
                          {t("aiRiskApprovalHistoryFeed.wait")}
                          {formatDuration(waitMs)}
                        </span>
                      )}
                      {exec.durationMs !== null && (
                        <span>
                          {t("aiRiskApprovalHistoryFeed.exec")}
                          {exec.durationMs}ms
                        </span>
                      )}
                    </div>
                  </div>
                </button>

                {isExpanded && (
                  <div className="border-t px-4 pb-4 pt-3">
                    <p className="mb-1 text-xs font-medium text-muted-foreground">
                      {t("aiRiskApprovalHistoryFeed.toolInput")}
                    </p>
                    <pre className="max-h-40 overflow-auto rounded bg-muted/30 p-2 text-xs">
                      {JSON.stringify(exec.toolInput, null, 2)}
                    </pre>
                    {exec.intentId && exec.tempPasswordState && (
                      <TempPasswordSection
                        intentId={exec.intentId}
                        state={exec.tempPasswordState}
                      />
                    )}
                    {exec.errorMessage && (
                      <div className="mt-2">
                        <p className="mb-1 text-xs font-medium text-red-600">
                          {t("aiRiskApprovalHistoryFeed.error")}
                        </p>
                        <p className="text-xs text-red-600">
                          {exec.errorMessage}
                        </p>
                      </div>
                    )}
                    <p className="mt-2 text-xs text-muted-foreground">
                      {t("aiRiskApprovalHistoryFeed.session")}
                      {exec.sessionId}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}
function TempPasswordSection({
  intentId,
  state,
}: {
  intentId: string;
  state: "available" | "revealed" | "expired";
}) {
  const { t } = useTranslation("security");
  const [password, setPassword] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [blocked, setBlocked] = useState<"forbidden" | "gone" | null>(null);

  const reveal = async () => {
    setBusy(true);
    try {
      const pw = await runAction<string>({
        request: () =>
          fetchWithAuth(`/action-intents/${intentId}/reveal-secret`, {
            method: "POST",
          }),
        errorFallback: t("aiRiskApprovalHistoryFeed.tempPasswordRevealFailed"),
        parseSuccess: (body) =>
          (body as { data: { temporaryPassword: string } }).data
            .temporaryPassword,
      });
      setPassword(pw);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (err instanceof ActionError && err.status === 403)
        setBlocked("forbidden");
      else if (err instanceof ActionError && err.status === 410)
        setBlocked("gone");
      else if (!(err instanceof ActionError))
        handleActionError(
          err,
          t("aiRiskApprovalHistoryFeed.tempPasswordRevealFailed"),
        );
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!password) return;
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked; user can still select the text manually.
    }
  };

  if (state === "revealed" || blocked === "gone") {
    return (
      <p className="mt-2 text-xs text-muted-foreground">
        {t("aiRiskApprovalHistoryFeed.tempPasswordAlreadyRevealed")}
      </p>
    );
  }
  if (state === "expired") {
    return (
      <p className="mt-2 text-xs text-muted-foreground">
        {t("aiRiskApprovalHistoryFeed.tempPasswordExpired")}
      </p>
    );
  }
  if (blocked === "forbidden") {
    return (
      <p className="mt-2 text-xs text-muted-foreground">
        {t("aiRiskApprovalHistoryFeed.tempPasswordForbidden")}
      </p>
    );
  }

  return (
    <div className="mt-2">
      <p className="mb-1 text-xs font-medium text-muted-foreground">
        {t("aiRiskApprovalHistoryFeed.tempPasswordTitle")}
      </p>
      {password ? (
        <div className="rounded bg-muted/40 p-2">
          <code className="break-all font-mono text-sm">{password}</code>
          <div className="mt-1 flex items-center gap-2">
            <button
              type="button"
              onClick={copy}
              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted/40"
            >
              <Copy className="h-3 w-3" />
              {copied
                ? t("aiRiskApprovalHistoryFeed.tempPasswordCopied")
                : t("aiRiskApprovalHistoryFeed.tempPasswordCopy")}
            </button>
            <span className="text-xs font-medium text-amber-700">
              {t("aiRiskApprovalHistoryFeed.tempPasswordShownOnce")}
            </span>
          </div>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={reveal}
          className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted/40 disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Eye className="h-3 w-3" />
          )}
          {t("aiRiskApprovalHistoryFeed.tempPasswordReveal")}
        </button>
      )}
    </div>
  );
}
export default ApprovalHistoryFeed;
