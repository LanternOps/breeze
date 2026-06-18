import { describe, expect, it } from 'vitest';

import { __testOnly } from './remediationSuggestions';

describe('remediation suggestion heuristics', () => {
  it('maps network egress anomalies to network/security remediation terms', () => {
    const terms = __testOnly.termsForSource({
      sourceType: 'anomaly',
      sourceId: 'anomaly-1',
      orgId: 'org-1',
      deviceId: 'dev-1',
      alertId: null,
      anomalyId: 'anomaly-1',
      correlationGroupId: null,
      rcaId: null,
      title: 'network_egress on bandwidth_out_bps',
      text: 'network_egress network bandwidth_out_bps',
      anomalyType: 'network_egress',
      metricName: 'bandwidth_out_bps',
    });

    expect(terms).toEqual(expect.arrayContaining(['network', 'egress', 'security']));
  });

  it('scores script library candidates by matched terms', () => {
    const result = __testOnly.scoreCandidate('disk cleanup temp storage maintenance', ['disk', 'cleanup', 'network']);

    expect(result.matchedTerms).toEqual(['disk', 'cleanup']);
    expect(result.score).toBeCloseTo(2 / 3);
  });

  it('raises risk for destructive or restart-style actions', () => {
    const context = {
      sourceType: 'alert' as const,
      sourceId: 'alert-1',
      orgId: 'org-1',
      deviceId: 'dev-1',
      alertId: 'alert-1',
      anomalyId: null,
      correlationGroupId: null,
      rcaId: null,
      title: 'Disk full',
      text: 'disk full',
      severity: 'critical',
    };

    expect(__testOnly.riskTierForCandidate(context, 'delete temp cleanup')).toBe('high');
    expect(__testOnly.riskTierForCandidate(context, 'restart service')).toBe('medium');
  });

  it('builds RCA suggestion context from correlation group metadata', () => {
    const context = __testOnly.rcaContextFromCorrelationGroup({
      id: 'group-1',
      orgId: 'org-1',
      rootAlertId: 'alert-1',
      groupKey: 'site:server-room',
      status: 'open',
      metadata: {
        logCorrelationRuleNames: ['Service crash burst'],
        logPatterns: ['service crashed'],
        flappingDetected: true,
      },
    }, {
      sourceType: 'rca',
      sourceId: 'group-1',
      orgId: 'org-1',
      deviceId: 'dev-1',
    });

    expect(context).toMatchObject({
      sourceType: 'rca',
      sourceId: 'group-1',
      orgId: 'org-1',
      deviceId: 'dev-1',
      alertId: 'alert-1',
      correlationGroupId: 'group-1',
      rcaId: 'group-1',
      title: 'RCA for correlation group site:server-room',
    });
    expect(context.text).toContain('service crash burst');
    expect(context.text).toContain('service crashed');
    expect(context.text).toContain('flappingdetected');
  });
});
