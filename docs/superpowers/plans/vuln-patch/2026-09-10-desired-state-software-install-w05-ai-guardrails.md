---
tracking_issue: LanternOps/breeze#5505
---

# Desired-State Software Install — W05: AI Guardrails and Tool Schemas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guarantee the AI agent can never arm `remediationOptions.autoInstall` on a software policy — an `autoInstall: true` reaching any of the four AI write sites is refused outright, not silently stripped — while leaving every existing AI capability (including arming `autoUninstall`, and reading a policy's armed state) unchanged.

**Architecture:** Schema typing cannot hold this line (both AI input-validation surfaces let extra/untyped keys reach the handler unmodified — verified below in Ground Truth). The refusal therefore lives as an explicit runtime check inside each of the four handler functions that can write `remediationOptions`, backed by one shared helper and one exported message string so all four sites say the same thing. A companion change makes the refusal greppable in the audit trail and documents it in the guardrail comment block and the tool-facing schema text.

**Tech Stack:** TypeScript, Hono AI tool handlers, Vitest (unit, mocked Drizzle — no live DB needed; this wave ships no migration and no schema change).

**Spec:** `docs/superpowers/specs/vuln-patch/2026-09-10-desired-state-software-install-design.md` (see its "Corrections after ground-truth verification" section — authoritative over the body where they disagree)

**Contract:** `/private/tmp/claude-501/-Users-toddhebebrand--herdr-worktrees-breeze-warranty-testing/4b860881-d3d0-4020-ad1e-65daf215df86/scratchpad/contract-A-desired-state.md` (locked, cross-wave, authoritative — this plan copies the parts it needs verbatim below)

**Tracking:** Feature #5505, wave W05 = sub-issue #5510.

## Global Constraints

(Copied verbatim from the locked contract, `contract-A-desired-state.md`, §D4 and the wave-ownership map — this wave may not diverge from them.)

- **D4 — the AI may never arm install.** `remediationOptionsSchema` (HTTP side) is non-strict, and `aiAgentSdkTools.ts:2251` types `remediationOptions` as `z.record(z.string(), z.unknown())` — schema-level typing cannot hold the line for the AI (verified below: neither AI validation path even uses its own parsed/stripped output). The refusal therefore lives at the four AI write sites: `aiToolsCompliance.ts:287` (create), `:356-357` (update); `aiToolsPolicyPrereqs.ts:441` (create), `:496` (update). An `autoInstall: true` reaching any of them is **refused, not stripped**.
- **Exact refusal message, verbatim, used at all four sites, exported once:**
  `'Arming autoInstall requires a human operator with devices.execute and MFA; the AI agent cannot arm software installation.'`
- W05 also adds an `autoInstall` line to `summarizeEnforcementChange` (`aiToolsSoftwarePolicyAudit.ts:76-84`) so it is greppable in the audit trail, and extends the `aiGuardrails.ts:211-245` comment block, whose text currently names only `autoUninstall` as the arming pair.
- **Wave ownership map (row for this wave):** W05 #5510 owns `aiGuardrails.ts`, the four AI write sites, AI zod/JSON schemas, `summarizeEnforcementChange`. **Must NOT touch:** everything else — in particular, not `aiToolsCompliance.ts:509` (the `remediate_software_violation` handler's `evaluateSoftwarePolicyArming(policy)` call — W01 owns updating that call site to pass the new required `'uninstall'` verb argument), not `softwarePolicyService.ts` (arming helper, audit-action constants — W01), not the compliance/remediation workers (W02/W03), not any migration, not any HTTP route.
- **Reads stay Tier 1 and are never escalated.** `list`/`get` on both software-policy AI tools deliberately auto-execute with no approval prompt; this wave must not change that, and the AI may freely **read** a policy's armed state (including a human-armed `autoInstall: true`) — only **writing** it is refused.
- **Testing gates (non-negotiable):** Red-first on every behavioural change — write the assertion, watch it fail against unmodified code, then implement. Scoped test runs: `cd apps/api && npx vitest run <path>`. **Never** `pnpm --filter <pkg> test -- --run <path>` (the `--` makes vitest run the whole suite in watch mode). Remember vitest's path filter is a plain substring match, not a directory prefix.
- This wave ships **no migration and no DB schema change** — `remediation_options` is jsonb and the AI write paths bypass `remediationOptionsSchema` entirely (they cast to `Record<string, unknown>`/`any`), so the guard works identically whether or not W01 (which adds `autoInstall` to the typed schema and DB column semantics) has landed yet.

---

## 0. Ground Truth

Every file and line the task brief cited was re-opened against the current worktree (branch `spec/hp-warranty-and-desired-state-install`, commit `02d3e7b143`). **All cited line numbers are confirmed correct — nothing in the brief was wrong.** Full verbatim quotes below.

### 0.1 The four AI write sites

**`apps/api/src/services/aiToolsCompliance.ts:262-319`** (create action, `manage_software_policy` tool):
```ts
    if (action === 'create') {
      if (typeof input.name !== 'string' || typeof input.mode !== 'string') {
        return JSON.stringify({ error: 'name and mode are required for create' });
      }

      const orgResolution = resolveWritableToolOrgId(auth, typeof input.orgId === 'string' ? input.orgId : undefined);
      if (!orgResolution.orgId) return JSON.stringify({ error: orgResolution.error });

      const rules = normalizeSoftwarePolicyRules({
        software: Array.isArray(input.software) ? input.software : [],
        allowUnknown: input.allowUnknown === true,
      });
      if (rules.software.length === 0) {
        return JSON.stringify({ error: 'At least one software rule is required' });
      }

      const [policy] = await db
        .insert(softwarePolicies)
        .values({
          orgId: orgResolution.orgId,
          name: input.name as string,
          description: (input.description as string) ?? null,
          mode: input.mode as 'allowlist' | 'blocklist' | 'audit',
          rules,
          enforceMode: input.enforceMode === true,
          remediationOptions: (input.remediationOptions as Record<string, unknown>) ?? null,   // :287
          createdBy: auth.user.id,
        })
        .returning();
```
Confirmed: `remediationOptions` write is at **line 287**, exactly as cited.

**`apps/api/src/services/aiToolsCompliance.ts:321-358`** (update action):
```ts
    if (action === 'update') {
      if (!input.policyId) return JSON.stringify({ error: 'policyId is required' });
      ...
      const [existing] = await db.select().from(softwarePolicies).where(and(...conditions)).limit(1);
      if (!existing) return JSON.stringify({ error: 'Policy not found or access denied' });

      // Partner-wide templates are administrable only with the partner-wide
      // capability (same gate as the HTTP route).
      if (existing.orgId === null && !canManagePartnerWidePolicies(auth)) {
        return JSON.stringify({ error: 'Modifying a partner-wide software policy requires full partner org access (orgAccess must be "all")' });
      }

      const updates: Omit<Partial<typeof softwarePolicies.$inferInsert>, 'approvalGeneration'> & { approvalGeneration?: SQL } = {
        updatedAt: new Date(),
        approvalGeneration: bumpApprovalGeneration(softwarePolicies.approvalGeneration),
      };
      if (typeof input.name === 'string') updates.name = input.name;
      if (typeof input.description === 'string') updates.description = input.description;
      if (typeof input.mode === 'string') updates.mode = input.mode as 'allowlist' | 'blocklist' | 'audit';
      if (typeof input.enforceMode === 'boolean') updates.enforceMode = input.enforceMode;
      if (typeof input.isActive === 'boolean') updates.isActive = input.isActive;
      if (input.remediationOptions && typeof input.remediationOptions === 'object') {           // :356
        updates.remediationOptions = input.remediationOptions as Record<string, unknown>;        // :357
      }
```
Confirmed: exactly `:356-357` as cited.

