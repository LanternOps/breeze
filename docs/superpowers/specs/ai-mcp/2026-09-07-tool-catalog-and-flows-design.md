# Tool Catalog (bring-your-own MCP/OpenAPI sources) and AI-Authored Flows: Design

**Date:** 2026-09-07
**Status:** Approved in dialogue (Todd, 2026-09-07). Codex `xhigh` quorum run 2026-09-07: agrees on both structural choices (D1 new tables, D3 in-house expressions), disagrees on four points, all accepted and folded in as **Amendment** call-outs; summary in §11. Awaiting written-spec review.
**Extends:** `2026-08-22-ai-agents-program-and-wave1-design.md` (ai_agents, ai_agent_runs, fan-out, act-mode assets), `2026-08-05-tier3-supervised-four-eyes-split-design.md`, `2026-07-18-action-intents-approval-layer-design.md`, `2026-08-23-per-partner-llm-byok-design.md` (encrypted tenant secrets pattern).
**Tracking:** to be registered via `feature-lifecycle` when the implementation plan is written.

---

## 1. Problem

Breeze's AI (chat, the MCP server, and the triage/patch/helpdesk agents) can only act inside Breeze: the catalog is the ~189 tools registered in code. An MSP lives in five to ten systems: a PSA, a documentation tool, an identity stack, a distributor, a backup vendor. The moment a workflow touches one of those, Breeze has no answer, and the MSP either keeps a separate automation product (Rewst, n8n, Zapier) or drops the workflow.

What MSPs use those products for, in order of frequency: user onboarding and offboarding across M365, the PSA, the RMM, documentation, and MFA; ticket enrichment, dedupe, assignment, and auto-close; license and billing reconciliation; self-service forms with approval; alert to remediation to ticket lifecycle; documentation sync. Breeze covers the Breeze-internal slice of each and none of the cross-vendor slice.

Two gaps, in priority order:

1. **Reach.** There is no way for a partner to give Breeze's AI a tool it did not ship with.
2. **Repeatability.** Once the AI can do something across systems, there is no way to make it happen the same way every time without a human in chat and without paying tokens per run. The existing `automations` engine has a closed set of six action types and cannot call catalog tools; the AI agents re-decide every run.

## 2. Goals

- A partner (or an org) registers an external **MCP server** or an **OpenAPI spec** with a credential, and its tools join the catalog with the same tier gating as core tools. Chat, agents, the flow validator, and (scope-permitting) Breeze's own MCP server see them immediately.
- A tech describes a workflow in chat; the AI emits a **flow document**; the tech reads it, sets approval behaviour per sensitive step, and enables it. The runner then executes it deterministically, with zero tokens per run unless the flow contains an explicit AI step.
- Tier 3 steps pause the run in the existing approval inbox (web and mobile) and resume on approval. A per-step "pre-approved" opt-in exists only for steps bound to a named asset, mirroring `ai_agents.actAssets`.
- Enabled flows with declared inputs become catalog tools themselves (`flow.<slug>`), callable from chat and by agents.
- Everything is dual-owned (org XOR partner) per Partner-Wide First, with RLS, cascade, org-merge, and export-policy obligations met in the same PRs that create the tables.

## 3. Non-goals, and why each is a bet

This section is load-bearing. Each exclusion is a product position, not a deferral.

| Not building | Because |
|---|---|
| A connector library (per-vendor integrations maintained by Breeze) | MCP and OpenAPI let vendors and the community publish the connector. Breeze consumes; it does not maintain 100 integrations. Rewst's moat becomes a commodity. |
| A visual canvas / node editor | The AI writes the document from a sentence; the step list is the review surface. A canvas exists to help humans author; here humans review. Can be layered on later without changing the document. |
| Branching beyond `when:` and for-each (joins, loops, sub-flows) | Where a flow needs judgment, that is an `ai` step, not graph edges. Deterministic spine, bounded AI where needed. Keeps the runner a loop over an array. |
| Syncing external data into Breeze tables (warehouse, reports, joins) | A flow fetches what it needs on demand via read tools and materialises what matters (a ticket link, a tag). A sync engine per connector is a separate product. |
| Making every run an LLM run ("AI playbooks") | Cost scales with fleet not with the problem; two runs on identical input may differ; you cannot unit-test a prompt; a Tier 3 pause 400 times a night is the alternative. The existing agents cover the unstructured cases and are unchanged. |
| A new automation UI paradigm alongside `automations` forever | Legacy automations convert mechanically to flows in the final wave (§10) and the old worker retires. Two engines is a transition, not a destination. |

## 4. What exists today (verified 2026-09-07)

