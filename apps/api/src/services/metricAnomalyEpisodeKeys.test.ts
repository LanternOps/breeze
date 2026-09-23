import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EPISODE_ASSEMBLY_LOOKBACK_HOURS,
  EPISODE_BUCKET_SECONDS,
  EPISODE_CLEAN_BUCKETS,
  EPISODE_EXPIRE_HOURS,
  EPISODE_GAP_MINUTES,
  EPISODE_METRIC_FAMILIES,
  EPISODE_RECURRENCE_DAYS,
  EPISODE_SNOOZE_DAYS,
  episodeKeyFor,
  parseEpisodeEnvInt,
} from './metricAnomalyEpisodeKeys';

// Spec §4.2, verbatim.
const TABLE = [
  ['device_metrics', 'cpu_percent', 'cpu', 'cpu'],
  ['device_metrics', 'ram_percent', 'ram', 'ramMb'],
  ['device_metrics', 'ram_used_mb', 'ram_used', 'ramMb'],
  ['device_metrics', 'disk_percent', 'disk', null],
  ['device_metrics', 'disk_used_gb', 'disk_used', null],
  ['device_metrics', 'disk_read_bps', 'disk_read', 'diskBps'],
  ['device_metrics', 'disk_write_bps', 'disk_write', 'diskBps'],
  ['device_metrics', 'bandwidth_in_bps', 'net_in', 'netBps'],
  ['device_metrics', 'bandwidth_out_bps', 'net_out', 'netBps'],
  ['device_metrics', 'process_count', 'process_count', null],
  ['device_process_samples', 'top_process_cpu_percent_sum', 'process_cpu', 'cpu'],
  ['device_process_samples', 'top_process_cpu_percent_max', 'process_cpu', 'cpu'],
  ['device_process_samples', 'top_process_ram_mb_sum', 'process_ram', 'ramMb'],
  ['device_process_samples', 'top_process_ram_mb_max', 'process_ram', 'ramMb'],
  ['device_process_samples', 'top_process_disk_bps_sum', 'process_disk', 'diskBps'],
  ['device_process_samples', 'top_process_net_bps_sum', 'process_net', 'netBps'],
  ['device_process_samples', 'top_process_count', 'process_count_top', null],
] as const;

// Every metric_name the three detectors in services/metricAnomalies.ts can write.
const DETECTOR_EMITTED: ReadonlyArray<readonly [string, string]> = [
  ...['cpu_percent', 'ram_percent', 'disk_percent', 'disk_read_bps', 'disk_write_bps', 'bandwidth_in_bps', 'bandwidth_out_bps', 'process_count', 'ram_used_mb', 'disk_used_gb']
    .map((name) => ['device_metrics', name] as const),
  ...['top_process_cpu_percent_sum', 'top_process_cpu_percent_max', 'top_process_ram_mb_sum', 'top_process_ram_mb_max', 'top_process_disk_bps_sum', 'top_process_net_bps_sum']
    .map((name) => ['device_process_samples', name] as const),
];

describe('episodeKeyFor (spec §4.2)', () => {
  it.each(TABLE)('%s / %s -> family %s, dimension %s', (sourceTable, metricName, family, dimension) => {
    expect(episodeKeyFor(sourceTable, 'spike', metricName)).toEqual({
      episodeKey: `${sourceTable}:spike:${family}`,
      metricFamily: family,
      attributionDimension: dimension,
    });
  });

  it('has an explicit entry for every metric the detectors emit', () => {
    for (const [sourceTable, metricName] of DETECTOR_EMITTED) {
      expect(EPISODE_METRIC_FAMILIES[sourceTable]?.[metricName], `${sourceTable}/${metricName}`).toBeDefined();
    }
  });

  it('collapses only the process cpu and ram pairs', () => {
    const namesByFamily = new Map<string, string[]>();
    for (const [sourceTable, metricName, family] of TABLE) {
      const key = `${sourceTable}:${family}`;
      namesByFamily.set(key, [...(namesByFamily.get(key) ?? []), metricName]);
    }
    const collapsed = [...namesByFamily.entries()].filter(([, names]) => names.length > 1).map(([key]) => key).sort();
    expect(collapsed).toEqual(['device_process_samples:process_cpu', 'device_process_samples:process_ram']);
  });

  it('keeps source_table in the key so device and process series never merge', () => {
    expect(episodeKeyFor('device_metrics', 'network_egress', 'bandwidth_out_bps').episodeKey)
      .not.toBe(episodeKeyFor('device_process_samples', 'network_egress', 'top_process_net_bps_sum').episodeKey);
    expect(episodeKeyFor('device_metrics', 'process_runaway', 'process_count').episodeKey)
      .toBe('device_metrics:process_runaway:process_count');
  });

  it('keeps anomaly_type in the key', () => {
    expect(episodeKeyFor('device_metrics', 'spike', 'cpu_percent').episodeKey)
      .not.toBe(episodeKeyFor('device_metrics', 'drop', 'cpu_percent').episodeKey);
  });

  it('falls back to metric_family = metric_name for an unknown metric, with no dimension', () => {
    expect(episodeKeyFor('device_metrics', 'spike', 'gpu_percent')).toEqual({
      episodeKey: 'device_metrics:spike:gpu_percent',
      metricFamily: 'gpu_percent',
      attributionDimension: null,
    });
    // Prototype keys are not known metrics.
    expect(episodeKeyFor('device_metrics', 'spike', 'toString').metricFamily).toBe('toString');
    expect(episodeKeyFor('constructor', 'spike', 'cpu_percent').metricFamily).toBe('cpu_percent');
  });
});

describe('episode constants (spec §5)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to the spec values', () => {
    expect(EPISODE_GAP_MINUTES).toBe(30);
    expect(EPISODE_CLEAN_BUCKETS).toBe(6);
    expect(EPISODE_EXPIRE_HOURS).toBe(24);
    expect(EPISODE_RECURRENCE_DAYS).toBe(7);
    expect(EPISODE_SNOOZE_DAYS).toBe(7);
    expect(EPISODE_ASSEMBLY_LOOKBACK_HOURS).toBe(24);
    expect(EPISODE_BUCKET_SECONDS).toBe(300);
  });

  it('honours a positive integer env override and rejects anything else', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('METRIC_ANOMALY_EPISODE_TEST', '45');
    expect(parseEpisodeEnvInt('METRIC_ANOMALY_EPISODE_TEST', 30)).toBe(45);
    for (const junk of ['0', '-5', 'abc', '']) {
      vi.stubEnv('METRIC_ANOMALY_EPISODE_TEST', junk);
      expect(parseEpisodeEnvInt('METRIC_ANOMALY_EPISODE_TEST', 30)).toBe(30);
    }
  });
});
