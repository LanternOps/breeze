/**
 * Display helpers for M3 measurements. A measured zero is a value ("0 bps");
 * only `null` means "not measured" — callers render the localized
 * `notMeasured` string for it, never a zero.
 */
export type MetricUnit = 'bits_per_second' | 'percent' | 'per_second';

const BIT_STEPS = [['Gbps', 1e9], ['Mbps', 1e6], ['Kbps', 1e3]] as const;

function trim(value: number, digits: number): string {
  return Number(value.toFixed(digits)).toString();
}

export function formatMetric(value: number, unit: MetricUnit): string {
  if (unit === 'percent') return `${trim(value, 1)}%`;
  if (unit === 'per_second') return `${trim(value, value >= 10 ? 1 : 3)}/s`;
  for (const [label, size] of BIT_STEPS) if (Math.abs(value) >= size) return `${trim(value / size, 2)} ${label}`;
  return `${trim(value, 0)} bps`;
}

/** Capacity arrives as a uint64 decimal string (bits/second). */
export function formatCapacity(capacityBps: string | null): string | null {
  if (capacityBps === null) return null;
  const value = Number(capacityBps);
  return Number.isFinite(value) ? formatMetric(value, 'bits_per_second') : `${capacityBps} bps`;
}

export function formatTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : '';
}

export type ChartPoint = { at: string; value: number | null };
/**
 * Polyline segments for a series: a null (not measured) point ends the current
 * segment, so a gap is drawn as a gap and never interpolated across.
 */
export function chartSegments(points: readonly ChartPoint[], from: number, to: number, width: number, height: number): Array<Array<[number, number]>> {
  const values = points.filter((point) => point.value !== null).map((point) => point.value!);
  const max = Math.max(0, ...values), min = Math.min(0, ...values);
  const span = max - min || 1, range = to - from || 1;
  const segments: Array<Array<[number, number]>> = [];
  let current: Array<[number, number]> = [];
  for (const point of points) {
    if (point.value === null) { if (current.length) segments.push(current); current = []; continue; }
    const x = ((Date.parse(point.at) - from) / range) * width;
    const y = height - ((point.value - min) / span) * height;
    current.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
  }
  if (current.length) segments.push(current);
  return segments;
}
