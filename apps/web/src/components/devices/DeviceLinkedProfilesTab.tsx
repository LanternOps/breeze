import { useCallback, useEffect, useState } from "react";
import { Link2, Link2Off, Circle } from "lucide-react";
import { fetchWithAuth } from "../../stores/auth";
import { runAction, handleActionError } from "../../lib/runAction";
import { useTranslation } from "react-i18next";
import "../../lib/i18n";

/** One boot profile (device record) in a linked multi-boot group. */
export interface LinkedProfile {
  deviceId: string;
  hostname: string;
  displayName: string | null;
  osType: string;
  osVersion: string;
  agentVersion: string;
  status: string;
  lastSeenAt: string | null;
}

interface LinkGroupResponse {
  group: { id: string; name: string | null } | null;
  members: LinkedProfile[];
}

function formatLastSeen(iso: string | null): string {
  if (!iso) return "Never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "Unknown";
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString();
}

export default function DeviceLinkedProfilesTab({
  deviceId,
}: {
  deviceId: string;
}) {
  const { t } = useTranslation("devices");
  const [data, setData] = useState<LinkGroupResponse | null>(null);
  const [loading, setLoading] = useState(true);
  // 'none' = ok, 'denied' = 403 (a Retry can never succeed), 'other' = a
  // transient/5xx failure worth retrying.
  const [errorKind, setErrorKind] = useState<"none" | "denied" | "other">(
    "none",
  );
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErrorKind("none");
    try {
      const res = await fetchWithAuth(`/devices/${deviceId}/link-group`);
      if (res.status === 403) {
        setErrorKind("denied");
        return;
      }
      if (!res.ok) {
        // Observability: a persistent 5xx on this panel should be visible in
        // the console rather than collapsing into a silent boolean.
        console.error(
          `Failed to load linked profiles for ${deviceId}: HTTP ${res.status}`,
        );
        setErrorKind("other");
        return;
      }
      setData((await res.json()) as LinkGroupResponse);
    } catch (err) {
      console.error(`Failed to load linked profiles for ${deviceId}:`, err);
      setErrorKind("other");
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const group = data?.group ?? null;
  const members = data?.members ?? [];

  const unlinkThisDevice = async () => {
    if (!group) return;
    setBusy(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/devices/link-groups/${group.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ removeDeviceIds: [deviceId] }),
          }),
        errorFallback: "Could not unlink this device",
        successMessage: "Device unlinked",
      });
      await load();
    } catch (err) {
      handleActionError(err, "Could not unlink this device");
    } finally {
      setBusy(false);
    }
  };

  const dissolveGroup = async () => {
    if (!group) return;
    setBusy(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/devices/link-groups/${group.id}`, {
            method: "DELETE",
          }),
        errorFallback: "Could not remove the link",
        successMessage: "Link removed",
      });
      await load();
    } catch (err) {
      handleActionError(err, "Could not remove the link");
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
        {t("deviceLinkedProfilesTab.loadingLinkedProfiles")}
      </div>
    );
  }

  if (errorKind === "denied") {
    return (
      <div
        className="rounded-lg border bg-card p-6"
        data-testid="linked-profiles-denied"
      >
        <p className="text-sm text-muted-foreground">
          {t("deviceLinkedProfilesTab.youDonTHaveAccessTo")}{" "}
        </p>
      </div>
    );
  }

  if (errorKind === "other") {
    return (
      <div
        className="rounded-lg border bg-card p-6"
        data-testid="linked-profiles-error"
      >
        <p className="text-sm text-destructive">
          {t("deviceLinkedProfilesTab.couldNotLoadLinkedProfiles")}
        </p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-3 rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
        >
          {t("deviceLinkedProfilesTab.retry")}{" "}
        </button>
      </div>
    );
  }

  if (!group) {
    return (
      <div
        className="rounded-lg border bg-card p-6"
        data-testid="linked-profiles-empty"
      >
        <div className="flex items-center gap-2 text-sm font-medium">
          <Link2 className="h-4 w-4 text-muted-foreground" />
          {t("deviceLinkedProfilesTab.notPartOfALinkedGroup")}{" "}
        </div>
        <p className="mt-2 max-w-prose text-sm text-muted-foreground">
          {t("deviceLinkedProfilesTab.multiBootMachinesRunASeparate")}{" "}
          <span className="font-medium">
            {" "}
            {t("deviceLinkedProfilesTab.linkAsMultiBoot")}
          </span>{" "}
          {t("deviceLinkedProfilesTab.toGroupThemWhenOnlyOne")}{" "}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="linked-profiles-tab">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Link2 className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">
            {group.name || "Linked boot profiles"}
          </h3>
          <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
            {members.length} {t("deviceLinkedProfilesTab.profiles")}{" "}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void unlinkThisDevice()}
            data-testid="linked-profiles-unlink-self"
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
          >
            <Link2Off className="h-3.5 w-3.5" />
            {t("deviceLinkedProfilesTab.unlinkThisDevice")}{" "}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void dissolveGroup()}
            data-testid="linked-profiles-dissolve"
            className="inline-flex items-center gap-1.5 rounded-md border border-destructive/40 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-50"
          >
            {t("deviceLinkedProfilesTab.removeLink")}{" "}
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">
                {t("deviceLinkedProfilesTab.profile")}
              </th>
              <th className="px-3 py-2 font-medium">
                {t("deviceLinkedProfilesTab.os")}
              </th>
              <th className="px-3 py-2 font-medium">
                {t("deviceLinkedProfilesTab.status")}
              </th>
              <th className="px-3 py-2 font-medium">
                {t("deviceLinkedProfilesTab.agent")}
              </th>
              <th className="px-3 py-2 font-medium">
                {t("deviceLinkedProfilesTab.lastSeen")}
              </th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const isOnline = m.status === "online";
              const isCurrent = m.deviceId === deviceId;
              return (
                <tr
                  key={m.deviceId}
                  data-testid={`linked-profile-${m.deviceId}`}
                  className={`border-t ${isOnline ? "" : "text-muted-foreground"} ${isCurrent ? "bg-muted/30" : ""}`}
                >
                  <td className="px-3 py-2">
                    <div className="font-medium">
                      {m.displayName || m.hostname}
                      {isCurrent && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          {t("deviceLinkedProfilesTab.thisDevice")}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {m.hostname}
                    </div>
                  </td>
                  <td className="px-3 py-2 capitalize">
                    {m.osType}{" "}
                    <span className="text-xs text-muted-foreground">
                      {m.osVersion}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex items-center gap-1.5 ${isOnline ? "text-success" : "text-muted-foreground"}`}
                      data-testid={`linked-profile-${m.deviceId}-status`}
                    >
                      <Circle
                        className={`h-2 w-2 ${isOnline ? "fill-success" : "fill-muted-foreground"}`}
                      />
                      {isOnline
                        ? t("deviceLinkedProfilesTab.online")
                        : m.status}
                    </span>
                  </td>
                  <td className="px-3 py-2">v{m.agentVersion}</td>
                  <td className="px-3 py-2">{formatLastSeen(m.lastSeenAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
