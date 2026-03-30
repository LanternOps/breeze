import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

/** Convert an unknown cell value to a display string. */
function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

/** Extract column headers and string[][] body from raw row objects. */
function extractTable(rows: unknown[]): { headers: string[]; body: string[][] } {
  const headers = Object.keys(rows[0] as Record<string, unknown>);
  const body = rows.map(row => {
    const record = row as Record<string, unknown>;
    return headers.map(h => cellToString(record[h]));
  });
  return { headers, body };
}

/** Trigger a browser file download from a Blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** Return the browser's IANA timezone string. */
export function getBrowserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Export report rows as CSV, Excel (TSV with .xls extension), or PDF.
 *
 * Throws if rows is empty for CSV/Excel formats.
 */
export function exportReport(
  rows: unknown[],
  opts: {
    format: 'csv' | 'pdf' | 'excel';
    reportType: string;
    timezone: string;
  }
): void {
  const { format, reportType, timezone } = opts;
  const dateStr = new Date().toISOString().split('T')[0];
  const baseFilename = `${reportType}-report-${dateStr}`;

  if (format === 'csv') {
    if (rows.length === 0) throw new Error('No data to export');
    const { headers, body } = extractTable(rows);
    const csvContent = [
      headers.join(','),
      ...body.map(row =>
        row.map(cell =>
          cell.includes(',') || cell.includes('"') || cell.includes('\n') || cell.includes('\r')
            ? `"${cell.replace(/"/g, '""')}"`
            : cell
        ).join(',')
      ),
    ].join('\n');
    downloadBlob(new Blob([csvContent], { type: 'text/csv;charset=utf-8;' }), `${baseFilename}.csv`);
    return;
  }

  if (format === 'excel') {
    if (rows.length === 0) throw new Error('No data to export');
    const { headers, body } = extractTable(rows);
    const tsvContent = [
      headers.join('\t'),
      ...body.map(row => row.join('\t')),
    ].join('\n');
    downloadBlob(new Blob([tsvContent], { type: 'application/vnd.ms-excel' }), `${baseFilename}.xls`);
    return;
  }

  if (format !== 'pdf') {
    throw new Error(`Unsupported report format: ${format}`);
  }

  // PDF
  const title = reportType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const generatedAt = new Date().toLocaleString([], { timeZone: timezone });

  const doc = new jsPDF({ orientation: 'landscape' });
  doc.setFontSize(18);
  doc.text(`${title} Report`, 14, 20);
  doc.setFontSize(10);
  doc.setTextColor(100);
  doc.text(`Generated: ${generatedAt}`, 14, 28);

  if (rows.length > 0) {
    const { headers, body } = extractTable(rows);
    autoTable(doc, {
      startY: 34,
      head: [headers],
      body,
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [41, 128, 185], textColor: 255 },
      alternateRowStyles: { fillColor: [245, 245, 245] },
    });
  } else {
    doc.setTextColor(0);
    doc.setFontSize(12);
    doc.text('No data available', 14, 40);
  }

  downloadBlob(doc.output('blob'), `${baseFilename}.pdf`);
}
