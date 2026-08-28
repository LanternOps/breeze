---
tracking_issue: LanternOps/breeze#3821
wave: W07 (#3828) — PR 2 of 5 (Fix-held watch; circuits inert)
---

# Wave 6 PR 2 (6.2a) — Fix-held watch, with the circuit ledger inert

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wave 6.1 let operators see what an agent *did*. This PR answers the question that follows — **did the fix hold?** — and lays the durable counter that 6.2b turns into an enforcing circuit breaker. Nothing in this PR blocks an agent action: the circuit table is written but never read by a gate. That inertness is the review contract, exactly as it was for wave 5 Part A's `ai_unattended_exposure`.

**Architecture:** `ai_agent_fix_watches` holds one row per watchable act execution, with a `watch_kind` discriminator:

- **`alert_recurrence`** — op-agnostic. Did an alert of the same identity (same device, same `rule_id`, or same `config_item_name` when `rule_id` is null) trigger again between the run finishing and the watch falling due? A pure DB read, so it resolves even when the device is offline, and it covers `run_script` and `execute_playbook` — ops that have no re-readable postcondition at all.
- **`postcondition`** — op-specific. Re-runs the op's own `verifySpec` read-back against the pinned target. **`service_running` is the only kind v1 watches** (see "Why only one postcondition kind").

A repeatable BullMQ sweeper claims due rows under a lease, performs the (bounded) device read outside any transaction, then finalizes the watch and increments the circuit in one idempotent transaction. `ai_agent_circuits` accumulates failure counters keyed on `(org_id, agent_id, device_id, op_key, target_fingerprint)` and carries an `epoch`, but **no code path reads it to make a decision in this PR**.

**Tech Stack:** TypeScript, Drizzle, ONE migration (`2026-09-18-…`, sorting after the newest committed `2026-09-17-ai-agent-runs-keyset-index.sql`), BullMQ repeatable, Hono zValidator, React + Astro + i18n (8 locales).

## Design authority — advisor quorum 2026-08-28

Two advisors: Claude Fable 5 (proposing) and Codex gpt-5.6-sol at `xhigh` (independent, read-only). Both read the wave 4/5/6.1 sources before answering. **Agreed on all six questions put to the quorum**; the corrections below are Codex's, and all are accepted.

| # | Decision | Note |
|---|---|---|
| 1 | **Two tables, not a derived breaker.** | `ai_agent_runs.outcome` is terminal-only jsonb, holds arrays of actions, carries no indexed target identity, and is incomplete after a crash. Deriving would move the cost into every act dispatch and still need a durable row for atomic half-open admission later. |
| 2 | **Circuit key includes `target_fingerprint`.** | *Codex correction.* `(org_id, agent_id, device_id, op_key)` is too coarse — a failed restart of service A must not block service B, and one failed script must not block every script. |
| 3 | **DB-backed sweeper, not a delayed job per watch.** | Deciding failure mode: the watch row commits but its Redis delayed job is lost (enqueue failure, flush/restore, eviction, operational reset). There is no atomic Postgres+Redis transaction, so the row must be rediscoverable. A delayed job is acceptable only as a latency optimization *on top of* the sweeper — not in v1. |
| 4 | **Sweeper worker is `socket-owner`.** | Its closure reaches `commandQueue`. `workerEntrypointClosure.contract.test.ts` is the authority — do not hand-reason the placement. |
| 5 | **`process_absent` is not watched, and re-checking by name is rejected.** | *Codex correction, accepted.* Name-matching is not a weaker version of the same postcondition — it is a broader and different claim (legitimate respawn, multiple instances, unrelated binaries sharing a name), and a UI label does not make a false regression safe to feed a breaker. Costs nothing today: `manage_processes.kill` is deliberately absent from the manifest. |
| 6 | **`disk_usage_improved` is not watched either.** | Both advisors reached this independently: its "verification" only reads the cleanup command's own `status`/`failedCount` and performs no disk read (`actVerify.ts:168-186`), and `ActTarget` carries paths but no before/after metric, volume identity, or threshold. There is no baseline to re-check against until one is captured. |
| 7 | **Gate at the normalized op/target level, never at run admission.** | Admission does not yet know which remediation the model will pick; skipping the run loses triage, read-only diagnostics, and the human-reviewable proposal. Admission keeps owning trigger storms and resource caps. *(Enforcement itself lands in 6.2b.)* |
| 8 | **Both tables are org-owned operational records, not dual-owned config.** | They describe one action on one device in one target org — the `ai_agent_runs` precedent, where `agent_id` may name a partner-wide agent while `org_id` is the device's org. Configurable thresholds and watch intervals belong in the already-dual-owned agent policy surface, not in a new table. |
| 9 | **On cross-org device move, DELETE both tables' rows — never re-stamp `org_id`.** | *Codex correction, accepted; it reverses the proposing advisor's lean.* Re-stamping would transfer source-tenant target data into the destination org and would let a source agent's pending watch fire a device command against a device now owned by a different tenant. `CORE_DEVICE_ORG_MOVE_DELETE_TABLES` exists and is currently empty — these are its first two entries. |
| 10 | **Manual reset only; no automatic half-open in this program.** | Codex's position is that auto half-open is defensible *only* as a single on-demand probe under a durable atomic lease (`probe_token`/`probe_run_id`/`probe_lease_until`, claimed by CAS, every concurrent contender downgraded, and for watchable ops the circuit stays half-open until the probe's own delayed watch reports `held`) — and that if that cannot be built in this wave, manual-reset-only is the correct v1. Given decision 11 below is now mandatory scope, we take that fallback. The leased-probe design is filed as the follow-up. |
| 11 | **The circuit must be enforced in all THREE unattended lanes, not just act dispatch.** | *Codex's "biggest omission" — verified against the code before acceptance.* "Downgrade to propose" does **not** mean "a human must approve": `recordProposal` calls `createActionIntent` for tier-3 (`runLoop.ts:462`), `intentService.ts:628` then fires `attemptPolicyDecision`, and `manage_services:restart` is in `POLICY_DECIDABLE_TIER3` (`policyDecidable.ts:96`). So a circuit-open restart can be downgraded and then authorized unattended, routing the breaker around itself. Enforcement must cover (a) direct act dispatch, (b) policy-decision authorization, and (c) release time, for the race where the circuit opens after authorization — and a circuit-origin proposal must carry a **durable** human-required marker, since `downgradeReason` lives only in the run outcome and is never carried into the intent. **This is why enforcement is split into 6.2b: it is a safety gate that deserves its own review, not a rider on a telemetry PR.** The bypass is dark in production today (the policy-decide flag is off), which is what makes the split safe. |

