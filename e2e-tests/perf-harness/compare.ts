/**
 * Compare two PerfResult JSON files (baseline vs a code change) and print a diff
 * table of the summary metrics.
 *
 * Usage (from e2e-tests/):
 *   npx tsx perf-harness/compare.ts <baseline.json> <change.json>
 */
import { readFileSync } from 'node:fs';
import type { PerfResult, PerfSummary } from './types';

interface MetricDef {
  key: keyof PerfSummary;
  label: string;
  unit: string;
  /** 'up' = higher is better, 'down' = lower is better. */
  better: 'up' | 'down';
}

const METRICS: MetricDef[] = [
  { key: 'meanFps', label: 'Mean FPS', unit: 'fps', better: 'up' },
  { key: 'p5Fps', label: 'p5 FPS', unit: 'fps', better: 'up' },
  { key: 'meanBitrateKbps', label: 'Mean bitrate', unit: 'kbps', better: 'up' },
  { key: 'framesDroppedPct', label: 'Frames dropped', unit: '%', better: 'down' },
  { key: 'freezeCount', label: 'Freeze count', unit: '', better: 'down' },
  { key: 'totalFreezeSec', label: 'Total freeze', unit: 's', better: 'down' },
  { key: 'meanRttMs', label: 'Mean RTT', unit: 'ms', better: 'down' },
  { key: 'meanJitterMs', label: 'Mean jitter', unit: 'ms', better: 'down' },
  { key: 'packetsLost', label: 'Packets lost', unit: '', better: 'down' },
  { key: 'mediaClockDriftMs', label: 'Media-clock drift', unit: 'ms', better: 'down' },
  { key: 'meanFramePacingErrorMs', label: 'Mean frame pacing err', unit: 'ms', better: 'down' },
  { key: 'p95FramePacingErrorMs', label: 'p95 frame pacing err', unit: 'ms', better: 'down' },
];

function load(p: string): PerfResult {
  return JSON.parse(readFileSync(p, 'utf8')) as PerfResult;
}

function fmt(v: number | null, unit: string): string {
  if (v == null) return '—';
  return `${v}${unit ? ' ' + unit : ''}`;
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

function deltaCell(base: number | null, chg: number | null, better: 'up' | 'down'): string {
  if (base == null || chg == null) return '—';
  const d = chg - base;
  if (d === 0) return '0';
  const pct = base !== 0 ? ` (${d > 0 ? '+' : ''}${((d / Math.abs(base)) * 100).toFixed(1)}%)` : '';
  const improved = better === 'up' ? d > 0 : d < 0;
  const mark = improved ? '▲ better' : '▼ worse';
  const sign = d > 0 ? '+' : '';
  return `${sign}${Math.round(d * 100) / 100}${pct} ${mark}`;
}

function main(): void {
  const [basePath, chgPath] = process.argv.slice(2);
  if (!basePath || !chgPath) {
    console.error('Usage: tsx perf-harness/compare.ts <baseline.json> <change.json>');
    process.exit(2);
  }
  const base = load(basePath);
  const chg = load(chgPath);

  console.log('');
  console.log(`Baseline : ${base.label}  (${base.machine}, ${base.timestamp})`);
  console.log(`Change   : ${chg.label}  (${chg.machine}, ${chg.timestamp})`);
  if (base.machine !== chg.machine) {
    console.log('⚠  Different machines — WebRTC numbers are only comparable on the same machine.');
  }
  if (!base.capturedLiveVideo || !chg.capturedLiveVideo) {
    console.log('⚠  At least one run captured no live video (scaffolding-only); metrics are null.');
  }
  console.log('');

  const cols = [34, 16, 16, 26];
  console.log(
    pad('Metric', cols[0]!) +
      pad('Baseline', cols[1]!) +
      pad('Change', cols[2]!) +
      pad('Delta', cols[3]!),
  );
  console.log('-'.repeat(cols.reduce((a, b) => a + b, 0)));
  for (const m of METRICS) {
    const b = base.summary[m.key] as number | null;
    const c = chg.summary[m.key] as number | null;
    console.log(
      pad(`${m.label}`, cols[0]!) +
        pad(fmt(b, m.unit), cols[1]!) +
        pad(fmt(c, m.unit), cols[2]!) +
        pad(deltaCell(b, c, m.better), cols[3]!),
    );
  }
  console.log('');
}

main();
