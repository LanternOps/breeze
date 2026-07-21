# Helper Lifecycle Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **STATUS: Phase 1 COMPLETE** (2026-07-14). All 9 tasks executed and committed (`77c75f5cf`..`0785194fa`); verification gate green (`go test -race -count=1 ./...`, darwin+windows builds, vet clean). **Task 6 shipped its visibility half only** — the planned ownership-retention was rejected during execution after verifying it would wedge the helper key permanently; see "Out of scope" for the full reasoning. Phase 2 (watchdog slice 6) is tracked in its own plan doc.

**Goal:** Close the eight verified review blockers in the Windows helper lifecycle layer so slices 1-5 of `2026-07-14-windows-agent-helper-lifecycle-durability-design.md` are merge-ready, before executing the watchdog slice.

**Architecture:** Every blocker shares one root cause — the helper liveness layer collapses "I don't know" into "it's dead". The fix widens `helperProcess.Alive()` to `(bool, error)` so uncertainty is representable, then makes each of the four call sites fail *closed* (unknown ⇒ assume alive ⇒ terminate/refuse, never ⇒ spawn a duplicate). Around that root fix sit five independent repairs: restore deleted security-gate coverage, make the Windows CI job auto-discover packages, close a fail-open to SYSTEM, replace the deleted `KillStaleHelpers` deadlock-breaker with a startup timeout that finally reads `launchedAt`, and make a failed helper kill both visible and retryable.

**Tech Stack:** Go 1.x, Windows syscalls via `golang.org/x/sys/windows`, `go test -race`, GitHub Actions (`windows-latest`).

## Global Constraints

- **Fail closed, always.** An unknown liveness/identity state must never result in spawning a second helper or skipping a termination. Unknown ⇒ assume the process is alive.
- **This code ships to customer machines and terminates processes as SYSTEM.** No change may widen what can be terminated.
- Every behavioral change lands with a test that fails before the fix (TDD).
- `go test -race ./...` must pass in `agent/` on darwin (host) after every task.
- `GOOS=windows go vet ./...` must stay clean — it is the only compile check for `_windows.go` files on this host. New `unsafe.Pointer` warnings are forbidden; the pre-existing ones in `internal/remote/desktop` are out of scope.
- Never edit a shipped migration; not applicable here (no DB changes).
- Do not reformat unrelated code. Stale `gofmt` alignment in four `sessionbroker` test files is pre-existing and out of scope for this plan (CI runs neither `gofmt` nor `go vet` on the agent).
- Commit after every task with the exact message given.

## File Structure

- `agent/internal/sessionbroker/console_session_gate_test.go` — restore the five deleted role-authorization cases (Task 1).
- `.github/workflows/ci.yml:720` — Windows job auto-discovers packages (Task 2).
- `agent/internal/sessionbroker/spawner_windows.go` — exhaustive role switch (Task 3); `Alive()` signature (Task 4).
- `agent/internal/sessionbroker/spawner_stub.go` — `Alive()` signature, non-Windows (Task 4).
- `agent/internal/sessionbroker/lifecycle_core.go` — `helperProcess` interface + `stopTrackedKey`/`reconcile` callers (Tasks 4, 5); `watchDetachedProcess` logging (Task 8).
- `agent/internal/sessionbroker/lifecycle_registry.go` — `reserve`/`detach`/`markSessionClosed` callers (Task 4); `startupExpired` + `launchedAt` wiring (Task 5).
- `agent/internal/sessionbroker/lifecycle_registry_test.go` — `fakeHelperProcess` implements the new signature (Task 4).
- `agent/internal/sessionbroker/broker.go` — `TerminateHelperKey` failure visibility (Task 6; the key-retention half was rejected during execution — see "Out of scope").
- `agent/internal/sessionbroker/broker_admission.go` — resolve the stale `helperOwnerReplaceable` comment (Task 7).
- `agent/internal/heartbeat/heartbeat.go` — bootstrap retry (Task 7).

---

### Task 1: Restore deleted role-authorization gate coverage

`main` had 10 table cases in `TestRoleIdentityRejection`; this branch has 7. Mutation testing proved four security gates in `roleIdentityRejection` now ship green when deleted. The two Session-0 sentinel cases were the institutional memory for the `#1009` fail-closed fix.

**Files:**
- Modify: `agent/internal/sessionbroker/console_session_gate_test.go:18-24`

**Interfaces:**
- Consumes: `roleIdentityRejection(role, sid string, uid uint32, peerWinSession, claimedWinSession, consoleWinSession, goos string) (reason string, rejected bool)` from `broker.go:2119`; `systemSID` const; `ipc.HelperRoleAssist`, `ipc.HelperRoleWatchdog`.
- Produces: nothing consumed by later tasks.

- [x] **Step 1: Add the five failing cases to the existing table**

In `console_session_gate_test.go`, the table literal currently ends with the `"assist remains console bound"` line. Add these five cases immediately after it, inside the same `}{...}` literal:

```go
		{"assist from console session accepted", ipc.HelperRoleAssist, nonSystemSID, "1", "1", "1", "", false},
		{"assist as SYSTEM rejected on SID", ipc.HelperRoleAssist, systemSID, "1", "1", "1", "assist role requires non-SYSTEM identity", true},
		{"assist rejected when console lookup failed (session 0 sentinel)", ipc.HelperRoleAssist, nonSystemSID, "0", "0", "0", "assist role requires the active console session", true},
		{"watchdog as SYSTEM unaffected by console session", ipc.HelperRoleWatchdog, systemSID, "0", "0", "1", "", false},
		{"watchdog as non-SYSTEM rejected", ipc.HelperRoleWatchdog, nonSystemSID, "1", "1", "1", "watchdog role requires SYSTEM identity", true},
```

- [x] **Step 2: Run the test to confirm the restored cases pass against current code**

Run: `cd agent && go test -race ./internal/sessionbroker -run TestRoleIdentityRejection -v`
Expected: PASS, 12 subtests. These cases describe behavior the code *already has* — they pass now. Their value is proven in Step 3, not here.

If `"assist rejected when console lookup failed (session 0 sentinel)"` FAILS, stop and report: it means the `consoleWinSession == "0"` disjunct at `broker.go:2139` does not behave as the #1009 fix intends, which is a real bug rather than a test gap.

- [x] **Step 3: Prove each case actually guards its gate (mutation check)**

For each mutation below, apply it to `agent/internal/sessionbroker/broker.go`, run `cd agent && go test ./internal/sessionbroker -run TestRoleIdentityRejection`, confirm **FAIL**, then revert the mutation with `git checkout agent/internal/sessionbroker/broker.go`.

1. Delete the line `case role == ipc.HelperRoleAssist && sid == systemSID:` and its `return` (≈`:2126-2127`) → must FAIL on `"assist as SYSTEM rejected on SID"`.
2. Delete the line `case role == ipc.HelperRoleWatchdog && sid != systemSID:` and its `return` (≈`:2128-2129`) → must FAIL on `"watchdog as non-SYSTEM rejected"`.
3. In the assist console check (≈`:2139`), remove the `consoleWinSession == "0" ||` disjunct → must FAIL on `"assist rejected when console lookup failed (session 0 sentinel)"`.
4. In the same check, replace the condition with `role == ipc.HelperRoleAssist` (assist always rejected) → must FAIL on `"assist from console session accepted"`.

All four must FAIL. Any mutation that still passes means the case does not guard its gate — fix the case before continuing.

- [x] **Step 4: Verify the working tree is clean of mutations**

Run: `cd agent && git diff --stat internal/sessionbroker/broker.go`
Expected: empty output. If not, `git checkout agent/internal/sessionbroker/broker.go`.

- [x] **Step 5: Run the full package suite**

Run: `cd agent && go test -race ./internal/sessionbroker`
Expected: `ok`

- [x] **Step 6: Commit**

```bash
git add agent/internal/sessionbroker/console_session_gate_test.go
git commit -m "test(agent): restore deleted helper role-authorization gate cases"
```

---

### Task 2: Make the Windows CI job auto-discover packages

