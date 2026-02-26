import { describe, expect, it, vi } from 'vitest';

vi.mock('./eventBus', () => ({
  publishEvent: vi.fn(async () => 'evt-1')
}));

import { publishEvent } from './eventBus';
import {
  classifyUserRiskSeverity,
  computeUserRiskScoreFromFactors,
  deriveUserRiskTrendDirection,
  normalizeUserRiskInterventions,
  normalizeUserRiskThresholds,
  normalizeUserRiskWeights,
  publishUserRiskScoreEvents
} from './userRiskScoring';

describe('userRiskScoring helpers', () => {
  it('normalizes weights and preserves deterministic scoring', () => {
    const weights = normalizeUserRiskWeights({
      mfaRisk: 2,
      authFailureRisk: 3,
      threatExposureRisk: 5
    });
    const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
    expect(Math.abs(total - 1)).toBeLessThan(0.02);

    const factors = {
      mfaRisk: 80,
      authFailureRisk: 60,
      sessionAnomalyRisk: 40,
      threatExposureRisk: 50,
      softwareViolationRisk: 30,
      deviceSecurityRisk: 20,
      staleAccessRisk: 10,
      recentImpactRisk: 70
    };

    const first = computeUserRiskScoreFromFactors(factors, weights);
    const second = computeUserRiskScoreFromFactors(factors, weights);
    expect(first).toBe(second);
  });

  it('applies threshold normalization and risk severity classification', () => {
    const thresholds = normalizeUserRiskThresholds({
      medium: 45,
      high: 75,
      critical: 92
    });

    expect(classifyUserRiskSeverity(40, thresholds)).toBe('low');
    expect(classifyUserRiskSeverity(60, thresholds)).toBe('medium');
    expect(classifyUserRiskSeverity(80, thresholds)).toBe('high');
    expect(classifyUserRiskSeverity(95, thresholds)).toBe('critical');
  });

  it('derives trend direction from score deltas', () => {
    expect(deriveUserRiskTrendDirection(null, 50)).toBe('stable');
    expect(deriveUserRiskTrendDirection(50, 55)).toBe('up');
    expect(deriveUserRiskTrendDirection(50, 45)).toBe('down');
    expect(deriveUserRiskTrendDirection(50, 52)).toBe('stable');
  });
});

describe('publishUserRiskScoreEvents', () => {
  it('publishes high and spike events when enabled', async () => {
    const result = await publishUserRiskScoreEvents({
      orgId: '00000000-0000-0000-0000-000000000001',
      changedUsers: [
        {
          userId: '00000000-0000-0000-0000-000000000010',
          score: 88,
          previousScore: 60,
          delta: 28,
          trendDirection: 'up',
          crossedHighThreshold: true,
          spiked: true
        }
      ],
      thresholds: { high: 70, spikeDelta: 15 },
      interventions: normalizeUserRiskInterventions({
        notifyOnHighRisk: true,
        notifyOnRiskSpike: true
      })
    });

    expect(result.publishedHigh).toBe(1);
    expect(result.publishedSpikes).toBe(1);
    expect(result.failed).toBe(0);
    expect(vi.mocked(publishEvent)).toHaveBeenCalledTimes(2);
  });

  it('respects intervention flags and suppresses notifications', async () => {
    vi.mocked(publishEvent).mockClear();

    const result = await publishUserRiskScoreEvents({
      orgId: '00000000-0000-0000-0000-000000000001',
      changedUsers: [
        {
          userId: '00000000-0000-0000-0000-000000000010',
          score: 88,
          previousScore: 60,
          delta: 28,
          trendDirection: 'up',
          crossedHighThreshold: true,
          spiked: true
        }
      ],
      thresholds: { high: 70, spikeDelta: 15 },
      interventions: normalizeUserRiskInterventions({
        notifyOnHighRisk: false,
        notifyOnRiskSpike: false
      })
    });

    expect(result.publishedHigh).toBe(0);
    expect(result.publishedSpikes).toBe(0);
    expect(vi.mocked(publishEvent)).not.toHaveBeenCalled();
  });
});
