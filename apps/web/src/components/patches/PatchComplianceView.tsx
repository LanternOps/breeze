import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { toNumber, type DevicePatchRow } from './patchHelpers';
import { usePatchSelection } from './usePatchSelection';
import { useBulkActions, type ResolvedInstallPatchIds } from './useBulkActions';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { useOrgStore } from '../../stores/orgStore';
import { runAction, ActionError } from '@/lib/runAction';
import { showToast } from '../shared/Toast';

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

function formatPatchRelativeTime(isoString: string, t: TFunction<'patches'>): string {
  const date = new Date(isoString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return t('patchComplianceView.relative.justNow');
  if (diffMins < 60) return t('patchComplianceView.relative.minutesAgo', { count: diffMins });
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return t('patchComplianceView.relative.hoursAgo', { count: diffHours });
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return t('patchComplianceView.relative.daysAgo', { count: diffDays });
  return date.toLocaleDateString();
}

function formatLastActivity(installed: string | undefined, scanned: string | undefined, t: TFunction<'patches'>): { label: string; tooltip: string } {
  const inst = installed ? new Date(installed).getTime() : 0;
  const scan = scanned ? new Date(scanned).getTime() : 0;
  if (!inst && !scan) {
    return {
      label: t('patchComplianceView.emptyValue'),
      tooltip: t('patchComplianceView.activity.noActivity'),
    };
  }
  if (inst >= scan) {
    const label = formatPatchRelativeTime(installed!, t);
    return {
      label: t('patchComplianceView.activity.installed', { time: label }),
      tooltip: scanned
        ? t('patchComplianceView.activity.lastScanned', { time: formatPatchRelativeTime(scanned, t) })
        : t('patchComplianceView.activity.noScan'),
    };
  }
  const label = formatPatchRelativeTime(scanned!, t);
  return {
    label: t('patchComplianceView.activity.scanned', { time: label }),
    tooltip: installed
      ? t('patchComplianceView.activity.lastInstalled', { time: formatPatchRelativeTime(installed, t) })
      : t('patchComplianceView.activity.noInstall'),
  };
}

export default function PatchComplianceView({ ringId }: PatchComplianceViewProps) {
  const { t } = useTranslation('patches');
  const { organizations, currentOrgId } = useOrgStore();
  // Compliance export resolves a single target org server-side
  // (resolvePatchReportOrgId), which 400s for a partner with >1 accessible org
  // and no orgId. With a specific org selected, fetchWithAuth auto-injects
  // ?orgId=; a selected ring also resolves the org. In All-orgs mode with no
  // ring, disable export with a hint instead of firing a request that 400s.
  const canExport = currentOrgId !== null || !!ringId;
  const [devices, setDevices] = useState<DevicePatchRow[]>([]);
  const [summary, setSummary] = useState<ComplianceSummary>({ totalDevices: 0, compliantDevices: 0, criticalPatches: 0, pendingPatches: 0, rebootPending: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [exporting, setExporting] = useState(false);
  const reportPollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
        throw new Error(t('patchComplianceView.errors.fetchData'));
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
          const pendingPatches = toNumber(n?.missingCount ?? 0);
          const approvedMissing = toNumber(n?.approvedMissing ?? 0);
          // Capture orgId from the /devices response so we can derive the true
          // action scope when the user triggers a bulk scan/install confirmation.
          const orgId = raw.orgId ? String(raw.orgId) : (raw.org_id ? String(raw.org_id) : undefined);
          merged.push({
            id,
            hostname: String(n?.name ?? n?.hostname ?? raw.hostname ?? t('patchComplianceView.unknownDevice')),
            osType: String(n?.os ?? n?.osType ?? raw.osType ?? raw.os_type ?? 'unknown'),
            lastSeenAt: (n?.lastSeen ?? raw.lastSeenAt) ? String(n?.lastSeen ?? raw.lastSeenAt) : undefined,
            pendingPatches,
            approvedMissing,
            // The compliance API always returns both approved/unapproved counts.
            // Read it directly rather than synthesizing from (pending - approved),
            // which produced a misleading count when the field was absent.
            unapprovedMissing: toNumber(n?.unapprovedMissing ?? 0),
            criticalMissing: toNumber(n?.criticalCount ?? 0),
            importantMissing: toNumber(n?.importantCount ?? 0),
            osMissing: toNumber(n?.osMissing ?? 0),
            thirdPartyMissing: toNumber(n?.thirdPartyMissing ?? 0),
            lastInstalledAt: n?.lastInstalledAt ? String(n.lastInstalledAt) : undefined,
            lastScannedAt: n?.lastScannedAt ? String(n.lastScannedAt) : undefined,
            pendingReboot: Boolean(n?.pendingReboot),
            status: raw.status ? String(raw.status) : undefined,
            orgId,
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
      setError(err instanceof Error ? err.message : t('patchComplianceView.errors.fetchData'));
    } finally {
      setLoading(false);
    }
  }, [ringId, t]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    return () => {
      if (reportPollTimerRef.current) {
        clearInterval(reportPollTimerRef.current);
        reportPollTimerRef.current = null;
      }
    };
  }, []);

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

  const resolveInstallPatchIds = useCallback(async (deviceId: string): Promise<ResolvedInstallPatchIds> => {
    const response = await fetchWithAuth(`/devices/${deviceId}/patches`);
    if (!response.ok) {
      if (response.status === 401) {
        void navigateTo('/login', { replace: true });
        return { patchIds: [] };
      }
      throw new Error(t('patchComplianceView.errors.loadPendingPatches', { deviceId }));
    }

    const payload = await response.json().catch(() => ({}));
    const data = payload?.data ?? payload;
    const pending = data?.pending ?? data?.pendingPatches ?? data?.available ?? [];
    if (!Array.isArray(pending)) {
      return { patchIds: [] };
    }

    const patchIds: string[] = [];
    let skippedPendingApproval = 0;
    for (const patch of pending) {
      if (!patch || typeof patch !== 'object') continue;
      const row = patch as { id?: unknown; approvalStatus?: unknown };
      if (!row.id) continue;
      if (row.approvalStatus === 'approved') {
        patchIds.push(String(row.id));
      } else {
        // Awaiting approval — drop it, but track so the caller can report it
        // rather than silently swallowing the patch.
        skippedPendingApproval += 1;
      }
    }

    return { patchIds, skippedPendingApproval };
  }, [t]);

  const filteredIds = useMemo(() => filteredDevices.map(d => d.id), [filteredDevices]);
  const { selectedIds, allPageSelected: allSelected, somePageSelected: someSelected, toggleSelect, toggleSelectAll, clearSelection } = usePatchSelection(filteredIds);

  // Derive org names from the selected devices' actual orgId fields (populated
  // from the /devices API response), NOT from currentOrgId which reflects only
  // the shell selection and is stale on the global /patches route.
  const orgNamesForSelection = useMemo((): string[] => {
    const seenOrgIds = new Set<string>();
    for (const id of selectedIds) {
      const d = devices.find(dev => dev.id === id);
      if (d?.orgId) seenOrgIds.add(d.orgId);
    }
    if (seenOrgIds.size === 0) {
      // Fall back: derive from all loaded devices if no orgId info on selected rows.
      for (const d of devices) {
        if (d.orgId) seenOrgIds.add(d.orgId);
      }
    }
    const names: string[] = [];
    for (const oid of seenOrgIds) {
      const org = organizations.find(o => o.id === oid);
      names.push(org ? org.name : oid);
    }
    return names.length > 0 ? names : [t('patchComplianceView.confirm.selectedOrganization')];
  }, [selectedIds, devices, organizations, t]);

  const { bulkAction, bulkError, setBulkError, bulkSuccess, setBulkSuccess, pendingConfirm, requestBulkScan, requestBulkInstall, confirmPendingAction, cancelPendingAction } = useBulkActions(
    selectedIds,
    clearSelection,
    fetchData,
    { resolveInstallPatchIds }
  );

  const handleExport = useCallback(async () => {
    if (!canExport) {
      showToast({ message: t('patchComplianceView.export.selectOrganization'), type: 'error' });
      return;
    }
    try {
      setExporting(true);
      setBulkError(undefined);
      setBulkSuccess(undefined);
      const params = new URLSearchParams();
      if (ringId) params.set('ringId', ringId);
      params.set('format', 'csv');
      // Surface the initial queue request via runAction (toast + HTTP-200
      // {success:false} handling) so a failed export is never a silent no-op.
      // The async report itself is then polled below.
      const result = await runAction<{ reportId?: string; id?: string; data?: { id?: string } }>({
        request: () => fetchWithAuth(`/patches/compliance/report?${params}`),
        errorFallback: t('patchComplianceView.export.generateFailed'),
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      const reportId = result.reportId ?? result.data?.id ?? result.id;
      if (reportId) {
        setBulkSuccess(t('patchComplianceView.export.queued', { reportId }));

        if (reportPollTimerRef.current) {
          clearInterval(reportPollTimerRef.current);
        }

        reportPollTimerRef.current = setInterval(async () => {
          try {
            const statusResponse = await fetchWithAuth(`/patches/compliance/report/${reportId}`);
            if (!statusResponse.ok) {
              throw new Error(t('patchComplianceView.export.checkFailed'));
            }
            const payload = await statusResponse.json();
            const report = payload?.data ?? payload;
            if (report?.status === 'completed') {
              if (reportPollTimerRef.current) {
                clearInterval(reportPollTimerRef.current);
                reportPollTimerRef.current = null;
              }
              setBulkSuccess(t('patchComplianceView.export.ready', { reportId }));
              window.location.assign(`/api/v1/patches/compliance/report/${reportId}/download`);
            } else if (report?.status === 'failed') {
              if (reportPollTimerRef.current) {
                clearInterval(reportPollTimerRef.current);
                reportPollTimerRef.current = null;
              }
              setBulkError(report?.errorMessage || t('patchComplianceView.export.failed', { reportId }));
              setBulkSuccess(undefined);
            }
          } catch (err) {
            if (reportPollTimerRef.current) {
              clearInterval(reportPollTimerRef.current);
              reportPollTimerRef.current = null;
            }
            setBulkError(err instanceof Error ? err.message : t('patchComplianceView.export.checkFailed'));
            setBulkSuccess(undefined);
          }
        }, 3000);
      } else {
        setBulkError(t('patchComplianceView.export.noReportId'));
      }
    } catch (err) {
      // 401 already redirected; ActionError was already toasted by runAction —
      // mirror it in the inline banner. Plain errors fall through to the banner.
      if (err instanceof ActionError && err.status === 401) return;
      setBulkError(err instanceof ActionError ? err.message : err instanceof Error ? err.message : t('patchComplianceView.export.generateFailed'));
    } finally {
      setExporting(false);
    }
  }, [ringId, canExport, setBulkError, setBulkSuccess, t]);

  const selectedPatchDeviceIds = useMemo(() => {
    return Array.from(selectedIds).filter(id => {
      const d = devices.find(dev => dev.id === id);
      return d && d.approvedMissing > 0;
    });
  }, [selectedIds, devices]);
  const selectedWithPatches = selectedPatchDeviceIds.length;
  const approvedPendingPatches = useMemo(
    () => devices.reduce((sum, d) => sum + d.approvedMissing, 0),
    [devices]
  );
  const unapprovedPendingPatches = useMemo(
    () => devices.reduce((sum, d) => sum + d.unapprovedMissing, 0),
    [devices]
  );

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
          {t('patchComplianceView.actions.tryAgain')}
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
            {t('patchComplianceView.summary.compliantPercent', { percent: compliancePercent })}
          </span>
          <span className="text-muted-foreground">
            {t('patchComplianceView.summary.devices', { compliant: summary.compliantDevices, total: summary.totalDevices })}
          </span>
          {nonCompliantCount > 0 && (
            <span className="flex items-center gap-1 text-orange-600">
              <AlertTriangle className="h-3.5 w-3.5" />
              {t('patchComplianceView.summary.pendingDevices', { count: nonCompliantCount })}
            </span>
          )}
          {approvedPendingPatches > 0 && (
            <span className="text-green-700 font-medium">{t('patchComplianceView.summary.approved', { count: approvedPendingPatches })}</span>
          )}
          {unapprovedPendingPatches > 0 && (
            <span className="text-orange-600 font-medium">{t('patchComplianceView.summary.pendingApproval', { count: unapprovedPendingPatches })}</span>
          )}
          {summary.criticalPatches > 0 && (
            <span className="text-red-600 font-medium">{t('patchComplianceView.summary.critical', { count: summary.criticalPatches })}</span>
          )}
          {summary.rebootPending > 0 && (
            <span className="flex items-center gap-1 text-orange-600">
              <RotateCcw className="h-3.5 w-3.5" />
              {t('patchComplianceView.summary.reboot', { count: summary.rebootPending })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting || !canExport}
            title={!canExport ? t('patchComplianceView.export.selectOrganization') : undefined}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-background px-3 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
            {t('patchComplianceView.actions.export')}
          </button>
          <button
            type="button"
            onClick={fetchData}
            disabled={loading}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-background px-3 text-xs font-medium hover:bg-muted disabled:opacity-50"
            aria-label={t('patchComplianceView.actions.refreshCompliance')}
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
            placeholder={t('patchComplianceView.searchPlaceholder')}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="h-9 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-56"
          />
        </div>
        <select
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        >
          <option value="all">{t('patchComplianceView.filters.allDevices', { count: devices.length })}</option>
          <option value="needs-patches">{t('patchComplianceView.filters.pendingPatches', { count: nonCompliantCount })}</option>
          <option value="critical">{t('patchComplianceView.filters.critical', { count: filterCounts.critical })}</option>
          <option value="reboot">{t('patchComplianceView.filters.pendingReboot', { count: summary.rebootPending })}</option>
          <option value="3rd-party">{t('patchComplianceView.filters.thirdPartyPending', { count: filterCounts.thirdParty })}</option>
          <option value="compliant">{t('patchComplianceView.filters.compliant', { count: summary.compliantDevices })}</option>
        </select>
        {hasActiveFilters && (
          <button
            type="button"
            onClick={() => { setSearchQuery(''); setStatusFilter('all'); }}
            className="h-9 rounded-md px-3 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            {t('patchComplianceView.actions.clear')}
          </button>
        )}
        {filteredDevices.length !== devices.length && (
          <span className="text-xs text-muted-foreground">
            {t('patchComplianceView.showing', { shown: filteredDevices.length, total: devices.length })}
          </span>
        )}
      </div>

      {/* Bulk action toolbar */}
      {selectedIds.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/50 px-4 py-2.5">
          <span className="text-sm font-medium">
            {t('patchComplianceView.selection.selected', { count: selectedIds.size })}
          </span>
          <div className="h-4 w-px bg-border" />
          <button
            type="button"
            onClick={() => requestBulkScan(orgNamesForSelection)}
            disabled={bulkAction !== null}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-background px-3 text-xs font-medium hover:bg-muted disabled:opacity-50"
          >
            {bulkAction === 'scan' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {t('patchComplianceView.actions.scan')}
          </button>
          {selectedWithPatches > 0 && (
            <button
              type="button"
              onClick={() => requestBulkInstall(orgNamesForSelection, selectedPatchDeviceIds)}
              disabled={bulkAction !== null}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              <Play className="h-3.5 w-3.5" />
              {t('patchComplianceView.actions.installCount', { count: selectedWithPatches })}
            </button>
          )}
          <button
            type="button"
            onClick={clearSelection}
            className="ml-auto h-8 rounded-md px-3 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            {t('patchComplianceView.actions.clear')}
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
                  aria-label={allSelected ? t('patchComplianceView.selection.deselectAll') : t('patchComplianceView.selection.selectAll')}
                >
                  {allSelected ? <CheckSquare className="h-4 w-4" /> : someSelected ? <Minus className="h-4 w-4" /> : <Square className="h-4 w-4" />}
                </button>
              </th>
              <th className="px-3 py-3">{t('patchComplianceView.table.device')}</th>
              <th className="px-3 py-3">{t('patchComplianceView.table.status')}</th>
              <th className="px-3 py-3" title={t('patchComplianceView.table.approvedTitle')}>{t('patchComplianceView.table.approved')}</th>
              <th className="px-3 py-3" title={t('patchComplianceView.table.pendingApprovalTitle')}>{t('patchComplianceView.table.pendingApproval')}</th>
              <th className="px-3 py-3" title={t('patchComplianceView.table.osPatchesTitle')}>{t('patchComplianceView.table.osPatches')}</th>
              <th className="px-3 py-3" title={t('patchComplianceView.table.thirdPartyTitle')}>{t('patchComplianceView.table.thirdParty')}</th>
              <th className="px-3 py-3" title={t('patchComplianceView.table.criticalTitle')}>{t('patchComplianceView.table.critical')}</th>
              <th className="px-3 py-3" title={t('patchComplianceView.table.lastActivityTitle')}>{t('patchComplianceView.table.lastActivity')}</th>
              <th className="px-3 py-3" title={t('patchComplianceView.table.rebootTitle')}>{t('patchComplianceView.table.reboot')}</th>
              <th className="px-3 py-3 text-right">{t('patchComplianceView.table.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filteredDevices.length === 0 ? (
              <tr>
                <td colSpan={11} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  {hasActiveFilters ? t('patchComplianceView.emptyFiltered') : t('patchComplianceView.empty')}
                </td>
              </tr>
            ) : (
              filteredDevices.map(device => {
                const isSelected = selectedIds.has(device.id);
                const isCompliant = device.pendingPatches === 0;
                const activity = formatLastActivity(device.lastInstalledAt, device.lastScannedAt, t);

                return (
                  <tr key={device.id} className={cn('text-sm hover:bg-muted/30', isSelected && 'bg-primary/5')}>
                    <td className="w-10 px-3 py-2.5">
                      <button
                        type="button"
                        onClick={() => toggleSelect(device.id)}
                        className="flex items-center justify-center text-muted-foreground hover:text-foreground"
                        aria-label={
                          isSelected
                            ? t('patchComplianceView.selection.deselectDevice', { name: device.hostname })
                            : t('patchComplianceView.selection.selectDevice', { name: device.hostname })
                        }
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
                            {device.lastSeenAt && <> &middot; {formatPatchRelativeTime(device.lastSeenAt, t)}</>}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      {isCompliant ? (
                        <span className="inline-flex items-center rounded-full border border-green-500/40 bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-700">
                          {t('patchComplianceView.status.ok')}
                        </span>
                      ) : device.criticalMissing > 0 ? (
                        <span className="inline-flex items-center rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-700">
                          {t('patchComplianceView.status.outstanding', { count: device.pendingPatches })}
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full border border-orange-500/40 bg-orange-500/10 px-2 py-0.5 text-xs font-medium text-orange-700">
                          {t('patchComplianceView.status.outstanding', { count: device.pendingPatches })}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 tabular-nums">
                      {device.approvedMissing > 0 ? (
                        <span className="inline-flex items-center rounded-full border border-green-500/40 bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-700">
                          {device.approvedMissing}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 tabular-nums">
                      {device.unapprovedMissing > 0 ? (
                        <span className="inline-flex items-center rounded-full border border-orange-500/40 bg-orange-500/10 px-2 py-0.5 text-xs font-medium text-orange-700">
                          {device.unapprovedMissing}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 tabular-nums">
                      {device.osMissing > 0 ? device.osMissing : <span className="text-muted-foreground">-</span>}
                    </td>
                    <td className="px-3 py-2.5 tabular-nums">
                      {device.thirdPartyMissing > 0 ? (
                        <span className="inline-flex items-center rounded-full border border-violet-500/40 bg-violet-500/10 px-2 py-0.5 text-xs font-medium text-violet-700">
                          {device.thirdPartyMissing}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      {device.criticalMissing > 0 ? (
                        <span className="inline-flex items-center rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-700">
                          {device.criticalMissing}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground" title={activity.tooltip}>
                      {activity.label}
                    </td>
                    <td className="px-3 py-2.5">
                      {device.pendingReboot ? (
                        device.status === 'offline' ? (
                          // Offline: the pending-reboot flag is frozen at the last
                          // heartbeat and may be stale, so mute it and qualify with
                          // "as of <last seen>" rather than an unqualified "Yes".
                          // Same rationale as the Devices list suppression
                          // (DeviceList.tsx), but compliance still wants the
                          // signal visible, not hidden (#2219).
                          <span
                            data-testid={`compliance-${device.id}-pending-reboot-stale`}
                            title={t('patchComplianceView.reboot.offlineTitle')}
                            className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
                          >
                            <RotateCcw className="h-3 w-3" />
                            {device.lastSeenAt
                              ? t('patchComplianceView.reboot.yesAsOf', { time: formatPatchRelativeTime(device.lastSeenAt, t) })
                              : t('patchComplianceView.reboot.yes')}
                          </span>
                        ) : (
                          <span
                            data-testid={`compliance-${device.id}-pending-reboot`}
                            className="inline-flex items-center gap-1 rounded-full border border-orange-500/40 bg-orange-500/10 px-2 py-0.5 text-xs font-medium text-orange-700"
                          >
                            <RotateCcw className="h-3 w-3" />
                            {t('patchComplianceView.reboot.yes')}
                          </span>
                        )
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <a
                        href={`/devices/${device.id}#patches`}
                        className="inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-xs font-medium hover:bg-muted"
                      >
                        {t('patchComplianceView.actions.view')}
                      </a>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {pendingConfirm && (
        <ConfirmDialog
          open={true}
          onClose={cancelPendingAction}
          onConfirm={() => { void confirmPendingAction(); }}
          title={t('patchComplianceView.confirm.title')}
          variant="warning"
          confirmLabel={pendingConfirm.action.startsWith('Scan') ? t('patchComplianceView.actions.scan') : t('patchComplianceView.actions.install')}
          confirmTestId="confirm-fleet-action"
          message={
            pendingConfirm.orgNames.length <= 1
              ? t(
                  /* i18n-dynamic */ pendingConfirm.deviceCount === 1
                    ? 'patchComplianceView.confirm.messageOne'
                    : 'patchComplianceView.confirm.messageMany',
                  {
                    action: pendingConfirm.action.startsWith('Scan')
                      ? t('patchComplianceView.confirm.scanAction')
                      : t('patchComplianceView.confirm.installAction'),
                    count: pendingConfirm.deviceCount,
                    org: pendingConfirm.orgNames[0] ?? t('patchComplianceView.confirm.selectedOrganization'),
                  }
                )
              : t('patchComplianceView.confirm.messageMultiOrg', {
                  action: pendingConfirm.action.startsWith('Scan')
                    ? t('patchComplianceView.confirm.scanAction')
                    : t('patchComplianceView.confirm.installAction'),
                  count: pendingConfirm.deviceCount,
                  orgCount: pendingConfirm.orgNames.length,
                  orgNames: pendingConfirm.orgNames.join(', '),
                })
          }
          isLoading={bulkAction !== null}
        />
      )}
    </div>
  );
}
