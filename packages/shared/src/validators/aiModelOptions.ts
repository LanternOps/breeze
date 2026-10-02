/**
 * AI model registry (#7598) option contract. Shared by the API (registry,
 * wire-param derivation, pricing) and the web (/admin/ai-models). Leaf module:
 * zod only, because the package root barrel is bundled into the browser.
 *
 * MODEL_LIFECYCLES and PROMPT_PROFILES are mirrored 1:1 by CHECK constraints in
 * apps/api/migrations/2026-11-13-100000-ai-platform-models.sql. Edit both sides
 * together; aiPlatformModels.contract.test.ts fails otherwise.
 */
import { z } from 'zod';

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export const THINKING_DISPLAYS = ['omitted', 'summarized', 'updates'] as const;
export type ThinkingDisplay = (typeof THINKING_DISPLAYS)[number];

export const MODEL_SPEEDS = ['standard', 'fast'] as const;
export type ModelSpeed = (typeof MODEL_SPEEDS)[number];

/** Prompt-variant family (spec §7). Profile names, not model ids. */
export const PROMPT_PROFILES = ['claude-frontier', 'claude-standard', 'claude-small', 'generic'] as const;
export type PromptProfile = (typeof PROMPT_PROFILES)[number];

export const MODEL_LIFECYCLES = ['available', 'missing', 'retired'] as const;
export type ModelLifecycle = (typeof MODEL_LIFECYCLES)[number];

/** Anthropic `inference_geo` tokens are short lowercase identifiers ("us", "global"). */
export const INFERENCE_GEO_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

function uniqueArray<T extends z.ZodTypeAny>(item: T) {
  return z.array(item).refine((values) => new Set(values).size === values.length, {
    message: 'values must be unique',
  });
}

const centsPerMillion = z.number().finite().min(0).max(1_000_000);

/** Cents per million tokens. All four are required: there is no "partly priced" model. */
export const modelRatesSchema = z.object({
  inputCentsPerM: centsPerMillion,
  outputCentsPerM: centsPerMillion,
  cacheReadCentsPerM: centsPerMillion,
  cacheWriteCentsPerM: centsPerMillion,
}).strict();
export type ModelRates = z.infer<typeof modelRatesSchema>;

/**
 * Manual-budget thinking for `budget`-mode models (spec §7 table: "Thinking:
 * off / on (budget)"). W05 (#7603). Meaningless on adaptive models, which
 * ignore it; buildWireParams reads it only in its budget branch.
 */
export const BUDGET_THINKING_STATES = ['off', 'on'] as const;
export type BudgetThinking = (typeof BUDGET_THINKING_STATES)[number];

/** Per-call knobs (spec §4). Every key is optional: absent = inherit / provider default. */
export const offeringOptionsSchema = z.object({
  effort: z.enum(EFFORT_LEVELS).optional(),
  thinkingDisplay: z.enum(THINKING_DISPLAYS).optional(),
  speed: z.enum(MODEL_SPEEDS).optional(),
  budgetThinking: z.enum(BUDGET_THINKING_STATES).optional(),
}).strict();

export type OfferingOptions = z.infer<typeof offeringOptionsSchema>;

/** What a model accepts for each knob, plus the inference geographies it can serve. */
export const optionSupportSchema = z.object({
  effort: uniqueArray(z.enum(EFFORT_LEVELS)),
  thinkingDisplay: uniqueArray(z.enum(THINKING_DISPLAYS)),
  speed: uniqueArray(z.enum(MODEL_SPEEDS)).refine((speeds) => speeds.includes('standard'), {
    message: "speed must include 'standard'",
  }),
  inferenceGeo: uniqueArray(z.string().regex(INFERENCE_GEO_PATTERN)).refine((geos) => geos.length <= 16, {
    message: 'at most 16 inference geographies',
  }),
}).strict();
export type OptionSupport = z.infer<typeof optionSupportSchema>;

/** Rate keys for non-standard option variants. A variant without a rate is not selectable (spec §8). */
export const OPTION_RATE_KEYS = ['speed:fast'] as const;
export type OptionRateKey = (typeof OPTION_RATE_KEYS)[number];

export const optionRatesSchema = z.object({
  'speed:fast': modelRatesSchema.optional(),
}).strict();
export type OptionRates = z.infer<typeof optionRatesSchema>;

export function emptyOptionSupport(): OptionSupport {
  return { effort: [], thinkingDisplay: [], speed: ['standard'], inferenceGeo: [] };
}
