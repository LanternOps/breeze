import type { OptionSupport, PromptProfile } from '@breeze/shared';
import type { ThinkingMode } from './aiModels/capabilities';

// Platform default model and the W01 bootstrap rules for models the registry
// (ai_platform_models) does not describe. A stale id makes the Claude Agent
// SDK report total_cost_usd: 0 (issue #1326). #7587 moved the default to
// Sonnet 5.5, which rejects `thinking: disabled`; thinking params are now
// built by services/aiModels/wireParams.ts.
//
// This is the ONE file outside the registry seed and test fixtures that may
// hold model-family knowledge (index invariant 1).
export const BREEZE_FALLBACK_MODEL = 'claude-sonnet-5-5';

// ANTHROPIC_MODEL (#1412) overrides the default for self-hosted operators
// pointing at a raw vLLM backend whose served model id differs from the
// Anthropic alias. With a LiteLLM gateway the alias route maps
// claude-sonnet-5-5 → backend model, so the override is unnecessary there.
// A whitespace-only/empty value falls back to the Anthropic default (never an
// empty model id). Billing never uses the SDK's own cost: every call is priced
// from the model's registry row. The registry cutover bootstraps a platform row
// for an env model it does not know at the legacy conservative rate (Opus-tier
// $5/$25 per MTok), i.e. an OVER-estimate for a cheap local model, not $0. For
// accurate accounting set its price on /admin/ai-models (or, for an env
// OpenAI-compatible endpoint, MCP_LLM_PRICE_*, which price its env-managed
// registry offering).
export function resolveDefaultModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.ANTHROPIC_MODEL?.trim() || BREEZE_FALLBACK_MODEL;
}

// AI model registry (spec §5.1 prompt_profile): derived from the id family
// for newly discovered models. The operator can override it on
// /admin/ai-models. aiModel.ts is the one file allowed to hold model-family
// knowledge (index invariant 1).
const CLAUDE_FAMILY_ID = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d{1,2})(?:-|$)/;

export function derivePromptProfile(modelId: string): PromptProfile {
  const match = CLAUDE_FAMILY_ID.exec(modelId);
  if (!match) return 'generic';
  const family = match[1];
  if (family === 'haiku') return 'claude-small';
  if (family === 'fable' || family === 'mythos' || (family === 'opus' && Number(match[2]) >= 5)) return 'claude-frontier';
  return 'claude-standard';
}

// ---------------------------------------------------------------------------
// W00 (#7587) bootstrap rules, moved verbatim from the deleted
// interim resolver. Used only when the registry can't answer:
// - a cold snapshot;
// - an unregistered id (catalog wire ids, BYO gateways, ANTHROPIC_MODEL);
// - a row whose capabilities derive to 'unknown'.
// W03's resolveModel removes the remaining callers.
// ---------------------------------------------------------------------------

// `claude-<family>-<major>[-<minor>][-<YYYYMMDD>]`: the minor is 1–2 digits and
// a dated snapshot suffix is exactly 8, so `claude-opus-4-6-20260101` parses as
// Opus 4.6 and nothing else can ride in on a trailing segment.
const FIRST_PARTY_MODEL_ID = /^claude-(opus|sonnet|haiku|fable)-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{8})?$/;

/**
 * Fable 5.x, Opus/Sonnet 5+, Opus 4.6–4.8 and Sonnet 4.6 run adaptive thinking.
 * Effort excludes `xhigh`, which 4.6 rejects. Every other first-party id
 * (Haiku 4.5, Opus/Sonnet ≤ 4.5) is `budget`, so thinking is explicitly
 * off. Anything else is `unknown`, which also becomes an explicit off on the
 * Agent SDK, exactly as W00 sent.
 */
export function legacyWireProfile(modelId: string): { thinkingMode: ThinkingMode; optionSupport: OptionSupport } {
  const match = FIRST_PARTY_MODEL_ID.exec(modelId);
  if (!match) {
    return { thinkingMode: 'unknown', optionSupport: { effort: [], thinkingDisplay: [], speed: ['standard'], inferenceGeo: [] } };
  }
  const family = match[1];
  const major = Number(match[2]);
  const minor = match[3] === undefined ? 0 : Number(match[3]);
  const adaptive = family === 'fable'
    || ((family === 'opus' || family === 'sonnet') && (major >= 5 || (major === 4 && minor >= 6)));
  return adaptive
    ? {
      thinkingMode: 'adaptive',
      optionSupport: { effort: ['low', 'medium', 'high', 'max'], thinkingDisplay: ['omitted', 'summarized'], speed: ['standard'], inferenceGeo: [] },
    }
    : { thinkingMode: 'budget', optionSupport: { effort: [], thinkingDisplay: [], speed: ['standard'], inferenceGeo: [] } };
}

/**
 * Whether the Messages API thinks when the `thinking` param is omitted:
 * Fable and Opus/Sonnet 5+ do; Opus/Sonnet 4.6–4.8 do not. The Models API
 * doesn't expose this, so W01 keeps W00's rule for the one-shot "only
 * reduce thinking" gate. W03 replaces it with per-surface assignment options.
 */
export function legacyThinksWhenOmitted(modelId: string): boolean {
  const match = FIRST_PARTY_MODEL_ID.exec(modelId);
  if (!match) return false;
  const family = match[1];
  return family === 'fable' || ((family === 'opus' || family === 'sonnet') && Number(match[2]) >= 5);
}
