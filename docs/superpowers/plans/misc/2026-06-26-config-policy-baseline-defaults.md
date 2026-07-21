# Config Policy Baseline "Breeze Defaults" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface a read-only, virtual "Breeze Defaults" baseline at the bottom of the configuration-policy hierarchy so admins can see how unassigned devices behave out of the box, sourced from a single canonical defaults module.

**Architecture:** A new canonical defaults module (`policyBaselineDefaults.ts`) becomes the single source of truth for the applied no-policy defaults (`remote_access`, `pam`); the live enforcement paths import from it. `resolveEffectiveConfig` gains an opt-in `includeBaseline` flag that synthesizes a `sourceLevel: 'default'` layer for unconfigured features (existing callers unchanged). A new read-only `GET /baseline` endpoint and a dedicated web page surface the full registry; the per-device effective-config view labels fall-through features as "Breeze Defaults".

**Tech Stack:** Hono (API), Drizzle (no schema changes — baseline is virtual), Vitest (API), Astro + React + Tailwind + lucide-react (web), Vitest + jsdom (web).

## Global Constraints

- **No DB migration.** The baseline is a virtual resolution-layer; no rows are created or seeded. Do not add tables, columns, or seed data.
- **Single source of truth.** Applied defaults (`remote_access`, `pam`) live ONLY in `apps/api/src/services/policyBaselineDefaults.ts`. `remoteAccessPolicy.ts` and `pamSettings.ts` import from it — no duplicated literals.
- **`ConfigAssignmentLevel` is NOT widened.** You still cannot *assign* at `'default'`. Only `ResolvedFeature.sourceLevel` and the inheritance-chain `level` widen to `ConfigAssignmentLevel | 'default'`.
- **`includeBaseline` defaults to `false`.** Every existing caller of `resolveEffectiveConfig` must keep its current behavior (the `features` map contains only real winners). Only the `GET /effective/:deviceId` route opts in.
- **Runtime-behavior semantics.** The baseline shows what actually happens to an unassigned device: `remote_access` ON, `pam` `uacInterceptionEnabled: false`, everything else "Not enforced". Not form-fill/schema defaults.
- **Scope = config-policy feature types only.** The 17 members of `ConfigFeatureType`. Out-of-band defaults (AI/SSO/portal/OneDrive) are explicitly out of scope.
- **Display labels live in the API baseline response.** The web `FeatureType` union is missing `onedrive_helper`; the baseline page renders whatever `GET /baseline` returns (label + value + behavior) rather than mapping enum→label client-side.
- Spec: `docs/superpowers/specs/misc/2026-06-26-config-policy-baseline-defaults-design.md`. Issue: #1725.

---

### Task 1: Canonical defaults module + feature-type list

Establishes the single source of truth and a runtime feature-type list (so both the contract test and the resolver synthesis loop can iterate the 17 types).

**Files:**
- Modify: `apps/api/src/services/configurationPolicy.ts:70` (convert `type ConfigFeatureType` to a const-array-derived, exported type)
- Create: `apps/api/src/services/policyBaselineDefaults.ts`
- Test: `apps/api/src/services/policyBaselineDefaults.test.ts`

**Interfaces:**
- Consumes: nothing (foundation task).
- Produces:
  - `export const CONFIG_FEATURE_TYPES: readonly ConfigFeatureType[]` and `export type ConfigFeatureType = typeof CONFIG_FEATURE_TYPES[number]` in `configurationPolicy.ts`.
  - In `policyBaselineDefaults.ts`:
    - `export interface RemoteAccessSettings` is NOT redefined here — import the type from `remoteAccessPolicy.ts` (type-only).
    - `export type BaselineEntry = { featureType: ConfigFeatureType; label: string; applied: boolean; inlineSettings: Record<string, unknown> | null; behavior: string }`
    - `export function getRemoteAccessBaseline(): RemoteAccessSettings`
    - `export function getPamBaseline(): { uacInterceptionEnabled: boolean }`
    - `export function getPolicyBaselineDefaults(): BaselineEntry[]` (one entry per feature type, in `CONFIG_FEATURE_TYPES` order)

- [ ] **Step 1: Export a runtime feature-type list in `configurationPolicy.ts`**

Replace line 70:
```ts
type ConfigFeatureType = 'patch' | 'alert_rule' | 'backup' | 'security' | 'monitoring' | 'maintenance' | 'compliance' | 'automation' | 'event_log' | 'software_policy' | 'sensitive_data' | 'peripheral_control' | 'warranty' | 'helper' | 'remote_access' | 'pam' | 'onedrive_helper';
```
with:
```ts
export const CONFIG_FEATURE_TYPES = [
  'patch', 'alert_rule', 'backup', 'security', 'monitoring', 'maintenance',
  'compliance', 'automation', 'event_log', 'software_policy', 'sensitive_data',
  'peripheral_control', 'warranty', 'helper', 'remote_access', 'pam', 'onedrive_helper',
] as const;
export type ConfigFeatureType = typeof CONFIG_FEATURE_TYPES[number];
```

- [ ] **Step 2: Write the failing contract test**

