import { useEffect, useMemo, useState } from "react";
import { FolderMinus, FolderPlus, Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Device } from "./DeviceList";
import { Dialog } from "../shared/Dialog";
import { showToast } from "../shared/Toast";
import { fetchWithAuth } from "../../stores/auth";
import { ActionError } from "@/lib/runAction";
import { addDevicesToGroup, removeDevicesFromGroup, summarizeBulkGroupRemove } from "./bulkGroupMembership";
import "../../lib/i18n";

/** The fields of a GET /device-groups row this dialog reads. */
type GroupRow = {
  id: string;
  name: string;
  orgId: string | null;
  siteId: string | null;
  type: "static" | "dynamic";
  ownerScope?: "organization" | "partner";
};

export type BulkGroupMembershipMode = "add" | "remove";

type Props = {
  mode: BulkGroupMembershipMode;
  /**
   * Agent devices of ONE org — the caller gates that (bulkGroupMembershipBlock in
   * bulkActionGating.ts); the first row names the org.
   */
  devices: Device[];
  onClose: () => void;
  /** Called after the server answered a write (the list behind may now be stale). */
  onDone: () => void;
  onUnauthorized?: () => void;
};

/**
 * Which groups the bulk write can act on for this selection (#9866), the same rules the group
 * editor and the membership routes apply:
 * - static only: a dynamic group's filter decides its members, and the API refuses manual writes;
 * - owned by the selection's org: partner-owned groups are read-only for membership
 *   (PARTNER_GROUP_READ_ONLY_BODY), and a static group only holds devices of its own org;
 * - a site-bound group only when EVERY selected device is at that site: the add route rejects the
 *   whole batch otherwise, and a device elsewhere cannot be a member of it.
 * GET /device-groups already drops groups whose site the viewer may not reach (allowedSiteIds).
 */
export function eligibleGroups(groups: readonly GroupRow[], orgId: string, siteIds: readonly string[]): GroupRow[] {
  const singleSite = siteIds.length === 1 ? siteIds[0] : null;
  return groups.filter((g) =>
    g.type === "static"
    && (g.ownerScope ?? "organization") === "organization"
    && g.orgId === orgId
    && (g.siteId === null || g.siteId === singleSite),
  );
}

function formatNames(names: string[], t: (key: string, opts?: Record<string, unknown>) => string): string {
  const shown = names.slice(0, 3).join(", ");
  const rest = names.length - 3;
  return rest > 0 ? t("bulkGroupMembership.andMore", { names: shown, n: rest }) : shown;
}

