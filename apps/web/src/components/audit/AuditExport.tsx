import { useMemo, useState } from 'react';
import { Download, FileJson2, FileSpreadsheet, Info } from 'lucide-react';
import { cn } from '@/lib/utils';

type AuditExportProps = {
  rangeLabel?: string;
  onExport?: (format: 'csv' | 'json') => void;
};

const columnOptions = [
  { id: 'timestamp', label: 'Timestamp' },
  { id: 'user', label: 'User' },
  { id: 'action', label: 'Action' },
  { id: 'resource', label: 'Resource' },
  { id: 'details', label: 'Details' },
  { id: 'ipAddress', label: 'IP Address' }
];

const mockExportRows = [
  {
    timestamp: '2024-05-28 14:12',
    user: 'Ariana Fields',
    action: 'login',
    resource: 'Admin Portal',
    details: 'Successful login with MFA challenge passed.',
    ipAddress: '174.20.31.10',
    changes: { before: { mfa: false }, after: { mfa: true } }
  },
  {
    timestamp: '2024-05-28 13:46',
    user: 'Ariana Fields',
    action: 'update',
    resource: 'Endpoint Policy - West Region',
    details: 'Updated USB access policy to read-only.',
    ipAddress: '174.20.31.10',
    changes: { before: { usbAccess: 'disabled' }, after: { usbAccess: 'read-only' } }
  },
  {
    timestamp: '2024-05-27 21:28',
    user: 'Priya Nair',
    action: 'export',
    resource: 'Alerts Report',
    details: 'Exported alert data to CSV.',
    ipAddress: '172.16.11.90',
    changes: { before: { format: 'none' }, after: { format: 'csv' } }
  }
];

const formatLabels: Record<'csv' | 'json', string> = {
  csv: 'CSV',
  json: 'JSON'
};

const formatIcons: Record<'csv' | 'json', JSX.Element> = {
  csv: <FileSpreadsheet className="h-4 w-4" />,
  json: <FileJson2 className="h-4 w-4" />
};

const toCsv = (rows: Record<string, unknown>[], columns: string[]) => {
  const header = columns.join(',');
  const body = rows
    .map(row =>
      columns
        .map(key => {
          const value = row[key];
          if (typeof value === 'string') {
            return `"${value.replace(/"/g, '""')}"`;
          }
          return `${value ?? ''}`;
        })
        .join(',')
    )
    .join('\n');
  return `${header}\n${body}`;
};

const downloadFile = (content: string, filename: string, type: string) => {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};

export default function AuditExport({ rangeLabel = 'Last 30 days', onExport }: AuditExportProps) {
  const [format, setFormat] = useState<'csv' | 'json'>('csv');
  const [selectedColumns, setSelectedColumns] = useState<string[]>(
    columnOptions.map(option => option.id)
  );
  const [includeDetails, setIncludeDetails] = useState(true);

  const effectiveColumns = useMemo(() => {
    if (includeDetails) return selectedColumns;
    return selectedColumns.filter(column => column !== 'details');
  }, [includeDetails, selectedColumns]);

  const handleColumnToggle = (columnId: string) => {
    setSelectedColumns(prev => {
      if (prev.includes(columnId)) {
        return prev.filter(column => column !== columnId);
      }
      return [...prev, columnId];
    });
  };

  const handleExport = () => {
    const rows = mockExportRows.map(row => {
      const base: Record<string, unknown> = {};
      effectiveColumns.forEach(column => {
        base[column] = row[column];
      });
      if (includeDetails) {
        base.changes = row.changes;
      }
      return base;
    });

    if (format === 'json') {
      downloadFile(JSON.stringify(rows, null, 2), 'audit-log-export.json', 'application/json');
    } else {
      downloadFile(toCsv(rows, effectiveColumns), 'audit-log-export.csv', 'text/csv');
    }
    onExport?.(format);
  };

  return (
    <div className="space-y-6 rounded-lg border bg-card p-6">
      <div>
        <h2 className="text-lg font-semibold">Export Audit Logs</h2>
        <p className="text-sm text-muted-foreground">
          Download entries using the current filters and columns.
        </p>
      </div>

      <div className="rounded-md border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
        <div className="flex items-center gap-2 font-medium text-foreground">
          <Info className="h-4 w-4 text-muted-foreground" />
          Date Range
        </div>
        <p className="mt-1 text-sm">{rangeLabel}</p>
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-semibold">Format</h3>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(formatLabels) as Array<'csv' | 'json'>).map(option => (
            <button
              key={option}
              type="button"
              onClick={() => setFormat(option)}
              className={cn(
                'inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium',
                format === option
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {formatIcons[option]}
              {formatLabels[option]}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Columns</h3>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={includeDetails}
              onChange={event => setIncludeDetails(event.target.checked)}
              className="h-4 w-4 rounded border-muted text-primary"
            />
            Include details & changes
          </label>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {columnOptions.map(column => (
            <label
              key={column.id}
              className={cn(
                'flex items-center justify-between rounded-md border px-3 py-2 text-sm',
                !includeDetails && column.id === 'details' && 'opacity-50'
              )}
            >
              <span>{column.label}</span>
              <input
                type="checkbox"
                checked={selectedColumns.includes(column.id)}
                onChange={() => handleColumnToggle(column.id)}
                disabled={!includeDetails && column.id === 'details'}
                className="h-4 w-4 rounded border-muted text-primary"
              />
            </label>
          ))}
        </div>
      </div>

      <button
        type="button"
        onClick={handleExport}
        className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
      >
        <Download className="h-4 w-4" />
        Export {format.toUpperCase()}
      </button>
    </div>
  );
}
