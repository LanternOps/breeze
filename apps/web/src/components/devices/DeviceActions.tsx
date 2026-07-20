import { useState } from "react";
import {
  Play,
  RotateCcw,
  RefreshCw,
  Monitor,
  Settings,
  Power,
  Shield,
  MoreHorizontal,
  Wrench,
  Trash2,
  XCircle,
  Package,
  MapPin,
  Zap,
  ChevronDown,
} from "lucide-react";
import type { Device, DeviceStatus } from "./DeviceList";
import ConnectDesktopButton from "../remote/ConnectDesktopButton";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { useTranslation } from "react-i18next";
import "../../lib/i18n";

// CORRECTION (#2426): an earlier version of this comment claimed that Run
// Script / Power / Reboot / Refresh "require an actively-connected agent" and
// that "the API rejects it with 'Device is not online'". **That was wrong**,
// and it propagated into two PRs before anyone checked it against the API.
// Two genuinely different categories live on this page:
//
//   LIVE SESSION — Connect Desktop, Remote Terminal, Remote Tools. These hand
//   off a socket, so they really do need `status === 'online'`. The string
//   "Device is not online" comes ONLY from these routes (`terminalWs`,
//   `desktopWs`, `tunnelWs`, `tunnels`, `bootMetrics`, `remote/sessions`).
//
//   QUEUED COMMAND — Run Script, Reboot, Reboot to Safe Mode, Shutdown,
//   Refresh. These insert a `device_commands` row with `status:'pending'` (no
//   TTL) and the agent claims it on its NEXT poll/heartbeat. The only status
//   the API refuses is `decommissioned`: `routes/devices/commands.ts` (:89,
//   :157, :268, :437), and for scripts the shared `executeScriptOnDevices`
//   service (`services/scriptExecution.ts:118`) — which drops decommissioned
//   devices from the target set and returns `status:'queued'` for the rest.
//   (The gate lives in that service, not in `routes/scripts.ts`.) So a script
//   queued against an offline device IS delivered — it runs when the machine
//   comes back. That is a feature, not a doomed request.
//
// Consequence: gating a queued command on `!== 'online'` does not prevent a
// doomed request, it REMOVES working functionality. The only status that can
// never service a queued command is `decommissioned` (agent-less by definition).
//
// The `!online` gates BELOW on the queued commands — run-script, refresh,
// reboot, reboot_safe_mode, shutdown, and the Power dropdown trigger — are
// therefore stricter than the API requires.
//
// STATUS (PR #2630): the maintainer decision issue #2486 asked for has now been
// made, and it went the loosening way — the DeviceList row menu and the grid
// card both moved to `isCommandQueueable`. This action bar was deliberately NOT
// included in that PR to keep it reviewable, so it is now the ONLY surface still
// gating queued commands on `!online`: an offline device shows Reboot enabled in
// the list and grid, and disabled here. Aligning it is tracked as follow-up work
// — when you do, use `isCommandQueueable`/`notQueueableTitle` from
// bulkActionGating.ts rather than re-deriving the rule a fourth time, and drop
// the private `unavailableTitle` switch below in favour of `notOnlineTitle`.
//
// The `!online` gates on Connect Desktop and Remote Tools are correct — those
// are live sessions.
// Do not copy the queued-command gates to new surfaces, and do not "fix" a
// missing gate by adding one; gate queued commands on `decommissioned`
// (see DeviceList.tsx). Wake (Wake-on-LAN) targets offline devices by design
// and is never gated.
function isDeviceOnline(device: Device): boolean {
  return device.status === "online";
}

// Status-accurate tooltip for a disabled session/command button. The old copy
// hard-coded "Device is offline", which was wrong for e.g. a quarantined or
// updating device.
type DeviceTranslation = ReturnType<typeof useTranslation<"devices">>["t"];

function unavailableTitle(status: DeviceStatus, t: DeviceTranslation): string {
  switch (status) {
    case "offline":
      return t("deviceActions.unavailable.offline");
    case "maintenance":
      return t("deviceActions.unavailable.maintenance");
    case "decommissioned":
      return t("deviceActions.unavailable.decommissioned");
    case "quarantined":
      return t("deviceActions.unavailable.quarantined");
    case "updating":
      return t("deviceActions.unavailable.updating");
    case "pending":
      return t("deviceActions.unavailable.pending");
    default:
      return t("deviceActions.unavailable.notOnline");
  }
}

type DeviceActionsProps = {
  device: Device;
  onAction?: (action: string, device: Device) => void;
  compact?: boolean;
};

