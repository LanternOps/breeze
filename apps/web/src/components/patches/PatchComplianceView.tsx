import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  AlertTriangle,
  CheckSquare,
  ExternalLink,
  FileText,
  Loader2,
  Minus,
  Monitor,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Shield,
  Square
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { formatRelativeTime, lastActivity, toNumber, type DevicePatchRow } from './patchHelpers';
import { usePatchSelection } from './usePatchSelection';
import { useBulkActions } from './useBulkActions';

type ComplianceSummary = {
  totalDevices: number;
  compliantDevices: number;
  criticalPatches: number;
  pendingPatches: number;
  rebootPending: number;
};

type PatchComplianceViewProps = {
  ringId?: string | null;
};

export default function PatchComplianceView({ ringId }: PatchComplianceViewProps) {
  const [devices, setDevices] = useState<DevicePatchRow[]>([]);
  const [summary, setSummary] = useState<ComplianceSummary>({ totalDevices: 0, compliantDevices: 0, criticalPatches: 0, pendingPatches: 0, rebootPending: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [exporting, setExporting] = useState(false);
  const [confirmInstall, setConfirmInstall] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const params = new URLSearchParams();
      if (ringId) params.set('ringId', ringId);
      const complianceUrl = params.toString() ? `/patches/compliance?${params}` : '/patches/compliance';

      const [complianceRes, devicesRes] = await Promise.all([
        fetchWithAuth(complianceUrl),
        fetchWithAuth('/devices?limit=200')
      ]);
      if (!complianceRes.ok || !devicesRes.ok) {
        if (complianceRes.status === 401 || devicesRes.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        throw new Error('Failed to fetch patch data');
      }

      const complianceData = (await complianceRes.json()).data ?? {};
      const needingList = complianceData.devicesNeedingPatches ?? [];
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
            pendingPatches: toNumber(n?.missingCount ?? 0),
            criticalMissing: toNumber(n?.criticalCount ?? 0),
            importantMissing: toNumber(n?.importantCount ?? 0),
            osMissing: toNumber(n?.osMissing ?? 0),
            thirdPartyMissing: toNumber(n?.thirdPartyMissing ?? 0),
            lastInstalledAt: n?.lastInstalledAt ? String(n.lastInstalledAt) : undefined,
            lastScannedAt: n?.lastScannedAt ? String(n.lastScannedAt) : undefined,
            pendingReboot: Boolean(n?.pendingReboot),
          });
        }
      }

      merged.sort((a, b) => b.criticalMissing - a.criticalMissing || b.pendingPatches - a.pendingPatches);
      setDevices(merged);

      const nonCompliant = merged.filter(d => d.pendingPatches > 0);
      setSummary({
        totalDevices: merged.length,
        compliantDevices: merged.length - nonCompliant.length,
        criticalPatches: nonCompliant.reduce((sum, d) => sum + d.criticalMissing, 0),
        pendingPatches: nonCompliant.reduce((sum, d) => sum + d.pendingPatches, 0),
        rebootPending: merged.filter(d => d.pendingReboot).length,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch patch data');
    } finally {
      setLoading(false);
    }
  }, [ringId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleExport = useCallback(async () => {
    try {
      setExporting(true);
      const params = new URLSearchParams();
      if (ringId) params.set('ringId', ringId);
      params.set('format', 'csv');
      const response = await fetchWithAuth(`/patches/compliance/report?${params}`);
      if (!response.ok) throw new Error('Failed to generate report');
      const result = await response.json();
      const reportId = result.data?.id;
      if (reportId) void navigateTo(`/patches/compliance/report/${reportId}`);
    } catch {
      setBulkError('Failed to generate report');
    } finally {
      setExporting(false);
    }
  }, [ringId]);

  // Filters
  const filteredDevices = useMemo(() => {
    let list = devices;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(d => d.hostname.toLowerCase().includes(q));
    }
    if (statusFilter === 'needs-patches') list = list.filter(d => d.pendingPatches > 0);
    else if (statusFilter === 'critical') list = list.filter(d => d.criticalMissing > 0);
    else if (statusFilter === 'reboot') list = list.filter(d => d.pendingReboot);
    else if (statusFilter === '3rd-party') list = list.filter(d => d.thirdPartyMissing > 0);
    else if (statusFilter === 'compliant') list = list.filter(d => d.pendingPatches === 0);
    return list;
  }, [devices, searchQuery, statusFilter]);

  const hasActiveFilters = searchQuery !== '' || statusFilter !== 'all';

  const filteredIds = useMemo(() => filteredDevices.map(d => d.id), [filteredDevices]);
  const { selectedIds, allPageSelected: allSelected, somePageSelected: someSelected, toggleSelect, toggleSelectAll, clearSelection } = usePatchSelection(filteredIds);
  const { bulkAction, bulkError, setBulkError, bulkSuccess, setBulkSuccess, handleBulkScan, handleBulkInstall } = useBulkActions(selectedIds, clearSelection, fetchData);

  const selectedWithPatches = useMemo(() => {
    return Array.from(selectedIds).filter(id => {
      const d = devices.find(dev => dev.id === id);
      return d && d.pendingPatches > 0;
    }).length;
  }, [selectedIds, devices]);

  // Precomputed filter counts
  const filterCounts = useMemo(() => ({
    critical: devices.filter(d => d.criticalMissing > 0).length,
    thirdParty: devices.filter(d => d.thirdPartyMissing > 0).length,
  }), [devices]);

  // Auto-dismiss success banners
  useEffect(() => {
    if (!bulkSuccess) return;
    const timer = setTimeout(() => setBulkSuccess(undefined), 5000);
    return () => clearTimeout(timer);
  }, [bulkSuccess, setBulkSuccess]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error && devices.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button type="button" onClick={fetchData} className="mt-3 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
          Try again
        </button>
      </div>
    );
  }

  const compliancePercent = summary.totalDevices > 0
    ? Math.round((summary.compliantDevices / summary.totalDevices) * 100)
    : 100;
  const nonCompliantCount = summary.totalDevices - summary.compliantDevices;

  return (
    <div className="space-y-4">
      {/* Compact compliance summary */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
          <span className="flex items-center gap-1.5 font-semibold">
            <Shield className="h-4 w-4 text-muted-foreground" />
            {compliancePercent}% compliant
          </span>
          <span className="text-muted-foreground">
            {summary.compliantDevices} of {summary.totalDevices} devices
          </span>
          {nonCompliantCount > 0 && (
            <span className="flex items-center gap-1 text-orange-600">
              <AlertTriangle className="h-3.5 w-3.5" />
              {nonCompliantCount} need patches
            </span>
          )}
          {summary.criticalPatches > 0 && (
            <span className="text-red-600 font-medium">{summary.criticalPatches} critical</span>
          )}
          {summary.rebootPending > 0 && (
            <span className="flex items-center gap-1 text-orange-600">
              <RotateCcw className="h-3.5 w-3.5" />
              {summary.rebootPending} reboot
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-background px-3 text-xs font-medium hover:bg-muted disabled:opacity-50"
          >
            {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
            Export
          </button>
          <button
            type="button"
            onClick={fetchData}
            disabled={loading}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-background px-3 text-xs font-medium hover:bg-muted disabled:opacity-50"
            aria-label="Refresh compliance data"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
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
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="all">All Devices ({devices.length})</option>
          <option value="needs-patches">Needs Patches ({nonCompliantCount})</option>
          <option value="critical">Critical ({filterCounts.critical})</option>
          <option value="reboot">Pending Reboot ({summary.rebootPending})</option>
          <option value="3rd-party">3rd-Party Missing ({filterCounts.thirdParty})</option>
          <option value="compliant">Compliant ({summary.compliantDevices})</option>
        </select>
        {hasActiveFilters && (
          <button
            type="button"
            onClick={() => { setSearchQuery(''); setStatusFilter('all'); }}
            className="h-9 rounded-md px-3 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
        )}
        {filteredDevices.length !== devices.length && (
          <span className="text-xs text-muted-foreground">
            Showing {filteredDevices.length} of {devices.length}
          </span>
        )}
      </div>

      {/* Bulk action toolbar */}
      {selectedIds.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/50 px-4 py-2.5">
          <span className="text-sm font-medium">
            {selectedIds.size} selected
          </span>
          <div className="h-4 w-px bg-border" />
          <button
            type="button"
            onClick={handleBulkScan}
            disabled={bulkAction !== null}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-background px-3 text-xs font-medium hover:bg-muted disabled:opacity-50"
          >
            {bulkAction === 'scan' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Scan
          </button>
          {selectedWithPatches > 0 && !confirmInstall && (
            <button
              type="button"
              onClick={() => setConfirmInstall(true)}
              disabled={bulkAction !== null}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              <Play className="h-3.5 w-3.5" />
              Install ({selectedWithPatches})
            </button>
          )}
          {confirmInstall && (
            <div className="flex items-center gap-2 rounded-md border border-orange-500/40 bg-orange-500/10 px-3 py-1">
              <span className="text-xs text-orange-700">Install patches on {selectedWithPatches} devices?</span>
              <button
                type="button"
                onClick={handleBulkInstall}
                disabled={bulkAction !== null}
                className="inline-flex h-6 items-center rounded bg-primary px-2 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {bulkAction === 'install' ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Confirm'}
              </button>
              <button
                type="button"
                onClick={() => setConfirmInstall(false)}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={clearSelection}
            className="ml-auto h-8 rounded-md px-3 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
        </div>
      )}

      {/* Status banners */}
      {bulkError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {bulkError}
        </div>
      )}
      {bulkSuccess && (
        <div className="rounded-md border border-green-500/40 bg-green-500/10 px-4 py-2 text-sm text-green-700">
          {bulkSuccess}
        </div>
      )}

      {/* Device table */}
      <div className="overflow-x-auto rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="w-10 px-3 py-3">
                <button
                  type="button"
                  onClick={toggleSelectAll}
                  className="flex items-center justify-center text-muted-foreground hover:text-foreground"
                  aria-label={allSelected ? 'Deselect all' : 'Select all'}
                >
                  {allSelected ? <CheckSquare className="h-4 w-4" /> : someSelected ? <Minus className="h-4 w-4" /> : <Square className="h-4 w-4" />}
                </button>
              </th>
              <th className="px-3 py-3">Device</th>
              <th className="px-3 py-3">Status</th>
              <th className="px-3 py-3" title="Missing updates from Windows Update, Apple, or Linux package managers">OS Patches</th>
              <th className="px-3 py-3" title="Missing updates from third-party or custom sources">3rd-Party</th>
              <th className="px-3 py-3" title="Missing patches rated critical severity">Critical</th>
              <th className="px-3 py-3" title="Most recent patch install or scan activity">Last Activity</th>
              <th className="px-3 py-3" title="Device needs a reboot to complete patch installation">Reboot</th>
              <th className="px-3 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filteredDevices.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  {hasActiveFilters ? 'No devices match your filters.' : 'No devices found.'}
                </td>
              </tr>
            ) : (
              filteredDevices.map(device => {
                const isSelected = selectedIds.has(device.id);
                const isCompliant = device.pendingPatches === 0;

                return (
                  <tr key={device.id} className={cn('text-sm hover:bg-muted/30', isSelected && 'bg-primary/5')}>
                    <td className="w-10 px-3 py-2.5">
                      <button
                        type="button"
                        onClick={() => toggleSelect(device.id)}
                        className="flex items-center justify-center text-muted-foreground hover:text-foreground"
                        aria-label={isSelected ? `Deselect ${device.hostname}` : `Select ${device.hostname}`}
                      >
                        {isSelected ? <CheckSquare className="h-4 w-4 text-primary" /> : <Square className="h-4 w-4" />}
                      </button>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-muted">
                          <Monitor className="h-3.5 w-3.5 text-muted-foreground" />
                        </div>
                        <div className="min-w-0">
                          <a
                            href={`/devices/${device.id}`}
                            className="flex items-center gap-1 text-sm font-medium hover:underline"
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
                    <td className="px-3 py-2.5">
                      {isCompliant ? (
                        <span className="inline-flex items-center rounded-full border border-green-500/40 bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-700">
                          OK
                        </span>
                      ) : device.criticalMissing > 0 ? (
                        <span className="inline-flex items-center rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-700">
                          {device.pendingPatches} missing
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full border border-orange-500/40 bg-orange-500/10 px-2 py-0.5 text-xs font-medium text-orange-700">
                          {device.pendingPatches} missing
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 tabular-nums">
                      {device.osMissing > 0 ? device.osMissing : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-3 py-2.5 tabular-nums">
                      {device.thirdPartyMissing > 0 ? (
                        <span className="inline-flex items-center rounded-full border border-violet-500/40 bg-violet-500/10 px-2 py-0.5 text-xs font-medium text-violet-700">
                          {device.thirdPartyMissing}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      {device.criticalMissing > 0 ? (
                        <span className="inline-flex items-center rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-700">
                          {device.criticalMissing}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground" title={lastActivity(device.lastInstalledAt, device.lastScannedAt).tooltip}>
                      {lastActivity(device.lastInstalledAt, device.lastScannedAt).label}
                    </td>
                    <td className="px-3 py-2.5">
                      {device.pendingReboot ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-orange-500/40 bg-orange-500/10 px-2 py-0.5 text-xs font-medium text-orange-700">
                          <RotateCcw className="h-3 w-3" />
                          Yes
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <a
                        href={`/devices/${device.id}#patches`}
                        className="inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-xs font-medium hover:bg-muted"
                      >
                        View
                      </a>
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
