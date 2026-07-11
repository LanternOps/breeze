import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { Loader2, Search, ShieldCheck, ShieldOff } from "lucide-react";
import { cn, formatNumber, friendlyFetchError } from "@/lib/utils";
import { fetchWithAuth } from "@/stores/auth";
import SecurityPageHeader from "./SecurityPageHeader";
import SecurityStatCard from "./SecurityStatCard";
type DeviceStatus = {
  deviceId: string;
  deviceName: string;
  os: string;
  status: string;
  riskLevel: string;
  realTimeProtection: boolean;
  provider: {
    name: string;
    vendor: string;
  } | null;
};
type DashboardStats = {
  totalDevices: number;
  protectedDevices: number;
  atRiskDevices: number;
  unprotectedDevices: number;
  offlineDevices: number;
  providers: Array<{
    providerId: string;
    providerName: string;
    deviceCount: number;
    coverage: number;
  }>;
};
type Pagination = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};
const PIE_COLORS = ["#22c55e", "#3b82f6", "#f59e0b", "#8b5cf6"];
const PIE_DOT_CLASSES = [
  "bg-green-500",
  "bg-blue-500",
  "bg-amber-500",
  "bg-violet-500",
];
const statusBadge: Record<string, string> = {
  protected: "bg-emerald-500/15 text-emerald-700 border-emerald-500/30",
  at_risk: "bg-amber-500/15 text-amber-700 border-amber-500/30",
  unprotected: "bg-red-500/15 text-red-700 border-red-500/30",
  offline: "bg-slate-500/15 text-slate-700 border-slate-500/30",
};
export default function AntivirusPage() {
  const { t } = useTranslation("security");
  const [devices, setDevices] = useState<DeviceStatus[]>([]);
  const [dashboard, setDashboard] = useState<DashboardStats | null>(null);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 50,
    total: 0,
    totalPages: 1,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [osFilter, setOsFilter] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const fetchData = useCallback(
    async (page = 1) => {
      setError(undefined);
      setLoading(true);
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const params = new URLSearchParams({ page: String(page), limit: "50" });
        if (debouncedSearch) params.set("search", debouncedSearch);
        if (statusFilter) params.set("status", statusFilter);
        if (osFilter) params.set("os", osFilter);
        const [statusRes, dashRes] = await Promise.all([
          fetchWithAuth(`/security/status?${params}`, {
            signal: controller.signal,
          }),
          fetchWithAuth("/security/dashboard", { signal: controller.signal }),
        ]);
        if (!statusRes.ok) throw new Error(`${statusRes.status}`);
        const statusJson = await statusRes.json();
        if (!Array.isArray(statusJson.data))
          throw new Error(t("securityAntivirusPage.invalidResponseFromServer"));
        setDevices(statusJson.data);
        if (statusJson.pagination) setPagination(statusJson.pagination);
        if (dashRes.ok) {
          const dashJson = await dashRes.json();
          setDashboard(dashJson.data ?? null);
        } else {
          console.error(
            "[AntivirusPage] dashboard fetch failed:",
            dashRes.status,
          );
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("[AntivirusPage] fetch error:", err);
        setError(friendlyFetchError(err));
      } finally {
        setLoading(false);
      }
    },
    [debouncedSearch, statusFilter, osFilter],
  );
  useEffect(() => {
    fetchData();
    return () => abortRef.current?.abort();
  }, [fetchData]);
  if (loading && devices.length === 0) {
    return (
      <div className="space-y-6">
        <SecurityPageHeader
          title={t("securityAntivirusPage.antivirusCoverage")}
          subtitle={t(
            "securityAntivirusPage.endpointProtectionStatusAcrossAllDevices",
          )}
        />
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }
  const total = dashboard?.totalDevices ?? 0;
  const prot = dashboard?.protectedDevices ?? 0;
  const unprot = dashboard?.unprotectedDevices ?? 0;
  const coveragePercent = total ? Math.round((prot / total) * 100) : 0;
  const pieData = (dashboard?.providers ?? [])
    .filter((p) => p.deviceCount > 0)
    .map((p) => ({ name: p.providerName, value: p.deviceCount }));
  return (
    <div className="space-y-6">
      <SecurityPageHeader
        title={t("securityAntivirusPage.antivirusCoverage")}
        subtitle={t(
          "securityAntivirusPage.endpointProtectionStatusAcrossAllDevices",
        )}
        loading={loading}
        onRefresh={() => fetchData(pagination.page)}
      />

      <div className="grid gap-4 sm:grid-cols-4">
        <SecurityStatCard
          icon={ShieldCheck}
          label={t("securityAntivirusPage.totalDevices")}
          value={formatNumber(total)}
        />
        <SecurityStatCard
          icon={ShieldCheck}
          label={t("securityAntivirusPage.protected")}
          value={formatNumber(prot)}
          variant="success"
        />
        <SecurityStatCard
          icon={ShieldOff}
          label={t("securityAntivirusPage.unprotected")}
          value={formatNumber(unprot)}
          variant="danger"
        />
        <SecurityStatCard
          icon={ShieldCheck}
          label={t("securityAntivirusPage.coverage")}
          value={`${coveragePercent}%`}
          variant={coveragePercent >= 90 ? "success" : "warning"}
        />
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-center">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-12">
        {pieData.length > 0 && (
          <div className="rounded-lg border bg-card p-6 shadow-xs lg:col-span-4">
            <p className="text-sm font-semibold">
              {t("securityAntivirusPage.providerDistribution")}
            </p>
            <div className="mt-4 h-56">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    outerRadius={80}
                    label
                  >
                    {pieData.map((_, i) => (
                      <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip wrapperClassName="chart-tooltip" />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-4 space-y-2">
              {(dashboard?.providers ?? []).map((p, i) => (
                <div
                  key={p.providerId}
                  className="flex items-center justify-between text-sm"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "h-2.5 w-2.5 rounded-full",
                        PIE_DOT_CLASSES[i % PIE_DOT_CLASSES.length],
                      )}
                    />
                    <span className="truncate">{p.providerName}</span>
                  </div>
                  <span className="font-medium">{p.deviceCount}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div
          className={cn(
            "space-y-4",
            pieData.length > 0 ? "lg:col-span-8" : "lg:col-span-12",
          )}
        >
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="relative w-full lg:w-64">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                placeholder={t("securityAntivirusPage.searchDevices")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="h-10 rounded-md border bg-background px-3 text-sm"
            >
              <option value="">{t("securityAntivirusPage.allStatuses")}</option>
              <option value="protected">
                {t("securityAntivirusPage.protected")}
              </option>
              <option value="at_risk">
                {t("securityAntivirusPage.atRisk")}
              </option>
              <option value="unprotected">
                {t("securityAntivirusPage.unprotected")}
              </option>
              <option value="offline">
                {t("securityAntivirusPage.offline")}
              </option>
            </select>
            <select
              value={osFilter}
              onChange={(e) => setOsFilter(e.target.value)}
              className="h-10 rounded-md border bg-background px-3 text-sm"
            >
              <option value="">{t("securityAntivirusPage.allOS")}</option>
              <option value="windows">
                {t("securityAntivirusPage.windows")}
              </option>
              <option value="macos">{t("securityAntivirusPage.macos")}</option>
              <option value="linux">{t("securityAntivirusPage.linux")}</option>
            </select>
          </div>

          <div className="overflow-x-auto rounded-lg border bg-card shadow-xs">
            <table className="min-w-full divide-y">
              <thead className="bg-muted/40">
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3">
                    {t("securityAntivirusPage.device")}
                  </th>
                  <th className="px-4 py-3">{t("securityAntivirusPage.os")}</th>
                  <th className="px-4 py-3">
                    {t("securityAntivirusPage.provider")}
                  </th>
                  <th className="px-4 py-3">
                    {t("securityAntivirusPage.status")}
                  </th>
                  <th className="px-4 py-3">
                    {t("securityAntivirusPage.realTime")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {devices.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-4 py-8 text-center text-sm text-muted-foreground"
                    >
                      {t("securityAntivirusPage.noDevicesFound")}
                    </td>
                  </tr>
                ) : (
                  devices.map((d) => (
                    <tr
                      key={d.deviceId}
                      className="transition hover:bg-muted/40"
                    >
                      <td className="px-4 py-3 text-sm font-medium">
                        {d.deviceName}
                      </td>
                      <td className="px-4 py-3 text-sm capitalize text-muted-foreground">
                        {d.os}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {d.provider?.name ?? t("securityAntivirusPage.unknown")}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={cn(
                            "inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold",
                            statusBadge[d.status] ?? "",
                          )}
                        >
                          {d.status.replace("_", " ")}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {d.realTimeProtection ? (
                          <span className="text-emerald-600">
                            {t("securityAntivirusPage.active")}
                          </span>
                        ) : (
                          <span className="text-red-600">
                            {t("securityAntivirusPage.inactive")}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {pagination.totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {t("securityAntivirusPage.pageOf", {
                  page: pagination.page,
                  totalPages: pagination.totalPages,
                })}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={pagination.page <= 1}
                  onClick={() => fetchData(pagination.page - 1)}
                  className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-50"
                >
                  {t("securityAntivirusPage.previous")}
                </button>
                <button
                  type="button"
                  disabled={pagination.page >= pagination.totalPages}
                  onClick={() => fetchData(pagination.page + 1)}
                  className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-50"
                >
                  {t("securityAntivirusPage.next")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
