# BE-15 Review Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all issues found in the PR review for BE-15 (application whitelisting / software policy remediation).

**Architecture:** Fixes span Go agent (`agent/internal/remote/tools/`), TypeScript API workers (`apps/api/src/jobs/`), routes (`apps/api/src/routes/`), services (`apps/api/src/services/`), and tests. Changes are purely additive error-handling improvements, security hardening, and test additions — no schema migrations needed.

**Tech Stack:** Go 1.22+, TypeScript/Node.js, Hono, Drizzle ORM, BullMQ, PostgreSQL

**Working directory:** `/Users/toddhebebrand/breeze/.worktrees/BE-15-application-whitelisting`

---

### Task 1: Fix WMI Injection (Security — Critical)

**Files:**
- Modify: `agent/internal/remote/tools/software.go:25`
- Modify: `agent/internal/remote/tools/software_test.go`

Single quotes in software names break out of the WQL string literal in:
```go
fmt.Sprintf("name like '%%%s%%'", name)  // software.go:111
```
`validateSoftwareName` blocks shell metacharacters but not `'`.

**Step 1: Add failing test for single quote injection**

Add to the `invalid` slice in `TestValidateSoftwareName`:
```go
"name'with'quotes",
"Foo' OR name like '%",
```

**Step 2: Run test to confirm it fails**
```bash
cd /Users/toddhebebrand/breeze/.worktrees/BE-15-application-whitelisting/agent && go test ./internal/remote/tools/... -run TestValidateSoftwareName -v
```
Expected: FAIL — single quote names currently pass validation.

**Step 3: Fix the `shellMetaPattern` to also block single and double quotes**

In `software.go:25`, change:
```go
shellMetaPattern = regexp.MustCompile("[;&|><`$]")
```
to:
```go
shellMetaPattern = regexp.MustCompile("[;&|><`$'\""]")
```
(blocks `'` and `"` — the WQL string delimiters)

**Step 4: Run test to confirm it passes**
```bash
cd /Users/toddhebebrand/breeze/.worktrees/BE-15-application-whitelisting/agent && go test ./internal/remote/tools/... -run TestValidateSoftwareName -v
```
Expected: PASS

**Step 5: Commit**
```bash
git add agent/internal/remote/tools/software.go agent/internal/remote/tools/software_test.go
git commit -m "fix: block single/double quotes in software name to prevent WQL injection"
```

---

### Task 2: Remove Dead SOFTWARE_INSTALL Code

**Files:**
- Modify: `apps/api/src/services/commandQueue.ts` (lines 62, 143)
- Modify: `agent/internal/remote/tools/types.go` (line 53)

`SOFTWARE_INSTALL` / `CmdSoftwareInstall` are declared and added to `AUDITED_COMMANDS` but have zero implementation. Sending this command silently fails on the agent. Keeping it in `AUDITED_COMMANDS` creates misleading audit records.

**Step 1: Remove from commandQueue.ts**

In `commandQueue.ts`, find and remove:
- Line `SOFTWARE_INSTALL: 'software_install',` from the `CommandTypes` object
- Line `CommandTypes.SOFTWARE_INSTALL,` from the `AUDITED_COMMANDS` set

**Step 2: Remove from agent types.go**

In `types.go`, remove:
```go
CmdSoftwareInstall   = "software_install"
```

**Step 3: Verify no references remain**
```bash
grep -r "SOFTWARE_INSTALL\|CmdSoftwareInstall\|software_install" /Users/toddhebebrand/breeze/.worktrees/BE-15-application-whitelisting/apps/api/src/ /Users/toddhebebrand/breeze/.worktrees/BE-15-application-whitelisting/agent/
```
Expected: zero results (or only in comments)

**Step 4: Run TypeScript type check**
```bash
cd /Users/toddhebebrand/breeze/.worktrees/BE-15-application-whitelisting && pnpm --filter api typecheck 2>/dev/null || pnpm --filter api exec tsc --noEmit
```

**Step 5: Commit**
```bash
git add apps/api/src/services/commandQueue.ts agent/internal/remote/tools/types.go
git commit -m "fix: remove unimplemented SOFTWARE_INSTALL from AUDITED_COMMANDS and agent types"
```

---

### Task 3: Add Execution Timeout to Agent Subprocess Calls

**Files:**
- Modify: `agent/internal/remote/tools/software.go` (lines 1, 210-221)

`runUninstallAttempts` uses `exec.Command` without a context/timeout. A hung `wmic` or `apt-get` blocks a BullMQ worker slot permanently.

**Step 1: Add context import**

In `software.go`, the imports block already has `os/exec`. Add `"context"` if not present.

**Step 2: Replace `exec.Command` in `runUninstallAttempts` with `exec.CommandContext`**

