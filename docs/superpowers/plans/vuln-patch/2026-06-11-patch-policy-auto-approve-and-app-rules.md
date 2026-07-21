# Patch Policy Auto-Approve Wiring + Per-App Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire policy-level auto-approve for ring-less config policies (linked ring takes absolute precedence) and add per-app block/pin rules with a catalog-backed picker to the policy Patch tab.

**Architecture:** Everything flows through the path `sources` took in PR #1269: `patchInlineSettingsSchema` (shared Zod) → job-creation snapshot into `patch_jobs.patches` JSONB (`routes/configurationPolicies/patchJobs.ts`, `jobs/patchSchedulerWorker.ts`) → executor parse with fail-closed malformed handling (`jobs/patchJobExecutor.ts`) → evaluator (`services/patchApprovalEvaluator.ts`). App rules filter all approval paths (including manual) in the job flow; policy auto-approve only fires when `ringId` is null. A new `GET /patches/app-options` endpoint merges the curated `third_party_package_catalog` with observed third-party patches for the picker UI. No migrations, no RLS changes, no agent changes.

**Tech Stack:** TypeScript, Zod, Hono, Drizzle (mocked in unit tests), Vitest, React (jsdom + testing-library).

**Spec:** `docs/superpowers/specs/vuln-patch/2026-06-11-patch-policy-auto-approve-and-app-rules-design.md`

**Environment note:** Run all pnpm/vitest commands with the pinned node: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`. Run single test files (the full local suite has known pre-existing parallel flakiness; CI is the source of truth).

---

## File Structure

| File | Change |
|---|---|
| `packages/shared/src/validators/index.ts` | Add `autoApproveDeferralDays` + `apps` to `patchInlineSettingsSchema`; new `policyAppRuleSchema` |
| `packages/shared/src/validators/index_inline_settings.test.ts` | New field/refinement tests |
| `apps/api/src/services/patchApprovalEvaluator.ts` | `comparePatchVersions`, app-rule filtering, policy auto-approve path, `packageId`/`version` in query |
| `apps/api/src/services/patchApprovalEvaluator.test.ts` | Comparator + app-rule + policy-auto-approve tests |
| `apps/api/src/jobs/patchJobExecutor.ts` | Parse `policyAutoApprove`/`apps` from job JSONB, thread into `RingConfig` |
| `apps/api/src/jobs/patchJobExecutor.test.ts` | Threading + malformed-handling tests |
| `apps/api/src/routes/configurationPolicies/patchJobs.ts` | Snapshot new keys into job JSONB; expose new fields in resolve endpoint |
| `apps/api/src/jobs/patchSchedulerWorker.ts` | Snapshot new keys into scheduled-job JSONB |
| `apps/api/src/routes/patches/appOptions.ts` (new) | Picker endpoint |
| `apps/api/src/routes/patches/appOptions.test.ts` (new) | Picker tests |
| `apps/api/src/routes/patches/index.ts` | Mount `appOptionsRoutes` |
| `apps/web/src/components/configurationPolicies/featureTabs/PatchAppRulesSection.tsx` (new) | App rules list + picker UI |
| `apps/web/src/components/configurationPolicies/featureTabs/PatchAppRulesSection.test.tsx` (new) | Section tests |
| `apps/web/src/components/configurationPolicies/featureTabs/PatchTab.tsx` | Auto-approve section (wired, ring-precedence aware) + app rules section |
| `apps/web/src/components/configurationPolicies/featureTabs/PatchTab.test.tsx` | New behavior tests |

---

### Task 1: Shared validator schema — `apps` + `autoApproveDeferralDays`

**Files:**
- Modify: `packages/shared/src/validators/index.ts` (patchInlineSettingsSchema, ~line 454)
- Test: `packages/shared/src/validators/index_inline_settings.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `index_inline_settings.test.ts` (follow the existing `patchInlineSettingsSchema.safeParse` style in that file):

```ts
describe('patchInlineSettingsSchema app rules + deferral', () => {
  it('defaults autoApproveDeferralDays to 0 and apps to []', () => {
    const result = patchInlineSettingsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.autoApproveDeferralDays).toBe(0);
    expect(result.data.apps).toEqual([]);
  });

  it('accepts a valid block rule and a valid pin rule', () => {
    const result = patchInlineSettingsSchema.safeParse({
      apps: [
        { source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' },
        { source: 'third_party', packageId: 'VideoLAN.VLC', displayName: 'VLC', action: 'pin', pinnedVersion: '3.0.20' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a pin rule without pinnedVersion', () => {
    const result = patchInlineSettingsSchema.safeParse({
      apps: [{ source: 'third_party', packageId: 'VideoLAN.VLC', action: 'pin' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects duplicate (source, packageId) entries case-insensitively', () => {
    const result = patchInlineSettingsSchema.safeParse({
      apps: [
        { source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' },
        { source: 'third_party', packageId: 'mozilla.firefox', action: 'pin', pinnedVersion: '120.0' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative or >60 deferral days', () => {
    expect(patchInlineSettingsSchema.safeParse({ autoApproveDeferralDays: -1 }).success).toBe(false);
    expect(patchInlineSettingsSchema.safeParse({ autoApproveDeferralDays: 61 }).success).toBe(false);
  });

  it('still rejects autoApprove without severities (existing refinement intact)', () => {
    expect(patchInlineSettingsSchema.safeParse({ autoApprove: true, autoApproveSeverities: [] }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run packages/shared/src/validators/index_inline_settings.test.ts --root packages/shared`
Expected: FAIL — `autoApproveDeferralDays` is stripped/undefined, pin/duplicate cases parse successfully.

(If `--root` invocation differs, use `cd packages/shared && npx vitest run src/validators/index_inline_settings.test.ts`.)

- [ ] **Step 3: Implement schema changes**

In `packages/shared/src/validators/index.ts`, above `patchInlineSettingsSchema` add:

```ts
export const policyAppRuleSchema = z.object({
  source: z.string().min(1).max(64),
  packageId: z.string().min(1).max(256),
  displayName: z.string().max(255).optional(),
  action: z.enum(['block', 'pin']),
  pinnedVersion: z.string().min(1).max(64).optional(),
}).superRefine((data, ctx) => {
  if (data.action === 'pin' && !data.pinnedVersion) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['pinnedVersion'],
      message: 'Pinned version is required for pin rules.',
    });
  }
});
```

Inside `patchInlineSettingsSchema`'s object, after `autoApproveSeverities`:

```ts
  autoApproveDeferralDays: z.number().int().min(0).max(60).default(0),
  apps: z.array(policyAppRuleSchema).max(200).default([]),
```

Extend the existing `superRefine` (keep the autoApprove/severities check) with:

