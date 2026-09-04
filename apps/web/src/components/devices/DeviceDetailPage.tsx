import { useState, useEffect, useCallback, useRef } from "react";
import { useEventStream } from "../../hooks/useEventStream";
import { ArrowLeft } from "lucide-react";
import { showToast } from "../shared/Toast";
import DeviceDetails from "./DeviceDetails";
import DeviceSettingsModal from "./DeviceSettingsModal";
import ChangeSiteModal from "./ChangeSiteModal";
import ScriptPickerModal, {
  type Script,
  type ScriptRunAsSelection,
} from "./ScriptPickerModal";
import type { Device, DeviceStatus, OSType } from "./DeviceList";
import { fetchWithAuth } from "../../stores/auth";
import {
  sendDeviceCommand,
  executeScript,
  toggleMaintenanceMode,
  decommissionDevice,
  clearDeviceSessions,
  restoreDevice,
  permanentDeleteDevice,
  sendWakeCommand,
  watchWakeOutcome,
  WakeCommandError,
  wakeFriendlyErrorMessage,
} from "../../services/deviceActions";
import { useAiStore } from "@/stores/aiStore";
import { navigateTo } from "@/lib/navigation";
import { runAction, ActionError } from "@/lib/runAction";
import Breadcrumbs from "../layout/Breadcrumbs";
import { useTranslation } from "react-i18next";
import "../../lib/i18n";

type DeviceDetailPageProps = {
  deviceId: string;
};

