---
tracking_issue: LanternOps/breeze#6754
wave: W18 (#6789)
spec: docs/superpowers/specs/ai-mcp/2026-09-23-ai-full-control-design.md
triage: docs/superpowers/plans/ai-mcp/2026-09-23-ai-full-control-w05-gap-triage.md
depends_on: W19 (#10087) merged to main; independent of W16 (#6786) and W17 (#6788)
branch: feature/6754-ai-full-control/wave-6789 (PR A), feature/6754-ai-full-control/wave-6789-b (PR B)
---
# AI full control W18: org admin tools and read-only users and roles — class review and plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** expose the W05 rows tagged `W18` to chat and MCP, each with a class that survives the spec's class review **before** the tool is reachable (spec D2). Users and roles stay read-only.

**Architecture:** route logic moves into exported functions the routes and tools both call (W07-D2), with the routers' own gates carried along, so no tool re-derives scope. Identity and portal-user reads are chat and MCP only; headless agents are denied. The two writers are supervised, with one four-eyes action bound to an effect digest.

**Tech Stack:** Hono services, Drizzle, Vitest (unit + `pnpm test-stack` integration), the action-intent / effect-digest machinery.

**Verified against** `origin/main` `36f9d9ca53` (2026-11-04). Paths are under `apps/api/src/` unless stated; line numbers drift, so re-grep.

## Global Constraints

- **Two sequential PRs, both base `main`, never stacked** (a stacked PR gets no CI). PR B branches from `main` after A merges. A: `Part of #6789`. B: `Closes #6789`. Both `Part of #6754`.
- **No migration, no new table, no new column** in either PR, so no RLS shape, no `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts`, `CORE_TENANT_EXPORT_POLICY` or device/ticket list entry. If implementation finds it needs one, stop and raise it: the slot would be `2027-01-21-100000-<slug>.sql`, sorted after the newest committed file at that moment (today `2027-01-20-120000-m365-mailbox-connect-baseline.sql`; open PRs hold `130000` / `140000` / `160000`, so re-check).
- **No new setting, so settings rule 9 counts are unchanged.** `portal_branding` is still edited on the org Branding tab; the tool is another door to the same row and resolver (W14 precedent). No `pages/settings/**` or `*Settings*` component changes. `portal_branding` stays org-scoped: partner-wide-first applies to new tables.
- **The tool never asks for less than the route.** That includes router-level gates: `roleRoutes.use('*')` requires `canManagePartnerWidePolicies`, and `userRoutes.use('*')` requires full partner membership. Both move into the shared operations.
- **No credential or MFA-bookkeeping column reaches the model:** `passwordHash`, `mfaEpoch`, `mfaEnrollmentGraceGrantedAt`, `roleForceMfa`.
- **`customCss` is not writable by a tool** (Decision 3).
- **No identity write action on any tool** (Decision 1).
- **`z.undefined()` is banned in tool schemas.** Tool description ≤ 300 chars, param description ≤ 160.

## Review Focus

1. **A selected-org partner technician asks "who are our users?".** REST refuses them at the router; if the gate is left behind in the route they enumerate every partner identity → T1 `selected-org partner caller refused by listScopedUsers and listRolesForCaller`.
2. **Enabling a parent flag activates data already flagged on.** With `enablePhysicalPlacement` already true, `update { enableNetworkVisibility: true }` shows rack data (`routes/portal/network.ts`) → T6 `update refuses a parent enable that activates a sensitive child`; `the check and the write share one row lock`.
3. **`remove` deletes a series exclusion, which restores delivery.** It needs the same gate as `add` → T7 `remove of a series 'remove' row without export + MFA is refused and the row stays`.
4. **An approved sensitive-access intent is released after the flags changed.** The digest no longer matches and nothing is written → T6 `release after drift refuses`.
5. **Org-scoped caller or foreign org.** `get_org_summary` refuses organization scope, `get_audit_retention` for another org is the same not-found as a missing one → T3; T5 integration.

---

## Premises

| # | Check | Result |
|---|---|---|
| 0.1 | All eight W05 modules are still `{ gap: '#6789' }` in `mcpCoverage.ts` | yes: `orgAccountReadiness.ts`, `orgAuditRetentionSettings.ts`, `orgPortalSettings.ts`, `orgPortalUsers.ts`, `orgSummary.ts`, `reports/recipients.ts`, `roles.ts`, `users.ts`. W03 and W14 absorbed none |
| 0.2 | None of the nine tool names is registered in `aiTools` | yes. `get_user` in `delegantClient.ts` / `aiToolsM365.ts` is the internal Delegant call name, not a registered tool |
| 0.3 | No `wave-6789` branch or PR | yes |
| 0.4 | #6789 and #6754 open | yes |

### Already covered (not in this wave)

| Surface | Covered by |
|---|---|
| Org and site list/update, contacts | `list_organizations`, `get_site`, `list_sites`, `manage_organizations`, `list_org_contacts` |
| Org audit log rows | `query_audit_log` |
| Report definitions and runs | `generate_report` (`emailRecipients` on a business type is refused to the tool) |
| Org ticket settings, billing profile | W06, W14 |
| Org archive, merge | `exempt: human_only_tenant_restructure` |
| Device-side user sessions, M365 identities | `get_active_users`, `m365_query_users` (separate concepts; see Decision 6) |

### W16 boundary

PR #10273 was **W10 (#6780), the read half**. No W16 write is on `main`, and no W16 plan or PR exists. W16 still owes `manage_ai_agent_schedules`, `create_operator_task`, `manage_fleet_designs` and `run_patch_plan`. W18 touches none of those route modules or handlers. The overlap is registry hot files only, so whichever lands second rebases, re-keys golden ids and re-measures.

## Facts the triage did not have

1. **Portal visibility has parent gates.** `enablePhysicalPlacement` and `enableNetworkAlerts` are read only when `enableNetworkVisibility` is on (`routes/portal/network.ts`). `enableHourBlock` needs `enableSupportUsage` too (`routes/portal/featureFlags.ts`). `enablePatchDetail` and `enableVulnerabilityDetail` are their own gates. So a flag-name check alone does not bound what `update` exposes.
2. **`customCss` is served verbatim to customer portal users,** with attack vectors rejected in `updatePortalSettingsSchema`. `enableReports: true` also provisions report definitions (`onPortalFlagsChanged`), with `createdBy` a user reference.
3. **A recipient on an org-owned definition is a live delivery:** `reportScheduleWorker.ts` sends to `report_schedule_recipients` rows with `mode = 'add'`. Series children route `add` and exclusion-removal through `callerMaySetEmailRecipients` (`reports:export` + MFA). Partner-owned definitions refuse every writer.
4. **Agents are always `scope: 'organization'`** (`aiAgents/agentAuthContext.ts`). `GET /organizations/:id/summary`, `GET /orgs/account-readiness` and the portal routes require partner or system, so an agent could never execute those tools even if reachable (Decision 4).
5. **The summary and readiness routes are per-section permissioned,** with inline logic and `c.get('permissions')`. Tools use the live set from `getUserPermissions`, the way `aiCallerPermissions` does in `aiToolsFleet.ts`.
6. **`GET /users` and `GET /organizations/:id/portal-users` are unbounded.** Tools add a limit and `truncated`. `users.ts` also holds `/me/*` self-service routes, whose subject is the caller; no tool covers them.

## Tools and per-action class review

Q1 reversible in a minute? Q2 leaves the tenant / reaches a person? Q3 blast radius? Q4 can an agent grant itself authority?

### PR A: reads

| Tool:action | Q2 | Q3 | Q4 | Triage | **W18** | RBAC (= route) | Scope (= route) |
|---|---|---|---|---|---|---|---|
| `get_org_summary` | none | one org | no | read | **t1** | `organizations:read`, per-section grants | partner, system |
| `get_account_readiness` | none | caller's orgs | no | read | **t1** | `organizations:read`, per-section grants | partner, system |
| `get_audit_retention` | none | one org | no | read | **t1** | `audit:read` | org (own), partner, system |
| `list_portal_users` | none | one org | no | read | **t1** | `organizations:read` | partner, system |
| `list_users` | none | scope | no (read) | read | **t1** | `users:read` | full partner member, org |
| `get_user` | none | one user | no (read) | read | **t1** | `users:read` | full partner member, org |
| `list_roles:list` / `get` / `users` / `effective_permissions` | none | scope | no (read) | read | **t1** | `users:read` | `canManagePartnerWidePolicies`, org |

### PR B: writers

| Tool:action | Q1 | Q2 | Q3 | Q4 | Triage | **W18** | RBAC / MFA (= route unless noted) |
|---|---|---|---|---|---|---|---|
| `manage_org_portal_settings:get` | read | none | one org | no | read | **t1** | `organizations:read` |
| `…:update` (non-sensitive) | yes, but customers see it at once | **reaches a person** | one org | no | sup | **sup** | `organizations:write`, MFA |
| `…:set_sensitive_access` | **no** (per-host CVE, patch and rack data cannot be un-seen) | **leaves the MSP for the customer** | one org | no | sup | **four-eyes**, Decision 2 | `organizations:write`, MFA |
| `manage_report_recipients:list` | read | none | one report | no | read | **t1** | `reports:read` |
| `…:add` / `convert` | no (a delivery may run first) | **report data reaches a person** | one report | no | sup | **sup** | `reports:write` + **`reports:export`** (tool-only, declared), MFA, Decision 5 |
| `…:remove` | yes, unless it restores a series delivery | as `add` when it restores | one report | no | sup | **sup** | `reports:write`; export + MFA when it restores |

### User and role writes: not built

The brief asks whether these are Tier 3 + four-eyes candidates. **They are candidates only in the sense that a class exists; this plan does not build them** (Decision 1):

- **Spec:** "identity and auth changes: API keys, SSO, role and user writes, service principals" is a standing exclusion. W05 rows 115 and 158 say "every write stays identity". The issue title says read-only.
- **Q4:** a role write changes who holds a permission, including who can approve a four-eyes intent. A four-eyes gate on its own membership is circular: an injected session proposes the grant, and the grant widens the approver pool for the next one.
- **Blast radius outlasts the approval:** a role change applies to every session of every member and has no per-call review after release.
- `mcpCoverage.ts` carries a comment on `users.ts`, `roles.ts` and `orgPortalUsers.ts` naming the writes as `identity`, so they read as decided rather than forgotten. `aiGuardrails.tier1WriteActions.contract` stops a write action appearing on these read tools.

### Agent (headless) exposure (spec D4)

| Tool | Agent reachable | Why |
|---|---|---|
| `list_users`, `get_user`, `list_portal_users` | **no**, `AGENT_DENIED_READ_TOOLS` | Names and emails with no device axis (`get_user_risk_scores` reasoning) |
| `list_roles` | **no**, `AGENT_DENIED_READ_TOOLS` | The permission matrix plus who holds what; no operational need |
| `get_org_summary`, `get_account_readiness` | **no**, `AGENT_DENIED_READ_TOOLS` | Agents run at organization scope and these require partner or system, so a catalog row would always refuse |
| `get_audit_retention` | yes | One number, one org; not device data |
| `manage_org_portal_settings`, `manage_report_recipients` | **no**, `AGENT_HUMAN_ONLY_TOOLS` | Customer-visible exposure and a data exit under prompt injection |

All entries need sign-off (Decision 4). `__snapshots__/agentToolCatalog.contract.test.ts.snap` gains eight names.

## Decisions surfaced while planning

1. **Build user and role writes in W18?** The brief says candidates; the spec, W05 and the issue say no.
   - **A: read-only, writes stay `identity` (recommended).** See above.
   - B: four-eyes tools for role assignment and user disable. Real value for offboarding from chat, but needs its own spec with approver-pool rules. Treat as a new feature, not a W18 rider.
2. **Sensitive portal flags: four-eyes action, or human-only?**
   - **A: `set_sensitive_access`, static four-eyes, digest-pinned (recommended).** The class rule says irreversible + leaves the tenant = four-eyes, which is not an exclusion. One action and one resolver.
   - B: omit the flags from the tool; the org Branding tab is the only door. No digest work and one fewer action, but a request in chat gets a refusal.
   - Either way `update` refuses a parent enable that would activate an enabled sensitive child.
3. **`customCss` human-only.** Recommended: excluded from the tool schema. It is served verbatim to customer browsers, and model-authored CSS from a prompt-injected session is a stored write to a customer surface. Alternative: four-eyes with the shared schema's checks. No demonstrated need.
4. **Sign-off on the agent denials** (the registries say entries are added only with sign-off): the six `AGENT_DENIED_READ_TOOLS` and two `AGENT_HUMAN_ONLY_TOOLS` above. For `get_org_summary` and `get_account_readiness`, the alternative is the W15 pattern (reachable, handler refuses org scope), which adds picker rows that can never work. Recommended: deny.
5. **`manage_report_recipients:add` and `convert` always need `reports:export` + MFA, and `convert` accepts only an address already in the report's `config.emailRecipients`.** Recommended: yes, matching the recipient delivery gate in `recipientGate.ts` for every definition. It is declared in the route-binding row's `toolOnly.extra`. Alternative: mirror each route path exactly, which leaves a tool-reachable delivery at `reports:write` alone.
6. **Tool names `list_users` / `get_user`.** Recommended: keep the triage's names. M365 tools carry the `m365_` prefix and `get_active_users` is distinct; descriptions say "Breeze logins" and golden prompts test the choice. Alternative: `list_breeze_users` (+7 B each), following the `manage_catalog` rename (spec D3). Revisit if the golden prompts confuse them.
7. **`get_account_readiness` input.** REST requires 1–200 `orgIds`. Recommended: `orgIds?` capped at 50, and when omitted the caller's first 50 accessible orgs by name with `truncated: true`, so "which customers aren't set up?" takes one call and stays inside `aiTools.outputBudget`. Alternative: require `orgIds`, forcing a `list_organizations` call first.
8. **Recipient functions stay in `routes/reports/recipients.ts`.** The quorum said an extraction must move the path-pinned entries in `partner-wide-write-coverage.test.ts` and `partnerOwnedVisibility.scan.test.ts`. Recommended: export in place (W07-D2), so nothing moves. Alternative: a `services/reportRecipients.ts`, tidier layering, and both contract entries move in the same commit.
9. **Wisp: every W18 tool non-focal, including the org-targeted `get_org_summary`.** The contract pins fourteen focal names, and device-targeted reads such as `get_device_health` are non-focal. Recommended: non-focal, avoiding a Wisp contract change here. Alternative: make `get_org_summary` focal on `orgId` (it is the `get_site` shape) and amend the pin; a working-set improvement worth its own Wisp change.

The quorum raised no disagreement with the structure; its W18 changes are in the plan (below).

## Wiring

| Map | PR A | PR B |
|---|---|---|
| `TOOL_TIERS` | `get_org_summary`, `get_account_readiness`, `get_audit_retention`, `list_portal_users`, `list_users`, `get_user`, `list_roles` all `1` | `manage_org_portal_settings: 1`, `manage_report_recipients: 1` |
| `TIER1_READ_ACTIONS` | `list_roles`: all four | `manage_org_portal_settings: get`; `manage_report_recipients: list` |
| `TIER3_ACTIONS` + `TIER3_SUPERVISED_ACTIONS` | — | `manage_org_portal_settings: update`; `manage_report_recipients: add, remove, convert` |
| `TIER3_ACTIONS` + `TIER3_FOUR_EYES_ACTIONS` | — | `manage_org_portal_settings: set_sensitive_access` |
| `EFFECT_DIGEST_RESOLVERS` (`actionIntents/effectDigest.ts`), `PINNED_EFFECT_DIGEST_REQUIRED_ACTIONS` (`pinnedEffectPolicy.ts`) | — | `manage_org_portal_settings:set_sensitive_access` |
| `MFA_GATED_TOOL_ACTIONS` | — | `manage_org_portal_settings: ['update','set_sensitive_access']`; `manage_report_recipients: ['add','convert']`. Conditional `remove` gated in the shared function |
| `TOOL_PERMISSIONS`, `TOOL_ACTION_EXTRA_PERMISSIONS` | per the table | per the table; `reports:export` extra on `add`, `convert` |
| `TOOL_RATE_LIMITS` | 30/300 s each; `get_account_readiness` 15/300 s | `manage_org_portal_settings` 15/300 s; `manage_report_recipients` 20/300 s |
| `AGENT_DENIED_READ_TOOLS` | six entries | — |
| `AGENT_HUMAN_ONLY_TOOLS` | — | two entries |
| `agentToolCatalog.ts` `TOOL_CAPABILITY` | `get_audit_retention: 'automations_reports'` beside `query_audit_log`. Denied tools get no row | — |
| `RAW_TEXT_FIELDS_BY_TOOL` | user, contact and portal names and emails; role names and descriptions; org and integration labels | portal text fields; contact names and emails |
| `mcpCoverage.ts`, `FROZEN_GAPS` | six modules → `{ tools }`, −6 | `orgPortalSettings.ts`, `reports/recipients.ts` → `{ tools }`, −2 |
| `WISP_NON_FOCAL_TOOLS` | seven names | two names |
| `DOMAIN_VOCABULARY` | `admin` + `, users and roles`; `accounts` + `, portal` | — |

Domains: `accounts` for `get_org_summary`, `get_account_readiness`, `list_portal_users`, `manage_org_portal_settings` (the org record page pre-expands this block). `admin` for `list_users`, `get_user`, `list_roles`, `manage_report_recipients`. `security` for `get_audit_retention`, beside `query_audit_log`.

### Locale labels (8 locales: en de-DE es-419 fr-CA fr-FR it-IT pt-BR tr-TR)

Only agent-reachable tools are in the catalog, so W18 adds exactly one label: `aiAgentsPage.catalog.tools.get_audit_retention` in `apps/web/src/locales/*/settings.json`. `agentToolCatalog.labels.contract` checks `en`, `apps/web/src/lib/i18n/localeParity.test.ts` the other seven, and `translationCoverage.test.ts` caps exact-English duplicates, so translate. If Decision 4's alternative is taken, each newly reachable tool needs its own label in all 8, plus action labels where it multiplexes.

## Budget

Measured on `36f9d9ca53` with a registry probe over `listChatSurfaceToolNames()`; "after" is computed from the rendered entry strings. T4 and T8 re-measure and replace these. The W17 column assumes W17 merged first (it adds 19 B of always-on).

| Measure | Bound | Before | After PR A | After PR B | After B with W17 |
|---|---|---|---|---|---|
| Always-on (lazy) | B1 < 2,560 | 2,507 | 2,532 (+25) | 2,532 | 2,551 |
| `accounts` block | B2 < 2,048 | 377 | 436 | 498 | 498 |
| `admin` block | B2 < 2,048 | 306 | 379 | 431 | 431 |
| `security` block | B2 < 2,048 | 1,644 | 1,665 | 1,665 | 1,665 |
| Largest block | B2 < 2,048 | `devices` 1,720 | unchanged | unchanged | unchanged |
| Worst page turn (alert) | B3 < 7,040 | 5,298 | 5,323 | 5,323 | 5,342 |
| Org record page turn | B3 < 7,040 | 2,908 | 2,992 | 3,054 | 3,073 |
| Whole index (`AI_TOOL_INDEX=full`) | none since W19 | 11,496 | 11,649 | 11,763 | 11,934 (informational) |

- **+128 B step rule:** a wave that exceeds a bound raises it by exactly +128 B in its own commit, bytes stated in the PR body, never above 7,680 B. No bound is exceeded here, so no step. The whole-index ceiling was retired by W19; `full` is informational.
- **`aiToolIndex.test.ts` pins always-on at an exact byte count** (2,507 today, near `:431`), so each vocabulary change updates the pin. `aiToolIndex.w15-budget.test.ts` stays green at these values.
- **Only 9 B of B1 would remain.** If T4 measures B1 ≥ 2,550 after a rebase, drop `, portal` (8 B) first and record it. W16 should plan on no vocabulary room.
- **`MCP_TOOL_COUNT_APPROX`:** registry 351, pin 350 ± 10. With W17 on `main`, PR A reaches 363 and goes red: bump to 360 in its own commit (`~360 tools` in `MCP_SERVER_INSTRUCTIONS` follows). Without W17, the bump lands whenever the count first passes 360.

## Golden prompts (`llm/toolEval/goldenPrompts.ts`)

Ids continue from the current maximum at implementation time; `goldenPrompts.test.ts` pins the count (+6 PR A, +3 PR B).

| PR | Prompt | Expect |
|---|---|---|
| A | "Give me a quick overview of Contoso." | `get_org_summary` |
| A | "Which of our customers aren't fully set up?" | `get_account_readiness` |
| A | "How long do we keep Contoso's audit logs?" | `get_audit_retention` |
| A | "Who has portal access at Contoso?" | `list_portal_users` |
| A | "Which of our technicians don't have MFA turned on?" | `list_users` (not `m365_query_users`, not `get_active_users`) |
| A | "What can someone with the Technician role actually do?" | `list_roles:effective_permissions` |
| B | "Turn on the reports section of Contoso's portal." | `manage_org_portal_settings:update` |
| B | "Show Contoso per-host vulnerability detail in their portal." | `manage_org_portal_settings:set_sensitive_access` |
| B | "Add Dana to Contoso's monthly report." | `manage_report_recipients:add`, `list_org_contacts` |

## Quorum (codex `exec`, read-only, xhigh, gpt-6-astra): AGREE WITH CHANGES

One round across W17 and W18. W18 findings, each verified by reading the cited code before accepting:

- **Parent flags cross the four-eyes boundary:** accepted, `update` refuses and the check holds a row lock (Fact 1, T6).
- **`remove` can restore delivery:** accepted, the conditional predicate moves with the code (T7).
- **Router gates must move with the handlers:** accepted (T1).
- **The new four-eyes action needs a digest decision (`effectDigestCoverage.contract`):** accepted, resolver and mandatory pin (T6).
- **Recipient extraction affects path-pinned contracts (`partner-wide-write-coverage.test.ts`, `partnerOwnedVisibility.scan.test.ts`):** resolved differently from the suggestion, Decision 8: the functions stay in `routes/reports/recipients.ts` and are exported (W07-D2), so both pinned paths stay valid.
- **`get_org_summary` / `get_account_readiness` can never run for agents:** accepted, denied rather than catalogued (Decision 4).
- **The exact-byte always-on pin:** accepted (T4).

## Execution split and parallelism

Web seam: only `tierConfig.ts` and one locale key, driven by final tool names, so there is no API/web contract to coordinate.

**PR A**
- **PARALLEL GROUP A (file-disjoint):** T1 (`users.ts`, `roles.ts`, new directory services) and T2 (`orgSummary.ts`, `orgAccountReadiness.ts`, `orgPortalUsers.ts`, `orgAuditRetentionSettings.ts`, new services).
- **SERIAL:** T3 handlers (needs both) → T4 wiring, index, golden, copy → T5 integration, PR.
- **Sonnet-eligible:** T4's `tierConfig.ts`, locale key and docs. Opus for T1–T3 and T5.

**PR B** (after A merges, from fresh `main`)
- **PARALLEL GROUP B (file-disjoint):** T6 (`orgPortalSettings.ts`, `effectDigest.ts`, `pinnedEffectPolicy.ts`, new service and handler) and T7 (`reports/recipients.ts`, new handler).
- **SERIAL:** T8 wiring, index, golden, copy → T9 integration, PR.
- **Opus throughout PR B** except T8's mechanical rows: it carries a four-eyes surface and a data exit.

## Tasks

Test commands: from `apps/api`, `pnpm exec vitest run <file>`. Never `pnpm --filter <pkg> test -- --run <path>`. TS: `tsc --build tsconfig.tests.json` with a 20 GB heap, and check the exit code, not `| tail`. Integration suites need `pnpm test-stack up` and do not run under `pnpm test`; tear down with `pnpm test-stack down`.

### Task 1 (PR A): directory services with the router gates

**Files:** Create `services/userDirectory.ts`, `services/userDirectory.test.ts`, `services/roleDirectory.ts`, `services/roleDirectory.test.ts`. Modify `routes/users.ts`, `routes/roles.ts` to call them; route suites stay green unchanged.

**Interfaces — Produces:**
- `hasFullPartnerMembership(auth): Promise<boolean>`: the `partnerUsers.orgAccess === 'all'` check from the `userRoutes` middleware, which now calls it.
- `listScopedUsers(auth): Promise<ScopedUserRow[]>`, moving `annotateMfaProtected` and `annotateMfaStatus` verbatim. `getScopedUser` moves here too; `getScopedUserForCaller(auth, userId)` adds the gate.
- `listRolesForCaller(auth, focusedOrgId?)`, `getRoleDetailForCaller(auth, roleId, focusedOrgId?)`, `listRoleUsersForCaller(...)`, `getRoleEffectivePermissionsForCaller(...)`. Each applies `canManagePartnerWidePolicies` for partner scope, then `resolveRoleActingScope`.
- All return `{ ok: true, value } | { ok: false, code: 'FORBIDDEN'|'NOT_FOUND' }`, never `HTTPException`. Routes map that to the current status and body.

- [ ] Step 1: failing tests:
  - `selected-org partner caller refused by listScopedUsers and listRolesForCaller`;
  - `system scope without a partner or org context is refused` (`getScopeContext` parity);
  - `listScopedUsers drops roleForceMfa, mfaEpoch, grace columns and keeps mfaStatus`;
  - `foreign role and missing role return the same NOT_FOUND`;
  - `a role's scope comes from the role row, not from focusedOrgId`.
- [ ] Step 2: run, expect FAIL.
- [ ] Step 3: move the code; the routes become thin. Re-run `routes/users*.test.ts` and `routes/roles*.test.ts` unchanged.
- [ ] Step 4: expect PASS. Commit `refactor(api): W18 user and role reads as shared operations (#6789)`.

### Task 2 (PR A): org read services

**Files:** Create `services/orgSummary.ts`, `services/orgAccountReadinessResponse.ts`, `services/portalUserDirectory.ts`, each with a test. Modify `routes/orgSummary.ts`, `routes/orgAccountReadiness.ts`, `routes/orgPortalUsers.ts`.

**Interfaces — Produces:**
- `buildOrgSummary(orgId: string, can: (grant) => boolean): Promise<OrgSummary | null>`.
- `buildAccountReadinessResponse(input: { partnerId: string; orgIds: string[]; accessibleOrgIds: string[] | null; can }): Promise<AccountReadinessResponse>`, with `shapeOrg` and its types moved; the route re-exports types its importers use.
- `listPortalUsersForOrg(orgId): Promise<PortalUserListItem[]>`. `effectivePortalStatus` moves with it and stays exported from the route for existing importers.

- [ ] Step 1: failing tests:
  - `summary sections absent without their grant` (table across devices, alerts, tickets, contracts, invoices, portalUsers, lastActivityAt);
  - `readiness capabilities false without their grant; no section computed`;
  - `an org outside accessibleOrgIds is dropped, and a null list only for system`;
  - `portal user list carries no passwordHash` (a sentinel in the column, byte scan of `JSON.stringify`) and `effectiveStatus` is `pending_setup` without one.
- [ ] Step 2: run, expect FAIL.
- [ ] Step 3: move the code. Route suites stay green unchanged.
- [ ] Step 4: expect PASS. Commit `refactor(api): W18 org summary, readiness and portal users as shared operations (#6789)`.

### Task 3 (PR A): read tools

**Files:** Create `services/aiToolsOrgAdminReads.ts`, `services/aiToolsIdentityReads.ts`, `services/aiToolCallerPermissions.ts` (exports `aiCallerPermissions`, moved from `aiToolsFleet.ts`), `services/aiToolSchemasOrgAdmin.ts`, tests for each handler module.

**Interfaces — Produces:**
- `registerOrgAdminReadTools`, `registerIdentityReadTools`, `orgAdminToolSchemas`.
- Inputs (`.strict()`): `get_org_summary { orgId }`; `get_account_readiness { orgIds?: uuid[] (1–50), partnerId? (system only) }`; `get_audit_retention { orgId? }`; `list_portal_users { orgId, limit?: 1–100 }`; `list_users { limit?: 1–200 }`; `get_user { userId }`; `list_roles { action, roleId?, orgId? }`.

- [ ] Step 1: failing tests:
  - `organization scope refused by get_org_summary, get_account_readiness, list_portal_users`;
  - `get_audit_retention: org caller only its own org; foreign org same not-found as missing`;
  - `get_org_summary: inaccessible org same not-found as missing`;
  - `device-bound session refused by get_org_summary and get_account_readiness` (`deviceBoundDenied`);
  - `readiness: omitted orgIds uses the first 50 accessible by name and sets truncated`; `51 ids refused`;
  - `list_users caps at limit and sets truncated`;
  - `list_roles requires roleId except for list`;
  - `HTML-ish and delimiter-forging names are fenced`, with a control;
  - `action enum and input keys are exact` (no write verb on any tool).
- [ ] Step 2: run, expect FAIL.
- [ ] Step 3: implement over T1 and T2.
- [ ] Step 4: expect PASS. Commit `feat(ai-tools): W18 org admin and identity read tools (#6789)`.

### Task 4 (PR A): wiring, index, golden, copy, coverage

**Files:** Every PR A cell of the Wiring table; `services/aiTools.ts`, `services/aiToolSchemas.ts`, `services/aiAgentSdkTools.ts`, `services/aiToolIndex.ts`, `aiToolIndex.test.ts`, `llm/toolEval/goldenPrompts.ts`, `goldenPrompts.test.ts`, `__tests__/mcp-coverage.test.ts`, `apps/web/src/components/ai-risk/tierConfig.ts`, `apps/web/src/locales/*/settings.json`, `apps/docs/src/content/docs/features/ai.mdx`, `.../mcp-server.mdx`. Tests: `W18A_EXPECTED` in `aiGuardrails.approvalScope.contract.test.ts`; route-binding rows (summary, readiness, retention GET, portal-users GET, users `/` and `/:id`, roles `/`, `/:id`, `/:id/users`, `/:id/effective-permissions`); `aiToolSchemas.orgAdmin.test.ts`.

- [ ] Step 1: write the failing rows, plus `every W18 identity read stays in AGENT_DENIED_READ_TOOLS`.
- [ ] Step 2: add the entries. Measure B1, B2, B3, org page and full; replace the Budget column; update the exact-byte pin.
- [ ] Step 3: run the sweep: `aiGuardrails.{approvalScope,routeBinding,routeParity,tier1WriteActions,agentPrincipal,mcpTier3ActionDowngrades,tierDecidingKeys}.contract`, `aiAgentSdkTools.{registryParity,handlerCoverage}.contract`, `aiToolPermissionsCatalogParity.contract`, `aiTools.{descriptionBudget,outputBudget,domainMetadata,deviceTextFence,userOwnedRelease}.contract`, `mcpToolPresentation.guardrailParity.contract`, `wisp/toolSubjects.contract`, `__tests__/parkedFanout.contract`, `__tests__/mcp-coverage`, `mcpGuidancePromptTools`, `aiGuardrailsTierConfig.parity`, `aiGuardrailsAiDocs.parity`, `actionIntents/approvalLabels.contract`, `aiAgents/agentToolCatalog.contract` (snapshot updated deliberately), `aiAgents/agentToolCatalog.labels.contract`, `aiToolIndex`, `aiToolIndex.w15-budget`, `aiAgent.toolIndexPrompt`, `goldenPrompts`, `lazyIndexCases`; web `localeParity`, `translationCoverage`. All PASS.
- [ ] Step 4: commit `feat(ai-tools): W18 PR A guard classes, index, labels and docs (#6789)`. `MCP_TOOL_COUNT_APPROX` in its own commit if red.

### Task 5 (PR A): integration, merge `main`, PR

**Files:** Create `__tests__/integration/aiToolsOrgAdminScope.integration.test.ts`.

Cases, as `breeze_app` on a per-worktree test stack:
- `list_users` as a partner member with `orgAccess: 'selected'` is refused, and with `'all'` returns only that partner's members. Control: lifting the gate goes red.
- `list_roles` never returns another partner's custom role.
- `get_org_summary` for an org of another partner is not found.
- `list_portal_users` byte scan on a real row with a password hash.

- [ ] Step 1: `pnpm test-stack up`, run, expect PASS, `pnpm test-stack down`.
- [ ] Step 2: TS check (20 GB heap, exit code checked), `tsc --noEmit` in `apps/web`. Merge `origin/main`, re-run T4's sweep and re-measure.
- [ ] Step 3: PR: tool/class table, sign-off lines for the six denials, measured budget, Merge Danger (two-way; verbatim extractions), chat smoke prompts. `Part of #6789`, `Part of #6754`. Integration runs only in CI's `integration-test`, so wait for it.

### Task 6 (PR B): `manage_org_portal_settings`

**Files:** Create `services/orgPortalSettingsService.ts` + test, `services/aiToolsOrgPortalSettings.ts` + test. Create `services/aiToolSchemasOrgPortalSettings.ts`. Modify `routes/orgPortalSettings.ts`, `services/actionIntents/effectDigest.ts`, `services/actionIntents/pinnedEffectPolicy.ts`.

**Interfaces — Produces:**
- `getOrgPortalSettings(org: { id; partnerId })` (the route's GET body, `partnerInvoiceFooter` and `partnerPrimaryColor` included).
- `applyOrgPortalSettings(orgId, body, actorUserId, opts?: { refuseSensitiveActivation?: boolean })`: `{ ok: true; settings } | { ok: false; code: 'SENSITIVE_ACTIVATION'; children: string[] }`. Runs in one transaction with `SELECT … FOR UPDATE` on the `portal_branding` row, then the upsert, then `onPortalFlagsChanged` after commit. REST calls it without the option, so REST behaviour is unchanged.
- `PORTAL_SENSITIVE_PARENTS = { enableNetworkVisibility: ['enableNetworkAlerts','enablePhysicalPlacement'], enableSupportUsage: ['enableHourBlock'] } as const`.
- `update` input = `updatePortalSettingsSchema` minus `customCss`, `PORTAL_SENSITIVE_FLAG_KEYS`, `PORTAL_PERMISSION_FLAG_KEYS`; `chromeAccent` retained; `.strict()`.
- `set_sensitive_access` input `{ orgId, flags }`, `flags` a `.strict()` non-empty object of `PORTAL_SENSITIVE_FLAG_KEYS ∪ PORTAL_PERMISSION_FLAG_KEYS ∪ keys(PORTAL_SENSITIVE_PARENTS)`.
- Digest resolver: hashes `orgId`, the requested `flags`, and the row's current values of every key in that union; missing row hashes as defaults.

- [ ] Step 1: failing tests:
  - `update rejects customCss and every sensitive and permission key` (schema);
  - `update refuses a parent enable that activates a sensitive child`, `allows it when no child is on`, `allows a parent disable`;
  - `the check and the write share one row lock` (mock `for('update')` before the upsert);
  - `get output fences welcomeMessage, footerText, customCss`;
  - `set_sensitive_access is four_eyes via resolveApprovalScope` and `requiresPinnedEffectDigest` is true;
  - `release after drift refuses` (flags change between pin and release);
  - `the org scope and a site-restricted session are refused`;
  - `PORTAL_SENSITIVE_PARENTS is exhaustive`: a scan over `routes/portal/*.ts` asserting each sensitive read sits under a known parent gate or stands alone;
  - `route: PATCH unchanged` (existing suite green).
- [ ] Step 2: run, expect FAIL, and confirm `effectDigestCoverage.contract` goes red for the new surface once classes land.
- [ ] Step 3: implement. If the handler passes `auth.user.id` to the service, register it in `aiTools.userOwnedRelease.contract` (`SAFE_WRITE_SITES` is keyed by file and line, so do this last).
- [ ] Step 4: expect PASS. Commit `feat(ai-tools): W18 portal settings tool with a four-eyes sensitive action (#6789)`.

### Task 7 (PR B): `manage_report_recipients`

**Files:** Create `services/aiToolsReportRecipients.ts` + test, `services/aiToolSchemasReportRecipients.ts`. Modify `routes/reports/recipients.ts` to export its operations in place (W07-D2). Leaving the functions in this file keeps `partner-wide-write-coverage.test.ts:448` and `partnerOwnedVisibility.scan.test.ts:130` valid.

**Interfaces — Produces, exported from `routes/reports/recipients.ts`:**
- `listReportRecipients(reportId, auth, permissions)`, `addReportRecipient(...)`, `removeReportRecipient(...)`, `convertReportRecipient(..., opts?: { requireLegacyAddress?: boolean })`, returning `{ ok: true; value } | { ok: false; code; status }`, with each `writeRefusal` code preserved.
- Tool input (`.strict()`): `{ action, reportId, contactId?, mode?: 'add'|'remove', email?, name? }`.

- [ ] Step 1: failing tests:
  - `add refused without reports:export or without MFA, on a plain and on a series definition`;
  - `convert: an address not in config.emailRecipients is refused, and nothing is written`;
  - `remove of a series 'remove' row without export + MFA is refused and the row stays`;
  - `remove of an 'add' row needs only reports:write`;
  - `partner-owned, system-managed and partner-only-delivery definitions: writes refused with the route's code; list empty for partner-owned`;
  - `a report hidden from the caller is NOT_FOUND`;
  - `a contact from another org is NOT_FOUND`;
  - `convert writes the contact audit event`.
- [ ] Step 2: run, expect FAIL.
- [ ] Step 3: implement; the Hono handlers become thin over the exports, with the existing route suite green unchanged. The conditional DELETE predicate moves intact.
- [ ] Step 4: expect PASS, plus `partner-wide-write-coverage` and `partnerOwnedVisibility.scan`. Commit `feat(ai-tools): W18 report recipient tool (#6789)`.

### Task 8 (PR B): wiring, index, golden, copy, coverage

As T4, for the PR B column. Approval copy (exact):
- `update`: "Change {changedFields} on {org}'s customer portal. Customers see this immediately."
- `set_sensitive_access`: "Let {org}'s portal users see: {labels of flags turned on}. Remove: {labels turned off}. Data seen in the portal cannot be recalled."
- `add`: "Send {report} to {contact} on its schedule. Report data leaves Breeze by email."
- `remove`: "Stop or restore delivery of {report} for {contact}."
- `convert`: "Move {email} on {report} to a contact recipient."

- [ ] Step 1: add `W18B_EXPECTED` and route-binding rows (portal-settings GET/PATCH twice; recipients GET/POST/DELETE/convert, with `toolOnly.extra` on add and convert).
- [ ] Step 2: add the entries; measure and update the pin; run T4's sweep plus `actionIntents/effectDigestCoverage.contract`.
- [ ] Step 3: commit `feat(ai-tools): W18 PR B guard classes, index and docs (#6789)`.

### Task 9 (PR B): integration, merge `main`, PR

**Files:** Create `__tests__/integration/aiToolsOrgAdminWrites.integration.test.ts`.

Cases: `update` refusal under a real row lock with a sensitive child on; a four-eyes intent released after a concurrent flag change refuses and writes nothing; a recipient `add` in org A against org B's contact is not found; series exclusion delete without the gate leaves the row.

- [ ] Step 1: run on a per-worktree stack; `pnpm test-stack down` after.
- [ ] Step 2: TS check, merge `origin/main`, re-run the sweep and re-measure.
- [ ] Step 3: PR with class table, the four-eyes sign-off line, digest fields, budget, Merge Danger (two-way, no data change; REST unchanged). `Closes #6789`, `Part of #6754`.

## Follow-ups (not filed)

- User and role writes, if ever: a spec of their own (Decision 1).
- A focal Wisp entry for `get_org_summary` (Decision 9).
- Pagination for `list_users` and `list_portal_users` if a tenant exceeds the caps.
