---
tracking_issue: LanternOps/breeze#7598
---

# AI Model Registry: plan index and cross-wave contract

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-30-ai-model-registry-design.md` (v3; decisions §15 approved 2026-09-30). The spec is authoritative for behaviour. This index is authoritative for **names**: every wave plan uses exactly the identifiers below, so plans written in parallel stay consistent.

## Waves

| Wave (sub-issue) | Plan file | Depends on | Plan status |
|---|---|---|---|
| W0 | — (issue #7587, PR #7593) | — | shipped as an interim fix; not part of this feature's sub-issues |
| W01 (#7599) platform catalog, discovery, derivation | `2026-09-30-ai-model-registry-w01-platform-catalog.md` | W0 merged | detailed (18 tasks) |
| W02 (#7600) schema + backfill + compatibility (no routing change) | `2026-09-30-ai-model-registry-w02-schema-backfill.md` | W01 merged | detailed (18 tasks; Codex xhigh schema pass done; W03-required changes R1–R6 applied) |
| W03 (#7601) resolver + cost/funding cutover | `2026-09-30-ai-model-registry-w03-resolver-cutover.md` | W02 merged **and** LanternOps/breeze-billing#24 (idempotent credit deduct) deployed | detailed (20 tasks; Codex high review applied: 12 adopted, 1 partial) |
| W04 (#7602) settings UI + usage page | `2026-10-01-ai-model-registry-w04-settings-ui.md` | W03 (implemented **stacked on the W03 branch**); **ship in the same release as W03** (W03 freezes the legacy reviewer / Office / agent-allowlist editors' effect on routing until W04 replaces them) | detailed (17 tasks; Codex high review applied: 18 adopted, 3 of them modified, 0 rejected; no migration) |
| W05 (#7603) SDK-resume spike → chat picker + switching | `2026-10-01-ai-model-registry-w05-chat-picker-switching.md` (spike: `specs/ai-mcp/2026-10-01-ai-model-registry-w05-resume-spike-findings.md`) | W03 + W04 merged (mounts into W04's `routes/aiModels/index.ts`) | detailed (15 tasks; Codex high review applied: 21 adopted, 2 of them modified, 0 rejected; 3 migrations `2026-11-22-1000xx`) |
| W06 (#7604) BYO OpenAI-compatible | `2026-10-01-ai-model-registry-w06-openai-compatible.md` | W03 + W04 merged (extends W04's `/ai/models` routes and Connections card) | detailed (18 tasks; Codex high review applied: 16 adopted, 1 partial); defines the shared loopback model gateway W07 extends |
| W07 (#7605) Bedrock / Vertex / Foundry | `2026-10-01-ai-model-registry-w07-cloud-providers.md` | W06 merged | **deferred 2026-10-01: needs Bedrock/Vertex/Foundry test accounts; #7605 blocked:upstream.** Plan: detailed (14 tasks; Codex high review applied: 10 adopted, 0 rejected); lab gates L1–L8 need real cloud accounts (Todd) |
| W08 (#7606) cleanup | `2026-10-02-ai-model-registry-w08-cleanup.md` | W04, W05 (shipped in a release before W08a), W06 merged; W08a ships one release before W08b; prod preflight gates G1/G2 (Todd) | detailed (15 tasks in 2 PRs: W08a code removal, W08b archive + drop; Codex high review applied: 14 adopted, 3 of them modified, 0 rejected; migration `2026-11-28-100000-ai-model-registry-legacy-drop.sql`) |
| W09 (#7607) failover + escalation | `2026-10-01-ai-model-registry-w09-failover-escalation.md` | W03 **and** W04 merged (it extends W04's assignment writes and Defaults card) | implemented (PR #7775; migrations `2026-12-02-100000-ai-model-registry-failover.sql` + `2026-12-02-100010-…-validate.sql`) |
| W10 (#7608) chargeback | `2026-10-01-ai-model-registry-w10-chargeback.md` | W03 merged (implemented on `main`, not stacked; touches no W04 file) | detailed (21 tasks; Codex high review applied: 15 adopted, 2 of them modified, 1 as documentation; migrations `2026-11-26-100000…100400`) |
| W11 (#7609) quality view + prompt profiles | `2026-10-02-ai-model-registry-w11-quality-profiles.md` | W03 + W04 merged (or stacked on W04's branch); reads W05/W09 data when merged and degrades without it | detailed (13 tasks; Codex high review applied: 8 adopted, 1 of them modified, 0 rejected); migrations `2026-11-27-100000…100100` |

Waves W04–W11 get their detailed plans when the wave starts. They consume interfaces W01–W03 define, and a plan written against interfaces that haven't shipped yet goes stale. Each later-wave plan must re-read this contract plus the merged code.

## Cross-wave contract (names are binding)

### Tables (columns per spec §5)
`ai_platform_models` · `partner_ai_connections` · `partner_ai_models` · `ai_model_assignments` · `ai_invocations`. Plus new columns on `ai_sessions` (`offering_id`, `offering_partner_id`, `effort` → stored inside `options`, see below) and on the AI agent policy model field (`offering_id`, `offering_partner_id`).

Correction to spec §5.6 for naming consistency: `ai_sessions` gets `options jsonb NULL` (an `OfferingOptions`), not a bare `effort` column.

### Shared package (`packages/shared`)
- `src/validators/aiModelOptions.ts`:
  - `offeringOptionsSchema` (zod) → `type OfferingOptions = { effort?: EffortLevel; thinkingDisplay?: 'omitted' | 'summarized' | 'updates'; speed?: 'standard' | 'fast' }`
  - `EFFORT_LEVELS = ['low','medium','high','xhigh','max'] as const`, `type EffortLevel`
  - `optionSupportSchema` → `type OptionSupport = { effort: EffortLevel[]; thinkingDisplay: ('omitted'|'summarized'|'updates')[]; speed: ('standard'|'fast')[]; inferenceGeo: string[] }`
  - `optionRatesSchema` → `type OptionRates = Partial<Record<'speed:fast', ModelRates>>`
  - `type ModelRates = { inputCentsPerM: number; outputCentsPerM: number; cacheReadCentsPerM: number; cacheWriteCentsPerM: number }`
- `src/constants/aiSurfaces.ts`:
  - `AI_SURFACES = ['chat','helper','script_builder','script_reviewer','office_chat','office_ticket','ai_agents','catalog_enrichment','extension_content','patch_test'] as const`, `type AiSurface`
  - `AI_SURFACE_ROLES: Record<AiSurface, readonly string[]>` (every surface has `'default'`; `ai_agents` also has `'triage' | 'analysis' | 'remediation'`)
  - `TOOL_REQUIRING_SURFACES = ['chat','helper','script_builder','ai_agents','office_chat'] as const`

### API services (`apps/api/src/services/aiModels/`, a new directory; a thin `index.ts` re-exports)
| File | Exports | Wave |
|---|---|---|
| `capabilities.ts` | `type ThinkingMode = 'adaptive'\|'budget'\|'none'\|'unknown'`; `deriveCapabilities(raw: unknown): DerivedCapabilities` (`{ thinkingMode, effortLevels, supportsTools, supportsVision }`) from the raw Models API `capabilities` tree | W01 |
| `wireParams.ts` | `buildWireParams(input: { thinkingMode: ThinkingMode; optionSupport: OptionSupport; requested: OfferingOptions; inferenceGeo?: string \| null; maxTokens: number }): WireParams` where `WireParams = { thinking?: {type:'adaptive', display?: string} \| {type:'enabled', budget_tokens:number} \| {type:'disabled'}; effort?: EffortLevel; speed?: 'fast'; inferenceGeo?: string; betas: string[]; applied: OfferingOptions }`. The single owner of thinking/effort wire mapping; **replaces W0's `services/aiModelThinking.ts`** (W01 deletes it and repoints its callers) | W01 |
| `platformModels.ts` | `listPlatformModels()`, `getPlatformModelByModelId(id)`, `upsertDiscoveredPlatformModel(apiModel)`, `updatePlatformModelAdmin(id, patch)`, `getPlatformDefaultModel()`, `type PlatformModel` | W01 |
| `discovery.ts` | `discoverAnthropicModels(apiKey: string \| undefined): Promise<AnthropicModelInfo[]>`, `syncPlatformModels(): Promise<SyncReport>` (W01), `syncConnectionModels(connectionId)` (W03) | W01 / W03 |
| `pricing.ts` | `type RateSnapshot = { source: 'platform'\|'offering'\|'catalog'\|'linked_platform'; standard: ModelRates; option?: { key: 'speed:fast'; rates: ModelRates } }`; `priceInvocation(rate: RateSnapshot, tokens: TokenComponents, applied: OfferingOptions): number` (cents, 6dp); `type TokenComponents = { input: number; output: number; cacheRead: number; cacheWrite: number }` | W01 introduces; W03 makes it the only cost path |
| `connections.ts` | `listConnections(partnerId)`, `getConnection(id)`, `createConnection(...)`, `decryptConnectionKey(conn)` | W02 |
| `offerings.ts` | `listOfferings(partnerId, opts?)`, `getOffering(id)`, `enableOffering(...)`, `type Offering` | W02 |
| `assignments.ts` | `getEffectiveAssignment({ partnerId, orgId, surface, role }): EffectiveAssignment` (tighten-only merge, spec §5.4) | W02 |
| `invocationLedger.ts` | `recordInvocation(row: NewInvocation): Promise<string>`, `type NewInvocation` (fields per spec §5.5) | W02 (written alongside the legacy path) / W03 (sole path) |
| `resolveModel.ts` | `resolveModel(input: ResolveModelInput): Promise<ResolveModelResult>`, signature per spec §9 | W03 |

### Routes
- `routes/admin/aiModels.ts` → `/admin/ai-models` (platform admin + MFA, mirrors `routes/admin/llmProviderCatalog.ts`). **W01.**
- `/ai/provider` keeps its contract and moves onto the new store in **W02**.
- `/ai/models` (partner offerings / assignments / connections API) → **W04**.

### Jobs
BullMQ queue `ai-model-discovery`, worker `jobs/aiModelDiscoveryWorker.ts` (the repo's `jobs/` convention, per W01). The connection sync uses job name `sync-connection` with jobId `sync-connection-{id}`; BullMQ rejects colon ids. Repeatable daily job `sync-platform` (W01), on-demand `sync-platform` (admin "Refresh"), and `sync-connection` / jobId `sync-connection-{id}` (W03).

### Web
- `apps/web/src/components/admin/AiModels.tsx` + page `/admin/ai-models` (W01).
- The partner tab `PartnerAiProviderTab.tsx` is renamed and rebuilt in W04.

### Invariants every wave keeps
1. No `'claude-` model literal outside `ai_platform_models` seed migrations, test fixtures and `aiModel.ts` bootstrap fallback. W03 adds the contract test.
2. `buildWireParams` is the only place a thinking/effort/speed param is built.
3. Migrations sort after the newest **committed** migration at commit time (`git ls-tree --name-only origin/main apps/api/migrations | sort | tail -1`), and use `YYYY-MM-DD-HHMMSS-slug.sql`. Every file that writes rows elects system scope first.
4. Every new `org_id` table → cascade order, merge registry, export policy, RLS coverage in the same PR (CLAUDE.md table).
5. Platform-key traffic is never priced from a non-platform rate. A model with no resolvable rate is never dispatched (spec §8).

## Index additions
Each wave plan ends with an "Index additions" table listing the names it introduced beyond this contract (e.g. W01 `modelWireOptions.ts`, `platformModelAdmin.ts`; W02 `legacyProjection` / `legacyReconcile`, `parity/*`, `legacyCostEvents`; W03 `eligibility`, `candidateLoader`, `transport`, `connectionFactory`, `turnBinding`, `settleInvocation`, `refusals`, `registryCutover`). Those tables are binding for later waves, the same as this file. W03's Preconditions table (P1–P15) records how it aligned to W01/W02's real names.