Replace:
```go
func runUninstallAttempts(softwareName string, attempts []uninstallAttempt) error {
	errors := make([]string, 0, len(attempts))
	attempted := 0

	for _, attempt := range attempts {
		if _, err := exec.LookPath(attempt.command); err != nil {
			continue
		}

		attempted++
		cmd := exec.Command(attempt.command, attempt.args...)
		output, err := cmd.CombinedOutput()
```
with:
```go
const uninstallTimeoutMinutes = 10

func runUninstallAttempts(softwareName string, attempts []uninstallAttempt) error {
	errors := make([]string, 0, len(attempts))
	attempted := 0

	for _, attempt := range attempts {
		if _, err := exec.LookPath(attempt.command); err != nil {
			continue
		}

		attempted++
		ctx, cancel := context.WithTimeout(context.Background(), uninstallTimeoutMinutes*time.Minute)
		cmd := exec.CommandContext(ctx, attempt.command, attempt.args...)
		output, err := cmd.CombinedOutput()
		cancel()
```

**Step 3: Build the agent to confirm it compiles**
```bash
cd /Users/toddhebebrand/breeze/.worktrees/BE-15-application-whitelisting/agent && go build ./...
```
Expected: no errors

**Step 4: Run all agent tests**
```bash
cd /Users/toddhebebrand/breeze/.worktrees/BE-15-application-whitelisting/agent && go test ./internal/remote/tools/... -v
```
Expected: PASS

**Step 5: Commit**
```bash
git add agent/internal/remote/tools/software.go
git commit -m "fix: add 10-minute timeout to software uninstall subprocess calls"
```

---

### Task 4: Fix macOS RemoveAll Error Propagation

**Files:**
- Modify: `agent/internal/remote/tools/software.go` (lines 154-172)

When `os.RemoveAll` fails, the error is silently discarded and Homebrew attempts follow. The final error omits the filesystem attempt.

**Step 1: Capture and propagate the RemoveAll error**

Replace the `uninstallSoftwareMacOS` function body:
```go
func uninstallSoftwareMacOS(name string) error {
	appPath, pathErr := safeMacOSApplicationPath(name)
	if pathErr != nil {
		return pathErr
	}

	if _, statErr := os.Stat(appPath); statErr == nil {
		if removeErr := os.RemoveAll(appPath); removeErr == nil {
			return nil
		}
		// Fall through to package manager attempts, but preserve the direct-removal error
		// in the combined error message so operators can diagnose permission issues.
	}

	attempts := []uninstallAttempt{
		{command: "brew", args: []string{"uninstall", "--cask", name}},
		{command: "brew", args: []string{"uninstall", name}},
	}

	return runUninstallAttempts(name, attempts)
}
```

Actually, to properly propagate the error we need to track it. Replace with:
```go
func uninstallSoftwareMacOS(name string) error {
	appPath, pathErr := safeMacOSApplicationPath(name)
	if pathErr != nil {
		return pathErr
	}

	var directRemoveErr error
	if _, statErr := os.Stat(appPath); statErr == nil {
		if removeErr := os.RemoveAll(appPath); removeErr == nil {
			return nil
		} else {
			directRemoveErr = fmt.Errorf("os.RemoveAll(%s): %w", appPath, removeErr)
		}
	}

	attempts := []uninstallAttempt{
		{command: "brew", args: []string{"uninstall", "--cask", name}},
		{command: "brew", args: []string{"uninstall", name}},
	}

	pkgErr := runUninstallAttempts(name, attempts)
	if pkgErr == nil {
		return nil
	}
	if directRemoveErr != nil {
		return fmt.Errorf("%w; also tried direct removal: %v", pkgErr, directRemoveErr)
	}
	return pkgErr
}
```

**Step 2: Build and test**
```bash
cd /Users/toddhebebrand/breeze/.worktrees/BE-15-application-whitelisting/agent && go build ./... && go test ./internal/remote/tools/... -v
```
Expected: PASS

**Step 3: Commit**
```bash
git add agent/internal/remote/tools/software.go
git commit -m "fix: propagate os.RemoveAll error in macOS uninstall fallback chain"
```

---

### Task 5: Expand Linux Protected Package List

**Files:**
- Modify: `agent/internal/remote/tools/software.go` (lines 26-36)
- Modify: `agent/internal/remote/tools/software_test.go`

Critical packages `apt`, `dpkg`, `rpm`, `grub`, `openssl`, `openssh-server` missing from the block list.

**Step 1: Add failing tests for missing packages**

Add to `TestIsProtectedLinuxPackage`:
```go
protected := []string{
    "systemd",
    "kernel-default",
    "linux-image-5.15.0-91-generic",
    "linux-headers-5.15.0",
    "systemd-resolved",
    "libc6",
    "bash",
    "apt",
    "dpkg",
    "rpm",
    "grub",
    "grub2-common",
    "openssl",
    "openssh-server",
    "initramfs-tools",
}
allowed := []string{
    "google-chrome-stable",
    "slack",
    "vscode",
    "nodejs",
}

for _, name := range protected {
    if !isProtectedLinuxPackage(name) {
        t.Errorf("expected %q to be protected", name)
    }
}
for _, name := range allowed {
    if isProtectedLinuxPackage(name) {
        t.Errorf("expected %q to be allowed", name)
    }
}
```

(Remove the existing three individual checks and replace with this table-driven test. Also change `t.Fatalf` to `t.Errorf` in the other tests so all cases run.)

