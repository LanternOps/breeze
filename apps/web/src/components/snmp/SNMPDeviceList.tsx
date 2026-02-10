import { useMemo, useState, useEffect, useCallback } from 'react';
import { Filter, Play, Pencil, Trash2, PlusCircle, Server, X } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type SnmpStatus = 'online' | 'offline' | 'warning' | 'maintenance' | string;

type SnmpDevice = {
  id: string;
  name: string;
  ipAddress: string;
  snmpVersion: 'v1' | 'v2c' | 'v3';
  templateName: string | null;
  status: SnmpStatus;
  lastPolledAt: string | null;
  pollingInterval: number;
  orgId?: string;
};

type DeviceDraft = {
  name: string;
  ipAddress: string;
  snmpVersion: 'v1' | 'v2c' | 'v3';
  pollingInterval: number;
  port: number;
  community: string;
  orgId: string;
};

const statusStyles: Record<string, string> = {
  online: 'bg-green-500/20 text-green-700 border-green-500/40',
  offline: 'bg-red-500/20 text-red-700 border-red-500/40',
  warning: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40',
  maintenance: 'bg-blue-500/20 text-blue-700 border-blue-500/40'
};

const defaultDraft: DeviceDraft = {
  name: '',
  ipAddress: '',
  snmpVersion: 'v2c',
  pollingInterval: 300,
  port: 161,
  community: 'public',
  orgId: ''
};

function formatLastPolled(value: string | null): string {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Never';
  return date.toLocaleString();
}

function toVersion(value: unknown): 'v1' | 'v2c' | 'v3' {
  return value === 'v1' || value === 'v3' ? value : 'v2c';
}

