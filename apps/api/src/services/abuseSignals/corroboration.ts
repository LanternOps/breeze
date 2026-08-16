import { scoreToSeverity, type SignalConfig } from './config';
import type { ComputedSignal } from './types';

/**
 * Cross-signal corroboration.
 *
 * Several detectors deliberately cap their score below `severity.alert_score`
 * because, on their own, they describe behaviour a legitimate operator also
 * exhibits — trialling remote sessions on a new device, paying with a spouse's
 * card, running unrenamed provider VMs. The config comments on those caps
 * (`rmm.session_intensity.max_score`, `billing.cardholder_name_mismatch.score`,
 * `rmm.provider_default_hostname.generic_max_score`) all say the signal "needs
 * a second signal to reach alert".
 *
 * That second half was never built. Severity is a pure function of one signal's
 * own score, so a partner firing four capped `watch` signals produced four
 * `watch` rows and — because only `alert` is ever delivered
 * (persistence.ts) — zero notifications. In production that gap cost real
 * victims: on several confirmed-fraud accounts a capped `watch` signal was the
 * ONLY signal that fired and nobody was notified.
 *
 * This closes it by emitting a synthetic `fraud.corroborated_watch` signal
 * rather than by mutating another detector's severity in place. Keeping it a
 * separate row means each detector keeps its own honest score, the existing
 * dedup/stale-resolution key `(partner_id, signal_key)` still works, and an
 * operator can acknowledge "yes, this combination is fine for this partner"
 * without suppressing the underlying detectors.
 */

/**
 * Which independent line of evidence a signal represents.
 *
 * Corroboration counts DISTINCT AXES, never raw signal count, and that
 * distinction is the whole false-positive control. `rmm.enrollment_ip_spread`
 * and `rmm.device_ip_scatter` are both restatements of one observation — this
 * fleet's addresses are scattered — and they co-fire on legitimate MSPs that
 * serve residential customers. Counting them as two would manufacture an alert
 * out of a single fact. They share an axis on purpose.
 *
 * A signal key absent from this map is treated as its own axis. That is the
 * safe default for a NEW detector (it can corroborate immediately), but it
 * means adding a detector that restates an existing observation REQUIRES adding
 * it here — otherwise it double-counts. `corroboration.test.ts` asserts every
 * key this sweep can emit is mapped.
 */
export const SIGNAL_AXIS: Record<string, string> = {
  'rmm.session_intensity': 'session',
  'rmm.consumer_devices': 'fleet_shape',
  'rmm.provider_default_hostname': 'fleet_shape',
  'rmm.enrollment_ip_spread': 'ip_scatter',
  'rmm.device_ip_scatter': 'ip_scatter',
  'rmm.enrollment_velocity': 'enrollment_velocity',
  'rmm.remote_access_installer': 'script',
  'rmm.unbranded_installer': 'script',
  'rmm.shared_installer_host': 'script',
  'billing.cardholder_name_mismatch': 'billing_identity',
  'billing.card_testing': 'billing_identity',
  'billing.shared_card_fingerprint': 'billing_identity',
  'fraud.failed_login_cluster': 'auth',
  'resource.enrollment_denied': 'resource',
  'resource.volume_outlier': 'resource',
};

export const CORROBORATED_SIGNAL_KEY = 'fraud.corroborated_watch';

export function axisFor(signalKey: string): string {
  return SIGNAL_AXIS[signalKey] ?? signalKey;
}

/**
 * Pure — no I/O. Runs on the signals the other detectors already computed, so
 * it adds no queries to the sweep.
 *
 * `invariant.*` signals are excluded as corroborators: they are hardcoded to
 * `alert` and already notify on their own, so folding them in would only
 * restate an alert that has already been delivered.
 */
export function computeCorroborationSignals(
  computed: ComputedSignal[],
  cfg: SignalConfig,
): ComputedSignal[] {
  const minAxes = cfg['fraud.corroborated_watch.min_axes'];
  const perExtraAxis = cfg['fraud.corroborated_watch.per_extra_axis'];

  const byPartner = new Map<string, ComputedSignal[]>();
  for (const s of computed) {
    if (s.severity !== 'watch') continue;
    if (s.signalKey.startsWith('invariant.')) continue;
    if (s.signalKey === CORROBORATED_SIGNAL_KEY) continue;
    const list = byPartner.get(s.partnerId);
    if (list) list.push(s);
    else byPartner.set(s.partnerId, [s]);
  }

  const out: ComputedSignal[] = [];
  for (const [partnerId, signals] of byPartner) {
    // Highest-scoring signal per axis: two watch signals on one axis
    // contribute one axis and the stronger of the two scores.
    const bestByAxis = new Map<string, ComputedSignal>();
    for (const s of signals) {
      const axis = axisFor(s.signalKey);
      const current = bestByAxis.get(axis);
      if (!current || s.score > current.score) bestByAxis.set(axis, s);
    }
    if (bestByAxis.size < minAxes) continue;

    const contributors = [...bestByAxis.entries()]
      .map(([axis, s]) => ({ axis, signalKey: s.signalKey, score: s.score }))
      .sort((a, b) => b.score - a.score || a.axis.localeCompare(b.axis));

    // Anchor on the strongest single axis, then add for each INDEPENDENT
    // corroborating axis. Deriving severity through the normal
    // scoreToSeverity keeps score and severity consistent, so lowering
    // per_extra_axis (or raising severity.alert_score) demotes this to watch
    // rather than producing an 'alert' that its own score contradicts.
    const base = contributors[0]?.score ?? 0;
    const score = Math.min(100, Math.round(base + perExtraAxis * (bestByAxis.size - 1)));

    out.push({
      partnerId,
      signalKey: CORROBORATED_SIGNAL_KEY,
      score,
      severity: scoreToSeverity(score, cfg),
      // partnerName must lead: index.ts formatSignalAlert reads it.
      evidence: {
        partnerName: signals.find((s) => s.evidence.partnerName)?.evidence.partnerName ?? 'unknown',
        axisCount: bestByAxis.size,
        contributors,
      },
    });
  }
  return out;
}
