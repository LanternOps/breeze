// Current model id so the Claude Agent SDK can price it natively. A stale id makes the
// SDK report total_cost_usd: 0 → $0.00 cost tracking (issue #1326). Successor to the
// previous default claude-sonnet-4-5-20250929, at the same $3/$15 per-MTok tier.
export const BREEZE_FALLBACK_MODEL = 'claude-sonnet-4-6';

// ANTHROPIC_MODEL (#1412) overrides the default for self-hosted operators
// pointing at a raw vLLM backend whose served model id differs from the
// Anthropic alias. With a LiteLLM gateway the alias route maps
// claude-sonnet-4-6 → backend model, so the override is unnecessary there.
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
