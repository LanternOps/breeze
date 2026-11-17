/**
 * Canonical shape of the Executive Summary report's `summary` snapshot.
 * Single-sourced (API produces with `satisfies`, the shared PDF renderer
 * consumes) and persisted in report_runs.result, so all fields are optional —
 * a legacy snapshot must still render. Mirrors postureReport.ts.
 */
export type ExecutiveSummaryDevices = {
  /** Managed devices (not decommissioned, not ephemeral, not parked). */
  total?: number;
  /** Devices whose status was `online` at generation. */
  online?: number;
  /** Devices whose status was `offline` at generation. */
  offline?: number;
  /**
   * Every other status a managed device held at generation (maintenance,
   * updating, quarantined, pending, ...), keyed by status, zero counts
   * omitted, so `online + offline + sum(otherStatuses) === total` (#12045).
   * Absent on snapshots written before #12045.
   */
  otherStatuses?: Record<string, number>;
  /**
   * Point-in-time share of managed devices online at generation, 0-100.
   * Kept for legacy readers and legacy snapshots; the headline score uses
   * `recentlySeenPercentage` when present (#12045).
   */
  healthPercentage?: number;
  /** Length of the "recently seen" window, in days, ending at generation. */
  recentWindowDays?: number;
  /** Managed devices online at generation or last seen inside the recent window. */
  recentlySeen?: number;
  /** `recentlySeen / total`, 0-100: the Executive Summary's headline score. */
  recentlySeenPercentage?: number;
};

export type ExecutiveSummaryAlerts = {
  total?: number;
  critical?: number;
  high?: number;
  resolved?: number;
  /** Share of window alerts resolved, 0-100. */
  resolutionRate?: number;
};

/**
 * The window the alert figures cover, as ISO instants. A null bound is open;
 * both null means no date range was configured, so every recorded alert
 * counts. Absent on snapshots written before #12045.
 */
export type ExecutiveSummaryPeriod = {
  start: string | null;
  end: string | null;
};

/** One critical/high alert raised in the window, named on the cover (#12045). */
export type ExecutiveSummaryNotableAlert = {
  title: string;
  severity: string;
  status: string;
  /** Hostname of the alert's device; null for a device-less (e.g. site-owned) alert. */
  device: string | null;
  /** ISO instant the alert was triggered. */
  triggeredAt: string;
};

export type ExecutiveSummary = {
  org?: { id?: string; name?: string };
  devices?: ExecutiveSummaryDevices;
  alerts?: ExecutiveSummaryAlerts;
  period?: ExecutiveSummaryPeriod;
  /** Critical/high alerts in the window: critical first, then most recent. */
  notableAlerts?: ExecutiveSummaryNotableAlert[];
  osDistribution?: Record<string, number>;
  siteBreakdown?: Array<{ site: string; count: number }>;
};
