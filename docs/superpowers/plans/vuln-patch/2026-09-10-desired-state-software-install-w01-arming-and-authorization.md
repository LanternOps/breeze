---
tracking_issue: LanternOps/breeze#5505
---

# Wave 01 — Arming: `autoInstall`, verb-aware arming, install authorization, audit actions, violation `catalogId` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a software policy *expressible* and *authorizable* as "install this" — add the `autoInstall` arming flag end-to-end through the type and both HTTP schemas, turn the single-verb arming gate into a verb-aware one, gate arming behind deployment-grade authorization (`devices.execute` + MFA) evaluated over post-write merged state, create the four install audit-action constants, and put `catalogId` on the `missing` violation so a later wave has something to install. **Nothing dispatches an install in this wave.**

**Architecture:** Five independent, small surfaces in `apps/api`. `SoftwarePolicyRemediationOptions` gains `autoInstall?: boolean`, and the single shared `remediationOptionsSchema` (consumed by both `createPolicySchema` and `updatePolicySchema`) gains the matching zod field — without it a non-strict `z.object` silently strips the key. `evaluateSoftwarePolicyArming` gains a **required** second parameter `verb: 'uninstall' | 'install'` so the compiler finds every existing caller, and its three refusal messages become verb-aware. A new service `softwarePolicyAuthorization.ts` computes whether a write leaves the policy armed for install from the merged (stored row ⊕ request body) state and refuses without `devices.execute` + satisfied MFA. Four exported audit-action constants become the registry for install events (the column is a bare `varchar(50)` with no enum). Finally the `missing` violation emission carries `catalogId`/`reason`, which W02/W03 need to resolve what to install.

**Tech Stack:** Hono + Drizzle ORM + PostgreSQL, zod, Vitest (unit only — this wave adds no migration and no integration suite).

**Spec:** `docs/superpowers/specs/vuln-patch/2026-09-10-desired-state-software-install-design.md` — §1 (`autoInstall`), §5 (Authorization), §6 (Audit), plus the "Corrections after ground-truth verification" section, which supersedes the body. **NOT** §2 (compliance-worker branch), §3 (dispatch/deployment coupling), §4 (resolving what to install) — those are W02/W03.

**Cross-wave contract:** `contract-A-desired-state.md` (coordinator, authoritative). This wave implements D2, D3, D6, D9 and the `autoInstall` half of §1.

**Depends on:** nothing. W02 (#5507), W03 (#5508) and W05 (#5510) all consume interfaces this wave produces.

---

## Global Constraints

Copied from the cross-wave contract. These are locked; do not rename, re-shape, or re-decide any of them.

- **D2 — the arming helper gains a verb; it keeps its real name.**
  ```ts
  export type PolicyRemediationVerb = 'uninstall' | 'install';

  export type SoftwarePolicyUnarmedReason =
    'audit_mode' | 'enforce_mode_off' | 'auto_uninstall_off' | 'auto_install_off';

  export function readSoftwarePolicyAutoInstall(raw: unknown): boolean;

  export function evaluateSoftwarePolicyArming(
    policy: SoftwarePolicyArmingInput,
    verb: PolicyRemediationVerb
  ): SoftwarePolicyArmingState;
  ```
  A **required** second parameter — not optional, not defaulted — so the compiler finds both existing call sites (`softwareRemediationWorker.ts:318`, `aiToolsCompliance.ts:509`), which pass `'uninstall'`. The `audit_mode` and `enforce_mode_off` messages take the verb noun; `auto_install_off` gets its own message naming `remediationOptions.autoInstall`. A technician must be told WHICH verb is unarmed.
- **D3 — authorization: the delta is `devices.execute`, evaluated post-write.** New file `apps/api/src/services/softwarePolicyAuthorization.ts` exporting `assertMayArmInstall`. Semantics: if the write would leave the policy armed for install (`mode !== 'audit'` AND `enforceMode === true` AND `remediationOptions.autoInstall === true`), the caller MUST hold `devices.execute` AND have satisfied MFA. Assert **both** even though both current routes already carry `requireMfa()` — the assertion must stay correct if reused on a route without it. "Post-write state" = the merged result of the stored row and the request body, so editing the rules of an already-armed policy is also gated.
  Building blocks — use these, invent nothing:
  - `hasPermission(userPerms, PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action)` — `apps/api/src/services/permissions.ts:210`; constant `packages/shared/src/constants/permissions.ts:24`.
  - `hasSatisfiedMfa(auth)` — `apps/api/src/middleware/auth.ts:915`. Returns true when 2FA is globally disabled; that is intended, do not work around it.
  - MFA refusal shape copied from `requireMfa()` (`auth.ts:897-905`): `c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403)` — a coded body.
- **D6 — audit actions: new exported constants.** No const set exists to extend, so W01 creates one in `softwarePolicyService.ts` and every emitter imports it — no string literals at emit sites: `install_queued`, `install_succeeded`, `install_failed`, `install_gave_up`. Never reuse an uninstall action value. Existing uninstall action strings are **NOT** refactored.
- **D9 — the emitted `missing` violation must carry `catalogId`.** Add `catalogId?: string` (and `reason?: string`) to the emitted `rule` object at `softwarePolicyService.ts:333-347` AND to `SoftwarePolicyViolation['rule']`. `violations` is jsonb and `software_compliance_status` appears in no export or org-cascade registry, so this needs **no migration and no registration**. Re-matching a violation to its rule by name at install time is rejected: rule names are not unique within a policy.
- **`autoInstall` mirrors `autoUninstall` and deliberately does not share it.** A policy armed to remove unauthorised software is not thereby armed to install anything. Absent or non-boolean means NOT armed.
- **Red-first on every behavioural change:** write the assertion, watch it fail against unmodified code, then implement. A test written after the code confirms rather than discriminates.
- **Scoped test runs:** `cd apps/api && npx vitest run <path>`. Never `pnpm --filter <pkg> test -- --run <path>` (the `--` makes vitest run the whole suite in watch mode). Vitest's path filter is a plain **substring** match — no globbing, and a trailing slash silently skips sibling `foo.test.ts` files, so name files explicitly.
- **Typecheck:** `pnpm --filter @breeze/api exec tsc --noEmit` (there is no `typecheck` script in `apps/api/package.json`).

### Contract deviation (one, deliberate — flagged to the coordinator)

The contract states the D3 signature as `assertMayArmInstall(c: Context): Promise<void>`. That signature cannot be implemented:

1. `Promise<void>` cannot deliver the mandated coded 403 body. Hono handlers return responses; the contract explicitly forbids the `HTTPException` route.
2. `c` alone does not carry the **stored** policy row, which the post-write merged state requires. Re-reading it inside the helper would be a second query of a row the PATCH handler already loaded at `softwarePolicies.ts:531`, and could read a different row than the one the handler authorized.

Implemented instead, with the name, file path, semantics and refusal shape **exactly** as the contract specifies:

```ts
export async function assertMayArmInstall(
  c: Context,
  stored: SoftwarePolicyArmingInput | null,   // null on create
  patch: SoftwarePolicyInstallArmingPatch
): Promise<Response | null>;                   // null = allowed
```

Everything else in D2/D3/D6/D9 is implemented verbatim.

### Explicitly OUT OF SCOPE for this wave

State this in the PR body too. W01 does **not** touch:

- `apps/api/src/jobs/softwareComplianceWorker.ts` — the remediation gate (`:423-444`), its local `readRemediationOptions` (`:136-162`), `readEarliestUnauthorizedDetection` (`:164-182`, D10) and `shouldQueueAutoRemediation` (`:184-212`). D11 (removing the inline gate duplication) is **W02**.
- `apps/api/src/jobs/softwareRemediationWorker.ts` beyond adding the single `'uninstall'` argument at `:318`. No dispatch, no dedup, no payload type change.
- Any migration. This wave adds zero SQL files. The three `software_compliance_status` install columns are **W02** (`…150400`); `software_deployments.software_policy_id` is **W03** (`…150401`).
- Any AI file beyond the single `'uninstall'` argument the compiler forces at `aiToolsCompliance.ts:509`. `aiGuardrails.ts`, `aiToolSchemas.ts`, `aiAgentSdkTools.ts`, `aiToolsPolicyPrereqs.ts` and `summarizeEnforcementChange` are **W05**.
- Any `apps/web` file. The arm/disarm UI, dry-run count and `catalogId` authoring warning are **W04**.
- The `'outdated'` violation type. Reserved, never emitted, explicitly a spec non-goal — do not partially wire it.

---

## 0. Ground truth

Every citation below was re-opened in this worktree (`/Users/toddhebebrand/.herdr/worktrees/breeze/warranty-testing`, branch `spec/hp-warranty-and-desired-state-install`) on 2026-09-10. Nothing here is copied from the spec or the contract on trust.

**Confirmed exactly as the contract states:**

- `apps/api/src/db/schema/softwarePolicies.ts:65-71` — `SoftwarePolicyRemediationOptions`, five fields, no `autoInstall`:
  ```ts
  export type SoftwarePolicyRemediationOptions = {
    autoUninstall?: boolean;
    notifyUser?: boolean; // not yet implemented
    gracePeriod?: number; // hours; max 90 days
    cooldownMinutes?: number;
    maintenanceWindowOnly?: boolean; // not yet implemented
  };
  ```
- `apps/api/src/db/schema/softwarePolicies.ts:48-63` — `SoftwarePolicyViolation`. Its `rule` sub-object is `:55-60` and reads `{ name: string; minVersion?: string; maxVersion?: string; reason?: string }` — **no `catalogId`**.
- `apps/api/src/db/schema/softwarePolicies.ts:25-32` — `SoftwarePolicyRuleDefinition` HAS `catalogId?: string` at `:30` and `reason?: string` at `:31`.
- `apps/api/src/services/softwarePolicyService.ts:333-347` — the `missing` emission, verbatim:
  ```ts
      for (const rule of softwareRules) {
        const found = inventory.some((installed) => matchesSoftwareRule(installed, rule));
        if (!found) {
          violations.push({
            type: 'missing',
            rule: {
              name: rule.name,
              minVersion: rule.minVersion,
              maxVersion: rule.maxVersion,
            },
            severity: 'high',
            detectedAt,
          });
        }
      }
  ```
- `apps/api/src/services/softwarePolicyService.ts:159` — `SoftwarePolicyUnarmedReason = 'audit_mode' | 'enforce_mode_off' | 'auto_uninstall_off'`. `:161-163` `SoftwarePolicyArmingState`. `:165-169` `SoftwarePolicyArmingInput` = `{ mode: string | null | undefined; enforceMode: boolean | null | undefined; remediationOptions: unknown }`. `:172-175` `readSoftwarePolicyAutoUninstall`. `:177-206` `evaluateSoftwarePolicyArming`, **one parameter**. Refusal messages at `:184`, `:192-193`, `:201-202`, all three saying "uninstall" verbatim.
- `apps/api/src/services/softwarePolicyService.ts:533-573` — `recordSoftwarePolicyAudit`; its input declares `action: string` at `:542`; the owner-axis invariant ("at least one", not XOR) is `:548-550`; the insert writes `action: input.action` at `:556`.
- `apps/api/src/db/schema/softwarePolicies.ts:142` — `action: varchar('action', { length: 50 }).notNull()`. No enum, no const set anywhere.
- Non-test callers of `evaluateSoftwarePolicyArming` — exactly two, confirmed by a repo-wide grep over `apps/`, `packages/`, `ee/`: `apps/api/src/jobs/softwareRemediationWorker.ts:318` (`const arming = evaluateSoftwarePolicyArming(policy);`) and `apps/api/src/services/aiToolsCompliance.ts:509` (same expression).
- `apps/api/src/routes/softwarePolicies.ts:79-85` — `remediationOptionsSchema`, a **non-strict, non-exported** `z.object`, so an unknown `autoInstall` key is silently stripped today.
- `apps/api/src/routes/softwarePolicies.ts:291-296` — policy create: `requireSoftwarePolicyWrite` (`= requirePermission(PERMISSIONS.DEVICES_WRITE.resource, …)`, `:30-33`) + `requireMfa()` + `zValidator('json', createPolicySchema)`. In-handler `canMutateOrgWideGovernance` at `:298-300`.
- `apps/api/src/routes/softwarePolicies.ts:517-525` — policy update: same middleware pair; `canMutateOrgWideGovernance` at `:525-527`; the partner-wide administration gate at `:539-541`.
- `apps/api/src/middleware/auth.ts:915-918` — `hasSatisfiedMfa(auth: Pick<AuthContext, 'token'>): boolean` — `if (!ENABLE_2FA) return true; return auth.token?.mfa === true;`.
- `apps/api/src/services/permissions.ts:210-218` — `hasPermission(userPerms: UserPermissions, resource: string, action: string): boolean`.
- `packages/shared/src/constants/permissions.ts:24` — `DEVICES_EXECUTE: { resource: 'devices', action: 'execute' }`.
- `apps/api/src/services/tenantCascade.ts` and `apps/api/src/services/tenantExportPolicyRegistry.ts` — **zero** occurrences of `software_compliance_status` in either file (grep count 0). D9 therefore needs no registration, confirmed rather than assumed.

**Corrections — contract/spec citations that are now wrong:**

- **`tenantExportPolicyRegistry.ts:430` is wrong for `software_policies`.** The spec body §1 cites `:430` as the entry classifying `remediation_options` as `excludedOpen`. `:430` is `software_catalog`. The real entry is **`:437`**, and it does classify `remediation_options` in `excludedOpen` alongside `rules` and `target_ids` — so §1's conclusion (no export-policy change, no migration for `autoInstall`) is correct, only the line number was off. (The contract's own `:434` for `software_deployments` is correct; that row is W03's problem, not this wave's.)
- **`requireMfa()`'s coded-body rationale is stale.** The contract says an `HTTPException` is unusable "because the global onError handler drops `code`". `apps/api/src/index.ts:1046-1062` now reads a `code` property off a caught `HTTPException` and copies it into the body (`:1053-1058`), so that rationale no longer holds. The decision stands anyway on a different ground: a bare `new Hono()` route test — the established convention in `apps/api/src/routes/softwarePolicies*.test.ts` — installs no `onError`, so a thrown `HTTPException` would surface as a plain-text body and the coded shape would be untestable at the unit level. Return a Response.
- **"BOTH HTTP zod schemas" is one edit, not two.** `createPolicySchema` (`:107`) and `updatePolicySchema` (`:117`) both reference the same `remediationOptionsSchema` object defined at `:79-85`. Adding the field once covers both surfaces; both must still be tested.

