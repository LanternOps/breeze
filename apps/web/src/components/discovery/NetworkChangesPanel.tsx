import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Info, Link2, RefreshCw } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import NetworkChangeDetailModal from './NetworkChangeDetailModal';
import { ResponsiveTable, DataCard, CardField, CardActions } from '../shared/ResponsiveTable';
import {
  eventTypeConfig,
  formatDateTime,
  mapNetworkChangeEvent,
  type DeviceOption,
  type NetworkChangeEvent,
  type NetworkEventType
} from './networkTypes';

type SiteOption = {
  id: string;
  name: string;
};

type ProfileOption = {
  id: string;
  name: string;
  siteId: string | null;
  recordsChanges: boolean;
};

type NetworkChangesPanelProps = {
  currentOrgId: string | null;
  currentSiteId: string | null;
  siteOptions: SiteOption[];
  timezone?: string;
};

type FilterState = {
  siteId: string;
  profileId: string;
  eventType: 'all' | NetworkEventType;
  acknowledged: 'all' | 'true' | 'false';
  since: string;
};

function createDefaultFilters(currentSiteId: string | null): FilterState {
  return {
    siteId: currentSiteId ?? 'all',
    profileId: 'all',
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
  timezone
}: NetworkChangesPanelProps) {
  const [changes, setChanges] = useState<NetworkChangeEvent[]>([]);
  const [profiles, setProfiles] = useState<ProfileOption[]>([]);
  const [profilesLoaded, setProfilesLoaded] = useState(false);
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
    setFilters((previous) => ({ ...previous, siteId: currentSiteId ?? previous.siteId }));
  }, [currentSiteId]);

  const fetchProfiles = useCallback(async () => {
    setProfilesLoaded(false);
    const params = new URLSearchParams();
    if (currentOrgId) params.set('orgId', currentOrgId);
    const query = params.toString();

    const response = await fetchWithAuth(`/discovery/profiles${query ? `?${query}` : ''}`);
    if (!response.ok) {
      throw new Error(await extractError(response, 'Failed to load profile filters'));
    }

    const payload = await response.json();
    const items = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload)
        ? payload
        : [];

    const mapped: ProfileOption[] = items
      .map((row: Record<string, unknown>) => {
        const id = typeof row.id === 'string' ? row.id : null;
        const name = typeof row.name === 'string' ? row.name : null;
        if (!id || !name) return null;
        // A profile records discovery-scan change events only when the master
        // Alerting switch is on AND at least one recording sub-toggle is set —
        // the worker gates each insert on `enabled && alertOn{New,Changed,...}`
        // (assetApproval.ts), so `enabled: true` with every sub-toggle off
        // still records nothing. Mirror that here so the hint stays accurate.
        const alert = (row.alertSettings && typeof row.alertSettings === 'object')
          ? row.alertSettings as Record<string, unknown>
          : null;
        const recordsChanges = !!(alert
          && alert.enabled === true
          && [alert.alertOnNew, alert.alertOnChanged, alert.alertOnDisappeared]
            .some((flag) => flag === true));
        const siteId = typeof row.siteId === 'string' ? row.siteId : null;
        return { id, name, siteId, recordsChanges };
      })
      .filter((row: ProfileOption | null): row is ProfileOption => row !== null);

    setProfiles(mapped);
    setProfilesLoaded(true);
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
      if (filters.profileId !== 'all') params.set('profileId', filters.profileId);
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
    Promise.all([fetchProfiles(), fetchDevices()]).catch((fetchError) => {
      setError(fetchError instanceof Error ? fetchError.message : 'Failed to load network metadata');
    });
  }, [fetchProfiles, fetchDevices]);

  useEffect(() => {
    fetchChanges();
  }, [fetchChanges]);

  const profileById = useMemo(
    () => new Map(profiles.map((profile) => [profile.id, profile])),
    [profiles]
  );

  // Discovery-scan change events are only recorded for profiles that have
  // Alerting enabled with a recording sub-toggle on (assetApproval.ts gates
  // `shouldAlert` on `alertSettings.enabled && alertOn*`, and discoveryWorker.ts
  // only inserts a network_change_event when `shouldAlert` is true). Surface
  // that prerequisite in the empty state so an empty Changes tab isn't misread
  // as a bug. Assumes the profile list from /discovery/profiles is complete
  // (it is currently unpaginated).
  const alertingPrerequisite = useMemo<
    { state: 'profile-disabled' | 'all-disabled'; profileName?: string } | null
  >(() => {
    if (profiles.length === 0) return null;

    if (filters.profileId !== 'all') {
      const selected = profileById.get(filters.profileId);
      if (selected && !selected.recordsChanges) {
        return { state: 'profile-disabled', profileName: selected.name };
      }
      return null;
    }

    // No specific profile selected: scope the check to the active site filter so
    // a disabled site isn't masked by an enabled profile elsewhere in the org.
    const inScope = filters.siteId === 'all'
      ? profiles
      : profiles.filter((profile) => profile.siteId === filters.siteId);
    if (inScope.length > 0 && inScope.every((profile) => !profile.recordsChanges)) {
      return { state: 'all-disabled' };
    }
    return null;
  }, [profiles, profileById, filters.profileId, filters.siteId]);

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

  // Row pieces shared by the desktop table and the mobile cards.
  const renderSelectCheckbox = (change: NetworkChangeEvent) => (
    <input
      type="checkbox"
      checked={selectedEventIds.has(change.id)}
      onChange={() => toggleRowSelection(change.id)}
      disabled={change.acknowledged}
      className="h-4 w-4 rounded border disabled:opacity-40"
    />
  );

  const renderEventInfo = (change: NetworkChangeEvent) => {
    const type = eventTypeConfig[change.eventType];
    return (
      <>
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${type.color}`}>
            {type.label}
          </span>
          <span className="font-mono text-sm">{change.ipAddress}</span>
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {change.hostname ?? 'Unknown host'} • {change.macAddress ?? 'No MAC'}
        </div>
      </>
    );
  };

  const renderStatusBadge = (change: NetworkChangeEvent) => (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
        change.acknowledged
          ? 'bg-success/15 text-success border-success/30'
          : 'bg-warning/15 text-warning border-warning/30'
      }`}
    >
      {change.acknowledged ? 'Acknowledged' : 'Unacknowledged'}
    </span>
  );

  const renderActions = (change: NetworkChangeEvent) => (
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
  );

  const genericEmptyState = (
    <span className="text-sm text-muted-foreground">No change events match the selected filters.</span>
  );

  const renderEmptyState = () =>
    !profilesLoaded ? genericEmptyState : profiles.length === 0 ? (
      <div className="mx-auto max-w-xl space-y-3 text-sm text-muted-foreground" data-testid="changes-no-profiles-hint">
        <div className="space-y-1">
          <p className="font-medium text-foreground">Set up a network discovery profile to start tracking changes.</p>
          <p>
            Network change events are created by discovery profiles. Create a profile and enable Alerting
            to record new, changed, or disappeared devices.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            if (typeof window !== 'undefined') window.location.hash = 'profiles';
          }}
          className="inline-flex items-center rounded-md border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
          data-testid="changes-create-profile"
        >
          Go to Profiles
        </button>
      </div>
    ) : alertingPrerequisite ? (
      <div className="mx-auto max-w-xl space-y-1 text-sm text-muted-foreground" data-testid="changes-alerting-hint">
        <p className="font-medium text-foreground">No change events recorded yet.</p>
        <p>
          {alertingPrerequisite.state === 'profile-disabled'
            ? `Discovery scans on “${alertingPrerequisite.profileName}” won’t record changes until Alerting is enabled on that profile.`
            : 'Discovery scans won’t record changes until Alerting is enabled on a discovery profile.'}
          {' '}Enable <span className="font-medium text-foreground">Alerting</span> in the profile’s
          settings (Profiles tab) to start tracking network changes.
        </p>
      </div>
    ) : genericEmptyState;

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <h2 className="text-lg font-semibold">Network Changes</h2>
            <p className="text-sm text-muted-foreground">
              Review and triage network change events across discovery profiles.
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
              aria-label="Site"
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
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Profile</label>
            <select
              aria-label="Profile"
              value={filters.profileId}
              onChange={(event) => setFilters((previous) => ({ ...previous, profileId: event.target.value }))}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="all">All profiles</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
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

        <ResponsiveTable
          className="mt-6"
          table={
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
                  <th className="px-4 py-3">Profile</th>
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
                    <td colSpan={7} className="px-4 py-6 text-center">
                      {renderEmptyState()}
                    </td>
                  </tr>
                ) : (
                  changes.map((change) => {
                    const profileName = change.profileId ? (profileById.get(change.profileId)?.name ?? 'Unknown') : 'Unknown';
                    const linkedDeviceLabel = change.linkedDeviceId
                      ? (deviceById.get(change.linkedDeviceId)?.label ?? change.linkedDeviceId)
                      : 'Not linked';

                    return (
                      <tr key={change.id} className="transition hover:bg-muted/40">
                        <td className="px-4 py-3">{renderSelectCheckbox(change)}</td>
                        <td className="px-4 py-3">{renderEventInfo(change)}</td>
                        <td className="px-4 py-3 text-sm">{profileName}</td>
                        <td className="px-4 py-3 text-sm">{formatDateTime(change.detectedAt, timezone)}</td>
                        <td className="px-4 py-3">{renderStatusBadge(change)}</td>
                        <td className="px-4 py-3 text-sm">{linkedDeviceLabel}</td>
                        <td className="px-4 py-3">{renderActions(change)}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          }
          cards={
            loading && changes.length === 0 ? (
              <DataCard>
                <p className="py-2 text-center text-sm text-muted-foreground">Loading network changes...</p>
              </DataCard>
            ) : changes.length === 0 ? (
              <DataCard>
                <div className="py-2 text-center">{renderEmptyState()}</div>
              </DataCard>
            ) : (
              changes.map((change) => {
                const profileName = change.profileId ? (profileById.get(change.profileId)?.name ?? 'Unknown') : 'Unknown';
                const linkedDeviceLabel = change.linkedDeviceId
                  ? (deviceById.get(change.linkedDeviceId)?.label ?? change.linkedDeviceId)
                  : 'Not linked';

                return (
                  <DataCard key={change.id}>
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 shrink-0">{renderSelectCheckbox(change)}</div>
                      <div className="min-w-0 flex-1">{renderEventInfo(change)}</div>
                    </div>
                    <div className="mt-3 space-y-2 border-t pt-3">
                      <CardField label="Profile">{profileName}</CardField>
                      <CardField label="Detected">{formatDateTime(change.detectedAt, timezone)}</CardField>
                      <CardField label="Status">{renderStatusBadge(change)}</CardField>
                      <CardField label="Linked Device">{linkedDeviceLabel}</CardField>
                    </div>
                    <CardActions>{renderActions(change)}</CardActions>
                  </DataCard>
                );
              })
            )
          }
        />
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