export default function SNMPDeviceList() {
  const [devices, setDevices] = useState<SnmpDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [statusFilter, setStatusFilter] = useState<SnmpStatus | 'all'>('all');
  const [templateFilter, setTemplateFilter] = useState('all');
  const [versionFilter, setVersionFilter] = useState<'all' | SnmpDevice['snmpVersion']>('all');
  const [showForm, setShowForm] = useState(false);
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DeviceDraft>(defaultDraft);
  const [submitting, setSubmitting] = useState(false);
  const [actionDeviceId, setActionDeviceId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string>();

  const fetchDevices = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth('/snmp/devices');
      if (response.status === 401) {
        window.location.href = '/login';
        return;
      }
      if (!response.ok) {
        throw new Error('Failed to fetch SNMP devices');
      }
      const payload = await response.json();
      const rows = (payload.data ?? payload.devices ?? (Array.isArray(payload) ? payload : [])) as Array<Record<string, unknown>>;
      setDevices(rows.map((row) => ({
        id: String(row.id),
        name: String(row.name ?? ''),
        ipAddress: String(row.ipAddress ?? row.ip ?? ''),
        snmpVersion: toVersion(row.snmpVersion),
        templateName: row.templateName ? String(row.templateName) : null,
        status: String(row.status ?? 'offline'),
        lastPolledAt: row.lastPolledAt ? String(row.lastPolledAt) : null,
        pollingInterval: Number(row.pollingInterval ?? 300),
        orgId: row.orgId ? String(row.orgId) : undefined
      })));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchDevices();
  }, [fetchDevices]);

  const templates = useMemo(() => {
    const unique = new Set(devices.map((device) => device.templateName || 'Unassigned'));
    return ['all', ...Array.from(unique)];
  }, [devices]);

  const filteredDevices = useMemo(() => {
    return devices.filter((device) => {
      const template = device.templateName || 'Unassigned';
      const matchesStatus = statusFilter === 'all' ? true : device.status === statusFilter;
      const matchesTemplate = templateFilter === 'all' ? true : template === templateFilter;
      const matchesVersion = versionFilter === 'all' ? true : device.snmpVersion === versionFilter;
      return matchesStatus && matchesTemplate && matchesVersion;
    });
  }, [devices, statusFilter, templateFilter, versionFilter]);

  const openAddForm = () => {
    setEditingDeviceId(null);
    setDraft(defaultDraft);
    setShowForm(true);
    setError(undefined);
  };

  const openEditForm = (device: SnmpDevice) => {
    setEditingDeviceId(device.id);
    setDraft({
      name: device.name,
      ipAddress: device.ipAddress,
      snmpVersion: device.snmpVersion,
      pollingInterval: device.pollingInterval,
      port: 161,
      community: '',
      orgId: device.orgId ?? ''
    });
    setShowForm(true);
    setError(undefined);
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingDeviceId(null);
    setDraft(defaultDraft);
  };

  const handleSaveDevice = async () => {
    if (!draft.name.trim() || !draft.ipAddress.trim()) {
      setError('Name and IP address are required.');
      return;
    }

    setSubmitting(true);
    setError(undefined);
    try {
      if (editingDeviceId) {
        const updateBody: Record<string, unknown> = {
          name: draft.name.trim(),
          ipAddress: draft.ipAddress.trim(),
          snmpVersion: draft.snmpVersion,
          pollingInterval: Number(draft.pollingInterval),
          port: Number(draft.port)
        };
        if (draft.snmpVersion !== 'v3' && draft.community.trim()) {
          updateBody.community = draft.community.trim();
        }

        const response = await fetchWithAuth(`/snmp/devices/${editingDeviceId}`, {
          method: 'PATCH',
          body: JSON.stringify(updateBody)
        });
        if (!response.ok) throw new Error('Failed to update SNMP device');
        setActionMessage('Device updated.');
      } else {
        const createBody: Record<string, unknown> = {
          name: draft.name.trim(),
          ipAddress: draft.ipAddress.trim(),
          snmpVersion: draft.snmpVersion,
          pollingInterval: Number(draft.pollingInterval),
          port: Number(draft.port)
        };
        if (draft.orgId.trim()) {
          createBody.orgId = draft.orgId.trim();
        }
        if (draft.snmpVersion !== 'v3') {
          createBody.community = draft.community.trim() || 'public';
        }

        const response = await fetchWithAuth('/snmp/devices', {
          method: 'POST',
          body: JSON.stringify(createBody)
        });
        if (!response.ok) throw new Error('Failed to create SNMP device');
        setActionMessage('Device added.');
      }

      closeForm();
      await fetchDevices();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save SNMP device');
    } finally {
      setSubmitting(false);
    }
  };

  const handlePoll = async (deviceId: string) => {
    setActionDeviceId(deviceId);
    setError(undefined);
    try {
      const response = await fetchWithAuth(`/snmp/devices/${deviceId}/poll`, { method: 'POST' });
      if (!response.ok) throw new Error('Failed to queue SNMP poll');
      setActionMessage('Poll queued.');
      await fetchDevices();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to queue SNMP poll');
    } finally {
      setActionDeviceId(null);
    }
  };

  const handleDelete = async (deviceId: string) => {
    if (!window.confirm('Delete this SNMP device and its related data?')) return;

    setActionDeviceId(deviceId);
    setError(undefined);
    try {
      const response = await fetchWithAuth(`/snmp/devices/${deviceId}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Failed to delete SNMP device');
      setActionMessage('Device deleted.');
      await fetchDevices();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete SNMP device');
    } finally {
      setActionDeviceId(null);
    }
  };

  if (loading) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-center py-12">
          <div className="text-center">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
            <p className="mt-4 text-sm text-muted-foreground">Loading SNMP devices...</p>
          </div>
        </div>
      </div>
    );
  }

  if (error && devices.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
          <p className="text-sm text-destructive">{error}</p>
          <button
            type="button"
            onClick={() => {
              void fetchDevices();
            }}
            className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">SNMP Devices</h2>
          <p className="text-sm text-muted-foreground">{filteredDevices.length} devices in scope</p>
        </div>
        <button
          type="button"
          onClick={openAddForm}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm"
        >
          <PlusCircle className="h-4 w-4" />
          Add device
        </button>
      </div>

      {(error || actionMessage) && (
        <div className={`mt-4 rounded-md border px-3 py-2 text-sm ${error ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-border bg-muted/30 text-muted-foreground'}`}>
          {error ?? actionMessage}
        </div>
      )}

      {showForm && (
        <div className="mt-4 rounded-lg border bg-background p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">{editingDeviceId ? 'Edit SNMP device' : 'Add SNMP device'}</h3>
            <button type="button" onClick={closeForm} className="rounded-md border p-1 text-muted-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <input
              type="text"
              value={draft.name}
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
              placeholder="Device name"
              className="rounded-md border bg-background px-3 py-2 text-sm"
            />
            <input
              type="text"
              value={draft.ipAddress}
              onChange={(event) => setDraft((current) => ({ ...current, ipAddress: event.target.value }))}
              placeholder="IP address"
              className="rounded-md border bg-background px-3 py-2 text-sm"
            />
            <select
              value={draft.snmpVersion}
              onChange={(event) => setDraft((current) => ({ ...current, snmpVersion: event.target.value as DeviceDraft['snmpVersion'] }))}
              className="rounded-md border bg-background px-3 py-2 text-sm"
            >
              <option value="v1">SNMP v1</option>
              <option value="v2c">SNMP v2c</option>
              <option value="v3">SNMP v3</option>
            </select>
            <input
              type="number"
              value={draft.port}
              onChange={(event) => setDraft((current) => ({ ...current, port: Number(event.target.value || 161) }))}
              placeholder="Port"
              className="rounded-md border bg-background px-3 py-2 text-sm"
            />
            <input
              type="number"
              value={draft.pollingInterval}
              onChange={(event) => setDraft((current) => ({ ...current, pollingInterval: Number(event.target.value || 300) }))}
              placeholder="Polling interval (seconds)"
              className="rounded-md border bg-background px-3 py-2 text-sm"
            />
            {draft.snmpVersion !== 'v3' ? (
              <input
                type="text"
                value={draft.community}
                onChange={(event) => setDraft((current) => ({ ...current, community: event.target.value }))}
                placeholder="Community string"
                className="rounded-md border bg-background px-3 py-2 text-sm"
              />
            ) : (
              <input
                type="text"
                value={draft.orgId}
                onChange={(event) => setDraft((current) => ({ ...current, orgId: event.target.value }))}
                placeholder="Org ID (optional for org scope)"
                className="rounded-md border bg-background px-3 py-2 text-sm"
              />
            )}
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" onClick={closeForm} className="rounded-md border px-3 py-2 text-sm">
              Cancel
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => {
                void handleSaveDevice();
              }}
              className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
            >
              {submitting ? 'Saving...' : editingDeviceId ? 'Save changes' : 'Create device'}
            </button>
          </div>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
        <div className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-2">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as SnmpStatus | 'all')}
            className="bg-transparent text-sm focus:outline-none"
          >
            <option value="all">All status</option>
            <option value="online">Online</option>
            <option value="offline">Offline</option>
            <option value="warning">Warning</option>
            <option value="maintenance">Maintenance</option>
          </select>
        </div>
        <div className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-2">
          <Server className="h-4 w-4 text-muted-foreground" />
          <select
            value={templateFilter}
            onChange={(event) => setTemplateFilter(event.target.value)}
            className="bg-transparent text-sm focus:outline-none"
          >
            {templates.map((template) => (
              <option key={template} value={template}>
                {template === 'all' ? 'All templates' : template}
              </option>
            ))}
          </select>
        </div>
        <div className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-2">
          <select
            value={versionFilter}
            onChange={(event) => setVersionFilter(event.target.value as 'all' | SnmpDevice['snmpVersion'])}
            className="bg-transparent text-sm focus:outline-none"
          >
            <option value="all">All versions</option>
            <option value="v1">SNMP v1</option>
            <option value="v2c">SNMP v2c</option>
            <option value="v3">SNMP v3</option>
          </select>
        </div>
      </div>

      <div className="mt-6 overflow-hidden rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3 text-left font-medium">Name</th>
              <th className="px-4 py-3 text-left font-medium">IP</th>
              <th className="px-4 py-3 text-left font-medium">Version</th>
              <th className="px-4 py-3 text-left font-medium">Template</th>
              <th className="px-4 py-3 text-left font-medium">Status</th>
              <th className="px-4 py-3 text-left font-medium">Last polled</th>
              <th className="px-4 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filteredDevices.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No SNMP devices found.
                </td>
              </tr>
            ) : (
              filteredDevices.map((device) => {
                const statusClass = statusStyles[device.status] ?? 'bg-muted text-muted-foreground border-muted-foreground/30';
                const pending = actionDeviceId === device.id;
                return (
                  <tr key={device.id} className="bg-background">
                    <td className="px-4 py-3">
                      <div className="font-medium">{device.name}</div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{device.ipAddress}</td>
                    <td className="px-4 py-3">{device.snmpVersion}</td>
                    <td className="px-4 py-3">{device.templateName ?? 'Unassigned'}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${statusClass}`}>
                        {device.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{formatLastPolled(device.lastPolledAt)}</td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => {
                            void handlePoll(device.id);
                          }}
                          className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs disabled:opacity-60"
                        >
                          <Play className="h-3 w-3" />
                          Poll
                        </button>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => openEditForm(device)}
                          className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs disabled:opacity-60"
                        >
                          <Pencil className="h-3 w-3" />
                          Edit
                        </button>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => {
                            void handleDelete(device.id);
                          }}
                          className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-red-600 disabled:opacity-60"
                        >
                          <Trash2 className="h-3 w-3" />
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
