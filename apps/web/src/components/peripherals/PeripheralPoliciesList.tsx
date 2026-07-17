import { useState, useEffect, useCallback } from "react";
import { Layers, Plus, RefreshCw, Globe } from "lucide-react";
import { fetchWithAuth } from "../../stores/auth";
import PeripheralPolicyForm from "./PeripheralPolicyForm";
import { useTranslation } from "react-i18next";

type PeripheralPolicy = {
  id: string;
  // null = partner-wide ("All organizations") policy (#2131)
  orgId?: string | null;
  name: string;
  deviceClass: string;
  action: string;
  isActive: boolean;
  exceptions?: Array<Record<string, unknown>>;
  createdAt?: string;
};

const deviceClassBadge: Record<string, string> = {
  storage: "bg-blue-500/20 text-blue-700 border-blue-500/40",
  all_usb: "bg-purple-500/20 text-purple-700 border-purple-500/40",
  bluetooth: "bg-indigo-500/20 text-indigo-700 border-indigo-500/40",
  thunderbolt: "bg-amber-500/20 text-amber-700 border-amber-500/40",
};

const actionBadge: Record<string, string> = {
  allow: "bg-success/15 text-success border-success/30",
  block: "bg-destructive/15 text-destructive border-destructive/30",
  read_only: "bg-warning/15 text-warning border-warning/30",
  alert: "bg-warning/15 text-warning border-warning/30",
};

export default function PeripheralPoliciesList() {
  const { t } = useTranslation("peripherals");
  const [policies, setPolicies] = useState<PeripheralPolicy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [showForm, setShowForm] = useState(false);
  const [editingPolicy, setEditingPolicy] = useState<PeripheralPolicy | null>(
    null,
  );

  // Filters
  const [filterClass, setFilterClass] = useState("");
  const [filterAction, setFilterAction] = useState("");
  const [filterActive, setFilterActive] = useState("");
  const fetchPolicies = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const params = new URLSearchParams();
      if (filterClass) params.set("deviceClass", filterClass);
      if (filterAction) params.set("action", filterAction);
      if (filterActive) params.set("isActive", filterActive);
      const qs = params.toString();
      const response = await fetchWithAuth(
        `/peripherals/policies${qs ? `?${qs}` : ""}`,
      );
      if (!response.ok)
        throw new Error(t("peripheralPoliciesList.errors.fetch"));
      const json = await response.json();
      setPolicies(
        Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : [],
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("peripheralPoliciesList.errors.generic"),
      );
    } finally {
      setLoading(false);
    }
  }, [filterClass, filterAction, filterActive, t]);

  useEffect(() => {
    fetchPolicies();
  }, [fetchPolicies]);

  const handleFormClose = (refresh?: boolean) => {
    setShowForm(false);
    setEditingPolicy(null);
    if (refresh) fetchPolicies();
  };

  const handleRowClick = (policy: PeripheralPolicy) => {
    setEditingPolicy(policy);
    setShowForm(true);
  };

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={filterClass}
          onChange={(e) => setFilterClass(e.target.value)}
          className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        >
          <option value="">{t("peripheralPoliciesList.allClasses")}</option>
          <option value="storage">
            {t("peripheralPoliciesList.classes.storage")}
          </option>
          <option value="all_usb">
            {t("peripheralPoliciesList.classes.all_usb")}
          </option>
          <option value="bluetooth">
            {t("peripheralPoliciesList.classes.bluetooth")}
          </option>
          <option value="thunderbolt">
            {t("peripheralPoliciesList.classes.thunderbolt")}
          </option>
        </select>
        <select
          value={filterAction}
          onChange={(e) => setFilterAction(e.target.value)}
          className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        >
          <option value="">{t("peripheralPoliciesList.allActions")}</option>
          <option value="allow">
            {t("peripheralPoliciesList.actions.allow")}
          </option>
          <option value="block">
            {t("peripheralPoliciesList.actions.block")}
          </option>
          <option value="read_only">
            {t("peripheralPoliciesList.actions.read_only")}
          </option>
          <option value="alert">
            {t("peripheralPoliciesList.actions.alert")}
          </option>
        </select>
        <select
          value={filterActive}
          onChange={(e) => setFilterActive(e.target.value)}
          className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        >
          <option value="">{t("peripheralPoliciesList.allStatus")}</option>
          <option value="true">{t("common:states.active")}</option>
          <option value="false">{t("common:states.inactive")}</option>
        </select>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            onClick={() => fetchPolicies()}
            className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              setEditingPolicy(null);
              setShowForm(true);
            }}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            {t("peripheralPoliciesList.createPolicy")}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="rounded-lg border bg-card shadow-xs">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : policies.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {t("peripheralPoliciesList.empty")}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y">
              <thead className="bg-muted/40">
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3">{t("common:labels.name")}</th>
                  <th className="px-4 py-3">
                    {t("peripheralPoliciesList.columns.deviceClass")}
                  </th>
                  <th className="px-4 py-3">
                    {t("peripheralPoliciesList.columns.action")}
                  </th>
                  <th className="px-4 py-3">{t("common:states.active")}</th>
                  <th className="px-4 py-3">
                    {t("peripheralPoliciesList.columns.exceptions")}
                  </th>
                  <th className="px-4 py-3">
                    {t("peripheralPoliciesList.columns.created")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {policies.map((policy) => (
                  <tr
                    key={policy.id}
                    className="cursor-pointer text-sm hover:bg-muted/30 transition"
                    onClick={() => handleRowClick(policy)}
                  >
                    <td className="px-4 py-3 font-medium">
                      <div className="flex items-center gap-2">
                        <span>{policy.name}</span>
                        {policy.orgId === null && (
                          <span
                            className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                            title={t("peripheralPoliciesList.partnerWideTitle")}
                            data-testid="peripheral-policy-partner-wide-badge"
                          >
                            <Layers className="h-3 w-3" />
                            {t("peripheralPoliciesList.allOrgs")}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${deviceClassBadge[policy.deviceClass] ?? "bg-muted text-muted-foreground"}`}
                      >
                        {t(
                          /* i18n-dynamic */ `peripheralPoliciesList.classes.${policy.deviceClass}`,
                          {
                            defaultValue: policy.deviceClass.replace("_", " "),
                          },
                        )}{" "}
                        {/* i18n-dynamic */}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${actionBadge[policy.action] ?? "bg-muted text-muted-foreground"}`}
                      >
                        {t(/* i18n-dynamic */ `peripheralPoliciesList.actions.${policy.action}`, {
                          defaultValue: policy.action.replace("_", " "),
                        })}{" "}
                        {/* i18n-dynamic */}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${policy.isActive ? "bg-success/15 text-success border-success/30" : "bg-muted text-muted-foreground border-border"}`}
                      >
                        {policy.isActive
                          ? t("common:labels.yes")
                          : t("common:labels.no")}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {policy.exceptions?.length ?? 0}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {policy.createdAt
                        ? new Date(policy.createdAt).toLocaleDateString()
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showForm && (
        <PeripheralPolicyForm
          policy={editingPolicy}
          onClose={handleFormClose}
        />
      )}
    </div>
  );
}
