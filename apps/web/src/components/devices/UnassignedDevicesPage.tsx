import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Inbox, RefreshCw } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { usePreAssignmentGate } from '../../stores/featuresStore';
import { navigateTo } from '../../lib/navigation';
import AssignParkedDeviceDialog, { type ParkedDeviceSummary } from './AssignParkedDeviceDialog';
import { useHashState } from '../../lib/useHashState';
import '../../lib/i18n';

/** One row of GET /pre-assignment/devices. Identity fields are device-reported. */
export interface ParkedDeviceRow extends ParkedDeviceSummary {
  agentVersion: string;
  status: string;
  parkedAt: string;
  lastSeenAt: string | null;
  deployKeyName: string | null;
}

/** The largest batch POST /pre-assignment/devices/assign-bulk accepts. */
const MAX_BATCH = 50;

/** The hash names the device whose assign dialog is open (URL state convention). */
function parseHashDeviceId(hash: string): string | null | undefined {
  return hash.length > 0 ? decodeURIComponent(hash) : undefined;
}

function writeHash(deviceId: string | null) {
  if (typeof window === 'undefined') return;
  if (deviceId) {
    window.location.hash = encodeURIComponent(deviceId);
  } else if (window.location.hash) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
}

/**
 * Devices enrolled with a partner deploy key wait in the partner's holding
 * area until a full partner admin assigns them. Only full partner admins reach
 * this page (the API refuses everyone else with 403).
 */
/**
 * The Unassigned Devices surface exists only while the platform's
 * PRE_ASSIGNMENT_ENROLLMENT_ENABLED switch is on (runtime /config). With it
 * off the page renders nothing and sends the user to the device list; the
 * pre-assignment API itself stays available to full partner admins.
 */
export default function UnassignedDevicesPage() {
  const { enabled, loaded } = usePreAssignmentGate();
  useEffect(() => {
    if (loaded && !enabled) void navigateTo('/devices', { replace: true });
  }, [loaded, enabled]);
  if (!loaded || !enabled) return null;
  return <UnassignedDevicesContent />;
}

function UnassignedDevicesContent() {
  const { t } = useTranslation('devices');
  const [devices, setDevices] = useState<ParkedDeviceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useHashState<string | null>(null, parseHashDeviceId);
  const [bulkOpen, setBulkOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetchWithAuth('/pre-assignment/devices');
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(typeof body?.error === 'string' ? body.error : t('unassignedDevices.loadFailed'));
      }
      const body = await response.json();
      const list: ParkedDeviceRow[] = Array.isArray(body?.devices) ? body.devices : [];
      setDevices(list);
      setSelected((prev) => new Set([...prev].filter((id) => list.some((d) => d.id === id))));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t('unassignedDevices.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  const activeDevice = useMemo(() => devices.find((d) => d.id === activeId) ?? null, [devices, activeId]);
  const selectedDevices = useMemo(() => devices.filter((d) => selected.has(d.id)), [devices, selected]);
  const allSelected = devices.length > 0 && selected.size === Math.min(devices.length, MAX_BATCH);

  const atCap = selected.size >= MAX_BATCH;
  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else if (next.size < MAX_BATCH) next.add(id);
    return next;
  });

  const openSingle = (id: string) => { setActiveId(id); writeHash(id); };
  const closeSingle = () => { setActiveId(null); writeHash(null); };
  const completed = () => { setSelected(new Set()); void load(); };

  const formatDate = (value: string | null) => (value ? new Date(value).toLocaleString() : t('unassignedDevices.never'));

  return (
    <div className="space-y-4" data-testid="unassigned-devices-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">{t('unassignedDevices.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('unassignedDevices.description')}</p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted"
            data-testid="parked-devices-refresh"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            {t('unassignedDevices.refresh')}
          </button>
          <button
            type="button"
            onClick={() => setBulkOpen(true)}
            disabled={selectedDevices.length < 2}
            className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            data-testid="parked-devices-bulk-assign"
          >
            {t('unassignedDevices.bulkAssign', { count: selectedDevices.length })}
          </button>
        </div>
      </div>

      {atCap && (
        <p className="text-xs text-warning" data-testid="parked-devices-selection-cap">
          {t('unassignedDevices.selectionCap', { max: MAX_BATCH })}
        </p>
      )}

      <p className="text-xs text-muted-foreground" data-testid="parked-devices-reported-caption">
        {t('unassignedDevices.reportedCaption')}
      </p>

      {loading ? (
        <p className="text-sm text-muted-foreground" data-testid="parked-devices-loading">{t('unassignedDevices.loading')}</p>
      ) : loadError ? (
        <p className="text-sm text-destructive" role="alert" data-testid="parked-devices-error">{loadError}</p>
      ) : devices.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-md border border-dashed p-10 text-center" data-testid="parked-devices-empty">
          <Inbox className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">{t('unassignedDevices.empty')}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="w-10 px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label={t('unassignedDevices.selectAll')}
                    checked={allSelected}
                    onChange={() => setSelected(allSelected ? new Set() : new Set(devices.slice(0, MAX_BATCH).map((d) => d.id)))}
                    data-testid="parked-devices-select-all"
                  />
                </th>
                <th className="px-3 py-2">{t('unassignedDevices.columns.hostname')}</th>
                <th className="px-3 py-2">{t('unassignedDevices.columns.os')}</th>
                <th className="px-3 py-2">{t('unassignedDevices.columns.serial')}</th>
                <th className="px-3 py-2">{t('unassignedDevices.columns.mac')}</th>
                <th className="px-3 py-2">{t('unassignedDevices.columns.deployKey')}</th>
                <th className="px-3 py-2">{t('unassignedDevices.columns.parkedAt')}</th>
                <th className="px-3 py-2">{t('unassignedDevices.columns.lastSeen')}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr
                  key={d.id}
                  className={`border-t ${activeId === d.id ? 'bg-muted/40' : ''}`}
                  data-testid={`parked-device-row-${d.id}`}
                >
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label={t('unassignedDevices.selectRow', { hostname: d.hostname })}
                      checked={selected.has(d.id)}
                      onChange={() => toggle(d.id)}
                      disabled={atCap && !selected.has(d.id)}
                      data-testid={`parked-device-select-${d.id}`}
                    />
                  </td>
                  <td className="px-3 py-2 font-medium">{d.hostname}</td>
                  <td className="px-3 py-2">{`${d.osType} ${d.osVersion}`}</td>
                  <td className="px-3 py-2">{d.serialNumber ?? '—'}</td>
                  <td className="px-3 py-2">{d.primaryMacAddress ?? '—'}</td>
                  <td className="px-3 py-2">{d.deployKeyName ?? '—'}</td>
                  <td className="px-3 py-2">{formatDate(d.parkedAt)}</td>
                  <td className="px-3 py-2">{formatDate(d.lastSeenAt)}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => openSingle(d.id)}
                      className="rounded-md border px-3 py-1 text-sm hover:bg-muted"
                      data-testid={`parked-device-assign-${d.id}`}
                    >
                      {t('unassignedDevices.assign')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeDevice && (
        <AssignParkedDeviceDialog
          open
          devices={[activeDevice]}
          onClose={closeSingle}
          onCompleted={completed}
        />
      )}
      {bulkOpen && selectedDevices.length > 1 && (
        <AssignParkedDeviceDialog
          open
          devices={selectedDevices}
          onClose={() => setBulkOpen(false)}
          onCompleted={completed}
        />
      )}
    </div>
  );
}
