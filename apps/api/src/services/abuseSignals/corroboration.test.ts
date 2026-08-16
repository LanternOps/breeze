import { describe, it, expect } from 'vitest';
import { loadSignalConfig, scoreToSeverity } from './config';
import {
  computeCorroborationSignals,
  axisFor,
  SIGNAL_AXIS,
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

  it('is idempotent — re-running over its own output adds nothing', () => {
    const first = computeCorroborationSignals(
      [
        watch('p1', 'rmm.session_intensity', 65),
        watch('p1', 'billing.cardholder_name_mismatch', 55),
      ],
      cfg,
    );
    const second = computeCorroborationSignals(
      [
        watch('p1', 'rmm.session_intensity', 65),
        watch('p1', 'billing.cardholder_name_mismatch', 55),
        ...first,
      ],
      cfg,
    );
    expect(second).toHaveLength(1);
    expect(second[0]!.score).toBe(first[0]!.score);
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

  it('stays watch rather than claiming an alert its score contradicts', () => {
    // Lowering per_extra_axis must demote the result, not produce a severity
    // that disagrees with the score.
    const timid = { ...cfg, 'fraud.corroborated_watch.per_extra_axis': 1 };
    const out = computeCorroborationSignals(
      [
        watch('p1', 'billing.cardholder_name_mismatch', 55),
        watch('p1', 'rmm.consumer_devices', 50),
      ],
      timid,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.score).toBe(56);
    expect(out[0]!.severity).toBe('watch');
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
    'fraud.failed_login_cluster',
    'resource.enrollment_denied',
    'resource.volume_outlier',
  ];

  it.each(EMITTED_KEYS)('%s has an explicit axis', (key) => {
    expect(SIGNAL_AXIS[key]).toBeDefined();
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