**`apps/api/src/services/aiToolsPolicyPrereqs.ts:415-468`** (create action, `manage_software_policies` tool):
```ts
      if (action === 'create') {
        let owner: { orgId: string | null; partnerId: string | null };
        if (input.ownerScope === 'partner') {
          if (!auth.partnerId) return JSON.stringify({ error: 'Partner-wide software policies require partner scope' });
          if (!canManagePartnerWidePolicies(auth)) {
            return JSON.stringify({ error: 'Partner-wide software policies require full partner org access (orgAccess must be "all")' });
          }
          owner = { orgId: null, partnerId: auth.partnerId };
        } else {
          if (!orgId) return JSON.stringify({ error: 'Organization context required' });
          owner = { orgId, partnerId: null };
        }
        if (!input.name) return JSON.stringify({ error: 'name is required' });
        if (!input.mode) return JSON.stringify({ error: 'mode is required (allowlist, blocklist, or audit)' });

        const rows = await db.insert(softwarePolicies).values({
          orgId: owner.orgId,
          partnerId: owner.partnerId,
          name: input.name as string,
          description: (input.description as string) ?? null,
          mode: input.mode as any,
          rules: (input.rules as any) ?? { software: [], allowUnknown: false },
          enforceMode: input.enforceMode === true,
          remediationOptions: (input.remediationOptions as any) ?? null,                          // :441
          isActive: input.isActive !== false,
          createdBy: auth.user.id,
        }).returning();
```
Confirmed: **line 441** exactly.

**`apps/api/src/services/aiToolsPolicyPrereqs.ts:470-499`** (update action):
```ts
      if (action === 'update') {
        if (!input.policyId) return JSON.stringify({ error: 'policyId is required' });
        ...
        const [existing] = await db.select().from(softwarePolicies).where(and(...conditions)).limit(1);
        if (!existing) return JSON.stringify({ error: 'Software policy not found or access denied' });

        if (existing.orgId === null && !canManagePartnerWidePolicies(auth)) {
          return JSON.stringify({ error: 'Modifying a partner-wide software policy requires full partner org access (orgAccess must be "all")' });
        }

        const updates: Record<string, unknown> = {
          updatedAt: new Date(),
          approvalGeneration: bumpApprovalGeneration(softwarePolicies.approvalGeneration),
        };
        if (typeof input.name === 'string') updates.name = input.name;
        if (typeof input.description === 'string') updates.description = input.description;
        if (typeof input.mode === 'string') updates.mode = input.mode;
        if (input.rules) updates.rules = input.rules;
        if (typeof input.enforceMode === 'boolean') updates.enforceMode = input.enforceMode;
        if (input.remediationOptions) updates.remediationOptions = input.remediationOptions;      // :496
        if (typeof input.isActive === 'boolean') updates.isActive = input.isActive;
```
Confirmed: **line 496** exactly.

### 0.2 Why the schema cannot hold the line (verified, not assumed)

`apps/api/src/services/aiTools.ts:522-540` (`executeTool`):
```ts
  let effectiveInput = input;
  if (auth.helperDeviceId) {
    const scoped = applyHelperDeviceScope(toolName, input, auth.helperDeviceId);
    if ('error' in scoped) return JSON.stringify({ error: scoped.error });
    effectiveInput = scoped.input;
  }

  const validation = extensionTool
    ? extensionTool.validateInput(effectiveInput)
    : validateToolInput(toolName, effectiveInput);
  if (!validation.success) {
    return JSON.stringify({ error: validation.error });
  }
  ...
  if (coreTool) return coreTool.handler(effectiveInput, auth, opts?.context);
```
`apps/api/src/services/aiToolSchemas.ts:1699-1721` (`validateToolInput`):
```ts
export function validateToolInput(
  toolName: string,
  input: Record<string, unknown>
): { success: true } | { success: false; error: string } {
  const schema = toolInputSchemas[toolName];
  if (!schema) { ... }
  const result = schema.safeParse(input);
  if (result.success) {
    return { success: true };
  }
  ...
}
```
**Confirmed:** `validateToolInput` calls `schema.safeParse(input)` but discards `result.data` — it returns only `{ success: true }`. `executeTool` then calls `coreTool.handler(effectiveInput, ...)` with the **original, unparsed** `effectiveInput`, not any zod-sanitized value. Since `remediationOptionsSchema`-shaped Zod objects in `aiToolSchemas.ts` (`:1120-1126`, `:1647-1653`) are plain `z.object({...}).optional()` — **not** `.strict()` — an unknown key like `autoInstall` causes no validation failure (zod only *strips* unknown keys from its own parsed output in non-strict mode; it does not reject the call). So `input.remediationOptions.autoInstall` reaches the handler completely untouched regardless of whether `autoInstall` is ever added to these Zod schemas.

The SDK path (`apps/api/src/services/aiAgentSdkTools.ts:2251`, inside the `manage_software_policies` tool registration) types `remediationOptions: z.record(z.string(), z.unknown()).optional()` — an explicitly untyped bag — and its handler (`makeHandler`, confirmed at `aiAgentSdkTools.ts:16,525-526`) delegates to the **same** `executeTool(toolName, args, auth)`. Both AI invocation paths converge on the same four handler functions.

**Conclusion (matches contract D4 exactly): the refusal must be a runtime check inside the four handler functions. Adding `autoInstall` to the AI-facing Zod schemas would be inert — it wouldn't block anything, since the schema's parsed/stripped value is never used — so this plan does not add it there (see §7 Decisions).**

### 0.3 The shared audit/description module

**`apps/api/src/services/aiToolsSoftwarePolicyAudit.ts`** (full file, 84 lines) — relevant tail, confirmed verbatim:
```ts
export function summarizeEnforcementChange(input: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  if (typeof input.enforceMode === 'boolean') summary.enforceMode = input.enforceMode;
  if (input.remediationOptions && typeof input.remediationOptions === 'object') {
    summary.remediationOptions = input.remediationOptions;
    summary.autoUninstall = (input.remediationOptions as Record<string, unknown>).autoUninstall === true;
  }
  return summary;
}
```
This is lines 76-84 exactly as cited. Both write-site files already import from this module:
- `aiToolsCompliance.ts:27-31`: `import { auditSoftwarePolicyToolEvent, summarizeEnforcementChange } from './aiToolsSoftwarePolicyAudit';`
- `aiToolsPolicyPrereqs.ts:27-30`: identical import shape.

No other non-test file imports `aiToolsSoftwarePolicyAudit.ts` (verified: `grep -rln "aiToolsSoftwarePolicyAudit" apps/api/src --include="*.ts" | grep -v test` returns only these two files).

### 0.4 `aiGuardrails.ts` comment block

**`apps/api/src/services/aiGuardrails.ts:211-245`** (inside `export const TIER3_ACTIONS`), confirmed verbatim, the relevant lines:
```ts
  // Policy prerequisite tools (#3552) — the standalone feature policies that
  ...
  // action on real endpoints with no human in the loop:                          // :224
  //   - software policies: `enforceMode` + `remediationOptions.autoUninstall`     // :225
  //     turn a detect-only allowlist into fleet-wide auto-uninstall (the #3381    // :226
  //     mass-uninstall failure mode).                                            // :227
  //   - update rings: `autoApprove` + `deadlineDays` + `gracePeriodHours` arm     // :228
  ...
  manage_update_rings: ['create', 'update'],
  manage_software_policies: ['create', 'update'],                                  // :245
```
Confirmed: `:225` is exactly the `enforceMode` + `remediationOptions.autoUninstall` line, `:245` is exactly the `manage_software_policies` tier entry. Both `manage_software_policy` (`aiToolsCompliance.ts`, base tier 3 — confirmed by its file-header doc comment `manage_software_policy (Tier 3): CRUD for software policies`) and `manage_software_policies` (this entry) are **already** gated Tier 3 for `create`/`update` — this wave changes no tier, only documents the new, stronger (outright-refusal, not merely approval-gated) rule for `autoInstall`.

### 0.5 The JSON-schema description strings

