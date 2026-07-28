# RDS Phase 0 — Helper Waste Cleanups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the helper-process waste that exists on multi-session Windows hosts today: Assist helpers spawned into sessions that reject them, SYSTEM helpers retained forever for disconnected RDP sessions, and `run_as_user` failing late with a misleading "downgraded to SYSTEM" log.

**Architecture:** Three independent agent-side fixes from the phase-0 section of `docs/superpowers/specs/agent/2026-07-28-rds-per-session-helpers-design.md`. All logic lands in build-tag-free pure functions so tests run on any platform; the Windows-tagged files only wire them up. No API/web/DB changes.

**Tech Stack:** Go (agent), standard `testing` package, table-driven tests per the breeze-testing skill.

## Global Constraints

- Branch: `ToddHebebrand/multiple-user-helpers`. Commit after every task with the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Run Go tests with race detection: `cd agent && go test -race ./internal/<pkg>/...`. CI runs on non-Windows, so **new logic must live in files without `//go:build windows` tags**; Windows-tagged files may only contain thin wiring.
- Test files sit alongside source files (`foo.go` → `foo_test.go`), table-driven style.
- Session state/type strings on Windows are `"active" | "connected" | "disconnected"` and `"console" | "rdp" | "services"` (see `agent/internal/sessionbroker/helper_key.go:31-43`). `sessionbroker.GetConsoleSessionID()` returns `"0"` as its failure/Session-0 sentinel (`detector_windows.go:294-300`).
- Do not change SCM event handling (`lifecycle.go:97-121`) or `helper_key.go` eligibility rules — phase 1 (the on-demand lifecycle) owns those.

---

### Task 1: Console-only Assist session enumeration

Assist (Tauri) helpers launched into non-console sessions are rejected at broker auth (`broker.go:2452` — "assist role requires the active console session"), so spawning one per RDP session is pure waste. Filter the Windows enumerator down to the console session.

**Files:**
- Create: `agent/internal/helper/enumerator_filter.go`
- Create: `agent/internal/helper/enumerator_filter_test.go`
- Modify: `agent/internal/helper/enumerator_windows.go:16-44`

**Interfaces:**
- Consumes: `sessionbroker.DetectedSession` (fields `Session`, `Username`, `State`, `Type` — `agent/internal/sessionbroker/detector.go:30`), `sessionbroker.GetConsoleSessionID() string`.
- Produces: `consoleOnlySessions(detected []sessionbroker.DetectedSession, consoleID string) []SessionInfo` — pure, untagged, returns at most one `SessionInfo{Key, Username}`.

Note: `Manager.Apply` and its tests (`manager_test.go:184` spawns per enumerated session via `mockEnumerator`) are intentionally untouched — filtering happens in the platform enumerator, so manager behavior and tests stay valid.

- [ ] **Step 1: Write the failing test**

Create `agent/internal/helper/enumerator_filter_test.go`:

```go
package helper

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

func TestConsoleOnlySessions(t *testing.T) {
	tests := []struct {
		name      string
		detected  []sessionbroker.DetectedSession
		consoleID string
		wantKeys  []string
	}{
		{
			name: "console session active is returned",
			detected: []sessionbroker.DetectedSession{
				{Session: "2", Username: "alice", State: "active", Type: "console"},
			},
			consoleID: "2",
			wantKeys:  []string{"2"},
		},
		{
			name: "rdp sessions are excluded even when active",
			detected: []sessionbroker.DetectedSession{
				{Session: "2", Username: "alice", State: "active", Type: "console"},
				{Session: "3", Username: "bob", State: "active", Type: "rdp"},
				{Session: "4", Username: "carol", State: "active", Type: "rdp"},
			},
			consoleID: "2",
			wantKeys:  []string{"2"},
		},
		{
			name: "console session in disconnected state is excluded",
			detected: []sessionbroker.DetectedSession{
				{Session: "2", Username: "alice", State: "disconnected", Type: "console"},
			},
			consoleID: "2",
			wantKeys:  nil,
		},
		{
			name: "connected (lock screen) console session is included",
			detected: []sessionbroker.DetectedSession{
				{Session: "2", Username: "alice", State: "connected", Type: "console"},
			},
			consoleID: "2",
			wantKeys:  []string{"2"},
		},
		{
			name: "sentinel console id 0 yields nothing",
			detected: []sessionbroker.DetectedSession{
				{Session: "3", Username: "bob", State: "active", Type: "rdp"},
			},
			consoleID: "0",
			wantKeys:  nil,
		},
		{
			name: "empty console id yields nothing",
			detected: []sessionbroker.DetectedSession{
				{Session: "3", Username: "bob", State: "active", Type: "rdp"},
			},
			consoleID: "",
			wantKeys:  nil,
		},
		{
			name: "console session absent from snapshot yields nothing",
			detected: []sessionbroker.DetectedSession{
				{Session: "3", Username: "bob", State: "active", Type: "rdp"},
			},
			consoleID: "2",
			wantKeys:  nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := consoleOnlySessions(tt.detected, tt.consoleID)
			if len(got) != len(tt.wantKeys) {
				t.Fatalf("got %d sessions, want %d (%v)", len(got), len(tt.wantKeys), got)
			}
			for i, want := range tt.wantKeys {
				if got[i].Key != want {
					t.Errorf("session[%d].Key = %q, want %q", i, got[i].Key, want)
				}
			}
		})
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test -race ./internal/helper/ -run TestConsoleOnlySessions -v`
Expected: FAIL — `undefined: consoleOnlySessions`

- [ ] **Step 3: Write the implementation**

Create `agent/internal/helper/enumerator_filter.go` (no build tag):

```go
package helper

import "github.com/breeze-rmm/agent/internal/sessionbroker"

// consoleOnlySessions filters a detector snapshot down to the single session
// attached to the physical console. Assist helpers launched into any other
// session are rejected at broker authentication (assist role requires the
// active console session), so spawning them elsewhere is pure waste on
// multi-session hosts (RDS). consoleID is sessionbroker.GetConsoleSessionID();
// "0" is its WTS-failure / Session-0 sentinel, in which case no session is
// eligible.
func consoleOnlySessions(detected []sessionbroker.DetectedSession, consoleID string) []SessionInfo {
	if consoleID == "" || consoleID == "0" {
		return nil
	}
	for _, s := range detected {
		if s.Session != consoleID {
			continue
		}
		if s.State != "active" && s.State != "connected" {
			continue
		}
		return []SessionInfo{{Key: s.Session, Username: s.Username}}
	}
	return nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && go test -race ./internal/helper/ -run TestConsoleOnlySessions -v`
Expected: PASS

- [ ] **Step 5: Wire the Windows enumerator through the filter**

Replace the body of `ActiveSessions` in `agent/internal/helper/enumerator_windows.go` (currently lines 16-44) with:

```go
func (e *windowsEnumerator) ActiveSessions() []SessionInfo {
	if e.detector == nil {
		return nil
	}
	detected, err := e.detector.ListSessions()
	if err != nil {
		return nil
	}
	return consoleOnlySessions(detected, sessionbroker.GetConsoleSessionID())
}
```

(The old session-0/services skip, state filter, and dedup are all subsumed: the filter returns at most the one console session.)

- [ ] **Step 6: Verify full helper package + Windows compile**

Run: `cd agent && go test -race ./internal/helper/... && GOOS=windows go build ./internal/helper/`
Expected: tests PASS, cross-compile succeeds

- [ ] **Step 7: Commit**

