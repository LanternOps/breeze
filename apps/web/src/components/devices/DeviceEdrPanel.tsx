import { useCallback, useEffect, useState } from "react";
import { Loader2, ShieldAlert, Activity } from "lucide-react";
import { formatDateTime as formatUserDateTime } from "@/lib/dateTimeFormat";
import { navigateTo } from "@/lib/navigation";
import { friendlyFetchError } from "../../lib/utils";
import {
  fetchS1Threats,
  fetchHuntressIncidents,
  isolateDevice,
  runS1ThreatAction,
  type S1Threat,
  type HuntressIncident,
  type S1ThreatActionType,
} from "../../lib/edr";
import {
  promoteToIncident,
  s1ThreatToIncident,
  huntressIncidentToIncident,
} from "../../lib/incidents";
import { handleActionError } from "../../lib/runAction";
import { useTranslation } from "react-i18next";
import "../../lib/i18n";

const severityBadge: Record<string, string> = {
  low: "bg-blue-500/20 text-blue-700 border-blue-500/30",
  medium: "bg-yellow-500/20 text-yellow-800 border-yellow-500/40",
  high: "bg-orange-500/20 text-orange-700 border-orange-500/40",
  critical: "bg-red-500/20 text-red-700 border-red-500/40",
};

function sevClass(sev: string | null): string {
  return (
    severityBadge[(sev ?? "").toLowerCase()] ??
    "bg-muted text-muted-foreground border-border"
  );
}

function fmt(value: string | null, timezone?: string): string {
  if (!value) return "-";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? "-"
    : formatUserDateTime(d, timezone ? { timeZone: timezone } : undefined);
}

type Props = { deviceId: string; orgId: string; timezone?: string };

