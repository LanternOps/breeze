import { useCallback, useEffect, useState } from "react";
import {
  Layers,
  AlertTriangle,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  Wrench,
  X,} from "lucide-react";
import { fetchWithAuth } from "../../stores/auth";
import { useOrgStore } from "../../stores/orgStore";
import { useDefaultOwnerScope } from "@/hooks/useDefaultOwnerScope";
import { showToast } from "../shared/Toast";
import PolicyForm, { type PolicyFormValues } from "./PolicyForm";
import { formatDateTime } from "@/lib/dateTimeFormat";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
type Policy = {
  id: string;
  name: string;
  description?: string;
  // null = partner-wide ("All organizations") template (#2126). Optional
  // because client-side prefill drafts (not yet server rows) omit it.
  orgId?: string | null;
  partnerId?: string | null;
  mode: "allowlist" | "blocklist" | "audit";
  rules?: {
    software: Array<{
      name: string;
      vendor?: string;
      minVersion?: string;
      maxVersion?: string;
      reason?: string;
    }>;
    allowUnknown?: boolean;
  };
  isActive: boolean;
  enforceMode: boolean;
  remediationOptions?: {
    autoUninstall?: boolean;
    gracePeriod?: number;
  } | null;
  createdAt?: string;
  updatedAt?: string;
};
type ComplianceOverview = {
  total: number;
  compliant: number;
  violations: number;
  unknown: number;
};
type ViolationRow = {
  device: {
    id: string;
    hostname: string;
  };
  compliance: {
    policyId: string;
    violations?: Array<{
      type: string;
    }>;
    remediationStatus?: string;
    lastChecked: string;
  };
};
type ModalMode = "closed" | "create" | "edit" | "delete";
type ComplianceDashboardProps = {
  prefill?: {
    name: string;
    vendor?: string;
    mode?: string;
  } | null;
};
function parsePolicyMode(
  value: string | null | undefined,
): Policy["mode"] | null {
  return value === "allowlist" || value === "blocklist" || value === "audit"
    ? value
    : null;
}
export default function ComplianceDashboard({
  prefill,
}: ComplianceDashboardProps = {}) {
  useTranslation("policies");
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [overview, setOverview] = useState<ComplianceOverview>({
    total: 0,
    compliant: 0,
    violations: 0,
    unknown: 0,
  });
  const [violations, setViolations] = useState<ViolationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalMode, setModalMode] = useState<ModalMode>("closed");
  const [selectedPolicy, setSelectedPolicy] = useState<Policy | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Ownership axis (#2126, mirrors ConfigPolicyCreatePage #1724): partner-scope
  // creators may own a policy partner-wide.
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const { isPartnerScope, defaultOwnerScope } = useDefaultOwnerScope();
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [policiesRes, overviewRes, violationsRes] = await Promise.all([
        fetchWithAuth("/software-policies?limit=100&isActive=true"),
        fetchWithAuth("/software-policies/compliance/overview"),
        fetchWithAuth("/software-policies/violations?limit=25"),
      ]);
      if (!policiesRes.ok || !overviewRes.ok || !violationsRes.ok) {
        throw new Error(
          i18n.t(
            "policies:software.complianceDashboard.failedToLoadSoftwarePolicyData",
          ),
        );
      }
      const [policiesData, overviewData, violationsData] = await Promise.all([
        policiesRes.json(),
        overviewRes.json(),
        violationsRes.json(),
      ]);
      setPolicies(Array.isArray(policiesData.data) ? policiesData.data : []);
      setOverview({
        total: Number(overviewData.total ?? 0),
        compliant: Number(overviewData.compliant ?? 0),
        violations: Number(overviewData.violations ?? 0),
        unknown: Number(overviewData.unknown ?? 0),
      });
      setViolations(
        Array.isArray(violationsData.data) ? violationsData.data : [],
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to load software policy data",
      );
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  // Support prefill from prop or URL: ?prefill=1&name=...&vendor=...&mode=...
  useEffect(() => {
    let name = "";
    let prefillVendor = "";
    let mode: "allowlist" | "blocklist" | "audit" | null = null;
    if (prefill?.name) {
      name = prefill.name;
      prefillVendor = prefill.vendor ?? "";
      mode = parsePolicyMode(prefill.mode);
    } else if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.get("prefill") !== "1") return;
      name = params.get("name") ?? "";
      prefillVendor = params.get("vendor") ?? "";
      mode = parsePolicyMode(params.get("mode"));
    }
    if (name) {
      setSelectedPolicy({
        id: "",
        name: `${name} Policy`,
        mode: mode ?? "blocklist",
        rules: {
          software: [{ name, vendor: prefillVendor || undefined }],
        },
        isActive: true,
        enforceMode: false,
      });
      setModalMode("create");
      // Clean up the URL
      if (typeof window !== "undefined")
        window.history.replaceState({}, "", window.location.pathname);
    }
  }, [prefill]);
  const handleCreate = () => {
    setSelectedPolicy(null);
    setModalMode("create");
  };
  const handleEdit = async (policy: Policy) => {
    try {
      const res = await fetchWithAuth(`/software-policies/${policy.id}`);
      if (res.ok) {
        const data = await res.json();
        setSelectedPolicy(data.data ?? policy);
      } else {
        console.warn(
          `[ComplianceDashboard] Failed to load policy ${policy.id}: ${res.status}`,
        );
        showToast({
          type: "error",
          message: i18n.t(
            "policies:software.complianceDashboard.couldNotLoadLatestPolicyDetailsShowing",
          ),
        });
        setSelectedPolicy(policy);
      }
    } catch (err) {
      console.warn(
        "[ComplianceDashboard] Error fetching policy for edit:",
        err,
      );
      showToast({
        type: "error",
        message: i18n.t(
          "policies:software.complianceDashboard.couldNotLoadPolicyDetailsShowingCached",
        ),
      });
      setSelectedPolicy(policy);
    }
    setModalMode("edit");
  };
  const handleFormSubmit = async (values: PolicyFormValues) => {
    setSubmitting(true);
    try {
      const body = {
        name: values.name,
        description: values.description || undefined,
        mode: values.mode,
        // Ownership is immutable after create — only send the intent on create.
        // The server derives the partner from the caller's own token (#2126).
        ownerScope: modalMode === "create" ? values.ownerScope : undefined,
        rules: {
          software: values.software.map((s) => ({
            name: s.name,
            vendor: s.vendor || undefined,
            minVersion: s.minVersion || undefined,
            maxVersion: s.maxVersion || undefined,
            reason: s.reason || undefined,
          })),
          allowUnknown:
            values.mode === "allowlist" ? values.allowUnknown : undefined,
        },
        enforceMode: values.enforceMode,
        remediationOptions: values.enforceMode
          ? {
              autoUninstall: values.autoUninstall,
              gracePeriod: values.gracePeriod,
            }
          : undefined,
      };
      const isEdit = modalMode === "edit" && selectedPolicy;
      const url = isEdit
        ? `/software-policies/${selectedPolicy.id}`
        : "/software-policies";
      const method = isEdit ? "PATCH" : "POST";
      const res = await fetchWithAuth(url, {
        method,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          (
            data as {
              error?: string;
            }
          ).error || i18n.t(/* i18n-dynamic */ isEdit ? "policies:software.complianceDashboard.failedToUpdatePolicy" : "policies:software.complianceDashboard.failedToCreatePolicy"),
        );
      }
      showToast({
        type: "success",
        message: i18n.t(/* i18n-dynamic */ isEdit ? "policies:software.complianceDashboard.policyUpdated" : "policies:software.complianceDashboard.policyCreated"),
      });
      setModalMode("closed");
      setSelectedPolicy(null);
      await refresh();
    } catch (err) {
      showToast({
        type: "error",
        message: err instanceof Error ? err.message : "Failed to save policy",
      });
    } finally {
      setSubmitting(false);
    }
  };
  const handleDelete = (policy: Policy) => {
    setSelectedPolicy(policy);
    setModalMode("delete");
  };
  const handleConfirmDelete = async () => {
    if (!selectedPolicy) return;
    setSubmitting(true);
    try {
      const res = await fetchWithAuth(
        `/software-policies/${selectedPolicy.id}`,
        {
          method: "DELETE",
        },
      );
      if (!res.ok) {
        throw new Error(
          i18n.t(
            "policies:software.complianceDashboard.failedToDeactivatePolicy",
          ),
        );
      }
      showToast({
        type: "success",
        message: `Policy "${selectedPolicy.name}" deactivated`,
      });
      setModalMode("closed");
      setSelectedPolicy(null);
      await refresh();
    } catch (err) {
      showToast({
        type: "error",
        message:
          err instanceof Error ? err.message : "Failed to deactivate policy",
      });
    } finally {
      setSubmitting(false);
    }
  };
  const handleCheckCompliance = async (policy: Policy) => {
    try {
      const res = await fetchWithAuth(`/software-policies/${policy.id}/check`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        throw new Error(
          i18n.t(
            "policies:software.complianceDashboard.failedToScheduleComplianceCheck",
          ),
        );
      }
      const data = (await res.json()) as {
        jobId?: string;
      };
      showToast({
        type: "success",
        message: `Compliance check scheduled${data.jobId ? ` (Job: ${data.jobId})` : ""}`,
      });
    } catch (err) {
      showToast({
        type: "error",
        message:
          err instanceof Error
            ? err.message
            : "Failed to schedule compliance check",
      });
    }
  };
  const handleRemediate = async (policy: Policy) => {
    try {
      const res = await fetchWithAuth(
        `/software-policies/${policy.id}/remediate`,
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          (
            data as {
              error?: string;
            }
          ).error || "Failed to schedule remediation",
        );
      }
      showToast({
        type: "success",
        message: `Remediation scheduled for ${
          (
            data as {
              queued?: number;
            }
          ).queued ?? 0
        } device(s)`,
      });
    } catch (err) {
      showToast({
        type: "error",
        message:
          err instanceof Error ? err.message : "Failed to schedule remediation",
      });
    }
  };
  const closeModal = () => {
    setModalMode("closed");
    setSelectedPolicy(null);
  };
  const policyToFormDefaults = (policy: Policy): Partial<PolicyFormValues> => ({
    name: policy.name,
    description: policy.description ?? "",
    mode: policy.mode,
    software: policy.rules?.software?.map((s) => ({
      name: s.name,
      vendor: s.vendor ?? "",
      minVersion: s.minVersion ?? "",
      maxVersion: s.maxVersion ?? "",
      reason: s.reason ?? "",
    })) ?? [
      { name: "", vendor: "", minVersion: "", maxVersion: "", reason: "" },
    ],
    allowUnknown: policy.rules?.allowUnknown ?? false,
    enforceMode: policy.enforceMode,
    autoUninstall: policy.remediationOptions?.autoUninstall ?? false,
    gracePeriod: policy.remediationOptions?.gracePeriod ?? 24,
  });
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-3 text-sm text-muted-foreground">
            {i18n.t(
              "policies:software.complianceDashboard.loadingSoftwarePolicyCompliance",
            )}
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={refresh}
          className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted/40"
        >
          {i18n.t("common:actions.refresh")}
        </button>
        <button
          type="button"
          onClick={handleCreate}
          className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          {i18n.t("policies:software.complianceDashboard.createPolicy")}
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-4">
        <div className="rounded-lg border bg-card p-4">
          <p className="text-sm text-muted-foreground">
            {i18n.t("policies:software.complianceDashboard.policies")}
          </p>
          <p className="mt-2 text-2xl font-bold">{policies.length}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-sm text-muted-foreground">
            {i18n.t("policies:software.complianceDashboard.devicesChecked")}
          </p>
          <p className="mt-2 text-2xl font-bold">{overview.total}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <ShieldCheck className="h-4 w-4 text-emerald-600" />
            {i18n.t("policies:software.complianceDashboard.compliant")}
          </div>
          <p className="mt-2 text-2xl font-bold">{overview.compliant}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            {i18n.t("policies:software.complianceDashboard.violations")}
          </div>
          <p className="mt-2 text-2xl font-bold">{overview.violations}</p>
        </div>
      </div>

      <div className="rounded-lg border bg-card">
        <div className="border-b px-4 py-3">
          <h2 className="font-semibold">
            {i18n.t("policies:software.complianceDashboard.policyDefinitions")}
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-muted/30 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">{i18n.t("common:labels.name")}</th>
                <th className="px-4 py-3">
                  {i18n.t("policies:software.complianceDashboard.mode")}
                </th>
                <th className="px-4 py-3">{i18n.t("common:labels.status")}</th>
                <th className="px-4 py-3 text-right">
                  {i18n.t("common:labels.actions")}
                </th>
              </tr>
            </thead>
            <tbody>
              {policies.map((policy) => (
                <tr key={policy.id} className="border-t">
                  <td className="px-4 py-3 font-medium">
                    <div className="flex items-center gap-2">
                      <span>{policy.name}</span>
                      {policy.orgId === null && (
                        <span
                          className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                          title={i18n.t(
                            "policies:software.complianceDashboard.partnerWideTemplateAppliesToEveryOrganization",
                          )}
                          data-testid="software-policy-partner-wide-badge"
                        >
                          <Layers className="h-3 w-3" />
                          {i18n.t(
                            "policies:software.complianceDashboard.allOrgs",
                          )}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 capitalize">{policy.mode}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-1 text-xs font-medium ${
                        policy.isActive
                          ? "bg-emerald-100 text-emerald-700"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {policy.isActive
                        ? i18n.t("common:states.active")
                        : i18n.t("common:states.inactive")}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => handleCheckCompliance(policy)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
                        title={i18n.t(
                          "policies:software.complianceDashboard.checkCompliance",
                        )}
                      >
                        <ShieldCheck className="h-4 w-4" />
                      </button>
                      {policy.mode !==
                        i18n.t(
                          "policies:software.complianceDashboard.audit",
                        ) && (
                        <button
                          type="button"
                          onClick={() => handleRemediate(policy)}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
                          title={i18n.t(
                            "policies:software.complianceDashboard.remediate",
                          )}
                        >
                          <Wrench className="h-4 w-4" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => handleEdit(policy)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
                        title={i18n.t("common:actions.edit")}
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(policy)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md border text-destructive hover:bg-destructive/10"
                        title={i18n.t(
                          "policies:software.complianceDashboard.deactivate",
                        )}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {policies.length === 0 && (
                <tr>
                  <td
                    colSpan={4}
                    className="px-4 py-6 text-center text-muted-foreground"
                  >
                    {i18n.t(
                      "policies:software.complianceDashboard.noSoftwarePoliciesFoundCreateOneTo",
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-lg border bg-card">
        <div className="border-b px-4 py-3">
          <h2 className="font-semibold">
            {i18n.t("policies:software.complianceDashboard.recentViolations")}
          </h2>
        </div>
        <div className="divide-y">
          {violations.length === 0 && (
            <p className="px-4 py-6 text-sm text-muted-foreground">
              {i18n.t(
                "policies:software.complianceDashboard.noCurrentSoftwareViolations",
              )}
            </p>
          )}
          {violations.map((row) => (
            <div
              key={`${row.compliance.policyId}:${row.device.id}`}
              className="flex flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <p className="font-medium">{row.device.hostname}</p>
                <p className="text-xs text-muted-foreground">
                  {Array.isArray(row.compliance.violations)
                    ? row.compliance.violations.length
                    : 0}{" "}
                  {i18n.t("policies:software.complianceDashboard.violationS")}
                </p>
              </div>
              <div className="text-xs text-muted-foreground">
                {i18n.t("policies:software.complianceDashboard.remediation")}
                {row.compliance.remediationStatus ??
                  i18n.t("policies:software.complianceDashboard.none")}
              </div>
              <div className="text-xs text-muted-foreground">
                {i18n.t("policies:software.complianceDashboard.checked")}
                {formatDateTime(row.compliance.lastChecked)}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Create/Edit Modal */}
      {(modalMode === "create" || modalMode === "edit") && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4">
          <div className="flex w-full max-w-3xl max-h-[calc(100vh-2rem)] flex-col rounded-lg border bg-card shadow-xs">
            <div className="flex items-center justify-between border-b px-6 py-4 shrink-0">
              <h2 className="text-lg font-semibold">
                {modalMode ===
                i18n.t("policies:software.complianceDashboard.create")
                  ? i18n.t(
                      "policies:software.complianceDashboard.createSoftwarePolicy",
                    )
                  : i18n.t(
                      "policies:software.complianceDashboard.editSoftwarePolicy",
                    )}
              </h2>
              <button
                type="button"
                onClick={closeModal}
                className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="overflow-y-auto px-6 py-4">
              <PolicyForm
                key={selectedPolicy?.id ?? "create"}
                onSubmit={handleFormSubmit}
                onCancel={closeModal}
                defaultValues={
                  modalMode ===
                    i18n.t("policies:software.complianceDashboard.edit") &&
                  selectedPolicy
                    ? policyToFormDefaults(selectedPolicy)
                    : { ownerScope: defaultOwnerScope }
                }
                submitLabel={
                  modalMode ===
                  i18n.t("policies:software.complianceDashboard.create")
                    ? i18n.t(
                        "policies:software.complianceDashboard.createPolicy",
                      )
                    : i18n.t(
                        "policies:software.complianceDashboard.updatePolicy",
                      )
                }
                loading={submitting}
                showOwnerScope={
                  modalMode ===
                    i18n.t("policies:software.complianceDashboard.create") &&
                  isPartnerScope
                }
              />
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {modalMode === "delete" && selectedPolicy && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-xs">
            <h2 className="text-lg font-semibold">
              {i18n.t("policies:software.complianceDashboard.deactivatePolicy")}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {i18n.t(
                "policies:software.complianceDashboard.areYouSureYouWantToDeactivate",
              )}{" "}
              <span className="font-medium">{selectedPolicy.name}</span>
              {i18n.t(
                "policies:software.complianceDashboard.thePolicyWillBeMarkedInactiveAnd",
              )}
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={closeModal}
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
              >
                {i18n.t("common:actions.cancel")}
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                disabled={submitting}
                className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting
                  ? i18n.t("policies:software.complianceDashboard.deactivating")
                  : i18n.t("policies:software.complianceDashboard.deactivate")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
