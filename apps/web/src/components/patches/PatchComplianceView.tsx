import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  AlertTriangle,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
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
import { deviceNeedsUpdates, toNumber, type DevicePatchRow } from './patchHelpers';
import { usePatchSelection } from './usePatchSelection';
import { useBulkActions, type ResolvedInstallPatchIds } from './useBulkActions';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { useOrgStore } from '../../stores/orgStore';
import { runAction, ActionError } from '@/lib/runAction';
import { showToast } from '../shared/Toast';
import { downloadBlob } from '@/lib/downloadBlob';
import { useStableT } from '@/lib/i18n/useStableT';
import { useHashState } from '@/lib/useHashState';
import { replaceUrl } from '@/lib/replaceUrl';
import { mergePatchesHash, parsePatchesHash, type ComplianceStatusSelection } from './patchesHash';

/**
 * Every number here comes from GET /patches/compliance (#9791 C), computed over
 * the whole counted device set, never from the loaded page of rows.
 */
type ComplianceSummary = {
  totalDevices: number;
  compliantDevices: number;
  /** compliant / total, the same figure the dashboard KPI shows. */
  devicePercent: number;
  /** Outstanding patch totals across all devices. */
  criticalPatches: number;
  approvedPatches: number;
  unapprovedPatches: number;
  failedPatches: number;
  /** W06: distinct container images the registry check could not verify. */
  imagesNotChecked: number;
  /** Devices per status filter (for the filter option labels). */
  counts: {
    all: number;
    compliant: number;
    needsPatches: number;
    failed: number;
    critical: number;
    reboot: number;
    thirdParty: number;
  };
};

const EMPTY_SUMMARY: ComplianceSummary = {
  totalDevices: 0,
  compliantDevices: 0,
  devicePercent: 0,
  criticalPatches: 0,
  approvedPatches: 0,
  unapprovedPatches: 0,
  failedPatches: 0,
  imagesNotChecked: 0,
  counts: { all: 0, compliant: 0, needsPatches: 0, failed: 0, critical: 0, reboot: 0, thirdParty: 0 },
};

type DevicePage = { total: number; limit: number; offset: number };

const SEARCH_DEBOUNCE_MS = 300;

