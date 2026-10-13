import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Info, Loader2, RefreshCw } from "lucide-react";
import {
  EDR_DETECTION_STATUSES,
  EDR_SEVERITIES,
  type EdrDetectionStatus,
  type EdrSeverity,
} from "@breeze/shared";
import { navigateTo } from "@/lib/navigation";
import { cn, friendlyFetchError } from "../../lib/utils";
import { errorKindOf, type LoadErrorKind } from "@/lib/httpError";
import { ActionError } from "../../lib/runAction";
import { showToast } from "../shared/Toast";
import AccessDenied from "../shared/AccessDenied";
import { FilterSelect } from "../shared/FilterSelect";
import { formatDateTime } from "../../lib/dateTimeFormat";
import {
  fetchEdrDetections,
  type EdrCoverage,
  type EdrDetectionDto,
  type EdrStatusProviderSummary,
  type EdrStatusSummary,
} from "../../lib/edrProviders";
import { edrDetectionToIncident, promoteToIncident } from "../../lib/incidents";

const PAGE_SIZE = 50;

const severityBadge: Record<string, string> = {
  info: "bg-slate-500/15 text-slate-700 border-slate-500/30",
  low: "bg-blue-500/20 text-blue-700 border-blue-500/30",
  medium: "bg-yellow-500/20 text-yellow-800 border-yellow-500/40",
  high: "bg-orange-500/20 text-orange-700 border-orange-500/40",
  critical: "bg-red-500/20 text-red-700 border-red-500/40",
};
const statusBadge: Record<string, string> = {
  open: "bg-red-500/15 text-red-700 border-red-500/30",
  in_progress: "bg-blue-500/15 text-blue-700 border-blue-500/30",
  mitigated: "bg-amber-500/20 text-amber-800 border-amber-500/40",
  resolved: "bg-emerald-500/20 text-emerald-700 border-emerald-500/40",
};
const neutralBadge = "bg-muted text-muted-foreground border-border";

function badgeClass(value: string, classes: Record<string, string>): string {
  return Object.prototype.hasOwnProperty.call(classes, value)
    ? classes[value]
    : neutralBadge;
}

function formatWhen(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : formatDateTime(date);
}

