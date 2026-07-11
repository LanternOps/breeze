import type { AbuseSeverity } from './types';

/**
 * Published defaults. Production deployments may diverge via the
 * ABUSE_SIGNAL_OVERRIDES env var (JSON map of key -> number) so adversaries
 * reading this public repo do not learn the live thresholds.
 */
export const SIGNAL_DEFAULTS: Record<string, number> = {
  'sweep.young_full_weight_days': 30,
  'sweep.young_zero_weight_days': 90,
  'severity.watch_score': 40,
  'severity.alert_score': 70,
  'rmm.consumer_devices.min_devices': 5,
  'rmm.consumer_devices.watch_ratio': 0.6,
  'rmm.enrollment_velocity.devices_24h': 10,
  'rmm.session_intensity.fast_remote_count_7d': 3,
  'rmm.session_intensity.sessions_per_device_7d': 5,
  'rmm.enrollment_ip_spread.min_devices': 8,
  'rmm.enrollment_ip_spread.distinct_ratio': 0.8,
  'fraud.failed_login_cluster.count_24h': 20,
  'resource.enrollment_denied.count_24h': 20,
  'resource.volume_outlier.commands_24h': 500,
  'resource.volume_outlier.scripts_24h': 200,
};

export function loadSignalConfig(): Record<string, number> {
  const raw = process.env.ABUSE_SIGNAL_OVERRIDES;
  if (!raw) return { ...SIGNAL_DEFAULTS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('[AbuseSignals] ABUSE_SIGNAL_OVERRIDES is not valid JSON — using defaults');
    return { ...SIGNAL_DEFAULTS };
  }
  const cfg = { ...SIGNAL_DEFAULTS };
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!(key in SIGNAL_DEFAULTS)) {
        console.warn(`[AbuseSignals] Unknown override key ignored: ${key}`);
        continue;
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        console.warn(`[AbuseSignals] Non-numeric override ignored: ${key}`);
        continue;
      }
      cfg[key] = value;
    }
  } else {
    console.warn('[AbuseSignals] ABUSE_SIGNAL_OVERRIDES must be a JSON object — using defaults');
  }
  return cfg;
}

export function scoreToSeverity(score: number, cfg: Record<string, number>): AbuseSeverity {
  if (score >= cfg['severity.alert_score']) return 'alert';
  if (score >= cfg['severity.watch_score']) return 'watch';
  return 'info';
}

/** 1.0 for partners younger than young_full_weight_days, linearly decaying to 0 at young_zero_weight_days. */
export function youngWeight(partnerCreatedAt: Date, now: Date, cfg: Record<string, number>): number {
  const ageDays = (now.getTime() - partnerCreatedAt.getTime()) / 86_400_000;
  const full = cfg['sweep.young_full_weight_days'];
  const zero = cfg['sweep.young_zero_weight_days'];
  if (ageDays <= full) return 1;
  if (ageDays >= zero) return 0;
  return (zero - ageDays) / (zero - full);
}
