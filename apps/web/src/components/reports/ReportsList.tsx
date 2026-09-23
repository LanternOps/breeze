import { useState, useEffect, useCallback, useRef } from 'react';
import {
  FileText,
  Calendar,
  Download,
  Play,
  Pencil,
  Trash2,
  Plus,
  Clock,
  CheckCircle,
  XCircle,
  Loader2,
  LayoutTemplate,
  Mail
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { runAction, ActionError } from '@/lib/runAction';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { useJwtClaims } from '@/lib/authScope';
import { ScopeBadge } from '../shared/ScopeBadge';
import { exportReport, downloadBlob, getBrowserTimezone, type PostureSummary } from './reportExport';
import { formatDateTime } from '@/lib/dateTimeFormat';
import {
  nextOccurrence,
  formatNextOccurrence,
  type ScheduleCadence,
  type ScheduleConfig,
  type ExecutiveSummary,
  type OrgNarrativeReportSummary,
  type FleetDesignReportSummary,
  type EndpointManagementSummary,
  type VulnerabilityManagementSummary,
  type IdentityAccessSummary,
  type TicketSlaSummary,
  type TechnicianTimeSummary,
  type ArAgingSummary,
  type ReportType as SharedReportType
} from '@breeze/shared';
import { useTranslation } from 'react-i18next';

// Derived from the canonical tuple in `@breeze/shared`
// (`packages/shared/src/reportTypes.ts`) rather than hand-listed. The
// per-type comments that used to live here were about LABELS
// (`getReportTypeLabel` does a dynamic i18n lookup), not about the values, so
// nothing is lost — W03 adds the three business-report labels to the locale
// files.
export type ReportType = SharedReportType;

/**
 * Report types the API owns end to end: the AI schedule creates the definition,
 * fires the run, and stores the snapshot, so every mutating route
 * (create/update/delete/generate/reauthorize) answers
 * `409 { error: 'system_managed_report' }`. Offering Generate/Edit/Delete on
 * such a row could only ever produce that 409, so the list shows a single read
 * action instead. Mirrors `isSystemManagedReportDefinition` in
 * `apps/api/src/routes/reports/helpers.ts` — keep the two in sync.
 */
const SYSTEM_MANAGED_REPORT_TYPES = new Set<ReportType>(['ai_org_narrative', 'ai_fleet_design']);

export function isSystemManagedReportType(type: ReportType): boolean {
  return SYSTEM_MANAGED_REPORT_TYPES.has(type);
}

export type ReportSchedule = 'one_time' | 'daily' | 'weekly' | 'monthly';

export type ReportFormat = 'csv' | 'pdf' | 'excel';

export type Report = {
  id: string;
  name: string;
  type: ReportType;
  schedule: ReportSchedule;
  format: ReportFormat;
  config: Record<string, unknown>;
  /** Owner. A partner-owned report (#3198: covers all of the partner's
   *  organizations) has `orgId: null` and `partnerId` set; an org-owned one has
   *  `orgId` set. Ownership is immutable after create. */
  orgId: string | null;
  partnerId: string | null;
  portalSelfService: boolean;
  lastGeneratedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ReportRun = {
  id: string;
  reportId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startedAt: string | null;
  completedAt: string | null;
  outputUrl: string | null;
  errorMessage: string | null;
  createdAt: string;
  reportName?: string;
  reportType?: ReportType;
};

type ReportsListProps = {
  onEdit?: (report: Report) => void;
  onGenerate?: (report: Report) => void;
  onDelete?: (report: Report) => void;
  timezone?: string;
};

/** Extract the filename from a Content-Disposition header, if present. */
function parseContentDispositionFilename(header: string | null): string | null {
  if (!header) return null;
  const match = /filename="?([^";]+)"?/.exec(header);
  return match?.[1] ?? null;
}

function scheduleConfigOf(config: Record<string, unknown> | undefined): ScheduleConfig {
  const raw = config?.schedule;
  return raw && typeof raw === 'object' ? (raw as ScheduleConfig) : {};
}

