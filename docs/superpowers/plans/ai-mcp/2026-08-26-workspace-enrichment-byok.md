---
tracking_issue: LanternOps/breeze#3917
---

# Workspace Enrichment Honors Partner BYOK — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ee/workspace` content enrichment runs on the partner's BYOK key when one is configured (and gets the cost tracking it has never had), replacing the phase-1 "always platform key, disclosed exception" carve-out from #3228.

**Architecture:** The extension host gains an optional **metered AI invocation capability** on `ExtensionRuntimeContext` (`context.ai.invoke(...)`). The host-side implementation (in `apps/api`, which already depends on `@breeze/ext-workspace` — no circular import) performs resolution via `resolveLlmConfigForOrg`, rate-limit + budget checks, the Anthropic call, and **awaited** usage recording with the correct `billing_source`, then returns only the text. The API key never crosses the extension boundary, and accounting cannot be skipped by construction. `ee/workspace` drops its boot-time `new Anthropic()` singleton and threads `invoke` through `enrichmentService`. Fail-loud: a partner whose BYOK config is broken gets a visible enrichment failure, never a silent fallback to the platform key.

**Tech Stack:** TypeScript; `packages/extension-sdk` (interface types only — no new deps), `apps/api` (`stageExtension.ts`, `llmConfigResolver`, `aiCostTracker`), `ee/workspace` (enrichmentService, ingestJobRunner, content routes), web locale strings.

**Advisor quorum (2026-08-26, codex gpt-5.6-sol xhigh):** agreed on host-injected capability over disable-for-BYOK, and on an optional structural member being backward-compatible. Folded in per its review: a single metered `invoke` (not separate `getClient` + `recordUsage`, which makes accounting optional); the input carries the acting principal + surface; typed unavailable/budget errors must bypass `classifyOne`'s per-file fail-soft catch and abort the run; workspace reports enrichment unavailable when `context.ai` is absent.

**Scope:** single PR. No feature-lifecycle registration needed.

## Global Constraints

- **Fail loud, never fall back to the platform key** (phase-1 BYOK invariant): `resolveLlmConfigForOrg` → `unavailable` must surface as a visible enrichment failure for that org, not platform-key traffic and not a silently skipped batch.
- **The extension never sees the API key.** Only `invoke()` crosses the boundary; the client object and plaintext key stay in `apps/api`.
- **`extension-sdk` stays dependency-light**: interface types only (the `AnthropicLike` precedent — structural types, no `@anthropic-ai/sdk` import).
- **Model policy:** enrichment keeps its own cheap default (`claude-haiku-4-5`, overridable via `WORKSPACE_CONTENT_LLM_MODEL`); it does **not** inherit the partner's `default_model` pin (a partner pinned to Opus would silently multiply their bulk-enrichment bill). The model must exist in `MODEL_PRICING`.
- **Budget overshoot bound:** `invoke` checks budget per call; with enrichment batches capped by the existing batch budget, overshoot is bounded by (batch size × one haiku call) — accepted, no atomic reservation (YAGNI; noted from quorum risk 2).
- Tests colocated; scoped runs via `cd <pkg> && npx vitest run <path>`. `ee/workspace` integration tests run in the Integration Tests CI job — verify the new test file actually RAN in the shard log.

---

### Task 1: `ai` capability types in the extension SDK

**Files:**
- Modify: `packages/extension-sdk/src/server.ts` (ExtensionRuntimeContext, ~line 22-44)
- Test: colocated test file next to `server.ts` if the package has one for types/contracts; otherwise type-only changes are covered by Task 2's tests

**Interfaces (produces — every later task consumes these exact names):**

