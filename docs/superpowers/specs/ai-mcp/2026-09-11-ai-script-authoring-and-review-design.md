---
title: AI script authoring, independent review, and reviewer-gated execution
status: v2.1 — approved by Todd 2026-09-11; Codex xhigh quorum folded in; reconciled against the six wave plans (§11)
date: 2026-09-11
owner: Todd Hebebrand
tracking_issue: LanternOps/breeze#5612
related:
  - docs/superpowers/specs/web-ui/2026-08-15-script-editor-test-loop-design.md
  - docs/superpowers/specs/ai-mcp/2026-08-05-tier3-supervised-four-eyes-split-design.md
  - docs/superpowers/specs/ai-mcp/2026-07-18-action-intents-approval-layer-design.md
  - docs/superpowers/specs/ai-mcp/2026-08-22-ai-agents-program-and-wave1-design.md
  - docs/superpowers/specs/ai-mcp/2026-09-06-ai-agent-builder-design.md
  - docs/superpowers/specs/ai-mcp/2026-09-07-ai-operator-completion-design.md
  - docs/superpowers/specs/ai-mcp/2026-09-07-tool-catalog-and-flows-design.md
---

# AI script authoring, independent review, and reviewer-gated execution

## 1. Summary

Today the troubleshooting assistant and the background AI agents cannot write a
script. `run_script` accepts only a saved library id and `execute_command` is a
closed set of ten command types, so when no library script fits, the AI stops
and the technician writes one by hand. This design lets the assistant and the
agents **author a script as a first-class, immutable proposal**, runs it through
**three review layers** (a deterministic static scan and touch classifier, an
independent model review with no author context, and the existing human
approval), shows the human a **readable approval card** instead of raw JSON,
records **provenance on the script, its version, and every execution**, and adds
a **reviewer-gated unattended lane** that is built in but **off by default**,
requires an explicit partner ceiling *and* an explicit org grant, and is bounded
by deterministic invariants the reviewer cannot widen.

The product goal is end-to-end autonomous troubleshooting. The safety goal is
that nothing the AI wrote ever runs unless (a) a human read a truthful summary
of it and approved, or (b) the partner and the org both opted in to the
unattended lane and the proposal cleared every invariant in §4.6, most of which
are enforced from the script's *classified content*, not from the reviewer's
opinion of it.

Decisions taken in dialogue on 2026-09-11 and confirmed after quorum:

| # | Decision | Rationale |
|---|---|---|
| D1 | The lane covers **both** chat sessions and headless agents (option A) | One decision type, one evaluator, one release validator; both transports already create action intents |
| D2 | Unattended execution of novel scripts is **built in v1, default off** | Todd wants the option available without arguing for it later; flows-vs-playbooks was a per-workflow choice, not a blanket one |
| D3 | Provenance lives on **`script_versions`**, which become immutable execution definitions | An edit after promotion must not inherit the review; same rule as the security-acknowledgement re-derivation (#5129) |
| D4 | No editing inside the approval; "Request changes" round-trips to the author | What was reviewed is exactly what runs (digest invariant) |
| D5 | Promotion to the library is an explicit human action after a **verified** run, not automatic | Keeps the library from filling with one-off scripts; promotion is the trust step that makes a script act-mode eligible |
| D6 | Unattended runs are single-device only in v1 | Canary by construction; fleet widening is #4173's job |
| D7 | Reviewer failure fails closed | A proposal with no completed model review is not runnable through any path |
| D8 | The unattended decision is a **new `decided_via = 'script_reviewer'` autonomy type evaluated inside `createActionIntent`**, released through the existing worker with its own revalidation branch | Reuses the durable intent lifecycle instead of copying the chat Tier-2 direct-execution shortcut (quorum) |
| D9 | Unattended eligibility is bounded by a **deterministic touch classifier plus a policy class allowlist and protected resources**; the reviewer supplies evidence, never authority | A model label is not an enforcement boundary (quorum, critical) |
| D10 | Partner row is a **ceiling**, org row is an **explicit grant**; a missing org row means off | Blanket partner enablement would silently enable every org (quorum) |
| D11 | A proposal-backed execution is a **first-class execution source**; no hidden library script is created to satisfy the FK | Contradicting D5 with a phantom script would be worse than the schema change (quorum) |
| D12 | Verification ships **before** promotion and before the unattended lane | D5 and the circuit breaker both depend on it (quorum) |

## 2. Problem, goals, non-goals

### 2.1 Problem

- The assistant and agents have no script-authoring tool. The only AI that writes code is the Script Builder inside the editor (`apply_script_code`, Tier 1, `scriptBuilderTools.ts:41`), and it writes into an editor buffer, not into anything runnable from chat.
- Approval cards on web, mobile, and helper render the tool input as raw JSON (`AiApprovalDialog.tsx:489-497`, mobile `DetailsCollapse.tsx:11`, helper `AppShell.tsx:547-551`). For `run_script` that JSON is a script id and a device list. The approver never sees the code.
- Nothing in the system is an independent AI reviewer. The only "second" is a second human (`four_eyes`).
- Audit does not keep the executed body. `device_commands.payload` is sanitised to `{length, sizeBytes, sha256}` (`commandAudit.ts:42-53`) and `script_executions` stores output only, so "show me exactly what ran" is unrecoverable once the script is edited.
- The library has no provenance: `created_by` is a user FK, `is_system` means built-in, and there is no reviewed-by or approved-by anywhere. `script_versions` exists but only the bundle importer writes it.

### 2.2 Goals

1. The assistant and agents can propose a script mid-troubleshoot and, after review and approval, run it on the devices they are working on.
2. Every proposal is immutable and content-addressed; the thing reviewed is the thing that runs.
3. Three review layers, in order: deterministic scan and classification, independent model review, human approval. The human sees a plain-language summary, a risk tier, findings, and the code.
4. Provenance (origin, reviewer, approver, method) is visible on the library script, on each version, and on each execution, and survives org moves and erasure of the source evidence.
5. A reviewer-gated unattended lane exists, is off by default, requires partner ceiling plus org grant, and is bounded by invariants the toggle cannot override.
6. Reuse, not rebuild: action intents and effect digests, the intent-side autonomy seam, supervised/four-eyes scopes, assurance-level step-up, the shared static scanner and per-script acknowledgements, budget reservations, the operator verification rule, circuit-breaker and fix-watch patterns.

### 2.3 Non-goals (v1)

- Editing a proposal inside the approval card (D4).
- Multi-device unattended runs or automatic widening (D6; see #4173).
- Cryptographic signing of script content or agent-side signature verification. The agent's trust boundary stays the authenticated command channel; the content digest is pinned server-side.
- AI-authored playbooks or flows. Playbooks stay static; flows are #5215. A promoted script can later be referenced by either. **The flows pre-approval contract (literal asset id plus digest, policy-decidable only) is not reinterpreted**; `run_script` stays excluded from `policyDecidableKeys.ts` (`:183-186`), and the proposal lane is a distinct decision type.
- Changing the agent binary. Proposals dispatch through the existing script payload shape (`handlers_script.go:119-152`), so the Go agent is unchanged.
- Tier 3 autonomy for any tool other than `run_script` with a proposal.

## 3. As-built facts this design relies on (verified 2026-09-11)

| Fact | Where | Consequence |
|---|---|---|
| `run_script` takes `scriptId` + `deviceIds[]` (+ parameters, runAs, targetSessionId); no inline content; ≤10 devices; waits 60 s per device | SDK schema `aiAgentSdkTools.ts:1421`; handler `aiToolsScripts.ts:376`, `:547` | Add `proposalId` as an XOR alternative; keep the cap and the wait |
| `execute_command` is a closed enum of 10 command types, no shell | `aiAgentSdkTools.ts:1405`, `aiToolsScripts.ts:233` | Not a path for arbitrary code; unchanged |
| Tier resolution and `approvalScope`; `run_script` is in `TIER3_SUPERVISED_TOOLS` | `aiGuardrails.ts:555`, `:1431`, `:466` | New input-aware branch for `run_script` with `proposalId`; classification is synchronous, so the persisted review risk is read at guardrail time |
| Chat `auto_approve` executes Tier 2 only | `aiAgentSdk.ts:899-919` | Not extended; the lane is intent-side (D8) |
| `createActionIntent` evaluates an autonomy decision **inside its transaction**: `evaluateTicketAutonomy` at `:1572`; policy stub at `:1554`; approved-at-creation intents write `decidedVia`, `decidedByUserId: null`, a release lease, no `approval_requests` rows, and an `intent_approved` outbox row | `intentService.ts:1564-1572`, `:1657-1664`, `:1819-1824`, `:1871-1877`; `requestedByUserId: agentRun ? null : requesterId` at `:1597` | The `script_reviewer` decision is a third autonomy type at this seam |
| Release revalidation recognises only `policy` and `ticket_autonomy` as system-decided, and the no-approval-row exception requires an agent run | `revalidateRelease.ts:130-132`, `:177-180` | Add a `script_reviewer` branch with typed evidence and live checks for both chat and agent origins |
| `decided_via` values written today: `ticket_autonomy`, `policy` | `intentService.ts:1660`, `policyDecide.ts:357`, `:643` | `script_reviewer` is new |
| Unattended policy decisions take a per-org advisory xact lock (`ai-exposure:<orgId>`), check caps, reserve exposure, then CAS to approved | `policyDecide.ts:252-298` | Same pattern for the lane's hourly reservation |
| Unresolved effect digests become null and skip enforcement | `intentService.ts:1537` | The proposal resolver must return a digest or intent creation fails |
| Agent act-mode direct execution is gated on `actAssets.scriptIds` in `actRevalidation.ts` (step 3.5) and the suggestion resolver requires a suggestion with a `scriptId` | `actRevalidation.ts:466-470`; `remediationActResolver.ts:141`, `:173`; `actManifest.ts:188` | Proposals do **not** use the direct-act lane; agents reach the proposal lane through `createActionIntent` in `runLoop.ts:563-586` like every other Tier-3 op |
| Agent guardrails never consult user RBAC; protected-resource checks inspect named input fields (`serviceName`, path keys, registry keys), never script content | `aiGuardrails.ts:1735-1737`, `:1649-1661`, `:1524-1532`, `:1827` | The lane needs its own content-derived touch classifier (D9) |
| `script_executions.script_id` is NOT NULL FK; dispatch creates execution rows only for `source.kind === 'saved'`; the stale reaper inner-joins `scripts` for `timeoutSeconds` | `schema/scripts.ts:167`; `scriptDispatch.ts:486`; `staleCommandReaper.ts:584` | Proposal-backed executions need a first-class source (D11) |
| `script_versions` (id, scriptId, version, content, changelog, createdBy, createdAt): no `org_id`, non-unique `(script_id, version)` index, FK to `scripts` with **no** `ON DELETE`, RLS policies permit UPDATE and DELETE; **only the bundle importer inserts rows, as a before-image**; PUT bumps `scripts.version` on content **or parameter** change only; language/timeout/runAs changes do not bump | `schema/scripts.ts:104-115`, `0001-baseline.sql:10156`, `:14337`; `2026-10-01-100000-script-children-rls.sql:91-104`; `scriptBundle/index.ts:777-787`; `routes/scripts.ts:885`, `:898`, `:913-915` | Versions are rebuilt as immutable execution definitions with every writer cutting one (D3, §4.2) |
| Script writers: `scriptWrite.insertScriptRow` (`:201-233`), `routes/scripts.ts` PUT (`:864-914`) and org-clone of a system script (`:564-587`), `scriptClone.ts:116-133`, `scriptBundle/index.ts:780`, `systemScriptLibrary.ts:353-376` | | Every one of these cuts a version in W01 |
| `script_executions` is device-denormalised and restamped on device move | `schema/scripts.ts:168`, `routes/devices/core.ts:294`, `moveOrg.ts:660` | Execution → version/proposal links are plain uuid columns, never same-org composite FKs |
| Cascade order is derived from **all** FK edges and rejects cycles; generic erasure assumes `org_id` | `tenantCascade.ts:1004-1046`, `:1319-1330` | No proposal↔review FK cycle; `script_versions` erases through a cascading parent FK |
| `action_intents`, `ai_agent_runs`, operator tasks/operations are **left for source-org erasure** on merge, not repointed | `orgMergeRegistry.ts:203`, `:214`, `:233-235` | Proposals and reviews follow the same rule |
| Dual-owner tables must join `DUAL_AXIS_TENANT_TABLES` and `XOR_OWNERSHIP_DUAL_AXIS_TABLES` | `rls-coverage.integration.test.ts:316`, `:588`, `:1555`, `:1617` | Policy table registration |
| Export policy: `token` is a suspicious name part; an `include` decision on such a column needs `reviewedSensitiveName: true` | `tenantExportPolicy.ts:41`, `:213-222` | Review token counters |
| A shared TS mirror of the agent's STRICT patterns exists with a parity test that parses the Go source; BASIC is guarded but not mirrored; the three XOR-obfuscated tokens are decoded at load with key `0x5a` | `packages/shared/src/utils/scriptSecurityPatterns.ts:1-11`, `:37-40`, `:57-61`, `:132-144`; `.test.ts:22`, `:95-106` | Extend this module; do not write a second scanner |
| Acknowledging STRICT patterns requires `scripts:write` + MFA and resolves as `(submitted ?? existing) ∩ matched`; supervised self-approve re-checks the **tool** permission, not `approvals:decide`; plain click only for supervised self-decide under a non-enforcing partner | `scriptSecurityAcknowledgement.ts:32-34`, `:98-105`; `routes/scripts.ts:629-631`; `decideApprovalRequest.ts:513-566`, `:739-740` | STRICT acknowledgements on a card need the library's permission and MFA (§4.5) |
| Agents reserve budget before model work (`reserveAiBudget`) and `recordUsage` settles a reservation (`settleAiBudgetReservationDurably`) | `runLoop.ts:1558-1565`; `aiCostTracker.ts:694-718` | Reviewer spend uses the same reservation |
| Circuit state is keyed `(org_id, agent_id)`; chat has no agent key | `schema/aiAgentCircuitState.ts:31-44`; `agentCircuit.ts:3-6` | The lane gets its own per-org state (§4.6) |
| Operator rule: a dispatch result is never evidence of recovery; operation identity is permanent and reserved in the intent transaction | `aiOperator/verification.ts:5-11`; `operationService.ts:3-16`; `runLoop.ts:563-586`, `intentService.ts:1797` | Verification claims are evaluated independently (§4.9); task context is passed through unchanged |
| Effect digest pins the materialised script row at approval and re-checks at release, then dispatches the same verified observation | `effectDigest.ts:164`, `intentReleaseWorker.ts:1025`, `:1133` | Proposal resolver returns the pinned snapshot; dispatch uses it |
| Agent-reachable tools are filtered by `TOOL_TIERS` in `agentToolCatalog.ts:317-325`; 86 registered tools are missing from the map | `aiAgentSdkTools.registryParity.contract.test.ts:43` | New tools must be registered in the tier map and the catalog in the same PR |
| Newest migration on `origin/main` (local ref) | `2026-10-15-170200-organization-key-dates.sql` | New files must sort after it; re-verify against the remote at push |

## 4. Design

### 4.1 Entities

#### `script_proposals` (new, org-scoped, shape 1)

Incident-bound, not configuration, so `org_id NOT NULL` is justified: a proposal targets specific devices in one org and dies with the incident. `org_id` is trigger-immutable (like `action_intents`), and the table is `leave-for-erasure` in `orgMergeRegistry` (§5).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `org_id` | uuid NOT NULL → organizations | RLS axis; `UNIQUE (id, org_id)` |
| `author_kind` | text | `chat_session` or `agent_run` |
| `session_id` | uuid null → ai_sessions ON DELETE SET NULL | chat author; registry-resident tool handlers do not receive the chat session id, so the SDK's post-tool hook for `propose_script` sets it from the tool output |
| `agent_run_id` | uuid null (typed reference, no FK) | agent author; runs are left for erasure, never repointed |
| `language` | existing `script_language` enum | |
| `content` | text NOT NULL | **immutable**; ≤ 64 KiB |
| `content_digest` | char(64) NOT NULL | sha256 of the canonical content |
| `timeout_seconds` | int NOT NULL | ≤ 3600; unattended ≤ 300 |
| `run_as` | text NOT NULL default `system` | `system` or `user` |
| `goal`, `expected_effect` | text NOT NULL | author's words |
| `verification` | jsonb NOT NULL | checkable claim, §4.9 |
| `rollback_note` | text null | |
| `target_device_ids` | uuid[] NOT NULL | 1..10 |
| `scanner_version` | text NOT NULL | version tag of the shared scanner used |
| `basic_hits`, `strict_hits` | text[] NOT NULL default `{}` | pattern descriptions matched |
| `acknowledged_patterns` | text[] NOT NULL default `{}` | the STRICT set the approver acknowledged, re-derived as `(submitted ∩ strict_hits)`; added by W03's migration |
| `touch_classes` | text[] NOT NULL default `{}` | deterministic classifier output (§4.4) |
| `status` | `script_proposal_status` enum | below |
| `revision`, `supersedes_id` | int, uuid null (no FK) | revision chain; a self-FK would add a cycle to the cascade topo-sort |
| `risk_tier` | text null | denormalised from the completed model review (§4.4); no FK to reviews |
| `decided_by`, `decided_at`, `decision_note` | | human decision, if any |
| `intent_id` | uuid null (no FK) | the one live run request; set by CAS (`WHERE intent_id IS NULL`) so a proposal is consumed by exactly one intent |
| `verified_at`, `verification_result` | timestamp, jsonb | §4.9 |
| `promoted_script_id`, `promoted_version_id` | uuid null (no FK) | §4.8 |
| `created_at`, `expires_at` | | expires 24 h after creation |

Status: `proposed` → (`scan_rejected` | `review_failed` | `reviewed`) → (`approved` | `rejected` | `changes_requested` | `expired`) → `executed` → (`verified` | `verification_failed`) → `promoted`; plus `superseded` when a revision replaces it. A merge fences every non-terminal proposal in the losing org to `expired` before erasure.

The latest review is derived (`ORDER BY created_at DESC LIMIT 1` on a `(proposal_id, created_at)` index), not stored as an FK, so there is no proposal↔review cycle for the cascade order.

#### `script_proposal_reviews` (new, org-scoped, shape 1, append-only)

| Column | Notes |
|---|---|
| `id`, `org_id` | |
| `proposal_id` | composite `(proposal_id, org_id) → script_proposals(id, org_id)` **DEFERRABLE INITIALLY IMMEDIATE** |
| `reviewer_kind` | `static_scan` or `model` |
| `model`, `reviewer_prompt_version` | model id and prompt version, null for static |
| `status` | `completed`, `failed`, `timeout` |
| `summary` | text, denormalised from the verdict |
| `risk_tier` | `low`/`medium`/`high`/`critical` |
| `goal_match` | `yes`/`partial`/`no` |
| `reversible`, `verification_adequate` | bool |
| `recommended_action` | `approve`/`changes`/`reject` |
| `verdict` | jsonb, full structured output (findings, advisory blast radius) |
| `input_tokens`, `output_tokens`, `cost_cents` | export: `include` with `reviewedSensitiveName: true` |
| `budget_reservation_id` | text null | idempotent settlement |
| `created_at` | |

`REVOKE DELETE` + immutability trigger, registered in `AUDIT_ADMIN_REQUIRED_TABLES`.

#### `script_versions` (existing, rebuilt as immutable execution definitions)

| Change | Detail |
|---|---|
| Columns added | `language`, `timeout_seconds`, `run_as`, `parameters` (jsonb, the parameter definitions), `origin` (`script_origin` enum: `human`, `ai_proposal`, `imported`, `system`; default `human`), `proposal_id`, `review_id`, `reviewed_at`, `approved_by` → users, `approved_at`, `approval_method`, `content_digest` |
| Uniqueness | `UNIQUE (script_id, version)` replaces the non-unique index; a repair step reports and renumbers duplicates first |
| Immutability | immutability trigger on every column; RLS policies replaced by INSERT + SELECT only (the 2026-10-01 UPDATE/DELETE policies are dropped); rows die only through the parent |
| Parent FK | `script_id → scripts(id) ON DELETE CASCADE` (re-added), so org erasure of `scripts` removes versions without an `org_id` on the child |
| Head | the row where `version = scripts.version`; there is **no** `head_version_id` column on `scripts` (it would create a `scripts ↔ script_versions` FK cycle) |
| Writers | every material change cuts a version under `SELECT … FOR UPDATE` on the script row: create (`insertScriptRow`), PUT (content, parameters, **and now** language, timeout, runAs), org-clone of a system script, `scriptClone`, the bundle importer (switched from a before-image to an after-image of the imported content), and the system-library sync. A shared `cutScriptVersion(tx, script, provenance)` helper is the only writer |
| Backfill | one migration inserts a version row for every script whose current `(version)` has no row, under `breeze.scope = system`, with the row count reported |

`scripts` gains `origin` (record's birth) and `origin_proposal_id` (uuid, no FK). A human edit cuts a new head with `origin = human` and empty review fields, so the badge honestly drops to "edited since review". `is_system` is kept; the migration sets `origin = system` for it.

#### `script_executions` (existing, gains a proposal source)

| Change | Detail |
|---|---|
| `script_id` | becomes **nullable** |
| `source_kind` | text NOT NULL default `library`; `library` or `proposal`; CHECK `(source_kind = 'library') = (script_id IS NOT NULL)` and `(source_kind = 'proposal') = (proposal_id IS NOT NULL)` |
| `proposal_id` | uuid null (no FK) |
| Snapshot columns | `language`, `timeout_seconds`, `run_as`, `content_digest` — written at dispatch for **both** sources so readers stop joining `scripts` |
| Provenance | `script_version_id` (uuid null, no FK), `review_id` (uuid null), `approved_by` (uuid null), `approval_method`, `review_risk_tier`, `review_summary` (≤ 600 chars) — the last two are snapshots so device activity renders after the proposal is erased |

`approval_method` values: `supervised_self`, `four_eyes`, `unattended_reviewer_gated`, `direct_ui`, `automation`.

Readers updated in W01 to use the snapshot instead of the join: `staleCommandReaper.ts:584`, result ingestion, execution history routes and `get_script_execution` / `get_script_execution_history` tools, cancellation (#3525 when it lands), device activity, verification (§4.9). `scriptDispatch` gains `source.kind === 'proposal'`.

#### `ai_script_policies` (new, dual-owner, org XOR partner)

One row per owner. **The partner row is a ceiling; the org row is a grant.** A missing org row means the lane is off for that org regardless of the partner row. Writing the partner row requires `canManagePartnerWidePolicies`; writing `unattended_enabled = true` on an org row requires `approvals:decide` and a fresh MFA claim (the #5601 step-up grant), mirroring act-mode enablement.

| Column | Partner (ceiling) | Org (grant) |
|---|---|---|
| `proposing_enabled` | default true | default true; effective = AND |
| `unattended_allowed` | default **false**: may any org under this partner use the lane | — |
| `unattended_enabled` | — | default **false**; effective = partner `unattended_allowed` AND org `unattended_enabled` |
| `max_unattended_risk_tier` | default `low`, CHECK in (`low`, `medium`) | ≤ partner; effective = min |
| `unattended_allowed_classes` | text[] default `{services, processes, temp_files, dns_cache, printing}` | ⊆ partner; effective = ∩ |
| `max_unattended_per_hour` | default 10 | ≤ partner; effective = min |
| `protected_resources` | jsonb, same shape as `ai_agents.protected_resources` | union with partner |
| `reviewer_model` | null = platform default | org may override only within the partner's BYOK provider |
| `unattended_enabled_by`, `unattended_enabled_at` | | audit of the grant |

Agents additionally intersect with their own `limits`, `protected_resources`, and allowlist through `effectivePolicy.ts`; the lane never widens an agent's existing envelope.

#### `ai_script_lane_state` (new, org-scoped, shape 1, PK `org_id`)

`consecutive_failed_verifications` int, `state` (`closed`/`open`), `opened_at`, `opened_reason`, `reset_by_user_id`, `reset_at`. Opens after 2 consecutive failed or unknown verifications of unattended runs in the org; checked at approval **and** at release; reset requires `approvals:decide` + MFA. Chat has no agent key, which is why this is per org rather than a reuse of `ai_agent_circuit_state`; agents remain subject to their own `(org, agent)` circuit as well.

### 4.2 Tools

| Tool | Tier | Registries | Input | Output |
|---|---|---|---|---|
| `propose_script` | 1 | chat, agents | `language`, `content`, `goal`, `expectedEffect`, `verification`, `rollbackNote?`, `deviceIds[1..10]`, `runAs?`, `timeoutSeconds?`, `supersedesProposalId?` | `proposalId`, `status`, `staticScan {basicHits, strictHits, touchClasses}`, `review` (verdict summary if it completed within the 45 s inline wait, else `pending`) |
| `get_script_proposal` | 1 | chat, agents | `proposalId` | status, verdict summary, risk tier, findings, decision, execution ids, verification |
| `run_script` | 3 (input-aware) | existing | gains `proposalId` XOR `scriptId` | unchanged |

Proposing is Tier 1 because a proposal is inert: nothing runs without an intent. Both new tools are added to `TOOL_TIERS`, to the agent catalog under a new capability group "Author scripts" (`agentToolCatalog.ts`), and the registry-parity contract test covers them.

`run_script` with `proposalId` validates: proposal org = session org; status = `reviewed`; not expired or superseded; `intent_id IS NULL`; `deviceIds` ⊆ `target_device_ids`; `runAs` and `timeoutSeconds` equal the proposal's; `parameters` absent. Validation failures return a tool error, never a silent fallback to `scriptId`.

### 4.3 Static scan and touch classifier

Both live in `packages/shared/src/utils/scriptSecurityPatterns.ts`, which already mirrors the agent's STRICT list with a Go-source parity test and decodes the three XOR-obfuscated tokens at load. W01 extends it:

- **BASIC mirror**: the BASIC list is added as data with the same Go-source parity test the STRICT list has. The existing fail-safe argument (`:37-40`) holds for proposals: a BASIC pattern the mirror misses is still blocked by the agent at execution, which surfaces as a failed run; a pattern only the mirror matches rejects a harmless proposal early. Neither direction loosens the agent.
- **Touch classifier**: a third list of `(regex, class)` pairs mapping content to a closed set of resource classes: `registry`, `services`, `processes`, `files_system`, `files_user`, `temp_files`, `network_egress`, `firewall`, `credentials`, `users_groups`, `packages`, `scheduled_tasks`, `disk`, `boot`, `security_tooling`, `dns_cache`, `printing`, `browser`, `shell_eval` (dynamic evaluation, encoded commands, download cradles). Output is the set of classes matched. Classes are additive and conservative: an unknown construct matches nothing, which the lane treats as **not** allowed (invariant 6 below requires the proposal's classes to be non-empty and within the allowlist, so a script the classifier cannot place goes to a human).
- **Behavioural parity cases** for both lists: whitespace variants, case, CRLF line endings, anchors, and encoded PowerShell. Equal pattern strings are not treated as semantic equivalence.
- `scanner_version` is a constant exported by the module and stamped on each proposal and in the intent evidence.

### 4.4 Review pipeline

```
propose_script
  ├─ canonicalise + sha256 ──► content_digest
  ├─ static scan + classifier (scanner_version stamped)
  │     BASIC hit ──► status scan_rejected, findings returned, STOP (no model review, no card)
  │     STRICT hit ──► recorded; continues
  ├─ reserveAiBudget({ orgId, idempotencyKey: `script-review:${proposalId}:${attempt}`, billingSource })
  │     denied ──► status review_failed (budget), author told
  ├─ enqueue script-review job (per-org concurrency 3, output cap 2k tokens); wait ≤ 45 s inline
  │
script-review worker (BullMQ)
  ├─ prompt = proposal fields + touch classes + device facts (OS family/version, hostname, tags)
  │            NEVER the author transcript; content wrapped as data; reviewer has no tools
  ├─ model = effective reviewer_model ?? platform default (Sonnet-class), via the partner's
  │          configured provider (BYOK design 2026-08-23) when one exists
  ├─ structured output (Zod-validated):
  │     summary ≤ 600 chars · goalMatch yes|partial|no · riskTier · blastRadius[] (advisory)
  │     reversible · verificationAdequate · findings[{severity,text,lineRef?}] · recommendedAction
  ├─ deterministic floors applied AFTER the model, from the CLASSIFIER, not the model's labels
  │   (it may raise, never lower):
  │     any STRICT hit ⇒ risk ≥ medium
  │     touch_classes ∩ {credentials, security_tooling, boot, disk, shell_eval} ≠ ∅ ⇒ risk ≥ high
  │     touch_classes ∩ {users_groups, firewall, scheduled_tasks, registry} ≠ ∅ ⇒ risk ≥ medium
  │     goalMatch = no ⇒ recommendedAction = reject
  │     verificationAdequate = false ⇒ recommendedAction ≠ approve
  ├─ persist review row; settle the reservation via recordUsage(budgetReservationId)
  ├─ set proposal.risk_tier, status reviewed
  └─ parse failure / 60 s timeout / provider error ⇒ review row failed, proposal review_failed (D7);
                                                     reservation settled at zero; author may re-propose
```

The reviewer's `blastRadius` is shown to the human and stored, but no enforcement reads it (D9).

### 4.5 Execution and approval scope (human path)

`run_script` with `proposalId` is Tier 3. `checkGuardrails` gains an input-aware branch that reads the proposal's persisted `risk_tier`:

| Review risk tier | `approvalScope` |
|---|---|
| low, medium | `supervised` (requester may approve their own, plain click under a non-enforcing partner, live tool-permission re-check) |
| high, critical | `four_eyes` (second human, 60-min window, assurance floor per partner policy) |

**STRICT acknowledgements.** Acknowledging on a card carries the library's requirement: the deciding approver must hold `scripts:write` and carry the JWT `mfa` claim, the same bar `POST /scripts` enforces (`routes/scripts.ts:626-631`). The #5601 step-up grant has no operation for acknowledgements; a resource-bound single-use grant is a possible follow-up, not v1. Supervised self-approve today re-checks only the tool permission (`decideApprovalRequest.ts:538-557`), so the decide endpoint gains an additional check when the intent's proposal has `strict_hits`: missing permission or MFA returns a typed 422 `strict_acknowledgement_not_permitted`, the card disables Approve and names the requirement, and four-eyes fan-out for such proposals is filtered to approvers who hold `scripts:write`. The acknowledged set is submitted with the decision, re-derived server-side as `(submitted ∩ strict_hits)` (there is no "existing" set on a proposal), stored on `script_proposals.acknowledged_patterns` (intents and approval rows carry no decision payload: `action_intents.arguments` is immutable and the release worker projects only `(id, status, bound_argument_digest)` off the winning approval), and rides the dispatch payload exactly as a library script's acknowledgements do, because dispatch already holds the proposal row.

**Effect digest** for `proposalId`: the resolver returns a non-null pinned snapshot `{proposalId, content_digest, language, run_as, timeout_seconds, sorted deviceIds, scanner_version}`; intent creation fails if it cannot, with intent error code `effect_digest_unresolvable`. This is the digest module's first throwing path: today unresolved digests become `NULL` and both release paths treat that as nothing to check (`intentService.ts:1537`). Release re-reads the proposal and fails closed with `content_changed` if the digest differs, and separately with `proposal_not_runnable` if status, expiry, supersession, or `intent_id` no longer match. Lifecycle state is never digest material. The worker dispatches the same verified snapshot.

On execution the dispatcher builds the same payload the library path builds (`content`, `language`, `runAs`, `timeoutSeconds`, `acknowledgedSecurityPatterns`), so the Go agent is unchanged. The chat inline release path treats an intent that is already `approved` at creation exactly like a just-approved one: it runs `revalidateApprovedIntentForRelease` before executing.

### 4.6 The unattended lane (D8, D9, D10)

**Seam.** `createActionIntent` gains `evaluateScriptReviewerAutonomy(...)` beside `evaluateTicketAutonomy` (`intentService.ts:1572`), invoked only when the op is `run_script` with a `proposalId`. `createActionIntent` also calls `checkGuardrails` itself (`intentService.ts:1042`) and rejects tier ≥ 4, so `CreateActionIntentInput` carries the proposal `GuardrailContext` from every caller. It runs inside the intent transaction under `pg_advisory_xact_lock(hashtextextended('ai-script-lane:' || org_id, 0))`. Both transports reach it the way they reach every Tier-3 op: chat through the SDK's intent creation, agents through `runLoop.ts:563-586` with task context passed through unchanged (operation reservation included). Agent act-mode direct execution (`actRevalidation.ts`) is **not** used for proposals.

**Invariants**, evaluated in order; the first failure is recorded as the refusal reason on the intent and the request falls through to the human path:

| # | Invariant | Source of truth | Overridable? |
|---|---|---|---|
| 1 | effective `unattended_enabled` (partner `unattended_allowed` AND org `unattended_enabled`) | policy | this IS the policy |
| 2 | proposal status `reviewed`, not expired/superseded, `intent_id IS NULL`, `basic_hits = {}` | proposal | no |
| 3 | latest review `completed`, `reviewer_kind = model`, `risk_tier` ≤ effective ceiling | review + policy | ceiling low/medium; high/critical never |
| 4 | `goal_match = yes`, `reversible = true`, `verification_adequate = true`, `recommended_action = approve` | review | no |
| 5 | `strict_hits = {}` | scanner | no |
| 6 | `touch_classes` non-empty and ⊆ effective `unattended_allowed_classes`; `touch_classes` ∩ hard-denied `{credentials, security_tooling, boot, disk, shell_eval, users_groups, firewall}` = ∅ | classifier + policy | allowlist within the partner ceiling; hard-denied never |
| 7 | no protected-resource hit: effective `protected_resources` (policy; plus the agent's own) checked against the classifier's extracted names (service names, paths, registry keys) | classifier + policy | no |
| 8 | `timeout_seconds ≤ 300` | proposal | no |
| 9 | resolved `approvalScope` would be `supervised` | guardrail | no |
| 10 | exactly one target device (D6) | proposal | no |
| 11 | recovery prerequisite: on Windows, when `touch_classes` ∩ `{registry, services, files_system}` ≠ ∅, a System Restore checkpoint is taken before dispatch and its success is a release precondition; on Linux/macOS such classes are not lane-eligible in v1 (`checkpoint_unavailable`). No checkpoint primitive exists today anywhere (patch install runs preflight only, `patchJobExecutor.ts:1191-1198`), so W04 implements `ensureRestoreCheckpoint` server-side over a raw script dispatch of a fixed PowerShell body, Windows only; a first-class agent command is a follow-up issue | dispatch | no |
| 12 | `ai_script_lane_state` closed; per-hour reservation under the advisory lock counts `script_reviewer` intents created in the last hour, **including pending and undispatched ones**, against effective `max_unattended_per_hour` | lane state | cap settable within the ceiling |
| 13 | requester authority: chat → the session user holds live `run_script` permission on the device (same `checkToolPermission` as supervised); agent → mode `act`, allowlist includes `run_script`, kill switch clear, agent structural guardrails pass, agent per-run action cap not exceeded | RBAC / agent policy | no |
| 14 | device online and not in a maintenance window | device | no |

**Decision record.** When all hold, the intent is inserted already `approved` with `decided_via = 'script_reviewer'`, `decided_by_user_id = null`, a release lease, no `approval_requests` rows, an `intent_approved` outbox row, and the proposal's `intent_id` set by CAS; `script_proposals.decided_by` stays `NULL`. When refused, the reason is recorded in `action_intents.result` as `{ scriptLaneRefusal }` (the ticket-autonomy twin's breadcrumb, `intentService.ts:1585`), not a new column. A new immutable `script_reviewer_evidence` jsonb on `action_intents` (written at insert, covered by the existing immutability trigger) holds: `proposalId`, `reviewId`, `contentDigest`, `scannerVersion`, `reviewerModel`, `reviewerPromptVersion`, `touchClasses`, `policySnapshot {ceiling, allowedClasses, perHour}`, `laneReservationAt`, `checkpointRequired`, and for agents `agentId`, `policyEpoch`, `killEpoch`.

**Release.** `revalidateRelease.isSystemDecided` recognises `script_reviewer`, and the no-approval-row exception is extended: `!winningApproval && decidedVia === 'script_reviewer' && evidenceValid`, for **both** chat-origin (has `requestedByUserId`) and agent-origin intents. The existing `!!intent.requestingAgentRunId` clause (`revalidateRelease.ts:170-180`) stays scoped to the `policy` and `ticket_autonomy` branches; regression tests prove the widening does not leak to them. `evidenceValid` re-runs invariants 1–3, 5–8, 12, 13, and 14 against **current** state (policy may have been tightened, the org grant revoked, the agent moved `act → shadow`, the kill switch flipped, the lane opened) and checks that the review id in the evidence is the proposal's latest completed review. Any failure fails the intent through `failIntent` with `errorCode: 'lane_revoked'` and the specific reason in `details`. For invariant 11 the checkpoint result is read back before dispatch.

**After execution.** The verification job (§4.9) runs; a failed or unknown result increments `ai_script_lane_state.consecutive_failed_verifications` (and, for agents, feeds the existing circuit classifier) and notifies the agent's recipients or the session owner. Audit action `ai.script.unattended_run` at approval and `ai.script.unattended_verified` / `ai.script.unattended_failed` after.

**What the lane does not claim.** The reviewer supplies evidence for invariants 3 and 4 only. Authority comes from the partner ceiling, the org grant, and invariants 5–14, every one of which is deterministic. A free-form script whose effects the classifier cannot bound always gets a human.

### 4.7 Revision loop ("Request changes")

The approver can return a proposal with a note. The proposal moves to `changes_requested`; the pending `run_script` tool call resolves with a tool error carrying the reviewer findings and the note. The author calls `propose_script` again with `supersedesProposalId`; the old row becomes `superseded`, the new row gets `revision + 1`, a fresh scan, and a fresh review. A superseded proposal can never be consumed by an intent (invariant 2 and the `run_script` validation). There is no edit-in-place anywhere (D4).

### 4.8 Promotion to the library

"Save to library" appears on the proposal detail and the execution card **only when `status = verified`** (D5, D12) and requires `scripts:write` + MFA (the library's own create requirement). It creates:

- a `scripts` row with `origin = ai_proposal`, `origin_proposal_id`, name and description prefilled from `goal`, an owner-scope selector (org or partner, like other config), `acknowledged_security_patterns` = the set the approver acknowledged, `security_acknowledged_by` = the approver;
- `script_versions` v1 through `cutScriptVersion` with `origin = ai_proposal`, `proposal_id`, `review_id`, `reviewed_at`, `approved_by`, `approved_at`, `approval_method`, `content_digest`.

The proposal moves to `promoted`. The script is now an ordinary library script and may be listed in an agent's `actAssets.scriptIds` through the existing builder flow, which is how a one-off remediation becomes a repeatable unattended one under the gates that already exist. Promotion to a **partner-wide** script copies the review summary and risk tier into the version row; the source proposal stays in the org and may later be erased, and the provenance panel then shows "review evidence erased" rather than a broken link.

### 4.9 Verification, audit, observability

**Verification claim** (`proposal.verification`), validated by a shared Zod union, v1 kinds: `exit_code` (default, `{ equals: 0 }`), `service_running {name}`, `process_absent {name}`, `file_exists {path}`, `output_matches {regex}`. After the execution reaches a terminal state, a `script-verify` job evaluates the claim under the operator rule: a dispatch result is never evidence of recovery (`aiOperator/verification.ts:5-11`), so `service_running` is an independent `list_services` read, `process_absent` an independent process list, and `file_exists` an independent file stat; `exit_code` and `output_matches` are execution evidence only and the reviewer must mark `verification_adequate = false` when they are the sole claim for a service, disk, or application goal. Results: `verified`, `verification_failed`, or `unknown` (device offline, timeout) with a bounded retry (three attempts over 20 minutes) before `unknown` is final. Stored as `verified_at` + `verification_result` on the proposal and a summary on the execution; posted into the author session and to notification recipients.

**Audit log actions**: `script.proposal.created`, `.scan_rejected`, `.reviewed`, `.review_failed`, `.decided` (approve / reject / changes), `.executed`, `.verified`, `.verification_failed`, `.promoted`; `ai.script.unattended_run`, `.unattended_verified`, `.unattended_failed`, `ai.script_lane.opened`, `.reset`.

**Library and device surfaces**: Scripts list gains an Origin column and filter and "Reviewed" / "Edited since review" badges. Script detail gains a Provenance panel (origin, proposal link or "evidence erased", review summary + risk + model + time, approver, method, executions). Device activity is audit-log driven (`routes/devices/events.ts`, with a performance-sensitive partial-index design), so dispatch writes an `audit_logs` row from the execution snapshot; no query onto `script_executions` or `script_proposals` is added to the feed. Rows link to the proposal or render "evidence erased" (closes #5022 for this path). `AiRiskDashboard` gains proposals per day, unattended runs, lane state, and reviewer disagreements (human rejected after `recommended_action = approve`, human approved after `reject`).

### 4.10 Approval UI

**Web** (`ScriptProposalApprovalCard`, rendered in the chat dialog and on the approvals inbox row when `tool = run_script` and the intent carries `proposalId`; there is no intent-detail page in `apps/web`):

1. Risk band + one-line summary (from the review).
2. Goal and expected effect, verification claim, rollback note.
3. Findings list with severity; blast-radius chips (advisory).
4. Device chips and the existing run-as row.
5. Script body in the editor's read-only highlighted view, collapsed past 40 lines.
6. STRICT acknowledgements as required checkboxes, each with the pattern description and the matching line; Approve stays disabled until all are ticked, and is disabled with an explanation when the approver lacks `scripts:write` or the `mfa` claim.
7. Expiry countdown (existing), then **Approve**, **Request changes** (note required), **Reject**.

The decision ceremony is unchanged and inherits the in-flight fixes: #5600 stops the web client from running a passkey ceremony on supervised self-approvals the server already accepts with a plain click, and #5601 adds a reusable step-up grant for four-eyes and enforcing partners. Four-eyes exclusion of the requester is unchanged. Data comes from `GET /ai/script-proposals/:id`, live-authorised (requester, or `approvals:decide` with org access) on every read, mirroring the `/pending` fix from #3175.

**Mobile**: a typed `ScriptProposalDetails` renderer beside `UacInterceptDetails`: summary, risk band (existing), findings, device, acknowledgements, body in a collapse. Hold-to-confirm and the deny sheet are unchanged. Late approvals continue to work through the existing pending-queue poll. `apps/mobile` has no component tests, so the renderer's logic lives in a pure module with its own tests and the view is covered by the e2e pass.

**Helper**: summary, findings, body collapse, approve or deny. The helper popup is fed by the legacy Tier-2 `approval_required` event, so a proposal-backed run reaches it only when that event carries a proposal; helper coverage is partial in v1 and the PR must say so.

**Approvals inbox list**: risk band and summary on the row.

## 5. Tenancy, RLS, registration

| Table | Shape | RLS | Cascade / registries | Merge | Export policy |
|---|---|---|---|---|---|
| `script_proposals` | 1 (`org_id`, trigger-immutable) | `breeze_has_org_access(org_id)` OR system, FORCE | `CORE_ORG_CASCADE_DELETE_ORDER` (alphabetical, after `script_proposal_reviews` which is its FK child) | `custom`: fence non-terminal rows to `expired`, no-op move, preview counter (the `ai_operator_tasks` pattern) — `leave-for-erasure` is a no-op in both merge phases (`orgMerge.ts:704-707`) so it cannot carry a fence | `content`, `goal`, `expected_effect`, `rollback_note`, ids, hits, classes: `include`; `verification`, `verification_result`: `excludedOpen` |
| `script_proposal_reviews` | 1 | same | before `script_proposals` in the order; `AUDIT_ADMIN_REQUIRED_TABLES` | `leave-for-erasure` | `verdict`: `excludedOpen`; `summary`, tiers: `include`; `input_tokens`/`output_tokens`: `include` + `reviewedSensitiveName: true` |
| `ai_script_policies` | dual-axis org XOR partner | one `FOR ALL` policy (system OR org-access OR partner-access) **plus** the separate `FOR SELECT`-only partner-wide branch on `breeze_current_partner_id()` | `CORE_ORG_CASCADE_DELETE_ORDER`, `DUAL_AXIS_TENANT_TABLES`, `XOR_OWNERSHIP_DUAL_AXIS_TABLES` | org row repointed like other org config; partner row untouched | all `include`; `protected_resources`: `excludedOpen` |
| `ai_script_lane_state` | 1 (PK `org_id`) | same as proposals | `CORE_ORG_CASCADE_DELETE_ORDER` | `leave-for-erasure` | all `include` |
| `script_versions` | no `org_id`; parent-scoped | unchanged axis (via parent script) but policies reduced to INSERT + SELECT | erased through `script_id … ON DELETE CASCADE`; no export entry (no `org_id`) | follows its script | — |
| `scripts`, `script_executions` (new columns) | existing | unchanged | already registered; **new columns classified** in `CORE_TENANT_EXPORT_POLICY` | existing | `origin`, ids, method, digests, `review_summary`: `include`; `parameters` on versions n/a |
| `action_intents.script_reviewer_evidence` | existing | unchanged | already registered | existing | `excludedOpen` |

FK rules: the only hard FK among the new tables is reviews → proposals (composite, deferrable). Proposals → intents, proposals → scripts, executions → versions/proposals/reviews, and `scripts.origin_proposal_id` are plain uuid columns because the referenced rows change org or die on different schedules. `script_versions.script_id` gets `ON DELETE CASCADE` (the constraint is dropped and re-added).

Migrations (W01 and W04), named to sort after `2026-10-15-170200-…` and re-verified against the remote at push: `2026-10-16-100000-script-versions-immutable.sql` (columns, unique, cascade FK, policy replacement, backfill under `breeze.scope = system` with row-count warnings), `-100100-script-proposals.sql` (proposals, reviews, enum, RLS, append-only), `-100200-script-executions-source.sql` (nullable `script_id`, `source_kind` CHECK, snapshot + provenance columns), `-100300-scripts-origin.sql` (origin columns, `origin = system` backfill), and in W04 `2026-10-16-110000-ai-script-policies.sql` (policy + lane-state tables, both RLS policies) and `-110100-action-intents-script-reviewer.sql` (evidence column). All idempotent, no inner transactions.

Contract suites that must go green: `rls-coverage.integration.test.ts`, `tenantCascade.integration.test.ts` (including the FK-cycle check), `tenant-export-policy.integration.test.ts`, `tenantExportErasureRoundtrip.integration.test.ts`, `orgLifecycleFoundations.integration.test.ts` (merge contract with a proposal + review pair and a promoted script), `migrationRlsScope.test.ts`, `autoMigrate.test.ts`, `aiAgentSdkTools.registryParity.contract.test.ts`, `aiGuardrails.imports.contract.test.ts`.

## 6. Failure modes and safety analysis

| Threat / failure | Mitigation |
|---|---|
| Prompt injection via device output steers the author into a hostile script | BASIC scan rejects before anyone sees it; the classifier bounds what the lane may touch regardless of what the reviewer says; the reviewer sees only the proposal, never the poisoned transcript; a human approves by default |
| Reviewer shares the author's blind spot, or is manipulated by content | Floors and lane eligibility read the classifier, not the model (D9); BASIC list unconditional; human default; disagreement metrics on the risk dashboard |
| Reviewer outage or malformed output | Fail closed (D7); reservation settled at zero; nothing runnable; the editor path is unaffected |
| TOCTOU between approval and release | Immutable proposals, non-null pinned snapshot in the digest, one live intent per proposal by CAS, separate lifecycle checks at release |
| Authority changes between approval and release (grant revoked, agent demoted, kill switch, lane opened) | `evidenceValid` re-runs the deterministic invariants at release; `failed:lane_revoked` with the reason |
| Concurrent unattended approvals exceed the cap | Per-org advisory xact lock around count + insert; pending intents counted |
| `runAs = user` IPC hop drops payload fields (#4882/#4883) | Proposal dispatch reuses the library payload shape; no new agent-facing field |
| Device moves org between proposal and release | Existing release re-validation checks device org; `deviceIds` are in the digest; execution snapshots keep provenance readable after the move |
| Source org merged or erased after promotion | Proposal/review rows are left for erasure; version and execution rows carry summary snapshots; UI shows "evidence erased" |
| Approver lacks `scripts:write` + MFA for STRICT hits | Typed 422; card disables Approve and names the requirement; four-eyes fan-out filtered |
| Unattended runaway | Per-hour reservation, single device, 300 s timeout, class allowlist, protected resources, checkpoint prerequisite, lane state opening on two failed verifications, partner ceiling + org grant + MFA |
| Cost | One extra bounded model call per proposal on a cheaper model, reserved before and settled after, attributed to the originating session or run, capped at three concurrent reviews per org |
| Library pollution | Promotion is explicit, requires a verified run and `scripts:write` + MFA (D5) |
| Version history rewrite | Immutability trigger, INSERT + SELECT policies only, `UNIQUE (script_id, version)` |

## 7. Testing

- **Contract**: scanner Go-source parity for BASIC, STRICT, and classifier lists plus behavioural cases; `TOOL_TIERS` + agent-catalog registration for the two new tools; guardrail exhaustiveness for the `run_script` + `proposalId` input-aware branch; `evaluateScriptReviewerAutonomy` table-driven with one negative case per invariant in §4.6 and one positive control; `evidenceValid` negative cases for each revocation (grant off, ceiling lowered, class removed, agent demoted, kill switch, lane open, review superseded); effect-digest non-null and drift; migration naming and RLS-scope guards; every script writer cuts a version (one test per writer).
- **Live DB (integration)**: RLS forge on all new tables (42501); XOR check on policies (23514); partner-wide SELECT branch visible to an org token; org cascade + export roundtrip including a proposal-backed execution and a promoted script; merge contract (fenced proposals, left-for-erasure reviews, repointed org policy row); FK-cycle check passes; a route-level propose → intent → release test inside a real request transaction (the 409-becomes-500 trap); a `Promise.all` race of two `run_script` calls on one proposal (exactly one intent); a `Promise.all` race of N unattended approvals against the hourly cap (exactly cap succeed); `script_versions` UPDATE/DELETE refused as `breeze_app`.
- **Reviewer**: parser rejects malformed output and marks `failed`; floors override a too-low model tier from classifier input; transcript never reaches the prompt (assert on the built request); reservation settled exactly once under job retry.
- **Verification**: each claim kind against a stubbed device; `unknown` after retries; lane state increments and opens at two.
- **Web**: card render tests for each risk tier; STRICT checkboxes gate Approve and the permission message renders; Request-changes requires a note; `no-silent-mutations` coverage for the new handlers.
- **Mobile / helper**: renderer tests for the typed details.
- **E2E** (wt-stack): propose from chat → card → approve → execution → verification → promote → script visible in library with provenance; a second run of the promoted script from an act-mode agent.

## 8. Delivery waves

| Wave | Scope | Flag |
|---|---|---|
| W01 Foundation | `script_versions` rebuild (immutable definitions, unique, cascade FK, all writers, backfill), proposals + reviews tables, `script_executions` proposal source + snapshot/provenance columns + reader updates, `scripts.origin`, shared scanner BASIC mirror + touch classifier + parity tests, `propose_script` / `get_script_proposal`, `run_script proposalId` validation + input-aware guardrail + non-null digest resolver, proposal consumption CAS | `BREEZE_AI_SCRIPT_AUTHORING_ENABLED` off |
| W02 Reviewer | `script-review` worker with budget reservation and settlement, structured verdict, classifier-derived floors, per-org concurrency (Redis counter) and output caps, model call through the partner BYOK client with its own LLM egress surface (`2026-10-16-100400-…`) | off |
| W03 Human loop + verification | proposals API for approvers, web card, mobile renderer, helper, inbox rows, STRICT acknowledgement ceremony on decide (`acknowledged_patterns` column, `2026-10-16-101000-…`), Request-changes loop, `script-verify` job and claim kinds, library provenance UI + `GET /scripts/:id/versions`, Save to library gated on `verified` | flag on by default when W03 lands |
| W04 Unattended lane | `ai_script_policies` + `ai_script_lane_state` + effective-policy resolver + settings UI (partner ceiling, org grant with MFA), `script_reviewer_evidence` column, `evaluateScriptReviewerAutonomy` in `createActionIntent`, `revalidateRelease` branch, hourly reservation under the advisory lock, checkpoint prerequisite (extends #4609), audit | lane off by default (policy) |
| W05 Close the loop | device activity (#5022), risk dashboard metrics, docs, flag removal | |

W04 depends on W03's verification job (lane state cannot open without it) and on W02's review row shape. W01 is the largest wave and may split into two PRs (versions rebuild; proposals + execution source) at planning time.

## 9. Decisions and defaults

Decided: D1–D12 (§1).

Defaults taken without a question, overridable at spec review:
- `proposing_enabled` defaults **on** for every org, because a proposal is inert without an approval.
- Platform reviewer default is a Sonnet-class model; independence comes from context isolation, not model family.
- Proposal expiry is 24 h; intents keep their own windows.
- Partner ceiling defaults: `max_unattended_risk_tier = low`, `unattended_allowed_classes = {services, processes, temp_files, dns_cache, printing}`, `max_unattended_per_hour = 10`.
- Lane state opens after 2 consecutive failed or unknown verifications.
- Unattended `timeout_seconds` cap is 300.
- `services`, `registry`, and `files_system` classes require the checkpoint, so on non-Windows devices they refuse with `checkpoint_unavailable`; the settings page marks those classes Windows-only.

## 10. Open items for planning

- Whether W01 splits the `script_versions` rebuild into its own PR (recommended).
- Exact repair strategy for existing duplicate `(script_id, version)` rows, if any exist in production (the migration must report the count before renumbering).
- A first-class `create_restore_point` agent command (follow-up issue): W04's server-side checkpoint over a raw script dispatch is the v1 mechanism; if it slips, invariant 11 makes `registry`/`services`/`files_system` classes lane-ineligible on every platform until it lands.

## 11. Review record

- 2026-09-11: design approved in dialogue (Todd): proceed; both call sites (A); unattended lane built but off; provenance fields on scripts.
- 2026-09-11: Codex `xhigh` (gpt-6-astra, read-only) quorum on Draft v1: **PROCEED WITH CHANGES**. One critical (a model label is not an enforcement boundary → D9 classifier + class allowlist + protected resources + checkpoint), eight high (intent-side autonomy seam instead of two transport branches → D8; `script_reviewer` needs a typed revalidation branch; proposal-backed executions need a first-class source → D11; versions must be immutable execution definitions across every writer; proposal↔review FK cycle and `script_versions` erasure; proposals must be left-for-erasure on merge; hourly cap must reserve under the lock and count pending intents; envelope must pin the exact review and exclude lifecycle state; verification before promotion and lane → D12), three medium (reuse the shared scanner; STRICT acknowledgement needs `scripts:write` + MFA; reviewer spend needs reservation). Three disagreements adopted: keep the shared policy table but intersect with agent limits; split partner ceiling from org grant → D10; do not reinterpret flow pre-approval. Every cited line was independently re-read before folding; three citations were corrected (versions FK has no cascade, PUT also bumps on parameter changes, export registry uses `include` + `reviewedSensitiveName`).

- 2026-09-11: reconciled against the six wave plans (W01a, W01b, W02, W03, W04, W05) and restored the Approval UI section (§4.10) dropped in the v2 rewrite. Corrections folded: `supersedes_id` and other cross-schedule links are bare uuids; org merge uses a `custom` fence for proposals; `createActionIntent` receives the proposal `GuardrailContext`; the digest resolver adds the module's first throwing path; the flag gates tool definitions and handlers, never registration; STRICT acknowledgements live on `script_proposals.acknowledged_patterns` and require the JWT `mfa` claim; no checkpoint primitive exists today (W04 builds it server-side, Windows only); lane refusals live in `action_intents.result`; device activity is written as an audit-log row from the execution snapshot; helper coverage is partial. Two migration slots added (W02 `100400`, W03 `101000`).

- 2026-09-12: as-built reconciliation against the five shipped implementation PRs (#5621 W01a, #5630 W02, #5636 W03, #5640 W04, #5642 W05), read for their own "Deviations"/"What differed from the plan" sections rather than re-derived. This wave (W06, #5618) consumes all five and adds nothing to the schema.

  **W01a (#5621 — script_versions):** the baseline `script_versions_script_id_scripts_id_fk` had **no `ON DELETE`** (defaulted to `NO ACTION`), a latent GDPR org-erasure bug fixed in the same migration to `ON DELETE CASCADE` — not a design change, a bug the rebuild happened to touch. RLS on `script_versions` is reduced to SELECT + INSERT only (the 2026-10-01 UPDATE/DELETE policies dropped, replaced by an UPDATE-refusing trigger) — an append-only table with no `org_id`/`device_id` of its own, so it needs none of the four registration lists.

  **W02 (#5630 — proposals, scanner, `propose_script`):** CAS updates read `.returning({ id })`, not `rowCount` — postgres.js exposes `count`, and both callers of the original design would always have read "lost". The `shell_eval` classifier rule's leading `\b` was dropped (`-EncodedCommand` starts with a non-word character, so the anchored version could never match — this is the difference between "shell_eval never hard-denies" and the invariant working as designed).

  **W03 (#5636 — reviewer worker):** `waitForReviewCompletion` filters to **`reviewer_kind = 'model'`** — the plan's version returned the *latest* review row of any kind, which meant the static-scan row (written at job start) would satisfy the wait instantly and report `reviewed` with a null risk tier while the proposal was still `proposed`. Every worker write runs inside `withSystemDbAccessContext` (never a bare `db.transaction` outside any context) — a contextless write under forced RLS is a silent 0-row no-op, the same class of bug the tenancy section above warns about. `config.ai.scriptReviewerModel` does not exist (`env.ts` is flat exports); implemented as `AI_SCRIPT_REVIEWER_MODEL`, falling back to `resolveDefaultModel()`.

  **W04 (#5640 — approval cards, promotion, verification):** `acknowledged_patterns` is classified **`excludedOpen`**, not `included`, in the tenant export policy — CLAUDE.md classifies a grant/scope list as a capability list, and the sibling `scripts.acknowledged_security_patterns` already carries that exact classification for the same reason. There is **no `requestedByUserId` column** on `script_proposals`; the requester is derived (the claiming intent's `requested_by_user_id`, else the chat session's `user_id`) — an agent-run proposal with no human requester has no requester-side read grant. Promotion claims the `verified → promoted` CAS **first**, then runs `insertScriptRow` as a savepoint inside the same transaction (the plan's order — insert then transition — would let two concurrent promotes both insert). There is **no `executedAt` column**; `executed` is status-only.

  **W05 (#5642 — reviewer-gated unattended lane):** `ai_script_policies` is registered in `orgMergeRegistry` as **`keep-survivor`, not `repoint`** — the owner-column uniques (`org_id`, and the partner-scoped shape) are **total** (NULLs never collide), which `orgMergeRegistry.integration.test.ts` requires for `keep-survivor`; a `repoint-dedupe` strategy with an empty dedupe key compiles to invalid SQL. Invariant 11 (the System Restore checkpoint) is **split**: creation only proves feasibility (checkpoint-needing classes ⇒ Windows device, recorded as `checkpointRequired` in the evidence); the checkpoint itself is **taken once at release**, via `ensureLaneCheckpointBeforeRelease` on **both** release paths (the durable worker and the inline-chat release — the plan's Task 17 covered only the worker). The intent claim (`consumeProposalForIntent`) already runs **unconditionally** for every `run_script{proposalId}` intent as part of W01b's own contract (throws `proposal_not_runnable` on a lost race) — this subsumes what the plan's Task 15 asked for as a separate "consume on grant" step; a refused (human-path) intent also owns its proposal. Per-run action cap (invariant 13, agent branch) is counted from durable `script_reviewer` action-intent rows (`countRunLaneIntents`), not the run loop's in-memory `ActReservationState`, which never reaches `createActionIntent`. Protected-resource names are read from a deterministic re-scan of the proposal's content (`scanScriptContent(...).touchedNames`) — there is no `touched_names` column on `script_proposals`. W03's unattended-verification hook is a **registry** (`registerUnattendedVerificationOutcomeHandler`), not a typed call site, so `laneOutcome.ts` resolves the intent/origin itself.
