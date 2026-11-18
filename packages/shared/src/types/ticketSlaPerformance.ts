import type { ReportPeriodKind } from './businessReports';

/**
 * Contract between the `ticket_sla_performance` generator
 * (apps/api/src/services/businessReports/ticketSlaPerformanceReport.ts), its PDF
 * renderer and the web preview and export (#11018). Customer-safe by
 * construction: no assignee, no internal number, no sweep-stamp discrepancy.
 */

export type SlaPriority = 'urgent' | 'high' | 'normal' | 'low';
export type SlaTargetKind = 'response' | 'resolution';
export type SlaTargetSummary = { minutes: number | null; varies: boolean };

/** Output order everywhere; every priority is always present. */
export const SLA_PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const satisfies readonly SlaPriority[];

/** Breach rows stored in `summary.breaches`. Aggregates ignore this cap. */
export const TICKET_SLA_BREACH_CAP = 1000;

/** One flat row per priority: summary.priorities, result.rows and the CSV are the same objects. */
export type TicketSlaPerformanceRow = {
  priority: SlaPriority | 'all';
  ticketsOpened: number;
  ticketsWithoutTarget: number;
  responseTargetMinutes: number | null;
  responseTargetVaries: boolean;
  responseMeasured: number;
  responseMet: number;
  responseMissed: number;
  responseMissedOpen: number;
  responseAttainment: number | null;
  responseMedianMinutes: number | null;
  responseMeanMinutes: number | null;
  responseTimedSample: number;
  resolutionTargetMinutes: number | null;
  resolutionTargetVaries: boolean;
  resolutionMeasured: number;
  resolutionMet: number;
  resolutionMissed: number;
  resolutionMissedOpen: number;
  resolutionAttainment: number | null;
  resolutionMedianMinutes: number | null;
  resolutionMeanMinutes: number | null;
  resolutionTimedSample: number;
};

/**
 * Column headers for the customer's portal CSV (#11018). Total over the row so a
 * new column can't ship as a raw camelCase header. Attainment stays a ratio in
 * the cell, so the header says so.
 */
export const TICKET_SLA_PERFORMANCE_ROW_CSV_LABELS = {
  priority: 'Priority',
  ticketsOpened: 'Tickets opened',
  ticketsWithoutTarget: 'Tickets without a target',
  responseTargetMinutes: 'Response target (minutes)',
  responseTargetVaries: 'Response target varies',
  responseMeasured: 'Responses measured',
  responseMet: 'Responses within SLA',
  responseMissed: 'Responses missed',
  responseMissedOpen: 'Responses missed and still open',
  responseAttainment: 'Response within SLA (0-1)',
  responseMedianMinutes: 'Median response (minutes)',
  responseMeanMinutes: 'Mean response (minutes)',
  responseTimedSample: 'Responses timed',
  resolutionTargetMinutes: 'Resolution target (minutes)',
  resolutionTargetVaries: 'Resolution target varies',
  resolutionMeasured: 'Resolutions measured',
  resolutionMet: 'Resolutions within SLA',
  resolutionMissed: 'Resolutions missed',
  resolutionMissedOpen: 'Resolutions missed and still open',
  resolutionAttainment: 'Resolution within SLA (0-1)',
  resolutionMedianMinutes: 'Median resolution (minutes)',
  resolutionMeanMinutes: 'Mean resolution (minutes)',
  resolutionTimedSample: 'Resolutions timed',
} as const satisfies Record<keyof TicketSlaPerformanceRow, string>;

export type TicketSlaBreachRow = {
  ticketId: string;
  ticketNumber: string;
  /** Null unless the definition opted in with `includeSubjects`. */
  subject: string | null;
  priority: SlaPriority;
  target: SlaTargetKind;
  targetMinutes: number;
  createdAt: string;
  dueAt: string;
  completedAt: string | null;
  /** Null when still open, or when the ticket's calendar could not be read. */
  elapsedSlaMinutes: number | null;
  overByMinutes: number | null;
};

export type TicketSlaPerformanceSummary = {
  generatedAt: string;
  /** Empty strings in an unmeasured (site-restricted) summary, as in the staff report. */
  period: {
    kind: ReportPeriodKind;
    start: string;
    end: string;
    label: string;
    timeZone: string;
    /** min(period.end, generatedAt): no outcome after this instant is counted. */
    measuredThrough: string;
  };
  org: { orgId: string; orgName: string | null } | null;
  /** Priority 'all'. */
  overall: TicketSlaPerformanceRow;
  /** Always four, urgent→low. */
  priorities: TicketSlaPerformanceRow[];
  breaches: {
    cap: number;
    stored: number;
    available: number;
    truncated: boolean;
    rows: TicketSlaBreachRow[];
  };
  /** Outcomes counted for attainment but untimed because their calendar could not be read. */
  unmeasuredDurations: number;
  includeSubjects: boolean;
  notes: string[];
  /** The same array as `priorities`. */
  rows: TicketSlaPerformanceRow[];
};

export function zeroTicketSlaPerformanceRow(priority: TicketSlaPerformanceRow['priority']): TicketSlaPerformanceRow {
  return {
    priority,
    ticketsOpened: 0,
    ticketsWithoutTarget: 0,
    responseTargetMinutes: null,
    responseTargetVaries: false,
    responseMeasured: 0,
    responseMet: 0,
    responseMissed: 0,
    responseMissedOpen: 0,
    responseAttainment: null,
    responseMedianMinutes: null,
    responseMeanMinutes: null,
    responseTimedSample: 0,
    resolutionTargetMinutes: null,
    resolutionTargetVaries: false,
    resolutionMeasured: 0,
    resolutionMet: 0,
    resolutionMissed: 0,
    resolutionMissedOpen: 0,
    resolutionAttainment: null,
    resolutionMedianMinutes: null,
    resolutionMeanMinutes: null,
    resolutionTimedSample: 0,
  };
}

/** `59 min`, `2h 05m`, or an em dash for an unmeasured duration (never 0). */
export function formatSlaMinutes(minutes: number | null): string {
  if (minutes === null) return '—';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** The summary of a report that measured nothing; `note` says why. */
export function emptyTicketSlaPerformanceSummary(note: string): TicketSlaPerformanceSummary {
  const priorities = SLA_PRIORITIES.map(zeroTicketSlaPerformanceRow);
  return {
    generatedAt: new Date().toISOString(),
    period: { kind: 'custom', start: '', end: '', label: '', timeZone: 'UTC', measuredThrough: '' },
    org: null,
    overall: zeroTicketSlaPerformanceRow('all'),
    priorities,
    breaches: { cap: TICKET_SLA_BREACH_CAP, stored: 0, available: 0, truncated: false, rows: [] },
    unmeasuredDurations: 0,
    includeSubjects: false,
    notes: [note],
    rows: priorities,
  };
}

/** Shape guard for a stored summary reaching the PDF, the email or the preview. */
export function isTicketSlaPerformanceSummary(value: unknown): value is TicketSlaPerformanceSummary {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Partial<Record<keyof TicketSlaPerformanceSummary, unknown>>;
  const isObject = (v: unknown) => typeof v === 'object' && v !== null;
  return isObject(s.period)
    && isObject(s.overall)
    && Array.isArray(s.priorities)
    && isObject(s.breaches)
    && Array.isArray((s.breaches as { rows?: unknown }).rows)
    && Array.isArray(s.notes);
}
