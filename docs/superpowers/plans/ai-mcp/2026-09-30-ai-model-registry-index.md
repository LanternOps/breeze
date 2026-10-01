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
| W02 (#7600) schema + backfill + compatibility (no routing change) | `2026-09-30-ai-model-registry-w02-schema-backfill.md` | W01 merged | detailed (18 tasks; Codex xhigh schema pass done) |
| W03 (#7601) resolver + cost/funding cutover | `2026-09-30-ai-model-registry-w03-resolver-cutover.md` | W02 merged | detailed (19 tasks) |
| W04 (#7602) settings UI + usage page | written at `start_wave` | W03 | outline (spec §11) |
| W05 (#7603) SDK-resume spike → chat picker + switching | written at `start_wave` | W03 (W04 for admin enablement UX) | outline (spec §9.2, §11) |
| W06 (#7604) BYO OpenAI-compatible | written at `start_wave` | W03 | outline (spec §6, §12) |
| W07 (#7605) Bedrock / Vertex / Foundry | written at `start_wave` | W03 | outline (spec §4, §12) |
| W08 (#7606) cleanup | written at `start_wave` | W04, W05 | outline |
| W09 (#7607) failover + escalation | written at `start_wave` | W03 | outline (spec §5.4, §9.1) |
| W10 (#7608) chargeback | written at `start_wave` | W03 | outline (spec §8) |
| W11 (#7609) quality view + prompt profiles | written at `start_wave` | W03, W04 | outline (spec §5.5, §7) |

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