**Additional facts this wave depends on, none of them in the contract:**

- `apps/api/src/services/softwarePolicyService.ts:98-111` — `violationFingerprint` for a non-`unauthorized` violation is `` `${type}:rule:${ruleName}:${minVersion}:${maxVersion}` ``. It does **not** compare the rule object structurally. `withStableViolationTimestamps` (`:113-146`) keys off that fingerprint, and `apps/api/src/jobs/softwareComplianceWorker.ts:377` calls that same shared helper (imported at `:17`) rather than carrying its own copy. **Therefore D9's new `catalogId`/`reason` fields cannot change `detectedAt` stabilisation.** This answers the "W02 must check, do not assume either way" note in D9 — the answer is *no change*, and Task 4 pins it with a regression test so W02 can rely on it.
- `apps/api/src/services/softwarePolicyService.ts:208-273` — `normalizeSoftwarePolicyRules` preserves `catalogId` (`:228`, `:234`) and `reason` (`:229`, `:235`) on every rule, so a `catalogId` authored through the HTTP route really does reach `evaluateSoftwareInventory`.
- `apps/api/src/routes/softwarePolicies.ts:46-53` — `softwareRuleSchema` already accepts `catalogId: z.string().guid().optional()` at `:51`. No route change is needed for D9.
- `apps/api/src/middleware/auth.ts:848-878` — `requirePermission` sets `c.set('permissions', userPerms)` at `:874` after resolving them. Both policy-write routes run `requireSoftwarePolicyWrite` first, so `c.get('permissions')` is always populated by the time the handler runs. A missing value therefore means the assertion is being used off a route that never resolved permissions — fail closed.
- `apps/api/src/services/deviceSiteAccess.ts:1,15` — the established service convention for a Hono-aware helper: `import type { Context } from 'hono'` and read `c.get('permissions') as … | undefined`. Mirrored by `installerBuilder.ts:1` and `mobileDeviceBinding.ts:1`.
- `apps/api/src/services/siteCeilingAccess.ts:37-47` — `canMutateOrgWideGovernance(auth)` is `auth.scope !== 'organization' || auth.allowedSiteIds === undefined`. A test auth object with `allowedSiteIds: undefined` passes it. This module is **not** mocked by the existing route tests, so the real implementation runs.
- `apps/api/src/routes/softwarePolicies.ts:215-227` — `getPolicyWithAccess` runs a bare `db.select()` (no projection), so the `policy` object the PATCH handler holds at `:531` carries `mode`, `enforceMode` and `remediationOptions` — everything the merged-state check needs, with no extra query.
- `apps/api/src/routes/softwarePolicies.ts:556` — PATCH **replaces** `remediationOptions` wholesale (`updates.remediationOptions = payload.remediationOptions`); it does not merge into the stored object. The merged-state rule "body field if provided, else stored field" is therefore an exact model of the write.
- `apps/api/src/services/softwarePolicyArming.test.ts` (126 lines, read in full) — the existing unit suite for the gate. It calls `evaluateSoftwarePolicyArming` at `:38`, `:44`, `:53`, `:61`, `:73`, `:114`; **all six need the new `'uninstall'` argument**. `:87-97` carries `complianceWorkerInlineGate`, a hand-written oracle reproducing `softwareComplianceWorker.ts:423-427`, and `:99-125` is the truth-table parity guard against it. That guard must keep passing for the `'uninstall'` verb — W02 replaces the inline gate outright (D11), not this wave.
- `apps/api/src/routes/softwarePolicies.approvalGeneration.test.ts` (119 lines, read in full) — the cleanest route-test template in this directory: a `vi.hoisted` `authRef`, a `vi.mock('../middleware/auth')` that injects it, a `db.transaction` stub capturing the `set()` payload, and `app()` returning `new Hono().route('/software-policies', softwarePoliciesRoutes)`. Task 6's tests mirror it.
- Grep over `apps/api/src/routes/softwarePolicies*.test.ts`: **zero** occurrences of `remediationOptions` or `autoUninstall`. No existing route test can trip the new arming gate, so none of the three existing files needs its `../services/permissions` mock widened (they mock only `PERMISSIONS` + `canAccessSite`; `hasPermission` is reached only on the armed path).
- Existing `software_policy_audit.action` values, enumerated repo-wide so Task 3 can prove no collision: `policy_created`, `policy_updated`, `policy_deleted`, `compliance_check_requested`, `compliance_check_failed`, `violation_detected`, `remediation_requested`, `remediation_scheduled`, `remediation_denied`, `remediation_deferred`, `remediation_skipped_unarmed`, `remediation_manual_override`, `remediation_command_failed`. **No `install_*` value exists.**
- `apps/api/package.json:26` — `"test": "vitest"` (bare, watch-mode by default: the `--` trap applies). No `typecheck` script.
- `apps/api/eslint.config.js` — flat config, `rules: {}` plus the SQLSTATE guard and a `no-restricted-imports` rule for `@hono/zod-validator`. `@typescript-eslint/require-await` is **not** enabled, so an `async` function with no `await` is fine.

---

## File structure

- **Modify** `apps/api/src/db/schema/softwarePolicies.ts` — `autoInstall?: boolean` on `SoftwarePolicyRemediationOptions` (Task 1); `catalogId?: string` on `SoftwarePolicyViolation['rule']` (Task 4).
- **Modify** `apps/api/src/routes/softwarePolicies.ts` — export + extend `remediationOptionsSchema` (Task 1); wire `assertMayArmInstall` into the create and update handlers (Task 6).
- **Modify** `apps/api/src/services/softwarePolicyService.ts` — verb-aware arming + `readSoftwarePolicyAutoInstall` (Task 2); install audit-action constants (Task 3); `catalogId`/`reason` on the `missing` emission (Task 4).
- **Modify** `apps/api/src/jobs/softwareRemediationWorker.ts` — one argument at `:318` (Task 2). Nothing else.
- **Modify** `apps/api/src/services/aiToolsCompliance.ts` — one argument at `:509` (Task 2). Nothing else; this is the wave's only AI-file edit.
- **Create** `apps/api/src/services/softwarePolicyAuthorization.ts` — `willBeArmedForInstall` + `assertMayArmInstall` (Task 5).
- **Create** `apps/api/src/services/softwarePolicyAuthorization.test.ts` — unit tests for both (Task 5).
- **Create** `apps/api/src/routes/softwarePolicies.autoInstall.test.ts` — route-level tests: schema passthrough (Task 1), then the create/update authorization matrix (Task 6).
- **Modify** `apps/api/src/services/softwarePolicyArming.test.ts` — verb argument on six call sites + the install-verb suites (Task 2).
- **Modify** `apps/api/src/services/softwarePolicyService.test.ts` — audit-action constants (Task 3), `catalogId` emission + fingerprint regression (Task 4).

No migration. No registry file. No web file.

---

### Task 1: `autoInstall` on the remediation-options type and the HTTP schema

**Files:**
- Modify: `apps/api/src/db/schema/softwarePolicies.ts:65-71`
- Modify: `apps/api/src/routes/softwarePolicies.ts:79-85`
- Test (create): `apps/api/src/routes/softwarePolicies.autoInstall.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SoftwarePolicyRemediationOptions.autoInstall?: boolean` (schema type, imported by Tasks 2/5 indirectly); `remediationOptionsSchema` becomes an exported `z.ZodObject` from `apps/api/src/routes/softwarePolicies.ts`, accepting `autoInstall: boolean | undefined`.

- [ ] **Step 1: Export `remediationOptionsSchema` so it can be asserted directly**

This is a visibility change only — no behaviour. It mirrors `softwareRulesSchema` (`:70`) and `executableRuleSchema` (`:58`), both already exported for exactly this reason.

In `apps/api/src/routes/softwarePolicies.ts`, change line 79 from:

```ts
const remediationOptionsSchema = z.object({
```

to:

```ts
export const remediationOptionsSchema = z.object({
```

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/routes/softwarePolicies.autoInstall.test.ts`. This file is the home for every W01 route-level assertion; Task 6 appends to it, so set the full mock harness up now.

```ts
/**
 * #5505 W01 — `remediationOptions.autoInstall` (the desired-state install
 * arming flag) and the authorization gate that guards arming it.
 *
 * `remediationOptionsSchema` is a NON-STRICT z.object, so before this wave an
 * `autoInstall` sent by a client was silently STRIPPED — no error, no field,
 * no way for a caller to tell. Both createPolicySchema and updatePolicySchema
 * reuse that one object, so the passthrough is asserted through both routes as
 * well as against the schema directly.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthContext } from '../middleware/auth';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  devices: { id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId', hostname: 'devices.hostname', status: 'devices.status', osType: 'devices.osType' },
  softwareComplianceStatus: { id: 'x', policyId: 'x', deviceId: 'x', status: 'x', violations: 'x', lastChecked: 'x', remediationStatus: 'x', lastRemediationAttempt: 'x' },
  softwarePolicies: { id: 'id', orgId: 'orgId', partnerId: 'partnerId', mode: 'mode', name: 'name', isActive: 'isActive', updatedAt: 'updatedAt', approvalGeneration: 'approvalGeneration' },
}));

const { authRef, mfaRef, executeRef } = vi.hoisted(() => ({
  authRef: { current: {} as Record<string, unknown> },
  mfaRef: { current: true },
  executeRef: { current: true },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', authRef.current);
    // requirePermission normally sets this (middleware/auth.ts:874); the mock
    // above replaces it, so inject the same shape the handler will read.
    c.set('permissions', { permissions: [], scope: 'organization', orgId: null, partnerId: null, roleId: 'role-1' });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
  hasSatisfiedMfa: vi.fn(() => mfaRef.current),
}));

vi.mock('../jobs/softwareComplianceWorker', () => ({ scheduleSoftwareComplianceCheck: vi.fn() }));
vi.mock('../jobs/softwareRemediationWorker', () => ({ scheduleSoftwareRemediation: vi.fn(async () => 1) }));
vi.mock('../services/softwarePolicyService', () => ({
  normalizeSoftwarePolicyRules: (r: any) => ({ software: r.software ?? [], executable: r.executable, allowUnknown: r.allowUnknown }),
  recordSoftwarePolicyAudit: vi.fn(async () => undefined),
  // Faithful copy of the real helper (softwarePolicyService.ts) — the
  // authorization service imports it from this module, so the mock has to
  // supply it. Arming is opt-in: only the literal boolean `true` counts.
  readSoftwarePolicyAutoInstall: (raw: unknown) =>
    !!raw && typeof raw === 'object' && (raw as Record<string, unknown>).autoInstall === true,
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../services/pamActuationLifecycle', () => ({ requestPamCleanup: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    DEVICES_READ: { resource: 'devices', action: 'read' },
    DEVICES_WRITE: { resource: 'devices', action: 'write' },
    DEVICES_EXECUTE: { resource: 'devices', action: 'execute' },
  },
  canAccessSite: () => true,
  hasPermission: vi.fn((_perms: unknown, resource: string, action: string) =>
    resource === 'devices' && action === 'execute' ? executeRef.current : true),
}));

import { remediationOptionsSchema, softwarePoliciesRoutes } from './softwarePolicies';
import { db } from '../db';
import type { SoftwarePolicyRemediationOptions } from '../db/schema/softwarePolicies';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const POLICY_ID = '22222222-2222-4222-8222-222222222222';

function orgAuth(): AuthContext {
  return {
    scope: 'organization',
    orgId: ORG_ID,
    canAccessOrg: (id: string) => id === ORG_ID,
    orgCondition: () => null,
    user: { id: 'user-1' },
    accessibleOrgIds: [ORG_ID],
    allowedSiteIds: undefined,
    token: { mfa: true },
  } as unknown as AuthContext;
}

function app() {
  const instance = new Hono();
  instance.route('/software-policies', softwarePoliciesRoutes);
  return instance;
}

/** db.insert(...).values(...).returning() — captures the inserted values. */
function mockInsertCapturing(captured: { values?: Record<string, unknown> }) {
  (db.insert as any).mockReturnValue({
    values: (v: Record<string, unknown>) => {
      captured.values = v;
      return { returning: () => Promise.resolve([{ id: POLICY_ID, orgId: ORG_ID, mode: v.mode, name: v.name }]) };
    },
  });
}

