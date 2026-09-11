---
tracking_issue: LanternOps/breeze#5612
---

# AI Script Authoring, Review, and Reviewer-Gated Execution — Roadmap and Cross-Wave Contracts

> **For agentic workers:** this roadmap is the contract layer. Each wave has its own plan
> (`2026-09-11-ai-script-authoring-w0N-*.md`) that argues from this file and from the spec.
> Implement a wave with superpowers:subagent-driven-development or superpowers:executing-plans.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-11-ai-script-authoring-and-review-design.md` (Draft v2, approved by Todd 2026-09-11)

**Goal:** the AI assistant and background agents can author a script as an immutable proposal, which is scanned, classified, independently reviewed by a model, approved by a human on a readable card (or, when a partner ceiling and an org grant both allow it, released unattended under deterministic invariants), executed with full provenance, verified, and optionally promoted to the library.

**Tracking:** feature `LanternOps/breeze#5612`; GitHub wave keys W01–W06 map to the plan files in table order (each sub-issue title names its plan file). Wave branches are `feature/5612-ai-script-authoring/wave-<sub-issue#>`; use `get_feature_status` for current state, never this doc.

---

## 1. Waves and dependencies

| Wave | Plan | Depends on | Produces working software that… |
|---|---|---|---|
| W01a Script versions rebuild | `…-w01a-script-versions.md` | — | every script writer cuts an immutable `script_versions` row; unique `(script_id, version)`; cascade FK; INSERT+SELECT RLS; backfill; provenance columns present but empty |
| W01b Proposals, execution source, tools | `…-w01b-proposals-and-tools.md` | W01a | `propose_script` / `get_script_proposal` exist behind the flag; `run_script { proposalId }` validates, is guarded, digests, and dispatches a proposal-backed execution once a proposal is `reviewed` (no reviewer yet, so nothing is runnable until W02) |
| W02 Reviewer | `…-w02-reviewer.md` | W01b | `script-review` worker turns `proposed` into `reviewed` with a structured verdict and classifier-derived floors; budget reserved and settled |
| W03 Human loop + verification | `…-w03-human-loop-and-verification.md` | W02 | approval cards (web, mobile, helper) render the proposal; STRICT acknowledgement ceremony on decide; request-changes loop; `script-verify` job; library provenance UI; Save to library gated on `verified`; flag defaults on |
| W04 Unattended lane | `…-w04-unattended-lane.md` | W03 | `ai_script_policies` + `ai_script_lane_state`; `script_reviewer` autonomy inside `createActionIntent`; `revalidateRelease` branch; settings UI; checkpoint prerequisite; lane off by default |
| W05 Close the loop | `…-w05-close-the-loop.md` | W03 (W04 for lane metrics) | device activity, risk dashboard metrics, docs, flag removal |

```
W01a ──► W01b ──► W02 ──► W03 ──► W04
                                └──► W05 (lane metrics land after W04)
```

W01a and W01b are separate PRs and separate wave sub-issues. W05 may start after W03 and take a follow-up PR for the lane metrics once W04 lands.

## 2. Global constraints (copied from the spec; every task inherits them)

