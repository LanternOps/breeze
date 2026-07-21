# Third-Party Patch Source Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the config-policy `sources` setting functional end-to-end (policy → patch job → approval evaluation), fix the dead `third_party_app` update-ring category rule, and expose sources/auto-approve configuration in the Config Policy Patch tab UI.

**Architecture:** The agent already scans/installs third-party patches (winget/chocolatey/homebrew report `source='third_party'`), and `config_policy_patch_settings.sources` already exists (default `['os']`) — but nothing downstream consumes it. We add source filtering in `patchApprovalEvaluator` (the single choke point all automated deployment flows through), thread `sources` from the patch-job JSONB in `patchJobExecutor`, and add the missing UI controls in `PatchTab.tsx`. No schema or migration changes needed.

**Tech Stack:** TypeScript, Hono API, Drizzle ORM (mocked in tests), Vitest, React + Testing Library.

---

## Background facts (verified 2026-06-11)

- `patches.source` enum values: `'microsoft' | 'apple' | 'linux' | 'third_party' | 'custom'` (`apps/api/src/db/schema/patches.ts:21-27`).
- Policy-level `sources` validator enum: `'os' | 'third_party' | 'custom' | 'firmware' | 'drivers' | 'microsoft' | 'apple' | 'linux'` (`packages/shared/src/validators/index.ts:443-452`), default `['os']`, min 1. Validator tests already cover defaults + the `autoApprove ⇒ severities` superRefine (`index_inline_settings.test.ts`) — **no validator changes in this plan**.
- Agent category values for third-party patches are inconsistent: winget → `application`, chocolatey → `application` (provider default), homebrew → `homebrew` / `homebrew-cask`, and catalog enrichment can overwrite category with arbitrary strings. Therefore the `third_party_app` ring rule must match on **patch source**, not category string.
- `patchJobService.createPatchJobFromConfigPolicy` already writes `sources` into `patchJobs.patches` JSONB (`apps/api/src/services/patchJobService.ts:79`). The executor just never reads it.
- Behavior change to flag in the PR: existing policies default to `sources=['os']`, so after this ships, ring/legacy auto-approval stops deploying third-party patches until a policy opts in. Manual per-device install is unaffected (different route). Manual approvals **are** affected when flowing through patch jobs — a manually-approved third-party patch will no longer deploy via a job whose policy says `['os']`. That is the intended semantics.

---

### Task 1: Source filtering in `patchApprovalEvaluator`

**Files:**
- Create: `apps/api/src/services/patchApprovalEvaluator.test.ts`
- Modify: `apps/api/src/services/patchApprovalEvaluator.ts`

- [ ] **Step 1.1: Write failing tests for the pure mapping helper**

Create `apps/api/src/services/patchApprovalEvaluator.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn() },
}));

vi.mock('../db/schema', () => ({
  devicePatches: { id: 'id', patchId: 'patchId', deviceId: 'deviceId', status: 'status' },
  patches: {
    id: 'id', externalId: 'externalId', title: 'title', category: 'category',
    severity: 'severity', releaseDate: 'releaseDate', requiresReboot: 'requiresReboot',
    source: 'source',
  },
  patchApprovals: { patchId: 'patchId', status: 'status', ringId: 'ringId', orgId: 'orgId' },
  OUTSTANDING_DEVICE_PATCH_STATUSES: ['pending'],
}));

import { db } from '../db';
import {
  buildAllowedPatchSources,
  resolveApprovedPatchesForDevice,
  type RingConfig,
} from './patchApprovalEvaluator';

describe('buildAllowedPatchSources', () => {
  it('maps os to the three OS patch sources', () => {
    expect(buildAllowedPatchSources(['os'])).toEqual(new Set(['microsoft', 'apple', 'linux']));
  });

  it('maps third_party to third_party and custom', () => {
    expect(buildAllowedPatchSources(['third_party'])).toEqual(new Set(['third_party', 'custom']));
  });

  it('passes through explicit patch-source values', () => {
    expect(buildAllowedPatchSources(['microsoft', 'custom'])).toEqual(new Set(['microsoft', 'custom']));
  });

  it('ignores firmware/drivers (no provider exists) without blocking other sources', () => {
    expect(buildAllowedPatchSources(['os', 'firmware', 'drivers'])).toEqual(
      new Set(['microsoft', 'apple', 'linux'])
    );
  });

  it('returns null (no filtering) for undefined or empty input — legacy jobs', () => {
    expect(buildAllowedPatchSources(undefined)).toBeNull();
    expect(buildAllowedPatchSources([])).toBeNull();
  });
});
```

