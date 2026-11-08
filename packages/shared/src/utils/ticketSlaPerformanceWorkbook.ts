/**
 * Sheets of the Ticket SLA performance Excel workbook (#11176, #11277).
 *
 * Shared so the two Excel paths build the same workbook: the web export from
 * the report preview and the API's stored-run download
 * (`GET /reports/runs/:id/download?format=excel`). Before #11277 only the web
 * path had it, and a stored run downloaded as a one-sheet "Report" of priority
 * rows with every breach missing.
 *
 * Returns sheets rather than bytes: callers pass them to `sheetsToXlsx` and
 * handle its `XlsxLimitError` the way they already handle `rowsToXlsx`.
 */
import type { TicketSlaPerformanceSummary } from '../types/ticketSlaPerformance';
import type { XlsxSheet } from './xlsxExport';

/** The priority rows, the breach list, then the report's notes, led by the
 *  truncation disclosure the PDF also prints. A report without subjects has no
 *  subject column at all, not an empty one. */
export function ticketSlaPerformanceSheets(
  rows: readonly unknown[],
  summary: TicketSlaPerformanceSummary,
): XlsxSheet[] {
  const { breaches } = summary;
  const breachRows = summary.includeSubjects
    ? breaches.rows
    : breaches.rows.map(({ subject: _subject, ...row }) => row);
  const truncation = breaches.truncated
    ? [`Breaches: showing ${breaches.rows.length} of ${breaches.available}. The stored report keeps at most ${breaches.cap}; totals count all of them.`]
    : [];
  return [
    { name: 'Priorities', rows },
    { name: 'Breaches', rows: breachRows },
    { name: 'Notes', rows: [...truncation, ...summary.notes].map((note) => ({ note })) },
  ];
}
