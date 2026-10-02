import { describe, expect, it, vi } from 'vitest';
import { makeResolvedModel } from './__fixtures__/resolvedModel';
import type { ResolvedModel } from './resolveModel';
import {
  MAX_CARRIED_RATES,
  liveQueryKey,
  parseTurnBinding,
  rateForServedModel,
  stableJson,
  turnBindingFrom,
  withCarriedRates,
} from './turnBinding';

const STD = { inputCentsPerM: 200, outputCentsPerM: 1000, cacheReadCentsPerM: 20, cacheWriteCentsPerM: 250 };
const FB = { inputCentsPerM: 100, outputCentsPerM: 500, cacheReadCentsPerM: 10, cacheWriteCentsPerM: 125 };

function resolved(over: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    ok: true, surface: 'chat', role: 'default', transport: 'agent_sdk', partnerId: 'p1', orgId: 'o1',
    offering: { id: 'off-1', displayName: 'Sonnet' },
    connection: { id: 'conn-1', kind: 'anthropic_byok', config: {
      source: 'partner', partnerId: 'p1', apiKey: 'k', model: 'claude-sonnet-5-5',
      configId: 'conn-1', configVersion: 3, endpoint: { kind: 'anthropic' } } },
    funding: 'partner_key', logicalModel: 'claude-sonnet-5-5', wireModel: 'claude-sonnet-5-5',
    thinking: 'adaptive',
    wireParams: { thinking: { type: 'adaptive' }, effort: 'medium', betas: [], applied: { effort: 'medium' } },
    options: { effort: 'medium' }, inferenceGeo: null,
    promptProfile: 'claude-standard',
    rateSnapshot: { source: 'linked_platform', standard: STD },
    capabilities: { thinkingMode: 'adaptive', effortLevels: ['medium'], supportsTools: true, supportsVision: false },
    limits: { maxInputTokens: 200000, maxOutputTokens: 64000 },
    configVersion: 3, fellBack: false,
    ...over,
  } as ResolvedModel;
}

describe('liveQueryKey (spec §9.2: reuse only if nothing that shaped the subprocess moved)', () => {
  const base = liveQueryKey(turnBindingFrom(resolved()));
  it.each<[string, Partial<ResolvedModel>]>([
    ['connection id', { connection: { ...resolved().connection, id: 'conn-2' } }],
    ['config_version (key rotation)', { configVersion: 4 }],
    ['catalog revision', { catalogRevisionId: 'rev-9' }],
    ['wire model', { wireModel: 'claude-opus-5-5' }],
    ['effort (fixed at query creation)', {
      wireParams: { thinking: { type: 'adaptive' }, effort: 'high', betas: [], applied: { effort: 'high' } } }],
    ['refusal fallback model', { refusalFallback: {
      offeringId: 'fb', displayName: 'FB', wireModel: 'claude-haiku-4-5',
      wireParams: { betas: [], applied: {} }, options: {}, rateSnapshot: { source: 'linked_platform', standard: FB } } }],
  ])('changes when the %s changes', (_n, over) => {
    expect(liveQueryKey(turnBindingFrom(resolved(over)))).not.toBe(base);
  });

  it('does NOT change when only the price changes (settlement reads the new binding)', () => {
    expect(liveQueryKey(turnBindingFrom(resolved({ rateSnapshot: { source: 'offering', standard: FB } })))).toBe(base);
  });

  it('never carries the API key into the binding or the key', () => {
    const conn = resolved().connection;
    const b = turnBindingFrom(resolved({
      connection: { ...conn, config: { ...conn.config, apiKey: 'sk-secret-material' } },
    }));
    expect(JSON.stringify(b)).not.toContain('sk-secret-material');
    expect(liveQueryKey(b)).not.toContain('sk-secret-material');
  });
});