```bash
git add agent/internal/helper/enumerator_filter.go agent/internal/helper/enumerator_filter_test.go agent/internal/helper/enumerator_windows.go
git commit -m "fix(agent): only spawn Assist helpers into the console session

Assist helpers launched into RDP sessions are rejected at broker auth
(assist role requires the active console session), so spawning one per
session on an RDS host is pure process waste.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Unconditional legacy HKLM Run cleanup

Nothing installs the `HKLM\...\CurrentVersion\Run` `BreezeHelper` value anymore (`installAutoStart` has zero call sites on any platform — it is dead code), but hosts upgraded before the per-session migration may still carry it, and Windows fires it for **every** logon — bypassing Task 1's console filter. Today it is removed only under one-time migration conditions (`migrate.go:126`, gated at `manager.go:215-228`) or on uninstall (`manager.go:348`). Sweep it once per agent process, and delete the dead installers.

**Files:**
- Modify: `agent/internal/helper/manager.go` (Apply, ~line 228; struct fields near the top of the file)
- Modify: `agent/internal/helper/install_windows.go:98-111` (delete `installAutoStart`)
- Modify: `agent/internal/helper/install_darwin.go:84` (delete `installAutoStart`)
- Modify: `agent/internal/helper/install_linux.go:75` (delete `installAutoStart`)
- Test: `agent/internal/helper/manager_test.go` (append)

**Interfaces:**
- Consumes: existing seam `removeAutoStartFunc` (package var, `migrate.go:10`).
- Produces: package var `sweepLegacyAutoStart bool` (default `runtime.GOOS == "windows"`) and manager field `legacyAutoStartCleaned bool` — test hooks only, nothing else consumes them.

- [ ] **Step 1: Write the failing test**

Append to `agent/internal/helper/manager_test.go`:

```go
func TestApplySweepsLegacyAutoStartOncePerProcess(t *testing.T) {
	tmpDir := t.TempDir()

	var removeCalls int
	origRemove := removeAutoStartFunc
	origSweep := sweepLegacyAutoStart
	origStopLegacy := stopHelperLegacyFunc
	t.Cleanup(func() {
		removeAutoStartFunc = origRemove
		sweepLegacyAutoStart = origSweep
		stopHelperLegacyFunc = origStopLegacy
	})
	removeAutoStartFunc = func() error { removeCalls++; return nil }
	stopHelperLegacyFunc = func() {}
	sweepLegacyAutoStart = true // simulate Windows on any test platform

	mgr := New(context.Background(), nil, nil, "")
	mgr.baseDir = tmpDir
	mgr.sessionEnumerator = &mockEnumerator{}

	mgr.Apply(&Settings{Enabled: false})
	mgr.Apply(&Settings{Enabled: false})

	// One sweep per process lifetime — not one per heartbeat tick. (The
	// migration/uninstall paths have their own removeAutoStartFunc calls;
	// with Enabled=false and no residual state those do not fire here.)
	if removeCalls != 1 {
		t.Fatalf("removeAutoStartFunc called %d times, want exactly 1", removeCalls)
	}
}

func TestApplySkipsLegacyAutoStartSweepOffWindows(t *testing.T) {
	tmpDir := t.TempDir()

	var removeCalls int
	origRemove := removeAutoStartFunc
	origSweep := sweepLegacyAutoStart
	origStopLegacy := stopHelperLegacyFunc
	t.Cleanup(func() {
		removeAutoStartFunc = origRemove
		sweepLegacyAutoStart = origSweep
		stopHelperLegacyFunc = origStopLegacy
	})
	removeAutoStartFunc = func() error { removeCalls++; return nil }
	stopHelperLegacyFunc = func() {}
	sweepLegacyAutoStart = false

	mgr := New(context.Background(), nil, nil, "")
	mgr.baseDir = tmpDir
	mgr.sessionEnumerator = &mockEnumerator{}

	mgr.Apply(&Settings{Enabled: false})

	if removeCalls != 0 {
		t.Fatalf("removeAutoStartFunc called %d times, want 0 when sweep disabled", removeCalls)
	}
}
```

Note: if `mockEnumerator{}` with no sessions differs from existing test usage, mirror how `TestApplyDisabledUninstalledIsStableNoOp` (`manager_test.go:232`) constructs the manager — the sweep must not depend on enumerator contents.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd agent && go test -race ./internal/helper/ -run TestApplySweepsLegacyAutoStart -v`
Expected: FAIL — `undefined: sweepLegacyAutoStart`

