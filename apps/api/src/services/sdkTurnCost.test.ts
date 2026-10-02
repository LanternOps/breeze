import { describe, it, expect, vi, beforeEach } from 'vitest';

const { calculateCostCentsMock } = vi.hoisted(() => ({
  calculateCostCentsMock: vi.fn(() => 7.5),
}));
vi.mock('./aiCostTracker', () => ({ calculateCostCents: calculateCostCentsMock }));

import { sdkTurnCostFromRunningTotal, type SdkTurnCostInput } from './sdkTurnCost';

const usage = {
  input_tokens: 300,
  output_tokens: 20,
  cache_read_input_tokens: 4000,
  cache_creation_input_tokens: 50,
};

function input(overrides: Partial<SdkTurnCostInput>): SdkTurnCostInput {
  return {
    reportedTotalUsd: 0,
    baselineUsd: undefined,
    totalCarriesPriorCost: false,
    model: 'claude-sonnet-5-5',
    usage,
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('sdkTurnCostFromRunningTotal (#7667)', () => {
  it('bills the whole total on the first result of a fresh query', () => {
    expect(sdkTurnCostFromRunningTotal(input({ reportedTotalUsd: 0.001637 }))).toEqual({
      turnCostUsd: 0.001637,
      baselineUsd: 0.001637,
    });
    expect(calculateCostCentsMock).not.toHaveBeenCalled();
  });

  it('bills the delta on later results of the same query (live SDK numbers)', () => {
    // Observed against SDK 0.3.286: turn 1 total 0.001637, turn 2 total 0.002473.
    const r = sdkTurnCostFromRunningTotal(input({ reportedTotalUsd: 0.002473, baselineUsd: 0.001637 }));
    expect(r.turnCostUsd).toBeCloseTo(0.000836, 12);
    expect(r.baselineUsd).toBe(0.002473);
  });

  it('prices the first result of a resumed query from its own usage', () => {
    const r = sdkTurnCostFromRunningTotal(input({ reportedTotalUsd: 0.003533, totalCarriesPriorCost: true }));
    expect(calculateCostCentsMock).toHaveBeenCalledWith('claude-sonnet-5-5', 300, 20, 4000, 50);
    expect(r).toEqual({ turnCostUsd: 0.075, baselineUsd: 0.003533 });
  });

  it('uses the delta for later results of a resumed query', () => {
    const r = sdkTurnCostFromRunningTotal(input({ reportedTotalUsd: 0.6, baselineUsd: 0.5, totalCarriesPriorCost: true }));
    expect(r.turnCostUsd).toBeCloseTo(0.1, 12);
    expect(calculateCostCentsMock).not.toHaveBeenCalled();
  });

  it('never returns a negative cost and never lowers the baseline', () => {
    expect(sdkTurnCostFromRunningTotal(input({ reportedTotalUsd: 0.04, baselineUsd: 0.05 }))).toEqual({
      turnCostUsd: 0,
      baselineUsd: 0.05,
    });
  });

  it.each([undefined, null, Number.NaN, -1])('bills 0 and keeps the baseline when the total is %s', (bad) => {
    expect(sdkTurnCostFromRunningTotal(input({ reportedTotalUsd: bad, baselineUsd: 0.02 }))).toEqual({
      turnCostUsd: 0,
      baselineUsd: 0.02,
    });
    expect(calculateCostCentsMock).not.toHaveBeenCalled();
  });
});
