import type { TFunction } from 'i18next';
import type { AttributionDimension, AttributionSnapshot, MetricAnomalyEpisodeDto } from '@breeze/shared';
import { formatNumber, formatPercent } from '@/lib/i18n/format';

/** W01's snapshot minus `sampledAt` — the formatter never reads the time. */
export type AttributionSnapshotLike = Pick<AttributionSnapshot, 'dimension' | 'processes'>;

/** The subset of W02's DTO the formatter reads; a full MetricAnomalyEpisodeDto is assignable. */
export type EpisodeSentenceInput = Pick<
  MetricAnomalyEpisodeDto,
  | 'anomalyType'
  | 'metricFamily'
  | 'peakMetricName'
  | 'rangeMin'
  | 'rangeMax'
  | 'peakValue'
  | 'peakBaselineValue'
  | 'durationSeconds'
> & {
  attribution: { opened?: AttributionSnapshotLike; peak?: AttributionSnapshotLike } | null;
};

// Friendly labels for episode-key metric families (spec §4.2). Raw metric-name
// labels (cpu_percent → "CPU") already exist in the legacy panel; families are
// a different, smaller vocabulary (cpu, disk_write, process_ram, ...), so this
// map is new rather than reused.
const FAMILY_LABELS: Record<string, string> = {
  cpu: 'CPU',
  ram: 'RAM',
  ram_used: 'RAM used',
  disk: 'Disk',
  disk_used: 'Disk used',
  disk_read: 'Disk read',
  disk_write: 'Disk write',
  net_in: 'Network in',
  net_out: 'Network out',
  process_count: 'Process count',
  process_cpu: 'Process CPU',
  process_ram: 'Process RAM',
  process_disk: 'Process disk I/O',
  process_net: 'Process network I/O',
  process_count_top: 'Top process count',
};

const DIMENSION_LABELS: Record<AttributionDimension, string> = {
  cpu: 'CPU',
  ramMb: 'RAM',
  diskBps: 'disk I/O',
  netBps: 'network I/O',
};

export function familyLabel(metricFamily: string, _t: TFunction): string {
  return FAMILY_LABELS[metricFamily] ?? titleCase(metricFamily.replace(/_/g, ' '));
}