- [ ] **Step 3: Implement the sweep**

In `agent/internal/helper/manager.go`:

1. Add to the imports if not present: `"runtime"`.
2. Add a package var near the top of the file:

```go
// sweepLegacyAutoStart enables the one-time HKLM Run cleanup in Apply. The
// value only ever exists on Windows (legacy installs); other platforms use
// launchd/systemd artifacts handled by migrate/uninstall.
var sweepLegacyAutoStart = runtime.GOOS == "windows"
```

3. Add a field to the `Manager` struct: `legacyAutoStartCleaned bool`.
4. In `Apply`, directly after the `needsSessionMigration` block (after line 228), insert:

```go
	// Nothing installs the HKLM Run "BreezeHelper" value anymore — spawning is
	// manager-driven — but hosts upgraded before the per-session migration may
	// still carry it, and Windows fires it for EVERY logon session, bypassing
	// the console-only enumerator filter on RDS hosts. The migration-time
	// removal only runs under one-time conditions, so sweep it here once per
	// agent process. Idempotent: removeAutoStart is a no-op when absent.
	if sweepLegacyAutoStart && !m.legacyAutoStartCleaned {
		if err := removeAutoStartFunc(); err != nil {
			log.Warn("failed to remove legacy HKLM Run autostart", "error", err.Error())
		} else {
			m.legacyAutoStartCleaned = true
		}
	}
```

- [ ] **Step 4: Delete dead `installAutoStart` from all three platform files**

Remove the entire `installAutoStart` function from `install_windows.go` (lines 98-111), `install_darwin.go` (line 84 onward), and `install_linux.go` (line 75 onward). Keep `removeAutoStart` in all three. If an import becomes unused (e.g. nothing — `registry` is still used by `removeAutoStart`), run `gofmt`/build to confirm.

- [ ] **Step 5: Run tests and cross-compile all platforms**

Run: `cd agent && go test -race ./internal/helper/... && GOOS=windows go build ./internal/helper/ && GOOS=darwin go build ./internal/helper/ && GOOS=linux go build ./internal/helper/`
Expected: PASS + three clean builds

- [ ] **Step 6: Commit**

