import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Pencil, PlusCircle, Trash2 } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

type SnmpDevice = {
  id: string;
  name: string;
  ipAddress: string;
};

type Threshold = {
  id: string;
  oid: string;
  operator: string | null;
  threshold: string | null;
  severity: Severity;
  message: string | null;
  isActive: boolean;
};

type ThresholdDraft = {
  oid: string;
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq';
  threshold: string;
  severity: Severity;
  message: string;
};

const severityStyles: Record<Severity, string> = {
  critical: 'bg-red-500/10 text-red-700',
  high: 'bg-orange-500/10 text-orange-700',
  medium: 'bg-yellow-500/10 text-yellow-700',
  low: 'bg-blue-500/10 text-blue-700',
  info: 'bg-muted text-muted-foreground'
};

const defaultDraft: ThresholdDraft = {
  oid: '',
  operator: 'gt',
  threshold: '',
  severity: 'critical',
  message: ''
};

const operatorLabels: Record<ThresholdDraft['operator'], string> = {
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  eq: '='
};

function formatDeviceLabel(device: SnmpDevice): string {
  return `${device.name} (${device.ipAddress})`;
}

export default function SNMPThresholdManager() {
  const [devices, setDevices] = useState<SnmpDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState('');

  const [thresholds, setThresholds] = useState<Threshold[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(true);
  const [loadingThresholds, setLoadingThresholds] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState<ThresholdDraft>(defaultDraft);

  const selectedDevice = useMemo(
    () => devices.find((device) => device.id === selectedDeviceId) ?? null,
    [devices, selectedDeviceId]
  );

  const loadDevices = useCallback(async () => {
    setLoadingDevices(true);
    setError(undefined);
    try {
      const response = await fetchWithAuth('/snmp/devices');
      if (response.status === 401) {
        window.location.href = '/login';
        return;
      }
      if (!response.ok) throw new Error('Failed to load SNMP devices');
      const payload = await response.json();
      const rows = (payload.data ?? []) as Array<{ id: string; name: string; ipAddress: string }>;
      const mapped = rows.map((row) => ({
        id: row.id,
        name: row.name,
        ipAddress: row.ipAddress
      }));
      setDevices(mapped);
      setSelectedDeviceId((current) => current || mapped[0]?.id || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load SNMP devices');
    } finally {
      setLoadingDevices(false);
    }
  }, []);

  const loadThresholds = useCallback(async () => {
    if (!selectedDeviceId) {
      setThresholds([]);
      return;
    }

    setLoadingThresholds(true);
    setError(undefined);
    try {
      const response = await fetchWithAuth(`/snmp/thresholds/${selectedDeviceId}`);
      if (response.status === 401) {
        window.location.href = '/login';
        return;
      }
      if (!response.ok) throw new Error('Failed to load thresholds');
      const payload = await response.json();
      setThresholds((payload.data ?? []) as Threshold[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load thresholds');
      setThresholds([]);
    } finally {
      setLoadingThresholds(false);
    }
  }, [selectedDeviceId]);

  const handleCreate = useCallback(async () => {
    if (!selectedDeviceId || !draft.oid.trim()) {
      setError('Device and OID are required.');
      return;
    }

    setSubmitting(true);
    setError(undefined);
    try {
      const response = await fetchWithAuth('/snmp/thresholds', {
        method: 'POST',
        body: JSON.stringify({
          deviceId: selectedDeviceId,
          oid: draft.oid.trim(),
          operator: draft.operator.trim() || undefined,
          threshold: draft.threshold.trim() || undefined,
          severity: draft.severity,
          message: draft.message.trim() || undefined,
          isActive: true
        })
      });

      if (!response.ok) throw new Error('Failed to create threshold');
      setDraft(defaultDraft);
      await loadThresholds();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create threshold');
    } finally {
      setSubmitting(false);
    }
  }, [draft, selectedDeviceId, loadThresholds]);

  const handleToggle = useCallback(async (threshold: Threshold) => {
    setError(undefined);
    try {
      const response = await fetchWithAuth(`/snmp/thresholds/${threshold.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          isActive: !threshold.isActive
        })
      });
      if (!response.ok) throw new Error('Failed to update threshold');
      await loadThresholds();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update threshold');
    }
  }, [loadThresholds]);

  const handleDelete = useCallback(async (thresholdId: string) => {
    setError(undefined);
    try {
      const response = await fetchWithAuth(`/snmp/thresholds/${thresholdId}`, {
        method: 'DELETE'
      });
      if (!response.ok) throw new Error('Failed to delete threshold');
      await loadThresholds();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete threshold');
    }
  }, [loadThresholds]);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  useEffect(() => {
    void loadThresholds();
  }, [loadThresholds]);

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Threshold Manager</h2>
        <p className="text-sm text-muted-foreground">Create, edit, and monitor SNMP thresholds.</p>
        <div className="mt-4">
          <label className="text-sm font-medium">Device</label>
          <select
            value={selectedDeviceId}
            onChange={(event) => setSelectedDeviceId(event.target.value)}
            className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
            disabled={loadingDevices || devices.length === 0}
          >
            {devices.map((device) => (
              <option key={device.id} value={device.id}>
                {formatDeviceLabel(device)}
              </option>
            ))}
            {!loadingDevices && devices.length === 0 && <option value="">No SNMP devices found</option>}
          </select>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">Add threshold</h3>
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
            onClick={() => {
              void handleCreate();
            }}
            disabled={submitting || !selectedDeviceId}
          >
            <PlusCircle className="h-4 w-4" />
            {submitting ? 'Creating...' : 'Add rule'}
          </button>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-5">
          <input
            type="text"
            value={draft.oid}
            onChange={(event) => setDraft((current) => ({ ...current, oid: event.target.value }))}
            placeholder="OID (e.g. 1.3.6.1.2.1.25.3.3.1.2)"
            className="rounded-md border bg-background px-3 py-2 text-sm"
          />
          <select
            value={draft.operator}
            onChange={(event) => setDraft((current) => ({ ...current, operator: event.target.value as ThresholdDraft['operator'] }))}
            className="rounded-md border bg-background px-3 py-2 text-sm"
          >
            <option value="gt">&gt;</option>
            <option value="gte">&gt;=</option>
            <option value="lt">&lt;</option>
            <option value="lte">&lt;=</option>
            <option value="eq">=</option>
          </select>
          <input
            type="text"
            value={draft.threshold}
            onChange={(event) => setDraft((current) => ({ ...current, threshold: event.target.value }))}
            placeholder="Threshold value"
            className="rounded-md border bg-background px-3 py-2 text-sm"
          />
          <select
            value={draft.severity}
            onChange={(event) => setDraft((current) => ({ ...current, severity: event.target.value as Severity }))}
            className="rounded-md border bg-background px-3 py-2 text-sm"
          >
            <option value="critical">critical</option>
            <option value="high">high</option>
            <option value="medium">medium</option>
            <option value="low">low</option>
            <option value="info">info</option>
          </select>
          <input
            type="text"
            value={draft.message}
            onChange={(event) => setDraft((current) => ({ ...current, message: event.target.value }))}
            placeholder="Optional message"
            className="rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">
            Thresholds for {selectedDevice?.name ?? 'selected device'}
          </h3>
          <AlertTriangle className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="mt-4 overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left font-medium">OID</th>
                <th className="px-4 py-3 text-left font-medium">Operator</th>
                <th className="px-4 py-3 text-left font-medium">Value</th>
                <th className="px-4 py-3 text-left font-medium">Severity</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {loadingThresholds ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">
                    Loading thresholds...
                  </td>
                </tr>
              ) : thresholds.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-muted-foreground">
                    No thresholds configured for this device.
                  </td>
                </tr>
              ) : (
                thresholds.map((threshold) => (
                  <tr key={threshold.id} className="bg-background">
                    <td className="px-4 py-3 font-medium">
                      {threshold.oid}
                      {threshold.message ? <div className="text-xs text-muted-foreground">{threshold.message}</div> : null}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {threshold.operator ? (operatorLabels[threshold.operator as ThresholdDraft['operator']] ?? threshold.operator) : '—'}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{threshold.threshold ?? '—'}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${severityStyles[threshold.severity]}`}>
                        {threshold.severity}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs text-muted-foreground">{threshold.isActive ? 'active' : 'paused'}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            void handleToggle(threshold);
                          }}
                          className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs"
                        >
                          <Pencil className="h-3 w-3" />
                          {threshold.isActive ? 'Pause' : 'Resume'}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            void handleDelete(threshold.id);
                          }}
                          className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-red-600"
                        >
                          <Trash2 className="h-3 w-3" />
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
