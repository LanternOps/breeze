import { useState, useEffect, useCallback } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import ReportBuilder, { type ReportBuilderFormValues } from './ReportBuilder';
import type { Report, ReportType } from './ReportsList';

type ReportEditPageProps = {
  reportId: string;
};

export default function ReportEditPage({ reportId }: ReportEditPageProps) {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const fetchReport = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetch(`/api/reports/${reportId}`);
      if (!response.ok) {
        throw new Error('Failed to fetch report');
      }
      const data = await response.json();
      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [reportId]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  const handleSubmit = useCallback(async () => {
    // Report has been updated
    window.location.href = '/reports';
  }, []);

  const handleCancel = useCallback(() => {
    window.location.href = '/reports';
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">Loading report...</p>
        </div>
      </div>
    );
  }

  if (error || !report) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <a
            href="/reports"
            className="flex h-10 w-10 items-center justify-center rounded-md border hover:bg-muted"
          >
            <ArrowLeft className="h-4 w-4" />
          </a>
          <h1 className="text-2xl font-bold">Edit Report</h1>
        </div>

        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
          <p className="text-sm text-destructive">{error || 'Report not found'}</p>
          <a
            href="/reports"
            className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Back to Reports
          </a>
        </div>
      </div>
    );
  }

  // Convert report config to form values
  const config = report.config as Record<string, unknown>;
  const defaultValues: Partial<ReportBuilderFormValues> = {
    name: report.name,
    type: report.type as ReportType,
    schedule: report.schedule,
    format: report.format,
    dateRange: (config.dateRange as ReportBuilderFormValues['dateRange']) || {
      preset: 'last_30_days'
    },
    filters: (config.filters as ReportBuilderFormValues['filters']) || {}
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-4">
        <a
          href="/reports"
          className="flex h-10 w-10 items-center justify-center rounded-md border hover:bg-muted"
        >
          <ArrowLeft className="h-4 w-4" />
        </a>
        <div>
          <h1 className="text-2xl font-bold">Edit Report</h1>
          <p className="text-muted-foreground">
            Update the configuration for "{report.name}".
          </p>
        </div>
      </div>

      <ReportBuilder
        mode="edit"
        reportId={reportId}
        defaultValues={defaultValues}
        onSubmit={handleSubmit}
        onCancel={handleCancel}
      />
    </div>
  );
}
