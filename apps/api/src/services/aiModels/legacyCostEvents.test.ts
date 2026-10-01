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

  it('logs only the scrubbed message of a listener error, never the raw error object', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const leaky = Object.assign(new Error('Failed query: insert … params: leaky-param-value'), {
      cause: Object.assign(new Error('permission denied'), { code: '42501' }),
    });
    onLegacyCostRecorded(() => { throw leaky; });
    emitLegacyCostRecorded(event);
    const args = error.mock.calls[0]!;
    expect(args.some((a) => a === leaky || a instanceof Error)).toBe(false);
    expect(JSON.stringify(args)).not.toContain('leaky-param-value');
    expect(JSON.stringify(args)).toContain('SQLSTATE 42501');
    error.mockRestore();
  });
});
