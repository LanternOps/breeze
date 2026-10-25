# `identity_offboarding` lab run — release gate evidence (spec §9)

> **THIS CHECKLIST HAS NOT BEEN RUN. EVERY ROW BELOW IS `TODO`. Clause (e) of the release gate is BLOCKED until a person fills it in by hand on a lab rig. Do not enable `AI_OPERATOR_RECIPE_IDENTITY_OFFBOARDING_ENABLED` in any environment until every row is PASS.**

This is the evidence document for spec §9's `deterministic` gate on the Operator Recipe Library's `identity_offboarding` recipe (feature #6165, wave #6171, PR R1c). Clauses (a)–(d) and (f) are automated tests that run on mocked providers and real Postgres; the gate table at the end summarises them. This checklist is clause (e), **zero unauthorized or duplicate effects**. It is the only clause that runs against a real Microsoft 365 developer tenant and a real Google Workspace test domain, on a non-production rig.

Rules for whoever fills this in:

- **No real identifiers in this file.** Redact the tenant id and the domain to their last four characters (`…ab12`). Never paste a token, a key, a real user's address or a customer name. Use the synthetic leaver names below. `scripts/security/check-customer-pii.sh` must stay green.
- A row is **PASS** only when it says how it was observed (an audit-log line id, a Breeze row id or a probe detail). A row with a blank evidence cell is not PASS.
- Any FAIL names the follow-up issue in the same row.

## 1. Environment

| Item | Value |
|---|---|
| Microsoft 365 developer tenant id (last 4) | TODO |
| Microsoft 365 tenant domain (last 4) | TODO |
| Google Workspace test domain (last 4) | TODO |
| Breeze version (`BREEZE_VERSION`) | TODO |
| Branch and commit SHA under test | TODO |
| `AI_OPERATOR_TASKS_ENABLED` / `AI_OPERATOR_RECIPE_IDENTITY_OFFBOARDING_ENABLED` on the rig | TODO / TODO (rig-local env only) |
| Caller-verification tier for `disable_user` on the rig's partner (see §3a) | TODO |
| Operator (name) | TODO |
| Date | TODO |

## 2. Setup

Two synthetic leavers per provider:

| Leaver | Provider | Shape | Created? | Notes |
|---|---|---|---|---|
| `plain-g` | Google | Licence, two groups, one enrolled phone, a vacation-capable mailbox | TODO | |
| `awkward-g` | Google | Sole owner of a group, plus a mail delegate that is a shared mailbox | TODO | |
| `plain-m` | M365 | Licence, two assigned groups, one Intune-enrolled phone | TODO | |
| `awkward-m` | M365 | Sole owner of a group, a dynamic-membership group, a role-assignable group, a shared mailbox in their delegates | TODO | |

Setup actions in Breeze:

| Step | Done? | Notes |
|---|---|---|
| Connect Microsoft 365 (`customer-graph-actions` profile, current manifest version) and run Retest | TODO | The library's setup rows carry **no deep link** (`action.href` is null; R1b follow-up). Follow the row's instruction text by hand. |
| Re-consent Microsoft 365 if the library row says so | TODO | Same: instruction text only, no link. |
| Connect Google Workspace (domain-wide delegation) | TODO | |
| Helpdesk agent's tool allowlist contains all 14 catalog tools | TODO | |
| The library card reads `ready` (not `setup_required` or `unavailable`) with the flag on | TODO | |
| Each leaver exists as a Breeze contact linked to its provider account | TODO | |

## 3. Per-effect rows (`plain-*` leavers)

One row per tool in `IDENTITY_OFFBOARDING_EFFECT_TOOLS`. A row is PASS only if all of these hold:

- the post-probe is `satisfied`;
- a replay of the same effect observed a no-op, or re-requested the same operation key and the provider log shows no second write;
- the provider's own audit log shows **exactly one** write.

| # | Tool | Dispatched? | Pre-probe | Write result | Post-probe | Replay → no-op? | Provider audit-log line id | Status |
|---|---|---|---|---|---|---|---|---|
| 1 | `google_set_vacation` | TODO | TODO | TODO | TODO | TODO | TODO | TODO |
| 2 | `google_set_forwarding` | TODO | TODO | TODO | TODO | TODO | TODO | TODO |
| 3 | `google_add_mail_delegate` | TODO | TODO | TODO | TODO | TODO | TODO | TODO |
| 4 | `google_remove_from_group` | TODO | TODO | TODO | TODO | TODO | TODO | TODO |
| 5 | `google_remove_license` | TODO | TODO | TODO | TODO | TODO | TODO | TODO |
| 6 | `google_account_wipe_mobile_device` | TODO | TODO | TODO | TODO | TODO | TODO | TODO |
| 7 | `google_signout` | TODO | TODO (always `unknown`) | TODO | TODO (always `unknown`; subsumed by #8) | TODO | TODO | TODO |
| 8 | `google_suspend_user` | TODO | TODO | TODO | TODO | TODO | TODO | TODO |
| 9 | `m365_set_auto_reply` | TODO | TODO | TODO | TODO | TODO | TODO | TODO |
| 10 | `m365_remove_from_group` | TODO | TODO | TODO | TODO | TODO | TODO | TODO |
| 11 | `m365_remove_license` | TODO | TODO | TODO | TODO | TODO | TODO | TODO |
| 12 | `m365_retire_intune_device` | TODO | TODO | TODO | TODO | TODO | TODO | TODO |
| 13 | `m365_revoke_sessions` | TODO | TODO | TODO | TODO | TODO | TODO | TODO |
| 14 | `m365_disable_user` | TODO | TODO | TODO | TODO | TODO | TODO | TODO |
| — | Device lock / log-off (Todd's D2: human work in R1, no catalog tool) | n/a | n/a | n/a | n/a | n/a | n/a | TODO: the manual item appeared and was completed by hand |

### 3a. Questions this run must answer

The automated gate cannot answer these questions. Each one bounds or explains a row above.

| Question | Why it matters | Answer | Status |
|---|---|---|---|
| What caller-verification tier for `disable_user` does the rig's partner use, and did `m365_disable_user` run **headless**? | Under the product default (tier 2) the effect is never planned and becomes a manual item. Row 14 can be exercised headless only at tier 0. If the rig runs the default, row 14 records the manual item instead (open design item 2 on PR #9993). | TODO | TODO |
| After `admin_account_wipe`, does `mobiledevices.list` report `WIPING` / `WIPED` for the device? | The probe treats those two statuses as done. If Google reports something else, the probe can never verify row 6. The tool is unclassified, so `non_idempotent`: an unconfirmed state hands off and is never retried. | TODO (record the exact `status` values seen) | TODO |
| How do the Gmail mail-settings reads (`getVacation`, `getAutoForwarding`, `delegates.list`) behave once the user is suspended? | `verify_outcome` re-reads after the suspend. If a suspended mailbox refuses the reads, rows 1–3 cannot be re-verified after row 8. | TODO | TODO |
| Did Google licence removal (row 5) affect mail delivery or the mail settings set in rows 1–3? | Open design item 3 on PR #9993 (a degraded mail tool holding only its own provider's lockout). The R1a note says Google licence removal may affect mail. | TODO | TODO |
| Did every refusal body match its recorded fixture shape (each fixture's `writeRefusal`, e.g. `consent_upgrade_required`, `unsupported_group_type`, `device_not_found`, `user_not_found`, `graph_throttled`, Google 403/404, and Gmail's pending-verification forward)? | The contract suite asserts each refusal fails closed or returns an error. That holds only if the real shapes match. | TODO | TODO |

## 4. Ordering evidence

| Evidence | Value | Status |
|---|---|---|
| The plan as approved (ordinals and tools, from `ai_operator_plan_approval_effects`) | TODO | TODO |
| Google audit-log timestamps: rows 1–3 (vacation, forwarding, delegate) **before** row 8 (suspend) | TODO | TODO |
| M365 audit-log timestamps: row 9 (auto-reply) **before** row 14 (disable) | TODO | TODO |
| Mid-plan stop: cancel the task after the Google mail effects and before the suspend; nothing dispatches afterwards | **BLOCKED on #9979.** There is no task-cancel path for recipe tasks yet. | BLOCKED |

These timestamps come from **the providers' own records**, not Breeze's.

## 5. The awkward leavers

| Check | Evidence | Status |
|---|---|---|
| The dynamic-membership group produced a human-work item and **no** membership call (the tenant audit log shows zero `Remove member from group` entries for it) | TODO | TODO |
| The role-assignable group: same as above | TODO | TODO |
| The sole-owned group produced a confirmation item | TODO | TODO |
| The shared mailbox among `awkward-g`'s delegates was not treated as a person | TODO | TODO |

## 6. `keepMailbox`

| Check | Evidence | Status |
|---|---|---|
| With `keepMailbox: true`, **no** `assignLicense` removal call appears in the M365 audit log | TODO | TODO |
| The shared-mailbox conversion manual item appeared, before the licence item | TODO | TODO |

## 7. Zero unauthorized effects

Export the full provider audit logs (M365 and Google) for the run window and reconcile them line by line against `ai_operator_plan_approval_effects`. **Every write in the logs must map to exactly one approved effect row.** An unmapped write is a gate failure and a security finding, not a footnote.

| Provider | Writes in log | Mapped to an approved effect | Unmapped | Status |
|---|---|---|---|---|
| Microsoft 365 | TODO | TODO | TODO | TODO |
| Google Workspace | TODO | TODO | TODO | TODO |

## 8. Zero duplicate effects

Repeat the same reconciliation, this time checking cardinality: no approved effect row maps to more than one write.

| Provider | Approved effects | Writes | Effects with more than one write | Status |
|---|---|---|---|---|
| Microsoft 365 | TODO | TODO | TODO | TODO |
| Google Workspace | TODO | TODO | TODO | TODO |

## 9. Fixtures recorded

Re-record the 14 files under `apps/api/src/services/aiOperator/__fixtures__/providers/` from this run, following that directory's README ("Recording procedure"). Set every `_source` to `lab-run-<date>`.

| Item | Value | Status |
|---|---|---|
| Fixture files replaced (list) | TODO | TODO |
| `BREEZE_GATE_SIGNOFF=1 npx vitest run src/services/aiOperator/effectContracts.test.ts`: the tripwire is green | TODO | TODO |
| Live intake eval re-recorded (`BREEZE_EVAL_LIVE=1`, model id recorded); `BREEZE_GATE_SIGNOFF=1` tripwire green | TODO | TODO |

## 10. Sign-off

| Clause | Status | Operator | Date | Follow-up issue (if FAIL) |
|---|---|---|---|---|
| (a) per-effect contracts | TODO | TODO | TODO | |
| (b) ordering | TODO | TODO | TODO | |
| (c) plan-approval membership | TODO | TODO | TODO | |
| (d) ≥ 20 evaluated cases, zero wrong-person resolutions accepted | TODO | TODO | TODO | |
| (e) zero unauthorized or duplicate effects in this lab run | TODO | TODO | TODO | |
| (f) own flag | TODO | TODO | TODO | |

## 11. Teardown

| Item | Done? |
|---|---|
| Synthetic leavers suspended or deleted in both providers | TODO |
| Test devices unenrolled (Intune, Google endpoint management) | TODO |
| Rig stack torn down; state what was left running | TODO |
| The rig's flag returned to off | TODO |

> Note for the operator: do **not** run an organization merge on the rig mid-task. A task fenced by an org merge cannot settle today (#9980), and that is not what this run measures.

---

## Gate status at R1c (automated clauses)

The R1c PR filled this table from real output on 2026-10-24, at the head the PR was opened from. The automated runs used local stacks with mocked providers; no lab run was involved. The table records the gate **as shipped**: shipped and unmet, with the flag off. All commands run from `apps/api`; integration runs add `--config vitest.integration.config.ts` and need a test stack.

| Clause | Evidence | Command | Result | Status |
|---|---|---|---|---|
| (a) per-effect contracts | `src/services/aiOperator/effectContracts.test.ts` + `__fixtures__/providers/*.json` (14 tools × 7 cases + 6) | `npx vitest run src/services/aiOperator/effectContracts.test.ts` | 1 file, 104 passed, 1 skipped (the tripwire) | PASS on reference fixtures |
| (a) tripwire | same file, gate mode | `BREEZE_GATE_SIGNOFF=1 npx vitest run src/services/aiOperator/effectContracts.test.ts` | 1 failed (`no fixture is still marked _source: "reference"`), 104 passed | **RED by design** until §9 re-records the fixtures |
| (b) ordering | `src/__tests__/integration/aiOperatorIdentityGate.integration.test.ts` (ordering block: k = 0..11, two off-path cases, the product-default case); `recipes/identityOffboarding.ordering.test.ts`; the R1a E2E | gate + E2E suites (integration config) | 2 files, 35 passed, 4 skipped (gate: the #9979 cancel case; E2E: its 3 BUG cases) | PASS (plan prefixes, the happy-path run, every dispatch stopping point). The mid-plan stop is BLOCKED on #9979 |
| (c) plan-approval membership | `aiOperatorIdentityGate.integration.test.ts` (membership block: cases 3, 4, 5, 6, 7a, 7b, 8a, 8b, 9, 10) | same run | included above | PASS |
| (d) intake eval | `src/services/aiOperator/evals/identityIntake.eval.test.ts` + `identityIntake.cases.json` (25 cases) | `npx vitest run src/services/aiOperator/evals/identityIntake.eval.test.ts` | 1 file, 34 passed, 1 skipped (the tripwire) | Structural PASS. Recall at prompt level is pending a live run: in gate mode the `authored` tripwire is **RED** |
| (a)+(d) gate run | the recipe tests, both ordering files, contracts, eval | `BREEZE_GATE_SIGNOFF=1 npx vitest run src/services/aiOperator/recipes/identityOffboarding.test.ts src/services/aiOperator/recipes/identityOffboarding.ordering.test.ts src/services/aiOperator/effectContracts.test.ts src/services/aiOperator/evals/identityIntake.eval.test.ts` | 4 files, 2 failed (both tripwires), 317 passed | As expected |
| (e) lab run | this document, §1–§11 | by hand | not performed | **BLOCKED — not yet performed** |
| (f) own flag | `.env.example:1461` and `deploy/.env.example:540` (commented out); `docker-compose.yml:357` and `deploy/docker-compose.prod.yml:550` (`${…:-false}`) | `grep -rn AI_OPERATOR_RECIPE_IDENTITY_OFFBOARDING_ENABLED .env.example deploy/.env.example docker-compose.yml deploy/docker-compose.prod.yml apps/api/src/routes/config.ts e2e-tests/` | no live assignment; no hit in `routes/config.ts`; the only `e2e-tests` hit is the spec-header comment | PASS (off) |

**Do not enable the flag until (e) is PASS.**
