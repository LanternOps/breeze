---
spec: docs/superpowers/specs/ai-mcp/2026-10-19-wisp-orchestrator-design.md
orchestrator: docs/superpowers/plans/ai-mcp/2026-10-19-wisp-w00-wave-map-and-contracts.md
wave: W05
depends_on: [W02, W03, W04]
tracking_issue: LanternOps/breeze#9906
---

# Wisp W05 — Triage Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Wisp its continuous-triage loop: typed wake-ups (events, floor tick, watches) fan out one bounded `assessment` run per org under a grant, assessments write shared `wisp_concerns` with per-grant recipient state, a deterministic rollup feeds the thread summary, and a per-grant UTC-day budget turns the model off (never the bookkeeping) when exhausted.

**Architecture:** A BullMQ wake coordinator (`jobs/wispWakeScheduler.ts`) holds no SDK process: it coalesces wake requests per (grant, org) into one delayed job, round-robins floor ticks across a partner's orgs, and admits runs only through `createAndEnqueueAgentRun({ grant, profile: 'assessment' })` (W02's admission does the ceiling check). Three new org-axis tables (`wisp_concerns`, `wisp_concern_recipients`, `wisp_watches`) carry the facts; `services/wisp/{concerns,watches,assessment,budget,pollers,wake}.ts` are the only writers. Four new outcome tools (`record_concern`, `update_concern`, `nudge`, `propose_action`) plus a stubbed `request_specialist` are the assessment's only effect channel; a post-run finalizer applies them. (`record_concern` is the run-side name of what w00 calls `raise_concern`: w00 A25 registers `raise_concern` as a **chat** tool in `TOOL_TIERS`, and `createBreezeMcpServer` throws `extra tool collides with registry` for any outcome tool whose name is in `TOOL_TIERS` — `aiAgentSdkTools.ts:4354` — so the two cannot share a name. See Task 11b and the reconciliation note.)

**Tech Stack:** Hono + Drizzle (queries) + hand-written SQL migration, BullMQ/Redis, Vitest (unit + integration), React island + `runAction` on the web.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-10-19-wisp-orchestrator-design.md` §3, §7.1–7.4, §9, §13, §14, §15 "other blockers". Orchestrator contracts: `docs/superpowers/plans/ai-mcp/2026-10-19-wisp-w00-wave-map-and-contracts.md` ("Triage engine (W05)" block defines this wave; the W02/W03/W04 blocks are consumed as written).

## Execution split and parallelism (orchestrator, 2026-10-23)

W05 is split into two sub-issues with a **schema/service seam**:
- **W05a — Concerns, watches, budget, routes, chat tools** (sub-issue #9911, branch `feature/9906-wisp/wave-9911`): Tasks 1 (+ Task 1 edits), 3 (+ edits), 4, 5 (+ edits), 11, 11b, 12, 16, 17. Owns the migration, Drizzle schema, tenancy registrations, `services/wisp/concerns.ts`, `watches.ts`, `budget.ts`, `routes/wispConcerns.ts`, `routes/wispWatches.ts`, the chat tools file, the web concern list.
- **W05b — Assessment engine** (sub-issue #9917, branch `feature/9906-wisp/wave-9917`): Tasks 2, 6, 7 (+ edits), 8, 9 (+ edits), 10, 13, 14, 15. Owns the `assessment` profile, outcome tools, `assessment.ts`, event bus additions, `jobs/wispWakeScheduler.ts`, the reaper, clustering/correlator, `readiness.ts`, and the end-to-end integration (Task 13, last).
- **Seam:** W05b starts as soon as W05a has pushed Tasks 1, 3, 4, 5 (the orchestrator lists the SHAs in the W05b brief; W05b cherry-picks them first, keeps them byte-identical, and rebases when W05a merges). From then on the two run in parallel.

PARALLEL GROUPS (W05a): G1 = Task 1. G2 = Task 3 ∥ Task 4 ∥ Task 5. G3 = Task 11 ∥ Task 11b ∥ Task 16 ∥ Task 12. Task 17 last.
PARALLEL GROUPS (W05b): G1 = Task 2 ∥ Task 8 (profile vs event bus). G2 = Task 6 ∥ Task 7 ∥ Task 15 (outcome tools, assessment.ts, readiness.ts). G3 = Task 9 ∥ Task 10 ∥ Task 14 (wake, reaper, clustering). Task 13 last.
**Sonnet:** Task 12 (web concern list + locales), Task 2's validator boilerplate, Task 8 emitter plumbing, Task 15 `renderReadinessSummary` copy.
**Rules for every sub-issue and parallel group**
- Every part bases on `origin/main` and targets `main` (never a stacked PR). The w00 contracts are the oracle, so parts can be built against each other's interfaces before they merge; web/mobile tests mock the API.
- **Shared-package ownership:** the API part owns `packages/shared` additions. A web/mobile part that needs a type not yet on main copies the file **verbatim** from the API part's branch (`git show origin/feature/9906-wisp/wave-<api#>:<path>`) into the same path; whichever PR lands second rebases, and byte-identical files resolve cleanly. Never re-type a contract.
- **In-wave fan-out:** tasks inside one PARALLEL GROUP are file-disjoint and may run as concurrent subagents in the same worktree. Concurrent subagents never run `git commit`; the fixer commits once per group after all members pass. Groups run in the listed order.
- **Model routing:** the session and every tenancy/auth/permission/migration task are Opus. Tasks marked **Sonnet** are mechanical (locale fan-out, page scaffolds, pure helpers, docs, DTO plumbing) and run on Sonnet subagents with an Opus reviewer.
- The part that lands last owns the whole-wave verification task and the PR-body statement that covers both parts.

## Global Constraints

- **Dark by default.** Nothing in this wave changes runtime behaviour unless `wispEnabled()` (`apps/api/src/config/env.ts`, W02) is true: the wake scheduler's tick returns early, the subscriber returns early, routes 404. Flag off ⇒ `pnpm test` and the integration suites are unchanged except for the new files.
- **Authority is structural.** Every read of concerns/watches on behalf of a grant is filtered by `GrantCeiling.orgIds`; every run is admitted via `createAndEnqueueAgentRun({ grant })` (W02 step 1d). No prompt text widens anything. Agent DB contexts keep `userId: null`.
- **Tenancy ceremony** (`docs/agents/tenancy-rls.md`): RLS enabled + forced + policies in the creating migration; the composite `(org_id, partner_id) → organizations(id, partner_id)` FK is `DEFERRABLE INITIALLY IMMEDIATE`; every new `org_id` table is registered in `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts`, `CORE_TENANT_EXPORT_POLICY`; every `jsonb` column is `excludedOpen`. **Subject refs carry no `device_id`/`ticket_id` column** (see Task 1), so the device/ticket cascade lists are deliberately not touched.
- **Migration** slot `2027-01-04-100400-wisp-concerns-watches.sql`; re-check `ls apps/api/migrations/*.sql | sort | tail -1` sorts before it at commit time (newest on this checkout: `2027-01-03-140000-report-type-client-profitability.sql`; W02–W04 take `100100`–`100300`). Idempotent; no inner `BEGIN`/`COMMIT`; status/kind columns are `text` + CHECK, never `pgEnum`.
- **Profiles are exhaustive.** Adding `'assessment'` to `AI_AGENT_RUN_PROFILES` (`packages/shared/src/types/aiAgents.ts:1134`) breaks four `never`-exhaustive sites until Task 2 updates them: `AGENT_PROFILE_ROLE` (`agentModelRole.ts:16`), `outcomeToolsForProfile` (`outcomeTools.ts:169`), `profileCaps` (`runService.ts:964`), and the DB CHECK `ai_agent_runs_profile_chk` (asserted equal to the enum by `aiAgentSchedulesPartnerRls.integration.test.ts:648`).
- **Assessment limits** (w00): 15 turns, 25 ¢, 300 s wall clock, Tier 1 + auto-approved T2 only (`maxActionsPerRun: 0`; every write goes through an outcome tool → intent).
- **Budget semantics** (spec §9, w00 `budget.ts`): UTC day window; exhausted ⇒ model calls stop, deterministic concern updates + in-app digest continue, floor tick suspended, grantor told **once per window**; `pauseGrant(..., 'budget_exhausted')` is **not** called.
- **Nudge discipline** (spec §7.4): `nextBackoff` = 30 → 60 → 120 → 1440 minutes; after 2 unanswered nudges a concern is digest-only. W05 delivery = in-app notification + recipient row; W06 swaps delivery without changing the tool schema.
- **Events** go through `services/eventBus.ts` (`EventType` union + `EVENT_TYPES`); durable subscribers register in `services/eventSubscribers.ts` with an id in `eventSubscriberIds.ts`; sub-hourly ticks use `repeat: { every }` with the literal in the module (`scheduleRegistry.contract.test.ts` reads it statically); daily jobs take a `JOB_SCHEDULES` slot.
- **Web mutations** use `runAction`; new `en` keys go to all 8 locale dirs under `apps/web/src/locales/*/ai.json` (`localeParity.test.ts`).
- **Tests** beside source; run one file with `cd apps/api && npx vitest run <path>`; integration suites with `--config vitest.integration.config.ts` after `pnpm test-stack up` (tear it down after). Red first.
- **Copy:** product name **Wisp**; identifiers `wisp_*` / `wisp*`. No internal hosts/IPs.

## Review Focus