```ts
  const seen = new Set<string>();
  for (const [i, app] of data.apps.entries()) {
    const key = `${app.source}|${app.packageId.toLowerCase()}`;
    if (seen.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['apps', i],
        message: 'Duplicate app rule for the same source and package.',
      });
    }
    seen.add(key);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Same command as Step 2. Expected: PASS (all, including pre-existing tests in the file).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators/index.ts packages/shared/src/validators/index_inline_settings.test.ts
git commit -m "feat(shared): app block/pin rules and auto-approve deferral in patch inline settings"
```

---

### Task 2: Evaluator pure helpers — version comparator + app-rule verdict

**Files:**
- Modify: `apps/api/src/services/patchApprovalEvaluator.ts`
- Test: `apps/api/src/services/patchApprovalEvaluator.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `patchApprovalEvaluator.test.ts` (import `comparePatchVersions`, `buildAppRuleMap`, `evaluateAppRule`, `type PolicyAppRule` from `./patchApprovalEvaluator`):

```ts
describe('comparePatchVersions', () => {
  it.each([
    ['1.2.3', '1.2.3', 0],
    ['1.2.10', '1.2.9', 1],
    ['1.2', '1.2.0', 0],          // missing segments treated as 0
    ['3.0.20', '3.0.21', -1],
    ['2024.1', '2024.1.5', -1],
    ['1.2.3-beta', '1.2.3-alpha', 1], // non-numeric segments compare lexicographically
  ])('compare(%s, %s) === %i', (a, b, expected) => {
    expect(comparePatchVersions(a, b)).toBe(expected);
  });

  it('returns null when either side is missing or blank', () => {
    expect(comparePatchVersions(null, '1.0')).toBeNull();
    expect(comparePatchVersions('1.0', undefined)).toBeNull();
    expect(comparePatchVersions('  ', '1.0')).toBeNull();
  });
});

describe('evaluateAppRule', () => {
  const rules = buildAppRuleMap([
    { source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' },
    { source: 'third_party', packageId: 'VideoLAN.VLC', action: 'pin', pinnedVersion: '3.0.20' },
  ]);

  it('blocks a matching block rule case-insensitively', () => {
    expect(evaluateAppRule({ source: 'third_party', packageId: 'mozilla.firefox', version: '120.0' }, rules)).toBe('blocked');
  });

  it('allows patches with no matching rule or no packageId', () => {
    expect(evaluateAppRule({ source: 'third_party', packageId: 'Notepad++.Notepad++', version: '8.6' }, rules)).toBe('allowed');
    expect(evaluateAppRule({ source: 'microsoft', packageId: null, version: null }, rules)).toBe('allowed');
  });

  it('holds a pinned app when the target version exceeds the pin', () => {
    expect(evaluateAppRule({ source: 'third_party', packageId: 'VideoLAN.VLC', version: '3.0.21' }, rules)).toBe('held');
  });

  it('allows a pinned app at or below the pin', () => {
    expect(evaluateAppRule({ source: 'third_party', packageId: 'VideoLAN.VLC', version: '3.0.20' }, rules)).toBe('allowed');
    expect(evaluateAppRule({ source: 'third_party', packageId: 'VideoLAN.VLC', version: '3.0.19' }, rules)).toBe('allowed');
  });

  it('holds (fail-closed) when the patch version is missing or unparseable', () => {
    expect(evaluateAppRule({ source: 'third_party', packageId: 'VideoLAN.VLC', version: null }, rules)).toBe('held');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/patchApprovalEvaluator.test.ts` (from `apps/api`)
Expected: FAIL — exports don't exist.

- [ ] **Step 3: Implement the helpers**

In `patchApprovalEvaluator.ts`, after the source-mapping section (~line 84), add:

```ts
// ============================================
// Per-app rules (block / pin) — Phase 3
// ============================================

export interface PolicyAppRule {
  source: string;
  packageId: string;
  action: 'block' | 'pin';
  pinnedVersion?: string;
}

export type AppRuleVerdict = 'allowed' | 'blocked' | 'held';

/**
 * Tolerant version comparison for winget/homebrew-style versions (not strict
 * semver). Splits on . - + _ ; numeric segments compare numerically, others
 * lexicographically; missing segments count as 0. Returns null when either
 * side is blank/missing — callers must treat null as "cannot prove the patch
 * is within the pin" and hold it (fail-closed).
 */
export function comparePatchVersions(
  a: string | null | undefined,
  b: string | null | undefined
): number | null {
  const av = (a ?? '').trim();
  const bv = (b ?? '').trim();
  if (!av || !bv) return null;
  const as = av.split(/[.\-+_]/);
  const bs = bv.split(/[.\-+_]/);
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const x = as[i] ?? '0';
    const y = bs[i] ?? '0';
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const diff = parseInt(x, 10) - parseInt(y, 10);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else {
      const cmp = x.localeCompare(y);
      if (cmp !== 0) return cmp < 0 ? -1 : 1;
    }
  }
  return 0;
}

/** Key app rules by source + lowercased packageId for O(1) candidate lookup. */
export function buildAppRuleMap(apps: PolicyAppRule[] | undefined): Map<string, PolicyAppRule> {
  const map = new Map<string, PolicyAppRule>();
  for (const rule of apps ?? []) {
    map.set(`${rule.source}|${rule.packageId.toLowerCase()}`, rule);
  }
  return map;
}

/**
 * Verdict for one candidate patch against the policy's app rules.
 * 'blocked' = block rule matched; 'held' = pin rule matched and the patch
 * version exceeds the pin OR versions can't be compared (fail-closed).
 */
export function evaluateAppRule(
  patch: { source: string; packageId: string | null; version: string | null },
  rules: Map<string, PolicyAppRule>
): AppRuleVerdict {
  if (rules.size === 0 || !patch.packageId) return 'allowed';
  const rule = rules.get(`${patch.source}|${patch.packageId.toLowerCase()}`);
  if (!rule) return 'allowed';
  if (rule.action === 'block') return 'blocked';
  const cmp = comparePatchVersions(patch.version, rule.pinnedVersion);
  if (cmp === null) return 'held';
  return cmp > 0 ? 'held' : 'allowed';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/patchApprovalEvaluator.ts apps/api/src/services/patchApprovalEvaluator.test.ts
git commit -m "feat(patches): version comparator and app-rule verdict helpers"
```

---

### Task 3: Evaluator integration — app-rule filtering + policy auto-approve path

**Files:**
- Modify: `apps/api/src/services/patchApprovalEvaluator.ts`
- Test: `apps/api/src/services/patchApprovalEvaluator.test.ts`

- [ ] **Step 1: Update test fixtures for the two new patch columns**

The `vi.mock('../db/schema')` block's `patches` object needs the new keys, and `PendingRow`/`pendingRow()` need `packageId`/`version`:

```ts
// in the vi.mock('../db/schema') patches object, add:
packageId: 'packageId', version: 'version',

// PendingRow type gains:
packageId: string | null;
version: string | null;

// pendingRow() defaults gain:
packageId: null,
version: null,
```

- [ ] **Step 2: Write the failing tests**

Add to the `resolveApprovedPatchesForDevice` describe block, following the file's existing mocked-chain pattern (a `mockSelectChain`-style helper already exists in the file for pending rows + approvals — reuse it exactly as the neighboring tests do):

```ts
describe('app rules in resolveApprovedPatchesForDevice', () => {
  it('excludes a blocked app even when manually approved', async () => {
    // pending: one third_party patch with packageId Mozilla.Firefox, manual approval exists for it
    mockChains(
      [pendingRow({ patchId: P1, source: 'third_party', packageId: 'Mozilla.Firefox', version: '121.0' })],
      [{ patchId: P1, status: 'approved', ringId: null }]
    );
    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: null, categoryRules: [], autoApprove: {}, deferralDays: 0,
      sources: ['third_party'],
      apps: [{ source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' }],
    });
    expect(result).toEqual([]);
  });

  it('holds a pinned app above the pin but approves one at the pin', async () => {
    mockChains(
      [
        pendingRow({ patchId: P1, devicePatchId: 'dp-1', source: 'third_party', packageId: 'VideoLAN.VLC', version: '3.0.21' }),
        pendingRow({ patchId: P2, devicePatchId: 'dp-2', source: 'third_party', packageId: 'VideoLAN.VLC', version: '3.0.20' }),
      ],
      [{ patchId: P1, status: 'approved', ringId: null }, { patchId: P2, status: 'approved', ringId: null }]
    );
    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: null, categoryRules: [], autoApprove: {}, deferralDays: 0,
      sources: ['third_party'],
      apps: [{ source: 'third_party', packageId: 'VideoLAN.VLC', action: 'pin', pinnedVersion: '3.0.20' }],
    });
    expect(result.map((r) => r.patchId)).toEqual([P2]);
  });
});

describe('policy-level auto-approve (ring-less)', () => {
  const policyAutoApprove = { enabled: true, severities: ['critical', 'important'], deferralDays: 0 };

  it('approves a ring-less matching-severity patch with reason policy_auto_approve', async () => {
    mockChains([pendingRow({ patchId: P1, severity: 'critical', source: 'third_party', packageId: 'X.Y' })], []);
    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: null, categoryRules: [], autoApprove: {}, deferralDays: 0,
      sources: ['third_party'], policyAutoApprove,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.approvalReason).toBe('policy_auto_approve');
  });

  it('does not approve severities outside the list, or null severity', async () => {
    mockChains([
      pendingRow({ patchId: P1, devicePatchId: 'dp-1', severity: 'low' }),
      pendingRow({ patchId: P2, devicePatchId: 'dp-2', severity: null }),
    ], []);
    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: null, categoryRules: [], autoApprove: {}, deferralDays: 0, policyAutoApprove,
    });
    expect(result).toEqual([]);
  });

  it('holds patches inside the deferral window', async () => {
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    mockChains([pendingRow({ patchId: P1, severity: 'critical', releaseDate: yesterday })], []);
    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: null, categoryRules: [], autoApprove: {}, deferralDays: 0,
      policyAutoApprove: { ...policyAutoApprove, deferralDays: 7 },
    });
    expect(result).toEqual([]);
  });

  it('ignores policyAutoApprove entirely when a ring is linked', async () => {
    // ring linked, no category rules, ring autoApprove disabled → nothing approved
    // even though policyAutoApprove would have matched
    mockChains([pendingRow({ patchId: P1, severity: 'critical' })], []);
    const result = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: RING_ID, categoryRules: [], autoApprove: { enabled: false }, deferralDays: 0,
      policyAutoApprove,
    });
    expect(result).toEqual([]);
  });
});
```

(`P1`/`P2` are uuid constants in the existing test file style; `mockChains` stands for the file's existing two-select mock helper — match its real name when editing.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/patchApprovalEvaluator.test.ts`
Expected: FAIL — `policyAutoApprove`/`apps` not in `RingConfig`, blocked patches still approved.

