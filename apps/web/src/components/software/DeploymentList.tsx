import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle,
  Loader2,
  PlayCircle,
  XCircle,
} from "lucide-react";
import { cn, widthPercentClass } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
import { fetchWithAuth } from "../../stores/auth";
import { runAction, handleActionError } from "../../lib/runAction";

/** Aggregate deployment status computed by the API over deployment_results. */
export type SoftwareDeploymentAggregateStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "completed_with_errors"
  | "failed"
  | "cancelled";

/** Per-status device counts returned by GET /software/deployments. */
export type SoftwareDeploymentCounts = {
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
  cancelled: number;
  total: number;
};

type DeploymentRow = {
  id: string;
  orgId?: string;
  name: string;
  deploymentType?: string;
  scheduleType: string;
  scheduledAt?: string | null;
  createdAt: string;
  status: SoftwareDeploymentAggregateStatus;
  counts: SoftwareDeploymentCounts;
};

const statusConfig: Record<
  SoftwareDeploymentAggregateStatus,
  {
    labelKey: string;
    color: string;
    icon: typeof PlayCircle;
  }
> = {
  pending: {
    labelKey: "common:states.pending",
    color: "bg-yellow-500/20 text-yellow-700 border-yellow-500/40",
    icon: PlayCircle,
  },
  in_progress: {
    labelKey: "policies:software.deploymentList.inProgress",
    color: "bg-blue-500/20 text-blue-700 border-blue-500/40",
    icon: PlayCircle,
  },
  completed: {
    labelKey: "policies:software.deploymentList.completed",
    color: "bg-emerald-500/20 text-emerald-700 border-emerald-500/40",
    icon: CheckCircle,
  },
  completed_with_errors: {
    labelKey: "policies:software.deploymentList.completedWithErrors",
    color: "bg-amber-500/20 text-amber-700 border-amber-500/40",
    icon: AlertTriangle,
  },
  failed: {
    labelKey: "policies:software.deploymentList.failed",
    color: "bg-red-500/20 text-red-700 border-red-500/40",
    icon: AlertTriangle,
  },
  cancelled: {
    labelKey: "policies:software.deploymentList.canceled",
    color: "bg-slate-500/20 text-slate-700 border-slate-500/40",
    icon: XCircle,
  },
};

const scheduleTypeLabelKeys: Record<string, string> = {
  immediate: "policies:software.deploymentList.immediate",
  scheduled: "policies:software.deploymentList.scheduled",
  maintenance: "policies:software.deploymentList.maintenance",
};

/** Share of devices in a terminal state — the honest "how far along" number. */
export function deploymentProgressPercent(
  counts: SoftwareDeploymentCounts,
): number {
  if (!counts || counts.total <= 0) return 0;
  const terminal = counts.completed + counts.failed + counts.cancelled;
  return Math.round((terminal / counts.total) * 100);
}

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleDateString();
}

const PAGE_SIZE = 20;

export interface DeploymentListProps {
  onSelectDeployment?: (id: string) => void;
  refreshToken?: number;
}