- [ ] **Step 1.2: Run the helper tests to verify they fail**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/patchApprovalEvaluator.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: FAIL — `buildAllowedPatchSources` is not exported.

- [ ] **Step 1.3: Implement `buildAllowedPatchSources`**

In `apps/api/src/services/patchApprovalEvaluator.ts`, add below the type definitions (after line 39):

```typescript
// ============================================
// Policy-source → patch-source mapping
// ============================================

/** patches.source values that count as OS updates */
const OS_PATCH_SOURCES = ['microsoft', 'apple', 'linux'] as const;
/** patches.source values that count as third-party application updates */
const THIRD_PARTY_PATCH_SOURCES = ['third_party', 'custom'] as const;

/**
 * Expand policy-level source selections ('os', 'third_party', ...) into the
 * set of patches.source values they allow. Returns null when no filtering
 * should be applied (legacy jobs created before sources were enforced).
 * 'firmware' / 'drivers' have no patch provider yet and expand to nothing.
 */
export function buildAllowedPatchSources(sources: string[] | undefined): Set<string> | null {
  if (!sources || sources.length === 0) return null;

  const allowed = new Set<string>();
  for (const source of sources) {
    switch (source) {
      case 'os':
        for (const s of OS_PATCH_SOURCES) allowed.add(s);
        break;
      case 'third_party':
        for (const s of THIRD_PARTY_PATCH_SOURCES) allowed.add(s);
        break;
      case 'microsoft':
      case 'apple':
      case 'linux':
      case 'custom':
        allowed.add(source);
        break;
      // 'firmware', 'drivers': no patch provider exists — expand to nothing
    }
  }
  return allowed;
}

export function isThirdPartyPatchSource(source: string | null | undefined): boolean {
  return source === 'third_party' || source === 'custom';
}
```

- [ ] **Step 1.4: Run the helper tests to verify they pass**

Same command as Step 1.2. Expected: the five `buildAllowedPatchSources` tests PASS.

- [ ] **Step 1.5: Write failing tests for source filtering in `resolveApprovedPatchesForDevice`**

Append to `patchApprovalEvaluator.test.ts`:

