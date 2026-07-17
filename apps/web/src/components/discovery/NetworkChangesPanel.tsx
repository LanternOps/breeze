import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Info, Link2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
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

// Site filtering is owned by this panel's own filter select (the global
// switcher no longer carries a site dimension).
function createDefaultFilters(): FilterState {
  return {
    siteId: 'all',
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
  siteOptions,
  timezone
}: NetworkChangesPanelProps) {
  const { t } = useTranslation('discovery');
  const [changes, setChanges] = useState<NetworkChangeEvent[]>([]);
  const [profiles, setProfiles] = useState<ProfileOption[]>([]);
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [profilesError, setProfilesError] = useState(false);
  const [devices, setDevices] = useState<DeviceOption[]>([]);
  const [filters, setFilters] = useState<FilterState>(() => createDefaultFilters());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [selectedEventIds, setSelectedEventIds] = useState<Set<string>>(new Set());
  const [bulkNotes, setBulkNotes] = useState('');
  const [bulkWorking, setBulkWorking] = useState(false);
  const [canAcknowledge, setCanAcknowledge] = useState(true);
  const [canLinkDevice, setCanLinkDevice] = useState(true);
  const [detailEventId, setDetailEventId] = useState<string | null>(null);

  const fetchProfiles = useCallback(async () => {
    setProfilesLoaded(false);
    setProfilesError(false);
    const params = new URLSearchParams();
    if (currentOrgId) params.set('orgId', currentOrgId);
    const query = params.toString();

    try {
      const response = await fetchWithAuth(`/discovery/profiles${query ? `?${query}` : ''}`);
      if (!response.ok) {
        throw new Error(await extractError(response, t('networkChangesPanel.errors.loadProfileFilters')));
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
    } catch (profilesFetchError) {
      // Mark the profiles fetch as settled-with-error so the empty state
      // resolves to the generic message (not a perpetual spinner, not the
      // setup CTA). Re-throw so the Promise.all catch still surfaces the banner.
      setProfilesError(true);
      throw profilesFetchError;
    }
  }, [currentOrgId, t]);

  const fetchDevices = useCallback(async () => {
    const params = new URLSearchParams();
    params.set('page', '1');
    params.set('limit', '200');
    if (currentOrgId) params.set('orgId', currentOrgId);

    const response = await fetchWithAuth(`/devices?${params.toString()}`);
    if (!response.ok) {
      throw new Error(await extractError(response, t('networkChangesPanel.errors.loadDevices')));
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
  }, [currentOrgId, t]);

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
        throw new Error(await extractError(response, t('networkChangesPanel.errors.loadChanges')));
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
      setError(fetchError instanceof Error ? fetchError.message : t('networkChangesPanel.errors.loadChanges'));
    } finally {
      setLoading(false);
    }
  }, [currentOrgId, filters, t]);

  useEffect(() => {
    Promise.all([fetchProfiles(), fetchDevices()]).catch((fetchError) => {
      setError(fetchError instanceof Error ? fetchError.message : t('networkChangesPanel.errors.loadMetadata'));
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
      throw new Error(await extractError(response, t('networkChangesPanel.errors.acknowledgeEvent')));
    }

    setInfo(t('networkChangesPanel.messages.eventAcknowledged'));
    await fetchChanges();
  }, [fetchChanges, t]);

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
      throw new Error(await extractError(response, t('networkChangesPanel.errors.linkDevice')));
    }

    setInfo(t('networkChangesPanel.messages.deviceLinked'));
    await fetchChanges();
  }, [fetchChanges, t]);

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
        throw new Error(await extractError(response, t('networkChangesPanel.errors.acknowledgeSelected')));
      }

      const payload = await response.json().catch(() => null);
      const acknowledgedCount = payload && typeof payload === 'object' && typeof (payload as { acknowledgedCount?: unknown }).acknowledgedCount === 'number'
        ? (payload as { acknowledgedCount: number }).acknowledgedCount
        : selectedUnacknowledgedIds.length;

      setInfo(t('networkChangesPanel.messages.acknowledgedCount', { count: acknowledgedCount }));
      setSelectedEventIds(new Set());
      setBulkNotes('');
      await fetchChanges();
    } catch (bulkError) {
      setError(bulkError instanceof Error ? bulkError.message : t('networkChangesPanel.errors.acknowledgeSelected'));
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
            {t(/* i18n-dynamic */ `networkEvents.type.${change.eventType}`)}
          </span>
          <span className="font-mono text-sm">{change.ipAddress}</span>
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {change.hostname ?? t('networkChangesPanel.unknownHost')} • {change.macAddress ?? t('networkChangesPanel.noMac')}
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
      {change.acknowledged ? t('networkChangesPanel.status.acknowledged') : t('networkChangesPanel.status.unacknowledged')}
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
        {t('networkChangesPanel.actions.details')}
      </button>
      {!change.acknowledged && canAcknowledge && (
        <button
          type="button"
          onClick={() => {
            acknowledgeEvent(change.id).catch((ackError) => {
                setError(ackError instanceof Error ? ackError.message : t('networkChangesPanel.errors.acknowledgeEvent'));
            });
          }}
          className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
          {t('networkChangesPanel.actions.ack')}
        </button>
      )}
      {canLinkDevice && (
        <button
          type="button"
          onClick={() => setDetailEventId(change.id)}
          className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
        >
          <Link2 className="h-3.5 w-3.5" />
          {t('networkChangesPanel.actions.link')}
        </button>
      )}
    </div>
  );

  const genericEmptyState = (
    <span className="text-sm text-muted-foreground">{t('networkChangesPanel.empty.filtered')}</span>
  );

  // Don't render the *terminal* empty state until BOTH fetches have settled.
  // The changes fetch (`loading`) and the profiles fetch (`profilesLoaded` /
  // `profilesError`) run as independent effects; without this gate a genuine
  // no-profiles org briefly flashes the generic "no events" copy before the
  // setup CTA appears once profiles resolve. While profiles are still in
  // flight (neither loaded nor errored) we keep showing the loading row.
  const profilesSettled = profilesLoaded || profilesError;
  const emptyStateResolving = changes.length === 0 && (loading || !profilesSettled);

  // Reached only once profiles have settled (the gate above intercepts the
  // still-loading case). When `profilesLoaded` is false here, it means the
  // profiles fetch errored — fall through to the generic message rather than
  // the setup CTA.
  const renderEmptyState = () =>
    !profilesLoaded ? genericEmptyState : profiles.length === 0 ? (
      <div className="mx-auto max-w-xl space-y-3 text-sm text-muted-foreground" data-testid="changes-no-profiles-hint">
        <div className="space-y-1">
          <p className="font-medium text-foreground">{t('networkChangesPanel.empty.noProfilesTitle')}</p>
          <p>
            {t('networkChangesPanel.empty.noProfilesDescription')}
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
          {t('networkChangesPanel.actions.goToProfiles')}
        </button>
      </div>
    ) : alertingPrerequisite ? (
      <div className="mx-auto max-w-xl space-y-1 text-sm text-muted-foreground" data-testid="changes-alerting-hint">
        <p className="font-medium text-foreground">{t('networkChangesPanel.empty.noEventsTitle')}</p>
        <p>
          {alertingPrerequisite.state === 'profile-disabled'
            ? t('networkChangesPanel.empty.profileAlertingDisabled', { profile: alertingPrerequisite.profileName })
            : t('networkChangesPanel.empty.alertingDisabled')}
          {' '}<span className="font-medium text-foreground">{t('networkChangesPanel.empty.enableAlerting')}</span>{' '}
          {t('networkChangesPanel.empty.enableAlertingSuffix')}
        </p>
      </div>
    ) : genericEmptyState;

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <h2 className="text-lg font-semibold">{t('networkChangesPanel.title')}</h2>
            <p className="text-sm text-muted-foreground">
              {t('networkChangesPanel.description')}
            </p>
          </div>
          <button
            type="button"
            onClick={() => fetchChanges()}
            className="ml-auto inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
          >
            <RefreshCw className="h-4 w-4" />
            {t('common:actions.refresh')}
          </button>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('common:labels.site')}</label>
            <select
              aria-label={t('common:labels.site')}
              value={filters.siteId}
              onChange={(event) => setFilters((previous) => ({ ...previous, siteId: event.target.value }))}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            >
              <option value="all">{t('networkChangesPanel.options.allSites')}</option>
              {siteOptions.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('networkChangesPanel.fields.profile')}</label>
            <select
              aria-label={t('networkChangesPanel.fields.profile')}
              value={filters.profileId}
              onChange={(event) => setFilters((previous) => ({ ...previous, profileId: event.target.value }))}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            >
              <option value="all">{t('networkChangesPanel.options.allProfiles')}</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('networkChangesPanel.fields.eventType')}</label>
            <select
              value={filters.eventType}
              onChange={(event) => setFilters((previous) => ({ ...previous, eventType: event.target.value as FilterState['eventType'] }))}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            >
              <option value="all">{t('networkChangesPanel.options.allTypes')}</option>
              <option value="new_device">{t('networkEvents.type.new_device')}</option>
              <option value="device_disappeared">{t('networkEvents.type.device_disappeared')}</option>
              <option value="device_changed">{t('networkEvents.type.device_changed')}</option>
              <option value="rogue_device">{t('networkEvents.type.rogue_device')}</option>
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('networkChangesPanel.fields.acknowledged')}</label>
            <select
              value={filters.acknowledged}
              onChange={(event) => setFilters((previous) => ({ ...previous, acknowledged: event.target.value as FilterState['acknowledged'] }))}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            >
              <option value="all">{t('common:labels.all')}</option>
              <option value="false">{t('networkChangesPanel.status.unacknowledged')}</option>
              <option value="true">{t('networkChangesPanel.status.acknowledged')}</option>
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('networkChangesPanel.fields.since')}</label>
            <input
              type="datetime-local"
              value={filters.since}
              onChange={(event) => setFilters((previous) => ({ ...previous, since: event.target.value }))}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>

        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <button
            type="button"
            onClick={() => setFilters(createDefaultFilters())}
            className="rounded-md border px-2 py-1 hover:bg-muted"
          >
            {t('networkChangesPanel.actions.resetFilters')}
          </button>
          <span>{t('networkChangesPanel.eventsLoaded', { count: changes.length })}</span>
        </div>

        {!canAcknowledge && (
          <div className="mt-4 rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-sm text-yellow-800">
            {t('networkChangesPanel.permissionAcknowledge')}
          </div>
        )}
        {!canLinkDevice && (
          <div className="mt-4 rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-sm text-yellow-800">
            {t('networkChangesPanel.permissionLink')}
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
            {t('networkChangesPanel.selectedUnacknowledged', { count: selectedUnacknowledgedIds.length })}
          </div>
          <input
            type="text"
            value={bulkNotes}
            onChange={(event) => setBulkNotes(event.target.value)}
            placeholder={t('networkChangesPanel.placeholders.bulkNotes')}
            className="h-9 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          />
          <button
            type="button"
            onClick={handleBulkAcknowledge}
            disabled={!canAcknowledge || bulkWorking || selectedUnacknowledgedIds.length === 0}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <CheckCircle2 className="h-4 w-4" />
            {bulkWorking ? t('networkChangesPanel.actions.acknowledging') : t('networkChangesPanel.actions.acknowledgeSelected')}
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
                  <th className="px-4 py-3">{t('networkChangesPanel.columns.event')}</th>
                  <th className="px-4 py-3">{t('networkChangesPanel.fields.profile')}</th>
                  <th className="px-4 py-3">{t('networkChangesPanel.columns.detected')}</th>
                  <th className="px-4 py-3">{t('common:labels.status')}</th>
                  <th className="px-4 py-3">{t('networkChangesPanel.columns.linkedDevice')}</th>
                  <th className="px-4 py-3 text-right">{t('common:labels.actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {emptyStateResolving ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-6 text-center text-sm text-muted-foreground">
                      {t('networkChangesPanel.loading')}
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
                    const profileName = change.profileId ? (profileById.get(change.profileId)?.name ?? t('common:states.unknown')) : t('common:states.unknown');
                    const linkedDeviceLabel = change.linkedDeviceId
                      ? (deviceById.get(change.linkedDeviceId)?.label ?? change.linkedDeviceId)
                      : t('networkChangesPanel.notLinked');

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
            emptyStateResolving ? (
              <DataCard>
                <p className="py-2 text-center text-sm text-muted-foreground">{t('networkChangesPanel.loading')}</p>
              </DataCard>
            ) : changes.length === 0 ? (
              <DataCard>
                <div className="py-2 text-center">{renderEmptyState()}</div>
              </DataCard>
            ) : (
              changes.map((change) => {
                const profileName = change.profileId ? (profileById.get(change.profileId)?.name ?? t('common:states.unknown')) : t('common:states.unknown');
                const linkedDeviceLabel = change.linkedDeviceId
                  ? (deviceById.get(change.linkedDeviceId)?.label ?? change.linkedDeviceId)
                  : t('networkChangesPanel.notLinked');

                return (
                  <DataCard key={change.id}>
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 shrink-0">{renderSelectCheckbox(change)}</div>
                      <div className="min-w-0 flex-1">{renderEventInfo(change)}</div>
                    </div>
                    <div className="mt-3 space-y-2 border-t pt-3">
                      <CardField label={t('networkChangesPanel.fields.profile')}>{profileName}</CardField>
                      <CardField label={t('networkChangesPanel.columns.detected')}>{formatDateTime(change.detectedAt, timezone)}</CardField>
                      <CardField label={t('common:labels.status')}>{renderStatusBadge(change)}</CardField>
                      <CardField label={t('networkChangesPanel.columns.linkedDevice')}>{linkedDeviceLabel}</CardField>
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
