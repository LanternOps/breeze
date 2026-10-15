import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { fetchEdrTenants, mapEdrTenant, type EdrTenantList } from "@/lib/edrProviders";
import { formatDate, formatRelativeTime } from "@/lib/dateTimeFormat";
import { handleActionError } from "@/lib/runAction";
import "@/lib/i18n";

export type EdrMappingOrg = { id: string; name: string };

/**
 * `orgId: null` on the wire means two things to the API: a never-decided tenant
 * keeps mapping_source NULL so auto-mapping retries it, while an explicit unmap
 * sets `manual_unmapped`, which auto-mapping must never touch. The empty-string
 * placeholder therefore stays INERT.
 */
const UNMAPPED = "__unmapped__";

export default function EdrTenantMapping({
  connectionId,
  orgs,
  canManage,
  onChanged,
}: {
  connectionId: string;
  orgs: EdrMappingOrg[];
  canManage: boolean;
  onChanged: () => void;
}) {
  const { t } = useTranslation("integrations");
  const [data, setData] = useState<EdrTenantList | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      setData(await fetchEdrTenants(connectionId));
    } catch (err) {
      console.error("[EdrTenantMapping] load:", err);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const orgName = (id: string) => orgs.find((o) => o.id === id)?.name ?? id;

  const handleMap = async (tenantId: string, orgId: string | null) => {
    setSaving((s) => ({ ...s, [tenantId]: true }));
    try {
      await mapEdrTenant(tenantId, orgId, {
        errorFallback: t("edrProviders.errorMap"),
        successMessage: t("edrProviders.mappedToast"),
      });
      onChanged();
      await load();
    } catch (err) {
      handleActionError(err, t("edrProviders.errorMap"));
    } finally {
      setSaving((s) => ({ ...s, [tenantId]: false }));
    }
  };

  const onSelect = (row: EdrTenantList["rows"][number], value: string) => {
    if (value === "") return; // inert placeholder
    const next = value === UNMAPPED ? null : value;
    // Re-mapping an already-mapped tenant is destructive server-side (the old
    // org's endpoints are deleted, detections detached), so confirm first. A
    // declined confirm leaves the controlled select on its old value.
    if (row.orgId && next !== row.orgId) {
      const ok = window.confirm(
        t("edrProviders.tenantRemapConfirm", {
          tenant: row.vendorTenantName ?? row.vendorTenantId,
          from: row.orgName ?? orgName(row.orgId),
          to: next ? orgName(next) : t("edrProviders.keepUnmapped"),
        }),
      );
      if (!ok) return;
    }
    void handleMap(row.id, next);
  };

  return (
    <div data-testid={`edr-mapping-${connectionId}`} className="mt-6 rounded-lg border bg-card p-5 shadow-xs">
      <h4 className="text-sm font-semibold text-foreground">{t("edrProviders.mappingTitle")}</h4>
      <p className="mt-1 text-sm text-muted-foreground">{t("edrProviders.mappingHelp")}</p>

      {loading ? (
        <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> {t("common:states.loading")}
        </div>
      ) : loadError || !data ? (
        <div data-testid="edr-mapping-error" className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {t("edrProviders.errorLoadTenants")}
        </div>
      ) : (
        <>
          <p data-testid="edr-mapping-summary" className="mt-2 text-xs text-muted-foreground">
            {t("edrProviders.unmappedSummary", {
              tenants: data.summary.unmappedTenants,
              endpoints: data.summary.unmappedEndpointCount,
            })}
          </p>
          {data.rows.length === 0 ? (
            <p data-testid="edr-mapping-empty" className="mt-4 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              {t("edrProviders.mappingEmpty")}
            </p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[820px] text-sm">
                <thead>
                  <tr className="border-b text-left text-xs font-semibold uppercase text-muted-foreground">
                    <th className="pb-2 pr-4">{t("edrProviders.vendorTenant")}</th>
                    <th className="pb-2 pr-4">{t("edrProviders.endpoints")}</th>
                    <th className="pb-2 pr-4">{t("edrProviders.openDetections")}</th>
                    <th className="pb-2 pr-4">{t("edrProviders.lastDetectionSync")}</th>
                    <th className="pb-2 pr-4">{t("common:labels.organization")}</th>
                    <th className="pb-2">{t("common:labels.status")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => {
                    const suggestion = data.suggestions.find((s) => s.tenantId === row.id);
                    const showSuggestion = canManage && !!suggestion && !row.orgId;
                    return (
                      <tr key={row.id} data-testid={`edr-tenant-row-${row.id}`} className="border-b align-top last:border-0">
                        <td className="py-3 pr-4">
                          <div className="font-medium">{row.vendorTenantName ?? row.vendorTenantId}</div>
                          <div className="text-xs text-muted-foreground">{row.vendorTenantId}</div>
                          {row.vendorMissingSince && (
                            <div
                              data-testid={`edr-tenant-missing-${row.id}`}
                              className="mt-1 text-xs text-amber-700"
                            >
                              {t("edrProviders.missingSince", { date: formatDate(row.vendorMissingSince) })}
                            </div>
                          )}
                        </td>
                        <td className="py-3 pr-4 text-muted-foreground">{row.endpointCount ?? 0}</td>
                        <td className="py-3 pr-4 text-muted-foreground">{row.openDetectionCount ?? 0}</td>
                        <td className="py-3 pr-4 text-muted-foreground">
                          {row.lastDetectionSyncAt ? formatRelativeTime(row.lastDetectionSyncAt) : t("edrProviders.never")}
                        </td>
                        <td className="py-3 pr-4">
                          {canManage ? (
                            <div className="flex flex-col gap-2">
                              <select
                                data-testid={`edr-tenant-select-${row.id}`}
                                aria-label={t("common:labels.organization")}
                                value={row.orgId ?? (row.mappingSource === "manual_unmapped" ? UNMAPPED : "")}
                                onChange={(e) => onSelect(row, e.target.value)}
                                disabled={saving[row.id]}
                                className="h-9 w-full max-w-xs rounded-md border bg-background px-2 text-sm disabled:opacity-50"
                              >
                                <option value="">{t("edrProviders.selectOrganization")}</option>
                                <option value={UNMAPPED}>{t("edrProviders.keepUnmapped")}</option>
                                {row.orgId && !orgs.some((o) => o.id === row.orgId) && (
                                  <option value={row.orgId}>{row.orgName ?? row.orgId}</option>
                                )}
                                {orgs.map((org) => (
                                  <option key={org.id} value={org.id}>
                                    {org.name}
                                  </option>
                                ))}
                              </select>
                              {showSuggestion && suggestion && (
                                <div className="flex flex-wrap items-center gap-2">
                                  <span
                                    data-testid={`edr-tenant-suggestion-${row.id}`}
                                    className="rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-xs text-sky-700"
                                  >
                                    {t("edrProviders.suggested", { org: orgName(suggestion.orgId) })}
                                  </span>
                                  <button
                                    type="button"
                                    data-testid={`edr-tenant-apply-${row.id}`}
                                    disabled={saving[row.id]}
                                    onClick={() => void handleMap(row.id, suggestion.orgId)}
                                    className="rounded-md border px-2 py-1 text-xs font-medium disabled:opacity-50"
                                  >
                                    {t("common:actions.apply")}
                                  </button>
                                </div>
                              )}
                            </div>
                          ) : (
                            <span className="text-muted-foreground">
                              {row.orgId ? (row.orgName ?? orgName(row.orgId)) : t("edrProviders.keepUnmapped")}
                            </span>
                          )}
                        </td>
                        <td className="py-3">
                          {saving[row.id] ? (
                            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                          ) : row.orgId ? (
                            <div className="flex items-center gap-1.5">
                              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                              {row.mappingSource && (
                                <span
                                  data-testid={`edr-tenant-source-${row.id}`}
                                  className="text-xs text-muted-foreground"
                                >
                                  {t(/* i18n-dynamic */ `edrProviders.mappingSource.${row.mappingSource}`)}
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">{t("edrProviders.keepUnmapped")}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