Create `apps/api/src/services/policyBaselineDefaults.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { CONFIG_FEATURE_TYPES } from './configurationPolicy';
import { getPolicyBaselineDefaults, getRemoteAccessBaseline, getPamBaseline } from './policyBaselineDefaults';

describe('policyBaselineDefaults', () => {
  it('has exactly one entry per ConfigFeatureType', () => {
    const entries = getPolicyBaselineDefaults();
    const types = entries.map((e) => e.featureType).sort();
    expect(types).toEqual([...CONFIG_FEATURE_TYPES].sort());
    expect(entries.length).toBe(CONFIG_FEATURE_TYPES.length);
  });

  it('marks remote_access as applied with desktop/vnc/tools ON', () => {
    const entry = getPolicyBaselineDefaults().find((e) => e.featureType === 'remote_access')!;
    expect(entry.applied).toBe(true);
    expect(entry.inlineSettings).toMatchObject({ webrtcDesktop: true, vncRelay: true, remoteTools: true });
  });

  it('marks pam as applied with UAC interception OFF (opt-in)', () => {
    const entry = getPolicyBaselineDefaults().find((e) => e.featureType === 'pam')!;
    expect(entry.applied).toBe(true);
    expect(entry.inlineSettings).toEqual({ uacInterceptionEnabled: false });
  });

  it('marks patch (and other unenforced features) as not applied', () => {
    const entry = getPolicyBaselineDefaults().find((e) => e.featureType === 'patch')!;
    expect(entry.applied).toBe(false);
    expect(entry.inlineSettings).toBeNull();
    expect(entry.behavior.length).toBeGreaterThan(0);
  });

  it('getRemoteAccessBaseline returns the full settings shape', () => {
    const s = getRemoteAccessBaseline();
    expect(s.webrtcDesktop).toBe(true);
    expect(s.maxConcurrentTunnels).toBe(5);
    expect(s.idleTimeoutMinutes).toBe(5);
    expect(s.maxSessionDurationHours).toBe(8);
  });

  it('getPamBaseline returns UAC off', () => {
    expect(getPamBaseline()).toEqual({ uacInterceptionEnabled: false });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/services/policyBaselineDefaults.test.ts`
Expected: FAIL — cannot resolve `./policyBaselineDefaults`.

- [ ] **Step 4: Create the module**

Create `apps/api/src/services/policyBaselineDefaults.ts`:
```ts
/**
 * Canonical "Breeze Defaults" — the single source of truth for how an UNASSIGNED
 * device behaves (no config policy anywhere in its hierarchy). Surfaced read-only
 * in the UI as the bottom of the assignment hierarchy (#1725).
 *
 * Semantics = runtime behavior, not form-fill values. Most feature types are
 * "Not enforced" (their resolvers return null/[] with no policy). Only
 * remote_access and pam carry applied defaults — and those are imported BY the
 * enforcement paths (remoteAccessPolicy.ts / pamSettings.ts) so there is exactly
 * one definition each.
 */
import { CONFIG_FEATURE_TYPES, type ConfigFeatureType } from './configurationPolicy';
import type { RemoteAccessSettings } from './remoteAccessPolicy';

export interface BaselineEntry {
  featureType: ConfigFeatureType;
  label: string;
  /** Does anything actually apply to an unassigned device? */
  applied: boolean;
  /** Resolved settings when applied; null when "Not enforced". */
  inlineSettings: Record<string, unknown> | null;
  /** Human-readable behavior label for the UI. */
  behavior: string;
}

// Hosted multi-tenant SaaS defaults the silent-exfil direction (remote host
// clipboard → operator viewer) OFF. Self-hosted preserves the historical
// bidirectional default. Mirrors the rationale in remoteAccessPolicy.ts.
const isHosted = process.env.IS_HOSTED === 'true';

export function getRemoteAccessBaseline(): RemoteAccessSettings {
  return {
    webrtcDesktop: true,
    vncRelay: true,
    remoteTools: true,
    clipboardHostToViewer: !isHosted,
    clipboardViewerToHost: true,
    enableProxy: true,
    defaultAllowedPorts: [],
    autoEnableProxy: false,
    maxConcurrentTunnels: 5,
    idleTimeoutMinutes: 5,
    maxSessionDurationHours: 8,
  };
}

export function getPamBaseline(): { uacInterceptionEnabled: boolean } {
  return { uacInterceptionEnabled: false };
}

// label + behavior + applied/inlineSettings for every feature type. Order
// follows CONFIG_FEATURE_TYPES. "Not enforced" entries describe the real-world
// effect of having no policy.
const NOT_ENFORCED: Record<Exclude<ConfigFeatureType, 'remote_access' | 'pam'>, { label: string; behavior: string }> = {
  patch:             { label: 'Patches',            behavior: 'Not enforced — no patch deployments are created from policy.' },
  alert_rule:        { label: 'Alerts',             behavior: 'Not enforced — no policy alert rules fire.' },
  backup:            { label: 'Backup',             behavior: 'Not enforced — no backups are scheduled.' },
  security:          { label: 'Security',           behavior: 'Not enforced — no security posture is applied.' },
  monitoring:        { label: 'Monitoring',         behavior: 'Not enforced — no service/process monitoring runs.' },
  maintenance:       { label: 'Maintenance',        behavior: 'Not enforced — no maintenance windows apply.' },
  compliance:        { label: 'Compliance',         behavior: 'Not enforced — no compliance checks run.' },
  automation:        { label: 'Automations',        behavior: 'Not enforced — no automations execute.' },
  event_log:         { label: 'Event Logs',         behavior: 'Not enforced — no event-log collection tuning applies.' },
  software_policy:   { label: 'Software Policy',     behavior: 'Not enforced — no allow/block software rules apply.' },
  sensitive_data:    { label: 'Data Discovery',     behavior: 'Not enforced — no sensitive-data scans run.' },
  peripheral_control:{ label: 'Peripheral Control', behavior: 'Not enforced — peripherals are unrestricted.' },
  warranty:          { label: 'Warranty',           behavior: 'Not enforced — no warranty alerts apply.' },
  helper:            { label: 'Breeze Assist',      behavior: 'Not enforced — Breeze Assist uses its built-in defaults.' },
  onedrive_helper:   { label: 'OneDrive Helper',    behavior: 'Not enforced — no OneDrive helper config applies.' },
};

export function getPolicyBaselineDefaults(): BaselineEntry[] {
  return CONFIG_FEATURE_TYPES.map((ft): BaselineEntry => {
    if (ft === 'remote_access') {
      return {
        featureType: ft,
        label: 'Remote Access',
        applied: true,
        inlineSettings: getRemoteAccessBaseline() as unknown as Record<string, unknown>,
        behavior: 'Remote Desktop, VNC, and Remote Tools are ON by default; session limits apply.',
      };
    }
    if (ft === 'pam') {
      return {
        featureType: ft,
        label: 'Privileged Access',
        applied: true,
        inlineSettings: getPamBaseline(),
        behavior: 'UAC elevation capture is OFF by default (opt-in via a policy).',
      };
    }
    const meta = NOT_ENFORCED[ft];
    return { featureType: ft, label: meta.label, applied: false, inlineSettings: null, behavior: meta.behavior };
  });
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @breeze/api exec vitest run src/services/policyBaselineDefaults.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Typecheck the API package**

Run: `pnpm --filter @breeze/api exec tsc --noEmit`
Expected: no new errors. (The `ConfigFeatureType` change is widening a private type to an exported one; existing usages still compile.)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/policyBaselineDefaults.ts apps/api/src/services/policyBaselineDefaults.test.ts apps/api/src/services/configurationPolicy.ts
git commit -m "feat(config-policy): canonical baseline defaults module (#1725)"
```

