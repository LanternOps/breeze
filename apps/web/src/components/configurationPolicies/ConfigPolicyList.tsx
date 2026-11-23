import { useEffect, useRef, useState } from "react";
import { LIST_PAGE_SIZE, type StatusFilter } from "./policyListQuery";
import {
  Layers,
  Search,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Trash2,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { FilterSelect } from "../shared/FilterSelect";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
import { FEATURE_META, type FeatureType } from "./featureTabs/types";
import {
  appliesToState,
  formatAppliesToTargets,
  notAppliedTone,
  parseAppliesTo,
} from "./appliesToSummary";
import ReachCount from "./appliesTo/ReachCount";
import { fetchReach, type ConfigPolicyReach } from "./appliesTo/appliesToApi";
export type ConfigPolicyStatus = "active" | "inactive" | "archived";
export type ConfigPolicy = {
  id: string;
  name: string;
  description?: string;
  status: ConfigPolicyStatus;
  // null = partner-wide ("All organizations") policy (#1724)
  orgId: string | null;
  partnerId?: string | null;
  // Present when this policy inherits from a baseline (#5080).
  parentPolicyId?: string | null;
  // Owning org's name, joined in by the list API for org-owned policies.
  orgName?: string | null;
  // Still sent by the API; no longer read. The Applies to column below shows
  // where a policy applies from `appliesTo` instead (#12306).
  hasPartnerWideAssignment?: boolean;
  // Where the policy applies (#12306), parsed per row with parseAppliesTo.
  // Absent when the API is a release behind: the row then claims nothing.
  appliesTo?: unknown;
  createdAt?: string;
  updatedAt?: string;
  featureLinks?: {
    id: string;
    featureType: string;
  }[];
};
// What the filter row shows. `org` is the select's value: "all" or an org id.
export type ListViewFilters = {
  search: string;
  status: StatusFilter;
  notApplied: boolean;
  org: string;
};
const DEFAULT_VIEW_FILTERS: ListViewFilters = {
  search: "",
  status: "all",
  notApplied: false,
  org: "all",
};
const SEARCH_DEBOUNCE_MS = 300;
type ConfigPolicyListProps = {
  // The rows of the current server page.
  policies: ConfigPolicy[];
  // The server's total for the current filters (not the rows held here).
  total?: number;
  page?: number;
  pageSize?: number;
  filters?: ListViewFilters;
  // The organization select shows only with more than one org to choose from.
  orgOptions?: { id: string; name: string }[];
  onFiltersChange?: (patch: Partial<ListViewFilters>) => void;
  onPageChange?: (page: number) => void;
  /**
   * The filters are at rest: nothing the user chose narrows the list. An org
   * filter that only follows the org switcher is at rest. Absent = judged from
   * `filters`.
   */
  filtersAtRest?: boolean;
  onEdit?: (policy: ConfigPolicy) => void;
  onDelete?: (policy: ConfigPolicy) => void;
};
const createStatusConfig = (): Record<
  ConfigPolicyStatus,
  {
    label: string;
    color: string;
  }
> => ({
  active: {
    label: i18n.t("common:states.active"),
    color: "bg-success/15 text-success border-success/30",
  },
  inactive: {
    label: i18n.t("common:states.inactive"),
    color: "bg-warning/15 text-warning border-warning/30",
  },
  archived: {
    label: i18n.t("policies:configurationPolicies.configPolicyList.archived"),
    color: "bg-muted text-muted-foreground border-border",
  },
});
// Feature badge labels come from FEATURE_META — the same registry the policy
// editor's feature tabs render — so the list can't drift from the tab names the
// user just clicked. The previous local map covered 8 of the 18 canonical
// feature types and silently fell through to raw enum values for the rest.
function featureTypeLabel(featureType: string): string {
  return FEATURE_META[featureType as FeatureType]?.label ?? featureType;
}
type AppliesTo = ReturnType<typeof parseAppliesTo>;

// The first targets and +N, from the API's unfiltered count (#12306). An absent
// or malformed summary is unknown: an em dash, never "Not applied". The device
// count follows when the page's reach read answered (#12467).
function AppliesToCell({ summary, reach }: { summary: AppliesTo; reach?: ConfigPolicyReach }) {
  const state = summary ? appliesToState(summary) : null;
  if (!summary || state !== "applied") {
    return (
      <div className="flex flex-col gap-0.5">
        <span className="text-muted-foreground" aria-hidden="true">
          &mdash;
        </span>
        {reach && state === "in_use_through_children" && (
          <ReachCount reach={reach} count="throughChildren" testId="config-policy-applies-to-reach" />
        )}
      </div>
    );
  }
  const { shown, more } = formatAppliesToTargets(summary);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1">
        {shown.map((target) => (
          <span
            key={target.key}
            className="inline-flex items-center gap-1 rounded-full border bg-muted/50 px-2 py-0.5 text-xs text-foreground"
          >
            {target.text}
          </span>
        ))}
        {more > 0 && (
          <span className="text-xs font-medium text-muted-foreground">+{more}</span>
        )}
      </div>
      {reach && <ReachCount reach={reach} count="direct" testId="config-policy-applies-to-reach" />}
    </div>
  );
}

