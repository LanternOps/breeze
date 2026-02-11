import { useState, useEffect, useCallback } from 'react';
import { ShieldAlert, CheckCircle, XCircle, RefreshCw, AlertTriangle, X } from 'lucide-react';

type QuarantinedDevice = {
  id: string;
  agentId: string;
  hostname: string;
  osType: string;
  quarantinedAt: string;
  quarantinedReason: string;
};

type ModalState = {
  type: 'none' | 'deny';
  device: QuarantinedDevice | null;
};

const osLabels: Record<string, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  darwin: 'macOS'
};

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

export default function QuarantinedDevices() {
  const [devices, setDevices] = useState<QuarantinedDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>({ type: 'none', device: null });

  const fetchDevices = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetch('/api/v1/agents/quarantined');
      if (!response.ok) {
        throw new Error('Failed to fetch quarantined devices');
      }
      const data = await response.json();
      setDevices(data.devices ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDevices();
  }, [fetchDevices]);

  const handleApprove = async (device: QuarantinedDevice) => {
    setActionLoading(device.id);
    setError(undefined);
    try {
      const response = await fetch(`/api/v1/agents/${device.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      if (!response.ok) {
        throw new Error('Failed to approve device');
      }
      await fetchDevices();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to approve device');
    } finally {
      setActionLoading(null);
    }
  };

  const handleDenyConfirm = async () => {
    if (!modal.device) return;
    setActionLoading(modal.device.id);
    setError(undefined);
    try {
      const response = await fetch(`/api/v1/agents/${modal.device.id}/deny`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      if (!response.ok) {
        throw new Error('Failed to deny device');
      }
      setModal({ type: 'none', device: null });
      await fetchDevices();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to deny device');
    } finally {
      setActionLoading(null);
    }
  };

  const handleCloseModal = () => {
    if (actionLoading) return;
    setModal({ type: 'none', device: null });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">Loading quarantined devices...</p>
        </div>
      </div>
    );
  }

  if (error && devices.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchDevices}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Quarantined Devices</h1>
          <p className="text-muted-foreground">
            Devices quarantined due to expired or invalid mTLS certificates. Approve to re-issue
            certificates or deny to decommission.
          </p>
        </div>
        <button
          type="button"
          onClick={fetchDevices}
          disabled={loading}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md border bg-background px-4 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {devices.length === 0 ? (
        <div className="rounded-lg border bg-card p-12 text-center">
          <ShieldAlert className="mx-auto h-12 w-12 text-muted-foreground/40" />
          <h3 className="mt-4 text-lg font-semibold">No quarantined devices</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            All devices have valid mTLS certificates. Devices with expired or revoked certificates
            will appear here for review.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border bg-card shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Hostname</th>
                  <th className="px-4 py-3 font-medium">OS</th>
                  <th className="px-4 py-3 font-medium">Quarantined At</th>
                  <th className="px-4 py-3 font-medium">Reason</th>
                  <th className="px-4 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {devices.map((device) => {
                  const isActionLoading = actionLoading === device.id;
                  return (
                    <tr key={device.id} className="border-t">
                      <td className="px-4 py-3">
                        <div>
                          <span className="font-medium">{device.hostname}</span>
                          <p className="text-xs text-muted-foreground">{device.agentId}</p>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {osLabels[device.osType] ?? device.osType}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {formatDate(device.quarantinedAt)}
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-700">
                          {device.quarantinedReason}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => handleApprove(device)}
                            disabled={isActionLoading}
                            className="inline-flex h-9 items-center gap-2 rounded-md bg-emerald-600 px-3 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {isActionLoading ? (
                              <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                            ) : (
                              <CheckCircle className="h-4 w-4" />
                            )}
                            Approve
                          </button>
                          <button
                            type="button"
                            onClick={() => setModal({ type: 'deny', device })}
                            disabled={isActionLoading}
                            className="inline-flex h-9 items-center gap-2 rounded-md bg-destructive px-3 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <XCircle className="h-4 w-4" />
                            Deny
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="border-t px-4 py-3">
            <p className="text-sm text-muted-foreground">
              {devices.length} quarantined device{devices.length === 1 ? '' : 's'}
            </p>
          </div>
        </div>
      )}

      {/* Deny Confirmation Modal */}
      {modal.type === 'deny' && modal.device && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-destructive/10">
                  <AlertTriangle className="h-5 w-5 text-destructive" />
                </div>
                <h2 className="text-lg font-semibold">Deny Device</h2>
              </div>
              <button
                type="button"
                onClick={handleCloseModal}
                disabled={!!actionLoading}
                className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted disabled:cursor-not-allowed"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <p className="mt-4 text-sm text-muted-foreground">
              Are you sure you want to deny <span className="font-medium text-foreground">{modal.device.hostname}</span>?
              This will permanently decommission the device and revoke its certificate.
              The agent will stop reporting and the device will no longer be managed.
            </p>

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={handleCloseModal}
                disabled={!!actionLoading}
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDenyConfirm}
                disabled={!!actionLoading}
                className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {actionLoading === modal.device.id ? (
                  <>
                    <span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    Denying...
                  </>
                ) : (
                  'Deny & Decommission'
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
