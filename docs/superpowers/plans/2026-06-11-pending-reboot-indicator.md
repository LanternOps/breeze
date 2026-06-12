# Pending Reboot Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the agent's OS-level `pendingReboot` heartbeat flag to `devices.pending_reboot`, extend detection to Linux, and surface a "Reboot pending" badge/column in the device list and detail views.

**Architecture:** The Go agent already detects pending reboots on Windows and sends `pendingReboot` in every heartbeat; the API validates the field but drops it. This plan adds a Linux detector (marker files + cached `needs-restarting -r`), persists the flag in the main-agent heartbeat handler, exposes it through the device list/detail endpoints, re-points the `system.rebootRequired` filter at the new column, and renders amber badges in the web UI.

**Tech Stack:** Go (agent), Hono + Drizzle + Vitest (API), hand-written SQL migrations, Astro/React + Vitest/jsdom (web).

**Spec:** `docs/superpowers/specs/2026-06-11-pending-reboot-indicator-design.md`

**Environment notes (read first):**
- Node toolchain: prefix every pnpm/vitest/tsc command with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH` (default node 23 breaks pnpm engine-strict).
- The full API vitest suite is flaky when run in parallel — verify by running affected test files individually; trust CI for the full sweep.
- Go agent code lives in `agent/`, NOT `apps/agent/`.

---

### Task 1: Agent — restructure `DetectPendingReboot` per platform and add Linux detection

The function currently lives in two files: `reboot_detect_windows.go` (`//go:build windows`) and `reboot_other.go` (`//go:build !windows`, which ALSO contains `RebootState`/`RebootManager` stubs that must stay `!windows`). Adding a Linux implementation means moving the function out of `reboot_other.go` into per-platform files. The Linux detection logic goes in an **untagged** file with injected dependencies (matching the `winget.go`/`UserExecFunc` pattern in this package) so its tests run on any dev platform (macOS locally, Linux in CI).

**Files:**
- Create: `agent/internal/patching/reboot_detect_unix.go` (untagged core logic)
- Create: `agent/internal/patching/reboot_detect_unix_test.go` (untagged tests)
- Create: `agent/internal/patching/reboot_detect_linux.go` (`//go:build linux` wrapper)
- Create: `agent/internal/patching/reboot_detect_other.go` (`//go:build !windows && !linux` stub)
- Modify: `agent/internal/patching/reboot_other.go` (delete the `DetectPendingReboot` function only)

- [ ] **Step 1: Write the failing test**

Create `agent/internal/patching/reboot_detect_unix_test.go` (no build tag — table-driven, matching `winget_test.go` style):

```go
package patching

import (
	"os"
	"testing"
	"time"
)

func TestDetectPendingRebootLinux(t *testing.T) {
	marker := linuxRebootMarkers[0]
	statHit := func(p string) (os.FileInfo, error) {
		if p == marker {
			return nil, nil // FileInfo value is never inspected
		}
		return nil, os.ErrNotExist
	}
	statMiss := func(string) (os.FileInfo, error) { return nil, os.ErrNotExist }

	tests := []struct {
		name string
		stat func(string) (os.FileInfo, error)
		nr   func() (bool, bool)
		want bool
	}{
		{"marker file present", statHit, func() (bool, bool) { return false, false }, true},
		{"needs-restarting reports reboot needed", statMiss, func() (bool, bool) { return true, true }, true},
		{"needs-restarting reports clean", statMiss, func() (bool, bool) { return false, true }, false},
		{"no signal available", statMiss, func() (bool, bool) { return false, false }, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, reasons := detectPendingRebootLinux(tt.stat, tt.nr)
			if got != tt.want {
				t.Errorf("got %v, want %v (reasons: %v)", got, tt.want, reasons)
			}
			if got && len(reasons) == 0 {
				t.Error("expected at least one reason when reboot is pending")
			}
			if !got && len(reasons) != 0 {
				t.Errorf("expected no reasons when not pending, got %v", reasons)
			}
		})
	}
}

func TestNeedsRestartingCache(t *testing.T) {
	calls := 0
	c := &nrCache{ttl: time.Hour, run: func() (bool, bool) { calls++; return true, true }}

	if got, ok := c.get(); !got || !ok {
		t.Fatalf("first get: got (%v,%v), want (true,true)", got, ok)
	}
	c.get()
	if calls != 1 {
		t.Errorf("expected 1 underlying call while cached, got %d", calls)
	}

	c.at = time.Now().Add(-2 * time.Hour) // expire the cache
	c.get()
	if calls != 2 {
		t.Errorf("expected refresh after TTL expiry, got %d calls", calls)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/toddhebebrand/breeze/agent && go test ./internal/patching/ -run 'TestDetectPendingRebootLinux|TestNeedsRestartingCache' -v
```
Expected: compile FAILURE — `undefined: linuxRebootMarkers`, `undefined: detectPendingRebootLinux`, `undefined: nrCache`.

