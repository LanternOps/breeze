import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDateTime as formatUserDateTime } from "@/lib/dateTimeFormat";
import { errorKindOf } from "@/lib/httpError";
import {
  edrProviderLabel,
  fetchEdrDetections,
  fetchEdrEndpoints,
  type EdrCoverage,
  type EdrDetectionDto,
  type EdrEndpoint,
} from "@/lib/edrProviders";
import "@/lib/i18n";

// Same palette as DeviceEdrPanel (copied: importing it would be circular).
const severityBadge: Record<string, string> = {
  low: "bg-blue-500/20 text-blue-700 border-blue-500/30",
  medium: "bg-yellow-500/20 text-yellow-800 border-yellow-500/40",
  high: "bg-orange-500/20 text-orange-700 border-orange-500/40",
  critical: "bg-red-500/20 text-red-700 border-red-500/40",
};

function sevClass(sev: string | null): string {
  return severityBadge[(sev ?? "").toLowerCase()] ?? "bg-muted text-muted-foreground border-border";
}

function fmt(value: string | null, timezone?: string): string {
  if (!value) return "-";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? "-"
    : formatUserDateTime(d, timezone ? { timeZone: timezone } : undefined);
}

type Props = { deviceId: string; orgId: string; timezone?: string };

export default function DeviceEdrGenericSection({ deviceId, orgId, timezone }: Props) {
  const { t } = useTranslation("devices");
  const [loading, setLoading] = useState(true);
  const [endpoints, setEndpoints] = useState<EdrEndpoint[]>([]);
  const [detections, setDetections] = useState<EdrDetectionDto[]>([]);
  const [coverage, setCoverage] = useState<EdrCoverage | null>(null);
  const [failed, setFailed] = useState(false);
  const [allDenied, setAllDenied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.allSettled([
      fetchEdrEndpoints({ deviceId, state: "linked" }),
      fetchEdrDetections({ deviceId, orgId, status: "open", limit: 50 }),
    ]).then(([epRes, detRes]) => {
      if (cancelled) return;
      setEndpoints(epRes.status === "fulfilled" ? epRes.value : []);
      setDetections(detRes.status === "fulfilled" ? detRes.value.rows : []);
      setCoverage(detRes.status === "fulfilled" ? detRes.value.coverage : null);
      const errors = [epRes, detRes].flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
      setAllDenied(errors.length === 2 && errors.every((e) => errorKindOf(e) === "denied"));
      setFailed(errors.some((e) => errorKindOf(e) !== "denied"));
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [deviceId, orgId]);

  if (loading || allDenied) return null;
  if (!failed && endpoints.length === 0 && detections.length === 0) return null;

  const providerName = (key: string) => edrProviderLabel(key) ?? key;
  const endpointIds = new Set(endpoints.map((e) => e.id));
  const looseDetections = detections.filter((d) => !d.endpointId || !endpointIds.has(d.endpointId));

  const connectionsByProvider = new Map<string, Set<string>>();
  for (const e of endpoints) {
    const set = connectionsByProvider.get(e.provider) ?? new Set<string>();
    set.add(e.connectionId);
    connectionsByProvider.set(e.provider, set);
  }
  const duplicateProviders = [...connectionsByProvider.entries()]
    .filter(([, conns]) => conns.size > 1)
    .map(([provider]) => provider);

  const renderDetection = (d: EdrDetectionDto) => (
    <li
      key={d.id}
      data-testid={`device-edr-detection-${d.id}`}
      className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm"
    >
      <span
        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${sevClass(d.severity)}`}
      >
        {t(/* i18n-dynamic */ `deviceEdrGenericSection.severity.${d.severity}`)}
      </span>
      <span className="font-medium">{d.threatName ?? d.title ?? "-"}</span>
      <span className="text-xs text-muted-foreground">
        {t(/* i18n-dynamic */ `deviceEdrGenericSection.detectionStatus.${d.status}`)}
      </span>
      <span className="text-xs text-muted-foreground">{fmt(d.detectedAt, timezone)}</span>
      <span className="ml-auto text-xs text-muted-foreground">
        {d.providerLabel || providerName(d.provider)}
      </span>
    </li>
  );

  return (
    <div className="mt-6 border-t pt-4" data-testid="device-edr-generic-section">
      <h4 className="mb-3 text-sm font-semibold">{t("deviceEdrGenericSection.title")}</h4>

      {failed && (
        <p className="mb-3 text-xs text-muted-foreground" data-testid="device-edr-generic-error">
          {t("deviceEdrGenericSection.loadError")}
        </p>
      )}

      {duplicateProviders.map((provider) => (
        <div
          key={provider}
          data-testid={`device-edr-duplicate-${provider}`}
          className="mb-3 rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 text-sm text-yellow-800"
        >
          {t("deviceEdrGenericSection.duplicateNotice", { provider: providerName(provider) })}
        </div>
      ))}

      <div className="space-y-3">
        {endpoints.map((e) => {
          const own = detections.filter((d) => d.endpointId === e.id);
          return (
            <div key={e.id} data-testid={`device-edr-endpoint-${e.id}`} className="rounded-md border p-3">
              <div className="mb-2 flex flex-wrap items-baseline gap-2">
                <span className="text-sm font-semibold">{providerName(e.provider)}</span>
                {e.tenantName && <span className="text-xs text-muted-foreground">{e.tenantName}</span>}
              </div>
              <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                <div className="flex gap-2">
                  <dt className="text-muted-foreground">{t("deviceEdrGenericSection.fields.health")}</dt>
                  <dd>{t(/* i18n-dynamic */ `deviceEdrGenericSection.health.${e.health}`)}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-muted-foreground">{t("deviceEdrGenericSection.fields.status")}</dt>
                  <dd>
                    {e.online === null
                      ? t("deviceEdrGenericSection.online.unknown")
                      : e.online
                        ? t("deviceEdrGenericSection.online.online")
                        : t("deviceEdrGenericSection.online.offline")}
                  </dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-muted-foreground">{t("deviceEdrGenericSection.fields.isolation")}</dt>
                  <dd>{t(/* i18n-dynamic */ `deviceEdrGenericSection.isolation.${e.isolationState}`)}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-muted-foreground">{t("deviceEdrGenericSection.fields.agentVersion")}</dt>
                  <dd>{e.agentVersion ?? "-"}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-muted-foreground">{t("deviceEdrGenericSection.fields.lastSeen")}</dt>
                  <dd>{fmt(e.lastSeenAt, timezone)}</dd>
                </div>
              </dl>
              {own.length > 0 && <ul className="mt-3 space-y-2">{own.map(renderDetection)}</ul>}
            </div>
          );
        })}
      </div>

      {looseDetections.length > 0 && (
        <div className="mt-3">
          <h5 className="mb-2 text-xs font-semibold text-muted-foreground">
            {t("deviceEdrGenericSection.openDetections")}
          </h5>
          <ul className="space-y-2">{looseDetections.map(renderDetection)}</ul>
        </div>
      )}

      {coverage?.partial && (
        <div className="mt-3 text-xs text-muted-foreground" data-testid="device-edr-coverage">
          <p className="font-medium">{t("deviceEdrGenericSection.coverageHeading")}</p>
          {coverage.notes.map((note, i) => (
            <p key={i}>{note}</p>
          ))}
        </div>
      )}
    </div>
  );
}
