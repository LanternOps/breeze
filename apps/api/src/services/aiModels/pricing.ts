/**
 * AI model registry (spec §8): one cost function over one resolved rate
 * snapshot. W01 introduces it; aiCostTracker's token-based fallback reads it.
 * W03 makes it the only cost path. Pure; no I/O.
 */
import type { ModelRates, OfferingOptions, OptionRates } from '@breeze/shared';

export type RateSnapshot = {
  source: 'platform' | 'offering' | 'catalog' | 'linked_platform';
  standard: ModelRates;
  option?: { key: 'speed:fast'; rates: ModelRates };
};

export type TokenComponents = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** A non-standard variant was used but the snapshot has no rate for it (spec §8: never guess). */
export class UnpricedOptionError extends Error {
  constructor(readonly optionKey: 'speed:fast') {
    super(`No rate for option variant "${optionKey}"; the call can't be priced.`);
    this.name = 'UnpricedOptionError';
  }
}

function assertTokens(tokens: TokenComponents): void {
  for (const [name, value] of Object.entries(tokens)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`priceInvocation: ${name} tokens must be a non-negative finite number, got ${String(value)}`);
    }
  }
}

/** Unrounded cents. Summed in W00's order (input, output, cache read, cache write) for bit parity. */
export function computeInvocationCents(rate: RateSnapshot, tokens: TokenComponents, applied: OfferingOptions): number {
  assertTokens(tokens);
  let rates = rate.standard;
  if (applied.speed === 'fast') {
    if (rate.option?.key !== 'speed:fast') throw new UnpricedOptionError('speed:fast');
    rates = rate.option.rates;
  }
  return (tokens.input / 1_000_000) * rates.inputCentsPerM
    + (tokens.output / 1_000_000) * rates.outputCentsPerM
    + (tokens.cacheRead / 1_000_000) * rates.cacheReadCentsPerM
    + (tokens.cacheWrite / 1_000_000) * rates.cacheWriteCentsPerM;
}

/** Cents, rounded to 6 decimal places (the precision of `ai_sessions.total_cost_cents`). */
export function priceInvocation(rate: RateSnapshot, tokens: TokenComponents, applied: OfferingOptions): number {
  return Math.round(computeInvocationCents(rate, tokens, applied) * 1_000_000) / 1_000_000;
}

/** A platform row's snapshot, or null when the row is unpriced. */
export function platformRateSnapshot(model: { rates: ModelRates | null; optionRates: OptionRates | null }): RateSnapshot | null {
  if (!model.rates) return null;
  const fast = model.optionRates?.['speed:fast'];
  return fast
    ? { source: 'platform', standard: model.rates, option: { key: 'speed:fast', rates: fast } }
    : { source: 'platform', standard: model.rates };
}
