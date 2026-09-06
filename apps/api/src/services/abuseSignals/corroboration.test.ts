import { describe, it, expect } from 'vitest';
import { loadSignalConfig, scoreToSeverity } from './config';
import {
  computeCorroborationSignals,
  axisFor,
  SIGNAL_AXIS,
  CORROBORATION_INELIGIBLE,
  CORROBORATED_SIGNAL_KEY,
} from './corroboration';
import type { ComputedSignal } from './types';

const cfg = loadSignalConfig();

function watch(partnerId: string, signalKey: string, score: number): ComputedSignal {
  return {
    partnerId,
    signalKey,
    score,
    severity: scoreToSeverity(score, cfg),
    evidence: { partnerName: 'Acme' },
  };
}

describe('computeCorroborationSignals', () => {
  it('counts the two origin-IP signals as ONE axis', () => {
    // They restate one observation — this partner works from infrastructure a
    // suspended operator used — measured at two strengths. The scorer today
    // suppresses the weaker row when the exact match fires, so this pair
    // cannot co-occur in practice; the mapping exists so that relaxing that
    // suppression can never silently manufacture an alert from a single fact.
    const out = computeCorroborationSignals(
      [
        watch('p1', 'fraud.suspended_console_ip', 65),
        watch('p1', 'fraud.dead_account_probe_origin', 55),
      ],
      cfg,
    );
    expect(out).toEqual([]);
  });

  it('lets an origin-IP signal corroborate a billing signal', () => {
    // The pair that would have caught the 08-31 re-establishment: an
    // infrastructure axis and an identity axis are genuinely independent.
    const out = computeCorroborationSignals(
      [
        watch('p1', 'fraud.dead_account_probe_origin', 55),
        watch('p1', 'billing.cardholder_name_mismatch', 55),
      ],
      cfg,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe('alert');
    expect(out[0]!.evidence.axisCount).toBe(2);
  });

  it('promotes two capped watch signals on independent axes to an alert', () => {
    // The onlineAccount-Statement shape: session_intensity 65 was the only
    // signal anyone looked at, and cardholder_name_mismatch 55 sat beside it.
    // Both are watch, so neither notified; together they are two axes.
    const out = computeCorroborationSignals(
      [
        watch('p1', 'rmm.session_intensity', 65),
        watch('p1', 'billing.cardholder_name_mismatch', 55),
      ],
      cfg,
    );

    expect(out).toHaveLength(1);
    expect(out[0]!.signalKey).toBe(CORROBORATED_SIGNAL_KEY);
    expect(out[0]!.partnerId).toBe('p1');
    // 65 anchor + 15 for the second independent axis.
    expect(out[0]!.score).toBe(80);
    expect(out[0]!.severity).toBe('alert');
    expect(out[0]!.evidence.axisCount).toBe(2);
    expect(out[0]!.evidence.partnerName).toBe('Acme');
  });

  it('does NOT corroborate two signals that restate one observation', () => {
    // enrollment_ip_spread and device_ip_scatter share the ip_scatter axis:
    // they are the same fact about a residential-serving MSP.
    const out = computeCorroborationSignals(
      [
        watch('p1', 'rmm.enrollment_ip_spread', 60),
        watch('p1', 'rmm.device_ip_scatter', 55),
      ],
      cfg,
    );
    expect(out).toHaveLength(0);
  });

  it('takes the stronger score when one axis fires twice, and still needs a second axis', () => {
    const out = computeCorroborationSignals(
      [
        watch('p1', 'rmm.enrollment_ip_spread', 50),
        watch('p1', 'rmm.device_ip_scatter', 60),
        watch('p1', 'rmm.session_intensity', 45),
      ],
      cfg,
    );
    expect(out).toHaveLength(1);
    // anchor is the strongest single axis (ip_scatter 60), not the sum of the
    // two ip_scatter signals.
    expect(out[0]!.score).toBe(75);
    expect(out[0]!.evidence.axisCount).toBe(2);
  });

  it('never fires on a single axis', () => {
    expect(
      computeCorroborationSignals([watch('p1', 'billing.cardholder_name_mismatch', 60)], cfg),
    ).toHaveLength(0);
  });

  it('ignores alert-severity signals — they already notify on their own', () => {
    const alert: ComputedSignal = {
      partnerId: 'p1',
      signalKey: 'rmm.remote_access_installer',
      score: 100,
      severity: 'alert',
      evidence: { partnerName: 'Acme' },
    };
    const out = computeCorroborationSignals(
      [alert, watch('p1', 'rmm.session_intensity', 65)],
      cfg,
    );
    expect(out).toHaveLength(0);
  });

  it('ignores info-tier signals', () => {
    const out = computeCorroborationSignals(
      [watch('p1', 'rmm.session_intensity', 65), watch('p1', 'billing.card_testing', 10)],
      cfg,
    );
    expect(out).toHaveLength(0);
  });

  it('excludes invariant.* signals as corroborators', () => {
    const invariant: ComputedSignal = {
      partnerId: 'p1',
      signalKey: 'invariant.active_unverified_email',
      score: 50,
      severity: 'watch',
      evidence: { partnerName: 'Acme' },
    };
    const out = computeCorroborationSignals(
      [invariant, watch('p1', 'rmm.session_intensity', 65)],
      cfg,
    );
    expect(out).toHaveLength(0);
  });

  it('scores independently per partner and does not leak across partners', () => {
    const out = computeCorroborationSignals(
      [
        watch('p1', 'rmm.session_intensity', 65),
        watch('p2', 'billing.cardholder_name_mismatch', 55),
      ],
      cfg,
    );
    expect(out).toHaveLength(0);
  });

  it('clamps at 100 with many axes', () => {
    const out = computeCorroborationSignals(
      [
        watch('p1', 'rmm.session_intensity', 65),
        watch('p1', 'billing.cardholder_name_mismatch', 55),
        watch('p1', 'rmm.consumer_devices', 60),
        watch('p1', 'rmm.device_ip_scatter', 55),
        watch('p1', 'fraud.failed_login_cluster', 50),
        watch('p1', 'resource.volume_outlier', 45),
      ],
      cfg,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.score).toBe(100);
    expect(out[0]!.severity).toBe('alert');
  });

  it('does not stack when re-run over its own output', () => {
    // Feeding the synthetic signal back in must not produce a second one.
    // (Its own alert severity trips the already-alerting suppression, which
    // is the desired outcome either way.)
    const first = computeCorroborationSignals(
      [
        watch('p1', 'rmm.session_intensity', 65),
        watch('p1', 'billing.cardholder_name_mismatch', 55),
      ],
      cfg,
    );
    expect(first).toHaveLength(1);

    const second = computeCorroborationSignals(
      [
        watch('p1', 'rmm.session_intensity', 65),
        watch('p1', 'billing.cardholder_name_mismatch', 55),
        ...first,
      ],
      cfg,
    );
    expect(second).toHaveLength(0);
  });

  it('respects a raised min_axes override', () => {
    const strict = { ...cfg, 'fraud.corroborated_watch.min_axes': 3 };
    const out = computeCorroborationSignals(
      [
        watch('p1', 'rmm.session_intensity', 65),
        watch('p1', 'billing.cardholder_name_mismatch', 55),
      ],
      strict,
    );
    expect(out).toHaveLength(0);
  });

  it('emits nothing rather than a synthetic watch when the aggregate misses alert', () => {
    // Two weak axes: 45 + 15 = 60, below the 70 alert threshold. A synthetic
    // watch row would notify nobody and crowd the digest's 20-row watch list.
    const out = computeCorroborationSignals(
      [
        watch('p1', 'rmm.provider_default_hostname', 45),
        watch('p1', 'rmm.device_ip_scatter', 45),
      ],
      cfg,
    );
    expect(out).toHaveLength(0);
  });

  it('emits nothing when per_extra_axis is lowered below the alert threshold', () => {
    const timid = { ...cfg, 'fraud.corroborated_watch.per_extra_axis': 1 };
    const out = computeCorroborationSignals(
      [
        watch('p1', 'billing.cardholder_name_mismatch', 55),
        watch('p1', 'rmm.consumer_devices', 50),
      ],
      timid,
    );
    expect(out).toHaveLength(0);
  });

  it('never emits a non-alert signal for any input', () => {
    const out = computeCorroborationSignals(
      [
        watch('p1', 'rmm.provider_default_hostname', 41),
        watch('p1', 'rmm.device_ip_scatter', 42),
        watch('p2', 'billing.card_testing', 40),
        watch('p2', 'rmm.consumer_devices', 44),
        watch('p3', 'rmm.session_intensity', 65),
        watch('p3', 'billing.cardholder_name_mismatch', 55),
      ],
      cfg,
    );
    expect(out.every((s) => s.severity === 'alert')).toBe(true);
  });

  it('leads the evidence with a compact axis summary for the 800-char alert body', () => {
    const out = computeCorroborationSignals(
      [
        watch('p1', 'rmm.session_intensity', 65),
        watch('p1', 'billing.cardholder_name_mismatch', 55),
      ],
      cfg,
    );
    expect(out[0]!.evidence.summary).toBe(
      'enrollment_burst:rmm.session_intensity=65 + billing_identity:billing.cardholder_name_mismatch=55',
    );
    // partnerName and summary must survive truncation of the serialised body.
    const keys = Object.keys(out[0]!.evidence);
    expect(keys.indexOf('partnerName')).toBeLessThan(keys.indexOf('contributors'));
    expect(keys.indexOf('summary')).toBeLessThan(keys.indexOf('contributors'));
  });
});

describe('corroboration eligibility', () => {
  it('does not let a failed-login burst corroborate — the partner may be the victim', () => {
    const out = computeCorroborationSignals(
      [
        watch('p1', 'fraud.failed_login_cluster', 65),
        watch('p1', 'rmm.consumer_devices', 60),
      ],
      cfg,
    );
    expect(out).toHaveLength(0);
  });

  it('does not let resource-volume signals corroborate — heavy automation is normal', () => {
    const out = computeCorroborationSignals(
      [
        watch('p1', 'resource.volume_outlier', 65),
        watch('p1', 'resource.enrollment_denied', 60),
      ],
      cfg,
    );
    expect(out).toHaveLength(0);
  });

  it('suppresses the synthetic page when the partner already has a direct alert', () => {
    const direct: ComputedSignal = {
      partnerId: 'p1',
      signalKey: 'rmm.remote_access_installer',
      score: 100,
      severity: 'alert',
      evidence: { partnerName: 'Acme' },
    };
    const out = computeCorroborationSignals(
      [
        direct,
        watch('p1', 'rmm.session_intensity', 65),
        watch('p1', 'billing.cardholder_name_mismatch', 55),
      ],
      cfg,
    );
    expect(out).toHaveLength(0);
  });

  it('treats the enrollment burst and fast enroll-to-remote as ONE axis', () => {
    // A legitimate onboarding bulk-enrolls and immediately connects to each
    // box, firing both. They must not corroborate each other.
    expect(axisFor('rmm.session_intensity')).toBe(axisFor('rmm.enrollment_velocity'));
    const out = computeCorroborationSignals(
      [
        watch('p1', 'rmm.session_intensity', 65),
        watch('p1', 'rmm.enrollment_velocity', 60),
      ],
      cfg,
    );
    expect(out).toHaveLength(0);
  });
});

describe('SIGNAL_AXIS coverage', () => {
  // Every key the sweep can emit must be mapped, or it silently becomes its
  // own axis and can double-count against a sibling that restates it.
  const EMITTED_KEYS = [
    'rmm.consumer_devices',
    'rmm.enrollment_velocity',
    'rmm.session_intensity',
    'rmm.enrollment_ip_spread',
    'rmm.provider_default_hostname',
    'rmm.device_ip_scatter',
    'rmm.remote_access_installer',
    'rmm.unbranded_installer',
    'rmm.shared_installer_host',
    'billing.cardholder_name_mismatch',
    'billing.shared_card_fingerprint',
    'billing.card_testing',
    'fraud.suspended_console_ip',
    'fraud.dead_account_probe_origin',
    'rmm.recidivist_endpoint',
    'fraud.failed_login_cluster',
    'resource.enrollment_denied',
    'resource.volume_outlier',
  ];

  it.each(EMITTED_KEYS)('%s is either mapped to an axis or explicitly ineligible', (key) => {
    // The invariant that matters: no emitted key may fall through to the
    // "own axis" default, which would silently make it paging-grade
    // corroboration without anyone deciding that.
    const decided = SIGNAL_AXIS[key] !== undefined || CORROBORATION_INELIGIBLE.has(key);
    expect(decided).toBe(true);
  });

  it('keeps the two sets disjoint', () => {
    for (const key of CORROBORATION_INELIGIBLE) {
      expect(SIGNAL_AXIS[key]).toBeUndefined();
    }
  });

  it('groups the two IP-scatter signals onto one axis', () => {
    expect(axisFor('rmm.enrollment_ip_spread')).toBe(axisFor('rmm.device_ip_scatter'));
  });

  it('keeps session and billing identity on separate axes', () => {
    expect(axisFor('rmm.session_intensity')).not.toBe(axisFor('billing.cardholder_name_mismatch'));
  });

  it('falls back to the signal key itself for an unmapped detector', () => {
    expect(axisFor('rmm.brand_new_detector')).toBe('rmm.brand_new_detector');
  });
});