```ts
/** Outcome codes an extension can branch on. Anything else is an unexpected error. */
export type ExtensionAiErrorCode = 'ai_unavailable' | 'budget_exceeded' | 'rate_limited';

export class ExtensionAiError extends Error {
  constructor(public readonly code: ExtensionAiErrorCode, message: string) { super(message); this.name = 'ExtensionAiError'; }
}

export interface ExtensionAiInvokeInput {
  orgId: string;
  /** Stable surface tag for audit/cost attribution, e.g. 'workspace_enrichment'. */
  surface: string;
  /** Acting principal, for rate limiting + audit. 'system' for host-triggered runs. */
  principal: { type: 'user' | 'agent' | 'system'; id: string | null };
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxTokens: number;
  /** Optional model override; must be a platform-priced model id. Host default applies when omitted. */
  model?: string;
}

export interface ExtensionAiInvokeResult {
  text: string;                                  // concatenated text blocks of the response
  model: string;
  billingSource: 'platform' | 'partner_key';
  usage: { inputTokens: number; outputTokens: number };
}

export interface ExtensionAiContext {
  /**
   * Metered LLM call: the host resolves the org's provider (partner BYOK or
   * platform), enforces rate limits and org budget, performs the call, and
   * records usage BEFORE resolving. Throws ExtensionAiError for expected
   * failure modes; never falls back across billing sources.
   */
  invoke(input: ExtensionAiInvokeInput): Promise<ExtensionAiInvokeResult>;
}

// On ExtensionRuntimeContext (optional — older hosts may not provide it):
//   ai?: ExtensionAiContext;
```