- [ ] **Step 4: Implement evaluator integration**

In `patchApprovalEvaluator.ts`:

a) Extend `RingConfig` (note doc comment — name kept, scope broadened):

```ts
export interface PolicyAutoApproveConfig {
  enabled: boolean;
  severities: string[];
  deferralDays: number;
}

/**
 * Evaluator input. Despite the name this now carries both ring-level config
 * and policy-level config (sources, app rules, ring-less auto-approve).
 */
export interface RingConfig {
  ringId: string | null;
  categoryRules: CategoryRule[];
  autoApprove: unknown;
  deferralDays: number;
  /** Policy-level source selections ('os', 'third_party', ...). Absent/empty = no filtering (legacy). */
  sources?: string[];
  /** Policy-level auto-approve — consulted ONLY when ringId is null. Absent = disabled. */
  policyAutoApprove?: PolicyAutoApproveConfig;
  /** Policy-level per-app block/pin rules. Applied to every approval path in the job flow. */
  apps?: PolicyAppRule[];
}
```

b) `ApprovedPatch.approvalReason` union gains `'policy_auto_approve'` (and the same union in `evaluatePatchApproval`'s return type).

c) Add `packageId: patches.packageId, version: patches.version` to the select at ~line 99, and to `PatchCandidate`:

```ts
interface PatchCandidate {
  patchId: string;
  category: string | null;
  severity: string | null;
  releaseDate: string | null;
  source: string;
  packageId: string | null;
  version: string | null;
}
```

d) In `resolveApprovedPatchesForDevice`, after the source-filter block (~line 132), filter by app rules — before manual approvals are loaded so block/pin override every path:

```ts
  // Apply per-app block/pin rules. These override every approval path in the
  // job flow — including manual approvals — mirroring how source filtering
  // treats manually-approved patches in an os-only job. Manual per-device
  // install does not go through this evaluator and is unaffected.
  const appRuleMap = buildAppRuleMap(ringConfig.apps);
  let finalCandidates = candidatePatches;
  if (appRuleMap.size > 0) {
    finalCandidates = candidatePatches.filter((p) => {
      const verdict = evaluateAppRule(p, appRuleMap);
      if (verdict !== 'allowed') {
        console.warn(
          `[PatchApproval] device ${deviceId}: patch ${p.patchId} (${p.source}/${p.packageId ?? '?'} v${p.version ?? '?'}) excluded by app rule (${verdict})`
        );
        return false;
      }
      return true;
    });
    if (finalCandidates.length === 0) return [];
  }
```

Replace subsequent uses of `candidatePatches` (the `patchIds` map and the main loop) with `finalCandidates`.

e) In `evaluatePatchApproval`, replace the bare ring-less early-return (lines 227–230):