`apps/api/src/services/aiToolsCompliance.ts:203`:
```ts
        remediationOptions: { type: 'object', description: 'Remediation behavior options' },
```
`apps/api/src/services/aiToolsPolicyPrereqs.ts:362`:
```ts
          remediationOptions: { type: 'object', description: '{ autoUninstall?: false, notifyUser?: true, gracePeriod?: number, cooldownMinutes?: 30, maintenanceWindowOnly?: false }' },
```
Both confirmed exactly as cited.

### 0.6 Existing tests that mock the shared module and will break without a fix

`grep -rln "vi.mock.*aiToolsSoftwarePolicyAudit" apps/api/src --include="*.test.ts"` finds exactly **four** files whose mock factory fully replaces the module (all four blocks are byte-identical):
```ts
vi.mock('./aiToolsSoftwarePolicyAudit', () => ({
  auditSoftwarePolicyToolEvent: vi.fn(),
  summarizeEnforcementChange: vi.fn(() => ({})),
}));
```
- `aiToolsCompliance.siteScope.test.ts:21-24` — exercises `manage_software_policy` create/update (confirmed: `handlerFor('manage_software_policy')({action: 'create', ...})` at line 217-218).
- `aiToolsPolicyPrereqs.siteScope.test.ts:29-32` — exercises `manage_software_policies` create/update (confirmed: `['manage_software_policies', { action: 'create', ...}]` at line 66-67).
- `aiToolsPolicyPrereqs.test.ts:47-50` — exercises `manage_software_policies` create (confirmed: `tools.get('manage_software_policies')` at line 598-599, "partner-wide create gate" describe block).
- `aiToolsPolicyPrereqs.updateRings.test.ts:39-42` — exercises only `manage_update_rings` (confirmed: `tools.get('manage_update_rings')` at line 65), **not** software policies.

**This is load-bearing:** once a handler calls a named export (`remediationOptionsArmsAutoInstall`) that these four mock factories don't provide, that export resolves to `undefined` inside the mocked module, and `undefined(...)` throws `TypeError: remediationOptionsArmsAutoInstall is not a function` on **every** create/update call in the first three files (and, defensively, would do the same in the fourth the moment any future test there touches software policies). All four factories must gain the new export in the same task that introduces the call, or those suites go red as an unintended regression, not a deliberate one this plan tracks.

Two sibling files (`aiToolsCompliance.auditAndArming.test.ts`, `aiToolsPolicyPrereqs.softwarePolicyAudit.test.ts`) do **not** mock `./aiToolsSoftwarePolicyAudit` (they let the real module run and instead mock `./auditEvents` + `softwarePolicyService`'s `recordSoftwarePolicyAudit`), so they need no fix — they exercise the real `remediationOptionsArmsAutoInstall` and serve as an additional regression check that unrelated `autoUninstall`-arming behavior is unchanged.

### 0.7 W01 boundary — confirmed, not assumed

Current (pre-W01) state of `apps/api/src/services/softwarePolicyService.ts:177-206`:
```ts
export function evaluateSoftwarePolicyArming(
  policy: SoftwarePolicyArmingInput
): SoftwarePolicyArmingState {
```
Single-argument, as the contract's "Verified starting facts" describe. Its sole non-test call sites are `softwareRemediationWorker.ts:318` and `aiToolsCompliance.ts:509`:
```ts
apps/api/src/services/aiToolsCompliance.ts:509:    const arming = evaluateSoftwarePolicyArming(policy);
```
Per the contract's D2 and wave-ownership map, **W01 owns updating this call site** (to `evaluateSoftwarePolicyArming(policy, 'uninstall')`) as part of making the helper verb-aware — it is explicitly listed under W01's scope ("verb-aware `evaluateSoftwarePolicyArming` + `readSoftwarePolicyAutoInstall` + both call sites"), not W05's. **This plan does not touch line 509.** It sits well after (line 509 > line 380) every region this plan edits in `aiToolsCompliance.ts`, so W01 landing before or after this wave causes no line-number drift in the regions this plan cites. This wave has **no compile-time dependency** on W01 — none of the code added here references any W01-introduced symbol (`PolicyRemediationVerb`, `readSoftwarePolicyAutoInstall`, `evaluateSoftwarePolicyArming`'s new parameter, `assertMayArmInstall`, the audit-action constants). It can be implemented and merged independently of W01's landing order; if both touch `aiToolsCompliance.ts` in the same PR window, the two changes are in disjoint line ranges (this plan: ~200-360; W01: ~509) so a rebase is mechanical.

---

## File Structure

- **Modify** `apps/api/src/services/aiToolsSoftwarePolicyAudit.ts` — add the exported refusal message + guard helper; extend `summarizeEnforcementChange`.
- **Create** `apps/api/src/services/aiToolsSoftwarePolicyAudit.test.ts` — unit tests for the new helper and the extended summary.
- **Modify** `apps/api/src/services/aiToolsCompliance.ts` — wire the guard into create + update; update the `remediationOptions` JSON-schema description.
- **Create** `apps/api/src/services/aiToolsCompliance.autoInstallGuardrail.test.ts` — refusal + regression tests for both write sites, plus a read-is-never-gated check.
- **Modify** `apps/api/src/services/aiToolsCompliance.siteScope.test.ts` — add the new export to its full-module mock.
- **Modify** `apps/api/src/services/aiToolsPolicyPrereqs.ts` — wire the guard into create + update; update the `remediationOptions` JSON-schema description.
- **Create** `apps/api/src/services/aiToolsPolicyPrereqs.autoInstallGuardrail.test.ts` — refusal + regression tests for both write sites.
- **Modify** `apps/api/src/services/aiToolsPolicyPrereqs.siteScope.test.ts`, `apps/api/src/services/aiToolsPolicyPrereqs.test.ts`, `apps/api/src/services/aiToolsPolicyPrereqs.updateRings.test.ts` — add the new export to their full-module mocks.
- **Modify** `apps/api/src/services/aiGuardrails.ts` — extend the `TIER3_ACTIONS` comment block documenting the software-policy arming fields.

No migration. No schema file. No HTTP route. No worker file.

---

## Task 1: Shared refusal helper and audit-summary line

**Files:**
- Modify: `apps/api/src/services/aiToolsSoftwarePolicyAudit.ts`
- Test: `apps/api/src/services/aiToolsSoftwarePolicyAudit.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 2 and 3):
  - `export const AI_AUTO_INSTALL_REFUSAL_MESSAGE: string`
  - `export function remediationOptionsArmsAutoInstall(remediationOptions: unknown): boolean`
- Consumes: nothing new.

- [ ] **Step 1: Write the failing unit test file**

Create `apps/api/src/services/aiToolsSoftwarePolicyAudit.test.ts`:
```ts
/**
 * Unit tests for the AI software-policy audit helpers — specifically the
 * autoInstall refusal guard (contract-A D4, #5505 W05) and its greppable
 * audit-summary line.
 */
import { describe, it, expect } from 'vitest';
import {
  AI_AUTO_INSTALL_REFUSAL_MESSAGE,
  remediationOptionsArmsAutoInstall,
  summarizeEnforcementChange,
} from './aiToolsSoftwarePolicyAudit';

describe('remediationOptionsArmsAutoInstall (contract-A D4)', () => {
  it('is true only for a literal { autoInstall: true }', () => {
    expect(remediationOptionsArmsAutoInstall({ autoInstall: true })).toBe(true);
  });

  it('is false when autoInstall is absent', () => {
    expect(remediationOptionsArmsAutoInstall({ autoUninstall: true })).toBe(false);
  });

  it('is false when autoInstall is explicitly false', () => {
    expect(remediationOptionsArmsAutoInstall({ autoInstall: false })).toBe(false);
  });

  it('is false for a truthy non-boolean value (string "true")', () => {
    expect(remediationOptionsArmsAutoInstall({ autoInstall: 'true' })).toBe(false);
  });

  it('is false for null, undefined, arrays, and non-objects', () => {
    expect(remediationOptionsArmsAutoInstall(null)).toBe(false);
    expect(remediationOptionsArmsAutoInstall(undefined)).toBe(false);
    expect(remediationOptionsArmsAutoInstall([{ autoInstall: true }])).toBe(false);
    expect(remediationOptionsArmsAutoInstall('autoInstall')).toBe(false);
    expect(remediationOptionsArmsAutoInstall(42)).toBe(false);
  });

  it('exports a stable, non-empty refusal message naming the required credential', () => {
    expect(AI_AUTO_INSTALL_REFUSAL_MESSAGE).toMatch(/devices\.execute/);
    expect(AI_AUTO_INSTALL_REFUSAL_MESSAGE).toMatch(/MFA/);
  });
});

