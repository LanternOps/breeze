import { useState, useEffect, useCallback } from "react";
import { Plus, Layers } from "lucide-react";
import ConfigPolicyList, { type ConfigPolicy } from "./ConfigPolicyList";
import { fetchWithAuth } from "../../stores/auth";
import { useOrgStore } from "../../stores/orgStore";
import { navigateTo } from "@/lib/navigation";
import { runAction, handleActionError } from "@/lib/runAction";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
type ModalMode = "closed" | "delete";
export default function ConfigurationPoliciesPage() {
  useTranslation("policies");
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const [policies, setPolicies] = useState<ConfigPolicy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [modalMode, setModalMode] = useState<ModalMode>("closed");
  const [selectedPolicy, setSelectedPolicy] = useState<ConfigPolicy | null>(
    null,
  );
  const [submitting, setSubmitting] = useState(false);
  const fetchPolicies = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const params = new URLSearchParams();
      if (currentOrgId) params.set("orgId", currentOrgId);
      const response = await fetchWithAuth(
        `/configuration-policies?${params.toString()}`,
      );
      if (!response.ok) {
        throw new Error(
          i18n.t(
            "policies:configurationPolicies.configurationPoliciesPage.failedToFetchConfigurationPolicies",
          ),
        );
      }
      const data = await response.json();
      const items = Array.isArray(data.data)
        ? data.data
        : Array.isArray(data)
          ? data
          : [];
      setPolicies(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  }, [currentOrgId]);
  useEffect(() => {
    fetchPolicies();
  }, [fetchPolicies]);
  const handleEdit = (policy: ConfigPolicy) => {
    void navigateTo(`/configuration-policies/${policy.id}`);
  };
  const handleDelete = (policy: ConfigPolicy) => {
    setSelectedPolicy(policy);
    setModalMode("delete");
  };
  const handleCloseModal = () => {
    setModalMode("closed");
    setSelectedPolicy(null);
  };
  const handleConfirmDelete = async () => {
    if (!selectedPolicy) return;
    setSubmitting(true);
    const fallback = i18n.t(
      "policies:configurationPolicies.configurationPoliciesPage.failedToDeletePolicy",
    );
    try {
      // runAction, not setError: the confirmation modal is `fixed inset-0 z-50`
      // over an opaque scrim, and this handler does NOT close it on failure —
      // so a page-level error banner rendered in normal flow is painted BEHIND
      // the modal. The user would see the button re-enable and nothing else,
      // indistinguishable from a dead button. runAction's toast renders above
      // the scrim, and extractApiError surfaces the server's real reason
      // instead of a generic string — notably the 403 partner-wide gate
      // ("Partner-wide policies require full partner org access"), which is
      // actionable and was previously discarded.
      await runAction({
        request: () =>
          fetchWithAuth(`/configuration-policies/${selectedPolicy.id}`, {
            method: "DELETE",
          }),
        errorFallback: fallback,
      });
      await fetchPolicies();
      handleCloseModal();
    } catch (err) {
      handleActionError(err, fallback);
    } finally {
      setSubmitting(false);
    }
  };
  const activeCount = policies.filter((p) => p.status === "active").length;
  const inactiveCount = policies.filter((p) => p.status === "inactive").length;
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">
            {i18n.t(
              "policies:configurationPolicies.configurationPoliciesPage.loadingConfigurationPolicies",
            )}
          </p>
        </div>
      </div>
    );
  }
  if (error && policies.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchPolicies}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {i18n.t(
            "policies:configurationPolicies.configurationPoliciesPage.tryAgain",
          )}
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {i18n.t(
              "policies:configurationPolicies.configurationPoliciesPage.configurationPolicies",
            )}
          </h1>
          <p className="text-muted-foreground">
            {i18n.t(
              "policies:configurationPolicies.configurationPoliciesPage.bundleFeatureSettingsIntoReusablePoliciesAnd",
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href="/configuration-policies/defaults"
            className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            <Layers className="h-4 w-4" />
            {i18n.t(
              "policies:configurationPolicies.configurationPoliciesPage.breezeDefaults",
            )}
          </a>
          <a
            href="/configuration-policies/new"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            {i18n.t(
              "policies:configurationPolicies.configurationPoliciesPage.newPolicy",
            )}
          </a>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {policies.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-lg border bg-card p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Layers className="h-4 w-4" />
              {i18n.t(
                "policies:configurationPolicies.configurationPoliciesPage.totalPolicies",
              )}
            </div>
            <p className="mt-2 text-2xl font-bold">{policies.length}</p>
          </div>
          <div className="rounded-lg border bg-card p-4">
            <p className="text-sm text-muted-foreground">
              {i18n.t("common:states.active")}
            </p>
            <p className="mt-2 text-2xl font-bold">{activeCount}</p>
          </div>
          <div className="rounded-lg border bg-card p-4">
            <p className="text-sm text-muted-foreground">
              {i18n.t("common:states.inactive")}
            </p>
            <p className="mt-2 text-2xl font-bold">{inactiveCount}</p>
          </div>
        </div>
      )}

      <ConfigPolicyList
        policies={policies}
        onEdit={handleEdit}
        onDelete={handleDelete}
      />

      {/*
        Compare against the ModalMode literal, NOT a translated string. An i18n
        codemod had rewritten this gate to test modalMode against the
        configurationPoliciesPage.delete catalog entry, which only ever matched
        because the en value happened to be the lowercase word "delete" — under
        fr/de/es/pt it resolves to "supprimer"/"löschen"/…, so the confirmation
        dialog never rendered and the row Delete button was a silent no-op for
        those users (#2950). The translated-comparison guard in
        src/lib/__tests__/no-translated-comparisons.test.ts now blocks the class.
      */}
      {modalMode === "delete" &&
        selectedPolicy && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8"
            data-testid="config-policy-delete-modal"
          >
            <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-xs">
              <h2 className="text-lg font-semibold">
                {i18n.t(
                  "policies:configurationPolicies.configurationPoliciesPage.deletePolicy",
                )}
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {i18n.t(
                  "policies:configurationPolicies.configurationPoliciesPage.areYouSureYouWantToDelete",
                )}{" "}
                <span className="font-medium">{selectedPolicy.name}</span>
                {i18n.t(
                  "policies:configurationPolicies.configurationPoliciesPage.thisWillAlsoRemoveAllFeatureLinks",
                )}
              </p>
              <div className="mt-6 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={handleCloseModal}
                  className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
                  data-testid="config-policy-delete-cancel"
                >
                  {i18n.t("common:actions.cancel")}
                </button>
                <button
                  type="button"
                  onClick={handleConfirmDelete}
                  disabled={submitting}
                  className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                  data-testid="config-policy-delete-confirm"
                >
                  {submitting
                    ? i18n.t(
                        "policies:configurationPolicies.configurationPoliciesPage.deleting",
                      )
                    : i18n.t("common:actions.delete")}
                </button>
              </div>
            </div>
          </div>
        )}
    </div>
  );
}