```typescript
// ---- resolveApprovedPatchesForDevice with mocked Drizzle chains ----

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const DEVICE_ID = '22222222-2222-2222-2222-222222222222';
const RING_ID = '33333333-3333-3333-3333-333333333333';

type PendingRow = {
  devicePatchId: string;
  patchId: string;
  externalId: string;
  title: string;
  category: string | null;
  severity: string | null;
  releaseDate: string | null;
  requiresReboot: boolean;
  source: string;
};

function pendingRow(overrides: Partial<PendingRow>): PendingRow {
  return {
    devicePatchId: 'dp-1',
    patchId: 'aaaaaaaa-0000-0000-0000-000000000001',
    externalId: 'KB0000001',
    title: 'A patch',
    category: 'security',
    severity: 'critical',
    releaseDate: null,
    requiresReboot: false,
    source: 'microsoft',
    ...overrides,
  };
}

function mockPendingAndApprovals(pendingRows: PendingRow[], approvalRows: Array<{ patchId: string; status: string; ringId: string | null }>) {
  const pendingChain: any = {
    from: vi.fn(() => pendingChain),
    innerJoin: vi.fn(() => pendingChain),
    where: vi.fn(() => Promise.resolve(pendingRows)),
  };
  const approvalChain: any = {
    from: vi.fn(() => approvalChain),
    where: vi.fn(() => Promise.resolve(approvalRows)),
  };
  vi.mocked(db.select)
    .mockReturnValueOnce(pendingChain)
    .mockReturnValueOnce(approvalChain);
}

const baseRing: RingConfig = {
  ringId: RING_ID,
  categoryRules: [],
  autoApprove: { enabled: true, severities: [] },
  deferralDays: 0,
};

describe('resolveApprovedPatchesForDevice source filtering', () => {
  beforeEach(() => {
    vi.mocked(db.select).mockReset();
  });

  it('excludes third_party and custom patches when sources is ["os"]', async () => {
    mockPendingAndApprovals(
      [
        pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000001', source: 'microsoft' }),
        pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000002', source: 'third_party' }),
        pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000003', source: 'custom' }),
      ],
      []
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ...baseRing,
      sources: ['os'],
    });

    expect(approved.map((p) => p.patchId)).toEqual(['aaaaaaaa-0000-0000-0000-000000000001']);
  });

  it('excludes OS patches when sources is ["third_party"]', async () => {
    mockPendingAndApprovals(
      [
        pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000001', source: 'microsoft' }),
        pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000002', source: 'apple' }),
        pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000003', source: 'third_party' }),
      ],
      []
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ...baseRing,
      sources: ['third_party'],
    });

    expect(approved.map((p) => p.patchId)).toEqual(['aaaaaaaa-0000-0000-0000-000000000003']);
  });

  it('applies no source filtering when sources is absent (legacy jobs)', async () => {
    mockPendingAndApprovals(
      [
        pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000001', source: 'microsoft' }),
        pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000002', source: 'third_party' }),
      ],
      []
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, baseRing);

    expect(approved).toHaveLength(2);
  });

  it('source filter also gates manually approved patches', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000002', source: 'third_party', severity: 'low' })],
      [{ patchId: 'aaaaaaaa-0000-0000-0000-000000000002', status: 'approved', ringId: null }]
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ringId: null,
      categoryRules: [],
      autoApprove: {},
      deferralDays: 0,
      sources: ['os'],
    });

    expect(approved).toHaveLength(0);
  });
});
```

- [ ] **Step 1.6: Run tests to verify the new ones fail**

Same command as Step 1.2.
Expected: FAIL — `sources` is not a known property of `RingConfig` (TS error) and/or third_party patches are returned despite `sources: ['os']`.

- [ ] **Step 1.7: Implement source filtering in the evaluator**

In `patchApprovalEvaluator.ts`:

1. Add `sources` to `RingConfig`:

```typescript
export interface RingConfig {
  ringId: string | null;
  categoryRules: CategoryRule[];
  autoApprove: unknown;
  deferralDays: number;
  /** Policy-level source selections ('os', 'third_party', ...). Absent/empty = no filtering (legacy). */
  sources?: string[];
}
```

2. Add `source: patches.source` to the select in `resolveApprovedPatchesForDevice` (the existing `.select({...})` block at line ~54).

3. Immediately after the `pendingPatches` query (after the `if (pendingPatches.length === 0) return [];` early-exit), filter:

```typescript
  // Apply policy-level source filtering ('os' vs 'third_party' etc.).
  // Legacy jobs without sources skip filtering entirely.
  const allowedSources = buildAllowedPatchSources(ringConfig.sources);
  const candidatePatches = allowedSources
    ? pendingPatches.filter((p) => allowedSources.has(p.source))
    : pendingPatches;

  if (candidatePatches.length === 0) return [];
```

4. Use `candidatePatches` instead of `pendingPatches` in the manual-approvals query (`const patchIds = candidatePatches.map((p) => p.patchId);`) and in the final `for (const patch of candidatePatches)` loop.

