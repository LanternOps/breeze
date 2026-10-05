import { describe, it, expect, vi, beforeEach } from 'vitest';

const { create, checkBudget, checkAiRateLimit, checkUserAiRateLimit, captureException, captureMessage, resolveModel, readOrgPartnerId, anthropicClientFor, settleInvocation, reserveAiBudget, markAiBudgetReservationIndeterminate, releaseUnusedAiBudgetReservation } = vi.hoisted(() => ({
  create: vi.fn(),
  checkBudget: vi.fn(async (): Promise<string | null> => null),
  checkAiRateLimit: vi.fn(async (): Promise<string | null> => null),
  checkUserAiRateLimit: vi.fn(async (): Promise<string | null> => null),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  resolveModel: vi.fn(),
  readOrgPartnerId: vi.fn(),
  anthropicClientFor: vi.fn(),
  settleInvocation: vi.fn(async (_input: unknown) => ({ costCents: 0, invocationIds: [], deferred: false })),
  reserveAiBudget: vi.fn(),
  markAiBudgetReservationIndeterminate: vi.fn(),
  releaseUnusedAiBudgetReservation: vi.fn(),
}));
vi.mock('./aiCostTracker', () => ({
  checkBudget, checkAiRateLimit, checkUserAiRateLimit,
}));
vi.mock('./aiBudgetReservations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./aiBudgetReservations')>()),
  reserveAiBudget,
  markAiBudgetReservationIndeterminate,
  releaseUnusedAiBudgetReservation,
}));
vi.mock('./sentry', () => ({ captureException, captureMessage }));
vi.mock('./aiModels/resolveModel', () => ({ resolveModel }));
vi.mock('./aiModels/candidateLoader', () => ({ readOrgPartnerId }));
// Real createMessage over the fake client; only the client factory is replaced.
vi.mock('./aiModels/connectionFactory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./aiModels/connectionFactory')>()),
  anthropicClientFor,
}));
// Real pricing (priceUsage / sumCostCents / costEstimator); only settlement is mocked.
vi.mock('./aiModels/settleInvocation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./aiModels/settleInvocation')>()),
  settleInvocation,
}));

import { aiEnrichmentProvider, enrichCatalogItem, enrichDistributorListing, polishCatalogText, EnrichmentError } from './catalogEnrichmentService';
import { LlmUnavailableError } from './llm/llmUnavailableError';
import { makeResolvedModel } from './aiModels/__fixtures__/resolvedModel';
import { turnBindingFrom } from './aiModels/turnBinding';

const RESERVATION_ID = '55555555-5555-4555-8555-555555555555';
const byok = () => makeResolvedModel('anthropic_byok', { surface: 'catalog_enrichment' });
/** 0.01 cent per output token and free input: output tokens price as n / 100 cents. */
const outputOnlyPricing = () => makeResolvedModel('anthropic_byok', {
  surface: 'catalog_enrichment',
  rateSnapshot: { source: 'linked_platform', standard: { inputCentsPerM: 0, outputCentsPerM: 10_000, cacheReadCentsPerM: 0, cacheWriteCentsPerM: 0 } },
});

const actor = { userId: 'u1', orgId: 'o1', partnerId: 'p1' };

function aiMessage(json: object, webSearchRequests = 0) {
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(json) }],
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      server_tool_use: { web_search_requests: webSearchRequests },
    },
  };
}

function catalogWithFallback() {
  const base = makeResolvedModel('catalog', { surface: 'catalog_enrichment' });
  return makeResolvedModel('catalog', {
    surface: 'catalog_enrichment',
    refusalFallback: {
      offeringId: 'fb', displayName: 'Haiku', wireModel: 'anthropic/claude-haiku-4.5',
      wireParams: { betas: [], applied: {} }, options: {}, rateSnapshot: base.rateSnapshot,
    } as never,
  });
}
const REFUSED = {
  model: 'anthropic/claude-sonnet-5.5', stop_reason: 'refusal', stop_details: { category: 'cyber' },
  content: [], usage: { input_tokens: 70, output_tokens: 3 },
};

beforeEach(() => {
  create.mockReset();
  resolveModel.mockReset().mockResolvedValue(byok());
  readOrgPartnerId.mockReset().mockResolvedValue('p1');
  anthropicClientFor.mockReset().mockReturnValue({ messages: { create } });
  settleInvocation.mockClear();
  captureMessage.mockClear();
  captureException.mockClear();
  checkBudget.mockClear(); checkAiRateLimit.mockClear(); checkUserAiRateLimit.mockClear();
  reserveAiBudget.mockClear(); markAiBudgetReservationIndeterminate.mockClear(); releaseUnusedAiBudgetReservation.mockClear();
  checkBudget.mockResolvedValue(null); checkAiRateLimit.mockResolvedValue(null); checkUserAiRateLimit.mockResolvedValue(null);
  reserveAiBudget.mockResolvedValue({
    kind: 'unlimited',
    reservationId: RESERVATION_ID,
    dailyPeriodKey: '2026-09-06',
    monthlyPeriodKey: '2026-09-01',
    status: 'active',
  });
  markAiBudgetReservationIndeterminate.mockResolvedValue({ kind: 'indeterminate', reservationId: RESERVATION_ID });
  releaseUnusedAiBudgetReservation.mockResolvedValue({ kind: 'released', reservationId: RESERVATION_ID });
});

