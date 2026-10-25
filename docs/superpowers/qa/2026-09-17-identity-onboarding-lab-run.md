# `identity_onboarding` lab run — release gate evidence (spec §9)

> **THIS CHECKLIST HAS NOT BEEN RUN. EVERY ROW BELOW IS `TODO`. Clause (e) of the release gate is BLOCKED until Todd (the operator) fills it in by hand on a non-production lab rig. Do not enable `AI_OPERATOR_RECIPE_IDENTITY_ONBOARDING_ENABLED` in any environment until every row is PASS.**

This is the evidence document for spec §9's `deterministic` gate on the Operator Recipe Library's `identity_onboarding` recipe (feature #6165, wave #6172, PR R2c). Clauses (a)–(d) and (f) are automated tests that run on mocked providers and real Postgres; the gate summary below lists them. This checklist is clause (e), **zero unauthorized or duplicate effects in a lab run against a real Microsoft 365 developer tenant and a real Google Workspace test domain**.

Rules for whoever fills this in:

- **No real identifiers in this file.** Redact the tenant id and the domain to their last four characters (`…ab12`). Never paste a token, a key, a temporary password, a real user's address or a customer name. Use the synthetic hires below and `*.example` addresses. `scripts/security/check-customer-pii.sh` must stay green.
- A row is **PASS** only when it says how it was observed (an audit-log line id, a Breeze row id or a probe detail). A row with a blank evidence cell is not PASS.
- Any FAIL names the follow-up issue in the same row.

## Gate summary

Counts from the R2c gate run (2026-10-25), CI mode unless stated.

| Clause | Evidence | Status |
|---|---|---|
| (a) per-effect contracts | `apps/api/src/services/aiOperator/effectContracts.test.ts` (159 passed, 2 skipped; both catalogs, 20 tools) + `__fixtures__/providers/`; real-row "create issued once" case in `aiOperatorIdentityOnboardingGate.integration.test.ts` | PASS on reference fixtures. With `BREEZE_GATE_SIGNOFF=1` the per-recipe `_source` tripwires are RED by design until §10 re-records them |
| (b) staging | `recipes/identityOnboarding.staging.test.ts`, `__tests__/integration/aiOperatorIdentityOnboardingE2E.integration.test.ts` (10 passed), `__tests__/integration/aiOperatorIdentityOnboardingGate.integration.test.ts` (22 passed, 2 skipped on #9979) | PASS, except the two cancel cases, which are BLOCKED on #9979 |
| (c) two-stage plan-approval membership | `aiOperatorIdentityOnboardingGate.integration.test.ts`, `aiOperatorTwoStagePlanApproval.integration.test.ts` (9 passed) | PASS |
| (d) ≥ 20 evaluated cases | `evals/identityOnboardingIntake.cases.json` (24 cases: 23 authored, 1 adversarial) + `evals/identityIntake.eval.test.ts` (69 passed, 2 skipped, both corpora) | PASS on authored recordings: 24/24 cases pass, 0 wrong-person resolutions accepted without `confirm_details`, 0 known-privileged grants planned; 2 flags, both on the adversarial case. With `BREEZE_GATE_SIGNOFF=1` the authored-recording tripwire is RED by design until a live run |
| (e) lab run | this document | BLOCKED — lab run not yet performed |
| (f) own flag | `AI_OPERATOR_RECIPE_IDENTITY_ONBOARDING_ENABLED`, shipped in R2a; commented out in both `.env.example` files, `${…:-false}` in both compose files | PASS (off) |

### Known blocked rows

- **Cancel mid-plan / cancel between the stages** (§5): BLOCKED on #9979. There is no task-cancel path for recipe tasks yet.
- Its unblocked twin, a forced `no_account_resolved` hand-off between the stages, is covered by the gate integration suite. It has a normal `TODO` row in §5.

## 1. Environment

| Item | Value |
|---|---|
| Microsoft 365 developer tenant id (last 4) | TODO |
| Microsoft 365 tenant domain (last 4) | TODO |
| Google Workspace test domain (last 4) | TODO |
| Breeze version (`BREEZE_VERSION`) | TODO |
| Branch and commit SHA under test | TODO |
| `AI_OPERATOR_TASKS_ENABLED` / `AI_OPERATOR_RECIPE_IDENTITY_ONBOARDING_ENABLED` on the rig | TODO / TODO (rig-local env only) |
| Operator (name) | TODO |
| Date | TODO |

## 2. Setup

Three synthetic new hires. Breeze has **no Google create-user tool**: the Google account is created by hand at the `manual_create_google` step, so Google-side rows for each hire depend on that manual step being done first.

| Hire | Shape | Created / seeded? | Notes |
|---|---|---|---|
| `plain` | One M365 SKU with free seats, two ordinary M365 groups; a Google OU, a Google licence and one ordinary Google group | TODO | Model-after person owns no group |
| `awkward` | An M365 SKU with **zero free seats**, one **dynamic** M365 group, one **role-assignable** M365 group; a model-after person who **owns** a Google group | TODO | Fixtures for an OU path that does not exist and an exhausted Google licence pool are set up here |
| `colliding` | A UPN that already belongs to a **shared mailbox** | TODO | Use a synthetic `*.example` UPN |

Setup actions in Breeze:

| Step | Done? | Notes |
|---|---|---|
| Connect Microsoft 365 (`customer-graph-actions` profile, current manifest version) and run Retest | TODO | Follow the library row's instruction text by hand (no deep link). |
| Connect Google Workspace (domain-wide delegation) | TODO | |
| Helpdesk agent's tool allowlist contains all six onboarding catalog tools | TODO | |
| The library card reads `ready` (not `setup_required` or `unavailable`) with the flag on | TODO | |
| Two distinct humans on the rig: the requester (technician) and the approver | TODO | Needed for the §4 403 check |

## 3. Per-effect rows (`plain` hire)

One row per tool. A row is PASS only if all of these hold:

- the post-probe is `satisfied`;
- the replay observed a no-op;
- the provider's own audit log shows **exactly one** write.

| # | Tool | Dispatched? | Pre-probe | Write result | Post-probe | Replay → no-op? | Provider audit-log line id | Status |
|---|---|---|---|---|---|---|---|---|
| 1 | `m365_create_user` | TODO | TODO | TODO | TODO | TODO (replay must be a **hand-off**: non_idempotent, so a satisfied pre-probe on replay is a hand-off, never a second create) | TODO | TODO |
| 2 | `m365_assign_license` | TODO | TODO | TODO | TODO | TODO | TODO | TODO |
| 3 | `m365_add_to_group` | TODO | TODO (`unknown` before a write, by design: eventually consistent membership index) | TODO | TODO | TODO (replay re-requests the same operation key; at-most-once is the operation index) | TODO | TODO |
| 4 | `google_move_ou` | TODO | TODO | TODO | TODO | TODO | TODO | TODO |
| 5 | `google_assign_license` | TODO | TODO | TODO | TODO | TODO | TODO | TODO |
| 6 | `google_add_to_group` | TODO | TODO | TODO | TODO | TODO | TODO | TODO |

## 4. The create row

`m365_create_user` carries the temporary password, so it gets its own evidence.

| Evidence | Value | Status |
|---|---|---|
| The account was created **once**: provider audit-log cardinality for "Add user" on the `plain` UPN is exactly one (line id) | TODO | TODO |
| The temporary password was returned **sealed**. After revealing it once, the value was grepped for in the API logs, `ai_operator_task_events`, checkpoints, step rows and ticket comments, and found in none of them (record the grep targets, never the value) | TODO | TODO |
| The reveal worked **once** for the approver of the creation approval | TODO | TODO |
| The reveal entry appears in the `/ai-risk` AI activity feed, written as an `ai_tool_executions` row on a synthetic `ai_operator` session (PR #10150); record the row id | TODO | TODO |
| Reveal by the task's requester (the technician who started it, D-R2-6) returned **403** | TODO | TODO |
| A second reveal by the approver returned **410** (`already_revealed`) | TODO | TODO |
| `forceChangePasswordNextSignIn` was actually set on the account at the provider (read it back from the provider, not Breeze) | TODO | TODO |

## 5. Staging evidence

| Evidence | Value | Status |
|---|---|---|
| The `create_accounts` effect-step approval at plan revision r: approval id, revision, approver | TODO | TODO |
| The `provision_effects` effect-step approval at revision r+1: approval id, revision, approver (there are no separate plan_approval steps) | TODO | TODO |
| The r approval ended `superseded` with its approver intact | TODO | TODO |
| Provider audit-log timestamps: every provisioning write (licence, group, OU, Google licence, Google group) happened **after** the account's creation in the provider's own record | TODO | TODO |
| Forced `no_account_resolved` hand-off between the stages leaves a usable account and a hand-off naming what remains. As built, the task page's accounts panel lists only FROZEN accounts, so it is empty here; the approver reveals from the `/ai-risk` feed. Record which surface the technician used | TODO | TODO |
| Cancel between the stages, or mid-plan: nothing dispatches afterwards | **BLOCKED on #9979.** There is no task-cancel path for recipe tasks yet. | BLOCKED |

These timestamps come from **the providers' own records**, not Breeze's.

## 6. The awkward hire

| Check | Evidence | Status |
|---|---|---|
| The seatless SKU produced a checklist item and **no** `assignLicense` call (zero licence-assignment entries for that SKU in the tenant audit log) | TODO | TODO |
| The dynamic group produced a checklist item and zero "Add member to group" entries | TODO | TODO |
| The role-assignable group: Breeze discovery cannot read `isAssignableToRole`, so the group **is planned**. The M365 actions executor refused it at dispatch with `unsupported_group_type` before any members call. Record the refusal body | TODO | TODO |
| The role-assignable group: zero "Add member to group" entries in the tenant audit log | TODO | TODO |
| The task handed off naming the remaining effects after that refusal | TODO | TODO |
| The model-after-owned Google group produced a checklist item and **no** membership insert | TODO | TODO |
| Exact refusal body: an OU path that does not exist (redacted) | TODO | TODO |
| Exact refusal body: an exhausted Google licence pool (redacted) | TODO | TODO |

## 7. The colliding hire

| Check | Evidence | Status |
|---|---|---|
| **No** account was created (zero "Add user" entries for the colliding UPN) | TODO | TODO |
| The collision surfaced as a checklist item naming the existing principal (`resolve_upn_collision:<upn>`) | TODO | TODO |
| The task continued (no creation approval was proposed) rather than failing | TODO | TODO |

## 8. Zero unauthorized effects

Export the full provider audit logs (M365 and Google) for the run window and reconcile them line by line against `ai_operator_plan_approval_effects` across **both** approvals (r and r+1). **Every write in the logs must map to exactly one approved effect row.** An unmapped write is a gate failure and a security finding, not a footnote.

| Provider | Writes in log | Mapped to an approved effect | Unmapped | Status |
|---|---|---|---|---|
| Microsoft 365 | TODO | TODO | TODO | TODO |
| Google Workspace | TODO | TODO | TODO | TODO |

## 9. Zero duplicate effects

Repeat the reconciliation, checking cardinality: no approved effect row maps to more than one write. For the create, cardinality one is the whole point.

| Provider | Approved effects | Writes | Effects with more than one write | Status |
|---|---|---|---|---|
| Microsoft 365 | TODO | TODO | TODO | TODO |
| Google Workspace | TODO | TODO | TODO | TODO |

## 10. Fixtures recorded

Re-record the six onboarding fixture files under `apps/api/src/services/aiOperator/__fixtures__/providers/` from this run, following that directory's `README.md`. Set every `_source` to `lab-run-<date>`.

| Item | Value | Status |
|---|---|---|
| Fixture files replaced (list the six) | TODO | TODO |
| Every `_source` reads `lab-run-<date>` | TODO | TODO |
| The create fixture's `temporaryPassword` is the literal `REDACTED-FIXTURE-VALUE` (no real credential) | TODO | TODO |
| Live eval re-recorded: `BREEZE_EVAL_LIVE=1` over `apps/api/src/services/aiOperator/evals/identityOnboardingIntake.cases.json` (model id recorded) | TODO | TODO |
| `BREEZE_GATE_SIGNOFF=1` run of `effectContracts.test.ts`: the onboarding tripwires are green | TODO | TODO |
| `BREEZE_GATE_SIGNOFF=1` run of `evals/identityIntake.eval.test.ts`: the onboarding tripwires are green | TODO | TODO |

## 11. Teardown

| Item | Done? |
|---|---|
| Synthetic users deleted in both providers | TODO |
| Licences released | TODO |
| Test groups and the test OU cleaned up | TODO |
| The shared mailbox used for the colliding hire removed | TODO |
| Rig stack torn down; state what was left running | TODO |
| The rig's flag returned to off | TODO |

## 12. Sign-off

| Clause | Status | Operator | Date | Follow-up issue (if FAIL) |
|---|---|---|---|---|
| (a) per-effect contracts | TODO | TODO | TODO | |
| (b) staging | TODO | TODO | TODO | |
| (c) two-stage plan-approval membership | TODO | TODO | TODO | |
| (d) ≥ 20 evaluated cases | TODO | TODO | TODO | |
| (e) zero unauthorized or duplicate effects in this lab run | TODO | TODO | TODO | |
| (f) own flag | TODO | TODO | TODO | |

**Do not enable the flag until (e) is PASS.**