- [ ] **Step 1.8: Run tests to verify they pass**

Same command as Step 1.2. Expected: all tests PASS.

- [ ] **Step 1.9: Commit**

```bash
git add apps/api/src/services/patchApprovalEvaluator.ts apps/api/src/services/patchApprovalEvaluator.test.ts
git commit -m "feat(patches): enforce policy source selection in patch approval evaluator"
```

---

### Task 2: Make the `third_party_app` ring category rule functional

**Files:**
- Modify: `apps/api/src/services/patchApprovalEvaluator.ts`
- Modify: `apps/api/src/services/patchApprovalEvaluator.test.ts`

Context: `UpdateRingForm.tsx` offers a `third_party_app` category rule, but agents report categories like `application`, `homebrew`, `homebrew-cask` (and catalog enrichment can overwrite them). The rule currently matches nothing. Fix: match `third_party_app` rules against **patch source** (`third_party`/`custom`), with exact category match taking precedence.

- [ ] **Step 2.1: Write failing tests**

Append to the `resolveApprovedPatchesForDevice` describe block (or a new describe) in `patchApprovalEvaluator.test.ts`:

```typescript
describe('third_party_app category rule', () => {
  beforeEach(() => {
    vi.mocked(db.select).mockReset();
  });

  const ringWithThirdPartyRule: RingConfig = {
    ringId: RING_ID,
    categoryRules: [{ category: 'third_party_app', autoApprove: true }],
    autoApprove: {},
    deferralDays: 0,
  };

  it('auto-approves a third_party-source patch regardless of its category string', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000010', source: 'third_party', category: 'homebrew-cask' })],
      []
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, ringWithThirdPartyRule);

    expect(approved).toHaveLength(1);
    expect(approved[0].approvalReason).toBe('category_rule');
  });

  it('does not apply the third_party_app rule to OS-source patches', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000011', source: 'microsoft', category: 'application' })],
      []
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, ringWithThirdPartyRule);

    expect(approved).toHaveLength(0);
  });

  it('prefers an exact category rule over the third_party_app fallback', async () => {
    mockPendingAndApprovals(
      [pendingRow({ patchId: 'aaaaaaaa-0000-0000-0000-000000000012', source: 'third_party', category: 'homebrew', severity: 'low' })],
      []
    );

    const approved = await resolveApprovedPatchesForDevice(DEVICE_ID, ORG_ID, {
      ...ringWithThirdPartyRule,
      categoryRules: [
        // exact rule blocks low severity...
        { category: 'homebrew', autoApprove: true, severityFilter: ['critical'] },
        // ...and must NOT fall through to the permissive third_party_app rule
        { category: 'third_party_app', autoApprove: true },
      ],
    });

    expect(approved).toHaveLength(0);
  });
});
```

- [ ] **Step 2.2: Run tests to verify the new ones fail**

Run: same command as Step 1.2.
Expected: first new test FAILS (0 approved — rule never matches `homebrew-cask`). The other two may pass already; that's fine, they pin the precedence contract.

- [ ] **Step 2.3: Implement source-based matching for `third_party_app`**

In `evaluatePatchApproval` (line ~154):

1. Add `source: string` to the `PatchCandidate` interface.
2. Replace the "Priority 2: Category rule" lookup with:

```typescript
  // Priority 2: Category rule.
  // 'third_party_app' is a virtual category — agents report inconsistent
  // category strings for app updates (application/homebrew/homebrew-cask/...),
  // so it matches by patch source instead. An exact category rule wins.
  let rule = patch.category ? categoryRuleMap.get(patch.category.toLowerCase()) : undefined;
  if (!rule && isThirdPartyPatchSource(patch.source)) {
    rule = categoryRuleMap.get('third_party_app');
  }
  if (rule && rule.autoApprove) {
    // ... existing severity filter + deferral logic unchanged, then return 'category_rule';
  }
```