- Feature flag `BREEZE_AI_SCRIPT_AUTHORING_ENABLED` (env, default `false` until W03; W03 flips the default to `true`; W05 removes it). Read through `apps/api/src/config/` like other `BREEZE_*` flags. Registration in the tool registry and `TOOL_TIERS` is **unconditional** (`aiAgentSdkTools.registryParity.contract.test.ts:179-194` reddens otherwise); the flag gates the SDK `tool()` definitions, the agent capability group, and the handlers, and `run_script { proposalId }` returns a tool error `feature_disabled` when off.
- Migrations are named to sort after the newest shipped file (`2026-10-15-170200-organization-key-dates.sql` on 2026-09-11). **Slots:** W01a `2026-10-16-100000-script-versions-immutable.sql`; W01b `2026-10-16-100100-script-proposals.sql`, `2026-10-16-100200-script-executions-source.sql`, `2026-10-16-100300-scripts-origin.sql`; W02 `2026-10-16-100400-llm-egress-events-script-review-surface.sql`; W03 `2026-10-16-101000-script-proposal-acknowledged-patterns.sql`; W04 `2026-10-16-110000-ai-script-policies.sql`, `2026-10-16-110100-action-intents-script-reviewer.sql`. Re-verify against `origin/main` at push (`scripts/check-migration-naming.sh --against-ref origin/main`); if main gained a later file, rename to sort after it and sweep references. Idempotent, no inner `BEGIN`/`COMMIT`; any file that writes rows starts with `SELECT set_config('breeze.scope', 'system', true);` and reports row counts via `RAISE WARNING`.
- Tenancy per CLAUDE.md: shape 1 for `script_proposals`, `script_proposal_reviews`, `ai_script_lane_state` (`breeze_has_org_access(org_id)` OR system, FORCE); dual-axis org XOR partner for `ai_script_policies` with the separate `FOR SELECT`-only partner-wide branch. Register every `org_id` table in `CORE_ORG_CASCADE_DELETE_ORDER` (alphabetical, FK children before parents), classify **every new column** on every org-cascade table in `CORE_TENANT_EXPORT_POLICY`, add reviews to `AUDIT_ADMIN_REQUIRED_TABLES`, policies to `DUAL_AXIS_TENANT_TABLES` and `XOR_OWNERSHIP_DUAL_AXIS_TABLES`, reviews and lane-state to `orgMergeRegistry` as `leave-for-erasure`, proposals as `custom` (fence non-terminal rows to `expired` + no-op move; `leave-for-erasure` is a no-op in both phases, `orgMerge.ts:704-707`), the org policy row as repointed config (`repoint-dedupe` if the partial unique on `org_id` demands it). Composite FKs referencing `org_id` are `DEFERRABLE INITIALLY IMMEDIATE`.
- `aiGuardrails.ts` must not import the tool registry or DB schema (`aiGuardrails.imports.contract.test.ts`). New tools go in `TOOL_TIERS` and the agent catalog in the same PR (`aiAgentSdkTools.registryParity.contract.test.ts`).
- No new agent-facing payload fields; the Go agent is unchanged.
- Web mutations go through `runAction`; new i18n keys need real translations in all locales (`translationCoverage.test.ts`).
- Tests sit beside source. Run one file with `cd apps/api && npx vitest run <path>`; integration suites need `pnpm test-stack up` and are run explicitly before PR.

## 3. Cross-wave contracts (exact names; implementers see only their own wave)

### 3.1 Shared package (`packages/shared`)

Produced by **W01b** in `packages/shared/src/utils/scriptSecurityPatterns.ts` (extends the existing module; keep its Go-source parity test style):

```ts
export const SCANNER_VERSION = '2026-09-11.1';
export const TOUCH_CLASSES = [
  'registry','services','processes','files_system','files_user','temp_files',
  'network_egress','firewall','credentials','users_groups','packages','scheduled_tasks',
  'disk','boot','security_tooling','dns_cache','printing','browser','shell_eval',
] as const;
export type TouchClass = (typeof TOUCH_CLASSES)[number];
export const LANE_HARD_DENIED_CLASSES: ReadonlySet<TouchClass>; // credentials, security_tooling, boot, disk, shell_eval, users_groups, firewall
export interface ScriptScanResult {
  scannerVersion: string;
  basicHits: string[];        // pattern descriptions, agent wording
  strictHits: string[];
  touchClasses: TouchClass[]; // sorted, unique
  touchedNames: { services: string[]; paths: string[]; registryKeys: string[] };
}
export function scanScriptContent(content: string, language: ScriptLanguage): ScriptScanResult;
```

Produced by **W01b** in `packages/shared/src/validators/scriptProposals.ts`:

```ts
export const RISK_TIERS = ['low','medium','high','critical'] as const;
export type RiskTier = (typeof RISK_TIERS)[number];
export function riskTierRank(t: RiskTier): number; // low 0 … critical 3
export const scriptVerificationClaimSchema: z.ZodType<ScriptVerificationClaim>; // union: exit_code | service_running | process_absent | file_exists | output_matches
export const proposeScriptInputSchema;   // language, content ≤ 65536, goal, expectedEffect, verification, rollbackNote?, deviceIds 1..10, runAs?, timeoutSeconds? ≤ 3600, supersedesProposalId?
export const SCRIPT_PROPOSAL_STATUSES = ['proposed','scan_rejected','review_failed','reviewed','approved','rejected','changes_requested','expired','superseded','executed','verified','verification_failed','promoted'] as const;
```

Produced by **W02** in the same validators file:

```ts
export const scriptReviewVerdictSchema; // summary ≤ 600, goalMatch yes|partial|no, riskTier, blastRadius string[], reversible, verificationAdequate, findings[{severity: 'info'|'warning'|'blocking', text, lineRef?: number}], recommendedAction approve|changes|reject
export type ScriptReviewVerdict = z.infer<typeof scriptReviewVerdictSchema>;
```

`packages/shared/src/types/scriptProposals.ts` is **created by W01a** with `ScriptOrigin` (`'human'|'ai_proposal'|'imported'|'system'`) and `ScriptApprovalMethod` (`'supervised_self'|'four_eyes'|'unattended_reviewer_gated'|'direct_ui'|'automation'`), because `ScriptVersionProvenance` consumes them; **W01b extends** the same file with `ScriptProposal`, `ScriptProposalReview`, `ScriptProposalStatus` — the API DTO shapes the web/mobile/helper read. Keep the two W01a types byte-identical.

### 3.2 Script versions (W01a)

`apps/api/src/services/scriptVersions.ts`:

```ts
export interface ScriptVersionProvenance {
  origin: ScriptOrigin;
  proposalId?: string | null; reviewId?: string | null; reviewedAt?: Date | null;
  approvedBy?: string | null; approvedAt?: Date | null; approvalMethod?: ScriptApprovalMethod | null;
  changelog?: string | null; createdBy: string | null;
}
/** Locks the script row FOR UPDATE, increments scripts.version, inserts the version row
 *  (content, language, timeout_seconds, run_as, parameters, content_digest) and returns it.
 *  Must be called inside the caller's transaction. The ONLY writer of script_versions. */
export function cutScriptVersion(tx: DbTransaction, args: { scriptId: string; provenance: ScriptVersionProvenance }): Promise<ScriptVersionRow>;
export function headScriptVersion(db: Db, scriptId: string): Promise<ScriptVersionRow | null>; // row where version = scripts.version
export function sha256Content(content: string): string; // canonical: NFC, \r\n → \n, no trailing whitespace change
```

Writers converted in W01a: `scriptWrite.insertScriptRow` (inserts at `version: 0` so the helper's increment yields v1 under one contract; accepts `opts.provenance?: ScriptVersionProvenance` and passes it to `cutScriptVersion`, which W03's promote relies on to avoid a double cut), `routes/scripts.ts` PUT (content, parameters, language, timeout, runAs all bump), org-clone (`routes/scripts.ts:564-587`), `scriptClone.ts`, `scriptBundle/index.ts` (after-image), `systemScriptLibrary.ts` (create at `:307` and update at `:353-376`). `script_versions` is in `PARENT_FK_JOIN_POLICY_TABLES` (`rls-coverage.integration.test.ts:750`), which demands all four DML policies; W01a adds a named `APPEND_ONLY_PARENT_FK_TABLES` exemption with an inverse assertion.

### 3.3 Proposals, dispatch source, guardrail, digest (W01b)