export default function BulkGroupMembershipDialog({ mode, devices, onClose, onDone, onUnauthorized }: Props) {
  const { t } = useTranslation("devices");
  const orgId = devices[0]?.orgId ?? "";
  const orgName = devices[0]?.orgName ?? null;
  const siteIds = useMemo(() => [...new Set(devices.map((d) => d.siteId))], [devices]);
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [groupId, setGroupId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    const params = new URLSearchParams({ ownerScope: "organization", orgId, type: "static" });
    fetchWithAuth(`/device-groups?${params.toString()}`)
      .then(async (res) => {
        if (res.status === 401) {
          // Session expired: the caller's handler redirects; no inline error.
          if (!cancelled) onUnauthorized?.();
          return;
        }
        if (!res.ok) throw new Error(`GET /device-groups answered ${res.status}`);
        const body = (await res.json()) as { data?: GroupRow[] };
        if (!cancelled) setGroups(eligibleGroups(Array.isArray(body.data) ? body.data : [], orgId, siteIds));
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[BulkGroupMembershipDialog] loading groups failed:", err);
        setGroups([]);
        setError(t("bulkGroupMembership.failedToLoadGroups"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // onUnauthorized is a stable module-level handler at the only call site; keeping it out of the
    // deps avoids refetching on every parent render if a caller passes an inline function.
  }, [orgId, siteIds, t]);

  const groupName = groups.find((g) => g.id === groupId)?.name ?? "";
  const deviceIds = devices.map((d) => d.id);
  const errorFallback = t("bulkGroupMembership.failedToUpdate");

  const reportRemove = (result: Awaited<ReturnType<typeof removeDevicesFromGroup>>) => {
    const summary = summarizeBulkGroupRemove(result, devices);
    if (summary.tone === "success") {
      showToast({
        type: "success",
        message: t("bulkGroupMembership.removeResult", {
          group: groupName, removed: summary.removed, notMember: summary.notMember,
        }),
      });
      return;
    }
    showToast({
      type: summary.tone,
      message: t("bulkGroupMembership.removeResultForbidden", {
        group: groupName,
        removed: summary.removed,
        notMember: summary.notMember,
        devices: formatNames(summary.forbidden, t),
      }),
    });
  };

  const handleSubmit = async () => {
    if (!groupId) return;
    setSaving(true);
    setError(undefined);
    try {
      if (mode === "add") {
        const result = await addDevicesToGroup({ groupId, deviceIds, errorFallback, onUnauthorized });
        showToast({
          type: "success",
          message: t("bulkGroupMembership.addResult", { group: groupName, added: result.added, skipped: result.skipped }),
        });
      } else {
        reportRemove(await removeDevicesFromGroup({ groupId, deviceIds, errorFallback, onUnauthorized }));
      }
    } catch (err) {
      setSaving(false);
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (!(err instanceof ActionError)) {
        console.error("[BulkGroupMembershipDialog] membership write failed:", err);
        showToast({ type: "error", message: errorFallback });
      }
      // No answer (status 0) or an unreadable 2xx: the server may have applied the change, so
      // refresh the list behind the dialog rather than leave it stale (same as ChangeSiteModal).
      if (err instanceof ActionError && (err.status === 0 || (err.status >= 200 && err.status < 300))) {
        onDone();
      }
      // ActionError was already toasted by runAction; keep the dialog open with the reason.
      setError(err instanceof Error ? err.message : errorFallback);
      return;
    }
    setSaving(false);
    onDone();
    onClose();
  };

  const isAdd = mode === "add";
  const title = isAdd ? t("bulkGroupMembership.titleAdd") : t("bulkGroupMembership.titleRemove");
  const Icon = isAdd ? FolderPlus : FolderMinus;

  return (
    <Dialog open onClose={saving ? () => {} : onClose} title={title} className="p-6" maxWidth="md">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10">
            <Icon className="h-4 w-4 text-primary" />
          </div>
          <h2 className="text-lg font-semibold">{title}</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          aria-label={t("bulkGroupMembership.cancel")}
          className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted disabled:cursor-not-allowed"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <p className="text-sm text-muted-foreground" data-testid="bulk-group-intro">
        {t("bulkGroupMembership.selectionSummary", { n: devices.length, org: orgName ?? "—" })}
      </p>

      <div className="mt-5 space-y-2">
        <label htmlFor="bulk-group-select" className="text-xs font-medium text-muted-foreground">
          {t("bulkGroupMembership.groupLabel")}
        </label>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("bulkGroupMembership.loadingGroups")}
          </div>
        ) : groups.length === 0 ? (
          !error && (
            <p className="text-sm text-muted-foreground" data-testid="bulk-group-empty">
              {t("bulkGroupMembership.noGroups")}
            </p>
          )
        ) : (
          <select
            id="bulk-group-select"
            data-testid="bulk-group-select"
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
            disabled={saving}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          >
            <option value="" disabled>
              {t("bulkGroupMembership.selectGroup")}
            </option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        )}
        <p className="text-xs text-muted-foreground">{t("bulkGroupMembership.scopeHint")}</p>
      </div>

      {error && (
        <div role="alert" className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="mt-6 flex justify-end gap-3">
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
        >
          {t("bulkGroupMembership.cancel")}
        </button>
        <button
          type="button"
          data-testid="bulk-group-submit"
          onClick={handleSubmit}
          disabled={saving || loading || !groupId}
          className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t("bulkGroupMembership.saving")}
            </>
          ) : isAdd ? (
            t("bulkGroupMembership.submitAdd")
          ) : (
            t("bulkGroupMembership.submitRemove")
          )}
        </button>
      </div>
    </Dialog>
  );
}
