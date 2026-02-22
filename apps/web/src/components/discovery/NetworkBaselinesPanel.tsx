import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ArrowRight, Pencil, Play, RefreshCw, Trash2 } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { formatDateTime, mapNetworkBaseline, type NetworkBaseline } from './networkTypes';

type SiteOption = {
  id: string;
  name: string;
};

type BaselineFormState = {
  siteId: string;
  subnet: string;
  enabled: boolean;
  intervalHours: number;
  alertNewDevice: boolean;
  alertDisappeared: boolean;
  alertChanged: boolean;
  alertRogueDevice: boolean;
};

type NetworkBaselinesPanelProps = {
  currentOrgId: string | null;
  currentSiteId: string | null;
  siteOptions: SiteOption[];
  timezone?: string;
  onViewChanges: (baselineId: string) => void;
};

const cidrRegex = /^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/;

function createDefaultForm(currentSiteId: string | null, siteOptions: SiteOption[]): BaselineFormState {
  return {
    siteId: currentSiteId ?? siteOptions[0]?.id ?? '',
    subnet: '',
    enabled: true,
    intervalHours: 4,
    alertNewDevice: true,
    alertDisappeared: true,
    alertChanged: true,
    alertRogueDevice: false
  };
}

function mapBaselineToForm(baseline: NetworkBaseline): BaselineFormState {
  return {
    siteId: baseline.siteId,
    subnet: baseline.subnet,
    enabled: baseline.scanSchedule.enabled,
    intervalHours: baseline.scanSchedule.intervalHours,
    alertNewDevice: baseline.alertSettings.newDevice,
    alertDisappeared: baseline.alertSettings.disappeared,
    alertChanged: baseline.alertSettings.changed,
    alertRogueDevice: baseline.alertSettings.rogueDevice
  };
}

async function extractError(response: Response, fallback: string): Promise<string> {
  const data = await response.json().catch(() => null);
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    if (typeof record.error === 'string' && record.error.trim().length > 0) {
      return record.error;
    }
    if (typeof record.message === 'string' && record.message.trim().length > 0) {
      return record.message;
    }
  }
  return `${fallback} (HTTP ${response.status})`;
}

