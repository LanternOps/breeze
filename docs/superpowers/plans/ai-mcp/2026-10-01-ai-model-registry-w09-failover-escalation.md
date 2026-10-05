---
tracking_issue: LanternOps/breeze#7598
---

# AI Model Registry W09: failover walk + agent escalation roles — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Closes #7607

**Goal:** When the model a feature would use is unavailable, rate-limited, overloaded, out of quota or has a bad key, the call fails over along the partner's ordered `fallback_offering_ids` list. Failover crosses between Breeze credits and the partner's own key only when `fallback_may_cross_funding` allows it. Every hop re-checks eligibility, re-binds its own rate snapshot and reservation, and is settled against the offering that actually served it. AI agent runs resolve a per-stage model role (`triage` → `analysis` → `remediation`, #7570). The partner "Defaults by feature" card and the org override card gain role sub-rows and the fallback list.

**Architecture:**
- **Resolution-time walk (all surfaces).** `resolveModel` keeps W03's fast path and W03's bounded same-route fallback for a stored choice. When those fail, it walks the effective assignment's `fallbackOfferingIds`, in order. Each candidate has to pass the effective permitted set, the live `checkEligibility` rule table, the funding rule (same funding unless `fallbackMayCrossFunding`) and, for a session that already has history, the same-connection rule. The result carries `failover: { fromOfferingId, hop, cause } | null` and `failoverRemaining` (the ids a dispatch could still try).
- **Health cooldown.** A provider failure marks the offering as cooling down in Redis for a short TTL (`offeringHealth.ts`). The next resolution prefers a healthy fallback and still uses the cooling primary when nothing else is eligible: a cooldown never turns into an outage. This gives chat (which never replays a turn, D5) "next message fails over" behaviour.
- **Dispatch-time failover (Messages API one-shots and agent runs).**
  - `failoverDispatch.ts` `runWithFailover` wraps one surface call. On a classified **pre-output** provider failure (HTTP 429 / 529 / 5xx / 401 / 403 / 402, or "credit balance too low") it marks the cooldown. It then settles the failed hop at its **own** reservation (zero tokens unless the provider reported usage) and re-resolves with `excludeOfferingIds`. Next it admits the next hop for the next hop's funding (credits + budget), reserves it under a deterministic hop key (`<base>:hop:<n>`) with that hop's binding, and retries.
  - The AI agent run loop does the same around its Agent SDK `query()`. A run fails over only if the failed attempt produced no assistant output and executed no tool.
- **Money.**
  - A hop is never settled under another hop's binding or reservation.
  - The DB provenance guard already rejects a ledger row whose `funding_source` disagrees with its `offering_id`; W09 extends it to the new `failover_from_offering_id`.
  - Platform credits are debited once per served platform hop, under `ai-settlement:<that hop's reservation id>`, by W03's existing exactly-once path.
- **Escalation.** A pure `agentRunModelRole(run)` maps a run's `profile` and `modeAtStart` to a role. Admission and the run loop pass that role to `resolveModel`. `getEffectiveAssignment` stops letting an org's generic `default` override erase a partner's role-specific default (D2).

**Tech Stack:** Hono, Drizzle ORM on PostgreSQL (hand-written SQL migration, forced RLS), Redis (`ioredis` via `services/redis.ts`), `@anthropic-ai/sdk` `^0.128.0` (`APIError.status`, `error.type`), `@anthropic-ai/claude-agent-sdk` `^0.3.286` (`SDKAPIRetryMessage`, `SDKAssistantMessage.error`, `SDKResultSuccess.api_error_status`), Vitest (unit + real-Postgres integration), React + Vitest/jsdom (web).

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-30-ai-model-registry-design.md` (v3): §4 (Role), §5.4 (`role`, `fallback_offering_ids`, `fallback_may_cross_funding`, tighten-only "Fallbacks"), §5.5 (ledger), §8 (funding per offering), §9 step 1 (role inherits `default`), §9.1 (W09 replaces the single candidate with an ordered walk), §11 (Defaults by feature: "agent roles + fallbacks once W09 lands"), §13 W09 row, §14 (no model-chosen escalation inside a turn). **Names** come from `docs/superpowers/plans/ai-mcp/2026-09-30-ai-model-registry-index.md` and the W01–W04 "Index additions" tables, which are binding.

**Out of scope:**
- **In-turn replay of a chat / helper / script-builder / Office-chat turn on another model (D5).** These surfaces get the resolution-time walk and the cooldown, so the next message fails over. They never replay a turn mid-stream. Open question 2.
- Model-chosen escalation inside one agent run or one chat turn (spec §14).
- Per-agent role pins (an agent policy that names a different offering per role). An agent policy's single `offering_id` pin still wins over the role default (D3). Open question 5.
- Re-funding sandbox compute on a cross-funding failover. Compute stays on the admitted funding (D7).
- Chargeback (W10), the quality view (W11), BYO OpenAI-compatible kinds (W06/W07). W09's classifier is Anthropic-shaped, and W06/W07 add their kinds' arms.

---

## Preconditions

**Bases.** W09 is implemented **after W03 (#7601) and W04 (#7602) are merged to `main`** (W04 is stacked on W03 and ships with it). Branch `feature/7598-ai-model-registry/wave-7607` from a freshly fetched `origin/main`.

**Before Task 1, the executor verifies every row below against `origin/main`.** Rows marked **built** were read from `origin/feature/7598-ai-model-registry/wave-7601` at `8ddee4e3af` (W03 Tasks 1–12). Rows marked **plan** come from a W03 task (13–18) or a W04 task that was not built when this plan was written. If a name or shape differs, change only the W09 adapter named in the last column, and record the difference in the PR body.

| # | What W09 consumes | Status / source | If it differs, adapt only |
|---|---|---|---|
| P1 | `services/aiModels/resolveModel.ts`: `resolveModel(input)`, `ResolveModelInput` (`partnerId`, `orgId`, `userId?`, `surface`, `role?`, `requested?: { offeringId?, options?, origin?: 'user'\|'session'\|'policy' }`, `maxTokens?`, `transport?`), `ResolvedModel` (`ok`, `surface`, `role`, `transport`, `partnerId`, `orgId`, `offering: { id, displayName }`, `connection: ResolvedConnection`, `funding`, `logicalModel`, `wireModel`, `thinking`, `wireParams`, `options`, `inferenceGeo`, `refusalFallback?`, `promptProfile`, `rateSnapshot`, `capabilities`, `limits`, `catalogRevisionId?`, `configVersion?`, `fellBack`), `ModelUnavailable`, `unavailableMessage`, `PLATFORM_ONLY_SURFACES`, the internal `finalize(c, input, role, assignmentOptions, ctx, fellBack, transport)` and `tryDefault(stored, storedReason)` closures | built | Task 5 |
| P2 | `services/aiModels/eligibility.ts`: `checkEligibility(facts, ctx)`, `CandidateFacts`, `EligibilityContext`, `ResolveFailureReason` (incl. `registry_unavailable`); W04 adds `checkEnableEligibility`, `EnableEligibilityContext` | built / W04 plan Task 3 | Task 5, Task 12 |
| P3 | `services/aiModels/candidateLoader.ts`: `loadOfferingCandidate(id, partnerId)` → `LoadedCandidate \| null` (`offeringId`, `connectionId`, `funding`, `facts`, `displayName`, …), `readOrgPartnerId`, `readSessionModelRow(sessionId)` → `{ orgId, offeringId, options }` | built | Task 5 (reads `connectionId`/`funding`), Task 9 (`readSessionModelRow` gains `turnCount`) |
| P4 | `services/aiModels/assignments.ts` (W02, on `main`): `getEffectiveAssignment`, `mergeEffectiveAssignment`, `EffectiveAssignment.{fallbackOfferingIds, fallbackMayCrossFunding, permitted}`, `isPermitted`, the internal `pickForRole(rows, role)` | built (W02) | Task 4 |
| P5 | `services/aiModels/turnBinding.ts`: `TurnBinding` (`v: 1`, …, `refusalFallback`), `turnBindingFrom`, `parseTurnBinding`, `liveQueryKey`, `stableJson` | built | Task 6 |
| P6 | `services/aiModels/settleInvocation.ts`: `settleInvocation(input)`, `SettleInvocationInput`, `toNewInvocations`, `priceUsage`, `sumCostCents`, `quoteInvocationCents`; `services/aiModels/invocationLedgerWrite.ts`: `NewInvocation`, `recordInvocation` (W03 put the writer in `invocationLedgerWrite.ts`; the index's `invocationLedger.ts` re-exports it) | built | Task 6 |
| P7 | `services/aiModels/invocationUsage.ts`: `SdkTurnObservation` (`refusalFallback`, `refusalNoFallback`), `newSdkTurnObservation()`, `observeSdkMessage(obs, message)`, `messagesUsage(binding, attempts)`, `TurnOutcome` | built | Task 9 |
| P8 | `services/aiModels/connectionFactory.ts`: `anthropicClientFor(resolved, caller)`, `createMessage(client, resolved, body, requestOptions?)` → `{ message, attempts }`, `MessageAttempt`, `sdkModelOptions(resolved)`, `grantCatalogSdkEgress(resolved, { key, orgId, aiSessionId })` | built | Tasks 7, 8, 11 |
| P9 | `services/aiBudgetReservations.ts`: `reserveAiBudget({ orgId, idempotencyKey, billingSource, sessionId?, namespace?, clientBudget?, maxHoldCents?, binding? })` → `ReserveAiBudgetResult` (`unlimited` \| `reserved` \| `denied`); the internal `stampSessionBinding(sessionId, orgId, binding)`; `markAiBudgetReservationIndeterminate`; `creditDebitIdempotencyKey(reservationId)` = `ai-settlement:<id>` | built | Tasks 6, 7, 11 |
| P10 | `services/aiCostTracker.ts`: `checkBudgetDetailed(orgId, billingSource)` → `AiAccessDenial \| null` (credits + budget), `debitBillingCredits(orgId, cents, { idempotencyKey })`, `settleComputeCents` | built | Tasks 7, 11 |
| P11 | `services/scriptProposals/reviewer.ts`: resolve (`surface: 'script_reviewer'`) → `checkBudgetDetailed` → `reserveAiBudget({ idempotencyKey: \`script-review:${proposalId}:${attempt}\` })` → `anthropicClientFor` → `createMessage(..., { signal, maxRetries: 0 })` → `settle(attempts)` | built (~L330–520) | Task 7 |
| P12 | `routes/officeAddin/tickets.ts` (`office_ticket`: resolve → `checkBudgetDetailed` → DLP → `reserveAiBudget({ idempotencyKey: \`office-email-draft:${randomUUID()}\` })` → `draftTicketFromEmail` → `settleDraftUsage`); `services/officeAddin/aiEmailDraft.ts` (`EmailDraftFailedError.attempts`); `services/aiTicketDraft.ts` (same shape, inherits the chat session's offering) | built | Task 8 |
| P13 | `services/aiAgents/runService.ts`: `resolveAgentModelForAdmission(orgId, offeringId)` (~L1041), called after `modeAtStart` is computed (~L1241) and before the admission transaction (~L1295); the run row gets `fundingSource`, `admittedOfferingId` | built | Task 10 |
| P14 | `services/aiAgents/runLoop.ts`: re-resolve with `requested: { offeringId: run.admittedOfferingId ?? effective.offeringId, origin: 'policy' }` (~L1854), the funding guard (~L1871), `reserveAiBudget({ idempotencyKey: \`ai-agent-run:${run.id}\`, maxHoldCents, binding })` (~L2092), `grantCatalogSdkEgress` (~L2111), the `query()` loop with `observeSdkMessage` / `sdkTurnUsage` (~L2156–2245), `settleInvocation` (~L2297); `RunContext.run.{profile, modeAtStart, fundingSource, admittedOfferingId}` (`runLoopTypes.ts`) | built | Tasks 10, 11 |
| P15 | `services/streamingSessionManager.ts`: `session.refusalObservation` (an `SdkTurnObservation`, reset per turn), `observeSdkMessage(session.refusalObservation, message)` (~L1536), the result handler that calls `sdkTurnUsage` (~L1975) | built | Task 9 |
| P16 | `services/aiModels/sessionModel.ts`: `resolveSessionTurn({ sessionId, surface, userId, maxTokens?, transport? })` | built | Task 9 |
| P17 | `services/redis.ts`: `getRedis(): Redis \| null` (null when Redis is not configured) | built | Task 3 |
| P18 | W03 **Task 13** (catalog enrichment + `extension_content`): `services/extensionAi.ts` `buildExtensionAiContext().invoke` resolves `extension_content` → admit → reserve → `createMessage` → `settleInvocation({ sourceRef: 'extension:workspace_enrichment' })`; `catalogEnrichmentService.ts` `resolveEnrichmentModel(actor)` | plan (W03 Task 13) | Task 8 Step 6 |
| P19 | W03 **Task 17** contract test `services/aiModels/aiModelRegistry.contract.test.ts`: no `new Anthropic(` outside `connectionFactory.ts`, no `total_cost_usd` read outside `invocationUsage.ts`, no `'claude-…'` literal outside the allow-list | plan (W03 Task 17) | none. W09 adds no literal and no client. |
| P20 | W04 `packages/shared/src/validators/aiModelRegistryApi.ts`: `CONFIGURABLE_AI_SURFACES`, `partnerAssignmentInputSchema` (`role: z.enum(['default'])`, non-strict), `partnerAssignmentsPutSchema` (max `CONFIGURABLE_AI_SURFACES.length`), `orgAssignmentInputSchema`, `orgAssignmentsPutSchema`; `packages/shared/src/types/aiModelRegistry.ts`: `AiAssignmentRowDto`, `AiSurfaceDefaultsDto`, `AiOrgSurfaceDefaultsDto`, `AiUsageRowDto` | plan (W04 Task 1) | Task 1 |
| P21 | W04 `services/aiModels/assignmentWrites.ts`: `putPartnerAssignments`, `putOrgAssignments`, `assertOfferingUsableForSurface`, `assertOptionsSupported`, `assertNotStale`, `conditionalUpsert(tx, owner, row, values)` (never writes fallback columns), `conditionalDeleteOrgRow`, internal `isBlank`, `widens`; `assignmentRows.ts` `listAssignmentRows`; `registryView.ts` `buildPartnerModelsSnapshot`, `buildOrgModelDefaults`; `usageQueries.ts` `AGGREGATES`, `buildUsageQuery`, `toUsageRow`, `RawRow` | plan (W04 Tasks 5, 6, 8, 9) | Task 12 |
| P22 | W04 web `components/settings/aiModels/FeatureDefaultsCard.tsx` (drafts keyed `${surface}/${role}`; the comment `// W09 (#7607): role sub-rows … render here.`; `toInput(draft, snapshotRow)`), `OrgModelDefaultsCard.tsx`, `AiUsageBreakdown.tsx`, `surfaceLabels.ts` (`SURFACE_LABEL_KEYS`, `REGISTRY_ERROR_KEYS`) | plan (W04 Tasks 13–15) | Task 13 |
| P23 | Integration fixtures: `__tests__/integration/helpers/aiModelRegistrySeed.ts` (`seedRegistryPartner(kind)`, `seedPricedPlatformModel`), `aiModelRegistryFixtures.ts` (`fixtureSql`, `seedOffering`, `closeRegistryFixtures`), `db-utils.ts` (`createPartner`, `createOrganization`, `createUser`), `services/aiModels/connections.ts` `createConnection`; the billing stub pattern in `aiInvocationSettlement.integration.test.ts` (`vi.stubGlobal('fetch', …)` on `/ai-credits/deduct`) | built | Tasks 5, 7, 11 |

Also verify, with `git ls-tree --name-only origin/main apps/api/migrations | grep -E '/[0-9]{4}-' | sort | tail -1`, that nothing on `main` sorts after `2026-11-25-100000`. W03's newest file is `2026-11-19-100700-ai-agent-runs-blocked-funding.sql`. If anything sorts after the slot, bump the slot's time component and record that in the PR body.

## Decisions taken in this plan

| # | Decision | Why | Reversible? |
|---|---|---|---|
| D1 | **One walk, in the resolver, for both resolution-time and dispatch-time failover.** Dispatch failover re-calls `resolveModel` with `excludeOfferingIds` and `failoverCause`, and never picks a hop itself. | The brief says "extend, don't duplicate". The permitted set, live eligibility, funding and connection rules live in one place, and every hop is re-checked against live rows. | Yes |
| D2 | **Role precedence.** For role R ≠ `default`, the partner side is `pR ?? pD` and the org side is `oR ?? oD` (W02). One exception: when the org side is the org's **default** row and the partner has an **R** row, the org row's `defaultOfferingId` and `fallbackOfferingIds` are not applied to R. Its narrowing (permitted set, user choice, options, cross-funding) still is. | Without it, any org that overrides the `ai_agents` default silently collapses triage/analysis/remediation onto one model, which is the opposite of #7570. Tighten-only still holds, because the org's permitted set still bounds R. | Yes. Open question 3. |
| D3 | **An agent policy's offering pin wins over the role default.** A pinned agent still uses the role's permitted set, fallback list and cross-funding flag. | The pin is an explicit admin choice (W03 binds it at write). A role only changes what an unpinned agent defaults to. | Yes. Open question 5. |
| D4 | **Profile/mode → role table.** `verdict`, `triage` and shadow `sweep` → `triage`. `analysis`, `narrative`, `design`, `patch` and shadow `full` → `analysis`. `act`-mode `full` and `act`-mode `sweep` → `remediation`. The table is declared `satisfies Record<AiAgentRunProfile, …>`, so a new profile is a compile error. | Remediation is the stage that can change customer machines (act mode); triage is a cheap first look. | Yes. Open question 1. |
| D5 | **Session surfaces (chat, helper, script builder, Office chat) never replay a turn.** They get the walk and the cooldown. A session **with history** fails over only within its connection; a session's first turn may cross connections. | Spec §9.2 / §15 #4: a cross-connection switch with history needs W05's continuation. The W05 spike (Q3) showed an oversized resume compacts silently and loses the prompt. A turn that failed after the CLI persisted the user message cannot be replayed without duplicating it. | Yes. Open question 2. |
| D6 | **Stickiness.** A failover caused by the stored choice being **ineligible** stamps the session (W03 behaviour: the old choice is gone). One caused by a **provider failure or cooldown** does not stamp the session's `offering_id` / `options` / `model` / `billing_source`, so the user's choice is retried next turn. | Matches the Agent SDK's own `fallbackModel` semantics ("the primary model is re-tried at the start of each user turn"). A transient 529 does not permanently demote a chat. | Yes |
| D7 | **Sandbox compute stays on the admitted funding** (`ai_agent_runs.funding_source`). Only model tokens fail over. `served_funding_source` records the token funding. | Admission reserved compute under the admitted funding (`reserveComputeCents`). Moving it mid-run would need a second compute reservation for no product gain. | Yes |
| D8 | **What fails over** is HTTP 429 / 529 / 500–504 / 401 / 403 / 402 and a 400 "credit balance is too low", i.e. a provider **status** response. A timeout or a socket reset after send does not: the outcome is unknown, so W03's indeterminate path keeps it. An `invalid_request` / `model_not_found` / `max_output_tokens` error does not either. | Only a status response proves no output and no spend. A malformed request would fail identically on every hop. | Yes |
| D9 | **Cooldown TTLs.** `rate_limited` / `overloaded` / `server_error`: 60 s. `auth_failed` / `quota_exhausted`: 15 min, cleared early when the connection's key is rotated. Redis absent → no cooldown (fail open to normal resolution). | Short enough that a recovered primary is back within a minute; long enough to stop hammering a dead key. | Yes. Open question 6. |
| D10 | **The fallback list is capped at 5** (`MAX_FALLBACK_OFFERINGS`) and may not contain the row's own default (write-time 422 + DB CHECK). `failover_hop` ≤ 6. | Bounds the worst-case latency and reservations of one call. | Yes |

## Global Constraints

- **Rigor: high (funding).** Every task is TDD: write the assertion, watch it fail for the stated reason, then implement.
- **Binding names** (index + W01–W04 Index additions): `resolveModel`, `ResolvedModel`, `turnBindingFrom`, `TurnBinding`, `settleInvocation`, `recordInvocation`, `NewInvocation`, `getEffectiveAssignment`, `mergeEffectiveAssignment`, `AI_SURFACE_ROLES`, `TOOL_REQUIRING_SURFACES`, `putPartnerAssignments`, `putOrgAssignments`, `buildPartnerModelsSnapshot`, `buildOrgModelDefaults`, `FeatureDefaultsCard`, `OrgModelDefaultsCard`. W09's new names are in "Index additions".
- **Funding rules (spec §5.4, §8, §9.1). Each is pinned by a named test.**
  - **F1.** A hop whose funding differs from the primary's is skipped unless the **effective** `fallbackMayCrossFunding` is true (partner ∧ org; an org can only turn it off). If the primary's funding is unknown (a stored choice that no longer loads), every hop counts as crossing.
  - **F2.** Every hop is re-checked live: the effective permitted set, `checkEligibility` (enabled, lifecycle, platform-offered, connection active + key usable, priced, tools, permission for user-initiated calls, `min_plan`, residency), and the transport's tool requirement.
  - **F3.** Every dispatched hop has its own `turnBindingFrom(hop)` and its own reservation with `billingSource: hop.funding`, reserved only after `checkBudgetDetailed(orgId, hop.funding)` passes. The hop key is `hopIdempotencyKey(base, n)`.
  - **F4.** A failed hop is settled on **its own** binding and reservation: zero tokens unless the provider reported usage. Nothing from a failed hop is carried into the next hop's settlement.
  - **F5.** The served hop is settled on its own binding and reservation. The ledger row's `offering_id`, `connection_id` and `funding_source` are the served hop's. `failover_from_offering_id` / `failover_hop` / `failover_cause` record the provenance.
  - **F6.** Platform credits are debited only by W03's `settleInvocation` path: once per settled platform reservation with spend > 0, under `ai-settlement:<reservationId>`. W09 adds no debit call.
- **Platform-key traffic is never priced from a non-platform rate** (index invariant 5). A hop's rate snapshot is the hop's own (`resolveModel` → `rateFor`).
- **Migration.** Exactly one file: `apps/api/migrations/2026-11-25-100000-ai-model-registry-failover.sql`. It is idempotent and writes no rows (DDL + `CREATE OR REPLACE FUNCTION` only), so no system-scope election is needed. It has no inner `BEGIN`/`COMMIT`. Re-run `scripts/check-migration-naming.sh --against-ref origin/main` before pushing.
- **Registrations for new columns** (CLAUDE.md "export-policy row fires on a new column"):
  - `ai_invocations.failover_from_offering_id`, `.failover_hop`, `.failover_cause` → `CORE_TENANT_EXPORT_POLICY` `included`;
  - `ai_agent_runs.served_offering_id`, `.served_funding_source`, `.served_failover_hop`, `.served_failover_cause` → `included`.
  - No new table, so no RLS shape, cascade or merge entry. Both tables are already registered: `ai_invocations` merge `repoint` and `AUDIT_ADMIN_REQUIRED_TABLES`; `ai_agent_runs` in the cascade order.
- **DB contexts.** The resolver's reads stay in `runOutsideDbContext(() => withSystemDbAccessContext(...))` (W03). Redis reads happen outside any DB transaction. Never call `resolveModel` or Redis while holding a row lock or a reservation transaction.
- **No new `new Anthropic(`**, no `total_cost_usd` read, no `'claude-…'` literal outside tests (P19).
- **Public repo.** No IPs, hostnames or infrastructure detail in code, comments, commits or the PR.
- **Tests.** Tests sit alongside source. Real-Postgres suites go in `apps/api/src/__tests__/integration/` and start with `import './setup'`.
  - Unit: `cd apps/api && npx vitest run <path>`. Never `pnpm --filter … test -- --run`.
  - Integration: `pnpm test-stack up` once, then `cd apps/api && npx vitest run --config vitest.integration.config.ts <path>`. Run `pnpm test-stack down` at the end.
  - RLS coverage: `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`.
  - Typecheck: `cd apps/api && npx tsc --noEmit -p tsconfig.json`, `cd apps/web && npx tsc --noEmit`, `cd packages/shared && npx tsc --noEmit`.
- **Commits.** One per task, conventional message, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Call `start_wave` (feature-lifecycle) before Task 1.

## Review Focus

The riskiest behaviours, most likely first. Each is pinned by the named test in the named task.

1. **A failover silently moves spend between Breeze credits and the partner's key.** Cases: a BYOK primary fails and the only fallback is a platform model, with crossing off; or an org turned crossing off while the partner turned it on. Expected: no hop, a recoverable failure, no reservation for the would-be hop. Pinned by:
   - Task 5 unit: "skips a cross-funding fallback when crossing is off (F1)" and "a stored choice that no longer exists: funding unknown counts as crossing…";
   - Task 4 unit: "…while the org default row still narrows the role" (org `false` beats partner `true`), plus W02's existing cross-funding merge table;
   - Task 5 integration: "cross-funding: off → unavailable; partner on → served; an org override OFF beats partner ON";
   - Task 7 integration: "BYOK→platform with crossing off: no platform reservation, no deduct, FailoverExhaustedError";
   - Task 12 unit: "422 crosses_funding: a BYOK fallback for a platform default with crossing off".
2. **Double-debit.**
   - A platform primary returns 529 and a platform fallback serves. The failed hop must not debit, and the served hop must debit exactly once.
   - A retried settlement, or a re-driven agent run, must not debit or reserve a second time.

   Pinned by:
   - Task 7 integration: "platform→platform: zero-cost failed hop never debits; the served hop debits once under its own key at ITS rate" and "re-settling the served hop (a retried settle) debits nothing more";
   - Task 11 integration: "a re-drive reserves the SAME hop reservation, and settling it twice debits once";
   - Task 11 unit: "a re-driven run resumes on its persisted hop key and offering".
3. **No-debit.** A BYOK primary returns 429 and a platform fallback serves. The settlement must debit the platform hop. It must never settle the platform hop's tokens under the BYOK binding or reservation, where the debit would be skipped. Pinned by:
   - Task 7 integration: "BYOK→platform with crossing on: the platform hop debits its registry cost; the BYOK hop debits nothing"; "the served hop's rows can never be settled on the failed hop's reservation"; "the ledger rejects a row naming the served platform offering with partner_key funding (23514)";
   - Task 6 unit: "toNewInvocations writes the SERVED hop's offering, connection and funding…".
4. **A stale rate, or a hop that went ineligible.**
   - The fallback is priced differently from the primary.
   - The fallback was disabled, or its connection went into error, between the first resolution and the failover.

   The hop must bill its own rate and must be skipped when ineligible. Pinned by:
   - Task 7 integration: "platform→platform: … at ITS rate" (asserts P2's price, not P's) and "a fallback disabled after the first resolution is skipped at failover time (F2)";
   - Task 5 unit: "re-resolution skips a fallback disabled since the first resolution (F2)";
   - Task 5 integration: "a fallback whose connection went into error is skipped".
5. **A failover after side effects.** An agent run executed a tool (or streamed text) and then got a 529. It must not re-run on another model, because tools would execute twice. A Messages API call whose first attempt returned a message must not fail over either. Pinned by:
   - Task 11 unit: "a tool executed before the failure → no failover, the hop settles normally";
   - Task 8 unit: "attempt 2 failing after attempt 1 returned a message never fails over…";
   - Task 7 unit: "after output (isPreOutput false): never fails over";
   - Task 9 unit: "a turn that streamed text before failing does not cool anything".
6. **Escalation silently collapsing.** An org overrides the `ai_agents` default. Triage runs must still use the partner's triage default, while staying inside the org's permitted set. Pinned by Task 4 unit "the partner triage default survives an org DEFAULT override" and Task 5 integration "a triage run resolves the partner triage default under an org ai_agents default override (D2)".
7. **A session with history crossing connections** (lossy resume, residency). Pinned by Task 9 unit "turnCount 3 on agent_sdk → sameConnectionOnly true" and Task 5 unit "sameConnectionOnly passes over a fallback on another connection (D5)".

---

## File Structure

**Create**

| Path | Responsibility |
|---|---|
| `apps/api/migrations/2026-11-25-100000-ai-model-registry-failover.sql` | Ledger failover provenance columns + CHECK; provenance guard covers `failover_from_offering_id`; `ai_agent_runs` served columns; assignment fallback-shape CHECK |
| `apps/api/src/services/aiModels/failover.ts` (+ `.test.ts`) | Pure: `FAILOVER_CAUSES`, `FailoverCause`, `ProviderFailureCause`, `classifyProviderStatus`, `classifyProviderError` (Messages API), `classifySdkAssistantError`, `COOLDOWN_TTL_MS`, `hopIdempotencyKey`, `MAX_FAILOVER_HOP`, `SDK_RETRIES_BEFORE_FAILOVER` |
| `apps/api/src/services/aiModels/offeringHealth.ts` (+ `.test.ts`) | Redis cooldown: `markOfferingCooldown`, `coolingOfferings`, `clearOfferingCooldowns`, `noteProviderFailure` |
| `apps/api/src/services/aiModels/failoverDispatch.ts` (+ `.test.ts`) | `runWithFailover`, `FailoverHop`, `HopReservation`, `FailoverExhaustedError`, `reserveFailoverHop`, `settleZeroUsageHop`, `isPreOutputMessagesFailure` |
| `apps/api/src/services/aiAgents/agentModelRole.ts` (+ `.test.ts`) | `AGENT_PROFILE_ROLE`, `ACT_MODE_REMEDIATION_PROFILES`, `agentRunModelRole` |
| `apps/api/src/__tests__/integration/aiModelFailover.integration.test.ts` | Resolution walk + escalation against real rows |
| `apps/api/src/__tests__/integration/aiModelFailoverFunding.integration.test.ts` | Funding pins: double-debit, no-debit, re-bind, cross-funding, forgery, replay |
| `apps/api/src/__tests__/integration/helpers/aiModelFailoverSeed.ts` | `seedFailoverPartner()`: one partner with a platform offering **and** a BYOK offering at different prices, assignments, a reviewer proposal fixture |

**Modify**

| Path | Task | Change |
|---|---|---|
| `packages/shared/src/constants/aiSurfaces.ts` | 1 | `AI_AGENT_ESCALATION_ROLES`, `AiAgentEscalationRole`, `MAX_FALLBACK_OFFERINGS` |
| `packages/shared/src/validators/aiModelRegistryApi.ts` (+ test) | 1 | `CONFIGURABLE_AI_SURFACE_ROLES`; role enum widened per surface; fallback fields; role-row clear; max rows |
| `packages/shared/src/types/aiModelRegistry.ts` | 1 | DTO `role`, fallback fields, `failovers` |
| `apps/api/src/db/schema/aiInvocations.ts`, `aiAgents.ts` | 2 | New columns |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | 2 | Six column classifications |
| `apps/api/src/services/aiModels/assignments.ts` (+ test) | 4 | `selectRoleRows` (D2), used by `getEffectiveAssignment` |
| `apps/api/src/services/aiModels/resolveModel.ts` (+ test) | 5 | Walk, cooldown, `excludeOfferingIds`, `failoverCause`, `sameConnectionOnly`, `failover`, `failoverRemaining` |
| `apps/api/src/services/aiModels/__fixtures__/resolvedModel.ts` | 5 | `failover: null`, `failoverRemaining: []` defaults |
| `apps/api/src/services/aiModels/turnBinding.ts` (+ test) | 6 | `failover` on the binding |
| `apps/api/src/services/aiModels/settleInvocation.ts` (+ test), `invocationLedgerWrite.ts` | 6 | Ledger provenance columns |
| `apps/api/src/services/aiBudgetReservations.ts` (+ test) | 6 | `stampSessionBinding` skips transient failover (D6) |
| `apps/api/src/services/aiModels/connectionFactory.ts` (+ test) | 7 | `MessageDispatchError`, `attemptsOf`: a burned attempt survives a later throw in the same dispatch (Codex review 3) |
| `apps/api/src/services/scriptProposals/reviewer.ts` (+ test) | 7 | `runWithFailover` |
| `apps/api/src/routes/officeAddin/tickets.ts`, `services/officeAddin/aiEmailDraft.ts`, `routes/ai.ts` (ticket-draft handler; its reservations become sessionless), `services/aiTicketDraft.ts`, `services/extensionAi.ts` (+ tests) | 7, 8 | `runWithFailover`; drafts keep `attemptsOf(err)` |
| `apps/api/src/services/aiModels/invocationUsage.ts` (+ test) | 9 | `SdkTurnObservation.providerFailure`, `.sawOutput` |
| `apps/api/src/services/streamingSessionManager.ts` (+ `.modelBinding.test.ts`) | 9 | Cooldown on a pre-output provider failure |
| `apps/api/src/services/aiModels/sessionModel.ts`, `candidateLoader.ts` (+ tests) | 9 | `sameConnectionOnly` for sessions with history |
| `apps/api/src/services/aiAgents/runService.ts`, `runLoop.ts` (+ tests) | 10, 11 | Role on resolve; dispatch failover loop; served columns; re-drive resume |
| `apps/api/src/services/aiModels/assignmentWrites.ts`, `registryView.ts`, `usageQueries.ts` (+ tests), `routes/aiModels/connections.ts` (key rotate) | 12 | Roles + fallbacks writes; DTOs; `failovers` count; cooldown cleared on rotate |
| `apps/api/src/__tests__/integration/aiModelsRoutes.integration.test.ts` | 12 | Role rows + fallback writes against real rows |
| `apps/web/src/components/settings/aiModels/FeatureDefaultsCard.tsx`, `OrgModelDefaultsCard.tsx`, `AiUsageBreakdown.tsx`, `surfaceLabels.ts` (+ tests), `apps/web/src/locales/*/settings.json` | 13 | Role sub-rows, fallback editor, cross-funding switch, failovers column |
| `apps/docs/src/content/docs/features/ai.mdx` | 14 | "Failover and escalation roles" section |
| `docs/superpowers/plans/ai-mcp/2026-09-30-ai-model-registry-index.md` | 14 | W09 row → implemented |

### File ownership vs. other waves

| Wave | Shared files / extension points | Collision rule |
|---|---|---|
| W03 (#7601, merged base) | `connectionFactory.ts` `createMessage` (one wrapped `catch` in the client-side refusal branch), `resolveModel.ts` (W09 inserts the walk **after** W03's fast path and **inside** W03's `tryDefault`; never edits W03's eligibility order), `turnBinding.ts` (adds one optional field; `v` stays 1), `settleInvocation.ts` `toNewInvocations` (three new fields), `aiBudgetReservations.ts` `stampSessionBinding` (one guard), `invocationUsage.ts` `observeSdkMessage` (new branches), `runLoop.ts` dispatch block, `reviewer.ts`, Office/ticket draft | Rebase onto merged W03. A W03 follow-up that touches the same block wins, and W09 re-applies on top. |
| W04 (#7602, merged base) | `partnerAssignmentInputSchema` / `orgAssignmentInputSchema` (`role` enum widens, fallback fields added; W04 already strips them), `assignmentWrites.ts` `conditionalUpsert` values (fallback columns written **only** when present in the payload), `registryView.ts` defaults loop (per `(surface, role)`), `usageQueries.ts` `AGGREGATES` (+1 column), `FeatureDefaultsCard` (role sub-rows + fallback editor at W04's `// W09 (#7607)` comment), `OrgModelDefaultsCard` (role rows + narrowing), `AiUsageBreakdown` (+1 column) | Additive arms only. W04's tests stay; the two "W09 widens this" tests are rewritten in Task 1 / Task 13. |
| W05 (#7603) | `sessionModel.ts` `resolveSessionTurn` (W09 adds `sameConnectionOnly`); `streamingSessionManager.ts` result handler (W09 adds one cooldown call); W05's continuation will relax D5 | W05 owns switching. When W05 lands continuation, it may drop `sameConnectionOnly` in favour of a continuation hop. W09 leaves a comment naming W05. |
| W06 / W07 (#7604 / #7605) | `failover.ts` classifier (W06/W07 add arms for their providers' error shapes), `eligibility.ts` `DISPATCHABLE_KINDS` (theirs) | W06/W07 add classifier arms, never change F1–F6. |
| W08 (#7606) | none | — |
| W10 (#7608) | `ai_invocations` columns (`chargeable` is W10's; W09's three failover columns are provenance), `settleInvocation.toNewInvocations` (W10 sets `chargeable`) | Different fields of the same object literal. |
| W11 (#7609) | `usageQueries.ts` (`failovers` column), quality view reads `failover_hop` | Additive. |

---

## Task 1: Shared contract — escalation roles, fallback fields, DTOs

**Files:**
- Modify: `packages/shared/src/constants/aiSurfaces.ts`
- Modify: `packages/shared/src/validators/aiModelRegistryApi.ts` (W04)
- Modify: `packages/shared/src/validators/aiModelRegistryApi.test.ts` (W04; rewrite its two "W09 widens this" cases)
- Modify: `packages/shared/src/types/aiModelRegistry.ts` (W04)

**Interfaces:**
- Consumes: W04's `CONFIGURABLE_AI_SURFACES`, `partnerAssignmentInputSchema`, `orgAssignmentInputSchema` (P20); `AI_SURFACE_ROLES`.
- Produces:

```ts
// constants/aiSurfaces.ts
export const AI_AGENT_ESCALATION_ROLES = ['triage', 'analysis', 'remediation'] as const;
export type AiAgentEscalationRole = (typeof AI_AGENT_ESCALATION_ROLES)[number];
export const MAX_FALLBACK_OFFERINGS = 5;
// validators/aiModelRegistryApi.ts
export const CONFIGURABLE_AI_SURFACE_ROLES: ReadonlyArray<{ surface: AiSurface; role: string }>;
// PartnerAssignmentInput gains: defaultOfferingId: string | null (null only on a role row = clear it),
//   fallbackOfferingIds?: string[] | null, fallbackMayCrossFunding?: boolean
// OrgAssignmentInput gains: fallbackOfferingIds?: string[] | null, fallbackMayCrossFunding?: false | null
// types: AiAssignmentRowDto.{fallbackOfferingIds, fallbackMayCrossFunding}; AiSurfaceDefaultsDto.role;
//   AiOrgSurfaceDefaultsDto.{role, inherited.fallback*, effective.fallback*}; AiUsageRowDto.failovers
```

- [ ] **Step 1: Write the failing tests**

In `aiModelRegistryApi.test.ts`, **delete** W04's cases `'rejects role other than default (W09 widens this)'` and `'never carries fallback fields (W09)'`, then add:

```ts
import { AI_AGENT_ESCALATION_ROLES, MAX_FALLBACK_OFFERINGS } from '../constants/aiSurfaces';
import {
  CONFIGURABLE_AI_SURFACE_ROLES,
  orgAssignmentInputSchema,
  partnerAssignmentInputSchema,
  partnerAssignmentsPutSchema,
} from './aiModelRegistryApi';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const partnerRow = (over: Record<string, unknown> = {}) => ({
  surface: 'ai_agents', role: 'default', defaultOfferingId: A, permittedOfferingIds: null,
  allowUserChoice: true, options: null, expectedUpdatedAt: null, ...over,
});

describe('W09 escalation roles', () => {
  it('lists every configurable (surface, role) pair, ai_agents with its three stages', () => {
    const agentRoles = CONFIGURABLE_AI_SURFACE_ROLES.filter((p) => p.surface === 'ai_agents').map((p) => p.role);
    expect(agentRoles).toEqual(['default', ...AI_AGENT_ESCALATION_ROLES]);
    expect(CONFIGURABLE_AI_SURFACE_ROLES.some((p) => p.surface === 'patch_test')).toBe(false);
  });

  it.each(AI_AGENT_ESCALATION_ROLES)('accepts role %s on ai_agents', (role) => {
    expect(partnerAssignmentInputSchema.safeParse(partnerRow({ role })).success).toBe(true);
  });

  it('rejects an escalation role on a surface that has none', () => {
    const r = partnerAssignmentInputSchema.safeParse(partnerRow({ surface: 'chat', role: 'triage' }));
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.path).toEqual(['role']);
  });

  it('a role row may clear its default (inherit the feature default) only when the whole row is blank', () => {
    expect(partnerAssignmentInputSchema.safeParse(partnerRow({ role: 'triage', defaultOfferingId: null })).success).toBe(true);
    expect(partnerAssignmentInputSchema.safeParse(partnerRow({ role: 'triage', defaultOfferingId: null, permittedOfferingIds: [A] })).success).toBe(false);
    expect(partnerAssignmentInputSchema.safeParse(partnerRow({ role: 'default', defaultOfferingId: null })).success).toBe(false);
  });

  it('accepts one partner row per (surface, role), including all four ai_agents rows', () => {
    const rows = ['default', ...AI_AGENT_ESCALATION_ROLES].map((role) => partnerRow({ role }));
    expect(partnerAssignmentsPutSchema.safeParse({ assignments: rows }).success).toBe(true);
    expect(partnerAssignmentsPutSchema.safeParse({ assignments: [partnerRow(), partnerRow()] }).success).toBe(false);
  });
});

describe('W09 fallback list', () => {
  it('carries an ordered fallback list and the cross-funding switch', () => {
    const parsed = partnerAssignmentInputSchema.parse(partnerRow({ fallbackOfferingIds: [C, B], fallbackMayCrossFunding: true }));
    expect(parsed.fallbackOfferingIds).toEqual([C, B]);
    expect(parsed.fallbackMayCrossFunding).toBe(true);
  });

  it('omitted fallback fields stay undefined (the write preserves the stored list)', () => {
    const parsed = partnerAssignmentInputSchema.parse(partnerRow());
    expect(parsed.fallbackOfferingIds).toBeUndefined();
    expect(parsed.fallbackMayCrossFunding).toBeUndefined();
  });

  it.each([
    ['a duplicate', [B, B]],
    ['the default itself', [B, A]],
    ['more than the cap', Array.from({ length: MAX_FALLBACK_OFFERINGS + 1 }, (_, i) => `4444444${i}-4444-4444-8444-444444444444`)],
  ])('rejects %s', (_l, ids) => {
    expect(partnerAssignmentInputSchema.safeParse(partnerRow({ fallbackOfferingIds: ids })).success).toBe(false);
  });

  it('an org may only switch cross-funding OFF or inherit it', () => {
    const org = { surface: 'chat', role: 'default', defaultOfferingId: null, permittedOfferingIds: null, allowUserChoice: null, options: null, expectedUpdatedAt: null };
    expect(orgAssignmentInputSchema.safeParse({ ...org, fallbackMayCrossFunding: false }).success).toBe(true);
    expect(orgAssignmentInputSchema.safeParse({ ...org, fallbackMayCrossFunding: null }).success).toBe(true);
    expect(orgAssignmentInputSchema.safeParse({ ...org, fallbackMayCrossFunding: true }).success).toBe(false);
    expect(orgAssignmentInputSchema.safeParse({ ...org, fallbackOfferingIds: [B] }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/shared && npx vitest run src/validators/aiModelRegistryApi.test.ts`
Expected: FAIL. `CONFIGURABLE_AI_SURFACE_ROLES` and `AI_AGENT_ESCALATION_ROLES` are undefined, and the role cases fail on `z.enum(['default'])`.

- [ ] **Step 3: Write the implementation**

Append to `packages/shared/src/constants/aiSurfaces.ts`:

```ts
/** W09 (#7607): the escalation stages an `ai_agents` run resolves (#7570). Mirrors AI_SURFACE_ROLES.ai_agents minus 'default'. */
export const AI_AGENT_ESCALATION_ROLES = ['triage', 'analysis', 'remediation'] as const;
export type AiAgentEscalationRole = (typeof AI_AGENT_ESCALATION_ROLES)[number];

/** W09: the longest ordered failover list on one assignment row (the DB CHECK mirrors it). */
export const MAX_FALLBACK_OFFERINGS = 5;
```

In `aiModelRegistryApi.ts`:
1. Extend the import from `../constants/aiSurfaces` with `AI_AGENT_ESCALATION_ROLES`, `AI_SURFACE_ROLES` and `MAX_FALLBACK_OFFERINGS`.
2. Replace W04's `assignmentRole`, `partnerAssignmentInputSchema`, `partnerAssignmentsPutSchema`, `orgAssignmentInputSchema` and `orgAssignmentsPutSchema` with:

```ts
/** Every configurable (surface, role) pair, in surface order then role order. */
export const CONFIGURABLE_AI_SURFACE_ROLES: ReadonlyArray<{ surface: AiSurface; role: string }> =
  CONFIGURABLE_AI_SURFACES.flatMap((surface) => AI_SURFACE_ROLES[surface].map((role) => ({ surface, role })));

/** W09 (#7607): `default` on every surface; ai_agents also has the escalation stages. Checked per surface below. */
const assignmentRole = z.enum(['default', ...AI_AGENT_ESCALATION_ROLES]);

const fallbackIds = z.array(uuid).max(MAX_FALLBACK_OFFERINGS)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'Duplicate model in the fallback list.' });

function roleBelongsToSurface(row: { surface: AiSurface; role: string }, ctx: z.RefinementCtx): void {
  if (!(AI_SURFACE_ROLES[row.surface] as readonly string[]).includes(row.role)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['role'], message: 'That feature has no such role.' });
  }
}

export const partnerAssignmentInputSchema = z.object({
  surface: configurableSurface,
  role: assignmentRole,
  /** null only on a role row (role ≠ 'default'): clears it, so the role inherits the feature default. */
  defaultOfferingId: uuid.nullable(),
  /** null = every enabled model. */
  permittedOfferingIds: permittedIds.nullable(),
  allowUserChoice: z.boolean(),
  options: offeringOptionsSchema.nullable(),
  /** W09: ordered failover list. Omitted = keep the stored list; null or [] = no failover. */
  fallbackOfferingIds: fallbackIds.nullable().optional(),
  /** W09: may failover move between Breeze credits and the partner's own key. Omitted = keep the stored value. */
  fallbackMayCrossFunding: z.boolean().optional(),
  /** The row's updatedAt as read; null when no partner row existed. */
  expectedUpdatedAt: z.string().datetime().nullable(),
}).superRefine((row, ctx) => {
  roleBelongsToSurface(row, ctx);
  if (row.defaultOfferingId === null) {
    if (row.role === 'default') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['defaultOfferingId'], message: 'Choose a default model.' });
    } else if (row.permittedOfferingIds !== null || row.options !== null || (row.fallbackOfferingIds ?? null) !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['defaultOfferingId'], message: 'Clear the whole role row to inherit the feature default.' });
    }
  }
  if (row.defaultOfferingId && row.fallbackOfferingIds?.includes(row.defaultOfferingId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['fallbackOfferingIds'], message: 'A model cannot be its own fallback.' });
  }
});
export type PartnerAssignmentInput = z.infer<typeof partnerAssignmentInputSchema>;

function uniqueSurfaceRole(rows: Array<{ surface: string; role: string }>): boolean {
  return new Set(rows.map((r) => `${r.surface}/${r.role}`)).size === rows.length;
}

export const partnerAssignmentsPutSchema = z.object({
  assignments: z.array(partnerAssignmentInputSchema).min(1).max(CONFIGURABLE_AI_SURFACE_ROLES.length)
    .refine(uniqueSurfaceRole, { message: 'Each feature role may appear once.' }),
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
  /** W09: null/omitted = inherit the partner list; a list narrows it (each id must be partner-permitted). */
  fallbackOfferingIds: fallbackIds.nullable().optional(),
  /** W09: an org can only switch cross-funding failover OFF (false) or inherit (null). */
  fallbackMayCrossFunding: z.literal(false).nullable().optional(),
  expectedUpdatedAt: z.string().datetime().nullable(),
}).superRefine((row, ctx) => roleBelongsToSurface(row, ctx));
export type OrgAssignmentInput = z.infer<typeof orgAssignmentInputSchema>;

export const orgAssignmentsPutSchema = z.object({
  assignments: z.array(orgAssignmentInputSchema).min(1).max(CONFIGURABLE_AI_SURFACE_ROLES.length)
    .refine(uniqueSurfaceRole, { message: 'Each feature role may appear once.' }),
}).strict();
```

In the file's header comment, replace the two W09 bullets with `- assignment role/fallback fields: widened by W09 (#7607).`

In `packages/shared/src/types/aiModelRegistry.ts`:

```ts
export interface AiAssignmentRowDto {
  surface: AiSurface;
  role: string;
  defaultOfferingId: string | null;
  permittedOfferingIds: string[] | null;
  allowUserChoice: boolean | null;
  options: OfferingOptions | null;
  /** W09: ordered failover list (null = none on this row). */
  fallbackOfferingIds: string[] | null;
  /** W09: null on an org row = inherit. */
  fallbackMayCrossFunding: boolean | null;
  updatedAt: string | null;
}

export interface AiSurfaceDefaultsDto {
  surface: AiSurface;
  /** W09: one entry per (surface, role); `default` first. */
  role: string;
  requiresTools: boolean;
  partner: AiAssignmentRowDto | null;
  /** Count of org overrides for this (surface, role). */
  orgOverrideCount: number;
}

export interface AiOrgSurfaceDefaultsDto {
  surface: AiSurface;
  role: string;
  requiresTools: boolean;
  /** The partner row's values = what an all-blank org row inherits. */
  inherited: {
    defaultOfferingId: string | null; permittedOfferingIds: string[] | null; allowUserChoice: boolean; options: OfferingOptions;
    fallbackOfferingIds: string[]; fallbackMayCrossFunding: boolean;
  };
  org: AiAssignmentRowDto | null;
  effective: {
    defaultOfferingId: string | null; defaultSource: 'org' | 'partner' | 'none'; permittedOfferingIds: string[] | null;
    allowUserChoice: boolean; options: OfferingOptions; fallbackOfferingIds: string[]; fallbackMayCrossFunding: boolean;
  };
}
```

`AiUsageRowDto` gains `/** W09: rows served by a failover hop (failover_hop > 0). */ failovers: number;`.

If W04's API or web code reads `partnerAssignmentInputSchema.shape`, a `.superRefine` breaks that: the object becomes a `ZodEffects`. In that case export the inner object as `partnerAssignmentObjectSchema` and keep `.shape` callers on it. `tsc` in Step 4 finds every such caller.

- [ ] **Step 4: Run tests and typecheck**

Run: `cd packages/shared && npx vitest run src/validators/aiModelRegistryApi.test.ts && npx tsc --noEmit`
Expected: PASS; tsc exits 0.
Then run `cd apps/api && npx tsc --noEmit -p tsconfig.json` and `cd apps/web && npx tsc --noEmit`.
Expected: errors **only** where W04 builds the four DTOs. Those are `registryView.ts`, `usageQueries.ts` `toUsageRow`, `FeatureDefaultsCard.tsx` `toInput` and `OrgModelDefaultsCard.tsx`, and Tasks 12–13 fix them. To keep this commit green, add the new DTO fields there as `fallbackOfferingIds: null, fallbackMayCrossFunding: null` / `role: 'default'` / `failovers: 0` stubs; Tasks 12–13 replace the stubs.

- [ ] **Step 5: Commit**

Stage `packages/shared`, plus the stubbed `apps/api/src/services/aiModels/registryView.ts`, `usageQueries.ts` and `apps/web/src/components/settings/aiModels/*`. Commit message: `feat(shared): escalation roles and fallback lists in the /ai/models contract (#7607)`, ending with the Co-Authored-By trailer.

---

## Task 2: Migration — failover provenance on the ledger and agent runs; fallback-shape CHECK

**Files:**
- Create: `apps/api/migrations/2026-11-25-100000-ai-model-registry-failover.sql`
- Modify: `apps/api/src/db/schema/aiInvocations.ts`, `apps/api/src/db/schema/aiAgents.ts`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts`
- Create: `apps/api/src/__tests__/integration/aiModelFailover.integration.test.ts` (schema cases; Task 5 appends)

**Interfaces:**
- Consumes: W02's `ai_invocations` / `ai_invocations_provenance_guard`, `ai_model_assignments`; W03's `ai_agent_runs.funding_source` / `admitted_offering_id`.
- Produces:
  - DB columns `ai_invocations.failover_from_offering_id uuid NULL`, `.failover_hop smallint NOT NULL DEFAULT 0`, `.failover_cause text NULL` (CHECK `ai_invocations_failover_chk`);
  - DB columns `ai_agent_runs.served_offering_id uuid NULL`, `.served_funding_source text NULL`, `.served_failover_hop smallint NULL`, `.served_failover_cause text NULL` (CHECK `ai_agent_runs_served_chk`);
  - CHECK `ai_model_assignments_fallback_shape_chk`;
  - Drizzle `aiInvocations.{failoverFromOfferingId, failoverHop, failoverCause}`, `aiAgentRuns.{servedOfferingId, servedFundingSource, servedFailoverHop, servedFailoverCause}`.

- [ ] **Step 1: Write the failing integration test**

`apps/api/src/__tests__/integration/aiModelFailover.integration.test.ts`:

```ts
/**
 * AI model registry W09 (#7607): failover + escalation against real Postgres.
 * Schema cases (Task 2) and resolution cases (Task 5).
 */
import './setup';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeRegistryFixtures, fixtureSql, seedOffering } from './aiModelRegistryFixtures';
import { seedPricedPlatformModel, seedRegistryPartner, type SeededRegistryPartner } from './helpers/aiModelRegistrySeed';

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);

async function sqlState(p: Promise<unknown>): Promise<string | null> {
  try { await p; return null; } catch (e) { return (e as { code?: string }).code ?? 'unknown'; }
}

function ledgerInsert(s: SeededRegistryPartner, over: { hop: number; cause: string | null; from: string | null }) {
  return fixtureSql`
    INSERT INTO ai_invocations (org_id, surface, role, offering_id, funding_source, requested_model, served_model,
                                ledger_mode, failover_from_offering_id, failover_hop, failover_cause)
    VALUES (${s.orgId}, 'chat', 'default', ${s.offeringId}, 'platform', ${s.modelId}, ${s.modelId},
            'authoritative', ${over.from}, ${over.hop}, ${over.cause})`;
}

describe.runIf(RUN)('W09 schema: failover provenance', () => {
  let s: SeededRegistryPartner;
  let other: SeededRegistryPartner;
  beforeEach(async () => {
    s = await seedRegistryPartner('platform');
    other = await seedRegistryPartner('platform');
  });

  it('accepts a hop row whose source is an offering of the same partner', async () => {
    const from = await seedOffering({ partnerId: s.partnerId, platformModelId: await seedPricedPlatformModel(), enabled: true });
    expect(await sqlState(ledgerInsert(s, { hop: 1, cause: 'overloaded', from }))).toBeNull();
  });

  it('rejects a failover source owned by another partner (23503)', async () => {
    expect(await sqlState(ledgerInsert(s, { hop: 1, cause: 'overloaded', from: other.offeringId }))).toBe('23503');
  });

  it.each([
    ['hop 0 with a cause', { hop: 0, cause: 'overloaded', from: null }],
    ['hop 1 without a cause', { hop: 1, cause: null, from: null }],
    ['an unknown cause', { hop: 1, cause: 'flaky', from: null }],
    ['hop 7', { hop: 7, cause: 'overloaded', from: null }],
  ] as const)('rejects %s (23514)', async (_l, over) => {
    expect(await sqlState(ledgerInsert(s, over))).toBe('23514');
  });

  it('accepts hop > 0 with no source (the stored choice no longer exists)', async () => {
    expect(await sqlState(ledgerInsert(s, { hop: 1, cause: 'ineligible', from: null }))).toBeNull();
  });

  it('an assignment cannot list its own default as a fallback, nor more than five (23514)', async () => {
    const extra = await Promise.all(Array.from({ length: 6 }, async () =>
      seedOffering({ partnerId: s.partnerId, platformModelId: await seedPricedPlatformModel(), enabled: true })));
    expect(await sqlState(fixtureSql`
      UPDATE ai_model_assignments SET fallback_offering_ids = ARRAY[${s.offeringId}]::uuid[]
       WHERE partner_id = ${s.partnerId} AND surface = 'chat'`)).toBe('23514');
    expect(await sqlState(fixtureSql`
      UPDATE ai_model_assignments SET fallback_offering_ids = ${extra}::uuid[]
       WHERE partner_id = ${s.partnerId} AND surface = 'chat'`)).toBe('23514');
    expect(await sqlState(fixtureSql`
      UPDATE ai_model_assignments SET fallback_offering_ids = ${extra.slice(0, 5)}::uuid[]
       WHERE partner_id = ${s.partnerId} AND surface = 'chat'`)).toBeNull();
  });

  it('an agent run records the served offering, funding and hop together or not at all (23514)', async () => {
    const [agent] = await fixtureSql`
      INSERT INTO ai_agents (org_id, kind, name, created_by) VALUES (${s.orgId}, 'triage', 'w09', ${s.userId}) RETURNING id`;
    const insertRun = (served: { id: string | null; funding: string | null; hop: number | null }) => fixtureSql`
      INSERT INTO ai_agent_runs (agent_id, org_id, status, trigger_kind, served_offering_id, served_funding_source, served_failover_hop, served_failover_cause)
      VALUES (${agent!.id}, ${s.orgId}, 'queued', 'manual', ${served.id}, ${served.funding}, ${served.hop}, ${served.hop ? 'overloaded' : null})`;
    expect(await sqlState(insertRun({ id: s.offeringId, funding: 'platform', hop: 1 }))).toBeNull();
    expect(await sqlState(insertRun({ id: s.offeringId, funding: null, hop: 1 }))).toBe('23514');
    expect(await sqlState(insertRun({ id: s.offeringId, funding: 'platform', hop: 0 }))).toBe('23514');
  });
});
```

`ai_agent_runs` has more NOT NULL columns than the insert above (for example `profile` and `mode_at_start`, depending on W03's head). Before running, copy the column list from the nearest existing integration insert of an `ai_agent_runs` row (`grep -rn "INSERT INTO ai_agent_runs" apps/api/src/__tests__/integration | head -3`) and keep only the three `served_*` values as the variables under test.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test-stack up` (once), then `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiModelFailover.integration.test.ts`
Expected: FAIL with `column "failover_from_offering_id" of relation "ai_invocations" does not exist`.

- [ ] **Step 3: Write the migration**

`apps/api/migrations/2026-11-25-100000-ai-model-registry-failover.sql`:

```sql
-- AI model registry W09 (#7607): failover provenance.
--
-- ai_invocations (append-only ledger, W02):
--   failover_from_offering_id  the offering the call was routed to BEFORE
--                              failover (NULL when hop = 0, and when the
--                              stored choice no longer exists). Provenance id,
--                              no FK (W02 precedent: an FK's ON DELETE would
--                              be an UPDATE the append-only trigger rejects);
--                              ownership is enforced at INSERT by the
--                              provenance guard below, fail-closed.
--   failover_hop               candidates passed over before the one that
--                              served (0 = no failover; <= 6).
--   failover_cause             why the first candidate was passed over.
-- The row's own offering_id / connection_id / funding_source stay the SERVED
-- offering's (the guard already rejects a funding that disagrees with it), so
-- a failover can never be settled against the requested offering.
--
-- ai_agent_runs: served_offering_id / served_funding_source /
-- served_failover_hop / served_failover_cause record the hop that served the run's model tokens when
-- it was not the admitted offering. funding_source keeps the ADMITTED funding,
-- which still funds sandbox compute (W09 D7). A re-driven run resumes on
-- served_failover_hop's reservation key, so a hop is never reserved twice.
--
-- ai_model_assignments: a row's fallback list holds at most 5 offerings and
-- never its own default (W09 D10).
--
-- Export policy: all seven new columns are `included` (identifiers, a counter,
-- enums), registered in tenantExportPolicyRegistry.ts in the same commit.
-- DDL only: writes no rows, so no system-scope election. Idempotent. CHECKs
-- are added NOT VALID then validated, so the ledger table is not held under
-- ACCESS EXCLUSIVE for a full scan.

ALTER TABLE public.ai_invocations ADD COLUMN IF NOT EXISTS failover_from_offering_id uuid;
ALTER TABLE public.ai_invocations ADD COLUMN IF NOT EXISTS failover_hop smallint NOT NULL DEFAULT 0;
ALTER TABLE public.ai_invocations ADD COLUMN IF NOT EXISTS failover_cause text;

ALTER TABLE public.ai_invocations DROP CONSTRAINT IF EXISTS ai_invocations_failover_chk;
ALTER TABLE public.ai_invocations ADD CONSTRAINT ai_invocations_failover_chk CHECK (
  failover_hop BETWEEN 0 AND 6
  AND ((failover_hop = 0) = (failover_cause IS NULL))
  AND (failover_hop > 0 OR failover_from_offering_id IS NULL)
  AND (failover_cause IS NULL OR failover_cause IN
       ('ineligible', 'cooldown', 'rate_limited', 'overloaded', 'server_error', 'auth_failed', 'quota_exhausted'))
) NOT VALID;
ALTER TABLE public.ai_invocations VALIDATE CONSTRAINT ai_invocations_failover_chk;

CREATE OR REPLACE FUNCTION public.ai_invocations_provenance_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  org_partner uuid;
  off_partner uuid;
  off_connection uuid;
  off_found boolean := false;
BEGIN
  SELECT o.partner_id INTO org_partner FROM public.organizations AS o WHERE o.id = NEW.org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ai_invocations.org_id % is not a visible organization', NEW.org_id USING ERRCODE = '23503';
  END IF;

  IF NEW.session_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.ai_sessions AS s WHERE s.id = NEW.session_id AND s.org_id = NEW.org_id
  ) THEN
    RAISE EXCEPTION 'session % does not belong to org %', NEW.session_id, NEW.org_id USING ERRCODE = '23503';
  END IF;

  IF NEW.agent_run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.ai_agent_runs AS r WHERE r.id = NEW.agent_run_id AND r.org_id = NEW.org_id
  ) THEN
    RAISE EXCEPTION 'agent run % does not belong to org %', NEW.agent_run_id, NEW.org_id USING ERRCODE = '23503';
  END IF;

  IF NEW.offering_id IS NOT NULL THEN
    SELECT true, m.partner_id, m.connection_id INTO off_found, off_partner, off_connection
      FROM public.partner_ai_models AS m WHERE m.id = NEW.offering_id;
    IF NOT FOUND OR off_partner IS DISTINCT FROM org_partner THEN
      RAISE EXCEPTION 'offering % is not an offering of org %''s partner', NEW.offering_id, NEW.org_id USING ERRCODE = '23503';
    END IF;
    IF (off_connection IS NULL) <> (NEW.funding_source = 'platform') THEN
      RAISE EXCEPTION 'funding_source % does not match offering %', NEW.funding_source, NEW.offering_id USING ERRCODE = '23514';
    END IF;
    IF NEW.connection_id IS DISTINCT FROM off_connection THEN
      RAISE EXCEPTION 'connection_id must be the offering''s connection' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.connection_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.partner_ai_connections AS c WHERE c.id = NEW.connection_id AND c.partner_id = org_partner
  ) THEN
    RAISE EXCEPTION 'connection % is not a connection of org %''s partner', NEW.connection_id, NEW.org_id USING ERRCODE = '23503';
  END IF;

  -- W09: the failover source is an offering of the same partner.
  IF NEW.failover_from_offering_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.partner_ai_models AS f
     WHERE f.id = NEW.failover_from_offering_id AND f.partner_id = org_partner
  ) THEN
    RAISE EXCEPTION 'failover source % is not an offering of org %''s partner', NEW.failover_from_offering_id, NEW.org_id
      USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END $$;

ALTER TABLE public.ai_agent_runs ADD COLUMN IF NOT EXISTS served_offering_id uuid;
ALTER TABLE public.ai_agent_runs ADD COLUMN IF NOT EXISTS served_funding_source text;
ALTER TABLE public.ai_agent_runs ADD COLUMN IF NOT EXISTS served_failover_hop smallint;
ALTER TABLE public.ai_agent_runs ADD COLUMN IF NOT EXISTS served_failover_cause text;

ALTER TABLE public.ai_agent_runs DROP CONSTRAINT IF EXISTS ai_agent_runs_served_chk;
ALTER TABLE public.ai_agent_runs ADD CONSTRAINT ai_agent_runs_served_chk CHECK (
  (served_funding_source IS NULL OR served_funding_source IN ('platform', 'partner_key'))
  AND (served_failover_hop IS NULL OR served_failover_hop BETWEEN 1 AND 6)
  AND ((served_offering_id IS NULL) = (served_failover_hop IS NULL))
  AND ((served_offering_id IS NULL) = (served_funding_source IS NULL))
  AND ((served_offering_id IS NULL) = (served_failover_cause IS NULL))
  AND (served_failover_cause IS NULL OR served_failover_cause IN
       ('ineligible', 'cooldown', 'rate_limited', 'overloaded', 'server_error', 'auth_failed', 'quota_exhausted'))
) NOT VALID;
ALTER TABLE public.ai_agent_runs VALIDATE CONSTRAINT ai_agent_runs_served_chk;

ALTER TABLE public.ai_model_assignments DROP CONSTRAINT IF EXISTS ai_model_assignments_fallback_shape_chk;
ALTER TABLE public.ai_model_assignments ADD CONSTRAINT ai_model_assignments_fallback_shape_chk CHECK (
  fallback_offering_ids IS NULL
  OR (cardinality(fallback_offering_ids) <= 5
      AND (default_offering_id IS NULL OR NOT (default_offering_id = ANY (fallback_offering_ids))))
) NOT VALID;
ALTER TABLE public.ai_model_assignments VALIDATE CONSTRAINT ai_model_assignments_fallback_shape_chk;
```

The function body is W02's `2026-11-14-100300-ai-invocations.sql` text verbatim, plus the one `W09` block before `RETURN NEW`. The trigger (`BEFORE INSERT`) is unchanged, so it is not re-created. W02 wrote `fallback_offering_ids = NULL` everywhere (`legacyReconcile.ts`), so the assignment CHECK validates on every existing database. Lab gate L4 confirms that on production before release.

- [ ] **Step 4: Drizzle schema and export policy**

`apps/api/src/db/schema/aiInvocations.ts`: add `smallint` to the `drizzle-orm/pg-core` import, and add after `fallbackUsed`:

```ts
  /** W09 (#7607): the offering routed to before failover; null on hop 0. Provenance, no FK. */
  failoverFromOfferingId: uuid('failover_from_offering_id'),
  /** W09: candidates passed over before the serving one (0 = no failover). */
  failoverHop: smallint('failover_hop').notNull().default(0),
  /** W09: FailoverCause; null on hop 0. */
  failoverCause: text('failover_cause'),
```

`apps/api/src/db/schema/aiAgents.ts`: add `smallint` to its `drizzle-orm/pg-core` import, and add after `admittedOfferingId`:

```ts
  /** W09 (#7607): the offering that served the run's model tokens when it was a failover hop. */
  servedOfferingId: uuid('served_offering_id'),
  /** W09: that hop's funding. Sandbox compute stays on `fundingSource` (D7). */
  servedFundingSource: text('served_funding_source').$type<'platform' | 'partner_key'>(),
  /** W09: the hop index; a re-driven run resumes on this hop's reservation key. */
  servedFailoverHop: smallint('served_failover_hop'),
  /** W09: why it failed over; restores the ledger provenance on a re-driven run. */
  servedFailoverCause: text('served_failover_cause'),
```

`apps/api/src/services/tenantExportPolicyRegistry.ts`:
- In the `"ai_invocations"` entry, append `"failover_from_offering_id","failover_hop","failover_cause"` to `included`.
- In the `"ai_agent_runs"` entry, append `"served_offering_id","served_funding_source","served_failover_hop","served_failover_cause"` to `included`.
- Put a one-line comment above each: `// AI model registry W09 (#7607): failover provenance -> included (identifiers, counter, enum).`

- [ ] **Step 5: Run the tests, drift and export-policy contracts**

Run, from `apps/api`:
- `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiModelFailover.integration.test.ts`
- `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts`
- `npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts`

Then, from the repo root: `DATABASE_URL=… pnpm db:check-drift` and `bash scripts/check-migration-naming.sh --against-ref origin/main`.
Expected: all PASS; drift reports none; the naming guard exits 0.

- [ ] **Step 6: Commit**

Stage the migration, the two schema files, `tenantExportPolicyRegistry.ts` and the integration test. Commit message: `feat(ai-models): failover provenance on the ledger and agent runs; fallback list shape (#7607)`, ending with the Co-Authored-By trailer.

---

## Task 3: Failure classification and the offering cooldown

**Files:**
- Create: `apps/api/src/services/aiModels/failover.ts`, `failover.test.ts`
- Create: `apps/api/src/services/aiModels/offeringHealth.ts`, `offeringHealth.test.ts`
- Modify: `apps/api/src/services/aiModels/index.ts` (re-export both)

**Interfaces:**
- Consumes: `getRedis` (P17); `listOfferings(partnerId, { connectionId })` (W02 `offerings.ts`); `ResolvedModel` (P1, type only).
- Produces:

```ts
// failover.ts
export const FAILOVER_CAUSES: readonly ['ineligible','cooldown','rate_limited','overloaded','server_error','auth_failed','quota_exhausted'];
export type FailoverCause = (typeof FAILOVER_CAUSES)[number];
export type ProviderFailureCause = Exclude<FailoverCause, 'ineligible' | 'cooldown'>;
export const MAX_FAILOVER_HOP = 6;
export const SDK_RETRIES_BEFORE_FAILOVER = 2;
export const COOLDOWN_TTL_MS: Readonly<Record<ProviderFailureCause, number>>;
export function classifyProviderStatus(status: number | null | undefined, errorType?: string | null, message?: string | null): ProviderFailureCause | null;
export function classifyProviderError(error: unknown): ProviderFailureCause | null;              // Messages API (walks `cause`)
export function classifySdkAssistantError(error: string | null | undefined, status: number | null | undefined): ProviderFailureCause | null;
export function hopIdempotencyKey(base: string, hop: number): string;
// offeringHealth.ts
export function markOfferingCooldown(offeringId: string, cause: ProviderFailureCause): Promise<void>;
export function coolingOfferings(ids: readonly string[]): Promise<Set<string>>;
export function clearOfferingCooldowns(ids: readonly string[]): Promise<void>;
export function clearConnectionCooldowns(partnerId: string, connectionId: string): Promise<void>;
export function noteProviderFailure(resolved: Pick<ResolvedModel, 'offering' | 'surface' | 'funding'>, cause: ProviderFailureCause): Promise<void>;
```

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/aiModels/failover.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  classifyProviderError,
  classifyProviderStatus,
  classifySdkAssistantError,
  hopIdempotencyKey,
} from './failover';

/** The shape @anthropic-ai/sdk's APIError carries: status + parsed body. */
function apiError(status: number, type: string | null, message = 'x') {
  return Object.assign(new Error(message), {
    status,
    error: type ? { type: 'error', error: { type, message } } : undefined,
  });
}

describe('classifyProviderStatus (D8)', () => {
  it.each([
    [529, null, null, 'overloaded'],
    [429, null, null, 'rate_limited'],
    [402, null, null, 'quota_exhausted'],
    [401, null, null, 'auth_failed'],
    [403, null, null, 'auth_failed'],
    [500, null, null, 'server_error'],
    [503, null, null, 'server_error'],
    [400, 'invalid_request_error', 'Your credit balance is too low to access the API', 'quota_exhausted'],
    [400, 'invalid_request_error', 'messages: field required', null],
    [404, 'not_found_error', 'model: x', null],
    [413, null, null, null],
    [null, null, null, null],
  ] as const)('%s %s → %s', (status, type, msg, expected) => {
    expect(classifyProviderStatus(status, type, msg)).toBe(expected);
  });

  it('the error type wins over the status', () => {
    expect(classifyProviderStatus(500, 'overloaded_error')).toBe('overloaded');
  });
});

describe('classifyProviderError (Messages API)', () => {
  it('reads an APIError directly', () => {
    expect(classifyProviderError(apiError(529, 'overloaded_error'))).toBe('overloaded');
  });

  it('unwraps a surface error that carries the APIError as its cause (Office draft)', () => {
    const wrapped = new Error('Failed to draft', { cause: apiError(429, 'rate_limit_error') });
    expect(classifyProviderError(wrapped)).toBe('rate_limited');
  });

  it('a timeout (no status) is never failover-eligible: the outcome is unknown', () => {
    const timeout = Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' });
    expect(classifyProviderError(timeout)).toBeNull();
    expect(classifyProviderError(new DOMException('aborted', 'TimeoutError'))).toBeNull();
  });

  it('gives up after five cause levels', () => {
    let e: Error = apiError(529, 'overloaded_error');
    for (let i = 0; i < 6; i++) e = new Error(`wrap ${i}`, { cause: e });
    expect(classifyProviderError(e)).toBeNull();
  });
});

describe('classifySdkAssistantError (Agent SDK)', () => {
  it.each([
    ['rate_limit', null, 'rate_limited'],
    ['overloaded', 529, 'overloaded'],
    ['server_error', 500, 'server_error'],
    ['authentication_failed', 401, 'auth_failed'],
    ['billing_error', 400, 'quota_exhausted'],
    ['invalid_request', 400, null],
    ['model_not_found', 404, null],
    ['max_output_tokens', null, null],
    ['unknown', 503, 'server_error'],
    [null, 529, 'overloaded'],
  ] as const)('%s / %s → %s', (err, status, expected) => {
    expect(classifySdkAssistantError(err, status)).toBe(expected);
  });
});

describe('hopIdempotencyKey', () => {
  it('hop 0 keeps the base key; later hops are deterministic', () => {
    expect(hopIdempotencyKey('ai-agent-run:r1', 0)).toBe('ai-agent-run:r1');
    expect(hopIdempotencyKey('ai-agent-run:r1', 2)).toBe('ai-agent-run:r1:hop:2');
  });
  it('rejects a hop outside 0..6', () => {
    expect(() => hopIdempotencyKey('k', 7)).toThrow(/hop/);
    expect(() => hopIdempotencyKey('k', -1)).toThrow(/hop/);
  });
});
```

`apps/api/src/services/aiModels/offeringHealth.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  redis: null as null | {
    set: ReturnType<typeof vi.fn>; mget: ReturnType<typeof vi.fn>; del: ReturnType<typeof vi.fn>;
  },
  listOfferings: vi.fn(),
}));
vi.mock('../redis', () => ({ getRedis: () => h.redis }));
vi.mock('./offerings', () => ({ listOfferings: h.listOfferings }));

import {
  clearConnectionCooldowns,
  coolingOfferings,
  markOfferingCooldown,
  noteProviderFailure,
} from './offeringHealth';

beforeEach(() => {
  h.redis = { set: vi.fn(async () => 'OK'), mget: vi.fn(async () => []), del: vi.fn(async () => 1) };
  h.listOfferings.mockReset();
});

describe('offering cooldown', () => {
  it('marks with the cause-specific TTL', async () => {
    await markOfferingCooldown('off-1', 'overloaded');
    await markOfferingCooldown('off-2', 'auth_failed');
    expect(h.redis!.set).toHaveBeenNthCalledWith(1, 'ai-model:cooldown:off-1', 'overloaded', 'PX', 60_000);
    expect(h.redis!.set).toHaveBeenNthCalledWith(2, 'ai-model:cooldown:off-2', 'auth_failed', 'PX', 900_000);
  });

  it('reads many ids in one MGET and returns the cooling ones', async () => {
    h.redis!.mget.mockResolvedValue(['overloaded', null]);
    expect(await coolingOfferings(['a', 'b', 'a'])).toEqual(new Set(['a']));
    expect(h.redis!.mget).toHaveBeenCalledWith('ai-model:cooldown:a', 'ai-model:cooldown:b');
  });

  it('fails open: no Redis, a Redis error, or a slow Redis all mean "nothing is cooling"', async () => {
    h.redis = null;
    expect(await coolingOfferings(['a'])).toEqual(new Set());
    h.redis = { set: vi.fn(), del: vi.fn(), mget: vi.fn(async () => { throw new Error('down'); }) };
    expect(await coolingOfferings(['a'])).toEqual(new Set());
    vi.useFakeTimers();
    h.redis.mget = vi.fn(() => new Promise(() => undefined));
    const pending = coolingOfferings(['a']);
    await vi.advanceTimersByTimeAsync(300);
    expect(await pending).toEqual(new Set());
    vi.useRealTimers();
  });

  it('noteProviderFailure skips a partnerless platform call (no offering id)', async () => {
    await noteProviderFailure({ offering: { id: null, displayName: 'x' }, surface: 'patch_test', funding: 'platform' }, 'overloaded');
    expect(h.redis!.set).not.toHaveBeenCalled();
  });

  it('a key rotation clears the cooldown of every offering on that connection', async () => {
    h.listOfferings.mockResolvedValue([{ id: 'o1', connectionId: 'c1' }, { id: 'o2', connectionId: 'c1' }]);
    await clearConnectionCooldowns('p1', 'c1');
    expect(h.listOfferings).toHaveBeenCalledWith('p1', { connectionId: 'c1' });
    expect(h.redis!.del).toHaveBeenCalledWith('ai-model:cooldown:o1', 'ai-model:cooldown:o2');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/failover.test.ts src/services/aiModels/offeringHealth.test.ts`
Expected: FAIL, `Cannot find module './failover'` / `'./offeringHealth'`.

- [ ] **Step 3: Write the implementation**

`apps/api/src/services/aiModels/failover.ts`:

```ts
/**
 * AI model registry W09 (#7607): what counts as a failover-eligible provider
 * failure (D8), and the deterministic per-hop reservation key. Pure.
 *
 * Only a provider STATUS response proves the call produced no output and
 * billed nothing. A timeout or a socket reset after send has an unknown
 * outcome and stays on W03's indeterminate path. A malformed request would
 * fail identically on every hop, so it is never a failover cause either.
 */
export const FAILOVER_CAUSES = [
  'ineligible', 'cooldown', 'rate_limited', 'overloaded', 'server_error', 'auth_failed', 'quota_exhausted',
] as const;
export type FailoverCause = (typeof FAILOVER_CAUSES)[number];
export type ProviderFailureCause = Exclude<FailoverCause, 'ineligible' | 'cooldown'>;

/** Upper bound of ai_invocations.failover_hop (DB CHECK): 1 stored-choice default + 5 fallbacks. */
export const MAX_FAILOVER_HOP = 6;
/** The Agent SDK retries a failing request itself; fail over after this many of its retries (agent runs). */
export const SDK_RETRIES_BEFORE_FAILOVER = 2;

/** D9. A key rotation clears the long ones early (clearConnectionCooldowns). */
export const COOLDOWN_TTL_MS: Readonly<Record<ProviderFailureCause, number>> = Object.freeze({
  rate_limited: 60_000,
  overloaded: 60_000,
  server_error: 60_000,
  auth_failed: 15 * 60_000,
  quota_exhausted: 15 * 60_000,
});

const LOW_CREDIT = /credit balance is too low/i;

export function classifyProviderStatus(
  status: number | null | undefined,
  errorType?: string | null,
  message?: string | null,
): ProviderFailureCause | null {
  switch (errorType) {
    case 'overloaded_error': return 'overloaded';
    case 'rate_limit_error': return 'rate_limited';
    case 'billing_error': return 'quota_exhausted';
    case 'authentication_error':
    case 'permission_error': return 'auth_failed';
    case 'api_error': return 'server_error';
    default: break;
  }
  if (status === 529) return 'overloaded';
  if (status === 429) return 'rate_limited';
  if (status === 402) return 'quota_exhausted';
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 400 && message && LOW_CREDIT.test(message)) return 'quota_exhausted';
  if (typeof status === 'number' && status >= 500 && status <= 504) return 'server_error';
  return null;
}

interface StatusErrorLike {
  status?: unknown;
  message?: unknown;
  error?: { type?: unknown; error?: { type?: unknown; message?: unknown } } | null;
  cause?: unknown;
}

/** An @anthropic-ai/sdk APIError anywhere in the first five `cause` levels. */
export function classifyProviderError(error: unknown): ProviderFailureCause | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth++) {
    const e = current as StatusErrorLike;
    if (typeof e.status === 'number') {
      const body = e.error && typeof e.error === 'object' ? e.error : null;
      const type = typeof body?.error?.type === 'string' ? body.error.type
        : typeof body?.type === 'string' && body.type !== 'error' ? body.type : null;
      const message = typeof body?.error?.message === 'string' ? body.error.message
        : typeof e.message === 'string' ? e.message : null;
      return classifyProviderStatus(e.status, type, message);
    }
    current = e.cause;
  }
  return null;
}

/** `SDKAssistantMessageError` / `SDKAPIRetryMessage.error` (agent-sdk 0.3.286) + its HTTP status. */
export function classifySdkAssistantError(
  error: string | null | undefined,
  status: number | null | undefined,
): ProviderFailureCause | null {
  switch (error) {
    case 'rate_limit': return 'rate_limited';
    case 'overloaded': return 'overloaded';
    case 'server_error': return 'server_error';
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
    case 'cloud_credential_error': return 'auth_failed';
    case 'billing_error':
    case 'account_on_hold': return 'quota_exhausted';
    case 'invalid_request':
    case 'model_not_found':
    case 'max_output_tokens':
    case 'verification_required': return null;
    default: return classifyProviderStatus(status ?? null);
  }
}

/** Hop 0 keeps the surface's own key (W03 behaviour, replay-compatible); hop n appends `:hop:n`. */
export function hopIdempotencyKey(base: string, hop: number): string {
  if (!Number.isInteger(hop) || hop < 0 || hop > MAX_FAILOVER_HOP) throw new Error(`invalid failover hop ${hop}`);
  return hop === 0 ? base : `${base}:hop:${hop}`;
}
```

`apps/api/src/services/aiModels/offeringHealth.ts`:

```ts
/**
 * AI model registry W09 (#7607): per-offering cooldown after a provider
 * failure (D9). resolveModel PREFERS a healthy fallback over a cooling
 * primary, and still uses the primary when nothing else is eligible: a
 * cooldown never turns into an outage. Redis absent, failing or slow → no
 * cooldown (fail open to normal resolution). Keys are per offering id, which
 * is partner-owned, so one partner's failures never steer another's routing.
 */
import { getRedis } from '../redis';
import { COOLDOWN_TTL_MS, type ProviderFailureCause } from './failover';
import { listOfferings } from './offerings';
import type { ResolvedModel } from './resolveModel';

const REDIS_TIMEOUT_MS = 250;
const key = (offeringId: string) => `ai-model:cooldown:${offeringId}`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** ioredis queues commands while disconnected; never let that stall a dispatch. */
async function bounded<T>(work: Promise<T>, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), REDIS_TIMEOUT_MS); });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function markOfferingCooldown(offeringId: string, cause: ProviderFailureCause): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await bounded(redis.set(key(offeringId), cause, 'PX', COOLDOWN_TTL_MS[cause]).then(() => undefined), undefined);
  } catch (error) {
    console.warn('[offeringHealth] cooldown write failed', { offeringId, cause, error: errorMessage(error) });
  }
}

export async function coolingOfferings(ids: readonly string[]): Promise<Set<string>> {
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))];
  const redis = getRedis();
  if (!redis || unique.length === 0) return new Set();
  try {
    const values = await bounded(redis.mget(...unique.map(key)), unique.map(() => null as string | null));
    return new Set(unique.filter((_, i) => values[i] !== null && values[i] !== undefined));
  } catch (error) {
    console.warn('[offeringHealth] cooldown read failed; treating nothing as cooling', { error: errorMessage(error) });
    return new Set();
  }
}

export async function clearOfferingCooldowns(ids: readonly string[]): Promise<void> {
  const redis = getRedis();
  if (!redis || ids.length === 0) return;
  try {
    await bounded(redis.del(...ids.map(key)).then(() => undefined), undefined);
  } catch (error) {
    console.warn('[offeringHealth] cooldown clear failed', { error: errorMessage(error) });
  }
}

/** A rotated key may fix auth_failed / quota_exhausted at once: forget that connection's cooldowns. */
export async function clearConnectionCooldowns(partnerId: string, connectionId: string): Promise<void> {
  const offerings = await listOfferings(partnerId, { connectionId });
  await clearOfferingCooldowns(offerings.map((o) => o.id));
}

export async function noteProviderFailure(
  resolved: Pick<ResolvedModel, 'offering' | 'surface' | 'funding'>,
  cause: ProviderFailureCause,
): Promise<void> {
  // The partnerless platform default (patch_test) has no offering to cool.
  if (!resolved.offering.id) return;
  console.warn('[aiModels] provider failure; offering cooling down', {
    offeringId: resolved.offering.id, surface: resolved.surface, funding: resolved.funding, cause,
  });
  await markOfferingCooldown(resolved.offering.id, cause);
}
```

Append `export * from './failover';` and `export * from './offeringHealth';` to `services/aiModels/index.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/aiModels/failover.test.ts src/services/aiModels/offeringHealth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Stage the four new files and `index.ts`. Commit message: `feat(ai-models): classify failover-eligible provider failures; per-offering cooldown (#7607)`, ending with the Co-Authored-By trailer.

---

## Task 4: Role-aware assignment merge (D2)

**Files:**
- Modify: `apps/api/src/services/aiModels/assignments.ts`
- Modify: `apps/api/src/services/aiModels/assignments.test.ts`

**Interfaces:**
- Consumes: W02's `mergeEffectiveAssignment`, `AssignmentRowInput`, `pickForRole` (P4).
- Produces: `export function selectRoleRows<T extends AssignmentRowInput & { orgId: string | null }>(rows: readonly T[], role: string): { partner: AssignmentRowInput | null; org: AssignmentRowInput | null }`. Used by `getEffectiveAssignment` and by Task 12's `registryView.ts`, so the API and the settings card agree.

- [ ] **Step 1: Write the failing tests**

Append to `assignments.test.ts` (W02's `row()` helper and the `A`/`B`/`C` ids already exist; add `selectRoleRows` to the import):

```ts
describe('W09 roles (D2): role row, else default row; an org default override never erases a partner role default', () => {
  const pD = { ...row({ id: 'pD', role: 'default', defaultOfferingId: A, permittedOfferingIds: [A, B, C], fallbackOfferingIds: [B] }), orgId: null };
  const pT = { ...row({ id: 'pT', role: 'triage', defaultOfferingId: C, permittedOfferingIds: [A, B, C], fallbackOfferingIds: [A] }), orgId: null };
  const oD = { ...row({ id: 'oD', role: 'default', defaultOfferingId: B, permittedOfferingIds: [B, C], fallbackOfferingIds: [C], allowUserChoice: false, fallbackMayCrossFunding: false }), orgId: 'org-1' };
  const oT = { ...row({ id: 'oT', role: 'triage', defaultOfferingId: B }), orgId: 'org-1' };
  const merged = (rows: Array<AssignmentRowInput & { orgId: string | null }>, role: string) =>
    mergeEffectiveAssignment({ surface: 'ai_agents', role, ...selectRoleRows(rows, role) });

  it('a role with no rows of its own inherits the default rows (W02 unchanged)', () => {
    const eff = merged([pD, oD], 'triage');
    expect([eff.defaultOfferingId, eff.defaultSource]).toEqual([B, 'org']);
    expect(eff.sources).toMatchObject({ partnerRowId: 'pD', orgRowId: 'oD' });
  });

  it('the partner triage default survives an org DEFAULT override', () => {
    const eff = merged([pD, pT, oD], 'triage');
    expect([eff.defaultOfferingId, eff.defaultSource]).toEqual([C, 'partner']);
    expect(eff.fallbackOfferingIds).toEqual([A]);                      // the org default row's fallbacks are not applied
  });

  it('…while the org default row still narrows the role', () => {
    const eff = merged([pD, pT, oD], 'triage');
    expect(eff.permitted).toEqual({ kind: 'list', offeringIds: [B, C] });
    expect(eff.allowUserChoice).toBe(false);
    expect(eff.fallbackMayCrossFunding).toBe(false);
  });

  it('an org TRIAGE row overrides the partner triage default (inside the permitted set)', () => {
    const eff = merged([pD, pT, oD, oT], 'triage');
    expect([eff.defaultOfferingId, eff.defaultSource]).toEqual([B, 'org']);
  });

  it('the default role is unaffected', () => {
    const eff = merged([pD, pT, oD], 'default');
    expect([eff.defaultOfferingId, eff.defaultSource]).toEqual([B, 'org']);
    expect(eff.fallbackOfferingIds).toEqual([C]);
  });
});
```

In these cases the partner triage default `C` sits inside the org's narrowed set `[B, C]`. W02's merge never re-filters a **partner** default by an org's narrowed set, and W03's resolver dispatches it as is. W09 keeps that behaviour; it is recorded under "Review" as a pre-existing gap, and W09 does not fix it.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/assignments.test.ts -t "W09 roles"`
Expected: FAIL, `selectRoleRows is not a function`.

- [ ] **Step 3: Write the implementation**

In `assignments.ts`, add above `getEffectiveAssignment`:

```ts
/**
 * W09 (#7607, D2): the two rows one (surface, role) merges. Each side is its
 * role row, else its `default` row (W02, spec §9 step 1). One exception: an
 * org's DEFAULT row standing in for role R does not carry its default model
 * or its fallback list onto R when the partner configured R explicitly —
 * otherwise any org that overrides the ai_agents default would silently
 * collapse triage/analysis/remediation onto one model (#7570). Its narrowing
 * (permitted set, user choice, options, cross-funding) still applies, so the
 * merge stays tighten-only.
 */
export function selectRoleRows<T extends AssignmentRowInput & { orgId: string | null }>(
  rows: readonly T[],
  role: string,
): { partner: AssignmentRowInput | null; org: AssignmentRowInput | null } {
  const partner = pickForRole(rows.filter((r) => r.orgId === null), role);
  let org: AssignmentRowInput | null = pickForRole(rows.filter((r) => r.orgId !== null), role);
  if (role !== 'default' && org?.role === 'default' && partner?.role === role) {
    org = { ...org, defaultOfferingId: null, fallbackOfferingIds: null };
  }
  return { partner, org };
}
```

In `getEffectiveAssignment`, replace the final `return mergeEffectiveAssignment({ … partner: pickForRole(…), org: pickForRole(…) })` with:

```ts
  return mergeEffectiveAssignment({ surface: input.surface, role, ...selectRoleRows(rows, role) });
```

`pickForRole` is generic over `{ role: string }`. If the compiler cannot infer `T` for `rows.filter(...)`, add the type argument `pickForRole<T>(…)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/aiModels/assignments.test.ts`
Expected: PASS (W02's cases + the five above).

- [ ] **Step 5: Commit**

Stage both files. Commit message: `feat(ai-models): an org default override no longer erases a partner escalation-role default (#7607)`, ending with the Co-Authored-By trailer.

---

## Task 5: `resolveModel` — the ordered failover walk, cooldown preference, exclusions

**Files:**
- Modify: `apps/api/src/services/aiModels/resolveModel.ts`
- Modify: `apps/api/src/services/aiModels/resolveModel.test.ts`
- Modify: `apps/api/src/services/aiModels/__fixtures__/resolvedModel.ts`
- Create: `apps/api/src/__tests__/integration/helpers/aiModelFailoverSeed.ts`
- Modify: `apps/api/src/__tests__/integration/aiModelFailover.integration.test.ts` (append)

**Interfaces:**
- Consumes: P1–P4; Task 3 `coolingOfferings`, `FailoverCause`, `ProviderFailureCause`, `MAX_FAILOVER_HOP`; Task 4 (through `getEffectiveAssignment`).
- Produces:

```ts
export interface ResolveModelInput {
  // …W03 fields…
  /** W09: offerings already attempted in this call (dispatch failover). Never chosen again. */
  excludeOfferingIds?: readonly string[];
  /** W09: why the excluded primary failed; recorded as the ledger's failover_cause. */
  failoverCause?: ProviderFailureCause;
  /** W09 (D5): a session with history may fail over only within its connection. */
  sameConnectionOnly?: boolean;
  /**
   * W09 (Codex review 4): the dispatch's FIRST hop. On a re-resolution every
   * candidate — including a primary that changed since the first hop — is
   * judged against this origin's funding and connection, never against a
   * primary that moved mid-dispatch.
   */
  failoverOrigin?: FailoverOrigin;
}
export interface FailoverOrigin { offeringId: string | null; funding: AiBillingSource; connectionId: string | null }
export interface ResolvedFailover { fromOfferingId: string | null; hop: number; cause: FailoverCause }
export interface ResolvedModel {
  // …W03 fields…
  /** W09: non-null when a candidate other than the primary serves. */
  failover: ResolvedFailover | null;
  /** W09: fallback ids a dispatch could still try (unfiltered for eligibility; the re-resolution filters). */
  failoverRemaining: readonly string[];
}
```

The walk order, as implemented below:
1. **W03 fast path.** The primary (the request, else the effective default) is eligible, not excluded and not cooling → it serves, `failover: null`.
2. **Cooling primary.** The primary is eligible but cooling down → walk; when nothing healthy is found, the primary serves anyway.
3. **A fresh user pick** (`origin: 'user'` with a `requested.offeringId`) never fails over (W03's strict session creation).
4. **A stored choice ≠ default (`session` / `policy`) that is ineligible or excluded.** With **no** fallback list, W03's single same-route default applies unchanged. With a list, the walk **replaces** it (spec §9.1: "a configured `fallback_offering_ids` list replaces the single-candidate rule"), so the default serves only if the partner put it in the list.
5. **The default itself ineligible or excluded** → walk.
6. **Walk:** each id of `assignment.fallbackOfferingIds`, in order. Skip the primary and anything already tried. Count an excluded, not-permitted, ineligible, funding-crossing (F1), other-connection (D5) or cooling candidate as passed over. The first healthy candidate serves, with `hop` = candidates passed over (≤ `MAX_FAILOVER_HOP`). If only cooling candidates remain, the first cooling one serves.
7. **Dispatch re-resolution (`failoverOrigin` set).** The F1 funding rule and the D5 connection rule are judged against the **origin** (the dispatch's first hop), not against the current primary. A primary that changed mid-dispatch to another funding is therefore a walk candidate like any other: it needs crossing permission. Any serving offering other than the origin records `failover.fromOfferingId = origin.offeringId`.

- [ ] **Step 1: Write the failing unit tests**

In `resolveModel.test.ts`:
- add `coolingOfferings: vi.fn(async () => new Set<string>())` to the `m` hoisted object;
- add `vi.mock('./offeringHealth', () => ({ coolingOfferings: m.coolingOfferings }));` next to the other mocks;
- reset it in `beforeEach` with `m.coolingOfferings.mockResolvedValue(new Set())`.

The existing W03 cases keep `fallbackOfferingIds: []`, so they pin "no list ⇒ W03 behaviour unchanged". Append:

```ts
describe('W09 failover walk', () => {
  const BYOK = (id: string, facts: Partial<LoadedCandidate['facts']> = {}) => cand(id, { connectionId: 'conn-b' }, facts);
  const withList = (over: Record<string, unknown>) => m.getEffectiveAssignment.mockResolvedValue({
    ...ASSIGNMENT, permitted: { kind: 'all' }, ...over,
  });

  it('a disabled default walks to the first eligible fallback on the same funding', async () => {
    candidates = { def: cand('def', {}, { enabled: false }), f1: cand('f1') };
    withList({ fallbackOfferingIds: ['f1'] });
    const r = await resolveModel(BASE);
    expect(r).toMatchObject({ ok: true, offering: { id: 'f1' }, fellBack: true, funding: 'platform',
      failover: { fromOfferingId: 'def', hop: 1, cause: 'ineligible' } });
  });

  it('skips a cross-funding fallback when crossing is off (F1)', async () => {
    candidates = { def: cand('def', {}, { enabled: false }), k: BYOK('k') };
    withList({ fallbackOfferingIds: ['k'], fallbackMayCrossFunding: false });
    expect(await resolveModel(BASE)).toMatchObject({ ok: false, reason: 'model_unavailable' });
  });

  it('crosses funding only when the effective assignment allows it', async () => {
    candidates = { def: cand('def', {}, { enabled: false }), k: BYOK('k') };
    withList({ fallbackOfferingIds: ['k'], fallbackMayCrossFunding: true });
    expect(await resolveModel(BASE)).toMatchObject({ ok: true, offering: { id: 'k' }, funding: 'partner_key' });
  });

  it('a fallback outside the effective permitted set is passed over', async () => {
    candidates = { def: cand('def', {}, { enabled: false }), f1: cand('f1'), f2: cand('f2') };
    withList({ permitted: { kind: 'list', offeringIds: ['def', 'f2'] }, fallbackOfferingIds: ['f1', 'f2'] });
    expect(await resolveModel(BASE)).toMatchObject({ offering: { id: 'f2' }, failover: { hop: 2 } });
  });

  it('re-resolution skips a fallback disabled since the first resolution (F2)', async () => {
    candidates = { def: cand('def'), f1: cand('f1', {}, { enabled: false }), f2: cand('f2') };
    withList({ fallbackOfferingIds: ['f1', 'f2'] });
    const r = await resolveModel({ ...BASE, excludeOfferingIds: ['def'], failoverCause: 'overloaded' });
    expect(r).toMatchObject({ offering: { id: 'f2' }, failover: { fromOfferingId: 'def', hop: 2, cause: 'overloaded' } });
  });

  it('nothing left after exclusions → recoverable unavailable', async () => {
    candidates = { def: cand('def'), f1: cand('f1') };
    withList({ fallbackOfferingIds: ['f1'] });
    expect(await resolveModel({ ...BASE, excludeOfferingIds: ['def', 'f1'], failoverCause: 'overloaded' }))
      .toMatchObject({ ok: false, recoverable: true });
  });

  it('prefers a healthy fallback over a cooling primary, and uses the primary when every fallback is unusable', async () => {
    candidates = { def: cand('def'), f1: cand('f1') };
    withList({ fallbackOfferingIds: ['f1'] });
    m.coolingOfferings.mockResolvedValue(new Set(['def']));
    expect(await resolveModel(BASE)).toMatchObject({ offering: { id: 'f1' }, failover: { cause: 'cooldown', hop: 1 } });
    candidates.f1 = cand('f1', {}, { enabled: false });
    expect(await resolveModel(BASE)).toMatchObject({ offering: { id: 'def' }, failover: null });
  });

  it('when every candidate is cooling, the first cooling fallback serves rather than an outage', async () => {
    candidates = { def: cand('def', {}, { enabled: false }), f1: cand('f1') };
    withList({ fallbackOfferingIds: ['f1'] });
    m.coolingOfferings.mockResolvedValue(new Set(['f1']));
    expect(await resolveModel(BASE)).toMatchObject({ ok: true, offering: { id: 'f1' } });
  });

  it('a fresh user pick never fails over, even with a list', async () => {
    candidates = { def: cand('def'), alt: cand('alt', {}, { enabled: false }), f1: cand('f1') };
    withList({ fallbackOfferingIds: ['f1'] });
    expect(await resolveModel({ ...BASE, requested: { offeringId: 'alt', origin: 'user' } }))
      .toMatchObject({ ok: false, reason: 'model_unavailable' });
  });

  it('with a list, the walk REPLACES W03\'s single same-route default (spec §9.1)', async () => {
    candidates = { def: cand('def'), alt: cand('alt', {}, { enabled: false }), f1: cand('f1') };
    withList({ fallbackOfferingIds: ['f1'] });
    // def is eligible and same-route, but not in the list: the list decides
    expect(await resolveModel({ ...BASE, requested: { offeringId: 'alt', origin: 'session' } }))
      .toMatchObject({ offering: { id: 'f1' }, failover: { fromOfferingId: 'alt', hop: 1, cause: 'ineligible' } });
  });

  it('without a list, a stored choice keeps W03\'s same-route default (now with provenance)', async () => {
    candidates = { def: cand('def'), alt: cand('alt', {}, { enabled: false }) };
    withList({ fallbackOfferingIds: [] });
    expect(await resolveModel({ ...BASE, requested: { offeringId: 'alt', origin: 'session' } }))
      .toMatchObject({ offering: { id: 'def' }, fellBack: true, failover: { fromOfferingId: 'alt', hop: 1, cause: 'ineligible' } });
  });

  it('re-resolution judges funding against the dispatch ORIGIN, even when the default changed mid-dispatch (Codex 4)', async () => {
    // first hop was BYOK k; meanwhile the partner switched the default to platform def; crossing is off
    candidates = { def: cand('def'), k: BYOK('k') };
    withList({ fallbackOfferingIds: ['f9'], fallbackMayCrossFunding: false });
    const origin = { offeringId: 'k', funding: 'partner_key' as const, connectionId: 'conn-b' };
    expect(await resolveModel({ ...BASE, excludeOfferingIds: ['k'], failoverCause: 'rate_limited', failoverOrigin: origin }))
      .toMatchObject({ ok: false });
    withList({ fallbackOfferingIds: ['f9'], fallbackMayCrossFunding: true });
    expect(await resolveModel({ ...BASE, excludeOfferingIds: ['k'], failoverCause: 'rate_limited', failoverOrigin: origin }))
      .toMatchObject({ ok: true, offering: { id: 'def' }, failover: { fromOfferingId: 'k', cause: 'rate_limited' } });
  });

  it('a stored choice that no longer exists: funding unknown counts as crossing, and the source is not recorded', async () => {
    candidates = { def: cand('def', { connectionId: 'conn-b' }), gone: null, f1: cand('f1') };
    withList({ fallbackOfferingIds: ['f1'], fallbackMayCrossFunding: false });
    expect(await resolveModel({ ...BASE, requested: { offeringId: 'gone', origin: 'session' } })).toMatchObject({ ok: false });
    withList({ fallbackOfferingIds: ['f1'], fallbackMayCrossFunding: true });
    expect(await resolveModel({ ...BASE, requested: { offeringId: 'gone', origin: 'session' } }))
      .toMatchObject({ offering: { id: 'f1' }, failover: { fromOfferingId: null } });
  });

  it('sameConnectionOnly passes over a fallback on another connection (D5)', async () => {
    candidates = { def: cand('def', {}, { enabled: false }), k: BYOK('k'), f1: cand('f1') };
    withList({ fallbackOfferingIds: ['k', 'f1'], fallbackMayCrossFunding: true });
    expect(await resolveModel({ ...BASE, sameConnectionOnly: true })).toMatchObject({ offering: { id: 'f1' }, failover: { hop: 2 } });
  });

  it('failoverRemaining lists what a dispatch could still try', async () => {
    candidates = { def: cand('def'), f1: cand('f1'), f2: cand('f2') };
    withList({ fallbackOfferingIds: ['f1', 'f2'] });
    expect((await resolveModel(BASE) as { failoverRemaining: string[] }).failoverRemaining).toEqual(['f1', 'f2']);
    expect((await resolveModel({ ...BASE, excludeOfferingIds: ['def'], failoverCause: 'rate_limited' }) as { failoverRemaining: string[] })
      .failoverRemaining).toEqual(['f2']);
  });

  it('reads cooldowns only when a list exists (no Redis round trip otherwise)', async () => {
    await resolveModel(BASE);
    expect(m.coolingOfferings).not.toHaveBeenCalled();
  });

  it('passes the escalation role to the assignment read', async () => {
    await resolveModel({ ...BASE, surface: 'ai_agents', role: 'triage' });
    expect(m.getEffectiveAssignment).toHaveBeenCalledWith(expect.objectContaining({ surface: 'ai_agents', role: 'triage' }));
  });
});
```

`BASE` uses `surface: 'chat'`. If W03's `cand()` returns platform-funded candidates for `connectionId: null`, which it does (see P1's test file), every non-`BYOK` candidate above is platform-funded.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/resolveModel.test.ts -t "W09 failover walk"`
Expected: FAIL. `failover` is undefined on results, and the disabled-default cases return `ok: false`.

- [ ] **Step 3: Implement**

In `resolveModel.ts`:

1. Imports:

```ts
import type { EffectiveAssignment } from './assignments';
import { MAX_FAILOVER_HOP, type FailoverCause, type ProviderFailureCause } from './failover';
import { coolingOfferings } from './offeringHealth';
```

2. Add the three input fields and the two result fields from the Interfaces block. Add `ResolvedFailover`.

3. `finalize` gains two trailing parameters and returns them:

```ts
async function finalize(
  c: LoadedCandidate,
  input: ResolveModelInput,
  role: string,
  assignmentOptions: Partial<OfferingOptions> | undefined,
  ctx: EligibilityContext,
  fellBack: boolean,
  transport: DispatchTransport,
  failover: ResolvedFailover | null,
  failoverRemaining: readonly string[],
): Promise<ResolveModelResult> {
  // …W03 body unchanged…
  return {
    // …W03 fields…
    fellBack,
    failover,
    failoverRemaining,
  };
}
```

The `PLATFORM_ONLY_SURFACES` branch passes `null, []`.

4. Replace everything in `resolveModel` from `const origin: RequestOrigin = …` to the end of the function with:

```ts
  const origin: RequestOrigin = input.requested?.origin ?? 'user';
  const requestedId = input.requested?.offeringId;
  const defaultId = assignment.defaultOfferingId;
  const permitted = (id: string) => isPermitted(assignment.permitted, id);
  const excluded = new Set(input.excludeOfferingIds ?? []);
  const fallbackList = assignment.fallbackOfferingIds;
  const dispatchOrigin = input.failoverOrigin ?? null;
  /** F1 + D5 against the dispatch origin (Codex review 4); always true outside a re-resolution. */
  const allowedFromOrigin = (c: LoadedCandidate) => dispatchOrigin === null || (
    (c.funding === dispatchOrigin.funding || assignment.fallbackMayCrossFunding)
    && (!input.sameConnectionOnly || c.connectionId === dispatchOrigin.connectionId));
  // One MGET for every id this call could serve, and none without a list: a
  // cooldown only matters when there is something healthier to prefer.
  const cooling = fallbackList.length > 0
    ? await coolingOfferings([requestedId, defaultId, ...fallbackList].filter((id): id is string => typeof id === 'string'))
    : new Set<string>();

  const serve = (c: LoadedCandidate, fellBack: boolean, failover: ResolvedFailover | null, primaryId: string | null) => {
    // A re-resolution that serves anything but the origin always records where it came from.
    const recorded = failover ?? (dispatchOrigin && c.offeringId !== dispatchOrigin.offeringId
      ? { fromOfferingId: dispatchOrigin.offeringId, hop: Math.min(Math.max(1, excluded.size), MAX_FAILOVER_HOP), cause: input.failoverCause ?? 'server_error' }
      : null);
    return finalize(c, input, role, assignment.options, ctx, fellBack || recorded !== null, transport, recorded,
      fallbackList.filter((id) => id !== c.offeringId && id !== primaryId && !excluded.has(id)));
  };

  /**
   * W09 (spec §9.1): the ordered walk. Every candidate is re-checked LIVE
   * (permitted set, eligibility), stays on the primary's funding unless the
   * effective assignment allows crossing (F1, an unknown primary counts as
   * crossing), stays on the primary's connection for a session with history
   * (D5), and is skipped while cooling unless nothing healthy remains.
   */
  const walk = async (
    primaryId: string | null,
    primary: LoadedCandidate | null,
    cause: FailoverCause,
    passedOver: number,
    tried: ReadonlySet<string>,
  ): Promise<ResolveModelResult | null> => {
    let skipped = passedOver;
    let firstCooling: { c: LoadedCandidate; hop: number } | null = null;
    // The reference for F1/D5: the dispatch origin on a re-resolution, else the primary.
    const reference = dispatchOrigin ?? (primary ? { funding: primary.funding, connectionId: primary.connectionId } : null);
    // The source is recorded only when it still exists: the ledger's provenance
    // guard rejects an id that no longer names an offering of the partner.
    const fromOfferingId = dispatchOrigin ? dispatchOrigin.offeringId : primary ? primaryId : null;
    for (const id of fallbackList) {
      if (id === primaryId || tried.has(id)) continue;
      if (excluded.has(id) || !permitted(id)) { skipped++; continue; }
      const c = await loadOfferingCandidate(id, partnerId);
      if (!c || checkEligibility(c.facts, ctx) !== null) { skipped++; continue; }
      const crossesFunding = reference === null || c.funding !== reference.funding;
      if (crossesFunding && !assignment.fallbackMayCrossFunding) { skipped++; continue; }
      if (input.sameConnectionOnly && (reference === null || c.connectionId !== reference.connectionId)) { skipped++; continue; }
      const hop = Math.min(skipped, MAX_FAILOVER_HOP);
      if (cooling.has(id)) {
        if (!firstCooling) firstCooling = { c, hop };
        skipped++;
        continue;
      }
      return serve(c, true, { fromOfferingId, hop, cause }, primaryId);
    }
    return firstCooling
      ? serve(firstCooling.c, true, { fromOfferingId, hop: firstCooling.hop, cause }, primaryId)
      : null;
  };

  /**
   * A stored choice (session / policy) that cannot serve. With no fallback
   * list: W03's one same-route default (§9.1 bounded fallback). With a list:
   * the walk REPLACES that rule (spec §9.1, Codex review 9).
   */
  const storedFallback = async (
    stored: LoadedCandidate | null,
    storedReason: ResolveFailureReason,
    cause: FailoverCause,
  ): Promise<ResolveModelResult> => {
    const tried = new Set<string>();
    if (fallbackList.length === 0 && stored && defaultId && defaultId !== requestedId && !excluded.has(defaultId)) {
      tried.add(defaultId);
      const fb = await loadOfferingCandidate(defaultId, partnerId);
      const sameRoute = fb !== null && fb.connectionId === stored.connectionId && fb.funding === stored.funding;
      if (fb && sameRoute && checkEligibility(fb.facts, ctx) === null) {
        return serve(fb, true, { fromOfferingId: requestedId ?? null, hop: 1, cause }, requestedId ?? null);
      }
    }
    return (await walk(requestedId ?? null, stored, cause, 1 + tried.size, tried))
      ?? unavailable(storedReason, requestedId ?? null, stored?.displayName);
  };

  if (requestedId && requestedId !== defaultId) {
    const choiceAllowed = origin === 'policy' || assignment.allowUserChoice;
    if (!choiceAllowed || !permitted(requestedId)) {
      if (origin === 'user') return unavailable('not_permitted', requestedId);
      return storedFallback(await loadOfferingCandidate(requestedId, partnerId), 'not_permitted', 'ineligible');
    }
  }

  const primaryId = requestedId ?? defaultId;
  if (!primaryId) return unavailable('no_eligible_model', null);
  const primary = await loadOfferingCandidate(primaryId, partnerId);
  const reason: ResolveFailureReason | null = primary ? checkEligibility(primary.facts, ctx) : 'not_permitted';
  const freshUserPick = origin === 'user' && requestedId !== undefined;
  // A primary the dispatch origin does not allow (Codex review 4) is passed over like an excluded one.
  const isExcluded = excluded.has(primaryId) || (primary !== null && reason === null && !allowedFromOrigin(primary));

  if (primary && reason === null && !isExcluded) {
    if (freshUserPick || !cooling.has(primaryId)) return serve(primary, false, null, primaryId);
    return (await walk(primaryId, primary, 'cooldown', 1, new Set())) ?? serve(primary, false, null, primaryId);
  }
  const failReason: ResolveFailureReason = reason ?? 'model_unavailable';
  if (freshUserPick) return unavailable(failReason, primaryId, primary?.displayName);
  const cause: FailoverCause = isExcluded ? (input.failoverCause ?? 'server_error') : 'ineligible';
  if (requestedId && requestedId !== defaultId) return storedFallback(primary, failReason, cause);
  return (await walk(primaryId, primary, cause, 1, new Set()))
    ?? unavailable(failReason, primaryId, primary?.displayName);
}
```

`tryDefault` (W03) is replaced by `storedFallback`, whose first branch is W03's same-route rule verbatim, taken only when no fallback list is configured. Remove the now-unused `tryDefault` closure. Delete the `EffectiveAssignment` import if your linter reports it unused: it is only needed if you extract `walk` into a helper that takes the assignment.

In `__fixtures__/resolvedModel.ts`, add `failover: null,` and `failoverRemaining: [],` to `base`.

- [ ] **Step 4: Run the unit tests**

Run: `cd apps/api && npx vitest run src/services/aiModels/resolveModel.test.ts`
Expected: PASS. Every W03 case passes as well; W03's "refuses when the default is on a different connection" still returns `ok: false`, because those cases configure no fallback list.

- [ ] **Step 5: Integration seed + resolution cases**

`apps/api/src/__tests__/integration/helpers/aiModelFailoverSeed.ts`:

```ts
/**
 * W09 integration seed (#7607): ONE partner with three routes at three prices.
 * Not a test file.
 *   P  platform offering   200/1000/20/250 (seedRegistryPartner's)
 *   P2 platform offering   400/2000/40/500
 *   K  BYOK offering       100/500/10/125 (own price → rate source 'offering')
 * Every surface's partner assignment defaults to P (seedRegistryPartner).
 */
import { randomUUID } from 'node:crypto';
import { withSystemDbAccessContext } from '../../../db';
import { createConnection } from '../../../services/aiModels/connections';
import { fixtureSql, seedOffering } from '../aiModelRegistryFixtures';
import { seedPricedPlatformModel, seedRegistryPartner, type SeededRegistryPartner } from './aiModelRegistrySeed';

export interface SeededFailoverPartner extends SeededRegistryPartner {
  platformOfferingId: string;
  platformOffering2Id: string;
  byokOfferingId: string;
  byokConnectionId: string;
}

export async function seedFailoverPartner(): Promise<SeededFailoverPartner> {
  const s = await seedRegistryPartner('platform');
  const p2Model = await seedPricedPlatformModel();
  await fixtureSql`
    UPDATE ai_platform_models
       SET input_cents_per_m = 400, output_cents_per_m = 2000, cache_read_cents_per_m = 40, cache_write_cents_per_m = 500
     WHERE id = ${p2Model}`;
  const platformOffering2Id = await seedOffering({ partnerId: s.partnerId, platformModelId: p2Model, enabled: true });

  const conn = await withSystemDbAccessContext(() => createConnection({
    partnerId: s.partnerId, kind: 'anthropic_byok', name: 'W09 BYOK', apiKey: `sk-w09-${randomUUID()}`,
    catalogEntryId: null, connectedBy: s.userId, verifiedAt: new Date(),
  }));
  const byokOfferingId = await seedOffering({
    partnerId: s.partnerId, connectionId: conn.id, platformModelId: s.platformModelId, modelId: s.modelId,
    source: 'discovered', enabled: true,
  });
  await fixtureSql`
    UPDATE partner_ai_models
       SET price_input_cents_per_m = 100, price_output_cents_per_m = 500,
           price_cache_read_cents_per_m = 10, price_cache_write_cents_per_m = 125
     WHERE id = ${byokOfferingId}`;

  return { ...s, platformOfferingId: s.offeringId, platformOffering2Id, byokOfferingId, byokConnectionId: conn.id };
}

/** Sets a partner assignment's fallback list (and cross-funding flag) for (surface, role). */
export async function setPartnerFallbacks(
  s: SeededFailoverPartner, surface: string, ids: string[], crossFunding: boolean | null, role = 'default',
): Promise<void> {
  await fixtureSql`
    UPDATE ai_model_assignments
       SET fallback_offering_ids = ${ids}::uuid[], fallback_may_cross_funding = ${crossFunding}
     WHERE partner_id = ${s.partnerId} AND org_id IS NULL AND surface = ${surface} AND role = ${role}`;
}

/** Points a partner assignment's default at an offering. */
export async function setPartnerDefault(s: SeededFailoverPartner, surface: string, offeringId: string, role = 'default'): Promise<void> {
  await fixtureSql`
    UPDATE ai_model_assignments SET default_offering_id = ${offeringId}
     WHERE partner_id = ${s.partnerId} AND org_id IS NULL AND surface = ${surface} AND role = ${role}`;
}
```

W02's `price_*_cents_per_m` columns are named in its schema (`partner_ai_models.price_input_cents_per_m`, …). Check them with `\d partner_ai_models` if the update errors.

Append to `aiModelFailover.integration.test.ts` (add the imports `resolveModel`, `seedFailoverPartner`, `setPartnerDefault`, `setPartnerFallbacks`):

```ts
describe.runIf(RUN)('W09 resolution walk against real rows', () => {
  let f: Awaited<ReturnType<typeof seedFailoverPartner>>;
  const savedKey = process.env.ANTHROPIC_API_KEY;
  beforeEach(async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-w09-integration-placeholder';
    f = await seedFailoverPartner();
  });
  afterAll(() => { if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey; });

  it('walks to the next eligible fallback when the default is disabled', async () => {
    await setPartnerFallbacks(f, 'script_reviewer', [f.platformOffering2Id], false);
    await fixtureSql`UPDATE partner_ai_models SET enabled = false WHERE id = ${f.platformOfferingId}`;
    const r = await resolveModel({ partnerId: f.partnerId, orgId: f.orgId, surface: 'script_reviewer' });
    expect(r).toMatchObject({ ok: true, offering: { id: f.platformOffering2Id }, funding: 'platform',
      failover: { fromOfferingId: f.platformOfferingId, hop: 1, cause: 'ineligible' } });
  });

  it('a fallback whose connection went into error is skipped', async () => {
    await setPartnerFallbacks(f, 'script_reviewer', [f.byokOfferingId], true);
    await fixtureSql`UPDATE partner_ai_connections SET status = 'error' WHERE id = ${f.byokConnectionId}`;
    const r = await resolveModel({
      partnerId: f.partnerId, orgId: f.orgId, surface: 'script_reviewer',
      excludeOfferingIds: [f.platformOfferingId], failoverCause: 'overloaded',
    });
    expect(r).toMatchObject({ ok: false });
  });

  it('cross-funding: off → unavailable; partner on → served; an org override OFF beats partner ON', async () => {
    await setPartnerFallbacks(f, 'script_reviewer', [f.byokOfferingId], false);
    const ask = () => resolveModel({
      partnerId: f.partnerId, orgId: f.orgId, surface: 'script_reviewer',
      excludeOfferingIds: [f.platformOfferingId], failoverCause: 'overloaded',
    });
    expect(await ask()).toMatchObject({ ok: false });
    await setPartnerFallbacks(f, 'script_reviewer', [f.byokOfferingId], true);
    expect(await ask()).toMatchObject({ ok: true, offering: { id: f.byokOfferingId }, funding: 'partner_key' });
    await fixtureSql`
      INSERT INTO ai_model_assignments (org_id, offering_partner_id, surface, role, fallback_may_cross_funding)
      VALUES (${f.orgId}, ${f.partnerId}, 'script_reviewer', 'default', false)`;
    expect(await ask()).toMatchObject({ ok: false });
  });

  it('a triage run resolves the partner triage default under an org ai_agents default override (D2)', async () => {
    await fixtureSql`
      INSERT INTO ai_model_assignments (partner_id, offering_partner_id, surface, role, default_offering_id, allow_user_choice)
      VALUES (${f.partnerId}, ${f.partnerId}, 'ai_agents', 'triage', ${f.platformOffering2Id}, true)`;
    await fixtureSql`
      INSERT INTO ai_model_assignments (org_id, offering_partner_id, surface, role, default_offering_id)
      VALUES (${f.orgId}, ${f.partnerId}, 'ai_agents', 'default', ${f.platformOfferingId})`;
    const triage = await resolveModel({ partnerId: f.partnerId, orgId: f.orgId, surface: 'ai_agents', role: 'triage' });
    const deflt = await resolveModel({ partnerId: f.partnerId, orgId: f.orgId, surface: 'ai_agents' });
    expect(triage).toMatchObject({ ok: true, role: 'triage', offering: { id: f.platformOffering2Id } });
    expect(deflt).toMatchObject({ ok: true, role: 'default', offering: { id: f.platformOfferingId } });
  });
});
```

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiModelFailover.integration.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

Stage `resolveModel.ts`, `resolveModel.test.ts`, `__fixtures__/resolvedModel.ts`, `helpers/aiModelFailoverSeed.ts` and the integration test. Commit message: `feat(ai-models): resolveModel walks the ordered fallback list under the funding and connection rules (#7607)`, ending with the Co-Authored-By trailer.

---

## Task 6: Failover on the turn binding, the ledger and session stamping

**Files:**
- Modify: `apps/api/src/services/aiModels/turnBinding.ts`, `turnBinding.test.ts`
- Modify: `apps/api/src/services/aiModels/invocationLedgerWrite.ts`
- Modify: `apps/api/src/services/aiModels/settleInvocation.ts`, `settleInvocation.test.ts`
- Modify: `apps/api/src/services/aiBudgetReservations.ts`
- Modify: `apps/api/src/__tests__/integration/aiModelFailover.integration.test.ts` (append)

**Interfaces:**
- Consumes: Task 5 `ResolvedModel.failover`; Task 3 `FAILOVER_CAUSES`.
- Produces:
  - `TurnBinding.failover?: { fromOfferingId: string | null; hop: number; cause: FailoverCause } | null`. `v` stays `1`, and a binding stored before W09 parses with `failover` absent.
  - `NewInvocation.{failoverFromOfferingId?, failoverHop?, failoverCause?}`.
  - `toNewInvocations` writes them from the binding.
  - `stampSessionBinding` leaves the session's stored choice alone for a transient failover (D6).
  - `export const TRANSIENT_FAILOVER_CAUSES: ReadonlySet<FailoverCause>` (in `failover.ts`).

- [ ] **Step 1: Write the failing tests**

Append to `turnBinding.test.ts`:

```ts
import { makeResolvedModel } from './__fixtures__/resolvedModel';

describe('W09 failover on the binding', () => {
  it('carries the resolver\'s failover facts and round-trips them', () => {
    const b = turnBindingFrom(makeResolvedModel('anthropic_byok', {
      failover: { fromOfferingId: 'off-0', hop: 1, cause: 'overloaded' },
    }));
    expect(b.failover).toEqual({ fromOfferingId: 'off-0', hop: 1, cause: 'overloaded' });
    expect(parseTurnBinding(JSON.parse(JSON.stringify(b)))?.failover).toEqual(b.failover);
  });

  it('a binding stored before W09 (no failover key) still parses', () => {
    const b = turnBindingFrom(makeResolvedModel('platform'));
    const { failover: _f, ...legacy } = b;
    expect(parseTurnBinding(legacy)).not.toBeNull();
  });

  it('failover is not part of the live-query key (the wire model already differs)', () => {
    const a = turnBindingFrom(makeResolvedModel('platform'));
    const b = turnBindingFrom(makeResolvedModel('platform', { failover: { fromOfferingId: 'x', hop: 1, cause: 'cooldown' } }));
    expect(liveQueryKey(a)).toBe(liveQueryKey(b));
  });
});
```

Append to `settleInvocation.test.ts`:

```ts
describe('W09 ledger provenance', () => {
  it('toNewInvocations writes the SERVED hop\'s offering, connection and funding, plus where it failed over from', () => {
    const binding = turnBindingFrom(makeResolvedModel('anthropic_byok', {
      offering: { id: 'off-k', displayName: 'K' },
      failover: { fromOfferingId: 'off-p', hop: 1, cause: 'rate_limited' },
    }));
    const [row] = toNewInvocations({
      binding, orgId: 'org-1', userId: null, sessionId: null, agentRunId: null, sourceRef: null,
      usage: [], outcome: { stopReason: 'end_turn', refused: false, refusalCategory: null, fallbackUsed: false,
        servedModel: binding.wireModel, providerModel: null, sdkReportedCostUsd: null },
    }, priceUsage(binding, []));
    expect(row).toMatchObject({
      offeringId: 'off-k', connectionId: 'conn-1', fundingSource: 'partner_key',
      failoverFromOfferingId: 'off-p', failoverHop: 1, failoverCause: 'rate_limited',
    });
  });

  it('a turn with no failover writes hop 0 and no cause', () => {
    const binding = turnBindingFrom(makeResolvedModel('platform'));
    const [row] = toNewInvocations({
      binding, orgId: 'org-1', userId: null, sessionId: null, agentRunId: null, sourceRef: null,
      usage: [], outcome: { stopReason: 'end_turn', refused: false, refusalCategory: null, fallbackUsed: false,
        servedModel: binding.wireModel, providerModel: null, sdkReportedCostUsd: null },
    }, priceUsage(binding, []));
    expect(row).toMatchObject({ failoverFromOfferingId: null, failoverHop: 0, failoverCause: null });
  });
});
```

Append to `aiModelFailover.integration.test.ts`:

```ts
describe.runIf(RUN)('W09 session stamping (D6)', () => {
  async function sessionOffering(id: string): Promise<string | null> {
    const [row] = await fixtureSql`SELECT offering_id FROM ai_sessions WHERE id = ${id}`;
    return (row?.offering_id as string | null) ?? null;
  }

  it('a transient failover hop does not replace the session\'s stored choice; an ineligible one does', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-w09-integration-placeholder';
    const f = await seedFailoverPartner();
    await setPartnerFallbacks(f, 'chat', [f.platformOffering2Id], false);
    const hop = await resolveModel({
      partnerId: f.partnerId, orgId: f.orgId, surface: 'chat',
      excludeOfferingIds: [f.platformOfferingId], failoverCause: 'overloaded',
    });
    if (!hop.ok) throw new Error(hop.reason);
    await reserveAiBudget({ orgId: f.orgId, idempotencyKey: `w09:${randomUUID()}`, billingSource: hop.funding,
      sessionId: f.chatSessionId, binding: turnBindingFrom(hop) });
    expect(await sessionOffering(f.chatSessionId)).toBe(f.platformOfferingId);   // unchanged

    await fixtureSql`UPDATE partner_ai_models SET enabled = false WHERE id = ${f.platformOfferingId}`;
    const moved = await resolveModel({ partnerId: f.partnerId, orgId: f.orgId, surface: 'chat',
      requested: { offeringId: f.platformOfferingId, origin: 'session' } });
    if (!moved.ok) throw new Error(moved.reason);
    await reserveAiBudget({ orgId: f.orgId, idempotencyKey: `w09:${randomUUID()}`, billingSource: moved.funding,
      sessionId: f.chatSessionId, binding: turnBindingFrom(moved) });
    expect(await sessionOffering(f.chatSessionId)).toBe(f.platformOffering2Id);  // the old choice is gone: sticky
  });
});
```

Add `import { randomUUID } from 'node:crypto';`, `reserveAiBudget` and `turnBindingFrom` to the file's imports.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/turnBinding.test.ts src/services/aiModels/settleInvocation.test.ts`
Expected: FAIL. `b.failover` is undefined, and the row lacks `failoverHop`.

- [ ] **Step 3: Implement**

`failover.ts` gains:

```ts
/** D6: causes that leave a session's own choice in place (it is retried next turn). */
export const TRANSIENT_FAILOVER_CAUSES: ReadonlySet<FailoverCause> = new Set<FailoverCause>([
  'cooldown', 'rate_limited', 'overloaded', 'server_error', 'auth_failed', 'quota_exhausted',
]);
```

`turnBinding.ts`:
- import `FAILOVER_CAUSES, type FailoverCause` from `./failover`;
- add to `TurnBinding`: `/** W09: set when a failover hop serves this turn; absent on bindings stored before W09. */ failover?: { fromOfferingId: string | null; hop: number; cause: FailoverCause } | null;`;
- in `turnBindingFrom`: `failover: r.failover ?? null,`;
- in `turnBindingSchema`: `failover: z.object({ fromOfferingId: z.string().nullable(), hop: z.number().int().min(1).max(6), cause: z.enum(FAILOVER_CAUSES) }).nullable().optional(),`.

`wireFingerprint` and `liveQueryKey` are unchanged.

`invocationLedgerWrite.ts`: add `failoverFromOfferingId?: string | null; failoverHop?: number; failoverCause?: FailoverCause | null;` to `NewInvocation`, and map them in `recordInvocation`:

```ts
    failoverFromOfferingId: row.failoverFromOfferingId ?? null,
    failoverHop: row.failoverHop ?? 0,
    failoverCause: row.failoverCause ?? null,
```

`settleInvocation.ts` `toNewInvocations`: after `fallbackUsed: servedByFallback,`, add

```ts
      // W09 (F5): this row is the SERVED hop's (offering/connection/funding
      // above come from its own binding); these record where it failed over from.
      failoverFromOfferingId: b.failover?.fromOfferingId ?? null,
      failoverHop: b.failover?.hop ?? 0,
      failoverCause: b.failover?.cause ?? null,
```

`aiBudgetReservations.ts` `stampSessionBinding`: replace its first line `if (!binding.offeringId) return;` with:

```ts
  if (!binding.offeringId) return;
  // W09 (D6): a hop that served because the session's own choice was
  // TRANSIENTLY failing (cooldown, 429/529/5xx, key/quota) does not replace
  // that choice; the next turn retries it. A failover because the choice is
  // gone ('ineligible') stamps, like W03's bounded fallback. The existence
  // check the UPDATE gave is kept.
  if (binding.failover && TRANSIENT_FAILOVER_CAUSES.has(binding.failover.cause)) {
    const exists = rows<{ id: string }>(await db.execute<{ id: string }>(sql`
      SELECT id FROM ai_sessions WHERE id = ${sessionId}::uuid AND org_id = ${orgId}::uuid
    `))[0];
    if (!exists) throw new Error('AI session not found in reservation organization');
    return;
  }
```

Import `TRANSIENT_FAILOVER_CAUSES` from `./aiModels/failover`.

- [ ] **Step 4: Run tests**

Run: `cd apps/api && npx vitest run src/services/aiModels/turnBinding.test.ts src/services/aiModels/settleInvocation.test.ts src/services/aiBudgetReservations.test.ts`
Then: `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiModelFailover.integration.test.ts src/__tests__/integration/aiInvocationSettlement.integration.test.ts`
Expected: PASS. The W03 settlement suite passes unchanged: its bindings carry no failover, so they write hop 0.

- [ ] **Step 5: Commit**

Stage the eight files. Commit message: `feat(ai-models): failover provenance on the turn binding and ledger; transient failover never re-stamps a session (#7607)`, ending with the Co-Authored-By trailer.

---

## Task 7: `runWithFailover` — per-hop admission, reservation and settlement; the script reviewer; the funding suite

**Files:**
- Create: `apps/api/src/services/aiModels/failoverDispatch.ts`, `failoverDispatch.test.ts`
- Modify: `apps/api/src/services/scriptProposals/reviewer.ts`, `reviewer.test.ts`
- Create: `apps/api/src/__tests__/integration/aiModelFailoverFunding.integration.test.ts`
- Modify: `apps/api/src/services/aiModels/index.ts`

**Interfaces:**
- Consumes: Task 3 (`classifyProviderError`, `hopIdempotencyKey`, `MAX_FAILOVER_HOP`, `noteProviderFailure`); Task 5 (`resolveModel` with `excludeOfferingIds`); Task 6; P6, P8, P9, P10, P11.
- Produces:

```ts
export interface FailoverHop {
  index: number; resolved: ResolvedModel; binding: TurnBinding; reservationId: string; idempotencyKey: string;
  /** This hop's own reserved allowance (null = uncapped). Surfaces size max_tokens from it, never from hop 0's (Codex review 6). */
  reservedCostCents: number | null;
}
export type HopReservation =
  | { ok: true; reservationId: string; reservedCostCents: number | null }
  | { ok: false; reason: 'credits' | 'budget'; message: string };
export class FailoverExhaustedError extends Error {
  readonly code: 'failover_exhausted';
  readonly lastError: unknown; readonly lastHop: FailoverHop;
  readonly stop: 'no_next_hop' | 'admission_denied'; readonly admissionMessage: string | null;
}
export function runWithFailover<T>(input: {
  first: FailoverHop;
  reResolve: (args: { excludeOfferingIds: string[]; cause: ProviderFailureCause; origin: FailoverOrigin }) => Promise<ResolveModelResult>;
  reserveHop: (resolved: ResolvedModel, binding: TurnBinding, idempotencyKey: string) => Promise<HopReservation>;
  attempt: (hop: FailoverHop) => Promise<T>;
  settleFailedHop: (hop: FailoverHop, error: unknown) => Promise<void>;
  isPreOutput?: (error: unknown) => boolean;
}): Promise<{ value: T; hop: FailoverHop }>;
export function failoverOriginOf(resolved: ResolvedModel): FailoverOrigin;
export function reserveFailoverHop(base: { orgId: string; sessionId?: string | null; namespace?: AiBudgetNamespace;
  clientBudget?: ClientAiBudgetCaps; maxHoldCents?: number }): FailoverHopReserver;
export function settleZeroUsageHop(ctx: { orgId: string; userId: string | null; sessionId: string | null;
  agentRunId: string | null; sourceRef: string | null }): (hop: FailoverHop) => Promise<void>;
export function isPreOutputMessagesFailure(error: unknown): boolean;
// connectionFactory.ts (W03 file, Codex review 3)
export class MessageDispatchError extends Error { readonly attempts: MessageAttempt[]; }  // cause = the provider error
export function attemptsOf(error: unknown): MessageAttempt[];
```

The contract:
- `runWithFailover` throws the **original** error, with the failed hop **unsettled**, whenever no failover applies. That covers an unclassified error, an error after output, and a resolved model with no `failoverRemaining`. The surface's own W03 failure handling then runs unchanged.
- It throws `FailoverExhaustedError` only **after** it settled the failed hop itself. The surface must not settle `lastHop` again.

- [ ] **Step 1: Write the failing unit tests**

`apps/api/src/services/aiModels/failoverDispatch.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  noteProviderFailure: vi.fn(async () => undefined),
  checkBudgetDetailed: vi.fn(async () => null),
  reserveAiBudget: vi.fn(async (i: { idempotencyKey: string }) => ({ kind: 'reserved', reservationId: `res:${i.idempotencyKey}`, reservedCostCents: 50, dailyPeriodKey: 'd', monthlyPeriodKey: 'm', status: 'active' })),
  settleInvocation: vi.fn(async () => ({ costCents: 0, invocationIds: ['inv'], deferred: false })),
}));
vi.mock('./offeringHealth', () => ({ noteProviderFailure: h.noteProviderFailure }));
vi.mock('../aiCostTracker', () => ({ checkBudgetDetailed: h.checkBudgetDetailed }));
vi.mock('../aiBudgetReservations', () => ({ reserveAiBudget: h.reserveAiBudget }));
vi.mock('./settleInvocation', () => ({ settleInvocation: h.settleInvocation }));

import { makeResolvedModel } from './__fixtures__/resolvedModel';
import { attemptsOf, MessageDispatchError } from './connectionFactory';
import {
  FailoverExhaustedError,
  isPreOutputMessagesFailure,
  reserveFailoverHop,
  runWithFailover,
  settleZeroUsageHop,
  type FailoverHop,
} from './failoverDispatch';
import { turnBindingFrom } from './turnBinding';

const overloaded = () => Object.assign(new Error('Overloaded'), {
  status: 529, error: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
});
const primary = makeResolvedModel('platform', { offering: { id: 'p', displayName: 'P' }, failoverRemaining: ['k'] });
const backup = makeResolvedModel('anthropic_byok', {
  offering: { id: 'k', displayName: 'K' }, failover: { fromOfferingId: 'p', hop: 1, cause: 'overloaded' }, failoverRemaining: [],
});
const first = (): FailoverHop => ({ index: 0, resolved: primary, binding: turnBindingFrom(primary), reservationId: 'res0', idempotencyKey: 'base', reservedCostCents: 50 });
const ctx = { orgId: 'org-1', userId: null, sessionId: null, agentRunId: null, sourceRef: 'w09' };

beforeEach(() => vi.clearAllMocks());

describe('runWithFailover', () => {
  it('on a pre-output 529: cools the primary, settles it on ITS reservation, re-resolves excluding it, reserves the next hop under base:hop:1', async () => {
    const reResolve = vi.fn(async () => backup);
    const attempt = vi.fn()
      .mockRejectedValueOnce(overloaded())
      .mockResolvedValueOnce('served');
    const out = await runWithFailover({
      first: first(), reResolve, reserveHop: reserveFailoverHop({ orgId: 'org-1' }), attempt,
      settleFailedHop: settleZeroUsageHop(ctx),
    });
    expect(h.noteProviderFailure).toHaveBeenCalledWith(primary, 'overloaded');
    expect(h.settleInvocation).toHaveBeenCalledTimes(1);
    expect(h.settleInvocation.mock.calls[0]![0]).toMatchObject({ reservationId: 'res0', usage: [], binding: { offeringId: 'p', funding: 'platform' } });
    expect(reResolve).toHaveBeenCalledWith({
      excludeOfferingIds: ['p'], cause: 'overloaded', origin: { offeringId: 'p', funding: 'platform', connectionId: null },
    });
    expect(h.checkBudgetDetailed).toHaveBeenCalledWith('org-1', 'partner_key');           // the NEXT hop's funding
    expect(h.reserveAiBudget).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'base:hop:1', billingSource: 'partner_key', binding: expect.objectContaining({ offeringId: 'k' }),
    }));
    expect(out).toMatchObject({ value: 'served', hop: { index: 1, reservationId: 'res:base:hop:1', reservedCostCents: 50, binding: { offeringId: 'k' } } });
  });

  it('a refusal answered, then its catalog refusal-fallback failing with 529, carries the burned attempt and never fails over (Codex 3)', async () => {
    const burned = [{ wireModel: 'w', message: { stop_reason: 'refusal' } }];
    const err = new MessageDispatchError(burned as never, overloaded());
    const reResolve = vi.fn();
    await expect(runWithFailover({ first: first(), reResolve, reserveHop: vi.fn(), attempt: vi.fn().mockRejectedValue(err),
      settleFailedHop: vi.fn(), isPreOutput: isPreOutputMessagesFailure })).rejects.toBe(err);
    expect(reResolve).not.toHaveBeenCalled();
    expect(attemptsOf(err)).toBe(burned);
  });

  it('an unclassified error is rethrown with the hop UNSETTLED (the surface\'s W03 handling runs)', async () => {
    const err = new Error('parse failure');
    await expect(runWithFailover({ first: first(), reResolve: vi.fn(), reserveHop: vi.fn(), attempt: vi.fn().mockRejectedValue(err), settleFailedHop: vi.fn() }))
      .rejects.toBe(err);
    expect(h.settleInvocation).not.toHaveBeenCalled();
  });

  it('no configured fallback: the original error, unsettled, after marking the cooldown', async () => {
    const lone: FailoverHop = { ...first(), resolved: { ...primary, failoverRemaining: [] } };
    const err = overloaded();
    const settleFailedHop = vi.fn();
    await expect(runWithFailover({ first: lone, reResolve: vi.fn(), reserveHop: vi.fn(), attempt: vi.fn().mockRejectedValue(err), settleFailedHop }))
      .rejects.toBe(err);
    expect(settleFailedHop).not.toHaveBeenCalled();
    expect(h.noteProviderFailure).toHaveBeenCalled();
  });

  it('after output (isPreOutput false): never fails over', async () => {
    const err = Object.assign(overloaded(), { attempts: [{ wireModel: 'x', message: {} }] });
    const reResolve = vi.fn();
    await expect(runWithFailover({ first: first(), reResolve, reserveHop: vi.fn(), attempt: vi.fn().mockRejectedValue(err),
      settleFailedHop: vi.fn(), isPreOutput: isPreOutputMessagesFailure })).rejects.toBe(err);
    expect(reResolve).not.toHaveBeenCalled();
  });

  it('nothing to fail over to: FailoverExhaustedError, with the failed hop already settled', async () => {
    const settleFailedHop = vi.fn(async () => undefined);
    const e = await runWithFailover({
      first: first(), reResolve: vi.fn(async () => ({ ok: false, reason: 'model_unavailable', recoverable: true, offeringId: null, message: 'x' })),
      reserveHop: vi.fn(), attempt: vi.fn().mockRejectedValue(overloaded()), settleFailedHop,
    }).catch((x) => x);
    expect(e).toBeInstanceOf(FailoverExhaustedError);
    expect([e.stop, e.lastHop.index]).toEqual(['no_next_hop', 0]);
    expect(settleFailedHop).toHaveBeenCalledTimes(1);
  });

  it('the next hop\'s admission is denied (credits): stops, reserves nothing', async () => {
    h.checkBudgetDetailed.mockResolvedValueOnce({ message: 'Out of AI credits', code: 'credits_exhausted' } as never);
    const e = await runWithFailover({
      first: first(), reResolve: vi.fn(async () => backup), reserveHop: reserveFailoverHop({ orgId: 'org-1' }),
      attempt: vi.fn().mockRejectedValue(overloaded()), settleFailedHop: vi.fn(async () => undefined),
    }).catch((x) => x);
    expect([e.stop, e.admissionMessage]).toEqual(['admission_denied', 'Out of AI credits']);
    expect(h.reserveAiBudget).not.toHaveBeenCalled();
  });

  it('a re-resolution that returns an already-tried offering is not retried', async () => {
    const e = await runWithFailover({
      first: first(), reResolve: vi.fn(async () => primary), reserveHop: vi.fn(),
      attempt: vi.fn().mockRejectedValue(overloaded()), settleFailedHop: vi.fn(async () => undefined),
    }).catch((x) => x);
    expect(e).toBeInstanceOf(FailoverExhaustedError);
  });
});

describe('settleZeroUsageHop', () => {
  it('settles zero usage with stop reason error, messageCount 0, on the hop\'s own reservation', async () => {
    await settleZeroUsageHop(ctx)(first());
    expect(h.settleInvocation).toHaveBeenCalledWith(expect.objectContaining({
      reservationId: 'res0', usage: [], messageCount: 0, toolExecutionCount: 0, turnCount: 0,
      outcome: expect.objectContaining({ stopReason: 'error', refused: false }),
    }));
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/failoverDispatch.test.ts`
Expected: FAIL, `Cannot find module './failoverDispatch'`.

- [ ] **Step 3: Implement `failoverDispatch.ts`**

```ts
/**
 * AI model registry W09 (#7607): dispatch-time failover for one call.
 *
 * Funding rules (plan F3–F6), in order, on a classified PRE-OUTPUT provider
 * failure of hop n:
 *   1. the offering cools down (offeringHealth);
 *   2. hop n is settled on ITS OWN binding and reservation (zero tokens: a
 *      status response bills nothing) — never carried into hop n+1;
 *   3. resolveModel is asked again with every tried offering excluded, so the
 *      permitted set, live eligibility, the funding rule (F1) and the
 *      connection rule are all re-checked for hop n+1 (F2);
 *   4. hop n+1 is admitted for ITS funding (credits on platform, caps on
 *      both) and reserved under `<base>:hop:<n+1>` with ITS binding (F3);
 *   5. the surface settles the serving hop on that hop's binding and
 *      reservation (F5); W03's exactly-once platform debit does the rest (F6).
 * Anything else — an unclassified error, an error after output, or a model
 * with nothing configured to fail over to — rethrows the ORIGINAL error with
 * the hop unsettled, so the surface's W03 failure handling is unchanged.
 */
import {
  reserveAiBudget,
  type AiBudgetNamespace,
  type ClientAiBudgetCaps,
} from '../aiBudgetReservations';
import { checkBudgetDetailed } from '../aiCostTracker';
import { attemptsOf } from './connectionFactory';
import { classifyProviderError, hopIdempotencyKey, MAX_FAILOVER_HOP, type ProviderFailureCause } from './failover';
import { noteProviderFailure } from './offeringHealth';
import type { FailoverOrigin, ResolvedModel, ResolveModelResult } from './resolveModel';
import { settleInvocation } from './settleInvocation';
import { turnBindingFrom, type TurnBinding } from './turnBinding';

export interface FailoverHop {
  /** 0 = the call's own first dispatch. */
  index: number;
  resolved: ResolvedModel;
  binding: TurnBinding;
  reservationId: string;
  idempotencyKey: string;
  /** This hop's own reserved allowance (null = uncapped); size max_tokens from it (Codex review 6). */
  reservedCostCents: number | null;
}

/** The first hop's funding/connection: every re-resolution is judged against it (Codex review 4). */
export function failoverOriginOf(resolved: ResolvedModel): FailoverOrigin {
  return { offeringId: resolved.offering.id, funding: resolved.funding, connectionId: resolved.connection.id };
}

export type HopReservation =
  | { ok: true; reservationId: string; reservedCostCents: number | null }
  | { ok: false; reason: 'credits' | 'budget'; message: string };

export type FailoverHopReserver = (resolved: ResolvedModel, binding: TurnBinding, idempotencyKey: string) => Promise<HopReservation>;

export class FailoverExhaustedError extends Error {
  readonly code = 'failover_exhausted' as const;
  constructor(
    readonly lastError: unknown,
    /** Already settled by runWithFailover: the caller must not settle it again. */
    readonly lastHop: FailoverHop,
    readonly stop: 'no_next_hop' | 'admission_denied',
    readonly admissionMessage: string | null = null,
  ) {
    super(stop === 'admission_denied'
      ? `AI failover stopped: ${admissionMessage ?? 'the backup model was not admitted'}`
      : 'AI failover found no other usable model');
    this.name = 'FailoverExhaustedError';
  }
}

export async function runWithFailover<T>(input: {
  first: FailoverHop;
  reResolve: (args: { excludeOfferingIds: string[]; cause: ProviderFailureCause; origin: FailoverOrigin }) => Promise<ResolveModelResult>;
  reserveHop: FailoverHopReserver;
  attempt: (hop: FailoverHop) => Promise<T>;
  settleFailedHop: (hop: FailoverHop, error: unknown) => Promise<void>;
  isPreOutput?: (error: unknown) => boolean;
}): Promise<{ value: T; hop: FailoverHop }> {
  const baseKey = input.first.idempotencyKey;
  const origin = failoverOriginOf(input.first.resolved);
  let hop = input.first;
  const tried: string[] = hop.resolved.offering.id ? [hop.resolved.offering.id] : [];
  for (;;) {
    let error: unknown;
    try {
      return { value: await input.attempt(hop), hop };
    } catch (caught) {
      error = caught;
    }
    const cause = classifyProviderError(error);
    if (cause === null || !(input.isPreOutput?.(error) ?? true)) throw error;
    await noteProviderFailure(hop.resolved, cause);
    if (hop.resolved.failoverRemaining.length === 0 || hop.index + 1 > MAX_FAILOVER_HOP) throw error;

    await input.settleFailedHop(hop, error);                                       // F4
    const next = await input.reResolve({ excludeOfferingIds: [...tried], cause, origin });  // F1 vs the origin, F2
    if (!next.ok || next.offering.id === null || tried.includes(next.offering.id)) {
      throw new FailoverExhaustedError(error, hop, 'no_next_hop');
    }
    const binding = turnBindingFrom(next);
    const index = hop.index + 1;
    const idempotencyKey = hopIdempotencyKey(baseKey, index);
    const reservation = await input.reserveHop(next, binding, idempotencyKey);     // F3
    if (!reservation.ok) throw new FailoverExhaustedError(error, hop, 'admission_denied', reservation.message);
    console.warn('[failover] dispatching the next hop', {
      surface: next.surface, fromOfferingId: hop.resolved.offering.id, toOfferingId: next.offering.id,
      fromFunding: hop.resolved.funding, toFunding: next.funding, cause, hop: index,
    });
    tried.push(next.offering.id);
    hop = { index, resolved: next, binding, reservationId: reservation.reservationId, idempotencyKey,
      reservedCostCents: reservation.reservedCostCents };
  }
}

/** F3: admission (credits + caps) for THIS hop's funding, then its reservation with its binding. */
export function reserveFailoverHop(base: {
  orgId: string;
  sessionId?: string | null;
  namespace?: AiBudgetNamespace;
  clientBudget?: ClientAiBudgetCaps;
  maxHoldCents?: number;
}): FailoverHopReserver {
  return async (resolved, binding, idempotencyKey) => {
    const denial = await checkBudgetDetailed(base.orgId, resolved.funding);
    if (denial) return { ok: false, reason: 'credits', message: denial.message };
    const r = await reserveAiBudget({
      orgId: base.orgId,
      idempotencyKey,
      billingSource: resolved.funding,
      binding,
      ...(base.sessionId ? { sessionId: base.sessionId } : {}),
      ...(base.namespace ? { namespace: base.namespace } : {}),
      ...(base.clientBudget ? { clientBudget: base.clientBudget } : {}),
      ...(base.maxHoldCents !== undefined ? { maxHoldCents: base.maxHoldCents } : {}),
    });
    if (r.kind === 'denied') return { ok: false, reason: 'budget', message: r.message };
    return { ok: true, reservationId: r.reservationId, reservedCostCents: r.kind === 'reserved' ? r.reservedCostCents : null };
  };
}

/** F4: a status-response failure billed nothing: a zero-token `error` row on the hop's own reservation. */
export function settleZeroUsageHop(ctx: {
  orgId: string; userId: string | null; sessionId: string | null; agentRunId: string | null; sourceRef: string | null;
}): (hop: FailoverHop) => Promise<void> {
  return async (hop) => {
    await settleInvocation({
      binding: hop.binding,
      orgId: ctx.orgId,
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      agentRunId: ctx.agentRunId,
      sourceRef: ctx.sourceRef,
      usage: [],
      outcome: {
        stopReason: 'error', refused: false, refusalCategory: null, fallbackUsed: false,
        servedModel: hop.binding.wireModel, providerModel: null, sdkReportedCostUsd: null,
      },
      reservationId: hop.reservationId,
      messageCount: 0,
      toolExecutionCount: 0,
      turnCount: 0,
    });
  };
}

/**
 * Pre-output only when no provider response came back. Reads the surface's own
 * `attempts` (Office/ticket draft errors) and connectionFactory's
 * MessageDispatchError (a refusal answered before its fallback failed).
 */
export function isPreOutputMessagesFailure(error: unknown): boolean {
  return attemptsOf(error).length === 0;
}
```

In `connectionFactory.ts` (W03), make `createMessage` keep a burned attempt when a later call in the same dispatch throws (Codex review 3). Without this, a catalog refusal that was answered and billed, followed by its client-side refusal fallback failing with a 529, loses the first message. W09 would then settle it at zero and fail over.

```ts
/** A dispatch that failed AFTER at least one provider response: carries what was billed. `cause` is the provider error. */
export class MessageDispatchError extends Error {
  constructor(readonly attempts: MessageAttempt[], cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'MessageDispatchError';
  }
}

/** Completed attempts carried by a dispatch error (MessageDispatchError or a surface error with `attempts`). */
export function attemptsOf(error: unknown): MessageAttempt[] {
  const attempts = error && typeof error === 'object' ? (error as { attempts?: unknown }).attempts : undefined;
  return Array.isArray(attempts) ? (attempts as MessageAttempt[]) : [];
}
```

In `createMessage`'s client-side branch, wrap the second call:

```ts
  if (fb && first.stop_reason === 'refusal') {
    let second: Anthropic.Message;
    try {
      second = await client.messages.create({ ...capped, ...messagesModelParams(fb) } as never,
        ...(requestOptions ? [requestOptions] : [])) as Anthropic.Message;
    } catch (error) {
      throw new MessageDispatchError([{ wireModel: resolved.wireModel, message: first }], error);
    }
    return {
      message: second,
      attempts: [{ wireModel: resolved.wireModel, message: first }, { wireModel: fb.wireModel, message: second }],
    };
  }
```

`classifyProviderError` walks `cause`, so the error still classifies. `isPreOutputMessagesFailure` sees one attempt and refuses to fail over. The surfaces then settle `attemptsOf(error)`. `aiEmailDraft.ts` / `aiTicketDraft.ts` must also push `attemptsOf(err)` into their `attempts` before wrapping a `createMessage` error (`attempts.push(...attemptsOf(err))` before `return fail(err, true)`). Add a `connectionFactory.test.ts` case: client-side refusal fallback rejecting with 529 → `MessageDispatchError` with one attempt and `cause.status === 529`.

Append `export * from './failoverDispatch';` to `services/aiModels/index.ts`. If that creates an import cycle (`aiBudgetReservations` → `aiModels/index`), re-export only the types from the index and import the module directly at call sites.

- [ ] **Step 4: Run the unit tests**

Run: `cd apps/api && npx vitest run src/services/aiModels/failoverDispatch.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing funding suite (real Postgres)**

`apps/api/src/__tests__/integration/aiModelFailoverFunding.integration.test.ts`:

```ts
/**
 * AI model registry W09 (#7607): the failover FUNDING contract against real
 * Postgres + a recording billing stub. A hop is admitted, reserved, settled
 * and debited on its own; a failover never double-debits, never skips a
 * debit, and never bills a hop at another hop's rate.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { messagesUsage } from '../../services/aiModels/invocationUsage';
import {
  FailoverExhaustedError,
  reserveFailoverHop,
  runWithFailover,
  settleZeroUsageHop,
  type FailoverHop,
} from '../../services/aiModels/failoverDispatch';
import { priceInvocation } from '../../services/aiModels/pricing';
import { resolveModel } from '../../services/aiModels/resolveModel';
import { settleInvocation } from '../../services/aiModels/settleInvocation';
import { turnBindingFrom } from '../../services/aiModels/turnBinding';
import { closeRegistryFixtures, fixtureSql } from './aiModelRegistryFixtures';
import { seedFailoverPartner, setPartnerFallbacks, type SeededFailoverPartner } from './helpers/aiModelFailoverSeed';

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);

const SURFACE = 'script_reviewer' as const;
const TOKENS = { input: 1000, output: 400 };
const P_RATE = { inputCentsPerM: 200, outputCentsPerM: 1000, cacheReadCentsPerM: 20, cacheWriteCentsPerM: 250 };
const P2_RATE = { inputCentsPerM: 400, outputCentsPerM: 2000, cacheReadCentsPerM: 40, cacheWriteCentsPerM: 500 };

// Billing service stub: credits checks answer `allowed` unless scripted; every deduct is recorded.
type Deduct = { key: string | null; costCents: number };
let deducts: Deduct[] = [];
let creditsAllowed = true;
function installBillingStub(): void {
  process.env.BILLING_SERVICE_URL = 'https://billing.test.invalid';
  process.env.BILLING_SERVICE_API_KEY = 'test-billing-key';
  deducts = [];
  creditsAllowed = true;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/ai-credits/deduct')) {
      const body = JSON.parse(String(init!.body)) as { costCents: number; idempotencyKey?: string };
      deducts.push({ key: body.idempotencyKey ?? null, costCents: body.costCents });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    if (u.includes('/ai-credits')) {
      return new Response(JSON.stringify({ allowed: creditsAllowed, remainingCredits: creditsAllowed ? 100_000 : 0, plan: 'pro' }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${u}`);
  }));
}

const status = (code: number, type: string) => Object.assign(new Error(type), { status: code, error: { type: 'error', error: { type, message: type } } });
function message(model: string) {
  return {
    id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model,
    content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: TOKENS.input, output_tokens: TOKENS.output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as never;
}

async function firstHop(f: SeededFailoverPartner): Promise<FailoverHop> {
  const r = await resolveModel({ partnerId: f.partnerId, orgId: f.orgId, surface: SURFACE });
  if (!r.ok) throw new Error(`resolveModel: ${r.reason}`);
  const binding = turnBindingFrom(r);
  const key = `w09-funding:${randomUUID()}`;
  const res = await reserveFailoverHop({ orgId: f.orgId })(r, binding, key);
  if (!res.ok) throw new Error(res.message);
  return { index: 0, resolved: r, binding, reservationId: res.reservationId, idempotencyKey: key, reservedCostCents: res.reservedCostCents };
}

/** One dispatch: each attempt throws the next scripted error, then serves; the serving hop is settled like a surface would. */
async function dispatch(f: SeededFailoverPartner, script: Array<Error | 'serve'>) {
  const first = await firstHop(f);
  const queue = [...script];
  const out = await runWithFailover({
    first,
    reResolve: ({ excludeOfferingIds, cause, origin }) => resolveModel({
      partnerId: f.partnerId, orgId: f.orgId, surface: SURFACE, excludeOfferingIds, failoverCause: cause, failoverOrigin: origin,
    }),
    reserveHop: reserveFailoverHop({ orgId: f.orgId }),
    attempt: async (hop) => {
      const next = queue.shift();
      if (next !== 'serve') throw next;
      return { wireModel: hop.binding.wireModel, message: message(hop.binding.wireModel) };
    },
    settleFailedHop: settleZeroUsageHop({ orgId: f.orgId, userId: null, sessionId: null, agentRunId: null, sourceRef: 'w09' }),
  });
  const settled = await settleInvocation({
    binding: out.hop.binding, orgId: f.orgId, userId: null, sessionId: null, agentRunId: null, sourceRef: 'w09',
    ...messagesUsage(out.hop.binding, [out.value]), reservationId: out.hop.reservationId,
  });
  return { first, out, settled };
}

async function q<R extends Record<string, unknown>>(query: ReturnType<typeof sql>): Promise<R[]> {
  return withSystemDbAccessContext(async () => {
    const result = await db.execute<R>(query);
    return ((result as unknown as { rows?: R[] }).rows ?? (result as unknown as R[]));
  });
}
const ledger = (orgId: string) => q<{ offering_id: string; funding_source: string; cost_cents: string; stop_reason: string;
  failover_hop: number; failover_cause: string | null; failover_from_offering_id: string | null }>(sql`
  SELECT offering_id, funding_source, cost_cents, stop_reason, failover_hop, failover_cause, failover_from_offering_id
    FROM ai_invocations WHERE org_id = ${orgId}::uuid ORDER BY created_at, failover_hop`);
const reservationsLike = (orgId: string, key: string) => q<{ idempotency_key: string; status: string; billing_source: string }>(sql`
  SELECT idempotency_key, status, billing_source FROM ai_budget_reservations
   WHERE org_id = ${orgId}::uuid AND idempotency_key LIKE ${`${key}%`} ORDER BY idempotency_key`);

describe.runIf(RUN)('W09 failover funding (F1–F6)', () => {
  let f: SeededFailoverPartner;
  const savedKey = process.env.ANTHROPIC_API_KEY;
  beforeEach(async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-w09-integration-placeholder';
    installBillingStub();
    f = await seedFailoverPartner();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.BILLING_SERVICE_URL;
    delete process.env.BILLING_SERVICE_API_KEY;
  });
  afterAll(() => { if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey; });

  it('platform→platform: zero-cost failed hop never debits; the served hop debits once under its own key at ITS rate', async () => {
    await setPartnerFallbacks(f, SURFACE, [f.platformOffering2Id], false);
    const { first, out, settled } = await dispatch(f, [status(529, 'overloaded_error'), 'serve']);
    const expected = priceInvocation({ source: 'platform', standard: P2_RATE }, { ...TOKENS, cacheRead: 0, cacheWrite: 0 }, {});
    expect(settled.costCents).toBeCloseTo(expected, 6);
    expect(expected).not.toBeCloseTo(priceInvocation({ source: 'platform', standard: P_RATE }, { ...TOKENS, cacheRead: 0, cacheWrite: 0 }, {}), 6);
    expect(deducts).toEqual([{ key: `ai-settlement:${out.hop.reservationId}`, costCents: expect.closeTo(expected, 4) }]);
    const rows = await ledger(f.orgId);
    expect(rows.map((r) => [r.offering_id, r.funding_source, Number(r.cost_cents), r.failover_hop, r.failover_cause])).toEqual([
      [f.platformOfferingId, 'platform', 0, 0, null],
      [f.platformOffering2Id, 'platform', expect.closeTo(expected, 6), 1, 'overloaded'],
    ]);
    expect(rows[1]!.failover_from_offering_id).toBe(f.platformOfferingId);
    expect((await reservationsLike(f.orgId, first.idempotencyKey)).map((r) => [r.idempotency_key, r.status, r.billing_source])).toEqual([
      [first.idempotencyKey, 'settled', 'platform'],
      [`${first.idempotencyKey}:hop:1`, 'settled', 'platform'],
    ]);
  });

  it('re-settling the served hop (a retried settle) debits nothing more', async () => {
    await setPartnerFallbacks(f, SURFACE, [f.platformOffering2Id], false);
    const { out } = await dispatch(f, [status(529, 'overloaded_error'), 'serve']);
    await settleInvocation({
      binding: out.hop.binding, orgId: f.orgId, userId: null, sessionId: null, agentRunId: null, sourceRef: 'w09',
      ...messagesUsage(out.hop.binding, [out.value]), reservationId: out.hop.reservationId,
    });
    expect(deducts).toHaveLength(1);
  });

  it('BYOK→platform with crossing on: the platform hop debits its registry cost; the BYOK hop debits nothing', async () => {
    await fixtureSql`UPDATE ai_model_assignments SET default_offering_id = ${f.byokOfferingId}
                      WHERE partner_id = ${f.partnerId} AND org_id IS NULL AND surface = ${SURFACE}`;
    await setPartnerFallbacks(f, SURFACE, [f.platformOfferingId], true);
    const { out, settled } = await dispatch(f, [status(429, 'rate_limit_error'), 'serve']);
    expect(out.hop.resolved.funding).toBe('platform');
    expect(deducts).toEqual([{ key: `ai-settlement:${out.hop.reservationId}`, costCents: expect.closeTo(settled.costCents, 4) }]);
    expect((await ledger(f.orgId)).map((r) => [r.offering_id, r.funding_source])).toEqual([
      [f.byokOfferingId, 'partner_key'],
      [f.platformOfferingId, 'platform'],
    ]);
  });

  it('BYOK→platform with crossing off: no platform reservation, no deduct, FailoverExhaustedError', async () => {
    await fixtureSql`UPDATE ai_model_assignments SET default_offering_id = ${f.byokOfferingId}
                      WHERE partner_id = ${f.partnerId} AND org_id IS NULL AND surface = ${SURFACE}`;
    await setPartnerFallbacks(f, SURFACE, [f.platformOfferingId], false);
    const first = await firstHop(f);
    const e = await runWithFailover({
      first,
      reResolve: ({ excludeOfferingIds, cause, origin }) => resolveModel({ partnerId: f.partnerId, orgId: f.orgId, surface: SURFACE, excludeOfferingIds, failoverCause: cause, failoverOrigin: origin }),
      reserveHop: reserveFailoverHop({ orgId: f.orgId }),
      attempt: async () => { throw status(429, 'rate_limit_error'); },
      settleFailedHop: settleZeroUsageHop({ orgId: f.orgId, userId: null, sessionId: null, agentRunId: null, sourceRef: 'w09' }),
    }).catch((x) => x);
    expect(e).toBeInstanceOf(FailoverExhaustedError);
    expect((await reservationsLike(f.orgId, first.idempotencyKey)).map((r) => r.idempotency_key)).toEqual([first.idempotencyKey]);
    expect(deducts).toEqual([]);
  });

  it('the platform hop is not admitted when credits are exhausted: stops before reserving it', async () => {
    await fixtureSql`UPDATE ai_model_assignments SET default_offering_id = ${f.byokOfferingId}
                      WHERE partner_id = ${f.partnerId} AND org_id IS NULL AND surface = ${SURFACE}`;
    await setPartnerFallbacks(f, SURFACE, [f.platformOfferingId], true);
    const first = await firstHop(f);
    creditsAllowed = false;
    const e = await runWithFailover({
      first,
      reResolve: ({ excludeOfferingIds, cause, origin }) => resolveModel({ partnerId: f.partnerId, orgId: f.orgId, surface: SURFACE, excludeOfferingIds, failoverCause: cause, failoverOrigin: origin }),
      reserveHop: reserveFailoverHop({ orgId: f.orgId }),
      attempt: async () => { throw status(429, 'rate_limit_error'); },
      settleFailedHop: settleZeroUsageHop({ orgId: f.orgId, userId: null, sessionId: null, agentRunId: null, sourceRef: 'w09' }),
    }).catch((x) => x);
    expect([e.stop]).toEqual(['admission_denied']);
    expect((await reservationsLike(f.orgId, first.idempotencyKey))).toHaveLength(1);
  });

  it('a fallback disabled after the first resolution is skipped at failover time (F2)', async () => {
    await setPartnerFallbacks(f, SURFACE, [f.platformOffering2Id], false);
    const first = await firstHop(f);
    await fixtureSql`UPDATE partner_ai_models SET enabled = false WHERE id = ${f.platformOffering2Id}`;
    const e = await runWithFailover({
      first,
      reResolve: ({ excludeOfferingIds, cause, origin }) => resolveModel({ partnerId: f.partnerId, orgId: f.orgId, surface: SURFACE, excludeOfferingIds, failoverCause: cause, failoverOrigin: origin }),
      reserveHop: reserveFailoverHop({ orgId: f.orgId }),
      attempt: async () => { throw status(529, 'overloaded_error'); },
      settleFailedHop: settleZeroUsageHop({ orgId: f.orgId, userId: null, sessionId: null, agentRunId: null, sourceRef: 'w09' }),
    }).catch((x) => x);
    expect(e).toBeInstanceOf(FailoverExhaustedError);
  });

  it('the served hop\'s rows can never be settled on the failed hop\'s reservation', async () => {
    await fixtureSql`UPDATE ai_model_assignments SET default_offering_id = ${f.byokOfferingId}
                      WHERE partner_id = ${f.partnerId} AND org_id IS NULL AND surface = ${SURFACE}`;
    await setPartnerFallbacks(f, SURFACE, [f.platformOfferingId], true);
    const first = await firstHop(f);                                                  // BYOK reservation
    const platform = await resolveModel({ partnerId: f.partnerId, orgId: f.orgId, surface: SURFACE,
      excludeOfferingIds: [f.byokOfferingId], failoverCause: 'rate_limited' });
    if (!platform.ok) throw new Error(platform.reason);
    const binding = turnBindingFrom(platform);
    await expect(settleInvocation({
      binding, orgId: f.orgId, userId: null, sessionId: null, agentRunId: null, sourceRef: 'w09',
      ...messagesUsage(binding, [{ wireModel: binding.wireModel, message: message(binding.wireModel) }]),
      reservationId: first.reservationId,
    })).rejects.toThrow(/funding|binding/i);
    expect(deducts).toEqual([]);
  });

  it('a default switched to another funding mid-dispatch cannot be used to cross funding with crossing off (Codex 4)', async () => {
    await fixtureSql`UPDATE ai_model_assignments SET default_offering_id = ${f.byokOfferingId}
                      WHERE partner_id = ${f.partnerId} AND org_id IS NULL AND surface = ${SURFACE}`;
    await setPartnerFallbacks(f, SURFACE, [], false);
    const first = await firstHop(f);                                                   // BYOK
    await fixtureSql`UPDATE ai_model_assignments SET default_offering_id = ${f.platformOfferingId}
                      WHERE partner_id = ${f.partnerId} AND org_id IS NULL AND surface = ${SURFACE}`;
    const r = await resolveModel({ partnerId: f.partnerId, orgId: f.orgId, surface: SURFACE,
      excludeOfferingIds: [f.byokOfferingId], failoverCause: 'rate_limited',
      failoverOrigin: { offeringId: first.resolved.offering.id, funding: first.resolved.funding, connectionId: first.resolved.connection.id } });
    expect(r).toMatchObject({ ok: false });
  });

  it('the ledger rejects a row naming the served platform offering with partner_key funding (23514)', async () => {
    const err = await fixtureSql`
      INSERT INTO ai_invocations (org_id, surface, offering_id, funding_source, requested_model, served_model, ledger_mode)
      VALUES (${f.orgId}, ${SURFACE}, ${f.platformOfferingId}, 'partner_key', 'm', 'm', 'authoritative')`.catch((e) => e);
    expect((err as { code?: string }).code).toBe('23514');
  });
});
```

The `/ai-credits` stub answers W03's `checkBillingCreditsDetailed`, whose response is `BillingCreditsPayload` (`allowed`, `remainingCredits`, `plan`, optional fields). If the credits check reads more fields than the stub returns, copy them from `BillingCreditsPayload` in `aiCostTracker.ts`.

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiModelFailoverFunding.integration.test.ts`
Expected: before Step 6 these already pass. They test `runWithFailover` plus W03's settlement, and do not depend on the reviewer. To prove the suite is not vacuous, temporarily change `settleFailedHop`'s binding to `out.hop.binding` in one case: it must fail with a funding/binding error. Then revert.

- [ ] **Step 6: Wire the script reviewer**

Add to `reviewer.test.ts` (the W03 file mocks `resolveModel`, `createMessage`, `reserveAiBudget` and `settleInvocation`; keep those mocks, and make `failoverDispatch` real):

```ts
it('a 529 on the reviewer model fails over to the assignment fallback; each hop settles on its own reservation', async () => {
  const primary = makeResolvedModel('platform', { surface: 'script_reviewer', offering: { id: 'p', displayName: 'P' }, failoverRemaining: ['k'] });
  const backup = makeResolvedModel('anthropic_byok', { surface: 'script_reviewer', offering: { id: 'k', displayName: 'K' },
    failover: { fromOfferingId: 'p', hop: 1, cause: 'overloaded' }, failoverRemaining: [] });
  resolveModel.mockResolvedValueOnce(primary).mockResolvedValueOnce(backup);
  createMessage
    .mockRejectedValueOnce(Object.assign(new Error('Overloaded'), { status: 529, error: { type: 'error', error: { type: 'overloaded_error' } } }))
    .mockResolvedValueOnce({ message: verdictMessage(), attempts: [{ wireModel: backup.wireModel, message: verdictMessage() }] });
  await runReviewJob(JOB);
  expect(resolveModel).toHaveBeenLastCalledWith(expect.objectContaining({
    surface: 'script_reviewer', excludeOfferingIds: ['p'], failoverCause: 'overloaded',
    failoverOrigin: { offeringId: 'p', funding: 'platform', connectionId: null },
  }));
  expect(reserveAiBudget).toHaveBeenLastCalledWith(expect.objectContaining({
    idempotencyKey: `script-review:${JOB.proposalId}:${JOB.attempt}:hop:1`, billingSource: 'partner_key',
  }));
  const settles = settleInvocation.mock.calls.map((c) => c[0]);
  expect(settles.map((s) => [s.binding.offeringId, s.usage.length])).toEqual([['p', 0], ['k', 1]]);
  expect(settles[1].reservationId).not.toBe(settles[0].reservationId);
});
```

`verdictMessage()`, `runReviewJob` and `JOB` are the helpers W03's `reviewer.test.ts` already uses for its success path; use the file's names if they differ.

In `reviewer.ts` (P11), replace the block from `let client: …` to the end of the `catch` of `createMessage` with:

```ts
  const baseKey = `script-review:${job.proposalId}:${job.attempt}`;   // the key the reservation above used
  const sourceRef = `script-review:${job.proposalId}`;
  const settleOn = (hop: FailoverHop, attempts: MessageAttempt[]) => settleInvocation({
    binding: hop.binding, orgId: job.orgId, userId: null, sessionId: null, agentRunId: null, sourceRef,
    ...(attempts.length > 0
      ? messagesUsage(hop.binding, attempts)
      : {
          usage: [],
          outcome: { stopReason: 'error', refused: false, refusalCategory: null, fallbackUsed: false,
            servedModel: hop.binding.wireModel, providerModel: null, sdkReportedCostUsd: null },
        }),
    reservationId: hop.reservationId,
  });
  let current: FailoverHop = {
    index: 0, resolved, binding, reservationId, idempotencyKey: baseKey,
    reservedCostCents: reservation.kind === 'reserved' ? reservation.reservedCostCents : null,
  };

  let client0: ReturnType<typeof anthropicClientFor>;
  try {
    client0 = anthropicClientFor(resolved, { surface: 'script_review_verdict', orgId: job.orgId });
  } catch (error) {
    await releaseUndispatched();
    const name = error instanceof Error ? error.name : 'Error';
    return failReview(job, `Provider or model resolution failed (${name}): ${errorMessage(error)}`, 'failed', { reservationId, model });
  }

  let outcome: Awaited<ReturnType<typeof createMessage>>;
  let served: FailoverHop;
  try {
    // W09 (#7607): a pre-output 429/529/5xx/key/quota failure fails over along
    // the script_reviewer assignment's fallback list; each hop is admitted,
    // reserved and settled on its own (failoverDispatch.ts).
    ({ value: outcome, hop: served } = await runWithFailover({
      first: current,
      reResolve: ({ excludeOfferingIds, cause, origin }) => resolveModel({
        partnerId: partnerId!, orgId: job.orgId, surface: 'script_reviewer', maxTokens: SCRIPT_REVIEW_MAX_OUTPUT_TOKENS,
        excludeOfferingIds, failoverCause: cause, failoverOrigin: origin,
      }),
      reserveHop: reserveFailoverHop({ orgId: job.orgId }),
      attempt: (hop) => {
        current = hop;
        const client = hop.index === 0 ? client0 : anthropicClientFor(hop.resolved, { surface: 'script_review_verdict', orgId: job.orgId });
        // No tools, one user turn, hard output cap, hard wall clock, no hidden SDK retries.
        return createMessage(
          client,
          hop.resolved,
          { max_tokens: SCRIPT_REVIEW_MAX_OUTPUT_TOKENS, system, messages: [{ role: 'user', content: user }] },
          { signal: AbortSignal.timeout(SCRIPT_REVIEW_TIMEOUT_MS), maxRetries: 0 },
        );
      },
      settleFailedHop: settleZeroUsageHop({ orgId: job.orgId, userId: null, sessionId: null, agentRunId: null, sourceRef }),
      isPreOutput: isPreOutputMessagesFailure,
    }));
  } catch (error) {
    if (error instanceof FailoverExhaustedError) {
      // Every hop it tried is already settled.
      return failReview(job, `Reviewer model call failed on every configured model: ${errorMessage(error.lastError)}`, 'failed',
        { reservationId: error.lastHop.reservationId, model: error.lastHop.binding.wireModel });
    }
    const timedOut = isTimeoutError(error);
    // A burned attempt (Codex review 3) is billed, never settled as zero.
    await settleOn(current, attemptsOf(error));
    return failReview(
      job,
      `Reviewer model call ${timedOut ? 'timed out' : 'failed'}: ${errorMessage(error)}`,
      timedOut ? 'timeout' : 'failed',
      { reservationId: current.reservationId, model: current.binding.wireModel },
    );
  }
```

Then, in the rest of the function, every use after dispatch moves to the **served** hop:
- `messagesUsage(binding, outcome.attempts)` → `messagesUsage(served.binding, outcome.attempts)`;
- each `settle(outcome.attempts)` → `settleOn(served, outcome.attempts)`;
- each `{ reservationId, model, … }` passed to `failReview` → `{ reservationId: served.reservationId, model: served.binding.wireModel, … }`;
- the review row's `model` → `served.binding.wireModel` and `budgetReservationId` → `served.reservationId`.

Delete the W03 `settle` closure. Add imports: `FailoverExhaustedError, isPreOutputMessagesFailure, reserveFailoverHop, runWithFailover, settleZeroUsageHop, type FailoverHop` from `../aiModels/failoverDispatch`, and `attemptsOf` from `../aiModels/connectionFactory`.

- [ ] **Step 7: Run tests**

Run: `cd apps/api && npx vitest run src/services/aiModels/failoverDispatch.test.ts src/services/scriptProposals/reviewer.test.ts`
Then: `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiModelFailoverFunding.integration.test.ts`
Expected: PASS, including all W03 reviewer cases (no list configured ⇒ the original error path).

- [ ] **Step 8: Commit**

Stage `failoverDispatch.ts` (+ test), `index.ts`, `reviewer.ts` (+ test) and the funding suite. Commit message: `feat(ai-models): dispatch failover with per-hop admission, reservation and settlement; script reviewer (#7607)`, ending with the Co-Authored-By trailer.

---

## Task 8: Office ticket, chat ticket draft and extension content fail over the same way

**Files:**
- Modify: `apps/api/src/routes/officeAddin/tickets.ts` (+ its test, `routes/officeAddin/tickets.test.ts`)
- Modify: `apps/api/src/routes/ai.ts` (`POST /sessions/:id/ticket-draft`, ~L498–612) (+ the W03 route test that covers it: `grep -ln "ticket-draft" apps/api/src/routes/*.test.ts`)
- Modify: `apps/api/src/services/extensionAi.ts` (+ `extensionAi.test.ts`) — **only if W03 Task 13 has landed** (P18)

**Interfaces:**
- Consumes: Task 7 (`runWithFailover`, `reserveFailoverHop`, `settleZeroUsageHop`, `isPreOutputMessagesFailure`, `FailoverExhaustedError`, `FailoverHop`); P12; P18.
- Produces: no new exports. Each surface's first dispatch is unchanged when no fallback list is configured.

The rules every surface follows here:
- **Hop 0 keeps the surface's W03 key.** Hop n is `<that key>:hop:<n>`.
- **`isPreOutput: isPreOutputMessagesFailure`.** A draft whose attempt 1 returned a message and whose attempt 2 then failed carries `attempts.length > 0`. It never fails over (Review Focus 5), and W03's settle-the-burned-attempts path runs.
- **A `FailoverExhaustedError` means every hop was settled.** The surface answers its "unavailable" response and settles nothing more.
- **On a timeout**, the hop that was in flight (`current`) is marked indeterminate, exactly like W03 marks its single reservation.

- [ ] **Step 1: Write the failing tests**

In `routes/officeAddin/tickets.test.ts`, alongside W03's draft cases (reuse its `resolveModel` / `createMessage` / `reserveAiBudget` / `settleInvocation` mocks, its request builder and its `makeResolvedModel` fixtures):

```ts
it('a 529 before any attempt fails over; each hop is reserved and settled on its own', async () => {
  const primary = makeResolvedModel('platform', { surface: 'office_ticket', offering: { id: 'p', displayName: 'P' }, failoverRemaining: ['k'] });
  const backup = makeResolvedModel('anthropic_byok', { surface: 'office_ticket', offering: { id: 'k', displayName: 'K' },
    failover: { fromOfferingId: 'p', hop: 1, cause: 'overloaded' }, failoverRemaining: [] });
  resolveModel.mockResolvedValueOnce(primary).mockResolvedValueOnce(backup);
  createMessage
    .mockRejectedValueOnce(Object.assign(new Error('Overloaded'), { status: 529, error: { type: 'error', error: { type: 'overloaded_error' } } }))
    .mockResolvedValueOnce(draftOutcome(backup.wireModel));
  const res = await postDraft(VALID_BODY);
  expect(res.status).toBe(200);
  const keys = reserveAiBudget.mock.calls.map((c) => c[0].idempotencyKey as string);
  expect(keys[1]).toBe(`${keys[0]}:hop:1`);
  expect(settleInvocation.mock.calls.map((c) => [c[0].binding.offeringId, c[0].usage.length])).toEqual([['p', 0], ['k', 1]]);
});

it('attempt 2 failing after attempt 1 returned a message never fails over (burned tokens bill on hop 0)', async () => {
  const primary = makeResolvedModel('platform', { surface: 'office_ticket', offering: { id: 'p', displayName: 'P' }, failoverRemaining: ['k'] });
  resolveModel.mockResolvedValueOnce(primary);
  createMessage
    .mockResolvedValueOnce(unparseableOutcome(primary.wireModel))   // attempt 1: a message with no usable text
    .mockRejectedValueOnce(Object.assign(new Error('Overloaded'), { status: 529, error: { type: 'error', error: { type: 'overloaded_error' } } }));
  await postDraft(VALID_BODY);
  expect(resolveModel).toHaveBeenCalledTimes(1);
  expect(reserveAiBudget).toHaveBeenCalledTimes(1);
  expect(settleInvocation.mock.calls[0]![0]).toMatchObject({ binding: { offeringId: 'p' } });
  expect(settleInvocation.mock.calls[0]![0].usage.length).toBeGreaterThan(0);
});
```

`draftOutcome(model)` and `unparseableOutcome(model)` return `{ message, attempts: [{ wireModel: model, message }] }`. Build them from the message fixture W03's tests already use for the draft success path and the "no text block" path.

Add the equivalent first case for the ticket draft (`POST /ai/sessions/:id/ticket-draft`, surface `chat`, transport `messages_api`, reservation key prefix `ticket-draft:`). Its re-resolution must go through `resolveSessionTurn` with `excludeOfferingIds`:

```ts
expect(resolveSessionTurn).toHaveBeenLastCalledWith(expect.objectContaining({
  sessionId: SESSION_ID, surface: 'chat', transport: 'messages_api', excludeOfferingIds: ['p'], failoverCause: 'overloaded',
  failoverOrigin: expect.objectContaining({ offeringId: 'p' }),
}));
// Codex review 2: every ticket-draft reservation is sessionless, so its sessionless settlement succeeds.
expect(reserveAiBudget.mock.calls.every((c) => c[0].sessionId === undefined)).toBe(true);
```

Add a third Office case: the backup hop's draft is sized from **its** reservation. Script `reserveAiBudget` to return `reservedCostCents: 80` for hop 0 and `20` for hop 1, then assert that `draftTicketFromEmail`'s second call received `budgetCents: 20` (spy through the `aiEmailDraft` module mock).

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx vitest run src/routes/officeAddin/tickets.test.ts <the ticket-draft route test>`
Expected: FAIL. The route answers 503 on the 529, and only one reservation exists.

- [ ] **Step 3: Implement — Office ticket (`routes/officeAddin/tickets.ts`)**

1. Hoist the key into a constant before the `reserveAiBudget` call: `const reservationKey = \`office-email-draft:${crypto.randomUUID()}\`;`, then use `idempotencyKey: reservationKey`.
2. Replace the block from `const draftPromise = draftTicketFromEmail({` to the end of its `catch` with:

```ts
    // W09 (#7607): a pre-output provider failure fails over along the
    // office_ticket assignment's fallback list; each hop is admitted, reserved
    // and settled on its own (failoverDispatch.ts).
    let current: FailoverHop = {
      index: 0, resolved, binding, reservationId, idempotencyKey: reservationKey,
      reservedCostCents: reservation.kind === 'reserved' ? reservation.reservedCostCents : null,
    };
    const settleOn = (hop: FailoverHop, attempts: MessageAttempt[]) => settleDraftUsage({
      binding: hop.binding, orgId: input.orgId, userId: auth.userId, reservationId: hop.reservationId, attempts,
    });
    const draftPromise = runWithFailover({
      first: current,
      reResolve: ({ excludeOfferingIds, cause, origin }) => resolveModel({
        partnerId: auth.partnerId, orgId: input.orgId, userId: auth.userId, surface: 'office_ticket', maxTokens: 1024,
        excludeOfferingIds, failoverCause: cause, failoverOrigin: origin,
      }),
      reserveHop: reserveFailoverHop({ orgId: input.orgId }),
      attempt: (hop) => {
        current = hop;
        return draftTicketFromEmail({
          subject: input.subject,
          bodyText: dlpResult.text ?? input.bodyText,
          resolved: hop.resolved,
          client: hop.index === 0 ? client : anthropicClientFor(hop.resolved, { surface: 'one_shot_email_draft', orgId: input.orgId }),
          // This hop's OWN allowance (Codex review 6), never hop 0's.
          ...(hop.reservedCostCents !== null ? { budgetCents: hop.reservedCostCents } : {}),
        });
      },
      settleFailedHop: settleZeroUsageHop({ orgId: input.orgId, userId: auth.userId, sessionId: null, agentRunId: null, sourceRef: 'office_email_draft' }),
      isPreOutput: isPreOutputMessagesFailure,
    });
    try {
      const { value: draft, hop } = await withTimeout(draftPromise, DRAFT_TIMEOUT_MS);
      await settleOn(hop, draft.attempts);
      const { attempts: _attempts, ...prefill } = draft;
      return c.json({ draft: prefill }, 200);
    } catch (err) {
      console.error('[office-addin] draft failed', err);
      if (err instanceof FailoverExhaustedError) {
        // Every hop it tried is already settled.
        return c.json({ error: 'ai_unavailable' }, 503);
      }
      if (err instanceof DraftTimeoutError) {
        const inFlight = current;
        await markAiBudgetReservationIndeterminate({ orgId: input.orgId, reservationId: inFlight.reservationId })
          .catch((markError) => captureException(markError));
        void runOutsideDbContext(() => draftPromise.then(
          ({ value: lateDraft, hop }) => settleOn(hop, lateDraft.attempts),
          (lateErr) => lateErr instanceof EmailDraftFailedError && lateErr.attempts.length > 0
            ? settleOn(current, lateErr.attempts)
            : undefined,
        )).catch((meterErr) => {
          console.error('[office-addin] draft usage accounting failed', meterErr);
        });
      } else if (err instanceof EmailDraftFailedError && err.attempts.length > 0) {
        await settleOn(current, err.attempts);
```

Then continue with W03's remaining `else` branches unchanged, except that every `reservationId` in them becomes `current.reservationId`. Add imports: `FailoverExhaustedError, isPreOutputMessagesFailure, reserveFailoverHop, runWithFailover, settleZeroUsageHop, type FailoverHop` from `../../services/aiModels/failoverDispatch`.

- [ ] **Step 4: Implement — chat ticket draft (`routes/ai.ts`)**

1. Hoist `const reservationKey = \`ticket-draft:${sessionId}:${crypto.randomUUID()}\`;` and use it in the existing `reserveAiBudget`. **Drop `sessionId` from that call** (Codex review 2). The draft settles with `sessionId: null` on purpose: it must not count in the chat's totals. W03 rejects settling a session-bound reservation without a session (`aiBudgetReservations.ts` ~L1002: "Session-bound AI budget reservation requires session settlement"), so today's session-bound reservation can never settle. If W03's final head already fixed this another way, keep W03's fix, and make the hop reservations match it.
2. Replace the W03 `settle` closure, the `draftTicketFromTranscript` call and its `catch` with:

```ts
    let current: FailoverHop = {
      index: 0, resolved: turn, binding, reservationId, idempotencyKey: reservationKey,
      reservedCostCents: reservation.kind === 'reserved' ? reservation.reservedCostCents : null,
    };
    const settleOn = (hop: FailoverHop, attempts: MessageAttempt[]) => {
      const { usage, outcome } = messagesUsage(hop.binding, attempts);
      return settleInvocation({
        binding: hop.binding, orgId: session.orgId, userId: auth.user.id, sessionId: null, agentRunId: null,
        sourceRef: 'ticket_draft', usage, outcome, reservationId: hop.reservationId,
      });
    };

    let draft;
    let servedHop: FailoverHop;
    try {
      ({ value: draft, hop: servedHop } = await runWithFailover({
        first: current,
        reResolve: ({ excludeOfferingIds, cause, origin }) => resolveSessionTurn({
          sessionId, surface: 'chat', userId: auth.user.id, maxTokens: 1024, transport: 'messages_api',
          excludeOfferingIds, failoverCause: cause, failoverOrigin: origin,
        }),
        // Sessionless, like hop 0 (Step 4.1): settled with sessionId null.
        reserveHop: reserveFailoverHop({ orgId: session.orgId }),
        attempt: (hop) => {
          current = hop;
          return draftTicketFromTranscript({
            messages: messages.map((m) => ({ role: m.role, content: m.content })),
            contextSnapshot: session.contextSnapshot,
            elapsedMinutes,
            resolved: hop.resolved,
            client: hop.index === 0 ? client : anthropicClientFor(hop.resolved, { surface: 'one_shot_ticket_draft', orgId: session.orgId }),
            // This hop's OWN allowance (Codex review 6), never hop 0's.
            ...(hop.reservedCostCents !== null ? { budgetCents: hop.reservedCostCents } : {}),
          });
        },
        settleFailedHop: settleZeroUsageHop({ orgId: session.orgId, userId: auth.user.id, sessionId: null, agentRunId: null, sourceRef: 'ticket_draft' }),
        isPreOutput: isPreOutputMessagesFailure,
      }));
    } catch (err) {
      if (err instanceof FailoverExhaustedError) {
        console.error('[AI] Ticket draft failed on every configured model:', err.lastError);
        return c.json({ error: 'ai_unavailable' }, 503);
      }
      try {
        if (err instanceof TicketDraftFailedError && err.attempts.length > 0) {
          await settleOn(current, err.attempts);
        } else if (err instanceof TicketDraftFailedError && err.providerOutcomeUnknown) {
          await markAiBudgetReservationIndeterminate({ orgId: session.orgId, reservationId: current.reservationId });
        } else {
          await releaseUnusedAiBudgetReservation({ orgId: session.orgId, reservationId: current.reservationId });
        }
      } catch (budgetError) {
        captureException(budgetError);
      }
      if (err instanceof ThinTranscriptError) return c.json({ error: err.message }, 422);
      if (err instanceof LlmUnavailableError) return c.json({ error: 'ai_unavailable' }, 503);
      console.error('[AI] Ticket draft failed:', err);
      captureException(err);
      return c.json({ error: 'Could not draft a ticket from this conversation' }, 502);
    }

    try {
      await settleOn(servedHop, draft.attempts);
    } catch (err) {
      captureException(err);
      await markAiBudgetReservationIndeterminate({ orgId: session.orgId, reservationId: servedHop.reservationId }).catch(captureException);
    }
```

`resolveSessionTurn` gains `excludeOfferingIds` / `failoverCause` pass-through in Task 9. Implement Task 9 Step 3's `sessionModel.ts` change first if you run this task's tests before Task 9.

- [ ] **Step 5: Run the tests**

Run: `cd apps/api && npx vitest run src/routes/officeAddin/tickets.test.ts <the ticket-draft route test> src/services/officeAddin/aiEmailDraft.test.ts src/services/aiTicketDraft.test.ts`
Expected: PASS, including every W03 case.

- [ ] **Step 6: `extension_content` (only if W03 Task 13 landed)**

If `services/extensionAi.ts` resolves `extension_content` and settles through `settleInvocation` (P18), wrap its single `createMessage` exactly as Task 7 Step 6 wrapped the reviewer:
- `first` = its W03 reservation;
- `reResolve` = its `resolveModel({ partnerId, orgId, surface: 'extension_content', …, excludeOfferingIds, failoverCause: cause })`;
- `reserveHop: reserveFailoverHop({ orgId })`;
- `settleFailedHop: settleZeroUsageHop({ orgId, userId: null, sessionId: null, agentRunId: null, sourceRef: 'extension:workspace_enrichment' })`;
- the success settlement and the returned `model` / `billingSource` from the **served** hop.

Add the same two-hop test to `extensionAi.test.ts`. `catalog_enrichment` is a multi-turn web-search loop: it keeps W03's single dispatch and gets the resolution-time walk and cooldown only (a second turn always follows output). If W03 Task 13 has not landed, skip this step and add a line to the PR body naming it as a follow-up for whoever lands Task 13.

- [ ] **Step 7: Commit**

Stage the changed route, service and test files. Commit message: `feat(ai-models): Office ticket, ticket draft and extension content fail over per hop (#7607)`, ending with the Co-Authored-By trailer.

---

## Task 9: Agent SDK failure observation; chat cools a failing model; sessions with history stay on their connection

**Files:**
- Modify: `apps/api/src/services/aiModels/invocationUsage.ts`, `invocationUsage.test.ts`
- Modify: `apps/api/src/services/aiModels/failover.ts`, `failover.test.ts` (add `shouldFailOverNow`)
- Modify: `apps/api/src/services/aiModels/offeringHealth.ts`, `offeringHealth.test.ts` (add `noteProviderFailureForBinding`)
- Modify: `apps/api/src/services/streamingSessionManager.ts`, `streamingSessionManager.modelBinding.test.ts`
- Modify: `apps/api/src/services/aiModels/candidateLoader.ts` (`readSessionModelRow` returns `turnCount`)
- Modify: `apps/api/src/services/aiModels/sessionModel.ts`, `sessionModel.test.ts`

**Interfaces:**
- Consumes: P7, P15, P16; Task 3; Task 5.
- Produces:

```ts
// invocationUsage.ts
export interface SdkTurnObservation {
  refusalFallback: …; refusalNoFallback: …;                 // W03
  /** W09: the last provider failure the CLI reported this turn. */
  providerFailure: { cause: ProviderFailureCause; status: number | null; retries: number } | null;
  /** W09: assistant content (text / thinking / tool_use) was produced this turn: never fail over after it. */
  sawOutput: boolean;
}
// failover.ts
export function shouldFailOverNow(obs: { providerFailure: SdkTurnObservation['providerFailure']; sawOutput: boolean },
  failoverRemaining: readonly string[]): ProviderFailureCause | null;
// offeringHealth.ts
export function noteProviderFailureForBinding(binding: Pick<TurnBinding, 'offeringId' | 'surface' | 'funding'>, cause: ProviderFailureCause): Promise<void>;
// candidateLoader.ts
readSessionModelRow(sessionId) → { orgId, offeringId, options, turnCount } | null
// sessionModel.ts
resolveSessionTurn({ …W03 fields, excludeOfferingIds?, failoverCause?, failoverOrigin? })   // sets sameConnectionOnly for an agent_sdk session with turns
```

- [ ] **Step 1: Write the failing tests**

Append to `invocationUsage.test.ts`:

```ts
describe('W09: provider-failure observation', () => {
  it('an api_retry records the classified cause, its status and the CLI\'s attempt count', () => {
    const obs = newSdkTurnObservation();
    observeSdkMessage(obs, { type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 500, error_status: 529, error: 'overloaded' });
    expect(obs.providerFailure).toEqual({ cause: 'overloaded', status: 529, retries: 2 });
    expect(obs.sawOutput).toBe(false);
  });

  it('a synthetic API-error assistant message is a failure, not output', () => {
    const obs = newSdkTurnObservation();
    observeSdkMessage(obs, { type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: 'API Error: 429' }] } });
    expect(obs.providerFailure).toMatchObject({ cause: 'rate_limited' });
    expect(obs.sawOutput).toBe(false);
  });

  it('real assistant content (text, thinking, tool_use) is output', () => {
    for (const block of [{ type: 'text', text: 'hi' }, { type: 'thinking', thinking: '' }, { type: 'tool_use', id: 't', name: 'x', input: {} }]) {
      const obs = newSdkTurnObservation();
      observeSdkMessage(obs, { type: 'assistant', message: { content: [block] } });
      expect(obs.sawOutput).toBe(true);
    }
  });

  it('a streamed content block start is output (the user may already be reading it)', () => {
    const obs = newSdkTurnObservation();
    observeSdkMessage(obs, { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    expect(obs.sawOutput).toBe(true);
  });

  it('a result with api_error_status records the failure', () => {
    const obs = newSdkTurnObservation();
    observeSdkMessage(obs, { type: 'result', subtype: 'success', is_error: true, api_error_status: 401 });
    expect(obs.providerFailure).toMatchObject({ cause: 'auth_failed', status: 401 });
  });

  it('a non-failover error (invalid_request) records nothing', () => {
    const obs = newSdkTurnObservation();
    observeSdkMessage(obs, { type: 'system', subtype: 'api_retry', attempt: 1, error_status: 400, error: 'invalid_request' });
    expect(obs.providerFailure).toBeNull();
  });
});
```

Append to `failover.test.ts`:

```ts
describe('shouldFailOverNow (agent runs)', () => {
  const pf = (cause: string, retries: number) => ({ cause, status: null, retries }) as never;
  it.each([
    ['no failure', null, false, ['k'], null],
    ['output already produced', pf('overloaded', 5), true, ['k'], null],
    ['nothing configured', pf('overloaded', 5), false, [], null],
    ['a transient failure the CLI is still retrying', pf('overloaded', 1), false, ['k'], null],
    ['a transient failure after the retry budget', pf('overloaded', 2), false, ['k'], 'overloaded'],
    ['a bad key fails over at once', pf('auth_failed', 0), false, ['k'], 'auth_failed'],
    ['out of quota fails over at once', pf('quota_exhausted', 0), false, ['k'], 'quota_exhausted'],
  ] as const)('%s', (_l, providerFailure, sawOutput, remaining, expected) => {
    expect(shouldFailOverNow({ providerFailure, sawOutput }, remaining)).toBe(expected);
  });
});
```

Append to `sessionModel.test.ts` (W03 mocks `readSessionModelRow`, `readOrgPartnerId` and `resolveModel`):

```ts
describe('W09 (D5): a resumed SDK session with history fails over only within its connection', () => {
  it.each([
    [3, 'agent_sdk', true],
    [0, 'agent_sdk', false],
    [3, 'messages_api', false],     // a one-shot (ticket draft) sends its transcript explicitly; no resume
  ] as const)('turnCount %s on %s → sameConnectionOnly %s', async (turnCount, transport, expected) => {
    readSessionModelRow.mockResolvedValue({ orgId: 'o1', offeringId: 'off', options: null, turnCount });
    readOrgPartnerId.mockResolvedValue('p1');
    await resolveSessionTurn({ sessionId: 's1', surface: 'chat', userId: 'u1', transport });
    expect(resolveModel).toHaveBeenLastCalledWith(expect.objectContaining({ sameConnectionOnly: expected }));
  });

  it('passes dispatch exclusions through', async () => {
    readSessionModelRow.mockResolvedValue({ orgId: 'o1', offeringId: 'off', options: null, turnCount: 0 });
    readOrgPartnerId.mockResolvedValue('p1');
    await resolveSessionTurn({ sessionId: 's1', surface: 'chat', userId: 'u1', transport: 'messages_api', excludeOfferingIds: ['off'], failoverCause: 'overloaded' });
    expect(resolveModel).toHaveBeenLastCalledWith(expect.objectContaining({ excludeOfferingIds: ['off'], failoverCause: 'overloaded' }));
  });
});
```

Append to `streamingSessionManager.modelBinding.test.ts`. W03's harness exposes `scriptedQuery`, `baseDbSession`, `baseAuth` (`services/__testUtils__/streamingSessionManagerHarness.ts`); mock `./aiModels/offeringHealth`'s `noteProviderFailureForBinding`:

```ts
it('a turn that failed on a 529 before any output cools the bound offering', async () => {
  scriptedQuery([
    { type: 'system', subtype: 'api_retry', attempt: 3, max_retries: 3, retry_delay_ms: 0, error_status: 529, error: 'overloaded' },
    { type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, usage: {}, modelUsage: {} },
  ]);
  await runOneTurn();   // the harness's single-turn driver used by W03's binding cases
  expect(noteProviderFailureForBinding).toHaveBeenCalledWith(expect.objectContaining({ offeringId: 'off-1' }), 'overloaded');
});

it('a turn that streamed text before failing does not cool anything', async () => {
  scriptedQuery([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it' }] } },
    { type: 'system', subtype: 'api_retry', attempt: 3, error_status: 529, error: 'overloaded' },
    { type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, usage: {}, modelUsage: {} },
  ]);
  await runOneTurn();
  expect(noteProviderFailureForBinding).not.toHaveBeenCalled();
});
```

If the harness's driver has another name, use it. The two scripts are what matters.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/invocationUsage.test.ts src/services/aiModels/failover.test.ts src/services/aiModels/sessionModel.test.ts src/services/streamingSessionManager.modelBinding.test.ts`
Expected: FAIL (`providerFailure` undefined; `shouldFailOverNow` / `noteProviderFailureForBinding` missing; `sameConnectionOnly` absent).

- [ ] **Step 3: Implement**

`invocationUsage.ts`:
- import `classifySdkAssistantError, type ProviderFailureCause` from `./failover`;
- extend `SdkTurnObservation` with the two fields;
- `newSdkTurnObservation()` returns `{ refusalFallback: null, refusalNoFallback: null, providerFailure: null, sawOutput: false }`;
- replace `observeSdkMessage` with:

```ts
const OUTPUT_BLOCKS = new Set(['text', 'thinking', 'redacted_thinking', 'tool_use', 'server_tool_use']);

export function observeSdkMessage(obs: SdkTurnObservation, message: unknown): void {
  if (!message || typeof message !== 'object') return;
  const m = message as {
    type?: unknown; subtype?: unknown; scope?: unknown; fallback_model?: unknown; api_refusal_category?: unknown;
    error?: unknown; error_status?: unknown; attempt?: unknown; api_error_status?: unknown;
    message?: { content?: Array<{ type?: unknown }> }; event?: { type?: unknown };
  };
  const recordFailure = (error: unknown, status: unknown, attempt: unknown) => {
    const httpStatus = typeof status === 'number' ? status : null;
    const cause = classifySdkAssistantError(typeof error === 'string' ? error : null, httpStatus);
    if (!cause) return;
    const retries = typeof attempt === 'number' ? attempt : (obs.providerFailure?.retries ?? 0);
    obs.providerFailure = { cause, status: httpStatus, retries };
  };

  if (m.type === 'assistant') {
    // W09: a synthetic API-error assistant message carries `error`; it is a
    // failure, not output. Anything else with a content block is output.
    if (typeof m.error === 'string') { recordFailure(m.error, null, undefined); return; }
    if ((m.message?.content ?? []).some((b) => typeof b?.type === 'string' && OUTPUT_BLOCKS.has(b.type))) obs.sawOutput = true;
    return;
  }
  if (m.type === 'stream_event') {
    if (m.event?.type === 'content_block_start') obs.sawOutput = true;
    return;
  }
  if (m.type === 'result') {
    if (typeof m.api_error_status === 'number') recordFailure(null, m.api_error_status, undefined);
    return;
  }
  if (m.type !== 'system') return;
  if (m.subtype === 'api_retry') { recordFailure(m.error, m.error_status, m.attempt); return; }
  const category = typeof m.api_refusal_category === 'string' ? m.api_refusal_category : null;
  if (m.subtype === 'model_refusal_fallback') {
    // 'local' = a subagent / side question fell back; the main loop did not.
    // Absent scope (older CLI) means 'session'.
    if (m.scope === 'local') return;
    const fallbackModel = typeof m.fallback_model === 'string' && m.fallback_model.length > 0 ? m.fallback_model : null;
    obs.refusalFallback = { fallbackModel, category };
  } else if (m.subtype === 'model_refusal_no_fallback') {
    obs.refusalNoFallback = { category };
  }
}
```

`failover.ts`:

```ts
const CLI_RETRIES_ITSELF: ReadonlySet<ProviderFailureCause> = new Set(['rate_limited', 'overloaded', 'server_error']);

/**
 * Agent runs (Task 11): fail over NOW? Never after output, never with nothing
 * configured. A 429/529/5xx is retried by the CLI itself; give it
 * SDK_RETRIES_BEFORE_FAILOVER tries first. A bad key or exhausted quota will
 * not fix itself, so it fails over at once.
 */
export function shouldFailOverNow(
  obs: { providerFailure: { cause: ProviderFailureCause; retries: number } | null; sawOutput: boolean },
  failoverRemaining: readonly string[],
): ProviderFailureCause | null {
  if (!obs.providerFailure || obs.sawOutput || failoverRemaining.length === 0) return null;
  if (CLI_RETRIES_ITSELF.has(obs.providerFailure.cause) && obs.providerFailure.retries < SDK_RETRIES_BEFORE_FAILOVER) return null;
  return obs.providerFailure.cause;
}
```

`offeringHealth.ts`:

```ts
import type { TurnBinding } from './turnBinding';

/** The same as noteProviderFailure, for callers that hold only the turn's binding (chat). */
export async function noteProviderFailureForBinding(
  binding: Pick<TurnBinding, 'offeringId' | 'surface' | 'funding'>,
  cause: ProviderFailureCause,
): Promise<void> {
  await noteProviderFailure({ offering: { id: binding.offeringId, displayName: '' }, surface: binding.surface, funding: binding.funding }, cause);
}
```

Add a matching test to `offeringHealth.test.ts`: `noteProviderFailureForBinding({ offeringId: 'o9', surface: 'chat', funding: 'platform' }, 'rate_limited')` sets `ai-model:cooldown:o9`.

`streamingSessionManager.ts`: in the `result` handler, right after the `sdkTurnUsage(...)` call (P15, ~L1975), add:

```ts
      // W09 (#7607, D5): chat never replays a turn on another model. A turn
      // that failed on a provider error BEFORE any output cools its offering,
      // so the next message resolves to a healthy fallback (resolveModel).
      const failed = (message as { is_error?: unknown }).is_error === true || (message as { subtype?: unknown }).subtype !== 'success';
      if (failed && observation.providerFailure && !observation.sawOutput && session.turnBinding) {
        void noteProviderFailureForBinding(session.turnBinding, observation.providerFailure.cause);
      }
```

Here `observation` is the turn's `SdkTurnObservation` (`session.refusalObservation`; use the local name the handler already uses). Make sure it is reset per turn where W03 resets it: `newSdkTurnObservation()` now initialises the two new fields.

`candidateLoader.ts` `readSessionModelRow`: add `turnCount: aiSessions.turnCount` to the select, and `turnCount: Number(row.turnCount ?? 0)` to the returned object (and its return type).

`sessionModel.ts` `resolveSessionTurn`:
- accept `excludeOfferingIds?: readonly string[]; failoverCause?: ProviderFailureCause; failoverOrigin?: FailoverOrigin`;
- compute `const transport = input.transport ?? defaultTransport(input.surface);`;
- pass to `resolveModel`:

```ts
    // W09 (D5): a resumed SDK session with history may fail over only within
    // its connection (a cross-connection resume needs W05's continuation). A
    // Messages API one-shot sends its transcript explicitly, so it may cross.
    sameConnectionOnly: transport === 'agent_sdk' && row.turnCount > 0,
    ...(input.excludeOfferingIds ? { excludeOfferingIds: input.excludeOfferingIds } : {}),
    ...(input.failoverCause ? { failoverCause: input.failoverCause } : {}),
    ...(input.failoverOrigin ? { failoverOrigin: input.failoverOrigin } : {}),
    transport,
```

Replace W03's conditional `...(input.transport ? { transport: input.transport } : {})` with the `transport` line above. Import `defaultTransport` from `./transport`. A comment names W05: `// W05 (#7603) may relax this once continuation sessions exist.`

- [ ] **Step 4: Run tests**

Run: `cd apps/api && npx vitest run src/services/aiModels/invocationUsage.test.ts src/services/aiModels/failover.test.ts src/services/aiModels/offeringHealth.test.ts src/services/aiModels/sessionModel.test.ts src/services/aiModels/candidateLoader.test.ts src/services/streamingSessionManager.modelBinding.test.ts src/services/streamingSessionManager.usage.test.ts`
Expected: PASS, including W03's refusal-observation cases.

- [ ] **Step 5: Commit**

Stage the eleven files. Commit message: `feat(ai-models): observe pre-output provider failures from the Agent SDK; chat cools a failing model; resumed sessions fail over within their connection (#7607)`, ending with the Co-Authored-By trailer.

---

## Task 10: Agent escalation roles — `triage` → `analysis` → `remediation`

**Files:**
- Create: `apps/api/src/services/aiAgents/agentModelRole.ts`, `agentModelRole.test.ts`
- Modify: `apps/api/src/services/aiAgents/runService.ts` (+ its admission test, `runService.test.ts` or the file W03 used for the model-admission cases: `grep -ln "resolveAgentModelForAdmission\|model_unavailable" apps/api/src/services/aiAgents/*.test.ts`)
- Modify: `apps/api/src/services/aiAgents/runLoop.ts` (+ the W03 run-loop model test)

**Interfaces:**
- Consumes: `AiAgentRunProfile`, `AI_AGENT_RUN_PROFILES` (`packages/shared/src/types/aiAgents.ts`); Task 1 `AiAgentEscalationRole`; P13, P14.
- Produces:

```ts
export const AGENT_PROFILE_ROLE: Readonly<Record<AiAgentRunProfile, AiAgentEscalationRole>>;
export const ACT_MODE_REMEDIATION_PROFILES: ReadonlySet<AiAgentRunProfile>;
export function agentRunModelRole(run: { profile?: AiAgentRunProfile | null; modeAtStart?: string | null }): AiAgentEscalationRole;
```

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/aiAgents/agentModelRole.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AI_AGENT_RUN_PROFILES, AI_SURFACE_ROLES } from '@breeze/shared';
import { AGENT_PROFILE_ROLE, agentRunModelRole } from './agentModelRole';

describe('agentRunModelRole (D4, #7570)', () => {
  it.each([
    ['verdict', 'shadow', 'triage'],
    ['triage', 'act', 'triage'],          // ticket triage writes ticket fields; still the cheap first look
    ['sweep', 'shadow', 'triage'],
    ['sweep', 'act', 'remediation'],      // act-mode sweeps change devices
    ['full', 'shadow', 'analysis'],
    ['full', 'act', 'remediation'],
    ['analysis', 'shadow', 'analysis'],
    ['narrative', 'shadow', 'analysis'],
    ['design', 'shadow', 'analysis'],
    ['patch', 'shadow', 'analysis'],      // plans patches, executes nothing
  ] as const)('%s in %s mode → %s', (profile, modeAtStart, role) => {
    expect(agentRunModelRole({ profile, modeAtStart })).toBe(role);
  });

  it('a run with no profile (pre-profile rows) is a full run', () => {
    expect(agentRunModelRole({ profile: null, modeAtStart: 'act' })).toBe('remediation');
    expect(agentRunModelRole({})).toBe('analysis');
  });

  it('covers every run profile, and every role it returns is an ai_agents assignment role', () => {
    expect(Object.keys(AGENT_PROFILE_ROLE).sort()).toEqual([...AI_AGENT_RUN_PROFILES].sort());
    for (const role of Object.values(AGENT_PROFILE_ROLE)) expect(AI_SURFACE_ROLES.ai_agents).toContain(role);
    expect(AI_SURFACE_ROLES.ai_agents).toContain('remediation');
  });
});
```

In the admission test file, next to W03's `model_unavailable` admission cases:

```ts
it('admission resolves the run\'s escalation role (verdict → triage)', async () => {
  await createAndEnqueueAgentRun({ ...BASE_INPUT, profile: 'verdict', triggerKind: 'alert' });
  expect(resolveModel).toHaveBeenCalledWith(expect.objectContaining({ surface: 'ai_agents', role: 'triage' }));
});
```

In the run-loop test, next to W03's "re-resolves the ADMITTED offering" case:

```ts
it('the run loop resolves the same role admission did (act-mode full → remediation)', async () => {
  await runAgentLoop(runContext({ profile: 'full', modeAtStart: 'act' }));
  expect(resolveModel).toHaveBeenCalledWith(expect.objectContaining({ surface: 'ai_agents', role: 'remediation' }));
});
```

`BASE_INPUT`, `runAgentLoop` and `runContext` are the fixtures those W03 test files already define for their model cases. Use the files' own names.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiAgents/agentModelRole.test.ts <the two W03 test files>`
Expected: FAIL. The module is missing, and `resolveModel` is called without `role`.

- [ ] **Step 3: Implement**

`apps/api/src/services/aiAgents/agentModelRole.ts`:

```ts
/**
 * AI model registry W09 (#7607, #7570): which `ai_agents` assignment role a
 * run resolves its model from. Escalation is policy-driven per agent STAGE
 * (spec §14: never model-chosen inside a run):
 *   triage       a cheap first look — alert verdicts, ticket triage, shadow sweeps;
 *   analysis     investigation and planning — full shadow runs, analysis,
 *                narrative, design and patch-planning runs;
 *   remediation  runs that may change customer machines — act-mode full and
 *                act-mode sweep runs.
 * A role with no assignment row of its own inherits the `ai_agents` default
 * (assignments.ts), so a partner that configures nothing sees no change. An
 * agent policy's explicit offering pin still wins (W09 D3).
 */
import type { AiAgentEscalationRole, AiAgentRunProfile } from '@breeze/shared';

export const AGENT_PROFILE_ROLE = {
  verdict: 'triage',
  triage: 'triage',
  sweep: 'triage',
  full: 'analysis',
  analysis: 'analysis',
  narrative: 'analysis',
  design: 'analysis',
  patch: 'analysis',
} as const satisfies Record<AiAgentRunProfile, AiAgentEscalationRole>;

/** Profiles whose act mode executes actions on devices. */
export const ACT_MODE_REMEDIATION_PROFILES: ReadonlySet<AiAgentRunProfile> = new Set<AiAgentRunProfile>(['full', 'sweep']);

export function agentRunModelRole(run: { profile?: AiAgentRunProfile | null; modeAtStart?: string | null }): AiAgentEscalationRole {
  const profile: AiAgentRunProfile = run.profile ?? 'full';
  if (run.modeAtStart === 'act' && ACT_MODE_REMEDIATION_PROFILES.has(profile)) return 'remediation';
  return AGENT_PROFILE_ROLE[profile];
}
```

`runService.ts` (P13):
- `resolveAgentModelForAdmission(orgId, offeringId, role: AiAgentEscalationRole)` passes `role` to `resolveModel`;
- at the call site (after `modeAtStart` is computed): `const modelRole = agentRunModelRole({ profile: input.profile ?? 'full', modeAtStart });` and `resolveAgentModelForAdmission(orgId, effective.offeringId ?? null, modelRole)`.

`input.profile` is `CreateAgentRunInput.profile`; if W03's head names the field differently, use that name.

`runLoop.ts` (P14): in the `resolveModel({ … surface: 'ai_agents' … })` call, add `role: agentRunModelRole(run),`. Store it once (`const modelRole = agentRunModelRole(run);` before the call); Task 11 reuses `modelRole`.

- [ ] **Step 4: Run tests**

Run: `cd apps/api && npx vitest run src/services/aiAgents/agentModelRole.test.ts src/services/aiAgents/runService.test.ts src/services/aiAgents/runLoop.test.ts`
Expected: PASS. W03's cases resolve role `analysis` (their fixtures are `full` / shadow); with no role row the assignment falls back to `default`, so their offerings are unchanged.

- [ ] **Step 5: Commit**

Stage the new module, its test, `runService.ts`, `runLoop.ts` and their tests. Commit message: `feat(ai-agents): runs resolve their escalation role (triage / analysis / remediation) from profile and mode (#7607)`, ending with the Co-Authored-By trailer.

---

## Task 11: AI agent runs fail over between hops, with re-drive resume and funding re-admission

**Files:**
- Create: `apps/api/src/services/aiAgents/agentRunFailover.ts`, `agentRunFailover.test.ts`
- Modify: `apps/api/src/services/aiAgents/runLoop.ts`, `runLoop.test.ts` (the W03 model/billing cases file)
- Modify: `apps/api/src/services/aiAgents/runLoopTypes.ts` (`RunContext.run` gains the three served fields), and the run loader's select list in `runLoop.ts` (~L290–300, next to `admittedOfferingId`)
- Modify: `apps/api/src/__tests__/integration/aiModelFailoverFunding.integration.test.ts` (append the re-drive case)

**Interfaces:**
- Consumes: Tasks 3, 5, 6, 9 (`shouldFailOverNow`), 10 (`modelRole`); P10, P14.
- Produces:

```ts
// agentRunFailover.ts
export function recordServedHop(runId: string, served: { offeringId: string; funding: AiBillingSource; hop: number; cause: FailoverCause }): Promise<void>;
export function markStaleHopReservations(input: { runId: string; orgId: string; uptoHop: number }): Promise<number>;
export type NextAgentHop =
  | { ok: true; resolved: ResolvedModel }
  | { ok: false; reason: 'no_next_hop' | 'admission_denied'; message: string };
export function nextAgentHop(input: {
  runId: string; orgId: string; partnerId: string; role: AiAgentEscalationRole;
  requestedOfferingId: string | null; tried: readonly string[]; cause: ProviderFailureCause; hop: number;
  origin: FailoverOrigin;
}): Promise<NextAgentHop>;
export function startHopFor(run: { servedOfferingId?: string | null; servedFailoverHop?: number | null; admittedOfferingId?: string | null }):
  { requestedOfferingId: string | null; hop: number };
```

Behaviour:
- **Start.** The run resumes on its persisted hop. `requestedOfferingId = run.servedOfferingId ?? run.admittedOfferingId ?? effective.offeringId`, and the reservation key is `hopIdempotencyKey('ai-agent-run:<id>', run.servedFailoverHop ?? 0)`.
- **Funding guard (replaces W03's).** If the resolved funding differs from `run.servedFundingSource ?? run.fundingSource`, the run continues only when `resolved.failover !== null` (an explicitly configured cross-funding walk) **and** `checkBudgetDetailed(orgId, resolved.funding)` admits it. That hop is recorded on the run first. Otherwise the run ends `blocked: model_unavailable`, as in W03.
- **Per hop.** Reserve (hop key, hop funding, hop binding) → egress grant → `query()`. While streaming, a **non-result** message may trigger `shouldFailOverNow(observation, hopModel.failoverRemaining)`, which aborts **this hop's** controller. A result message is always billed first through W03's handling (Codex review 1). After the hop:
  - `cause` = the abort's cause, or a terminal SDK failure with a classified `providerFailure`, no output and no tool executed in this hop.
  - With a cause (and the wall clock not expired), the order is (Codex review 5):
    1. cool the offering;
    2. `nextAgentHop`: resolve with exclusions and the run's origin → `checkBudgetDetailed` for the next funding → `recordServedHop` (offering, funding, hop, cause);
    3. settle **this** hop on its own reservation with its own billed usage (zero when none);
    4. re-check the wall clock, then loop.

    A crash between steps 2 and 3 leaves hop n−1's reservation active while the run row already names hop n. On re-drive, `markStaleHopReservations` marks it indeterminate (W03's unknown-outcome state). It is never re-reserved, and never debited at a guessed amount.
  - Otherwise leave the loop. W03's settlement block then settles the last hop (`binding` and `reservationId` are now the last hop's).
- **Provenance on re-drive.** A resumed run resolves with `failoverOrigin` = its admitted offering and funding, and its binding's `failover.hop` / `cause` come from the run row, so the served hop's ledger row keeps its failover provenance (Codex review 5).
- **Wall clock.** The timer aborts whichever hop's controller is current. A hop transition re-checks the deadline before reserving, so no hop is dispatched after the deadline (Codex review 7).
- **Compute** stays on `run.fundingSource` (D7). Nothing in the compute path changes.

- [ ] **Step 1: Write the failing unit tests**

`apps/api/src/services/aiAgents/agentRunFailover.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  checkBudgetDetailed: vi.fn(async () => null),
  markIndeterminate: vi.fn(async () => undefined),
  updates: [] as Array<Record<string, unknown>>,
  reservationRows: {} as Record<string, { id: string; status: string }>,
  lastKey: '' as string,
}));
vi.mock('../aiModels/resolveModel', () => ({ resolveModel: h.resolveModel }));
vi.mock('../aiCostTracker', () => ({ checkBudgetDetailed: h.checkBudgetDetailed }));
vi.mock('../aiBudgetReservations', () => ({ markAiBudgetReservationIndeterminate: h.markIndeterminate }));
vi.mock('drizzle-orm', async (orig) => {
  const actual = await orig<typeof import('drizzle-orm')>();
  // Capture the idempotency key the select filters on (the second eq()).
  return { ...actual, eq: (col: unknown, value: unknown) => { if (typeof value === 'string' && value.startsWith('ai-agent-run:')) h.lastKey = value; return actual.eq(col as never, value as never); } };
});
vi.mock('../../db', () => ({
  db: {
    update: () => ({ set: (v: Record<string, unknown>) => ({ where: async () => { h.updates.push(v); } }) }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => (h.reservationRows[h.lastKey] ? [h.reservationRows[h.lastKey]] : []) }) }) }),
  },
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

import { makeResolvedModel } from '../aiModels/__fixtures__/resolvedModel';
import { markStaleHopReservations, nextAgentHop, startHopFor } from './agentRunFailover';

const ORIGIN = { offeringId: 'p', funding: 'platform' as const, connectionId: null };
const base = { runId: 'run-1', orgId: 'org-1', partnerId: 'p1', role: 'triage' as const, requestedOfferingId: 'p', tried: ['p'], cause: 'overloaded' as const, hop: 1, origin: ORIGIN };

beforeEach(() => { vi.clearAllMocks(); h.updates = []; });

describe('nextAgentHop', () => {
  it('re-resolves the role with the tried offerings excluded, admits the next funding, records the hop BEFORE returning', async () => {
    h.resolveModel.mockResolvedValue(makeResolvedModel('anthropic_byok', { surface: 'ai_agents', offering: { id: 'k', displayName: 'K' } }));
    const r = await nextAgentHop(base);
    expect(h.resolveModel).toHaveBeenCalledWith(expect.objectContaining({
      surface: 'ai_agents', role: 'triage', requested: { offeringId: 'p', origin: 'policy' },
      excludeOfferingIds: ['p'], failoverCause: 'overloaded', failoverOrigin: ORIGIN,
    }));
    expect(h.checkBudgetDetailed).toHaveBeenCalledWith('org-1', 'partner_key');
    expect(h.updates).toEqual([{ servedOfferingId: 'k', servedFundingSource: 'partner_key', servedFailoverHop: 1, servedFailoverCause: 'overloaded' }]);
    expect(r).toMatchObject({ ok: true, resolved: { offering: { id: 'k' } } });
  });

  it('records nothing when the next funding is not admitted', async () => {
    h.resolveModel.mockResolvedValue(makeResolvedModel('platform', { surface: 'ai_agents', offering: { id: 'p2', displayName: 'P2' } }));
    h.checkBudgetDetailed.mockResolvedValueOnce({ message: 'Out of AI credits' } as never);
    expect(await nextAgentHop(base)).toEqual({ ok: false, reason: 'admission_denied', message: 'Out of AI credits' });
    expect(h.updates).toEqual([]);
  });

  it('an already-tried or unavailable result is no next hop', async () => {
    h.resolveModel.mockResolvedValueOnce(makeResolvedModel('platform', { offering: { id: 'p', displayName: 'P' } }));
    expect(await nextAgentHop(base)).toMatchObject({ ok: false, reason: 'no_next_hop' });
    h.resolveModel.mockResolvedValueOnce({ ok: false, reason: 'model_unavailable', recoverable: true, offeringId: null, message: 'gone' });
    expect(await nextAgentHop(base)).toMatchObject({ ok: false, reason: 'no_next_hop', message: 'gone' });
  });
});

describe('markStaleHopReservations (crash between recording hop n and settling hop n-1)', () => {
  it('marks an earlier hop\'s still-active reservation indeterminate, and leaves settled ones alone', async () => {
    h.reservationRows = { 'ai-agent-run:run-1': { id: 'r0', status: 'active' } };
    expect(await markStaleHopReservations({ runId: 'run-1', orgId: 'org-1', uptoHop: 1 })).toBe(1);
    expect(h.markIndeterminate).toHaveBeenCalledWith({ orgId: 'org-1', reservationId: 'r0' });
    h.reservationRows = { 'ai-agent-run:run-1': { id: 'r0', status: 'settled' } };
    h.markIndeterminate.mockClear();
    expect(await markStaleHopReservations({ runId: 'run-1', orgId: 'org-1', uptoHop: 1 })).toBe(0);
    expect(h.markIndeterminate).not.toHaveBeenCalled();
  });
});

describe('startHopFor (re-drive resume)', () => {
  it('a fresh run starts at hop 0 on the admitted offering', () => {
    expect(startHopFor({ admittedOfferingId: 'p' })).toEqual({ requestedOfferingId: 'p', hop: 0 });
  });
  it('a re-driven run resumes on the hop it last reserved', () => {
    expect(startHopFor({ admittedOfferingId: 'p', servedOfferingId: 'k', servedFailoverHop: 1 })).toEqual({ requestedOfferingId: 'k', hop: 1 });
  });
});
```

Append to the W03 run-loop billing test. That file mocks `@anthropic-ai/claude-agent-sdk`'s `query` with a scripted async iterator, plus `resolveModel`, `reserveAiBudget`, `settleInvocation` and `grantCatalogSdkEgress`. Also mock `./agentRunFailover`'s `nextAgentHop` / `recordServedHop` and `../aiModels/offeringHealth`'s `noteProviderFailure`.

```ts
describe('W09 run failover', () => {
  const primary = () => makeResolvedModel('platform', { surface: 'ai_agents', role: 'analysis', offering: { id: 'p', displayName: 'P' }, failoverRemaining: ['k'] });
  const backup = () => makeResolvedModel('anthropic_byok', { surface: 'ai_agents', role: 'analysis', offering: { id: 'k', displayName: 'K' },
    failover: { fromOfferingId: 'p', hop: 1, cause: 'overloaded' }, failoverRemaining: [] });
  const retry = (attempt: number) => ({ type: 'system', subtype: 'api_retry', attempt, max_retries: 10, retry_delay_ms: 0, error_status: 529, error: 'overloaded' });

  it('fails over after the CLI\'s retry budget; each hop reserves and settles on its own key', async () => {
    resolveModel.mockResolvedValueOnce(primary());
    nextAgentHop.mockResolvedValueOnce({ ok: true, resolved: backup() });
    scriptQueries([
      [retry(1), retry(2)],                                    // hop 0: aborted by shouldFailOverNow
      [successResult({ 'claude-sonnet-5-5': USAGE })],          // hop 1 serves
    ]);
    await runAgentLoop(runContext({ id: 'run-1' }));
    expect(reserveAiBudget.mock.calls.map((c) => [c[0].idempotencyKey, c[0].billingSource])).toEqual([
      ['ai-agent-run:run-1', 'platform'],
      ['ai-agent-run:run-1:hop:1', 'partner_key'],
    ]);
    expect(settleInvocation.mock.calls.map((c) => [c[0].binding.offeringId, c[0].usage.length])).toEqual([['p', 0], ['k', 1]]);
    expect(noteProviderFailure).toHaveBeenCalledWith(expect.objectContaining({ offering: { id: 'p', displayName: 'P' } }), 'overloaded');
  });

  it('a tool executed before the failure → no failover, the hop settles normally', async () => {
    resolveModel.mockResolvedValueOnce(primary());
    scriptQueries([[toolUseThenExecute('device_info'), retry(5), errorResult()]]);
    await runAgentLoop(runContext({ id: 'run-2' }));
    expect(nextAgentHop).not.toHaveBeenCalled();
    expect(reserveAiBudget).toHaveBeenCalledTimes(1);
  });

  it('nothing configured → W03 behaviour: no abort on retries, one reservation', async () => {
    resolveModel.mockResolvedValueOnce({ ...primary(), failoverRemaining: [] });
    scriptQueries([[retry(1), retry(2), retry(3), errorResult()]]);
    await runAgentLoop(runContext({ id: 'run-3' }));
    expect(nextAgentHop).not.toHaveBeenCalled();
    expect(reserveAiBudget).toHaveBeenCalledTimes(1);
  });

  it('a re-driven run resumes on its persisted hop key and offering', async () => {
    resolveModel.mockResolvedValueOnce(backup());
    scriptQueries([[successResult({ 'claude-sonnet-5-5': USAGE })]]);
    await runAgentLoop(runContext({ id: 'run-4', admittedOfferingId: 'p', fundingSource: 'platform',
      servedOfferingId: 'k', servedFundingSource: 'partner_key', servedFailoverHop: 1 }));
    expect(resolveModel).toHaveBeenCalledWith(expect.objectContaining({ requested: { offeringId: 'k', origin: 'policy' } }));
    expect(reserveAiBudget.mock.calls[0]![0].idempotencyKey).toBe('ai-agent-run:run-4:hop:1');
  });

  it('a queued run whose admitted offering went ineligible may cross funding only via a configured failover that is admitted', async () => {
    resolveModel.mockResolvedValueOnce(makeResolvedModel('anthropic_byok', { surface: 'ai_agents', offering: { id: 'k', displayName: 'K' }, failover: null }));
    await expect(runAgentLoop(runContext({ id: 'run-5', admittedOfferingId: 'p', fundingSource: 'platform' }))).rejects.toMatchObject({ name: 'AgentRunBlockedError' });
    resolveModel.mockResolvedValueOnce(backup());
    scriptQueries([[successResult({ 'claude-sonnet-5-5': USAGE })]]);
    await runAgentLoop(runContext({ id: 'run-6', admittedOfferingId: 'p', fundingSource: 'platform' }));
    expect(recordServedHop).toHaveBeenCalledWith('run-6', { offeringId: 'k', funding: 'partner_key', hop: 1, cause: 'overloaded' });
  });

  it('an error RESULT with usage is billed on its hop before failing over (Codex 1)', async () => {
    resolveModel.mockResolvedValueOnce(primary());
    nextAgentHop.mockResolvedValueOnce({ ok: true, resolved: backup() });
    scriptQueries([
      [errorResultWithUsage({ status: 401, usage: USAGE })],   // pre-output, but tokens were billed
      [successResult({ 'claude-sonnet-5-5': USAGE })],
    ]);
    await runAgentLoop(runContext({ id: 'run-7' }));
    expect(settleInvocation.mock.calls[0]![0]).toMatchObject({ binding: { offeringId: 'p' } });
    expect(settleInvocation.mock.calls[0]![0].usage.length).toBeGreaterThan(0);
  });

  it('a hop transition after the deadline dispatches nothing more (Codex 7)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    resolveModel.mockResolvedValueOnce(primary());
    nextAgentHop.mockImplementationOnce(async () => { vi.setSystemTime(Date.now() + 10 * 60 * 60 * 1000); return { ok: true, resolved: backup() }; });
    scriptQueries([[retry(1), retry(2)]]);
    await runAgentLoop(runContext({ id: 'run-8' }));
    expect(reserveAiBudget).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('a re-drive marks earlier hops\' stale reservations before reserving its own', async () => {
    resolveModel.mockResolvedValueOnce(backup());
    scriptQueries([[successResult({ 'claude-sonnet-5-5': USAGE })]]);
    await runAgentLoop(runContext({ id: 'run-9', admittedOfferingId: 'p', fundingSource: 'platform',
      servedOfferingId: 'k', servedFundingSource: 'partner_key', servedFailoverHop: 1, servedFailoverCause: 'overloaded' }));
    expect(markStaleHopReservations).toHaveBeenCalledWith({ runId: 'run-9', orgId: expect.any(String), uptoHop: 1 });
    expect(settleInvocation.mock.calls[0]![0].binding.failover).toMatchObject({ hop: 1, cause: 'overloaded' });
  });
});
```

`scriptQueries`, `successResult`, `errorResult`, `errorResultWithUsage`, `toolUseThenExecute`, `USAGE` and `runContext` are local helpers. `errorResultWithUsage({ status, usage })` is a `result` message with `is_error: true`, `api_error_status`, and that `modelUsage`. Build them from the W03 file's existing scripted-query helper. `scriptQueries` hands the n-th `query()` call the n-th script. `toolUseThenExecute(name)` emits an assistant `tool_use` block and drives the MCP pre/post hooks the way the file's existing tool-execution case does.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiAgents/agentRunFailover.test.ts src/services/aiAgents/runLoop.test.ts -t "W09"`
Expected: FAIL (module missing; one reservation only).

- [ ] **Step 3: Implement `agentRunFailover.ts`**

```ts
/**
 * AI model registry W09 (#7607): the run loop's failover hop. A run fails
 * over only on a PRE-OUTPUT provider failure (runLoop.ts decides that); this
 * module re-resolves the run's role with every tried offering excluded,
 * admits the next hop's funding (credits on platform, caps on both), and
 * records the hop on the run BEFORE its reservation exists, so a re-driven
 * run resumes on the same hop key and can never reserve a hop twice.
 */
import { eq } from 'drizzle-orm';
import type { AiAgentEscalationRole } from '@breeze/shared';
import { db, withSystemDbAccessContext } from '../../db';
import { aiAgentRuns } from '../../db/schema';
import { and } from 'drizzle-orm';
import { aiBudgetReservations } from '../../db/schema';
import { markAiBudgetReservationIndeterminate } from '../aiBudgetReservations';
import { checkBudgetDetailed, type AiBillingSource } from '../aiCostTracker';
import { hopIdempotencyKey, type FailoverCause, type ProviderFailureCause } from '../aiModels/failover';
import { resolveModel, type FailoverOrigin, type ResolvedModel } from '../aiModels/resolveModel';

export async function recordServedHop(
  runId: string,
  served: { offeringId: string; funding: AiBillingSource; hop: number; cause: FailoverCause },
): Promise<void> {
  await withSystemDbAccessContext(() => db
    .update(aiAgentRuns)
    .set({
      servedOfferingId: served.offeringId, servedFundingSource: served.funding,
      servedFailoverHop: served.hop, servedFailoverCause: served.cause,
    })
    .where(eq(aiAgentRuns.id, runId)));
}

/**
 * Codex review 5: the run row names hop n before hop n-1 is settled. A crash
 * in between leaves an earlier hop's reservation ACTIVE. On re-drive, mark any
 * such reservation indeterminate (W03's unknown-outcome state: it keeps holding
 * capacity until its TTL, is never re-reserved, never debited at a guess).
 * Returns how many it marked.
 */
export async function markStaleHopReservations(input: { runId: string; orgId: string; uptoHop: number }): Promise<number> {
  let marked = 0;
  for (let n = 0; n < input.uptoHop; n++) {
    const key = hopIdempotencyKey(`ai-agent-run:${input.runId}`, n);
    const [row] = await withSystemDbAccessContext(() => db
      .select({ id: aiBudgetReservations.id, status: aiBudgetReservations.status })
      .from(aiBudgetReservations)
      .where(and(eq(aiBudgetReservations.orgId, input.orgId), eq(aiBudgetReservations.idempotencyKey, key)))
      .limit(1));
    if (row?.status === 'active') {
      await markAiBudgetReservationIndeterminate({ orgId: input.orgId, reservationId: row.id });
      marked++;
    }
  }
  return marked;
}

export type NextAgentHop =
  | { ok: true; resolved: ResolvedModel }
  | { ok: false; reason: 'no_next_hop' | 'admission_denied'; message: string };

export async function nextAgentHop(input: {
  runId: string;
  orgId: string;
  partnerId: string;
  role: AiAgentEscalationRole;
  requestedOfferingId: string | null;
  tried: readonly string[];
  cause: ProviderFailureCause;
  hop: number;
  /** The run's first hop (its admitted offering and funding): F1 is judged against it. */
  origin: FailoverOrigin;
}): Promise<NextAgentHop> {
  const next = await resolveModel({
    partnerId: input.partnerId,
    orgId: input.orgId,
    surface: 'ai_agents',
    role: input.role,
    ...(input.requestedOfferingId ? { requested: { offeringId: input.requestedOfferingId, origin: 'policy' as const } } : {}),
    excludeOfferingIds: input.tried,
    failoverCause: input.cause,
    failoverOrigin: input.origin,
  });
  if (!next.ok) return { ok: false, reason: 'no_next_hop', message: next.message };
  if (!next.offering.id || input.tried.includes(next.offering.id)) {
    return { ok: false, reason: 'no_next_hop', message: 'No other AI model is available for this agent.' };
  }
  const denial = await checkBudgetDetailed(input.orgId, next.funding);
  if (denial) return { ok: false, reason: 'admission_denied', message: denial.message };
  await recordServedHop(input.runId, { offeringId: next.offering.id, funding: next.funding, hop: input.hop, cause: input.cause });
  return { ok: true, resolved: next };
}

export function startHopFor(run: {
  servedOfferingId?: string | null;
  servedFailoverHop?: number | null;
  admittedOfferingId?: string | null;
}): { requestedOfferingId: string | null; hop: number } {
  if (run.servedOfferingId && run.servedFailoverHop) {
    return { requestedOfferingId: run.servedOfferingId, hop: run.servedFailoverHop };
  }
  return { requestedOfferingId: run.admittedOfferingId ?? null, hop: 0 };
}
```

`AiBillingSource` is exported from `aiCostTracker.ts` (W03 imports it from there); if not, import it from `../aiBudgetReservations`.

- [ ] **Step 4: Implement the run-loop changes (`runLoop.ts`)**

1. **Run loader** (~L290): select `servedOfferingId: aiAgentRuns.servedOfferingId`, `servedFundingSource: aiAgentRuns.servedFundingSource`, `servedFailoverHop: aiAgentRuns.servedFailoverHop` next to `admittedOfferingId`. Add the three optional fields to `RunContext.run` in `runLoopTypes.ts`.

2. **Start resolution** (~L1854): replace

```ts
  const requestedOfferingId = run.admittedOfferingId ?? effective.offeringId ?? null;
```

with

```ts
  // W09: a re-driven run resumes on the hop it last reserved (agentRunFailover.ts).
  const start = startHopFor(run);
  const requestedOfferingId = start.requestedOfferingId ?? effective.offeringId ?? null;
  const modelRole = agentRunModelRole(run);
  // The run's failover origin: its ADMITTED offering and funding (F1 is judged against it on every hop).
  const runOrigin: FailoverOrigin | null = run.admittedOfferingId && run.fundingSource
    ? { offeringId: run.admittedOfferingId, funding: run.fundingSource, connectionId: null }
    : null;
  if (start.hop > 0) await markStaleHopReservations({ runId: run.id, orgId: run.orgId, uptoHop: start.hop });
```

In that `resolveModel` call, pass `role: modelRole` (Task 10). When `start.hop > 0`, also pass `failoverOrigin: runOrigin`, plus `failoverCause: run.servedFailoverCause` when it is a provider cause. `runOrigin.connectionId` is `null` because agents never set `sameConnectionOnly`.

3. **Funding guard** (~L1871): replace W03's `if (run.fundingSource && agentModel.funding !== run.fundingSource) { … throw … }` with:

```ts
  const runFunding = run.servedFundingSource ?? run.fundingSource;
  let hopIndex = start.hop;
  if (runFunding && agentModel.funding !== runFunding) {
    // W09 (F1/F3): a queued run's funding may move only through a CONFIGURED
    // cross-funding failover (the resolver walked to it), and only once the
    // new funding is admitted. Anything else is W03's blocked run.
    const denial = agentModel.failover ? await checkBudgetDetailed(run.orgId, agentModel.funding) : null;
    if (!agentModel.failover || denial || !agentModel.offering.id) {
      const message = denial?.message ?? 'The agent\'s AI model changed funding source after the run was admitted. Run it again.';
      throw new AgentRunBlockedError(
        'model_unavailable',
        blockedOutcome('model_unavailable', { message, offeringId: agentModel.offering.id }),
        message,
      );
    }
    hopIndex = Math.max(hopIndex, 0) + 1;
    await recordServedHop(run.id, { offeringId: agentModel.offering.id, funding: agentModel.funding, hop: hopIndex, cause: agentModel.failover.cause });
  } else if (agentModel.failover && agentModel.offering.id && agentModel.offering.id !== start.requestedOfferingId) {
    // Same funding, different offering (the admitted one went ineligible): provenance only.
    hopIndex = Math.max(hopIndex, 0) + 1;
    await recordServedHop(run.id, { offeringId: agentModel.offering.id, funding: agentModel.funding, hop: hopIndex, cause: agentModel.failover.cause });
  }
  let hopModel = agentModel;
  let binding = turnBindingFrom(hopModel);
  // Codex review 5: a resumed run keeps its ledger provenance (hop and cause from the run row).
  if (start.hop > 0 && binding.failover) {
    binding = { ...binding, failover: { ...binding.failover, hop: start.hop, cause: (run.servedFailoverCause ?? binding.failover.cause) as FailoverCause } };
  }
```

Remove W03's `const binding = turnBindingFrom(agentModel);`. Every later use of `agentModel` inside the dispatch block (`sdkModelOptions`, `buildClaudeSdkChildEnv`, `grantCatalogSdkEgress`, `applyPromptProfile`, the provenance `model`) becomes `hopModel`. `billingSource` is re-derived per hop from `hopModel.funding`.

4. **Dispatch loop.** Wrap the code from `const reservation = await reserveAiBudget({` (~L2092) through the SDK `try { … } catch { … } finally { … }` (~L2277) in a hop loop. The variables the post-loop settlement reads (`reservationId`, `binding`, `billed`, `turnOutcome`, `receivedResult`, `usageConfirmed`, `failure`, `summary`, `turnCount`, `costCents`) become `let`s declared **before** the loop. They are reset at the top of each iteration, except `turnCount`, which accumulates. Use this skeleton, keeping W03's bodies where marked:

```ts
  const baseReservationKey = `ai-agent-run:${run.id}`;
  const tried: string[] = [...new Set([run.admittedOfferingId, run.servedOfferingId, hopModel.offering.id]
    .filter((id): id is string => typeof id === 'string'))];
  let currentAbort = new AbortController();
  let reservationId = '';
  let priorHopsCostCents = 0;
  // …the other per-hop lets (billed, observation, usageSnapshot, lastResult, turnOutcome, receivedResult,
  //    usageConfirmed, failure, summary) declared here, as W03 declares them today…
  const wallClockTimer = setTimeout(() => { wallClockExceeded = true; currentAbort.abort(); }, wallClockMs);

  for (;;) {
    billed.length = 0; observation = newSdkTurnObservation(); usageSnapshot = null; lastResult = null;
    turnOutcome = null; receivedResult = false; usageConfirmed = true; failure = undefined; summary = '';
    currentAbort = new AbortController();
    const toolsAtHopStart = outcome.toolExecutionCount;
    let failoverCause: ProviderFailureCause | null = null;

    const reservation = await reserveAiBudget({
      orgId: run.orgId,
      idempotencyKey: hopIdempotencyKey(baseReservationKey, hopIndex),
      billingSource: hopModel.funding,
      maxHoldCents: runLimits.maxBudgetCentsPerRun,
      binding,
    });
    if (reservation.kind === 'denied') throw new AgentRunError('org_budget_exceeded', reservation.message);
    reservationId = reservation.reservationId;
    // …W03's grantCatalogSdkEgress block (key `agent-run:${run.id}:${hopIndex}`, hopModel) and maxBudgetCents…

    try {
      await runOutsideDbContext(async () => {
        const sdkQuery = query({ prompt: buildAgentRunTaskPrompt(prompt), options: {
          ...sdkModelOptions(hopModel),
          // …W03's options, with `abortController: currentAbort` and hopModel's child env…
        } });
        try {
          for await (const message of sdkQuery) {
            observeSdkMessage(observation, message);
            // W09: a NON-result message may fail over once the CLI's own retries
            // are spent and nothing was produced. A result is never short-circuited:
            // W03's handling below bills its usage first (Codex review 1), and the
            // post-hop check decides.
            if (message.type !== 'result') {
              const now = outcome.toolExecutionCount === toolsAtHopStart ? shouldFailOverNow(observation, hopModel.failoverRemaining) : null;
              if (now) { failoverCause = now; currentAbort.abort(); break; }
            }
            // …W03's assistant / result handling, unchanged, except:
            //    costCents = priorHopsCostCents + sumCostCents(priceUsage(binding, billed));
          }
        } finally {
          // …W03's sdkQuery.close()…
        }
      });
    } catch (error) {
      // …W03's catch, with `failoverCause` added to the controlled-stop condition:
      //    if (wallClockExceeded || budgetExceeded || maxTurnsExceeded || failure || failoverCause) { warn } else { failure = sdk_error }
    } finally {
      // …W03's egress revoke…
    }

    // A terminal SDK failure with a classified provider error, no output and no
    // tool executed this hop is failover-eligible too (the CLI gave up before
    // shouldFailOverNow's threshold, e.g. a 401).
    if (!failoverCause && failure && !observation.sawOutput && outcome.toolExecutionCount === toolsAtHopStart
        && observation.providerFailure && hopModel.failoverRemaining.length > 0) {
      failoverCause = observation.providerFailure.cause;
    }
    if (!failoverCause || wallClockExceeded || hopIndex + 1 > MAX_FAILOVER_HOP) break;

    await noteProviderFailure(hopModel, failoverCause);
    // Codex review 5: resolve, admit and RECORD the next hop before settling this one.
    const next = await nextAgentHop({
      runId: run.id, orgId: run.orgId, partnerId: ctx.orgPartnerId, role: modelRole,
      requestedOfferingId, tried, cause: failoverCause, hop: hopIndex + 1,
      origin: runOrigin ?? failoverOriginOf(agentModel),
    });
    // F4: settle THIS hop on its own binding and reservation.
    try {
      const settledHop = await settleInvocation({
        binding, orgId: run.orgId, userId: null, sessionId: null, agentRunId: run.id, sourceRef: null,
        usage: billed,
        outcome: turnOutcome ?? {
          stopReason: 'error', refused: false, refusalCategory: null, fallbackUsed: false,
          servedModel: binding.wireModel, providerModel: null, sdkReportedCostUsd: null,
        },
        reservationId, messageCount: Math.max(0, turnCount), toolExecutionCount: 0, turnCount: 0,
      });
      priorHopsCostCents += settledHop.costCents;
    } catch (error) {
      console.error('[aiAgentRunLoop] failed to settle a failed-over hop', { runId: run.id, error });
      await markAiBudgetReservationIndeterminate({ orgId: run.orgId, reservationId }).catch(() => undefined);
    }
    if (!next.ok) {
      failure = { errorCode: next.reason === 'admission_denied' ? 'org_budget_exceeded' : 'llm_unavailable', message: next.message };
      // The failed hop is settled; nothing is left for the post-loop settlement.
      receivedResult = false; turnOutcome = null; reservationId = '';
      break;
    }
    // Codex review 7: never dispatch a hop after the run's deadline.
    if (Date.now() >= deadlineMs) {
      wallClockExceeded = true;
      receivedResult = false; turnOutcome = null; reservationId = '';
      break;
    }
    hopIndex += 1;
    tried.push(next.resolved.offering.id!);
    hopModel = next.resolved;
    binding = turnBindingFrom(hopModel);
  }
  clearTimeout(wallClockTimer);
```

In the post-loop settlement block (W03, ~L2290):
- guard with `if (reservationId)`, so a run that ended in `nextAgentHop` failure (its last hop already settled) settles nothing more;
- set `costCents = priorHopsCostCents + settled.costCents`;
- keep `markAiBudgetReservationIndeterminate({ orgId: run.orgId, reservationId })` for the "no result" branch only when `reservationId` is non-empty.

Imports: `hopIdempotencyKey`, `MAX_FAILOVER_HOP`, `shouldFailOverNow`, `type FailoverCause`, `type ProviderFailureCause` from `../aiModels/failover`; `noteProviderFailure` from `../aiModels/offeringHealth`; `failoverOriginOf` from `../aiModels/failoverDispatch`; `type FailoverOrigin` from `../aiModels/resolveModel`; `markStaleHopReservations`, `nextAgentHop`, `recordServedHop`, `startHopFor` from `./agentRunFailover`; `agentRunModelRole` from `./agentModelRole`; `checkBudgetDetailed` from `../aiCostTracker`.

The compute settlement (~L2764) is **not** changed: it reads `ctx.run.fundingSource` (D7).

- [ ] **Step 5: Real-Postgres re-drive cases**

The first case below pins the crash window (Codex review 5). Add it next to the second:

```ts
  it('a crash after recording hop 1 but before settling hop 0: re-drive marks hop 0 indeterminate, never debits it, and reserves hop 1', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-w09-integration-placeholder';
    installBillingStub();
    const f = await seedFailoverPartner();
    const r = await resolveModel({ partnerId: f.partnerId, orgId: f.orgId, surface: 'ai_agents' });
    if (!r.ok) throw new Error(r.reason);
    const runId = randomUUID();
    const hop0 = await reserveFailoverHop({ orgId: f.orgId })(r, turnBindingFrom(r), `ai-agent-run:${runId}`);   // never settled
    if (!hop0.ok) throw new Error('not admitted');
    expect(await markStaleHopReservations({ runId, orgId: f.orgId, uptoHop: 1 })).toBe(1);
    const [row] = await fixtureSql`SELECT status FROM ai_budget_reservations WHERE id = ${hop0.reservationId}`;
    expect(row!.status).toBe('indeterminate');
    const hop1 = await reserveFailoverHop({ orgId: f.orgId })(r, turnBindingFrom(r), `ai-agent-run:${runId}:hop:1`);
    expect(hop1.ok).toBe(true);
    expect(deducts).toEqual([]);
    vi.unstubAllGlobals();
  });
```

Add `markStaleHopReservations` to the file's imports.

Append to `aiModelFailoverFunding.integration.test.ts`:

```ts
describe.runIf(RUN)('W09 agent-run hop keys', () => {
  it('a re-drive reserves the SAME hop reservation, and settling it twice debits once', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-w09-integration-placeholder';
    installBillingStub();
    const f = await seedFailoverPartner();
    const r = await resolveModel({ partnerId: f.partnerId, orgId: f.orgId, surface: 'ai_agents' });
    if (!r.ok) throw new Error(r.reason);
    const binding = turnBindingFrom(r);
    const key = `ai-agent-run:${randomUUID()}:hop:1`;
    const a = await reserveFailoverHop({ orgId: f.orgId })(r, binding, key);
    const b = await reserveFailoverHop({ orgId: f.orgId })(r, binding, key);          // the re-driven run
    if (!a.ok || !b.ok) throw new Error('not admitted');
    expect(b.reservationId).toBe(a.reservationId);
    const settle = () => settleInvocation({
      binding, orgId: f.orgId, userId: null, sessionId: null, agentRunId: null, sourceRef: 'w09',
      ...messagesUsage(binding, [{ wireModel: binding.wireModel, message: message(binding.wireModel) }]), reservationId: a.reservationId,
    });
    await settle();
    await settle();
    expect(deducts.filter((d) => d.key === `ai-settlement:${a.reservationId}`)).toHaveLength(1);
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 6: Run tests**

Run: `cd apps/api && npx vitest run src/services/aiAgents/agentRunFailover.test.ts src/services/aiAgents/runLoop.test.ts src/services/aiAgents/runService.test.ts`
Then: `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiModelFailoverFunding.integration.test.ts`
Expected: PASS, including every W03 run-loop case. With no list configured the loop runs exactly once, on the W03 key.

- [ ] **Step 7: Commit**

Stage the new module and its test, `runLoop.ts`, `runLoopTypes.ts`, the run-loop test and the integration suite. Commit message: `feat(ai-agents): runs fail over between hops before any output; per-hop reservation, settlement and funding re-admission; re-drive resumes the hop (#7607)`, ending with the Co-Authored-By trailer.

---

## Task 12: `/ai/models` API — role rows, fallback lists, cross-funding; the snapshot; usage `failovers`

**Files:**
- Modify: `apps/api/src/services/aiModels/assignmentWrites.ts`, `assignmentWrites.test.ts` (W04)
- Modify: `apps/api/src/services/aiModels/registryView.ts`, `registryView.test.ts` (W04)
- Modify: `apps/api/src/services/aiModels/usageQueries.ts`, `usageQueries.test.ts` (W04)
- Modify: `apps/api/src/routes/aiModels/connections.ts` (W04 key-rotate handler) (+ its test)
- Modify: `apps/api/src/__tests__/integration/aiModelsRoutes.integration.test.ts` (W04, append)

**Interfaces:**
- Consumes: Task 1 (schemas, DTOs), Task 4 `selectRoleRows`, Task 3 `clearConnectionCooldowns`; P21.
- Produces:
  - `putPartnerAssignments` accepts role rows (`defaultOfferingId: null` on a role row deletes it) and fallback fields;
  - `putOrgAssignments` accepts role rows, a narrowed fallback list and `fallbackMayCrossFunding: false`;
  - new export `conditionalDeletePartnerRoleRow(tx, partnerId, row)`;
  - new 422 code `crosses_funding` (`RegistryWriteCode` gains it);
  - every assignment 422 `details` now carries `role`;
  - `buildPartnerModelsSnapshot().defaults` has one entry per `CONFIGURABLE_AI_SURFACE_ROLES` pair;
  - `buildOrgModelDefaults().surfaces` likewise, merged with `selectRoleRows`;
  - `AiUsageRowDto.failovers`.

Partner validation, added to W04's rules (each failure is a 422 with `details: { surface, role, field, offeringId? }`):

| Rule | Else |
|---|---|
| A role row with `defaultOfferingId: null` is a delete (inherit). It must have an existing row version, or it is a no-op when none exists. | — |
| Each fallback id passes `assertOfferingUsableForSurface` (enabled, eligible, owned, tools on tool surfaces). | `not_eligible` / `tools_unsupported` (`field: 'fallbackOfferingIds'`) |
| With a permitted list, each fallback id is in it. | `invalid` (`field: 'fallbackOfferingIds'`) |
| A fallback whose funding differs from the row default's needs the row's effective `fallbackMayCrossFunding` to be true (the payload's value, else the stored one). | `crosses_funding` |
| Omitted fallback fields are **not written** (W04 rows keep their stored list). | — |

Org validation, added to W04's rules:
- The partner reference row for `(surface, role)` is `selectRoleRows(partnerRows, role).partner`: the role row, else the `default` row. With that, an org may override a role the partner left on the default.
- Each org fallback id must be usable, inside the partner's permitted set, and inside the org row's own permitted set. Otherwise 422 `widens_partner` with `field: 'fallbackOfferingIds'`.
- A fallback crossing the org's effective default funding requires the partner's effective `fallbackMayCrossFunding` and the org not having set `false`. Otherwise 422 `widens_partner` with `key: 'crossFunding'`.
- `isBlank` treats absent or `null` fallback fields as blank.

- [ ] **Step 1: Write the failing tests**

Append to `assignmentWrites.test.ts` (W04's `cand()`, `h`, `P`, `A`, `B`, `C` exist; add `funding` to `cand`'s `over` where shown):

```ts
describe('W09 partner role rows and fallbacks', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    surface: 'ai_agents' as const, role: 'default' as const, defaultOfferingId: A, permittedOfferingIds: null as string[] | null,
    allowUserChoice: true, options: null, expectedUpdatedAt: null as string | null, ...over,
  });
  beforeEach(() => {
    h.candidates.set(A, cand());                                          // platform
    h.candidates.set(B, cand());                                          // platform
    h.candidates.set(C, cand({ connection: { kind: 'anthropic_byok', status: 'active', keyUsable: true }, platform: null },
      { connectionId: 'conn-1', funding: 'partner_key' }));              // BYOK
  });

  it('writes a triage row with an ordered fallback list', async () => {
    await putPartnerAssignments({ partnerId: P, rows: [row({ role: 'triage', defaultOfferingId: B, fallbackOfferingIds: [A], fallbackMayCrossFunding: false })] });
    expect(h.upserts[0].values).toMatchObject({ role: 'triage', defaultOfferingId: B, fallbackOfferingIds: [A], fallbackMayCrossFunding: false });
  });

  it('omitted fallback fields are not written (the stored list is kept)', async () => {
    await putPartnerAssignments({ partnerId: P, rows: [row()] });
    expect(h.upserts[0].values).not.toHaveProperty('fallbackOfferingIds');
    expect(h.upserts[0].values).not.toHaveProperty('fallbackMayCrossFunding');
  });

  it('an empty list is stored as NULL (no failover)', async () => {
    await putPartnerAssignments({ partnerId: P, rows: [row({ fallbackOfferingIds: [] })] });
    expect(h.upserts[0].values).toMatchObject({ fallbackOfferingIds: null });
  });

  it('422 crosses_funding: a BYOK fallback for a platform default with crossing off', async () => {
    const err = await putPartnerAssignments({ partnerId: P, rows: [row({ fallbackOfferingIds: [C], fallbackMayCrossFunding: false })] }).catch((e) => e);
    expect([err.status, err.code, err.details]).toEqual([422, 'crosses_funding',
      { surface: 'ai_agents', role: 'default', field: 'fallbackOfferingIds', offeringId: C }]);
    expect(h.upserts).toHaveLength(0);
  });

  it('…and accepts it once crossing is allowed', async () => {
    await putPartnerAssignments({ partnerId: P, rows: [row({ fallbackOfferingIds: [C], fallbackMayCrossFunding: true })] });
    expect(h.upserts[0].values).toMatchObject({ fallbackOfferingIds: [C], fallbackMayCrossFunding: true });
  });

  it('a stored crossing flag counts when the payload omits it', async () => {
    h.partnerRows = [{ id: 'r1', surface: 'ai_agents', role: 'default', orgId: null, fallbackMayCrossFunding: true, updatedAt: new Date('2026-10-01T10:00:00.000Z') }];
    await putPartnerAssignments({ partnerId: P, rows: [row({ fallbackOfferingIds: [C], expectedUpdatedAt: '2026-10-01T10:00:00.000Z' })] });
    expect(h.upserts[0].kind).toBe('update');
  });

  it('422 invalid: a fallback outside the row\'s permitted list', async () => {
    const err = await putPartnerAssignments({ partnerId: P, rows: [row({ permittedOfferingIds: [A], fallbackOfferingIds: [B] })] }).catch((e) => e);
    expect([err.code, err.details.field, err.details.offeringId]).toEqual(['invalid', 'fallbackOfferingIds', B]);
  });

  it('clearing a role row deletes it (the role inherits the feature default)', async () => {
    h.partnerRows = [{ id: 'r2', surface: 'ai_agents', role: 'triage', orgId: null, updatedAt: new Date('2026-10-01T10:00:00.000Z') }];
    await putPartnerAssignments({ partnerId: P, rows: [row({ role: 'triage', defaultOfferingId: null, expectedUpdatedAt: '2026-10-01T10:00:00.000Z' })] });
    expect(h.deletes).toHaveLength(1);
    expect(h.upserts).toHaveLength(0);
  });
});

describe('W09 org role rows and fallback narrowing', () => {
  const ORG = '55555555-5555-4555-8555-555555555555';
  const orgRow = (over: Record<string, unknown> = {}) => ({
    surface: 'ai_agents' as const, role: 'default' as const, defaultOfferingId: null as string | null,
    permittedOfferingIds: null as string[] | null, allowUserChoice: null as false | null,
    options: null as Record<string, unknown> | null, expectedUpdatedAt: null as string | null, ...over,
  });
  beforeEach(() => {
    for (const id of [A, B]) h.candidates.set(id, cand());
    h.candidates.set(C, cand({ connection: { kind: 'anthropic_byok', status: 'active', keyUsable: true }, platform: null }, { connectionId: 'conn-1', funding: 'partner_key' }));
    h.partnerRows = [{ surface: 'ai_agents', role: 'default', orgId: null, defaultOfferingId: A, permittedOfferingIds: [A, B, C],
      fallbackOfferingIds: [B, C], fallbackMayCrossFunding: true, allowUserChoice: true, options: null, updatedAt: new Date() }];
  });

  it('an org may narrow the fallback list and switch cross-funding off', async () => {
    await putOrgAssignments({ partnerId: P, orgId: ORG, rows: [orgRow({ fallbackOfferingIds: [B], fallbackMayCrossFunding: false })] });
    expect(h.upserts[0].values).toMatchObject({ fallbackOfferingIds: [B], fallbackMayCrossFunding: false });
  });

  it('an org\'s EMPTY list is stored as [] (no backups), never NULL (which would inherit) — Codex 8', async () => {
    await putOrgAssignments({ partnerId: P, orgId: ORG, rows: [orgRow({ fallbackOfferingIds: [] })] });
    expect(h.upserts[0].values.fallbackOfferingIds).toEqual([]);
  });

  it('an org override of a role the partner left on the default is accepted (reference = the default row)', async () => {
    await putOrgAssignments({ partnerId: P, orgId: ORG, rows: [orgRow({ role: 'triage', defaultOfferingId: B })] });
    expect(h.upserts[0].values).toMatchObject({ role: 'triage', defaultOfferingId: B });
  });

  it('422 widens_partner: a fallback outside the partner set, or crossing funding with the org\'s crossing off', async () => {
    h.partnerRows[0]!.permittedOfferingIds = [A, B];
    let err = await putOrgAssignments({ partnerId: P, orgId: ORG, rows: [orgRow({ fallbackOfferingIds: [C] })] }).catch((e) => e);
    expect([err.code, err.details.field]).toEqual(['widens_partner', 'fallbackOfferingIds']);
    h.partnerRows[0]!.permittedOfferingIds = [A, B, C];
    err = await putOrgAssignments({ partnerId: P, orgId: ORG, rows: [orgRow({ fallbackOfferingIds: [C], fallbackMayCrossFunding: false })] }).catch((e) => e);
    expect([err.code, err.details.key]).toEqual(['widens_partner', 'crossFunding']);
  });
});
```

Append to `usageQueries.test.ts`:

```ts
it('counts rows served by a failover hop', () => {
  const text = new PgDialect().sqlToQuery(buildUsageQuery({ groupBy: 'model', from: '2026-11-01', to: '2026-11-30', orgId: null })).sql;
  expect(text).toContain('FILTER (WHERE i.failover_hop > 0)');
  expect(toUsageRow({ key: 'k', label: 'L', invocations: '4', cost_cents: '1', input_tokens: '1', output_tokens: '1', refusals: '0', fallbacks: '0', failovers: '2' }).failovers).toBe(2);
});
```

Append to `registryView.test.ts`:

```ts
it('lists one defaults entry per (surface, role), ai_agents with its three stages', async () => {
  const snap = await buildPartnerModelsSnapshot(P);
  expect(snap.defaults.filter((d) => d.surface === 'ai_agents').map((d) => d.role)).toEqual(['default', 'triage', 'analysis', 'remediation']);
  expect(snap.defaults.find((d) => d.surface === 'chat')).toMatchObject({ role: 'default' });
});

it('the org view merges a role exactly as the resolver does (D2)', async () => {
  h.partnerRows = [
    { surface: 'ai_agents', role: 'default', orgId: null, defaultOfferingId: A, permittedOfferingIds: null, allowUserChoice: true, options: null, fallbackOfferingIds: null, fallbackMayCrossFunding: null, updatedAt: new Date() },
    { surface: 'ai_agents', role: 'triage', orgId: null, defaultOfferingId: B, permittedOfferingIds: null, allowUserChoice: true, options: null, fallbackOfferingIds: [A], fallbackMayCrossFunding: false, updatedAt: new Date() },
  ];
  h.orgRows = [{ surface: 'ai_agents', role: 'default', orgId: ORG, defaultOfferingId: A, permittedOfferingIds: null, allowUserChoice: null, options: null, fallbackOfferingIds: null, fallbackMayCrossFunding: null, updatedAt: new Date() }];
  const view = await buildOrgModelDefaults({ partnerId: P, orgId: ORG, canEdit: true, canEditReviewer: true });
  const triage = view.surfaces.find((s) => s.surface === 'ai_agents' && s.role === 'triage')!;
  expect(triage.effective).toMatchObject({ defaultOfferingId: B, defaultSource: 'partner', fallbackOfferingIds: [A], fallbackMayCrossFunding: false });
  expect(triage.org).toBeNull();     // no org row for (ai_agents, triage) itself
});
```

`h.partnerRows` / `h.orgRows` / `ORG` are the W04 `registryView.test.ts` mocks of `listAssignmentRows`; use the file's own names.

In the connections route test, next to W04's key-rotate case: `expect(clearConnectionCooldowns).toHaveBeenCalledWith(PARTNER_ID, CONNECTION_ID)` after a successful rotate. Mock `../../services/aiModels/offeringHealth`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/assignmentWrites.test.ts src/services/aiModels/usageQueries.test.ts src/services/aiModels/registryView.test.ts src/routes/aiModels/connections.test.ts`
Expected: FAIL (`crosses_funding` unknown, fallback fields not written, one defaults entry per surface, no `failovers`).

- [ ] **Step 3: Implement**

`registryWriteErrors.ts`: add `'crosses_funding'` to `RegistryWriteCode`.

`assignmentWrites.ts`:

```ts
type AssignmentValues = {
  defaultOfferingId: string | null; permittedOfferingIds: string[] | null;
  allowUserChoice: boolean | null; options: Record<string, unknown> | null;
  /** W09: written only when the payload carried them. */
  fallbackOfferingIds?: string[] | null;
  fallbackMayCrossFunding?: boolean | null;
};

/**
 * W09: omitted → not written (keep the stored value). On a PARTNER row [] and
 * NULL both mean "no failover", stored as NULL. On an ORG row they differ
 * (Codex review 8): NULL inherits the partner list, [] is an explicit "no
 * backups" override (mergeEffectiveAssignment honours an empty org list).
 */
function fallbackValues(
  row: { fallbackOfferingIds?: string[] | null; fallbackMayCrossFunding?: boolean | null },
  owner: 'partner' | 'org',
): Partial<AssignmentValues> {
  return {
    ...(row.fallbackOfferingIds !== undefined
      ? { fallbackOfferingIds: owner === 'partner' && row.fallbackOfferingIds?.length === 0 ? null : row.fallbackOfferingIds }
      : {}),
    ...(row.fallbackMayCrossFunding !== undefined ? { fallbackMayCrossFunding: row.fallbackMayCrossFunding } : {}),
  };
}

async function assertFallbacks(input: {
  partnerId: string; surface: AiSurface; role: string; ids: readonly string[];
  permitted: readonly string[] | null; reference: LoadedCandidate | null; crossFunding: boolean;
  ctx: EnableEligibilityContext; cache: Map<string, LoadedCandidate | null>;
  onOutsidePermitted: (offeringId: string) => never;
  onCrossesFunding: (offeringId: string) => never;
}): Promise<void> {
  for (const id of input.ids) {
    const fb = await assertOfferingUsableForSurface({
      partnerId: input.partnerId, offeringId: id, surface: input.surface, field: 'fallbackOfferingIds', ctx: input.ctx, cache: input.cache,
    });
    if (input.permitted && !input.permitted.includes(id)) input.onOutsidePermitted(id);
    if (input.reference && fb.funding !== input.reference.funding && !input.crossFunding) input.onCrossesFunding(id);
  }
}
```

In `putPartnerAssignments`'s validation loop, after W04's checks for the row (and **before** them, `if (row.defaultOfferingId === null) continue;` right after `assertNotStale`, since a cleared role row needs no checks):

```ts
    const existingRow = existing.find((e) => e.surface === row.surface && e.role === row.role);
    if (row.fallbackOfferingIds && row.fallbackOfferingIds.length > 0) {
      await assertFallbacks({
        partnerId: input.partnerId, surface: row.surface, role: row.role, ids: row.fallbackOfferingIds,
        permitted: row.permittedOfferingIds, reference: def,
        crossFunding: row.fallbackMayCrossFunding ?? existingRow?.fallbackMayCrossFunding ?? false,
        ctx, cache,
        onOutsidePermitted: (offeringId) => {
          throw new RegistryWriteError('A fallback must be one of the permitted models.', 'invalid', 422,
            { surface: row.surface, role: row.role, field: 'fallbackOfferingIds', offeringId });
        },
        onCrossesFunding: (offeringId) => {
          throw new RegistryWriteError(
            'That backup model is paid from a different source. Allow failover between Breeze credits and your own API key first.',
            'crosses_funding', 422, { surface: row.surface, role: row.role, field: 'fallbackOfferingIds', offeringId });
        },
      });
    }
```

Add `role: row.role` to every `details` object the partner/org validation throws. W04's tests that assert exact `details` gain `role: 'default'`; update their expected objects in the same commit.

In the write transaction:

```ts
      for (const row of input.rows) {
        if (row.defaultOfferingId === null) {   // a role row cleared → inherit the feature default
          await conditionalDeletePartnerRoleRow(tx, input.partnerId, row);
          continue;
        }
        out.push(await conditionalUpsert(tx, { kind: 'partner', partnerId: input.partnerId }, row, {
          defaultOfferingId: row.defaultOfferingId,
          permittedOfferingIds: row.permittedOfferingIds,
          allowUserChoice: row.allowUserChoice,
          options: row.options as Record<string, unknown> | null,
          ...fallbackValues(row, 'partner'),
        }));
      }
```

```ts
/** W09: clears a partner ROLE row at version V (no-op when there was none). Never a `default` row. */
export async function conditionalDeletePartnerRoleRow(
  tx: Tx, partnerId: string, row: { surface: string; role: string; expectedUpdatedAt: string | null },
): Promise<void> {
  if (row.role === 'default') throw new Error('conditionalDeletePartnerRoleRow: a default row is never deleted');
  if (row.expectedUpdatedAt === null) return;
  const deleted = await tx
    .delete(aiModelAssignments)
    .where(and(
      isNull(aiModelAssignments.orgId),
      eq(aiModelAssignments.partnerId, partnerId),
      eq(aiModelAssignments.surface, row.surface),
      eq(aiModelAssignments.role, row.role),
      versionMatches(row.expectedUpdatedAt),
    ))
    .returning({ id: aiModelAssignments.id });
  if (deleted.length === 0) {
    throw new RegistryWriteError('These defaults were changed by someone else. Reload and try again.', 'stale_write', 409, { surface: row.surface, role: row.role });
  }
}
```

The `conditionalUpsert` "Never writes fallback…" doc line becomes: `Writes fallback columns only when the caller's values carry them (W09).`

In `putOrgAssignments`:
- `isBlank` adds `&& (row.fallbackOfferingIds ?? null) === null && (row.fallbackMayCrossFunding ?? null) === null`.
- Replace `const p = partnerRows.find((r) => r.surface === row.surface && r.role === row.role);` with `const p = selectRoleRows(partnerRows.filter((r) => r.surface === row.surface), row.role).partner as (typeof partnerRows)[number] | null;`.
- After W04's options block, add:

```ts
    if (row.fallbackOfferingIds && row.fallbackOfferingIds.length > 0) {
      const crossFunding = (p?.fallbackMayCrossFunding ?? false) && row.fallbackMayCrossFunding !== false;
      await assertFallbacks({
        partnerId: input.partnerId, surface: row.surface, role: row.role, ids: row.fallbackOfferingIds,
        permitted: partnerSet, reference: effectiveDefault, crossFunding, ctx, cache,
        onOutsidePermitted: (offeringId) => widens(row.surface, 'fallbackOfferingIds', { offeringId, role: row.role }),
        onCrossesFunding: (offeringId) => widens(row.surface, 'fallbackOfferingIds', { offeringId, role: row.role, key: 'crossFunding' }),
      });
      for (const id of row.fallbackOfferingIds) {
        if (row.permittedOfferingIds && !row.permittedOfferingIds.includes(id)) widens(row.surface, 'fallbackOfferingIds', { offeringId: id, role: row.role });
      }
    }
```

In the org upsert values, add `...fallbackValues(row, 'org')`. Import `selectRoleRows` from `./assignments`.

`registryView.ts`:
- `buildPartnerModelsSnapshot`'s `defaults` maps `CONFIGURABLE_AI_SURFACE_ROLES`:

```ts
    defaults: CONFIGURABLE_AI_SURFACE_ROLES.map(({ surface, role }) => {
      const p = partnerRows.find((r) => r.surface === surface && r.role === role) ?? null;
      return {
        surface, role, requiresTools: TOOL_SURFACES.has(surface),
        partner: p && toAssignmentRowDto(p),
        orgOverrideCount: allRows.filter((r) => r.surface === surface && r.role === role && r.orgId !== null).length,
      };
    }),
```

- A local `toAssignmentRowDto(r)` returns W04's fields plus `fallbackOfferingIds: r.fallbackOfferingIds ?? null, fallbackMayCrossFunding: r.fallbackMayCrossFunding ?? null`. Use it in both builders.
- `buildOrgModelDefaults`'s `surfaces` maps `CONFIGURABLE_AI_SURFACE_ROLES`:

```ts
    surfaces: CONFIGURABLE_AI_SURFACE_ROLES.map(({ surface, role }) => {
      const rows = [...partnerRows, ...orgRows].filter((r) => r.surface === surface);
      const picked = selectRoleRows(rows, role);
      const eff = mergeEffectiveAssignment({ surface, role, ...picked });
      const ownOrgRow = orgRows.find((r) => r.surface === surface && r.role === role) ?? null;
      const p = picked.partner;
      return {
        surface, role, requiresTools: TOOL_SURFACES.has(surface),
        inherited: {
          defaultOfferingId: p?.defaultOfferingId ?? null, permittedOfferingIds: p?.permittedOfferingIds ?? null,
          allowUserChoice: p?.allowUserChoice ?? true, options: (p?.options ?? {}) as OfferingOptions,
          fallbackOfferingIds: [...(p?.fallbackOfferingIds ?? [])], fallbackMayCrossFunding: p?.fallbackMayCrossFunding ?? false,
        },
        org: ownOrgRow && toAssignmentRowDto(ownOrgRow),
        effective: {
          defaultOfferingId: eff.defaultOfferingId, defaultSource: eff.defaultSource,
          permittedOfferingIds: eff.permitted.kind === 'all' ? null : [...eff.permitted.offeringIds],
          allowUserChoice: eff.allowUserChoice, options: eff.options,
          fallbackOfferingIds: [...eff.fallbackOfferingIds], fallbackMayCrossFunding: eff.fallbackMayCrossFunding,
        },
      };
    }),
```

`usageQueries.ts`: append `,\n  COUNT(*) FILTER (WHERE i.failover_hop > 0)::text AS failovers` to `AGGREGATES`, `failovers: string` to `RawRow`, `failovers: Number(r.failovers ?? 0)` to `toUsageRow`, and `failovers: '0'` to the zero-total fallback.

`routes/aiModels/connections.ts` (W04 key-rotate handler): after the rotation succeeds and before the response, add `await clearConnectionCooldowns(auth.partnerId, connectionId).catch(() => undefined);` with the comment `// W09: a new key may fix auth_failed / quota_exhausted at once.`

- [ ] **Step 4: Real-Postgres route cases**

Append to `aiModelsRoutes.integration.test.ts`, using W04's partner/org seed and its authenticated `PUT` helpers:

```ts
it('W09: a partner writes a triage row with a fallback list; clearing it restores inheritance', async () => {
  const put = await partnerPut('/ai/models/assignments', { assignments: [{
    surface: 'ai_agents', role: 'triage', defaultOfferingId: offA2, permittedOfferingIds: null, allowUserChoice: true,
    options: null, fallbackOfferingIds: [offA], fallbackMayCrossFunding: false, expectedUpdatedAt: null,
  }] });
  expect(put.status).toBe(200);
  const [row] = await fixtureSql`SELECT fallback_offering_ids, updated_at FROM ai_model_assignments
    WHERE partner_id = ${partnerA} AND surface = 'ai_agents' AND role = 'triage'`;
  expect(row!.fallback_offering_ids).toEqual([offA]);
  const cleared = await partnerPut('/ai/models/assignments', { assignments: [{
    surface: 'ai_agents', role: 'triage', defaultOfferingId: null, permittedOfferingIds: null, allowUserChoice: true,
    options: null, expectedUpdatedAt: (row!.updated_at as Date).toISOString(),
  }] });
  expect(cleared.status).toBe(200);
  expect(await fixtureSql`SELECT 1 FROM ai_model_assignments WHERE partner_id = ${partnerA} AND role = 'triage'`).toHaveLength(0);
});

it('W09: another partner\'s offering in a fallback list is refused', async () => {
  const put = await partnerPut('/ai/models/assignments', { assignments: [{
    surface: 'chat', role: 'default', defaultOfferingId: offA, permittedOfferingIds: null, allowUserChoice: true,
    options: null, fallbackOfferingIds: [offB], expectedUpdatedAt: null,
  }] });
  expect(put.status).toBe(422);
});
```

`partnerPut`, `offA`, `offA2`, `offB` and `partnerA` are W04's fixtures for that suite (partner A's two offerings, partner B's offering). Use the suite's own names.

- [ ] **Step 5: Run tests**

Run: `cd apps/api && npx vitest run src/services/aiModels/assignmentWrites.test.ts src/services/aiModels/registryView.test.ts src/services/aiModels/usageQueries.test.ts src/routes/aiModels src/__tests__/partner-wide-write-coverage.test.ts`
Then: `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiModelsRoutes.integration.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

Stage the API files and tests. Commit message: `feat(ai-models): role rows, fallback lists and cross-funding in /ai/models; failovers in AI usage (#7607)`, ending with the Co-Authored-By trailer.

---

## Task 13: Settings UI — role sub-rows, the fallback list, the cross-funding switch, failovers column

**Files:**
- Create: `apps/web/src/components/settings/aiModels/FallbackListEditor.tsx`, `FallbackListEditor.test.tsx`
- Modify: `apps/web/src/components/settings/aiModels/FeatureDefaultsCard.tsx`, `FeatureDefaultsCard.test.tsx` (W04)
- Modify: `apps/web/src/components/settings/aiModels/OrgModelDefaultsCard.tsx`, `OrgModelDefaultsCard.test.tsx` (W04)
- Modify: `apps/web/src/components/settings/aiModels/AiUsageBreakdown.tsx`, `AiUsageBreakdown.test.tsx` (W04)
- Modify: `apps/web/src/components/settings/aiModels/surfaceLabels.ts` (`ROLE_LABEL_KEYS`, `REGISTRY_ERROR_KEYS.crosses_funding`)
- Modify: `apps/web/src/locales/*/settings.json` (every locale W04 Task 13 touched)

**Interfaces:**
- Consumes: Task 1 DTOs (`AiSurfaceDefaultsDto.role`, `AiAssignmentRowDto.fallback*`, `AiOrgSurfaceDefaultsDto.*.fallback*`, `AiUsageRowDto.failovers`), `MAX_FALLBACK_OFFERINGS`; Task 12 API; P22.
- Produces: `FallbackListEditor({ rowKey, value, options, referenceFunding, crossFunding, onChange, disabled? })`; `ROLE_LABEL_KEYS: Record<'triage' | 'analysis' | 'remediation', string>`.

Settings rules (CLAUDE.md "Settings — one concept, one home"). Both concepts live in the existing home, **AI Providers & Models → Defaults by feature** (partner, page Save), with the org override card **Org Settings → AI → Model defaults** (org, page Save, tighten-only, blank = inherit with the source shown). No new screen, no new URL. Concept count: failover list 0 → 1 (+ the org override); escalation role defaults 0 → 1 (+ the org override).

**data-testids** (W04's surface-row ids are unchanged; role sub-rows add `-${role}`):

| Element | Testid |
|---|---|
| role sub-row | `ai-defaults-row-ai_agents-${role}` (`triage` / `analysis` / `remediation`) |
| role default select (first option "Same as AI agents default") | `ai-defaults-default-ai_agents-${role}` |
| fallback list / item / add / up / down / remove | `ai-defaults-fallbacks-${key}`, `ai-defaults-fallback-${key}-${i}`, `ai-defaults-fallback-add-${key}`, `ai-defaults-fallback-up-${key}-${i}`, `ai-defaults-fallback-down-${key}-${i}`, `ai-defaults-fallback-remove-${key}-${i}` |
| crossing marker on an item | `ai-defaults-fallback-crosses-${key}-${i}` |
| cross-funding switch | `ai-defaults-cross-funding-${key}` |
| org equivalents | the same ids with the `org-model-defaults-` prefix; org cross-funding is a "Don't fail over between Breeze credits and your own key" checkbox `org-model-defaults-no-cross-funding-${key}` |
| usage column | `ai-usage-col-failovers` |

`${key}` is `${surface}` for a `default` row (W04's form) and `${surface}-${role}` for a role sub-row.

- [ ] **Step 1: Write the failing tests**

`FallbackListEditor.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FallbackListEditor } from './FallbackListEditor';

const off = (id: string, funding: 'platform' | 'partner_key', displayName = id) => ({ id, displayName, funding }) as never;
const OPTIONS = [off('p2', 'platform', 'Sonnet 5.5'), off('k', 'partner_key', 'Own key: Opus 5.5'), off('p3', 'platform', 'Haiku 4.5')];

describe('FallbackListEditor', () => {
  it('adds only same-funding models while crossing is off, and every model once it is on', () => {
    const { rerender } = render(<FallbackListEditor rowKey="chat" value={[]} options={OPTIONS} referenceFunding="platform" crossFunding={false} onChange={vi.fn()} />);
    const values = () => [...(screen.getByTestId('ai-defaults-fallback-add-chat') as HTMLSelectElement).options].map((o) => o.value);
    expect(values()).toEqual(['', 'p2', 'p3']);
    rerender(<FallbackListEditor rowKey="chat" value={[]} options={OPTIONS} referenceFunding="platform" crossFunding onChange={vi.fn()} />);
    expect(values()).toEqual(['', 'p2', 'k', 'p3']);
  });

  it('reorders, removes, and marks an entry paid from a different source', () => {
    const onChange = vi.fn();
    render(<FallbackListEditor rowKey="chat" value={['p2', 'k']} options={OPTIONS} referenceFunding="platform" crossFunding onChange={onChange} />);
    expect(screen.getByTestId('ai-defaults-fallback-crosses-chat-1')).toBeTruthy();
    expect(screen.queryByTestId('ai-defaults-fallback-crosses-chat-0')).toBeNull();
    fireEvent.click(screen.getByTestId('ai-defaults-fallback-up-chat-1'));
    expect(onChange).toHaveBeenLastCalledWith(['k', 'p2']);
    fireEvent.click(screen.getByTestId('ai-defaults-fallback-remove-chat-0'));
    expect(onChange).toHaveBeenLastCalledWith(['k']);
  });

  it('hides the add control at the cap', () => {
    render(<FallbackListEditor rowKey="chat" value={['a', 'b', 'c', 'd', 'e']} options={OPTIONS} referenceFunding="platform" crossFunding onChange={vi.fn()} />);
    expect(screen.queryByTestId('ai-defaults-fallback-add-chat')).toBeNull();
  });
});
```

In `FeatureDefaultsCard.test.tsx`, **delete** W04's `'renders no fallback controls (W09)'` case and add the cases below. Extend the file's `snapWithDefaults()` so `defaults` carries the three `ai_agents` role entries (`partner: null`) and every `partner` row carries `fallbackOfferingIds: null, fallbackMayCrossFunding: null`.

```tsx
it('renders the three ai_agents escalation sub-rows', () => {
  render(<FeatureDefaultsCard snapshot={snapWithDefaults()} onSaved={vi.fn()} />);
  for (const role of ['triage', 'analysis', 'remediation']) expect(screen.getByTestId(`ai-defaults-row-ai_agents-${role}`)).toBeTruthy();
});

it('a role sub-row starts on "Same as AI agents default" and is not dirty', () => {
  render(<FeatureDefaultsCard snapshot={snapWithDefaults()} onSaved={vi.fn()} />);
  expect((screen.getByTestId('ai-defaults-default-ai_agents-triage') as HTMLSelectElement).value).toBe('');
  expect(screen.queryByTestId('ai-defaults-dirty')).toBeNull();
});

it('choosing a triage model saves a triage row; the fallback list and crossing switch ride along', async () => {
  fetchWithAuth.mockResolvedValueOnce(jsonRes({ assignments: [] }));
  render(<FeatureDefaultsCard snapshot={snapWithDefaults()} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByTestId('ai-defaults-default-ai_agents-triage'), { target: { value: B } });
  fireEvent.change(screen.getByTestId('ai-defaults-fallback-add-ai_agents-triage'), { target: { value: A } });
  fireEvent.click(screen.getByTestId('ai-defaults-save'));
  await waitFor(() => expect(JSON.parse(fetchWithAuth.mock.calls[0][1].body).assignments).toEqual([expect.objectContaining({
    surface: 'ai_agents', role: 'triage', defaultOfferingId: B, fallbackOfferingIds: [A], fallbackMayCrossFunding: false, expectedUpdatedAt: null,
  })]));
});

it('switching cross-funding off drops the entries that cross', () => {
  render(<FeatureDefaultsCard snapshot={snapWithDefaults({ chatFallbacks: [B, K], chatCrossFunding: true })} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByTestId('ai-defaults-cross-funding-chat'));
  expect(screen.queryByTestId('ai-defaults-fallback-chat-1')).toBeNull();
  expect(screen.getByTestId('ai-defaults-fallback-chat-0').textContent).toContain('Model B');
});

it('a 422 crosses_funding highlights the role row named in details', async () => {
  fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'x', code: 'crosses_funding', details: { surface: 'ai_agents', role: 'triage', field: 'fallbackOfferingIds' } }, 422));
  render(<FeatureDefaultsCard snapshot={snapWithDefaults()} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByTestId('ai-defaults-default-ai_agents-triage'), { target: { value: B } });
  fireEvent.click(screen.getByTestId('ai-defaults-save'));
  await waitFor(() => expect(screen.getByTestId('ai-defaults-row-ai_agents-triage').getAttribute('aria-invalid')).toBe('true'));
});
```

`K` is a BYOK offering added to the fixture (`funding: 'partner_key'`). `snapWithDefaults` gains `chatFallbacks` / `chatCrossFunding` overrides for the chat partner row.

In `OrgModelDefaultsCard.test.tsx`:

```tsx
it('an org can narrow the inherited fallback list and switch cross-funding failover off', async () => {
  fetchWithAuth
    .mockResolvedValueOnce(jsonRes(orgDefaults({ chat: { inherited: { fallbackOfferingIds: [B, C], fallbackMayCrossFunding: true } } })))
    .mockResolvedValueOnce(jsonRes({ assignments: [] }))
    .mockResolvedValueOnce(jsonRes(orgDefaults()));
  render(<OrgModelDefaultsCard orgId={ORG} />);
  await screen.findByTestId('org-model-defaults-row-chat');
  fireEvent.click(screen.getByTestId('org-model-defaults-fallback-remove-chat-1'));
  fireEvent.click(screen.getByTestId('org-model-defaults-no-cross-funding-chat'));
  fireEvent.click(screen.getByTestId('org-model-defaults-save'));
  await waitFor(() => expect(JSON.parse(fetchWithAuth.mock.calls[1][1].body).assignments[0]).toMatchObject({
    surface: 'chat', role: 'default', fallbackOfferingIds: [B], fallbackMayCrossFunding: false,
  }));
});

it('shows the ai_agents role sub-rows with their inherited model and source', async () => {
  fetchWithAuth.mockResolvedValueOnce(jsonRes(orgDefaults()));
  render(<OrgModelDefaultsCard orgId={ORG} />);
  expect(await screen.findByTestId('org-model-defaults-row-ai_agents-triage')).toBeTruthy();
  expect(screen.getByTestId('org-model-defaults-inherited-ai_agents-triage').textContent).toMatch(/partner/i);
});
```

In `AiUsageBreakdown.test.tsx`: assert the `ai-usage-col-failovers` header exists, and that a row with `failovers: 2` renders `2`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/web && npx vitest run src/components/settings/aiModels`
Expected: FAIL (component missing; no role sub-rows; no failovers column).

- [ ] **Step 3: Implement**

`FallbackListEditor.tsx`:

```tsx
import { useTranslation } from 'react-i18next';
import { MAX_FALLBACK_OFFERINGS, type AiOfferingDto } from '@breeze/shared';

export interface FallbackListEditorProps {
  /** Test-id suffix: `${surface}` or `${surface}-${role}`. */
  rowKey: string;
  /** Test-id prefix: 'ai-defaults' (partner card) or 'org-model-defaults' (org card). */
  idPrefix?: string;
  value: string[];
  /** Eligible enabled offerings for this row (tool-filtered, permitted-filtered, never the row's own default). */
  options: Array<Pick<AiOfferingDto, 'id' | 'displayName' | 'funding'>>;
  /** The funding of the row's default; null when the row inherits a default it cannot see. */
  referenceFunding: 'platform' | 'partner_key' | null;
  crossFunding: boolean;
  onChange: (next: string[]) => void;
  disabled?: boolean;
}

export function FallbackListEditor(props: FallbackListEditorProps) {
  const { t } = useTranslation('settings');
  const prefix = props.idPrefix ?? 'ai-defaults';
  const byId = new Map(props.options.filter((o) => o.id).map((o) => [o.id as string, o]));
  const crosses = (funding: string | undefined) =>
    funding !== undefined && props.referenceFunding !== null && funding !== props.referenceFunding;
  const addable = props.options.filter((o) => o.id && !props.value.includes(o.id) && (props.crossFunding || !crosses(o.funding)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= props.value.length) return;
    const next = [...props.value];
    [next[i], next[j]] = [next[j]!, next[i]!];
    props.onChange(next);
  };

  return (
    <div data-testid={`${prefix}-fallbacks-${props.rowKey}`} className="space-y-1">
      <ol className="space-y-1">
        {props.value.map((id, i) => {
          const o = byId.get(id);
          return (
            <li key={id} data-testid={`${prefix}-fallback-${props.rowKey}-${i}`} className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">{i + 1}.</span>
              <span>{o?.displayName ?? t('aiModels.defaults.fallbackUnavailable')}</span>
              {crosses(o?.funding) && (
                <span data-testid={`${prefix}-fallback-crosses-${props.rowKey}-${i}`} className="rounded bg-amber-100 px-1.5 text-xs text-amber-900 dark:bg-amber-900/40 dark:text-amber-100">
                  {t(o!.funding === 'platform' ? 'aiModels.defaults.fundingPlatform' : 'aiModels.defaults.fundingOwnKey')}
                </span>
              )}
              <button type="button" className="ml-auto" aria-label={t('aiModels.defaults.moveUp')} disabled={props.disabled || i === 0}
                onClick={() => move(i, -1)} data-testid={`${prefix}-fallback-up-${props.rowKey}-${i}`}>↑</button>
              <button type="button" aria-label={t('aiModels.defaults.moveDown')} disabled={props.disabled || i === props.value.length - 1}
                onClick={() => move(i, 1)} data-testid={`${prefix}-fallback-down-${props.rowKey}-${i}`}>↓</button>
              <button type="button" aria-label={t('aiModels.defaults.removeFallback')} disabled={props.disabled}
                onClick={() => props.onChange(props.value.filter((x) => x !== id))}
                data-testid={`${prefix}-fallback-remove-${props.rowKey}-${i}`}>×</button>
            </li>
          );
        })}
      </ol>
      {props.value.length < MAX_FALLBACK_OFFERINGS && (
        <select
          value=""
          aria-label={t('aiModels.defaults.addFallback')}
          disabled={props.disabled || addable.length === 0}
          onChange={(e) => { if (e.target.value) props.onChange([...props.value, e.target.value]); }}
          data-testid={`${prefix}-fallback-add-${props.rowKey}`}
          className="rounded border px-2 py-1 text-sm"
        >
          <option value="">{t('aiModels.defaults.addFallback')}</option>
          {addable.map((o) => <option key={o.id!} value={o.id!}>{o.displayName}</option>)}
        </select>
      )}
    </div>
  );
}
```

`FeatureDefaultsCard.tsx` (at W04's `// W09 (#7607): …` comment; replace the comment):
- Drafts are keyed `${surface}/${role}` for every entry of `snapshot.defaults` (Task 12 makes it per role). `RowDraft` gains `fallbacks: string[]` (init `partner?.fallbackOfferingIds ?? []`) and `crossFunding: boolean` (init `partner?.fallbackMayCrossFunding ?? false`).
- Render each surface's `default` row as W04 does, plus `<FallbackListEditor rowKey={surface} … />` and the cross-funding checkbox `ai-defaults-cross-funding-${surface}`, labelled `aiModels.defaults.crossFunding`, with the help text `aiModels.defaults.crossFundingHelp`.
- For `surface === 'ai_agents'`, render one sub-row per role under the default row (`ai-defaults-row-ai_agents-${role}`):
  - the default select's first option is `''` = `t('aiModels.defaults.roleInherit')` ("Same as AI agents default");
  - the permitted / options / fallback controls render only when the sub-row's default is set.
- `options` for the editor: enabled offerings that pass the row's tool filter and permitted set, excluding the row default.
- `referenceFunding`: the row default's `funding` (for a role sub-row on `''`, the `ai_agents` default row's).
- Unchecking cross-funding drops crossing entries: `setDraft({ ...d, crossFunding: false, fallbacks: d.fallbacks.filter((id) => fundingOf(id) === referenceFunding) })`.
- Dirtiness compares `fallbacks` (order-sensitive) and `crossFunding` too.
- A role sub-row that is `''` and has no partner row is never dirty. One that is `''` and **has** a partner row is dirty and saves as a clear.
- `toInput(draft, snapshotRow)`:

```ts
{
  surface, role,
  defaultOfferingId: draft.defaultOfferingId || null,                 // '' on a role sub-row = clear (inherit)
  permittedOfferingIds: draft.defaultOfferingId ? (draft.mode === 'all' ? null : draft.permitted) : null,
  allowUserChoice: draft.allowUserChoice,
  options: draft.defaultOfferingId ? compact({ effort: draft.effort || undefined, thinkingDisplay: draft.display || undefined, speed: draft.speed || undefined }) : null,
  fallbackOfferingIds: draft.defaultOfferingId ? draft.fallbacks : null,
  fallbackMayCrossFunding: draft.crossFunding,
  expectedUpdatedAt: snapshotRow.partner?.updatedAt ?? null,
}
```

- W04's save guard `rows.some((r) => !r.defaultOfferingId)` becomes `rows.some((r) => r.role === 'default' && !r.defaultOfferingId)`.
- The 422 highlight reads `details.surface` **and** `details.role` (default `'default'`), and marks `ai-defaults-row-${surface}` or `ai-defaults-row-${surface}-${role}`.

`OrgModelDefaultsCard.tsx`:
- One row per `view.surfaces` entry (Task 12 makes it per role); `ai_agents` role entries render as sub-rows `org-model-defaults-row-ai_agents-${role}`, with `org-model-defaults-inherited-ai_agents-${role}` showing the inherited model and its source.
- Fallbacks are an "Inherit — N backup models (partner)" / "Only these" mode select (`org-model-defaults-fallback-mode-${key}`). "Only these" shows a `FallbackListEditor` (`idPrefix="org-model-defaults"`), initialised from `inherited.fallbackOfferingIds`, whose options are restricted to `inherited.permittedOfferingIds` (or every offering when null).
- `org-model-defaults-no-cross-funding-${key}` maps to `fallbackMayCrossFunding: false | null`. It is disabled with "Not allowed by the partner" when `inherited.fallbackMayCrossFunding` is false.
- The PUT body adds `fallbackOfferingIds` (`null` in Inherit mode; the list in "Only these" mode, where an emptied list is sent as `[]` and labelled "No backup models", Codex review 8) and `fallbackMayCrossFunding`.
- A row reset to all-inherit sends both as `null` (W04's all-null delete).

`AiUsageBreakdown.tsx`: add a "Failovers" column after "Fallbacks" (`ai-usage-col-failovers`, label key `aiModels.usage.failovers`, help tooltip `aiModels.usage.failoversHelp`: "Calls served by a backup model because the configured one failed or was unavailable").

`surfaceLabels.ts`:

```ts
export const ROLE_LABEL_KEYS = {
  triage: 'aiModels.roles.triage',
  analysis: 'aiModels.roles.analysis',
  remediation: 'aiModels.roles.remediation',
} as const;
```

Add `crosses_funding: 'aiModels.errors.crossesFunding'` to `REGISTRY_ERROR_KEYS`.

Locale keys. Add each to **every** `apps/web/src/locales/<lang>/settings.json` that W04 Task 13 updated, translated. Use the English below where the repo's locale test accepts an English fallback; check the W04 PR's locale diff for the convention.

| Key | English |
|---|---|
| `aiModels.roles.triage` | Triage (first look) |
| `aiModels.roles.analysis` | Analysis (investigate and plan) |
| `aiModels.roles.remediation` | Remediation (act on devices) |
| `aiModels.defaults.roleInherit` | Same as AI agents default |
| `aiModels.defaults.fallbacks` | Backup models, in order |
| `aiModels.defaults.addFallback` | Add a backup model… |
| `aiModels.defaults.moveUp` / `moveDown` / `removeFallback` | Move up / Move down / Remove |
| `aiModels.defaults.fallbackUnavailable` | A model that is no longer available |
| `aiModels.defaults.crossFunding` | Allow failover between Breeze credits and your own API key |
| `aiModels.defaults.crossFundingHelp` | When on, a backup paid from the other source may serve a request. It is billed to whichever source actually served it. |
| `aiModels.defaults.fundingPlatform` / `fundingOwnKey` | Breeze credits / Your API key |
| `aiModels.org.noCrossFunding` | Don't fail over between Breeze credits and the partner's own key |
| `aiModels.org.crossFundingLocked` | Not allowed by the partner |
| `aiModels.org.fallbackInherit` | Inherit — {{count}} backup models (partner) |
| `aiModels.usage.failovers` / `failoversHelp` | Failovers / Calls served by a backup model because the configured one failed or was unavailable |
| `aiModels.errors.crossesFunding` | That backup model is paid from a different source. Allow failover between Breeze credits and your own API key first. |

- [ ] **Step 4: Run tests and typecheck**

Run: `cd apps/web && npx vitest run src/components/settings/aiModels src/lib/__tests__/no-silent-mutations.test.ts src/lib/__tests__/settingsPageRegistry.test.ts && npx tsc --noEmit`
Expected: PASS. No new mutation handler and no new settings page; both cards already save through `runAction` (W04).

- [ ] **Step 5: Commit**

Stage the web component, test and locale files. Commit message: `feat(web): escalation role sub-rows, ordered failover list and cross-funding switch in AI model defaults (#7607)`, ending with the Co-Authored-By trailer.

---

## Task 14: Docs, whole-wave verification, review and the PR

**Files:**
- Modify: `apps/docs/src/content/docs/features/ai.mdx` (new section)
- Modify: `docs/superpowers/plans/ai-mcp/2026-09-30-ai-model-registry-index.md` (W09 row → implemented)

- [ ] **Step 1: Docs**

Add a section `## Failover and escalation roles` to `apps/docs/src/content/docs/features/ai.mdx`. It goes after the "Model refusals" section W03 added, and covers:
- **Backup models.** Each feature's default has an ordered list of up to five backup models (Settings → AI Providers & Models → Defaults by feature). When the model is disabled or retired, rate-limited, overloaded, erroring, or its API key or quota fails, Breeze uses the next eligible backup.
  - Backups follow the same permissions, plan, residency and tool rules as the default.
  - A backup that was just tried, or that is cooling down after a failure, is skipped.
- **Billing.** Each attempt is billed to the source that served it: Breeze AI credits for a Breeze-provided model, your provider account for your own API key. A failed attempt that the provider rejected costs nothing. Failover moves between Breeze credits and your own key only when "Allow failover between Breeze credits and your own API key" is on.
- **Chat.** A chat message is never re-sent on another model mid-reply. After a failure, the next message uses a backup. A conversation that already has history stays on the same provider connection.
- **Escalation roles for AI agents.** Triage (alert verdicts, ticket triage, shadow sweeps), Analysis (investigations and plans) and Remediation (act-mode runs that change devices) can each have their own default and backups; unset roles use the AI agents default. An agent pinned to a specific model keeps that model.
- **Organization overrides** can narrow the backup list and turn cross-funding failover off. They cannot widen either.
- **Usage.** The AI usage page's "Failovers" column counts calls served by a backup.

No infrastructure detail, hostnames or IPs.

- [ ] **Step 2: Full verification**

Run each command in the foreground, in small batches. Record pass/fail counts for the PR body.

```
cd packages/shared && npx vitest run && npx tsc --noEmit
cd apps/api && npx tsc --noEmit -p tsconfig.json
cd apps/api && npx vitest run src/services/aiModels
cd apps/api && npx vitest run src/services/aiAgents/agentModelRole.test.ts src/services/aiAgents/agentRunFailover.test.ts src/services/aiAgents/runLoop.test.ts src/services/aiAgents/runService.test.ts
cd apps/api && npx vitest run src/services/scriptProposals src/routes/officeAddin src/routes/aiModels src/services/streamingSessionManager.modelBinding.test.ts src/services/streamingSessionManager.usage.test.ts
cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/__tests__/partner-wide-write-coverage.test.ts
cd apps/api && npx vitest run src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts src/services/orgMerge.test.ts
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiModelFailover.integration.test.ts src/__tests__/integration/aiModelFailoverFunding.integration.test.ts
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiInvocationSettlement.integration.test.ts src/__tests__/integration/resolveModel.integration.test.ts src/__tests__/integration/aiModelsRoutes.integration.test.ts
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
cd apps/web && npx vitest run src/components/settings/aiModels src/lib/__tests__ && npx tsc --noEmit
DATABASE_URL=… pnpm db:check-drift
bash scripts/check-migration-naming.sh --against-ref origin/main
pnpm test-stack down
```

Expected: every command exits 0. Then run the full API unit suite once (`cd apps/api && npx vitest run`), because `orgMerge.test.ts` and similar suites only fail in a full run (CLAUDE.md).

- [ ] **Step 3: Review**

Run `/pr-review-toolkit:review-pr`. Rigor is high (billing/funding), so ask the reviewers to focus on F1–F6, D5/D6 and Review Focus 1–7. At most one round; act only on confirmed, consequential findings.

- [ ] **Step 4: Index + PR**

- In the index's Waves table, set W09's "Plan status" to `implemented (PR #<n>)`.
- Push `feature/7598-ai-model-registry/wave-7607` and open the PR to `main`, titled `feat(ai): model registry W09 — failover walk + agent escalation roles (#7607)`. The body contains:
  - `Closes #7607`;
  - the Preconditions differences (if any);
  - the verification counts;
  - the Settings PR statement below;
  - the lab gates L1–L4 as unchecked boxes.
- Run `complete_wave` only after merge.

**Settings PR statement** (CLAUDE.md rule 9):

| Concept | Home | Level | Resolver | Places configured before → after |
|---|---|---|---|---|
| Failover list (ordered backups) + cross-funding permission | AI Providers & Models → Defaults by feature (page Save); org override: Org Settings → AI → Model defaults (tighten-only) | partner (+ org narrowing) | `resolveModel` walk (`services/aiModels/resolveModel.ts`) | 0 → 1 (+ the existing override card) |
| AI agent escalation role defaults (triage / analysis / remediation) | Same card, `ai_agents` sub-rows; org override in the same org card | partner (+ org override) | `resolveModel` with `role` (`agentRunModelRole`) | 0 → 1 (+ the existing override card) |

---

## Lab / Todd gates (CI cannot prove these)

| # | Gate | How | Owner |
|---|---|---|---|
| L1 | **Real Agent SDK failure shapes.** The classifier's inputs (`SDKAPIRetryMessage.error` / `error_status`, a synthetic API-error assistant message, `result.api_error_status`) and the retry-then-abort timing, against the real CLI, on forced 429 / 529 / 401 / "credit balance too low". Confirm three things: aborting after `SDK_RETRIES_BEFORE_FAILOVER` retries leaves no billed request unaccounted; a fast-mode 429 (which the CLI retries as standard on its own, W05 spike Q4) is **not** classified as a failover; a hop-0 abort followed by a hop-1 `query()` with another key never reuses the first child. | The W05 spike harness (`apps/api/src/services/aiModels/__scripts__/sdkResumeAcrossModelsSpike.ts`): logging proxy with a status-injection mode. One run per status. | Implementer, before the PR leaves draft |
| L2 | **Cross-funding failover on a hosted staging stack with the real billing service.** Platform → BYOK and BYOK → platform for an agent run and for the script reviewer. The billing service's ledger must show exactly one deduct per served platform hop, keyed `ai-settlement:<that hop's reservation>`, and none for the BYOK or zero-cost hops. | Staging partner with real platform credits and a real BYOK key, plus a fallback list; force the primary to fail through an invalid model id on a manual offering (a 404 is not failover-eligible), or by revoking the BYOK key (401) | Todd (real credentials) |
| L3 | **Cooldown recovery.** A revoked BYOK key cools its offerings for 15 min. Rotating the key under AI Providers & Models clears them, and the next call routes back to the BYOK offering. | Staging, same setup as L2 | Implementer |
| L4 | **Production preflight for the migration.** On each region, before the release that carries `2026-11-25-100000`: `SELECT count(*) FROM ai_model_assignments WHERE fallback_offering_ids IS NOT NULL AND (cardinality(fallback_offering_ids) > 5 OR default_offering_id = ANY(fallback_offering_ids));` must be 0 (run it with `SET breeze.scope = 'system'` in the session). Otherwise the `VALIDATE CONSTRAINT` aborts the deploy. | `psql "$DATABASE_URL"` on the droplet | Todd |

W09 must ship in a release **with or after** W03 + W04 (it modifies both). It needs no agent release.

## Open questions for Todd

Each has a recommendation, and the plan implements the recommendation unless told otherwise.

1. **Profile → role mapping (D4).**
   - Triage = alert verdicts, ticket triage, shadow sweeps.
   - Analysis = shadow full runs, analysis, narrative, design, patch planning.
   - Remediation = act-mode full and act-mode sweep runs.

   **Recommend as written.** Remediation is exactly the set of runs that can change devices, which is where a stronger model pays for itself; ticket triage stays cheap even in act mode, because it only writes ticket fields.
2. **Chat in-turn replay (D5).** Should a chat turn that fails before any output be re-sent on the backup within the same turn, instead of on the next message?
   - **A — next message (this plan):** pro: no duplicated user message in the SDK transcript, and no W05 dependency; con: the user sees one error.
   - **B — in-turn replay:** pro: invisible to the user; con: needs W05's continuation for cross-connection backups, and a spike on what the CLI persisted for the failed turn.

   **Recommend A now, B as a W05 follow-up.**
3. **An org's `default` override vs. a partner's role rows (D2).** With D2, an org that overrides the AI agents default still gets the partner's triage / analysis / remediation models, narrowed by its permitted set. Without D2, the org override silently collapses all three stages onto one model. **Recommend D2.**
4. **Stickiness (D6).** A transient failover (429 / 529 / 5xx / key / quota / cooldown) does not change a chat's stored model; a model that was disabled or retired does. **Recommend as written** (it matches the Agent SDK's own fallback semantics).
5. **Per-agent role pins.** Should an individual agent policy be able to name a different model per role? **Recommend no for W09** (a pinned agent keeps its one model, D3). File a follow-up if partners ask.
6. **Cooldown TTLs (D9):** 60 s for rate-limit / overload / 5xx, 15 min for key / quota (cleared on key rotation). **Recommend as written**; revisit with W11's quality view.
7. **Sandbox compute on a cross-funding failover (D7).** Compute stays on the admitted funding, and only model tokens move. **Recommend as written.**

---

## Review

**Codex review** (`gpt-6-astra`, `model_reasoning_effort="high"`, read-only, 2026-10-01). Inputs: the plan, the spec, the index, the W04 plan, and the **real W03 code** (`origin/feature/7598-ai-model-registry/wave-7601` at `8ddee4e3af`, extracted read-only) plus the Agent SDK 0.3.286 types.

Codex's overall verdict: the W03 interfaces the plan consumes exist, and the W04 dependencies are declared as preconditions. The RLS, cascade/merge registrations and the export classifications are appropriate. Per-hop bindings and W03's `assertInvocationsMatchBinding` / `creditsDebitDue` path prevent mismatched funding and duplicate debits, provided settlement gets complete usage and a compatible reservation. It reported nine findings. Each was checked against the W03 code before adoption.

| # | Sev | Finding | Verified | Decision |
|---|---|---|---|---|
| 1 | high | Agent failover discarded reported usage: a `result` carrying an error status *and* tokens was short-circuited before W03 billed it. | Yes: the SDK types allow `api_error_status` on a result with usage. | **Adopted.** A `result` is never short-circuited; W03 bills it, and the post-hop check decides. Task 11 test "an error RESULT with usage is billed on its hop before failing over". |
| 2 | high | Ticket-draft reservations could not settle: they were session-bound, but settled with `sessionId: null`. | Yes: `aiBudgetReservations.ts` ~L1002 throws "Session-bound AI budget reservation requires session settlement"; the W03 ticket-draft route already has this mismatch on hop 0. | **Adopted.** Hop 0 and every hop reservation are sessionless (Task 8 Step 4.1, with test). Flag to W03: if its final head fixes this another way, keep W03's fix and match it. |
| 3 | high | A billable refusal could be settled as zero: on a catalog connection, `createMessage` loses the answered first attempt when its client-side refusal fallback throws. | Yes: `connectionFactory.ts` ~L202–210. | **Adopted.** `MessageDispatchError` + `attemptsOf` in `connectionFactory.ts`; drafts keep `attemptsOf(err)`; the reviewer settles `attemptsOf(error)`; `isPreOutputMessagesFailure` refuses to fail over (Task 7, with tests). |
| 4 | high | Cross-funding bypass: if the default switched funding mid-dispatch, re-resolution treated the new default as a fresh primary and skipped F1. | Yes: `resolveModel` re-reads the assignment on every call. | **Adopted.** `ResolveModelInput.failoverOrigin`: every re-resolution judges F1/D5 against the dispatch's first hop, and a primary the origin does not allow is passed over (Task 5 unit + Task 7 integration "a default switched to another funding mid-dispatch…"). |
| 5 | medium | Re-drive crash window: hop n−1 was settled before hop n was recorded, so a crash left the run pointing at a settled reservation (and `existingResult` rejects reusing it). The resume also lost the failover provenance. | Yes: `existingResult` ~L456–466. | **Adopted.** Order is now record hop n → settle hop n−1. `markStaleHopReservations` marks an orphaned active hop indeterminate on re-drive. A new `served_failover_cause` column restores provenance on resume (Task 2, Task 11, with unit and real-DB tests). |
| 6 | medium | Backup drafts were sized from hop 0's reserved allowance. | Yes: `aiEmailDraft.ts` sizes `max_tokens` from `budgetCents`. | **Adopted.** `FailoverHop.reservedCostCents`; each attempt uses its own hop's allowance (Task 8 test). |
| 7 | medium | A hop could be dispatched after the wall-clock deadline: the timer firing during a transition was lost when the controller was replaced. | Yes. | **Adopted.** The deadline is re-checked before every new hop (Task 11 test). |
| 8 | medium | An org's emptied fallback list became `NULL`, which re-inherits the partner list. | Yes: `mergeEffectiveAssignment` honours an org `[]` as "no backups". | **Adopted.** `fallbackValues(row, owner)` keeps `[]` on org rows, and the org card sends `[]` as "No backup models" (Task 12 test). |
| 9 | medium | Spec §9.1 says a configured list *replaces* the single-candidate rule; the draft kept W03's same-route default ahead of the list. | Yes: spec §9.1. | **Adopted.** W03's default attempt applies only when no list is configured (Task 5 tests for both cases). |

Nothing was rejected.

**Pre-existing gaps recorded, not fixed here:**
- W02/W03 dispatch a partner default that lies outside an org's narrowed permitted set (Task 4 note).
- The W03 ticket-draft session/settlement mismatch (finding 2) predates W09; Task 8 fixes it on the route W09 touches.

---

## Index additions

These names are introduced here and absent from the index and from W01–W04's Index additions. None renames an existing name.

| Where | Name(s) | Why |
|---|---|---|
| `packages/shared/src/constants/aiSurfaces.ts` | `AI_AGENT_ESCALATION_ROLES`, `AiAgentEscalationRole`, `MAX_FALLBACK_OFFERINGS` | #7570 stages; the fallback cap |
| `packages/shared/src/validators/aiModelRegistryApi.ts` | `CONFIGURABLE_AI_SURFACE_ROLES`; `PartnerAssignmentInput.{fallbackOfferingIds, fallbackMayCrossFunding}` (+ nullable `defaultOfferingId` on role rows); `OrgAssignmentInput.{fallbackOfferingIds, fallbackMayCrossFunding}` | Assignment writes carry roles and fallbacks |
| `packages/shared/src/types/aiModelRegistry.ts` | `AiAssignmentRowDto.{fallbackOfferingIds, fallbackMayCrossFunding}`, `AiSurfaceDefaultsDto.role`, `AiOrgSurfaceDefaultsDto.{role, inherited.fallback*, effective.fallback*}`, `AiUsageRowDto.failovers` | DTOs |
| `services/aiModels/failover.ts` | `FAILOVER_CAUSES`, `FailoverCause`, `ProviderFailureCause`, `TRANSIENT_FAILOVER_CAUSES`, `MAX_FAILOVER_HOP`, `SDK_RETRIES_BEFORE_FAILOVER`, `COOLDOWN_TTL_MS`, `classifyProviderStatus`, `classifyProviderError`, `classifySdkAssistantError`, `shouldFailOverNow`, `hopIdempotencyKey` | What fails over; per-hop keys |
| `services/aiModels/offeringHealth.ts` | `markOfferingCooldown`, `coolingOfferings`, `clearOfferingCooldowns`, `clearConnectionCooldowns`, `noteProviderFailure`, `noteProviderFailureForBinding`; Redis key `ai-model:cooldown:<offeringId>` | Cooldown |
| `services/aiModels/failoverDispatch.ts` | `runWithFailover`, `FailoverHop` (incl. `reservedCostCents`), `HopReservation`, `FailoverHopReserver`, `FailoverExhaustedError`, `failoverOriginOf`, `reserveFailoverHop`, `settleZeroUsageHop`, `isPreOutputMessagesFailure` | Dispatch failover for Messages API surfaces |
| `services/aiModels/resolveModel.ts` | `ResolveModelInput.{excludeOfferingIds, failoverCause, sameConnectionOnly, failoverOrigin}`, `ResolvedModel.{failover, failoverRemaining}`, `ResolvedFailover`, `FailoverOrigin` | The walk (spec §9.1); judging re-resolutions against the dispatch origin |
| `services/aiModels/connectionFactory.ts` (W03) | `MessageDispatchError`, `attemptsOf` | A burned attempt survives a later throw in one dispatch |
| `services/aiModels/assignments.ts` | `selectRoleRows` | D2 role precedence, shared by the resolver and the settings view |
| `services/aiModels/turnBinding.ts` | `TurnBinding.failover` (optional; `v` stays 1) | Ledger provenance; D6 stamping |
| `services/aiModels/invocationUsage.ts` | `SdkTurnObservation.{providerFailure, sawOutput}` | SDK failure observation |
| `services/aiModels/sessionModel.ts`, `candidateLoader.ts` | `resolveSessionTurn({ excludeOfferingIds, failoverCause, failoverOrigin })` → `sameConnectionOnly`; `readSessionModelRow().turnCount` | D5 |
| `services/aiModels/assignmentWrites.ts` (W04) | `conditionalDeletePartnerRoleRow`; `RegistryWriteCode` `crosses_funding` | Role-row clear; cross-funding write gate |
| `services/aiAgents/agentModelRole.ts` | `AGENT_PROFILE_ROLE`, `ACT_MODE_REMEDIATION_PROFILES`, `agentRunModelRole` | Escalation |
| `services/aiAgents/agentRunFailover.ts` | `recordServedHop`, `markStaleHopReservations`, `nextAgentHop`, `NextAgentHop`, `startHopFor` | Agent-run hops; crash-window recovery |
| DB | `ai_invocations.failover_from_offering_id`, `.failover_hop`, `.failover_cause` (+ `ai_invocations_failover_chk`); `ai_agent_runs.served_offering_id`, `.served_funding_source`, `.served_failover_hop`, `.served_failover_cause` (+ `ai_agent_runs_served_chk`); `ai_model_assignments_fallback_shape_chk`; `ai_invocations_provenance_guard` covers `failover_from_offering_id` | Migration `2026-11-25-100000-ai-model-registry-failover.sql` |
| Web `components/settings/aiModels/` | `FallbackListEditor`, `ROLE_LABEL_KEYS` | UI |
| tests | `__tests__/integration/helpers/aiModelFailoverSeed.ts` (`seedFailoverPartner`, `setPartnerFallbacks`, `setPartnerDefault`, `SeededFailoverPartner`); `aiModelFailover.integration.test.ts`, `aiModelFailoverFunding.integration.test.ts` | Real-DB pins |

---

## Self-review

**Spec coverage (W09 scope):**

| Requirement | Task |
|---|---|
| §9.1: a configured `fallback_offering_ids` list replaces the single-candidate rule with an ordered walk under the same eligibility checks | 5 (walk), 2 (shape CHECK), 12 (writes), 13 (UI) |
| §5.4 / §9.1: crosses funding only when `fallback_may_cross_funding` | 5 (F1), 4 (org can only turn off), 12 (write gate), 7 (integration) |
| Brief: "inside resolveModel and the transports" | 5 (resolveModel), 7–8 (Messages API transport), 9 (Agent SDK observation, chat cooldown), 11 (agent runs) |
| Funding: permitted explicitly; eligibility re-checked; rate snapshot re-bound; settled against the serving offering | 5 + 12 (explicit), 5 + 7 (re-check, F2), 6 + 7 (re-bind, F3), 6 + 7 + 11 (served settlement, F5; DB guard pinned) |
| Double-debit and no-debit integration cases | 7 (platform→platform, re-settle, BYOK→platform, wrong-reservation settle, ledger forgery), 11 (re-drive hop key) |
| Agent escalation roles triage → analysis → remediation (#7570); `role` values beyond `default` | 1, 4, 10, 12, 13 |
| §11: W04 Defaults-by-feature extension (roles + fallbacks) and the org override | 12, 13 |
| §5.5 ledger records what served | 2, 6 |
| Migration slot `2026-11-25-100000`; registrations for new columns | 2 |

**Known limits, called out rather than hidden:**
- Chat turns never replay on another model (D5). The next message fails over through the cooldown.
- A session with history fails over only within its connection until W05's continuation exists.
- `catalog_enrichment` (a multi-turn loop) gets the walk and the cooldown, not in-call failover.
- A stored session choice whose offering row was **deleted** walks only with crossing on. Its source is not recorded, because the ledger guard rejects ids that do not exist.
- Pre-existing (W02/W03) gap: a partner default outside an org's narrowed permitted set is still dispatched; the walk checks permitted for fallbacks only. Not changed here.
- A timeout is never a failover cause (D8): it stays on W03's indeterminate path.

**Placeholders.** Every step names the file and the function it changes. Where a step edits code W03/W04 wrote, it names the W03/W04 identifier (P-rows) and gives the replacement code. Test helpers that W03/W04 test files already define (`runOneTurn`, `scriptQueries`, `partnerPut`, …) are named as "the file's own helper" with the behaviour required; the executor reuses them rather than inventing parallel ones.

**Type consistency.** The following names are spelled identically everywhere:
- `ResolvedModel.failover` / `.failoverRemaining`;
- `TurnBinding.failover`;
- `FailoverHop.{index, resolved, binding, reservationId, idempotencyKey}`;
- `hopIdempotencyKey(base, n)`;
- `runWithFailover({ first, reResolve, reserveHop, attempt, settleFailedHop, isPreOutput })`, where `reResolve` receives `{ excludeOfferingIds, cause, origin }`;
- `FailoverOrigin { offeringId, funding, connectionId }`;
- `nextAgentHop({ runId, orgId, partnerId, role, requestedOfferingId, tried, cause, hop, origin })`;
- `recordServedHop(runId, { offeringId, funding, hop, cause })`;
- `agentRunModelRole({ profile, modeAtStart })`;
- `selectRoleRows(rows, role)`.

**Review Focus.** Each of the seven lines names its pinning test and owning task.
