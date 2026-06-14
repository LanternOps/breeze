import { useState } from 'react';
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
  ChevronDown
} from 'lucide-react';
import type { Device } from './DeviceList';
import ConnectDesktopButton from '../remote/ConnectDesktopButton';
import { ConfirmDialog } from '../shared/ConfirmDialog';

type DeviceActionsProps = {
  device: Device;
  onAction?: (action: string, device: Device) => void;
  compact?: boolean;
};

type ModalType = 'none' | 'reboot' | 'reboot_safe_mode' | 'shutdown' | 'maintenance' | 'decommission' | 'clear-sessions';

type ModalConfigEntry = {
  title: string;
  message: string;
  confirmLabel: string;
  variant: 'destructive' | 'warning';
};

// Copy + variant for each confirm action. Rendered via the shared ConfirmDialog
// (which owns the focus trap, Escape, scroll-lock, portal, and animation) rather
// than a bespoke modal. `destructive` = irreversible/offline-inducing; everything
// else is `warning`.
function getModalConfig(type: Exclude<ModalType, 'none'>, device: Device): ModalConfigEntry {
  switch (type) {
    case 'reboot':
      return {
        title: 'Reboot Device',
        message: `Are you sure you want to reboot ${device.hostname}? This will temporarily disconnect the device and any active sessions.`,
        confirmLabel: 'Reboot',
        variant: 'warning',
      };
    case 'reboot_safe_mode':
      return {
        title: 'Reboot to Safe Mode',
        message: `Are you sure you want to reboot ${device.hostname} into Safe Mode with Networking? The device will boot into a minimal Windows environment with network access. The agent will automatically clear the safe mode flag so the next reboot returns to normal mode.`,
        confirmLabel: 'Reboot to Safe Mode',
        variant: 'warning',
      };
    case 'shutdown':
      return {
        title: 'Shutdown Device',
        message: `Are you sure you want to shutdown ${device.hostname}? The device will go offline and will need to be manually powered on again.`,
        confirmLabel: 'Shutdown',
        variant: 'destructive',
      };
    case 'maintenance':
      return device.status === 'maintenance'
        ? {
            title: 'Exit Maintenance Mode',
            message: `Are you sure you want to exit maintenance mode for ${device.hostname}? Alerting and monitoring will resume.`,
            confirmLabel: 'Exit Maintenance',
            variant: 'warning',
          }
        : {
            title: 'Enter Maintenance Mode',
            message: `Are you sure you want to put ${device.hostname} into maintenance mode? Alerting will be suppressed while in this mode.`,
            confirmLabel: 'Enter Maintenance',
            variant: 'warning',
          };
    case 'decommission':
      return {
        title: 'Decommission Device',
        message: `Are you sure you want to decommission ${device.hostname}? This will permanently remove the device from your fleet. The agent will stop reporting and the device will no longer be monitored.`,
        confirmLabel: 'Decommission',
        variant: 'destructive',
      };
    case 'clear-sessions':
      return {
        title: 'Clear Sessions',
        message: `End all active remote sessions for ${device.hostname}? This will disconnect any users currently connected via terminal, desktop, or file transfer.`,
        confirmLabel: 'Clear Sessions',
        variant: 'warning',
      };
  }
}