describe('parseTurnBinding', () => {
  it('round-trips through jsonb', () => {
    const b = turnBindingFrom(resolved());
    expect(parseTurnBinding(JSON.parse(JSON.stringify(b)))).toEqual(b);
  });
  it('round-trips a binding with a refusal fallback and a fast-mode option rate', () => {
    const b = turnBindingFrom(resolved({
      rateSnapshot: { source: 'platform', standard: STD, option: { key: 'speed:fast', rates: FB } },
      refusalFallback: {
        offeringId: 'fb', displayName: 'FB', wireModel: 'claude-haiku-4-5',
        wireParams: { betas: [], applied: {} }, options: {}, rateSnapshot: { source: 'platform', standard: FB } },
    }));
    expect(parseTurnBinding(JSON.parse(JSON.stringify(b)))).toEqual(b);
  });
  it('rejects anything else', () => {
    expect(parseTurnBinding(null)).toBeNull();
    expect(parseTurnBinding({ v: 2 })).toBeNull();
    const b = JSON.parse(JSON.stringify(turnBindingFrom(resolved())));
    expect(parseTurnBinding({ ...b, funding: 'someone_else' })).toBeNull();
    expect(parseTurnBinding({
      ...b, rateSnapshot: { source: 'platform', standard: { ...STD, inputCentsPerM: -1 } },
    })).toBeNull();
  });
});

