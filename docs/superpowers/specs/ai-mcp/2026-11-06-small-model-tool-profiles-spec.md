---
status: draft (spec-drafted). Awaiting Todd's Gate A on the Open Decisions in §7. Quorum: Codex gpt-6-astra xhigh, read-only, 2026-11-06; agreed on OD-1/OD-2, disagreed on OD-4/OD-5/OD-7/OD-8 (both positions in §7; author recommends Codex's refinements).
date: 2026-11-06
tracking_issue: LanternOps/breeze#9596
covers: "#9596 (constrained prompt for small self-hosted models), #11111 (cap the tool catalog for small-window OpenAI-compatible models; learn the window), #9770 (tool profiles / allowlists for AI chat on self-hosted LLMs)"
related: "#7598 (AI model registry, closed; this extends its model record), #11107 (max_tokens fit, merged), #10577, #7429 (tool search on BYO endpoints), #7795, #7794, #8081, #4447 (onlyTools unknown-name check), #10065 (W19 lazy tool index)"
---

# Tool profiles and a constrained prompt for small-context models

**Scope:** the API side of AI model selection and tool exposure (`apps/api/src/services/aiModels/**`, `aiAgentSdkTools.ts`, `aiToolIndex.ts`, `aiToolSearchPolicy.ts`, `streamingSessionManager.ts`, the OpenAI-compatible gateway) plus the model drawer in Settings → AI. This document records intent and decisions. It contains no plan and no code.

**Evidence:** "verified" means the author re-read the code on `origin/main` at `bef484ca8b`. "Inferred" means it follows from the code but was not exercised. "Reported" means a number from an issue reporter, not measured by us.

## 1. Problem

Three requests describe one gap. A self-hoster points Breeze at an OpenAI-compatible server (LM Studio, Ollama, vLLM, a DGX box). Breeze then sends every turn the same large prompt it sends a frontier model. Nothing lets an operator say "this model gets a small tool set and a short prompt."

- **#9596:** a 3B model loaded at an 8k context on an 8 GB machine cannot finish a turn. Turns time out, come back empty, or end on a tool call the gateway refuses.
- **#11111:** after #11107, an over-window prompt gets a clear "does not fit" error instead of a hang. But the tool catalog dominates the prompt, so a small-window model now fails clearly instead of working. The ask: cap the catalog per connection or model, and know the window before the first over-window request.
- **#9770:** a 131k-window self-hosted model pays about 72–79k input tokens per request (reported). `AI_TOOL_SEARCH=on` cuts that, but the gateway cannot carry `tool_reference` blocks, so tool calls fail. The ask: expose `onlyTools` through `minimal` / `standard` / `full` profiles plus an explicit allowlist, chosen per connection or model, with `full` as the default.

Verified facts that shape the design:

1. **Web chat registers the whole registry.** `streamingSessionManager.getOrCreate` calls `createBreezeMcpServer` without `onlyTools` (`streamingSessionManager.ts:1257`), and `allowedTools` defaults to every Breeze MCP name (`:1398`). The filter itself exists and works (`aiAgentSdkTools.ts:5889`). Helper (`routes/helper/index.ts:130`), topology (`routes/aiTopologyTurn.ts:114`) and agent runs (`aiAgents/runLoop.ts:2299`, `resolveRunToolExposure`) already pass a subset. The script builder runs its own small server (`scriptBuilderTools.ts`).
2. **Tool search never helps a gateway connection.** `resolveToolSearchPolicy` turns search off for any non-first-party host unless `AI_TOOL_SEARCH=on` (`aiToolSearchPolicy.ts:86`). With it on, the `ToolSearch` result arrives as a `tool_result` whose content is `tool_reference` blocks, and the translator accepts only text or image there (`gateway/openai/translateRequest.ts`). This is the 400 in #9770.
3. **The window is learned only from rejections, only in memory.** `gateway/openai/contextWindow.ts` parses the endpoint's context-length rejection, retries once with a `max_tokens` that fits, and keeps the window in a per-process memo with a 1 h TTL. Nothing is stored. Each API replica (#8139) learns it again. The first over-window request always reaches the endpoint.
4. **Gateway offerings have no size facts.** `gatewayCandidate.ts:212-213` hardcodes `promptProfile: 'generic'` and `limits: { maxInputTokens: null, maxOutputTokens: null }`. `ai_platform_models` has `max_input_tokens` and `prompt_profile` (`db/schema/aiPlatformModels.ts:17,29`). `partner_ai_models` (the offering, i.e. the model record) has neither. OpenAI `/models` discovery reads only `id` and a display name (`gateway/openai/discovery.ts`).
5. **Verify proves a toy exchange, not a Breeze turn.** `offeringVerification.ts` runs the fidelity harness: a direct tool_use → tool_result → end_turn with one synthetic tool, then an Agent SDK subprocess with one in-process MCP tool (`llm/providerFidelityHarness.ts:20-26`). A model can pass both and still fail every real surface (#7795, #9596). The record (`gatewayCapabilities.ts`) is what grants tool use to a gateway offering. It is keyed on `FIDELITY_HARNESS_VERSION = '1'`.
6. **An invalid tool call ends the turn.** `validateToolCalls` rejects the whole batch when any call names a tool that was not offered or fails its schema. The response then carries a fixed note instead of the calls (`translateResponse.ts:196-262`). Small models produce these often.
7. **The prompt is mostly tool schemas.** The static chat prompt is about 10.7 KB before the index: base 5.6 KB, tail 1.4 KB, diagnosis 3.7 KB (measured on a local checkout of `main`; approximate). The always-on index is under 2.5 KB (W19 bound B1, `aiToolIndex.w18-budget.test.ts:27`). The reporter on #9770 measured 195 tools and about 68k prompt tokens on the BYO path, with stable prefix hashes across turns (reported). So the schemas are about 85% of the prompt (inferred).
8. **The registry already groups tools by domain.** Every registered tool has one of 14 `AI_TOOL_DOMAINS` (`aiTools.ts:663`, `getToolDomain`) and a short `searchHint` (`:670`). A small `alwaysLoad` core set exists for tool search (`getToolAlwaysLoad`, `:680`).

## 2. Users and scope

- **Who sets it:** the partner (the MSP, or the single tenant on a self-host). Offerings and connections are partner-axis rows (`partner_ai_models`, `partner_ai_connections`, tenancy shape 3). They are edited in Settings → AI → Models (`OfferingDrawer.tsx`) through `PATCH` on the offering (`offeringDetailsPatchSchema`).
- **Who feels it:** every org whose surface assignment (`ai_model_assignments`, org override or partner default) resolves to a constrained offering. Orgs do not edit profiles. They pick models where the partner allows it, and the model brings its profile with it.
- **Surfaces:** `chat` (web chat and Wisp), `helper`, `script_builder`, `ai_agents`, `office_chat`. `script_reviewer`, `office_ticket`, `catalog_enrichment`, `extension_content` and `patch_test` register no Breeze tools. They receive only the window facts (§3.4).
- **Connection kinds:** profiles can be set on any offering. In practice the only non-`full` default is on gateway kinds (`openai_compatible` today, W07 cloud kinds later), because only those have unknown windows (§3.3). Platform and BYO-Anthropic offerings default to `full` and keep tool search.

## 3. Proposed design

### 3.1 The model record carries a tool profile

Add to `partner_ai_models`:

| Column | Type | Meaning |
|---|---|---|
| `tool_profile` | text, CHECK in (`auto`, `full`, `standard`, `minimal`, `custom`), default `auto` | Which tool set this model gets. |
| `tool_allowlist` | jsonb, NULL unless `custom` (CHECK) | `{ domains: AiToolDomain[], tools: string[] }`. Validated at write against `AI_TOOL_DOMAINS` and the declared tool names. |
| `context_window_override` | integer, NULL = none, CHECK 1024..100 000 000 | The operator's number. |
| `context_window_discovered` | integer, NULL | Read from the `/models` payload on each discovery sync (§3.3). |
| `context_window_observed` | integer, NULL | Learned from the endpoint's own context-length rejection (§3.3). |
| `context_window_observed_at` | timestamptz, NULL iff `observed` is NULL | When it was observed. |
| `context_window_observed_config_version` | integer, NULL iff `observed` is NULL | The connection `config_version` it was observed under. A URL or key change invalidates it. |

The operator's override is stored apart from what was observed. Clearing the override restores the evidence underneath, as Codex asked.

Profiles, from smallest to largest:

- **`minimal`:** about a dozen read-only tools per surface, none with a mutating action. Chat example: device lookup and details, device context, fleet health, alerts list/get, log search, metrics, audit log, docs, org lookup. The exact list is set in the plan and pinned by a contract test (§6).
- **`standard`:** about 40 common helpdesk and admin tools per surface, writes included (tickets, scripts, alerts, services). Writes stay behind the same approvals.
- **`full`:** what each surface registers today. For chat, this also keeps tool search on first-party hosts.
- **`custom`:** the partner's own domains and tools (§3.2).
- **`auto`:** resolves at session creation from the window (§3.3).

`auto` with no known window is `full`, which is today's behaviour. That keeps #9770's ask that `full` stays the default for every model that works today. The drawer shows "capacity unknown" in that state, so the operator knows nothing was constrained. A window does not prove tool competence. A large-window model that still struggles can be set to `minimal` or `standard` explicitly.

### 3.2 One resolver: exposure only, and it only removes

A new pure module, `aiModels/toolExposure.ts`:

```
resolveToolExposure({ surface, offering: { toolProfile, toolAllowlist }, effectiveWindow, surfaceBaseSet, extraTools })
  → { profile, names: string[] | null, extraToolNames: string[], promptMode: 'standard'|'constrained',
      toolSearchAllowed: boolean, compactSchemas: boolean, resultCharBudget: number, fingerprint: string }
```

Rules:

1. **Intersection only.** `names` is always a subset of the surface's existing set. That set is the whole registry for chat, the helper level's list, the agent run's `resolveRunToolExposure` list, or the script builder's own declarations (`scriptBuilderTools.ts:43`, with names of its own). A profile or custom allowlist can hide a tool. It can never add one: a custom `execute_command` on a helper `basic` session is dropped. `names: null` means "unchanged" (full).
2. **Extra tools are filtered too.** `createBreezeMcpServer` deliberately leaves `extraTools` outside `onlyTools` (`aiAgentSdkTools.ts:5834`). Chat's tenant/extension tools and flow tools ride there, so a profile must filter them separately:
   - Under `minimal`, `standard` and `custom`, tenant and flow tools are kept only when their domain is in the profile. They count toward the profile's budget.
   - Agent outcome tools (`submit_*_verdict` and similar) are always kept. A run cannot finish without them.
   - `propose_action_plan` is kept when approval mode needs it, and `set_device_context` is always kept for chat.
3. **Exposure, not authority.** RBAC, approvals, guardrails, tenant scoping, Wisp's gate and the agent guardrail policy run in the pre-tool-use hook whatever was registered. This matches Todd's #9770 commitment and the existing `resolveRunToolExposure` contract. The resolver never feeds `guardrailPolicy.toolAllowlist`.
4. **One list, three consumers.** The same names feed:
   - the system prompt's tool index (`composeStaticSystemPrompt` and `aiAgent.ts:962`, which today use `listChatSurfaceToolNames()`)
   - `createBreezeMcpServer({ onlyTools })` plus the filtered `extraTools`
   - `query({ allowedTools })`

   The prompt cannot advertise a tool the server does not register.
5. **#4447 stays a code-bug check.** Curated profile lists are hardcoded, so an unknown name still throws outside production. Custom lists come from the database. They are intersected with the names the server actually declares under the current env before they reach `onlyTools`. A stale custom name is dropped at runtime and flagged in the drawer. It never trips the throw.
6. **Tool search.** `toolSearchAllowed` is true only for `full`. A new `ToolSearchReason` `profile_static` joins `surface_static`. A per-endpoint tool-search capability (#7429) stays out of scope (§5).
7. **Live query key.** `fingerprint` is a hash of the resolved names, the advertised schema form (compact or not) and the prompt mode, not just the profile label. It goes into the turn binding and `liveQueryKey` (`turnBinding.ts:135`). A custom allowlist edit, or a schema or prompt change, then rebuilds the SDK query on the next turn, the same way a `config_version` change does.

Every registered tool keeps its `TOOL_TIERS` entry and its `WISP_TOOL_SUBJECTS` / `WISP_NON_FOCAL_TOOLS` classification. This feature adds no AI tools, so the chat tool-index byte budget for `full` is unchanged. Constrained prompts get their own budget (§3.4).

### 3.3 Knowing the context window

Three sources feed one **effective window**:

1. **Override:** typed by the operator in the drawer. When set, it is the effective window.
2. **Discovered:** read, when present, from the `/models` payload discovery already fetches. Recognised fields include `context_length` (OpenRouter-style), `max_model_len` (vLLM) and `max_context_length` / `loaded_context_length` (LM Studio). Numbers only, plausibility-bounded like `contextWindow.ts`. No extra endpoint is called in v1 (no Ollama `/api/show`, no llama.cpp `/props`).
3. **Observed:** the window `contextWindow.ts` parses from a rejection. It is persisted as an **expiring observation**, under these rules:
   - It is keyed to the connection's `config_version`.
   - It is fresh for the memo TTL (1 h). After that it remains as a stale hint shown in the drawer, but no longer constrains.
   - The write is best-effort and internal. It uses an atomic compare on offering id, partner id and `config_version`, runs in `withSystemDbAccessContext` after `runOutsideDbContext`, and never runs inside a request transaction. A failure is caught and logged and never fails the turn.

   The in-process memo keeps its role for `max_tokens` capping.

**Effective window** = override, if set. Otherwise the smaller of `discovered` and a fresh `observed`. Otherwise unknown.

A fresh rejection that reports a smaller *serving* limit beats a larger advertised *architectural* maximum. This is the LM Studio case: the model supports 262k, but it is loaded at 8k. A higher precedence for discovery would keep a known failure in place.

`resolveModel` fills `limits.maxInputTokens` from the effective window for gateway offerings, instead of the hardcoded null at `gatewayCandidate.ts:213`. `contextWindow.planRequest` treats it like a memo entry. The first request is then capped up front, and a clearly over-window request is refused before any provider call, using the existing `contextWindowExceededMessage` (#11107).

**`auto` resolution, on the whole request.** Codex's point: fitting the static prefix is not the same as a usable conversation. The very first tool result can be 8,000 characters (`aiToolOutput.ts:71`). The budget therefore counts the whole request:

- **Fixed prefix:** the system prompt and the advertised schemas, measured per profile and per surface. The plan measures them with the `ai:tool-capture` surfaces, using the gateway's bytes/3 estimate, and stores them as code constants (`PROFILE_PREFIX_TOKENS`). A test fails on more than 10% drift.
- **Reserve:** an output allowance (`CONTEXT_MIN_OUTPUT_TOKENS` or more), plus at least two tool results at the profile's `resultCharBudget`, plus page/device context.

`auto` picks the largest profile whose prefix plus reserve is at most `AUTO_FIT_FRACTION` (0.75) of the effective window. `minimal` is the floor. Example, inferred from #9770's 68k figure:

- a 131k window stays `full`
- a 32k window gets `standard`
- an 8k window gets `minimal`

Constrained profiles also lower the per-result budget: `resultCharBudget` is about 2,000 characters for `minimal`, against `MAX_TOOL_RESULT_CHARS` = 8,000 today. Larger results go to the existing artifact capture, so they are bounded, not lost.

If even `minimal` plus its reserve does not fit, the session start says so plainly: "This model's 4,096-token window is too small for Breeze chat tools." It does not wait for the header deadline. Mid-conversation, when accumulated history pushes the request past the window, the existing pre-send refusal ("start a new chat") applies (§5 covers history trimming).

The drawer shows the resolved profile next to `auto`, e.g. "Auto: minimal (window 8,192, observed 12 min ago)". When a profile is set explicitly and the known window cannot hold it, the drawer suggests the profile that fits, as Todd's #9596 comment asked.

### 3.4 Constrained prompt

When `promptMode = constrained` (any profile except `full`):

- **System prompt.** A new compact base, `AI_SYSTEM_PROMPT_COMPACT` (≤ 2 KB), replaces base + tail + diagnosis. It keeps the safety-relevant rules: approvals, never claim an action ran, tenant boundaries, and say plainly when the model cannot do something. The diagnosis section is dropped.
- **Tool index.** It renders the full tool line (`renderDomainBlock`) only for the profile's domains, since the set is small. The always-on vocabulary for absent domains is dropped.
- **Descriptions.** With `compactSchemas`, each tool in a curated profile is advertised with a hand-written `compactDescription` (≤ 200 chars), not its `searchHint`. `searchHint` is documented as "synonyms, not workflow" (`aiTools.ts:197`). Swapping it in would strip the argument and workflow guidance that small models need most. Codex raised this.
  - A contract test requires a `compactDescription` for every tool in a curated `minimal` or `standard` list.
  - Custom-profile tools without one fall back to the full description's first sentence.
- **Schemas.** Purely advisory JSON-schema keywords are stripped from the advertised `input_schema`: `maxLength`, `minLength`, `maximum`, `minimum`, `pattern`, `format`, `examples`, `default`. #9596 reports local chat templates crashing on numeric fields.
  - Enforcement is unaffected: handlers validate with Zod (`aiToolSchemas.validateToolInput`).
  - The gateway must keep validating against the **uncompacted** schema in `matchesToolSchema`. Otherwise compaction would loosen gateway validation. The plan decides where compaction runs and pins the "no loosening" property with a test.
- **Provenance.** Every `ai_invocations` row records the profile and exposure fingerprint it ran with: new nullable `tool_profile` and `tool_exposure_fingerprint` text columns. The quality view can then compare profiles.
- **Window facts on tool-less surfaces.** The script reviewer, office ticket and the rest receive only the window facts (§3.3: `max_tokens` fit and pre-send refusal). Their prompts are unchanged in v1.

### 3.5 Per-surface floors, by tool coverage

Some surfaces cannot work below a capability (#9596 item 4). The floor is set by **required tool coverage, not the profile label**, as Codex refined. A static `SURFACE_REQUIRED_TOOLS` map names, per surface (and per agent run profile), the tools without which the surface cannot do its job. Examples: the script builder's execute and validate tools, and an agent run's outcome tools plus its run-profile minimum.

| Surface | Requirement | When unmet |
|---|---|---|
| `chat`, `office_chat`, `helper` | none beyond `set_device_context` (chat) | Run constrained. Chat may answer from page context with no tool call. |
| `script_builder` | its required declarations, in its own name space | Refuse up front: "This model's tool profile does not include what the script builder needs. Assign a larger model to this surface, or widen the profile." |
| `ai_agents` | the run's outcome tools plus `SURFACE_REQUIRED_TOOLS` for that run profile | Refuse the run up front with the same message, recorded as a run failure reason, not an empty turn. |

The check runs in assignment validation as a warning. It also runs at resolve time as a hard refusal, so a model reassigned to a heavier surface fails clearly.

### 3.6 Verify checks a real tool round-trip, per surface

A new verification stage, `surface_turn`, runs after the two existing stages pass. It runs once per tool-requiring surface the offering is assigned to or permitted on, chat first.

- **The turn.** Each run is one turn through the loopback gateway exactly as production sends it. That means the surface's resolved exposure (names, compact or full schemas) and the matching system prompt.
- **Stub handlers.** Tools are registered with **schema-identical stub handlers**: real names, real advertised schemas, original Zod validation, execution disabled. A deny hook is not used, because a denial reads as an error to the model and proves less. Each stub returns a canned result carrying a random **sentinel**. No tenant data is touched, and verification grants stay org-less.
- **Pass.** The model calls an offered tool with input that passes the original Zod schema, and its final answer contains the sentinel. That proves it consumed the result, matching what today's harness already requires (`providerFidelityHarness.ts:454`).
- **What is recorded.** The prompt tokens the endpoint reported, and `cached_tokens` if the endpoint reports them, so cache reuse is visible (#9770).
- **Storage.** Results are kept per surface:

  ```
  surfaceReadiness[surface] = { passed, exposureFingerprint, endpointFingerprint, version, at, promptTokens, cachedTokens, summary }
  ```

  This record is bound to the exposure fingerprint and has its own `SURFACE_TURN_VERSION`. If the connection or the exposure changes mid-run, the result is discarded (`superseded`), as `offeringVerification.ts` already does for connection changes.

Gating (**recommended, OD-5**):

- `FIDELITY_HARNESS_VERSION` is **not** bumped. A bump would mark every gateway offering stale (`gatewayCapabilities.ts:101`) and turn tools off fleet-wide.
- The base record keeps granting `supportsTools`, exactly as now.
- Eligibility for one surface (`eligibility.ts:88`) additionally refuses the offering on **that surface only** when its `surfaceReadiness` entry is present and failed. A chat failure never disables a working helper or script-builder assignment.
- An absent or stale entry (grandfathered records, or a changed profile) is allowed and shows "Verified (basic). Re-verify to check a real tool round-trip on Chat."

Cost: one turn per surface (a few thousand tokens for `minimal`). For `full` chat it is about the size of a real chat prefix (about 68k tokens, reported), on the partner's endpoint and unledgered (Todd decision 2026-10-02, as now).

### 3.7 Invalid tool calls: measure first, repair later if needed

Today a refused tool-call batch ends the turn with a fixed note (`translateResponse.ts:196-262`). v1 does **not** change that (**recommended, OD-7**). It adds three things:

- a `refused_tool_batch` failure code on the gateway failure notes (`gateway/failureNotes.ts`) and the invocation ledger, so the quality view shows the refused-batch rate per offering and profile
- the refused names (log-safe, already produced by `describeRefusedToolCalls`) in the turn's failure detail
- a user-facing message for constrained profiles: "This model produced a tool call Breeze could not use. Try again, or ask a narrower question." It replaces the generic rephrase advice.

If the measured rate stays high after profiles ship, a follow-up adds **one** repair attempt inside the same gateway request. The attempt is allowed only when no text has been streamed yet: text deltas go out before batch validation (`translateStream.ts:178`), so a later retry cannot cleanly replace what the user saw. It keeps atomic batch validation, shares the request's cancellation and deadline, and sums both attempts' usage. Invalid batches are never forwarded to the SDK as unknown-name calls.

### 3.8 Settings (docs/agents/settings.md rule 9)

- **Home:** Settings → AI → Models → model drawer (`OfferingDrawer.tsx`), a new "Tools and context" section. One home: the connection drawer does not repeat it.
- **Level:** partner, on the model record. There is no org override. Orgs choose models through assignments, and the model's profile comes with it (§7 OD-1).
- **Permission:** edits go through the existing partner registry write gate for offering details. There is no new permission.
- **Resolver:**
  - `resolveToolExposure` for the profile, with one call site per surface entry
  - `resolveEffectiveContextWindow` for the window, called inside `resolveModel`
- **Inheritance control (rule 4):** blank override = inherit. The field shows the effective discovered or observed value and its source and age. Profile `auto` shows what it resolves to, or "capacity unknown".
- **Count of places configured.**

  | Concept | Before | After | Note |
  |---|---|---|---|
  | Tool exposure for chat | 0 UI + 2 instance env switches (`AI_TOOL_SEARCH`, `AI_TOOL_INDEX`) | 1 UI (model drawer) + the same 2 env switches | The env switches are operator kill switches, not settings. Removal plan for `AI_TOOL_SEARCH`: it becomes a per-connection capability under #7429. |
  | Context window | 0 | 1 (model drawer) | |

- **Save pattern:** the drawer's existing Save, wrapped in `runAction`. The section has no URL state.

## 4. Tenancy and data model impact

- **Tables:** no new tables. Seven nullable or defaulted columns are added to `partner_ai_models`, a partner-axis table (shape 3, `breeze_has_partner_access(partner_id)`, plus the existing SELECT-only org branch on enabled rows). Partner-wide first (#2135) is satisfied by construction: the row has no `org_id`.
  - `partner_ai_models` is not in `CORE_ORG_CASCADE_DELETE_ORDER` (`tenantCascade.ts:342` comment) and has no `CORE_TENANT_EXPORT_POLICY` entry (verified by grep). The new columns therefore need no cascade or export registration (Codex concurs).
  - Org-token reads of enabled offerings will see the profile and window. These are not secrets: tool names are public API.
- **`ai_invocations.tool_profile` and `ai_invocations.tool_exposure_fingerprint`** (text, nullable) are added to an org-cascade, append-only table.
  - Both **must** be classified `included` in `CORE_TENANT_EXPORT_POLICY` in the same PR. They are scalar text. A JSON snapshot of the names would have to be `excludedOpen`, and v1 stores none.
  - The suite that checks this runs only under Integration Tests.
  - Adding nullable columns does not conflict with the append-only `REVOKE UPDATE/DELETE` posture.
- **Writes:**
  - Operator edits go through the existing partner registry lock (`inPartnerRegistryWrite`), like every offering write.
  - Discovery writes the discovered window inside its existing sync.
  - The observed-window write is described in §3.3: best-effort, atomic compare on id, partner and `config_version`, system context after `runOutsideDbContext`, never inside a request transaction, and failure-isolated.
- **Migration:** one hand-written, idempotent migration.
  - Columns go in with `ADD COLUMN IF NOT EXISTS`. CHECKs are guarded with `DO $$ … IF NOT EXISTS (pg_constraint) …`.
  - There is no `BEGIN`/`COMMIT`. It writes no rows, so no `breeze.scope` election is needed.
  - It is named to sort after the newest committed migration at PR time (currently `2027-01-22-200300-…`; check, don't assume). Then run `pnpm db:check-drift`.
- **Shared types:** `toolProfile`, `toolAllowlist` and the window facts are added to the registry view types and `offeringDetailsPatchSchema` in `packages/shared`, with UI strings in all 8 locales.

## 5. Out of scope

- Tool search on gateway connections: either a `tool_reference` translation, or a per-endpoint capability that replaces the global `AI_TOOL_SEARCH`. That work is #7429. Constrained profiles make it unnecessary for the small-model case.
- A chat "loader" meta-tool (list domains, then load one). See OD-6.
- A gateway repair retry for invalid tool calls in v1. See §3.7 and OD-7.
- History trimming or compaction for small windows. The Agent SDK owns the transcript, and its auto-compaction threshold for an unknown model is not under our control (not checked). v1 bounds per-result size (§3.3) and relies on the pre-send refusal ("start a new chat"). A follow-up can lower session `maxTurns` for constrained profiles if the quality view shows long sessions failing.
- Frontier-quality answers from small models. Changing anything for first-party Anthropic hosts.
- Per-org overrides of a model's profile.
- Calling extra endpoints (`/api/show`, `/props`) to discover windows.

## 6. Test and rollout notes

- **Red first, pure:** `toolExposure.test.ts` covers:
  - intersection-only, including `extraTools` (a profile or custom list never adds a name, and outcome tools always survive)
  - `auto` thresholds on prefix plus reserve
  - the `full` + unknown window identity: byte-identical to today's registration, prompt and `liveQueryKey`
  - unknown custom names dropped without reaching `onlyTools`
  - a fingerprint change on any change to the custom allowlist
- **Window precedence:**
  - the override wins
  - a fresh smaller observation beats a larger discovered value
  - a stale observation or a changed `config_version` stops constraining
  - a failed observation write never fails the turn
- **Contract tests:**
  - every `minimal` tool has base tier 1 and no action that `aiGuardrails` escalates to a write
  - every curated name is declared, is in `TOOL_TIERS`, and is classified in `WISP_TOOL_SUBJECTS` / `WISP_NON_FOCAL_TOOLS`
  - every curated tool has a `compactDescription` of at most 200 chars
  - the compact base prompt is at most 2 KB, and the `minimal` chat prefix is at most a pinned token target
  - `PROFILE_PREFIX_TOKENS` drifts at most 10% from a fresh measurement
  - `SURFACE_REQUIRED_TOOLS` names only declared tools
- **Regression guard:** the existing W19 index budget tests and `aiAgent.toolIndexPrompt.test.ts` stay green unchanged for `full`.
- **Gateway:**
  - the effective window caps `max_tokens` on the first request
  - compaction does not loosen `matchesToolSchema`
  - a refused batch records `refused_tool_batch`
- **Verify:**
  - `surface_turn` passes only with a Zod-valid call plus the sentinel in the final text
  - it is discarded when the connection or exposure changes mid-run
  - a failed chat readiness refuses chat only, not helper or script builder
  - grandfathered records stay eligible
- **Integration Tests:** the export-policy classification for the two `ai_invocations` columns, and RLS on the new offering columns (org-token reads see enabled rows only, as now).
- **E2E (Playwright, `data-testid`):**
  - set a profile and an override in the drawer
  - `auto` shows its resolution or "capacity unknown"
  - a chat turn on a `minimal` offering advertises only that profile's tools, checked via `ai:tool-capture`
- **Rollout:**
  - The default `auto` with an unknown window is a no-op, so the migration plus resolver ship dark.
  - The first visible change is for gateway offerings whose window becomes known through discovery or observation.
  - Release notes for self-hosters: how to set the window, what each profile includes, and that re-verify now runs a real tool round-trip per surface.
  - The docs page for `AI_TOOL_SEARCH` says an OpenAI-compatible connection is not a Messages-API proxy (promised on #9770).
- **Lab leg:** an 8k-window 3–4B model on LM Studio (the #9596 shape) and a 131k-window model (the #9770 shape) through a wt-stack. Record prompt tokens per profile, whether a tool round-trip completes, and the refused-batch rate. Those numbers decide whether the OD-7 repair follow-up is needed.

## 7. Open Decisions

**Quorum:** Codex `gpt-6-astra`, `xhigh`, read-only, 2026-11-06, run on `origin/main` `bef484ca8b`.

- **Agreed:** the attach point (OD-1) and the `auto` default (OD-2).
- **Disagreed on four points**, each recorded below with both positions: window persistence (OD-4), verification gating (OD-5), the repair retry (OD-7), and the floor rule (OD-8).
- **Unopposed refinements**, folded into §3 without a separate decision:
  - `extraTools` filtering and a full exposure fingerprint in `liveQueryKey` (§3.2)
  - budgeting the whole request and not only the prefix (§3.3)
  - `compactDescription` instead of `searchHint` (§3.4)
  - export classification `included` for the scalar invocation columns (§4)

1. **OD-1: Where the profile and window attach.**
   - A: the offering, i.e. the model record (`partner_ai_models`).
   - B: the connection.
   - C: a partner-wide default.
   - D: the per-surface assignment row.

   **Recommend A.** Capacity belongs to a model on an endpoint. One connection can serve models of very different sizes. Surface differences are already handled by per-surface curated sets inside a profile. Todd committed to A on #9596 and #9770. Codex agrees. B would force one profile on every model behind an endpoint. D would make the operator repeat a model fact once per surface and org.

2. **OD-2: Default for bring-your-own offerings.**
   - A: `auto`. Today's behaviour while the window is unknown. Constrained automatically once a window is known and the full set cannot fit.
   - B: `full`, opt-in only, with a drawer suggestion. This is the wording of Todd's #9596 comment.

   **Recommend A.** A turn that `auto` constrains would otherwise fail anyway: the window is known to be too small. The drawer shows "capacity unknown" when nothing is known. Codex agrees, with the caveat now in §3.1: a window does not prove competence, so an explicit smaller profile stays available.

3. **OD-3: Who curates the tool sets.**
   - A: Breeze curates `minimal` and `standard` per surface in code, and the partner may define `custom` (domains plus extra tools), validated at write and intersected at runtime.
   - B: curated tiers only.
   - C: free-form tool allowlist only (#9770's item 2 alone).

   **Recommend A.** Curated tiers make the common case one click and keep a contract test on what `minimal` means (read-only, compact descriptions). `custom` covers the #9770 operator who knows their workload. Domains are more robust to tool renames than names alone. Codex raised no objection.

4. **OD-4: How a learned window is kept.**
   - **Author's original:** persist the rejection-learned window into one `context_window` column with `source = learned`. Precedence: operator, then discovered, then learned. Only-lowering.
   - **Codex:** keep the override separate from the evidence. Persist *expiring* observations keyed to `config_version` with atomic, failure-isolated writes. Let a fresh smaller observation beat a larger discovered value, since the serving limit can be below the advertised maximum (an LM Studio model loaded at 8k).
   - **Option C:** in-process memo only, as today.

   **Recommend Codex's version, now written into §3.1 and §3.3.** The author's precedence would keep a known failure in place whenever `/models` advertises the architectural maximum. C leaves replicas inconsistent, and `auto` blind on a fresh process.

5. **OD-5: What "Verified" means and what it gates.**
   - **Author's original:** one extra `profile_turn` stage on the chat profile. New verifications need it to reach `verified`. No harness-version bump, old records grandfathered.
   - **Codex:** agrees on no bump and on grandfathering. Disagrees with a global gate: tool support is applied across all tool surfaces (`eligibility.ts:88`), so a chat failure would disable a working helper or script builder. Use per-surface readiness bound to the exposure fingerprint, schema-identical stub handlers instead of a deny hook, and a result sentinel the final answer must contain.
   - **Option C:** bump `FIDELITY_HARNESS_VERSION`. Every gateway offering goes stale and tools turn off until re-verify.

   **Recommend Codex's version, now in §3.6.** It is stricter (the model must consume the result) and narrower (it refuses only the surface that failed). C is a fleet-wide outage for self-hosters at upgrade.

6. **OD-6: How chat reaches tools outside a small profile.**
   - A: a fixed set per profile in v1. The operator widens it with `standard` or `custom`.
   - B: at session start, expand the profile with the page's domains (`pageContextToolDomains`, the closed W19-D3 map), fixed for the session.
   - C: a loader meta-tool (`list_domains` / `load_domain` / `call_tool`), as #9596 proposed.

   **Recommend A for v1, and B as a measured follow-up.** C routes every call through one generic tool, so the pre-tool-use hook, tiering, approvals and audit rows would see `call_tool`, not the real tool. That reopens the authority model this design keeps untouched. B changes the exposure fingerprint per page, which costs the KV prefix cache #9770 cares about. Codex was not asked about B or C separately.

7. **OD-7: Invalid tool calls from small models.**
   - **Author's original:** one gateway repair retry inside the same request, for every gateway request.
   - **Codex:** do not ship it now. Text is streamed before batch validation (`translateStream.ts:178`), so a retry cannot cleanly replace what the user saw. Measure after profiles reduce the catalog. If repair is still needed, allow one retry only before any visible text, and keep atomic validation, shared deadlines and summed usage. Never forward invalid batches to the SDK.
   - **Option C:** forward an unknown-name call to the SDK so its loop returns an error result.

   **Recommend Codex's version, now in §3.7:** measure in v1 (`refused_tool_batch`) and repair as a follow-up only if the lab and quality numbers call for it. C is rejected by both of us: it makes the gateway emit calls it knows are invalid.

8. **OD-8: What makes a surface refuse a model.**
   - **Author's original:** a minimum profile label per surface (`script_builder` and `ai_agents` need at least `standard`).
   - **Codex:** gate on required tool coverage, not the label. A window says nothing about competence, and the script builder has its own declarations.
   - **Option C:** never refuse; run every surface constrained and let it fail.

   **Recommend Codex's version, now in §3.5 (`SURFACE_REQUIRED_TOOLS`).** It refuses exactly when the surface cannot work, including under `custom`. C reproduces the empty turns #9596 reports.
