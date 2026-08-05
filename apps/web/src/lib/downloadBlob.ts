/**
 * Trigger a browser file download from a Blob.
 *
 * Lives here rather than in `components/reports/reportExport.ts` for the same
 * reason `lib/csvExport.ts` does: that module pulls in the jsPDF-backed report
 * PDF builder, so a non-report exporter (e.g. the quote "to be ordered" CSV)
 * that only needs the download primitive would drag a PDF library into its
 * island bundle. `reportExport` re-exports this name for existing importers.
 */
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
