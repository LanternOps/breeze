import { createContext, useContext, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { useMenuKeyboard } from "../billing/shared/menuKeyboard";
import { usePermissions } from "../../lib/permissions";
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
  Beer,
  MapPin,
  Zap,
  ChevronDown,
  ArrowRightLeft,
} from "lucide-react";
import type { Device, DeviceStatus } from "./DeviceList";
import ConnectDesktopButton from "../remote/ConnectDesktopButton";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import RemoveDeviceDialog from "./RemoveDeviceDialog";
import { DelegateToOperatorButton } from "../aiOperator/DelegateToOperatorButton";
import { isInMaintenance } from "../../lib/maintenanceResource";
import { useCanMoveDeviceOrg } from "@/lib/moveOrgCapability";
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
// Known inconsistency: the DeviceList row menu and the grid card gate queued
// commands on `isCommandQueueable` (decommissioned-only), while this action bar
// still gates them on `!online` — so an offline device shows Reboot enabled in
// the list and grid but disabled here. This is stricter, not broken. When
// aligning it, use `isCommandQueueable`/`notQueueableTitle` from
// bulkActionGating.ts rather than re-deriving the rule, and drop the private
// `unavailableTitle` switch below in favour of `notOnlineTitle`.
//
// The `!online` gates on Connect Desktop and Remote Tools are correct — those
// are live sessions.
// Do not copy the queued-command gates to new surfaces, and do not "fix" a
// missing gate by adding one; gate queued commands on `decommissioned`
// (see DeviceList.tsx). Wake (Wake-on-LAN) targets offline devices by design
// and is never gated.
// Header button variants (#9026): one height for the whole row; the filled
// variant is reserved for the single primary action.
const HEADER_BUTTON =
  "inline-flex h-9 items-center gap-2 rounded-md px-4 text-sm font-medium transition";
const FILLED_BUTTON = `${HEADER_BUTTON} bg-primary text-primary-foreground hover:opacity-90 aria-disabled:cursor-progress`;
const OUTLINE_BUTTON = `${HEADER_BUTTON} border bg-background hover:bg-muted aria-disabled:cursor-not-allowed aria-disabled:text-muted-foreground aria-disabled:hover:bg-background`;

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

/**
 * Extra answers a confirm dialog collected from the operator (#3987). Today
 * only Remove has one: whether to queue the agent uninstall. Passed through to
 * the page-level handler, which turns it into the DELETE body.
 */
export interface DeviceActionOptions {
  uninstallAgent?: boolean;
  /**
   * Set by a page-owned confirm dialog to mean "this already passed a gate,
   * execute it" (#5023). Never sent by an action trigger — a handler keying on
   * its absence is therefore gated for every present and future caller, which
   * is the same guarantee `uninstallAgent`'s absence gives Remove.
   */
  confirmed?: boolean;
}

type DeviceActionsProps = {
  device: Device;
  onAction?: (action: string, device: Device, opts?: DeviceActionOptions) => void | Promise<void>;
  compact?: boolean;
};

