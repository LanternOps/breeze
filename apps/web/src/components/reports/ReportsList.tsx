import { useState, useEffect, useCallback } from 'react';
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
import { fetchWithAuth } from '../../stores/auth';
import { exportReport, downloadBlob, getBrowserTimezone, type PostureSummary } from './reportExport';
import { formatDateTime } from '@/lib/dateTimeFormat';
import {
  nextOccurrence,
  formatNextOccurrence,
  type ScheduleCadence,
  type ScheduleConfig,
  type ExecutiveSummary
} from '@breeze/shared';
import { useTranslation } from 'react-i18next';

export type ReportType =
  | 'device_inventory'
  | 'software_inventory'
  | 'alert_summary'
  | 'compliance'
  | 'performance'
  | 'executive_summary'
  | 'security_compliance_posture';

export type ReportSchedule = 'one_time' | 'daily' | 'weekly' | 'monthly';

export type ReportFormat = 'csv' | 'pdf' | 'excel';

export type Report = {
  id: string;
  name: string;
  type: ReportType;
  schedule: ReportSchedule;
  format: ReportFormat;
  config: Record<string, unknown>;
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

  const fetchReports = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth('/reports');
      if (!response.ok) {
        throw new Error(t('reports.reportsList.errors.fetchReports'));
      }
      const data = await response.json();
      setReports(data.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('reports.reportsList.errors.generic'));
    } finally {
      setLoading(false);
    }
  }, [t]);

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
    fetchRecentRuns();
  }, [fetchReports, fetchRecentRuns]);

  const handleGenerate = async (report: Report) => {
    setGeneratingIds(prev => new Set([...prev, report.id]));
    try {
      const response = await fetchWithAuth(`/reports/${report.id}/generate`, {
        method: 'POST'
      });

      if (!response.ok) {
        throw new Error(t('reports.reportsList.errors.generateReport'));
      }

      onGenerate?.(report);
      // Refresh runs after a short delay
      setTimeout(fetchRecentRuns, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('reports.reportsList.errors.generateReport'));
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

  const getReportTypeLabel = (type: ReportType) => t(`reports.reportsList.reportTypes.${type}`); // i18n-dynamic
  const getScheduleLabel = (schedule: ReportSchedule) => t(`reports.reportsList.schedules.${schedule}`); // i18n-dynamic
  const getFormatLabel = (format: ReportFormat) => t(`reports.reportsList.formats.${format}`); // i18n-dynamic
  const getStatusLabel = (status: ReportRun['status']) => t(`reports.reportsList.status.${status}`); // i18n-dynamic

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
          // The posture and executive-summary covers consume this snapshot to
          // render their designed cover pages; ignored by other report types.
          summary: data?.summary as PostureSummary | ExecutiveSummary | undefined,
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
                    <tr key={report.id} className="hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <FileText className="h-4 w-4 text-muted-foreground" />
                          <span className="font-medium">{report.name}</span>
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
                             the user, not a contract for when the run actually fires. */
                          <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                            <span>
                              {t('reports.reportsList.nextOccurrence', {
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
                          <button
                            type="button"
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
                            onClick={() => onEdit?.(report)}
                            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
                            title={t('reports.reportsList.actions.edit')}
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
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
                    <tr key={run.id} className="hover:bg-muted/30">
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