type ModalType =
  | "none"
  | "reboot"
  | "reboot_safe_mode"
  | "shutdown"
  | "maintenance"
  | "decommission"
  | "clear-sessions";

type ModalConfigEntry = {
  title: string;
  message: string;
  confirmLabel: string;
  variant: "destructive" | "warning";
};

// Copy + variant for each confirm action. Rendered via the shared ConfirmDialog
// (which owns the focus trap, Escape, scroll-lock, portal, and animation) rather
// than a bespoke modal. `destructive` = irreversible/offline-inducing; everything
// else is `warning`.
function getModalConfig(
  type: Exclude<ModalType, "none">,
  device: Device,
  t: DeviceTranslation,
): ModalConfigEntry {
  switch (type) {
    case "reboot":
      return {
        title: t("deviceActions.confirm.reboot.title"),
        message: t("deviceActions.confirm.reboot.message", {
          hostname: device.hostname,
        }),
        confirmLabel: t("deviceActions.confirm.reboot.confirm"),
        variant: "warning",
      };
    case "reboot_safe_mode":
      return {
        title: t("deviceActions.confirm.rebootSafeMode.title"),
        message: t("deviceActions.confirm.rebootSafeMode.message", {
          hostname: device.hostname,
        }),
        confirmLabel: t("deviceActions.confirm.rebootSafeMode.confirm"),
        variant: "warning",
      };
    case "shutdown":
      return {
        title: t("deviceActions.confirm.shutdown.title"),
        message: t("deviceActions.confirm.shutdown.message", {
          hostname: device.hostname,
        }),
        confirmLabel: t("deviceActions.confirm.shutdown.confirm"),
        variant: "destructive",
      };
    case "maintenance":
      return device.status === "maintenance"
        ? {
            title: t("deviceActions.confirm.exitMaintenance.title"),
            message: t("deviceActions.confirm.exitMaintenance.message", {
              hostname: device.hostname,
            }),
            confirmLabel: t("deviceActions.confirm.exitMaintenance.confirm"),
            variant: "warning",
          }
        : {
            title: t("deviceActions.confirm.enterMaintenance.title"),
            message: t("deviceActions.confirm.enterMaintenance.message", {
              hostname: device.hostname,
            }),
            confirmLabel: t("deviceActions.confirm.enterMaintenance.confirm"),
            variant: "warning",
          };
    case "decommission":
      return {
        title: t("deviceActions.confirm.decommission.title"),
        message: t("deviceActions.confirm.decommission.message", {
          hostname: device.hostname,
        }),
        confirmLabel: t("deviceActions.confirm.decommission.confirm"),
        variant: "destructive",
      };
    case "clear-sessions":
      return {
        title: t("deviceActions.confirm.clearSessions.title"),
        message: t("deviceActions.confirm.clearSessions.message", {
          hostname: device.hostname,
        }),
        confirmLabel: t("deviceActions.confirm.clearSessions.confirm"),
        variant: "warning",
      };
  }
}

