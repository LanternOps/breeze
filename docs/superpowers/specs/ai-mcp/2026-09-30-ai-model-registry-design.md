---
title: AI model registry — discovered models, admin enablement, per-chat model + effort, BYO providers
status: draft (awaiting advisor quorum + Todd decisions §14)
date: 2026-09-30
issues: "#7570 (multiple models/providers), #7120 (BYO OpenAI-compatible), #6772 (tool calling on OpenAI-compatible), #7587 (interim — W0)"
---

# AI model registry

## 1. Problem

Breeze hard-codes every Claude model name it knows about. There are about eight places, and they have already drifted apart:

| Where | What |
|---|---|
| `services/aiModel.ts` | platform default `claude-sonnet-4-6` |
| `services/aiCostTracker.ts` | `MODEL_PRICING`, `OFFERABLE_AI_MODELS` (4 ids) |
| `web/components/admin/LlmProviderCatalog.tsx` | a second copy of the offerable list |
| `web/components/clientAi/PolicyEditor.tsx` | dated Sonnet 4.5 / Haiku 4.5 ids that match nothing else |
| `db/schema/ai.ts` | `ai_sessions.model` default and `ai_budgets.allowed_models` default, both `claude-sonnet-4-5-20250929`. `allowed_models` has no write path |
| `services/extensionAi.ts`, `ee/workspace/.../enrichmentService.ts` | `claude-haiku-4-5` |
| 4 call sites | `thinking: { type: 'disabled' }`: a per-model decision baked into the code. Current models reject it with a 400 |
| env | `ANTHROPIC_MODEL`, `MCP_LLM_MODEL`, `WORKSPACE_CONTENT_LLM_MODEL`, `BREEZE_AI_SCRIPT_REVIEWER_MODEL` |

The consequences:
- A new Anthropic model needs a release before anyone can use it.
- The chat runs Sonnet 4.6 with no reasoning step.
- Partners can pick exactly one model for everything.
- Techs cannot choose a stronger model for a hard problem.
- BYO providers are env-only (self-host) and chat-only (no tools).