// One state chip beside the status: Not applied (a warning only when active)
// or In use through N policies for a parent with no rows of its own.
function AppliesToStateChip({
  status,
  summary,
}: {
  status: ConfigPolicyStatus;
  summary: AppliesTo;
}) {
  if (!summary) return null;
  const state = appliesToState(summary);
  if (state === "in_use_through_children") {
    return (
      <span
        className="inline-flex items-center rounded-full border bg-muted/60 px-2 py-0.5 text-xs font-medium text-muted-foreground"
        data-testid="config-policy-in-use-badge"
      >
        <Layers className="mr-1 h-3 w-3" aria-hidden="true" />
        {i18n.t("policies:configurationPolicies.configPolicyList.inUseChip", {
          count: summary.childPolicyCount,
        })}
      </span>
    );
  }
  const tone = notAppliedTone(status, state);
  if (!tone) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        tone === "warning"
          ? "border-warning/30 bg-warning/15 text-warning"
          : "bg-muted/60 text-muted-foreground",
      )}
      data-testid="config-policy-not-applied-badge"
      data-tone={tone}
    >
      {tone === "warning" && <AlertTriangle className="mr-1 h-3 w-3" aria-hidden="true" />}
      {i18n.t("policies:configurationPolicies.configPolicyList.notAppliedChip")}
    </span>
  );
}
function formatDate(dateString?: string): string {
  if (!dateString) return "\u2014";
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleDateString();
}
export default function ConfigPolicyList({
  policies,
  total = policies.length,
  page = 1,
  pageSize = LIST_PAGE_SIZE,
  filters = DEFAULT_VIEW_FILTERS,
  orgOptions = [],
  onFiltersChange,
  onPageChange,
  filtersAtRest,
  onEdit,
  onDelete,
}: ConfigPolicyListProps) {
  useTranslation("policies");
  const statusConfig = createStatusConfig();
  // Accessible names for the icon-only controls (#2950). The row buttons append
  // the policy name so a screen-reader user can tell one row's Edit from
  // another's, which a bare "Edit" cannot.
  const editLabel = i18n.t("common:actions.edit");
  const deleteLabel = i18n.t("common:actions.delete");
  // Dedicated pagination keys rather than actions.back/actions.next: those are
  // navigation verbs ("Back"/"Retour"/"Zurück"), which is the wrong thing to
  // announce for a pager control.
  const previousPageLabel = i18n.t("common:actions.previousPage");
  const nextPageLabel = i18n.t("common:actions.nextPage");

  // Paging, search and the filters all run on the server: this component only
  // renders the rows it is handed and reports what the user changed.
  const paginatedPolicies = policies;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const hasActiveFilters =
    filters.search.trim().length > 0 ||
    filters.status !== "all" ||
    filters.notApplied ||
    filters.org !== "all";
  // "No results" and "nothing exists yet" are different states and need
  // different copy. The server's total is 0 AND nothing narrows the list. This
  // does not claim the tenant is new: it only says the list is empty with the
  // filters at rest.
  const hasNoPoliciesAtAll = total === 0 && (filtersAtRest ?? !hasActiveFilters);
  const firstShown = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const lastShown = Math.min(total, (safePage - 1) * pageSize + policies.length);

  // The search box types into a local draft; the parent hears about it once the
  // user pauses, so each keystroke is not a request. A search that changed from
  // outside (the hash, back/forward) replaces the draft.
  const [searchDraft, setSearchDraft] = useState(filters.search);
  const emittedSearch = useRef(filters.search);
  useEffect(() => {
    if (filters.search !== emittedSearch.current) {
      emittedSearch.current = filters.search;
      setSearchDraft(filters.search);
    }
  }, [filters.search]);
  useEffect(() => {
    if (searchDraft === emittedSearch.current) return;
    const timer = setTimeout(() => {
      emittedSearch.current = searchDraft;
      onFiltersChange?.({ search: searchDraft });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchDraft, onFiltersChange]);

  // Device counts for the rows shown, one reach read per page (#12467).
  // A failed read leaves the counts out; the list stays usable. An id absent
  // from the answer is unknown, never 0.
  const pageIdsKey = paginatedPolicies.map((p) => p.id).join(",");
  const [reachById, setReachById] = useState<Record<string, ConfigPolicyReach>>({});
  useEffect(() => {
    if (!pageIdsKey) return;
    let cancelled = false;
    const ids = pageIdsKey.split(",");
    // The newest read owns this page's counts: an id it leaves out, or a read
    // that fails, shows no count rather than an older one.
    const replacePage = (reach: Record<string, ConfigPolicyReach>) =>
      setReachById((prev) => {
        const next = { ...prev };
        for (const id of ids) delete next[id];
        return Object.assign(next, reach);
      });
    fetchReach(ids)
      .then((reach) => {
        if (!cancelled) replacePage(reach);
      })
      .catch((err: unknown) => {
        // Counts are an addition to the row; without them the row still reads.
        console.warn("[configuration policies] reach read failed", err);
        if (!cancelled) replacePage({});
      });
    return () => {
      cancelled = true;
    };
  }, [pageIdsKey]);
  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">
            {i18n.t(
              "policies:configurationPolicies.configPolicyList.configurationPolicies",
            )}
          </h2>
          {/*
            One interpolated string, not four adjacent JSX expressions. The
            #2340 extraction codemod split "N of M policies" into
            {count}{t.of}{count}{t.policies}, and JSX inserts no whitespace
            between expression containers, so this rendered as "0of0policies".
            Interpolating also keeps word order translatable, which glueing the
            fragments back together with spaces would not.
          */}
          <p
            className="text-sm text-muted-foreground"
            data-testid="config-policy-range-summary"
          >
            {i18n.t("policies:configurationPolicies.configPolicyList.rangeSummary", {
              from: firstShown,
              to: lastShown,
              total,
            })}
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center flex-wrap">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              placeholder={i18n.t(
                "policies:configurationPolicies.configPolicyList.searchPolicies",
              )}
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
              className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-48"
            />
          </div>
          <FilterSelect
            label={i18n.t(
              "policies:configurationPolicies.configPolicyList.statusFilterLabel",
            )}
            value={filters.status}
            onChange={(event) =>
              onFiltersChange?.({ status: event.target.value as StatusFilter })
            }
            className="w-full sm:w-36"
            data-testid="config-policy-status-filter"
          >
            <option value="all">
              {i18n.t(
                "policies:configurationPolicies.configPolicyList.allStatus",
              )}
            </option>
            <option value="active">{i18n.t("common:states.active")}</option>
            <option value="inactive">{i18n.t("common:states.inactive")}</option>
            <option value="archived">
              {i18n.t(
                "policies:configurationPolicies.configPolicyList.archived2",
              )}
            </option>
          </FilterSelect>
          {orgOptions.length > 1 && (
            <FilterSelect
              label={i18n.t(
                "policies:configurationPolicies.configPolicyList.organizationFilterLabel",
              )}
              value={filters.org}
              onChange={(event) => onFiltersChange?.({ org: event.target.value })}
              className="w-full sm:w-48"
              data-testid="config-policy-org-filter"
            >
              <option value="all">
                {i18n.t(
                  "policies:configurationPolicies.configPolicyList.allOrganizations",
                )}
              </option>
              {orgOptions.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </FilterSelect>
          )}
          <label className="inline-flex h-10 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={filters.notApplied}
              onChange={(event) =>
                onFiltersChange?.({ notApplied: event.target.checked })
              }
              className="h-4 w-4 rounded border"
              data-testid="config-policy-not-applied-filter"
            />
            {i18n.t(
              "policies:configurationPolicies.configPolicyList.notAppliedFilterLabel",
            )}
          </label>
        </div>
      </div>

      <div className="mt-6 overflow-x-auto rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">{i18n.t("common:labels.name")}</th>
              <th className="px-4 py-3">
                {i18n.t(
                  "policies:configurationPolicies.configPolicyList.appliesToHeader",
                )}
              </th>
              <th className="px-4 py-3">{i18n.t("common:labels.status")}</th>
              <th className="px-4 py-3">
                {i18n.t(
                  "policies:configurationPolicies.configPolicyList.features",
                )}
              </th>
              <th className="px-4 py-3">{i18n.t("common:labels.updatedAt")}</th>
              <th className="px-4 py-3 text-right">
                {i18n.t("common:labels.actions")}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {paginatedPolicies.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-6 text-center text-sm text-muted-foreground"
                >
                  {hasNoPoliciesAtAll ? (
                    // Nothing to adjust: the list is empty and the search and
                    // status controls are untouched, so telling the user to
                    // change a search they never made is unhelpful. This does
                    // NOT establish that the tenant has no policies — the list
                    // can be org-scoped, and a malformed HTTP 200 is coerced to
                    // [] upstream — so the copy stays a suggestion, not a claim.
                    <>
                      <p>
                        {i18n.t(
                          "policies:configurationPolicies.configPolicyList.noPoliciesYet",
                        )}
                      </p>
                      <a
                        href="/configuration-policies/new"
                        className="mt-3 inline-flex items-center rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
                      >
                        {i18n.t(
                          "policies:configurationPolicies.configurationPoliciesPage.newPolicy",
                        )}
                      </a>
                    </>
                  ) : (
                    i18n.t(
                      "policies:configurationPolicies.configPolicyList.noPoliciesFoundTryAdjustingYourSearch",
                    )
                  )}
                </td>
              </tr>
            ) : (
              paginatedPolicies.map((policy) => {
                const appliesTo = parseAppliesTo(policy.appliesTo);
                return (
                <tr
                  key={policy.id}
                  className="text-sm"
                  data-testid="config-policy-row"
                  data-policy-id={policy.id}
                >
                  <td className="px-4 py-3 font-medium text-foreground">
                    <span>{policy.name}</span>
                    {/* Only an org-managed row names its manager; an
                        MSP-managed row is the default and says nothing. */}
                    {policy.orgId !== null && (
                      <p
                        className="mt-0.5 text-xs font-normal text-muted-foreground"
                        data-testid="config-policy-managed-by"
                      >
                        {i18n.t(
                          "policies:configurationPolicies.configPolicyList.managedByOrganization",
                          {
                            organization:
                              policy.orgName ??
                              i18n.t(
                                "policies:configurationPolicies.configPolicyList.itsOwningOrganization",
                              ),
                          },
                        )}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3" data-testid="config-policy-applies-to-cell">
                    <AppliesToCell summary={appliesTo} reach={reachById[policy.id]} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium",
                          statusConfig[policy.status].color,
                        )}
                      >
                        {statusConfig[policy.status].label}
                      </span>
                      <AppliesToStateChip status={policy.status} summary={appliesTo} />
                      {policy.parentPolicyId && (
                        <span
                          className="inline-flex items-center rounded-full border bg-muted/60 px-2 py-0.5 text-xs font-medium text-muted-foreground"
                          data-testid="config-policy-inherits-badge"
                        >
                          {i18n.t(
                            "policies:configurationPolicies.configPolicyList.inheritsBadge",
                          )}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {policy.featureLinks && policy.featureLinks.length > 0 ? (
                        policy.featureLinks.map((link) => (
                          <span
                            key={link.id}
                            className="inline-flex items-center rounded-full border bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground"
                            data-testid="config-policy-feature-badge"
                            data-feature-type={link.featureType}
                          >
                            {featureTypeLabel(link.featureType)}
                          </span>
                        ))
                      ) : policy.featureLinks ? (
                        // Present-but-empty: the endpoint answered, and the
                        // answer is "no features". Safe to say so out loud.
                        <span
                          className="text-muted-foreground"
                          data-testid="config-policy-features-empty"
                        >
                          <span aria-hidden="true">&mdash;</span>
                          <span className="sr-only">
                            {i18n.t("common:labels.none")}
                          </span>
                        </span>
                      ) : (
                        // Field absent — a web bundle running ahead of an api
                        // that doesn't send featureLinks yet (version skew is
                        // real here; see the droplet rollout notes). We do NOT
                        // know there are no features, so render the neutral
                        // em-dash and assert nothing to assistive tech.
                        <span
                          className="text-muted-foreground"
                          aria-hidden="true"
                          data-testid="config-policy-features-unknown"
                        >
                          &mdash;
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {formatDate(policy.updatedAt)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => onEdit?.(policy)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
                        title={editLabel}
                        aria-label={`${editLabel}: ${policy.name}`}
                        data-testid="config-policy-edit-button"
                      >
                        <Pencil className="h-4 w-4" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onDelete?.(policy)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md border text-destructive hover:bg-destructive/10"
                        title={deleteLabel}
                        aria-label={`${deleteLabel}: ${policy.name}`}
                        data-testid="config-policy-delete-button"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </div>
                  </td>
                </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {i18n.t("policies:configurationPolicies.configPolicyList.page")}
            {safePage}
            {i18n.t("policies:configurationPolicies.configPolicyList.of2")}
            {totalPages}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onPageChange?.(Math.max(safePage - 1, 1))}
              disabled={safePage === 1}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border disabled:opacity-50"
              title={previousPageLabel}
              aria-label={previousPageLabel}
              data-testid="config-policy-prev-page"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => onPageChange?.(Math.min(safePage + 1, totalPages))}
              disabled={safePage === totalPages}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border disabled:opacity-50"
              title={nextPageLabel}
              aria-label={nextPageLabel}
              data-testid="config-policy-next-page"
            >
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
