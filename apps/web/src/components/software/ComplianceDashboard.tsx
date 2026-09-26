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
import RemediateConfirmDialog from "./RemediateConfirmDialog";
import PolicyForm, {
  type CatalogOption,
  type PolicyFormValues,
} from "./PolicyForm";
import { asList } from "@/lib/asList";
import { runAction, ActionError } from "@/lib/runAction";
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
      catalogId?: string;
    }>;
    allowUnknown?: boolean;
  };
  isActive: boolean;
  enforceMode: boolean;
  remediationOptions?: {
    autoUninstall?: boolean;
    autoInstall?: boolean;
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
      rule?: {
        catalogId?: string;
      };
    }>;
    remediationStatus?: string;
    // Desired-state install remediation, projected by GET /violations (#5509).
    // Absent on a policy that was never armed.
    installRemediationStatus?: string;
    lastInstallRemediationAttempt?: string;
    installRemediationAttempts?: number;
    lastChecked: string;
  };
};

const installStatusLabelKeys: Record<string, string> = {
  pending: "policies:software.complianceDashboard.installStatusPending",
  in_progress: "policies:software.complianceDashboard.installStatusInProgress",
  completed: "policies:software.complianceDashboard.installStatusCompleted",
  failed: "policies:software.complianceDashboard.installStatusFailed",
  gave_up: "policies:software.complianceDashboard.installStatusGaveUp",
  skipped: "policies:software.complianceDashboard.installStatusSkipped",
};

const installStatusBadgeStyles: Record<string, string> = {
  pending: "bg-blue-100 text-blue-700",
  in_progress: "bg-blue-100 text-blue-700",
  completed: "bg-emerald-100 text-emerald-700",
  failed: "bg-amber-100 text-amber-700",
  // 'gave_up' is a distinct TERMINAL state, not another shade of "failed":
  // the install loop has stopped retrying this device entirely. Destructive
  // red so it reads as "Breeze stopped trying", not "one attempt failed".
  gave_up: "bg-destructive/10 text-destructive",
  skipped: "bg-slate-100 text-slate-600",
};

function installStatusBadgeClass(status: string): string {
  return installStatusBadgeStyles[status] ?? installStatusBadgeStyles.failed;
}