- **Registry.** `apps/api/src/services/aiTools.ts` (`AiTool`: `definition`, `tier 1|2|3|4`, `handler(input, auth, ctx)`, `deviceArgs`), map instance in `aiToolNames.ts`, ~41 `registerXTools` domain files. Tier semantics in `aiGuardrails.ts`. Parity tests (`aiToolsRegistryParity.test.ts`) require a Zod schema (`aiToolSchemas.ts`) and a `TOOL_PERMISSIONS` entry per name; these assume a closed, static name set.
- **MCP server.** `routes/mcpServer.ts` reuses the registry (`getToolDefinitions`, `executeTool`, `getToolTier`), filters by API-key scope (`ai:read | ai:write | ai:execute | ai:execute_admin`), resolves execution org via `routes/mcpExecutionOrg.ts`. No MCP client library is a dependency of `apps/api`; the server is hand-rolled.
- **Extensions.** `packages/extension-sdk/src/server.ts` registers AI tools in the same shape; core-name collision is refused.
- **Automations.** `db/schema/automations.ts`: dual-owned; `trigger jsonb` (`schedule|event|webhook|manual`), `conditions`, `actions jsonb` with six fixed types (`run_script|send_notification|create_alert|execute_command|deploy_software|ai_triage`), `onFailure`; `automation_runs`, `automation_run_device_results`, `automation_resource_bindings`; worker `jobs/automationWorker.ts` executes actions per targeted device (per-device fan-out model, not step sequencing).
- **AI agents.** `db/schema/aiAgents.ts`: `ai_agents` (kind, mode, toolAllowlist, triggers, actAssets), `ai_agent_runs` (status incl. `awaiting_approval`), `ai_agent_schedules` + `jobs/aiAgentSweepScheduler.ts` (partner baseline / org override cron, per-org fan-out).
- **Approvals.** `db/schema/actionIntents.ts` (`pending_approval|approved|executing|completed|failed|rejected|expired|cancelled`, source `chat|mcp_api|ai_agent`), `db/schema/approvals.ts` (`approval_requests`, inbox at `routes/approvals.ts`, mirrored to mobile).
- **Events.** `services/eventBus.ts` (`EventType` union incl. `alert.*`, `device.*`, `script.*`, `patch.*`, `policy.*`), durable subscribers via `eventSubscriberRegistry.ts` (`DurableEventSubscriber { id, eventTypes, handler, retry }`).
- **Secrets.** `services/secretCrypto.ts` (`encryptSecret`/`decryptSecret` with AAD, key rotation) plus `services/encryptedColumnRegistry.ts` (`EncryptedColumnSpec`, `columnAad(spec, rowId)`, re-encryption sweep). The row-bound pattern to copy is `services/partnerLlmConfig.ts:59` (`encryptPartnerLlmApiKey`), stored in a `*_encrypted text` column.
- **SSRF / egress.** `services/urlSafety.ts`: `assertSafeUrl`, `safeFetch`, `safeFetchFollowingRedirects`, `createGuardedHttpAgents`, `isAlwaysBlockedIp`. Already streaming-capable and test-hookable (`__setLookupForTests`).
- **Agent principal.** `services/aiAgents/agentAuthContext.ts`: agents run as their own principal with an org-scoped `DbAccessContext` whose `userId` is always null, and `assertRunOwnership` enforces org-agent ⇒ same org, partner-agent ⇒ org under partner. `services/aiAgents/actRevalidation.ts` re-authorises per-script act assets at execution time; `services/actionIntents/policyDecidable.ts` defines which Tier 3 tools/actions may be policy-approved (four-eyes actions never).
- **Event dispatch.** `eventBus.ts:340`: durable BullMQ ingress is behind `eventDispatchMode()`, default `off` (in-process delivery only).
- **MCP Tier 3.** `routes/mcpServer.ts:1201` unconditionally denies approval-required tools over Breeze's MCP server (`isMcpApprovalRequired`); Tier 3 is a chat/agent path, not an MCP path.
- **Partner-wide gating.** `services/partnerWideAccess.ts` `canManagePartnerWidePolicies(auth)`.
- **Prior art.** No spec or plan mentions flows, workflow engine, tool catalog, Rewst, n8n or Zapier. Greenfield.

## 5. Piece 1: Tool sources (the catalog becomes tenant-extensible)

### 5.1 Concept

Every catalog entry has a `source`: `core`, `extension`, `mcp`, `openapi`. The first two stay code-registered at boot. The last two are tenant data. A **resolver** presents the union to every consumer.

### 5.2 Data model

`tool_sources` (dual-owned, shape 3/1 dual-axis)

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| org_id | uuid null fk organizations | XOR with partner_id (`tool_sources_one_owner_chk`) |
| partner_id | uuid null fk partners | |
| slug | text | namespace prefix; `^[a-z][a-z0-9_]{1,31}$`; unique per owner; may not equal a reserved core prefix |
| name | text | display |
| kind | enum `mcp` \| `openapi` | |
| endpoint_url | text | MCP: server URL (streamable HTTP). OpenAPI: spec URL, or null when `spec_document` is uploaded |
| spec_document | jsonb null | uploaded OpenAPI document (openapi kind only) |
| base_url_override | text null | openapi kind: overrides `servers[0]` |
| auth_kind | enum `none` \| `bearer` \| `api_key_header` \| `basic` \| `oauth2_client_credentials` | |
| auth_config_encrypted | text null | `encryptSecret` with `columnAad(TOOL_SOURCE_AUTH_SPEC, row.id)`; spec registered in `encryptedColumnRegistry.ts` so rotation sweeps cover it (pattern: `partnerLlmConfig.ts`); JSON of the credential fields for `auth_kind` |
| credential_origin | text | scheme+host[:port] the credential may be sent to; derived from `endpoint_url` / `servers[0]` / `base_url_override` at save time and pinned (§5.5) |
| auth_fingerprint | text null | `hmacFingerprint` of the secret for change detection without decrypting |
| status | enum `active` \| `error` \| `disabled` | |
| last_discovered_at | timestamptz null | |
| last_error | text null | redacted |
| created_by_user_id | uuid fk users | |
| created_at / updated_at | timestamptz | |

