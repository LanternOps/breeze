import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  CheckSquare,
  Download,
  ExternalLink,
  Loader2,
  Minus,
  Monitor,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Square
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { formatRelativeTime, type DevicePatchRow } from './patchHelpers';
import { usePatchSelection } from './usePatchSelection';
import { useBulkActions } from './useBulkActions';

export default function PatchDevicesTab() {
  const [devices, setDevices] = useState<DevicePatchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [searchQuery, setSearchQuery] = useState('');
  const [osFilter, setOsFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const fetchDevices = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const [complianceRes, devicesRes] = await Promise.all([
        fetchWithAuth('/patches/compliance'),
        fetchWithAuth('/devices?limit=200')
      ]);
      if (!complianceRes.ok || !devicesRes.ok) {
        if (complianceRes.status === 401 || devicesRes.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        throw new Error('Failed to fetch device patch data');
      }

      const complianceData = (await complianceRes.json()).data ?? {};
      const needingList = complianceData.devicesNeedingPatches ?? complianceData.devices_needing_patches ?? [];
      const allDevicesPayload = await devicesRes.json();
      const allDevices = allDevicesPayload.devices ?? allDevicesPayload.data ?? allDevicesPayload.items ?? [];

      const needingMap = new Map<string, Record<string, unknown>>();
      if (Array.isArray(needingList)) {
        for (const d of needingList) {
          const id = String(d.id ?? d.deviceId ?? '');
          if (id) needingMap.set(id, d);
        }
      }

      const merged: DevicePatchRow[] = [];
      if (Array.isArray(allDevices)) {
        for (const raw of allDevices) {
          const id = String(raw.id ?? '');
          const n = needingMap.get(id);
          merged.push({
            id,
            hostname: String(n?.name ?? n?.hostname ?? raw.hostname ?? 'Unknown'),
            osType: String(n?.os ?? n?.osType ?? raw.osType ?? raw.os_type ?? 'unknown'),
            lastSeenAt: (n?.lastSeen ?? raw.lastSeenAt) ? String(n?.lastSeen ?? raw.lastSeenAt) : undefined,
            pendingPatches: Number(n?.missingCount ?? 0),
            criticalMissing: Number(n?.criticalCount ?? 0),
            importantMissing: Number(n?.importantCount ?? 0),
            osMissing: Number(n?.osMissing ?? 0),
            thirdPartyMissing: Number(n?.thirdPartyMissing ?? 0),
            lastInstalledAt: n?.lastInstalledAt ? String(n.lastInstalledAt) : undefined,
            lastScannedAt: n?.lastScannedAt ? String(n.lastScannedAt) : undefined,
            pendingReboot: Boolean(n?.pendingReboot),
          });
        }
      }

      merged.sort((a, b) => b.criticalMissing - a.criticalMissing || b.pendingPatches - a.pendingPatches);
      setDevices(merged);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch device data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDevices();
  }, [fetchDevices]);

  const osOptions = useMemo(() => {
    const osSet = new Set(devices.map(d => d.osType));
    return Array.from(osSet).sort();
  }, [devices]);

  const filteredDevices = useMemo(() => {
    let list = devices;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(d => d.hostname.toLowerCase().includes(q));
    }
    if (osFilter !== 'all') {
      list = list.filter(d => d.osType === osFilter);
    }
    if (statusFilter === 'needs-patches') {
      list = list.filter(d => d.pendingPatches > 0);
    } else if (statusFilter === 'compliant') {
      list = list.filter(d => d.pendingPatches === 0);
    } else if (statusFilter === 'critical') {
      list = list.filter(d => d.criticalMissing > 0);
    } else if (statusFilter === 'reboot') {
      list = list.filter(d => d.pendingReboot);
    } else if (statusFilter === '3rd-party') {
      list = list.filter(d => d.thirdPartyMissing > 0);
    }
    return list;
  }, [devices, searchQuery, osFilter, statusFilter]);

  const hasActiveFilters = searchQuery !== '' || osFilter !== 'all' || statusFilter !== 'all';

  const filteredIds = useMemo(() => filteredDevices.map(d => d.id), [filteredDevices]);
  const { selectedIds, allPageSelected: allSelected, somePageSelected: someSelected, toggleSelect, toggleSelectAll, clearSelection } = usePatchSelection(filteredIds);
  const { bulkAction, bulkError, bulkSuccess, handleBulkScan, handleBulkInstall } = useBulkActions(selectedIds, clearSelection, fetchDevices);

  const selectedWithPatches = useMemo(() => {
    return Array.from(selectedIds).filter(id => {
      const d = devices.find(dev => dev.id === id);
      return d && d.pendingPatches > 0;
    }).length;
  }, [selectedIds, devices]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
          <p className="mt-4 text-sm text-muted-foreground">Loading device patch data...</p>
        </div>
      </div>
    );
  }

  if (error && devices.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button type="button" onClick={fetchDevices} className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
          Try again
        </button>
      </div>
    );
  }

  const nonCompliantCount = devices.filter(d => d.pendingPatches > 0).length;
  const rebootCount = devices.filter(d => d.pendingReboot).length;

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Device Patch Status</h2>
          <p className="text-sm text-muted-foreground">
            {nonCompliantCount} of {devices.length} devices need patches
            {rebootCount > 0 && <span className="ml-1 text-orange-600">&middot; {rebootCount} pending reboot</span>}
            {filteredDevices.length !== devices.length && ` (showing ${filteredDevices.length})`}
          </p>
        </div>
        <button
          type="button"
          onClick={fetchDevices}
          disabled={loading}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border bg-background px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          Refresh
        </button>
      </div>

      {/* Filters */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            placeholder="Search devices..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="h-9 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-56"
          />
        </div>
        <select
          value={osFilter}
          onChange={e => setOsFilter(e.target.value)}
          className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="all">All OS</option>
          {osOptions.map(os => (
            <option key={os} value={os}>{os}</option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="all">All Status</option>
          <option value="needs-patches">Needs Patches</option>
          <option value="critical">Critical Missing</option>
          <option value="reboot">Pending Reboot</option>
          <option value="3rd-party">3rd-Party Missing</option>
          <option value="compliant">Compliant</option>
        </select>
        {hasActiveFilters && (
          <button
            type="button"
            onClick={() => { setSearchQuery(''); setOsFilter('all'); setStatusFilter('all'); }}
            className="h-9 rounded-md px-3 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Bulk action toolbar */}
      {selectedIds.size > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border bg-muted/50 px-4 py-3">
          <span className="text-sm font-medium">
            {selectedIds.size} {selectedIds.size === 1 ? 'device' : 'devices'} selected
          </span>
          <div className="h-4 w-px bg-border" />
          <button
            type="button"
            onClick={handleBulkScan}
            disabled={bulkAction !== null}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-background px-3 text-xs font-medium hover:bg-muted disabled:opacity-50"
          >
            {bulkAction === 'scan' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Scan for Patches
          </button>
          {selectedWithPatches > 0 && (
            <button
              type="button"
              onClick={handleBulkInstall}
              disabled={bulkAction !== null}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {bulkAction === 'install' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              Install Patches ({selectedWithPatches})
            </button>
          )}
          <button
            type="button"
            onClick={clearSelection}
            className="ml-auto h-8 rounded-md px-3 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            Clear selection
          </button>
        </div>
      )}

      {bulkError && (
        <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {bulkError}
        </div>
      )}
      {bulkSuccess && (
        <div className="mt-3 rounded-md border border-green-500/40 bg-green-500/10 px-4 py-2 text-sm text-green-700">
          {bulkSuccess}
        </div>
      )}

      {/* Device table */}
      <div className="mt-4 overflow-x-auto rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="w-10 px-3 py-3">
                <button
                  type="button"
                  onClick={toggleSelectAll}
                  className="flex items-center justify-center text-muted-foreground hover:text-foreground"
                  title={allSelected ? 'Deselect all' : 'Select all'}
                >
                  {allSelected ? <CheckSquare className="h-4 w-4" /> : someSelected ? <Minus className="h-4 w-4" /> : <Square className="h-4 w-4" />}
                </button>
              </th>
              <th className="px-3 py-3">Device</th>
              <th className="px-3 py-3">Status</th>
              <th className="px-3 py-3">OS Patches</th>
              <th className="px-3 py-3">3rd-Party</th>
              <th className="px-3 py-3">Critical</th>
              <th className="px-3 py-3">Last Installed</th>
              <th className="px-3 py-3">Last Scanned</th>
              <th className="px-3 py-3">Reboot</th>
              <th className="px-3 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filteredDevices.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  {hasActiveFilters ? 'No devices match your filters.' : 'No devices found.'}
                </td>
              </tr>
            ) : (
              filteredDevices.map(device => {
                const isSelected = selectedIds.has(device.id);
                const isCompliant = device.pendingPatches === 0;

                return (
                  <tr key={device.id} className={cn('text-sm hover:bg-muted/30', isSelected && 'bg-primary/5')}>
                    <td className="w-10 px-3 py-3">
                      <button
                        type="button"
                        onClick={() => toggleSelect(device.id)}
                        className="flex items-center justify-center text-muted-foreground hover:text-foreground"
                      >
                        {isSelected ? <CheckSquare className="h-4 w-4 text-primary" /> : <Square className="h-4 w-4" />}
                      </button>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-2">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                          <Monitor className="h-4 w-4 text-muted-foreground" />
                        </div>
                        <div className="min-w-0">
                          <a
                            href={`/devices/${device.id}`}
                            className="flex items-center gap-1 font-medium hover:underline"
                            title={device.hostname}
                          >
                            <span className="truncate">{device.hostname}</span>
                            <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
                          </a>
                          <div className="text-xs text-muted-foreground">
                            {device.osType}
                            {device.lastSeenAt && <> &middot; {formatRelativeTime(device.lastSeenAt)}</>}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      {isCompliant ? (
                        <span className="inline-flex items-center rounded-full border border-green-500/40 bg-green-500/20 px-2 py-0.5 text-xs font-medium text-green-700">
                          Compliant
                        </span>
                      ) : device.criticalMissing > 0 ? (
                        <span className="inline-flex items-center rounded-full border border-red-500/40 bg-red-500/20 px-2 py-0.5 text-xs font-medium text-red-700">
                          {device.pendingPatches} missing
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full border border-orange-500/40 bg-orange-500/20 px-2 py-0.5 text-xs font-medium text-orange-700">
                          {device.pendingPatches} missing
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      {device.osMissing > 0 ? (
                        <span className="font-medium">{device.osMissing}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      {device.thirdPartyMissing > 0 ? (
                        <span className="inline-flex items-center rounded-full border border-violet-500/40 bg-violet-500/20 px-2 py-0.5 text-xs font-medium text-violet-700">
                          {device.thirdPartyMissing}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      {device.criticalMissing > 0 ? (
                        <span className="inline-flex items-center rounded-full border border-red-500/40 bg-red-500/20 px-2 py-0.5 text-xs font-medium text-red-700">
                          {device.criticalMissing}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-xs text-muted-foreground">
                      {device.lastInstalledAt ? formatRelativeTime(device.lastInstalledAt) : '—'}
                    </td>
                    <td className="px-3 py-3 text-xs text-muted-foreground">
                      {device.lastScannedAt ? formatRelativeTime(device.lastScannedAt) : '—'}
                    </td>
                    <td className="px-3 py-3">
                      {device.pendingReboot ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-orange-500/40 bg-orange-500/20 px-2 py-0.5 text-xs font-medium text-orange-700">
                          <RotateCcw className="h-3 w-3" />
                          Pending
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <a
                          href={`/devices/${device.id}#patches`}
                          className="inline-flex h-8 items-center gap-1 rounded-md border px-3 text-xs font-medium hover:bg-muted"
                          title="View device patches"
                        >
                          <Download className="h-3.5 w-3.5" />
                          Patches
                        </a>
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
