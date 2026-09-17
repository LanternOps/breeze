---
title: Operator Recipe Library — Breeze-shipped MSP procedures, starting with employee offboarding and onboarding
date: 2026-09-17
status: draft for product and engineering review
baseline_commit: 59a94162c
scope: apps/api (aiOperator, m365ControlPlane, tickets), apps/m365-graph-actions-executor, packages/shared, apps/web
builds_on:
  - docs/superpowers/specs/ai-mcp/2026-09-07-ai-operator-completion-design.md
  - docs/superpowers/specs/integrations/2026-07-13-breeze-m365-control-plane-design.md
  - docs/superpowers/specs/integrations/2026-07-22-breeze-m365-customer-graph-actions-consent-design.md
related:
  - docs/superpowers/specs/ai-mcp/2026-09-07-tool-catalog-and-flows-design.md
---

# Operator Recipe Library

## Summary

- **Problem:** the AI Operator can own a durable task, wait without holding a process, and verify an outcome — but it ships exactly one recipe (`service_recovery`), targets only a device, and has no step a human performs. The most frequent multi-system MSP procedure, a person leaving or joining a customer, has no home in Breeze. Google Workspace has a single best-effort composite tool (`google_offboard_user`); Microsoft 365 can disable a user and reset a password and nothing else.
- **Proposal:** grow the Operator from one recipe into a **library** of Breeze-authored, versioned, code-owned recipes. This spec does not add an engine. It pulls forward the registry, steps, targets, and events the Operator completion spec already sketched (P3-2, P3-4), and adds the four things that spec does not have: a **person target**, a **human-work step**, a **plan approval**, and a **recipe gate class** for deterministic recipes.
- **First recipes:** `identity_offboarding`, then `identity_onboarding`, across Microsoft 365 and Google Workspace in one task. `email_provider_migration` is named as the later proof that human-work and long waits are first-class; it does not drive this design.
- **Critical path is the M365 write surface, not the engine.** Two write actions exist. Offboarding needs six more, a permission-profile version bump, and customer re-consent on every connected tenant (§7). Exchange Online has a declared profile and no executor (§7.3).
- **Boundary with Flows (#5215):** a Recipe owns an outcome and must prove it; a Flow owns a sequence and reports what each step returned (§3). This spec recommends both run on the `ai_operator_*` substrate; that recommendation changes an open feature and is raised as decision D1, not assumed.
- **Name:** "playbook" stays with the shipped device self-healing feature (`playbook_definitions`). The user-facing word here is **recipe**, as the Operator spec already decided (§3 there: "'Recipe' is the user-facing name for a supported workflow").
- **Not in scope:** tenant-authored recipes, a recipe DSL or graph executor, autonomous end-customer email, rollback of identity changes, DNS/registrar tooling, mailbox data migration.
- **Status:** draft. Nothing is implemented. Register the feature on approval.

## 1. Outcome and scope

A technician opens a ticket that says "Dana's last day is Friday", picks **Offboard a person**, confirms who Dana is and who inherits her mail, approves one plan, and the Operator carries it: revokes sessions, removes licenses and group memberships, sets forwarding and auto-reply, retires her phone, suspends or disables the accounts last, asks the technician to collect the laptop, verifies each effect against the provider, and leaves a completion record on the ticket. If the browser closes, a worker restarts, the approval lands Monday, or the cutoff is scheduled for 5 pm Friday, the task still owns the work.

In scope:

1. A code-owned recipe registry and the refactor that makes the coordinator dispatch on `workflow_key`.
2. `ai_operator_task_steps`, `ai_operator_task_targets`, `ai_operator_task_events` (Operator spec §11), with a new `contact` target class.
3. A human-work step bound to ticket checklist items.
4. A plan approval: one four-eyes decision over an ordered, digest-pinned effect set.
5. The M365 identity write catalog and per-action verification probes.
6. The `identity_offboarding` and `identity_onboarding` recipes, their web surface, and their release gate.

Out of scope, with the reason:

| Excluded | Why |
|---|---|
| Tenant-authored recipes, recipe DSL | Operator spec §2.1 and §11 preamble: "No generic graph or arbitrary instruction executor is introduced." Tenant-authored procedures are Flows. |
| Rollback | Operator spec §7.3: cancel is not rollback. A half-reversed identity is worse than a stopped one. The recipe orders effects so stopping is safe (§6.3). |
| Emailing the departing user or end customers autonomously | Operator spec excludes autonomous customer sending until its own gate. Auto-reply text is a plan argument the technician approves. |
| DNS, registrar, mailbox data migration | No tooling exists; belongs to the later migration recipe and is reached through `tool_sources` or human-work steps. |
| Retiring `playbook_definitions` | Recommended (§10) but a separate change with its own migration of three built-ins. |

## 2. What exists, verified at `59a94162c`

| Piece | State |
|---|---|
| `ai_operator_tasks`, `ai_operator_operations`, `ai_operator_task_outbox`, coordinator, reconciler, outbox publisher, routes, task page | Built (P3-0, P3-1). Flag-off: `AI_OPERATOR_TASKS_ENABLED`. |
| Recipes | One: `services/aiOperator/recipes/serviceRecovery.ts`. "A recipe is DATA plus pure validators… It owns NO I/O." |
| Recipe registry | None. `workflow_key` is stored and never dispatched on. `taskCoordinator.ts` imports service-recovery constants directly and switches on the step-key string; `taskService.ts` hardcodes the workflow key at admission. |
| `_task_steps`, `_task_targets`, `_task_events`, `ai_operator_workflows` | Specified (Operator spec §11), unbuilt, and unregistered: feature #5205 closed after the thin slice; P3-2…P3-5 have no issues. |
| Task target | One inline nullable `device_id` with detach semantics. No non-device target. |
| Human wait | `information` wait, `wait_dependency_kind = 'user_answer'`, and outbox `source_kind = 'user_answer'` exist. No answer surface; no checklist linkage. |
| `maintenance_window` wait reason | In the CHECK list, no writer. |
| Ticket checklists | Built: `ticket_checklist_items` (`source ∈ manual, deliverable, checklist_template`, `done_at` authoritative, `done_by_user_id`), partner-wide templates, `apply-template` callable by a non-interactive principal. Completion is human-only: `patchChecklistItem` stamps the acting user. |
| Person entity | `contacts` (Shape 1, real columns, exportable) and `contact_external_links (org_id, system, external_id)`. `m365_users` is synced by tenant sync. No Google directory sync table. |
| M365 writes | `M365_WRITE_ACTION_IDS = ['m365.user.disable', 'm365.user.reset_password']`. Profile `customer-graph-actions` v1 holds `User.ReadWrite.All`, `User-PasswordProfile.ReadWrite.All`; its roadmap comment names the scopes later actions need and states each needs a version bump and customer re-consent. |
| Exchange Online | Profile `customer-exchange-powershell` declared; no executor app, no code path. |
| Google writes | 20 granular Tier-3 tools, all headless-capable, all four-eyes. `google_offboard_user` is a seven-effect best-effort composite returning one `offboard_incomplete` string on partial failure. |
| Agent authority | The Operator has no agent kind. A task runs as the admitting agent (`triage`, `patch`, `helpdesk`, `designer`) and inherits its `toolAllowlist` and policy snapshot. One live agent per (owner, kind). |
| Flows (#5215) | W01 (`tool_sources`) merged. No `flows`, `flow_runs`, runner, or validator exists. W02–W06 open. |

## 3. Recipes, Flows, playbooks: one boundary

Flows' motivating use case is "user onboarding and offboarding across M365, the PSA, the RMM, documentation, and MFA", and its non-goals argue against "AI playbooks" where every run is an LLM run. Neither spec mentions the other. This one does.

> **A Recipe is Breeze-authored code that owns an outcome and must prove it with a verification adapter. A Flow is tenant-authored data that owns a sequence and reports only what each step returned. If it can fail verification, hand off, or outlive a worker, it is a Recipe; if the tenant may edit it, it is a Flow.**

Offboarding is a Recipe because its failure mode is a former employee who can still sign in. That is an outcome claim, and it needs a probe, a frozen authority ceiling (Operator spec §7.1), per-effect operation identity (§6.5), and handoff on unknown effect. Flows caps a run at one hour, fails a run on an unknown Tier-2/3 outcome, has no verification adapter, no human step, and runs under a standing enable-time principal; a Breeze-shipped identity-destruction library must not run on a standing partner-wide delegation.

The Flows objection is answered by construction, not by argument: **a recipe is a deterministic spine.** The model never chooses an effect. It is used where judgment is real (§6.2) and nowhere else, which is how `serviceRecovery.ts` is already built (the model may propose `execute` from `investigate`; the coordinator drives everything after).

| | Recipe | Flow | Playbook (shipped) |
|---|---|---|---|
| Author | Breeze, in code | Tenant, AI-drafted | Breeze built-ins only |
| Target | Device, contact, ticket | Whatever its tools touch | One device, NOT NULL |
| Proves outcome | Yes, verification adapter | No | `verify` step, device-only |
| Horizon | Days to weeks | ≤ 1 h | Minutes |
| Human-work step | Yes | No | No |
| Authority | Frozen at admission, re-checked per dispatch | Standing flow principal | System |

**D1 (raised, not assumed):** Flows W04 should not create a second run/step/wait/approval substrate. The Operator's is built and tested; Flows' does not exist yet, so convergence costs a spec edit today and a migration later. Proposed wording for the Flows spec: W04's runner composes `ai_operator_*` with a `definition_source` of `flow`. This spec does not depend on D1 and does not edit the Flows spec.

## 4. Product model

Terms are the Operator spec's. Additions in bold.

- **Recipe** — code: step keys, permitted model proposals, input schemas, effect catalog, verification criteria, bounds, **gate class**, **required capabilities**.
- **Library** — the registry of recipes plus server-computed readiness per org (`GET /api/v1/ai/operator/workflows`, Operator spec §12).
- **Task** — one admitted run of a recipe against frozen targets.
- **Target** — a row in `ai_operator_task_targets`. **New class: `contact`.**
- **Step** — a row in `ai_operator_task_steps`. **New kind: `human_work`.**
- **Plan** — the ordered effect set the task will dispatch, with pinned arguments. **New: approved as one unit (§6.4).**
- **Operation** — one external effect with a permanent operation key (unchanged).

### 4.1 Readiness

A recipe appears in the library for an org only as one of: `ready`, `setup_required` (with the missing capability named), `unavailable`. Readiness is computed from rows, never from a model: connection status, `permission_manifest_version` against the profile version, `observed_grants` against the recipe's required app roles, tool-source health, and the admitting agent's allowlist. A tenant that has not re-consented sees **setup required: re-consent Microsoft 365**, not a failed task. This is the Operator spec's §4 availability rule applied per capability.

`setup_required` means something the tenant can fix. A capability the product does not have yet (the Exchange Online effects before M2) is classed `always_manual`: it never blocks `ready`, and the card says how many steps will be done by hand.

Offboarding degrades by provider, not as a whole: an org with Google ready and M365 on the v1 profile can run the recipe with the M365 effects beyond disable/reset rendered as human-work steps (§6.5).

## 5. Data model

All new tables: Shape 1, `org_id NOT NULL` immutable, ENABLE + FORCE RLS with the four `breeze_org_isolation_*` policies in the creating migration, `text` + CHECK (never pgEnum — Operator spec §11.1), composite `(x, org_id)` FKs `DEFERRABLE INITIALLY IMMEDIATE`, partial-index predicates as literals. Registration in the same PR: `CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_TENANT_EXPORT_POLICY` (every jsonb → `excludedOpen`), org-merge classification, and — for anything with `ticket_id` + denormalized `org_id` — `TICKET_ORG_DENORMALIZED_TABLES` and `CUSTOM_ORG_REWRITE_TABLES` in the same relative order.

This spec adopts the Operator spec §11 column lists for steps, targets, and events and states only the deltas.

### 5.1 `ai_operator_task_targets` — delta: the contact class

```
target_kind        text NOT NULL  CHECK in ('device','ticket','contact')
device_id          uuid NULL      -- ON DELETE SET NULL
ticket_id          uuid NULL
contact_id         uuid NULL      -- ON DELETE SET NULL; composite (contact_id, org_id) → contacts(id, org_id)
target_label       text NOT NULL  -- frozen display label
target_ordinal     int  NOT NULL
state              text NOT NULL
detached_at / detached_reason     -- existing reason list; 'scope_invalidated' covers a merged/deleted contact
-- device_id / ticket_id are PLAIN FKs (Operator spec §11.3); only contact_id is composite. On a device or ticket org-move and on org merge the target is DETACHED, never re-stamped: contacts are repointed by org merge, so the task fence must detach in the merge's resolve phase, before the move phase. Any later table referencing a contact does the same.
CHECK exactly one of (device_id, ticket_id, contact_id) is set, or the row is detached
```

Provider accounts are **not** target rows. They are frozen facts about the contact target:

### 5.2 `ai_operator_task_target_accounts` — new

```
id, org_id, task_id, target_id
provider           text CHECK in ('m365','google')
connection_id      uuid            -- the m365_connections / google_workspace_connections row, same-org composite FK
external_id        text NOT NULL   -- Entra object id / Google user id: immutable, never the UPN
principal_label    text NOT NULL   -- UPN / primary email at admission, display only
UNIQUE (org_id, task_id, provider)
```

**D2 — the person is a `contacts` row.** Alternatives considered: target `m365_users` directly (no Google equivalent exists, and a person with two accounts would be two targets); a new `org_identities` table (duplicates `contacts`, which already carries `contact_external_links (org_id, system, external_id)` built for exactly this re-identification problem). A contact is customer data, org-scoped, exportable, and is what a ticket requester already resolves to. Admission resolves or creates the contact, upserts `contact_external_links` with `system ∈ ('m365','google')`, and freezes the external ids onto the task. Every dispatch addresses the account by `external_id`; a rename mid-task cannot retarget an effect. Onboarding creates the contact first and gains its external links as accounts are created.

This is the hard-to-reverse choice in the spec.

### 5.3 `ai_operator_task_steps` — delta: step kind and human work

```
step_kind          text NOT NULL CHECK in ('reason','effect','probe','wait','human_work','document')
checklist_item_id  uuid NULL     -- human_work only; composite (checklist_item_id, org_id) → ticket_checklist_items
```

And on `ticket_checklist_items`: a fourth `source` value `operator_task`, and a nullable `operator_step_id`. The link has ONE owning FK: `ai_operator_task_steps.checklist_item_id` is a plain single-column FK, `ON DELETE SET NULL`; `ticket_checklist_items.operator_step_id` is provenance with no FK, the same rationale as `source_template_item_id`. A composite `(checklist_item_id, org_id)` FK is not possible: `ticket_checklist_items.org_id` is re-stamped by both ticket org-movers while a step's `org_id` is immutable, so a composite FK would abort every ticket org-move with 23503. The movers and the org-merge fence detach the link by hand. `source` is a pgEnum; the new value is added by `ALTER TYPE … ADD VALUE IF NOT EXISTS` in its own migration, sorted ahead of any file that uses it (a new enum value cannot be used in the transaction that adds it; no `-- @no-transaction` needed). Steps also carry `remind_after_at` and `reminded_at`. A task has no ticket column: its ticket is a `ticket` target row.

### 5.4 `ai_operator_plan_approvals` — new

```
id, org_id, task_id
plan_revision      int  NOT NULL          -- = ai_operator_tasks.revision at proposal
effect_set_digest  char(64) NOT NULL      -- SHA-256 over the canonical ordered effect list (§6.4)
intent_id          uuid NOT NULL          -- the single action intent carrying the approval
state              text CHECK in ('pending','approved','rejected','expired','superseded')
UNIQUE (org_id, task_id, plan_revision)
```

### 5.5 `ai_operator_tasks` — deltas

`workflow_config_id` (nullable, for P3-5), and nothing else: the inline `device_id`/`target_label` columns are migrated to a target row and kept as a read projection until P3-5 removes them. `accounting_root_task_id` already exists and becomes the budget root for a task and its successors.

Adding columns to `ai_operator_tasks` re-fires `CORE_TENANT_EXPORT_POLICY`; the completion record (§6.6) is bounded `text`, not jsonb, so it survives export.

## 6. Recipe contract and execution

### 6.1 Registry

```ts
interface RecipeDefinition<Input> {
  key: string; version: number; promptVersion: string;
  gateClass: 'deterministic' | 'model_chooses_effect';   // §9
  targetKinds: readonly TargetKind[];
  requires: readonly CapabilityRequirement[];            // readiness, §4.1
  inputSchema: z.ZodType<Input>;
  steps: Record<StepKey, StepDefinition>;
  permittedNextSteps: Record<StepKey, readonly StepKey[]>; // what the MODEL may propose; sparse
  bounds: RecipeBounds;                                  // stricter than policy, never looser
  crossCheckStepInputs?(stepKey, proposedInputs, frozenInput): CrossCheckResult; // pure; pinned-argument check (service_recovery's frozen serviceName)
  buildPlan(input: Input, facts: DiscoveryFacts): PlannedEffect[];   // pure; DiscoveryFacts is an opaque readonly record until R1 produces it
  operationKey(args): string;                            // delegates to buildTaskOperationKey
}
```

`RECIPES: Record<string, RecipeDefinition>` lives in `services/aiOperator/recipes/index.ts`. `taskService` admission and `taskCoordinator.advanceTask` look the recipe up by `(workflow_key, workflow_version)`; an admitted task keeps its version for life (P3-4: "freeze recipe versions for admitted tasks"). Recipes stay pure: no I/O, no imports from services. `service_recovery` is ported first, behavior-identical, as the refactor's regression proof.

Step execution by kind is coordinator code, not recipe code:

| Kind | Coordinator does | Wait |
|---|---|---|
| `reason` | enqueue a bounded agent run; validate its `submit_task_step` output against the recipe | `information` / run |
| `effect` | reserve operation → pre-write probe → mint or attach intent → dispatch via release worker | `approval`, then `execution` |
| `probe` | run the verification adapter | `verification_window` |
| `wait` | write `next_wake_at` | `maintenance_window` |
| `human_work` | create or attach checklist item | `information` / `user_answer` |
| `document` | write the completion record | terminal |

### 6.2 Where the model is used

Only in `reason` steps, and only to produce data the server validates:

1. **Intake** — resolve "Dana in accounting" to a contact and its provider accounts; ask when ambiguous. Output is candidate ids; the technician confirms.
2. **Discovery synthesis** — from deterministic reads (licenses, group memberships and ownerships, mail delegates, forwarding, enrolled mobile devices), flag what a fixed list cannot: sole owner of a group or Team, a license whose removal orphans a shared mailbox, a service account that looks like a person.
3. **Exception triage** — when a probe fails, classify retry / human-work / handoff within the recipe's permitted set.
4. **Completion narrative** — prose over the event timeline; facts come from rows.

The model never proposes an effect that `buildPlan` did not produce, never edits plan arguments, and never marks anything done. Discovery reads are coordinator-issued tool calls, not model-chosen. Two read gaps at this baseline: there is no M365 group-ownership read action, so M365 ownership is `unknown` and any such group the plan touches becomes human-work (follow-up: `m365.group.owners.list`); and Breeze has no device-to-person link — only the agent-reported `devices.last_user` string — so matching devices are a suggestion in the start form, never an effect target, and hardware is always human-work. When the plan keeps the mailbox, `m365_remove_license` is omitted from the plan entirely and replaced by a manual conversion item, so the mailbox deletion clock never starts.

### 6.3 `identity_offboarding` spine

```
intake (reason) → confirm_identity (human_work: technician confirms contact + accounts + inheritor)
→ discover (probe reads, both providers) → review (reason: exceptions) → plan_approval (§6.4)
→ wait_cutoff (wait, optional: scheduled last-day time)
→ per provider, in this order, each = pre-probe → effect → post-probe:
     1 auto-reply            4 remove group memberships     7 retire/selective-wipe mobile
     2 mail forwarding       5 remove licenses*             8 revoke sessions / sign out
     3 mailbox delegate      6 revoke app tokens            9 disable (M365) / suspend (Google) — LAST
→ device steps (Breeze agent: lock or log off, flag for collection)
→ human_work: collect hardware, transfer file ownership, update documentation, anything rendered manual by readiness
→ verify_outcome (probe: account cannot sign in; no licenses; no memberships) → document
```

Ordering is a recipe-owned, tested safety contract, lifted from the comment in `googleOffboardUserAction`: mailbox effects run while the account is active because suspension blocks Gmail impersonation, and disable/suspend is last so that **a task stopped at any point leaves an account that is more restricted than before, never one that is disabled with mail unrouted.** *On M365, license removal is gated on shared-mailbox conversion being confirmed when the plan keeps the mailbox (a human-work step until M2): removing the Exchange license first starts the mailbox's deletion clock.

`google_offboard_user` is **not** called by the recipe. One tool call with seven effects has one operation key: a replay re-runs all seven and "3/7 OK" has no per-effect result row. The recipe dispatches the granular tools (`google_set_vacation`, `google_set_forwarding`, `google_add_mail_delegate`, `google_remove_from_group`, `google_remove_license`, `google_signout`, `google_suspend_user`), which are already registered, Tier 3, and headless-capable. **The mobile step is the exception: `google_wipe_mobile_device` is a full factory reset (`admin_remote_wipe`) and its own description says it is not for offboarding. The selective corporate-account wipe (`admin_account_wipe`) is reachable today only inside the composite, so R1 adds a granular `google_account_wipe_mobile_device` tool and the recipe never plans the factory-reset one.** The composite stays for chat use; deprecating it is a follow-up.

`identity_onboarding` is the mirror with one inversion: account creation is first, and the temporary credential is secret-bearing (the `reset_password` sealing path). Its human-work steps are hardware assignment and first-login handover.

### 6.4 Plan approval

Every mutating Google and M365 tool is `TIER3_FOUR_EYES`. Nine effects across two providers is up to eighteen approvals per leaver; nobody will use that. Flows forbids pre-approving four-eyes tools and the Operator spec has no plan-level approval, so this is new and is designed explicitly.

- `buildPlan` produces an ordered list of `PlannedEffect { ordinal, toolName, provider, targetId, accountExternalId, canonicalArguments }`, `provider ∈ breeze | m365 | google`. `accountExternalId` is null for a `breeze` effect (a device command names its target row, not a provider account).
- `effect_set_digest` = SHA-256 over the canonical serialization of that list (same canonicalizer as `action_intents.arguments`).
- One action intent is minted with tool name `operator_plan`, Tier 3, four-eyes, whose immutable arguments are the digest, the task id, the plan revision, and a bounded human-readable rendering of every effect. The approval card shows the full list, per provider, with the target's frozen labels.
- On approval, each effect's operation is dispatched under the plan approval: the release path accepts an effect **only if** `(task_id, plan_revision, ordinal, argument_digest)` is a member of the approved set. Membership is checked at release, against rows, after the usual revalidation.
- Any change — a discovered group, an edited forward address, a provider dropping to human-work — bumps `revision`, supersedes the approval, and requires a new one. "Existing approvals only authorize their pinned arguments" (Operator spec §7.1) is preserved: the unit of pinning is the set.
- Expiry, requester-cannot-self-approve, and sole-operator step-up self-approval are inherited from action intents unchanged.
- Secret-bearing effects (onboarding's temporary password) are excluded from plan approval and keep their individual intent.
- Per-effect audit is not lost: each operation still writes its own `ai_operator_operations` row, event, and audit entry, attributed to the plan approval's approver.

`createActionIntent` gains an allowlist ceiling: neither the plan intent nor a child effect may name a tool the admitting agent's frozen snapshot does not allow, checked at mint and again at release. This is new work — PR #6110's ceiling is a *site* ceiling and never reads `toolAllowlist`.

Child effects are minted as action intents decided `plan_approval`, so the durable release worker, audit trail, intent-id idempotency, and secret handling are reused. That requires one deliberate loosening: a task-linked intent today requires an agent run; E4 permits `task` context for a non-agent principal only when accompanied by a plan approval whose rows and the task's live revision prove membership. Supersession is judged by the task's live `revision`, not the approval row's state. `operator_plan` also gets an `EFFECT_DIGEST_RESOLVERS` entry that re-hashes the effect rows at release. **This branch, and that `revalidateRelease` never grows a blanket `plan_approval` system-decided arm, gets an independent adversarial review before E4 merges (D6).**

### 6.5 Human-work steps

A `human_work` step creates a `ticket_checklist_items` row (`source = 'operator_task'`, `operator_step_id` set) on the task's ticket and yields to `waiting(information)` with `wait_dependency_kind = 'user_answer'`, dependency id = the checklist item id. `patchChecklistItem` setting `done_at` writes a task outbox row (`source_kind = 'user_answer'`) in the same transaction; the wake handler re-reads the item. Evidence is the completing user id and timestamp — never model-graded free text. Un-checking an item after the task advanced writes an event and does not rewind.

Consequences: a task with human-work steps requires a ticket (admission creates one if absent — "do not create a second ticket queue" holds, the ticket is the business record); the technician works from the ticket they already have; and a provider capability that is not ready degrades to a checklist item with generated instructions instead of blocking the recipe. `patchChecklistItem` stays human-only: the Operator creates items and never completes them.

Reminders: a human-work step past its `remind_after` writes a ticket comment and a notification; past the task deadline the task hands off, it does not fail.

### 6.6 Idempotency and verification

There is no executor-side dedup store and neither Graph nor the Google Directory API takes an idempotency key. Every effect is therefore **probe → write → probe**:

- Pre-write probe observes the desired end state ("already not a member"). If true, the operation settles `succeeded` with `result.noop = true` and no write is dispatched. Replay is a no-op by observation.
- Post-write probe is the verification adapter. Success of the write call never implies success of the effect (Operator spec §13: "Failed/inconclusive verification cannot produce 'Resolved'").
- Per-action classification, stated in the action's definition: `idempotent` (group remove, license remove, disable, revoke sessions), `idempotent_by_probe` (forwarding, auto-reply), `non_idempotent` (create user, reset password — never auto-retried; unknown effect → handoff).
- Some effects have no observable end state (`google_signout`: the Directory API exposes no session-validity field; `m365.user.reset_password`). A recipe declares such an effect `unobservable` and names the outcome criterion that subsumes it (a verified suspend makes live sessions moot). Its probe result stays `unknown` and the completion record says "dispatched, not independently verifiable".
- Task outcome `verified_resolved` requires the final `verify_outcome` probe plus a `satisfied` post-probe for every observable effect. An `unknown` on an observable effect, or an unsubsumed unobservable one, is `partial` with the unverified effects listed.

The completion record is bounded text written at `document`: target labels, each effect with its result and approver, each human-work item with its completer, unresolved items, and total cost. It is posted as an internal ticket comment and is the evidence artifact for service deliverables.

### 6.7 Bounds

Identity recipes: deadline 14 days (the Operator default is 72 h; `service_recovery` is 24 h), reasoning runs ≤ 6, one active target, mutation attempts ≤ 2 per effect, cost ceiling in the agent policy `limits` (a policy snapshot version bump in E2 — the Operator spec's "9→10" is stale; the version is 13 at this baseline, so E2 takes it to 14). Waiting tasks consume no run concurrency. The migration recipe will need a separate long-horizon budget class and a check that `ai_operator_tasks_wake_idx` still plans well with weeks-old waiting rows; that is recorded here and deferred.

### 6.8 Authority

**D3 — no new agent kind.** Identity recipes are admitted under the org's or partner's `helpdesk` agent. Its `toolAllowlist` must include the identity tools for the recipe to be `ready`; enabling the recipe in the library offers to add them, which is an agent policy edit with the existing review. This respects "do not multiply policy rows to create workflow names" and the one-live-agent-per-kind index. The recipe narrows that policy (only the tools in its effect catalog, only the frozen accounts) and never widens it.

## 7. M365 write catalog

The two M365 specs that froze the catalog at two actions named this work as deferred. Action ids follow the control-plane spec's `m365.<domain>.<object>.<verb>` convention; all are Tier 3, four-eyes.

### 7.1 Graph actions (wave M1)

| Action id | Graph call | App role | Class |
|---|---|---|---|
| `m365.user.revoke_sessions` | `POST /users/{id}/revokeSignInSessions` | `User.ReadWrite.All` (held) | idempotent |
| `m365.user.license.remove` | `POST /users/{id}/assignLicense` (removeLicenses) | `User.ReadWrite.All` (held) | idempotent |
| `m365.user.license.assign` | same (addLicenses) | `User.ReadWrite.All` + `Organization.Read.All` (seat pre-read) | idempotent_by_probe; fails closed on no available seat |
| `m365.group.membership.remove` | `DELETE /groups/{gid}/members/{id}/$ref` | `GroupMember.ReadWrite.All` | idempotent |
| `m365.group.membership.add` | `POST /groups/{gid}/members/$ref` | `GroupMember.ReadWrite.All` | idempotent |
| `m365.intune.device.retire` | `POST /deviceManagement/managedDevices/{id}/retire` | `DeviceManagementManagedDevices.PrivilegedOperations.All` | idempotent; retire only — full wipe is excluded |
| `m365.user.create` | `POST /users` | `User.ReadWrite.All` (held) | non_idempotent, secret-bearing |
| `m365.user.mailbox.auto_reply` | `PATCH /users/{id}/mailboxSettings` | `MailboxSettings.ReadWrite` | idempotent_by_probe |

`GroupMember.ReadWrite.All` is chosen over the roadmap comment's `Group.ReadWrite.All`: the recipe never creates or deletes groups, and least privilege is the consent story. Role-assignable and dynamic-membership groups are detected at discovery and rendered as human-work. Verify each app-role GUID against Microsoft's published list when implementing; do not copy from this table.

Probes run on the read executor, with one exception: the read profile holds no `MailboxSettings.Read`, and adding it would force a second re-consent on a second app registration, so the auto-reply probe is a read-only arm on the actions executor. Session revocation has no directly observable end state; its criterion is `signInSessionsValidFromDateTime ≥` the effect's request time, and anything else is `unsatisfied`, never assumed. The new tools are session-only like `m365_disable_user` (the agent tool catalog's contract test makes `m365ToolTiers` membership and agent-reachable registry membership mutually exclusive); recipes reach them through action intents and the release worker's headless map, not through the model. One offboarding is roughly nine writes in a minute, so the per-connection write budget (10/min, 100/day) rises to 30/min, 300/day — a safety-limit change called out for review. `consent_upgrade_required` is returned only when grants have been authoritatively observed, so a never-reconciled v1 connection keeps its two v1 actions.

Each action touches, in one PR: `packages/shared/src/m365/writeActions.ts` (id list, schema arm, **result arm**), executor `writeActions.ts` case, a probe in the read executor, `m365ToolTiers`, `TOOL_TIERS`, `aiGuardrails` four-eyes list and RBAC map, `M365_HEADLESS_ACTIONS` (parity test), `secretBearingTools.ts` where applicable, the approval-card verb map, `routes/approvals.ts M365_MUTATION_TOOLS`, `intentReleaseWorker`, mobile approvals, and the tests that enumerate the id list. The tools are useful from chat on their own and ship independently of any recipe.

### 7.2 Consent migration

Profile `customer-graph-actions` goes to **v2** once, with all M1 roles, not once per action. `connectionNeedsConsentReconciliation` then reports every existing connection as needing re-consent. Requirements:

- A v1 connection keeps working for the two v1 actions. Re-consent is an upgrade, not an outage.
- The M365 settings card shows what v2 adds in plain language and what each permission is used for.
- Recipe readiness reads `observed_grants` per required role, so partial consent degrades per effect (§4.1).
- A partner-level view lists connections still on v1.

### 7.3 Exchange Online (wave M2)

Shared-mailbox conversion, mailbox forwarding (`Set-Mailbox -ForwardingSmtpAddress`), full-access delegation, and litigation hold have no Graph API. `customer-exchange-powershell` is a declared profile with no executor. M2 is a new executor app with its own spec. Until it ships these are human-work steps with generated instructions, which is also the first real exercise of §6.5. Offboarding is shippable without M2.

## 8. API and web

Operator spec §12 surface, no new route family:

- `GET /api/v1/ai/operator/workflows` — library with per-org readiness and missing capabilities.
- `POST /api/v1/ai/operator/task-drafts` → intake; `POST /tasks` with `clientIdempotencyKey`. One live task per `(contact, recipe)` is enforced at admission, serialized per contact; the contact lives on the target row, so this is an admission check in the same transaction as the insert, not an index on `ai_operator_tasks`.
- `GET /tasks/:id` gains `steps`, `targets`, `events`, `plan`.
- `POST /tasks/:id/plan/approve` is not added: approval is the action intent, through `/approvals` and mobile.

Web: a **Library** tab in the Operator workspace (cards with readiness), a start form launched from a ticket or a contact, and the task page extended with the step list, the plan, and the timeline. Mutations go through `runAction`. Selected step/tab state uses `window.location.hash`. New strings need real translations in every locale.

## 9. Release gates

The Operator spec's §13 gate (≥ 50 evaluated cases, ≥ 10 failure/unknown/wait cases, zero false verified-success) is calibrated for recipes where a model chooses a remediation. Applied unchanged it would block a deterministic recipe for no safety gain. Recipes declare a gate class:

| Class | Applies when | Gate |
|---|---|---|
| `model_chooses_effect` | model output selects or parameterizes an effect | Operator spec §13 unchanged |
| `deterministic` | every effect comes from `buildPlan`; model output is only ids, flags, and prose, all server-validated | (a) contract test per effect: pre-probe, write, post-probe, replay-is-noop, against recorded provider fixtures; (b) ordering test: stopping after any step leaves no disabled-with-unrouted-mail state; (c) plan-approval membership tests incl. revision supersede; (d) ≥ 20 evaluated intake/discovery cases with zero wrong-person resolutions accepted without human confirmation; (e) zero unauthorized or duplicate effects in a lab run against a real M365 developer tenant and a real Google Workspace test domain; (f) own flag, `AI_OPERATOR_RECIPE_IDENTITY_OFFBOARDING_ENABLED` |

Both classes keep: own flag, zero false verified-success, metrics before enablement.

## 10. Waves

| Wave | Content | Depends on |
|---|---|---|
| **E1** | Recipe registry + coordinator dispatch refactor; port `service_recovery`. No schema. | — |
| **E2** | `_task_targets` (incl. `contact`), `_task_target_accounts`, `_task_steps`, `_task_events`; migrate inline target; policy snapshot 13→14. This *is* Operator P3-2 with the deltas in §5. | E1 |
| **E3** | Human-work step + checklist linkage; `maintenance_window` writer. | E2 |
| **E4** | Plan approval. | E2 |
| **M1** | M365 Graph write catalog + probes + profile v2 + consent UX. | — (parallel with E1–E4) |
| **R1** | `identity_offboarding` recipe, library + task UI, gate. | E3, E4, M1 |
| **R2** | `identity_onboarding`. | R1 |
| **M2** | Exchange Online executor (own spec). | — |
| later | `email_provider_migration`; retire `playbook_definitions` into recipes. | R1, M2 |

E1–E4 and M1 are high blast radius (tenancy, auth, approvals): full rigor, integration suites, one independent review each. **D4:** register this as a new feature whose E2 wave is declared to be Operator P3-2, rather than reopening closed #5205; note it on #5205 so the unregistered P3-3…P3-5 work has a pointer.

## 11. Risks

| Risk | Mitigation |
|---|---|
| Wrong person offboarded | Human confirmation step is mandatory and not skippable by policy; effects address immutable external ids; the plan card shows frozen labels per provider. |
| Half-offboarded identity | Recipe-owned ordering with disable/suspend last; ordering test in the gate; stopped tasks hand off with the remaining plan listed. |
| Plan approval becomes a four-eyes bypass | Set is digest-pinned; membership checked at release from rows; any deviation supersedes; secret-bearing effects excluded; ceiling check at `createActionIntent`. |
| Re-consent stalls adoption | v1 keeps working; per-effect degradation to human-work; partner view of v1 connections. |
| Replay duplicates an effect | Probe-before-write; permanent `(org_id, task_id, operation_key)` index; non-idempotent actions never auto-retried. |
| Two engines diverge further | D1. |
| Cascade / export / merge registration missed | Treated as a mechanical grep per table in each wave's checklist; both contract suites run before PR. |

## 12. Decisions for review

- **D1** — Flows W04 composes the `ai_operator_*` substrate instead of building `flow_runs`. Recommend yes; changes open feature #5215.
- **D2** — The person target is a `contacts` row with provider accounts frozen on the task. Recommend yes; hardest to reverse.
- **D3** — No new agent kind; identity recipes run under `helpdesk`. Recommend yes.
- **D4** — New feature, E2 = Operator P3-2, pointer left on #5205. Recommend yes.
- **D5** — Intune: retire only, never full wipe, in the first catalog. Recommend yes.
- **D6** — E4 loosens `createActionIntent`'s task-context rule for plan-approved effects. Requires an independent adversarial review (Opus or Codex `xhigh`) of that branch before merge.

## 13. Review history

- 2026-09-17 — Drafted by Claude at Todd's request. Duplicate check against `origin/main` specs, plans, and issues: no spec covers employee lifecycle; overlaps are the Operator completion spec (built on) and Flows #5215 (boundary in §3). Independent advisor pass (Opus; Codex was out of usage until 09-19) concurred on building on the Operator substrate and contributed the plan-approval primitive, the gate class, and probe-before-write; the `contacts` target (D2) is the author's and was not reviewed by the advisor.
