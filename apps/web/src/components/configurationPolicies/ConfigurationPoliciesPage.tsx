import { useState, useEffect, useCallback, useRef } from "react";
import { Plus, Layers } from "lucide-react";
import ConfigPolicyList, {
  type ConfigPolicy,
  type ListViewFilters,
} from "./ConfigPolicyList";
import {
  DEFAULT_LIST_STATE,
  LIST_PAGE_SIZE,
  buildPolicyListQuery,
  parseListHash,
  parsePolicyListResponse,
  serializeListHash,
  type ListHashState,
} from "./policyListQuery";
import { useHashState } from "@/lib/useHashState";
import { fetchWithAuth } from "../../stores/auth";
import { useOrgStore } from "../../stores/orgStore";
import { navigateTo } from "@/lib/navigation";
import { runAction, handleActionError, ActionError } from "@/lib/runAction";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
type ModalMode = "closed" | "delete";
// The list reads pass `skipOrgIdInjection`: the list scopes itself with
// `appliesToOrgId` (W03d C4). fetchWithAuth would otherwise add the switcher's
// org as `orgId`, which the API ANDs with it: "All organizations" would show
// one org's policies, and another org's own policies would vanish.
// A count that is still loading reads as an ellipsis; one whose read failed as
// a dash. Neither is ever shown as 0.
const formatCount = (count: number | null | undefined) =>
  count === undefined ? "\u2026" : count === null ? "\u2014" : count;
