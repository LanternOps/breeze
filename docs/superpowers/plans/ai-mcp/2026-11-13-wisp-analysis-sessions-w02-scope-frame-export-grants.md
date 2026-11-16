---
spec: docs/superpowers/specs/ai-mcp/2026-11-13-wisp-analysis-sessions-design.md
wave_map: docs/superpowers/plans/ai-mcp/2026-11-13-wisp-analysis-sessions-w00-wave-map-and-contracts.md
---

# Wisp Analysis Sessions W02 — Scope Frame and Frozen Export Grants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An analysis run launched from Wisp covers an explicit device list, one site, or the whole organization, expanded and frozen at admission under the live grant ceiling. The datasets it may export are frozen the same way, and `export_dataset` enforces them.

**Architecture:** Two halves, each placed where its inputs already are.
- **The frame is resolved in admission.** `createAndEnqueueAgentRun` already resolves the live grant ceiling at step 1d (`grantCeiling`, `apps/api/src/services/aiAgents/runService.ts:1356-1386`). The run's limits snapshot is also only there, and step 4d (`:1689-1750`) is where the device set freezes today. W02 replaces that freeze with `resolveAnalysisFrame` (new `services/aiAgents/analysisFrame.ts`), fed by `ceilingSiteIdsForOrg(grantCeiling, orgId)`. The ceiling's site restriction therefore needs no passing: admission reads it from its own resolution of the same pinned grant and revision.
- **Export grants are evaluated in the launcher.** `launchAnalysis` evaluates `EXPORT_DATASET_REQUIREMENTS` (new leaf `services/aiToolsExportPermissions.ts`) against `ctx.ceiling`, the ceiling `coordinator.decide` just resolved and gated on (spec §4.4). It passes the result to admission as trusted internal input (`CreateAgentRunInput.analysis.exportGrants`, the same posture as `grant`/`task`), and admission freezes it verbatim. Evaluated once, before admission, because W03's `deriveChainHandles` filters inherited exports by the same grants in the launcher.

Both paths that reach `launchAnalysis`, the chat `launch_specialist` path and the assessment auto-admit path, carry `ctx.ceiling` and a grant, so they behave the same. The run loop hands `staged_inputs.exportGrants` to tool handlers on `ToolExecutionContext`, next to `runTargets`. `export_dataset` refuses a dataset outside the frozen set, and the `event_logs` security category reads the frozen `security_events` gate.

**Tech Stack:** TypeScript, Hono API, Drizzle (queries only), Zod 4, Vitest. No migration: `staged_inputs` is jsonb and already `excludedOpen` in `tenantExportPolicyRegistry.ts:114`.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-11-13-wisp-analysis-sessions-design.md` §4.3, §4.4 "Permission", §7 "Scope frame" and "Dataset permission". Contracts: W00 C1 (`scope`), C2, C3 (`analysisMaxFrameDevices`), C6 (`EXPORT_DATASET_REQUIREMENTS`, `resolveExportGrants`, `resolveAnalysisFrame`), C7 (`scope_required`, `frame_too_large`, `site_not_in_scope`, `dataset_not_permitted`).

## Global Constraints

- W00 global constraints apply: no new flag (`aiWorkspaceEnabled()` and `wispEnabled()` gate everything); D-B stands; the chat model never supplies an artifact handle; **a run principal has no RBAC role, so no check here evaluates the `ai_agent` principal: authority is frozen at admission from the live grant ceiling**; an empty device set returns nothing and never means unrestricted.
- **Behaviour change (state it in the PR body):** a `launch_specialist` `analysis` call with no `scope`, no `deviceIds` and no `siteId` is now **refused** (`invalid_params`, detail `scope_required`). Until now it admitted a run with `staged_inputs.deviceIds: []` that could read no device data. An assessment's `request_specialist` analysis with no scope is refused the same way at coordinator gate 6.
- C1 schema verbatim: `scope: z.enum(['devices', 'site', 'org']).optional()`, `deviceIds: z.array(z.uuid()).min(1).max(200).optional()` (was `.max(25)`), `siteId: z.uuid().optional()`. Resolution: `scope` omitted + `deviceIds` → `devices`; omitted + only `siteId` → `site`; omitted + neither → `scope_required`. `devices` requires `deviceIds`; `site` requires `siteId`; `org` forbids both.
- C3: `analysisMaxFrameDevices` default **1000**, validator `z.number().int().min(50).max(5000)`, merged with `min` (not in `MAX_MERGED_LIMIT_KEYS`). Every read is `limits.analysisMaxFrameDevices ?? AI_AGENT_LIMIT_DEFAULTS.analysisMaxFrameDevices`. `analysisMaxInputDevicesPerRun` (default 50) keeps applying to `devices` scope only.
- C2: `exportGrants` and `scope` on `AiAgentRunStagedInputs` are optional. **Absent `exportGrants` = legacy:** the original seven datasets are allowed and no sensitive gate is held.
- All seven existing datasets require `devices:read` (every equivalent read tool's `TOOL_PERMISSIONS` entry, `aiGuardrails.ts:1635-2840`). `event_logs` also declares the sensitive gate `security_events` ← `devices:execute`.
- Analysis limits have no settings UI and no locale keys (`grep -rn analysisMax apps/web` is empty). Do not add any; the refusal messages name the limit key.
- After editing any `aiTools*.ts` file, re-run `src/services/aiTools.userOwnedRelease.contract.test.ts` (`SAFE_WRITE_SITES` is line-keyed) and `src/services/aiTools.descriptionBudget.contract.test.ts` (tool descriptions ≤ 300 chars, parameter descriptions ≤ 160).
- New `services/` files that read `devices` must be classified in `src/__tests__/parkedFanout.contract.test.ts`.
- Run one test file with `cd apps/api && npx vitest run <path>`, never `pnpm --filter <pkg> test -- --run <path>`. Shared package: `cd packages/shared && npx vitest run <path>`.
- W00 C7a fixes four decisions this plan follows:
  - the device frame resolves inside admission, and export grants are evaluated in the launcher and passed in as trusted internal input;
  - the policy snapshot goes to 17;
  - decommissioned devices are left out of site and org frames and kept when listed explicitly;
  - `frame_empty` is a C7 code.
- Thread rule (C7a): nothing in W02 reads or checks session ancestry; there is no `resolveSessionAncestry` dependency.
- W01 edits `launchAnalysis` in `specialistLaunchers.ts` in parallel (origin session, replay-lookup fix). Rebase onto whichever lands first and keep both changes.

## Review Focus

1. **Empty frame.** An org or site with zero eligible devices, or a ceiling that narrows the frame to zero, must refuse `frame_empty`. It must never freeze `deviceIds: []`, which `export_dataset` reads as "no frame". Pinned in Task 4.
2. **Legacy run with an empty frozen set.** A run admitted before W02 with `staged_inputs.deviceIds: []` and no `exportGrants` must export nothing from `event_logs`. Today `scopedDeviceIds` (`aiToolsExportDatasets.ts:115-122`) returns `null` (unrestricted) for an auth that carries only `allowedDeviceIds: []` (inferred from the code, not reproduced). Pinned in Task 8.
3. **Frame size boundary.** Exactly `analysisMaxFrameDevices` devices admits; one more refuses `frame_too_large`; the query never loads more than `max + 1` ids. Pinned in Task 4.
4. **Contradictory params.** `scope: 'org'` with `siteId`, or `devices` with `siteId`, must be refused with a readable detail. It must not silently drop `siteId`. Pinned in Task 6.
5. **Snapshots and runs from before W02.** A policy snapshot without `analysisMaxFrameDevices` gets 1000. A queued run whose `staged_inputs` has no `scope`/`exportGrants` still renders its prompt and exports under legacy grants. Pinned in Tasks 5, 7 and 9.

---

### Task 1: `analysisMaxFrameDevices` limit and snapshot v17

**Files:**
- Modify: `packages/shared/src/types/aiAgents.ts:210-232` (interface), `:353-367` (defaults), `:700-754` (version docstring, constant, `schemaVersion` union)
- Modify: `packages/shared/src/validators/aiAgents.ts:98-112`
- Test: `packages/shared/src/types/aiAgents.test.ts`, `packages/shared/src/validators/aiAgents.test.ts`, `packages/shared/src/validators/remediationResearch.test.ts:15`, `apps/api/src/__tests__/integration/aiAgentEffectivePolicy.integration.test.ts` (reads the constant; no edit expected)

**Interfaces:**
- Produces: `AiAgentLimits.analysisMaxFrameDevices: number`; `AI_AGENT_LIMIT_DEFAULTS.analysisMaxFrameDevices === 1000`; `AI_AGENT_POLICY_SNAPSHOT_VERSION === 17`; `AiAgentPolicySnapshot['schemaVersion']` includes `17`. W03 bumps again (18) for its three chain limits.

- [ ] **Step 1: Write the failing tests**

In `packages/shared/src/types/aiAgents.test.ts`, inside `describe('analysis profile limits (execution plane W04, spec §5.4)')`:

```ts
it('W02 analysis sessions: the frame cap defaults to 1000 and the snapshot is v17', () => {
  expect(AI_AGENT_LIMIT_DEFAULTS.analysisMaxFrameDevices).toBe(1000);
  expect(AI_AGENT_POLICY_SNAPSHOT_VERSION).toBe(17);
});
```

In `packages/shared/src/validators/aiAgents.test.ts`, inside `describe('analysis limits bounds ...')`:

```ts
it.each([[49, false], [50, true], [1000, true], [5000, true], [5001, false], [1.5, false]] as const)(
  'analysisMaxFrameDevices %s → %s', (value, ok) => {
    expect(aiAgentLimitsPatchSchema.safeParse({ analysisMaxFrameDevices: value }).success).toBe(ok);
  });
