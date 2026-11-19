import { rowsToCsv } from './csvExport';
import { POSTURE_DEVICE_ROW_CSV_LABELS } from '../types/postureReport';
import { TICKET_SLA_PERFORMANCE_ROW_CSV_LABELS } from '../types/ticketSlaPerformance';

/**
 * Customer-facing header labels per report type (#9964). A type without an
 * entry keeps its row keys as the header.
 */
const REPORT_RUN_CSV_HEADER_LABELS: Partial<Record<string, Readonly<Record<string, string>>>> = {
  security_compliance_posture: POSTURE_DEVICE_ROW_CSV_LABELS,
  ticket_sla_performance: TICKET_SLA_PERFORMANCE_ROW_CSV_LABELS,
};

/**
 * The one CSV serializer for a completed report run's rows. The portal download
 * and the staff download both call it, so the two CSVs of one run cannot drift
 * apart (#11282).
 */
export function reportRunRowsToCsv(reportType: string | null | undefined, rows: unknown[]): string {
  const headerLabels = reportType ? REPORT_RUN_CSV_HEADER_LABELS[reportType] : undefined;
  return rowsToCsv(rows, { headerLabels });
}