`apps/api/src/services/scriptProposals/index.ts` (hub) with per-concern files:

```ts
// proposals.ts
export function createScriptProposal(auth: AuthContext, input: ProposeScriptInput, author: { kind: 'chat_session'; sessionId: string } | { kind: 'agent_run'; agentRunId: string }): Promise<{ proposal: ScriptProposalRow; scan: ScriptScanResult }>;
export function getScriptProposalForPrincipal(auth: AuthContext, proposalId: string): Promise<ScriptProposalRow | null>; // org-scoped read
export function supersedeProposal(tx, oldId: string, newId: string): Promise<void>;
export function transitionProposal(tx, proposalId: string, from: ScriptProposalStatus[], to: ScriptProposalStatus, patch?: Partial<ScriptProposalRow>): Promise<boolean>; // CAS on status
/** Atomically claims the proposal for one intent: UPDATE … SET intent_id = $2, status='approved'|'reviewed'-preserving WHERE id=$1 AND intent_id IS NULL AND status='reviewed' AND expires_at > now(). Returns false if already consumed. */
export function consumeProposalForIntent(tx, proposalId: string, intentId: string): Promise<boolean>;
// runnable.ts
export type ProposalRunnability = { ok: true; proposal: ScriptProposalRow } | { ok: false; reason: 'not_found'|'wrong_org'|'not_reviewed'|'expired'|'superseded'|'consumed'|'device_not_targeted'|'run_as_mismatch'|'timeout_mismatch'|'parameters_not_allowed' };
export function assertProposalRunnable(auth: AuthContext, input: { proposalId: string; deviceIds: string[]; runAs?: string; timeoutSeconds?: number; parameters?: unknown }): Promise<ProposalRunnability>;
// guardrailContext.ts
export function loadProposalGuardrailContext(input: Record<string, unknown>, orgId: string): Promise<GuardrailContext | undefined>; // { proposal: { riskTier, strictHits } } when input.proposalId is set
// dispatchSnapshot.ts
export interface ProposalDispatchSnapshot { proposalId: string; contentDigest: string; language: ScriptLanguage; runAs: 'system'|'user'; timeoutSeconds: number; deviceIds: string[]; scannerVersion: string }
export function proposalDispatchSnapshot(p: ScriptProposalRow, deviceIds: string[]): ProposalDispatchSnapshot;
```

`apps/api/src/services/aiGuardrails.ts` gains an optional third parameter, no DB access:

```ts
export interface GuardrailContext { proposal?: { riskTier: RiskTier; strictHits: string[] } }
export function checkGuardrails(toolName: string, input: Record<string, unknown>, context?: GuardrailContext): GuardrailCheck;
// run_script with input.proposalId: tier 3; approvalScope = context.proposal.riskTier in {low,medium} ? 'supervised' : 'four_eyes'; missing context ⇒ deny (tier 4, reason 'proposal_context_missing').
```

Callers that pass the context in W01b: the SDK tool dispatch in `aiAgentSdk.ts` (before `checkGuardrails`), the agent `runLoop.ts` proposal path, and **`createActionIntent` itself**, which calls `checkGuardrails` at `intentService.ts:1042` and rejects tier ≥ 4 — so `CreateActionIntentInput` gains `guardrailContext?: GuardrailContext` and W04's lane paths must pass it too. `checkAgentGuardrails` (`aiGuardrails.ts:1744`) passes it through. `resolveApprovalScope(toolName, action, input, context?)` gains the same optional parameter. Chat proposals get `session_id` from the SDK `onPostToolUse` hook for `propose_script` (org-scoped update from the output's `proposalId`), because registry-resident handlers never see the chat session id.

`apps/api/src/services/scriptDispatch.ts`:

```ts
export type ScriptDispatchSource =
  | { kind: 'saved'; script: typeof scripts.$inferSelect; automationRunId?: string | null }
  | { kind: 'proposal'; proposal: ScriptProposalRow; snapshot: ProposalDispatchSnapshot };
// both kinds insert script_executions with source_kind, snapshot columns, and provenance (§4.1 of the spec)
```