export default function DeviceActions({ device, onAction, compact = false }: DeviceActionsProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [powerMenuOpen, setPowerMenuOpen] = useState(false);
  const [modalType, setModalType] = useState<ModalType>('none');
  const [loading, setLoading] = useState(false);

  const closeMenus = () => {
    setMenuOpen(false);
    setPowerMenuOpen(false);
  };

  const handleAction = async (action: string) => {
    if (action === 'reboot' || action === 'reboot_safe_mode' || action === 'shutdown' || action === 'maintenance' || action === 'decommission' || action === 'clear-sessions') {
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
    if (modalType === 'none') return;

    setLoading(true);
    try {
      await onAction?.(modalType, device);
      setModalType('none');
    } finally {
      setLoading(false);
    }
  };

  const closeModal = () => {
    if (!loading) {
      setModalType('none');
    }
  };

  const modalCfg = modalType === 'none' ? null : getModalConfig(modalType, device);

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
                onClick={() => handleAction('run-script')}
                disabled={device.status === 'offline'}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Play className="h-4 w-4" />
                Run Script
              </button>
              <ConnectDesktopButton deviceId={device.id} compact disabled={device.status === 'offline'} isHeadless={device.isHeadless} desktopAccess={device.desktopAccess} remoteAccessPolicy={device.remoteAccessPolicy} />
              <button
                type="button"
                onClick={() => handleAction('remote-tools')}
                disabled={device.status === 'offline' || device.remoteAccessPolicy?.remoteTools === false}
                title={device.remoteAccessPolicy?.remoteTools === false ? `Remote tools disabled by policy${device.remoteAccessPolicy?.policyName ? ` "${device.remoteAccessPolicy.policyName}"` : ''}` : undefined}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Wrench className="h-4 w-4" />
                Remote Tools
              </button>
              <button
                type="button"
                onClick={() => handleAction('refresh')}
                disabled={device.status === 'offline'}
                title="Re-run agent inventory collectors so the UI sees fresh hardware/software/network data without waiting for the next heartbeat cycle"
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw className="h-4 w-4" />
                Refresh
              </button>
              <button
                type="button"
                onClick={() => handleAction('reboot')}
                disabled={device.status === 'offline'}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RotateCcw className="h-4 w-4" />
                Reboot
              </button>
              {device.status === 'offline' && (
                <button
                  type="button"
                  onClick={() => handleAction('wake')}
                  className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
                >
                  <Zap className="h-4 w-4" />
                  Wake
                </button>
              )}
              {device.os === 'windows' && (
                <button
                  type="button"
                  onClick={() => handleAction('reboot_safe_mode')}
                  disabled={device.status === 'offline'}
                  className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-warning hover:bg-warning/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Shield className="h-4 w-4" />
                  Reboot to Safe Mode
                </button>
              )}
              <button
                type="button"
                onClick={() => handleAction('deploy-software')}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
              >
                <Package className="h-4 w-4" />
                Deploy Software
              </button>
              <button
                type="button"
                onClick={() => handleAction('clear-sessions')}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
              >
                <XCircle className="h-4 w-4" />
                Clear Sessions
              </button>
              <hr className="my-1" />
              <button
                type="button"
                onClick={() => handleAction('change-site')}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
              >
                <MapPin className="h-4 w-4" />
                Change Site
              </button>
              <button
                type="button"
                onClick={() => handleAction('maintenance')}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
              >
                <Shield className="h-4 w-4" />
                {device.status === 'maintenance' ? 'Exit Maintenance' : 'Enter Maintenance'}
              </button>
              <hr className="my-1" />
              <button
                type="button"
                onClick={() => handleAction('decommission')}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="h-4 w-4" />
                Decommission
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
        {device.status === 'offline' && (
          <button
            type="button"
            onClick={() => handleAction('wake')}
            disabled={loading}
            title="Send a Wake-on-LAN packet via an online peer agent on the device's LAN"
            className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Zap className="h-4 w-4" />
            Wake
          </button>
        )}
        <button
          type="button"
          onClick={() => handleAction('run-script')}
          disabled={device.status === 'offline' || loading}
          title={device.status === 'offline' ? 'Device is offline' : undefined}
          className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Play className="h-4 w-4" />
          Run Script
        </button>
        <ConnectDesktopButton deviceId={device.id} disabled={device.status === 'offline'} isHeadless={device.isHeadless} desktopAccess={device.desktopAccess} remoteAccessPolicy={device.remoteAccessPolicy} />
        <button
          type="button"
          onClick={() => handleAction('remote-tools')}
          disabled={device.status === 'offline' || loading || device.remoteAccessPolicy?.remoteTools === false}
          title={device.status === 'offline' ? 'Device is offline' : device.remoteAccessPolicy?.remoteTools === false ? `Remote tools disabled by policy${device.remoteAccessPolicy?.policyName ? ` "${device.remoteAccessPolicy.policyName}"` : ''}` : undefined}
          className="flex items-center gap-2 rounded-md border bg-background px-4 py-2 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Wrench className="h-4 w-4" />
          Remote Tools
        </button>
        <div className="relative">
          <button
            type="button"
            onClick={() => { setPowerMenuOpen(!powerMenuOpen); setMenuOpen(false); }}
            disabled={loading}
            aria-haspopup="true"
            aria-expanded={powerMenuOpen}
            className="flex items-center gap-2 rounded-md border bg-background px-4 py-2 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Power className="h-4 w-4" />
            Power
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
          {powerMenuOpen && (
            <div className="absolute right-0 top-full z-10 mt-1 w-48 rounded-md border bg-card shadow-lg">
              <button
                type="button"
                onClick={() => handleAction('reboot')}
                disabled={device.status === 'offline'}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RotateCcw className="h-4 w-4" />
                Reboot
              </button>
              {device.os === 'windows' && (
                <button
                  type="button"
                  onClick={() => handleAction('reboot_safe_mode')}
                  disabled={device.status === 'offline'}
                  className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-warning hover:bg-warning/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Shield className="h-4 w-4" />
                  Reboot to Safe Mode
                </button>
              )}
              <button
                type="button"
                onClick={() => handleAction('shutdown')}
                disabled={device.status === 'offline'}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Power className="h-4 w-4" />
                Shutdown
              </button>
            </div>
          )}
        </div>
        <div className="relative">
          <button
            type="button"
            onClick={() => { setMenuOpen(!menuOpen); setPowerMenuOpen(false); }}
            disabled={loading}
            className="flex h-10 w-10 items-center justify-center rounded-md border bg-background transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full z-10 mt-1 w-48 rounded-md border bg-card shadow-lg">
              <button
                type="button"
                onClick={() => handleAction('refresh')}
                disabled={device.status === 'offline' || loading}
                title="Re-run agent inventory collectors so the UI sees fresh hardware/software/network data without waiting for the next heartbeat cycle"
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw className="h-4 w-4" />
                Refresh
              </button>
              <button
                type="button"
                onClick={() => handleAction('maintenance')}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
              >
                <Shield className="h-4 w-4" />
                {device.status === 'maintenance' ? 'Exit Maintenance' : 'Enter Maintenance'}
              </button>
              <button
                type="button"
                onClick={() => handleAction('deploy-software')}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
              >
                <Package className="h-4 w-4" />
                Deploy Software
              </button>
              <button
                type="button"
                onClick={() => handleAction('clear-sessions')}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
              >
                <XCircle className="h-4 w-4" />
                Clear Sessions
              </button>
              <button
                type="button"
                onClick={() => handleAction('change-site')}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
              >
                <MapPin className="h-4 w-4" />
                Change Site
              </button>
              <button
                type="button"
                onClick={() => handleAction('settings')}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
              >
                <Settings className="h-4 w-4" />
                Device Settings
              </button>
              <hr className="my-1" />
              <button
                type="button"
                onClick={() => handleAction('decommission')}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="h-4 w-4" />
                Decommission
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