type ModalType =
  | "none"
  | "reboot"
  | "reboot_safe_mode"
  | "shutdown"
  | "maintenance"
  | "decommission"
  | "clear-sessions"
  | "install-homebrew";

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
  // `decommission` is deliberately absent: RemoveDeviceDialog owns the Remove
  // copy (#3987) because Remove asks a question rather than posing a yes/no.
  type: Exclude<ModalType, "none" | "decommission">,
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
    // RMM-QA-176 D10: only EXIT still confirms. Entry needs a reason, a
    // duration and possibly a step-up factor, none of which a yes/no confirm
    // can collect — `handleAction` routes it to the parent's
    // MaintenanceModeDialog instead, so this case is only reached for exit.
    // (The `deviceActions.confirm.enterMaintenance.*` keys stay in the locale
    // files: nothing else reads them, and deleting a key across eight locales
    // to re-add it later is churn.)
    case "maintenance":
      return {
        title: t("deviceActions.confirm.exitMaintenance.title"),
        message: t("deviceActions.confirm.exitMaintenance.message", {
          hostname: device.hostname,
        }),
        confirmLabel: t("deviceActions.confirm.exitMaintenance.confirm"),
        variant: "warning",
      };
    case "install-homebrew":
      return {
        title: t("deviceActions.confirm.installHomebrew.title"),
        message: t("deviceActions.confirm.installHomebrew.message"),
        confirmLabel: t("deviceActions.confirm.installHomebrew.confirm"),
        variant: "warning",
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

// Menu-button pattern shared by the "…" and Power menus (#9025), built on the
// same useMenuKeyboard hook the other action menus use: aria-expanded/haspopup
// live on the trigger (the first [aria-haspopup] inside the root), the popup is
// role="menu", focus moves in on open, arrows/Home/End/Tab are handled, and
// Escape or an outside mousedown closes (Escape also returns focus).
const DropdownContext = createContext<{
  open: boolean;
  listRef: RefObject<HTMLDivElement | null>;
  onKeyDown: (e: ReactKeyboardEvent) => void;
}>({ open: false, listRef: { current: null }, onKeyDown: () => {} });

function DropdownRoot({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { listRef, onKeyDown: onMenuKeyDown } = useMenuKeyboard(open, onClose);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open, onClose]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (!open) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      rootRef.current?.querySelector<HTMLElement>("[aria-haspopup]")?.focus();
      return;
    }
    onMenuKeyDown(e);
  };

  return (
    <DropdownContext.Provider value={{ open, listRef, onKeyDown }}>
      <div ref={rootRef} className="relative" onKeyDown={onKeyDown}>
        {children}
      </div>
    </DropdownContext.Provider>
  );
}