it('a stored policy without analysisMaxFrameDevices parses to the default', () => {
  const { analysisMaxFrameDevices: _omit, ...rest } = AI_AGENT_LIMIT_DEFAULTS;
  expect(aiAgentLimitsSchema.parse(rest).analysisMaxFrameDevices).toBe(1000);
});
```

Change every existing `expect(AI_AGENT_POLICY_SNAPSHOT_VERSION).toBe(16)` to `17` (validators test lines 166, 486, 500, 518, 558; types test line 16; remediationResearch test line 15).

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/shared && npx vitest run src/types/aiAgents.test.ts src/validators/aiAgents.test.ts src/validators/remediationResearch.test.ts`
Expected: FAIL. `analysisMaxFrameDevices` is `undefined`; the version is still 16.

- [ ] **Step 3: Implement**

Add `analysisMaxFrameDevices: number` after `analysisMaxStepsPerRun`, with a docstring: device cap on a `site`/`org` frame expanded at admission; `devices` scope stays under `analysisMaxInputDevicesPerRun`; snapshot v17. Default `1000`. Validator `z.number().int().min(50).max(5000)`. Bump `AI_AGENT_POLICY_SNAPSHOT_VERSION` to `17 as const`, add `17` to the `schemaVersion` union, extend its doc comment ("… 16 (pre-frame-limit), or 17 (current)"), and add a `v17` paragraph in the same "same rule as every prior bump" form as v16.

- [ ] **Step 4: Run to verify pass**

Run the Step 2 command. Expected: PASS. Then `cd packages/shared && npx tsc --noEmit; echo "tsc exit $?"`. Expected: `tsc exit 0`.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/aiAgents.ts packages/shared/src/types/aiAgents.test.ts packages/shared/src/validators/aiAgents.ts packages/shared/src/validators/aiAgents.test.ts packages/shared/src/validators/remediationResearch.test.ts
git commit -m "feat(shared): analysisMaxFrameDevices limit (default 1000), policy snapshot v17"
```

---

### Task 2: Frozen-input types and the export permission leaf

**Files:**
- Modify: `apps/api/src/db/schema/aiAgents.ts:301-305`
- Create: `apps/api/src/services/aiToolsExportPermissions.ts`
- Test: `apps/api/src/services/aiToolsExportPermissions.test.ts` (new), `apps/api/src/services/aiToolsExportDatasets.test.ts` (key-equality pin)

**Interfaces:**
- Produces (in `db/schema/aiAgents.ts`, C2 verbatim):
  ```ts
  export type AnalysisScopeKind = 'devices' | 'site' | 'org';
  export type AnalysisSensitiveGate = 'security_events' | 'user_account_changes';
  export interface AiRunExportGrants { datasets: string[]; sensitiveGates: AnalysisSensitiveGate[] }
  export interface AiAgentRunStagedInputs {
    handles: string[]; deviceIds: string[]; region: 'eu' | 'us';
    scope?: { kind: AnalysisScopeKind; siteId: string | null; deviceCount: number };
    exportGrants?: AiRunExportGrants;
  }
  ```
- Produces (in `aiToolsExportPermissions.ts`). **Zero runtime imports.** It has exactly two imports, both `import type` and erased at compile time:
  - `import type { ExportDataset } from './aiToolsExportDatasets'`. That is where the type lives today (`aiToolsExportDatasets.ts:62-66`). Because the import is type-only, it cannot close the `aiToolSchemas → aiTools → aiToolsExport → aiToolsExportDatasets` load cycle that W04's leaf exists to break. W04 repoints this import to `./aiToolsExportDatasetNames`.
  - `import type { AnalysisSensitiveGate, AiRunExportGrants } from '../db/schema/aiAgents'`.

  A source-text test (Step 1) pins this.
  - `export interface ExportPermission { resource: string; action: string }`
  - `export interface ExportDatasetRequirement { permission: ExportPermission; sensitiveGate?: { gate: AnalysisSensitiveGate; permission: ExportPermission } }`
  - `export const EXPORT_DATASET_REQUIREMENTS: Readonly<Record<ExportDataset, ExportDatasetRequirement>>`
  - `export const LEGACY_EXPORT_GRANTS: Readonly<AiRunExportGrants>`. The ORIGINAL SEVEN datasets written out as a literal array, **never derived from `EXPORT_DATASETS` or from the record's keys** (both grow in W04/W05), with `sensitiveGates: []`. W04/W05 must not change it: a run admitted before W02 must never gain a new dataset.
  - `export function resolveExportGrants(has: (resource: string, action: string) => boolean): AiRunExportGrants`
  - `export function withheldSensitiveGates(datasets: readonly string[], grants: AiRunExportGrants): AnalysisSensitiveGate[]`. The gates declared by those datasets that `grants` does not hold, deduplicated and sorted.

- [ ] **Step 1: Write the failing tests**

`aiToolsExportPermissions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXPORT_DATASET_REQUIREMENTS, LEGACY_EXPORT_GRANTS, resolveExportGrants, withheldSensitiveGates } from './aiToolsExportPermissions';

const SEVEN = ['event_logs', 'agent_logs', 'device_inventory', 'software_inventory', 'metrics', 'vulnerabilities', 'custom_fields'];

describe('EXPORT_DATASET_REQUIREMENTS', () => {
  it('every existing dataset needs devices:read; event_logs gates security rows on devices:execute', () => {
    for (const d of SEVEN) expect(EXPORT_DATASET_REQUIREMENTS[d as keyof typeof EXPORT_DATASET_REQUIREMENTS].permission).toEqual({ resource: 'devices', action: 'read' });
    expect(EXPORT_DATASET_REQUIREMENTS.event_logs.sensitiveGate).toEqual({ gate: 'security_events', permission: { resource: 'devices', action: 'execute' } });
    expect(SEVEN.filter((d) => d !== 'event_logs').every((d) => !EXPORT_DATASET_REQUIREMENTS[d as 'agent_logs'].sensitiveGate)).toBe(true);
  });
  it('legacy grants are the ORIGINAL SEVEN as a literal, with no gate (they must not grow when W04/W05 add datasets)', () => {
    expect(LEGACY_EXPORT_GRANTS).toEqual({ datasets: SEVEN, sensitiveGates: [] });
  });
  it('is a zero-runtime-import leaf: every import is `import type`', () => {
    const src = readFileSync(join(import.meta.dirname, 'aiToolsExportPermissions.ts'), 'utf8');
    const imports = src.split('\n').filter((l) => /^import\s/.test(l));
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((l) => l.startsWith('import type '))).toBe(true);
  });
});

describe('resolveExportGrants', () => {
  it('a ceiling holding devices:read and devices:execute gets every dataset and the security gate', () => {
    expect(resolveExportGrants(() => true)).toEqual({ datasets: SEVEN, sensitiveGates: ['security_events'] });
  });
  it('devices:read without devices:execute: every dataset, no gate', () => {
    expect(resolveExportGrants((r, a) => r === 'devices' && a === 'read')).toEqual({ datasets: SEVEN, sensitiveGates: [] });
  });
  it('a ceiling without devices:read gets nothing, and holds no gate for a dataset it cannot export', () => {
    expect(resolveExportGrants((r, a) => r === 'devices' && a === 'execute')).toEqual({ datasets: [], sensitiveGates: [] });
  });
});