(Keep the existing severity/deferral body — only the lookup changes, and the surrounding `if (patch.category)` guard is replaced by the logic above since the fallback must work even when `category` is null.)

- [ ] **Step 2.4: Run tests to verify they pass**

Same command. Expected: all PASS.

- [ ] **Step 2.5: Commit**

```bash
git add apps/api/src/services/patchApprovalEvaluator.ts apps/api/src/services/patchApprovalEvaluator.test.ts
git commit -m "fix(patches): make third_party_app ring rule match by patch source"
```

---

### Task 3: Thread `sources` through `patchJobExecutor`

**Files:**
- Modify: `apps/api/src/jobs/patchJobExecutor.ts:361-378`
- Modify: `apps/api/src/jobs/patchJobExecutor.test.ts`

- [ ] **Step 3.1: Write the failing test**

Append to the existing `describe('patch job executor queueing', ...)` block in `patchJobExecutor.test.ts` (reuse the existing `createSelectChain` helper and mocks — `resolveApprovedPatchesForDevice` is already mocked at module level; `db.insert`/`db.update` are mocked in the `../db` factory):

```typescript
  it('passes the job sources through to the approval evaluator', async () => {
    vi.mocked(db.select)
      // patch job row
      .mockImplementationOnce(() => createSelectChain([{
        id: 'job-1',
        orgId: 'org-1',
        status: 'running',
        patches: { ringId: null, autoApprove: {}, sources: ['third_party'] },
        targets: { deviceIds: ['device-1'] },
      }]) as any)
      // device-in-org check
      .mockImplementationOnce(() => createSelectChain([{ id: 'device-1' }]) as any);

    vi.mocked(resolveApprovedPatchesForDevice).mockResolvedValueOnce([]);

    createPatchJobDeviceWorker();
    const result = await shared.processorRefs['patch-job-devices']({
      data: {
        type: 'execute-patch-job-device',
        patchJobId: 'job-1',
        deviceId: 'device-1',
        orgId: 'org-1',
      },
    });

    expect(resolveApprovedPatchesForDevice).toHaveBeenCalledWith(
      'device-1',
      'org-1',
      expect.objectContaining({ sources: ['third_party'] }),
    );
    expect(result).toEqual({ skipped: true, reason: 'No approved patches' });
  });
```

Check the top of the test file first: if the `../db` mock factory does not already provide `insert`/`update` chains that `markDeviceSkipped` needs (`db.insert(...).values(...)` and `db.update(...).set(...).where(...)`), extend the test's mocks accordingly (e.g. `vi.mocked(db.insert).mockImplementationOnce(() => ({ values: vi.fn(() => Promise.resolve()) }) as any)` and a `createUpdateChain` without `.returning`, matching how `markDeviceSkipped` at `patchJobExecutor.ts:566-590` uses them).

- [ ] **Step 3.2: Run the test to verify it fails**

Run: `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/jobs/patchJobExecutor.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: FAIL — `resolveApprovedPatchesForDevice` called WITHOUT `sources` in the third argument.

- [ ] **Step 3.3: Implement extraction in the executor**

In `patchJobExecutor.ts` (lines 361-378), extend the JSONB type and ringConfig:

```typescript
  // Extract ring config from job's patches JSONB
  const patchesConfig = patchJob.patches as {
    ringId?: string | null;
    categoryRules?: unknown[];
    autoApprove?: unknown;
    sources?: unknown;
  };
```

```typescript
  const ringConfig: RingConfig = {
    ringId: patchesConfig?.ringId ?? null,
    categoryRules: (Array.isArray(patchesConfig?.categoryRules)
      ? patchesConfig.categoryRules
      : []) as RingConfig['categoryRules'],
    autoApprove: patchesConfig?.autoApprove ?? {},
    deferralDays: 0,
    sources: Array.isArray(patchesConfig?.sources)
      ? patchesConfig.sources.filter((s): s is string => typeof s === 'string')
      : undefined,
  };