// GET /reports caps `limit` at 100 (apps/api/src/utils/pagination.ts). The
// page cap bounds the all-organizations merge at 2,000 rows.
const PARTNER_WIDE_PAGE_LIMIT = 100;
const PARTNER_WIDE_PAGE_CAP = 20;

function recipientCountOf(config: Record<string, unknown> | undefined): number {
  const raw = config?.emailRecipients;
  return Array.isArray(raw) ? raw.filter((r) => typeof r === 'string' && r.trim() !== '').length : 0;
}

export default function ReportsList({ onEdit, onGenerate, onDelete, timezone }: ReportsListProps) {
  const { t } = useTranslation('reports');
  const effectiveTimezone = timezone || getBrowserTimezone();
  const [reports, setReports] = useState<Report[]>([]);
  const [recentRuns, setRecentRuns] = useState<ReportRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [generatingIds, setGeneratingIds] = useState<Set<string>>(new Set());
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'reports' | 'runs'>('reports');
  const { currentOrgId } = useOrgStore();
  const jwtClaims = useJwtClaims();
  // `GET /reports` carries the ambient `?orgId=` of the focused org (kept on
  // purpose: dropping it would list every org's reports under one org), and
  // the API lists partner-owned reports only without it. A partner-owned
  // report covers the focused org too, so for a partner-scope user with an org
  // focused the all-organizations listing is fetched as well and ONLY its
  // partner-owned rows are merged in. This is also the only way a single-org
  // partner (who never gets an All organizations option) sees them. The server
  // stays the gate: it returns partner-owned rows only to callers who may
  // administer partner-wide state. Fails closed while the token is unresolved.
  const mergePartnerWide =
    jwtClaims.status === 'resolved' && jwtClaims.claims.scope === 'partner' && !!currentOrgId;

  const fetchPartnerWideReports = useCallback(async (): Promise<Report[]> => {
    // The listing is paginated (updatedAt desc), so page through it: a
    // partner-owned row past page 1 would otherwise vanish from the org view.
    const rows: Report[] = [];
    try {
      for (let page = 1; page <= PARTNER_WIDE_PAGE_CAP; page++) {
        const response = await fetchWithAuth(
          `/reports?limit=${PARTNER_WIDE_PAGE_LIMIT}&page=${page}`,
          { skipOrgIdInjection: true },
        );
        if (!response.ok) {
          console.warn('Failed to fetch partner-wide reports:', response.status);
          break;
        }
        const data = await response.json();
        const pageRows = (data.data ?? []) as Report[];
        rows.push(...pageRows);
        const total = Number(data.pagination?.total ?? 0);
        if (pageRows.length === 0 || rows.length >= total) break;
        if (page === PARTNER_WIDE_PAGE_CAP) {
          console.warn('Partner-wide reports listing hit the page cap; later rows are not shown:', {
            pages: PARTNER_WIDE_PAGE_CAP,
            fetched: rows.length,
            total,
          });
        }
      }
    } catch (err) {
      // The org's own list still renders; partner-wide rows are an addition.
      console.warn('Failed to fetch partner-wide reports:', err);
    }
    return rows.filter((r) => !!r.partnerId && !r.orgId);
  }, []);

  // Each list fetch takes a sequence number; only the newest may write state,
  // so an older (e.g. pre-merge) response landing late cannot clobber it.
  const fetchSeq = useRef(0);
  const fetchReports = useCallback(async () => {
    const seq = ++fetchSeq.current;
    const isCurrent = () => seq === fetchSeq.current;
    try {
      setLoading(true);
      setError(undefined);
      const [response, partnerWide] = await Promise.all([
        fetchWithAuth('/reports'),
        mergePartnerWide ? fetchPartnerWideReports() : Promise.resolve([] as Report[]),
      ]);
      if (!response.ok) {
        throw new Error(t('reports.reportsList.errors.fetchReports'));
      }
      const data = await response.json();
      if (!isCurrent()) return;
      const own: Report[] = data.data ?? [];
      const seen = new Set(own.map((r) => r.id));
      setReports([...own, ...partnerWide.filter((r) => !seen.has(r.id))]);
    } catch (err) {
      if (!isCurrent()) return;
      setError(err instanceof Error ? err.message : t('reports.reportsList.errors.generic'));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [t, mergePartnerWide, fetchPartnerWideReports]);

  const fetchRecentRuns = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/reports/runs?limit=20');
      if (!response.ok) {
        console.error('Failed to fetch recent runs:', response.status);
        return;
      }
      const data = await response.json();
      setRecentRuns(data.data ?? []);
    } catch (err) {
      console.error('Failed to fetch recent runs:', err);
    }
  }, []);

  useEffect(() => {
    fetchReports();
  }, [fetchReports]);

  // Separate effect: the runs list does not depend on the partner-wide merge
  // flag, so resolving the token must not refetch it.
  useEffect(() => {
    fetchRecentRuns();
  }, [fetchRecentRuns]);

  const handleGenerate = async (report: Report) => {
    setGeneratingIds(prev => new Set([...prev, report.id]));
    try {
      await runAction({
        request: () => fetchWithAuth(`/reports/${report.id}/generate`, {
          method: 'POST'
        }),
        errorFallback: t('reports.reportsList.errors.generateReport'),
        successMessage: t('reports.reportsList.success.generated', { name: report.name })
      });

      onGenerate?.(report);
      // The run completes synchronously server-side (lastGeneratedAt is
      // already updated), so the row must be refetched now, not just the
      // recent-runs list — otherwise it keeps reading "Never" until reload.
      fetchReports();
      // Refresh runs after a short delay
      setTimeout(fetchRecentRuns, 1500);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        setError(err instanceof Error ? err.message : t('reports.reportsList.errors.generateReport'));
      }
    } finally {
      setGeneratingIds(prev => {
        const next = new Set(prev);
        next.delete(report.id);
        return next;
      });
    }
  };

  const handleDelete = async (report: Report) => {
    if (!confirm(t('reports.reportsList.confirmDelete', { name: report.name }))) {
      return;
    }

    setDeletingId(report.id);
    try {
      const response = await fetchWithAuth(`/reports/${report.id}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error(t('reports.reportsList.errors.deleteReport'));
      }

      onDelete?.(report);
      fetchReports();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('reports.reportsList.errors.deleteReport'));
    } finally {
      setDeletingId(null);
    }
  };

  const getStatusIcon = (status: ReportRun['status']) => {
    switch (status) {
      case 'completed':
        return <CheckCircle className="h-4 w-4 text-success" />;
      case 'failed':
        return <XCircle className="h-4 w-4 text-destructive" />;
      case 'running':
        return <Loader2 className="h-4 w-4 text-primary animate-spin" />;
      default:
        return <Clock className="h-4 w-4 text-muted-foreground" />;
    }
  };

  const [downloadingRunId, setDownloadingRunId] = useState<string | null>(null);
  const [openingReportId, setOpeningReportId] = useState<string | null>(null);

  const getReportTypeLabel = (type: ReportType) => t(/* i18n-dynamic */ `reports.reportsList.reportTypes.${type}`);
  const getScheduleLabel = (schedule: ReportSchedule) => t(/* i18n-dynamic */ `reports.reportsList.schedules.${schedule}`);
  const getFormatLabel = (format: ReportFormat) => t(/* i18n-dynamic */ `reports.reportsList.formats.${format}`);
  const getStatusLabel = (status: ReportRun['status']) => t(/* i18n-dynamic */ `reports.reportsList.status.${status}`);

  const handleDownload = async (run: ReportRun) => {
    setDownloadingRunId(run.id);
    try {
      const res = await fetchWithAuth(`/reports/runs/${run.id}/download`);
      if (!res.ok) {
        let message = t('reports.reportsList.errors.downloadFailed');
        try {
          message = (await res.json())?.error ?? message;
        } catch {
          /* non-JSON error body */
        }
        throw new Error(message);
      }

      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        // PDF path: server returned the stored snapshot; render client-side.
        const payload = await res.json();
        const data = payload.data as {
          rows?: unknown[];
          summary?: unknown;
          previous?: { generatedAt?: string | null; summary?: unknown };
        } | undefined;
        const rows = data?.rows ?? [];
        await exportReport(rows, {
          format: 'pdf',
          reportType: payload.type ?? run.reportType ?? 'report',
          timezone: effectiveTimezone,
          // The posture / executive-summary covers and the AI org narrative
          // body consume this snapshot; ignored by other report types.
          summary: data?.summary as
            | PostureSummary
            | ExecutiveSummary
            | OrgNarrativeReportSummary
            | FleetDesignReportSummary
            // #5784 W03 — the endpoint-management cover consumes this snapshot
            // too. The cast does not filter at runtime, but leaving the type
            // out would let a later refactor drop the summary here and silently
            // degrade the staff PDF to the generic row table.
            | EndpointManagementSummary
            // #5784 W04: without this member the staff/browser path passes the
            // designed vulnerability summary as an unrelated type and the
            // compiler stops guarding buildReportPdf's arm for it.
            | VulnerabilityManagementSummary
            // #5784 W06 — same reasoning, for the identity access review cover.
            | IdentityAccessSummary
            // #3198 W03 — the three business report types (ticket SLA
            // attainment, technician time & billability, AR aging).
            | TicketSlaSummary
            | TechnicianTimeSummary
            | ArAgingSummary
            | undefined,
          // Drives the scorecard trend chip ("79, up from 74 last month")
          // when the stored run snapshot captured a prior baseline.
          previous: data?.previous,
        });
        return;
      }

      // CSV/Excel: save the returned file blob directly.
      const blob = await res.blob();
      const filename =
        parseContentDispositionFilename(res.headers.get('content-disposition')) ??
        `${run.reportType ?? 'report'}-report.csv`;
      downloadBlob(blob, filename);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('reports.reportsList.errors.downloadFailed'));
    } finally {
      setDownloadingRunId(null);
    }
  };

  /**
   * The only list action a system-managed report offers: resolve its newest
   * completed run and hand it to the shared download path, which renders the
   * stored snapshot client-side. `GET /reports/runs` orders newest-first, so
   * `limit=1` is the latest. Read-only, so no `runAction` wrapper — failures
   * surface through the same inline error banner the download path uses.
   */
  const handleOpenLatest = async (report: Report) => {
    setOpeningReportId(report.id);
    try {
      const res = await fetchWithAuth(
        `/reports/runs?reportId=${encodeURIComponent(report.id)}&status=completed&limit=1`
      );
      if (!res.ok) {
        throw new Error(t('reports.reportsList.errors.downloadFailed'));
      }
      const payload = await res.json();
      const latest = (payload.data ?? [])[0] as ReportRun | undefined;
      if (!latest) {
        throw new Error(t('reports.reportsList.errors.noCompletedRun'));
      }
      // handleDownload swallows its own failures into `error`; nothing to catch.
      await handleDownload({ ...latest, reportType: latest.reportType ?? report.type });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('reports.reportsList.errors.downloadFailed'));
    } finally {
      setOpeningReportId(null);
    }
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return t('reports.reportsList.never');
    return formatDateTime(dateStr, { timeZone: effectiveTimezone });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">{t('reports.reportsList.loading')}</p>
        </div>
      </div>
    );
  }

  if (error && reports.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchReports}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {t('reports.reportsList.tryAgain')}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('reports.reportsList.title')}</h1>
          <p className="text-muted-foreground">{t('reports.reportsList.description')}</p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href="/reports/templates"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted"
          >
            <LayoutTemplate className="h-4 w-4" />
            {t('reports.reportsList.templates')}
          </a>
          <a
            href="/reports/builder"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted"
          >
            <FileText className="h-4 w-4" />
            {t('reports.reportsList.adhocReport')}
          </a>
          <a
            href="/reports/new"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            {t('reports.reportsList.newReport')}
          </a>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Tabs */}
      <div className="border-b">
        <div className="flex gap-4">
          <button
            type="button"
            data-testid="reports-tab-saved"
            onClick={() => setActiveTab('reports')}
            className={cn(
              'pb-3 text-sm font-medium transition-colors',
              activeTab === 'reports'
                ? 'border-b-2 border-primary text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {t('reports.reportsList.tabs.savedReports')}
          </button>
          <button
            type="button"
            data-testid="reports-tab-runs"
            onClick={() => setActiveTab('runs')}
            className={cn(
              'pb-3 text-sm font-medium transition-colors',
              activeTab === 'runs'
                ? 'border-b-2 border-primary text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {t('reports.reportsList.tabs.recentRuns')}
          </button>
        </div>
      </div>

      {activeTab === 'reports' && (
        <>
          {reports.length === 0 ? (
            <div className="rounded-lg border border-dashed p-12 text-center">
              <FileText className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-medium">{t('reports.reportsList.emptyReportsTitle')}</h3>
              <p className="text-sm text-muted-foreground mt-1">
                {t('reports.reportsList.emptyReportsDescription')}
              </p>
              <a
                href="/reports/new"
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 mt-4"
              >
                <Plus className="h-4 w-4" />
                {t('reports.reportsList.createReport')}
              </a>
            </div>
          ) : (
            <div className="rounded-lg border bg-card shadow-xs overflow-hidden">
              <table className="w-full">
                <thead className="bg-muted/40">
                  <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3">
                      {t('reports.reportsList.table.name')}
                    </th>
                    <th className="px-4 py-3">
                      {t('reports.reportsList.table.type')}
                    </th>
                    <th className="px-4 py-3">
                      {t('reports.reportsList.table.schedule')}
                    </th>
                    <th className="px-4 py-3">
                      {t('reports.reportsList.table.format')}
                    </th>
                    <th className="px-4 py-3">
                      {t('reports.reportsList.table.lastGenerated')}
                    </th>
                    <th className="px-4 py-3 text-right">
                      {t('reports.reportsList.table.actions')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {reports.map(report => (
                    <tr key={report.id} data-testid={`report-row-${report.id}`} className="hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <FileText className="h-4 w-4 text-muted-foreground" />
                          <span className="font-medium">{report.name}</span>
                          {report.portalSelfService && (
                            <span
                              data-testid={`report-portal-badge-${report.id}`}
                              className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                            >
                              {t('reports.reportsList.visibleInPortal')}
                            </span>
                          )}
                          {report.partnerId && !report.orgId && (
                            // Partner-owned: covers all of the partner's
                            // organizations (#3198). ScopeBadge keeps its own
                            // fixed testid, so the per-row one lives here.
                            <span data-testid={`report-scope-badge-${report.id}`} className="shrink-0">
                              <ScopeBadge orgId={null} partnerId={report.partnerId} isSystem={false} />
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {getReportTypeLabel(report.type)}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={cn(
                            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
                            report.schedule === 'one_time'
                              ? 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
                              : 'bg-primary/10 text-primary'
                          )}
                        >
                          <Calendar className="h-3 w-3" />
                          {getScheduleLabel(report.schedule)}
                        </span>
                        {report.schedule !== 'one_time' && (
                          /* Computed in the viewer's timezone; the worker fires in the
                             org's timezone, so this is a close approximation shown to
                             the user, not a contract for when the run actually fires.
                             System-managed rows are fired by the AI schedule, not by
                             this definition's cadence, so no occurrence is computed. */
                          <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                            <span>
                              {isSystemManagedReportType(report.type)
                                ? t('reports.reportsList.aiNarrative.managedBySchedule')
                                : t('reports.reportsList.nextOccurrence', {
                                    next: formatNextOccurrence(
                                      nextOccurrence(
                                        new Date(),
                                        report.schedule as ScheduleCadence,
                                        scheduleConfigOf(report.config),
                                        effectiveTimezone
                                      ),
                                      { weekday: report.schedule === 'weekly' }
                                    )
                                  })}
                            </span>
                            {recipientCountOf(report.config) > 0 && (
                              <span className="inline-flex items-center gap-1" title={t('reports.reportsList.emailRecipients')}>
                                <Mail className="h-3 w-3" />
                                {recipientCountOf(report.config)}
                              </span>
                            )}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {getFormatLabel(report.format)}
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {formatDate(report.lastGeneratedAt)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          {isSystemManagedReportType(report.type) || report.portalSelfService ? (
                            /* Generate/Edit/Delete all return 409 for these —
                               system-managed always, portal self-service
                               (#4562) while the customer portal exposes
                               reports — so the row offers reading the newest
                               run only. Read-only, not invisible: the MSP can
                               still open what the customer sees. */
                            <button
                              type="button"
                              data-testid={`report-open-latest-${report.id}`}
                              onClick={() => handleOpenLatest(report)}
                              disabled={openingReportId === report.id}
                              className="flex h-8 items-center gap-1 rounded-md border px-3 text-sm hover:bg-muted disabled:opacity-50"
                            >
                              {openingReportId === report.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Download className="h-4 w-4" />
                              )}
                              {t('reports.reportsList.aiNarrative.openLatest')}
                            </button>
                          ) : (
                            <>
                              <button
                                type="button"
                                data-testid={`report-generate-${report.id}`}
                                onClick={() => handleGenerate(report)}
                                disabled={generatingIds.has(report.id)}
                                className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted disabled:opacity-50"
                                title={t('reports.reportsList.actions.generateNow')}
                              >
                                {generatingIds.has(report.id) ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <Play className="h-4 w-4" />
                                )}
                              </button>
                              <button
                                type="button"
                                data-testid={`report-edit-${report.id}`}
                                onClick={() => onEdit?.(report)}
                                className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
                                title={t('reports.reportsList.actions.edit')}
                              >
                                <Pencil className="h-4 w-4" />
                              </button>
                              <button
                                type="button"
                                data-testid={`report-delete-${report.id}`}
                                onClick={() => handleDelete(report)}
                                disabled={deletingId === report.id}
                                className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted text-destructive disabled:opacity-50"
                                title={t('reports.reportsList.actions.delete')}
                              >
                                {deletingId === report.id ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <Trash2 className="h-4 w-4" />
                                )}
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {activeTab === 'runs' && (
        <>
          {recentRuns.length === 0 ? (
            <div className="rounded-lg border border-dashed p-12 text-center">
              <Clock className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-medium">{t('reports.reportsList.emptyRunsTitle')}</h3>
              <p className="text-sm text-muted-foreground mt-1">
                {t('reports.reportsList.emptyRunsDescription')}
              </p>
            </div>
          ) : (
            <div className="rounded-lg border bg-card shadow-xs overflow-hidden">
              <table className="w-full">
                <thead className="bg-muted/40">
                  <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3">
                      {t('reports.reportsList.runsTable.report')}
                    </th>
                    <th className="px-4 py-3">
                      {t('reports.reportsList.runsTable.status')}
                    </th>
                    <th className="px-4 py-3">
                      {t('reports.reportsList.runsTable.started')}
                    </th>
                    <th className="px-4 py-3">
                      {t('reports.reportsList.runsTable.completed')}
                    </th>
                    <th className="px-4 py-3 text-right">
                      {t('reports.reportsList.runsTable.actions')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {recentRuns.map(run => (
                    <tr key={run.id} data-testid={`report-run-row-${run.id}`} className="hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <div>
                          <span className="font-medium">{run.reportName || t('reports.reportsList.unknownReport')}</span>
                          {run.reportType && (
                            <p className="text-xs text-muted-foreground">
                              {getReportTypeLabel(run.reportType)}
                            </p>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {getStatusIcon(run.status)}
                          <span
                            data-testid={`report-run-status-${run.id}`}
                            data-status={run.status}
                            className={cn(
                              'text-sm capitalize',
                              run.status === 'completed' && 'text-success',
                              run.status === 'failed' && 'text-destructive',
                              run.status === 'running' && 'text-primary'
                            )}
                          >
                            {getStatusLabel(run.status)}
                          </span>
                        </div>
                        {run.errorMessage && (
                          <p className="text-xs text-destructive mt-1">{run.errorMessage}</p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {formatDate(run.startedAt)}
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {formatDate(run.completedAt)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end">
                          {run.status === 'completed' && (
                            <button
                              type="button"
                              data-testid={`report-run-download-${run.id}`}
                              onClick={() => handleDownload(run)}
                              disabled={downloadingRunId === run.id}
                              className="flex h-8 items-center gap-1 rounded-md border px-3 text-sm hover:bg-muted disabled:opacity-50"
                            >
                              {downloadingRunId === run.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Download className="h-4 w-4" />
                              )}
                              {t('reports.reportsList.download')}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
