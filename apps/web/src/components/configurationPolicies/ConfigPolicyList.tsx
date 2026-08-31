import { useEffect, useMemo, useState } from "react";
import {
  Layers,
  Search,
  ChevronLeft,
  ChevronRight,
  Pencil,
  Trash2,
  Building2,} from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
import { FEATURE_META, type FeatureType } from "./featureTabs/types";
export type ConfigPolicyStatus = "active" | "inactive" | "archived";
export type ConfigPolicy = {
  id: string;
  name: string;
  description?: string;
  status: ConfigPolicyStatus;
  // null = partner-wide ("All organizations") policy (#1724)
  orgId: string | null;
  partnerId?: string | null;
  // Owning org's name, joined in by the list API for org-owned policies.
  orgName?: string | null;
  createdAt?: string;
  updatedAt?: string;
  featureLinks?: {
    id: string;
    featureType: string;
  }[];
};
type ConfigPolicyListProps = {
  policies: ConfigPolicy[];
  onEdit?: (policy: ConfigPolicy) => void;
  onDelete?: (policy: ConfigPolicy) => void;
  pageSize?: number;
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
function formatDate(dateString?: string): string {
  if (!dateString) return "\u2014";
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleDateString();
}
export default function ConfigPolicyList({
  policies,
  onEdit,
  onDelete,
  pageSize = 10,
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
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [currentPage, setCurrentPage] = useState(1);
  const filteredPolicies = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return policies.filter((policy) => {
      const matchesQuery =
        normalizedQuery.length === 0 ||
        policy.name.toLowerCase().includes(normalizedQuery);
      const matchesStatus =
        statusFilter === "all" || policy.status === statusFilter;
      return matchesQuery && matchesStatus;
    });
  }, [policies, query, statusFilter]);
  // "No results" and "nothing exists yet" are different states and need
  // different copy. Keyed off the UNFILTERED list plus the search and status
  // controls being at rest, so a search that happens to match nothing still
  // gets the adjust-your-search message.
  //
  // Deliberately NOT a claim that the tenant is new: the list can be
  // org-scoped, and a malformed HTTP 200 is coerced to [] upstream. It only
  // distinguishes "the list is empty and the filters are untouched".
  const hasNoPoliciesAtAll =
    policies.length === 0 && query.trim().length === 0 && statusFilter === "all";
  // Floor of 1 so an empty list reads as Page 1 of 1 rather than Page 1 of 0,
  // and `safePage` below cannot land on 0. (The negative `startIndex` that a
  // page of 0 produces is harmless against an empty array — it is the page
  // COUNT that would be wrong, and it is what the pager renders.)
  const totalPages = Math.max(1, Math.ceil(filteredPolicies.length / pageSize));
  // Render from a clamped page rather than trusting the stored one. Search and
  // status changes reset the page, but nothing reconciled it with the row
  // count, so deleting the only row on the last page (the page refetches and
  // hands down a shorter array) left the user on a page that no longer exists:
  // no rows, the adjust-your-search copy over an untouched search box, and —
  // because `totalPages` had dropped below the stored page — no pager to get
  // back (#4008). Clamping during render rather than in an effect means the
  // dead page never paints.
  const safePage = Math.min(currentPage, totalPages);
  const startIndex = (safePage - 1) * pageSize;
  const paginatedPolicies = filteredPolicies.slice(
    startIndex,
    startIndex + pageSize,
  );
  // Retire the out-of-range value so it cannot come back. Without this the
  // clamp above is purely cosmetic: a later create + refetch that grows the
  // list past the stored page would teleport the user forward to a page they
  // had already been bounced off. Renders the same output either way, so it
  // costs a state write and no visible frame.
  useEffect(() => {
    if (currentPage !== safePage) setCurrentPage(safePage);
  }, [currentPage, safePage]);
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
          <p className="text-sm text-muted-foreground">
            {i18n.t("policies:configurationPolicies.configPolicyList.summary", {
              filtered: filteredPolicies.length,
              total: policies.length,
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
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setCurrentPage(1);
              }}
              className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-48"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(event) => {
              setStatusFilter(event.target.value);
              setCurrentPage(1);
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-36"
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
          </select>
        </div>
      </div>

      <div className="mt-6 overflow-x-auto rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">{i18n.t("common:labels.name")}</th>
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
                  colSpan={5}
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
              paginatedPolicies.map((policy) => (
                <tr
                  key={policy.id}
                  className="text-sm"
                  data-testid="config-policy-row"
                  data-policy-id={policy.id}
                >
                  <td className="px-4 py-3 font-medium text-foreground">
                    <div className="flex items-center gap-2">
                      <span>{policy.name}</span>
                      {policy.orgId === null && (
                        <span
                          className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                          title={i18n.t(
                            "policies:configurationPolicies.configPolicyList.partnerWidePolicyAppliesToEveryOrganization",
                          )}
                          data-testid="partner-wide-badge"
                        >
                          <Layers className="h-3 w-3" />
                          {i18n.t(
                            "policies:configurationPolicies.configPolicyList.allOrgs",
                          )}
                        </span>
                      )}
                      {policy.orgId !== null && (
                        <span
                          className="inline-flex items-center gap-1 rounded-full border bg-muted/60 px-2 py-0.5 text-xs font-medium text-muted-foreground"
                          title={i18n.t("policies:configurationPolicies.configPolicyList.organizationPolicyTitle", { organization: policy.orgName ?? i18n.t("policies:configurationPolicies.configPolicyList.itsOwningOrganization") })}
                          data-testid="org-badge"
                        >
                          <Building2 className="h-3 w-3" />
                          {policy.orgName ??
                            i18n.t("common:labels.organization")}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium",
                        statusConfig[policy.status].color,
                      )}
                    >
                      {statusConfig[policy.status].label}
                    </span>
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
              ))
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
              onClick={() => setCurrentPage(Math.max(safePage - 1, 1))}
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
              onClick={() => setCurrentPage(Math.min(safePage + 1, totalPages))}
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