export default function DeviceEdrPanel({ deviceId, orgId, timezone }: Props) {
  const { t } = useTranslation("devices");
  const [threats, setThreats] = useState<S1Threat[]>([]);
  const [incidents, setIncidents] = useState<HuntressIncident[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [confirmAction, setConfirmAction] = useState<
    null | "isolate" | "unisolate"
  >(null);
  const [isolating, setIsolating] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);
  const [promotingId, setPromotingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [s1, hi] = await Promise.all([
        fetchS1Threats({ orgId, deviceId, limit: 50 }),
        fetchHuntressIncidents({ orgId, deviceId, limit: 50 }),
      ]);
      setThreats(s1.rows);
      setIncidents(hi.rows);
    } catch (err) {
      setError(friendlyFetchError(err));
    } finally {
      setLoading(false);
    }
  }, [orgId, deviceId]);

  const doIsolate = async (isolate: boolean) => {
    setIsolating(true);
    try {
      await isolateDevice(orgId, deviceId, isolate);
      await load();
    } catch (err) {
      handleActionError(
        err,
        isolate
          ? t("deviceEdrPanel.failedToIsolateDevice")
          : t("deviceEdrPanel.failedToRemoveIsolation"),
      );
    } finally {
      setIsolating(false);
      setConfirmAction(null);
    }
  };

  const doThreatAction = async (
    threatId: string,
    action: S1ThreatActionType,
  ) => {
    setActingId(threatId);
    try {
      await runS1ThreatAction(orgId, threatId, action);
      await load();
    } catch (err) {
      handleActionError(err, `Failed to ${action} threat`);
    } finally {
      setActingId(null);
    }
  };

  const promote = async (
    key: string,
    input: import("../../lib/incidents").CreateIncidentInput,
  ) => {
    setPromotingId(key);
    try {
      const { id } = await promoteToIncident(input);
      navigateTo(`/incidents/${id}`);
    } catch (err) {
      handleActionError(err, "Failed to create incident");
    } finally {
      setPromotingId(null);
    }
  };

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div
      className="rounded-lg border bg-card p-6 shadow-xs"
      data-testid="device-edr-panel"
    >
      <div className="mb-4 flex items-center gap-2">
        <ShieldAlert className="h-4 w-4 text-primary" />
        <h3 className="text-lg font-semibold">
          {t("deviceEdrPanel.endpointProtectionEdr")}
        </h3>
        <button
          type="button"
          data-testid="edr-isolate-btn"
          onClick={() => setConfirmAction("isolate")}
          className="ml-auto inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
        >
          {t("deviceEdrPanel.isolateDevice")}{" "}
        </button>
        <button
          type="button"
          data-testid="edr-unisolate-btn"
          onClick={() => setConfirmAction("unisolate")}
          className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
        >
          {t("deviceEdrPanel.removeIsolation")}{" "}
        </button>
      </div>

      {error && (
        <div
          className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          data-testid="edr-error"
        >
          {error}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* SentinelOne threats */}
        <div>
          <h4 className="mb-3 text-sm font-semibold">
            {t("deviceEdrPanel.sentineloneThreats")}
          </h4>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("deviceEdrPanel.loading")}
            </div>
          ) : threats.length === 0 ? (
            <p
              className="text-sm text-muted-foreground"
              data-testid="edr-s1-empty"
            >
              {t("deviceEdrPanel.noSentineloneThreatsForThisDevice")}
            </p>
          ) : (
            <div className="space-y-3">
              {threats.map((threat) => (
                <div
                  key={threat.id}
                  className="rounded-md border bg-background p-3"
                  data-testid="edr-s1-row"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium">
                      {threat.threatName ?? t("deviceEdrPanel.unknownThreat")}
                    </p>
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${sevClass(threat.severity)}`}
                      >
                        {threat.severity ?? t("deviceEdrPanel.unknown")}
                      </span>
                      <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold bg-muted text-muted-foreground border-border">
                        {threat.status}
                      </span>
                    </div>
                  </div>
                  {threat.filePath && (
                    <p
                      className="mt-1 text-xs text-muted-foreground"
                      title={threat.filePath}
                    >
                      {threat.filePath}
                    </p>
                  )}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("deviceEdrPanel.detected")}{" "}
                    {fmt(threat.detectedAt, timezone)}
                  </p>
                  {threat.status === "active" && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {(["kill", "quarantine", "rollback"] as const).map(
                        (action) => (
                          <button
                            key={action}
                            type="button"
                            data-testid={`edr-threat-${action}-${threat.id}`}
                            onClick={() => doThreatAction(threat.id, action)}
                            disabled={actingId === threat.id}
                            className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium capitalize hover:bg-muted disabled:opacity-60"
                          >
                            {actingId === threat.id && (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            )}
                            {action}
                          </button>
                        ),
                      )}
                    </div>
                  )}
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      data-testid={`edr-s1-promote-${threat.id}`}
                      onClick={() =>
                        promote(threat.id, s1ThreatToIncident(threat))
                      }
                      disabled={promotingId === threat.id}
                      className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-60"
                    >
                      {promotingId === threat.id && (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      )}
                      {t("deviceEdrPanel.promoteToIncident")}{" "}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Huntress incidents (read-only this pillar) */}
        <div>
          <h4 className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <Activity className="h-4 w-4" />
            {t("deviceEdrPanel.huntressIncidents")}
          </h4>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("deviceEdrPanel.loading")}
            </div>
          ) : incidents.length === 0 ? (
            <p
              className="text-sm text-muted-foreground"
              data-testid="edr-huntress-empty"
            >
              {t("deviceEdrPanel.noHuntressIncidentsForThisDevice")}
            </p>
          ) : (
            <div className="space-y-3">
              {incidents.map((i) => (
                <div
                  key={i.id}
                  className="rounded-md border bg-background p-3"
                  data-testid="edr-huntress-row"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium">{i.title}</p>
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${sevClass(i.severity)}`}
                      >
                        {i.severity ?? "unknown"}
                      </span>
                      <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold bg-muted text-muted-foreground border-border">
                        {i.status}
                      </span>
                    </div>
                  </div>
                  {i.recommendation && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {i.recommendation}
                    </p>
                  )}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("deviceEdrPanel.reported")} {fmt(i.reportedAt, timezone)}
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      data-testid={`edr-huntress-promote-${i.id}`}
                      onClick={() =>
                        promote(i.id, huntressIncidentToIncident(i))
                      }
                      disabled={promotingId === i.id}
                      className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:opacity-60"
                    >
                      {promotingId === i.id && (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      )}
                      {t("deviceEdrPanel.promoteToIncident")}{" "}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {confirmAction !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="edr-isolate-dialog-title"
        >
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-lg">
            <h4
              id="edr-isolate-dialog-title"
              className="text-base font-semibold"
            >
              {confirmAction === "isolate"
                ? t("deviceEdrPanel.isolateThisDevice")
                : t("deviceEdrPanel.removeIsolation2")}
            </h4>
            <p className="mt-2 text-sm text-muted-foreground">
              {confirmAction === "isolate"
                ? t("deviceEdrPanel.sentineloneWillCutTheDeviceOff")
                : t("deviceEdrPanel.sentineloneWillRestoreThisDeviceS")}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmAction(null)}
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
              >
                {t("deviceEdrPanel.cancel")}
              </button>
              <button
                type="button"
                data-testid={`edr-${confirmAction}-confirm`}
                onClick={() => doIsolate(confirmAction === "isolate")}
                disabled={isolating}
                className="inline-flex items-center gap-2 rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground hover:opacity-90 disabled:opacity-60"
              >
                {isolating && <Loader2 className="h-4 w-4 animate-spin" />}
                {confirmAction === "isolate"
                  ? t("deviceEdrPanel.isolate")
                  : t("deviceEdrPanel.removeIsolation")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
