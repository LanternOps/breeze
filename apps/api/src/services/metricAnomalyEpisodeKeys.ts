import type { AttributionDimension } from '@breeze/shared';

/**
 * Metric anomaly episodes — constants and the episode key map (spec §4.2, §5).
 *
 * A LEAF module (no db, no services) so the pure planner and its tests can
 * import it without a database. `services/metricAnomalyEpisodes.ts` re-exports
 * everything here; that is the path the cross-wave contract names.
 */

export function parseEpisodeEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== raw.trim()) {
    console.warn(`[MetricAnomalyEpisodes] Invalid ${name}="${raw}", using default ${fallback}`);
    return fallback;
  }
  return parsed;
}

/** Max gap (end of one anomalous bucket to start of the next) inside one episode. */
export const EPISODE_GAP_MINUTES = parseEpisodeEnvInt('METRIC_ANOMALY_EPISODE_GAP_MINUTES', 30);
/** Clean 5-minute buckets, per member metric, required to auto-resolve. */
export const EPISODE_CLEAN_BUCKETS = parseEpisodeEnvInt('METRIC_ANOMALY_EPISODE_CLEAN_BUCKETS', 6);
/** No clean data for this long after the last anomalous bucket -> expired. */
export const EPISODE_EXPIRE_HOURS = parseEpisodeEnvInt('METRIC_ANOMALY_EPISODE_EXPIRE_HOURS', 24);
/** Window for `recurrence_count`. */
export const EPISODE_RECURRENCE_DAYS = parseEpisodeEnvInt('METRIC_ANOMALY_EPISODE_RECURRENCE_DAYS', 7);
/** How long a user dismiss silences the key on that device (used by W02). */
export const EPISODE_SNOOZE_DAYS = parseEpisodeEnvInt('METRIC_ANOMALY_EPISODE_SNOOZE_DAYS', 7);
/** How far back the assembly scan looks for unassigned rows. */
export const EPISODE_ASSEMBLY_LOOKBACK_HOURS = parseEpisodeEnvInt('METRIC_ANOMALY_EPISODE_ASSEMBLY_LOOKBACK_HOURS', 24);
/**
 * Distinct buckets a new episode needs. Lone buckets of a settled island close
 * `cleared` with no episode (planner persistence gate).
 */
export const EPISODE_MIN_BUCKETS = parseEpisodeEnvInt('METRIC_ANOMALY_EPISODE_MIN_BUCKETS', 2);
/** Raw rollup grain the detectors and the clean-data check read. Not tunable. */
export const EPISODE_BUCKET_SECONDS = 300;

export type AttributionDimensionOrNull = AttributionDimension | null;

interface FamilyEntry {
  family: string;
  dimension: AttributionDimensionOrNull;
}

/**
 * source_table -> metric_name -> family. The process cpu and ram `_sum`/`_max`
 * pairs collapse, and so do the device ram/disk percent + absolute pairs: the
 * growth detector emits `ram_percent` and `ram_used_mb` (resp. `disk_percent`
 * and `disk_used_gb`) for the same growth, which opened two episodes per event
 * (2026-09-26 prod review). Episodes opened before that keep their old
 * `ram_used`/`disk_used` family and close normally. `source_table` stays part of the key because
 * `network_egress` and `process_runaway` are each emitted for a device series
 * AND a process-sample series, which must not merge.
 */
export const EPISODE_METRIC_FAMILIES: Readonly<Record<string, Readonly<Record<string, FamilyEntry>>>> = {
  device_metrics: {
    cpu_percent: { family: 'cpu', dimension: 'cpu' },
    ram_percent: { family: 'ram', dimension: 'ramMb' },
    ram_used_mb: { family: 'ram', dimension: 'ramMb' },
    disk_percent: { family: 'disk', dimension: null },
    disk_used_gb: { family: 'disk', dimension: null },
    disk_read_bps: { family: 'disk_read', dimension: 'diskBps' },
    disk_write_bps: { family: 'disk_write', dimension: 'diskBps' },
    bandwidth_in_bps: { family: 'net_in', dimension: 'netBps' },
    bandwidth_out_bps: { family: 'net_out', dimension: 'netBps' },
    process_count: { family: 'process_count', dimension: null },
  },
  device_process_samples: {
    top_process_cpu_percent_sum: { family: 'process_cpu', dimension: 'cpu' },
    top_process_cpu_percent_max: { family: 'process_cpu', dimension: 'cpu' },
    top_process_ram_mb_sum: { family: 'process_ram', dimension: 'ramMb' },
    top_process_ram_mb_max: { family: 'process_ram', dimension: 'ramMb' },
    top_process_disk_bps_sum: { family: 'process_disk', dimension: 'diskBps' },
    top_process_net_bps_sum: { family: 'process_net', dimension: 'netBps' },
    top_process_count: { family: 'process_count_top', dimension: null },
  },
};

export function episodeKeyFor(
  sourceTable: string,
  anomalyType: string,
  metricName: string,
): { episodeKey: string; metricFamily: string; attributionDimension: AttributionDimensionOrNull } {
  const byMetric = Object.hasOwn(EPISODE_METRIC_FAMILIES, sourceTable) ? EPISODE_METRIC_FAMILIES[sourceTable] : undefined;
  const entry = byMetric && Object.hasOwn(byMetric, metricName) ? byMetric[metricName] : undefined;
  // Unknown metric -> its own family, so the detector can grow without
  // breaking assembly (spec §4.2).
  const metricFamily = entry?.family ?? metricName;
  return {
    episodeKey: `${sourceTable}:${anomalyType}:${metricFamily}`,
    metricFamily,
    attributionDimension: entry?.dimension ?? null,
  };
}