**Step 2: Run test to confirm failures**
```bash
cd /Users/toddhebebrand/breeze/.worktrees/BE-15-application-whitelisting/agent && go test ./internal/remote/tools/... -run TestIsProtectedLinuxPackage -v
```
Expected: multiple FAIL lines for apt, dpkg, rpm, etc.

**Step 3: Expand the protected package map in software.go**

Replace the `protectedLinuxPackageNames` map:
```go
protectedLinuxPackageNames = map[string]struct{}{
    // Core OS
    "kernel":    {},
    "linux":     {},
    "systemd":   {},
    "glibc":     {},
    "libc6":     {},
    "coreutils": {},
    "bash":      {},
    "sudo":      {},
    "init":      {},
    // Package managers — removing these bricks the system's package management
    "apt":        {},
    "apt-get":    {},
    "dpkg":       {},
    "rpm":        {},
    "yum":        {},
    "dnf":        {},
    "zypper":     {},
    "pacman":     {},
    // Bootloader — removing grub makes the OS unbootable
    "grub":         {},
    "grub2":        {},
    "grub-common":  {},
    "grub2-common": {},
    "grub-efi":     {},
    // Security-critical
    "openssl":        {},
    "openssh-server": {},
    "openssh-client": {},
    "libssl":         {},
    // Init/recovery
    "initramfs-tools": {},
    "dracut":          {},
    "systemd-sysv":    {},
}
```

**Step 4: Run test to confirm it passes**
```bash
cd /Users/toddhebebrand/breeze/.worktrees/BE-15-application-whitelisting/agent && go test ./internal/remote/tools/... -run TestIsProtectedLinuxPackage -v
```
Expected: PASS

**Step 5: Commit**
```bash
git add agent/internal/remote/tools/software.go agent/internal/remote/tools/software_test.go
git commit -m "fix: expand Linux protected package list to include apt, dpkg, grub, openssl, openssh"
```

---

### Task 6: Fix Go Tests — Use t.Errorf Instead of t.Fatalf in Loops

**Files:**
- Modify: `agent/internal/remote/tools/software_test.go`

`t.Fatalf` inside for loops stops on first failure, hiding subsequent cases.

**Step 1: Replace t.Fatalf with t.Errorf in all loop bodies**

In `TestValidateSoftwareName`, change both occurrences:
```go
// valid loop
t.Errorf("expected %q to be valid, got error: %v", name, err)
// invalid loop
t.Errorf("expected %q to be invalid", name)
```

**Step 2: Run tests**
```bash
cd /Users/toddhebebrand/breeze/.worktrees/BE-15-application-whitelisting/agent && go test ./internal/remote/tools/... -v
```
Expected: PASS (behavior unchanged, all test cases now run on failure)

**Step 3: Commit**
```bash
git add agent/internal/remote/tools/software_test.go
git commit -m "fix: use t.Errorf instead of t.Fatalf in Go test loops so all cases run"
```

---

### Task 7: Add RLS Context Fallback Warning to Both Workers

**Files:**
- Modify: `apps/api/src/jobs/softwareComplianceWorker.ts` (lines 24-27)
- Modify: `apps/api/src/jobs/softwareRemediationWorker.ts` (lines 11-14)

Both workers silently fall back to running without the RLS context when `withSystemDbAccessContext` is unavailable. Peer worker `agentLogRetention.ts` already logs this case.

**Step 1: Update softwareComplianceWorker.ts**

Replace:
```typescript
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};
```
with:
```typescript
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  if (typeof withSystem !== 'function') {
    console.error('[SoftwareComplianceWorker] withSystemDbAccessContext is not available — running without access context');
  }
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};
```

**Step 2: Update softwareRemediationWorker.ts**

Same replacement, with prefix `[SoftwareRemediationWorker]`.

**Step 3: Commit**
```bash
git add apps/api/src/jobs/softwareComplianceWorker.ts apps/api/src/jobs/softwareRemediationWorker.ts
git commit -m "fix: log warning when RLS context fallback fires in software workers"
```

---

### Task 8: Add console.error to Per-Device Catch Block

**Files:**
- Modify: `apps/api/src/jobs/softwareComplianceWorker.ts` (line 380)

Per-device errors are silently converted to `status: 'unknown'`. Peer workers all log at catch boundaries. Operators cannot distinguish a DB error from an expected `unknown` state.

**Step 1: Add console.error as the first line in the catch block**

In `processCheckPolicy`, find the catch block (around line 380):
```typescript
    } catch (error) {
      complianceUpserts.push({
```

Replace with:
```typescript
    } catch (error) {
      console.error(
        `[SoftwareComplianceWorker] Compliance evaluation failed for device ${deviceId} (policy ${policy.id}):`,
        error
      );
      complianceUpserts.push({
```

**Step 2: Commit**
```bash
git add apps/api/src/jobs/softwareComplianceWorker.ts
git commit -m "fix: log per-device compliance evaluation errors instead of silently becoming unknown"
```

---

### Task 9: Add Logging to Worker No-Op Early Returns

