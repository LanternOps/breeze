---
tracking_issue: LanternOps/breeze#3821
wave: W07 (#3828) — PR 2 of 4 (Safety controls)
---

# Wave 6 PR 2 — Safety Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three safety mechanisms the quorum locked: the **fix-held watch** (`ai_agent_fix_watches` — after an act-lane remediation verifies, watch whether the triggering alert recovers and then whether it recurs; recurrence pages the operators), the **per-org circuit breaker** (`ai_agent_circuit_state` — repeated agent failures in an org auto-open a circuit that skips new admissions until a human resets it with MFA), and the **kill-state admin API** (the `ai_kill_state` flip finally gets an authorized surface + runbook).

**Architecture:** Two new org-scoped tables (full ceremony each — the `ai_unattended_exposure` template, including the org-merge registry and the device-cascade list where `device_id` exists). Circuit accounting centralizes in `transitionRunStatus`: it gains terminal-status bookkeeping, and the two raw-update bypass writers (`reapStalledAgentRuns`, `failRunAfterEnqueueFailure`) are converted to route through it — after this PR there is exactly ONE terminalization chokepoint (contract-tested). Classification per quorum: increment on runner failures/execution-ceiling codes and `completed`+`needs_attention`; reset on clean `completed` and `awaiting_approval`; neutral on `cancelled`/`expired`/`stalled`/`enqueue_failed`/policy-revoked. Open at `maxConsecutiveFailures` (new limits field, v4 snapshot) under a per-(org,agent) advisory xact lock; admission gains `skip('circuit_open')` right after the kill switch; reset is an org-scoped MFA route, never automatic, and config edits never close an open circuit. The fix-watch is two-phase and recovery-anchored: phase 1 polls for the triggering alert's RESOLUTION (delayed BullMQ jobs, patchJobExecutor's stable-jobId idempotency pattern; 24h timeout → `inconclusive`); phase 2 fires `FIX_HOLD_MINUTES` after observed recovery and checks recurrence (`ruleId`+`deviceId`, `triggeredAt > recovery`) → `recurred` (high-priority notification + rule-less attention alert, actVerify template) or `held_qualified` ("no re-alert for N minutes" — never an unconditional "held"). **v1 watch windows are CONSTANTS** (`FIX_HOLD_MINUTES = 60`, `RECOVERY_TIMEOUT_HOURS = 24`) — configurability needs the quorum's own-merge-semantics design (OR/max, not tighten-only min) and is deliberately deferred (flagged in the PR body).

**Tech Stack:** TypeScript, Drizzle, ONE migration (both tables + any index), BullMQ delayed jobs, Vitest. Policy snapshot v3 → v4 (tolerant reads 1-4).

**Design authority — LOCKED (wave-6 quorum 2026-08-28):** watch results live in their own table, never mutate a terminal run's outcome; act-lane clean runs only (policy-decided actions excluded until they gain post-execution verification); absence of recurrence is NOT proof (alert dedupe/cooldown can suppress rows — hence `held_qualified` phrasing and `inconclusive` on no-recovery); flapping recurrences count as `recurred`; circuit state is `(org_id, agent_id)` — NEVER `ai_agents.enabled` (partner-level); manual MFA reset only; `maxConsecutiveFailures` bounded 1-10, no 0-disables; kill UI stays latent (prod has zero platform admins — API + runbook only, flagged to the operator).

## Global Constraints