function statusFromHash(hash: string): ComplianceStatusSelection | undefined {
  return parsePatchesHash(hash).status ?? undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

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
  const stableT = useStableT(t); // #3632: effect-safe translator; JSX keeps `t`
  const { organizations, currentOrgId } = useOrgStore();
  // Compliance export resolves a single target org server-side
  // (resolvePatchReportOrgId), which 400s for a partner with >1 accessible org
  // and no orgId. With a specific org selected, fetchWithAuth auto-injects
  // ?orgId=; a selected ring also resolves the org. In All-orgs mode with no
  // ring, disable export with a hint instead of firing a request that 400s.
  const canExport = currentOrgId !== null || !!ringId;
  // One page of rows; the server filters (status, search) and pages (#9791 C).
  const [devices, setDevices] = useState<DevicePatchRow[]>([]);
  const [summary, setSummary] = useState<ComplianceSummary>(EMPTY_SUMMARY);
  const [page, setPage] = useState<DevicePage>({ total: 0, limit: 0, offset: 0 });
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const [searchQuery, setSearchQuery] = useState('');
  const [search, setSearch] = useState('');
  // The status filter lives in the hash (`#compliance&status=failed` ≡
  // `#status=failed`) so a dashboard link lands pre-filtered.
  const [statusFilter, setStatusFilterState] = useHashState<ComplianceStatusSelection>('all', statusFromHash);
  const setStatusFilter = useCallback((next: ComplianceStatusSelection) => {
    setStatusFilterState(next);
    replaceUrl(`${window.location.pathname}${window.location.search}${mergePatchesHash(window.location.hash, { status: next })}`);
  }, [setStatusFilterState]);
  // The page offset belongs to one filter combination: a new ring, status or
  // search derives back to the first page with no extra fetch.
  const filterKey = `${ringId ?? ''}|${statusFilter}|${search}`;
  const [pageCursor, setPageCursor] = useState({ key: filterKey, offset: 0 });
  const offset = pageCursor.key === filterKey ? pageCursor.offset : 0;
  const goToOffset = useCallback((next: number) => setPageCursor({ key: filterKey, offset: Math.max(0, next) }), [filterKey]);
  // Only the newest request may write state: the hash-adopted status, a
  // debounced search or a page click can overlap an in-flight fetch.
  const requestSeqRef = useRef(0);
  const [exporting, setExporting] = useState(false);
  const reportPollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Bumped each time an export starts polling. A poll whose generation is no
  // longer current was superseded by a newer export and must not touch the
  // newer poll's timer or banner (its download can still be in flight).
  const reportPollGenerationRef = useRef(0);

  const fetchData = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    const isCurrent = () => requestSeqRef.current === seq;
    // A 401 navigates away: keep the spinner up rather than flash an empty view.
    let redirecting = false;
    try {
      setLoading(true);
      setError(undefined);
      // Only non-default params are sent; the server's page size comes back in
      // devicesPage.limit. The org scope is ambient (fetchWithAuth injects it).
      const params = new URLSearchParams();
      if (ringId) params.set('ringId', ringId);
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (search) params.set('search', search);
      if (offset > 0) params.set('offset', String(offset));
      const complianceUrl = params.toString() ? `/patches/compliance?${params}` : '/patches/compliance';

      const complianceRes = await fetchWithAuth(complianceUrl);
      if (!isCurrent()) return;
      if (!complianceRes.ok) {
        if (complianceRes.status === 401) {
          redirecting = true;
          void navigateTo('/login', { replace: true });
          return;
        }
        throw new Error('compliance request failed');
      }

      // A body that isn't the expected JSON (proxy error page, truncated
      // response) is a load failure, never an empty fleet.
      const body = await complianceRes.json().catch(() => null);
      if (!isCurrent()) return;
      const data = body?.data;
      if (!data || typeof data !== 'object') throw new Error('compliance response has no data');
      // Rows are required whenever the scope has devices; an API without the
      // #9791 C list must read as a failure, not as an empty table.
      if (!Array.isArray(data.devices) && toNumber(data.totalDevices ?? 0) > 0) {
        throw new Error('compliance response has no device list');
      }
      const rawRows: unknown[] = Array.isArray(data.devices) ? data.devices : [];
      const rows: DevicePatchRow[] = rawRows.map((value) => {
        const raw = (value ?? {}) as Record<string, unknown>;
        return {
          id: String(raw.id ?? ''),
          hostname: str(raw.hostname) ?? stableT('patchComplianceView.unknownDevice'),
          displayName: typeof raw.displayName === 'string' && raw.displayName.trim() ? raw.displayName : undefined,
          osType: str(raw.osType) ?? 'unknown',
          lastSeenAt: str(raw.lastSeenAt),
          pendingPatches: toNumber(raw.pendingPatches ?? 0),
          approvedMissing: toNumber(raw.approvedMissing ?? 0),
          unapprovedMissing: toNumber(raw.unapprovedMissing ?? 0),
          failedMissing: toNumber(raw.failedMissing ?? 0),
          criticalMissing: toNumber(raw.criticalMissing ?? 0),
          importantMissing: toNumber(raw.importantMissing ?? 0),
          osMissing: toNumber(raw.osMissing ?? 0),
          thirdPartyMissing: toNumber(raw.thirdPartyMissing ?? 0),
          lastInstalledAt: str(raw.lastInstalledAt),
          lastScannedAt: str(raw.lastScannedAt),
          pendingReboot: Boolean(raw.pendingReboot),
          staleImages: toNumber(raw.staleImages ?? 0),
          status: str(raw.status),
          // Load-bearing: the bulk scan/install confirmation names the
          // selected rows' orgs from this, not from currentOrgId.
          orgId: str(raw.orgId),
        };
      });
      setDevices(rows);

      const counts = data.deviceCounts ?? {};
      const totals = data.outstandingTotals ?? {};
      const totalDevices = toNumber(data.totalDevices ?? 0);
      const compliantDevices = toNumber(data.compliantDevices ?? 0);
      setSummary({
        totalDevices,
        compliantDevices,
        // Same derivation as the dashboard card's fallback, so the two never
        // disagree if the field is ever absent.
        devicePercent: typeof data.devicePercent === 'number'
          ? data.devicePercent
          : totalDevices > 0 ? Math.round((compliantDevices / totalDevices) * 100) : 0,
        criticalPatches: toNumber(totals.critical ?? 0),
        approvedPatches: toNumber(totals.approved ?? 0),
        unapprovedPatches: toNumber(totals.unapproved ?? 0),
        failedPatches: toNumber(totals.failed ?? 0),
        imagesNotChecked: toNumber(data.containerImages?.unknown ?? 0),
        counts: {
          all: toNumber(counts.all ?? data.totalDevices ?? 0),
          compliant: toNumber(counts.compliant ?? data.compliantDevices ?? 0),
          needsPatches: toNumber(counts.needsPatches ?? 0),
          failed: toNumber(counts.failed ?? data.failedDevices ?? 0),
          critical: toNumber(counts.critical ?? 0),
          reboot: toNumber(counts.reboot ?? 0),
          thirdParty: toNumber(counts.thirdParty ?? 0),
        },
      });
      const devicesPage = data.devicesPage ?? {};
      setPage({
        total: toNumber(devicesPage.total ?? rows.length),
        limit: toNumber(devicesPage.limit ?? rows.length),
        offset: toNumber(devicesPage.offset ?? offset),
      });
      setLoaded(true);
    } catch {
      if (!isCurrent()) return;
      // Always the localized message: a raw SyntaxError / TypeError text
      // ("Unexpected token '<'", "Failed to fetch") means nothing to a user.
      setError(stableT('patchComplianceView.errors.fetchData'));
    } finally {
      if (isCurrent() && !redirecting) setLoading(false);
    }
  }, [ringId, statusFilter, search, offset, stableT]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Search is a server param; debounce keystrokes into it.
  useEffect(() => {
    const trimmed = searchQuery.trim();
    if (trimmed === search) return;
    const timer = setTimeout(() => setSearch(trimmed), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchQuery, search]);


  useEffect(() => {
    return () => {
      if (reportPollTimerRef.current) {
        clearInterval(reportPollTimerRef.current);
        reportPollTimerRef.current = null;
      }
    };
  }, []);

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

  // "Select all" selects the loaded page; the selection is dropped whenever a
  // different page or filter loads, since bulk actions read each selected
  // row's counts and orgId from the loaded rows.
  const pageIds = useMemo(() => devices.map(d => d.id), [devices]);
  const { selectedIds, allPageSelected: allSelected, somePageSelected: someSelected, toggleSelect, toggleSelectAll, clearSelection } = usePatchSelection(pageIds);
  // Cleared both when the request changes and when its rows land, so a box
  // ticked on the old rows during the in-flight window cannot survive.
  useEffect(() => {
    clearSelection();
  }, [filterKey, offset, devices, clearSelection]);

  // A page past the end (the fleet shrank, or a bulk action emptied the last
  // page) snaps back to the last page that has rows.
  useEffect(() => {
    if (!loaded || loading || devices.length > 0 || page.offset === 0 || page.total === 0 || page.limit <= 0) return;
    goToOffset(Math.floor((page.total - 1) / page.limit) * page.limit);
  }, [loaded, loading, devices.length, page, goToOffset]);

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

        const generation = ++reportPollGenerationRef.current;
        const isCurrentPoll = () => reportPollGenerationRef.current === generation;
        const stopPolling = () => {
          clearInterval(timer);
          if (reportPollTimerRef.current === timer) reportPollTimerRef.current = null;
        };
        const timer = setInterval(async () => {
          try {
            const statusResponse = await fetchWithAuth(`/patches/compliance/report/${reportId}`);
            if (!statusResponse.ok) {
              throw new Error(t('patchComplianceView.export.checkFailed'));
            }
            const payload = await statusResponse.json();
            const report = payload?.data ?? payload;
            if (report?.status === 'completed') {
              stopPolling();
              setBulkSuccess(t('patchComplianceView.export.ready', { reportId }));
              // Fetch through fetchWithAuth: the access token lives in memory
              // and is attached only by fetchWithAuth, so a plain navigation to
              // the download URL reaches authMiddleware without a bearer (#8306).
              const downloadResponse = await fetchWithAuth(`/patches/compliance/report/${reportId}/download`);
              if (!downloadResponse.ok) {
                throw new Error(t('patchComplianceView.export.downloadFailed', { reportId }));
              }
              downloadBlob(await downloadResponse.blob(), `patch-compliance-${reportId}.csv`);
            } else if (report?.status === 'failed') {
              stopPolling();
              setBulkError(report?.errorMessage || t('patchComplianceView.export.failed', { reportId }));
              setBulkSuccess(undefined);
            } else if (report?.status === 'expired') {
              // The report file is past its retention window and was removed.
              if (reportPollTimerRef.current) {
                clearInterval(reportPollTimerRef.current);
                reportPollTimerRef.current = null;
              }
              setBulkError(t('patchComplianceView.export.expired', { reportId }));
              setBulkSuccess(undefined);
            }
          } catch (err) {
            stopPolling();
            // Superseded by a newer export: don't overwrite its banner.
            if (!isCurrentPoll()) return;
            setBulkError(err instanceof Error ? err.message : t('patchComplianceView.export.checkFailed'));
            setBulkSuccess(undefined);
          }
        }, 3000);
        reportPollTimerRef.current = timer;
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
      // Failed installs are split out of approvedMissing; they stay selectable
      // so a failed approved patch can still be retried from here.
      return d && d.approvedMissing + d.failedMissing > 0;
    });
  }, [selectedIds, devices]);
  const selectedWithPatches = selectedPatchDeviceIds.length;

  // Auto-dismiss success banners
  useEffect(() => {
    if (!bulkSuccess) return;
    const timer = setTimeout(() => setBulkSuccess(undefined), 5000);
    return () => clearTimeout(timer);
  }, [bulkSuccess, setBulkSuccess]);

  // Full-page spinner only before the first load: later refetches (filter,
  // search, page) keep the controls mounted so the search box keeps focus.
  if (loading && !loaded) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error && !loaded) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button type="button" onClick={fetchData} className="mt-3 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
          {t('patchComplianceView.actions.tryAgain')}
        </button>
      </div>
    );
  }

  const nonCompliantCount = summary.totalDevices - summary.compliantDevices;
  const pageFrom = page.total === 0 ? 0 : page.offset + 1;
  const pageTo = page.offset + devices.length;
  const hasPrevPage = page.offset > 0;
  const hasNextPage = page.limit > 0 && page.offset + page.limit < page.total;

  return (
    <div className="space-y-4">
      {/* Compact compliance summary */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
          {/* The device % from the API, the same figure the dashboard KPI
              shows. An empty fleet has no percentage: the table's empty state
              speaks instead of claiming 0% or 100% of nothing. */}
          {summary.totalDevices > 0 && (
            <>
              <span className="flex items-center gap-1.5 font-semibold" data-testid="patch-compliance-device-percent">
                <Shield className="h-4 w-4 text-muted-foreground" />
                {t('patchComplianceView.summary.compliantPercent', { percent: summary.devicePercent })}
              </span>
              <span className="text-muted-foreground">
                {t('patchComplianceView.summary.devices', { compliant: summary.compliantDevices, total: summary.totalDevices })}
              </span>
            </>
          )}
          {nonCompliantCount > 0 && (
            <span className="flex items-center gap-1 text-orange-600">
              <AlertTriangle className="h-3.5 w-3.5" />
              {t('patchComplianceView.summary.pendingDevices', { count: nonCompliantCount })}
            </span>
          )}
          {summary.approvedPatches > 0 && (
            <span className="text-green-700 font-medium">{t('patchComplianceView.summary.approved', { count: summary.approvedPatches })}</span>
          )}
          {summary.unapprovedPatches > 0 && (
            <span className="text-orange-600 font-medium">{t('patchComplianceView.summary.pendingApproval', { count: summary.unapprovedPatches })}</span>
          )}
          {summary.failedPatches > 0 && (
            <span className="text-red-600 font-medium">{t('patchComplianceView.summary.failedInstalls', { count: summary.failedPatches })}</span>
          )}
          {summary.criticalPatches > 0 && (
            <span className="text-red-600 font-medium">{t('patchComplianceView.summary.critical', { count: summary.criticalPatches })}</span>
          )}
          {summary.imagesNotChecked > 0 && (
            <span className="text-muted-foreground">{t('patchComplianceView.summary.imagesNotChecked', { count: summary.imagesNotChecked })}</span>
          )}
          {summary.counts.reboot > 0 && (
            <span className="flex items-center gap-1 text-orange-600">
              <RotateCcw className="h-3.5 w-3.5" />
              {t('patchComplianceView.summary.reboot', { count: summary.counts.reboot })}
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
          aria-label={t('patchComplianceView.filters.statusFilterLabel')}
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value as ComplianceStatusSelection)}
          className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        >
          <option value="all">{t('patchComplianceView.filters.allDevices', { count: summary.counts.all })}</option>
          <option value="needs-patches">{t('patchComplianceView.filters.pendingPatches', { count: summary.counts.needsPatches })}</option>
          <option value="critical">{t('patchComplianceView.filters.critical', { count: summary.counts.critical })}</option>
          <option value="failed">{t('patchComplianceView.filters.failed', { count: summary.counts.failed })}</option>
          <option value="reboot">{t('patchComplianceView.filters.pendingReboot', { count: summary.counts.reboot })}</option>
          <option value="third-party">{t('patchComplianceView.filters.thirdPartyPending', { count: summary.counts.thirdParty })}</option>
          <option value="compliant">{t('patchComplianceView.filters.compliant', { count: summary.counts.compliant })}</option>
        </select>
        {hasActiveFilters && (
          <button
            type="button"
            onClick={() => { setSearchQuery(''); setSearch(''); setStatusFilter('all'); }}
            className="h-9 rounded-md px-3 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            {t('patchComplianceView.actions.clear')}
          </button>
        )}
        {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />}
        {page.total > 0 && (
          <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground" data-testid="patch-compliance-pager">
            <span>{t('patchComplianceView.pager.range', { from: pageFrom, to: pageTo, total: page.total })}</span>
            <button
              type="button"
              onClick={() => goToOffset(page.offset - page.limit)}
              disabled={!hasPrevPage || loading}
              aria-label={t('patchComplianceView.pager.previous')}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border bg-background hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => goToOffset(page.offset + page.limit)}
              disabled={!hasNextPage || loading}
              aria-label={t('patchComplianceView.pager.next')}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border bg-background hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
      {error && loaded && (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

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
              <th className="px-3 py-3" title={t('patchComplianceView.table.failedTitle')}>{t('patchComplianceView.table.failed')}</th>
              <th className="px-3 py-3" title={t('patchComplianceView.table.osPatchesTitle')}>{t('patchComplianceView.table.osPatches')}</th>
              <th className="px-3 py-3" title={t('patchComplianceView.table.thirdPartyTitle')}>{t('patchComplianceView.table.thirdParty')}</th>
              <th className="px-3 py-3" title={t('patchComplianceView.table.criticalTitle')}>{t('patchComplianceView.table.critical')}</th>
              <th className="px-3 py-3" title={t('patchComplianceView.table.lastActivityTitle')}>{t('patchComplianceView.table.lastActivity')}</th>
              <th className="px-3 py-3" title={t('patchComplianceView.table.rebootTitle')}>{t('patchComplianceView.table.reboot')}</th>
              <th className="px-3 py-3 text-right">{t('patchComplianceView.table.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {devices.length === 0 ? (
              <tr>
                <td colSpan={12} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  {hasActiveFilters ? t('patchComplianceView.emptyFiltered') : t('patchComplianceView.empty')}
                </td>
              </tr>
            ) : (
              devices.map(device => {
                const isSelected = selectedIds.has(device.id);
                const isCompliant = !deviceNeedsUpdates(device);
                const activity = formatLastActivity(device.lastInstalledAt, device.lastScannedAt, t);
                // #9533: lead with the display name like the rest of the app;
                // the hostname stays visible as secondary context.
                const deviceName = device.displayName || device.hostname;
                const showHostname = !!device.displayName && device.displayName !== device.hostname;

                return (
                  <tr key={device.id} className={cn('text-sm hover:bg-muted/30', isSelected && 'bg-primary/5')}>
                    <td className="w-10 px-3 py-2.5">
                      <button
                        type="button"
                        onClick={() => toggleSelect(device.id)}
                        className="flex items-center justify-center text-muted-foreground hover:text-foreground"
                        aria-label={
                          isSelected
                            ? t('patchComplianceView.selection.deselectDevice', { name: deviceName })
                            : t('patchComplianceView.selection.selectDevice', { name: deviceName })
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
                            <span className="truncate" title={deviceName}>{deviceName}</span>
                            <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
                          </a>
                          <div className="text-xs text-muted-foreground">
                            {showHostname && (
                              <><span data-testid={`compliance-${device.id}-hostname`} title={device.hostname}>{device.hostname}</span> &middot; </>
                            )}
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
                    <td className="px-3 py-2.5 tabular-nums" data-testid={`failed-installs-${device.id}`}>
                      {device.failedMissing > 0 ? (
                        <span className="inline-flex items-center rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-700">
                          {device.failedMissing}
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
