import type { AiCoverage } from '@breeze/shared';

/** One price-list row as edited in the drawer. Amounts stay strings end to end
 * (the API stores numeric(14,6)); the patterns below mirror the shared zod
 * `aiRateRowSchema` / `aiMarkupPercentSchema`, which remain the server authority. */
export interface AiRateDraft {
  modelId: string;
  inputPricePerM: string;
  outputPricePerM: string;
  cacheReadPricePerM: string;
  cacheWritePricePerM: string;
  notes?: string | null;
}
export interface AiUsageValue {
  aiCoverage: AiCoverage;
  aiMarkupPercent: string | null;
  aiRates: AiRateDraft[];
}
export interface AiModelChoice { modelId: string; label: string; source: 'offering' | 'recent_usage' }

export const PRICE_PATTERN = /^\d{1,8}(\.\d{1,6})?$/;
export const MARKUP_PATTERN = /^\d{1,4}(\.\d{1,2})?$/;
export const PRICE_FIELDS = ['inputPricePerM', 'outputPricePerM', 'cacheReadPricePerM', 'cacheWritePricePerM'] as const;
export const EMPTY_RATE: AiRateDraft = { modelId: '', inputPricePerM: '', outputPricePerM: '', cacheReadPricePerM: '', cacheWritePricePerM: '' };

/** Profiles from older API responses (or fixtures) may lack the AI fields. */
export function normalizeAiUsage(source?: Partial<AiUsageValue> | null): AiUsageValue {
  return {
    aiCoverage: source?.aiCoverage ?? 'non_billable',
    aiMarkupPercent: source?.aiMarkupPercent ?? null,
    aiRates: (source?.aiRates ?? []).map(rate => ({ ...rate })),
  };
}

export interface AiUsageValidation {
  markupInvalid: boolean;
  rows: Array<{ invalid: boolean; duplicate: boolean }>;
  valid: boolean;
}
export function validateAiUsage(value: AiUsageValue): AiUsageValidation {
  if (value.aiCoverage !== 'billable') return { markupInvalid: false, rows: [], valid: true };
  const markup = value.aiMarkupPercent;
  const markupInvalid = markup !== null && markup !== '' && (!MARKUP_PATTERN.test(markup) || Number(markup) > 1000);
  const seen = new Set<string>();
  const rows = value.aiRates.map(rate => {
    const modelId = rate.modelId.trim();
    const duplicate = modelId !== '' && seen.has(modelId);
    if (modelId !== '') seen.add(modelId);
    const invalid = modelId === '' || modelId.length > 200 || PRICE_FIELDS.some(field => !PRICE_PATTERN.test(rate[field]));
    return { invalid, duplicate };
  });
  return { markupInvalid, rows, valid: !markupInvalid && rows.every(row => !row.invalid && !row.duplicate) };
}

/** The exact fields added to the drawer's save/create body. Non-billable cards
 * send no markup and an empty price list so the server never stores dead terms. */
export function aiUsageRequestFields(value: AiUsageValue) {
  if (value.aiCoverage !== 'billable') return { aiCoverage: value.aiCoverage, aiMarkupPercent: null, aiRates: [] as AiRateDraft[] };
  return {
    aiCoverage: value.aiCoverage,
    aiMarkupPercent: value.aiMarkupPercent === '' ? null : value.aiMarkupPercent,
    aiRates: value.aiRates.map(({ modelId, inputPricePerM, outputPricePerM, cacheReadPricePerM, cacheWritePricePerM, notes }) => ({
      modelId: modelId.trim(), inputPricePerM, outputPricePerM, cacheReadPricePerM, cacheWritePricePerM, ...(notes ? { notes } : {}),
    })),
  };
}

/** Breeze's cost is USD, so a markup cannot price a non-USD card; only a price
 * list in the card currency can. */
export function showUsdOnlyWarning(value: AiUsageValue, currencyCode: string): boolean {
  return value.aiCoverage === 'billable' && currencyCode !== 'USD' && value.aiRates.length === 0;
}
