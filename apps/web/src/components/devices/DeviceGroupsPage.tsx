import {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
  type DragEvent,
  type FormEvent,
} from "react";
import { Plus, Pencil, Trash2, Shield, Play, X } from "lucide-react";
import { fetchWithAuth } from "@/stores/auth";
import { useFleetOrgOwner } from "@/hooks/useFleetOrgOwner";
import { asList } from "@/lib/asList";
import type { FilterConditionGroup } from "@breeze/shared";
import { FilterBuilder, DEFAULT_FILTER_FIELDS } from "../filters/FilterBuilder";
import { FilterPreview } from "../filters/FilterPreview";
import { useFilterPreview } from "../../hooks/useFilterPreview";
import {
  describeFilterConditions,
  legacyRulesToFilterConditions,
} from "./filterMigration";
import {
  deviceOsType,
  matchDeviceIds,
  type DeviceGroupRule,
} from "./deviceGroupMatching";
import { useTranslation } from "react-i18next";
import "../../lib/i18n";

type OSType = "windows" | "macos" | "linux";

/**
 * Whatever `/devices` returned. The list endpoint reports `osType` (never
 * `os`) and omits `siteName` entirely, so every field beyond `id` is optional
 * and read through a helper rather than dereferenced.
 */
type Device = {
  id: string;
  hostname?: string;
  osType?: OSType;
  /** Legacy alias this page used to assume; tolerated on read only. */
  os?: OSType;
  siteId?: string;
  siteName?: string;
  tags?: string[];
};

type GroupType = "static" | "dynamic";

type DeviceGroup = {
  id: string;
  name: string;
  type: GroupType;
  deviceCount?: number;
  deviceIds?: string[];
  devices?: Device[];
  /**
   * Legacy, read-only. The web app has not authored these since the
   * FilterBuilder landed — see `handleSubmitGroup`.
   */
  rules?: DeviceGroupRule[];
  filterConditions?: FilterConditionGroup | null;
  policyId?: string;
  policyName?: string;
  policy?: { id: string; name: string };
};

type Site = {
  id: string;
  name: string;
};

type Policy = {
  id: string;
  name: string;
};

type Script = {
  id: string;
  name: string;
};

type ModalMode =
  | "closed"
  | "create"
  | "edit"
  | "delete"
  | "bulk-script"
  | "bulk-policy";

type GroupFormState = {
  name: string;
  type: GroupType;
  deviceIds: string[];
  filterConditions: FilterConditionGroup;
};

type DragPayload = {
  deviceId: string;
  fromGroupId: string;
};

const osLabels: Record<OSType, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
};

/** OS label for a device, tolerating the missing/renamed OS field. */
const osLabel = (device: Device): string => {
  const os = deviceOsType(device);
  return osLabels[os as OSType] ?? os;
};

const normalizeGroup = (group: DeviceGroup): DeviceGroup => {
  const inferredType: GroupType =
    group.type ??
    (group.filterConditions || (group.rules && group.rules.length > 0)
      ? "dynamic"
      : "static");
  const policyId = group.policyId ?? group.policy?.id ?? "";
  const policyName = group.policyName ?? group.policy?.name ?? "";
  const deviceIds =
    group.deviceIds ?? group.devices?.map((device) => device.id) ?? [];

  return {
    ...group,
    type: inferredType,
    policyId,
    policyName,
    deviceIds,
  };
};

const buildRuleLabel = (
  rule: DeviceGroupRule,
  siteNameById: Map<string, string>,
): string => {
  const fieldLabel =
    rule.field === "os"
      ? "OS"
      : rule.field === "site"
        ? "Site"
        : rule.field === "tag"
          ? "Tag"
          : "Hostname";
  const operatorLabel =
    rule.operator === "is"
      ? "is"
      : rule.operator === "is_not"
        ? "is not"
        : rule.operator === "contains"
          ? "contains"
          : rule.operator === "not_contains"
            ? "does not contain"
            : rule.operator === "matches"
              ? "matches"
              : "does not match";

  const value =
    rule.field === "site"
      ? (siteNameById.get(rule.value) ?? rule.value)
      : rule.value;

  return `${fieldLabel} ${operatorLabel} ${value || "..."}`;
};