**Files:**
- Modify: `apps/api/src/jobs/softwareComplianceWorker.ts` (`processCheckPolicy` policy not found)
- Modify: `apps/api/src/jobs/softwareRemediationWorker.ts` (`processRemediateDevice` policy/compliance missing)

Silent `{ commandsQueued: 0 }` returns make it impossible to distinguish stale jobs from real activity. Devices can get permanently stuck in `in_progress`.

**Step 1: Add warning to processCheckPolicy policy-not-found branch**

In `processCheckPolicy`, find:
```typescript
  if (!policy) {
    return {
      policyId: data.policyId,
      devicesEvaluated: 0,
      violations: 0,
      remediationQueued: 0,
    };
  }
```

Replace with:
```typescript
  if (!policy) {
    console.warn(
      `[SoftwareComplianceWorker] Policy ${data.policyId} not found or inactive — job may be stale (queued after deletion)`
    );
    return {
      policyId: data.policyId,
      devicesEvaluated: 0,
      violations: 0,
      remediationQueued: 0,
    };
  }
```

**Step 2: Add warnings to processRemediateDevice early returns**

In `processRemediateDevice`, find the `!policy || !policy.isActive` return and add:
```typescript
  if (!policy || !policy.isActive) {
    console.warn(
      `[SoftwareRemediationWorker] Policy ${data.policyId} not found or inactive for device ${data.deviceId} — skipping remediation`
    );
    return { policyId: data.policyId, deviceId: data.deviceId, commandsQueued: 0, errors: 0 };
  }
```

Find the `!compliance` return and add:
```typescript
  if (!compliance) {
    console.warn(
      `[SoftwareRemediationWorker] No compliance record for device ${data.deviceId} under policy ${data.policyId} — cannot remediate`
    );
    return { policyId: data.policyId, deviceId: data.deviceId, commandsQueued: 0, errors: 0 };
  }
```

**Step 3: Commit**
```bash
git add apps/api/src/jobs/softwareComplianceWorker.ts apps/api/src/jobs/softwareRemediationWorker.ts
git commit -m "fix: add warn logs to worker early-return no-op paths"
```

---

### Task 10: Add Server-Side Logging for Schedule Failures

**Files:**
- Modify: `apps/api/src/routes/softwarePolicies.ts` (two schedule warning catch blocks — POST create ~line 244, PATCH update ~line 441)

Schedule failures are silently captured into `scheduleWarning` with no server log. If Redis is down, operators see nothing.

**Step 1: Add console.error to both catch blocks**

For the POST (create) handler, find:
```typescript
    } catch (error) {
      scheduleWarning = error instanceof Error ? error.message : 'Failed to schedule compliance check';
    }
```

(There are two identical blocks.) In both, add the error log:
```typescript
    } catch (error) {
      scheduleWarning = error instanceof Error ? error.message : 'Failed to schedule compliance check';
      console.error(
        `[softwarePolicies] Failed to schedule compliance check for policy ${policy.id}:`,
        error
      );
    }
```

**Step 2: Commit**
```bash
git add apps/api/src/routes/softwarePolicies.ts
git commit -m "fix: log schedule failure server-side in software policy create/update routes"
```

---

### Task 11: Make recordSoftwarePolicyAudit Non-Fatal in Worker Catch Blocks

**Files:**
- Modify: `apps/api/src/jobs/softwareComplianceWorker.ts` (the catch block audit call)

`recordSoftwarePolicyAudit` can throw (transient DB failure). When it does inside the per-device catch block, it aborts the upsert batch mid-way. The audit write inside a catch block should never itself cause the job to fail.

**Step 1: Wrap the audit call inside the catch block in its own try-catch**

In the per-device catch block (the one just below the `console.error` we added in Task 8):
```typescript
    } catch (error) {
      console.error(
        `[SoftwareComplianceWorker] Compliance evaluation failed for device ${deviceId} (policy ${policy.id}):`,
        error
      );
      complianceUpserts.push({
        deviceId,
        policyId: policy.id,
        status: 'unknown',
        violations: [],
        checkedAt: now,
      });
      recordSoftwarePolicyEvaluation(policy.mode, 'unknown', Date.now() - startedAt, 'error');

      try {
        await recordSoftwarePolicyAudit({
          orgId: policy.orgId,
          policyId: policy.id,
          deviceId,
          action: 'compliance_check_failed',
          actor: 'system',
          details: {
            mode: policy.mode,
            error: error instanceof Error ? error.message : 'Unknown compliance evaluation error',
          },
        });
      } catch (auditError) {
        console.error('[SoftwareComplianceWorker] Failed to write audit record (non-fatal):', auditError);
      }
    }
```

**Step 2: Commit**
```bash
git add apps/api/src/jobs/softwareComplianceWorker.ts
git commit -m "fix: make audit write non-fatal inside per-device compliance error handler"
```

---

### Task 12: Cap Remediate-All Endpoint and Chunk the Status Update

**Files:**
- Modify: `apps/api/src/routes/softwarePolicies.ts` (remediate endpoint ~line 596-628)