```bash
git add agent/internal/helper/manager.go agent/internal/helper/manager_test.go agent/internal/helper/install_windows.go agent/internal/helper/install_darwin.go agent/internal/helper/install_linux.go
git commit -m "fix(agent): sweep legacy HKLM Run autostart unconditionally, drop dead installAutoStart

The Run value launches Assist into every logon session (including RDP
sessions whose helpers are auth-rejected); removal previously only
happened under one-time migration conditions.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Disconnected-RDP SYSTEM-helper retention cap

`helper_key.go:37` keeps a SYSTEM helper desired for every disconnected RDP session with no age limit; on terminal servers disconnected sessions linger for days and helpers accumulate. Track when the lifecycle first sees a session disconnected and prune the SYSTEM key after 10 minutes. (`DetectedSession` carries no disconnected-since timestamp — `detector.go:29` — so a stateless predicate would re-add the key every reconcile; the state lives in the lifecycle manager.)

**Files:**
- Create: `agent/internal/sessionbroker/lifecycle_retention.go`
- Create: `agent/internal/sessionbroker/lifecycle_retention_test.go`
- Modify: `agent/internal/sessionbroker/lifecycle_core.go` (constants block ~line 12-32; `HelperLifecycleManager` struct at line 135; `newHelperLifecycleManager` at line 154; `detectedDesired` at line 179)

**Interfaces:**
- Consumes: `HelperKey{WindowsSessionID uint32, Role ipc.HelperRole}`, `DetectedSession`, `ipc.HelperRoleSystem`.
- Produces: `applyDisconnectedRetention(desired map[HelperKey]bool, sessions []DetectedSession, seen map[uint32]time.Time, now time.Time, ttl time.Duration)` — pure aside from mutating `desired` and `seen` in place. New manager fields `disconnectedSince map[uint32]time.Time` and `now func() time.Time` (test clock hook).

- [ ] **Step 1: Write the failing unit test for the pure function**

Create `agent/internal/sessionbroker/lifecycle_retention_test.go`:

```go
package sessionbroker

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestApplyDisconnectedRetention(t *testing.T) {
	base := time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)
	ttl := 10 * time.Minute
	sysKey := func(id uint32) HelperKey { return HelperKey{WindowsSessionID: id, Role: ipc.HelperRoleSystem} }
	userKey := func(id uint32) HelperKey { return HelperKey{WindowsSessionID: id, Role: ipc.HelperRoleUser} }

	rdpDisconnected := DetectedSession{Session: "3", Type: "rdp", State: "disconnected"}
	rdpActive := DetectedSession{Session: "3", Type: "rdp", State: "active"}

	t.Run("first sighting records but does not prune", func(t *testing.T) {
		desired := map[HelperKey]bool{sysKey(3): true}
		seen := map[uint32]time.Time{}
		applyDisconnectedRetention(desired, []DetectedSession{rdpDisconnected}, seen, base, ttl)
		if !desired[sysKey(3)] {
			t.Fatal("system key pruned on first sighting")
		}
		if _, ok := seen[3]; !ok {
			t.Fatal("disconnected-since not recorded")
		}
	})

	t.Run("prunes system key after ttl", func(t *testing.T) {
		desired := map[HelperKey]bool{sysKey(3): true}
		seen := map[uint32]time.Time{3: base}
		applyDisconnectedRetention(desired, []DetectedSession{rdpDisconnected}, seen, base.Add(ttl), ttl)
		if desired[sysKey(3)] {
			t.Fatal("system key not pruned after ttl")
		}
	})

	t.Run("under ttl is retained", func(t *testing.T) {
		desired := map[HelperKey]bool{sysKey(3): true}
		seen := map[uint32]time.Time{3: base}
		applyDisconnectedRetention(desired, []DetectedSession{rdpDisconnected}, seen, base.Add(ttl-time.Second), ttl)
		if !desired[sysKey(3)] {
			t.Fatal("system key pruned before ttl elapsed")
		}
	})

	t.Run("reconnect clears tracking", func(t *testing.T) {
		desired := map[HelperKey]bool{sysKey(3): true, userKey(3): true}
		seen := map[uint32]time.Time{3: base}
		applyDisconnectedRetention(desired, []DetectedSession{rdpActive}, seen, base.Add(ttl), ttl)
		if _, ok := seen[3]; ok {
			t.Fatal("tracking not cleared when session left disconnected state")
		}
		if !desired[sysKey(3)] || !desired[userKey(3)] {
			t.Fatal("active session keys must be untouched")
		}
	})

	t.Run("session gone from snapshot clears tracking", func(t *testing.T) {
		desired := map[HelperKey]bool{}
		seen := map[uint32]time.Time{3: base}
		applyDisconnectedRetention(desired, nil, seen, base.Add(ttl), ttl)
		if len(seen) != 0 {
			t.Fatalf("stale tracking entries remain: %v", seen)
		}
	})

	t.Run("console disconnected sessions are not tracked", func(t *testing.T) {
		desired := map[HelperKey]bool{sysKey(2): true}
		seen := map[uint32]time.Time{}
		applyDisconnectedRetention(desired, []DetectedSession{{Session: "2", Type: "console", State: "disconnected"}}, seen, base, ttl)
		if len(seen) != 0 {
			t.Fatal("console session must not be tracked for RDP retention")
		}
	})
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test -race ./internal/sessionbroker/ -run TestApplyDisconnectedRetention -v`
Expected: FAIL — `undefined: applyDisconnectedRetention`

- [ ] **Step 3: Implement the pure function**

Create `agent/internal/sessionbroker/lifecycle_retention.go`:

```go
package sessionbroker

