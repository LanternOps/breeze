import type { PromptProfile } from '@breeze/shared';

// Current model id so the Claude Agent SDK can price it natively. A stale id makes the
// SDK report total_cost_usd: 0 → $0.00 cost tracking (issue #1326). #7587 moved the
// default from claude-sonnet-4-6 ($3/$15) to Sonnet 5.5 ($2/$10), which rejects
// `thinking: disabled` — see resolveModelThinking (aiModelThinking.ts).
export const BREEZE_FALLBACK_MODEL = 'claude-sonnet-5-5';

// ANTHROPIC_MODEL (#1412) overrides the default for self-hosted operators
// pointing at a raw vLLM backend whose served model id differs from the
// Anthropic alias. With a LiteLLM gateway the alias route maps
// claude-sonnet-5-5 → backend model, so the override is unnecessary there.
// A whitespace-only/empty value falls back to the Anthropic default (never an
// empty model id). Cost tracking stays best-effort: the SDK can't price a
// non-Anthropic model id so it reports total_cost_usd=0, then aiCostTracker
// falls back to token-based pricing — and an unrecognized model id is priced at
// conservative DEFAULT_PRICING (Opus-tier $5/$25 per MTok), i.e. an OVER-estimate
// for a cheap local model, not $0. For accurate accounting add the model to
// MODEL_PRICING (aiCostTracker.ts), or use the openai-compatible path's
// MCP_LLM_PRICE_* overrides.
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
