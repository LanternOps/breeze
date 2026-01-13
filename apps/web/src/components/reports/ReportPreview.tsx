import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Download,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Table,
  BarChart3,
  Loader2,
  FileText
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ReportType } from './ReportsList';

type PreviewMode = 'table' | 'chart';

type ReportData = {
  type: ReportType;
  format: string;
  generatedAt: string;
  data: {
    rows?: Record<string, unknown>[];
    rowCount?: number;
    summary?: Record<string, unknown>;
    // For alerts summary
    bySeverity?: Record<string, number>;
    byStatus?: Record<string, number>;
    byDay?: { date: string; count: number }[];
    topRules?: { ruleId: string; ruleName: string; count: number }[];
    // For compliance
    overview?: Record<string, unknown>;
    byOsType?: { osType: string; count: number }[];
    agentVersions?: { version: string; count: number }[];
    issues?: { type: string; severity: string; count: number; message: string }[];
    // For metrics
    averages?: Record<string, number>;
    topCpu?: { deviceId: string; hostname: string; value: number }[];
    topRam?: { deviceId: string; hostname: string; value: number }[];
    topDisk?: { deviceId: string; hostname: string; value: number }[];
  };
};

type ReportPreviewProps = {
  data?: ReportData;
  loading?: boolean;
  error?: string;
  onRefresh?: () => void;
  onExport?: (format: 'csv' | 'pdf' | 'excel') => void;
};

const reportTypeLabels: Record<ReportType, string> = {
  device_inventory: 'Device Inventory',
  software_inventory: 'Software Inventory',
  alert_summary: 'Alert Summary',
  compliance: 'Compliance Report',
  performance: 'Performance Report',
  executive_summary: 'Executive Summary'
};