import (
	"strconv"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// applyDisconnectedRetention caps how long a SYSTEM-role helper stays desired
// for a disconnected RDP session. helperRoleDesired retains those helpers
// deliberately (an RDP session keeps running when disconnected), but with no
// age limit they accumulate on terminal servers where disconnected sessions
// linger for days. seen maps Windows session ID → when this function first
// observed the session disconnected; it is mutated in place — entries are
// added on first sighting and dropped when the session leaves the
// disconnected state or the snapshot. desired is pruned in place once a
// session has been disconnected for ttl or longer.
func applyDisconnectedRetention(desired map[HelperKey]bool, sessions []DetectedSession, seen map[uint32]time.Time, now time.Time, ttl time.Duration) {
	disconnected := make(map[uint32]bool, len(seen))
	for _, s := range sessions {
		if s.Type != "rdp" || s.State != "disconnected" {
			continue
		}
		id64, err := strconv.ParseUint(s.Session, 10, 32)
		if err != nil || id64 == 0 {
			continue
		}
		id := uint32(id64)
		disconnected[id] = true
		since, ok := seen[id]
		if !ok {
			seen[id] = now
			continue
		}
		if now.Sub(since) >= ttl {
			delete(desired, HelperKey{WindowsSessionID: id, Role: ipc.HelperRoleSystem})
		}
	}
	for id := range seen {
		if !disconnected[id] {
			delete(seen, id)
		}
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && go test -race ./internal/sessionbroker/ -run TestApplyDisconnectedRetention -v`
Expected: PASS

- [ ] **Step 5: Write the failing wiring test (manager level, injected clock)**

Append to `agent/internal/sessionbroker/lifecycle_retention_test.go`:

```go
type stubRetentionDetector struct{ sessions []DetectedSession }

func (d *stubRetentionDetector) ListSessions() ([]DetectedSession, error) { return d.sessions, nil }
func (d *stubRetentionDetector) WatchSessions(ctx context.Context) <-chan SessionEvent {
	ch := make(chan SessionEvent)
	close(ch)
	return ch
}

func TestDetectedDesiredPrunesLongDisconnectedRDP(t *testing.T) {
	det := &stubRetentionDetector{sessions: []DetectedSession{
		{Session: "3", Username: "bob", Type: "rdp", State: "disconnected"},
	}}
	m := newHelperLifecycleManager(nil, det, nil, nil)

	base := time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)
	current := base
	m.now = func() time.Time { return current }

	sysKey := HelperKey{WindowsSessionID: 3, Role: ipc.HelperRoleSystem}

	desired, err := m.detectedDesired()
	if err != nil {
		t.Fatal(err)
	}
	if !desired[sysKey] {
		t.Fatal("freshly disconnected RDP session should still desire a SYSTEM helper")
	}

	current = base.Add(disconnectedHelperRetention + time.Second)
	desired, err = m.detectedDesired()
	if err != nil {
		t.Fatal(err)
	}
	if desired[sysKey] {
		t.Fatal("SYSTEM helper still desired after retention window elapsed")
	}
}
```

Add `"context"` to the test file's imports.

- [ ] **Step 6: Run test to verify it fails**

Run: `cd agent && go test -race ./internal/sessionbroker/ -run TestDetectedDesiredPrunesLongDisconnectedRDP -v`
Expected: FAIL — `m.now undefined` (and `disconnectedHelperRetention` undefined)

- [ ] **Step 7: Wire into the lifecycle manager**

In `agent/internal/sessionbroker/lifecycle_core.go`:

1. Add to the constants block (near `helperStartupTimeout`, lines 12-32):

```go
	// disconnectedHelperRetention caps how long the SYSTEM helper of a
	// disconnected RDP session stays desired. Long enough to survive brief
	// network drops and RDP reconnects; short enough that helpers don't
	// accumulate on terminal servers where disconnected sessions linger for
	// days. Phase 1's on-demand lifecycle re-spawns on target if needed.
	disconnectedHelperRetention = 10 * time.Minute
```

2. Add two fields to `HelperLifecycleManager` (struct at line 135):

```go
	disconnectedSince map[uint32]time.Time
	now               func() time.Time
```

3. Initialize both in `newHelperLifecycleManager` (line 154):

```go
		disconnectedSince: make(map[uint32]time.Time),
		now:               time.Now,
```

4. In `detectedDesired` (line 179), after the loop that fills `desired` and before `return desired, nil`:

```go
	m.mu.Lock()
	applyDisconnectedRetention(desired, sessions, m.disconnectedSince, m.now(), disconnectedHelperRetention)
	m.mu.Unlock()
```

(Safe: both `reconcile` and `Bootstrap` call `detectedDesired` *before* taking `m.mu`, never while holding it.)

- [ ] **Step 8: Run the full sessionbroker suite**

Run: `cd agent && go test -race ./internal/sessionbroker/...`
Expected: PASS (including the existing fake-backed `rds_lifecycle_integration_test.go` — its scenarios use active sessions and must be unaffected; if it constructs managers via `newHelperLifecycleManager`, the new fields are initialized there and no test change is needed)

- [ ] **Step 9: Commit**

```bash
git add agent/internal/sessionbroker/lifecycle_retention.go agent/internal/sessionbroker/lifecycle_retention_test.go agent/internal/sessionbroker/lifecycle_core.go
git commit -m "fix(agent): cap disconnected-RDP SYSTEM helper retention at 10 minutes

helperRoleDesired retained the SYSTEM helper for every disconnected RDP
session with no age limit; on terminal servers disconnected sessions
linger for days and helpers accumulate.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `run_as_user` fails fast with the real reason

When `runAs=user` resolves no helper session, `handleScript` logs a misleading "downgraded to local (SYSTEM) context" warning and falls through to the local executor (`handlers_script.go:52-72`), which then rejects the run anyway (`executor.go:354-356`). No SYSTEM execution actually happens — the failure is just late and mislabeled. Fail fast with a typed result before any executor involvement.

**Files:**
- Modify: `agent/internal/heartbeat/handlers_script.go:52-70`
- Modify: `agent/internal/heartbeat/handlers_script_test.go:219-243` (replace) + one new test

**Interfaces:**
- Consumes: `resolveRunAsSession(broker, runAs)` (`handlers_script.go:94`, unchanged), `tools.CommandResult`.
- Produces: no new symbols. Error string relied on by tests: `runAs=user requires a connected user helper session; no eligible session found (script was not executed)`.

- [ ] **Step 1: Update the pinned test and add the nil-broker case**

Replace `TestHandleScriptRunAsUserNoHelper` (`handlers_script_test.go:219-243`) with:

```go
func TestHandleScriptRunAsUserNoHelper(t *testing.T) {
	// When no user helper is connected, runAs=user must fail fast with the
	// real reason — before the local executor is involved — instead of the
	// old misleading "downgraded to SYSTEM" fallthrough (#1009 symptom).
	broker := sessionbroker.New("/tmp/test-broker-no-helper.sock", nil)
	h := newTestHeartbeat(broker)

	result := handleScript(h, Command{
		ID:   "cmd-user-noop",
		Type: tools.CmdScript,
		Payload: map[string]any{
			"content":        "echo 'fallback'",
			"language":       "bash",
			"runAs":          "user",
			"timeoutSeconds": 10,
		},
	})

	if result.Status != "failed" {
		t.Fatalf("expected failed (no helper for runAs=user), got %s", result.Status)
	}
	if !strings.Contains(result.Error, "no eligible session found") {
		t.Fatalf("expected fail-fast error naming the missing session, got: %q", result.Error)
	}
	if !strings.Contains(result.Error, "script was not executed") {
		t.Fatalf("error must state the script did not run, got: %q", result.Error)
	}
}

func TestHandleScriptRunAsUserNoBroker(t *testing.T) {
	// Same fail-fast contract when there is no session broker at all
	// (non-service mode) — previously this fell through to a late executor
	// rejection.
	h := newTestHeartbeat(nil)

	result := handleScript(h, Command{
		ID:   "cmd-user-nobroker",
		Type: tools.CmdScript,
		Payload: map[string]any{
			"content":        "echo 'x'",
			"language":       "bash",
			"runAs":          "user",
			"timeoutSeconds": 10,
		},
	})

	if result.Status != "failed" {
		t.Fatalf("expected failed, got %s", result.Status)
	}
	if !strings.Contains(result.Error, "script was not executed") {
		t.Fatalf("expected fail-fast error, got: %q", result.Error)
	}
}
```

(`strings` is already imported by the test file; if not, add it.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd agent && go test -race ./internal/heartbeat/ -run 'TestHandleScriptRunAsUser' -v`
Expected: FAIL — `TestHandleScriptRunAsUserNoHelper` fails on the `no eligible session found` substring (old path produces the executor's message), `TestHandleScriptRunAsUserNoBroker` fails likewise

- [ ] **Step 3: Implement fail-fast**

In `agent/internal/heartbeat/handlers_script.go`, replace the block at lines 52-70 (`// Phase 3: ...` through the closing brace of the WARN `if`) with:

```go
	// Phase 3: If runAs is specified and a user helper is connected, forward via IPC
	if script.RunAs != "" && h.sessionBroker != nil {
		if session := resolveRunAsSession(h.sessionBroker, script.RunAs); session != nil {
			return h.executeViaUserHelper(session, cmd, script.Timeout)
		}
	}
	if strings.EqualFold(script.RunAs, "user") {
		// No eligible user helper for a user-context run. The local executor
		// would reject this anyway (executor.configureRunAs), but only after a
		// misleading "downgraded to SYSTEM" warning; on multi-user / RDS hosts
		// the real cause is the console-session delivery binding (#1009).
		// Fail fast, before any process spawn, with the actual reason.
		return tools.CommandResult{
			Status: "failed",
			// Synthetic exit code: no process ran (see tools.CommandResult.ExitCode).
			ExitCode:   1,
			Error:      "runAs=user requires a connected user helper session; no eligible session found (script was not executed)",
			DurationMs: time.Since(start).Milliseconds(),
		}
	}
	if script.RunAs != "" && h.sessionBroker != nil &&
		!strings.EqualFold(script.RunAs, "system") && !strings.EqualFold(script.RunAs, "elevated") {
		// Explicit-username delivery didn't resolve to a helper; the local
		// executor may still honour it (sudo on unix), so this path remains a
		// fallthrough — but record it accurately.
		log.Warn("runAs username did not resolve to a helper session; attempting local executor fallback",
			"runAs", script.RunAs, "commandId", cmd.ID)
	}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd agent && go test -race ./internal/heartbeat/ -run 'TestHandleScript' -v`
Expected: PASS — including the untouched `TestHandleScriptRunAsSystemFallsThrough` (`runAs=system` still executes locally)

- [ ] **Step 5: Run the full heartbeat + executor suites**

Run: `cd agent && go test -race ./internal/heartbeat/... ./internal/executor/...`
Expected: PASS (`executor.configureRunAs` and its tests are intentionally unchanged — it remains the backstop)

- [ ] **Step 6: Commit**

```bash
git add agent/internal/heartbeat/handlers_script.go agent/internal/heartbeat/handlers_script_test.go
git commit -m "fix(agent): fail runAs=user fast with the real reason when no helper session exists

Previously the handler warned 'downgraded to SYSTEM' and fell through to
the local executor, which rejected the run anyway — a late, mislabeled
failure. No behavior change for runAs=system/elevated or explicit
usernames.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the entire agent test suite with race detection**

Run: `cd agent && go test -race ./...`
Expected: PASS

- [ ] **Step 2: Cross-compile the agent for all shipped platforms**

Run: `cd agent && GOOS=windows go build ./... && GOOS=darwin go build ./... && GOOS=linux go build ./...`
Expected: three clean builds

- [ ] **Step 3: gofmt check**

Run: `cd agent && gofmt -l ./internal/ | tee /dev/stderr | wc -l`
Expected: `0`

- [ ] **Step 4: Commit any stragglers (should be none) and push**

```bash
git status --short   # expect clean
git push -u origin ToddHebebrand/multiple-user-helpers
```
