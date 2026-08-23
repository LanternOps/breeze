---
tracking_issue: LanternOps/breeze#3228
---

# Per-Partner LLM API Configuration (Hosted BYOK) — Design Spec

- **Date:** 2026-08-23
- **Issue:** #3228 (`track:spec`, decision comment 2026-08-16)
- **Related:** Discussion #505, PR #859 (openai-compatible chat-only PoC), #1412 (`ANTHROPIC_BASE_URL` self-host), #1326 (cost source fallback)
- **Status:** Draft for review
- **Advisor quorum:** Codex (gpt-5.6-sol, xhigh, read-only) independently reviewed the four consequential decisions on 2026-08-23 and **agreed on all four** (phase-1 Anthropic-only, dedicated table, fail-loud, record-but-don't-deduct); its refinements are folded in below.

## Summary

Hosted partners (MSPs) can register their **own Anthropic API key** so all AI features for their tenancy run on their key and their Anthropic bill instead of the platform key and Breeze AI credits. Phase 1 is deliberately **Anthropic-BYOK-only with the endpoint fixed to `api.anthropic.com`** — no per-partner base URLs on hosted. The data model and resolution seam are shaped so alternative providers/endpoints can be added later without a schema rewrite.

Self-hosted deployments are already covered by process-wide env (`ANTHROPIC_BASE_URL`, `MCP_LLM_PROVIDER=openai-compatible`); this spec adds a docs page to make that discoverable but changes none of it.

## Goals

1. A partner-scope admin can save/rotate/remove their own Anthropic API key, verified live at save time.
2. Every partner-attributable LLM call in the hosted product uses the partner's key when one is configured.
3. Breeze AI-credit billing is suppressed for BYOK partners (no double-billing), while usage/cost telemetry and org budget enforcement keep working.
4. The key is stored and handled to the same standard as the partner Stripe key (encrypted at rest, write-only, last4 display, audited).
5. Broken partner config **fails loud** — AI becomes unavailable for that partner with a clear operator-visible error. Never a silent fallback to the platform key.

## Non-goals (phase 1)

- **Per-partner base URLs / third-party or self-hosted endpoints on hosted.** `ANTHROPIC_BASE_URL` is refused on hosted by a deliberate, twice-enforced fail-closed guard (`apps/api/src/config/validate.ts:932-968`, `apps/api/src/services/streamingSessionManager.ts:115-129`, from #1412). Reversing that means SSRF/egress controls (public-IP-only DNS pinning, metadata-endpoint blocking, per-partner egress audit) plus tool-call-quality support burden on arbitrary backends. Deferred to a possible phase 2; the schema carries `provider` and `base_url` columns so it slots in.
- **OpenAI-compatible chat-only provider on hosted.** It is tool-less (rejects tool calls, `services/llm/openaiCompatibleProvider.ts:175-187`) and currently dead code behind an infinitely-recursive guard (`routes/ai.ts:61-66`) — a degraded product we don't want to sell to hosted partners. Stays self-host-only.
- **Per-org keys.** Ownership is partner-level, matching who pays and matching the Stripe/accounting/Huntress credential precedent. (This is a partner *credential*, not a config policy, so the Partner-Wide-First dual-ownership XOR pattern does not apply.)
- **BYOK for `ee/workspace` content enrichment.** The extension builds a boot-time Anthropic singleton from process env (`ee/workspace/src/index.ts:36-41`) behind the extension-SDK boundary. Threading a per-partner resolver through the extension host is real work for a peripheral feature; phase 1 keeps workspace enrichment on the platform key, **discloses the exception in the AI Provider UI** (not only engineering docs — it processes customer content), and files a follow-up to bring it into BYOK or disable it for BYOK partners.

## Current architecture (what the design must thread through)

There is **no unified LLM provider seam** today. Consumers:

| # | Surface | Client construction | Partner available? |
|---|---|---|---|
| 1 | Technician AI chat (`routes/ai.ts:611-629`) | Agent SDK `query()` subprocess per session; child env from `buildClaudeSdkChildEnv()` (`streamingSessionManager.ts:102-131`) reading `process.env` | Yes (`auth.partnerId`) |
| 2 | AI script builder (`routes/scriptAi.ts:195-214`) | same SDK path | Yes |
| 3 | AI for Office sessions (`routes/clientAi/sessions.ts:180`) | same SDK path | **No** — synthetic auth sets `partnerId: null` (`services/clientAiSessions.ts:168,172`); must resolve via `organizations.partnerId` |
| 4 | Breeze Helper agent (`routes/helper/index.ts:273-289`) | same SDK path | Yes |
| 5 | Ticket draft from chat (`services/aiTicketDraft.ts:61`) | raw `new Anthropic()` (env key) | via session org |
| 6 | Office add-in email draft (`services/officeAddin/aiEmailDraft.ts:86,108`) | raw `new Anthropic()` | Yes |
| 7 | Catalog enrichment ×2 (`services/catalogEnrichmentService.ts:188,603`) | raw `new Anthropic()` | partner-level actor |
| 8 | AI patch test runner (`services/aiPatchTestRunner.ts:95-99`) | raw `new Anthropic()`, hardcoded model, **no cost tracking** | needs plumbing |
| 9 | `ee/workspace` enrichment | boot singleton | out of scope (see non-goals) |

The MCP server (`routes/mcpServer.ts`) never calls an LLM (the external client brings its own model) — no change.

Cost/billing today: `aiCostTracker.ts` records org-keyed usage into `ai_cost_usage`, enforces org budgets (`checkBudget:208`, `getRemainingBudgetUsd:643` → SDK `maxBudgetUsd`), and **unconditionally** checks/deducts partner AI credits against the billing service (`checkBillingCredits:46-89`, `deductBillingCredits:91-116`, called at `:562`, `:636`).

## Design

### 1. Data model — `partner_llm_configs`

Modeled on `stripe_connect_accounts` / `services/partnerStripe.ts` (the canonical per-partner secret-key pattern). **Not** `partners.settings`: that jsonb is returned wholesale to the browser on every partner read (`routes/orgs.ts:337-374`).

```sql
CREATE TABLE IF NOT EXISTS partner_llm_configs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id      uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  provider        text NOT NULL DEFAULT 'anthropic',      -- extensible; phase 1 CHECK (provider = 'anthropic')
  api_key_encrypted text NOT NULL,                        -- secretCrypto v3, row-bound AAD
  key_last4       text NOT NULL,
  key_fingerprint text NOT NULL,                          -- HMAC(server secret, key) — cross-partner reuse detection, never a bare hash
  base_url        text,                                   -- always NULL in phase 1 (CHECK base_url IS NULL)
  default_model   text,                                   -- NULL = platform default
  status          text NOT NULL DEFAULT 'active',         -- active | error  (no 'disabled': switching back to platform = DELETE the row)
  config_version  integer NOT NULL DEFAULT 1,             -- bumped on every key/model write; see rotation semantics
  last_error      text,
  verified_at     timestamptz,
  connected_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS partner_llm_configs_partner_uq ON partner_llm_configs(partner_id);
```

Registration obligations (same migration / same PR):

- **RLS shape 3** (partner-axis): `breeze_has_partner_access(partner_id)` OR system, RLS enabled + forced in the creating migration. Add to `PARTNER_TENANT_TABLES` in `rls-coverage.integration.test.ts`.
- **encryptedColumnRegistry**: `partner_llm_configs.api_key_encrypted`, `kind: 'text'`, **row-bound AAD** (`aadBinding: 'row'`, the `tenant_variables` pattern) so a ciphertext cannot be replayed onto another partner's row; covered by `reencryptRegisteredSecrets`.
- **Envelope-prefix rejection**: refuse submitted plaintext beginning with the `enc:` ciphertext envelope prefix (the `tenantVariables.ts:64` guard) so a copy-pasted ciphertext can't be double-encrypted.
- **Cascade lists**: no `org_id`, no `device_id` → no org/device cascade or export-policy entries. Partner deletion is handled by the FK `ON DELETE CASCADE`.
- Phase-1 CHECKs (`provider = 'anthropic'`, `base_url IS NULL`) make the frozen scope enforceable at the DB, not just the route; phase 2 relaxes them in a new migration.

### 2. Resolution seam — `resolveLlmConfig`

New `apps/api/src/services/llm/llmConfigResolver.ts`:

```ts
type ResolvedLlmConfig =
  | { source: 'platform'; apiKey: string | undefined; model: string }
  | { source: 'partner'; partnerId: string; apiKey: string; model: string; configId: string; configVersion: number }
  | { source: 'unavailable'; partnerId: string; reason: 'key_error' };

async function resolveLlmConfig(partnerId: string | null): Promise<ResolvedLlmConfig>;
```

- `partnerId null` or no row → `platform` (today's behavior, `resolveDefaultModel()`).
- Row with `status='active'` → decrypt, return partner config. Decrypt failure → mark `status='error'` + return `unavailable`.
- Row with `status='error'` → `unavailable`. Callers turn `unavailable` into the Office-add-in-style `503 { error: 'ai_unavailable' }` (`routes/officeAddin/tickets.ts:306-308` is the pattern) **before** starting a stream/SDK subprocess — never a mid-turn SDK crash, never a fallback to the platform key.
- **No plaintext caching in phase 1.** Resolution happens per session-create / per one-shot call — a single-row indexed read plus AES decrypt, cheap at that granularity. A cache would extend plaintext secret lifetime and create cross-node invalidation problems; if one is ever added it must be process-local and invalidated synchronously on write, never Redis.
- Plaintext lives only in the resolved object and the SDK child env — never logged, never in error messages, never in responses. Raw Anthropic error bodies are not persisted into `last_error` (store a normalized reason code + HTTP status).

**Error semantics:** `status='error'` is reserved for *credential* failures — Anthropic 401/403 (`authentication_error`/`permission_error`) and local decrypt failure. Transient 429/5xx/network errors surface as retryable turn errors and do **not** flip status. Status writes are **version-conditional** (`WHERE config_version = $seen`) so a request still running on a just-rotated key can't mark the new key erroneous.

Why fail-loud: a silent fallback would (a) put a partner's traffic on platform spend without consent, (b) route customer data to a key/account the partner explicitly moved off of, and (c) hide the breakage from the operator. `status='error'` is surfaced in the partner UI and via a banner on the AI surfaces. Switching back to the platform key is an explicit admin action (DELETE), never automatic.

### 3. Threading into call sites

**Agent SDK path (call sites 1–4):** `buildClaudeSdkChildEnv()` gains a `resolved: ResolvedLlmConfig` parameter. For `source='partner'` it sets `ANTHROPIC_API_KEY` to the partner key and **scrubs every other credential variable the allowlist currently permits** — `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, and any future credential alternates — plus `ANTHROPIC_BASE_URL`, so neither platform credentials nor platform routing can leak into a partner-keyed subprocess. Audit `SDK_CHILD_ENV_ALLOWLIST` (`streamingSessionManager.ts:74-101`) as part of the change. Entry points resolve config **before session creation** (the client-ai path first resolves `partnerId` from `organizations` via the partner-axis read helper — no helper may accept a caller-supplied partner id) and pass it down. The SDK subprocess is already created per session (`streamingSessionManager.ts:644-666`), so no architectural change — but see key rotation below.

**One-shot sites (5–7):** new helper `getAnthropicClientForPartner(partnerId)` in the resolver module returns `{ client: Anthropic, resolved }` or throws a typed `LlmUnavailableError`. The ticket-draft, email-draft, and catalog-enrichment sites move onto it. `aiPatchTestRunner` (site 8) is **platform-owned tooling, not partner-attributable work — it stays on the platform key** (documented); it still gets its hardcoded model routed through `resolveDefaultModel()` as a drive-by fix.

**Key rotation / session interplay:** SDK sessions are long-lived (24h max, 2h idle) and `getOrCreate` reuses a running subprocess, so a rotated key would otherwise keep serving old sessions for hours. Each SDK session snapshots `{ source, configVersion }` at creation; **every turn's pre-flight re-reads the config row (cheap, single indexed read) and closes/recreates the session if source or version changed** — this also covers multi-node deployments without distributed invalidation. A config DELETE or key rotation therefore takes effect on the next turn, worst case.

**Model resolution:** one central supported-model registry (the `MODEL_PRICING` keys, `aiCostTracker.ts:21-31`) validates **every** model entry point, not just `default_model` — notably the public session-create validator (`packages/shared/src/validators/ai.ts:41`) currently accepts an arbitrary model string that is persisted to `ai_sessions.model` before the SDK session exists. While here, the stale hardcoded ids in `scriptBuilderService.ts:16` and `clientAiSessions.ts:19` (`claude-sonnet-4-5-20250929`) are routed through the resolver's model instead.

### 4. Cost tracking & billing

Principles: **track always, deduct never (for BYOK), enforce budgets unchanged.**

- `ai_cost_usage` gains `billing_source text NOT NULL DEFAULT 'platform'` (`'platform' | 'partner_key'`). It is a **stamp, not part of the aggregate identity** — the unique key stays `(org, period, periodKey)` so every existing `limit(1)` budget/summary reader keeps working; a mid-period switch simply relabels the current row (acceptable: the partner-facing meaning is "where is this billed *now*"). `ADD COLUMN` on an org-cascade table → **classify in `CORE_TENANT_EXPORT_POLICY`** (`included`) in the same PR.
- `ai_sessions` gains the same `billing_source` stamp for durable per-session provenance (UI/history: "this conversation ran on your key").
- `recordUsage` / `recordUsageFromSdkResult` / `recordOpenAIUsage` take the resolved source; when `'partner_key'` they skip `deductBillingCredits` (`aiCostTracker.ts:562,636`) and stamp `billing_source`.
- `checkBillingCredits` today conflates **plan entitlement** ("AI assistant requires the Community plan") with **credit availability** ("out of AI credits") — `aiCostTracker.ts:79-83`. Split it: plan/product entitlement is enforced for **everyone** (BYOK is not a plan-gate bypass); the credit check-and-deduct runs only for `source='platform'`. Org **budget** enforcement (`checkBudget`, `getRemainingBudgetUsd` → SDK `maxBudgetUsd`) is deliberately unchanged: budgets are the MSP's control over tech spend, and with BYOK they cap the partner's own Anthropic bill. Costs keep being computed from the pricing map (`total_cost_usd` fallback per #1326), so caps stay meaningful.
- Rate limits (`checkAiRateLimit`, per-user/per-org Redis buckets) unchanged — they protect platform infrastructure, not spend.
- `aiGuardrails` tool tiers/approvals unchanged and **must not** be bypassable by BYOK (no interaction by construction; noted for the test plan).
- Billing service: no contract change needed in phase 1 — the API simply stops calling the two credit endpoints for BYOK partners. A follow-up may want the billing service to *know* a partner is BYOK for plan display; out of scope here.

### 5. API surface

`apps/api/src/routes/aiProvider.ts` (mounted under `/api/v1/ai/provider`), mirroring `routes/stripeConnect/index.ts`:

| Method | Path | Gate | Behavior |
|---|---|---|---|
| GET | `/` | `BILLING_MANAGE` | `{ status, provider, keyLast4, defaultModel, verifiedAt, lastError }` — never the key |
| POST | `/key` | `BILLING_MANAGE` + `requireMfa()` | Save/replace key. **Atomic rotation:** live probe first (1-max-token `messages.create` against the platform default model); on probe failure the existing working key is retained untouched and a typed 400/409 is returned (per `savePartnerStripeKey`'s probe-then-store shape). On success: persist, bump `config_version`, reset `status='active'`. Audits `ai_provider.connected` (actor + last4 + version only). |
| PATCH | `/` | `BILLING_MANAGE` | Update `defaultModel` (validated against the model registry). Bumps `config_version`. Audits. |
| DELETE | `/` | `BILLING_MANAGE` + `requireMfa()` | Remove config → partner reverts to platform key + credits (the only way back to platform; never automatic). Audits `ai_provider.disconnected`. Takes effect on each session's next-turn version check. |

Gating rationale: BYOK changes *who pays* — semantically a billing action — and `BILLING_MANAGE` + MFA is exactly how the partner Stripe key is gated. Reusing it avoids the six-list cost of a new permission. All partner-scope only (`auth.partnerId` required); org-scoped tokens get 403.

### 6. Web UI

- New **"AI Provider"** tab on `PartnerSettingsPage` (pattern: `PartnerAiBudgetsTab.tsx`, hash `#ai-provider`): status card (Platform key / Your key ending in •1234 / Error banner with `lastError`), key paste + Save (write-only field), default model select, disconnect. All mutations via `runAction`.
- `AiUsagePage` shows a "Usage billed to your Anthropic key" note when the partner is BYOK (from `GET /ai/usage`, which gains the flag).
- AI chat surfaces show the existing error path when the API returns `ai_unavailable` — plus a partner-admin-only hint linking to the settings tab.

### 7. Security considerations

- **Key custody:** encrypted at rest (secretCrypto v3 + AAD, rotation-walkable via the registry); plaintext only in resolver + SDK child env; write-only API; last4 for display; MFA to write/remove; audit events on every mutation.
- **Child-env hygiene:** partner-keyed subprocess env must contain the partner key **only** — strip platform `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`; `ANTHROPIC_BASE_URL` remains impossible on hosted (unchanged #1412 guard). Unit-test the env builder for both sources.
- **No fallback** (fail-loud, §2) — also prevents a partner "testing" a bad key from silently consuming platform credits.
- **Abuse angle — stolen-key laundering:** Breeze must not become an anonymizing proxy for stolen Anthropic keys. A live probe proves a key *works*, not that the partner *owns* it. Mitigations: MFA on key write; audit trail with `connected_by`; live probe at save (a revoked key never persists); plan entitlement still enforced; existing per-user/per-org rate limits still apply; keys only usable through Breeze's tool-governed agent loop (no raw completion passthrough endpoint exists); store an **HMAC fingerprint** of the key (keyed by a server secret, never a bare hash) to detect the same key appearing across unrelated partners — surfaced as an ops alert, not a hard block. Accepted residual risk documented.
- **Tenancy:** partner-axis RLS on the table; resolver takes `partnerId` from `AuthContext` (or org→partner lookup for client-ai), never from request input.
- **Never returned to clients:** the config table is not folded into `partners.settings` or any wholesale-serialized object.

### 8. Self-host interplay & docs

- On self-host, per-partner BYOK works identically (a partner row overrides the instance env key). `ANTHROPIC_BASE_URL` / `MCP_LLM_*` remain instance-wide env and take effect only for `source='platform'` resolution. Precedence documented: **partner config > instance env**.
- New docs page (from Todd's #3228 comment): "Bringing your own LLM" — hosted BYOK steps + the self-host env-var matrix (`ANTHROPIC_BASE_URL`, `MCP_LLM_*`), which is currently undocumented (not in `.env.example` or compose files).

### 9. Bundled cleanups (small, same initiative)

1. Fix or remove the infinitely-recursive `isOpenAICompatibleProvider()` (`routes/ai.ts:61-66`) — today it burns ~10k stack frames per call and permanently disables the openai path it guards.
2. `aiPatchTestRunner`: route the hardcoded model through `resolveDefaultModel()` and add the missing `recordUsage` (it is platform-owned and stays on the platform key — see §3).
3. Note-and-defer: `client_ai_org_policies.allowed_providers` is editable but enforced nowhere (`db/schema/clientAi.ts:49`); with a real provider setting landing at partner level, either enforce or drop it — tracked as a follow-up issue, not in these PRs.

## Phasing (single feature, ~4 PRs)

| Wave | Contents |
|---|---|
| 1 | Migration + schema + RLS + registries; `llmConfigResolver` + `getAnthropicClientForPartner`; `routes/aiProvider.ts`; RLS integration suite (`partnerLlmConfigsPartnerRls.integration.test.ts`: cross-partner forge 42501, org-token 403, system path) |
| 2 | Thread SDK path (child env, 4 entry points incl. client-ai partner lookup, session-close-on-rotate) + one-shot sites; fail-loud `503` preflight; cleanups #1–2 |
| 3 | Cost/billing: `billing_source` column + export-policy entry, deduct/credit suppression, `GET /ai/usage` flag; integration test proving a BYOK partner's turn records usage but produces zero billing-service calls |
| 4 | Web UI tab + usage indicator; docs page; release-notes entry |

Track via `feature-lifecycle` (parent + 4 wave sub-issues) once the spec is approved.

## Test plan (contract-level)

- RLS: new partner-axis suite; `PARTNER_TENANT_TABLES` entry keeps `rls-coverage` green.
- Export policy: `billing_source` classified; roundtrip suite green.
- Resolver: platform/partner/unavailable branches; decrypt-failure → `status='error'`; 429/5xx does NOT flip status; status write is version-conditional (stale version → no-op).
- Rotation: session snapshots `{source, configVersion}`; next-turn pre-flight closes/recreates on version or source change; failed probe on POST `/key` leaves the old working key untouched.
- Child env builder: partner source scrubs ALL platform credential vars (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`) and `ANTHROPIC_BASE_URL`; platform source unchanged; base-URL hosted guard untouched.
- Billing: BYOK turn → usage recorded with `billing_source='partner_key'`, zero credit check/deduct calls, plan entitlement still enforced; non-BYOK unchanged.
- Route: MFA required on write/delete; key never in any response body; probe failure → typed 4xx, nothing persisted; `enc:` envelope-prefix plaintext rejected; model ids validated against the registry at every entry point (session-create validator included).
- E2E (worktree stack): save key → chat works on partner key (assert via outbound auth header in a stub) → break key → chat 503s with banner → delete → platform path restored.

## Open questions for Todd

1. **Entitlement:** may every hosted partner BYOK, or is it plan-gated (e.g. paid plans only)? Spec assumes ungated; billing-side plan display is a follow-up either way.
2. **Budget default for BYOK partners:** keep org budget defaults as-is (spec's assumption), or default budgets off when the partner pays Anthropic directly?
3. **Phase 2 appetite:** should the follow-up issue for hosted third-party endpoints (OpenRouter/LiteLLM/vLLM behind egress controls) be filed now as `status:considering`, or wait for demand?
