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
  Loader2
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';

export type ReportType =
  | 'device_inventory'
  | 'software_inventory'
  | 'alert_summary'
  | 'compliance'
  | 'performance'
  | 'executive_summary';

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
};

const reportTypeLabels: Record<ReportType, string> = {
  device_inventory: 'Device Inventory',
  software_inventory: 'Software Inventory',
  alert_summary: 'Alert Summary',
  compliance: 'Compliance Report',
  performance: 'Performance Report',
  executive_summary: 'Executive Summary'
};

const scheduleLabels: Record<ReportSchedule, string> = {
  one_time: 'One-time',
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly'
};

const formatLabels: Record<ReportFormat, string> = {
  csv: 'CSV',
  pdf: 'PDF',
  excel: 'Excel'
};

export default function ReportsList({ onEdit, onGenerate, onDelete }: ReportsListProps) {
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
        throw new Error('Failed to fetch reports');
      }
      const data = await response.json();
      setReports(data.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchRecentRuns = useCallback(async () => {
    try {
      const response = await fetchWithAuth('/reports/runs?limit=20');
      if (response.ok) {
        const data = await response.json();
        setRecentRuns(data.data ?? []);
      }
    } catch {
      // Silently fail
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
        throw new Error('Failed to generate report');
      }

      onGenerate?.(report);
      // Refresh runs after a short delay
      setTimeout(fetchRecentRuns, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate report');
    } finally {
      setGeneratingIds(prev => {
        const next = new Set(prev);
        next.delete(report.id);
        return next;
      });
    }
  };

  const handleDelete = async (report: Report) => {
    if (!confirm(`Are you sure you want to delete "${report.name}"?`)) {
      return;
    }

    setDeletingId(report.id);
    try {
      const response = await fetchWithAuth(`/reports/${report.id}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error('Failed to delete report');
      }

      onDelete?.(report);
      fetchReports();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete report');
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

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return 'Never';
    return new Date(dateStr).toLocaleString();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">Loading reports...</p>
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
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Reports</h1>
          <p className="text-muted-foreground">Generate and schedule reports for your infrastructure.</p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href="/reports/builder"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted"
          >
            <FileText className="h-4 w-4" />
            Ad-hoc Report
          </a>
          <a
            href="/reports/new"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            New Report
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
            Saved Reports
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
            Recent Runs
          </button>
        </div>
      </div>

      {activeTab === 'reports' && (
        <>
          {reports.length === 0 ? (
            <div className="rounded-lg border border-dashed p-12 text-center">
              <FileText className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-medium">No reports yet</h3>
              <p className="text-sm text-muted-foreground mt-1">
                Create your first report to get started.
              </p>
              <a
                href="/reports/new"
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 mt-4"
              >
                <Plus className="h-4 w-4" />
                Create Report
              </a>
            </div>
          ) : (
            <div className="rounded-lg border bg-card shadow-sm overflow-hidden">
              <table className="w-full">
                <thead className="border-b bg-muted/50">
                  <tr>
                    <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                      Name
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                      Type
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                      Schedule
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                      Format
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                      Last Generated
                    </th>
                    <th className="px-4 py-3 text-right text-sm font-medium text-muted-foreground">
                      Actions
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
                        {reportTypeLabels[report.type]}
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
                          {scheduleLabels[report.schedule]}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {formatLabels[report.format]}
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
                            title="Generate now"
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
                            title="Edit"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDelete(report)}
                            disabled={deletingId === report.id}
                            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted text-destructive disabled:opacity-50"
                            title="Delete"
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
              <h3 className="text-lg font-medium">No recent runs</h3>
              <p className="text-sm text-muted-foreground mt-1">
                Generate a report to see it here.
              </p>
            </div>
          ) : (
            <div className="rounded-lg border bg-card shadow-sm overflow-hidden">
              <table className="w-full">
                <thead className="border-b bg-muted/50">
                  <tr>
                    <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                      Report
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                      Status
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                      Started
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">
                      Completed
                    </th>
                    <th className="px-4 py-3 text-right text-sm font-medium text-muted-foreground">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {recentRuns.map(run => (
                    <tr key={run.id} className="hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <div>
                          <span className="font-medium">{run.reportName || 'Unknown Report'}</span>
                          {run.reportType && (
                            <p className="text-xs text-muted-foreground">
                              {reportTypeLabels[run.reportType]}
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
                            {run.status}
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
                          {run.status === 'completed' && run.outputUrl && (
                            <a
                              href={run.outputUrl}
                              className="flex h-8 items-center gap-1 rounded-md border px-3 text-sm hover:bg-muted"
                            >
                              <Download className="h-4 w-4" />
                              Download
                            </a>
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