- [ ] **Step 3: Write the implementation**

Create `agent/internal/patching/reboot_detect_unix.go` (no build tag):

```go
package patching

import (
	"errors"
	"os"
	"os/exec"
	"sync"
	"time"
)

// linuxRebootMarkers are distro-written marker files whose presence means a
// reboot is required (Debian/Ubuntu apt writes /var/run/reboot-required).
var linuxRebootMarkers = []string{
	"/var/run/reboot-required",
}

// nrCache memoizes the needs-restarting result: the command can take seconds
// on RHEL-family systems and heartbeats run every cycle.
type nrCache struct {
	mu  sync.Mutex
	ttl time.Duration
	at  time.Time
	val bool
	ok  bool
	run func() (bool, bool)
}

func (c *nrCache) get() (bool, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.at.IsZero() && time.Since(c.at) < c.ttl {
		return c.val, c.ok
	}
	c.val, c.ok = c.run()
	c.at = time.Now()
	return c.val, c.ok
}

// detectPendingRebootLinux is the testable core of the Linux detector. Kept
// untagged with injected deps so its tests run on any dev platform; the
// //go:build linux wrapper in reboot_detect_linux.go wires the real deps.
func detectPendingRebootLinux(stat func(string) (os.FileInfo, error), nr func() (bool, bool)) (bool, []string) {
	var reasons []string
	for _, p := range linuxRebootMarkers {
		if _, err := stat(p); err == nil {
			reasons = append(reasons, "reboot-required marker present: "+p)
		}
	}
	if len(reasons) == 0 {
		if needed, ok := nr(); ok && needed {
			reasons = append(reasons, "needs-restarting reports reboot required")
		}
	}
	return len(reasons) > 0, reasons
}

// runNeedsRestarting executes `needs-restarting -r` (RHEL/dnf-utils).
// Exit 0 = no reboot needed, exit 1 = reboot needed, anything else (or the
// tool being absent) = no signal.
func runNeedsRestarting() (bool, bool) {
	path, err := exec.LookPath("needs-restarting")
	if err != nil {
		return false, false
	}
	if err := exec.Command(path, "-r").Run(); err == nil {
		return false, true
	} else {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
			return true, true
		}
	}
	return false, false
}
```

Create `agent/internal/patching/reboot_detect_linux.go`:

```go
//go:build linux

package patching

import (
	"os"
	"time"
)

var linuxNeedsRestarting = &nrCache{ttl: 30 * time.Minute, run: runNeedsRestarting}

// DetectPendingReboot reports whether the OS indicates a pending reboot.
func DetectPendingReboot() (bool, []string) {
	return detectPendingRebootLinux(os.Stat, linuxNeedsRestarting.get)
}
```

Create `agent/internal/patching/reboot_detect_other.go`:

```go
//go:build !windows && !linux

package patching

// DetectPendingReboot is a no-op on macOS — there is no reliable cheap
// pending-reboot signal short of querying softwareupdate.
func DetectPendingReboot() (bool, []string) {
	return false, nil
}
```

Modify `agent/internal/patching/reboot_other.go` — delete ONLY this function (lines ~7-10); everything else in the file (`RebootState`, `NotifyFunc`, `RebootManager` and its methods) stays, with the `//go:build !windows` tag unchanged:

```go
// DELETE these lines:
// DetectPendingReboot is a no-op on non-Windows platforms.
func DetectPendingReboot() (bool, []string) {
	return false, nil
}
```

- [ ] **Step 4: Run the tests and cross-compile checks**

```bash
cd /Users/toddhebebrand/breeze/agent && go test ./internal/patching/ -run 'TestDetectPendingRebootLinux|TestNeedsRestartingCache' -v
GOOS=linux go build ./... && GOOS=darwin go build ./... && GOOS=windows go build ./...
```
Expected: tests PASS; all three GOOS builds succeed (proves no duplicate/missing `DetectPendingReboot` symbol on any platform).

