---
tracking_issue: LanternOps/breeze#6754
wave: W11 (#6781)
spec: docs/superpowers/specs/ai-mcp/2026-09-23-ai-full-control-design.md
triage: docs/superpowers/plans/ai-mcp/2026-09-23-ai-full-control-w05-gap-triage.md
depends_on: W10 (#6780, PR #10273) and W19 (#10087) merged to main
branch: feature/6754-ai-full-control/wave-6781
---
# AI full control W11: security policy tools — class review and plan

**Goal:** give chat and MCP the security-policy capabilities the W05 triage tagged `W11` (rows #1, #13, #109, #119–#124, plus the #6141 PAM-rules gap) as eight new tools, each with a class that survives the spec's class review **before** it is reachable (spec D2). Three actions stay human-only and are **absent from every tool schema** (not refused actions, not enum members): `accessReviews complete` (revokes members and kills their sessions), `auditBaselines apply-request decision` (an approval), `recoveryKeys reveal` (plaintext BitLocker/FileVault key). Paths are under `apps/api/src/`.

**Verified against** `origin/main` `25fcb2e35b` (2026-10-26; W10 #10273 merged, `KNOWN_MISSING_TOOL_TIERS` gone, `FIXTURE_W03_W04` empty).

## Premises

| # | Check | Result |
|---|---|---|
| 0.1 | #10273 merged and on `origin/main`; `KNOWN_MISSING_TOOL_TIERS` absent | yes (comments only) |
| 0.2 | none of the eight names in registry / `TOOL_TIERS` / `HUMAN_ONLY_TOOLS`; every route module exists | yes / yes (`accessReviews.ts`, `auditBaselines.ts`, `policyManagement/actions.ts`, `security/{compliance,dashboard,policies,recommendations,recoveryKeys,status}.ts`, `pam.ts`) |
| 0.3 | no `wave-6781` branch or PR | yes |
| 0.4 | #6781 and #6754 open | yes |

## Facts the triage did not have

1. **Access reviews.** Router-wide: partner callers need `canManagePartnerWidePolicies`; system scope is refused by `getScopeContext`. `POST /` (users:write + MFA) snapshots every `partner_users` (partner scope) or `organization_users` (org scope) row into pending items; nothing is emailed and there is **no delete endpoint**. `PATCH /:id/items/:itemId` (users:write + MFA) records `approved`/`revoked`/`pending` + notes; it changes no access, refuses a completed review, and applies the separation-of-duties rule `canSelfDecideAccessReviewItem` (`services/accessReviewSelfDecision.ts`). Only `POST /:id/complete` acts: it deletes the memberships, advances auth epochs, revokes every refresh family and can neutralise an orphaned account. `POST /:id/notify` emails the reviewer (users:write, no MFA) — **not in the triage row, not built** (it reaches a person). **REST gap:** `reviewerId` is never checked to be a member of the review's scope (any user id is accepted; the reviewer's name is then shown and `/notify` emails them). The tool validates it (W11-D7).
2. **Audit baselines.** All org-owned (`org_id NOT NULL`, no partner axis). `POST /` (organizations:write, no MFA) is an upsert; activating a baseline deactivates the other active baseline for the same org+OS and enqueues a server-side drift evaluation (`evaluateAuditBaselineDrift`, no device command). An active baseline also enrols that org+OS in the daily read-only `collect_audit_policy` sweep (`jobs/auditBaselineJobs.ts`). There is no delete endpoint. `POST /apply-requests` (devices:write, no MFA) inserts one **pending** `audit_baseline_apply_approvals` row (Windows only, ≤ 500 devices, 5–1440 min expiry) and **changes no device state and queues no command**. A *different* user with MFA approves it through `/decision` (human-only here); `/apply` then consumes it and queues `apply_audit_policy_baseline`. Neither `/decision` nor `/apply` is exposed. List/compliance/apply-request reads are **not site-filtered** in REST; device reads are.
3. **Compliance-policy deactivate** (`POST /policies/:id/deactivate`, devices:write + MFA + `canMutateOrgWideGovernance` + partner-wide gate) sets `automation_policies.enabled = false`, closes the alerts the policy raised (`scheduleComplianceAlertReconcile`) and invalidates the agents' probe cache (the agents stop evaluating it). **There is no way back in the product:** `policyManagement/crud.ts` is read-only (two GETs), `actions.ts` retired activate/evaluate/remediate, and no route, service or web page writes `enabled = true` or inserts an `automation_policies` row (grep: the only `update(automationPolicies)` outside this route is the evaluator's `lastEvaluatedAt` stamp). The web app never calls the deactivate route either. So deactivation is **irreversible** in-product, and its row's `updated_at` churns on every evaluation.
4. **Security compliance reads** (`security/{compliance,dashboard,status}.ts`) are projections over `listStatusRows` (site-filtered in SQL), the posture services and `buildBe9Recommendations`. `get_security_posture` (t1, `alwaysLoad`) already covers posture lists and the device posture; it does not cover status, firewall, encryption, password policy, admin audit, trends or the dashboard. **REST fabricates data:** `/security/firewall` synthesises `profiles` and a hard-coded `rulesCount` (142 / 38) from one boolean — the tool never returns them (W11-D5).
5. **Security policies** (`security_policies`, `org_id` XOR `partner_id`; AV/EDR settings JSON). REST has list/create/update only (**no delete**), devices:write, no MFA, no audit row, no site-ceiling check. **The row's settings reach no endpoint today (corrected by quorum QW7):** the device-side security-scan resolver reads the configuration policy's feature-link `inlineSettings` (`featureConfigResolver.ts` `resolveSecurityScanSettingsForDevice`), and `configurationPolicy.ts` only checks that a linked `featurePolicyId` exists. Partner-wide rows are visible only to partner-scope callers and writable only with `canManagePartnerWidePolicies`.
6. **Security recommendations** are computed (`buildBe9Recommendations`), not stored; `complete`/`dismiss`/`reopen` each insert one `audit_logs` row (devices:write, no MFA) that the list's status map reads. Nothing is remediated, no command, no event; `reopen` (UI) undoes either. The status is recorded **org-wide** even though the recommendation set is site-filtered.
7. **Recovery keys.** List (devices:read) returns key metadata (id, type, volume, protector id, status, dates) and the reveal ledger (staff email + name) — **no key material**. `rotate` (devices:execute, no MFA) queues `encryption_rotate_key`; on macOS it needs a FileVault user's password or the current recovery key. `collect` queues `encryption_collect_keys` (agent escrows the current keys). `reveal` (devices:read + MFA, 20/h/user) returns plaintext — human-only.
8. **PAM rules / config / signer groups** (`pam.ts`; all org-owned, no partner axis). Reads devices:read; writes `pam:manage_policy` + MFA; config and signer-group writes also `canMutateOrgWideGovernance`; rule writes check the site of the rule. A rule's `verdict` is `auto_approve | auto_deny | require_approval | ignore`. **`auto_approve` is honoured on the device UAC path** (`routes/agents/elevationRequests.ts`: no human, actuated on the device) **and on the Helper tool-action path** (`pamToolActionGovernance.ts`: the Helper's own tool approvals are skipped). It is ignored only by the AI `request_elevation` tool. A signer group is matched by every rule that references it, so a membership edit widens or narrows those rules at once. Disabling or deleting a rule revokes the elevations it granted (`cleanupPamRuleActuations`).

## Tools and per-action class review

Q1 reversible within a minute? Q2 leaves the tenant / reaches a person / touches a customer machine? Q3 blast radius? Q4 can an agent grant itself authority? t1 = `TIER1_READ_ACTIONS`; t2 = the user approves unless `auto_approve`; sup / 4e = tier-3 scopes.

| Tool / action | Q1 | Q2 | Q3 | Q4 | Triage | **W11** | Route twin / floor |
|---|---|---|---|---|---|---|---|
| `get_security_compliance` (`view`: dashboard, score_breakdown, trends, status, firewall, encryption, password_policy, admin_audit) | read | none | org(s) the caller reaches, site-filtered | no | read | **t1** | GET `/security/{dashboard,score-breakdown,trends,status[/:deviceId],firewall,encryption,password-policy,admin-audit}`, devices:read |
| `manage_security_recommendations:list` | read | none | org, site-filtered set | no | read | **t1** | GET `/security/recommendations`, devices:read |
| `…:complete` / `dismiss` | yes (`reopen` in the UI) | none (one `audit_logs` row; nothing remediated) | one recommendation, **org-wide status** | no | t2 | **t2** | POST `…/:id/complete` / `dismiss`, devices:write |
| `manage_access_reviews:list` / `get` | read | none | review scope (partner staff or org members); emails, roles, permissions | no | read | **t1** | GET `/access-reviews[/:id]`, users:read |
| `…:create` | **no** (no delete or cancel endpoint; inert until a human completes it) | none (no email) | partner staff (partner scope) or one org | no | t2 | **sup** (quorum QW6) | POST `/access-reviews`, users:write + MFA |
| `…:decide_item` | yes (re-decide or reset to `pending` while open) | none: **not the revoking act** — `complete` (human-only) is | one member's item | no (SoD rule; an agent is never a review subject) | t2 | **t2** | PATCH `/access-reviews/:id/items/:itemId`, users:write + MFA |
| `manage_audit_baselines:list` / `compliance` / `device_results` | read | none | org; device read is one device | no | read | **t1** | GET `/audit-baselines`, `/compliance`, `/devices/:deviceId`, audit:read |
| `…:create` | no delete; an active create replaces the org's active baseline for that OS | **device**: an active baseline enrols the org's devices of that OS in the daily `collect_audit_policy` command sweep; drift evaluation publishes deviation events (partner webhooks) | one org + OS | no | t2 | **sup** (quorum QW3) | POST `/audit-baselines` (create only; no `id` upsert), organizations:write |
| `…:request_apply` | yes (expires, or a reviewer rejects it) | **none**: one pending approval row; no command (fact 2) | ≤ 500 named devices of one org | no: a *different* person approves; the requester can never approve their own | sup in triage | **t2** (brief rule: sup only if the request itself changes device state — it does not) | POST `/audit-baselines/apply-requests`, devices:write |
| `manage_compliance_policies:deactivate` | **no** (fact 3: nothing re-enables) | closes the policy's alerts; agents stop evaluating it on customer machines | one org, or **every org** for a partner-wide row | no | t2 org / sup partner-wide | **input-aware, escalated:** `ownerScope: 'organization'` → **sup**; anything else (incl. absent) → **four-eyes**; the handler refuses `'organization'` on a partner-wide row | POST `/policies/:id/deactivate`, devices:write + MFA |
| `manage_security_policies:list` | read | none | org + own partner's templates | no | read | **t1** | GET `/security/policies`, devices:read |
| `…:create` | **no** (no delete endpoint) | none (fact 5) | one org, or every org (`ownerScope: 'partner'`, gated) | no | sup | **input-aware:** org → **sup**; `ownerScope: 'partner'` → **four-eyes** (irreversible **and** partner-wide; quorum QW7) | POST `/security/policies`, devices:write |
| `…:update` | yes (edit back) | none (fact 5) | one org, or every org (partner-wide row, gated) | no | sup | **sup** (stricter than the rule now that fact 5 is corrected; kept as the brief's class) | PUT `/security/policies/:id`, devices:write |
| `manage_recovery_keys:list` | read | none (no key material; reveal ledger names staff) | one device | no | read | **t1** | GET `…/recovery-keys`, devices:read |
| `…:rotate` | **no** (the old key stops working) | **device**: `encryption_rotate_key` | one device (Windows only in the tool) | no | sup | **sup** | POST `…/recovery-keys/rotate`, devices:execute |
| `…:collect` | n/a (re-escrow of the current keys) | **device**: `encryption_collect_keys` | one device | no | sup | **sup** | POST `…/recovery-keys/collect`, devices:execute |
| `manage_pam_rules:list_rules` / `get_config` / `list_signer_groups` | read | none | org | no | read | **t1** | GET `/pam/rules`, `/pam/config`, `/pam/signer-groups`, devices:read |
| `…:create_rule` / `update_rule` / `delete_rule` | yes (edit, disable, delete; disable/delete revoke granted elevations) | none directly; rules decide future elevation on customer machines | one org, or one site of it | **yes for `auto_approve`, and for any change that lets a request fall through to an `auto_approve` rule** (fact 8, quorum QW1) — both refused (W11-D3) | sup (4e if standing elevation) | **sup** | POST / PATCH / DELETE `/pam/rules`, pam:manage_policy + MFA |
| `…:set_config` | yes | none (`require_approval` / `auto_deny` default) | one org | no | sup | **sup** | PUT `/pam/config`, pam:manage_policy + MFA |
| `…:create_signer_group` / `update_signer_group` / `delete_signer_group` | yes | none directly | one org; every rule referencing the group | **yes when membership changes in an org with an auto-approve rule** — refused (W11-D3) | sup | **sup** | POST / PATCH / DELETE `/pam/signer-groups`, pam:manage_policy + MFA |

**Absent from every schema (contract-tested):** `manage_access_reviews` has no `complete` (nor `notify`); `manage_audit_baselines` has no `decision` / `approve` / `reject` / `apply`; `manage_recovery_keys` has no `reveal`; `manage_pam_rules` has no `auto_approve` verdict and no `reapprove`.

### Agent (headless) exposure (spec D4)

| Tool | Exposure |
|---|---|
| `get_security_compliance`, `manage_security_recommendations:list`, `manage_security_policies:list`, `manage_audit_baselines` reads | **reachable; skip the allowlist** (t1). Every read applies the exact-device axis before aggregation and paging; the org-wide aggregates (dashboard, score breakdown, trends, recommendations, audit compliance) are refused to a session bound to specific devices (quorum QW4). Device-reported strings are fenced (QW10). |
| recommendation `complete` / `dismiss` | **reachable; allowlisted t2** (an agent's tier-2 call becomes a supervised intent, the `agentTier2` lane). The org-wide status write is refused to a site- or device-restricted run in the handler, which runs under the agent's own auth at release. |
| security-policy `create` / `update`, compliance `deactivate` | **reachable as proposals** (sup; the partner-wide arms are four-eyes and never pre-authorisable). None is in `POLICY_DECIDABLE_TIER3`. Released under the agent's own auth, so `canMutateOrgWideGovernance` refuses every device-bound run. |
| `manage_recovery_keys` | **reachable** (quorum QW8: no Q4 path). `list` is t1 and the tool drops the reveal ledger's staff names and emails (action, key and time only); `rotate` / `collect` are supervised proposals, device-scoped by `deviceArgs`. |
| `manage_audit_baselines:create` / `request_apply` | **`AGENT_HUMAN_ONLY_ACTIONS`** (quorum QW5, QW9). A user-owned release would run them as the approving human and drop the requesting run's site ceiling, and org-axis approvers cannot be rebuilt today; a pending apply request is also an input to someone else's approval. Reads stay reachable. |
| `manage_access_reviews` | **`AGENT_HUMAN_ONLY_TOOLS`**, an explicit D4 exception (QW8). Access reviews are identity governance (the spec's standing exclusion for identity and role changes); the reads are every member's email, role and permission map with no device axis; an agent principal is not a reviewer the separation-of-duties rule can reason about. |
| `manage_pam_rules` | **`AGENT_HUMAN_ONLY_TOOLS`**, an explicit D4 exception (Q4, QW8). Writes edit who gets local admin and, through tool-action rules, the Helper's own approval governance; the reads are the elevation policy map (which signers, paths and users are trusted), reconnaissance with no autonomous need. |

## Decisions

- **W11-D1 one PR, eight tools.** Thin adapters over exported helpers; no migration. The PAM rule/config/signer-group validators (`ruleBaseSchema`, criteria validators, `validateRuleShape`, `tierDriftResponse`, signer-group schemas, `cleanupPamRuleActuations`) and the rule insert/update row builders move **verbatim** out of `routes/pam.ts` into `services/pamPolicySchemas.ts` (pure zod, no DB handle or registry import, so the tool schemas can use it without a cycle) and `services/pamPolicyAdmin.ts` (cleanup, tier drift, row builders), so the route and the tool share one copy; `routes/pam.test.ts` and `pam.siteScope.test.ts` pass unchanged (149/149).
- **W11-D2 `get_security_compliance` is a new read tool, not an extension of `get_security_posture`.** The posture tool is `alwaysLoad` (every chat turn pays its schema) and reads posture snapshots; these views read `security_status`. Its selector is `view` (not `action`), so the index renders it bare. The status view takes an optional `deviceId` (`deviceArgs`).
- **W11-D3 the tool can never widen auto-approval (revised by quorum QW1/QW2).** (a) The `verdict` enum is `require_approval | auto_deny | ignore`; `reapprove` is absent, so the tool cannot write `auto_approve`. (b) The first enabled matching rule wins, so removing or narrowing a higher-priority rule lets a request fall through to a lower-priority `auto_approve` rule, and a signer-group edit changes every rule that references it. So **when the organization has any rule whose `verdict` or `suspendedVerdict` is `auto_approve` (enabled or not)**, the tool may only: create a rule; change a rule's `name` / `description`; disable or delete a rule whose current `verdict` is `auto_approve` (that never widens the auto-approved set); change a signer group's `name` / `description`; set the org default. Every other rule update or delete and every signer-group membership change is refused ("edit it in PAM settings"). (c) The check runs inside the mutation's transaction, with the target row locked `FOR UPDATE` and the org's auto-approve rules read `FOR SHARE`, so a concurrent tool write cannot slip between check and write; a concurrent human REST write is not serialised (residual, recorded). (d) Weakening that grants nothing stays supervised by decision: deleting a `require_approval` tool-action rule (requests then wait for the normal approval), or a higher-priority `require_approval` over an `auto_deny` (a denial becomes a pending request). With no path to standing elevation, every PAM write is **supervised, not four-eyes** (the W04 `request_elevation` precedent was four-eyes "out of caution" because a rule *might* grant; here the grant path is closed instead).
- **W11-D4 compliance deactivate is escalated and input-aware on an asserted owner.** The brief proposed t2 org / sup partner-wide on the premise that deactivation is reversible; fact 3 shows it is not, so the class rule gives **sup** for an org row (irreversible) and **four-eyes** for a partner-wide row (irreversible **and** every org). Ownership is DB state and guardrails are DB-free, so the model asserts `ownerScope: 'organization' | 'partner'`: only the literal `'organization'` resolves supervised, anything else (absent included) four-eyes, and the handler refuses an `'organization'` assertion on a partner-wide row, so the cheaper scope can never reach a partner-wide effect. Registry tier 3 for the whole tool; partner-wide still needs `canManagePartnerWidePolicies`. The four-eyes arm is `DELIBERATELY_UNPINNED`: the row has no edit path to drift through, and its `updated_at` churns with every evaluation, so a pin would fail closed on routine activity; the policy id, name and owner travel in the intent the approvers review.
- **W11-D5 no fabricated data.** `get_security_compliance` firewall rows carry `firewallEnabled` only (no synthesised profiles or rule counts). Follow-up for the REST twin, not changed here.
- **W11-D6 stricter than REST for org-wide state.** A site- or device-restricted caller cannot: write a security policy, mark a recommendation (org-wide status), deactivate a compliance policy (route parity: `canMutateOrgWideGovernance`), create an audit baseline, or touch access reviews at all (they enumerate every member of the org). Audit-baseline compliance for a restricted caller is computed over the devices it can see (REST is org-wide).
- **W11-D7 access-review `reviewerId` must be a member of the review's scope** (`partner_users` for a partner review, `organization_users` for an org review); REST accepts any user id (follow-up).
- **W11-D8 user-FK writes (revised by quorum QW5/QW9).** `access_review_items.reviewed_by`, `access_reviews.reviewer_id`, `audit_baselines.created_by`, `audit_baseline_apply_approvals.requested_by`, `pam_rules.created_by_user_id`, `pam_signer_groups.created_by_user_id` and `pam_org_config.updated_by_user_id` are `users` FKs. Every W11 write that stores one is agent-unreachable: access reviews and PAM by `AGENT_HUMAN_ONLY_TOOLS` (SAFE_WRITE_SITES class (b)), the two audit-baseline writes by `AGENT_HUMAN_ONLY_ACTIONS`. No user-owned release is added: it would run the write as the approving human and drop the requesting run's site ceiling (QW5), and org-axis approvers cannot be rebuilt (QW9).
- **W11-D13 security policies have no endpoint effect (quorum QW7).** Fact 5 corrected. `create` has no delete twin, so an org create is supervised and a partner-wide create (`ownerScope: 'partner'`) four-eyes (irreversible and every org); `update` stays supervised, stricter than the rule now requires, because the brief set it there and a loosening needs a sign-off.
- **W11-D14 exact-device axis and fencing (quorum QW4, QW10).** Device lists apply `filterToDeviceScope` after the SQL org/site axes and before paging; org-wide aggregates refuse a device-bound session; audit-baseline compliance is computed over the caller's visible devices. Every free-text field a tool returns, nested ones included, is an explicit projection listed in `RAW_TEXT_FIELDS_BY_TOOL`.
- **W11-D9 rotate is Windows-only in the tool.** macOS rotation needs a FileVault user's password or the current recovery key; credentials never travel through chat.
- **W11-D10 MFA parity.** Every write whose REST twin carries `requireMfa()` (access-review create/decide, compliance deactivate, PAM writes) checks `hasSatisfiedMfa` in the handler (W09 QW4 precedent: an MCP key carries no MFA claim).
- **W11-D11 rate limits** on every tool; device-reaching `manage_recovery_keys` 10/300 s.
- **W11-D12 MCP surface (Todd signs off in the PR).** Every tool is new, so nothing is lost. Gains over MCP: every t1 read and the t2 writes above. The supervised and four-eyes actions are denied over MCP by default (`MCP_APPROVAL_REQUIRED`), as every tier-3 action is, unless `MCP_TIER3_INTENTS_ENABLED=true` or an unattended principal is configured. **No loosening:** no existing class moves.

### Existing entries, and whether they change

| Map | W11 |
|---|---|
| `TOOL_TIERS` (block after W10) | + 8 (registry tiers: `get_security_compliance` 1; the six `manage_*` with reads 1; `manage_compliance_policies` 3) |
| `TIER1_READ_ACTIONS` | + every read action above |
| `TIER2_ACTIONS` | recommendations complete/dismiss, access-review decide_item, audit-baseline request_apply |
| `TIER3_ACTIONS` + `TIER3_SUPERVISED_ACTIONS` | access-review create, audit-baseline create, security-policy update, recovery-key rotate/collect, the seven PAM writes |
| `TIER3_ACTIONS` + `TIER3_INPUT_AWARE_ACTIONS` / `resolveApprovalScope` arms / `TIER_DECIDING_INPUT_KEYS` | + `manage_compliance_policies:deactivate` and `manage_security_policies:create` (`ownerScope`; supervised for an org row, four-eyes for partner-wide — the `manage_organizations:update_org` shape) |
| `TIER3_FOUR_EYES_*` | unchanged — the only four-eyes W11 surfaces are the two input-aware arms above |
| `EFFECT_DIGEST_RESOLVERS` / `DELIBERATELY_UNPINNED` | + `DELIBERATELY_UNPINNED` reasons for `manage_compliance_policies:deactivate` (W11-D4) and `manage_security_policies:create` (NEW-OBJECT) |
| `AGENT_HUMAN_ONLY_TOOLS` | + `manage_access_reviews`, `manage_pam_rules` |
| `AGENT_HUMAN_ONLY_ACTIONS` | + `manage_audit_baselines:create`, `manage_audit_baselines:request_apply` |
| `USER_OWNED_RELEASE_ACTIONS` | unchanged (no agent-reachable W11 write stores `auth.user.id` in a `users` FK); `aiTools.userOwnedRelease.contract` learns that an `AGENT_HUMAN_ONLY_ACTIONS` key is agent-unreachable, as it already knows for `AGENT_HUMAN_ONLY_TOOLS` |
| `TOOL_PERMISSIONS` | per-action rows from each route (table above) |
| `mcpCoverage.ts` / `FROZEN_GAPS` | W11 gaps burned down: `accessReviews.ts`, `auditBaselines.ts`, `policyManagement/actions.ts`, `security/{compliance,dashboard,policies,recommendations,recoveryKeys,status}.ts`; `pam.ts` gains `manage_pam_rules` |

## Budget (W19 bounds; `AI_TOOL_INDEX=lazy`)

| Measure | main `25fcb2e35b` | branch |
|---|---|---|
| Always-on (B1 < 2,560) | 2,494 | _measured at T5_ |
| security block (B2 < 2,048) | 1,268 (largest) | _T5_ |
| Worst page turn (B3 < 7,040) — alert | 4,731 | _T5_ |

Projection: ≈ +370 B on the security line (eight tools, `manage_pam_rules` collapses to `(10 actions)`), ≈ 1,640 B. No ceiling, `DOMAIN_NOTES` or vocabulary change.

## Quorum (codex `exec`, read-only, xhigh): AGREE WITH CHANGES

- **QW1 (blocking) PAM fall-through to an `auto_approve` rule. ACCEPTED** — W11-D3 (b): in an org with an auto-approve rule only non-widening writes are allowed.
- **QW2 PAM checks must be atomic; weakening needs a decision. ACCEPTED** — W11-D3 (c), (d).
- **QW3 (blocking) audit-baseline `create` is not t2. ACCEPTED** — supervised (it arms recurring `collect_audit_policy` commands and deviation events).
- **QW4 (blocking) exact-device axis before aggregation. ACCEPTED** — W11-D14.
- **QW5 (blocking) a user-owned release drops the run's ceiling. ACCEPTED** — audit-baseline writes are `AGENT_HUMAN_ONLY_ACTIONS`; W11-D8.
- **QW6 access-review `create` has no undo. ACCEPTED** — supervised.
- **QW7 security policies reach no endpoint; create has no delete. ACCEPTED** — fact 5 corrected, W11-D13.
- **QW8 whole-tool human-only is overused. PARTLY ACCEPTED** — recovery keys become reachable (reads without staff identities, writes as proposals); audit-baseline writes are action-level. Access reviews and PAM stay whole-tool, recorded as explicit D4 exceptions with reasons (identity governance; privileged-access governance and its reconnaissance value). **Dissent for Todd:** codex would expose PAM reads to agents.
- **QW9 org-axis approvers cannot be rebuilt for a user-owned release. ACCEPTED** — moot: no user-owned release is added.
- **QW10 fence every device-reported string. ACCEPTED** — W11-D14.
- **QW11 W11-D4 is sound. Agreed** — tests cover missing / malformed / false owner assertions, and ownership is re-checked in the UPDATE itself.
- **QW12 remaining classes verified. Agreed.**

## Tasks

T1 (this doc + quorum) → T2 guardrail classes → T3 route bindings + permission parity → T4 schemas, handlers, the PAM validator move, pre-exposure fixes → T5 wiring + index measure → T6 agent catalog → T7 `W11_EXPECTED` → T8 web `tierConfig.ts` → T9 docs → T10 prompt-size gate → T11 golden prompts → T12 integration suites → T13 merge main, gates, PR.