```ts
  // No ring linked: manual approvals (handled above) plus policy-level
  // auto-approve. A linked ring takes absolute precedence — policyAutoApprove
  // is never consulted when ringId is set.
  if (!ringConfig.ringId) {
    const pa = ringConfig.policyAutoApprove;
    if (pa?.enabled && patch.severity && pa.severities.includes(patch.severity)) {
      if (pa.deferralDays > 0 && patch.releaseDate) {
        const releaseDate = new Date(patch.releaseDate);
        const deferralEnd = new Date(releaseDate.getTime() + pa.deferralDays * 24 * 60 * 60 * 1000);
        if (deferralEnd > now) {
          return null; // Still in deferral window
        }
      }
      return 'policy_auto_approve';
    }
    return null;
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Same command — all evaluator tests (new + the 19 existing) must pass.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/patchApprovalEvaluator.ts apps/api/src/services/patchApprovalEvaluator.test.ts
git commit -m "feat(patches): app-rule filtering and ring-less policy auto-approve in evaluator"
```

---

### Task 4: Executor — parse and thread `policyAutoApprove` + `apps`

**Files:**
- Modify: `apps/api/src/jobs/patchJobExecutor.ts` (~lines 361–400)
- Test: `apps/api/src/jobs/patchJobExecutor.test.ts`

- [ ] **Step 1: Write the failing tests**

The executor test file mocks `./patchApprovalEvaluator` (or asserts via the db mocks — follow the existing "threads sources" tests, which capture the `RingConfig` passed to `resolveApprovedPatchesForDevice`). Add:

```ts
it('threads well-formed policyAutoApprove and apps to the evaluator', async () => {
  // job.patches: { ringId: null, categoryRules: [], autoApprove: {},
  //   policyAutoApprove: { enabled: true, severities: ['critical'], deferralDays: 3 },
  //   apps: [{ source: 'third_party', packageId: 'A.B', action: 'block' }] }
  // assert resolveApprovedPatchesForDevice received:
  expect(capturedRingConfig.policyAutoApprove).toEqual({ enabled: true, severities: ['critical'], deferralDays: 3 });
  expect(capturedRingConfig.apps).toEqual([{ source: 'third_party', packageId: 'A.B', action: 'block' }]);
});

it('treats malformed policyAutoApprove as disabled and warns', async () => {
  // job.patches.policyAutoApprove = { enabled: 'yes', severities: 'critical' }
  expect(capturedRingConfig.policyAutoApprove).toBeUndefined();
  expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('malformed patches.policyAutoApprove'), expect.anything());
});

it('drops malformed app entries individually and keeps valid ones', async () => {
  // job.patches.apps = [ { source: 'third_party', packageId: 'A.B', action: 'block' },
  //                      { source: 'third_party', action: 'block' },               // no packageId
  //                      { source: 'third_party', packageId: 'C.D', action: 'pin' } ] // pin w/o version
  expect(capturedRingConfig.apps).toEqual([{ source: 'third_party', packageId: 'A.B', action: 'block' }]);
  expect(warnSpy).toHaveBeenCalledTimes(2);
});

it('leaves policyAutoApprove and apps undefined for legacy jobs (keys absent)', async () => {
  expect(capturedRingConfig.policyAutoApprove).toBeUndefined();
  expect(capturedRingConfig.apps).toBeUndefined();
});
```

