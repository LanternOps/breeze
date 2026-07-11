import { useState, useEffect, useCallback, useRef } from "react";
import { Plus, Trash2, Search, ChevronDown, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import { extractApiError } from "@/lib/apiError";
import { fetchWithAuth } from "../../stores/auth";
import { DEVICE_ROLES, getDeviceRoleLabel } from "@/lib/deviceRoles";
import HelpTooltip from "../shared/HelpTooltip";
import OrganizationScopePanel from "./OrganizationScopePanel";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
type Assignment = {
  id: string;
  level: string;
  targetId: string;
  priority: number;
  roleFilter?: string[] | null;
  osFilter?: string[] | null;
};
type TargetOption = {
  id: string;
  name: string;
  extra?: string;
};
// Org-owned policies can only narrow within their owning org. The Partner-Wide
// level is intentionally absent here — assigning an org-owned policy partner-wide
// is a footgun (resolution still clamps it to the one owning org), so the API
// rejects it and the picker must not offer it. Partner-OWNED policies are a
// reusable library (#2280) — assignment scope (all orgs or a subset) is handled
// by the dedicated OrganizationScopePanel below, not this level picker.
const orgOwnedAssignmentLevels = [
  { value: "organization", label: i18n.t("common:labels.organization") },
  { value: "site", label: i18n.t("common:labels.site") },
  {
    value: "device_group",
    label: i18n.t("policies:configurationPolicies.assignmentsTab.deviceGroup"),
  },
  { value: "device", label: i18n.t("common:labels.device") },
];
const osFilterOptions = [
  {
    value: "windows",
    label: i18n.t("policies:configurationPolicies.assignmentsTab.windows"),
  },
  {
    value: "macos",
    label: i18n.t("policies:configurationPolicies.assignmentsTab.macOS"),
  },
  {
    value: "linux",
    label: i18n.t("policies:configurationPolicies.assignmentsTab.linux"),
  },
];
function getOsLabel(value: string): string {
  return osFilterOptions.find((o) => o.value === value)?.label ?? value;
}
type Props = {
  policyId: string;
  // null for partner-owned ("all organizations") policies.
  orgId: string | null;
  // Owning org's name (org-owned policies only) — shown in the locked
  // organization-level target field.
  orgName?: string | null;
  // Set when the policy is partner-OWNED (a reusable library, #2280). Drives
  // delegation to OrganizationScopePanel.
  partnerId?: string | null;
};
export default function AssignmentsTab({
  policyId,
  orgId,
  orgName,
  partnerId,
}: Props) {
  useTranslation("policies");
  const isPartnerOwned = !!partnerId;
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [assignmentsLoading, setAssignmentsLoading] = useState(false);
  const [error, setError] = useState<string>();
  // Only used by the org-owned assignment form below; partner-owned policies
  // delegate to OrganizationScopePanel before this state is ever rendered.
  const [newLevel, setNewLevel] = useState(
    isPartnerOwned ? "partner" : "organization",
  );
  const [newTargetId, setNewTargetId] = useState("");
  const [newPriority, setNewPriority] = useState("0");
  const [newRoleFilter, setNewRoleFilter] = useState<string[]>([]);
  const [newOsFilter, setNewOsFilter] = useState<string[]>([]);
  const [addingAssignment, setAddingAssignment] = useState(false);
  // Target picker state
  const [targetOptions, setTargetOptions] = useState<TargetOption[]>([]);
  const [targetSearch, setTargetSearch] = useState("");
  const [targetDropdownOpen, setTargetDropdownOpen] = useState(false);
  const [loadingTargets, setLoadingTargets] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // Cache resolved target names for the assignments table
  const [targetNameCache, setTargetNameCache] = useState<
    Record<string, string>
  >({});
  const attemptedIdsRef = useRef(new Set<string>());
  const fetchAssignments = useCallback(async () => {
    if (!policyId) return;
    try {
      setAssignmentsLoading(true);
      const response = await fetchWithAuth(
        `/configuration-policies/${policyId}/assignments`,
      );
      if (!response.ok) {
        const errBody = await response.json().catch(() => null);
        throw new Error(
          extractApiError(
            errBody,
            i18n.t(
              "policies:configurationPolicies.assignmentsTab.failedToFetchAssignments",
            ),
          ),
        );
      }
      const data = await response.json();
      setAssignments(Array.isArray(data.data) ? data.data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setAssignmentsLoading(false);
    }
  }, [policyId]);
  useEffect(() => {
    fetchAssignments();
  }, [fetchAssignments]);
  // Fetch target options when level changes
  const fetchTargetOptions = useCallback(
    async (level: string) => {
      // Partner-Wide (All Orgs) needs no target picker: the partner is derived
      // server-side from the caller's own partner_id (#1724). Listing partners
      // (the old `/orgs/partners` call) requires system scope and 403s for a
      // normal MSP user, so we must NOT call it here.
      if (level === "partner") {
        setTargetOptions([]);
        setLoadingTargets(false);
        return;
      }
      setLoadingTargets(true);
      setTargetOptions([]);
      // Every target level here is scoped to the owning org. This branch is only
      // reached for org-owned policies (partner-owned uses the no-picker flow),
      // which always have an orgId — but guard rather than interpolate
      // `orgId=null` into the URL if the ownership invariant is ever violated.
      if (!orgId) {
        setLoadingTargets(false);
        setError(
          i18n.t(
            "policies:configurationPolicies.assignmentsTab.thisPolicyHasNoOrganizationSoAssignment",
          ),
        );
        return;
      }
      // Organization level: an org-owned policy can only be assigned to its own
      // org, so there's nothing to pick — lock the target to the owning org.
      if (level === "organization") {
        const name = orgName || orgId;
        setTargetOptions([{ id: orgId, name }]);
        setTargetNameCache((prev) => ({ ...prev, [orgId]: name }));
        setNewTargetId(orgId);
        setLoadingTargets(false);
        return;
      }
      const endpointMap: Record<string, string> = {
        site: `/orgs/sites?orgId=${orgId}&limit=200`,
        device_group: `/device-groups?orgId=${orgId}&limit=200`,
        device: `/devices?orgId=${orgId}&limit=200`,
      };
      try {
        const url = endpointMap[level];
        if (!url) return;
        const res = await fetchWithAuth(url);
        if (!res.ok) {
          const errBody = await res.json().catch(() => null);
          throw new Error(
            extractApiError(
              errBody,
              i18n.t("policies:configurationPolicies.assignmentsTab.failedToLoadTargetsHttp", { status: res.status }),
            ),
          );
        }
        const data = await res.json();
        const items = Array.isArray(data.data)
          ? data.data
          : Array.isArray(data)
            ? data
            : [];
        const options: TargetOption[] = items.map((item: any) => ({
          id: item.id,
          name: item.hostname || item.name || item.id,
          extra: level === "device" ? item.siteName : undefined,
        }));
        setTargetOptions(options);
        setTargetNameCache((prev) => {
          const next = { ...prev };
          options.forEach((o) => {
            next[o.id] = o.name;
          });
          return next;
        });
      } catch (err) {
        setTargetOptions([]);
        setError(err instanceof Error ? err.message : "Failed to load targets");
      } finally {
        setLoadingTargets(false);
      }
    },
    [orgId, orgName],
  );
  useEffect(() => {
    // Reset BEFORE fetching — the organization branch of fetchTargetOptions
    // pre-selects the owning org synchronously and must not be cleared.
    setNewTargetId("");
    setTargetSearch("");
    fetchTargetOptions(newLevel);
  }, [newLevel, fetchTargetOptions]);
  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setTargetDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);
  // Resolve target names for existing assignments (skip already-attempted IDs).
  // Partner rows are rendered as "All Organizations" without a lookup — the
  // old `/partners/:id` path is system-scoped and 403s for MSP users (#1724).
  useEffect(() => {
    const missing = assignments.filter(
      (a) =>
        a.level !== "partner" &&
        !targetNameCache[a.targetId] &&
        !attemptedIdsRef.current.has(a.targetId),
    );
    if (missing.length === 0) return;
    missing.forEach((a) => attemptedIdsRef.current.add(a.targetId));
    const levelEndpoint: Record<string, string> = {
      organization: "/organizations",
      site: "/sites",
      device: "/devices",
      device_group: "/devices/groups",
    };
    const resolveAll = async () => {
      const resolved: Record<string, string> = {};
      await Promise.all(
        missing.map(async (a) => {
          try {
            const base = levelEndpoint[a.level];
            if (!base) return;
            const res = await fetchWithAuth(`${base}/${a.targetId}`);
            if (!res.ok) return;
            const d = await res.json();
            resolved[a.targetId] = d.hostname || d.name || a.targetId;
          } catch {
            /* skip */
          }
        }),
      );
      if (Object.keys(resolved).length > 0) {
        setTargetNameCache((prev) => ({ ...prev, ...resolved }));
      }
    };
    resolveAll();
  }, [assignments]);
  const filteredOptions = targetOptions.filter((o) => {
    const q = targetSearch.toLowerCase();
    return (
      o.name.toLowerCase().includes(q) ||
      o.id.toLowerCase().includes(q) ||
      (o.extra && o.extra.toLowerCase().includes(q))
    );
  });
  const selectedTargetName =
    targetOptions.find((o) => o.id === newTargetId)?.name ||
    targetNameCache[newTargetId] ||
    "";
  const handleSelectTarget = (id: string) => {
    setNewTargetId(id);
    setTargetDropdownOpen(false);
    setTargetSearch("");
  };
  const isPartnerLevel = newLevel === "partner";
  const handleAddAssignment = async () => {
    // Partner-Wide needs no target; the server derives it (#1724).
    if (!policyId || (!isPartnerLevel && !newTargetId.trim())) return;
    setAddingAssignment(true);
    setError(undefined);
    try {
      const response = await fetchWithAuth(
        `/configuration-policies/${policyId}/assignments`,
        {
          method: "POST",
          body: JSON.stringify({
            level: newLevel,
            // Omit targetId entirely for Partner-Wide — the server uses the
            // caller's / policy's own partner_id and ignores any client value.
            ...(isPartnerLevel ? {} : { targetId: newTargetId.trim() }),
            priority: Number(newPriority) || 0,
            ...(newRoleFilter.length > 0 ? { roleFilter: newRoleFilter } : {}),
            ...(newOsFilter.length > 0 ? { osFilter: newOsFilter } : {}),
          }),
        },
      );
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(
          extractApiError(
            data,
            i18n.t(
              "policies:configurationPolicies.assignmentsTab.failedToAddAssignment",
            ),
          ),
        );
      }
      setNewTargetId("");
      setNewPriority("0");
      setNewRoleFilter([]);
      setNewOsFilter([]);
      await fetchAssignments();
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setAddingAssignment(false);
    }
  };
  const handleRemoveAssignment = async (aid: string) => {
    setError(undefined);
    try {
      const response = await fetchWithAuth(
        `/configuration-policies/${policyId}/assignments/${aid}`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        const errBody = await response.json().catch(() => null);
        throw new Error(
          extractApiError(
            errBody,
            i18n.t(
              "policies:configurationPolicies.assignmentsTab.failedToRemoveAssignment",
            ),
          ),
        );
      }
      await fetchAssignments();
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    }
  };
  // Role + OS filter pickers — shared by the org-owned and partner-wide add cards.
  const filterFields = (
    <div className="grid gap-4 sm:grid-cols-2">
      <div>
        <label className="text-sm font-medium">
          {i18n.t("policies:configurationPolicies.assignmentsTab.roleFilter")}
          <span className="text-xs text-muted-foreground">
            {i18n.t("policies:configurationPolicies.assignmentsTab.optional")}
          </span>
          <HelpTooltip
            text={i18n.t(
              "policies:configurationPolicies.assignmentsTab.restrictThisAssignmentToDevicesWithSpecific",
            )}
          />
        </label>
        <div className="mt-2 flex flex-wrap gap-2 rounded-md border bg-background p-2 min-h-10">
          {DEVICE_ROLES.map((role) => {
            const isSelected = newRoleFilter.includes(role);
            return (
              <button
                key={role}
                type="button"
                onClick={() => {
                  setNewRoleFilter((prev) =>
                    isSelected
                      ? prev.filter((r) => r !== role)
                      : [...prev, role],
                  );
                }}
                className={cn(
                  "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium transition",
                  isSelected
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-muted bg-muted/30 text-muted-foreground hover:bg-muted/60",
                )}
              >
                {getDeviceRoleLabel(role)}
              </button>
            );
          })}
        </div>
        {newRoleFilter.length === 0 && (
          <p className="mt-1 text-xs text-muted-foreground">
            {i18n.t(
              "policies:configurationPolicies.assignmentsTab.noRestrictionAppliesToAllDeviceRoles",
            )}
          </p>
        )}
      </div>
      <div>
        <label className="text-sm font-medium">
          {i18n.t("policies:configurationPolicies.assignmentsTab.oSFilter")}
          <span className="text-xs text-muted-foreground">
            {i18n.t("policies:configurationPolicies.assignmentsTab.optional2")}
          </span>
        </label>
        <div className="mt-2 flex flex-wrap gap-2 rounded-md border bg-background p-2 min-h-10">
          {osFilterOptions.map((os) => {
            const isSelected = newOsFilter.includes(os.value);
            return (
              <button
                key={os.value}
                type="button"
                onClick={() => {
                  setNewOsFilter((prev) =>
                    isSelected
                      ? prev.filter((o) => o !== os.value)
                      : [...prev, os.value],
                  );
                }}
                className={cn(
                  "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium transition",
                  isSelected
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-muted bg-muted/30 text-muted-foreground hover:bg-muted/60",
                )}
              >
                {os.label}
              </button>
            );
          })}
        </div>
        {newOsFilter.length === 0 && (
          <p className="mt-1 text-xs text-muted-foreground">
            {i18n.t(
              "policies:configurationPolicies.assignmentsTab.noRestrictionAppliesToAllOperatingSystems",
            )}
          </p>
        )}
      </div>
    </div>
  );
  const priorityField = (
    <div>
      <label className="text-sm font-medium">
        {i18n.t("policies:configurationPolicies.assignmentsTab.priority")}
        <HelpTooltip
          text={i18n.t(
            "policies:configurationPolicies.assignmentsTab.lowerValuesOverrideHigherOnesWhenMultiple",
          )}
        />
      </label>
      <input
        type="number"
        min={0}
        max={1000}
        value={newPriority}
        onChange={(e) => setNewPriority(e.target.value)}
        className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
      />
    </div>
  );
  const renderAssignmentsList = () => (
    <div className="rounded-lg border bg-card p-6 shadow-xs">
      <h2 className="text-lg font-semibold">
        {i18n.t(
          "policies:configurationPolicies.assignmentsTab.currentAssignments",
        )}
      </h2>
      {assignmentsLoading ? (
        <div className="flex items-center justify-center py-8">
          <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      ) : assignments.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">
          {i18n.t(
            "policies:configurationPolicies.assignmentsTab.noAssignmentsYetAssignThisPolicyTo",
          )}
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-md border">
          <table className="min-w-full divide-y">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">
                  {i18n.t(
                    "policies:configurationPolicies.assignmentsTab.level",
                  )}
                </th>
                <th className="px-4 py-3">
                  {i18n.t(
                    "policies:configurationPolicies.assignmentsTab.target",
                  )}
                </th>
                <th className="px-4 py-3">
                  {i18n.t(
                    "policies:configurationPolicies.assignmentsTab.priority2",
                  )}
                </th>
                <th className="px-4 py-3">
                  {i18n.t(
                    "policies:configurationPolicies.assignmentsTab.filters",
                  )}
                </th>
                <th className="px-4 py-3 text-right">
                  {i18n.t("common:labels.actions")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {assignments.map((assignment) => (
                <tr key={assignment.id} className="text-sm">
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center rounded-full border bg-muted/50 px-2.5 py-1 text-xs font-medium capitalize">
                      {assignment.level.replace("_", " ")}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div>
                      {assignment.level === "partner" ? (
                        <span className="font-medium">
                          {i18n.t(
                            "policies:configurationPolicies.assignmentsTab.allOrganizations",
                          )}
                        </span>
                      ) : targetNameCache[assignment.targetId] ? (
                        <>
                          <span className="font-medium">
                            {targetNameCache[assignment.targetId]}
                          </span>
                          <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                            {assignment.targetId.slice(0, 8)}
                          </span>
                        </>
                      ) : (
                        <span className="font-mono text-xs text-muted-foreground">
                          {assignment.targetId}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {assignment.priority}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {(!assignment.roleFilter ||
                        assignment.roleFilter.length === 0) &&
                        (!assignment.osFilter ||
                          assignment.osFilter.length === 0) && (
                          <span className="text-xs text-muted-foreground">
                            {i18n.t(
                              "policies:configurationPolicies.assignmentsTab.allDevices",
                            )}
                          </span>
                        )}
                      {assignment.roleFilter &&
                        assignment.roleFilter.length > 0 &&
                        assignment.roleFilter.map((role) => (
                          <span
                            key={role}
                            className="inline-flex items-center rounded-full border border-purple-500/40 bg-purple-500/10 px-2 py-0.5 text-xs font-medium text-purple-700"
                          >
                            {getDeviceRoleLabel(role)}
                          </span>
                        ))}
                      {assignment.osFilter &&
                        assignment.osFilter.length > 0 &&
                        assignment.osFilter.map((os) => (
                          <span
                            key={os}
                            className="inline-flex items-center rounded-full border border-blue-500/40 bg-blue-500/10 px-2 py-0.5 text-xs font-medium text-blue-700"
                          >
                            {getOsLabel(os)}
                          </span>
                        ))}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={() => handleRemoveAssignment(assignment.id)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md border text-destructive hover:bg-destructive/10"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
  // Partner-OWNED policies ("all organizations" library, #2280): scoping is a
  // subset of the partner's organizations, not a fixed all-orgs assignment —
  // delegate to the dedicated master-toggle + org-checklist panel. The
  // advanced site/group/device flow below remains reachable only for
  // org-owned policies.
  if (isPartnerOwned && partnerId) {
    return <OrganizationScopePanel policyId={policyId} partnerId={partnerId} />;
  }
  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Add Assignment Form */}
      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <h2 className="text-lg font-semibold">
          {i18n.t(
            "policies:configurationPolicies.assignmentsTab.addAssignment",
          )}
        </h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <div>
            <label className="text-sm font-medium">
              {i18n.t("policies:configurationPolicies.assignmentsTab.level2")}
              <HelpTooltip
                text={i18n.t(
                  "policies:configurationPolicies.assignmentsTab.scopeOfTheAssignmentMoreSpecificLevels",
                )}
              />
            </label>
            <select
              value={newLevel}
              onChange={(e) => setNewLevel(e.target.value)}
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            >
              {orgOwnedAssignmentLevels.map((level) => (
                <option key={level.value} value={level.value}>
                  {level.label}
                </option>
              ))}
            </select>
          </div>
          {newLevel === "organization" ? (
            <div>
              <label className="text-sm font-medium">
                {i18n.t(
                  "policies:configurationPolicies.assignmentsTab.target2",
                )}
                <HelpTooltip
                  text={i18n.t(
                    "policies:configurationPolicies.assignmentsTab.anOrganizationPolicyAlwaysTargetsItsOwn",
                  )}
                />
              </label>
              <div
                className="mt-2 flex h-10 w-full items-center gap-2 rounded-md border bg-muted/40 px-3 text-sm"
                data-testid="locked-org-target"
              >
                <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">
                  {selectedTargetName ||
                    orgName ||
                    i18n.t(
                      "policies:configurationPolicies.assignmentsTab.thisOrganization",
                    )}
                </span>
              </div>
            </div>
          ) : (
            <div ref={dropdownRef} className="relative">
              <label className="text-sm font-medium">
                {i18n.t(
                  "policies:configurationPolicies.assignmentsTab.target3",
                )}
              </label>
              <button
                type="button"
                onClick={() => setTargetDropdownOpen(!targetDropdownOpen)}
                className="mt-2 flex h-10 w-full items-center justify-between rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              >
                <span
                  className={cn(
                    selectedTargetName
                      ? "text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {selectedTargetName ||
                    (loadingTargets
                      ? i18n.t(
                          "policies:configurationPolicies.assignmentsTab.loading",
                        )
                      : i18n.t(
                          "policies:configurationPolicies.assignmentsTab.selectATarget",
                        ))}
                </span>
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              </button>
              {targetDropdownOpen && (
                <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-lg">
                  <div className="flex items-center border-b px-3 py-2">
                    <Search className="mr-2 h-4 w-4 text-muted-foreground" />
                    <input
                      value={targetSearch}
                      onChange={(e) => setTargetSearch(e.target.value)}
                      placeholder={i18n.t(
                        "policies:configurationPolicies.assignmentsTab.search",
                      )}
                      className="w-full bg-transparent text-sm outline-hidden placeholder:text-muted-foreground"
                      autoFocus
                    />
                  </div>
                  <div className="max-h-60 overflow-y-auto py-1">
                    {loadingTargets ? (
                      <div className="flex items-center justify-center py-4">
                        <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                        <span className="ml-2 text-sm text-muted-foreground">
                          {i18n.t(
                            "policies:configurationPolicies.assignmentsTab.loading",
                          )}
                        </span>
                      </div>
                    ) : filteredOptions.length === 0 ? (
                      <div className="px-3 py-4 text-center text-sm text-muted-foreground">
                        {targetOptions.length === 0
                          ? i18n.t(
                              "policies:configurationPolicies.assignmentsTab.noTargetsAvailable",
                            )
                          : i18n.t(
                              "policies:configurationPolicies.assignmentsTab.noMatchesFound",
                            )}
                      </div>
                    ) : (
                      filteredOptions.map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          onClick={() => handleSelectTarget(option.id)}
                          className={cn(
                            "flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-accent",
                            option.id === newTargetId && "bg-accent",
                          )}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-medium">
                              {option.name}
                            </div>
                            {option.extra && (
                              <div className="truncate text-xs text-muted-foreground">
                                {option.extra}
                              </div>
                            )}
                          </div>
                          <span className="ml-2 shrink-0 font-mono text-[10px] text-muted-foreground">
                            {option.id.slice(0, 8)}
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
          {priorityField}
        </div>
        <div className="mt-4">{filterFields}</div>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={handleAddAssignment}
            disabled={addingAssignment || !newTargetId.trim()}
            className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            {addingAssignment
              ? i18n.t(
                  "policies:configurationPolicies.assignmentsTab.assigning",
                )
              : i18n.t("policies:configurationPolicies.assignmentsTab.assign")}
          </button>
        </div>
      </div>

      {renderAssignmentsList()}
    </div>
  );
}
