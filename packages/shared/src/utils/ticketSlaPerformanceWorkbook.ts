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
import {
  TICKET_SLA_PERFORMANCE_ROW_CSV_LABELS,
  type TicketSlaBreachRow,
  type TicketSlaPerformanceSummary,
} from '../types/ticketSlaPerformance';
import type { XlsxSheet } from './xlsxExport';

/** Breach columns in output order; total over the row so a new field can't be left out of an empty sheet's header. */
const BREACH_COLUMNS: Record<keyof TicketSlaBreachRow, true> = {
  ticketId: true, ticketNumber: true, subject: true, priority: true, target: true, targetMinutes: true,
  createdAt: true, dueAt: true, completedAt: true, elapsedSlaMinutes: true, overByMinutes: true,
};

/** Priority rows re-keyed with the labels the CSV header uses (one label source). */
function labelPriorityRows(rows: readonly unknown[]): unknown[] {
  const labels: Readonly<Record<string, string>> = TICKET_SLA_PERFORMANCE_ROW_CSV_LABELS;
  return rows.map((row) => Object.fromEntries(
    Object.entries(row as Record<string, unknown>).map(([key, value]) => [labels[key] ?? key, value]),
  ));
}

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
    { name: 'Priorities', rows: labelPriorityRows(rows) },
    {
      name: 'Breaches',
      rows: breachRows,
      headers: Object.keys(BREACH_COLUMNS).filter((key) => summary.includeSubjects || key !== 'subject'),
    },
    { name: 'Notes', rows: [...truncation, ...summary.notes].map((note) => ({ note })) },
  ];
}