---

### Task 2: Source remote_access enforcement defaults from the canonical module

Makes `remoteAccessPolicy.ts` use `getRemoteAccessBaseline()` instead of its private `DEFAULTS` const — single source of truth — and proves the permissive defaults did not change (security-sensitive).

**Files:**
- Modify: `apps/api/src/services/remoteAccessPolicy.ts:58-72` (remove inline `DEFAULTS`, derive from module)
- Create: `apps/api/src/services/remoteAccessPolicy.test.ts`

**Interfaces:**
- Consumes: `getRemoteAccessBaseline()` from Task 1.
- Produces: no signature changes — `resolveRemoteAccessForDevice`, `checkRemoteAccess`, `RemoteAccessSettings` unchanged.

- [ ] **Step 1: Write the failing regression test**

Create `apps/api/src/services/remoteAccessPolicy.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { getRemoteAccessBaseline } from './policyBaselineDefaults';

// Guards the security-sensitive default: Remote Desktop / VNC / Remote Tools
// must stay ON-by-default after sourcing DEFAULTS from the canonical module.
describe('remote access baseline defaults (single source of truth)', () => {
  it('keeps the permissive remote capabilities ON by default', () => {
    const d = getRemoteAccessBaseline();
    expect(d.webrtcDesktop).toBe(true);
    expect(d.vncRelay).toBe(true);
    expect(d.remoteTools).toBe(true);
    expect(d.enableProxy).toBe(true);
    expect(d.autoEnableProxy).toBe(false);
    expect(d.maxConcurrentTunnels).toBe(5);
    expect(d.idleTimeoutMinutes).toBe(5);
    expect(d.maxSessionDurationHours).toBe(8);
    expect(d.clipboardViewerToHost).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it passes against Task 1's module**

Run: `pnpm --filter @breeze/api exec vitest run src/services/remoteAccessPolicy.test.ts`
Expected: PASS (the module from Task 1 already provides these values). This test exists to lock the values; the refactor below must keep it green.

- [ ] **Step 3: Refactor `remoteAccessPolicy.ts` to use the module**

In `apps/api/src/services/remoteAccessPolicy.ts`, add the import near the top (after the existing imports, around line 13):
```ts
import { getRemoteAccessBaseline } from './policyBaselineDefaults';
```

Delete the `isHosted` const and the entire `DEFAULTS` literal (lines 50-72, the block of comment + `const isHosted` + `const DEFAULTS: RemoteAccessSettings = { ... };`) and replace with:
```ts
// Applied defaults for an unassigned device live in the canonical baseline
// module (single source of truth, #1725). isHosted-dependent clipboard default
// is encoded there.
const DEFAULTS: RemoteAccessSettings = getRemoteAccessBaseline();
```
Leave `clampSettings`, the cache, `resolveRemoteAccessForDevice`, and `checkRemoteAccess` untouched — they keep referencing the local `DEFAULTS`.

- [ ] **Step 4: Run the regression test + the existing remote-access resolver tests**

Run: `pnpm --filter @breeze/api exec vitest run src/services/remoteAccessPolicy.test.ts src/services/configurationPolicy.remoteAccess.test.ts`
Expected: PASS for both.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @breeze/api exec tsc --noEmit`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/remoteAccessPolicy.ts apps/api/src/services/remoteAccessPolicy.test.ts
git commit -m "refactor(config-policy): source remote_access defaults from baseline module (#1725)"
```

---

### Task 3: Source pam enforcement defaults from the canonical module

Makes `pamSettings.ts` derive `PAM_DEFAULTS` from `getPamBaseline()` so the baseline display and enforcement agree. `helpers.ts` keeps importing `PAM_DEFAULTS` from `pamSettings.ts` (no change there).

**Files:**
- Modify: `apps/api/src/routes/agents/pamSettings.ts:21-23`
- Test: reuse `apps/api/src/services/policyBaselineDefaults.test.ts` (already asserts pam OFF) — add one assertion tying `PAM_DEFAULTS` to the module.

**Interfaces:**
- Consumes: `getPamBaseline()` from Task 1.
- Produces: `PAM_DEFAULTS` retains its type `PamSettings` and value `{ uacInterceptionEnabled: false }`.

- [ ] **Step 1: Write the failing test (tie-through assertion)**

Append to `apps/api/src/services/policyBaselineDefaults.test.ts`:
```ts
import { PAM_DEFAULTS } from '../routes/agents/pamSettings';