export default function ConfigurationPoliciesPage() {
  useTranslation("policies");
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const [policies, setPolicies] = useState<ConfigPolicy[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  // undefined = still reading, null = the count read failed (shown as a dash).
  const [activeCount, setActiveCount] = useState<number | null | undefined>();
  const [inactiveCount, setInactiveCount] = useState<number | null | undefined>();
  const [orgFilterForbidden, setOrgFilterForbidden] = useState(false);
  // The last list read failed: the Total card shows a dash, never the
  // previous query's number.
  const [totalUnknown, setTotalUnknown] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [modalMode, setModalMode] = useState<ModalMode>("closed");
  const [selectedPolicy, setSelectedPolicy] = useState<ConfigPolicy | null>(
    null,
  );
  const [submitting, setSubmitting] = useState(false);
  // Set when a delete is refused with 409 POLICY_HAS_CHILDREN (#5080) — the
  // named blockers render inside the modal instead of a generic failure, and
  // the modal stays open so the operator can see exactly what to delete first.
  const [deleteBlockedChildren, setDeleteBlockedChildren] = useState<
    { id: string; name: string }[] | null
  >(null);

  // Filters, search and the page live in the URL hash (default org = the org
  // switcher's). Writes go through updateState, which keeps the ref current so
  // the stable callback the list's debounce depends on never reads stale state.
  const [state, setState] = useHashState<ListHashState>(
    DEFAULT_LIST_STATE,
    parseListHash,
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const updateState = useCallback(
    (patch: Partial<ListHashState>) => {
      // Any filter change goes back to page 1; only an explicit page keeps it.
      const next = { ...stateRef.current, page: 1, ...patch };
      stateRef.current = next;
      setState(next);
      window.location.hash = serializeListHash(next);
    },
    [setState],
  );

  const orgValue = state.org ?? currentOrgId ?? "all";
  const appliesToOrgId = orgValue === "all" ? null : orgValue;
  const statusParam = state.status === "all" ? undefined : state.status;
  const listQuery = buildPolicyListQuery({
    page: state.page,
    limit: LIST_PAGE_SIZE,
    search: state.search,
    status: statusParam,
    notApplied: state.notApplied,
    appliesToOrgId,
  });
  // The Active and Inactive cards are their own reads: the same filters, minus
  // the state filter, with the state forced and one row asked for.
  const countQuery = (status: "active" | "inactive") =>
    buildPolicyListQuery({
      page: 1,
      limit: 1,
      search: state.search,
      status,
      notApplied: state.notApplied,
      appliesToOrgId,
    });
  const activeCountQuery = countQuery("active");
  const inactiveCountQuery = countQuery("inactive");
  const hasActiveFilters =
    state.search.trim().length > 0 ||
    state.status !== "all" ||
    state.notApplied ||
    appliesToOrgId !== null;

  // Only the newest request may set state: a slow earlier answer must never
  // overwrite a newer one.
  const seqRef = useRef(0);
  // The hash is adopted post-mount; fetching before that would send the
  // default filters for a deep link.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  const readCount = useCallback(
    async (query: string): Promise<number | null> => {
      try {
        const response = await fetchWithAuth(`/configuration-policies?${query}`, { skipOrgIdInjection: true });
        if (!response.ok) return null;
        return parsePolicyListResponse(await response.json())?.total ?? null;
      } catch {
        return null;
      }
    },
    [],
  );

  const fetchPolicies = useCallback(async () => {
    const seq = ++seqRef.current;
    const isNewest = () => seq === seqRef.current;
    setLoading(true);
    setError(undefined);
    setOrgFilterForbidden(false);
    setActiveCount(undefined);
    setInactiveCount(undefined);
    void readCount(activeCountQuery).then((n) => isNewest() && setActiveCount(n));
    void readCount(inactiveCountQuery).then((n) => isNewest() && setInactiveCount(n));
    try {
      const response = await fetchWithAuth(`/configuration-policies?${listQuery}`, { skipOrgIdInjection: true });
      if (!isNewest()) return;
      // Only the route's own org-access refusal is about the filter; any other
      // 403 (a permission, MFA) is a plain fetch failure below.
      // (A 403 is never a list, so its body is read here and nowhere else.)
      const forbiddenBody =
        response.status === 403 ? await response.json().catch(() => null) : null;
      if (
        forbiddenBody &&
        typeof forbiddenBody === "object" &&
        (forbiddenBody as { error?: unknown }).error === "Access to this organization denied" &&
        new URLSearchParams(listQuery).has("appliesToOrgId")
      ) {
        if (!isNewest()) return;
        // The org filter names an organization the caller cannot use. Say so
        // inline; the filter row stays so another organization can be chosen.
        setTotalUnknown(true);
        setOrgFilterForbidden(true);
        setPolicies([]);
        setTotal(0);
        setLoaded(true);
        return;
      }
      if (!response.ok) {
        throw new Error(
          i18n.t(
            "policies:configurationPolicies.configurationPoliciesPage.failedToFetchConfigurationPolicies",
          ),
        );
      }
      const parsed = parsePolicyListResponse(await response.json());
      if (!isNewest()) return;
      if (!parsed) {
        throw new Error(
          i18n.t(
            "policies:configurationPolicies.configurationPoliciesPage.failedToFetchConfigurationPolicies",
          ),
        );
      }
      setPolicies(parsed.data);
      setTotal(parsed.total);
      setTotalUnknown(false);
      setLoaded(true);
      // A delete (or a stale link) can leave the page past the last one: move
      // to the last page that still exists.
      const lastPage = Math.max(1, Math.ceil(parsed.total / LIST_PAGE_SIZE));
      if (stateRef.current.page > lastPage) updateState({ page: lastPage });
    } catch (err) {
      if (!isNewest()) return;
      setPolicies([]);
      setTotal(0);
      setTotalUnknown(true);
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      if (isNewest()) setLoading(false);
    }
  }, [listQuery, activeCountQuery, inactiveCountQuery, readCount, updateState]);
  useEffect(() => {
    if (hydrated) void fetchPolicies();
  }, [hydrated, fetchPolicies]);

  const handleFiltersChange = useCallback(
    (patch: Partial<ListViewFilters>) => {
      const { org, ...rest } = patch;
      updateState({ ...rest, ...(org !== undefined ? { org } : {}) });
    },
    [updateState],
  );
  const organizations = useOrgStore((s) => s.organizations);
  const orgOptions = organizations.map((o) => ({ id: o.id, name: o.name }));

  const handleEdit = (policy: ConfigPolicy) => {
    void navigateTo(`/configuration-policies/${policy.id}`);
  };
  const handleDelete = (policy: ConfigPolicy) => {
    setSelectedPolicy(policy);
    setDeleteBlockedChildren(null);
    setModalMode("delete");
  };
  const handleCloseModal = () => {
    setModalMode("closed");
    setSelectedPolicy(null);
    setDeleteBlockedChildren(null);
  };
  const handleConfirmDelete = async () => {
    if (!selectedPolicy) return;
    setSubmitting(true);
    setDeleteBlockedChildren(null);
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
        // 409 POLICY_HAS_CHILDREN carries no `message`, just the bare code —
        // give the toast the same readable text as the inline list below
        // instead of the raw machine code.
        friendly: (code) =>
          code === "POLICY_HAS_CHILDREN"
            ? i18n.t(
                "policies:configurationPolicies.configurationPoliciesPage.deleteBlockedByChildren",
              )
            : undefined,
      });
      await fetchPolicies();
      handleCloseModal();
    } catch (err) {
      if (
        err instanceof ActionError &&
        err.status === 409 &&
        err.body &&
        typeof err.body === "object" &&
        (err.body as { error?: unknown }).error === "POLICY_HAS_CHILDREN"
      ) {
        // Keep the modal open and name the blockers — a generic toast alone
        // would tell the operator THAT it failed but not what to do about it.
        const children = (err.body as { children?: unknown }).children;
        setDeleteBlockedChildren(
          Array.isArray(children) ? (children as { id: string; name: string }[]) : [],
        );
      } else {
        handleActionError(err, fallback);
      }
    } finally {
      setSubmitting(false);
    }
  };
  if (loading && !loaded) {
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

      {orgFilterForbidden && (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          data-testid="config-policies-org-filter-error"
        >
          {i18n.t(
            "policies:configurationPolicies.configurationPoliciesPage.orgFilterForbidden",
          )}
        </div>
      )}

      {(total > 0 || hasActiveFilters) && (
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-lg border bg-card p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Layers className="h-4 w-4" />
              {i18n.t(
                "policies:configurationPolicies.configurationPoliciesPage.totalPolicies",
              )}
            </div>
            <p className="mt-2 text-2xl font-bold" data-testid="config-policies-total-count">
              {orgFilterForbidden || totalUnknown ? "\u2014" : total}
            </p>
          </div>
          <div className="rounded-lg border bg-card p-4">
            <p className="text-sm text-muted-foreground">
              {i18n.t("common:states.active")}
            </p>
            <p className="mt-2 text-2xl font-bold" data-testid="config-policies-active-count">
              {formatCount(activeCount)}
            </p>
          </div>
          <div className="rounded-lg border bg-card p-4">
            <p className="text-sm text-muted-foreground">
              {i18n.t("common:states.inactive")}
            </p>
            <p className="mt-2 text-2xl font-bold" data-testid="config-policies-inactive-count">
              {formatCount(inactiveCount)}
            </p>
          </div>
        </div>
      )}

      <ConfigPolicyList
        policies={policies}
        total={total}
        page={state.page}
        pageSize={LIST_PAGE_SIZE}
        filters={{
          search: state.search,
          status: state.status,
          notApplied: state.notApplied,
          org: orgValue,
        }}
        orgOptions={orgOptions}
        onFiltersChange={handleFiltersChange}
        onPageChange={(next) => updateState({ page: next })}
        filtersAtRest={
          state.search.trim().length === 0 &&
          state.status === "all" &&
          !state.notApplied &&
          state.org === undefined
        }
        onEdit={handleEdit}
        onDelete={handleDelete}
      />

      {/*
        Compare against the ModalMode literal, NOT a translated string. An i18n
        codemod had rewritten this gate to `modalMode === i18n.t(...".delete")`,
        which only ever matched because the en value happened to be the
        lowercase word "delete" — under fr/de/es/pt it resolves to
        "supprimer"/"löschen"/… so the confirmation dialog never rendered and
        the row Delete button was a silent no-op for those users (#2950).
        src/lib/__tests__/no-translated-comparisons.test.ts now guards the class
        repo-wide (and tolerates prose like this line quoting the bad shape).
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
              {deleteBlockedChildren && deleteBlockedChildren.length > 0 && (
                <div
                  className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
                  data-testid="config-policy-delete-children"
                >
                  <p className="font-medium text-destructive">
                    {i18n.t(
                      "policies:configurationPolicies.configurationPoliciesPage.deleteBlockedByChildren",
                    )}
                  </p>
                  <ul className="mt-2 list-disc space-y-0.5 pl-5 text-muted-foreground">
                    {deleteBlockedChildren.map((child) => (
                      <li key={child.id}>{child.name}</li>
                    ))}
                  </ul>
                </div>
              )}
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
