---
title: AI model registry — discovered models, admin enablement, per-chat model + effort, BYO providers
status: draft v3 (Codex xhigh quorum §16 + extension hooks: refusals, chargeback, residency, options, roles/failover, permission/plan gates, cloud connections, prompt profiles, quality view; decisions §15 approved 2026-09-30)
date: 2026-09-30
issues: "#7570 (multiple models/providers), #7120 (BYO OpenAI-compatible), #6772 (tool calling on OpenAI-compatible), #7587 (interim — W0)"
---

# AI model registry

## 1. Problem

Breeze hard-codes every Claude model it knows about, in roughly eight places that have already drifted apart:

| Where | What |
|---|---|
| `services/aiModel.ts` | Platform default `claude-sonnet-4-6` |
| `services/aiCostTracker.ts` | `MODEL_PRICING`, `OFFERABLE_AI_MODELS` (4 ids) |
| `web/components/admin/LlmProviderCatalog.tsx` | A second copy of the offerable list |
| `web/components/clientAi/PolicyEditor.tsx` | Dated Sonnet 4.5 / Haiku 4.5 ids that match nothing else |
| `db/schema/ai.ts` | `ai_sessions.model` and `ai_budgets.allowed_models` defaults, both `claude-sonnet-4-5-20250929` |
| `services/extensionAi.ts`, `ee/workspace/.../enrichmentService.ts` | `claude-haiku-4-5` |
| Four call sites | `thinking: { type: 'disabled' }`, which current models reject with a 400 |
| Environment | `ANTHROPIC_MODEL`, `MCP_LLM_MODEL`, `WORKSPACE_CONTENT_LLM_MODEL`, `BREEZE_AI_SCRIPT_REVIEWER_MODEL` |

The consequences:
- A new Anthropic model needs a release.
- Chat runs Sonnet 4.6 with no reasoning step.
- A partner can pick exactly one model for everything.
- Techs can't reach for a stronger model when a problem is hard.
- BYO providers are env-only (self-host) and chat-only (no tools).
- Customers keep asking for per-task models (#7570: cheap triage → analysis → remediation) and BYO endpoints (#7120).

## 2. Goals

1. **One registry** of the models a partner can use: id, display name, connection, capabilities, price, enabled state. Every model list, price lookup and thinking decision in the code reads from it.
2. **Discovery.** Learn Anthropic models from the Models API (`GET /v1/models`) for the platform key and for BYOK keys. Discover BYO providers through their `/models` endpoint, or enter them by hand.
3. **Admin enablement.** A partner admin chooses which models techs may use, and the default model and effort for each AI surface. An org can narrow or override those choices, never widen them.
4. **Direct exposure.** Chat shows real model names and the options that model supports.
5. **Capability-driven requests.** Thinking and effort parameters are derived from verified capabilities, never from a list of names.
6. **One source of cost truth.** Every model call is priced from one resolved rate snapshot and written to one invocation ledger, carrying the funding source it actually used.
7. **Refusals are visible.** Safety-classifier refusals are recorded and surfaced, with an optional explicit fallback model. Sonnet 5.5 / Opus 5.5 refuse in a `cyber` category, and RMM work (malware triage, suspicious scripts, persistence checks) will hit it.
8. **Chargeback-ready.** The ledger carries user, org, surface and model, so MSPs can show AI usage per client and later invoice it through Breeze billing.
9. **Data residency.** Connections carry an inference geography, and a partner can require it (the EU deployment).
10. **Extensible without migrations.** The schema already has slots for model options (effort, thinking display, speed), per-surface roles (escalation), ordered fallbacks (failover), and per-model permission / plan gates. Later waves fill them in.

### Non-goals (v1 runtime; schema hooks exist, behaviour lands in later waves)
- Automatic multi-provider failover (W09; columns in §5.4).
- Escalation chains inside one agent run (W09; `role` in §5.4).
- Invoicing AI usage to client orgs (W10; ledger fields in §5.5).
- Embeddings and images.

## 3. Current state to build on (origin/main c1c8fee46f)

- **`partner_llm_configs`** (partner axis, one row per partner):
  - encrypted BYOK Anthropic key. The AAD is **row-bound** (`encryptedColumnRegistry.ts:128`, `aadBinding: 'row'`);
  - `default_model`, validated against `OFFERABLE_AI_MODELS`;
  - optional `catalog_entry_id`.

  Every save is probed live.
- **Platform provider catalog** (`llm_provider_catalog` + revisions + verifications). It is system-wide with **no RLS**, and its writes are gated to platform-admin + MFA at the route layer (`2026-09-12-llm-provider-catalog.sql`, `SYSTEM_TABLES` allowlist in `rls-coverage`).
  - Each **immutable revision** binds `base_url`, `model_map` (logical id → `{providerModel, pricing}`) and the per-model verification at the current `FIDELITY_HARNESS_VERSION` into one snapshot (`llmConfigResolver.ts:232`).
  - This is already a small registry, but it is limited to curated endpoints and keyed by the hard-coded list.
- **Resolver.** `resolveLlmConfig(partnerId)` → platform | partner (anthropic | catalog); `resolveWireModel()`.
- **Funding source is inferred per org.** `getLlmBillingSourceForOrg` returns `partner_key` whenever a partner config exists (`llmConfigResolver.ts:421`). Agent admission and reviewer reservations use it.
- **Cost prefers the SDK's self-reported `total_cost_usd`.** It falls back to `MODEL_PRICING` only when the SDK reports 0 (`aiCostTracker.ts:1008`). The Office path uses SDK cost directly, including 0 (`streamingSessionManager.ts:1916`).
- **AI agents** run with `persistSession: false` and account without a session (`aiAgents/runLoop.ts:2235`). They send the logical model with no `resolveWireModel` call. The org model override is admitted only if it is in `ai_budgets.allowed_models`, a tighten-only merge that fails closed (`effectivePolicy.ts:212`).
- **OpenAI-compatible provider**: env-only, deployment-wide, chat-only.
- **Patch test runner** calls `new Anthropic()` + `resolveDefaultModel()`, bypassing BYOK.

## 4. Concepts

- **Connection.** How models are reached. It fixes the **destination**, the **funding source** and the **inference geography**.
  - `platform` is implicit: the deployment's key, funded by platform credits on hosted.
  - `anthropic_byok`, `catalog` and `openai_compatible` are rows, funded by the partner's key. `bedrock`, `vertex` and `foundry` connections (Claude on the MSP's own AWS / GCP / Azure commitment) are W07; `kind` is a CHECK'd text column, so adding them needs no table change.