describe('pam defaults single source of truth', () => {
  it('PAM_DEFAULTS equals the canonical pam baseline', () => {
    expect(PAM_DEFAULTS).toEqual(getPamBaseline());
  });
});
```

- [ ] **Step 2: Run to verify it passes (values already match) — then make the source single**

Run: `pnpm --filter @breeze/api exec vitest run src/services/policyBaselineDefaults.test.ts`
Expected: PASS (values match today). The refactor below removes the duplicated literal.

- [ ] **Step 3: Refactor `pamSettings.ts`**

Replace lines 21-23:
```ts
export const PAM_DEFAULTS: PamSettings = {
  uacInterceptionEnabled: false,
};
```
with:
```ts
import { getPamBaseline } from '../../services/policyBaselineDefaults';

export const PAM_DEFAULTS: PamSettings = getPamBaseline();
```
(Place the `import` with the other imports at the top of the file, not inline — move it above the `PamSettings` interface. Keep the explanatory comment block at lines 12-20.)

- [ ] **Step 4: Run the test + existing pam/helper tests**

Run: `pnpm --filter @breeze/api exec vitest run src/services/policyBaselineDefaults.test.ts src/routes/agents/pamSettings.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck (watch for import cycles)**

Run: `pnpm --filter @breeze/api exec tsc --noEmit`
Expected: no new errors. (`policyBaselineDefaults` imports `pamSettings` only in the test file, and `pamSettings` imports `getPamBaseline` as a value — `getPamBaseline` does not import `pamSettings`, so no runtime cycle.)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/agents/pamSettings.ts apps/api/src/services/policyBaselineDefaults.test.ts
git commit -m "refactor(config-policy): source pam defaults from baseline module (#1725)"
```

---

### Task 4: `includeBaseline` option on `resolveEffectiveConfig`

Adds the opt-in synthetic `'default'` layer to the resolver. Default off → existing callers unaffected.

**Files:**
- Modify: `apps/api/src/services/configurationPolicy.ts` — `ResolvedFeature` (81-90), `EffectiveConfiguration` (94-105), `resolveEffectiveConfigWithExecutor` (1192-1349), `resolveEffectiveConfig` (1351-1353).
- Test: `apps/api/src/services/configurationPolicy.baseline.test.ts`

**Interfaces:**
- Consumes: `getPolicyBaselineDefaults()` from Task 1.
- Produces:
  - `ResolvedFeature.sourceLevel: ConfigAssignmentLevel | 'default'`
  - `EffectiveConfiguration.inheritanceChain[].level: ConfigAssignmentLevel | 'default'`
  - `resolveEffectiveConfig(deviceId, auth, opts?: { includeBaseline?: boolean })`
  - When `includeBaseline` is true: every `ConfigFeatureType` absent from real winners gets a synthetic `ResolvedFeature` with `sourceLevel: 'default'`, `sourcePolicyId: 'breeze-defaults'`, `sourcePolicyName: 'Breeze Defaults'`, `sourceTargetId: 'breeze-defaults'`, `sourcePriority: 0`, `featurePolicyId: null`, `inlineSettings` from the baseline entry (or `null` for not-enforced). A single inheritance-chain node `{ level: 'default', policyId: 'breeze-defaults', policyName: 'Breeze Defaults', targetId: 'breeze-defaults', priority: 0, featureTypes: [<all synthesized types>] }` is appended last.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/configurationPolicy.baseline.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';

// We test the pure synthesis behavior by exercising resolveEffectiveConfig with
// includeBaseline against a device that has NO assignments. The DB layer is
// mocked to return a device with no policy rows.
vi.mock('../db', () => {
  const chain = (rows: unknown[]) => {
    const b: any = {};
    for (const m of ['select','from','where','innerJoin','orderBy','limit']) b[m] = () => b;
    b.then = (r: (v: unknown) => void) => r(rows);
    return b;
  };
  // device row, org row, no group memberships, no assignment rows
  let call = 0;
  const db: any = {
    select: () => {
      call += 1;
      if (call === 1) return chain([{ id: 'dev-1', orgId: 'org-1', siteId: 'site-1', deviceRole: 'workstation', osType: 'windows' }]);
      if (call === 2) return chain([{ partnerId: 'ptr-1' }]);
      if (call === 3) return chain([]); // group memberships
      return chain([]); // assignments join
    },
  };
  return { db };
});

import { resolveEffectiveConfig } from './configurationPolicy';
import type { AuthContext } from '../middleware/auth';

const systemAuth = {
  user: { id: 'system', email: 'system', name: 'System', isPlatformAdmin: false },
  token: {} as any, partnerId: null, orgId: null, scope: 'system',
  accessibleOrgIds: null, orgCondition: () => undefined, canAccessOrg: () => true,
} as unknown as AuthContext;

describe('resolveEffectiveConfig includeBaseline', () => {
  it('omits baseline by default (features empty for unassigned device)', async () => {
    const r = await resolveEffectiveConfig('dev-1', systemAuth);
    expect(r).not.toBeNull();
    expect(Object.keys(r!.features)).toHaveLength(0);
    expect(r!.inheritanceChain).toHaveLength(0);
  });

  it('synthesizes the default layer when includeBaseline is true', async () => {
    const r = await resolveEffectiveConfig('dev-1', systemAuth, { includeBaseline: true });
    expect(r).not.toBeNull();
    const ra = r!.features.remote_access;
    expect(ra.sourceLevel).toBe('default');
    expect(ra.sourcePolicyName).toBe('Breeze Defaults');
    expect((ra.inlineSettings as Record<string, unknown>).webrtcDesktop).toBe(true);
    expect(r!.features.patch.sourceLevel).toBe('default');
    expect(r!.features.patch.inlineSettings).toBeNull();
    const defaultNode = r!.inheritanceChain.find((n) => n.level === 'default');
    expect(defaultNode).toBeTruthy();
    expect(defaultNode!.policyName).toBe('Breeze Defaults');
  });
});
```