`tool_source_tools` (owner ids denormalised from the source so RLS stays direct dual-axis)

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| source_id | uuid fk tool_sources on delete cascade | |
| org_id / partner_id | uuid null | copied from source; same XOR check |
| name | text | raw tool name / operationId |
| qualified_name | text | `<slug>.<name>`; unique per owner |
| description | text | from the source; truncated to 2k chars |
| input_schema | jsonb | JSON Schema from MCP `inputSchema` or synthesised from OpenAPI parameters + requestBody |
| output_schema | jsonb null | MCP `outputSchema` if present; OpenAPI 2xx response schema if present |
| annotations | jsonb | MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`); OpenAPI `{ method, path, operationId }` |
| proposed_tier | smallint | 1 or 3 (see 5.3) |
| tier | smallint | effective; 1, 2 or 3; never 4 |
| enabled | boolean default false | |
| discovered_at / removed_at | timestamptz | soft-remove when a re-discovery no longer lists the tool; an enabled tool that disappears flips the source to `error` with a message rather than silently vanishing from flows |

### 5.3 Discovery and tier proposal

Triggered on create, on credential change, and by an explicit "re-discover" action. Runs as a BullMQ job so the UI is not blocked.

- **MCP:** `initialize` then `tools/list` (paginated). `readOnlyHint: true` and not `destructiveHint` → propose 1. Otherwise propose 3.
- **OpenAPI 3.x:** parse, dereference `$ref` (local refs only; remote refs rejected). One tool per operation. `GET`/`HEAD` → propose 1. Everything else → propose 3. Operations without `operationId` get a synthesised name from method + path. Specs over 5 MB or over 2,000 operations are rejected with a message.
- Tier 2 is never proposed; a tech sets it by hand.
- All discovered tools start `enabled = false`. UI offers "enable all reads" and per-tool toggles. The AI may *suggest* which tools to enable given a stated goal; it may not enable them.
- **Amendment (quorum):** descriptions and annotations from a source are untrusted input. They are stored and shown as text, passed to the model as tool descriptions with a fixed prefix naming the source, and never interpreted as instructions to Breeze. Re-discovery never lowers an effective tier: if a tool's proposed tier drops, the effective tier stays and the row is flagged `review_needed`; if the proposal rises to 3, the effective tier is raised immediately and the source is flagged. A changed `input_schema` bumps the tool's `revision` (§5.4).

### 5.4 Resolver

`resolveCatalog(auth): Promise<ToolDescriptor[]>` in a new `services/toolCatalog.ts`.

**Amendment (quorum): the unit of resolution is an immutable descriptor, not a name.** Following the seam extensions already use (`extensions/contributionRegistry.ts:68` freezes definition and compiled validator together):

```ts
interface ToolDescriptor {
  name: string;                 // 'run_script' | 'hudu.get_asset' | 'flow.new_user'
  revision: string;             // content hash of definition+tier+policy; stored on intents and run steps
  source: 'core' | 'extension' | 'mcp' | 'openapi' | 'flow';
  ownerRef: { partnerId: string | null; orgId: string | null } | null;  // null for core/extension
  definition: Anthropic.Tool;
  validate: (input: unknown) => ValidationResult;   // compiled once
  tier: 1 | 2 | 3 | 4;
  approvalPolicy: 'none' | 'supervised_self' | 'four_eyes';
  permission: PermissionRequirement;                 // what TOOL_PERMISSIONS holds today
  deviceArgs?: readonly string[]; assetArgs?: readonly string[];
  execute: (input, auth, ctx) => Promise<string>;
}
```

Listing, authorization (guardrails), execution, and approval release all take a descriptor. An `action_intent` stores `tool_revision`; release re-resolves and refuses on mismatch (§6.5 drift).

- Static part: today's registry (`aiToolNames` map + extension contributions), wrapped into descriptors at boot.
- Tenant part: enabled `tool_source_tools` whose source is `active` and whose owner is visible to `auth`: the caller's org, plus partner-wide sources when `auth.scope === 'partner'` or when the caller's org belongs to the partner (partner-wide rows are visible to org callers; this is the read direction, so app-layer dual-axis `orgCondition OR (org_id IS NULL AND partner_id = auth.partnerId)` is fine, and the RLS policy grants it via `breeze_has_partner_access` for partner tokens and via an org-membership clause for org tokens; §8).
- Tenant *metadata* (descriptors) cached per owner with a short TTL and explicit invalidation on any `tool_sources`/`tool_source_tools` write. **Authorization is never cached:** each call recomputes visibility and permission from `auth` against the descriptor, and dispatch re-reads `enabled`/`status` so a disabled tool or source is refused immediately.
- Consumers: chat tool list, agent allowlist validation, MCP server `tools/list` and `tools/call`, flow validator, `flow.<slug>` registration.
- Name rule: tenant tools always contain a dot; core and extension tools never do, so the dot alone prevents collision with them. Reserved slugs: `flow`, `core`, `breeze`, every extension id, and, for an org-owned source, any slug already used by a partner-wide source visible to that org (otherwise the org could shadow its partner's tools).

### 5.5 Execution

`executeTool` learns a second path: when the name contains a dot, dispatch to `services/toolSourceExecutor.ts`.

- **MCP:** streamable-HTTP client, `tools/call`, structured result preferred, text content otherwise. One connection per call in v1 (no session pooling); sessions are cheap and the failure modes are simpler.
- **OpenAPI:** map input fields to path, query, header, cookie parameters and request body per the operation; serialise per spec; send; parse JSON or return text.
- Both: credentials injected server-side from `auth_config_encrypted`; OAuth2 client-credentials tokens cached per source until expiry. Timeout 30 s. Response cap 1 MB, then truncated with a marker. Redaction pass over the model-visible output for the source's own credential values and common secret shapes.
- **Egress guard: reuse `services/urlSafety.ts`** (`assertSafeUrl` + `safeFetchFollowingRedirects` with `createGuardedHttpAgents`), not a new module. It already resolves every A/AAAA answer and blocks loopback, RFC1918, link-local, ULA and metadata ranges. Additions: HTTPS required; at most 3 redirects, same-host only; `TOOL_SOURCES_ALLOW_PRIVATE_EGRESS=true` passes `allowPrivate` through the existing options for self-hosted deployments and is refused at boot when `IS_HOSTED=true`.
- **Credential origin pinning (quorum):** a source's credential is attached only to requests whose scheme+host[:port] equals `credential_origin`. OpenAPI `servers[]` entries and `base_url_override` must match it; remote `$ref`s are rejected at discovery; a redirect to another host is followed without the credential or not at all.
- Audit: every tenant-tool call goes through the same `executeTool` path as core tools, so the existing tool audit and the MCP execution ledger record source id, qualified name, redacted input, tier, and approver.

### 5.6 Guardrails and permissions for tenant tools

**Amendment (quorum): four places hard-code the closed name set and must consume the descriptor instead** (each is a unit-tested change in W1):

1. `aiGuardrails.ts` ~1265: `getToolTier(name) === undefined` ⇒ tier 4 deny. Becomes descriptor lookup via the resolver.
2. `aiGuardrails.ts` ~1804: `resolveToolPermissionRequirements` denies when `TOOL_PERMISSIONS[name]` is absent. Becomes `descriptor.permission`, where dotted names carry the generic policy below.
3. `aiAgentSdk.ts` ~503: chat rejects any tool missing from static `TOOL_TIERS`. Becomes descriptor lookup.
4. `mcpExecutionOrg.ts` ~94: `deviceArgs` lookup is core-only. Becomes `descriptor.deviceArgs`.

Unchanged on purpose: `mcpServer.ts`'s `isMcpApprovalRequired` gate (Tier 3 tenant tools are denied over Breeze's MCP server exactly like core Tier 3 tools; flows and chat are the Tier 3 paths), and the API-key transport ceilings in `apiKeyScopes.ts`.

- Generic permission policy for dotted names: tier 1 → `ai:read` scope (API key) or the `ai.use` permission (user); tier 2/3 → `ai:write` / `ai.write`. Tier 3 additionally goes through the action-intent approval path exactly as core Tier 3 tools do, with `approvalPolicy = 'supervised_self'` (a tenant tool is never four-eyes in v1 and never policy-decidable, §6.3).
- **Known limitation (quorum, bite #3):** Breeze RLS cannot constrain what a partner-wide credential can reach in the external system. A partner-wide Hudu key used from org A's context can fetch org B's Hudu data if the flow or the model asks for it. Mitigations in v1: the add-source form warns in plain words that a partner-wide source exposes every customer's data in that vendor to every org's chat and flows; per-org sources are recommended when the vendor scopes credentials by tenant; every call is audited with the calling org. This is documented, not solved.
- Parity tests: `aiToolsRegistryParity.test.ts` keeps asserting the static set; a new `toolCatalogResolver.test.ts` asserts the generic policy applies to every dotted name and that no static tool contains a dot.
- Rate limits: per-source per-minute cap (default 120 calls), configurable on the source, enforced in `checkToolRateLimit`.
- `MCP_EXECUTE_TOOL_ALLOWLIST` (production allowlist for Breeze's own MCP server) gains a `tenant:*` entry meaning "dotted names permitted"; default off in hosted until the feature flag flips.
- Feature flag: `TOOL_SOURCES_ENABLED` (env) gates the routes and UI; `FLOWS_ENABLED` gates piece 2.

### 5.7 Routes and UI

Routes (`routes/toolSources.ts`, mounted under `/api/v1/tool-sources`):
`GET /`, `POST /` (`ownerScope: 'organization' | 'partner'`), `GET /:id`, `PATCH /:id` (schema derived via `.partial().omit({ ownerScope: true })`), `DELETE /:id`, `POST /:id/discover`, `GET /:id/tools`, `PATCH /:id/tools/:toolId` (tier, enabled), `POST /:id/tools/bulk` (enable all reads), `POST /:id/tools/:toolId/test` (Tier 1 only; runs the tool with supplied input and returns the redacted result).

UI: **Settings → Integrations → Tool Sources** page: list with owner badge ("All orgs"), add-source form with create-only owner selector (pattern: `apps/web/src/components/software/PolicyForm.tsx`), source detail with discovery results table (name, description, proposed tier, tier select, enabled toggle, last used), test-call drawer. Mutations via `runAction`.

## 6. Piece 2: Flows

### 6.1 Flow document (v1)

Stored as `flows.definition jsonb`; validated by a Zod schema in `packages/shared/src/validators/flows.ts` and by the catalog-aware validator on the API (§6.3).

```jsonc
{
  "version": 1,
  "name": "Disk cleanup with escalation",
  "description": "…",
  "trigger": { "type": "event", "event": "alert.triggered", "filter": { "alertType": "disk_space", "deviceRole": "server" } },
  "inputs": [ { "name": "ticketBoard", "type": "string", "required": false, "description": "…" } ],
  "steps": [
    { "id": "cleanup", "tool": "run_script",
      "input": { "scriptId": "8b2c…", "deviceIds": ["{{trigger.device.id}}"] },
      "approval": "pre_approved", "onFailure": "stop", "timeoutSec": 900 },
    { "id": "wait", "tool": "wait", "input": { "minutes": 5 } },
    { "id": "recheck", "tool": "get_device_metrics",
      "input": { "deviceId": "{{trigger.device.id}}", "metric": "disk_free_pct" } },
    { "id": "ticket", "when": "steps.recheck.output.value < 10", "tool": "halo.create_ticket",
      "input": { "clientId": "{{trigger.org.externalIds.halo}}", "summary": "Disk still low on {{trigger.device.hostname}}" } },
    { "id": "resolve", "when": "steps.recheck.output.value >= 10", "tool": "resolve_alert",
      "input": { "alertId": "{{trigger.alert.id}}" } }
  ]
}
```

Step fields: `id` (`^[a-z][a-z0-9_]{0,31}$`, unique), `tool` (catalog name), `input` (object; values may contain templates), `when` (expression), `forEach` (`{ items, as, maxItems ≤ 500, concurrency ≤ 10 }`), `approval` (`default` | `pre_approved`), `onFailure` (`stop` | `continue`; default `stop`), `timeoutSec` (default 300, max 3600).

Built-in step tools (registered in core, Tier 1, only meaningful inside flows): `wait` (minutes ≤ 1440; implemented as a delayed re-enqueue, never a sleeping worker), `set` (compute a value from templates for later steps), `ai` (question, tool allowlist, required JSON output schema; runs a bounded agent turn under the flow's budget and returns structured output; the only step that costs tokens), `notify` (existing notification channels), `http_request` (generic; goes through the egress guard; Tier 3 unless method is GET).

Triggers:

| type | fields | wiring |
|---|---|---|
| `schedule` | `cron`, `timezone` | BullMQ repeatable job per enabled flow; partner-wide flows enqueue one run per active org of the partner (mirrors `aiAgentSweepScheduler`) |
| `event` | `event` (an `EventType`), `filter` (equality map over payload paths) | one `DurableEventSubscriber` `flows.event-trigger` for `'*'` that indexes enabled event flows by type and owner; publishes runs |
| `webhook` | none authored; Breeze issues `POST /api/v1/flows/:id/webhook` and a secret | `X-Breeze-Signature: sha256=<hmac>` over raw body, 5-minute timestamp window, replay cache; or `?token=` for systems that cannot sign (documented as weaker) |
| `manual` | `inputs` declared at flow level | UI form; `flow.<slug>` tool; `POST /api/v1/flows/:id/run` |

### 6.2 Templating and expressions

`{{ path }}` inside any string value. Roots: `trigger`, `inputs`, `steps.<id>.output`, `steps.<id>.status`, `item` (inside for-each), `flow` (`id`, `name`, `orgId`), `now` (ISO). Path grammar: identifiers, `.`, `[n]`. A string that is exactly one template yields the referenced value with its type preserved; otherwise the value is stringified into the surrounding text.

`when` and `forEach.items` are expressions in a small in-house grammar (`packages/shared/src/flows/expr.ts`, ~200 lines, exhaustive tests): literals (string, number, boolean, null), paths as above, `== != < <= > >=`, `&& || !`, `in`, and three functions: `length(x)`, `exists(path)`, `lower(s)`. No other calls, no property access on functions, no prototype traversal (paths are resolved against plain data via own-property lookup only). Semantics fixed here so the LLM and the tech read the same thing: a missing path and an explicit `null` both evaluate to `null` (`exists(path)` tells them apart); a skipped step has `status == 'skipped'` and `output == null`; `in` is array membership only (no substring); comparisons involving `null` are `false`; `==` is strict, no coercion. Bounds: AST depth 32, 10,000 evaluation nodes per expression, rendered value 256 KB, forward references rejected at validation. Evaluation is total and deterministic. (Deterministic expressions do not make external tool results deterministic; that is what the run ledger is for.)

### 6.3 Validation at save (and at enable)

The API validator (`services/flowValidator.ts`) runs against the owner's resolved catalog:

1. Every `tool` exists and is enabled for the owner; `flow.<slug>` self-reference is refused.
2. `input` is checked against the tool's JSON Schema with template placeholders treated as `unknown`; the same input is re-validated after rendering at run time.
3. Step ids unique; every `steps.<id>` reference points to an earlier step; `item` only inside for-each.
4. **Amendment (quorum):** `approval: pre_approved` is allowed only when the step's tool/action is **policy-decidable** per `services/actionIntents/policyDecidable.ts` (four-eyes tools and actions can never be pre-approved; a policy is a mechanism, not a second human), **and** the tool declares an asset-binding field (`assetArgs`, e.g. `run_script.scriptId`, `deploy_software.catalogItemId`), **and** that field is a literal. Enabling records an **effect binding** for the step: asset id plus content digest (the `actRevalidation.ts` pattern for scripts). At run time the binding is revalidated; drift fails the step with `binding_drift` and never executes. Tenant tools may not be pre-approved in v1.
5. Effective tier of the flow = max step tier; recorded on the row for list badges and for `flow.<slug>` registration.
6. Partner-wide flows may only reference partner-wide or core assets (scripts, notification channels), never an org's asset; reuses the ownership check `automation_resource_bindings` performs today.
7. Enabling re-runs validation, and additionally checks the enabling user holds every permission the steps need (`checkToolPermission` per step, as if in chat).

### 6.4 Data model

`flows` (dual-owned)

| column | notes |
|---|---|
| id, org_id / partner_id (XOR), slug (unique per owner), name, description | |
| definition jsonb, definition_version int | version increments on every save; runs pin the version they started with |
| effective_tier smallint | |
| status enum `draft` \| `enabled` \| `paused` \| `disabled` | `paused` is system-set (enabling user disabled, source in error, budget exhausted) and carries `paused_reason` |
| enabled_by_user_id, enabled_at | permission principal for runs |
| created_by_user_id, ai_session_id null, managed_by_agent_id null | provenance |
| webhook_secret_encrypted text null, webhook_token_fingerprint | webhook trigger only |
| created_at, updated_at | |

`flow_runs`

| column | notes |
|---|---|
| id, flow_id fk, org_id **not null**, partner_id null | a run always belongs to exactly one org |
| definition_version int | |
| trigger_kind enum `schedule` \| `event` \| `webhook` \| `manual` \| `tool` | `tool` = invoked as `flow.<slug>` |
| trigger_payload jsonb, inputs jsonb | redacted before storage |
| status enum `queued` \| `running` \| `awaiting_approval` \| `completed` \| `failed` \| `cancelled` \| `expired` | |
| current_step_id text null, current_item_index int null | resume cursor |
| dedupe_key text null | unique per flow while status in (queued, running, awaiting_approval) |
| action_intent_id uuid null | the intent the run is parked on |
| started_at, finished_at, error text null | |
| triggered_by_user_id null, parent_run_id null | manual/tool provenance; agent-invoked runs record the agent run via parent fields |

`flow_run_steps`

| column | notes |
|---|---|
| id, run_id fk on delete cascade, org_id (denormalised), step_id text, item_index int null | |
| tool text, tier smallint | |
| status enum `pending` \| `running` \| `awaiting_approval` \| `completed` \| `failed` \| `skipped` | |
| rendered_input jsonb, output jsonb, error text null | redacted; output capped at 256 KB with truncation marker |
| approval_request_id uuid null, approved_by_user_id null | |
| started_at, finished_at, duration_ms | |

### 6.5 Runner

`jobs/flowRunner.ts`, queue `flow-runs`, job data `{ runId }`, concurrency 10 per worker.

1. Load run + flow definition at the pinned version. Set `running`.
2. From `current_step_id`, for each step: evaluate `when` (skip → `skipped`); render input; validate against tool schema; if `forEach`, expand items and process with the declared concurrency, one `flow_run_steps` row per item.
3. Guardrails per (step, item): `checkToolPermission` for the enabling user, `checkToolTier`, per-source rate limit, flow budget (§6.7).
4. Tier 3 and not pre-approved: create an `action_intent` (source `flow`, new enum value) and an `approval_request` whose card reads "Flow *name*, step *id*: *tool*" with the rendered input; set run and step to `awaiting_approval`, store the cursor, return. The approval decision handler (existing) re-enqueues the run on approve, sets `failed` with `error='rejected'` on deny, and the existing expiry sweep sets `expired` after `FLOW_APPROVAL_TTL_HOURS` (default 24).
5. Execute via `executeTool` (same path as chat). On error: `onFailure: stop` → run `failed`; `continue` → step `failed`, next step. Transient errors (network, 5xx, 429) on Tier 1 steps retry 3× with backoff; mutating steps never auto-retry.
6. `wait` steps re-enqueue the job with a delay and return.
7. After the last step: `completed` (or `failed` if any step failed and stop/continue semantics produced a failure). Publish `flow.run.completed | failed` events for downstream use.

**Identity and tenancy (Amendment, quorum D4: flow principal, not enabling-user delegation).** A run executes as a **`flow` principal** modelled on `aiAgents/agentAuthContext.ts`: an org-scoped `DbAccessContext` with `orgId = run.org_id`, `partnerId`, and `userId` always null. Tool execution never runs under `SYSTEM_DB_ACCESS_CONTEXT` (system scope grants every axis, `db/index.ts:180`); the runner uses a brief system read only to load the flow row, its sources, and partner-wide inheritance before opening the org-scoped context. Ownership is asserted like `assertRunOwnership`: org flow ⇒ `run.org_id == flow.org_id`; partner flow ⇒ `org.partner_id == flow.partner_id`. External I/O never happens inside a DB transaction.

Authorization is split in two: at **enable time** the enabling user must hold every permission the steps require (this is the delegation decision, recorded with `enabled_by_user_id`); at **run time** the checks are policy checks, not user checks: flow still `enabled`, definition version pinned, every step's `tool_revision` still matches the resolver, effect bindings intact, source `active`, org still under the partner. The enabling user leaving does not stop runs; it is recorded, and an admin can re-enable under a new delegator. `action_intents` gains `requesting_flow_run_id` as a fourth mutually-exclusive actor (`action_intents_one_actor_chk` extended by a new migration) and `source = 'flow'`. The enabler may approve their own flow's `supervised_self` steps; four-eyes steps require a different human, unchanged.

**Checkpointing and unknown outcomes (quorum, bite #1).** Before calling a tool, the runner writes the `flow_run_steps` row as `running` with idempotency key `(run_id, step_id, item_index, attempt)`; after the call it writes output and advances the cursor in one transaction. If a worker dies mid-call, the resumed run finds a `running` row: for a Tier 1 step it retries; for a Tier 2/3 step it marks the step `unknown_outcome`, fails the run with that reason, and notifies, because re-executing a mutation whose outcome is unknown is worse than stopping. Cancellation (`POST /flows/:id/runs/:runId/cancel`) is checked between steps and before each for-each item.

**Drift on resume (quorum, bite #2).** A run parked in `awaiting_approval` re-validates before continuing: pinned definition version, each remaining step's `tool_revision`, effect bindings, source status. Any mismatch ⇒ `failed`, `error = 'drift'`, notify. Approving stale work never executes new work.

**Loop prevention.** `flow_runs.chain_depth` starts at 0; a run started by an event that a flow run published inherits `depth + 1`; depth > 3 is refused. A flow may not subscribe to its own `flow.run.*` events.

**Execution org for device-less triggers.** `schedule`: org flow ⇒ that org; partner flow ⇒ one run per active org. `manual`/`tool`: org flow ⇒ that org; partner flow ⇒ caller supplies `orgId` and must be able to access it. `webhook`: org flow ⇒ that org; partner flow ⇒ the trigger declares `orgResolver: { path, externalIdKind }` resolved through org external ids; unresolvable ⇒ a `failed` run with `error = 'org_unresolved'` so the miss is visible.

**Event delivery prerequisite.** The event trigger registers a `DurableEventSubscriber`; it is only offered when `eventDispatchMode() !== 'off'` (durable BullMQ ingress). In `off` mode delivery is in-process and at-most-once, so the UI shows the event trigger as unavailable with the reason. `dedupe_key = event:<eventId>` makes redelivery idempotent.

Limits: 50 steps per flow; 500 items per for-each; run wall-clock 1 h excluding time parked in approval; one concurrent run per flow with `dedupe_key` derived from the trigger (`alert:<id>`, `webhook:<delivery-id>`, `schedule:<occurrence>`, `manual:<uuid>`); per-owner queued-run cap 1,000.

### 6.6 Flows as tools

On enable, a flow with `manual` trigger registers `flow.<slug>` in the resolver for its owner: description from the flow, input schema from `inputs`, tier = `effective_tier`. Calling it requires the caller to hold the flow's effective-tier permission (so a Tier 3 flow is itself Tier 3 for the caller) and to have access to the target org. The run still executes as the flow principal: the caller gains exactly what the enabler authorised for that flow and nothing else of the enabler's authority. It creates a run with `trigger_kind = tool`, returns the run id immediately, and (in chat) the AI can poll `get_flow_run`. Agents may include `flow.*` names in `toolAllowlist`.

### 6.7 Budgets and observability

- `ai` steps draw from the owner's existing AI budget (per-partner budgets and alerts already exist); a flow with an `ai` step cannot be enabled if the owner has no budget.
- Per-flow monthly run cap (default 10,000) and per-owner cap, both configurable; exceeding sets `paused` with reason and notifies the owner via the notification channel chosen on the flow.
- Runs page shows each run as a checklist: step, tool, tier, status, duration, approver, expandable rendered input/output.

### 6.8 Authoring (AI) and UI

New core AI tools (all Tier 1 except `run_flow`, which inherits the flow's tier, and `enable_flow`, which is Tier 3):
`draft_flow` (natural-language description → validated document saved as `draft`, returns the document plus the validator's per-step tier summary), `validate_flow`, `list_flows`, `get_flow`, `run_flow`, `get_flow_run`, `explain_flow_run` (turns the step ledger into prose), `suggest_tools_to_enable` (reads a goal and the disabled tools of the owner's sources, returns a suggestion; never enables).

Chat renders a **Flow card** for `draft_flow` results: name, trigger, steps with tool + tier + approval mode, "Review and enable" link to the web page.

Web: nav item **Flows** (under Automation): list (owner badge, status, effective tier, last run), detail (read-only step list; per Tier 3 step a toggle "Pre-approve this step" shown only when §6.3 rule 4 allows it; trigger panel with webhook URL/secret reveal + rotate; inputs form for manual flows; enable / pause / disable), runs tab (checklist view), "Convert from automation" (wave 6). All mutations via `runAction`.

Approvals: the existing inbox and mobile cards work unchanged; the card body gains the flow context line.

## 7. Legacy `automations` conversion (final wave)

**Amendment (quorum): conversion is semi-mechanical, not mechanical.** Three gaps: (a) `create_alert` has no core tool today (`manage_alerts` only lists, acknowledges, resolves, suppresses; `aiToolsAlerts.ts:70`), so W6 adds a `create_alert` core tool first; (b) legacy actions treat *queued* as success (`automationRuntime.ts:1075` returns `{success, log}` with no structured output), so converted steps carry `awaitCompletion: false` to preserve behaviour and the Flows UI flags them for review; (c) legacy deployment runs as a batch *after* the per-device sequence (`automationRuntime.ts:2349`), so the converter emits `deploy_software` after the for-each, not inside it. Mapping otherwise: `run_script`, `send_notification` → `notify`, `create_alert`, `execute_command`, `deploy_software`, `ai_triage` → `ai`. A converter maps `automations.trigger` → `flows.trigger`, `conditions` → a `when` on the first step, `actions[i]` → `steps[i]` with `onFailure` from the automation, and `target` (device selector) → a first step `find_devices` followed by `forEach` over its output. Conversion is opt-in per automation from the UI, creates a `draft` flow alongside the automation, and the automation is disabled only when the tech enables the flow. A parity test runs each fixture automation through both engines and diffs the resulting side effects. After a release with zero enabled automations in hosted, the automation worker is retired and the tables are frozen (kept for history; not dropped).

## 8. Tenancy, security, repo-contract obligations

**Tables and shapes.** `tool_sources`, `tool_source_tools`, `flows` are dual-owned (org XOR partner, `_one_owner_chk`, one dual-axis policy `system OR breeze_has_org_access(org_id) OR breeze_has_partner_access(partner_id)`, plus the read clause allowing an org token to see its partner's partner-wide rows, exactly as `automations` and `ai_agents` do). `flow_runs`, `flow_run_steps` have `org_id NOT NULL` (shape 1). Register all five in `DUAL_AXIS_TENANT_TABLES` / auto-discovered shape-1 as appropriate in `rls-coverage.integration.test.ts`.

**Cascade and lifecycle.** All five into `CORE_ORG_CASCADE_DELETE_ORDER` (alphabetical, FK children before parents: `flow_run_steps` < `flow_runs` < `flows`; `tool_source_tools` < `tool_sources`), into `orgMergeRegistry.ts` policies (repoint owner; runs repoint), and into `CORE_TENANT_EXPORT_POLICY`: `auth_config_encrypted`, `webhook_secret_encrypted` → `excludedSensitive`; `auth_fingerprint`, `webhook_token_fingerprint` → `reviewedIncluded`; every jsonb (`definition`, `input_schema`, `output_schema`, `annotations`, `trigger_payload`, `inputs`, `rendered_input`, `output`, `spec_document`) → `excludedOpen`.

**Cross-reference tenancy.** A flow's references to scripts, catalog items, notification channels and devices are validated for ownership at save and enable (the `automation_resource_bindings` check), not trusted because a UUID FK exists.

**`action_intents` change.** New column `requesting_flow_run_id uuid null` + `source` enum value `flow`; `action_intents_one_actor_chk` is dropped and re-created with four exclusive actors in a new idempotent migration (the table is shipped; never edit its original migration).

**Migrations.** Named to sort after the newest committed file (`2026-09-27-…` as of 2026-09-07), idempotent, policies in the same file as the table, `set_config('breeze.scope','system')` form for any DML, run `migrationRlsScope.test.ts`.

**Secrets.** `secretCrypto` domain `tool_source_auth` and `flow_webhook`; credentials never returned by any route (fingerprint only); never included in model-visible text; redaction pass on tool outputs.

**Egress.** §5.5 guard for tenant tools and `http_request`; refused when `IS_HOSTED=true` and private egress is requested.

**Webhooks in.** HMAC + timestamp window + replay cache; body size cap 1 MB; per-flow rate limit; a leaked secret is rotated from the UI and the old secret is rejected immediately.

**Tier 4.** Tenant tools cannot be Tier 4 and cannot be pre-approved; `ai:execute_admin` is never required or granted by anything in this design.

**Partner-wide readers in org contexts.** The event-trigger subscriber and the schedule tick run in system context and fan out per org, per the heartbeat probe-config pattern; an org-scoped RLS context never needs to see partner-wide flows.

## 9. Testing

- **Unit (Test API job):** expression grammar (every operator, null semantics, prototype-pollution attempts, depth limits); renderer (type preservation, nested templates, missing paths); OpenAPI → tools generator on three fixture specs (petstore, a Halo-like spec with `operationId` gaps, a spec with remote `$ref` that must be rejected); MCP client against an in-process fake streamable-HTTP server (list, call, structured vs text results, timeouts, oversize responses); egress guard (each blocked range, redirect rules, self-hosted flag vs `IS_HOSTED`); flow validator (each rule in §6.3 red then green); runner state machine (pause on Tier 3, resume on approve, deny, expire, `wait` re-enqueue, for-each with a failing item under stop and continue, dedupe collision, disabled enabling user → paused); resolver (dotted-name policy, cache invalidation, visibility matrix org/partner).
- **Integration (needs Postgres):** `toolSourcesPartnerRls.integration.test.ts` and `flowsPartnerRls.integration.test.ts` (cross-partner forge 42501, XOR 23514, org isolation, partner-wide fan-out creates one run per org); RLS coverage, tenant cascade, org-merge, export-policy and erasure round-trip contract suites; event-trigger subscriber against the real event bus.
- **E2E (Playwright, data-testid):** register a fake MCP source, enable a read tool, ask chat a question that uses it; draft a flow in chat, open the card, enable it with one pre-approved step, fire the trigger, approve the Tier 3 step in the inbox, read the completed run checklist.

## 10. Waves

| wave | scope | proves |
|---|---|---|
| W1 | `tool_sources`/`tool_source_tools` + migrations + RLS/cascade/export registration; MCP discovery + executor; resolver wired into chat, agents, MCP server; egress guard; Tool Sources UI | an MSP connects an MCP server and uses its tools in chat with correct tiers and approvals |
| W2 | OpenAPI source kind (parser, generator, executor, fixtures) | vendors with only a REST API are reachable |
| W3 | flow document schema (shared Zod), expression grammar + renderer, `flows` table, validator, `draft_flow`/`validate_flow`/`get_flow` tools, Flow card, Flows read-only UI | the AI produces a valid, reviewable flow from a sentence |
| W4 | `flow_runs`/`flow_run_steps`, runner, manual + schedule + event triggers, approval pause/resume, pre-approval rule, runs UI, `run_flow`/`get_flow_run`/`explain_flow_run` | a flow runs end to end with a human tap on the sensitive step |
| W5 | webhook trigger, `flow.<slug>` as tool, for-each concurrency, `ai`/`http_request` steps, budgets and caps | cross-system and external-event flows; agents can call flows |
| W6 | automations converter, worker retirement gate | one engine |

Each wave is a feature-lifecycle sub-issue; W1/W2 are independent of W3+, and W3 can start once W1's resolver exists.

## 11. Codex quorum

Codex `xhigh` (gpt-6-astra, read-only, 2026-09-07) was asked five questions with the author's positions stated. Every citation it gave was re-read in source before acceptance.

| # | Question | Codex | Outcome |
|---|---|---|---|
| D1 | Extend `automations` vs new flow tables | **Agree: new tables.** Confirms the worker's per-device fan-out model (`automationRuntime.ts:2256`, deployment batched after at `:2349`, actions return `{success, log}` with no dataflow at `:1075`). Disagrees that the runner is "~300 lines" and that conversion is mechanical. | Accepted: §6.5 checkpointing/unknown-outcome/cancellation/drift; §7 semi-mechanical with three named gaps. |
| D2 | Tenant-aware resolver in front of the map | **Agree on the resolver, refine the seam:** resolve an immutable descriptor (identity, revision, validator, tier/approval policy, permission, executor), as `contributionRegistry.ts:68` already does; four hard-coded closed-set checks will break otherwise; use `partnerLlmConfig.ts` + `encryptedColumnRegistry` for credentials; reuse `urlSafety.ts:543`; pin credential origins; treat annotations as untrusted; never auto-lower tiers; cache metadata not authorization. | Accepted in full: §5.2, §5.3, §5.4, §5.5, §5.6. |
| D3 | In-house expression grammar vs library | **Agree**, rejecting line count as the justification; specify null/missing/skipped semantics, membership, typing, bounds. | Accepted: §6.2. |
| D4 | Runs as system context scoped to org, enabling user as permission principal | **Disagree.** Agents run as their own principal with org-scoped context and `userId = null` (`agentAuthContext.ts:39`); automations run with no caller context (`automationRuntime.ts:849`); "system context scoped to org" is a contradiction (`db/index.ts:180`). Named-asset pre-approval needs effect binding + live revalidation (`actRevalidation.ts:455`) and can never cover four-eyes actions (`policyDecidable.ts:211`). | Accepted: **flow principal** replaces enabling-user delegation (§6.5); pre-approval restricted to policy-decidable actions with effect bindings (§6.3); `action_intents` fourth actor (§8); `flow.<slug>` invocation authz (§6.6). |
| D5 | Repo-contract obligations | **Agree on shapes**; adds: cross-reference tenancy beyond FKs, `PARENT_FK_JOIN_POLICY_TABLES` exists as an alternative to denormalising (we keep denormalising so children stay dual-axis), event dispatch mode defaults off (`eventBus.ts:340`), loop/feedback prevention, webhook replay. | Accepted: §6.5 event prerequisite + loop prevention, §8 cross-reference tenancy. |

Codex's top three implementation risks, each now addressed in the text: remote success followed by worker death before checkpoint (§6.5 unknown outcome); approved revisions drifting before resume (§6.5 drift); partner-wide credentials reaching another customer's data in the external system (§5.6 known limitation, UI warning, per-org recommendation).