export default function DeviceActions({
  device,
  onAction,
  compact = false,
}: DeviceActionsProps) {
  const { t } = useTranslation("devices");
  const [menuOpen, setMenuOpen] = useState(false);
  const [powerMenuOpen, setPowerMenuOpen] = useState(false);
  const [modalType, setModalType] = useState<ModalType>("none");
  const [loading, setLoading] = useState(false);

  // NOTE: `online` gates BOTH live-session buttons (correctly) and queued
  // commands (more strictly than the API requires) — see the category note at
  // the top of this file. It is not evidence that a queued command needs an
  // online agent. Wake (Wake-on-LAN) is exempt and gated on `=== 'offline'`.
  const online = isDeviceOnline(device);
  const offlineTitle = online ? undefined : unavailableTitle(device.status, t);

  const closeMenus = () => {
    setMenuOpen(false);
    setPowerMenuOpen(false);
  };

  const handleAction = async (action: string) => {
    if (
      action === "reboot" ||
      action === "reboot_safe_mode" ||
      action === "shutdown" ||
      action === "maintenance" ||
      action === "decommission" ||
      action === "clear-sessions"
    ) {
      setModalType(action);
      closeMenus();
      return;
    }

    setLoading(true);
    try {
      await onAction?.(action, device);
    } finally {
      setLoading(false);
      closeMenus();
    }
  };

  const handleConfirm = async () => {
    if (modalType === "none") return;

    setLoading(true);
    try {
      await onAction?.(modalType, device);
      setModalType("none");
    } finally {
      setLoading(false);
    }
  };

  const closeModal = () => {
    if (!loading) {
      setModalType("none");
    }
  };

  const modalCfg =
    modalType === "none" ? null : getModalConfig(modalType, device, t);

  if (compact) {
    return (
      <>
        <div className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen(!menuOpen)}
            className="flex h-9 w-9 items-center justify-center rounded-md border hover:bg-muted"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full z-10 mt-1 w-48 rounded-md border bg-card shadow-lg">
              <button
                type="button"
                onClick={() => handleAction("run-script")}
                disabled={!online}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Play className="h-4 w-4" />
                {t("deviceActions.runScript")}{" "}
              </button>
              <ConnectDesktopButton
                deviceId={device.id}
                compact
                disabled={!online}
                disabledTitle={offlineTitle}
                isHeadless={device.isHeadless}
                desktopAccess={device.desktopAccess}
                remoteAccessPolicy={device.remoteAccessPolicy}
              />
              <button
                type="button"
                onClick={() => handleAction("remote-tools")}
                disabled={
                  !online || device.remoteAccessPolicy?.remoteTools === false
                }
                title={
                  offlineTitle ??
                  (device.remoteAccessPolicy?.remoteTools === false
                    ? `Remote tools disabled by policy${device.remoteAccessPolicy?.policyName ? ` "${device.remoteAccessPolicy.policyName}"` : ""}`
                    : undefined)
                }
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Wrench className="h-4 w-4" />
                {t("deviceActions.remoteTools")}{" "}
              </button>
              <button
                type="button"
                onClick={() => handleAction("refresh")}
                disabled={!online}
                title={t("deviceActions.reRunAgentInventoryCollectorsSo")}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw className="h-4 w-4" />
                {t("deviceActions.refresh")}{" "}
              </button>
              <button
                type="button"
                onClick={() => handleAction("reboot")}
                disabled={!online}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RotateCcw className="h-4 w-4" />
                {t("deviceActions.reboot")}{" "}
              </button>
              {device.status === "offline" && (
                <button
                  type="button"
                  onClick={() => handleAction("wake")}
                  className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
                >
                  <Zap className="h-4 w-4" />
                  {t("deviceActions.wake")}{" "}
                </button>
              )}
              {device.os === "windows" && (
                <button
                  type="button"
                  onClick={() => handleAction("reboot_safe_mode")}
                  disabled={!online}
                  className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-warning hover:bg-warning/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Shield className="h-4 w-4" />
                  {t("deviceActions.rebootToSafeMode")}{" "}
                </button>
              )}
              <button
                type="button"
                onClick={() => handleAction("deploy-software")}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
              >
                <Package className="h-4 w-4" />
                {t("deviceActions.deploySoftware")}{" "}
              </button>
              <button
                type="button"
                onClick={() => handleAction("clear-sessions")}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
              >
                <XCircle className="h-4 w-4" />
                {t("deviceActions.clearSessions")}{" "}
              </button>
              <hr className="my-1" />
              <button
                type="button"
                onClick={() => handleAction("change-site")}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
              >
                <MapPin className="h-4 w-4" />
                {t("deviceActions.changeSite")}{" "}
              </button>
              <button
                type="button"
                onClick={() => handleAction("maintenance")}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
              >
                <Shield className="h-4 w-4" />
                {device.status === "maintenance"
                  ? t("deviceActions.exitMaintenance")
                  : t("deviceActions.enterMaintenance")}
              </button>
              <hr className="my-1" />
              <button
                type="button"
                onClick={() => handleAction("decommission")}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="h-4 w-4" />
                {t("deviceActions.decommission")}{" "}
              </button>
            </div>
          )}
        </div>

        {modalCfg && (
          <ConfirmDialog
            open
            onClose={closeModal}
            onConfirm={handleConfirm}
            title={modalCfg.title}
            message={modalCfg.message}
            confirmLabel={modalCfg.confirmLabel}
            variant={modalCfg.variant}
            isLoading={loading}
          />
        )}
      </>
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {/* When the device is offline, Wake is the one action that matters —
            promote it to a primary header button instead of burying it in the
            Power dropdown, where every other action is disabled anyway. */}
        {device.status === "offline" && (
          <button
            type="button"
            onClick={() => handleAction("wake")}
            disabled={loading}
            title={t("deviceActions.sendAWakeOnLanPacket")}
            className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Zap className="h-4 w-4" />
            {t("deviceActions.wake")}{" "}
          </button>
        )}
        <button
          type="button"
          onClick={() => handleAction("run-script")}
          disabled={!online || loading}
          title={offlineTitle}
          className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Play className="h-4 w-4" />
          {t("deviceActions.runScript")}{" "}
        </button>
        <ConnectDesktopButton
          deviceId={device.id}
          disabled={!online}
          disabledTitle={offlineTitle}
          isHeadless={device.isHeadless}
          desktopAccess={device.desktopAccess}
          remoteAccessPolicy={device.remoteAccessPolicy}
        />
        <button
          type="button"
          onClick={() => handleAction("remote-tools")}
          disabled={
            !online ||
            loading ||
            device.remoteAccessPolicy?.remoteTools === false
          }
          title={
            offlineTitle ??
            (device.remoteAccessPolicy?.remoteTools === false
              ? `Remote tools disabled by policy${device.remoteAccessPolicy?.policyName ? ` "${device.remoteAccessPolicy.policyName}"` : ""}`
              : undefined)
          }
          className="flex items-center gap-2 rounded-md border bg-background px-4 py-2 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Wrench className="h-4 w-4" />
          {t("deviceActions.remoteTools")}{" "}
        </button>
        <div className="relative">
          <button
            type="button"
            onClick={() => {
              setPowerMenuOpen(!powerMenuOpen);
              setMenuOpen(false);
            }}
            disabled={!online || loading}
            title={offlineTitle}
            aria-haspopup="true"
            aria-expanded={powerMenuOpen}
            className="flex items-center gap-2 rounded-md border bg-background px-4 py-2 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Power className="h-4 w-4" />
            {t("deviceActions.power")}{" "}
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
          {powerMenuOpen && (
            <div className="absolute right-0 top-full z-10 mt-1 w-48 rounded-md border bg-card shadow-lg">
              <button
                type="button"
                onClick={() => handleAction("reboot")}
                disabled={!online}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RotateCcw className="h-4 w-4" />
                {t("deviceActions.reboot")}{" "}
              </button>
              {device.os === "windows" && (
                <button
                  type="button"
                  onClick={() => handleAction("reboot_safe_mode")}
                  disabled={!online}
                  className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-warning hover:bg-warning/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Shield className="h-4 w-4" />
                  {t("deviceActions.rebootToSafeMode")}{" "}
                </button>
              )}
              <button
                type="button"
                onClick={() => handleAction("shutdown")}
                disabled={!online}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Power className="h-4 w-4" />
                {t("deviceActions.shutdown")}{" "}
              </button>
            </div>
          )}
        </div>
        <div className="relative">
          <button
            type="button"
            onClick={() => {
              setMenuOpen(!menuOpen);
              setPowerMenuOpen(false);
            }}
            disabled={loading}
            className="flex h-10 w-10 items-center justify-center rounded-md border bg-background transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full z-10 mt-1 w-48 rounded-md border bg-card shadow-lg">
              <button
                type="button"
                onClick={() => handleAction("refresh")}
                disabled={!online || loading}
                title={t("deviceActions.reRunAgentInventoryCollectorsSo")}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw className="h-4 w-4" />
                {t("deviceActions.refresh")}{" "}
              </button>
              <button
                type="button"
                onClick={() => handleAction("maintenance")}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
              >
                <Shield className="h-4 w-4" />
                {device.status === "maintenance"
                  ? t("deviceActions.exitMaintenance")
                  : t("deviceActions.enterMaintenance")}
              </button>
              <button
                type="button"
                onClick={() => handleAction("deploy-software")}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
              >
                <Package className="h-4 w-4" />
                {t("deviceActions.deploySoftware")}{" "}
              </button>
              <button
                type="button"
                onClick={() => handleAction("clear-sessions")}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
              >
                <XCircle className="h-4 w-4" />
                {t("deviceActions.clearSessions")}{" "}
              </button>
              <button
                type="button"
                onClick={() => handleAction("change-site")}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
              >
                <MapPin className="h-4 w-4" />
                {t("deviceActions.changeSite")}{" "}
              </button>
              <button
                type="button"
                onClick={() => handleAction("settings")}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
              >
                <Settings className="h-4 w-4" />
                {t("deviceActions.deviceSettings")}{" "}
              </button>
              <hr className="my-1" />
              <button
                type="button"
                onClick={() => handleAction("decommission")}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="h-4 w-4" />
                {t("deviceActions.decommission")}{" "}
              </button>
            </div>
          )}
        </div>
      </div>

      {modalCfg && (
        <ConfirmDialog
          open
          onClose={closeModal}
          onConfirm={handleConfirm}
          title={modalCfg.title}
          message={modalCfg.message}
          confirmLabel={modalCfg.confirmLabel}
          variant={modalCfg.variant}
          isLoading={loading}
        />
      )}
    </>
  );
}
