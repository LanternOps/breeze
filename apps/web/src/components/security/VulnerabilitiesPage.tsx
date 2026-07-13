import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { useHashState } from "@/lib/useHashState";
import {
  AlertTriangle,
  Loader2,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import {
  cn,
  formatNumber,
  formatSafeDate,
  friendlyFetchError,
} from "@/lib/utils";
import { errorKindOf, throwIfNotOk, type LoadErrorKind } from "@/lib/httpError";
import { fetchWithAuth } from "@/stores/auth";
import AccessDenied from "../shared/AccessDenied";
import SecurityPageHeader from "./SecurityPageHeader";
import SecurityStatCard from "./SecurityStatCard";
import {
  ResponsiveTable,
  DataCard,
  CardField,
} from "../shared/ResponsiveTable";
type Threat = {
  id: string;
  deviceId: string;
  deviceName: string;
  name: string;
  category: string;
  severity: string;
  status: string;
  detectedAt: string;
  filePath: string;
};
type Pagination = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};
const severityBadge: Record<string, string> = {
  critical: "bg-red-500/15 text-red-700 border-red-500/30",
  high: "bg-orange-500/15 text-orange-700 border-orange-500/30",
  medium: "bg-yellow-500/15 text-yellow-800 border-yellow-500/30",
  low: "bg-blue-500/15 text-blue-700 border-blue-500/30",
};
const statusBadge: Record<string, string> = {
  active: "bg-red-500/15 text-red-700 border-red-500/30",
  quarantined: "bg-amber-500/15 text-amber-800 border-amber-500/30",
  removed: "bg-emerald-500/15 text-emerald-700 border-emerald-500/30",
};
export default function VulnerabilitiesPage() {
  const { t } = useTranslation("security");
  const [threats, setThreats] = useState<Threat[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 50,
    total: 0,
    totalPages: 1,
  });
  const [summary, setSummary] = useState({
    total: 0,
    active: 0,
    quarantined: 0,
    critical: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [errorKind, setErrorKind] = useState<LoadErrorKind>("none");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  // Deep-linkable severity filter (#severity=critical), see dashboard severity rows.
  // Adopted post-mount to avoid an SSR hydration mismatch (#2421).
  const [severity, setSeverity] = useHashState<string>(
    "",
    (h) => h.match(/severity=(critical|high|medium|low)/)?.[1],
  );
  const [status, setStatus] = useState("");
  const [category, setCategory] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const fetchData = useCallback(
    async (page = 1) => {
      setError(undefined);
      setErrorKind("none");
      setLoading(true);
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const params = new URLSearchParams({ page: String(page), limit: "50" });
        if (debouncedSearch) params.set("search", debouncedSearch);
        if (severity) params.set("severity", severity);
        if (status) params.set("status", status);
        if (category) params.set("category", category);
        const res = await fetchWithAuth(`/security/threats?${params}`, {
          signal: controller.signal,
        });
        // HttpError (not a bare Error) so a 403 survives the throw and the render
        // can tell "you may not see this" from "this broke, try again" (#2472).
        throwIfNotOk(res);
        const json = await res.json();
        if (!Array.isArray(json.data))
          throw new Error(
            t("securityVulnerabilitiesPage.invalidResponseFromServer"),
          );
        setThreats(json.data);
        if (json.pagination) setPagination(json.pagination);
        if (json.summary) setSummary(json.summary);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("[VulnerabilitiesPage] fetch error:", err);
        const kind = errorKindOf(err);
        setErrorKind(kind);
        // 'denied' renders AccessDenied, which supplies its own copy.
        if (kind === "other") setError(friendlyFetchError(err));
      } finally {
        // An aborted request must NOT drop the spinner — a superseding request
        // is still in flight. On a `#severity=` deep link the hook's post-mount
        // adoption (#2421) aborts the seed fetch, and clearing `loading` here
        // would paint the settled "No vulnerabilities found" empty state (rows
        // are still []) for the whole duration of the real request.
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [debouncedSearch, severity, status, category],
  );
  useEffect(() => {
    fetchData();
    return () => abortRef.current?.abort();
  }, [fetchData]);
  const handleBulkAction = async (action: "quarantine" | "remove") => {
    try {
      for (const id of selectedIds) {
        const res = await fetchWithAuth(`/security/threats/${id}/${action}`, {
          method: "POST",
        });
        throwIfNotOk(res);
      }
      setSelectedIds(new Set());
    } catch (err) {
      console.error("[VulnerabilitiesPage] bulk action error:", err);
      setError(friendlyFetchError(err));
    }
    fetchData(pagination.page);
  };
  const allSelected =
    threats.length > 0 && threats.every((t) => selectedIds.has(t.id));
  const someSelected = threats.some((t) => selectedIds.has(t.id));
  const toggleAll = (checked: boolean) => {
    setSelectedIds(checked ? new Set(threats.map((t) => t.id)) : new Set());
  };
  const toggleOne = (id: string, checked: boolean) => {
    const next = new Set(selectedIds);
    if (checked) next.add(id);
    else next.delete(id);
    setSelectedIds(next);
  };
  const { active, quarantined, critical } = summary;
  // Cell pieces shared by the desktop table and the mobile cards.
  const renderSeverity = (t: Threat) => (
    <span
      className={cn(
        "inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold capitalize",
        severityBadge[t.severity],
      )}
    >
      {t.severity}
    </span>
  );
  const renderStatus = (t: Threat) => (
    <span
      className={cn(
        "inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold capitalize",
        statusBadge[t.status],
      )}
    >
      {t.status}
    </span>
  );
  if (loading && threats.length === 0) {
    return (
      <div className="space-y-6">
        <SecurityPageHeader
          title={t("securityVulnerabilitiesPage.vulnerabilities")}
          subtitle={t(
            "securityVulnerabilitiesPage.detectedThreatsAcrossAllDevices",
          )}
        />
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }
  // A 403 is terminal for this user — a retry hits the same permission gate. Stop
  // before the summary tiles: falling through would paint the zeroed `summary`
  // default and tell someone who may not see the data that 0 threats are
  // active. Fabricated zeros are worse than an error. (#2472)
  if (errorKind === "denied") {
    return (
      <div className="space-y-6">
        <SecurityPageHeader
          title={t("securityVulnerabilitiesPage.vulnerabilities")}
          subtitle={t(
            "securityVulnerabilitiesPage.detectedThreatsAcrossAllDevices",
          )}
        />
        <AccessDenied testId="security-vulnerabilities-denied" />
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <SecurityPageHeader
        title={t("securityVulnerabilitiesPage.vulnerabilities")}
        subtitle={t(
          "securityVulnerabilitiesPage.detectedThreatsAcrossAllDevices",
        )}
        loading={loading}
        onRefresh={() => fetchData(pagination.page)}
      />

      <div className="grid gap-4 sm:grid-cols-4">
        <SecurityStatCard
          icon={AlertTriangle}
          label={t("securityVulnerabilitiesPage.total")}
          value={formatNumber(pagination.total)}
        />
        <SecurityStatCard
          icon={Shield}
          label={t("securityVulnerabilitiesPage.critical")}
          value={formatNumber(critical)}
          variant="danger"
        />
        <SecurityStatCard
          icon={ShieldAlert}
          label={t("securityVulnerabilitiesPage.active")}
          value={formatNumber(active)}
          variant="warning"
        />
        <SecurityStatCard
          icon={ShieldCheck}
          label={t("securityVulnerabilitiesPage.quarantined")}
          value={formatNumber(quarantined)}
          variant="success"
        />
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-center">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative w-full lg:w-64">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            placeholder={t("securityVulnerabilitiesPage.searchThreats")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <select
            value={severity}
            onChange={(e) => {
              const value = e.target.value;
              setSeverity(value);
              window.history.replaceState(
                null,
                "",
                value ? `#severity=${value}` : window.location.pathname,
              );
            }}
            className="h-10 rounded-md border bg-background px-3 text-sm"
          >
            <option value="">
              {t("securityVulnerabilitiesPage.allSeverities")}
            </option>
            <option value="critical">
              {t("securityVulnerabilitiesPage.critical")}
            </option>
            <option value="high">
              {t("securityVulnerabilitiesPage.high")}
            </option>
            <option value="medium">
              {t("securityVulnerabilitiesPage.medium")}
            </option>
            <option value="low">{t("securityVulnerabilitiesPage.low")}</option>
          </select>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="h-10 rounded-md border bg-background px-3 text-sm"
          >
            <option value="">
              {t("securityVulnerabilitiesPage.allStatuses")}
            </option>
            <option value="active">
              {t("securityVulnerabilitiesPage.active")}
            </option>
            <option value="quarantined">
              {t("securityVulnerabilitiesPage.quarantined")}
            </option>
            <option value="removed">
              {t("securityVulnerabilitiesPage.removed")}
            </option>
          </select>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="h-10 rounded-md border bg-background px-3 text-sm"
          >
            <option value="">
              {t("securityVulnerabilitiesPage.allCategories")}
            </option>
            <option value="trojan">
              {t("securityVulnerabilitiesPage.trojan")}
            </option>
            <option value="ransomware">
              {t("securityVulnerabilitiesPage.ransomware")}
            </option>
            <option value="malware">
              {t("securityVulnerabilitiesPage.malware")}
            </option>
            <option value="spyware">
              {t("securityVulnerabilitiesPage.spyware")}
            </option>
            <option value="pup">{t("securityVulnerabilitiesPage.pup")}</option>
          </select>
        </div>
      </div>

      {selectedIds.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/40 px-4 py-3">
          <span className="text-sm font-medium">
            {t("securityVulnerabilitiesPage.selectedCount", {
              count: selectedIds.size,
            })}
          </span>
          <button
            type="button"
            onClick={() => handleBulkAction("quarantine")}
            className="flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            <ShieldAlert className="h-4 w-4" />
            {t("securityVulnerabilitiesPage.quarantine")}
          </button>
          <button
            type="button"
            onClick={() => handleBulkAction("remove")}
            className="flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            <ShieldCheck className="h-4 w-4" />
            {t("securityVulnerabilitiesPage.remove")}
          </button>
          <button
            type="button"
            onClick={() => setSelectedIds(new Set())}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            {t("securityVulnerabilitiesPage.clear")}
          </button>
        </div>
      )}

      <ResponsiveTable
        table={
          <table className="min-w-full divide-y bg-card">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someSelected && !allSelected;
                    }}
                    onChange={(e) => toggleAll(e.target.checked)}
                    className="h-4 w-4 rounded border-border"
                  />
                </th>
                <th className="px-4 py-3">
                  {t("securityVulnerabilitiesPage.device")}
                </th>
                <th className="px-4 py-3">
                  {t("securityVulnerabilitiesPage.threat")}
                </th>
                <th className="px-4 py-3">
                  {t("securityVulnerabilitiesPage.category")}
                </th>
                <th className="px-4 py-3">
                  {t("securityVulnerabilitiesPage.severity")}
                </th>
                <th className="px-4 py-3">
                  {t("securityVulnerabilitiesPage.status")}
                </th>
                <th className="px-4 py-3">
                  {t("securityVulnerabilitiesPage.detected")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {threats.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-8 text-center text-sm text-muted-foreground"
                  >
                    {t("securityVulnerabilitiesPage.noThreatsFound")}
                  </td>
                </tr>
              ) : (
                threats.map((threat) => (
                  <tr key={threat.id} className="transition hover:bg-muted/40">
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(threat.id)}
                        onChange={(e) => toggleOne(threat.id, e.target.checked)}
                        className="h-4 w-4 rounded border-border"
                      />
                    </td>
                    <td className="px-4 py-3 text-sm font-medium">
                      {threat.deviceName}
                    </td>
                    <td className="px-4 py-3 text-sm">{threat.name}</td>
                    <td className="px-4 py-3 text-sm capitalize text-muted-foreground">
                      {threat.category}
                    </td>
                    <td className="px-4 py-3">{renderSeverity(threat)}</td>
                    <td className="px-4 py-3">{renderStatus(threat)}</td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {formatSafeDate(threat.detectedAt)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        }
        cards={
          threats.length === 0 ? (
            <DataCard>
              <p className="py-2 text-center text-sm text-muted-foreground">
                {t("securityVulnerabilitiesPage.noThreatsFound")}
              </p>
            </DataCard>
          ) : (
            threats.map((threat) => (
              <DataCard
                key={threat.id}
                className={
                  threat.severity === "critical"
                    ? "bg-destructive/5"
                    : undefined
                }
              >
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    aria-label={t("securityVulnerabilitiesPage.selectThreat", {
                      name: threat.name,
                    })}
                    checked={selectedIds.has(threat.id)}
                    onChange={(e) => toggleOne(threat.id, e.target.checked)}
                    className="mt-1 h-4 w-4 shrink-0 rounded border-border"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 wrap-break-word text-sm font-semibold">
                        {threat.name}
                      </span>
                      {renderSeverity(threat)}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {threat.deviceName}
                    </div>
                  </div>
                </div>
                <div className="mt-3 space-y-2 border-t pt-3">
                  <CardField label={t("securityVulnerabilitiesPage.category")}>
                    <span className="text-sm capitalize text-muted-foreground">
                      {threat.category}
                    </span>
                  </CardField>
                  <CardField label={t("securityVulnerabilitiesPage.status")}>
                    {renderStatus(threat)}
                  </CardField>
                  <CardField label={t("securityVulnerabilitiesPage.detected")}>
                    <span className="text-sm text-muted-foreground">
                      {formatSafeDate(threat.detectedAt)}
                    </span>
                  </CardField>
                </div>
              </DataCard>
            ))
          )
        }
      />

      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {t("securityVulnerabilitiesPage.pageOfTotal", {
              page: pagination.page,
              totalPages: pagination.totalPages,
              total: pagination.total,
            })}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pagination.page <= 1}
              onClick={() => fetchData(pagination.page - 1)}
              className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-50"
            >
              {t("securityVulnerabilitiesPage.previous")}
            </button>
            <button
              type="button"
              disabled={pagination.page >= pagination.totalPages}
              onClick={() => fetchData(pagination.page + 1)}
              className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-50"
            >
              {t("securityVulnerabilitiesPage.next")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
