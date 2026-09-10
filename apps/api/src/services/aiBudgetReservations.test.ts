import { describe, expect, it, vi } from 'vitest';
import { maxOutputTokensForAiBudget } from './aiBudgetReservations';

describe('maxOutputTokensForAiBudget', () => {
  it('keeps the provider ceiling for an unlimited reservation', () => {
    const calculateCostCents = vi.fn(() => 999);
    expect(maxOutputTokensForAiBudget({
      prompt: 'hello',
      requestedMaxOutputTokens: 1024,
      budgetCents: undefined,
      calculateCostCents,
    })).toBe(1024);
    expect(calculateCostCents).not.toHaveBeenCalled();
  });

  it('reduces output tokens so the conservative request cannot exceed the reservation', () => {
    const calculateCostCents = (inputTokens: number, outputTokens: number) =>
      inputTokens * 0.01 + outputTokens * 0.1;
    const cap = maxOutputTokensForAiBudget({
      prompt: 'hello',
      requestedMaxOutputTokens: 1024,
      budgetCents: 30,
      calculateCostCents,
    });
    expect(cap).not.toBeNull();
    const conservativeInputTokens = Buffer.byteLength('hello', 'utf8') + 256;
    expect(calculateCostCents(conservativeInputTokens, cap!)).toBeLessThanOrEqual(30);
    expect(calculateCostCents(conservativeInputTokens, cap! + 1)).toBeGreaterThan(30);
  });

  it('fails closed when the prompt alone consumes the reservation', () => {
    expect(maxOutputTokensForAiBudget({
      prompt: 'large request',
      requestedMaxOutputTokens: 1024,
      budgetCents: 1,
      calculateCostCents: () => 2,
    })).toBeNull();
  });
});
