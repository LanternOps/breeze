import { useState } from 'react';
import {
  Play,
  RotateCcw,
  Monitor,
  Settings,
  Power,
  Shield,
  MoreHorizontal,
  X,
  AlertTriangle,
  Wrench,
  Trash2
} from 'lucide-react';
import type { Device } from './DeviceList';
import ConnectDesktopButton from '../remote/ConnectDesktopButton';

type DeviceActionsProps = {
  device: Device;
  onAction?: (action: string, device: Device) => void;
  compact?: boolean;
};

type ModalType = 'none' | 'reboot' | 'shutdown' | 'maintenance' | 'decommission';

export default function DeviceActions({ device, onAction, compact = false }: DeviceActionsProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [modalType, setModalType] = useState<ModalType>('none');
  const [loading, setLoading] = useState(false);

  const handleAction = async (action: string) => {
    if (action === 'reboot' || action === 'shutdown' || action === 'maintenance' || action === 'decommission') {
      setModalType(action);
      setMenuOpen(false);
      return;
    }

    setLoading(true);
    try {
      await onAction?.(action, device);
    } finally {
      setLoading(false);
      setMenuOpen(false);
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
              <ConnectDesktopButton deviceId={device.id} compact />
              <button
                type="button"
                onClick={() => handleAction('remote-tools')}
                disabled={device.status === 'offline'}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Wrench className="h-4 w-4" />
                Remote Tools
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
              <hr className="my-1" />
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

        {/* Confirmation Modals */}
        {modalType !== 'none' && (
          <ConfirmationModal
            type={modalType}
            device={device}
            loading={loading}
            onConfirm={handleConfirm}
            onCancel={closeModal}
          />
        )}
      </>
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => handleAction('run-script')}
          disabled={device.status === 'offline' || loading}
          className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Play className="h-4 w-4" />
          Run Script
        </button>
        <ConnectDesktopButton deviceId={device.id} />
        <button
          type="button"
          onClick={() => handleAction('remote-tools')}
          disabled={device.status === 'offline' || loading}
          className="flex items-center gap-2 rounded-md border bg-background px-4 py-2 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Wrench className="h-4 w-4" />
          Remote Tools
        </button>
        <button
          type="button"
          onClick={() => handleAction('reboot')}
          disabled={device.status === 'offline' || loading}
          className="flex items-center gap-2 rounded-md border bg-background px-4 py-2 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
        >
          <RotateCcw className="h-4 w-4" />
          Reboot
        </button>

        <div className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen(!menuOpen)}
            disabled={loading}
            className="flex h-10 w-10 items-center justify-center rounded-md border bg-background transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full z-10 mt-1 w-48 rounded-md border bg-card shadow-lg">
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
                onClick={() => handleAction('shutdown')}
                disabled={device.status === 'offline'}
                className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Power className="h-4 w-4" />
                Shutdown
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

      {/* Confirmation Modals */}
      {modalType !== 'none' && (
        <ConfirmationModal
          type={modalType}
          device={device}
          loading={loading}
          onConfirm={handleConfirm}
          onCancel={closeModal}
        />
      )}
    </>
  );
}

type ConfirmationModalProps = {
  type: ModalType;
  device: Device;
  loading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

function ConfirmationModal({ type, device, loading, onConfirm, onCancel }: ConfirmationModalProps) {
  const modalConfig = {
    reboot: {
      title: 'Reboot Device',
      description: `Are you sure you want to reboot ${device.hostname}? This will temporarily disconnect the device and any active sessions.`,
      confirmLabel: 'Reboot',
      confirmClass: 'bg-yellow-600 text-white hover:bg-yellow-700'
    },
    shutdown: {
      title: 'Shutdown Device',
      description: `Are you sure you want to shutdown ${device.hostname}? The device will go offline and will need to be manually powered on again.`,
      confirmLabel: 'Shutdown',
      confirmClass: 'bg-destructive text-destructive-foreground hover:opacity-90'
    },
    maintenance: {
      title: device.status === 'maintenance' ? 'Exit Maintenance Mode' : 'Enter Maintenance Mode',
      description: device.status === 'maintenance'
        ? `Are you sure you want to exit maintenance mode for ${device.hostname}? Alerting and monitoring will resume.`
        : `Are you sure you want to put ${device.hostname} into maintenance mode? Alerting will be suppressed while in this mode.`,
      confirmLabel: device.status === 'maintenance' ? 'Exit Maintenance' : 'Enter Maintenance',
      confirmClass: 'bg-primary text-primary-foreground hover:opacity-90'
    },
    decommission: {
      title: 'Decommission Device',
      description: `Are you sure you want to decommission ${device.hostname}? This will permanently remove the device from your fleet. The agent will stop reporting and the device will no longer be monitored.`,
      confirmLabel: 'Decommission',
      confirmClass: 'bg-destructive text-destructive-foreground hover:opacity-90'
    },
    none: {
      title: '',
      description: '',
      confirmLabel: '',
      confirmClass: ''
    }
  };

  const config = modalConfig[type];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className={`flex h-10 w-10 items-center justify-center rounded-full ${
              type === 'shutdown' || type === 'decommission' ? 'bg-destructive/10' : 'bg-yellow-500/10'
            }`}>
              <AlertTriangle className={`h-5 w-5 ${
                type === 'shutdown' || type === 'decommission' ? 'text-destructive' : 'text-yellow-600'
              }`} />
            </div>
            <h2 className="text-lg font-semibold">{config.title}</h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted disabled:cursor-not-allowed"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mt-4 text-sm text-muted-foreground">{config.description}</p>

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className={`inline-flex h-10 items-center justify-center rounded-md px-4 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${config.confirmClass}`}
          >
            {loading ? (
              <>
                <span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                Processing...
              </>
            ) : (
              config.confirmLabel
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