> Note: if the existing `configurationPolicy.test.ts` already establishes a richer DB-mock harness, mirror that harness instead of the inline mock above — match the file's established pattern. The assertions stay the same.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @breeze/api exec vitest run src/services/configurationPolicy.baseline.test.ts`
Expected: FAIL — `resolveEffectiveConfig` ignores the third arg; `features` is empty even with `includeBaseline`.

- [ ] **Step 3: Widen the source-level types**

In `configurationPolicy.ts`, change `ResolvedFeature.sourceLevel` (line 85):
```ts
  sourceLevel: ConfigAssignmentLevel | 'default';
```
and the inheritance-chain `level` (line 98):
```ts
    level: ConfigAssignmentLevel | 'default';
```

- [ ] **Step 4: Thread the option through both entry points**

Replace `resolveEffectiveConfig` (lines 1351-1353):
```ts
export async function resolveEffectiveConfig(
  deviceId: string,
  auth: AuthContext,
  opts?: { includeBaseline?: boolean }
): Promise<EffectiveConfiguration | null> {
  return resolveEffectiveConfigWithExecutor(db, deviceId, auth, opts);
}
```
Update the `resolveEffectiveConfigWithExecutor` signature (line 1192-1196):
```ts
async function resolveEffectiveConfigWithExecutor(
  executor: DbExecutor,
  deviceId: string,
  auth: AuthContext,
  opts?: { includeBaseline?: boolean }
): Promise<EffectiveConfiguration | null> {
```
And in `previewEffectiveConfig`, the internal call at line 1396 stays as-is (no baseline for diffs).

- [ ] **Step 5: Synthesize the baseline before returning**

Add this import at the top of `configurationPolicy.ts` (with the other service imports):
```ts
import { getPolicyBaselineDefaults } from './policyBaselineDefaults';
```
Then replace the final `return { deviceId, features, inheritanceChain };` (line 1348) with:
```ts
  if (opts?.includeBaseline) {
    const synthesized: ConfigFeatureType[] = [];
    for (const entry of getPolicyBaselineDefaults()) {
      if (features[entry.featureType]) continue;
      features[entry.featureType] = {
        featureType: entry.featureType,
        featurePolicyId: null,
        inlineSettings: entry.inlineSettings,
        sourceLevel: 'default',
        sourceTargetId: 'breeze-defaults',
        sourcePolicyId: 'breeze-defaults',
        sourcePolicyName: 'Breeze Defaults',
        sourcePriority: 0,
      };
      synthesized.push(entry.featureType);
    }
    if (synthesized.length > 0) {
      inheritanceChain.push({
        level: 'default',
        targetId: 'breeze-defaults',
        policyId: 'breeze-defaults',
        policyName: 'Breeze Defaults',
        priority: 0,
        featureTypes: synthesized,
      });
    }
  }

  return { deviceId, features, inheritanceChain };
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @breeze/api exec vitest run src/services/configurationPolicy.baseline.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the broader config-policy suite to confirm no regression**

Run: `pnpm --filter @breeze/api exec vitest run src/services/configurationPolicy.test.ts src/services/configurationPolicy.remoteAccess.test.ts src/services/configurationPolicy.onedrive.test.ts src/services/aiToolsConfigPolicy.test.ts`
Expected: PASS (existing callers pass no `opts`, so behavior is unchanged).

- [ ] **Step 8: Typecheck + commit**

Run: `pnpm --filter @breeze/api exec tsc --noEmit`
Expected: no new errors.
```bash
git add apps/api/src/services/configurationPolicy.ts apps/api/src/services/configurationPolicy.baseline.test.ts
git commit -m "feat(config-policy): opt-in baseline layer in resolveEffectiveConfig (#1725)"
```

---

### Task 5: API surface — `GET /baseline` + opt-in on `GET /effective/:deviceId`

Exposes the static baseline registry for the dedicated page and makes the per-device effective endpoint surface the baseline layer.

**Files:**
- Modify: `apps/api/src/routes/configurationPolicies/resolution.ts` (add `GET /baseline`; pass `includeBaseline: true` at line 57)
- Test: `apps/api/src/routes/configurationPolicies/resolution.test.ts` (create if absent; otherwise extend)

**Interfaces:**
- Consumes: `getPolicyBaselineDefaults()` (Task 1), `resolveEffectiveConfig(..., { includeBaseline: true })` (Task 4).
- Produces: `GET /configuration-policies/baseline` → `{ features: BaselineEntry[] }`.

- [ ] **Step 1: Write the failing route test**

Create `apps/api/src/routes/configurationPolicies/resolution.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { getPolicyBaselineDefaults } from '../../services/policyBaselineDefaults';

// The handler returns the static registry verbatim. We assert the registry's
// shape is what the endpoint will serialize (no DB needed).
describe('GET /baseline payload shape', () => {
  it('returns every feature with label/applied/behavior', () => {
    const features = getPolicyBaselineDefaults();
    expect(features.length).toBeGreaterThanOrEqual(17);
    for (const f of features) {
      expect(typeof f.label).toBe('string');
      expect(typeof f.behavior).toBe('string');
      expect(typeof f.applied).toBe('boolean');
    }
    const ra = features.find((f) => f.featureType === 'remote_access')!;
    expect(ra.applied).toBe(true);
  });
});
```

> If the repo has an established Hono route-test harness (look at `crud.test.ts` / `assignments.test.ts` in the same folder), add an integration-style test that mounts `resolutionRoutes` and asserts `GET /baseline` returns 200 with the registry, following that harness. Keep the payload-shape test above regardless.

- [ ] **Step 2: Run to verify it passes (shape) — fails later steps drive the route**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/configurationPolicies/resolution.test.ts`
Expected: PASS for the shape test.