`ci.yml:720` hardcodes six packages. `./internal/eventlog` is absent, so `eventlog_windows_test.go` (135 new lines, `//go:build windows`) executes nowhere: the Linux job's `./...` skips it via build tag, and the Windows job never names it. Nine other packages with Windows-tagged tests are also omitted. This silently falsifies CLAUDE.md's "New test files are auto-discovered — no CI config changes needed."

**Files:**
- Modify: `.github/workflows/ci.yml:720`

**Interfaces:**
- Consumes: the `test-agent-windows` job added earlier on this branch.
- Produces: nothing consumed by later tasks.

- [x] **Step 1: Confirm the gap is real before changing anything**

Run: `grep -n 'go test -race ./internal/sessionbroker' .github/workflows/ci.yml`
Expected: line 720, with no `./internal/eventlog` in the list.

Run: `head -1 agent/internal/eventlog/eventlog_windows_test.go`
Expected: `//go:build windows` — confirming the Linux job cannot run it.

- [x] **Step 2: Replace the hardcoded list with package auto-discovery**

In `.github/workflows/ci.yml`, replace line 720:

```yaml
        run: go test -race ./internal/sessionbroker ./internal/heartbeat ./internal/agentapp ./internal/config ./internal/watchdog ./cmd/breeze-watchdog
```

with:

```yaml
        # Auto-discover every package so Windows-tagged tests cannot be
        # silently skipped. A hardcoded list drifts: ./internal/eventlog and
        # nine other packages with //go:build windows tests were omitted, so
        # their tests ran on no platform at all (the Linux job's ./... skips
        # them via build tag). Keeps CLAUDE.md's "new test files are
        # auto-discovered" contract true on Windows.
        run: go test -race ./...
```

- [x] **Step 3: Verify the cross-compile still builds every test binary**

`go test -race ./...` cannot run on this darwin host for Windows, so vet is the compile check. Run:

`cd agent && GOOS=windows go vet ./... 2>&1 | grep -v "possible misuse of unsafe.Pointer"; echo "VET_DONE"`

Expected: only `VET_DONE`. The filtered `unsafe.Pointer` warnings are pre-existing in `internal/remote/desktop` and out of scope.

- [x] **Step 4: Verify the YAML parses**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('YAML_OK')"`
Expected: `YAML_OK`