(Write these against the file's real harness — it dispatches the worker processor and inspects mock calls; copy the setup of the existing `sources`-threading tests verbatim, changing only the `patches` JSONB payload and assertions.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/jobs/patchJobExecutor.test.ts`
Expected: FAIL — new keys not parsed.

- [ ] **Step 3: Implement executor parsing**

In `patchJobExecutor.ts`: extend the `patchesConfig` cast (~line 362):

```ts
  const patchesConfig = patchJob.patches as {
    ringId?: string | null;
    categoryRules?: unknown[];
    autoApprove?: unknown;
    sources?: unknown;
    policyAutoApprove?: unknown;
    apps?: unknown;
  };
```

After the `jobSources` block (~line 388), add (import `type PolicyAppRule`, `type PolicyAutoApproveConfig` from the evaluator):

```ts
  // policyAutoApprove: absent → undefined (legacy job / ring-linked job);
  // malformed → undefined, loudly. Fail-closed: the dangerous direction is
  // silently enabling auto-approval.
  let policyAutoApprove: PolicyAutoApproveConfig | undefined;
  if (patchesConfig?.policyAutoApprove !== undefined) {
    const raw = patchesConfig.policyAutoApprove as
      | { enabled?: unknown; severities?: unknown; deferralDays?: unknown }
      | null;
    const severities = Array.isArray(raw?.severities)
      ? raw.severities.filter((s): s is string => typeof s === 'string')
      : null;
    if (
      raw && typeof raw === 'object' && typeof raw.enabled === 'boolean' &&
      severities !== null && severities.length === (raw.severities as unknown[]).length
    ) {
      policyAutoApprove = {
        enabled: raw.enabled,
        severities,
        deferralDays:
          typeof raw.deferralDays === 'number' && Number.isFinite(raw.deferralDays) && raw.deferralDays >= 0
            ? raw.deferralDays
            : 0,
      };
    } else {
      console.warn(
        `[PatchJobExecutor] Job ${patchJobId} has malformed patches.policyAutoApprove; treating as disabled:`,
        JSON.stringify(patchesConfig.policyAutoApprove)
      );
    }
  }

  // apps: absent → undefined; non-array → ignored loudly; malformed entries
  // dropped individually with a warning (a dropped block rule widens scope,
  // so each drop must be visible in logs).
  let jobApps: PolicyAppRule[] | undefined;
  if (patchesConfig?.apps !== undefined) {
    if (!Array.isArray(patchesConfig.apps)) {
      console.warn(
        `[PatchJobExecutor] Job ${patchJobId} has malformed patches.apps; ignoring app rules:`,
        JSON.stringify(patchesConfig.apps)
      );
    } else {
      const valid: PolicyAppRule[] = [];
      for (const entry of patchesConfig.apps) {
        const e = entry as { source?: unknown; packageId?: unknown; action?: unknown; pinnedVersion?: unknown } | null;
        const okBase =
          e && typeof e.source === 'string' && e.source.length > 0 &&
          typeof e.packageId === 'string' && e.packageId.length > 0;
        if (okBase && e.action === 'block') {
          valid.push({ source: e.source as string, packageId: e.packageId as string, action: 'block' });
        } else if (okBase && e.action === 'pin' && typeof e.pinnedVersion === 'string' && e.pinnedVersion.length > 0) {
          valid.push({
            source: e.source as string,
            packageId: e.packageId as string,
            action: 'pin',
            pinnedVersion: e.pinnedVersion,
          });
        } else {
          console.warn(
            `[PatchJobExecutor] Job ${patchJobId} dropping malformed app rule:`,
            JSON.stringify(entry)
          );
        }
      }
      jobApps = valid;
    }
  }
```

Then add both to the `ringConfig` literal:

```ts
    sources: jobSources,
    policyAutoApprove,
    apps: jobApps,
```

- [ ] **Step 4: Run tests to verify they pass**

Same command — all executor tests (new + 8 existing) must pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/patchJobExecutor.ts apps/api/src/jobs/patchJobExecutor.test.ts
git commit -m "feat(patches): thread policy auto-approve and app rules from patch job to evaluator"
```

---

### Task 5: Job-creation snapshots + resolve endpoint

**Files:**
- Modify: `apps/api/src/routes/configurationPolicies/patchJobs.ts` (insert at ~line 178–190; resolve response at ~line 363–372)
- Modify: `apps/api/src/jobs/patchSchedulerWorker.ts` (insert at ~line 379–388)
- Test: `apps/api/src/routes/configurationPolicies/patchJobs.test.ts` (extend existing job-creation test)

- [ ] **Step 1: Write the failing test**

In `patchJobs.test.ts`, find the existing test that asserts the inserted job's `patches` JSONB contains `sources` and extend it (or add a sibling test in the same arrangement) to assert the new keys:

```ts
expect(insertedJob.patches).toMatchObject({
  sources: ['third_party'],
  policyAutoApprove: { enabled: true, severities: ['critical'], deferralDays: 5 },
  apps: [{ source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' }],
});
```

Seed the mocked policy-local settings for that test with `autoApprove: true, autoApproveSeverities: ['critical'], autoApproveDeferralDays: 5, apps: [...]`.

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/configurationPolicies/patchJobs.test.ts`
Expected: FAIL — `policyAutoApprove`/`apps` missing from snapshot.

- [ ] **Step 3: Implement snapshots**

In `patchJobs.ts` inside the `patches:` object of the insert (after `sources: policyLocal.settings.sources,` at line 183):

```ts
            policyAutoApprove: {
              enabled: policyLocal.settings.autoApprove ?? false,
              severities: policyLocal.settings.autoApproveSeverities ?? [],
              deferralDays: policyLocal.settings.autoApproveDeferralDays ?? 0,
            },
            apps: policyLocal.settings.apps ?? [],
```

In `patchSchedulerWorker.ts`, same addition after `sources: policyLocal.settings.sources,` (line 384), with identical code.

In the resolve endpoint response (`patchJobs.ts` ~line 364, the `settings:` object), after `autoApproveSeverities`:

```ts
              autoApproveDeferralDays: effective.settings.autoApproveDeferralDays ?? 0,
              apps: effective.settings.apps ?? [],
```

- [ ] **Step 4: Run tests to verify they pass**

```
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/configurationPolicies/patchJobs.test.ts
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/jobs/patchJobExecutor.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/configurationPolicies/patchJobs.ts apps/api/src/jobs/patchSchedulerWorker.ts apps/api/src/routes/configurationPolicies/patchJobs.test.ts
git commit -m "feat(patches): snapshot policy auto-approve and app rules into patch jobs"
```

---

### Task 6: Picker endpoint — `GET /patches/app-options`

**Files:**
- Create: `apps/api/src/routes/patches/appOptions.ts`
- Create: `apps/api/src/routes/patches/appOptions.test.ts`
- Modify: `apps/api/src/routes/patches/index.ts`

- [ ] **Step 1: Write the failing tests**

`appOptions.test.ts` — follow the db-mocking style of `apps/api/src/routes/patches/index.test.ts` (mock `../../db`, build a Hono app with a stubbed auth context):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const selectMock = vi.fn();
const selectDistinctMock = vi.fn();
vi.mock('../../db', () => ({ db: { select: (...a: unknown[]) => selectMock(...a), selectDistinct: (...a: unknown[]) => selectDistinctMock(...a) } }));
vi.mock('../../middleware/auth', () => ({
  requireScope: () => async (c: any, next: any) => {
    c.set('auth', { canAccessOrg: (id: string) => id !== 'denied-org' });
    await next();
  },
}));

import { appOptionsRoutes } from './appOptions';

function chain(rows: unknown[]) {
  return { from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(rows), then: undefined }), then: undefined } as any;
}

describe('GET /app-options', () => {
  beforeEach(() => { selectMock.mockReset(); selectDistinctMock.mockReset(); });

  it('merges catalog and observed entries, catalog metadata winning on dedup', async () => {
    selectMock.mockReturnValue({ from: vi.fn().mockResolvedValue([
      { source: 'third_party', packageId: 'Mozilla.Firefox', vendor: 'Mozilla', displayName: 'Firefox' },
    ]) });
    selectDistinctMock.mockReturnValue(chain([
      { source: 'third_party', packageId: 'mozilla.firefox', vendor: 'Mozilla Corp', displayName: 'Firefox 121 update' },
      { source: 'third_party', packageId: 'VideoLAN.VLC', vendor: 'VideoLAN', displayName: 'VLC update' },
    ]));
    const res = await appOptionsRoutes.request('/app-options');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    const firefox = body.data.find((o: any) => o.packageId.toLowerCase() === 'mozilla.firefox');
    expect(firefox.displayName).toBe('Firefox');   // catalog won
    expect(firefox.inCatalog).toBe(true);
    expect(body.data.find((o: any) => o.packageId === 'VideoLAN.VLC').inCatalog).toBe(false);
  });

  it('filters by search across name, vendor, and packageId', async () => {
    selectMock.mockReturnValue({ from: vi.fn().mockResolvedValue([
      { source: 'third_party', packageId: 'Mozilla.Firefox', vendor: 'Mozilla', displayName: 'Firefox' },
      { source: 'third_party', packageId: 'VideoLAN.VLC', vendor: 'VideoLAN', displayName: 'VLC' },
    ]) });
    selectDistinctMock.mockReturnValue(chain([]));
    const res = await appOptionsRoutes.request('/app-options?search=videolan');
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].packageId).toBe('VideoLAN.VLC');
  });

  it('rejects an inaccessible orgId with 403', async () => {
    const res = await appOptionsRoutes.request('/app-options?orgId=00000000-0000-0000-0000-00000000dead');
    // stub denies only 'denied-org'; use a uuid the stub denies — adjust stub: deny this uuid
    expect([200, 403]).toContain(res.status); // tighten to 403 once the stub matches
  });
});
```

(Adjust the 403 test so the stubbed `canAccessOrg` denies the exact uuid used — make the stub `canAccessOrg: (id) => id !== '00000000-0000-0000-0000-00000000dead'` and assert `res.status === 403`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/patches/appOptions.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement the route**

`apps/api/src/routes/patches/appOptions.ts`:

```ts
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import { requireScope } from '../../middleware/auth';
import { db } from '../../db';
import { patches, devices, devicePatches, thirdPartyPackageCatalog } from '../../db/schema';

/** Keep in sync with THIRD_PARTY_PATCH_SOURCES in services/patchApprovalEvaluator.ts. */
const THIRD_PARTY_SOURCES = ['third_party', 'custom'] as const;

