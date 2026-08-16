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
  // Connecting repeatedly to a newly-enrolled device is also just what an
  // operator does while trialling the product, and remote_sessions carries no
  // field that separates the two intents — session rows look the same either
  // way. So this corroborates rather than accuses: it caps below
  // severity.alert_score and needs a second signal to reach alert. Same rule as
  // cardholder_name_mismatch and card_testing below. Do not raise past
  // severity.alert_score without a discriminator that actually exists.
  'rmm.session_intensity.max_score': 65,
  'rmm.enrollment_ip_spread.min_devices': 8,
  'rmm.enrollment_ip_spread.distinct_ratio': 0.8,
  // Provider-default hostnames (heuristics.ts). A managed MSP endpoint gets
  // named or domain-joined; a box still carrying the hostname its hosting
  // provider or installer stamped on it is almost always the operator's own
  // staging VM rather than a customer asset. Sibling to rmm.consumer_devices,
  // which makes the same argument about DESKTOP-/LAPTOP- consumer defaults.
  //
  // Two tiers, because they carry very different confidence:
  //
  //  - CURATED: the hostname starts with a prefix listed in
  //    ABUSE_HOSTNAME_INDICATORS. That list is a specific, human-reviewed
  //    attribution ("this VPS provider's default prefix has only ever appeared
  //    on abusive fleets"), so curated_score is set to meet severity.alert_score
  //    exactly: at default thresholds a single matching device reaches alert.
  //    Both numbers are independently overridable via ABUSE_SIGNAL_OVERRIDES,
  //    so that equality is an intent, not an invariant — lowering
  //    curated_score or raising severity.alert_score demotes the tier. The list
  //    is deliberately EMPTY in this public repo — publishing it would tell the
  //    operator exactly which string to rename. Same reasoning and same
  //    mechanism as ABUSE_SCRIPT_INDICATORS.
  //
  //  - GENERIC: the hostname merely has the SHAPE of a stock OS installer
  //    default (see PROVIDER_DEFAULT_HOSTNAME_PATTERNS). It needs no
  //    configuration, but an unconfigurable pattern list has to be narrow: a
  //    small shop really does name machines `PC-0042`, so the built-in list is
  //    restricted to installer-generated artifacts and, on its own, this tier
  //    is corroboration — it requires a meaningful share of the fleet and caps
  //    below severity.alert_score. Same rule as session_intensity and
  //    cardholder_name_mismatch — do not raise past the alert threshold
  //    without a discriminator that actually exists.
  //
  // Neither tier is age-decayed: a fleet of unrenamed provider VMs is evidence
  // about what the fleet IS, not about how recently the account was created.
  'rmm.provider_default_hostname.curated_score': 70,
  'rmm.provider_default_hostname.curated_per_extra': 10,
  'rmm.provider_default_hostname.generic_min_devices': 3,
  'rmm.provider_default_hostname.generic_ratio': 0.5,
  'rmm.provider_default_hostname.generic_score': 45,
  'rmm.provider_default_hostname.generic_max_score': 55,
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
  // Unbranded-installer gate (same detector, shape-based stage 1): a remote
  // fetch of an .msi/.exe from cloud object storage, with no vendor named.
  // Same gate score as the branded path — fetching an installer is what an RMM
  // does, so the gate alone stays below watch and the SAME marker weights
  // above supply the discrimination. Markers are deliberately NOT duplicated
  // per gate: 'unrelated_host' means the same thing either way, and one set
  // keeps tuning honest.
  'rmm.unbranded_installer.gate_score': 20,
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
  // Cross-signal corroboration (corroboration.ts). This is the "second signal"
  // that the capped scores above (session_intensity, cardholder_name_mismatch,
  // provider_default_hostname generic) have always referred to — it did not
  // exist until 2026-08-16, which is why a partner could fire several capped
  // watch signals and never notify anyone.
  //
  // min_axes counts DISTINCT EVIDENCE AXES, not signals: two detectors that
  // restate one observation (the two IP-scatter signals) share an axis and
  // cannot corroborate each other. 2 is the meaningful floor — one axis is a
  // single detector, which is what the caps already decided is not enough.
  //
  // per_extra_axis is deliberately large enough that two watch-tier axes clear
  // severity.alert_score at defaults (55 + 15 = 70), because the whole point is
  // to make a corroborated pair reach an operator in real time.
  //
  // Reaching min_axes is necessary but NOT sufficient: the aggregate must also
  // cross severity.alert_score or nothing is emitted at all. Two weak axes can
  // sum below it (45 + 15 = 60), and a synthetic *watch* row would notify
  // nobody while crowding out the weekly digest's 20-row watch list. Lowering
  // this value therefore silences the signal rather than demoting it.
  'fraud.corroborated_watch.min_axes': 2,
  'fraud.corroborated_watch.per_extra_axis': 15,
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