describe('enrichCatalogItem', () => {
  it('caps each provider turn against the remaining durable reservation', async () => {
    reserveAiBudget.mockResolvedValueOnce({
      kind: 'reserved',
      reservationId: '55555555-5555-4555-8555-555555555555',
      reservedCostCents: 7,
      dailyPeriodKey: '2026-09-06',
      monthlyPeriodKey: '2026-09-01',
      status: 'active',
    });
    resolveModel.mockResolvedValue(outputOnlyPricing());
    create.mockResolvedValueOnce(aiMessage({ name: 'UPS', itemType: 'hardware' }));

    await enrichCatalogItem('UPS', 'hardware', actor);

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ max_tokens: 200 }));
  });

  it('does not dispatch when the reservation cannot cover maximum web-search fees', async () => {
    reserveAiBudget.mockResolvedValueOnce({
      kind: 'reserved',
      reservationId: '55555555-5555-4555-8555-555555555555',
      reservedCostCents: 5,
      dailyPeriodKey: '2026-09-06',
      monthlyPeriodKey: '2026-09-01',
      status: 'active',
    });
    resolveModel.mockResolvedValue(outputOnlyPricing());

    await expect(enrichCatalogItem('UPS', 'hardware', actor)).rejects.toMatchObject({
      code: 'AI_LIMIT', status: 429,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('resolves catalog_enrichment for the acting user, admits with its funding, settles every turn incl. web-search fees', async () => {
    const model = byok();
    resolveModel.mockResolvedValue(model);
    create
      .mockResolvedValueOnce({
        model: 'claude-sonnet-5-5', stop_reason: 'pause_turn', content: [{ type: 'text', text: '' }],
        usage: { input_tokens: 500, output_tokens: 20, server_tool_use: { web_search_requests: 2 } },
      })
      .mockResolvedValueOnce(aiMessage({ name: 'UPS', itemType: 'hardware' }));

    await aiEnrichmentProvider.enrich('Contoso Widget', 'hardware', actor);

    expect(resolveModel).toHaveBeenCalledWith(expect.objectContaining({
      partnerId: 'p1', orgId: 'o1', userId: 'u1', surface: 'catalog_enrichment',
    }));
    expect(checkBudget).toHaveBeenCalledWith('o1', 'partner_key');
    expect(reserveAiBudget).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'o1', billingSource: 'partner_key', binding: turnBindingFrom(model as never),
    }));
    expect(settleInvocation).toHaveBeenCalledTimes(1);
    const settled = settleInvocation.mock.calls[0]![0] as Record<string, any>;
    expect(settled.usage).toHaveLength(2);
    expect(settled.usage[0].webSearchRequests).toBe(2);
    expect(settled.sourceRef).toBe('catalog_enrich');
    expect(settled.reservationId).toBe(RESERVATION_ID);
    expect(settled.userId).toBe('u1');
    // Billing is the registry's job: no SDK/provider cost field travels with the settlement.
    expect(settled).not.toHaveProperty('costUsd');
  });

  it('a system-initiated enrichment is not user-initiated (no permission gate)', async () => {
    resolveModel.mockResolvedValue(makeResolvedModel('platform', { surface: 'catalog_enrichment' }));
    create.mockResolvedValueOnce(aiMessage({ name: 'UPS', itemType: 'hardware' }));
    await aiEnrichmentProvider.enrich('x', 'hardware', { ...actor, systemInitiated: true });
    expect(resolveModel).toHaveBeenCalledWith(expect.objectContaining({ userId: null }));
    expect((settleInvocation.mock.calls[0]![0] as { userId: unknown }).userId).toBeNull();
  });

  it('does not dispatch after a durable budget denial', async () => {
    reserveAiBudget.mockResolvedValueOnce({
      kind: 'denied', reason: 'daily_budget', message: 'Daily AI budget exhausted ($1.00)',
    });

    await expect(enrichCatalogItem('UPS', 'hardware', actor)).rejects.toMatchObject({
      code: 'AI_LIMIT', status: 429,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('retains an indeterminate reservation on a provider transport failure', async () => {
    create.mockRejectedValueOnce(new Error('connection reset'));

    await expect(enrichCatalogItem('UPS', 'hardware', actor)).rejects.toThrow('connection reset');
    expect(markAiBudgetReservationIndeterminate).toHaveBeenCalledWith({
      orgId: 'o1',
      reservationId: '55555555-5555-4555-8555-555555555555',
    });
  });

  it('a refused attempt whose client-side fallback then throws is settled (billed) as an error, not left indeterminate', async () => {
    resolveModel.mockResolvedValue(catalogWithFallback());
    create.mockResolvedValueOnce(REFUSED).mockRejectedValueOnce(new Error('connection reset'));

    await expect(enrichCatalogItem('UPS', 'hardware', actor)).rejects.toThrow('connection reset');
    expect(markAiBudgetReservationIndeterminate).not.toHaveBeenCalled();
    expect(settleInvocation).toHaveBeenCalledTimes(1);
    expect(settleInvocation).toHaveBeenCalledWith(expect.objectContaining({
      sourceRef: 'catalog_enrich',
      usage: [expect.objectContaining({ model: 'anthropic/claude-sonnet-5.5', tokens: expect.objectContaining({ input: 70, output: 3 }) })],
      outcome: expect.objectContaining({ stopReason: 'error' }),
    }));
  });

  it('maps AI fields to a draft + price guidance and never sets unitPrice', async () => {
    create.mockResolvedValueOnce(aiMessage({
      name: 'APC Back-UPS 600VA', description: 'Battery backup',
      itemType: 'hardware', unitOfMeasure: 'each', taxable: true, taxCategory: null,
      priceLow: 80, priceHigh: 120, currency: 'USD', confidence: 0.8, notes: '',
    }));
    const res = await enrichCatalogItem('APC Back-UPS 600VA', 'hardware', actor);
    expect(res.draft.name).toBe('APC Back-UPS 600VA');
    expect(res.draft.itemType).toBe('hardware');
    expect((res.draft as Record<string, unknown>).unitPrice).toBeUndefined();
    expect(res.priceGuidance).toMatch(/80/);
    expect(res.priceGuidance).toMatch(/120/);
    // No explicit costEstimate in the AI output → falls back to priceLow.
    expect(res.estimatedCost).toBe(80);
    expect(res.provenance.source).toBe('ai_enrich');
    expect(settleInvocation).toHaveBeenCalledTimes(1);
    expect(settleInvocation).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'o1', userId: 'u1', sessionId: null, agentRunId: null,
      sourceRef: 'catalog_enrich', reservationId: RESERVATION_ID,
    }));
    expect(checkBudget).toHaveBeenCalledWith('o1', 'partner_key');
    expect(anthropicClientFor).toHaveBeenCalledWith(expect.objectContaining({ ok: true }), { surface: 'one_shot_catalog_enrichment', orgId: 'o1' });
  });

  it('sends the WIRE model to the provider and binds the revision rates', async () => {
    const catalog = makeResolvedModel('catalog', { surface: 'catalog_enrichment' });
    resolveModel.mockResolvedValue(catalog);
    create.mockResolvedValueOnce(aiMessage({
      name: 'APC Back-UPS 600VA', description: 'Battery backup',
      itemType: 'hardware', unitOfMeasure: 'each', taxable: true, taxCategory: null,
      priceLow: 80, priceHigh: 120, currency: 'USD', confidence: 0.8, notes: '',
    }));

    await enrichCatalogItem('apc 600va ups', undefined, actor);

    // A catalog gateway 404s on the platform-logical id.
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'anthropic/claude-sonnet-5.5' }));
    // …while settlement is priced from the revision snapshot bound at admission.
    const settled = settleInvocation.mock.calls[0]![0] as { binding: { rateSnapshot: { source: string } } };
    expect(settled.binding.rateSnapshot.source).toBe('catalog');
  });

  it('maps an unavailable partner LLM config to the typed 503 service error', async () => {
    anthropicClientFor.mockImplementationOnce(() => { throw new LlmUnavailableError(); });

    await expect(enrichCatalogItem('APC Back-UPS 600VA', 'hardware', actor)).rejects.toMatchObject({
      name: 'EnrichmentError',
      code: 'AI_UNAVAILABLE',
      status: 503,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('prefers an explicit costEstimate over the priceLow fallback', async () => {
    create.mockResolvedValueOnce(aiMessage({
      name: 'APC Back-UPS 600VA', description: 'Battery backup',
      itemType: 'hardware', unitOfMeasure: 'each', taxable: true, taxCategory: null,
      priceLow: 80, priceHigh: 120, costEstimate: 68.5, currency: 'USD', confidence: 0.8, notes: '',
    }));
    const res = await enrichCatalogItem('APC Back-UPS 600VA', 'hardware', actor);
    expect(res.estimatedCost).toBe(68.5);
  });

  it('ignores a negative/garbage costEstimate and falls back to priceLow', async () => {
    create.mockResolvedValueOnce(aiMessage({
      name: 'APC Back-UPS 600VA', description: null, itemType: 'hardware',
      unitOfMeasure: 'each', taxable: true, taxCategory: null,
      priceLow: 80, priceHigh: 120, costEstimate: -5, currency: 'USD', confidence: 0.8, notes: '',
    }));
    const res = await enrichCatalogItem('APC Back-UPS 600VA', 'hardware', actor);
    expect(res.estimatedCost).toBe(80);
  });

  it('appends the partner style override to the system prompt (and omits it by default)', async () => {
    const reply = {
      name: 'X', description: null, itemType: 'service', unitOfMeasure: 'each', taxable: true,
      taxCategory: null, priceLow: null, priceHigh: null, currency: null, confidence: 0.5, notes: '',
    };
    create.mockResolvedValueOnce(aiMessage(reply));
    await enrichCatalogItem('X', undefined, actor, 'One-line descriptions, no bullets.');
    const styled = (create.mock.calls[0]![0] as { system: string }).system;
    expect(styled).toContain('MSP STYLE OVERRIDE');
    expect(styled).toContain('<msp_style>One-line descriptions, no bullets.</msp_style>');

    create.mockResolvedValueOnce(aiMessage(reply));
    await enrichCatalogItem('X', undefined, actor);
    const plain = (create.mock.calls[1]![0] as { system: string }).system;
    expect(plain).not.toContain('MSP STYLE OVERRIDE');
    // The built-in house format is the default: generic name + bulleted specs.
    expect(plain).toContain('customer-friendly item name');
    expect(plain).toContain('"• "');
  });

  it('returns null priceGuidance when no usable range', async () => {
    create.mockResolvedValueOnce(aiMessage({
      name: 'Mystery', description: null, itemType: 'service',
      unitOfMeasure: 'each', taxable: true, taxCategory: null,
      priceLow: null, priceHigh: null, currency: null, confidence: 0.2, notes: '',
    }));
    const res = await enrichCatalogItem('Mystery', undefined, actor);
    expect(res.priceGuidance).toBeNull();
    expect(res.estimatedCost).toBeNull();
  });

  it('throws AI_LIMIT when budget is exhausted', async () => {
    checkBudget.mockResolvedValueOnce('Monthly AI budget exceeded');
    await expect(enrichCatalogItem('x', undefined, actor)).rejects.toMatchObject({
      code: 'AI_LIMIT', status: 429,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('throws AI_PARSE (code + status) on non-JSON output', async () => {
    create.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'sorry, no idea' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    await expect(enrichCatalogItem('x', undefined, actor)).rejects.toMatchObject({
      code: 'AI_PARSE', status: 502,
    });
  });

  it('throws AI_TRUNCATED when the model hits max_tokens with no text', async () => {
    create.mockResolvedValueOnce({
      stop_reason: 'max_tokens',
      content: [],
      usage: { input_tokens: 10, output_tokens: 1024 },
    });
    await expect(enrichCatalogItem('x', undefined, actor)).rejects.toMatchObject({
      code: 'AI_TRUNCATED', status: 502,
    });
  });

  it('short-circuits with AI_LIMIT when the rate limit is hit (before any API call)', async () => {
    checkAiRateLimit.mockResolvedValueOnce('Rate limit exceeded');
    await expect(enrichCatalogItem('x', undefined, actor)).rejects.toMatchObject({
      code: 'AI_LIMIT', status: 429,
    });
    expect(create).not.toHaveBeenCalled();
    expect(checkBudget).not.toHaveBeenCalled(); // rate check runs first and short-circuits
  });

  it('falls back to the hint when the AI omits itemType', async () => {
    create.mockResolvedValueOnce(aiMessage({
      name: 'Widget', description: null,
      unitOfMeasure: 'each', taxable: true, taxCategory: null,
      priceLow: null, priceHigh: null, currency: null, confidence: 0.5, notes: '',
    }));
    const res = await enrichCatalogItem('Widget', 'hardware', actor);
    expect(res.draft.itemType).toBe('hardware');
  });

  it('replaces an oversized AI suggestion with a truncation marker', async () => {
    create.mockResolvedValueOnce(aiMessage({
      name: 'Big', description: null, itemType: 'service',
      unitOfMeasure: 'each', taxable: true, taxCategory: null,
      priceLow: null, priceHigh: null, currency: null, confidence: 0.5, notes: '',
      blob: 'x'.repeat(20_000),
    }));
    const res = await enrichCatalogItem('Big', undefined, actor);
    expect(res.provenance.suggestion).toEqual({ truncated: true });
  });

  // Issue #1950: mainstream products (e.g. Microsoft 365 Business Premium) came
  // back with off-enum itemTypes / oversized fields and were rejected with a
  // blanket AI_PARSE/502. We now coerce the advisory output to fit the schema.
  it('maps an off-enum itemType ("subscription") to software instead of rejecting', async () => {
    create.mockResolvedValueOnce(aiMessage({
      name: 'Microsoft 365 Business Premium', description: 'Office apps + security',
      itemType: 'subscription', unitOfMeasure: 'user/month', taxable: true, taxCategory: null,
      priceLow: 22, priceHigh: 22, currency: 'USD', confidence: 0.9, notes: '',
    }));
    const res = await enrichCatalogItem('Microsoft 365 Business Premium', undefined, actor);
    expect(res.draft.itemType).toBe('software');
    expect(res.draft.name).toBe('Microsoft 365 Business Premium');
  });

  it('normalizes a capitalized itemType ("Software")', async () => {
    create.mockResolvedValueOnce(aiMessage({
      name: 'Adobe Acrobat', description: null, itemType: 'Software',
      unitOfMeasure: 'each', taxable: true, taxCategory: null,
      priceLow: null, priceHigh: null, currency: null, confidence: 0.5, notes: '',
    }));
    const res = await enrichCatalogItem('Adobe Acrobat', undefined, actor);
    expect(res.draft.itemType).toBe('software');
  });

  it('truncates an oversized description and name instead of throwing AI_PARSE', async () => {
    create.mockResolvedValueOnce(aiMessage({
      name: 'N'.repeat(400), description: 'd'.repeat(20_000), itemType: 'service',
      unitOfMeasure: 'u'.repeat(80), taxable: true, taxCategory: 'c'.repeat(200),
      priceLow: null, priceHigh: null, currency: null, confidence: 0.5, notes: '',
    }));
    const res = await enrichCatalogItem('Service X', undefined, actor);
    expect(res.draft.name.length).toBe(255);
    expect(res.draft.description?.length).toBe(10_000);
    expect(res.draft.unitOfMeasure.length).toBe(50);
    expect(res.draft.taxCategory?.length).toBe(100);
  });

  it('falls back to the query for the name when the model omits it', async () => {
    create.mockResolvedValueOnce(aiMessage({
      description: null, itemType: 'service',
      unitOfMeasure: 'each', taxable: true, taxCategory: null,
      priceLow: null, priceHigh: null, currency: null, confidence: 0.3, notes: '',
    }));
    const res = await enrichCatalogItem('Some Product', undefined, actor);
    expect(res.draft.name).toBe('Some Product');
  });

  it('coerces a non-string description to null rather than failing', async () => {
    create.mockResolvedValueOnce(aiMessage({
      name: 'Thing', description: 42, itemType: 'service',
      unitOfMeasure: 'each', taxable: true, taxCategory: null,
      priceLow: null, priceHigh: null, currency: null, confidence: 0.5, notes: '',
    }));
    const res = await enrichCatalogItem('Thing', undefined, actor);
    expect(res.draft.description).toBeNull();
  });

  // S6: this used to assert that an org-less caller DISPATCHED with the
  // org-scoped guardrails simply skipped. That is the finding, not the
  // contract — paid web-search turns on the platform key with no budget, no
  // reservation and no usage row. The behaviour is now a refusal; the
  // system-scope exemption below is the only way through.
  it('refuses an org-less caller outright rather than dispatching unbudgeted', async () => {
    await expect(enrichCatalogItem('x', undefined, { userId: 'u1', orgId: null, partnerId: 'p1' }))
      .rejects.toMatchObject({ code: 'AI_ORG_REQUIRED', status: 400 });
    expect(create).not.toHaveBeenCalled();
    expect(checkBudget).not.toHaveBeenCalled();
    expect(settleInvocation).not.toHaveBeenCalled();
  });

  it('still allows an org-less call that DECLARES itself system-initiated', async () => {
    create.mockResolvedValueOnce(aiMessage({
      name: 'N', description: null, itemType: 'service',
      unitOfMeasure: 'each', taxable: true, taxCategory: null,
      priceLow: null, priceHigh: null, currency: null, confidence: 0.5, notes: '',
    }));
    await enrichCatalogItem('x', undefined, {
      userId: 'u1', orgId: null, partnerId: 'p1', systemInitiated: true,
    });
    // Platform-funded operational spend: still unbudgeted, deliberately, and
    // tracked separately as an org-less quota decision. The exemption is
    // DECLARED by the caller, never inferred from an ambient db scope.
    expect(create).toHaveBeenCalled();
    expect(checkBudget).not.toHaveBeenCalled();
    expect(settleInvocation).not.toHaveBeenCalled();
  });
});

describe('enrichDistributorListing', () => {
  it('maps a successful enrichment to name/description/itemType/provenance', async () => {
    create.mockResolvedValueOnce(aiMessage({
      name: 'Dell UltraSharp U2724D 27" Monitor',
      description: '27-inch QHD (2560x1440) IPS monitor, 120Hz, USB-C hub.',
      itemType: 'hardware', unitOfMeasure: 'each', taxable: true, taxCategory: null,
      priceLow: 380, priceHigh: 550, currency: 'USD', confidence: 0.9, notes: '',
    }));
    const res = await enrichDistributorListing('SPL Dell U2724D DISTI (MPN: DELL-U2724D)', 'hardware', actor);
    expect(res).not.toBeNull();
    expect(res!.name).toBe('Dell UltraSharp U2724D 27" Monitor');
    expect(res!.description).toMatch(/QHD/);
    expect(res!.itemType).toBe('hardware');
    expect(res!.provenance.source).toBe('ai_enrich');
    expect(res!.priceGuidance).toMatch(/380/);
  });

  it('returns null (never throws) when the AI call fails', async () => {
    create.mockRejectedValueOnce(new Error('network down'));
    const res = await enrichDistributorListing('Some product', 'hardware', actor);
    expect(res).toBeNull();
  });

  it('returns null when the AI is rate-limited or over budget', async () => {
    checkAiRateLimit.mockResolvedValueOnce('rate limited');
    const res = await enrichDistributorListing('Some product', 'hardware', actor);
    expect(res).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('keeps raw values but logs and captures a broken partner credential', async () => {
    anthropicClientFor.mockImplementationOnce(() => { throw new LlmUnavailableError(); });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await enrichDistributorListing('Some product', 'hardware', actor);

    expect(res).toBeNull();
    expect(consoleError).toHaveBeenCalledWith('[distributor-enrich] failed:', 'AI is unavailable');
    expect(captureException).toHaveBeenCalledWith(expect.objectContaining({
      name: 'EnrichmentError',
      code: 'AI_UNAVAILABLE',
    }));
    consoleError.mockRestore();
  });

  it('returns null for a blank query without calling the model', async () => {
    const res = await enrichDistributorListing('   ', 'hardware', actor);
    expect(res).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('returns null (keeps raw values) when enrichment exceeds the timeout', async () => {
    create.mockReturnValue(new Promise(() => {})); // never resolves → forces timeout
    const res = await enrichDistributorListing('Some product', 'hardware', actor, 20);
    expect(res).toBeNull();
  });
});

describe('polishCatalogText', () => {
  it('polishes name + description and reports changed=true when facts are preserved', async () => {
    create.mockResolvedValueOnce(aiMessage({
      name: 'APC Back-UPS 600VA UPS',
      description: 'APC Back-UPS 600VA battery backup with 7 outlets.',
    }));
    const res = await polishCatalogText(
      { name: 'spl apc back-ups 600va disti', description: 'apc backups 600va,7 outlets' },
      actor,
    );
    expect(res.name).toBe('APC Back-UPS 600VA UPS');
    expect(res.description).toMatch(/7 outlets/);
    expect(res.changed).toBe(true);
    expect(res.factChanges).toBeNull();
    expect(anthropicClientFor).toHaveBeenCalledWith(expect.objectContaining({ ok: true }), { surface: 'one_shot_catalog_enrichment', orgId: 'o1' });
  });

  it('maps an unavailable partner LLM config to the typed 503 service error', async () => {
    anthropicClientFor.mockImplementationOnce(() => { throw new LlmUnavailableError(); });

    await expect(polishCatalogText({ name: 'APC Back-UPS 600VA' }, actor)).rejects.toMatchObject({
      name: 'EnrichmentError',
      code: 'AI_UNAVAILABLE',
      status: 503,
    });
    expect(create).not.toHaveBeenCalled();
  });

  /**
   * Mirrors the `enrichCatalogItem` case above. Polish is a SECOND outbound
   * surface in this service with its own turn runner (`runPolishTurn`) and its
   * own settlement in a `finally`, so it can regress independently of enrich.
   */
  it('sends the WIRE model to the provider and binds the revision rates', async () => {
    const catalog = makeResolvedModel('catalog', { surface: 'catalog_enrichment' });
    resolveModel.mockResolvedValue(catalog);
    create.mockResolvedValueOnce(aiMessage({
      name: 'APC Back-UPS 600VA UPS',
      description: 'APC Back-UPS 600VA battery backup with 7 outlets.',
    }));

    await polishCatalogText(
      { name: 'spl apc back-ups 600va disti', description: 'apc backups 600va,7 outlets' },
      actor,
    );

    // A catalog gateway 404s on the platform-logical id.
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'anthropic/claude-sonnet-5.5' }));
    // …and settlement prices from the revision snapshot, NOT Anthropic list rates.
    const settled = settleInvocation.mock.calls[0]![0] as { binding: { rateSnapshot: { source: string } }; sourceRef: string };
    expect(settled.binding.rateSnapshot.source).toBe('catalog');
    expect(settled.sourceRef).toBe('catalog_polish');
  });

  it('polish: a refused attempt whose client-side fallback then throws is settled (billed) as an error, not left indeterminate', async () => {
    resolveModel.mockResolvedValue(catalogWithFallback());
    create.mockResolvedValueOnce(REFUSED).mockRejectedValueOnce(new Error('connection reset'));

    await expect(polishCatalogText({ name: 'apc back-ups 600va' }, actor)).rejects.toThrow('connection reset');
    expect(markAiBudgetReservationIndeterminate).not.toHaveBeenCalled();
    expect(settleInvocation).toHaveBeenCalledTimes(1);
    expect(settleInvocation).toHaveBeenCalledWith(expect.objectContaining({
      sourceRef: 'catalog_polish',
      usage: [expect.objectContaining({ model: 'anthropic/claude-sonnet-5.5', tokens: expect.objectContaining({ input: 70, output: 3 }) })],
      outcome: expect.objectContaining({ stopReason: 'error' }),
    }));
  });

  it('polish: a budget stop before any dispatch releases the reservation (nothing to settle)', async () => {
    reserveAiBudget.mockResolvedValueOnce({
      kind: 'reserved', reservationId: RESERVATION_ID, reservedCostCents: 0,
      dailyPeriodKey: '2026-09-06', monthlyPeriodKey: '2026-09-01', status: 'active',
    });
    resolveModel.mockResolvedValue(outputOnlyPricing());

    await expect(polishCatalogText({ name: 'apc back-ups 600va' }, actor)).rejects.toBeDefined();
    expect(create).not.toHaveBeenCalled();
    expect(settleInvocation).not.toHaveBeenCalled();
    expect(markAiBudgetReservationIndeterminate).not.toHaveBeenCalled();
    expect(releaseUnusedAiBudgetReservation).toHaveBeenCalledWith({ orgId: 'o1', reservationId: RESERVATION_ID });
  });

  it('settles the stricter RETRY turn too (every attempt, one settlement)', async () => {
    resolveModel.mockResolvedValue(makeResolvedModel('catalog', { surface: 'catalog_enrichment' }));
    // Both turns drift, so both run and both spend.
    create
      .mockResolvedValueOnce(aiMessage({ name: 'APC Back-UPS 650VA', description: null }))
      .mockResolvedValueOnce(aiMessage({ name: 'APC Back-UPS 650VA', description: null }));

    await polishCatalogText({ name: 'apc back-ups 600va' }, actor);

    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: 'anthropic/claude-sonnet-5.5' }));
    expect(settleInvocation).toHaveBeenCalledTimes(1);
    const settled = settleInvocation.mock.calls[0]![0] as { usage: Array<{ tokens: { input: number; output: number } }> };
    expect(settled.usage.reduce((n, u) => n + u.tokens.input, 0)).toBe(200);
    expect(settled.usage.reduce((n, u) => n + u.tokens.output, 0)).toBe(100);
  });

  it('warns (does not block) when a number CHANGES, after retrying for a clean version', async () => {
    // Both attempts drift 600VA -> 650VA. The guard is advisory: it returns the
    // polished text with a non-null factChanges so the human preview can flag it, and
    // reports the added/removed numeric tokens.
    create
      .mockResolvedValueOnce(aiMessage({ name: 'APC Back-UPS 650VA', description: null }))
      .mockResolvedValueOnce(aiMessage({ name: 'APC Back-UPS 650VA', description: null }));
    const res = await polishCatalogText({ name: 'apc back-ups 600va' }, actor);
    expect(create).toHaveBeenCalledTimes(2); // one clean turn + one stricter retry
    expect(res.name).toBe('APC Back-UPS 650VA');
    expect(res.factChanges).not.toBeNull();
    expect(res.factChanges?.added).toContain('650va');
    expect(res.factChanges?.removed).toContain('600va');
  });

  it('warns when the model INVENTS a new spec not present in the input', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    create
      .mockResolvedValueOnce(aiMessage({ name: 'Dell Monitor 27" 144Hz', description: null }))
      .mockResolvedValueOnce(aiMessage({ name: 'Dell Monitor 27" 144Hz', description: null }));
    // input has 27 but NOT 144 — inventing 144Hz is surfaced as an added token.
    const res = await polishCatalogText({ name: 'dell monitor 27 inch' }, actor);
    expect(res.factChanges).not.toBeNull();
    expect(res.factChanges?.added).toContain('144hz');
    // An over-claim (added token) must emit a queryable Sentry signal so an
    // operator can catch the model inventing specs on live quotes.
    expect(captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('over-claimed'),
      expect.objectContaining({ eventCode: 'catalog_polish_fact_over_claim' }),
    );
    // BREEZE-18: the invented token used to be asserted inside the `extra` bag,
    // which never reached Sentry — captureMessage never attached it and
    // scrubEvent deleted it. The durable record is the console line above the
    // capture, so that is where the token is asserted now.
    expect(consoleWarn).toHaveBeenCalledWith(
      '[catalog-polish] fact guard: advisory drift',
      expect.objectContaining({
        direction: 'over-claim',
        added: expect.arrayContaining(['144hz']),
      }),
    );
    consoleWarn.mockRestore();
  });

  it('accepts the stricter retry when the first attempt drifts but the second is clean', async () => {
    create
      .mockResolvedValueOnce(aiMessage({ name: 'APC Back-UPS 650VA', description: null })) // drift
      .mockResolvedValueOnce(aiMessage({ name: 'APC Back-UPS 600VA', description: null })); // clean
    const res = await polishCatalogText({ name: 'spl apc back-ups 600va disti' }, actor);
    expect(res.name).toBe('APC Back-UPS 600VA');
    // A first-attempt drift must NOT leak a stale warning onto the clean retry.
    expect(res.factChanges).toBeNull();
  });

  it('allows pure presentation changes: thousands separators and unit spacing are not drift', async () => {
    create.mockResolvedValueOnce(aiMessage({
      name: null,
      description: 'Storage array with 1440GB usable capacity and 10GbE networking.',
    }));
    const res = await polishCatalogText(
      { description: 'storage array 1,440 gb usable, 10 gbe networking' },
      actor,
    );
    expect(res.description).toMatch(/1440GB/);
    expect(res.changed).toBe(true);
  });

  it('never invents a name when only a description was provided', async () => {
    create.mockResolvedValueOnce(aiMessage({
      name: 'Some Invented Product Name',
      description: 'Clean managed support description.',
    }));
    const res = await polishCatalogText({ description: 'managed support desc' }, actor);
    expect(res.name).toBeNull();
    expect(res.description).toBe('Clean managed support description.');
  });

  it('reports changed=false when the model returns identical text', async () => {
    create.mockResolvedValueOnce(aiMessage({ name: 'Already Clean Name', description: null }));
    const res = await polishCatalogText({ name: 'Already Clean Name' }, actor);
    expect(res.changed).toBe(false);
  });

  it('reports changed=false when the input differs only by surrounding whitespace', async () => {
    // A trailing textarea newline must not count as a "change" — that produced
    // preview dialogs showing two visually identical blocks.
    create.mockResolvedValueOnce(aiMessage({ name: 'Already Clean Name', description: 'Battery backup.' }));
    const res = await polishCatalogText({ name: 'Already Clean Name ', description: 'Battery backup.\n' }, actor);
    expect(res.changed).toBe(false);
    expect(res.name).toBe('Already Clean Name');
    expect(res.description).toBe('Battery backup.');
  });

  it('throws AI_LIMIT (429) when rate-limited, before calling the model', async () => {
    checkAiRateLimit.mockResolvedValueOnce('Too many AI requests');
    await expect(polishCatalogText({ name: 'x' }, actor))
      .rejects.toMatchObject({ code: 'AI_LIMIT', status: 429 });
    expect(create).not.toHaveBeenCalled();
  });

  // S6: a per-user rate limit bounds the RATE of unbudgeted spend; it never
  // made the spend accounted. An org-less tenant caller is now refused.
  it('refuses an org-less caller instead of falling back to a per-user rate limit', async () => {
    await expect(polishCatalogText({ name: 'clean name' }, { userId: 'u1', orgId: null, partnerId: 'p1' }))
      .rejects.toMatchObject({ code: 'AI_ORG_REQUIRED', status: 400 });
    expect(create).not.toHaveBeenCalled();
    expect(checkBudget).not.toHaveBeenCalled();
    expect(settleInvocation).not.toHaveBeenCalled();
  });

  it('keeps the per-user rate limit on the declared system-initiated org-less path', async () => {
    checkUserAiRateLimit.mockResolvedValueOnce('Rate limit exceeded');
    await expect(polishCatalogText({ name: 'x' }, {
      userId: 'u1', orgId: null, partnerId: 'p1', systemInitiated: true,
    })).rejects.toMatchObject({ code: 'AI_LIMIT', status: 429 });
    expect(create).not.toHaveBeenCalled();
  });

  it('warns on a UNIT swap that keeps the digit (16GB → 16TB)', async () => {
    create
      .mockResolvedValueOnce(aiMessage({ name: '16TB DDR4 module', description: null }))
      .mockResolvedValueOnce(aiMessage({ name: '16TB DDR4 module', description: null }));
    const res = await polishCatalogText({ name: '16gb ddr4 module' }, actor);
    expect(res.factChanges).not.toBeNull();
    expect(res.factChanges?.added).toContain('16tb');
    expect(res.factChanges?.removed).toContain('16gb');
  });

  it('warns on a PRICE change ($549.99 → $559.99)', async () => {
    create
      .mockResolvedValueOnce(aiMessage({ name: null, description: 'Monitor, $559.99 street price.' }))
      .mockResolvedValueOnce(aiMessage({ name: null, description: 'Monitor, $559.99 street price.' }));
    const res = await polishCatalogText({ description: 'monitor $549.99 street price' }, actor);
    expect(res.factChanges).not.toBeNull();
    expect(res.factChanges?.added).toContain('559.99');
    expect(res.factChanges?.removed).toContain('549.99');
  });

  it('warns (removed-only) when the bare quantity multiplier is dropped (2 × 2TB → 2TB)', async () => {
    create
      .mockResolvedValueOnce(aiMessage({ name: 'Dual 2TB NAS', description: null }))
      .mockResolvedValueOnce(aiMessage({ name: 'Dual 2TB NAS', description: null }));
    // input has bare "2" (the ×2 multiplier) and "2tb"; output keeps a single
    // "2tb" and drops the bare "2". Dropping a token is the non-misleading
    // direction, so it's surfaced as a removed-only warning (nothing added)
    // rather than blocking.
    const res = await polishCatalogText({ name: '2 x 2tb nas' }, actor);
    expect(res.factChanges).not.toBeNull();
    expect(res.factChanges?.removed).toContain('2');
    expect(res.factChanges?.added).toEqual([]);
  });

  it('does NOT block a legitimate clean-up that strips a digit-bearing distributor code (the #2270 bug)', async () => {
    // Regression: the prompt tells the model to strip "internal order codes", but
    // an order code (ORD-44718) contributes a "44718" fact token. Before this
    // fix, dropping it tripped the guard on both attempts → hard 502 on exactly
    // the distributor-sourced lines. Now the clean-up succeeds with a
    // removed-only advisory warning.
    const polished = {
      name: 'Battery Backup (UPS)',
      description: 'APC Back-UPS Pro BR1500MS2\n• 1500VA\n• 10 outlets',
    };
    // Both turns correctly strip the order code, so the guard trips both times —
    // it must still return the clean-up (with a warning), never a hard failure.
    create
      .mockResolvedValueOnce(aiMessage(polished))
      .mockResolvedValueOnce(aiMessage(polished));
    const res = await polishCatalogText(
      { name: 'SPL APC-BR1500MS2 DISTI', description: 'APC Back-UPS Pro 1500VA, 10 outlets, ORD-44718' },
      actor,
    );
    expect(res.name).toBe('Battery Backup (UPS)');
    expect(res.factChanges).not.toBeNull();
    expect(res.factChanges?.removed).toContain('44718');
    expect(res.factChanges?.added).toEqual([]);
    // Removed-only (stripped noise) is the safe direction — it must NOT raise a
    // Sentry over-claim signal, or the alert would be pure noise on every
    // distributor line.
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('surfaces a combined warning when BOTH name and description drift together', async () => {
    // name drops the bare "2" multiplier; description swaps 500GB → 512GB. The
    // guard combines both fields into one multiset, so factChanges must aggregate
    // across name AND description, not just one field.
    create
      .mockResolvedValueOnce(aiMessage({ name: 'Dell Laptop', description: '512GB SSD, 16GB RAM' }))
      .mockResolvedValueOnce(aiMessage({ name: 'Dell Laptop', description: '512GB SSD, 16GB RAM' }));
    const res = await polishCatalogText(
      { name: '2 x Dell Laptop', description: '500GB SSD, 16GB RAM' },
      actor,
    );
    expect(res.factChanges).not.toBeNull();
    expect(res.factChanges?.added).toContain('512gb');   // from the description
    expect(res.factChanges?.removed).toEqual(expect.arrayContaining(['2', '500gb'])); // name + description
  });

  it('allows decimal/trailing-zero reformatting (1.50 ↔ 1.5) — not drift', async () => {
    create.mockResolvedValueOnce(aiMessage({ name: '1.5 GHz mini PC', description: null }));
    const res = await polishCatalogText({ name: '1.50ghz mini pc' }, actor);
    expect(res.name).toBe('1.5 GHz mini PC');
    expect(res.changed).toBe(true);
  });

  it('allows a numeric spec to MOVE from name into description — not drift', async () => {
    create.mockResolvedValueOnce(aiMessage({
      name: 'APC Back-UPS', description: '600VA battery backup unit.',
    }));
    const res = await polishCatalogText(
      { name: 'apc back-ups 600va', description: 'battery backup unit' },
      actor,
    );
    expect(res.name).toBe('APC Back-UPS');
    expect(res.description).toBe('600VA battery backup unit.');
  });

  it('never invents a description when only a name was provided', async () => {
    create.mockResolvedValueOnce(aiMessage({ name: 'Clean Name', description: 'Invented blurb.' }));
    const res = await polishCatalogText({ name: 'clean name' }, actor);
    expect(res.description).toBeNull();
    expect(res.name).toBe('Clean Name');
  });

  it('throws AI_PARSE (not AI_FACT_DRIFT) when the model never returns parseable JSON', async () => {
    create
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }], usage: { input_tokens: 10, output_tokens: 5 } })
      .mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: '```still not json```' }], usage: { input_tokens: 10, output_tokens: 5 } });
    await expect(polishCatalogText({ name: 'apc 600va' }, actor))
      .rejects.toMatchObject({ code: 'AI_PARSE', status: 502 });
  });

  it('records the SUMMED tokens across both attempts even when it returns a fact warning', async () => {
    create
      .mockResolvedValueOnce(aiMessage({ name: '650VA UPS', description: null }))   // drift, 100/50
      .mockResolvedValueOnce(aiMessage({ name: '650VA UPS', description: null }));  // drift, 100/50
    const res = await polishCatalogText({ name: 'apc 600va ups' }, actor);
    expect(res.factChanges).not.toBeNull();
    // Tokens were really spent on both turns — they must still be billed.
    const settled = settleInvocation.mock.calls[0]![0] as { usage: Array<{ tokens: { input: number; output: number } }>; reservationId: string };
    expect(settled.usage.reduce((n, u) => n + u.tokens.input, 0)).toBe(200);
    expect(settled.usage.reduce((n, u) => n + u.tokens.output, 0)).toBe(100);
    expect(settled.reservationId).toBe(RESERVATION_ID);
  });
});

