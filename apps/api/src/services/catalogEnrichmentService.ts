import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import { resolveDefaultModel } from './aiAgent';
import { checkBudget, checkAiRateLimit, recordUsage } from './aiCostTracker';
import {
  enrichDraftSchema,
  type EnrichResponse,
  type EnrichmentProvenance,
} from '@breeze/shared';

export class EnrichmentError extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'EnrichmentError';
    this.code = code;
    this.status = status;
  }
}

export interface EnrichmentActor {
  userId: string;
  orgId: string | null;
}

export interface EnrichmentProvider {
  enrich(query: string, hint: string | undefined, actor: EnrichmentActor): Promise<EnrichResponse>;
}

const MONEY_MAX = 9_999_999_999.99;

const SYSTEM_PROMPT =
  'You are a product catalog assistant for an MSP billing system. Given a product ' +
  'name or SKU, use web search to find current details, then respond with ONLY a single ' +
  'JSON object (no prose, no code fences) of the exact shape:\n' +
  '{"name":string,"description":string|null,"itemType":"hardware"|"software"|"service",' +
  '"unitOfMeasure":string,"taxable":boolean,"taxCategory":string|null,' +
  '"priceLow":number|null,"priceHigh":number|null,"currency":string|null,' +
  '"confidence":number,"notes":string}\n' +
  'priceLow/priceHigh are a TYPICAL street-price RANGE in the item currency; never a ' +
  'single committed price. If unknown, use null. Do not invent a price you are unsure of.';

function clampMoney(n: unknown): number | null {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  return Math.min(n, MONEY_MAX);
}

function priceGuidanceFrom(low: number | null, high: number | null, currency: string | null): string | null {
  const sym = currency === 'USD' || currency == null ? '$' : `${currency} `;
  if (low != null && high != null) return `typically ${sym}${low}–${high}`;
  if (low != null) return `from ${sym}${low}`;
  if (high != null) return `up to ${sym}${high}`;
  return null;
}

function lastTextBlock(content: Array<{ type: string; text?: string }>): string | null {
  for (let i = content.length - 1; i >= 0; i--) {
    const b = content[i];
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) return b.text;
  }
  return null;
}

export const aiEnrichmentProvider: EnrichmentProvider = {
  async enrich(query, hint, actor) {
    if (actor.orgId) {
      const rate = await checkAiRateLimit(actor.userId, actor.orgId);
      if (rate) throw new EnrichmentError(rate, 'AI_LIMIT', 429);
      const budget = await checkBudget(actor.orgId);
      if (budget) throw new EnrichmentError(budget, 'AI_LIMIT', 429);
    } else {
      console.warn('[catalog-enrich] no org context — skipping budget/rate checks');
    }

    const model = resolveDefaultModel();
    const client = new Anthropic();
    // SDK 0.105 lacks the web-search tool type; the GA tool is valid at the API layer.
    const tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }] as unknown as
      Anthropic.Messages.ToolUnion[];
    const hintLine = hint ? `\nThe user expects itemType to be "${hint}" unless clearly wrong.` : '';

    const messages: Anthropic.Messages.MessageParam[] = [
      { role: 'user', content: `Product: ${query}${hintLine}` },
    ];

    let totalIn = 0;
    let totalOut = 0;
    let finalText: string | null = null;

    for (let i = 0; i < 4; i++) {
      const resp = await client.messages.create({
        model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools,
        messages,
      });
      totalIn += resp.usage?.input_tokens ?? 0;
      totalOut += resp.usage?.output_tokens ?? 0;
      if (resp.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: resp.content });
        continue;
      }
      finalText = lastTextBlock(resp.content as Array<{ type: string; text?: string }>);
      break;
    }

    if (actor.orgId) {
      recordUsage('catalog-enrich-' + randomUUID(), actor.orgId, model, totalIn, totalOut, true)
        .catch((err) => console.error('[catalog-enrich] recordUsage failed:', err));
    }

    if (!finalText) throw new EnrichmentError('AI returned no text', 'AI_PARSE', 502);

    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(finalText) as Record<string, unknown>;
    } catch {
      throw new EnrichmentError('Could not parse AI response', 'AI_PARSE', 502);
    }

    const draftParse = enrichDraftSchema.safeParse({
      name: raw.name,
      description: raw.description ?? null,
      itemType: raw.itemType ?? hint ?? 'service',
      unitOfMeasure: typeof raw.unitOfMeasure === 'string' && raw.unitOfMeasure ? raw.unitOfMeasure : 'each',
      taxable: typeof raw.taxable === 'boolean' ? raw.taxable : true,
      taxCategory: (raw.taxCategory as string | null) ?? null,
    });
    if (!draftParse.success) throw new EnrichmentError('AI response missing required fields', 'AI_PARSE', 502);

    const low = clampMoney(raw.priceLow);
    const high = clampMoney(raw.priceHigh);
    const currency = typeof raw.currency === 'string' ? raw.currency : null;

    const provenance: EnrichmentProvenance = {
      source: 'ai_enrich',
      model,
      query,
      suggestion: raw,
      enrichedAt: new Date().toISOString(),
      enrichedBy: actor.userId,
    };

    return {
      draft: draftParse.data,
      priceGuidance: priceGuidanceFrom(low, high, currency),
      provenance,
    };
  },
};

export function enrichCatalogItem(
  query: string,
  hint: string | undefined,
  actor: EnrichmentActor,
): Promise<EnrichResponse> {
  return aiEnrichmentProvider.enrich(query, hint, actor);
}
