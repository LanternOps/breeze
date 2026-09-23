/**
 * Metric anomaly episodes (spec docs/superpowers/specs/monitoring/
 * 2026-09-21-metric-anomaly-episodes-design.md).
 *
 * Three grouping grains exist and are NOT interchangeable:
 *  - metric_anomalies           one row per 5-minute bucket per metric (evidence)
 *  - metric_anomaly_incidents   AI-dispatch outbox, one row per bucket per anomaly type
 *  - metric_anomaly_episodes    the lifecycle a technician sees (one card per event)
 */

/** Per-bucket row status. `cleared` = closed by episode auto-resolve, never a human label. */
export const METRIC_ANOMALY_STATUSES = ['open', 'dismissed', 'promoted', 'resolved', 'cleared'] as const;
export type MetricAnomalyStatus = (typeof METRIC_ANOMALY_STATUSES)[number];

/** Promotion is a link (`linkedAlertId`), not a status (D6). */
export const METRIC_ANOMALY_EPISODE_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export type MetricAnomalyEpisodeStatus = (typeof METRIC_ANOMALY_EPISODE_STATUSES)[number];

/** `detection_off` = closed because ml.anomalies.enabled was turned off for the org (A5) — automatic, never a human label. */
export const EPISODE_CLOSE_REASONS = ['cleared', 'expired_offline', 'expired_no_data', 'detection_off', 'user', 'snoozed'] as const;
export type EpisodeCloseReason = (typeof EPISODE_CLOSE_REASONS)[number];

/** Keys of the agent's TopProcess JSON (`apps/api/src/db/schema/devices.ts` TopProcess). */
export const ATTRIBUTION_DIMENSIONS = ['cpu', 'ramMb', 'diskBps', 'netBps'] as const;
export type AttributionDimension = (typeof ATTRIBUTION_DIMENSIONS)[number];

export interface AttributionProcess {
  name: string;
  pid: number;
  value: number;
}

export interface AttributionSnapshot {
  /** ISO-8601 UTC time of the device_process_samples row used. */
  sampledAt: string;
  dimension: AttributionDimension;
  /** Top 3 by `dimension`; empty when the agent omitted the dimension (diskBps/netBps are omitempty). */
  processes: AttributionProcess[];
}

/** `opened` is written once; `peak` is overwritten whenever the peak grows (§9). */
export interface EpisodeAttribution {
  opened?: AttributionSnapshot;
  peak?: AttributionSnapshot;
}
