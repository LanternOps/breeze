---
title: Configuration policies UX reshape (implementation plan, W1 W2 W3 W5)
spec: docs/superpowers/specs/config-policy/2026-11-21-config-policy-ux-reshape-spec.md
status: plan-drafted
anchor_issue: LanternOps/breeze#12306
---

# Configuration Policies UX Reshape Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tech can read, on one page, what a policy sets, where it applies and whether it is active. A saved policy that applies to nothing says so on the page and in the list. Where a policy applies is edited in one place and committed as one stated change. A new policy is inactive until someone activates it.

**Architecture:**
- **W1 (UI, #12306).** The list and detail reads gain an additive applies-to summary (`appliesTo`), computed by a new service in the caller's own request context. The detail page gets an always-visible Applies-to strip that opens today's editors in a drawer. The list gets an Applies-to column. The device Config tab links the winning policy and says why each other policy lost. One shared, translated label set serves the editor, the list and the device tab.
- **W2 (assignment writes).** A diff-shaped `POST /:id/assignments/apply`, with a dry run, runs the same gates as today's single POST, extracted into one module. A reach read (`direct`, `throughChildren`, `organizations`) runs in the caller's context. One applies-to panel replaces `AssignmentsTab`, `OrganizationScopePanel` and `PartnerGroupAssignmentSection`. The target listing includes MSP-managed policies for partner-scope callers.
- **W3 (read scoping, page shape, create).** A read predicate decides which MSP-managed policies a caller may list, open or name. `policyAccessCondition` stays the write-side reader. The page gets a grouped feature rail (no Overview), one save pattern per control, one-page create that saves `status: 'inactive'`, explicit Activate, and the MSP-managed owner default.
- **W5.** "Outranked on N devices" per feature, and Copy.
- **W4** (device-own settings) belongs to the companion spec, which is not approved. It is not planned here.

**Tech stack:** TypeScript, Hono, Zod 4, Drizzle (queries only), Postgres forced RLS, React + Astro + react-i18next (8 locales), Vitest, Playwright (`data-testid` only).

**Spec:** `docs/superpowers/specs/config-policy/2026-11-21-config-policy-ux-reshape-spec.md` (approved 2026-11-21). Read it with this plan. The plan links to spec sections rather than restating them.

**Baseline.** Written against `origin/main` `46f3a89d01`, plus three docs-only spec commits on `spec/config-policy-ux-reshape` (`0407fbcf2e`, `1ec5be12a3`, `5570293812`). No code differs from `origin/main`. Every symbol below was read on that tree. **Every part's Step 0:** run `git fetch origin main`, then check the state, not a commit subject:
- `git show origin/main:apps/api/src/services/configurationPolicy.ts | grep -c hasPartnerWideAssignment` is non-zero (the baseline list shape).
- `git cat-file -e origin/main:apps/web/src/components/configurationPolicies/AppliesToStrip.tsx` fails for W1 parts and succeeds for W2 and later parts.
- `git cat-file -e origin/main:apps/web/src/components/configurationPolicies/appliesTo/AppliesToPanel.tsx` succeeds for W3 and W5 parts.

If a check disagrees with what the part expects, stop and report.

## Global Constraints

- **Rigor.**
  - W01a is medium: a new read model over RLS. It gets an integration test.
  - W01b is UI: red first, typecheck, targeted tests.
  - W2 and W3 are high. Each task writes its test first. Each part runs its contract suites and gets one independent Opus review round.
  - W05a is high (it reads across tenants). W05b is high (it is a write that crosses owners).
- **One PR per part, base `main`, never stacked.** A PR whose base is not `main` runs no CI; if one is stacked anyway, run `gh workflow run CI --ref <branch>`. Merge with a bare `gh pr merge <N>`.
- **No migrations, no new tables, no new columns, no RLS change in any wave** (spec "Tenancy & data model impact"). Every part states `Migration slot: none`. A part that finds it needs one stops and raises it.
- **Tests.**
  - API: `cd apps/api && npx vitest run <exact files…>`.
  - Web: `cd apps/web && npx vitest run <exact files…>`.
  - Shared: `cd packages/shared && npx vitest run <files>`.
  - Never `pnpm --filter <pkg> test -- --run <path>`. Path filters are substring matches: list dotted siblings explicitly (`crud.test.ts crud.hpCmsl.test.ts …`). A run that reports 0 files is a stall, not a pass.
- **Integration suites** run only in the CI "Integration Tests" job. Locally, run `pnpm test-stack up` once, then `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/<file>`. Tear it down afterwards with `pnpm test-stack down`, and say so.
- **Typecheck.** Read exit codes directly, never through a pipe to `tail`.
  - API: `NODE_OPTIONS=--max-old-space-size=12288 pnpm exec tsc --build apps/api/tsconfig.tests.json; echo "exit=$?"` from the repo root. An OOM is not a pass.
  - Shared: `cd packages/shared && npx tsc --noEmit; echo "exit=$?"`.
  - Web: `cd apps/web && pnpm exec astro check; echo "exit=$?"`, then `pnpm lint`.
- **DB context.**
  - Every new read runs in the caller's `withDbAccessContext`, never a system context (spec API change 2).
  - A write path that must roll back on a mapped 4xx runs its writes in `withDbTransaction(() => …)`, with the catch outside. The request transaction commits whenever the handler returns, including a 409.
  - Never start `withDbTransaction` beside siblings in a `Promise.all`.
- **Web mutations.**
  - Every POST/PUT/PATCH/DELETE goes through `runAction` (`apps/web/src/lib/runAction.ts`), with the CLAUDE.md catch pattern.
  - A file this plan migrates is added to `TARGET_GLOBS` in `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`. `MIN_GUARDED_FILES` is 286 against about 316 entries; a part that deletes guarded files adds their successors first.
  - A dry-run POST, which writes nothing and must not toast, carries a reasoned `// runaction-exempt:` marker.
- **URL state.**
  - The selected feature stays in `window.location.hash` (`useHashTab`, `apps/web/src/lib/useHashState.ts`; guard `no-hash-in-usestate.test.ts`).
  - `#assignments` stays a working alias. It opens the Applies-to drawer (W1b), following the `LEGACY_TAB_ALIASES` pattern in `ConfigPolicyDetailPage.tsx`.
  - Drawer open state is local React state: it is an overlay, not a navigable view.
- **Locales.**
  - Every new or changed `en` key goes into all 8 locales: en, de-DE, es-419, fr-CA, fr-FR, it-IT, pt-BR, tr-TR. A changed `en` value is retranslated in the other seven; `localeParity` checks keys only.
  - Contracts: `apps/web/src/lib/i18n/{localeParity,translationCoverage,keyUsage,titleKeyUsage,terminologyQuality}.test.ts` and `apps/web/src/locales/humanizedKeyRegression.test.ts`.
  - `t(cond ? a : b)` fails `keyUsage`. A dynamic key carries `/* i18n-dynamic */`, and every value must exist.
  - **Key leaves never equal the word they hold** (`humanizedKeyRegression`). Feature labels live at `configurationPolicies.featureNames.<featureType>.label`, not `featureLabels.backup = "Backup"`.
- **Files** aim to stay under about 500 lines. `services/configurationPolicy.ts` (3,702 lines), `routes/orgs.ts` and `ConfigPolicyDetailPage.tsx` (809) are already over, so new logic goes into new files.
- **New service files** must be classified if `apps/api/src/__tests__/parkedFanout.contract.test.ts` discovers them (read models go in VISIBILITY_MODULES). A new route file needs an `MCP_COVERAGE` entry (`apps/api/src/services/mcpCoverage.ts`; contract `__tests__/mcp-coverage.test.ts`). Run both in every API part.
- **Docs.**
  - User-facing changes update `apps/docs/src/content/docs/features/configuration-policies.mdx` (use the `update-breeze-docs` skill), then regenerate the index: `npx tsx scripts/build-docs-index.ts` from the repo root. `apps/api/src/services/aiToolsDocs.test.ts` fails on a stale index.
  - Two pages link `#policy-ownership-organization-vs-partner-wide` (`features/patch-management.mdx`, `features/policy-management.mdx`). A heading rename updates both links.
  - Exactly one part per wave owns `apps/docs/**` and `docsIndex.json`.
- **Release notes.** Each wave appends one entry under `## Features / API` in `docs/release-notes/next-release-draft.md`. **Append only; rebase just before opening the PR.** One part per wave owns the append.
- **Public repo.** No hostnames, IPs, regions, tenant or customer names. Test fixtures use generic names (`Acme`, `Birch`).
- **Permissions (unchanged).** Config-policy reads are `devices.read`; writes are `devices.write` + `requireMfa()`. Any write on a partner-owned policy also needs `canManagePartnerWidePolicies(auth)`. Site-restricted callers go through `authorizeAssignmentTarget` and `canMutateOrgWideGovernance`.
- **Settings Rule 9.** No part adds a setting. A part that touches a `*Settings*` component (W03b extends `SettingsSectionNav`) states in its PR: "adds no setting; places the concept is configured: unchanged".
- **Names and values (verbatim).**
  - `APPLIES_TO_SUMMARY_TARGET_LIMIT = 3`.
  - The precedence legend (spec "Applies-to editor"): "Most specific wins, per feature: Device › Device group › Site › Organization › All organizations. A closer policy replaces the whole feature; it does not merge."
  - Routes: `POST /api/v1/configuration-policies/:id/assignments/apply`, `GET /api/v1/configuration-policies/:id/reach`, `GET /api/v1/configuration-policies/reach?ids=…` (W2); `GET /api/v1/configuration-policies/:id/precedence`, `POST /api/v1/configuration-policies/:id/copy` (W5).
  - Rail groups (spec Decision 5): Updates & software · Monitoring · Security · Backup · Access & end user · Lifecycle.

## Review Focus

Five conditions the spec implies that no single route test exercises. Each is pinned by a named test in its owning task.

1. **A site-restricted tech opens a policy applied at organization level.** `GET /:id/assignments` hides that row from them, so a warning derived from it would say "Not applied" when it is not. Expect the strip to show the policy as applied, with "+1". Tests: W01a `assignmentCount counts rows the caller may not list`; W01b `strip never says Not applied when assignmentCount > 0`.
2. **A parent policy with no assignments of its own, whose child policies are assigned.** A parent is never inert (spec "Inheritance display"). Expect "In use through 2 policies", not the warning, on the page and in the list. Tests: W01a `childPolicyCount counts children`; W01b `a parent with children reads In use through N policies`.
3. **The web is a release ahead of the API, so `appliesTo` is absent.** Expect no warning and no applies-to claim, the same way the list treats a missing `featureLinks`. Test: W01b `absent appliesTo renders unknown, never Not applied`.
4. **Apply races another editor.** A row added from the Site page after the panel loaded must survive an Apply. An add that collides with an existing row rolls the whole Apply back. Tests: W02b integration `an Apply leaves a row it was not told about` and `a colliding add rolls back the whole Apply`.
5. **An org-scope tech follows the winning-policy link to an MSP-managed policy before W3.** Today that page answers 404. Expect the policy name with "Managed by your MSP", not a dead link. Test: W01b `an org-scope caller sees no link to an MSP-managed winner`.

## Decisions taken in this plan

Each is flagged in its PR body.

- **D1. W1 is two PRs.** W01a is the API summary. W01b is all web, locales, docs and E2E. W01b builds against the declared shape and treats a missing field as unknown, so either can merge first. Merge order: W01a, then W01b.
- **D2. "Not applied" uses an unfiltered count.** `assignmentCount` counts every assignment row the caller's RLS context reads. `targets` holds only rows that pass both of these:
  - `authorizeAssignmentTarget` admits them (the same filter `GET /:id/assignments` applies);
  - their target name resolves in the caller's context. A `partner` row needs no name.

  Every other row counts only toward "+N". The warning never depends on the caller's site ceiling, and the summary never sends a target the caller cannot name.
- **D2a. The warning follows status** (spec "States": "active but not applied (warning)"). A web helper decides it: `notAppliedTone(status, state): 'warning' | 'neutral' | null`.
  - An active, unapplied policy with no children is `warning`: "Not applied to any device".
  - An inactive one is `neutral`: "Not applied yet".
  - An archived one is `null`.
  - `in_use_through_children` is never a warning.
- **D3. The summary goes on the route responses, not in `getConfigPolicy` or `listConfigPolicies`.** Those service functions also feed AI tools, and their outputs must not grow. `crud.ts` merges `loadAppliesToSummaries` into `GET /` rows and into `GET /:id`.
- **D4. The winner link follows the `canOpenParent` rule.** `GET /effective/:deviceId` gains `policyOwners: Record<policyId, 'organization' | 'partner'>`. The route builds it after the resolver, in the caller's context, leaving `resolveEffectiveConfig` and its AI callers unchanged. The web links a policy when the caller is partner-scope or the owner is `organization`; otherwise it shows the name and "Managed by your MSP". The chain rows, which link unconditionally today, follow the same rule. W03a removes the restriction for policies the read rule admits.
- **D5. Why a policy lost, in the resolver's own order** (`LEVEL_PRIORITY`, then priority ascending, then assignment age, in `resolveEffectiveConfigWithExecutor`). This gives three reasons, not the spec's two: `more_specific_level`, `lower_priority_number`, `assigned_earlier`. The web derives them from `sourceLevel`/`sourcePriority` against each chain row. The third is inferred when level and priority tie, because the chain carries no assignment age.
- **D6. One label set; the editor's words win.** "Patches", not "Patch Management"; "Automations", not "Automation". Seven types already use translated keys; their keys are kept.
- **D7. W1 keeps the four feature-state badge strings' English** ("Configured", "Configured (inherited)", "Saved (not deployed)", "Not configured") and only moves them into i18n. Four tab tests pin them (`HelperTab`, `RemoteAccessTab`, `SecurityTab`, `SensitiveDataTab`). W03b changes them to the rail's words: Set here, From parent, Not set.
- **D8. #12306 item 4 ("prompt after the first save").** In W1, a successful create navigates to `/configuration-policies/<id>#assignments`, which opens the Applies-to drawer. W03d replaces this with the activation flow.
- **D9. The W1 drawer reuses `AssignmentsTab` with no behaviour change, and refetches `GET /:id` when it closes.** Both editors commit each toggle at once, so a close-time refetch is enough. No change callback is threaded through three components that W02c deletes. B5 adds only copy changes and E2E `data-testid`s to them. Today `AssignmentsTab` has one testid (`locked-org-target`) and `OrganizationScopePanel` none.
- **D10. Dry run does not reuse `previewEffectiveConfig`.** That function resolves one device's winners inside a forced-rollback transaction. Apply needs the device delta of the policy's own targets. W02b computes the proposed assignment set in memory and expands both sets with the W02a reach service. Nothing is written, so no reconcile scheduler fires.
- **D11. Reach reuses `resolveAssignmentDevices`** (`services/configPolicyAssignmentDevices.ts`), the resolver the patch scheduler and update rings share. That keeps role/OS and group-membership semantics identical. Two additions:
  - `AssignmentExpansionOptions.auditAction` becomes `string | null`, and `null` skips `auditRefusedExecutionGroups`, so a read never writes audit rows;
  - results are memoized per request on `(level, targetId, roleFilter, osFilter, policyOrgId, policyPartnerId)`.
- **D12. The arming and branding gates move into one module** (`routes/configurationPolicies/assignmentGates.ts`), used by the single POST and by Apply. The AI tool `apply_configuration_policy` keeps its own refusal semantics; AI tools are out of scope (spec).
- **D13. W3 read scoping is a separate predicate.** `policyReadCondition(auth)` in a new `services/configPolicyReadScope.ts`. `getConfigPolicy` gains `opts?: { access?: 'read' | 'write' }`, default `'write'`, so every write path keeps `policyAccessCondition`. Only read routes and read embeds pass `'read'`.
- **D14. "Applies to an organization" (the read rule's test) is true for a partner-owned policy when any of these holds:**
  - it has a `partner`-level row of its own partner;
  - an `organization` row names that org;
  - a `site`, `device` or org-owned `device_group` row lives in that org;
  - a partner-owned `device_group` row has a member device in that org;
  - it is the parent of a policy that applies to that org.

  The last clause keeps the parent embed and "Based on X" working for a child the caller can see. See Q5.
- **D15. Rail state lives in `SettingsNavItem.status`.** W03b adds `status?: string` to `SettingsNavItem` in `SettingsSectionNav.tsx`. When set, it renders in place of `description` and is appended to the item's accessible name. Existing callers are unchanged.
- **D16. The unsaved-changes guard sits in `FeatureTabShell`, not in 26 tabs.** The shell marks itself dirty on a bubbling `input` or `change` event inside its body and clears on a save that settles without an error. It also exposes `useFeatureDirty().markDirty()` for picker controls that emit neither. W03b wires `markDirty` into the pickers that call back through `onSelect`: `InlineEntityPicker`, `PolicyLinkSelector`, `SoftwareCatalogPicker`, `RuleSetPicker`, `RemediationScriptPicker`, `OneDriveLibraryPicker`.
- **D17. Copy is not offered before W5.** Where W3 names Copy as the exit (a locked owner or parent, OneDrive Helper on an MSP-managed policy), it states the reason with no action. W05b adds the action at those places.
- **D18. Full rail map** (Decision 5 places only the six newer features; the rest is this plan's proposal, see Q4):
  - **Updates & software:** patch, oem_updates, software_policy.
  - **Monitoring:** monitors, event_log, hardware_monitoring, workload_inventory, time_sync, warranty.
  - **Security:** security, security_agents, containment, vulnerability, sensitive_data, peripheral_control, pam, compliance.
  - **Backup:** backup, system_protection.
  - **Access & end user:** remote_access, helper, onedrive_helper, wake_on_lan.
  - **Lifecycle:** maintenance, automation, device_lifecycle.

## Wave and part map

| Id | Title | Depends on | Merges | Model | Size |
|---|---|---|---|---|---|
| W01a | API: applies-to summary on list and detail; `policyOwners` on effective config | — | first | opus | S |
| W01b | Web: strip and drawer, list column, device Config tab, shared labels, vocabulary, docs, E2E | W01a shape (declared locally) | after W01a | opus (sonnet for locale fan-out) | M |
| W02a | API: reach service and reach routes; site search | W1 merged | first | opus | M |
| W02b | API: gate extraction, `updateAssignment`, Apply with dry run, target-listing fix | W02a | after W02a | opus | M |
| W02c | Web: unified applies-to panel, counts, entry points, docs, E2E | W02a and W02b shapes | last | opus | L |
| W03a | API: read scoping, list filters, `access` on `GET /:id` | W2 merged | **one release unit with W03d** | opus | M |
| W03b | Web: feature rail, header, details form, Overview removed, unsaved guard, read-only viewer | W2 merged | any time after W2 | opus | L |
| W03c | Web: Remove / Reset to parent / Change for this policy; reach lines; Activate and Deactivate | W03b | after W03b | opus | M |
| W03d | Web: one-page create, owner default, Start from, list filters and server paging, docs, E2E | W03a, W03c | with W03a | opus | L |
| W05a | "Outranked on N devices" | W2 merged | — | opus | M |
| W05b | Copy | W3 merged; Q1 and Q2 answered | — | opus | M |

**Release unit W03a + W03d.** The spec ships read scoping with the owner default, not before. W03a does not enqueue until W03d is approved and green. Then they enqueue back to back, W03a first.

**Docs and release-notes owners:** W01b, W02c, W03d, W05a, W05b.

---

## W1 — Applies-to visible, honest copy (#12306)

Spec wave row W1. Gating: none.

### File structure (W1)

**packages/shared (W01a)**
- Create `src/types/configPolicyAppliesTo.ts` and its test. Modify `src/types/index.ts` (export it).

**apps/api (W01a)**
- Create `src/services/configPolicyAppliesTo.ts` and its test.
- Modify `src/routes/configurationPolicies/crud.ts` (`GET /`, `GET /:id`), `crud.test.ts`, `src/routes/configurationPolicies/resolution.ts` (`GET /effective/:deviceId`) and `resolution.test.ts`.
- Create `src/__tests__/integration/configPolicyAppliesToSummary.integration.test.ts`.

**apps/web (W01b)**
- Create:
  - `src/components/configurationPolicies/configPolicyLabels.ts` and its test;
  - `src/components/configurationPolicies/AppliesToStrip.tsx` and its test;
  - `src/components/configurationPolicies/appliesToSummary.ts` (the web-local copy of the response type, re-exporting the shared one) and its test.
- Modify:
  - `ConfigPolicyDetailPage.tsx`, `ConfigPolicyList.tsx`, `ConfigPolicyCreatePage.tsx` and their tests;
  - `featureTabs/types.ts`, `featureTabs/FeatureTabShell.tsx` and `FeatureTabShell.test.tsx`;
  - `components/devices/DeviceEffectiveConfigTab.tsx` and `DeviceEffectiveConfigTab.summaryAndChain.test.tsx`;
  - `AssignmentsTab.tsx`, `OrganizationScopePanel.tsx` and `PartnerGroupAssignmentSection.tsx` (copy only);
  - `locales/*/policies.json` and `locales/*/devices.json` (8 each);
  - `lib/__tests__/no-silent-mutations.test.ts` (add `ConfigPolicyDetailPage.tsx`).
- Create `e2e-tests/pages/ConfigPolicyPage.ts` and `e2e-tests/tests/config-policy-applies-to.spec.ts`.
- Docs: `apps/docs/src/content/docs/features/configuration-policies.mdx`, the two linking pages, `apps/api/src/data/docsIndex.json`, `docs/release-notes/next-release-draft.md`.

### W01a — API: applies-to summary

#### Task A1: The shared summary type and state function

**Files:**
- Create: `packages/shared/src/types/configPolicyAppliesTo.ts`, `packages/shared/src/types/configPolicyAppliesTo.test.ts`
- Modify: `packages/shared/src/types/index.ts`

**Interfaces (produced; W01a A2, W01b and W2 consume these names):**

```ts
export const APPLIES_TO_SUMMARY_TARGET_LIMIT = 3;
export type ConfigPolicyTargetLevel = 'partner' | 'organization' | 'site' | 'device_group' | 'device';
export interface ConfigPolicyAppliesToTarget {
  assignmentId: string;
  level: ConfigPolicyTargetLevel;
  targetId: string;
  name: string | null;            // null only for 'partner' (render "All organizations"); unnamed rows never appear (D2)
  roleFilter: string[] | null;
  osFilter: string[] | null;
}
export interface ConfigPolicyAppliesToSummary {
  assignmentCount: number;        // every row the caller's RLS context reads (D2)
  allOrganizations: boolean;      // a 'partner'-level row exists
  targets: ConfigPolicyAppliesToTarget[]; // ≤ APPLIES_TO_SUMMARY_TARGET_LIMIT rows the caller is authorized to list
  childPolicyCount: number;       // policies whose parent is this one, visible to the caller
}
export type ConfigPolicyAppliesToState = 'applied' | 'not_applied' | 'in_use_through_children';
export function appliesToState(s: ConfigPolicyAppliesToSummary): ConfigPolicyAppliesToState;
export const TARGET_LEVEL_ORDER: readonly ConfigPolicyTargetLevel[]; // ['partner','organization','site','device_group','device']
```

- [ ] **Step 0:** the baseline check (header).
- [ ] **Step 1: Failing tests** in `configPolicyAppliesTo.test.ts`:
  - `appliesToState is applied when assignmentCount > 0, whatever childPolicyCount says`;
  - `appliesToState is in_use_through_children when there are no rows but there are children`;
  - `appliesToState is not_applied when there are no rows and no children`;
  - `TARGET_LEVEL_ORDER runs from most general to most specific`.
- [ ] **Step 2:** `cd packages/shared && npx vitest run src/types/configPolicyAppliesTo.test.ts src/browserSafeBarrel.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement. Export the module from `types/index.ts`.
- [ ] **Step 4:** Rerun. Expected: PASS. Then run the shared typecheck and expect `exit=0`.
- [ ] **Step 5: Commit** `feat(shared): config policy applies-to summary type (#12306)`.

#### Task A2: `loadAppliesToSummaries`

**Files:**
- Create: `apps/api/src/services/configPolicyAppliesTo.ts`, `apps/api/src/services/configPolicyAppliesTo.test.ts`

**Interfaces:**
- Consumes: `configPolicyAssignments`, `configurationPolicies`, `organizations`, `sites`, `deviceGroups`, `devices` (schema); `authorizeAssignmentTarget(auth, level, targetId)` from `services/configurationPolicy.ts`; the A1 types.
- Produces: `loadAppliesToSummaries(auth: AuthContext, policyIds: readonly string[]): Promise<Map<string, ConfigPolicyAppliesToSummary>>`.

The function issues at most four statements, plus one name lookup per level present:
1. The assignment rows for `policyIds`, ordered by `TARGET_LEVEL_ORDER`, then priority, then `createdAt`.
2. One grouped count of `configurationPolicies` where `parentPolicyId IN policyIds`.
3. The name lookups, one select per level among the targets kept: `organizations.name`, `sites.name`, `deviceGroups.name`, and `devices.displayName ?? devices.hostname`.

All statements run on the ambient `db`, in the caller's request context. `authorizeAssignmentTarget` is called per row; it returns at once for an unrestricted caller.

- [ ] **Step 1: Failing tests** (Drizzle mocks, following `services/configPolicyAssignmentDevices.partnerLevel.test.ts` for the mock style):
  - `empty ids return an empty map and run no query`;
  - `targets are ordered partner, organization, site, device group, device and capped at 3`;
  - `assignmentCount counts rows the caller may not list` (`authorizeAssignmentTarget` rejects one of two rows: `assignmentCount` 2, one target);
  - `a partner-level row sets allOrganizations and carries name null`;
  - `a device target is named displayName, else hostname`;
  - `a target whose name lookup returns nothing is left out of targets but counted`;
  - `childPolicyCount counts children`;
  - `a policy with no rows and no children is present with zeros`.
- [ ] **Step 2:** `cd apps/api && npx vitest run src/services/configPolicyAppliesTo.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun, plus `src/__tests__/parkedFanout.contract.test.ts`. Expected: PASS. If the contract names the new file, add it to VISIBILITY_MODULES with the reason "list and detail read model; no fan-out".
- [ ] **Step 5: Commit** `feat(api): applies-to summary read model for configuration policies (#12306)`.

#### Task A3: Wire it into `GET /` and `GET /:id`; `policyOwners` on effective config

**Files:**
- Modify: `apps/api/src/routes/configurationPolicies/crud.ts`, `crud.test.ts`, `apps/api/src/routes/configurationPolicies/resolution.ts`, `resolution.test.ts`

**Interfaces:**
- Produces:
  - `GET /configuration-policies`: each row gains `appliesTo: ConfigPolicyAppliesToSummary`. `hasPartnerWideAssignment` stays (additive; W01b stops reading it).
  - `GET /configuration-policies/:id`: gains `appliesTo`.
  - `GET /configuration-policies/effective/:deviceId`: gains `policyOwners: Record<string, 'organization' | 'partner'>`. The keys are every `sourcePolicyId` and every chain `policyId`, minus the `breeze-defaults` sentinel. The route builds it with one `select id, orgId from configurationPolicies where id in (…)` in the caller's context. An id the select does not return gets no key; the web then treats the owner as unknown and does not link.

- [ ] **Step 1: Failing tests:**
  - `crud.test.ts`, mocking `../../services/configPolicyAppliesTo`:
    - `GET / merges appliesTo into every row`;
    - `GET / asks for the page's ids only`;
    - `GET /:id carries appliesTo`;
    - `GET /:id returns 404 without loading a summary when the policy is not visible`.
  - `resolution.test.ts`:
    - `GET /effective/:deviceId carries policyOwners for winners and chain rows`;
    - `the Breeze Defaults sentinel gets no policyOwners entry`.
- [ ] **Step 2:** `cd apps/api && npx vitest run src/routes/configurationPolicies/crud.test.ts src/routes/configurationPolicies/crud.hpCmsl.test.ts src/routes/configurationPolicies/crud.oemUpdates.test.ts src/routes/configurationPolicies/crud.siteScope.test.ts src/routes/configurationPolicies/resolution.test.ts`. Expected: the new tests FAIL; the rest PASS.
- [ ] **Step 3:** Implement. Call the service after the existing read, never before the 404.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): list and detail carry applies-to; effective config names policy owners (#12306)`.

#### Task A4: Integration proof and PR

**Files:** Create `apps/api/src/__tests__/integration/configPolicyAppliesToSummary.integration.test.ts`. Follow `configurationPolicyOrgScopedPartnerWide.integration.test.ts` for the context fixtures (`createPartner`, `createOrganization`, `createSite`, and the `orgDbContext` shape).

- [ ] **Step 1: Write the cases.** Each runs `loadAppliesToSummaries` inside `withDbAccessContext`:
  - `a partner-scope context names targets in two of its organizations`;
  - `an org-scope context names the site and device group targets of its own policy`;
  - `a parent with an assigned child reports childPolicyCount 1 and assignmentCount 0`;
  - `the summary query runs in the caller's context` (the same call under a context for another partner returns no rows).
- [ ] **Step 2:** `pnpm test-stack up`, then run the file. Expected: PASS. Tear the stack down.
- [ ] **Step 3: Contracts:**
  - `cd apps/api && npx vitest run src/__tests__/mcp-coverage.test.ts src/__tests__/partner-wide-write-coverage.test.ts src/__tests__/site-ceiling-write-coverage.test.ts src/__tests__/parkedFanout.contract.test.ts src/services/aiGuardrails.routeBinding.contract.test.ts`;
  - the API typecheck.
- [ ] **Step 4:** Open PR `feat(api): config policy applies-to summary (#12306)` with `Refs #12306` (W01b carries `Closes`). `Migration slot: none`.

### W01b — Web: strip, list column, device tab, labels, vocabulary

#### Task B1: One translated label set

**Files:**
- Create: `apps/web/src/components/configurationPolicies/configPolicyLabels.ts`, `configPolicyLabels.test.ts`
- Modify:
  - `featureTabs/types.ts` (`FEATURE_META[*].label` reads `configFeatureLabel`);
  - `components/devices/DeviceEffectiveConfigTab.tsx` (its local `FEATURE_META` labels and `LEVEL_LABELS` call the shared functions; icons stay local);
  - `featureTabs/FeatureTabShell.tsx` (the badge text);
  - `ConfigPolicyDetailPage.tsx` (the gated-tab `title`);
  - `locales/en/policies.json`.

**Interfaces (produced):**

```ts
export function configFeatureLabel(featureType: ConfigFeatureType): string;
export function configTargetLevelLabel(level: ConfigPolicyTargetLevel | 'default'): string;
```

Keys:
- `policies:configurationPolicies.featureNames.<featureType>.label` for the 19 types with English literals today.
- The seven types already translated keep their keys: `devices:timeSync.management.title`, `devices:workloads.policy.title`, and the `featureTabs.{securityAgentsTab,systemProtectionTab,containmentTab,vendorUpdatesTab,wakeOnLanTab}.title` keys.
- Levels use `policies:configurationPolicies.levelNames.<level>.label`. Values: partner "All organizations", organization "Organization", site "Site", device_group "Device group", device "Device", default "Breeze Defaults".
- Shell badges: `featureTabShell.badgeInherited` "Configured (inherited)", `badgeSavedNotDeployed` "Saved (not deployed)", `badgeConfigured` "Configured", `badgeNotConfigured` "Not configured".
- Gated title: `configPolicyDetailPage.gatedFeatureTitle` "Not available on MSP-managed policies. Set this feature on a policy managed by one organization."

- [ ] **Step 1: Failing tests:**
  - `configPolicyLabels.test.ts`:
    - `every ConfigFeatureType has a label that resolves in en` (iterate `CONFIG_FEATURE_TYPES` from `@breeze/shared`; no value equals its key path);
    - `the editor and the device tab show the same label for every feature type`. B1 exports the device tab's map as `EFFECTIVE_FEATURE_META`; today the file exports only `ALL_FEATURE_TYPES`. The test compares it with `FEATURE_META` from `featureTabs/types.ts` over `ALL_FEATURE_TYPES`, without rendering.
    - `pt-BR renders a translated feature label` (goes green in B6).
  - `FeatureTabShell.test.tsx`: `the state badge text comes from i18n` (switch to pt-BR; expect the pt-BR value).
- [ ] **Step 2:** `cd apps/web && npx vitest run src/components/configurationPolicies/configPolicyLabels.test.ts src/components/configurationPolicies/featureTabs/FeatureTabShell.test.tsx src/components/configurationPolicies/featureTabs/featureTypeParity.test.ts src/components/devices/DeviceEffectiveConfigTab.featureParity.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. The badge stays a ternary over literal `i18n.t('…')` calls (never `t(cond ? a : b)`). Labels use a getter, as the seven translated entries already do, so a language switch re-reads them. The dynamic key gets `/* i18n-dynamic */`.
- [ ] **Step 4:** Rerun, plus `src/components/configurationPolicies/featureTabs/HelperTab.test.tsx src/components/configurationPolicies/featureTabs/RemoteAccessTab.test.tsx src/components/configurationPolicies/featureTabs/SecurityTab.test.tsx src/components/configurationPolicies/featureTabs/SensitiveDataTab.test.tsx` (they pin the English badge text, unchanged by D7). Expected: PASS.
- [ ] **Step 5: Commit** `refactor(web): one translated label set for config policy features and levels (#12306)`.

#### Task B2: The Applies-to strip and drawer on the policy page

**Files:**
- Create: `apps/web/src/components/configurationPolicies/AppliesToStrip.tsx`, `AppliesToStrip.test.tsx`, `appliesToSummary.ts`, `appliesToSummary.test.ts`
- Modify: `ConfigPolicyDetailPage.tsx`, `ConfigPolicyDetailPage.test.tsx`, `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`

**Interfaces:**
- Consumes: the A1 types; `configTargetLevelLabel` and `configFeatureLabel` (B1); `AssignmentFilterBadges` (`AssignmentRoleOsFilters.tsx`); `Drawer` (`components/shared/Drawer.tsx`).
- Produces:
  - `appliesToSummary.ts`:
    - `parseAppliesTo(raw: unknown): ConfigPolicyAppliesToSummary | null`. It returns null when the field is absent or malformed.
    - `formatAppliesToTargets(s: ConfigPolicyAppliesToSummary): { shown: { key: string; text: string; roleFilter: string[] | null; osFilter: string[] | null }[]; more: number }`. `more = assignmentCount - shown.length`.
  - `AppliesToStrip`:

    ```ts
    type AppliesToStripProps = {
      summary: ConfigPolicyAppliesToSummary | null;
      status: 'active' | 'inactive' | 'archived';
      onEdit: () => void;
    };
    ```

  - `notAppliedTone(status, state)` (D2a), in `appliesToSummary.ts`, shared with B3.

  - `data-testid`s: `config-policy-applies-to-strip`, `-target`, `-more`, `-edit`, `-not-applied`, `-assign`, `-in-use`.

Behaviour:
- `summary === null` renders the strip label with an em dash and the Edit button, with no state claim.
- `applied` renders the targets. A `partner` row reads "All organizations". Any other row reads its target name. Each row is followed by its filter badges. Then comes "+N" when `more > 0`.
- `not_applied` depends on the tone, with an **Assign** button that calls `onEdit` in both cases:
  - `warning` (active): "Not applied to any device. This policy applies to nothing until you choose where it applies."
  - `neutral` (inactive): "Not applied yet".
  - An archived policy shows the em dash.
- `in_use_through_children` renders "In use through {{count}} policies", with no warning.
- The strip renders above the tabs and stays visible on every tab.

The detail page:
- Remove `assignments` from `tabs` and from `VALID_TABS`.
- Add `assignments` to the legacy-hash effect: `#assignments` keeps the current tab (or Overview), opens the drawer, and canonicalizes the hash with `replaceState`.
- The drawer (`dataTestId="config-policy-applies-to-drawer"`, title "Applies to", `width="max-w-2xl"`) renders today's `AssignmentsTab` with the same props. Closing it refetches `GET /:id` (D9).
- Migrate `handleSaveOverview` to `runAction`, then refetch `GET /:id`. Today the PATCH response replaces the policy with a bare row, dropping `parentPolicy`, `childPolicies` and the summary from the page until a reload.
- Add the file to `TARGET_GLOBS`.

- [ ] **Step 1: Failing tests:**
  - `appliesToSummary.test.ts`:
    - `parseAppliesTo returns null for a missing or malformed field`;
    - `formatAppliesToTargets names partner rows All organizations and counts the rest as more`;
    - `notAppliedTone warns only for an active policy, is neutral when inactive and silent when archived`.
  - `AppliesToStrip.test.tsx`:
    - `absent appliesTo renders unknown, never Not applied`;
    - `strip never says Not applied when assignmentCount > 0` (`targets: []`, `assignmentCount: 1` shows "+1");
    - `a parent with children reads In use through N policies`;
    - `Not applied shows the warning and an Assign button that opens the editor`;
    - `long target lists truncate to three names and +N`;
    - `an inactive unapplied policy reads Not applied yet, not the warning`;
    - `an archived policy shows no not-applied state`.
  - `ConfigPolicyDetailPage.test.tsx`:
    - `the tab strip no longer contains Assignments`;
    - `the strip stays visible on a feature tab`;
    - `#assignments opens the Applies-to drawer`;
    - `closing the drawer refetches the policy`;
    - `saving details goes through runAction and keeps the parent banner`.
- [ ] **Step 2:** `cd apps/web && npx vitest run src/components/configurationPolicies/AppliesToStrip.test.tsx src/components/configurationPolicies/appliesToSummary.test.ts src/components/configurationPolicies/ConfigPolicyDetailPage.test.tsx src/lib/__tests__/no-silent-mutations.test.ts src/lib/__tests__/no-hash-in-usestate.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun. Expected: PASS. Then run the web typecheck.
- [ ] **Step 5: Commit** `feat(web): applies-to strip and editor drawer on the policy page (#12306)`.

#### Task B3: Applies-to column and state in the policy list

**Files:**
- Modify: `ConfigPolicyList.tsx`, `ConfigPolicyList.test.tsx`

**Interfaces:**
- Consumes: `parseAppliesTo` and `formatAppliesToTargets` (B2); `appliesToState` (A1).
- Produces:
  - `ConfigPolicy` gains `appliesTo?: unknown`, parsed per row.
  - A new "Applies to" column, `data-testid="config-policy-applies-to-cell"`, sits between Name and Status.
  - The ownership badges (`partner-wide-badge`, `partner-policy-badge`, `org-badge`) are removed. An org-managed row shows `Managed by {{organization}}` (`data-testid="config-policy-managed-by"`) under the name. An MSP-managed row shows nothing there.
  - State: the Status cell keeps Active/Inactive/Archived. It adds one chip:
    - `not_applied` with tone `warning`: a warning chip "Not applied" (`config-policy-not-applied-badge`, `data-tone="warning"`);
    - `not_applied` with tone `neutral`: the same chip, neutral (`data-tone="neutral"`);
    - `in_use_through_children`: "In use through {{count}} policies" (`config-policy-in-use-badge`).

- [ ] **Step 1: Failing tests:**
  - `shows the first targets and +N in the Applies to cell`;
  - `marks an active unassigned policy with no children with a warning chip`;
  - `marks an inactive unassigned policy with a neutral chip and an archived one with none`;
  - `marks a parent with children In use through N policies, not Not applied`;
  - `renders an em dash and no chip when appliesTo is absent`;
  - `shows Managed by <org> only on org-managed rows`;
  - `no longer renders the Partner-wide or Partner policy badges`. Update the existing assertions on those testids in `ConfigPolicyList.test.tsx`.
- [ ] **Step 2:** `cd apps/web && npx vitest run src/components/configurationPolicies/ConfigPolicyList.test.tsx src/components/configurationPolicies/ConfigPolicyList.pagination.test.tsx src/components/configurationPolicies/ConfigPolicyList.emptyState.test.tsx src/components/configurationPolicies/ConfigurationPoliciesPage.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement. Keep `colSpan` in step with the new column count.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): applies-to column and not-applied state in the policy list (#12306)`.

#### Task B4: Device Config tab names the winner and why others lost

**Files:**
- Modify: `apps/web/src/components/devices/DeviceEffectiveConfigTab.tsx`, `DeviceEffectiveConfigTab.summaryAndChain.test.tsx`

**Interfaces:**
- Consumes: `policyOwners` (A3); `configFeatureLabel` and `configTargetLevelLabel` (B1); `useJwtClaims` (`@/lib/authScope`), as `ConfigPolicyDetailPage` uses it for `canOpenParent`.
- Produces:
  - `canOpenPolicy(policyId, owners, claims): boolean`: partner-scope, or `owners[policyId] === 'organization'`.
  - `lostReason(entry: InheritanceEntry, winner: ResolvedFeature): 'more_specific_level' | 'lower_priority_number' | 'assigned_earlier'`. Uses the resolver's `LEVEL_PRIORITY` order (device 5, device_group 4, site 3, organization 2, partner 1), mirrored as a local constant with a comment naming its source.

Card: "From {{policy}} · via {{level}}". The policy is a link (`data-testid="effective-config-winner-link"`) when `canOpenPolicy`; otherwise it is the name plus "Managed by your MSP" (the existing `configPolicyDetailPage.managedByYourMsp` text, moved to a `devices` key). The level is `effective-config-winner-level`. "Inherited from {{name}}" becomes "Based on {{name}}".

Chain:
- The heading becomes "Precedence". The two explanatory lines are replaced by the precedence legend (Global Constraints).
- Each row whose policy lost at least one feature gets a visible line, `data-testid="chain-row-lost-reason"`: "Replaced for {{features}} by {{winner}}: {{reason}}". It has one clause per winning policy, and `reason` comes from the three D5 strings.
- The `title=` on overridden chips stays as a duplicate; it is no longer the only carrier, since a title tooltip is invisible to touch and keyboard users.
- Chain-row policy links follow `canOpenPolicy`.

- [ ] **Step 1: Failing tests:**
  - `the winning policy is a link for a partner-scope caller`;
  - `an org-scope caller sees no link to an MSP-managed winner`;
  - `the card states the level the feature arrived through`;
  - `a row that lost on level says more specific level`;
  - `a row that lost on priority at the same level says lower priority number`;
  - `a tie on level and priority says assigned earlier`;
  - `chain heading reads Precedence and shows the legend`;
  - `card labels match the editor's labels`.
- [ ] **Step 2:** `cd apps/web && npx vitest run src/components/devices/DeviceEffectiveConfigTab.test.tsx src/components/devices/DeviceEffectiveConfigTab.summaryAndChain.test.tsx src/components/devices/DeviceEffectiveConfigTab.settingsSummary.test.tsx src/components/devices/DeviceEffectiveConfigTab.containment.test.tsx src/components/devices/DeviceEffectiveConfigTab.patchApproval.test.tsx src/components/devices/DeviceEffectiveConfigTab.vendorUpdates.test.tsx src/components/devices/DeviceEffectiveConfigTab.featureParity.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement. The file is 724 lines, so put `canOpenPolicy` and `lostReason` in a new `components/devices/effectiveConfigPrecedence.ts`, with its own test.
- [ ] **Step 4:** Rerun, plus `src/components/devices/effectiveConfigPrecedence.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): device Config tab links the winning policy and says why others lost (#9565, #12306)`.

#### Task B5: Vocabulary and the contradictory copy

**Files:** Modify `locales/en/policies.json`, `locales/en/devices.json`, and the components that read the keys below. Add the E2E testids, with no behaviour change:
- in `ConfigPolicyCreatePage.tsx`: `config-policy-create-mode-new`, `config-policy-create-name`, `config-policy-create-submit`;
- in `OrganizationScopePanel.tsx`, which has none today: `org-scope-all-orgs` on the All-organizations checkbox, `org-scope-org-<orgId>` on each organization checkbox (both lists), and `org-scope-search`;
- in `AssignmentsTab.tsx`: `assignment-level-select`, `assignment-target-<id>` on each picker option, and `assignment-add`.

Use the spec's vocabulary table: Applies to, Managed by, Parent policy / "Based on X", Precedence, Inactive. API field names do not change. Only `en` values change here; B6 retranslates them.
- **Create page:**
  - `linkToExisting` → "Based on a parent policy".
  - `useAnotherPolicyAsTheMasterBaseline` → "Start from another policy's settings and change what differs".
  - `masterPolicy` → "Parent policy".
  - `selectTheConfigurationPolicyToUseAs` → "Choose the parent policy. You can change individual features for this policy."
  - `createAPolicyLinkedToAnExisting` → "Create a policy based on a parent policy."
  - `scope` → "Managed by". `partnerLibrary` → "Your MSP". `aSpecificOrganization` → "One organization".
  - `assignToOrganizationsAfterCreating` → "(choose where it applies next)".
  - `createAReusablePolicyOwnedByYour` → "Managed by your MSP. It applies to nothing until you choose where it applies under Applies to." The old text names an "Organizations tab" that does not exist.
- **Detail page:**
  - `inheritingFrom` → "Based on".
  - `inheritedByPolicies_one/_other` → "Parent of {{count}} policy" / "Parent of {{count}} policies".
  - `overrideIndividualTabsToCustomizeSettings` → "Change a feature to set it for this policy only."
  - `isnTAvailableOnPartnerWidePolicies` → " isn't available on MSP-managed policies".
  - `configureThisFeatureOnAnOrganizationScoped` → "Set this feature on a policy managed by one organization."
- **Editors:**
  - `assignmentsTab.currentAssignments` → "Applies to". `addAssignment` → "Add target".
  - `noAssignmentsYetAssignThisPolicyTo` → "Not applied to any device yet. Add a target above."
  - `organizationScopePanel.thisPartnerLibraryPolicyAppliesOnlyTo` → "This MSP-managed policy applies only to the organizations you choose."
  - `allOrganizationsPartnerWide` and `allOrganizationsPartnerWide2` → "All organizations".
  - `partnerGroupAssignment.title` → "Device groups across organizations". `partnerGroupAssignment.description` keeps its precedence sentence, with "partner-wide" → "MSP-owned".
- **List:** `noPoliciesYet` → "No configuration policies yet. Create one, then choose where it applies." Remove the now-unused `allOrgs`, `partnerPolicy`, `partnerWidePolicyAppliesToEveryOrganization`, `partnerPolicyAppliesOnlyWhereAssigned` and `organizationPolicyTitle`, after grepping that nothing else reads them.
- **Device tab:** `inheritanceChain` → "Precedence". `inheritedFrom` → "Based on {{name}}". Remove `policiesAreResolvedUsingClosestWins` and `chainResolutionRule` after B4 replaces them with the legend.

- [ ] **Step 1: Failing test:** `ConfigPolicyCreatePage.test.tsx`, `create navigates to the policy with the Applies-to drawer open` (D8). Then update every test that asserted an old string. Grep the changed `en` values under `apps/web/src` and `e2e-tests`.
- [ ] **Step 2:** Run the files touched by B2–B5 together. Expected: the new test FAILS.
- [ ] **Step 3:** Change the copy and the create page's navigation target.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5: Commit** `fix(web): one vocabulary for where a policy applies, who manages it and precedence (#12306)`.

#### Task B6: Locales in all eight languages

- [ ] Add every new key from B1–B5 to the seven other `policies.json` and `devices.json` files. Retranslate each changed `en` value; follow `locales/TERMINOLOGY.md` ("policy" is fixed per locale). Delete the removed keys everywhere.
- [ ] Add a `translationCoverage.test.ts` baseline entry only for a true loanword (for example "Backup" in de-DE), with its reason.
- [ ] Run: `cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/i18n/keyUsage.test.ts src/lib/i18n/titleKeyUsage.test.ts src/lib/i18n/terminologyQuality.test.ts src/locales/humanizedKeyRegression.test.ts src/components/configurationPolicies/configPolicyLabels.test.ts`. Expected: PASS.
- [ ] Commit `chore(web): applies-to and precedence copy in all locales (#12306)`.

#### Task B7: Docs, docs index, release notes

- [ ] Use the `update-breeze-docs` skill on `features/configuration-policies.mdx`:
  - rename "Policy ownership: organization vs. partner-wide" to "Managed by: your MSP or one organization", and update the two linking pages' anchors;
  - rename "Baseline policies (inheritance)" to "Parent policies";
  - rename "Assigning a policy" to "Where a policy applies", and describe the strip, the not-applied warning and the drawer;
  - in "Viewing effective configuration", describe the winner link, the level, the precedence legend and the three reasons a policy loses.
- [ ] Run `npx tsx scripts/build-docs-index.ts`, then `cd apps/docs && pnpm exec astro check` (0 errors), then `cd apps/api && npx vitest run src/services/aiToolsDocs.test.ts`.
- [ ] Append under `## Features / API`:
  - **Configuration policies show where they apply** (#12306). The detail page has an always-visible Applies-to line. It opens the target editor, and warns "Not applied to any device" when a policy reaches nothing.
  - The list has an Applies-to column, a Not applied chip and "In use through N policies" for parents. The ownership badges are gone; org-managed rows read "Managed by <organization>".
  - The device Config tab links the policy that won each feature, names the level it arrived through, and says why each other policy lost.
  - `GET /configuration-policies` rows and `GET /configuration-policies/:id` gain `appliesTo`; `GET /configuration-policies/effective/:deviceId` gains `policyOwners` (additive).
  - Old `#assignments` links still work.

  Append only; rebase just before the PR.
- [ ] Commit `docs(config-policy): where a policy applies and precedence (#12306)`.

#### Task B8: E2E and wave verification

- [ ] Create `e2e-tests/pages/ConfigPolicyPage.ts` (testids only) and `e2e-tests/tests/config-policy-applies-to.spec.ts`. Use `pam.spec.ts` for the sign-in and hydration pattern. The spec:
  1. Create a policy on `/configuration-policies/new`, choosing `policy-owner-partner` so the drawer shows `OrganizationScopePanel` whatever the seeded admin's org selection. Land on its page with the drawer open (D8). Close it.
  2. See `config-policy-applies-to-not-applied`, then click `config-policy-applies-to-assign`.
  3. In the drawer, tick `org-scope-org-<seeded org id>`. Close it. See `config-policy-applies-to-target`.
  4. On `/configuration-policies`, see the row's `config-policy-applies-to-cell` without `config-policy-not-applied-badge`.
  5. Open `/configuration-policies/<id>#assignments` and see the drawer.
- [ ] **Wave verification** (after W01a merges, on W01b rebased on `main`):
  - every W01b test command above, the i18n batch, the web typecheck and lint;
  - on a per-worktree stack (`worktree-stack` skill), the Playwright spec;
  - walk a device's Config tab where a device-level policy beats an organization-level one.

  Screenshots stay local. Tear the stack down and say so.
- [ ] Open PR `feat(web): show where a configuration policy applies (#12306)` with `Closes #12306` and `Refs #9565`. One Opus review round, then the summary comment. `Migration slot: none`.

**W1 exit checklist**
- [ ] Assignments is out of the tab strip; the strip is visible on every tab; `#assignments` opens the drawer.
- [ ] "Not applied" appears only when the API's unfiltered count is 0 and there are no children; an absent field claims nothing.
- [ ] The list column, the chips and "Managed by" are present; the ownership badges are gone.
- [ ] The device card links the winner when the caller can open it, states the level, and each losing row says why.
- [ ] One label set; badges in i18n; 8 locales; contracts green; docs, index and release notes in.

---

## W2 — One applies-to editor, staged Apply, reach

Spec wave row W2 and "API changes" 1, 2 and 5. Full rigor: each task's test is written first, and each part gets one independent Opus review.

**Every W2 part's Step 0:** the baseline check (header), plus `git cat-file -e origin/main:apps/api/src/services/configPolicyAppliesTo.ts`. That file is W01a's; W2 builds on its `TARGET_LEVEL_ORDER` and its types.

### W02a — Reach (API)

#### Task R1: Expansion reads can skip the audit

**Files:**
- Modify: `apps/api/src/services/configPolicyAssignmentDevices.ts` (`AssignmentExpansionOptions.auditAction: string | null`)
- Test: `apps/api/src/services/configPolicyAssignmentDevices.partnerLevel.test.ts` (extend)

**Interfaces:**
- Produces: when `auditAction` is null, `resolveAssignmentDevices` does not call `auditRefusedExecutionGroups`, under both `'resolve'` and `'exclude'`. Existing callers pass strings, so their behaviour is unchanged.

- [ ] **Step 1: Failing tests:** `auditAction null skips the refused-group audit`; `a string auditAction still audits` (characterization).
- [ ] **Step 2:** `cd apps/api && npx vitest run src/services/configPolicyAssignmentDevices.partnerLevel.test.ts src/jobs/patchSchedulerWorker.test.ts`. Expected: the first FAILS.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5: Commit** `refactor(api): assignment expansion can run without auditing (#<sub-issue>)`.

#### Task R2: `computePolicyReach`

**Files:**
- Create: `apps/api/src/services/configPolicyReach.ts`, `configPolicyReach.test.ts`

**Interfaces (produced; W02b, W02c, W03c and W05a consume):**

```ts
export interface ConfigPolicyReach { direct: number; throughChildren: number; organizations: number }
export async function computePolicyReach(auth: AuthContext, policyIds: readonly string[]): Promise<Map<string, ConfigPolicyReach>>;
export async function expandAssignmentsToDevices(
  rows: readonly AssignmentToExpand[],
  scope: AssignmentExpansionScope,
  memo: Map<string, string[]>,
): Promise<Set<string>>; // union of resolveAssignmentDevices; options { refusedGroups: 'resolve', auditAction: null } (D11)
```

Semantics:
- `direct` is the distinct devices the policy's own rows reach.
- `throughChildren` is the distinct devices that the visible child policies' rows reach and `direct` does not already hold.
- `organizations` is the distinct `devices.orgId` over the union.
- An inactive policy is counted the same way: reach describes the targets, not enforcement.
- Everything runs on the ambient `db`, in the caller's context.
- The memo key is `level|targetId|roleFilter|osFilter|policyOrgId|policyPartnerId`.

- [ ] **Step 1: Failing tests:**
  - `reach unions a policy's targets once`;
  - `throughChildren excludes devices already reached directly`;
  - `role and OS filters narrow the count`;
  - `organizations counts distinct device orgs`;
  - `memo reuses one expansion across policies`;
  - `reach never writes an audit row`.
- [ ] **Step 2:** `cd apps/api && npx vitest run src/services/configPolicyReach.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Load the assignments and the children's assignments with one statement each, never one per policy.
- [ ] **Step 4:** Rerun, plus `src/__tests__/parkedFanout.contract.test.ts`. Expected: PASS. Classify the file if the contract names it (VISIBILITY_MODULES: "policy reach counts; no fan-out").
- [ ] **Step 5: Commit** `feat(api): configuration policy reach counts (#<sub-issue>)`.

#### Task R3: Reach routes

**Files:**
- Create: `apps/api/src/routes/configurationPolicies/reach.ts`, `reach.test.ts`
- Modify:
  - `routes/configurationPolicies/index.ts`: mount `reachRoutes` before `crudRoutes`, so `/reach` is not read as `/:id`;
  - `services/mcpCoverage.ts`: `'configurationPolicies/reach.ts': { exempt: 'tool_in_later_wave', note: 'reach counts for the policy page and list; an AI read follows the spec''s AI follow-up' }`.

**Interfaces:**
- `GET /configuration-policies/reach?ids=<csv of 1–100 guids>` (`devices.read`) answers `{ data: Record<id, ConfigPolicyReach> }`. Ids the caller cannot read are absent.
- `GET /configuration-policies/:id/reach` (`devices.read`) answers a `ConfigPolicyReach`, or 404 through `getConfigPolicy`.

- [ ] **Step 1: Failing tests:**
  - `GET /reach rejects more than 100 ids`;
  - `GET /reach rejects a non-guid`;
  - `GET /reach omits ids the caller cannot read`;
  - `GET /:id/reach 404s on an invisible policy`;
  - `GET /:id/reach returns the three counts`.
- [ ] **Step 2:** `cd apps/api && npx vitest run src/routes/configurationPolicies/reach.test.ts src/__tests__/mcp-coverage.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Filter the batch ids through `listConfigPolicies`' access condition before computing; never trust the client's list.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): reach routes for configuration policies (#<sub-issue>)`.

#### Task R4: Server search on the sites list

**Files:**
- Modify: `apps/api/src/routes/orgs.ts` (`listSitesSchema` gains `search: z.string().max(100).optional()`; an ILIKE on `sites.name` with `%_\` escaped, as `listConfigPolicies` does)
- Test: `apps/api/src/routes/organizations.test.ts` (it holds the `GET /orgs/sites` tests)

- [ ] **Step 1: Failing tests:** `GET /orgs/sites?search= filters by name`; `search escapes LIKE characters`.
- [ ] **Step 2:** `cd apps/api && npx vitest run src/routes/organizations.test.ts src/routes/orgs.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): search the sites list on the server (#<sub-issue>)`.

#### Task R5: Integration proof and PR

**Files:** Create `apps/api/src/__tests__/integration/configPolicyReach.integration.test.ts`.

- [ ] **Step 1: Write the cases:**
  - `group membership and the role filter decide the count`;
  - `an org-scope caller's throughChildren counts only its own organization's devices`;
  - `a partner-scope caller counts devices across its organizations`;
  - `the count runs in the caller's context`.
- [ ] **Step 2:** Run it on the test stack, together with `patchSchedulerRoleFilter.integration.test.ts` and `partnerDeviceGroupFanout.integration.test.ts` (they prove the shared resolver did not move). Expected: PASS. Tear the stack down.
- [ ] **Step 3:** Run the contract batch (`mcp-coverage`, `partner-wide-write-coverage`, `site-ceiling-write-coverage`, `parkedFanout.contract`, `aiGuardrails.routeBinding.contract`) and the API typecheck.
- [ ] **Step 4:** Open PR `feat(api): configuration policy reach (#<sub-issue>)`, then one independent Opus review. `Migration slot: none`.

### W02b — Gates, update, Apply, target listing (API)

#### Task G1: One gate module, extracted under the existing tests

**Files:**
- Create: `apps/api/src/routes/configurationPolicies/assignmentGates.ts`, `assignmentGates.test.ts`
- Modify: `apps/api/src/routes/configurationPolicies/assignments.ts` (`POST /:id/assignments` calls the gates)

**Interfaces (produced):**

```ts
export type LoadedPolicy = NonNullable<Awaited<ReturnType<typeof getConfigPolicy>>>;
export type AssignmentGateResult = { ok: true } | { ok: false; status: 403 | 409; body: Record<string, unknown> };
export function checkPolicyAssignableBy(auth: AuthContext, policy: LoadedPolicy): AssignmentGateResult;
//   a partner-owned policy needs canManagePartnerWidePolicies
export function checkAddLevel(policy: LoadedPolicy, level: ConfigAssignmentLevel): AssignmentGateResult;
//   helper branding (assignmentWriteAllowed)
export function checkAddArming(auth: AuthContext, permissions: UserPermissions | undefined, policy: LoadedPolicy): AssignmentGateResult;
//   HP CMSL + oem_updates, as the POST computes them today
```

- [ ] **Step 1: Characterization.** Run `cd apps/api && npx vitest run src/routes/configurationPolicies/assignments.test.ts src/routes/configurationPolicies/assignments.helperBranding.test.ts src/routes/configurationPolicies/assignments.hpCmsl.test.ts src/routes/configurationPolicies/assignments.oemUpdates.test.ts` on unmodified code and record the count. Expected: PASS.
- [ ] **Step 2: Failing tests:** one case per gate in `assignmentGates.test.ts`, moved from those files' assertions (partner-owned denial; branding at site, group and device level; HP CMSL on an own or inherited warranty link; an unresolvable parent fails closed; armed oem_updates). Run them. Expected: FAIL.
- [ ] **Step 3:** Implement the module, then switch the POST to it. Move the bodies; do not change them.
- [ ] **Step 4:** Rerun both batches. Expected: PASS, with the Step 1 count unchanged. Also run `src/__tests__/partner-wide-write-coverage.test.ts`: the new file names `canManagePartnerWidePolicies` itself.
- [ ] **Step 5: Commit** `refactor(api): assignment gates in one module (#<sub-issue>)`.

#### Task G2: `updateAssignment` and the target owner on listings

**Files:**
- Modify: `apps/api/src/services/configurationPolicy.ts` (`updateAssignment`; `listAssignmentsForTarget` also selects `policyPartnerId`), `services/deviceEventFeed.ts` (a label for `config_policy.assignment_update`)
- Test: create `apps/api/src/services/configPolicyAssignmentUpdate.test.ts` (the service file has no single test file to extend)

**Interfaces:**

```ts
export async function updateAssignment(
  assignmentId: string, configPolicyId: string,
  patch: { priority?: number; roleFilter?: string[] | null; osFilter?: string[] | null },
  executor?: DbExecutor,
): Promise<typeof configPolicyAssignments.$inferSelect | null>;
```

When a row changed, it schedules the same three reconciles as `assignPolicy`. It never moves a row to another policy.

- [ ] **Step 1: Failing tests:**
  - `updateAssignment changes priority and filters`;
  - `updateAssignment returns null for another policy's row`;
  - `updateAssignment schedules the reconciles only when a row changed`;
  - `listAssignmentsForTarget returns policyPartnerId`.
- [ ] **Step 2:** `cd apps/api && npx vitest run src/services/configPolicyAssignmentUpdate.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Normalize `[]` to null for the filters, as `assignPolicy` does.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): edit an assignment's priority and filters in place (#<sub-issue>)`.

#### Task G3: The Apply request schema

**Files:**
- Modify: `packages/shared/src/validators/index.ts`
- Test: `packages/shared/src/validators/index_configpolicy.test.ts`

**Interfaces:**

```ts
export const applyAssignmentsSchema = z.object({
  add: z.array(assignPolicySchema).max(200).default([]),
  update: z.array(z.object({ id: z.string().guid(), priority: z.number().int().min(0).max(1000).optional(),
    roleFilter: z.array(z.enum(DEVICE_ROLES)).nullable().optional(),
    osFilter: z.array(z.enum(['windows', 'macos', 'linux'])).nullable().optional() })).max(200).default([]),
  remove: z.array(z.string().guid()).max(200).default([]),
  dryRun: z.boolean().optional(),
});
export type ApplyAssignmentsInput = z.infer<typeof applyAssignmentsSchema>;
```

- [ ] **Step 1: Failing tests:**
  - `apply schema defaults the three lists to empty`;
  - `apply schema caps each list at 200`;
  - `apply schema refuses an id in both update and remove`. A `superRefine` holds the cross-list rule; the per-field checks stay on the fields (zod 4.6 skips a `superRefine` after a field fails).
- [ ] **Step 2:** `cd packages/shared && npx vitest run src/validators/index_configpolicy.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement, and re-export it from `apps/api/src/routes/configurationPolicies/schemas.ts`.
- [ ] **Step 4:** Rerun. Expected: PASS. Run the shared typecheck.
- [ ] **Step 5: Commit** `feat(shared): staged Apply request schema (#<sub-issue>)`.

#### Task G4: `POST /:id/assignments/apply`

**Files:**
- Modify: `apps/api/src/routes/configurationPolicies/assignments.ts` (or a new `assignmentsApply.ts` mounted from it, if `assignments.ts` would pass about 500 lines)
- Test: create `apps/api/src/routes/configurationPolicies/assignments.apply.test.ts`

**Interfaces:**
- Consumes: G1 gates, G2 `updateAssignment`, G3 schema, and W02a `expandAssignmentsToDevices`.
- Produces: `POST /configuration-policies/:id/assignments/apply` (`devices.write` + `requireMfa()`). Responses:
  - `201 { added, updated, removed }`;
  - `200 { dryRun: true, delta: { added: number; removed: number } }`;
  - `4xx { error, entry?: { op: 'add' | 'update' | 'remove'; index: number } }`;
  - `409 { error: 'assignment_conflict', entry }`.

Order of work:
1. Load the policy (404), then `checkPolicyAssignableBy`.
2. Check every `add`: derive the target as the POST does, then run `validateAssignmentTarget`, `authorizeAssignmentTarget` and `checkAddLevel`. If there is at least one add, run `checkAddArming` once.
3. Check every `update` and `remove` with `getAssignment(aid, id)` (404 when it is not this policy's row) and `authorizeAssignmentTarget` on the stored target.
4. All checks finish before any write. The first failure returns its status and names its entry.
5. `dryRun`: build the proposed set in memory, then expand current and proposed (D10). Write nothing.
6. Otherwise, run remove, then update, then add, inside one `withDbTransaction`. A null `assignPolicy`, or an update or delete that matches nothing, throws `AssignmentApplyConflictError`. It is caught outside the savepoint and answers 409.
7. After the savepoint commits: one `invalidateRemoteAccessCache()`, and one audit row per change (`config_policy.assign`, `config_policy.unassign`, `config_policy.assignment_update`).
8. A row not in the request is never touched.

- [ ] **Step 1: Failing tests:**
  - `Apply runs every check before any write`;
  - `Apply names the failing entry`;
  - `Apply derives the partner target server-side`;
  - `Apply refuses a partner-owned policy without full partner access`;
  - `Apply runs the arming gates once when it adds`;
  - `Apply skips the arming gates for removes and updates only`;
  - `Apply refuses a branding-incompatible level`;
  - `Apply refuses another policy's assignment id`;
  - `dry run writes nothing and returns the device delta`;
  - `Apply audits one row per change`.
- [ ] **Step 2:** `cd apps/api && npx vitest run src/routes/configurationPolicies/assignments.apply.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun, together with the G1 batch. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): staged Apply for configuration policy assignments (#<sub-issue>)`.

#### Task G5: Target listing shows MSP-managed policies to their partner

**Files:**
- Modify: `apps/api/src/routes/configurationPolicies/assignments.ts` (`GET /assignments/target`)
- Test: `assignments.test.ts`

Rule:
- Keep a partner-owned row for a partner-scope caller when `r.policyPartnerId === auth.partnerId` and the caller can access the target's organization: the organization itself, or the site's, device's or org-owned group's org.
- A partner-owned group target is kept only when `canManagePartnerWidePolicies(auth)`.
- Org-scope callers are unchanged in W2; W03a applies the read rule to them.

- [ ] **Step 1: Failing tests:**
  - `target listing includes an MSP-managed policy for its own partner`;
  - `target listing omits an MSP-managed row whose target organization the caller cannot access`;
  - `target listing still omits MSP-managed rows for an org-scope caller`.
- [ ] **Step 2:** Run `assignments.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Resolve the target orgs with one select per level, never one per row.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5: Commit** `fix(api): the Site page lists MSP-managed policies assigned there (#<sub-issue>)`.

#### Task G6: Integration proof, contracts, PR

**Files:** Create `apps/api/src/__tests__/integration/configPolicyAssignmentApply.integration.test.ts`.

- [ ] **Step 1: Write the cases** (through the real router, on real Postgres):
  - `a colliding add rolls back the whole Apply`: two adds, the second a duplicate. Expect 409, and the first add absent afterwards.
  - `an Apply leaves a row it was not told about`;
  - `update changes priority and filters in place`;
  - `a cross-partner target is refused`;
  - `dry run leaves the table unchanged`.
- [ ] **Step 2:** Run it on the test stack, with `configPolicyAssignmentDeleteContext`, `configPolicyPartnerLevelAssignments` and `configurationPoliciesPartnerRls`. Expected: PASS. Tear the stack down.
- [ ] **Step 3:** Run the contract batch from R5, `src/services/aiToolsConfigPolicy.test.ts`, and both typechecks.
- [ ] **Step 4:** Open PR `feat(api): staged Apply and the Site page target listing (#<sub-issue>)`, then one independent Opus review. `Migration slot: none`.

### W02c — The unified panel (web)

**Every W02c task's Step 0** adds: W02a and W02b are merged, or their response shapes are copied verbatim as local types in `appliesTo/appliesToApi.ts`.

#### Task P1: Staged-diff reducer and API client

**Files:**
- Create in `apps/web/src/components/configurationPolicies/appliesTo/`: `appliesToDraft.ts`, `appliesToDraft.test.ts`, `appliesToApi.ts`, `appliesToApi.test.ts`

**Interfaces (produced):**

```ts
export type DraftRow =
  | { kind: 'existing'; assignment: { id: string; level: ConfigPolicyTargetLevel; targetId: string; name: string; priority: number; roleFilter: string[] | null; osFilter: string[] | null };
      edits?: { priority?: number; roleFilter?: string[] | null; osFilter?: string[] | null }; removed?: boolean }
  | { kind: 'added'; key: string; level: ConfigPolicyTargetLevel; targetId: string; name: string; priority: number; roleFilter: string[] | null; osFilter: string[] | null };
export function draftToApplyPayload(rows: DraftRow[]): ApplyAssignmentsInput; // only changed rows; unchanged existing rows never appear
export function draftIsDirty(rows: DraftRow[]): boolean;
export async function applyAssignments(policyId: string, input: ApplyAssignmentsInput): Promise<{ added: number; updated: number; removed: number }>; // via runAction
export async function dryRunAssignments(policyId: string, input: ApplyAssignmentsInput): Promise<{ added: number; removed: number }>; // runaction-exempt
export async function fetchReach(ids: string[]): Promise<Record<string, ConfigPolicyReach>>;
```

- [ ] **Step 1: Failing tests:**
  - `unchanged rows never enter the payload`;
  - `edit then revert is not dirty`;
  - `removing an added row drops it`;
  - `removing an existing row sends its id`;
  - `applyAssignments goes through runAction`;
  - `dryRunAssignments carries the runaction-exempt marker and does not toast`.
- [ ] **Step 2:** `cd apps/web && npx vitest run src/components/configurationPolicies/appliesTo/appliesToDraft.test.ts src/components/configurationPolicies/appliesTo/appliesToApi.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Add `appliesTo/appliesToApi.ts` to `TARGET_GLOBS`.
- [ ] **Step 4:** Rerun, plus `src/lib/__tests__/no-silent-mutations.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): staged applies-to draft and client (#<sub-issue>)`.

#### Task P2: Drill-down target picker

**Files:** Create `appliesTo/TargetPicker.tsx` and `appliesTo/TargetPicker.test.tsx`.

**Interfaces:**

```ts
type TargetPickerProps = {
  owner: { kind: 'msp' } | { kind: 'org'; orgId: string; orgName: string | null };
  onPick: (t: { level: ConfigPolicyTargetLevel; targetId: string; name: string }) => void;
};
```

Server queries:
- `/orgs/organizations?search=`;
- `/orgs/sites?orgId=&search=` (R4);
- `/device-groups?orgId=&search=`, and `/device-groups?ownerScope=partner&search=` (with `skipOrgIdInjection`, as `PartnerGroupAssignmentSection` does);
- `/devices?orgId=&search=&limit=50`.

Testids: `target-picker-level-<level>`, `target-picker-search`, `target-picker-option-<id>`.

- [ ] **Step 1: Failing tests:**
  - `an org-managed policy's picker only queries its own organization` (#6339, at every level);
  - `MSP-owned groups are offered only on an MSP-managed policy`;
  - `search hits the server with the query`;
  - `a device option shows its site`.
- [ ] **Step 2:** `cd apps/web && npx vitest run src/components/configurationPolicies/appliesTo/TargetPicker.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): drill-down target picker searched on the server (#<sub-issue>)`.

#### Task P3: Target rows and the panel

**Files:** Create `appliesTo/TargetRow.tsx`, `appliesTo/AppliesToPanel.tsx` and their tests.

Rules:
- **Top choice: All organizations or Specific targets.** All organizations is a `partner` row, offered on MSP-managed policies only.
- **Rows edit in place.** Role and OS use `AssignmentRoleOsFilters`; Priority sits under Advanced.
- **The legend is fixed** (Global Constraints).
- **The foot shows the dry-run delta**, debounced by 400 ms: "Apply · adds {{added}} devices, removes {{removed}}". "0 matching devices" is a warning.
- **A 409 `assignment_conflict` keeps the draft and offers Reload.**
- **Closing with a dirty draft asks first.** Use the `Drawer` `closeDisabled` prop with its reason, plus a discard confirm.

Testids: `applies-to-panel`, `applies-to-all-orgs`, `applies-to-specific`, `applies-to-row-<key>`, `applies-to-apply`, `applies-to-delta`, `applies-to-legend`.

- [ ] **Step 1: Failing tests:**
  - `Apply states the delta before committing`;
  - `zero matching devices is a warning`;
  - `a 409 keeps the draft and offers reload`;
  - `closing a dirty draft asks first`;
  - `All organizations is not offered on an org-managed policy`;
  - `an org-managed policy shows its organization locked`;
  - `the legend is always shown`.
- [ ] **Step 2:** `cd apps/web && npx vitest run src/components/configurationPolicies/appliesTo/TargetRow.test.tsx src/components/configurationPolicies/appliesTo/AppliesToPanel.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement. Add `appliesTo/AppliesToPanel.tsx` to `TARGET_GLOBS`.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): one applies-to panel with staged Apply (#<sub-issue>)`.

#### Task P4: Wire it in; counts; retire the old editors

**Files:**
- Modify: `ConfigPolicyDetailPage.tsx` (the drawer renders `AppliesToPanel`), `AppliesToStrip.tsx` (device count), `ConfigPolicyList.tsx` (one `fetchReach` per page), and their tests.
- Delete: `AssignmentsTab.tsx`, `OrganizationScopePanel.tsx`, `PartnerGroupAssignmentSection.tsx` and their tests. Remove their three `TARGET_GLOBS` entries after P1 and P3 added the successors. Delete the locale key groups only they read (`assignmentsTab`, `organizationScopePanel`, `partnerGroupAssignment`), after grepping, in all 8 locales.

- [ ] **Step 1: Failing tests:**
  - `the drawer renders the applies-to panel`;
  - `the strip shows the direct device count when reach is known`;
  - `the list asks for reach once per page`;
  - `a reach failure leaves the counts out and the page usable`.
- [ ] **Step 2:** `cd apps/web && npx vitest run src/components/configurationPolicies/ConfigPolicyDetailPage.test.tsx src/components/configurationPolicies/AppliesToStrip.test.tsx src/components/configurationPolicies/ConfigPolicyList.test.tsx src/lib/__tests__/no-silent-mutations.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement, then delete the three components.
- [ ] **Step 4:** Rerun, plus the i18n batch (`keyUsage` catches a deleted key that is still read). Expected: PASS.
- [ ] **Step 5: Commit** `refactor(web): the policy page uses the unified applies-to panel (#<sub-issue>)`.

#### Task P5: Device Groups bulk apply is one request

**Files:**
- Modify: `apps/web/src/components/devices/DeviceGroupsPage.tsx` (`handleBulkPolicy`)
- Test: create `DeviceGroupsPage.bulkPolicy.test.tsx`, beside the existing `DeviceGroupsPage.*.test.tsx` files

The Site page needs no web change: W02b fixed its data. Check it in P6's walk-through.

- [ ] **Step 1: Failing tests:** `bulk apply sends one apply request with one add per group, through runAction`; `a 409 names the group that collided`.
- [ ] **Step 2:** `cd apps/web && npx vitest run src/components/devices/DeviceGroupsPage.bulkPolicy.test.tsx src/components/devices/DeviceGroupsPage.bulkScript.test.tsx src/components/devices/DeviceGroupsPage.partnerGroups.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement. The page's other handlers stay on `RUN_ACTION_MIGRATION_BACKLOG`.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5: Commit** `fix(web): apply a policy to several device groups in one change (#<sub-issue>)`.

#### Task P6: Locales, docs, release notes, E2E, PR

- [ ] Add the P1–P5 keys to all 8 locales and run the i18n batch.
- [ ] Docs: rewrite "Where a policy applies" for the panel, staged Apply, the delta, narrower MSP-managed targets, and the legend. Regenerate the index, then run `aiToolsDocs.test.ts`.
- [ ] Append to the release notes:
  - **One Applies-to editor for every configuration policy.** Changes are staged and committed with one Apply, which states how many devices it adds and removes.
  - MSP-managed policies can now target sites, device groups and devices.
  - Device counts show on the policy page and the list.
  - An MSP-managed policy assigned at a site now shows on that Site page.
  - New routes: `POST /configuration-policies/:id/assignments/apply`, `GET /configuration-policies/:id/reach` and `GET /configuration-policies/reach`.
  - `GET /orgs/sites` accepts `search`.
- [ ] Extend `e2e-tests/tests/config-policy-applies-to.spec.ts`:
  - add a site and a device target to an MSP-managed policy;
  - see the delta, Apply, and see the strip count;
  - the W1 steps switch from `org-scope-org-*` to `target-picker-*` and `applies-to-*`.
- [ ] **Wave verification:** every W02c command, the web typecheck and lint, and the Playwright spec on a worktree stack. Walk the Site page with an MSP-managed policy assigned there. Tear the stack down.
- [ ] Open PR `feat(web): one applies-to editor with staged Apply (#<sub-issue>)`, then one Opus review. `Migration slot: none`.

**W2 exit checklist:** Apply is all-or-nothing and diff-shaped, with every gate today's POST has. Reach is counted in the caller's context and never audits. The three old editors are gone. MSP-managed site, group and device targets work. The target listing shows MSP-managed policies to their partner. Contracts and integration suites are green.

---

## W3 — Read scoping, one page shape, inactive until activated

Spec wave row W3, "Policy page", "Save model", "Create", "Policy list", "Inheritance display", "Tenancy & data model impact", and Decisions 1–5. Full rigor.

**Every W3 part's Step 0:** the baseline check, plus `git cat-file -e origin/main:apps/api/src/services/configPolicyReach.ts` (W2 merged).

### W03a — Read scoping and list filters (API)

**Requirement (spec "Tenancy & data model impact", Decision 2).** A caller may list, open or name an MSP-managed policy only when it applies to an organization that caller can access (D14). This covers org-scope callers and partner-scope callers whose org access is not "all", on every surface that lists, opens or names policies, the parent picker included. Full-access partner users and system scope keep seeing every policy of their partner. An org admin sees the MSP-managed policies that apply to their organization read-only, and only those are offered as parents. Writes are unchanged.

#### Task S1: The reader inventory

**Files:** none changed. The output is a table in the PR body.

- [ ] **Step 1:** List every reader of `configuration_policies` rows or names under `apps/api/src/{routes,services,jobs}`. Two searches find them: `rg -l "configurationPolicies\.name|policyAccessCondition"`, and every caller of `getConfigPolicy`, `listConfigPolicies` and `listEligibleParentPolicies`.
- [ ] **Step 2:** Classify each reader:
  - **gated:** it reads through `policyAccessCondition` and moves to the read predicate in S3;
  - **device-scoped:** it names only policies that already apply to a device the caller can reach;
  - **needs the predicate:** S3 adds it.

  Every "needs the predicate" row becomes a case in S5's matrix.
- [ ] **Step 3:** Commit nothing. Paste the table into the PR draft.

#### Task S2: The read predicate

**Files:**
- Create: `apps/api/src/services/configPolicyReadScope.ts`, `configPolicyReadScope.test.ts`

**Interfaces (produced):**

```ts
export function policyReadCondition(auth: AuthContext): SQL | undefined;
//   system ⇒ undefined; full-access partner ⇒ policyAccessCondition(auth); else orgCondition OR (partner-owned AND applies to an accessible org)
export function policyAppliesToOrgsSql(orgIds: readonly string[], partnerId: string): SQL; // the D14 EXISTS clauses
export type PolicyViewerAccess = { canEdit: boolean; reason: 'msp_managed_limited_access' | 'msp_managed_org_user' | 'site_restricted' | null };
export function policyViewerAccess(auth: AuthContext, policy: { orgId: string | null }): PolicyViewerAccess;
```

- [ ] **Step 1: Failing tests:**
  - `policyReadCondition leaves full-access partners and system unchanged`;
  - `an org-scope caller's condition admits partner-owned rows only through the applies-to clause`;
  - `a limited partner caller's condition uses its accessible org ids`;
  - `policyAppliesToOrgsSql covers the five D14 clauses`. Pin the compiled SQL, as `buildPartnerLevelCondition` is pinned.
  - `policyViewerAccess explains read-only for limited and org callers, and for a site-restricted caller`.
- [ ] **Step 2:** `cd apps/api && npx vitest run src/services/configPolicyReadScope.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. The SQL reads only tables the caller's RLS context already reads.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): read predicate for MSP-managed configuration policies (#<sub-issue>)`.

#### Task S3: Wire the predicate into every read surface

**Files:**
- Modify `services/configurationPolicy.ts`:
  - `getConfigPolicy(id, auth, opts?: { access?: 'read' | 'write' })`, default `'write'`;
  - the `childPolicies` embed is filtered by `policyReadCondition`;
  - `listConfigPolicies` and `listEligibleParentPolicies` use the predicate.
- Modify `routes/configurationPolicies/crud.ts`: `GET /:id` passes `'read'` and gains `access`. Modify `assignments.ts` (`GET /assignments/target`), the read handlers of `services/aiToolsConfigPolicy.ts`, and every "needs the predicate" row from S1.
- Tests: `crud.test.ts`, `assignments.test.ts`, `src/services/aiToolsConfigPolicy.test.ts`

- [ ] **Step 1: Failing tests:**
  - `getConfigPolicy defaults to the write-side reader`;
  - `GET /:id reads with the read predicate and returns access`;
  - `PATCH, DELETE and the assignment writes still use the write-side reader`;
  - `eligible parents use the read predicate`;
  - `the childPolicies embed lists only children the caller may read`;
  - `the AI read tools use the read predicate`.
- [ ] **Step 2:** Run all `crud*.test.ts` and `assignments*.test.ts` files by name, plus `src/services/aiToolsConfigPolicy.test.ts src/services/aiToolsConfigPolicy.outputShape.test.ts src/services/aiToolsConfigPolicy.siteScope.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun. Expected: PASS. If an AI tool's output shape changed, check the line-keyed AI-tool contracts (`aiTools.userOwnedRelease.contract.test.ts`).
- [ ] **Step 5: Commit** `feat(api): configuration policy reads follow the applies-to rule (#<sub-issue>)`.

#### Task S4: List filters

**Files:**
- Modify: `packages/shared/src/validators/index.ts` (`listConfigPoliciesSchema` gains `appliesToOrgId: z.string().guid().optional()` and `notApplied: z.enum(['true']).optional()`), `services/configurationPolicy.ts` (`listConfigPolicies`) and `routes/configurationPolicies/crud.ts`.
- Tests: `crud.test.ts`, and a new `services/configPolicyListFilters.test.ts`

Rules:
- `appliesToOrgId=X` returns policies that apply to X, of any status, plus inactive policies with no assignments (Q3).
- `notApplied=true` returns policies with no assignments and no children.
- The existing `orgId` keeps its meaning (spec "API changes" 3).

- [ ] **Step 1: Failing tests:**
  - `appliesToOrgId returns applying policies plus unassigned inactive ones`;
  - `appliesToOrgId refuses an org the caller cannot access`;
  - `notApplied returns policies with no rows and no children`;
  - `orgId keeps its existing meaning`.
- [ ] **Step 2:** Run `crud.test.ts`, the new file and `packages/shared` `index_configpolicy.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement with `policyAppliesToOrgsSql([X], partnerId)`.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): list configuration policies by where they apply (#<sub-issue>)`.

#### Task S5: The integration matrix, contracts, PR

**Files:** Create `apps/api/src/__tests__/integration/configPolicyReadScope.integration.test.ts`.

The matrix runs through the real router on real Postgres. Callers:
- org-scope in organization A;
- partner-scope with access to A only;
- partner-scope with access to all;
- system.

Policies (all MSP-managed unless noted):
- P1 targeted only at organization B;
- P2 at the partner level;
- P3 at a site in A;
- P4 at an MSP-owned device group whose only member is in B;
- P5 with no targets and an org-managed child in A;
- P6 with no targets and no children.

Surfaces:
- `GET /`, `GET /:id`, `GET /eligible-parents`;
- the `childPolicies` and `parentPolicy` embeds;
- `GET /assignments/target`;
- the AI read tools;
- every S1 "needs the predicate" row.

- [ ] **Step 1: Write the cases.**
  - The two limited callers see P2, P3 and P5 on every surface, and never P1, P4 or P6.
  - The full-access partner and system see all six.
  - Writes by the limited callers on P2, P3 and P5 are refused as today.
  - Include the spec's named case: `a caller limited to one organization cannot list, open or name a policy targeted only at another`.
- [ ] **Step 2:** Run it on the test stack, with `configPolicyPartnerWideSelect`, `configurationPoliciesPartnerRls`, `configurationPolicyOrgScopedPartnerWide` and `configPolicyInheritance`. Expected: PASS. Tear the stack down.
- [ ] **Step 3:** Run the contract batch from R5 and both typechecks.
- [ ] **Step 4:** Open the PR, with the S1 table, then one independent Opus review. **Do not enqueue until W03d is approved and green** (release unit). `Migration slot: none`.

### W03b — Page shell: rail, header, details form (web)

#### Task H1: A status slot on the settings rail

**Files:**
- Modify: `apps/web/src/components/settings/SettingsSectionNav.tsx` (D15)
- Test: `SettingsSectionNav.test.tsx`

- [ ] **Step 1: Failing tests:** `status replaces the description and joins the accessible name`; `callers without status render as before`.
- [ ] **Step 2:** `cd apps/web && npx vitest run src/components/settings/SettingsSectionNav.test.tsx src/components/settings/OrgSettingsPage.test.tsx src/components/settings/PartnerSettingsPage.test.tsx src/components/settings/PartnerSettingsPage.layout.test.tsx src/components/settings/PartnerSettingsPage.tabs.test.tsx src/components/settings/PartnerSettingsPage.navGuard.test.tsx`. Expected: the first FAILS.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): a status line on settings rail items (#<sub-issue>)`.

#### Task H2: Feature state and the rail

**Files:** Create `apps/web/src/components/configurationPolicies/page/featureState.ts`, `page/FeatureRail.tsx` and their tests.

**Interfaces:**

```ts
export type FeatureState = 'set_here' | 'from_parent' | 'changed_from_parent' | 'not_set' | 'unavailable';
export function featureState(own: FeatureLink | undefined, parent: FeatureLink | undefined, gated: boolean): FeatureState;
export const FEATURE_RAIL_GROUPS: readonly { key: string; features: readonly FeatureType[] }[]; // D18, exhaustive over FeatureType
```

- [ ] **Step 1: Failing tests:**
  - `featureState covers the five states`;
  - `FEATURE_RAIL_GROUPS places every feature exactly once`;
  - `the rail lists 26 features in six groups with Compliance Status at the foot`;
  - `the rail announces each feature's state`;
  - `selecting a feature writes the hash`.
- [ ] **Step 2:** `cd apps/web && npx vitest run src/components/configurationPolicies/page/featureState.test.ts src/components/configurationPolicies/page/FeatureRail.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement on `SettingsSectionNav`. Below `lg` (1024 px), it already renders a select.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): grouped feature rail for configuration policies (#<sub-issue>)`.

#### Task H3: Header, details form, Overview removed, read-only viewer

**Files:**
- Create: `page/PolicyHeader.tsx`, `page/PolicyDetailsForm.tsx` and their tests.
- Modify: `ConfigPolicyDetailPage.tsx` (split down: rail on the left, the feature on the right, strip and header above) and its test.

Rules:
- The header shows name, description, the state pill, "Based on X", "Parent of N policies", and "Managed by <org>" only when org-managed. The "Based on X" link follows `canOpenPolicy`, with W03a's admitted parents now openable.
- The details form has Save and Cancel (`runAction`; Cancel restores).
- `#overview` lands on the first feature, with the details form open.
- With `access.canEdit === false`, every form renders read-only, and the reason shows in the header before any click. When `access` is absent (the API is not yet W03a), the page derives the reason client-side and fails closed to read-only on MSP-managed policies for org-scope callers.
- OneDrive Helper on an MSP-managed policy reads "unavailable on this policy", with the reason (Decision 4; D17).

- [ ] **Step 1: Failing tests:**
  - `the header shows Based on, Parent of and Managed by facts`;
  - `the details form saves through runAction and Cancel restores`;
  - `#overview lands on a feature`;
  - `a read-only viewer sees the reason before any click`;
  - `OneDrive Helper on an MSP-managed policy says why it is unavailable`;
  - `the tab strip is gone`.
- [ ] **Step 2:** `cd apps/web && npx vitest run src/components/configurationPolicies/page/PolicyHeader.test.tsx src/components/configurationPolicies/page/PolicyDetailsForm.test.tsx src/components/configurationPolicies/ConfigPolicyDetailPage.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): policy header and details form replace Overview (#<sub-issue>)`.

#### Task H4: Unsaved-changes guard and the rail's words

**Files:**
- Modify:
  - `featureTabs/FeatureTabShell.tsx` (D16 dirty detection, `useFeatureDirty`, and the D7 words Set here / From parent / Not set);
  - the six pickers in D16;
  - the four tab tests pinning the old badge text (`HelperTab`, `RemoteAccessTab`, `SecurityTab`, `SensitiveDataTab`).

The guard asks Discard or Stay when the user leaves a dirty feature: on a rail click, on `hashchange`, and on `beforeunload`.

- [ ] **Step 1: Failing tests:**
  - `typing in a feature marks it dirty`;
  - `a picker selection marks it dirty`;
  - `a successful save clears dirty`;
  - `leaving a dirty feature asks first`;
  - `the rail item of a dirty feature shows the unsaved dot`;
  - `the badge reads Set here, From parent or Not set`.
- [ ] **Step 2:** `cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/FeatureTabShell.test.tsx src/components/configurationPolicies/featureTabs/FeatureTabShell.confirm.test.tsx src/components/configurationPolicies/featureTabs/HelperTab.test.tsx src/components/configurationPolicies/featureTabs/RemoteAccessTab.test.tsx src/components/configurationPolicies/featureTabs/SecurityTab.test.tsx src/components/configurationPolicies/featureTabs/SensitiveDataTab.test.tsx src/components/configurationPolicies/ConfigPolicyDetailPage.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun, plus every `featureTabs/*.test.tsx` file by name. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): unsaved feature changes are never lost silently (#<sub-issue>)`.

#### Task H5: Locales and PR

- [ ] Add the H1–H4 keys to all 8 locales and run the i18n batch.
- [ ] Run the web typecheck and lint.
- [ ] Open the PR, with the Rule 9 line ("adds no setting"), then one Opus review. No docs here: W03d owns them.

### W03c — Feature actions and the save model (web)

**Step 0** adds: W03b is merged (this part edits the same shell).

#### Task F1: One rule for Remove and Reset to parent

**Files:**
- Create: `featureTabs/featureEditAction.ts` and its test, and `featureTabs/featureEditAction.parity.test.tsx`
- Modify: the 26 tabs' `onRemove` and `onRevert` props. Five key on `parentLink` today, the rest on `linkedPolicyId`.

**Interfaces:**

```ts
export function featureEditAction(own: FeatureLink | undefined, parent: FeatureLink | undefined): 'remove' | 'reset_to_parent' | null;
// own && parent ⇒ 'reset_to_parent'; own && !parent ⇒ 'remove'; otherwise null
```

- [ ] **Step 1: Failing tests:**
  - `featureEditAction offers Reset only when the parent has the feature`;
  - `every tab wires its footer through featureEditAction`. The parity test renders each of the 26 tabs with own-only links and with own-plus-parent links, and checks which button shows.
- [ ] **Step 2:** `cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/featureEditAction.test.ts src/components/configurationPolicies/featureTabs/featureEditAction.parity.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement, then rewire the 26 tabs.
- [ ] **Step 4:** Rerun, plus every `featureTabs/*.test.tsx` file by name. Expected: PASS.
- [ ] **Step 5: Commit** `fix(web): Remove returns a feature to Not set or to its parent (#12263)`.

#### Task F2: "Change for this policy"

**Files:** Modify `featureTabs/FeatureTabShell.tsx` and its test. Fix any tab whose `handleSave` cannot create a link while `existingLink` is undefined.

- [ ] **Step 1:** List each tab's `handleSave` path for an inherited tab. The shell will call `onSave` once the form is unlocked, so `handleSave` must create a link when `existingLink` is undefined. Record the tabs that fail.
- [ ] **Step 2: Failing tests:**
  - `Change for this policy unlocks without writing`;
  - `Save after unlocking writes once`;
  - `onOverride is no longer called`;
  - for each tab Step 1 listed, `<Tab> creates its own link from inherited values on Save`.
- [ ] **Step 3:** Run them. Expected: FAIL.
- [ ] **Step 4:** Implement. Rerun. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): change an inherited feature without writing until Save (#<sub-issue>)`.

#### Task F3: Reach on saves; Activate and Deactivate

**Files:** Create `page/ReachLine.tsx` and `page/PolicyStateActions.tsx` and their tests. Modify `FeatureTabShell.tsx` (the Save label).

Rules:
- On an active policy, Save reads "Save · reaches {{count}} devices" (`direct + throughChildren`, W02a).
- An inactive or unapplied parent reads "In use through {{policies}} policies · {{devices}} devices", and its saves carry that reach.
- Activate and Deactivate state their reach. They use the existing `PATCH /:id` `status`, through `runAction`. Activate keeps the OEM arming gate already on that route.

- [ ] **Step 1: Failing tests:**
  - `the save reach line shows direct plus through-children on an active policy`;
  - `an unapplied parent's saves carry its through-children reach`;
  - `Activate states its reach and patches status`;
  - `Deactivate never runs the arming gate`;
  - `a 403 from the arming gate is shown, not swallowed`.
- [ ] **Step 2:** `cd apps/web && npx vitest run src/components/configurationPolicies/page/ReachLine.test.tsx src/components/configurationPolicies/page/PolicyStateActions.test.tsx src/components/configurationPolicies/featureTabs/FeatureTabShell.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): saves and activation state how many devices they reach (#<sub-issue>)`.

#### Task F4: Locales and PR

- [ ] Add the F1–F3 keys to all 8 locales and run the i18n batch.
- [ ] Run the web typecheck and lint.
- [ ] Open the PR (`Closes #12263`), then one Opus review.

### W03d — One-page create, owner default, list filters (web)

**Step 0** adds: W03c is merged, and W03a's PR is approved, green and not yet merged (release unit).

#### Task C1: Create mode on the page shell

**Files:**
- Modify: `apps/web/src/pages/configuration-policies/new.astro` (today it renders `ConfigPolicyCreatePage` under `titles.configurationPoliciesNew`; keep the title key), `ConfigPolicyDetailPage.tsx` (an optional `policyId`; create mode when it is absent), and `ConfigPolicyCreatePage.tsx` (reduced to the Start-from chooser: Blank, or Based on a parent policy).
- Tests: `ConfigPolicyCreatePage.test.tsx`, `ConfigPolicyDetailPage.test.tsx`

Rules:
- **Every feature is browsable before any save.**
- **The first feature Save** posts `{ name, status: 'inactive', ownerScope or orgId, parentPolicyId? }`, then the feature, then `replaceState`s to `/configuration-policies/<id>#<feature>`. Only a name is needed first.
- **If the feature save fails after the create,** the policy stays as an inactive, unapplied policy, and the page says so.
- **`?feature=<type>` opens that feature.** Today the create page ignores the parameter Breeze Defaults sends.
- **Managed by and Based on are fixed at the first save.** The page says so before that save. Afterwards it gives the reason, with no action until W05b (D17).

- [ ] **Step 1: Failing tests:**
  - `nothing is created until the first feature save`;
  - `the first save creates the policy inactive, then saves the feature`;
  - `a failed feature save leaves an inactive policy and says so`;
  - `?feature= opens that feature`;
  - `owner and parent lock after the first save`;
  - `a name is required before the first save`.
- [ ] **Step 2:** `cd apps/web && npx vitest run src/components/configurationPolicies/ConfigPolicyCreatePage.test.tsx src/components/configurationPolicies/ConfigPolicyDetailPage.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement. The create POST goes through `runAction`. Add `ConfigPolicyCreatePage.tsx` to `TARGET_GLOBS`, or remove it if it is gone.
- [ ] **Step 4:** Rerun, plus `src/lib/__tests__/no-silent-mutations.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): create a policy on the policy page; it starts inactive (#<sub-issue>)`.

#### Task C2: Owner default and the Managed-by line

**Files:** Modify `page/PolicyHeader.tsx` and the linked-entity pickers on MSP-managed policies (`featureTabs/PolicyLinkSelector.tsx`, `InlineEntityPicker.tsx`), with tests.

Rules (Decision 1):
- **A partner user with full org access** gets MSP-managed. The full-access signal is `useAuthStore().user.canManagePartnerWide` (`stores/auth.ts`, set from `/users/me`; `lib/navGates.ts` already gates on it). `undefined` while loading counts as not full access, and the default is re-evaluated once it resolves, before the first save.
- **A partner user without full access** gets org-managed, owned by the switcher's org. They must choose one when none is selected.
- **An org-scope user** gets their own org.
- **The trade sentence** (spec Decision 1) shows on the Managed-by line before the first save, and in each linked picker of an MSP-managed policy.

- [ ] **Step 1: Failing tests:**
  - `the owner default follows the caller's access`;
  - `a limited partner must pick an organization when none is selected`;
  - `the Managed-by line states the trade before the first save`;
  - `linked pickers on an MSP-managed policy state the trade`.
- [ ] **Step 2:** `cd apps/web && npx vitest run src/components/configurationPolicies/page/PolicyHeader.test.tsx src/components/configurationPolicies/featureTabs/RuleSetPicker.test.tsx`, plus each picker test it touches. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): new policies default to MSP-managed for full-access partners (#<sub-issue>)`.

#### Task C3: Activate with an explicit applies-to decision

**Files:** Modify `page/PolicyStateActions.tsx` (W03c) and `appliesTo/AppliesToPanel.tsx` (a staged mode with no policy id), with tests.

Rules:
- The primary action is "Activate · reaches {{count}} devices". It needs a name and either at least one staged target or the stated choice "Don't apply yet".
- The sequence is: create (if not yet created), then `apply` the staged targets, then `PATCH status: 'active'`.
- "Don't apply yet" leaves the policy inactive and unapplied.
- No target is pre-selected. The switcher's org is the first suggestion in the picker.

- [ ] **Step 1: Failing tests:**
  - `Activate needs a target or Don't apply yet`;
  - `Activate creates, applies, then activates, in that order`;
  - `a failed apply leaves the policy inactive`;
  - `no target is pre-selected; the switcher's org is first`.
- [ ] **Step 2:** `cd apps/web && npx vitest run src/components/configurationPolicies/page/PolicyStateActions.test.tsx src/components/configurationPolicies/appliesTo/AppliesToPanel.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): Activate states its reach and needs an applies-to decision (#<sub-issue>)`.

#### Task C4: The list on the server, filtered by where it applies

**Files:** Modify `ConfigurationPoliciesPage.tsx` and `ConfigPolicyList.tsx`, and their tests (`ConfigPolicyList.pagination.test.tsx` moves to server paging).

Rules:
- With one org selected, the list sends `appliesToOrgId` instead of `orgId`.
- Filters: state, not applied, organization.
- Paging and search run on the server. Today the page sends no `limit` and gets the API's default 25.

- [ ] **Step 1: Failing tests:**
  - `the org-filtered list asks for appliesToOrgId`;
  - `the not-applied filter sends notApplied=true`;
  - `paging and search go to the server`;
  - `the totals come from the server's total`.
- [ ] **Step 2:** `cd apps/web && npx vitest run src/components/configurationPolicies/ConfigurationPoliciesPage.test.tsx src/components/configurationPolicies/ConfigPolicyList.test.tsx src/components/configurationPolicies/ConfigPolicyList.pagination.test.tsx src/components/configurationPolicies/ConfigPolicyList.emptyState.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement. Use `window.location.hash` for the filter state (`useHashState`).
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): the policy list filters by where policies apply (#<sub-issue>)`.

#### Task C5: Locales, docs, release notes, E2E, wave verification

- [ ] Add the C1–C4 keys to all 8 locales and run the i18n batch.
- [ ] Docs: rewrite "Creating a policy" (one page, inactive until activated, Start from, owner and parent fixed at the first save). Describe the rail, Remove and Reset, the read-only view for customer admins, and the list filters. Regenerate the index and run `aiToolsDocs.test.ts`.
- [ ] Append to the release notes:
  - **New configuration policies start inactive** and are switched on with Activate, which states how many devices it reaches.
  - A grouped feature rail replaces the tab strip; Overview is gone.
  - New policies default to MSP-managed for partner users with full access.
  - Customer admins see, read-only, the MSP-managed policies that apply to their organization.
  - With one organization selected, the list shows the policies that apply to it.
  - `GET /configuration-policies` accepts `appliesToOrgId` and `notApplied`.
- [ ] E2E: create, set a feature, stage a target, Activate, and see the policy listed as Active with its target. Then use `?feature=patch` from Breeze Defaults.
- [ ] **Wave verification**, after W03a–W03c merge and W03d is rebased: every W3 command, both typechecks, the S5 integration matrix, and the Playwright spec on a worktree stack. Tear the stack down.
- [ ] Open the PR. One independent review covers the release unit (W03a + W03d). Enqueue W03a, then W03d.

**W3 exit checklist:** The read matrix is green on every surface in the S1 inventory. Writes are unchanged. There is one page for create and edit, with the rail, one save pattern per control, reach on saves, explicit Activate and the owner default. Docs, locales and release notes are in.

---

## W4 — Device-own settings

Not planned here: the companion spec (`2026-11-21-device-own-settings-spec.md`, #6670, #12293) is not approved.

---

## W5 — Outranked on N devices; Copy

**Every W5 part's Step 0:** the baseline check, plus W2 merged (`configPolicyReach.ts` on `main`). W05b also needs W3 merged and Q1 and Q2 answered.

### W05a — "Outranked on N devices" per feature

#### Task O1: `computePolicyPrecedence`

**Files:** Create `apps/api/src/services/configPolicyPrecedence.ts` and `configPolicyPrecedence.test.ts`.

**Interfaces:**

```ts
export const PRECEDENCE_SCAN_CAP = 5000; // devices
export interface FeaturePrecedence { reached: number; outranked: number }
export async function computePolicyPrecedence(auth: AuthContext, policyId: string):
  Promise<{ capped: true } | { capped: false; features: Partial<Record<ConfigFeatureType, FeaturePrecedence>> }>;
```

Algorithm:
- Take each feature the policy has in effect: its own links, or its parent's (`configPolicyEffectiveFeatureLinks`).
- Take the direct reach (W02a `expandAssignmentsToDevices`), and each reached device's best own assignment.
- Competitors are the active policies whose effective links include that feature. Expand their assignments the same way and intersect them with the reach.
- A device is outranked when a competitor beats this policy's best assignment by `LEVEL_PRIORITY`, then priority, then assignment age (the resolver's order).
- The whole computation runs in the caller's context.
- Over `PRECEDENCE_SCAN_CAP` reached devices, the answer is `{ capped: true }`.
- An inactive policy is evaluated as if active (Q6).

- [ ] **Step 1: Failing tests:**
  - `a more specific competitor outranks`;
  - `priority breaks a level tie`;
  - `assignment age breaks a priority tie`;
  - `an inactive competitor never outranks`;
  - `an inherited feature is counted for the child`;
  - `over the cap returns capped`.
- [ ] **Step 2:** `cd apps/api && npx vitest run src/services/configPolicyPrecedence.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun, plus `src/__tests__/parkedFanout.contract.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): count where another policy wins each feature (#<sub-issue>)`.

#### Task O2: Route and parity proof

**Files:**
- Create: `routes/configurationPolicies/precedence.ts`, its test, and its `MCP_COVERAGE` entry (`tool_in_later_wave`). Mount it before `crudRoutes`.
- Create: `__tests__/integration/configPolicyPrecedence.integration.test.ts`.

- [ ] **Step 1: Failing tests:**
  - Route: `GET /:id/precedence 404s on an invisible policy`; `returns capped over the cap`.
  - **The parity proof (integration):** on a seeded tree, for every reached device and feature, `outranked` agrees with whether `resolveEffectiveConfig`'s winner is another policy.
- [ ] **Step 2:** Run the route test, then the integration file on the test stack. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun, plus the contract batch and the API typecheck. Expected: PASS. Tear the stack down.
- [ ] **Step 5: Commit** `feat(api): precedence route for configuration policies (#<sub-issue>)`.

#### Task O3: Web, locales, docs, release notes, PR

**Files:** A per-feature line in `page/PolicyHeader.tsx` or the feature header, and in the rail item's status: "Outranked on {{count}} devices", with a link to the device list filtered by policy if one exists (check; otherwise no link). Locales (8), docs, release notes.

- [ ] **Step 1: Failing tests:** `the feature shows Outranked on N devices`; `capped says to open a device`; `zero outranked shows nothing`.
- [ ] **Step 2:** Run them. Expected: FAIL. Implement. Rerun. Expected: PASS.
- [ ] **Step 3:** Add the locales, docs and index. Append to the release notes: **"Outranked on N devices" on each feature of a configuration policy** shows where a more specific policy wins that feature. New route: `GET /configuration-policies/:id/precedence`.
- [ ] **Step 4:** Open the PR, then one independent review. `Migration slot: none`.

### W05b — Copy (#12309, #11776)

**Blocked on Q1 and Q2.** Planned to the recommended answers.

#### Task K1: Copy service and schema

**Files:** Create `apps/api/src/services/configPolicyCopy.ts` and its test. Modify `packages/shared/src/validators/index.ts` (`copyConfigPolicySchema`).

**Interfaces:**

```ts
export const copyConfigPolicySchema = z.object({
  name: z.string().min(1).max(255),
  ownerScope: z.enum(['organization', 'partner']),
  orgId: z.string().guid().optional(),
  parentPolicyId: z.string().guid().nullable().optional(),
  dryRun: z.boolean().optional(),
});
export async function copyConfigPolicy(auth: AuthContext, sourceId: string, input: CopyConfigPolicyInput):
  Promise<{ dryRun: true; carried: ConfigFeatureType[]; dropped: { featureType: ConfigFeatureType; reason: string }[] }
        | { dryRun: false; policyId: string; dropped: { featureType: ConfigFeatureType; reason: string }[] }>;
```

Rules:
- The copy is created `inactive`, with no assignments.
- It carries the source's own feature links. Inline settings are copied; linked entities are referenced, not cloned (#12309's safer default).
- Each link is revalidated for the new owner with `validateFeaturePolicyExists`, `PARTNER_LINKABLE_FEATURE_TYPES` and `ORG_SCOPED_ONLY_FEATURE_TYPES`. A link that cannot be carried goes into `dropped`, with its reason.
- The source is read with `getConfigPolicy(…, { access: 'read' })`.

- [ ] **Step 1: Failing tests:**
  - `copy is inactive with no assignments`;
  - `copy to MSP-managed drops org-owned links and says why`;
  - `OneDrive Helper is dropped when copying to MSP-managed`;
  - `a dry run writes nothing`;
  - `copy cannot read a source the caller cannot read`.
- [ ] **Step 2:** `cd apps/api && npx vitest run src/services/configPolicyCopy.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. The writes run in one `withDbTransaction`, with the catch outside.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): copy a configuration policy (#12309)`.

#### Task K2: Route, gates, integration

**Files:** `POST /:id/copy` goes in `routes/configurationPolicies/crud.ts` (its existing `MCP_COVERAGE` entry covers it), with `crud.copy.test.ts`. Create `__tests__/integration/configPolicyCopy.integration.test.ts`.

The route applies the create gates:
- `devices.write` + MFA;
- `canMutateOrgWideGovernance`;
- `canManagePartnerWidePolicies` for a partner owner;
- the parent compatibility check (`InvalidParentPolicyError`);
- the HP CMSL and OEM gates when a carried link arms them.

- [ ] **Step 1: Failing tests:**
  - `copy re-runs the arming gates`;
  - `a limited partner cannot copy to MSP-managed`;
  - `a site-restricted caller cannot copy`;
  - integration: `a copy across organizations references only entities the new owner may link`.
- [ ] **Step 2:** Run them (the integration file on the test stack). Expected: FAIL.
- [ ] **Step 3:** Implement. `crud.ts` must keep naming `canManagePartnerWidePolicies` and `canMutateOrgWideGovernance` for the textual coverage contracts.
- [ ] **Step 4:** Rerun, plus the contract batch and both typechecks. Expected: PASS. Tear the stack down.
- [ ] **Step 5: Commit** `feat(api): copy route for configuration policies (#12309, #11776)`.

#### Task K3: Web, locales, docs, release notes, PR

**Files:** A Copy action on the header and on list rows, and at the D17 places (a locked owner or parent, an unavailable OneDrive Helper). A Copy dialog runs the dry run and confirms the dropped list. Locales (8), docs, release notes.

- [ ] **Step 1: Failing tests:**
  - `Copy shows what will not be carried before it copies`;
  - `Copy lands on the new inactive policy`;
  - `a locked owner offers Copy`;
  - `OneDrive Helper on an MSP-managed policy offers Copy to one organization`.
- [ ] **Step 2:** Run them. Expected: FAIL. Implement through `runAction`; the dry run carries the exempt marker. Rerun. Expected: PASS.
- [ ] **Step 3:** Add the locales, docs and index. Append to the release notes: **Copy a configuration policy**, to the same owner or to another organization or your MSP (#12309, #11776). The copy starts inactive and unapplied, and lists any feature the new owner cannot carry. New route: `POST /configuration-policies/:id/copy`.
- [ ] **Step 4:** Open the PR (`Closes #12309`, `Closes #11776`), then one independent review. `Migration slot: none`.

---

## CI traps

- **Integration suites run only under Integration Tests** (`configPolicyAppliesToSummary`, `configPolicyReach`, `configPolicyAssignmentApply`, `configPolicyReadScope`, `configPolicyPrecedence`, `configPolicyCopy`). A green unit run proves nothing about them.
- **A returned 409 commits the request transaction.** Apply's writes need `withDbTransaction`, with the catch outside it. Prove it on real Postgres, not with mocks.
- **`partner-wide-write-coverage.test.ts` and `site-ceiling-write-coverage.test.ts` are textual.** `assignmentGates.ts` and `configPolicyCopy.ts` must name `canManagePartnerWidePolicies` and `canMutateOrgWideGovernance` themselves.
- **`mcp-coverage.test.ts`** fails on a new route file without an entry (`reach.ts`, `precedence.ts`).
- **`parkedFanout.contract.test.ts`** lives in `__tests__/`, which fixers miss. Run it whenever a services file is added.
- **`no-silent-mutations`.** Deleting guarded files (W02c) without adding their successors first can drop the list below `MIN_GUARDED_FILES`.
- **Locales.** All 8. No `t(cond ? a : b)`. No key leaf equal to its value. A changed `en` value is retranslated, not copied.
- **Docs index.** Any `.mdx` change without `npx tsx scripts/build-docs-index.ts` fails `aiToolsDocs.test.ts`. Two parts that regenerate it merge one after the other.
- **Release-notes draft.** Append only; rebase just before the PR.
- **tsc under a pipe** reads an OOM as green. Always `echo "exit=$?"`.

## Out of scope

Per the spec:
- the insides of the 26 feature forms, the resolver rules and the one-level parent rule;
- draft/publish for active edits;
- exclusion targeting and field-level merging;
- tag and dynamic filters (#7414, #8957);
- #3381's confirmation rule (this plan provides the place and the number);
- the backup setup pages (#12308);
- AI tool changes (`aiToolsConfigPolicy.ts` read handlers change only in W03a, to obey the read rule);
- device-own settings (W4).

## Self-review

- **Spec coverage.**
  - W1 row: the strip (B2), the warning on the page (B2) and in the list (B3), the list column with the API summary (A1–A3, B3), the vocabulary and contradictory copy (B5), the device tab winner link, level, reason and shared labels (A3, B1, B4), and the badges into i18n (B1).
  - W2 row: the unified editor with staged Apply (W02b, W02c), MSP-managed narrower targets (W02c), reach (W02a, W02c), the target listing (W02b).
  - W3 row: one-page create and inactive until activated (W03d), the rail (W03b), the save model (W03b, W03c), the owner default with the read rule (W03a, W03d), the list filter (W03a, W03d).
  - W5 row: W05a, W05b. W4: one line.
  - "API changes" 1–6 map to W02b, W02a, W03a, W03d (activation needs no endpoint), W02b and W03a.
- **Step scan.** Every part has task blocks with files, interfaces, failing-test names, the command and the commit. Steps that wait on an earlier outcome say so in that step: W02c's Step 0, F2's per-tab check, C2's signal, and W05b's Q1 and Q2.
- **Type consistency.** The same names are used throughout: `ConfigPolicyAppliesToSummary`, `APPLIES_TO_SUMMARY_TARGET_LIMIT`, `appliesToState`, `loadAppliesToSummaries`, `policyOwners`, `configFeatureLabel`, `configTargetLevelLabel`, `parseAppliesTo`, `formatAppliesToTargets`, `canOpenPolicy`, `lostReason`, `ConfigPolicyReach`, `computePolicyReach`, `expandAssignmentsToDevices`, `applyAssignmentsSchema`, `updateAssignment`, `checkPolicyAssignableBy`, `checkAddArming`, `checkAddLevel`, `policyReadCondition`, `policyAppliesToOrgsSql`, `policyViewerAccess`, `featureState`, `featureEditAction`, `computePolicyPrecedence`, `copyConfigPolicy`.
- **Review Focus.** Each of the five has a named test in its owning task.

## Questions for the owner

Product calls the spec does not settle. Each part is written to the recommended default and says so in its PR body.

1. **Is Copy in this spec (W5) or out of it?** The wave table puts Copy in W5. "Out of scope" excludes "Duplicate and copy-between-orgs themselves (#12309, #11776)".
   - **(a) In: W05b ships Copy** as the exit the spec relies on (a locked owner or parent, OneDrive Helper on an MSP-managed policy). Pro: those states get an action. Con: it takes over #12309 and #11776.
   - **(b) Out: W5 ships only "Outranked"**, and W3's exits stay text-only until #12309 lands on its own plan.
   - **Recommend (a).** Three W3 states name Copy as the only way forward.
2. **When a copy changes owner and a linked entity cannot be linked there**, should the copy drop that feature or be refused?
   - **(a) Drop it with a listed reason**, confirmed in a dry run. Pro: the common "make this MSP-managed" case works. Con: the copy is not identical.
   - **(b) Refuse the whole copy.**
   - **Recommend (a).**
3. **"Plus inactive ones" in the org-filtered list** (spec "Policy list").
   - **(a) Inactive policies that apply nowhere yet** (drafts). Pro: the list stays about the selected org.
   - **(b) Every inactive policy the caller can read.**
   - **Recommend (a).** W03a is written to it.
4. **Rail placement of the 20 features Decision 5 did not place.** D18 is the proposal: compliance under Security, warranty and time sync under Monitoring, OneDrive Helper under Access & end user, maintenance and automations under Lifecycle. Confirm or move.
5. **What counts as "applies to an organization" for the read rule** (D14)? The two clauses that are choices are:
   - an MSP-owned device group with a member in that org;
   - being the parent of a policy that applies there.

   Pro: the device's own precedence and the "Based on X" line stay explainable to that org. Con: a group's membership changes what an org admin can see.

   **Recommend both clauses on.**
6. **Should "Outranked on N devices" be computed for an inactive policy?**
   - **(a) Yes, as if active**, labelled the same. Pro: you see the effect before activating.
   - **(b) Hide it until active.**
   - **Recommend (a).**