```

- [ ] **Step 3.4: Run the executor test file to verify all pass**

Same command as Step 3.2. Expected: all PASS (existing tests must stay green).

- [ ] **Step 3.5: Commit**

```bash
git add apps/api/src/jobs/patchJobExecutor.ts apps/api/src/jobs/patchJobExecutor.test.ts
git commit -m "feat(patches): pass policy sources from patch job to approval evaluator"
```

---

### Task 4: PatchTab UI — sources, auto-approve, severities

**Files:**
- Modify: `apps/web/src/components/configurationPolicies/featureTabs/PatchTab.tsx`
- Create: `apps/web/src/components/configurationPolicies/featureTabs/PatchTab.test.tsx`

UI design: a "Patch Sources" section with two checkbox cards (OS updates / Third-party applications — `firmware`/`drivers` stay hidden, no provider exists), then an "Automatic Approval" section with a toggle and severity chips, mirroring the validator contract (`sources` min 1; `autoApprove ⇒ ≥1 severity`). Place Patch Sources before the existing Approval Ring section.

- [ ] **Step 4.1: Write failing component tests**

Create `PatchTab.test.tsx` (mirrors `BackupTab.test.tsx` mock pattern; the rings fetch returns an empty list):

```typescript
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PatchTab from './PatchTab';
import { fetchWithAuth } from '../../../stores/auth';

const saveMock = vi.fn();
const removeMock = vi.fn();
const clearErrorMock = vi.fn();

vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('./useFeatureLink', () => ({
  useFeatureLink: () => ({
    save: saveMock,
    remove: removeMock,
    saving: false,
    error: undefined,
    clearError: clearErrorMock,
  }),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const baseProps = {
  policyId: 'policy-1',
  existingLink: null,
  onLinkChanged: vi.fn(),
  linkedPolicyId: undefined,
  parentLink: null,
} as any;

describe('PatchTab patch sources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ data: [] }),
    } as unknown as Response);
    saveMock.mockResolvedValue({ id: 'link-1', featureType: 'patch', inlineSettings: {} });
  });

  it('renders OS checked and third-party unchecked by default', async () => {
    render(<PatchTab {...baseProps} />);
    expect(await screen.findByLabelText(/os updates/i)).toBeChecked();
    expect(screen.getByLabelText(/third-party applications/i)).not.toBeChecked();
  });

  it('saves selected sources in inlineSettings', async () => {
    render(<PatchTab {...baseProps} />);
    fireEvent.click(await screen.findByLabelText(/third-party applications/i));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const [, payload] = saveMock.mock.calls[0];
    expect(payload.inlineSettings.sources).toEqual(['os', 'third_party']);
  });

  it('keeps at least one source selected', async () => {
    render(<PatchTab {...baseProps} />);
    const osBox = await screen.findByLabelText(/os updates/i);
    fireEvent.click(osBox); // attempt to uncheck the only source
    expect(screen.getByLabelText(/os updates/i)).toBeChecked();
  });

  it('reveals severity selection when auto-approve is enabled and saves it', async () => {
    render(<PatchTab {...baseProps} />);
    fireEvent.click(await screen.findByLabelText(/automatically approve/i));
    fireEvent.click(screen.getByRole('button', { name: /critical/i }));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const [, payload] = saveMock.mock.calls[0];
    expect(payload.inlineSettings.autoApprove).toBe(true);
    expect(payload.inlineSettings.autoApproveSeverities).toEqual(['critical']);
  });

  it('hydrates sources from an existing link', async () => {
    render(
      <PatchTab
        {...baseProps}
        existingLink={{
          id: 'link-1',
          featureType: 'patch',
          featurePolicyId: null,
          inlineSettings: { sources: ['third_party'], autoApprove: false, autoApproveSeverities: [] },
        }}
      />
    );
    expect(await screen.findByLabelText(/third-party applications/i)).toBeChecked();
    expect(screen.getByLabelText(/os updates/i)).not.toBeChecked();
  });
});
```

- [ ] **Step 4.2: Run the tests to verify they fail**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/configurationPolicies/featureTabs/PatchTab.test.tsx`
Expected: FAIL — no elements labeled "OS updates" / "Third-party applications".

