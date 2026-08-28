---
tracking_issue: LanternOps/breeze#3821
wave: W06 (#3827) — Part A (inert foundations)
---

# Wave 5 Part A — Policy-Decide Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The inert groundwork for wave 5's policy-satisfied unattended Tier-3 (Part B): the `policy_decision_state` lifecycle column + safe policy-provenance columns on `action_intents`, the `ai_unattended_exposure` blast-cap ledger table (full 5-part tenancy ceremony), the DB-backed `ai_kill_state` (epoch'd, system-scoped, wired into the guardrails as an ADDITIONAL live gate), the `POLICY_DECIDABLE_TIER3` registry module (data + validators), `maxPolicyDecisionsPerDay` + snapshot v3, and the `createActionIntent` refactor that defers human approval fanout behind the decision state — which in this PR **always resolves `human_required`**, so behavior is byte-identical.

**Architecture:** `createActionIntent`'s fanout region (approval-request inserts, no-eligible-approver cancellation) extracts into `runHumanFanout(tx, …)` invoked only after `resolvePolicyDecisionState()` — a PR-A stub returning `'human_required'` unconditionally (Part B replaces it with the real `attemptPolicyDecision`). The exposure ledger and kill state are written by nobody in this PR (ledger) / flippable only via SQL (kill state, default not-killed) — every change is either invisible or a pure tightening.

**Tech Stack:** TypeScript, Drizzle, hand-written SQL migration (ONE file), Vitest. Quorum decisions locked 2026-08-28 (run memory + Part B plan will carry the full record): policy is a mechanism not a principal; `decidedVia: 'policy'` + NULL user + NULL assurance is Part B's discriminator; fanout must never fire before the state resolves; org-wide exposure accounting shared by act + policy lanes; `floor()` percentage semantics without `max(1,·)`.

## Global Constraints

- **Inertness:** every existing intent flow (creation, fanout, cancellation, decide, release) behaves byte-identically. The ONLY observable deltas: new columns default-populated, the kill-state gate (default pass), and the state column stamped `human_required` on every new intent.
- Migration: ONE new file named to sort after the newest committed migration — **check `ls apps/api/migrations/*.sql | sort | tail -1` at implementation time** (was `2026-09-15-ai-agents-act-assets.sql` at plan time → use `2026-09-16-ai-agents-policy-decide-foundations.sql` unless something newer exists). Idempotent throughout; no inner BEGIN/COMMIT; follow `2026-09-13-c-llm-egress-events.sql` as the style template.
- **The 5-part new-table ceremony for `ai_unattended_exposure`** (org-scoped Shape 1): (1) migration w/ forced RLS + `breeze_has_org_access(org_id)` policy + composite `(org_id, partner_id)` FK → organizations CASCADE; (2) `CORE_ORG_CASCADE_DELETE_ORDER` (alphabetical: after `ai_sessions`, before `alert_…`); (3) `CORE_TENANT_EXPORT_POLICY` entry; (4) `orgMergeRegistry.ts` disposition (`leave-for-erasure`, llm_egress_events reasoning); (5) rls-coverage is auto-discovered for Shape 1 — no allowlist edit. Verify cascade FK direction (children-before-parents) — the table references ai_agents/ai_agent_runs/action_intents: it must sort BEFORE them in delete order… it does NOT alphabetically (`ai_unattended_exposure` > `ai_agent_runs`)! **Check the FK direction rule**: give every FK an explicit `ON DELETE CASCADE` (or SET NULL for intent_id) so alphabetical order cannot cause FK violations regardless of position, and note this in the migration comments. Run `tenantCascade.integration.test.ts` reasoning locally if possible; the CI Integration job is authoritative.
- **`ai_kill_state` is system-scoped** (mirror `abuse_sweep_state`, migration `2026-07-25-abuse-script-hosts.sql:56-78`): forced RLS, single system-only policy, no org_id → **register in the rls-coverage `INTENTIONAL_UNSCOPED` allowlist** with a justification comment; no cascade/export/merge entries (no org_id).
- New shared-limits field + snapshot v3: tolerant reads (1|2|3), write-side stamps 3 — grep every `schemaVersion`/`AI_AGENT_POLICY_SNAPSHOT_VERSION` consumer.
- No new env vars. Run tests as `cd apps/api && npx vitest run <path>`; typecheck with the heap bump; shared edits also `pnpm --filter @breeze/shared test`.
- **PR-B pointers, updated post-review (commit c395223b7 "review fixes for wave-5a kill-state"):** `intentReleaseWorker.ts:295-317` (approved-human-request fetch) and `revalidateRelease.ts:41-64` (digest chain) stay byte-identical in this PR. The other two are NOT byte-identical: `agentReleaseAuthority`'s `checkAgentReleaseAuthority` predicate gains its own `readAiKillState()` refresh (~line 184) and a distinct, non-terminal `kill_switch_engaged` verdict (~line 223) instead of the terminal `agent_policy_denied`; `intentReleaseWorker.ts`'s `releaseApprovedIntent` gains a `kill_switch_engaged` branch (~line 373) that routes through a new `pauseIntentForKillSwitch` (~line 103), CASing the intent `executing -> approved` instead of calling `failIntent`. Both are reachable only when `killState.killed` is true, which is false on every seeded row in this PR — so the release lane is **inert while the kill state is not killed**, not untouched. Write the PR body's inertness statement from that corrected framing, not from "release path byte-identical."
- Commit after every task with trailers:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_012o7QB15EFjEvetDAXMxmae`

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/migrations/2026-09-16-ai-agents-policy-decide-foundations.sql` (new) | action_intents columns + `ai_unattended_exposure` + `ai_kill_state`, all idempotent. |
| `apps/api/src/db/schema/actionIntents.ts` + new `aiUnattendedExposure.ts` + `aiKillState.ts` (schema) | Drizzle declarations (drift check must stay clean). |
| `apps/api/src/services/tenantCascade.ts`, `tenantExportPolicyRegistry.ts`, `orgMergeRegistry.ts`, `rls-coverage.integration.test.ts` | Registrations per ceremony. |
| `apps/api/src/services/aiKillState.ts` (new) | Cached reader (fail-closed) + epoch; `setAiKillState` (SQL-only flip surface this PR). |
| `apps/api/src/services/aiGuardrails.ts` (modify) | `checkAgentGuardrails` gains the DB kill-state gate beside the env flag. |
| `apps/api/src/services/actionIntents/policyDecidable.ts` (new) | `POLICY_DECIDABLE_TIER3` registry: entries + key validators (data only; no runtime consumer yet). |
| `apps/api/src/services/actionIntents/intentService.ts` (modify) | `runHumanFanout` extraction + `resolvePolicyDecisionState` stub + state stamping. |
| `packages/shared` types/validators (modify) | `maxPolicyDecisionsPerDay`, snapshot v3. |

---

### Task 1: Migration + Drizzle schema + registrations

**Contract:**
- `action_intents` gains (all `ADD COLUMN IF NOT EXISTS`): `policy_decision_state text NOT NULL DEFAULT 'human_required'` + CHECK `IN ('unattempted','authorized','human_required')` (DEFAULT `human_required` is deliberately the backfill value — every pre-existing row went through human fanout; Part B changes the INSERT-time value to `unattempted`, not the column default); `policy_authorization_key text`, `policy_snapshot_digest text`, `policy_classification_version integer`, `policy_reservation_id uuid`, `policy_kill_epoch bigint` — all nullable, Part-B-written. Export policy: all six columns → `included` (scalar provenance facts, same tier as `decided_via`).
- `ai_unattended_exposure`: `id uuid PK default gen_random_uuid()`, `org_id uuid NOT NULL`, `partner_id uuid NOT NULL`, `agent_id uuid NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE`, `run_id uuid NOT NULL REFERENCES ai_agent_runs(id) ON DELETE CASCADE`, `device_id uuid NOT NULL` (no FK — device rows are deleted/moved independently of exposure history; document), `intent_id uuid REFERENCES action_intents(id) ON DELETE SET NULL`, `source text NOT NULL CHECK (source IN ('act','policy_intent'))`, `reserved_at timestamptz NOT NULL DEFAULT now()`, composite FK `(org_id, partner_id) → organizations(id, partner_id) ON DELETE CASCADE`; indexes `(org_id, reserved_at DESC)` and `(agent_id, reserved_at DESC)`; forced org RLS (llm_egress template verbatim); GRANT to breeze_app. Registrations 2-4 per Global Constraints (export policy: everything `included` — no open containers). Retention: none this PR (no writers exist); Part B adds the sweep — note in the migration comment.
- `ai_kill_state`: `id text PRIMARY KEY DEFAULT 'global'` + CHECK `(id = 'global')`, `killed boolean NOT NULL DEFAULT false`, `epoch bigint NOT NULL DEFAULT 0`, `reason text`, `updated_by uuid` (no FK — may be flipped via SQL by ops), `updated_at timestamptz NOT NULL DEFAULT now()`; forced RLS, system-only policy (abuse_sweep_state verbatim); seed row `INSERT … ON CONFLICT DO NOTHING`; INTENTIONAL_UNSCOPED allowlist entry with comment.
- Drizzle schema files for both tables + the new columns; `pnpm db:check-drift` clean.

- [x] TDD where testable (schema-shape assertions per repo pattern; the ceremony contract tests are the real gate — run what's runnable locally, note the Integration-only suites for CI). Commit: `feat(api): wave-5 foundations schema — policy decision state, exposure ledger, kill state (#3827)`

---

### Task 2: `aiKillState` service + guardrail gate

**Interfaces:** `readAiKillState(): Promise<{ killed: boolean; epoch: number }>` — 5s in-process TTL cache; **fail closed**: a read error returns `{ killed: true, epoch: -1 }` (an unreachable DB must never let agents act; the env kill flag has no such failure mode, the DB one must); `bumpAiKillState(killed, reason, updatedBy?)` — CAS-free single-row UPDATE with `epoch = epoch + 1` (SQL-flip parity documented); `_resetAiKillStateCacheForTest()`.

**Guardrail wiring:** in `checkAgentGuardrails`, directly after the env-flag deny: the DB state is consulted via a SYNCHRONOUS seam — `checkAgentGuardrails` is sync (verify!), so the gate reads a module-level snapshot maintained by the cache (refreshed lazily by callers: `revalidateActExecution` and `isStoppedBeforeStart` call `await readAiKillState()` before invoking the guardrails; the guardrail itself checks the last-known snapshot and denies when `killed`). Document the staleness bound (≤5s cache + call-site refresh). Killed → same deny text pattern as the env flag with the epoch in the reason.

- [x] TDD: fail-closed read; TTL; guardrail denies when snapshot killed; act revalidation path refreshes before guardrail re-run (extend the wave-4 revalidation tests); default state passes everything (inertness). Commit: `feat(api): DB-backed AI kill state with epoch, wired as a live guardrail gate (#3827)`

---

### Task 3: `POLICY_DECIDABLE_TIER3` registry (data + validation only)

**Interfaces:** `interface PolicyDecidableEntry { key: string /* 'tool' or 'tool:action' */; toolName: string; action: string | null; headlessCompatible: boolean; maxTargetCardinality: 1; requiresEffectPin: boolean; note: string }`; `POLICY_DECIDABLE_TIER3: readonly PolicyDecidableEntry[]`; `isPolicyDecidableKey(key: string): boolean`; `validateAuthorizationKeys(keys: string[]): { ok: string[]; rejected: Array<{ key: string; reason: string }> }` — rejects unknown keys, anything in `TIER3_FOUR_EYES_*`, tier-4/blocked/secret-bearing tools, and bare-tool keys for multiplexed tools.

**v1 entry set (conservative; each entry's `headlessCompatible` must be VERIFIED by reading the tool's execution path — a tool that needs an interactive session gets `headlessCompatible: false` and is thereby inert):** `manage_services:start`, `manage_services:stop`, `manage_services:restart`, `manage_startup_items:disable`, `manage_startup_items:enable`, `manage_scheduled_tasks:run`, `manage_scheduled_tasks:disable`, `manage_scheduled_tasks:enable`, `security_scan:quarantine`, `security_scan:remove`, `security_scan:restore`. Explicitly EXCLUDED with comments: `run_script`/`execute_playbook` (the act-mode `actAssets` lane owns script/playbook authorization — one lane per asset class), `execute_command` (program-locked exclusion), `manage_processes:kill` (tool unregistered — #4149), `file_operations`/`registry_operations` (unbounded target surface, need per-entry pins — future quorum), everything four_eyes. Frozen-key-set test + `⊆ TIER3_SUPERVISED` containment test + `∩ TIER3_FOUR_EYES = ∅` test.

- [x] TDD → commit: `feat(api): POLICY_DECIDABLE_TIER3 registry — data + authorization-key validation (#3827)`

---

### Task 4: `createActionIntent` fanout deferral (inert)

**Contract:** extract the fanout region (`intentService.ts:704-813`: `approvalRowFor`/`insertSingleApproverRow`/pool selection/no-eligible-approver cancellation) into `runHumanFanout(tx, args)` — same transaction, same behavior, verbatim logic. The flow becomes: insert intent → `const decisionState = resolvePolicyDecisionState(inserted, guardrail)` (PR-A stub: `return 'human_required';` with the Part-B pointer comment) → stamp `policy_decision_state` on the row (part of the INSERT values, not a second UPDATE — the stub is consulted before insert; on conflict-reuse paths the existing row keeps its state) → `if (decisionState === 'human_required') runHumanFanout(...)` → outbox insert (unconditional, unchanged). Since the stub always returns `human_required`, every test asserting fanout/cancellation/notification behavior passes unchanged — run the FULL intentService + approvals test files and report counts as the inertness proof.

- [x] TDD: new tests assert the state column lands `human_required` on creation + the extraction is behavior-identical (existing suites green untouched). Commit: `refactor(api): defer human approval fanout behind policy_decision_state (inert — always human_required) (#3827)`

---

### Task 5: `maxPolicyDecisionsPerDay` + snapshot v3

Shared types (`AiAgentLimits` + defaults: `maxPolicyDecisionsPerDay: 10`), validator (`int().min(1).max(200)`), min-wins merge (generic loop covers it — add the merge test), `AI_AGENT_POLICY_SNAPSHOT_VERSION` 2→3 with every read site tolerating {1,2,3} (grep them all; the v1→v2 comment discipline at `packages/shared/src/types/aiAgents.ts:118-127` is the template). Unenforced this PR (Part B's decision path consumes it) — add it to the runService limits-coverage inventory comment as DEFERRED-to-Part-B (the wave-4 review lesson).

- [x] TDD → shared + api suites → commit: `feat(shared,api): maxPolicyDecisionsPerDay limit + agent policy snapshot v3 (#3827)`

---

### Task 6: Verification + PR

- [x] Full api suite + shared suite + typecheck + `pnpm db:check-drift`; contract suites (closure/registry/dispatch-boundary/envComposeParity + migration-naming); grep sweeps: no writer of `ai_unattended_exposure` exists; no consumer of `POLICY_DECIDABLE_TIER3` outside its own tests; `runHumanFanout` has exactly one caller.
- [ ] Tick checkboxes. **Open the PR**: `feature/3821-ai-agents/wave-3827` → main, title `feat(api): wave 5 part A — policy-decide foundations (decision-state lifecycle, exposure ledger, kill state)`, body: inertness statement + the quorum pointer + the 5-part ceremony note + Integration-only suites caveat + "Part A of #3827 — do NOT close". **Stop after opening the PR.**

## Self-Review Notes

- Inertness per task: T1 columns default-populated/no writers; T2 default not-killed (pure additive gate); T3 data-only; T4 stub always human_required (full suites = proof); T5 unenforced field.
- The cascade-order FK-direction hazard for `ai_unattended_exposure` is neutralized by explicit ON DELETE on every FK (position-independent) — called out in the migration.
- Part B consumes: `resolvePolicyDecisionState` seam, provenance columns, ledger, kill epoch, registry, the day cap.
