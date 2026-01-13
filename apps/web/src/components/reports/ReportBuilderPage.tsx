import { useState, useCallback } from 'react';
import { ArrowLeft, FileText } from 'lucide-react';
import ReportBuilder, { type ReportBuilderFormValues } from './ReportBuilder';
import ReportPreview from './ReportPreview';
import type { ReportType } from './ReportsList';

type ReportData = {
  type: ReportType;
  format: string;
  generatedAt: string;
  data: Record<string, unknown>;
};

export default function ReportBuilderPage() {
  const [previewData, setPreviewData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const handlePreview = useCallback(async (values: ReportBuilderFormValues) => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetch('/api/reports/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: values.type,
          config: {
            dateRange: values.dateRange,
            filters: values.filters
          },
          format: values.format
        })
      });

      if (!response.ok) {
        throw new Error('Failed to generate report preview');
      }

      const data = await response.json();
      setPreviewData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate preview');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSubmit = useCallback(async (values: ReportBuilderFormValues) => {
    // For ad-hoc mode, generate and show the result
    await handlePreview(values);
  }, [handlePreview]);

  const handleExport = useCallback(async (format: 'csv' | 'pdf' | 'excel') => {
    if (!previewData) return;

    // In a real implementation, this would trigger a download
    // For now, we'll just show an alert
    alert(`Export to ${format.toUpperCase()} would be triggered here.`);
  }, [previewData]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <a
          href="/reports"
          className="flex h-10 w-10 items-center justify-center rounded-md border hover:bg-muted"
        >
          <ArrowLeft className="h-4 w-4" />
        </a>
        <div>
          <h1 className="text-2xl font-bold">Ad-hoc Report Builder</h1>
          <p className="text-muted-foreground">
            Generate a one-time report without saving it.
          </p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Builder Section */}
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-6">
            <FileText className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-lg font-semibold">Report Configuration</h2>
          </div>

          <ReportBuilder
            mode="adhoc"
            onSubmit={handleSubmit}
            onPreview={handlePreview}
          />
        </div>

        {/* Preview Section */}
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <ReportPreview
            data={previewData ?? undefined}
            loading={loading}
            error={error}
            onRefresh={() => {
              if (previewData) {
                // Re-fetch with same parameters
                handlePreview({
                  type: previewData.type,
                  dateRange: { preset: 'last_30_days' },
                  filters: {},
                  schedule: 'one_time',
                  format: previewData.format as 'csv' | 'pdf' | 'excel'
                });
              }
            }}
            onExport={handleExport}
          />
        </div>
      </div>
    </div>
  );
}
