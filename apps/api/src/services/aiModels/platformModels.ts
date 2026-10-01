// apps/api/src/services/aiModels/platformModels.ts
/**
 * AI model registry W01 (#7599): the platform model catalog
 * (`ai_platform_models`). Task 7 adds the type and the row mapper; Task 9 adds
 * the database functions to this file.
 */
import {
  emptyOptionSupport,
  optionRatesSchema,
  optionSupportSchema,
  type ModelLifecycle,
  type ModelRates,
  type OptionRates,
  type OptionSupport,
  type PromptProfile,
} from '@breeze/shared';
import type { AiPlatformModelRow } from '../../db/schema';

export interface PlatformModel {
  id: string;
  provider: 'anthropic';
  modelId: string;
  displayName: string;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  /** Raw Models API capabilities tree (or the seed's stand-in until the first sync sees the model). */
  capabilities: unknown;
  /** All four standard rates, or null when any is unset (unpriced). */
  rates: ModelRates | null;
  optionRates: OptionRates | null;
  optionSupport: OptionSupport;
  minPlan: string | null;
  promptProfile: PromptProfile;
  platformOffered: boolean;
  isPlatformDefault: boolean;
  lifecycle: ModelLifecycle;
  missedSyncCount: number;
  operatorNotifiedAt: Date | null;
  firstSeenAt: Date;
  /** Null until a discovery sync has seen the model (seeded rows start null). */
  lastSeenAt: Date | null;
  updatedAt: Date;
}

function toNumber(value: number | string | null): number | null {
  if (value === null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function toPlatformModel(row: AiPlatformModelRow): PlatformModel {
  const input = toNumber(row.inputCentsPerM);
  const output = toNumber(row.outputCentsPerM);
  const cacheRead = toNumber(row.cacheReadCentsPerM);
  const cacheWrite = toNumber(row.cacheWriteCentsPerM);
  const rates = input !== null && output !== null && cacheRead !== null && cacheWrite !== null
    ? { inputCentsPerM: input, outputCentsPerM: output, cacheReadCentsPerM: cacheRead, cacheWriteCentsPerM: cacheWrite }
    : null;

  const support = optionSupportSchema.safeParse(row.optionSupport);
  if (!support.success) {
    console.warn(`[aiModels] ai_platform_models.option_support for "${row.modelId}" is malformed; treating it as empty`);
  }
  let optionRates: OptionRates | null = null;
  if (row.optionRates !== null) {
    const parsed = optionRatesSchema.safeParse(row.optionRates);
    if (parsed.success) optionRates = parsed.data;
    else console.warn(`[aiModels] ai_platform_models.option_rates for "${row.modelId}" is malformed; ignoring it`);
  }

  return {
    id: row.id,
    provider: 'anthropic',
    modelId: row.modelId,
    displayName: row.displayName,
    maxInputTokens: row.maxInputTokens,
    maxOutputTokens: row.maxOutputTokens,
    capabilities: row.capabilities ?? null,
    rates,
    optionRates,
    optionSupport: support.success ? support.data : emptyOptionSupport(),
    minPlan: row.minPlan,
    promptProfile: row.promptProfile,
    platformOffered: row.platformOffered,
    isPlatformDefault: row.isPlatformDefault,
    lifecycle: row.lifecycle,
    missedSyncCount: row.missedSyncCount,
    operatorNotifiedAt: row.operatorNotifiedAt,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    updatedAt: row.updatedAt,
  };
}