function StatusStrip({ p }: { p: EdrStatusProviderSummary }) {
  const { t } = useTranslation("security");
  const partnerScope = p.connectionStatus !== undefined;
  const tenantCounts: [string, number | undefined][] = [
    ["stale", p.tenantsStale],
    ["failed", p.tenantsFailed],
    ["pending", p.tenantsPending],
    ["unmapped", p.tenantsUnmapped],
  ];
  return (
    <div
      className="rounded-md border bg-background p-3 text-sm"
      data-testid={`other-edr-status-${p.provider}-${p.connectionId ?? "org"}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold">{p.label}</span>
        {partnerScope && (
          <span
            className={cn(
              "inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold",
              p.connectionStatus === "connected"
                ? "bg-emerald-500/20 text-emerald-700 border-emerald-500/40"
                : "bg-red-500/15 text-red-700 border-red-500/30",
            )}
          >
            {t(
              /* i18n-dynamic */ `securityOtherEdr.connectionStatuses.${p.connectionStatus}`,
            )}
          </span>
        )}
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        <div>
          <dt className="text-muted-foreground">
            {t("securityOtherEdr.openDetections")}
          </dt>
          <dd className="font-medium">{p.openDetections}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">
            {t("securityOtherEdr.endpoints")}
          </dt>
          <dd className="font-medium">{p.endpoints}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">
            {t("securityOtherEdr.linkedEndpoints")}
          </dt>
          <dd className="font-medium">{p.linkedEndpoints}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">
            {t("securityOtherEdr.unhealthyEndpoints")}
          </dt>
          <dd className="font-medium">{p.unhealthyEndpoints}</dd>
        </div>
        <div className="col-span-2">
          <dt className="text-muted-foreground">
            {t("securityOtherEdr.lastDetectionSync")}
          </dt>
          <dd className="font-medium">
            {p.lastDetectionSyncAt ? (
              formatWhen(p.lastDetectionSyncAt)
            ) : (
              <span>{t("securityOtherEdr.never")}</span>
            )}
          </dd>
        </div>
        {tenantCounts.map(
          ([key, value]) =>
            value !== undefined && (
              <div key={key}>
                <dt className="text-muted-foreground">
                  {t(/* i18n-dynamic */ `securityOtherEdr.tenants.${key}`)}
                </dt>
                <dd className="font-medium">{value}</dd>
              </div>
            ),
        )}
      </dl>
    </div>
  );
}

export default function OtherEdrDetectionList({
  status,
}: {
  status: EdrStatusSummary;
}) {
  const { t } = useTranslation("security");
  const [severity, setSeverity] = useState<"all" | EdrSeverity>("all");
  const [statusFilter, setStatusFilter] = useState<"open" | "all" | EdrDetectionStatus>("open");
  const [providerFilter, setProviderFilter] = useState("all");
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<EdrDetectionDto[]>([]);
  const [total, setTotal] = useState(0);
  const [pageCoverage, setPageCoverage] = useState<EdrCoverage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [errorKind, setErrorKind] = useState<LoadErrorKind>("none");
  const [promotingId, setPromotingId] = useState<string | null>(null);
  const [alreadyPromoted, setAlreadyPromoted] = useState<Set<string>>(
    () => new Set(),
  );
  const requestSeq = useRef(0);

  const providerKeys = useMemo(
    () => Array.from(new Set(status.providers.map((p) => p.provider))),
    [status.providers],
  );
  const providerLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const p of status.providers) if (!labels.has(p.provider)) labels.set(p.provider, p.label);
    return labels;
  }, [status.providers]);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(undefined);
    setErrorKind("none");
    try {
      const page = await fetchEdrDetections({
        severity: severity === "all" ? undefined : [severity],
        status: statusFilter,
        provider: providerFilter === "all" ? undefined : providerFilter,
        limit: PAGE_SIZE,
        offset,
      });
      if (seq !== requestSeq.current) return;
      setRows(page.rows);
      setTotal(page.total);
      setPageCoverage(page.coverage);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      const kind = errorKindOf(err);
      setErrorKind(kind);
      if (kind === "other") setError(friendlyFetchError(err));
      setRows([]);
      setTotal(0);
      setPageCoverage(null);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [severity, statusFilter, providerFilter, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  const promote = async (d: EdrDetectionDto) => {
    setPromotingId(d.id);
    try {
      const { id } = await promoteToIncident(edrDetectionToIncident(d), {
        suppressErrorToast: (s) => s === 409,
      });
      navigateTo(`/incidents/${id}`);
    } catch (err) {
      if (err instanceof ActionError && err.status === 409) {
        setAlreadyPromoted((prev) => new Set(prev).add(d.id));
      } else if (err instanceof ActionError && err.status === 401) {
        return; // auth redirect handles it
      } else if (!(err instanceof ActionError)) {
        showToast({
          type: "error",
          message: t("securityOtherEdr.promoteFailed"),
        });
      }
      // other ActionErrors were already toasted by runAction
    } finally {
      setPromotingId(null);
    }
  };

  if (errorKind === "denied") {
    return (
      <div
        className="rounded-lg border bg-card p-6 shadow-xs"
        data-testid="other-edr-list"
      >
        <AccessDenied testId="other-edr-denied" />
      </div>
    );
  }

  const coverage = pageCoverage ?? status.coverage;
  const showBanner = coverage.partial || coverage.notes.length > 0;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + rows.length, total);

  return (
    <div
      className="space-y-4 rounded-lg border bg-card p-6 shadow-xs"
      data-testid="other-edr-list"
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">
            {t("securityOtherEdr.title")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {loading
              ? t("securityOtherEdr.loading")
              : t("securityOtherEdr.showing", { from, to, total })}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <FilterSelect
            label={t("securityOtherEdr.filters.severity")}
            data-testid="other-edr-filter-severity"
            value={severity}
            onChange={(e) => {
              setOffset(0);
              setSeverity(e.target.value as "all" | EdrSeverity);
            }}
          >
            <option value="all">{t("securityOtherEdr.filters.allSeverities")}</option>
            {EDR_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {t(/* i18n-dynamic */ `securityOtherEdr.severities.${s}`)}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect
            label={t("securityOtherEdr.filters.status")}
            data-testid="other-edr-filter-status"
            value={statusFilter}
            onChange={(e) => {
              setOffset(0);
              setStatusFilter(e.target.value as "open" | "all" | EdrDetectionStatus);
            }}
          >
            <option value="open">{t("securityOtherEdr.filters.openDefault")}</option>
            <option value="all">{t("securityOtherEdr.filters.allStatuses")}</option>
            {EDR_DETECTION_STATUSES.filter((s) => s !== "open").map((s) => (
              <option key={s} value={s}>
                {t(/* i18n-dynamic */ `securityOtherEdr.statuses.${s}`)}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect
            label={t("securityOtherEdr.filters.provider")}
            data-testid="other-edr-filter-provider"
            value={providerFilter}
            onChange={(e) => {
              setOffset(0);
              setProviderFilter(e.target.value);
            }}
          >
            <option value="all">{t("securityOtherEdr.filters.allProviders")}</option>
            {providerKeys.map((key) => (
              <option key={key} value={key}>
                {providerLabels.get(key) ?? key}
              </option>
            ))}
          </FilterSelect>
          <button
            type="button"
            data-testid="other-edr-refresh"
            onClick={() => void load()}
            className="inline-flex h-10 items-center gap-2 rounded-md border bg-background px-3 text-sm hover:bg-muted"
          >
            <RefreshCw className="h-4 w-4" />
            {t("securityOtherEdr.refresh")}
          </button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2" data-testid="other-edr-status-strip">
        {status.providers.map((p) => (
          <StatusStrip key={`${p.provider}-${p.connectionId ?? "org"}`} p={p} />
        ))}
      </div>

      {showBanner && (
        <div
          role="status"
          data-testid="other-edr-coverage-banner"
          className="rounded-md border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-sm text-blue-900 dark:text-blue-200"
        >
          <div className="flex items-center gap-2 font-medium">
            <Info className="h-4 w-4" />
            {t("securityOtherEdr.coverageHeading")}
          </div>
          {coverage.notes.length > 0 && (
            <ul className="mt-1 list-disc space-y-0.5 pl-6">
              {coverage.notes.map((note, i) => (
                <li key={i}>{note}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          data-testid="other-edr-error"
        >
          {error}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">{t("securityOtherEdr.table.provider")}</th>
              <th className="px-4 py-3">{t("securityOtherEdr.table.detection")}</th>
              <th className="px-4 py-3">{t("securityOtherEdr.table.severity")}</th>
              <th className="px-4 py-3">{t("securityOtherEdr.table.status")}</th>
              <th className="px-4 py-3">{t("securityOtherEdr.table.device")}</th>
              <th className="px-4 py-3">{t("securityOtherEdr.table.detected")}</th>
              <th className="px-4 py-3">{t("securityOtherEdr.table.actions")}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  <span className="inline-flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t("securityOtherEdr.loading")}
                  </span>
                </td>
              </tr>
            ) : rows.length === 0 && !error ? (
              <tr>
                <td
                  colSpan={7}
                  data-testid="other-edr-empty"
                  className="px-4 py-8 text-center text-sm text-muted-foreground"
                >
                  {coverage.partial
                    ? t("securityOtherEdr.emptyPartial")
                    : t("securityOtherEdr.empty")}
                </td>
              </tr>
            ) : (
              rows.map((d) => {
                const promoted = d.promotedIncidentId;
                return (
                  <tr key={d.id} data-testid={`other-edr-row-${d.id}`} className="text-sm">
                    <td className="px-4 py-3">
                      <span className="inline-flex rounded-full border bg-muted px-2.5 py-1 text-xs font-semibold">
                        {d.providerLabel}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {d.threatName ?? d.title ?? t("securityOtherEdr.unnamedDetection")}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          "inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold",
                          badgeClass(d.severity, severityBadge),
                        )}
                      >
                        {t(/* i18n-dynamic */ `securityOtherEdr.severities.${d.severity}`)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          "inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold",
                          badgeClass(d.status, statusBadge),
                        )}
                      >
                        {t(/* i18n-dynamic */ `securityOtherEdr.statuses.${d.status}`)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {d.breezeDeviceId ? (
                        <a
                          data-testid={`other-edr-device-link-${d.id}`}
                          href={`/devices/${d.breezeDeviceId}`}
                          className="font-medium text-primary hover:underline"
                        >
                          {d.deviceName ?? d.breezeDeviceId}
                        </a>
                      ) : (
                        <span className="inline-flex items-center gap-2">
                          <span>{d.deviceName ?? "-"}</span>
                          {d.detached && (
                            <span
                              data-testid={`other-edr-detached-${d.id}`}
                              className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground"
                            >
                              {t("securityOtherEdr.detached")}
                            </span>
                          )}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {formatWhen(d.detectedAt)}
                    </td>
                    <td className="px-4 py-3">
                      {promoted ? (
                        <a
                          href={`/incidents/${promoted}`}
                          data-testid={`other-edr-promoted-${d.id}`}
                          className="text-xs font-medium text-primary hover:underline"
                        >
                          {t("securityOtherEdr.promoted")}
                        </a>
                      ) : alreadyPromoted.has(d.id) ? (
                        <span
                          data-testid={`other-edr-already-promoted-${d.id}`}
                          className="text-xs text-muted-foreground"
                        >
                          {t("securityOtherEdr.alreadyPromoted")}
                        </span>
                      ) : (
                        <button
                          type="button"
                          data-testid={`other-edr-promote-${d.id}`}
                          onClick={() => void promote(d)}
                          disabled={promotingId === d.id}
                          className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-60"
                        >
                          {promotingId === d.id && (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          )}
                          {t("securityOtherEdr.promoteToIncident")}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {t("securityOtherEdr.showing", { from, to, total })}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            data-testid="other-edr-prev"
            disabled={offset === 0 || loading}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
          >
            {t("securityOtherEdr.previous")}
          </button>
          <button
            type="button"
            data-testid="other-edr-next"
            disabled={offset + PAGE_SIZE >= total || loading}
            onClick={() => setOffset(offset + PAGE_SIZE)}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
          >
            {t("securityOtherEdr.next")}
          </button>
        </div>
      </div>
    </div>
  );
}
