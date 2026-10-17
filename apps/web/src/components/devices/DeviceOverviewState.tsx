import { useEffect, useState, type MouseEvent } from "react";
import { AlertTriangle, Clock, Ticket } from "lucide-react";
import { useTranslation } from "react-i18next";
import "../../lib/i18n";
import { fetchWithAuth } from "../../stores/auth";
import { asList } from "@/lib/asList";
import { formatTimeAgo } from "@/lib/formatTime";
import type { DeviceStatus } from "./DeviceList";

type OpenAlert = { id: string; title: string; severity: string };

const severityStyles: Record<string, string> = {
  critical: "bg-destructive/15 text-destructive border-destructive/30",
  high: "bg-warning/15 text-warning-strong border-warning/30",
  medium: "bg-warning/10 text-warning-strong border-warning/20",
  low: "bg-info/15 text-info border-info/30",
  info: "bg-muted text-muted-foreground border-border",
};

const OPEN_ALERT_PREVIEW = 3;

type Props = {
  deviceId: string;
  status: DeviceStatus;
  lastSeen: string;
  /** Open-alert / open-ticket counts from GET /devices/:id/tab-counts. */
  alertCount?: number;
  ticketCount?: number;
  onOpenTab: (tab: "alerts" | "tickets") => void;
};

/**
 * First Overview block (#9029): what state the device is in and what is open
 * against it, so triage starts at the top instead of in the right rail.
 */
export default function DeviceOverviewState({
  deviceId,
  status,
  lastSeen,
  alertCount,
  ticketCount,
  onOpenTab,
}: Props) {
  const { t } = useTranslation("devices");
  const [alerts, setAlerts] = useState<OpenAlert[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setAlerts(null);
    setLoadFailed(false);
    fetchWithAuth(`/devices/${deviceId}/alerts?status=active&limit=${OPEN_ALERT_PREVIEW}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw: any[] = asList(await res.json(), "data");
        return raw
          .filter((a) => typeof a?.id === "string")
          .map((a) => ({
            id: a.id as string,
            title: a.title || a.message || a.summary || t("deviceOverviewState.untitledAlert"),
            severity: String(a.severity || a.level || "info").toLowerCase(),
          }));
      })
      .then((list) => {
        if (!cancelled) setAlerts(list.slice(0, OPEN_ALERT_PREVIEW));
      })
      .catch((err) => {
        // Never fall through to "No open alerts" on a failed read: on a triage
        // card a false all-clear is the worst wrong answer.
        console.error(`[DeviceOverviewState] open alerts for ${deviceId} failed`, err);
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [deviceId]);

  const lastSeenValid = lastSeen !== "" && !Number.isNaN(new Date(lastSeen).getTime());
  const stateLine = !lastSeenValid
    ? null
    : status === "offline"
      ? t("deviceDetails.offlineLastSeen", { ago: formatTimeAgo(lastSeen) })
      : t("deviceOverviewState.lastCheckIn", { ago: formatTimeAgo(lastSeen) });

  // The tab-counts number is authoritative; the preview is capped at three, so
  // without a count we link to the tab instead of printing a number that
  // would undercount.
  const openAlerts = alertCount ?? 0;
  const previewHasAlerts = alerts !== null && alerts.length > 0;
  const noAlertsKnown =
    alertCount === 0 || (alertCount === undefined && alerts !== null && alerts.length === 0);
  const openTickets = ticketCount ?? 0;
  const goTo = (tab: "alerts" | "tickets") => (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onOpenTab(tab);
  };
  const linkClass =
    "inline-flex items-center gap-1.5 font-medium text-foreground underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground";

  return (
    <section
      data-testid="device-overview-state"
      aria-label={t("deviceOverviewState.label")}
      className="rounded-lg border bg-card px-5 py-4"
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        {stateLine && (
          <span
            className={`inline-flex items-center gap-1.5 ${
              status === "offline" ? "font-medium text-destructive" : "text-muted-foreground"
            }`}
          >
            <Clock className="h-4 w-4" aria-hidden="true" />
            {stateLine}
          </span>
        )}
        {openAlerts > 0 ? (
          <a
            href="#alerts"
            data-testid="device-overview-open-alerts"
            onClick={goTo("alerts")}
            className={linkClass}
          >
            <AlertTriangle className="h-4 w-4 text-warning-strong" aria-hidden="true" />
            {t("deviceOverviewState.openAlerts", { count: openAlerts })}
          </a>
        ) : previewHasAlerts || (loadFailed && alertCount === undefined) ? (
          <a
            href="#alerts"
            data-testid="device-overview-open-alerts"
            onClick={goTo("alerts")}
            className={linkClass}
          >
            <AlertTriangle className="h-4 w-4 text-warning-strong" aria-hidden="true" />
            {loadFailed ? t("deviceOverviewState.alertsUnavailable") : t("deviceOverviewState.viewAlerts")}
          </a>
        ) : (
          noAlertsKnown && (
            <span className="text-muted-foreground">{t("deviceOverviewState.noOpenAlerts")}</span>
          )
        )}
        {openTickets > 0 && (
          <a
            href="#tickets"
            data-testid="device-overview-open-tickets"
            onClick={goTo("tickets")}
            className={linkClass}
          >
            <Ticket className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            {t("deviceOverviewState.openTickets", { count: openTickets })}
          </a>
        )}
      </div>
      {alerts && alerts.length > 0 && (
        <ul className="mt-3 divide-y border-t">
          {alerts.map((alert) => (
            <li
              key={alert.id}
              data-testid={`device-overview-alert-${alert.id}`}
              className="flex items-center justify-between gap-3 py-2"
            >
              <a href={`/alerts/${alert.id}`} className="min-w-0 truncate text-sm hover:underline">
                {alert.title}
              </a>
              <span
                className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-medium capitalize ${
                  severityStyles[alert.severity] ?? severityStyles.info
                }`}
              >
                {alert.severity}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
