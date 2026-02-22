# PR Review Fixes - BE-15 Application Whitelisting

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all issues identified in the comprehensive PR review of BE-15 — covering security bugs, data integrity problems, silent failures, observability gaps, and test coverage holes.

**Architecture:** Fixes are organized by file area. Each task is independent and can be committed separately. No schema migrations needed — the `remediationErrors` `.$type<>()` fix is TypeScript-only and requires no DB change. The `gracePeriod` rename only adds a comment (not a field rename) to avoid breaking JSONB data.

**Tech Stack:** Go (agent), TypeScript/Hono (API), Drizzle ORM, BullMQ, Vitest, Go testing package

---

## Task 1: Go agent — WMIC security fixes + tests

**Files:**
- Modify: `agent/internal/remote/tools/software.go`
- Modify: `agent/internal/remote/tools/software_test.go`

### Step 1: Fix WMIC single-quote injection

In `software.go`, the `shellMetaPattern` regex does not include single quotes. The WMIC WQL query interpolates the name directly into a `name like '%%%s%%'` format string.

**Fix 1a — Add single quote to shellMetaPattern (line 25):**
```go
shellMetaPattern = regexp.MustCompile("[;&|><`$']")
```

**Fix 1b — Change WMIC to exact match instead of substring (line 111):**
```go
fmt.Sprintf("name='%s'", name),
```

This eliminates both the injection vector and the overly-broad substring match (e.g., "Chrome" matching "Chrome Remote Desktop") in one change.

### Step 2: Log os.RemoveAll error before falling through (lines 160–164)

```go
if _, err := os.Stat(appPath); err == nil {
	if removeErr := os.RemoveAll(appPath); removeErr != nil {
		fmt.Printf("[UninstallSoftware] RemoveAll failed for %q: %v, falling back to package managers\n", appPath, removeErr)
	} else {
		return nil
	}
}
```

### Step 3: Add tests in software_test.go

Add after line 63 (end of TestIsProtectedLinuxPackage):

```go
func TestIsProtectedLinuxPackageSystemdVariants(t *testing.T) {
	t.Parallel()
	protected := []string{
		"systemd-journald",
		"systemd-resolved",
		"systemd-networkd",
	}
	for _, name := range protected {
		if !isProtectedLinuxPackage(name) {
			t.Fatalf("expected %q to be protected", name)
		}
	}
}

func TestValidateSoftwareNameBoundaries(t *testing.T) {
	t.Parallel()

	// Exactly 200 chars — must be valid
	long200 := strings.Repeat("a", 200)
	if err := validateSoftwareName(long200); err != nil {
		t.Fatalf("expected 200-char name to be valid, got: %v", err)
	}

	// 201 chars — must be invalid
	long201 := strings.Repeat("a", 201)
	if err := validateSoftwareName(long201); err == nil {
		t.Fatal("expected 201-char name to be invalid")
	}
}