const appOptionsQuerySchema = z.object({
  search: z.string().max(255).optional(),
  orgId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const appOptionsRoutes = new Hono();

// GET /patches/app-options — options for the policy app-rule picker: curated
// catalog merged with third-party apps observed in patch data (optionally
// narrowed to one org via the same EXISTS pattern as GET /patches).
appOptionsRoutes.get(
  '/app-options',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', appOptionsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { search, orgId, limit } = c.req.valid('query');

    if (orgId && !auth.canAccessOrg(orgId)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }

    const catalogRows = await db
      .select({
        source: thirdPartyPackageCatalog.source,
        packageId: thirdPartyPackageCatalog.packageId,
        vendor: thirdPartyPackageCatalog.vendor,
        displayName: thirdPartyPackageCatalog.friendlyName,
      })
      .from(thirdPartyPackageCatalog);

    const observedConditions: SQL[] = [
      inArray(patches.source, [...THIRD_PARTY_SOURCES]),
      isNotNull(patches.packageId),
    ];
    if (orgId) {
      observedConditions.push(sql`EXISTS (
        SELECT 1 FROM ${devicePatches} dp
        INNER JOIN ${devices} d ON d.id = dp.device_id
        WHERE dp.patch_id = ${patches.id} AND d.org_id = ${orgId}
      )`);
    }
    const observedRows = await db
      .selectDistinct({
        source: patches.source,
        packageId: patches.packageId,
        vendor: patches.vendor,
        displayName: patches.title,
      })
      .from(patches)
      .where(and(...observedConditions));

    type AppOption = {
      source: string;
      packageId: string;
      vendor: string | null;
      displayName: string;
      inCatalog: boolean;
    };
    const merged = new Map<string, AppOption>();
    for (const row of observedRows) {
      if (!row.packageId) continue;
      merged.set(`${row.source}|${row.packageId.toLowerCase()}`, { ...row, packageId: row.packageId, inCatalog: false });
    }
    for (const row of catalogRows) {
      merged.set(`${row.source}|${row.packageId.toLowerCase()}`, { ...row, inCatalog: true });
    }

    let options = [...merged.values()];
    if (search) {
      const q = search.toLowerCase();
      options = options.filter(
        (o) =>
          o.displayName.toLowerCase().includes(q) ||
          (o.vendor ?? '').toLowerCase().includes(q) ||
          o.packageId.toLowerCase().includes(q)
      );
    }
    options.sort((a, b) => a.displayName.localeCompare(b.displayName));

    return c.json({ data: options.slice(0, limit) });
  }
);
```

Mount in `apps/api/src/routes/patches/index.ts` — add the import and register it **before** the other subrouters so `/app-options` can't be swallowed by any `/:id` param route:

```ts
import { appOptionsRoutes } from './appOptions';
// ...
patchRoutes.route('/', appOptionsRoutes);
patchRoutes.route('/', operationsRoutes);
```

- [ ] **Step 4: Run tests to verify they pass**

`PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/patches/appOptions.test.ts` — PASS.
Also run `npx vitest run src/routes/patches/index.test.ts` to confirm mounting broke nothing.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/patches/appOptions.ts apps/api/src/routes/patches/appOptions.test.ts apps/api/src/routes/patches/index.ts
git commit -m "feat(patches): app-options endpoint for policy app-rule picker"
```

---

### Task 7: Web UI — app rules section + wired auto-approve

**Files:**
- Create: `apps/web/src/components/configurationPolicies/featureTabs/PatchAppRulesSection.tsx`
- Create: `apps/web/src/components/configurationPolicies/featureTabs/PatchAppRulesSection.test.tsx`
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/PatchTab.tsx`
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/PatchTab.test.tsx`

- [ ] **Step 1: Write failing PatchAppRulesSection tests**

`PatchAppRulesSection.test.tsx` (follow the render/mocking style of `PatchTab.test.tsx`, which mocks `../../../stores/auth` `fetchWithAuth`):

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchWithAuthMock = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuthMock(...a) }));

import PatchAppRulesSection, { type PolicyAppRule } from './PatchAppRulesSection';

const options = [
  { source: 'third_party', packageId: 'Mozilla.Firefox', vendor: 'Mozilla', displayName: 'Firefox', inCatalog: true },
  { source: 'third_party', packageId: 'VideoLAN.VLC', vendor: 'VideoLAN', displayName: 'VLC', inCatalog: false },
];

beforeEach(() => {
  fetchWithAuthMock.mockResolvedValue({ ok: true, json: async () => ({ data: options }) });
});