describe('withheldSensitiveGates', () => {
  it('names a gate a permitted dataset declares and the grants lack', () => {
    expect(withheldSensitiveGates(['event_logs'], { datasets: SEVEN, sensitiveGates: [] })).toEqual(['security_events']);
    expect(withheldSensitiveGates(['event_logs'], { datasets: SEVEN, sensitiveGates: ['security_events'] })).toEqual([]);
    expect(withheldSensitiveGates(['metrics'], LEGACY_EXPORT_GRANTS)).toEqual([]);
  });
});
```

In `aiToolsExportDatasets.test.ts`, add (this file already has the mocks that let `EXPORT_DATASETS` load):

```ts
it('EXPORT_DATASET_REQUIREMENTS has exactly one entry per EXPORT_DATASETS member', async () => {
  const { EXPORT_DATASET_REQUIREMENTS } = await import('./aiToolsExportPermissions');
  expect(Object.keys(EXPORT_DATASET_REQUIREMENTS).sort()).toEqual([...EXPORT_DATASETS].sort());
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/aiToolsExportPermissions.test.ts src/services/aiToolsExportDatasets.test.ts`
Expected: FAIL. `Failed to resolve import "./aiToolsExportPermissions"`.

- [ ] **Step 3: Implement**

Add the types to `db/schema/aiAgents.ts`. In `resolveExportGrants`, a dataset is granted when `has(permission)`. A gate is held when at least one granted dataset declares it and `has(gate.permission)`. `datasets` keeps `EXPORT_DATASETS` declaration order (iterate the record's keys, which follow it); `sensitiveGates` is deduplicated and sorted. The module has no runtime imports. A file-header comment says why: the chat gate, the prompt and the handler all load it, and a run principal has no role, so these are human permissions evaluated against the grant ceiling at admission.

- [ ] **Step 4: Run to verify pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/schema/aiAgents.ts apps/api/src/services/aiToolsExportPermissions.ts apps/api/src/services/aiToolsExportPermissions.test.ts apps/api/src/services/aiToolsExportDatasets.test.ts
git commit -m "feat(api): export dataset permission requirements and frozen-input types (W02)"
```

---

### Task 3: Ceiling helpers: site allowlist for an org, permission held

**Files:**
- Modify: `apps/api/src/services/wisp/grantAuthority.ts` (after `assertReadWithinCeiling`, ~line 227)
- Test: `apps/api/src/services/wisp/grantAuthority.test.ts` (reuse its `ceiling()` factory, line 70)

**Interfaces:**
- Produces:
  - `export function ceilingSiteIdsForOrg(ceiling: Pick<GrantCeiling, 'siteIds' | 'orgTerms'>, orgId: string): string[] | null`. Returns `ceiling.siteIds ∩ orgTerms.get(orgId)?.siteIds`, `null` = unrestricted, sorted. Reuses the private `intersectSiteAllowlists` (line 408).
  - `export function ceilingHoldsPermission(ceiling: GrantCeiling, orgId: string, resource: string, action: string): boolean`. Wraps `assertWithinCeiling(ceiling, { orgId, permission: `${resource}:${action}` })`. Returns `false` on `CeilingViolationError` and rethrows anything else. It goes through the single comparator, so a paused ceiling, an org outside the ceiling and a site-restricted ceiling all answer `false` (fail closed).

- [ ] **Step 1: Write the failing tests**

```ts
describe('ceilingSiteIdsForOrg / ceilingHoldsPermission (W02 analysis frame)', () => {
  it('null when neither the ceiling nor the org term restricts sites', () => {
    expect(ceilingSiteIdsForOrg(ceiling(), ORG_A)).toBeNull();
  });
  it('intersects the ceiling-wide sites with the org membership sites', () => {
    const c = ceiling({ siteIds: new Set(['s1', 's2']), orgTerms: new Map([[ORG_A, { permissionKeys: new Set(['*:*']), siteIds: new Set(['s2', 's3']) }]]) });
    expect(ceilingSiteIdsForOrg(c, ORG_A)).toEqual(['s2']);
    expect(ceilingSiteIdsForOrg(c, 'org-without-term')).toEqual(['s1', 's2']);
  });
  it('holds a permission the org term grants; not one it lacks; never for an inactive ceiling', () => {
    const c = ceiling({ permissionKeys: new Set(['devices:*']), orgTerms: new Map([[ORG_A, { permissionKeys: new Set(['devices:read']), siteIds: null }]]) });
    expect(ceilingHoldsPermission(c, ORG_A, 'devices', 'read')).toBe(true);
    expect(ceilingHoldsPermission(c, ORG_A, 'devices', 'execute')).toBe(false);
    expect(ceilingHoldsPermission({ ...c, status: 'paused' }, ORG_A, 'devices', 'read')).toBe(false);
  });
  it('fails closed for a site-restricted ceiling (coordinator gate 4 refuses those for every specialist)', () => {
    expect(ceilingHoldsPermission(ceiling({ siteIds: new Set(['s1']) }), ORG_A, 'devices', 'read')).toBe(false);
  });
});
```

Use the file's existing org constant in place of `ORG_A` if it has a different name.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/wisp/grantAuthority.test.ts`
Expected: FAIL. `ceilingSiteIdsForOrg is not a function`.

- [ ] **Step 3: Implement both functions** as specified in Interfaces.

- [ ] **Step 4: Run to verify pass.** Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/wisp/grantAuthority.ts apps/api/src/services/wisp/grantAuthority.test.ts
git commit -m "feat(api): grant ceiling site allowlist and permission-held helpers (W02)"
```

---

### Task 4: `resolveAnalysisFrame`

**Files:**
- Create: `apps/api/src/services/aiAgents/analysisFrame.ts`
- Test: `apps/api/src/services/aiAgents/analysisFrame.test.ts` (new, mocked db), `apps/api/src/__tests__/integration/analysisFrame.integration.test.ts` (new, real Postgres)
- Modify: `apps/api/src/__tests__/parkedFanout.contract.test.ts` (EXEMPT entry)

**Interfaces:**
- Consumes: `AnalysisScopeKind`, `AiAgentRunStagedInputs` (Task 2).
- Produces (C6 verbatim):
  ```ts
  export type AnalysisFrameRefusal = 'too_many_input_devices' | 'device_not_in_org' | 'frame_too_large' | 'site_not_in_scope' | 'frame_empty';
  export async function resolveAnalysisFrame(input: {
    orgId: string; scope: AnalysisScopeKind; deviceIds: string[]; siteId: string | null;
    allowedSiteIds: string[] | null; maxInputDevices: number; maxFrameDevices: number;
  }): Promise<{ ok: true; deviceIds: string[]; scope: NonNullable<AiAgentRunStagedInputs['scope']> } | { ok: false; refusal: AnalysisFrameRefusal }>;
  ```
  Uses the ambient `db` (admission calls it inside its own system-context transaction). Opens no context of its own.

Rules, in order:
- **devices:** dedupe (first occurrence order). Empty → `frame_empty`. More than `maxInputDevices` → `too_many_input_devices`. One select of `(id, siteId)` from `devices` where `id IN list AND org_id = orgId`; fewer rows than ids → `device_not_in_org`. When `allowedSiteIds !== null` and any row's site is outside it → `site_not_in_scope`. Decommissioned devices named explicitly are kept. `scope = { kind: 'devices', siteId: null, deviceCount }`.
- **site:** `siteId` must exist in `sites` with `org_id = orgId`, else `site_not_in_scope`. When `allowedSiteIds !== null` and it does not contain `siteId` → `site_not_in_scope`. Then expand.
- **org:** `allowedSiteIds` of `[]` → `frame_empty` with no query. Then expand.
- **Expand (site/org):** `select id from devices where org_id = orgId [and site_id = siteId | and site_id in allowedSiteIds] and status <> 'decommissioned' order by id limit maxFrameDevices + 1`. More than `maxFrameDevices` rows → `frame_too_large`. Zero → `frame_empty`. `scope.siteId` is the site id for `site` and `null` for `org`.

- [ ] **Step 1: Write the failing unit tests**

Mock `../../db` with the FIFO-by-table builder from `analysisProfile.admission.test.ts:36-69`. Extend it so `limit(n)` records `n` in `dbMockState.limits`. Use `base = { orgId: ORG, deviceIds: [], siteId: null, allowedSiteIds: null, maxInputDevices: 50, maxFrameDevices: 3 }` and v4-UUID constants `SITE_1`, `SITE_2`, `D1`–`D4`. One `it` per row:

| Input (over `base`) | Queued rows | Expected |
|---|---|---|
| `scope: 'org'` | devices `[D1, D2]` | `{ ok: true, deviceIds: [D1, D2], scope: { kind: 'org', siteId: null, deviceCount: 2 } }`, and `dbMockState.limits` is `[4]` |
| `scope: 'org'` | devices `[D1, D2, D3]` | `ok: true` (exactly the limit) |
| `scope: 'org'` | devices `[D1, D2, D3, D4]` | `{ ok: false, refusal: 'frame_too_large' }` |
| `scope: 'org'` | devices `[]` | `frame_empty` |
| `scope: 'org', allowedSiteIds: []` | none | `frame_empty`, and `db.select` not called |
| `scope: 'site', siteId: SITE_1` | sites `[]` | `site_not_in_scope` |
| `scope: 'site', siteId: SITE_1, allowedSiteIds: [SITE_2]` | sites `[{ id: SITE_1 }]` | `site_not_in_scope` |
| `scope: 'site', siteId: SITE_1` | sites `[{ id: SITE_1 }]`, devices `[D1]` | `{ ok: true, deviceIds: [D1], scope: { kind: 'site', siteId: SITE_1, deviceCount: 1 } }` |
| `scope: 'devices', deviceIds: []` | none | `frame_empty` |
| `scope: 'devices', deviceIds: [D1, D2, D3], maxInputDevices: 2` | none | `too_many_input_devices` |
| `scope: 'devices', deviceIds: [D1, D2]` | devices `[{ id: D1, siteId: SITE_1 }]` | `device_not_in_org` |
| `scope: 'devices', deviceIds: [D1, D1]` | devices `[{ id: D1, siteId: SITE_1 }]` | `{ ok: true, deviceIds: [D1], scope: { kind: 'devices', siteId: null, deviceCount: 1 } }` |
| `scope: 'devices', deviceIds: [D1], allowedSiteIds: [SITE_2]` | devices `[{ id: D1, siteId: SITE_1 }]` | `site_not_in_scope` |

- [ ] **Step 2: Write the failing integration test**

`src/__tests__/integration/analysisFrame.integration.test.ts`. `import './setup'`. Seed with `createPartner`, `createOrganization`, `createSite` and `createDevice` from `./db-utils`: org A with sites S1 (2 devices) and S2 (1 device plus 1 device then set `status = 'decommissioned'` via `getTestDb().execute(sql\`update devices set status = 'decommissioned' where id = ${id}\`)`), and org B with site S3 (1 device). Call `withSystemDbAccessContext(() => resolveAnalysisFrame(...))`. Assert:
- `org` on A → exactly A's three live devices (B's and the decommissioned one absent), `deviceCount: 3`;
- `site` S1 → S1's two devices; `site` S3 with `orgId` A → `site_not_in_scope`;
- `org` on A with `allowedSiteIds: [S2]` → only S2's live device;
- `org` on A with `maxFrameDevices: 2` → `frame_too_large`;
- `devices` naming B's device with `orgId` A → `device_not_in_org`.

- [ ] **Step 3: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/aiAgents/analysisFrame.test.ts`
Expected: FAIL. `Failed to resolve import "./analysisFrame"`.
Integration (needs `pnpm test-stack up` first): `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/analysisFrame.integration.test.ts`. Expected: FAIL on the same import.

- [ ] **Step 4: Implement `resolveAnalysisFrame`** per the rules above (`ne(devices.status, 'decommissioned')`, `inArray(devices.siteId, allowedSiteIds)`, `.orderBy(devices.id).limit(maxFrameDevices + 1)`).

- [ ] **Step 5: Classify the new file**

`cd apps/api && npx vitest run src/__tests__/parkedFanout.contract.test.ts` now fails, asking to classify `services/aiAgents/analysisFrame.ts`. Add it to `EXEMPT` with: `'analysis frame (W02 analysis sessions): expands one customer org or site the coordinator already checked against GrantCeiling.orgIds, which never contains a holding org, so a parked device cannot match; selects read scope for a run that cannot act'`.

- [ ] **Step 6: Run to verify pass**

Run the Step 3 commands and the parkedFanout command. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/aiAgents/analysisFrame.ts apps/api/src/services/aiAgents/analysisFrame.test.ts apps/api/src/__tests__/integration/analysisFrame.integration.test.ts apps/api/src/__tests__/parkedFanout.contract.test.ts
git commit -m "feat(api): resolveAnalysisFrame — site/org device frame under the grant site allowlist (W02)"
```

---

### Task 5: Admission expands and freezes the frame, and freezes the passed export grants

**Files:**
- Modify: `apps/api/src/services/aiAgents/runService.ts:396-404` (`CreateAgentRunInput.analysis`), `:488-527` (`AgentRunSkipReason`), `:831-845` (`PUBLISHED_SKIP_REASONS`), `:1689-1750` (step 4d)
- Modify: `apps/api/src/services/aiAgents/analysisAdmission.ts:40-76, 100-163, 199-206`
- Modify: `apps/api/src/services/automationRuntime.ts:1590-1660` (`AI_TRIAGE_SKIP_IS_FAILURE`)
- Test: `apps/api/src/services/aiAgents/analysisProfile.admission.test.ts`, `apps/api/src/services/aiAgents/analysisAdmission.test.ts`, `apps/api/src/services/automationRuntime.aiTriage.test.ts:62-100`

**Interfaces:**
- Consumes: `resolveAnalysisFrame` (Task 4), `ceilingSiteIdsForOrg` (Task 3), `AiRunExportGrants`/`AnalysisScopeKind` (Task 2), `AI_AGENT_LIMIT_DEFAULTS.analysisMaxFrameDevices` (Task 1).
- Produces:
  - `CreateAgentRunInput.analysis?: { scope: AnalysisScopeKind; siteId: string | null; deviceIds: string[]; inputHandles: string[]; exportGrants?: AiRunExportGrants }`. `scope` is required, so every producer chooses one. The docstring marks `exportGrants` as **TRUSTED INTERNAL INPUT**: the Wisp analysis launcher computes it from the coordinator's live ceiling, and nothing may build it from a request body.
  - `AgentRunSkipReason` gains `'frame_too_large' | 'site_not_in_scope' | 'frame_empty'`. All three go in `PUBLISHED_SKIP_REASONS` and map to `false` in `AI_TRIAGE_SKIP_IS_FAILURE`, like `too_many_input_devices`.
  - `AdmitAnalysisRunInput` gains `scope: AnalysisScopeKind` and `exportGrants?: AiRunExportGrants` (TRUSTED INTERNAL INPUT, same comment as `grant`). `AnalysisAdmissionRefusal` gains the three codes, and `SKIP_REASON_REFUSALS` maps each one to itself. `admitAnalysisRun` forwards both into `analysis`.
  - Step 4d writes `staged_inputs = { handles, deviceIds: frame.deviceIds, region, scope: frame.scope, ...(exportGrants ? { exportGrants } : {}) }`.

Step 4d, replacing block (d), still before every counter and inside both advisory locks:
1. `analysis.scope !== 'devices' && !grantCeiling` → `skip('analysis_not_available')`. Without a grant there is no human authority to bound a site or org frame. The Wisp launcher always passes a grant, and `workspace_launch_analysis` stays denied (#6086).
2. `grantCeiling && !analysis.exportGrants` → `skip('analysis_not_available')`. A grant-bearing analysis must arrive with its grants: fail closed rather than fall back to legacy.
3. `frame = await resolveAnalysisFrame({ orgId, scope: analysis.scope, deviceIds: analysis.deviceIds, siteId: analysis.siteId, allowedSiteIds: grantCeiling ? ceilingSiteIdsForOrg(grantCeiling, orgId) : null, maxInputDevices: limits.analysisMaxInputDevicesPerRun ?? default, maxFrameDevices: limits.analysisMaxFrameDevices ?? default })`. `!frame.ok` → `skip(frame.refusal)`.

- [ ] **Step 1: Write the failing tests**

In `analysisProfile.admission.test.ts`:
- Mock the ceiling as `runService.grantAdmission.test.ts:107-111` does (`vi.mock('../wisp/grantAuthority', async (orig) => ({ ...(await orig()), resolveGrantCeiling }))`). Copy its `ceiling(o)` factory (line 140) with `deniedTools: new Set()`.
- Add a pass-through spy: `vi.mock('./analysisFrame', async (orig) => { const a = await orig<typeof import('./analysisFrame')>(); return { resolveAnalysisFrame: resolveAnalysisFrameSpy.mockImplementation(a.resolveAnalysisFrame) }; })`, re-armed in `beforeEach`. The existing `too_many_input_devices` and `device_not_in_org` tests keep exercising the real function through it.
- `analysisInput()` default becomes `analysis: { scope: 'devices', siteId: null, deviceIds: [DEVICE_A, DEVICE_B], inputHandles: [] }`. Add `scope: 'devices', siteId: null` to the two tests that pass `analysis` inline. `'admits, freezes staged_inputs …'` now expects `scope: { kind: 'devices', siteId: null, deviceCount: 2 }` and no `exportGrants`.

```ts
const GRANT = { grantId: 'g1', grantRevisionId: 'r1' };
const GRANTS = { datasets: ['event_logs', 'metrics'], sensitiveGates: [] as AnalysisSensitiveGate[] };
const ORG_SCOPE = { scope: 'org' as const, siteId: null, deviceIds: [], inputHandles: [], exportGrants: GRANTS };

it('org scope under a grant: freezes the expanded frame, its scope and the passed export grants verbatim', async () => {
  resolveGrantCeiling.mockResolvedValue(ceiling());
  const result = await createAndEnqueueAgentRun(analysisInput({ grant: GRANT, analysis: ORG_SCOPE }));
  expect(result.created).toBe(true);
  expect(dbMockState.insertValues[0]!.stagedInputs).toEqual({
    handles: [], deviceIds: [DEVICE_A, DEVICE_B], region: 'eu',
    scope: { kind: 'org', siteId: null, deviceCount: 2 }, exportGrants: GRANTS,
  });
});
it('passes the ceiling site allowlist and both limits to resolveAnalysisFrame', async () => {
  resolveGrantCeiling.mockResolvedValue(ceiling());
  await createAndEnqueueAgentRun(analysisInput({ grant: GRANT, analysis: ORG_SCOPE }));
  expect(resolveAnalysisFrameSpy).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG_ID, scope: 'org', allowedSiteIds: null, maxInputDevices: 50, maxFrameDevices: 1000 }));
});
it('a site-restricted ceiling never reaches the frame: step 1d refuses it (the narrowing is defence in depth)', async () => {
  resolveGrantCeiling.mockResolvedValue(ceiling({ siteIds: new Set(['site-1']) }));
  await expect(createAndEnqueueAgentRun(analysisInput({ grant: GRANT, analysis: ORG_SCOPE }))).resolves.toEqual({ created: false, skipped: 'grant_org_out_of_ceiling' });
  expect(resolveAnalysisFrameSpy).not.toHaveBeenCalled();
});
it('a snapshot without analysisMaxFrameDevices falls back to 1000', async () => {
  const { analysisMaxFrameDevices: _drop, ...older } = AI_AGENT_LIMIT_DEFAULTS;
  const snap = snapshot([...WORKSPACE_TOOL_NAMES]);
  resolveEffectiveAgentSystem.mockResolvedValue({ ...snap, effective: { ...snap.effective, limits: older } });
  resolveGrantCeiling.mockResolvedValue(ceiling());
  await createAndEnqueueAgentRun(analysisInput({ grant: GRANT, analysis: ORG_SCOPE }));
  expect(resolveAnalysisFrameSpy).toHaveBeenCalledWith(expect.objectContaining({ maxFrameDevices: 1000 }));
});
it.each(['frame_too_large', 'site_not_in_scope', 'frame_empty'] as const)('skips %s before any counter or insert', async (refusal) => {
  resolveGrantCeiling.mockResolvedValue(ceiling());
  resolveAnalysisFrameSpy.mockResolvedValueOnce({ ok: false, refusal });
  await expect(createAndEnqueueAgentRun(analysisInput({ grant: GRANT, analysis: ORG_SCOPE }))).resolves.toEqual({ created: false, skipped: refusal });
  expect(dbMockState.insertValues).toEqual([]);
});
it('fails closed: a site/org frame without a grant, or a grant-bearing analysis without export grants', async () => {
  await expect(createAndEnqueueAgentRun(analysisInput({ analysis: ORG_SCOPE }))).resolves.toEqual({ created: false, skipped: 'analysis_not_available' });
  resolveGrantCeiling.mockResolvedValue(ceiling());
  const { exportGrants: _no, ...withoutGrants } = ORG_SCOPE;
  await expect(createAndEnqueueAgentRun(analysisInput({ grant: GRANT, analysis: withoutGrants }))).resolves.toEqual({ created: false, skipped: 'analysis_not_available' });
});
```

In `analysisAdmission.test.ts`: the forward assertion at line 59 becomes `{ scope: 'devices', siteId: null, deviceIds: ['dev-1'], inputHandles: [HANDLE] }` (pass `scope: 'devices'` in its input). Add a case asserting `exportGrants` is forwarded when given and absent when not. Add the three codes to the runtime-union test (line 117). In `automationRuntime.aiTriage.test.ts` `EXPECTED_OUTCOME`, add the three as `'succeeded'`.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/aiAgents/analysisProfile.admission.test.ts src/services/aiAgents/analysisAdmission.test.ts src/services/automationRuntime.aiTriage.test.ts`
Expected: FAIL. `stagedInputs` has no `scope`/`exportGrants`; the org input admits with `deviceIds: []`; the union test is missing members.

- [ ] **Step 3: Implement** step 4d, the input shapes, the skip reasons and the three maps as specified above. Rewrite the comment above block (d): the set is frozen here; a site or org frame is expanded here under the live ceiling's site allowlist; the export grants arrive from the launcher and are frozen verbatim.

- [ ] **Step 4: Run to verify pass**

Run the Step 2 command, plus `cd apps/api && npx vitest run src/services/aiAgents/runService.test.ts src/services/aiAgents/runService.grantAdmission.test.ts src/services/aiAgents/redTeam.workspace.contract.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiAgents/runService.ts apps/api/src/services/aiAgents/analysisAdmission.ts apps/api/src/services/automationRuntime.ts apps/api/src/services/aiAgents/analysisProfile.admission.test.ts apps/api/src/services/aiAgents/analysisAdmission.test.ts apps/api/src/services/automationRuntime.aiTriage.test.ts
git commit -m "feat(api): analysis admission expands the scope frame under the live ceiling and freezes export grants (W02)"
```

---

### Task 6: Launch params, export grants from the ceiling, refusal messages

**Files:**
- Modify: `apps/api/src/services/wisp/specialistLaunchers.ts:95-99` (schema), `:372-379` (`SPECIALIST_PREREQUISITES.analysis`), `:462-483` (`launchAnalysis`)
- Modify: `apps/api/src/services/wisp/specialistRefusalMessages.ts:60-93`
- Modify: `apps/api/src/services/aiToolSchemas.ts:524-526`
- Modify: `apps/docs/src/content/docs/features/ai-analysis-runs.mdx`
- Test: `apps/api/src/services/wisp/specialistLaunchers.test.ts`, `apps/api/src/services/wisp/specialistRefusalMessages.test.ts`, `apps/api/src/services/aiToolsWisp.description.test.ts`

**Interfaces:**
- Consumes: `AdmitAnalysisRunInput.scope`/`.exportGrants` (Task 5), `resolveExportGrants` (Task 2), `ceilingHoldsPermission` (Task 3).
- Produces:
  - `analysisParamsSchema`: the C1 object (without `continueFromRunId`; W03 adds it) plus a `.superRefine` adding these issues. Neither scope nor `deviceIds` nor `siteId` → path `[]`, message `'scope_required'`. Effective `devices`: no `deviceIds` → `['deviceIds']` `'required for scope devices'`; `siteId` present → `['siteId']` `'not allowed with scope devices'`. Effective `site`: no `siteId` → `['siteId']` `'required for scope site'`; `deviceIds` present → `['deviceIds']` `'not allowed with scope site'`. `org` with either → `['scope']` `'org takes neither deviceIds nor siteId'`.
  - `export function resolveAnalysisScope(params: { scope?: AnalysisScopeKind; deviceIds?: string[]; siteId?: string }): AnalysisScopeKind | null`. The C1 inference, used by the refine and the launcher.
  - `launchAnalysis` computes `exportGrants = resolveExportGrants((r, a) => ceilingHoldsPermission(ctx.ceiling, ctx.orgId, r, a))` and passes `scope: resolveAnalysisScope(params)!`, `deviceIds: params.deviceIds ?? []`, `siteId: params.siteId ?? null`, `exportGrants` to `admitAnalysisRun`. Refusals keep `{ refused: 'admission_skipped', detail: result.refusal }`. W03 inserts continuation handling between computing `exportGrants` and calling admission.
  - `SPECIALIST_PREREQUISITES.analysis`: resolved scope `site` with no `sites` row for `(siteId, orgId)` (read via `systemRead`) → `{ refused: 'admission_skipped', detail: 'site_not_in_scope' }`, so the chat gate refuses before raising a card. Otherwise `null`.

Refusal sentences (exact copy):
- `invalid_params.scope_required`: `'Choose what the analysis covers: scope "org" for the whole organization, "site" with siteId, or "devices" with deviceIds.'`
- `admission_skipped.frame_too_large`: `'That scope has more devices than one analysis may cover (the AI agent limit analysisMaxFrameDevices, default 1000). Scope the analysis to one site, or ask an administrator to raise the limit.'`
- `admission_skipped.site_not_in_scope`: `'That site is not in this organization, or this Wisp grant does not reach it.'`
- `admission_skipped.frame_empty`: `'There are no active devices in that scope, so the analysis would have nothing to read.'`
- `admission_skipped.too_many_input_devices`: `'That is more devices than one analysis may list (the AI agent limit analysisMaxInputDevicesPerRun, default 50). Use scope "site" or "org" instead of listing devices.'`

`launch_specialist` params description (159 chars, exact): `'Keys: sweep {sweepKinds?}; analysis {goal, scope: org|site|devices, siteId|deviceIds}; patch_plan {}; remediation_research {deviceId, alertId?}; rest: see tool'`

This text is interim. **W06 owns the final `launch_specialist` wording** (C7a) and will replace it when it adds `continueFromRunId` and the `analysisLaunchMessage`. Pin only the `scope` keys and the 160-char bound, not the full string.

- [ ] **Step 1: Write the failing tests**

`specialistLaunchers.test.ts`. The `ctx()` default `ceiling` becomes a full `GrantCeiling` (`liveCeiling(o)`: fields as in `runService.grantAdmission.test.ts:140`, `orgIds: new Set([ORG])`, `permissionKeys: new Set(['*:*'])`, `status: 'active'`). Replace the analysis lines of `'validates per kind'` (151-152) and of the prerequisite case (926):

```ts
const SITE = '00000000-0000-4000-8000-0000000000b1';
it('analysis params follow C1 scope resolution and bounds', () => {
  expect(parseSpecialistParams('analysis', { goal: 'why', scope: 'org' })).toEqual({ goal: 'why', scope: 'org' });
  expect(parseSpecialistParams('analysis', { goal: 'why', deviceIds: [DEVICE] })).toEqual({ goal: 'why', deviceIds: [DEVICE] });
  expect(parseSpecialistParams('analysis', { goal: 'why', siteId: SITE })).toEqual({ goal: 'why', siteId: SITE });
  expect(parseSpecialistParams('analysis', { goal: 'why' })).toBeNull();
  expect(parseSpecialistParams('analysis', { goal: 'why', deviceIds: [] })).toBeNull();
  expect(parseSpecialistParams('analysis', { goal: 'why', deviceIds: Array(201).fill(DEVICE) })).toBeNull();
  expect(parseSpecialistParams('analysis', { goal: 'why', deviceIds: Array(200).fill(DEVICE) })).not.toBeNull();
});
it('names the exact problem for each contradictory analysis scope', () => {
  expect(specialistParamsError('analysis', { goal: 'why' })).toBe('scope_required');
  expect(specialistParamsError('analysis', { goal: 'why', scope: 'org', siteId: SITE })).toBe('scope: org takes neither deviceIds nor siteId');
  expect(specialistParamsError('analysis', { goal: 'why', deviceIds: [DEVICE], siteId: SITE })).toBe('siteId: not allowed with scope devices');
  expect(specialistParamsError('analysis', { goal: 'why', scope: 'site' })).toBe('siteId: required for scope site');
  expect(specialistParamsError('analysis', { goal: 'why', scope: 'devices' })).toBe('deviceIds: required for scope devices');
  expect(specialistParamsError('analysis', { goal: 'why', scope: 'site', siteId: SITE, deviceIds: [DEVICE] })).toBe('deviceIds: not allowed with scope site');
});
it('resolveAnalysisScope infers devices, then site, else null', () => {
  expect(resolveAnalysisScope({ deviceIds: [DEVICE] })).toBe('devices');
  expect(resolveAnalysisScope({ siteId: SITE })).toBe('site');
  expect(resolveAnalysisScope({ scope: 'org' })).toBe('org');
  expect(resolveAnalysisScope({})).toBeNull();
});
```

In `describe('launchAnalysis')`, `params` becomes `{ goal: 'why failing', scope: 'org' }` and the forward assertion adds `scope: 'org', deviceIds: [], siteId: null`. Add:

```ts
const SEVEN = ['event_logs', 'agent_logs', 'device_inventory', 'software_inventory', 'metrics', 'vulnerabilities', 'custom_fields'];
it('evaluates export grants against ctx.ceiling and forwards them (chat and assessment paths alike)', async () => {
  h.tables.ai_agent_runs = [[], []];
  h.admitAnalysisRun.mockResolvedValue({ created: true, runId: 'run-1' });
  await launchAnalysis(ctx({ params: { goal: 'why', scope: 'org' } }));
  expect(h.admitAnalysisRun).toHaveBeenLastCalledWith(expect.objectContaining({ exportGrants: { datasets: SEVEN, sensitiveGates: ['security_events'] } }));
  await launchAnalysis(ctx({ actorAuth: null, params: { goal: 'why', scope: 'org' }, ceiling: liveCeiling({ permissionKeys: new Set(['devices:read', 'ai_agents:write', 'ai_workspace:execute']) }) }));
  expect(h.admitAnalysisRun).toHaveBeenLastCalledWith(expect.objectContaining({ exportGrants: { datasets: SEVEN, sensitiveGates: [] } }));
});
it('a ceiling without devices:read forwards an empty dataset set (the handler then refuses every export)', async () => {
  h.tables.ai_agent_runs = [[]];
  h.admitAnalysisRun.mockResolvedValue({ created: true, runId: 'run-1' });
  await launchAnalysis(ctx({ params: { goal: 'why', scope: 'org' }, ceiling: liveCeiling({ permissionKeys: new Set(['ai_agents:write', 'ai_workspace:execute']) }) }));
  expect(h.admitAnalysisRun).toHaveBeenCalledWith(expect.objectContaining({ exportGrants: { datasets: [], sensitiveGates: [] } }));
});
it('infers site scope from a bare siteId', async () => {
  h.tables.ai_agent_runs = [[]];
  h.admitAnalysisRun.mockResolvedValue({ created: true, runId: 'run-1' });
  await launchAnalysis(ctx({ params: { goal: 'why', siteId: SITE } }));
  expect(h.admitAnalysisRun).toHaveBeenCalledWith(expect.objectContaining({ scope: 'site', siteId: SITE, deviceIds: [] }));
});
it.each(['frame_too_large', 'site_not_in_scope', 'frame_empty'] as const)('maps %s to admission_skipped with detail', async (refusal) => {
  h.tables.ai_agent_runs = [[], []];
  h.admitAnalysisRun.mockResolvedValue({ created: false, refusal });
  expect(await launchAnalysis(ctx({ params: { goal: 'why', scope: 'org' } }))).toEqual({ refused: 'admission_skipped', detail: refusal });
});
it('analysis prerequisite: a site outside the org is refused before any card; org scope has none', async () => {
  h.tables.sites = [[], [{ id: SITE }]];
  expect(await pre('analysis', { goal: 'why', siteId: SITE })).toEqual({ refused: 'admission_skipped', detail: 'site_not_in_scope' });
  expect(await pre('analysis', { goal: 'why', siteId: SITE })).toBeNull();
  expect(await pre('analysis', { goal: 'why', scope: 'org' })).toBeNull();
  noSideEffects();
});
```

`specialistRefusalMessages.test.ts`:

```ts
it('W02 analysis scope refusals name the setting', () => {
  expect(specialistRefusalMessage('invalid_params', 'scope_required')).toMatch(/scope "org"/);
  expect(specialistRefusalMessage('admission_skipped', 'frame_too_large')).toMatch(/analysisMaxFrameDevices/);
  expect(specialistRefusalMessage('admission_skipped', 'too_many_input_devices')).toMatch(/analysisMaxInputDevicesPerRun/);
  expect(specialistRefusalMessage('admission_skipped', 'site_not_in_scope')).toMatch(/does not reach it/);
  expect(specialistRefusalMessage('admission_skipped', 'frame_empty')).toMatch(/no active devices/);
});
```

`aiToolsWisp.description.test.ts`:

```ts
it('W02: the params description names the analysis scope and its values within 160 chars', () => {
  for (const enabled of [false, true]) {
    const d = launchSpecialistShapeFor(enabled).params.description!;
    expect(d).toMatch(/analysis \{[^}]*scope[^}]*org\|site\|devices/); // W06 rewrites the wording; pin only the keys
    expect(d.length).toBeLessThanOrEqual(160);
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/wisp/specialistLaunchers.test.ts src/services/wisp/specialistRefusalMessages.test.ts src/services/aiToolsWisp.description.test.ts`
Expected: FAIL. `{ goal: 'why' }` still parses; `resolveAnalysisScope` is undefined; no `exportGrants` is forwarded; the messages fall back to the generic sentences; the description lacks `scope`.

- [ ] **Step 3: Implement** the schema, `resolveAnalysisScope`, the launcher, the prerequisite, the five sentences and the description string. In `ai-analysis-runs.mdx`, add `## What a run covers` under `## Before you start`, stating that:
  - a run covers listed devices (up to 50 by default), one site, or the whole organization;
  - a site or organization is expanded to its active devices when the run starts, and that list is fixed: devices added later are not read;
  - the frame is limited to 1000 devices by default (`analysisMaxFrameDevices`, 50–5000) and a larger one is refused; scope to a site instead;
  - a launch that names no scope is refused;
  - the datasets a run may export are fixed when it starts, from what the Wisp grant's owner may read at that moment, and Security-category event logs need `devices:execute`.

- [ ] **Step 4: Run to verify pass**

Run the Step 2 command, plus `cd apps/api && npx vitest run src/services/wisp/coordinator.test.ts src/services/wisp/specialistDispatch.test.ts src/services/aiAgentSdk.wispCeiling.test.ts src/services/aiTools.descriptionBudget.contract.test.ts src/services/aiTools.userOwnedRelease.contract.test.ts`. Expected: PASS. If a fixture launches `analysis` with `{ goal }` alone, add `scope: 'org'` to it. Do not loosen the schema.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/wisp/specialistLaunchers.ts apps/api/src/services/wisp/specialistLaunchers.test.ts apps/api/src/services/wisp/specialistRefusalMessages.ts apps/api/src/services/wisp/specialistRefusalMessages.test.ts apps/api/src/services/aiToolSchemas.ts apps/api/src/services/aiToolsWisp.description.test.ts apps/docs/src/content/docs/features/ai-analysis-runs.mdx
git commit -m "feat(api): analysis launch takes scope devices|site|org and freezes export grants from the live ceiling; no scope is refused (W02)"
```

---

### Task 7: Frozen grants reach `export_dataset` and its adapters; `dataset_not_permitted`; adapter notes

**Files:**
- Modify: `apps/api/src/services/toolExecutionContext.ts:114-116`
- Modify: `apps/api/src/services/aiAgents/runLoop.ts:905-935` (`createAgentRunPreToolUse` args and `runFrame`), `:2729-2734` (call site)
- Modify: `apps/api/src/services/aiToolsExport.ts:54-210`
- Modify: `apps/api/src/services/aiToolsExportDatasets.ts:69-80` (`DatasetRequest`), `:183-194` (`eventLogsAdapter`), import line 21
- Test: `apps/api/src/services/aiToolsExport.test.ts`, `apps/api/src/services/aiToolsExportDatasets.test.ts`, `apps/api/src/services/aiAgents/runLoop.analysis.test.ts`, `apps/api/src/services/aiAgents/runLoop.runContext.test.ts`

**Interfaces:**
- Consumes: `AiRunExportGrants`, `LEGACY_EXPORT_GRANTS`, `withheldSensitiveGates` (Task 2).
- Produces (the C8 adapter request fields; W04/W05 consume both):
  - `DatasetRequest.exportGrants: AiRunExportGrants`. The run's frozen grants: always the effective set, never absent, and `LEGACY_EXPORT_GRANTS` for a run admitted before W02.
  - `DatasetRequest.notes: string[]`. The handler creates it empty for each call. An adapter appends one plain sentence per note (withheld sensitive rows today; W04/W05 add an unapplied time range and others). The handler copies it into the tool result as `notes` after `await stream.stats`, and only when it is non-empty.
  - `ToolExecutionContext.exportGrants?: AiRunExportGrants`. Doc: the datasets and sensitive gates frozen at admission from the live grant ceiling. Absent means legacy (`LEGACY_EXPORT_GRANTS`), never "everything".
  - `createAgentRunPreToolUse` args gain `exportGrants?: AiRunExportGrants`, copied into `runFrame` only when defined. The call site passes `analysis && stagedInputs ? stagedInputs.exportGrants : undefined`.
  - `export_dataset` computes `grants = context?.exportGrants ?? LEGACY_EXPORT_GRANTS` after the `export_requires_run` check and before the run-target check. A dataset not in `grants.datasets` returns `{ error: 'dataset_not_permitted', dataset, permitted: grants.datasets, message: 'This run was not granted that dataset. The Wisp grant owner cannot read it, or the run was admitted before it existed.' }` and creates no artifact.
  - **Result fields.** The handler keeps a machine-readable `sensitiveRowsWithheld: AnalysisSensitiveGate[]`. It is computed from `withheldSensitiveGates([dataset], grants)` and present only when non-empty. Adapters never set it: they say the same thing to the model through `req.notes`.
  - `eventLogsAdapter`: `canReadSensitiveCategory = req.exportGrants.sensitiveGates.includes('security_events')`. When that is false, it appends the note `'Security-category event logs are not in this export: this run does not hold the security_events gate (devices:execute).'`. It no longer calls `canReadSensitiveEventLogCategory`: `export_dataset` runs only under an `ai_agent` run principal, which has no role (`agentAuthContext.ts:101`), so that RBAC call always returned `false`. Remove the unused import.
  - Description (279 chars, exact): `"Export a complete dataset as a file handle without read-tool compaction. Datasets: event_logs, agent_logs, device_inventory, software_inventory, metrics, vulnerabilities, custom_fields. Stage the handle with workspace_stage. Per-device datasets may truncate on large device sets."`

- [ ] **Step 1: Write the failing tests**

`aiToolsExport.test.ts`. The `DATASET_ADAPTERS` proxy mock already forwards the request to `createPager`, so the adapter-side push is simulated through `r.notes`:

```ts
const SEVEN = ['event_logs', 'agent_logs', 'device_inventory', 'software_inventory', 'metrics', 'vulnerabilities', 'custom_fields'];

it('refuses a dataset outside the frozen export grants, before any pager or artifact', async () => {
  const parsed = JSON.parse(await getTool().handler({ dataset: 'metrics' }, auth,
    { runTargets: ['d1'], stagedBytesRemaining: 1_000_000, exportGrants: { datasets: ['event_logs'], sensitiveGates: [] } }));
  expect(parsed).toMatchObject({ error: 'dataset_not_permitted', dataset: 'metrics', permitted: ['event_logs'] });
  expect(createPager).not.toHaveBeenCalled();
  expect(createArtifact).not.toHaveBeenCalled();
});
it('no frozen grants (a run admitted before W02): the original seven, legacy grants on the request, security rows reported withheld', async () => {
  createPager.mockResolvedValue(pagesOf([{ rows: [{ id: 1 }], nextCursor: null }]));
  const parsed = JSON.parse(await getTool().handler({ dataset: 'event_logs' }, auth, { runTargets: ['d1'], stagedBytesRemaining: 1_000_000 }));
  expect(parsed.error).toBeUndefined();
  expect(parsed.sensitiveRowsWithheld).toEqual(['security_events']);
  expect(createPager.mock.calls[0]![0]).toMatchObject({ exportGrants: { datasets: SEVEN, sensitiveGates: [] }, notes: [] });
});
it('copies adapter notes into the result; omits notes and sensitiveRowsWithheld when there are none', async () => {
  createPager.mockImplementationOnce(async (r: { notes: string[] }) => { r.notes.push('a note'); return pagesOf([{ rows: [{ id: 1 }], nextCursor: null }]); });
  const grants = { datasets: SEVEN, sensitiveGates: ['security_events' as const] };
  const withNote = JSON.parse(await getTool().handler({ dataset: 'event_logs' }, auth, { runTargets: ['d1'], stagedBytesRemaining: 1_000_000, exportGrants: grants }));
  expect(withNote.notes).toEqual(['a note']);
  expect(withNote.sensitiveRowsWithheld).toBeUndefined();
  createPager.mockResolvedValueOnce(pagesOf([{ rows: [{ id: 1 }], nextCursor: null }]));
  const plain = JSON.parse(await getTool().handler({ dataset: 'metrics' }, auth, { runTargets: ['d1'], stagedBytesRemaining: 1_000_000, exportGrants: grants }));
  expect(plain).not.toHaveProperty('notes');
});
it('states that per-device datasets may truncate on large device sets', () => {
  expect(getTool().definition.description).toContain('may truncate on large device sets');
});
```

`aiToolsExportDatasets.test.ts`. The file builds each request inline (for example line 174). Add `exportGrants: { datasets: [...EXPORT_DATASETS], sensitiveGates: [] }, notes: []` to every inline request so they typecheck. Add a local `req(over)` helper returning `{ auth, orgId: 'org-1', filters: {}, deviceIds: null, runTargets: null, siteId: null, pageSize: 500, exportGrants: { datasets: [...EXPORT_DATASETS], sensitiveGates: [] }, notes: [], ...over }`. Then replace `'event_logs resolves and passes canReadSensitiveCategory through to the builder'` (line 197) with:

```ts
it('event_logs reads security rows only when the run holds the frozen security_events gate, and notes it otherwise', async () => {
  searchFleetLogs.mockResolvedValue({ results: [], nextCursor: null, hasMore: false });
  const heldReq = req({ exportGrants: { datasets: ['event_logs'], sensitiveGates: ['security_events'] }, notes: [] });
  await (await DATASET_ADAPTERS.event_logs.createPager(heldReq))(null);
  expect(searchFleetLogs.mock.calls[0]![1]).toMatchObject({ canReadSensitiveCategory: true });
  expect(heldReq.notes).toEqual([]);
  const notHeldReq = req({ exportGrants: { datasets: ['event_logs'], sensitiveGates: [] }, notes: [] });
  await (await DATASET_ADAPTERS.event_logs.createPager(notHeldReq))(null);
  expect(searchFleetLogs.mock.calls[1]![1]).toMatchObject({ canReadSensitiveCategory: false });
  expect(notHeldReq.notes).toEqual(['Security-category event logs are not in this export: this run does not hold the security_events gate (devices:execute).']);
  expect(canReadSensitiveEventLogCategory).not.toHaveBeenCalled();
});
```

`runLoop.runContext.test.ts`:

```ts
it('accepts exportGrants', () => {
  const ctx: ToolExecutionContext = { exportGrants: { datasets: ['event_logs'], sensitiveGates: ['security_events'] } };
  expect(ctx.exportGrants!.datasets).toEqual(['event_logs']);
});
```

`runLoop.analysis.test.ts`. In `scriptQuery`, push every verdict into a module-level `const verdicts: unknown[] = []` (cleared in `beforeEach`). Then:

```ts
it('hands the frozen export grants to every allowed tool call', async () => {
  const grants = { datasets: ['event_logs'], sensitiveGates: [] as never[] };
  seedRows({ stagedInputs: { ...STAGED_INPUTS, exportGrants: grants } });
  scriptQuery({ toolCalls: [{ tool: 'mcp__breeze__export_dataset', input: { dataset: 'event_logs' } }] });
  await executeAgentRun(RUN_ID);
  expect((verdicts[0] as { context?: ToolExecutionContext }).context?.exportGrants).toEqual(grants);
});
it('a run admitted before W02 (no exportGrants on staged_inputs) passes none', async () => {
  seedRows();
  scriptQuery({ toolCalls: [{ tool: 'mcp__breeze__export_dataset', input: { dataset: 'event_logs' } }] });
  await executeAgentRun(RUN_ID);
  expect((verdicts[0] as { context?: ToolExecutionContext }).context).not.toHaveProperty('exportGrants');
});
it('an org-frame run is pinned to its frozen list: a device added after admission is denied', async () => {
  // Spec §7. Passes on arrival: pins existing behaviour so the frame change cannot regress it.
  seedRows({ stagedInputs: { ...STAGED_INPUTS, scope: { kind: 'org', siteId: null, deviceCount: 2 } } });
  await executeAgentRun(RUN_ID);
  const runAuth = hooks.getAuth!() as AuthContext;
  expect(runAuth.allowedDeviceIds).toEqual([DEVICE_A, DEVICE_B]);
  expect(deviceSiteDenied(runAuth, 'any-site', '00000000-0000-4000-8000-0000000000ff')).toBe(true);
});
```

Import `deviceSiteDenied` from `../aiToolsSiteScope` and the `AuthContext` type from `../../middleware/auth`. If the harness's `policy()` denies `export_dataset`, add it to the test allowlist: the verdict must be `allowed`.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/aiToolsExport.test.ts src/services/aiToolsExportDatasets.test.ts src/services/aiAgents/runLoop.analysis.test.ts src/services/aiAgents/runLoop.runContext.test.ts`
Expected: FAIL for four reasons:
- `metrics` is exported;
- there is no `sensitiveRowsWithheld`, `notes` or `exportGrants` on the request;
- `canReadSensitiveEventLogCategory` is still called;
- the verdict context has no `exportGrants`.

- [ ] **Step 3: Implement** the two request fields, the context field, the run-loop plumbing, the handler check, the two result fields, the adapter change and the description, as specified in Interfaces.

- [ ] **Step 4: Run to verify pass**

Run the Step 2 command, plus `cd apps/api && npx vitest run src/services/aiToolsExport.registration.test.ts src/services/aiTools.descriptionBudget.contract.test.ts src/services/aiTools.userOwnedRelease.contract.test.ts src/services/aiAgents/runLoop.test.ts src/services/aiAgents/runLoop.grantCeiling.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/toolExecutionContext.ts apps/api/src/services/aiAgents/runLoop.ts apps/api/src/services/aiToolsExport.ts apps/api/src/services/aiToolsExport.test.ts apps/api/src/services/aiToolsExportDatasets.ts apps/api/src/services/aiToolsExportDatasets.test.ts apps/api/src/services/aiAgents/runLoop.analysis.test.ts apps/api/src/services/aiAgents/runLoop.runContext.test.ts
git commit -m "feat(api): export_dataset enforces frozen export grants; adapters report through notes (W02)"
```

---

### Task 8: An empty exact-device set exports nothing (self-contained, can ship ahead of the wave)

> **Self-contained.** This task depends on nothing in Tasks 1–7 and changes no interface they use. To ship it alone, branch from `main`, apply only this task, and open its own PR, labelled as a data-minimisation fix. Inside the wave, it can run at any point. Its tests vary only `auth.allowedDeviceIds` and `runTargets`. Build each request the way the neighbouring `event_logs` tests do: as an inline literal `{ auth, orgId: 'org-1', filters: {}, deviceIds: null, runTargets: null, siteId: null, pageSize: 500 }`, plus `exportGrants`/`notes` only if Task 7 has already landed. The snippets below write that literal as `req({...})` for brevity.

**Why:** an analysis run admitted with no devices carries `auth.allowedDeviceIds: []` and no run frame. `export_dataset` passes `runTargets: null` for an empty frame (`aiToolsExport.ts:163`). `siteScopedDeviceIds` (`aiToolsExportDatasets.ts:93-96`) returns `null` unless the auth has `allowedSiteIds`, so `scopedDeviceIds` (`:115-122`) answers "unrestricted". `event_logs` then calls `searchFleetLogs` with `allowedDeviceIds: null`: an org-wide read of non-security event logs. This is inferred from the code and not reproduced; Step 2 proves or disproves it. `agent_logs` is already safe through `deviceScopeCondition` (`aiToolsAgentLogs.ts:157-160`, #6096 RC3), and the per-device and inventory adapters already return nothing for an empty list.

**Files:**
- Modify: `apps/api/src/services/aiToolsExportDatasets.ts:85-122` (`siteScopedDeviceIds` / `scopedDeviceIds`)
- Test: `apps/api/src/services/aiToolsExportDatasets.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `scopedDeviceIds(req)` also narrows by `req.auth.allowedDeviceIds` whenever it is an array, empty included. Intersect it directly in this function: do not route it through `resolveSiteAllowedDeviceIds`, which the test file mocks to `null`. The result is exact-device ∩ run frame ∩ site axis, and `[]` means export nothing (the `event_logs` adapter already returns its empty pager for `[]`, line 192). `null` stays reserved for a caller restricted on no axis. The function's doc comment is corrected: an empty exact-device list is "no devices", never "no frame".

- [ ] **Step 1: Write the failing tests**

`auth` is the file's existing agent auth constant, which carries no `allowedDeviceIds` and no site axis.

```ts
it('event_logs exports nothing for a run whose exact-device set is empty and that has no frame', async () => {
  const pager = await DATASET_ADAPTERS.event_logs.createPager(req({ auth: { ...(auth as object), allowedDeviceIds: [] } as never, runTargets: null }));
  expect(await pager(null)).toEqual({ rows: [], nextCursor: null });
  expect(searchFleetLogs).not.toHaveBeenCalled();
});
it('event_logs narrows to the exact-device set when the run carries one and no frame', async () => {
  searchFleetLogs.mockResolvedValue({ results: [], nextCursor: null, hasMore: false });
  const pager = await DATASET_ADAPTERS.event_logs.createPager(req({ auth: { ...(auth as object), allowedDeviceIds: ['d1', 'd2'] } as never, runTargets: null }));
  await pager(null);
  expect(searchFleetLogs.mock.calls[0]![1]).toMatchObject({ allowedDeviceIds: ['d1', 'd2'] });
});
it('event_logs intersects the exact-device set with the run frame', async () => {
  searchFleetLogs.mockResolvedValue({ results: [], nextCursor: null, hasMore: false });
  const pager = await DATASET_ADAPTERS.event_logs.createPager(req({ auth: { ...(auth as object), allowedDeviceIds: ['d1', 'd2'] } as never, runTargets: ['d2', 'd3'] }));
  await pager(null);
  expect(searchFleetLogs.mock.calls[0]![1]).toMatchObject({ allowedDeviceIds: ['d2'] });
});
it('an unrestricted caller (no exact-device set, no site axis, no frame) is still unrestricted', async () => {
  searchFleetLogs.mockResolvedValue({ results: [], nextCursor: null, hasMore: false });
  const pager = await DATASET_ADAPTERS.event_logs.createPager(req({ runTargets: null }));
  await pager(null);
  expect(searchFleetLogs.mock.calls[0]![1]).toMatchObject({ allowedDeviceIds: null });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/aiToolsExportDatasets.test.ts`
Expected: FAIL. The empty-set case calls `searchFleetLogs` with `allowedDeviceIds: null`, which is the org-wide read; the narrowing cases pass `null` too. If the empty-set case passes before any change, the hole is not real: say so in the PR body and keep the tests as pins.

- [ ] **Step 3: Implement** the narrowing in `scopedDeviceIds`.

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/api && npx vitest run src/services/aiToolsExportDatasets.test.ts src/services/aiToolsExport.test.ts src/services/aiToolsSiteScope.runFrozenDeviceIds.test.ts src/services/aiTools.userOwnedRelease.contract.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiToolsExportDatasets.ts apps/api/src/services/aiToolsExportDatasets.test.ts
git commit -m "fix(api): export_dataset never reads an empty exact-device set as unrestricted"
```

---

### Task 9: Task prompt states the scope and the exportable datasets

**Files:**
- Modify: `apps/api/src/services/aiAgents/runnerPrompt.ts:308` (`AgentRunPromptContext['analysis']`), `:1707-1735`
- Test: `apps/api/src/services/aiAgents/runnerPrompt.test.ts` (existing analysis case near line 71)

**Interfaces:**
- Consumes: `AiAgentRunStagedInputs['scope']`, `AiRunExportGrants`, `withheldSensitiveGates` (Task 2).
- Produces: `AgentRunPromptContext['analysis']` becomes `{ goal: string | null; deviceIds: string[]; handles: string[]; scope: NonNullable<AiAgentRunStagedInputs['scope']> | null; exportGrants: AiRunExportGrants | null } | null`. `analysisPromptContext(triggerRef, stagedInputs)` reads `scope` and `exportGrants` defensively (wrong shape → `null`) and still never reads scope from `trigger_ref`.

Lines `buildAnalysisTaskPrompt` emits, replacing the device-ids line and the "Use only the frozen device set" line:
- `scope` null or `kind: 'devices'`: unchanged: `Admission-frozen device IDs (JSON): [...]` and `'Use only the frozen device set for fleet data. An empty set authorizes no device reads; synthetic computation and supplied artifacts can still be analyzed.'`
- `kind: 'org'`: `Device scope: the whole organization (${n} devices, frozen at launch). Device IDs are not listed; use query_devices to orient. Fleet data tools are already limited to this set.`
- `kind: 'site'`: `Device scope: one site, ${siteId} (${n} devices, frozen at launch). Device IDs are not listed; use query_devices to orient. Fleet data tools are already limited to this set.`
- `exportGrants` non-null: `Datasets you may export with export_dataset (JSON): ${JSON.stringify(datasets)}`. When `withheldSensitiveGates(datasets, grants)` is non-empty, add `Rows withheld from those exports (JSON): ${JSON.stringify(gates)}`. With `exportGrants` null (pre-W02 run), neither line appears.

- [ ] **Step 1: Write the failing tests**

```ts
const GRANTS = { datasets: ['event_logs', 'metrics'], sensitiveGates: [] as never[] };
it('an org frame states scope and count, lists no device ids, and lists the exportable datasets', () => {
  const ctx = analysisPromptContext({ goal: 'why' }, { handles: [], deviceIds: ['d1', 'd2'], region: 'eu', scope: { kind: 'org', siteId: null, deviceCount: 2 }, exportGrants: GRANTS });
  const task = buildAgentRunTaskPrompt(ctx_({ profile: 'analysis', device: null, alert: null, analysis: ctx }));
  expect(task).toContain('Device scope: the whole organization (2 devices, frozen at launch).');
  expect(task).not.toContain('d1');
  expect(task).toContain('Datasets you may export with export_dataset (JSON): ["event_logs","metrics"]');
  expect(task).toContain('Rows withheld from those exports (JSON): ["security_events"]');
});
it('a site frame names the site id', () => {
  const ctx = analysisPromptContext({ goal: 'why' }, { handles: [], deviceIds: ['d1'], region: 'eu', scope: { kind: 'site', siteId: 'site-1', deviceCount: 1 }, exportGrants: { datasets: ['metrics'], sensitiveGates: [] } });
  const task = buildAgentRunTaskPrompt(ctx_({ profile: 'analysis', device: null, alert: null, analysis: ctx }));
  expect(task).toContain('Device scope: one site, site-1 (1 devices, frozen at launch).');
  expect(task).not.toContain('Rows withheld');
});
it('a pre-W02 run (no scope, no grants) renders the device-id list and no dataset line', () => {
  const ctx = analysisPromptContext({ goal: 'why' }, { handles: [], deviceIds: ['d1'], region: 'eu' });
  expect(ctx.scope).toBeNull();
  expect(ctx.exportGrants).toBeNull();
  const task = buildAgentRunTaskPrompt(ctx_({ profile: 'analysis', device: null, alert: null, analysis: ctx }));
  expect(task).toContain('Admission-frozen device IDs (JSON): ["d1"]');
  expect(task).not.toContain('Datasets you may export');
});
it('scope is read from staged_inputs only, never from trigger_ref', () => {
  expect(analysisPromptContext({ goal: 'why', scope: { kind: 'org' } }, { handles: [], deviceIds: [], region: 'eu' }).scope).toBeNull();
});
```

`ctx_` is the file's existing `ctx(overrides)` factory (`runnerPrompt.test.ts:28`). It is renamed here only because these tests name a local `ctx`; in the file, name the local `analysis` and call `ctx(...)`. `buildAgentRunTaskPrompt` is already imported there.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/aiAgents/runnerPrompt.test.ts`
Expected: FAIL. The org frame still prints `Admission-frozen device IDs`; `ctx.scope` is undefined.

- [ ] **Step 3: Implement** the context fields and the lines above.

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/api && npx vitest run src/services/aiAgents/runnerPrompt.test.ts src/services/aiAgents/runLoop.analysis.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiAgents/runnerPrompt.ts apps/api/src/services/aiAgents/runnerPrompt.test.ts
git commit -m "feat(api): analysis task prompt states the frame and the exportable datasets (W02)"
```

---

### Task 10: Wave verification: contract suites and typecheck

**Files:** none changed unless a step fails.

- [ ] **Step 1: Shared package**

Run: `cd packages/shared && npx vitest run && npx tsc --noEmit; echo "exit $?"`
Expected: all tests pass, `exit 0`.

- [ ] **Step 2: API unit suites this wave touches, plus the unit contract suites**

Run:
```bash
cd apps/api && npx vitest run src/services/aiAgents src/services/wisp src/services/aiToolsExport src/services/aiToolsExportPermissions.test.ts src/services/aiToolsSiteScope src/services/aiToolsWisp src/services/aiAgentSdk.wispCeiling.test.ts src/services/automationRuntime.aiTriage.test.ts src/__tests__/parkedFanout.contract.test.ts src/services/aiTools.userOwnedRelease.contract.test.ts src/services/aiTools.descriptionBudget.contract.test.ts
```
Expected: PASS. Check the reported file count includes `analysisFrame.test.ts` and `aiToolsExportPermissions.test.ts`; vitest filters are substring matches.

- [ ] **Step 3: Full API unit suite**

Run: `cd apps/api && npx vitest run`
Expected: PASS. A fixture that builds a full `AiAgentLimits` or launches `analysis` without a scope is a test to update, not a reason to loosen the code.

- [ ] **Step 4: Integration (real Postgres)**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/analysisFrame.integration.test.ts src/__tests__/integration/aiAgentEffectivePolicy.integration.test.ts
pnpm --filter=@breeze/api test:integration-suite-coverage
pnpm test-stack down
```
Expected: PASS. There is no new table or column, so the org-cascade and export-policy contracts are unaffected (`staged_inputs` is already `excludedOpen`). They still run in CI's Integration Tests job.

- [ ] **Step 5: Typecheck (12 GB heap, check tsc's own exit code)**

Run: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "tsc exit $?"`
Expected: `tsc exit 0`. Do not pipe to `tail`.

- [ ] **Step 6: Commit any fixture fixes**

```bash
git add -A apps/api/src packages/shared/src
git commit -m "test(api): fixtures carry an analysis scope and the v17 limit (W02)"
```
Skip this step if nothing changed.
