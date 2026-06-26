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

  it('throws AI_PARSE on non-JSON output', async () => {
    create.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'sorry, no idea' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    await expect(enrichCatalogItem('x', undefined, actor)).rejects.toBeInstanceOf(EnrichmentError);
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
