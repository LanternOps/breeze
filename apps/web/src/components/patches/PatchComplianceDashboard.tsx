import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  AlertTriangle,
  CheckCircle,
  CheckSquare,
  Download,
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
import { cn, widthPercentClass } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';

export type PatchSeveritySummary = {
  total: number;
  patched: number;
  pending: number;
};

export type DevicePatchNeed = {
  id: string;
  name: string;
  os: string;
  missingCount: number;
  criticalCount: number;
  importantCount: number;
  osMissing: number;
  thirdPartyMissing: number;
  lastInstalledAt?: string;
  lastScannedAt?: string;
  pendingReboot: boolean;
  lastSeen?: string;
};

type PatchComplianceData = {
  totalDevices: number;
  compliantDevices: number;
  criticalSummary: PatchSeveritySummary;
  importantSummary: PatchSeveritySummary;
  devicesNeedingPatches: DevicePatchNeed[];
};

function formatPercent(value: number, total: number) {
  if (total === 0) return '0%';
  return `${Math.round((value / total) * 100)}%`;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeSummary(raw?: Record<string, unknown>): PatchSeveritySummary {
  if (!raw) {
    return { total: 0, patched: 0, pending: 0 };
  }

  return {
    total: toNumber(raw.total ?? raw.totalCount ?? raw.count),
    patched: toNumber(raw.patched ?? raw.approved ?? raw.installed),
    pending: toNumber(raw.pending ?? raw.awaiting)
  };
}

function normalizeDeviceNeed(raw: Record<string, unknown>, index: number): DevicePatchNeed {
  const id = raw.id ?? raw.deviceId ?? raw.device_id ?? `device-${index}`;
  const name = raw.name ?? raw.hostname ?? raw.deviceName ?? 'Unknown device';
  const os = raw.os ?? raw.osName ?? raw.osType ?? raw.platform ?? 'Unknown OS';

  return {
    id: String(id),
    name: String(name),
    os: String(os),
    missingCount: toNumber(raw.missingCount ?? raw.missing ?? raw.patchesMissing),
    criticalCount: toNumber(raw.criticalCount ?? raw.critical ?? raw.criticalMissing),
    importantCount: toNumber(raw.importantCount ?? raw.important ?? raw.importantMissing),
    osMissing: toNumber(raw.osMissing ?? raw.os_missing ?? 0),
    thirdPartyMissing: toNumber(raw.thirdPartyMissing ?? raw.third_party_missing ?? 0),
    lastInstalledAt: raw.lastInstalledAt ? String(raw.lastInstalledAt) : raw.last_installed_at ? String(raw.last_installed_at) : undefined,
    lastScannedAt: raw.lastScannedAt ? String(raw.lastScannedAt) : raw.last_scanned_at ? String(raw.last_scanned_at) : undefined,
    pendingReboot: Boolean(raw.pendingReboot ?? raw.pending_reboot ?? false),
    lastSeen: raw.lastSeen ? String(raw.lastSeen) : raw.last_seen ? String(raw.last_seen) : undefined
  };
}

function normalizeCompliance(raw: Record<string, unknown>): PatchComplianceData {
  const summary = raw.summary && typeof raw.summary === 'object' ? (raw.summary as Record<string, unknown>) : undefined;
  const severitySummary = raw.severitySummary && typeof raw.severitySummary === 'object'
    ? (raw.severitySummary as Record<string, unknown>)
    : undefined;
  const severity = raw.severity && typeof raw.severity === 'object'
    ? (raw.severity as Record<string, unknown>)
    : undefined;
  const totalDevices = toNumber(raw.totalDevices ?? raw.total_devices ?? raw.total ?? summary?.total);
  const compliantDevices = toNumber(raw.compliantDevices ?? raw.compliant_devices ?? raw.compliant ?? summary?.approved);
  const criticalSummary = normalizeSummary(
    (raw.criticalSummary ?? raw.critical_summary ?? severitySummary?.critical ?? severity?.critical) as
      | Record<string, unknown>
      | undefined
  );
  const importantSummary = normalizeSummary(
    (raw.importantSummary ?? raw.important_summary ?? severitySummary?.important ?? severity?.important) as
      | Record<string, unknown>
      | undefined
  );

  const deviceList = raw.devicesNeedingPatches ?? raw.devices_needing_patches ?? raw.devices ?? [];
  const devicesNeedingPatches = Array.isArray(deviceList)
    ? deviceList.map((device: Record<string, unknown>, index: number) => normalizeDeviceNeed(device, index))
    : [];

  return {
    totalDevices,
    compliantDevices,
    criticalSummary,
    importantSummary,
    devicesNeedingPatches
  };
}

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function SeveritySummaryCard({
  title,
  summary,
  colorClass,
  barClass
}: {
  title: string;
  summary: PatchSeveritySummary;
  colorClass: string;
  barClass: string;
}) {
  const progress = summary.total > 0 ? Math.round((summary.patched / summary.total) * 100) : 0;

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground">{title}</p>
          <p className="mt-1 text-2xl font-bold">{summary.total}</p>
        </div>
        <div className={cn('rounded-full border px-3 py-1 text-xs font-medium', colorClass)}>
          {summary.pending} pending
        </div>
      </div>
      <div className="mt-3">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{summary.patched} patched</span>
          <span>{progress}%</span>
        </div>
        <div className="mt-2 h-2 rounded-full bg-muted">
          <div className={cn('h-2 rounded-full', barClass, widthPercentClass(progress))} />
        </div>
      </div>
    </div>
  );
}