Customers ask for per-task models (#7570: cheap triage, then analysis, then remediation) and BYO endpoints (#7120).

## 2. Goals

1. **One registry** of the models a partner can use: id, display name, provider/connection, capabilities, price, enabled state. Every model list, price lookup and thinking decision in the code reads from it.
2. **Discovery.** Anthropic models are learned from the Models API (`GET /v1/models`) for both the platform key and a BYOK key. BYO providers are discovered via their `/models` endpoint where one exists, otherwise entered manually.
3. **Admin enablement.** A partner admin chooses which models their techs may use and sets the default model + effort for each AI surface. An org can override the surface defaults (partner default → org override).
4. **Direct exposure.** The chat shows real model names and the options that model supports (effort, thinking). No abstract tiers are imposed.
5. **Capability-driven requests.** The thinking and effort parameters are derived from the model's capabilities, never from a name list.
6. **Correct cost.** Every model has a price source, and every turn records the model that actually ran.

### Non-goals (v1)
- Automatic multi-provider failover when a provider is rate-limited or down (#7570 asks for it). The connection model leaves room for it (§13).
- Escalation chains (triage model → analysis model) inside a single agent run. Per-surface defaults cover the common case; chains are a follow-up.
- Non-chat modalities (embeddings, images).

## 3. Current state to build on (origin/main c1c8fee46f)

- **`partner_llm_configs`** (partner axis, one row per partner): encrypted BYOK Anthropic key, `default_model` (validated against `OFFERABLE_AI_MODELS`), optional `catalog_entry_id`. Every save is probed live.
- **Platform provider catalog** (`llm_provider_catalog` + revisions + verifications; platform-global, platform-admin + MFA): each revision has a `model_map` of logical id → `{providerModel, pricing}`. A fidelity harness (`runFidelityCheck`) verifies each mapped model, and a revision activates only when all its models are verified. **This is already a small registry.** It is limited to curated endpoints and keyed by the hard-coded offerable list.
- **Resolver** (`services/llm/llmConfigResolver.ts`): `resolveLlmConfig(partnerId)` → platform | partner (anthropic | catalog endpoint), plus `resolveWireModel()` for catalog id translation.
- **OpenAI-compatible provider**: env-only, deployment-wide, chat-only (no tools, no caching).
- **Surfaces.** 12 surfaces call a model: chat and topology chat, helper, script builder, script-proposal reviewer, client-AI / Office chat, Office email→ticket, ticket draft, AI agents / alert verdicts, catalog enrichment, extension AI / workspace enrichment, and the patch test runner. Known defects: AI agents skip `resolveWireModel`, and the patch test runner bypasses the resolver and BYOK entirely.
- **Hosted billing** deducts platform-key spend from breeze-billing AI credits. BYOK spend is billed to the partner directly by Anthropic; our budgets still meter it.

The registry **generalizes** the catalog's model map and **replaces** `OFFERABLE_AI_MODELS`, `MODEL_PRICING`, `ai_budgets.allowed_models`, the PolicyEditor list and the model env vars (the env vars stay only as bootstrap defaults).

## 4. Concepts

- **Connection**: a way to reach models, which is a provider plus credentials. Kinds:
  - `platform`: implicit, the deployment's own key (the hosted platform key, or the self-host env key).
  - `anthropic_byok`: a partner's Anthropic key.
  - `catalog`: a platform-vetted third-party Anthropic-dialect endpoint.
  - `openai_compatible`: partner BYO, W5.
- **Model**: a wire model id reachable through a connection, with capabilities and price.
- **Offering**: a model that a partner has made available to its techs (enabled), plus defaults.
- **Surface**: a feature that calls a model: `chat`, `helper`, `script_builder`, `script_reviewer`, `office_chat`, `office_ticket`, `ai_agents`, `catalog_enrichment`, `extension_content`, `patch_test`. Ticket draft and topology inherit the chat session's model.
- **Assignment**: the default offering + effort for one surface, set at partner level with an optional org override.

## 5. Data model

All new tables are created with their RLS policies in the same migration. Shapes refer to the CLAUDE.md table.

### 5.1 `ai_platform_models`: platform-global catalog (no tenant column)
Precedent: `llm_provider_catalog`. Global rows. Writes happen in system context (discovery worker and platform-admin routes); `breeze_app` gets SELECT.

| column | notes |
|---|---|
| `id` uuid pk | |
| `provider` text | `anthropic` (v1) |
| `model_id` text unique | wire id exactly as the Models API returns it; never date-suffixed by us |
| `display_name` text | from the API |
| `max_input_tokens`, `max_output_tokens` int | from the API |
| `capabilities` jsonb | the raw `capabilities` tree from the Models API, stored verbatim |
| `thinking_mode` text | **derived** (§7): `adaptive` \| `budget` \| `none` |
| `effort_levels` text[] | **derived** from `capabilities.effort.*.supported` |
| `supports_tools`, `supports_vision` bool | derived |
| `input/output/cache_read/cache_write_cents_per_m` numeric | **operator-set price** (§8). NULL = unpriced |
| `platform_offered` bool default false | the operator allows partners to enable it on the platform key. It requires a price |
| `lifecycle` text | `available` \| `missing` (absent from the last N syncs) \| `retired` |
| `first_seen_at`, `last_seen_at`, `updated_at` | |

It is seeded by migration with today's `MODEL_PRICING` rows, so a fresh self-host works before the first sync.

### 5.2 `partner_ai_connections`: shape 3 (partner axis)
This generalizes `partner_llm_configs` from one row per partner to many.

| column | notes |
|---|---|
| `id`, `partner_id` | RLS `breeze_has_partner_access(partner_id)` |
| `kind` | `anthropic_byok` \| `catalog` \| `openai_compatible` (the `platform` connection is implicit and has no row) |
| `name` | admin label ("Anthropic — prod key") |
| `api_key_encrypted`, `key_last4`, `key_fingerprint` | same encryption and AAD scheme as today |
| `catalog_entry_id` | for `catalog` |
| `base_url` | `openai_compatible` only; egress-guarded (§11) |
| `status`, `last_error`, `verified_at`, `config_version`, `connected_by` | as today |
| `last_discovered_at`, `discovery_error` | |

Migration: each `partner_llm_configs` row becomes one connection, and its `default_model` becomes that partner's `chat` assignment (§5.4). `partner_llm_configs` stays read-only for one release, then is dropped (W6).

### 5.3 `partner_ai_models`: shape 3 (partner axis). The offerings list

One row per model a partner can use: a platform model the partner enabled, or a model discovered or entered on one of its connections.

| column | notes |
|---|---|
| `id`, `partner_id` | |
| `connection_id` uuid NULL | NULL = platform connection; FK `partner_ai_connections` ON DELETE CASCADE |
| `platform_model_id` uuid NULL | set for the platform connection **and** for BYOK rows whose id matches a platform model. Capabilities and price are inherited from it unless overridden |
| `model_id` text | wire id on this connection |
| `display_name` text NULL | admin override |
| `source` | `platform` \| `discovered` \| `manual` \| `catalog` |
| `capabilities` jsonb NULL, `thinking_mode`, `effort_levels`, `supports_tools`, `max_input_tokens`, `max_output_tokens` | used when `platform_model_id` is NULL (BYO), or as an override |
| `price_*_cents_per_m` NULL | **BYO only**, used for budget metering. It is refused for the platform connection, whose price is the operator's |
| `enabled` bool default false | new discoveries arrive **disabled**. An admin enables them |
| `default_effort` text NULL, `allowed_efforts` text[] NULL | admin limits (NULL = all the model supports) |
| `verification` | `unverified` \| `passed` \| `failed` + `verified_at` (fidelity harness; required for tools on BYO) |
| `lifecycle` | mirrors the source (`available` \| `missing` \| `retired`) |

Unique key: `(partner_id, coalesce(connection_id, '00000000-…'), model_id)`.

### 5.4 `ai_model_assignments`: partner-wide first (org_id XOR partner_id)
This is a config table, so it follows the dual-ownership playbook: `org_id` and `partner_id` are both nullable, `ai_model_assignments_one_owner_chk`, one dual-axis RLS policy, plus the SELECT-only partner-wide branch for org tokens (template `2026-10-05-110000-config-policy-partner-wide-select.sql`).

| column | notes |
|---|---|
| `id`, `org_id` NULL, `partner_id` NULL | |
| `surface` text | §4 list (CHECK) |
| `partner_ai_model_id` uuid | FK `partner_ai_models` ON DELETE RESTRICT (disabling an in-use model is handled by the app, §9.4) |
| `effort` text NULL | clamped to the model's levels at resolve time |
| `allow_user_choice` bool default true | chat/office only: whether techs may pick another enabled model |

Unique `(coalesce(org_id, partner_id), surface)`. An org row must reference an offering of the org's own partner (validated in the app and asserted in the RLS test).

**Cascade registration** (org_id table):
- `CORE_ORG_CASCADE_DELETE_ORDER`
- `orgMergeRegistry` (`repoint`)
- `CORE_TENANT_EXPORT_POLICY` (all columns `included`)
- `DUAL_AXIS_TENANT_TABLES`
- a `aiModelAssignmentsPartnerRls.integration.test.ts` suite

### 5.5 Changes to existing tables
- **`ai_sessions`**:
  - add `partner_ai_model_id` uuid NULL and `effort` text NULL.
  - Keep `model` as the provenance snapshot of the wire id.
  - Drop the stale column default (the app always sets it).
  - The new columns → export policy `included`.
- **`ai_messages`**: add `model` text NULL and `effort` text NULL on assistant turns, for per-turn attribution once switching exists (§9.2). The table has no org_id and is not in the cascade list.
- **`ai_budgets.allowed_models`**: its only reader (the agents org-model gate) moves to "offering enabled for the partner, and allowed by the assignment". The column is dropped in W6. The export-policy entry is removed with it.
- **AI agents policy `model` field**: becomes `partner_ai_model_id` (see #2135 policy shape). Existing string values are mapped by `model_id` in a migration.
- **`ai_script_policies.reviewer_model`** (free text): becomes the `script_reviewer` assignment.

## 6. Discovery

A BullMQ job `ai-model-discovery` runs:
- per connection, on create/rotate and on "Refresh models";
- daily for every connection;
- daily for the platform connection, using the platform key.

- **Anthropic** (platform, `anthropic_byok`): `client.models.list()` (auto-paginates). The job upserts `id`, `display_name`, `max_input_tokens`, `max_tokens` and the raw `capabilities` tree, and recomputes the derived fields (§7).
  - Platform: new ids land in `ai_platform_models` with `platform_offered=false` and no price. The operator is notified (§8).
  - BYOK: new ids land in `partner_ai_models`, **disabled**. A BYOK row whose `model_id` matches a platform model links `platform_model_id`, so it inherits a price for metering.
- **Catalog**: offerings are imported from the active revision's `model_map` (the providerModel is the wire id; the snapshot price and verification are reused). Catalog `model_map` keys become `ai_platform_models.model_id` instead of `OFFERABLE_AI_MODELS`.
- **OpenAI-compatible** (W5): `GET {base_url}/models`, which returns ids only, through the egress guard. Capabilities are unknown, so rows land `unverified` with `supports_tools=false` until the fidelity harness passes. The admin enters a price, otherwise metering uses `DEFAULT_PRICING` with a visible warning. Manual entry is always allowed; some gateways have no `/models`.
- **Lifecycle**: a model absent from 3 consecutive successful syncs becomes `missing`, and absent for 14 days becomes `retired`. A failed sync never changes lifecycle.
- **Discovery never enables anything.** It never changes an assignment and never deletes rows.

## 7. Thinking and effort derivation (replaces the #7587 interim resolver)

From the stored capabilities, using the Models API leaves `capabilities.thinking.types.{adaptive,enabled}.supported` and `capabilities.effort.{low,medium,high,xhigh,max}.supported`:

| capability | `thinking_mode` | request sent |
|---|---|---|
| adaptive supported | `adaptive` | `thinking: {type:'adaptive'}` + `effort` (clamped to `effort_levels`). **Never `disabled`.** Current models reject `disabled` or accept it only at lower effort, and adaptive + low effort is the documented way to reduce thinking |
| only `enabled` supported | `budget` | `thinking: {type:'enabled', budget_tokens}` from an effort→budget table (low 2k … max 32k), below `max_tokens` |
| neither / unknown (BYO) | `none` | no thinking param, no effort |

- **Effort resolution order**: request (the chat picker) → assignment → offering `default_effort` → `medium`. The result is then clamped to `allowed_efforts ∩ effort_levels`. If the model has no effort support, no effort is sent.
- The Agent SDK mapping (how `query()` takes thinking/effort) is settled by #7587, and this function owns it thereafter.
- **Display**: the chat renders a progress indicator while thinking and does not show raw thinking. `display: 'summarized'` is opt-in per surface later.

## 8. Pricing and billing

- **Platform key**: price comes from `ai_platform_models.*_cents_per_m`, which is operator-set on `/admin/ai-models` and seeded from today's `MODEL_PRICING` by migration. **A model can be `platform_offered` only if it is priced.** The Models API does not return prices, so this is the one human step for a new Anthropic model on the hosted platform. Partners cannot change platform prices. Credits (breeze-billing) deduct at these rates.
- **BYOK / catalog / BYO**: price for **metering only** (budgets, usage page). Precedence: the offering override → the linked platform model → the catalog snapshot → `DEFAULT_PRICING` (logged, with a UI warning "unpriced — budgets over-estimate").
- `MODEL_PRICING` and `OFFERABLE_AI_MODELS` are deleted (W2). `isPricedModel` reads the registry.
- **Cost attribution**: every usage write records the model that ran (`ai_messages.model`). Today's per-session totals stay as they are.

## 9. Resolution: the single entry point

```ts
resolveModel({
  partnerId, orgId, surface,
  requested?: { partnerAiModelId?: string; effort?: string },   // chat picker / API
}): Promise<ResolvedModel>
// ResolvedModel = { connection (platform | row), wireModel, logicalModelId,
//   thinking, effort, pricing, capabilities, billingSource, offeringId }
```

1. **Load the assignment** for `(orgId ?? partner, surface)`: the org row, else the partner row, else the **platform fallback** (a platform model that is `platform_offered`, priced and `available`, choosing the env `ANTHROPIC_MODEL` id if it qualifies, else the operator's marked default).
2. **Handle a `requested` model.** It must be `enabled`, `available`, belong to the partner, and the surface's assignment must have `allow_user_choice`. Otherwise the request is rejected with 400 (API) and the picker never offers it. This replaces the free-form `createAiSessionSchema.model`.
3. **Check capabilities.** A surface that needs tools (chat, agents, helper, script builder) rejects an offering without `supports_tools`. Assignment writes are rejected for such offerings too.
4. **Build the wire request.** The connection supplies the endpoint and key. The catalog id is translated as today, and this now also applies to **AI agents**, fixing the current skip. Thinking and effort are built per §7. Pricing follows §8.

`resolveLlmConfig` becomes the connection half of this function. Every surface in §3 calls `resolveModel`, including the patch test runner, which stops calling `new Anthropic()` directly. **Acceptance for the migration wave** is a grep contract test: no `'claude-` literal outside the seed migration and test fixtures, and no `new Anthropic(` outside the connection factory.

### 9.1 Sessions
Creating a session resolves the model and stores `partner_ai_model_id`, `effort` and the `model` snapshot. Each turn re-resolves from the session's offering, so a price or capability change applies without a restart.

### 9.2 Switching models in a chat
The picker sits in the composer and applies from the next turn. Switching is allowed between enabled offerings **on the same connection**. A cross-connection switch starts a continuation session carrying a summary, because Agent SDK resume is per backend. Thinking blocks from another model are dropped by the API (unbilled), so no transcript surgery is needed. The prompt cache resets on a switch, and the UI says so ("switching model restarts the cache for this chat"). `ai_messages.model` records the model per turn.

### 9.3 AI agents
Agent policy `model` → offering reference, validated on write (enabled + tools). A partner-wide agent policy running for an org resolves through the **device org's** assignment rules only if the policy leaves the model unset (partner-wide first, step 5).

### 9.4 Disabling / retirement
- **An admin disables an offering that is in use.** The UI lists the assignments and agent policies that reference it. The admin must repoint them, or confirm "fall back to surface default". A disabled model is never used silently.
- **A model becomes `missing`/`retired`.** Open sessions fall back to the surface default at their next turn, with an inline notice. Agent runs fall back too and raise one partner notification. Nothing ever errors mid-conversation because a model disappeared.

## 10. UI and settings homes

**Settings rules (2026-09-17 audit).** Each concept has one home, partner default → org override, and one save pattern per screen type.

| Concept | Home | Level | Save pattern |
|---|---|---|---|
| Connections (keys, endpoints) | Partner Settings → **AI Providers & Models** (the existing `#ai-provider` tab, renamed) — "Connections" card | partner | row drawer Save |
| Model offerings (enable, default effort, limits, BYO price, verify) | same tab, "Models" table (one row per offering: name, connection, context, efforts, price, status, enable switch) | partner | enable switch = autosave + toast; details = row drawer Save |
| Surface defaults | same tab, "Defaults by feature" card | partner default | page Save |
| Surface defaults override | Org Settings → `#ai`, "Model defaults" card; blank = inherit, shows the inherited value and its source | org override | page Save |
| Platform models + prices + `platform_offered` | `/admin/ai-models` (platform admin + MFA). The provider catalog page reads its model list from here | platform | row drawer Save |

**Chat composer**: a model menu (display name + context size + a price hint such as "$2/$10 per M") and an effort segmented control showing only the levels the model supports. The menu is hidden when the surface's `allow_user_choice` is false.

**Office add-in PolicyEditor**: its checkbox list is replaced by the `office_chat` assignment + `allow_user_choice`. Script authoring's free-text reviewer model becomes the `script_reviewer` assignment.

**Places a model is configured.**
- Before: partner default model, `ai_budgets.allowed_models` (no UI), the Office policy list, the script reviewer text field, and 4 env vars. That is 4 UI/DB homes + 4 env.
- After: 1 home (the partner tab) + 1 org override card. The env vars remain as bootstrap/fallback only and are documented as such.

## 11. Security and tenancy

- **Permissions**: connections and offerings follow the existing `/ai/provider` gate (`BILLING_MANAGE` + `canManagePartnerWidePolicies`). Org assignment overrides use the org-settings permission. Every mutation gets `writeRouteAudit`.
- **Keys**: the same encryption and column AAD as `partner_llm_configs`. Keys are never returned, only `last4` and the fingerprint. Keys and credentials are excluded from export.
- **BYO base URLs (W5, hosted)**: all traffic goes through `guardedLlmFetch`/the egress guard (no private/link-local/metadata IPs, DNS pinning, https only on hosted). Requests are recorded in `llm_egress_events`. The discovery call is guarded the same way. **This wave needs a security review** (SSRF, response-size limits, a key echoed in error bodies).
- **RLS**:
  - `partner_ai_connections` and `partner_ai_models` → `PARTNER_TENANT_TABLES`.
  - `ai_model_assignments` → `DUAL_AXIS_TENANT_TABLES` with the partner-wide SELECT branch.
  - `ai_platform_models` is global, read-only to `breeze_app`, written only in system context.
  - Test: an org token cannot read another partner's offerings, and cannot reference another partner's offering in an assignment (42501 / validation).
- **Cost abuse**: this replaces today's free-form `model` input (anyone could start a session on any id against the platform key). Only enabled, priced, offered models are reachable.

## 12. Waves

| Wave | Scope | Rigor |
|---|---|---|
| **W0 (#7587, in flight)** | Sonnet 5.5 default, adaptive thinking, new prices, validate session model — interim | high (billing) |
| **W1** | `ai_platform_models` + seed; Anthropic discovery (platform connection); §7 derivation from capabilities (deletes the interim resolver); `/admin/ai-models` (prices, `platform_offered`) | high |
| **W2** | `partner_ai_connections` (migrate `partner_llm_configs`), `partner_ai_models`, `ai_model_assignments`; `resolveModel`; migrate **all 12 surfaces** + fix agents wire translation + patch runner; delete `MODEL_PRICING`/`OFFERABLE_AI_MODELS`; grep contract test; BYOK discovery | high (tenancy, billing) |
| **W3** | Partner "AI Providers & Models" tab (connections, models table, defaults by feature) + org override card; replace the PolicyEditor list + reviewer text field | medium |
| **W4** | Chat composer model + effort picker; per-turn `ai_messages.model`; same-connection switching; agent policy model picker | medium |
| **W5** | `openai_compatible` per-partner connections: guarded discovery, manual entry, fidelity verification, tool calling (absorbs #6772, closes #7120) | high (egress/SSRF) |
| **W6** | Drop `partner_llm_configs`, `ai_budgets.allowed_models`; env vars documented as bootstrap only; docs | low |

W1 and W2 can overlap once the W1 schema lands. W3 and W4 are UI waves on top of W2. W5 is independent after W2.

## 13. Designed-for, not built
- **Failover**: `ai_model_assignments` could later hold an ordered fallback list (for rate limits or an outage on a connection), as #7570 asks.
- **Escalation**: an agent policy could name `triage`/`analysis`/`remediation` offerings. The surface enum and the per-policy offering reference make this additive.
- **Server-side refusal fallback** (`fallbacks: "default"`) for Sonnet 5.5 / Opus 5.5 / Fable 5.1 could be a per-offering flag once the Agent SDK passes it through.

## 14. Decisions needed (Todd)

1. **Premium models on the platform key (hosted).** May every plan enable Opus 5.5 / Fable 5.1 on the platform key? Credits burn 2–5× faster than Sonnet 5.5. **Recommend: yes, gated only by `platform_offered` + price,** with the per-model price shown at enable time. Plan-gating can be added later as a column.
2. **Who picks per chat.** **Recommend:** techs pick among enabled models by default. `allow_user_choice=false` lets a partner (or org) lock a surface.
3. **New Anthropic model on hosted.** Discovery finds it, then the operator sets a price and flips `platform_offered`. The alternative is to auto-offer at a seeded list price. **Recommend the manual step**: one click per model, and it never bills at a guessed rate.
4. **Cross-connection switching mid-chat.** A continuation session (recommended) versus forbidding it in v1.

## 15. Advisor quorum
Pending: Fable position (this doc) plus an independent Codex `xhigh` review of §5 (tenancy shapes), §7 (derivation) and §9 (resolver + switching). Disagreements get recorded here with the resolution.
