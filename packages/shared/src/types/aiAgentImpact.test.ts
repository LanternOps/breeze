import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IMPACT_WEIGHTS, AI_AGENT_IMPACT_COUNTER_KEYS,
  resolveImpactWeights, normalizeImpactWeightOverrides, estimateSecondsSaved,
  type AiAgentImpactCounters,
} from './aiAgentImpact';

const zeroCounters = (): AiAgentImpactCounters =>
  Object.fromEntries(AI_AGENT_IMPACT_COUNTER_KEYS.map((k) => [k, 0])) as AiAgentImpactCounters;

describe('resolveImpactWeights', () => {
  it('returns the defaults for null, undefined and a non-object', () => {
    for (const stored of [null, undefined, 42, 'x', []]) {
      expect(resolveImpactWeights(stored)).toEqual(DEFAULT_IMPACT_WEIGHTS);
    }
  });
  it('merges a PARTIAL override onto the defaults', () => {
    expect(resolveImpactWeights({ fixExecuted: 1200 })).toEqual({
      ...DEFAULT_IMPACT_WEIGHTS, fixExecuted: 1200,
    });
  });
  it('accepts an explicit 0 (a partner may price an outcome at nothing)', () => {
    expect(resolveImpactWeights({ noiseFlagged: 0 }).noiseFlagged).toBe(0);
  });
  it('drops out-of-range, non-integer, negative and unknown keys', () => {
    expect(resolveImpactWeights({
      alertJudged: -1, noiseFlagged: 86_401, ticketTriaged: 1.5, bogus: 10,
    })).toEqual(DEFAULT_IMPACT_WEIGHTS);
  });
});

describe('normalizeImpactWeightOverrides', () => {
  it('returns null when nothing valid survives', () => {
    expect(normalizeImpactWeightOverrides({ bogus: 1 })).toBeNull();
    expect(normalizeImpactWeightOverrides(null)).toBeNull();
  });
  it('keeps only the valid subset', () => {
    expect(normalizeImpactWeightOverrides({ draftSent: 120, bogus: 1, fixExecuted: -3 }))
      .toEqual({ draftSent: 120 });
  });
});

describe('estimateSecondsSaved', () => {
  it('prices exactly the six priced counters and ignores the other four', () => {
    // Non-uniform on purpose: a wrong-counter bug must change the total.
    const counters: AiAgentImpactCounters = {
      ...zeroCounters(),
      alertsJudged: 2, noiseFlagged: 3, ticketsTriaged: 5, draftsSent: 7,
      fixesExecuted: 11, narrativesDelivered: 13,
      suppressionsApplied: 1000, fixesProposed: 1000,
      fixWatchesHeld: 1000, fixWatchesRecurred: 1000,
    };
    expect(estimateSecondsSaved(counters, DEFAULT_IMPACT_WEIGHTS)).toBe(
      2 * 90 + 3 * 240 + 5 * 360 + 7 * 300 + 11 * 900 + 13 * 1800,
    );
  });
  it('is 0 for an all-zero day', () => {
    expect(estimateSecondsSaved(zeroCounters(), DEFAULT_IMPACT_WEIGHTS)).toBe(0);
  });
});
