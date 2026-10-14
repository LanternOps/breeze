import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { fetchWithAuth } from "../../stores/auth";
import { fetchEdrEndpoints, linkEdrEndpoint, type EdrEndpoint } from "@/lib/edrProviders";
import { formatRelativeTime } from "@/lib/dateTimeFormat";
import { handleActionError } from "@/lib/runAction";
import "@/lib/i18n";

type EndpointFilter = "unlinked" | "ambiguous";
type DeviceOption = { id: string; label: string };
type OrgDevices = DeviceOption[];

export default function EdrUnlinkedEndpoints({
  connectionId,
  canManage,
}: {
  connectionId: string;
  canManage: boolean;
}) {
  const { t } = useTranslation("integrations");
  const [filter, setFilter] = useState<EndpointFilter>("unlinked");
  const [rows, setRows] = useState<EdrEndpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [devicesByOrg, setDevicesByOrg] = useState<Record<string, OrgDevices>>({});
  const [truncatedOrgs, setTruncatedOrgs] = useState<Record<string, boolean>>({});
  const [failedOrgs, setFailedOrgs] = useState<Record<string, boolean>>({});
  // Orgs whose device fetch is in flight, so the effect never double-fetches.
  const inflight = useRef(new Set<string>());
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      setRows(await fetchEdrEndpoints({ connectionId, state: filter }));
    } catch (err) {
      console.error("[EdrUnlinkedEndpoints] load:", err);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [connectionId, filter]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  // Devices are fetched once per distinct org the visible endpoints belong to
  // (an endpoint can only be linked to a device of its own org). A failed fetch
  // is NOT cached as a device list, so it can be retried.
  const loadDevices = useCallback(async (orgId: string) => {
    if (inflight.current.has(orgId)) return;
    inflight.current.add(orgId);
    setFailedOrgs((f) => (f[orgId] ? { ...f, [orgId]: false } : f));
    try {
      const res = await fetchWithAuth(`/devices?orgId=${orgId}&limit=200`);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const body = await res.json();
      const data = Array.isArray(body?.data) ? body.data : [];
      const total = typeof body?.pagination?.total === "number" ? body.pagination.total : undefined;
      const more = Boolean(body?.pagination?.nextCursor) || (total !== undefined && total > data.length);
      setDevicesByOrg((prev) => ({
        ...prev,
        [orgId]: data.map((d: { id: string; hostname?: string | null; displayName?: string | null }) => ({
          id: d.id,
          label: d.displayName || d.hostname || d.id,
        })),
      }));
      setTruncatedOrgs((prev) => ({ ...prev, [orgId]: more }));
    } catch (err) {
      console.error("[EdrUnlinkedEndpoints] devices:", err);
      setFailedOrgs((f) => ({ ...f, [orgId]: true }));
    } finally {
      inflight.current.delete(orgId);
    }
  }, []);

  useEffect(() => {
    if (!canManage) return;
    for (const orgId of new Set(rows.map((r) => r.orgId))) {
      if (!(orgId in devicesByOrg) && !failedOrgs[orgId]) void loadDevices(orgId);
    }
  }, [rows, canManage, devicesByOrg, failedOrgs, loadDevices]);

  const handleLink = async (endpointId: string) => {
    const deviceId = picked[endpointId];
    if (!deviceId) return;
    setSaving((s) => ({ ...s, [endpointId]: true }));
    try {
      await linkEdrEndpoint(endpointId, deviceId, {
        errorFallback: t("edrProviders.errorLink"),
        successMessage: t("edrProviders.linkedToast"),
      });
      await load();
    } catch (err) {
      handleActionError(err, t("edrProviders.errorLink"));
    } finally {
      setSaving((s) => ({ ...s, [endpointId]: false }));
    }
  };

  return (
    <div data-testid={`edr-endpoints-${connectionId}`} className="mt-6 rounded-lg border bg-card p-5 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-foreground">{t("edrProviders.endpointsTitle")}</h4>
          <p className="mt-1 text-sm text-muted-foreground">{t("edrProviders.endpointsHelp")}</p>
        </div>
        <select
          data-testid="edr-endpoints-state"
          aria-label={t("edrProviders.endpointsFilter")}
          value={filter}
          onChange={(e) => setFilter(e.target.value as EndpointFilter)}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          <option value="unlinked">{t("edrProviders.filterUnlinked")}</option>
          <option value="ambiguous">{t("edrProviders.filterAmbiguous")}</option>
        </select>
      </div>

      {loading ? (
        <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> {t("common:states.loading")}
        </div>
      ) : loadError ? (
        <div data-testid="edr-endpoints-error" className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {t("edrProviders.errorLoadEndpoints")}
        </div>
      ) : rows.length === 0 ? (
        <p data-testid="edr-endpoints-empty" className="mt-4 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          {t("edrProviders.endpointsEmpty")}
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="border-b text-left text-xs font-semibold uppercase text-muted-foreground">
                <th className="pb-2 pr-4">{t("edrProviders.hostname")}</th>
                <th className="pb-2 pr-4">{t("edrProviders.vendorTenant")}</th>
                <th className="pb-2 pr-4">{t("edrProviders.os")}</th>
                <th className="pb-2 pr-4">{t("edrProviders.lastSeen")}</th>
                <th className="pb-2 pr-4">{t("edrProviders.health")}</th>
                {canManage && <th className="pb-2">{t("edrProviders.device")}</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const devices = devicesByOrg[row.orgId];
                const devicesFailed = !!failedOrgs[row.orgId];
                return (
                  <tr key={row.id} data-testid={`edr-endpoint-row-${row.id}`} className="border-b align-top last:border-0">
                    <td className="py-3 pr-4 font-medium">{row.hostname ?? row.vendorEndpointId}</td>
                    <td className="py-3 pr-4 text-muted-foreground">{row.tenantName ?? "--"}</td>
                    <td className="py-3 pr-4 text-muted-foreground">{row.osName ?? "--"}</td>
                    <td className="py-3 pr-4 text-muted-foreground">
                      {row.lastSeenAt ? formatRelativeTime(row.lastSeenAt) : t("edrProviders.never")}
                    </td>
                    <td className="py-3 pr-4 text-muted-foreground">{t(/* i18n-dynamic */ `edrProviders.healthValue.${row.health}`)}</td>
                    {canManage && (
                      <td className="py-3">
                        <div className="flex items-center gap-2">
                          <select
                            data-testid={`edr-endpoint-device-${row.id}`}
                            aria-label={t("edrProviders.device")}
                            value={picked[row.id] ?? ""}
                            onChange={(e) => setPicked((p) => ({ ...p, [row.id]: e.target.value }))}
                            disabled={saving[row.id] || devices === undefined}
                            className="h-9 w-full max-w-xs rounded-md border bg-background px-2 text-sm disabled:opacity-50"
                          >
                            <option value="">
                              {devices !== undefined
                                ? t("edrProviders.selectDevice")
                                : devicesFailed
                                  ? t("edrProviders.errorLoadDevices")
                                  : t("common:states.loading")}
                            </option>
                            {(devices ?? []).map((d) => (
                              <option key={d.id} value={d.id}>
                                {d.label}
                              </option>
                            ))}
                          </select>
                          {devicesFailed && devices === undefined && (
                            <button
                              type="button"
                              data-testid={`edr-endpoint-devices-retry-${row.id}`}
                              onClick={() => void loadDevices(row.orgId)}
                              className="rounded-md border px-3 py-1.5 text-xs font-medium"
                            >
                              {t("common:actions.retry")}
                            </button>
                          )}
                          <button
                            type="button"
                            data-testid={`edr-endpoint-link-${row.id}`}
                            disabled={saving[row.id] || !picked[row.id]}
                            onClick={() => void handleLink(row.id)}
                            className="rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
                          >
                            {t("edrProviders.link")}
                          </button>
                        </div>
                        {truncatedOrgs[row.orgId] && (
                          <p data-testid="edr-endpoint-devices-truncated" className="mt-1 text-xs text-muted-foreground">
                            {t("edrProviders.devicesTruncated")}
                          </p>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