export default function NetworkBaselinesPanel({
  currentOrgId,
  currentSiteId,
  siteOptions,
  timezone,
  onViewChanges
}: NetworkBaselinesPanelProps) {
  const [baselines, setBaselines] = useState<NetworkBaseline[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [canManage, setCanManage] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<BaselineFormState>(() => createDefaultForm(currentSiteId, siteOptions));

  const siteNameById = useMemo(
    () => new Map(siteOptions.map((site) => [site.id, site.name])),
    [siteOptions]
  );

  const editingBaseline = useMemo(
    () => baselines.find((baseline) => baseline.id === editingId) ?? null,
    [baselines, editingId]
  );

  const fetchBaselines = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      if (currentOrgId) params.set('orgId', currentOrgId);
      if (currentSiteId) params.set('siteId', currentSiteId);
      params.set('limit', '200');

      const query = params.toString();
      const response = await fetchWithAuth(`/network/baselines${query ? `?${query}` : ''}`);
      if (!response.ok) {
        throw new Error(await extractError(response, 'Failed to load network baselines'));
      }

      const payload = await response.json();
      const items = Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload)
          ? payload
          : [];

      const mapped = items
        .map((row: unknown) => mapNetworkBaseline(row))
        .filter((row: NetworkBaseline | null): row is NetworkBaseline => row !== null);

      setBaselines(mapped);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : 'Failed to load network baselines');
    } finally {
      setLoading(false);
    }
  }, [currentOrgId, currentSiteId]);

  useEffect(() => {
    fetchBaselines();
  }, [fetchBaselines]);

  useEffect(() => {
    if (editingId) return;
    setForm((previous) => ({
      ...previous,
      siteId: currentSiteId ?? previous.siteId ?? siteOptions[0]?.id ?? ''
    }));
  }, [currentSiteId, editingId, siteOptions]);

  const resetForm = useCallback(() => {
    setEditingId(null);
    setForm(createDefaultForm(currentSiteId, siteOptions));
  }, [currentSiteId, siteOptions]);

  const handleEdit = (baseline: NetworkBaseline) => {
    setEditingId(baseline.id);
    setForm(mapBaselineToForm(baseline));
    setInfo(null);
    setError(null);
  };

  const validateForm = (): string | null => {
    if (!form.siteId.trim()) return 'Select a site before saving.';
    if (!cidrRegex.test(form.subnet.trim())) return 'Subnet must be in CIDR format (example: 192.168.1.0/24).';
    if (!Number.isInteger(form.intervalHours) || form.intervalHours < 1 || form.intervalHours > 168) {
      return 'Scan interval must be between 1 and 168 hours.';
    }
    return null;
  };

  const handleSubmit = async (submitEvent: FormEvent) => {
    submitEvent.preventDefault();

    const validationError = validateForm();
    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving(true);
    setError(null);
    setInfo(null);

    const scanSchedule = {
      enabled: form.enabled,
      intervalHours: form.intervalHours
    };
    const alertSettings = {
      newDevice: form.alertNewDevice,
      disappeared: form.alertDisappeared,
      changed: form.alertChanged,
      rogueDevice: form.alertRogueDevice
    };

    try {
      if (editingId) {
        const response = await fetchWithAuth(`/network/baselines/${editingId}`, {
          method: 'PATCH',
          body: JSON.stringify({ scanSchedule, alertSettings })
        });

        if (!response.ok) {
          if (response.status === 403) {
            setCanManage(false);
          }
          throw new Error(await extractError(response, 'Failed to update baseline'));
        }

        setInfo('Baseline settings updated.');
      } else {
        const response = await fetchWithAuth('/network/baselines', {
          method: 'POST',
          body: JSON.stringify({
            orgId: currentOrgId ?? undefined,
            siteId: form.siteId.trim(),
            subnet: form.subnet.trim(),
            scanSchedule,
            alertSettings
          })
        });

        if (!response.ok) {
          if (response.status === 403) {
            setCanManage(false);
          }
          throw new Error(await extractError(response, 'Failed to create baseline'));
        }

        setInfo('Baseline created.');
      }

      await fetchBaselines();
      resetForm();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save baseline');
    } finally {
      setSaving(false);
    }
  };

  const handleRunNow = async (baseline: NetworkBaseline) => {
    setError(null);
    setInfo(null);

    try {
      const response = await fetchWithAuth(`/network/baselines/${baseline.id}/scan`, {
        method: 'POST'
      });

      if (!response.ok) {
        if (response.status === 403) {
          setCanManage(false);
        }
        throw new Error(await extractError(response, 'Failed to trigger baseline scan'));
      }

      const payload = await response.json().catch(() => null);
      const queueJobId = payload && typeof payload === 'object' && typeof (payload as { queueJobId?: unknown }).queueJobId === 'string'
        ? (payload as { queueJobId: string }).queueJobId
        : null;

      setInfo(queueJobId ? `Scan queued (${queueJobId}).` : 'Scan queued.');
      await fetchBaselines();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : 'Failed to run baseline scan');
    }
  };

  const handleDelete = async (baseline: NetworkBaseline) => {
    const confirmed = window.confirm(`Delete baseline ${baseline.subnet}? Associated change events will also be deleted.`);
    if (!confirmed) return;

    setError(null);
    setInfo(null);

    try {
      const response = await fetchWithAuth(`/network/baselines/${baseline.id}?deleteChanges=true`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        if (response.status === 403) {
          setCanManage(false);
        }
        throw new Error(await extractError(response, 'Failed to delete baseline'));
      }

      setInfo(`Deleted baseline ${baseline.subnet}.`);
      await fetchBaselines();
      if (editingId === baseline.id) {
        resetForm();
      }
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Failed to delete baseline');
    }
  };

  if (loading && baselines.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-card p-10 shadow-sm">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading network baselines...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[2fr,1fr]">
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Network Baselines</h2>
            <p className="text-sm text-muted-foreground">{baselines.length} baselines configured</p>
          </div>
          <button
            type="button"
            onClick={() => fetchBaselines()}
            className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
        </div>

        {!canManage && (
          <div className="mt-4 rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-sm text-yellow-800">
            Mutating actions are disabled after permission check failure. Requires `devices:write`.
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        {info && (
          <div className="mt-4 rounded-md border border-green-500/40 bg-green-500/10 px-3 py-2 text-sm text-green-700">
            {info}
          </div>
        )}

        <div className="mt-6 overflow-hidden rounded-md border">
          <table className="min-w-full divide-y">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">Subnet</th>
                <th className="px-4 py-3">Site</th>
                <th className="px-4 py-3">Schedule</th>
                <th className="px-4 py-3">Last Scan</th>
                <th className="px-4 py-3">Known Devices</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {baselines.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-sm text-muted-foreground">
                    No network baselines yet. Create one to enable continuous change detection.
                  </td>
                </tr>
              ) : (
                baselines.map((baseline) => (
                  (() => {
                    const enabledAlerts: string[] = [];
                    if (baseline.alertSettings.newDevice) enabledAlerts.push('new');
                    if (baseline.alertSettings.disappeared) enabledAlerts.push('gone');
                    if (baseline.alertSettings.changed) enabledAlerts.push('changed');
                    if (baseline.alertSettings.rogueDevice) enabledAlerts.push('rogue');

                    return (
                      <tr key={baseline.id} className="transition hover:bg-muted/40">
                        <td className="px-4 py-3">
                          <div className="font-mono text-sm">{baseline.subnet}</div>
                          <div className="text-xs text-muted-foreground">
                            Alerts: {enabledAlerts.length > 0 ? enabledAlerts.join(', ') : 'none'}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm">{siteNameById.get(baseline.siteId) ?? baseline.siteId}</td>
                        <td className="px-4 py-3">
                          <div className="text-sm">
                            {baseline.scanSchedule.enabled
                              ? `Every ${baseline.scanSchedule.intervalHours}h`
                              : 'Paused'}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            Next: {formatDateTime(baseline.scanSchedule.nextScanAt, timezone)}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm">{formatDateTime(baseline.lastScanAt, timezone)}</td>
                        <td className="px-4 py-3 text-sm">{baseline.knownDevices.length}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => onViewChanges(baseline.id)}
                              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
                              title="View changes"
                            >
                              Changes
                              <ArrowRight className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRunNow(baseline)}
                              disabled={!canManage}
                              className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted disabled:opacity-40"
                              title="Run now"
                            >
                              <Play className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleEdit(baseline)}
                              disabled={!canManage}
                              className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted disabled:opacity-40"
                              title="Edit"
                            >
                              <Pencil className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDelete(baseline)}
                              disabled={!canManage}
                              className="flex h-8 w-8 items-center justify-center rounded-md border border-destructive/30 text-destructive hover:bg-destructive/10 disabled:opacity-40"
                              title="Delete"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })()
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">{editingBaseline ? 'Edit Baseline' : 'Create Baseline'}</h2>
            <p className="text-sm text-muted-foreground">
              {editingBaseline
                ? 'Update scan cadence and alert behavior.'
                : 'Create a subnet baseline for scheduled discovery comparisons.'}
            </p>
          </div>
          {editingBaseline && (
            <button
              type="button"
              onClick={resetForm}
              className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
            >
              Cancel
            </button>
          )}
        </div>

        <div className="mt-4 space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Site</label>
            <select
              value={form.siteId}
              onChange={(event) => setForm((previous) => ({ ...previous, siteId: event.target.value }))}
              disabled={!!editingBaseline}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
            >
              <option value="">Select site</option>
              {siteOptions.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Subnet (CIDR)</label>
            <input
              type="text"
              value={form.subnet}
              onChange={(event) => setForm((previous) => ({ ...previous, subnet: event.target.value }))}
              placeholder="192.168.1.0/24"
              disabled={!!editingBaseline}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
            />
            {editingBaseline && (
              <p className="mt-1 text-xs text-muted-foreground">Site and subnet are immutable after creation.</p>
            )}
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => setForm((previous) => ({ ...previous, enabled: event.target.checked }))}
              className="h-4 w-4 rounded border"
            />
            Enable scheduled scans
          </label>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Scan Interval (hours)</label>
            <input
              type="number"
              min={1}
              max={168}
              value={form.intervalHours}
              onChange={(event) => setForm((previous) => ({ ...previous, intervalHours: Number(event.target.value) || 1 }))}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="rounded-md border p-3">
            <p className="text-xs font-medium text-muted-foreground">Alert Settings</p>
            <div className="mt-2 space-y-2 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.alertNewDevice}
                  onChange={(event) => setForm((previous) => ({ ...previous, alertNewDevice: event.target.checked }))}
                  className="h-4 w-4 rounded border"
                />
                New device
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.alertDisappeared}
                  onChange={(event) => setForm((previous) => ({ ...previous, alertDisappeared: event.target.checked }))}
                  className="h-4 w-4 rounded border"
                />
                Device disappeared
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.alertChanged}
                  onChange={(event) => setForm((previous) => ({ ...previous, alertChanged: event.target.checked }))}
                  className="h-4 w-4 rounded border"
                />
                Device changed
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.alertRogueDevice}
                  onChange={(event) => setForm((previous) => ({ ...previous, alertRogueDevice: event.target.checked }))}
                  className="h-4 w-4 rounded border"
                />
                Rogue device
              </label>
            </div>
          </div>
        </div>

        <button
          type="submit"
          disabled={saving || !canManage}
          className="mt-6 w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving
            ? (editingBaseline ? 'Saving...' : 'Creating...')
            : (editingBaseline ? 'Save Baseline Settings' : 'Create Baseline')}
        </button>
      </form>
    </div>
  );
}