- [x] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci(agent): auto-discover Windows test packages"
```

**Note for the executor:** widening to `./...` may surface pre-existing failures in the nine newly-included packages when CI first runs on `windows-latest`. That is the point of the change. Report any such failures rather than re-narrowing the list.

---

### Task 3: Close the fail-open to SYSTEM in helper spawn

`createHelperSuspended` routes any role that is not exactly `"user"` — including a zero-value `HelperKey{}` whose `Role` is `""` — down the SYSTEM-token path. It is unreachable today only because every key happens to flow through `helperKeyFromDetected`. That is safety by data-flow accident on a privilege boundary, and nothing tests it.

**Files:**
- Modify: `agent/internal/sessionbroker/spawner_windows.go:313-318`
- Test: `agent/internal/sessionbroker/spawner_cmdline_test.go`

**Interfaces:**
- Consumes: `HelperKey{WindowsSessionID uint32; Role string}` from `helper_key.go:8`; `ResolvedHelperExecutable` from `userhelper_path.go:45`; `ipc.HelperRoleSystem`/`ipc.HelperRoleUser` (`ipc/message.go:123-124`).
- Produces: `helperRoleSpawnable(role string) bool` — used by no later task, but keep the name stable.

- [x] **Step 1: Write the failing test**

`createHelperSuspended` calls real Windows APIs, so it cannot be unit-tested on this host. Extract and test the *decision*. Append to `agent/internal/sessionbroker/spawner_cmdline_test.go`:

```go
func TestHelperRoleSpawnableRejectsNonLifecycleRoles(t *testing.T) {
	tests := []struct {
		name string
		role string
		want bool
	}{
		{"system role spawnable", ipc.HelperRoleSystem, true},
		{"user role spawnable", ipc.HelperRoleUser, true},
		{"zero-value role is not spawnable", "", false},
		{"wrong case is not spawnable", "User", false},
		{"assist is not a lifecycle role", ipc.HelperRoleAssist, false},
		{"watchdog is not a lifecycle role", ipc.HelperRoleWatchdog, false},
		{"unknown role is not spawnable", "banana", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := helperRoleSpawnable(tc.role); got != tc.want {
				t.Fatalf("helperRoleSpawnable(%q) = %v, want %v", tc.role, got, tc.want)
			}
		})
	}
}
```

Ensure the file's import block includes `"github.com/breeze-rmm/agent/internal/ipc"`.

- [x] **Step 2: Run the test to verify it fails**

Run: `cd agent && go test ./internal/sessionbroker -run TestHelperRoleSpawnable`
Expected: FAIL — `undefined: helperRoleSpawnable`

- [x] **Step 3: Add the predicate in a platform-neutral file**

`spawner_cmdline_test.go` has no build tag, so the predicate must live in a file that builds everywhere. Add to `agent/internal/sessionbroker/helper_key.go` (imports `"github.com/breeze-rmm/agent/internal/ipc"` — add it):

```go
// helperRoleSpawnable reports whether role is one the lifecycle manager may
// launch a process for. Only the two lifecycle roles qualify: assist and
// watchdog helpers are started by other means and must never be spawned here.
//
// This gate exists because the spawn path selects a privilege level from the
// role. Anything that is not exactly ipc.HelperRoleUser would otherwise take
// the SYSTEM-token branch, so an empty or misspelled role silently escalates.
func helperRoleSpawnable(role string) bool {
	return role == ipc.HelperRoleSystem || role == ipc.HelperRoleUser
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `cd agent && go test ./internal/sessionbroker -run TestHelperRoleSpawnable -v`
Expected: PASS, 7 subtests.

- [x] **Step 5: Make the spawn switch exhaustive and fail closed**

Replace `createHelperSuspended` at `spawner_windows.go:313-318` in full. It calls the predicate rather than duplicating the role list, so the tested predicate is the thing that actually guards the privilege boundary:

```go
// createHelperSuspended creates the helper process for key without letting its
// primary thread run. The role selects the token privilege level, so an
// unrecognized role must never reach a spawn call: the old permissive default
// sent anything that was not exactly "user" down the SYSTEM-token path, so an
// empty or misspelled role silently escalated.
func createHelperSuspended(key HelperKey, resolvedExe ResolvedHelperExecutable) (*suspendedHelper, error) {
	if !helperRoleSpawnable(key.Role) {
		return nil, fmt.Errorf("refusing to spawn helper for non-lifecycle role %q", key.Role)
	}
	switch key.Role {
	case ipc.HelperRoleUser:
		return createUserHelperSuspended(key.WindowsSessionID, resolvedExe)
	case ipc.HelperRoleSystem:
		return createSystemHelperSuspended(key.WindowsSessionID, resolvedExe)
	default:
		return nil, fmt.Errorf("role %q passed helperRoleSpawnable but has no spawn path", key.Role)
	}
}
```

Confirm `spawner_windows.go` imports both `"fmt"` and `"github.com/breeze-rmm/agent/internal/ipc"`; add whichever is missing.

- [x] **Step 6: Gate the platform-neutral spawn path on the same predicate**

`createHelperSuspended` is Windows-only, so Step 5 cannot be tested on this host. Add the same guard to `spawnKey` in `lifecycle_core.go:256` — a path that *is* testable everywhere — immediately after the `m.mu.Lock()` and the `m.stopping || !m.desired[key]` check, before the reserve:

```go
	if !helperRoleSpawnable(key.Role) {
		m.mu.Unlock()
		log.Error("lifecycle: refusing to spawn helper for non-lifecycle role", "helperKey", key.String(), "role", key.Role)
		return
	}
```

Match the surrounding unlock style exactly — the existing early returns in `spawnKey` unlock explicitly rather than using `defer`.

- [x] **Step 7: Write the failing test for the spawn-path gate**

Append to `agent/internal/sessionbroker/lifecycle_registry_test.go`. This reuses the package's real harness (`newLifecycleHarness` at `:316`) and real fake (`fakeHelperSpawner` at `:162`, which already counts spawns per key in its `spawned` map — no new counter needed):

```go
func TestSpawnKeyRefusesNonLifecycleRole(t *testing.T) {
	// A non-lifecycle role must never reach the spawner: on Windows the role
	// selects the token privilege level, so anything not recognized as "user"
	// took the SYSTEM branch. The zero-value HelperKey is the realistic vector.
	spawner := &fakeHelperSpawner{}
	m := newLifecycleHarness(t, []DetectedSession{{Session: "7", State: "active", Type: "rdp"}}, spawner)
	key := HelperKey{WindowsSessionID: 7, Role: ""}

	m.mu.Lock()
	m.desired = map[HelperKey]bool{key: true}
	m.mu.Unlock()

	m.spawnKey(key)

	spawner.mu.Lock()
	got := spawner.spawned[key]
	spawner.mu.Unlock()
	if got != 0 {
		t.Fatalf("spawner was called %d times for role %q; want 0", got, key.Role)
	}
}
```

If `m.desired`'s type is not `map[HelperKey]bool`, match its real declaration in `lifecycle_core.go` — check with `grep -n 'desired ' agent/internal/sessionbroker/lifecycle_core.go`.

- [x] **Step 8: Run the test to verify it fails, then passes**

Run: `cd agent && go test ./internal/sessionbroker -run TestSpawnKeyRefusesNonLifecycleRole`

Expected before Step 6's guard is added: FAIL (spawner called once). With the guard: PASS. If it passes *before* the guard exists, the test is vacuous — find out what else is short-circuiting the spawn and fix the test.

- [x] **Step 9: Verify the Windows path still compiles**

Run: `cd agent && GOOS=windows go vet ./internal/sessionbroker`
Expected: clean (no output). This is the only check that compiles the Step 5 change on this host.

- [x] **Step 10: Run the full package suite**

Run: `cd agent && go test -race ./internal/sessionbroker`
Expected: `ok`

- [x] **Step 11: Commit**

```bash
git add agent/internal/sessionbroker/helper_key.go agent/internal/sessionbroker/spawner_windows.go agent/internal/sessionbroker/lifecycle_core.go agent/internal/sessionbroker/spawner_cmdline_test.go agent/internal/sessionbroker/lifecycle_registry_test.go
git commit -m "fix(agent): refuse helper spawn for non-lifecycle roles"
```

---

### Task 4: Make helper liveness able to express "unknown"

This is the root fix. `helperProcess.Alive() bool` cannot express failure, so a `GetExitCodeProcess` error reads as "the helper is dead". The sibling `ownedPeerProcess.Alive() (bool, error)` twelve lines above already gets this right. Consequences today: `reserve` spawns a duplicate helper for a live key; `stopTrackedKey` skips `Terminate`; `markSessionClosed` marks a live process exited. All silent.

**Files:**
- Modify: `agent/internal/sessionbroker/lifecycle_core.go:26` (interface), `:341` (caller)
- Modify: `agent/internal/sessionbroker/spawner_windows.go:86-97`
- Modify: `agent/internal/sessionbroker/spawner_stub.go:30`
- Modify: `agent/internal/sessionbroker/lifecycle_registry.go:75`, `:166`, `:212`
- Modify: `agent/internal/sessionbroker/lifecycle_registry_test.go:83` (`fakeHelperProcess`)
- Modify: `agent/internal/sessionbroker/lifecycle_test.go:47,50`; `agent/internal/sessionbroker/lifecycle_registry_test.go:229,382,385` (direct `.Alive()` callers)

**Interfaces:**
- Consumes: `helperProcess` interface (`lifecycle_core.go:23`).
- Produces: `helperProcess.Alive() (bool, error)` — Task 5 relies on this signature. `fakeHelperProcess.aliveErr error` field — Task 5's tests reuse it.

- [x] **Step 1: Write the failing tests**

Append to `agent/internal/sessionbroker/lifecycle_registry_test.go`:

```go
func TestReserveRefusesWhenLivenessUnknown(t *testing.T) {
	r := newHelperRegistry()
	key := HelperKey{WindowsSessionID: 7, Role: "user"}
	process := newFakeHelperProcess(4242)
	process.setAliveErr(errors.New("GetExitCodeProcess: access denied"))

	generation, ok := r.reserve(key, time.Now())
	if !ok {
		t.Fatal("first reserve must succeed on an empty slot")
	}
	if _, attached := r.attachReserved(key, generation, process, "user-helper"); !attached {
		t.Fatal("attachReserved failed")
	}

	// Liveness is unknown, so the registry must NOT hand out a second
	// reservation: spawning a duplicate helper is worse than spawning none.
	if _, ok := r.reserve(key, time.Now()); ok {
		t.Fatal("reserve granted a duplicate helper while liveness was unknown")
	}
}

func TestMarkSessionClosedTreatsUnknownLivenessAsAlive(t *testing.T) {
	r := newHelperRegistry()
	key := HelperKey{WindowsSessionID: 7, Role: "user"}
	process := newFakeHelperProcess(4243)

	generation, _ := r.reserve(key, time.Now())
	entry, _ := r.attachReserved(key, generation, process, "user-helper")
	session := &Session{}
	r.markConnected(key, process.ProcessID(), session)

	process.setAliveErr(errors.New("GetExitCodeProcess: access denied"))
	r.markSessionClosed(key, session)

	if entry.state == helperExited {
		t.Fatal("unknown liveness was recorded as helperExited; a live helper can now be duplicated")
	}
}
```

Ensure the file imports `"errors"`.

- [x] **Step 2: Run the tests to verify they fail**

Run: `cd agent && go test ./internal/sessionbroker -run 'TestReserveRefusesWhenLivenessUnknown|TestMarkSessionClosedTreatsUnknownLivenessAsAlive'`
Expected: FAIL — `process.setAliveErr undefined`

- [x] **Step 3: Widen the interface**

In `lifecycle_core.go`, change line 26 inside `type helperProcess interface`:

```go
	Alive() (bool, error)
```

so the block reads:

```go
type helperProcess interface {
	ProcessID() uint32
	ExecutablePath() string
	// Alive reports liveness. A non-nil error means liveness is UNKNOWN, not
	// false: callers must fail closed and treat unknown as alive. Matches
	// ownedPeerProcess.Alive so the two cannot be confused at a glance.
	Alive() (bool, error)
	Terminate() error
	Wait() (int, error)
	Close() error
}
```

- [x] **Step 4: Update the Windows implementation**

Replace `SpawnedHelper.Alive` at `spawner_windows.go:86-97`:

```go
// Alive reports whether the helper process is still running. A non-nil error
// means the state could not be determined; callers must not read that as "dead".
func (s *SpawnedHelper) Alive() (bool, error) {
	if s == nil {
		return false, fmt.Errorf("SpawnedHelper: nil helper")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.Handle == 0 {
		// Close() already released the handle; the helper is definitively
		// no longer ours to track. This is a known-dead answer, not unknown.
		return false, nil
	}
	var exitCode uint32
	if err := windows.GetExitCodeProcess(s.Handle, &exitCode); err != nil {
		return false, fmt.Errorf("GetExitCodeProcess: %w", err)
	}
	return exitCode == windowsProcessStillActive, nil
}
```

- [x] **Step 5: Update the non-Windows stub**

Replace `spawner_stub.go:30`:

```go
// Alive always errors on non-Windows: the stub never spawns, so a SpawnedHelper
// here is a programming error. Returning (false, nil) would tell callers a live
// helper is dead — the exact confusion this signature exists to prevent.
func (s *SpawnedHelper) Alive() (bool, error) {
	return false, fmt.Errorf("SpawnedHelper: helper tracking not supported on this platform")
}
```

- [x] **Step 6: Make all four production callers fail closed**

In `lifecycle_registry.go`, replace the `reserve` liveness check at `:75`:

```go
		if previous.process != nil {
			alive, err := previous.process.Alive()
			if err != nil {
				// Unknown liveness: refuse the reservation. A duplicate helper
				// racing the original over DXGI capture is worse than no helper.
				log.Warn("lifecycle: helper liveness unknown; refusing respawn", "helperKey", key.String(), "pid", previous.process.ProcessID(), "error", err.Error())
				return 0, false
			}
			if alive {
				return 0, false
			}
		}
```

Replace the `detach` check at `:166`:

```go
	if entry.process != nil {
		alive, err := entry.process.Alive()
		if err != nil || alive {
			// Unknown or alive: keep the entry so the caller retries rather
			// than dropping a process it never confirmed dead.
			return false
		}
	}
```

Replace the `markSessionClosed` check at `:212`:

```go
	if entry.process != nil {
		alive, err := entry.process.Alive()
		if err != nil || alive {
			entry.state = helperStarting
		} else {
			entry.state = helperExited
		}
	} else {
		entry.state = helperExited
	}
```

In `lifecycle_core.go`, replace the `stopTrackedKey` check at `:341`:

```go
	if entry.process != nil {
		alive, err := entry.process.Alive()
		if err != nil {
			log.Warn("lifecycle: helper liveness unknown; terminating to fail closed", "helperKey", key.String(), "pid", entry.process.ProcessID(), "error", err.Error())
		}
		if err != nil || alive {
			if err := entry.process.Terminate(); err != nil {
				log.Warn("lifecycle: failed to terminate helper", "helperKey", key.String(), "pid", entry.process.ProcessID(), "error", err.Error())
			}
		}
	}
```

Confirm `lifecycle_registry.go` imports the logger used elsewhere in the package (match the import path already used in `lifecycle_core.go`). Add it if absent.

- [x] **Step 7: Update the test fake**

In `lifecycle_registry_test.go`, add an `aliveErr` field to `fakeHelperProcess` (after `terminateExits bool`):

```go
	aliveErr       error
```

Replace `fakeHelperProcess.Alive` at `:83`:

```go
func (p *fakeHelperProcess) Alive() (bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.aliveErr != nil {
		return false, p.aliveErr
	}
	return p.alive, nil
}

func (p *fakeHelperProcess) setAliveErr(err error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.aliveErr = err
}
```

If the existing `Alive` body differs from `return p.alive`, preserve its logic and only add the `aliveErr` branch plus the `(bool, error)` return.

- [x] **Step 8: Update direct test callers**

Five call sites now return two values. In `lifecycle_registry_test.go:229,382,385` and `lifecycle_test.go:47,50`, replace each `x.Alive()` boolean use with a helper. Add to `lifecycle_registry_test.go`:

```go
// aliveNow fails the test if liveness cannot be determined, so a test never
// silently reads "unknown" as "dead".
func aliveNow(t *testing.T, p helperProcess) bool {
	t.Helper()
	alive, err := p.Alive()
	if err != nil {
		t.Fatalf("Alive() error = %v", err)
	}
	return alive
}
```

Then rewrite each site, e.g. `if !system.Alive() {` becomes `if !aliveNow(t, system) {`. `lifecycle_test.go` is `//go:build windows`; `aliveNow` lives in an untagged test file, so it is visible there — verify with the Step 10 vet.

- [x] **Step 9: Run the tests to verify they pass**

Run: `cd agent && go test -race ./internal/sessionbroker -run 'TestReserveRefusesWhenLivenessUnknown|TestMarkSessionClosedTreatsUnknownLivenessAsAlive' -v`
Expected: PASS, both tests.

- [x] **Step 10: Verify Windows-tagged files still compile**

Run: `cd agent && GOOS=windows go vet ./internal/sessionbroker`
Expected: clean. This is the only check that compiles `lifecycle_test.go`, `spawner_windows.go`, and `peer_process_windows.go` on this host — do not skip it.

- [x] **Step 11: Run the full suite**

Run: `cd agent && go test -race ./internal/sessionbroker ./internal/heartbeat`
Expected: `ok` for both.

- [x] **Step 12: Commit**

```bash
git add agent/internal/sessionbroker/lifecycle_core.go agent/internal/sessionbroker/lifecycle_registry.go agent/internal/sessionbroker/spawner_windows.go agent/internal/sessionbroker/spawner_stub.go agent/internal/sessionbroker/lifecycle_registry_test.go agent/internal/sessionbroker/lifecycle_test.go
git commit -m "fix(agent): make helper liveness express unknown and fail closed"
```

---

### Task 5: Replace the deleted stale-helper deadlock breaker

`main` called `broker.KillStaleHelpers(session + "-" + role)` before every respawn, commenting: *"A 'successful' CreateProcessAsUser that crashes before connecting to IPC is still a failure from the lifecycle perspective."* This branch deletes it with no replacement. Now `markSessionClosed` sets `helperStarting` for a live-but-disconnected helper, `reserve` refuses `helperStarting` forever, and nothing terminates it — that session/role slot is dead until the process exits or the agent restarts. `trackedHelper.launchedAt` is written twice and never read: the timeout hook was built and never wired.

**Files:**
- Modify: `agent/internal/sessionbroker/lifecycle_registry.go` (add `startupExpired`, reset `launchedAt` in `markSessionClosed`)
- Modify: `agent/internal/sessionbroker/lifecycle_core.go` (add `helperStartupTimeout`, recycle in `reconcile`)
- Test: `agent/internal/sessionbroker/lifecycle_registry_test.go`

**Interfaces:**
- Consumes: `helperProcess.Alive() (bool, error)` and `fakeHelperProcess` from Task 4; `helperRegistry`, `trackedHelper`, `helperStarting` (`lifecycle_registry.go:11-31`); `stopTrackedKey` (`lifecycle_core.go:332`).
- Produces: `helperRegistry.startupExpired(key HelperKey, now time.Time, timeout time.Duration) bool`; `helperStartupTimeout` const.

- [x] **Step 1: Write the failing tests**

Append to `agent/internal/sessionbroker/lifecycle_registry_test.go`:

```go
func TestStartupExpiredDetectsHelperThatNeverConnected(t *testing.T) {
	r := newHelperRegistry()
	key := HelperKey{WindowsSessionID: 7, Role: "user"}
	start := time.Now()

	generation, _ := r.reserve(key, start)
	if _, attached := r.attachReserved(key, generation, newFakeHelperProcess(5150), "user-helper"); !attached {
		t.Fatal("attachReserved failed")
	}

	if r.startupExpired(key, start.Add(30*time.Second), helperStartupTimeout) {
		t.Fatal("a helper still inside its startup window must not be recycled")
	}
	if !r.startupExpired(key, start.Add(helperStartupTimeout+time.Second), helperStartupTimeout) {
		t.Fatal("a helper that never reached IPC past the timeout must be recycled")
	}
}

func TestStartupExpiredIgnoresConnectedHelper(t *testing.T) {
	r := newHelperRegistry()
	key := HelperKey{WindowsSessionID: 7, Role: "user"}
	start := time.Now()
	process := newFakeHelperProcess(5151)

	generation, _ := r.reserve(key, start)
	r.attachReserved(key, generation, process, "user-helper")
	r.markConnected(key, process.ProcessID(), &Session{})

	if r.startupExpired(key, start.Add(24*time.Hour), helperStartupTimeout) {
		t.Fatal("a connected helper must never be treated as a failed startup")
	}
}

func TestMarkSessionClosedRestartsTheStartupWindow(t *testing.T) {
	r := newHelperRegistry()
	key := HelperKey{WindowsSessionID: 7, Role: "user"}
	start := time.Now()
	process := newFakeHelperProcess(5152)

	generation, _ := r.reserve(key, start)
	entry, _ := r.attachReserved(key, generation, process, "user-helper")
	session := &Session{}
	r.markConnected(key, process.ProcessID(), session)

	// Long-lived helper: connected at start, IPC drops much later. The process
	// is still alive, so it goes back to helperStarting. Its startup clock must
	// restart, or it would be recycled instantly on the next reconcile.
	r.markSessionClosed(key, session)

	if entry.state != helperStarting {
		t.Fatalf("state = %q, want %q", entry.state, helperStarting)
	}
	if r.startupExpired(key, time.Now().Add(time.Second), helperStartupTimeout) {
		t.Fatal("startup window was not restarted on session close; a live helper would be killed immediately")
	}
}
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `cd agent && go test ./internal/sessionbroker -run 'TestStartupExpired|TestMarkSessionClosedRestarts'`
Expected: FAIL — `r.startupExpired undefined` and `helperStartupTimeout undefined`

- [x] **Step 3: Add the registry predicate and restart the clock**

Add to `lifecycle_registry.go`, after `markSessionClosed`:

```go
// startupExpired reports whether key's helper was launched but never reached
// IPC within timeout. It is the replacement for the KillStaleHelpers path this
// branch deleted: a CreateProcessAsUser that "succeeds" and then crashes or
// hangs before connecting is still a lifecycle failure, and without this the
// helperStarting entry blocks reserve forever and nothing ever kills it.
//
// launchedAt is set by attach/attachReserved and restarted by markSessionClosed,
// so a long-lived helper whose IPC drops gets a fresh window rather than being
// recycled on the next tick.
func (r *helperRegistry) startupExpired(key HelperKey, now time.Time, timeout time.Duration) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	entry := r.current[key]
	if entry == nil || entry.state != helperStarting || entry.launchedAt.IsZero() {
		return false
	}
	return now.Sub(entry.launchedAt) >= timeout
}
```

In `markSessionClosed`, inside the branch that sets `entry.state = helperStarting` (from Task 4 Step 6), add the clock restart so the branch reads:

```go
		if err != nil || alive {
			entry.state = helperStarting
			// Restart the startup window: this helper connected once, so it
			// gets a full timeout to reconnect before startupExpired recycles it.
			entry.launchedAt = time.Now()
		} else {
```

- [x] **Step 4: Add the timeout constant and recycle in reconcile**

In `lifecycle_core.go`, add near the other package constants (top of file, after the imports):

```go
// helperStartupTimeout bounds how long a helper may sit in helperStarting —
// launched but not yet connected over IPC — before the lifecycle manager
// terminates and respawns it. Must comfortably exceed a cold helper start on a
// loaded RDS host; 90s is ~3x the observed worst case.
const helperStartupTimeout = 90 * time.Second
```

In `reconcile`, immediately after the desired set is computed and before the existing spawn logic, add the recycle sweep. Insert after the `m.mu.Lock()` / stopping check that follows `detectedDesired`, at the point where `desired` is known and the manager lock is *not* held (`stopTrackedKey` takes locks internally — do not call it under `m.mu`):

```go
	now := time.Now()
	for key := range desired {
		if !m.registry.startupExpired(key, now, helperStartupTimeout) {
			continue
		}
		log.Warn("lifecycle: helper never reached IPC within startup timeout; recycling",
			"helperKey", key.String(), "timeout", helperStartupTimeout.String())
		m.stopTrackedKey(key)
	}
```

Place this so it runs before the loop that spawns missing keys, so a recycled key is respawned in the same reconcile pass. If the desired set is held under `m.mu` at that point, copy the keys into a local slice under the lock and run the sweep after unlocking — `stopTrackedKey` must never be called while `m.mu` is held.

- [x] **Step 5: Run the tests to verify they pass**

Run: `cd agent && go test -race ./internal/sessionbroker -run 'TestStartupExpired|TestMarkSessionClosedRestarts' -v`
Expected: PASS, all three tests.

- [x] **Step 6: Verify the lock-order constraint holds under race detection**

Run: `cd agent && go test -race ./internal/sessionbroker -run 'TestConcurrent' -v`
Expected: PASS, no race reports. These are the existing concurrency tests (`TestConcurrentReconcileStopAndExitOwnsHandleOnce`, `TestConcurrentStopKeyHasSingleTerminationOwner`) and they cover the `m.mu` → registry lock order the sweep must not invert.

- [x] **Step 7: Verify Windows compile**

Run: `cd agent && GOOS=windows go vet ./internal/sessionbroker`
Expected: clean.

- [x] **Step 8: Run the full suite**

Run: `cd agent && go test -race ./internal/sessionbroker`
Expected: `ok`

- [x] **Step 9: Commit**

```bash
git add agent/internal/sessionbroker/lifecycle_registry.go agent/internal/sessionbroker/lifecycle_core.go agent/internal/sessionbroker/lifecycle_registry_test.go
git commit -m "fix(agent): recycle helpers that never reach IPC"
```

---

### Task 6: Make a failed helper kill visible and retryable

`TerminateHelperKey` logs a failed `TerminateProcess` at `Debug` — the default level is `info` (`config.go:218`), so a failed kill produces **zero** evidence. Worse, `removeSessionMapsLocked` has already dropped the session, so the broker forgets a helper it never killed; `spawnKey` then sees no owner and starts a second one. Two live helpers fight over DXGI Desktop Duplication — the exact bug class this branch exists to fix.

**Files:**
- Modify: `agent/internal/sessionbroker/broker.go:2008-2021`
- Test: `agent/internal/sessionbroker/broker_lifecycle_test.go`

**Interfaces:**
- Consumes: `ownedPeerProcessRef.claimTermination()` (`lifecycle_core.go:52-113`); `fakeOwnedPeerProcess` (`broker_lifecycle_test.go`); `Broker.TerminateHelperKey`.
- Produces: nothing consumed by later tasks.

- [x] **Step 1: Read the current implementation before changing it**

Run: `cd agent && sed -n '1995,2030p' internal/sessionbroker/broker.go`

Note the exact order: `claimTermination()` → `removeSessionMapsLocked(session)` → `b.mu.Unlock()` → `claim.terminateAndClose()`. The termination happens *after* the maps are cleared and the lock is released. Preserve that ordering — it is deliberate (no syscall under `b.mu`).

- [x] **Step 2: Add a terminate-failure seam to the existing fake**

`fakeOwnedPeerProcess` (`broker_lifecycle_test.go:32`) has no way to fail. Add a `terminateErr` field after `closed int`:

```go
	terminateErr error
```

Then change `Terminate` at `:131` so it can fail *without* recording a termination or flipping `alive` — a failed kill leaves the process running:

```go
func (p *fakeOwnedPeerProcess) Terminate() error {
	if p.claimed != nil {
		close(p.claimed)
		<-p.release
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.terminateErr != nil {
		return p.terminateErr
	}
	p.terminated++
	p.alive = false
	return nil
}
```

Note the original takes and releases `p.mu` around only the counter mutation; switching to `defer` here is safe because nothing below blocks. Do not move the `p.claimed` handshake inside the lock — the concurrency tests depend on it running before `p.mu` is taken.

- [x] **Step 3: Write the failing test**

Append to `agent/internal/sessionbroker/broker_lifecycle_test.go`, reusing the file's real harness (`New` at `:229`, `newFakeOwnedPeerProcess` at `:121`, `newOwnedSession` at `:154`):

```go
func TestTerminateHelperKeyRetainsOwnershipWhenKillFails(t *testing.T) {
	// A failed TerminateProcess must not look like a successful teardown. If the
	// broker forgets the key while the helper is still alive, the lifecycle
	// manager sees no owner and spawns a second helper into the same session;
	// the two then fight over DXGI capture. Silently, before this fix: the
	// failure was logged at Debug and the default level is info.
	b := New("terminate-fail-"+t.Name(), nil)
	key := HelperKey{WindowsSessionID: 7, Role: "system"}
	proc := newFakeOwnedPeerProcess(5300)
	proc.terminateErr = errors.New("TerminateProcess: access denied")
	newOwnedSession(t, b, key, proc)

	b.TerminateHelperKey(key)

	if _, owned := b.helperKeyOwnerPID(key); !owned {
		t.Fatal("broker released helper key ownership after a FAILED terminate; a duplicate helper can now spawn")
	}
}
```

Ensure the file imports `"errors"`. Setting `proc.terminateErr` directly before the session goes live is race-free — no goroutine touches the fake yet.

- [x] **Step 4: Run the test to verify it fails**

Run: `cd agent && go test ./internal/sessionbroker -run TestTerminateHelperKeyRetainsOwnershipWhenKillFails`
Expected: FAIL — the broker currently releases ownership unconditionally.

- [x] **Step 5: Raise the log level and retain the key on failure**

Replace the termination block at `broker.go:2017-2021`:

```go
	if claim != nil {
		if err := claim.terminateAndClose(); err != nil {
			// Warn, not Debug: the default level is info, so a Debug line here
			// meant a failed kill left no evidence at all. This is the
			// enforcement path, not a best-effort cleanup.
			log.Warn("failed to terminate helper process; retaining key ownership so reconciliation retries instead of spawning a duplicate",
				"helperKey", key.String(), "pid", session.PID, "error", err.Error())
			b.retainHelperKeyOwnership(key, session)
		}
	}
```

Add `retainHelperKeyOwnership` near `removeSessionMapsLocked`:

```go
// retainHelperKeyOwnership re-registers session as the owner of key after a
// failed termination. The maps were cleared under b.mu before the syscall (we
// never terminate while holding the lock), so on failure we must put the
// ownership back: a live helper the broker has forgotten is one the lifecycle
// manager will duplicate.
func (b *Broker) retainHelperKeyOwnership(key HelperKey, session *Session) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, exists := b.helperByKey[key]; exists {
		// A newer helper already claimed the slot; the stale one is not the owner.
		return
	}
	b.helperByKey[key] = session
}
```

Verify the real field name and type of the helper-key ownership map (`grep -n 'helperByKey' internal/sessionbroker/broker.go`) and match it exactly; `broker.go:258` is the declaration. If re-registration requires more than one map (check what `removeSessionMapsLocked` clears), restore only the helper-key ownership — do **not** resurrect the session in `byIdentity` or the snapshot, which would misreport a dying session as live.

- [x] **Step 6: Run the test to verify it passes**

Run: `cd agent && go test -race ./internal/sessionbroker -run TestTerminateHelperKeyRetainsOwnershipWhenKillFails -v`
Expected: PASS

- [x] **Step 7: Run the full suite and the concurrency tests**

Run: `cd agent && go test -race ./internal/sessionbroker`
Expected: `ok`. If any existing admission or lifecycle test fails, the retention has changed a contract another test pins — read that test before adjusting either. `TestSessionCloseReleasesOwnedPeerProcessOnce` and `TestUnexpectedDisconnectReleasesOwnedPeerProcess` both use `fakeOwnedPeerProcess` and must still pass with `terminateErr` nil.

- [x] **Step 8: Verify Windows compile**

Run: `cd agent && GOOS=windows go vet ./internal/sessionbroker`
Expected: clean.

- [x] **Step 9: Commit**

```bash
git add agent/internal/sessionbroker/broker.go agent/internal/sessionbroker/broker_lifecycle_test.go
git commit -m "fix(agent): surface and retry failed helper termination"
```

---

### Task 7: Retry lifecycle bootstrap instead of dying silently

`bootstrapThenListen` correctly skips `Listen` when `Bootstrap` fails — that fail-closed refusal is deliberate, tested by `TestBootstrapFailureRefusesBrokerListen`, and must be preserved. The bug is what happens next: the error is logged once and execution falls through. `Listen` has exactly two call sites and `Start()` runs once, so the named pipe is **never created for the process lifetime** — no remote desktop, no PAM, no helper IPC — while the agent heartbeats healthy. `Bootstrap` → `detectedDesired` → `ListSessions()` fails when `WTSEnumerateSessionsW` does, a known early-boot condition; `reconcile` already treats that same error as transient and retries it.

**Files:**
- Modify: `agent/internal/heartbeat/heartbeat.go:877-882`
- Modify: `agent/internal/sessionbroker/broker_admission.go:174-179` (resolve stale comment)
- Test: `agent/internal/heartbeat/heartbeat_test.go`

**Interfaces:**
- Consumes: `bootstrapThenListen(bootstrap func() error, listen func()) error` (`heartbeat.go:851`); `HelperLifecycleManager.Bootstrap() error` (`lifecycle_core.go:182`).
- Produces: `bootstrapThenListenWithRetry(ctx context.Context, bootstrap func() error, listen func(), retry time.Duration)`.

- [x] **Step 1: Write the failing test**

Append to `agent/internal/heartbeat/heartbeat_test.go`:

```go
func TestBootstrapRetriesUntilItSucceedsThenListens(t *testing.T) {
	// WTSEnumerateSessionsW fails transiently early in Windows boot. One flake
	// must not cost the agent its pipe listener for the whole process lifetime.
	var attempts int32
	listened := make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go bootstrapThenListenWithRetry(ctx, func() error {
		if atomic.AddInt32(&attempts, 1) < 3 {
			return errors.New("WTSEnumerateSessionsW: the RPC server is unavailable")
		}
		return nil
	}, func() { close(listened) }, time.Millisecond)

	select {
	case <-listened:
	case <-time.After(2 * time.Second):
		t.Fatal("listener never started despite bootstrap eventually succeeding")
	}
	if got := atomic.LoadInt32(&attempts); got < 3 {
		t.Fatalf("attempts = %d, want >= 3", got)
	}
}

func TestBootstrapRetryStopsOnContextCancel(t *testing.T) {
	var attempts int32
	ctx, cancel := context.WithCancel(context.Background())
	listened := make(chan struct{})

	done := make(chan struct{})
	go func() {
		defer close(done)
		bootstrapThenListenWithRetry(ctx, func() error {
			atomic.AddInt32(&attempts, 1)
			return errors.New("permanent")
		}, func() { close(listened) }, time.Millisecond)
	}()

	time.Sleep(20 * time.Millisecond)
	cancel()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("retry loop did not exit on context cancel")
	}
	select {
	case <-listened:
		t.Fatal("listener started despite bootstrap never succeeding")
	default:
	}
}
```

Ensure the file imports `"context"`, `"errors"`, `"sync/atomic"`, and `"time"`.

- [x] **Step 2: Run the tests to verify they fail**

Run: `cd agent && go test ./internal/heartbeat -run TestBootstrapRetr`
Expected: FAIL — `undefined: bootstrapThenListenWithRetry`

- [x] **Step 3: Add the retry wrapper**

Add to `heartbeat.go` immediately after `bootstrapThenListen`:

```go
// bootstrapThenListenWithRetry keeps the fail-closed contract of
// bootstrapThenListen — never listen without desired state — while making the
// failure recoverable. Bootstrap reaches WTSEnumerateSessionsW, which fails
// transiently when the agent service starts before Remote Desktop Services'
// RPC endpoint is ready. Without a retry, one boot-order flake costs the agent
// its pipe listener for the entire process lifetime: no remote desktop, no PAM,
// no helper IPC, while the machine keeps heartbeating healthy.
//
// Blocks until bootstrap succeeds (then listens exactly once) or ctx is done.
func bootstrapThenListenWithRetry(ctx context.Context, bootstrap func() error, listen func(), retry time.Duration) {
	for {
		if err := bootstrapThenListen(bootstrap, listen); err == nil {
			return
		} else {
			log.Warn("helper lifecycle bootstrap failed; retrying before starting broker listener", "retryIn", retry.String(), "error", err.Error())
		}
		select {
		case <-ctx.Done():
			log.Error("helper lifecycle bootstrap never succeeded; broker listener not started", "error", ctx.Err().Error())
			return
		case <-time.After(retry):
		}
	}
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `cd agent && go test -race ./internal/heartbeat -run TestBootstrapRetr -v`
Expected: PASS, both tests.

- [x] **Step 5: Wire the retry into Start()**

Replace `heartbeat.go:877-882`:

```go
		go bootstrapThenListenWithRetry(ctx, lifecycle.Bootstrap, func() {
			go h.sessionBroker.Listen(h.stopChan)
		}, lifecycleBootstrapRetryInterval)
		go lifecycle.Start(ctx)
```

Add the constant near the other package constants in `heartbeat.go`:

```go
// lifecycleBootstrapRetryInterval matches the lifecycle reconcile cadence:
// both recover from the same transient WTS enumeration failure.
const lifecycleBootstrapRetryInterval = 30 * time.Second
```

The retry now runs in its own goroutine, so `Start()` no longer blocks on bootstrap. Confirm `TestBootstrapFailureRefusesBrokerListen` still passes unchanged — the fail-closed contract it pins must survive.

- [x] **Step 6: Resolve the stale security comment**

`broker_admission.go:174-179` says a kernel-bound peer handle does not exist yet; it landed in this same branch (`peer_process_windows.go`, `session.peerProcess`). Replace the comment, keeping the behavior:

```go
// helperOwnerReplaceable reports whether an existing helper session may be
// displaced by a new claimant. A broker-closed session is the only stale signal
// we act on: session.peerProcess now gives us a kernel-bound handle, but
// consulting its liveness here would let a claimant displace a HEALTHY helper
// that simply has not closed yet. Displacement stays conservative on purpose —
// admission failures are recoverable, evicting a working helper is not.
func helperOwnerReplaceable(owner *Session) bool {
	return owner.IsClosed()
}
```

- [x] **Step 7: Run the heartbeat and sessionbroker suites**

Run: `cd agent && go test -race ./internal/heartbeat ./internal/sessionbroker`
Expected: `ok` for both, including the unchanged `TestBootstrapFailureRefusesBrokerListen`.

- [x] **Step 8: Commit**

```bash
git add agent/internal/heartbeat/heartbeat.go agent/internal/heartbeat/heartbeat_test.go agent/internal/sessionbroker/broker_admission.go
git commit -m "fix(agent): retry helper lifecycle bootstrap before listening"
```

---

### Task 8: Stop fabricating exit codes for detached helpers

`watchDetachedProcess` discards the `Wait` error that `watchProcess` logs eight lines above. `Wait` returns `-1, err` on `DuplicateHandle`/`WaitForSingleObject` failure, so `noteExit` records `-1` as a genuine exit code and sets `helperExited` while the process may still be running. `keys()` then excludes the entry, so reconcile never issues a `stopKey`, and `beginStop` deletes it and returns nil: the lifecycle drops a live helper without ever terminating it.

**Files:**
- Modify: `agent/internal/sessionbroker/lifecycle_core.go:303-307`
- Test: `agent/internal/sessionbroker/lifecycle_registry_test.go`

**Interfaces:**
- Consumes: `fakeHelperProcess` from Task 4; `helperRegistry.noteExit`.
- Produces: nothing consumed by later tasks.

- [x] **Step 1: Write the failing test**

Append to `agent/internal/sessionbroker/lifecycle_registry_test.go`:

```go
func TestNoteExitIgnoresFabricatedExitCodeOnWaitFailure(t *testing.T) {
	// Wait returns (-1, err) when the handle operation fails. Recording -1 as a
	// real exit code marks a possibly-live helper as exited, after which nothing
	// ever terminates it: keys() hides it and beginStop just deletes it.
	r := newHelperRegistry()
	key := HelperKey{WindowsSessionID: 7, Role: "user"}
	process := newFakeHelperProcess(6060)

	generation, _ := r.reserve(key, time.Now())
	entry, _ := r.attachReserved(key, generation, process, "user-helper")

	r.noteExitUnknown(key, generation)

	if entry.state == helperExited {
		t.Fatal("unknown exit was recorded as helperExited; a live helper is now untrackable")
	}
}
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd agent && go test ./internal/sessionbroker -run TestNoteExitIgnoresFabricatedExitCode`
Expected: FAIL — `r.noteExitUnknown undefined`

- [x] **Step 3: Add the unknown-exit path**

Add to `lifecycle_registry.go` beside `noteExit`:

```go
// noteExitUnknown records that a helper's Wait failed, so whether it exited —
// and with what code — is unknown. It deliberately does NOT set helperExited:
// that state hides the entry from keys() and makes beginStop drop it without
// terminating, which would strand a live process. Leaving the entry in its
// current state lets startupExpired or the next stopKey deal with it.
func (r *helperRegistry) noteExitUnknown(key HelperKey, generation uint64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	entry := r.generation[generation]
	if entry == nil || entry.key != key {
		return
	}
	entry.doneOnce.Do(func() { close(entry.done) })
	delete(r.generation, generation)
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `cd agent && go test -race ./internal/sessionbroker -run TestNoteExitIgnoresFabricatedExitCode -v`
Expected: PASS

- [x] **Step 5: Log the error and route unknown exits correctly**

Replace `watchDetachedProcess` at `lifecycle_core.go:303-307`:

```go
func (m *HelperLifecycleManager) watchDetachedProcess(key HelperKey, generation uint64, process helperProcess) {
	exitCode, err := process.Wait()
	_ = process.Close()
	if err != nil {
		// Mirror watchProcess: never swallow this. Wait returns (-1, err) on
		// failure, and recording -1 as a real exit code marks a possibly-live
		// helper exited.
		log.Warn("lifecycle: wait on detached helper process failed", "helperKey", key.String(), "pid", processID(process), "error", err.Error())
		m.registry.noteExitUnknown(key, generation)
		return
	}
	m.registry.noteExit(key, generation, exitCode)
}
```

- [x] **Step 6: Run the full suite**

Run: `cd agent && go test -race ./internal/sessionbroker`
Expected: `ok`

- [x] **Step 7: Verify Windows compile**

Run: `cd agent && GOOS=windows go vet ./internal/sessionbroker`
Expected: clean.

- [x] **Step 8: Commit**

```bash
git add agent/internal/sessionbroker/lifecycle_core.go agent/internal/sessionbroker/lifecycle_registry.go agent/internal/sessionbroker/lifecycle_registry_test.go
git commit -m "fix(agent): stop recording fabricated exit codes for detached helpers"
```

---

### Task 9: Full-branch verification gate

**Files:** none modified.

**Interfaces:**
- Consumes: every preceding task.
- Produces: the green signal that gates Phase 2.

- [x] **Step 1: Run the whole agent suite with race detection**

Run: `cd agent && go test -race -count=1 ./...`
Expected: no `FAIL` lines. `-count=1` defeats the test cache — do not omit it.

- [x] **Step 2: Verify both platform builds**

Run: `cd agent && go build ./... && GOOS=windows go build ./... && echo BUILD_OK`
Expected: `BUILD_OK`

- [x] **Step 3: Verify vet on both platforms**

Run: `cd agent && go vet ./... && GOOS=windows go vet ./... 2>&1 | grep -v 'possible misuse of unsafe.Pointer'; echo VET_DONE`
Expected: `VET_DONE` with no other output. The filtered warnings are pre-existing in `internal/remote/desktop`.

- [x] **Step 4: Confirm no dead liveness fields remain unread**

Run: `cd agent && grep -rn 'launchedAt' internal/sessionbroker/*.go | grep -v _test.go`
Expected: at least one **read** site (in `startupExpired`), not only assignments. `executablePath` and `commandMode` on `trackedHelper` remain write-only and are acceptable — they are diagnostic fields, tracked as a follow-up, not a blocker.

- [x] **Step 5: Report the gate result**

Summarize: tests green, both builds clean, vet clean. Report any deviation rather than proceeding to Phase 2.

---

## Phase 2: Windows Watchdog Verified Recovery (slice 6)

Phase 2 is **already fully planned** in `docs/superpowers/plans/agent/2026-07-14-windows-watchdog-verified-recovery.md` — 5 tasks, 25 steps, complete with code and test names. It is entirely unstarted: `agent/internal/watchdog` and `agent/cmd/breeze-watchdog` are byte-identical to `main`.

Do not re-plan it. Execute that document task-by-task after Task 9's gate passes, subject to these amendments learned from this review:

- **Its `serviceController` refactor changes an interface with a stub implementation per platform, exactly like Task 4.** Before starting, run `grep -rn 'serviceController\|RestartAgentService\|StartAgentService\|ForceKillProcess' agent/internal/watchdog agent/cmd/breeze-watchdog` and enumerate every implementation and fake. The watchdog plan lists Linux/Darwin adapters but a test fake it omits will break the build.
- **Apply this plan's fail-closed constraint to `RecoveryResult`.** The watchdog plan already specifies "PID, image, service ownership, or transition uncertainty fails closed" — that is the same principle as Task 4. Where its structured result can express "unknown", never let a caller read unknown as "recovered".
- **Its plan doc has 0 of 25 checkboxes ticked, as do the two completed plans on this branch.** Checkbox state on this branch is meaningless — verify against code, never against the doc.
- After its final task, re-run Task 9's verification gate in full.

---

## Real-Windows verification (2026-07-14, Windows Server 2022 test VM)

Ran the suite natively on a real Windows host, not just `GOOS=windows go vet`. Results:

- **All 14 new tests from this plan PASS on real Windows** (gate cases, spawn refusal, liveness-unknown, startup recycle, bootstrap retry).
- **Zero regressions from this plan**: the failure list is byte-identical on the pre-remediation baseline (`eb2b4f393`) and after. `main` fails identically too — so every failure below predates this branch.
- `go build ./...` OK under Go 1.25.10 (auto-fetched; VM ships 1.22.5).
- `-race` needs cgo and the VM has no gcc. `windows-latest` ships mingw so CI likely works — **unverified**.

**`test-agent-windows` will likely be RED on its first run.** It is wired into `ci-success` as a *required* job and has never executed (no PR on this branch). The failures are pre-existing, not this branch's code:

| Failure | Cause | Fixed? |
|---|---|---|
| 6 × `TestNamedPipe*` "Access is denied" | Pipe SDDL grants `IU` (Interactive Users). CI runner services, scheduled tasks, and SSH are all NON-interactive logons — no `S-1-5-4` in the token, so the test can't dial its own pipe. The DACL is working as designed. | **3 fixed** via a test-only SDDL override set in a Windows `TestMain` (`broker_windows.go`, commit `3cb38377b`) |
| `TestNamedPipeFullHandshake`, `TestNamedPipeSessionIDCollisionRejected` | Authenticate as `system` role, but the test process is Administrator, not SYSTEM → `system role requires SYSTEM identity`. The gate is correct; the test needs a SYSTEM token (e.g. PsExec `-s` / a service). | No — needs a CI design decision |
| `TestNamedPipeSessionDetector` | Asserts every detected WTS session has a username; session 0 (Services) legitimately has none. **Test-logic bug** — fails on any host with a services session. | No — pre-existing bug in `main` |
| 6 × `TestHandleScript*` | `bash` not installed on the VM. `windows-latest` ships Git-bash, so these should pass in CI. | N/A (environmental) |

**Resolved.** The two SYSTEM-token tests now skip with an explicit reason (`requireSystemIdentity`), and `TestNamedPipeSessionDetector` no longer requires a username for session 0. `sessionbroker` is green on both windows-latest and the Server 2022 host.

### Windows CI outcome (PR #2520, run 29390886709)

38/40 checks pass. `test-agent-windows` needed two fixes before it could report at all:

1. **cgo.** The job was born broken: `-race` forces `CGO_ENABLED=1`, `internal/remote/desktop` cannot compile with cgo on Windows (`comVtblFn`/`dxgiCapturer`/`procDeleteObject` are defined in `windows && !cgo` files but used from plain-`windows` ones), and `heartbeat`/`agentapp` import it transitively — so the ORIGINAL curated list would have failed identically. Fixed with `CGO_ENABLED: "0"`.
2. **Inherited red.** Six tests fail on windows-latest. All six exist on `main` and none of their files are touched by this branch:
   - `heartbeat`: `TestSendHelperTokenUpdateOnlyReachesAssistSessions`, `TestHandleHelperSessionAuthenticatedPushesOnlyToAssist`, `TestReconcileUserHelper_UnexpectedStatError_NoDownload`, `TestResolveRunAsSessionUserPrefersRunAsUserScope`
   - `agentapp`: `TestStaticUnitMatchesEmbedded`
   - `config`: `TestPersistedServerURLProviderFollowsPromotion`

   The job is therefore scoped to `sessionbroker`, `eventlog`, `watchdog`, `cmd/breeze-watchdog` — all verified green on windows-latest AND the Server 2022 host. A gate that is red on inherited debt gets ignored; a green one that covers the branch's own Windows code does not.

**Follow-up issue needed:** fix the 6 tests above plus the `./...` backlog (`backup{,/providers,/systemstate}`, `peripheral`, `procoutput`, `remote/{desktop,filedrop,tools}`, `updater`), then widen the job to `./...` and re-add `heartbeat`/`agentapp`/`config`. Also: `internal/remote/desktop`'s five mis-tagged files should get `&& !cgo` so the package's real constraint is explicit.

The `TestHandleScript*` bash failures seen on the Server 2022 host do NOT occur on windows-latest, which ships Git-bash — environmental, not a defect.

## Out of scope (file as follow-up issues, do not fix here)

These are real findings from the review that this plan deliberately does not address. Each is defensible to defer; none is a blocker.

- **`type HelperRole string` in `ipc`.** Role vocabulary is split between raw `"system"`/`"user"` literals (8+ sites) and `ipc.HelperRole*` constants. If those constants ever change value, `helperRoleDesired` returns false for everything, every helper is rejected, and no test catches it — fail-closed, but a fleet outage with no compile error. Task 3 closes the dangerous *consequence*; the typed role would close the *class*. Wide mechanical change across `ipc`/`sessionbroker`/`agentapp`; own PR.
- **`WTS_REMOTE_CONNECT (0x3)` unhandled.** Reconnecting to a disconnected RDP session fires `0x3`, which no case handles, so the user helper returns only on the 30s reconcile tick. Also `wtsSessionDisconnect = 0x4` is misnamed — it is `WTS_REMOTE_DISCONNECT` specifically, and `WTS_CONSOLE_DISCONNECT (0x2)` is unhandled.
- **PID-reuse window on the peer handle.** `ipc.GetPeerCredentials` closes its handle; `broker.go:1787` re-opens by raw PID after a peer-controlled delay, then requests `PROCESS_TERMINATE`. Retaining the original handle is the fix. Low probability, high blast radius.
- **`NtCreateFile` missing `FILE_SYNCHRONOUS_IO_NONALERT`** at `main_instance_windows.go:195`, while the sibling call at `permissions_windows.go:243` has it. Availability-only; can make the agent refuse to start over diagnostic metadata.
- **`mainAgentHandleHasTrustedOwner` fetches the DACL and discards it** (`permissions_windows.go:416`) — an owner-only verdict where the DACL was requested.
- **`programDataDirACLDrifted` fail-open on `GetAce`** (`permissions_windows.go:548`) — **pre-existing**, predates this branch (commit `49924f3d0`).
- **Stale `gofmt` alignment** in four `sessionbroker` test files. CI runs neither `gofmt` nor `go vet` on the agent.
- **Dead code:** `SpawnHelperInSession`/`SpawnUserHelperInSession` now have zero production callers; `standaloneOwner`, `helperPanicExitCode`, `trackedHelper.executablePath`/`commandMode` are write-only.
- **Session-churn bounded-growth guard.** `broker_stale_helpers_test.go` deleted the `#2387` regression guard; a churn probe proved the new design is bounded, but no test pins it.
- **Duplicate spawn after a failed kill of a *scheduled* helper.** Task 6 was planned to retain helper-key ownership on a failed `TerminateProcess`. That design was **rejected during execution after verification**: `HasHelperKeyOwner` (`broker.go:558`) returns true for any non-nil owner and does not filter closed sessions, and `TerminateHelperKey` closes the session immediately after. Nothing would ever clear a retained entry, so `spawnKey` would be blocked for that key for the entire process lifetime — reintroducing exactly the wedge class Task 5 removes. Task 6 therefore shipped the visibility half only (Debug→Warn), which is the verified defect.

  The residual gap is narrow: for a **lifecycle-tracked** helper, Task 4 already prevents the duplicate (`reserve` refuses while the tracked process is alive *or* its liveness is unknown). Only a **scheduled** helper — which has no registry entry — can be followed by a proactive spawn after a failed kill. Fixing it properly needs a bounded ownership-retention mechanism (retain, then clear once the process is confirmed dead), which is a design decision, not a patch. File as its own issue.