func TestValidateSoftwareNameRejectsSingleQuote(t *testing.T) {
	t.Parallel()
	if err := validateSoftwareName("Joe's App"); err == nil {
		t.Fatal("expected name with single quote to be rejected")
	}
}
```

Also add `"strings"` to the import if not already present.

### Step 4: Run the Go tests

```bash
cd /Users/toddhebebrand/breeze/.worktrees/BE-15-application-whitelisting/agent
go test ./internal/remote/tools/... -v -run TestValidate
go test ./internal/remote/tools/... -v -run TestIsProtected
```

Expected: all PASS

### Step 5: Commit

```bash
git add agent/internal/remote/tools/software.go agent/internal/remote/tools/software_test.go
git commit -m "fix: WMIC injection via single quote, exact match uninstall, RemoveAll logging, extended tests"
```

---

## Task 2: Route safety — JSON parse failure + schedule failure logging

**Files:**
- Modify: `apps/api/src/routes/softwarePolicies.ts`

### Step 1: Fix JSON parse safety on POST /:id/check (line 531)

Replace:
```typescript
const rawPayload = await c.req.json().catch(() => ({}));
```
With:
```typescript
let rawPayload: unknown;
try {
  rawPayload = await c.req.json();
} catch {
  return c.json({ error: 'Invalid JSON in request body' }, 400);
}
```

Do the same for `POST /:id/remediate` (line 577).

### Step 2: Add server-side logging to schedule failure handlers

In both the `POST /` (create, line 246) and `PATCH /:id` (update, line 443) schedule warning catch blocks, add `console.error` before setting `scheduleWarning`:

```typescript
} catch (error) {
  scheduleWarning = error instanceof Error ? error.message : 'Failed to schedule compliance check';
  console.error('[softwarePolicies] Failed to schedule compliance check', {
    policyId: policy.id,
    error,
  });
}
```

### Step 3: Run tests

```bash
cd /Users/toddhebebrand/breeze/.worktrees/BE-15-application-whitelisting
pnpm --filter @breeze/api test:run
```

Expected: existing tests pass

### Step 4: Commit

```bash
git add apps/api/src/routes/softwarePolicies.ts
git commit -m "fix: return 400 on JSON parse failure in check/remediate routes, log schedule failures server-side"
```

---

## Task 3: AI Tool delete — add transaction + compliance status cleanup

**Files:**
- Modify: `apps/api/src/services/aiTools.ts`

### Step 1: Locate the delete action (around line 2072)

The existing code:
```typescript
if (action === 'delete') {
  if (!input.policyId) return JSON.stringify({ error: 'policyId is required' });
  ...
  await db
    .update(softwarePolicies)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(softwarePolicies.id, existing.id));

  return JSON.stringify({ success: true, message: `Policy "${existing.name}" disabled` });
}
```

### Step 2: Replace with transactional delete mirroring the REST endpoint

First, check what's imported at the top of `aiTools.ts`. You need `softwareComplianceStatus` imported from schema. Add it if missing.

Replace the `await db.update(...)` block:
```typescript
    await db.transaction(async (tx) => {
      await tx
        .update(softwarePolicies)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(softwarePolicies.id, existing.id));

      await tx
        .delete(softwareComplianceStatus)
        .where(eq(softwareComplianceStatus.policyId, existing.id));
    });
