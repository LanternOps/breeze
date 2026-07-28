import type { AbuseSeverity } from './types';

/**
 * Published defaults. Production deployments may diverge via the
 * ABUSE_SIGNAL_OVERRIDES env var (JSON map of key -> number) so adversaries
 * reading this public repo do not learn the live thresholds.
 */
export const SIGNAL_DEFAULTS = {
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
  'rmm.device_ip_scatter.min_devices': 8,
  'rmm.device_ip_scatter.watch_ratio': 0.85,
  'rmm.device_ip_scatter.high_ratio': 0.95,
  'fraud.failed_login_cluster.count_24h': 20,
  'resource.enrollment_denied.count_24h': 20,
  'resource.volume_outlier.commands_24h': 500,
  'resource.volume_outlier.scripts_24h': 200,
  // Script-content detector (scriptContent.ts). Gate alone (remote-access
  // product + install/fetch primitive) is what an RMM does, so it scores
  // below watch; corroborating markers are additive on top, clamped at 100.
  // NONE of these are age-decayed — a malicious installer is malicious
  // regardless of account age.
  'rmm.remote_access_installer.gate_score': 20,
  'rmm.remote_access_installer.marker.tls_bypass': 70,
  'rmm.remote_access_installer.marker.shared_host': 60,
  'rmm.remote_access_installer.marker.indicator_host': 60,
  'rmm.remote_access_installer.marker.throwaway_tld': 50,
  'rmm.remote_access_installer.marker.bare_ip_port': 50,
  'rmm.remote_access_installer.marker.misleading_filename': 45,
  'rmm.remote_access_installer.marker.unrelated_host': 25,
  'rmm.remote_access_installer.marker.exec_policy_bypass': 20,
  'rmm.remote_access_installer.marker.unattended_params': 15,
  'rmm.shared_installer_host.min_partners': 2,
  'rmm.shared_installer_host.base_score': 60,
  'rmm.shared_installer_host.per_extra_partner': 20,
  // Billing-identity detector (billingIdentity.ts). Like the script-content
  // detector, NONE of these are age-decayed — a cardholder name that matches
  // nothing about the account is evidence regardless of how old the account is.
  // A name mismatch alone caps below alert: legitimate operators do pay with a
  // spouse's or a parent company's card.
  'billing.cardholder_name_mismatch.score': 55,
  'billing.cardholder_name_mismatch.failed_attempt_bonus': 5,
  'billing.shared_card_fingerprint.min_partners': 2,
  'billing.shared_card_fingerprint.base_score': 70,
  'billing.shared_card_fingerprint.per_extra_partner': 15,
  'billing.card_testing.distinct_methods': 3,
  // The window is the SPAN the distinct methods were accumulated over
  // (last_seen - first_seen), not a recency check. A card-testing burst is
  // minutes; a legitimate MSP replacing an expired card is months or years
  // apart. 1 day sits far above the burst and far below any legitimate
  // re-card cadence, and still covers an adversary pacing attempts across a
  // working day. It deliberately does also catch a genuine
  // decline-then-retry-twice signup — that is a watch-tier review, not an
  // alert, which is why 3 methods alone scores below severity.alert_score.
  'billing.card_testing.window_days': 1,
  'billing.card_testing.base_score': 50,
  'billing.card_testing.per_extra_method': 15,
  'billing.card_testing.per_failed_attempt': 5,
} as const satisfies Record<string, number>;

export type SignalConfigKey = keyof typeof SIGNAL_DEFAULTS;
export type SignalConfig = Record<SignalConfigKey, number>;

export function loadSignalConfig(): SignalConfig {
  const raw = process.env.ABUSE_SIGNAL_OVERRIDES;
  if (!raw) return { ...SIGNAL_DEFAULTS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('[AbuseSignals] ABUSE_SIGNAL_OVERRIDES is not valid JSON — using defaults');
    return { ...SIGNAL_DEFAULTS };
  }
  const cfg: SignalConfig = { ...SIGNAL_DEFAULTS };
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
      // `key in SIGNAL_DEFAULTS` above narrows the runtime string to a known
      // key, but TS can't carry that narrowing through Object.entries — cast
      // is safe because of the check on the line above.
      cfg[key as SignalConfigKey] = value;
    }
  } else {
    console.warn('[AbuseSignals] ABUSE_SIGNAL_OVERRIDES must be a JSON object — using defaults');
  }
  return cfg;
}

export function scoreToSeverity(score: number, cfg: SignalConfig): AbuseSeverity {
  if (score >= cfg['severity.alert_score']) return 'alert';
  if (score >= cfg['severity.watch_score']) return 'watch';
  return 'info';
}

/** 1.0 for partners younger than young_full_weight_days, linearly decaying to 0 at young_zero_weight_days. */
export function youngWeight(partnerCreatedAt: Date, now: Date, cfg: SignalConfig): number {
  const ageDays = (now.getTime() - partnerCreatedAt.getTime()) / 86_400_000;
  const full = cfg['sweep.young_full_weight_days'];
  const zero = cfg['sweep.young_zero_weight_days'];
  if (ageDays <= full) return 1;
  if (ageDays >= zero) return 0;
  return (zero - ageDays) / (zero - full);
}
