import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  inserted: [] as Array<Record<string, unknown>>,
  session: null as null | Record<string, unknown>,
  partnerId: 'partner-1' as string | null,
  compat: null as null | { id: string; configVersion: number },
  offeringId: null as string | null,
  offering: null as null | Record<string, unknown>,
  platform: null as null | Record<string, unknown>,
  scope: 'system' as string | undefined,
  afterExit: [] as Array<{ label: string; work: () => unknown }>,
}));

vi.mock('../../db', () => ({
  db: {
    insert: vi.fn(() => ({ values: vi.fn((v: Record<string, unknown>) => { state.inserted.push(v); return { returning: vi.fn(async () => [{ id: 'inv-1' }]) }; }) })),
    select: vi.fn(() => ({ from: vi.fn((table: { [k: symbol]: unknown }) => ({ where: vi.fn(() => ({ limit: vi.fn(async () => {
      const name = String((table as Record<symbol, unknown>)[Symbol.for('drizzle:Name')] ?? '');
      if (name === 'ai_sessions') return state.session ? [state.session] : [];
      if (name === 'organizations') return state.partnerId ? [{ partnerId: state.partnerId }] : [];
      return [];
    }) })) })) })),
  },
  getCurrentDbAccessContext: () => (state.scope ? { scope: state.scope } : undefined),
  runAfterDbContextExit: (label: string, work: () => unknown) => { state.afterExit.push({ label, work }); },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('./connections', () => ({ getCompatConnection: vi.fn(async () => state.compat) }));
vi.mock('./offerings', () => ({
  findOfferingIdForModel: vi.fn(async () => state.offeringId),
  getOffering: vi.fn(async () => state.offering),
}));
vi.mock('./platformModels', () => ({ getPlatformModelByModelId: vi.fn(async () => state.platform) }));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));

import { __resetLegacyCostListenersForTests, emitLegacyCostRecorded, type LegacyCostEvent } from './legacyCostEvents';
import {
  __resetInvocationLedgerShadowForTests,
  buildShadowRateSnapshot,
  getInvocationLedgerShadowCounters,
  recordShadowInvocation,
  registerInvocationLedgerShadow,
  shadowCostDiff,
  surfaceFromSession,
} from './invocationLedger';

const rates = { inputCentsPerM: 200, outputCentsPerM: 1000, cacheReadCentsPerM: 20, cacheWriteCentsPerM: 250 };
const platformRow = { id: 'pm', modelId: 'claude-sonnet-5-5', rates, optionRates: null };

function event(over: Partial<LegacyCostEvent> = {}): LegacyCostEvent {
  return {
    orgId: 'org-1', sessionId: null, model: 'claude-sonnet-5-5', billingSource: 'platform', catalogPricing: null,
    tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, legacyCostCents: 200, legacyAdditionalCostCents: 0,
    legacyCostSource: 'model_pricing', sdkReportedCostUsd: null, ledger: { surface: 'catalog_enrichment' }, ...over,
  };
}

beforeEach(() => {
  state.inserted.length = 0; state.afterExit.length = 0;
  state.session = null; state.partnerId = 'partner-1'; state.compat = null; state.offeringId = null;
  state.offering = null; state.platform = platformRow; state.scope = 'system';
  __resetLegacyCostListenersForTests();
  __resetInvocationLedgerShadowForTests();
});

describe('surfaceFromSession', () => {
  it.each([
    [{ type: 'script_builder', clientUserId: null, contextSnapshot: null }, 'script_builder'],
    [{ type: 'general', clientUserId: 'cu', contextSnapshot: null }, 'office_chat'],
    [{ type: 'excel_client', clientUserId: null, contextSnapshot: null }, 'office_chat'],
    [{ type: 'general', clientUserId: null, contextSnapshot: { source: 'helper' } }, 'helper'],
    [{ type: 'agent', clientUserId: null, contextSnapshot: null }, 'ai_agents'],
    [{ type: 'topology', clientUserId: null, contextSnapshot: null }, 'chat'],
    [{ type: 'general', clientUserId: null, contextSnapshot: null }, 'chat'],
  ] as const)('%j → %s', (row, surface) => {
    expect(surfaceFromSession(row)).toBe(surface);
  });
});

describe('buildShadowRateSnapshot — never prices platform traffic from a non-platform rate', () => {
  it('catalog traffic uses the revision snapshot', () => {
    expect(buildShadowRateSnapshot({
      funding: 'partner_key',
      catalogPricing: { catalogEntryId: 'e', revisionId: 'r', ...rates },
      platformModel: null, offering: null, linkedPlatformModel: null,
    })).toEqual({ source: 'catalog', standard: rates });
  });
  it('platform traffic uses the platform row, or nothing when it is unpriced', () => {
    expect(buildShadowRateSnapshot({ funding: 'platform', catalogPricing: null, platformModel: platformRow as never, offering: null, linkedPlatformModel: null }))
      .toEqual({ source: 'platform', standard: rates });
    expect(buildShadowRateSnapshot({ funding: 'platform', catalogPricing: null, platformModel: { ...platformRow, rates: null } as never, offering: null, linkedPlatformModel: null }))
      .toBeNull();
  });
  it('partner-key traffic: offering price, then the linked platform row, then nothing', () => {
    const priced = { priceInputCentsPerM: 1, priceOutputCentsPerM: 2, priceCacheReadCentsPerM: 3, priceCacheWriteCentsPerM: 4, platformModelId: 'pm' };
    expect(buildShadowRateSnapshot({ funding: 'partner_key', catalogPricing: null, platformModel: null, offering: priced as never, linkedPlatformModel: platformRow as never }))
      .toEqual({ source: 'offering', standard: { inputCentsPerM: 1, outputCentsPerM: 2, cacheReadCentsPerM: 3, cacheWriteCentsPerM: 4 } });
    const linked = { priceInputCentsPerM: null, priceOutputCentsPerM: null, priceCacheReadCentsPerM: null, priceCacheWriteCentsPerM: null, platformModelId: 'pm' };
    expect(buildShadowRateSnapshot({ funding: 'partner_key', catalogPricing: null, platformModel: null, offering: linked as never, linkedPlatformModel: platformRow as never }))
      .toEqual({ source: 'linked_platform', standard: rates });
    expect(buildShadowRateSnapshot({ funding: 'partner_key', catalogPricing: null, platformModel: platformRow as never, offering: null, linkedPlatformModel: null }))
      .toBeNull();
  });
});

describe('shadowCostDiff', () => {
  it.each([
    [200, 200, false, null],
    [200.004, 200, false, null],
    [200.02, 200, true, 'price_mismatch'],
    [null, 200, true, 'unpriced'],
  ] as const)('ledger %s vs legacy %s', (ledger, legacy, differs, reason) => {
    expect(shadowCostDiff(ledger, legacy)).toMatchObject({ differs, reason });
  });
});

describe('recordShadowInvocation', () => {
  it('writes a shadow row priced by the registry, carrying the legacy cost', async () => {
    state.offeringId = 'off-1';
    await expect(recordShadowInvocation(event())).resolves.toBe('written');
    expect(state.inserted[0]).toMatchObject({
      orgId: 'org-1', surface: 'catalog_enrichment', fundingSource: 'platform', offeringId: 'off-1', connectionId: null,
      requestedModel: 'claude-sonnet-5-5', servedModel: 'claude-sonnet-5-5', ledgerMode: 'shadow', legacyCostCents: 200,
      inputTokens: 1_000_000, rateSnapshot: { source: 'platform', standard: rates },
    });
    expect(Number(state.inserted[0]!.costCents)).toBeCloseTo(200, 6);
  });

  it('derives surface and user from the session row for session-bound calls', async () => {
    state.session = { type: 'script_builder', clientUserId: null, contextSnapshot: null, userId: 'user-9', model: 'claude-sonnet-5-5' };
    await recordShadowInvocation(event({ sessionId: 'sess-1', ledger: null }));
    expect(state.inserted[0]).toMatchObject({ surface: 'script_builder', userId: 'user-9', sessionId: 'sess-1' });
  });

  it('a sessionless call without a ledger context is skipped and warned once, never guessed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(recordShadowInvocation(event({ ledger: null }))).resolves.toBe('skipped_no_context');
    expect(state.inserted).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ai_invocation_ledger_context_missing'));
    warn.mockRestore();
  });

  it('skips a zero-token, zero-cost settle (not an invocation)', async () => {
    await expect(recordShadowInvocation(event({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, legacyCostCents: 0 }))).resolves.toBe('skipped_zero');
  });

  it('logs a structured diff when the registry price disagrees, and records NULL cost when unpriced', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    state.platform = { ...platformRow, rates: null };
    await recordShadowInvocation(event());
    expect(state.inserted[0]).toMatchObject({ costCents: null, rateSnapshot: null, legacyCostCents: 200 });
    const logged = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes('ai_invocation_shadow_cost_diff'));
    expect(JSON.parse(logged!)).toMatchObject({ event: 'ai_invocation_shadow_cost_diff', reason: 'unpriced', surface: 'catalog_enrichment', legacyCents: 200 });
    warn.mockRestore();
  });

  it('refuses to run outside a system context', async () => {
    state.scope = 'organization';
    await expect(recordShadowInvocation(event())).rejects.toThrow(/system DB context/);
  });
});