describe('PatchAppRulesSection', () => {
  it('renders existing rules with action and pinned version', () => {
    const apps: PolicyAppRule[] = [
      { source: 'third_party', packageId: 'Mozilla.Firefox', displayName: 'Firefox', action: 'block' },
      { source: 'third_party', packageId: 'VideoLAN.VLC', displayName: 'VLC', action: 'pin', pinnedVersion: '3.0.20' },
    ];
    render(<PatchAppRulesSection apps={apps} onChange={() => {}} />);
    expect(screen.getByText('Firefox')).toBeTruthy();
    expect(screen.getByText(/Blocked/i)).toBeTruthy();
    expect(screen.getByText(/3\.0\.20/)).toBeTruthy();
  });

  it('adds a block rule from picker search results', async () => {
    const onChange = vi.fn();
    render(<PatchAppRulesSection apps={[]} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('app-rules-add'));
    fireEvent.change(screen.getByTestId('app-rules-search'), { target: { value: 'fire' } });
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    fireEvent.click(await screen.findByTestId('app-option-third_party-Mozilla.Firefox'));
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' }),
    ]);
  });

  it('removes a rule', () => {
    const onChange = vi.fn();
    render(
      <PatchAppRulesSection
        apps={[{ source: 'third_party', packageId: 'Mozilla.Firefox', action: 'block' }]}
        onChange={onChange}
      />
    );
    fireEvent.click(screen.getByTestId('app-rule-remove-third_party-Mozilla.Firefox'));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('switches a rule to pin and sets the version', () => {
    const onChange = vi.fn();
    render(
      <PatchAppRulesSection
        apps={[{ source: 'third_party', packageId: 'VideoLAN.VLC', action: 'pin', pinnedVersion: '' }]}
        onChange={onChange}
      />
    );
    fireEvent.change(screen.getByTestId('app-rule-pin-version-third_party-VideoLAN.VLC'), {
      target: { value: '3.0.20' },
    });
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ action: 'pin', pinnedVersion: '3.0.20' }),
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/configurationPolicies/featureTabs/PatchAppRulesSection.test.tsx` (from `apps/web`)
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement PatchAppRulesSection**

`PatchAppRulesSection.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { fetchWithAuth } from '../../../stores/auth';

export type PolicyAppAction = 'block' | 'pin';

export type PolicyAppRule = {
  source: string;
  packageId: string;
  displayName?: string;
  action: PolicyAppAction;
  pinnedVersion?: string;
};

type AppOption = {
  source: string;
  packageId: string;
  vendor: string | null;
  displayName: string;
  inCatalog: boolean;
};

type Props = {
  apps: PolicyAppRule[];
  onChange: (apps: PolicyAppRule[]) => void;
};

const ruleKey = (r: { source: string; packageId: string }) => `${r.source}-${r.packageId}`;

export default function PatchAppRulesSection({ apps, onChange }: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [options, setOptions] = useState<AppOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [manualPackageId, setManualPackageId] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (!pickerOpen) return;
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const response = await fetchWithAuth(`/patches/app-options?search=${encodeURIComponent(search)}`);
        if (response.ok) {
          const payload = await response.json();
          setOptions(Array.isArray(payload.data) ? payload.data : []);
        }
      } catch {
        // Read-only lookup; picker simply shows no results
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => clearTimeout(debounceRef.current);
  }, [pickerOpen, search]);

  const exists = (source: string, packageId: string) =>
    apps.some((a) => a.source === source && a.packageId.toLowerCase() === packageId.toLowerCase());

  const addRule = (option: { source: string; packageId: string; displayName?: string }) => {
    if (exists(option.source, option.packageId)) return;
    onChange([...apps, { source: option.source, packageId: option.packageId, displayName: option.displayName, action: 'block' }]);
    setPickerOpen(false);
    setSearch('');
    setManualPackageId('');
  };

  const updateRule = (key: string, patch: Partial<PolicyAppRule>) =>
    onChange(apps.map((a) => (ruleKey(a) === key ? { ...a, ...patch } : a)));

  const removeRule = (key: string) => onChange(apps.filter((a) => ruleKey(a) !== key));

  return (
    <div className="mt-6">
      <h3 className="text-sm font-semibold">Application Rules</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Block specific applications from automated patching, or pin them to a maximum version.
        Rules apply to automated deployment only — manual per-device installs are unaffected.
      </p>

      {apps.length > 0 && (
        <ul className="mt-2 space-y-2">
          {apps.map((rule) => {
            const key = ruleKey(rule);
            return (
              <li key={key} className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm">
                <span className="font-medium">{rule.displayName ?? rule.packageId}</span>
                <span className="text-xs text-muted-foreground">{rule.packageId}</span>
                <select
                  value={rule.action}
                  data-testid={`app-rule-action-${key}`}
                  onChange={(e) =>
                    updateRule(key, {
                      action: e.target.value as PolicyAppAction,
                      pinnedVersion: e.target.value === 'block' ? undefined : rule.pinnedVersion ?? '',
                    })
                  }
                  className="ml-auto h-8 rounded-md border bg-background px-2 text-xs"
                >
                  <option value="block">Blocked</option>
                  <option value="pin">Pinned</option>
                </select>
                {rule.action === 'pin' && (
                  <input
                    type="text"
                    placeholder="Max version"
                    value={rule.pinnedVersion ?? ''}
                    data-testid={`app-rule-pin-version-${key}`}
                    onChange={(e) => updateRule(key, { pinnedVersion: e.target.value })}
                    className="h-8 w-28 rounded-md border bg-background px-2 text-xs"
                  />
                )}
                <button
                  type="button"
                  aria-label={`Remove rule for ${rule.displayName ?? rule.packageId}`}
                  data-testid={`app-rule-remove-${key}`}
                  onClick={() => removeRule(key)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {apps.some((a) => a.action === 'pin' && !a.pinnedVersion) && (
        <p className="mt-1 text-xs text-destructive">Pinned applications need a version.</p>
      )}

      {!pickerOpen ? (
        <button
          type="button"
          data-testid="app-rules-add"
          onClick={() => setPickerOpen(true)}
          className="mt-2 inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs hover:bg-muted"
        >
          <Plus className="h-3.5 w-3.5" /> Add application
        </button>
      ) : (
        <div className="mt-2 rounded-md border p-3">
          <input
            type="text"
            placeholder="Search catalog and detected applications..."
            value={search}
            data-testid="app-rules-search"
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            autoFocus
          />
          <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
            {loading && <li className="text-xs text-muted-foreground">Searching…</li>}
            {!loading &&
              options.map((o) => (
                <li key={`${o.source}|${o.packageId}`}>
                  <button
                    type="button"
                    data-testid={`app-option-${o.source}-${o.packageId}`}
                    disabled={exists(o.source, o.packageId)}
                    onClick={() => addRule(o)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted disabled:opacity-50"
                  >
                    <span>{o.displayName}</span>
                    <span className="text-xs text-muted-foreground">{o.vendor ?? o.packageId}</span>
                    {o.inCatalog && <span className="ml-auto text-[10px] uppercase text-muted-foreground">catalog</span>}
                  </button>
                </li>
              ))}
            {!loading && options.length === 0 && (
              <li className="text-xs text-muted-foreground">No matches.</li>
            )}
          </ul>
          <div className="mt-2 flex items-center gap-2 border-t pt-2">
            <input
              type="text"
              placeholder="Or enter a package ID manually (e.g. Mozilla.Firefox)"
              value={manualPackageId}
              data-testid="app-rules-manual-id"
              onChange={(e) => setManualPackageId(e.target.value)}
              className="h-8 flex-1 rounded-md border bg-background px-2 text-xs"
            />
            <button
              type="button"
              data-testid="app-rules-manual-add"
              disabled={!manualPackageId.trim()}
              onClick={() => addRule({ source: 'third_party', packageId: manualPackageId.trim() })}
              className="h-8 rounded-md border px-3 text-xs hover:bg-muted disabled:opacity-50"
            >
              Add
            </button>
            <button
              type="button"
              onClick={() => { setPickerOpen(false); setSearch(''); }}
              className="h-8 rounded-md px-2 text-xs text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run section tests — PASS**

Same command as Step 2.

- [ ] **Step 5: Write failing PatchTab tests**

Add to `PatchTab.test.tsx` (reuse its existing render helpers/mocks):

```tsx
it('includes wired auto-approve fields and apps in the save payload', async () => {
  // render with no ring selected; enable auto-approve, check 'critical', set deferral 3,
  // then save and inspect the body passed to useFeatureLink's save (existing tests show how
  // save is mocked/captured)
  expect(savedPayload.inlineSettings).toMatchObject({
    autoApprove: true,
    autoApproveSeverities: ['critical'],
    autoApproveDeferralDays: 3,
    apps: [],
  });
});

it('disables the auto-approve section and shows the ring-precedence notice when a ring is linked', () => {
  // render with existingLink.featurePolicyId set to a ring id
  expect(screen.getByTestId('auto-approve-ring-notice').textContent).toMatch(/governed by the linked update ring/i);
  expect((screen.getByTestId('auto-approve-toggle') as HTMLInputElement).disabled).toBe(true);
});

it('hydrates auto-approve fields and apps from existing inline settings', () => {
  // existingLink.inlineSettings: { autoApprove: true, autoApproveSeverities: ['important'],
  //   autoApproveDeferralDays: 7, apps: [{ source: 'third_party', packageId: 'A.B', action: 'block' }] }
  expect((screen.getByTestId('auto-approve-toggle') as HTMLInputElement).checked).toBe(true);
  expect(screen.getByText('A.B')).toBeTruthy();
});
```

- [ ] **Step 6: Implement PatchTab changes**

In `PatchTab.tsx`:

a) Extend the settings type and defaults:

```tsx
import PatchAppRulesSection, { type PolicyAppRule } from './PatchAppRulesSection';

type PatchSeverity = 'critical' | 'important' | 'moderate' | 'low';

type PatchDeploymentSettings = {
  sources: PatchSourceOption[];
  autoApprove: boolean;
  autoApproveSeverities: PatchSeverity[];
  autoApproveDeferralDays: number;
  apps: PolicyAppRule[];
  scheduleFrequency: ScheduleFrequency;
  scheduleTime: string;
  scheduleDayOfWeek: string;
  scheduleDayOfMonth: number;
  rebootPolicy: RebootPolicy;
};

const defaults: PatchDeploymentSettings = {
  sources: ['os'],
  autoApprove: false,
  autoApproveSeverities: [],
  autoApproveDeferralDays: 0,
  apps: [],
  scheduleFrequency: 'weekly',
  scheduleTime: '02:00',
  scheduleDayOfWeek: 'sun',
  scheduleDayOfMonth: 1,
  rebootPolicy: 'if_required',
};

const severityOptions: { value: PatchSeverity; label: string }[] = [
  { value: 'critical', label: 'Critical' },
  { value: 'important', label: 'Important' },
  { value: 'moderate', label: 'Moderate' },
  { value: 'low', label: 'Low' },
];
```

(The two hydration sites — the `useState` initializer and the `useEffect` on `existingLink`/`parentLink` — keep their existing `{ ...prev/defaults, ...inline, sources: normalizeSources(...) }` spreads; the new keys hydrate automatically. The earlier "stored settings round-trip" tests must keep passing: values now round-trip as first-class fields.)

b) After the Approval Ring section, add the Automatic Approval section:

```tsx
      {/* Automatic Approval (policy-level, ring-less only) */}
      <div className="mt-6">
        <h3 className="text-sm font-semibold">Automatic Approval</h3>
        {selectedRingId ? (
          <p className="mt-1 text-xs text-muted-foreground" data-testid="auto-approve-ring-notice">
            Automatic approval is governed by the linked update ring
            {selectedRing ? ` “${selectedRing.name}”` : ''}. These settings apply only when no ring is linked.
          </p>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">
            Automatically approve patches by severity when no update ring is linked.
          </p>
        )}
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            data-testid="auto-approve-toggle"
            checked={settings.autoApprove}
            disabled={!!selectedRingId}
            onChange={(e) => update('autoApprove', e.target.checked)}
          />
          Enable automatic approval
        </label>
        {settings.autoApprove && !selectedRingId && (
          <div className="mt-2 space-y-2">
            <div className="flex flex-wrap gap-3">
              {severityOptions.map((o) => (
                <label key={o.value} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    data-testid={`auto-approve-severity-${o.value}`}
                    checked={settings.autoApproveSeverities.includes(o.value)}
                    onChange={() =>
                      update(
                        'autoApproveSeverities',
                        settings.autoApproveSeverities.includes(o.value)
                          ? settings.autoApproveSeverities.filter((s) => s !== o.value)
                          : [...settings.autoApproveSeverities, o.value]
                      )
                    }
                  />
                  {o.label}
                </label>
              ))}
            </div>
            {settings.autoApproveSeverities.length === 0 && (
              <p className="text-xs text-destructive">Select at least one severity for auto-approval.</p>
            )}
            <div>
              <label className="text-xs text-muted-foreground">Deferral (days after release)</label>
              <input
                type="number"
                min={0}
                max={60}
                data-testid="auto-approve-deferral"
                value={settings.autoApproveDeferralDays}
                onChange={(e) => update('autoApproveDeferralDays', Math.max(0, Math.min(60, Number(e.target.value) || 0)))}
                className="mt-1 h-9 w-28 rounded-md border bg-background px-2 text-sm"
              />
            </div>
          </div>
        )}
      </div>

      <PatchAppRulesSection apps={settings.apps} onChange={(apps) => update('apps', apps)} />
```

(Place `<PatchAppRulesSection>` before the Schedule section.)

- [ ] **Step 7: Run PatchTab tests — PASS**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/configurationPolicies/featureTabs/PatchTab.test.tsx src/components/configurationPolicies/featureTabs/PatchAppRulesSection.test.tsx`
Expected: PASS, including the 7 pre-existing PatchTab tests.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/configurationPolicies/featureTabs/
git commit -m "feat(web): wired auto-approve and per-app rules in config policy patch tab"
```

---

### Task 8: Verification + PR

- [ ] **Step 1: Type-check both apps**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
cd ../web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
```
Expected: clean apart from documented pre-existing errors (`agents.test.ts`, `apiKeyAuth.test.ts`).

- [ ] **Step 2: Run every touched test file once more**

```bash
cd packages/shared && npx vitest run src/validators/index_inline_settings.test.ts
cd apps/api && npx vitest run src/services/patchApprovalEvaluator.test.ts src/jobs/patchJobExecutor.test.ts src/routes/configurationPolicies/patchJobs.test.ts src/routes/patches/appOptions.test.ts src/routes/patches/index.test.ts
cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/
```
(All with the pinned-node PATH prefix.) Expected: PASS.

- [ ] **Step 3: Push branch and open PR**

PR body must cover: ring precedence semantics (policy auto-approve fires only ring-less), app rules overriding manual approvals in the job flow (manual per-device install unaffected), fail-closed handling (malformed policyAutoApprove → disabled; unparseable pin versions → held; dropped malformed app rules warned), and the test counts. Reference the spec and this plan.

```bash
git push -u origin worktree-patch-policy-auto-approve-app-rules
gh pr create --title "feat(patches): policy-level auto-approve and per-app block/pin rules" --body-file <(...)
```

---

## Self-Review Notes

- **Spec coverage:** schema (Task 1), comparator + verdicts (Task 2), evaluator filtering + policy auto-approve + ring precedence (Task 3), executor fail-closed parsing (Task 4), both job-creation snapshots + resolve endpoint (Task 5), picker endpoint with catalog+observed+manual (Task 6 + manual entry in Task 7 UI), wired UI with ring-precedence notice (Task 7), verification (Task 8). Compatibility: all new fields default to no-op; legacy jobs unchanged (Tasks 1/4).
- **Type consistency:** `PolicyAppRule` defined once in the evaluator (API side) and once locally in `PatchAppRulesSection` (web side, includes `displayName`); `PolicyAutoApproveConfig` exported from evaluator and imported by executor; `approvalReason` union extended consistently.
- **Known judgment calls for the implementer:** the exact name of the evaluator test file's select-chain mock helper, and the executor test harness setup, must be copied from the neighboring existing tests rather than invented; test code above is written to slot into those patterns.