// A 'skipped' status collapses three causes the worker does not persist
// separately: no catalogId on the rule, the per-pass install cap, or no
// install method for the device's platform. Only the first is reconstructable
// from data this route already returns (the violation's own rule carries
// catalogId), so only that case gets a specific, actionable explanation; the
// other two share one honest, hedged sentence rather than a false claim of
// precision the data cannot support.
function installSkipHasMissingCatalogLink(row: ViolationRow): boolean {
  return (row.compliance.violations ?? []).some(
    (violation) => violation.type === "missing" && !violation.rule?.catalogId,
  );
}
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
  // Catalog items for PolicyForm's per-rule catalog-link picker (#5509).
  // Fetched on its own rather than inside refresh()'s Promise.all: a catalog
  // hiccup must not blank the whole dashboard.
  const [catalogItems, setCatalogItems] = useState<CatalogOption[]>([]);
  // An empty picker because the fetch failed must never look like an empty
  // picker because the org has no catalog items — the authoring warning would
  // otherwise blame the operator for a broken data source.
  const [catalogUnavailable, setCatalogUnavailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithAuth("/software/catalog");
        if (cancelled) return;
        if (!res.ok) {
          console.warn(
            "[ComplianceDashboard] Software catalog fetch failed for policy linking:",
            res.status,
          );
          setCatalogUnavailable(true);
          return;
        }
        const payload = await res.json();
        const rows = asList<Record<string, unknown>>(payload, "catalog");
        const items = rows
          .map((item) => ({
            id: String(item.id ?? ""),
            name: String(item.name ?? ""),
            vendor: item.vendor ? String(item.vendor) : undefined,
          }))
          .filter((item) => item.id.length > 0);
        if (!cancelled) setCatalogItems(items);
      } catch (err) {
        // Non-fatal for the rest of the dashboard, but the picker must say so.
        console.warn(
          "[ComplianceDashboard] Failed to load software catalog for policy linking:",
          err,
        );
        if (!cancelled) setCatalogUnavailable(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
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
  // Both arming refusals are coded 403s: MFA_REQUIRED from requireMfa(), and
  // DEVICES_EXECUTE_REQUIRED from the server's assertMayArmInstall permission
  // check. Neither may be swallowed (CLAUDE.md runAction contract, #5509).
  const armInstallFriendly = (code: string) => {
    if (code === "MFA_REQUIRED") {
      return i18n.t(
        "policies:software.complianceDashboard.armInstallRequiresMfa",
      );
    }
    if (code === "DEVICES_EXECUTE_REQUIRED") {
      return i18n.t(
        "policies:software.complianceDashboard.armInstallRequiresPermission",
      );
    }
    return undefined;
  };

  const handleFormSubmit = async (values: PolicyFormValues) => {
    setSubmitting(true);
    const isEdit = modalMode === "edit" && selectedPolicy;
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
          catalogId: s.catalogId || undefined,
        })),
        allowUnknown:
          values.mode === "allowlist" ? values.allowUnknown : undefined,
      },
      enforceMode: values.enforceMode,
      remediationOptions: values.enforceMode
        ? {
            autoUninstall: values.autoUninstall,
            // Arming is meaningless outside allowlist mode — only allowlist
            // rules ever produce a 'missing' violation. The checkbox unmounts
            // when the operator switches mode away, but react-hook-form keeps
            // its last value, so guard here (same shape as allowUnknown).
            autoInstall:
              values.mode === "allowlist" ? values.autoInstall : undefined,
            gracePeriod: values.gracePeriod,
          }
        : undefined,
    };
    const url = isEdit
      ? `/software-policies/${selectedPolicy.id}`
      : "/software-policies";
    const method = isEdit ? "PATCH" : "POST";
    try {
      await runAction({
        request: () =>
          fetchWithAuth(url, { method, body: JSON.stringify(body) }),
        errorFallback: i18n.t(
          /* i18n-dynamic */ isEdit
            ? "policies:software.complianceDashboard.failedToUpdatePolicy"
            : "policies:software.complianceDashboard.failedToCreatePolicy",
        ),
        friendly: armInstallFriendly,
        successMessage: i18n.t(
          /* i18n-dynamic */ isEdit
            ? "policies:software.complianceDashboard.policyUpdated"
            : "policies:software.complianceDashboard.policyCreated",
        ),
      });
    } catch (err) {
      // runAction already toasted an ActionError (including the friendly
      // arming-refusal copy above) — never a silent no-op. Anything else
      // still needs its own toast. The modal stays open for retry.
      if (!(err instanceof ActionError)) {
        showToast({ type: "error", message: "Failed to save policy" });
      }
      setSubmitting(false);
      return;
    }
    setSubmitting(false);
    setModalMode("closed");
    setSelectedPolicy(null);
    // refresh() surfaces its own failures via setError()'s banner and does not
    // rethrow, so this catch is belt-and-braces rather than the operative error
    // path — it exists only so that if refresh() ever starts throwing, the save
    // (which genuinely succeeded) is not reported back as a failure.
    try {
      await refresh();
    } catch (err) {
      console.error(
        "[ComplianceDashboard] refresh() failed after a successful policy save",
        err,
      );
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
      await runAction({
        request: () => fetchWithAuth(`/software-policies/${policy.id}/check`, {
          method: "POST",
          body: JSON.stringify({}),
        }),
        errorFallback: i18n.t(
          "policies:software.complianceDashboard.failedToScheduleComplianceCheck",
        ),
        successMessage: i18n.t(
          "policies:software.complianceDashboard.complianceCheckQueued",
        ),
      });
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({
          type: "error",
          message: i18n.t(
            "policies:software.complianceDashboard.failedToScheduleComplianceCheck",
          ),
        });
      }
    }
  };

  // Remediate uninstalls software on real machines. It opens a server-backed
  // preview + confirmation (#3616, incident #3381) rather than POSTing
  // directly; the dialog confirms with exactly the previewed device ids.
  const [remediatePolicy, setRemediatePolicy] = useState<Policy | null>(null);
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
      catalogId: s.catalogId ?? "",
    })) ?? [
      {
        name: "",
        vendor: "",
        minVersion: "",
        maxVersion: "",
        reason: "",
        catalogId: "",
      },
    ],
    allowUnknown: policy.rules?.allowUnknown ?? false,
    enforceMode: policy.enforceMode,
    autoUninstall: policy.remediationOptions?.autoUninstall ?? false,
    autoInstall: policy.remediationOptions?.autoInstall ?? false,
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
                    <div className="flex flex-wrap items-center gap-2">
                      <span>{policy.name}</span>
                      {policy.enforceMode && policy.remediationOptions?.autoInstall && (
                        <span
                          data-testid="policy-autoinstall-badge"
                          className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-800 dark:text-amber-300"
                        >
                          {i18n.t("policies:software.complianceDashboard.autoInstallArmed")}
                        </span>
                      )}
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
                        data-testid={`policy-check-compliance-${policy.id}`}
                        onClick={() => handleCheckCompliance(policy)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
                        title={i18n.t(
                          "policies:software.complianceDashboard.checkCompliance",
                        )}
                      >
                        <ShieldCheck className="h-4 w-4" />
                      </button>
                      {/*
                        `mode` is the softwarePolicies enum
                        ("allowlist" | "blocklist" | "audit"), so it must be
                        compared to the literal. Comparing it to the translated
                        label offered Remediate on audit-only policies wherever
                        the catalog actually translated "audit" (fr: "Audit",
                        de: "Prüfung", es: "auditoría") — audit mode means
                        report, never change.
                      */}
                      {policy.mode !== "audit" && (
                        <button
                          type="button"
                          data-testid={`policy-remediate-${policy.id}`}
                          onClick={() => setRemediatePolicy(policy)}
                          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-destructive/40 px-2.5 text-sm font-medium text-destructive hover:bg-destructive/10"
                        >
                          <Wrench className="h-4 w-4" aria-hidden="true" />
                          {i18n.t(
                            "policies:software.complianceDashboard.remediate",
                          )}
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
              {row.compliance.installRemediationStatus &&
                row.compliance.installRemediationStatus !== "none" && (
                  <div
                    className="flex flex-col items-start gap-1 text-xs text-muted-foreground sm:items-end"
                    data-testid={`install-remediation-${row.device.id}`}
                  >
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${installStatusBadgeClass(
                        row.compliance.installRemediationStatus,
                      )}`}
                    >
                      {i18n.t(
                        /* i18n-dynamic */ installStatusLabelKeys[
                          row.compliance.installRemediationStatus
                        ] ?? installStatusLabelKeys.failed,
                      )}
                    </span>
                    {row.compliance.installRemediationStatus === "skipped" && (
                      <span>
                        {installSkipHasMissingCatalogLink(row)
                          ? i18n.t(
                              "policies:software.complianceDashboard.installSkippedNoCatalog",
                            )
                          : i18n.t(
                              "policies:software.complianceDashboard.installSkippedCapOrPlatform",
                            )}
                      </span>
                    )}
                    {!!row.compliance.installRemediationAttempts && (
                      <span>
                        {i18n.t(
                          "policies:software.complianceDashboard.installAttempts",
                          {
                            count: row.compliance.installRemediationAttempts,
                          },
                        )}
                      </span>
                    )}
                    {row.compliance.lastInstallRemediationAttempt && (
                      <span>
                        {i18n.t(
                          "policies:software.complianceDashboard.installLastAttempt",
                        )}
                        {formatDateTime(
                          row.compliance.lastInstallRemediationAttempt,
                        )}
                      </span>
                    )}
                  </div>
                )}
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
                {modalMode === "create"
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
                  modalMode === "edit" && selectedPolicy
                    ? policyToFormDefaults(selectedPolicy)
                    : { ownerScope: defaultOwnerScope }
                }
                submitLabel={
                  modalMode === "create"
                    ? i18n.t(
                        "policies:software.complianceDashboard.createPolicy",
                      )
                    : i18n.t(
                        "policies:software.complianceDashboard.updatePolicy",
                      )
                }
                loading={submitting}
                showOwnerScope={
                  modalMode === "create" && isPartnerScope
                }
                policyId={
                  modalMode === "edit" ? selectedPolicy?.id || undefined : undefined
                }
                catalogItems={catalogItems}
                catalogUnavailable={catalogUnavailable}
              />
            </div>
          </div>
        </div>
      )}

      <RemediateConfirmDialog
        open={remediatePolicy !== null}
        policy={remediatePolicy}
        onClose={() => setRemediatePolicy(null)}
        onQueued={() => {
          refresh().catch((err) =>
            console.error(
              "[ComplianceDashboard] refresh() failed after queuing remediation",
              err,
            ),
          );
        }}
      />

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