describe('registerInvocationLedgerShadow', () => {
  it('defers the write until the caller\'s DB context exits, and is idempotent', async () => {
    registerInvocationLedgerShadow();
    registerInvocationLedgerShadow();
    emitLegacyCostRecorded(event());
    expect(state.afterExit.map((t) => t.label)).toEqual(['aiInvocationLedger.shadow']);
    expect(state.inserted).toEqual([]);
    await state.afterExit[0]!.work();
    expect(state.inserted).toHaveLength(1);
  });

  it('a failing shadow write is swallowed and logged — billing callers never see it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    registerInvocationLedgerShadow();
    state.partnerId = null; // org lookup fails → the write throws inside the deferred task
    emitLegacyCostRecorded(event());
    await expect(Promise.resolve(state.afterExit[0]!.work())).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('ai_invocation_shadow_failed'), expect.anything());
    error.mockRestore();
  });

  it('logs and reports only the driver cause — never the failed query or its params', async () => {
    const { getCompatConnection } = await import('./connections');
    const { captureException } = await import('../sentry');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const leaky = Object.assign(new Error('Failed query: insert into "ai_invocations" params: org-1,leaky-param-value'), {
      cause: Object.assign(new Error('permission denied for table ai_invocations'), { code: '42501' }),
    });
    vi.mocked(getCompatConnection).mockRejectedValueOnce(leaky);
    registerInvocationLedgerShadow();
    emitLegacyCostRecorded(event({ billingSource: 'partner_key' }));
    await state.afterExit[0]!.work();
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).toContain('permission denied for table ai_invocations');
    expect(logged).not.toContain('leaky-param-value');
    const sent = vi.mocked(captureException).mock.calls.at(-1)![0] as Error & { code?: string };
    expect(sent).not.toBe(leaky);
    expect(sent.message).toBe('Error (SQLSTATE 42501, permission denied for table ai_invocations)');
    expect(sent.code).toBe('42501');
    expect(JSON.stringify(sent)).not.toContain('leaky-param-value');
    error.mockRestore();
  });

  describe('failure noise control', () => {
    const pgFailure = (code: string) => Object.assign(new Error('Failed query: insert … params: secret-param'), {
      cause: Object.assign(new Error(`pg failure ${code}`), { code }),
    });
    let consoleError: ReturnType<typeof vi.spyOn>;
    beforeEach(async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
      consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { captureException } = await import('../sentry');
      vi.mocked(captureException).mockClear();
    });
    afterEach(() => {
      vi.useRealTimers();
      consoleError.mockRestore();
    });

    async function failOnce(code: string): Promise<void> {
      const { getCompatConnection } = await import('./connections');
      vi.mocked(getCompatConnection).mockRejectedValueOnce(pgFailure(code));
      emitLegacyCostRecorded(event({ billingSource: 'partner_key' }));
      await state.afterExit.at(-1)!.work();
    }

    it('captures under a fixed fingerprint per SQLSTATE: the first failure, then at most one per minute', async () => {
      const { captureException } = await import('../sentry');
      registerInvocationLedgerShadow();
      await failOnce('42501');
      await failOnce('42501');
      await failOnce('42501');
      await failOnce('23503'); // a different fingerprint is reported on its own
      expect(vi.mocked(captureException).mock.calls.map((c) => c[3])).toEqual([
        { fingerprint: ['ai_invocation_shadow', '42501'] },
        { fingerprint: ['ai_invocation_shadow', '23503'] },
      ]);
      vi.advanceTimersByTime(60_001);
      await failOnce('42501');
      expect(vi.mocked(captureException)).toHaveBeenCalledTimes(3);
      // The throttled log line carries how many were suppressed in between.
      const lastLog = JSON.stringify(consoleError.mock.calls.at(-1));
      expect(lastLog).toContain('"suppressedSinceLastReport":2');
      expect(consoleError).toHaveBeenCalledTimes(3);
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain('secret-param');
    });

    it('an error with no SQLSTATE is fingerprinted as unknown', async () => {
      const { captureException } = await import('../sentry');
      registerInvocationLedgerShadow();
      state.partnerId = null; // org lookup fails with a plain Error
      emitLegacyCostRecorded(event());
      await state.afterExit[0]!.work();
      expect(vi.mocked(captureException).mock.calls[0]![3]).toEqual({ fingerprint: ['ai_invocation_shadow', 'unknown'] });
    });

    it('keeps process counters of shadow outcomes by reason and logs them with each reported failure', async () => {
      registerInvocationLedgerShadow();
      emitLegacyCostRecorded(event({ ledger: null }));
      await state.afterExit.at(-1)!.work();
      emitLegacyCostRecorded(event({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, legacyCostCents: 0 }));
      await state.afterExit.at(-1)!.work();
      await failOnce('42501');
      expect(getInvocationLedgerShadowCounters()).toEqual({ written: 0, failed: 1, skipped_no_context: 1, skipped_zero: 1 });
      expect(JSON.stringify(consoleError.mock.calls.at(-1))).toContain('"counters":{"written":0,"failed":1,"skipped_no_context":1,"skipped_zero":1}');
    });
  });
});
