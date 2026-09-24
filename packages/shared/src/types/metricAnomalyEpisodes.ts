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

// ── W02: episode API surface (spec §8.1, §12) ─────────────────────────────

export const EPISODE_ACTIONS = ['resolve', 'dismiss', 'promote', 'unsnooze'] as const;
export type EpisodeAction = (typeof EPISODE_ACTIONS)[number];

export const EPISODE_LIST_STATUSES = ['open', 'closed', 'all'] as const;
export type EpisodeListStatus = (typeof EPISODE_LIST_STATUSES)[number];

/** Spec §12: the detail endpoint returns at most this many members. */
export const EPISODE_DETAIL_MEMBER_LIMIT = 200;

/**
 * Spec §12 serialization: every §4.1 column in camelCase (timestamps as ISO
 * strings) plus derived fields. `rangeMin`/`rangeMax` are min/max observedValue
 * over members whose metric_name equals `peakMetricName` — the ram/cpu families
 * mix `_sum` and `_max` members and a range across both is meaningless.
 */
export interface MetricAnomalyEpisodeDto {
  id: string;
  orgId: string;
  deviceId: string;
  episodeKey: string;
  sourceTable: string;
  anomalyType: string;
  metricFamily: string;
  metricNames: string[];
  status: MetricAnomalyEpisodeStatus;
  closeReason: EpisodeCloseReason | null;
  firstSeenAt: string;
  lastSeenAt: string;
  bucketCount: number;
  peakValue: number;
  peakMetricName: string;
  peakBaselineValue: number | null;
  peakScore: number;
  peakAt: string;
  recurrenceCount: number;
  attribution: EpisodeAttribution | null;
  linkedAlertId: string | null;
  snoozedUntil: string | null;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  durationSeconds: number;
  ongoing: boolean;
  promoted: boolean;
  snoozed: boolean;
  rangeMin: number | null;
  rangeMax: number | null;
  /**
   * Highest-score member (score DESC, window_start ASC — W01's peak rule).
   * The web card keys remediation suggestions on it (`sourceType: 'anomaly'`,
   * which is keyed by metric_anomalies.id, never an episode id).
   */
  peakAnomalyId: string | null;
  /**
   * `devices.last_seen_at` of the episode's device (ISO), for the web card's
   * "expired: device not seen since …" chip (second quorum A9). NULL when the
   * device never checked in.
   */
  deviceLastSeenAt: string | null;
}

export interface MetricAnomalyEpisodeMemberDto {
  id: string;
  metricName: string;
  anomalyType: string;
  status: MetricAnomalyStatus;
  windowStart: string;
  windowEnd: string;
  observedValue: number;
  baselineValue: number | null;
  baselineMax: number | null;
  score: number;
  confidence: number;
  linkedAlertId: string | null;
}

export interface MetricAnomalyEpisodeDetailDto extends MetricAnomalyEpisodeDto {
  members: MetricAnomalyEpisodeMemberDto[];
  /** true when the episode has more than EPISODE_DETAIL_MEMBER_LIMIT members. */
  membersTruncated: boolean;
}

export interface MetricAnomalyEpisodeListResponse {
  data: MetricAnomalyEpisodeDto[];
  /** The episode a `ref` resolved to (always data[0] when non-null). */
  focusedEpisodeId: string | null;
}