function titleCase(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

/** No locale grouping, no forced trailing zero — mirrors raw sensor precision
 *  (2355 → "2355", 1932.5 → "1932.5"), unlike Intl.NumberFormat's default
 *  thousands separators and unlike a forced-decimal format. */
function formatPlainNumber(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/** Scale + unit for a bps value, shared by a single formatted value and by
 *  formatRange (which must pick ONE scale for both ends of a range). */
function bpsScale(value: number): { divisor: number; unit: string } {
  if (value >= 1_000_000_000) return { divisor: 1_000_000_000, unit: ' GB/s' };
  if (value >= 1_000_000) return { divisor: 1_000_000, unit: ' MB/s' };
  if (value >= 1_000) return { divisor: 1_000, unit: ' KB/s' };
  return { divisor: 1, unit: ' B/s' };
}

function formatBps(value: number): string {
  const { divisor, unit } = bpsScale(value);
  const scaled = value / divisor;
  const number = divisor === 1 ? String(Math.round(scaled)) : formatNumber(scaled, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${number}${unit}`;
}

export function formatMetricValue(metricName: string, value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (metricName.endsWith('_percent'))
    return formatPercent(value / 100, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (metricName.includes('_bps')) return formatBps(value);
  // `_mb` is checked with includes, not endsWith: the process-pair peak
  // metrics are `top_process_ram_mb_max` / `_sum`, which end in `_max`/`_sum`
  // rather than `_mb`.
  if (metricName.includes('_mb')) return `${formatPlainNumber(value)} MB`;
  if (metricName.endsWith('_gb'))
    return `${formatNumber(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} GB`;
  return value >= 100 ? formatNumber(value, { maximumFractionDigits: 0 }) : formatPlainNumber(value);
}

/** Attribution-line process values (spec §9): plain sensor precision, never
 *  the headline's forced-one-decimal percent style (headline: "3.0%" for an
 *  exact 3; attribution: "88%" for an exact 88) — these are two different
 *  display conventions for the same underlying metric family. */
function formatAttributionValue(dimension: AttributionDimension, value: number): string {
  if (dimension === 'cpu') return `${formatPlainNumber(value)}%`;
  if (dimension === 'ramMb') return `${formatPlainNumber(value)} MB`;
  return formatBps(value); // diskBps / netBps
}

export function formatDuration(seconds: number, _t: TFunction): string {
  // Anything up to and including a full minute reads as "<1 m" — a spike that
  // resolves inside its own opening bucket is not worth a "1 m" label.
  if (!Number.isFinite(seconds) || seconds <= 60) return '<1 m';
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} m`;
  if (minutes === 0) return `${hours} h`;
  return `${hours} h ${minutes} m`;
}

export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

function formatRange(metricName: string, min: number, max: number): string {
  if (min === max) return formatMetricValue(metricName, max);
  if (metricName.includes('_bps')) {
    // A range must share one scale (both ends in MB/s, not one in KB/s and
    // the other in MB/s) — pick it from the larger end.
    const { divisor, unit } = bpsScale(max);
    const minNumber = divisor === 1 ? String(Math.round(min / divisor)) : formatNumber(min / divisor, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    const maxNumber = divisor === 1 ? String(Math.round(max / divisor)) : formatNumber(max / divisor, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    return `${minNumber}–${maxNumber}${unit}`;
  }
  // Every non-bps branch of formatMetricValue uses a fixed unit regardless of
  // magnitude (percent/mb/gb/fallback), so strip the trailing unit text off
  // the min side rather than repeating it (e.g. "86.0 MB/s–153.0 MB/s" is
  // wrong; only bps has a magnitude-dependent unit, handled above).
  const minFormatted = formatMetricValue(metricName, min);
  const maxFormatted = formatMetricValue(metricName, max);
  const unitMatch = /[^\d.,-]+$/.exec(minFormatted);
  const unit = unitMatch ? unitMatch[0] : '';
  const minNumber = unit ? minFormatted.slice(0, minFormatted.length - unit.length) : minFormatted;
  return `${minNumber}–${maxFormatted}`;
}

const PROCESS_PAIR_FAMILIES = new Set(['process_cpu', 'process_ram']);

export function formatEpisodeSentence(
  episode: EpisodeSentenceInput,
  t: TFunction,
): { headline: string; attributionLine: string } {
  const metric = familyLabel(episode.metricFamily, t);
  const duration = formatDuration(episode.durationSeconds, t);
  // W02 returns null when no member of the peak metric was found; one value then.
  const rangeMin = episode.rangeMin ?? episode.peakValue;
  const rangeMax = episode.rangeMax ?? episode.peakValue;
  const baseline = episode.peakBaselineValue == null
    ? t('deviceAnomaliesPanel.text')
    : formatMetricValue(episode.peakMetricName, episode.peakBaselineValue);

  let headline: string;
  if (PROCESS_PAIR_FAMILIES.has(episode.metricFamily) && episode.peakMetricName.endsWith('_max')) {
    headline = t('deviceAnomaliesPanel.sentence.processMax', {
      value: formatMetricValue(episode.peakMetricName, episode.peakValue),
      baseline,
      defaultValue: 'One process reached {{value}}, normally {{baseline}}.',
    });
  } else if (PROCESS_PAIR_FAMILIES.has(episode.metricFamily) && episode.peakMetricName.endsWith('_sum')) {
    headline = t('deviceAnomaliesPanel.sentence.processSum', {
      value: formatMetricValue(episode.peakMetricName, episode.peakValue),
      baseline,
      defaultValue: 'Top processes together used {{value}}, normally {{baseline}}.',
    });
  } else if (episode.anomalyType === 'drop') {
    headline = t('deviceAnomaliesPanel.sentence.drop', {
      metric,
      value: formatRange(episode.peakMetricName, rangeMin, rangeMax),
      duration,
      baseline,
      defaultValue: '{{metric}} dropped to {{value}} for {{duration}}, normally {{baseline}}.',
    });
  } else if (episode.anomalyType === 'memory_growth' || episode.anomalyType === 'disk_growth') {
    headline = t('deviceAnomaliesPanel.sentence.growth', {
      metric,
      from: formatMetricValue(episode.peakMetricName, rangeMin),
      to: formatMetricValue(episode.peakMetricName, rangeMax),
      duration,
      defaultValue: '{{metric}} grew from {{from}} to {{to}} over {{duration}}.',
    });
  } else {
    // spike / network_egress / process_runaway on a non-pair family.
    headline = t('deviceAnomaliesPanel.sentence.spike', {
      metric,
      range: formatRange(episode.peakMetricName, rangeMin, rangeMax),
      duration,
      baseline,
      defaultValue: '{{metric}} has been {{range}} for {{duration}}, normally {{baseline}}.',
    });
  }

  const snapshot = episode.attribution?.peak ?? episode.attribution?.opened ?? null;
  let attributionLine: string;
  if (!snapshot || snapshot.processes.length === 0) {
    attributionLine = t('deviceAnomaliesPanel.processDetailNotAvailable', {
      defaultValue: 'Process detail not available for this metric.',
    });
  } else {
    const dimensionLabel = DIMENSION_LABELS[snapshot.dimension];
    const list = snapshot.processes
      .map((p) => `${p.name} ${formatAttributionValue(snapshot.dimension, p.value)}`)
      .join(' · ');
    attributionLine = t('deviceAnomaliesPanel.topByAtPeak', {
      dimension: dimensionLabel,
      list,
      defaultValue: 'Top by {{dimension}} at peak: {{list}}',
    });
  }

  return { headline, attributionLine };
}
