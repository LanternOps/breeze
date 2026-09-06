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
 * key in its hand-maintained EMITTED_KEYS list is mapped or explicitly
 * ineligible — when you add a detector, add its key THERE as well as here, or
 * the assertion cannot see it.
 */
export const SIGNAL_AXIS: Record<string, string> = {
  // `session_intensity` is "fast enroll-to-remote" and `enrollment_velocity` is
  // the enrollment burst itself — the same episode measured twice. An MSP
  // onboarding a customer bulk-enrolls and immediately connects to each box,
  // firing both. One axis.
  'rmm.session_intensity': 'enrollment_burst',
  'rmm.enrollment_velocity': 'enrollment_burst',
  'rmm.consumer_devices': 'fleet_shape',
  'rmm.provider_default_hostname': 'fleet_shape',
  'rmm.enrollment_ip_spread': 'ip_scatter',
  'rmm.device_ip_scatter': 'ip_scatter',
  'rmm.remote_access_installer': 'script',
  'rmm.unbranded_installer': 'script',
  'rmm.shared_installer_host': 'script',
  // Both origin-IP signals restate one observation — this partner works from
  // infrastructure a suspended operator used — measured at two strengths
  // (exact address vs /24). Counting them as two axes would let a single fact
  // manufacture an alert, the same trap the ip_scatter pair is grouped for.
  'fraud.suspended_console_ip': 'origin_ip',
  'fraud.dead_account_probe_origin': 'origin_ip',
  // Deliberately its OWN axis, distinct from origin_ip: the recidivist
  // detector reads endpoint identity (ScreenConnect client GUID, hostname,
  // device egress IP), the origin-IP detector reads console/network origin.
  // A ring re-establishing trips both from independent evidence sources, and
  // that pair corroborating (hostname-only watch at 60 + probe watch at 55)
  // is the desired outcome, not double-counting.
  'rmm.recidivist_endpoint': 'endpoint_identity',
  'billing.cardholder_name_mismatch': 'billing_identity',
  'billing.card_testing': 'billing_identity',
  'billing.shared_card_fingerprint': 'billing_identity',
};

/**
 * Signals that may NOT corroborate, no matter how strongly they fire.
 *
 * `fraud.failed_login_cluster` is not directional: a burst of failed logins
 * usually means the partner is being ATTACKED, not that it is the attacker.
 * Treating it as evidence against the partner would page us about victims.
 *
 * `resource.*` measures volume, and heavy automation is a normal reason to be
 * loud. It is a capacity/abuse-of-plan concern, not evidence of fraud, and
 * folding it in would let two non-fraud observations manufacture a page.
 *
 * These are listed explicitly rather than matched by prefix so a NEW detector
 * in either namespace has to make a deliberate choice rather than silently
 * inheriting paging-grade weight.
 */
export const CORROBORATION_INELIGIBLE = new Set([
  'fraud.failed_login_cluster',
  'resource.enrollment_denied',
  'resource.volume_outlier',
]);

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

  // A partner that already has a real alert this sweep is being paged about
  // anyway; a second synthetic page for the same account is noise.
  const alreadyAlerting = new Set(
    computed.filter((s) => s.severity === 'alert').map((s) => s.partnerId),
  );

  const byPartner = new Map<string, ComputedSignal[]>();
  for (const s of computed) {
    if (s.severity !== 'watch') continue;
    if (s.signalKey.startsWith('invariant.')) continue;
    if (s.signalKey === CORROBORATED_SIGNAL_KEY) continue;
    if (CORROBORATION_INELIGIBLE.has(s.signalKey)) continue;
    if (alreadyAlerting.has(s.partnerId)) continue;
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
    // corroborating axis. Severity is derived through the normal
    // scoreToSeverity so score and severity never contradict each other.
    const base = contributors[0]?.score ?? 0;
    const score = Math.min(100, Math.round(base + perExtraAxis * (bestByAxis.size - 1)));
    const severity = scoreToSeverity(score, cfg);

    // Emit ONLY when the aggregate actually reaches alert. Two weak axes can
    // sum below the threshold (45 + 15 = 60), and a synthetic *watch* row
    // would be pure cost: it notifies nobody, duplicates evidence already
    // visible on the constituent rows, and crowds out the weekly digest's
    // 20-row watch list. The whole purpose of this signal is to page.
    if (severity !== 'alert') continue;

    out.push({
      partnerId,
      signalKey: CORROBORATED_SIGNAL_KEY,
      score,
      severity,
      // Key order matters: index.ts formatSignalAlert reads partnerName, and
      // truncates the serialised evidence at 800 chars — so the human-readable
      // axis summary goes near the front, before the detailed contributors.
      evidence: {
        partnerName: signals.find((s) => s.evidence.partnerName)?.evidence.partnerName ?? 'unknown',
        summary: contributors.map((c) => `${c.axis}:${c.signalKey}=${c.score}`).join(' + '),
        axisCount: bestByAxis.size,
        contributors,
      },
    });
  }
  return out;
}
