import { useCallback, useEffect, useState } from "react";
import { Activity, AlertTriangle, ArrowLeft, Loader2, RefreshCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import ProgressBar from "../shared/ProgressBar";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
import { fetchWithAuth } from "../../stores/auth";
import { runAction, handleActionError } from "../../lib/runAction";
import type {
  SoftwareDeploymentAggregateStatus,
  SoftwareDeploymentCounts,
} from "./DeploymentList";

export const DEPLOYMENT_POLL_INTERVAL_MS = 5000;
const RESULTS_LIMIT = 200;

type DeploymentDetail = {
  id: string;
  orgId?: string;
  name: string;
  scheduleType?: string;
  scheduledAt?: string | null;
  createdAt: string;
  status: SoftwareDeploymentAggregateStatus;
  counts: SoftwareDeploymentCounts;
};

type DeploymentResultRow = {
  id: string;
  deploymentId: string;
  deviceId: string;
  status: string;
  startedAt?: string | null;
  completedAt?: string | null;
  exitCode?: number | null;
  output?: string | null;
  errorMessage?: string | null;
  retryCount?: number;
  deviceCommandId?: string | null;
  hostname?: string | null;
  queuedOffline?: boolean;
};

export interface DeploymentProgressProps {
  deploymentId: string;
  onBack?: () => void;
}

const resultStatusStyles: Record<
  string,
  {
    labelKey: string;
    color: string;
  }
> = {
  pending: {
    labelKey: "common:states.pending",
    color: "bg-slate-500/20 text-slate-700 border-slate-500/40",
  },
  running: {
    labelKey: "policies:software.deploymentProgress.running",
    color: "bg-blue-500/20 text-blue-700 border-blue-500/40",
  },
  downloading: {
    labelKey: "policies:software.deploymentProgress.downloading",
    color: "bg-blue-500/20 text-blue-700 border-blue-500/40",
  },
  installing: {
    labelKey: "policies:software.deploymentProgress.installing",
    color: "bg-blue-500/20 text-blue-700 border-blue-500/40",
  },
  completed: {
    labelKey: "policies:software.deploymentProgress.completed",
    color: "bg-emerald-500/20 text-emerald-700 border-emerald-500/40",
  },
  failed: {
    labelKey: "policies:software.deploymentProgress.failed",
    color: "bg-red-500/20 text-red-700 border-red-500/40",
  },
  cancelled: {
    labelKey: "policies:software.deploymentProgress.cancelled",
    color: "bg-slate-500/20 text-slate-700 border-slate-500/40",
  },
};

const queuedOfflineStyle = {
  labelKey: "policies:software.deploymentProgress.queuedOffline",
  color: "bg-amber-500/20 text-amber-700 border-amber-500/40",
};

function formatDateTime(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

export default function DeploymentProgress({
  deploymentId,
  onBack,
}: DeploymentProgressProps) {
  const { t } = useTranslation(["policies", "common"]);
  const [deployment, setDeployment] = useState<DeploymentDetail | null>(null);
  const [results, setResults] = useState<DeploymentResultRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [retrying, setRetrying] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [detailResponse, resultsResponse] = await Promise.all([
        fetchWithAuth(`/software/deployments/${deploymentId}`),
        fetchWithAuth(
          `/software/deployments/${deploymentId}/results?limit=${RESULTS_LIMIT}`,
        ),
      ]);
      if (!detailResponse.ok || !resultsResponse.ok) {
        throw new Error(
          i18n.t("policies:software.deploymentProgress.failedToLoadDeployment"),
        );
      }
      const detailPayload = await detailResponse.json();
      const resultsPayload = await resultsResponse.json();
      setDeployment(detailPayload?.data ?? null);
      setResults(Array.isArray(resultsPayload?.data) ? resultsPayload.data : []);
      setError(undefined);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : i18n.t(
              "policies:software.deploymentProgress.failedToLoadDeployment",
            ),
      );
    } finally {
      setLoading(false);
    }
  }, [deploymentId]);

  useEffect(() => {
    setLoading(true);
    void fetchData();
  }, [fetchData]);

  const isPolling =
    deployment?.status === "pending" || deployment?.status === "in_progress";

  // Poll while the deployment is still moving; terminal aggregate statuses
  // (completed / completed_with_errors / failed / cancelled) stop the interval,
  // and unmount clears it.
  useEffect(() => {
    if (!isPolling) return;
    const interval = setInterval(() => {
      void fetchData();
    }, DEPLOYMENT_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isPolling, fetchData]);

  const mutationUrl = useCallback(
    (action: "retry" | "cancel") => {
      const base = `/software/deployments/${deploymentId}/${action}`;
      return deployment?.orgId ? `${base}?orgId=${deployment.orgId}` : base;
    },
    [deploymentId, deployment?.orgId],
  );

  const handleRetryFailed = useCallback(async () => {
    try {
      setRetrying(true);
      await runAction({
        request: () => fetchWithAuth(mutationUrl("retry"), { method: "POST" }),
        errorFallback: i18n.t(
          "policies:software.deploymentProgress.failedToRetryDeployment",
        ),
        successMessage: i18n.t(
          "policies:software.deploymentProgress.retryStarted",
        ),
      });
      await fetchData();
    } catch (err) {
      handleActionError(
        err,
        i18n.t("policies:software.deploymentProgress.failedToRetryDeployment"),
      );
    } finally {
      setRetrying(false);
    }
  }, [mutationUrl, fetchData]);

  const handleCancel = useCallback(async () => {
    try {
      setCancelling(true);
      await runAction({
        request: () =>
          fetchWithAuth(mutationUrl("cancel"), {
            method: "POST",
            body: JSON.stringify({}),
          }),
        errorFallback: i18n.t(
          "policies:software.deploymentProgress.failedToCancelDeployment",
        ),
        successMessage: i18n.t(
          "policies:software.deploymentProgress.deploymentCancelled",
        ),
      });
      await fetchData();
    } catch (err) {
      handleActionError(
        err,
        i18n.t("policies:software.deploymentProgress.failedToCancelDeployment"),
      );
    } finally {
      setCancelling(false);
    }
  }, [mutationUrl, fetchData]);

  if (loading && !deployment) {
    return (
      <div
        className="flex items-center justify-center gap-2 rounded-lg border bg-card p-12 text-sm text-muted-foreground"
        data-testid="deployment-progress-loading"
      >
        <Loader2 className="h-4 w-4 animate-spin" />
        {i18n.t("policies:software.deploymentProgress.loadingDeployment")}
      </div>
    );
  }

  if (error && !deployment) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <div className="mt-4 flex items-center justify-center gap-2">
          {onBack && (
            <button
              type="button"
              data-testid="deployment-back"
              onClick={onBack}
              className="inline-flex h-9 items-center justify-center gap-2 rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted"
            >
              <ArrowLeft className="h-4 w-4" />
              {i18n.t("common:actions.back")}
            </button>
          )}
          <button
            type="button"
            onClick={() => void fetchData()}
            className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            {i18n.t("common:actions.retry")}
          </button>
        </div>
      </div>
    );
  }

  if (!deployment) return null;

  const counts = deployment.counts ?? {
    pending: 0,
    inProgress: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    total: 0,
  };
  const finished = counts.completed + counts.failed + counts.cancelled;
  const percent =
    counts.total > 0 ? Math.round((finished / counts.total) * 100) : 0;
  const cancellable =
    deployment.status === "pending" || deployment.status === "in_progress";
  const progressVariant =
    counts.failed > 0 && counts.completed === 0
      ? ("error" as const)
      : counts.failed > 0
        ? ("warning" as const)
        : deployment.status === "completed"
          ? ("success" as const)
          : ("default" as const);

  return (
    <div className="space-y-6" data-testid="deployment-progress">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          {onBack && (
            <button
              type="button"
              data-testid="deployment-back"
              onClick={onBack}
              aria-label={i18n.t("common:actions.back")}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border bg-background hover:bg-muted"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              {deployment.name}
            </h1>
            <p className="text-sm text-muted-foreground">
              {formatDateTime(deployment.createdAt)}
            </p>
          </div>
        </div>
        {isPolling && (
          <div
            className="flex items-center gap-2 rounded-full border px-3 py-1 text-xs text-muted-foreground"
            data-testid="deployment-auto-refresh"
          >
            <Activity className="h-3.5 w-3.5 text-emerald-500" />
            {i18n.t("policies:software.deploymentProgress.autoRefreshing")}
          </div>
        )}
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="text-sm font-semibold">
              {i18n.t("policies:software.deploymentProgress.overallProgress")}
            </p>
            <p className="text-xs text-muted-foreground">
              {i18n.t("policies:software.deploymentProgress.devicesFinished", {
                finished,
                total: counts.total,
              })}
            </p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-semibold" data-testid="deployment-percent">
              {percent}%
            </p>
            <p className="text-xs text-muted-foreground">
              {deployment.status === "completed"
                ? i18n.t(
                    "policies:software.deploymentProgress.deploymentComplete",
                  )
                : i18n.t("policies:software.deploymentProgress.inProgress")}
            </p>
          </div>
        </div>

        <ProgressBar
          current={finished}
          total={counts.total}
          variant={progressVariant}
          showCount={false}
        />

        <div className="mt-4 grid gap-4 sm:grid-cols-5">
          <div
            className="rounded-md border bg-muted/30 p-4"
            data-testid="deployment-tile-completed"
          >
            <p className="text-xs uppercase text-muted-foreground">
              {i18n.t("policies:software.deploymentProgress.completed2")}
            </p>
            <p className="mt-2 text-lg font-semibold">{counts.completed}</p>
          </div>
          <div
            className="rounded-md border bg-muted/30 p-4"
            data-testid="deployment-tile-in-progress"
          >
            <p className="text-xs uppercase text-muted-foreground">
              {i18n.t("policies:software.deploymentProgress.inProgress")}
            </p>
            <p className="mt-2 text-lg font-semibold">{counts.inProgress}</p>
          </div>
          <div
            className="rounded-md border bg-muted/30 p-4"
            data-testid="deployment-tile-pending"
          >
            <p className="text-xs uppercase text-muted-foreground">
              {i18n.t("common:states.pending")}
            </p>
            <p className="mt-2 text-lg font-semibold">{counts.pending}</p>
          </div>
          <div
            className="rounded-md border bg-muted/30 p-4"
            data-testid="deployment-tile-failed"
          >
            <p className="text-xs uppercase text-muted-foreground">
              {i18n.t("policies:software.deploymentProgress.failed2")}
            </p>
            <p className="mt-2 text-lg font-semibold text-destructive">
              {counts.failed}
            </p>
          </div>
          <div
            className="rounded-md border bg-muted/30 p-4"
            data-testid="deployment-tile-cancelled"
          >
            <p className="text-xs uppercase text-muted-foreground">
              {i18n.t("policies:software.deploymentProgress.cancelled")}
            </p>
            <p className="mt-2 text-lg font-semibold">{counts.cancelled}</p>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          {cancellable && (
            <button
              type="button"
              data-testid="deployment-cancel"
              disabled={cancelling}
              onClick={() => void handleCancel()}
              className="inline-flex h-9 items-center justify-center rounded-md border px-4 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
            >
              {i18n.t("common:actions.cancel")}
            </button>
          )}
          <button
            type="button"
            data-testid="deployment-retry-failed"
            disabled={counts.failed === 0 || retrying}
            onClick={() => void handleRetryFailed()}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            <RefreshCcw className="h-4 w-4" />
            {i18n.t("policies:software.deploymentProgress.retryFailed")}
          </button>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <h2 className="text-lg font-semibold">
          {i18n.t("policies:software.deploymentProgress.perDeviceStatus")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {i18n.t(
            "policies:software.deploymentProgress.trackStatusUpdatesAsDevicesReportBack",
          )}
        </p>

        <div className="mt-4 overflow-x-auto rounded-md border">
          <table className="min-w-full divide-y">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">{i18n.t("common:labels.device")}</th>
                <th className="px-4 py-3">{i18n.t("common:labels.status")}</th>
                <th className="px-4 py-3">
                  {i18n.t("policies:software.deploymentProgress.started")}
                </th>
                <th className="px-4 py-3">
                  {i18n.t("policies:software.deploymentProgress.completed3")}
                </th>
                <th className="px-4 py-3">
                  {i18n.t("policies:software.deploymentProgress.exitCode")}
                </th>
                <th className="px-4 py-3">
                  {i18n.t("policies:software.deploymentProgress.error")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {results.map((result) => {
                const style = result.queuedOffline
                  ? queuedOfflineStyle
                  : resultStatusStyles[result.status];
                return (
                  <tr
                    key={result.id}
                    className="text-sm"
                    data-testid={`deployment-result-row-${result.id}`}
                  >
                    <td className="px-4 py-3 font-medium text-foreground">
                      {result.hostname ?? result.deviceId}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium",
                          style?.color ??
                            "bg-slate-500/20 text-slate-700 border-slate-500/40",
                        )}
                      >
                        {style
                          ? t(/* i18n-dynamic */ style.labelKey)
                          : result.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {formatDateTime(result.startedAt)}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {formatDateTime(result.completedAt)}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {result.exitCode ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {result.errorMessage ? (
                        <span className="inline-flex items-center gap-1 text-xs text-destructive">
                          <AlertTriangle className="h-3.5 w-3.5" />
                          {result.errorMessage}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
