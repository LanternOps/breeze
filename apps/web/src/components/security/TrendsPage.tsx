import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Loader2, TrendingDown, TrendingUp } from "lucide-react";
import { cn, friendlyFetchError } from "@/lib/utils";
import { fetchWithAuth } from "@/stores/auth";
import SecurityPageHeader from "./SecurityPageHeader";
import SecurityStatCard from "./SecurityStatCard";
type TrendSummary = {
  current: number;
  previous: number;
  change: number;
  trend: "improving" | "declining" | "stable";
};
type TrendsData = {
  period: string;
  dataPoints: Array<Record<string, string | number>>;
  summary: TrendSummary;
};
const lineColors: Record<string, string> = {
  overall: "#22c55e",
  antivirus: "#3b82f6",
  firewall: "#06b6d4",
  encryption: "#8b5cf6",
  password_policy: "#f59e0b",
  admin_accounts: "#ef4444",
  patch_compliance: "#ec4899",
  vulnerability_management: "#f97316",
};
const lineDotClasses: Record<string, string> = {
  overall: "bg-green-500",
  antivirus: "bg-blue-500",
  firewall: "bg-cyan-500",
  encryption: "bg-violet-500",
  password_policy: "bg-amber-500",
  admin_accounts: "bg-red-500",
  patch_compliance: "bg-pink-500",
  vulnerability_management: "bg-orange-500",
};
type Period = "7d" | "30d" | "90d";
export default function TrendsPage() {
  const { t } = useTranslation("security");
  const [data, setData] = useState<TrendsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [period, setPeriod] = useState<Period>("30d");
  const [visibleLines, setVisibleLines] = useState<Set<string>>(
    new Set(["overall", "antivirus", "firewall", "encryption"]),
  );
  const abortRef = useRef<AbortController | null>(null);
  const lineLabelMap: Record<string, string> = {
    overall: t("securityTrendsPage.overall"),
    antivirus: t("securityTrendsPage.antivirus"),
    firewall: t("securityTrendsPage.firewall"),
    encryption: t("securityTrendsPage.encryption"),
    password_policy: t("securityTrendsPage.passwordPolicy"),
    admin_accounts: t("securityTrendsPage.adminAccounts"),
    patch_compliance: t("securityTrendsPage.patchCompliance"),
    vulnerability_management: t("securityTrendsPage.vulnMgmt"),
  };
  const fetchData = useCallback(async () => {
    setError(undefined);
    setLoading(true);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetchWithAuth(`/security/trends?period=${period}`, {
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const json = await res.json();
      if (!json.data)
        throw new Error(t("securityTrendsPage.invalidResponseFromServer"));
      setData(json.data);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      console.error("[TrendsPage] fetch error:", err);
      setError(friendlyFetchError(err));
    } finally {
      setLoading(false);
    }
  }, [period]);
  useEffect(() => {
    fetchData();
    return () => abortRef.current?.abort();
  }, [fetchData]);
  const toggleLine = (key: string) => {
    setVisibleLines((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        if (next.size > 1) next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };
  if (loading && !data) {
    return (
      <div className="space-y-6">
        <SecurityPageHeader
          title={t("securityTrendsPage.securityTrends")}
          subtitle={t("securityTrendsPage.scoreMovementOverTime")}
        />
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }
  if (error && !data) {
    return (
      <div className="space-y-6">
        <SecurityPageHeader
          title={t("securityTrendsPage.securityTrends")}
          subtitle={t("securityTrendsPage.scoreMovementOverTime")}
        />
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
          <p className="text-sm text-destructive">{error}</p>
          <button
            type="button"
            onClick={fetchData}
            className="mt-2 text-sm text-primary hover:underline"
          >
            {t("securityTrendsPage.retry")}
          </button>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="space-y-6">
        <SecurityPageHeader
          title={t("securityTrendsPage.securityTrends")}
          subtitle={t("securityTrendsPage.scoreMovementOverTime")}
        />
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
          <p className="text-sm text-destructive">
            {t("securityTrendsPage.unableToLoadTrendsData")}
          </p>
          <button
            type="button"
            onClick={fetchData}
            className="mt-2 text-sm text-primary hover:underline"
          >
            {t("securityTrendsPage.retry")}
          </button>
        </div>
      </div>
    );
  }
  const TrendIcon =
    data.summary.trend === "improving" ? TrendingUp : TrendingDown;
  return (
    <div className="space-y-6">
      <SecurityPageHeader
        title={t("securityTrendsPage.securityTrends")}
        subtitle={t("securityTrendsPage.scoreMovementOverTime")}
        loading={loading}
        onRefresh={fetchData}
      />

      {error && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-center">
          <p className="text-sm text-amber-700">
            {t("securityTrendsPage.dataMayBeOutdated", { error })}
          </p>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-4">
        <SecurityStatCard
          icon={TrendIcon}
          label={t("securityTrendsPage.currentScore")}
          value={data.summary.current}
          variant={
            data.summary.current >= 80
              ? "success"
              : data.summary.current >= 60
                ? "warning"
                : "danger"
          }
        />
        <SecurityStatCard
          icon={TrendIcon}
          label={t("securityTrendsPage.previousScore")}
          value={data.summary.previous}
        />
        <SecurityStatCard
          icon={TrendIcon}
          label={t("securityTrendsPage.change")}
          value={`${data.summary.change >= 0 ? "+" : ""}${data.summary.change}`}
          variant={
            data.summary.change > 0
              ? "success"
              : data.summary.change < 0
                ? "danger"
                : "default"
          }
        />
        <SecurityStatCard
          icon={TrendIcon}
          label={t("securityTrendsPage.trend")}
          value={data.summary.trend}
          variant={
            data.summary.trend === "improving"
              ? "success"
              : data.summary.trend === "declining"
                ? "danger"
                : "default"
          }
        />
      </div>

      <div className="flex gap-2">
        {(["7d", "30d", "90d"] as Period[]).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPeriod(p)}
            className={cn(
              "rounded-md border px-3 py-1.5 text-sm font-medium",
              period === p
                ? "bg-primary text-primary-foreground"
                : "bg-background hover:bg-muted",
            )}
          >
            {p === "7d"
              ? t("securityTrendsPage.value7Days")
              : p === "30d"
                ? t("securityTrendsPage.value30Days")
                : t("securityTrendsPage.value90Days")}
          </button>
        ))}
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <div className="mb-4 flex flex-wrap gap-2">
          {Object.entries(lineLabelMap).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => toggleLine(key)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition",
                visibleLines.has(key)
                  ? "border-transparent bg-muted text-foreground"
                  : "border-muted text-muted-foreground opacity-50",
              )}
            >
              <span
                className={cn(
                  "h-2.5 w-2.5 rounded-full",
                  lineDotClasses[key] ?? "bg-muted",
                )}
              />
              {label}
            </button>
          ))}
        </div>
        <div className="h-96">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data.dataPoints}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis
                dataKey="timestamp"
                tick={{ fontSize: 10 }}
                className="text-muted-foreground"
              />
              <YAxis
                domain={[0, 100]}
                tick={{ fontSize: 10 }}
                className="text-muted-foreground"
              />
              <Tooltip wrapperClassName="chart-tooltip" />
              <Legend />
              {Object.entries(lineColors).map(([key, color]) =>
                visibleLines.has(key) ? (
                  <Line
                    key={key}
                    type="monotone"
                    dataKey={key}
                    name={lineLabelMap[key]}
                    stroke={color}
                    strokeWidth={key === "overall" ? 2.5 : 1.5}
                    dot={false}
                  />
                ) : null,
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