- [ ] **Step 5: Run the full patching package test suite with race detection**

```bash
cd /Users/toddhebebrand/breeze/agent && go test -race ./internal/patching/...
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add agent/internal/patching/reboot_detect_unix.go agent/internal/patching/reboot_detect_unix_test.go agent/internal/patching/reboot_detect_linux.go agent/internal/patching/reboot_detect_other.go agent/internal/patching/reboot_other.go
git commit -m "feat(agent): Linux pending-reboot detection via markers + needs-restarting"
```

---

### Task 2: Agent — send `pendingReboot: false` explicitly (remove `omitempty`)

With `omitempty`, the flag clearing after a reboot means the field vanishes from the wire instead of being sent as `false`. The API treats absent as false anyway, but explicit is unambiguous.

**Files:**
- Modify: `agent/internal/heartbeat/heartbeat.go:68`

- [ ] **Step 1: Edit the struct tag**

In `agent/internal/heartbeat/heartbeat.go` line 68, change:

```go
	PendingReboot    bool                      `json:"pendingReboot,omitempty"`
```
to:
```go
	PendingReboot    bool                      `json:"pendingReboot"`
```

- [ ] **Step 2: Build and test the heartbeat package**

```bash
cd /Users/toddhebebrand/breeze/agent && go build ./... && go test -race ./internal/heartbeat/...
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add agent/internal/heartbeat/heartbeat.go
git commit -m "fix(agent): send pendingReboot=false explicitly in heartbeat"
```

---

### Task 3: DB — migration + Drizzle schema for `devices.pending_reboot`

**Files:**
- Create: `apps/api/migrations/2026-06-11-j-device-pending-reboot.sql` (next free slot after `2026-06-11-i-devices-site-id-index.sql`; lexicographic ordering matters)
- Modify: `apps/api/src/db/schema/devices.ts:67` (after `isHeadless`)

- [ ] **Step 1: Write the migration**

Create `apps/api/migrations/2026-06-11-j-device-pending-reboot.sql` (idempotent, NO inner BEGIN/COMMIT — autoMigrate wraps each file in a transaction):

```sql
-- OS-level pending-reboot flag reported by the agent in every main-agent
-- heartbeat (Windows registry checks; Linux reboot-required markers /
-- needs-restarting). Self-clears on the first post-reboot heartbeat.
-- Backs the system.rebootRequired device filter and the "Reboot pending"
-- UI badge. Spec: docs/superpowers/specs/2026-06-11-pending-reboot-indicator-design.md
ALTER TABLE devices ADD COLUMN IF NOT EXISTS pending_reboot boolean NOT NULL DEFAULT false;

-- Partial index: the fleet-wide system.rebootRequired filter only ever looks
-- for pending_reboot = true, which is a small minority of rows.
CREATE INDEX IF NOT EXISTS devices_pending_reboot_idx ON devices (pending_reboot) WHERE pending_reboot = true;
```

- [ ] **Step 2: Add the column to the Drizzle schema**

In `apps/api/src/db/schema/devices.ts`, directly after the `isHeadless` line (line 67):

```typescript
  isHeadless: boolean('is_headless').notNull().default(false),
  // OS-level pending-reboot flag from the agent heartbeat (Windows registry
  // checks; Linux reboot-required markers / needs-restarting). Self-clears
  // on the first post-reboot heartbeat. Backs the system.rebootRequired
  // filter and the "Reboot pending" UI badge.
  pendingReboot: boolean('pending_reboot').notNull().default(false),
```

- [ ] **Step 3: Verify no schema drift**

```bash
cd /Users/toddhebebrand/breeze && export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm db:check-drift
```
Expected: no drift. Note: `2026-06-11-i-devices-site-id-index.sql` added an index with no schema-side declaration and passes drift check, so the partial index needs no Drizzle representation. If drift IS flagged for the index, mirror it in the schema by adding a third argument to the `pgTable` call: `(t) => [index('devices_pending_reboot_idx').on(t.pendingReboot).where(sql\`pending_reboot = true\`)]`.

- [ ] **Step 4: Apply locally and verify the column exists**

