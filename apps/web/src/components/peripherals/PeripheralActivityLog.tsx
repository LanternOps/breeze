import { useState, useEffect, useCallback } from "react";
import { RefreshCw, ChevronLeft, ChevronRight } from "lucide-react";
import { fetchWithAuth } from "../../stores/auth";
import { formatDateTime as formatUserDateTime } from "@/lib/dateTimeFormat";
import { useTranslation } from "react-i18next";

type PeripheralEvent = {
  id: string;
  eventType: string;
  peripheralType: string;
  vendor?: string;
  product?: string;
  serialNumber?: string;
  deviceId: string;
  policyId?: string;
  occurredAt: string;
  details?: Record<string, unknown>;
};

const eventTypeBadge: Record<string, string> = {
  connected: "bg-success/15 text-success border-success/30",
  disconnected: "bg-muted text-muted-foreground border-border",
  blocked: "bg-destructive/15 text-destructive border-destructive/30",
  mounted_read_only: "bg-warning/15 text-warning border-warning/30",
  policy_override: "bg-blue-500/20 text-blue-700 border-blue-500/40",
};

type PeripheralActivityLogProps = {
  deviceId?: string;
  limit?: number;
};

function formatDateTime(value?: string) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : formatUserDateTime(d);
}

export default function PeripheralActivityLog({
  deviceId,
  limit: propLimit,
}: PeripheralActivityLogProps) {
  const { t } = useTranslation("peripherals");
  const [events, setEvents] = useState<PeripheralEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const limit = propLimit ?? 50;

  // Filters
  const [filterEventType, setFilterEventType] = useState("");
  const [filterPeripheralType, setFilterPeripheralType] = useState("");
  const [filterVendor, setFilterVendor] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const params = new URLSearchParams();
      if (deviceId) params.set("deviceId", deviceId);
      if (filterEventType) params.set("eventType", filterEventType);
      if (filterPeripheralType)
        params.set("peripheralType", filterPeripheralType);
      if (filterVendor) params.set("vendor", filterVendor);
      if (filterFrom) params.set("start", new Date(filterFrom).toISOString());
      if (filterTo)
        params.set("end", new Date(filterTo + "T23:59:59").toISOString());
      params.set("limit", String(limit));
      params.set("offset", String(offset));
      const response = await fetchWithAuth(
        `/peripherals/activity?${params.toString()}`,
      );
      if (!response.ok)
        throw new Error(t("peripheralActivityLog.errors.fetch"));
      const json = await response.json();
      const data = Array.isArray(json.data)
        ? json.data
        : Array.isArray(json)
          ? json
          : [];
      setEvents(data);
      setTotal(json.pagination?.total ?? json.total ?? data.length);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("peripheralActivityLog.errors.generic"),
      );
    } finally {
      setLoading(false);
    }
  }, [
    deviceId,
    filterEventType,
    filterPeripheralType,
    filterVendor,
    filterFrom,
    filterTo,
    limit,
    offset,
    t,
  ]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  const handlePrev = () => setOffset(Math.max(0, offset - limit));
  const handleNext = () => setOffset(offset + limit);
  const hasNext = offset + limit < total;
  const hasPrev = offset > 0;

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={filterEventType}
          onChange={(e) => {
            setFilterEventType(e.target.value);
            setOffset(0);
          }}
          className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        >
          <option value="">{t("peripheralActivityLog.allEvents")}</option>
          <option value="connected">
            {t("peripheralActivityLog.events.connected")}
          </option>
          <option value="disconnected">
            {t("peripheralActivityLog.events.disconnected")}
          </option>
          <option value="blocked">
            {t("peripheralActivityLog.events.blocked")}
          </option>
          <option value="mounted_read_only">
            {t("peripheralActivityLog.events.mounted_read_only")}
          </option>
          <option value="policy_override">
            {t("peripheralActivityLog.events.policy_override")}
          </option>
        </select>
        <input
          value={filterPeripheralType}
          onChange={(e) => {
            setFilterPeripheralType(e.target.value);
            setOffset(0);
          }}
          placeholder={t("peripheralActivityLog.peripheralType")}
          className="h-9 w-32 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        />
        <input
          value={filterVendor}
          onChange={(e) => {
            setFilterVendor(e.target.value);
            setOffset(0);
          }}
          placeholder={t("peripheralActivityLog.vendor")}
          className="h-9 w-32 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        />
        <input
          type="date"
          value={filterFrom}
          onChange={(e) => {
            setFilterFrom(e.target.value);
            setOffset(0);
          }}
          className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        />
        <input
          type="date"
          value={filterTo}
          onChange={(e) => {
            setFilterTo(e.target.value);
            setOffset(0);
          }}
          className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        />
        <button
          type="button"
          onClick={() => fetchEvents()}
          className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted ml-auto"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="rounded-lg border bg-card shadow-xs">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : events.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {t("peripheralActivityLog.empty")}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y">
              <thead className="bg-muted/40">
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3">
                    {t("peripheralActivityLog.columns.occurredAt")}
                  </th>
                  <th className="px-4 py-3">
                    {t("peripheralActivityLog.columns.eventType")}
                  </th>
                  <th className="px-4 py-3">
                    {t("peripheralActivityLog.peripheralType")}
                  </th>
                  <th className="px-4 py-3">
                    {t("peripheralActivityLog.vendor")}
                  </th>
                  <th className="px-4 py-3">
                    {t("peripheralActivityLog.columns.product")}
                  </th>
                  <th className="px-4 py-3">
                    {t("peripheralActivityLog.columns.serialNumber")}
                  </th>
                  {!deviceId && (
                    <th className="px-4 py-3">
                      {t("peripheralActivityLog.columns.device")}
                    </th>
                  )}
                  <th className="px-4 py-3">
                    {t("peripheralActivityLog.columns.policy")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {events.map((event) => (
                  <tr key={event.id} className="text-sm">
                    <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                      {formatDateTime(event.occurredAt)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${eventTypeBadge[event.eventType] ?? "bg-muted text-muted-foreground"}`}
                      >
                        {t(`peripheralActivityLog.events.${event.eventType}`, {
                          defaultValue: event.eventType.replace("_", " "),
                        })}{" "}
                        {/* i18n-dynamic */}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {event.peripheralType}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {event.vendor ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {event.product ?? "—"}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                      {event.serialNumber ?? "—"}
                    </td>
                    {!deviceId && (
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                        {event.deviceId.slice(0, 8)}...
                      </td>
                    )}
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                      {event.policyId
                        ? `${event.policyId.slice(0, 8)}...`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {total > limit && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {t("peripheralActivityLog.pagination", {
              from: offset + 1,
              to: Math.min(offset + limit, total),
              total,
            })}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handlePrev}
              disabled={!hasPrev}
              className="inline-flex h-8 items-center gap-1 rounded-md border px-3 text-xs font-medium hover:bg-muted disabled:opacity-50"
            >
              <ChevronLeft className="h-3 w-3" />{" "}
              {t("peripheralActivityLog.prev")}
            </button>
            <button
              type="button"
              onClick={handleNext}
              disabled={!hasNext}
              className="inline-flex h-8 items-center gap-1 rounded-md border px-3 text-xs font-medium hover:bg-muted disabled:opacity-50"
            >
              {t("common:actions.next")} <ChevronRight className="h-3 w-3" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