When no `deviceIds` provided, the query fetches all violating devices without limit. A large result set (10K+ UUIDs) passed to `inArray` causes a PostgreSQL parameter limit error.

**Step 1: Add `.limit(500)` to the violation query**

Find the query inside the `else` branch (where `targetDeviceIds.length === 0`):
```typescript
      const rows = await db
        .select({ deviceId: softwareComplianceStatus.deviceId })
        .from(softwareComplianceStatus)
        .innerJoin(devices, eq(softwareComplianceStatus.deviceId, devices.id))
        .where(and(...complianceConditions));

      targetDeviceIds = Array.from(new Set(rows.map((row) => row.deviceId)));
```

Replace with:
```typescript
      const rows = await db
        .select({ deviceId: softwareComplianceStatus.deviceId })
        .from(softwareComplianceStatus)
        .innerJoin(devices, eq(softwareComplianceStatus.deviceId, devices.id))
        .where(and(...complianceConditions))
        .limit(500);

      targetDeviceIds = Array.from(new Set(rows.map((row) => row.deviceId)));
```

**Step 2: Chunk the status update that follows**

Find the `db.update` inside `if (queued > 0)`:
```typescript
    if (queued > 0) {
      await db
        .update(softwareComplianceStatus)
        .set({
          remediationStatus: 'pending',
          lastRemediationAttempt: new Date(),
        })
        .where(and(
          eq(softwareComplianceStatus.policyId, policy.id),
          inArray(softwareComplianceStatus.deviceId, targetDeviceIds),
        ));
    }
```

Replace with chunked version. First check whether a `chunkArray` helper exists in scope in this file. If not, add one inline, or just use the existing pattern. The file imports from Drizzle — add a simple chunk helper at the top of the handler:

```typescript
    if (queued > 0) {
      const CHUNK = 500;
      for (let i = 0; i < targetDeviceIds.length; i += CHUNK) {
        const chunk = targetDeviceIds.slice(i, i + CHUNK);
        await db
          .update(softwareComplianceStatus)
          .set({
            remediationStatus: 'pending',
            lastRemediationAttempt: new Date(),
          })
          .where(and(
            eq(softwareComplianceStatus.policyId, policy.id),
            inArray(softwareComplianceStatus.deviceId, chunk),
          ));
      }
    }
```

**Step 3: Commit**
```bash
git add apps/api/src/routes/softwarePolicies.ts
git commit -m "fix: cap remediate-all device query at 500 and chunk the status update"
```

---

### Task 13: Fix AI Tool Delete — Clean Up Compliance Status Rows

**Files:**
- Modify: `apps/api/src/services/aiTools.ts` (around line 2082)

The AI tool `delete` action only soft-deletes the policy. The REST `DELETE /:id` also deletes compliance status rows in a transaction. Stale violation rows persist on the dashboard.

**Step 1: Update the AI tool delete action**

Find:
```typescript
    if (action === 'delete') {
      if (!input.policyId) return JSON.stringify({ error: 'policyId is required' });

      const conditions: SQL[] = [eq(softwarePolicies.id, input.policyId as string)];
      const orgCondition = auth.orgCondition(softwarePolicies.orgId);
      if (orgCondition) conditions.push(orgCondition);

      const [existing] = await db.select().from(softwarePolicies).where(and(...conditions)).limit(1);
      if (!existing) return JSON.stringify({ error: 'Policy not found or access denied' });

      await db
        .update(softwarePolicies)
        .set({ isActive: false, updatedAt: new Date() })
        .where(eq(softwarePolicies.id, existing.id));

      return JSON.stringify({ success: true, message: `Policy "${existing.name}" disabled` });
    }
```

Replace the `await db.update(...)` with a transaction that mirrors the REST route:
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

Verify `softwareComplianceStatus` is already imported in the aiTools.ts file. If not, add it to the import from `'../db/schema'`.

**Step 2: Commit**
```bash
git add apps/api/src/services/aiTools.ts
git commit -m "fix: AI tool policy delete now cleans compliance status rows to match REST behavior"
```

---

### Task 14: Fix resolveTargetDeviceIdsForPolicy Unknown TargetType

**Files:**
- Modify: `apps/api/src/services/softwarePolicyService.ts` (around line 351)

Unknown `targetType` silently falls through to returning ALL devices in the org, which would apply every policy org-wide on any schema addition.

**Step 1: Add log + empty return for unrecognized targetType**

Find the fallthrough at the end of `resolveTargetDeviceIdsForPolicy`:
```typescript
  const rows = await db
    .select({ id: devices.id })
    .from(devices)
    .where(eq(devices.orgId, policy.orgId));

  return rows.map((row) => row.id);
```

Replace with:
```typescript
  console.warn(
    `[softwarePolicyService] resolveTargetDeviceIdsForPolicy: unrecognized targetType "${policy.targetType}" for policy in org ${policy.orgId} — returning empty device list`
  );
  return [];
```

**Step 2: Commit**
```bash
git add apps/api/src/services/softwarePolicyService.ts
git commit -m "fix: return empty device list for unrecognized policy targetType instead of all-org fallthrough"
```

---

### Task 15: Replace Compliance Overview In-Memory Aggregation with SQL