// ---------------------------------------------------------------------------
// Review S6 — org-less catalog AI spend fails closed
// ---------------------------------------------------------------------------

describe('org-less catalog AI is refused before any provider work', () => {
  const orglessActor = { userId: 'u1', orgId: null as string | null, partnerId: 'p1' };

  beforeEach(() => {
    create.mockReset();
    reserveAiBudget.mockReset();
    checkUserAiRateLimit.mockClear();
    resolveModel.mockClear();
  });

  it('refuses enrichCatalogItem with no organization, before resolving a provider client', async () => {
    const thrown = await enrichCatalogItem('a widget', undefined, orglessActor)
      .catch((err: unknown) => err);

    expect(thrown).toBeInstanceOf(EnrichmentError);
    expect(thrown).toMatchObject({ code: 'AI_ORG_REQUIRED', status: 400 });
    // Fail CLOSED, and early: no key chosen, no reservation, no model call. The
    // previous behaviour was a per-user rate limit plus a console warning, then
    // a dispatch — paid web-search turns on the platform key that no ledger
    // ever saw.
    expect(resolveModel).not.toHaveBeenCalled();
    expect(reserveAiBudget).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(settleInvocation).not.toHaveBeenCalled();
  });

  it('refuses polishCatalogText with no organization, before resolving a provider client', async () => {
    const thrown = await polishCatalogText({ name: 'a widget' }, orglessActor)
      .catch((err: unknown) => err);

    expect(thrown).toBeInstanceOf(EnrichmentError);
    expect(thrown).toMatchObject({ code: 'AI_ORG_REQUIRED', status: 400 });
    expect(resolveModel).not.toHaveBeenCalled();
    expect(reserveAiBudget).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    // The per-user rate limit is no longer what stands between an org-less
    // caller and the provider, so it is not even consulted.
    expect(checkUserAiRateLimit).not.toHaveBeenCalled();
  });
});