export default function ReportPreview({
  data,
  loading,
  error,
  onRefresh,
  onExport
}: ReportPreviewProps) {
  const [previewMode, setPreviewMode] = useState<PreviewMode>('table');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize] = useState(25);

  // Reset page when data changes
  useEffect(() => {
    setCurrentPage(1);
  }, [data]);

  // Extract rows from data
  const rows = useMemo(() => {
    if (!data?.data) return [];
    return data.data.rows || [];
  }, [data]);

  // Get columns from first row
  const columns = useMemo(() => {
    if (rows.length === 0) return [];
    return Object.keys(rows[0]);
  }, [rows]);

  // Paginated rows
  const paginatedRows = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return rows.slice(start, start + pageSize);
  }, [rows, currentPage, pageSize]);

  const totalPages = Math.ceil(rows.length / pageSize);

  // Format cell value for display
  const formatCellValue = (value: unknown): string => {
    if (value === null || value === undefined) return '-';
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (value instanceof Date) return value.toLocaleString();
    if (typeof value === 'string' && value.match(/^\d{4}-\d{2}-\d{2}/)) {
      return new Date(value).toLocaleString();
    }
    if (Array.isArray(value)) return value.join(', ');
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  };

  // Format column header
  const formatColumnHeader = (column: string): string => {
    return column
      .replace(/([A-Z])/g, ' $1')
      .replace(/_/g, ' ')
      .replace(/^./, str => str.toUpperCase())
      .trim();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">Generating report preview...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            className="mt-4 inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <RefreshCw className="h-4 w-4" />
            Try again
          </button>
        )}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-lg border border-dashed p-12 text-center">
        <FileText className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
        <h3 className="text-lg font-medium">No preview available</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Configure your report settings and click Preview to see the data.
        </p>
      </div>
    );
  }

  const hasChartData =
    data.type === 'alert_summary' ||
    data.type === 'compliance' ||
    data.type === 'performance' ||
    data.type === 'executive_summary';

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">{reportTypeLabels[data.type]}</h3>
          <p className="text-sm text-muted-foreground">
            Generated {new Date(data.generatedAt).toLocaleString()}
            {data.data.rowCount !== undefined && ` - ${data.data.rowCount} records`}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* View Mode Toggle */}
          {hasChartData && (
            <div className="flex rounded-md border">
              <button
                type="button"
                onClick={() => setPreviewMode('table')}
                className={cn(
                  'flex items-center gap-1 px-3 py-1.5 text-sm transition',
                  previewMode === 'table'
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-muted'
                )}
              >
                <Table className="h-4 w-4" />
                Table
              </button>
              <button
                type="button"
                onClick={() => setPreviewMode('chart')}
                className={cn(
                  'flex items-center gap-1 px-3 py-1.5 text-sm transition',
                  previewMode === 'chart'
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-muted'
                )}
              >
                <BarChart3 className="h-4 w-4" />
                Chart
              </button>
            </div>
          )}

          {/* Export Buttons */}
          {onExport && (
            <div className="flex rounded-md border">
              <button
                type="button"
                onClick={() => onExport('csv')}
                className="flex items-center gap-1 px-3 py-1.5 text-sm hover:bg-muted"
              >
                <Download className="h-4 w-4" />
                CSV
              </button>
              <button
                type="button"
                onClick={() => onExport('excel')}
                className="border-l px-3 py-1.5 text-sm hover:bg-muted"
              >
                Excel
              </button>
              <button
                type="button"
                onClick={() => onExport('pdf')}
                className="border-l px-3 py-1.5 text-sm hover:bg-muted"
              >
                PDF
              </button>
            </div>
          )}

          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              className="flex h-9 w-9 items-center justify-center rounded-md border hover:bg-muted"
              title="Refresh"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Summary Cards */}
      {data.data.summary && previewMode === 'table' && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Object.entries(data.data.summary).map(([key, value]) => (
            <div key={key} className="rounded-lg border bg-card p-4">
              <p className="text-sm text-muted-foreground">{formatColumnHeader(key)}</p>
              <p className="text-2xl font-bold mt-1">
                {typeof value === 'number' && key.toLowerCase().includes('rate')
                  ? `${value}%`
                  : formatCellValue(value)}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Table View */}
      {previewMode === 'table' && rows.length > 0 && (
        <>
          <div className="rounded-lg border bg-card shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b bg-muted/50">
                  <tr>
                    {columns.map(column => (
                      <th
                        key={column}
                        className="px-4 py-3 text-left text-sm font-medium text-muted-foreground whitespace-nowrap"
                      >
                        {formatColumnHeader(column)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {paginatedRows.map((row, index) => (
                    <tr key={index} className="hover:bg-muted/30">
                      {columns.map(column => (
                        <td
                          key={column}
                          className="px-4 py-3 text-sm whitespace-nowrap max-w-xs truncate"
                          title={formatCellValue(row[column])}
                        >
                          {formatCellValue(row[column])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Showing {(currentPage - 1) * pageSize + 1} to{' '}
                {Math.min(currentPage * pageSize, rows.length)} of {rows.length} records
              </p>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted disabled:opacity-50"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="px-3 text-sm">
                  Page {currentPage} of {totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted disabled:opacity-50"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Chart View */}
      {previewMode === 'chart' && hasChartData && (
        <div className="space-y-6">
          {/* Alert Summary Charts */}
          {data.type === 'alert_summary' && (
            <>
              {/* Severity Distribution */}
              {data.data.bySeverity && (
                <div className="rounded-lg border bg-card p-4">
                  <h4 className="text-sm font-semibold mb-4">Alerts by Severity</h4>
                  <div className="space-y-2">
                    {Object.entries(data.data.bySeverity).map(([severity, count]) => {
                      const total = Object.values(data.data.bySeverity!).reduce((a, b) => a + b, 0);
                      const percentage = total > 0 ? (count / total) * 100 : 0;
                      return (
                        <div key={severity} className="flex items-center gap-3">
                          <span className="w-20 text-sm capitalize">{severity}</span>
                          <div className="flex-1 h-4 bg-muted rounded-full overflow-hidden">
                            <div
                              className={cn(
                                'h-full rounded-full',
                                severity === 'critical' && 'bg-red-500',
                                severity === 'high' && 'bg-orange-500',
                                severity === 'medium' && 'bg-yellow-500',
                                severity === 'low' && 'bg-blue-500',
                                severity === 'info' && 'bg-gray-500'
                              )}
                              style={{ width: `${percentage}%` }}
                            />
                          </div>
                          <span className="w-12 text-sm text-right">{count}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Top Alert Rules */}
              {data.data.topRules && data.data.topRules.length > 0 && (
                <div className="rounded-lg border bg-card p-4">
                  <h4 className="text-sm font-semibold mb-4">Top Alerting Rules</h4>
                  <div className="space-y-2">
                    {data.data.topRules.map((rule, index) => (
                      <div key={rule.ruleId} className="flex items-center gap-3">
                        <span className="w-6 text-sm text-muted-foreground">{index + 1}.</span>
                        <span className="flex-1 text-sm truncate">{rule.ruleName}</span>
                        <span className="text-sm font-medium">{rule.count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {/* Compliance Charts */}
          {data.type === 'compliance' && (
            <>
              {data.data.overview && (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="rounded-lg border bg-card p-4 text-center">
                    <p className="text-sm text-muted-foreground">Compliance Score</p>
                    <p className="text-3xl font-bold text-primary mt-1">
                      {String((data.data.overview as Record<string, unknown>).complianceScore)}%
                    </p>
                  </div>
                  <div className="rounded-lg border bg-card p-4 text-center">
                    <p className="text-sm text-muted-foreground">Total Devices</p>
                    <p className="text-3xl font-bold mt-1">
                      {String((data.data.overview as Record<string, unknown>).totalDevices)}
                    </p>
                  </div>
                  <div className="rounded-lg border bg-card p-4 text-center">
                    <p className="text-sm text-muted-foreground">Online</p>
                    <p className="text-3xl font-bold text-success mt-1">
                      {String((data.data.overview as Record<string, unknown>).onlineDevices)}
                    </p>
                  </div>
                  <div className="rounded-lg border bg-card p-4 text-center">
                    <p className="text-sm text-muted-foreground">Offline</p>
                    <p className="text-3xl font-bold text-destructive mt-1">
                      {String((data.data.overview as Record<string, unknown>).offlineDevices)}
                    </p>
                  </div>
                </div>
              )}

              {data.data.issues && data.data.issues.length > 0 && (
                <div className="rounded-lg border bg-card p-4">
                  <h4 className="text-sm font-semibold mb-4">Compliance Issues</h4>
                  <div className="space-y-3">
                    {data.data.issues.map((issue, index) => (
                      <div
                        key={index}
                        className={cn(
                          'flex items-start gap-3 rounded-md border p-3',
                          issue.severity === 'warning' && 'border-yellow-500/40 bg-yellow-500/10',
                          issue.severity === 'info' && 'border-blue-500/40 bg-blue-500/10'
                        )}
                      >
                        <span className="text-sm font-medium">{issue.count}</span>
                        <span className="text-sm">{issue.message}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {/* Performance Charts */}
          {data.type === 'performance' && (
            <>
              {data.data.averages && (
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="rounded-lg border bg-card p-4 text-center">
                    <p className="text-sm text-muted-foreground">Avg CPU</p>
                    <p className="text-3xl font-bold mt-1">{data.data.averages.cpu}%</p>
                  </div>
                  <div className="rounded-lg border bg-card p-4 text-center">
                    <p className="text-sm text-muted-foreground">Avg Memory</p>
                    <p className="text-3xl font-bold mt-1">{data.data.averages.ram}%</p>
                  </div>
                  <div className="rounded-lg border bg-card p-4 text-center">
                    <p className="text-sm text-muted-foreground">Avg Disk</p>
                    <p className="text-3xl font-bold mt-1">{data.data.averages.disk}%</p>
                  </div>
                </div>
              )}

              {data.data.topCpu && data.data.topCpu.length > 0 && (
                <div className="rounded-lg border bg-card p-4">
                  <h4 className="text-sm font-semibold mb-4">Top CPU Consumers</h4>
                  <div className="space-y-2">
                    {data.data.topCpu.slice(0, 5).map((device, index) => (
                      <div key={device.deviceId} className="flex items-center gap-3">
                        <span className="w-6 text-sm text-muted-foreground">{index + 1}.</span>
                        <span className="flex-1 text-sm truncate">{device.hostname}</span>
                        <div className="w-24 h-2 bg-muted rounded-full overflow-hidden">
                          <div
                            className="h-full bg-primary rounded-full"
                            style={{ width: `${device.value}%` }}
                          />
                        </div>
                        <span className="w-12 text-sm text-right">{device.value}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Empty State */}
      {rows.length === 0 && previewMode === 'table' && (
        <div className="rounded-lg border border-dashed p-12 text-center">
          <p className="text-sm text-muted-foreground">No data matches the current filters.</p>
        </div>
      )}
    </div>
  );
}