1. **Grant paused/revoked between wake and run start.** Expected: the delayed assess job admits nothing (`skip('grant_inactive')` from W02's step 1d), the grant's watches read `status = 'stopped'` on the next tick, and the partner admin gets one orphan notice — never a second run. Test pinned in Task 9 (`stops watches and notifies once`).
2. **Alert storm — 500 `alert.triggered` for one org inside a minute.** Expected: exactly one assessment job for (grant, org) in that window and at most `ASSESSMENT_MAX_RUNS_PER_HOUR` admissions per hour; the rest coalesce. Test pinned in Task 9 (`coalesces N wake requests into one job`) and Task 2 (`profileCaps('assessment')`).
3. **The subject disappears** (ticket deleted, device purged) while its concern is open. Expected: the next reaper pass resolves it with outcome `subject_gone`; the recipient never gets another nudge. Test pinned in Task 10.
4. **UTC midnight while an assessment is running.** Expected: spend is counted in the day the run was **queued** (`queued_at`), so a run admitted at 23:59 under budget cannot be refused retroactively and the new day starts at zero. Test pinned in Task 5 (`window boundary`).
5. **The model re-raises a snoozed concern.** Expected: `upsertConcern` returns `{ created: false }`, the snooze is untouched, and no nudge is sent before `snoozed_until`. Test pinned in Task 3 (`snoozed is live for the unique index`) and Task 6 (`nudge respects snooze`).

---

## Assumed from unmerged waves (grep these on day one; if a name differs, w00 wins and the wave plan is corrected)

| Wave | Symbol / table assumed by this plan | Where W05 uses it |
|---|---|---|
| W02 | `wispEnabled()` (`config/env.ts`) | every entry point's early return |
| W02 | `wisp_grants(id, partner_id, org_id, grantor_user_id, current_revision_id, status, budget_cents_per_day, floor_tick_minutes)`; Drizzle `wispGrants` | Tasks 1, 4, 5, 8, 9 |
| W02 | `resolveGrantCeiling(grantId, revisionId)`, `assertWithinCeiling`, `GrantCeiling` (incl. `grantorUserId`, w00 A3), `GrantInactiveError`, `CeilingViolationError`, `getActiveGrantForUser`, `pauseGrant`/`resumeGrant`, `updateGrantSettings(…, bounds)` + `GrantSettingsBounds` (`services/wisp/grantAuthority.ts`, `grants.ts`) | Tasks 3, 4, 5, 7, 9, 11 |
| W02 | `createAndEnqueueAgentRun` input `grant?: { grantId; grantRevisionId }`; `ai_agent_runs.grant_id` / `grant_revision_id` (Drizzle `aiAgentRuns.grantId`, `.grantRevisionId`); admission step 1d skips `grant_inactive` / `grant_org_out_of_ceiling` | Tasks 1, 5, 7, 13 |
| W02 | `apps/api/src/routes/wisp.ts` exporting `wispRoutes` (single file; mounted at `/wisp` in `apps/api/src/index.ts`; middleware order `authMiddleware` → 404 when `!wispEnabled()` → `requireScope('partner')` → `requirePermission('ai_sessions','use')`) | Task 11 |
| W02 | `ai_agent_runs.grant_id` reachable from an intent through `action_intents.requesting_agent_run_id` (W02 adds **no** column to `action_intents`), and `ai_operator_tasks.grant_id` | Task 8 payloads |
| W01 | `getEntitlements(partnerId)` → `{ plan, entitlements.wisp.{state,limits} }`, `hasEntitlement(partnerId, 'wisp')` (`services/entitlements.ts`) | Tasks 5, 7, 9 |
| W03 | `rememberForGrant(ceiling, block)`, `MemoryBlockType 'concern_outcome'`, table `ai_memory_blocks` (Drizzle `aiMemoryBlocks`), broker-caller contract test allowlist | Tasks 3, 10 |
| W04 | `getOrCreateThread(grantId)`, `updateThreadSummary(threadId, summary)` (≤ 4 000 chars), `seedContextForSession(threadId, ceiling)` (`services/wisp/threads.ts`) | Task 7 |
| W04 | `AiChatSidebar.tsx` renders `<WispThreadHeader>` under its header when `wisp` (a `NonNullable<WispState>` carrying `grantId`/`threadId`) is set; `no-silent-mutations.test.ts:35` `TARGET_GLOBS` lists the Wisp web files; deep link `/ai/wisp/thread/:threadId#concern=:id` | Tasks 6, 12 |
| W06 (consumer) | a callers-contract test that forbids `createNotification(` under `services/wisp/` outside **`services/wisp/deliver.ts`** (w00 A18); W05 therefore funnels every in-app delivery through `deliverInApp` in that one file; W06's `notifyUser` calls `deliverInApp` for its in-app row and replaces the finalizer's nudge step | Tasks 3–7 |
| W01 | `requireEntitlement('wisp')` middleware (already applied on the W02 hub from W04 onward) | Task 11 (inherited from the hub) |

## File structure

| Path | Responsibility |
|---|---|
| `apps/api/migrations/2027-01-04-100400-wisp-concerns-watches.sql` | 3 tables + RLS, `wisp_grants.last_floor_tick_at`, `ai_agent_runs_profile_chk` widened, `ai_agent_runs` grant/org/profile index |
| `apps/api/src/db/schema/wispConcerns.ts` | Drizzle for `wisp_concerns`, `wisp_concern_recipients`, `wisp_watches` |
| `packages/shared/src/types/wispConcerns.ts`, `packages/shared/src/validators/wispConcerns.ts` | Shared unions, DTOs, Zod for outcome-tool inputs and route bodies |
| `apps/api/src/services/wisp/concerns.ts` | Concern facts + recipient state + backoff + reaper (`upsertConcern`, `resolveConcern`, `listConcernsForCeiling`, `recipientState`, `nextBackoff`, …) |
| `apps/api/src/services/wisp/deliver.ts` | `deliverInApp` — the single `createNotification` call site under `services/wisp/` (W06 swaps its body for `notifyUser`) |
| `apps/api/src/services/wisp/watches.ts` | Watches CRUD, due-watch scan, stop-on-inactive-grant + orphan notice |
| `apps/api/src/services/wisp/budget.ts` | `chargeableUnderGrant`, once-per-window grantor notice |
| `apps/api/src/services/wisp/assessment.ts` | `enqueueAssessment`, `loadAssessmentContext`, `rollupPartnerPicture` |
| `apps/api/src/services/wisp/wake.ts` | `requestAssessment` (debounce), `pickRoundRobinOrg` (pure), subscriber handler |
| `apps/api/src/services/wisp/pollers.ts` | `ticket.stale` sliding-window poller |
| `apps/api/src/services/aiAgents/assessmentProfile.ts` | profile limits/allowlist/caps constants/prompt |
| `apps/api/src/services/aiAgents/runFinalizers.ts` | `finalizeAssessment` (applies outcome tools) |
| `apps/api/src/jobs/wispWakeScheduler.ts` | queue `wisp-wake`: 5-min tick (floor ticks, watches, poller) + delayed `assess` jobs |
| `apps/api/src/jobs/wispConcernRetention.ts` | daily reaper (`wisp-concern-retention`) |
| `apps/api/src/routes/wisp/concerns.ts`, `routes/wisp/watches.ts` | HTTP surface, mounted on W02's `wispRoutes` hub |
| `apps/web/src/components/ai/WispConcernsPanel.tsx`, `apps/web/src/lib/wispConcernsApi.ts` | Concerns list in the W04 thread view |

---

### Task 1: Migration, Drizzle schema, tenancy registrations

**Files:**
- Create: `apps/api/migrations/2027-01-04-100400-wisp-concerns-watches.sql`
- Create: `apps/api/src/db/schema/wispConcerns.ts`
- Modify: `apps/api/src/db/schema/index.ts` (add `export * from './wispConcerns';` after line 73's `./aiAgents`)
- Modify: `apps/api/src/services/tenantCascade.ts:1112-1119` (insert `'wisp_concern_recipients'`, `'wisp_concerns'`, `'wisp_watches'` between `'webhooks'` and `'yara_rule_sets'` — W04's `'wisp_thread_sessions'` sorts between `wisp_concerns` and `wisp_watches`)
- Modify: `apps/api/src/services/orgMergeRegistry.ts` (three `{ kind: 'repoint' }` entries)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (three `tablePolicy('org_id', …)` entries)
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:617` (add `'wisp_watches'` to `DUAL_AXIS_TENANT_TABLES` next to `connection_health_incidents`, same comment shape; `wisp_concerns`/`wisp_concern_recipients` are shape 1, auto-discovered)
- Test: `apps/api/src/__tests__/integration/wispConcernsRls.integration.test.ts`

**Interfaces:**
- Consumes: W02's `wisp_grants(id, partner_id, org_id, grantor_user_id, status, budget_cents_per_day, floor_tick_minutes)` and `ai_agent_runs.grant_id` / `grant_revision_id` (SQL FKs, Drizzle columns `aiAgentRuns.grantId`, `aiAgentRuns.grantRevisionId`).
- Produces: Drizzle tables `wispConcerns`, `wispConcernRecipients`, `wispWatches`; row types `WispConcernRow`, `WispConcernRecipientRow`, `WispWatchRow`.

**Schema decisions (copy into the migration header comment):**

- `wisp_concerns` — shape 1 (`org_id NOT NULL`) with `partner_id NOT NULL` denormalised; composite FK `(org_id, partner_id) → organizations(id, partner_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE` (template: `2026-12-29-100100-connection-health-incidents.sql:35-41`). Columns: `id uuid PK`, `partner_id`, `org_id`, `subject_kind text CHECK IN ('ticket','device','alert','org','integration','run','task','incident','quote','invoice','contract','site')` (the last five added 2026-10-23, w00 A30/A35), `subject_id uuid NOT NULL`, `summary text NOT NULL CHECK (length(summary) <= 2000)`, `severity text CHECK IN ('info','low','medium','high')`, `status text CHECK IN ('open','snoozed','resolved','dismissed') DEFAULT 'open'`, `evidence jsonb NOT NULL DEFAULT '{}' CHECK (pg_column_size(evidence) <= 32768)`, `raised_by_grant_id uuid NULL REFERENCES wisp_grants(id) ON DELETE SET NULL`, `last_assessed_run_id uuid NULL` (soft ref), `outcome text NULL CHECK (length(outcome) <= 1000)`, `resolved_at`, `resolved_by_user_id uuid NULL`, `created_at`, `updated_at`.
  - **Partial unique index** `wisp_concerns_live_subject_uq ON (partner_id, org_id, subject_kind, subject_id) WHERE status IN ('open','snoozed')`.
  - **Subject ids are soft references (no FK)** — decided. Reasons: (a) subjects span seven tables with different erasure dispositions (`ai_agent_runs` is `leave-for-erasure`, devices are purged by `removed-device-purge`, tickets move orgs); an FK would either cascade-delete the concern's history on device purge or block the purge with 23503. (b) A `device_id`/`ticket_id` column name would pull the table into `CORE_DEVICE_CASCADE_DELETE_TABLES` / `TICKET_ORG_DENORMALIZED_TABLES` with restamp semantics that are wrong for a concern (a concern about a device that moved org is resolved, not moved). (c) Reconciliation is cheap: the reaper (Task 10) resolves concerns whose subject no longer exists with outcome `subject_gone`. The generic name `subject_id` is deliberate so the device-list coverage tests do not match it.
  - Indexes: `(partner_id, status)`, `(org_id, status, severity)`, `(status, updated_at) WHERE status IN ('resolved','dismissed')` for the reaper.
- `wisp_concern_recipients` — shape 1, `org_id NOT NULL` + `partner_id NOT NULL` denormalised from the concern; composite FK `(concern_id, org_id) → wisp_concerns(id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE` (needs `UNIQUE (id, org_id)` on `wisp_concerns`); `grant_id uuid NOT NULL REFERENCES wisp_grants(id) ON DELETE CASCADE`; `UNIQUE (concern_id, grant_id)`; `nudge_count int NOT NULL DEFAULT 0`, `last_nudged_at`, `next_eligible_nudge_at`, `snoozed_until`, `dismissed_at`, `answered_at` (set by any user action on the concern: snooze/dismiss/resolve/reply), `created_at`, `updated_at`.
- `wisp_watches` — partner-anchored, org-optional (`partner_id NOT NULL`, `org_id NULL` = every org in the ceiling), **exactly** the `connection_health_incidents` precedent: single `FOR ALL` policy `system OR (org_id IS NOT NULL AND breeze_has_org_access(org_id)) OR (org_id IS NULL AND breeze_has_partner_access(partner_id))`, composite FK `(org_id, partner_id) → organizations(id, partner_id)` deferrable, registered in `DUAL_AXIS_TENANT_TABLES` (not XOR; no `breeze_current_partner_id()` read branch — an org token must never see a partner-wide watch). Columns: `id`, `partner_id`, `org_id`, `grant_id NOT NULL REFERENCES wisp_grants(id) ON DELETE CASCADE`, `owner_user_id uuid NOT NULL` (= grantor; composite FK `(owner_user_id, partner_id) → users(id, partner_id)` deferrable), `kind text CHECK IN ('ticket_waiting','alert_pattern','backup_health','patch_compliance','security_findings','custom_query','ticket_cluster')` (`ticket_cluster` added 2026-10-23, w00 A30), `params jsonb NOT NULL DEFAULT '{}' CHECK (pg_column_size(params) <= 8192)`, `cadence_minutes int NOT NULL CHECK (cadence_minutes BETWEEN 15 AND 10080)`, `status text CHECK IN ('active','stopped') DEFAULT 'active'`, `stopped_reason text NULL`, `last_ran_at`, `next_due_at timestamptz NOT NULL`, `created_at`, `updated_at`. Index `(status, next_due_at) WHERE status = 'active'`.
- `wisp_concerns` / `wisp_concern_recipients` policies: the four standard shape-1 policies from `0008-tenant-rls.sql:78-93` (`breeze_has_org_access(org_id)`), written explicitly with `DROP POLICY IF EXISTS` guards. `GRANT SELECT, INSERT, UPDATE, DELETE … TO breeze_app` on all three.
- `ALTER TABLE wisp_grants ADD COLUMN IF NOT EXISTS last_floor_tick_at timestamptz NULL;` (W02's table; column is W05's — the floor-tick cursor, see Task 9).
- `ALTER TABLE ai_agent_runs DROP CONSTRAINT IF EXISTS ai_agent_runs_profile_chk; ADD CONSTRAINT … CHECK (profile IN ('full','verdict','sweep','narrative','triage','design','patch','analysis','remediation_research','assessment'));` (pattern: `2026-12-07-100000-ai-agents-research-kind.sql:22-24`).
- `CREATE INDEX IF NOT EXISTS ai_agent_runs_grant_org_profile_queued_idx ON ai_agent_runs (grant_id, org_id, profile, queued_at DESC) WHERE grant_id IS NOT NULL;` — the assessment watermark and the budget sum both read it.
- No row writes ⇒ no `set_config('breeze.scope','system')` needed (DDL only). Say so in the header.

- [ ] **Step 1: Write the failing integration test**

`apps/api/src/__tests__/integration/wispConcernsRls.integration.test.ts` (structure: `aiAgentSchedulesPartnerRls.integration.test.ts` — `import './setup'`, `createPartner`/`createOrganization`/`createUser` from `./db-utils`, `SYSTEM_CTX`, afterEach cleanup). Cases:

```ts
it('cross-partner forge into wisp_concerns fails 42501', …)       // partner B org ctx inserts a row with partner A's org_id
it('org A token cannot read org B concerns of the same partner', …)
it('live subject uniqueness: second open concern for the same subject → 23505; a resolved one does not block', …)
it('snoozed counts as live for the unique index', …)
it('wisp_watches: org_id NULL row visible to partner ctx, invisible to org ctx', …)
it('composite org/partner FK is DEFERRABLE INITIALLY IMMEDIATE on all three tables', …) // pg_constraint condeferrable
it('ai_agent_runs_profile_chk accepts assessment', …)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test-stack up && cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/wispConcernsRls.integration.test.ts`
Expected: FAIL — `relation "wisp_concerns" does not exist`.

- [ ] **Step 3: Write the migration and the Drizzle schema**

`wispConcerns.ts` declares the three tables with `pgTable`, the composite FKs via `foreignKey(...)` (so `moveOrg.coverage.test.ts`'s FK reader sees them), the partial unique index via `uniqueIndex(...).where(sql\`…\`)`, and exports `WispConcernRow`, `WispConcernRecipientRow`, `WispWatchRow`. Types for `subject_kind`/`severity`/`status`/`kind` come from Task 2's shared unions (`$type<…>()`); create Task 2's `packages/shared/src/types/wispConcerns.ts` unions first if executing in order.

- [ ] **Step 4: Register the tables**

`tenantCascade.ts`: the three names in alphabetical position. `orgMergeRegistry.ts`: `wisp_concerns: { kind: 'repoint', note: 'subjects are org-owned rows that the merge repoints too, so (partner, survivor org, subject) stays unique' }`, same `repoint` for recipients and watches. `tenantExportPolicyRegistry.ts`: every column `included` except `evidence` and `params` → `excludedOpen`. `rls-coverage.integration.test.ts`: `'wisp_watches'` in `DUAL_AXIS_TENANT_TABLES` with the connection-health-style comment.

- [ ] **Step 5: Migrate, check drift, run the contract suites**

Run: `pnpm db:migrate && pnpm db:check-drift`
Run: `cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/db/migrationPartnerExportLocks.test.ts`
Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/wispConcernsRls.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts`
Run: `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`
Run: `cd apps/api && npx vitest run src/routes/devices/moveOrg.coverage.test.ts src/routes/devices/cascadeDelete.test.ts src/services/orgMerge.test.ts`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/2027-01-04-100400-wisp-concerns-watches.sql apps/api/src/db/schema/wispConcerns.ts apps/api/src/db/schema/index.ts apps/api/src/services/tenantCascade.ts apps/api/src/services/orgMergeRegistry.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts apps/api/src/__tests__/integration/wispConcernsRls.integration.test.ts
git commit -m "feat(wisp): wisp_concerns, wisp_concern_recipients, wisp_watches with RLS and tenancy registrations (W05)"
```

---

### Task 2: `assessment` profile — shared enum, model role, caps, circuit, validators

**Files:**
- Modify: `packages/shared/src/types/aiAgents.ts:1134-1136` (append `'assessment'`)
- Create: `packages/shared/src/types/wispConcerns.ts`, `packages/shared/src/validators/wispConcerns.ts` (+ exports from the two `index.ts` barrels)
- Modify: `apps/api/src/services/aiAgents/agentModelRole.ts:16-27` (`assessment: 'triage'`)
- Create: `apps/api/src/services/aiAgents/assessmentProfile.ts`
- Modify: `apps/api/src/services/aiAgents/runService.ts` — `AgentRunSkipReason` (:396), `profileCaps` (:964), admission step 2a (:1261-1264)
- Modify: `apps/api/src/services/aiAgents/agentCircuit.ts:127-131` (`'assessment'` in `STREAK_NEUTRAL_PROFILES`)
- Test: `apps/api/src/services/aiAgents/assessmentProfile.test.ts`, `packages/shared/src/validators/wispConcerns.test.ts`

**Interfaces:**
- Produces (shared, `types/wispConcerns.ts`):
  ```ts
  export const CONCERN_SUBJECT_KINDS = ['ticket','device','alert','org','integration','run','task'] as const;
  export type ConcernSubject = { kind: (typeof CONCERN_SUBJECT_KINDS)[number]; id: string };
  export type ConcernSeverity = 'info'|'low'|'medium'|'high';
  export type ConcernStatus = 'open'|'snoozed'|'resolved'|'dismissed';
  export type WatchKind = 'ticket_waiting'|'alert_pattern'|'backup_health'|'patch_compliance'|'security_findings'|'custom_query';
  export type WatchStatus = 'active'|'stopped';
  export interface Concern { id; partnerId; orgId; subject: ConcernSubject; summary; severity: ConcernSeverity; status: ConcernStatus; evidence: Record<string, unknown>; outcome: string | null; approvalIntentId: string | null /* latest intent minted by propose_action({ concernId }); read from evidence.approvalIntentId; W06's mobile sheet and web page open the card from it */; createdAt: string; updatedAt: string; recipient?: { nudgeCount; nextEligibleNudgeAt: string | null; snoozedUntil: string | null; dismissedAt: string | null } }
  export interface Watch { id; partnerId; orgId: string | null; grantId; kind: WatchKind; params; cadenceMinutes; status: WatchStatus; lastRanAt: string | null; nextDueAt: string }
  export interface AssessmentOutcome { concernsRaised: RaiseConcernInput[]; concernsUpdated: UpdateConcernInput[]; nudges: NudgeInput[]; proposedActions: ProposeActionInput[]; specialistRequests: { kind: string; params: Record<string, unknown> }[] }
  ```
- Produces (shared, `validators/wispConcerns.ts`): `raiseConcernSchema` (`subject`, `summary ≤ 2000`, `severity`, `evidence` object ≤ 20 keys), `raiseConcernChatSchema = raiseConcernSchema.extend({ orgId: uuid, subject: z.object({ kind: z.enum(['org','ticket']), id: uuid }) })` (w00 A25: the chat tool's input — subject kinds narrowed to `org`/`ticket`, explicit `orgId` because a chat turn names its target org; Task 11b), `updateConcernSchema` (`concernId`, optional `summary`/`severity`/`evidence`, `status?: 'resolved'` + `outcome`), `nudgeSchema` (`concernId`, `nextStep ≤ 300`, `approvalIntentId?`), `proposeActionSchema` (`toolName`, `input` object, `reason ≤ 500`, `concernId?`), `requestSpecialistSchema` (`kind`, `params`), `createWatchBodySchema` (`grantId` uuid, `orgId` nullable uuid, `kind`, `params`, `cadenceMinutes` int 15–10080), `snoozeBodySchema` (`grantId` uuid, `until` ISO datetime, ≤ 30 days ahead), `dismissBodySchema` (`grantId` uuid), `resolveBodySchema` (`grantId` uuid, `outcome ≤ 1000`) — `grantId` names the caller's recipient row; W06's web page and mobile sheet send it from the thread payload / push data. `requestSpecialistSchema` (`kind`, `params`, `reason` string 10–500) — W07 fills the body behind it.
- Produces (`assessmentProfile.ts`):
  ```ts
  export const ASSESSMENT_MAX_TURNS = 15;
  export const ASSESSMENT_BUDGET_CENTS_PER_RUN = 25;
  export const ASSESSMENT_WALL_CLOCK_SECONDS = 300;
  export const ASSESSMENT_MAX_CONCURRENT_RUNS = 1;   // per (agent, org)
  export const ASSESSMENT_MAX_RUNS_PER_HOUR = 6;      // per (agent, org)
  export const ASSESSMENT_TOOL_ALLOWLIST: readonly string[]; // read-only drill-down floor, see step 3
  export function isAssessmentProfile(run: { profile: AiAgentRunProfile }): boolean;
  export function assessmentLimits(limits: AiAgentLimits): AiAgentLimits; // pins maxTurnsPerRun, maxBudgetCentsPerRun, wallClockSeconds, maxActionsPerRun: 0
  export function assessmentToolAllowlist(agentAllowlist: string[]): string[]; // ASSESSMENT_TOOL_ALLOWLIST ∩ agentAllowlist (empty agent list = policy default ⇒ whole floor)
  ```
- Produces (`runService.ts`): skip reasons `'max_concurrent_assessment_runs' | 'assessment_rate' | 'assessment_requires_grant'`; `profileCaps('assessment')` arm `{ maxConcurrent: ASSESSMENT_MAX_CONCURRENT_RUNS, maxPerWindow: ASSESSMENT_MAX_RUNS_PER_HOUR, windowMs: 3_600_000, concurrentSkip: 'max_concurrent_assessment_runs', rateSkip: 'assessment_rate' }`; step 2a gains `if ((input.profile ?? 'full') === 'assessment' && (kind !== 'triage' || !input.grant)) return skip(kind !== 'triage' ? 'ownership_mismatch' : 'assessment_requires_grant');`.

- [ ] **Step 1: Write the failing tests**

`assessmentProfile.test.ts`:
```ts
it('AI_AGENT_RUN_PROFILES contains assessment and AGENT_PROFILE_ROLE maps it to triage', …)
it('assessmentLimits pins 15 turns / 25 cents / 300 s / 0 actions and passes everything else through', …)
it('assessmentToolAllowlist is read-only: every name is registered and its TOOL_TIERS base tier is 1', …)   // TOOL_TIERS lives in services/aiAgentSdkTools.ts:191, not aiGuardrails.ts
it('outcomeToolsForProfile("assessment") is exactly [record_concern, update_concern, nudge, propose_action, request_specialist]', …) // goes green in Task 6
it('profileCaps("assessment") returns the pinned caps', …)  // via runService's exported test seam if present, else exercise createAndEnqueueAgentRun with mocks as runService.test.ts does
it('classifyTerminal("completed", null, "needs_attention", "assessment") is neutral', …)
```
`validators/wispConcerns.test.ts`: one accept + one reject per schema (`summary` 2001 chars rejected; `cadenceMinutes` 14 rejected; `until` 31 days ahead rejected; `raiseConcernChatSchema` rejects `subject.kind: 'device'` and a missing `orgId`).

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/api && npx vitest run src/services/aiAgents/assessmentProfile.test.ts && cd ../../packages/shared && npx vitest run src/validators/wispConcerns.test.ts`
Expected: FAIL — module not found / `'assessment'` not assignable.

- [ ] **Step 3: Implement**

Add `'assessment'` to the enum; add the `assessment: 'triage'` arm (spec §14: assessments default to the registry's `triage` role). `ASSESSMENT_TOOL_ALLOWLIST` = the Tier-1 read tools an assessment needs to look at what changed. Verified base-tier-1 names in `aiAgentSdkTools.ts` `TOOL_TIERS` (:191+): `query_devices`, `get_device_details`, `query_audit_log`, `get_backup_status`, `query_backup_sla`, `list_incidents`, `get_incident_timeline`, `get_security_posture`, `list_edr_detections`, `get_vulnerability_report`, `get_device_vulnerabilities`, plus W03's `recall` (T1; works because Task 6 stamps `wispGrant` on the run's agent auth). For ticket and alert reads copy the exact names `VERDICT_TOOL_ALLOWLIST` (`verdictProfile.ts`) and `ticketHelpdeskSubscriber`'s triage path already expose for reading (the `manage_alerts` / ticket tools are base tier 1 with action-based escalation in `aiGuardrails.ts`; the run-loop read-only guard at `runLoop.ts:1183` plus `maxActionsPerRun: 0` keep any escalated action out of an assessment). Do not list a name the step-1 test rejects. Mirror `triageProfile.ts` for shape and docstrings (`DESIGN_TOOL_ALLOWLIST` in `designProfile.ts:23` is the precedent for a non-empty read floor). In `runService.ts` add the three skip reasons (not in `PUBLISHED_SKIP_REASONS` — volume guards, same posture as the triage pair; `assessment_requires_grant` is a caller bug surfaced as a skip, not a throw, because the wake coordinator must never wedge on it) and the caps arm. `STREAK_NEUTRAL_PROFILES` gains `'assessment'` (an assessment that reports `needs_attention` is doing its job, not failing).

- [ ] **Step 4: Typecheck and run**

Run: `pnpm --filter @breeze/shared build && cd apps/api && npx tsc --noEmit -p tsconfig.json` (12 GB heap per CLAUDE memory: `NODE_OPTIONS=--max-old-space-size=12288`; check the exit code, do not pipe to `tail`)
Expected: the only remaining errors are the `never` arm in `outcomeToolsForProfile` (Task 6 closes it). If `tsc` reports other exhaustive sites, fix them in this task and list them in the commit body.
Run the step-1 tests: all PASS except the `outcomeToolsForProfile` case (expected red until Task 6).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/aiAgents.ts packages/shared/src/types/wispConcerns.ts packages/shared/src/types/index.ts packages/shared/src/validators/wispConcerns.ts packages/shared/src/validators/wispConcerns.test.ts packages/shared/src/validators/index.ts apps/api/src/services/aiAgents/agentModelRole.ts apps/api/src/services/aiAgents/assessmentProfile.ts apps/api/src/services/aiAgents/assessmentProfile.test.ts apps/api/src/services/aiAgents/runService.ts apps/api/src/services/aiAgents/agentCircuit.ts
git commit -m "feat(wisp): assessment run profile — enum, triage model role, pinned limits, admission caps (W05)"
```

---

### Task 3: `services/wisp/concerns.ts`

**Files:**
- Create: `apps/api/src/services/wisp/concerns.ts`, `apps/api/src/services/wisp/deliver.ts`
- Test: `apps/api/src/services/wisp/concerns.test.ts` (unit, Drizzle mocks per `breeze-testing`), `apps/api/src/services/wisp/deliver.test.ts`, `apps/api/src/__tests__/integration/wispConcerns.integration.test.ts`

**Interfaces:**
- Consumes: W02 `resolveGrantCeiling`, `GrantCeiling` (`services/wisp/grantAuthority.ts`); W03 `rememberForGrant(ceiling, block)` (`services/wisp/memoryBroker.ts`); `withSystemDbAccessContext` / `runOutsideDbContext` (`db/index.ts:1005`); `createNotification` (`services/userNotifications.ts:64`).
- Produces (exact w00 names, plus the helpers routes and the finalizer need):
  ```ts
  export type { ConcernSubject, ConcernSeverity, ConcernStatus, Concern } from '@breeze/shared';
  export async function upsertConcern(input: { partnerId: string; orgId: string; subject: ConcernSubject; summary: string; severity: ConcernSeverity; evidence: Record<string, unknown>; raisedByGrantId?: string | null; lastAssessedRunId?: string | null }): Promise<{ id: string; created: boolean }>;
  export async function updateConcern(id: string, patch: { summary?: string; severity?: ConcernSeverity; evidence?: Record<string, unknown>; lastAssessedRunId?: string | null }): Promise<void>;
  export async function resolveConcern(id: string, by: { grantId?: string; userId?: string }, outcome: string): Promise<void>;
  export async function dismissConcern(id: string, by: { grantId: string; userId: string }): Promise<void>;   // per-recipient: sets recipients.dismissed_at + answered_at; concern status → 'dismissed' only when every recipient dismissed
  export async function snoozeConcern(id: string, by: { grantId: string; userId: string }, until: Date): Promise<void>; // recipient.snoozed_until; concern status → 'snoozed' while any recipient snoozed and none open
  export async function listConcernsForCeiling(ceiling: GrantCeiling, f?: { status?: ConcernStatus[]; orgId?: string }): Promise<Concern[]>; // system ctx; WHERE partner_id = ceiling.partnerId AND org_id = ANY(ceiling.orgIds); joins the caller grant's recipient row
  export async function recipientState(concernId: string, grantId: string): Promise<{ nudgeCount: number; nextEligibleNudgeAt: Date | null; snoozedUntil: Date | null; dismissedAt: Date | null }>;
  export async function recordNudge(concernId: string, grantId: string, at: Date): Promise<{ nudgeCount: number; nextEligibleNudgeAt: Date }>; // upserts recipient row; nudge_count++, last_nudged_at, next_eligible = at + nextBackoff(nudge_count)
  export async function markAnswered(concernId: string, grantId: string, at: Date): Promise<void>; // resets nudge_count to 0, answered_at
  export function nextBackoff(nudgeCount: number): number; // 30, 60, 120, then 1440
  export function isDigestOnly(state: { nudgeCount: number; answeredAt: Date | null; lastNudgedAt: Date | null }): boolean; // ≥ 2 nudges since the last answer
  export async function reapConcerns(now: Date, opts?: { resolvedRetentionDays?: number; limit?: number }): Promise<{ deleted: number; subjectGone: number }>; // Task 10 calls it
  ```
- Produces (`deliver.ts` — the one place under `services/wisp/` that imports `createNotification`; Tasks 4–7 call it, never `createNotification` directly):
  ```ts
  export type InAppDelivery = { userId: string; orgId: string | null; title: string; body: string | null; link: string; dedupeKey: string; priority?: 'normal' | 'high'; concernId?: string | null; approvalIntentId?: string | null; threadId?: string | null; grantId?: string | null; deepLink?: string | null };
  export async function deliverInApp(d: InAppDelivery): Promise<{ created: boolean }>; // runOutsideDbContext(withSystemDbAccessContext(() => createNotification({ type: 'ai', metadata: { wispThreadId: threadId, concernId, grantId, intentId: approvalIntentId, deepLink }, … }))); created:false when createNotification returns null (dedupe collision). The metadata keys are what W06's web bell fallback (`buildHref`) reads — keep the spelling.
  ```
- Rules: `upsertConcern` uses `INSERT … ON CONFLICT ON CONSTRAINT`-free form: `insert().onConflictDoNothing({ target: [...], where: sql\`status IN ('open','snoozed')\` }).returning()`, and on no row returned selects the live row and returns `{ created: false }` **without touching its status** (Review Focus 5). `resolveConcern` with `grantId` writes a `concern_outcome` block via `rememberForGrant(ceiling, { owner: { kind: 'org', orgId }, blockType: 'concern_outcome', subjectKey: \`concern:${subject.kind}:${subject.id}\`, content: { summary, outcome, severity, resolvedBy: 'wisp' }, confidence: 'medium' })` where `ceiling = await resolveGrantCeiling(grantId, currentRevisionId)`; with `userId` only, no memory block (W03 writes human-authored blocks elsewhere). All writes run under `runOutsideDbContext(() => withSystemDbAccessContext(fn, 'wisp.concerns'))` because callers are workers and routes alike.

- [ ] **Step 1: Write the failing unit tests**

```ts
describe('nextBackoff', () => {
  it.each([[0, 30], [1, 60], [2, 120], [3, 1440], [9, 1440]])('nudgeCount %i → %i minutes', …);
});
describe('isDigestOnly', () => {
  it('false after one unanswered nudge, true after two', …);
  it('false when answered after the last nudge', …);
});
describe('upsertConcern', () => {
  it('returns created:true on insert and created:false with the existing id when the live row exists', …);
  it('never writes status on the created:false path', …);
});
describe('resolveConcern', () => {
  it('calls rememberForGrant with blockType concern_outcome and the org owner when grantId is present', …);
  it('does not call the broker when only userId is present', …);
});
// deliver.test.ts
it('deliverInApp wraps createNotification in runOutsideDbContext + withSystemDbAccessContext and returns created:false on a dedupe collision', …);
it('createNotification( appears in exactly one file under services/wisp/: deliver.ts', …); // readdir + regex, the W06 contract in advance
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/wisp/concerns.test.ts`
Expected: FAIL — cannot find module `./concerns`.

- [ ] **Step 3: Implement `concerns.ts`**

Pure functions first (`nextBackoff`, `isDigestOnly`), then the DB functions with the signatures above. `listConcernsForCeiling` orders by `severity DESC (high→info), updated_at DESC`, caps at 200 rows.

- [ ] **Step 4: Write and run the integration test**

`wispConcerns.integration.test.ts`: two orgs A and B under one partner, a grant whose ceiling is `{ orgIds: [A] }` (build a `GrantCeiling` literal — no need for a live W02 grant row for the read-side test). Cases: `listConcernsForCeiling` returns A's concern and never B's; `upsertConcern` twice → one row, second `{ created: false }`; `resolveConcern` then `upsertConcern` → new row (the partial index releases the subject); `snoozeConcern` then `upsertConcern` → `{ created: false }` and `snoozed_until` unchanged.

Run: `cd apps/api && npx vitest run src/services/wisp/concerns.test.ts src/services/wisp/deliver.test.ts && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/wispConcerns.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/wisp/concerns.ts apps/api/src/services/wisp/concerns.test.ts apps/api/src/services/wisp/deliver.ts apps/api/src/services/wisp/deliver.test.ts apps/api/src/__tests__/integration/wispConcerns.integration.test.ts
git commit -m "feat(wisp): concerns service — upsert/resolve/snooze/dismiss, recipient backoff, ceiling-filtered reads (W05)"
```

---

### Task 4: `services/wisp/watches.ts`

**Files:**
- Create: `apps/api/src/services/wisp/watches.ts`
- Test: `apps/api/src/services/wisp/watches.test.ts`

**Interfaces:**
- Consumes: `GrantCeiling` (incl. `grantorUserId`, `partnerId`), `assertWithinCeiling` (W02); Task 3 `deliverInApp`; W04 `getOrCreateThread(grantId)` (for notice links); a local `select` of `wispGrants.orgId` for the partner-wide check.
- Produces:
  ```ts
  export type { WatchKind, Watch } from '@breeze/shared';
  export async function createWatch(ceiling: GrantCeiling, input: { orgId: string | null; kind: WatchKind; params: Record<string, unknown>; cadenceMinutes: number }): Promise<Watch>; // assertWithinCeiling(ceiling, { orgId }) when orgId set; orgId null requires the grant to be partner-wide (wisp_grants.org_id IS NULL) else CeilingViolationError('org'); owner_user_id = ceiling.grantorUserId; next_due_at = now + cadence
  export async function listWatches(ceiling: GrantCeiling): Promise<Watch[]>; // grant_id = ceiling.grantId
  export async function deleteWatch(ceiling: GrantCeiling, watchId: string): Promise<boolean>; // only the owning grant's rows
  export async function claimDueWatches(now: Date, limit: number): Promise<Watch[]>; // status active AND next_due_at <= now, FOR UPDATE SKIP LOCKED; bumps next_due_at = now + cadence and last_ran_at = now in the same statement
  export async function stopWatchesForInactiveGrants(now: Date): Promise<{ stopped: number; grantsNotified: number }>; // UPDATE … SET status='stopped', stopped_reason = grant.status WHERE grant.status <> 'active'; then one in-app notice per affected partner admin listing the orphaned watches (dedupeKey `wisp-watches-orphaned-<grantId>`)
  export function watchPromptLines(w: Watch): string[]; // deterministic, used by Task 7's prompt: kind, params as sanitized key=value, cadence
  ```
- Partner admins for the orphan notice: the partner's users that `canManagePartnerWidePolicies` would admit — `partner_users.org_access = 'all'` (w00 A1: partner-admin actions key on that predicate, not on `ai_agents:write`; read `services/partnerWideAccess.ts` for the column); delivered through Task 3's `deliverInApp({ orgId: null, link: '/approvals', title: 'Wisp: watches stopped', body: '<grantor name>\'s grant is <status>; N watches are no longer running: <kinds>', dedupeKey: \`wisp-watches-orphaned-${grantId}\` })` — partner-wide (`orgId: null`) so it is visible regardless of the admin's org narrowing. (`/ai/wisp` is not a page; the admin cannot open another tech's thread, so the link goes to an existing page and the body carries the facts.)

- [ ] **Step 1: Write the failing tests**

```ts
it('createWatch refuses an orgId outside the ceiling with CeilingViolationError code org', …)
it('createWatch with orgId null on a single-org grant is refused', …)
it('claimDueWatches advances next_due_at by cadence in the same statement', …)  // assert the generated SQL/mocked update set
it('stopWatchesForInactiveGrants notifies each partner admin once per grant (dedupeKey)', …)
it('watchPromptLines is deterministic and sanitises params values', …)
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/wisp/watches.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `watches.ts`**

- [ ] **Step 4: Run tests**

Run: `cd apps/api && npx vitest run src/services/wisp/watches.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/wisp/watches.ts apps/api/src/services/wisp/watches.test.ts
git commit -m "feat(wisp): watches service — ceiling-checked create/list/delete, due-claim, stop-on-inactive-grant (W05)"
```

---

### Task 5: `services/wisp/budget.ts`

**Files:**
- Create: `apps/api/src/services/wisp/budget.ts`
- Test: `apps/api/src/services/wisp/budget.test.ts`

**Interfaces:**
- Consumes: `aiAgentRuns.grantId`, `aiAgentRuns.queuedAt`, `aiAgentRuns.costCents` (index from Task 1); W02 grant row (`budget_cents_per_day`, `grantor_user_id`, `partner_id`, `org_id`), W02 `createGrant` (one-line edit below) and `GrantSettingsBounds`; W01 `getEntitlements(partnerId)` (`plan`, `entitlements.wisp.limits`); W04 `getOrCreateThread(grantId)`; Task 3 `deliverInApp`.
- Produces:
  ```ts
  export const WISP_BUDGET_DEFAULT_BY_PLAN: Record<PartnerPlan, number>; // spec §16: pro 200, enterprise 500, unlimited 1000; free/starter/community 200 (only reachable through a manual entitlement)
  export async function grantSettingsBounds(partnerId: string): Promise<GrantSettingsBounds>; // { budgetCentsPerDayMax: min(5 × WISP_BUDGET_DEFAULT_BY_PLAN[plan], limits.budgetCentsPerDayCeiling), minFloorTickMinutes: max(15, limits.minFloorTickMinutes) } from getEntitlements (spec §9 "raise to 5× within plan ceiling"); W02's PATCH /wisp/grants/:id/settings handler is edited to pass it
  export function utcDayWindow(now: Date): { start: Date; end: Date; key: string }; // key 'YYYY-MM-DD', same derivation as aiCostTracker.checkBudgetDetailed (:675)
  export async function spentUnderGrant(grantId: string, now?: Date): Promise<number>; // SUM(cost_cents) of ai_agent_runs WHERE grant_id = $1 AND queued_at >= window.start AND status NOT IN ('skipped')
  export async function chargeableUnderGrant(grantId: string, estimateCents: number): Promise<{ ok: true } | { ok: false; reason: 'budget_exhausted' }>; // ok when spent + estimate <= budget_cents_per_day
  export async function notifyBudgetExhaustedOnce(grantId: string, now?: Date): Promise<boolean>; // deliverInApp({ userId: grantorUserId, orgId: grant.orgId, title: 'Wisp paused for today — budget reached', body: 'Raise the daily budget from the thread header to resume.', link: `/ai/wisp/thread/${thread.id}`, threadId, grantId, dedupeKey: `wisp-budget-${grantId}-${window.key}` }).created  — spec §9 "told once, with a one-tap raise": the link lands on the thread page whose header (W04) carries the budget control
  ```
- `chargeableUnderGrant` never calls `pauseGrant` (w00). It runs under `runOutsideDbContext(withSystemDbAccessContext)`.
- One-line edit to W02's `createGrant` (`services/wisp/grants.ts`): `budgetCentsPerDay = WISP_BUDGET_DEFAULT_BY_PLAN[(await getEntitlements(scope.partnerId)).plan]` instead of the column default (spec §16 plan defaults); W02's own test "budgetCentsPerDay 200" stays true for a `pro` fixture.

- [ ] **Step 1: Write the failing tests**

```ts
describe('utcDayWindow', () => {
  it('23:59:59.999Z and 00:00:00.000Z fall in different windows', …);
  it('key is UTC, not local', …);   // run with TZ=America/Chicago via process.env.TZ in the test
});
describe('chargeableUnderGrant', () => {
  it('ok when spent + estimate == budget', …);
  it('budget_exhausted when spent + estimate > budget', …);
  it('counts runs by queued_at, so a run queued yesterday that finished today is not charged to today', …);  // Review Focus 4
});
describe('notifyBudgetExhaustedOnce', () => {
  it('second call in the same window returns false (dedupe key collides)', …);
  it('links to the grant\'s thread page, not a bare path', …);
});
describe('plan defaults and bounds', () => {
  it('createGrant on an enterprise partner stores budgetCentsPerDay 500; pro 200; unlimited 1000', …);   // getEntitlements mocked per plan
  it('grantSettingsBounds is min(5 × plan default, limits.budgetCentsPerDayCeiling) and max(15, limits.minFloorTickMinutes)', …); // pro: { 1000, 15 }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/wisp/budget.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `budget.ts`**

- [ ] **Step 4: Run tests**

Run: `cd apps/api && npx vitest run src/services/wisp/budget.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/wisp/budget.ts apps/api/src/services/wisp/budget.test.ts apps/api/src/services/wisp/grants.ts apps/api/src/services/wisp/grants.test.ts apps/api/src/routes/wisp.ts
git commit -m "feat(wisp): per-grant UTC-day budget gate, plan budget defaults and settings bounds, once-per-window grantor notice (W05)"
```

---

### Task 6: Outcome tools, run-loop wiring, prompt, finalizer

**Files:**
- Modify: `apps/api/src/services/aiAgents/outcomeTools.ts` — `OUTCOME_TOOL_NAMES` (:71), `OUTCOME_MCP_TOOL_NAMES` (:99), `outcomeToolsForProfile` (:169), `validateOutcomeToolInput` overloads (:215+), `buildOutcomeSdkTools` (:784)
- Modify: `apps/api/src/services/aiAgents/runLoopTypes.ts:139` (`AgentRunOutcome` gains `assessment?: AssessmentOutcome`), `RunContext` (:413) gains `assessment: AssessmentRunContext | null`
- Modify: `apps/api/src/services/aiAgents/runLoop.ts` — `loadRunContext` (:321), the capture switch around :1402, read-only guard (:1183), `resolveRunProfileLimits` (:1897), `resolveRunProfileToolAllowlist` (:1916), the finalizer dispatch in `finishRun` (~:3509)
- Modify: `apps/api/src/services/aiAgents/runnerPrompt.ts` — `AgentRunPromptContext` (:301) gains `assessment?: AgentRunAssessmentPromptContext | null`; `buildAgentRunTaskPrompt` (:1760) gains the `assessment` arm; new `buildAssessmentTaskPrompt`
- Modify: `apps/api/src/services/aiAgents/runFinalizers.ts` — add `finalizeAssessment`
- Test: `apps/api/src/services/aiAgents/outcomeTools.test.ts` (extend), `apps/api/src/services/aiAgents/runFinalizers.assessment.test.ts`, `apps/api/src/services/aiAgents/runnerPrompt.assessment.test.ts`

**Interfaces:**
- Consumes: Task 2 validators and constants; Task 3 `upsertConcern`/`updateConcern`/`resolveConcern`/`recordNudge`/`recipientState`/`isDigestOnly`/`deliverInApp`; Task 7 `loadAssessmentContext` (define its type here, implement there); `createActionIntent(agentAuth, { toolName, input, source: 'ai_agent', orgId, reason })` exactly as `runLoop.ts:905`; `createNotification`; `wrapUntrustedData(label, body)` (`aiInputSanitizer.ts:286`) and `UNTRUSTED_TOOL_OUTPUT_RULE` (`aiAgentSystemPrompt.ts:16`).
- Produces:
  ```ts
  // outcomeTools.ts
  OUTCOME_TOOL_NAMES += 'record_concern' | 'update_concern' | 'nudge' | 'propose_action' | 'request_specialist';   // record_concern, not raise_concern: that name is the chat tool (Task 11b, w00 A25) and TOOL_TIERS names are forbidden as extras (aiAgentSdkTools.ts:4354)
  outcomeToolsForProfile('assessment') === ['record_concern','update_concern','nudge','propose_action','request_specialist'];
  // each tool MAY be called many times per run (unlike submit_*); capture APPENDS to outcome.assessment.<list>; request_specialist's SDK handler returns { refused: 'not_available_until_w07' } and is still recorded in outcome.assessment.specialistRequests for W07's audit
  // runLoopTypes.ts
  export interface AssessmentRunContext { grantId: string; grantRevisionId: string; threadId: string; threadSummary: string; openConcerns: Concern[]; changedSince: string | null; digest: AssessmentDigest; watch: Watch | null; reason: AssessmentReason }
  export type AssessmentDigest = { alerts: { id; title; severity; status; at }[]; tickets: { id; number; title; status; updatedAt }[]; incidents: { id; sourceKind; condition; openedAt }[]; runs: { id; profile; status; summary }[]; intents: { id; toolName; status }[] }; // each list ≤ 25 rows, text fields through sanitizeSweepText
  // runnerPrompt.ts
  export function buildAssessmentTaskPrompt(ctx: AgentRunPromptContext): string;
  // runFinalizers.ts
  export async function finalizeAssessment(ctx: RunContext, result: LoopResult): Promise<string | null>;
  ```
- `buildAssessmentTaskPrompt` content (exact order): (1) `## Mode: assessment` + the five-outcome instruction ("stay quiet | update a concern | nudge | propose an action | request a specialist — call the matching tool; call nothing when nothing changed"); (2) `AGENT_PROMPT_AUTHORITY_DISCLAIMER`; (3) `wrapUntrustedData('wisp-thread-summary', ctx.assessment.threadSummary)`; (4) `wrapUntrustedData('wisp-open-concerns', <one line per concern: id | severity | subject kind:id | summary | recipient nudgeCount/nextEligible>)`; (5) `wrapUntrustedData('wisp-changes-since-watermark', <digest rendered as one line per row>)`; (6) when `ctx.assessment.watch` is set, `watchPromptLines(...)`; (7) `UNTRUSTED_TOOL_OUTPUT_RULE`; (8) the closing rule: "Nudge only when `recipient.nextEligibleNudgeAt` is null or in the past; never nudge a concern marked digest-only; one nudge names one person, one subject, one next step."
- `finalizeAssessment` order, each step independently try/caught and logged (a failed nudge must not lose a raised concern): (1) `record_concern` → `upsertConcern({ ..., raisedByGrantId: run.grantId, lastAssessedRunId: run.id })`, max 10 per run (overflow → `outcome.assessmentSkipped.push('raise_cap')`); (2) `update_concern` → `updateConcern` / `resolveConcern(id, { grantId }, outcome)`; **refuse** an id whose concern is outside `run.orgId` (`concern_not_in_org`); (3) `nudge` → load `recipientState`; skip when `snoozedUntil > now`, `dismissedAt` set, `nextEligibleNudgeAt > now`, or `isDigestOnly` (`outcome.assessmentSkipped.push('nudge_backoff' | 'nudge_digest_only' | 'nudge_snoozed')`); else `deliverInApp({ userId: ceiling.grantorUserId, orgId: run.orgId, title: 'Wisp: ' + concern.summary.slice(0, 80), body: nextStep, link: \`/ai/wisp/thread/${threadId}#concern=${concernId}\`, priority: severity === 'high' ? 'high' : 'normal', concernId, approvalIntentId, threadId, grantId, dedupeKey: \`wisp-nudge-${concernId}-${grantId}-${nudgeCount}\` })` then `recordNudge` (W06 Task 4 replaces this one `deliverInApp` call with `notifyUser({ userId, category: 'wisp_nudge', title, body, deepLink: mobileDeepLink(threadId, concernId), concernId, threadId, grantId, approvalIntentId })` and keeps `recordNudge`; `deliverInApp` itself stays the single `createNotification` site, w00 A18); (4) `propose_action` → `createActionIntent(result.agentAuth, { toolName, input, source: 'ai_agent', orgId: run.orgId, reason: \`Proposed by Wisp assessment ${run.id}: ${reason}\` })`, push to `result.intentIds`, max `AI_AGENT_LIMIT_DEFAULTS.maxActionsPerRun`; a Tier-1 `toolName` is refused (`propose_tier1_refused`); when `concernId` is given, `updateConcern(concernId, { evidence: { ...evidence, approvalIntentId: intentId } })` so the concern's `approvalIntentId` (Task 2 DTO) points at the card (spec §7.4 "the nudge carries the approval card id"); (5) `request_specialist` entries are left in the outcome untouched (W07). Finally `touch wisp_concerns.last_assessed_run_id` for every concern read, and call Task 7's `rollupPartnerPicture(grantId)` (best-effort).

- [ ] **Step 1: Write the failing tests**

`outcomeTools.test.ts` additions: names present in `OUTCOME_TOOL_NAMES` and `OUTCOME_MCP_TOOL_NAMES`; `outcomeToolsForProfile('assessment')` exact list; no assessment outcome-tool name is a key of `TOOL_TIERS` (the `createBreezeMcpServer` collision guard, asserted statically so Task 11b's `raise_concern` can never trip it); `validateOutcomeToolInput('record_concern', bad)` throws on a 2001-char summary; `buildOutcomeSdkTools(['request_specialist'], …)` handler resolves to `{ refused: 'not_available_until_w07' }`.
`runnerPrompt.assessment.test.ts`: prompt contains the three `<untrusted_data source="wisp-…">` fences in order; a thread summary containing `</untrusted_data>` is neutralised to `[filtered]`; empty digest renders the literal `No changes since the last assessment.`; `buildAgentRunTaskPrompt({ profile: 'assessment', … })` dispatches to the new builder.
`runFinalizers.assessment.test.ts` (mock `../wisp/concerns`, `../wisp/deliver`, `../actionIntents/intentService`): raise → `upsertConcern` called with `raisedByGrantId`; update on a concern in another org → skipped with `concern_not_in_org`; nudge with `nextEligibleNudgeAt` in the future → no `createNotification`; nudge on digest-only → none; nudge on a fresh concern → `deliverInApp` with the exact `dedupeKey` and `link`, then `recordNudge`; `propose_action` Tier 3 → `createActionIntent` called once with `source: 'ai_agent'`; Tier 1 → refused; 11 raises → 10 upserts + `raise_cap`; a throwing `upsertConcern` does not prevent the nudge step from running.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/aiAgents/outcomeTools.test.ts src/services/aiAgents/runnerPrompt.assessment.test.ts src/services/aiAgents/runFinalizers.assessment.test.ts`
Expected: FAIL — unknown tool names / missing exports.

- [ ] **Step 3: Implement**

Follow the `triage` arms as the template at every listed line. In `runLoop.ts`: when `run.grantId` is set, the run's agent `AuthContext` gets `wispGrant: { grantId: run.grantId, grantRevisionId: run.grantRevisionId, sessionId: run.sessionId ?? null }` (w00 A2 — W05 is the run-side populator; w00 A23 — `sessionId` is what W03's `remember` stamps as `source_session_id`, null for a scheduled assessment; W03's `recall` inside an assessment depends on it; test: "a grant run's agentAuth carries wispGrant; a plain run's does not" in `runLoop.grantCeiling.test.ts` or a sibling); `loadRunContext` sets `assessment` by calling Task 7's `loadAssessmentContext(run)` when `isAssessmentProfile(run)` (null otherwise); `resolveRunProfileLimits` adds `if (isAssessmentProfile(run)) return assessmentLimits(limits);`; `resolveRunProfileToolAllowlist` adds the matching arm; the read-only guard list at :1183 gains `|| isAssessmentProfile(run)`; the capture switch appends to `outcome.assessment` lists; `finishRun` dispatches `finalizeAssessment` next to `finalizeTicketTriage`. `buildOutcomeSdkTools` arms use the Zod shapes from Task 2's validators and the descriptions: `record_concern` "Record something Wisp should keep tracking for this org. One subject per call.", `update_concern` "Change severity/summary/evidence of an open concern, or resolve it with an outcome.", `nudge` "Tell the person Wisp works for about one concern with one suggested next step. Respect the eligibility shown in the concerns list.", `propose_action` "Propose a Tier-2/3 tool call for approval. Never executes directly.", `request_specialist` "Not available yet (W07). Calls are recorded and refused."

- [ ] **Step 4: Typecheck and run**

Run: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo EXIT=$?`
Expected: `EXIT=0` (the Task 2 `never` arm is now closed).
Run the step-1 tests plus `src/services/aiAgents/assessmentProfile.test.ts src/services/aiAgents/triageProfile.test.ts src/services/aiAgents/verdictProfile.contract.test.ts src/services/aiAgents/outcomeTools.test.ts src/services/aiAgents/agentCircuit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiAgents/outcomeTools.ts apps/api/src/services/aiAgents/outcomeTools.test.ts apps/api/src/services/aiAgents/runLoopTypes.ts apps/api/src/services/aiAgents/runLoop.ts apps/api/src/services/aiAgents/runnerPrompt.ts apps/api/src/services/aiAgents/runnerPrompt.assessment.test.ts apps/api/src/services/aiAgents/runFinalizers.ts apps/api/src/services/aiAgents/runFinalizers.assessment.test.ts
git commit -m "feat(wisp): assessment outcome tools, prompt, run-loop wiring and finalizer (W05)"
```

---

### Task 7: `services/wisp/assessment.ts` — enqueue, context, rollup

**Files:**
- Create: `apps/api/src/services/wisp/assessment.ts`
- Test: `apps/api/src/services/wisp/assessment.test.ts`, `apps/api/src/services/wisp/assessment.rollup.test.ts`

**Interfaces:**
- Consumes: `createAndEnqueueAgentRun` (`runService.ts:1149`, input gains `grant` in W02); W02 `resolveGrantCeiling`, `GrantInactiveError`; W04 `getOrCreateThread(grantId)`, `updateThreadSummary(threadId, summary)`, `seedContextForSession(threadId, ceiling)`; Task 3 `listConcernsForCeiling`, `recipientState`; Task 4 watch row; Task 5 `chargeableUnderGrant`, `notifyBudgetExhaustedOnce`; tables `alerts`, `tickets` (`schema/portal.ts:170`), `connectionHealthIncidents`, `aiAgentRuns`, `actionIntents`; `sanitizeSweepText` (`runnerPrompt.ts:750`).
- Produces (exact w00 names):
  ```ts
  export type AssessmentReason = { kind: 'event'; eventType: string; eventId: string } | { kind: 'tick' } | { kind: 'watch'; watchId: string };
  export async function enqueueAssessment(input: { grantId: string; orgId: string; reason: AssessmentReason }): Promise<{ runId: string } | { skipped: string }>;
  export async function lastAssessmentWatermark(grantId: string, orgId: string): Promise<Date | null>; // MAX(finished_at) of ai_agent_runs WHERE grant_id, org_id, profile='assessment', status='completed'
  export async function loadAssessmentContext(run: { id; orgId; grantId; grantRevisionId; triggerRef }): Promise<AssessmentRunContext | null>; // null when the grant is no longer active (run then finishes with 'grant_inactive' summary, no model call)
  export async function rollupPartnerPicture(grantId: string): Promise<string>; // deterministic; also calls updateThreadSummary
  export function renderPartnerPicture(input: { generatedAt: Date; orgs: { orgId: string; orgName: string; concerns: Concern[] }[] }): string; // pure; exported for the determinism test
  ```
- `enqueueAssessment` algorithm (one line each, in order): `wispEnabled()` else `{ skipped: 'wisp_disabled' }`; `hasEntitlement(grant.partnerId, 'wisp')` else `{ skipped: 'not_entitled' }` (spec §10 claim-time re-check; W01 service); `resolveGrantCeiling(grantId, grant.currentRevisionId)` — `GrantInactiveError` → `{ skipped: 'grant_inactive' }`; `orgId ∉ ceiling.orgIds` → `{ skipped: 'grant_org_out_of_ceiling' }` (same spelling as W02's admission skip); `chargeableUnderGrant(grantId, ASSESSMENT_BUDGET_CENTS_PER_RUN)` not ok → `notifyBudgetExhaustedOnce(grantId)`, run the **deterministic digest path** (`recordDeterministicDigest`, below) and return `{ skipped: 'budget_exhausted' }`; else `createAndEnqueueAgentRun({ orgId, kind: 'triage', triggerKind: 'schedule', deviceId: null, profile: 'assessment', dedupeKey: \`wisp-assess-${grantId}-${orgId}-${Date.now()}\`, triggerRef: { wisp: { grantId, grantRevisionId: ceiling.revisionId, reason, watermark: (await lastAssessmentWatermark(...))?.toISOString() ?? null } }, grant: { grantId, grantRevisionId: ceiling.revisionId } })` → `{ runId }` or `{ skipped: result.skipped }`. Called with **no ambient DB context** (the #1105 seam documented in `metricAnomalySubscriber.ts`).
- `recordDeterministicDigest(grantId, orgId, reason)`: for an `event` reason whose `eventType` is `alert.triggered` / `integration.health_opened` / `ticket.stale` / `ai.operator.task.finished` with a `failed` outcome, `upsertConcern` a `severity: 'low'` concern on the event's subject with `summary = '<eventType> (recorded while Wisp\'s budget was exhausted)'` and `evidence: { eventId, recordedWithoutModel: true }`; then `deliverInApp` once per UTC day (`dedupeKey: wisp-digest-<grantId>-<utc day>`, `link: \`/ai/wisp/thread/${thread.id}\``, `threadId`, `grantId`; later events in the same day create nothing — the concerns list is the digest). Tick/watch reasons record nothing.
- `loadAssessmentContext`: `ceiling` (null on `GrantInactiveError`), `thread = getOrCreateThread(grantId)`, `threadSummary = seedContextForSession(thread.id, ceiling)` (already untrusted-wrapped memory inside; the prompt wraps the whole block again — double fences are harmless), `openConcerns = listConcernsForCeiling(ceiling, { status: ['open','snoozed'], orgId })` each with the grant's `recipientState`, `changedSince = triggerRef.wisp.watermark ?? now − 24 h`, digest = five bounded reads (`≤ 25` rows each, newest first) under `withSystemDbAccessContext`, every read `WHERE org_id = run.orgId` (the ceiling already admitted this org; the org pin is the second lock).
- `renderPartnerPicture`: header `Wisp picture · <orgs with open concerns>/<orgs in ceiling> orgs · <N high / M medium / K low> · as of <ISO minute>`; then one line per org sorted by (max severity desc, open count desc, orgName asc, orgId asc): `<orgName>: <count> open — <up to 3 summaries, highest severity first, each ≤ 80 chars>`; orgs with zero concerns omitted; truncate to 4 000 chars on a line boundary with `…`. `rollupPartnerPicture` loads org names in one query, calls the renderer, then `updateThreadSummary(thread.id, text)`.

- [ ] **Step 1: Write the failing tests**

`assessment.rollup.test.ts`:
```ts
it('renderPartnerPicture is byte-identical for the same input regardless of input order', …)  // shuffle orgs and concerns
it('sorts orgs by max severity, then open count, then name', …)
it('omits orgs with zero concerns and caps at 4000 chars on a line boundary', …)
it('header counts match the body', …)
```
`assessment.test.ts` (mock runService, grantAuthority, threads, budget, concerns):
```ts
it('returns wisp_disabled without touching the DB when the flag is off', …)
it('returns not_entitled when hasEntitlement(partnerId, "wisp") is false and never resolves the ceiling', …)
it('returns grant_inactive on GrantInactiveError and never calls createAndEnqueueAgentRun', …)
it('returns grant_org_out_of_ceiling for an org not in ceiling.orgIds', …)
it('budget exhausted: notifies once, records a deterministic concern for alert.triggered, returns budget_exhausted, admits nothing', …)
it('happy path passes grant, profile assessment, kind triage, triggerKind schedule and the watermark in triggerRef', …)
it('loadAssessmentContext returns null when the grant is inactive', …)
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/wisp/assessment`
Expected: FAIL — module not found (check the reported file count is 2).

- [ ] **Step 3: Implement `assessment.ts`**

- [ ] **Step 4: Run tests**

Run: `cd apps/api && npx vitest run src/services/wisp/assessment`
Expected: PASS (2 files).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/wisp/assessment.ts apps/api/src/services/wisp/assessment.test.ts apps/api/src/services/wisp/assessment.rollup.test.ts
git commit -m "feat(wisp): per-org assessment admission, bounded context, deterministic partner rollup (W05)"
```

---

### Task 8: Event-bus additions and emitters

**Files:**
- Modify: `apps/api/src/services/eventBus.ts` — `EventType` union (append after `'notification.created'`, :225) and `EVENT_TYPES` (:596-735)
- Modify: `apps/api/src/services/actionIntents/intentService.ts:3265-3317` (`transitionIntent`)
- Modify: `apps/api/src/services/aiOperator/taskCoordinator.ts:388-453` (`settle`)
- Create: `apps/api/src/services/wisp/pollers.ts`
- Test: `apps/api/src/services/eventBus.wisp.test.ts`, `apps/api/src/services/actionIntents/intentService.decidedEvent.test.ts`, `apps/api/src/services/aiOperator/taskCoordinator.finishedEvent.test.ts`, `apps/api/src/services/wisp/pollers.test.ts`

**Interfaces:**
- Produces (`EVENT_TYPES`):
  ```ts
  AI_INTENT_DECIDED: 'ai.intent.decided' as const,            // payload { intentId, orgId, toolName, decision: 'approved'|'rejected'|'expired'|'cancelled', requestingAgentRunId: string|null, grantId: string|null }
  AI_OPERATOR_TASK_FINISHED: 'ai.operator.task.finished' as const, // payload { taskId, orgId, state: 'completed'|'partial'|'handed_off'|'failed', outcome, grantId: string|null }
  TICKET_STALE: 'ticket.stale' as const,                       // payload { ticketId, orgId, staleHours, updatedAt } ; eventId `ticket-stale:${ticketId}:${staleHours}`
  ```
  `'ai.agent.run.completed'` already exists (`eventBus.ts:594`, published by `runLoop.ts:3319`) — nothing to add.
- **Connection health — conflict, decided:** w00 and spec §7.1 ask for a new `connection_health.incident.opened`, but the module already publishes `integration.health_opened` from a durable outbox (`services/connectionHealth/events.ts:73`, `eventPayload.ts:9-12`, merged in the 2026-10-15 connection-health W5). A second event for the same transition would double every webhook subscriber's delivery. **W05 subscribes to the existing `integration.health_opened` and adds no new type.** The orchestrator doc's name list should be corrected (see "Calls made by the planner").
- `transitionIntent`: extend `.returning(...)` with `orgId`, `toolName`, `requestingAgentRunId`; `grantId` in the payload is `ai_agent_runs.grant_id` of `requestingAgentRunId` (one extra select inside the same system block; null when the intent has no requesting run — W02 adds no column to `action_intents`; the grant is reachable through the run that minted the intent, which is how "stamped on every intent" is satisfied). After the `withSystemDbAccessContext` block returns a row **and** `to ∈ {'approved','rejected','expired','cancelled'}`, `void publishEvent('ai.intent.decided', row.orgId, payload, 'action-intents').catch(log)` — outside the DB context, never awaited inside it (#1105). Transitions to `executing`/`completed`/`failed` publish nothing (not decisions).
- `settle`: after `committed === true`, `void publishEvent('ai.operator.task.finished', task.orgId, { taskId, orgId, state: nextTaskState(task.state, event), outcome, grantId: task.grantId ?? null }, 'ai-operator').catch(log)`.
- `pollers.ts`:
  ```ts
  export const TICKET_STALE_DEFAULT_HOURS = 72;
  export const TICKET_STALE_SCAN_WINDOW_MINUTES = 5;  // == the wake tick interval
  export async function pollStaleTickets(now: Date, opts?: { staleHours?: number; windowMinutes?: number; limit?: number }): Promise<{ scanned: number; published: number }>;
  ```
  Sliding window, stateless: `SELECT id, org_id, updated_at FROM tickets WHERE status IN ('new','open','pending') AND updated_at > now − stale − window AND updated_at <= now − stale LIMIT 500` under system ctx, then `publishEvent('ticket.stale', orgId, payload, 'wisp-pollers', { eventId, occurredAt: updatedAt + stale })` per row. A ticket crosses the threshold exactly once; a restart longer than the window misses the crossing, which the floor tick covers (documented in the header). Only orgs with an active grant are scanned: join `wisp_grants` (`status='active'`, `partner_id = organizations.partner_id`, `org_id IS NULL OR org_id = tickets.org_id`) so a partner without Wisp never pays the scan.

- [ ] **Step 1: Write the failing tests**

`eventBus.wisp.test.ts`: the three literals are in `EVENT_TYPES`, are assignable to `EventType`, and `Object.values(EVENT_TYPES)` has no duplicates. Do **not** assert `EVENT_TYPE_RE` (`routes/eventWs.ts:27` — a WS-client subscription pattern limited to two segments; `ai.agent.run.completed` already has four, and these events are consumed by durable subscribers, not WS clients).
`intentService.decidedEvent.test.ts` (mock `../eventBus`): `transitionIntent(id, 'pending_approval', 'approved')` publishes once with `decision: 'approved'`; `→ 'executing'` publishes nothing; a CAS miss (`rows.length === 0`) publishes nothing; `publishEvent` rejecting does not reject `transitionIntent`.
`taskCoordinator.finishedEvent.test.ts`: drive `__testOnly.settle` exactly as `taskCoordinatorGraph.test.ts:136-160` does; `committed` true publishes `ai.operator.task.finished` with `state: 'failed'` for `event: 'fail'` and `state: 'completed'` for `event: 'complete'`; a lost lease CAS (`committed` false) publishes nothing.
`pollers.test.ts`: window arithmetic — a ticket updated exactly `stale` hours ago is included, `stale + window + 1 min` ago is not, `stale − 1 min` is not; `eventId` is `ticket-stale:<id>:72`; an org without an active grant is not scanned (assert the SQL/mocked join).

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/eventBus.wisp.test.ts src/services/actionIntents/intentService.decidedEvent.test.ts src/services/aiOperator/taskCoordinator.finishedEvent.test.ts src/services/wisp/pollers.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the new tests and the neighbours**

Run: the step-2 command plus `src/services/eventBus.test.ts src/services/actionIntents/intentService.test.ts src/services/aiOperator/taskCoordinatorGraph.test.ts src/services/aiOperator/taskCoordinatorLimits.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/eventBus.ts apps/api/src/services/eventBus.wisp.test.ts apps/api/src/services/actionIntents/intentService.ts apps/api/src/services/actionIntents/intentService.decidedEvent.test.ts apps/api/src/services/aiOperator/taskCoordinator.ts apps/api/src/services/aiOperator/taskCoordinator.finishedEvent.test.ts apps/api/src/services/wisp/pollers.ts apps/api/src/services/wisp/pollers.test.ts
git commit -m "feat(wisp): ai.intent.decided, ai.operator.task.finished and ticket.stale bus events (W05)"
```

---

### Task 9: Wake-up coordinator — subscriber, debounce, floor tick round-robin, watch cadence

**Files:**
- Create: `apps/api/src/services/wisp/wake.ts`
- Create: `apps/api/src/jobs/wispWakeScheduler.ts`
- Modify: `apps/api/src/services/eventSubscribers.ts` (new `registerEventSubscriber`), `apps/api/src/services/eventSubscriberIds.ts` (`'wisp-wake'` after `'webhook-delivery'`)
- Modify: `apps/api/src/services/workerRegistry.ts` (entry after `aiAgentSweepScheduler`, :1694-1700, `placement: 'global'`)
- Test: `apps/api/src/services/wisp/wake.test.ts`, `apps/api/src/jobs/wispWakeScheduler.test.ts`

**Interfaces:**
- Consumes: Task 7 `enqueueAssessment`; Task 4 `claimDueWatches`, `stopWatchesForInactiveGrants`; Task 8 `pollStaleTickets`; W02 grant rows (`status`, `floor_tick_minutes`, `partner_id`, `org_id`, `last_floor_tick_at`), `resolveGrantCeiling`; `loadPartnerOrgIds` pattern (`aiAgentSweepScheduler.ts:494-516` — copy, do not import: `SWEEPABLE_ORG_STATUSES = ['active','trial']` is module-private at :462; `notHoldingOrgCondition()` comes from `services/unassignedPool/selectorPredicate`; plus `type <> 'quick_support'`, `deleted_at IS NULL`); `getBullMQConnection` (`services/redis`), `attachWorkerObservability` (`jobs/workerObservability`).
- Produces:
  ```ts
  // wake.ts
  export const WISP_WAKE_QUEUE = 'wisp-wake';
  export const WISP_WAKE_DEBOUNCE_MS = 60_000;
  export const WISP_WAKE_TICK_INTERVAL_MS = 5 * 60 * 1000;   // literal here — scheduleRegistry.contract.test.ts reads `repeat: { every }` statically
  export function wakeJobId(grantId: string, orgId: string): string; // `wisp-assess-${grantId}-${orgId}` (no ':' — BullMQ reserves it)
  export async function requestAssessment(input: { grantId: string; orgId: string; reason: AssessmentReason }): Promise<'queued' | 'coalesced'>;
  export function pickRoundRobinOrg(candidates: { orgId: string; lastAssessedAt: Date | null }[]): string | null; // pure
  export async function grantsForEvent(event: BreezeEvent): Promise<{ grantId: string; orgId: string }[]>; // active grants whose partner owns event.orgId and (org_id IS NULL OR org_id = event.orgId)
  export async function handleWispWakeEvent(event: BreezeEvent): Promise<void>; // the subscriber body
  // wispWakeScheduler.ts
  export async function processWakeTick(now?: Date): Promise<{ grantsTicked: number; watchesFired: number; staleTicketsPublished: number; watchesStopped: number }>;
  export async function processAssessJob(data: { grantId: string; orgId: string; reason: AssessmentReason }): Promise<void>;
  export async function initializeWispWakeScheduler(): Promise<void>;
  export async function shutdownWispWakeScheduler(): Promise<void>;
  ```
- Subscriber: `id: 'wisp-wake'`, `eventTypes: ['alert.triggered', 'alert.resolved', 'ticket.sla_breached', 'ticket.stale', 'ticket.status_changed', 'monitoring.check_failed', 'integration.health_opened', 'anomaly.incident_opened', 'vulnerability.critical_detected', 'edr.detection_detected', 'ai.agent.run.completed', 'ai.agent.run.failed', 'ai.operator.task.finished', 'ai.intent.decided']`, lazy `import('./wisp/wake')` in the handler (the `workerEntrypointClosure` reason documented at `eventSubscribers.ts:60-70`), `retry: { attempts: 3, backoffMs: 30_000 }`. The handler returns immediately when `!wispEnabled()`. For `ai.agent.run.*` it ignores runs whose `profile === 'assessment'` (no self-wake).

**Debounce (the only algorithm the signatures do not determine):**

```ts
export async function requestAssessment({ grantId, orgId, reason }) {
  const queue = getWispWakeQueue();
  const jobId = wakeJobId(grantId, orgId);
  // BullMQ silently no-ops `add` when a job with this id already exists (waiting,
  // delayed or active) — the same property aiAgentSweepScheduler.ts relies on for
  // occurrence single-flight. One delayed job per (grant, org) IS the 60 s window:
  // every wake inside it collapses onto the first; the reason stored is the first
  // reason, which is fine because the assessment reads "everything since the
  // watermark", not the reason.
  const job = await queue.add('assess', { grantId, orgId, reason }, {
    jobId, delay: WISP_WAKE_DEBOUNCE_MS,
    removeOnComplete: { count: 100 }, removeOnFail: { count: 100 },
  });
  const state = await job.getState();           // 'delayed' when we created it just now
  return job.timestamp >= Date.now() - 1_000 && state === 'delayed' ? 'queued' : 'coalesced';
}
```

**Floor tick round-robin (inside `processWakeTick`, per due grant):**

```ts
// due: status = 'active' AND (last_floor_tick_at IS NULL OR last_floor_tick_at <= now − floor_tick_minutes)
// claim: UPDATE wisp_grants SET last_floor_tick_at = now WHERE id = $1 AND (last_floor_tick_at IS NULL OR last_floor_tick_at = $prev)  → one replica wins
// candidates: ceiling.orgIds ∩ loadPartnerOrgIds(partnerId), each with lastAssessedAt = MAX(finished_at) of completed assessment runs for (grant, org)
// pickRoundRobinOrg: never-assessed first (ordered by orgId asc), else the oldest lastAssessedAt, ties by orgId asc
// then requestAssessment({ grantId, orgId: picked, reason: { kind: 'tick' } }) — ONE org per grant per tick, so a quiet partner is charged once per floor tick, not N×
```

Also per tick, in order: **`reconcileEntitlements(now)`** (spec §10: for every `active` grant whose partner fails `hasEntitlement(partnerId, 'wisp')` → `pauseGrant(id, 'entitlement_lost')`; for every `paused` grant with `paused_reason = 'entitlement_lost'` whose partner is entitled again → `resumeGrant(id)`; one `getEntitlements` per distinct partner per tick — W02's reconciler deliberately leaves this reason alone because W02 cannot import W01); `stopWatchesForInactiveGrants(now)`; `claimDueWatches(now, 200)` → `requestAssessment({ grantId: w.grantId, orgId: w.orgId ?? pickRoundRobinOrg(ceiling orgs), reason: { kind: 'watch', watchId } })`; `pollStaleTickets(now)`. Every section is try/caught separately with a `console.error` naming the section; a failing section never stops the next one. `processAssessJob` calls `enqueueAssessment` and logs the skip reason at `info`. Also set W07's `setWispGrantsActive(count)` gauge here once W07 lands (W07 Task 8 adds the call).

Worker lifecycle mirrors `initializeAiAgentSweepScheduler` (:808): remove any existing `tick` repeatable, add `{ jobId: 'wisp-wake-tick', repeat: { every: WISP_WAKE_TICK_INTERVAL_MS } }`, `concurrency: 4`. `initialize` is unconditional (registry-driven); the tick itself returns `{0,0,0,0}` when `!wispEnabled()`.

- [ ] **Step 1: Write the failing tests**

`wake.test.ts`:
```ts
describe('pickRoundRobinOrg', () => {
  it('returns null for no candidates', …);
  it('prefers never-assessed orgs, lowest orgId first', …);
  it('otherwise returns the oldest lastAssessedAt; ties by orgId', …);
  it('is deterministic under input shuffling', …);
});
describe('requestAssessment', () => {
  it('coalesces N wake requests inside 60 s into one delayed job with id wisp-assess-<grant>-<org>', …); // mocked Queue.add records calls; second call returns 'coalesced'
  it('a new request after the job completed creates a new job', …);
});
describe('handleWispWakeEvent', () => {
  it('returns without DB access when wispEnabled() is false', …);
  it('fans one request per active grant covering the event org; a paused grant gets none', …);
  it('ignores ai.agent.run.completed for profile assessment', …);
});
```
`wispWakeScheduler.test.ts`:
```ts
it('tick does nothing when the flag is off', …);
it('ticks only grants whose last_floor_tick_at is older than floor_tick_minutes and claims with a CAS', …);
it('one assessment request per due grant per tick (not per org)', …);
it('a due watch requests an assessment with reason watch and advances next_due_at', …);
it('stops watches of a paused grant and notifies once', …);   // Review Focus 1
it('pauses an active grant with entitlement_lost when the partner lost the wisp entitlement, and resumes a paused/entitlement_lost grant when it is back; never touches paused/grantor_suspended', …);
it('a throwing section does not prevent the later sections', …);
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/wisp/wake.test.ts src/jobs/wispWakeScheduler.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `wake.ts`, `wispWakeScheduler.ts`, the subscriber and registry entries**

- [ ] **Step 4: Run tests and the registry contracts**

Run: `cd apps/api && npx vitest run src/services/wisp/wake.test.ts src/jobs/wispWakeScheduler.test.ts src/jobs/scheduleRegistry.contract.test.ts src/services/eventSubscriberRegistry.test.ts src/services/workerRegistry.test.ts src/services/workerEntrypointClosure.contract.test.ts`
Expected: PASS. If `workerEntrypointClosure.contract.test.ts` reports the new entry's closure reaching `routes/agentWs.ts`, switch the dynamic import boundary (lazy-import `./assessment` from the job processor) rather than changing placement.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/wisp/wake.ts apps/api/src/services/wisp/wake.test.ts apps/api/src/jobs/wispWakeScheduler.ts apps/api/src/jobs/wispWakeScheduler.test.ts apps/api/src/services/eventSubscribers.ts apps/api/src/services/eventSubscriberIds.ts apps/api/src/services/workerRegistry.ts
git commit -m "feat(wisp): wake coordinator — event subscriber, 60 s per-org debounce, floor-tick round-robin, watch cadence (W05)"
```

---

### Task 10: Concern retention reaper and `concern_outcome` memory retention

**Files:**
- Create: `apps/api/src/jobs/wispConcernRetention.ts`
- Modify: `apps/api/src/jobs/scheduleRegistry.ts:78+` (`'wisp-concern-retention': '23 21 * * *'` — hour 21 holds only `sending-domains-daily` at `:3`; daily tier, minute ≡ 3 mod 5)
- Modify: `apps/api/src/services/workerRegistry.ts` (entry after `metricAnomalyIncidentRetention`, :564-575, `placement: 'global'`)
- Modify: `apps/api/src/services/wisp/concerns.ts` (`reapConcerns` body from Task 3)
- Test: `apps/api/src/jobs/wispConcernRetention.test.ts`, `apps/api/src/services/wisp/concerns.reaper.test.ts`

**Interfaces:**
- Consumes: Task 3 `reapConcerns`, `resolveConcern`; W03 table `aiMemoryBlocks` (Drizzle export name per W03; `block_type`, `created_at`).
- Produces:
  ```ts
  export const WISP_CONCERN_RESOLVED_RETENTION_DAYS = 90;
  export const WISP_CONCERN_OUTCOME_MEMORY_RETENTION_DAYS = 180;  // w00 Memory block: "concern_outcome 180 days (reaper in W05)"
  export async function runWispConcernRetention(now?: Date): Promise<{ concernsDeleted: number; subjectGone: number; memoryBlocksDeleted: number }>;
  export async function initializeWispConcernRetention(): Promise<void>;
  export async function shutdownWispConcernRetention(): Promise<void>;
  ```
- `reapConcerns` does three batched passes (batch 500, max 20 batches, pattern `metricAnomalyIncidentRetention.ts`): (1) delete `resolved`/`dismissed` rows with `updated_at < now − 90 d`; (2) **subject reconciliation** — for live concerns, one `NOT EXISTS` query per `subject_kind` against its table (`tickets`, `devices`, `alerts`, `organizations`, `connection_health_incidents` for `integration`, `ai_agent_runs`, `ai_operator_tasks`), each additionally pinned `AND <table>.org_id = wisp_concerns.org_id` (a subject that moved org counts as gone); matches → `resolveConcern(id, {}, 'subject_gone')` (no memory block: nothing was learned); (3) delete `ai_memory_blocks WHERE block_type = 'concern_outcome' AND created_at < now − 180 d` directly under system context (W03 ships `ai_memory_blocks_concern_outcome_created_idx (created_at) WHERE block_type = 'concern_outcome'` for exactly this scan) — if W03's broker contract test (`memoryBroker.callers.contract.test.ts` or equivalent) flags this file, add `jobs/wispConcernRetention.ts` to its allowlist with the comment "retention delete, not an agent-side write".

- [ ] **Step 1: Write the failing tests**

`concerns.reaper.test.ts`: a resolved concern 91 days old is deleted, 89 days is kept; a live concern whose ticket row is gone is resolved with `subject_gone` (Review Focus 3); a concern whose ticket moved to another org is resolved with `subject_gone`; memory blocks of type `concern_outcome` older than 180 days are deleted, `fact` blocks are not.
`wispConcernRetention.test.ts`: registers `repeat: { pattern: jobSchedule('wisp-concern-retention') }` and removes existing repeatables first; a throwing pass is logged and the others still run.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/jobs/wispConcernRetention.test.ts src/services/wisp/concerns.reaper.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run tests**

Run: `cd apps/api && npx vitest run src/jobs/wispConcernRetention.test.ts src/services/wisp/concerns.reaper.test.ts src/jobs/scheduleRegistry.contract.test.ts src/services/workerRegistry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/wispConcernRetention.ts apps/api/src/jobs/wispConcernRetention.test.ts apps/api/src/jobs/scheduleRegistry.ts apps/api/src/services/workerRegistry.ts apps/api/src/services/wisp/concerns.ts apps/api/src/services/wisp/concerns.reaper.test.ts
git commit -m "feat(wisp): concern retention reaper with subject reconciliation and concern_outcome memory retention (W05)"
```

---

### Task 11: API routes — concerns and watches

**Files:**
- Create: `apps/api/src/routes/wispConcerns.ts`, `apps/api/src/routes/wispWatches.ts`
- Modify: `apps/api/src/routes/wisp.ts` (W02's hub, single file) — after its existing middleware chain add `wispRoutes.route('/concerns', wispConcernsRoutes)` and `wispRoutes.route('/watches', wispWatchesRoutes)` so the sub-routers inherit the flag gate, `requireScope('partner')` and `requirePermission('ai_sessions','use')`
- Test: `apps/api/src/routes/wispConcerns.test.ts`, `apps/api/src/routes/wispWatches.test.ts`

**Interfaces:**
- Consumes: the hub's inherited middleware (W02: `authMiddleware` → 404 when `!wispEnabled()` → `requireScope('partner')` → `requirePermission('ai_sessions','use')`; W04 adds `requireEntitlement('wisp')` on the same hub); `requirePermission` (`middleware/auth.ts:1002`) for the extra write gate; `zValidator` (`lib/validation`); W02 `getActiveGrantForUser(userId, scope)` / `WispGrantDto` lookups, `resolveGrantCeiling`; Tasks 3–4 services; `runOutsideDbContext` for the service calls (they open system contexts internally).
- Produces (all under `/api/v1/wisp`):
  - `GET /concerns?grantId&status=open,snoozed&orgId` → `{ concerns: Concern[] }` — the grant must belong to `auth.user.id`, or `canManagePartnerWidePolicies(auth)` (partner-admin read of another tech's grant, w00 A1); otherwise 404 (non-enumerating, as W02's `org_out_of_reach`).
  - `POST /concerns/:id/snooze { grantId, until }` → `snoozeConcern(id, { grantId, userId }, until)` + `markAnswered`; grant ownership required (a snooze is personal state).
  - `POST /concerns/:id/dismiss { grantId }` → `dismissConcern` + `markAnswered`; grant ownership required.
  - `POST /concerns/:id/resolve { grantId, outcome }` → `resolveConcern(id, { userId }, outcome)` + `markAnswered`; grant ownership required and the concern's org must be inside that grant's ceiling (any grant holder covering the org may resolve the shared fact — spec §7.3 "two techs … share it").
  - `GET /watches?grantId` → `{ watches: Watch[] }`; `POST /watches { grantId, orgId, kind, params, cadenceMinutes }` → `createWatch(ceiling, …)` 201; `DELETE /watches/:id` → 204 / 404. Create/delete: grant ownership (a watch is "a standing check a user asked for", spec §7.2; owner = grantor).
  - Every route resolves `ceiling = resolveGrantCeiling(grant.id, grant.currentRevisionId)` and answers 409 `{ error, code: 'grant_inactive' }` on `GrantInactiveError` (coded `c.json`, W02's error-shape convention); a concern whose `org_id ∉ ceiling.orgIds` is 404.
- Permissions (w00 A1): every route gates on `ai_sessions:use` (inherited from the hub) plus grant ownership; the only partner-admin branch (`GET /concerns` for another tech's grant) keys on `canManagePartnerWidePolicies`. No `ai_agents:*` gate is added.

- [ ] **Step 1: Write the failing route tests**

Pattern: `routes/wisp.test.ts` (W02) and `routes/aiOperatorTasks.test.ts:44-52` (auth fixture). Mount the sub-router under a test copy of the hub chain so the inherited gates are exercised. Cases: `GET /concerns` 404 when the flag is off; 403 without `ai_sessions:use`; a user asking for another user's grant without `canManagePartnerWidePolicies` → 404, with it → 200; `POST /concerns/:id/snooze` with `until` 31 days ahead → 400; a body without `grantId` → 400; snooze on a concern outside the ceiling → 404; resolve by a non-owner of the grant → 404; `POST /watches` with `cadenceMinutes: 14` → 400; `POST /watches` on a paused grant → 409 `grant_inactive`; `DELETE /watches/:id` for another grant's watch → 404.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/routes/wispConcerns.test.ts src/routes/wispWatches.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the two route files and mount them on the hub**

- [ ] **Step 4: Run tests**

Run: `cd apps/api && npx vitest run src/routes/wisp` (substring match — it also picks up W02's hub test, W03's `routes/wisp/memory.test.ts` and W04's `wispThreads.test.ts`; check the reported file count rather than assuming 3; a route-registry contract test, if `ls src/routes/*.contract.test.ts` shows one, must list the new paths)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/wisp.ts apps/api/src/routes/wispConcerns.ts apps/api/src/routes/wispConcerns.test.ts apps/api/src/routes/wispWatches.ts apps/api/src/routes/wispWatches.test.ts
git commit -m "feat(wisp): concerns and watches routes under /api/v1/wisp (W05)"
```

---

### Task 11b: Chat tools — `list_concerns`, `raise_concern`, `snooze_concern`, `resolve_concern`, `create_watch` (spec §7.4 reply-in-thread, §6.1 (4), §14 tool list; w00 A25)

**Files:**
- Create: `apps/api/src/services/wisp/concernTools.ts` (pattern: W03's `services/wisp/memoryTools.ts` / `registerWispMemoryTools`)
- Modify: `apps/api/src/services/aiTools.ts` (call `registerWispConcernTools(aiTools)` beside `registerWispMemoryTools`), `apps/api/src/services/aiAgentSdkTools.ts` (`TOOL_TIERS` :191 block; MCP `tool()` in `createBreezeMcpServer`; `SESSION_TOOL_DESCRIPTIONS` if W03 found it necessary), `apps/api/src/services/aiToolSchemas.ts`, `apps/api/src/services/aiGuardrails.ts` (`TOOL_PERMISSIONS`), `apps/api/src/services/aiAgents/agentToolCatalog.ts` (`TOOL_CAPABILITY`), `apps/api/src/services/aiToolRateLimits.ts`; `packages/shared/src/validators/wispConcerns.ts` (`raiseConcernChatSchema`, Task 2)
- Test: `apps/api/src/services/wisp/concernTools.test.ts`

**Interfaces:**
- Consumes: `AuthContext.wispGrant` (W03 type; populated by W04 on chat turns and by Task 6 on assessment runs); W02 `resolveGrantCeiling`, `assertWithinCeiling`, `GrantInactiveError`, `CeilingViolationError`; Task 3 `listConcernsForCeiling`, `upsertConcern`, `snoozeConcern`, `resolveConcern`, `markAnswered`; Task 4 `createWatch`; W03's `wisp_grant_required` / `grant_inactive` / `ceiling_violation` error-string conventions.
- Produces: `registerWispConcernTools(aiTools: Map<string, AiTool>): void`; **five** tools, all six registries (model-callable), `TOOL_PERMISSIONS` `{ resource: 'ai_sessions', action: 'use' }` (w00 A1), `TOOL_CAPABILITY` `'tenancy'` as W03 chose for its tools, `domain: 'ai'`, `deviceArgs: []`:
  - `list_concerns` (T1): `{ status?: ConcernStatus[]; orgId?: uuid }` → the concerns the grant's ceiling covers, one line each `id | severity | status | subject | summary | quiet until`, or `No concerns on Wisp's radar.`
  - `raise_concern` (T2, auto-approvable — same posture as W03's `remember`: a Tier-2 registry entry, no approval card, rate limit `{ limit: 20, windowSeconds: 300 }`; w00 A25, spec §6.1 (4) "pending items from conversation"): input `raiseConcernChatSchema` = `{ orgId: uuid; subject: { kind: 'org' | 'ticket'; id: uuid }; summary ≤ 2000; severity: ConcernSeverity; evidence?: object }` → `assertWithinCeiling(ceiling, { orgId })` then `upsertConcern({ partnerId: ceiling.partnerId, orgId, subject, summary, severity, evidence: evidence ?? {}, raisedByGrantId: grantId })` → `Concern raised (ID: <id>).` or, when `created: false`, `Already on Wisp's radar (ID: <id>) — use update via resolve_concern/snooze_concern.` A `subject.kind` of `org` must have `subject.id === orgId` (else `{"error":"subject_org_mismatch"}`); a `ticket` subject is verified to belong to `orgId` with one select under system context (else `{"error":"subject_not_in_org"}`) — the same `concern_not_in_org` discipline the finalizer applies. Other subject kinds stay run-only (schema rejects them). Description: "Note a loose end for this customer that Wisp should keep tracking and remind you about — something you are waiting on, or a ticket to revisit. Subject is the org or one of its tickets."
  - `snooze_concern` (T2): `{ concernId: uuid; until: ISO datetime ≤ 30 d }` → `snoozeConcern(id, { grantId, userId: ceiling.grantorUserId }, until)` + `markAnswered`.
  - `resolve_concern` (T2): `{ concernId: uuid; outcome: string ≤ 1000 }` → `resolveConcern(id, { grantId }, outcome)` + `markAnswered` — the `grantId` form writes the `concern_outcome` memory block through W03's broker (spec §7.4 "records the answer as memory where appropriate").
  - `create_watch` (T2, rate limit `{ limit: 10, windowSeconds: 3600 }`): `{ orgId: uuid | null; kind: WatchKind; params: object; cadenceMinutes: int 15..10080 }` → `createWatch(ceiling, …)`.
  - Every handler: `auth.wispGrant` absent → `{"error":"wisp_grant_required"}`; `GrantInactiveError` → `{"error":"grant_inactive"}`; `CeilingViolationError` → `{"error":"ceiling_violation","code":<code>}` (W03's exact strings). Under an assessment run only `list_concerns` is in `ASSESSMENT_TOOL_ALLOWLIST` (the T2 four stay chat-only; assessments change concerns through the `record_concern`/`update_concern` outcome tools — and `raise_concern` **must not** be exposed to a run, or the registry/extra name split in Task 6 is moot). An `ai_agent` principal reaching `raise_concern` from chat (a specialist run that inherited the chat server) has no `auth.wispGrant` unless Task 6 stamped one, and without it the tool refuses before any read.

- [ ] **Step 1: Write the failing tests** (mock `./concerns`, `./watches`, `./grantAuthority`):

```ts
it('registers the five tools in aiTools; list_concerns is tier 1, the other four tier 2; all five map to ai_sessions:use', …);
it('every tool returns {"error":"wisp_grant_required"} without auth.wispGrant and calls nothing', …);
it('raise_concern: an ai_agent principal (principal.kind === "ai_agent") without auth.wispGrant gets {"error":"wisp_grant_required"} and upsertConcern is never called', …);   // w00 A25 — the agent-without-grant case, pinned separately from the user_session case above
it('raise_concern asserts orgId is inside the ceiling (CeilingViolationError → {"error":"ceiling_violation","code":"org"}, no upsert), then calls upsertConcern with partnerId = ceiling.partnerId and raisedByGrantId = grantId; created:false renders the "already on radar" line', …);
it('raise_concern rejects subject.kind device/alert/integration/run/task at the schema, subject_org_mismatch when kind=org and id ≠ orgId, and subject_not_in_org for a ticket from another org', …);
it('raise_concern is not in ASSESSMENT_TOOL_ALLOWLIST and no OUTCOME_TOOL_NAMES entry equals a TOOL_TIERS key', …);
it('list_concerns resolves the ceiling from auth.wispGrant and calls listConcernsForCeiling(ceiling, { status, orgId })', …);
it('snooze_concern calls snoozeConcern with the grant + grantor and then markAnswered; a until 31 days ahead is rejected by the schema', …);
it('resolve_concern calls resolveConcern(id, { grantId }, outcome) (memory-writing form) then markAnswered', …);
it('create_watch surfaces CeilingViolationError as {"error":"ceiling_violation","code":"org"}', …);
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/wisp/concernTools.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `concernTools.ts` and the six registry entries** (five tools each; `raise_concern` in `TOOL_RATE_LIMITS` at `{ limit: 20, windowSeconds: 300 }`).

- [ ] **Step 4: Run the tool test and the registry contracts**

Run: `cd apps/api && npx vitest run src/services/wisp/concernTools.test.ts src/services/aiAgentSdkTools.registryParity.contract.test.ts src/services/aiGuardrails.readonly.contract.test.ts src/services/aiGuardrails.agentPrincipal.contract.test.ts src/services/aiToolSchemas.validateToolInput.test.ts src/__tests__/mcp-coverage.test.ts src/services/aiAgents/assessmentProfile.test.ts src/services/aiAgents/outcomeTools.test.ts`
Expected: PASS (add the five names to `mcpCoverage.ts` under `'wisp/concerns.ts'` if `mcp-coverage` demands it; if `agentPrincipal.contract.test.ts` wants every chat-server tool classified, `raise_concern` is a Tier-2 write an agent principal reaches only with a stamped `wispGrant` — list it where `remember` landed in W03).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/wisp/concernTools.ts apps/api/src/services/wisp/concernTools.test.ts apps/api/src/services/aiTools.ts apps/api/src/services/aiAgentSdkTools.ts apps/api/src/services/aiToolSchemas.ts apps/api/src/services/aiGuardrails.ts apps/api/src/services/aiAgents/agentToolCatalog.ts apps/api/src/services/aiToolRateLimits.ts apps/api/src/services/mcpCoverage.ts packages/shared/src/validators/wispConcerns.ts packages/shared/src/validators/wispConcerns.test.ts
git commit -m "feat(wisp): list/raise/snooze/resolve concern and create_watch chat tools under the grant ceiling (W05)"
```

---

### Task 12: Web — concerns list in the thread view

**Files:**
- Create: `apps/web/src/lib/wispConcernsApi.ts`, `apps/web/src/components/ai/WispConcernsPanel.tsx`
- Modify: `apps/web/src/components/ai/AiChatSidebar.tsx` — where W04 renders `<WispThreadHeader wisp={wisp} …/>` (W04 Task 8), render `<WispConcernsPanel grantId={wisp.grantId} threadId={wisp.threadId} />` directly beneath it, inside the same `wisp`-set branch
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts:35` (`TARGET_GLOBS` += `WispConcernsPanel.tsx`, `wispConcernsApi.ts` — W04 extended the same list for its files)
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/ai.json` (new `wispConcerns.*` keys — English in `en`, translated in the other seven)
- Test: `apps/web/src/components/ai/WispConcernsPanel.test.tsx`, `apps/web/src/lib/wispConcernsApi.test.ts`

**Interfaces:**
- Consumes: `fetchWithAuth` (`apps/web/src/stores/auth.ts:1335`), `runAction` / `ActionError` (`apps/web/src/lib/runAction.ts:91`), `useTranslation('ai')`, shared `Concern`/`ConcernStatus` types; `window.location.hash` `#concern=<id>` (w00 deep link) selects/expands a concern — hash, not query params (CLAUDE.md "URL State in Components").
- Produces:
  ```ts
  // wispConcernsApi.ts
  export async function listWispConcerns(grantId: string, status?: ConcernStatus[]): Promise<Concern[]>;
  export function snoozeWispConcern(id: string, grantId: string, until: Date): Promise<void>;   // runAction, successMessage t('wispConcerns.snoozed')
  export function dismissWispConcern(id: string, grantId: string): Promise<void>;
  export function resolveWispConcern(id: string, grantId: string, outcome: string): Promise<void>;
  // WispConcernsPanel.tsx
  export function WispConcernsPanel(props: { grantId: string; threadId: string }): JSX.Element;
  ```
- UI: grouped by severity (high → info), each row `data-testid="wisp-concern-row"` with subject chip, summary, age, nudge state ("quiet until …", "digest only"); actions Snooze (1 h / until tomorrow 09:00 local / 7 days), Dismiss, Resolve (inline outcome input ≤ 1000). Filter toggle open+snoozed / all. Empty state `t('wispConcerns.empty')`. Caller catch pattern from CLAUDE.md: `if (err instanceof ActionError && err.status === 401) return; if (!(err instanceof ActionError)) showToast(...)`.
- Locale keys (en): `wispConcerns.title: "Concerns"`, `.empty: "Nothing on Wisp's radar right now."`, `.snooze: "Snooze"`, `.snoozeOneHour`, `.snoozeTomorrow`, `.snoozeWeek`, `.dismiss`, `.resolve`, `.resolveOutcomePlaceholder: "What happened?"`, `.snoozed: "Snoozed"`, `.dismissed: "Dismissed"`, `.resolved: "Resolved"`, `.quietUntil: "quiet until {{when}}"`, `.digestOnly: "digest only"`, `.showAll`, `.showLive`, `.loadFailed: "Couldn't load concerns"`.

- [ ] **Step 1: Write the failing tests**

`WispConcernsPanel.test.tsx` (jsdom, mocked api module): renders rows grouped by severity; `#concern=<id>` expands that row; Snooze calls `snoozeWispConcern` with a `Date` one hour ahead and refetches; a 401 `ActionError` from dismiss produces no extra toast; the empty state renders with no rows. `wispConcernsApi.test.ts`: every mutation goes through `runAction` (spy) and `no-silent-mutations.test.ts` stays green without an allowlist entry.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && npx vitest run src/components/ai/WispConcernsPanel.test.tsx src/lib/wispConcernsApi.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the api module, the panel, the mount, the locale keys**

- [ ] **Step 4: Run tests, parity, and the mutation guard**

Run: `cd apps/web && npx vitest run src/components/ai/WispConcernsPanel.test.tsx src/lib/wispConcernsApi.test.ts src/lib/i18n/localeParity.test.ts src/lib/i18n/keyUsage.test.ts src/lib/__tests__/no-silent-mutations.test.ts && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit; echo EXIT=$?`
Expected: PASS, `EXIT=0`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/wispConcernsApi.ts apps/web/src/lib/wispConcernsApi.test.ts apps/web/src/components/ai/WispConcernsPanel.tsx apps/web/src/components/ai/WispConcernsPanel.test.tsx apps/web/src/components/ai/AiChatSidebar.tsx apps/web/src/lib/__tests__/no-silent-mutations.test.ts apps/web/src/locales/
git commit -m "feat(wisp): concerns panel in the Wisp thread view with snooze/dismiss/resolve (W05)"
```

---

### Task 13: End-to-end integration — ceiling isolation, budget exhaustion, flag-off, full suites

**Files:**
- Create: `apps/api/src/__tests__/integration/wispTriageEngine.integration.test.ts`
- Test only; no production code expected (fix forward in the owning task's files if a case fails).

**Interfaces:**
- Consumes: W02 `createGrant` test helper or direct `wisp_grants`/`wisp_grant_revisions` inserts under `SYSTEM_CTX` (copy the fixture W02's `wispGrantsRls.integration.test.ts` uses); Tasks 3, 5, 7, 9.

- [ ] **Step 1: Write the integration cases (they are red until the stack runs the real admission)**

```ts
it('a grant scoped to org A never sees org B concerns through listConcernsForCeiling or GET /wisp/concerns', …)
it('an exhausted grant budget admits zero assessment runs: enqueueAssessment → budget_exhausted, ai_agent_runs count unchanged, grantor notified exactly once across 3 attempts, deterministic concern recorded', …)
  // seed: two completed assessment runs today with cost_cents summing to budget_cents_per_day
it('a run queued yesterday is not charged to today', …)
it('with BREEZE_WISP_ENABLED unset: processWakeTick returns zeros, handleWispWakeEvent touches no table, GET /api/v1/wisp/concerns is 404', …)
it('flag on, real admission: enqueueAssessment admits a run with profile assessment, grant_id set, kind triage; a second request within 60 s coalesces', …)
  // requires an enabled partner-wide triage agent fixture (see aiAgentSchedulesPartnerRls.integration.test.ts for the ai_agents insert shape); without one the result is { skipped: 'no_effective_agent' } — assert THAT in a sibling case so the dependency is explicit
it('paused grant: the next tick sets its watches to stopped and the partner admin notification exists once', …)
```

- [ ] **Step 2: Run them and fix forward**

Run: `pnpm test-stack up && cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/wispTriageEngine.integration.test.ts`
Expected: PASS after fixes land in the owning files.

- [ ] **Step 3: Run the full unit suites and every contract suite this wave can red**

Run: `pnpm --filter @breeze/api test --run && pnpm --filter @breeze/web test --run && pnpm --filter @breeze/shared test --run`
Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/wispConcernsRls.integration.test.ts src/__tests__/integration/wispConcerns.integration.test.ts src/__tests__/integration/wispTriageEngine.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts src/__tests__/integration/aiAgentSchedulesPartnerRls.integration.test.ts`
Run: `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage && pnpm --filter=@breeze/api test:rls`
Run: `pnpm test-stack down`
Expected: all PASS; say in the PR which suites ran.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/__tests__/integration/wispTriageEngine.integration.test.ts
git commit -m "test(wisp): triage-engine integration — ceiling isolation, budget exhaustion, flag-off, coalescing (W05)"
```

- [ ] **Step 5: PR body checklist (w00 reconciliation item 7)**

State: flag off = no behaviour change; tenancy registrations added (3 tables × cascade/merge/export, `wisp_watches` in `DUAL_AXIS_TENANT_TABLES`); contract names introduced (`enqueueAssessment`, `rollupPartnerPicture`, `chargeableUnderGrant`, `upsertConcern`, `resolveConcern`, `listConcernsForCeiling`, `recipientState`, `nextBackoff`, `createWatch`, the three event types, the `assessment` profile and five outcome tools) and consumed (`createAndEnqueueAgentRun({ grant })`, `resolveGrantCeiling`, `assertWithinCeiling`, `rememberForGrant`, `getOrCreateThread`, `updateThreadSummary`, `seedContextForSession`, `requireEntitlement('wisp')`); the W03 broker-caller allowlist entry; the connection-health event decision; `Closes #<W05 sub-issue>`.

---

## Calls made by the planner

1. **Subject ids are soft references, no FK** (Task 1) — seven subject tables with conflicting erasure dispositions; an FK would cascade-delete concern history on device purge or block it; the reaper reconciles with `subject_gone`. The column is named `subject_id` so the device/ticket cascade-list tests do not match it; those lists are deliberately untouched.
2. **No new `connection_health.incident.opened` event.** The checkout already publishes `integration.health_opened` from a durable outbox (`services/connectionHealth/events.ts`); W05 subscribes to it. w00's event list and spec §7.1's "today has none of … connection-health" are stale against main and should be amended by the orchestrator.
3. **Assessments resolve the org's `triage` agent** (`kind: 'triage'`, `triggerKind: 'schedule'`, Wisp fields in `triggerRef.wisp`). A partner with no enabled triage agent gets `skipped: 'no_effective_agent'` and only the deterministic path; a new `AiAgentKind` was rejected for blast radius (kinds drive policy, UI, graduation, recipients).
4. **Assessment caps are constants** (`1` concurrent, `6`/hour per agent+org) in `assessmentProfile.ts`, not new `AiAgentLimits` fields — avoids a policy-snapshot version bump for a profile no policy page configures.
5. **Debounce = one BullMQ delayed job per (grant, org) with a deterministic jobId**; **floor tick = one fixed 5-minute tick** scanning grants whose `last_floor_tick_at` is due, **one org per grant per tick** chosen round-robin by oldest assessment. `last_floor_tick_at` is a W05 column on W02's `wisp_grants`. Per-grant repeatables were rejected for the orphaned-repeatable problem the sweep scheduler documents.
6. **Assessment watermark = `MAX(finished_at)` of the last completed assessment run for (grant, org)** — no cursor table; a partial index on `ai_agent_runs (grant_id, org_id, profile, queued_at)` serves it and the budget sum.
7. **`ticket.stale` is a stateless sliding-window poller** (72 h default, 5-minute window, deterministic `eventId`), scanning only orgs under an active grant; a long outage misses crossings, which the floor tick covers.
8. **Budget counts `ai_agent_runs.cost_cents` by `queued_at`** for runs carrying `grant_id`. W04 chat turns under a grant are not counted in W05 (W04 would need to stamp `ai_sessions`); flagged as a follow-up, not a blocker.
9. **Permissions:** spec says `ai_agents:use`, the table has only `ai_agents:read`/`write`; w00 A1 fixes every Wisp route and tool on `ai_sessions:use` and partner-admin actions on `canManagePartnerWidePolicies`. W05 inherits the hub gate and adds grant ownership; no `ai_agents:write` gates.
10. **Retention:** resolved/dismissed concerns 90 days; `concern_outcome` memory 180 days (w00), deleted directly by the reaper with a W03 contract-allowlist entry if required.
11. **W05 nudge delivery** = `deliverInApp` (`services/wisp/deliver.ts`, the single `createNotification` call site under `services/wisp/`, `type: 'ai'`, `link: '/ai/wisp/thread/:threadId#concern=:id'`, `dedupeKey: wisp-nudge-<concern>-<grant>-<n>`); the budget notice, orphan-watch notice and exhausted-budget digest go through the same function, so W06's `notifyUser` swap and its callers-contract test touch one file.
12. **Watch kinds** are stored and fed to the assessment prompt (`watchPromptLines`); W05 implements no per-kind evaluator beyond `ticket_waiting`'s threshold feeding the poller — the model reads live data for the rest.
13. **`request_specialist`** is registered as an outcome tool whose SDK handler answers `{ refused: 'not_available_until_w07' }`; calls are kept in the outcome for W07's audit.
14. **Web mount point** is `AiChatSidebar.tsx`'s `wisp`-set branch, directly beneath W04's `<WispThreadHeader>` (W04 Task 8), and the two new web files join `no-silent-mutations` `TARGET_GLOBS` as W04's did.
15. **`wisp_watches` tenancy shape** copies `connection_health_incidents` (partner-anchored, org-optional, `DUAL_AXIS_TENANT_TABLES`, no `breeze_current_partner_id()` branch); `wisp_concerns`/`wisp_concern_recipients` are plain shape 1 with `partner_id` denormalised and a deferrable composite FK.

### Reconciliation edits (reviewer)

- Permissions per w00 A1: dropped every `ai_agents:write` gate (routes, orphan-notice recipients); partner-admin branches key on `canManagePartnerWidePolicies`.
- `GrantCeiling.grantorUserId` (w00 A3) replaces the `loadGrant` lookup in `createWatch` and the finalizer's nudge recipient.
- `deliver.ts` is the single `createNotification` site (w00 A18): `InAppDelivery` gains `threadId`/`grantId`/`deepLink` so W06's `notifyUser` can route through it; metadata keys fixed (`wispThreadId`, `concernId`, `grantId`, `intentId`, `deepLink`).
- Route bodies for snooze/dismiss/resolve carry `grantId` (the recipient row cannot be found without it; W06 web/mobile send it); `Concern` DTO gains `approvalIntentId` (stamped by `propose_action({ concernId })`) for W06's "Review approval".
- `ai.intent.decided.grantId` is read through `requesting_agent_run_id → ai_agent_runs.grant_id` (W02 adds no `action_intents` column).
- Spec §10 "entitlement lost ⇒ grants paused with `entitlement_lost`": added `reconcileEntitlements` to the wake tick (Task 9) and a claim-time `hasEntitlement` check in `enqueueAssessment` (Task 7).
- Spec §9/§16: plan budget defaults (`WISP_BUDGET_DEFAULT_BY_PLAN`, one-line `createGrant` edit), `grantSettingsBounds` for W02's `PATCH /grants/:id/settings`, and the budget-exhausted notice now links to the thread page (the one-tap raise lives in W04's header). `/ai/wisp` was not a page; all notice links now point at real pages.
- Spec §7.4 reply-in-thread / §14 tool list: added Task 11b (`list_concerns`, `snooze_concern`, `resolve_concern`, `create_watch`, six registries, `ai_sessions:use`); `recall` added to the assessment allowlist; Task 6 stamps `AuthContext.wispGrant` on grant-bearing runs (w00 A2).
- Task 11's file-count expectation corrected (W03/W04 test files share the `src/routes/wisp` substring).
- w00 A25 (consulting mode, spec §6.1 (4)): `raise_concern` added to Task 11b as a fifth chat tool (T2, auto-approvable like W03's `remember`, rate-limited 20/300 s, `raiseConcernChatSchema` with subject kinds `org`/`ticket` only and an explicit `orgId` checked by `assertWithinCeiling`; ticket subjects verified to belong to the org; six registries; tests incl. an `ai_agent` principal without a grant being refused). **Name split forced by code:** `createBreezeMcpServer` throws when an extra (outcome) tool's name is a `TOOL_TIERS` key (`aiAgentSdkTools.ts:4354` — the guard exists precisely to keep outcome tools off the chat surface), so the assessment **outcome** tool is renamed `record_concern` (Architecture, Task 2 test, Task 6 — `OUTCOME_TOOL_NAMES`, `outcomeToolsForProfile`, finalizer step 1, descriptions) and a static assertion in `outcomeTools.test.ts` keeps the two sets disjoint. w00 line 129 ("`raise_concern`" among the outcome tools) should be amended to `record_concern`; the orchestrator owns that edit.
- w00 A23 (populator side): Task 6's run-side `wispGrant` stamp carries `sessionId: run.sessionId ?? null` so W03's `remember` writes `source_session_id` for a chat-initiated run and NULL for a scheduled assessment.

## 2026-10-23 amendments (w00 A30, A32, A33, A34, A35) — tasks added by the orchestrator

These edit Task 1's schema in place (the CHECK lists above already carry the new values) and add Tasks 14–17. Where a task below and an earlier task disagree, this section wins.

### Task 1 edits (schema)

- `wisp_concerns.org_id` is **`uuid NULL`** (partner-level concern when NULL; w00 A30). Policy and registration become the `wisp_watches` / `connection_health_incidents` shape: one `FOR ALL` policy `breeze_current_scope() = 'system' OR (org_id IS NOT NULL AND breeze_has_org_access(org_id)) OR (org_id IS NULL AND breeze_has_partner_access(partner_id))`; add `'wisp_concerns'` and `'wisp_concern_recipients'` to `DUAL_AXIS_TENANT_TABLES`; they **stay** in `CORE_ORG_CASCADE_DELETE_ORDER` / `orgMergeRegistry.ts` / `CORE_TENANT_EXPORT_POLICY` (org rows carry `org_id`; the cascade's `WHERE org_id = $1` never touches partner-level rows — add this sentence to the migration header and an assertion to the RLS integration test).
- Live-subject index: `CREATE UNIQUE INDEX IF NOT EXISTS wisp_concerns_live_subject_uq ON wisp_concerns (partner_id, org_id, subject_kind, subject_id) NULLS NOT DISTINCT WHERE status IN ('open','snoozed');` (pg16).
- New columns on `wisp_concerns`: `signature text NULL`, partial unique index `wisp_concerns_live_signature_uq (partner_id, signature) WHERE status IN ('open','snoozed') AND signature IS NOT NULL`; `child_concern_ids uuid[] NOT NULL DEFAULT '{}'` (partner-level incidents only).
- `wisp_concern_recipients`: `org_id uuid NULL` (copied from the concern; RLS only), FK `concern_id → wisp_concerns(id) ON DELETE CASCADE` (drop the composite `(concern_id, org_id)` FK and the `UNIQUE (id, org_id)` it needed), new `feedback text NULL CHECK (feedback IN ('useful','not_useful'))`, `feedback_at timestamptz NULL`, `feedback_note text NULL CHECK (length(feedback_note) <= 200)` (w00 A34).
- `wisp_watches.stopped_reason` is read by W02's `userResumeGrant` (A29): keep the value `'paused'` for grant-paused stops.
- Export policy: `signature`, `child_concern_ids` → `included`; `feedback_note` → `reviewedIncluded`.
- RLS integration test additions: an org-scoped token never reads a partner-level (`org_id NULL`) concern; a partner-scoped token does; the `NULLS NOT DISTINCT` index refuses two live partner-level concerns for the same `(subject_kind, subject_id)`; the signature index refuses two live concerns with the same signature.

### Task 3 edits (`concerns.ts`)

- `upsertConcern` accepts `orgId: string | null` and optional `signature`, `childConcernIds`; the conflict target is the signature index when `signature` is set, else the subject index. `listConcernsForCeiling` WHERE becomes `partner_id = $p AND (org_id = ANY($orgIds) OR (org_id IS NULL AND $scopeOrgId IS NULL))` using `ceiling.scopeOrgId` (W02 contract change). `recordFeedback(concernId, grantId, { useful, note })` sets the three columns, calls `markAnswered`, and on `not_useful` sets `next_eligible_nudge_at = now + 24 h`.

### Task 5 edits (`budget.ts`, w00 A32)

- Export `spendSummary(grantId, now?): Promise<{ spentTodayCents: number; budgetCentsPerDay: number; budgetResetsAt: Date }>`; W04's `GET /wisp/thread` and W06's `GET /wisp/thread/:id` grant blocks gain `spentTodayCents` and `budgetResetsAt` (W05 edits `routes/wispThreads.ts` and its test — one additional select; the field names are the contract).

### Task 7 edits (`assessment.ts`, w00 A33/A34)

- `AssessmentReason` gains `{ kind: 'onboarding' }`. The context block gains (a) `readinessInventory` for the org (Task 15) and (b) the grantor's last 20 `preference` blocks with `subjectKeyPrefix: 'nudge_feedback:'` via `recallForGrant` (W03), rendered under the untrusted wrapper. Prompt line: *"The person has marked these past nudges useful or not useful; weigh that before you nudge."*

### Task 9 edits (`wake.ts`)

- Subscribe to `wisp.grant.created` and `wisp.grant.resumed` (W02 Task 15): for `created`, `requestAssessment({ reason: { kind: 'onboarding' } })` for the first **10** orgs of the ceiling (alphabetical by org name; the rest reach the floor tick); for `resumed`, one `{ kind: 'tick' }` request for the round-robin org. `reconcileEntitlements` and the new `reconcilePartnerDisabled` (A35: `wisp_partner_settings.enabled = false` ⇒ `pauseGrant(id, 'partner_disabled')`; back to true ⇒ resume) both skip `paused_reason = 'user_paused'`. The tick also runs `pollTicketClusters(now)` then `correlateIncidents(now)` (Task 14) after `pollStaleTickets`.

### Task 14: Ticket clustering and the partner-level incident correlator (w00 A30)

**Files:**
- Modify: `apps/api/src/services/wisp/pollers.ts` (+ `pollers.test.ts`), `apps/api/src/services/wisp/watches.ts` (kind registry + default params), `packages/shared/src/types/wispConcerns.ts` (`CONCERN_SUBJECT_KINDS` + `WATCH_KINDS`)
- Create: `apps/api/src/services/wisp/incidentCorrelator.ts` (+ `.test.ts`), `apps/api/src/__tests__/integration/wispIncidents.integration.test.ts`

**Interfaces:**
```ts
// pollers.ts
export function normalizeTicketTokens(subject: string): string[];                         // lowercase, strip punctuation, drop stop-words + ticket numbers, ≤ 12 tokens
export function jaccard(a: readonly string[], b: readonly string[]): number;
export function clusterTickets(rows: Array<{ id: string; orgId: string; tokens: string[] }>, minTickets: number, threshold?: number): Array<{ orgId: string; ticketIds: string[]; tokens: string[] }>; // pure; greedy single-link at Jaccard ≥ 0.5; top-5 tokens by frequency name the cluster
export function clusterSignature(scope: string, tokens: string[]): string;                   // sha256(`${scope}:${sorted top-5 tokens}`)
export async function pollTicketClusters(now: Date, opts?: { limit?: number }): Promise<{ scanned: number; clustersOpened: number; clustersUpdated: number }>;
//   per active ticket_cluster watch (default params { windowMinutes: 15, minTickets: 3 }; partner-wide watches expand to every org in the ceiling): tickets created in [now − window, now] for that org (status not closed), ≤ 500 per org; clusterTickets → upsertConcern({ orgId, subject: { kind: 'incident', id: <new uuid> }, signature: clusterSignature(orgId, tokens), severity: 'medium', summary: `${n} similar tickets in ${window} min: ${tokens.join(' ')}`, evidence: { ticketIds, tokens, windowMinutes } }); an existing live concern with the signature gets updateConcern with the merged ticketIds (created:false path).
// incidentCorrelator.ts
export async function correlateIncidents(now: Date): Promise<{ partnerIncidentsOpened: number; updated: number; autoClosed: number }>;
//   for each partner with ≥ 1 active partner-wide grant: org-level 'incident' concerns opened/updated in the last 60 min, grouped by clusterSignature(partnerId, tokens) across orgs; a group spanning ≥ 2 orgs OR ≥ 8 tickets → upsertConcern({ orgId: null, subject: { kind: 'incident', id }, signature, severity: 'high', summary: `Possible incident across ${orgCount} customers: ${tokens.join(' ')}`, evidence: { orgIds, ticketIds, childConcernIds, healthIncidentIds }, childConcernIds }) where healthIncidentIds = connection_health_incidents opened in the window for the same partner; nudge: one deliverInApp per partner-wide grantor (W06 swaps to notifyUser) with dedupeKey `wisp-incident-${concernId}-${grantId}`; auto-close: a partner-level incident whose children are all resolved/dismissed, or that is older than 24 h with no new tickets, → resolveConcern(id, {}, 'auto_closed').
```
Rules: every write runs under `runOutsideDbContext(withSystemDbAccessContext)`; only orgs under an active grant are scanned (the same join as `pollStaleTickets`); no model call anywhere in this task; `pg_trgm` is **not** assumed — tokenising is in TS.

- [ ] **Step 1: Failing unit tests** — `normalizeTicketTokens('RE: Outlook keeps asking for password #4021')` → `['outlook','keeps','asking','password']`; `jaccard` edge cases; `clusterTickets` groups three similar subjects and leaves two unrelated ones alone; `clusterSignature` is stable under token order; `pollTicketClusters` opens one concern per cluster and updates (not duplicates) on the second scan; `correlateIncidents` opens one partner-level concern for two orgs sharing a signature, none for one org with 3 tickets, one for a single org with 8; auto-close after children resolve; a partner with only org-scoped grants gets no partner-level concern.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/wisp/pollers.test.ts src/services/wisp/incidentCorrelator.test.ts` — FAIL.
- [ ] **Step 3: Implement**; integration test: two orgs under one partner with a partner-wide grant and an org-scoped grant; seed 3+3 similar tickets; run both pollers; assert the org-scoped ceiling lists its own org incident only and the partner-wide ceiling lists the partner-level one; assert the `NULLS NOT DISTINCT` index holds.
- [ ] **Step 4: Run** unit + integration + `wispConcernsRls.integration.test.ts` — PASS.
- [ ] **Step 5: Commit** — `feat(wisp): ticket_cluster watch, deterministic ticket clustering and the partner-level incident correlator (W05 T14, w00 A30)`.

### Task 15: `readiness.ts` — what Wisp can and cannot watch (w00 A33)

**Files:**
- Create: `apps/api/src/services/wisp/readiness.ts` (+ `readiness.test.ts`)
- Modify: Task 7's context builder, Task 6's finalizer (one `org`-subject concern per org with gaps on an `onboarding` assessment; `subject: { kind: 'org', id: orgId }`, `severity: 'info'`, `signature: \`readiness:${orgId}\``, so it upserts rather than duplicates on re-runs)

**Interfaces:**
```ts
export type ReadinessCheck = { watchKind: WatchKind; serviceable: boolean; reason: string | null };   // reason e.g. 'no backup integration configured'
export type OrgReadiness = { orgId: string; orgName: string; checks: ReadinessCheck[]; missingIntegrations: string[] };
export async function readinessInventory(ceiling: GrantCeiling, opts?: { orgIds?: string[] }): Promise<OrgReadiness[]>; // deterministic reads only, system ctx filtered by ceiling.orgIds; serviceable rules: backup_health ⇔ a configured backup provider for the org; security_findings ⇔ vuln or EDR rows in 30 d; patch_compliance ⇔ an effective patch policy; ticket_waiting / ticket_cluster ⇔ ≥ 1 ticket in 90 d; alert_pattern ⇔ ≥ 1 monitor or alert rule; custom_query always true
export function renderReadinessSummary(r: OrgReadiness): string;   // "I can watch alerts and tickets here. I can't watch backups (no backup integration configured) or patch compliance (no policy)."
```
- [ ] **Step 1: Failing tests** — each serviceable rule flips on its own fixture; an org outside the ceiling is never returned; `renderReadinessSummary` wording for 0, 1 and 3 gaps; the finalizer writes exactly one readiness concern per org and the second onboarding run updates it (signature path).
- [ ] **Step 2–4:** run → FAIL, implement, run with Task 7's tests — PASS. Commit `feat(wisp): readiness inventory and the onboarding assessment's "what I can watch" concern (W05 T15, w00 A33)`.

### Task 16: Widened concern subjects and `raise_concern` kinds (w00 A35)

- `CONCERN_SUBJECT_KINDS` gains `incident`, `quote`, `invoice`, `contract`, `site`; Task 11b's `raiseConcernChatSchema` allows `ticket | org | quote | invoice | contract | device` (each verified to belong to the named org through its own org-scoped read — `quotes`, `invoices`, `contracts`, `devices` by `(id, org_id)`); the reaper's `subjectGone` map learns the new tables. Tests: a quote from another org is refused with `CeilingViolationError('org')`; `incident` is **not** accepted from chat (correlator-only).

### Task 17: Routes — `GET /wisp/concerns/:id`, feedback endpoint owner

- `GET /wisp/concerns/:id?grantId=` → the `Concern` DTO with `recipient` (W06's mobile sheet deep-links by id). The feedback route itself is W06's (A34); W05 exposes `recordFeedback` only.
