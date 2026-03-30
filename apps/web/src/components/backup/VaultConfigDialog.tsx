import { useCallback, useEffect, useState } from 'react';
import { HardDrive, Loader2, Server, Usb, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';

// ── Types ──────────────────────────────────────────────────────────

type VaultType = 'local' | 'smb' | 'usb';

type Vault = {
  id: string;
  deviceId: string;
  vaultPath: string;
  type: VaultType;
  retentionCount?: number | null;
  [key: string]: unknown;
};

type Device = {
  id: string;
  hostname: string;
};

type VaultConfigDialogProps = {
  vault: Vault | null;
  onClose: (saved?: boolean) => void;
};

const typeOptions: { value: VaultType; label: string; icon: typeof HardDrive; description: string }[] = [
  { value: 'local', label: 'Local', icon: HardDrive, description: 'Local disk path' },
  { value: 'smb', label: 'SMB', icon: Server, description: 'Network SMB share' },
  { value: 'usb', label: 'USB', icon: Usb, description: 'USB attached storage' },
];

// ── Component ─────────────────────────────────────────────────────

export default function VaultConfigDialog({ vault, onClose }: VaultConfigDialogProps) {
  const isEdit = !!vault;

  const [deviceId, setDeviceId] = useState(vault?.deviceId ?? '');
  const [vaultPath, setVaultPath] = useState(vault?.vaultPath ?? '');
  const [vaultType, setVaultType] = useState<VaultType>(vault?.type ?? 'local');
  const [retentionCount, setRetentionCount] = useState(vault?.retentionCount ?? 3);
  const [devices, setDevices] = useState<Device[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const fetchDevices = async () => {
      setDevicesLoading(true);
      try {
        const response = await fetchWithAuth('/devices');
        if (response.ok) {
          const payload = await response.json();
          const data = payload?.data ?? payload ?? [];
          setDevices(Array.isArray(data) ? data : []);
        }
      } catch {
        // Silently fail; user can type device ID manually
      } finally {
        setDevicesLoading(false);
      }
    };
    fetchDevices();
  }, []);

  const handleSave = useCallback(async () => {
    setError(undefined);

    if (!deviceId.trim()) {
      setError('Please select a device');
      return;
    }
    if (!vaultPath.trim()) {
      setError('Please enter a vault path');
      return;
    }
    if (retentionCount < 1 || retentionCount > 100) {
      setError('Retention count must be between 1 and 100');
      return;
    }

    setSaving(true);
    try {
      const body = {
        deviceId,
        vaultPath,
        type: vaultType,
        retentionCount,
      };

      const url = isEdit ? `/backup/vault/${vault.id}` : '/backup/vault';
      const method = isEdit ? 'PATCH' : 'POST';

      const response = await fetchWithAuth(url, {
        method,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Failed to ${isEdit ? 'update' : 'create'} vault`);
      }

      onClose(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSaving(false);
    }
  }, [deviceId, isEdit, onClose, retentionCount, vault?.id, vaultPath, vaultType]);

  const placeholderExamples: Record<VaultType, string> = {
    local: '/mnt/backup/vault or D:\\Backups\\Vault',
    smb: '\\\\nas-01\\backups\\vault',
    usb: 'E:\\BreeezeVault',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-xl">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-foreground">
            {isEdit ? 'Edit Vault' : 'Add Vault'}
          </h3>
          <button
            type="button"
            onClick={() => onClose()}
            className="rounded-md p-1 hover:bg-muted"
          >
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>

        {error && (
          <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="mt-4 space-y-4">
          {/* Device Picker */}
          <div>
            <label htmlFor="vault-device" className="text-xs font-medium text-muted-foreground">
              Device
            </label>
            {devicesLoading ? (
              <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading devices...
              </div>
            ) : (
              <select
                id="vault-device"
                value={deviceId}
                onChange={(e) => setDeviceId(e.target.value)}
                disabled={isEdit}
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm disabled:opacity-60"
              >
                <option value="">Select a device...</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.hostname}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Vault Path */}
          <div>
            <label htmlFor="vault-path" className="text-xs font-medium text-muted-foreground">
              Vault Path
            </label>
            <input
              id="vault-path"
              value={vaultPath}
              onChange={(e) => setVaultPath(e.target.value)}
              placeholder={placeholderExamples[vaultType]}
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 font-mono text-sm"
            />
          </div>

          {/* Vault Type */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">Vault Type</label>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              {typeOptions.map((opt) => {
                const Icon = opt.icon;
                return (
                  <label
                    key={opt.value}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 rounded-md border p-3 text-sm transition',
                      vaultType === opt.value
                        ? 'border-primary/40 bg-primary/10'
                        : 'border-muted hover:border-muted-foreground/30'
                    )}
                  >
                    <input
                      type="radio"
                      name="vaultType"
                      value={opt.value}
                      checked={vaultType === opt.value}
                      onChange={() => setVaultType(opt.value)}
                      className="hidden"
                    />
                    <Icon className={cn('h-4 w-4', vaultType === opt.value ? 'text-primary' : 'text-muted-foreground')} />
                    <div>
                      <span className="font-medium text-foreground">{opt.label}</span>
                      <p className="text-[10px] text-muted-foreground">{opt.description}</p>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          {/* Retention Count */}
          <div>
            <label htmlFor="vault-retention" className="text-xs font-medium text-muted-foreground">
              Retention Count
            </label>
            <input
              id="vault-retention"
              type="number"
              min={1}
              max={100}
              value={retentionCount}
              onChange={(e) => setRetentionCount(Number(e.target.value) || 3)}
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Number of snapshots to keep in the vault (1-100).
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-6 flex items-center justify-end gap-2 border-t pt-4">
          <button
            type="button"
            onClick={() => onClose()}
            className="rounded-md border px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {isEdit ? 'Update Vault' : 'Create Vault'}
          </button>
        </div>
      </div>
    </div>
  );
}