describe('summarizeEnforcementChange — autoInstall is greppable (contract-A D4)', () => {
  it('surfaces autoInstall:true at the top level, not just buried in remediationOptions', () => {
    const summary = summarizeEnforcementChange({ remediationOptions: { autoInstall: true } });
    expect(summary.autoInstall).toBe(true);
  });

  it('surfaces autoInstall:false when remediationOptions is present without it', () => {
    const summary = summarizeEnforcementChange({ remediationOptions: { autoUninstall: true } });
    expect(summary.autoInstall).toBe(false);
  });

  it('omits autoInstall entirely when remediationOptions is absent', () => {
    const summary = summarizeEnforcementChange({ enforceMode: true });
    expect(summary).not.toHaveProperty('autoInstall');
  });

  it('still reports autoUninstall unchanged (regression — this wave adds a verb, not replaces one)', () => {
    const summary = summarizeEnforcementChange({ remediationOptions: { autoUninstall: true, autoInstall: false } });
    expect(summary.autoUninstall).toBe(true);
    expect(summary.autoInstall).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/api && npx vitest run src/services/aiToolsSoftwarePolicyAudit.test.ts`
Expected: FAIL — `AI_AUTO_INSTALL_REFUSAL_MESSAGE` and `remediationOptionsArmsAutoInstall` are not exported by the module yet (import error / undefined).

- [ ] **Step 3: Add the helper and message, and extend the summary function**

In `apps/api/src/services/aiToolsSoftwarePolicyAudit.ts`, add after the imports (before `export type SoftwarePolicyToolAuditEntry`):
```ts
/**
 * Contract-A D4 (`contract-A-desired-state.md`, locked 2026-09-10, #5505 W05):
 * the AI agent may never arm `remediationOptions.autoInstall`. Both AI
 * invocation paths let a call reach a handler with this key present and
 * untouched — `aiToolSchemas.ts`'s `remediationOptions` Zod schema is
 * non-strict (unknown keys don't fail `safeParse`, and `validateToolInput`
 * discards the parsed/stripped value anyway — see `aiTools.ts:522-540`), and
 * the SDK path (`aiAgentSdkTools.ts:2251`) types the whole object as an
 * untyped `z.record` before delegating to the same `executeTool()`. Schema
 * typing cannot hold this line, so the four handler write sites that can set
 * `remediationOptions` (`aiToolsCompliance.ts` create/update,
 * `aiToolsPolicyPrereqs.ts` create/update) call
 * `remediationOptionsArmsAutoInstall` before touching the database and
 * refuse with this exact message rather than silently dropping the field.
 */
export const AI_AUTO_INSTALL_REFUSAL_MESSAGE =
  'Arming autoInstall requires a human operator with devices.execute and MFA; the AI agent cannot arm software installation.';

/**
 * True only for a literal `{ autoInstall: true }` — mirrors the strict
 * `=== true` check `readSoftwarePolicyAutoUninstall` uses for the sibling
 * verb (`softwarePolicyService.ts:172-175`), so a truthy-but-not-boolean
 * value (e.g. the string `"true"`) does not count as an arm attempt.
 */
export function remediationOptionsArmsAutoInstall(remediationOptions: unknown): boolean {
  if (!remediationOptions || typeof remediationOptions !== 'object' || Array.isArray(remediationOptions)) {
    return false;
  }
  return (remediationOptions as Record<string, unknown>).autoInstall === true;
}
```

Then change `summarizeEnforcementChange` from:
```ts
export function summarizeEnforcementChange(input: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  if (typeof input.enforceMode === 'boolean') summary.enforceMode = input.enforceMode;
  if (input.remediationOptions && typeof input.remediationOptions === 'object') {
    summary.remediationOptions = input.remediationOptions;
    summary.autoUninstall = (input.remediationOptions as Record<string, unknown>).autoUninstall === true;
  }
  return summary;
}
```
to:
```ts
export function summarizeEnforcementChange(input: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  if (typeof input.enforceMode === 'boolean') summary.enforceMode = input.enforceMode;
  if (input.remediationOptions && typeof input.remediationOptions === 'object') {
    summary.remediationOptions = input.remediationOptions;
    summary.autoUninstall = (input.remediationOptions as Record<string, unknown>).autoUninstall === true;
    summary.autoInstall = (input.remediationOptions as Record<string, unknown>).autoInstall === true;
  }
  return summary;
}
```

- [ ] **Step 4: Run the test again and confirm it passes**

Run: `cd apps/api && npx vitest run src/services/aiToolsSoftwarePolicyAudit.test.ts`
Expected: PASS (all 10 assertions).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiToolsSoftwarePolicyAudit.ts apps/api/src/services/aiToolsSoftwarePolicyAudit.test.ts
git commit -m "$(cat <<'EOF'
feat(ai): add autoInstall refusal guard to the software-policy audit module (#5505 W05)

Shared helper + exported message so all four AI write sites that can set
remediationOptions refuse an autoInstall:true attempt identically, and
summarizeEnforcementChange surfaces autoInstall in the audit trail.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ANjBwca2cfsLWDLJro3fkz
EOF
)"
```

---

## Task 2: Wire the refusal into `aiToolsCompliance.ts` (`manage_software_policy`)

**Files:**
- Modify: `apps/api/src/services/aiToolsCompliance.ts:27-31` (import), `:274-278` (create), `:341-345` (update), `:203` (schema description)
- Modify: `apps/api/src/services/aiToolsCompliance.siteScope.test.ts:21-24` (mock fix — required, see Ground Truth §0.6)
- Test: `apps/api/src/services/aiToolsCompliance.autoInstallGuardrail.test.ts`

**Interfaces:**
- Consumes: `AI_AUTO_INSTALL_REFUSAL_MESSAGE`, `remediationOptionsArmsAutoInstall` from `./aiToolsSoftwarePolicyAudit` (Task 1).
- Produces: nothing new (behavioural change only).

- [ ] **Step 1: Write the failing test file**

Create `apps/api/src/services/aiToolsCompliance.autoInstallGuardrail.test.ts`:
```ts
/**
 * Contract-A D4 (#5505 W05): the AI may never arm
 * `remediationOptions.autoInstall` via `manage_software_policy`
 * (aiToolsCompliance.ts). An `autoInstall: true` reaching either write site
 * must be REFUSED outright, not silently stripped.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn() },
}));
vi.mock('../jobs/softwareComplianceWorker', () => ({ scheduleSoftwareComplianceCheck: vi.fn(async () => 'job-1') }));
vi.mock('../jobs/softwareRemediationWorker', () => ({ scheduleSoftwareRemediation: vi.fn(async () => 1) }));
vi.mock('./softwarePolicyService', async (orig) => {
  const actual = await orig<typeof import('./softwarePolicyService')>();
  return {
    ...actual,
    normalizeSoftwarePolicyRules: vi.fn((r: any) => ({
      software: Array.isArray(r?.software) ? r.software : [],
      allowUnknown: r?.allowUnknown === true,
    })),
    recordSoftwarePolicyAudit: vi.fn(async () => {}),
  };
});
vi.mock('./auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  requestLikeFromSnapshot: vi.fn(() => ({ req: { header: () => undefined } })),
}));

import { db } from '../db';
import { registerComplianceTools } from './aiToolsCompliance';
import { AI_AUTO_INSTALL_REFUSAL_MESSAGE } from './aiToolsSoftwarePolicyAudit';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

const USER_ID = 'user-1';
const ORG_ID = 'org-1';
const POLICY_ID = 'pol-1';

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerComplianceTools(reg);
  return reg.get(name)!.handler;
}

function makeAuth(): AuthContext {
  return {
    user: { id: USER_ID, email: 'ai@example.com', name: 'AI', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId: ORG_ID,
    scope: 'organization',
    accessibleOrgIds: [ORG_ID],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
  } as unknown as AuthContext;
}

function chain(result: unknown): any {
  const p: any = Promise.resolve(result);
  for (const m of ['from', 'where', 'orderBy', 'limit', 'set', 'values', 'returning']) {
    p[m] = () => p;
  }
  return p;
}

function policyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: POLICY_ID,
    orgId: ORG_ID,
    partnerId: null,
    name: 'Allowlist policy',
    mode: 'allowlist',
    enforceMode: false,
    remediationOptions: null,
    isActive: true,
    rules: { software: [{ name: 'Foo' }], allowUnknown: false },
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('manage_software_policy create — autoInstall refusal (contract-A D4)', () => {
  it('refuses { autoInstall: true } with the exact contract message and writes nothing', async () => {
    const result = JSON.parse(await handlerFor('manage_software_policy')({
      action: 'create',
      name: 'Armed policy',
      mode: 'allowlist',
      software: [{ name: 'Foo' }],
      enforceMode: true,
      remediationOptions: { autoInstall: true },
    }, makeAuth()));

    expect(result.error).toBe(AI_AUTO_INSTALL_REFUSAL_MESSAGE);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('still allows autoUninstall arming (unrelated, unchanged verb) when autoInstall is absent', async () => {
    mockDb.insert.mockImplementation(() =>
      chain([policyRow({ enforceMode: true, remediationOptions: { autoUninstall: true } })]));

    const result = JSON.parse(await handlerFor('manage_software_policy')({
      action: 'create',
      name: 'Armed for uninstall',
      mode: 'allowlist',
      software: [{ name: 'Foo' }],
      enforceMode: true,
      remediationOptions: { autoUninstall: true },
    }, makeAuth()));

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
  });

  it('allows autoInstall: false (an explicit opt-out is not an arm attempt)', async () => {
    mockDb.insert.mockImplementation(() => chain([policyRow({ remediationOptions: { autoInstall: false } })]));

    const result = JSON.parse(await handlerFor('manage_software_policy')({
      action: 'create',
      name: 'Not armed',
      mode: 'allowlist',
      software: [{ name: 'Foo' }],
      remediationOptions: { autoInstall: false },
    }, makeAuth()));

    expect(result.error).toBeUndefined();
  });
});

describe('manage_software_policy update — autoInstall refusal (contract-A D4)', () => {
  it('refuses { autoInstall: true } on an existing policy and writes nothing', async () => {
    mockDb.select.mockImplementation(() => chain([policyRow()]));

    const result = JSON.parse(await handlerFor('manage_software_policy')({
      action: 'update',
      policyId: POLICY_ID,
      remediationOptions: { autoInstall: true },
    }, makeAuth()));

    expect(result.error).toBe(AI_AUTO_INSTALL_REFUSAL_MESSAGE);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('refuses regardless of the policy\'s current enforcement state (this is a write-time refusal, not an arming check)', async () => {
    mockDb.select.mockImplementation(() => chain([policyRow({ mode: 'audit', enforceMode: false })]));

    const result = JSON.parse(await handlerFor('manage_software_policy')({
      action: 'update',
      policyId: POLICY_ID,
      remediationOptions: { autoInstall: true },
    }, makeAuth()));

    expect(result.error).toBe(AI_AUTO_INSTALL_REFUSAL_MESSAGE);
    expect(mockDb.update).not.toHaveBeenCalled();
  });
});

describe('manage_software_policy get — reads are never gated (decision: AI may read armed state, never write it)', () => {
  it('returns a policy whose autoInstall is already armed (by a human, via HTTP) without refusing', async () => {
    mockDb.select.mockImplementation(() =>
      chain([policyRow({ enforceMode: true, remediationOptions: { autoInstall: true } })]));

    const result = JSON.parse(await handlerFor('manage_software_policy')({
      action: 'get',
      policyId: POLICY_ID,
    }, makeAuth()));

    expect(result.error).toBeUndefined();
    expect(result.policy.remediationOptions.autoInstall).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and confirm the refusal tests fail**

Run: `cd apps/api && npx vitest run src/services/aiToolsCompliance.autoInstallGuardrail.test.ts`
Expected: FAIL — the two refusal tests get `result.error === undefined` (or a DB-mock error) instead of the refusal message, because nothing refuses `autoInstall` yet. The "still allows autoUninstall" and "get" tests may already pass; that's fine, they document current behavior that must not regress.

- [ ] **Step 3: Wire the guard into the create and update write sites**

In `apps/api/src/services/aiToolsCompliance.ts`, change the import block (lines 27-31) from:
```ts
import {
  auditSoftwarePolicyToolEvent,
  summarizeEnforcementChange,
} from './aiToolsSoftwarePolicyAudit';
```
to:
```ts
import {
  auditSoftwarePolicyToolEvent,
  summarizeEnforcementChange,
  AI_AUTO_INSTALL_REFUSAL_MESSAGE,
  remediationOptionsArmsAutoInstall,
} from './aiToolsSoftwarePolicyAudit';
```

In the `create` branch, change (around line 274-278):
```ts
      if (rules.software.length === 0) {
        return JSON.stringify({ error: 'At least one software rule is required' });
      }

      const [policy] = await db
        .insert(softwarePolicies)
```
to:
```ts
      if (rules.software.length === 0) {
        return JSON.stringify({ error: 'At least one software rule is required' });
      }

      // Contract-A D4 (#5505 W05): the AI may never arm autoInstall. Refused
      // outright — never silently stripped — because the input schema cannot
      // hold this line (see aiToolsSoftwarePolicyAudit.ts).
      if (remediationOptionsArmsAutoInstall(input.remediationOptions)) {
        return JSON.stringify({ error: AI_AUTO_INSTALL_REFUSAL_MESSAGE });
      }

      const [policy] = await db
        .insert(softwarePolicies)
```

In the `update` branch, change (around line 339-345):
```ts
      if (existing.orgId === null && !canManagePartnerWidePolicies(auth)) {
        return JSON.stringify({ error: 'Modifying a partner-wide software policy requires full partner org access (orgAccess must be "all")' });
      }

      const updates: Omit<Partial<typeof softwarePolicies.$inferInsert>, 'approvalGeneration'> & { approvalGeneration?: SQL } = {
```
to:
```ts
      if (existing.orgId === null && !canManagePartnerWidePolicies(auth)) {
        return JSON.stringify({ error: 'Modifying a partner-wide software policy requires full partner org access (orgAccess must be "all")' });
      }

      // Contract-A D4 (#5505 W05): the AI may never arm autoInstall, on
      // create OR on an already-armed policy's update.
      if (remediationOptionsArmsAutoInstall(input.remediationOptions)) {
        return JSON.stringify({ error: AI_AUTO_INSTALL_REFUSAL_MESSAGE });
      }

      const updates: Omit<Partial<typeof softwarePolicies.$inferInsert>, 'approvalGeneration'> & { approvalGeneration?: SQL } = {
```

Also update the schema description at line 203 from:
```ts
        remediationOptions: { type: 'object', description: 'Remediation behavior options' },
```
to:
```ts
        remediationOptions: { type: 'object', description: 'Remediation behavior options: { autoUninstall?: boolean, notifyUser?: boolean, gracePeriod?: number, cooldownMinutes?: number, maintenanceWindowOnly?: boolean }. autoInstall is NOT settable here — arming software installation requires a human operator with devices.execute and MFA.' },
```

- [ ] **Step 4: Run the new test file again and confirm it passes**

Run: `cd apps/api && npx vitest run src/services/aiToolsCompliance.autoInstallGuardrail.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 5: Fix the sibling suite that fully mocks the module (required — see Ground Truth §0.6)**

In `apps/api/src/services/aiToolsCompliance.siteScope.test.ts`, change (lines 21-24):
```ts
vi.mock('./aiToolsSoftwarePolicyAudit', () => ({
  auditSoftwarePolicyToolEvent: vi.fn(),
  summarizeEnforcementChange: vi.fn(() => ({})),
}));
```
to:
```ts
vi.mock('./aiToolsSoftwarePolicyAudit', () => ({
  auditSoftwarePolicyToolEvent: vi.fn(),
  summarizeEnforcementChange: vi.fn(() => ({})),
  remediationOptionsArmsAutoInstall: vi.fn(() => false),
  AI_AUTO_INSTALL_REFUSAL_MESSAGE: 'AI_AUTO_INSTALL_REFUSAL_MESSAGE (mocked)',
}));
```

- [ ] **Step 6: Run the full affected set and confirm no regression**

Run:
```bash
cd apps/api && npx vitest run \
  src/services/aiToolsCompliance.autoInstallGuardrail.test.ts \
  src/services/aiToolsCompliance.siteScope.test.ts \
  src/services/aiToolsCompliance.auditAndArming.test.ts
```
Expected: PASS — all three files green. (`aiToolsCompliance.auditAndArming.test.ts` uses the real, unmocked module — see Ground Truth §0.6 — so it directly proves `autoUninstall` arming and audit behavior are unchanged.)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/aiToolsCompliance.ts \
  apps/api/src/services/aiToolsCompliance.autoInstallGuardrail.test.ts \
  apps/api/src/services/aiToolsCompliance.siteScope.test.ts
git commit -m "$(cat <<'EOF'
fix(ai): refuse autoInstall arming in manage_software_policy create/update (#5505 W05)

Both AI write sites in aiToolsCompliance.ts now refuse remediationOptions
.autoInstall:true outright instead of silently accepting it (contract-A D4).
Reads (get/list) are untouched — the AI may still see an already-armed
policy, it just can never arm one itself.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ANjBwca2cfsLWDLJro3fkz
EOF
)"
```

---

## Task 3: Wire the refusal into `aiToolsPolicyPrereqs.ts` (`manage_software_policies`)

**Files:**
- Modify: `apps/api/src/services/aiToolsPolicyPrereqs.ts:27-30` (import), `:430-433` (create), `:481-485` (update), `:362` (schema description)
- Modify: `apps/api/src/services/aiToolsPolicyPrereqs.siteScope.test.ts:29-32`, `apps/api/src/services/aiToolsPolicyPrereqs.test.ts:47-50`, `apps/api/src/services/aiToolsPolicyPrereqs.updateRings.test.ts:39-42` (mock fixes — required, see Ground Truth §0.6)
- Test: `apps/api/src/services/aiToolsPolicyPrereqs.autoInstallGuardrail.test.ts`

**Interfaces:**
- Consumes: `AI_AUTO_INSTALL_REFUSAL_MESSAGE`, `remediationOptionsArmsAutoInstall` from `./aiToolsSoftwarePolicyAudit` (Task 1).
- Produces: nothing new (behavioural change only).

- [ ] **Step 1: Write the failing test file**

Create `apps/api/src/services/aiToolsPolicyPrereqs.autoInstallGuardrail.test.ts`:
```ts
/**
 * Contract-A D4 (#5505 W05): the AI may never arm
 * `remediationOptions.autoInstall` via `manage_software_policies`
 * (aiToolsPolicyPrereqs.ts). Refused outright at both write sites, never
 * silently stripped.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { insertMock, updateMock, selectMock, recordPolicyAuditMock, writeAuditEventMock } = vi.hoisted(() => ({
  insertMock: vi.fn(),
  updateMock: vi.fn(),
  selectMock: vi.fn(),
  recordPolicyAuditMock: vi.fn(async () => {}),
  writeAuditEventMock: vi.fn(),
}));

vi.mock('../db', () => ({ db: { insert: insertMock, update: updateMock, select: selectMock } }));
vi.mock('../db/schema/patches', () => ({ patchPolicies: {} }));
vi.mock('../db/schema/softwarePolicies', () => ({ softwarePolicies: {} }));
vi.mock('../db/schema/peripheralControl', () => ({ peripheralPolicies: {} }));
vi.mock('../db/schema/backup', () => ({ backupConfigs: {}, backupProfiles: {} }));
vi.mock('../db/schema/configurationPolicies', () => ({ configPolicyBackupSettings: {} }));
vi.mock('../jobs/peripheralJobs', () => ({
  resolvePeripheralPolicyDeviceIds: vi.fn(async () => []),
  schedulePeripheralPolicyDevices: vi.fn(async () => undefined),
}));
vi.mock('./softwarePolicyService', () => ({ recordSoftwarePolicyAudit: recordPolicyAuditMock }));
vi.mock('./auditEvents', () => ({
  writeAuditEvent: writeAuditEventMock,
  requestLikeFromSnapshot: vi.fn(() => ({ req: { header: () => undefined } })),
}));

import { registerPolicyPrereqTools } from './aiToolsPolicyPrereqs';
import { AI_AUTO_INSTALL_REFUSAL_MESSAGE } from './aiToolsSoftwarePolicyAudit';

const PARTNER_ID = '00000000-0000-0000-0000-000000000001';
const ORG_ID = '33333333-3333-3333-3333-333333333333';
const POLICY_ID = '55555555-5555-5555-5555-555555555555';
const USER_ID = 'user-1';

function makeOrgAuth() {
  return {
    user: { id: USER_ID, email: 'ai@example.com', name: 'AI' },
    scope: 'organization',
    partnerId: PARTNER_ID,
    orgId: ORG_ID,
    accessibleOrgIds: [ORG_ID],
    canAccessOrg: () => true,
    orgCondition: () => undefined,
  } as any;
}

function tool() {
  const tools = new Map<string, any>();
  registerPolicyPrereqTools(tools);
  return tools.get('manage_software_policies');
}

function mockInsertReturns(row: unknown) {
  const returning = vi.fn(async () => [row]);
  const values = vi.fn(() => ({ returning }));
  insertMock.mockReturnValue({ values });
}

function mockUpdate() {
  const where = vi.fn(async () => undefined);
  const set = vi.fn((_payload: Record<string, unknown>) => ({ where }));
  updateMock.mockReturnValue({ set });
  return { set, where };
}

function mockSelectReturns(rows: unknown[]) {
  selectMock.mockReturnValue({
    from: () => ({ where: () => ({ limit: async () => rows }) }),
  });
}

beforeEach(() => {
  insertMock.mockReset();
  updateMock.mockReset();
  selectMock.mockReset();
  recordPolicyAuditMock.mockClear();
  writeAuditEventMock.mockClear();
});

describe('manage_software_policies create — autoInstall refusal (contract-A D4)', () => {
  it('refuses { autoInstall: true } with the exact contract message and writes nothing', async () => {
    const out = JSON.parse(await tool().handler({
      action: 'create',
      name: 'Armed policy',
      mode: 'allowlist',
      enforceMode: true,
      remediationOptions: { autoInstall: true },
    }, makeOrgAuth()));

    expect(out.error).toBe(AI_AUTO_INSTALL_REFUSAL_MESSAGE);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('still allows autoUninstall arming (unrelated, unchanged verb) when autoInstall is absent', async () => {
    mockInsertReturns({ id: POLICY_ID, name: 'Armed for uninstall', orgId: ORG_ID, partnerId: null, mode: 'allowlist' });

    const out = JSON.parse(await tool().handler({
      action: 'create',
      name: 'Armed for uninstall',
      mode: 'allowlist',
      enforceMode: true,
      remediationOptions: { autoUninstall: true },
    }, makeOrgAuth()));

    expect(out.error).toBeUndefined();
    expect(out.success).toBe(true);
  });
});

describe('manage_software_policies update — autoInstall refusal (contract-A D4)', () => {
  it('refuses { autoInstall: true } on an existing policy and writes nothing', async () => {
    mockSelectReturns([{ id: POLICY_ID, name: 'Detect only', orgId: ORG_ID, partnerId: null, mode: 'allowlist' }]);
    mockUpdate();

    const out = JSON.parse(await tool().handler({
      action: 'update',
      policyId: POLICY_ID,
      remediationOptions: { autoInstall: true },
    }, makeOrgAuth()));

    expect(out.error).toBe(AI_AUTO_INSTALL_REFUSAL_MESSAGE);
    expect(updateMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and confirm the refusal tests fail**

Run: `cd apps/api && npx vitest run src/services/aiToolsPolicyPrereqs.autoInstallGuardrail.test.ts`
Expected: FAIL — the two refusal tests get `out.error === undefined` (create/update proceed) instead of the refusal message.

- [ ] **Step 3: Wire the guard into the create and update write sites**

In `apps/api/src/services/aiToolsPolicyPrereqs.ts`, change the import block (lines 27-30) from:
```ts
import {
  auditSoftwarePolicyToolEvent,
  summarizeEnforcementChange,
} from './aiToolsSoftwarePolicyAudit';
```
to:
```ts
import {
  auditSoftwarePolicyToolEvent,
  summarizeEnforcementChange,
  AI_AUTO_INSTALL_REFUSAL_MESSAGE,
  remediationOptionsArmsAutoInstall,
} from './aiToolsSoftwarePolicyAudit';
```

In the `create` branch, change (around line 430-433):
```ts
        if (!input.name) return JSON.stringify({ error: 'name is required' });
        if (!input.mode) return JSON.stringify({ error: 'mode is required (allowlist, blocklist, or audit)' });

        const rows = await db.insert(softwarePolicies).values({
```
to:
```ts
        if (!input.name) return JSON.stringify({ error: 'name is required' });
        if (!input.mode) return JSON.stringify({ error: 'mode is required (allowlist, blocklist, or audit)' });

        // Contract-A D4 (#5505 W05): the AI may never arm autoInstall.
        // Refused outright — never silently stripped.
        if (remediationOptionsArmsAutoInstall(input.remediationOptions)) {
          return JSON.stringify({ error: AI_AUTO_INSTALL_REFUSAL_MESSAGE });
        }

        const rows = await db.insert(softwarePolicies).values({
```

In the `update` branch, change (around line 479-485):
```ts
        if (existing.orgId === null && !canManagePartnerWidePolicies(auth)) {
          return JSON.stringify({ error: 'Modifying a partner-wide software policy requires full partner org access (orgAccess must be "all")' });
        }

        const updates: Record<string, unknown> = {
```
to:
```ts
        if (existing.orgId === null && !canManagePartnerWidePolicies(auth)) {
          return JSON.stringify({ error: 'Modifying a partner-wide software policy requires full partner org access (orgAccess must be "all")' });
        }

        // Contract-A D4 (#5505 W05): the AI may never arm autoInstall, on
        // create OR on an already-armed policy's update.
        if (remediationOptionsArmsAutoInstall(input.remediationOptions)) {
          return JSON.stringify({ error: AI_AUTO_INSTALL_REFUSAL_MESSAGE });
        }

        const updates: Record<string, unknown> = {
```

Also update the schema description at line 362 from:
```ts
          remediationOptions: { type: 'object', description: '{ autoUninstall?: false, notifyUser?: true, gracePeriod?: number, cooldownMinutes?: 30, maintenanceWindowOnly?: false }' },
```
to:
```ts
          remediationOptions: { type: 'object', description: '{ autoUninstall?: false, notifyUser?: true, gracePeriod?: number, cooldownMinutes?: 30, maintenanceWindowOnly?: false }. autoInstall is NOT settable via AI tools — arming software installation requires a human operator with devices.execute and MFA.' },
```

- [ ] **Step 4: Run the new test file again and confirm it passes**

Run: `cd apps/api && npx vitest run src/services/aiToolsPolicyPrereqs.autoInstallGuardrail.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 5: Fix the three sibling suites that fully mock the module (required — see Ground Truth §0.6)**

In each of `apps/api/src/services/aiToolsPolicyPrereqs.siteScope.test.ts` (lines 29-32), `apps/api/src/services/aiToolsPolicyPrereqs.test.ts` (lines 47-50), and `apps/api/src/services/aiToolsPolicyPrereqs.updateRings.test.ts` (lines 39-42), change:
```ts
vi.mock('./aiToolsSoftwarePolicyAudit', () => ({
  auditSoftwarePolicyToolEvent: vi.fn(),
  summarizeEnforcementChange: vi.fn(() => ({})),
}));
```
to:
```ts
vi.mock('./aiToolsSoftwarePolicyAudit', () => ({
  auditSoftwarePolicyToolEvent: vi.fn(),
  summarizeEnforcementChange: vi.fn(() => ({})),
  remediationOptionsArmsAutoInstall: vi.fn(() => false),
  AI_AUTO_INSTALL_REFUSAL_MESSAGE: 'AI_AUTO_INSTALL_REFUSAL_MESSAGE (mocked)',
}));
```
(All three blocks are byte-identical before the edit, so the same replacement applies verbatim to each file.)

- [ ] **Step 6: Run the full affected set and confirm no regression**

Run:
```bash
cd apps/api && npx vitest run \
  src/services/aiToolsPolicyPrereqs.autoInstallGuardrail.test.ts \
  src/services/aiToolsPolicyPrereqs.siteScope.test.ts \
  src/services/aiToolsPolicyPrereqs.test.ts \
  src/services/aiToolsPolicyPrereqs.updateRings.test.ts \
  src/services/aiToolsPolicyPrereqs.softwarePolicyAudit.test.ts
```
Expected: PASS — all five files green. (`aiToolsPolicyPrereqs.softwarePolicyAudit.test.ts` uses the real, unmocked module, directly proving `autoUninstall` arming and audit behavior are unchanged.)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/aiToolsPolicyPrereqs.ts \
  apps/api/src/services/aiToolsPolicyPrereqs.autoInstallGuardrail.test.ts \
  apps/api/src/services/aiToolsPolicyPrereqs.siteScope.test.ts \
  apps/api/src/services/aiToolsPolicyPrereqs.test.ts \
  apps/api/src/services/aiToolsPolicyPrereqs.updateRings.test.ts
git commit -m "$(cat <<'EOF'
fix(ai): refuse autoInstall arming in manage_software_policies create/update (#5505 W05)

Both AI write sites in aiToolsPolicyPrereqs.ts now refuse remediationOptions
.autoInstall:true outright instead of silently accepting it (contract-A D4),
mirroring the same fix in aiToolsCompliance.ts's manage_software_policy.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ANjBwca2cfsLWDLJro3fkz
EOF
)"
```

---

## Task 4: Document the new rule in the guardrail comment block

**Files:**
- Modify: `apps/api/src/services/aiGuardrails.ts:225-227`

**Interfaces:**
- Consumes: nothing (documentation-only change).
- Produces: nothing (no exported symbol changes).

This task changes no logic — `manage_software_policy` and `manage_software_policies` `create`/`update` are already Tier 3 (confirmed in Ground Truth §0.4), and the actual enforcement is the refusal added in Tasks 2-3, not a tier escalation. This step exists because the contract requires the comment block that currently names only `autoUninstall` as the arming pair to also name `autoInstall`, so a future reader of `aiGuardrails.ts` does not have to rediscover this asymmetry from scratch.

- [ ] **Step 1: Confirm the baseline — the existing contract suite is green before this edit**

Run: `cd apps/api && npx vitest run src/services/aiGuardrails.enforcementArming.contract.test.ts`
Expected: PASS (this is a pre-existing suite; this step establishes the baseline this task must not disturb — there is no new assertion to red here, since this task changes no logic that suite exercises).

- [ ] **Step 2: Update the comment block**

In `apps/api/src/services/aiGuardrails.ts`, change (lines 225-227):
```ts
  //   - software policies: `enforceMode` + `remediationOptions.autoUninstall`
  //     turn a detect-only allowlist into fleet-wide auto-uninstall (the #3381
  //     mass-uninstall failure mode).
```
to:
```ts
  //   - software policies: `enforceMode` + `remediationOptions.autoUninstall`
  //     turn a detect-only allowlist into fleet-wide auto-uninstall (the #3381
  //     mass-uninstall failure mode). `remediationOptions.autoInstall` (#5505
  //     desired-state install) is NOT gated the same way as the fields above —
  //     it is never accepted from the AI at all. The four handler write sites
  //     in aiToolsCompliance.ts/aiToolsPolicyPrereqs.ts refuse an
  //     autoInstall:true outright, regardless of tier or approval, because
  //     only a human operator holding devices.execute + MFA may arm software
  //     installation (contract-A D4). Tier-3 approval on this tool remains
  //     for enforceMode/autoUninstall; it is not the mechanism that protects
  //     autoInstall.
```

- [ ] **Step 3: Confirm the contract suite is still green (no functional change)**

Run: `cd apps/api && npx vitest run src/services/aiGuardrails.enforcementArming.contract.test.ts`
Expected: PASS, identical result to Step 1 — this proves the comment-only edit changed no behavior the contract test observes.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/aiGuardrails.ts
git commit -m "$(cat <<'EOF'
docs(ai): document that autoInstall is refused outright, not tier-gated (#5505 W05)

Extends the TIER3_ACTIONS comment block in aiGuardrails.ts, which previously
named only remediationOptions.autoUninstall as the software-policy arming
pair, to explain that autoInstall is never accepted from the AI at all —
a stronger guarantee than Tier-3 approval.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ANjBwca2cfsLWDLJro3fkz
EOF
)"
```

---

## Task 5: Full regression sweep and self-review

**Files:** none (verification only).

**Interfaces:** none.

- [ ] **Step 1: Run every test file this wave touched or could affect, together**

```bash
cd apps/api && npx vitest run \
  src/services/aiToolsSoftwarePolicyAudit.test.ts \
  src/services/aiToolsCompliance.autoInstallGuardrail.test.ts \
  src/services/aiToolsCompliance.siteScope.test.ts \
  src/services/aiToolsCompliance.auditAndArming.test.ts \
  src/services/aiToolsPolicyPrereqs.autoInstallGuardrail.test.ts \
  src/services/aiToolsPolicyPrereqs.siteScope.test.ts \
  src/services/aiToolsPolicyPrereqs.test.ts \
  src/services/aiToolsPolicyPrereqs.updateRings.test.ts \
  src/services/aiToolsPolicyPrereqs.softwarePolicyAudit.test.ts \
  src/services/aiGuardrails.enforcementArming.contract.test.ts \
  src/services/aiGuardrails.test.ts \
  src/services/aiGuardrailsTierConfig.parity.test.ts \
  src/services/aiGuardrailsAiDocs.parity.test.ts \
  src/services/aiGuardrails.readonly.contract.test.ts
```
Expected: PASS across all 14 files. (Note vitest's path-filter is a substring match — these are listed as explicit file paths, one per argument, precisely to avoid the trailing-slash/substring traps documented in CLAUDE.md.)

- [ ] **Step 2: Typecheck the touched files**

Run: `cd apps/api && npx tsc --noEmit -p .`
Expected: no new errors introduced by this wave's changes. (There is no root typecheck script per CLAUDE.md; this runs the API package's own TS config directly.)

- [ ] **Step 3: Self-review against the contract**

Confirm each of the following by inspection (this is a checklist, not a code step):
- [ ] All four write sites (`aiToolsCompliance.ts:287,356-357`; `aiToolsPolicyPrereqs.ts:441,496`) refuse `autoInstall: true` with the exact string `'Arming autoInstall requires a human operator with devices.execute and MFA; the AI agent cannot arm software installation.'` — not four different strings, not a stripped/ignored field.
- [ ] `list`/`get` on both tools are untouched — no new gate, no tier change (verified by the "reads are never gated" test in Task 2 and by `aiGuardrails.enforcementArming.contract.test.ts` staying green in Task 4).
- [ ] `aiToolsCompliance.ts:509` (`remediate_software_violation`'s `evaluateSoftwarePolicyArming` call) was not touched — grep confirms: `git diff main --stat -- apps/api/src/services/aiToolsCompliance.ts` shows only the import block and the two write-site regions changed.
- [ ] No migration file was created; no `apps/api/src/db/schema/*` file was touched; no HTTP route file was touched.
- [ ] `summarizeEnforcementChange` surfaces `autoInstall` at the top level of its return value whenever `remediationOptions` is present (Task 1 test).
- [ ] `aiGuardrails.ts`'s comment block names `autoInstall` alongside `autoUninstall` (Task 4).
- [ ] Every existing test that previously passed for `manage_software_policy` / `manage_software_policies` still passes unchanged (Task 2 Step 6, Task 3 Step 6).

- [ ] **Step 4: Report**

No commit in this task (verification only) — if Steps 1-2 surface any regression, fix it under the task whose file it belongs to and re-run this sweep before considering the wave done.

---

## Self-Review

**1. Spec/contract coverage:**
- D4's core requirement (refuse, don't strip, at all four sites, exact message) → Tasks 2 and 3, all four write sites, each independently tested.
- "W05 also adds an autoInstall line to summarizeEnforcementChange" → Task 1.
- "extends the aiGuardrails.ts:211-245 comment block" → Task 4.
- "AI zod/JSON schemas" ownership → addressed as the two description-string updates in Tasks 2-3 (Step 3 of each); explicitly **not** adding `autoInstall` to the typed Zod schemas themselves, with the reasoning recorded in Ground Truth §0.2 and Decisions below (adding it there would be inert, since neither AI validation path uses its schema's parsed/stripped output).
- "Do not escalate read tools" → verified as a passing regression test in Task 2 and confirmed via the untouched `aiGuardrails.enforcementArming.contract.test.ts` in Task 4.
- "Must NOT touch: everything else" (in particular `aiToolsCompliance.ts:509`) → confirmed in Ground Truth §0.7 and re-checked in Task 5's self-review checklist.

**2. Placeholder scan:** none found — every step above contains complete, real code (no "add validation", no "similar to Task N" without the code, no TBD).

**3. Type consistency:** `AI_AUTO_INSTALL_REFUSAL_MESSAGE` and `remediationOptionsArmsAutoInstall` are defined once (Task 1) and imported with identical names in every consuming file (Tasks 2, 3) and every mock factory (Task 2 Step 5, Task 3 Step 5) — no renaming drift between tasks.

## Decisions this plan made that the contract left open

1. **The refusal happens *before* any audit write, and is itself unaudited.** Matches the existing precedent in both files (see the "does not audit when the create is rejected before any row is written" tests already in `aiToolsCompliance.auditAndArming.test.ts` and `aiToolsPolicyPrereqs.softwarePolicyAudit.test.ts`) — a rejected-before-any-row-exists validation failure is not written to `software_policy_audit`/`audit_logs` today, and this plan treats the autoInstall refusal the same way rather than inventing a new audit action. Inventing one would also require a new `software_policy_audit.action` constant, which is explicitly W01's file (`softwarePolicyService.ts`), not W05's.
2. **`autoInstall` is deliberately NOT added to the AI-facing Zod schemas** (`aiToolSchemas.ts:1120-1126,1647-1653`) or the SDK's `z.record` (`aiAgentSdkTools.ts:2251`). Ground Truth §0.2 proves this would be inert (neither path uses its schema's parsed output), so adding it would only cost a second place D4's message could drift out of sync with the handler-level string. The two JSON-schema *description* strings (documentation, not validation) are updated instead, in Tasks 2-3.