Also carried into the plan from Codex's sign-off list: version the serialized watch contract (`verify_spec.kind` alone is insufficient), use circuit **epochs** so a stale watch cannot reopen a manually-reset circuit or close a newer failure, define watch-**creation** failure behavior (an action must not read as cleanly remediated when its required watch could not be recorded), emit a **separate** regression notification (the run-finished one has already been sent and deduped), and define retention for terminal watches and closed circuits.

### Why only one postcondition kind

The live act manifest has five ops: `manage_services.restart` (`service_running`), `disk_cleanup.execute` (`disk_usage_improved`), `run_script` (`script_exit_code`), `execute_playbook` (`playbook_aggregate`), and the virtual `remediation_suggestion` (resolves to `run_script`). `script_exit_code` is point-in-time and has nothing to re-read; `playbook_aggregate` is a roll-up of per-step verifies; `disk_usage_improved` and `process_absent` are excluded per decisions 5-6. That leaves `service_running`.

A postcondition-only watch would therefore cover one op out of five — which is why the `alert_recurrence` lane exists. It is the honest general answer to "did the fix hold", it needs no device I/O, and it is the only lane that says anything at all about a script or a playbook.

## Global Constraints

- Tests: `cd apps/api && npx vitest run <path>` (never `pnpm --filter … test -- --run`). Web: touched components + `src/lib/i18n/localeParity.test.ts`; new UI strings in all 8 locales.
- Migration: idempotent (`CREATE TABLE IF NOT EXISTS`, `DO $$` guards, `pg_policies` checks), no inner `BEGIN`/`COMMIT`, named to sort after `2026-09-17-ai-agent-runs-keyset-index.sql`. `pnpm db:check-drift` clean.
- **Inertness contract:** no gate reads `ai_agent_circuits` in this PR. A test asserts the table has no reader outside the writer/route modules this PR adds.
- Safe-projection rule from 6.1 holds for every DTO here: no raw tool input/output, ever.
- Web mutations via `runAction`.
- Contract suites (RLS, tenantCascade, export policy, moveOrg coverage, cascadeDelete) must be run locally before the PR — they need a live DB and several of them cannot fail in the unit job.