**Files:**
- Modify: `apps/api/src/routes/softwarePolicies.ts` (`GET /compliance/overview`, lines 281-331)

Currently loads all `softwareComplianceStatus` rows into Node.js memory and aggregates with a Map. At 10K+ agents this is hundreds of thousands of rows per dashboard load.

**Step 1: Replace with SQL aggregation**

The existing logic computes per-device "worst status" (violation > unknown > compliant), then counts per status. This requires a subquery:

```typescript
softwarePoliciesRoutes.get('/compliance/overview', async (c) => {
  const auth = c.get('auth');

  const orgCondition = auth.orgCondition(devices.orgId);

  // Compute per-device worst status in SQL via priority ordering
  const worstStatusSq = db
    .select({
      deviceId: softwareComplianceStatus.deviceId,
      status: sql<string>`
        CASE
          WHEN MAX(CASE WHEN ${softwareComplianceStatus.status} = 'violation' THEN 1 ELSE 0 END) = 1 THEN 'violation'
          WHEN MAX(CASE WHEN ${softwareComplianceStatus.status} = 'unknown' THEN 1 ELSE 0 END) = 1 THEN 'unknown'
          ELSE 'compliant'
        END
      `.as('status'),
    })
    .from(softwareComplianceStatus)
    .innerJoin(devices, eq(softwareComplianceStatus.deviceId, devices.id))
    .where(orgCondition ?? undefined)
    .groupBy(softwareComplianceStatus.deviceId)
    .as('worst_status');

  const counts = await db
    .select({
      status: worstStatusSq.status,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(worstStatusSq)
    .groupBy(worstStatusSq.status);

  let compliant = 0;
  let violations = 0;
  let unknown = 0;
  let total = 0;
  for (const row of counts) {
    total += row.count;
    if (row.status === 'compliant') compliant = row.count;
    else if (row.status === 'violation') violations = row.count;
    else unknown += row.count;
  }

  return c.json({ total, compliant, violations, unknown });
});
```

**Step 2: Verify TypeScript compiles**
```bash
cd /Users/toddhebebrand/breeze/.worktrees/BE-15-application-whitelisting && pnpm --filter api exec tsc --noEmit 2>&1 | head -30
```

**Step 3: Commit**
```bash
git add apps/api/src/routes/softwarePolicies.ts
git commit -m "perf: replace in-memory compliance overview aggregation with SQL GROUP BY"
```

---

### Task 16: Add TypeScript Tests — shouldQueueAutoRemediation

**Files:**
- Modify: `apps/api/src/services/softwarePolicyService.test.ts`

`shouldQueueAutoRemediation` is the gate preventing duplicate uninstall jobs and enforcing grace/cooldown. It is pure logic and completely untested.

First, export the function from `softwareComplianceWorker.ts` for testing:

**Step 1: Export shouldQueueAutoRemediation from the worker**

In `softwareComplianceWorker.ts`, change:
```typescript
function shouldQueueAutoRemediation(
```
to:
```typescript
export function shouldQueueAutoRemediation(
```

Also export `readEarliestUnauthorizedDetection`:
```typescript
export function readEarliestUnauthorizedDetection(
```

**Step 2: Create a new test file for worker logic**

Create: `apps/api/src/jobs/softwareComplianceWorker.test.ts`