describe('#5505 remediationOptions.autoInstall reaches the server', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authRef.current = orgAuth() as unknown as Record<string, unknown>;
    mfaRef.current = true;
    executeRef.current = true;
  });

  it('remediationOptionsSchema keeps autoInstall instead of stripping it', () => {
    const parsed = remediationOptionsSchema.parse({ autoInstall: true, autoUninstall: false });
    expect(parsed.autoInstall).toBe(true);
    expect(parsed.autoUninstall).toBe(false);
  });

  it('remediationOptionsSchema rejects a non-boolean autoInstall', () => {
    expect(() => remediationOptionsSchema.parse({ autoInstall: 'true' })).toThrow();
    expect(() => remediationOptionsSchema.parse({ autoInstall: 1 })).toThrow();
  });

  it('autoInstall and autoUninstall are independent flags on the type', () => {
    const installOnly: SoftwarePolicyRemediationOptions = { autoInstall: true };
    const uninstallOnly: SoftwarePolicyRemediationOptions = { autoUninstall: true };
    expect(installOnly.autoUninstall).toBeUndefined();
    expect(uninstallOnly.autoInstall).toBeUndefined();
  });

  it('POST persists autoInstall into remediation_options', async () => {
    const captured: { values?: Record<string, unknown> } = {};
    mockInsertCapturing(captured);

    const res = await app().request('/software-policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orgId: ORG_ID,
        name: 'Required software',
        mode: 'allowlist',
        rules: { software: [{ name: '7-Zip' }] },
        enforceMode: true,
        remediationOptions: { autoInstall: true },
      }),
    });

    expect(res.status).toBe(201);
    expect(captured.values?.remediationOptions).toEqual({ autoInstall: true });
  });

  it('PATCH persists autoInstall into remediation_options', async () => {
    let updateSetArg: Record<string, unknown> | undefined;
    (db.select as any).mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: POLICY_ID, orgId: ORG_ID, isActive: true, mode: 'allowlist', enforceMode: true, remediationOptions: null }]) }) }),
    });
    (db.transaction as any).mockImplementation(async (fn: (tx: unknown) => unknown) => fn({
      update: () => ({
        set: (setArg: Record<string, unknown>) => {
          updateSetArg = setArg;
          return { where: () => ({ returning: () => Promise.resolve([{ id: POLICY_ID, orgId: ORG_ID, name: 'Required software', approvalGeneration: 2 }]) }) };
        },
      }),
    }));

    const res = await app().request(`/software-policies/${POLICY_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remediationOptions: { autoInstall: true } }),
    });

    expect(res.status).toBe(200);
    expect(updateSetArg?.remediationOptions).toEqual({ autoInstall: true });
  });
});
```

- [ ] **Step 3: Run the test and watch it fail**

```bash
cd apps/api && npx vitest run src/routes/softwarePolicies.autoInstall.test.ts
```

Expected: the three assertions that touch the field fail —
`remediationOptionsSchema keeps autoInstall` fails with `expected undefined to be true` (the non-strict object strips it);
`rejects a non-boolean autoInstall` fails with "expected function to throw" (an unknown key is stripped, never validated);
both route tests fail with `expected {} to equal { autoInstall: true }`.
`autoInstall and autoUninstall are independent flags` passes at runtime (vitest strips types) — its red is the typecheck in Step 4.

- [ ] **Step 4: Confirm the type-level red**

```bash
pnpm --filter @breeze/api exec tsc --noEmit
```

Expected: `error TS2353: Object literal may only specify known properties, and 'autoInstall' does not exist in type 'SoftwarePolicyRemediationOptions'.` — in `softwarePolicies.autoInstall.test.ts`. That is the failing assertion for the schema-type half of this task.

- [ ] **Step 5: Add the field to the schema type**

In `apps/api/src/db/schema/softwarePolicies.ts`, replace lines 65-71 with:

```ts
export type SoftwarePolicyRemediationOptions = {
  autoUninstall?: boolean;
  /**
   * Desired-state install arming (#5505). Opt-in — absent or non-boolean means
   * NOT armed — and deliberately NOT sharing `autoUninstall`'s flag: a policy
   * armed to REMOVE unauthorised software is not thereby armed to INSTALL
   * anything. Both verbs still sit behind `enforceMode` and `mode !== 'audit'`.
   */
  autoInstall?: boolean;
  notifyUser?: boolean; // not yet implemented
  gracePeriod?: number; // hours; max 90 days
  cooldownMinutes?: number;
  maintenanceWindowOnly?: boolean; // not yet implemented
};
```

- [ ] **Step 6: Add the field to the HTTP schema**

In `apps/api/src/routes/softwarePolicies.ts`, replace lines 79-85 (the block you exported in Step 1) with:

```ts
// NOTE: a non-strict z.object STRIPS unknown keys silently rather than
// rejecting them, so a field is invisible to the API until it is declared
// here. Both createPolicySchema and updatePolicySchema reference this one
// object, so a field added here covers the create and update surfaces alike.
export const remediationOptionsSchema = z.object({
  autoUninstall: z.boolean().optional(),
  autoInstall: z.boolean().optional(), // #5505 — see SoftwarePolicyRemediationOptions
  notifyUser: z.boolean().optional(),
  gracePeriod: z.number().int().min(0).max(24 * 90).optional(), // hours; max 90 days
  cooldownMinutes: z.number().int().min(1).max(24 * 90 * 60).optional(),
  maintenanceWindowOnly: z.boolean().optional(),
});
```

- [ ] **Step 7: Run the test and watch it pass**

```bash
cd apps/api && npx vitest run src/routes/softwarePolicies.autoInstall.test.ts
```

Expected: 5 passed, 1 file.

- [ ] **Step 8: Typecheck, then re-run the three neighbouring route suites**

```bash
pnpm --filter @breeze/api exec tsc --noEmit
cd apps/api && npx vitest run src/routes/softwarePolicies.test.ts src/routes/softwarePolicies.siteScope.test.ts src/routes/softwarePolicies.approvalGeneration.test.ts
```

Expected: tsc clean; 3 files passed. (Listing the three files explicitly is deliberate — `vitest run src/routes/softwarePolicies` would substring-match, and a trailing slash would skip all three.)

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/db/schema/softwarePolicies.ts apps/api/src/routes/softwarePolicies.ts apps/api/src/routes/softwarePolicies.autoInstall.test.ts
git commit -m "feat(api): add remediationOptions.autoInstall to the policy type and HTTP schema (#5506)"
```

---

### Task 2: verb-aware arming (`PolicyRemediationVerb`, `readSoftwarePolicyAutoInstall`, `auto_install_off`)

**Files:**
- Modify: `apps/api/src/services/softwarePolicyService.ts:148-206`
- Modify: `apps/api/src/jobs/softwareRemediationWorker.ts:318`
- Modify: `apps/api/src/services/aiToolsCompliance.ts:509`
- Test: `apps/api/src/services/softwarePolicyArming.test.ts`

**Interfaces:**
- Consumes: `SoftwarePolicyRemediationOptions.autoInstall` (Task 1) — only as documentation; the helper reads `unknown`.
- Produces, all exported from `apps/api/src/services/softwarePolicyService.ts`:
  - `type PolicyRemediationVerb = 'uninstall' | 'install'`
  - `type SoftwarePolicyUnarmedReason = 'audit_mode' | 'enforce_mode_off' | 'auto_uninstall_off' | 'auto_install_off'`
  - `function readSoftwarePolicyAutoInstall(raw: unknown): boolean`
  - `function evaluateSoftwarePolicyArming(policy: SoftwarePolicyArmingInput, verb: PolicyRemediationVerb): SoftwarePolicyArmingState`
  - `SoftwarePolicyArmingInput` and `SoftwarePolicyArmingState` are unchanged and still exported.

- [ ] **Step 1: Write the failing tests**

Rewrite `apps/api/src/services/softwarePolicyArming.test.ts` in full. Three things change: the header docblock, the six existing calls gain `'uninstall'`, and two new `describe` blocks cover the install verb and message byte-identity.

```ts
/**
 * #3543 — the arming gate, unit-tested directly plus a drift guard.
 * #5505 W01 — the gate is now verb-aware: `evaluateSoftwarePolicyArming(policy,
 * verb)` answers "may this policy UNINSTALL?" or "may this policy INSTALL?"
 * against two independent flags. The second parameter is REQUIRED so the
 * compiler finds every caller; there is no default verb.
 *
 * `softwareComplianceWorker.ts` still carries its own inline copy of the
 * uninstall rule (W02 removes it, contract D11). Two independent copies of a
 * security gate drift, and drift in THAT file reintroduces the #3381 bug class,
 * so the parity block below pins them together over a truth table.
 */

import { describe, expect, it } from 'vitest';
import {
  evaluateSoftwarePolicyArming,
  readSoftwarePolicyAutoInstall,
  readSoftwarePolicyAutoUninstall,
} from './softwarePolicyService';

describe('readSoftwarePolicyAutoUninstall — arming is opt-in', () => {
  it.each([
    ['null', null, false],
    ['undefined', undefined, false],
    ['empty object', {}, false],
    ['array', [], false],
    ['string "true"', 'true', false],
    ['number 1', 1, false],
    ['boolean true', true, false],
    ['autoUninstall: false', { autoUninstall: false }, false],
    ['autoUninstall: "true" (string, not boolean)', { autoUninstall: 'true' }, false],
    ['autoUninstall: 1 (truthy, not true)', { autoUninstall: 1 }, false],
    ['autoUninstall: true', { autoUninstall: true }, true],
  ])('%s -> %s', (_label, input, expected) => {
    expect(readSoftwarePolicyAutoUninstall(input)).toBe(expected);
  });
});

describe('readSoftwarePolicyAutoInstall — arming is opt-in', () => {
  it.each([
    ['null', null, false],
    ['undefined', undefined, false],
    ['empty object', {}, false],
    ['array', [], false],
    ['string "true"', 'true', false],
    ['number 1', 1, false],
    ['boolean true', true, false],
    ['autoInstall: false', { autoInstall: false }, false],
    ['autoInstall: "true" (string, not boolean)', { autoInstall: 'true' }, false],
    ['autoInstall: 1 (truthy, not true)', { autoInstall: 1 }, false],
    ['autoInstall: true', { autoInstall: true }, true],
  ])('%s -> %s', (_label, input, expected) => {
    expect(readSoftwarePolicyAutoInstall(input)).toBe(expected);
  });

  it('does not read autoUninstall', () => {
    expect(readSoftwarePolicyAutoInstall({ autoUninstall: true })).toBe(false);
    expect(readSoftwarePolicyAutoUninstall({ autoInstall: true })).toBe(false);
  });
});

describe('evaluateSoftwarePolicyArming — uninstall verb', () => {
  const ARMED_OPTIONS = { autoUninstall: true };

  it('is armed only when mode is non-audit AND enforceMode AND autoUninstall', () => {
    expect(evaluateSoftwarePolicyArming({
      mode: 'blocklist', enforceMode: true, remediationOptions: ARMED_OPTIONS,
    }, 'uninstall')).toEqual({ armed: true });
  });

  it('reports audit_mode first, even when otherwise fully armed', () => {
    const state = evaluateSoftwarePolicyArming({
      mode: 'audit', enforceMode: true, remediationOptions: ARMED_OPTIONS,
    }, 'uninstall');
    expect(state.armed).toBe(false);
    expect(state).toMatchObject({ reason: 'audit_mode' });
  });

  it('reports enforce_mode_off when enforcement is off', () => {
    for (const enforceMode of [false, null, undefined]) {
      const state = evaluateSoftwarePolicyArming({
        mode: 'blocklist', enforceMode, remediationOptions: ARMED_OPTIONS,
      }, 'uninstall');
      expect(state).toMatchObject({ armed: false, reason: 'enforce_mode_off' });
    }
  });

  it('reports auto_uninstall_off when enforcement is on but uninstall is not armed', () => {
    const state = evaluateSoftwarePolicyArming({
      mode: 'allowlist', enforceMode: true, remediationOptions: { autoUninstall: false },
    }, 'uninstall');
    expect(state).toMatchObject({ armed: false, reason: 'auto_uninstall_off' });
  });

  it('always carries an operator-legible message when unarmed', () => {
    for (const policy of [
      { mode: 'audit', enforceMode: true, remediationOptions: ARMED_OPTIONS },
      { mode: 'blocklist', enforceMode: false, remediationOptions: ARMED_OPTIONS },
      { mode: 'blocklist', enforceMode: true, remediationOptions: null },
    ]) {
      const state = evaluateSoftwarePolicyArming(policy, 'uninstall');
      expect(state.armed).toBe(false);
      if (!state.armed) expect(state.message.length).toBeGreaterThan(20);
    }
  });
});

describe('evaluateSoftwarePolicyArming — install verb', () => {
  const ARMED_OPTIONS = { autoInstall: true };

  it('is armed only when mode is non-audit AND enforceMode AND autoInstall', () => {
    expect(evaluateSoftwarePolicyArming({
      mode: 'allowlist', enforceMode: true, remediationOptions: ARMED_OPTIONS,
    }, 'install')).toEqual({ armed: true });
  });

  it('reports audit_mode first, even when otherwise fully armed', () => {
    const state = evaluateSoftwarePolicyArming({
      mode: 'audit', enforceMode: true, remediationOptions: ARMED_OPTIONS,
    }, 'install');
    expect(state).toMatchObject({ armed: false, reason: 'audit_mode' });
  });

  it('reports enforce_mode_off when enforcement is off', () => {
    for (const enforceMode of [false, null, undefined]) {
      const state = evaluateSoftwarePolicyArming({
        mode: 'allowlist', enforceMode, remediationOptions: ARMED_OPTIONS,
      }, 'install');
      expect(state).toMatchObject({ armed: false, reason: 'enforce_mode_off' });
    }
  });

  it('reports auto_install_off — never auto_uninstall_off — when install is not armed', () => {
    const state = evaluateSoftwarePolicyArming({
      mode: 'allowlist', enforceMode: true, remediationOptions: { autoInstall: false },
    }, 'install');
    expect(state).toMatchObject({ armed: false, reason: 'auto_install_off' });
    if (!state.armed) expect(state.message).toContain('remediationOptions.autoInstall');
  });
});

describe('the two verbs are independent (spec: "arming install does not arm uninstall")', () => {
  const BASE = { mode: 'allowlist' as const, enforceMode: true };

  it('autoUninstall alone arms uninstall and NOT install', () => {
    const policy = { ...BASE, remediationOptions: { autoUninstall: true } };
    expect(evaluateSoftwarePolicyArming(policy, 'uninstall').armed).toBe(true);
    expect(evaluateSoftwarePolicyArming(policy, 'install')).toMatchObject({ armed: false, reason: 'auto_install_off' });
  });

  it('autoInstall alone arms install and NOT uninstall', () => {
    const policy = { ...BASE, remediationOptions: { autoInstall: true } };
    expect(evaluateSoftwarePolicyArming(policy, 'install').armed).toBe(true);
    expect(evaluateSoftwarePolicyArming(policy, 'uninstall')).toMatchObject({ armed: false, reason: 'auto_uninstall_off' });
  });

  it('both flags arm both verbs', () => {
    const policy = { ...BASE, remediationOptions: { autoInstall: true, autoUninstall: true } };
    expect(evaluateSoftwarePolicyArming(policy, 'install').armed).toBe(true);
    expect(evaluateSoftwarePolicyArming(policy, 'uninstall').armed).toBe(true);
  });
});

/**
 * The uninstall messages are user-visible: `aiToolsCompliance.ts` returns
 * `arming.message` straight to the model and the route surfaces it to a
 * technician. Making the gate verb-aware must not reword the uninstall copy,
 * so pin all three byte-for-byte.
 */
describe('uninstall refusal messages are unchanged byte-for-byte', () => {
  it.each([
    [
      { mode: 'audit', enforceMode: true, remediationOptions: { autoUninstall: true } },
      'Policy is audit-only (mode="audit"); it cannot uninstall software.',
    ],
    [
      { mode: 'blocklist', enforceMode: false, remediationOptions: { autoUninstall: true } },
      'Policy enforcement is off (enforceMode=false), so it is detect-only and must not uninstall software. '
      + 'An administrator has to enable enforcement on the policy first.',
    ],
    [
      { mode: 'blocklist', enforceMode: true, remediationOptions: null },
      'Policy remediation is not armed (remediationOptions.autoUninstall is not true), so it must not uninstall software. '
      + 'An administrator has to enable automatic uninstall on the policy first.',
    ],
  ])('%#', (policy, expected) => {
    const state = evaluateSoftwarePolicyArming(policy, 'uninstall');
    expect(state.armed).toBe(false);
    if (!state.armed) expect(state.message).toBe(expected);
  });
});

describe('install refusal messages name the install verb', () => {
  it('audit_mode says "install", not "uninstall"', () => {
    const state = evaluateSoftwarePolicyArming(
      { mode: 'audit', enforceMode: true, remediationOptions: { autoInstall: true } },
      'install'
    );
    expect(state.armed).toBe(false);
    if (!state.armed) {
      expect(state.message).toBe('Policy is audit-only (mode="audit"); it cannot install software.');
    }
  });

  it('enforce_mode_off says "install", not "uninstall"', () => {
    const state = evaluateSoftwarePolicyArming(
      { mode: 'allowlist', enforceMode: false, remediationOptions: { autoInstall: true } },
      'install'
    );
    expect(state.armed).toBe(false);
    if (!state.armed) {
      expect(state.message).toBe(
        'Policy enforcement is off (enforceMode=false), so it is detect-only and must not install software. '
        + 'An administrator has to enable enforcement on the policy first.'
      );
    }
  });

  it('auto_install_off names the autoInstall option', () => {
    const state = evaluateSoftwarePolicyArming(
      { mode: 'allowlist', enforceMode: true, remediationOptions: {} },
      'install'
    );
    expect(state.armed).toBe(false);
    if (!state.armed) {
      expect(state.message).toBe(
        'Policy remediation is not armed (remediationOptions.autoInstall is not true), so it must not install software. '
        + 'An administrator has to enable automatic install on the policy first.'
      );
    }
  });
});

/**
 * Drift guard against the untouched inline gate in
 * `apps/api/src/jobs/softwareComplianceWorker.ts:423-427`:
 *   policy.enforceMode && policy.mode !== 'audit' && remediationOptions.autoUninstallEnabled
 * where `autoUninstallEnabled` comes from its local `readRemediationOptions`
 * (`:158`, `options.autoUninstall === true`). Reproduced here as the reference
 * oracle. W02 deletes that inline copy (contract D11); until then this holds.
 */
function complianceWorkerInlineGate(policy: {
  mode: string | null | undefined;
  enforceMode: boolean | null | undefined;
  remediationOptions: unknown;
}): boolean {
  const raw = policy.remediationOptions;
  const autoUninstallEnabled = !raw || typeof raw !== 'object'
    ? false
    : (raw as Record<string, unknown>).autoUninstall === true;
  return Boolean(policy.enforceMode) && policy.mode !== 'audit' && autoUninstallEnabled;
}

describe('gate parity with the inline compliance-worker gate (#3543 drift guard)', () => {
  const MODES = ['allowlist', 'blocklist', 'audit'];
  const ENFORCE = [true, false, null, undefined];
  const OPTIONS: unknown[] = [
    null, undefined, {}, [], 'true', 1,
    { autoUninstall: true }, { autoUninstall: false }, { autoUninstall: 'true' },
    { autoUninstall: true, cooldownMinutes: 30 },
    { autoInstall: true }, { autoInstall: true, autoUninstall: true },
  ];

  it('agrees on every combination of mode / enforceMode / remediationOptions', () => {
    const disagreements: string[] = [];
    for (const mode of MODES) {
      for (const enforceMode of ENFORCE) {
        for (const remediationOptions of OPTIONS) {
          const policy = { mode, enforceMode, remediationOptions };
          const shared = evaluateSoftwarePolicyArming(policy, 'uninstall').armed;
          const inline = complianceWorkerInlineGate(policy);
          if (shared !== inline) {
            disagreements.push(
              `mode=${mode} enforceMode=${String(enforceMode)} options=${JSON.stringify(remediationOptions)}: shared=${shared} inline=${inline}`
            );
          }
        }
      }
    }
    expect(disagreements).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
cd apps/api && npx vitest run src/services/softwarePolicyArming.test.ts
```

Expected: the whole file fails to load —
`SyntaxError: The requested module './softwarePolicyService' does not provide an export named 'readSoftwarePolicyAutoInstall'`.

- [ ] **Step 3: Make the gate verb-aware**

In `apps/api/src/services/softwarePolicyService.ts`, replace the docblock and the whole helper block — lines 148 through 206 — with:

```ts
/**
 * Remediation-arming gate (#3543, incident #3381; verb-aware since #5505).
 *
 * A policy only authorises remediation commands for a given verb when all three
 * are true: `mode !== 'audit'`, `enforceMode`, and that verb's own flag —
 * `remediationOptions.autoUninstall` for `'uninstall'`,
 * `remediationOptions.autoInstall` for `'install'`. The two flags are
 * deliberately independent: a policy armed to REMOVE unauthorised software is
 * not thereby armed to INSTALL anything.
 *
 * Until #3543 the gate lived ONLY inline in softwareComplianceWorker.ts, so
 * every other path that reached `scheduleSoftwareRemediation` (the AI tool, the
 * manual route, a replayed BullMQ job) could queue mass uninstalls against a
 * policy whose owner had deliberately left enforcement off. This is the single
 * shared definition — callers must use it rather than re-deriving the check.
 *
 * `verb` is REQUIRED and has no default: an unarmed policy must never be
 * mistaken for an armed one because a caller forgot an argument.
 */
export type PolicyRemediationVerb = 'uninstall' | 'install';

export type SoftwarePolicyUnarmedReason =
  | 'audit_mode'
  | 'enforce_mode_off'
  | 'auto_uninstall_off'
  | 'auto_install_off';

export type SoftwarePolicyArmingState =
  | { armed: true }
  | { armed: false; reason: SoftwarePolicyUnarmedReason; message: string };

export type SoftwarePolicyArmingInput = {
  mode: string | null | undefined;
  enforceMode: boolean | null | undefined;
  remediationOptions: unknown;
};

/** `autoUninstall` is opt-in: absent or non-object options mean NOT armed. */
export function readSoftwarePolicyAutoUninstall(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  return (raw as Record<string, unknown>).autoUninstall === true;
}

/** `autoInstall` is opt-in: absent or non-object options mean NOT armed. */
export function readSoftwarePolicyAutoInstall(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  return (raw as Record<string, unknown>).autoInstall === true;
}

export function evaluateSoftwarePolicyArming(
  policy: SoftwarePolicyArmingInput,
  verb: PolicyRemediationVerb
): SoftwarePolicyArmingState {
  if (policy.mode === 'audit') {
    return {
      armed: false,
      reason: 'audit_mode',
      message: `Policy is audit-only (mode="audit"); it cannot ${verb} software.`,
    };
  }
  if (policy.enforceMode !== true) {
    return {
      armed: false,
      reason: 'enforce_mode_off',
      message:
        `Policy enforcement is off (enforceMode=false), so it is detect-only and must not ${verb} software. `
        + 'An administrator has to enable enforcement on the policy first.',
    };
  }
  if (verb === 'install') {
    if (!readSoftwarePolicyAutoInstall(policy.remediationOptions)) {
      return {
        armed: false,
        reason: 'auto_install_off',
        message:
          'Policy remediation is not armed (remediationOptions.autoInstall is not true), so it must not install software. '
          + 'An administrator has to enable automatic install on the policy first.',
      };
    }
    return { armed: true };
  }
  if (!readSoftwarePolicyAutoUninstall(policy.remediationOptions)) {
    return {
      armed: false,
      reason: 'auto_uninstall_off',
      message:
        'Policy remediation is not armed (remediationOptions.autoUninstall is not true), so it must not uninstall software. '
        + 'An administrator has to enable automatic uninstall on the policy first.',
    };
  }
  return { armed: true };
}
```

- [ ] **Step 4: Update the two non-test call sites the compiler now rejects**

In `apps/api/src/jobs/softwareRemediationWorker.ts`, line 318:

```ts
  const arming = evaluateSoftwarePolicyArming(policy, 'uninstall');
```

In `apps/api/src/services/aiToolsCompliance.ts`, line 509:

```ts
    const arming = evaluateSoftwarePolicyArming(policy, 'uninstall');
```

Change nothing else in either file. The `aiToolsCompliance.ts` edit is the only AI-file change in this wave; the AI's *write* refusals are W05.

- [ ] **Step 5: Run the tests and watch them pass**

```bash
cd apps/api && npx vitest run src/services/softwarePolicyArming.test.ts
```

Expected: all suites pass, including the byte-identity block and the drift guard.

- [ ] **Step 6: Typecheck**

```bash
pnpm --filter @breeze/api exec tsc --noEmit
```

Expected: clean. If it reports a call site other than the two above, a third caller appeared since the ground-truth pass — pass `'uninstall'` there too and note it in the PR body.

- [ ] **Step 7: Run the two suites that exercise the changed call sites**

```bash
cd apps/api && npx vitest run src/jobs/softwareRemediationWorker.test.ts src/services/aiToolsCompliance.siteScope.test.ts
```

Expected: both pass. Both re-export the real helper through their mocks (`softwareRemediationWorker.test.ts:46`, `aiToolsCompliance.siteScope.test.ts:17`), so they exercise the new signature without needing an edit.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/softwarePolicyService.ts apps/api/src/services/softwarePolicyArming.test.ts apps/api/src/jobs/softwareRemediationWorker.ts apps/api/src/services/aiToolsCompliance.ts
git commit -m "feat(api): make the software-policy arming gate verb-aware (install/uninstall) (#5506)"
```

---

### Task 3: install audit-action constants

**Files:**
- Modify: `apps/api/src/services/softwarePolicyService.ts` (append after the arming block from Task 2)
- Test: `apps/api/src/services/softwarePolicyService.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, exported from `apps/api/src/services/softwarePolicyService.ts`:
  - `const SOFTWARE_POLICY_INSTALL_AUDIT_ACTIONS = { queued: 'install_queued', succeeded: 'install_succeeded', failed: 'install_failed', gaveUp: 'install_gave_up' } as const`
  - `type SoftwarePolicyInstallAuditAction` — the union of those four literals.
  W02 and W03 import this object and pass its members as `recordSoftwarePolicyAudit({ action })`; no emitter writes a string literal.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/services/softwarePolicyService.test.ts`. Add the import at the top of the file — the existing import block is lines 2-8, so extend it:

```ts
import {
  SOFTWARE_POLICY_INSTALL_AUDIT_ACTIONS,
  compareSoftwareVersions,
  evaluateSoftwareInventory,
  matchesSoftwareRule,
  normalizeSoftwarePolicyRules,
  withStableViolationTimestamps,
} from './softwarePolicyService';
```

Then append this block at the end of the file:

```ts
/**
 * #5505 D6 — `software_policy_audit.action` is a bare varchar(50) with no enum
 * and no pre-existing const set (softwarePolicies.ts:142), so this object IS
 * the registry. An audit reader must never have to infer the verb, so install
 * events never reuse an uninstall action value.
 */
describe('SOFTWARE_POLICY_INSTALL_AUDIT_ACTIONS', () => {
  // Every action string already written to software_policy_audit.action,
  // enumerated from the emitters as of #5506. The point is collision, not
  // completeness: a new install action must not be any of these.
  const EXISTING_ACTIONS = [
    'policy_created',
    'policy_updated',
    'policy_deleted',
    'compliance_check_requested',
    'compliance_check_failed',
    'violation_detected',
    'remediation_requested',
    'remediation_scheduled',
    'remediation_denied',
    'remediation_deferred',
    'remediation_skipped_unarmed',
    'remediation_manual_override',
    'remediation_command_failed',
  ];

  it('exposes exactly the four install actions the contract names', () => {
    expect(SOFTWARE_POLICY_INSTALL_AUDIT_ACTIONS).toEqual({
      queued: 'install_queued',
      succeeded: 'install_succeeded',
      failed: 'install_failed',
      gaveUp: 'install_gave_up',
    });
  });

  it('never collides with an existing uninstall or lifecycle action', () => {
    for (const action of Object.values(SOFTWARE_POLICY_INSTALL_AUDIT_ACTIONS)) {
      expect(EXISTING_ACTIONS).not.toContain(action);
    }
  });

  it('every value is install-prefixed and fits software_policy_audit.action varchar(50)', () => {
    for (const action of Object.values(SOFTWARE_POLICY_INSTALL_AUDIT_ACTIONS)) {
      expect(action.startsWith('install_')).toBe(true);
      expect(action.length).toBeLessThanOrEqual(50);
    }
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd apps/api && npx vitest run src/services/softwarePolicyService.test.ts
```

Expected: `SyntaxError: The requested module './softwarePolicyService' does not provide an export named 'SOFTWARE_POLICY_INSTALL_AUDIT_ACTIONS'`.

- [ ] **Step 3: Add the constants**

In `apps/api/src/services/softwarePolicyService.ts`, insert immediately after the closing brace of `evaluateSoftwarePolicyArming` (which ends at what was line 206 before Task 2, and now ends just before `export function normalizeSoftwarePolicyRules`):

```ts
/**
 * Install-remediation audit actions (#5505 D6).
 *
 * `software_policy_audit.action` is a bare `varchar(50)`
 * (`db/schema/softwarePolicies.ts:142`) written as `action: string` — no enum,
 * no pre-existing const set — so this object IS the registry. Every emitter
 * imports it; no install emit site writes a string literal.
 *
 * Install actions never reuse an uninstall action value: an audit reader must
 * never have to infer which verb an event describes. The existing uninstall
 * action strings are deliberately NOT refactored into a matching object here —
 * that is a separate, unrelated change.
 */
export const SOFTWARE_POLICY_INSTALL_AUDIT_ACTIONS = {
  /** An install was queued for a (policy, device). */
  queued: 'install_queued',
  /** The queued install reported success. */
  succeeded: 'install_succeeded',
  /** The queued install reported failure (one attempt). */
  failed: 'install_failed',
  /** Consecutive attempts exhausted; the install loop guard stopped retrying. */
  gaveUp: 'install_gave_up',
} as const;

export type SoftwarePolicyInstallAuditAction =
  (typeof SOFTWARE_POLICY_INSTALL_AUDIT_ACTIONS)[keyof typeof SOFTWARE_POLICY_INSTALL_AUDIT_ACTIONS];
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd apps/api && npx vitest run src/services/softwarePolicyService.test.ts
```

Expected: all suites pass, 3 new tests included.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm --filter @breeze/api exec tsc --noEmit
git add apps/api/src/services/softwarePolicyService.ts apps/api/src/services/softwarePolicyService.test.ts
git commit -m "feat(api): add install-remediation audit action constants (#5506)"
```

---

### Task 4: `catalogId` on the `missing` violation (contract D9)

**Files:**
- Modify: `apps/api/src/db/schema/softwarePolicies.ts:55-60`
- Modify: `apps/api/src/services/softwarePolicyService.ts:333-347`
- Test: `apps/api/src/services/softwarePolicyService.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SoftwarePolicyViolation['rule'].catalogId?: string`. W02 and W03 read `violation.rule?.catalogId` off a stored `missing` violation to resolve what to install. `reason` was already on the type (`:59`); this task starts *populating* it on the `missing` branch, which previously dropped it.

**No migration and no registration.** `violations` is a jsonb column and `software_compliance_status` appears in neither `tenantCascade.ts` nor `tenantExportPolicyRegistry.ts` (grep count 0 in both) — re-verified in §0.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/services/softwarePolicyService.test.ts`:

```ts
/**
 * #5505 D9 — a `missing` violation is the ONLY place the install path can
 * learn WHAT to install. Before this wave the emission dropped the rule's
 * `catalogId`, and re-matching a violation to its rule by name is not an
 * option: rule names are not unique within a policy and nothing enforces that
 * they are.
 */
describe('missing violations carry the rule catalogId', () => {
  const CATALOG_ID = '99999999-9999-4999-8999-999999999999';

  it('emits catalogId and reason from the unmatched rule', () => {
    const rules = normalizeSoftwarePolicyRules({
      software: [{ name: '7-Zip', minVersion: '23.0', catalogId: CATALOG_ID, reason: 'Standard archive tool' }],
      allowUnknown: true,
    });

    const violations = evaluateSoftwareInventory('allowlist', rules, []);
    const missing = violations.find((v) => v.type === 'missing');

    expect(missing).toBeDefined();
    expect(missing?.rule).toEqual({
      name: '7-Zip',
      minVersion: '23.0',
      maxVersion: undefined,
      catalogId: CATALOG_ID,
      reason: 'Standard archive tool',
    });
  });

  it('leaves catalogId undefined for a rule that has none — never fabricates one', () => {
    const rules = normalizeSoftwarePolicyRules({
      software: [{ name: 'Firefox' }],
      allowUnknown: true,
    });

    const missing = evaluateSoftwareInventory('allowlist', rules, []).find((v) => v.type === 'missing');
    expect(missing?.rule?.name).toBe('Firefox');
    expect(missing?.rule?.catalogId).toBeUndefined();
  });

  /**
   * Contract D9 asks whether the new field changes violation matching.
   * `violationFingerprint` keys a `missing` violation on
   * `type:rule:name:minVersion:maxVersion` only (softwarePolicyService.ts:107-110),
   * so it must NOT. Pinned here so W02 can rely on it: a previously-stored
   * violation with no catalogId still stabilises the new one's detectedAt.
   */
  it('does not disturb detectedAt stabilisation against previously-stored violations', () => {
    const rules = normalizeSoftwarePolicyRules({
      software: [{ name: '7-Zip', catalogId: CATALOG_ID }],
      allowUnknown: true,
    });
    const next = evaluateSoftwareInventory('allowlist', rules, []);

    const previous = [{
      type: 'missing',
      rule: { name: '7-Zip' }, // stored before D9 shipped — no catalogId
      severity: 'high',
      detectedAt: '2026-01-01T00:00:00.000Z',
    }];

    const stabilised = withStableViolationTimestamps(next, previous);
    expect(stabilised[0]?.detectedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(stabilised[0]?.rule?.catalogId).toBe(CATALOG_ID);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd apps/api && npx vitest run src/services/softwarePolicyService.test.ts
```

Expected: the first test fails —
`expected { name: '7-Zip', minVersion: '23.0', maxVersion: undefined } to deeply equal { name: '7-Zip', minVersion: '23.0', maxVersion: undefined, catalogId: '999…', reason: 'Standard archive tool' }`.
The second and third pass already (they assert absence and stabilisation); they are the guard rails, not the discriminator. Also run:

```bash
pnpm --filter @breeze/api exec tsc --noEmit
```

Expected: `error TS2353: Object literal may only specify known properties, and 'catalogId' does not exist in type '{ name: string; minVersion?: string; maxVersion?: string; reason?: string; }'` — the type-level red.

- [ ] **Step 3: Add `catalogId` to the violation type**

In `apps/api/src/db/schema/softwarePolicies.ts`, replace lines 55-60 with:

```ts
  rule?: {
    name: string;
    minVersion?: string;
    maxVersion?: string;
    reason?: string;
    /**
     * The catalog item the matched/unmatched rule points at (#5505 D9).
     * Load-bearing for desired-state install: a `missing` violation is the only
     * place the install path can learn WHAT to install, and rule names are not
     * unique within a policy, so re-deriving it by name is not an option.
     */
    catalogId?: string;
  };
```

- [ ] **Step 4: Carry `catalogId` and `reason` through the `missing` emission**

In `apps/api/src/services/softwarePolicyService.ts`, replace the loop at lines 333-347 with:

```ts
    for (const rule of softwareRules) {
      const found = inventory.some((installed) => matchesSoftwareRule(installed, rule));
      if (!found) {
        violations.push({
          type: 'missing',
          rule: {
            name: rule.name,
            minVersion: rule.minVersion,
            maxVersion: rule.maxVersion,
            // #5505 D9: the install path resolves the catalog item from here.
            // `reason` mirrors the audit-mode branch below, which has always
            // carried it — a `missing` violation dropping it was an oversight.
            catalogId: rule.catalogId,
            reason: rule.reason,
          },
          severity: 'high',
          detectedAt,
        });
      }
    }
```

- [ ] **Step 5: Run the tests and watch them pass**

```bash
cd apps/api && npx vitest run src/services/softwarePolicyService.test.ts
pnpm --filter @breeze/api exec tsc --noEmit
```

Expected: all suites pass; tsc clean.

- [ ] **Step 6: Run the compliance-worker suite — it consumes these violations**

```bash
cd apps/api && npx vitest run src/jobs/softwareComplianceWorker.test.ts
```

Expected: pass, unchanged. This wave does not edit that worker; the run confirms the extra jsonb field did not disturb its violation handling.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/db/schema/softwarePolicies.ts apps/api/src/services/softwarePolicyService.ts apps/api/src/services/softwarePolicyService.test.ts
git commit -m "feat(api): carry rule catalogId and reason on missing software violations (#5506)"
```

---

### Task 5: `softwarePolicyAuthorization.ts` — the install-arming gate

**Files:**
- Create: `apps/api/src/services/softwarePolicyAuthorization.ts`
- Test (create): `apps/api/src/services/softwarePolicyAuthorization.test.ts`

**Interfaces:**
- Consumes: `readSoftwarePolicyAutoInstall` and `SoftwarePolicyArmingInput` from `./softwarePolicyService` (Task 2); `hasPermission`, `PERMISSIONS`, `UserPermissions` from `./permissions`; `hasSatisfiedMfa` from `../middleware/auth`.
- Produces:
  - `type SoftwarePolicyInstallArmingPatch = { mode?: string | null; enforceMode?: boolean | null; remediationOptions?: unknown }`
  - `const ARM_INSTALL_EXECUTE_DENIED_MESSAGE: string`
  - `function willBeArmedForInstall(stored: SoftwarePolicyArmingInput | null, patch: SoftwarePolicyInstallArmingPatch): boolean`
  - `async function assertMayArmInstall(c: Context, stored: SoftwarePolicyArmingInput | null, patch: SoftwarePolicyInstallArmingPatch): Promise<Response | null>` — `null` means allowed; a `Response` is the 403 the handler must return. (See "Contract deviation" in Global Constraints.)

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/softwarePolicyAuthorization.test.ts`:

```ts
/**
 * #5505 D3 — arming `remediationOptions.autoInstall` installs software on
 * customer machines, which is exactly what creating a software deployment does
 * (`routes/software.ts:1882-1888`: devices:execute + requireMfa()). The
 * software-policy write routes carry only devices:write + requireMfa(), so
 * without this gate a devices:write holder reaches installation through the
 * policy route — a privilege-escalation path around the deployment gate.
 *
 * The check is over POST-WRITE state: stored row overlaid with the request
 * body. That is what makes "edit the rules of an ALREADY-armed policy" gated
 * too — adding a catalogId to an armed policy installs new software.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { mfaRef, executeRef } = vi.hoisted(() => ({
  mfaRef: { current: true },
  executeRef: { current: true },
}));

vi.mock('../middleware/auth', () => ({
  hasSatisfiedMfa: vi.fn(() => mfaRef.current),
}));

vi.mock('./permissions', () => ({
  PERMISSIONS: {
    DEVICES_EXECUTE: { resource: 'devices', action: 'execute' },
  },
  hasPermission: vi.fn((_perms: unknown, resource: string, action: string) =>
    resource === 'devices' && action === 'execute' ? executeRef.current : false),
}));

import {
  ARM_INSTALL_EXECUTE_DENIED_MESSAGE,
  assertMayArmInstall,
  willBeArmedForInstall,
} from './softwarePolicyAuthorization';

const ARMED_STORED = { mode: 'allowlist', enforceMode: true, remediationOptions: { autoInstall: true } };
const UNARMED_STORED = { mode: 'allowlist', enforceMode: true, remediationOptions: { autoUninstall: true } };

describe('willBeArmedForInstall — post-write merged state', () => {
  it('create: body alone arms', () => {
    expect(willBeArmedForInstall(null, {
      mode: 'allowlist', enforceMode: true, remediationOptions: { autoInstall: true },
    })).toBe(true);
  });

  it('create: enforceMode absent means not armed (the row is created with enforceMode=false)', () => {
    expect(willBeArmedForInstall(null, {
      mode: 'allowlist', remediationOptions: { autoInstall: true },
    })).toBe(false);
  });

  it('create: audit mode is never armed', () => {
    expect(willBeArmedForInstall(null, {
      mode: 'audit', enforceMode: true, remediationOptions: { autoInstall: true },
    })).toBe(false);
  });

  it('create: autoUninstall does not arm install', () => {
    expect(willBeArmedForInstall(null, {
      mode: 'allowlist', enforceMode: true, remediationOptions: { autoUninstall: true },
    })).toBe(false);
  });

  it('update: an empty body over an ARMED stored row is still armed', () => {
    expect(willBeArmedForInstall(ARMED_STORED, {})).toBe(true);
  });

  it('update: an empty body over an UNARMED stored row is still unarmed', () => {
    expect(willBeArmedForInstall(UNARMED_STORED, {})).toBe(false);
  });

  it('update: the body wins over the stored row when it supplies the field', () => {
    expect(willBeArmedForInstall(ARMED_STORED, { remediationOptions: { autoInstall: false } })).toBe(false);
    expect(willBeArmedForInstall(ARMED_STORED, { enforceMode: false })).toBe(false);
    expect(willBeArmedForInstall(ARMED_STORED, { mode: 'audit' })).toBe(false);
    expect(willBeArmedForInstall(UNARMED_STORED, { remediationOptions: { autoInstall: true } })).toBe(true);
  });

  it('update: remediationOptions is REPLACED, not merged (routes/softwarePolicies.ts:556)', () => {
    // The stored row is armed; the body sends an options object without
    // autoInstall. The route writes that object wholesale, so the result is
    // disarmed — and the gate must agree.
    expect(willBeArmedForInstall(ARMED_STORED, { remediationOptions: { cooldownMinutes: 30 } })).toBe(false);
  });
});

/** Minimal Hono Context factory: runs a handler and hands back its Response. */
async function runGate(
  ctxSetup: (c: any) => void,
  stored: Parameters<typeof assertMayArmInstall>[1],
  patch: Parameters<typeof assertMayArmInstall>[2]
): Promise<Response> {
  const app = new Hono();
  app.get('/probe', async (c) => {
    ctxSetup(c);
    const denied = await assertMayArmInstall(c, stored, patch);
    return denied ?? c.json({ ok: true }, 200);
  });
  return app.request('/probe');
}

const ALLOWED_CTX = (c: any) => {
  c.set('auth', { user: { id: 'user-1' }, token: { mfa: true } });
  c.set('permissions', { permissions: [], scope: 'organization', orgId: null, partnerId: null, roleId: 'role-1' });
};

describe('assertMayArmInstall', () => {
  beforeEach(() => {
    mfaRef.current = true;
    executeRef.current = true;
  });

  it('allows any write that does not arm install, regardless of permissions', async () => {
    executeRef.current = false;
    mfaRef.current = false;
    const res = await runGate(ALLOWED_CTX, UNARMED_STORED, { mode: 'allowlist' });
    expect(res.status).toBe(200);
  });

  it('allows an arming write from a caller with devices.execute and MFA', async () => {
    const res = await runGate(ALLOWED_CTX, null, {
      mode: 'allowlist', enforceMode: true, remediationOptions: { autoInstall: true },
    });
    expect(res.status).toBe(200);
  });

  it('refuses an arming write without devices.execute', async () => {
    executeRef.current = false;
    const res = await runGate(ALLOWED_CTX, null, {
      mode: 'allowlist', enforceMode: true, remediationOptions: { autoInstall: true },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: ARM_INSTALL_EXECUTE_DENIED_MESSAGE,
      code: 'DEVICES_EXECUTE_REQUIRED',
    });
  });

  it('refuses an arming write when MFA is not satisfied, even with devices.execute', async () => {
    mfaRef.current = false;
    const res = await runGate(ALLOWED_CTX, null, {
      mode: 'allowlist', enforceMode: true, remediationOptions: { autoInstall: true },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'MFA required', code: 'MFA_REQUIRED' });
  });

  it('fails closed when the route never resolved permissions', async () => {
    const res = await runGate(
      (c: any) => { c.set('auth', { user: { id: 'user-1' }, token: { mfa: true } }); },
      null,
      { mode: 'allowlist', enforceMode: true, remediationOptions: { autoInstall: true } }
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('DEVICES_EXECUTE_REQUIRED');
  });

  it('refuses with 401 when there is no auth context at all', async () => {
    const res = await runGate(
      (c: any) => { c.set('permissions', { permissions: [] }); },
      null,
      { mode: 'allowlist', enforceMode: true, remediationOptions: { autoInstall: true } }
    );
    expect(res.status).toBe(401);
  });

  it('gates an edit that leaves an ALREADY-armed policy armed', async () => {
    executeRef.current = false;
    // Body touches only the name; the stored row stays armed for install.
    const res = await runGate(ALLOWED_CTX, ARMED_STORED, {});
    expect(res.status).toBe(403);
  });

  it('does not gate a write that DISARMS an armed policy', async () => {
    executeRef.current = false;
    const res = await runGate(ALLOWED_CTX, ARMED_STORED, { remediationOptions: { autoInstall: false } });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd apps/api && npx vitest run src/services/softwarePolicyAuthorization.test.ts
```

Expected: `Error: Failed to load url ./softwarePolicyAuthorization` — the module does not exist yet.

- [ ] **Step 3: Write the service**

Create `apps/api/src/services/softwarePolicyAuthorization.ts`:

```ts
import type { Context } from 'hono';
import { hasSatisfiedMfa } from '../middleware/auth';
import { hasPermission, PERMISSIONS, type UserPermissions } from './permissions';
import { readSoftwarePolicyAutoInstall, type SoftwarePolicyArmingInput } from './softwarePolicyService';

/**
 * Install-arming authorization (#5505 D3).
 *
 * Arming `remediationOptions.autoInstall` causes software to be installed on
 * customer machines — exactly what creating a software deployment does, which
 * requires `devices:execute` + `requireMfa()` (`routes/software.ts:1882-1888`).
 * The software-policy write routes require only `devices:write` +
 * `requireMfa()` + the in-handler `canMutateOrgWideGovernance` site ceiling, so
 * the delta needed to reach deployment-grade authorization is `devices.execute`.
 * Without this assertion the policy route is a privilege-escalation path around
 * the deployment gate.
 *
 * Why in-handler and not middleware: middleware cannot see whether the write
 * ARMS install — that depends on the resulting policy, which only exists once
 * the request body has been merged onto the stored row.
 *
 * Both conditions are asserted even though both current call sites already sit
 * behind `requireMfa()`. The assertion must stay correct if it is ever reused
 * on a route without it.
 */

/** The subset of a policy write body that can change install arming. */
export type SoftwarePolicyInstallArmingPatch = {
  mode?: string | null;
  enforceMode?: boolean | null;
  remediationOptions?: unknown;
};

export const ARM_INSTALL_EXECUTE_DENIED_MESSAGE =
  'Arming remediationOptions.autoInstall installs software on managed devices, so it requires the '
  + 'devices.execute permission — the same permission as creating a software deployment.';

/**
 * Post-write arming: `stored` is the row as it exists today (null on create),
 * `patch` is the validated request body. A field the body does not supply keeps
 * its stored value, which mirrors the PATCH handler exactly — note that
 * `remediationOptions` is REPLACED wholesale there
 * (`routes/softwarePolicies.ts:556`), never merged key-by-key.
 */
export function willBeArmedForInstall(
  stored: SoftwarePolicyArmingInput | null,
  patch: SoftwarePolicyInstallArmingPatch
): boolean {
  const mode = patch.mode !== undefined ? patch.mode : stored?.mode;
  const enforceMode = patch.enforceMode !== undefined ? patch.enforceMode : stored?.enforceMode;
  const remediationOptions = patch.remediationOptions !== undefined
    ? patch.remediationOptions
    : stored?.remediationOptions;

  if (mode === 'audit') return false;
  if (enforceMode !== true) return false;
  return readSoftwarePolicyAutoInstall(remediationOptions);
}

/**
 * Returns `null` when the write is allowed, or the 403/401 `Response` the
 * handler must return when it is not:
 *
 *   const denied = await assertMayArmInstall(c, stored, patch);
 *   if (denied) return denied;
 *
 * Refusals use coded bodies rather than `HTTPException` so callers branch on
 * `code` (mirrors `requireMfa()`, `middleware/auth.ts:897-905`).
 */
export async function assertMayArmInstall(
  c: Context,
  stored: SoftwarePolicyArmingInput | null,
  patch: SoftwarePolicyInstallArmingPatch
): Promise<Response | null> {
  if (!willBeArmedForInstall(stored, patch)) return null;

  const auth = c.get('auth');
  if (!auth) {
    return c.json({ error: 'Not authenticated', code: 'NOT_AUTHENTICATED' }, 401);
  }

  // `requirePermission` populates this (middleware/auth.ts:874) and runs ahead
  // of both current handlers. A missing value means this assertion is being
  // used off a route that never resolved permissions — fail closed.
  const perms = c.get('permissions') as UserPermissions | undefined;
  if (!perms || !hasPermission(
    perms,
    PERMISSIONS.DEVICES_EXECUTE.resource,
    PERMISSIONS.DEVICES_EXECUTE.action
  )) {
    return c.json({ error: ARM_INSTALL_EXECUTE_DENIED_MESSAGE, code: 'DEVICES_EXECUTE_REQUIRED' }, 403);
  }

  if (!hasSatisfiedMfa(auth)) {
    return c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403);
  }

  return null;
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
cd apps/api && npx vitest run src/services/softwarePolicyAuthorization.test.ts
```

Expected: 17 passed, 1 file.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm --filter @breeze/api exec tsc --noEmit
git add apps/api/src/services/softwarePolicyAuthorization.ts apps/api/src/services/softwarePolicyAuthorization.test.ts
git commit -m "feat(api): add the install-arming authorization gate (devices.execute + MFA) (#5506)"
```

---

### Task 6: wire the gate into the policy create and update routes

**Files:**
- Modify: `apps/api/src/routes/softwarePolicies.ts` (import; create handler after `:301`; update handler after `:541`)
- Test: `apps/api/src/routes/softwarePolicies.autoInstall.test.ts` (append)

**Interfaces:**
- Consumes: `assertMayArmInstall` from `../services/softwarePolicyAuthorization` (Task 5); `remediationOptionsSchema` with `autoInstall` (Task 1).
- Produces: no new exports. Behavioural contract: `POST /software-policies` and `PATCH /software-policies/:id` return `403 { code: 'DEVICES_EXECUTE_REQUIRED' }` or `403 { code: 'MFA_REQUIRED' }` when the write would leave the policy armed for install and the caller is not authorized. No write occurs on refusal.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/routes/softwarePolicies.autoInstall.test.ts`. Extend the existing import of `./softwarePolicies` — no change needed there — and add one import at the top of the import block:

```ts
import { ARM_INSTALL_EXECUTE_DENIED_MESSAGE } from '../services/softwarePolicyAuthorization';
```

Then append:

```ts
describe('#5505 D3 — arming autoInstall requires devices.execute + MFA', () => {
  const ARMED_BODY = {
    orgId: ORG_ID,
    name: 'Required software',
    mode: 'allowlist',
    rules: { software: [{ name: '7-Zip' }] },
    enforceMode: true,
    remediationOptions: { autoInstall: true },
  };

  function mockStoredPolicy(row: Record<string, unknown>) {
    (db.select as any).mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([row]) }) }),
    });
  }

  function mockUpdateTransaction() {
    (db.transaction as any).mockImplementation(async (fn: (tx: unknown) => unknown) => fn({
      update: () => ({
        set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: POLICY_ID, orgId: ORG_ID, name: 'renamed', approvalGeneration: 2 }]) }) }),
      }),
    }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    authRef.current = orgAuth() as unknown as Record<string, unknown>;
    mfaRef.current = true;
    executeRef.current = true;
  });

  it('POST refuses an arming create without devices.execute, and writes nothing', async () => {
    executeRef.current = false;
    const captured: { values?: Record<string, unknown> } = {};
    mockInsertCapturing(captured);

    const res = await app().request('/software-policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ARMED_BODY),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: ARM_INSTALL_EXECUTE_DENIED_MESSAGE,
      code: 'DEVICES_EXECUTE_REQUIRED',
    });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('POST refuses an arming create when MFA is unsatisfied', async () => {
    mfaRef.current = false;
    mockInsertCapturing({});

    const res = await app().request('/software-policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ARMED_BODY),
    });

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('MFA_REQUIRED');
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('POST allows an arming create for a caller with devices.execute + MFA', async () => {
    const captured: { values?: Record<string, unknown> } = {};
    mockInsertCapturing(captured);

    const res = await app().request('/software-policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ARMED_BODY),
    });

    expect(res.status).toBe(201);
    expect(captured.values?.remediationOptions).toEqual({ autoInstall: true });
  });

  it('POST does NOT gate autoInstall without enforceMode (the row is created detect-only)', async () => {
    executeRef.current = false;
    const captured: { values?: Record<string, unknown> } = {};
    mockInsertCapturing(captured);

    const res = await app().request('/software-policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...ARMED_BODY, enforceMode: false }),
    });

    expect(res.status).toBe(201);
  });

  it('POST does NOT gate an audit-mode policy even with enforceMode + autoInstall', async () => {
    executeRef.current = false;
    mockInsertCapturing({});

    const res = await app().request('/software-policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...ARMED_BODY, mode: 'audit' }),
    });

    expect(res.status).toBe(201);
  });

  it('POST does NOT gate an autoUninstall-only create', async () => {
    executeRef.current = false;
    mockInsertCapturing({});

    const res = await app().request('/software-policies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...ARMED_BODY, remediationOptions: { autoUninstall: true } }),
    });

    expect(res.status).toBe(201);
  });

  it('PATCH gates a rules edit on an ALREADY-armed policy (post-write merged state)', async () => {
    executeRef.current = false;
    mockStoredPolicy({
      id: POLICY_ID, orgId: ORG_ID, isActive: true,
      mode: 'allowlist', enforceMode: true, remediationOptions: { autoInstall: true },
    });
    mockUpdateTransaction();

    const res = await app().request(`/software-policies/${POLICY_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules: { software: [{ name: 'Firefox' }] } }),
    });

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('DEVICES_EXECUTE_REQUIRED');
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('PATCH allows DISARMING an armed policy without devices.execute', async () => {
    executeRef.current = false;
    mockStoredPolicy({
      id: POLICY_ID, orgId: ORG_ID, isActive: true,
      mode: 'allowlist', enforceMode: true, remediationOptions: { autoInstall: true },
    });
    mockUpdateTransaction();

    const res = await app().request(`/software-policies/${POLICY_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remediationOptions: { autoInstall: false } }),
    });

    expect(res.status).toBe(200);
  });

  it('PATCH gates arming an unarmed policy', async () => {
    executeRef.current = false;
    mockStoredPolicy({
      id: POLICY_ID, orgId: ORG_ID, isActive: true,
      mode: 'allowlist', enforceMode: true, remediationOptions: { autoUninstall: true },
    });
    mockUpdateTransaction();

    const res = await app().request(`/software-policies/${POLICY_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remediationOptions: { autoInstall: true } }),
    });

    expect(res.status).toBe(403);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('PATCH leaves an ordinary edit on an unarmed policy alone', async () => {
    executeRef.current = false;
    mockStoredPolicy({
      id: POLICY_ID, orgId: ORG_ID, isActive: true,
      mode: 'allowlist', enforceMode: true, remediationOptions: null,
    });
    mockUpdateTransaction();

    const res = await app().request(`/software-policies/${POLICY_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'renamed' }),
    });

    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
cd apps/api && npx vitest run src/routes/softwarePolicies.autoInstall.test.ts
```

Expected: the six refusal/gating tests fail with `expected 201 to be 403` / `expected 200 to be 403` and `expected "insert" not to be called` — the routes do not consult the gate yet. The permissive tests pass.

- [ ] **Step 3: Import the gate into the route module**

In `apps/api/src/routes/softwarePolicies.ts`, add the import next to the other service imports (after line 20, `siteCeilingAccess`):

```ts
import { assertMayArmInstall } from '../services/softwarePolicyAuthorization';
```

- [ ] **Step 4: Gate the create handler**

In `apps/api/src/routes/softwarePolicies.ts`, replace line 301 (`const payload = c.req.valid('json');` inside the POST handler) with:

```ts
    const payload = c.req.valid('json');

    // #5505 D3: arming remediationOptions.autoInstall installs software on
    // managed devices, so it needs deployment-grade authorization
    // (devices.execute + MFA) on top of the devices:write + requireMfa() this
    // route already carries. `stored` is null — nothing exists yet — so the
    // merged state is the body alone.
    const armDenied = await assertMayArmInstall(c, null, {
      mode: payload.mode,
      enforceMode: payload.enforceMode,
      remediationOptions: payload.remediationOptions,
    });
    if (armDenied) return armDenied;
```

- [ ] **Step 5: Gate the update handler**

In `apps/api/src/routes/softwarePolicies.ts`, insert immediately after the partner-wide administration check that ends at line 541 (`}` closing `if (policy.orgId === null && !canManagePartnerWidePolicies(auth))`), and before the `const updates: …` declaration:

```ts
    // #5505 D3: evaluated over the POST-WRITE merged state — the stored row
    // overlaid with this body — so editing an ALREADY-armed policy is gated
    // too. Adding a catalogId to an armed policy installs new software, and
    // that must not be reachable with a weaker credential than arming was.
    const armDenied = await assertMayArmInstall(c, policy, {
      mode: payload.mode,
      enforceMode: payload.enforceMode,
      remediationOptions: payload.remediationOptions,
    });
    if (armDenied) return armDenied;
```

- [ ] **Step 6: Run the tests and watch them pass**

```bash
cd apps/api && npx vitest run src/routes/softwarePolicies.autoInstall.test.ts
```

Expected: all suites pass (5 from Task 1 + 10 here).

- [ ] **Step 7: Re-run the neighbouring route suites and typecheck**

```bash
cd apps/api && npx vitest run src/routes/softwarePolicies.test.ts src/routes/softwarePolicies.siteScope.test.ts src/routes/softwarePolicies.approvalGeneration.test.ts
pnpm --filter @breeze/api exec tsc --noEmit
```

Expected: 3 files passed; tsc clean. None of those files sends `remediationOptions` (verified in §0), so the gate short-circuits before it can touch their `../services/permissions` mock — which supplies no `hasPermission`. If one of them ever starts sending armed options, add `hasPermission: () => true` to that file's permissions mock.

- [ ] **Step 8: Lint and commit**

```bash
pnpm --filter @breeze/api lint
git add apps/api/src/routes/softwarePolicies.ts apps/api/src/routes/softwarePolicies.autoInstall.test.ts
git commit -m "feat(api): gate autoInstall arming on devices.execute + MFA in both policy write routes (#5506)"
```

---

## Wave close-out

- [ ] **Run every suite this wave touched, in one command**

```bash
cd apps/api && npx vitest run \
  src/routes/softwarePolicies.autoInstall.test.ts \
  src/routes/softwarePolicies.test.ts \
  src/routes/softwarePolicies.siteScope.test.ts \
  src/routes/softwarePolicies.approvalGeneration.test.ts \
  src/services/softwarePolicyArming.test.ts \
  src/services/softwarePolicyService.test.ts \
  src/services/softwarePolicyAuthorization.test.ts \
  src/services/aiToolsCompliance.siteScope.test.ts \
  src/jobs/softwareRemediationWorker.test.ts \
  src/jobs/softwareComplianceWorker.test.ts
```

Every path is listed explicitly on purpose: vitest's filter is a plain substring match, so `src/services/softwarePolicy` would also pull in unrelated files and `src/services/softwarePolicy/` would match nothing.

- [ ] **Typecheck and lint the package**

```bash
pnpm --filter @breeze/api exec tsc --noEmit
pnpm --filter @breeze/api lint
```

- [ ] **No migration, no registry — assert it rather than assume it**

```bash
git diff --name-only main...HEAD | grep -E 'migrations/|tenantCascade|tenantExportPolicyRegistry|rls-coverage|routes/devices/core' || echo "clean: no migration or registry file touched"
```

Expected: `clean: …`. This wave changes only jsonb-typed shapes and TypeScript, so the cascade/export/RLS contracts are untouched. If this grep prints a filename, something outside W01's scope was edited — revert it.

- [ ] **PR body must state the out-of-scope list**

Include the "Explicitly OUT OF SCOPE" section from this plan verbatim, plus `Closes #5506`, so a reviewer does not read the missing worker/dispatch/migration work as an omission.

---

## Self-review

**1. Spec coverage.** Walked the spec and the contract's wave-ownership row for W01:

| Requirement | Task |
|---|---|
| `autoInstall?: boolean` on `SoftwarePolicyRemediationOptions` (spec §1) | 1 |
| `autoInstall` on both HTTP zod schemas (contract "Verified starting facts": one shared object) | 1 |
| No migration / no export-policy change for `autoInstall` (spec §1) | 1 + close-out grep |
| `PolicyRemediationVerb`, extended `SoftwarePolicyUnarmedReason`, `readSoftwarePolicyAutoInstall`, required verb param (D2) | 2 |
| Both non-test call sites pass `'uninstall'` (D2) | 2 (step 4) |
| Verb-aware refusal messages, `auto_install_off` names `remediationOptions.autoInstall` (D2) | 2 |
| Regression: arming install does not arm uninstall and vice versa (spec Testing) | 2 (`the two verbs are independent`) |
| `softwarePolicyAuthorization.ts` + `assertMayArmInstall` (D3) | 5 |
| `devices.execute` **and** MFA both asserted (D3) | 5 |
| Post-write merged state; editing an already-armed policy gated (D3) | 5 + 6 |
| Wired into policy create and update (D3) | 6 |
| Four exported audit-action constants, no literals, no uninstall refactor (D6) | 3 |
| `catalogId` (+ `reason`) on the emitted `missing` violation and on the type (D9) | 4 |
| D9's open question — does the new field disturb violation matching? | 4 (answered *no*, with a regression test; see §0) |

Not covered, by design: everything in the "Explicitly OUT OF SCOPE" list. Spec §5's AI-tool decision ("the safe default is no") is D4, owned by **W05** — W01 deliberately leaves the AI write sites alone, and because `aiAgentSdkTools.ts:2251` types `remediationOptions` as `z.record(z.string(), z.unknown())`, adding `autoInstall` to the HTTP schema in Task 1 does **not** widen the AI surface (it was already unconstrained). The one AI-adjacent edit here is the compiler-forced `'uninstall'` argument at `aiToolsCompliance.ts:509`.

**2. Placeholder scan.** No "TBD", no "similar to Task N", no "add appropriate error handling". Every code step carries the complete literal it replaces or inserts, quoted against a line range that was re-opened during the ground-truth pass. The one judgement call left to the implementer is spelled out with its exact remedy (Task 6 step 7's permissions-mock note).

**3. Type consistency.** Names used across tasks: `SoftwarePolicyArmingInput` (Task 2 keeps it unchanged; Tasks 5/6 consume it as `stored`'s type); `readSoftwarePolicyAutoInstall` (Task 2 defines, Task 5 imports, Task 1's route-test mock reproduces it faithfully); `SoftwarePolicyInstallArmingPatch` (Task 5 defines, Task 6 passes object literals matching it — `mode?: string | null` accepts the route's `'allowlist' | 'blocklist' | 'audit' | undefined`, `enforceMode?: boolean | null` accepts `boolean | undefined`); `ARM_INSTALL_EXECUTE_DENIED_MESSAGE` (Task 5 exports, Tasks 5 and 6 assert against it rather than restating the string); `SOFTWARE_POLICY_INSTALL_AUDIT_ACTIONS` (Task 3, consumed by W02/W03 only). `assertMayArmInstall`'s three-parameter shape is used identically in Task 5's tests and Task 6's two call sites.

**4. Known deviation.** One, recorded in Global Constraints → "Contract deviation": `assertMayArmInstall` returns `Promise<Response | null>` and takes `(c, stored, patch)` rather than the contract's `(c): Promise<void>`. Name, file path, semantics and both refusal bodies are exactly as contracted.
