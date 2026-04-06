import { useCallback, useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';

// ── Types ──────────────────────────────────────────────────────────

type SLAConfig = {
  id: string;
  name: string;
  rpoMinutes: number;
  rtoMinutes: number;
  active: boolean;
  alertOnBreach?: boolean;
  targetDeviceIds?: string[];
  targetDeviceGroupIds?: string[];
  [key: string]: unknown;
};

type Device = { id: string; hostname: string };
type DeviceGroup = { id: string; name: string };

type SLAConfigDialogProps = {
  config: SLAConfig | null;
  onClose: (saved?: boolean) => void;
};

type ScopeMode = 'devices' | 'groups';

// ── Component ─────────────────────────────────────────────────────

export default function SLAConfigDialog({ config, onClose }: SLAConfigDialogProps) {
  const isEdit = !!config;

  const [name, setName] = useState(config?.name ?? '');
  const [rpoMinutes, setRpoMinutes] = useState(config?.rpoMinutes ?? 60);
  const [rtoMinutes, setRtoMinutes] = useState(config?.rtoMinutes ?? 120);
  const [alertOnBreach, setAlertOnBreach] = useState(config?.alertOnBreach ?? true);
  const [active, setActive] = useState(config?.active ?? true);
  const [scopeMode, setScopeMode] = useState<ScopeMode>(
    config?.targetDeviceGroupIds?.length ? 'groups' : 'devices'
  );
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<string[]>(
    config?.targetDeviceIds ?? []
  );
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>(
    config?.targetDeviceGroupIds ?? []
  );
  const [devices, setDevices] = useState<Device[]>([]);
  const [groups, setGroups] = useState<DeviceGroup[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const fetchOptions = async () => {
      try {
        const [devRes, grpRes] = await Promise.all([
          fetchWithAuth('/devices'),
          fetchWithAuth('/device-groups'),
        ]);
        if (devRes.ok) {
          const payload = await devRes.json();
          const data = payload?.data ?? payload ?? [];
          setDevices(Array.isArray(data) ? data : []);
        }
        if (grpRes.ok) {
          const payload = await grpRes.json();
          const data = payload?.data ?? payload ?? [];
          setGroups(Array.isArray(data) ? data : []);
        }
      } catch {
        // Silently fail
      }
    };
    fetchOptions();
  }, []);

  const handleSave = useCallback(async () => {
    setError(undefined);
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    if (rpoMinutes < 1) {
      setError('RPO target must be at least 1 minute');
      return;
    }
    if (rtoMinutes < 1) {
      setError('RTO target must be at least 1 minute');
      return;
    }

    setSaving(true);
    try {
      const body = {
        name,
        rpoMinutes,
        rtoMinutes,
        alertOnBreach,
        active,
        targetDeviceIds: scopeMode === 'devices' ? selectedDeviceIds : [],
        targetDeviceGroupIds: scopeMode === 'groups' ? selectedGroupIds : [],
      };

      const url = isEdit ? `/backup/sla/configs/${config.id}` : '/backup/sla/configs';
      const method = isEdit ? 'PATCH' : 'POST';

      const response = await fetchWithAuth(url, {
        method,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Failed to ${isEdit ? 'update' : 'create'} SLA config`);
      }

      onClose(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSaving(false);
    }
  }, [active, alertOnBreach, config?.id, isEdit, name, onClose, rpoMinutes, rtoMinutes, scopeMode, selectedDeviceIds, selectedGroupIds]);

  const toggleDevice = (id: string) => {
    setSelectedDeviceIds((prev) =>
      prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id]
    );
  };

  const toggleGroup = (id: string) => {
    setSelectedGroupIds((prev) =>
      prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id]
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-xl">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-foreground">
            {isEdit ? 'Edit SLA Configuration' : 'Add SLA Configuration'}
          </h3>
          <button type="button" onClick={() => onClose()} className="rounded-md p-1 hover:bg-muted">
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>

        {error && (
          <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="mt-4 space-y-4">
          {/* Name */}
          <div>
            <label htmlFor="sla-name" className="text-xs font-medium text-muted-foreground">Name</label>
            <input
              id="sla-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Critical Servers SLA"
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>

          {/* RPO / RTO */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="sla-rpo" className="text-xs font-medium text-muted-foreground">RPO Target (minutes)</label>
              <input
                id="sla-rpo"
                type="number"
                min={1}
                value={rpoMinutes}
                onChange={(e) => setRpoMinutes(Number(e.target.value) || 60)}
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
              />
            </div>
            <div>
              <label htmlFor="sla-rto" className="text-xs font-medium text-muted-foreground">RTO Target (minutes)</label>
              <input
                id="sla-rto"
                type="number"
                min={1}
                value={rtoMinutes}
                onChange={(e) => setRtoMinutes(Number(e.target.value) || 120)}
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
              />
            </div>
          </div>

          {/* Target Scope */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">Target Scope</label>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => setScopeMode('devices')}
                className={cn(
                  'rounded-md border px-3 py-1.5 text-xs font-medium transition',
                  scopeMode === 'devices' ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                Devices
              </button>
              <button
                type="button"
                onClick={() => setScopeMode('groups')}
                className={cn(
                  'rounded-md border px-3 py-1.5 text-xs font-medium transition',
                  scopeMode === 'groups' ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                Device Groups
              </button>
            </div>

            {scopeMode === 'devices' && (
              <div className="mt-2 max-h-32 overflow-y-auto rounded-md border bg-muted/10 p-2">
                {devices.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No devices available.</p>
                ) : (
                  devices.map((d) => (
                    <label key={d.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted/20">
                      <input
                        type="checkbox"
                        checked={selectedDeviceIds.includes(d.id)}
                        onChange={() => toggleDevice(d.id)}
                        className="h-3.5 w-3.5"
                      />
                      <span className="text-foreground">{d.hostname}</span>
                    </label>
                  ))
                )}
              </div>
            )}

            {scopeMode === 'groups' && (
              <div className="mt-2 max-h-32 overflow-y-auto rounded-md border bg-muted/10 p-2">
                {groups.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No device groups available.</p>
                ) : (
                  groups.map((g) => (
                    <label key={g.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted/20">
                      <input
                        type="checkbox"
                        checked={selectedGroupIds.includes(g.id)}
                        onChange={() => toggleGroup(g.id)}
                        className="h-3.5 w-3.5"
                      />
                      <span className="text-foreground">{g.name}</span>
                    </label>
                  ))
                )}
              </div>
            )}
          </div>

          {/* Toggles */}
          <div className="flex items-center justify-between rounded-md border bg-background px-4 py-3">
            <div>
              <p className="text-sm font-medium">Alert on breach</p>
              <p className="text-xs text-muted-foreground">Send alert when SLA is breached</p>
            </div>
            <button
              type="button"
              onClick={() => setAlertOnBreach(!alertOnBreach)}
              className={cn(
                'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
                alertOnBreach ? 'bg-primary' : 'bg-muted'
              )}
            >
              <span className={cn('pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform', alertOnBreach ? 'translate-x-5' : 'translate-x-0')} />
            </button>
          </div>

          <div className="flex items-center justify-between rounded-md border bg-background px-4 py-3">
            <div>
              <p className="text-sm font-medium">Active</p>
              <p className="text-xs text-muted-foreground">Enable SLA monitoring</p>
            </div>
            <button
              type="button"
              onClick={() => setActive(!active)}
              className={cn(
                'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
                active ? 'bg-primary' : 'bg-muted'
              )}
            >
              <span className={cn('pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform', active ? 'translate-x-5' : 'translate-x-0')} />
            </button>
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
            {isEdit ? 'Update' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