- [ ] **Step 3: Add the `GET /baseline` route**

In `resolution.ts`, add the import:
```ts
import { resolveEffectiveConfig, previewEffectiveConfig } from '../../services/configurationPolicy';
import { getPolicyBaselineDefaults } from '../../services/policyBaselineDefaults';
```
Add the route after the `resolutionRoutes` / `requireConfigPolicyRead` declarations (before `GET /effective/:deviceId`):
```ts
// GET /baseline — static "Breeze Defaults" registry (read-only, no tenant data)
resolutionRoutes.get(
  '/baseline',
  requireScope('organization', 'partner', 'system'),
  requireConfigPolicyRead,
  (c) => c.json({ features: getPolicyBaselineDefaults() })
);
```
> `GET /baseline` is a static path and must be registered before `/:id` catches it — it lives in `resolutionRoutes`, which `index.ts` already mounts before `crudRoutes` (line 14), so ordering is satisfied.

- [ ] **Step 4: Opt the effective endpoint into the baseline**

In `resolution.ts`, change line 57:
```ts
    const result = await resolveEffectiveConfig(deviceId, auth, { includeBaseline: true });
```

- [ ] **Step 5: Run the test + typecheck**

Run: `pnpm --filter @breeze/api exec vitest run src/routes/configurationPolicies/resolution.test.ts && pnpm --filter @breeze/api exec tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/configurationPolicies/resolution.ts apps/api/src/routes/configurationPolicies/resolution.test.ts
git commit -m "feat(config-policy): /baseline endpoint + baseline on /effective (#1725)"
```

---

### Task 6: Web — dedicated read-only "Breeze Defaults" page

Lists every feature's baseline value + behavior with a "Create override policy" deep-link per row.

**Files:**
- Create: `apps/web/src/components/configurationPolicies/BreezeDefaultsPage.tsx`
- Create: `apps/web/src/pages/configuration-policies/defaults.astro`
- Modify: `apps/web/src/components/configurationPolicies/ConfigurationPoliciesPage.tsx` (header link to the defaults page)
- Test: `apps/web/src/components/configurationPolicies/BreezeDefaultsPage.test.tsx`

**Interfaces:**
- Consumes: `GET /configuration-policies/baseline` → `{ features: Array<{ featureType: string; label: string; applied: boolean; inlineSettings: Record<string, unknown> | null; behavior: string }> }`.
- Produces: a page reachable at `/configuration-policies/defaults`.

- [ ] **Step 1: Write the failing component test**

Create `apps/web/src/components/configurationPolicies/BreezeDefaultsPage.test.tsx`:
```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import BreezeDefaultsPage from './BreezeDefaultsPage';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(async () => ({
    ok: true,
    json: async () => ({
      features: [
        { featureType: 'remote_access', label: 'Remote Access', applied: true,
          inlineSettings: { webrtcDesktop: true, vncRelay: true, remoteTools: true }, behavior: 'Remote Desktop, VNC, and Remote Tools are ON by default; session limits apply.' },
        { featureType: 'patch', label: 'Patches', applied: false, inlineSettings: null, behavior: 'Not enforced — no patch deployments are created from policy.' },
      ],
    }),
  })),
}));

describe('BreezeDefaultsPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the applied remote access default and its behavior', async () => {
    render(<BreezeDefaultsPage />);
    await waitFor(() => expect(screen.getByText('Remote Access')).toBeInTheDocument());
    expect(screen.getByText(/Remote Desktop, VNC, and Remote Tools are ON/)).toBeInTheDocument();
  });

  it('renders a not-enforced feature and a create-override link', async () => {
    render(<BreezeDefaultsPage />);
    await waitFor(() => expect(screen.getByText('Patches')).toBeInTheDocument());
    expect(screen.getByText(/Not enforced/)).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: /create override/i });
    expect(links.length).toBeGreaterThanOrEqual(2);
    expect(links[0]).toHaveAttribute('href', expect.stringContaining('/configuration-policies/new'));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @breeze/web exec vitest run src/components/configurationPolicies/BreezeDefaultsPage.test.tsx`
Expected: FAIL — cannot resolve `./BreezeDefaultsPage`.

- [ ] **Step 3: Create the page component**