## Registration obligations — all six lists

| List | File | Entry |
|---|---|---|
| `CORE_ORG_CASCADE_DELETE_ORDER` | `services/tenantCascade.ts` | `ai_agent_circuits`, `ai_agent_fix_watches` — alphabetical, both between `ai_agents` and `ai_budgets` |
| `CORE_DEVICE_CASCADE_DELETE_TABLES` | `routes/devices/core.ts` | both |
| `CORE_DEVICE_ORG_MOVE_DELETE_TABLES` | `routes/devices/core.ts` | both (decision 9) — its first entries |
| `INTENTIONALLY_NO_ORG_ID` | `routes/devices/moveOrg.coverage.test.ts` | both, with the decision-9 reason; they are deliberately NOT in `CORE_DEVICE_ORG_DENORMALIZED_TABLES` |
| `CORE_TENANT_EXPORT_POLICY` | `services/tenantExportPolicyRegistry.ts` | every column classified; `verify_spec` and `target` are jsonb → `excludedOpen` |
| `orgMergeRegistry` | `services/orgMergeRegistry.ts` | both — `leave-for-erasure`, same disposition and reasoning as `ai_unattended_exposure` |
| RLS coverage | `__tests__/integration/rls-coverage.integration.test.ts` | Shape 1 is auto-discovered, so no allowlist entry — but the suite must pass |

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/migrations/2026-09-18-ai-agents-fix-watch-circuits.sql` (new) | Both tables, forced RLS shape 1, indexes. Template: `2026-09-16-ai-agents-policy-decide-foundations.sql`. |
| `apps/api/src/db/schema/aiAgentFixWatches.ts` (new) | Drizzle definitions for both tables + row types. |
| `packages/shared/src/types/aiAgentFixWatches.ts` (new) | `AiAgentFixWatchDto`, watch-kind/status unions, `schemaVersion: 1`. |
| `apps/api/src/services/aiAgents/fixWatch.ts` (new) | `scheduleFixWatches(run, outcome, targets)` — pure selection + the insert. Contract version stamped here. |
| `apps/api/src/services/aiAgents/fixWatchCheck.ts` (new) | The two check implementations (`alert_recurrence`, `postcondition`) — each returns `held | regressed | inconclusive` + a short detail. |
| `apps/api/src/services/aiAgents/circuitLedger.ts` (new) | Epoch'd counter upsert. **Writer only — no gate reads it in this PR.** |
| `apps/api/src/jobs/aiAgentFixWatchWorker.ts` (new) | Repeatable sweeper: lease-claim → check outside the tx → finalize + increment in one tx → reclaim expired leases. |
| `apps/api/src/services/workerRegistry.ts` (modify) | Register it; placement decided by the contract test, not by hand. |
| `apps/api/src/services/aiAgents/runLoop.ts` (modify) | Stash structured act targets on the run context; call `scheduleFixWatches` from `finishRun`. |
| `apps/api/src/services/aiAgents/fixWatchNotify.ts` (new) | The separate regression alert + notification (decision list: the run-finished notification is already sent and deduped). |
| `apps/api/src/routes/aiAgents.ts` (modify) | `GET /runs/:runId/fix-watches` (safe DTO). |
| `apps/api/src/services/aiAgents/runTrace.ts` (modify) | Surface watch outcomes on the run-detail DTO. |
| `apps/web/src/components/aiAgents/RunDetailPage.tsx` (modify) + locales × 8 | "Did the fix hold" section. |
| Six registration lists (modify) | Per the table above. |

## Tasks

### Task 1: Migration + Drizzle schema + all six registration lists

Both tables, forced RLS shape 1 (`breeze_current_scope() = 'system' OR breeze_has_org_access(org_id)`), indexes for the sweeper's due-scan (`(status, due_at)`) and for per-run lookup. `ai_agent_circuits` gets a unique on `(org_id, agent_id, device_id, op_key, target_fingerprint)` and an `epoch bigint NOT NULL DEFAULT 0`. Watch rows carry `contract_version integer NOT NULL` and a `lease_expires_at`/`checking` claim column.

- [ ] Red first: add both tables to the six lists BEFORE the migration exists and watch the contract tests fail, then make them pass.
- [ ] Verify as `breeze_app`: forge a cross-tenant insert into each table; must fail with `new row violates row-level security policy`.
- [ ] Commit: `feat(api): fix-watch + circuit ledger tables with full tenancy registration (#3828)`

### Task 2: Watch scheduling at run finish

Selection is pure and unit-tested: an executed action qualifies for `postcondition` only when `actOpKey === 'manage_services.restart'` and `verification === 'passed'`; it qualifies for `alert_recurrence` whenever the run has an `alertId` and any act executed. Structured `ActTarget`s are stashed on the run context by the post-tool-use hook — **not** reconstructed from `actTargetName`, which is a lossy summary. `finishRun` calls the scheduler best-effort; a failure to record a required watch must be visible (decision list), not silently swallowed into a clean verdict.

- [ ] TDD → commit: `feat(api): schedule fix-held watches when an act run finishes (#3828)`

### Task 3: The sweeper worker

Lease-claim due rows (`UPDATE … SET status='checking', lease_expires_at=now()+interval` … `RETURNING`), run the check outside any transaction, finalize + increment the circuit in one idempotent transaction guarded on the circuit `epoch`, reclaim expired leases, retry `inconclusive` with bounded backoff before making it terminal, and never let an offline device increment a counter.

- [ ] TDD, plus one integration test against real Postgres proving the lease claim is exclusive under concurrency.
- [ ] Commit: `feat(api): fix-watch sweeper with lease-claimed due rows (#3828)`

### Task 4: Regression alert + notification, retention

Separate rule-less alert (the `recordActVerifyFailureAlert` pattern) and a separate notification with its own dedupe key. Retention sweep for terminal watches and closed circuits.

- [ ] TDD → commit: `feat(api): regression alert + notification for a fix that did not hold (#3828)`

### Task 5: Read route + run-detail surfacing + web

Safe DTO (`schemaVersion: 1`, every field enumerated by hand, leak-tripwire test asserting the serialized response contains no `args`/`toolInput`/`toolOutput`). Run-detail page gains a "Did the fix hold" section. i18n × 8 locales.

- [ ] TDD → commit: `feat(api,web): surface fix-held watch outcomes on the run detail page (#3828)`

### Task 6: Verification + PR

- [ ] Full api suite, shared, web, localeParity, typecheck, `pnpm db:check-drift`, migration-naming, and the contract suites that need a live DB: RLS coverage, tenantCascade, tenant-export-policy, tenantExportErasureRoundtrip, moveOrg coverage, cascadeDelete.
- [ ] Assert the inertness contract: no gate reads `ai_agent_circuits`.
- [ ] **Open the PR** → main, body: "PR 2 of 5 for #3828 — do NOT close", the inertness contract, decision 11 and why enforcement is deferred to 6.2b, and the deferred list. **Stop after opening the PR.**

## Deferred to 6.2b (circuit enforcement)

The three-lane gate (act dispatch, policy-decision authorization, release-time re-check), the durable human-required marker on circuit-origin intents, the manual reset route + UI, and breaker-opened notifications. 6.2b is where the breaker becomes a safety gate; this PR only makes it count.

**Where the three gates actually go.** `attemptPolicyDecision` has two callers — the fire-and-forget creation-time trigger (`intentService.ts:628`) and the durable one (`jobs/intentReleaseWorker.ts:978`, which its own comments name as the single durable caller). Gating *inside* `attemptPolicyDecision` therefore covers both entry points at once; do not gate each caller separately. So the three sites are:

1. `actRevalidation.ts` — after target normalization and asset-digest resolution, before the unattended-exposure reservation (so a blocked op never burns a ledger row).
2. `attemptPolicyDecision` — one gate, both callers.
3. `intentReleaseWorker`'s release path — the race where the circuit opens *after* authorization.

## Deferred beyond wave 6.2

- Leased single-probe half-open recovery (decision 10).
- A disk-usage baseline capture that would make `disk_usage_improved` genuinely watchable (decision 6).
- A durable executable-identity postcondition for `process_absent`, should `manage_processes.kill` ever return to the manifest (decision 5).
- The second-threshold "many distinct circuits open on one device → force all mutations to human review" scope Codex raised under decision 7.
