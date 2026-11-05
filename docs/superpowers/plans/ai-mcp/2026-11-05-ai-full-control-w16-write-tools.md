---
tracking_issue: LanternOps/breeze#6754 (W16 #6786)
wave: W16 (#6786)
spec: docs/superpowers/specs/ai-mcp/2026-09-23-ai-full-control-design.md
triage: docs/superpowers/plans/ai-mcp/2026-09-23-ai-full-control-w05-gap-triage.md
depends_on: W10 (#6780, PR #10273) and W19 (#10087) merged to main; W17 (#6788) and W18 (#6789) merged (registry hot files)
branch: feature/6754-ai-full-control/wave-6786 (PR A), feature/6754-ai-full-control/wave-6786-b (PR B)
---
# AI full control W16: AI write tools for agent schedules, operator tasks, Fleet Designs and patch plans. Class review and plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** expose the write halves of the four route modules the W05 triage tagged `W16`. These are the writes that make the AI start more AI. Each tool and action gets a class that survives the spec's class review **before** the tool is reachable (spec D2).

**Architecture:** route logic moves into exported functions that the routes and tools both call (W07-D2). The routes' own gates go with that logic, so no tool re-derives scope. All four tools are chat-only: headless agents are denied (`AGENT_HUMAN_ONLY_TOOLS`), and so is every Wisp grant session (the ceiling floor). The launches are supervised. The two multiplexers carry three four-eyes actions, each bound to a mandatory effect digest that the handler re-checks under its own lock.

**Tech Stack:** Hono services, Drizzle, Vitest (unit + `pnpm test-stack` integration), the action-intent / effect-digest machinery.

**Verified against** `origin/main` `c9ee81b574` (2026-11-05). Paths are under `apps/api/src/` unless stated. Line numbers drift, so re-grep.

## Global Constraints

- **Two sequential PRs, both base `main`, never stacked** (a stacked PR gets no CI). PR B branches from `main` after A merges. A: `Part of #6786`. B: `Closes #6786`. Both `Part of #6754`.
- **No migration, no new table, no new column**, so there is no RLS shape and no entry in `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts`, `CORE_TENANT_EXPORT_POLICY` or the device/ticket lists. `ai_agent_schedules` is already dual-owner (partner baseline XOR org override), so partner-wide-first holds. If implementation finds it needs a migration, stop and raise it: name it after the newest committed migration at that moment (re-check `apps/api/migrations/`).
- **No new setting, so the settings rule-9 counts are unchanged.** Schedules are still edited on the AI Agents page. The tool is another door to the same rows and the same resolver (`effectiveSchedule`), the W14/W18 precedent.
- **The tool never asks for less than the route.** See the gate matrix below.
- **No tool arms act mode.** No tool creates, enables or edits an agent (`designer/enable` stays on the Fleet Design page).
- **No identity recipe is reachable from `create_operator_task`** (Decision 4).
- **A business failure is an `error` envelope.** The release worker and the chat SDK treat a result as failed only when it has `error` and none of `success`, `data`, `configured` (`isReturnedToolError`). A tool that relays a REST body such as `{ success: false, skipped }` records a failed launch as a completed release.
- **`z.undefined()` is banned in tool schemas.** Tool description ≤ 300 chars, param description ≤ 160.

## Review Focus

1. **Widening unattended execution through a side door.** On an armed baseline, `enabled: true`, a wider `sweepKinds`, a new cron, or deleting an override that narrowed, disabled or disarmed each widens what runs unattended → T7 `update of an armed schedule refuses anything that widens`; `delete of a narrowing override under an armed baseline refuses`; `a concurrent REST disarm is not overwritten`.
2. **A Fleet Design apply released after the org changed.** A device moved, a function group or policy assignment changed, another apply landed, or a monitor link's inheritance changed between approval and release → T8 `digest changes when …`; T9 `release after drift refuses`.
3. **The org changes between digest verification and the apply transaction.** Both release paths verify the digest in an earlier transaction, so the handler re-derives it under the report-run lock and refuses on a mismatch → T9 `a change after verification is refused under the lock`.
4. **A site- or device-restricted session.** `create_operator_task` against a device outside the caller's sites is the same not-found as a missing one. Fleet Design and patch tools refuse the session outright → T2, T3, T9 and the integration tasks.
5. **A retried release against a second approved card.** A retried release of one intent replays (`ai-tool:<intentId>`), and the same request approved twice is two intentional launches. → T3 `a retried release replays`; `a second approved intent is a new task`.

---

## Premises

| # | Check | Result |
|---|---|---|
| 0.1 | #6786 and #6754 open | yes |
| 0.2 | None of the four tool names is in `TOOL_TIERS` or registered on `origin/main` | yes (`git grep` over `apps packages ee` finds none) |
| 0.3 | No W16 plan doc, `plan/6754-w16*` branch, or W16 PR | yes |
| 0.4 | `mcpCoverage.ts`: `aiAgentSchedules.ts`, `aiOperatorTasks.ts`, `fleetDesign.ts` are `{ tools }` with reads only (W10). `patchPlan.ts` is `{ gap: '#6786' }` | yes |

### Already covered (not in this wave)

| Surface | Covered by |
|---|---|
| Schedule list, operator task list/detail, Fleet Design list/detail | W10: `list_ai_agent_schedules`, `list_operator_tasks`, `get_operator_task`, `list_fleet_designs`, `get_fleet_design` |
| A patch plan or an Operator recipe from a **Wisp grant session** | `launch_specialist` kinds `patch_plan` and `operator_recipe` (Tier 3 supervised; needs a Wisp grant, so it is absent from ordinary chat and from deployments without Wisp). Decision 2 |
| Agent create / enable / authority grants | `manage_ai_agents` (four-eyes, agent-human-only); `designer/enable` stays human |
| Applying a patch the plan proposed | `manage_patches:install` (Tier 3 supervised, digest-pinned), which is how every patch-plan card is decided |

## Facts the triage did not have

1. **A patch run executes nothing.** `patchLimits()` pins `maxActionsPerRun: 0` (`aiAgents/patchProfile.ts`). Each surviving `install` item becomes one Tier-3 **supervised** `manage_patches:install` card (`aiAgents/patchPlan.ts`, W02 header), and `resolvePolicyDecisionState` returns `human_required` for it with no patch exception. So nothing installs or reboots unattended because of `run_patch_plan`: the tool admits a run that proposes. The design run is the same shape (`designLimits`, `maxActionsPerRun: 0`).
2. **Runs still cost and notify.** Each admission is a credit-debiting LLM run with per-org caps. `runFinishedNotify.ts` sends the run's digest to the agent's recipients. A narrative schedule writes per-recipient email delivery intents (`aiAgents/narrativeReport.ts`). So a launch or a schedule cannot be tier 2 (spec: nothing that leaves the tenant may be tier 2). Whether the literal class rule makes launches four-eyes is Decision 1.
3. **`actMode` on a partner baseline arms unattended Tier-3 execution** for every org under the partner (`routes/aiAgentSchedules.ts` PATCH comment; `aiAgents/sweepActMode.ts`). `enabled`, `sweepKinds` and `actMode` merge independently (`scheduleMerge.effectiveSchedule`). `enabled: false` stops future admission, and `actMode: false` also brakes pending policy-decided releases (`checkSweepScheduleBrake`). `resolveEffectiveScheduleActMode` reports false while the deployment flag is off, so a guard on persisted state must read the rows and use `effectiveSchedule` directly.
4. **Deleting a baseline cascades its org overrides** (`baseline_schedule_id … ON DELETE CASCADE`). Every org's tightening is lost and cannot be restored.
5. **`assertAgentWriteAllowed` refuses every automation principal** (`aiAgents/access.ts`), so an agent could never execute a schedule write even if it were reachable.
6. **A durable release rebuilds the requester on the organization axis** unless the action is named (`actionIntents/actorContext.ts`: `requirePartnerAxis`, `SESSION_EPOCH_RELEASE_ACTIONS`). `assertAgentWriteAllowed` needs `canManagePartnerWidePolicies` for a baseline, so a baseline write released by the worker fails closed, while the same intent released inline by a live session succeeds. A four-eyes approval can easily outlive the session. T6 names the schedule actions (Decision 8).
7. **The apply digest resolver has no auth.** `computeEffectDigestForRelease(actionName, args, db)` runs in `withSystemDbAccessContext`, while `previewFleetDesignApplyWithContext` reads `policyAccessCondition(auth)`, `canManagePartnerWidePolicies(auth)` and `previewBundle(auth, …)`. So the preview cannot be the resolver. T8 adds an auth-free target snapshot.
8. **Digest verification and execution are separate transactions.** Both release paths verify first and then execute (the worker under `withAuthDbAccessContext`, since `toolManagesDbContext` is false for these tools). A later read proves nothing about the earlier one (the worker's own #3409 note). `lockReportRun` serializes same-report operations, not independent policy, group or device edits. The `verifiedTopologyDiagnostic` / `ApprovalBinding` pattern (carry what was verified; re-derive and re-bind inside the acceptance transaction) is the precedent T9 follows.
9. **Fleet Design apply changes billing and installs responses.** Role corrections are `billingRelevant: true` (`fleetDesign/preview.ts`). A watch with `autoRestart` installs an unattended service-restart response (`fleetDesign/monitorAttachments.ts`). Monitors attach to an existing policy, keeping its current assignments and inheritance, so assignment drift changes the affected fleet without changing ledger refs.
10. **`POST /ai/operator/tasks` admits three recipes.** `service_recovery` is device-targeted (triage agent). `identity_offboarding` disables accounts, removes licences and wipes mobiles. `identity_onboarding` creates accounts. The identity paths add `organizations:write` and `canMutateOrgWideGovernance`.
11. **Admission replays any existing `(org, clientIdempotencyKey)` whatever the task's status** (`aiOperator/taskService.ts`), and the triggering alert becomes part of the frozen success criterion (`recipes/serviceRecovery.ts`). So a key derived from the inputs would swallow an intentional second task.
12. **Registry count is 368 on `c9ee81b574`** (measured, `aiTools.size`), not 365. Plus 4 is 372 > 370, so `MCP_TOOL_COUNT_APPROX` (360 ± 10) needs a bump in PR B.

## Tools and per-action class review

Q1 reversible in a minute? Q2 leaves the tenant / reaches a person? Q3 blast radius? Q4 can an agent grant itself authority?

### PR A: launch tools

| Tool:action | Q1 | Q2 | Q3 | Q4 | Triage | **W16** |
|---|---|---|---|---|---|---|
| `run_patch_plan` | no: credits, and the digest is sent | **notifies recipients**; proposes installs, each its own card | one org | **yes:** an agent starting agent runs | sup | **Tier 3 supervised** (class-rule exception, Decision 1) |
| `create_operator_task` (service_recovery) | no: the task starts work on a device at once | touches a customer machine; each effect has its own approval | one device | **yes:** delegation outlives the call | sup | **Tier 3 supervised** (Decision 1) |

### PR B: multiplexers

| Tool:action | Q1 | Q2 | Q3 | Q4 | Triage | **W16** |
|---|---|---|---|---|---|---|
| `manage_ai_agent_schedules:create` | yes (delete), but it can fire first | narrative schedules email people; runs debit credits | partner-wide (baseline) or one org | **yes** | sup | **sup** |
| `…:update` | yes | as create | as create | **yes** | sup | **sup**; on an armed schedule, anything that widens is refused (Decision 3) |
| `…:delete` | **no** (a baseline cascades every override; an override's narrowing is lost) | as create | partner-wide or one org | **yes** | sup | **four-eyes**, mandatory digest. Static for both owners: the input names no owner, and for a single-org override on an unarmed baseline this is stricter than the rule requires (recorded) |
| `manage_fleet_designs:run` | no (credits) | the run digest notifies recipients | one org | **yes** | sup | **sup** (Decision 1) |
| `…:preview` | read (takes a short row lock) | none | one org | no | read | **t1** |
| `…:applied` | read | none | one org | no | read | **t1** |
| `…:apply` | **no** (role corrections bill; scripts, memberships and restart responses reach devices) | **bills money**; touches every device the design names | one org | no | 4e | **four-eyes**, mandatory digest |
| `…:rollback` | **no** (removes monitoring from customer devices; reverses billing roles) | as apply | one org | no | — | **four-eyes**, mandatory digest (Decision 5) |
| `…:document` | yes (delete the document) | may mark a contract deliverable delivered | one org | no | — | **sup** |

Not built, recorded in `mcpCoverage.ts` comments so they read as decided: `POST /ai/fleet-design/designer/enable` (creates or enables an autonomous agent: `manage_ai_agents` territory). The operator-task drafts, the reservation release and the identity-recipe admissions (Decision 4). The schedule `actMode: true` arm (Decision 3).

### Gate matrix (= route unless marked tool-only)

| Surface | Scope | Permission | MFA | Other gates carried |
|---|---|---|---|---|
| `run_patch_plan` | org, partner, system | `ai_agents:write` | yes | `canAccessOrg` same not-found; effective `patch` agent; **tool-only:** site/device-restricted refused (Decision 6) |
| `create_operator_task` | org, partner, system | `ai_agents:write` | yes | org access; device in org and `canAccessSite` same not-found (`deviceArgs: ['deviceId']`); readiness flags (`aiOperatorTasksEnabled`, `aiOperatorServiceRecoveryEnabled`); recipe version; effective enabled triage agent |
| schedules `create`/`update`/`delete` | org, partner, system | `ai_agents:write` | yes | `assertAgentWriteAllowed` (includes `canMutateOrgWideGovernance`, `canManagePartnerWidePolicies`); owner pair; cron, kind and baseline validation |
| fleet `run` | org, partner, system | `ai_agents:write` | yes | `canAccessOrg`; `siteId` belongs to `orgId`; effective `designer` agent; **tool-only:** restricted refused (Decision 6) |
| fleet `preview`, `apply` | org, partner, system | `devices:write`; `scripts:write` when `automation` is non-empty | yes | `siteRestricted` refusal; report org condition |
| fleet `rollback` | org, partner, system | `devices:write` | yes | `siteRestricted` refusal; passes the live `canWriteScripts`, so only script rows are refused without it |
| fleet `applied` | org, partner, system | `ai_agents:read` | no | report org condition; **tool-only:** restricted refused (Decision 6) |
| fleet `document` | org, partner, system | `documents:write` | no | **must pass `linkDeliverableEvidence = has(contracts:write)` explicitly** (omission defaults to linking); **tool-only:** restricted refused (Decision 6) |

### Agent (headless) exposure (spec D4)

| Tool | Agent reachable | Why |
|---|---|---|
| `run_patch_plan`, `create_operator_task`, `manage_ai_agent_schedules` | **no**, `AGENT_HUMAN_ONLY_TOOLS` | Q4: each starts or schedules autonomous work; an agent that could call them launches runs that launch runs (the `launch_specialist` and `workspace_launch_analysis` reasoning). Schedule writes are refused to automation principals anyway (Fact 5), and the launches record `requestedByUserId`, which an agent principal does not have |
| `manage_fleet_designs` | **no**, `AGENT_HUMAN_ONLY_TOOLS`, whole tool | `run` is Q4. `apply`, `rollback` and the reads are **not** Q4, so this is an explicit exception to D4's "action-level where only some actions grant authority" (Decision 7). Agents keep the W10 reads, and an agent has no `devices:write` user permissions for `preview` |

Membership puts all four in the Wisp grant ceiling floor (`isNeverDelegableTool`), so a Wisp grant session refuses them and `launch_specialist` stays the Wisp door. `__snapshots__/agentToolCatalog.contract.test.ts.snap` gains four names. No locale labels are added, because only agent-reachable tools are in the catalog.

## Decisions surfaced while planning

1. **Launches: supervised, or four-eyes by the literal class rule?** (The quorum and this plan disagree.) A launch cannot be undone (credits) and it notifies people, and the rule says irreversible + reaches a person = four-eyes.
   - **A: supervised, as a recorded exception (recommended).** The effect is findings: `maxActionsPerRun: 0` for patch and design runs, and each operator effect has its own approval. Per-org caps bound the spend. `launch_specialist:patch_plan` and `:operator_recipe` are already supervised. REST "Run now" is one person + MFA, so four-eyes would make chat slower than the button for the same run. The PR body carries the sign-off (spec: moving off four-eyes is a loosening).
   - B: four-eyes for `run_patch_plan`, `create_operator_task` and fleet `run`. Literal rule, no exception, but a second person must approve a findings-only run, and it is out of step with `launch_specialist`.
2. **Build `run_patch_plan` and `create_operator_task` although `launch_specialist` has `patch_plan` and `operator_recipe` kinds?**
   - **A: build both (recommended; the quorum agrees).** `launch_specialist` refuses without a Wisp grant (`aiToolsWisp.ts`: `GRANT_REQUIRED`), so ordinary chat and deployments without Wisp have no door. The paths share admission, so semantics cannot drift. Golden prompts check that ordinary chat picks the W16 tool.
   - B: mark both modules covered by `launch_specialist`. Zero new tools, but the gap stays for every session without a grant.
3. **Act mode from chat.**
   - **A: the tool never arms, and an armed schedule only narrows (recommended).** `create` has no `actMode`. `update` accepts only `actMode: false`. While the baseline's persisted `actMode` is true, a write is refused if the resulting effective `{enabled, sweepKinds, actMode}` is not a subset of the current one, or if it changes cadence. Deleting a narrowing override is refused the same way. Creating an override with `actMode` null is allowed: the absent override already inherits. The approval copy distinguishes the brakes: `enabled: false` stops future runs; `actMode: false` also stops pending unattended actions. Arming stays on the AI Agents page (Q4, the `manage_ai_agents` precedent).
   - B: an `arm_act_mode` four-eyes action with a digest over the baseline and its overrides. Chat-reachable, but a second grant-of-authority path beside `manage_ai_agents`. Needs its own review.
4. **`create_operator_task` recipes.**
   - **A: `service_recovery` only (recommended).** Identity changes are a spec standing exclusion. The identity paths stay on the Recipe Library page and on the existing Wisp `operator_recipe` path, both unchanged.
   - B: all three, carrying the route's `organizations:write` + `canMutateOrgWideGovernance` gates. Reaches offboarding from chat, but it makes an identity write reachable from a W16 tool.
5. **Fleet Design rollback: four-eyes or supervised?**
   - **A: four-eyes, digest over the ledger and the live targets (recommended).** It removes monitoring from customer devices and reverses billing-relevant role corrections. One person cannot apply alone, so one person should not silently undo it either.
   - B: supervised with the same mandatory digest. One approver, still bound to what was approved. The class rule allows it, because rollback is org-scoped.
6. **`run_patch_plan` and `manage_fleet_designs` (all actions) refuse site- and device-restricted sessions, stricter than REST for `run`, `applied` and `document`.** Recommended: refuse, because the W10 reads already refuse those sessions, so such a caller could start a run whose result it cannot read. Alternative: mirror REST exactly.
7. **Sign-off on the four `AGENT_HUMAN_ONLY_TOOLS` entries, including the D4 exception for `manage_fleet_designs`.** Recommended: whole-tool denial. No agent workflow needs it, and a designer agent proposing its own design's apply adds a self-review loop. Alternative: `AGENT_HUMAN_ONLY_ACTIONS` for `run`, letting an agent propose `apply` / `rollback` as four-eyes cards (the D4 "agent proposes, human approves" path), which also needs agent-principal handling in `preview`.
8. **Partner baselines from chat need a release-auth change.** (`actionIntents/actorContext.ts`, Fact 6.)
   - **A: a narrow `PARTNER_AXIS_RELEASE_ACTIONS` registry naming only `manage_ai_agent_schedules` `create`/`update`/`delete` (recommended).** A requester who currently resolves on `intent.partnerId` releases on the partner axis with live `partnerOrgAccess`, so `canManagePartnerWidePolicies` re-proves full membership at release. Anyone else stays on the organization axis and fails closed. The baseline is the schedule's main object: orgs may only tighten.
   - B: org overrides only in W16; baselines stay on the AI Agents page. No auth change, but "schedule a nightly sweep for all our customers" refuses from chat, which is most of the tool's value.

## Wiring

| Map | PR A | PR B |
|---|---|---|
| `TOOL_TIERS` | `run_patch_plan: 3`, `create_operator_task: 3` | `manage_ai_agent_schedules: 1`, `manage_fleet_designs: 1` |
| `TIER3_SUPERVISED_TOOLS` | both | — |
| `TIER1_READ_ACTIONS` | — | `manage_fleet_designs: ['preview','applied']` |
| `TIER3_ACTIONS` + `TIER3_SUPERVISED_ACTIONS` | — | schedules `create`, `update`; fleet `run`, `document` |
| `TIER3_ACTIONS` + `TIER3_FOUR_EYES_ACTIONS` | — | schedules `delete`; fleet `apply`, `rollback` |
| `TOOL_ACTION_INPUT_KEYS` | — | both `action` |
| `EFFECT_DIGEST_RESOLVERS` + `PINNED_EFFECT_DIGEST_REQUIRED_ACTIONS` | — | `manage_ai_agent_schedules:delete`, `manage_fleet_designs:apply`, `manage_fleet_designs:rollback` |
| `ORG_WIDE_GOVERNANCE_TOOL_ACTIONS` (`actionIntents/orgWideGovernanceTools.ts`) | — | schedules `create`/`update`/`delete`; fleet `apply`/`rollback`. Supplies the site/device ceiling on raise, fan-out, decide and release, not the partner-membership check (that is T6) |
| `PARTNER_AXIS_RELEASE_ACTIONS` (new, `actorContext.ts`) | — | schedules `create`/`update`/`delete` (Decision 8) |
| `MFA_GATED_TOOL_ACTIONS` | both `'*'` | schedules `'*'`; fleet `['run','preview','apply','rollback']` |
| `TOOL_PERMISSIONS` | both `ai_agents:write` | per the gate matrix, per action |
| `TOOL_ACTION_EXTRA_PERMISSIONS` | — | none static; `scripts:write` and `contracts:write` are conditional, handler-enforced, and noted as `toolOnly` on the route-binding rows |
| `TOOL_RATE_LIMITS` | `run_patch_plan` 5/300 s; `create_operator_task` 10/300 s | schedules 15/300 s; fleet 10/300 s |
| `AGENT_HUMAN_ONLY_TOOLS` | two | two |
| `WISP_NON_FOCAL_TOOLS` (`wisp/toolSubjects.ts`, #10834) | two | two |
| `RAW_TEXT_FIELDS_BY_TOOL` | task objective, refusal detail | design labels, function and script names, blocker text |
| `mcpCoverage.ts`, `FROZEN_GAPS` | `patchPlan.ts` → `{ tools: ['run_patch_plan'] }` (−1); `aiOperatorTasks.ts` + `create_operator_task` | `aiAgentSchedules.ts` + `manage_ai_agent_schedules`; `fleetDesign.ts` + `manage_fleet_designs`; comments name the routes left human |
| `apps/web/src/components/ai-risk/tierConfig.ts`, AI docs page | two rows | two rows with per-action classes |
| `agentToolCatalog.ts` `TOOL_CAPABILITY` | `'tenancy'` rows only if `agentToolCatalog.contract` requires denied tools mapped (the `manage_ai_agents` "mapped for completeness" precedent); never reachable | same |
| Helper whitelist (`helperToolFilter.ts`) | none (spec checklist 9: single-device by design) | none |

All four have domain `ai`, beside the W10 reads and `launch_specialist`. No `DOMAIN_VOCABULARY` or `DOMAIN_NOTES` change.

## Budget

Measured on `c9ee81b574` with a registry probe over `listChatSurfaceToolNames()` (`FLOWS_ENABLED=true`, the pinned configuration; Wisp exposure off). "After" is rendered with the four names registered in `ai` and the action enums below. The quorum reproduced these numbers independently. T4 and T10 re-measure and replace them.

| Measure | Bound | Before | After PR A | After PR B |
|---|---|---|---|---|
| Always-on (lazy) | B1 < 2,560 | 2,551 | 2,551 (+0) | 2,551 (+0) |
| `ai` block | B2 < 2,048 | 325 | 363 | 481 |
| Largest block | B2 < 2,048 | `devices` 1,720 | unchanged | unchanged |
| Worst page turn | B3 < 7,040 | 5,342 | 5,342 (`ai` is not page-expanded) | 5,342 |
| Whole index (`AI_TOOL_INDEX=full`) | none since W19 | 11,934 | ~11,972 | 12,090 (informational) |
| Registry (`aiTools.size`) vs `MCP_TOOL_COUNT_APPROX` 360 ± 10 | ≤ 370 | 368 | 370 | 372 → **bump to 370** in its own PR B commit (`~370 tools` in `MCP_SERVER_INSTRUCTIONS` follows) |

- **The always-on bound is not raised and gains 0 B.** The tools land in an existing domain with no vocabulary change. The exact-byte pin (`aiToolIndex.test.ts`, `toBe(2551)`) stays.
- Alternative measured: `run_patch_plan` in `patching` puts `patching` at 721 B (from 705) and `ai` at 465 B, still inside every bound. Rejected because users ask "run the patch agent", and the `patching` block is about patches, not agents.
- No +128 B step is needed: no bound is exceeded.

## Golden prompts (`services/llm/toolEval/goldenPrompts.ts`)

Ids start at **g136** (W17 g120–g126, W18 g127–g135). `goldenPrompts.test.ts` pins the count (+2 PR A, +5 PR B). Rebase onto whatever is newest at implementation time and re-key.

| Id | PR | Prompt | Expect |
|---|---|---|---|
| g136 | A | "Run the patch agent for Contoso now." | `run_patch_plan` (not `launch_specialist`, not `manage_patches`) |
| g137 | A | "Have the AI get the Print Spooler on WS-01 running again." | `create_operator_task` |
| g138 | B | "Schedule a health sweep every night at 2am for all our customers." | `manage_ai_agent_schedules:create` |
| g139 | B | "Stop the nightly sweep for Contoso." | `manage_ai_agent_schedules:update` or `:create` (override with `enabled: false`) |
| g140 | B | "Run a Fleet Design for Contoso." | `manage_fleet_designs:run` |
| g141 | B | "Apply the functions and monitoring from Contoso's latest Fleet Design." | `list_fleet_designs` then `manage_fleet_designs:preview` / `:apply` |
| g142 | B | "Undo the Fleet Design we applied at Contoso last week." | `manage_fleet_designs:applied` then `:rollback` |

## Quorum (codex `exec`, read-only, xhigh, gpt-6-astra): AGREE WITH CHANGES

One round. Each finding was checked by reading the cited code before it was accepted.

**Agreed as drafted:** the sequential split; building the two launch tools despite `launch_specialist`; the Wisp floor; no new table or column; the budget arithmetic.

**Changes adopted:**
- Partner-baseline writes fail closed on a worker release: accepted (Fact 6, Decision 8, T6). This also removed the plan's `USER_OWNED_RELEASE_ACTIONS` rows: that list applies only to agent-originated intents, which these tools cannot produce.
- The act-mode guard compared only act mode: accepted. The guard compares the whole effective schedule, reads persisted rows rather than the flag-gated resolver, and distinguishes the two brakes (Fact 3, Decision 3, T7).
- Guards must share the mutation's locks, and the baseline delete digest must pin override contents, not ids: accepted (T7).
- The apply snapshot was incomplete: accepted. It adds policy ownership and status, assignments, monitor-link settings and inheritance, group identity, function assessments and notification destinations; approval copy discloses `autoRestart` (T8, T10).
- Rollback needs live-target pinning: accepted (T8). The two service tightenings are in T9.
- **The draft's transaction premise was wrong:** the worker already wraps these tools in `withAuthDbAccessContext`. The real gap is verify-then-execute, so the handler carries the verified digest and re-derives it under the lock (Fact 8, T9).
- Gate matrix made explicit: accepted (above), including the explicit `linkDeliverableEvidence`.
- The operator idempotency key conflated retries with new requests: accepted. The key is now the intent id (Fact 11, T3), and the run launches use the same identity.
- Business failures must be `error` envelopes: accepted (Global Constraints, T2, T9).
- `deviceArgs: ['deviceId']` on `create_operator_task`, and dedicated arming tests because `aiGuardrails.enforcementArming.contract` does not scan `actMode`: accepted (T3, T7).

**Resolved differently:**
- *Launches are four-eyes under the literal rule:* not adopted; supervised as a recorded exception, surfaced as **Decision 1** for sign-off.
- *Atomic baseline validation for every caller:* adopted for the target row (`FOR UPDATE`) and for partner callers' baseline read. An organization session cannot hold a lock on a partner row in its own transaction (`scheduleService.ts`, `loadBaselineForOverride`), so its read stays plain. That is safe for the arming race: a check that reads "unarmed" before a concurrent arm commits is equivalent to the override write happening first, which the arming human then acts on.
- *Whole-tool Fleet denial needs a rationale; delete four-eyes is stricter than the rule for a single-org override:* both kept and recorded in the class tables, with the alternative in **Decision 7**.

## Execution split and parallelism

Web seam: only `tierConfig.ts` and the docs page, driven by final tool names, so there is no API/web contract to coordinate.

**PR A**
- **PARALLEL GROUP A (file-disjoint):** T1 (`routes/aiOperatorTasks.ts`, new `services/aiOperator/serviceRecoveryLaunch.ts`) and T2 (`routes/patchPlan.ts`, new `services/aiAgents/patchPlanLaunch.ts`, new handler).
- **SERIAL:** T3 (operator handler, needs T1 and T2's module) → T4 wiring, index, golden, copy → T5 integration, PR.
- **Sonnet-eligible:** T4's `tierConfig.ts` rows, docs page, `mcpCoverage.ts` comments, golden rows. **Opus** for T1–T3 and T5.

**PR B** (after A merges, from fresh `main`)
- **PARALLEL GROUP B (file-disjoint):** T6 + T7 (`actorContext.ts`, `scheduleService.ts`, `routes/aiAgentSchedules.ts`, new handler, `actionIntents/scheduleDeleteDigest.ts`) and T8 + T9 (`services/fleetDesign/*`, `routes/fleetDesign.ts`, `toolExecutionContext.ts`, new handler, `actionIntents/fleetDesignDigest.ts`). The resolvers live in leaf files so `effectDigest.ts` takes one-line registrations, made in T10.
- **SERIAL within each group:** T6 → T7; T8 → T9. Then T10 wiring, index, golden, copy → T11 integration, PR.
- **Opus throughout PR B** (auth reconstruction and three four-eyes surfaces) except T10's mechanical rows (`tierConfig.ts`, docs, coverage comments, golden rows: Sonnet).

### Implementer brief: stop rules

1. **Premise false: ABORT and report; do not improvise.** Re-check at the start of each PR: issues open, tool names unregistered, W16 branch and PR absent, and the module rows as in Premises.
2. **Open the PR, post the review summary, and STOP.** Do not merge. Do not close #6786. Merge and the `plan-approved` gate are the orchestrator's and Todd's.
3. **No background CI pollers, and never `pkill -f`.** Watching CI is the orchestrator's job. Run verification synchronously in the foreground.

Plan-specific halts, same rule (stop and report, do not work around):
- A class, gate or denial in this plan is wrong against the code. Do not loosen a class, drop a gate or move a tool off `AGENT_HUMAN_ONLY_TOOLS` to make a test pass (spec D2).
- The work needs a migration, a new table or column, a new setting, or a raised index bound.
- A contract test goes red for a reason this plan does not name. Fix the classification; add no allowlist entry or exemption without a written reason in the PR body.

Every branch comes off fresh `origin/main` in its own worktree. Public repo: no customer names, hosts, IPs or production numbers in code, tests or PR text.

## Tasks

Test commands run from `apps/api`: `pnpm exec vitest run <file>`. Never `pnpm --filter <pkg> test -- --run <path>`. Run test files in small batches on a loaded host. TS check: `tsc --build tsconfig.tests.json` with a 20 GB heap (`NODE_OPTIONS=--max-old-space-size=20480`). Check the exit code, not `| tail`. Integration suites need `pnpm test-stack up` and do not run under `pnpm test`. Tear down with `pnpm test-stack down`.

### Task 1 (PR A): service-recovery admission as a shared operation

**Files:** Create `services/aiOperator/serviceRecoveryLaunch.ts` + `.test.ts`. Modify `routes/aiOperatorTasks.ts` (`POST /tasks` device path calls it; the identity paths are untouched). The route suites (`aiOperatorTasks*.test.ts`) stay green unchanged.

**Interfaces — Produces:**
- `launchServiceRecoveryTask(auth: AuthContext, input: { orgId: string; recipeKey: string; recipeVersion: number; deviceId: string; serviceName: string; sourceKind?: 'alert'; sourceId?: string; clientIdempotencyKey: string }): Promise<ServiceRecoveryLaunchResult>`.
- `type ServiceRecoveryLaunchResult = { ok: true; taskId: string; replayed: boolean } | { ok: false; code: string; detail?: string; supportedRecipeKeys?: string[] }`, where `code` is `NOT_FOUND` or the route's existing `OPERATOR_*` / uppercased refusal code. The route maps each code to its current status and body (404 / 422 / 400 / 429). The check order in the route header (org → device + site → readiness → agent → admission) moves verbatim.

- [ ] Step 1: failing tests:
  - `org outside canAccessOrg and device outside the caller's sites both return NOT_FOUND with no admission call`;
  - `readiness flags off refuse before admission`;
  - `the effective triage agent is resolved server-side; a disabled one is OPERATOR_NO_AGENT`;
  - `a replayed key returns the first taskId with replayed: true`;
  - `objective is built from the device hostname, never from input text`.
- [ ] Step 2: run, expect FAIL.
- [ ] Step 3: move the code; the route becomes thin. Re-run the route suites unchanged.
- [ ] Step 4: expect PASS. Commit `refactor(api): W16 service-recovery task admission as a shared operation (#6786)`.

### Task 2 (PR A): `run_patch_plan`

**Files:** Create `services/aiAgents/patchPlanLaunch.ts` + test, `services/aiToolsAiAgentLaunch.ts` + test (registers both PR A tools; `create_operator_task` lands in T3). Modify `routes/patchPlan.ts` to call the service.

**Interfaces — Produces:**
- `launchPatchPlanRun(auth, orgId: string, dedupeKey: string): Promise<{ ok: true; runId: string; agentId: string } | { ok: false; code: 'NOT_FOUND' | 'NO_PATCH_AGENT' } | { ok: false; code: 'SKIPPED'; skipped: string; agentId: string }>`. The audit row stays with the caller (route: `writeRouteAudit`; tool: `auditToolWrite`), both with action `ai_patch_plan.run.manual_trigger` on every outcome. The tool adds `details.via: 'ai_tool'`.
- Tool input (`.strict()`): `{ orgId: uuid }`. Output: `{ queued: true, runId }`, or the envelope `{ error: 'The patch run was not started', code: 'RUN_SKIPPED', skipped }`. No `success` key.
- Dedupe key: `patch-ai-tool-${context.actionIntentId}` when a release path supplies it (a retried release is one run; a second approved card is a second run), else `patch-ai-tool-${randomUUID()}`.
- `registerAiAgentLaunchTools(aiTools)`. The handler declares the third `context` parameter and goes through no truncating wrapper.

- [ ] Step 1: failing tests:
  - `run_patch_plan refuses an org outside reach with the same not-found as a missing org`;
  - `site- and device-restricted sessions are refused before any lookup` (Decision 6);
  - `an ai_agent principal is refused` (defence beside the registry);
  - `skipped admission is an error envelope` (has `error`; none of `success`, `data`, `configured`);
  - `every outcome writes one audit row`;
  - `a body carrying deviceId is rejected` (schema `.strict()`);
  - `route: POST /ai/patch-plan/runs unchanged`, including its 200 `{ success: false, skipped }` (existing suite green).
- [ ] Step 2: run, expect FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: expect PASS. Commit `feat(ai-tools): W16 run_patch_plan (#6786)`.

### Task 3 (PR A): `create_operator_task`

**Files:** Modify `services/aiToolsAiAgentLaunch.ts` + test. Create `services/aiToolSchemasAiAgentLaunch.ts`.

**Interfaces — Produces:**
- Tool input (`.strict()`): `{ orgId: uuid, deviceId: uuid, serviceName: string (1–256), alertId?: uuid }`, with `deviceArgs: ['deviceId']`. No `recipeKey` (fixed `service_recovery`, released version read server-side) and no idempotency key.
- `clientIdempotencyKey = 'ai-tool:' + context.actionIntentId`. The intent's arguments are immutable, so the key binds the device, service and alert the approver saw. With no `actionIntentId` (a tier-3 tool always mints one in chat), refuse with `code: 'APPROVAL_REQUIRED'` rather than invent a key.
- Output: `{ taskId, replayed }`, or `{ error, code }` with the T1 code.

- [ ] Step 1: failing tests:
  - `a retried release replays` (same `actionIntentId`: same `taskId`, `replayed: true`);
  - `a second approved intent is a new task` (same inputs, new intent id);
  - `no actionIntentId is refused and nothing is admitted`;
  - `device outside the caller's sites is NOT_FOUND`;
  - `no identity recipe is reachable` (schema has no `recipeKey`; a body naming `identity_offboarding` is rejected);
  - `an ai_agent principal is refused`;
  - `serviceName and refusal detail are fenced as untrusted text`, with a control.
- [ ] Step 2: run, expect FAIL.
- [ ] Step 3: implement over T1.
- [ ] Step 4: expect PASS. Commit `feat(ai-tools): W16 create_operator_task for service recovery (#6786)`.

### Task 4 (PR A): wiring, index, golden, copy, coverage

**Files:** Every PR A cell of the Wiring table; `services/aiTools.ts`, `services/aiToolSchemas.ts`, `services/aiAgentSdkTools.ts`, `aiToolIndex.test.ts` (no pin change expected), `services/llm/toolEval/goldenPrompts.ts` + test, `__tests__/mcp-coverage.test.ts`, `apps/web/src/components/ai-risk/tierConfig.ts`, `apps/docs/src/content/docs/features/ai.mdx`, `.../mcp-server.mdx`. Tests: `W16A_EXPECTED` in `aiGuardrails.approvalScope.contract.test.ts`; route-binding rows (`POST /ai/patch-plan/runs`, `POST /ai/operator/tasks` with `toolOnly` noting the service_recovery-only input).

Approval copy (exact):
- `run_patch_plan`: "Run the patch agent for {org} now. It uses AI credits and may notify people. It proposes installs for approval; nothing is installed without a further approval."
- `create_operator_task`: "Delegate restoring the {serviceName} service on {hostname} to the AI Operator. It uses AI credits. Each change it makes asks for approval."

- [ ] Step 1: write the failing rows, plus `every W16 tool stays in AGENT_HUMAN_ONLY_TOOLS` and `isNeverDelegableTool is true for each`.
- [ ] Step 2: add the entries. Measure B1, B2, B3 and full; replace the Budget column.
- [ ] Step 3: run the sweep, in batches: `aiGuardrails.{approvalScope,routeBinding,routeParity,tier1WriteActions,agentPrincipal,mcpTier3ActionDowngrades,tierDecidingKeys}.contract`, `aiAgentSdkTools.{registryParity,handlerCoverage}.contract`, `aiToolPermissionsCatalogParity.contract`, `aiTools.{descriptionBudget,outputBudget,domainMetadata,deviceTextFence,userOwnedRelease}.contract`, `mcpToolPresentation.guardrailParity.contract`, `wisp/toolSubjects.contract`, `__tests__/parkedFanout.contract`, `__tests__/mcp-coverage`, `mcpGuidancePromptTools`, `aiGuardrailsTierConfig.parity`, `aiGuardrailsAiDocs.parity`, `actionIntents/approvalLabels.contract`, `aiAgents/agentToolCatalog.contract` (snapshot updated deliberately), `aiToolIndex`, `aiToolIndex.w15-budget`, `aiAgent.toolIndexPrompt`, `goldenPrompts`, `lazyIndexCases`. All PASS.
- [ ] Step 4: commit `feat(ai-tools): W16 PR A guard classes, index and docs (#6786)`.

### Task 5 (PR A): integration, merge `main`, PR

**Files:** Create `__tests__/integration/aiToolsAiLaunchScope.integration.test.ts`.

Cases, as `breeze_app` on a per-worktree test stack, through `executeTool`:
- `create_operator_task` as a site-restricted member against a device in another site of the same org is not found, and no task row exists. Control: the same device for an unrestricted caller admits.
- `run_patch_plan` for an org of another partner is not found, with no run row.
- A retried release (same `actionIntentId`) returns the same task id under real admission.

- [ ] Step 1: `pnpm test-stack up`, run, expect PASS, `pnpm test-stack down`.
- [ ] Step 2: TS check (20 GB heap, exit code checked), `tsc --noEmit` in `apps/web`. Merge `origin/main`, re-run T4's sweep and re-measure.
- [ ] Step 3: PR with the tool/class table, the Decision 1 exception and the two denial sign-off lines, measured budget, Merge Danger (two-way; verbatim extraction), chat smoke prompts. `Part of #6786`, `Part of #6754`. Integration runs only in CI's `integration-test`, so it is not green until CI says so.

### Task 6 (PR B): partner-axis release for schedule writes

**Files:** Modify `services/actionIntents/actorContext.ts` + its test.

**Interfaces — Produces:**
- `PARTNER_AXIS_RELEASE_ACTIONS: ReadonlyMap<string, readonly string[]>` = `{ manage_ai_agent_schedules: ['create','update','delete'] }`.
- In `buildUserOwnedAuthContext`: a third way to the partner axis beside `requirePartnerAxis` and `carriedPartnerAxis`. It applies when the intent's tool and action are listed, the origin is `user_session`, `perms.scope === 'partner'`, and `perms.partnerId === intent.partnerId`. It carries no session epochs. `partnerOrgAccess` comes from the current membership (existing line). Anyone else keeps the organization axis.

- [ ] Step 1: failing tests:
  - `a full-partner requester releases on the partner axis with live partnerOrgAccess`;
  - `a requester whose membership became selected fails canManagePartnerWidePolicies at release`;
  - `an org-axis requester keeps organization scope and the baseline write is refused`;
  - `a requester of another partner gets null or organization scope, never partner`;
  - `an unlisted tool or action is unchanged` (exact context shape as today);
  - `an agent or MCP origin never takes this axis`.
- [ ] Step 2: run, expect FAIL.
- [ ] Step 3: implement. Do not change `SESSION_EPOCH_RELEASE_ACTIONS` or the existing branches.
- [ ] Step 4: expect PASS. Commit `feat(api): W16 named partner-axis release for schedule writes (#6786)`.

### Task 7 (PR B): `manage_ai_agent_schedules`

**Files:** Create `services/aiToolsAiAgentSchedules.ts` + test, `services/aiToolSchemasAiAgentSchedules.ts`, `services/actionIntents/scheduleDeleteDigest.ts` + test. Modify `services/aiAgents/scheduleService.ts` (optional guard argument; REST passes none, so REST is unchanged).

**Interfaces — Produces:**
- Tool input (`.strict()`, discriminated on `action`):
  - `create`: the shared `createAiAgentScheduleSchema` **minus `actMode`** (both owner arms).
  - `update`: `{ scheduleId, cron?, timezone?, sweepKinds?, enabled?, actMode?: false }`.
  - `delete`: `{ scheduleId }`.
- `scheduleWriteWidens(before: EffectiveSchedule, after: EffectiveSchedule): boolean` (pure, in `aiAgents/scheduleMerge.ts`): true if `after.enabled && !before.enabled`, or a kind in `after` is not in `before`, or `after.actMode && !before.actMode`.
- `updateSchedule` / `deleteSchedule` gain `opts?: { refuseArmedWidening?: boolean }`. When set, they run in one `db.transaction` that takes `FOR UPDATE` on the target row. They read the baseline (partner callers `FOR SHARE` in the same transaction; an org caller's plain read, see Quorum). They compute `effectiveSchedule` from persisted rows (not `resolveEffectiveScheduleActMode`, which is flag-gated). While the baseline's `actMode === true`, they throw `ScheduleValidationError` with the new code `armed_widening_refused` on a widening or on a `cron` / `timezone` change. Deleting a baseline is exempt: it stops every run.
- `scheduleDeleteDigest(args, database)`: pins `{ v: 1, scheduleId, ownerScope, ownerId, kind, agentId, cron, timezone, enabled, actMode, sweepKinds, overrides: [{ id, orgId, enabled, sweepKinds, actMode }] sorted by id }`. A missing row is `TARGET_ABSENT`.
- Errors map as the route's `mapScheduleError` codes into `{ error, code }`, including `override_exists`.

- [ ] Step 1: failing tests:
  - `create and update schemas reject actMode: true`; `update accepts actMode: false`;
  - `update of an armed schedule refuses anything that widens` (table: `enabled: true` on a disabled row, a wider `sweepKinds`, a new `cron`, a new `timezone`; `enabled: false`, `actMode: false` and a narrower `sweepKinds` pass);
  - `the guard reads persisted arming with the deployment flag off`;
  - `delete of a narrowing override under an armed baseline refuses` (table: override `enabled: false`, narrowed kinds, `actMode: false`); `delete of a no-op override passes`;
  - `creating an override with actMode null under an armed baseline is allowed`;
  - `a concurrent REST disarm is not overwritten` (the tool write waits on the target-row lock, then re-evaluates);
  - `REST behaviour is unchanged` (no opts: an armed-row widening still succeeds through the route, existing suite green);
  - `delete is four_eyes via resolveApprovalScope` and `requiresPinnedEffectDigest` is true;
  - `release after drift refuses` (an override added, or an override's `enabled` changed, between pin and release);
  - `an org-scoped caller creating a partner baseline is refused with the service's code`;
  - `a site-restricted partner admin is refused`.
- [ ] Step 2: run, expect FAIL. Confirm `effectDigestCoverage.contract` goes red once the class lands.
- [ ] Step 3: implement. Audit actions are the route's (`ai_agent.schedule.created|updated|deleted`) with `details.via: 'ai_tool'`, and `actMode` recorded as the route does.
- [ ] Step 4: expect PASS. Commit `feat(ai-tools): W16 schedule writes: no arming, armed schedules only narrow, four-eyes delete (#6786)`.

### Task 8 (PR B): auth-free Fleet Design targets

**Files:** Create `services/fleetDesign/applyTargets.ts` + test, `services/actionIntents/fleetDesignDigest.ts` + test.

**Interfaces — Produces:**
- `snapshotFleetDesignApplyTargets(reportRunId: string, approval: FleetDesignApproval, database): Promise<FleetDesignApplyTargets | null>`. No auth and no row lock. It covers:
  - the report's `orgId`; `sha256(canonical(outcome))` (the design revision); the canonical approval (each array deduped and sorted);
  - per approved function: the wanted device ids that still exist in the org, the reusable group's id and current members, and the current `deviceFunctionAssessments` for those devices;
  - per policy the apply will touch: id, owner (org or partner), status, assignments, and the `monitors` link's settings and inheritance mode;
  - ledger rows `(itemRef, status)`;
  - `(deviceId, deviceRole, deviceRoleSource, deviceFunctionSource)` for every named device;
  - `sha256` of each approved script's content;
  - the notification destinations the approved monitors reference.
  `null` when the run is not a Fleet Design report of an org.
- `snapshotFleetDesignRollbackTargets(reportRunId, database)`: the ledger's `applied` rows `(itemRef, itemKind, createdRefs, sha256(beforeImage))` in step order, plus the live state each would touch: device role and source, function assessment, group members, policy assignments, status and monitor snapshots.
- `fleetDesignApplyDigest` / `fleetDesignRollbackDigest` resolvers, `material(canonicalJson({ v: 1, … }))`. On a match, each returns release `context` carrying `{ digest }` (the existing resolver-to-dispatch mechanism).
- Shared helpers move out of `preview.ts` (`loadOrgDeviceIndex`, `loadGroupMemberDeviceIds`) only if needed, re-exported from their old paths.

- [ ] Step 1: failing tests:
  - `the snapshot agrees with preview for the same inputs` (wanted and removed device sets per function, role-correction targets, scripts), so the digest pins what the approver saw;
  - `digest changes when` (one case each): a named device leaves the org; a function group gains or loses a member; a policy gains an assignment; a policy's monitor-link inheritance changes; another apply records a ledger row; a device's role source becomes manual; a function assessment changes; a notification destination changes;
  - `digest is stable across approval array order and duplicates`;
  - `a partner-owned or non-Fleet-Design run is TARGET_ABSENT`;
  - `rollback digest changes when a ledger row changes, a device's role changes, or a policy gains an assignment`.
- [ ] Step 2: run, expect FAIL.
- [ ] Step 3: implement.
- [ ] Step 4: expect PASS. Commit `feat(api): W16 auth-free Fleet Design apply and rollback targets for digests (#6786)`.

### Task 9 (PR B): `manage_fleet_designs`

**Files:** Create `services/aiToolsFleetDesigns.ts` + test, `services/aiToolSchemasFleetDesigns.ts`. Create `services/fleetDesign/runLaunch.ts` + test: `launchFleetDesignRun(auth, { orgId, siteId? }, dedupeKey)` (the T2 result shape, moved from the route; the route calls it and keeps its audit and its 200 `{ success: false, skipped }`). Modify `services/toolExecutionContext.ts` (`verifiedFleetDesignBinding?: { digest: string }`, documented as the two sibling fields are). Modify `services/fleetDesign/rollback.ts` for the two tightenings below.

**Interfaces — Produces:**
- Tool input (`.strict()`): `{ action, orgId?, siteId?, reportRunId?, approval?: fleetDesignApprovalSchema }`. `run` needs `orgId`. Every other action needs `reportRunId`. `preview` and `apply` need `approval`.
- Every action refuses an `ai_agent` principal, a device-bound session, and a site- or device-restricted session. Gates as in the matrix. The `run` dedupe key follows T2 (`design-ai-tool-${actionIntentId}`).
- `apply` / `rollback`: no `selfManagedDbContext`, so both release paths and the chat wrapper hold one caller-scoped transaction. The handler refuses without `context.verifiedFleetDesignBinding` and `actionIntentId`. Inside the transaction, after `lockReportRun`, it recomputes the T8 snapshot digest and refuses on a mismatch (`code: 'CONTENT_CHANGED'`), writing nothing. The residual is stated in the PR: an independent edit after this re-check is an ordinary concurrent edit, and the ledger records what landed. Verify both release paths supply the binding (`aiAgentSdk.ts` inline path and `intentReleaseWorker.ts`). If the inline path cannot, add the tool to `DURABLE_RELEASE_ONLY_TOOLS` with its parity test.
- Result envelopes: full success `{ applied, skipped, rollbackAvailable }`. A blocked apply is `{ error, code: 'BLOCKED', blockers, unaccepted }`. A partial apply is `{ error, code: 'FLEET_DESIGN_PARTIAL', applied, skipped, failedStep, rollbackAvailable }`. A rollback with refusals is `{ error, code: 'ROLLBACK_PARTIAL', rolledBack, refused }`. Audit rows match the route's `fleet_design.apply|rollback|document.file` and `ai_fleet_design.run.manual_trigger`, with `details.via: 'ai_tool'`.
- `rollback.ts` tightenings, which apply to REST as well and go in the PR's Merge Danger: role rollback restores only while the current role equals the role this design applied (read from the ledger's refs). Policy rollback refuses `modified_since_apply` when the policy has assignments beyond the one this design created. Both use the existing refusal shape.
- The approval card for `apply` renders the preview: groups and device counts, policies, scripts, role corrections (marked billing-relevant), watches with `autoRestart` (named), already-applied refs.

- [ ] Step 1: failing tests:
  - `apply and rollback are four_eyes; run and document supervised; preview and applied tier 1` (via `resolveApprovalScope`);
  - `release after drift refuses` (each T8 drift class, against the pinned digest);
  - `a change after verification is refused under the lock` (binding digest ≠ recomputed digest: `CONTENT_CHANGED`, no ledger row);
  - `no binding is refused`;
  - `a blocked preview is refused at apply with the blockers, and nothing is written`;
  - `partial apply and partial rollback are error envelopes that keep their details`;
  - `automation refs without scripts:write are refused`; `rollback without scripts:write refuses only script rows`;
  - `document without contracts:write files the document and links no evidence` (the flag is passed explicitly);
  - `site-restricted session refused for every action`;
  - `foreign report run is the same not-found as a missing one`;
  - `design markdown, labels and blocker text are fenced`, with a control;
  - `role rollback leaves a later AI correction alone`; `policy rollback refuses when another assignment appeared`;
  - `route: every other fleet-design route behaviour unchanged` (existing suite green).
- [ ] Step 2: run, expect FAIL.
- [ ] Step 3: implement over T8 and the existing services. `designer/enable` gets no action.
- [ ] Step 4: expect PASS. Commit `feat(ai-tools): W16 manage_fleet_designs with four-eyes apply and rollback (#6786)`.

### Task 10 (PR B): wiring, index, golden, copy, coverage

As T4, for the PR B column, plus: register the two resolvers in `EFFECT_DIGEST_RESOLVERS` and the three per-action pins in `PINNED_EFFECT_DIGEST_REQUIRED_ACTIONS`. Add the `ORG_WIDE_GOVERNANCE_TOOL_ACTIONS` rows, and `MCP_TOOL_COUNT_APPROX` → 370 in its own commit.

Approval copy (exact):
- schedules `create`: "Schedule {kind} runs of {agent} {cadence} for {owner}. Each run uses AI credits and may notify people."
- schedules `update`: "Change {changedFields} on the {kind} schedule for {owner}."; with `enabled: false`: "Stop future {kind} runs for {owner}."; with `actMode: false`: "Stop unattended actions from the {kind} schedule for {owner}, including ones already waiting."
- schedules `delete`: "Delete the {kind} schedule for {owner}{, and every organization's override of it}. This cannot be undone."
- fleet `run`: "Run a Fleet Design for {org}{ at {site}}. It uses AI credits and may notify people; nothing is applied."
- fleet `apply`: "Apply Fleet Design {date} to {org}: {n} groups covering {d} devices, {p} monitoring policies, {s} scripts, {r} device role changes (billing){, and automatic restart for {names}}. Undo is available until the objects change."
- fleet `rollback`: "Undo Fleet Design {date} at {org}: remove {list} and restore {r} device roles (billing). Monitoring it added stops."
- fleet `document`: "File Fleet Design {date} in {org}'s documents{ and attach it to {deliverable}}."

- [ ] Step 1: add `W16B_EXPECTED` and route-binding rows (schedules POST/PATCH/DELETE; fleet runs, apply/preview, apply, rollback, applied, document).
- [ ] Step 2: add the entries; measure and replace the Budget column; run T4's sweep plus `actionIntents/effectDigestCoverage.contract`, `actionIntents/orgWideGovernanceCoverage.contract`, `actionIntents/intentApprovers.deviceTargets.contract`, `aiGuardrails.enforcementArming.contract`.
- [ ] Step 3: commit `feat(ai-tools): W16 PR B guard classes, index and docs (#6786)`.

### Task 11 (PR B): integration, merge `main`, PR

**Files:** Create `__tests__/integration/aiToolsAiDesignWrites.integration.test.ts`.

Cases, on a per-worktree stack:
- A baseline `create` released through the worker path succeeds for a full-partner admin. The same intent for a member whose access became `selected` fails, and no row is written.
- A four-eyes apply intent released after a device leaves the function's group refuses and writes no ledger row.
- A change committed after digest verification and before the handler's lock refuses (`CONTENT_CHANGED`).
- Two concurrent apply releases: one applies, the other finds `alreadyApplied` or refuses on the digest.
- A schedule delete released after an override changed refuses.
- An org caller's override cannot reach another partner's baseline (`baseline_wrong_partner`).
- An override delete blocked by a real `FOR UPDATE` held by a concurrent disarm re-evaluates and refuses.

- [ ] Step 1: run on a per-worktree stack; `pnpm test-stack down` after.
- [ ] Step 2: TS check, merge `origin/main`, re-run the sweep and re-measure.
- [ ] Step 3: PR with the class table, the three four-eyes sign-off lines, digest fields, budget, Merge Danger (two-way, no data change; REST unchanged except the two `rollback.ts` tightenings; the actor-context registry named). `Closes #6786`, `Part of #6754`.

## Contract traps (checked, so the implementer does not rediscover them)

- **User-owned release (`SAFE_WRITE_SITES`, line-keyed):** `USER_OWNED_RELEASE_ACTIONS` is applied only to agent-originated intents, so no entry is needed. The contract scans `aiTools*.ts` for `<prop>: auth.user.id`. Keep those writes in the extracted services where possible. If a handler line remains, add a `(b) agent-denied` `SAFE_WRITE_SITES` entry keyed by file and line, last in the PR.
- **Parked fan-out:** it discovers `services/` files only by Quick Support / ephemeral exclusion tokens, and `jobs/` files reading `devices`. `serviceRecoveryLaunch.ts` and `applyTargets.ts` read `devices` without those tokens, so they are not expected to be discovered. Run the contract anyway, and classify the file if it is.
- **Effect-digest coverage:** every four-eyes action needs a resolver or a written `DELIBERATELY_UNPINNED` reason. All three here have resolvers.
- **Arming scanner:** `aiGuardrails.enforcementArming.contract` does not recognise `actMode`, so T7's tests are the guard, not that contract.
- **Tier-1 write actions:** `manage_ai_agent_schedules` and `manage_fleet_designs` are tier-1 multiplexers, so every write action must be in `TIER3_ACTIONS` and the reads in `TIER1_READ_ACTIONS`.
- **Handler wrappers truncate `context`:** both new handler modules declare the third parameter directly (`aiTools.ts` `AiTool.handler` note).
- **Wisp subjects (#10834):** all four are classified non-focal (the W18 Decision 9 precedent; `reportRunId` and `scheduleId` have no subject kind).
- **`agentEditionCompat`:** not applicable. No Go agent or heartbeat change.

## Follow-ups (not filed)

- Act-mode arming from chat, if ever: its own four-eyes review beside `manage_ai_agents` (Decision 3B).
- Identity recipes from ordinary chat (Decision 4B).
- An agent-proposed Fleet Design apply (Decision 7 alternative), if a workflow appears.
- **To check, not established here:** `manage_org_portal_settings` (W18) requires partner scope and is not in a partner-axis release list, so a worker release of `set_sensitive_access` may fail closed once the requesting session has gone (read from the code, not reproduced). If T6's registry lands, that action may belong in it.
