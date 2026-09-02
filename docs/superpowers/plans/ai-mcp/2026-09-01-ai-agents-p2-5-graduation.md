---
tracking_issue: LanternOps/breeze#4187
wave: W05 (#4192) — P2-5 Feedback + graduation (PR A1 evidence + watches, PR A2 graduation + promotion, PR B web)
---

# AI Agents Phase 2 — Wave P2-5: Feedback + Graduation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent earns narrower human supervision by evidence. Every terminal outcome an agent produces — a released action intent, an act-mode manifest execution, a fix-watch verdict, a 👍/👎 on an alert verdict — writes exactly ONE immutable row into a new `ai_agent_op_evidence` ledger keyed by `(source_kind, source_id, metric)`, so BullMQ redelivery can never double-count. A `graduationService` reads that ledger over a 30-day window and moves an `(org, agent, op_key)` tuple through `tracking → eligible → promoted → demoted → tracking`. Promotion is never automatic: it is a Tier-3 **four-eyes** action intent (`manage_ai_agents:authorize_supervised_key`, human-only — a device-bound agent can never propose it) whose executor appends the colon key to the **org** row's `ai_agents.actAssets.supervisedActionKeys` under a per-key advisory lock. Demotion IS automatic and always on: the first ATTEMPTED failure or fix-watch recurrence on a granted key removes it in the same transaction as the negative evidence and notifies the agent's recipients at high priority. A read-only Graduation panel and an "Approve and always allow" affordance on `/approvals` make the whole ledger visible with the policy-decide flag still off.

**Architecture:** One Shape-1 org-scoped ledger (`ai_agent_op_evidence`) plus one Shape-1 state table (`ai_agent_graduation`); no daily counter buckets (they cannot be incremented exactly-once, and a timestamped ledger answers "since `demoted_at`" unambiguously where a `date` bucket cannot). Evidence writers are folded into transactions that already exist: the release worker's terminal CAS (one outer `withSystemDbAccessContext`, which every nested DB context joins — `db/index.ts:526-528`), `finishRun`'s post-CAS section, the fix-watch phase-2 verdict CAS, and the verdict-feedback update. Fix watches become **intent-anchored** as well as run-anchored (`intent_id` + partial UNIQUE, `source_kind`, `op_keys[]`), so N independently-released intents from one run each get their own verification episode instead of sharing one run-unique watch. The BLOCKER fix that makes any of this mean something: partner `supervisedActionKeys` become a **ceiling**, not an inherited grant — with no org row the effective key set is `[]`, so promotion (an org-row append) is the only way a key goes live, and demotion (an org-row removal) actually revokes.

**Tech Stack:** TypeScript, Hono, Drizzle, BullMQ, Postgres 15+ (partial unique indexes, `pg_advisory_xact_lock`), Claude Agent SDK MCP tools, Zod, Vitest, React + Astro + react-i18next (8 locales).

**Spec:** `docs/superpowers/specs/ai-mcp/2026-08-28-ai-agents-phase2-intelligence-layer-design.md` §4.5 (lines 141-162), §5 P2-5 rows (lines 187-189, 192), §6 rows (lines 202, 205-206, 208). **This plan amends the spec (Task 0)** per the advisor quorum (Fable + Codex `gpt-5.6-sol` xhigh read-only, 2026-09-01; contract `p2-5-contract.md` C1–C16, all eight ranked Codex amendments adopted): the spec's `ai_agent_op_stats_daily` is **dropped** and replaced by the exactly-once `ai_agent_op_evidence` ledger (C1); `ai_agent_graduation` gains a fourth state `tracking` (C2); partner supervised keys become a ceiling rather than inherited authority (C3, release-blocking); "success" is decomposed into `executed` / `verified` / `failed` / `recurred` with `failed` counting ATTEMPTED failures only (C4); fix watches become intent-anchored (C5, closes #4206); sweep act auto-execution is OUT of P2-5 and moves to roadmap **#4442** (C13).

## Global Constraints

- Tests: `cd apps/api && npx vitest run <path>`; shared: `cd packages/shared && npx vitest run <path>`; web: `cd apps/web && npx vitest run <path>` + `src/lib/i18n/localeParity.test.ts` + `src/lib/i18n/translationCoverage.test.ts` + `src/lib/__tests__/no-silent-mutations.test.ts`. Add `--pool=threads --maxWorkers=2` when a dev stack is running; **a 0-test run is a stall, not green** — always check the reported file count. Never write `pnpm --filter <pkg> test -- --run <path>` (the `--` makes vitest run the whole suite in watch mode). Typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`; web `cd apps/web && npx astro check`. `pnpm lint` in every touched package.
- **One migration, in PR A1**: `apps/api/migrations/2026-09-29-ai-agents-graduation-evidence.sql` — the newest COMMITTED migration is `2026-09-28-quickbooks-entity-mappings.sql` (verified via `git ls-files apps/api/migrations | sort | tail`), so this name sorts last today. **Re-verify immediately before opening PR A1 and rename if W06's `2026-09-30-…` landed first** (see Final verification). Idempotent throughout (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` + re-add, `DO $$ … EXCEPTION WHEN duplicate_object`); no inner `BEGIN;`/`COMMIT;` (`autoMigrate` already wraps each file); explicit `ON DELETE` on every FK; never edit a shipped migration — the existing `ai_agent_fix_watches_run_id_uq` UNIQUE **constraint** is replaced by a same-named partial unique **index** via `DROP CONSTRAINT IF EXISTS` + `CREATE UNIQUE INDEX IF NOT EXISTS` in the NEW file.
- **Registries for the two new tables** (these contract suites only fail under **Integration Tests**, never **Test API** — a stale base can go green and redden main): `ai_agent_graduation` and `ai_agent_op_evidence` → `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts`, alphabetical: both slot between `'ai_agent_fix_watches'` at line 82 and `'ai_agent_runs'` at line 83, graduation first — verified with `localeCompare`), `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts`, alphabetical between the `ai_agent_fix_watches` entry at line 53 and `ai_agent_runs` at line 59), `orgMergeRegistry.ts` `SPECIAL` as `leave-for-erasure`. Both are Shape 1 (`org_id NOT NULL` + `breeze_has_org_access(org_id)`) so they are **auto-discovered by `rls-coverage.integration.test.ts` — do NOT add them to any RLS allowlist**. Column add on an already-registered table: `ai_agent_fix_watches.op_keys` / `.intent_id` / `.source_kind` → all three must be classified in that table's `CORE_TENANT_EXPORT_POLICY` entry (`included`; `op_keys` is `text[]`, not jsonb, so `included` is correct — precedent `ai_agent_schedules.sweep_kinds`). Neither table is append-only, so neither goes in `AUDIT_ADMIN_REQUIRED_TABLES`.
- Policy snapshot `AI_AGENT_POLICY_SNAPSHOT_VERSION` **8 → 9** for the new `promoteThreshold` limit; `schemaVersion: 1 | … | 9`; every read tolerates 1–9 via `?? AI_AGENT_LIMIT_DEFAULTS.promoteThreshold`. `promoteThreshold` is the FIRST limit merged with `Math.max` instead of `Math.min` (a partner raising the bar must not be undercut by an org lowering it) — that exception lives in one named set in `effectivePolicy.ts`, never inline.
- **No `'verdict'` / `'sweep'` / `'narrative'` / `'triage'` profile literal may be introduced into** `services/aiGuardrails.ts`, `services/aiAgents/executionLedger.ts`, `services/actionIntents/policyDecide.ts`, `services/aiAgents/actRevalidation.ts` (`verdictProfile.contract.test.ts:18-22` FORBIDDEN list, regexes at `:27-40`). The evidence namespace literal `'alert_verdict'` does NOT match its `/['"]verdict['"]/` regex (that regex matches the exact quoted word), but none of these four files gains an evidence writer anyway — keep it that way.
- **Leak rules:** no model-authored text in any notification, audit `details`, Sentry tag, or evidence row. Evidence rows carry identifiers only (`op_key`, `rule_id`, ids, timestamps) — never a tool result, alert message, or rationale. The demote notification names the agent and the op key, nothing else (mirror `sendRecurrenceNotifications`, `fixWatch.ts:292-336`).
- **Tenancy invariants:** every new loader predicates by `org_id` explicitly under the system context (RLS passes unconditionally there); every write pins `org_id`; composite same-org FKs make a forged cross-tenant pointer a 23503 even under system context — `(promoted_intent_id, org_id) → action_intents(id, org_id)` (target `action_intents_id_org_uq` exists, `actionIntents.ts:399`), `(run_id, org_id) → ai_agent_runs(id, org_id)` (target `ai_agent_runs_id_org_uq` exists, `aiAgents.ts:161`), `(intent_id, org_id) → action_intents(id, org_id)` on the watch.
- Commit after every task with trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Run `get_feature_status LanternOps/breeze#4187` before starting, and `start_wave` for #4192.
- Branches: PR A1 = `feature/4187-ai-agents-p2/wave-4192` (base main), PR A2 = `feature/4187-ai-agents-p2/wave-4192-a2` (base main, opened after A1 merges), PR B = `feature/4187-ai-agents-p2/wave-4192-b` (base main, opened after A2 merges). All three target **main**, so all three get normal PR CI — do NOT stack them on each other (a PR based on a sibling branch runs no CI at all).

## File Structure

### PR A1 — evidence ledger + intent-anchored watches (`Part of #4192`)

| File | Responsibility |
|---|---|
| spec §4.2/§4.5/§5/§6 + `services/actionIntents/intentService.ts` comment (modify) | Amendments, sweep act auto-exec → #4442 (Task 0). |
| `packages/shared/src/types/aiAgentGraduation.ts` (new), `validators/aiAgentGraduation.ts` (new), `types/aiAgents.ts`, `validators/aiAgents.ts`, barrels (modify) | Evidence/graduation enums + DTOs, `promoteThreshold`, limits v9 (Task 1). |
| `apps/api/migrations/2026-09-29-ai-agents-graduation-evidence.sql` (new) | Both tables, fix-watch columns/constraint swap, RLS, grants (Task 2). |
| `apps/api/src/db/schema/aiAgentOpEvidence.ts` (new), `aiAgentGraduation.ts` (new), `aiAgentFixWatches.ts`, `schema/index.ts`, `services/tenantCascade.ts`, `tenantExportPolicyRegistry.ts`, `orgMergeRegistry.ts` (modify) | Drizzle + the four registries (Task 2). |
| `apps/api/src/services/actionIntents/canonicalPolicyKey.ts` (new), `policyDecide.ts` (modify); `apps/api/src/services/aiAgents/opEvidence.ts` (new) | One canonical `tool:action` resolver; exactly-once evidence writer (Task 3). |
| `apps/api/src/jobs/intentReleaseWorker.ts` (modify) | Terminalization inside one system transaction + intent evidence + attempted/not-attempted classification (Task 4). |
| `apps/api/src/services/aiAgents/fixWatch.ts`, `apps/api/src/jobs/fixWatchWorker.ts`, `apps/api/src/jobs/queueSchemas.ts` (modify) | `createIntentFixWatchRow`, `op_keys` snapshot, durable enqueue + recovery sweep (Task 5). |
| `apps/api/src/services/aiAgents/fixWatch.ts`, `runLoop.ts` (modify) | Watch-verdict evidence (`verified` / `recurred`) + act-op evidence at `finishRun` (Task 6). |
| `apps/api/src/services/aiAgents/alertVerdicts.ts` (modify) | `FOR UPDATE` feedback capture + `verdict_feedback` evidence upsert (Task 7). |
| `apps/api/src/services/aiAgents/agentService.ts` (modify) | `updateAgent` row lock + shared `withAgentRowLocked` helper (Task 8). |
| `apps/api/src/jobs/aiAgentGraduationWorker.ts` (new), `jobs/scheduleRegistry.ts`, `services/workerRegistry.ts`, `services/workerEntrypointClosure.contract.test.ts` (modify) | Evidence retention (400 d) + the queue A2 extends (Task 9). |
| `apps/api/src/__tests__/integration/aiAgentOpEvidence.integration.test.ts` (new) | Exactly-once under redelivery, RLS forge, erasure, org-merge (Task 10). |

### PR A2 — graduation, promotion, demotion (`Part of #4192`)

| File | Responsibility |
|---|---|
| `apps/api/src/services/aiAgents/effectivePolicy.ts` + `.test.ts`, `effectivePolicy.ceiling.contract.test.ts` (new), `docs/deploy/…` runbook (modify) | Partner keys become a ceiling; `promoteThreshold` merged with `max` (Task 11). |
| `apps/api/src/services/aiAgents/graduationService.ts` (new) + `.test.ts` | Window query, eligibility, state machine, advisory lock (Task 12). |
| `apps/api/src/jobs/aiAgentGraduationWorker.ts`, `jobs/scheduleRegistry.ts` (modify) | Daily evaluation repeatable (Task 13). |
| `apps/api/src/services/aiToolsAiAgentGovernance.ts` (new), `aiTools.ts`, `aiToolSchemas.ts`, `aiAgentSdkTools.ts`, `aiGuardrails.ts`, `aiGuardrails.approvalScope.contract.test.ts`, `actionIntents/effectDigest.ts`, `apps/web/src/components/ai-risk/tierConfig.ts`, `apps/docs/src/content/docs/features/ai.mdx` (modify) | `manage_ai_agents:authorize_supervised_key` — every mandatory wiring point (Task 14). |
| `apps/api/src/services/aiAgents/supervisedKeyGrant.ts` (new), `aiToolsAiAgentGovernance.ts` (modify) | Promote executor under the advisory lock (Task 15). |
| `apps/api/src/services/aiAgents/supervisedKeyGrant.ts`, `fixWatch.ts`, `apps/api/src/jobs/intentReleaseWorker.ts` (modify) | Auto-demote on attempted failure / recurrence (Task 16). |
| `apps/api/src/services/orgMergeCustomExecutors.ts` (modify) | Strip `supervisedActionKeys` from repointed org agent rows (Task 17). |
| `apps/api/src/routes/aiAgents.ts` (modify), `packages/shared/src/types/aiAgentGraduation.ts` (modify) | `GET /ai/agents/graduation`, `POST /ai/agents/graduation/promote` (Task 18). |
| `apps/api/src/__tests__/integration/aiAgentGraduation.integration.test.ts` (new) | End-to-end: evidence → eligible → four-eyes promote → policy-decide sees the key → attempted failure → demoted → notified (Task 19). |

### PR B — web (`Closes #4192`)

| File | Responsibility |
|---|---|
| `apps/web/src/components/settings/AiAgentGraduationPanel.tsx` (new), `AiAgentForm.tsx` (modify), `locales/*/settings.json` | Graduation panel, act-op reliability, Promote button, partner ceiling hint (Task 20). |
| `apps/web/src/components/approvals/ApprovalsInbox.tsx` (modify), `locales/*/approvals.json` | "Approve and always allow" on eligible supervised agent cards (Task 21). |

---

## PR A1 — evidence ledger + intent-anchored watches

### Task 0 (A1-0): Spec + code-comment amendments