Create `apps/web/src/components/configurationPolicies/BreezeDefaultsPage.tsx`:
```tsx
import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, Layers } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { friendlyFetchError } from '../../lib/utils';

type BaselineFeature = {
  featureType: string;
  label: string;
  applied: boolean;
  inlineSettings: Record<string, unknown> | null;
  behavior: string;
};

function summarize(settings: Record<string, unknown> | null): string[] {
  if (!settings) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(settings)) {
    if (v === null || v === undefined) continue;
    const label = k.replace(/_/g, ' ').replace(/([A-Z])/g, ' $1').trim().toLowerCase();
    if (typeof v === 'boolean') out.push(`${label}: ${v ? 'on' : 'off'}`);
    else if (typeof v === 'string' || typeof v === 'number') out.push(`${label}: ${v}`);
    else if (Array.isArray(v)) out.push(`${label}: ${v.length} item${v.length !== 1 ? 's' : ''}`);
    if (out.length >= 6) break;
  }
  return out;
}

export default function BreezeDefaultsPage() {
  const [features, setFeatures] = useState<BaselineFeature[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const res = await fetchWithAuth('/configuration-policies/baseline');
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = await res.json();
      setFeatures(Array.isArray(data.features) ? data.features : []);
    } catch (err) {
      setError(friendlyFetchError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-card py-12 shadow-sm">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button type="button" onClick={load} className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">Retry</button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Layers className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">Breeze Defaults</h2>
          <p className="text-sm text-muted-foreground">
            How devices behave out of the box with no configuration policy assigned. These are
            read-only — create a policy to override any of them.
          </p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {features.map((f) => {
          const settings = summarize(f.inlineSettings);
          return (
            <div key={f.featureType} className="rounded-lg border bg-card p-5 shadow-sm">
              <div className="flex items-start justify-between gap-2">
                <h4 className="font-semibold">{f.label}</h4>
                <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${f.applied ? 'bg-primary/10 text-primary' : 'bg-muted/50 text-muted-foreground'}`}>
                  {f.applied ? <ShieldCheck className="h-3 w-3" /> : null}
                  {f.applied ? 'Active default' : 'Not enforced'}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{f.behavior}</p>
              {settings.length > 0 && (
                <ul className="mt-3 space-y-0.5 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  {settings.map((s) => <li key={s} className="capitalize">{s}</li>)}
                </ul>
              )}
              <a
                href={`/configuration-policies/new?feature=${encodeURIComponent(f.featureType)}`}
                className="mt-3 inline-block text-xs font-medium text-primary hover:underline"
              >
                Create override policy
              </a>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the component test to verify it passes**

Run: `pnpm --filter @breeze/web exec vitest run src/components/configurationPolicies/BreezeDefaultsPage.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Create the Astro route**

Create `apps/web/src/pages/configuration-policies/defaults.astro`:
```astro
---
import DashboardLayout from '../../layouts/DashboardLayout.astro';
import BreezeDefaultsPage from '../../components/configurationPolicies/BreezeDefaultsPage';
---

<DashboardLayout title="Breeze Defaults">
  <BreezeDefaultsPage client:load />
</DashboardLayout>
```

- [ ] **Step 6: Add a link from the Configuration Policies page**

In `apps/web/src/components/configurationPolicies/ConfigurationPoliciesPage.tsx`, the header already imports `Layers` from lucide-react. Add an anchor next to the existing "New policy" control (search for the `Plus` button in the header JSX) so admins can reach the baseline. Add this anchor immediately before the New-policy button:
```tsx
<a
  href="/configuration-policies/defaults"
  className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted"
>
  <Layers className="h-4 w-4" />
  Breeze Defaults
</a>
```

- [ ] **Step 7: Run web typecheck + the new test**

Run: `pnpm --filter @breeze/web exec vitest run src/components/configurationPolicies/BreezeDefaultsPage.test.tsx && pnpm --filter @breeze/web exec astro check`
Expected: test PASS; `astro check` no new errors. (Note: `astro check` does not typecheck `.astro` page bodies deeply, but will catch import errors.)

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/configurationPolicies/BreezeDefaultsPage.tsx apps/web/src/components/configurationPolicies/BreezeDefaultsPage.test.tsx apps/web/src/pages/configuration-policies/defaults.astro apps/web/src/components/configurationPolicies/ConfigurationPoliciesPage.tsx
git commit -m "feat(web): read-only Breeze Defaults page (#1725)"
```

---

### Task 7: Web — label baseline source in the per-device effective-config view

When a feature resolves from the baseline, the device's Effective Configuration tab shows "Breeze Defaults" as the source instead of "No policy assigned", and the "assigned policies" count excludes the synthetic default node.

**Files:**
- Modify: `apps/web/src/components/devices/DeviceEffectiveConfigTab.tsx`
- Test: `apps/web/src/components/devices/DeviceEffectiveConfigTab.test.tsx` (create if absent)

**Interfaces:**
- Consumes: `GET /configuration-policies/effective/:deviceId` (now includes `sourceLevel: 'default'` features + a `'default'` inheritance node, from Task 5).
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/devices/DeviceEffectiveConfigTab.test.tsx`:
```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import DeviceEffectiveConfigTab from './DeviceEffectiveConfigTab';

const baselineResponse = {
  deviceId: 'dev-1',
  features: {
    patch: { featureType: 'patch', featurePolicyId: null, inlineSettings: null, sourceLevel: 'default', sourceTargetId: 'breeze-defaults', sourcePolicyId: 'breeze-defaults', sourcePolicyName: 'Breeze Defaults', sourcePriority: 0 },
    alert_rule: { featureType: 'alert_rule', featurePolicyId: null, inlineSettings: null, sourceLevel: 'default', sourceTargetId: 'breeze-defaults', sourcePolicyId: 'breeze-defaults', sourcePolicyName: 'Breeze Defaults', sourcePriority: 0 },
  },
  inheritanceChain: [
    { level: 'default', targetId: 'breeze-defaults', policyId: 'breeze-defaults', policyName: 'Breeze Defaults', priority: 0, featureTypes: ['patch', 'alert_rule'] },
  ],
};

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => baselineResponse })),
}));

