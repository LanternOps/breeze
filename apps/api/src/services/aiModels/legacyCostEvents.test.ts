import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetLegacyCostListenersForTests, emitLegacyCostRecorded, onLegacyCostRecorded, type LegacyCostEvent } from './legacyCostEvents';

const event: LegacyCostEvent = {
  orgId: 'org', sessionId: null, model: 'claude-sonnet-5-5', billingSource: 'platform', catalogPricing: null,
  tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, legacyCostCents: 0.007, legacyAdditionalCostCents: 0,
  legacyCostSource: 'model_pricing', sdkReportedCostUsd: null, ledger: { surface: 'catalog_enrichment' },
};

afterEach(() => __resetLegacyCostListenersForTests());

describe('legacyCostEvents (#7600 W02)', () => {
  it('is a no-op with no listener (every existing tracker unit test runs this way)', () => {
    expect(() => emitLegacyCostRecorded(event)).not.toThrow();
  });

  it('delivers to listeners and supports unsubscribe', () => {
    const seen: LegacyCostEvent[] = [];
    const off = onLegacyCostRecorded((e) => seen.push(e));
    emitLegacyCostRecorded(event);
    off();
    emitLegacyCostRecorded(event);
    expect(seen).toEqual([event]);
  });

  it('never throws into the caller, even when a listener does', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    onLegacyCostRecorded(() => { throw new Error('boom'); });
    expect(() => emitLegacyCostRecorded(event)).not.toThrow();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
