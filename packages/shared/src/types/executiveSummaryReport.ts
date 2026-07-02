/**
 * Canonical shape of the Executive Summary report's `summary` snapshot.
 * Single-sourced (API produces with `satisfies`, the shared PDF renderer
 * consumes) and persisted in report_runs.result, so all fields are optional —
 * a legacy snapshot must still render. Mirrors postureReport.ts.
 */
export type ExecutiveSummaryDevices = {
  total?: number;
  online?: number;
  offline?: number;
  /** Share of managed devices online, 0-100. */
  healthPercentage?: number;
};

export type ExecutiveSummaryAlerts = {
  total?: number;
  critical?: number;
  high?: number;
  resolved?: number;
  /** Share of window alerts resolved, 0-100. */
  resolutionRate?: number;
};

export type ExecutiveSummary = {
  org?: { id?: string; name?: string };
  devices?: ExecutiveSummaryDevices;
  alerts?: ExecutiveSummaryAlerts;
  osDistribution?: Record<string, number>;
  siteBreakdown?: Array<{ site: string; count: number }>;
};
