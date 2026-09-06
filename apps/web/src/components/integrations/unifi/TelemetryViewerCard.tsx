// Live per-device PoE health + connected clients viewer (cloud). Split out of
// UnifiIntegration.tsx (#2382) — verbatim move, no behavior change.

import { AlertTriangle, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { formatNumber } from "@/lib/i18n/format";
import type { SiteGroup, TelemetryClient, TelemetryDevice } from "./unifiTypes";

interface TelemetryViewerCardProps {
  telemetrySite: string;
  sitesByOrg: SiteGroup[];
  telemetryLoading: boolean;
  telemetryError: string | null;
  telemetry: { devices: TelemetryDevice[]; clients: TelemetryClient[] } | null;
  onLoadTelemetry: (siteId: string) => void;
}

export default function TelemetryViewerCard({
  telemetrySite,
  sitesByOrg,
  telemetryLoading,
  telemetryError,
  telemetry,
  onLoadTelemetry,
}: TelemetryViewerCardProps) {
  const { t } = useTranslation("integrations");
  return (
    <div
      className="rounded-xl border bg-card p-5 shadow-xs"
      data-testid="unifi-telemetry-card"
    >
      <h2 className="text-lg font-semibold">
        {t("unifiIntegration.deepTelemetry")}
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        {t("unifiIntegration.livePerDevicePoEHealthAndConnectedClients")}
      </p>
      <label className="block max-w-xs text-sm">
        <span className="text-muted-foreground">
          {t("common:labels.site")}
        </span>
        <select
          value={telemetrySite}
          onChange={(e) => void onLoadTelemetry(e.target.value)}
          className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
          data-testid="unifi-telemetry-site"
        >
          <option value="">{t("unifiIntegration.selectSite")}</option>
          {sitesByOrg.map((group) => (
            <optgroup key={group.id} label={group.name}>
              {group.sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      {telemetryLoading ? (
        <div
          className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"
          data-testid="unifi-telemetry-loading"
        >
          <Loader2 className="h-4 w-4 animate-spin" />{" "}
          {t("unifiIntegration.loadingTelemetry")}
        </div>
      ) : telemetryError ? (
        <div
          className="mt-4 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          data-testid="unifi-telemetry-error"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" /> {telemetryError}
        </div>
      ) : telemetry ? (
        <div className="mt-4 space-y-6">
          <div>
            <h3 className="mb-2 text-sm font-semibold">
              {t("unifiIntegration.devices")}
              {telemetry.devices.length})
            </h3>
            {telemetry.devices.length === 0 ? (
              <p
                className="text-sm text-muted-foreground"
                data-testid="unifi-telemetry-devices-empty"
              >
                {t("unifiIntegration.noDeviceTelemetryYet")}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table
                  className="min-w-full divide-y text-sm"
                  data-testid="unifi-telemetry-devices"
                >
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="px-3 py-2 font-medium">
                        {t("common:labels.device")}
                      </th>
                      <th className="px-3 py-2 font-medium">MAC</th>
                      <th className="px-3 py-2 font-medium">
                        {t("unifiIntegration.clients")}
                      </th>
                      <th className="px-3 py-2 font-medium">
                        {t("unifiIntegration.poePorts")}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {telemetry.devices.map((d) => (
                      <tr
                        key={d.id}
                        className={d.isStale ? "text-muted-foreground" : ""}
                        data-testid="unifi-telemetry-device-row"
                      >
                        <td className="px-3 py-2 font-medium">
                          {d.name ?? d.unifiDeviceId}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {d.mac ?? "—"}
                        </td>
                        <td className="px-3 py-2 tabular-nums">
                          {d.numClients ?? "—"}
                        </td>
                        <td className="px-3 py-2">
                          {Array.isArray(d.poePorts) &&
                          d.poePorts.length > 0
                            ? `${d.poePorts.filter((p) => p.up).length}/${d.poePorts.length} up · ${formatNumber(
                                d.poePorts.reduce(
                                  (sum, p) => sum + (p.poe_power_w ?? 0),
                                  0,
                                ),
                                {
                                  minimumFractionDigits: 1,
                                  maximumFractionDigits: 1,
                                },
                              )}W`
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div>
            <h3 className="mb-2 text-sm font-semibold">
              {t("unifiIntegration.clients2")}
              {telemetry.clients.length})
            </h3>
            {telemetry.clients.length === 0 ? (
              <p
                className="text-sm text-muted-foreground"
                data-testid="unifi-telemetry-clients-empty"
              >
                {t("unifiIntegration.noClientsReported")}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table
                  className="min-w-full divide-y text-sm"
                  data-testid="unifi-telemetry-clients"
                >
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="px-3 py-2 font-medium">
                        {t("unifiIntegration.host")}
                      </th>
                      <th className="px-3 py-2 font-medium">IP</th>
                      <th className="px-3 py-2 font-medium">MAC</th>
                      <th className="px-3 py-2 font-medium">
                        {t("unifiIntegration.link")}
                      </th>
                      <th className="px-3 py-2 font-medium">
                        {t("unifiIntegration.signal")}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {telemetry.clients.map((cl) => (
                      <tr
                        key={cl.id}
                        className={
                          cl.isStale ? "text-muted-foreground" : ""
                        }
                        data-testid="unifi-telemetry-client-row"
                      >
                        <td className="px-3 py-2 font-medium">
                          {cl.hostname ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {cl.ipAddress ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {cl.mac}
                        </td>
                        <td className="px-3 py-2">
                          {cl.isWired
                            ? t("unifiIntegration.wired")
                            : cl.ssid
                              ? `Wi-Fi · ${cl.ssid}`
                              : "Wi-Fi"}
                        </td>
                        <td className="px-3 py-2 tabular-nums">
                          {cl.signalDbm != null
                            ? `${cl.signalDbm} dBm`
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