- Tests `cd apps/api && npx vitest run <path>`; typecheck heap bump; shared: `pnpm --filter @breeze/shared test`. **Run `pnpm lint` in every touched package before finishing** — eslint-disable comments naming unregistered rules (`@typescript-eslint/*`, `react-hooks/*`) are THEMSELVES lint errors in this repo (bit CI twice already; use `as never`, write real deps arrays).
- Migration idempotent, sorts after newest committed (check `ls apps/api/migrations/*.sql | sort | tail -1` at implementation time), llm_egress_events RLS/FK style, explicit ON DELETE on every FK.
- Ceremony sets: `ai_agent_fix_watches` (has org_id + device_id + run/agent/alert FKs) → org cascade + export policy + org-merge `leave-for-erasure` + `CORE_DEVICE_CASCADE_DELETE_TABLES` (devices/core.ts:234) + `INTENTIONALLY_NO_ORG_ID`-adjacent moveOrg exemption decision (it HAS org_id — check the moveOrg denormalized list instead and mirror ai_unattended_exposure's reasoning at devices/core.ts:129-140) + RLS auto. `ai_agent_circuit_state` (org_id + agent_id, NO device_id) → org cascade + export + org-merge + RLS auto, NO device-cascade. Schema barrel exports.
- The terminalization contract test is load-bearing: after this PR, a grep-style test asserts no production writer sets a terminal `ai_agent_runs.status` outside `transitionRunStatus` (mirror the agentDispatchBoundary source-scan mechanism).
- `createNotification` under system context (docstring rule); dedupe keys `fix-watch-<watchId>-recurred`, `circuit-open-<orgId>-<agentId>` (hyphen-only jobIds; BullMQ jobIds for watches: `fix-watch-p1-<watchId>` / `fix-watch-p2-<watchId>`).
- Commit after every task with trailers:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_012o7QB15EFjEvetDAXMxmae`

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/migrations/<next>-ai-agents-safety-controls.sql` + schema files + registrations | Both tables, full ceremony. |
| `packages/shared` (modify) | `maxConsecutiveFailures` (default 3, 1-10) + snapshot v4. |
| `apps/api/src/services/aiAgents/agentCircuit.ts` (new) | Classification, `recordRunTerminal`, open/notify/audit, `isCircuitOpen`, `resetCircuit`. |
| `apps/api/src/services/aiAgents/runService.ts` (modify) | `transitionRunStatus` bookkeeping hook; 2 bypass writers routed through it; `skip('circuit_open')` admission rule; limits-coverage line. |
| `apps/api/src/routes/aiAgents.ts` (modify) | `GET /:id/circuit` + `POST /:id/circuit/reset` (org-scoped, `requireMfa`, reason required, audited). |
| `apps/api/src/services/aiAgents/fixWatch.ts` + `apps/api/src/jobs/fixWatchWorker.ts` (new) | Watch rows + two-phase delayed checks + verdict writes + notifications/alert. |
| `apps/api/src/services/aiAgents/runLoop.ts` (modify) | `finishRun` schedules watches for eligible runs (alert-triggered ∧ ≥1 executed action with `verification: 'passed'` ∧ act lane). |
| `apps/api/src/routes/admin/aiKillState.ts` (new) + `routes/admin/index.ts` | GET state / POST flip (`requireMfa`), platform_admin audit; runbook section in `docs/deploy/worker-split.md` or a new `docs/deploy/ai-kill-switch.md`. |
| `workerRegistry.ts` + snapshots (modify) | `fixWatchWorker` registry entry (placement per closure verdict; snapshots 107 → 108). |

---

### Task 1: Migration + schemas + ceremonies + `maxConsecutiveFailures`

- `ai_agent_fix_watches`: id, org_id NOT NULL, partner_id NOT NULL (composite org FK CASCADE), agent_id FK ai_agents CASCADE, run_id FK ai_agent_runs CASCADE, alert_id FK alerts SET NULL, rule_id uuid NULL (denormalized from the triggering alert — survives alert deletion), device_id uuid NOT NULL (no FK, exposure precedent), config_item_name varchar(200) NULL, state text NOT NULL DEFAULT 'pending' CHECK IN ('pending','watching','recurred','held_qualified','inconclusive','cancelled'), recovery_observed_at timestamptz, due_at timestamptz, evaluated_at timestamptz, recurrence_alert_id uuid FK alerts SET NULL, notified_at timestamptz, created_at timestamptz DEFAULT now(); UNIQUE (run_id); indexes (org_id, created_at DESC), (state, due_at). RLS org policy.
- `ai_agent_circuit_state`: org_id NOT NULL + agent_id NOT NULL FK ai_agents CASCADE, PRIMARY KEY (org_id, agent_id), partner_id NOT NULL + composite org FK CASCADE, consecutive_failures int NOT NULL DEFAULT 0, state text NOT NULL DEFAULT 'closed' CHECK IN ('closed','open'), opened_at timestamptz, opened_reason text, last_run_id uuid NULL, last_transition_at timestamptz NOT NULL DEFAULT now(), reset_by uuid NULL, reset_at timestamptz. RLS org policy.
- All ceremony registrations per Global Constraints; drift check clean; shared field + validator + defaults + v4 bump (grep every snapshot-version read site → tolerate 1-4) + limits-coverage line (`maxConsecutiveFailures — agentCircuit.ts via transitionRunStatus`).
- [x] TDD → commit: `feat(api,shared): fix-watch + circuit-state schema, ceremonies, maxConsecutiveFailures (#3828)`

### Task 2: Circuit service + terminalization chokepoint + admission + reset route

- `classifyTerminal(to, errorCode, runVerdict): 'increment' | 'reset' | 'neutral'` — pure, exhaustive-tested: increment = `failed` with runner/ceiling codes (grep the errorCode values runLoop/runService actually write and enumerate them) OR `completed` with `runVerdict === 'needs_attention'`; reset = clean `completed`, `awaiting_approval`; neutral = `cancelled`, `expired`, `skipped`, `stalled`, `enqueue_failed`.
- `recordRunTerminal(tx-or-db, run, to, patch)` — advisory xact lock `('ai-circuit:' + orgId + ':' + agentId)`, upsert the state row, on threshold breach (consecutive_failures ≥ effective `maxConsecutiveFailures` resolved at that moment) → state open + opened_reason + notify recipients (dedupe key) + audit + `ai.agent.circuit.opened` event? NO new event type this PR (registry ceremony churn) — notification + audit suffice; note as follow-up.
- `transitionRunStatus` calls it when `to` is terminal AND the CAS won; convert `reapStalledAgentRuns` + `failRunAfterEnqueueFailure` to `transitionRunStatus` calls (their patches carried over; behavior byte-identical otherwise — tests). The **terminalization contract test** (source scan: no `.set({ status: 'failed'|'cancelled'|...` on aiAgentRuns outside runService).
- Admission: `if (await isCircuitOpen(orgId, agentId)) return skip('circuit_open')` after the kill-switch rule; `circuit_open` joins `AgentRunSkipReason` + `PUBLISHED_SKIP_REASONS`.
- Reset route: `POST /:id/circuit/reset` — org-scoped (`scopes` + the ai-agents write permission the update route uses — grep it), `requireMfa()`, body `{ reason: string (min 3) }`, resets count + state closed + reset_by/reset_at + audit `ai_agent.circuit_reset`; `GET /:id/circuit` returns the state DTO. Config edits (agentService update) must NOT touch circuit rows — test.
- [x] TDD (classification matrix, lock-serialized concurrent terminals, threshold open exactly-once, reset, contract test red-proof by temporarily restoring a raw writer) → commit: `feat(api): per-org agent circuit breaker with centralized terminalization (#3828)`

### Task 3: Fix-watch service + worker + scheduling

- `scheduleFixWatch(run, outcome)` called from `finishRun` (best-effort, never affects run status): eligibility = `run.alertId` set ∧ act-lane executed action with `verification: 'passed'` ∧ run `completed`; insert watch (denormalize rule_id/device_id/config_item_name from the alert row) + enqueue phase-1 job (`fix-watch-p1-<id>`, delay 5min).
- Worker (`fix-watch` queue): phase 1 — alert resolved/recovered? (status `resolved` — a `dismissed` alert → watch `cancelled` per quorum's "manually dismissed must not establish recovery"; still `active` → re-enqueue phase 1 (+5min) unless created_at + 24h passed → `inconclusive`); resolved → stamp recovery_observed_at, state `watching`, due_at = recovery + 60min, enqueue phase-2 (`fix-watch-p2-<id>`, delay 60min). Phase 2 — recurrence query (same rule+device, `triggeredAt > recovery_observed_at`; rule_id NULL watches (rule-less alerts) match on device + config_item_name): any row → `recurred` + recurrence_alert_id + high-priority notification to the run's snapshot recipients ("The fix for <agent>'s remediation did not hold") + the rule-less attention alert (actVerify template, `configItemName: 'ai_agent_fix_watch'`, context.source `'ai_agent_fix_watch'`) + notified_at; none → `held_qualified` (quiet; evaluated_at stamped).
- Registry entry `fixWatchWorker` (+ snapshots 107 → 108, closure verdict — expect global) + shutdown export + phased-shutdown membership via the registry.
- [x] TDD (eligibility matrix incl. policy-decided exclusion, dismissed→cancelled, flap→recurred, 24h→inconclusive, notification dedupe, jobId idempotency) → commit: `feat(api): fix-held watch — recovery-anchored recurrence checks (#3828)`

### Task 4: Kill-state admin API + runbook + verification + PR

- `routes/admin/aiKillState.ts`: `GET /` (state + epoch), `POST /` `requireMfa()` body `{ killed: boolean, reason: string }` → `bumpAiKillState` + platform_admin audit; mount in admin/index.ts. Runbook: the SQL fallback AND the API, the ≤5s propagation bound, the zero-platform-admins caveat verbatim.
- Full battery: api suite + shared + typecheck + lint (both packages) + drift + contract suites + migration naming; terminalization contract green; registry snapshots consistent.
- [x] Tick checkboxes. **Open the PR**: branch `feature/3821-ai-agents/wave-3828-2` → main, title `feat(api): wave 6.2 — safety controls: fix-held watch, per-org circuit breaker, kill-state admin API`, body: "PR 2 of 4 for #3828 — do NOT close", the constants-v1 watch-window deferral, the no-new-event-type note, the zero-platform-admins flag. **Stop after opening the PR.**

## Self-Review Notes

- The watch never blocks or mutates runs; the circuit never terminates in-flight work (admission-only); both are additive with default-safe states.
- Chokepoint honesty: the contract test is what makes "centralized" true tomorrow, not just today.
- Deferred: watch-window configurability (own merge semantics), `ai.agent.circuit.opened` event type, policy-decided-action watches (needs release-side verification), kill UI.