**Files:**
- Modify: `docs/superpowers/specs/ai-mcp/2026-08-28-ai-agents-phase2-intelligence-layer-design.md` (§4.2 line 102, §4.5 lines 141-162, §5 lines 187-189 + 192, §6 lines 202 + 205)
- Modify: `apps/api/src/services/actionIntents/intentService.ts` lines 424-439 (the `hasScope` gate's comment)

**Interfaces:** none (documentation only).

- [ ] **Step 1:** Append immediately after §4.5's heading line 141, before the `**Stats.**` paragraph:
```markdown
**Amendment (P2-5 plan, 2026-09-01, quorum):** `ai_agent_op_stats_daily` is DROPPED and replaced by `ai_agent_op_evidence` — one immutable row per outcome, UNIQUE `(source_kind, source_id, metric)`, inserted `ON CONFLICT DO NOTHING` inside the transaction that terminalizes the outcome. Daily counter buckets cannot be incremented exactly-once under BullMQ redelivery (`count = count + excluded.count` is not idempotent) and a `date` bucket cannot distinguish evidence before and after a same-day `demoted_at`; every aggregate is a GROUP BY over the ledger instead, and a 400-day retention job prunes it. The vocabulary is four metrics, not "success/failure": `executed` (attempted AND the executor reported success), `verified` (`executed` AND a fix-watch reached `held_qualified`, or no eligible watch existed for that source), `failed` (**ATTEMPTED** failure only — the terminal write stamps `executed_at`; revalidation refusals, `session_required`, `connection_unavailable` and pre-execution digest stops are NOT failures), `recurred` (fix-watch `recurred`). Fix watches become **intent-anchored** as well as run-anchored (`intent_id` + partial UNIQUE, `source_kind`, `op_keys[]`) so N independently released intents from one run each get their own verification episode — the run-unique watch mis-attributed them (closes #4206). `ai_agent_graduation` gains a fourth state `tracking`. **Partner `supervisedActionKeys` become a CEILING, not inherited authority**: with no org row the effective key set is `[]` (today `mergeAgentPolicies` returns the partner policy verbatim, `effectivePolicy.ts:135-159`), so an org-level promote is the only thing that makes a key live and an auto-demote actually revokes one. `promoteThreshold` is a new v9 limit merged with `max`, not `min`. Promotion is human-only: `manage_ai_agents` is denied to the `ai_agent` principal in `checkAgentGuardrails`. Four-eyes here means requester + one DIFFERENT approver, first eligible approval wins (`decideApprovalRequest.ts:964-1009`), and the sole-operator WebAuthn self-approval exception (`intentService.ts:574-586`) applies unchanged. Eligibility, promotion and negative evidence all serialize on `pg_advisory_xact_lock` over `(org_id, agent_id, op_key)`.
```
- [ ] **Step 2:** §5 table edits. Replace the `ai_agent_op_stats_daily` row (line 187) with:
```markdown
| `ai_agent_op_evidence` | `id, org_id, agent_id FK ai_agents CASCADE, namespace CHECK IN ('policy_key','act_op','alert_verdict'), op_key text, rule_id uuid NULL (no FK — historical), source_kind CHECK IN ('intent','watch','act_execution','verdict_feedback'), source_id text, metric CHECK IN ('executed','verified','failed','recurred','feedback_up','feedback_down'), run_id NULL composite FK (run_id, org_id) → ai_agent_runs(id, org_id) SET NULL, occurred_at, created_at`; UNIQUE `(source_kind, source_id, metric)`; partial UNIQUE `(source_id) WHERE source_kind = 'verdict_feedback'`; index `(org_id, agent_id, namespace, op_key, occurred_at DESC)` | shape 1; every column `included` | P2-5 |
```
Replace the `ai_agent_graduation` row's state CHECK (line 188) with `CHECK IN ('tracking','eligible','promoted','demoted')` and its `promoted_intent_id` clause with `promoted_intent_id NULL, composite FK (promoted_intent_id, org_id) → action_intents(id, org_id) ON DELETE SET NULL`. Replace the `ai_agent_fix_watches.op_keys` row (line 189) with:
```markdown
| `ai_agent_fix_watches`: `op_keys text[] NOT NULL DEFAULT '{}'`, `intent_id uuid NULL` (composite FK `(intent_id, org_id) → action_intents(id, org_id)`, partial UNIQUE `(intent_id) WHERE intent_id IS NOT NULL`), `source_kind text NOT NULL DEFAULT 'act_run' CHECK IN ('act_run','intent')`; the existing `run_id` UNIQUE becomes partial `WHERE source_kind = 'act_run'` | column adds → `included` | existing | P2-5 |
```
On line 192, change `promoteThreshold` (20, 5–200)` to `promoteThreshold` (20, 5–200, merged with **max**)` and `snapshot v4 → v5` to `snapshot v8 → v9 (promoteThreshold only)`.
- [ ] **Step 3:** §4.2 line 102 — replace `**Act-mode auto-execution of sweep proposals (the "child run") is deferred to P2-5**` with `**Act-mode auto-execution of sweep proposals (the "child run") is roadmap #4442, NOT P2-5**`. §6 line 202 — replace the Sweep-remediation row's Path cell `existing \`recordProposal\` → auto / inbox / policy-decide` with `existing \`recordProposal\` → supervised inbox card; auto-execution is roadmap #4442`. §6 line 205 — replace `inbox, two approvers` with `inbox; requester + one different approver (first eligible approval wins), human-only principal`.
- [ ] **Step 4:** `intentService.ts` — in the comment block above the `if (args.hasScope) return 'human_required';` gate (lines 424-439), replace the closing sentence `Act-mode auto-execution for sweeps arrives with P2-5, behind its own review, and is expected to REPLACE this line rather than route around it.` with `Act-mode auto-execution for sweeps is roadmap #4442 (explicitly OUT of P2-5, quorum 2026-09-01), behind its own review, and is expected to REPLACE this line rather than route around it.`
- [ ] **Step 5:** `cd apps/api && npx vitest run src/services/actionIntents/intentService` — PASS (comment-only change; confirms nothing pinned the old string).
- [ ] **Step 6:** Commit: `git add docs/superpowers/specs/ai-mcp/2026-08-28-ai-agents-phase2-intelligence-layer-design.md apps/api/src/services/actionIntents/intentService.ts && git commit -m "docs(spec): P2-5 quorum amendments — evidence ledger, partner ceiling, attempted-failure vocabulary, sweep auto-exec to #4442 (#4192)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`

### Task 1 (A1-1): Shared types, validators, limits v9

**Files:**
- Create: `packages/shared/src/types/aiAgentGraduation.ts`, `packages/shared/src/validators/aiAgentGraduation.ts`, `packages/shared/src/validators/aiAgentGraduation.test.ts`
- Modify: `packages/shared/src/types/aiAgents.ts` (`AiAgentLimits` line 22-113, `AI_AGENT_LIMIT_DEFAULTS` line 116, `AI_AGENT_POLICY_SNAPSHOT_VERSION` line 418, `schemaVersion` union line 422), `packages/shared/src/validators/aiAgents.ts` (`limitsFields` lines 33-72), `packages/shared/src/types/index.ts`, `packages/shared/src/validators/index.ts`

**Interfaces (produced):**
```ts
// packages/shared/src/types/aiAgentGraduation.ts
export const AI_AGENT_EVIDENCE_NAMESPACES = ['policy_key', 'act_op', 'alert_verdict'] as const;
export type AiAgentEvidenceNamespace = (typeof AI_AGENT_EVIDENCE_NAMESPACES)[number];

export const AI_AGENT_EVIDENCE_SOURCE_KINDS = ['intent', 'watch', 'act_execution', 'verdict_feedback'] as const;
export type AiAgentEvidenceSourceKind = (typeof AI_AGENT_EVIDENCE_SOURCE_KINDS)[number];

export const AI_AGENT_EVIDENCE_METRICS = ['executed', 'verified', 'failed', 'recurred', 'feedback_up', 'feedback_down'] as const;
export type AiAgentEvidenceMetric = (typeof AI_AGENT_EVIDENCE_METRICS)[number];

export const AI_AGENT_GRADUATION_STATES = ['tracking', 'eligible', 'promoted', 'demoted'] as const;
export type AiAgentGraduationState = (typeof AI_AGENT_GRADUATION_STATES)[number];

export const AI_AGENT_GRADUATION_BLOCKED_REASONS = [
  'needs_partner_baseline', 'below_threshold', 'too_recent', 'has_failures', 'not_policy_decidable',
] as const;
export type AiAgentGraduationBlockedReason = (typeof AI_AGENT_GRADUATION_BLOCKED_REASONS)[number];

/** Literal `op_key` every `alert_verdict`-namespace evidence row carries. */
export const AI_AGENT_ALERT_VERDICT_OP_KEY = 'alert_verdict';
/** Trailing evidence window, in days. */
export const AI_AGENT_GRADUATION_WINDOW_DAYS = 30;
/** Minimum age of the window's first `verified` row before a key can graduate. */
export const AI_AGENT_GRADUATION_MIN_AGE_DAYS = 14;
/** Evidence retention — bounded by executions/watches/verdicts per day, so no rollup is needed. */
export const AI_AGENT_EVIDENCE_RETENTION_DAYS = 400;

export interface AiAgentGraduationWindow {
  executed: number; verified: number; failed: number; recurred: number;
  firstVerifiedAt: string | null;   // ISO
}
export interface AiAgentGraduationRowDto {
  opKey: string;
  namespace: AiAgentEvidenceNamespace;
  state: AiAgentGraduationState;
  window: AiAgentGraduationWindow;
  blockedReason: AiAgentGraduationBlockedReason | null;
  promotedAt: string | null;
  demotedAt: string | null;
  demoteReason: string | null;
}
export interface AiAgentActOpReliabilityDto {
  opKey: string; executed: number; verified: number; failed: number; recurred: number;
}
export interface AiAgentGraduationDto {
  version: 1;
  agentId: string;
  ownerScope: 'partner' | 'organization';
  rows: AiAgentGraduationRowDto[];
  actOpReliability: AiAgentActOpReliabilityDto[];
  promoteThreshold: number;
  policyDecideEnabled: boolean;
}
export interface AiAgentGraduationByOrgDto {
  version: 1;
  promoteThreshold: number;
  policyDecideEnabled: boolean;
  // Final review (A2): the fan-out is capped at AI_AGENT_GRADUATION_BY_ORG_LIMIT
  // (400) orgs by name and batched 25 per system transaction. True when the
  // caller has more; the panel must say so and point at the `?orgId=` form.
  byOrgTruncated: boolean;
  byOrg: Array<{
    orgId: string; orgName: string; agentId: string;
    rows: AiAgentGraduationRowDto[];
    actOpReliability: AiAgentActOpReliabilityDto[];
  }>;
}
```
```ts
// packages/shared/src/validators/aiAgentGraduation.ts
import { z } from 'zod';
export const promoteSupervisedKeyRequestSchema = z.object({
  orgId: z.string().uuid(),
  kind: z.enum(AI_AGENT_KINDS),          // reuse the existing shared kind enum
  opKey: z.string().min(3).max(120).regex(/^[a-z0-9_]+:[a-z0-9_]+$/),
}).strict();
export type PromoteSupervisedKeyRequest = z.infer<typeof promoteSupervisedKeyRequestSchema>;
```
- `types/aiAgents.ts`: `AiAgentLimits` gains `promoteThreshold: number;` with a doc comment "v9 (P2-5) — verified-evidence count a colon key must reach before it becomes promote-eligible. Merged with `max`, not `min`: a partner raising the bar must not be undercut by an org lowering it."; `AI_AGENT_LIMIT_DEFAULTS` gains `promoteThreshold: 20`; `AI_AGENT_POLICY_SNAPSHOT_VERSION = 9 as const`; `schemaVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9`.
- `validators/aiAgents.ts` `limitsFields`: `promoteThreshold: z.number().int().min(5).max(200),`.
- Barrels: `export * from './aiAgentGraduation';` in both `types/index.ts` and `validators/index.ts`.

- [ ] **Step 1:** Write `packages/shared/src/validators/aiAgentGraduation.test.ts` FIRST with these failing assertions: `promoteSupervisedKeyRequestSchema` accepts `{ orgId: <uuid>, kind: 'triage', opKey: 'manage_services:restart' }`; rejects `opKey: 'manage_services.restart'` (dot key — act-op keys are never promotable); rejects an unknown extra field (strict); rejects a non-uuid `orgId`. Add to the existing shared limits test (find it: `grep -rln 'maxTriageRunsPerHour' packages/shared/src`) assertions that `AI_AGENT_LIMIT_DEFAULTS.promoteThreshold === 20`, `AI_AGENT_POLICY_SNAPSHOT_VERSION === 9`, and that `limitsFields.parse` rejects `promoteThreshold: 4` and `promoteThreshold: 201`.
- [ ] **Step 2:** Run `cd packages/shared && npx vitest run src/validators/aiAgentGraduation.test.ts` — expect FAIL (`Cannot find module './aiAgentGraduation'`).
- [ ] **Step 3:** Implement `types/aiAgentGraduation.ts`, `validators/aiAgentGraduation.ts`, the `aiAgents.ts` / `validators/aiAgents.ts` edits, and both barrel exports.
- [ ] **Step 4:** Run `cd packages/shared && npx vitest run src/validators/aiAgentGraduation.test.ts src/validators/aiAgents.test.ts src/types` — PASS (check the file count is > 0); then `cd packages/shared && npx tsc --noEmit -p tsconfig.json`.
- [ ] **Step 5:** Commit: `git add packages/shared && git commit -m "feat(shared): P2-5 evidence/graduation types, promoteThreshold limit, snapshot v9 (#4192)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`

### Task 2 (A1-2): Migration, Drizzle schemas, four registries

**Files:**
- Create: `apps/api/migrations/2026-09-29-ai-agents-graduation-evidence.sql`, `apps/api/src/db/schema/aiAgentOpEvidence.ts`, `apps/api/src/db/schema/aiAgentGraduation.ts`
- Modify: `apps/api/src/db/schema/aiAgentFixWatches.ts` (columns block lines 20-50, options block lines 51-55), `apps/api/src/db/schema/index.ts` (after line 58), `apps/api/src/services/tenantCascade.ts` (lines 81-83), `apps/api/src/services/tenantExportPolicyRegistry.ts` (lines 53-59), `apps/api/src/services/orgMergeRegistry.ts` (`SPECIAL`, near the `ai_agent_fix_watches` entry at line 166)

**Interfaces (produced):**
```ts
// apps/api/src/db/schema/aiAgentOpEvidence.ts
export const aiAgentOpEvidence = pgTable('ai_agent_op_evidence', { … });
export type AiAgentOpEvidenceRow = typeof aiAgentOpEvidence.$inferSelect;
export type NewAiAgentOpEvidenceRow = typeof aiAgentOpEvidence.$inferInsert;
// apps/api/src/db/schema/aiAgentGraduation.ts
export const aiAgentGraduation = pgTable('ai_agent_graduation', { … });
export type AiAgentGraduationRow = typeof aiAgentGraduation.$inferSelect;
export type NewAiAgentGraduationRow = typeof aiAgentGraduation.$inferInsert;
// apps/api/src/db/schema/aiAgentFixWatches.ts (added columns)
//   intentId: uuid('intent_id'), sourceKind: text('source_kind').$type<'act_run' | 'intent'>().notNull().default('act_run'),
//   opKeys: text('op_keys').array().notNull().default(sql`'{}'::text[]`)
```

**Migration contents, in this order (every statement idempotent, no inner BEGIN/COMMIT):**
```sql
-- P2-5 (#4192) — graduation evidence ledger + graduation state + intent-anchored fix watches.
-- Quorum contract C1/C2/C5. Shape-1 org tenancy throughout (auto-discovered by rls-coverage).

-- ---------------------------------------------------------------- 1. evidence ledger
CREATE TABLE IF NOT EXISTS ai_agent_op_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  namespace text NOT NULL CONSTRAINT ai_agent_op_evidence_namespace_chk
    CHECK (namespace IN ('policy_key','act_op','alert_verdict')),
  op_key text NOT NULL,
  -- Deliberately NO foreign key: a historical copy of the triggering rule, the
  -- same treatment ai_agent_fix_watches.rule_id gets. An ON DELETE SET NULL
  -- here would collapse several rows onto a single NULL key and break the
  -- uniqueness this table exists for.
  rule_id uuid,
  source_kind text NOT NULL CONSTRAINT ai_agent_op_evidence_source_kind_chk
    CHECK (source_kind IN ('intent','watch','act_execution','verdict_feedback')),
  source_id text NOT NULL,
  metric text NOT NULL CONSTRAINT ai_agent_op_evidence_metric_chk
    CHECK (metric IN ('executed','verified','failed','recurred','feedback_up','feedback_down')),
  run_id uuid,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Composite same-org provenance FK. ai_agent_runs_id_org_uq already exists
-- (renamed by 2026-09-25-ai-agents-ticket-triage.sql) — do not recreate it.
DO $$ BEGIN
  ALTER TABLE ai_agent_op_evidence ADD CONSTRAINT ai_agent_op_evidence_run_org_fk
    FOREIGN KEY (run_id, org_id) REFERENCES ai_agent_runs (id, org_id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Exactly-once under BullMQ redelivery: a no-op INSERT means "already counted".
CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_op_evidence_source_metric_uq
  ON ai_agent_op_evidence (source_kind, source_id, metric);
-- A re-vote UPDATEs the single feedback row's metric in place; never a negative delta.
CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_op_evidence_feedback_uq
  ON ai_agent_op_evidence (source_id) WHERE source_kind = 'verdict_feedback';
CREATE INDEX IF NOT EXISTS ai_agent_op_evidence_window_idx
  ON ai_agent_op_evidence (org_id, agent_id, namespace, op_key, occurred_at DESC);
CREATE INDEX IF NOT EXISTS ai_agent_op_evidence_prune_idx
  ON ai_agent_op_evidence (occurred_at);

ALTER TABLE ai_agent_op_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_agent_op_evidence FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON ai_agent_op_evidence;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON ai_agent_op_evidence;
DROP POLICY IF EXISTS breeze_org_isolation_update ON ai_agent_op_evidence;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON ai_agent_op_evidence;
CREATE POLICY breeze_org_isolation_select ON ai_agent_op_evidence
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON ai_agent_op_evidence
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON ai_agent_op_evidence
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON ai_agent_op_evidence
  FOR DELETE USING (public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_agent_op_evidence TO breeze_app;

-- ---------------------------------------------------------------- 2. graduation state
CREATE TABLE IF NOT EXISTS ai_agent_graduation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  op_key text NOT NULL,
  state text NOT NULL DEFAULT 'tracking' CONSTRAINT ai_agent_graduation_state_chk
    CHECK (state IN ('tracking','eligible','promoted','demoted')),
  first_verified_at timestamptz,
  promoted_at timestamptz,
  promoted_intent_id uuid,
  demoted_at timestamptz,
  demote_reason text,
  demote_run_id uuid,
  demote_watch_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  ALTER TABLE ai_agent_graduation ADD CONSTRAINT ai_agent_graduation_intent_org_fk
    FOREIGN KEY (promoted_intent_id, org_id) REFERENCES action_intents (id, org_id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_graduation_key_uq
  ON ai_agent_graduation (org_id, agent_id, op_key);
ALTER TABLE ai_agent_graduation ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_agent_graduation FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON ai_agent_graduation;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON ai_agent_graduation;
DROP POLICY IF EXISTS breeze_org_isolation_update ON ai_agent_graduation;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON ai_agent_graduation;
CREATE POLICY breeze_org_isolation_select ON ai_agent_graduation
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON ai_agent_graduation
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON ai_agent_graduation
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON ai_agent_graduation
  FOR DELETE USING (public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_agent_graduation TO breeze_app;

-- ---------------------------------------------------- 3. intent-anchored fix watches
ALTER TABLE ai_agent_fix_watches ADD COLUMN IF NOT EXISTS intent_id uuid;
ALTER TABLE ai_agent_fix_watches ADD COLUMN IF NOT EXISTS source_kind text NOT NULL DEFAULT 'act_run';
ALTER TABLE ai_agent_fix_watches ADD COLUMN IF NOT EXISTS op_keys text[] NOT NULL DEFAULT '{}';
ALTER TABLE ai_agent_fix_watches DROP CONSTRAINT IF EXISTS ai_agent_fix_watches_source_kind_chk;
ALTER TABLE ai_agent_fix_watches ADD CONSTRAINT ai_agent_fix_watches_source_kind_chk
  CHECK (source_kind IN ('act_run','intent'));
ALTER TABLE ai_agent_fix_watches DROP CONSTRAINT IF EXISTS ai_agent_fix_watches_intent_shape_chk;
ALTER TABLE ai_agent_fix_watches ADD CONSTRAINT ai_agent_fix_watches_intent_shape_chk
  CHECK ((source_kind = 'intent') = (intent_id IS NOT NULL));
DO $$ BEGIN
  ALTER TABLE ai_agent_fix_watches ADD CONSTRAINT ai_agent_fix_watches_intent_org_fk
    FOREIGN KEY (intent_id, org_id) REFERENCES action_intents (id, org_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_fix_watches_intent_uq
  ON ai_agent_fix_watches (intent_id) WHERE intent_id IS NOT NULL;
-- The shipped run_id UNIQUE is total; an act run may now also spawn N intent
-- watches, so it becomes partial. DROP the CONSTRAINT (2026-09-16 shipped it
-- as a named constraint, not a bare index) then recreate it as a partial index
-- under the SAME name so nothing that inspects the name by string breaks.
ALTER TABLE ai_agent_fix_watches DROP CONSTRAINT IF EXISTS ai_agent_fix_watches_run_id_uq;
DROP INDEX IF EXISTS ai_agent_fix_watches_run_id_uq;
CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_fix_watches_run_id_uq
  ON ai_agent_fix_watches (run_id) WHERE source_kind = 'act_run';
CREATE INDEX IF NOT EXISTS ai_agent_fix_watches_pending_recovery_idx
  ON ai_agent_fix_watches (created_at) WHERE state = 'pending';
```
- Drizzle mirrors: `aiAgentOpEvidence` / `aiAgentGraduation` use `pgTable(name, cols, (t) => [ … ])` with `uniqueIndex('…_uq').on(…)` (+ `.where(sql\`…\`)` for the two partial ones) and `index('…').on(…)`, and `foreignKey({ columns, foreignColumns, name }).onDelete('set null')` for the composite FKs — copy the shape from `apps/api/src/db/schema/ticketDrafts.ts`'s composite-FK block. `aiAgentFixWatches.ts` replaces `unique('ai_agent_fix_watches_run_id_uq').on(t.runId)` (line 52) with `uniqueIndex('ai_agent_fix_watches_run_id_uq').on(t.runId).where(sql\`${t.sourceKind} = 'act_run'\`)` and adds `uniqueIndex('ai_agent_fix_watches_intent_uq').on(t.intentId).where(sql\`${t.intentId} IS NOT NULL\`)`.
- Registries: `tenantCascade.ts` — insert `'ai_agent_graduation',` then `'ai_agent_op_evidence',` between lines 82 and 83, each with a one-line comment naming its FKs' explicit `ON DELETE` (the standing comment at lines 74-80 requires it). `tenantExportPolicyRegistry.ts` — two new `tablePolicy("org_id", { … })` entries with EVERY column in `included` and empty `reviewedIncluded`/`excludedSensitive`/`excludedOpen`, plus add `"intent_id","source_kind","op_keys"` to the existing `ai_agent_fix_watches` `included` array (line 53). `orgMergeRegistry.ts` `SPECIAL` — two `leave-for-erasure` entries with notes mirroring line 166's reasoning (derived history tied to runs that stay with the source org).

- [ ] **Step 1:** Write `apps/api/src/db/schema/aiAgentOpEvidence.registry.test.ts` FIRST asserting: `CORE_ORG_CASCADE_DELETE_ORDER` contains `'ai_agent_graduation'` and `'ai_agent_op_evidence'` exactly once each and is sorted by `localeCompare` with `'organizations'` last; `CORE_TENANT_EXPORT_POLICY` has an entry for both table names; `orgMergeRegistry.__testOnly.SPECIAL` has both keys with `kind: 'leave-for-erasure'`; and `Object.keys(aiAgentOpEvidence)`/`aiAgentGraduation` include every column named in the migration.
- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/db/schema/aiAgentOpEvidence.registry.test.ts` — expect FAIL (module missing).
- [ ] **Step 3:** Write the migration file, both schema files, the `aiAgentFixWatches.ts` edits, the barrel export lines (after `schema/index.ts:58`), and the three registry edits.
- [ ] **Step 4:** Run `cd apps/api && npx vitest run src/db/schema/aiAgentOpEvidence.registry.test.ts src/db/autoMigrate.test.ts` — PASS (autoMigrate pins filename ordering and that every `readFileSync`'d migration path resolves). Then apply for real: `export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm db:migrate && pnpm db:check-drift` — drift must be clean. Re-run `pnpm db:migrate` a second time to prove idempotency (zero errors, zero changes).
- [ ] **Step 5:** Verify isolation by hand as the unprivileged role: `docker exec -it breeze-postgres psql -U breeze_app -d breeze` then `SET breeze.scope='org'; SET breeze.org_ids='<org A>'; INSERT INTO ai_agent_op_evidence (org_id, agent_id, namespace, op_key, source_kind, source_id, metric, occurred_at) VALUES ('<org B>', …);` — must fail with `new row violates row-level security policy`.
- [ ] **Step 6:** Commit: `git add apps/api/migrations apps/api/src/db apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/orgMergeRegistry.ts && git commit -m "feat(api): P2-5 schema — op-evidence ledger, graduation state, intent-anchored fix watches (#4192)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`

### Task 3 (A1-3): Canonical key resolver + exactly-once evidence writer

**Files:**
- Create: `apps/api/src/services/actionIntents/canonicalPolicyKey.ts`, `apps/api/src/services/aiAgents/opEvidence.ts`, `apps/api/src/services/aiAgents/opEvidence.test.ts`
- Modify: `apps/api/src/services/actionIntents/policyDecide.ts` (delete the private `canonicalPolicyKey` at lines 67-74, import it instead)

**Interfaces:**
```ts
// apps/api/src/services/actionIntents/canonicalPolicyKey.ts  (leaf module — imports only aiGuardrails)
/** The canonical POLICY_DECIDABLE_TIER3 key for a stored intent's action —
 *  derived EXACTLY the way checkGuardrails/checkAgentGuardrails resolve the
 *  sub-operation (aiGuardrails.ts's `resolveActionForTool`), never a second ad
 *  hoc parse of `arguments`. Moved out of policyDecide.ts (P2-5, #4192) so the
 *  release worker and the evidence writers share ONE definition instead of
 *  rebuilding the string. */
export function canonicalPolicyKey(actionName: string, args: Record<string, unknown>): string;
```
```ts
// apps/api/src/services/aiAgents/opEvidence.ts
import type { AiAgentEvidenceMetric, AiAgentEvidenceNamespace, AiAgentEvidenceSourceKind } from '@breeze/shared';

export interface OpEvidenceInsert {
  orgId: string;
  agentId: string;                       // the EFFECTIVE agent id (partner baseline row) the run recorded
  namespace: AiAgentEvidenceNamespace;
  opKey: string;
  ruleId: string | null;
  sourceKind: AiAgentEvidenceSourceKind;
  sourceId: string;
  metric: AiAgentEvidenceMetric;
  runId: string | null;
  occurredAt: Date;
}

/** Inserts with ON CONFLICT (source_kind, source_id, metric) DO NOTHING and
 *  returns how many rows were actually new. JOINS the caller's ambient DB
 *  context — never opens its own — so it commits atomically with the CAS that
 *  produced the outcome. Callers MUST already be inside a system context. */
export async function insertOpEvidence(rows: OpEvidenceInsert[]): Promise<number>;

/** The single `verdict_feedback` row for a verdict, upserted so a re-vote flips
 *  `metric` in place (up <-> down). Never a negative delta. */
export async function upsertVerdictFeedbackEvidence(row: OpEvidenceInsert): Promise<void>;

/** Stable source ids. Each is deterministic so a redelivered job recomputes the
 *  same value and the unique index absorbs it. */
export function intentEvidenceSourceId(intentId: string): string;                 // `${intentId}`
export function watchEvidenceSourceId(watchId: string, opKey: string): string;    // `${watchId}:${opKey}`
export function actEvidenceSourceId(runId: string, actionIndex: number): string;  // `${runId}:${actionIndex}`
export function verdictEvidenceSourceId(verdictId: string): string;               // `${verdictId}`
```
**Why `watchEvidenceSourceId` includes the op key:** a watch carries N `op_keys` and emits one row per key with the SAME metric, so a bare watch id would collide on `(source_kind, source_id, metric)` and silently drop all but the first key.

- [ ] **Step 1:** Write `opEvidence.test.ts` FIRST (Drizzle mock; assert the COMPILED SQL, not the builder object — the repo's vacuous-assertion trap): `insertOpEvidence` emits `on conflict ("source_kind","source_id","metric") do nothing`; it returns `rows.length` on a fresh insert and `0` when the DB returns no rows; a second call with identical inputs produces byte-identical SQL and params; `upsertVerdictFeedbackEvidence` emits `on conflict ("source_id") where "source_kind" = 'verdict_feedback' do update set "metric" = …`; `watchEvidenceSourceId('w1','manage_services:restart') === 'w1:manage_services:restart'`; `actEvidenceSourceId('r1', 0) === 'r1:0'`. Plus a `canonicalPolicyKey.test.ts` asserting `canonicalPolicyKey('manage_services', { action: 'restart' }) === 'manage_services:restart'` and that a tool with no resolvable action returns the bare tool name.
- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/services/aiAgents/opEvidence.test.ts src/services/actionIntents/canonicalPolicyKey.test.ts` — expect FAIL (modules missing).
- [ ] **Step 3:** Implement both modules; move `canonicalPolicyKey` out of `policyDecide.ts` and replace its body there with the import (its call site at `policyDecide.ts:534` is unchanged).
- [ ] **Step 4:** Run `cd apps/api && npx vitest run src/services/aiAgents/opEvidence src/services/actionIntents/canonicalPolicyKey src/services/actionIntents/policyDecide` — PASS. Then `npx vitest run src/services/aiAgents/verdictProfile.contract.test.ts` — PASS (confirms `policyDecide.ts` gained no forbidden literal).
- [ ] **Step 5:** Commit: `git add apps/api/src/services && git commit -m "feat(api): P2-5 exactly-once op-evidence writer + shared canonical policy-key resolver (#4192)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`

### Task 4 (A1-4): Release-worker terminalization + intent evidence

**Files:** Modify `apps/api/src/jobs/intentReleaseWorker.ts` (`failIntent` lines 237-257, the returned-tool-error CAS lines 629-645, the success CAS lines 665-690) and `apps/api/src/jobs/intentReleaseWorker.test.ts`.

**Interfaces (produced, module-private to the worker):**
```ts
/** Runs a terminal CAS and, only when it WINS, the evidence write, inside ONE
 *  outer system transaction. transitionIntent opens its own
 *  withSystemDbAccessContext (intentService.ts:1929), and a nested context
 *  JOINS an ambient one (db/index.ts:526-528), so both land in one commit.
 *  NEVER wraps executeTool — the worker deliberately executes outside any DB
 *  context (intentReleaseWorker.ts:533-575). */
async function terminalizeIntent(
  intent: ActionIntent,
  to: 'completed' | 'failed',
  patch: { executedAt?: Date | null; errorCode?: string; result?: Record<string, unknown> },
  onWon?: () => Promise<void>,
): Promise<boolean>;

/** True iff this terminal write represents an ATTEMPTED operation. The
 *  discriminator is already in the codebase and already documented: a terminal
 *  write stamps `executed_at` exactly when the provider-side effect happened
 *  (failIntent's `executed: true`, intentReleaseWorker.ts:229-236). */
function isAttemptedTerminal(patch: { executedAt?: Date | null }): boolean;
```
**Terminal-branch inventory — every exit of `releaseApprovedIntent`, with its C4 classification (verified line by line in this file):**

| Line | Branch | Terminal write | Attempted? | Evidence |
|---|---|---|---|---|
| 317-325 | claim CAS `approved→executing` lost | none (silent return) | — | none |
| 291 | `failOnPlaintextSecretGuard` → `failIntent(SECRET_SEAL_INVARIANT_VIOLATED_ERROR_CODE, { executed: true })` | `failed`, `executedAt` set | **YES** | `failed` |
| 386 | kill switch on revalidation → `pauseIntentForKillSwitch` | `executing→approved` (not terminal) | — | none |
| 389 | revalidation stop (digest bound / tier / actor / org / rbac / policy) | `failed`, no `executedAt` | no | none |
| 472 | `digest_check_failed` (recompute threw) | `failed`, no `executedAt` | no | none |
| 481 | `content_changed` (digest mismatch) | `failed`, no `executedAt` | no | none |
| 499 | `session_required` | `failed`, no `executedAt` | no | none |
| 525 | pre-dispatch kill read → `pauseIntentForKillSwitch` | `executing→approved` | — | none |
| 583 | `connection_unavailable` (no API call was made) | `failed`, no `executedAt` | no | none |
| 589 | `execution_error` (executor threw) `{ executed: true }` | `failed`, `executedAt` set | **YES** | `failed` |
| 629 | `tool_returned_error` (error body, not a throw) | `failed`, `executedAt` set | **YES** | `failed` |
| 665 | success | `completed`, `executedAt` set | **YES** | `executed` (+ `verified` when no watch is created — Task 5) |

The rule reduces to: **evidence is written iff the terminal write stamps `executedAt`**; `completed → executed`, `failed → failed`. `failIntent`'s existing `executed?: boolean` option IS the attempted flag — do not invent a second classifier.

**Evidence payload for an intent terminal (agent-originated only — `intent.requestingAgentRunId` non-null; a human/chat/MCP intent produces no agent evidence):** load the run row (`ai_agent_runs.agent_id`, `.alert_id`) inside the same transaction; `namespace: 'policy_key'`, `opKey: canonicalPolicyKey(intent.actionName, intent.arguments)`, `ruleId: null`, `sourceKind: 'intent'`, `sourceId: intentEvidenceSourceId(intent.id)`, `runId: intent.requestingAgentRunId`, `occurredAt: new Date()`, `agentId: run.agentId`, `orgId: intent.orgId`.

- [ ] **Step 1:** Write failing tests in `intentReleaseWorker.test.ts`: a table-driven case per row above asserting `insertOpEvidence` is called with the exact metric (or not called at all) — one case per branch, twelve cases, using the branch's real trigger (mock `revalidateApprovedIntentForRelease`, `executeTool`, `readAiKillState`); a redelivery case (`releaseApprovedIntent` called twice for the same id) asserting the second call writes nothing because the claim CAS loses; a case asserting evidence is NOT written when `intent.requestingAgentRunId` is null; a case asserting `insertOpEvidence` is never called when the terminal CAS returns false.
- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/jobs/intentReleaseWorker.test.ts` — expect FAIL.
- [ ] **Step 3:** Implement `terminalizeIntent` + `isAttemptedTerminal`; route the three attempted terminal writes (`failIntent`'s `executed: true` calls, the `tool_returned_error` CAS at 629, the success CAS at 665) through it. Leave `auditReleaseFailure` / `recordActionIntentEvent` OUTSIDE the transaction, exactly where they are today.
- [ ] **Step 4:** Run `cd apps/api && npx vitest run src/jobs/intentReleaseWorker src/services/actionIntents/intentService` — PASS; then `npx vitest run src/jobs/intentReleaseWorker.durable.contract.test.ts` — PASS (no new terminal writer was introduced).
- [ ] **Step 5:** Commit: `git add apps/api/src/jobs/intentReleaseWorker.ts apps/api/src/jobs/intentReleaseWorker.test.ts && git commit -m "feat(api): P2-5 intent terminalization writes op evidence in the CAS transaction (#4192)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`

### Task 5 (A1-5): Intent-anchored fix watches + durable enqueue recovery

**Files:** Modify `apps/api/src/services/aiAgents/fixWatch.ts` (add beside `createFixWatchRow` at lines 132-182), `apps/api/src/jobs/fixWatchWorker.ts` (`scheduleFixWatch` lines 131-146, `processFixWatchJob` lines 155-…, `initializeFixWatchWorker`), `apps/api/src/jobs/queueSchemas.ts` (line 321-324), `apps/api/src/jobs/intentReleaseWorker.ts`, and the two workers' `.test.ts` files.

**Interfaces:**
```ts
// fixWatch.ts
export interface IntentForWatch {
  intentId: string; orgId: string; runId: string; agentId: string;
  alertId: string; opKey: string;                 // colon key from canonicalPolicyKey
}
/** Sibling of createFixWatchRow for a released INTENT rather than an act run.
 *  createFixWatchRow rejects anything but an act-mode, execution-succeeded,
 *  verification-passed RUN (fixWatch.ts:112-121) and cannot be reused. Reuses
 *  the same alert/device denormalisation (rule_id, device_id,
 *  config_item_name from the TRIGGERING ALERT ROW, org-predicated) and the
 *  same partner resolution; writes source_kind 'intent', op_keys [opKey].
 *  JOINS the caller's ambient system transaction. Returns the watch id, or
 *  null when the alert is unreadable in this org or the org has no partner. */
export async function createIntentFixWatchRow(input: IntentForWatch): Promise<string | null>;

// fixWatchWorker.ts
/** Now returns the watch id it created (or null) so finishRun can tell whether
 *  an act run's executions will ever be verified by a watch. */
export async function scheduleFixWatch(run: FinishedRunForWatch, outcome: FixWatchOutcomeInput): Promise<string | null>;
/** Re-enqueues phase-1 for any `pending` watch older than PENDING_RECOVERY_MS
 *  whose job was lost (the enqueue is post-commit, so a crash between commit
 *  and add() strands the row). The jobId is stable
 *  (`getFixWatchPhase1JobId`), so a duplicate add is a no-op. */
export async function recoverStrandedFixWatches(): Promise<number>;
export const PENDING_RECOVERY_MS = 2 * 60 * 1000;
```
- `queueSchemas.ts`: `fixWatchQueueJobDataSchema` becomes a discriminated union on `phase`:
```ts
export const fixWatchQueueJobDataSchema = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('phase1'), watchId: z.string().min(1) }).strict(),
  z.object({ phase: z.literal('phase2'), watchId: z.string().min(1) }).strict(),
  z.object({ phase: z.literal('recover') }).strict(),
]);
```
The `recover` variant rides the EXISTING `fix-watch` queue and `check-fix-watch` job name, so `assertQueueJobName` is unchanged and **no `workerRegistry.ts` entry is added** (which would force `EXPECTED_NAMES` + the hard-coded `115` count in `workerEntrypointClosure.contract.test.ts:453` to change). Register it in `initializeFixWatchWorker` with `repeat: { every: PENDING_RECOVERY_MS }` and `jobId: 'fix-watch-recover'`; 2 minutes is far below `COARSE_REPEAT_INTERVAL_MS`, so `scheduleRegistry.contract.test.ts` needs no slot.
- `intentReleaseWorker.ts` success branch: inside `terminalizeIntent`'s `onWon`, after the evidence insert, when the run has an `alertId` call `createIntentFixWatchRow`; capture the returned id. When it is `null` (no eligible watch), ALSO insert the `verified` metric for the same `sourceId` immediately (C4's "no eligible watch existed for the source"). **Enqueue AFTER the transaction commits** — `bullmqQueue.ts:52-58` `assertOutsideHeldDbContext` throws if `queue.add` runs inside a held context. Use the existing `enqueueFixWatchCheck('phase1', watchId, PHASE1_RECHECK_DELAY_MS)` with its stable jobId.
- `runLoop.ts` act-run watch: `createFixWatchRow` also snapshots `opKeys: outcome.executedActions.map(a => a.actOpKey).filter(Boolean)` (dot keys, `runLoop.ts:213`) and `sourceKind: 'act_run'`. Its `.onConflictDoNothing({ target: aiAgentFixWatches.runId })` (line 177) MUST gain the index predicate or Postgres cannot infer the now-partial index: `.onConflictDoNothing({ target: aiAgentFixWatches.runId, where: sql\`${aiAgentFixWatches.sourceKind} = 'act_run'\` })` — drizzle 0.45.2 renders this as `on conflict ("run_id") where … do nothing` (`insert.js:107`).

- [ ] **Step 1:** Write failing tests: `createIntentFixWatchRow` writes `source_kind='intent'`, `op_keys=[opKey]`, and denormalises `rule_id`/`device_id`/`config_item_name` from an alert row read with BOTH `id` and `org_id` predicates; it returns null when the alert belongs to another org; two calls for the same intent id insert one row (partial unique). `createFixWatchRow`'s compiled SQL contains `on conflict ("run_id") where`. `scheduleFixWatch` returns the watch id. `recoverStrandedFixWatches` re-enqueues only `pending` watches older than 2 minutes and uses the phase-1 jobId. In `intentReleaseWorker.test.ts`: a successful agent intent whose run HAS an alertId creates a watch and writes only `executed`; one whose run has NO alertId writes `executed` AND `verified`; the watch enqueue happens after the transaction (assert `queue.add` is called after the transaction callback resolves, and that no `assertOutsideHeldDbContext` error is thrown).
- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/services/aiAgents/fixWatch src/jobs/fixWatchWorker src/jobs/intentReleaseWorker` — expect FAIL.
- [ ] **Step 3:** Implement all of the above.
- [ ] **Step 4:** Run the same command — PASS; then `npx vitest run src/services/workerEntrypointClosure.contract.test.ts` — PASS (`intentReleaseWorker` is `socket-owner` and `fixWatchWorker` is `global`; the test only forbids a GLOBAL entrypoint reaching socket-local dispatch, `:451-473`, so a socket-owner importing the global producer is fine — but run it, do not assume).
- [ ] **Step 5:** Commit: `git add apps/api/src && git commit -m "feat(api): P2-5 intent-anchored fix watches with durable enqueue recovery (#4192, closes #4206)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`

### Task 6 (A1-6): Watch-verdict evidence + act-op evidence

**Files:** Modify `apps/api/src/services/aiAgents/fixWatch.ts` (`checkFixWatchPhase2` lines 382-447: the `recurred` CAS at 411-418 and the `held_qualified` CAS at 427-432), `apps/api/src/services/aiAgents/runLoop.ts` (`finishRun`, the `watches && status === 'completed'` block at lines 2562-2573), and both `.test.ts` files.

**Interfaces:** no new exports. Evidence payloads:
- **Watch verdict** (inside the WINNING CAS's transaction, before it returns; notify stays after commit exactly as today at `fixWatch.ts:439-446`): one row per entry of `watch.opKeys`, `namespace: watch.sourceKind === 'intent' ? 'policy_key' : 'act_op'`, `opKey: <entry>`, `ruleId: watch.ruleId`, `sourceKind: 'watch'`, `sourceId: watchEvidenceSourceId(watch.id, entry)`, `metric: 'recurred' | 'verified'`, `runId: watch.runId`, `occurredAt: new Date()`, `agentId: watch.agentId`, `orgId: watch.orgId`. A watch with an empty `op_keys` writes nothing (pre-P2-5 rows).
- **Act execution** (in `finishRun`, after the terminal CAS is won — `finishRun` returns early on `!moved`, so this section runs at most once per winning executor): for each `outcome.executedActions[i]` with an `actOpKey`, `namespace: 'act_op'`, `opKey: action.actOpKey`, `ruleId: null`, `sourceKind: 'act_execution'`, `sourceId: actEvidenceSourceId(run.id, i)`, `runId: run.id`, `occurredAt: new Date()`. Metric mapping: `execution === 'succeeded'` → `executed`; `execution === 'failed'` OR `verification === 'failed'` → `failed`; `verification` of `inconclusive`/`skipped` → nothing extra. When `scheduleFixWatch` returned `null` (no watch will ever verify this run), each `executed` action ALSO gets a `verified` row with the same `sourceId`.

- [ ] **Step 1:** Write failing tests. `fixWatch.test.ts`: a `recurred` verdict on a watch with `op_keys = ['a:b','c:d']` inserts two `recurred` rows with source ids `<watchId>:a:b` / `<watchId>:c:d`; a LOST CAS (`moved` empty) inserts nothing; `held_qualified` inserts `verified` per key; an intent watch uses namespace `policy_key`, an act watch `act_op`; notification still fires only after the transaction. `runLoop.test.ts`: two executed actions with distinct `actOpKey`s (non-uniform fixture — different tool AND different verification per action, so a wrong-index bug surfaces) produce the right metric per index; a run where `scheduleFixWatch` returns null gets `executed` + `verified`; one where it returns an id gets `executed` only; `!moved` writes nothing.
- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/services/aiAgents/fixWatch src/services/aiAgents/runLoop` — expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command — PASS (check the file count; `runLoop.test.ts` is large, use `--pool=threads --maxWorkers=2` if a stack is up).
- [ ] **Step 5:** Commit: `git add apps/api/src/services/aiAgents && git commit -m "feat(api): P2-5 watch-verdict and act-execution op evidence (#4192)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`

### Task 7 (A1-7): Verdict feedback evidence

**Files:** Modify `apps/api/src/services/aiAgents/alertVerdicts.ts` (`recordVerdictFeedback`, lines 603-623) and `alertVerdicts.test.ts`.

**Interfaces:** `recordVerdictFeedback`'s signature and `RecordVerdictFeedbackResult` union are UNCHANGED. Rewrite the body as: one `SELECT … FOR UPDATE` on the verdict row (`id`, `orgId`, `runId`, `alertId`, `correlationGroupId`, `feedback`, `feedbackBy`, `createdAt`) → not found ⇒ `{ status: 'not_found' }`; `feedbackBy` set and ≠ `auth.user.id` ⇒ `{ status: 'conflict', orgId }` (**preserve the existing rule at `alertVerdicts.ts:612-615`: a different user may never overwrite; the same user changing their mind is fine**); otherwise UPDATE the verdict and upsert the single evidence row. The request already runs inside `withDbAccessContext`, so all of this joins that ambient transaction — do not open a new one.

**Evidence payload:** `namespace: 'alert_verdict'`, `opKey: AI_AGENT_ALERT_VERDICT_OP_KEY`, `metric: feedback === 'up' ? 'feedback_up' : 'feedback_down'`, `sourceKind: 'verdict_feedback'`, `sourceId: verdictEvidenceSourceId(verdictId)`, `runId: verdict.runId`, `occurredAt: verdict.createdAt` (the FIXED bucket — the verdict's own creation, not the vote's), `agentId`: from `ai_agent_runs.agent_id` for `verdict.runId`, `orgId: verdict.orgId`. `ruleId`: `alerts.rule_id` for `verdict.alertId`; for a group verdict, the rule of `alert_correlation_groups.root_alert_id` (`alerts.ts:141`), NULL when the group has no root or the alert row is gone. Superseded verdicts keep accepting feedback (unchanged, and `ai_alert_verdicts` has no state gate on it). **No backfill of historical votes** — pre-P2-5 feedback simply has no evidence row; say so in the docstring.

- [ ] **Step 1:** Write failing tests: an up-vote inserts one `feedback_up` row with `occurred_at = verdict.created_at`; the same user re-voting `down` UPDATEs that row's metric to `feedback_down` and leaves exactly one row (assert the compiled `on conflict ("source_id") where "source_kind" = 'verdict_feedback' do update`); a different user gets `{ status: 'conflict' }` and NO evidence write; a missing verdict gets `{ status: 'not_found' }` and no write; a group verdict resolves `rule_id` through `root_alert_id`; a group with `root_alert_id` null yields `ruleId: null`; the SELECT is `FOR UPDATE` (assert the compiled SQL contains `for update`).
- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/services/aiAgents/alertVerdicts` — expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `cd apps/api && npx vitest run src/services/aiAgents/alertVerdicts src/routes/aiAgents` — PASS.
- [ ] **Step 5:** Commit: `git add apps/api/src/services/aiAgents/alertVerdicts.ts apps/api/src/services/aiAgents/alertVerdicts.test.ts && git commit -m "feat(api): P2-5 verdict feedback writes a single locked evidence row (#4192)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`

### Task 8 (A1-8): `updateAgent` row lock

**Files:** Modify `apps/api/src/services/aiAgents/agentService.ts` (`updateAgent` lines 470-533; `getAgent` lines 378-396 stays as-is) and `agentService.test.ts`.

**Interfaces (produced):**
```ts
/** SELECT … FOR UPDATE on one ai_agents row, bound by the SAME
 *  accessibleAgentCondition(auth) predicate getAgent uses (agentService.ts:392),
 *  then runs `fn` with the locked row inside the caller's ambient transaction.
 *  Every writer of actAssets — updateAgent (here), promote and demote
 *  (supervisedKeyGrant.ts, PR A2) — goes through this. A read-modify-write of
 *  the jsonb without it loses a concurrent key append. */
export async function withAgentRowLocked<T>(
  auth: AuthContext | null,           // null = system caller (promote/demote): predicate by id + orgId instead
  id: string,
  fn: (row: AiAgentRow) => Promise<T>,
): Promise<T>;
```
`updateAgent` becomes: `withAgentRowLocked(auth, id, async (existing) => { … existing body from line 476 onward, ending with the same UPDATE … })`. The `disabledAt`/`assertAgentWriteAllowed` checks move inside the callback so they read the locked row.

- [ ] **Step 1:** Write failing tests: `withAgentRowLocked` compiles to a SELECT containing `for update` AND the accessible-agent predicate (assert the compiled SQL includes both `for update` and `org_id`); `updateAgent` calls it before validating and updating (assert call order via a spy); a disabled row inside the lock still throws `AgentAccessDeniedError`; the existing `updateAgent` test suite still passes unchanged.
- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/services/aiAgents/agentService` — expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `cd apps/api && npx vitest run src/services/aiAgents/agentService src/routes/aiAgents` — PASS.
- [ ] **Step 5:** Commit: `git add apps/api/src/services/aiAgents/agentService.ts apps/api/src/services/aiAgents/agentService.test.ts && git commit -m "fix(api): lock the ai_agents row across every actAssets read-modify-write (#4192)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`

### Task 9 (A1-9): Evidence retention worker

**Files:**
- Create: `apps/api/src/jobs/aiAgentGraduationWorker.ts`, `apps/api/src/jobs/aiAgentGraduationWorker.test.ts`
- Modify: `apps/api/src/jobs/scheduleRegistry.ts` (`JOB_SCHEDULES` daily tier, after `'ai-unattended-exposure-retention': '8 18 * * *'` at the end of the daily block), `apps/api/src/services/workerRegistry.ts` (append an entry after `aiAgentSweepScheduler`), `apps/api/src/services/workerEntrypointClosure.contract.test.ts` (`EXPECTED_NAMES` at line 272, and the `expect(entries.length).toBe(115)` sanity count at line 453 → 116)

**Interfaces:**
```ts
// apps/api/src/jobs/aiAgentGraduationWorker.ts
export const AI_AGENT_GRADUATION_QUEUE = 'ai-agent-graduation';
export const AI_AGENT_GRADUATION_JOB_NAME = 'ai-agent-graduation';
/** Discriminated so PR A2 can add `{ task: 'evaluate' }` to the SAME queue and
 *  worker without a second workerRegistry entry. */
export type AiAgentGraduationJobData = { task: 'prune-evidence' };
export async function pruneOpEvidence(): Promise<{ deletedCount: number; durationMs: number }>;
export async function initializeAiAgentGraduationWorker(): Promise<void>;
export async function shutdownAiAgentGraduationWorker(): Promise<void>;
```
- Copy the structure of `apps/api/src/jobs/aiUnattendedExposureRetention.ts` verbatim (its `runWithSystemDbAccess` guard, `extractRowCount`, `recordRetentionRun`, `attachWorkerObservability`, `jobSchedule(...)`). The prune is `DELETE FROM ai_agent_op_evidence WHERE occurred_at < <cutoff ISO string>::timestamptz` with `cutoff = now - AI_AGENT_EVIDENCE_RETENTION_DAYS days`; pass the cutoff as an ISO **string**, not a `Date` (postgres-js does not coerce Date in template params — the sibling workers' convention).
- `scheduleRegistry.ts`: add `'ai-agent-op-evidence-retention': '48 18 * * *',`. That minute is ≡ 3 (mod 5) as the daily tier requires and no other job holds `(18, 48)` — `scheduleRegistry.contract.test.ts` asserts one slot per job, no duplicate patterns, and no two coarse schedules in the same minute.
- `workerRegistry.ts`: `{ name: 'aiAgentGraduation', placement: 'global', load: async () => { const m = await import('../jobs/aiAgentGraduationWorker'); return { init: m.initializeAiAgentGraduationWorker, shutdown: m.shutdownAiAgentGraduationWorker }; } }` with a comment stating the closure reaches only `db` + `services/aiAgents/opEvidence.ts` and must never import `aiTools.ts` (the promotion executor lives there and would drag socket-local dispatch in).

- [ ] **Step 1:** Write failing tests: `pruneOpEvidence` emits a DELETE whose predicate is `occurred_at < $1::timestamptz` with a cutoff 400 days back (assert the compiled SQL and the param); it returns the extracted row count; `initializeAiAgentGraduationWorker` registers the repeatable with `pattern: jobSchedule('ai-agent-op-evidence-retention')` and a fixed `jobId`.
- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/jobs/aiAgentGraduationWorker.test.ts` — expect FAIL.
- [ ] **Step 3:** Implement the worker + the three registry edits (including bumping the `115` literal).
- [ ] **Step 4:** Run `cd apps/api && npx vitest run src/jobs/aiAgentGraduationWorker src/jobs/scheduleRegistry.contract.test.ts src/services/workerEntrypointClosure.contract.test.ts` — PASS (all three; the closure test will fail loudly if `global` is the wrong placement and names the offending import chain).
- [ ] **Step 5:** Commit: `git add apps/api/src && git commit -m "feat(api): P2-5 op-evidence retention worker (400d) (#4192)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`

### Task 10 (A1-10): Live-Postgres proof (exactly-once, RLS, erasure, merge)

**Files:** Create `apps/api/src/__tests__/integration/aiAgentOpEvidence.integration.test.ts`.

**Interfaces:** none (test only). It must live under `apps/api/src/__tests__/integration/` or it runs in ZERO CI jobs.

- [ ] **Step 1:** Write the suite. It must prove:
  1. **Exactly-once under redelivery** — `releaseApprovedIntent(id)` invoked twice against a real DB leaves exactly one `executed` evidence row (the second call loses the claim CAS); `insertOpEvidence` called twice with identical inputs leaves one row and returns `0` the second time.
  2. **Atomicity** — force the evidence insert to throw inside `terminalizeIntent` and assert the intent stays `executing` (the CAS rolled back), not `completed` with no evidence.
  3. **Watch fan-out** — a watch with two `op_keys` reaching `recurred` writes exactly two rows; running phase 2 twice writes no third row.
  4. **RLS forge** — as `breeze_app` under org A's context, an INSERT/UPDATE/SELECT naming org B's `org_id` fails `42501` on both new tables; the composite FK forge (a `promoted_intent_id` from another org) fails `23503`.
  5. **Erasure** — deleting an org with rows in both tables succeeds via the tenant-cascade path (no FK abort, no stranded rows).
  6. **Org merge** — merging an org with rows in both tables succeeds and leaves the rows on the loser shell (`leave-for-erasure`).
- [ ] **Step 2:** Bring up the wave's DB: `docker compose -p breeze-test-ai-agents-p2-5 -f docker-compose.test.yml up -d postgres` (mirror P2-2/P2-4's harness naming), then run `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiAgentOpEvidence.integration.test.ts` — expect FAIL first (assertions 1-3 before Tasks 3-6 land are already green from earlier tasks, so run this AFTER them and expect 4-6 to fail until the registries are right).
- [ ] **Step 3:** Fix whatever fails, then run the registry contract suites against the same DB: `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts` — ALL PASS.
- [ ] **Step 4:** Full API typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`; `pnpm lint` in `apps/api` and `packages/shared`.
- [ ] **Step 5:** Commit: `git add apps/api/src/__tests__ && git commit -m "test(api): P2-5 live-Postgres proof — exactly-once evidence, RLS forge, erasure, merge (#4192)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`; then run the **Final verification** checklist below and open **PR A1** targeting main with body `Part of #4192`. STOP at the open PR.

---

## PR A2 — graduation, promotion, demotion (branch `feature/4187-ai-agents-p2/wave-4192-a2`, base main, opened after A1 merges)

### Task 11 (A2-1): Partner keys become a ceiling

**Files:** Modify `apps/api/src/services/aiAgents/effectivePolicy.ts` (`mergeLimits` lines 70-99, the `if (!org)` fast path lines 135-159, the `actAssets` merge lines 245-266), `effectivePolicy.test.ts` (the pinned assertion at lines 367-374), `docs/deploy/ai-kill-switch.md` (the operator runbook that already documents the policy-decide lane — `docs/deploy/` has no dedicated policy-decide file, verified); create `apps/api/src/services/aiAgents/effectivePolicy.ceiling.contract.test.ts`.

**Interfaces (produced):**
```ts
/** Limit keys merged with Math.max instead of Math.min. Everything else is
 *  tighten-only (the org may only narrow). `promoteThreshold` is a BAR, not a
 *  budget: a partner who requires 50 verified executions must not be undercut
 *  by an org row asking for 5. */
const MAX_MERGED_LIMIT_KEYS: ReadonlySet<keyof AiAgentLimits> = new Set(['promoteThreshold']);
```
**Behaviour change (C3, release-blocking):** in the `if (!org)` fast path, `actAssets.supervisedActionKeys` resolves to `[]` — joining `anomalyEnabled` and `ticketAutonomousWrites` as a field the partner baseline alone can never turn on. The `org` branch is unchanged (`intersect(partner ?? [], org ?? [])`, line 262-265). Docstring must say: partner keys are a CEILING (what an org MAY be granted), the org row is the GRANT (what it HAS); promotion is the only writer that adds one, demotion the only one that removes one. Safe to land now because `attemptPolicyDecision` is the sole consumer and `BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED` is off in production (`policyDecide.ts:501-508` re-reads it live).

- [ ] **Step 1:** Update the pinned test at `effectivePolicy.test.ts:367-374` — the "No org override at all: effective === partner verbatim" case now asserts `{ scriptIds: [], supervisedActionKeys: [] }` and its comment is rewritten to state the ceiling rule. Then write `effectivePolicy.ceiling.contract.test.ts` FIRST with: no org row + partner `[KEY_A]` ⇒ `[]`; org row present ⇒ intersection (unchanged); org row with a key the partner lacks ⇒ dropped; `mergeLimits` returns `max(partner, org)` for `promoteThreshold` and `min` for every other numeric (table-driven over `AI_AGENT_LIMIT_DEFAULTS`'s keys, so a future limit added to the max set fails loudly); a v8 snapshot with no `promoteThreshold` reads the default 20.
- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/services/aiAgents/effectivePolicy` — expect FAIL (check the file count picks up BOTH `effectivePolicy.test.ts` and `effectivePolicy.ceiling.contract.test.ts`; a trailing slash or an asterisk would silently skip siblings).
- [ ] **Step 3:** Implement `MAX_MERGED_LIMIT_KEYS` in `mergeLimits` and the `[]` in the `!org` fast path.
- [ ] **Step 4:** Run `cd apps/api && npx vitest run src/services/aiAgents/effectivePolicy src/services/actionIntents/policyDecide src/services/aiAgents/runService` — PASS.
- [ ] **Step 5:** Add a section to `docs/deploy/ai-kill-switch.md` under its policy-decide bullet: before flipping `BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED` on, every org that should hold a supervised key needs an org-level `ai_agents` row carrying it — as of P2-5 a partner-only baseline is a ceiling and grants nothing. Commit: `git add apps/api/src/services/aiAgents docs/deploy/ai-kill-switch.md && git commit -m "fix(api): partner supervisedActionKeys are a ceiling, not an inherited grant (#4192)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`

### Task 12 (A2-2): Graduation service — window, eligibility, state machine

**Files:** Create `apps/api/src/services/aiAgents/graduationService.ts`, `graduationService.test.ts`.

**Interfaces (produced):**
```ts
import type {
  AiAgentGraduationBlockedReason, AiAgentGraduationRowDto, AiAgentGraduationState,
  AiAgentGraduationWindow, AiAgentActOpReliabilityDto,
} from '@breeze/shared';

export interface GraduationEvaluation {
  opKey: string;
  state: AiAgentGraduationState;
  window: AiAgentGraduationWindow;
  blockedReason: AiAgentGraduationBlockedReason | null;
}

/** Pure over the evidence ledger + the current graduation row. Window =
 *  evidence with occurred_at > GREATEST(now() - 30 days, graduation.demoted_at)
 *  — timestamps, never day buckets, so a demotion and a re-verification on the
 *  same day are unambiguous. Only namespace 'policy_key' rows count. */
export async function evaluateGraduation(
  orgId: string, agentId: string, opKey: string,
): Promise<GraduationEvaluation>;

/** Recomputes and PERSISTS the graduation row for one tuple under
 *  pg_advisory_xact_lock(hashtext('ai_agent_graduation'), hashtext(orgId||agentId||opKey)).
 *  Called by the daily job and by the read route. Never promotes or demotes —
 *  it only moves tracking <-> eligible and resets first_verified_at on the
 *  first `verified` after demoted_at. */
export async function refreshGraduationRow(
  orgId: string, agentId: string, opKey: string,
): Promise<GraduationEvaluation>;

/** Every (org, agent, op_key) with at least one policy_key evidence row in the
 *  trailing 30 days — the daily job's work list. */
export async function listTrackedTuples(): Promise<Array<{ orgId: string; agentId: string; opKey: string }>>;

/** Rows + act-op reliability for one resolved agent, for the read route. */
export async function loadGraduationRows(orgId: string, agentId: string): Promise<AiAgentGraduationRowDto[]>;
export async function loadActOpReliability(orgId: string, agentId: string): Promise<AiAgentActOpReliabilityDto[]>;

/** Advisory-lock helper shared by this module, the promote executor and the
 *  demote path. Must run inside a transaction (xact lock releases on commit). */
export async function withGraduationLock<T>(
  orgId: string, agentId: string, opKey: string, fn: () => Promise<T>,
): Promise<T>;
```
**Eligibility rule (all must hold; `blockedReason` is the FIRST failing check, in this order):**
1. `isPolicyDecidableKey(opKey)` (`policyDecidable.ts`) else `'not_policy_decidable'`.
2. The key is in the PARTNER row's `actAssets.supervisedActionKeys` (read the partner baseline for the org's partner in a system context) else `'needs_partner_baseline'`.
3. `window.failed === 0 && window.recurred === 0` else `'has_failures'`.
4. `window.verified >= effective.limits.promoteThreshold ?? AI_AGENT_LIMIT_DEFAULTS.promoteThreshold` else `'below_threshold'`.
5. `now - window.firstVerifiedAt >= AI_AGENT_GRADUATION_MIN_AGE_DAYS` else `'too_recent'`.
If all hold and the key is already in the ORG row's `supervisedActionKeys`, state is `promoted` (not `eligible`) with `blockedReason: null`. `window.firstVerifiedAt` = `MIN(occurred_at)` over `verified` rows in the window.
**Transitions:** `tracking → eligible` (job or read, when 1-5 hold); `eligible → tracking` (the window slid and a check now fails); `eligible → promoted` (promote intent executed, Task 15); `promoted → demoted` (Task 16); `demoted → tracking` on the first `verified` row with `occurred_at > demoted_at` (which also resets `first_verified_at`).

- [ ] **Step 1:** Write `graduationService.test.ts` FIRST (Drizzle mock, compiled-SQL assertions where a predicate matters): the window query's lower bound is `GREATEST(now() - interval '30 days', demoted_at)` and it filters `namespace = 'policy_key'`; each blocked reason fires in the documented precedence (a key that is both not-policy-decidable and below threshold reports `'not_policy_decidable'`); `verified === promoteThreshold` is eligible but `promoteThreshold - 1` is `'below_threshold'`; `firstVerifiedAt` exactly 14 days ago is eligible, 13 days 23 h is `'too_recent'`; a key already in the org row reports `promoted`; `withGraduationLock` emits `pg_advisory_xact_lock(hashtext($1), hashtext($2))` with the two expected arguments; `refreshGraduationRow` after a demotion ignores evidence at or before `demoted_at` and resets `first_verified_at` on the first later `verified`.
- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/services/aiAgents/graduationService.test.ts` — expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `cd apps/api && npx vitest run src/services/aiAgents/graduationService` — PASS.
- [ ] **Step 5:** Commit: `git add apps/api/src/services/aiAgents && git commit -m "feat(api): P2-5 graduation service — 30d evidence window, eligibility, state machine (#4192)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`

### Task 13 (A2-3): Daily graduation evaluation job

**Files:** Modify `apps/api/src/jobs/aiAgentGraduationWorker.ts` (widen `AiAgentGraduationJobData` and the processor), `apps/api/src/jobs/scheduleRegistry.ts`, `aiAgentGraduationWorker.test.ts`.

**Interfaces (produced):**
```ts
export type AiAgentGraduationJobData = { task: 'prune-evidence' } | { task: 'evaluate' };
/** Refreshes every tuple listTrackedTuples() returns, each under its own
 *  advisory-locked transaction so one slow tuple never blocks the rest and a
 *  failure mid-sweep leaves the already-refreshed rows committed. */
export async function evaluateAllGraduations(): Promise<{ tuples: number; changed: number; durationMs: number }>;
```
- `scheduleRegistry.ts`: add `'ai-agent-graduation-evaluate': '28 18 * * *',` to the daily tier. Minute 28 ≡ 3 (mod 5); `(18, 28)` is unused (`(18, 8)` is `ai-unattended-exposure-retention`, `(18, 48)` is A1's retention slot).
- No new `workerRegistry.ts` entry and no change to the `116` count — this rides A1's queue and worker.

- [ ] **Step 1:** Write failing tests: `evaluateAllGraduations` calls `refreshGraduationRow` once per tuple and counts state changes; a throw on one tuple does not abort the others (assert the remaining tuples still ran and the error was captured); the processor dispatches on `task`; `initializeAiAgentGraduationWorker` now registers TWO repeatables with distinct jobIds and the two registry patterns.
- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/jobs/aiAgentGraduationWorker.test.ts` — expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `cd apps/api && npx vitest run src/jobs/aiAgentGraduationWorker src/jobs/scheduleRegistry.contract.test.ts src/services/workerEntrypointClosure.contract.test.ts` — PASS.
- [ ] **Step 5:** Commit: `git add apps/api/src/jobs && git commit -m "feat(api): P2-5 daily graduation evaluation repeatable (#4192)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`

### Task 14 (A2-4): `manage_ai_agents:authorize_supervised_key` — every wiring point

**Files:**
- Create: `apps/api/src/services/aiToolsAiAgentGovernance.ts`, `aiToolsAiAgentGovernance.test.ts`
- Modify: `apps/api/src/services/aiTools.ts` (import block lines 31-86, registration block lines 255-304), `aiToolSchemas.ts` (`toolInputSchemas`, line 97+), `aiAgentSdkTools.ts` (`TOOL_TIERS` lines 115-283, the `tools` array inside `createBreezeMcpServer` at line 1085), `aiGuardrails.ts` (`TIER3_FOUR_EYES_ACTIONS` lines 309-330, `TIER3_FOUR_EYES_TOOLS` line 333+, `TOOL_PERMISSIONS` line 503+, `TOOL_RATE_LIMITS` line 1075+, `buildApprovalDescription` line 1935+, `checkAgentGuardrails` lines 1621-1626), `aiGuardrails.approvalScope.contract.test.ts` (the pinned arrays at lines 176-178 and 185), `services/actionIntents/effectDigest.ts` (`EFFECT_DIGEST_RESOLVERS` lines 117-319), `apps/web/src/components/ai-risk/tierConfig.ts` (`TIER_DEFINITIONS` tier-3 block line 193+, `RBAC_MAPPINGS` line 335+), `apps/docs/src/content/docs/features/ai.mdx` (tier table lines 27-32, four-eyes bullet list lines 59-68)

**Interfaces (produced):**
```ts
// apps/api/src/services/aiToolsAiAgentGovernance.ts
// Deliberately NOT named aiToolsAgentMgmt.ts — that module is ENDPOINT-agent
// management (query_agent_versions / trigger_agent_upgrade / trigger_agent_restart).
export function registerAiAgentGovernanceTools(aiTools: Map<string, AiTool>): void;
```
**The tool:** name `manage_ai_agents`, `tier: 3`, one action `authorize_supervised_key`, arguments `{ action: 'authorize_supervised_key', kind: AiAgentKind, opKey: string }`. **No `orgId` argument** — the org comes from the intent's own `org_id`, and the agent id is resolved server-side by `resolveEffectiveAgentSystem(orgId, kind)` (`effectivePolicy.ts:309`), never trusted from arguments.

**Every mandatory wiring item (omit one and it fails differently — the failure mode is listed):**
1. `aiTools.ts`: `import { registerAiAgentGovernanceTools } from './aiToolsAiAgentGovernance';` + `registerAiAgentGovernanceTools(aiTools);` beside `registerAgentMgmtTools(aiTools);` (line 300). Omitted ⇒ `executeTool`/`getToolTier` never see the tool. Do NOT edit `aiToolNames.ts`.
2. `aiToolSchemas.ts` `toolInputSchemas`: `manage_ai_agents: z.object({ action: z.enum(['authorize_supervised_key']), kind: z.enum(AI_AGENT_KINDS), opKey: z.string().min(3).max(120) })`. Omitted ⇒ `validateToolInput` rejects every call (`aiToolSchemas.ts:1658-1666` fails closed).
3. `aiAgentSdkTools.ts`: `TOOL_TIERS.manage_ai_agents = 3` AND an explicit `tool('manage_ai_agents', …, makeHandler('manage_ai_agents', getAuth, onPreToolUse, onPostToolUse))` in the `tools` array — copy the `manage_organizations` block at `:2241-2253`, NOT `manage_tickets` (which has a schema and permissions but no tier and no `tool()`, and is therefore unreachable from chat/MCP — the exact bug `aiAgentSdkTools.ts:2256-2261` documents). Omitted ⇒ `aiAgentSdkTools.registryParity.contract.test.ts` fails, and its `KNOWN_MISSING_TOOL_TIERS` set may only SHRINK, so the name must never be added there.
4. `aiGuardrails.ts` `TIER3_FOUR_EYES_ACTIONS`: `manage_ai_agents: ['authorize_supervised_key'],`. `TIER3_FOUR_EYES_TOOLS`: `'manage_ai_agents',` (whole-tool fail-safe: any future action defaults to four_eyes rather than the weaker supervised).
5. `aiGuardrails.ts` `TOOL_PERMISSIONS`: `manage_ai_agents: { authorize_supervised_key: { resource: 'ai_agents', action: 'write' } }` — match the exact per-action entry shape used by `manage_tickets` at `:523-553`. `ai_agents:write` already exists in the canonical registry (`packages/shared/src/constants/permissions.ts:139-146`), seed, migration and catalog, so there is **no six-list permission ceremony**.
6. `aiGuardrails.ts` `TOOL_RATE_LIMITS`: `manage_ai_agents: { limit: 5, windowSeconds: 3600 },`.
7. `aiGuardrails.ts` `buildApprovalDescription`: `case 'manage_ai_agents':` returning `Authorize the AI agent to run "<opKey>" without an approval for this organization in future runs` — the op key only, never model text.
8. `aiGuardrails.ts` `checkAgentGuardrails` (line 1592): immediately after the `isSecretBearingTool` deny at `:1623-1625`, add `if (toolName === 'manage_ai_agents') return deny('Tool "manage_ai_agents" is human-only and is never available to agents');`. Omitted ⇒ a device-bound agent could propose its own promotion.
9. `aiGuardrails.approvalScope.contract.test.ts`: because item 4 makes `manage_ai_agents` a whole-tool member with a real `action` enum, BOTH pinned arrays must gain `'manage_ai_agents'` — the `enumerated.sort()` assertion at `:176-178` and the "exposes both enum sources" list at `:185`.
10. `effectDigest.ts` `EFFECT_DIGEST_RESOLVERS`: a `'manage_ai_agents:authorize_supervised_key'` resolver whose material is `{ agentId, opKey, partnerCeilingHasKey: boolean, orgKeys: string[] /* sorted */ }` — resolved from the org's effective agent, so an operator editing supervised keys during the approval window makes the approved digest stale and the release fails `content_changed` instead of silently granting a different authority. Returns `TARGET_ABSENT` when no partner baseline exists for the org. Omitted ⇒ `effectDigestCoverage.contract.test.ts:144-160` fails (every four-eyes surface needs a resolver or a ≥40-character `DELIBERATELY_UNPINNED` entry — use the resolver, not the exemption).
11. `apps/web/src/components/ai-risk/tierConfig.ts`: a `TIER_DEFINITIONS` tier-3 tools entry `{ name: 'manage_ai_agents (authorize_supervised_key)', description: 'Grant an AI agent a pre-authorized action key', category: 'AI Governance' }` and an `RBAC_MAPPINGS` entry `manage_ai_agents: { authorize_supervised_key: 'ai_agents.write' }`. Its parity test is one-way so omission would not fail CI — add it anyway (the file's whole purpose is to mirror `aiGuardrails.ts`).
12. `apps/docs/src/content/docs/features/ai.mdx`: add `manage_ai_agents` (authorize_supervised_key) to the Tier-3 row and a new four-eyes bullet "AI agent governance — granting an agent a pre-authorized action key". `aiGuardrailsAiDocs.parity.test.ts` requires every documented `tool` (action) pair to be machine-parseable and to resolve to the tier the docs claim.
13. Keep `manage_ai_agents` **OUT** of `POLICY_DECIDABLE_TIER3` (`policyDecidable.ts:83` — its header at `:19-21` already excludes everything four_eyes: policy is a mechanism, not a second human) and out of `TIER3_ACTIONS` (unnecessary once the registered base tier is 3).

- [ ] **Step 1:** Write `aiToolsAiAgentGovernance.test.ts` FIRST: `registerAiAgentGovernanceTools` puts `manage_ai_agents` in the map with `tier: 3`; `validateToolInput('manage_ai_agents', { action: 'authorize_supervised_key', kind: 'triage', opKey: 'manage_services:restart' })` succeeds and an unknown action fails; `checkGuardrails('manage_ai_agents', { action: 'authorize_supervised_key' })` returns `tier: 3` and `approvalScope: 'four_eyes'`; `checkAgentGuardrails('manage_ai_agents', …, <valid agent policy>)` returns `allowed: false, disposition: 'deny'` with a reason naming human-only; `isPolicyDecidableKey('manage_ai_agents:authorize_supervised_key') === false`; the effect-digest resolver returns a `material` whose bytes change when `orgKeys` changes and are stable when unrelated agent fields change.
- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/services/aiToolsAiAgentGovernance.test.ts` — expect FAIL.
- [ ] **Step 3:** Implement items 1-13. The tool handler at this point can `throw new Error('not implemented')` **only if** no test exercises it — Task 15 supplies the body in the same PR; prefer implementing 14 and 15 back to back and committing once if that is cleaner.
- [ ] **Step 4:** Run `cd apps/api && npx vitest run src/services/aiToolsAiAgentGovernance src/services/aiToolsRegistryParity.test.ts src/services/aiAgentSdkTools.registryParity.contract.test.ts src/services/aiAgentSdkTools.mcpCoverage.test.ts src/services/aiGuardrails.approvalScope.contract.test.ts src/services/actionIntents/effectDigestCoverage.contract.test.ts src/services/actionIntents/policyDecidable.test.ts src/services/aiGuardrailsTierConfig.parity.test.ts src/services/aiGuardrailsAiDocs.parity.test.ts src/services/aiAgents/verdictProfile.contract.test.ts` — ALL PASS.
- [ ] **Step 5:** Commit: `git add apps/api/src apps/web/src/components/ai-risk/tierConfig.ts apps/docs && git commit -m "feat(api): manage_ai_agents:authorize_supervised_key — tier-3 four-eyes, human-only (#4192)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`

### Task 15 (A2-5): Promote executor + creation route

**Files:** Create `apps/api/src/services/aiAgents/supervisedKeyGrant.ts`, `supervisedKeyGrant.test.ts`; modify `apps/api/src/services/aiToolsAiAgentGovernance.ts` (the handler body), `apps/api/src/routes/aiAgents.ts` (mount `POST /ai/agents/graduation/promote` beside the existing `GET /policy-decidable-keys` at line 251).

**Interfaces (produced):**
```ts
export class SupervisedKeyGrantError extends Error {
  constructor(public readonly code:
    | 'policy_decide_disabled' | 'not_eligible' | 'needs_partner_baseline'
    | 'agent_not_found' | 'already_granted' | 'non_human_origin', message: string);
}

/** The promote executor. Runs inside the release path's org-scoped context,
 *  opens ONE system transaction, and under withGraduationLock:
 *   1. re-read BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED live (throw
 *      'policy_decide_disabled' — a flag flipped off mid-approval must not grant);
 *   2. assert the intent's origin is human (`intent.requestingAgentRunId` is
 *      null) else 'non_human_origin';
 *   3. re-evaluate eligibility (evaluateGraduation) and the partner ceiling —
 *      approval time is not execution time;
 *   4. SELECT the PARTNER baseline row FOR UPDATE, then the ORG row FOR UPDATE;
 *      when no org row exists, INSERT … ON CONFLICT (org_id, kind) WHERE
 *      disabled_at IS NULL DO NOTHING a clone of the EFFECTIVE policy (same
 *      mode/allowlists/limits/recipients as currently effective — a row built
 *      from schema defaults would disable the agent and empty its allowlists),
 *      then lock and re-read the winner;
 *   5. append opKey idempotently to the org row's actAssets.supervisedActionKeys
 *      (via withAgentRowLocked, Task 8);
 *   6. audit; graduation row -> 'promoted' with promoted_at + promoted_intent_id.
 */
export async function authorizeSupervisedKey(input: {
  orgId: string; kind: AiAgentKind; opKey: string; intentId: string; actorUserId: string;
}): Promise<{ agentId: string; orgAgentId: string; keys: string[] }>;
```
- The tool handler calls `authorizeSupervisedKey` with `orgId` taken from the executing auth context's org (the intent's `org_id`, pinned by the release path) — **never** from arguments. It catches `SupervisedKeyGrantError` and returns `JSON.stringify({ error: err.code, message: err.message })`: `isReturnedToolError` (`intentReleaseWorker.ts:148-162`) treats a parsed object with an `error` key and no `success`/`data`/`configured` key as a FAILED release, so the intent terminalizes `failed:tool_returned_error` instead of reading as a false success. Do not use `googleHelpers.errorString` — that helper belongs to the Google/M365 tool families.
- Route `POST /ai/agents/graduation/promote` (`scopes`, `requireAiWrite`): body `promoteSupervisedKeyRequestSchema`; 409 `{ error: 'policy_decide_disabled' }` when the flag is off; otherwise creates the four-eyes intent through the normal `createActionIntent` path with `tool: 'manage_ai_agents'`, `action: 'authorize_supervised_key'`, arguments `{ action, kind, opKey }`, and returns `{ intentId }`. Four-eyes as built = requester + one DIFFERENT approver, first eligible approval wins (`decideApprovalRequest.ts:964-1009`); the sole-operator WebAuthn self-approval exception (`intentService.ts:574-586`) applies unchanged — say so in the route's docstring.

- [ ] **Step 1:** Write failing tests: flag off ⇒ `policy_decide_disabled` and no write; an agent-originated intent ⇒ `non_human_origin`; a key that became ineligible between approval and release ⇒ `not_eligible` and no write; partner ceiling lost ⇒ `needs_partner_baseline`; no org row ⇒ a clone is inserted carrying the EFFECTIVE mode/toolAllowlist/limits (assert each field, non-uniform fixture) and then the key; an existing org row ⇒ append only, no clone; a duplicate key ⇒ idempotent, one entry; two concurrent calls ⇒ the advisory lock serializes them and the final array has one entry (assert `pg_advisory_xact_lock` in the compiled SQL and the ordering of the two FOR UPDATE selects: partner first, org second); the graduation row ends `promoted` with `promoted_intent_id` set. Route tests: 409 with the flag off; 201 with `{ intentId }`; RBAC denies without `ai_agents:write`.
- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/services/aiAgents/supervisedKeyGrant.test.ts src/routes/aiAgents.test.ts` — expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `cd apps/api && npx vitest run src/services/aiAgents/supervisedKeyGrant src/services/aiToolsAiAgentGovernance src/routes/aiAgents` — PASS.
- [ ] **Step 5:** Commit: `git add apps/api/src && git commit -m "feat(api): P2-5 promote executor — clone-from-effective, locked org-row grant (#4192)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`

### Task 16 (A2-6): Auto-demote

**Files:** Modify `apps/api/src/services/aiAgents/supervisedKeyGrant.ts` (add the revoke half), `apps/api/src/jobs/intentReleaseWorker.ts` (the attempted-failure evidence path from Task 4), `apps/api/src/services/aiAgents/fixWatch.ts` (the `recurred` CAS from Task 6), and their tests.

**Interfaces (produced):**
```ts
/** Removes `opKey` from the ORG row's supervisedActionKeys, in the SAME
 *  transaction as the negative evidence insert and under the same
 *  withGraduationLock. Never touches `enabled`, `mode`, or the partner row. A
 *  key held only by the partner ceiling (no org grant) has nothing to revoke:
 *  returns { revoked: false } and records nothing. Notification is the caller's
 *  job, AFTER commit. */
export async function demoteSupervisedKey(input: {
  orgId: string; agentId: string; opKey: string;
  reason: 'attempted_failure' | 'recurrence';
  runId: string | null; watchId: string | null; intentId: string | null;
}): Promise<{ revoked: boolean; orgAgentId: string | null }>;

/** Post-commit notification, modelled exactly on sendRecurrenceNotifications
 *  (fixWatch.ts:292-336): recipients resolved from the RUN's immutable snapshot,
 *  priority 'high', dedupeKey `graduation-demote-<orgAgentId>-<opKey>-<runId ?? watchId>`,
 *  title/message naming the agent and the op key only. */
export async function notifyDemotion(input: {
  orgId: string; agentId: string; orgAgentId: string; opKey: string;
  reason: 'attempted_failure' | 'recurrence'; runId: string | null; watchId: string | null;
}): Promise<void>;
```
**Triggers (C9):** (a) an ATTEMPTED `failed` evidence row in namespace `policy_key` (the release worker's three attempted-failure branches from Task 4's table); (b) a watch `recurred` whose `op_keys` contains a colon key. In both cases, for each such colon key present in the ORG row's `supervisedActionKeys`: inside the evidence transaction, under `withGraduationLock`, `SELECT … FOR UPDATE` the org row, remove the key, write an audit entry `{ reason, runId, watchId, intentId, opKey }`, set the graduation row to `demoted` with `demote_reason`/`demote_run_id`/`demote_watch_id`/`demoted_at`. Notify only after the transaction commits. Auto-demote is **always on** — it does not consult `BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED`.

- [ ] **Step 1:** Write failing tests: an attempted failure on a granted key removes it and stamps `demoted`; the SAME failure on a key held only by the partner ceiling revokes nothing and writes no graduation row change; a `recurred` watch with two op keys, one granted and one not, revokes exactly one; `enabled`/`mode`/the partner row are untouched (assert the compiled UPDATE's SET clause names only `act_assets` and `updated_at`); the notification fires only after commit and its message contains no model-authored text; a lost CAS on the watch writes nothing at all.
- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/services/aiAgents/supervisedKeyGrant src/services/aiAgents/fixWatch src/jobs/intentReleaseWorker` — expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command — PASS.
- [ ] **Step 5:** Commit: `git add apps/api/src && git commit -m "feat(api): P2-5 auto-demote on attempted failure or recurrence (#4192)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`

### Task 17 (A2-7): Org merge must not carry graduated authority

**Files:** Modify `apps/api/src/services/orgMergeCustomExecutors.ts` (`mergeAiAgents`, lines 636-676) and `orgMergeCustomExecutors.test.ts`.

**Interfaces:** none new. `mergeAiAgents` gains a THIRD statement, between the collision-disable UPDATE and `buildRepoint('ai_agents', loser, survivor)`:
```sql
UPDATE ai_agents
   SET act_assets = jsonb_set(coalesce(act_assets, '{}'::jsonb), '{supervisedActionKeys}', '[]'::jsonb),
       updated_at = now()
 WHERE org_id = <loser>
   AND disabled_at IS NULL
   AND jsonb_array_length(coalesce(act_assets -> 'supervisedActionKeys', '[]'::jsonb)) > 0
```
Its row count feeds a merge note: `ai_agents: cleared graduated supervised action keys on N agent(s) from the merged-away org — a survivor org must re-earn them (evidence is leave-for-erasure)`. Rationale comment: the repoint would otherwise hand the survivor an authority nobody granted it, while the evidence that justified it stays on the loser shell.

- [ ] **Step 1:** Write failing tests: a loser org agent with two supervised keys is repointed with an EMPTY key array and the note reports 1; an agent with no keys produces no note; the disable-collision behaviour is unchanged; the partner-wide rows (`org_id IS NULL`) are never touched (assert the `org_id = loser` predicate is present in the compiled SQL).
- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/services/orgMergeCustomExecutors` — expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `cd apps/api && npx vitest run src/services/orgMergeCustomExecutors src/services/orgMergeRegistry` — PASS.
- [ ] **Step 5:** Commit: `git add apps/api/src/services/orgMergeCustomExecutors.ts apps/api/src/services/orgMergeCustomExecutors.test.ts && git commit -m "fix(api): org merge strips graduated supervised keys before repointing agents (#4192)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`

### Task 18 (A2-8): Read route + DTO

**Files:** Modify `apps/api/src/routes/aiAgents.ts` (add `GET /graduation` beside `GET /policy-decidable-keys` at line 251), `apps/api/src/routes/aiAgents.test.ts`; the DTO types already exist from Task 1.

**Interfaces (consumed):** `AiAgentGraduationDto`, `AiAgentGraduationByOrgDto`, `loadGraduationRows`, `loadActOpReliability`, `resolveEffectiveAgentSystem`.

**Route contract:** `GET /ai/agents/graduation?orgId=<uuid>&kind=<AiAgentKind>` (`scopes`, `requireAiRead`).
- With `orgId`: resolve the effective agent SERVER-SIDE via `resolveEffectiveAgentSystem(orgId, kind)` — an org token carries a `partnerId` but never passes `breeze_has_partner_access`, so it cannot read the partner baseline row itself (`agentService.ts:341-350`); never trust an agent id from the query. Returns `AiAgentGraduationDto` with `ownerScope` = `'organization'` when an org override row exists, else `'partner'`.
- Partner scope with NO `orgId`: returns `AiAgentGraduationByOrgDto` — the same rows grouped per org, for the partner-wide agent page. Org-scope callers omitting `orgId` get 400.
- `policyDecideEnabled` mirrors the live env flag; `promoteThreshold` is the effective merged limit. The route WORKS with the flag off (read-only value without a flag flip) — only the promote POST 409s.
- Every row's `state`/`blockedReason` comes from `refreshGraduationRow` so a read is never staler than the request.

- [ ] **Step 1:** Write failing route tests: org-scope call returns `version: 1` with rows and `actOpReliability`; the agent id in the response is the resolver's, not one supplied in the query (pass a bogus `agentId` param and assert it is ignored); a partner-scope call with no `orgId` returns `byOrg`; an org-scope call with no `orgId` is 400; the flag off still returns 200 with `policyDecideEnabled: false`; RBAC denies without `ai:read`; a cross-org `orgId` is denied by the scope middleware.
- [ ] **Step 2:** Run `cd apps/api && npx vitest run src/routes/aiAgents` — expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `cd apps/api && npx vitest run src/routes/aiAgents src/services/aiAgents/graduationService` — PASS.
- [ ] **Step 5:** Commit: `git add apps/api/src/routes packages/shared && git commit -m "feat(api): P2-5 graduation read route + versioned DTO (#4192)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`

### Task 19 (A2-9): End-to-end live-Postgres proof

**Files:** Create `apps/api/src/__tests__/integration/aiAgentGraduation.integration.test.ts`.

- [ ] **Step 1:** Write the suite as ONE ordered narrative against a real DB: seed a partner baseline agent holding `manage_services:restart` in `supervisedActionKeys` and an org with NO agent override → assert `resolveEffectiveAgent` returns `supervisedActionKeys: []` (the ceiling, C3) → insert `promoteThreshold` `verified` evidence rows dated ≥ 14 days back through the real writers (release a real intent, then reach `held_qualified` on its watch) → `refreshGraduationRow` reports `eligible` → `POST /ai/agents/graduation/promote` creates a four-eyes intent → approve it as a DIFFERENT user (first eligible approval wins) → the release executes `authorizeSupervisedKey` → an org agent row now exists, cloned from the effective policy, holding the key, and `ai_agent_graduation` is `promoted` with `promoted_intent_id` → `resolveEffectiveAgent` now returns the key (so `attemptPolicyDecision` would see it) → release a second intent for the same key that fails with `execution_error` → the `failed` evidence row, the org-row key removal, and the `demoted` graduation row all committed together, the partner row untouched, and one high-priority notification queued → `refreshGraduationRow` reports `tracking` with a window that ignores everything at or before `demoted_at`.
- [ ] **Step 2:** `docker compose -p breeze-test-ai-agents-p2-5 -f docker-compose.test.yml up -d postgres`, then `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiAgentGraduation.integration.test.ts` — expect FAIL first, then PASS.
- [ ] **Step 3:** Re-run the five registry contract suites listed in Task 10 Step 3 plus `aiAgentOpEvidence.integration.test.ts` — ALL PASS.
- [ ] **Step 4:** `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`; `pnpm lint` in `apps/api`, `packages/shared`, `apps/web` (tierConfig.ts changed), `apps/docs`.
- [ ] **Step 5:** Commit: `git add apps/api/src/__tests__ && git commit -m "test(api): P2-5 end-to-end graduation proof — ceiling, promote, policy-decide, demote (#4192)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`; run **Final verification**; open **PR A2** targeting main with body `Part of #4192`. STOP at the open PR.

---

## PR B — web (branch `feature/4187-ai-agents-p2/wave-4192-b`, base main, opened after A2 merges)

### Task 20 (B1): Graduation panel + partner ceiling hint

**Files:**
- Create: `apps/web/src/components/settings/AiAgentGraduationPanel.tsx`, `AiAgentGraduationPanel.test.tsx`
- Modify: `apps/web/src/components/settings/AiAgentForm.tsx` (render the panel below the `ai-agent-policy-decide` fieldset at lines 679-717; add the ceiling hint inside that fieldset), `apps/web/src/locales/{de-DE,en,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/settings.json`

**Interfaces (consumed):** `AiAgentGraduationDto`, `AiAgentGraduationByOrgDto`, `AiAgentGraduationRowDto`, `AiAgentActOpReliabilityDto` from `@breeze/shared`; `fetchWithAuth`; `runAction` + `ActionError` from `apps/web/src/lib/runAction.ts`.

- Panel props: `{ orgId: string | null; kind: AiAgentKind; isPartnerScope: boolean }`. Fetches `GET /ai/agents/graduation?orgId=…&kind=…` in a `useEffect` with `fetchWithAuth` (the file's existing pattern, `AiAgentForm.tsx:300`); partner scope with no `orgId` renders the `byOrg` grouping, and must surface `byOrgTruncated` (a partner over the 400-org cap sees only the first 400 by name — a silently short list reads as "these orgs have no evidence").
- Renders two tables: **Graduation** (op key, state badge, `verified / promoteThreshold`, failed, recurred, first verified, blocked reason) and **Act-op reliability** (op key, executed, verified, failed, recurred — read-only, dot keys are never promotable, say so in the caption).
- A **Promote** button appears only on rows with `state === 'eligible'` AND `policyDecideEnabled === true`. It opens a confirm dialog, then `runAction({ request: () => fetchWithAuth('/ai/agents/graduation/promote', { method: 'POST', body: JSON.stringify({ orgId, kind, opKey }) }), successMessage: …, errorFallback: …, friendly: …, onUnauthorized: … })` and the success toast links to `/approvals`. Copy states plainly that approval affects **future runs only**.
- With `policyDecideEnabled === false` the whole panel is read-only with an explanatory note ("Pre-authorized execution is turned off for this deployment; these figures are informational") — the panel is the visible value that needs no flag flip.
- Ceiling hint inside the existing policy-decide fieldset, shown on the PARTNER form: "Partner-level keys are a ceiling, not a grant. Each organization's agent must be granted the key separately — through graduation or by editing that org's agent."
- `data-testid`s follow the file's kebab convention: `ai-agent-graduation-panel`, `ai-agent-graduation-row-<opKey>`, `ai-agent-graduation-promote-<opKey>`, `ai-agent-act-reliability-row-<opKey>`, `ai-agent-graduation-readonly-note`, `ai-agent-supervised-keys-ceiling-hint`.
- All copy through `t('aiAgentsPage.graduation.*')` in the `settings` namespace, in **all 8 locales**. Never compare UI logic against `i18n.t(...)` output in a test (the tr-TR rule).

- [ ] **Step 1:** Write failing component tests: rows render from a mocked DTO with DISTINCT values per column (non-uniform fixture, so a wrong-column bug surfaces); the Promote button is absent for `tracking`/`promoted`/`demoted` rows and absent for an `eligible` row when `policyDecideEnabled` is false; clicking it POSTs the exact body and shows the toast; a 409 shows the friendly message and does not remove the row; `blockedReason` renders its own localized string per value (five cases); the read-only note appears exactly when the flag is off; the partner form shows the ceiling hint and the org form does not.
- [ ] **Step 2:** Run `cd apps/web && npx vitest run src/components/settings/AiAgentGraduationPanel.test.tsx` — expect FAIL.
- [ ] **Step 3:** Implement the panel, the `AiAgentForm.tsx` wiring, and the 8 locale files.
- [ ] **Step 4:** Run `cd apps/web && npx vitest run src/components/settings src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/__tests__/no-silent-mutations.test.ts` — PASS (add `--pool=threads --maxWorkers=2` if a dev stack is up; `AiAgentForm.tsx` is already in the no-silent-mutations target list at line 64, so any new mutating fetch must be `runAction`-wrapped). Then `cd apps/web && npx astro check`.
- [ ] **Step 5:** Commit: `git add apps/web && git commit -m "feat(web): P2-5 graduation panel, act-op reliability, partner ceiling hint, 8 locales (#4192)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`

### Task 21 (B2): "Approve and always allow" on the approvals inbox

**Files:** Modify `apps/web/src/components/approvals/ApprovalsInbox.tsx` (the card action group at lines 626-652; the `PendingApproval` type at lines 42-71 gains nothing — the eligibility comes from a separate fetch), `ApprovalsInbox.test.tsx`, `apps/web/src/locales/*/approvals.json` (8 files).

**Interfaces (consumed):** `AiAgentGraduationDto`; `decideIntentApproval` from `@/lib/intentApprovals`; `runAction`.

- On mount, for each DISTINCT `(orgId, actionToolName)` among supervised agent-originated cards, fetch `GET /ai/agents/graduation?orgId=…&kind=…` once and build a `Set<opKey>` of `state === 'eligible'` rows. Cache per orgId for the component's lifetime; a fetch failure disables the affordance silently (it is additive — never block the existing Approve).
- A **secondary** button "Approve and always allow" renders next to Approve only when: the card's `approvalScope === 'supervised'`, its `${actionToolName}:${action}` is in that org's eligible set, and the graduation DTO reported `policyDecideEnabled: true`. `data-testid={\`approval-always-allow-${approval.id}\`}`.
- Clicking it: first the normal `decideIntentApproval(approval.id, 'approve')` (the card's own intent is approved the ordinary way — graduation never retro-authorizes it), then `runAction` POSTing `/ai/agents/graduation/promote`. The confirm copy must say the promote applies to **future runs only** and needs a second approver. If the promote POST fails, the approve has already succeeded — surface that explicitly in the error toast rather than implying the whole action failed.
- Four-eyes cards are excluded structurally: they are never `approvalScope === 'supervised'` (the existing `isGroupable` comment at `ApprovalsInbox.tsx:95-118` documents this) — assert it in a test rather than adding a second condition.

- [ ] **Step 1:** Write failing tests: the button renders only for a supervised card whose key is eligible; it is absent for a four-eyes/`critical` card, for an ineligible key, and when `policyDecideEnabled` is false; clicking calls `decideIntentApproval` FIRST and then the promote POST (assert call order); a failing promote after a successful approve produces the "approved, promotion failed" toast and the card still leaves the list; a graduation fetch failure hides the button and logs nothing user-facing.
- [ ] **Step 2:** Run `cd apps/web && npx vitest run src/components/approvals/ApprovalsInbox.test.tsx` — expect FAIL.
- [ ] **Step 3:** Implement + the 8 `approvals.json` locale files.
- [ ] **Step 4:** Run `cd apps/web && npx vitest run src/components/approvals src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/__tests__/no-silent-mutations.test.ts` — PASS; `cd apps/web && npx astro check`; `pnpm lint` in `apps/web`.
- [ ] **Step 5:** Commit: `git add apps/web && git commit -m "feat(web): P2-5 approve-and-always-allow on eligible supervised agent cards (#4192)" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"`; run **Final verification**; open **PR B** targeting main with body `Closes #4192`. STOP at the open PR.

---

## Final verification (before each PR opens)

- [ ] **Migration name re-check (PR A1 only, and again at merge time).** Run `git fetch origin main && git ls-tree --name-only origin/main apps/api/migrations | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(s.trim().split('\n').sort((a,b)=>a.localeCompare(b)).slice(-3).join('\n')))"`. `2026-09-29-ai-agents-graduation-evidence.sql` **must sort after** the newest name printed. If W06 landed `2026-09-30-…` first, rename the file to sort after it (the file is unmerged, so renaming is safe) **and sweep every reference**: `grep -rn '2026-09-29-ai-agents-graduation-evidence' apps/api` — integration suites that replay migrations by path turn a missed rename into an `ENOENT` minutes into Integration Tests. Never use today's real date: shipped names run ahead of it.
- [ ] `pnpm lint` in every package the PR touched (`apps/api`, `packages/shared`, `apps/web`, `apps/docs`).
- [ ] `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`; `cd packages/shared && npx tsc --noEmit -p tsconfig.json`; `cd apps/web && npx astro check`.
- [ ] Contract suites, against a live DB where required — ALL must pass, and all of them are Integration-Tests-only except the last four:
  `rls-coverage.integration.test.ts`, `tenantCascade.integration.test.ts`, `tenant-export-policy.integration.test.ts`, `tenantExportErasureRoundtrip.integration.test.ts`, `orgMergeRegistry.integration.test.ts`, and (unit, **Test API**) `workerEntrypointClosure.contract.test.ts`, `effectDigestCoverage.contract.test.ts`, `aiAgentSdkTools.registryParity.contract.test.ts`, `policyDecidable.test.ts`, `verdictProfile.contract.test.ts`.
- [ ] Mechanical registry grep (this is the check code review has caught 0/5 times and the contract tests 5/5): `grep -rn 'ai_agent_op_evidence\|ai_agent_graduation' apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/orgMergeRegistry.ts` — six hits, two per file. And `grep -n 'op_keys\|intent_id\|source_kind' apps/api/src/services/tenantExportPolicyRegistry.ts` must show the three new fix-watch columns.
- [ ] `pnpm db:migrate` twice in a row on a fresh DB (idempotency), then `pnpm db:check-drift` clean.
- [ ] Confirm no forbidden profile literal crept in: `cd apps/api && npx vitest run src/services/aiAgents/verdictProfile.contract.test.ts`.
- [ ] PR body: A1 and A2 carry `Part of #4192`; B carries `Closes #4192`. Every body lists, explicitly, each scope call this plan made — the contract points implemented (C1–C16), the migration filename as merged, the registries touched, the contract suites run with their results, and any item from **Deviations from the contract** below that the PR relies on.
- [ ] All three PRs target **main**, so `gh pr checks` is real. Do NOT stack them: a PR based on a sibling branch runs no CI at all and reads green.

---

## Deviations from the contract

Every item below was verified by reading the cited file in this worktree (which equals `origin/main`). Where the contract and the code disagree, the code wins and the plan follows the code.

1. **C4's terminal-branch classification is under-specified and one branch is missing.** The contract lists "generic pre-execution CAS failures (:237-245)" as a not-counted branch, but `intentReleaseWorker.ts:237-257` is `failIntent`'s *definition*, not a call site. The real inventory is the twelve exits tabulated in Task 4, and it includes a branch the contract omits: `failOnPlaintextSecretGuard` (`:284-294`) CASes to `failed` with `executed: true` after the tool has already run, so it IS an attempted failure. More usefully, the codebase already carries the exact discriminator the contract was reaching for: `failIntent`'s `executed?: boolean` option stamps `executed_at` "used for `execution_error` and `secret_seal_invariant_violated`, both of which mean a real attempt was made … the earlier revalidation stops never touched execution" (`:229-236`). The plan therefore defines attempted-ness as "the terminal write stamps `executedAt`" rather than as a hand-maintained line-number list.

2. **The canonical key resolver is not exported and cannot simply be exported.** C4 says to use "the resolver exported from `policyDecide.ts:67-74`". `canonicalPolicyKey` is module-private there (`policyDecide.ts:71`) with one caller (`:534`). Exporting it from `policyDecide.ts` would drag that module's graph (`attemptPolicyDecision`, the exposure ledger, the kill-state reader) into the release worker and the evidence writers. The plan moves it to a new leaf module `services/actionIntents/canonicalPolicyKey.ts` that imports only `resolveActionForTool` (`aiGuardrails.ts:1241`), and `policyDecide.ts` imports it back. One definition, no graph bloat, and `policyDecide.ts` stays clean for `verdictProfile.contract.test.ts`.

3. **`source_id` for watch evidence must include the op key.** C1 defines UNIQUE `(source_kind, source_id, metric)` and gives `source_id` = "watch id" for watches, while C5 requires one evidence row per entry of `op_keys` with the same metric. Those two are inconsistent: N keys would collide on one unique tuple and all but the first would be silently dropped by `ON CONFLICT DO NOTHING`. The plan uses `source_id = '<watchId>:<opKey>'` (`watchEvidenceSourceId`).

4. **`source_id` for act executions is `<runId>:<index>`, not `<run_id>:<tool_use_id>`.** C1 proposes a `tool_use_id`, but `OutcomeExecutedAction` (`runLoop.ts:186-217`) carries no such field — it has `executionId`, which is documented to fall back to the literal `'(inline)'` when the execution-ledger write fails (`:189-198`), so it is not unique within a run. The plan writes act evidence in `finishRun` (after the terminal CAS is won, so at most once per run — `finishRun` returns early on `!moved`) using the action's index in `outcome.executedActions`, which is deterministic and unique.

5. **The agent-principal denial goes at `aiGuardrails.ts:1623-1626`, not `:1654-1710`.** `checkAgentGuardrails` starts at `:1592`; the correct insertion point is immediately after the `isSecretBearingTool` deny at `:1623-1625`, before the multiplexed-action resolution. The `:1654-1710` range is further down the same function.

6. **The approvalScope contract test needs TWO list edits at `:176-178` and `:185`, not one at `:177-191`.** Making `manage_ai_agents` a whole-tool `TIER3_FOUR_EYES_TOOLS` member (which C8 requires, and which is the safer fail-closed posture) puts it into `multiplexedBackstopTools()`, so both the `enumerated.sort()` array (`:176-178`) and the separate "exposes both enum sources" list (`:185`) must gain the name.

7. **`KNOWN_MISSING_TOOL_TIERS` does not live in `aiAgentSdkTools.ts`.** C8 says to keep the tool out of it; the set is actually in `aiAgentSdkTools.registryParity.contract.test.ts:43+` and may only shrink. Registering `TOOL_TIERS.manage_ai_agents = 3` is what keeps it out — no edit to that file at all.

8. **The `TOOL_TIERS` template is `manage_organizations`, not `manage_tickets`.** `manage_tickets` has a Zod schema and `TOOL_PERMISSIONS` entries but NO `TOOL_TIERS` entry and NO `tool()` declaration, so it is unreachable from chat/MCP today — the exact failure mode documented at `aiAgentSdkTools.ts:2256-2261`. Copying it would reproduce the bug.

9. **`effectDigest` needs a real resolver, and its material must be the authority set, not the evidence counts.** C8 says only "add a resolver". Pinning the eligibility counters would make the digest drift on every new evidence row and fail every promotion approval. The plan pins `{ agentId, opKey, partnerCeilingHasKey, orgKeys }` — which drifts exactly when someone edits supervised keys during the approval window, which is the TOCTOU the effect digest exists to catch.

10. **The intent-watch recovery sweep needs no `workerRegistry.ts` entry.** C5 asks for "a recovery sweep in `fixWatchWorker`". Adding a new registry entry would force edits to `EXPECTED_NAMES` and the hard-coded `expect(entries.length).toBe(115)` at `workerEntrypointClosure.contract.test.ts:453`. The plan instead widens `fixWatchQueueJobDataSchema` (`queueSchemas.ts:321-324`) with a `{ phase: 'recover' }` variant on the existing queue and job name; at a 2-minute interval it is also below `COARSE_REPEAT_INTERVAL_MS`, so `scheduleRegistry.contract.test.ts` needs no slot either. The A1 retention worker DOES need one registry entry (and the `115 → 116` bump), and A2's daily evaluator reuses that same queue so the count bumps only once.

11. **`createFixWatchRow`'s conflict target must gain the index predicate.** C5 requires the `run_id` UNIQUE to become partial. `createFixWatchRow` currently uses `.onConflictDoNothing({ target: aiAgentFixWatches.runId })` (`fixWatch.ts:177`); Postgres cannot infer a partial unique index without its predicate. drizzle-orm 0.45.2's `onConflictDoNothing({ target, where })` renders `on conflict (col) where <pred> do nothing` (`insert.js:107`), which is exactly the form needed — verified in the installed package, not assumed.

12. **`recordVerdictFeedback` must keep its "a different user may never overwrite" rule.** C10 describes the rewrite as `SELECT … FOR UPDATE` + update + upsert, without mentioning the existing CAS predicate `feedback_by IS NULL OR feedback_by = <this user>` (`alertVerdicts.ts:612-615`) and its documented 404-vs-409 contract. The plan preserves both, moving the check inside the lock (which strictly improves it — the current follow-up SELECT is not atomic with the UPDATE).

13. **Line-number corrections (all minor, code unchanged):** `orgMergeCustomExecutors.mergeAiAgents` is `:636-676`, not `:637-675`. `updateAgent` is `:470-533`, not `:470-520`. `TIER3_FOUR_EYES_ACTIONS` is `:309-330`. `effectDigestCoverage.contract.test.ts`'s requirement is at `:144-160`. `workerEntrypointClosure.contract.test.ts`'s global-closure block is `:451-473`. `effectivePolicy.test.ts`'s pinned assertion is the `it(...)` beginning at `:367` with the assertion at `:372-374` — the contract's cite is correct.

14. **There is no policy-decide deploy runbook.** C3 asks for "a note in `docs/deploy` runbook for policy-decide". `docs/deploy/` contains no such file (`ai-kill-switch.md`, `agent-server-url-migration.md`, `agent-update-trust-bootstrap.md`, the two M365 executor docs); the only prose about the flag lives in the wave-5B plan and the spec. The plan puts the ceiling note in `docs/deploy/ai-kill-switch.md`, which already documents the policy-decide lane's kill behaviour, rather than creating a one-paragraph file.

15. **Unresolved / defaulted:** C1 does not say whether `run_id` carries a foreign key. The plan gives it a composite `(run_id, org_id) → ai_agent_runs(id, org_id) ON DELETE SET NULL` (the target `ai_agent_runs_id_org_uq` already exists, `aiAgents.ts:161`) — it makes a cross-tenant forged pointer a 23503 even under a system context, which is the tenancy invariant this repo holds everywhere else, and `SET NULL` keeps the evidence when a run is erased. If a reviewer prefers the `rule_id` treatment (a bare historical uuid with no FK), dropping the constraint is a one-line change with no other consequence.