`apps/api/src/services/actionIntents/effectDigest.ts`: the `run_script` resolver branches on `args.proposalId` → `runScriptProposalDigestMaterial(proposalRow, args)` = `{ proposalId, contentDigest, language, runAs, timeoutSeconds, deviceIds: sorted, scannerVersion }`; returns `null` never — an unresolvable proposal throws (the module's first throwing path; today sentinels become `effect_digest = NULL`, which both release paths treat as nothing to check) and intent creation fails with intent error code `effect_digest_unresolvable`.

Tools (W01b, `apps/api/src/services/aiToolsScriptProposals.ts`, registered in `aiTools.ts` hub, `TOOL_TIERS`, `agentToolCatalog.ts` group `author_scripts`): `propose_script` (tier 1), `get_script_proposal` (tier 1). `run_script` schema in `aiToolSchemas*.ts` and `aiAgentSdkTools.ts` gains `proposalId` with `scriptId` XOR `proposalId` refinement.

Review queue **defined in W01b, implemented in W02**: `apps/api/src/services/scriptProposals/reviewQueue.ts` exports `SCRIPT_REVIEW_QUEUE = 'script-review'`, `ScriptReviewJobData = { proposalId: string; orgId: string; attempt: number }`, `enqueueScriptReview(data)`, `waitForReviewCompletion(proposalId, timeoutMs): Promise<ScriptProposalReviewRow | null>` (polls the reviews table every 2 s, circuit-breaks after 5 DB errors like `waitForApproval`).

### 3.4 Reviewer (W02)

`apps/api/src/services/scriptProposals/reviewer.ts` and `apps/api/src/jobs/scriptReviewWorker.ts`:

```ts
export function buildReviewerPrompt(args: { proposal: ScriptProposalRow; scan: ScriptScanResult; devices: DeviceFacts[]; ceiling: RiskTier }): { system: string; user: string }; // never includes session/run transcript
export function applyReviewFloors(verdict: ScriptReviewVerdict, scan: Pick<ScriptScanResult,'strictHits'|'touchClasses'>): ScriptReviewVerdict; // raises only, per spec §4.4
export function runScriptReview(job: ScriptReviewJobData): Promise<ScriptProposalReviewRow>; // reserveAiBudget(idempotencyKey `script-review:${proposalId}:${attempt}`) → model → floors → insert review → transitionProposal(proposed→reviewed | review_failed) → recordUsage({ budgetReservationId })
export const SCRIPT_REVIEW_TIMEOUT_MS = 60_000; export const SCRIPT_REVIEW_ORG_CONCURRENCY = 3; export const SCRIPT_REVIEW_MAX_OUTPUT_TOKENS = 2_000;
```

Model selection: `resolveReviewerModel(orgId)` returns the org/partner `reviewer_model` when W04's policy table exists, else the platform default (`config.ai.scriptReviewerModel`, env `BREEZE_AI_SCRIPT_REVIEWER_MODEL`, default a Sonnet-class id). The call goes through `getAnthropicClientForPartner` for BYOK and egress-audit parity, which needs a new `LLM_EGRESS_SURFACES` value and its CHECK-constraint migration (`2026-10-16-100400-…`). Per-org concurrency is a Redis-counted slot (`reviewConcurrency.ts`) with BullMQ `moveToDelayed` re-delay, since open-source BullMQ has no group concurrency.

### 3.5 Human loop and verification (W03)

Routes (`apps/api/src/routes/ai/scriptProposals.ts`, mounted under `/api/v1/ai/script-proposals`, registered before any `/:id` sibling):

- `GET /:id` → `ScriptProposalDetailDto` (proposal + latest review + executions + verification), live-authorised: requester, or `approvals:decide` with org access.
- `POST /:id/request-changes` `{ note: string }` → proposal `changes_requested`, denies the linked intent with `reason: 'changes_requested'`, and posts the findings + note into the author session (chat) or the run's pending tool result (agent).
- `POST /:id/promote` `{ name, description?, ownerScope: 'organization'|'partner' }` → requires `scripts:write` + MFA and `status === 'verified'`; creates the script via `insertScriptRow` + `cutScriptVersion` with provenance; proposal → `promoted`.

Decide endpoint (`decideApprovalRequest.ts`) accepts `acknowledgedPatterns?: string[]` when the intent's proposal has `strictHits`; enforces `scripts:write` + the JWT `mfa` claim (same bar as `POST /scripts`; #5601's grant has no acknowledgement operation) and stores `(submitted ∩ strictHits)` on **`script_proposals.acknowledged_patterns`** (migration `2026-10-16-101000-…`; intents and approval rows carry no decision payload) which dispatch reads; typed 422 `strict_acknowledgement_not_permitted`. Promote threads provenance through `insertScriptRow(opts.provenance)` rather than a second `cutScriptVersion`. There is no intent-detail page; the card renders in `AiApprovalDialog` and the inbox row (spec §4.10). Helper coverage is partial (legacy Tier-2 `approval_required` feed) and the PR must say so.