- [ ] **Step 1:** Add the types + optional `ai?: ExtensionAiContext` member; export `ExtensionAiError` from the package's public entry (check `packages/extension-sdk/src/index.ts` / `package.json` exports and follow how `ExtensionRuntimeContext` itself is exported).
- [ ] **Step 2:** `pnpm --filter @breeze/extension-sdk build` (or the package's check script) — clean. Bump the package's minor version if the workspace versions it (check `package.json`; workspace-protocol deps may make this a no-op — mirror whatever the last SDK surface addition did, `git log -- packages/extension-sdk/package.json`).
- [ ] **Step 3:** Commit `feat(extension-sdk): optional metered ai invocation capability`.

### Task 2: Host implementation in apps/api

**Files:**
- Create: `apps/api/src/services/extensionAi.ts`
- Modify: `apps/api/src/extensions/stageExtension.ts` (inject `ai` into the runtime context it builds, ~lines 68-104)
- Test: `apps/api/src/services/extensionAi.test.ts`

**Interfaces:**
- Consumes: `resolveLlmConfigForOrg`, `getAnthropicClientForPartner` (`services/llm/llmConfigResolver.ts`), `checkAiRateLimit`, `checkBudget`, `recordUsage`, `getLlmBillingSourceForOrg` (`services/aiCostTracker.ts` / resolver), `resolveDefaultModel` (`services/aiModel.ts`), `MODEL_PRICING` keys.
- Produces: `buildExtensionAiContext(): ExtensionAiContext`.

Implementation contract (mirror `catalogEnrichmentService.ts:188-256` — it is the canonical one-shot site that already does resolve → rate-limit → budget → call → record; copy its exact call shapes rather than inventing new ones):

```ts
// apps/api/src/services/extensionAi.ts
import { ExtensionAiError, type ExtensionAiContext, type ExtensionAiInvokeInput } from '@breeze/extension-sdk';

const EXTENSION_AI_DEFAULT_MODEL = 'claude-haiku-4-5';

export function buildExtensionAiContext(): ExtensionAiContext {
  return {
    async invoke(input: ExtensionAiInvokeInput) {
      const model = input.model ?? process.env.WORKSPACE_CONTENT_LLM_MODEL ?? EXTENSION_AI_DEFAULT_MODEL;
      if (!(model in MODEL_PRICING)) throw new ExtensionAiError('ai_unavailable', `Unpriced model: ${model}`);

      // 1. Resolve (org → partner → BYOK|platform). LlmUnavailableError → 'ai_unavailable'.
      //    Deliberately NOT the partner's default_model — see plan Global Constraints.
      // 2. Rate limit: checkAiRateLimit keyed the same way catalogEnrichmentService keys its
      //    partner-level actor calls; principal.id threads through when type==='user'.
      //    Limited → ExtensionAiError('rate_limited', ...).
      // 3. Budget: checkBudget(orgId) → exceeded → ExtensionAiError('budget_exceeded', ...).
      // 4. client.messages.create({ model, max_tokens, system, messages }) via
      //    getAnthropicClientForPartner (which already pins baseURL + authToken:null for
      //    partner keys). Anthropic 401/403 → markPartnerLlmError semantics are ALREADY
      //    inside the resolver/one-shot path — do not duplicate; rethrow as 'ai_unavailable'.
      // 5. AWAIT recordUsage(orgId, ..., billingSource) BEFORE returning — mirror
      //    catalogEnrichmentService's argument shape exactly (usage tokens from the response).
      // 6. Return { text, model, billingSource, usage }.
    },
  };
}
```

(The comment-numbered body above is the specification; the implementer writes the real code by opening `catalogEnrichmentService.ts:188-256` and transplanting its sequence — every function named exists today with those names.)

In `stageExtension.ts`, add `ai: buildExtensionAiContext(),` to the runtime context object literal (same place `secrets`/`audit` are built).

- [ ] **Step 1:** Failing unit tests (mock resolver + cost tracker): BYOK org → `billingSource:'partner_key'`, `recordUsage` awaited with `'partner_key'` (assert call order: recordUsage resolves before invoke resolves); platform org → `'platform'`; resolver `unavailable` → `ExtensionAiError('ai_unavailable')` and **zero** client calls; budget exceeded → `'budget_exceeded'`, zero client calls; rate limited → `'rate_limited'`; unpriced model → `'ai_unavailable'`; response with multiple text blocks concatenated.
- [ ] **Step 2:** Implement → green (`cd apps/api && npx vitest run src/services/extensionAi.test.ts`).
- [ ] **Step 3:** Commit `feat(api): host-side metered ai capability for extensions`.

### Task 3: Thread `invoke` through workspace enrichment

**Files:**
- Modify: `ee/workspace/src/hostTypes.ts` (narrowing seam), `ee/workspace/src/index.ts` (drop the singleton, ~lines 30-42 and 77, 85-87), `ee/workspace/src/services/enrichmentService.ts`
- Test: `ee/workspace/src/services/enrichmentService.test.ts` (rewrite the client fakes as invoke fakes)

Changes:
1. `hostTypes.ts`: re-export the SDK types (`export type { ExtensionAiContext, ExtensionAiInvokeResult } from '@breeze/extension-sdk'; export { ExtensionAiError } from '@breeze/extension-sdk';`) — the documented single seam.
2. `enrichmentService.ts`: replace `AnthropicLike`/`EnrichmentDeps.client` with

```ts
export type EnrichmentInvoke = (input: {
  orgId: string; surface: 'workspace_enrichment';
  principal: { type: 'system'; id: null };
  system: string; messages: Array<{ role: 'user'; content: string }>;
  maxTokens: number;
}) => Promise<{ text: string }>;

export interface EnrichmentDeps { invoke: EnrichmentInvoke; }
```

   `classifyOne` calls `deps.invoke({ orgId, surface:'workspace_enrichment', principal:{type:'system',id:null}, system: SYSTEM_PROMPT, messages:[{role:'user',content:prompt}], maxTokens:1024 })` and parses `result.text` exactly as it parses the current `content` text block. **The per-file fail-soft catch must rethrow `ExtensionAiError`** (all three codes) so a broken BYOK config or exhausted budget aborts the run instead of marking every file errored:

```ts
} catch (e) {
  if (e instanceof ExtensionAiError) throw e;   // provider/budget problems abort the run — never per-file noise
  // existing per-file error handling unchanged
}
```

   `run(orgId, batch)` propagates it (no new catch). Since `orgId` is now needed inside `classifyOne`, pass it through from `run` (it already receives `orgId`).
3. `index.ts`: `buildEnrichmentService(db, ai)` takes `context.ai`; returns `undefined` when `context.ai` is undefined (older host) — same no-op/503 handling as the missing-env-key case today, with the log line updated to name the missing capability. Delete the `new Anthropic()` construction and, if now-unused, the `@anthropic-ai/sdk` import in `index.ts` (keep the dependency only if other code uses it — `grep -rn "@anthropic-ai/sdk" ee/workspace/src` and drop it from `ee/workspace/package.json` if the only non-test hit was this file).
4. `ingestJobRunner.ts` (no code change expected — verify): an `ExtensionAiError` escaping `enrichment.run` must land in the existing catch at `ingestJobRunner.ts:185` and take the **transient** branch (back-off with a visible `transient_error` release carrying the message, not a fatal job failure — the partner can fix their key and the job resumes). Today `isTransientIngestError` won't match `ExtensionAiError`. Add the mapping **in enrichmentService.run**, not the runner: wrap the invoke-loop so `ExtensionAiError` is rethrown as the workspace's `TransientIngestError` (import it from where the runner's `isTransientIngestError` expects — find via `grep -rn 'TransientIngestError' ee/workspace/src`) with message `AI provider unavailable for this organization: <code>`. Admin route `POST /content/enrich-run` (`content.ts:134-178`): let the error map to the route's existing error path with a 503 + the code in the body (follow the route's current error-shape).

- [ ] **Step 1:** Rewrite failing tests first: fake `invoke` returning canned JSON replies (replacing `fakeClient`); new cases — `invoke` throwing `ExtensionAiError('ai_unavailable')` aborts the run as `TransientIngestError` with zero files marked errored; a plain `Error` from `invoke` still takes the per-file fail-soft path (regression); parse behavior over `text` identical to the old content-block path (reuse existing fixtures).
- [ ] **Step 2:** Implement → green (`cd ee/workspace && npx vitest run src/services/enrichmentService.test.ts`), plus the runner's existing tests stay green.
- [ ] **Step 3:** Commit `feat(workspace): enrichment via host ai capability (BYOK-honoring, cost-tracked)`.

### Task 4: Integration test — BYOK partner's enrichment records partner_key usage

**Files:**
- Create: `apps/api/src/__tests__/integration/workspaceEnrichmentByok.integration.test.ts` (this directory, NOT ee/workspace — integration shards discover here; the placement trap has zeroed CI runs before)

Real Postgres. Seed: partner A with an active `partner_llm_configs` row (encrypt a dummy key via the same helper the phase-1 RLS suite uses — copy from `partnerLlmConfigsPartnerRls.integration.test.ts`), org under A, workspace org settings enabled, one `workspace_file_content` row in `extracted` status. Stub the Anthropic client at the resolver boundary (the suite-level pattern used by existing AI integration tests — find via `grep -rln 'getAnthropicClientForPartner' apps/api/src/__tests__/`; if none stubs it, stub `Anthropic.prototype.messages.create`). Assertions:
- enrichment run completes; `ai_cost_usage` row for the org has `billing_source = 'partner_key'`;
- zero calls to the billing-credit deduction path (spy);
- flip the config row to `status='error'` → run again → the run fails visibly (transient release / 503) and **no** usage row with `billing_source='platform'` appears (the fallback-forbidden assertion).

- [ ] **Step 1:** Write, run locally against the integration DB, confirm it RAN and passed.
- [ ] **Step 2:** Commit `test(api): workspace enrichment BYOK integration proof`.

### Task 5: UI disclosure + docs

**Files:**
- Modify: `apps/web/src/locales/en/settings.json:162` (`workspaceDisclosure`) + every other locale's same key (parity check), `apps/web/src/components/settings/PartnerAiProviderTab.tsx:306-309`

Replace the static exception text with the new truth: "Workspace content enrichment uses your configured AI provider and appears in your AI usage." (key rename to `workspaceEnrichmentNote` optional — if renamed, sweep all locales in the same commit). Update the "Bringing your own LLM" docs page section that documents the workspace exception (`update-breeze-docs` skill).

- [ ] **Step 1:** Implement + locale parity green (`cd apps/web && npx vitest run` scoped to the i18n parity test — find its path via `grep -rln 'parity' apps/web/src`).
- [ ] **Step 2:** Commit `feat(web,docs): retire the workspace platform-key disclosure`, open the PR (`Closes #3917`), one review round (code-reviewer + silent-failure-hunter lenses — the fail-soft-catch change is exactly their territory).

## Self-review notes

- Issue options: implements option 1 (capability), plus the issue's explicit requirement that usage lands with correct `billing_source` (Tasks 2/4). Option 2 (disable-for-BYOK) becomes unnecessary; the fail-loud path covers the "no partner traffic on the platform key without consent" concern.
- Key never crosses the extension boundary; accounting is structurally mandatory (single metered invoke — quorum P9).
- Backward compatibility: `ai` optional; workspace degrades to "enrichment unavailable" exactly like the missing-key case today (quorum P10).
- Type consistency: `ExtensionAiContext`/`ExtensionAiInvokeInput`/`ExtensionAiError` defined once in Task 1 and imported by name in Tasks 2–3; `EnrichmentInvoke` is workspace-local and structurally compatible with `invoke`.