export default function DeviceDetailPage({ deviceId }: DeviceDetailPageProps) {
  const { t } = useTranslation("devices");
  const [device, setDevice] = useState<Device | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [actionInProgress, setActionInProgress] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [changeSiteOpen, setChangeSiteOpen] = useState(false);
  const [scriptPickerOpen, setScriptPickerOpen] = useState(false);

  // Track every in-flight wake watcher so that navigating away aborts the
  // long-running poll loop. Without this, watchWakeOutcome keeps polling
  // /devices/:id for up to 4 minutes after unmount and tries to render a
  // toast / setDevice on a dead component. (Todd's #789 review.) A Set is
  // used because a single device-detail page can only have one wake at a
  // time, but the abstraction matches the multi-target DevicesPage path
  // and is cheap.
  const wakeWatchersRef = useRef<Set<AbortController>>(new Set());
  useEffect(() => {
    const watchers = wakeWatchersRef.current;
    return () => {
      for (const ctrl of watchers) ctrl.abort();
      watchers.clear();
    };
  }, []);

  const fetchDevice = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);

      const response = await fetchWithAuth(`/devices/${deviceId}`);
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error("Device not found");
        }
        throw new Error("Failed to fetch device");
      }

      const data = await response.json();

      // Get latest metrics from recentMetrics array
      const latestMetrics = data.recentMetrics?.[0];

      // Transform API response to match Device type
      const transformedDevice: Device = {
        id: data.id,
        hostname: data.hostname ?? data.displayName ?? "Unknown",
        os: (data.osType ?? data.os ?? "windows") as OSType,
        osVersion: data.osVersion ?? "",
        status: (data.status ?? "offline") as DeviceStatus,
        cpuPercent: latestMetrics?.cpuPercent ?? 0,
        ramPercent: latestMetrics?.ramPercent ?? 0,
        lastSeen: data.lastSeenAt ?? data.lastSeen ?? "",
        orgId: data.orgId ?? "",
        orgName: data.orgName ?? "Unknown Org",
        siteId: data.siteId ?? "",
        siteName: data.siteName ?? "Unknown Site",
        agentVersion: data.agentVersion ?? "",
        tags: data.tags ?? [],
        lastUser: data.lastUser ?? undefined,
        uptimeSeconds:
          typeof data.uptimeSeconds === "number"
            ? data.uptimeSeconds
            : (latestMetrics?.uptimeSeconds ?? undefined),
        deviceRole: data.deviceRole ?? undefined,
        displayName: data.displayName ?? undefined,
        isHeadless: data.isHeadless ?? undefined,
        pendingReboot: data.pendingReboot === true,
        // Collision enrollment (#2764) — the ONLY input to the review banner.
        // The detail endpoint spreads the whole row (the column is not in
        // SENSITIVE_DEVICE_FIELDS), but this transform is an explicit
        // whitelist, so omitting it here silently kills the banner while every
        // other test stays green — the #800/#1273/#2138 dropped-field mode.
        possibleReplacementOfDeviceId:
          typeof data.possibleReplacementOfDeviceId === "string"
            ? data.possibleReplacementOfDeviceId
            : null,
        desktopAccess: data.desktopAccess ?? undefined,
        remoteAccessPolicy: data.remoteAccessPolicy ?? undefined,
        // Link-group membership (#2138/#2308). Carried through so the detail
        // page can hide the Linked Profiles tab on an unlinked device (#2865)
        // without a second fetch — the detail endpoint already returns both
        // columns (neither is in SENSITIVE_DEVICE_FIELDS).
        linkGroupId: data.linkGroupId ?? null,
        linkGroupRole: data.linkGroupRole ?? null,
        // RDS per-session helper mode (Task 12) — gates the session pickers
        // added in Tasks 13/14. Not in SENSITIVE_DEVICE_FIELDS, so the
        // detail endpoint's full-row spread already includes it.
        helperLifecycleMode: data.helperLifecycleMode ?? null,
      };

      setDevice(transformedDevice);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("deviceDetailPage.failedToFetchDevice"),
      );
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    fetchDevice();
  }, [fetchDevice]);

  // Real-time device updates
  const handleDeviceEvent = useCallback(
    (event: { type: string; payload: Record<string, unknown> }) => {
      const { type, payload } = event;
      const eventDeviceId = payload.deviceId as string;
      if (eventDeviceId !== deviceId) return;

      if (type === "device.online" || type === "device.offline") {
        setDevice((prev) =>
          prev
            ? {
                ...prev,
                status: ((payload.status as string) ??
                  (type === "device.online"
                    ? "online"
                    : "offline")) as DeviceStatus,
                lastSeen: new Date().toISOString(),
                agentVersion:
                  (payload.agentVersion as string) ?? prev.agentVersion,
              }
            : prev,
        );
      } else if (type === "device.updated") {
        const fields = payload.fields as string[] | undefined;
        if (fields?.includes("agentVersion")) {
          setDevice((prev) =>
            prev
              ? {
                  ...prev,
                  agentVersion:
                    (payload.agentVersion as string) ?? prev.agentVersion,
                }
              : prev,
          );
        }
      } else if (type === "device.decommissioned") {
        fetchDevice();
      }
    },
    [deviceId, fetchDevice],
  );

  const { subscribe } = useEventStream({ onEvent: handleDeviceEvent });

  useEffect(() => {
    subscribe([
      "device.online",
      "device.offline",
      "device.updated",
      "device.decommissioned",
    ]);
  }, [subscribe]);

  // Inject AI context when device data is available
  const setPageContext = useAiStore((s) => s.setPageContext);
  useEffect(() => {
    if (device) {
      setPageContext({
        type: "device",
        id: device.id,
        hostname: device.hostname,
        os: device.os,
        status: device.status,
        ip: undefined,
      });
    }
    return () => setPageContext(null);
  }, [device, setPageContext]);

  const handleBack = () => {
    void navigateTo("/devices");
  };

  const handleAction = async (action: string, device: Device) => {
    if (actionInProgress) return;

    try {
      setActionInProgress(true);

      switch (action) {
        case "reboot":
        case "reboot_safe_mode":
        case "shutdown":
        case "lock": {
          await sendDeviceCommand(device.id, action);
          const label =
            action === "reboot_safe_mode"
              ? t("deviceDetailPage.rebootToSafeMode")
              : action.charAt(0).toUpperCase() + action.slice(1);
          showToast({
            type: "success",
            message: `${label} command sent to ${device.hostname}`,
          });
          break;
        }

        case "wake": {
          try {
            const wake = await sendWakeCommand(device.id);
            const hostname = device.hostname;
            showToast({
              type: "success",
              message: `Wake packet sent to ${hostname} via ${wake.relay.hostname} (${wake.broadcast}). Watching for it to come online…`,
            });
            const wakeController = new AbortController();
            wakeWatchersRef.current.add(wakeController);
            void watchWakeOutcome(device.id, { signal: wakeController.signal })
              .then(async (outcome) => {
                if (outcome === "online") {
                  showToast({
                    type: "success",
                    message: `${hostname} is now online.`,
                  });
                  await fetchDevice();
                } else if (outcome === "timeout") {
                  showToast({
                    type: "error",
                    message: `${hostname} did not come online within 4 minutes. Check ethernet + BIOS WoL.`,
                  });
                }
                // 'aborted' is silent — user navigated away or page reloaded.
              })
              .finally(() => {
                wakeWatchersRef.current.delete(wakeController);
              });
          } catch (err) {
            if (err instanceof WakeCommandError) {
              const friendly =
                wakeFriendlyErrorMessage(err.code) ?? err.message;
              showToast({
                type: "error",
                message: `${device.hostname}: ${friendly}`,
              });
            } else {
              throw err;
            }
          }
          break;
        }

        case "refresh": {
          await sendDeviceCommand(device.id, "refresh_inventory");
          showToast({
            type: "success",
            message: `Inventory refresh requested for ${device.hostname}. Fresh data in 1–2 minutes.`,
          });
          break;
        }

        case "maintenance": {
          const isCurrentlyMaintenance = device.status === "maintenance";
          await toggleMaintenanceMode(device.id, !isCurrentlyMaintenance);
          showToast({
            type: "success",
            message: `${device.hostname} ${isCurrentlyMaintenance ? t("deviceDetailPage.takenOutOf") : t("deviceDetailPage.putInto")} maintenance mode`,
          });
          await fetchDevice();
          break;
        }

        case "files":
          void navigateTo(`/remote/files/${device.id}`);
          return;

        case "remote-tools":
          void navigateTo(
            `/remote/tools?deviceId=${device.id}&deviceName=${encodeURIComponent(device.hostname)}&os=${device.os}`,
          );
          return;

        case "deploy-software":
          // Carry the device into the deploy wizard via the hash (#2866).
          void navigateTo(`/software#deploy=${device.id}`);
          return;

        case "run-script":
          setScriptPickerOpen(true);
          break;

        case "settings":
          setSettingsOpen(true);
          break;

        case "change-site":
          setChangeSiteOpen(true);
          return;

        case "install-homebrew": {
          // Opt-in, per-device package-manager bootstrap. The pinned installer
          // URL + sha256 live server-side (services/homebrewBootstrap.ts) — the
          // browser never chooses what gets executed on the endpoint.
          try {
            await runAction({
              request: () =>
                fetchWithAuth(`/devices/${device.id}/homebrew-bootstrap`, {
                  method: "POST",
                }),
              errorFallback: `Failed to queue Homebrew install for ${device.hostname}`,
              successMessage: `Homebrew install queued for ${device.hostname}. It runs as the signed-in console user.`,
            });
          } catch (err) {
            // 401 → the auth redirect is the feedback; any other ActionError was
            // already toasted by runAction.
            if (!(err instanceof ActionError)) throw err;
          }
          break;
        }

        case "clear-sessions": {
          const result = await clearDeviceSessions(device.id);
          showToast({
            type: "success",
            message: `Cleared ${result.cleaned} session${result.cleaned !== 1 ? t("deviceDetailPage.s") : ""} for ${device.hostname}`,
          });
          break;
        }

        case "decommission": {
          // Deferred execution with undo — gives the user 5 seconds to cancel
          let cancelled = false;
          showToast({
            type: "undo",
            message: `Removing "${device.hostname}"...`,
            duration: 5000,
            onUndo: () => {
              cancelled = true;
              showToast({
                type: "success",
                message: t("deviceDetailPage.decommissionCancelled"),
                duration: 2000,
              });
            },
          });
          setTimeout(async () => {
            if (cancelled) return;
            try {
              await decommissionDevice(device.id);
              showToast({
                type: "success",
                message: `${device.hostname} has been removed`,
              });
              void navigateTo("/devices");
            } catch (err) {
              showToast({
                type: "error",
                message:
                  err instanceof Error
                    ? err.message
                    : `Failed to remove ${device.hostname}`,
              });
            }
          }, 5000);
          return;
        }

        case "restore":
          await restoreDevice(device.id);
          showToast({
            type: "success",
            message: `${device.hostname} has been restored`,
          });
          await fetchDevice();
          break;

        case "permanent-delete": {
          // Deferred execution with undo — gives the user 5 seconds to cancel
          let pdCancelled = false;
          showToast({
            type: "undo",
            message: `Permanently deleting "${device.hostname}"...`,
            duration: 5000,
            onUndo: () => {
              pdCancelled = true;
              showToast({
                type: "success",
                message: t("deviceDetailPage.permanentDeleteCancelled"),
                duration: 2000,
              });
            },
          });
          setTimeout(async () => {
            if (pdCancelled) return;
            try {
              const result = await permanentDeleteDevice(device.id);
              if (result.warning) {
                showToast({
                  type: "warning",
                  message: t("deviceDetailPage.permanentlyDeletedWithWarning", {
                    hostname: device.hostname,
                    warning: result.warning,
                  }),
                  duration: 10000,
                });
              } else {
                showToast({
                  type: "success",
                  message: `${device.hostname} has been permanently deleted`,
                });
              }
              void navigateTo("/devices");
            } catch (err) {
              showToast({
                type: "error",
                message:
                  err instanceof Error
                    ? err.message
                    : `Failed to delete ${device.hostname}`,
              });
            }
          }, 5000);
          return;
        }

        default:
          showToast({ type: "error", message: `Unknown action: ${action}` });
      }
    } catch (err) {
      showToast({
        type: "error",
        message:
          err instanceof Error
            ? err.message
            : `Failed to ${action} ${device.hostname}`,
      });
    } finally {
      setActionInProgress(false);
    }
  };

  const handleScriptSelect = async (
    script: Script,
    runAs: ScriptRunAsSelection,
    parameters?: Record<string, unknown>,
    targetSessionId?: number,
  ) => {
    if (actionInProgress || !device) return;

    try {
      setActionInProgress(true);
      const result = await executeScript(script.id, [device.id], parameters, runAs, targetSessionId);
      const target = result.targets.find(candidate => candidate.requestedDeviceId === device.id);
      if (target?.admission === "admitted") {
        showToast({
          type: "success",
          message: `Script "${script.name}" queued for ${device.hostname}`,
        });
        // #4886 — land on the Scripts tab with the new execution highlighted,
        // so the operator watches the result instead of staying wherever they
        // happened to trigger the run from (often Overview). Same page, so a
        // direct hash write is enough — DeviceDetails' useHashState picks up
        // the resulting hashchange (the CLAUDE.md tab-state convention).
        window.location.hash = target.executionId
          ? `scripts/${target.executionId}`
          : "scripts";
      } else {
        showToast({
          type: "error",
          message: `${t("deviceDetailPage.failedToQueueScript")}: ${target?.reasonCode ?? target?.admission ?? "not_admitted"}`,
        });
      }
    } catch (err) {
      showToast({
        type: "error",
        message:
          err instanceof Error
            ? err.message
            : t("deviceDetailPage.failedToQueueScript"),
      });
    } finally {
      setActionInProgress(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">
            {t("deviceDetailPage.loadingDevice")}
          </p>
        </div>
      </div>
    );
  }

  if (error || !device) {
    return (
      <div className="space-y-6">
        <button
          type="button"
          onClick={handleBack}
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t("deviceDetailPage.backToDevices")}{" "}
        </button>
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
          <p className="text-sm text-destructive">
            {error || "Device not found"}
          </p>
          <button
            type="button"
            onClick={handleBack}
            className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            {t("deviceDetailPage.goBack")}{" "}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Breadcrumbs
        items={[
          // #3839 (Discord ask): one-click jump to the device's Organization
          // page from the device breadcrumb, instead of using the OrgSwitcher
          // dropdown + search. Omitted when the device has no orgId (defensive
          // — the detail fetch always sets one for a real device).
          ...(device.orgId
            ? [{ label: device.orgName, href: `/settings/organizations/${device.orgId}` }]
            : []),
          { label: t("deviceDetailPage.devices"), href: "/devices" },
          { label: device.hostname || "Device" },
        ]}
      />
      <DeviceDetails
        device={device}
        onBack={handleBack}
        onAction={handleAction}
      />
      <DeviceSettingsModal
        device={device}
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={fetchDevice}
        onAction={handleAction}
      />
      <ChangeSiteModal
        device={device}
        isOpen={changeSiteOpen}
        onClose={() => setChangeSiteOpen(false)}
        onSaved={() => {
          showToast({
            type: "success",
            message: `${device.hostname} moved to new site`,
          });
          void fetchDevice();
        }}
      />
      <ScriptPickerModal
        isOpen={scriptPickerOpen}
        onClose={() => setScriptPickerOpen(false)}
        onSelect={handleScriptSelect}
        deviceHostname={device.hostname}
        deviceOs={device.os}
        deviceId={device.id}
        helperLifecycleMode={device.helperLifecycleMode ?? null}
      />
    </div>
  );
}
