import { useMemo, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { fetchWithAuth } from "../../stores/auth";
import { useOrgStore } from "../../stores/orgStore";
import { handleActionError, runAction } from "@/lib/runAction";
import "@/lib/i18n";

export type BackupProviderCustomer = {
  id: string;
  vendorCustomerId: string;
  vendorCustomerName: string;
  vendorLevel: string | null;
  vendorExternalCode: string | null;
  orgId: string | null;
  mappingSource: "manual" | "auto_name" | "auto_external_code" | "manual_unmapped" | null;
  deviceCount: number;
  unmappedDeviceCount: number;
  lastSeenAt: string | null;
};

/**
 * Sentinel for "deliberately not mapped". `orgId: null` on the wire means two
 * different things to the API — a never-decided customer keeps mapping_source
 * NULL so auto-mapping retries it, while an explicit unmap sets
 * `manual_unmapped`, which auto-mapping must never touch. The empty-string
 * placeholder therefore stays INERT: opening the dropdown and closing it must
 * not silently pin a customer out of auto-mapping forever.
 */
const UNMAPPED = "__unmapped__";

export default function BackupProviderCustomerMapping({
  connectionId,
  customers,
  onChanged,
}: {
  connectionId: string;
  customers: BackupProviderCustomer[];
  onChanged: () => void;
}) {
  const { t } = useTranslation("integrations");
  const organizations = useOrgStore((s) => s.organizations);
  const [saving, setSaving] = useState<Record<string, boolean>>({});

  const summary = useMemo(() => {
    const unmappedCustomers = customers.filter((c) => !c.orgId);
    return {
      customers: unmappedCustomers.length,
      devices: unmappedCustomers.reduce((sum, c) => sum + (c.unmappedDeviceCount ?? 0), 0),
    };
  }, [customers]);

  const handleMap = async (customerId: string, value: string) => {
    if (value === "") return; // inert placeholder
    const orgId = value === UNMAPPED ? null : value;
    setSaving((s) => ({ ...s, [customerId]: true }));
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/backup/providers/customers/${customerId}/mapping`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ orgId }),
          }),
        errorFallback: t("backupProviders.errorMap"),
        successMessage: t("backupProviders.mappedToast"),
      });
      onChanged();
    } catch (err) {
      handleActionError(err, t("backupProviders.errorMap"));
    } finally {
      setSaving((s) => ({ ...s, [customerId]: false }));
    }
  };

  return (
    <div data-testid={`backup-mapping-${connectionId}`} className="mt-6 rounded-lg border bg-card p-5 shadow-xs">
      <h4 className="text-sm font-semibold text-foreground">{t("backupProviders.mappingTitle")}</h4>
      <p className="mt-1 text-sm text-muted-foreground">{t("backupProviders.mappingHelp")}</p>
      <p data-testid="backup-mapping-summary" className="mt-2 text-xs text-muted-foreground">
        {t("backupProviders.unmappedSummary", { customers: summary.customers, devices: summary.devices })}
      </p>

      {customers.length === 0 ? (
        <p data-testid="backup-mapping-empty" className="mt-4 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          {t("backupProviders.mappingEmpty")}
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b text-left text-xs font-semibold uppercase text-muted-foreground">
                <th className="pb-2 pr-4">{t("backupProviders.vendorCustomer")}</th>
                <th className="pb-2 pr-4">{t("backupProviders.level")}</th>
                <th className="pb-2 pr-4">{t("backupProviders.devices")}</th>
                <th className="pb-2 pr-4">{t("common:labels.organization")}</th>
                <th className="pb-2">{t("common:labels.status")}</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((row) => (
                <tr key={row.id} data-testid={`backup-mapping-row-${row.id}`} className="border-b last:border-0">
                  <td className="py-3 pr-4">
                    <div className="font-medium">{row.vendorCustomerName}</div>
                    <div className="text-xs text-muted-foreground">{row.vendorCustomerId}</div>
                  </td>
                  <td className="py-3 pr-4 text-muted-foreground">{row.vendorLevel ?? "--"}</td>
                  <td data-testid={`backup-mapping-devices-${row.id}`} className="py-3 pr-4 text-muted-foreground">
                    {row.deviceCount}
                  </td>
                  <td className="py-3 pr-4">
                    <div className="flex items-center gap-2">
                      <select
                        data-testid={`backup-mapping-select-${row.id}`}
                        value={row.orgId ?? (row.mappingSource === "manual_unmapped" ? UNMAPPED : "")}
                        onChange={(e) => void handleMap(row.id, e.target.value)}
                        disabled={saving[row.id]}
                        className="h-9 w-full max-w-xs rounded-md border bg-background px-2 text-sm disabled:opacity-50"
                      >
                        <option value="">{t("backupProviders.selectOrganization")}</option>
                        <option value={UNMAPPED}>{t("backupProviders.keepUnmapped")}</option>
                        {organizations.map((org) => (
                          <option key={org.id} value={org.id}>
                            {org.name}
                          </option>
                        ))}
                      </select>
                      {(row.mappingSource === "auto_name" || row.mappingSource === "auto_external_code") && (
                        <span
                          data-testid={`backup-mapping-auto-${row.id}`}
                          title={t("backupProviders.autoTitle", { source: row.mappingSource })}
                          className="shrink-0 rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-xs text-sky-700"
                        >
                          {t("backupProviders.auto")}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-3">
                    {saving[row.id] ? (
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    ) : row.orgId ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                    ) : (
                      <span className="text-xs text-muted-foreground">{t("backupProviders.keepUnmapped")}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