describe('DeviceEffectiveConfigTab baseline labeling', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows Breeze Defaults as the source for baseline features', async () => {
    render(<DeviceEffectiveConfigTab deviceId="dev-1" />);
    await waitFor(() => expect(screen.getAllByText(/Breeze Defaults/).length).toBeGreaterThan(0));
  });

  it('reports zero assigned policies when only the baseline is present', async () => {
    render(<DeviceEffectiveConfigTab deviceId="dev-1" />);
    await waitFor(() => expect(screen.getByText(/0 assigned/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @breeze/web exec vitest run src/components/devices/DeviceEffectiveConfigTab.test.tsx`
Expected: FAIL — the component does not know the `'default'` level (`LEVEL_LABELS['default']` is undefined) and the header text says "from N assigned policies" counting the default node.

- [ ] **Step 3: Add the `'default'` level + adjust the assigned-policy count**

In `DeviceEffectiveConfigTab.tsx`:

(a) Widen `AssignmentLevel` (line 31):
```ts
type AssignmentLevel = 'partner' | 'organization' | 'site' | 'device_group' | 'device' | 'default';
```

(b) Add the label (in `LEVEL_LABELS`, after `device`):
```ts
  device: 'Device',
  default: 'Breeze Defaults',
```

(c) The header at lines 207-212 counts `inheritanceChain.length` as "assigned policies". Exclude the synthetic default node. Replace the count expression. Just before the `return (` at line 202, add:
```ts
  const assignedChain = inheritanceChain.filter((e) => e.level !== 'default');
```
Then in the header text (lines 209-212) replace `inheritanceChain.length` with `assignedChain.length` in both the count and the singular/plural check:
```tsx
            Resolved configuration from {assignedChain.length} assigned{' '}
            {assignedChain.length === 1 ? 'policy' : 'policies'} across{' '}
            {configuredTypes.length} feature{configuredTypes.length !== 1 ? 's' : ''}
```

(d) The empty-state guard at line 179 (`Object.keys(data.features).length === 0`) would no longer fire now that baseline always populates `features`. Change it to fire when there are no real (non-default) configured features, so the "No Configuration Policies" empty state still appears for genuinely-unassigned devices. Replace line 179's condition:
```ts
  const hasRealFeatures = data ? Object.values(data.features).some((f) => f.sourceLevel !== 'default') : false;
  if (!data || !hasRealFeatures) {
```
Keep the existing empty-state JSX, but add a link to the new Breeze Defaults page inside it (after the existing "Go to Config Policies" anchor):
```tsx
        <a
          href="/configuration-policies/defaults"
          className="mt-2 inline-block text-sm font-medium text-primary hover:underline"
        >
          View Breeze Defaults
        </a>
```

> The inheritance-chain table already renders any level via `LEVEL_LABELS[entry.level]` and `FEATURE_META[ft]?.label ?? ft`, so the `'default'` node renders without further change once the label exists. Baseline features for the 8 shown types now appear in the "configured" grid with source "Breeze Defaults".

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @breeze/web exec vitest run src/components/devices/DeviceEffectiveConfigTab.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the existing device-tab / related tests to confirm no regression**

Run: `pnpm --filter @breeze/web exec vitest run src/components/devices/`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm --filter @breeze/web exec astro check`
Expected: no new errors.
```bash
git add apps/web/src/components/devices/DeviceEffectiveConfigTab.tsx apps/web/src/components/devices/DeviceEffectiveConfigTab.test.tsx
git commit -m "feat(web): label Breeze Defaults source in device effective-config (#1725)"
```

---

### Task 8: Full-suite verification + final commit

**Files:** none (verification only).

- [ ] **Step 1: API package tests**

Run: `pnpm --filter @breeze/api exec vitest run src/services/policyBaselineDefaults.test.ts src/services/remoteAccessPolicy.test.ts src/services/configurationPolicy.baseline.test.ts src/routes/configurationPolicies/resolution.test.ts`
Expected: all PASS.

- [ ] **Step 2: API typecheck**

Run: `pnpm --filter @breeze/api exec tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Web package tests + check**

Run: `pnpm --filter @breeze/web exec vitest run src/components/configurationPolicies/BreezeDefaultsPage.test.tsx src/components/devices/DeviceEffectiveConfigTab.test.tsx && pnpm --filter @breeze/web exec astro check`
Expected: all PASS, no new check errors.

- [ ] **Step 4: Confirm no migration / schema drift was introduced**

Run: `git diff --name-only main... | grep -E 'migrations/|db/schema/' || echo "no schema/migration changes (expected)"`
Expected: prints "no schema/migration changes (expected)".

- [ ] **Step 5: Final review commit (if any uncommitted verification fixes)**

```bash
git status
# commit any stragglers, otherwise nothing to do
```

---

## Manual verification (post-merge / local stack)

These confirm the user-facing behavior the issue asked for. Run against a local stack with at least one device.

1. Navigate to **Configuration Policies → Breeze Defaults**. Confirm Remote Access shows **"Active default"** with `webrtc desktop: on`, `vnc relay: on`, `remote tools: on`; confirm Patches/Alerts/etc. show **"Not enforced"**; confirm each row has a **Create override policy** link.
2. Click **Create override policy** on Patches → lands on the new-policy page with `?feature=patch`.
3. Open a device with **no** assigned policies → **Effective Configuration** tab → confirm the empty-state offers **View Breeze Defaults**, OR (depending on whether the device shows the 8 tracked features) the tracked features show source **"Breeze Defaults"** and the inheritance chain has a **Breeze Defaults** row; header reads **"0 assigned policies"**.
4. Assign a real policy with a patch feature to that device → confirm Patch now shows the real policy as source (baseline no longer wins for patch), while still-unconfigured features show Breeze Defaults.

## Out of scope (do not implement here)

- Out-of-band defaults (AI/SSO/portal/OneDrive) — separate future issue.
- Editable baseline / seeded per-partner rows.
- Fixing #1854 enforcement bugs.
- Wiring `?feature=` pre-selection logic in the new-policy page beyond passing the query param (the deep-link lands the user on policy creation; honoring the param to pre-open a tab is a nice-to-have, not required by #1725).
