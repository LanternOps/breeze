import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ComponentType } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  Shield,
  ShieldCheck,
  ShieldOff,
  Trash2,
} from "lucide-react";
import { fetchWithAuth } from "@/stores/auth";
import { formatDateTime as formatUserDateTime } from "@/lib/dateTimeFormat";
import { friendlyFetchError } from "@/lib/utils";
import { errorKindOf, HttpError, throwIfNotOk, type LoadErrorKind } from "@/lib/httpError";
import { runAction, ActionError } from "@/lib/runAction";
import type { YaraThreatRuleView } from "@breeze/shared";
import { showToast } from "../shared/Toast";
import AccessDenied from "../shared/AccessDenied";
import ThreatRulePanel from "./ThreatRulePanel";
import { getThreatDetails } from "./detectionRules/ruleSetsApi";
type ThreatSeverity = "low" | "medium" | "high" | "critical";
type ThreatStatus = "active" | "quarantined" | "removed";
type ThreatDetailData = {
  id: string;
  deviceId: string;
  deviceName: string;
  name: string;
  category: string;
  severity: ThreatSeverity;
  status: ThreatStatus;
  detectedAt: string;
  filePath: string;
  providerId?: string;
  provider?: { id?: string; name?: string } | null;
  removedAt?: string | null;
};
type TimelineEvent = {
  id: string;
  title: string;
  description: string;
  // Null when the API has no record of when it happened; never invent one.
  timestamp: string | null;
  icon: ComponentType<{
    className?: string;
  }>;
};
const severityBadge: Record<ThreatSeverity, string> = {
  low: "bg-blue-500/20 text-blue-700 border-blue-500/30",
  medium: "bg-yellow-500/20 text-yellow-800 border-yellow-500/40",
  high: "bg-orange-500/20 text-orange-700 border-orange-500/40",
  critical: "bg-red-500/20 text-red-700 border-red-500/40",
};
interface ThreatDetailProps {
  threatId?: string;
  timezone?: string;
}
export default function ThreatDetail({
  threatId,
  timezone,
}: ThreatDetailProps) {
  const { t } = useTranslation("security");
  const [threat, setThreat] = useState<ThreatDetailData | null>(null);
  // null = the related-threats read failed (shown as an error, not as "none").
  const [relatedThreats, setRelatedThreats] = useState<ThreatDetailData[] | null>([]);
  const [rule, setRule] = useState<YaraThreatRuleView | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string>();
  const [errorKind, setErrorKind] = useState<LoadErrorKind>("none");
  const fetchThreat = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    setErrorKind("none");
    setNotFound(false);
    // Never show the previous threat (or its rule) under a new load's error.
    setThreat(null);
    setRule(null);
    if (!threatId) {
      setThreat(null);
      setRule(null);
      setRelatedThreats([]);
      setLoading(false);
      return;
    }
    // The selected threat comes from its own /details read (#6267 W04-5), so
    // it no longer has to be among the first 100 list items; the list only
    // feeds "related threats" and is read in parallel.
    const relatedPromise = fetchWithAuth("/security/threats?limit=100")
      .then(async (res) => {
        throwIfNotOk(res);
        const payload = await res.json();
        return Array.isArray(payload.data) ? (payload.data as ThreatDetailData[]) : null;
      })
      .catch((err: unknown) => {
        console.error("[ThreatDetail] related threats:", err);
        return null;
      });
    try {
      const details = await getThreatDetails(threatId);
      const selected = details.threat as unknown as ThreatDetailData;
      setThreat(selected);
      setRule(details.rule ?? null);
      const list = await relatedPromise;
      // A failed related read is surfaced, never shown as "no related threats".
      setRelatedThreats(
        list === null
          ? null
          : list
              .filter((item) => item.id !== selected.id && item.deviceId === selected.deviceId)
              .slice(0, 5),
      );
    } catch (err) {
      // HttpError keeps the status, so a 403 renders AccessDenied and a 404
      // is "not found" — never another threat picked from the list (#2472).
      if (err instanceof HttpError && err.status === 404) {
        setThreat(null);
        setRule(null);
        setNotFound(true);
        return;
      }
      const kind = errorKindOf(err);
      setErrorKind(kind);
      // 'denied' renders AccessDenied, which supplies its own copy.
      if (kind === "other") setError(friendlyFetchError(err));
    } finally {
      setLoading(false);
    }
  }, [threatId]);
  useEffect(() => {
    fetchThreat();
  }, [fetchThreat]);
  const threatActionSuccessMessage: Record<"quarantine" | "restore" | "remove", string> = {
    quarantine: t("securityThreatDetail.quarantineQueued"),
    restore: t("securityThreatDetail.restoreQueued"),
    remove: t("securityThreatDetail.removeQueued"),
  };
  const performThreatAction = async (action: "quarantine" | "restore" | "remove") => {
    if (!threat) return;
    setActing(true);
    setError(undefined);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/security/threats/${threat.id}/${action}`, { method: "POST" }),
        errorFallback: t("securityThreatDetail.actionFailed"),
        successMessage: threatActionSuccessMessage[action],
      });
      await fetchThreat();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // let the auth redirect handle it
      if (!(err instanceof ActionError)) showToast({ message: String(err), type: "error" });
    } finally {
      setActing(false);
    }
  };
  const timeline = useMemo<TimelineEvent[]>(() => {
    if (!threat) return [];
    const events: TimelineEvent[] = [
      {
        id: `${threat.id}-detected`,
        title: t("securityThreatDetail.threatDetected"),
        description: `${threat.name} was detected on ${threat.deviceName}.`,
        timestamp: threat.detectedAt,
        icon: AlertTriangle,
      },
    ];
    // Only events with a real record. The API does not stamp quarantine time
    // (quarantine leaves resolved_at null), so that entry shows the reported
    // state without a timestamp; removal is stamped by `removedAt`.
    if (threat.status === "quarantined") {
      events.push({
        id: `${threat.id}-quarantined`,
        title: t("securityThreatDetail.threatQuarantined"),
        description: t(
          "securityThreatDetail.threatWasMovedToQuarantineByPolicy",
        ),
        timestamp: null,
        icon: ShieldOff,
      });
    }
    if (threat.status === "removed") {
      events.push({
        id: `${threat.id}-removed`,
        title: t("securityThreatDetail.threatRemoved"),
        description: t(
          "securityThreatDetail.threatFileWasRemovedFromEndpointStorage",
        ),
        timestamp: threat.removedAt ?? null,
        icon: ShieldCheck,
      });
    }
    return events;
  }, [threat]);
  const formatDateTime = (value: string): string => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return formatUserDateTime(date, { timeZone: timezone });
  };
  if (loading) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("securityThreatDetail.loadingThreatDetails")}
        </div>
      </div>
    );
  }
  // A 403 is terminal for this user — a retry hits the same permission gate. Stop
  // before the detail panels: falling through would paint the "no threat
  // selected" empty state and tell someone who may not see the data that
  // nothing was found. Fabricated emptiness is worse than an error. (#2472)
  if (errorKind === "denied") {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <AccessDenied testId="security-threat-detail-denied" />
      </div>
    );
  }
  if (!threat) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-xs">
        {notFound ? (
          <p data-testid="security-threat-detail-not-found" className="text-sm text-muted-foreground">
            {t("securityThreatDetail.notFound")}
          </p>
        ) : error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("securityThreatDetail.noThreatSelected")}
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">
          {t("securityThreatDetail.threatDetail")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("securityThreatDetail.investigateContainAndResolveThisDetection")}
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <div className="rounded-lg border bg-card p-6 shadow-xs">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">{threat.name}</h2>
                <p className="text-sm capitalize text-muted-foreground">
                  {threat.category}
                </p>
              </div>
              <span
                className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${severityBadge[threat.severity]}`}
              >
                {t(/* i18n-dynamic */ `securityThreatList.${threat.severity}`)}
              </span>
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <p className="text-xs uppercase text-muted-foreground">
                  {t("securityThreatDetail.filePath")}
                </p>
                <p className="text-sm font-medium">{threat.filePath || "-"}</p>
              </div>
              <div>
                <p className="text-xs uppercase text-muted-foreground">
                  {t("securityThreatDetail.provider")}
                </p>
                <p className="text-sm font-medium">
                  {threat.provider?.name ??
                    threat.providerId ??
                    t("securityThreatDetail.providerUnknown")}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase text-muted-foreground">
                  {t("securityThreatDetail.detected")}
                </p>
                <p className="text-sm font-medium">
                  {formatDateTime(threat.detectedAt)}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase text-muted-foreground">
                  {t("securityThreatDetail.status")}
                </p>
                <p className="text-sm font-medium">
                  {t(/* i18n-dynamic */ `securityThreatList.${threat.status}`)}
                </p>
              </div>
              <div className="sm:col-span-2">
                <p className="text-xs uppercase text-muted-foreground">
                  {t("securityThreatDetail.threatID")}
                </p>
                <p className="text-sm font-medium">{threat.id}</p>
              </div>
            </div>
            <div className="mt-6 flex flex-wrap gap-3">
              <button
                type="button"
                disabled={acting}
                onClick={() => performThreatAction("quarantine")}
                className="inline-flex items-center gap-2 rounded-md border bg-background px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-60"
              >
                {acting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Shield className="h-4 w-4" />
                )}
                {t("securityThreatDetail.quarantine")}
              </button>
              <button
                type="button"
                disabled={acting}
                onClick={() => performThreatAction("restore")}
                className="inline-flex items-center gap-2 rounded-md border bg-background px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-60"
              >
                <CheckCircle2 className="h-4 w-4" />
                {t("securityThreatDetail.restore")}
              </button>
              <button
                type="button"
                disabled={acting}
                onClick={() => performThreatAction("remove")}
                className="inline-flex items-center gap-2 rounded-md border bg-background px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-60"
              >
                <Trash2 className="h-4 w-4" />
                {t("securityThreatDetail.remove")}
              </button>
            </div>
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-xs">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">
                {t("securityThreatDetail.timeline")}
              </h2>
              <Clock className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="mt-4 space-y-4">
              {timeline.map((event) => (
                <div
                  key={event.id}
                  className="flex items-start gap-4 rounded-md border bg-muted/30 px-4 py-3"
                >
                  <div className="rounded-full border bg-background p-2">
                    <event.icon className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">{event.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {event.description}
                    </p>
                    {event.timestamp && (
                      <p className="text-xs text-muted-foreground">
                        {formatDateTime(event.timestamp)}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-lg border bg-card p-6 shadow-xs">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">
                {t("securityThreatDetail.deviceInfo")}
              </h2>
              <ShieldCheck className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="mt-4 space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">
                  {t("securityThreatDetail.device")}
                </span>
                <span className="font-medium">{threat.deviceName}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">
                  {t("securityThreatDetail.threatStatus")}
                </span>
                <span className="font-medium">{t(/* i18n-dynamic */ `securityThreatList.${threat.status}`)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">
                  {t("securityThreatDetail.severity")}
                </span>
                <span className="font-medium">
                  {t(/* i18n-dynamic */ `securityThreatList.${threat.severity}`)}
                </span>
              </div>
            </div>
          </div>

          {rule && <ThreatRulePanel rule={rule} />}

          <div className="rounded-lg border bg-card p-6 shadow-xs">
            <h2 className="text-lg font-semibold">
              {t("securityThreatDetail.relatedThreats")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t("securityThreatDetail.otherDetectionsOnThisDevice")}
            </p>
            <div className="mt-4 space-y-3">
              {relatedThreats === null ? (
                <p data-testid="security-threat-related-error" role="alert" className="text-sm text-destructive">
                  {t("securityThreatDetail.relatedLoadFailed")}
                </p>
              ) : relatedThreats.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("securityThreatDetail.noRelatedThreats")}
                </p>
              ) : (
                relatedThreats.map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between rounded-md border bg-muted/30 px-4 py-3"
                  >
                    <div>
                      <p className="text-sm font-medium">{item.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatDateTime(item.detectedAt)}
                      </p>
                    </div>
                    <span
                      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${severityBadge[item.severity]}`}
                    >
                      {item.severity}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