```typescript
import { describe, expect, it } from 'vitest';
import { readEarliestUnauthorizedDetection, shouldQueueAutoRemediation } from './softwareComplianceWorker';

const NOW = new Date('2025-01-15T12:00:00Z');
const PAST_VIOLATION = [{ type: 'unauthorized', detectedAt: '2025-01-01T00:00:00Z' }];
const RECENT_VIOLATION = [{ type: 'unauthorized', detectedAt: '2025-01-15T11:00:00Z' }];

describe('shouldQueueAutoRemediation', () => {
  it('returns queue:false when status is in_progress', () => {
    const result = shouldQueueAutoRemediation({
      violations: PAST_VIOLATION,
      previousRemediationStatus: 'in_progress',
      lastRemediationAttempt: null,
      now: NOW,
      gracePeriodHours: 0,
      cooldownMinutes: 120,
    });
    expect(result).toEqual({ queue: false, reason: 'in_progress' });
  });

  it('returns queue:false when status is pending', () => {
    const result = shouldQueueAutoRemediation({
      violations: PAST_VIOLATION,
      previousRemediationStatus: 'pending',
      lastRemediationAttempt: null,
      now: NOW,
      gracePeriodHours: 0,
      cooldownMinutes: 120,
    });
    expect(result).toEqual({ queue: false, reason: 'in_progress' });
  });

  it('returns queue:false when inside grace period', () => {
    // violation detected 1 hour ago, grace period is 24 hours
    const result = shouldQueueAutoRemediation({
      violations: RECENT_VIOLATION,
      previousRemediationStatus: null,
      lastRemediationAttempt: null,
      now: NOW,
      gracePeriodHours: 24,
      cooldownMinutes: 120,
    });
    expect(result).toEqual({ queue: false, reason: 'grace_period' });
  });

  it('returns queue:true when outside grace period', () => {
    // violation detected 14 days ago, grace period is 24 hours
    const result = shouldQueueAutoRemediation({
      violations: PAST_VIOLATION,
      previousRemediationStatus: null,
      lastRemediationAttempt: null,
      now: NOW,
      gracePeriodHours: 24,
      cooldownMinutes: 120,
    });
    expect(result).toEqual({ queue: true });
  });

  it('returns queue:false when inside cooldown window', () => {
    const lastAttempt = new Date(NOW.getTime() - 30 * 60 * 1000); // 30 min ago
    const result = shouldQueueAutoRemediation({
      violations: PAST_VIOLATION,
      previousRemediationStatus: null,
      lastRemediationAttempt: lastAttempt,
      now: NOW,
      gracePeriodHours: 0,
      cooldownMinutes: 120,
    });
    expect(result).toEqual({ queue: false, reason: 'cooldown' });
  });

  it('returns queue:true when past cooldown window', () => {
    const lastAttempt = new Date(NOW.getTime() - 200 * 60 * 1000); // 200 min ago
    const result = shouldQueueAutoRemediation({
      violations: PAST_VIOLATION,
      previousRemediationStatus: null,
      lastRemediationAttempt: lastAttempt,
      now: NOW,
      gracePeriodHours: 0,
      cooldownMinutes: 120,
    });
    expect(result).toEqual({ queue: true });
  });

  it('returns queue:true with no previous state and no grace/cooldown', () => {
    const result = shouldQueueAutoRemediation({
      violations: PAST_VIOLATION,
      previousRemediationStatus: null,
      lastRemediationAttempt: null,
      now: NOW,
      gracePeriodHours: 0,
      cooldownMinutes: 120,
    });
    expect(result).toEqual({ queue: true });
  });

  it('skips grace period check when gracePeriodHours is 0', () => {
    // Even a recent violation should queue when grace is disabled
    const result = shouldQueueAutoRemediation({
      violations: RECENT_VIOLATION,
      previousRemediationStatus: null,
      lastRemediationAttempt: null,
      now: NOW,
      gracePeriodHours: 0,
      cooldownMinutes: 120,
    });
    expect(result).toEqual({ queue: true });
  });
});

describe('readEarliestUnauthorizedDetection', () => {
  it('returns null for non-array input', () => {
    expect(readEarliestUnauthorizedDetection(null)).toBeNull();
    expect(readEarliestUnauthorizedDetection('string')).toBeNull();
    expect(readEarliestUnauthorizedDetection({})).toBeNull();
  });

  it('returns null for empty array', () => {
    expect(readEarliestUnauthorizedDetection([])).toBeNull();
  });

  it('returns null when no unauthorized violations', () => {
    const violations = [{ type: 'missing', detectedAt: '2025-01-01T00:00:00Z' }];
    expect(readEarliestUnauthorizedDetection(violations)).toBeNull();
  });

  it('returns the earliest unauthorized detection date', () => {
    const violations = [
      { type: 'unauthorized', detectedAt: '2025-01-10T00:00:00Z' },
      { type: 'unauthorized', detectedAt: '2025-01-01T00:00:00Z' },
      { type: 'unauthorized', detectedAt: '2025-01-15T00:00:00Z' },
    ];
    const result = readEarliestUnauthorizedDetection(violations);
    expect(result?.toISOString()).toBe('2025-01-01T00:00:00.000Z');
  });

  it('skips violations with invalid detectedAt strings', () => {
    const violations = [
      { type: 'unauthorized', detectedAt: 'not-a-date' },
      { type: 'unauthorized', detectedAt: '2025-01-05T00:00:00Z' },
    ];
    const result = readEarliestUnauthorizedDetection(violations);
    expect(result?.toISOString()).toBe('2025-01-05T00:00:00.000Z');
  });

  it('ignores non-unauthorized violation types', () => {
    const violations = [
      { type: 'missing', detectedAt: '2024-01-01T00:00:00Z' },
      { type: 'unauthorized', detectedAt: '2025-01-05T00:00:00Z' },
    ];
    const result = readEarliestUnauthorizedDetection(violations);
    expect(result?.toISOString()).toBe('2025-01-05T00:00:00.000Z');
  });
});
```

**Step 3: Run the new tests**
```bash
cd /Users/toddhebebrand/breeze/.worktrees/BE-15-application-whitelisting && pnpm --filter api test src/jobs/softwareComplianceWorker.test.ts 2>&1 | tail -20
```
Expected: all PASS

**Step 4: Commit**
```bash
git add apps/api/src/jobs/softwareComplianceWorker.test.ts apps/api/src/jobs/softwareComplianceWorker.ts
git commit -m "test: add shouldQueueAutoRemediation and readEarliestUnauthorizedDetection tests"
```

---

### Task 17: Add TypeScript Tests — audit mode and compareSoftwareVersions edge cases

**Files:**
- Modify: `apps/api/src/services/softwarePolicyService.test.ts`

**Step 1: Add audit mode test**

In `softwarePolicyService.test.ts`, add a new `it` block after the existing blocklist test:

```typescript
it('evaluates audit mode with medium severity violations', () => {
  const policy = { mode: 'audit' as const, rules: null };
  const inventory = [{ name: 'Slack', version: '4.0.0', vendor: null, catalogId: null }];
  const rules = normalizeSoftwarePolicyRules([{ name: 'Slack', reason: 'Audit only' }]);
  const result = evaluateSoftwareInventory('audit', rules, inventory);

  expect(result).toHaveLength(1);
  expect(result[0].type).toBe('unauthorized');
  expect(result[0].severity).toBe('medium'); // audit produces medium, not critical
});

it('audit mode does not produce missing violations', () => {
  const rules = normalizeSoftwarePolicyRules([{ name: 'RequiredApp' }]);
  const emptyInventory: SoftwareInventoryRow[] = [];
  const result = evaluateSoftwareInventory('audit', rules, emptyInventory);
  expect(result).toHaveLength(0); // audit never flags missing software
});
```

**Step 2: Add compareSoftwareVersions edge cases**

```typescript
describe('compareSoftwareVersions', () => {
  it('returns 0 for identical versions', () => {
    expect(compareSoftwareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('correctly orders 10.x as greater than 9.x (numeric comparison)', () => {
    expect(compareSoftwareVersions('10.0', '9.9')).toBeGreaterThan(0);
    expect(compareSoftwareVersions('9.9', '10.0')).toBeLessThan(0);
  });

  it('handles empty string inputs', () => {
    expect(compareSoftwareVersions('', '')).toBe(0);
  });
});
```

**Step 3: Run all service tests**
```bash
cd /Users/toddhebebrand/breeze/.worktrees/BE-15-application-whitelisting && pnpm --filter api test src/services/softwarePolicyService.test.ts 2>&1 | tail -20
```
Expected: all PASS

**Step 4: Commit**
```bash
git add apps/api/src/services/softwarePolicyService.test.ts
git commit -m "test: add audit mode and compareSoftwareVersions edge case tests"
```

---

### Task 18: Add Context to commands.ts Catch Block Log

**Files:**
- Modify: `apps/api/src/routes/agents/commands.ts` (lines 87-93)

The software_uninstall catch block logs `commandId` but not `deviceId` or `policyId`, making triage impossible. Also ensure the log message identifies that the device may be stuck in `in_progress`.

**Step 1: Improve the catch block**

Find:
```typescript
    if (command.type === 'software_uninstall') {
      try {
        await handleSoftwareRemediationCommandResult(command, data);
      } catch (err) {
        console.error(`[agents] software remediation post-processing failed for ${commandId}:`, err);
      }
    }
```

Replace with:
```typescript
    if (command.type === 'software_uninstall') {
      try {
        await handleSoftwareRemediationCommandResult(command, data);
      } catch (err) {
        const policyId = command.payload && typeof command.payload === 'object'
          ? (command.payload as Record<string, unknown>).policyId ?? 'unknown'
          : 'unknown';
        console.error(
          `[agents] software remediation post-processing failed for command ${commandId} ` +
          `(device ${command.deviceId}, policy ${policyId}) — device may be stuck in_progress:`,
          err
        );
      }
    }
```

**Step 2: Commit**
```bash
git add apps/api/src/routes/agents/commands.ts
git commit -m "fix: add device/policy context to software remediation command result error log"
```

---

### Task 19: Add Warning to helpers.ts for Missing policyId

**Files:**
- Modify: `apps/api/src/routes/agents/helpers.ts` (around line 597)

Silent return when `policyId` is missing/invalid leaves no trace that a command result was unprocessable.

**Step 1: Add warning log**

Find:
```typescript
  const policyId = readTrimmedString(payload.policyId);
  if (!policyId || !isUuid(policyId)) {
    return;
  }
```

Replace with:
```typescript
  const policyId = readTrimmedString(payload.policyId);
  if (!policyId || !isUuid(policyId)) {
    console.warn(
      `[agents/helpers] software_uninstall command ${command.id} for device ${command.deviceId} ` +
      `has missing or invalid policyId — cannot update compliance status`
    );
    return;
  }
```

**Step 2: Commit**
```bash
git add apps/api/src/routes/agents/helpers.ts
git commit -m "fix: log warning when software_uninstall command result has missing policyId"
```

---

### Task 20: Final Verification

**Step 1: Run all TypeScript tests**
```bash
cd /Users/toddhebebrand/breeze/.worktrees/BE-15-application-whitelisting && pnpm --filter api test 2>&1 | tail -30
```
Expected: all PASS

**Step 2: Run all Go tests**
```bash
cd /Users/toddhebebrand/breeze/.worktrees/BE-15-application-whitelisting/agent && go test ./... 2>&1 | tail -20
```
Expected: all PASS

**Step 3: TypeScript type check**
```bash
cd /Users/toddhebebrand/breeze/.worktrees/BE-15-application-whitelisting && pnpm --filter api exec tsc --noEmit 2>&1 | head -20
```
Expected: no errors

**Step 4: Check no regressions in git log**
```bash
git log --oneline -20
```