describe('rateForServedModel', () => {
  const b = turnBindingFrom(resolved({ refusalFallback: {
    offeringId: 'fb', displayName: 'FB', wireModel: 'claude-haiku-4-5',
    wireParams: { betas: [], applied: {} }, options: {}, rateSnapshot: { source: 'linked_platform', standard: FB } } }));
  it('primary → primary rate; fallback → fallback rate', () => {
    expect(rateForServedModel(b, 'claude-sonnet-5-5').standard).toEqual(STD);
    expect(rateForServedModel(b, 'claude-haiku-4-5').standard).toEqual(FB);
  });
  it('an unexpected served model is priced at the primary rate and logged', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(rateForServedModel(b, 'something-else').standard).toEqual(STD);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('stableJson', () => {
  it('is key-order independent and drops undefined', () => {
    expect(stableJson({ b: 1, a: [{ d: 2, c: undefined, e: 'x' }] })).toBe(stableJson({ a: [{ e: 'x', d: 2 }], b: 1 }));
  });
});

describe('carriedRates (W05)', () => {
  const HAIKU_RATE = { source: 'linked_platform' as const, standard: { inputCentsPerM: 100, outputCentsPerM: 500, cacheReadCentsPerM: 10, cacheWriteCentsPerM: 125 } };
  const b = () => turnBindingFrom(makeResolvedModel('anthropic_byok'));   // wire claude-sonnet-5-5

  it('a W03 binding without carriedRates still parses (absent, not [])', () => {
    const parsed = parseTurnBinding(JSON.parse(JSON.stringify(b())));
    expect(parsed).not.toBeNull();
    expect(parsed!.carriedRates).toBeUndefined();
  });
  it('carriedRates round-trip through the jsonb parse (the schema must not strip them)', () => {
    const withCarried = withCarriedRates(b(), [{ wireModel: 'claude-haiku-4-5', rateSnapshot: HAIKU_RATE }]);
    expect(parseTurnBinding(JSON.parse(JSON.stringify(withCarried)))!.carriedRates)
      .toEqual([{ wireModel: 'claude-haiku-4-5', rateSnapshot: HAIKU_RATE }]);
  });
  it('excludes the bound model, de-duplicates (latest wins), caps the list, and never emits []', () => {
    const base = b();
    expect(withCarriedRates(base, [])).toBe(base);
    expect(withCarriedRates(base, [{ wireModel: base.wireModel, rateSnapshot: HAIKU_RATE }])).toBe(base);
    const newer = { ...HAIKU_RATE, standard: { ...HAIKU_RATE.standard, inputCentsPerM: 120 } };
    const out = withCarriedRates(base, [
      { wireModel: 'claude-haiku-4-5', rateSnapshot: HAIKU_RATE },
      { wireModel: 'claude-haiku-4-5', rateSnapshot: newer },
    ]);
    expect(out.carriedRates).toEqual([{ wireModel: 'claude-haiku-4-5', rateSnapshot: newer }]);
    const many = Array.from({ length: 12 }, (_, i) => ({ wireModel: `m-${i}`, rateSnapshot: HAIKU_RATE }));
    expect(withCarriedRates(base, many).carriedRates!.map((c) => c.wireModel)).toEqual(many.slice(-MAX_CARRIED_RATES).map((c) => c.wireModel));
  });
  it('rateForServedModel prices a carried model at its carried rate', () => {
    const out = withCarriedRates(b(), [{ wireModel: 'claude-haiku-4-5', rateSnapshot: HAIKU_RATE }]);
    expect(rateForServedModel(out, 'claude-haiku-4-5')).toBe(HAIKU_RATE);
  });
  it('carriedRates never change the live-query key (a price is not a reason to recreate)', () => {
    const base = b();
    expect(liveQueryKey(withCarriedRates(base, [{ wireModel: 'claude-haiku-4-5', rateSnapshot: HAIKU_RATE }]))).toBe(liveQueryKey(base));
  });
});

describe('W11 promptProfile and W05 carriedRates together', () => {
  it('a switched binding keeps both fields through the persisted JSON round trip', () => {
    const HAIKU = { source: 'linked_platform' as const, standard: { inputCentsPerM: 100, outputCentsPerM: 500, cacheReadCentsPerM: 10, cacheWriteCentsPerM: 125 } };
    const b = withCarriedRates(turnBindingFrom(makeResolvedModel('anthropic_byok', { promptProfile: 'claude-small' })), [
      { wireModel: 'claude-haiku-4-5', rateSnapshot: HAIKU },
    ]);
    const parsed = parseTurnBinding(JSON.parse(JSON.stringify(b)));
    expect(parsed).toMatchObject({ promptProfile: 'claude-small', carriedRates: [{ wireModel: 'claude-haiku-4-5' }] });
    expect(stableJson(parsed)).toBe(stableJson(b));
  });
});

describe('W11 promptProfile on the binding', () => {
  it('turnBindingFrom carries the resolved prompt profile', () => {
    expect(turnBindingFrom(makeResolvedModel('platform', { promptProfile: 'claude-frontier' })).promptProfile).toBe('claude-frontier');
  });
  it('keeps promptProfile through the persisted JSON round trip (W11)', () => {
    // aiBudgetReservations re-binds a reservation when stableJson(parsed stored
    // binding) !== stableJson(new binding). A schema that stripped the field
    // would re-bind every stable-key retry and 409 a settled one.
    const b = turnBindingFrom(makeResolvedModel('anthropic_byok', { promptProfile: 'claude-small' }));
    const parsed = parseTurnBinding(JSON.parse(JSON.stringify(b)));
    expect(parsed).not.toBeNull();
    expect(parsed!.promptProfile).toBe('claude-small');
    expect(stableJson(parsed)).toBe(stableJson(b));
  });
  it('a binding persisted before W11 (no promptProfile) still parses', () => {
    const { promptProfile: _p, ...legacy } = turnBindingFrom(makeResolvedModel('platform'));
    expect(parseTurnBinding(JSON.parse(JSON.stringify(legacy)))).toMatchObject({ v: 1, wireModel: 'claude-sonnet-5-5' });
  });
  it('rejects a promptProfile outside PROMPT_PROFILES', () => {
    const b = { ...turnBindingFrom(makeResolvedModel('platform')), promptProfile: 'claude-huge' };
    expect(parseTurnBinding(JSON.parse(JSON.stringify(b)))).toBeNull();
  });
});

describe('W09 failover on the binding', () => {
  it('carries the resolver\'s failover facts and round-trips them', () => {
    const b = turnBindingFrom(makeResolvedModel('anthropic_byok', {
      failover: { fromOfferingId: 'off-0', hop: 1, cause: 'overloaded' },
    }));
    expect(b.failover).toEqual({ fromOfferingId: 'off-0', hop: 1, cause: 'overloaded' });
    expect(parseTurnBinding(JSON.parse(JSON.stringify(b)))?.failover).toEqual(b.failover);
  });

  it('a binding with no failover carries no key at all (byte-identical to W03/W05 for the stable-key re-bind)', () => {
    const b = turnBindingFrom(makeResolvedModel('platform'));
    expect('failover' in b).toBe(false);
    expect(parseTurnBinding(JSON.parse(JSON.stringify(b)))).not.toBeNull();
  });

  it('rejects a malformed failover (hop 0, unknown cause)', () => {
    const b = turnBindingFrom(makeResolvedModel('platform'));
    expect(parseTurnBinding({ ...b, failover: { fromOfferingId: null, hop: 0, cause: 'overloaded' } })).toBeNull();
    expect(parseTurnBinding({ ...b, failover: { fromOfferingId: null, hop: 1, cause: 'flaky' } })).toBeNull();
  });

  it('failover is not part of the live-query key (the wire model already differs)', () => {
    const a = turnBindingFrom(makeResolvedModel('platform'));
    const b = turnBindingFrom(makeResolvedModel('platform', { failover: { fromOfferingId: 'x', hop: 1, cause: 'cooldown' } }));
    expect(liveQueryKey(a)).toBe(liveQueryKey(b));
  });
});