```

Also fix the tool description so `delete` accurately says "disable" (find the tool's `description` string in the `registerTool` call and update `'Create, update, delete, list, or fetch software policies'` to `'Create, update, disable (soft-delete), list, or fetch software policies'`).

### Step 3: Verify the import

Confirm `softwareComplianceStatus` is imported from `../db/schema`. If not, add it to the existing import.

### Step 4: Run tests

```bash
cd /Users/toddhebebrand/breeze/.worktrees/BE-15-application-whitelisting
pnpm --filter @breeze/api test:run
```

### Step 5: Commit

```bash
git add apps/api/src/services/aiTools.ts
git commit -m "fix: AI tool delete uses transaction to clean up compliance status rows, fix misleading description"
```

---

## Task 4: commandQueue — structured audit log error context

**Files:**
- Modify: `apps/api/src/services/commandQueue.ts`

### Step 1: Fix audit log .catch in queueCommand (line 194)

```typescript
.catch((err) => console.error('Failed to write audit log', {
  commandId: command.id,
  deviceId,
  type,
  error: err,
}));
```

### Step 2: Fix audit log .catch in executeCommand (line 391)

```typescript
.catch((err) => console.error('Failed to write audit log', {
  commandId: command.id,
  deviceId,
  type,
  orgId: device.orgId,
  error: err,
}));
```

### Step 3: Commit

```bash
git add apps/api/src/services/commandQueue.ts
git commit -m "fix: add structured context to audit log write failures in commandQueue"
```

---

## Task 5: recordSoftwarePolicyAudit — make fault-tolerant

**Files:**
- Modify: `apps/api/src/services/softwarePolicyService.ts`

### Step 1: Locate `recordSoftwarePolicyAudit` function (around line 586)

The current implementation does a bare `await db.insert(...)`. Any failure propagates to callers (BullMQ job processors), causing the entire job to fail and retry — which can duplicate uninstall commands.

### Step 2: Wrap the db.insert in try-catch

```typescript
export async function recordSoftwarePolicyAudit(input: {
  orgId: string;
  policyId?: string;
  deviceId?: string;
  action: string;
  actor: string;
  actorId?: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(softwarePolicyAudit).values({
      orgId: input.orgId,
      policyId: input.policyId ?? null,
      deviceId: input.deviceId ?? null,
      action: input.action,
      actor: input.actor,
      actorId: input.actorId ?? null,
      details: input.details ?? null,
    });
  } catch (err) {
    console.error('[softwarePolicyService] Failed to write policy audit record', {
      orgId: input.orgId,
      policyId: input.policyId,
      deviceId: input.deviceId,
      action: input.action,
      error: err,
    });
  }
}
```

This means audit failures are logged but never cause job retries or duplicate commands.

### Step 3: Run tests

```bash
cd /Users/toddhebebrand/breeze/.worktrees/BE-15-application-whitelisting
pnpm --filter @breeze/api test:run
```

### Step 4: Commit

```bash
git add apps/api/src/services/softwarePolicyService.ts
git commit -m "fix: make recordSoftwarePolicyAudit fault-tolerant to prevent job retries from audit write failures"
```

---

## Task 6: Workers — observability, defaults, silent exits

**Files:**
- Modify: `apps/api/src/jobs/softwareComplianceWorker.ts`
- Modify: `apps/api/src/jobs/softwareRemediationWorker.ts`

### Step 1: Change autoUninstallEnabled default to false (softwareComplianceWorker.ts:101-106)

Auto-uninstall is destructive and should be explicitly opted into. Change the default-when-absent from `true` to `false`:

```typescript
if (!raw || typeof raw !== 'object') {
  return {
    autoUninstallEnabled: false,
    gracePeriodHours: 0,
    cooldownMinutes: REMEDIATION_COOLDOWN_DEFAULT_MINUTES,
  };
}
// ...
autoUninstallEnabled: options.autoUninstall === true,  // was: !== false
```

### Step 2: Add console.error in per-device compliance error catch (softwareComplianceWorker.ts:380)

At the start of the catch block, before the existing `complianceUpserts.push(...)`:
```typescript
} catch (error) {
  console.error('[SoftwareComplianceWorker] Device compliance evaluation failed', {
    policyId: policy.id,
    deviceId,
    error,
  });
  complianceUpserts.push({ ... }); // existing code
  ...
```

### Step 3: Add structured logging to worker event handlers

In `softwareComplianceWorker.ts` (lines 493-499), replace:
```typescript
softwareComplianceWorker.on('error', (error) => {
  console.error('[SoftwareComplianceWorker] Worker error:', error);
});

softwareComplianceWorker.on('failed', (job, error) => {
  console.error(`[SoftwareComplianceWorker] Job ${job?.id} failed:`, error);
});
```
With:
```typescript
softwareComplianceWorker.on('error', (error) => {
  console.error('[SoftwareComplianceWorker] Worker error', { error });
});

softwareComplianceWorker.on('failed', (job, error) => {
  console.error('[SoftwareComplianceWorker] Job failed', {
    jobId: job?.id,
    policyId: (job?.data as CheckPolicyJobData | undefined)?.policyId,
    error,
  });
});
```

Do the same for `softwareRemediationWorker.ts` (lines 320-326):
```typescript
softwareRemediationWorker.on('error', (error) => {
  console.error('[SoftwareRemediationWorker] Worker error', { error });
});

softwareRemediationWorker.on('failed', (job, error) => {
  console.error('[SoftwareRemediationWorker] Job failed', {
    jobId: job?.id,
    policyId: (job?.data as RemediateDeviceJobData | undefined)?.policyId,
    deviceId: (job?.data as RemediateDeviceJobData | undefined)?.deviceId,
    error,
  });
});
```

### Step 4: Add warning when withSystemDbAccessContext is missing

In `softwareComplianceWorker.ts` (line 24-27):
```typescript
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  if (typeof withSystem !== 'function') {
    console.error('[SoftwareComplianceWorker] withSystemDbAccessContext unavailable — DB operations may bypass RLS');
  }
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};
```

Do the same in `softwareRemediationWorker.ts` (line 11-14), with `[SoftwareRemediationWorker]`.

### Step 5: Fix processRemediateDevice silent early exits (softwareRemediationWorker.ts:103-128)

When policy is missing/inactive, log and clear the stuck `pending` status:
```typescript
if (!policy || !policy.isActive) {
  console.warn('[SoftwareRemediationWorker] Policy not found or inactive, skipping remediation', {
    policyId: data.policyId,
    deviceId: data.deviceId,
  });
  return {
    policyId: data.policyId,
    deviceId: data.deviceId,
    commandsQueued: 0,
    errors: 0,
  };
}
```

When compliance record is missing:
```typescript
if (!compliance) {
  console.warn('[SoftwareRemediationWorker] Compliance record not found', {
    policyId: data.policyId,
    deviceId: data.deviceId,
  });
  return {
    policyId: data.policyId,
    deviceId: data.deviceId,
    commandsQueued: 0,
    errors: 0,
  };
}
```

### Step 6: Run tests

```bash
cd /Users/toddhebebrand/breeze/.worktrees/BE-15-application-whitelisting
pnpm --filter @breeze/api test:run
```

Expected: all pass

### Step 7: Commit

```bash
git add apps/api/src/jobs/softwareComplianceWorker.ts apps/api/src/jobs/softwareRemediationWorker.ts
git commit -m "fix: autoUninstall defaults to false, structured worker error logging, silent exits now log warnings"
```

---

## Task 7: Tests — shouldQueueAutoRemediation + resolveOrgIdForWrite

**Files:**
- Modify: `apps/api/src/services/softwarePolicyService.test.ts`

The `shouldQueueAutoRemediation` function is private to `softwareComplianceWorker.ts`. To test it, we need to export it for testing.

### Step 1: Export shouldQueueAutoRemediation for testing

In `softwareComplianceWorker.ts`, change:
```typescript
function shouldQueueAutoRemediation(input: {
```
To:
```typescript
export function shouldQueueAutoRemediation(input: {
```

### Step 2: Create softwareComplianceWorker.test.ts

Create file: `apps/api/src/jobs/softwareComplianceWorker.test.ts`

```typescript
import { describe, expect, it } from 'vitest';
import { shouldQueueAutoRemediation } from './softwareComplianceWorker';

describe('shouldQueueAutoRemediation', () => {
  const now = new Date('2026-02-20T12:00:00Z');

  it('returns queue=false when remediation is already in_progress', () => {
    const result = shouldQueueAutoRemediation({
      violations: [],
      previousRemediationStatus: 'in_progress',
      lastRemediationAttempt: null,
      now,
      gracePeriodHours: 0,
      cooldownMinutes: 120,
    });
    expect(result.queue).toBe(false);
    expect(result.reason).toBe('in_progress');
  });

  it('returns queue=false when remediation is pending', () => {
    const result = shouldQueueAutoRemediation({
      violations: [],
      previousRemediationStatus: 'pending',
      lastRemediationAttempt: null,
      now,
      gracePeriodHours: 0,
      cooldownMinutes: 120,
    });
    expect(result.queue).toBe(false);
    expect(result.reason).toBe('in_progress');
  });

  it('returns queue=false during grace period', () => {
    const recentViolation = [{
      type: 'unauthorized',
      software: { name: 'TeamViewer Host', version: '15.2' },
      severity: 'critical',
      detectedAt: new Date('2026-02-20T11:00:00Z').toISOString(), // 1 hour ago
    }];

    const result = shouldQueueAutoRemediation({
      violations: recentViolation,
      previousRemediationStatus: null,
      lastRemediationAttempt: null,
      now,
      gracePeriodHours: 24, // 24-hour grace: violation is only 1 hour old
      cooldownMinutes: 120,
    });
    expect(result.queue).toBe(false);
    expect(result.reason).toBe('grace_period');
  });

  it('returns queue=true when grace period has expired', () => {
    const oldViolation = [{
      type: 'unauthorized',
      software: { name: 'TeamViewer Host', version: '15.2' },
      severity: 'critical',
      detectedAt: new Date('2026-02-18T12:00:00Z').toISOString(), // 48 hours ago
    }];

    const result = shouldQueueAutoRemediation({
      violations: oldViolation,
      previousRemediationStatus: null,
      lastRemediationAttempt: null,
      now,
      gracePeriodHours: 24, // expired
      cooldownMinutes: 120,
    });
    expect(result.queue).toBe(true);
  });

  it('returns queue=false within cooldown window', () => {
    const result = shouldQueueAutoRemediation({
      violations: [],
      previousRemediationStatus: 'failed',
      lastRemediationAttempt: new Date('2026-02-20T11:30:00Z'), // 30 min ago
      now,
      gracePeriodHours: 0,
      cooldownMinutes: 120, // 2 hour cooldown, only 30 min elapsed
    });
    expect(result.queue).toBe(false);
    expect(result.reason).toBe('cooldown');
  });

  it('returns queue=true when cooldown has elapsed', () => {
    const result = shouldQueueAutoRemediation({
      violations: [],
      previousRemediationStatus: 'failed',
      lastRemediationAttempt: new Date('2026-02-20T09:00:00Z'), // 3 hours ago
      now,
      gracePeriodHours: 0,
      cooldownMinutes: 120, // 2 hour cooldown has passed
    });
    expect(result.queue).toBe(true);
  });

  it('skips grace period check when gracePeriodHours is 0', () => {
    const recentViolation = [{
      type: 'unauthorized',
      software: { name: 'TeamViewer Host' },
      severity: 'critical',
      detectedAt: new Date('2026-02-20T11:59:00Z').toISOString(), // 1 min ago
    }];

    const result = shouldQueueAutoRemediation({
      violations: recentViolation,
      previousRemediationStatus: null,
      lastRemediationAttempt: null,
      now,
      gracePeriodHours: 0,
      cooldownMinutes: 120,
    });
    // No cooldown (no previous attempt), no grace (gracePeriodHours=0) → queue
    expect(result.queue).toBe(true);
  });
});
```

### Step 3: Add resolveOrgIdForWrite test

The function `resolveOrgIdForWrite` is private to `softwarePolicies.ts`. To test it we need to export it. Check if it's already exported; if not, add `export` to the function declaration.

Create file: `apps/api/src/routes/softwarePolicies.test.ts`

```typescript
import { describe, expect, it } from 'vitest';
import { resolveOrgIdForWrite } from './softwarePolicies';

// Minimal AuthContext stub
function makeOrgAuth(orgId: string) {
  return {
    scope: 'organization',
    orgId,
    canAccessOrg: (id: string) => id === orgId,
    orgCondition: () => null,
    user: { id: 'user-1' },
    accessibleOrgIds: [orgId],
  } as any;
}

function makePartnerAuth(orgIds: string[]) {
  return {
    scope: 'partner',
    orgId: undefined,
    canAccessOrg: (id: string) => orgIds.includes(id),
    orgCondition: () => null,
    user: { id: 'user-1' },
    accessibleOrgIds: orgIds,
  } as any;
}

describe('resolveOrgIdForWrite', () => {
  it('org-scope token cannot write to a different org', () => {
    const auth = makeOrgAuth('org-A');
    const result = resolveOrgIdForWrite(auth, 'org-B');
    expect(result.error).toBeDefined();
    expect(result.orgId).toBeUndefined();
  });

  it('org-scope token can write to its own org', () => {
    const auth = makeOrgAuth('org-A');
    const result = resolveOrgIdForWrite(auth, 'org-A');
    expect(result.orgId).toBe('org-A');
    expect(result.error).toBeUndefined();
  });

  it('org-scope token uses its own org when no requestedOrgId', () => {
    const auth = makeOrgAuth('org-A');
    const result = resolveOrgIdForWrite(auth);
    expect(result.orgId).toBe('org-A');
  });

  it('partner-scope token denied for inaccessible org', () => {
    const auth = makePartnerAuth(['org-A', 'org-B']);
    const result = resolveOrgIdForWrite(auth, 'org-C');
    expect(result.error).toBeDefined();
  });

  it('partner-scope token allowed for accessible org', () => {
    const auth = makePartnerAuth(['org-A', 'org-B']);
    const result = resolveOrgIdForWrite(auth, 'org-B');
    expect(result.orgId).toBe('org-B');
  });
});
```

### Step 4: Run new tests

```bash
cd /Users/toddhebebrand/breeze/.worktrees/BE-15-application-whitelisting
pnpm --filter @breeze/api test:run -- softwareComplianceWorker softwarePolicies
```

Expected: all new tests PASS

### Step 5: Commit

```bash
git add apps/api/src/jobs/softwareComplianceWorker.ts apps/api/src/jobs/softwareComplianceWorker.test.ts apps/api/src/routes/softwarePolicies.ts apps/api/src/routes/softwarePolicies.test.ts
git commit -m "test: add shouldQueueAutoRemediation and resolveOrgIdForWrite isolation tests"
```

---

## Task 8: Type fixes + schema annotation + minor cleanups

**Files:**
- Modify: `apps/api/src/db/schema/softwarePolicies.ts`
- Modify: `apps/api/src/jobs/softwareComplianceWorker.ts`
- Modify: `apps/api/src/services/aiToolSchemas.ts`
- Modify: `apps/api/src/services/aiTools.ts` (tool description already fixed in Task 3)

### Step 1: Add .$type to remediationErrors column (softwarePolicies.ts:94)

First, the `RemediationError` type needs to be exported from the schema or a shared file. Since it's currently defined in `softwareRemediationWorker.ts`, move it to the schema file:

In `softwarePolicies.ts`, add after `SoftwarePolicyRemediationOptions`:
```typescript
export type RemediationError = {
  softwareName?: string;
  message: string;
};
```

Then update the column definition:
```typescript
remediationErrors: jsonb('remediation_errors').$type<RemediationError[]>(),
```

Remove the `RemediationError` type definition from `softwareRemediationWorker.ts` (line 40-43) and import it from the schema:
```typescript
import { ..., type RemediationError } from '../db/schema/softwarePolicies';
```
(or from `'../db/schema'` if it's re-exported there)

### Step 2: Tighten ExistingComplianceState types (softwareComplianceWorker.ts:53-59)

Import the status union types at the top of the file if not already imported:
```typescript
import type { SoftwarePolicyComplianceStatus, SoftwarePolicyRemediationStatus } from '../services/softwarePolicyService';
```

Change:
```typescript
type ExistingComplianceState = {
  deviceId: string;
  status: string;
  violations: unknown;
  remediationStatus: string | null;
  lastRemediationAttempt: Date | null;
};
```
To:
```typescript
type ExistingComplianceState = {
  deviceId: string;
  status: SoftwarePolicyComplianceStatus;
  violations: unknown;
  remediationStatus: SoftwarePolicyRemediationStatus | null;
  lastRemediationAttempt: Date | null;
};
```

### Step 3: Fix catalogId validation in aiToolSchemas.ts (line 339)

The `catalogId` in the `manage_software_policy` schema uses `z.string().max(100).optional()` instead of a UUID validator. The `uuid` helper is already defined near the top of the file. Change:

```typescript
catalogId: uuid.optional(),
```

(It was already `uuid.optional()` in the schema output I saw — verify by re-reading line 339. If it shows `z.string().max(100).optional()`, change it to `uuid.optional()`.)

### Step 4: Add gracePeriod units comment to type and schemas

In `softwarePolicies.ts`, `SoftwarePolicyRemediationOptions`:
```typescript
gracePeriod?: number; // hours
```

In `softwarePolicies.ts` route schema (line 46):
```typescript
gracePeriod: z.number().int().min(0).max(24 * 90).optional(), // hours; max 90 days
```

In `aiToolSchemas.ts` (line 351):
```typescript
gracePeriod: z.number().int().min(0).max(24 * 90).optional(), // hours; max 90 days
```

### Step 5: Mark dead types with comments

In `softwarePolicies.ts`, `SoftwarePolicyViolation`:
```typescript
type: 'unauthorized' | 'missing'; // 'outdated' is planned but not yet emitted
```

In `SoftwarePolicyRemediationOptions`:
```typescript
notifyUser?: boolean; // not yet implemented
maintenanceWindowOnly?: boolean; // not yet implemented
```

### Step 6: Run tests

```bash
cd /Users/toddhebebrand/breeze/.worktrees/BE-15-application-whitelisting
pnpm --filter @breeze/api test:run
```

Expected: all pass (type changes should not break runtime behavior)

### Step 7: Commit

```bash
git add apps/api/src/db/schema/softwarePolicies.ts apps/api/src/jobs/softwareComplianceWorker.ts apps/api/src/jobs/softwareRemediationWorker.ts apps/api/src/services/aiToolSchemas.ts
git commit -m "fix: type remediationErrors column, tighten ExistingComplianceState types, uuid catalogId, annotate dead types"
```

---

## Task 9: Final test run + verification

### Step 1: Run all TypeScript tests

```bash
cd /Users/toddhebebrand/breeze/.worktrees/BE-15-application-whitelisting
pnpm --filter @breeze/api test:run
```

Expected: all pass

### Step 2: Run all Go tests

```bash
cd /Users/toddhebebrand/breeze/.worktrees/BE-15-application-whitelisting/agent
go test ./... -v
```

Expected: all pass

### Step 3: TypeScript type check

```bash
cd /Users/toddhebebrand/breeze/.worktrees/BE-15-application-whitelisting
pnpm --filter @breeze/api lint
```

Expected: no errors

---

## Summary of all changes

| # | Severity | File | Change |
|---|----------|------|--------|
| 1a | Critical | `software.go` | Add `'` to shellMetaPattern |
| 1b | Critical | `software.go` | WMIC exact match instead of substring |
| 1c | Important | `software.go` | Log RemoveAll error before fallback |
| 1d | Test | `software_test.go` | systemd variants, 200-char boundary, single-quote |
| 2a | Critical | `softwarePolicies.ts` | JSON parse → 400 on both check/remediate routes |
| 2b | Important | `softwarePolicies.ts` | console.error on schedule failure |
| 3 | Critical | `aiTools.ts` | AI tool delete: transaction + compliance cleanup + fix description |
| 4 | Critical | `commandQueue.ts` | Structured context on audit log write failures |
| 5 | Critical | `softwarePolicyService.ts` | recordSoftwarePolicyAudit fault-tolerant |
| 6a | Important | `softwareComplianceWorker.ts` | autoUninstall default → false |
| 6b | Important | `softwareComplianceWorker.ts` | console.error in per-device error catch |
| 6c | Important | `softwareComplianceWorker.ts` | Structured worker event logging |
| 6d | Important | `softwareComplianceWorker.ts` | withSystemDbAccessContext warning |
| 6e | Important | `softwareRemediationWorker.ts` | Structured worker event logging |
| 6f | Important | `softwareRemediationWorker.ts` | Silent exits now log warnings |
| 6g | Important | `softwareRemediationWorker.ts` | withSystemDbAccessContext warning |
| 7a | Test | `softwareComplianceWorker.test.ts` | shouldQueueAutoRemediation tests |
| 7b | Test | `softwarePolicies.test.ts` | resolveOrgIdForWrite cross-org tests |
| 8a | Type | `softwarePolicies.ts` | remediationErrors .$type annotation |
| 8b | Type | `softwareComplianceWorker.ts` | ExistingComplianceState typed status fields |
| 8c | Type | `aiToolSchemas.ts` | catalogId → uuid validator |
| 8d | Doc | `softwarePolicies.ts` | gracePeriod // hours comment, dead type annotations |
