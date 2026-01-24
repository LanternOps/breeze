import { useState, useCallback } from 'react';
import { ArrowLeft, FileText } from 'lucide-react';
import ReportBuilder, { type ReportBuilderFormValues } from './ReportBuilder';
import ReportPreview from './ReportPreview';
import type { ReportType } from './ReportsList';
import { fetchWithAuth } from '../../stores/auth';

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
      const response = await fetchWithAuth('/reports/generate', {
        method: 'POST',
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

    try {
      // Get report data for export
      const rows = (previewData.data as { rows?: unknown[] })?.rows ?? [];

      if (format === 'csv') {
        // Convert data to CSV format
        if (rows.length === 0) {
          throw new Error('No data to export');
        }

        const headers = Object.keys(rows[0] as Record<string, unknown>);
        const csvContent = [
          headers.join(','),
          ...rows.map(row => {
            const record = row as Record<string, unknown>;
            return headers.map(header => {
              const value = record[header];
              // Escape values containing commas or quotes
              const stringValue = value === null || value === undefined ? '' : String(value);
              return stringValue.includes(',') || stringValue.includes('"')
                ? `"${stringValue.replace(/"/g, '""')}"`
                : stringValue;
            }).join(',');
          })
        ].join('\n');

        // Create blob and download
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${previewData.type}-report-${new Date().toISOString().split('T')[0]}.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      } else if (format === 'excel') {
        // For Excel, we'll export as CSV with .xls extension (basic compatibility)
        if (rows.length === 0) {
          throw new Error('No data to export');
        }

        const headers = Object.keys(rows[0] as Record<string, unknown>);
        const csvContent = [
          headers.join('\t'),
          ...rows.map(row => {
            const record = row as Record<string, unknown>;
            return headers.map(header => {
              const value = record[header];
              return value === null || value === undefined ? '' : String(value);
            }).join('\t');
          })
        ].join('\n');

        const blob = new Blob([csvContent], { type: 'application/vnd.ms-excel' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${previewData.type}-report-${new Date().toISOString().split('T')[0]}.xls`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      } else if (format === 'pdf') {
        // PDF export - generate HTML content and open print dialog
        const reportTitle = previewData.type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const generatedAt = new Date().toLocaleString();

        let tableHtml = '<p>No data available</p>';
        if (rows.length > 0) {
          const headers = Object.keys(rows[0] as Record<string, unknown>);
          const headerRow = headers.map(h => `<th>${h}</th>`).join('');
          const bodyRows = rows.map(row => {
            const record = row as Record<string, unknown>;
            return `<tr>${Object.values(record).map(v => `<td>${v ?? ''}</td>`).join('')}</tr>`;
          }).join('');
          tableHtml = `<table><thead><tr>${headerRow}</tr></thead><tbody>${bodyRows}</tbody></table>`;
        }

        const htmlContent = `<!DOCTYPE html><html><head><title>${reportTitle} Report</title><style>body{font-family:system-ui,sans-serif;padding:20px}h1{font-size:18px;margin-bottom:10px}p{color:#666;font-size:12px;margin-bottom:20px}table{width:100%;border-collapse:collapse;font-size:11px}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background-color:#f5f5f5;font-weight:600}tr:nth-child(even){background-color:#fafafa}</style></head><body><h1>${reportTitle} Report</h1><p>Generated: ${generatedAt}</p>${tableHtml}</body></html>`;

        // Create blob URL and open in new window for printing
        const blob = new Blob([htmlContent], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const printWindow = window.open(url, '_blank');
        if (printWindow) {
          printWindow.onload = () => {
            printWindow.print();
            URL.revokeObjectURL(url);
          };
        }
      }
    } catch (err) {
      console.error('Export failed:', err);
    }
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