type PatchComplianceDashboardProps = {
  ringId?: string | null;
};

export default function PatchComplianceDashboard({ ringId }: PatchComplianceDashboardProps = {}) {
  const [data, setData] = useState<PatchComplianceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [searchQuery, setSearchQuery] = useState('');
  const [osFilter, setOsFilter] = useState('all');
  const [exporting, setExporting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<string | null>(null);
  const [bulkError, setBulkError] = useState<string>();

  const fetchCompliance = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const params = new URLSearchParams();
      if (ringId) params.set('ringId', ringId);
      const url = params.toString() ? `/patches/compliance?${params}` : '/patches/compliance';
      const response = await fetchWithAuth(url);
      if (!response.ok) {
        if (response.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        throw new Error('Failed to fetch compliance data');
      }
      const payload = await response.json();
      const normalized = normalizeCompliance((payload.data ?? payload) as Record<string, unknown>);
      setData(normalized);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch compliance data');
    } finally {
      setLoading(false);
    }
  }, [ringId]);

  useEffect(() => {
    fetchCompliance();
  }, [fetchCompliance]);

  const handleExportCsv = useCallback(async () => {
    try {
      setExporting(true);
      const params = new URLSearchParams();
      if (ringId) params.set('ringId', ringId);
      params.set('format', 'csv');
      const response = await fetchWithAuth(`/patches/compliance/report?${params}`);
      if (!response.ok) throw new Error('Failed to generate report');
      const result = await response.json();
      const reportId = result.data?.id;
      if (reportId) {
        void navigateTo(`/patches/compliance/report/${reportId}`);
      }
    } catch {
      // Silently fail — user can retry
    } finally {
      setExporting(false);
    }
  }, [ringId]);

  const complianceData: PatchComplianceData = data ?? {
    totalDevices: 0,
    compliantDevices: 0,
    criticalSummary: { total: 0, patched: 0, pending: 0 },
    importantSummary: { total: 0, patched: 0, pending: 0 },
    devicesNeedingPatches: []
  };

  const osOptions = useMemo(() => {
    const osSet = new Set(complianceData.devicesNeedingPatches.map(d => d.os));
    return Array.from(osSet).sort();
  }, [complianceData.devicesNeedingPatches]);

  const filteredDevices = useMemo(() => {
    let list = complianceData.devicesNeedingPatches;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(d => d.name.toLowerCase().includes(q));
    }
    if (osFilter !== 'all') {
      list = list.filter(d => d.os === osFilter);
    }
    return list;
  }, [complianceData.devicesNeedingPatches, searchQuery, osFilter]);

  const hasActiveFilters = searchQuery !== '' || osFilter !== 'all';

  // Selection helpers
  const pageIds = useMemo(() => new Set(filteredDevices.map(d => d.id)), [filteredDevices]);
  const allPageSelected = filteredDevices.length > 0 && filteredDevices.every(d => selectedIds.has(d.id));
  const somePageSelected = filteredDevices.some(d => selectedIds.has(d.id));

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (allPageSelected) {
        for (const id of pageIds) next.delete(id);
      } else {
        for (const id of pageIds) next.add(id);
      }
      return next;
    });
  }, [allPageSelected, pageIds]);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  // Bulk actions
  const handleBulkScan = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkAction('scan');
    setBulkError(undefined);
    try {
      const response = await fetchWithAuth('/patches/scan', {
        method: 'POST',
        body: JSON.stringify({ deviceIds: ids })
      });
      if (!response.ok) {
        if (response.status === 401) { void navigateTo('/login', { replace: true }); return; }
        throw new Error('Failed to start patch scan');
      }
      clearSelection();
      // Refresh compliance data after a brief delay for scan to start
      setTimeout(() => { void fetchCompliance(); }, 2000);
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : 'Failed to start scan');
    } finally {
      setBulkAction(null);
    }
  }, [selectedIds, clearSelection, fetchCompliance]);

  const handleBulkInstall = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkAction('install');
    setBulkError(undefined);
    const failed: string[] = [];
    try {
      for (const deviceId of ids) {
        const response = await fetchWithAuth(`/devices/${deviceId}/patches/install`, {
          method: 'POST',
          body: JSON.stringify({})
        });
        if (!response.ok) {
          if (response.status === 401) { void navigateTo('/login', { replace: true }); return; }
          failed.push(deviceId);
        }
      }
      if (failed.length > 0) {
        setBulkError(`Failed to install patches on ${failed.length} of ${ids.length} devices`);
      }
      clearSelection();
      setTimeout(() => { void fetchCompliance(); }, 3000);
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : 'Failed to install patches');
    } finally {
      setBulkAction(null);
    }
  }, [selectedIds, clearSelection, fetchCompliance]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
          <p className="mt-4 text-sm text-muted-foreground">Loading compliance data...</p>
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchCompliance}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

  const compliancePercent = complianceData.totalDevices > 0
    ? Math.round((complianceData.compliantDevices / complianceData.totalDevices) * 100)
    : 0;
  const needsPatches = complianceData.totalDevices - complianceData.compliantDevices;

  return (
    <div className="space-y-6">
      {/* Header actions */}
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={handleExportCsv}
          disabled={exporting}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border bg-background px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
          Export Report
        </button>
        <button
          type="button"
          onClick={fetchCompliance}
          disabled={loading}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border bg-background px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          Refresh
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Shield className="h-4 w-4" />
            Compliance
          </div>
          <p className="mt-3 text-3xl font-bold">{compliancePercent}%</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {complianceData.compliantDevices} of {complianceData.totalDevices} devices compliant
          </p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle className="h-4 w-4" />
            Patched Devices
          </div>
          <p className="mt-3 text-3xl font-bold">{complianceData.compliantDevices}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatPercent(complianceData.compliantDevices, complianceData.totalDevices)} of fleet
          </p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <AlertTriangle className="h-4 w-4" />
            Needs Patches
          </div>
          <p className="mt-3 text-3xl font-bold">{needsPatches}</p>
          <p className="mt-1 text-sm text-muted-foreground">{formatPercent(needsPatches, complianceData.totalDevices)} of fleet</p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SeveritySummaryCard
          title="Critical Patches"
          summary={complianceData.criticalSummary}
          colorClass="bg-red-500/20 text-red-700 border-red-500/40"
          barClass="bg-red-500"
        />
        <SeveritySummaryCard
          title="Important Patches"
          summary={complianceData.importantSummary}
          colorClass="bg-orange-500/20 text-orange-700 border-orange-500/40"
          barClass="bg-orange-500"
        />
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Devices needing patches</h2>
            <p className="text-sm text-muted-foreground">
              {filteredDevices.length === complianceData.devicesNeedingPatches.length
                ? `${complianceData.devicesNeedingPatches.length} devices require updates`
                : `Showing ${filteredDevices.length} of ${complianceData.devicesNeedingPatches.length} devices`}
            </p>
          </div>
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
          {hasActiveFilters && (
            <button
              type="button"
              onClick={() => { setSearchQuery(''); setOsFilter('all'); }}
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
            <button
              type="button"
              onClick={handleBulkInstall}
              disabled={bulkAction !== null}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {bulkAction === 'install' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              Install Missing Patches
            </button>
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

        <div className="mt-4 overflow-hidden rounded-md border">
          <table className="min-w-full divide-y">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="w-10 px-4 py-3">
                  <button
                    type="button"
                    onClick={toggleSelectAll}
                    className="flex items-center justify-center text-muted-foreground hover:text-foreground"
                    title={allPageSelected ? 'Deselect all' : 'Select all'}
                  >
                    {allPageSelected ? (
                      <CheckSquare className="h-4 w-4" />
                    ) : somePageSelected ? (
                      <Minus className="h-4 w-4" />
                    ) : (
                      <Square className="h-4 w-4" />
                    )}
                  </button>
                </th>
                <th className="px-3 py-3">Device</th>
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
                  <td colSpan={9} className="px-4 py-6 text-center text-sm text-muted-foreground">
                    {hasActiveFilters ? 'No devices match your filters.' : 'All devices are compliant.'}
                  </td>
                </tr>
              ) : (
                filteredDevices.map(device => {
                  const isSelected = selectedIds.has(device.id);
                  return (
                    <tr key={device.id} className={cn('text-sm hover:bg-muted/30', isSelected && 'bg-primary/5')}>
                      <td className="w-10 px-3 py-3">
                        <button
                          type="button"
                          onClick={() => toggleSelect(device.id)}
                          className="flex items-center justify-center text-muted-foreground hover:text-foreground"
                        >
                          {isSelected ? (
                            <CheckSquare className="h-4 w-4 text-primary" />
                          ) : (
                            <Square className="h-4 w-4" />
                          )}
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
                              title={`View ${device.name}`}
                            >
                              <span className="truncate">{device.name}</span>
                              <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
                            </a>
                            <div className="text-xs text-muted-foreground">
                              {device.os}
                              {device.lastSeen && <> &middot; {formatRelativeTime(device.lastSeen)}</>}
                            </div>
                          </div>
                        </div>
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
                        {device.criticalCount > 0 ? (
                          <span className="inline-flex items-center rounded-full border border-red-500/40 bg-red-500/20 px-2 py-0.5 text-xs font-medium text-red-700">
                            {device.criticalCount}
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
    </div>
  );
}
