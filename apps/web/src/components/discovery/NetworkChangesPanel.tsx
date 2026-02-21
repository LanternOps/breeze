import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Info, Link2, RefreshCw } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import NetworkChangeDetailModal from './NetworkChangeDetailModal';
import {
  eventTypeConfig,
  formatDateTime,
  mapNetworkBaseline,
  mapNetworkChangeEvent,
  type DeviceOption,
  type NetworkBaseline,
  type NetworkChangeEvent,
  type NetworkEventType
} from './networkTypes';

type SiteOption = {
  id: string;
  name: string;
};

type NetworkChangesPanelProps = {
  currentOrgId: string | null;
  currentSiteId: string | null;
  siteOptions: SiteOption[];
  baselineFilterId?: string | null;
  timezone?: string;
};

type FilterState = {
  siteId: string;
  baselineId: string;
  eventType: 'all' | NetworkEventType;
  acknowledged: 'all' | 'true' | 'false';
  since: string;
};

function createDefaultFilters(currentSiteId: string | null): FilterState {
  return {
    siteId: currentSiteId ?? 'all',
    baselineId: 'all',
    eventType: 'all',
    acknowledged: 'false',
    since: ''
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

function normalizeDevices(raw: unknown): DeviceOption[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .map((entry): DeviceOption | null => {
      if (!entry || typeof entry !== 'object') return null;
      const row = entry as Record<string, unknown>;
      const id = typeof row.id === 'string' ? row.id : null;
      if (!id) return null;

      const hostname = typeof row.hostname === 'string' ? row.hostname : null;
      const displayName = typeof row.displayName === 'string' ? row.displayName : null;
      const label = (displayName || hostname || id).trim();

      return { id, label };
    })
    .filter((device): device is DeviceOption => device !== null);
}

export default function NetworkChangesPanel({
  currentOrgId,
  currentSiteId,
  siteOptions,
  baselineFilterId,
  timezone
}: NetworkChangesPanelProps) {
  const [changes, setChanges] = useState<NetworkChangeEvent[]>([]);
  const [baselines, setBaselines] = useState<NetworkBaseline[]>([]);
  const [devices, setDevices] = useState<DeviceOption[]>([]);
  const [filters, setFilters] = useState<FilterState>(() => createDefaultFilters(currentSiteId));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [selectedEventIds, setSelectedEventIds] = useState<Set<string>>(new Set());
  const [bulkNotes, setBulkNotes] = useState('');
  const [bulkWorking, setBulkWorking] = useState(false);
  const [canAcknowledge, setCanAcknowledge] = useState(true);
  const [canLinkDevice, setCanLinkDevice] = useState(true);
  const [detailEventId, setDetailEventId] = useState<string | null>(null);

  useEffect(() => {
    if (!baselineFilterId) return;
    setFilters((previous) => ({ ...previous, baselineId: baselineFilterId }));
  }, [baselineFilterId]);

  useEffect(() => {
    if (baselineFilterId) return;
    setFilters((previous) => ({ ...previous, siteId: currentSiteId ?? previous.siteId }));
  }, [baselineFilterId, currentSiteId]);

  const fetchBaselines = useCallback(async () => {
    const params = new URLSearchParams();
    if (currentOrgId) params.set('orgId', currentOrgId);
    params.set('limit', '200');
    const query = params.toString();

    const response = await fetchWithAuth(`/network/baselines${query ? `?${query}` : ''}`);
    if (!response.ok) {
      throw new Error(await extractError(response, 'Failed to load baseline filters'));
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
  }, [currentOrgId]);

  const fetchDevices = useCallback(async () => {
    const params = new URLSearchParams();
    params.set('page', '1');
    params.set('limit', '200');
    if (currentOrgId) params.set('orgId', currentOrgId);

    const response = await fetchWithAuth(`/devices?${params.toString()}`);
    if (!response.ok) {
      throw new Error(await extractError(response, 'Failed to load devices'));
    }

    const payload = await response.json();
    const rows = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.devices)
        ? payload.devices
        : Array.isArray(payload)
          ? payload
          : [];

    setDevices(normalizeDevices(rows));
  }, [currentOrgId]);

  const fetchChanges = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      if (currentOrgId) params.set('orgId', currentOrgId);
      if (filters.siteId !== 'all') params.set('siteId', filters.siteId);
      if (filters.baselineId !== 'all') params.set('baselineId', filters.baselineId);
      if (filters.eventType !== 'all') params.set('eventType', filters.eventType);
      if (filters.acknowledged !== 'all') params.set('acknowledged', filters.acknowledged);
      if (filters.since.trim()) {
        const parsed = new Date(filters.since);
        if (!Number.isNaN(parsed.getTime())) {
          params.set('since', parsed.toISOString());
        }
      }
      params.set('limit', '200');

      const response = await fetchWithAuth(`/network/changes?${params.toString()}`);
      if (!response.ok) {
        throw new Error(await extractError(response, 'Failed to load network changes'));
      }

      const payload = await response.json();
      const rows = Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload)
          ? payload
          : [];

      const mapped: NetworkChangeEvent[] = rows
        .map((row: unknown) => mapNetworkChangeEvent(row))
        .filter((row: NetworkChangeEvent | null): row is NetworkChangeEvent => row !== null);

      setChanges(mapped);
      setSelectedEventIds((previous) => {
        const valid = new Set(mapped.map((row) => row.id));
        return new Set([...previous].filter((id) => valid.has(id)));
      });
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : 'Failed to load network changes');
    } finally {
      setLoading(false);
    }
  }, [currentOrgId, filters]);

  useEffect(() => {
    Promise.all([fetchBaselines(), fetchDevices()]).catch((fetchError) => {
      setError(fetchError instanceof Error ? fetchError.message : 'Failed to load network metadata');
    });
  }, [fetchBaselines, fetchDevices]);

  useEffect(() => {
    fetchChanges();
  }, [fetchChanges]);

  const baselineById = useMemo(
    () => new Map(baselines.map((baseline) => [baseline.id, baseline])),
    [baselines]
  );

  const deviceById = useMemo(
    () => new Map(devices.map((device) => [device.id, device])),
    [devices]
  );

  const detailEvent = useMemo(
    () => changes.find((change) => change.id === detailEventId) ?? null,
    [changes, detailEventId]
  );

  const selectableEventIds = useMemo(
    () => changes.filter((change) => !change.acknowledged).map((change) => change.id),
    [changes]
  );

  const selectedUnacknowledgedIds = useMemo(
    () => selectableEventIds.filter((id) => selectedEventIds.has(id)),
    [selectableEventIds, selectedEventIds]
  );

  const allSelectableSelected = selectableEventIds.length > 0
    && selectableEventIds.every((id) => selectedEventIds.has(id));

  const toggleSelectAll = () => {
    setSelectedEventIds((previous) => {
      const next = new Set(previous);
      if (allSelectableSelected) {
        for (const id of selectableEventIds) next.delete(id);
      } else {
        for (const id of selectableEventIds) next.add(id);
      }
      return next;
    });
  };

  const toggleRowSelection = (eventId: string) => {
    setSelectedEventIds((previous) => {
      const next = new Set(previous);
      if (next.has(eventId)) {
        next.delete(eventId);
      } else {
        next.add(eventId);
      }
      return next;
    });
  };

  const acknowledgeEvent = useCallback(async (eventId: string, notes?: string) => {
    setError(null);
    setInfo(null);

    const response = await fetchWithAuth(`/network/changes/${eventId}/acknowledge`, {
      method: 'POST',
      body: JSON.stringify(notes ? { notes } : {})
    });

    if (!response.ok) {
      if (response.status === 403) {
        setCanAcknowledge(false);
      }
      throw new Error(await extractError(response, 'Failed to acknowledge event'));
    }

    setInfo('Event acknowledged.');
    await fetchChanges();
  }, [fetchChanges]);

  const linkDevice = useCallback(async (eventId: string, deviceId: string) => {
    setError(null);
    setInfo(null);

    const response = await fetchWithAuth(`/network/changes/${eventId}/link-device`, {
      method: 'POST',
      body: JSON.stringify({ deviceId })
    });

    if (!response.ok) {
      if (response.status === 403) {
        setCanLinkDevice(false);
      }
      throw new Error(await extractError(response, 'Failed to link device'));
    }

    setInfo('Device linked.');
    await fetchChanges();
  }, [fetchChanges]);

  const handleBulkAcknowledge = async () => {
    if (selectedUnacknowledgedIds.length === 0) return;

    setBulkWorking(true);
    setError(null);
    setInfo(null);

    try {
      const trimmedNotes = bulkNotes.trim();
      const response = await fetchWithAuth('/network/changes/bulk-acknowledge', {
        method: 'POST',
        body: JSON.stringify({
          eventIds: selectedUnacknowledgedIds,
          ...(trimmedNotes ? { notes: trimmedNotes } : {})
        })
      });

      if (!response.ok) {
        if (response.status === 403) {
          setCanAcknowledge(false);
        }
        throw new Error(await extractError(response, 'Failed to acknowledge selected events'));
      }

      const payload = await response.json().catch(() => null);
      const acknowledgedCount = payload && typeof payload === 'object' && typeof (payload as { acknowledgedCount?: unknown }).acknowledgedCount === 'number'
        ? (payload as { acknowledgedCount: number }).acknowledgedCount
        : selectedUnacknowledgedIds.length;

      setInfo(`Acknowledged ${acknowledgedCount} event(s).`);
      setSelectedEventIds(new Set());
      setBulkNotes('');
      await fetchChanges();
    } catch (bulkError) {
      setError(bulkError instanceof Error ? bulkError.message : 'Failed to acknowledge selected events');
    } finally {
      setBulkWorking(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <h2 className="text-lg font-semibold">Network Changes</h2>
            <p className="text-sm text-muted-foreground">
              Review and triage baseline change events across managed subnets.
            </p>
          </div>
          <button
            type="button"
            onClick={() => fetchChanges()}
            className="ml-auto inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Site</label>
            <select
              value={filters.siteId}
              onChange={(event) => setFilters((previous) => ({ ...previous, siteId: event.target.value }))}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">All sites</option>
              {siteOptions.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Baseline</label>
            <select
              value={filters.baselineId}
              onChange={(event) => setFilters((previous) => ({ ...previous, baselineId: event.target.value }))}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">All baselines</option>
              {baselines.map((baseline) => (
                <option key={baseline.id} value={baseline.id}>
                  {baseline.subnet}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Event Type</label>
            <select
              value={filters.eventType}
              onChange={(event) => setFilters((previous) => ({ ...previous, eventType: event.target.value as FilterState['eventType'] }))}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">All types</option>
              <option value="new_device">New device</option>
              <option value="device_disappeared">Disappeared</option>
              <option value="device_changed">Changed</option>
              <option value="rogue_device">Rogue</option>
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Acknowledged</label>
            <select
              value={filters.acknowledged}
              onChange={(event) => setFilters((previous) => ({ ...previous, acknowledged: event.target.value as FilterState['acknowledged'] }))}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">All</option>
              <option value="false">Unacknowledged</option>
              <option value="true">Acknowledged</option>
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Since</label>
            <input
              type="datetime-local"
              value={filters.since}
              onChange={(event) => setFilters((previous) => ({ ...previous, since: event.target.value }))}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>

        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <button
            type="button"
            onClick={() => setFilters(createDefaultFilters(currentSiteId))}
            className="rounded-md border px-2 py-1 hover:bg-muted"
          >
            Reset filters
          </button>
          <span>{changes.length} events loaded</span>
        </div>

        {!canAcknowledge && (
          <div className="mt-4 rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-sm text-yellow-800">
            Acknowledge actions disabled after permission check failure. Requires `alerts:acknowledge`.
          </div>
        )}
        {!canLinkDevice && (
          <div className="mt-4 rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-sm text-yellow-800">
            Device linking disabled after permission check failure. Requires `devices:write`.
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

        <div className="mt-4 flex flex-col gap-2 rounded-md border bg-muted/20 p-3 lg:flex-row lg:items-center">
          <div className="text-sm">
            <span className="font-medium">{selectedUnacknowledgedIds.length}</span> unacknowledged event(s) selected
          </div>
          <input
            type="text"
            value={bulkNotes}
            onChange={(event) => setBulkNotes(event.target.value)}
            placeholder="Optional bulk acknowledgement notes"
            className="h-9 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <button
            type="button"
            onClick={handleBulkAcknowledge}
            disabled={!canAcknowledge || bulkWorking || selectedUnacknowledgedIds.length === 0}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <CheckCircle2 className="h-4 w-4" />
            {bulkWorking ? 'Acknowledging...' : 'Acknowledge Selected'}
          </button>
        </div>

        <div className="mt-6 overflow-hidden rounded-md border">
          <table className="min-w-full divide-y">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">
                  <input
                    type="checkbox"
                    checked={allSelectableSelected}
                    onChange={toggleSelectAll}
                    className="h-4 w-4 rounded border"
                  />
                </th>
                <th className="px-4 py-3">Event</th>
                <th className="px-4 py-3">Subnet</th>
                <th className="px-4 py-3">Detected</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Linked Device</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {loading && changes.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-sm text-muted-foreground">
                    Loading network changes...
                  </td>
                </tr>
              ) : changes.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-sm text-muted-foreground">
                    No change events match the selected filters.
                  </td>
                </tr>
              ) : (
                changes.map((change) => {
                  const type = eventTypeConfig[change.eventType];
                  const subnet = change.baselineSubnet ?? baselineById.get(change.baselineId)?.subnet ?? 'Unknown';
                  const linkedDeviceLabel = change.linkedDeviceId
                    ? (deviceById.get(change.linkedDeviceId)?.label ?? change.linkedDeviceId)
                    : 'Not linked';

                  return (
                    <tr key={change.id} className="transition hover:bg-muted/40">
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selectedEventIds.has(change.id)}
                          onChange={() => toggleRowSelection(change.id)}
                          disabled={change.acknowledged}
                          className="h-4 w-4 rounded border disabled:opacity-40"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${type.color}`}>
                            {type.label}
                          </span>
                          <span className="font-mono text-sm">{change.ipAddress}</span>
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {change.hostname ?? 'Unknown host'} • {change.macAddress ?? 'No MAC'}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm">{subnet}</td>
                      <td className="px-4 py-3 text-sm">{formatDateTime(change.detectedAt, timezone)}</td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
                            change.acknowledged
                              ? 'bg-green-500/20 text-green-700 border-green-500/40'
                              : 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40'
                          }`}
                        >
                          {change.acknowledged ? 'Acknowledged' : 'Unacknowledged'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm">{linkedDeviceLabel}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => setDetailEventId(change.id)}
                            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
                          >
                            <Info className="h-3.5 w-3.5" />
                            Details
                          </button>
                          {!change.acknowledged && canAcknowledge && (
                            <button
                              type="button"
                              onClick={() => {
                                acknowledgeEvent(change.id).catch((ackError) => {
                                  setError(ackError instanceof Error ? ackError.message : 'Failed to acknowledge event');
                                });
                              }}
                              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
                            >
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              Ack
                            </button>
                          )}
                          {canLinkDevice && (
                            <button
                              type="button"
                              onClick={() => setDetailEventId(change.id)}
                              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
                            >
                              <Link2 className="h-3.5 w-3.5" />
                              Link
                            </button>
                          )}
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

      <NetworkChangeDetailModal
        open={detailEvent !== null}
        event={detailEvent}
        timezone={timezone}
        devices={devices}
        canAcknowledge={canAcknowledge}
        canLinkDevice={canLinkDevice}
        onClose={() => setDetailEventId(null)}
        onAcknowledge={acknowledgeEvent}
        onLinkDevice={linkDevice}
      />
    </div>
  );
}
