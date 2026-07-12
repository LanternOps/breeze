import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Calendar } from "lucide-react";
import { formatDateTime as formatUserDateTime } from "@/lib/dateTimeFormat";
import { fetchWithAuth } from "../../stores/auth";
import { useTranslation } from "react-i18next";
import "../../lib/i18n";

type AlertItem = {
  id?: string;
  severity?: string;
  level?: string;
  message?: string;
  summary?: string;
  status?: string;
  createdAt?: string;
  timestamp?: string;
};

type DeviceAlertHistoryProps = {
  deviceId: string;
  timezone?: string;
  showFilters?: boolean;
  limit?: number;
};

// Severity badges use the same semantic-token vocabulary as the device status
// badge (DeviceDetails statusColors) and the warranty card — one consistent
// `bg-X/15 text-X border-X/30` pattern across the whole device surface, instead
// of three divergent raw-palette systems (#device-overview-polish).
const severityStyles: Record<string, string> = {
  critical: "bg-destructive/15 text-destructive border-destructive/30",
  error: "bg-destructive/15 text-destructive border-destructive/30",
  warning: "bg-warning/15 text-warning border-warning/30",
  info: "bg-info/15 text-info border-info/30",
};

function formatDateTime(value?: string, timezone?: string) {
  if (!value) return "Not reported";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : formatUserDateTime(date, timezone ? { timeZone: timezone } : undefined);
}

export default function DeviceAlertHistory({
  deviceId,
  timezone,
  showFilters = true,
  limit,
}: DeviceAlertHistoryProps) {
  const { t } = useTranslation("devices");
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [siteTimezone, setSiteTimezone] = useState<string | undefined>(
    timezone,
  );
  const [startDateInput, setStartDateInput] = useState("");
  const [endDateInput, setEndDateInput] = useState("");
  const [appliedRange, setAppliedRange] = useState({
    startDate: "",
    endDate: "",
  });

  // Use provided timezone, fetched siteTimezone, or browser default
  const effectiveTimezone =
    timezone ??
    siteTimezone ??
    Intl.DateTimeFormat().resolvedOptions().timeZone;

  const fetchAlerts = useCallback(
    async (range?: { startDate: string; endDate: string }) => {
      setLoading(true);
      setError(undefined);
      try {
        const params = new URLSearchParams();
        const startDate = range?.startDate ?? appliedRange.startDate;
        const endDate = range?.endDate ?? appliedRange.endDate;
        if (startDate) params.set("startDate", startDate);
        if (endDate) params.set("endDate", endDate);
        const response = await fetchWithAuth(
          `/devices/${deviceId}/alerts?${params}`,
        );
        if (!response.ok) throw new Error("Failed to fetch alert history");
        const json = await response.json();
        const payload = json?.data ?? json;
        setAlerts(Array.isArray(payload) ? payload : []);
        if (json?.timezone || json?.siteTimezone) {
          setSiteTimezone(json.timezone ?? json.siteTimezone);
        }
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : t("deviceAlertHistory.failedToFetchAlertHistory"),
        );
      } finally {
        setLoading(false);
      }
    },
    [appliedRange.endDate, appliedRange.startDate, deviceId],
  );

  useEffect(() => {
    fetchAlerts();
  }, [fetchAlerts]);

  const visibleAlerts = useMemo(() => {
    if (!limit) return alerts;
    return alerts.slice(0, limit);
  }, [alerts, limit]);

  const handleApply = () => {
    const range = { startDate: startDateInput, endDate: endDateInput };
    setAppliedRange(range);
    fetchAlerts(range);
  };

  const handleClear = () => {
    setStartDateInput("");
    setEndDateInput("");
    setAppliedRange({ startDate: "", endDate: "" });
    fetchAlerts({ startDate: "", endDate: "" });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-card py-12 shadow-xs">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-3 text-sm text-muted-foreground">
            {t("deviceAlertHistory.loadingAlertHistory")}
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={() => fetchAlerts()}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {t("deviceAlertHistory.retry")}{" "}
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-lg font-semibold">
            {t("deviceAlertHistory.alertHistory")}
          </h3>
        </div>
        {showFilters && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <div className="relative">
              <Calendar className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="date"
                value={startDateInput}
                onChange={(event) => setStartDateInput(event.target.value)}
                className="h-9 rounded-md border bg-background pl-8 pr-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>
            <span className="text-xs text-muted-foreground">
              {t("deviceAlertHistory.to")}
            </span>
            <div className="relative">
              <Calendar className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="date"
                value={endDateInput}
                onChange={(event) => setEndDateInput(event.target.value)}
                className="h-9 rounded-md border bg-background pl-8 pr-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>
            <button
              type="button"
              onClick={handleApply}
              className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              {t("deviceAlertHistory.apply")}{" "}
            </button>
            <button
              type="button"
              onClick={handleClear}
              className="h-9 rounded-md border px-3 text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              {t("deviceAlertHistory.clear")}{" "}
            </button>
          </div>
        )}
      </div>
      <div className="mt-4 space-y-3">
        {visibleAlerts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("deviceAlertHistory.noAlertsReportedForThisDevice")}
          </p>
        ) : (
          visibleAlerts.map((alert, index) => {
            const severity = (
              alert.severity ||
              alert.level ||
              "info"
            ).toLowerCase();
            const badgeStyle =
              severityStyles[severity] ||
              "bg-muted/40 text-muted-foreground border-muted";
            return (
              <div
                key={
                  alert.id ??
                  `${alert.message ?? alert.summary ?? "alert"}-${index}`
                }
                className="rounded-md border p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">
                      {alert.message || alert.summary || "Alert reported"}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatDateTime(
                        alert.createdAt || alert.timestamp,
                        effectiveTimezone,
                      )}
                    </p>
                  </div>
                  <span
                    className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${badgeStyle}`}
                  >
                    {severity}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
      {limit && alerts.length > limit && (
        <a
          href="#alerts"
          className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
        >
          {t("deviceAlertHistory.viewAll")} {alerts.length}{" "}
          {t("deviceAlertHistory.alerts")}{" "}
          <span aria-hidden="true">{t("deviceAlertHistory.text")}</span>
        </a>
      )}
    </div>
  );
}
