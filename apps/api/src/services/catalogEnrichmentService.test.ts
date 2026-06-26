import { describe, it, expect, vi, beforeEach } from 'vitest';

const { create, checkBudget, checkAiRateLimit, recordUsage } = vi.hoisted(() => ({
  create: vi.fn(),
  checkBudget: vi.fn(async (): Promise<string | null> => null),
  checkAiRateLimit: vi.fn(async (): Promise<string | null> => null),
  recordUsage: vi.fn(async () => {}),
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class { messages = { create }; },
}));
vi.mock('./aiAgent', () => ({ resolveDefaultModel: () => 'claude-sonnet-4-6' }));
vi.mock('./aiCostTracker', () => ({ checkBudget, checkAiRateLimit, recordUsage }));

import { enrichCatalogItem, EnrichmentError } from './catalogEnrichmentService';

const actor = { userId: 'u1', orgId: 'o1' };

function aiMessage(json: object) {
  return {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(json) }],
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

beforeEach(() => {
  create.mockReset();
  checkBudget.mockClear(); checkAiRateLimit.mockClear(); recordUsage.mockClear();
  checkBudget.mockResolvedValue(null); checkAiRateLimit.mockResolvedValue(null);
});

describe('enrichCatalogItem', () => {
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
    expect(res.provenance.source).toBe('ai_enrich');
    expect(recordUsage).toHaveBeenCalledTimes(1);
  });

  it('returns null priceGuidance when no usable range', async () => {
    create.mockResolvedValueOnce(aiMessage({
      name: 'Mystery', description: null, itemType: 'service',
      unitOfMeasure: 'each', taxable: true, taxCategory: null,
      priceLow: null, priceHigh: null, currency: null, confidence: 0.2, notes: '',
    }));
    const res = await enrichCatalogItem('Mystery', undefined, actor);
    expect(res.priceGuidance).toBeNull();
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

  it('skips org-scoped guardrails and cost when orgId is null', async () => {
    create.mockResolvedValueOnce(aiMessage({
      name: 'N', description: null, itemType: 'service',
      unitOfMeasure: 'each', taxable: true, taxCategory: null,
      priceLow: null, priceHigh: null, currency: null, confidence: 0.5, notes: '',
    }));
    await enrichCatalogItem('x', undefined, { userId: 'u1', orgId: null });
    expect(checkBudget).not.toHaveBeenCalled();
    expect(recordUsage).not.toHaveBeenCalled();
  });
});