function DropdownPopup({ children }: { children: ReactNode }) {
  const { open, listRef } = useContext(DropdownContext);
  if (!open) return null;
  return (
    <div
      ref={listRef}
      role="menu"
      // aria-disabled items stay focusable so their reason (title) is
      // reachable by keyboard; their activation is swallowed here.
      onClickCapture={(e) => {
        if ((e.target as HTMLElement).closest('[aria-disabled="true"]')) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      className="absolute right-0 top-full z-10 mt-1 w-48 rounded-md border bg-card shadow-lg"
    >
      {children}
    </div>
  );
}

export default function DeviceActions({
  device,
  onAction,
  compact = false,
}: DeviceActionsProps) {
  const { t } = useTranslation("devices");
  const { can } = usePermissions();
  // UX gate; POST /devices/:id/commands requires devices.execute.
  const canWake = can("devices", "execute");
  // UX gate; every /system-tools route (including the process, service, file
  // and registry listings) runs a live command on the device and requires
  // devices.execute, so read-only roles are not offered Remote Tools.
  const canUseRemoteTools = can("devices", "execute");
  const canMoveOrg = useCanMoveDeviceOrg();
  const [menuOpen, setMenuOpen] = useState(false);
  const [powerMenuOpen, setPowerMenuOpen] = useState(false);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  const powerTriggerRef = useRef<HTMLButtonElement>(null);
  const [modalType, setModalType] = useState<ModalType>("none");
  const [loading, setLoading] = useState(false);
  const offlineReasonId = useId();
  const remoteToolsReasonId = useId();

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
    // Return focus to the open menu's trigger before the item unmounts, so a
    // dialog opened by the action restores focus there rather than to <body>.
    if (menuOpen) moreTriggerRef.current?.focus();
    else if (powerMenuOpen) powerTriggerRef.current?.focus();
    if (
      action === "reboot" ||
      action === "reboot_safe_mode" ||
      action === "shutdown" ||
      // Entry falls THROUGH to the parent (see getModalConfig); only exit
      // confirms here.
      (action === "maintenance" && isInMaintenance(device)) ||
      action === "decommission" ||
      action === "clear-sessions" ||
      action === "install-homebrew"
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

  const handleConfirm = async (opts?: DeviceActionOptions) => {
    if (modalType === "none") return;

    setLoading(true);
    try {
      // Only Remove collects an answer. Forwarding a bare `undefined` for every
      // other action would change its call arity for no reason, so the two
      // shapes stay distinct.
      await (opts
        ? onAction?.(modalType, device, opts)
        : onAction?.(modalType, device));
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
    modalType === "none" || modalType === "decommission"
      ? null
      : getModalConfig(modalType, device, t);

  // Same JSX, testids, and handlers rendered by both the compact and full
  // menu below — computed once so the two variants can't drift.
  const removeOrRestoreMenuItems =
    device.status === "decommissioned" ? (
      <>
        <button
          type="button"
          data-testid="device-action-restore"
          onClick={() => handleAction("restore")}
          role="menuitem"
          tabIndex={-1}
          className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-success hover:bg-success/10"
        >
          <RotateCcw className="h-4 w-4" />
          {t("deviceActions.restore")}
        </button>
        <button
          type="button"
          data-testid="device-action-permanent-delete"
          onClick={() => handleAction("permanent-delete")}
          role="menuitem"
          tabIndex={-1}
          className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-destructive hover:bg-destructive/10"
        >
          <Trash2 className="h-4 w-4" />
          {t("deviceActions.permanentlyDelete")}
        </button>
      </>
    ) : (
      <button
        type="button"
        data-testid="device-action-remove"
        onClick={() => handleAction("decommission")}
        role="menuitem"
        tabIndex={-1}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-destructive hover:bg-destructive/10"
      >
        <Trash2 className="h-4 w-4" />
        {t("deviceActions.decommission")}{" "}
      </button>
    );

  if (compact) {
    return (
      <>
        <DropdownRoot open={menuOpen} onClose={closeMenus}>
          <button
            type="button"
            ref={moreTriggerRef}
            data-testid="device-actions-menu"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={t("deviceActions.moreActions")}
            title={t("deviceActions.moreActions")}
            onClick={() => setMenuOpen(!menuOpen)}
            className="flex h-9 w-9 items-center justify-center rounded-md border hover:bg-muted"
          >
            <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
          </button>
          <DropdownPopup>
              <button
                type="button"
                onClick={() => handleAction("run-script")}
                aria-disabled={(!online) || undefined}
                role="menuitem"
                tabIndex={-1}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
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
                helperLifecycleMode={device.helperLifecycleMode}
              />
              {canUseRemoteTools && (
                <button
                  type="button"
                  onClick={() => handleAction("remote-tools")}
                  aria-disabled={
                    !online || device.remoteAccessPolicy?.remoteTools === false
                      ? true
                      : undefined
                  }
                  title={
                    offlineTitle ??
                    (device.remoteAccessPolicy?.remoteTools === false
                      ? `Remote tools disabled by policy${device.remoteAccessPolicy?.policyName ? ` "${device.remoteAccessPolicy.policyName}"` : ""}`
                      : undefined)
                  }
                  role="menuitem"
                  tabIndex={-1}
                  className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                >
                  <Wrench className="h-4 w-4" />
                  {t("deviceActions.remoteTools")}{" "}
                </button>
              )}
              <button
                type="button"
                onClick={() => handleAction("refresh")}
                aria-disabled={(!online) || undefined}
                title={t("deviceActions.reRunAgentInventoryCollectorsSo")}
                role="menuitem"
                tabIndex={-1}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
              >
                <RefreshCw className="h-4 w-4" />
                {t("deviceActions.refresh")}{" "}
              </button>
              <button
                type="button"
                onClick={() => handleAction("reboot")}
                aria-disabled={(!online) || undefined}
                role="menuitem"
                tabIndex={-1}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
              >
                <RotateCcw className="h-4 w-4" />
                {t("deviceActions.reboot")}{" "}
              </button>
              {canWake && device.status === "offline" && (
                <button
                  type="button"
                  onClick={() => handleAction("wake")}
                  role="menuitem"
                  tabIndex={-1}
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
                  aria-disabled={(!online) || undefined}
                  role="menuitem"
                  tabIndex={-1}
                  className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-warning hover:bg-warning/10 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                >
                  <Shield className="h-4 w-4" />
                  {t("deviceActions.rebootToSafeMode")}{" "}
                </button>
              )}
              <button
                type="button"
                onClick={() => handleAction("deploy-software")}
                role="menuitem"
                tabIndex={-1}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
              >
                <Package className="h-4 w-4" />
                {t("deviceActions.deploySoftware")}{" "}
              </button>
{device.os === "macos" && (
                <button
                  type="button"
                  data-testid="device-install-homebrew"
                  onClick={() => handleAction("install-homebrew")}
                  role="menuitem"
                  tabIndex={-1}
                  className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
                >
                  <Beer className="h-4 w-4" />
                  {t("deviceActions.installHomebrew")}{" "}
                </button>
              )}
                            <button
                type="button"
                onClick={() => handleAction("clear-sessions")}
                role="menuitem"
                tabIndex={-1}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
              >
                <XCircle className="h-4 w-4" />
                {t("deviceActions.clearSessions")}{" "}
              </button>
              <hr className="my-1" />
              <button
                type="button"
                onClick={() => handleAction("change-site")}
                role="menuitem"
                tabIndex={-1}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
              >
                <MapPin className="h-4 w-4" />
                {t("deviceActions.changeSite")}{" "}
              </button>
              <button
                type="button"
                onClick={() => handleAction("maintenance")}
                role="menuitem"
                tabIndex={-1}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
              >
                <Shield className="h-4 w-4" />
                {isInMaintenance(device)
                  ? t("deviceActions.exitMaintenance")
                  : t("deviceActions.enterMaintenance")}
              </button>
              <hr className="my-1" />
              {removeOrRestoreMenuItems}
            </DropdownPopup>
        </DropdownRoot>

        {modalType === "decommission" ? (
          <RemoveDeviceDialog
            open
            targets={[{ hostname: device.hostname, status: device.status }]}
            onClose={closeModal}
            onConfirm={(choice) => void handleConfirm(choice)}
            isLoading={loading}
            confirmTestId="device-actions-remove-confirm"
          />
        ) : modalCfg && (
          <ConfirmDialog
            open
            onClose={closeModal}
            onConfirm={() => void handleConfirm()}
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

  // #9026: exactly one filled primary — Run Script while online, Wake while
  // offline. Anything unavailable renders as the outline variant (never a
  // faded filled button) and stays focusable via aria-disabled, with its reason
  // wired through aria-describedby so keyboard and screen-reader users get it.
  const showWake = canWake && device.status === "offline";
  const remoteToolsPolicyTitle =
    device.remoteAccessPolicy?.remoteTools === false
      ? `Remote tools disabled by policy${device.remoteAccessPolicy?.policyName ? ` "${device.remoteAccessPolicy.policyName}"` : ""}`
      : undefined;
  const remoteToolsTitle = offlineTitle ?? remoteToolsPolicyTitle;
  const remoteToolsUnavailable =
    !online || device.remoteAccessPolicy?.remoteTools === false;

  return (
    <>
      <div data-testid="device-header-actions" className="flex flex-wrap items-center gap-2">
        {offlineTitle && (
          <span id={offlineReasonId} className="sr-only">
            {offlineTitle}
          </span>
        )}
        {remoteToolsTitle && remoteToolsTitle !== offlineTitle && (
          <span id={remoteToolsReasonId} className="sr-only">
            {remoteToolsTitle}
          </span>
        )}
        {/* When the device is offline, Wake is the one action that matters —
            promote it to the primary header button instead of burying it in the
            Power dropdown, where every other action is disabled anyway. */}
        {showWake && (
          <button
            type="button"
            onClick={() => {
              if (!loading) void handleAction("wake");
            }}
            aria-disabled={loading || undefined}
            title={t("deviceActions.sendAWakeOnLanPacket")}
            className={FILLED_BUTTON}
          >
            <Zap className="h-4 w-4" aria-hidden="true" />
            {t("deviceActions.wake")}{" "}
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            if (online && !loading) void handleAction("run-script");
          }}
          aria-disabled={!online || loading ? true : undefined}
          title={offlineTitle}
          aria-describedby={offlineTitle ? offlineReasonId : undefined}
          className={online ? FILLED_BUTTON : OUTLINE_BUTTON}
        >
          <Play className="h-4 w-4" aria-hidden="true" />
          {t("deviceActions.runScript")}{" "}
        </button>
        {/* W08 of #5205 (#5246). Renders nothing unless the AI Operator flags
            are on, so this row is unchanged for every deployment that has not
            enabled the feature (decision D2: internal/test orgs only). No
            `online` gate: a task is durable work with its own deadline, not an
            immediate command — the coordinator waits for the device rather
            than the technician having to. */}
        <DelegateToOperatorButton
          orgId={device.orgId}
          deviceId={device.id}
          deviceLabel={device.displayName || device.hostname}
          orgLabel={device.orgName}
          source={{ kind: "device", id: device.id }}
          className={OUTLINE_BUTTON}
        />
        <ConnectDesktopButton
          deviceId={device.id}
          disabled={!online}
          disabledTitle={offlineTitle}
          isHeadless={device.isHeadless}
          desktopAccess={device.desktopAccess}
          remoteAccessPolicy={device.remoteAccessPolicy}
          helperLifecycleMode={device.helperLifecycleMode}
        />
        {canUseRemoteTools && (
          <button
            type="button"
            onClick={() => {
              if (!remoteToolsUnavailable && !loading) void handleAction("remote-tools");
            }}
            aria-disabled={remoteToolsUnavailable || loading ? true : undefined}
            title={remoteToolsTitle}
            aria-describedby={
              remoteToolsTitle
                ? remoteToolsTitle === offlineTitle
                  ? offlineReasonId
                  : remoteToolsReasonId
                : undefined
            }
            className={OUTLINE_BUTTON}
          >
            <Wrench className="h-4 w-4" aria-hidden="true" />
            {t("deviceActions.remoteTools")}{" "}
          </button>
        )}
        <DropdownRoot open={powerMenuOpen} onClose={closeMenus}>
          <button
            type="button"
            onClick={() => {
              if (!online || loading) return;
              setPowerMenuOpen(!powerMenuOpen);
              setMenuOpen(false);
            }}
            aria-disabled={!online || loading ? true : undefined}
            title={offlineTitle}
            aria-describedby={offlineTitle ? offlineReasonId : undefined}
            ref={powerTriggerRef}
            data-testid="device-power-menu"
            aria-haspopup="menu"
            aria-expanded={powerMenuOpen}
            className={OUTLINE_BUTTON}
          >
            <Power className="h-4 w-4" />
            {t("deviceActions.power")}{" "}
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
          <DropdownPopup>
              <button
                type="button"
                onClick={() => handleAction("reboot")}
                aria-disabled={(!online) || undefined}
                role="menuitem"
                tabIndex={-1}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
              >
                <RotateCcw className="h-4 w-4" />
                {t("deviceActions.reboot")}{" "}
              </button>
              {device.os === "windows" && (
                <button
                  type="button"
                  onClick={() => handleAction("reboot_safe_mode")}
                  aria-disabled={(!online) || undefined}
                  role="menuitem"
                  tabIndex={-1}
                  className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-warning hover:bg-warning/10 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                >
                  <Shield className="h-4 w-4" />
                  {t("deviceActions.rebootToSafeMode")}{" "}
                </button>
              )}
              <button
                type="button"
                onClick={() => handleAction("shutdown")}
                aria-disabled={(!online) || undefined}
                role="menuitem"
                tabIndex={-1}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-destructive hover:bg-destructive/10 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
              >
                <Power className="h-4 w-4" />
                {t("deviceActions.shutdown")}{" "}
              </button>
              <hr className="my-1" />
              {/* #4936: maintenance is a DB flag, not an agent command, so it
                  carries no `!online` gate of its own — it is the action you
                  want immediately before the Reboot above. Same label logic and
                  same ConfirmDialog route as the "…" menu entry. NOTE: the
                  Power BUTTON keeps its pre-existing `!online` gate (#2013), so
                  for a device already in maintenance this dropdown cannot open
                  and exit stays on the "…" menu; relaxing that gate is pinned by
                  test and deliberately not touched here. */}
              <button
                type="button"
                data-testid="device-power-action-maintenance"
                onClick={() => handleAction("maintenance")}
                role="menuitem"
                tabIndex={-1}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
              >
                <Shield className="h-4 w-4" />
                {isInMaintenance(device)
                  ? t("deviceActions.exitMaintenance")
                  : t("deviceActions.enterMaintenance")}
              </button>
            </DropdownPopup>
        </DropdownRoot>
        <DropdownRoot open={menuOpen} onClose={closeMenus}>
          <button
            type="button"
            ref={moreTriggerRef}
            data-testid="device-actions-menu"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={t("deviceActions.moreActions")}
            title={t("deviceActions.moreActions")}
            onClick={() => {
              if (loading) return;
              setMenuOpen(!menuOpen);
              setPowerMenuOpen(false);
            }}
            aria-disabled={loading ? true : undefined}
            className="flex h-9 w-9 items-center justify-center rounded-md border bg-background transition hover:bg-muted aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
          >
            <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
          </button>
          <DropdownPopup>
              <button
                type="button"
                onClick={() => handleAction("refresh")}
                aria-disabled={(!online || loading) || undefined}
                title={t("deviceActions.reRunAgentInventoryCollectorsSo")}
                role="menuitem"
                tabIndex={-1}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
              >
                <RefreshCw className="h-4 w-4" />
                {t("deviceActions.refresh")}{" "}
              </button>
              <button
                type="button"
                onClick={() => handleAction("maintenance")}
                role="menuitem"
                tabIndex={-1}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
              >
                <Shield className="h-4 w-4" />
                {isInMaintenance(device)
                  ? t("deviceActions.exitMaintenance")
                  : t("deviceActions.enterMaintenance")}
              </button>
              <button
                type="button"
                onClick={() => handleAction("deploy-software")}
                role="menuitem"
                tabIndex={-1}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
              >
                <Package className="h-4 w-4" />
                {t("deviceActions.deploySoftware")}{" "}
              </button>
{device.os === "macos" && (
                <button
                  type="button"
                  data-testid="device-install-homebrew"
                  onClick={() => handleAction("install-homebrew")}
                  role="menuitem"
                  tabIndex={-1}
                  className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
                >
                  <Beer className="h-4 w-4" />
                  {t("deviceActions.installHomebrew")}{" "}
                </button>
              )}
                            <button
                type="button"
                onClick={() => handleAction("clear-sessions")}
                role="menuitem"
                tabIndex={-1}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
              >
                <XCircle className="h-4 w-4" />
                {t("deviceActions.clearSessions")}{" "}
              </button>
              <button
                type="button"
                onClick={() => handleAction("change-site")}
                role="menuitem"
                tabIndex={-1}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
              >
                <MapPin className="h-4 w-4" />
                {t("deviceActions.changeSite")}{" "}
              </button>
              {/* Full menu only: DeviceDetailPage is the one host that handles
                  "move-org"; the compact variant has no consumer that would. */}
              {canMoveOrg && (
                <button
                  type="button"
                  data-testid="device-action-move-org"
                  onClick={() => handleAction("move-org")}
                  role="menuitem"
                  tabIndex={-1}
                  className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
                >
                  <ArrowRightLeft className="h-4 w-4" />
                  {t("deviceActions.moveOrg")}{" "}
                </button>
              )}
              <button
                type="button"
                onClick={() => handleAction("settings")}
                role="menuitem"
                tabIndex={-1}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
              >
                <Settings className="h-4 w-4" />
                {t("deviceActions.deviceSettings")}{" "}
              </button>
              <hr className="my-1" />
              {removeOrRestoreMenuItems}
            </DropdownPopup>
        </DropdownRoot>
      </div>

      {modalType === "decommission" ? (
        <RemoveDeviceDialog
          open
          targets={[{ hostname: device.hostname, status: device.status }]}
          onClose={closeModal}
          onConfirm={(choice) => void handleConfirm(choice)}
          isLoading={loading}
          confirmTestId="device-actions-remove-confirm"
        />
      ) : modalCfg && (
        <ConfirmDialog
          open
          onClose={closeModal}
          onConfirm={() => void handleConfirm()}
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
