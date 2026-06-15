# Configurable Anthropic base URL for the AI Agent (vLLM / LiteLLM / Anthropic-compatible backends)

**Status:** Draft
**Date:** 2026-06-15
**Origin:** Discussion #505 (alternative LLM backends), phase 2. Supersedes the need to build a separate tool-dispatch surface on the openai-compatible path (PR #859).

## Motivation

Self-hosters want to run the Breeze AI Agent against their own LLM infrastructure (local vLLM, a LiteLLM gateway, etc.) instead of Anthropic's hosted API. PR #859 shipped a chat-only `openai-compatible` provider, but it has no tool-use and no guardrails, so it cannot drive the actual agent.

As of vLLM 0.23, vLLM exposes an Anthropic-compatible `/v1/messages` endpoint, and LiteLLM offers an Anthropic passthrough. Both speak the same dialect the `@anthropic-ai/claude-agent-sdk` already uses. That means we do not need a new provider path: we can point the existing SDK at an Anthropic-compatible base URL and inherit the full agent loop, tool-use, and guardrails unchanged.

## Current state (as of main, v0.70.0+)

- **SDK path:** `apps/api/src/services/streamingSessionManager.ts:15-45` invokes `query()` from `@anthropic-ai/claude-agent-sdk`, spawned as a per-session subprocess. The model + system prompt are passed per session from `apps/api/src/services/aiAgent.ts:113` (default `claude-sonnet-4-6`).
- **Subprocess env allowlist:** `streamingSessionManager.ts:42-64` forwards a filtered allowlist to the child: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, proxy/cert vars. **`ANTHROPIC_BASE_URL` is NOT forwarded** — this is the one real gap.
- **Guardrails:** `apps/api/src/services/aiGuardrails.ts` (RBAC, Tier 1-4 tool gating, per-tool rate limits, cost tracking) wrap the Anthropic SDK path only (`aiAgentSdk.ts`). The openai-compatible path has none.
- **openai-compatible path:** gated by `MCP_LLM_PROVIDER=openai-compatible` (`apps/api/src/routes/ai.ts:50-87`), served by `services/llm/openaiSessionManager.ts` + `openaiCompatibleProvider.ts`. Chat-only; no `tools` sent and `tool_calls` rejected (`openaiCompatibleProvider.ts:10-11,172-186`). Env: `MCP_LLM_BASE_URL`, `MCP_LLM_API_KEY`, `MCP_LLM_MODEL`, optional `MCP_LLM_PRICE_INPUT_PER_M_USD` / `MCP_LLM_PRICE_OUTPUT_PER_M_USD`.
- **Config/env validation:** `apps/api/src/config/validate.ts` + `config/env.ts`. No `ANTHROPIC_BASE_URL` is declared today.

## Goal

A self-hosted operator can set the AI Agent to talk to any Anthropic-compatible `/v1/messages` endpoint, keeping full tool-use and the existing guardrails, without code changes on their side.

## Design

1. **Config.** Add optional `ANTHROPIC_BASE_URL` to the env schema (`config/env.ts` + `config/validate.ts`). When set, validate it is a well-formed `https?://` URL.
2. **Forward to the SDK subprocess.** Add `ANTHROPIC_BASE_URL` to the allowlist in `streamingSessionManager.ts:42-64`. The SDK reads it natively, so no other code change is needed for the happy path.
3. **Auth.** `ANTHROPIC_AUTH_TOKEN` is already forwarded. Document: for a self-hosted backend, set `ANTHROPIC_BASE_URL` plus `ANTHROPIC_AUTH_TOKEN` (a LiteLLM virtual key or vLLM token).
4. **Model name.** The per-session model defaults to `claude-sonnet-4-6`. Two supported routes:
   - **Recommended:** run LiteLLM in front and alias `claude-sonnet-4-6` (and any other model strings the agent requests) to the backend model. No code change.
   - **Optional:** add `ANTHROPIC_MODEL` config override applied at `aiAgent.ts:113` when a base URL is set, for raw vLLM without an alias layer.
5. **Cost tracking.** Anthropic-path cost assumes Anthropic pricing. When a custom base URL is set, either accept best-effort cost or mirror the openai path's `*_PRICE_*_PER_M_USD` overrides. Decide during implementation; not a blocker for the core feature.

## Security considerations

- **Hosted gating (required).** This must be self-hosted only. Gate on `IS_HOSTED`: if `IS_HOSTED=true`, `ANTHROPIC_BASE_URL` is ignored or rejected at boot, so a misconfig cannot redirect the platform's AI traffic off Anthropic. Fail-closed.
- **Operator-chosen URL.** The base URL is an operator config value, not user input, so SSRF is out of scope, but the URL should still be validated as a syntactically valid `http(s)` URL at boot.
- **Guardrails intact.** Because this reuses the SDK path, RBAC / tool-tiering / rate-limits / cost tracking all continue to apply. No new bypass surface.

## Relationship to PR #859

The openai-compatible provider stays as the fallback for endpoints that only speak the OpenAI `/v1/chat/completions` dialect and cannot present an Anthropic `/v1/messages` surface. The base-URL route is the preferred path whenever the backend (vLLM 0.23+, LiteLLM) can speak the Anthropic dialect, because it is the only one that supports tool-use and guardrails.

## Testing

- Config validation: `ANTHROPIC_BASE_URL` accepted when valid, rejected when malformed; ignored/rejected under `IS_HOSTED=true`.
- Allowlist: subprocess env includes `ANTHROPIC_BASE_URL` when set.
- Manual: point at a local vLLM `/v1/messages` (or LiteLLM) and confirm a tool-using agent turn completes end to end with guardrails applied (Emilien verified the vLLM tool-calling round-trip already).

## Out of scope

- Per-org / per-session backend selection (this is a deployment-wide config).
- Changing the default hosted behavior.
- Cost-tracking accuracy for non-Anthropic pricing beyond an optional override.