export default function DeploymentList({
  onSelectDeployment,
  refreshToken,
}: DeploymentListProps) {
  const { t } = useTranslation(["policies", "common"]);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [deployments, setDeployments] = useState<DeploymentRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const fetchDeployments = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth(
        `/software/deployments?page=${page}&limit=${PAGE_SIZE}`,
      );
      if (!response.ok) {
        throw new Error(
          i18n.t(
            "policies:software.deploymentList.failedToLoadDeployments",
          ),
        );
      }
      const payload = await response.json();
      setDeployments(Array.isArray(payload?.data) ? payload.data : []);
      setTotal(Number(payload?.pagination?.total ?? 0));
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : i18n.t("policies:software.deploymentList.failedToLoadDeployments"),
      );
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    void fetchDeployments();
  }, [fetchDeployments, refreshToken]);

  const handleCancel = useCallback(
    async (item: DeploymentRow) => {
      const url = item.orgId
        ? `/software/deployments/${item.id}/cancel?orgId=${item.orgId}`
        : `/software/deployments/${item.id}/cancel`;
      try {
        setCancellingId(item.id);
        await runAction({
          request: () =>
            fetchWithAuth(url, { method: "POST", body: JSON.stringify({}) }),
          errorFallback: i18n.t(
            "policies:software.deploymentList.failedToCancelDeployment",
          ),
          successMessage: i18n.t(
            "policies:software.deploymentList.deploymentCancelled",
          ),
        });
        await fetchDeployments();
      } catch (err) {
        handleActionError(
          err,
          i18n.t("policies:software.deploymentList.failedToCancelDeployment"),
        );
      } finally {
        setCancellingId(null);
      }
    },
    [fetchDeployments],
  );

  const filteredDeployments = useMemo(() => {
    return deployments.filter((item) => {
      const matchesStatus =
        statusFilter === "all" ? true : item.status === statusFilter;
      const matchesType =
        typeFilter === "all" ? true : item.scheduleType === typeFilter;
      const itemDate = new Date(item.createdAt).getTime();
      const fromDate = dateFrom ? new Date(dateFrom).getTime() : null;
      const toDate = dateTo ? new Date(dateTo).getTime() : null;
      const matchesFrom = fromDate ? itemDate >= fromDate : true;
      const matchesTo = toDate ? itemDate <= toDate : true;
      return matchesStatus && matchesType && matchesFrom && matchesTo;
    });
  }, [deployments, statusFilter, typeFilter, dateFrom, dateTo]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6" data-testid="deployment-list">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          {i18n.t("policies:software.deploymentList.deployments")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {i18n.t(
            "policies:software.deploymentList.monitorProgressAndManageDeploymentWorkflows",
          )}
        </p>
      </div>

      <div className="flex flex-col gap-3 rounded-lg border bg-card p-4 shadow-xs lg:flex-row lg:items-end">
        <div className="flex-1">
          <label className="text-xs font-semibold uppercase text-muted-foreground">
            {i18n.t("common:labels.status")}
          </label>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            data-testid="deployment-status-filter"
            className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          >
            <option value="all">
              {i18n.t("policies:software.deploymentList.allStatuses")}
            </option>
            <option value="pending">{i18n.t("common:states.pending")}</option>
            <option value="in_progress">
              {i18n.t("policies:software.deploymentList.inProgress")}
            </option>
            <option value="completed">
              {i18n.t("policies:software.deploymentList.completed2")}
            </option>
            <option value="completed_with_errors">
              {i18n.t("policies:software.deploymentList.completedWithErrors")}
            </option>
            <option value="failed">
              {i18n.t("policies:software.deploymentList.failed2")}
            </option>
            <option value="cancelled">
              {i18n.t("policies:software.deploymentList.canceled2")}
            </option>
          </select>
        </div>
        <div className="flex-1">
          <label className="text-xs font-semibold uppercase text-muted-foreground">
            {i18n.t("common:labels.type")}
          </label>
          <select
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value)}
            data-testid="deployment-type-filter"
            className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          >
            <option value="all">
              {i18n.t("policies:software.deploymentList.allTypes")}
            </option>
            <option value="immediate">
              {i18n.t("policies:software.deploymentList.immediate")}
            </option>
            <option value="scheduled">
              {i18n.t("policies:software.deploymentList.scheduled")}
            </option>
            <option value="maintenance">
              {i18n.t("policies:software.deploymentList.maintenance")}
            </option>
          </select>
        </div>
        <div className="flex-1">
          <label className="text-xs font-semibold uppercase text-muted-foreground">
            {i18n.t("policies:software.deploymentList.from")}
          </label>
          <input
            type="date"
            value={dateFrom}
            onChange={(event) => setDateFrom(event.target.value)}
            className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          />
        </div>
        <div className="flex-1">
          <label className="text-xs font-semibold uppercase text-muted-foreground">
            {i18n.t("policies:software.deploymentList.to")}
          </label>
          <input
            type="date"
            value={dateTo}
            onChange={(event) => setDateTo(event.target.value)}
            className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          />
        </div>
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">
              {i18n.t("policies:software.deploymentList.deploymentList")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {filteredDeployments.length}{" "}
              {i18n.t("policies:software.deploymentList.deploymentsFound")}
            </p>
          </div>
        </div>

        {error ? (
          <div className="mt-5 rounded-md border border-destructive/40 bg-destructive/10 p-6 text-center">
            <p className="text-sm text-destructive">{error}</p>
            <button
              type="button"
              onClick={() => void fetchDeployments()}
              data-testid="deployment-list-retry"
              className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              {i18n.t("common:actions.retry")}
            </button>
          </div>
        ) : loading && deployments.length === 0 ? (
          <div
            className="mt-5 flex items-center justify-center gap-2 rounded-md border p-6 text-sm text-muted-foreground"
            data-testid="deployment-list-loading"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            {i18n.t("policies:software.deploymentList.loadingDeployments")}
          </div>
        ) : (
          <div className="mt-5 overflow-x-auto rounded-md border">
            <table className="min-w-full divide-y">
              <thead className="bg-muted/40">
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3">{i18n.t("common:labels.name")}</th>
                  <th className="px-4 py-3">{i18n.t("common:labels.type")}</th>
                  <th className="px-4 py-3">
                    {i18n.t("common:labels.status")}
                  </th>
                  <th className="px-4 py-3">
                    {i18n.t("policies:software.deploymentList.progress")}
                  </th>
                  <th className="px-4 py-3">
                    {i18n.t("common:labels.createdAt")}
                  </th>
                  <th className="px-4 py-3 text-right">
                    {i18n.t("common:labels.actions")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filteredDeployments.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-4 py-6 text-center text-sm text-muted-foreground"
                      data-testid="deployment-list-empty"
                    >
                      {deployments.length === 0
                        ? i18n.t(
                            "policies:software.deploymentList.noDeploymentsYet",
                          )
                        : i18n.t(
                            "policies:software.deploymentList.noDeploymentsMatchYourFilters",
                          )}
                    </td>
                  </tr>
                ) : (
                  filteredDeployments.map((item) => {
                    const status =
                      statusConfig[item.status] ?? statusConfig.pending;
                    const StatusIcon = status.icon;
                    const progress = deploymentProgressPercent(item.counts);
                    const cancellable =
                      item.status === "pending" ||
                      item.status === "in_progress";
                    return (
                      <tr
                        key={item.id}
                        data-testid={`deployment-row-${item.id}`}
                        onClick={() => onSelectDeployment?.(item.id)}
                        className={cn(
                          "text-sm",
                          onSelectDeployment && "cursor-pointer hover:bg-muted/40",
                        )}
                      >
                        <td className="px-4 py-3">
                          <p className="font-medium text-foreground">
                            {item.name}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {item.id}
                          </p>
                        </td>
                        <td className="px-4 py-3">
                          <span className="rounded-full border px-2 py-1 text-xs font-medium text-muted-foreground">
                            {scheduleTypeLabelKeys[item.scheduleType]
                              ? t(
                                  /* i18n-dynamic */ scheduleTypeLabelKeys[
                                    item.scheduleType
                                  ],
                                )
                              : item.scheduleType}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={cn(
                              "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium",
                              status.color,
                            )}
                          >
                            <StatusIcon className="h-3.5 w-3.5" />
                            {t(/* i18n-dynamic */ status.labelKey)}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          {item.status === "in_progress" ? (
                            <div
                              className="flex items-center gap-2"
                              data-testid={`deployment-progress-${item.id}`}
                            >
                              <div className="h-2 w-24 rounded-full bg-muted">
                                <div
                                  className={cn(
                                    "h-2 rounded-full bg-primary",
                                    widthPercentClass(progress),
                                  )}
                                />
                              </div>
                              <span className="text-xs text-muted-foreground">
                                {progress}%
                              </span>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              —
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {formatDate(item.createdAt)}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {cancellable ? (
                            <button
                              type="button"
                              data-testid={`deployment-cancel-${item.id}`}
                              disabled={cancellingId === item.id}
                              onClick={(event) => {
                                event.stopPropagation();
                                void handleCancel(item);
                              }}
                              className="inline-flex h-8 items-center justify-center rounded-md border px-3 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                            >
                              {i18n.t("common:actions.cancel")}
                            </button>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              —
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}

        {!error && total > PAGE_SIZE && (
          <div className="mt-4 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              {i18n.t("policies:software.deploymentList.pageOf", {
                page,
                pages: totalPages,
              })}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                data-testid="deployment-page-prev"
                disabled={page <= 1 || loading}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                className="inline-flex h-8 items-center justify-center rounded-md border px-3 text-xs font-medium hover:bg-muted disabled:opacity-50"
              >
                {i18n.t("common:actions.back")}
              </button>
              <button
                type="button"
                data-testid="deployment-page-next"
                disabled={page >= totalPages || loading}
                onClick={() =>
                  setPage((current) => Math.min(totalPages, current + 1))
                }
                className="inline-flex h-8 items-center justify-center rounded-md border px-3 text-xs font-medium hover:bg-muted disabled:opacity-50"
              >
                {i18n.t("common:actions.next")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