const parseDragPayload = (event: DragEvent): DragPayload | null => {
  const data = event.dataTransfer.getData("text/plain");
  if (!data) return null;
  try {
    const parsed = JSON.parse(data) as DragPayload;
    if (parsed?.deviceId && parsed?.fromGroupId) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
};

export default function DeviceGroupsPage() {
  const { t } = useTranslation("devices");
  const [groups, setGroups] = useState<DeviceGroup[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [scripts, setScripts] = useState<Script[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [modalMode, setModalMode] = useState<ModalMode>("closed");
  const [selectedGroup, setSelectedGroup] = useState<DeviceGroup | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string>();
  // All-orgs view injects no `?orgId=`, so a create needs an explicit owner org
  // (the server would otherwise reject it with "orgId is required").
  const fleet = useFleetOrgOwner();
  const EMPTY_FILTER: FilterConditionGroup = {
    operator: "AND",
    conditions: [{ field: "hostname", operator: "contains", value: "" }],
  };

  const [groupForm, setGroupForm] = useState<GroupFormState>({
    name: "",
    type: "static",
    deviceIds: [],
    filterConditions: EMPTY_FILTER,
  });
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(
    new Set(),
  );
  const [assignmentQuery, setAssignmentQuery] = useState("");
  // Membership on an existing static group is edited against the server's own
  // answer, not the list payload: the diff on save issues DELETEs, so a stale
  // baseline would drop rows the user never touched. `undefined` means "not
  // loaded yet" and keeps the chooser disabled (#3615).
  const [baselineDeviceIds, setBaselineDeviceIds] = useState<
    string[] | undefined
  >(undefined);
  const [membershipLoading, setMembershipLoading] = useState(false);
  const [membershipError, setMembershipError] = useState<string>();
  const membershipRequestId = useRef(0);
  const [bulkScriptId, setBulkScriptId] = useState("");
  const [bulkPolicyId, setBulkPolicyId] = useState("");
  const [deleteReassignGroupId, setDeleteReassignGroupId] = useState("");
  const [draggingDevice, setDraggingDevice] = useState<DragPayload | null>(
    null,
  );
  const [dragOverGroupId, setDragOverGroupId] = useState<string | null>(null);

  const {
    preview: formPreview,
    loading: formPreviewLoading,
    error: formPreviewError,
    refresh: formPreviewRefresh,
  } = useFilterPreview(
    groupForm.type === "dynamic" &&
      (modalMode === "create" || modalMode === "edit")
      ? groupForm.filterConditions
      : null,
    { enabled: true },
  );

  // The chooser is inert until the server's membership answer is in hand: an
  // unloaded or failed baseline makes every diff on save a guess.
  const membershipUnavailable =
    modalMode === "edit" &&
    groupForm.type === "static" &&
    (membershipLoading ||
      baselineDeviceIds === undefined ||
      Boolean(membershipError));

  const deviceById = useMemo(() => {
    return new Map(devices.map((device) => [device.id, device]));
  }, [devices]);

  const siteOptions = useMemo(() => {
    if (sites.length > 0) {
      return sites;
    }
    const seen = new Map<string, string>();
    devices.forEach((device) => {
      if (device.siteId && device.siteName) {
        seen.set(device.siteId, device.siteName);
      }
    });
    return Array.from(seen.entries()).map(([id, name]) => ({ id, name }));
  }, [devices, sites]);

  const siteNameById = useMemo(() => {
    return new Map(siteOptions.map((site) => [site.id, site.name]));
  }, [siteOptions]);

  const tagOptions = useMemo(() => {
    const tags = new Set<string>();
    devices.forEach((device) => {
      device.tags?.forEach((tag: string) => tags.add(tag));
    });
    return Array.from(tags).sort((a, b) => a.localeCompare(b));
  }, [devices]);

  const filteredAssignmentDevices = useMemo(() => {
    const query = assignmentQuery.trim().toLowerCase();
    if (!query) return devices;
    return devices.filter((device) => {
      const matchesHostname = String(device.hostname ?? "")
        .toLowerCase()
        .includes(query);
      const matchesTag = device.tags?.some((tag: string) =>
        String(tag ?? "")
          .toLowerCase()
          .includes(query),
      );
      return matchesHostname || matchesTag;
    });
  }, [assignmentQuery, devices]);

  const fetchGroups = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      // `includeMemberships` is what puts `deviceIds` on each row. Without it
      // every static group renders as empty and the drag-and-drop move is inert
      // (its source-membership guard can never pass).
      const response = await fetchWithAuth(
        "/device-groups?includeMemberships=true",
      );
      if (!response.ok) {
        throw new Error("Failed to fetch device groups");
      }
      const data = await response.json();
      const nextGroups = asList<DeviceGroup>(data, "groups").map(normalizeGroup);
      setGroups(nextGroups);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("deviceGroupsPage.failedToFetchDeviceGroups"),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchDevices = useCallback(async () => {
    try {
      const response = await fetchWithAuth("/devices");
      if (response.ok) {
        const data = await response.json();
        setDevices(asList<Device>(data, "devices"));
      }
    } catch {
      // Devices are optional for the page to render.
    }
  }, []);

  const fetchSites = useCallback(async () => {
    try {
      // Sites live under the orgs router (`/orgs/sites`) — a bare `/sites`
      // 404s, which this page swallowed silently.
      const response = await fetchWithAuth("/orgs/sites");
      if (response.ok) {
        const data = await response.json();
        setSites(asList<Site>(data, "sites"));
      }
    } catch {
      // Sites are optional and can be derived from device data.
    }
  }, []);

  const fetchPolicies = useCallback(async () => {
    try {
      const response = await fetchWithAuth("/policies");
      if (response.ok) {
        const data = await response.json();
        setPolicies(asList<Policy>(data, "policies"));
      }
    } catch {
      // Policies are optional for this page.
    }
  }, []);

  const fetchScripts = useCallback(async () => {
    try {
      const response = await fetchWithAuth("/scripts");
      if (response.ok) {
        const data = await response.json();
        setScripts(asList<Script>(data, "scripts"));
      }
    } catch {
      // Scripts are optional for this page.
    }
  }, []);

  useEffect(() => {
    fetchGroups();
    fetchDevices();
    fetchSites();
    fetchPolicies();
    fetchScripts();
  }, [fetchGroups, fetchDevices, fetchPolicies, fetchScripts, fetchSites]);

  useEffect(() => {
    setSelectedGroupIds((prev) => {
      const next = new Set<string>();
      groups.forEach((group) => {
        if (prev.has(group.id)) {
          next.add(group.id);
        }
      });
      return next;
    });
  }, [groups]);

  const resetForm = (group?: DeviceGroup) => {
    if (group) {
      // The filter is the authored representation. Legacy `rules` are only a
      // seed for groups that predate the FilterBuilder and have no filter yet.
      const filterConditions =
        group.filterConditions ??
        (group.rules && group.rules.length > 0
          ? legacyRulesToFilterConditions(group.rules)
          : EMPTY_FILTER);

      setGroupForm({
        name: group.name ?? "",
        type: group.type ?? "static",
        deviceIds: group.deviceIds
          ? [...group.deviceIds]
          : (group.devices?.map((device) => device.id) ?? []),
        filterConditions,
      });
    } else {
      setGroupForm({
        name: "",
        type: "static",
        deviceIds: [],
        filterConditions: EMPTY_FILTER,
      });
    }
    setAssignmentQuery("");
    setFormError(undefined);
  };

  /**
   * Current membership straight from the server.
   *
   * `GET /device-groups` only carries `deviceIds` when asked, and that copy is
   * as old as the last list refresh. The edit diff turns "absent from the
   * selection" into a DELETE, so the baseline it diffs against has to be the
   * authoritative one read at modal-open time.
   */
  const fetchGroupMembership = useCallback(
    async (groupId: string, options: { seedSelection?: boolean } = {}) => {
      const seedSelection = options.seedSelection ?? true;
      // Only the newest read may write state. Opening Edit on one group while
      // another group's read is still in flight would otherwise let the stale
      // response install ITS membership as this group's baseline — and the next
      // Save would diff one group's device list against another's, moving
      // devices between groups with no error shown.
      const requestId = ++membershipRequestId.current;
      const isCurrent = () => membershipRequestId.current === requestId;

      setMembershipLoading(seedSelection);
      setMembershipError(undefined);
      if (seedSelection) setBaselineDeviceIds(undefined);
      try {
        const response = await fetchWithAuth(
          `/device-groups/${groupId}/devices`,
        );
        if (!response.ok) {
          throw new Error(t("deviceGroupsPage.failedToLoadGroupMembership"));
        }
        const body = await response.json();
        const memberIds = asList<{ deviceId: string }>(body, "devices")
          .map((member) => member.deviceId)
          .filter((id): id is string => typeof id === "string");
        if (!isCurrent()) return;
        setBaselineDeviceIds(memberIds);
        // A re-sync after a failed save keeps the user's unsaved picks — only
        // the baseline they will be diffed against is refreshed.
        if (seedSelection) {
          setGroupForm((prev) => ({ ...prev, deviceIds: memberIds }));
        }
      } catch (err) {
        if (!isCurrent()) return;
        // Without a trustworthy baseline the chooser would misreport membership
        // and silently no-op on save — say so instead of rendering a lie.
        setMembershipError(
          err instanceof Error
            ? err.message
            : t("deviceGroupsPage.failedToLoadGroupMembership"),
        );
      } finally {
        if (isCurrent()) setMembershipLoading(false);
      }
    },
    [],
  );

  const handleOpenCreate = () => {
    setSelectedGroup(null);
    resetForm();
    // Start each create fresh — the hook is page-level, so a prior fleet pick
    // would otherwise linger across close/reopen.
    fleet.setOrgId("");
    setBaselineDeviceIds([]);
    setMembershipError(undefined);
    setMembershipLoading(false);
    setModalMode("create");
  };

  const handleOpenEdit = (group: DeviceGroup) => {
    setSelectedGroup(group);
    resetForm(group);
    setMembershipError(undefined);
    setModalMode("edit");
    if (group.type === "static") {
      void fetchGroupMembership(group.id);
    } else {
      // A dynamic group has no manual membership to diff against — its members
      // are the server's evaluation, not an authored list. If the user converts
      // it to static here, the chooser starts empty and every pick is an
      // addition; re-POSTing the evaluated set would forge manual memberships
      // the user never asked for.
      setBaselineDeviceIds([]);
      setGroupForm((prev) => ({ ...prev, deviceIds: [] }));
      setMembershipLoading(false);
    }
  };

  const handleOpenDelete = (group: DeviceGroup) => {
    setSelectedGroup(group);
    setDeleteReassignGroupId("");
    setModalMode("delete");
  };

  const handleCloseModal = () => {
    setModalMode("closed");
    setSelectedGroup(null);
    setFormError(undefined);
    setBulkScriptId("");
    setBulkPolicyId("");
    setDeleteReassignGroupId("");
    setBaselineDeviceIds(undefined);
    setMembershipError(undefined);
    setMembershipLoading(false);
  };

  const getGroupDeviceIds = (group: DeviceGroup): string[] => {
    if (group.type === "dynamic") {
      if (group.deviceIds && group.deviceIds.length > 0) {
        return group.deviceIds;
      }
      // A filter-authored group is the server's to evaluate — the legacy
      // matcher only understands four of the forty filter fields, so guessing
      // here would report a membership the server disagrees with.
      if (group.filterConditions) return [];
      return matchDeviceIds(devices, group.rules);
    }
    return group.deviceIds ?? group.devices?.map((device) => device.id) ?? [];
  };

  const getGroupDeviceCount = (group: DeviceGroup): number => {
    if (typeof group.deviceCount === "number") {
      return group.deviceCount;
    }
    return getGroupDeviceIds(group).length;
  };

  /**
   * Apply a membership change through the membership endpoints.
   *
   * Membership is NOT part of the group's definition: `PATCH /device-groups/:id`
   * has no `deviceIds` field, so folding membership into it is a write that
   * silently does nothing (#3554). Adds go to `POST /:id/devices` in one call;
   * removals are one `DELETE /:id/devices/:deviceId` each, because the API
   * offers no bulk-remove verb.
   */
  const applyMembershipChanges = async (
    groupId: string,
    change: { add: string[]; remove: string[] },
  ) => {
    const failed = async (response: Response) => {
      const body = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new Error(
        body?.error ?? t("deviceGroupsPage.failedToUpdateGroupMembership"),
      );
    };

    if (change.add.length > 0) {
      const response = await fetchWithAuth(`/device-groups/${groupId}/devices`, {
        method: "POST",
        body: JSON.stringify({ deviceIds: change.add }),
      });
      if (!response.ok) await failed(response);
    }

    for (const deviceId of change.remove) {
      const response = await fetchWithAuth(
        `/device-groups/${groupId}/devices/${deviceId}`,
        { method: "DELETE" },
      );
      if (!response.ok) await failed(response);
    }
  };

  const handleSubmitGroup = async (event: FormEvent) => {
    event.preventDefault();
    const trimmedName = groupForm.name.trim();
    if (!trimmedName) {
      setFormError("Group name is required.");
      return;
    }
    // A new group must land in one org; edits keep the group's existing owner.
    if (modalMode === "create" && fleet.needsOrgSelection) {
      setFormError(t("common:layout.orgRequired.title"));
      return;
    }
    if (groupForm.type === "dynamic") {
      const hasValidCondition = groupForm.filterConditions.conditions.some(
        (c) => {
          if ("conditions" in c) return true;
          return c.value !== "" && c.value !== null && c.value !== undefined;
        },
      );
      if (!hasValidCondition) {
        setFormError("Add at least one filter condition to a dynamic group.");
        return;
      }
    }

    setSubmitting(true);
    setFormError(undefined);

    try {
      // `filterConditions` is the only membership representation this form
      // authors. It deliberately does NOT send `rules`: the form has no legacy
      // rule editor, so anything it sent would be a fabricated stub — and the
      // page then rendered that stub as the group's membership while the
      // server evaluated the real filter. The server evaluates only
      // `filterConditions` (routes/groups.ts, services/groupMembership.ts);
      // `rules` is inert storage kept for pre-FilterBuilder rows.
      const isEdit = modalMode === "edit" && Boolean(selectedGroup);
      const isDynamic = groupForm.type === "dynamic";

      const payload: Record<string, unknown> = {
        name: trimmedName,
        type: groupForm.type,
      };

      // A create carries the concrete owner org in the body (the focused org, or
      // the fleet picker's choice); edits never move a group between orgs.
      if (!isEdit && fleet.bodyOrgId) {
        payload.orgId = fleet.bodyOrgId;
      }

      if (isDynamic) {
        payload.filterConditions = groupForm.filterConditions;
      } else if (isEdit) {
        // A static group carries no filter, and the two verbs want that said
        // differently (#3159). EDIT must send an explicit `null`, because the
        // update route reads `undefined` as "leave the filter alone"; omitting
        // it would strand a stale filter on a group converted from dynamic to
        // static. Membership is still NOT in this payload — the PATCH route has
        // no `deviceIds` field — but it is no longer dropped either: the chooser
        // is offered on edit and its diff goes to the membership endpoints
        // below (#3615).
        payload.filterConditions = null;
      } else {
        // Devices are only meaningful for a static group. The create route
        // rejects a non-empty list on a dynamic one rather than ignoring it.
        payload.deviceIds = groupForm.deviceIds;
      }

      const url = isEdit
        ? `/device-groups/${selectedGroup!.id}`
        : "/device-groups";
      // The update route is PATCH /:id — the frontend historically sent PUT,
      // which has no handler and 404s on every edit (#3554). Create stays POST.
      const method = isEdit ? "PATCH" : "POST";

      const response = await fetchWithAuth(url, {
        method,
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        // Surface the server's own message. The reporter of #3159 had to open
        // devtools to discover their create was failing validation, because
        // this branch threw a fixed string and dropped the response body.
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          body?.error ?? t("deviceGroupsPage.failedToSaveDeviceGroup"),
        );
      }

      // Membership rides its own endpoints, and only on edit — create already
      // carried `deviceIds` in the POST body. The group definition is saved
      // first so a dynamic→static conversion is committed before the membership
      // calls, which the API rejects on a dynamic group.
      if (isEdit && !isDynamic) {
        if (baselineDeviceIds === undefined) {
          // Membership never loaded. Diffing against a guessed baseline is how
          // a "Save" removes devices the user never deselected.
          throw new Error(t("deviceGroupsPage.failedToLoadGroupMembership"));
        }
        const baseline = baselineDeviceIds;
        const selected = groupForm.deviceIds;
        try {
          await applyMembershipChanges(selectedGroup!.id, {
            add: selected.filter((id) => !baseline.includes(id)),
            remove: baseline.filter((id) => !selected.includes(id)),
          });
        } catch (membershipErr) {
          // Removals are one call per device, so a failure can leave the group
          // half-applied. Re-read the baseline (keeping the user's picks) before
          // surfacing the error: a retry against the pre-save baseline would
          // re-DELETE an already-removed device, which the API 404s.
          await fetchGroupMembership(selectedGroup!.id, {
            seedSelection: false,
          });
          await fetchGroups();
          throw membershipErr;
        }
      }

      await fetchGroups();
      handleCloseModal();
    } catch (err) {
      setFormError(
        err instanceof Error
          ? err.message
          : t("deviceGroupsPage.failedToSaveDeviceGroup"),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!selectedGroup) return;
    setSubmitting(true);
    setFormError(undefined);
    try {
      const response = await fetchWithAuth(
        `/device-groups/${selectedGroup.id}`,
        {
          method: "DELETE",
          body: JSON.stringify({
            reassignGroupId: deleteReassignGroupId || null,
          }),
        },
      );

      if (!response.ok) {
        if (response.status === 409) {
          const body = await response.json().catch(() => null) as
            { contractCount?: number; contracts?: Array<{ name: string }> } | null;
          if (body?.contractCount) {
            const names = body.contracts?.map((contract) => contract.name).join(", ");
            throw new Error(names
              ? t("deviceGroupsPage.billedByContracts", { count: body.contractCount, names })
              : t("deviceGroupsPage.billedByContractsCount", { count: body.contractCount }));
          }
        }
        throw new Error(t("deviceGroupsPage.failedToDeleteGroup"));
      }

      await fetchGroups();
      handleCloseModal();
    } catch (err) {
      setFormError(
        err instanceof Error
          ? err.message
          : t("deviceGroupsPage.failedToDeleteGroup"),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleBulkScript = async () => {
    if (!bulkScriptId || selectedGroupIds.size === 0) return;
    setSubmitting(true);
    try {
      const response = await fetchWithAuth("/device-groups/bulk", {
        method: "POST",
        body: JSON.stringify({
          action: "run-script",
          scriptId: bulkScriptId,
          groupIds: Array.from(selectedGroupIds),
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to run script on groups");
      }

      await fetchGroups();
      setSelectedGroupIds(new Set());
      handleCloseModal();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("deviceGroupsPage.failedToRunScriptOnGroups"),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleBulkPolicy = async () => {
    if (!bulkPolicyId || selectedGroupIds.size === 0) return;
    setSubmitting(true);
    try {
      const response = await fetchWithAuth("/device-groups/bulk", {
        method: "POST",
        body: JSON.stringify({
          action: "apply-policy",
          policyId: bulkPolicyId,
          groupIds: Array.from(selectedGroupIds),
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to apply policy to groups");
      }

      await fetchGroups();
      setSelectedGroupIds(new Set());
      handleCloseModal();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("deviceGroupsPage.failedToApplyPolicyToGroups"),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleDropDevice = async (
    targetGroupId: string,
    payload: DragPayload | null,
  ) => {
    const dragPayload = payload ?? draggingDevice;
    if (!dragPayload) return;
    if (dragPayload.fromGroupId === targetGroupId) return;

    const sourceGroup = groups.find(
      (group) => group.id === dragPayload.fromGroupId,
    );
    const targetGroup = groups.find((group) => group.id === targetGroupId);
    if (!sourceGroup || !targetGroup) return;
    if (sourceGroup.type !== "static" || targetGroup.type !== "static") return;

    const sourceIds = sourceGroup.deviceIds ?? [];
    const targetIds = targetGroup.deviceIds ?? [];
    if (!sourceIds.includes(dragPayload.deviceId)) return;

    const nextSourceIds = sourceIds.filter((id) => id !== dragPayload.deviceId);
    const nextTargetIds = Array.from(
      new Set([...targetIds, dragPayload.deviceId]),
    );

    setGroups((prev) =>
      prev.map((group) => {
        if (group.id === sourceGroup.id) {
          return { ...group, deviceIds: nextSourceIds };
        }
        if (group.id === targetGroup.id) {
          return { ...group, deviceIds: nextTargetIds };
        }
        return group;
      }),
    );

    setDraggingDevice(null);
    setDragOverGroupId(null);

    try {
      // One device moves between two static groups: remove it there, add it
      // here. This used to go through a `PUT /device-groups/:id` that has no
      // handler at all (#3554) and carried a `deviceIds` the update route
      // ignores regardless — the optimistic state above was the only thing that
      // ever changed.
      await applyMembershipChanges(sourceGroup.id, {
        add: [],
        remove: [dragPayload.deviceId],
      });
      await applyMembershipChanges(targetGroup.id, {
        add: [dragPayload.deviceId],
        remove: [],
      });
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("deviceGroupsPage.failedToMoveDevice"),
      );
      await fetchGroups();
    }
  };

  const toggleGroupSelection = (groupId: string, checked: boolean) => {
    setSelectedGroupIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(groupId);
      } else {
        next.delete(groupId);
      }
      return next;
    });
  };

  const handleSelectAll = (checked: boolean) => {
    if (!checked) {
      setSelectedGroupIds(new Set());
      return;
    }
    setSelectedGroupIds(new Set(groups.map((group) => group.id)));
  };

  const allSelected =
    groups.length > 0 &&
    groups.every((group) => selectedGroupIds.has(group.id));

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">
            {t("deviceGroupsPage.loadingDeviceGroups")}
          </p>
        </div>
      </div>
    );
  }

  if (error && groups.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchGroups}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {t("deviceGroupsPage.tryAgain")}{" "}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {t("deviceGroupsPage.deviceGroups2")}
          </h1>
          <p className="text-muted-foreground">
            {t("deviceGroupsPage.organizeDevicesIntoStaticAndDynamic")}{" "}
          </p>
        </div>
        <button
          type="button"
          onClick={handleOpenCreate}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          {t("deviceGroupsPage.createGroup")}{" "}
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {selectedGroupIds.size > 0 && (
        <div className="flex flex-col gap-3 rounded-md border bg-muted/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm font-medium">
            {selectedGroupIds.size} {t("deviceGroupsPage.group")}
            {selectedGroupIds.size === 1 ? "" : t("deviceGroupsPage.s")}{" "}
            {t("deviceGroupsPage.selected")}{" "}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setModalMode("bulk-script")}
              className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium transition hover:bg-muted"
            >
              <Play className="h-4 w-4" />
              {t("deviceGroupsPage.runScript")}{" "}
            </button>
            <button
              type="button"
              onClick={() => setModalMode("bulk-policy")}
              className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium transition hover:bg-muted"
            >
              <Shield className="h-4 w-4" />
              {t("deviceGroupsPage.applyPolicy")}{" "}
            </button>
            <button
              type="button"
              onClick={() => setSelectedGroupIds(new Set())}
              className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium text-muted-foreground transition hover:bg-muted"
            >
              {t("deviceGroupsPage.clearSelection")}{" "}
            </button>
          </div>
        </div>
      )}

      {groups.length === 0 ? (
        <div className="rounded-lg border bg-card p-6 text-center">
          <p className="text-sm text-muted-foreground">
            {t("deviceGroupsPage.noDeviceGroupsYetCreateOne")}{" "}
          </p>
          <button
            type="button"
            onClick={handleOpenCreate}
            className="mt-4 inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            {t("deviceGroupsPage.createYourFirstGroup")}{" "}
          </button>
        </div>
      ) : (
        <div className="rounded-lg border bg-card p-6 shadow-xs space-y-4">
          <div className="flex items-center gap-3 text-sm font-medium text-muted-foreground">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={(event) => handleSelectAll(event.target.checked)}
              className="h-4 w-4 rounded border-muted text-primary focus:ring-primary"
            />
            {t("deviceGroupsPage.selectAllGroups")}{" "}
          </div>
          <div className="space-y-4">
            {groups.map((group) => {
              const deviceIds = getGroupDeviceIds(group);
              const groupDevices = deviceIds
                .map((id) => deviceById.get(id))
                .filter((device): device is Device => Boolean(device));
              const deviceCount = getGroupDeviceCount(group);
              // Describe what the server actually evaluates. Legacy `rules`
              // are only shown for rows that have no filter — otherwise a
              // stale stub would misreport the group's membership.
              const membershipChips = group.filterConditions
                ? describeFilterConditions(group.filterConditions)
                : (group.rules ?? []).map((rule) =>
                    buildRuleLabel(rule, siteNameById),
                  );
              const isSelected = selectedGroupIds.has(group.id);
              const isDragOver = dragOverGroupId === group.id;

              return (
                <div
                  key={group.id}
                  className="rounded-lg border bg-background p-4"
                >
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="flex gap-3">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={(event) =>
                          toggleGroupSelection(group.id, event.target.checked)
                        }
                        className="mt-1 h-4 w-4 rounded border-muted text-primary focus:ring-primary"
                      />
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <h2 className="text-lg font-semibold">
                            {group.name}
                          </h2>
                          <span className="rounded-full border bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                            {group.type === "dynamic"
                              ? t("deviceGroupsPage.dynamic")
                              : t("deviceGroupsPage.static")}
                          </span>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
                          <span className="rounded-full border bg-muted px-2 py-0.5">
                            {deviceCount} {t("deviceGroupsPage.device")}
                            {deviceCount === 1 ? "" : t("deviceGroupsPage.s")}
                          </span>
                          <span className="rounded-full border bg-muted px-2 py-0.5">
                            {t("deviceGroupsPage.policy")}{" "}
                            {group.policyName || "Not assigned"}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleOpenEdit(group)}
                        className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium transition hover:bg-muted"
                      >
                        <Pencil className="h-4 w-4" />
                        {t("deviceGroupsPage.edit")}{" "}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleOpenDelete(group)}
                        className="inline-flex h-9 items-center gap-2 rounded-md border border-destructive/40 px-3 text-sm font-medium text-destructive transition hover:bg-destructive/10"
                      >
                        <Trash2 className="h-4 w-4" />
                        {t("deviceGroupsPage.delete")}{" "}
                      </button>
                    </div>
                  </div>

                  {group.type === "dynamic" ? (
                    <div className="mt-4 rounded-md border bg-muted/20 p-4">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-medium">
                          {t("deviceGroupsPage.autoMembershipRules")}
                        </p>
                        <span className="text-xs text-muted-foreground">
                          {t("deviceGroupsPage.matches")} {deviceCount}{" "}
                          {t("deviceGroupsPage.device")}
                          {deviceCount === 1 ? "" : t("deviceGroupsPage.s")}
                        </span>
                      </div>
                      {membershipChips.length > 0 ? (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {membershipChips.map((chip, index) => (
                            <span
                              key={`${group.id}-chip-${index}`}
                              className="rounded-full border bg-background px-3 py-1 text-xs text-muted-foreground"
                            >
                              {chip}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <p className="mt-2 text-xs text-muted-foreground">
                          {t("deviceGroupsPage.noRulesDefined")}
                        </p>
                      )}
                    </div>
                  ) : (
                    <div
                      className={`mt-4 rounded-md border border-dashed p-4 transition ${
                        isDragOver
                          ? "border-primary/60 bg-primary/5"
                          : "border-muted-foreground/30 bg-muted/20"
                      }`}
                      onDragOver={(event) => {
                        if (draggingDevice?.fromGroupId === group.id) return;
                        event.preventDefault();
                        setDragOverGroupId(group.id);
                      }}
                      onDragLeave={() => setDragOverGroupId(null)}
                      onDrop={(event) => {
                        event.preventDefault();
                        const payload =
                          draggingDevice ?? parseDragPayload(event);
                        handleDropDevice(group.id, payload);
                      }}
                    >
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>{t("deviceGroupsPage.devices")}</span>
                        <span>
                          {t("deviceGroupsPage.dragDevicesBetweenGroups")}
                        </span>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {groupDevices.length === 0 ? (
                          <span className="text-xs text-muted-foreground">
                            {t(
                              "deviceGroupsPage.dropDevicesHereOrAssignThem",
                            )}{" "}
                          </span>
                        ) : (
                          groupDevices.map((device) => (
                            <div
                              key={device.id}
                              draggable
                              onDragStart={(event) => {
                                const payload = {
                                  deviceId: device.id,
                                  fromGroupId: group.id,
                                };
                                setDraggingDevice(payload);
                                event.dataTransfer.setData(
                                  "text/plain",
                                  JSON.stringify(payload),
                                );
                              }}
                              onDragEnd={() => setDraggingDevice(null)}
                              className="flex items-center gap-2 rounded-full border bg-background px-3 py-1 text-xs text-muted-foreground transition hover:border-primary/40 cursor-grab"
                            >
                              <span className="font-medium text-foreground">
                                {device.hostname}
                              </span>
                              <span>{osLabel(device)}</span>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {(modalMode === "create" || modalMode === "edit") && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8 overflow-y-auto">
          <div className="w-full max-w-3xl my-8 rounded-lg border bg-card p-6 shadow-xs">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">
                  {modalMode === "create"
                    ? t("deviceGroupsPage.createDeviceGroup")
                    : t("deviceGroupsPage.editDeviceGroup")}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {modalMode === "create"
                    ? t(
                        "deviceGroupsPage.defineMembershipRulesOrManuallyAssign",
                      )
                    : t("deviceGroupsPage.updateTheGroupNameRulesAnd")}
                </p>
              </div>
              <button
                type="button"
                onClick={handleCloseModal}
                className="rounded-md p-2 text-muted-foreground transition hover:bg-muted"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form className="mt-6 space-y-6" onSubmit={handleSubmitGroup}>
              {modalMode === "create" && fleet.isFleetScope && (
                <div>
                  <label className="text-sm font-medium">
                    {t("common:labels.organization")}
                  </label>
                  <select
                    value={fleet.orgId}
                    onChange={(event) => fleet.setOrgId(event.target.value)}
                    className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  >
                    <option value="" disabled>
                      {t("common:layout.org.noSelection")}
                    </option>
                    {fleet.organizations.map((org) => (
                      <option key={org.id} value={org.id}>
                        {org.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <div>
                  <label className="text-sm font-medium">
                    {t("deviceGroupsPage.groupName")}
                  </label>
                  <input
                    type="text"
                    value={groupForm.name}
                    onChange={(event) =>
                      setGroupForm((prev) => ({
                        ...prev,
                        name: event.target.value,
                      }))
                    }
                    className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    placeholder={t("deviceGroupsPage.eGProductionLinux")}
                  />
                </div>
              </div>

              <div>
                <label className="text-sm font-medium">
                  {t("deviceGroupsPage.groupType")}
                </label>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setGroupForm((prev) => ({
                        ...prev,
                        type: "static",
                      }))
                    }
                    className={`inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium transition ${
                      groupForm.type === "static"
                        ? "border-primary bg-primary/10 text-primary"
                        : "hover:bg-muted"
                    }`}
                  >
                    {t("deviceGroupsPage.static")}{" "}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setGroupForm((prev) => ({
                        ...prev,
                        type: "dynamic",
                        filterConditions:
                          prev.filterConditions.conditions.length > 0
                            ? prev.filterConditions
                            : EMPTY_FILTER,
                      }))
                    }
                    className={`inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium transition ${
                      groupForm.type === "dynamic"
                        ? "border-primary bg-primary/10 text-primary"
                        : "hover:bg-muted"
                    }`}
                  >
                    {t("deviceGroupsPage.dynamic")}{" "}
                  </button>
                </div>
              </div>

              {groupForm.type === "dynamic" ? (
                <div className="rounded-md border bg-muted/20 p-4 space-y-4">
                  <div>
                    <h3 className="text-sm font-semibold">
                      {t("deviceGroupsPage.autoMembershipFilter")}
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      {t(
                        "deviceGroupsPage.devicesMatchingTheseConditionsWillAutomatically",
                      )}{" "}
                    </p>
                  </div>
                  <FilterBuilder
                    value={groupForm.filterConditions}
                    onChange={(conditions) =>
                      setGroupForm((prev) => ({
                        ...prev,
                        filterConditions: conditions,
                      }))
                    }
                    filterFields={DEFAULT_FILTER_FIELDS}
                    showPreview={false}
                  />
                  <FilterPreview
                    preview={formPreview}
                    loading={formPreviewLoading}
                    error={formPreviewError}
                    onRefresh={formPreviewRefresh}
                  />
                </div>
              ) : (
                // Static membership is editable on create AND edit. Create
                // carries `deviceIds` in the POST body; edit diffs the selection
                // against the server's current membership and drives the
                // `/:id/devices` endpoints (#3615) — the PATCH route still has
                // no membership field, so nothing is folded into it.
                <div className="rounded-md border bg-muted/20 p-4">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h3 className="text-sm font-semibold">
                        {t("deviceGroupsPage.manualDeviceAssignment")}
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        {t(
                          "deviceGroupsPage.selectDevicesThatShouldBelongTo",
                        )}{" "}
                      </p>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {groupForm.deviceIds.length}{" "}
                      {t("deviceGroupsPage.selected")}{" "}
                    </span>
                  </div>
                  <div className="mt-3">
                    <input
                      type="search"
                      value={assignmentQuery}
                      onChange={(event) =>
                        setAssignmentQuery(event.target.value)
                      }
                      placeholder={t(
                        "deviceGroupsPage.searchDevicesByHostnameOrTag",
                      )}
                      disabled={membershipUnavailable}
                      className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  </div>
                  <div className="mt-3 max-h-56 overflow-y-auto space-y-2">
                    {membershipLoading ? (
                      <p className="text-xs text-muted-foreground">
                        {t("deviceGroupsPage.loadingGroupMembership")}
                      </p>
                    ) : membershipError ? (
                      <p className="text-xs text-destructive">
                        {membershipError}
                      </p>
                    ) : filteredAssignmentDevices.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        {t("deviceGroupsPage.noDevicesMatchYourSearch")}
                      </p>
                    ) : (
                      filteredAssignmentDevices.map((device) => {
                        const checked = groupForm.deviceIds.includes(device.id);
                        return (
                          <label
                            key={device.id}
                            className="flex items-center gap-3 rounded-md border bg-background px-3 py-2 text-xs transition hover:bg-muted/40"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={membershipUnavailable}
                              onChange={(event) => {
                                const isChecked = event.target.checked;
                                setGroupForm((prev) => {
                                  const nextIds = new Set(prev.deviceIds);
                                  if (isChecked) {
                                    nextIds.add(device.id);
                                  } else {
                                    nextIds.delete(device.id);
                                  }
                                  return {
                                    ...prev,
                                    deviceIds: Array.from(nextIds),
                                  };
                                });
                              }}
                              className="h-4 w-4 rounded border-muted text-primary focus:ring-primary"
                            />
                            <div className="flex-1">
                              <p className="text-sm font-medium text-foreground">
                                {device.hostname}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {osLabel(device)} ·{" "}
                                {device.siteName ??
                                  (device.siteId
                                    ? (siteNameById.get(device.siteId) ?? "")
                                    : "")}
                              </p>
                            </div>
                          </label>
                        );
                      })
                    )}
                  </div>
                </div>
              )}

              {formError && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {formError}
                </div>
              )}

              <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  onClick={handleCloseModal}
                  className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
                >
                  {t("deviceGroupsPage.cancel")}{" "}
                </button>
                <button
                  type="submit"
                  disabled={
                    submitting ||
                    membershipUnavailable ||
                    (modalMode === "create" && fleet.needsOrgSelection)
                  }
                  className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {submitting
                    ? modalMode === "create"
                      ? t("deviceGroupsPage.creating")
                      : t("deviceGroupsPage.saving")
                    : modalMode === "create"
                      ? t("deviceGroupsPage.createGroup2")
                      : t("deviceGroupsPage.saveChanges")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {modalMode === "delete" && selectedGroup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-xs">
            <h2 className="text-lg font-semibold">
              {t("deviceGroupsPage.deleteGroup")}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t("deviceGroupsPage.areYouSureYouWantTo")}{" "}
              <span className="font-medium">{selectedGroup.name}</span>
              {t("deviceGroupsPage.thisWillRemove")}{" "}
              {getGroupDeviceCount(selectedGroup)}{" "}
              {t("deviceGroupsPage.device")}{" "}
              {getGroupDeviceCount(selectedGroup) === 1
                ? ""
                : t("deviceGroupsPage.s")}{" "}
              {t("deviceGroupsPage.fromTheGroup")}{" "}
            </p>
            <div className="mt-4">
              <label className="text-sm font-medium">
                {t("deviceGroupsPage.reassignDevicesOptional")}
              </label>
              <select
                value={deleteReassignGroupId}
                onChange={(event) =>
                  setDeleteReassignGroupId(event.target.value)
                }
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              >
                <option value="">
                  {t("deviceGroupsPage.leaveUnassigned")}
                </option>
                {groups
                  .filter(
                    (group) =>
                      group.id !== selectedGroup.id && group.type === "static",
                  )
                  .map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
              </select>
            </div>
            {formError && (
              <div role="alert" className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {formError}
              </div>
            )}
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={handleCloseModal}
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
              >
                {t("deviceGroupsPage.cancel")}{" "}
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                disabled={submitting}
                className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting
                  ? t("deviceGroupsPage.deleting")
                  : t("deviceGroupsPage.deleteGroup2")}
              </button>
            </div>
          </div>
        </div>
      )}

      {modalMode === "bulk-script" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-xs">
            <h2 className="text-lg font-semibold">
              {t("deviceGroupsPage.runScriptOnGroups")}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t("deviceGroupsPage.chooseAScriptToRunOn")}{" "}
              {selectedGroupIds.size} {t("deviceGroupsPage.selectedGroup")}{" "}
              {selectedGroupIds.size === 1 ? "" : t("deviceGroupsPage.s")}.
            </p>
            <div className="mt-4">
              <label className="text-sm font-medium">
                {t("deviceGroupsPage.script")}
              </label>
              <select
                value={bulkScriptId}
                onChange={(event) => setBulkScriptId(event.target.value)}
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              >
                <option value="">{t("deviceGroupsPage.selectAScript")}</option>
                {scripts.map((script) => (
                  <option key={script.id} value={script.id}>
                    {script.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={handleCloseModal}
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
              >
                {t("deviceGroupsPage.cancel")}{" "}
              </button>
              <button
                type="button"
                onClick={handleBulkScript}
                disabled={submitting || !bulkScriptId}
                className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting
                  ? t("deviceGroupsPage.running")
                  : t("deviceGroupsPage.runScript")}
              </button>
            </div>
          </div>
        </div>
      )}

      {modalMode === "bulk-policy" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-xs">
            <h2 className="text-lg font-semibold">
              {t("deviceGroupsPage.applyPolicyToGroups")}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t("deviceGroupsPage.assignAPolicyTo")} {selectedGroupIds.size}{" "}
              {t("deviceGroupsPage.selectedGroup")}{" "}
              {selectedGroupIds.size === 1 ? "" : t("deviceGroupsPage.s")}.
            </p>
            <div className="mt-4">
              <label className="text-sm font-medium">
                {t("deviceGroupsPage.policy2")}
              </label>
              <select
                value={bulkPolicyId}
                onChange={(event) => setBulkPolicyId(event.target.value)}
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              >
                <option value="">{t("deviceGroupsPage.selectAPolicy")}</option>
                {policies.map((policy) => (
                  <option key={policy.id} value={policy.id}>
                    {policy.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={handleCloseModal}
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
              >
                {t("deviceGroupsPage.cancel")}{" "}
              </button>
              <button
                type="button"
                onClick={handleBulkPolicy}
                disabled={submitting || !bulkPolicyId}
                className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting
                  ? t("deviceGroupsPage.applying")
                  : t("deviceGroupsPage.applyPolicy")}
              </button>
            </div>
          </div>
        </div>
      )}

      {tagOptions.length > 0 && (
        <datalist id="tag-options">
          {tagOptions.map((tag) => (
            <option key={tag} value={tag} />
          ))}
        </datalist>
      )}
    </div>
  );
}