Verification: `apps/api/src/services/scriptProposals/verify.ts` + `apps/api/src/jobs/scriptVerifyWorker.ts`, queue `script-verify`, job `{ proposalId, executionId, attempt }`, `evaluateVerificationClaim(claim, execution, device): Promise<{ outcome: 'verified'|'verification_failed'|'unknown'; evidence: Record<string, unknown> }>`; three attempts over 20 min; writes `verified_at`/`verification_result`, transitions `executed → verified | verification_failed`, posts to the session/recipients. Exposes `onUnattendedVerificationOutcome` hook consumed by W04.

Web: `apps/web/src/components/ai/ScriptProposalApprovalCard.tsx` (rendered by `AiApprovalDialog`, the approvals inbox row, and intent detail when `input.proposalId`), `apps/web/src/components/scripts/ScriptProvenancePanel.tsx`, Origin column/filter in the scripts list. Mobile: `apps/mobile/src/screens/approvals/components/ScriptProposalDetails.tsx`. Helper: summary + findings + body collapse in the approval card.

### 3.6 Unattended lane (W04)

`apps/api/src/services/scriptProposals/policy.ts`:

```ts
export interface EffectiveScriptPolicy { proposingEnabled: boolean; unattendedEnabled: boolean; maxUnattendedRiskTier: RiskTier; unattendedAllowedClasses: TouchClass[]; maxUnattendedPerHour: number; protectedResources: ProtectedResources; reviewerModel: string | null; source: { partnerRowId: string | null; orgRowId: string | null } }
export function resolveEffectiveScriptPolicy(orgId: string): Promise<EffectiveScriptPolicy>; // partner ceiling ∧ org grant; missing org row ⇒ unattendedEnabled false
```

`apps/api/src/services/actionIntents/scriptReviewerAutonomy.ts`, mirroring `ticketAutonomy.ts`:

```ts
export type ScriptReviewerRefusal = 'lane_disabled'|'proposal_not_runnable'|'review_missing'|'risk_above_ceiling'|'verdict_not_approve'|'strict_hits'|'class_not_allowed'|'class_hard_denied'|'protected_resource'|'timeout_too_long'|'scope_not_supervised'|'multi_device'|'checkpoint_unavailable'|'lane_open'|'hourly_cap'|'requester_unauthorized'|'device_unavailable';
export interface ScriptReviewerEvidence { proposalId: string; reviewId: string; contentDigest: string; scannerVersion: string; reviewerModel: string; reviewerPromptVersion: string; touchClasses: TouchClass[]; policySnapshot: { ceiling: RiskTier; allowedClasses: TouchClass[]; perHour: number }; laneReservationAt: string; checkpointRequired: boolean; agent?: { agentId: string; policyEpoch: number; killEpoch: number } }
export function evaluateScriptReviewerAutonomy(args: { tx: DbTransaction; auth: AuthContext; intentDraft: …; proposal: ScriptProposalRow; review: ScriptProposalReviewRow }): Promise<{ granted: true; evidence: ScriptReviewerEvidence } | { granted: false; reason: ScriptReviewerRefusal }>; // takes pg_advisory_xact_lock(hashtextextended('ai-script-lane:'||orgId,0)) before the hourly count
export function revalidateScriptReviewerEvidence(intent: ActionIntent, db): Promise<{ ok: true } | { ok: false; reason: ScriptReviewerRefusal }>; // used by revalidateRelease
```

`intentService.createActionIntent`: after `evaluateTicketAutonomy`, when `input.tool === 'run_script' && input.arguments.proposalId`, call `evaluateScriptReviewerAutonomy`; on grant write `status: 'approved', decidedVia: 'script_reviewer', decidedByUserId: null, releaseBy`, `script_reviewer_evidence`, no approval rows, `intent_approved` outbox, and `consumeProposalForIntent`; on refusal record `{ scriptLaneRefusal }` in `action_intents.result` (no new column). `revalidateRelease.isSystemDecided` adds `'script_reviewer'`; the no-approval-row exception adds `|| (intent.decidedVia === 'script_reviewer' && (await revalidateScriptReviewerEvidence(intent, db)).ok)` while the `!!intent.requestingAgentRunId` clause stays scoped to `policy`/`ticket_autonomy`. Failures go through `failIntent(intent, 'lane_revoked', { details: { reason } })`. `aiAgentSdk.ts:1227` must branch on intent status so an approved-at-creation intent does not flash an `approval_required` card.

`apps/api/src/db/schema/aiScriptPolicies.ts`, `aiScriptLaneState.ts`; routes `GET/PUT /api/v1/ai/script-policy` (org grant) and `/api/v1/partner/ai/script-policy` (partner ceiling), settings UI under Settings → AI → Script authoring. Checkpoint prerequisite: `services/deviceRecovery/restoreCheckpoint.ts` `ensureRestoreCheckpoint(deviceId): Promise<{ ok: true; checkpointRef: string } | { ok: false; reason }>`. No checkpoint primitive exists today in the agent or the API (patch install runs preflight only), so W04 implements it server-side over a raw script dispatch of a fixed PowerShell body and polls the command result; non-Windows returns `unsupported_platform`, making `registry`/`services`/`files_system` lane-ineligible there (settings UI badges them Windows-only). File a follow-up issue for a first-class `create_restore_point` agent command.

### 3.7 Close the loop (W05)

Device activity is audit-log driven (`routes/devices/events.ts`), so `scriptDispatch` writes an `audit_logs` row whose details come from the just-inserted `script_executions` snapshot (no proposal join, no new feed query arm); `AiRiskDashboard` metrics endpoint gains `scriptProposals { perDay, unattendedRuns, laneState, reviewerDisagreements }`; docs pages under `apps/docs/src/content/docs/features/` (`ai-script-authoring.mdx`, updates to `ai.mdx`, `scripts.mdx`, `ai-agents.mdx`, `approval-security.mdx`); flag removal.

## 4. Definition of done per wave

- Unit suites for touched files green; `pnpm --filter @breeze/api test --run <files>` for each new/changed test file.
- Contract suites named in spec §5 green locally against `pnpm test-stack up` before PR (W01a/W01b/W04 touch tenancy).
- One review round (Codex `medium` + Sonnet for tenancy/auth waves), findings fixed, PR body records it.
- PR body includes `Closes #<wave sub-issue>`.
- Release-notes entry appended to `docs/release-notes/next-release-draft.md` in the wave that makes the behaviour user-visible (W03, W04).
