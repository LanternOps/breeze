---
tracking_issue: LanternOps/breeze#7598
---

# AI Model Registry W04: settings UI, `/ai/models` API and the AI-usage breakdown — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Closes #7602

**Goal:**
- A partner admin manages every AI model decision in one place: **Partner Settings → AI Providers & Models**. That covers connections, residency, the models techs may use, and defaults per feature.
- An org can narrow those defaults on **Org Settings → AI → Model defaults**.
- **Settings → AI Usage** shows spend and refusals by model, surface, tech and org, read from `ai_invocations`.
- The three legacy model editors that W03 stopped routing on are gone:
  - the Office PolicyEditor allowed-models list;
  - the script reviewer's free-text model field;
  - the agent `allowed_models` allowlist, which has no editor and is DB-only.

**Architecture:**
- **One API family, `/ai/models`.** It has one route file per resource under `routes/aiModels/`, plus a snapshot `GET /ai/models` that returns everything the partner tab renders in one round trip.
- **Write logic lives in new services, never in routes.** The services are `offeringWrites.ts`, `assignmentWrites.ts`, `connectionSettings.ts` and `residency.ts`. Each one:
  - calls W03's `ensurePartnerCutover(partnerId)` first;
  - reuses W03's `checkEligibility` rule table for every gate (through one neutralising wrapper, `checkEnableEligibility`, never a second copy);
  - maps every DB failure through the one scrubber, `safeDbError.ts`.
- **Connection credential flows delegate to the existing services.** Connect, rotate, switch endpoint and disconnect all run through `partnerLlmConfig.ts`, which W03 Task 6B made registry-native. W04 adds no second implementation of the key probe, the catalog consent check or the offering remap.
- **The UI follows spec §11's save patterns exactly:**
  - row drawers with Save for connection and offering details;
  - autosave plus a toast for the residency switch and the offering enable switch;
  - a card-level Save/Discard footer ("page Save") for Defaults by feature and for the org Model defaults card.
- **Usage page.** It keeps its existing stat cards and adds a breakdown card fed by `GET /ai/models/usage`.

**Tech Stack:** Hono, Drizzle ORM on PostgreSQL (RLS), zod in `packages/shared`, Astro + React islands, `react-i18next` (8 locales), Vitest (unit + real-Postgres integration), Playwright (`data-testid` only).

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-30-ai-model-registry-design.md` (v3):
- §5.2–§5.5 (columns this wave edits or reads);
- §8 (price precedence, "a non-platform offering with no resolvable price can't be enabled");
- §9 (eligibility, reused at write time);
- **§11 (the contract for this wave)**;
- §12 (permissions);
- §13 (W04 row);
- §15 (#1 "rate shown at enable time", #2 user choice, #7 fast mode behind `required_permission`).

**Names** come from `docs/superpowers/plans/ai-mcp/2026-09-30-ai-model-registry-index.md` and the W01–W03 "Index additions" tables, which are binding.

**Out of scope (and what W04 leaves room for):**
- **The chat model picker, option controls in the composer, thinking progress, session switching and the agent-policy picker (W05).** W04 adds no chat or agent UI. `GET /ai/models` is partner-admin-scoped; W05 adds its own user-scoped "my permitted offerings" read.
- **Creating `openai_compatible` connections, manual model entry and harness verification for BYO endpoints (W06).**
  - The Connections card renders a list and dispatches on `kind`, so W06 adds a kind, not a card.
  - `connectionCreateSchema` is a discriminated union on `kind` with one arm (`anthropic_byok`) in W04.
- **Bedrock / Vertex / Foundry (W07).** Same extension point as W06.
- **Dropping `partner_llm_configs`, `ai_budgets.allowed_models`, `ai_script_policies.reviewer_model`, `client_ai_org_policies.allowed_models`, the `/ai/provider` routes and `partner_ai_connections_compat_uq` (W08).**
- **Escalation roles and the failover list (W09).**
  - Assignment writes accept `role: 'default'` only. The schema is `z.enum(['default'])` with a comment naming W09.
  - Writes **preserve** `fallback_offering_ids` / `fallback_may_cross_funding` untouched. They are never in a W04 payload, and the upsert's `SET` list omits them.
  - The Defaults card renders one row per surface, keyed by `(surface, role)`, so W09 adds role sub-rows without reshaping state.
- **Chargeback (W10)** and the quality view (W11). The usage endpoint's `groupBy` enum is the extension point.

---

## Preconditions from W03

W03 (#7601) is being implemented on `feature/7598-ai-model-registry/wave-7601`. **This wave is implemented stacked on that branch**: base `feature/7598-ai-model-registry/wave-7602` on the W03 head as soon as W03's PR is open, and target the W03 branch until W03 merges, then retarget `main`.

When this plan was written (2026-10-01), W03 had no pushed commits. The names below come from the W03 plan's Task 2, 3, 6, 6A, 6B, 9, 11, 16 and its Index additions.

**Before Task 1, the executor checks each row against the W03 branch head.** Where W03 code exists, **it wins over this table**: change only the adapter named in the right-hand column, and record the difference in the PR body.

| # | What W04 consumes | Source | If it differs, adapt only |
|---|---|---|---|
| Q1 | `services/aiModels/eligibility.ts`:<br>• `checkEligibility(c: CandidateFacts, ctx: EligibilityContext): ResolveFailureReason \| null` (pure; rule order: owner → enabled/lifecycle → platform offered/lifecycle → dispatchable kind → connection active/key usable → catalog usable → rate → tools → permission → plan (hosted, platform rows only) → residency).<br>• Types `CandidateFacts`, `EligibilityContext`, `ResolveFailureReason` (9 codes plus `registry_unavailable` from Task 6A), `PartnerPlan`, `planSatisfies`. | W03 Task 2, 6A | `eligibility.ts` `checkEnableEligibility` (Task 3) |
| Q2 | `services/aiModels/candidateLoader.ts`:<br>• `loadOfferingCandidate(offeringId, partnerId): Promise<LoadedCandidate \| null>` (null = missing or foreign; facts are filled even for disabled offerings and unusable connections);<br>• `loadPartnerFacts(partnerId): Promise<{ plan: PartnerPlan; residencyRequired: boolean }>`;<br>• `readOrgPartnerId(orgId)`;<br>• `LoadedCandidate` (`facts`, `offeringId`, `connectionId`, `displayName`, `logicalModel`, `funding`, `capabilities`, `optionSupport`, `optionRates`, `defaultOptions`, `allowedOptions`, `refusalFallbackOfferingId`, `limits`). | W03 Task 2 | `offeringWrites.ts`, `registryView.ts` |
| Q3 | `services/aiModels/transport.ts`: `defaultTransport(surface)`, `transportCarries(transport): { speed; inferenceGeo; thinkingDisplayUpdates }`. | W03 Task 3 | `residency.ts` |
| Q4 | `services/aiModels/resolveModel.ts`: `unavailableMessage(reason, displayName?)`; `PLATFORM_ONLY_SURFACES = ['patch_test']`. | W03 Task 3 | `registryView.ts`, `surfaceLabels.ts` |
| Q5 | `services/aiModels/registryCutover.ts`: `ensurePartnerCutover(partnerId): Promise<boolean>`. It **resolves `false`** when the cutover cannot complete; it captures the error itself and does not throw (W03 plan L4978-4986). The `/ai/provider` facade maps `false` to `503 'AI configuration is being upgraded. Try again in a moment.'`. W04 treats a rejection the same as `false`. | W03 Task 6A, 6B | `routes/aiModels/shared.ts` `registryWrite` |
| Q13 | `candidateLoader.ts` reads through its **own** system transaction (`runOutsideDbContext(() => withSystemDbAccessContext(...))`, W03 L1110-1112). It therefore **cannot see rows the request transaction has written but not committed.** W04 never loads a candidate for a row it inserted in the same request (Task 4 `ensurePlatformOffering`). | W03 Task 2 | Task 4 |
| Q14 | Rate rules in the loader (W03 L1262-1271):<br>• an offering with its own prices has **no** `optionRates` (fast is unselectable on it);<br>• a BYOK offering with no own price inherits the linked platform row's rates and fast rate. | W03 Task 2 | Task 4 `validateOptions` |
| Q15 | `getPlatformInferenceGeo(): string \| null` (env `AI_PLATFORM_INFERENCE_GEO`). The effective geo is `conn.inferenceGeo ?? platformGeo` (W03 L1292, L1421). | W03 Task 2 | Task 8 `registryView.ts` |
| Q6 | `services/partnerLlmConfig.ts` (registry-native after W03 Task 6B; contract unchanged):<br>• `savePartnerLlmKey({ partnerId, apiKey, userId }) → { last4, model, verifiedAt, configVersion }` (probe, then first connect or same-kind rotate);<br>• `updatePartnerLlmEndpoint({ partnerId, catalogEntryId, acknowledgeDataNote, userId })`;<br>• `deletePartnerLlmConfig(partnerId) → boolean`;<br>• `PartnerLlmError(message, status)`. | merged + W03 Task 6B | `routes/aiModels/connections.ts` |
| Q7 | `jobs/aiModelDiscoveryWorker.ts`: `enqueueConnectionSync(connectionId): Promise<void>` (job `sync-connection`, jobId `sync-connection-${id}`). | W03 Task 16 | `routes/aiModels/connections.ts` |
| Q8 | `packages/shared/src/constants/permissions.ts`: `PERMISSION_GRANTS.AI_MODELS_PREMIUM = { resource: 'ai_models', action: 'premium' }`, seeded and granted to no role. | W03 Task 2 | `AI_MODEL_REQUIRED_PERMISSION_CHOICES` (Task 1) |
| Q9 | `packages/shared/src/types/index.ts` `PartnerSettings.ai?: { residencyRequired?: boolean }`. **W03 adds the type and the reader only, no writer.** | W03 Task 2 | `residency.ts` |
| Q10 | W03's `ai_invocations` rows are written with `ledgerMode: 'authoritative'`. Refused legs have `stopReason: 'refusal'`, and turns served by a refusal fallback have `fallbackUsed: true`. W02 shadow rows (`ledger_mode = 'shadow'`) were never billed. | W03 Task 6 | `usageQueries.ts` |
| Q11 | W03 Task 17's AST contract test allowlists `apps/web/src/components/clientAi/PolicyEditor.tsx` for its `'claude-…'` literals ("W04 (#7602) replaces it"). | W03 Task 17 | Task 15 Step 6 |
| Q12 | W03 Task 11 / Task 9: the reviewer and Office session create no longer read `reviewer_model` / `allowedModels`. `scriptProposals/policy.ts` still merges `reviewerModel` into the read API. | W03 Task 9, 11 | Task 15 |

Merged W01/W02 names used directly (verified on `origin/main` `02fd9abd76`):
- `services/aiModels/offerings.ts`: `listOfferings`, `getOffering`, `enableOffering`, `offeringPriceSource`, `OfferingWriteError('not_found'|'unpriced')`, `type Offering`.
- `services/aiModels/connections.ts`: `listConnections`, `getConnection`, `getCompatConnection`, `createConnection`, `ConnectionKeyError`, `type PartnerAiConnection`.
- `services/aiModels/assignments.ts`: `getEffectiveAssignment`, `mergeEffectiveAssignment`, `clampOrgOptions`, `isPermitted`, `EffectiveAssignment`, `PermittedSet`, `AssignmentMergeWarning`.
- `services/aiModels/safeDbError.ts`: `carriesQueryValues`, `safeDbErrorDetail`, `formatSafeDbErrorDetail`, `errorSqlstate`.
- `services/aiModels/platformModels.ts`: `listPlatformModels`, `getPlatformModelById`, `type PlatformModel`.
- `services/aiModels/capabilities.ts`: `deriveCapabilities`.
- Drizzle `partnerAiConnections`, `partnerAiModels`, `aiModelAssignments` (`db/schema/aiModelRegistry.ts`), `aiInvocations` (`db/schema/aiInvocations.ts`).
- Shared: `AI_SURFACES`, `AiSurface`, `AI_SURFACE_ROLES`, `TOOL_REQUIRING_SURFACES`, `offeringOptionsSchema`, `OfferingOptions`, `EFFORT_LEVELS`, `THINKING_DISPLAYS`, `MODEL_SPEEDS`, `INFERENCE_GEO_PATTERN`, `modelRatesSchema`, `ModelRates`.

## Global Constraints

- **Rigor: medium (spec §13), with high-rigor carve-outs.** Every task is TDD: write the assertion, watch it fail for the stated reason, then implement. The authz matrix tests (Task 8, Task 9) and the tenancy integration suite (Task 10) are mandatory, because this wave adds the first tenant-facing write routes on the registry tables.
- **No migration.** W04 adds no table, column, constraint or permission. `partner_ai_connections_compat_uq` (one `anthropic_byok`/`catalog` connection per partner) **stays**:
  - it excludes `openai_compatible`, so W06 is not blocked;
  - `getCompatConnection`, the `/ai/provider` facade and W03's `compatRemap` all depend on it;
  - W08 drops it with the facade.

  If any task turns out to need a migration, stop and record an open question. Do not invent schema. Any migration would use slot `2026-11-21-100000-…` onward, to sort after W03's `2026-11-19-*`; re-check `git ls-tree --name-only origin/main apps/api/migrations | sort | tail -1` at commit time.
- **Gates (spec §12).**
  - **Partner-level registry writes** (connections, offerings, partner assignments, residency) use:
    - `requirePermission(BILLING_MANAGE)`;
    - `requireMfa()`;
    - a handler check `auth.partnerId` + `canManagePartnerWidePolicies(auth)`, returning 403 with `PARTNER_WIDE_WRITE_DENIED_MESSAGE`.

    This is exactly the `/ai/provider` gate, plus MFA on every write, because each one changes cost or destination.
  - **Partner reads** (`GET /ai/models`) use the same gate without MFA.
  - **Org override writes** use `requireScope('partner','system','organization')`, `requirePermission(ORGS_WRITE)` and `requireMfa()`, plus `auth.canAccessOrg(orgId)`. This is the same gate as the neighbouring AI budget card (`PUT /ai/budget`).
  - **Writes that change the `script_reviewer` surface** additionally require `approvals:decide` (`PERMISSIONS.APPROVALS_DECIDE`). That preserves today's rule that changing the reviewer model is a privileged widening (`partnerAiScriptPolicy.ts:103-150`, `ai/scriptPolicy.ts`).
  - **Org reads** use `requirePermission(ORGS_READ)` + `canAccessOrg`.
  - **Usage reads** use `requireScope('partner','system')` + `requirePermission(AI_SESSIONS_READ_ALL)`, the gate the page already uses for `/ai/admin/sessions`.
  - **The partner id always comes from `auth.partnerId`**, never from input. The org's partner comes from `readOrgPartnerId(orgId)` and must equal `auth.partnerId` for partner-scope callers.
- **Registry cutover.** Every write calls `ensurePartnerCutover(partnerId)` before touching a registry row (W03 Q5). On failure it returns `503 { error: 'AI configuration is being upgraded. Try again in a moment.', code: 'registry_unavailable' }`. Reads do not gate.
- **One scrubber.** Every catch around a registry write passes through `toRegistryWriteError` (Task 2). It rewrites any error that `carriesQueryValues` into a safe error carrying only class, SQLSTATE, constraint and primary message. Programming errors without query values are rethrown untouched. No route ever returns or logs a raw `DrizzleQueryError`.
- **One rule table.** Write-time gates call W03's `checkEligibility` through `checkEnableEligibility` (Task 3). No file re-implements "is this offering offered / priced / plan-allowed / lifecycle-available".
- **Tighten-only is enforced at write, not only at read.** W02's merge silently clamps at read. W04's org writes **reject** a widening with `422 { code: 'widens_partner', surface, field }`, so an admin never saves a value that will be ignored.
- **Optimistic concurrency.** Offering detail writes and assignment writes carry the row's `updatedAt` as `expectedUpdatedAt` (or `null` for "no row yet"). A mismatch returns `409 { code: 'stale_write' }`, and the UI reloads and toasts.
- **Web.**
  - Every mutation goes through `runAction`, and every new mutating file is added to `no-silent-mutations` `TARGET_GLOBS` with the count bumped.
  - Every interactive element has a `data-testid`.
  - Every string goes through `react-i18next` with keys in all 8 locales.
  - No `'claude-…'` literal anywhere in `apps/web/src` (W03 contract test).
  - Transient UI state (selected drawer row) goes in `window.location.hash` only where it already does. W04 keeps the partner tab's hash `#ai-provider`, and the org page's `#ai`.
- **Settings rules (CLAUDE.md 1–9).** The PR carries the statement drafted in "Settings PR statement" below.
- **Public repo.** No IPs, hostnames, infrastructure detail or unfixed-vulnerability description in code, comments, commits or the PR.
- **Tests.** Tests sit alongside source; real-Postgres suites go under `apps/api/src/__tests__/integration/`.
  - API unit: `cd apps/api && npx vitest run <path>`. Never `pnpm --filter … test -- --run`.
  - Web unit: `cd apps/web && npx vitest run <path>`.
  - i18n: `cd apps/web && npx vitest run src/lib/i18n src/locales` (the whole directories, not just `localeParity`).
  - Integration: `pnpm test-stack up` once, then `cd apps/api && npx vitest run --config vitest.integration.config.ts <path>`, and `pnpm test-stack down` when finished.
  - Typecheck: `cd apps/api && npx tsc --noEmit -p tsconfig.json`, `cd apps/web && npx tsc --noEmit`, `cd packages/shared && npx tsc --noEmit`.
- **Commits.** One per task, with a conventional message ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work on `feature/7598-ai-model-registry/wave-7602`. Call `start_wave` (feature-lifecycle) before Task 1.

## Review Focus

Each item has its pinning test in the task named.

1. **Disabling an offering that a surface depends on.** An admin flips off the model that `chat` (or any surface, at partner or org level) uses as its default. Every AI call on that surface would start failing `no_eligible_model`. The switch must not silently break AI:
   - the API returns `409 offering_in_use` with the affected surfaces;
   - the UI shows a confirm dialog listing them;
   - only `force: true` disables.

   Pinned by Task 4 "disable of a default offering is refused without force" and Task 12 "disable confirm lists affected surfaces".
2. **An org override that widens the partner.** Examples:
   - a permitted id outside the partner's set;
   - a default outside the effective permitted set;
   - `allowUserChoice: true` when the partner is `false`;
   - effort `max` when the partner allows `medium`;
   - `speed: fast` when the partner has no fast.

   Each must be a 422 with the field named, never a silent clamp. Pinned by the Task 6 table "org write rejects every widening".
3. **A cross-tenant id in any write.** Examples:
   - an offering id of another partner in `permittedOfferingIds`, `defaultOfferingId` or `refusalFallbackOfferingId`;
   - a connection id of another partner in `/connections/:id`;
   - an org of another partner in `/orgs/:orgId`.

   It must be 404 or 422 and never write. Pinned by Task 10 (real Postgres as `breeze_app`, forged ids) and Task 8 / Task 9 (route matrix).
4. **Turning residency on while no surface can honour it.** Before W01's spike enables geo carriage, every surface becomes `residency_unavailable`. The switch must show the impact and require acknowledgement, never silently break every AI feature. Pinned by Task 7 "enable with impact requires acknowledgeImpact" and Task 11 "residency confirm".
5. **A partner whose registry is not cut over yet** (W03's per-partner cutover is lazy). Any write must return the recoverable 503 and write nothing, never a partial edit that the cutover projection later overwrites. Pinned by Task 8 "writes return 503 registry_unavailable when the cutover resolves false (W03 contract)" and "… when the cutover rejects, too".

---

## File structure

| Path | Action | Responsibility |
|---|---|---|
| `packages/shared/src/validators/aiModelRegistryApi.ts` | create | zod request schemas for `/ai/models` + constants |
| `packages/shared/src/validators/aiModelRegistryApi.test.ts` | create | schema tests |
| `packages/shared/src/validators/index.ts` | modify | `export * from './aiModelRegistryApi'` |
| `packages/shared/src/types/aiModelRegistry.ts` | create | response DTOs shared by API and web |
| `packages/shared/src/types/index.ts` | modify | `export * from './aiModelRegistry'` |
| `apps/api/src/services/aiModels/registryWriteErrors.ts` (+ `.test.ts`) | create | `RegistryWriteError`, `toRegistryWriteError` (the scrub + SQLSTATE map) |
| `apps/api/src/services/aiModels/connections.ts` (+ test) | modify | `createConnection` scrubs at source (PR #7665 handoff) |
| `apps/api/src/services/aiModels/eligibility.ts` (+ test) | modify (W03 file) | `checkEnableEligibility` wrapper over `checkEligibility` |
| `apps/api/src/services/aiModels/offeringWrites.ts` (+ test) | create | ensure platform offering, enable/disable (gated), detail patch |
| `apps/api/src/services/aiModels/assignmentRows.ts` | create | raw partner / org assignment row reads (mockable seam) |
| `apps/api/src/services/aiModels/assignmentWrites.ts` (+ test) | create | partner and org assignment writes with tighten-only validation |
| `apps/api/src/services/aiModels/residency.ts` (+ test) | create | residency read, impact preview, write |
| `apps/api/src/services/aiModels/connectionSettings.ts` (+ test) | create | connection name + inference geo |
| `apps/api/src/services/aiModels/registryView.ts` (+ test) | create | `GET /ai/models` snapshot and org-defaults DTO builders |
| `apps/api/src/services/aiModels/usageQueries.ts` (+ test) | create | `ai_invocations` breakdowns |
| `apps/api/src/services/aiModels/index.ts` | modify | re-export the new modules |
| `apps/api/src/routes/aiModels/index.ts` | create | `aiModelsRoutes` hub + `GET /` snapshot |
| `apps/api/src/routes/aiModels/shared.ts` | create | gate helpers, `withRegistryWrite`, `registryErrorResponse` |
| `apps/api/src/routes/aiModels/connections.ts` | create | connection routes |
| `apps/api/src/routes/aiModels/offerings.ts` | create | offering routes |
| `apps/api/src/routes/aiModels/assignments.ts` | create | partner assignment PUT |
| `apps/api/src/routes/aiModels/residency.ts` | create | residency preview + PUT |
| `apps/api/src/routes/aiModels/orgAssignments.ts` | create | org GET + PUT |
| `apps/api/src/routes/aiModels/usage.ts` | create | usage GET |
| `apps/api/src/routes/aiModels/*.test.ts` | create | route authz matrix + behaviour |
| `apps/api/src/index.ts` | modify | mount `/ai/models` before `/ai` |
| `apps/api/src/services/mcpCoverage.ts` | modify | 7 `exempt` entries |
| `apps/api/src/__tests__/partner-wide-write-coverage.test.ts` | modify | reasons for `connections.ts` / `offerings.ts` now name the real route; new entries for `offeringWrites.ts`, `assignmentWrites.ts`, `connectionSettings.ts` |
| `apps/api/src/__tests__/integration/aiModelsRoutes.integration.test.ts` | create | real-Postgres tenancy + tighten-only |
| `apps/api/src/routes/orgs.test.ts` (or nearest partner-settings test) | modify | `PATCH /partners/me` cannot write `settings.ai` |
| `apps/api/src/routes/clientAi/schemas.ts`, `admin.ts` (+ tests) | modify | `allowedModels` leaves the PUT schema |
| `apps/api/src/routes/ai/scriptPolicy.ts`, `partnerAiScriptPolicy.ts` (+ tests) | modify | `reviewerModel` leaves both PUT schemas |
| W03's AST contract test (`apps/api/src/__tests__/noHardcodedModels.contract.test.ts` or the path W03 chose) | modify | drop the `PolicyEditor.tsx` allowlist entry |
| `apps/web/src/components/settings/aiModels/PartnerAiModelsTab.tsx` | create | partner tab hub (replaces `PartnerAiProviderTab.tsx`) |
| `apps/web/src/components/settings/aiModels/ConnectionsCard.tsx`, `ConnectionDrawer.tsx`, `ResidencySwitch.tsx` | create | Connections card |
| `apps/web/src/components/settings/aiModels/ModelsCard.tsx`, `OfferingDrawer.tsx` | create | Models card |
| `apps/web/src/components/settings/aiModels/FeatureDefaultsCard.tsx` | create | Defaults by feature |
| `apps/web/src/components/settings/aiModels/OrgModelDefaultsCard.tsx` | create | org override card |
| `apps/web/src/components/settings/aiModels/AiUsageBreakdown.tsx` | create | usage breakdown card |
| `apps/web/src/components/settings/aiModels/ModelDefaultsLink.tsx` | create | "set under AI Providers & Models" pointer used by legacy pages |
| `apps/web/src/components/settings/aiModels/surfaceLabels.ts` | create | literal i18n key maps (surfaces, reasons, sources) |
| `apps/web/src/components/settings/aiModels/*.test.tsx` | create | component tests |
| `apps/web/src/components/settings/PartnerAiProviderTab.tsx` + `.test.tsx` | delete | replaced |
| `apps/web/src/components/settings/PartnerSettingsPage.tsx` | modify | mount the new tab, keep key `aiProvider` + hash `ai-provider` |
| `apps/web/src/components/settings/OrgSettingsPage.tsx` | modify | mount `OrgModelDefaultsCard` in `case 'ai'` |
| `apps/web/src/components/settings/AiUsagePage.tsx` (+ test) | modify | mount `AiUsageBreakdown` |
| `apps/web/src/components/clientAi/PolicyEditor.tsx` (+ test) | modify | allowed-models list → `ModelDefaultsLink` |
| `apps/web/src/components/settings/ScriptAuthoringPage.tsx` (+ test) | modify | both reviewer free-text fields → `ModelDefaultsLink` |
| `apps/web/src/lib/settingsCatalog.ts` (+ test) | modify | `ai-models` catalog entry deep-linking the tab |
| `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` | modify | `TARGET_GLOBS` + count |
| `apps/web/src/locales/*/settings.json`, `*/ai.json` | modify | new keys, 8 locales |
| `apps/docs/src/content/docs/…` (AI provider page, `deploy/environment.mdx`) | modify | new home, env deprecation text |
| `e2e-tests/pages/PartnerAiModelsPage.ts`, `e2e-tests/tests/ai-providers-models.spec.ts` | create | e2e |

### File ownership vs. other waves

| Wave | Files it will touch that W04 also touches | Collision rule |
|---|---|---|
| W03 (#7601, base) | `eligibility.ts` (W04 appends one exported function), the AST contract test (W04 deletes one allowlist entry), `services/aiModels/index.ts` | W04 is stacked on W03. Rebase, never edit W03 behaviour. |
| W05 (#7603, chat picker) | none of W04's files. W05 owns the chat composer, `routes/ai.ts` session routes, and agent-policy UI. It **reads** `packages/shared/src/types/aiModelRegistry.ts` DTOs and may add a user-scoped read route as a new file under `routes/aiModels/`. | W05 adds files; it does not edit `routes/aiModels/index.ts` beyond one `route()` line. |
| W06 / W07 (new connection kinds) | `connectionCreateSchema` (adds union arms), `ConnectionsCard.tsx` / `ConnectionDrawer.tsx` (adds a kind branch), `routes/aiModels/connections.ts` (adds a kind branch), `registryView.ts` (connection DTO fields such as `baseUrl` / `providerConfig` summary) | W04 shapes these as discriminated unions and `switch (kind)` with an exhaustive `never` default, so a new kind is an additive arm. |
| W08 (cleanup) | `routes/aiProvider.ts` (deleted), `partnerLlmConfig.ts` facade, migration dropping `compat_uq` and legacy columns, `clientAi/schemas.ts`, script-policy routes (column drops) | W04 leaves the `/ai/provider` routes in place (no UI caller) and only removes **write** paths for the legacy columns. |
| W09 (failover / roles UI) | `assignmentWrites.ts` (adds role + fallback fields), `FeatureDefaultsCard.tsx` (adds role sub-rows, fallback list), `partnerAssignmentsPutSchema` (role enum widens) | W04's upsert never writes the fallback columns, and its rows are keyed `(surface, role)`. |
| W10 / W11 | `usageQueries.ts` / `aiUsageQuerySchema` (`groupBy` enum widens), `AiUsageBreakdown.tsx` | additive |

---

### Task 1: Shared request schemas and response DTOs

**Files:**
- Create: `packages/shared/src/validators/aiModelRegistryApi.ts`
- Create: `packages/shared/src/validators/aiModelRegistryApi.test.ts`
- Create: `packages/shared/src/types/aiModelRegistry.ts`
- Modify: `packages/shared/src/validators/index.ts` (append `export * from './aiModelRegistryApi';` after the `aiModelOptions` line, ~L1289)
- Modify: `packages/shared/src/types/index.ts` (append `export * from './aiModelRegistry';` after the existing `export * from` block, ~L12)

**Interfaces:**
- Consumes: `AI_SURFACES`, `AiSurface`, `offeringOptionsSchema`, `OfferingOptions`, `modelRatesSchema`, `ModelRates`, `INFERENCE_GEO_PATTERN`, `EffortLevel`, `OptionSupport`, `ModelLifecycle` (all merged).
- Produces (binding for every later task):

```ts
// validators/aiModelRegistryApi.ts
export const CONFIGURABLE_AI_SURFACES: readonly AiSurface[]; // AI_SURFACES minus 'patch_test'
export const AI_MODEL_REQUIRED_PERMISSION_CHOICES: readonly ['ai_models:premium'];
export const AI_USAGE_GROUP_BYS: readonly ['model', 'surface', 'user', 'org'];
export type AiUsageGroupBy = (typeof AI_USAGE_GROUP_BYS)[number];
export const MAX_AI_USAGE_RANGE_DAYS = 92;
export const connectionCreateSchema;        // discriminated union on kind; W04 arm: anthropic_byok
export const connectionRotateKeySchema;     // { apiKey }
export const connectionEndpointSchema;      // { catalogEntryId: string|null, acknowledgeDataNote }
export const connectionSettingsPatchSchema; // { name?, inferenceGeo? (nullable) } — at least one key
export const offeringEnableSchema;          // { enabled: boolean, force?: boolean }
export const offeringDetailsPatchSchema;    // { expectedUpdatedAt, displayName?, prices?, defaultOptions?, allowedOptions?, requiredPermission?, refusalFallbackOfferingId? }
export const partnerAssignmentInputSchema;
export const partnerAssignmentsPutSchema;   // { assignments: PartnerAssignmentInput[] } (1..9, unique surface+role)
export const orgAssignmentInputSchema;
export const orgAssignmentsPutSchema;
export const residencyPutSchema;            // { required: boolean, acknowledgeImpact?: boolean }
export const aiUsageQuerySchema;            // { groupBy, from?, to?, orgId? }
export type ConnectionCreateInput, ConnectionSettingsPatch, OfferingDetailsPatch,
  PartnerAssignmentInput, OrgAssignmentInput, AiUsageQuery;

// types/aiModelRegistry.ts — see Step 3 for the full shapes
export type AiConnectionDto, AiOfferingDto, AiAssignmentRowDto, AiSurfaceDefaultsDto,
  AiModelsSnapshotDto, AiOrgModelDefaultsDto, AiOrgSurfaceDefaultsDto,
  AiResidencyImpactDto, AiUsageBreakdownDto, AiUsageRowDto, OfferingEnableBlocker;
```

- [ ] **Step 1: Write the failing tests**

`packages/shared/src/validators/aiModelRegistryApi.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  AI_USAGE_GROUP_BYS,
  CONFIGURABLE_AI_SURFACES,
  MAX_AI_USAGE_RANGE_DAYS,
  aiUsageQuerySchema,
  connectionCreateSchema,
  connectionSettingsPatchSchema,
  offeringDetailsPatchSchema,
  orgAssignmentsPutSchema,
  partnerAssignmentsPutSchema,
  residencyPutSchema,
} from './aiModelRegistryApi';

const OFF_A = '0b8f1f2e-6a1c-4c55-9a39-6a7f1e1c0a01';
const OFF_B = '0b8f1f2e-6a1c-4c55-9a39-6a7f1e1c0a02';

describe('CONFIGURABLE_AI_SURFACES', () => {
  it('is every surface except the platform-only patch_test', () => {
    expect(CONFIGURABLE_AI_SURFACES).not.toContain('patch_test');
    expect(CONFIGURABLE_AI_SURFACES).toHaveLength(9);
  });
});

describe('connectionCreateSchema', () => {
  it('accepts an anthropic_byok create', () => {
    expect(connectionCreateSchema.parse({ kind: 'anthropic_byok', apiKey: 'sk-ant-api03-' + 'x'.repeat(40) }))
      .toMatchObject({ kind: 'anthropic_byok' });
  });
  it('rejects a kind W04 does not create (W06/W07 add arms)', () => {
    expect(connectionCreateSchema.safeParse({ kind: 'openai_compatible', apiKey: 'x'.repeat(30), baseUrl: 'https://example.com' }).success).toBe(false);
  });
  it('rejects a short key', () => {
    expect(connectionCreateSchema.safeParse({ kind: 'anthropic_byok', apiKey: 'short' }).success).toBe(false);
  });
});

describe('connectionSettingsPatchSchema', () => {
  it('requires at least one field', () => {
    expect(connectionSettingsPatchSchema.safeParse({}).success).toBe(false);
  });
  it('accepts clearing the geo with null', () => {
    expect(connectionSettingsPatchSchema.parse({ inferenceGeo: null })).toEqual({ inferenceGeo: null });
  });
  it('rejects a geo outside INFERENCE_GEO_PATTERN', () => {
    expect(connectionSettingsPatchSchema.safeParse({ inferenceGeo: 'EU West!' }).success).toBe(false);
  });
});

describe('offeringDetailsPatchSchema', () => {
  it('requires expectedUpdatedAt', () => {
    expect(offeringDetailsPatchSchema.safeParse({ displayName: 'x' }).success).toBe(false);
  });
  it('accepts all-four prices or null, never a partial set', () => {
    const base = { expectedUpdatedAt: '2026-10-01T00:00:00.000Z' };
    expect(offeringDetailsPatchSchema.safeParse({ ...base, prices: null }).success).toBe(true);
    expect(offeringDetailsPatchSchema.safeParse({
      ...base, prices: { inputCentsPerM: 300, outputCentsPerM: 1500, cacheReadCentsPerM: 30, cacheWriteCentsPerM: 375 },
    }).success).toBe(true);
    expect(offeringDetailsPatchSchema.safeParse({ ...base, prices: { inputCentsPerM: 300 } }).success).toBe(false);
  });
  it('limits requiredPermission to the offered choices or null', () => {
    const base = { expectedUpdatedAt: '2026-10-01T00:00:00.000Z' };
    expect(offeringDetailsPatchSchema.safeParse({ ...base, requiredPermission: 'ai_models:premium' }).success).toBe(true);
    expect(offeringDetailsPatchSchema.safeParse({ ...base, requiredPermission: null }).success).toBe(true);
    expect(offeringDetailsPatchSchema.safeParse({ ...base, requiredPermission: 'billing:manage' }).success).toBe(false);
  });
});

describe('partnerAssignmentsPutSchema', () => {
  const row = {
    surface: 'chat', role: 'default', defaultOfferingId: OFF_A, permittedOfferingIds: null,
    allowUserChoice: true, options: { effort: 'high' }, expectedUpdatedAt: null,
  };
  it('accepts a partner row', () => {
    expect(partnerAssignmentsPutSchema.parse({ assignments: [row] }).assignments).toHaveLength(1);
  });
  it('rejects role other than default (W09 widens this)', () => {
    expect(partnerAssignmentsPutSchema.safeParse({ assignments: [{ ...row, surface: 'ai_agents', role: 'triage' }] }).success).toBe(false);
  });
  it('rejects patch_test (platform-only)', () => {
    expect(partnerAssignmentsPutSchema.safeParse({ assignments: [{ ...row, surface: 'patch_test' }] }).success).toBe(false);
  });
  it('rejects a partner row with no default', () => {
    expect(partnerAssignmentsPutSchema.safeParse({ assignments: [{ ...row, defaultOfferingId: null }] }).success).toBe(false);
  });
  it('rejects an empty permitted list (use null for all)', () => {
    expect(partnerAssignmentsPutSchema.safeParse({ assignments: [{ ...row, permittedOfferingIds: [] }] }).success).toBe(false);
  });
  it('rejects duplicate surfaces in one PUT', () => {
    expect(partnerAssignmentsPutSchema.safeParse({ assignments: [row, row] }).success).toBe(false);
  });
  it('never carries fallback fields (W09)', () => {
    const parsed = partnerAssignmentsPutSchema.parse({ assignments: [{ ...row, fallbackOfferingIds: [OFF_B] }] });
    expect(parsed.assignments[0]).not.toHaveProperty('fallbackOfferingIds');
  });
});

describe('orgAssignmentsPutSchema', () => {
  it('accepts an all-inherit row (clears the override)', () => {
    expect(orgAssignmentsPutSchema.parse({ assignments: [{
      surface: 'chat', role: 'default', defaultOfferingId: null, permittedOfferingIds: null,
      allowUserChoice: null, options: null, expectedUpdatedAt: '2026-10-01T00:00:00.000Z',
    }] }).assignments[0].defaultOfferingId).toBeNull();
  });
  it('rejects allowUserChoice: true (an org can only lock, never unlock)', () => {
    expect(orgAssignmentsPutSchema.safeParse({ assignments: [{
      surface: 'chat', role: 'default', defaultOfferingId: null, permittedOfferingIds: null,
      allowUserChoice: true, options: null, expectedUpdatedAt: null,
    }] }).success).toBe(false);
  });
});

describe('residencyPutSchema', () => {
  it('defaults acknowledgeImpact to false', () => {
    expect(residencyPutSchema.parse({ required: true })).toEqual({ required: true, acknowledgeImpact: false });
  });
});

describe('aiUsageQuerySchema', () => {
  it('accepts each groupBy', () => {
    for (const groupBy of AI_USAGE_GROUP_BYS) expect(aiUsageQuerySchema.safeParse({ groupBy }).success).toBe(true);
  });
  it(`rejects a range longer than ${MAX_AI_USAGE_RANGE_DAYS} days`, () => {
    expect(aiUsageQuerySchema.safeParse({ groupBy: 'model', from: '2026-01-01', to: '2026-06-01' }).success).toBe(false);
  });
  it('rejects from after to', () => {
    expect(aiUsageQuerySchema.safeParse({ groupBy: 'model', from: '2026-10-02', to: '2026-10-01' }).success).toBe(false);
  });
  it('rejects a one-sided range (would bypass the length cap)', () => {
    expect(aiUsageQuerySchema.safeParse({ groupBy: 'model', from: '2020-01-01' }).success).toBe(false);
    expect(aiUsageQuerySchema.safeParse({ groupBy: 'model', to: '2026-10-01' }).success).toBe(false);
  });
  it('rejects impossible calendar dates', () => {
    expect(aiUsageQuerySchema.safeParse({ groupBy: 'model', from: '2026-02-30', to: '2026-03-01' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/shared && npx vitest run src/validators/aiModelRegistryApi.test.ts`
Expected: FAIL, `Cannot find module './aiModelRegistryApi'`.

- [ ] **Step 3: Write the implementation**

`packages/shared/src/validators/aiModelRegistryApi.ts`:

```ts
/**
 * Request schemas for the /ai/models API (AI model registry W04, #7602).
 * Response DTOs live in ../types/aiModelRegistry.ts.
 *
 * Extension points, deliberately narrow in W04:
 *  - connectionCreateSchema is a discriminated union on `kind`; W06 adds
 *    `openai_compatible`, W07 adds `bedrock` | `vertex` | `foundry`.
 *  - assignment `role` is `'default'` only; W09 widens it to AI_SURFACE_ROLES.
 *  - assignment writes never carry fallback fields; W09 adds them.
 *  - aiUsageQuerySchema.groupBy; W10/W11 add groupings.
 */
import { z } from 'zod';
import { AI_SURFACES, type AiSurface } from '../constants/aiSurfaces';
import { INFERENCE_GEO_PATTERN, modelRatesSchema, offeringOptionsSchema } from './aiModelOptions';

export const CONFIGURABLE_AI_SURFACES = AI_SURFACES.filter(
  (s): s is Exclude<AiSurface, 'patch_test'> => s !== 'patch_test',
) as readonly AiSurface[];

/** Offered as a checkbox in the offering drawer. Spec §5.3, §15 #7. */
export const AI_MODEL_REQUIRED_PERMISSION_CHOICES = ['ai_models:premium'] as const;

export const AI_USAGE_GROUP_BYS = ['model', 'surface', 'user', 'org'] as const;
export type AiUsageGroupBy = (typeof AI_USAGE_GROUP_BYS)[number];
export const MAX_AI_USAGE_RANGE_DAYS = 92;

const uuid = z.string().uuid();
const apiKey = z.string().trim().min(20, 'Enter a valid Anthropic API key.').max(500);
const connectionName = z.string().trim().min(1).max(80);
const inferenceGeo = z.string().regex(INFERENCE_GEO_PATTERN);

export const connectionCreateSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('anthropic_byok'),
    apiKey,
    name: connectionName.optional(),
    inferenceGeo: inferenceGeo.nullable().optional(),
  }).strict(),
]);
export type ConnectionCreateInput = z.infer<typeof connectionCreateSchema>;

export const connectionRotateKeySchema = z.object({ apiKey }).strict();

export const connectionEndpointSchema = z.object({
  catalogEntryId: z.string().trim().min(1).nullable(),
  acknowledgeDataNote: z.boolean().optional().default(false),
}).strict();

export const connectionSettingsPatchSchema = z.object({
  name: connectionName.optional(),
  inferenceGeo: inferenceGeo.nullable().optional(),
}).strict().refine((v) => v.name !== undefined || v.inferenceGeo !== undefined, {
  message: 'Change at least one setting.',
});
export type ConnectionSettingsPatch = z.infer<typeof connectionSettingsPatchSchema>;

export const offeringEnableSchema = z.object({
  enabled: z.boolean(),
  /** Disable even when a surface uses this offering as its default. */
  force: z.boolean().optional().default(false),
}).strict();

/** An allow-list of option values; [] is rejected (use null for "all the model supports"). */
const allowedOptionsSchema = z.object({
  effort: z.array(offeringOptionsSchema.shape.effort.unwrap()).min(1).optional(),
  thinkingDisplay: z.array(offeringOptionsSchema.shape.thinkingDisplay.unwrap()).min(1).optional(),
  speed: z.array(offeringOptionsSchema.shape.speed.unwrap()).min(1).optional(),
}).strict();

export const offeringDetailsPatchSchema = z.object({
  expectedUpdatedAt: z.string().datetime(),
  displayName: z.string().trim().min(1).max(120).nullable().optional(),
  /** All four or null (DB price_chk). Only discovered/manual offerings carry prices (spec §8). */
  prices: modelRatesSchema.nullable().optional(),
  defaultOptions: offeringOptionsSchema.nullable().optional(),
  allowedOptions: allowedOptionsSchema.nullable().optional(),
  requiredPermission: z.enum(AI_MODEL_REQUIRED_PERMISSION_CHOICES).nullable().optional(),
  refusalFallbackOfferingId: uuid.nullable().optional(),
}).strict();
export type OfferingDetailsPatch = z.infer<typeof offeringDetailsPatchSchema>;

const configurableSurface = z.enum(CONFIGURABLE_AI_SURFACES as unknown as [AiSurface, ...AiSurface[]]);
/** W09 (#7607) widens this to AI_SURFACE_ROLES. */
const assignmentRole = z.enum(['default']);
const permittedIds = z.array(uuid).min(1).max(200)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'Duplicate model in the permitted list.' });

export const partnerAssignmentInputSchema = z.object({
  surface: configurableSurface,
  role: assignmentRole,
  defaultOfferingId: uuid,
  /** null = every enabled model. */
  permittedOfferingIds: permittedIds.nullable(),
  allowUserChoice: z.boolean(),
  options: offeringOptionsSchema.nullable(),
  /** The row's updatedAt as read; null when no partner row existed. */
  expectedUpdatedAt: z.string().datetime().nullable(),
}); // non-strict on purpose: stray fields (e.g. W09's fallbacks) are stripped, not written
export type PartnerAssignmentInput = z.infer<typeof partnerAssignmentInputSchema>;

function uniqueSurfaceRole(rows: Array<{ surface: string; role: string }>): boolean {
  return new Set(rows.map((r) => `${r.surface}/${r.role}`)).size === rows.length;
}

export const partnerAssignmentsPutSchema = z.object({
  assignments: z.array(partnerAssignmentInputSchema).min(1).max(CONFIGURABLE_AI_SURFACES.length)
    .refine(uniqueSurfaceRole, { message: 'Each feature may appear once.' }),
}).strict();

export const orgAssignmentInputSchema = z.object({
  surface: configurableSurface,
  role: assignmentRole,
  /** null = inherit the partner default. */
  defaultOfferingId: uuid.nullable(),
  /** null = inherit the partner's permitted set. */
  permittedOfferingIds: permittedIds.nullable(),
  /** An org can only lock choice (false) or inherit (null). */
  allowUserChoice: z.literal(false).nullable(),
  /** null = inherit; per-key values may only narrow (checked server-side). */
  options: offeringOptionsSchema.nullable(),
  expectedUpdatedAt: z.string().datetime().nullable(),
});
export type OrgAssignmentInput = z.infer<typeof orgAssignmentInputSchema>;

export const orgAssignmentsPutSchema = z.object({
  assignments: z.array(orgAssignmentInputSchema).min(1).max(CONFIGURABLE_AI_SURFACES.length)
    .refine(uniqueSurfaceRole, { message: 'Each feature may appear once.' }),
}).strict();

export const residencyPutSchema = z.object({
  required: z.boolean(),
  /** Required when turning residency on would make any feature unavailable (see the preview). */
  acknowledgeImpact: z.boolean().optional().default(false),
}).strict();

/** A real calendar date (2026-02-30 is rejected: it must round-trip through Date). */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => {
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}, { message: 'Enter a valid date (YYYY-MM-DD).' });
export const aiUsageQuerySchema = z.object({
  groupBy: z.enum(AI_USAGE_GROUP_BYS),
  /** Inclusive UTC dates, BOTH or NEITHER (neither = the first of the current month → today, applied by the route). */
  from: isoDate.optional(),
  to: isoDate.optional(),
  orgId: uuid.optional(),
}).refine((q) => (q.from === undefined) === (q.to === undefined), { message: 'Give both `from` and `to`, or neither.' })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: '`from` must not be after `to`.' })
  .refine((q) => {
    if (!q.from || !q.to) return true;
    const days = (Date.parse(`${q.to}T00:00:00Z`) - Date.parse(`${q.from}T00:00:00Z`)) / 86_400_000;
    return days <= MAX_AI_USAGE_RANGE_DAYS;
  }, { message: `Choose a range of at most ${MAX_AI_USAGE_RANGE_DAYS} days.` });
export type AiUsageQuery = z.infer<typeof aiUsageQuerySchema>;
```

`packages/shared/src/types/aiModelRegistry.ts`:

```ts
/**
 * Response DTOs for /ai/models (AI model registry W04, #7602). The API builds
 * them in services/aiModels/registryView.ts and usageQueries.ts; the web reads
 * them unchanged. Never add key material, fingerprints or raw provider config.
 */
import type { AiSurface } from '../constants/aiSurfaces';
import type { EffortLevel, ModelLifecycle, ModelRates, OfferingOptions, OptionSupport } from '../validators/aiModelOptions';

export type AiConnectionKind = 'platform' | 'anthropic_byok' | 'catalog' | 'openai_compatible';

export interface AiConnectionDto {
  /** null for the implicit platform connection. */
  id: string | null;
  kind: AiConnectionKind;
  name: string;
  status: 'active' | 'error' | 'platform';
  lastError: string | null;
  keyLast4: string | null;
  /** The connection's own setting (null = inherit). */
  inferenceGeo: string | null;
  /** What W03 actually sends: own → platform setting (AI_PLATFORM_INFERENCE_GEO) → provider default. */
  effectiveInferenceGeo: string | null;
  inferenceGeoSource: 'connection' | 'platform' | 'provider_default';
  /** Geos the connection's models can honour (union of their option_support.inferenceGeo). */
  supportedInferenceGeos: string[];
  catalogEntryId: string | null;
  catalogName: string | null;
  configVersion: number | null;
  verifiedAt: string | null;
  lastDiscoveredAt: string | null;
  discoveryError: string | null;
  funding: 'platform' | 'partner_key';
}

/** Why the enable switch is disabled (the subset of ResolveFailureReason the enable gate can return). */
export type OfferingEnableBlocker = 'model_unavailable' | 'unpriced' | 'plan_required' | 'connection_unavailable';

export interface AiOfferingDto {
  /** null for a platform model the partner has not added yet (row is synthesized). */
  id: string | null;
  platformModelId: string | null;
  connectionId: string | null;
  source: 'platform' | 'discovered' | 'manual' | 'catalog';
  modelId: string;
  displayName: string;
  displayNameOverride: string | null;
  enabled: boolean;
  lifecycle: ModelLifecycle;
  funding: 'platform' | 'partner_key';
  /** The rate the resolver would bill, per spec §8 precedence; null = unpriced. */
  rates: ModelRates | null;
  fastRates: ModelRates | null;
  priceSource: 'platform' | 'offering' | 'catalog' | 'linked_platform' | null;
  /** Own prices (discovered/manual only), for the drawer. */
  ownPrices: ModelRates | null;
  pricesEditable: boolean;
  thinkingMode: 'adaptive' | 'budget' | 'none' | 'unknown';
  supportsTools: boolean;
  contextTokens: number | null;
  optionSupport: OptionSupport;
  defaultOptions: OfferingOptions | null;
  allowedOptions: { effort?: EffortLevel[]; thinkingDisplay?: OptionSupport['thinkingDisplay']; speed?: OptionSupport['speed'] } | null;
  requiredPermission: string | null;
  refusalFallbackOfferingId: string | null;
  /** null = can be enabled; otherwise why not. */
  enableBlocker: OfferingEnableBlocker | null;
  /** Surfaces (partner or org rows) that use this offering as their default. */
  defaultFor: Array<{ surface: AiSurface; level: 'partner' | 'org'; orgId: string | null }>;
  updatedAt: string | null;
}

export interface AiAssignmentRowDto {
  surface: AiSurface;
  role: string;
  defaultOfferingId: string | null;
  permittedOfferingIds: string[] | null;
  allowUserChoice: boolean | null;
  options: OfferingOptions | null;
  updatedAt: string | null;
}

export interface AiSurfaceDefaultsDto {
  surface: AiSurface;
  requiresTools: boolean;
  partner: AiAssignmentRowDto | null;
  /** Count of org overrides for this surface (link to orgs, not edited here). */
  orgOverrideCount: number;
}

export interface AiModelsSnapshotDto {
  partner: { residencyRequired: boolean; plan: string; hosted: boolean };
  connections: AiConnectionDto[];
  offerings: AiOfferingDto[];
  defaults: AiSurfaceDefaultsDto[];
  catalog: Array<{ entryId: string; slug: string; name: string; dataNote: string | null; models: string[] }>;
  catalogEnabled: boolean;
}

export interface AiOrgSurfaceDefaultsDto {
  surface: AiSurface;
  requiresTools: boolean;
  /** The partner row's values = what an all-blank org row inherits. */
  inherited: { defaultOfferingId: string | null; permittedOfferingIds: string[] | null; allowUserChoice: boolean; options: OfferingOptions };
  org: AiAssignmentRowDto | null;
  effective: { defaultOfferingId: string | null; defaultSource: 'org' | 'partner' | 'none'; permittedOfferingIds: string[] | null; allowUserChoice: boolean; options: OfferingOptions };
}

export interface AiOrgModelDefaultsDto {
  orgId: string;
  /** Enabled offerings of the org's partner (what an override may choose from). */
  offerings: Array<Pick<AiOfferingDto, 'id' | 'displayName' | 'funding' | 'supportsTools' | 'optionSupport' | 'rates' | 'requiredPermission'>>;
  surfaces: AiOrgSurfaceDefaultsDto[];
  canEdit: boolean;
  canEditReviewer: boolean;
}

export interface AiResidencyImpactDto {
  /** Surfaces whose PARTNER default becomes ineligible when residency is required. */
  unavailableSurfaces: AiSurface[];
  /** Org overrides whose own default becomes ineligible (Codex review finding 12). */
  affectedOrgOverrides: Array<{ orgId: string; orgName: string | null; surface: AiSurface }>;
}

export interface AiUsageRowDto {
  key: string;
  label: string;
  invocations: number;
  costCents: number;
  inputTokens: number;
  outputTokens: number;
  refusals: number;
  /** refusals / invocations, 0..1; 0 when invocations = 0. */
  refusalRate: number;
  fallbacks: number;
}

export interface AiUsageBreakdownDto {
  groupBy: 'model' | 'surface' | 'user' | 'org';
  from: string;
  to: string;
  orgId: string | null;
  rows: AiUsageRowDto[];
  totals: Omit<AiUsageRowDto, 'key' | 'label'>;
}
```

Append the two `export *` lines to the index files listed above.

- [ ] **Step 4: Run tests and typecheck**

Run: `cd packages/shared && npx vitest run src/validators/aiModelRegistryApi.test.ts && npx tsc --noEmit`
Expected: PASS (every case in the file); tsc exits 0. If `offeringOptionsSchema.shape.effort.unwrap()` does not typecheck (zod version difference), import `EFFORT_LEVELS` / `THINKING_DISPLAYS` / `MODEL_SPEEDS` and use `z.enum(...)` instead.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators/aiModelRegistryApi.ts packages/shared/src/validators/aiModelRegistryApi.test.ts \
  packages/shared/src/types/aiModelRegistry.ts packages/shared/src/validators/index.ts packages/shared/src/types/index.ts
git commit -m "feat(shared): /ai/models request schemas and response DTOs (#7602)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: One write-error mapper; `createConnection` scrubs at its source

Closes PR #7665's handoff: "`createConnection`'s insert can raise a `DrizzleQueryError` whose params include ciphertext. W04 must route it through `safeDbError` before wiring a caller." The fix goes **at the source**, so every caller is covered. That includes W03's `connectCompat` and any future W06/W07 caller.

**Files:**
- Create: `apps/api/src/services/aiModels/registryWriteErrors.ts`
- Create: `apps/api/src/services/aiModels/registryWriteErrors.test.ts`
- Modify: `apps/api/src/services/aiModels/connections.ts:104-134` (`createConnection`)
- Modify: `apps/api/src/services/aiModels/connections.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `carriesQueryValues`, `safeDbErrorDetail`, `formatSafeDbErrorDetail`, `errorSqlstate` (merged `safeDbError.ts`).
- Produces:

```ts
export type RegistryWriteCode =
  | 'not_found' | 'unpriced' | 'not_eligible' | 'offering_in_use' | 'stale_write'
  | 'conflict' | 'invalid' | 'tools_unsupported' | 'widens_partner' | 'write_failed';
export class RegistryWriteError extends Error {
  constructor(message: string, readonly code: RegistryWriteCode, readonly status: 400 | 404 | 409 | 422 | 500,
              readonly details?: Record<string, unknown>);
}
/** Rethrows RegistryWriteError / OfferingWriteError / ConnectionKeyError as RegistryWriteError,
 *  scrubs any error that carries query values into a 500 'write_failed' (cause keeps SQLSTATE),
 *  maps 23505 → 409 conflict and 23503/23514 → 422 invalid, and rethrows anything else untouched. */
export function toRegistryWriteError(error: unknown, fallbackMessage: string): never;
```

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/aiModels/registryWriteErrors.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { RegistryWriteError, toRegistryWriteError } from './registryWriteErrors';
import { OfferingWriteError } from './offerings';
import { ConnectionKeyError } from './connections';

/** Shape of a drizzle DrizzleQueryError wrapping a postgres.js error. */
function drizzleError(code: string, constraint: string, params: unknown[]): Error {
  const pg = Object.assign(new Error('duplicate key value violates unique constraint'), {
    code, constraint_name: constraint, severity: 'ERROR', query: 'insert into …', parameters: params,
  });
  return Object.assign(new Error(`Failed query: insert into … params: ${params.join(',')}`), {
    name: 'DrizzleQueryError', query: 'insert into …', params, cause: pg,
  });
}

function capture(fn: () => never): RegistryWriteError | unknown {
  try { fn(); } catch (e) { return e; }
  throw new Error('did not throw');
}

describe('toRegistryWriteError', () => {
  it('never lets ciphertext in params reach the message', () => {
    const err = capture(() => toRegistryWriteError(drizzleError('XX000', 'x', ['enc:v1:SECRETCIPHERTEXT']), 'Could not save.'));
    expect(err).toBeInstanceOf(RegistryWriteError);
    const e = err as RegistryWriteError;
    expect(e.status).toBe(500);
    expect(e.code).toBe('write_failed');
    expect(JSON.stringify({ m: e.message, c: String((e as Error).cause), d: e.details })).not.toContain('SECRETCIPHERTEXT');
    expect(((e as Error).cause as { code?: string }).code).toBe('XX000');
  });

  it('maps a unique violation to 409 conflict with the constraint name only', () => {
    const e = capture(() => toRegistryWriteError(
      drizzleError('23505', 'partner_ai_connections_compat_uq', ['enc:v1:X']), 'Could not save.',
    )) as RegistryWriteError;
    expect(e.status).toBe(409);
    expect(e.code).toBe('conflict');
    expect(e.details).toEqual({ constraint: 'partner_ai_connections_compat_uq' });
  });

  it('maps FK and CHECK violations to 422 invalid', () => {
    for (const code of ['23503', '23514']) {
      const e = capture(() => toRegistryWriteError(drizzleError(code, 'c', ['v']), 'Could not save.')) as RegistryWriteError;
      expect(e.status).toBe(422);
      expect(e.code).toBe('invalid');
    }
  });

  it('passes typed service errors through as RegistryWriteError', () => {
    const a = capture(() => toRegistryWriteError(new OfferingWriteError('Set a price first.', 'unpriced'), 'x')) as RegistryWriteError;
    expect([a.code, a.status, a.message]).toEqual(['unpriced', 409, 'Set a price first.']);
    const b = capture(() => toRegistryWriteError(new OfferingWriteError('Offering not found.', 'not_found'), 'x')) as RegistryWriteError;
    expect([b.code, b.status]).toEqual(['not_found', 404]);
    const c = capture(() => toRegistryWriteError(new ConnectionKeyError('bad', 'key_rejected'), 'x')) as RegistryWriteError;
    expect([c.code, c.status]).toEqual(['invalid', 400]);
    const d = new RegistryWriteError('m', 'stale_write', 409);
    expect(capture(() => toRegistryWriteError(d, 'x'))).toBe(d);
  });

  it('rethrows an error with no query values untouched (bugs stay diagnosable)', () => {
    const bug = new TypeError('cannot read x of undefined');
    expect(capture(() => toRegistryWriteError(bug, 'x'))).toBe(bug);
  });
});
```

Append to `apps/api/src/services/aiModels/connections.test.ts` (reuse the file's existing `db` mock; if it has none, add `vi.mock('../../db', …)` returning an `insert` chain whose `returning` rejects):

```ts
describe('createConnection error scrubbing (PR #7665 handoff)', () => {
  it('throws a scrubbed RegistryWriteError when the insert fails with query values', async () => {
    const pg = Object.assign(new Error('duplicate key'), { code: '23505', constraint_name: 'partner_ai_connections_compat_uq' });
    insertReturningMock.mockRejectedValueOnce(Object.assign(new Error('Failed query … params: enc:v1:SECRET'), {
      name: 'DrizzleQueryError', query: 'insert', params: ['enc:v1:SECRET'], cause: pg,
    }));
    const err = await createConnection({
      partnerId: P, kind: 'anthropic_byok', name: 'Anthropic', apiKey: 'sk-ant-' + 'x'.repeat(40),
      connectedBy: null, verifiedAt: null,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(RegistryWriteError);
    expect(err.code).toBe('conflict');
    expect(String(err.message) + String(err.cause)).not.toContain('SECRET');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/registryWriteErrors.test.ts src/services/aiModels/connections.test.ts`
Expected: FAIL. `registryWriteErrors.test.ts` fails with `Cannot find module './registryWriteErrors'`. The new `connections.test.ts` case fails because the raw `DrizzleQueryError` escapes.

- [ ] **Step 3: Write the implementation**

`apps/api/src/services/aiModels/registryWriteErrors.ts`:

```ts
/**
 * The one error mapper for AI model registry writes (W04, #7602).
 * Every /ai/models write path catches into toRegistryWriteError. An error that
 * carries SQL query values (DrizzleQueryError params, postgres.js parameters)
 * is never rethrown as-is: its params can hold key ciphertext and fingerprints
 * (safeDbError.ts header). Anything without query values is rethrown untouched
 * so programming bugs stay diagnosable.
 */
import { carriesQueryValues, errorSqlstate, formatSafeDbErrorDetail, safeDbErrorDetail } from './safeDbError';
import { OfferingWriteError } from './offerings';
import { ConnectionKeyError } from './connections';

export type RegistryWriteCode =
  | 'not_found' | 'unpriced' | 'not_eligible' | 'offering_in_use' | 'stale_write'
  | 'conflict' | 'invalid' | 'tools_unsupported' | 'widens_partner' | 'write_failed';

export class RegistryWriteError extends Error {
  constructor(
    message: string,
    readonly code: RegistryWriteCode,
    readonly status: 400 | 404 | 409 | 422 | 500,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'RegistryWriteError';
  }
}

export function toRegistryWriteError(error: unknown, fallbackMessage: string): never {
  if (error instanceof RegistryWriteError) throw error;
  if (error instanceof OfferingWriteError) {
    throw new RegistryWriteError(error.message, error.code, error.code === 'not_found' ? 404 : 409);
  }
  if (error instanceof ConnectionKeyError) {
    throw new RegistryWriteError(error.message, 'invalid', 400);
  }
  if (!carriesQueryValues(error)) throw error;

  const detail = safeDbErrorDetail(error);
  const sqlstate = errorSqlstate(error);
  const constraint = detail.constraint;
  let mapped: RegistryWriteError;
  if (sqlstate === '23505') {
    mapped = new RegistryWriteError('This conflicts with an existing setting.', 'conflict', 409, constraint ? { constraint } : undefined);
  } else if (sqlstate === '23503' || sqlstate === '23514') {
    mapped = new RegistryWriteError('That value is not allowed here.', 'invalid', 422, constraint ? { constraint } : undefined);
  } else {
    mapped = new RegistryWriteError(fallbackMessage, 'write_failed', 500);
  }
  const formatted = formatSafeDbErrorDetail(detail);
  mapped.cause = Object.assign(
    new Error(`AI model registry write failed: ${detail.kind}${formatted ? ` (${formatted})` : ''}`),
    sqlstate ? { code: sqlstate } : {},
  );
  throw mapped;
}
```

`registryWriteErrors.ts` imports `connections.ts`, and `connections.ts` must not import back at module top. Wrap the insert in `createConnection` with a lazy import, which avoids the cycle (`OfferingWriteError` / `ConnectionKeyError` are classes defined at module top):

```ts
// connections.ts — createConnection, replacing the bare insert
  let created: PartnerAiConnection | undefined;
  try {
    [created] = await db
      .insert(partnerAiConnections)
      .values({ /* unchanged */ })
      .returning(PUBLIC_COLUMNS);
  } catch (error) {
    // PR #7665 handoff: the params carry key ciphertext. Scrub at the source so
    // every caller (W03 connectCompat, W04 routes, W06/W07) is covered.
    const { toRegistryWriteError } = await import('./registryWriteErrors');
    toRegistryWriteError(error, 'Could not save the AI connection.');
  }
  if (!created) throw new Error('Could not create the connection.');
  return created;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/aiModels/registryWriteErrors.test.ts src/services/aiModels/connections.test.ts src/services/partnerLlmConfig.test.ts`
Expected: PASS. `partnerLlmConfig.test.ts` stays green: its `toSafeWriteError` receives an already-scrubbed error, and `carriesQueryValues` is false on it, so it is rethrown unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiModels/registryWriteErrors.ts apps/api/src/services/aiModels/registryWriteErrors.test.ts \
  apps/api/src/services/aiModels/connections.ts apps/api/src/services/aiModels/connections.test.ts
git commit -m "fix(ai-models): scrub createConnection DB errors at the source; one registry write-error mapper (#7602)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `checkEnableEligibility` — the enable gate reuses W03's rule table

W02's `enableOffering` checks only "priced". The spec also requires the offered / plan / lifecycle gates (§8: "`min_plan` … at enable time **and** at dispatch"; §5.1: `platform_offered`; §6 lifecycle). The rules already exist once, in W03's pure `checkEligibility`. W04 must not copy them. Instead, `checkEnableEligibility` calls `checkEligibility` with the dispatch-only inputs **neutralised**. Those inputs are:
- `enabled` (we are deciding it);
- tools and surface (decided per assignment, Task 5);
- the user permission (decided per user, at dispatch);
- residency (decided per partner setting, at dispatch).

Connection health is reported but does not block enabling, because a key in `error` state is transient. The UI shows it as a non-blocking warning.

**Files:**
- Modify: `apps/api/src/services/aiModels/eligibility.ts` (append; W03 file)
- Modify: `apps/api/src/services/aiModels/eligibility.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: W03 `checkEligibility`, `CandidateFacts`, `PartnerPlan` (Q1).
- Produces:

```ts
export interface EnableEligibilityContext { partnerId: string; partnerPlan: PartnerPlan | null; hosted: boolean }
export type EnableGateReason = 'not_permitted' | 'model_unavailable' | 'unpriced' | 'plan_required';
/** The enable-time gate. Returns null when the offering may be enabled. Connection health never blocks. */
export function checkEnableEligibility(c: CandidateFacts, ctx: EnableEligibilityContext): EnableGateReason | null;
/** Same rules, reporting connection health too (for the snapshot DTO's enableBlocker). */
export function enableBlockerFor(c: CandidateFacts, ctx: EnableEligibilityContext): OfferingEnableBlocker | null;
```

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/services/aiModels/eligibility.test.ts` (reuse the file's `baseFacts()` builder if W03 named one; otherwise define it as below):

```ts
import { checkEnableEligibility, enableBlockerFor } from './eligibility';

describe('checkEnableEligibility (W04 enable gate; one rule table)', () => {
  const P = 'partner-1';
  const rates = { source: 'platform' as const, standard: { inputCentsPerM: 300, outputCentsPerM: 1500, cacheReadCentsPerM: 30, cacheWriteCentsPerM: 375 } };
  const facts = (over: Partial<CandidateFacts> = {}): CandidateFacts => ({
    ownerPartnerId: P, enabled: false, lifecycle: 'available', requiredPermission: 'ai_models:premium',
    platform: { platformOffered: true, lifecycle: 'available', minPlan: null },
    connection: { kind: 'platform', status: 'active', keyUsable: true },
    catalog: null, rate: rates, supportsTools: false, inferenceGeo: null, supportedInferenceGeos: [],
    ...over,
  });
  const ctx = { partnerId: P, partnerPlan: 'pro' as const, hosted: true };

  it.each([
    ['a disabled, offered, priced platform model', facts(), null],
    ['a model the operator stopped offering', facts({ platform: { platformOffered: false, lifecycle: 'available', minPlan: null } }), 'model_unavailable'],
    ['a retired platform row', facts({ platform: { platformOffered: true, lifecycle: 'retired', minPlan: null } }), 'model_unavailable'],
    ['a missing offering', facts({ lifecycle: 'missing' }), 'model_unavailable'],
    ['an unpriced connection model', facts({ platform: null, connection: { kind: 'anthropic_byok', status: 'active', keyUsable: true }, rate: null }), 'unpriced'],
    ['a plan-gated model on a lower plan (hosted)', facts({ platform: { platformOffered: true, lifecycle: 'available', minPlan: 'enterprise' } }), 'plan_required'],
    ['a catalog model no longer mapped+verified', facts({ platform: null, connection: { kind: 'catalog', status: 'active', keyUsable: true }, catalog: { usable: false } }), 'model_unavailable'],
    ['another partner’s offering', facts({ ownerPartnerId: 'other' }), 'not_permitted'],
  ])('%s → %s', (_label, f, expected) => {
    expect(checkEnableEligibility(f, ctx)).toBe(expected);
  });

  it('does not gate on tools, user permission or residency (decided at assignment / dispatch)', () => {
    expect(checkEnableEligibility(facts({ supportsTools: false, requiredPermission: 'ai_models:premium' }), ctx)).toBeNull();
  });

  it('ignores min_plan when not hosted (self-host has no plans)', () => {
    expect(checkEnableEligibility(facts({ platform: { platformOffered: true, lifecycle: 'available', minPlan: 'enterprise' } }), { ...ctx, hosted: false })).toBeNull();
  });

  it('never blocks enabling on connection health, but enableBlockerFor reports it', () => {
    const f = facts({ platform: null, connection: { kind: 'anthropic_byok', status: 'error', keyUsable: false }, rate: rates });
    expect(checkEnableEligibility(f, ctx)).toBeNull();
    expect(enableBlockerFor(f, ctx)).toBe('connection_unavailable');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/eligibility.test.ts`
Expected: FAIL, `checkEnableEligibility is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `apps/api/src/services/aiModels/eligibility.ts`:

```ts
// ── W04 (#7602): the enable-time gate ────────────────────────────────────────
// Spec §8 / §5.1 / §6: enabling re-checks offered, lifecycle, price and plan.
// It REUSES checkEligibility (one rule table) by neutralising the inputs that
// are not decided at enable time:
//   enabled            → true            (that is what we are deciding)
//   connection status  → active/usable   (transient; reported, never blocking)
//   tools              → supported       (decided per surface at assignment)
//   requiredPermission → null            (decided per user at dispatch)
//   residency          → not required    (decided per partner at dispatch)
// `chat` is only the surface label checkEligibility needs; with supportsTools
// forced true the tools rule cannot fire for any surface.
export interface EnableEligibilityContext {
  partnerId: string;
  partnerPlan: PartnerPlan | null;
  hosted: boolean;
}
export type EnableGateReason = 'not_permitted' | 'model_unavailable' | 'unpriced' | 'plan_required';

function neutralised(c: CandidateFacts): CandidateFacts {
  return {
    ...c,
    enabled: true,
    connection: { ...c.connection, status: 'active', keyUsable: true },
    supportsTools: true,
    requiredPermission: null,
  };
}

function enableContext(ctx: EnableEligibilityContext): EligibilityContext {
  return {
    partnerId: ctx.partnerId,
    surface: 'chat',
    partnerPlan: ctx.partnerPlan,
    hosted: ctx.hosted,
    residencyRequired: false,
    geoCarriable: true,
    userInitiated: false,
    userHoldsPermission: () => true,
  };
}

export function checkEnableEligibility(c: CandidateFacts, ctx: EnableEligibilityContext): EnableGateReason | null {
  const reason = checkEligibility(neutralised(c), enableContext(ctx));
  if (reason === null) return null;
  if (reason === 'not_permitted' || reason === 'model_unavailable' || reason === 'unpriced' || reason === 'plan_required') {
    return reason;
  }
  // connection_unavailable can still come from a non-dispatchable kind
  // (openai_compatible before W06). Treat it as unavailable for enabling.
  return 'model_unavailable';
}

export function enableBlockerFor(
  c: CandidateFacts,
  ctx: EnableEligibilityContext,
): 'model_unavailable' | 'unpriced' | 'plan_required' | 'connection_unavailable' | null {
  const gate = checkEnableEligibility(c, ctx);
  if (gate === 'not_permitted') return 'model_unavailable';
  if (gate) return gate;
  if (c.connection.kind !== 'platform' && (c.connection.status !== 'active' || !c.connection.keyUsable)) {
    return 'connection_unavailable';
  }
  return null;
}
```

If the W03 branch's `EligibilityContext` has more or fewer fields than Q1, update `enableContext` only. The test table pins the behaviour.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/aiModels/eligibility.test.ts`
Expected: PASS (W03's table plus 11 new cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiModels/eligibility.ts apps/api/src/services/aiModels/eligibility.test.ts
git commit -m "feat(ai-models): enable-time gate reuses checkEligibility's rule table (#7602)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 4: `offeringWrites.ts` — add a platform model, enable/disable (gated), edit details

**Files:**
- Create: `apps/api/src/services/aiModels/offeringWrites.ts`
- Create: `apps/api/src/services/aiModels/offeringWrites.test.ts`
- Modify: `apps/api/src/services/aiModels/index.ts` (add `export * from './offeringWrites';` and `export * from './registryWriteErrors';`)
- Modify: `apps/api/src/__tests__/partner-wide-write-coverage.test.ts` (add `services/aiModels/offeringWrites.ts`; reword the `offerings.ts` and `connections.ts` reasons)

**Interfaces:**
- Consumes:
  - Task 2 `RegistryWriteError`, `toRegistryWriteError`;
  - Task 3 `checkEnableEligibility`;
  - W03 `loadOfferingCandidate`, `loadPartnerFacts` (Q2);
  - merged `enableOffering`, `getOffering`, `offeringPriceSource`, `getPlatformModelById`;
  - `isHosted()` from `config/env.ts`;
  - shared `OfferingDetailsPatch`.
- Produces:

```ts
export interface OfferingInUse { surface: AiSurface; level: 'partner' | 'org'; orgId: string | null }
/** Creates the partner's platform offering for a platform model (disabled), or returns the existing one. Idempotent. */
export function ensurePlatformOffering(input: { partnerId: string; platformModelId: string; enabled: boolean }): Promise<Offering>;
/** Enable runs checkEnableEligibility; disable refuses (409 offering_in_use) while a surface defaults to it, unless force. */
export function setOfferingEnabled(input: { partnerId: string; offeringId: string; enabled: boolean; force: boolean }):
  Promise<{ offering: Offering; inUse: OfferingInUse[] }>;
export function listOfferingDefaultUses(partnerId: string, offeringId: string): Promise<OfferingInUse[]>;
export function updateOfferingDetails(input: { partnerId: string; offeringId: string; patch: OfferingDetailsPatch }): Promise<Offering>;
```

`updateOfferingDetails` enforces these rules (spec §5.3, §7, §8; the DB CHECKs are in `2026-11-14-100100`):

| Field | Rule | Error |
|---|---|---|
| `expectedUpdatedAt` | Must equal the row's `updatedAt` (ms precision). | 409 `stale_write` |
| `prices` | Only `source ∈ {discovered, manual}` (`pricesEditable`). The DB forbids prices on platform and catalog rows. Setting `null` on an **enabled** offering is refused when no other §8 price source remains. | 422 `invalid` `{field:'prices'}` / 409 `unpriced` |
| `defaultOptions` | Each set key's value must be in the model's support (from the loaded candidate) ∩ the new-or-current `allowedOptions`. | 422 `invalid` `{ field: 'defaultOptions', key }` |
| `allowedOptions` | Each provided list must intersect the model's support, non-empty. Spec §5.3: "A write whose intersection with the model's support is empty is rejected". | 422 `invalid` `{ field: 'allowedOptions', key }` |
| `speed: 'fast'` in either | Requires `optionRates['speed:fast']`. §8: a variant with no rate can't be selected. | 422 `invalid` `{key:'speed'}` |
| `requiredPermission` | Already limited to `AI_MODEL_REQUIRED_PERMISSION_CHOICES` by zod. | — |
| `refusalFallbackOfferingId` | Must be another offering of the same partner, **on the same connection and funding**, **enabled**, with `checkEnableEligibility(fallback.facts) === null` (eligible and priced, §5.3). The DB trigger re-checks owner and connection. | 422 `not_eligible` `{ field: 'refusalFallbackOfferingId', reason }` |
| `displayName` | Trimmed, or null (null = use the model's name). | — |

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/aiModels/offeringWrites.test.ts`. It mocks `../../db` (a select/update/insert chain recorder), `./candidateLoader`, `./offerings`, `./platformModels` and `../../config/env`, in the hoisted-mock style of `offerings.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  loadOfferingCandidate: vi.fn(),
  loadPartnerFacts: vi.fn(async () => ({ plan: 'pro', residencyRequired: false })),
  enableOffering: vi.fn(),
  getOffering: vi.fn(),
  getPlatformModelById: vi.fn(),
  hosted: true,
  dbSelectRows: [] as unknown[][],
  dbUpdateReturning: vi.fn(),
  dbInsertReturning: vi.fn(),
}));

vi.mock('./candidateLoader', () => ({ loadOfferingCandidate: h.loadOfferingCandidate, loadPartnerFacts: h.loadPartnerFacts }));
vi.mock('./offerings', async (orig) => ({ ...(await orig<typeof import('./offerings')>()), enableOffering: h.enableOffering, getOffering: h.getOffering }));
vi.mock('./platformModels', () => ({ getPlatformModelById: h.getPlatformModelById }));
vi.mock('../../config/env', () => ({ isHosted: () => h.hosted }));
vi.mock('../../db', () => {
  const chain = (rows: () => unknown[]) => {
    const c: any = { from: () => c, where: () => c, limit: () => Promise.resolve(rows()), then: (r: any) => Promise.resolve(rows()).then(r) };
    return c;
  };
  return {
    db: {
      select: () => chain(() => h.dbSelectRows.shift() ?? []),
      update: () => ({ set: () => ({ where: () => ({ returning: h.dbUpdateReturning }) }) }),
      insert: () => ({ values: () => ({ onConflictDoNothing: () => ({ returning: h.dbInsertReturning }) }) }),
    },
  };
});

import { ensurePlatformOffering, setOfferingEnabled, updateOfferingDetails } from './offeringWrites';
import { RegistryWriteError } from './registryWriteErrors';

const P = '22222222-2222-4222-8222-222222222222';
const OFF = '33333333-3333-4333-8333-333333333333';
const FB = '44444444-4444-4444-8444-444444444444';
const RATES = { inputCentsPerM: 300, outputCentsPerM: 1500, cacheReadCentsPerM: 30, cacheWriteCentsPerM: 375 };
const UPDATED = new Date('2026-10-01T10:00:00.000Z');

function candidate(over: Record<string, unknown> = {}, factsOver: Record<string, unknown> = {}) {
  return {
    offeringId: OFF, connectionId: null, displayName: 'Model A', funding: 'platform',
    optionSupport: { effort: ['low', 'medium', 'high'], thinkingDisplay: ['summarized'], speed: ['standard'], inferenceGeo: [] },
    optionRates: null, allowedOptions: null, defaultOptions: null,
    facts: {
      ownerPartnerId: P, enabled: false, lifecycle: 'available', requiredPermission: null,
      platform: { platformOffered: true, lifecycle: 'available', minPlan: null },
      connection: { kind: 'platform', status: 'active', keyUsable: true }, catalog: null,
      rate: { source: 'platform', standard: RATES }, supportsTools: true, inferenceGeo: null, supportedInferenceGeos: [],
      ...factsOver,
    },
    ...over,
  };
}
const row = (over: Record<string, unknown> = {}) => ({
  id: OFF, partnerId: P, connectionId: null, platformModelId: 'pm-1', modelId: null, source: 'platform',
  enabled: false, updatedAt: UPDATED, priceInputCentsPerM: null, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.hosted = true;
  h.dbSelectRows = [];
});

describe('setOfferingEnabled', () => {
  it('enables an eligible offering through W02 enableOffering', async () => {
    h.loadOfferingCandidate.mockResolvedValue(candidate());
    h.enableOffering.mockResolvedValue(row({ enabled: true }));
    const r = await setOfferingEnabled({ partnerId: P, offeringId: OFF, enabled: true, force: false });
    expect(h.enableOffering).toHaveBeenCalledWith({ partnerId: P, offeringId: OFF, enabled: true });
    expect(r.offering.enabled).toBe(true);
  });

  it.each([
    ['not offered by the platform', { platform: { platformOffered: false, lifecycle: 'available', minPlan: null } }, 'model_unavailable'],
    ['retired', { lifecycle: 'retired' }, 'model_unavailable'],
    ['plan-gated', { platform: { platformOffered: true, lifecycle: 'available', minPlan: 'enterprise' } }, 'plan_required'],
  ])('refuses to enable a model that is %s (409 not_eligible, reason %s)', async (_l, facts, reason) => {
    h.loadOfferingCandidate.mockResolvedValue(candidate({}, facts));
    const err = await setOfferingEnabled({ partnerId: P, offeringId: OFF, enabled: true, force: false }).catch((e) => e);
    expect(err).toBeInstanceOf(RegistryWriteError);
    expect([err.status, err.code, err.details?.reason]).toEqual([409, 'not_eligible', reason]);
    expect(h.enableOffering).not.toHaveBeenCalled();
  });

  it('404s an offering of another partner (loader returns null)', async () => {
    h.loadOfferingCandidate.mockResolvedValue(null);
    const err = await setOfferingEnabled({ partnerId: P, offeringId: OFF, enabled: true, force: false }).catch((e) => e);
    expect([err.status, err.code]).toEqual([404, 'not_found']);
  });

  it('refuses to disable a default offering without force, listing the surfaces', async () => {
    h.loadOfferingCandidate.mockResolvedValue(candidate({}, { enabled: true }));
    h.dbSelectRows = [[{ surface: 'chat', orgId: null }, { surface: 'helper', orgId: 'org-1' }]];
    const err = await setOfferingEnabled({ partnerId: P, offeringId: OFF, enabled: false, force: false }).catch((e) => e);
    expect([err.status, err.code]).toEqual([409, 'offering_in_use']);
    expect(err.details.inUse).toEqual([
      { surface: 'chat', level: 'partner', orgId: null },
      { surface: 'helper', level: 'org', orgId: 'org-1' },
    ]);
    expect(h.enableOffering).not.toHaveBeenCalled();
  });

  it('disables a default offering with force and reports what it affected', async () => {
    h.loadOfferingCandidate.mockResolvedValue(candidate({}, { enabled: true }));
    h.dbSelectRows = [[{ surface: 'chat', orgId: null }]];
    h.enableOffering.mockResolvedValue(row({ enabled: false }));
    const r = await setOfferingEnabled({ partnerId: P, offeringId: OFF, enabled: false, force: true });
    expect(r.inUse).toHaveLength(1);
  });
});

describe('ensurePlatformOffering', () => {
  it('inserts a disabled platform offering for an offered platform model', async () => {
    h.getPlatformModelById.mockResolvedValue({ id: 'pm-1', platformOffered: true, lifecycle: 'available' });
    h.dbInsertReturning.mockResolvedValue([row()]);
    const o = await ensurePlatformOffering({ partnerId: P, platformModelId: 'pm-1', enabled: false });
    expect([o.enabled, o.source]).toEqual([false, 'platform']);
  });
  it('returns the existing row on conflict (idempotent)', async () => {
    h.getPlatformModelById.mockResolvedValue({ id: 'pm-1', platformOffered: true, lifecycle: 'available' });
    h.dbInsertReturning.mockResolvedValue([]);
    h.dbSelectRows = [[row()]];
    expect((await ensurePlatformOffering({ partnerId: P, platformModelId: 'pm-1', enabled: false })).id).toBe(OFF);
  });
  it('refuses a platform model the operator does not offer', async () => {
    h.getPlatformModelById.mockResolvedValue({ id: 'pm-1', platformOffered: false, lifecycle: 'available' });
    const err = await ensurePlatformOffering({ partnerId: P, platformModelId: 'pm-1', enabled: false }).catch((e) => e);
    expect([err.status, err.code]).toEqual([409, 'not_eligible']);
  });
});

describe('updateOfferingDetails', () => {
  const at = UPDATED.toISOString();
  beforeEach(() => {
    h.getOffering.mockResolvedValue(row());
    h.loadOfferingCandidate.mockResolvedValue(candidate());
    h.dbUpdateReturning.mockResolvedValue([row({ updatedAt: new Date() })]);
  });

  it('409s a stale write', async () => {
    const err = await updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: { expectedUpdatedAt: '2026-09-30T00:00:00.000Z', displayName: 'x' } }).catch((e) => e);
    expect([err.status, err.code]).toEqual([409, 'stale_write']);
  });

  it('refuses prices on a platform offering (prices are read from the platform row)', async () => {
    const err = await updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: { expectedUpdatedAt: at, prices: RATES } }).catch((e) => e);
    expect([err.status, err.code, err.details.field]).toEqual([422, 'invalid', 'prices']);
  });

  it('accepts zero prices (valid for local models) on a discovered offering', async () => {
    h.getOffering.mockResolvedValue(row({ source: 'discovered', connectionId: 'c-1', platformModelId: null, modelId: 'm' }));
    await updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: { expectedUpdatedAt: at, prices: { inputCentsPerM: 0, outputCentsPerM: 0, cacheReadCentsPerM: 0, cacheWriteCentsPerM: 0 } } });
    expect(h.dbUpdateReturning).toHaveBeenCalled();
  });

  it('refuses clearing the only price of an enabled connection offering (409 unpriced)', async () => {
    h.getOffering.mockResolvedValue(row({ source: 'discovered', connectionId: 'c-1', platformModelId: null, modelId: 'm', enabled: true, priceInputCentsPerM: 300 }));
    h.loadOfferingCandidate.mockResolvedValue(candidate({}, { rate: { source: 'offering', standard: RATES } }));
    const err = await updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: { expectedUpdatedAt: at, prices: null } }).catch((e) => e);
    expect([err.status, err.code]).toEqual([409, 'unpriced']);
  });

  it('rejects allowed options with an empty intersection with model support', async () => {
    const err = await updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: { expectedUpdatedAt: at, allowedOptions: { effort: ['max'] } } }).catch((e) => e);
    expect([err.status, err.details]).toEqual([422, { field: 'allowedOptions', key: 'effort' }]);
  });

  it('rejects a default option outside allowed ∩ support', async () => {
    const err = await updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: {
      expectedUpdatedAt: at, allowedOptions: { effort: ['low', 'medium'] }, defaultOptions: { effort: 'high' },
    } }).catch((e) => e);
    expect([err.status, err.details]).toEqual([422, { field: 'defaultOptions', key: 'effort' }]);
  });

  it('rejects speed fast on a model with no fast rate', async () => {
    const err = await updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: { expectedUpdatedAt: at, defaultOptions: { speed: 'fast' } } }).catch((e) => e);
    expect([err.status, err.details.key]).toEqual([422, 'speed']);
  });

  it.each([
    ['on a different connection', candidate({ offeringId: FB, connectionId: 'c-2', funding: 'partner_key' }, { enabled: true }), 'different_connection'],
    ['disabled', candidate({ offeringId: FB }, { enabled: false }), 'disabled'],
    ['unpriced', candidate({ offeringId: FB }, { enabled: true, rate: null }), 'unpriced'],
  ])('rejects a refusal fallback that is %s', async (_l, fb, reason) => {
    h.loadOfferingCandidate.mockImplementation(async (id: string) => (id === FB ? fb : candidate()));
    const err = await updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: { expectedUpdatedAt: at, refusalFallbackOfferingId: FB } }).catch((e) => e);
    expect([err.status, err.code, err.details.reason]).toEqual([422, 'not_eligible', reason]);
  });

  it('rejects the offering as its own refusal fallback', async () => {
    const err = await updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: { expectedUpdatedAt: at, refusalFallbackOfferingId: OFF } }).catch((e) => e);
    expect(err.details.reason).toBe('self');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/offeringWrites.test.ts`
Expected: FAIL, `Cannot find module './offeringWrites'`.

- [ ] **Step 3: Write the implementation**

`apps/api/src/services/aiModels/offeringWrites.ts`:

```ts
/**
 * Partner offering writes for /ai/models (W04, #7602). Every function runs in
 * the caller's request DB context (RLS as the partner). The route gates it on
 * BILLING_MANAGE + canManagePartnerWidePolicies + MFA, and runs
 * ensurePartnerCutover first. All gates reuse W03's rule table via
 * checkEnableEligibility, and DB failures go through toRegistryWriteError.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { AiSurface, OfferingDetailsPatch, OfferingOptions } from '@breeze/shared';
import { db } from '../../db';
import { aiModelAssignments, partnerAiModels } from '../../db/schema';
import { isHosted } from '../../config/env';
import { loadOfferingCandidate, loadPartnerFacts, type LoadedCandidate } from './candidateLoader';
import { checkEnableEligibility, type CandidateFacts, type EnableEligibilityContext, type PartnerPlan } from './eligibility';
import { enableOffering, getOffering, offeringPriceSource, type Offering } from './offerings';
import { getPlatformModelById, type PlatformModel } from './platformModels';
import { platformRateSnapshot } from './pricing';
import { deriveCapabilities } from './capabilities';
import { RegistryWriteError, toRegistryWriteError } from './registryWriteErrors';

export interface OfferingInUse { surface: AiSurface; level: 'partner' | 'org'; orgId: string | null }

async function loadOwned(partnerId: string, offeringId: string): Promise<LoadedCandidate> {
  const c = await loadOfferingCandidate(offeringId, partnerId);
  if (!c) throw new RegistryWriteError('Model not found.', 'not_found', 404);
  return c;
}

export async function enableEligibilityContext(partnerId: string): Promise<EnableEligibilityContext> {
  const { plan } = await loadPartnerFacts(partnerId);
  return { partnerId, partnerPlan: plan, hosted: isHosted() };
}

export async function listOfferingDefaultUses(partnerId: string, offeringId: string): Promise<OfferingInUse[]> {
  const rows = await db
    .select({ surface: aiModelAssignments.surface, orgId: aiModelAssignments.orgId })
    .from(aiModelAssignments)
    .where(and(
      eq(aiModelAssignments.offeringPartnerId, partnerId),
      eq(aiModelAssignments.defaultOfferingId, offeringId),
    ));
  return rows.map((r) => ({
    surface: r.surface as AiSurface,
    level: r.orgId === null ? 'partner' : 'org',
    orgId: r.orgId,
  }));
}

/**
 * Eligibility facts for a platform model the partner has not added yet. These are
 * the same facts W03's loader builds for a platform offering. Exported for
 * registryView (enableBlocker on synthesized rows).
 */
export function platformCandidateFacts(partnerId: string, pm: PlatformModel): CandidateFacts {
  return {
    ownerPartnerId: partnerId, enabled: false, lifecycle: 'available', requiredPermission: null,
    platform: { platformOffered: pm.platformOffered, lifecycle: pm.lifecycle, minPlan: pm.minPlan as PartnerPlan | null },
    connection: { kind: 'platform', status: 'active', keyUsable: true }, catalog: null,
    rate: platformRateSnapshot(pm), supportsTools: deriveCapabilities(pm.capabilities).supportsTools,
    inferenceGeo: null, supportedInferenceGeos: pm.optionSupport.inferenceGeo,
  };
}

/** Fast mode is selectable on this platform model (supported + rated). */
function platformFastSelectable(pm: PlatformModel): boolean {
  return pm.optionSupport.speed.includes('fast') && Boolean(pm.optionRates?.['speed:fast']);
}

/**
 * Adds the partner's platform offering, optionally enabled, in ONE statement.
 * The enable gate runs on facts built from the platform row, NOT through
 * loadOfferingCandidate: the loader reads through its own system transaction
 * and cannot see a row this request inserted but has not committed yet (Q13,
 * Codex review finding 3).
 * Spec §15 #7: a new offering whose model supports fast mode starts with
 * allowed speed ['standard']. Fast is opted into deliberately in the drawer,
 * behind the premium permission (updateOfferingDetails).
 */
export async function ensurePlatformOffering(input: { partnerId: string; platformModelId: string; enabled: boolean }): Promise<Offering> {
  const platform = await getPlatformModelById(input.platformModelId);
  if (!platform || !platform.platformOffered || platform.lifecycle !== 'available') {
    throw new RegistryWriteError('This model is not offered on the platform.', 'not_eligible', 409, { reason: 'model_unavailable' });
  }
  if (input.enabled) {
    const reason = checkEnableEligibility(platformCandidateFacts(input.partnerId, platform), await enableEligibilityContext(input.partnerId));
    if (reason) throw new RegistryWriteError('This model cannot be enabled.', 'not_eligible', 409, { reason });
  }
  try {
    const [inserted] = await db
      .insert(partnerAiModels)
      .values({
        partnerId: input.partnerId,
        connectionId: null,
        platformModelId: input.platformModelId,
        modelId: null,
        source: 'platform',
        enabled: input.enabled,
        allowedOptions: platformFastSelectable(platform) ? { speed: ['standard'] } : null,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) return inserted;
    // Already added (a committed row): enable through the normal gated path.
    const [existing] = await db
      .select()
      .from(partnerAiModels)
      .where(and(
        eq(partnerAiModels.partnerId, input.partnerId),
        eq(partnerAiModels.platformModelId, input.platformModelId),
        isNull(partnerAiModels.connectionId),
      ))
      .limit(1);
    if (!existing) throw new RegistryWriteError('Could not add the model.', 'write_failed', 500);
    if (input.enabled && !existing.enabled) {
      return (await setOfferingEnabled({ partnerId: input.partnerId, offeringId: existing.id, enabled: true, force: false })).offering;
    }
    return existing;
  } catch (error) {
    toRegistryWriteError(error, 'Could not add the model.');
  }
}

export async function setOfferingEnabled(input: {
  partnerId: string; offeringId: string; enabled: boolean; force: boolean;
}): Promise<{ offering: Offering; inUse: OfferingInUse[] }> {
  const candidate = await loadOwned(input.partnerId, input.offeringId);
  let inUse: OfferingInUse[] = [];
  if (input.enabled) {
    const reason = checkEnableEligibility(candidate.facts, await enableEligibilityContext(input.partnerId));
    if (reason) throw new RegistryWriteError('This model cannot be enabled.', 'not_eligible', 409, { reason });
  } else {
    inUse = await listOfferingDefaultUses(input.partnerId, input.offeringId);
    if (inUse.length > 0 && !input.force) {
      throw new RegistryWriteError(
        'This model is the default for one or more features. Choose another default first, or confirm.',
        'offering_in_use', 409, { inUse },
      );
    }
  }
  try {
    const offering = await enableOffering({ partnerId: input.partnerId, offeringId: input.offeringId, enabled: input.enabled });
    return { offering, inUse };
  } catch (error) {
    toRegistryWriteError(error, 'Could not change the model.');
  }
}

type OptionKey = 'effort' | 'thinkingDisplay' | 'speed';
export const OPTION_KEYS: readonly OptionKey[] = ['effort', 'thinkingDisplay', 'speed'];

/** Support for one option key; `fast` only counts when the model has a fast rate (§8). Shared with assignmentWrites. */
export function supportedOptionValues(c: LoadedCandidate, key: OptionKey): readonly string[] {
  const base = (c.optionSupport[key] ?? []) as readonly string[];
  if (key === 'speed') return base.filter((s) => s !== 'fast' || Boolean(c.optionRates?.['speed:fast']));
  return base;
}

type ProposedAllowed = OfferingDetailsPatch['allowedOptions'] | null;

/**
 * Validates the COMPLETE proposed option state, whichever fields the patch
 * touches (Codex review findings 7, 9):
 *  - allowed lists must intersect support, and defaults must lie in allowed ∩ support;
 *  - fast counts as supported only while a fast rate will exist after the write
 *    (W03 loader: own prices carry no option rates, Q14);
 *  - spec §15 #7: on a PLATFORM-funded offering, a selectable fast mode needs
 *    the premium permission.
 */
function validateProposedOptions(
  c: LoadedCandidate,
  proposed: { allowed: ProposedAllowed; defaults: OfferingOptions | null; requiredPermission: string | null; fastRated: boolean },
): void {
  for (const key of OPTION_KEYS) {
    const support = key === 'speed'
      ? ((c.optionSupport.speed ?? []) as readonly string[]).filter((s) => s !== 'fast' || proposed.fastRated)
      : supportedOptionValues(c, key);
    const allow = proposed.allowed?.[key] as readonly string[] | undefined;
    if (allow && !allow.some((v) => support.includes(v))) {
      throw new RegistryWriteError('None of those options is supported by this model.', 'invalid', 422, { field: 'allowedOptions', key });
    }
    const value = proposed.defaults?.[key] as string | undefined;
    if (value !== undefined && (!support.includes(value) || (allow && !allow.includes(value)))) {
      throw new RegistryWriteError('That default is not available for this model.', 'invalid', 422, { field: 'defaultOptions', key });
    }
  }
  const fastSelectable = proposed.fastRated
    && (c.optionSupport.speed ?? []).includes('fast')
    && (!proposed.allowed?.speed || proposed.allowed.speed.includes('fast'));
  if (fastSelectable && c.funding === 'platform' && proposed.requiredPermission === null) {
    throw new RegistryWriteError(
      'Fast mode on Breeze credits needs the premium-model permission. Require it, or allow only standard speed.',
      'invalid', 422, { field: 'requiredPermission', reason: 'fast_requires_permission' },
    );
  }
}

async function validateRefusalFallback(partnerId: string, self: LoadedCandidate, fallbackId: string): Promise<void> {
  const fail = (reason: string): never => {
    throw new RegistryWriteError('That model cannot be the refusal fallback.', 'not_eligible', 422, { field: 'refusalFallbackOfferingId', reason });
  };
  if (fallbackId === self.offeringId) fail('self');
  const fb = await loadOfferingCandidate(fallbackId, partnerId);
  if (!fb) return fail('not_found');
  if (fb.connectionId !== self.connectionId || fb.funding !== self.funding) fail('different_connection');
  if (!fb.facts.enabled) fail('disabled');
  const reason = checkEnableEligibility(fb.facts, await enableEligibilityContext(partnerId));
  if (reason) fail(reason);
}

/**
 * Version token for optimistic concurrency. Postgres stores microseconds and
 * the DTO carries ISO milliseconds, so the comparison is made at ms precision
 * on both sides (Codex review finding 6). W04 writes `updatedAt: new Date()`
 * (ms precision), so every row W04 has written compares exactly. Two writes
 * inside one millisecond are the only residual window; accepted, because a
 * version column would need a migration this wave does not take.
 */
export function sameVersion(stored: Date, expectedIso: string): boolean {
  return stored.toISOString() === new Date(expectedIso).toISOString();
}

export async function updateOfferingDetails(input: {
  partnerId: string; offeringId: string; patch: OfferingDetailsPatch;
}): Promise<Offering> {
  const { patch } = input;
  const current = await getOffering(input.offeringId);
  if (!current || current.partnerId !== input.partnerId) throw new RegistryWriteError('Model not found.', 'not_found', 404);
  if (!sameVersion(current.updatedAt, patch.expectedUpdatedAt)) {
    throw new RegistryWriteError('This model was changed by someone else. Reload and try again.', 'stale_write', 409);
  }
  const candidate = await loadOwned(input.partnerId, input.offeringId);

  const set: Partial<typeof partnerAiModels.$inferInsert> = { updatedAt: new Date() };
  if (patch.displayName !== undefined) set.displayName = patch.displayName;

  let fastRated = Boolean(candidate.optionRates?.['speed:fast']);
  if (patch.prices !== undefined) {
    const editable = current.source === 'discovered' || current.source === 'manual';
    if (!editable) {
      throw new RegistryWriteError('This model’s price comes from the platform or the catalog.', 'invalid', 422, { field: 'prices' });
    }
    if (patch.prices === null && current.enabled) {
      // §8 precedence after clearing the offering's own price: catalog snapshot,
      // then the linked platform row (Codex review finding 10).
      const linked = current.platformModelId ? await getPlatformModelById(current.platformModelId) : null;
      const remaining = offeringPriceSource({ ...current, priceInputCentsPerM: null }, {
        platformRowPriced: Boolean(linked?.rates),
        catalogMapsAndVerifies: candidate.facts.catalog?.usable === true,
      });
      if (!remaining) throw new RegistryWriteError('An enabled model needs a price. Disable it first.', 'unpriced', 409);
    }
    // Own prices carry no fast-mode rate (Q14). Setting them makes fast unselectable.
    if (patch.prices !== null) fastRated = false;
    set.priceInputCentsPerM = patch.prices?.inputCentsPerM ?? null;
    set.priceOutputCentsPerM = patch.prices?.outputCentsPerM ?? null;
    set.priceCacheReadCentsPerM = patch.prices?.cacheReadCentsPerM ?? null;
    set.priceCacheWriteCentsPerM = patch.prices?.cacheWriteCentsPerM ?? null;
  }

  // Always validate the full proposed state, not only the fields in the patch.
  validateProposedOptions(candidate, {
    allowed: patch.allowedOptions !== undefined ? patch.allowedOptions : (current.allowedOptions as ProposedAllowed),
    defaults: patch.defaultOptions !== undefined ? patch.defaultOptions : (current.defaultOptions as OfferingOptions | null),
    requiredPermission: patch.requiredPermission !== undefined ? patch.requiredPermission : current.requiredPermission,
    fastRated,
  });
  if (patch.allowedOptions !== undefined) set.allowedOptions = patch.allowedOptions as Record<string, unknown> | null;
  if (patch.defaultOptions !== undefined) set.defaultOptions = patch.defaultOptions as Record<string, unknown> | null;
  if (patch.requiredPermission !== undefined) set.requiredPermission = patch.requiredPermission;

  if (patch.refusalFallbackOfferingId !== undefined) {
    if (patch.refusalFallbackOfferingId !== null) {
      await validateRefusalFallback(input.partnerId, candidate, patch.refusalFallbackOfferingId);
    }
    set.refusalFallbackOfferingId = patch.refusalFallbackOfferingId;
  }

  try {
    const [updated] = await db
      .update(partnerAiModels)
      .set(set)
      .where(and(
        eq(partnerAiModels.id, input.offeringId),
        eq(partnerAiModels.partnerId, input.partnerId),
        sql`date_trunc('milliseconds', ${partnerAiModels.updatedAt}) = ${new Date(patch.expectedUpdatedAt).toISOString()}::timestamptz`,
      ))
      .returning();
    if (!updated) throw new RegistryWriteError('This model was changed by someone else. Reload and try again.', 'stale_write', 409);
    return updated;
  } catch (error) {
    toRegistryWriteError(error, 'Could not save the model.');
  }
}
```

Add `sql` to the `drizzle-orm` import. Add these cases to the Step 1 tests:

```ts
it('accepts expectedUpdatedAt for a row whose DB timestamp has microseconds (ms-precision compare)', async () => {
  h.getOffering.mockResolvedValue(row({ updatedAt: new Date('2026-10-01T10:00:00.123Z') })); // pg value …00.123456 truncates to this
  await updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: { expectedUpdatedAt: '2026-10-01T10:00:00.123Z', displayName: 'x' } });
  expect(h.dbUpdateReturning).toHaveBeenCalled();
});

it('setting own prices drops fast: an existing fast default is rejected against the proposed state', async () => {
  h.getOffering.mockResolvedValue(row({ source: 'discovered', connectionId: 'c-1', platformModelId: 'pm-1', modelId: 'm', defaultOptions: { speed: 'fast' } }));
  h.loadOfferingCandidate.mockResolvedValue(candidate({ funding: 'partner_key', optionRates: { 'speed:fast': RATES },
    optionSupport: { effort: [], thinkingDisplay: [], speed: ['standard', 'fast'], inferenceGeo: [] } }, { rate: { source: 'linked_platform', standard: RATES } }));
  const err = await updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: { expectedUpdatedAt: at, prices: RATES } }).catch((e) => e);
  expect([err.status, err.details]).toEqual([422, { field: 'defaultOptions', key: 'speed' }]);
});

it('spec §15 #7: allowing fast on a platform offering requires the premium permission', async () => {
  h.loadOfferingCandidate.mockResolvedValue(candidate({ optionRates: { 'speed:fast': RATES },
    optionSupport: { effort: [], thinkingDisplay: [], speed: ['standard', 'fast'], inferenceGeo: [] } }));
  h.getOffering.mockResolvedValue(row({ allowedOptions: { speed: ['standard'] }, requiredPermission: null }));
  const err = await updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: { expectedUpdatedAt: at, allowedOptions: { speed: ['standard', 'fast'] } } }).catch((e) => e);
  expect([err.status, err.details.reason]).toEqual([422, 'fast_requires_permission']);
  await expect(updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: {
    expectedUpdatedAt: at, allowedOptions: { speed: ['standard', 'fast'] }, requiredPermission: 'ai_models:premium',
  } })).resolves.toBeDefined();
});

it('a rename never clears option restrictions (untouched fields keep their stored value)', async () => {
  h.getOffering.mockResolvedValue(row({ allowedOptions: { speed: ['standard'] } }));
  await updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: { expectedUpdatedAt: at, displayName: 'Renamed' } });
  expect(h.lastSet).not.toHaveProperty('allowedOptions');
});

it('clearing own prices on an enabled offering is allowed when the linked platform row is priced', async () => {
  h.getOffering.mockResolvedValue(row({ source: 'discovered', connectionId: 'c-1', platformModelId: 'pm-1', modelId: 'm', enabled: true, priceInputCentsPerM: 300 }));
  h.getPlatformModelById.mockResolvedValue({ id: 'pm-1', rates: RATES });
  h.loadOfferingCandidate.mockResolvedValue(candidate({ funding: 'partner_key' }, { rate: { source: 'offering', standard: RATES } }));
  await expect(updateOfferingDetails({ partnerId: P, offeringId: OFF, patch: { expectedUpdatedAt: at, prices: null } })).resolves.toBeDefined();
});
```

(`h.lastSet` is recorded by the `db.update().set(s)` mock.) The earlier "refuses clearing the only price" case keeps `h.getPlatformModelById` resolving `null`. Add to the `ensurePlatformOffering` describe:

```ts
it('adds AND enables in one insert (never loads its own uncommitted row)', async () => {
  h.getPlatformModelById.mockResolvedValue({ id: 'pm-1', platformOffered: true, lifecycle: 'available', minPlan: null, rates: RATES, optionRates: null,
    optionSupport: { effort: [], thinkingDisplay: [], speed: ['standard'], inferenceGeo: [] }, capabilities: {} });
  h.dbInsertReturning.mockResolvedValue([row({ enabled: true })]);
  await ensurePlatformOffering({ partnerId: P, platformModelId: 'pm-1', enabled: true });
  expect(h.loadOfferingCandidate).not.toHaveBeenCalled();
  expect(h.insertedValues).toMatchObject({ enabled: true });
});
it('a fast-capable platform model starts with allowed speed [standard] (fast is a deliberate opt-in)', async () => {
  h.getPlatformModelById.mockResolvedValue({ id: 'pm-1', platformOffered: true, lifecycle: 'available', minPlan: null, rates: RATES,
    optionRates: { 'speed:fast': RATES }, optionSupport: { effort: [], thinkingDisplay: [], speed: ['standard', 'fast'], inferenceGeo: [] }, capabilities: {} });
  h.dbInsertReturning.mockResolvedValue([row()]);
  await ensurePlatformOffering({ partnerId: P, platformModelId: 'pm-1', enabled: false });
  expect(h.insertedValues.allowedOptions).toEqual({ speed: ['standard'] });
});
```

(`h.insertedValues` is recorded by the `db.insert().values(v)` mock.) Update the existing `ensurePlatformOffering` cases to pass `enabled: false`.


Edits to `partner-wide-write-coverage.test.ts`:
- Add `'services/aiModels/offeringWrites.ts': 'gated at routes/aiModels/offerings.ts (BILLING_MANAGE + canManagePartnerWidePolicies + MFA); partner-axis only, every write pinned to input.partnerId from auth'`.
- Reword `services/aiModels/offerings.ts` to `'enableOffering is reached from offeringWrites.ts (gated at routes/aiModels/offerings.ts: BILLING_MANAGE + canManagePartnerWidePolicies) and the W02/W03 projection. Partner-axis only, every write pinned to input.partnerId'`.
- Reword `services/aiModels/connections.ts` to `'createConnection is reached only through partnerLlmConfig/compatRemap, called from routes/aiProvider.ts and routes/aiModels/connections.ts (both gate canManagePartnerWidePolicies). Partner-axis only, partner id is always the caller\'s own'`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/aiModels/offeringWrites.test.ts src/__tests__/partner-wide-write-coverage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Stage `offeringWrites.ts`, `offeringWrites.test.ts`, `services/aiModels/index.ts` and `partner-wide-write-coverage.test.ts`. Commit with message `feat(ai-models): offering writes — add platform model, gated enable, refuse in-use disable, detail patch (#7602)`, ending in the Co-Authored-By trailer.

---

### Task 5: `assignmentWrites.ts` — partner "Defaults by feature" writes

**Files:**
- Create: `apps/api/src/services/aiModels/assignmentWrites.ts`
- Create: `apps/api/src/services/aiModels/assignmentWrites.test.ts`
- Modify: `apps/api/src/services/aiModels/index.ts` (`export * from './assignmentWrites';`)
- Modify: `apps/api/src/__tests__/partner-wide-write-coverage.test.ts` (entry for `assignmentWrites.ts`)

**Interfaces:**
- Consumes:
  - Task 2;
  - Task 3 `checkEnableEligibility`;
  - Task 4 `enableEligibilityContext`, `supportedOptionValues`;
  - W03 `loadOfferingCandidate`;
  - merged `aiModelAssignments`, `TOOL_REQUIRING_SURFACES`;
  - shared `PartnerAssignmentInput`.
- Produces:

```ts
export function listAssignmentRows(input: { partnerId: string; orgId?: string | null }): Promise<AiModelAssignmentRow[]>;
/** All-or-nothing: validates every row, then upserts in one transaction. Never writes fallback columns (W09). */
export function putPartnerAssignments(input: { partnerId: string; rows: PartnerAssignmentInput[] }): Promise<AiModelAssignmentRow[]>;
/** Shared by partner and org validation (Task 6). */
export function assertOfferingUsableForSurface(input: {
  partnerId: string; offeringId: string; surface: AiSurface; field: string;
  ctx: EnableEligibilityContext; cache: Map<string, LoadedCandidate | null>;
}): Promise<LoadedCandidate>;
export function assertOptionsSupported(surface: AiSurface, model: LoadedCandidate, options: OfferingOptions | null): void;
```

Partner-row validation. Every failure is a 422 with `details: { surface, field, … }`:
1. The default and every permitted id must be an offering of the partner, **enabled**, with `checkEnableEligibility === null`. Otherwise `not_eligible` with `reason`.
2. For `TOOL_REQUIRING_SURFACES`, the default and every permitted id need `facts.supportsTools`. Otherwise `tools_unsupported` (spec §7).
3. With a permitted list, the default must be in it. Otherwise `invalid` `{ field: 'defaultOfferingId' }`.
4. Each set `options` key must be supported by the default offering (`supportedOptionValues` ∩ its `allowedOptions`). Otherwise `invalid` `{ field: 'options', key }`.
5. `expectedUpdatedAt` must equal the existing partner row's `updatedAt`, or be `null` when there is none. Otherwise 409 `stale_write` `{ surface }`.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/aiModels/assignmentWrites.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  candidates: new Map<string, unknown>(),
  existingRows: [] as Array<Record<string, unknown>>,
  partnerRows: [] as Array<Record<string, unknown>>,
  upserts: [] as Array<{ kind: 'insert' | 'update'; values: Record<string, unknown> }>,
  deletes: [] as Array<unknown>,
  insertResult: null as unknown[] | null,   // null → echo the row; [] → a concurrent insert won
  updateResult: null as unknown[] | null,   // [] → a concurrent update won (version mismatch)
}));

vi.mock('./candidateLoader', () => ({
  loadOfferingCandidate: vi.fn(async (id: string) => h.candidates.get(id) ?? null),
  loadPartnerFacts: vi.fn(async () => ({ plan: 'pro', residencyRequired: false })),
}));
vi.mock('../../config/env', () => ({ isHosted: () => true }));
vi.mock('./assignmentRows', () => ({
  listAssignmentRows: vi.fn(async ({ orgId }: { orgId?: string | null }) =>
    orgId ? h.existingRows.filter((r) => r.orgId === orgId) : h.partnerRows),
}));
vi.mock('../../db', () => {
  const echo = (values: Record<string, unknown>) => [{ ...values, id: 'row', updatedAt: new Date() }];
  const tx = {
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => { h.upserts.push({ kind: 'insert', values }); return h.insertResult ?? echo(values); },
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => { h.upserts.push({ kind: 'update', values }); return h.updateResult ?? echo(values); },
        }),
      }),
    }),
    delete: () => ({ where: (w: unknown) => ({ returning: async () => { h.deletes.push(w); return [{ id: 'row' }]; } }) }),
  };
  return { db: { transaction: async (cb: (t: typeof tx) => unknown) => cb(tx) } };
});

import { putOrgAssignments, putPartnerAssignments, touchesSurface } from './assignmentWrites';

const P = '22222222-2222-4222-8222-222222222222';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const RATES = { inputCentsPerM: 300, outputCentsPerM: 1500, cacheReadCentsPerM: 30, cacheWriteCentsPerM: 375 };

function cand(factsOver: Record<string, unknown> = {}, over: Record<string, unknown> = {}) {
  return {
    connectionId: null, funding: 'platform', optionRates: null, allowedOptions: null, defaultOptions: null,
    optionSupport: { effort: ['low', 'medium', 'high', 'max'], thinkingDisplay: ['summarized'], speed: ['standard'], inferenceGeo: [] },
    facts: {
      ownerPartnerId: P, enabled: true, lifecycle: 'available', requiredPermission: null,
      platform: { platformOffered: true, lifecycle: 'available', minPlan: null },
      connection: { kind: 'platform', status: 'active', keyUsable: true }, catalog: null,
      rate: { source: 'platform', standard: RATES }, supportsTools: true, inferenceGeo: null, supportedInferenceGeos: [],
      ...factsOver,
    },
    ...over,
  };
}

beforeEach(() => {
  h.candidates.clear();
  h.existingRows = [];
  h.partnerRows = [];
  h.upserts = [];
  h.deletes = [];
  h.insertResult = null;
  h.updateResult = null;
});

describe('putPartnerAssignments', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    surface: 'chat' as const, role: 'default' as const, defaultOfferingId: A, permittedOfferingIds: null as string[] | null,
    allowUserChoice: true, options: null, expectedUpdatedAt: null as string | null, ...over,
  });

  it('upserts a valid row with offering_partner_id = partner, and never the fallback columns', async () => {
    h.candidates.set(A, cand());
    await putPartnerAssignments({ partnerId: P, rows: [row()] });
    expect(h.upserts[0].values).toMatchObject({ partnerId: P, orgId: null, offeringPartnerId: P, surface: 'chat', role: 'default', defaultOfferingId: A });
    expect(h.upserts[0].kind).toBe('insert');                 // expectedUpdatedAt null → insert-only
    expect(h.upserts[0].values).not.toHaveProperty('fallbackOfferingIds');
    expect(h.upserts[0].values).not.toHaveProperty('fallbackMayCrossFunding');
  });

  it('updates an existing row by version and never touches the fallback columns', async () => {
    h.candidates.set(A, cand());
    h.partnerRows = [{ id: 'r1', surface: 'chat', role: 'default', orgId: null, updatedAt: new Date('2026-10-01T10:00:00.000Z') }];
    await putPartnerAssignments({ partnerId: P, rows: [row({ expectedUpdatedAt: '2026-10-01T10:00:00.000Z' })] });
    expect(h.upserts[0].kind).toBe('update');
    expect(Object.keys(h.upserts[0].values)).not.toContain('fallbackOfferingIds');
  });

  it('a concurrent insert (row appeared after validation) is stale and rolls back the batch', async () => {
    h.candidates.set(A, cand());
    h.insertResult = [];
    const err = await putPartnerAssignments({ partnerId: P, rows: [row()] }).catch((e) => e);
    expect([err.status, err.code, err.details.surface]).toEqual([409, 'stale_write', 'chat']);
  });

  it('a concurrent update (version moved after validation) is stale', async () => {
    h.candidates.set(A, cand());
    h.partnerRows = [{ id: 'r1', surface: 'chat', role: 'default', orgId: null, updatedAt: new Date('2026-10-01T10:00:00.000Z') }];
    h.updateResult = [];
    const err = await putPartnerAssignments({ partnerId: P, rows: [row({ expectedUpdatedAt: '2026-10-01T10:00:00.000Z' })] }).catch((e) => e);
    expect([err.status, err.code]).toEqual([409, 'stale_write']);
  });

  it('rejects a default without tool support on a tool surface (spec §7)', async () => {
    h.candidates.set(A, cand({ supportsTools: false }));
    const err = await putPartnerAssignments({ partnerId: P, rows: [row()] }).catch((e) => e);
    expect([err.status, err.code, err.details]).toEqual([422, 'tools_unsupported', { surface: 'chat', field: 'defaultOfferingId', offeringId: A }]);
  });

  it('accepts a tool-less model on a non-tool surface', async () => {
    h.candidates.set(A, cand({ supportsTools: false }));
    await expect(putPartnerAssignments({ partnerId: P, rows: [row({ surface: 'catalog_enrichment' })] })).resolves.toBeDefined();
  });

  it('rejects a disabled permitted offering', async () => {
    h.candidates.set(A, cand());
    h.candidates.set(B, cand({ enabled: false }));
    const err = await putPartnerAssignments({ partnerId: P, rows: [row({ permittedOfferingIds: [A, B] })] }).catch((e) => e);
    expect([err.code, err.details.field, err.details.offeringId, err.details.reason]).toEqual(['not_eligible', 'permittedOfferingIds', B, 'disabled']);
  });

  it('rejects another partner’s offering as 422 not_eligible (loader returns null)', async () => {
    const err = await putPartnerAssignments({ partnerId: P, rows: [row()] }).catch((e) => e);
    expect([err.status, err.code, err.details.reason]).toEqual([422, 'not_eligible', 'not_found']);
  });

  it('rejects a default outside the permitted list', async () => {
    h.candidates.set(A, cand());
    h.candidates.set(B, cand());
    const err = await putPartnerAssignments({ partnerId: P, rows: [row({ permittedOfferingIds: [B] })] }).catch((e) => e);
    expect([err.code, err.details.field]).toEqual(['invalid', 'defaultOfferingId']);
  });

  it('rejects an effort the default model does not support', async () => {
    h.candidates.set(A, cand({}, { optionSupport: { effort: ['low'], thinkingDisplay: [], speed: ['standard'], inferenceGeo: [] } }));
    const err = await putPartnerAssignments({ partnerId: P, rows: [row({ options: { effort: 'max' } })] }).catch((e) => e);
    expect([err.code, err.details]).toEqual(['invalid', { surface: 'chat', field: 'options', key: 'effort' }]);
  });

  it('409s when expectedUpdatedAt does not match the stored row', async () => {
    h.candidates.set(A, cand());
    h.partnerRows = [{ id: 'r1', surface: 'chat', role: 'default', orgId: null, updatedAt: new Date('2026-10-01T10:00:00Z') }];
    const err = await putPartnerAssignments({ partnerId: P, rows: [row({ expectedUpdatedAt: null })] }).catch((e) => e);
    expect([err.status, err.code, err.details.surface]).toEqual([409, 'stale_write', 'chat']);
  });

  it('writes nothing when any row fails (all-or-nothing)', async () => {
    h.candidates.set(A, cand());
    await putPartnerAssignments({ partnerId: P, rows: [row(), row({ surface: 'helper', defaultOfferingId: B })] }).catch(() => undefined);
    expect(h.upserts).toHaveLength(0);
  });
});
```

All row reads go through `listAssignmentRows` in its own module, `assignmentRows.ts`, so the test mocks reads without depending on drizzle internals. The only `db` use left in `assignmentWrites.ts` is the write transaction.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/assignmentWrites.test.ts`
Expected: FAIL, `Cannot find module './assignmentWrites'`.

- [ ] **Step 3: Write the implementation**

`apps/api/src/services/aiModels/assignmentRows.ts`:

```ts
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { aiModelAssignments, type AiModelAssignmentRow } from '../../db/schema';

/** Raw partner rows (orgId omitted/null) or one org's override rows. Runs under the caller's RLS. */
export async function listAssignmentRows(input: { partnerId: string; orgId?: string | null }): Promise<AiModelAssignmentRow[]> {
  const owner = input.orgId
    ? and(eq(aiModelAssignments.orgId, input.orgId), eq(aiModelAssignments.offeringPartnerId, input.partnerId))
    : and(isNull(aiModelAssignments.orgId), eq(aiModelAssignments.partnerId, input.partnerId));
  return db.select().from(aiModelAssignments).where(owner);
}
```

`apps/api/src/services/aiModels/assignmentWrites.ts`:

```ts
/**
 * Assignment writes for /ai/models (W04, #7602): partner "Defaults by feature"
 * (this task) and org "Model defaults" overrides (Task 6). Tighten-only is
 * enforced HERE at write time (spec §5.4), not just clamped at read time by
 * mergeEffectiveAssignment. The fallback columns (W09) are never written.
 */
import { and, eq, sql } from 'drizzle-orm';
import { TOOL_REQUIRING_SURFACES, type AiSurface, type OfferingOptions, type PartnerAssignmentInput } from '@breeze/shared';
import { db } from '../../db';
import { aiModelAssignments, type AiModelAssignmentRow } from '../../db/schema';
import { loadOfferingCandidate, type LoadedCandidate } from './candidateLoader';
import { checkEnableEligibility, type EnableEligibilityContext } from './eligibility';
import { enableEligibilityContext, supportedOptionValues, OPTION_KEYS } from './offeringWrites';
import { listAssignmentRows } from './assignmentRows';
import { RegistryWriteError, toRegistryWriteError } from './registryWriteErrors';

export { listAssignmentRows };

const TOOL_SURFACES = new Set<string>(TOOL_REQUIRING_SURFACES);

export async function assertOfferingUsableForSurface(input: {
  partnerId: string; offeringId: string; surface: AiSurface; field: string;
  ctx: EnableEligibilityContext; cache: Map<string, LoadedCandidate | null>;
}): Promise<LoadedCandidate> {
  const { offeringId, surface, field } = input;
  let c = input.cache.get(offeringId);
  if (c === undefined) {
    c = await loadOfferingCandidate(offeringId, input.partnerId);
    input.cache.set(offeringId, c);
  }
  if (!c) throw new RegistryWriteError('That model is not available.', 'not_eligible', 422, { surface, field, offeringId, reason: 'not_found' });
  if (!c.facts.enabled) throw new RegistryWriteError('That model is not enabled.', 'not_eligible', 422, { surface, field, offeringId, reason: 'disabled' });
  const reason = checkEnableEligibility(c.facts, input.ctx);
  if (reason) throw new RegistryWriteError('That model is not available.', 'not_eligible', 422, { surface, field, offeringId, reason });
  if (TOOL_SURFACES.has(surface) && !c.facts.supportsTools) {
    throw new RegistryWriteError('This feature needs a model that can use tools.', 'tools_unsupported', 422, { surface, field, offeringId });
  }
  return c;
}

export function assertOptionsSupported(surface: AiSurface, model: LoadedCandidate, options: OfferingOptions | null): void {
  if (!options) return;
  for (const key of OPTION_KEYS) {
    const value = options[key] as string | undefined;
    if (value === undefined) continue;
    const support = supportedOptionValues(model, key);
    const allow = model.allowedOptions?.[key] as readonly string[] | undefined;
    if (!support.includes(value) || (allow && !allow.includes(value))) {
      throw new RegistryWriteError('The default model does not support that option.', 'invalid', 422, { surface, field: 'options', key });
    }
  }
}

export function assertNotStale(surface: string, existing: AiModelAssignmentRow | undefined, expected: string | null): void {
  const actual = existing ? existing.updatedAt.toISOString() : null;
  const want = expected === null ? null : new Date(expected).toISOString();
  if (actual !== want) {
    throw new RegistryWriteError('These defaults were changed by someone else. Reload and try again.', 'stale_write', 409, { surface });
  }
}

export async function putPartnerAssignments(input: { partnerId: string; rows: PartnerAssignmentInput[] }): Promise<AiModelAssignmentRow[]> {
  const ctx = await enableEligibilityContext(input.partnerId);
  const cache = new Map<string, LoadedCandidate | null>();
  const existing = await listAssignmentRows({ partnerId: input.partnerId });

  // Validate every row before writing anything (all-or-nothing).
  for (const row of input.rows) {
    assertNotStale(row.surface, existing.find((e) => e.surface === row.surface && e.role === row.role), row.expectedUpdatedAt);
    const def = await assertOfferingUsableForSurface({ partnerId: input.partnerId, offeringId: row.defaultOfferingId, surface: row.surface, field: 'defaultOfferingId', ctx, cache });
    for (const id of row.permittedOfferingIds ?? []) {
      await assertOfferingUsableForSurface({ partnerId: input.partnerId, offeringId: id, surface: row.surface, field: 'permittedOfferingIds', ctx, cache });
    }
    if (row.permittedOfferingIds && !row.permittedOfferingIds.includes(row.defaultOfferingId)) {
      throw new RegistryWriteError('The default must be one of the permitted models.', 'invalid', 422, { surface: row.surface, field: 'defaultOfferingId' });
    }
    assertOptionsSupported(row.surface, def, row.options);
  }

  try {
    return await db.transaction(async (tx) => {
      const out: AiModelAssignmentRow[] = [];
      for (const row of input.rows) {
        out.push(await conditionalUpsert(tx, { kind: 'partner', partnerId: input.partnerId }, row, {
          defaultOfferingId: row.defaultOfferingId,
          permittedOfferingIds: row.permittedOfferingIds,
          allowUserChoice: row.allowUserChoice,
          options: row.options as Record<string, unknown> | null,
        }));
      }
      return out;
    });
  } catch (error) {
    toRegistryWriteError(error, 'Could not save the defaults.');
  }
}

type AssignmentOwner = { kind: 'partner'; partnerId: string } | { kind: 'org'; orgId: string; partnerId: string };
type AssignmentValues = {
  defaultOfferingId: string | null; permittedOfferingIds: string[] | null;
  allowUserChoice: boolean | null; options: Record<string, unknown> | null;
};
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function ownerCondition(owner: AssignmentOwner) {
  return owner.kind === 'partner'
    ? and(isNull(aiModelAssignments.orgId), eq(aiModelAssignments.partnerId, owner.partnerId))
    : eq(aiModelAssignments.orgId, owner.orgId);
}

/** ms-precision version match (see offeringWrites.sameVersion). */
function versionMatches(expectedIso: string) {
  return sql`date_trunc('milliseconds', ${aiModelAssignments.updatedAt}) = ${new Date(expectedIso).toISOString()}::timestamptz`;
}

/**
 * Optimistic-concurrency write INSIDE the transaction (Codex review finding 5):
 *  - "no row expected" → INSERT … ON CONFLICT DO NOTHING; a concurrent insert wins → stale;
 *  - "row at version V" → UPDATE … WHERE updated_at ≈ V; a concurrent update wins → stale.
 * A stale row throws, which rolls back the whole batch (all-or-nothing).
 * Never writes fallback_offering_ids / fallback_may_cross_funding (W09).
 */
export async function conditionalUpsert(
  tx: Tx, owner: AssignmentOwner,
  row: { surface: string; role: string; expectedUpdatedAt: string | null },
  values: AssignmentValues,
): Promise<AiModelAssignmentRow> {
  const now = new Date();
  const stale = () => new RegistryWriteError('These defaults were changed by someone else. Reload and try again.', 'stale_write', 409, { surface: row.surface });
  if (row.expectedUpdatedAt === null) {
    const [inserted] = await tx
      .insert(aiModelAssignments)
      .values({
        orgId: owner.kind === 'org' ? owner.orgId : null,
        partnerId: owner.kind === 'partner' ? owner.partnerId : null,
        offeringPartnerId: owner.partnerId,
        surface: row.surface,
        role: row.role,
        ...values,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted) throw stale();
    return inserted;
  }
  const [updated] = await tx
    .update(aiModelAssignments)
    .set({ ...values, updatedAt: now })
    .where(and(
      ownerCondition(owner),
      eq(aiModelAssignments.surface, row.surface),
      eq(aiModelAssignments.role, row.role),
      versionMatches(row.expectedUpdatedAt),
    ))
    .returning();
  if (!updated) throw stale();
  return updated;
}

/** Clears an org override at version V (no-op when there was none). */
export async function conditionalDeleteOrgRow(
  tx: Tx, orgId: string, row: { surface: string; role: string; expectedUpdatedAt: string | null },
): Promise<void> {
  if (row.expectedUpdatedAt === null) return;
  const deleted = await tx
    .delete(aiModelAssignments)
    .where(and(
      eq(aiModelAssignments.orgId, orgId),
      eq(aiModelAssignments.surface, row.surface),
      eq(aiModelAssignments.role, row.role),
      versionMatches(row.expectedUpdatedAt),
    ))
    .returning({ id: aiModelAssignments.id });
  if (deleted.length === 0) {
    throw new RegistryWriteError('These defaults were changed by someone else. Reload and try again.', 'stale_write', 409, { surface: row.surface });
  }
}
}
```

The validation reads happen before the write transaction, so a small window exists between "offering enabled" and the upsert. It is safe for two reasons:
- the resolver re-filters to enabled, eligible rows at every dispatch (spec §5.4);
- the ownership trigger re-checks ownership in the same statement.

Add the coverage entry `'services/aiModels/assignmentWrites.ts': 'partner rows gated at routes/aiModels/assignments.ts (BILLING_MANAGE + canManagePartnerWidePolicies + MFA); org rows are org-scoped overrides gated at routes/aiModels/orgAssignments.ts (ORGS_WRITE + canAccessOrg + MFA) and can never write a partner row (org_id set, offering_partner_id from the org)'`. `assignmentRows.ts` only reads, so it needs no entry.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/aiModels/assignmentWrites.test.ts src/__tests__/partner-wide-write-coverage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Stage `assignmentRows.ts`, `assignmentWrites.ts`, `assignmentWrites.test.ts`, `services/aiModels/index.ts` and `partner-wide-write-coverage.test.ts`. Commit with message `feat(ai-models): partner Defaults-by-feature writes with tool, eligibility and option checks (#7602)`, ending in the Co-Authored-By trailer.

---

### Task 6: Org "Model defaults" writes — tighten-only enforced at write

**Files:**
- Modify: `apps/api/src/services/aiModels/assignmentWrites.ts` (append)
- Modify: `apps/api/src/services/aiModels/assignmentWrites.test.ts` (append)

**Interfaces:**
- Consumes: Task 5 helpers; merged `clampOrgOptions` (`assignments.ts`).
- Produces:

```ts
/** Writes one org's override rows. An all-null row deletes the override (inherit). Rejects every widening (422 widens_partner). */
export function putOrgAssignments(input: { partnerId: string; orgId: string; rows: OrgAssignmentInput[] }): Promise<AiModelAssignmentRow[]>;
export function touchesSurface(rows: Array<{ surface: string }>, surface: AiSurface): boolean;
```

Rules (spec §5.4 "Tighten-only merge"). `P` is the partner row for `(surface, 'default')`. When `P` is absent, the partner has no default for the surface: an org row may narrow `permitted` but may not set a default.

| Org field | Accepted when | Else |
|---|---|---|
| `permittedOfferingIds` (non-null) | Every id passes `assertOfferingUsableForSurface`, **and**, when `P.permitted_offering_ids` is a list, every id is in it. | 422 `widens_partner` `{ field: 'permittedOfferingIds', offeringId }` |
| `defaultOfferingId` (non-null) | `P` exists, **and** the id is in the effective permitted set (`P`'s set ∩ the org's set), **and** it passes `assertOfferingUsableForSurface`. | 422 `widens_partner` `{ field: 'defaultOfferingId' }` |
| `allowUserChoice` | `false` or `null`. zod already rejects `true`. | — |
| `options` (non-null) | `clampOrgOptions(P.options ?? {}, org.options)` reports no `org_effort_clamped`, `org_speed_clamped` or `invalid_org_options` warning, and each set key is supported by the effective default (`assertOptionsSupported`). | 422 `widens_partner` `{ field: 'options', key }` |
| all four `null` | Always. **Deletes** the org row: the override is cleared, and blank = inherit. | — |

- [ ] **Step 1: Write the failing tests**

Append to `assignmentWrites.test.ts`:

```ts
describe('putOrgAssignments — the org write rejects every widening', () => {
  const ORG = '55555555-5555-4555-8555-555555555555';
  const orgRow = (over: Record<string, unknown> = {}) => ({
    surface: 'chat' as const, role: 'default' as const, defaultOfferingId: null as string | null,
    permittedOfferingIds: null as string[] | null, allowUserChoice: null as false | null,
    options: null as Record<string, unknown> | null, expectedUpdatedAt: null as string | null, ...over,
  });
  beforeEach(() => {
    for (const id of [A, B, C]) h.candidates.set(id, cand());
    h.partnerRows = [{ surface: 'chat', role: 'default', orgId: null, defaultOfferingId: A, permittedOfferingIds: [A, B], allowUserChoice: true, options: { effort: 'medium' }, updatedAt: new Date() }];
  });

  it.each([
    ['a permitted id outside the partner set', { permittedOfferingIds: [A, C] }, 'permittedOfferingIds'],
    ['a default outside the partner set', { defaultOfferingId: C }, 'defaultOfferingId'],
    ['a default outside its own narrowed set', { permittedOfferingIds: [A], defaultOfferingId: B }, 'defaultOfferingId'],
    ['an effort above the partner', { options: { effort: 'high' } }, 'options'],
    ['fast when the partner has no fast', { options: { speed: 'fast' } }, 'options'],
  ])('rejects %s', async (_l, over, field) => {
    const err = await putOrgAssignments({ partnerId: P, orgId: ORG, rows: [orgRow(over)] }).catch((e) => e);
    expect([err.status, err.code, err.details.field]).toEqual([422, 'widens_partner', field]);
    expect(h.upserts).toHaveLength(0);
  });

  it('accepts a narrowing (subset, default inside it, lower effort, user choice locked)', async () => {
    await putOrgAssignments({ partnerId: P, orgId: ORG, rows: [orgRow({ permittedOfferingIds: [B], defaultOfferingId: B, options: { effort: 'low' }, allowUserChoice: false })] });
    expect(h.upserts[0].values).toMatchObject({ orgId: ORG, partnerId: null, offeringPartnerId: P, permittedOfferingIds: [B], defaultOfferingId: B, allowUserChoice: false });
  });

  it('an all-blank row deletes the override (blank = inherit)', async () => {
    h.existingRows = [{ id: 'o1', surface: 'chat', role: 'default', orgId: ORG, updatedAt: new Date('2026-10-01T10:00:00Z') }];
    await putOrgAssignments({ partnerId: P, orgId: ORG, rows: [orgRow({ expectedUpdatedAt: '2026-10-01T10:00:00.000Z' })] });
    expect(h.deletes).toHaveLength(1);
    expect(h.upserts).toHaveLength(0);
  });

  it('refuses a default when the partner has no row for the surface', async () => {
    h.partnerRows = [];
    const err = await putOrgAssignments({ partnerId: P, orgId: ORG, rows: [orgRow({ defaultOfferingId: A })] }).catch((e) => e);
    expect([err.code, err.details.field]).toEqual(['widens_partner', 'defaultOfferingId']);
  });

  it('touchesSurface detects the reviewer surface', () => {
    expect(touchesSurface([{ surface: 'chat' }, { surface: 'script_reviewer' }], 'script_reviewer')).toBe(true);
    expect(touchesSurface([{ surface: 'chat' }], 'script_reviewer')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/assignmentWrites.test.ts -t putOrgAssignments`
Expected: FAIL, `putOrgAssignments is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `assignmentWrites.ts`, adding `import type { OrgAssignmentInput } from '@breeze/shared';` and `import { clampOrgOptions } from './assignments';` to the top import block:

```ts
export function touchesSurface(rows: Array<{ surface: string }>, surface: AiSurface): boolean {
  return rows.some((r) => r.surface === surface);
}

function widens(surface: string, field: string, extra: Record<string, unknown> = {}): never {
  throw new RegistryWriteError('An organization can only narrow the partner’s defaults.', 'widens_partner', 422, { surface, field, ...extra });
}

function isBlank(row: OrgAssignmentInput): boolean {
  return row.defaultOfferingId === null && row.permittedOfferingIds === null && row.allowUserChoice === null && row.options === null;
}

export async function putOrgAssignments(input: { partnerId: string; orgId: string; rows: OrgAssignmentInput[] }): Promise<AiModelAssignmentRow[]> {
  const ctx = await enableEligibilityContext(input.partnerId);
  const cache = new Map<string, LoadedCandidate | null>();
  const partnerRows = await listAssignmentRows({ partnerId: input.partnerId });
  const orgRows = await listAssignmentRows({ partnerId: input.partnerId, orgId: input.orgId });

  for (const row of input.rows) {
    assertNotStale(row.surface, orgRows.find((r) => r.surface === row.surface && r.role === row.role), row.expectedUpdatedAt);
    if (isBlank(row)) continue;
    const p = partnerRows.find((r) => r.surface === row.surface && r.role === row.role);
    const partnerSet = p?.permittedOfferingIds ?? null; // null = every enabled offering

    for (const id of row.permittedOfferingIds ?? []) {
      await assertOfferingUsableForSurface({ partnerId: input.partnerId, offeringId: id, surface: row.surface, field: 'permittedOfferingIds', ctx, cache });
      if (partnerSet && !partnerSet.includes(id)) widens(row.surface, 'permittedOfferingIds', { offeringId: id });
    }

    let effectiveDefault: LoadedCandidate | null = null;
    if (row.defaultOfferingId !== null) {
      if (!p) widens(row.surface, 'defaultOfferingId');
      const inPartner = !partnerSet || partnerSet.includes(row.defaultOfferingId);
      const inOrg = !row.permittedOfferingIds || row.permittedOfferingIds.includes(row.defaultOfferingId);
      if (!inPartner || !inOrg) widens(row.surface, 'defaultOfferingId');
      effectiveDefault = await assertOfferingUsableForSurface({ partnerId: input.partnerId, offeringId: row.defaultOfferingId, surface: row.surface, field: 'defaultOfferingId', ctx, cache });
    } else if (p?.defaultOfferingId) {
      effectiveDefault = await loadOfferingCandidate(p.defaultOfferingId, input.partnerId);
    }

    if (row.options) {
      const { warnings } = clampOrgOptions((p?.options ?? {}) as OfferingOptions, row.options);
      if (warnings.includes('org_effort_clamped')) widens(row.surface, 'options', { key: 'effort' });
      if (warnings.includes('org_speed_clamped')) widens(row.surface, 'options', { key: 'speed' });
      if (warnings.includes('invalid_org_options')) widens(row.surface, 'options');
      if (effectiveDefault) assertOptionsSupported(row.surface, effectiveDefault, row.options);
    }
  }

  try {
    return await db.transaction(async (tx) => {
      const out: AiModelAssignmentRow[] = [];
      for (const row of input.rows) {
        if (isBlank(row)) {
          await conditionalDeleteOrgRow(tx, input.orgId, row);
          continue;
        }
        out.push(await conditionalUpsert(tx, { kind: 'org', orgId: input.orgId, partnerId: input.partnerId }, row, {
          defaultOfferingId: row.defaultOfferingId,
          permittedOfferingIds: row.permittedOfferingIds,
          allowUserChoice: row.allowUserChoice,
          options: row.options as Record<string, unknown> | null,
        }));
      }
      return out;
    });
  } catch (error) {
    toRegistryWriteError(error, 'Could not save the organization’s model defaults.');
  }
}
```

`input.partnerId` is the org's partner. The route (Task 9) passes `readOrgPartnerId(orgId)` and refuses a partner-scope caller whose `auth.partnerId` differs. The composite FK `(org_id, offering_partner_id) → organizations(id, partner_id)` turns any mismatch into a 23503, which maps to 422.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/aiModels/assignmentWrites.test.ts`
Expected: PASS (Task 5 + Task 6 cases).

- [ ] **Step 5: Commit**

Stage `assignmentWrites.ts` and `assignmentWrites.test.ts`. Commit with message `feat(ai-models): org model-default overrides, tighten-only enforced at write (#7602)`, ending in the Co-Authored-By trailer.

---

### Task 7: Residency (with impact preview), connection settings, and one home for `settings.ai`

W03 added `PartnerSettings.ai.residencyRequired` and its reader, but no writer (Q9). W04 adds the only writer.

`PATCH /orgs/partners/me` already strips `settings.ai`:
- `partnerSettingsSchema` is a non-passthrough `z.object` (`routes/orgs.ts:707`);
- its merge is shallow (`{...current, ...body.settings}`), so the stored value survives.

A regression test pins that, so the residency switch stays the concept's single home (settings rule 1).

**Files:**
- Create: `apps/api/src/services/aiModels/residency.ts` + `residency.test.ts`
- Create: `apps/api/src/services/aiModels/connectionSettings.ts` + `connectionSettings.test.ts`
- Modify: `apps/api/src/services/aiModels/index.ts`
- Modify: `apps/api/src/__tests__/partner-wide-write-coverage.test.ts` (entry for `connectionSettings.ts`)
- Modify: the existing `PATCH /orgs/partners/me` test. Find it with `git grep -ln "partners/me" apps/api/src/routes/*.test.ts`.
- Modify: `apps/api/src/routes/orgs.ts`, the **system** `PATCH /orgs/partners/:id` handler (wholesale `settings: z.any()` replace, ~L1371-1400) (Codex review finding 11). Next to `preserveIpAllowlistOnOmit`, add a reserved-subtree guard so this path can neither erase nor set `settings.ai`:

  ```ts
  // settings.ai is owned by /ai/models/residency (one home, W04 #7602): a
  // wholesale settings write keeps the stored subtree and ignores any incoming one.
  if (currentPartner) {
    const next = updates.settings as Record<string, unknown>;
    const stored = (currentPartner.settings as Record<string, unknown> | null)?.ai;
    if (stored === undefined) delete next.ai; else next.ai = stored;
  }
  ```

  Add the matching test to that handler's test file: a system PATCH with settings lacking `ai` keeps `{ ai: { residencyRequired: true } }`, and one carrying `ai: { residencyRequired: false }` is ignored.

**Interfaces:**
- Consumes:
  - W03 `loadPartnerFacts`, `loadOfferingCandidate`, `checkEligibility`, `defaultTransport`, `transportCarries` (Q1–Q3);
  - Task 5 `listAssignmentRows`;
  - merged `partners`, `partnerAiConnections`, `getConnection`.
- Produces:

```ts
export function previewResidencyImpact(partnerId: string): Promise<AiResidencyImpactDto>;
/** Turning residency on with a non-empty impact needs acknowledgeImpact, else 409 'not_eligible' { unavailableSurfaces }. */
export function setResidencyRequired(input: { partnerId: string; required: boolean; acknowledgeImpact: boolean }):
  Promise<{ residencyRequired: boolean; impact: AiResidencyImpactDto }>;
/** name / inferenceGeo; bumps config_version when the geo changes, so live SDK queries are rebuilt (spec §9.2). */
export function updateConnectionSettings(input: { partnerId: string; connectionId: string; patch: ConnectionSettingsPatch }):
  Promise<PartnerAiConnection>;
```

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/aiModels/residency.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  candidates: new Map<string, unknown>(),
  carries: { agent_sdk: false, messages_api: false } as Record<string, boolean>,
  partnerUpdates: [] as Array<{ setSql: string }>,
  orgRows: [] as Array<{ orgId: string; orgName: string | null; surface: string; defaultOfferingId: string }>,
}));

vi.mock('./assignmentRows', () => ({ listAssignmentRows: vi.fn(async () => h.rows) }));
vi.mock('./candidateLoader', () => ({
  loadOfferingCandidate: vi.fn(async (id: string) => h.candidates.get(id) ?? null),
  loadPartnerFacts: vi.fn(async () => ({ plan: 'pro', residencyRequired: false })),
}));
vi.mock('./transport', () => ({
  defaultTransport: (s: string) => (['chat', 'helper', 'script_builder', 'ai_agents', 'office_chat'].includes(s) ? 'agent_sdk' : 'messages_api'),
  transportCarries: (t: string) => ({ speed: false, thinkingDisplayUpdates: false, inferenceGeo: h.carries[t] }),
}));
vi.mock('../../config/env', () => ({ isHosted: () => true }));
vi.mock('../../db', () => ({
  db: {
    update: () => ({ set: (s: Record<string, unknown>) => ({ where: async () => { h.partnerUpdates.push({ setSql: JSON.stringify(s) }); } }) }),
    // org-override rows for the preview (select … leftJoin … where)
    select: () => ({ from: () => ({ leftJoin: () => ({ where: async () => h.orgRows }) }) }),
  },
}));

import { previewResidencyImpact, setResidencyRequired } from './residency';

const P = '22222222-2222-4222-8222-222222222222';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RATES = { inputCentsPerM: 300, outputCentsPerM: 1500, cacheReadCentsPerM: 30, cacheWriteCentsPerM: 375 };
const cand = (geo: string | null, supported: string[]) => ({
  facts: {
    ownerPartnerId: P, enabled: true, lifecycle: 'available', requiredPermission: null,
    platform: { platformOffered: true, lifecycle: 'available', minPlan: null },
    connection: { kind: 'platform', status: 'active', keyUsable: true }, catalog: null,
    rate: { source: 'platform', standard: RATES }, supportsTools: true, inferenceGeo: geo, supportedInferenceGeos: supported,
  },
});

beforeEach(() => { h.rows = []; h.orgRows = []; h.candidates.clear(); h.partnerUpdates = []; h.carries = { agent_sdk: false, messages_api: false }; });

describe('previewResidencyImpact', () => {
  it('lists every surface whose partner default would be residency_unavailable', async () => {
    h.rows = [
      { surface: 'chat', role: 'default', orgId: null, defaultOfferingId: A },
      { surface: 'catalog_enrichment', role: 'default', orgId: null, defaultOfferingId: B },
    ];
    h.candidates.set(A, cand(null, []));
    h.candidates.set(B, cand('eu', ['eu']));
    h.carries = { agent_sdk: false, messages_api: true };
    expect((await previewResidencyImpact(P)).unavailableSurfaces).toEqual(['chat']);
  });

  it('lists org overrides whose own default would fail, even when the partner default is fine', async () => {
    h.carries = { agent_sdk: true, messages_api: true };
    h.rows = [{ surface: 'chat', role: 'default', orgId: null, defaultOfferingId: B }];
    h.candidates.set(B, cand('eu', ['eu']));
    h.candidates.set(A, cand(null, []));
    h.orgRows = [{ orgId: 'o1', orgName: 'Acme', surface: 'chat', defaultOfferingId: A }];
    expect(await previewResidencyImpact(P)).toEqual({ unavailableSurfaces: [], affectedOrgOverrides: [{ orgId: 'o1', orgName: 'Acme', surface: 'chat' }] });
  });

  it('treats a geo-capable default as unavailable while its transport cannot carry inference_geo (W01 spike pending)', async () => {
    h.rows = [{ surface: 'catalog_enrichment', role: 'default', orgId: null, defaultOfferingId: B }];
    h.candidates.set(B, cand('eu', ['eu']));
    expect((await previewResidencyImpact(P)).unavailableSurfaces).toEqual(['catalog_enrichment']);
  });
});

describe('setResidencyRequired', () => {
  it('refuses to turn residency on with impact unless acknowledged, and writes nothing', async () => {
    h.rows = [{ surface: 'chat', role: 'default', orgId: null, defaultOfferingId: A }];
    h.candidates.set(A, cand(null, []));
    const err = await setResidencyRequired({ partnerId: P, required: true, acknowledgeImpact: false }).catch((e) => e);
    expect([err.status, err.code, err.details.unavailableSurfaces]).toEqual([409, 'not_eligible', ['chat']]);
    expect(h.partnerUpdates).toHaveLength(0);
  });

  it('writes when acknowledged', async () => {
    h.rows = [{ surface: 'chat', role: 'default', orgId: null, defaultOfferingId: A }];
    h.candidates.set(A, cand(null, []));
    const r = await setResidencyRequired({ partnerId: P, required: true, acknowledgeImpact: true });
    expect(r.residencyRequired).toBe(true);
    expect(h.partnerUpdates).toHaveLength(1);
  });

  it('turning residency off never needs acknowledgement', async () => {
    await expect(setResidencyRequired({ partnerId: P, required: false, acknowledgeImpact: false })).resolves.toMatchObject({ residencyRequired: false });
  });
});
```

`apps/api/src/services/aiModels/connectionSettings.test.ts` mocks `./connections` (`getConnection`) and `db.update().set(s).where().returning()`, recording `s`:

```ts
describe('updateConnectionSettings', () => {
  it('renames without bumping config_version', async () => {
    h.conn = { id: C, partnerId: P, inferenceGeo: null, configVersion: 3 };
    await updateConnectionSettings({ partnerId: P, connectionId: C, patch: { name: 'Prod key' } });
    expect(h.set).toMatchObject({ name: 'Prod key' });
    expect(h.set).not.toHaveProperty('configVersion');
  });
  it('bumps config_version when inference geo changes', async () => {
    h.conn = { id: C, partnerId: P, inferenceGeo: null, configVersion: 3 };
    await updateConnectionSettings({ partnerId: P, connectionId: C, patch: { inferenceGeo: 'eu' } });
    expect(h.set).toHaveProperty('configVersion');
  });
  it('does not bump config_version when the geo is unchanged', async () => {
    h.conn = { id: C, partnerId: P, inferenceGeo: 'eu', configVersion: 3 };
    await updateConnectionSettings({ partnerId: P, connectionId: C, patch: { inferenceGeo: 'eu' } });
    expect(h.set).not.toHaveProperty('configVersion');
  });
  it('404s another partner’s connection', async () => {
    h.conn = { id: C, partnerId: 'other', inferenceGeo: null, configVersion: 1 };
    const err = await updateConnectionSettings({ partnerId: P, connectionId: C, patch: { name: 'x' } }).catch((e) => e);
    expect([err.status, err.code]).toEqual([404, 'not_found']);
  });
});
```

The partner-settings regression goes in the existing `PATCH /partners/me` test file. Use that file's harness: `app`, auth headers, and its captured-settings accessor, which the executor names after reading the file.

```ts
it('cannot write settings.ai — residency has one home (/ai/models/residency)', async () => {
  storedPartner.settings = { ai: { residencyRequired: true } };
  const res = await app.request('/orgs/partners/me', {
    method: 'PATCH', headers: authedJsonHeaders,
    body: JSON.stringify({ settings: { ai: { residencyRequired: false } } }),
  });
  expect(res.status).toBe(200);
  expect(lastWrittenPartnerSettings().ai).toEqual({ residencyRequired: true });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/residency.test.ts src/services/aiModels/connectionSettings.test.ts`
Expected: FAIL, modules not found.

The partner-settings regression **passes immediately**, because it pins existing behaviour. Prove it discriminates before trusting it:
1. Temporarily add `ai: z.unknown().optional()` to `partnerSettingsSchema` (`routes/orgs.ts:707`).
2. Re-run: the test must go RED.
3. Revert.

- [ ] **Step 3: Write the implementation**

`apps/api/src/services/aiModels/residency.ts`:

```ts
/**
 * Partner data-residency requirement (spec §7, §11; W03 reads it in
 * loadPartnerFacts). W04 owns the only writer. Residency fails CLOSED in the
 * resolver, so turning it on can make features unavailable. The impact is
 * computed with W03's checkEligibility (residencyRequired: true), never with a
 * second copy of the residency rule.
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { AiResidencyImpactDto, AiSurface } from '@breeze/shared';
import { db } from '../../db';
import { aiModelAssignments, organizations, partners } from '../../db/schema';
import { isHosted } from '../../config/env';
import { loadOfferingCandidate, loadPartnerFacts, type LoadedCandidate } from './candidateLoader';
import { checkEligibility, type PartnerPlan } from './eligibility';
import { defaultTransport, transportCarries } from './transport';
import { listAssignmentRows } from './assignmentRows';
import { RegistryWriteError, toRegistryWriteError } from './registryWriteErrors';

/** Would this offering, as the default of `surface`, become residency_unavailable? (W03 rule table, never a copy.) */
async function failsResidency(partnerId: string, plan: PartnerPlan, surface: AiSurface, offeringId: string, cache: Map<string, LoadedCandidate | null>): Promise<boolean> {
  let c = cache.get(offeringId);
  if (c === undefined) { c = await loadOfferingCandidate(offeringId, partnerId); cache.set(offeringId, c); }
  if (!c) return false;
  return checkEligibility(c.facts, {
    partnerId, surface, partnerPlan: plan, hosted: isHosted(),
    residencyRequired: true,
    geoCarriable: transportCarries(defaultTransport(surface)).inferenceGeo,
    userInitiated: false, userHoldsPermission: () => true,
  }) === 'residency_unavailable';
}

export async function previewResidencyImpact(partnerId: string): Promise<AiResidencyImpactDto> {
  const { plan } = await loadPartnerFacts(partnerId);
  const cache = new Map<string, LoadedCandidate | null>();
  const partnerRows = (await listAssignmentRows({ partnerId })).filter((r) => r.role === 'default' && r.defaultOfferingId);
  const unavailable: AiSurface[] = [];
  for (const row of partnerRows) {
    if (await failsResidency(partnerId, plan, row.surface as AiSurface, row.defaultOfferingId!, cache)) unavailable.push(row.surface as AiSurface);
  }
  // Org overrides with their own default (Codex review finding 12): an org can
  // point a surface at a model on another connection than the partner default.
  const orgRows = await db
    .select({ orgId: aiModelAssignments.orgId, orgName: organizations.name, surface: aiModelAssignments.surface, defaultOfferingId: aiModelAssignments.defaultOfferingId })
    .from(aiModelAssignments)
    .leftJoin(organizations, eq(organizations.id, aiModelAssignments.orgId))
    .where(and(
      eq(aiModelAssignments.offeringPartnerId, partnerId),
      isNotNull(aiModelAssignments.orgId),
      isNotNull(aiModelAssignments.defaultOfferingId),
      eq(aiModelAssignments.role, 'default'),
    ));
  const affectedOrgOverrides: AiResidencyImpactDto['affectedOrgOverrides'] = [];
  for (const r of orgRows) {
    if (await failsResidency(partnerId, plan, r.surface as AiSurface, r.defaultOfferingId!, cache)) {
      affectedOrgOverrides.push({ orgId: r.orgId!, orgName: r.orgName ?? null, surface: r.surface as AiSurface });
    }
  }
  return { unavailableSurfaces: unavailable.sort(), affectedOrgOverrides };
}

export async function setResidencyRequired(input: { partnerId: string; required: boolean; acknowledgeImpact: boolean }):
  Promise<{ residencyRequired: boolean; impact: AiResidencyImpactDto }> {
  const impact: AiResidencyImpactDto = input.required
    ? await previewResidencyImpact(input.partnerId)
    : { unavailableSurfaces: [], affectedOrgOverrides: [] };
  const hasImpact = impact.unavailableSurfaces.length > 0 || impact.affectedOrgOverrides.length > 0;
  if (input.required && hasImpact && !input.acknowledgeImpact) {
    throw new RegistryWriteError(
      'Requiring residency would make some AI features unavailable.', 'not_eligible', 409,
      { unavailableSurfaces: impact.unavailableSurfaces, affectedOrgOverrides: impact.affectedOrgOverrides },
    );
  }
  try {
    // Merge one key into settings.ai, creating settings / settings.ai as needed
    // and never touching sibling keys.
    await db
      .update(partners)
      .set({
        settings: sql`COALESCE(${partners.settings}, '{}'::jsonb)
          || jsonb_build_object('ai', COALESCE(${partners.settings} -> 'ai', '{}'::jsonb)
          || jsonb_build_object('residencyRequired', ${input.required}::boolean))`,
        updatedAt: new Date(),
      })
      .where(eq(partners.id, input.partnerId));
  } catch (error) {
    toRegistryWriteError(error, 'Could not save the residency setting.');
  }
  return { residencyRequired: input.required, impact };
}
```

`apps/api/src/services/aiModels/connectionSettings.ts`:

```ts
/** Connection name and inference geography (spec §5.2, §11 "Connections (incl. inference geo)"). */
import { and, eq, sql } from 'drizzle-orm';
import type { ConnectionSettingsPatch } from '@breeze/shared';
import { db } from '../../db';
import { partnerAiConnections } from '../../db/schema';
import { getConnection, type PartnerAiConnection } from './connections';
import { RegistryWriteError, toRegistryWriteError } from './registryWriteErrors';

export async function updateConnectionSettings(input: {
  partnerId: string; connectionId: string; patch: ConnectionSettingsPatch;
}): Promise<PartnerAiConnection> {
  const conn = await getConnection(input.connectionId);
  if (!conn || conn.partnerId !== input.partnerId) throw new RegistryWriteError('Connection not found.', 'not_found', 404);
  const geoChanged = input.patch.inferenceGeo !== undefined && input.patch.inferenceGeo !== conn.inferenceGeo;
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (input.patch.name !== undefined) set.name = input.patch.name;
  if (input.patch.inferenceGeo !== undefined) set.inferenceGeo = input.patch.inferenceGeo;
  // A geo change alters what is sent on the wire. Bumping config_version
  // changes W03's live-query key, so a reused SDK query is rebuilt (spec §9.2).
  if (geoChanged) set.configVersion = sql`${partnerAiConnections.configVersion} + 1`;
  try {
    const [updated] = await db
      .update(partnerAiConnections)
      .set(set)
      .where(and(eq(partnerAiConnections.id, input.connectionId), eq(partnerAiConnections.partnerId, input.partnerId)))
      .returning({ id: partnerAiConnections.id });
    if (!updated) throw new RegistryWriteError('Connection not found.', 'not_found', 404);
  } catch (error) {
    toRegistryWriteError(error, 'Could not save the connection.');
  }
  return (await getConnection(input.connectionId))!;
}
```

Add the coverage entry `'services/aiModels/connectionSettings.ts': 'gated at routes/aiModels/connections.ts (BILLING_MANAGE + canManagePartnerWidePolicies + MFA); partner-axis, pinned to input.partnerId from auth'`. `residency.ts` writes `partners`, which has no `partner_id` column, so the coverage scan does not detect it. It is still gated at its route.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/aiModels/residency.test.ts src/services/aiModels/connectionSettings.test.ts src/__tests__/partner-wide-write-coverage.test.ts`, plus the partner-settings test file.
Expected: PASS.

- [ ] **Step 5: Commit**

Stage `residency.ts`, `connectionSettings.ts`, their tests, `services/aiModels/index.ts`, `partner-wide-write-coverage.test.ts` and the partner-settings test. Commit with message `feat(ai-models): residency requirement with impact preview, connection name/geo settings (#7602)`, ending in the Co-Authored-By trailer.

---
### Task 8: The snapshot view and the partner `/ai/models` routes

**Files:**
- Create: `apps/api/src/services/aiModels/registryView.ts` + `registryView.test.ts`
- Create: `apps/api/src/routes/aiModels/shared.ts`
- Create: `apps/api/src/routes/aiModels/index.ts` (hub + `GET /`)
- Create: `apps/api/src/routes/aiModels/connections.ts`
- Create: `apps/api/src/routes/aiModels/offerings.ts`
- Create: `apps/api/src/routes/aiModels/assignments.ts`
- Create: `apps/api/src/routes/aiModels/residency.ts`
- Create: `apps/api/src/routes/aiModels/partnerRoutes.test.ts`
- Modify: `apps/api/src/routes/aiProvider.ts`:
  - import `buildCatalogSummary` from `registryView.ts` instead of its local copy;
  - **gate parity for the retained compat PATCH** (Codex review finding 4). `PATCH /ai/provider` (default model) gains `requireMfa()` and requires `approvals:decide`, because W03's `changeCompatDefaultModel` re-points every partner-level assignment on the old default, `script_reviewer` included. It would otherwise be a weaker door to the same rows `/ai/models/assignments` gates.
- Modify: `apps/api/src/routes/aiProvider.test.ts`. Add: `PATCH / → 403 without MFA`; `PATCH / → 403 APPROVALS_DECIDE_REQUIRED without approvals:decide`; the existing success case runs with both.
- Modify: `apps/api/src/index.ts` (mount `/ai/models` next to `/ai/provider`, ~L954, **before** `api.route('/ai', aiScriptPolicyRoutes)` (L976) and `api.route('/ai', aiRoutes)` (L982))
- Modify: `apps/api/src/services/mcpCoverage.ts` (entries, Step 3)

**Interfaces:**
- Consumes: Tasks 1–7; W03 Q2, Q5, Q6, Q7; merged `listConnections`, `getCompatConnection`, `listOfferings`, `listPlatformModels`, `platformRateSnapshot`, `deriveCapabilities`, `getListedProviders`, `isLlmProviderCatalogEnabled`, `isPlatformLlmConfigured`, `writeRouteAudit`, `captureException`.
- Produces:

```ts
// services/aiModels/registryView.ts
export function buildCatalogSummary(): Promise<AiModelsSnapshotDto['catalog']>;   // moved from routes/aiProvider.ts
export function buildPartnerModelsSnapshot(partnerId: string): Promise<AiModelsSnapshotDto>;
export function buildOrgModelDefaults(input: { partnerId: string; orgId: string; canEdit: boolean; canEditReviewer: boolean }): Promise<AiOrgModelDefaultsDto>;

// routes/aiModels/shared.ts
export const partnerRead: MiddlewareHandler[];   // [requirePermission(BILLING_MANAGE)]
export const partnerWrite: MiddlewareHandler[];  // [requirePermission(BILLING_MANAGE), requireMfa()]
export function requirePartnerWide(c: Context): { partnerId: string; userId: string }; // 403s
export function canDecideApprovals(c: Context): boolean;
export function registryWrite(c: Context, partnerId: string, fn: () => Promise<Response>): Promise<Response>;

// routes/aiModels/index.ts
export const aiModelsRoutes: Hono;   // mounted at /ai/models
```

**Routes (all under `/ai/models`):**

| Method + path | Gate | Body / query | Service | Audit action |
|---|---|---|---|---|
| `GET /` | `partnerRead` + partner-wide | — | `buildPartnerModelsSnapshot` | — |
| `POST /connections` | `partnerWrite` + partner-wide | `connectionCreateSchema` | `savePartnerLlmKey` (+ `updateConnectionSettings` for name/geo) | `ai_models.connection.created` |
| `POST /connections/:id/key` | same | `connectionRotateKeySchema` | `savePartnerLlmKey` | `ai_models.connection.key_rotated` |
| `POST /connections/:id/endpoint` | same | `connectionEndpointSchema` | `updatePartnerLlmEndpoint` | `ai_models.connection.endpoint_changed` |
| `PATCH /connections/:id` | same | `connectionSettingsPatchSchema` | `updateConnectionSettings` | `ai_models.connection.updated` |
| `DELETE /connections/:id` | same | — | `deletePartnerLlmConfig` | `ai_models.connection.deleted` |
| `POST /connections/:id/refresh` | same | — | `enqueueConnectionSync` (202) | `ai_models.connection.refresh_requested` |
| `POST /offerings/platform/:platformModelId` | same | `offeringEnableSchema` | `ensurePlatformOffering({ enabled })` (one insert; gate from platform facts) | `ai_models.offering.added` |
| `POST /offerings/:id/enabled` | same | `offeringEnableSchema` | `setOfferingEnabled` | `ai_models.offering.enabled` / `.disabled` |
| `PATCH /offerings/:id` | same | `offeringDetailsPatchSchema` | `updateOfferingDetails` | `ai_models.offering.updated` |
| `POST /offerings/:id/verify` | same | — | `enqueueConnectionSync(offering.connectionId)` (202; 409 for platform offerings) | `ai_models.offering.verify_requested` |
| `PUT /assignments` | same + **`approvals:decide` when a row's surface is `script_reviewer`** | `partnerAssignmentsPutSchema` | `putPartnerAssignments` | `ai_models.assignments.updated` |
| `GET /residency/preview` | `partnerRead` + partner-wide | — | `previewResidencyImpact` | — |
| `PUT /residency` | `partnerWrite` + partner-wide | `residencyPutSchema` | `setResidencyRequired` | `ai_models.residency.updated` |

**Connection id binding.** `partner_ai_connections_compat_uq` holds through W04, so `:id` must equal `getCompatConnection(partnerId)?.id`. Otherwise the route returns 404. This also makes a forged other-partner id a 404 before any write. `POST /connections` returns 409 `conflict` when a compat connection already exists ("rotate its key instead").

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/aiModels/registryView.test.ts`. It mocks `listConnections`, `listOfferings`, `loadOfferingCandidate`, `loadPartnerFacts`, `listPlatformModels`, `listAssignmentRows`, `getListedProviders` and `isPlatformLlmConfigured`.

```ts
describe('buildPartnerModelsSnapshot', () => {
  it('puts the implicit platform connection first, then partner connections', async () => {
    h.connections = [conn({ id: C, kind: 'anthropic_byok', name: 'Anthropic' })];
    const s = await buildPartnerModelsSnapshot(P);
    expect(s.connections.map((c) => [c.id, c.kind])).toEqual([[null, 'platform'], [C, 'anthropic_byok']]);
    expect(s.connections[1]).not.toHaveProperty('apiKeyEncrypted');
    expect(s.connections[1]).not.toHaveProperty('keyFingerprint');
  });

  it('synthesizes a not-yet-added row for each offered platform model with no offering', async () => {
    h.platformModels = [pm({ id: 'pm-1', platformOffered: true }), pm({ id: 'pm-2', platformOffered: false })];
    h.offerings = [];
    const s = await buildPartnerModelsSnapshot(P);
    expect(s.offerings.filter((o) => o.id === null).map((o) => o.platformModelId)).toEqual(['pm-1']);
  });

  it('reports enableBlocker via enableBlockerFor (plan gate on a synthesized row)', async () => {
    h.facts = { plan: 'starter', residencyRequired: false };
    h.platformModels = [pm({ id: 'pm-1', platformOffered: true, minPlan: 'enterprise' })];
    const s = await buildPartnerModelsSnapshot(P);
    expect(s.offerings[0].enableBlocker).toBe('plan_required');
  });

  it('lists the surfaces an offering is default for (partner and org rows)', async () => {
    h.offerings = [offering({ id: A })];
    h.allRows = [{ surface: 'chat', orgId: null, defaultOfferingId: A }, { surface: 'helper', orgId: 'o1', defaultOfferingId: A }];
    const s = await buildPartnerModelsSnapshot(P);
    expect(s.offerings[0].defaultFor).toEqual([
      { surface: 'chat', level: 'partner', orgId: null },
      { surface: 'helper', level: 'org', orgId: 'o1' },
    ]);
  });

  it('returns one defaults row per configurable surface, never patch_test', async () => {
    const s = await buildPartnerModelsSnapshot(P);
    expect(s.defaults).toHaveLength(9);
    expect(s.defaults.map((d) => d.surface)).not.toContain('patch_test');
    expect(s.defaults.find((d) => d.surface === 'chat')!.requiresTools).toBe(true);
  });

  it('marks prices editable only for discovered/manual offerings', async () => {
    h.offerings = [offering({ id: A, source: 'platform' }), offering({ id: B, source: 'discovered', connectionId: C })];
    const s = await buildPartnerModelsSnapshot(P);
    expect(s.offerings.map((o) => [o.id, o.pricesEditable])).toEqual([[A, false], [B, true]]);
  });
});

describe('buildOrgModelDefaults', () => {
  it('shows the inherited (partner) value, the org value and the merged effective value', async () => {
    h.partnerRows = [{ surface: 'chat', role: 'default', orgId: null, defaultOfferingId: A, permittedOfferingIds: null, allowUserChoice: true, options: { effort: 'high' } }];
    h.orgRows = [{ surface: 'chat', role: 'default', orgId: ORG, defaultOfferingId: null, permittedOfferingIds: null, allowUserChoice: false, options: null }];
    const d = await buildOrgModelDefaults({ partnerId: P, orgId: ORG, canEdit: true, canEditReviewer: false });
    const chat = d.surfaces.find((s) => s.surface === 'chat')!;
    expect(chat.inherited).toMatchObject({ defaultOfferingId: A, allowUserChoice: true, options: { effort: 'high' } });
    expect(chat.org).toMatchObject({ allowUserChoice: false });
    expect(chat.effective).toMatchObject({ defaultOfferingId: A, defaultSource: 'partner', allowUserChoice: false });
    expect(d.canEditReviewer).toBe(false);
  });
});
```

`apps/api/src/routes/aiModels/partnerRoutes.test.ts` follows the `aiProvider.test.ts` harness exactly: hoisted `authGates`, a mocked `../../middleware/auth`, `../../services/permissions`, `../../services/auditEvents` and `../../services/sentry`. It also mocks every service module this task's routes import. Note that its routes import paths are one level deeper (`../../`). The authz matrix and the key behaviours:

```ts
const WRITE_ROUTES: Array<[method: string, path: string, body?: unknown]> = [
  ['POST', '/connections', { kind: 'anthropic_byok', apiKey: 'sk-ant-' + 'x'.repeat(40) }],
  ['POST', `/connections/${C}/key`, { apiKey: 'sk-ant-' + 'x'.repeat(40) }],
  ['POST', `/connections/${C}/endpoint`, { catalogEntryId: null }],
  ['PATCH', `/connections/${C}`, { name: 'x' }],
  ['DELETE', `/connections/${C}`],
  ['POST', `/connections/${C}/refresh`],
  ['POST', `/offerings/platform/${PM}`, { enabled: true }],
  ['POST', `/offerings/${A}/enabled`, { enabled: true }],
  ['PATCH', `/offerings/${A}`, { expectedUpdatedAt: '2026-10-01T00:00:00.000Z', displayName: 'x' }],
  ['POST', `/offerings/${A}/verify`],
  ['PUT', '/assignments', { assignments: [chatRow] }],
  ['PUT', '/residency', { required: false }],
];

describe('/ai/models partner routes — authz matrix', () => {
  it.each(WRITE_ROUTES)('%s %s → 403 without BILLING_MANAGE', async (method, path, body) => {
    authGates.permissionDenied = true;
    expect((await call(method, path, body)).status).toBe(403);
  });
  it.each(WRITE_ROUTES)('%s %s → 403 without MFA', async (method, path, body) => {
    authGates.mfaDenied = true;
    expect((await call(method, path, body)).status).toBe(403);
  });
  it.each(WRITE_ROUTES)('%s %s → 403 for a partner user with orgAccess != all', async (method, path, body) => {
    authState.value = { ...authState.value, partnerOrgAccess: 'selected' };
    expect((await call(method, path, body)).status).toBe(403);
  });
  it.each(WRITE_ROUTES)('%s %s → 403 for an org-scope token (no partner context)', async (method, path, body) => {
    authState.value = { ...authState.value, scope: 'organization', partnerId: null };
    expect((await call(method, path, body)).status).toBe(403);
  });
  it.each(WRITE_ROUTES)('%s %s → 503 registry_unavailable when the cutover resolves false (W03 contract), and no service write', async (method, path, body) => {
    ensurePartnerCutover.mockResolvedValueOnce(false);
    const res = await call(method, path, body);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'registry_unavailable' });
    for (const write of ALL_WRITE_SERVICE_MOCKS) expect(write).not.toHaveBeenCalled();
  });
  it.each(WRITE_ROUTES)('%s %s → 503 when the cutover rejects, too', async (method, path, body) => {
    ensurePartnerCutover.mockRejectedValueOnce(new Error('cutover failed'));
    expect((await call(method, path, body)).status).toBe(503);
  });
  it('GET / needs BILLING_MANAGE but not MFA', async () => {
    authGates.mfaDenied = true;
    expect((await call('GET', '/')).status).toBe(200);
    authGates.permissionDenied = true;
    expect((await call('GET', '/')).status).toBe(403);
  });
});

describe('/ai/models partner routes — behaviour', () => {
  it('404s a connection id that is not the partner’s connection (forged id)', async () => {
    getCompatConnection.mockResolvedValue({ id: 'someone-else', partnerId: P });
    expect((await call('PATCH', `/connections/${C}`, { name: 'x' })).status).toBe(404);
    expect(updateConnectionSettings).not.toHaveBeenCalled();
  });
  it('409s creating a second Anthropic connection', async () => {
    getCompatConnection.mockResolvedValue({ id: C, partnerId: P });
    const res = await call('POST', '/connections', { kind: 'anthropic_byok', apiKey: 'sk-ant-' + 'x'.repeat(40) });
    expect([res.status, (await res.json()).code]).toEqual([409, 'conflict']);
  });
  it('maps RegistryWriteError to its status with code + details', async () => {
    setOfferingEnabled.mockRejectedValue(new RegistryWriteError('in use', 'offering_in_use', 409, { inUse: [{ surface: 'chat', level: 'partner', orgId: null }] }));
    const res = await call('POST', `/offerings/${A}/enabled`, { enabled: false });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'in use', code: 'offering_in_use', details: { inUse: [{ surface: 'chat', level: 'partner', orgId: null }] } });
  });
  it('requires approvals:decide to change the script_reviewer default', async () => {
    permissionsState.approvalsDecide = false;
    const res = await call('PUT', '/assignments', { assignments: [{ ...chatRow, surface: 'script_reviewer' }] });
    expect([res.status, (await res.json()).code]).toEqual([403, 'APPROVALS_DECIDE_REQUIRED']);
    expect(putPartnerAssignments).not.toHaveBeenCalled();
  });
  it('does not require approvals:decide for other surfaces', async () => {
    permissionsState.approvalsDecide = false;
    expect((await call('PUT', '/assignments', { assignments: [chatRow] })).status).toBe(200);
  });
  it('writes an audit row per mutation with orgId null and the partner as resource', async () => {
    await call('PUT', '/residency', { required: false });
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: null, action: 'ai_models.residency.updated', resourceType: 'partner', resourceId: P,
    }));
  });
  it('captures 5xx registry errors to Sentry and never echoes the cause', async () => {
    const e = new RegistryWriteError('Could not save the model.', 'write_failed', 500);
    e.cause = Object.assign(new Error('SQLSTATE XX000'), { code: 'XX000' });
    updateOfferingDetails.mockRejectedValue(e);
    const res = await call('PATCH', `/offerings/${A}`, { expectedUpdatedAt: '2026-10-01T00:00:00.000Z', displayName: 'x' });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('XX000');
    expect(captureException).toHaveBeenCalled();
  });
  it('POST /offerings/:id/verify on a platform offering is 409 (operator-verified)', async () => {
    getOffering.mockResolvedValue({ id: A, partnerId: P, connectionId: null });
    expect((await call('POST', `/offerings/${A}/verify`)).status).toBe(409);
  });
});
```

`call(method, path, body)` is `aiModelsRoutes.request(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })`. `permissionsState.approvalsDecide` drives a mocked `hasPermission` for `('approvals','decide')`. The mocked `requirePermission` sets `c.set('permissions', {})`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/registryView.test.ts src/routes/aiModels/partnerRoutes.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write the implementation**

`apps/api/src/services/aiModels/registryView.ts`:

```ts
/**
 * Read models for the /ai/models UI (W04, #7602). The DTOs never carry key
 * material, fingerprints or raw provider config. Eligibility facts come from
 * W03's candidate loader, and the enable blocker comes from enableBlockerFor
 * (one rule table).
 */
import {
  CONFIGURABLE_AI_SURFACES, TOOL_REQUIRING_SURFACES,
  type AiConnectionDto, type AiModelsSnapshotDto, type AiOfferingDto, type AiOrgModelDefaultsDto,
  type AiSurface, type OfferingOptions,
} from '@breeze/shared';
import { db } from '../../db';
import { aiModelAssignments } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { isHosted } from '../../config/env';
import { isPlatformLlmConfigured } from '../llm/llmAvailability';
import { isLlmProviderCatalogEnabled } from '../llm/llmConfigResolver';
import { getListedProviders } from '../llmProviderCatalog';
import { loadOfferingCandidate, loadPartnerFacts, type LoadedCandidate } from './candidateLoader';
import { enableBlockerFor } from './eligibility';
import { platformCandidateFacts } from './offeringWrites';
import { getPlatformInferenceGeo } from './platformModels';
import { listConnections } from './connections';
import { listOfferings, type Offering } from './offerings';
import { listPlatformModels, type PlatformModel } from './platformModels';
import { platformRateSnapshot } from './pricing';
import { deriveCapabilities } from './capabilities';
import { listAssignmentRows } from './assignmentRows';
import { mergeEffectiveAssignment } from './assignments';

const TOOL_SURFACES = new Set<string>(TOOL_REQUIRING_SURFACES);

export async function buildCatalogSummary(): Promise<AiModelsSnapshotDto['catalog']> {
  // Body moved verbatim from routes/aiProvider.ts (verified ∩ mapped, Object.hasOwn).
  const providers = await getListedProviders();
  return providers.map((p) => ({
    entryId: p.entryId, slug: p.slug, name: p.name, dataNote: p.dataNote,
    models: p.verifiedModels.filter((m) => Object.hasOwn(p.modelMap, m)),
  }));
}

function offeringDto(o: Offering, c: LoadedCandidate, blocker: AiOfferingDto['enableBlocker'], defaultFor: AiOfferingDto['defaultFor']): AiOfferingDto {
  const own = o.priceInputCentsPerM === null ? null : {
    inputCentsPerM: o.priceInputCentsPerM!, outputCentsPerM: o.priceOutputCentsPerM!,
    cacheReadCentsPerM: o.priceCacheReadCentsPerM!, cacheWriteCentsPerM: o.priceCacheWriteCentsPerM!,
  };
  return {
    id: o.id, platformModelId: o.platformModelId, connectionId: o.connectionId, source: o.source,
    modelId: c.logicalModel, displayName: c.displayName, displayNameOverride: o.displayName ?? null,
    enabled: o.enabled, lifecycle: o.lifecycle, funding: c.funding,
    rates: c.facts.rate?.standard ?? null, fastRates: c.optionRates?.['speed:fast'] ?? null,
    priceSource: c.facts.rate?.source ?? null, ownPrices: own,
    pricesEditable: o.source === 'discovered' || o.source === 'manual',
    thinkingMode: c.capabilities.thinkingMode, supportsTools: c.facts.supportsTools,
    contextTokens: c.limits.maxInputTokens, optionSupport: c.optionSupport,
    defaultOptions: (o.defaultOptions ?? null) as OfferingOptions | null,
    allowedOptions: (o.allowedOptions ?? null) as AiOfferingDto['allowedOptions'],
    requiredPermission: o.requiredPermission, refusalFallbackOfferingId: o.refusalFallbackOfferingId,
    enableBlocker: blocker, defaultFor, updatedAt: o.updatedAt.toISOString(),
  };
}

/** Effective geo per W03 (Q15): the connection's own value, else the platform setting, else provider default. */
function effectiveGeo(own: string | null, platformGeo: string | null): Pick<AiConnectionDto, 'effectiveInferenceGeo' | 'inferenceGeoSource'> {
  if (own) return { effectiveInferenceGeo: own, inferenceGeoSource: 'connection' };
  if (platformGeo) return { effectiveInferenceGeo: platformGeo, inferenceGeoSource: 'platform' };
  return { effectiveInferenceGeo: null, inferenceGeoSource: 'provider_default' };
}

export async function buildPartnerModelsSnapshot(partnerId: string): Promise<AiModelsSnapshotDto> {
  const facts = await loadPartnerFacts(partnerId);
  const ctx = { partnerId, partnerPlan: facts.plan, hosted: isHosted() };
  const [connections, offerings, platformModels, partnerRows, allRows] = await Promise.all([
    listConnections(partnerId),
    listOfferings(partnerId),
    listPlatformModels(),
    listAssignmentRows({ partnerId }),
    db.select({ surface: aiModelAssignments.surface, orgId: aiModelAssignments.orgId, defaultOfferingId: aiModelAssignments.defaultOfferingId })
      .from(aiModelAssignments).where(eq(aiModelAssignments.offeringPartnerId, partnerId)),
  ]);

  const offeringDtos: AiOfferingDto[] = [];
  for (const o of offerings) {
    const c = await loadOfferingCandidate(o.id, partnerId);
    if (!c) continue;
    const defaultFor = allRows.filter((r) => r.defaultOfferingId === o.id).map((r) => ({
      surface: r.surface as AiSurface, level: r.orgId === null ? 'partner' as const : 'org' as const, orgId: r.orgId,
    }));
    offeringDtos.push(offeringDto(o, c, enableBlockerFor(c.facts, ctx), defaultFor));
  }
  const added = new Set(offerings.filter((o) => o.connectionId === null).map((o) => o.platformModelId));
  for (const pm of platformModels) {
    if (!pm.platformOffered || pm.lifecycle !== 'available' || added.has(pm.id)) continue;
    const derived = deriveCapabilities(pm.capabilities);
    offeringDtos.push({
      id: null, platformModelId: pm.id, connectionId: null, source: 'platform', modelId: pm.modelId,
      displayName: pm.displayName, displayNameOverride: null, enabled: false, lifecycle: pm.lifecycle, funding: 'platform',
      rates: pm.rates, fastRates: pm.optionRates?.['speed:fast'] ?? null, priceSource: pm.rates ? 'platform' : null,
      ownPrices: null, pricesEditable: false, thinkingMode: derived.thinkingMode, supportsTools: derived.supportsTools,
      contextTokens: pm.maxInputTokens, optionSupport: pm.optionSupport, defaultOptions: null, allowedOptions: null,
      requiredPermission: null, refusalFallbackOfferingId: null,
      enableBlocker: enableBlockerFor(platformCandidateFacts(partnerId, pm), ctx), defaultFor: [], updatedAt: null,
    });
  }

  const platformGeo = getPlatformInferenceGeo();
  const platformConn: AiConnectionDto = {
    id: null, kind: 'platform', name: 'Breeze platform', status: 'platform', lastError: null, keyLast4: null,
    inferenceGeo: platformGeo, ...effectiveGeo(platformGeo, null),
    supportedInferenceGeos: [...new Set(platformModels.flatMap((m) => m.optionSupport.inferenceGeo))].sort(),
    catalogEntryId: null, catalogName: null, configVersion: null, verifiedAt: null,
    lastDiscoveredAt: null, discoveryError: null, funding: 'platform',
  };
  const catalog = isLlmProviderCatalogEnabled() ? await buildCatalogSummary() : [];
  const catalogNames = new Map(catalog.map((e) => [e.entryId, e.name]));
  const connectionDtos: AiConnectionDto[] = (isPlatformLlmConfigured() ? [platformConn] : []).concat(
    connections.map((c) => ({
      id: c.id, kind: c.kind, name: c.name, status: c.status, lastError: c.lastError, keyLast4: c.keyLast4,
      inferenceGeo: c.inferenceGeo, ...effectiveGeo(c.inferenceGeo, platformGeo),
      supportedInferenceGeos: [...new Set(offeringDtos.filter((o) => o.connectionId === c.id).flatMap((o) => o.optionSupport.inferenceGeo))].sort(),
      catalogEntryId: c.catalogEntryId, catalogName: c.catalogEntryId ? catalogNames.get(c.catalogEntryId) ?? null : null,
      configVersion: c.configVersion, verifiedAt: c.verifiedAt?.toISOString() ?? null,
      lastDiscoveredAt: c.lastDiscoveredAt?.toISOString() ?? null, discoveryError: c.discoveryError, funding: 'partner_key' as const,
    })),
  );

  return {
    partner: { residencyRequired: facts.residencyRequired, plan: facts.plan, hosted: isHosted() },
    connections: connectionDtos,
    offerings: offeringDtos,
    defaults: CONFIGURABLE_AI_SURFACES.map((surface) => {
      const p = partnerRows.find((r) => r.surface === surface && r.role === 'default') ?? null;
      return {
        surface, requiresTools: TOOL_SURFACES.has(surface),
        partner: p && {
          surface, role: p.role, defaultOfferingId: p.defaultOfferingId, permittedOfferingIds: p.permittedOfferingIds,
          allowUserChoice: p.allowUserChoice, options: (p.options ?? null) as OfferingOptions | null, updatedAt: p.updatedAt.toISOString(),
        },
        orgOverrideCount: allRows.filter((r) => r.surface === surface && r.orgId !== null).length,
      };
    }),
    catalog,
    catalogEnabled: isLlmProviderCatalogEnabled(),
  };
}

export async function buildOrgModelDefaults(input: { partnerId: string; orgId: string; canEdit: boolean; canEditReviewer: boolean }): Promise<AiOrgModelDefaultsDto> {
  const [enabled, partnerRows, orgRows] = await Promise.all([
    listOfferings(input.partnerId, { enabledOnly: true }),
    listAssignmentRows({ partnerId: input.partnerId }),
    listAssignmentRows({ partnerId: input.partnerId, orgId: input.orgId }),
  ]);
  const offerings: AiOrgModelDefaultsDto['offerings'] = [];
  for (const o of enabled) {
    const c = await loadOfferingCandidate(o.id, input.partnerId);
    if (!c) continue;
    offerings.push({ id: o.id, displayName: c.displayName, funding: c.funding, supportsTools: c.facts.supportsTools,
      optionSupport: c.optionSupport, rates: c.facts.rate?.standard ?? null, requiredPermission: o.requiredPermission });
  }
  return {
    orgId: input.orgId, offerings, canEdit: input.canEdit, canEditReviewer: input.canEditReviewer,
    surfaces: CONFIGURABLE_AI_SURFACES.map((surface) => {
      const p = partnerRows.find((r) => r.surface === surface && r.role === 'default') ?? null;
      const o = orgRows.find((r) => r.surface === surface && r.role === 'default') ?? null;
      const eff = mergeEffectiveAssignment({ surface, role: 'default', partner: p, org: o });
      return {
        surface, requiresTools: TOOL_SURFACES.has(surface),
        inherited: {
          defaultOfferingId: p?.defaultOfferingId ?? null, permittedOfferingIds: p?.permittedOfferingIds ?? null,
          allowUserChoice: p?.allowUserChoice ?? true, options: (p?.options ?? {}) as OfferingOptions,
        },
        org: o && {
          surface, role: o.role, defaultOfferingId: o.defaultOfferingId, permittedOfferingIds: o.permittedOfferingIds,
          allowUserChoice: o.allowUserChoice, options: (o.options ?? null) as OfferingOptions | null, updatedAt: o.updatedAt.toISOString(),
        },
        effective: {
          defaultOfferingId: eff.defaultOfferingId, defaultSource: eff.defaultSource,
          permittedOfferingIds: eff.permitted.kind === 'all' ? null : [...eff.permitted.offeringIds],
          allowUserChoice: eff.allowUserChoice, options: eff.options,
        },
      };
    }),
  };
}
```

`apps/api/src/routes/aiModels/shared.ts`:

```ts
import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { requireMfa, requirePermission } from '../../middleware/auth';
import { PERMISSIONS, hasPermission } from '../../services/permissions';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../../services/partnerWideAccess';
import { ensurePartnerCutover } from '../../services/aiModels/registryCutover';
import { RegistryWriteError } from '../../services/aiModels/registryWriteErrors';
import { PartnerLlmError } from '../../services/partnerLlmConfig';
import { captureException } from '../../services/sentry';

export const partnerRead: MiddlewareHandler[] = [
  requirePermission(PERMISSIONS.BILLING_MANAGE.resource, PERMISSIONS.BILLING_MANAGE.action),
];
export const partnerWrite: MiddlewareHandler[] = [
  requirePermission(PERMISSIONS.BILLING_MANAGE.resource, PERMISSIONS.BILLING_MANAGE.action),
  requireMfa(),
];

/** Same gate as routes/aiProvider.ts: a partner token with orgAccess 'all' (or system with a partner context). */
export function requirePartnerWide(c: Context): { partnerId: string; userId: string } {
  const auth = c.get('auth');
  if (!auth?.partnerId) throw new HTTPException(403, { message: 'Partner context required' });
  if (!canManagePartnerWidePolicies(auth)) throw new HTTPException(403, { message: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
  return { partnerId: auth.partnerId, userId: auth.user.id };
}

/** approvals:decide — required to change the script reviewer's model (partnerAiScriptPolicy.ts:135-150 precedent). */
export function canDecideApprovals(c: Context): boolean {
  const perms = c.get('permissions');
  return Boolean(perms) && hasPermission(perms, PERMISSIONS.APPROVALS_DECIDE.resource, PERMISSIONS.APPROVALS_DECIDE.action);
}

export const APPROVALS_DECIDE_REQUIRED = { error: 'approvals:decide is required to change the script reviewer’s model', code: 'APPROVALS_DECIDE_REQUIRED' } as const;

/**
 * Every registry write: W03's per-partner cutover gate first (a partner not yet
 * cut over would have the edit overwritten by its projection), then the write.
 * Typed errors map to their status. 5xx are captured, and no cause is ever echoed.
 */
export async function registryWrite(c: Context, partnerId: string, fn: () => Promise<Response>): Promise<Response> {
  // W03 contract (Q5): resolves false on failure (it captures the error itself).
  // A rejection is treated the same way.
  const cutOver = await ensurePartnerCutover(partnerId).catch((error) => {
    captureException(error, undefined, { service: 'aiModels', stage: 'cutover' });
    return false;
  });
  if (!cutOver) {
    return c.json({ error: 'AI configuration is being upgraded. Try again in a moment.', code: 'registry_unavailable' }, 503);
  }
  try {
    return await fn();
  } catch (error) {
    if (error instanceof RegistryWriteError) {
      if (error.status >= 500) captureException(error, undefined, { service: 'aiModels' });
      return c.json({ error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) }, error.status);
    }
    if (error instanceof PartnerLlmError) {
      if (error.status >= 500) captureException(error, undefined, { service: 'aiModels' });
      return c.json({ error: error.message }, error.status);
    }
    throw error;
  }
}
```

`apps/api/src/routes/aiModels/connections.ts`:

```ts
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { connectionCreateSchema, connectionEndpointSchema, connectionRotateKeySchema, connectionSettingsPatchSchema } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { writeRouteAudit } from '../../services/auditEvents';
import { getCompatConnection } from '../../services/aiModels/connections';
import { updateConnectionSettings } from '../../services/aiModels/connectionSettings';
import { enqueueConnectionSync } from '../../jobs/aiModelDiscoveryWorker';
import { isLlmProviderCatalogEnabled } from '../../services/llm/llmConfigResolver';
import { deletePartnerLlmConfig, savePartnerLlmKey, updatePartnerLlmEndpoint } from '../../services/partnerLlmConfig';
import { partnerWrite, registryWrite, requirePartnerWide } from './shared';

export const aiModelConnectionRoutes = new Hono();

/** compat_uq (W02–W08): the partner has at most one anthropic_byok/catalog connection; :id must be it. */
async function ownConnectionId(partnerId: string, id: string): Promise<string> {
  const conn = await getCompatConnection(partnerId);
  if (!conn || conn.id !== id) throw new HTTPException(404, { message: 'Connection not found.' });
  return conn.id;
}

function audit(c: Context, partnerId: string, action: string, details: Record<string, unknown> = {}) {
  writeRouteAudit(c, { orgId: null, action: `ai_models.connection.${action}`, resourceType: 'partner', resourceId: partnerId, details });
}

aiModelConnectionRoutes.post('/', ...partnerWrite, zValidator('json', connectionCreateSchema), async (c) => {
  const { partnerId, userId } = requirePartnerWide(c);
  const body = c.req.valid('json');
  return registryWrite(c, partnerId, async () => {
    if (await getCompatConnection(partnerId)) {
      return c.json({ error: 'This partner already has an Anthropic connection. Rotate its key instead.', code: 'conflict' }, 409);
    }
    switch (body.kind) {
      case 'anthropic_byok': {
        const result = await savePartnerLlmKey({ partnerId, apiKey: body.apiKey, userId });
        const conn = await getCompatConnection(partnerId);
        if (conn && (body.name !== undefined || body.inferenceGeo !== undefined)) {
          await updateConnectionSettings({ partnerId, connectionId: conn.id, patch: { name: body.name, inferenceGeo: body.inferenceGeo } });
        }
        audit(c, partnerId, 'created', { kind: body.kind, last4: result.last4, configVersion: result.configVersion });
        return c.json({ id: conn?.id ?? null }, 201);
      }
      default: {
        const never: never = body.kind;
        throw new HTTPException(400, { message: `Unsupported connection kind ${String(never)}` });
      }
    }
  });
});

aiModelConnectionRoutes.post('/:id/key', ...partnerWrite, zValidator('json', connectionRotateKeySchema), async (c) => {
  const { partnerId, userId } = requirePartnerWide(c);
  const id = await ownConnectionId(partnerId, c.req.param('id'));
  return registryWrite(c, partnerId, async () => {
    const result = await savePartnerLlmKey({ partnerId, apiKey: c.req.valid('json').apiKey, userId });
    audit(c, partnerId, 'key_rotated', { connectionId: id, last4: result.last4, configVersion: result.configVersion });
    return c.json({ id, keyLast4: result.last4, configVersion: result.configVersion });
  });
});

aiModelConnectionRoutes.post('/:id/endpoint', ...partnerWrite, zValidator('json', connectionEndpointSchema), async (c) => {
  const { partnerId, userId } = requirePartnerWide(c);
  const id = await ownConnectionId(partnerId, c.req.param('id'));
  const { catalogEntryId, acknowledgeDataNote } = c.req.valid('json');
  // Same rule as routes/aiProvider.ts: the flag gates SELECTING an endpoint, never clearing one.
  if (catalogEntryId !== null && !isLlmProviderCatalogEnabled()) {
    throw new HTTPException(404, { message: 'Catalog endpoint selection is not available on this deployment.' });
  }
  return registryWrite(c, partnerId, async () => {
    const result = await updatePartnerLlmEndpoint({ partnerId, catalogEntryId, acknowledgeDataNote, userId });
    audit(c, partnerId, 'endpoint_changed', { connectionId: id, catalogEntryId, configVersion: result.configVersion });
    return c.json(result);
  });
});

aiModelConnectionRoutes.patch('/:id', ...partnerWrite, zValidator('json', connectionSettingsPatchSchema), async (c) => {
  const { partnerId } = requirePartnerWide(c);
  const id = await ownConnectionId(partnerId, c.req.param('id'));
  return registryWrite(c, partnerId, async () => {
    const patch = c.req.valid('json');
    const conn = await updateConnectionSettings({ partnerId, connectionId: id, patch });
    audit(c, partnerId, 'updated', { connectionId: id, ...patch, configVersion: conn.configVersion });
    return c.json({ id, configVersion: conn.configVersion });
  });
});

aiModelConnectionRoutes.delete('/:id', ...partnerWrite, async (c) => {
  const { partnerId } = requirePartnerWide(c);
  const id = await ownConnectionId(partnerId, c.req.param('id'));
  return registryWrite(c, partnerId, async () => {
    const deleted = await deletePartnerLlmConfig(partnerId);
    if (deleted) audit(c, partnerId, 'deleted', { connectionId: id });
    return c.json({ deleted });
  });
});

aiModelConnectionRoutes.post('/:id/refresh', ...partnerWrite, async (c) => {
  const { partnerId } = requirePartnerWide(c);
  const id = await ownConnectionId(partnerId, c.req.param('id'));
  return registryWrite(c, partnerId, async () => {
    await enqueueConnectionSync(id);
    audit(c, partnerId, 'refresh_requested', { connectionId: id });
    return c.json({ queued: true }, 202);
  });
});
```

`apps/api/src/routes/aiModels/offerings.ts`:

```ts
import { Hono } from 'hono';
import { offeringDetailsPatchSchema, offeringEnableSchema } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { writeRouteAudit } from '../../services/auditEvents';
import { getOffering } from '../../services/aiModels/offerings';
import { ensurePlatformOffering, setOfferingEnabled, updateOfferingDetails } from '../../services/aiModels/offeringWrites';
import { enqueueConnectionSync } from '../../jobs/aiModelDiscoveryWorker';
import { partnerWrite, registryWrite, requirePartnerWide } from './shared';

export const aiModelOfferingRoutes = new Hono();

const auditOffering = (c: Parameters<typeof writeRouteAudit>[0], partnerId: string, action: string, details: Record<string, unknown>) =>
  writeRouteAudit(c, { orgId: null, action: `ai_models.offering.${action}`, resourceType: 'partner', resourceId: partnerId, details });

aiModelOfferingRoutes.post('/platform/:platformModelId', ...partnerWrite, zValidator('json', offeringEnableSchema), async (c) => {
  const { partnerId } = requirePartnerWide(c);
  const platformModelId = c.req.param('platformModelId');
  return registryWrite(c, partnerId, async () => {
    const { enabled } = c.req.valid('json');
    // One statement: add + (gated) enable. Never a separate setOfferingEnabled on
    // the just-inserted row, because the loader cannot see it yet (Q13).
    const offering = await ensurePlatformOffering({ partnerId, platformModelId, enabled });
    auditOffering(c, partnerId, 'added', { offeringId: offering.id, platformModelId, enabled });
    return c.json({ id: offering.id, enabled: offering.enabled, updatedAt: offering.updatedAt.toISOString() });
  });
});

aiModelOfferingRoutes.post('/:id/enabled', ...partnerWrite, zValidator('json', offeringEnableSchema), async (c) => {
  const { partnerId } = requirePartnerWide(c);
  const { enabled, force } = c.req.valid('json');
  return registryWrite(c, partnerId, async () => {
    const { offering, inUse } = await setOfferingEnabled({ partnerId, offeringId: c.req.param('id'), enabled, force });
    auditOffering(c, partnerId, enabled ? 'enabled' : 'disabled', { offeringId: offering.id, force, affectedSurfaces: inUse });
    return c.json({ id: offering.id, enabled: offering.enabled, inUse, updatedAt: offering.updatedAt.toISOString() });
  });
});

aiModelOfferingRoutes.patch('/:id', ...partnerWrite, zValidator('json', offeringDetailsPatchSchema), async (c) => {
  const { partnerId } = requirePartnerWide(c);
  const patch = c.req.valid('json');
  return registryWrite(c, partnerId, async () => {
    const offering = await updateOfferingDetails({ partnerId, offeringId: c.req.param('id'), patch });
    const { expectedUpdatedAt: _ignored, ...changed } = patch;
    auditOffering(c, partnerId, 'updated', { offeringId: offering.id, fields: Object.keys(changed) });
    return c.json({ id: offering.id, updatedAt: offering.updatedAt.toISOString() });
  });
});

aiModelOfferingRoutes.post('/:id/verify', ...partnerWrite, async (c) => {
  const { partnerId } = requirePartnerWide(c);
  return registryWrite(c, partnerId, async () => {
    const offering = await getOffering(c.req.param('id'));
    if (!offering || offering.partnerId !== partnerId) return c.json({ error: 'Model not found.', code: 'not_found' }, 404);
    if (!offering.connectionId) {
      return c.json({ error: 'Platform models are verified by the Breeze operator.', code: 'conflict' }, 409);
    }
    await enqueueConnectionSync(offering.connectionId);
    auditOffering(c, partnerId, 'verify_requested', { offeringId: offering.id, connectionId: offering.connectionId });
    return c.json({ queued: true }, 202);
  });
});
```

"Verify" (spec §11) in v1 re-runs discovery for the offering's connection, which re-reads capabilities and lifecycle. Harness verification of BYO models is W06. Platform models are verified on `/admin/ai-models`. See Decision D4.

`apps/api/src/routes/aiModels/assignments.ts`:

```ts
import { Hono } from 'hono';
import { partnerAssignmentsPutSchema } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { writeRouteAudit } from '../../services/auditEvents';
import { putPartnerAssignments, touchesSurface } from '../../services/aiModels/assignmentWrites';
import { APPROVALS_DECIDE_REQUIRED, canDecideApprovals, partnerWrite, registryWrite, requirePartnerWide } from './shared';

export const aiModelAssignmentRoutes = new Hono();

aiModelAssignmentRoutes.put('/', ...partnerWrite, zValidator('json', partnerAssignmentsPutSchema), async (c) => {
  const { partnerId } = requirePartnerWide(c);
  const { assignments } = c.req.valid('json');
  if (touchesSurface(assignments, 'script_reviewer') && !canDecideApprovals(c)) {
    return c.json(APPROVALS_DECIDE_REQUIRED, 403);
  }
  return registryWrite(c, partnerId, async () => {
    const rows = await putPartnerAssignments({ partnerId, rows: assignments });
    writeRouteAudit(c, {
      orgId: null, action: 'ai_models.assignments.updated', resourceType: 'partner', resourceId: partnerId,
      details: { surfaces: assignments.map((a) => a.surface) },
    });
    return c.json({ assignments: rows.map((r) => ({ surface: r.surface, role: r.role, updatedAt: r.updatedAt.toISOString() })) });
  });
});
```

`apps/api/src/routes/aiModels/residency.ts`:

```ts
import { Hono } from 'hono';
import { residencyPutSchema } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { writeRouteAudit } from '../../services/auditEvents';
import { previewResidencyImpact, setResidencyRequired } from '../../services/aiModels/residency';
import { partnerRead, partnerWrite, registryWrite, requirePartnerWide } from './shared';

export const aiModelResidencyRoutes = new Hono();

aiModelResidencyRoutes.get('/preview', ...partnerRead, async (c) => {
  const { partnerId } = requirePartnerWide(c);
  return c.json(await previewResidencyImpact(partnerId));
});

aiModelResidencyRoutes.put('/', ...partnerWrite, zValidator('json', residencyPutSchema), async (c) => {
  const { partnerId } = requirePartnerWide(c);
  const body = c.req.valid('json');
  return registryWrite(c, partnerId, async () => {
    const result = await setResidencyRequired({ partnerId, ...body });
    writeRouteAudit(c, {
      orgId: null, action: 'ai_models.residency.updated', resourceType: 'partner', resourceId: partnerId,
      details: { required: body.required, unavailableSurfaces: result.impact.unavailableSurfaces },
    });
    return c.json(result);
  });
});
```

`apps/api/src/routes/aiModels/index.ts`:

```ts
/**
 * /ai/models — the partner AI model registry API (W04, #7602): connections,
 * offerings, partner assignments, residency, org overrides and usage. Mounted
 * in index.ts BEFORE the broad api.route('/ai', …) mounts (Hono matches in
 * registration order).
 */
import { Hono } from 'hono';
import { authMiddleware } from '../../middleware/auth';
import { buildPartnerModelsSnapshot } from '../../services/aiModels/registryView';
import { aiModelAssignmentRoutes } from './assignments';
import { aiModelConnectionRoutes } from './connections';
import { aiModelOfferingRoutes } from './offerings';
import { aiModelOrgAssignmentRoutes } from './orgAssignments';
import { aiModelResidencyRoutes } from './residency';
import { aiModelUsageRoutes } from './usage';
import { partnerRead, requirePartnerWide } from './shared';

export const aiModelsRoutes = new Hono();
aiModelsRoutes.use('*', authMiddleware);

aiModelsRoutes.get('/', ...partnerRead, async (c) => {
  const { partnerId } = requirePartnerWide(c);
  return c.json(await buildPartnerModelsSnapshot(partnerId));
});

aiModelsRoutes.route('/connections', aiModelConnectionRoutes);
aiModelsRoutes.route('/offerings', aiModelOfferingRoutes);
aiModelsRoutes.route('/assignments', aiModelAssignmentRoutes);
aiModelsRoutes.route('/residency', aiModelResidencyRoutes);
aiModelsRoutes.route('/orgs', aiModelOrgAssignmentRoutes);
aiModelsRoutes.route('/usage', aiModelUsageRoutes);
```

`orgAssignments.ts` and `usage.ts` are created in Task 9. Until then, create both as stubs that export an empty `new Hono()`, so this task typechecks. Task 9 replaces them.

Mount in `apps/api/src/index.ts`, directly after `api.route('/ai/provider', aiProviderRoutes);`:

```ts
// AI model registry (W04 #7602) — before the broad '/ai' mounts (Hono matches in order).
api.route('/ai/models', aiModelsRoutes);
```

`routes/aiProvider.ts`: delete its local `buildCatalogSummary` and import it from `../services/aiModels/registryView`. `aiProvider.test.ts` mocks `../services/llmProviderCatalog`, so add `vi.mock('../services/aiModels/registryView', async (o) => ({ ...(await o()), }))` only if the import breaks the existing mocks. Otherwise leave it.

Also in `routes/aiProvider.ts`, the compat `PATCH /` (default model) becomes:

```ts
aiProviderRoutes.patch(
  '/',
  requirePermission(PERMISSIONS.BILLING_MANAGE.resource, PERMISSIONS.BILLING_MANAGE.action),
  requireMfa(),                                   // W04: parity with /ai/models writes
  zValidator('json', updateConfigSchema),
  async (c) => {
    const auth = c.get('auth');
    if (!auth?.partnerId) throw new HTTPException(403, { message: 'Partner context required' });
    if (!canManagePartnerWidePolicies(auth)) throw new HTTPException(403, { message: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
    // W03 changeCompatDefaultModel re-points partner assignments on the old
    // default, script_reviewer included: same gate as PUT /ai/models/assignments.
    if (!canDecideApprovals(c)) return c.json(APPROVALS_DECIDE_REQUIRED, 403);
    /* … unchanged body … */
  },
);
```

`canDecideApprovals` and `APPROVALS_DECIDE_REQUIRED` are imported from `./aiModels/shared`.

`apps/api/src/services/mcpCoverage.ts`: add these keys, alphabetically, next to `'aiProvider.ts'`:

```ts
'aiModels/index.ts': { exempt: 'human_only_ai_governance', note: 'Partner AI model registry snapshot -- what models and keys the AI may use; the AI must not manage its own model provider.' },
'aiModels/connections.ts': { exempt: 'human_only_ai_governance', note: 'BYO model connections and keys -- a credential, and the AI must not manage its own model provider.' },
'aiModels/offerings.ts': { exempt: 'human_only_ai_governance', note: 'Enabling, pricing and gating AI models -- the AI must not widen its own model access or spend.' },
'aiModels/assignments.ts': { exempt: 'human_only_ai_governance', note: 'Per-feature model defaults and permitted sets -- the AI must not choose its own model policy.' },
'aiModels/residency.ts': { exempt: 'human_only_ai_governance', note: 'Data-residency requirement for AI calls -- a compliance control the AI must not change.' },
```

Task 9 adds `aiModels/orgAssignments.ts` and `aiModels/usage.ts`. `shared.ts` has no route method calls, so `mcp-coverage.test.ts` does not index it.

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cd apps/api && npx vitest run src/services/aiModels/registryView.test.ts src/routes/aiModels/partnerRoutes.test.ts \
  src/routes/aiProvider.test.ts src/routes/aiProvider.registry.test.ts \
  src/__tests__/mcp-coverage.test.ts src/__tests__/routerAuthGate.contract.test.ts src/__tests__/partner-wide-write-coverage.test.ts
```
Expected: PASS. `routerAuthGate.contract.test.ts` must show `/ai/models` returning 401 unauthenticated, which proves the mount sits behind `authMiddleware`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiModels/registryView.ts apps/api/src/services/aiModels/registryView.test.ts \
  apps/api/src/routes/aiModels apps/api/src/routes/aiProvider.ts apps/api/src/index.ts apps/api/src/services/mcpCoverage.ts
git commit -m "feat(ai-models): /ai/models partner API — snapshot, connections, offerings, assignments, residency (#7602)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Org override routes and the usage breakdown

**Files:**
- Create: `apps/api/src/services/aiModels/usageQueries.ts` + `usageQueries.test.ts`
- Replace stub: `apps/api/src/routes/aiModels/orgAssignments.ts`
- Replace stub: `apps/api/src/routes/aiModels/usage.ts`
- Create: `apps/api/src/routes/aiModels/orgAndUsageRoutes.test.ts`
- Modify: `apps/api/src/services/mcpCoverage.ts` (two entries)

**Interfaces:**
- Consumes: Tasks 1, 6, 8; W03 `readOrgPartnerId` (Q2); merged `aiInvocations`, `partnerAiModels`, `aiPlatformModels`, `users`, `organizations`, `requireScope`, `PERMISSIONS.ORGS_READ` / `ORGS_WRITE` / `AI_SESSIONS_READ_ALL`.
- Produces:

```ts
export function queryAiUsageBreakdown(input: { groupBy: AiUsageGroupBy; from: string; to: string; orgId: string | null }): Promise<AiUsageBreakdownDto>;
export function defaultUsageRange(now?: Date): { from: string; to: string };  // first of the UTC month → today
export const aiModelOrgAssignmentRoutes: Hono;   // GET/PUT /:orgId/assignments
export const aiModelUsageRoutes: Hono;           // GET /
```

**Org routes:**

| Route | Gate | Behaviour |
|---|---|---|
| `GET /orgs/:orgId/assignments` | `requireScope('partner','system','organization')`, `requirePermission(ORGS_READ)`, `auth.canAccessOrg(orgId)` | `partnerId = readOrgPartnerId(orgId)`. A partner-scope caller must have `auth.partnerId === partnerId`, else 404. Returns `buildOrgModelDefaults` with `canEdit = hasPermission(perms,'organizations','write')` and `canEditReviewer = canEdit && canDecideApprovals(c)`. |
| `PUT /orgs/:orgId/assignments` | the same scopes, `requirePermission(ORGS_WRITE)`, `requireMfa()`, `canAccessOrg`; `approvals:decide` when a row's surface is `script_reviewer` | `registryWrite(c, partnerId, () => putOrgAssignments(...))`. Audit `ai_models.org_assignments.updated` with `orgId` set and `resourceType: 'organization'`. |

**Usage route:**
- `GET /usage?groupBy=&from=&to=&orgId=`
- Gate: `requireScope('partner','system')`, `requirePermission(AI_SESSIONS_READ_ALL)`, and `canAccessOrg(orgId)` when `orgId` is given (403 otherwise). This is the same gate the page's existing `/ai/admin/sessions` call uses, because the breakdown exposes per-tech spend.
- The query runs in the request DB context, so `ai_invocations`'s shape-1 RLS (`breeze_has_org_access`) limits a partner to its own orgs **without** an app-layer partner filter.

**Usage semantics (pinned by tests):**
- Only `ledger_mode = 'authoritative'` rows count. W02 shadow rows were never billed (PR #7665: "shadow totals are approximate").
- `invocations` = row count. `refusals` = rows with `stop_reason = 'refusal'`. `fallbacks` = rows with `fallback_used`. A refused turn that a refusal fallback then served writes **two** rows (W03 Task 6): one refused, one with `fallback_used`. `refusalRate = refusals / invocations` is therefore "declined calls per model call". The UI label says "Refusal rate (per call)".
- `costCents` = `SUM(cost_cents)`. `inputTokens` = `SUM(input_tokens + cache_read_tokens + cache_write_tokens)`, the same definition as W03's rollup. `outputTokens` = `SUM(output_tokens)`.
- Grouping and labels:

  | `groupBy` | `key` | `label` |
  |---|---|---|
  | `model` | `COALESCE(offering_id::text, 'model:' || served_model)` | `COALESCE(m.display_name, pm.display_name, m.model_id, served_model)` |
  | `surface` | `surface` | `surface`; the web translates it |
  | `user` | `COALESCE(user_id::text, 'system')` | `COALESCE(u.name, 'system')`; the web translates `system` |
  | `org` | `org_id::text` | `o.name` |

- Rows are ordered by cost descending, then invocations descending, and capped at 200. `totals` comes from a separate ungrouped aggregate.
- `from`/`to` are inclusive UTC dates: `created_at >= from AND created_at < to + 1 day`.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/aiModels/usageQueries.test.ts` is a pure unit test of the SQL builder and the row mapping. The query builder is exported as `buildUsageQuery(input)` returning a drizzle `SQL`. Assert on its rendered text through `new PgDialect().sqlToQuery(q)`:

```ts
import { PgDialect } from 'drizzle-orm/pg-core';
import { buildUsageQuery, defaultUsageRange, toUsageRow } from './usageQueries';

const render = (q: ReturnType<typeof buildUsageQuery>) => new PgDialect().sqlToQuery(q);

describe('buildUsageQuery', () => {
  it('counts only authoritative ledger rows', () => {
    expect(render(buildUsageQuery({ groupBy: 'model', from: '2026-10-01', to: '2026-10-31', orgId: null })).sql)
      .toContain(`"ledger_mode" = 'authoritative'`);
  });
  it('treats `to` as inclusive (created_at < to + 1 day)', () => {
    const { params } = render(buildUsageQuery({ groupBy: 'surface', from: '2026-10-01', to: '2026-10-31', orgId: null }));
    expect(params).toContain('2026-11-01T00:00:00.000Z');
  });
  it('filters by org only when orgId is given', () => {
    expect(render(buildUsageQuery({ groupBy: 'org', from: '2026-10-01', to: '2026-10-02', orgId: null })).sql).not.toMatch(/"org_id" = \$/);
    expect(render(buildUsageQuery({ groupBy: 'org', from: '2026-10-01', to: '2026-10-02', orgId: 'o1' })).params).toContain('o1');
  });
  it.each(['model', 'surface', 'user', 'org'] as const)('groups by %s with a stable key expression', (groupBy) => {
    expect(render(buildUsageQuery({ groupBy, from: '2026-10-01', to: '2026-10-02', orgId: null })).sql).toMatch(/GROUP BY/i);
  });
});

describe('toUsageRow', () => {
  it('computes refusalRate and coerces numerics', () => {
    expect(toUsageRow({ key: 'k', label: 'L', invocations: '4', cost_cents: '12.5', input_tokens: '100', output_tokens: '50', refusals: '1', fallbacks: '0' }))
      .toEqual({ key: 'k', label: 'L', invocations: 4, costCents: 12.5, inputTokens: 100, outputTokens: 50, refusals: 1, refusalRate: 0.25, fallbacks: 0 });
  });
  it('refusalRate is 0 with no invocations', () => {
    expect(toUsageRow({ key: 'k', label: 'L', invocations: '0', cost_cents: null, input_tokens: null, output_tokens: null, refusals: '0', fallbacks: '0' }).refusalRate).toBe(0);
  });
});

describe('defaultUsageRange', () => {
  it('is the first of the UTC month through today', () => {
    expect(defaultUsageRange(new Date('2026-10-17T05:00:00Z'))).toEqual({ from: '2026-10-01', to: '2026-10-17' });
  });
});
```

`apps/api/src/routes/aiModels/orgAndUsageRoutes.test.ts` uses the same harness as Task 8, with `canAccessOrg` on the auth state:

```ts
describe('org assignment routes', () => {
  it('GET 403s an org the caller cannot access', async () => {
    authState.value.canAccessOrg = () => false;
    expect((await call('GET', `/orgs/${ORG}/assignments`)).status).toBe(403);
  });
  it('GET 404s an org of another partner for a partner-scope caller', async () => {
    readOrgPartnerId.mockResolvedValue('other-partner');
    expect((await call('GET', `/orgs/${ORG}/assignments`)).status).toBe(404);
  });
  it('GET works for an org-scope token of that org', async () => {
    authState.value = { ...orgToken, orgId: ORG, canAccessOrg: (id: string) => id === ORG };
    readOrgPartnerId.mockResolvedValue(P);
    expect((await call('GET', `/orgs/${ORG}/assignments`)).status).toBe(200);
  });
  it('PUT needs ORGS_WRITE and MFA', async () => {
    authGates.mfaDenied = true;
    expect((await call('PUT', `/orgs/${ORG}/assignments`, { assignments: [orgChatRow] })).status).toBe(403);
  });
  it('PUT on script_reviewer needs approvals:decide', async () => {
    permissionsState.approvalsDecide = false;
    const res = await call('PUT', `/orgs/${ORG}/assignments`, { assignments: [{ ...orgChatRow, surface: 'script_reviewer' }] });
    expect(res.status).toBe(403);
    expect(putOrgAssignments).not.toHaveBeenCalled();
  });
  it('PUT passes the ORG’s partner id (never caller input) and audits with orgId', async () => {
    readOrgPartnerId.mockResolvedValue(P);
    await call('PUT', `/orgs/${ORG}/assignments`, { assignments: [orgChatRow] });
    expect(putOrgAssignments).toHaveBeenCalledWith({ partnerId: P, orgId: ORG, rows: [expect.objectContaining({ surface: 'chat' })] });
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ orgId: ORG, action: 'ai_models.org_assignments.updated' }));
  });
  it('PUT maps widens_partner to 422 with details', async () => {
    readOrgPartnerId.mockResolvedValue(P);
    putOrgAssignments.mockRejectedValue(new RegistryWriteError('narrow only', 'widens_partner', 422, { surface: 'chat', field: 'options', key: 'effort' }));
    const res = await call('PUT', `/orgs/${ORG}/assignments`, { assignments: [orgChatRow] });
    expect([res.status, (await res.json()).details]).toEqual([422, { surface: 'chat', field: 'options', key: 'effort' }]);
  });
});

describe('usage route', () => {
  it('needs ai_sessions:read_all', async () => {
    authGates.permissionDenied = true;
    expect((await call('GET', '/usage?groupBy=model')).status).toBe(403);
  });
  it('rejects org-scope tokens (partner/system only)', async () => {
    authState.value = { ...orgToken };
    expect((await call('GET', '/usage?groupBy=model')).status).toBe(403);
  });
  it('403s an orgId the caller cannot access', async () => {
    authState.value.canAccessOrg = () => false;
    expect((await call('GET', `/usage?groupBy=model&orgId=${ORG}`)).status).toBe(403);
  });
  it('400s a range over 92 days', async () => {
    expect((await call('GET', '/usage?groupBy=model&from=2026-01-01&to=2026-06-01')).status).toBe(400);
  });
  it('defaults the range to month-to-date', async () => {
    await call('GET', '/usage?groupBy=surface');
    expect(queryAiUsageBreakdown).toHaveBeenCalledWith(expect.objectContaining({ groupBy: 'surface', orgId: null, from: expect.stringMatching(/-01$/) }));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/usageQueries.test.ts src/routes/aiModels/orgAndUsageRoutes.test.ts`
Expected: FAIL. `usageQueries` is missing, and the stub routers return 404.

- [ ] **Step 3: Write the implementation**

`apps/api/src/services/aiModels/usageQueries.ts`:

```ts
/**
 * AI usage breakdowns from the invocation ledger (spec §5.5, §11). Runs in the
 * request DB context: ai_invocations is shape-1 RLS, so a partner token sees
 * only its orgs. Counts authoritative rows only (W02 shadow rows were never billed).
 */
import { sql, type SQL } from 'drizzle-orm';
import type { AiUsageBreakdownDto, AiUsageGroupBy, AiUsageRowDto } from '@breeze/shared';
import { db } from '../../db';

const KEY: Record<AiUsageGroupBy, SQL> = {
  model: sql`COALESCE(i.offering_id::text, 'model:' || i.served_model)`,
  surface: sql`i.surface`,
  user: sql`COALESCE(i.user_id::text, 'system')`,
  org: sql`i.org_id::text`,
};
const LABEL: Record<AiUsageGroupBy, SQL> = {
  model: sql`COALESCE(m.display_name, pm.display_name, m.model_id, i.served_model)`,
  surface: sql`i.surface`,
  user: sql`COALESCE(u.name, 'system')`,
  org: sql`o.name`,
};

function nextDayIso(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

function where(input: { from: string; to: string; orgId: string | null }): SQL {
  return sql`i.ledger_mode = 'authoritative'
    AND i.created_at >= ${`${input.from}T00:00:00.000Z`}::timestamptz
    AND i.created_at < ${nextDayIso(input.to)}::timestamptz
    ${input.orgId ? sql`AND i.org_id = ${input.orgId}::uuid` : sql``}`;
}

const AGGREGATES = sql`
  COUNT(*)::text AS invocations,
  SUM(i.cost_cents)::text AS cost_cents,
  SUM(i.input_tokens + i.cache_read_tokens + i.cache_write_tokens)::text AS input_tokens,
  SUM(i.output_tokens)::text AS output_tokens,
  COUNT(*) FILTER (WHERE i.stop_reason = 'refusal')::text AS refusals,
  COUNT(*) FILTER (WHERE i.fallback_used)::text AS fallbacks`;

export function buildUsageQuery(input: { groupBy: AiUsageGroupBy; from: string; to: string; orgId: string | null }): SQL {
  return sql`
    SELECT ${KEY[input.groupBy]} AS key, ${LABEL[input.groupBy]} AS label, ${AGGREGATES}
    FROM ai_invocations i
    LEFT JOIN partner_ai_models m ON m.id = i.offering_id
    LEFT JOIN ai_platform_models pm ON pm.id = m.platform_model_id
    LEFT JOIN users u ON u.id = i.user_id
    LEFT JOIN organizations o ON o.id = i.org_id
    WHERE ${where(input)}
    GROUP BY 1, 2
    ORDER BY SUM(i.cost_cents) DESC NULLS LAST, COUNT(*) DESC
    LIMIT 200`;
}

type RawRow = { key?: string; label?: string | null; invocations: string; cost_cents: string | null; input_tokens: string | null; output_tokens: string | null; refusals: string; fallbacks: string };

export function toUsageRow(r: RawRow): AiUsageRowDto {
  const invocations = Number(r.invocations ?? 0);
  const refusals = Number(r.refusals ?? 0);
  return {
    key: r.key ?? '', label: r.label ?? r.key ?? '',
    invocations, costCents: Number(r.cost_cents ?? 0),
    inputTokens: Number(r.input_tokens ?? 0), outputTokens: Number(r.output_tokens ?? 0),
    refusals, refusalRate: invocations === 0 ? 0 : refusals / invocations, fallbacks: Number(r.fallbacks ?? 0),
  };
}

export function defaultUsageRange(now: Date = new Date()): { from: string; to: string } {
  const to = now.toISOString().slice(0, 10);
  return { from: `${to.slice(0, 8)}01`, to };
}

export async function queryAiUsageBreakdown(input: { groupBy: AiUsageGroupBy; from: string; to: string; orgId: string | null }): Promise<AiUsageBreakdownDto> {
  const rows = await db.execute<RawRow>(buildUsageQuery(input));
  const [total] = await db.execute<RawRow>(sql`SELECT ${AGGREGATES} FROM ai_invocations i WHERE ${where(input)}`);
  const { key: _k, label: _l, ...totals } = toUsageRow(total ?? { invocations: '0', cost_cents: null, input_tokens: null, output_tokens: null, refusals: '0', fallbacks: '0' });
  return { groupBy: input.groupBy, from: input.from, to: input.to, orgId: input.orgId, rows: [...rows].map(toUsageRow), totals };
}
```

`apps/api/src/routes/aiModels/orgAssignments.ts`:

```ts
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { orgAssignmentsPutSchema } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS, hasPermission } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import { readOrgPartnerId } from '../../services/aiModels/candidateLoader';
import { buildOrgModelDefaults } from '../../services/aiModels/registryView';
import { putOrgAssignments, touchesSurface } from '../../services/aiModels/assignmentWrites';
import { APPROVALS_DECIDE_REQUIRED, canDecideApprovals, registryWrite } from './shared';

export const aiModelOrgAssignmentRoutes = new Hono();

/** The org's partner, after the caller's org access is proven. Never trusts input for the partner id. */
async function orgPartnerFor(c: Context, orgId: string): Promise<string> {
  const auth = c.get('auth');
  if (!auth?.canAccessOrg?.(orgId)) throw new HTTPException(403, { message: 'Organization access denied' });
  const partnerId = await readOrgPartnerId(orgId);
  if (!partnerId) throw new HTTPException(404, { message: 'Organization not found' });
  if (auth.scope === 'partner' && auth.partnerId !== partnerId) throw new HTTPException(404, { message: 'Organization not found' });
  return partnerId;
}

aiModelOrgAssignmentRoutes.get('/:orgId/assignments',
  requireScope('partner', 'system', 'organization'),
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
  async (c) => {
    const orgId = c.req.param('orgId');
    const partnerId = await orgPartnerFor(c, orgId);
    const perms = c.get('permissions');
    const canEdit = Boolean(perms) && hasPermission(perms, PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);
    return c.json(await buildOrgModelDefaults({ partnerId, orgId, canEdit, canEditReviewer: canEdit && canDecideApprovals(c) }));
  });

aiModelOrgAssignmentRoutes.put('/:orgId/assignments',
  requireScope('partner', 'system', 'organization'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('json', orgAssignmentsPutSchema),
  async (c) => {
    const orgId = c.req.param('orgId');
    const partnerId = await orgPartnerFor(c, orgId);
    const { assignments } = c.req.valid('json');
    if (touchesSurface(assignments, 'script_reviewer') && !canDecideApprovals(c)) return c.json(APPROVALS_DECIDE_REQUIRED, 403);
    return registryWrite(c, partnerId, async () => {
      const rows = await putOrgAssignments({ partnerId, orgId, rows: assignments });
      writeRouteAudit(c, {
        orgId, action: 'ai_models.org_assignments.updated', resourceType: 'organization', resourceId: orgId,
        details: { surfaces: assignments.map((a) => a.surface) },
      });
      return c.json({ assignments: rows.map((r) => ({ surface: r.surface, role: r.role, updatedAt: r.updatedAt.toISOString() })) });
    });
  });
```

`apps/api/src/routes/aiModels/usage.ts`:

```ts
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { aiUsageQuerySchema } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { defaultUsageRange, queryAiUsageBreakdown } from '../../services/aiModels/usageQueries';

export const aiModelUsageRoutes = new Hono();

aiModelUsageRoutes.get('/',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.AI_SESSIONS_READ_ALL.resource, PERMISSIONS.AI_SESSIONS_READ_ALL.action),
  zValidator('query', aiUsageQuerySchema),
  async (c) => {
    const q = c.req.valid('query');
    const auth = c.get('auth');
    if (q.orgId && !auth.canAccessOrg(q.orgId)) throw new HTTPException(403, { message: 'Organization access denied' });
    const range = defaultUsageRange();
    return c.json(await queryAiUsageBreakdown({
      groupBy: q.groupBy, from: q.from ?? range.from, to: q.to ?? range.to, orgId: q.orgId ?? null,
    }));
  });
```

`mcpCoverage.ts`:

```ts
'aiModels/orgAssignments.ts': { exempt: 'human_only_ai_governance', note: 'Org narrowing of AI model defaults -- the AI must not choose its own model policy.' },
'aiModels/usage.ts': { exempt: 'human_only_ai_governance', note: 'AI spend and refusal reporting by model / feature / tech -- admin showback, not an agent workflow.' },
```

If `mcp-coverage.test.ts` rejects `human_only_ai_governance` for a read-only report, use the `McpExemptReason` value that the existing `routes/clientAi/adminUsage.ts` entry uses. Find it with `git grep -n "adminUsage" apps/api/src/services/mcpCoverage.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/aiModels/usageQueries.test.ts src/routes/aiModels src/__tests__/mcp-coverage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiModels/usageQueries.ts apps/api/src/services/aiModels/usageQueries.test.ts \
  apps/api/src/routes/aiModels/orgAssignments.ts apps/api/src/routes/aiModels/usage.ts \
  apps/api/src/routes/aiModels/orgAndUsageRoutes.test.ts apps/api/src/services/mcpCoverage.ts
git commit -m "feat(ai-models): org model-default override routes and ai_invocations usage breakdown (#7602)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Real-Postgres tenancy and contract suite

The unit suites mock the DB. This suite proves the three properties that only Postgres + RLS can prove, as `breeze_app` with each tenancy shape:
- cross-tenant ids never write;
- tighten-only and the ownership trigger hold together;
- the usage query is tenant-bounded.

**Files:**
- Create: `apps/api/src/__tests__/integration/aiModelsRoutes.integration.test.ts`

**Interfaces:**
- Consumes:
  - W03 `__tests__/integration/helpers/aiModelRegistrySeed.ts` `seedRegistryPartner`;
  - W02 `aiModelRegistryFixtures.ts` (`partnerContext`, `orgContext`, `seedPlatformModel`, `seedOffering`, `fixtureSql`);
  - `db-utils.ts` `createPartner`, `createOrganization`;
  - `withDbAccessContext`;
  - Tasks 4–9 services.

- [ ] **Step 1: Write the tests**

```ts
import './setup';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withDbAccessContext } from '../../db';
import { createOrganization, createPartner } from './db-utils';
import { closeRegistryFixtures, fixtureSql, orgContext, partnerContext, seedOffering, seedPlatformModel } from './aiModelRegistryFixtures';
import { putOrgAssignments, putPartnerAssignments } from '../../services/aiModels/assignmentWrites';
import { setOfferingEnabled, updateOfferingDetails } from '../../services/aiModels/offeringWrites';
import { setResidencyRequired } from '../../services/aiModels/residency';
import { queryAiUsageBreakdown } from '../../services/aiModels/usageQueries';

let pA: string; let pB: string; let orgA: string; let orgB: string; let pm: string;
let offA: string; let offA2: string; let offB: string;

/**
 * W02's seedPlatformModel() inserts identity fields only: unpriced, not offered,
 * no capabilities (Codex review finding 17). Make the row explicitly eligible.
 * The tests use NON-tool surfaces (catalog_enrichment, extension_content), so
 * no capability tree is needed.
 */
async function seedEligiblePlatformModel(): Promise<string> {
  const id = await seedPlatformModel();
  await fixtureSql`UPDATE ai_platform_models SET
    input_cents_per_m = 300, output_cents_per_m = 1500, cache_read_cents_per_m = 30, cache_write_cents_per_m = 375,
    platform_offered = true, lifecycle = 'available'
    WHERE id = ${id}`;
  return id;
}

beforeAll(async () => {
  pA = (await createPartner()).id; pB = (await createPartner()).id;
  orgA = (await createOrganization({ partnerId: pA })).id; orgB = (await createOrganization({ partnerId: pB })).id;
  pm = await seedEligiblePlatformModel();
  const pm2 = await seedEligiblePlatformModel();
  offA = await seedOffering({ partnerId: pA, platformModelId: pm, enabled: true });
  offA2 = await seedOffering({ partnerId: pA, platformModelId: pm2, enabled: true });
  offB = await seedOffering({ partnerId: pB, platformModelId: pm, enabled: true });
  // Mark both partners cut over (W03 Task 6A) so ensurePartnerCutover is a no-op here.
  await fixtureSql`INSERT INTO ai_model_registry_partner_cutover (partner_id) VALUES (${pA}), (${pB}) ON CONFLICT DO NOTHING`;
});
afterAll(closeRegistryFixtures);

const asPartner = <T>(p: string, orgs: string[], fn: () => Promise<T>) => withDbAccessContext(partnerContext(p, orgs), fn);
const asOrg = <T>(o: string, p: string, fn: () => Promise<T>) => withDbAccessContext(orgContext(o, p), fn);
const partnerRow = (surface: 'catalog_enrichment' | 'extension_content', def: string, permitted: string[] | null = null) => ({
  surface, role: 'default' as const, defaultOfferingId: def, permittedOfferingIds: permitted,
  allowUserChoice: true, options: null, expectedUpdatedAt: null,
});

describe('cross-tenant ids never write (as breeze_app)', () => {
  it('partner A cannot point a default at partner B’s offering', async () => {
    const err = await asPartner(pA, [orgA], () => putPartnerAssignments({ partnerId: pA, rows: [partnerRow('extension_content', offB)] })).catch((e) => e);
    expect([err.status, err.code]).toEqual([422, 'not_eligible']);
    const [{ n }] = await fixtureSql`SELECT count(*)::int n FROM ai_model_assignments WHERE default_offering_id = ${offB} AND partner_id = ${pA}`;
    expect(n).toBe(0);
  });

  it('partner A cannot enable or edit partner B’s offering (404)', async () => {
    expect((await asPartner(pA, [orgA], () => setOfferingEnabled({ partnerId: pA, offeringId: offB, enabled: false, force: true })).catch((e) => e)).status).toBe(404);
    expect((await asPartner(pA, [orgA], () => updateOfferingDetails({ partnerId: pA, offeringId: offB, patch: { expectedUpdatedAt: new Date().toISOString(), displayName: 'x' } })).catch((e) => e)).status).toBe(404);
  });

  it('a forged org override for another partner’s org never writes', async () => {
    const err = await asPartner(pA, [orgA], () => putOrgAssignments({ partnerId: pA, orgId: orgB, rows: [{
      surface: 'extension_content', role: 'default', defaultOfferingId: null, permittedOfferingIds: null, allowUserChoice: false, options: null, expectedUpdatedAt: null,
    }] })).catch((e) => e);
    // Composite FK (org_id, offering_partner_id) → 23503 → 422, or RLS WITH CHECK denial (no org access) — either way nothing lands.
    expect(err).toBeInstanceOf(Error);
    const [{ n }] = await fixtureSql`SELECT count(*)::int n FROM ai_model_assignments WHERE org_id = ${orgB}`;
    expect(n).toBe(0);
  });
});

describe('tighten-only + ownership trigger, under an org token', () => {
  it('an org admin narrows within the partner set', async () => {
    await asPartner(pA, [orgA], () => putPartnerAssignments({ partnerId: pA, rows: [partnerRow('catalog_enrichment', offA, [offA, offA2])] }));
    const rows = await asOrg(orgA, pA, () => putOrgAssignments({ partnerId: pA, orgId: orgA, rows: [{
      surface: 'catalog_enrichment', role: 'default', defaultOfferingId: offA2, permittedOfferingIds: [offA2], allowUserChoice: false, options: null, expectedUpdatedAt: null,
    }] }));
    expect(rows[0]).toMatchObject({ orgId: orgA, offeringPartnerId: pA, defaultOfferingId: offA2 });
  });

  it('an org token cannot widen beyond the partner set (422 widens_partner), and the DB is unchanged', async () => {
    const offA3 = await seedOffering({ partnerId: pA, platformModelId: await seedEligiblePlatformModel(), enabled: true });
    const [{ v }] = await fixtureSql`SELECT to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') v FROM ai_model_assignments WHERE org_id = ${orgA} AND surface = 'catalog_enrichment'`;
    const err = await asOrg(orgA, pA, () => putOrgAssignments({ partnerId: pA, orgId: orgA, rows: [{
      surface: 'catalog_enrichment', role: 'default', defaultOfferingId: null, permittedOfferingIds: [offA3], allowUserChoice: null, options: null, expectedUpdatedAt: v,
    }] })).catch((e) => e);
    expect([err.status, err.code]).toEqual([422, 'widens_partner']);
  });

  it('an org token cannot reference a disabled offering (write check + trigger agree)', async () => {
    const offOff = await seedOffering({ partnerId: pA, platformModelId: await seedEligiblePlatformModel(), enabled: false });
    const err = await asOrg(orgA, pA, () => putOrgAssignments({ partnerId: pA, orgId: orgA, rows: [{
      surface: 'extension_content', role: 'default', defaultOfferingId: null, permittedOfferingIds: [offOff], allowUserChoice: null, options: null, expectedUpdatedAt: null,
    }] })).catch((e) => e);
    expect(err.status).toBe(422);
  });

  it('a microsecond DB timestamp still matches its ms-precision version token (stale-write precision)', async () => {
    await fixtureSql`SELECT set_config('breeze.scope','system',false)`;
    await fixtureSql`UPDATE ai_model_assignments SET updated_at = '2026-10-01T10:00:00.123456Z' WHERE org_id = ${orgA} AND surface = 'catalog_enrichment'`;
    const rows = await asOrg(orgA, pA, () => putOrgAssignments({ partnerId: pA, orgId: orgA, rows: [{
      surface: 'catalog_enrichment', role: 'default', defaultOfferingId: offA2, permittedOfferingIds: [offA2], allowUserChoice: null, options: null,
      expectedUpdatedAt: '2026-10-01T10:00:00.123Z',
    }] }));
    expect(rows).toHaveLength(1);
  });
});


describe('residency writer', () => {
  it('creates settings.ai on a partner with no settings and keeps sibling keys', async () => {
    await fixtureSql`UPDATE partners SET settings = '{"ml": {"x": 1}}'::jsonb WHERE id = ${pB}`;
    await asPartner(pB, [orgB], () => setResidencyRequired({ partnerId: pB, required: false, acknowledgeImpact: false }));
    const [{ settings }] = await fixtureSql`SELECT settings FROM partners WHERE id = ${pB}`;
    expect(settings).toEqual({ ml: { x: 1 }, ai: { residencyRequired: false } });
  });
});

describe('usage is tenant-bounded by RLS', () => {
  it('partner A sees only its orgs’ authoritative rows', async () => {
    await fixtureSql`SELECT set_config('breeze.scope','system',false)`;
    await fixtureSql`INSERT INTO ai_invocations (org_id, surface, funding_source, requested_model, served_model, ledger_mode, rate_snapshot, cost_cents, offering_id)
      VALUES (${orgA}, 'chat', 'platform', 'm', 'm', 'authoritative', '{}'::jsonb, 5, ${offA}),
             (${orgB}, 'chat', 'platform', 'm', 'm', 'authoritative', '{}'::jsonb, 7, ${offB}),
             (${orgA}, 'chat', 'platform', 'm', 'm', 'shadow', NULL, NULL, ${offA})`;
    const today = new Date().toISOString().slice(0, 10);
    const r = await asPartner(pA, [orgA], () => queryAiUsageBreakdown({ groupBy: 'org', from: today, to: today, orgId: null }));
    expect(r.rows.map((x) => x.key)).toEqual([orgA]);
    expect(r.totals.invocations).toBe(1);
    expect(r.totals.costCents).toBe(5);
  });
});
```

Adapt column names in the raw inserts to the merged table, because the provenance guard trigger may require a matching offering and funding. If the `ai_invocations` provenance trigger rejects the fixture rows, seed through W03's `recordInvocation` helper in a system context instead. The assertion is what matters, not the seeding path. The org-B forge test accepts any of three outcomes: the FK's 422, an RLS denial, or the caller-access 403. The invariant is the zero-row count after.

- [ ] **Step 2: Run against the private test stack**

Run:
```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiModelsRoutes.integration.test.ts
```
Expected: PASS. If the residency test shows `{ ml: {x:1} }` unchanged, the `||` merge was inert. Fix `setResidencyRequired` (Task 7) and re-run.

- [ ] **Step 3: Run the RLS coverage contract (no new tables, but confirm nothing regressed)**

Run: `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`
Expected: PASS, with the same counts as on the W03 branch.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/__tests__/integration/aiModelsRoutes.integration.test.ts
git commit -m "test(ai-models): real-Postgres tenancy, tighten-only and usage-scope suite for /ai/models (#7602)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 11: Partner tab shell, Connections card, connection drawer, residency switch

The old `PartnerAiProviderTab.tsx` (600 lines, one card) is replaced by a hub plus three cards. **The tab key stays `aiProvider` and the hash stays `#ai-provider`**: bookmarks, the W03 docs row and W03's `unavailableMessage` ("Reconnect it under AI Providers & Models") all point there. Only the label changes, to "AI Providers & Models". The legacy camelCase hash `#aiProvider` keeps resolving through `HASH_TO_TAB`. A second hash `#ai-models` is added as an alias (Step 3), so the docs can use the new name.

**Files:**
- Create: `apps/web/src/components/settings/aiModels/PartnerAiModelsTab.tsx` + `.test.tsx`
- Create: `apps/web/src/components/settings/aiModels/ConnectionsCard.tsx`
- Create: `apps/web/src/components/settings/aiModels/ConnectionDrawer.tsx` + `.test.tsx`
- Create: `apps/web/src/components/settings/aiModels/ResidencySwitch.tsx` + `.test.tsx`
- Create: `apps/web/src/components/settings/aiModels/surfaceLabels.ts`
- Delete: `apps/web/src/components/settings/PartnerAiProviderTab.tsx`, `PartnerAiProviderTab.test.tsx`
- Modify: `apps/web/src/components/settings/PartnerSettingsPage.tsx` (import, L37; content mount, L748-755; alias hash)
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (`TARGET_GLOBS`: remove `PartnerAiProviderTab.tsx`, add `aiModels/PartnerAiModelsTab.tsx`, `aiModels/ConnectionDrawer.tsx`, `aiModels/ResidencySwitch.tsx`; bump the count by +2 with a changelog line)
- Modify: `apps/web/src/locales/*/settings.json` (keys under `aiModels.*`; `partnerSettingsPage.tabs.aiProvider.label` → "AI Providers & Models", description → "Connections, models and defaults for every AI feature")

**Interfaces:**
- Consumes: `AiModelsSnapshotDto`, `AiConnectionDto`, `AiResidencyImpactDto` (`@breeze/shared`); `GET /ai/models`; the connection routes; `GET /ai/models/residency/preview`; `PUT /ai/models/residency`.
- Produces:

```ts
// PartnerAiModelsTab.tsx
export default function PartnerAiModelsTab(): JSX.Element;
/** Snapshot loader shared by the cards; refetch after every mutation (server computes eligibility). */
export function useAiModelsSnapshot(): { snapshot: AiModelsSnapshotDto | null; loading: boolean; error: 'forbidden' | 'failed' | null; reload: () => Promise<void> };
// surfaceLabels.ts — literal key maps (i18n keyUsage test cannot check template keys)
export const SURFACE_LABEL_KEYS: Record<AiSurface, string>;
export const ENABLE_BLOCKER_KEYS: Record<OfferingEnableBlocker, string>;
export const REGISTRY_ERROR_KEYS: Record<string, string>;     // RegistryWriteCode → i18n key
export const DEFAULT_SOURCE_KEYS: Record<'org' | 'partner' | 'none', string>;
```

**data-testids:**

| Element | Testid |
|---|---|
| tab root | `ai-models-tab` |
| loading | `ai-models-loading` |
| forbidden | `ai-models-forbidden` |
| load error | `ai-models-load-error` |
| retry | `ai-models-retry` |
| Connections card | `ai-connections-card` |
| connection row | `ai-connection-row-${id ?? 'platform'}` |
| status chip | `ai-connection-status-${id}` |
| row edit button | `ai-connection-edit-${id}` |
| add-connection button | `ai-connection-add` |
| residency switch | `ai-residency-switch` |
| residency confirm dialog | `ai-residency-confirm` |
| residency confirm list | `ai-residency-confirm-surfaces` |
| residency confirm cancel / submit | `ai-residency-confirm-cancel` / `ai-residency-confirm-submit` |
| drawer | `ai-connection-drawer` |
| drawer fields | `ai-connection-name`, `ai-connection-key`, `ai-connection-geo`, `ai-connection-endpoint-direct`, `ai-connection-endpoint-${entryId}`, `ai-connection-datanote-consent` |
| drawer actions | `ai-connection-save`, `ai-connection-cancel`, `ai-connection-refresh`, `ai-connection-disconnect` |
| disconnect confirm | `ai-connection-disconnect-confirm` |

Behaviour (save patterns per spec §11):
- **Connections card.** Rows open the drawer. The platform row (id `null`) is read-only: it shows funding "Breeze credits", its supported geos, and no Edit button.
  - The "Add connection" button appears only when no partner connection exists (compat_uq).
  - The card renders rows with `switch (connection.kind)` and an exhaustive `never` default, so W06/W07 add an arm.
- **Connection drawer — Save.** The drawer holds:
  - name;
  - inference geo: a `<select>` of `connection.supportedInferenceGeos` plus "Provider default" = `null`;
  - "Replace key": a password input, which on Save calls `POST /connections/:id/key` before the PATCH;
  - endpoint: direct vs catalog radios. A catalog entry with a `dataNote` requires the consent checkbox, the same consent rule as the old tab, which moves here.

  **A Save may change the key OR the endpoint, never both** (Codex review finding 1). The existing services probe a new key against the **stored** endpoint (`partnerLlmConfig.ts:227-239, 286-287`), and probe a new endpoint with the **stored** key. Combining the two would send the new credential to the old destination. When both are dirty:
  - Save is disabled;
  - the inline notice `ai-connection-one-credential-change` reads "Save the new key first, then change the endpoint (each is verified separately)".

  Otherwise Save sends, in order:
  1. the key rotate **or** the endpoint change;
  2. `PATCH` (name/geo).

  Each step goes through `runAction`. The drawer stays open on failure. On success: close and reload.

  "Refresh models" (`POST /:id/refresh`, 202) and "Disconnect" (`DELETE`, behind a `ConfirmDialog`, never `window.confirm`) are immediate actions in the drawer footer.
- **Residency switch — autosave + toast** (rule 7: a switch with immediate effect). In the card header:
  - **Turning it on** first GETs `/residency/preview`.
    - With a non-empty `unavailableSurfaces` or `affectedOrgOverrides`, it opens `ai-residency-confirm`, which lists the surfaces by `SURFACE_LABEL_KEYS` and the affected organizations by name + surface (`ai-residency-confirm-orgs`) and warns: "These features will stop working until a model that can keep data in the required region is set as their default." Confirming PUTs `{ required: true, acknowledgeImpact: true }`.
    - With an empty impact, it PUTs `{ required: true }` directly.
  - **Turning it off** PUTs immediately.
  - The switch is optimistic and reverts on failure (the `OrgAiProcessingToggle` pattern).

- [ ] **Step 1: Write the failing tests**

`apps/web/src/components/settings/aiModels/PartnerAiModelsTab.test.tsx` uses the `PartnerAiProviderTab.test.tsx` harness: mocked `fetchWithAuth`, `showToast` and `navigateTo`, and a **real** `runAction`.

```ts
const SNAPSHOT: AiModelsSnapshotDto = {
  partner: { residencyRequired: false, plan: 'pro', hosted: true },
  connections: [
    { id: null, kind: 'platform', name: 'Breeze platform', status: 'platform', lastError: null, keyLast4: null, inferenceGeo: null, effectiveInferenceGeo: null, inferenceGeoSource: 'provider_default',
      supportedInferenceGeos: ['eu', 'us'], catalogEntryId: null, catalogName: null, configVersion: null, verifiedAt: null,
      lastDiscoveredAt: null, discoveryError: null, funding: 'platform' },
    { id: CONN, kind: 'anthropic_byok', name: 'Anthropic', status: 'active', lastError: null, keyLast4: '7890', inferenceGeo: null, effectiveInferenceGeo: null, inferenceGeoSource: 'provider_default',
      supportedInferenceGeos: ['eu'], catalogEntryId: null, catalogName: null, configVersion: 2, verifiedAt: '2026-10-01T00:00:00.000Z',
      lastDiscoveredAt: null, discoveryError: null, funding: 'partner_key' },
  ],
  offerings: [], defaults: [], catalog: [], catalogEnabled: false,
};

it('renders connections from GET /ai/models, platform row first and read-only', async () => {
  fetchWithAuth.mockResolvedValueOnce(jsonRes(SNAPSHOT));
  render(<PartnerAiModelsTab />);
  await screen.findByTestId('ai-connection-row-platform');
  expect(screen.queryByTestId('ai-connection-edit-platform')).toBeNull();
  expect(screen.getByTestId(`ai-connection-edit-${CONN}`)).toBeTruthy();
  expect(screen.queryByTestId('ai-connection-add')).toBeNull(); // one Anthropic connection max (compat_uq)
});

it('shows the forbidden state on 403', async () => {
  fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'x' }, 403));
  render(<PartnerAiModelsTab />);
  await screen.findByTestId('ai-models-forbidden');
});
```

`ResidencySwitch.test.tsx`:

```ts
it('turning on with impact opens a confirm that lists the surfaces, and only PUTs with acknowledgeImpact', async () => {
  fetchWithAuth
    .mockResolvedValueOnce(jsonRes({ unavailableSurfaces: ['chat', 'helper'], affectedOrgOverrides: [] }))   // preview
    .mockResolvedValueOnce(jsonRes({ residencyRequired: true, impact: { unavailableSurfaces: ['chat', 'helper'] } }));
  const onSaved = vi.fn();
  render(<ResidencySwitch required={false} onSaved={onSaved} />);
  fireEvent.click(screen.getByTestId('ai-residency-switch'));
  const dialog = await screen.findByTestId('ai-residency-confirm');
  expect(within(dialog).getByTestId('ai-residency-confirm-surfaces').textContent).toMatch(/Chat/);
  expect(fetchWithAuth).toHaveBeenCalledTimes(1);           // nothing written yet
  fireEvent.click(screen.getByTestId('ai-residency-confirm-submit'));
  await waitFor(() => expect(fetchWithAuth).toHaveBeenLastCalledWith('/ai/models/residency', expect.objectContaining({
    method: 'PUT', body: JSON.stringify({ required: true, acknowledgeImpact: true }),
  })));
  expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  expect(onSaved).toHaveBeenCalled();
});

it('cancelling the confirm leaves the switch off and writes nothing', async () => {
  fetchWithAuth.mockResolvedValueOnce(jsonRes({ unavailableSurfaces: ['chat'], affectedOrgOverrides: [] }));
  render(<ResidencySwitch required={false} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByTestId('ai-residency-switch'));
  fireEvent.click(await screen.findByTestId('ai-residency-confirm-cancel'));
  expect((screen.getByTestId('ai-residency-switch') as HTMLInputElement).checked).toBe(false);
  expect(fetchWithAuth).toHaveBeenCalledTimes(1);
});

it('reverts the switch when the PUT fails', async () => {
  fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'nope' }, 500));
  render(<ResidencySwitch required={true} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByTestId('ai-residency-switch')); // turning off: no preview
  await waitFor(() => expect((screen.getByTestId('ai-residency-switch') as HTMLInputElement).checked).toBe(true));
});
```

`ConnectionDrawer.test.tsx`:

```ts
it('saves name and geo with one PATCH and closes', async () => {
  fetchWithAuth.mockResolvedValueOnce(jsonRes({ id: CONN, configVersion: 3 }));
  const onSaved = vi.fn();
  render(<ConnectionDrawer connection={SNAPSHOT.connections[1]} catalog={[]} catalogEnabled={false} onClose={vi.fn()} onSaved={onSaved} />);
  fireEvent.change(screen.getByTestId('ai-connection-name'), { target: { value: 'Prod' } });
  fireEvent.change(screen.getByTestId('ai-connection-geo'), { target: { value: 'eu' } });
  fireEvent.click(screen.getByTestId('ai-connection-save'));
  await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(`/ai/models/connections/${CONN}`, expect.objectContaining({
    method: 'PATCH', body: JSON.stringify({ name: 'Prod', inferenceGeo: 'eu' }),
  })));
  expect(onSaved).toHaveBeenCalled();
});

it('rotates the key before patching when a new key is entered', async () => {
  fetchWithAuth.mockResolvedValueOnce(jsonRes({ id: CONN })).mockResolvedValueOnce(jsonRes({ id: CONN }));
  render(<ConnectionDrawer connection={SNAPSHOT.connections[1]} catalog={[]} catalogEnabled={false} onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByTestId('ai-connection-key'), { target: { value: 'sk-ant-' + 'x'.repeat(40) } });
  fireEvent.change(screen.getByTestId('ai-connection-name'), { target: { value: 'Prod' } });
  fireEvent.click(screen.getByTestId('ai-connection-save'));
  await waitFor(() => expect(fetchWithAuth.mock.calls.map((c) => c[0])).toEqual([
    `/ai/models/connections/${CONN}/key`, `/ai/models/connections/${CONN}`,
  ]));
});

it('never sends a new key and a new endpoint in one Save (each is probed against the stored other half)', () => {
  const catalog = [{ entryId: 'e1', slug: 's', name: 'Proxy', dataNote: null, models: [] }];
  render(<ConnectionDrawer connection={SNAPSHOT.connections[1]} catalog={catalog} catalogEnabled onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByTestId('ai-connection-key'), { target: { value: 'sk-ant-' + 'x'.repeat(40) } });
  fireEvent.click(screen.getByTestId('ai-connection-endpoint-e1'));
  expect((screen.getByTestId('ai-connection-save') as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByTestId('ai-connection-one-credential-change')).toBeTruthy();
});

it('blocks Save on a catalog endpoint with a data note until consent is checked', async () => {
  const catalog = [{ entryId: 'e1', slug: 's', name: 'Proxy', dataNote: 'May be logged.', models: [] }];
  render(<ConnectionDrawer connection={SNAPSHOT.connections[1]} catalog={catalog} catalogEnabled onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByTestId('ai-connection-endpoint-e1'));
  expect((screen.getByTestId('ai-connection-save') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByTestId('ai-connection-datanote-consent'));
  expect((screen.getByTestId('ai-connection-save') as HTMLButtonElement).disabled).toBe(false);
});

it('keeps the drawer open and shows nothing extra when a save fails (runAction toasted)', async () => {
  fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'This conflicts with an existing setting.', code: 'conflict' }, 409));
  const onClose = vi.fn();
  render(<ConnectionDrawer connection={SNAPSHOT.connections[1]} catalog={[]} catalogEnabled={false} onClose={onClose} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByTestId('ai-connection-name'), { target: { value: 'x' } });
  fireEvent.click(screen.getByTestId('ai-connection-save'));
  await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
  expect(onClose).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && npx vitest run src/components/settings/aiModels`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write the implementation**

`surfaceLabels.ts`:

```ts
import type { AiSurface, OfferingEnableBlocker } from '@breeze/shared';

export const SURFACE_LABEL_KEYS: Record<AiSurface, string> = {
  chat: 'aiModels.surfaces.chat',
  helper: 'aiModels.surfaces.helper',
  script_builder: 'aiModels.surfaces.script_builder',
  script_reviewer: 'aiModels.surfaces.script_reviewer',
  office_chat: 'aiModels.surfaces.office_chat',
  office_ticket: 'aiModels.surfaces.office_ticket',
  ai_agents: 'aiModels.surfaces.ai_agents',
  catalog_enrichment: 'aiModels.surfaces.catalog_enrichment',
  extension_content: 'aiModels.surfaces.extension_content',
  patch_test: 'aiModels.surfaces.patch_test',
};
export const ENABLE_BLOCKER_KEYS: Record<OfferingEnableBlocker, string> = {
  model_unavailable: 'aiModels.blockers.model_unavailable',
  unpriced: 'aiModels.blockers.unpriced',
  plan_required: 'aiModels.blockers.plan_required',
  connection_unavailable: 'aiModels.blockers.connection_unavailable',
};
export const DEFAULT_SOURCE_KEYS = {
  org: 'aiModels.org.source.org',
  partner: 'aiModels.org.source.partner',
  none: 'aiModels.org.source.none',
} as const;
```

The literal map is required because the i18n `keyUsage` test cannot check template keys.

`PartnerAiModelsTab.tsx` (hub):

```tsx
import '@/lib/i18n';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AiModelsSnapshotDto } from '@breeze/shared';
import { fetchWithAuth } from '../../../stores/auth';
import { useStableT } from '@/lib/i18n/useStableT';
import ConnectionsCard from './ConnectionsCard';
import ModelsCard from './ModelsCard';
import FeatureDefaultsCard from './FeatureDefaultsCard';

export function useAiModelsSnapshot() {
  const [snapshot, setSnapshot] = useState<AiModelsSnapshotDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<'forbidden' | 'failed' | null>(null);
  const reload = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/ai/models');
      if (res.status === 403) { setError('forbidden'); return; }
      if (!res.ok) { setError('failed'); return; }
      setSnapshot(await res.json());
      setError(null);
    } catch {
      setError('failed');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  return { snapshot, loading, error, reload };
}

export default function PartnerAiModelsTab() {
  const { t } = useTranslation('settings');
  const { snapshot, loading, error, reload } = useAiModelsSnapshot();
  if (loading) return <div data-testid="ai-models-loading" className="text-sm text-muted-foreground">{t('aiModels.loading')}</div>;
  if (error === 'forbidden') return <div data-testid="ai-models-forbidden" className="text-sm">{t('aiModels.forbidden')}</div>;
  if (error || !snapshot) {
    return (
      <div data-testid="ai-models-load-error" className="space-y-2 text-sm">
        <p>{t('aiModels.loadFailed')}</p>
        <button type="button" data-testid="ai-models-retry" onClick={() => void reload()} className="rounded-md border px-3 py-1.5">
          {t('common:actions.retry')}
        </button>
      </div>
    );
  }
  return (
    <div data-testid="ai-models-tab" className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold">{t('aiModels.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('aiModels.subtitle')}</p>
      </header>
      <ConnectionsCard snapshot={snapshot} onChanged={reload} />
      <ModelsCard snapshot={snapshot} onChanged={reload} />
      <FeatureDefaultsCard snapshot={snapshot} onSaved={reload} />
    </div>
  );
}
```

`ModelsCard` and `FeatureDefaultsCard` are created in Tasks 12 and 13. Until then, create them as stubs returning `null` so this task builds.

`ResidencySwitch.tsx`:

```tsx
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AiResidencyImpactDto, AiSurface } from '@breeze/shared';
import { fetchWithAuth } from '../../../stores/auth';
import { runAction, ActionError } from '../../../lib/runAction';
import { showToast } from '../../shared/Toast';
import { navigateTo } from '@/lib/navigation';
import { Dialog } from '../../shared/Dialog';
import { SURFACE_LABEL_KEYS } from './surfaceLabels';

const onUnauthorized = () => { void navigateTo('/login', { replace: true }); };

export default function ResidencySwitch({ required, onSaved }: { required: boolean; onSaved: () => void | Promise<void> }) {
  const { t } = useTranslation('settings');
  const [checked, setChecked] = useState(required);
  const [busy, setBusy] = useState(false);
  const [impact, setImpact] = useState<AiResidencyImpactDto | null>(null);

  const save = async (next: boolean, acknowledgeImpact: boolean) => {
    setChecked(next);
    setBusy(true);
    try {
      await runAction({
        request: () => fetchWithAuth('/ai/models/residency', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(acknowledgeImpact ? { required: next, acknowledgeImpact: true } : { required: next }),
        }),
        successMessage: next ? t('aiModels.residency.savedOn') : t('aiModels.residency.savedOff'),
        errorFallback: t('aiModels.residency.saveFailed'),
        onUnauthorized,
      });
      await onSaved();
    } catch (err) {
      setChecked(!next);
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('aiModels.residency.saveFailed') });
    } finally {
      setBusy(false);
      setImpact(null);
    }
  };

  const onToggle = async (next: boolean) => {
    if (busy) return;
    if (!next) return save(false, false);
    setBusy(true);
    let preview: AiResidencyImpactDto = { unavailableSurfaces: [], affectedOrgOverrides: [] };
    try {
      const res = await fetchWithAuth('/ai/models/residency/preview');
      if (res.ok) preview = (await res.json()) as AiResidencyImpactDto;
    } finally {
      setBusy(false);
    }
    if (preview.unavailableSurfaces.length > 0 || preview.affectedOrgOverrides.length > 0) setImpact(preview);
    else await save(true, false);
  };

  return (
    <>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" data-testid="ai-residency-switch" checked={checked} disabled={busy}
          onChange={(e) => void onToggle(e.target.checked)} />
        <span>{t('aiModels.residency.label')}</span>
      </label>
      {impact && (
        <Dialog open onClose={() => setImpact(null)} title={t('aiModels.residency.confirmTitle')} maxWidth="md" className="p-6">
          <div data-testid="ai-residency-confirm" className="space-y-3 text-sm">
            <p>{t('aiModels.residency.confirmBody')}</p>
            <ul data-testid="ai-residency-confirm-surfaces" className="list-disc pl-5">
              {impact.unavailableSurfaces.map((s) => <li key={s}>{t(SURFACE_LABEL_KEYS[s])}</li>)}
            </ul>
            {impact.affectedOrgOverrides.length > 0 && (
              <ul data-testid="ai-residency-confirm-orgs" className="list-disc pl-5">
                {impact.affectedOrgOverrides.map((o) => (
                  <li key={`${o.orgId}/${o.surface}`}>{t('aiModels.residency.orgOverride', { org: o.orgName ?? o.orgId, surface: t(SURFACE_LABEL_KEYS[o.surface]) })}</li>
                ))}
              </ul>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" data-testid="ai-residency-confirm-cancel" onClick={() => setImpact(null)} className="rounded-md border px-3 py-1.5">
                {t('common:actions.cancel')}
              </button>
              <button type="button" data-testid="ai-residency-confirm-submit" onClick={() => void save(true, true)} className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground">
                {t('aiModels.residency.confirmSubmit')}
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}
```

`ConnectionsCard.tsx` renders a header containing `<ResidencySwitch required={snapshot.partner.residencyRequired} onSaved={onChanged} />`. It then renders a table of `snapshot.connections`:
- columns: name, kind label, status chip, key `••••${keyLast4}`, inference geo as `effectiveInferenceGeo` with its source ("own setting" / "platform setting" / "provider default"), funding;
- an Edit button for `id !== null`;
- the "Add connection" button when `!snapshot.connections.some((c) => c.id !== null)`. It opens a small create form in the same drawer component, with `connection={null}`, which POSTs `/ai/models/connections` `{ kind: 'anthropic_byok', apiKey, name?, inferenceGeo? }`.

`ConnectionDrawer.tsx` follows `admin/AiModels.tsx`'s drawer pattern (`Drawer` from `../../shared/Drawer`, `closeDisabled={saving}`, footer Cancel/Save). Its Save handler:

```tsx
const handleSave = async () => {
  if (!draft || saving) return;
  setSaving(true);
  try {
    if (connection === null) {
      await runAction({
        request: () => fetchWithAuth('/ai/models/connections', { method: 'POST', headers: JSON_HEADERS,
          body: JSON.stringify({ kind: 'anthropic_byok', apiKey: draft.apiKey.trim(), ...(draft.name ? { name: draft.name } : {}), ...(draft.geo !== null ? { inferenceGeo: draft.geo } : {}) }) }),
        successMessage: t('aiModels.connections.created'), errorFallback: t('aiModels.connections.saveFailed'), onUnauthorized,
      });
    } else {
      const base = `/ai/models/connections/${connection.id}`;
      // Guarded by `bothCredentialsDirty` (Save disabled): never key AND endpoint in one Save.
      if (draft.apiKey.trim()) {
        await runAction({ request: () => fetchWithAuth(`${base}/key`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ apiKey: draft.apiKey.trim() }) }),
          errorFallback: t('aiModels.connections.keyFailed'), onUnauthorized });
      } else if (draft.endpoint !== (connection.catalogEntryId ?? null)) {
        await runAction({ request: () => fetchWithAuth(`${base}/endpoint`, { method: 'POST', headers: JSON_HEADERS,
          body: JSON.stringify({ catalogEntryId: draft.endpoint, acknowledgeDataNote: draft.consent }) }),
          errorFallback: t('aiModels.connections.endpointFailed'), onUnauthorized });
      }
      const patch: Record<string, unknown> = {};
      if (draft.name !== connection.name) patch.name = draft.name;
      if (draft.geo !== connection.inferenceGeo) patch.inferenceGeo = draft.geo;
      if (Object.keys(patch).length > 0) {
        await runAction({ request: () => fetchWithAuth(base, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(patch) }),
          errorFallback: t('aiModels.connections.saveFailed'), onUnauthorized });
      }
      showToast({ type: 'success', message: t('aiModels.connections.saved') });
    }
    await onSaved();
    onClose();
  } catch (err) {
    if (err instanceof ActionError && err.status === 401) return;
    if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('aiModels.connections.saveFailed') });
  } finally {
    setSaving(false);
  }
};
```

The `showToast` success after the sequence is the single success toast for the multi-step Save. The intermediate `runAction` calls pass no `successMessage`, so the user sees one toast per Save. Refresh and Disconnect each use their own `runAction` with a success message. Disconnect sits behind `ConfirmDialog` (`../../shared/ConfirmDialog`), with testid `ai-connection-disconnect-confirm`.

`PartnerSettingsPage.tsx`:
- Replace the `PartnerAiProviderTab` import with `import PartnerAiModelsTab from './aiModels/PartnerAiModelsTab';`.
- In the `activeTab === 'aiProvider'` block, render `<PartnerAiModelsTab />`.
- After the `HASH_TO_TAB` loop, add the alias: `HASH_TO_TAB['ai-models'] = 'aiProvider'; // AI Providers & Models (W04 #7602) — canonical stays #ai-provider`.
- The tab def keeps `selfSaving: true`: the page-level Save button does not apply, because each card owns its save pattern.

- [ ] **Step 4: Run tests and the guards**

Run:
```bash
cd apps/web && npx vitest run src/components/settings/aiModels src/components/settings/PartnerSettingsPage.test.tsx \
  src/lib/__tests__/no-silent-mutations.test.ts
```
Expected: PASS. `no-silent-mutations` lists the three new files and the bumped count.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings/aiModels apps/web/src/components/settings/PartnerSettingsPage.tsx \
  apps/web/src/lib/__tests__/no-silent-mutations.test.ts apps/web/src/locales
git rm apps/web/src/components/settings/PartnerAiProviderTab.tsx apps/web/src/components/settings/PartnerAiProviderTab.test.tsx
git commit -m "feat(web): AI Providers & Models tab — connections, drawer, residency switch (#7602)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Models card and offering drawer

**Files:**
- Create: `apps/web/src/components/settings/aiModels/ModelsCard.tsx` + `.test.tsx`
- Create: `apps/web/src/components/settings/aiModels/OfferingDrawer.tsx` + `.test.tsx`
- Modify: `no-silent-mutations.test.ts` (add both, count +2)
- Modify: `apps/web/src/locales/*/settings.json`

**Interfaces:**
- Consumes: `AiOfferingDto`, `AI_MODEL_REQUIRED_PERMISSION_CHOICES`, `EFFORT_LEVELS`, `THINKING_DISPLAYS`, `MODEL_SPEEDS` (`@breeze/shared`); `POST /ai/models/offerings/platform/:platformModelId`, `POST /offerings/:id/enabled`, `PATCH /offerings/:id`, `POST /offerings/:id/verify`.
- Produces: `ModelsCard({ snapshot, onChanged })` and `OfferingDrawer({ offering, offerings, onClose, onSaved })`.

**data-testids:**

| Element | Testid |
|---|---|
| card | `ai-models-card` |
| row | `ai-offering-row-${rowKey}`, where `rowKey = offering.id ?? 'pm-' + offering.platformModelId` |
| enable switch | `ai-offering-enable-${rowKey}` |
| blocker reason | `ai-offering-blocker-${rowKey}` |
| price cell | `ai-offering-price-${rowKey}` |
| details button | `ai-offering-edit-${rowKey}` |
| disable confirm | `ai-offering-disable-confirm`, `ai-offering-disable-confirm-surfaces`, `ai-offering-disable-confirm-submit` |
| drawer | `ai-offering-drawer` |
| drawer fields | `ai-offering-display-name`, `ai-offering-price-<input|output|cacheRead|cacheWrite>`, `ai-offering-allowed-effort-<level>`, `ai-offering-default-effort`, `ai-offering-default-display`, `ai-offering-default-speed`, `ai-offering-allow-fast`, `ai-offering-premium`, `ai-offering-refusal-fallback` |
| drawer actions | `ai-offering-verify`, `ai-offering-save`, `ai-offering-cancel` |

Behaviour:
- **Rows.** Group by connection, platform first. Each row shows:
  - display name, plus a "capabilities unverified" badge when `thinkingMode === 'unknown'`;
  - context size;
  - the price `$x / $y per 1M tokens` (in/out), via `formatCurrency(cents / 100)`;
  - for platform rows, the fast rate as "Fast: $…";
  - "No price" when `rates === null`;
  - the lifecycle badge for `missing` / `retired`;
  - the "Default for N features" hint (`defaultFor.length`).
- **Enable switch — autosave + toast.**
  - It is disabled with the `ENABLE_BLOCKER_KEYS` reason when `enableBlocker !== null && enableBlocker !== 'connection_unavailable'`. A connection problem shows a non-blocking warning.
  - On a synthesized row (`id === null`), on → `POST /offerings/platform/:platformModelId { enabled: true }`.
  - Otherwise → `POST /offerings/:id/enabled { enabled }`.
  - Turning off a row with `defaultFor.length > 0` first opens `ai-offering-disable-confirm`. It lists the surfaces (and "N organizations") from `defaultFor` and warns that those features will have no model. Only Confirm sends `{ enabled: false, force: true }`.
  - A 409 `offering_in_use` from a race (the snapshot was stale) opens the same confirm from `ActionError.body.details.inUse`.
  - **Spec §15 #1 "rate shown at enable time".** The success toast includes the rate: "Enabled {{name}} at {{in}} / {{out}} per 1M tokens".
- **Drawer — Save.** It sends `PATCH /offerings/:id` with `expectedUpdatedAt = offering.updatedAt` and only the changed fields:
  - display name;
  - prices (four inputs, shown only when `pricesEditable`; otherwise the price source and rate are read-only: "Price from the Breeze platform" / "from the catalog" / "from the linked platform model");
  - allowed efforts (checkboxes over `optionSupport.effort`);
  - default effort / thinking display / speed (selects limited to `allowed ∩ support`; "Fast" listed only when `fastRates !== null`, labelled with its rate);
  - "Allow Fast mode" (`ai-offering-allow-fast`, shown only when `fastRates !== null`). New fast-capable platform offerings start with Fast disallowed (`allowedOptions.speed = ["standard"]`, Task 4). On a platform-funded offering, ticking it also ticks and locks "Require the premium-model permission", because the API rejects Fast without it (spec §15 #7);
  - "Require the premium-model permission" (a checkbox mapping to `requiredPermission: 'ai_models:premium' | null`, with help text naming the role permission);
  - refusal fallback (a select over **enabled offerings on the same `connectionId`**, excluding itself, plus "None").

  A 409 `stale_write` toasts (via `runAction`), then reloads and closes. The drawer is disabled for synthesized rows (`id === null`): the user enables first, then edits.
- **Verify.** It shows only for connection offerings and calls `POST /offerings/:id/verify` (202), with the toast "Model check queued".

- [ ] **Step 1: Write the failing tests**

`ModelsCard.test.tsx`:

```ts
it('adds and enables a not-yet-added platform model in one call, toasting the rate', async () => {
  fetchWithAuth.mockResolvedValueOnce(jsonRes({ id: OFF, enabled: true, updatedAt: '2026-10-01T00:00:00.000Z' }));
  const onChanged = vi.fn();
  render(<ModelsCard snapshot={snap([synthRow({ platformModelId: PM, rates: RATES })])} onChanged={onChanged} />);
  fireEvent.click(screen.getByTestId(`ai-offering-enable-pm-${PM}`));
  await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(`/ai/models/offerings/platform/${PM}`, expect.objectContaining({
    method: 'POST', body: JSON.stringify({ enabled: true }),
  })));
  expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: expect.stringMatching(/\$3\.00/) }));
  expect(onChanged).toHaveBeenCalled();
});

it('disables the switch with the reason when the enable gate blocks it', () => {
  render(<ModelsCard snapshot={snap([row({ id: OFF, enableBlocker: 'plan_required' })])} onChanged={vi.fn()} />);
  expect((screen.getByTestId(`ai-offering-enable-${OFF}`) as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByTestId(`ai-offering-blocker-${OFF}`).textContent).toMatch(/plan/i);
});

it('disable confirm lists affected surfaces and only then sends force', async () => {
  render(<ModelsCard snapshot={snap([row({ id: OFF, enabled: true, defaultFor: [{ surface: 'chat', level: 'partner', orgId: null }] })])} onChanged={vi.fn()} />);
  fireEvent.click(screen.getByTestId(`ai-offering-enable-${OFF}`));
  const dialog = await screen.findByTestId('ai-offering-disable-confirm');
  expect(within(dialog).getByTestId('ai-offering-disable-confirm-surfaces').textContent).toMatch(/Chat/);
  expect(fetchWithAuth).not.toHaveBeenCalled();
  fetchWithAuth.mockResolvedValueOnce(jsonRes({ id: OFF, enabled: false, inUse: [] }));
  fireEvent.click(screen.getByTestId('ai-offering-disable-confirm-submit'));
  await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(`/ai/models/offerings/${OFF}/enabled`, expect.objectContaining({
    body: JSON.stringify({ enabled: false, force: true }),
  })));
});

it('a stale in-use race (409 offering_in_use) opens the same confirm', async () => {
  fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'in use', code: 'offering_in_use', details: { inUse: [{ surface: 'helper', level: 'org', orgId: 'o1' }] } }, 409));
  render(<ModelsCard snapshot={snap([row({ id: OFF, enabled: true, defaultFor: [] })])} onChanged={vi.fn()} />);
  fireEvent.click(screen.getByTestId(`ai-offering-enable-${OFF}`));
  await screen.findByTestId('ai-offering-disable-confirm');
});
```

`OfferingDrawer.test.tsx`:

```ts
it('sends only changed fields with expectedUpdatedAt', async () => {
  fetchWithAuth.mockResolvedValueOnce(jsonRes({ id: OFF, updatedAt: '2026-10-02T00:00:00.000Z' }));
  render(<OfferingDrawer offering={row({ id: OFF, updatedAt: '2026-10-01T00:00:00.000Z' })} offerings={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByTestId('ai-offering-premium'));
  fireEvent.click(screen.getByTestId('ai-offering-save'));
  await waitFor(() => expect(JSON.parse(fetchWithAuth.mock.calls[0][1].body)).toEqual({
    expectedUpdatedAt: '2026-10-01T00:00:00.000Z', requiredPermission: 'ai_models:premium',
  }));
});

it('hides price inputs on a platform offering and shows the source', () => {
  render(<OfferingDrawer offering={row({ id: OFF, pricesEditable: false, priceSource: 'platform' })} offerings={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
  expect(screen.queryByTestId('ai-offering-price-input')).toBeNull();
  expect(screen.getByTestId('ai-offering-drawer').textContent).toMatch(/Breeze platform/);
});

it('offers only same-connection enabled offerings as the refusal fallback', () => {
  const others = [row({ id: 'o2', connectionId: null, enabled: true, displayName: 'Same' }), row({ id: 'o3', connectionId: CONN, enabled: true, displayName: 'Other conn' }), row({ id: 'o4', connectionId: null, enabled: false, displayName: 'Off' })];
  render(<OfferingDrawer offering={row({ id: OFF, connectionId: null })} offerings={others} onClose={vi.fn()} onSaved={vi.fn()} />);
  const opts = [...(screen.getByTestId('ai-offering-refusal-fallback') as HTMLSelectElement).options].map((o) => o.textContent);
  expect(opts).toEqual(['None', 'Same']);
});

it('a rename keeps stored option restrictions (no allowedOptions in the patch)', async () => {
  fetchWithAuth.mockResolvedValueOnce(jsonRes({ id: OFF, updatedAt: '2026-10-02T00:00:00.000Z' }));
  render(<OfferingDrawer offering={row({ id: OFF, updatedAt: '2026-10-01T00:00:00.000Z', fastRates: RATES,
    optionSupport: { effort: ['low'], thinkingDisplay: ['summarized'], speed: ['standard', 'fast'], inferenceGeo: [] },
    allowedOptions: { speed: ['standard'], thinkingDisplay: ['summarized'] } })} offerings={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByTestId('ai-offering-display-name'), { target: { value: 'Renamed' } });
  fireEvent.click(screen.getByTestId('ai-offering-save'));
  await waitFor(() => expect(JSON.parse(fetchWithAuth.mock.calls[0][1].body)).not.toHaveProperty('allowedOptions'));
});

it('allowing Fast on a platform offering also requires the premium permission', () => {
  render(<OfferingDrawer offering={row({ id: OFF, funding: 'platform', fastRates: RATES,
    optionSupport: { effort: [], thinkingDisplay: [], speed: ['standard', 'fast'], inferenceGeo: [] }, allowedOptions: { speed: ['standard'] } })} offerings={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByTestId('ai-offering-allow-fast'));
  const premium = screen.getByTestId('ai-offering-premium') as HTMLInputElement;
  expect([premium.checked, premium.disabled]).toEqual([true, true]);
});

it('lists Fast only when the model has a fast rate', () => {
  render(<OfferingDrawer offering={row({ id: OFF, fastRates: null, optionSupport: { effort: [], thinkingDisplay: [], speed: ['standard', 'fast'], inferenceGeo: [] } })} offerings={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
  expect([...(screen.getByTestId('ai-offering-default-speed') as HTMLSelectElement).options].map((o) => o.value)).not.toContain('fast');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && npx vitest run src/components/settings/aiModels/ModelsCard.test.tsx src/components/settings/aiModels/OfferingDrawer.test.tsx`
Expected: FAIL. The stub `ModelsCard` returns null, and `OfferingDrawer` does not exist.

- [ ] **Step 3: Write the implementation**

The enable handler in `ModelsCard.tsx`:

```tsx
const rowKey = (o: AiOfferingDto) => o.id ?? `pm-${o.platformModelId}`;
const rateLabel = (o: AiOfferingDto) => o.rates
  ? t('aiModels.models.rate', { input: formatCurrency(o.rates.inputCentsPerM / 100), output: formatCurrency(o.rates.outputCentsPerM / 100) })
  : t('aiModels.models.noPrice');

const sendEnable = async (o: AiOfferingDto, enabled: boolean, force: boolean) => {
  setBusyKey(rowKey(o));
  try {
    await runAction({
      request: () => o.id === null
        ? fetchWithAuth(`/ai/models/offerings/platform/${o.platformModelId}`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ enabled: true }) })
        : fetchWithAuth(`/ai/models/offerings/${o.id}/enabled`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(force ? { enabled, force: true } : { enabled }) }),
      successMessage: enabled
        ? t('aiModels.models.enabledAt', { name: o.displayName, rate: rateLabel(o) })
        : t('aiModels.models.disabled', { name: o.displayName }),
      errorFallback: t('aiModels.models.toggleFailed'),
      onUnauthorized,
    });
    setConfirm(null);
    await onChanged();
  } catch (err) {
    if (err instanceof ActionError && err.status === 401) return;
    if (err instanceof ActionError && err.code === 'offering_in_use') {
      const inUse = (err.body as { details?: { inUse?: AiOfferingDto['defaultFor'] } })?.details?.inUse ?? [];
      setConfirm({ offering: o, inUse });
      return;
    }
    if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('aiModels.models.toggleFailed') });
  } finally {
    setBusyKey(null);
  }
};

const onToggle = (o: AiOfferingDto, next: boolean) => {
  if (!next && o.defaultFor.length > 0) { setConfirm({ offering: o, inUse: o.defaultFor }); return; }
  void sendEnable(o, next, false);
};
```

A 409 shows `runAction`'s own error toast before the confirm opens. Pass `friendly: (code) => (code === 'offering_in_use' ? t('aiModels.models.inUseFriendly') : undefined)` so the toast reads "This model is still a default — confirm to disable it", not the raw API sentence. Confirm that `runAction`'s `friendly` option fires for a 409 with a `code`; it does per `runAction.ts`'s `RunActionOptions`.

The `OfferingDrawer.tsx` draft and Save follow the `AiModels.tsx` pattern (`editing`, `draft`, `saving`; `closeDisabled={saving}`). The patch builder:

```tsx
function buildPatch(o: AiOfferingDto, d: Draft): Record<string, unknown> {
  const patch: Record<string, unknown> = { expectedUpdatedAt: o.updatedAt };
  const name = d.displayName.trim() || null;
  if (name !== o.displayNameOverride) patch.displayName = name;
  if (o.pricesEditable) {
    const prices = draftToRates(d.prices);            // all four or null; 'invalid' blocks Save
    if (JSON.stringify(prices) !== JSON.stringify(o.ownPrices)) patch.prices = prices;
  }
  // Merge into the stored allow-list: the drawer edits effort and speed (Fast opt-in);
  // thinkingDisplay and any key the drawer does not show are preserved
  // (Codex review finding 7: a rename must never drop speed: ['standard']).
  const allowed = compact({
    ...(o.allowedOptions ?? {}),
    effort: d.allowedEffort.length ? d.allowedEffort : undefined,
    speed: d.allowFast ? undefined /* = all supported */ : (o.optionSupport.speed.includes('fast') ? ['standard'] : (o.allowedOptions?.speed ?? undefined)),
  });
  if (JSON.stringify(allowed) !== JSON.stringify(o.allowedOptions ?? null)) patch.allowedOptions = allowed;
  const defaults = compact({ effort: d.defaultEffort || undefined, thinkingDisplay: d.defaultDisplay || undefined, speed: d.defaultSpeed || undefined });
  if (JSON.stringify(defaults) !== JSON.stringify(o.defaultOptions ?? null)) patch.defaultOptions = defaults;
  const perm = d.premium ? 'ai_models:premium' : null;
  if (perm !== o.requiredPermission) patch.requiredPermission = perm;
  const fb = d.refusalFallback || null;
  if (fb !== o.refusalFallbackOfferingId) patch.refusalFallbackOfferingId = fb;
  return patch;
}
```

Here `compact` returns `null` for an all-undefined object. `draftToRates` is a local copy of `admin/AiModels.tsx`'s helper of the same name. Copy it rather than export it from an admin component, per the CLAUDE.md "helpers … can be duplicated locally" rule. Refusal-fallback options: `offerings.filter((x) => x.id && x.id !== o.id && x.enabled && x.connectionId === o.connectionId)`.

- [ ] **Step 4: Run tests and the guard**

Run: `cd apps/web && npx vitest run src/components/settings/aiModels src/lib/__tests__/no-silent-mutations.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings/aiModels apps/web/src/lib/__tests__/no-silent-mutations.test.ts apps/web/src/locales
git commit -m "feat(web): AI models card — gated enable with rate toast, in-use confirm, offering drawer (#7602)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Defaults by feature (page Save)

**Files:**
- Create: `apps/web/src/components/settings/aiModels/FeatureDefaultsCard.tsx` + `.test.tsx`
- Modify: `no-silent-mutations.test.ts` (add, count +1)
- Modify: locales

**Interfaces:**
- Consumes: `AiSurfaceDefaultsDto`, `AiOfferingDto`, `PartnerAssignmentInput` (`@breeze/shared`); `PUT /ai/models/assignments`.
- Produces: `FeatureDefaultsCard({ snapshot, onSaved })`.

**data-testids:**

| Element | Testid |
|---|---|
| card | `ai-defaults-card` |
| row | `ai-defaults-row-${surface}` |
| fields | `ai-defaults-default-${surface}` (select), `ai-defaults-permitted-mode-${surface}` (select: "All enabled models" / "Only these"), `ai-defaults-permitted-${surface}-${offeringId}` (checkbox), `ai-defaults-user-choice-${surface}`, `ai-defaults-effort-${surface}`, `ai-defaults-display-${surface}`, `ai-defaults-speed-${surface}` |
| org override link | `ai-defaults-org-overrides-${surface}` (shown when `orgOverrideCount > 0`) |
| footer | `ai-defaults-save`, `ai-defaults-discard`, `ai-defaults-dirty` |

Behaviour (rule 7, forms use page Save):
- **One row per configurable surface, in `CONFIGURABLE_AI_SURFACES` order.** Rows are keyed `${surface}/${role}`, which leaves room for W09's role sub-rows. Each row has:
  - the surface label;
  - "needs tools" when `requiresTools`;
  - a Default select over enabled offerings, filtered to `supportsTools` when `requiresTools`, and to the permitted set when "Only these" is chosen;
  - the permitted set: an "All enabled models" / "Only these" mode select, plus checkboxes over the eligible enabled offerings;
  - an "Users may choose" checkbox;
  - Effort, Thinking display and Speed selects, each limited to the chosen default's `optionSupport` ∩ `allowedOptions` ("Fast" only when the default has a fast rate and allows it), each with "Model default" = unset (spec §11: assignments carry options; Codex review finding 14).
- **The footer shows "Unsaved changes" plus Save and Discard** while any row differs from the snapshot.
  - Save PUTs only the dirty rows, with `expectedUpdatedAt = row.partner?.updatedAt ?? null`, through `runAction`.
  - A 422 response's `details.surface` highlights that row (`aria-invalid` + red border). A 409 `stale_write` reloads.
- **`script_reviewer` gate.** That row's help text says "Changing this needs the approvals permission". A 403 `APPROVALS_DECIDE_REQUIRED` is translated through `friendly`.
- **No fallback controls.** A comment in the row component reads: `// W09 (#7607): role sub-rows (triage/analysis/remediation) and the ordered fallback list render here.`

- [ ] **Step 1: Write the failing tests**

```ts
it('PUTs only dirty rows with expectedUpdatedAt', async () => {
  fetchWithAuth.mockResolvedValueOnce(jsonRes({ assignments: [{ surface: 'chat', role: 'default', updatedAt: 'x' }] }));
  render(<FeatureDefaultsCard snapshot={snapWithDefaults()} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByTestId('ai-defaults-default-chat'), { target: { value: B } });
  expect(screen.getByTestId('ai-defaults-dirty')).toBeTruthy();
  fireEvent.click(screen.getByTestId('ai-defaults-save'));
  await waitFor(() => expect(JSON.parse(fetchWithAuth.mock.calls[0][1].body)).toEqual({ assignments: [{
    surface: 'chat', role: 'default', defaultOfferingId: B, permittedOfferingIds: null, allowUserChoice: true, options: null,
    expectedUpdatedAt: '2026-10-01T00:00:00.000Z',
  }] }));
});

it('a tool surface lists only tool-capable models', () => {
  render(<FeatureDefaultsCard snapshot={snapWithDefaults({ offerings: [off(A, { supportsTools: true }), off(C, { supportsTools: false })] })} onSaved={vi.fn()} />);
  const values = [...(screen.getByTestId('ai-defaults-default-chat') as HTMLSelectElement).options].map((o) => o.value);
  expect(values).toContain(A);
  expect(values).not.toContain(C);
});

it('narrowing the permitted set drops a default outside it from the select', () => {
  render(<FeatureDefaultsCard snapshot={snapWithDefaults()} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByTestId('ai-defaults-permitted-mode-chat'), { target: { value: 'list' } });
  fireEvent.click(screen.getByTestId(`ai-defaults-permitted-chat-${B}`));
  const values = [...(screen.getByTestId('ai-defaults-default-chat') as HTMLSelectElement).options].map((o) => o.value);
  expect(values).toEqual([B]);
});

it('Discard restores the snapshot and hides the footer', () => {
  render(<FeatureDefaultsCard snapshot={snapWithDefaults()} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByTestId('ai-defaults-user-choice-chat'));
  fireEvent.click(screen.getByTestId('ai-defaults-discard'));
  expect(screen.queryByTestId('ai-defaults-dirty')).toBeNull();
});

it('marks the failing row from a 422 details.surface', async () => {
  fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'needs tools', code: 'tools_unsupported', details: { surface: 'chat', field: 'defaultOfferingId' } }, 422));
  render(<FeatureDefaultsCard snapshot={snapWithDefaults()} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByTestId('ai-defaults-user-choice-chat'));
  fireEvent.click(screen.getByTestId('ai-defaults-save'));
  await waitFor(() => expect(screen.getByTestId('ai-defaults-row-chat').getAttribute('aria-invalid')).toBe('true'));
});

it('a snapshot reload (another card autosaved) keeps dirty rows and refreshes clean ones', () => {
  const { rerender } = render(<FeatureDefaultsCard snapshot={snapWithDefaults()} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByTestId('ai-defaults-default-chat'), { target: { value: B } });
  rerender(<FeatureDefaultsCard snapshot={snapWithDefaults({ helperDefault: A2 })} onSaved={vi.fn()} />);
  expect((screen.getByTestId('ai-defaults-default-chat') as HTMLSelectElement).value).toBe(B);       // kept
  expect((screen.getByTestId('ai-defaults-default-helper') as HTMLSelectElement).value).toBe(A2);    // refreshed
});

it('edits thinking display and speed per surface, limited to the default model', () => {
  render(<FeatureDefaultsCard snapshot={snapWithDefaults()} onSaved={vi.fn()} />);
  expect(screen.getByTestId('ai-defaults-display-chat')).toBeTruthy();
  const speeds = [...(screen.getByTestId('ai-defaults-speed-chat') as HTMLSelectElement).options].map((o) => o.value);
  expect(speeds).not.toContain('fast');   // default A has no fast rate in the fixture
});

it('renders no fallback controls (W09)', () => {
  render(<FeatureDefaultsCard snapshot={snapWithDefaults()} onSaved={vi.fn()} />);
  expect(screen.queryByText(/fallback/i)).toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && npx vitest run src/components/settings/aiModels/FeatureDefaultsCard.test.tsx`
Expected: FAIL (stub).

- [ ] **Step 3: Write the implementation**

State: `drafts: Record<string, RowDraft>`, keyed by `${surface}/default`, initialised from `snapshot.defaults`. When `snapshot` changes (any card's autosave reloads it), **only non-dirty rows are re-initialised**: a dirty row keeps its draft, and is marked "changed elsewhere" (`ai-defaults-conflict-${surface}`) when its snapshot `updatedAt` moved (Codex review finding 13). Then `dirtyKeys = keys.filter((k) => !rowEquals(drafts[k], fromSnapshot(k)))`. Save:

```tsx
const handleSave = async () => {
  const rows = dirtyKeys.map((k) => toInput(drafts[k], snapshotRow(k)));
  if (rows.some((r) => !r.defaultOfferingId)) { showToast({ type: 'error', message: t('aiModels.defaults.needsDefault') }); return; }
  setSaving(true);
  setInvalidSurface(null);
  try {
    await runAction({
      request: () => fetchWithAuth('/ai/models/assignments', { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ assignments: rows }) }),
      successMessage: t('aiModels.defaults.saved'),
      errorFallback: t('aiModels.defaults.saveFailed'),
      friendly: (code) => (code ? REGISTRY_ERROR_KEYS[code] && t(REGISTRY_ERROR_KEYS[code]) : undefined) || undefined,
      onUnauthorized,
    });
    await onSaved();
  } catch (err) {
    if (err instanceof ActionError && err.status === 401) return;
    if (err instanceof ActionError) {
      const surface = (err.body as { details?: { surface?: string } })?.details?.surface;
      if (surface) setInvalidSurface(surface);
      if (err.code === 'stale_write') await onSaved();
      return;
    }
    showToast({ type: 'error', message: t('aiModels.defaults.saveFailed') });
  } finally {
    setSaving(false);
  }
};
```

`toInput(draft, snapshotRow)` returns:

```ts
{
  surface,
  role: 'default',
  defaultOfferingId,
  permittedOfferingIds: draft.mode === 'all' ? null : draft.permitted,
  allowUserChoice,
  options: compact({ effort: draft.effort || undefined, thinkingDisplay: draft.display || undefined, speed: draft.speed || undefined }),
  expectedUpdatedAt: snapshotRow.partner?.updatedAt ?? null,
}
```

All three option keys are edited on the row. An all-unset row sends `options: null` (follow each model's own default).

Add `REGISTRY_ERROR_KEYS` to `surfaceLabels.ts` with one key per code: `not_eligible`, `tools_unsupported`, `widens_partner`, `stale_write`, `offering_in_use`, `unpriced`, `conflict`, `invalid`, `registry_unavailable`, `APPROVALS_DECIDE_REQUIRED`.

- [ ] **Step 4: Run tests**

Run: `cd apps/web && npx vitest run src/components/settings/aiModels src/lib/__tests__/no-silent-mutations.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings/aiModels apps/web/src/lib/__tests__/no-silent-mutations.test.ts apps/web/src/locales
git commit -m "feat(web): Defaults by feature — per-surface default, permitted set, user choice, effort; page Save (#7602)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Org Settings → AI → "Model defaults" override card

**Files:**
- Create: `apps/web/src/components/settings/aiModels/OrgModelDefaultsCard.tsx` + `.test.tsx`
- Modify: `apps/web/src/components/settings/OrgSettingsPage.tsx` (`case 'ai'`, L676-702: render `<OrgModelDefaultsCard orgId={effectiveOrgId} />` first, before `OrgAiBudgetSettings`)
- Modify: `no-silent-mutations.test.ts` (add, count +1)
- Modify: locales

**Interfaces:**
- Consumes: `AiOrgModelDefaultsDto`, `OrgAssignmentInput`; `GET/PUT /ai/models/orgs/:orgId/assignments`.
- Produces: `OrgModelDefaultsCard({ orgId })`.

**data-testids:**

| Element | Testid |
|---|---|
| card | `org-model-defaults-card` |
| row | `org-model-defaults-row-${surface}` |
| fields | `org-model-defaults-default-${surface}` (select whose first option is "Inherit — {{model}} (partner default)"), `org-model-defaults-permitted-mode-${surface}` ("Inherit" / "Only these"), `org-model-defaults-permitted-${surface}-${offeringId}`, `org-model-defaults-lock-choice-${surface}` (checkbox "Don't let users choose"), `org-model-defaults-effort-${surface}` (first option "Inherit — {{effort}}"), `org-model-defaults-display-${surface}` ("Inherit — {{display}}"), `org-model-defaults-speed-${surface}` ("Inherit — {{speed}}") |
| inherited value | `org-model-defaults-inherited-${surface}` (text) |
| partner link | `org-model-defaults-partner-link` → `/settings/partner#ai-provider` |
| footer | `org-model-defaults-save`, `org-model-defaults-discard` |
| read-only notice | `org-model-defaults-readonly` |

Behaviour (spec §11 and rules 3 and 4):
- **Blank means inherit, and the inherited value is always visible.** Every control's first option is "Inherit", and its label carries the inherited value and its source: "Inherit — Sonnet 5.5 (partner default)". The effective value is shown under each row as `effective` + `DEFAULT_SOURCE_KEYS[defaultSource]`.
- **Tighten-only in the UI as well as the API.**
  - The permitted checkboxes list only offerings in `inherited.permittedOfferingIds` (or every offering when that is null), filtered by tools.
  - The default select lists only offerings in the effective permitted set.
  - The effort select lists only levels ≤ the inherited effort, using `EFFORT_LEVELS` order. The speed select offers "Fast" only when the inherited options already allow fast (`clampOrgOptions` rejects anything else). The thinking-display select lists the effective default's supported values: the merge takes org ?? partner, so any supported value is a narrowing, not a widening.
  - "Users may choose" can only be **locked** (checkbox → `false`). When the partner already locks it, the box is disabled and shows "Locked by the partner".
- **Page Save.** The card has its own footer. Org AI cards already self-save, and `case 'ai'` has no page-level Save (`OrgSettingsPage.tsx:676` comment "the tab owns its own draft AND its own save").
  - Save PUTs the dirty rows. A row reset to all-inherit sends all four fields `null`, which the API turns into a delete.
  - `canEdit === false` renders every control disabled, plus the `org-model-defaults-readonly` notice "You can view these defaults. Changing them needs the organization-write permission."
  - `canEditReviewer === false` disables only the `script_reviewer` row.
- The card renders nothing when `GET` returns 403. The tab may be viewable without `organizations:read` in some custom roles.

- [ ] **Step 1: Write the failing tests**

```ts
it('shows the inherited value and its source on every row', async () => {
  fetchWithAuth.mockResolvedValueOnce(jsonRes(orgDefaults()));
  render(<OrgModelDefaultsCard orgId={ORG} />);
  expect((await screen.findByTestId('org-model-defaults-inherited-chat')).textContent).toMatch(/Model A.*partner default/);
});

it('offers only partner-permitted models and only lower efforts (tighten-only)', async () => {
  fetchWithAuth.mockResolvedValueOnce(jsonRes(orgDefaults({ chat: { inherited: { permittedOfferingIds: [A, B], options: { effort: 'medium' } } } })));
  render(<OrgModelDefaultsCard orgId={ORG} />);
  await screen.findByTestId('org-model-defaults-row-chat');
  fireEvent.change(screen.getByTestId('org-model-defaults-permitted-mode-chat'), { target: { value: 'list' } });
  expect(screen.queryByTestId(`org-model-defaults-permitted-chat-${C}`)).toBeNull();
  const efforts = [...(screen.getByTestId('org-model-defaults-effort-chat') as HTMLSelectElement).options].map((o) => o.value);
  expect(efforts).toEqual(['', 'low', 'medium']);
});

it('resetting a row to inherit sends an all-null row', async () => {
  fetchWithAuth
    .mockResolvedValueOnce(jsonRes(orgDefaults({ chat: { org: { defaultOfferingId: B, permittedOfferingIds: null, allowUserChoice: null, options: null, updatedAt: T } } })))
    .mockResolvedValueOnce(jsonRes({ assignments: [] }))
    .mockResolvedValueOnce(jsonRes(orgDefaults()));
  render(<OrgModelDefaultsCard orgId={ORG} />);
  fireEvent.change(await screen.findByTestId('org-model-defaults-default-chat'), { target: { value: '' } });
  fireEvent.click(screen.getByTestId('org-model-defaults-save'));
  await waitFor(() => expect(JSON.parse(fetchWithAuth.mock.calls[1][1].body)).toEqual({ assignments: [{
    surface: 'chat', role: 'default', defaultOfferingId: null, permittedOfferingIds: null, allowUserChoice: null, options: null, expectedUpdatedAt: T,
  }] }));
});

it('is read-only without canEdit, and the reviewer row without canEditReviewer', async () => {
  fetchWithAuth.mockResolvedValueOnce(jsonRes(orgDefaults({ canEdit: true, canEditReviewer: false })));
  render(<OrgModelDefaultsCard orgId={ORG} />);
  expect((await screen.findByTestId('org-model-defaults-default-script_reviewer') as HTMLSelectElement).disabled).toBe(true);
  expect((screen.getByTestId('org-model-defaults-default-chat') as HTMLSelectElement).disabled).toBe(false);
});

it('the lock is disabled when the partner already locks user choice', async () => {
  fetchWithAuth.mockResolvedValueOnce(jsonRes(orgDefaults({ chat: { inherited: { allowUserChoice: false } } })));
  render(<OrgModelDefaultsCard orgId={ORG} />);
  expect((await screen.findByTestId('org-model-defaults-lock-choice-chat') as HTMLInputElement).disabled).toBe(true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && npx vitest run src/components/settings/aiModels/OrgModelDefaultsCard.test.tsx`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

`OrgModelDefaultsCard.tsx` follows `FeatureDefaultsCard`'s draft and footer structure. The differences:
- the GET URL is `/ai/models/orgs/${orgId}/assignments`, reloaded when `orgId` changes;
- every field is nullable, and `''` in a select maps to `null`;
- the choices are derived from `inherited` / `effective` as described above;
- the PUT goes to the same URL.

Effort ordering helper:

```ts
const EFFORT_RANK = Object.fromEntries(EFFORT_LEVELS.map((e, i) => [e, i])) as Record<EffortLevel, number>;
const effortChoices = (inheritedEffort: EffortLevel | undefined, supported: EffortLevel[]) =>
  supported.filter((e) => inheritedEffort === undefined || EFFORT_RANK[e] <= EFFORT_RANK[inheritedEffort]);
```

In `OrgSettingsPage.tsx`, inside `case 'ai':`, insert `<OrgModelDefaultsCard orgId={effectiveOrgId} />` as the first child of the fragment. Add a one-line comment: `{/* AI model registry W04 (#7602): org override of the partner's per-feature model defaults (tighten-only). */}`.

- [ ] **Step 4: Run tests**

Run: `cd apps/web && npx vitest run src/components/settings/aiModels src/components/settings/OrgSettingsPage.test.tsx src/lib/__tests__/no-silent-mutations.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings/aiModels apps/web/src/components/settings/OrgSettingsPage.tsx \
  apps/web/src/lib/__tests__/no-silent-mutations.test.ts apps/web/src/locales
git commit -m "feat(web): org Model defaults card — tighten-only override, blank = inherit with source (#7602)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: AI-usage breakdown card; retire the legacy model editors

**Files:**
- Create: `apps/web/src/components/settings/aiModels/AiUsageBreakdown.tsx` + `.test.tsx`
- Create: `apps/web/src/components/settings/aiModels/ModelDefaultsLink.tsx`
- Modify: `apps/web/src/components/settings/AiUsagePage.tsx` (+ test): mount `<AiUsageBreakdown orgId={currentOrgId ?? null} />` between the stat cards and "Recent sessions"
- Modify: `apps/web/src/components/clientAi/PolicyEditor.tsx` (+ test): delete `KNOWN_MODELS` (L60-64), the `allowedModels` state/toggle (L134, L169) and the checkbox list (L428-451); render `<ModelDefaultsLink surface="office_chat" orgId={orgId} />`; drop `allowedModels` from `buildPayload()`
- Modify: `apps/api/src/routes/clientAi/schemas.ts` (`putPolicySchema`, L85-91): remove `allowedModels`; **keep** it in the GET response (W08 drops the column)
- Modify: `apps/api/src/routes/clientAi/admin.ts` (~L220): delete `if (body.allowedModels !== undefined) set.allowedModels = body.allowedModels;`, plus its tests
- Modify: `apps/web/src/components/settings/ScriptAuthoringPage.tsx` (+ test): replace both reviewer free-text inputs (org L630-640, partner L769-776) with `<ModelDefaultsLink surface="script_reviewer" … />`; drop `reviewerModel` from both draft types and both PUT bodies (L302, L339)
- Modify: `apps/api/src/routes/ai/scriptPolicy.ts` (zod ~L59) and `apps/api/src/routes/partnerAiScriptPolicy.ts` (zod L55, widening L94/L118/L129): remove `reviewerModel` from both PUT schemas. Remove the `reviewerModelChanged` term from the widening check; changing the reviewer's model is now gated on `/ai/models` by `approvals:decide`. Keep `reviewerModel` in the GET response for one wave (W03 keeps merging it). Update the step-up grant binding (`routes/auth/schemas.ts:240`) only if its `reviewerModel` field becomes unreachable. It stays `z.string().nullable()` and always receives `null`.
- Modify: W03's AST contract test: delete the `'apps/web/src/components/clientAi/PolicyEditor.tsx'` allowlist entry (Q11)
- Modify: `no-silent-mutations.test.ts`: `AiUsageBreakdown.tsx` is read-only, so do **not** add it. `ModelDefaultsLink.tsx` is read-only too.

**Interfaces:**
- Consumes: `AiUsageBreakdownDto`, `AI_USAGE_GROUP_BYS`; `GET /ai/models/usage`; `GET /ai/models/orgs/:orgId/assignments` (for the link's current-value text).
- Produces:

```tsx
export default function AiUsageBreakdown(props: { orgId: string | null }): JSX.Element;
/** "Model: <effective> — set under AI Providers & Models → Defaults by feature" (+ org override link when orgId). */
export default function ModelDefaultsLink(props: { surface: AiSurface; orgId?: string | null; level: 'partner' | 'org' }): JSX.Element;
```

**data-testids:**

| Element | Testid |
|---|---|
| breakdown card | `ai-usage-breakdown` |
| group-by tabs | `ai-usage-groupby-model`, `-surface`, `-user`, `-org` |
| range inputs | `ai-usage-range-from`, `ai-usage-range-to` |
| table | `ai-usage-breakdown-table` |
| row | `ai-usage-breakdown-row-${key}` |
| refusal cell | `ai-usage-breakdown-refusals-${key}` |
| empty state | `ai-usage-breakdown-empty` |
| error state | `ai-usage-breakdown-error` |
| legacy-page pointer | `model-defaults-link-${surface}` |
| pointer's partner anchor | `model-defaults-link-partner` |
| pointer's org anchor | `model-defaults-link-org` |

Behaviour:
- **Breakdown.**
  - The group-by tabs follow the URL-state rule (CLAUDE.md "URL State in Components"): the selected grouping lives in `window.location.hash` as `#usage-by-model` / `#usage-by-surface` / `#usage-by-user` / `#usage-by-org`, read on mount and on `hashchange` (Codex review finding 18). It defaults to `#usage-by-model`. Add a test: rendering with `location.hash = "#usage-by-org"` fetches `groupBy=org`, and clicking a tab updates the hash.
  - The date range defaults to month-to-date.
  - The table sits in an `overflow-x-auto` wrapper (`no-clipped-tables.test.ts`). Columns: label (surfaces via `SURFACE_LABEL_KEYS`, `system` → "System / agents"), calls, cost (`formatCurrency(costCents / 100)`), input tokens, output tokens, refusals + rate as "3 (1.2%)", fallbacks.
  - A footer row shows the totals.
  - A footnote reads "Refusal rate is per model call. Counts start when the model registry went live; earlier usage is in the totals above."
  - The org filter is the page's existing org context (`currentOrgId` from `useOrgStore`). With no org selected, the breakdown covers all of the partner's orgs.
- **`ModelDefaultsLink`** renders the effective model for the surface. It is fetched from the org endpoint when `orgId` is set; otherwise it shows the static text "Set per feature". It links to `/settings/partner#ai-provider` and, when `orgId` is set, also to `/settings/organizations/${orgId}#ai`. It replaces each legacy field in place, so the old page's layout keeps a visible pointer. This satisfies rule 8's "old URLs redirect" for concepts that lived inside a page rather than at their own URL.

- [ ] **Step 1: Write the failing tests**

`AiUsageBreakdown.test.tsx`:

```ts
it('loads month-to-date by model and renders rows with refusal rate', async () => {
  fetchWithAuth.mockResolvedValueOnce(jsonRes({ groupBy: 'model', from: '2026-10-01', to: '2026-10-17', orgId: null,
    rows: [{ key: A, label: 'Model A', invocations: 80, costCents: 1234, inputTokens: 1, outputTokens: 2, refusals: 2, refusalRate: 0.025, fallbacks: 1 }],
    totals: { invocations: 80, costCents: 1234, inputTokens: 1, outputTokens: 2, refusals: 2, refusalRate: 0.025, fallbacks: 1 } }));
  render(<AiUsageBreakdown orgId={null} />);
  expect((await screen.findByTestId(`ai-usage-breakdown-refusals-${A}`)).textContent).toMatch(/2 \(2\.5%\)/);
  expect(fetchWithAuth.mock.calls[0][0]).toMatch(/^\/ai\/models\/usage\?groupBy=model/);
});
it('switches grouping and passes the org filter', async () => {
  fetchWithAuth.mockResolvedValue(jsonRes(emptyBreakdown('surface')));
  render(<AiUsageBreakdown orgId={ORG} />);
  fireEvent.click(await screen.findByTestId('ai-usage-groupby-surface'));
  await waitFor(() => expect(fetchWithAuth.mock.calls.at(-1)![0]).toMatch(new RegExp(`groupBy=surface.*orgId=${ORG}`)));
});
it('shows the empty state', async () => {
  fetchWithAuth.mockResolvedValueOnce(jsonRes(emptyBreakdown('model')));
  render(<AiUsageBreakdown orgId={null} />);
  await screen.findByTestId('ai-usage-breakdown-empty');
});
```

`PolicyEditor.test.tsx` (append; update existing cases that set `allowedModels`):

```ts
it('no longer edits allowed models; points to the office_chat assignment instead', async () => {
  renderLoadedEditor();
  expect(screen.queryByTestId(/^ai-office-policy-model-/)).toBeNull();
  expect(await screen.findByTestId('model-defaults-link-office_chat')).toBeTruthy();
});
it('does not send allowedModels on save', async () => {
  renderLoadedEditor();
  fireEvent.click(await screen.findByTestId('ai-office-policy-save'));
  await waitFor(() => expect(JSON.parse(lastPut().body)).not.toHaveProperty('allowedModels'));
});
```

`ScriptAuthoringPage.test.tsx`:

```ts
it('replaces both reviewer model fields with the script_reviewer pointer', async () => {
  renderPage();
  expect(screen.queryByTestId('script-reviewer-model')).toBeNull();
  expect((await screen.findAllByTestId('model-defaults-link-script_reviewer')).length).toBeGreaterThan(0);
});
it('org and partner saves no longer send reviewerModel', async () => { /* assert both PUT bodies lack reviewerModel */ });
```

API side (`routes/clientAi/admin.test.ts`, `routes/ai/scriptPolicy.test.ts`, `routes/partnerAiScriptPolicy.test.ts`):

```ts
it('PUT policy ignores allowedModels (single home: the office_chat assignment)', async () => {
  await put({ ...validPolicy, allowedModels: ['x'] });
  expect(lastSet()).not.toHaveProperty('allowedModels');
});
it('PUT script policy strips reviewerModel and no longer treats it as a widening', async () => {
  const res = await put({ reviewerModel: 'anything' });
  expect(res.status).toBe(200);                         // no approvals:decide demanded for a stripped field
  expect(lastSet()).not.toHaveProperty('reviewerModel');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
cd apps/web && npx vitest run src/components/settings/aiModels/AiUsageBreakdown.test.tsx src/components/clientAi/PolicyEditor.test.tsx src/components/settings/ScriptAuthoringPage.test.tsx
cd ../api && npx vitest run src/routes/clientAi/admin.test.ts src/routes/ai/scriptPolicy.test.ts src/routes/partnerAiScriptPolicy.test.ts
```
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement** as described in Files. Then remove the AST contract allowlist entry and confirm that test passes: no `'claude-…'` literal remains in `PolicyEditor.tsx`.

- [ ] **Step 4: Run tests**

Run the Step 2 commands, plus:
```bash
cd apps/api && npx vitest run <W03 AST contract test path> src/routes/auth
cd ../web && npx vitest run src/components/settings/AiUsagePage.test.tsx src/lib/__tests__/no-clipped-tables.test.ts src/lib/__tests__/no-silent-mutations.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings/aiModels apps/web/src/components/settings/AiUsagePage.tsx apps/web/src/components/settings/AiUsagePage.test.tsx \
  apps/web/src/components/clientAi/PolicyEditor.tsx apps/web/src/components/clientAi/PolicyEditor.test.tsx \
  apps/web/src/components/settings/ScriptAuthoringPage.tsx apps/web/src/components/settings/ScriptAuthoringPage.test.tsx \
  apps/api/src/routes/clientAi apps/api/src/routes/ai/scriptPolicy.ts apps/api/src/routes/ai/scriptPolicy.test.ts \
  apps/api/src/routes/partnerAiScriptPolicy.ts apps/api/src/routes/partnerAiScriptPolicy.test.ts apps/api/src/__tests__ apps/web/src/locales
git commit -m "feat(ai-models): usage breakdown by model/surface/tech/org; legacy model editors point to the registry (#7602)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Settings catalog entry, translations, docs, e2e

**Files:**
- Modify: `apps/web/src/lib/settingsCatalog.ts`: add an entry after `ai-usage`:
  ```ts
  { id: 'ai-models', name: 'AI Providers & Models', labelKey: 'nav.aiModels', href: '/settings/partner#ai-provider', icon: Cpu, group: 'ai', partnerScopeOnly: true, requiredPermission: { resource: 'billing', action: 'manage' } },
  ```
  Add `nav.aiModels` to `locales/*/common.json`. Import `Cpu` from `lucide-react`. The page `/settings/partner` is already reachable, so `settingsPageRegistry.test.ts` needs no change. Run it to prove that.
- Modify: `apps/web/src/locales/<8 locales>/settings.json`, `common.json`, `ai.json`: every key added in Tasks 11–15, in all 8 locales (`en`, `pt-BR`, `es-419`, `fr-FR`, `fr-CA`, `de-DE`, `it-IT`, `tr-TR`). Delete the now-unused `partnerAiProvider.*` keys, `policyEditor.allowedModels` / `allModelsHint`, and `scriptAuthoringPage.fields.reviewerModel` / `reviewerModelHint` from every locale.
- Modify: `apps/docs/src/content/docs/deploy/environment.mdx`. In the `BREEZE_AI_SCRIPT_REVIEWER_MODEL` row W03 wrote, replace "Until that page ships, new partners still inherit this value." with "New partners inherit this value as their initial script-reviewer default; change it per partner under AI Providers & Models."
- Modify: the AI provider doc page. Find it with `git grep -l "AI Provider" apps/docs/src/content/docs`. Rename its heading to "AI Providers & Models" and add three sections, "Connections and residency", "Models", and "Defaults by feature (and org overrides)", each describing the cards in Tasks 11–14 in 2–4 sentences.
- Create: `e2e-tests/pages/PartnerAiModelsPage.ts`
- Create: `e2e-tests/tests/ai-providers-models.spec.ts`

**e2e page object:**

```ts
import { BasePage } from './BasePage';
import { waitForAppReady } from './hydration';

export class PartnerAiModelsPage extends BasePage {
  url = '/settings/partner#ai-provider';
  tab = () => this.page.getByTestId('partner-settings-tab-aiProvider');
  root = () => this.page.getByTestId('ai-models-tab');
  connectionRow = (id: string | null) => this.page.getByTestId(`ai-connection-row-${id ?? 'platform'}`);
  residencySwitch = () => this.page.getByTestId('ai-residency-switch');
  residencyConfirm = () => this.page.getByTestId('ai-residency-confirm');
  residencyConfirmCancel = () => this.page.getByTestId('ai-residency-confirm-cancel');
  offeringEnable = (rowKey: string) => this.page.getByTestId(`ai-offering-enable-${rowKey}`);
  offeringEdit = (rowKey: string) => this.page.getByTestId(`ai-offering-edit-${rowKey}`);
  offeringDrawer = () => this.page.getByTestId('ai-offering-drawer');
  offeringPremium = () => this.page.getByTestId('ai-offering-premium');
  offeringSave = () => this.page.getByTestId('ai-offering-save');
  defaultsSelect = (surface: string) => this.page.getByTestId(`ai-defaults-default-${surface}`);
  defaultsSave = () => this.page.getByTestId('ai-defaults-save');
  async goto() { await this.page.goto(this.url); await waitForAppReady(this.page, 'ai-models-tab'); }
}
```

**e2e spec outline** (`ai-providers-models.spec.ts`; testid-only; one shared context per file per the `partner-sending-domains.spec.ts` precedent: `test.describe.configure({ mode: 'serial', timeout: 180_000 })`, `persistStorageState`):
1. **The tab renders under the new name.** Go to `/settings/partner#ai-provider`. The `partner-settings-tab-aiProvider` text is "AI Providers & Models", and `ai-connection-row-platform` is visible.
2. **Enable and disable a platform model, autosaved.** Toggle `ai-offering-enable-<seeded platform offering>` off, then on. Wait for the `POST /ai/models/offerings/:id/enabled` 200 each time, and reload: the state persists.
3. **The in-use guard.** Toggle off the seeded `chat` default. `ai-offering-disable-confirm` appears and lists "Chat". Cancel, and the switch stays on.
4. **The offering drawer.** Open a row's drawer, tick `ai-offering-premium`, and Save. The `PATCH` returns 200. Reopen: it is still ticked.
5. **Defaults by feature.** Change `ai-defaults-default-catalog_enrichment` to another enabled offering, Save, and reload: the value persists.
6. **Residency confirm.** Click `ai-residency-switch`. `ai-residency-confirm` appears (seed defaults cannot honour a geo until W01's spike enables carriage). Cancel, and the switch stays off. No `PUT /ai/models/residency` is sent (`page.on('request')` counter = 0).
7. **Org override.** Go to `/settings/organizations/<seeded org>#ai`. `org-model-defaults-card` shows `org-model-defaults-inherited-chat` with "partner default". Lock user choice on `chat`, Save, and reload: it persists.
8. **The legacy pointer.** On `/settings/ai-script-authoring`, `model-defaults-link-script_reviewer` is visible and `script-reviewer-model` is absent.

The seed fixtures must contain at least two enabled, tool-capable platform offerings for the e2e partner. Add them to `apps/api/src/db/seedE2eFixtures.ts` through the registry services. Never use raw SQL that bypasses the cutover: call `ensurePartnerCutover` first, then `ensurePlatformOffering` + `setOfferingEnabled` in a system context.

- [ ] **Step 1: Write the failing check**

Run: `cd apps/web && npx vitest run src/lib/i18n src/locales`
Expected: FAIL. `localeParity` reports the keys Tasks 11–15 added to `en` only, and `keyUsage` reports deleted keys still referenced, if any. Also add the catalog assertion to `src/lib/__tests__/settingsCatalog.test.ts` (or the nearest catalog test):
```ts
it('lists AI Providers & Models in the AI group, deep-linking the partner tab', () => {
  expect(SETTINGS_CATALOG.find((e) => e.id === 'ai-models')).toMatchObject({ group: 'ai', href: '/settings/partner#ai-provider' });
});
```
and watch it fail.

- [ ] **Step 2: Implement.** Add the catalog entry. Translate every new key in all 8 locales; machine-drafting is allowed, and the PR body carries the machine-drafted line per `locales/README.md`. Delete the dead keys. Update the docs. Write the page object and spec, plus the seed additions.

- [ ] **Step 3: Run the whole i18n and settings guard set**

Run:
```bash
cd apps/web && npx vitest run src/lib/i18n src/locales src/lib/__tests__/settingsPageRegistry.test.ts \
  src/lib/__tests__/settingsCatalog.test.ts src/components/layout/Sidebar.nav.test.tsx
```
Expected: PASS. If `translationCoverage` flags new keys whose translation equals English (e.g. "AI" or brand names), add the narrowest justified baseline bump the test's own comments describe. Never blanket-bump.

Run the e2e spec against a worktree stack (`pnpm wt-stack up`, then `cd e2e-tests && npx playwright test tests/ai-providers-models.spec.ts`), and tear the stack down afterwards with `pnpm wt-stack down`.
Expected: 8 passed. If no stack can be brought up in the executor's environment, record "e2e not run locally" in the PR. **This is a UI-test hold for Todd.**

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/settingsCatalog.ts apps/web/src/lib/__tests__ apps/web/src/locales apps/docs e2e-tests apps/api/src/db/seedE2eFixtures.ts
git commit -m "feat(ai-models): settings catalog entry, 8-locale strings, docs, e2e for AI Providers & Models (#7602)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 17: Full verification and the PR

- [ ] **Step 1: Typecheck everything touched**

```bash
cd packages/shared && npx tsc --noEmit
cd ../../apps/api && npx tsc --noEmit -p tsconfig.json
cd ../web && npx tsc --noEmit
```
Expected: exit 0 for all three.

- [ ] **Step 2: Run the affected suites in small batches** (foreground, generous timeouts)

```bash
cd apps/api && npx vitest run src/services/aiModels
cd apps/api && npx vitest run src/routes/aiModels src/routes/aiProvider.test.ts src/routes/aiProvider.registry.test.ts src/routes/clientAi src/routes/ai/scriptPolicy.test.ts src/routes/partnerAiScriptPolicy.test.ts
cd apps/api && npx vitest run src/__tests__/mcp-coverage.test.ts src/__tests__/partner-wide-write-coverage.test.ts src/__tests__/routerAuthGate.contract.test.ts <W03 AST contract test>
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiModelsRoutes.integration.test.ts src/__tests__/integration/resolveModel.integration.test.ts
cd apps/web && npx vitest run src/components/settings src/components/clientAi src/lib
cd packages/shared && npx vitest run src/validators
```
Expected: every batch green. Then run the full API unit suite once (`cd apps/api && npx vitest run`). It is the only run that catches a cross-file contract (e.g. `orgMerge.test.ts`-style registry walks) a touched-file run misses.

- [ ] **Step 3: Self-check the settings statement and the file-ownership table** against `git diff --stat feature/7598-ai-model-registry/wave-7601...HEAD`. Every changed file must appear in "File structure". Add any file that is missing, or explain it in the PR.

- [ ] **Step 4: Open the PR** stacked on W03 (base `feature/7598-ai-model-registry/wave-7601` until it merges, then retarget `main`), titled `feat(ai): model registry W04 — AI Providers & Models settings, /ai/models API, usage breakdown (#7602)`. The body must include:
  - `Closes #7602`, `Part of #7598`;
  - the "Settings PR statement" below, verbatim, updated with anything that changed;
  - the Preconditions table differences (Q1–Q12), if any;
  - the line `pt-BR strings are machine-drafted pending native review` (and the es-419/fr/de/it equivalent line, per `locales/README.md`);
  - the decisions D1–D11 and the open questions;
  - the release note: **W03 and W04 ship in the same release** (W03 freezes the legacy editors' routing effect; W04 replaces them).

  Stacked PRs get no CI (`ci.yml` triggers on PRs to `main`). Run `gh workflow run CI --ref feature/7598-ai-model-registry/wave-7602` and wait for it before asking for merge.

- [ ] **Step 5: Run the review round.** One `/pr-review-toolkit:review-pr` pass, with the authz matrix and the tenancy suite as the focus. Act only on confirmed, consequential findings, and post the review summary as a PR comment.

---
## Settings PR statement (CLAUDE.md rule 9; paste into the PR body)

| Setting | Home (one per level) | Level | Resolver | Places configured before → after |
|---|---|---|---|---|
| Model per AI feature: default, permitted set, user choice, effort | Partner Settings → **AI Providers & Models** → "Defaults by feature" | partner | `getEffectiveAssignment` → `resolveModel` (W02/W03) | **Before**, 5 UI/DB places + 4 env vars:<br>• partner AI Provider tab "default model" (`partner_llm_configs.default_model`);<br>• Office PolicyEditor allowed models (`client_ai_org_policies.allowed_models`);<br>• script reviewer model, org form (`ai_script_policies.reviewer_model`, org row);<br>• script reviewer model, partner form (partner row);<br>• agent allowlist (`ai_budgets.allowed_models`, DB-only);<br>• `ANTHROPIC_MODEL`, `MCP_LLM_MODEL`, `WORKSPACE_CONTENT_LLM_MODEL`, `BREEZE_AI_SCRIPT_REVIEWER_MODEL`.<br>**After**, 1 partner home + 1 org override card. The env vars remain only as bootstrap defaults for a fresh self-host, and `BREEZE_AI_SCRIPT_REVIEWER_MODEL` is documented as deprecated. |
| Model-default override | Org Settings → AI → **Model defaults** | org | the same tighten-only merge | before 3 (Office policy, org reviewer field, org `ai_budgets.allowed_models`) → after 1 |
| Connections (key, endpoint, name, inference geo) | AI Providers & Models → "Connections" (row drawer Save) | partner | `getConnection` → W03 `candidateLoader` | before 1 (AI Provider tab; no geo) → after 1 |
| Residency requirement | AI Providers & Models → "Connections" header switch (autosave + toast) | partner | W03 `loadPartnerFacts().residencyRequired` | before 0 → after 1. A new concept; `PATCH /orgs/partners/me` cannot write `settings.ai`, pinned by a test. |
| Models a partner may use (enable, price for BYO, options, premium permission, refusal fallback) | AI Providers & Models → "Models" (switch autosave + toast; details in a row drawer) | partner | W03 `checkEligibility` | before 0 (a hard-coded list) → after 1 |
| AI usage by model / feature / tech / org, refusal rate | Settings → AI Usage (existing page, new card; read-only) | partner, with org filter | `queryAiUsageBreakdown` over `ai_invocations` | n/a (a report, not a setting) |

The count only goes down. `/ai/provider` (`GET`/`PATCH`/`POST key`/`POST endpoint`/`DELETE`) stays as an **API-only** compatibility surface with no UI caller, and W08 deletes it. Its `PATCH defaultModel` writes the same registry rows through W03's `changeCompatDefaultModel`, so it is not a second store. The legacy columns stay readable until W08 drops them, but **no editor or PUT schema writes them after W04**.

Rule check:
- **1:** one home per level.
- **2:** AI settings live under the AI tab and the AI group.
- **3:** partner → org (tighten-only) → snapshotted on the turn (W03 turn binding).
- **4:** blank = inherit, showing the value and its source.
- **5:** one resolver, `resolveModel`.
- **6:** snapshotted at turn claim (W03).
- **7:** each card uses one save pattern, per spec §11.
- **8:** catalog entry `ai-models` plus the `#ai-provider` deep link. The legacy fields are replaced in place by a pointer.

## Decisions taken in this plan

| # | Decision | Why | Reversible? |
|---|---|---|---|
| D1 | **No migration, and `partner_ai_connections_compat_uq` stays.** The Connections UI is list-shaped, but the API allows one `anthropic_byok`/`catalog` connection (409 on a second). | The index excludes `openai_compatible`, so W06 is unblocked. `getCompatConnection`, the `/ai/provider` facade and W03's `compatRemap` all assume one row. Dropping it means rewriting W03's facade, which is W08's job. | Yes. W06/W08 drop the index when a second Anthropic-dialect connection is needed. |
| D2 | **The enable gate is `checkEligibility` with the dispatch-only inputs neutralised** (`checkEnableEligibility`), not a second rule list. Connection health reports but never blocks enabling. | PR #7665 handoff ("reuse W03's eligibility rules, never a second copy"). A key in `error` is transient. | Yes |
| D3 | **Org overrides use the `organizations:write` + MFA gate**, the same as the neighbouring AI budget card (`PUT /ai/budget`). | Spec §12 "the org-settings permission". It is consistent within the `#ai` tab. **Consequence:** the seeded Org Admin role has no `organizations:write`, so org admins see the card read-only and partner techs edit it. This matches the budget card today. | Yes. A one-line gate change to `ai_agents:write` or a new permission. **Open question 1.** |
| D4 | **"Verify" on an offering re-runs discovery** for its connection (capabilities and lifecycle). Platform rows are verified by the operator. | Harness verification of BYO models is W06's scope (spec §6). Anthropic/catalog verification already happens at connect and at revision level. | Yes |
| D5 | **Changing the `script_reviewer` model (partner or org) requires `approvals:decide`.** The old field's lane step-up grant is not replicated; MFA is required instead. | It preserves the privileged-widening intent of `partnerAiScriptPolicy.ts:103-150` without copying the lane-grant machinery into a generic assignment API. | Yes. **Open question 2.** |
| D6 | **The tab key `aiProvider` and the hash `#ai-provider` stay**, with the label renamed and an alias hash `#ai-models` added. | Bookmarks, W03's `unavailableMessage` and the e2e testid prefix `partner-settings-tab-aiProvider`. | Yes |
| D7 | **Disabling an offering that is a default returns 409 `offering_in_use`** unless `force`. The UI confirms with the list of surfaces. | A silent disable makes every call on that surface fail `no_eligible_model` (Review Focus 1). | Yes |
| D8 | **Usage counts only `authoritative` ledger rows, and the refusal rate is per model call.** | Shadow rows were never billed (W02). A refusal-fallback turn writes two rows (W03 Task 6), and the UI says "per call". | Yes |
| D10 | **Fast mode on the platform key is opt-in behind `ai_models:premium`.** New fast-capable platform offerings start with `allowedOptions.speed = ['standard']`. | Spec §15 #7 (approved), Codex finding 8. | Yes |
| D11 | **The retained `PATCH /ai/provider` gets MFA + `approvals:decide`.** | It reaches the same assignment rows as `/ai/models/assignments` (W03 compat remap), so it must not be a weaker door (Codex finding 4). | Yes; W08 deletes the route. |
| D9 | **Turning residency on with a non-empty impact needs an explicit acknowledgement.** | Until W01's spike enables geo carriage, every surface becomes `residency_unavailable` (W03 self-review). | Yes. **Open question 3.** |

## Open questions for Todd

1. **Who may edit an org's model overrides?**
   - **A, keep `organizations:write`** (as planned, matching the AI budget card): org admins are read-only; partner techs edit.
   - **B, `ai_agents:write`**: the existing "org admin may tighten their own org's agent policy" precedent.
   - **C, a new `ai_models:manage` seeded to Org Admin**: needs a permission migration.

   **Recommend A**, for consistency with the budget card next to it, and revisit with the budget card together.
2. **Should the reviewer-model change keep the full lane step-up grant,** rather than `approvals:decide` + MFA (D5)? **Recommend no**: the assignment is a model choice within the partner-enabled set, not a lane widening. Revisit if the security review disagrees.
3. **Should the residency switch ship before W01's spike enables `inference_geo` carriage?** Until then, turning it on disables every AI feature (shown in the confirm). **Recommend shipping it with the confirm.** The EU deployment decision (spec §15 #5) needs the switch to exist, and the confirm makes the impact explicit.
4. **Release coupling.** W03 must not reach a release without W04: the legacy editors' writes stop routing in W03. This plan assumes the merge order W03 → W04 → release, and that the billing deploy gates W03.

## Self-review

**Spec coverage (§11 rows → tasks):**
- Connections incl. inference geo, row drawer: Tasks 7, 8, 11.
- Residency header switch, autosave: Tasks 7, 8, 11.
- Offerings:
  - enable autosave: Tasks 3, 4, 8, 12;
  - details drawer (options, BYO price, required permission, refusal fallback, verify): Tasks 4, 8, 12;
  - price rule §8: Task 4 `prices` rules, and Task 8 DTO `priceSource` / `pricesEditable`.
- Assignments: page Save: Tasks 5, 8, 13. W09's roles and fallbacks: room left (Tasks 1, 5, 13).
- Org override (tighten-only, blank = inherit with source, page Save): Tasks 6, 9, 14.
- `/settings/ai-usage` by model / surface / tech / org + refusal rate, org filter: Tasks 9, 15.
- Existing surfaces (PolicyEditor → `office_chat`, reviewer field → `script_reviewer`, agent allowlist → the `ai_agents` assignment): Task 15. The agent allowlist had no editor, so its row is the `ai_agents` row in Defaults by feature and the org card.
- §12 permissions and audit: Tasks 8, 9 (matrix tests).
- PR #7665 handoffs:
  - `safeDbError` for `createConnection`: Task 2;
  - `enableOffering` gates: Tasks 3, 4.
- Settings registry and redirects: Task 16 (catalog), Task 15 (in-place pointers), Task 11 (hash alias).
- MCP coverage: Tasks 8, 9. Partner-wide-write coverage: Tasks 4, 5, 7.
- i18n (8 locales, the whole `lib/i18n` + `locales` test dirs): Task 16. e2e: Task 16.

**Placeholder scan:** every code step carries code. Two steps name a file the executor must locate by `git grep`, because the path depends on W03's or the repo's existing naming:
- W03's AST contract test;
- the `PATCH /partners/me` test file.

Both give the exact grep.

**Type consistency:**
- `RegistryWriteError(message, code, status, details)` is used identically in Tasks 2–9.
- `checkEnableEligibility(facts, { partnerId, partnerPlan, hosted })` is consumed by Tasks 4, 5, 6 and 8 via `enableEligibilityContext` (Task 4).
- `listAssignmentRows` lives in `assignmentRows.ts` and is re-exported from `assignmentWrites.ts`; Tasks 5–8 import it from either.
- The DTO names match Task 1.

**Review Focus → pinning tests:**
1. Task 4 "refuses to disable a default offering without force" and Task 12 "disable confirm lists affected surfaces".
2. Task 6 table "org write rejects every widening".
3. Task 10 "cross-tenant ids never write", Task 8 "404s a connection id…", and Task 9 "GET 404s an org of another partner".
4. Task 7 "refuses to turn on with impact unless acknowledged" and Task 11 residency tests.
5. Task 8 matrix "503 registry_unavailable when the cutover resolves false (W03 contract), and no service write" + "… rejects, too".

## Review

**The review.** It was an independent Codex review (`gpt-6-astra`, `model_reasoning_effort=high`, read-only, foreground), run 2026-10-01 against this plan, the spec, the index, the W03 plan and merged `main` `02fd9abd76`.

**Outcome.** 18 findings: **18 adopted** (3 of them with a modified fix) and **0 rejected**. Each adopted change is marked "Codex review finding N" in the task it changed.

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | H | The drawer rotated the key, then switched the endpoint. The key probe runs against the *stored* endpoint, so a new key could be sent to the old destination. | **Adopted, modified.** A Save may change the key OR the endpoint, never both (Task 11), and the UI explains why. A combined server operation was not added, because it would mean reworking W03's facade; one change per verified step keeps both probes honest. |
| 2 | H | W03's `ensurePartnerCutover` **resolves `false`**; it does not throw. | **Adopted.** Q5 corrected. `registryWrite` returns 503 on `false` or on a rejection, and the matrix tests both (Task 8). |
| 3 | H | Adding and enabling a platform offering in one request: the W03 loader reads in its own system transaction and cannot see the uncommitted insert. | **Adopted.** `ensurePlatformOffering({ enabled })` gates on facts built from the platform row and inserts it already enabled, in one statement (Task 4, Q13). The route no longer calls `setOfferingEnabled` on a new row. |
| 4 | H | The retained `PATCH /ai/provider` (default model) bypasses MFA and the reviewer gate, but W03's compat remap re-points `script_reviewer`. | **Adopted.** That PATCH gains `requireMfa()` + `approvals:decide` (Task 8). |
| 5 | H | The assignment version check happened before the transaction, so lost updates were possible. | **Adopted.** `conditionalUpsert` / `conditionalDeleteOrgRow`: insert-only when no row is expected, versioned UPDATE/DELETE otherwise, and stale → throw → whole-batch rollback (Tasks 5, 6). |
| 6 | H | Postgres microseconds vs the ISO-ms DTO make unchanged rows look stale. | **Adopted, modified.** Version compare is at **ms precision** (`date_trunc('milliseconds', updated_at)`), and W04's own writes are ms-precision. A version column was rejected: it would need a migration this wave does not take. The residual same-millisecond window is documented, and an integration test pins a microsecond row (Task 10). |
| 7 | H | The drawer rebuilt `allowedOptions` from effort only, so a rename dropped the `speed` / `thinkingDisplay` restrictions. | **Adopted.** It merges into the stored allow-list, plus a test that a rename sends no `allowedOptions` (Task 12). |
| 8 | H | Fast mode on the platform key was possible without the deliberate permission (spec §15 #7). | **Adopted.** New fast-capable platform offerings start with `speed: ['standard']`. Allowing fast on a platform-funded offering requires `ai_models:premium` (API 422 `fast_requires_permission`; UI auto-ticks and locks), in Tasks 4 and 12. |
| 9 | M | Option validation ran against the pre-edit state, so setting own prices left a fast default without a rate. | **Adopted.** `validateProposedOptions` always validates the full proposed state, and fast loses its rate when own prices are set (Q14) (Task 4). |
| 10 | M | Clearing own prices was refused even when a priced linked platform row remains. | **Adopted.** The remaining §8 source is resolved via `offeringPriceSource` (Task 4). |
| 11 | M | The system `PATCH /orgs/partners/:id` wholesale-replaces settings and can erase `settings.ai`. | **Adopted.** A reserved-subtree guard (keep stored, ignore incoming), plus a test (Task 7). |
| 12 | M | The residency preview ignored org overrides with their own defaults. | **Adopted.** `affectedOrgOverrides` in the DTO, the preview, the 409 details and the confirm dialog (Tasks 1, 7, 11). |
| 13 | M | Any autosave reloads the snapshot, which reset unsaved Defaults drafts. | **Adopted.** Only non-dirty rows re-initialise, with a "changed elsewhere" marker (Task 13). |
| 14 | M | Assignment option editing was effort-only; spec §11 puts options on both forms. | **Adopted.** Effort, thinking display and speed on both the partner and org forms, tighten-only on the org side (Tasks 13, 14). |
| 15 | M | The platform geo was hard-coded `null` ("provider default"), but W03 sends `AI_PLATFORM_INFERENCE_GEO`. | **Adopted.** `effectiveInferenceGeo` + `inferenceGeoSource` in the connection DTO and the UI (Tasks 1, 8, 11). |
| 16 | M | Usage dates: a one-sided range bypassed the cap, and impossible dates passed the regex. | **Adopted.** Both-or-neither, plus calendar round-trip validation (Task 1). |
| 17 | M | `seedPlatformModel()` is identity-only, not "priced + offered + tool-capable", and one setup step swallowed errors. | **Adopted.** `seedEligiblePlatformModel()`, non-tool surfaces in the integration suite, and no swallowed setup (Task 10). |
| 18 | L | Usage group-by tabs in local state violate the URL-state rule. | **Adopted, modified.** The grouping goes in the hash (`#usage-by-*`) (Task 15). |

Codex's existence check (item 2) found no route, function or table the plan names as merged that is missing on `main`. Every W03-only name is in the Preconditions table (Q1–Q15).

## Index additions

These names are introduced here and are absent from the index and from W01–W03's Index additions. None renames an existing name.

| Where | Name(s) | Why |
|---|---|---|
| `packages/shared/src/validators/aiModelRegistryApi.ts` | `CONFIGURABLE_AI_SURFACES`, `AI_MODEL_REQUIRED_PERMISSION_CHOICES`, `AI_USAGE_GROUP_BYS`, `AiUsageGroupBy`, `MAX_AI_USAGE_RANGE_DAYS`, `connectionCreateSchema`, `connectionRotateKeySchema`, `connectionEndpointSchema`, `connectionSettingsPatchSchema`, `offeringEnableSchema`, `offeringDetailsPatchSchema`, `partnerAssignmentInputSchema`, `partnerAssignmentsPutSchema`, `orgAssignmentInputSchema`, `orgAssignmentsPutSchema`, `residencyPutSchema`, `aiUsageQuerySchema` + inferred types | `/ai/models` request contract (W05–W11 extend the unions and enums) |
| `packages/shared/src/types/aiModelRegistry.ts` | `AiConnectionKind`, `AiConnectionDto`, `OfferingEnableBlocker`, `AiOfferingDto`, `AiAssignmentRowDto`, `AiSurfaceDefaultsDto`, `AiModelsSnapshotDto`, `AiOrgSurfaceDefaultsDto`, `AiOrgModelDefaultsDto`, `AiResidencyImpactDto`, `AiUsageRowDto`, `AiUsageBreakdownDto` | Response DTOs; W05's picker reuses `AiOfferingDto` fields |
| `services/aiModels/registryWriteErrors.ts` | `RegistryWriteError`, `RegistryWriteCode`, `toRegistryWriteError` | The one write-error mapper (scrub + SQLSTATE map) |
| `services/aiModels/eligibility.ts` (W03 file) | `checkEnableEligibility`, `enableBlockerFor`, `EnableEligibilityContext`, `EnableGateReason` | The enable gate over W03's rule table |
| `services/aiModels/offeringWrites.ts` | `ensurePlatformOffering({ partnerId, platformModelId, enabled })`, `setOfferingEnabled`, `updateOfferingDetails`, `listOfferingDefaultUses`, `OfferingInUse`, `enableEligibilityContext`, `supportedOptionValues`, `OPTION_KEYS`, `platformCandidateFacts`, `sameVersion` | Offering writes; the ms-precision version token |
| `services/aiModels/assignmentRows.ts` | `listAssignmentRows` | Raw partner/org assignment rows |
| `services/aiModels/assignmentWrites.ts` | `putPartnerAssignments`, `putOrgAssignments`, `assertOfferingUsableForSurface`, `assertOptionsSupported`, `assertNotStale`, `touchesSurface`, `conditionalUpsert`, `conditionalDeleteOrgRow` | Assignment writes with in-transaction optimistic concurrency (W09 extends with roles and fallbacks) |
| `services/aiModels/residency.ts` | `previewResidencyImpact`, `setResidencyRequired` | The only writer of `partners.settings.ai.residencyRequired` |
| `services/aiModels/connectionSettings.ts` | `updateConnectionSettings` | Connection name and inference geo |
| `services/aiModels/registryView.ts` | `buildCatalogSummary` (moved from `routes/aiProvider.ts`), `buildPartnerModelsSnapshot`, `buildOrgModelDefaults` | Read models |
| `services/aiModels/usageQueries.ts` | `buildUsageQuery`, `toUsageRow`, `defaultUsageRange`, `queryAiUsageBreakdown` | `ai_invocations` breakdowns (W10/W11 extend `groupBy`) |
| `routes/aiModels/` | `aiModelsRoutes` (index), `aiModelConnectionRoutes`, `aiModelOfferingRoutes`, `aiModelAssignmentRoutes`, `aiModelResidencyRoutes`, `aiModelOrgAssignmentRoutes`, `aiModelUsageRoutes`; `shared.ts`: `partnerRead`, `partnerWrite`, `requirePartnerWide`, `canDecideApprovals`, `APPROVALS_DECIDE_REQUIRED`, `registryWrite` | `/ai/models` (index: "W04 owns the `/ai/models` route") |
| Audit actions | `ai_models.connection.{created,key_rotated,endpoint_changed,updated,deleted,refresh_requested}`, `ai_models.offering.{added,enabled,disabled,updated,verify_requested}`, `ai_models.assignments.updated`, `ai_models.org_assignments.updated`, `ai_models.residency.updated` | Spec §12 "every mutation is audited" |
| Web `components/settings/aiModels/` | `PartnerAiModelsTab` (+ `useAiModelsSnapshot`), `ConnectionsCard`, `ConnectionDrawer`, `ResidencySwitch`, `ModelsCard`, `OfferingDrawer`, `FeatureDefaultsCard`, `OrgModelDefaultsCard`, `AiUsageBreakdown`, `ModelDefaultsLink`, `surfaceLabels.ts` (`SURFACE_LABEL_KEYS`, `ENABLE_BLOCKER_KEYS`, `REGISTRY_ERROR_KEYS`, `DEFAULT_SOURCE_KEYS`) | UI; `PartnerAiProviderTab.tsx` deleted (index: "renamed and rebuilt in W04") |
| Web routing | hash alias `#ai-models` → tab `aiProvider`; settings catalog id `ai-models` | Rule 8 |
| e2e | `e2e-tests/pages/PartnerAiModelsPage.ts`, `e2e-tests/tests/ai-providers-models.spec.ts` | testid-only coverage |