```bash
docker exec -i breeze-postgres psql -U breeze -d breeze -c "\d devices" | grep pending_reboot || echo "COLUMN MISSING — start the API once to run autoMigrate, then re-check"
```
Expected: `pending_reboot | boolean | not null | default false` (run the API dev server briefly if autoMigrate hasn't applied it yet).

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-06-11-j-device-pending-reboot.sql apps/api/src/db/schema/devices.ts
git commit -m "feat(db): devices.pending_reboot column + partial index"
```

---

### Task 4: API — persist the heartbeat flag (main-agent branch only)

**Files:**
- Modify: `apps/api/src/routes/agents/heartbeat.ts:310-317` (the `deviceUpdates` literal)
- Test: `apps/api/src/routes/agents/heartbeat.test.ts`

The Zod schema already parses the field (`apps/api/src/routes/agents/schemas.ts:137`: `pendingReboot: z.boolean().optional().catch(undefined)`) — no schema change needed. The watchdog branch (lines 161-177, `watchdogUpdates`) must NOT be touched.

- [ ] **Step 1: Read the existing test file to learn its helpers**

Read `apps/api/src/routes/agents/heartbeat.test.ts` (786 lines) — note how existing tests build a heartbeat request, how `updateMock`/`selectChainResolving` capture the `.set()` payload, and how main-agent vs watchdog heartbeats are distinguished (the `role: 'watchdog'` payload field). The new tests below must reuse those exact helpers.

- [ ] **Step 2: Write the failing tests**

Add to `heartbeat.test.ts`, following the file's existing pattern for asserting fields in the captured `db.update(devices).set(...)` argument (adapt helper/mock names to what Step 1 found — the assertions are the contract):

```typescript
describe('pendingReboot persistence', () => {
  it('persists pendingReboot=true from the main-agent heartbeat', async () => {
    // Build a standard main-agent heartbeat request (existing helper) with
    // payload { ...validHeartbeat, pendingReboot: true }
    // Assert the captured devices update payload:
    expect(capturedDeviceUpdate).toMatchObject({ pendingReboot: true });
  });

  it('clears pendingReboot when the field is absent (old agents / post-reboot)', async () => {
    // Same request WITHOUT a pendingReboot key in the payload.
    expect(capturedDeviceUpdate).toMatchObject({ pendingReboot: false });
  });

  it('watchdog heartbeats never touch pendingReboot', async () => {
    // Build a watchdog heartbeat request (role: 'watchdog', existing helper).
    expect(capturedWatchdogUpdate).not.toHaveProperty('pendingReboot');
  });
});
```

- [ ] **Step 3: Run the tests to verify the first two fail**

```bash
cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/agents/heartbeat.test.ts
```
Expected: the two persistence tests FAIL (no `pendingReboot` key in the update payload); the watchdog test passes already.

- [ ] **Step 4: Implement**

In `apps/api/src/routes/agents/heartbeat.ts`, add one line to the `deviceUpdates` literal (after `uptimeSeconds`, line 315):

```typescript
  const deviceUpdates: Record<string, unknown> = {
    lastSeenAt: new Date(),
    status: 'online',
    agentVersion: data.agentVersion,
    lastUser: data.lastUser ?? null,
    uptimeSeconds: data.uptime ?? null,
    // OS-level pending-reboot flag. Absent (old agents) means false — the
    // conservative default — and writing unconditionally lets the flag
    // self-clear on the first post-reboot heartbeat.
    pendingReboot: data.pendingReboot ?? false,
    updatedAt: new Date()
  };
```

- [ ] **Step 5: Run the test file again**

```bash
cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/agents/heartbeat.test.ts
```
Expected: ALL tests in the file PASS (including pre-existing ones).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/agents/heartbeat.ts apps/api/src/routes/agents/heartbeat.test.ts
git commit -m "feat(api): persist agent pendingReboot heartbeat flag to devices"
```

---

### Task 5: API — expose `pendingReboot` in device list + shared type

**Files:**
- Modify: `apps/api/src/routes/devices/core.ts:525` (list SELECT)
- Modify: `packages/shared/src/types/index.ts:152` (Device interface)

The detail route (`coreRoutes.get` at core.ts:678) fetches the device with a bare `.select()` — all columns — so it picks up `pendingReboot` automatically once the schema column exists. Only the list endpoint's explicit field list needs editing.

- [ ] **Step 1: Add the field to the list SELECT**

In `apps/api/src/routes/devices/core.ts`, in the `.select({...})` starting at line 501, after `isHeadless` (line 525):

```typescript
        isHeadless: devices.isHeadless,
        pendingReboot: devices.pendingReboot,
```

- [ ] **Step 2: Add the field to the shared Device interface**

In `packages/shared/src/types/index.ts`, after `isHeadless` (line 152):

```typescript
  isHeadless: boolean;
  pendingReboot: boolean;
```

- [ ] **Step 3: Check the OpenAPI doc**

```bash
grep -n "isHeadless" /Users/toddhebebrand/breeze/apps/api/src/openapi.ts
```
If the device response schema in `openapi.ts` documents `isHeadless`, add `pendingReboot: { type: 'boolean' }` alongside it in the same object. If devices responses aren't documented there (only the heartbeat request is, at line 656), skip.

- [ ] **Step 4: Type-check both packages**

```bash
cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
cd /Users/toddhebebrand/breeze/packages/shared && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
```
Expected: no NEW errors (pre-existing failures in `agents.test.ts` / `apiKeyAuth.test.ts` are known).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/devices/core.ts packages/shared/src/types/index.ts apps/api/src/openapi.ts
git commit -m "feat(api): return pendingReboot in device list response"
```

---

### Task 6: API — re-point `system.rebootRequired` filter at the new column

**Files:**
- Modify: `apps/api/src/services/filterEngine.ts:119` (field definition) and `:217-229` (SQL rendering)
- Test: `apps/api/src/services/filterEngine.test.ts:94-99`

- [ ] **Step 1: Update the failing test first**

Replace the existing test at `filterEngine.test.ts:94-99`:

```typescript
    it('system.rebootRequired → devices.pending_reboot column', () => {
      const sql = render({ field: 'system.rebootRequired', operator: 'equals', value: 'yes' });
      expect(sql).toMatch(/pending_reboot/i);
      expect(sql).not.toMatch(/patch_job_results/i);
    });
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/filterEngine.test.ts
```
Expected: FAIL — rendered SQL still references `patch_job_results`.

- [ ] **Step 3: Implement**

In `apps/api/src/services/filterEngine.ts`:

(a) Field definition, line 119 — update the description:

```typescript
  { key: 'system.rebootRequired', label: 'Reboot Required', category: 'core', type: 'boolean', operators: ['equals', 'notEquals'], description: 'Device OS reports a reboot is pending' },
```

(b) SQL rendering, lines 217-229 — swap the `patch_job_results` EXISTS subquery for the column predicate. The surrounding equals/notEquals negation logic is shared and stays untouched:

```typescript
  if (field === 'patches.pending' || field === 'alerts.critical' || field === 'system.rebootRequired') {
    let inner: SQL<unknown>;
    if (field === 'patches.pending') {
      inner = sql`EXISTS (SELECT 1 FROM device_patches WHERE device_id = ${devices.id} AND status = 'pending')`;
    } else if (field === 'alerts.critical') {
      inner = sql`EXISTS (SELECT 1 FROM alerts WHERE device_id = ${devices.id} AND status = 'active' AND severity = 'critical')`;
    } else {
      // OS-level flag persisted from the agent heartbeat. Intentionally
      // broader than the old patch_job_results subquery: matches reboots
      // from any cause, so the filter agrees with the "Reboot pending"
      // badge. (Spec 2026-06-11-pending-reboot-indicator-design.md)
      inner = sql`${devices.pendingReboot} = true`;
    }
    const negative = value === false || value === 'no' || value === 'false';
    const negate = (operator === 'notEquals') !== negative;
    return negate ? sql`NOT (${inner})` : inner;
  }
```

- [ ] **Step 4: Run the test file**

```bash
cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/filterEngine.test.ts
```
Expected: ALL tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/filterEngine.ts apps/api/src/services/filterEngine.test.ts
git commit -m "feat(api): re-point system.rebootRequired filter at devices.pending_reboot"
```

---

### Task 7: Web — add `pendingReboot` to the Device type and both API→UI mappings

**Files:**
- Modify: `apps/web/src/components/devices/DeviceList.tsx:36-83` (local `Device` type)
- Modify: `apps/web/src/components/devices/DevicesPage.tsx:~187` (list transform)
- Modify: `apps/web/src/components/devices/DeviceDetailPage.tsx:~83` (detail transform)

- [ ] **Step 1: Extend the Device type**

In `DeviceList.tsx`, in the exported `Device` type, after `isHeadless?: boolean;`:

```typescript
  isHeadless?: boolean;
  /**
   * OS-level pending-reboot flag persisted from the agent heartbeat
   * (devices.pending_reboot). True when Windows registry / Linux
   * reboot-required markers say a reboot is outstanding. Absent on
   * responses from older API versions.
   */
  pendingReboot?: boolean;
```

- [ ] **Step 2: Map it in DevicesPage**

In `DevicesPage.tsx`, in the `transformedDevices` map (the `isHeadless` line is at 187), add alongside:

```typescript
          isHeadless: typeof d.isHeadless === 'boolean' ? d.isHeadless : undefined,
          pendingReboot: d.pendingReboot === true,
```

- [ ] **Step 3: Map it in DeviceDetailPage**

In `DeviceDetailPage.tsx`, in the `transformedDevice` literal (the `isHeadless` line is at 83), add alongside:

```typescript
        isHeadless: data.isHeadless ?? undefined,
        pendingReboot: data.pendingReboot === true,
```

- [ ] **Step 4: Type-check**

```bash
cd /Users/toddhebebrand/breeze/apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
```
Expected: no NEW errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/devices/DeviceList.tsx apps/web/src/components/devices/DevicesPage.tsx apps/web/src/components/devices/DeviceDetailPage.tsx
git commit -m "feat(web): thread pendingReboot through device type and page mappings"
```

---

### Task 8: Web — device list badge + toggleable column

**Files:**
- Modify: `apps/web/src/components/devices/DeviceList.tsx` (status cell ~line 590-613; column registry near `agentVersion` def at ~668)
- Modify: `apps/web/src/components/devices/columnVisibility.ts` (COLUMN_IDS at 9-33, COLUMN_LABELS at 36-61; do NOT touch DEFAULT_VISIBLE_COLUMNS — the column ships hidden by default)
- Test: `apps/web/src/components/devices/DeviceList.test.tsx`

- [ ] **Step 1: Write the failing tests**

Add to `DeviceList.test.tsx`, reusing the existing `baseDevice` fixture (lines 16-31) and following the agent-silent badge test style (lines 34-49):

```tsx
describe('DeviceList — pending reboot badge', () => {
  it('renders the amber badge when pendingReboot is true', () => {
    const device: Device = {
      ...baseDevice,
      id: '33333333-3333-3333-3333-333333333333',
      hostname: 'host-needs-reboot',
      pendingReboot: true,
    };

    render(<DeviceList devices={[device]} />);

    const badge = screen.getByTestId(`device-${device.id}-pending-reboot-badge`);
    expect(badge.textContent).toMatch(/Reboot pending/i);
  });

  it('renders no badge when pendingReboot is false or absent', () => {
    const explicitFalse: Device = {
      ...baseDevice,
      id: '44444444-4444-4444-4444-444444444444',
      pendingReboot: false,
    };

    render(<DeviceList devices={[explicitFalse, baseDevice]} />);

    expect(
      screen.queryByTestId(`device-${explicitFalse.id}-pending-reboot-badge`)
    ).toBeNull();
    expect(
      screen.queryByTestId(`device-${baseDevice.id}-pending-reboot-badge`)
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/toddhebebrand/breeze/apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/devices/DeviceList.test.tsx
```
Expected: the first new test FAILS (`Unable to find an element by: [data-testid="device-...-pending-reboot-badge"]`).

- [ ] **Step 3: Add the badge to the status cell**

In `DeviceList.tsx`, in the `status` column cell (lines 590-613), after the agent-silent badge block and inside the same flex wrapper:

```tsx
        {shouldShowAgentSilentBadge(device) && (
          /* ...existing agent-silent badge unchanged... */
        )}
        {device.pendingReboot && (
          <span
            data-testid={`device-${device.id}-pending-reboot-badge`}
            title="The OS reports a pending reboot (Windows registry / Linux reboot-required markers)."
            className="inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-medium bg-warning/15 text-warning border-warning/30"
          >
            Reboot pending
          </span>
        )}
```

- [ ] **Step 4: Register the toggleable column**

In `columnVisibility.ts`, add `'pendingReboot'` to `COLUMN_IDS` directly after `'status'`:

```typescript
  'status',
  'pendingReboot',
```

and to `COLUMN_LABELS`:

```typescript
  status: 'Status',
  pendingReboot: 'Pending Reboot',
```

In `DeviceList.tsx`, add a column definition to the column registry (same object as the `status` and `agentVersion` definitions; place it after `status`):

```tsx
pendingReboot: {
  header: () => <th key="pendingReboot" className="px-3 py-3">Pending Reboot</th>,
  cell: (device) => (
    <td key="pendingReboot" className="px-3 py-3 text-sm whitespace-nowrap">
      {device.pendingReboot ? (
        <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium bg-warning/15 text-warning border-warning/30">
          Reboot pending
        </span>
      ) : (
        dash
      )}
    </td>
  ),
},
```

(Display-only — no `sortHeader`, matching the spec; the advanced filter covers querying. If the registry's TypeScript type requires every `ColumnId` to have a definition, the compiler will flag any miss — fix until `tsc` is clean.)

- [ ] **Step 5: Run the tests**

```bash
cd /Users/toddhebebrand/breeze/apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/devices/DeviceList.test.tsx && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
```
Expected: all DeviceList tests PASS; no new type errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/devices/DeviceList.tsx apps/web/src/components/devices/columnVisibility.ts apps/web/src/components/devices/DeviceList.test.tsx
git commit -m "feat(web): pending-reboot badge and toggleable column in device list"
```

---

### Task 9: Web — device detail header badge

**Files:**
- Modify: `apps/web/src/components/devices/DeviceDetails.tsx:~212-216` (header, next to the status badge)

- [ ] **Step 1: Add the badge**

In `DeviceDetails.tsx`, inside the header flex row (lines 211-216), directly after the status `<span>`:

```tsx
              <span className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-xs font-medium ${statusColors[device.status]}`}>
                {statusLabels[device.status]}
              </span>
              {device.pendingReboot && (
                <span
                  data-testid="device-pending-reboot-badge"
                  title="The OS reports a pending reboot (Windows registry / Linux reboot-required markers)."
                  className="inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-xs font-medium bg-warning/15 text-warning border-warning/30"
                >
                  Reboot pending
                </span>
              )}
```

- [ ] **Step 2: Type-check and run the devices component tests**

```bash
cd /Users/toddhebebrand/breeze/apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/devices/
```
Expected: PASS. (If a `DeviceDetails.test.tsx` exists, add a badge render test mirroring the Task 8 Step 1 pattern with `data-testid="device-pending-reboot-badge"`; if none exists, do not create one just for this — the DeviceList tests cover the badge logic and the detail badge is the same one-line conditional.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/devices/DeviceDetails.tsx
git commit -m "feat(web): pending-reboot badge on device detail header"
```

---

### Task 10: Final verification sweep

- [ ] **Step 1: Re-run every affected test file individually** (full parallel vitest run is known-flaky locally; trust CI for the sweep)

```bash
cd /Users/toddhebebrand/breeze/agent && go test -race ./internal/patching/... ./internal/heartbeat/...
cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/agents/heartbeat.test.ts src/services/filterEngine.test.ts
cd /Users/toddhebebrand/breeze/apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/devices/
```
Expected: all PASS.

- [ ] **Step 2: Drift + type checks**

```bash
cd /Users/toddhebebrand/breeze && export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm db:check-drift
cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
cd /Users/toddhebebrand/breeze/apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
```
Expected: no drift, no new type errors (known pre-existing: `agents.test.ts`, `apiKeyAuth.test.ts`).

- [ ] **Step 3: End-to-end smoke (optional but recommended)**

With local docker compose dev stack running and a Windows or Linux test agent enrolled: trigger a heartbeat, then

```bash
docker exec -i breeze-postgres psql -U breeze -d breeze -c "SELECT hostname, pending_reboot FROM devices ORDER BY last_seen_at DESC LIMIT 5;"
```
Expected: column populated (false is fine — it proves the write path). On a Linux test box, `sudo touch /var/run/reboot-required` and wait one heartbeat to see it flip to true, then check the badge renders in the device list UI.

- [ ] **Step 4: Done — hand off**

Use the superpowers:finishing-a-development-branch skill (or open a PR per the repo's `gh pr merge --squash --admin` flow) once everything is green.