- **Options.** One typed set of per-call knobs, `OfferingOptions` (shared zod schema):
  - `effort`;
  - `thinkingDisplay` (`omitted` | `summarized` | `updates`);
  - `speed` (`standard` | `fast`).

  A model supports only some of these, and an option variant can carry its own rate (fast mode). New knobs extend the schema, not the table.
- **Role.** A sub-slot of a surface: `default` for every surface. `triage` / `analysis` / `remediation` for `ai_agents` (W09 escalation).
- **Offering.** A model a partner can use through one connection. It carries enabled state and defaults.
- **Surface.** A feature that calls a model: `chat`, `helper`, `script_builder`, `script_reviewer`, `office_chat`, `office_ticket`, `ai_agents`, `catalog_enrichment`, `extension_content`, `patch_test`. Ticket draft and topology inherit their chat session's offering.
- **Assignment.** For one surface: the default offering and effort, the **permitted** offerings, and whether users may choose among them. It is set at partner level, and an org may override it tighten-only.

## 5. Data model

All new tables ship with their RLS in the same migration. **Every cross-table reference that crosses the tenant boundary is enforced by a composite FK, not just an app check** (quorum #1). Shapes follow CLAUDE.md.

### 5.1 `ai_platform_models` — system-wide (precedent: `llm_provider_catalog`)
It has no tenant column and **no RLS**. It goes in the `rls-coverage` system-table allowlist with the same comment. Writes are gated to the discovery worker and platform-admin + MFA routes.

| column | notes |
|---|---|
| `id` uuid pk | |
| `provider` | `anthropic` (v1) |
| `model_id` text unique | Wire id exactly as the Models API returns it |
| `display_name`, `max_input_tokens`, `max_output_tokens` | From the API |
| `capabilities` jsonb | Raw Models API `capabilities` tree, stored verbatim |
| `input/output/cache_read/cache_write_cents_per_m` numeric NULL | Operator price (§8). NULL = unpriced |
| `option_rates` jsonb NULL | Rates for non-standard option variants, e.g. `{"speed:fast": {input, output, cache_read, cache_write}}`, validated by the shared schema. **A variant with no rate can't be selected** |
| `option_support` jsonb | Derived plus operator-set support for options the Models API doesn't expose: `speed.fast`, `thinkingDisplay.updates`, `inferenceGeo` values. The operator confirms them on `/admin/ai-models` |
| `min_plan` text NULL | Hosted plan gate (compared with `partners.plan`). NULL = all plans |
| `prompt_profile` text | Model family used to pick prompt variants (`claude-frontier`, `claude-standard`, `claude-small`, `generic`). Derived from the id family; the operator can override it |
| `platform_offered` bool default false | CHECK: may be true only when all four prices are non-NULL |
| `is_platform_default` bool | At most one row, via a partial unique index |
| `lifecycle` | `available` \| `missing` \| `retired` |
| `first_seen_at`, `last_seen_at`, `updated_at` | |

It is seeded by migration from today's `MODEL_PRICING` rows (priced, `platform_offered` for the current ids), so a fresh self-host works before its first sync.

### 5.2 `partner_ai_connections` — shape 3 (partner axis)
It generalizes `partner_llm_configs`. Columns:
- `id`, `partner_id`, `kind` (`anthropic_byok` | `catalog` | `openai_compatible`; W07 adds `bedrock` | `vertex` | `foundry`), `name`;
- `inference_geo` text NULL. Sent as Anthropic's top-level `inference_geo` where the model supports it; for W07 cloud kinds it is the provider region. NULL = provider default;
- `provider_config` jsonb NULL. Non-secret per-kind settings (region, project id, resource name) for W07 kinds. Export: `excludedOpen`;
- `api_key_encrypted`, `key_last4`, `key_fingerprint`;
- `catalog_entry_id`, `base_url` (openai_compatible only);
- `status`, `last_error`, `verified_at`, `config_version`, `connected_by`;
- `last_discovered_at`, `discovery_error`.

Constraints:
- `UNIQUE (id, partner_id)`, the target for the composite FKs.

**Ciphertext migration** (quorum #13):
- Each `partner_llm_configs` row becomes a connection with the **same `id`**.
- The new column is registered with `aadTag: 'partner_llm_configs.api_key_encrypted'` and `aadBinding: 'row'`, so existing ciphertext decrypts unchanged.
- The rotation walker (`reencryptSecrets`) is updated to walk the new table.
- A test decrypts a pre-migration ciphertext after cutover.

### 5.3 `partner_ai_models` — shape 3, the offerings

| column | notes |
|---|---|
| `id`, `partner_id` | `UNIQUE (id, partner_id)` |
| `connection_id` NULL | NULL = platform connection. **Composite FK `(connection_id, partner_id) → partner_ai_connections(id, partner_id)` ON DELETE CASCADE**, so an offering can't point at another partner's connection |
| `platform_model_id` NULL | FK `ai_platform_models` |
| `model_id` text NULL | Wire / logical id on a non-platform connection |
| `source` | `platform` \| `discovered` \| `manual` \| `catalog` |
| `display_name` NULL | Admin override |
| `capabilities` jsonb NULL | BYO and manual only (§7) |
| `price_*_cents_per_m` NULL | Non-platform only (§8) |
| `enabled` bool default false | Discoveries arrive disabled |
| `default_options`, `allowed_options` jsonb NULL | `OfferingOptions` default and allow-list (effort levels, speeds, thinking displays). A write whose intersection with the model's support is empty is rejected. Export: `excludedOpen` |
| `required_permission` text NULL | A permission key the **user** must hold to use this offering, e.g. a seeded `ai_models:premium` granted to senior techs. Checked by the resolver for user-initiated calls. NULL = anyone allowed by the assignment |
| `refusal_fallback_offering_id` uuid NULL | Explicit fallback when the model refuses. **Composite FK to an offering of the same partner**, validated eligible **and on the same connection** (same destination and funding). On the Claude API it is sent as server-side `fallbacks: [{model}]` (array form). Elsewhere, client-side via the SDK middleware. The `fallbacks: "default"` auto-routing form is **not** used, because it could serve a model we can't price |
| `lifecycle` | `available` \| `missing` \| `retired` |

CHECKs (quorum #2):
- **platform offering** ⇔ `connection_id IS NULL AND source='platform' AND platform_model_id IS NOT NULL AND model_id IS NULL AND capabilities IS NULL AND price_* IS NULL`. Wire identity, capabilities and price are **always read from the platform row**; they are never copied.
- **catalog offering** ⇔ `source='catalog'`, with `model_id` = the logical id. Endpoint, providerModel, price and verification are **resolved live from the connection's current authorized catalog revision** each call. Nothing is copied from the revision, so delisting or revocation takes effect immediately (quorum #7).
- **BYOK Anthropic** rows may link `platform_model_id`, for capability inheritance only. Price precedence is in §8.

Uniqueness:
- `(partner_id, platform_model_id) WHERE connection_id IS NULL`
- `(connection_id, model_id) WHERE connection_id IS NOT NULL`

**Org-token read path** (quorum #12): the chat picker runs under org tokens, which can't read partner-axis rows. Add a **separate SELECT-only policy**, `USING (enabled AND partner_id = public.breeze_current_partner_id())`, mirroring the partner-wide SELECT branch pattern. It is never appended to the FOR ALL policy. Connections get **no** org-token read path.

### 5.4 `ai_model_assignments` — partner-wide first (org_id XOR partner_id)

| column | notes |
|---|---|
| `id`, `org_id` NULL, `partner_id` NULL | `_one_owner_chk` |
| `offering_partner_id` NOT NULL | The partner that owns the referenced offerings. Denormalized for enforcement |
| `surface` | CHECK against §4 |
| `role` text NOT NULL default `'default'` | CHECK per surface (§4). v1 resolves only `default`; W09 escalation reads the agent roles |
| `default_offering_id` NULL | **Composite FK `(default_offering_id, offering_partner_id) → partner_ai_models(id, partner_id)`**. NULL on an org row = inherit |
| `options` jsonb NULL | `OfferingOptions` for this surface (e.g. effort `low` for catalog enrichment). NULL = inherit |
| `fallback_offering_ids` uuid[] NULL | **Ordered failover list (W09)**. Same ownership trigger as `permitted_offering_ids`. Stored and validated in v1 but **not acted on until W09** |
| `fallback_may_cross_funding` bool default false | W09. Failover may move from the platform key to a partner key (or back) only when this is explicitly true |
| `permitted_offering_ids` uuid[] NULL | NULL = all enabled offerings (partner row) or inherit (org row). A trigger asserts every id belongs to `offering_partner_id` (arrays can't carry FKs). The resolver re-filters to enabled rows at use |
| `allow_user_choice` bool NULL | NULL on an org row = inherit |

Ownership enforcement (quorum #1):
- Partner rows have a CHECK `partner_id = offering_partner_id`.
- Org rows have a composite FK `(org_id, offering_partner_id) → organizations(id, partner_id)`, **DEFERRABLE INITIALLY IMMEDIATE** (the org-merge contract).
- Direct-SQL forgery tests, run as `breeze_app` with each shape, must fail.

**Tighten-only merge** (quorum #11, preserving `effectivePolicy.ts:212` semantics):
- **Permitted set**: effective permitted = partner permitted ∩ org permitted. An org can only narrow.
- **Default**: the org default must lie inside the effective permitted set, or it is ignored and the partner default applies.
- **User choice**: `allow_user_choice` = partner ∧ org.
- **Options**: org options are clamped to the partner's.
- **Fallbacks**: org fallbacks must be a subset of the partner's permitted set.

Uniqueness: `(coalesce(org_id, partner_id), surface, role)`.

Registrations:
- The table's policies follow the dual-axis + partner-wide SELECT branch template (`2026-10-05-110000-config-policy-partner-wide-select.sql`).
- Cascade: `CORE_ORG_CASCADE_DELETE_ORDER`.
- Org merge: `orgMergeRegistry` → **`repoint-dedupe` keyed on `(surface, role)`** (quorum #12). Two merged orgs can't both keep an override.
- Export policy: `CORE_TENANT_EXPORT_POLICY`. `options` → `excludedOpen`; all other columns `included`.
- RLS coverage: `DUAL_AXIS_TENANT_TABLES`.
- Tests: an `aiModelAssignmentsPartnerRls.integration.test.ts` suite.

### 5.5 `ai_invocations` — the invocation ledger (quorum #6), shape 1 (`org_id`)
One immutable row per model call or turn, from **every** surface, including sessionless agent runs.

Columns:
- `id`, `org_id`, `surface`, `role`;
- `user_id` NULL: the tech who initiated it. NULL for system and agent runs. Needed for per-tech showback (W10);
- `session_id` / `agent_run_id` / `source_ref` NULL;
- `offering_id`, `connection_id` NULL, `funding_source` (`platform` | `partner_key`);
- `requested_model`, `served_model`. They differ when a refusal fallback served the turn;
- `options_sent` jsonb (effort / speed / thinking display actually sent), `thinking_mode_sent`, `inference_geo_sent` NULL;
- `stop_reason` (`end_turn` | `tool_use` | `max_tokens` | `refusal` | `error` | …), `refusal_category` NULL, `fallback_used` bool;
- `catalog_revision_id` NULL, `connection_config_version` NULL;
- `input/output/cache_read/cache_write_tokens`, `rate_snapshot` jsonb, `cost_cents`;
- `chargeable` bool: a **snapshot** of whether the partner's chargeback policy (W10) treats this as billable to the org. Default false until W10;
- `sdk_reported_cost_usd` (telemetry only), `created_at`.

A refused turn that fell back is priced by the **served** model's rate (from the registry; fallback eligibility guarantees it is priced). The declined attempt is priced per Anthropic's refusal billing.

It is append-only (REVOKE UPDATE/DELETE + an immutability trigger). Registrations:
- cascade and `AUDIT_ADMIN_REQUIRED_TABLES` (append-only);
- export policy (`rate_snapshot`, `options_sent` → `excludedOpen`);
- merge `repoint`;
- retention by the existing AI-usage retention job. Chargeback (W10) aggregates **before** retention trims rows; it never mutates them.

`ai_sessions` totals and the `ai_cost_usage` rollups become **derived from** invocations, not written independently.

**Quality link**: session flags (`ai_sessions.flagged_at` / `flagged_by`) and the flagged-chat review outcomes are joinable to invocations through `session_id`, giving refusal rate, flag rate and cost per offering. W11 builds the comparison view; no extra columns are needed now.

### 5.6 Existing tables
- **`ai_sessions`**:
  - Add `offering_id` and `offering_partner_id`, with composite FKs to `partner_ai_models(id, partner_id)` and `organizations(id, partner_id)`, deferrable.
  - Add `effort`.
  - `model` stays as a provenance snapshot. Drop its stale default.
  - Export policy: add the new columns.
- **AI agent policies' `model`** → `offering_id` + `offering_partner_id` with the same composite-FK pattern. Explicit policy models are checked against the `ai_agents` assignment's effective permitted set at write **and** at run (quorum #11).
- **`ai_script_policies.reviewer_model`** → the `script_reviewer` assignment.
- **`ai_budgets.allowed_models`** → replaced by the `ai_agents` assignment's `permitted_offering_ids` (backfilled from it), then dropped in W08.

## 6. Discovery

The BullMQ job `ai-model-discovery` runs per connection on create/rotate and on "Refresh models", daily for every connection, and daily for the platform key.

- **Anthropic** (platform and BYOK): `models.list()` upserts id, display name, token limits and the raw capabilities.
  - On the platform key, new ids land unpriced with `platform_offered=false`, and the operator is notified.
  - On BYOK, new ids land as offerings, **disabled**, linked to a platform row when the ids match.
- **Catalog**: offerings are mirrored from the active revision's `model_map` keys, and only mapped **and** verified models appear. `model_map` keys become `ai_platform_models.model_id` values (replacing `OFFERABLE_AI_MODELS` validation).
- **OpenAI-compatible** (W06): `GET {base_url}/models` through the egress guard. Rows land with capabilities `unknown` until the fidelity harness verifies them. Manual entry is always allowed.
- **Lifecycle**: a model absent from 3 consecutive successful syncs is `missing`; absent for 14 days it is `retired`. A failed sync never changes lifecycle.
- **Discovery never enables anything, never changes an assignment, and never deletes rows.**

## 7. Thinking and effort (replaces the #7587 interim resolver)

The Models API capability leaves used are `thinking.types.{adaptive,enabled}.supported` and `effort.{low…max}.supported`. Two concepts stay **separate** (quorum #10): the **API effort level** and the **manual thinking budget**.

| Verified capability | `thinking_mode` | Wire |
|---|---|---|
| adaptive supported | `adaptive` | `thinking: {type:'adaptive'}` + `output_config.effort` (only when effort is supported). **Never `disabled`** |
| only `enabled` supported | `budget` | `thinking: {type:'enabled', budget_tokens}`, with `budget_tokens ≥ 1024` and `< max_tokens`. The UI shows "Thinking: off / on (budget)" and no effort control |
| supported: neither | `none` | No thinking, no effort |
| not verified (BYO, catalog without a harness pass, or manual) | `unknown` | Nothing is sent. The UI shows no thinking or effort controls and labels the model "capabilities unverified" |

- **Catalog and BYO endpoints send a parameter only if the fidelity harness verified it** for that revision or connection. The harness gains an adaptive + effort probe and moves to `max_tokens ≥ 2048`, because manual thinking needs ≥1024 and today's harness uses 512.
- **Option resolution** (each `OfferingOptions` key independently): request → effective assignment `options` → offering `default_options` → provider default (the param is omitted). The result is clamped to `allowed_options ∩ model support`. If that intersection is empty at runtime (a model's capabilities changed), the param is omitted and a warning is logged. Writes can never create an empty intersection.
  - `effort` → `output_config.effort`.
  - `thinkingDisplay` → `thinking.display`. `updates` (beta `thinking-display-updates-2026-08-18`; Fable 5.1, Opus 5.5, Sonnet 5.5) streams short progress notes while the model thinks. **It is the chat default where supported**, so a thinking model never looks frozen. That holds only if the Agent SDK passes it through; W01 verifies this, and if it can't, the chat shows a "thinking…" indicator.
  - `speed: fast` → `speed: 'fast'` + beta `fast-mode-2026-02-01`. Only on models whose `option_support.speed.fast` is set (Opus 5.5 / 5 / 4.8, Claude API only). Priced from `option_rates["speed:fast"]`. A 429 on fast falls back to standard and records `options_sent` accordingly.
- **Inference geography**: the connection's `inference_geo`, else the platform setting, is sent only where `option_support.inferenceGeo` includes the value. If the partner **requires** residency (`partners.settings.ai.residencyRequired`), offerings that can't honour it are ineligible (§9), never silently sent elsewhere. The supported values must be confirmed against the live API before W03.
- **`max_tokens`** per call is validated against the model's `max_output_tokens`.
- **Tool-requiring surfaces**: `chat`, `helper`, `script_builder`, `ai_agents`, `office_chat`. An offering without verified tool support can't be assigned or permitted for them.
- **Prompt profile**: `resolveModel` returns the model's `prompt_profile`. System-prompt builders may branch on it: frontier models (Opus 5.5 / Fable) do worse with heavily prescriptive prompts, and small models need terser tool guidance. v1 ships one prompt per surface plus the hook. Per-profile prompt tuning is W11, measured with the quality view.
- **Agent SDK**: #7587 established `query({ thinking, effort })`. This module owns the mapping of every option onto SDK/API params afterwards.

## 8. Pricing, funding and billing (quorum #4, #5)

- **One cost function.** `priceInvocation(rateSnapshot, tokenComponents)`. The rate snapshot comes from `resolveModel`. The SDK's `total_cost_usd` is **recorded as telemetry only** and is never used for billing. This replaces the SDK-preferred path (`aiCostTracker.ts:1008`) and the Office SDK-cost path (`streamingSessionManager.ts:1916`). Budgets, reservations, credits, org/user ledgers and displayed cost all read the resulting `cost_cents`.
- **Funding source per offering, not per org.** Platform offering → `platform`. Any connection offering → `partner_key`. Admission, reservations, credit checks, settlement and compute accounting take the funding source from the **resolved offering**, before admission. `getLlmBillingSourceForOrg` is deleted.
- **Platform rates**: from `ai_platform_models` only. A platform offering is reachable only if its platform row is `platform_offered` (which implies priced) and `available`. **This is re-checked at every dispatch**: assignment, stored session, agent policy and fallback alike (quorum #2). Platform traffic never uses any fallback rate.
- **Connection rates, for metering**, in precedence order:
  1. the offering's price;
  2. the catalog revision's snapshot price, for catalog offerings;
  3. the linked platform row's price (BYOK Anthropic);
  4. none.

  A non-platform offering **with no resolvable price can't be enabled**. The admin enters one; 0 is valid for local models. There is no `DEFAULT_PRICING` guess.
- **Option rates**: an option variant with its own rate (fast mode) is priced from `option_rates`. A variant with no rate is not selectable.
- **Refusals**: a turn served by a refusal fallback is priced at the **served** model's rate. The fallback offering must itself be eligible and priced (§5.3), so this is always defined.
- **Hosted plan gate**: `ai_platform_models.min_plan` is compared with `partners.plan` at enable time **and** at dispatch. A partner that downgrades loses access to the gated models at the next turn, through the §9.1 fallback.
- **Chargeback (W10)**: Breeze's own costs stay as above. What an MSP charges its client is a **separate** partner-set price (cost-plus markup or a per-model client price list). It is applied in W10 by aggregating `ai_invocations` where `chargeable`, into invoice lines through the existing billing profiles. W10 decides the pricing model (§15 #6).
- `MODEL_PRICING`, `OFFERABLE_AI_MODELS`, `DEFAULT_PRICING` and `isPricedModel` are deleted in W03.

## 9. Resolution

```ts
resolveModel({ partnerId, orgId, userId?, surface, role = 'default',
               requested?: { offeringId?: string; options?: Partial<OfferingOptions> } })
  → { ok: true, offering, connection, funding, wireModel, thinking, options, inferenceGeo,
      refusalFallback?, promptProfile, rateSnapshot, capabilities, catalogRevisionId?, configVersion? }
  | { ok: false, reason: 'no_eligible_model' | 'not_permitted' | 'permission_required' | 'plan_required'
        | 'residency_unavailable' | 'unpriced' | 'connection_unavailable' | ..., recoverable: true }
```

The steps:
1. **Effective assignment.** Take the partner row for `(surface, role)` and apply the org row tighten-only (§5.4). If a role has no row, it inherits the surface's `default` role.
2. **Candidate.** If `requested` is set, it must satisfy `allow_user_choice` and the effective permitted set; otherwise use the effective default. Then **eligibility**:
   - enabled, `available`;
   - owned by the partner;
   - platform offering → `platform_offered`;
   - connection offering → connection `active` and priced; catalog → mapped + verified in the current authorized revision;
   - tools when the surface requires them;
   - `required_permission` held by `userId` (user-initiated calls; system/agent calls skip it, because the admin chose the model);
   - `min_plan` satisfied by the partner's plan (hosted);
   - residency honoured when the partner requires it (§7).
3. **Wire.** Endpoint, key and catalog translation, **for every surface including AI agents** (fixing the current skip). Thinking, options and inference geo per §7. The refusal fallback, if configured and eligible, is passed as `fallbacks`. Rate snapshot per §8, including the fallback model's rate.

`resolveLlmConfig` becomes the connection half. Every surface calls `resolveModel`, including the patch test runner. The same rule is enforced by construction (`new Anthropic(` only in the connection factory) and a grep contract test. **Correctness is proven by per-surface parity tests** (destination, funding, model before and after the cutover), not by the grep (quorum #14).

### 9.1 Unavailable models: bounded fallback (quorum #9)
When a stored choice (session, agent policy) is ineligible, the resolver tries **exactly one** candidate: the effective assignment default. It is used only if it is eligible **and** on the same connection and funding source. Otherwise the result is `ok:false, recoverable`:
- chat shows "Model X is no longer available — choose another" with the picker;
- an agent run ends `blocked: model_unavailable` and notifies the partner once per policy per day.

Nothing ever crosses a connection or funding source implicitly. In W09, a configured `fallback_offering_ids` list replaces the single-candidate rule with an ordered walk under the same eligibility checks. It crosses funding only when `fallback_may_cross_funding` is set.

### 9.1a Refusals
When a turn ends `stop_reason: refusal` (after any configured refusal fallback also declined), the ledger records the category. The user sees "The model declined this request (category: cyber)." It offers the other permitted offerings and links to the admin docs on configuring a refusal fallback. It is **never** a silent empty answer. An agent run ends `blocked: model_refused`, carrying the category in its outcome. The usage view reports the refusal rate per offering, so a partner can see when, say, security work needs a different model.

### 9.2 Sessions and switching (quorum #8)
- **Claiming a turn** binds offering, effort, rate snapshot and reservation **atomically** (the same transaction as the turn claim).
- **A live SDK query is reused** only if the connection id, `config_version`, catalog revision and wire model are all unchanged. Otherwise the query is recreated.
- **Switching** is allowed within the same connection **and** the same `config_version` and revision, and only when the transcript fits the target model's context window. A cross-connection switch starts a continuation session seeded with a summary.
- **W05 opens with a spike.** It must verify Agent SDK `resume` across models with persisted tool and thinking histories, and with a smaller target context. Preserved-thinking prefix binding means blocks from another model are dropped, not replayed. If resume is unsafe, same-connection switching also becomes a continuation.

## 10. Migration and backfill (quorum #3)

W02 backfills **every surface for every partner** from its **current effective behaviour**, preserving destination and funding source:
- **Partners with a `partner_llm_configs` row:**
  - A connection is created with the same id.
  - An offering is created for each model any surface currently resolves to: the partner default, agent policy models, `reviewer_model`, Office policy models, and the extension/env models where they run on the partner key.
  - Assignments point **every** surface at the offering that surface uses today.
- **Partners without one:** platform offerings for the current platform default, plus any model referenced by their policies.
- **Legacy ids** that match no platform row become `manual` offerings **on the same connection they run on today**. They never silently move to the platform key.
- **Live sessions** get `offering_id` backfilled from `model` + their session's funding source.
- **Parity test**: for a fixture of every existing config shape, `resolveModel` returns the same destination, funding source and wire model that the legacy code path returns.
- **Compatibility**: `/ai/provider` (GET/PATCH/POST key/endpoint) keeps working **against the new store** until W04 replaces the UI.

## 11. UI and settings homes

These follow the settings rules (2026-09-17 audit).

| Concept | Home | Level | Save pattern |
|---|---|---|---|
| Connections (incl. inference geo) | Partner Settings → **AI Providers & Models** (the renamed `#ai-provider` tab), "Connections" card | partner | row drawer Save |
| Residency requirement | Same tab, "Connections" card header switch | partner | autosave + toast |
| Offerings (enable, options, BYO price, required permission, refusal fallback, verify) | Same tab, "Models" table | partner | enable switch = autosave + toast; details = row drawer Save |
| Assignments (default, permitted set, user choice, options; agent roles + fallbacks once W09 lands) | Same tab, "Defaults by feature" | partner | page Save |
| Assignment override (tighten-only; blank = inherit, showing the inherited value and its source) | Org Settings → `#ai`, "Model defaults" | org | page Save |
| Platform models, prices + option rates, option support, `min_plan`, prompt profile, `platform_offered`, platform default, platform inference geo | `/admin/ai-models` (platform admin + MFA). The provider catalog page reads its model list from here | platform | row drawer Save |
| AI usage by model / surface / tech / org, refusal rate (read-only) | The existing `/settings/ai-usage` page, extended from `ai_invocations` | partner (org filter) | n/a |

**Chat composer**:
- a model menu listing the permitted offerings: name, context size, price hint;
- option controls for what the model supports: effort, "Fast" (shows its higher rate), or the thinking toggle for `budget` models;
- offerings the user lacks the permission for appear disabled, with "requires <role>";
- all hidden when `allow_user_choice` is false;
- while the model thinks, the progress notes (`thinkingDisplay: updates`) or a thinking indicator, never a silent pause;
- refusals rendered per §9.1a.

**Existing surfaces**:
- The Office PolicyEditor list becomes the `office_chat` assignment.
- The script reviewer's free-text field becomes the `script_reviewer` assignment.

**Places a model is configured**: before, 4 UI/DB homes + 4 env vars. After, 1 partner home + 1 org override card. The env vars remain only as bootstrap for the platform default on a fresh self-host.

## 12. Security

- **Permissions.** Connections, offerings and partner assignments use the `/ai/provider` gate (`BILLING_MANAGE` + `canManagePartnerWidePolicies`). Org overrides use the org-settings permission. Every mutation is audited.
- **Keys.** Encryption and row-bound AAD as today. Keys are never returned. They are excluded from export.
- **BYO base URLs (W06).** All requests, including discovery, go through `guardedLlmFetch`:
  - no private, link-local or metadata IPs; DNS pinning;
  - https only on hosted;
  - response-size limits;
  - error bodies scrubbed of key material;
  - calls recorded in `llm_egress_events`.

  **W06 requires a security review.**
- **RLS.**
  - `partner_ai_connections`: `PARTNER_TENANT_TABLES`.
  - `partner_ai_models`: `PARTNER_TENANT_TABLES` + the SELECT-only org-token branch.
  - `ai_model_assignments`: dual-axis + the partner-wide SELECT branch.
  - `ai_invocations`: shape 1.
  - `ai_platform_models`: system-table allowlist.
  - **Forgery tests** cover every composite FK: cross-partner connection, offering, assignment, session and agent policy.
- **Cost abuse.** This replaces the free-form session `model` input. Only eligible offerings are reachable, and they are re-checked at every dispatch. Fast mode and premium models can be gated by `required_permission` and `min_plan`.
- **Residency.** When it is required, it fails closed: an offering that can't honour the geography is ineligible, and nothing falls back to a non-resident model.
- **W07 cloud connections** (Bedrock / Vertex / Foundry) store cloud credentials under the same row-bound encryption. They get the same security review as W06.

## 13. Waves (revised per quorum #14)

| Wave | Scope | Rigor |
|---|---|---|
| **W0 (#7587, in flight)** | Interim: Sonnet 5.5 default, adaptive thinking, new prices, validate session model | high |
| **W01** | `ai_platform_models` + seed + Anthropic discovery (platform key) + `/admin/ai-models` (prices, option rates/support, `min_plan`, prompt profile); §7 derivation + `OfferingOptions` schema (deletes the interim resolver); harness adaptive/effort probe; verify the SDK passes `thinking.display: updates`, `speed` and `inference_geo` | high |
| **W02** | Schema + backfill + compatibility: connections (id-preserving, AAD, `inference_geo`, `provider_config`), offerings (options, `required_permission`, refusal fallback), assignments (every surface, `role`, `options`, fallback columns), `ai_invocations` (user, served model, refusal, options, chargeable); `/ai/provider` on the new store; **no routing change** (parity tests) | high (tenancy, secrets) |
| **W03** | Cutover: `resolveModel` on all surfaces (agents wire translation, patch runner); per-offering funding through admission → settlement; one cost function incl. option + fallback rates; permission / plan / residency eligibility; refusal handling (§9.1a); prompt-profile hook; delete the hard-coded lists; BYOK discovery | high (billing) |
| **W04** | Settings UI: partner tab (connections, residency, models, defaults) + org override card; AI-usage page by model / surface / tech / refusal rate; replace PolicyEditor list + reviewer field | medium |
| **W05** | SDK-resume spike → turn-claim binding, chat picker with option controls + thinking progress, same-connection switching / continuation, agent policy picker | medium→high if the spike finds resume issues |
| **W06** | `openai_compatible` per partner: guarded discovery, manual entry, harness verification, tool calling (absorbs #6772, closes #7120) | high + security review |
| **W07** | `bedrock` / `vertex` / `foundry` connections via the Agent SDK's provider modes: provider config, regional inference, discovery where the provider lists models, harness verification | high + security review |
| **W08** | Drop `partner_llm_configs`, `ai_budgets.allowed_models`, legacy cost paths; docs | low |
| **W09** | Failover (`fallback_offering_ids` walk, `fallback_may_cross_funding`) + agent escalation roles (triage → analysis → remediation, #7570) | high (funding) |
| **W10** | Chargeback: partner client pricing (markup or price list), `chargeable` policy, monthly aggregation into invoice lines via billing profiles, per-client AI usage report | high (billing) |
| **W11** | Model quality view (cost, refusal rate, flag rate, turns-to-resolution per offering) + per-prompt-profile prompt tuning measured against it | medium |

## 14. Still out of scope

- `fallbacks: "default"` (Anthropic auto-routed refusal fallback). It could serve a model we haven't priced, so only the explicit-model form is used.
- Automatic, model-chosen escalation **within** one chat turn. W09 escalation is policy-driven per agent stage.
- Non-chat modalities.

## 15. Decisions (approved by Todd 2026-09-30 — all recommendations accepted)

1. **Premium models on the platform key (hosted).** Credits burn 2–5× faster than Sonnet 5.5. **Recommend** gating only by `platform_offered` + price, with the rate shown at enable time. Plan-gating can come later as a column.
2. **Who picks per chat.** **Recommend** techs choose among the permitted offerings by default, with `allow_user_choice=false` locking a surface (partner or org).
3. **A new Anthropic model on hosted.** **Recommend** a manual operator step (set price → offer): one click, and never billed at a guessed rate.
4. **Cross-connection switch mid-chat.** **Recommend** a continuation session with a summary.
5. **EU residency default.** **Recommend** the EU deployment sets the platform inference geo to EU **if** Anthropic offers an EU value for the offered models (verify in W01). Partners there can then turn on "residency required".
6. **Chargeback pricing model (W10).** Cost-plus markup per partner vs. a per-model client price list vs. both. **Recommend** deciding at W10 planning with partner input. The ledger supports either.
7. **Fast mode on the platform key.** It costs 2× Opus rates. **Recommend** offering it only behind a `required_permission` the partner grants deliberately.

## 16. Advisor quorum (2026-09-30)

- **Fable position**: the v1 draft of this doc.
- **Codex** (`gpt-6-astra`, xhigh, read-only, verified against source): **agree-with-changes**. It kept the four configuration entities and found 14 issues.
- **Verification.** The claims about current code were verified before adoption: `llmConfigResolver.ts:421` org-level funding, `aiCostTracker.ts:1008` SDK-cost preference, harness `max_tokens: 512`, `effectivePolicy.ts:212` tighten-only allowlist, `repoint-dedupe` availability, row-bound AAD at `encryptedColumnRegistry.ts:128`.
- **Adopted, all 14**:
  - #1: composite FKs + forgery tests.
  - #2: platform identity derived, eligibility re-checked at dispatch.
  - #3: full-surface backfill + parity.
  - #4: per-offering funding.
  - #5: one cost function.
  - #6: `ai_invocations` in W02.
  - #7: live catalog-revision resolution, precedence fixed.
  - #8: atomic turn binding + resume spike.
  - #9: bounded fallback + recoverable unavailable.
  - #10: separate effort/budget, `unknown` mode, verified params only, `office_chat` needs tools.
  - #11: `permitted_offering_ids` + tighten-only merge.
  - #12: `repoint-dedupe`, org-token SELECT branch, system-table posture.
  - #13: id-preserving connection migration with the legacy `aadTag`.
  - #14: W2 split into W02/W03.
- **Divergence from Codex's suggestion**:
  - The permitted list is a `uuid[]` + ownership trigger, not a child table (it avoids a new join-policy shape). Membership is re-filtered at resolve.
  - Unpriced BYO offerings can't be enabled, rather than metering at a default rate.

  Codex did not rule these out.

**v3 additions (2026-09-30, after the quorum, at Todd's request):**
- refusal recording + explicit refusal fallback;
- chargeback-ready ledger (user, chargeable);
- inference geo / residency;
- generalized `OfferingOptions` (effort, thinking display, fast mode);
- `(surface, role)` assignments + failover columns;
- `required_permission` / `min_plan` gates;
- W07 cloud connections, W09 failover/escalation, W10 chargeback, W11 quality.

These are additive columns and waves on the quorum-reviewed structure, so none changes the tenancy, funding or migration contracts Codex reviewed. **A second Codex pass on the W02 schema is required during W02 planning.**