- [ ] **Step 4.3: Implement the UI**

In `PatchTab.tsx`:

1. Extend the settings type and defaults:

```typescript
type PatchSourceOption = 'os' | 'third_party';
type Severity = 'critical' | 'important' | 'moderate' | 'low';

type PatchDeploymentSettings = {
  sources: PatchSourceOption[];
  autoApprove: boolean;
  autoApproveSeverities: Severity[];
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
  scheduleFrequency: 'weekly',
  scheduleTime: '02:00',
  scheduleDayOfWeek: 'sun',
  scheduleDayOfMonth: 1,
  rebootPolicy: 'if_required',
};

const sourceOptions: { value: PatchSourceOption; label: string; description: string }[] = [
  { value: 'os', label: 'OS updates', description: 'Windows Update, macOS software updates, and Linux package updates.' },
  { value: 'third_party', label: 'Third-party applications', description: 'Application updates via winget, Chocolatey, and Homebrew.' },
];

const severityOptions: { value: Severity; label: string }[] = [
  { value: 'critical', label: 'Critical' },
  { value: 'important', label: 'Important' },
  { value: 'moderate', label: 'Moderate' },
  { value: 'low', label: 'Low' },
];
```

2. Add toggle handlers (keep at least one source; `os`-mapped legacy values like `microsoft` may appear in stored settings — normalize on load):

```typescript
  const toggleSource = (value: PatchSourceOption) => {
    setSettings((prev) => {
      const has = prev.sources.includes(value);
      if (has && prev.sources.length === 1) return prev; // validator requires min 1
      return {
        ...prev,
        sources: has ? prev.sources.filter((s) => s !== value) : [...prev.sources, value],
      };
    });
  };

  const toggleSeverity = (value: Severity) => {
    setSettings((prev) => ({
      ...prev,
      autoApproveSeverities: prev.autoApproveSeverities.includes(value)
        ? prev.autoApproveSeverities.filter((s) => s !== value)
        : [...prev.autoApproveSeverities, value],
    }));
  };
```

When hydrating from `effectiveLink.inlineSettings` (both the `useState` initializer and the `useEffect`), normalize unknown stored source values so the two checkboxes stay accurate:

```typescript
const OS_VALUE_ALIASES = new Set(['os', 'microsoft', 'apple', 'linux']);
const THIRD_PARTY_VALUE_ALIASES = new Set(['third_party', 'custom']);

function normalizeSources(raw: unknown): PatchSourceOption[] {
  if (!Array.isArray(raw)) return ['os'];
  const result: PatchSourceOption[] = [];
  if (raw.some((s) => typeof s === 'string' && OS_VALUE_ALIASES.has(s))) result.push('os');
  if (raw.some((s) => typeof s === 'string' && THIRD_PARTY_VALUE_ALIASES.has(s))) result.push('third_party');
  return result.length > 0 ? result : ['os'];
}
```

Apply it wherever inlineSettings are merged, e.g.:

```typescript
  const [settings, setSettings] = useState<PatchDeploymentSettings>(() => {
    const inline = effectiveLink?.inlineSettings as Partial<PatchDeploymentSettings> | undefined;
    return { ...defaults, ...inline, sources: normalizeSources(inline?.sources) };
  });
```

(and the same `sources: normalizeSources(...)` override in the `useEffect` that re-merges `link.inlineSettings`.)

3. Render, before the Approval Ring section:

```tsx
      {/* Patch Sources */}
      <div>
        <h3 className="text-sm font-semibold">Patch Sources</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Which update sources this policy manages on assigned devices.
        </p>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          {sourceOptions.map((option) => (
            <label
              key={option.value}
              className={cn(
                'flex cursor-pointer flex-col gap-1 rounded-md border p-3 text-sm transition',
                settings.sources.includes(option.value)
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-muted text-muted-foreground hover:text-foreground'
              )}
            >
              <input
                type="checkbox"
                aria-label={option.label}
                checked={settings.sources.includes(option.value)}
                onChange={() => toggleSource(option.value)}
                className="hidden"
              />
              <span className="font-medium text-foreground">{option.label}</span>
              <span className="text-xs text-muted-foreground">{option.description}</span>
            </label>
          ))}
        </div>
      </div>
```

4. Render, after the Approval Ring section (before Schedule):

```tsx
      {/* Automatic Approval */}
      <div className="mt-6">
        <h3 className="text-sm font-semibold">Automatic Approval</h3>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            aria-label="Automatically approve patches by severity"
            checked={settings.autoApprove}
            onChange={(e) => update('autoApprove', e.target.checked)}
            className="h-4 w-4 rounded border"
          />
          <span>Automatically approve patches by severity</span>
        </label>
        {settings.autoApprove && (
          <div className="mt-2 flex flex-wrap gap-2">
            {severityOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => toggleSeverity(option.value)}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs transition',
                  settings.autoApproveSeverities.includes(option.value)
                    ? 'border-primary/40 bg-primary/10 text-primary'
                    : 'border-muted text-muted-foreground hover:text-foreground'
                )}
              >
                {option.label}
              </button>
            ))}
            {settings.autoApproveSeverities.length === 0 && (
              <p className="w-full text-xs text-amber-600">
                Select at least one severity for auto-approval.
              </p>
            )}
          </div>
        )}
      </div>
```

- [ ] **Step 4.4: Run the component tests to verify they pass**

Same command as Step 4.2. Expected: all PASS. (If `getByRole('button', { name: /save/i })` is ambiguous because FeatureTabShell renders multiple buttons, inspect FeatureTabShell's save button label and tighten the matcher — fix the test, not the shell.)

- [ ] **Step 4.5: Commit**

```bash
git add apps/web/src/components/configurationPolicies/featureTabs/PatchTab.tsx apps/web/src/components/configurationPolicies/featureTabs/PatchTab.test.tsx
git commit -m "feat(web): expose patch sources and auto-approval in config policy patch tab"
```

---

### Task 5: Verification, docs, PR

- [ ] **Step 5.1: Run affected API tests single-fork** (full parallel suite is known-flaky; see memory)

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run \
  src/services/patchApprovalEvaluator.test.ts \
  src/jobs/patchJobExecutor.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true
```
Expected: PASS.

- [ ] **Step 5.2: Run affected web tests**

```bash
cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run \
  src/components/configurationPolicies/featureTabs/PatchTab.test.tsx
```
Expected: PASS.

- [ ] **Step 5.3: Type-check both apps**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
cd ../web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit 2>/dev/null || PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx astro check
```
Expected: no NEW errors (`agents.test.ts` / `apiKeyAuth.test.ts` errors in the API are pre-existing — see memory).

- [ ] **Step 5.4: Open PR**

PR description must include the behavior-change callout:

> **Behavior change:** `config_policy_patch_settings.sources` (default `['os']`) is now enforced during automated patch deployment. Policies that have not opted into `third_party` will no longer auto-deploy third-party patches via patch jobs (manual per-device install is unaffected). The previously dead `third_party_app` update-ring category rule now matches by patch source.

```bash
git push -u origin worktree-third-party-patch-sources
gh pr create --title "feat(patches): functional third-party patch source management" --body "..."
```

---

## Explicitly out of scope (future phases)

- Per-app allow/block lists and version pinning (Phase 3 of the gap analysis).
- Agent-side honoring of the `patch_scan` source parameter (scan-everything/deploy-filtered is intentional for visibility).
- Compliance view treating unmanaged third-party-missing as informational.
- `firmware`/`drivers` sources (no agent provider exists).
