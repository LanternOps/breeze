# RDS Helper Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Windows helpers scale safely across RDS sessions while enforcing one owned process per Windows-session/role pair and preserving cross-user isolation.

**Architecture:** Introduce a shared `HelperKey`, make pre-auth admission session-aware, atomically enforce one authenticated helper per key, and replace retry-only tracking with an injected process registry. Proactively spawned helpers are created suspended, assigned to a kill-on-close Job Object, and only then resumed.

**Tech Stack:** Go, `golang.org/x/sys/windows`, `github.com/Microsoft/go-winio`, Windows SCM/WTS APIs, Go race detector.

## Global Constraints

- Operating-system-derived SID, PID, Windows session, process handle, and executable path are authoritative; helper claims are never authoritative by themselves.
- Generic Windows `runAs=user` remains physical-console-bound to preserve the #1009 cross-user interception defense.
- Explicit-user and explicit-Windows-session operations may use matching RDP user helpers.
- SYSTEM helper desired state is active or connected; user helper desired state is active only; Session 0 and service sessions are never eligible.
- Unix identity keys and helper authorization behavior must remain unchanged.
- Never kill by filename or an unverified PID.
- Every implementation task follows red-green-refactor and ends in a focused commit.
- Design source: `docs/superpowers/specs/agent/2026-07-14-windows-agent-helper-lifecycle-durability-design.md`.
- This document is the RDS/helper phase of that design. Companion plans cover the main-agent guard/diagnostics and verified watchdog recovery.

## File Structure

- Create `agent/internal/sessionbroker/helper_key.go`: shared key, parsing, and desired-state predicate.
- Create `agent/internal/sessionbroker/helper_key_test.go`: host-neutral key and eligibility tests.
- Create `agent/internal/sessionbroker/broker_admission.go`: pure admission/logical-key helpers and atomic registration support.
- Create `agent/internal/sessionbroker/broker_admission_test.go`: session-aware quota and concurrent logical dedup tests.
- Modify `agent/internal/sessionbroker/broker.go`: early Windows session derivation, composite identity, logical-key map, role validation, and map cleanup.
- Modify `agent/internal/sessionbroker/console_session_gate_test.go`: RDP user-role authorization cases while retaining assist/console tests.
- Create `agent/internal/sessionbroker/lifecycle_registry.go`: host-neutral tracked-process state machine and bounded cleanup.
- Create `agent/internal/sessionbroker/lifecycle_registry_test.go`: fake process/spawner lifecycle tests.
- Create `agent/internal/sessionbroker/peer_process_windows.go`: kernel-bound handle for every authenticated Windows helper.
- Create `agent/internal/sessionbroker/peer_process_other.go`: no-op cross-platform peer ownership.
- Create `agent/internal/sessionbroker/peer_process_windows_test.go`: native handle lifetime/termination tests.
- Modify `agent/internal/sessionbroker/lifecycle.go`: dependency injection, `HelperKey` use, event cleanup, and process-aware reconciliation.
- Modify `agent/internal/heartbeat/heartbeat.go`: retain and synchronously stop the lifecycle manager after the broker stops accepting.
- Modify `agent/internal/heartbeat/heartbeat_test.go`: shutdown-order regression coverage.
- Modify `agent/internal/sessionbroker/spawner_windows.go`: process interface methods and suspended creation wiring.
- Create `agent/internal/sessionbroker/helper_job_windows.go`: Job Object wrapper.
- Create `agent/internal/sessionbroker/helper_job_windows_test.go`: native Windows ownership tests.
- Modify `agent/internal/sessionbroker/spawner_stub.go`: keep cross-platform compile parity.
- Modify `.github/workflows/ci.yml`: run Windows Go unit tests that cannot execute on Ubuntu.

---

### Task 1: Shared helper key and eligibility contract

**Files:**
- Create: `agent/internal/sessionbroker/helper_key.go`
- Create: `agent/internal/sessionbroker/helper_key_test.go`
- Modify: `agent/internal/sessionbroker/lifecycle.go:138-187`

**Interfaces:**
- Produces: `HelperKey{WindowsSessionID uint32, Role string}`.
- Produces: `helperKeyFromDetected(DetectedSession, string) (HelperKey, bool)`.
- Produces: `helperRoleDesired(DetectedSession, string) bool`.
- Consumed by: broker registration, lifecycle registry, SCM cleanup, and targeted broker close operations.

- [ ] **Step 1: Write failing table tests for key parsing and desired state**

```go
package sessionbroker

import "testing"

func TestHelperRoleDesired(t *testing.T) {
	tests := []struct {
		name string
		s    DetectedSession
		role string
		want bool
	}{
		{"system active", DetectedSession{Session: "7", State: "active", Type: "rdp"}, "system", true},
		{"system connected", DetectedSession{Session: "7", State: "connected", Type: "rdp"}, "system", true},
		{"user active", DetectedSession{Session: "7", State: "active", Type: "rdp"}, "user", true},
		{"user connected", DetectedSession{Session: "7", State: "connected", Type: "rdp"}, "user", false},
		{"session zero", DetectedSession{Session: "0", State: "active", Type: "rdp"}, "system", false},
		{"services", DetectedSession{Session: "8", State: "active", Type: "services"}, "system", false},
		{"disconnected", DetectedSession{Session: "8", State: "disconnected", Type: "rdp"}, "system", false},
		{"unknown role", DetectedSession{Session: "8", State: "active", Type: "rdp"}, "assist", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := helperRoleDesired(tt.s, tt.role); got != tt.want {
				t.Fatalf("helperRoleDesired() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestHelperKeyFromDetectedRejectsInvalidSession(t *testing.T) {
	if _, ok := helperKeyFromDetected(DetectedSession{Session: "not-a-number", State: "active", Type: "rdp"}, "user"); ok {
		t.Fatal("invalid Windows session unexpectedly produced a key")
	}
}
```

- [ ] **Step 2: Run the tests and verify the missing-symbol failure**

Run: `cd agent && go test -race ./internal/sessionbroker -run 'TestHelper(RoleDesired|KeyFromDetected)' -count=1`

Expected: FAIL because `helperRoleDesired` and `helperKeyFromDetected` do not exist.

- [ ] **Step 3: Add the shared key and predicate**

```go
package sessionbroker

import (
	"fmt"
	"strconv"
)

type HelperKey struct {
	WindowsSessionID uint32
	Role             string
}

func (k HelperKey) String() string {
	return fmt.Sprintf("%d-%s", k.WindowsSessionID, k.Role)
}

func helperRoleDesired(s DetectedSession, role string) bool {
	if s.Session == "0" || s.Type == "services" {
		return false
	}
	switch role {
	case "system":
		return s.State == "active" || s.State == "connected"
	case "user":
		return s.State == "active"
	default:
		return false
	}
}

func helperKeyFromDetected(s DetectedSession, role string) (HelperKey, bool) {
	if !helperRoleDesired(s, role) {
		return HelperKey{}, false
	}
	id, err := strconv.ParseUint(s.Session, 10, 32)
	if err != nil || id == 0 {
		return HelperKey{}, false
	}
	return HelperKey{WindowsSessionID: uint32(id), Role: role}, true
}
```

Replace the duplicated desired-state checks in `reconcile` with calls to `helperKeyFromDetected` so admission and lifecycle cannot drift.

- [ ] **Step 4: Run focused tests and the existing lifecycle tests**

Run: `cd agent && go test -race ./internal/sessionbroker -run 'TestHelper|TestSpawnWithRetry|TestHandleSCMEvent' -count=1`

Expected: PASS.

- [ ] **Step 5: Commit the shared contract**

```bash
git add agent/internal/sessionbroker/helper_key.go agent/internal/sessionbroker/helper_key_test.go agent/internal/sessionbroker/lifecycle.go
git commit -m "refactor(agent): share Windows helper eligibility rules"
```

---

### Task 2: Session-aware admission and atomic one-per-key registration

**Files:**
- Create: `agent/internal/sessionbroker/broker_admission.go`
- Create: `agent/internal/sessionbroker/broker_admission_test.go`
- Modify: `agent/internal/sessionbroker/broker.go:247-289,1264-1613,1662-1702`
- Modify: `agent/internal/sessionbroker/broker_windows.go:36-42`
- Modify: `agent/internal/sessionbroker/lifecycle.go:138-187`

**Interfaces:**
- Consumes: `HelperKey` from Task 1.
- Produces: `admissionIdentityKey(base string, peerSession uint32, goos string) string`.
- Produces: `AuthenticatedHelperKey{PeerSID string; HelperKey}` plus one-per-role `Broker.helperByKey` enforcement.
- Produces: `Broker.UpdateDesiredHelperKeys(map[HelperKey]struct{})` for the detector-backed eligibility snapshot.
- Produces: `reserveWindowsHelper`, `commitWindowsHelper`, and `releaseWindowsHelper`; no session is published before the accepted response is sent and its HMAC key is installed.

- [ ] **Step 1: Write failing pure and concurrent registration tests**

```go
package sessionbroker

import (
	"errors"
	"sync"
	"testing"
)

func TestAdmissionIdentityKeyWindowsIncludesSession(t *testing.T) {
	a := admissionIdentityKey("S-1-5-18", 7, "windows")
	b := admissionIdentityKey("S-1-5-18", 8, "windows")
	if a == b {
		t.Fatalf("distinct RDS sessions shared key %q", a)
	}
	if got := admissionIdentityKey("1000", 7, "linux"); got != "1000" {
		t.Fatalf("Unix key changed: %q", got)
	}
}

func TestReserveWindowsHelperAllowsOnlyOnePerHelperKey(t *testing.T) {
	b := New("test", nil)
	b.goos = "windows"
	key := HelperKey{WindowsSessionID: 7, Role: "system"}
	b.UpdateDesiredHelperKeys(map[HelperKey]struct{}{key: {}})

	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := b.reserveWindowsHelper("windows:S-1-5-18:session:7", "S-1-5-18", key)
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)

	duplicates := 0
	for err := range errs {
		if errors.Is(err, errDuplicateHelperKey) {
			duplicates++
		}
	}
	if duplicates != 1 || len(b.helperReservations) != 1 || len(b.sessions) != 0 {
		t.Fatalf("duplicates=%d reservations=%d sessions=%d", duplicates, len(b.helperReservations), len(b.sessions))
	}
}

func TestReserveWindowsHelperRejectsUndesiredWindowsKey(t *testing.T) {
	b := New("test", nil)
	b.goos = "windows"
	_, err := b.reserveWindowsHelper("windows:S-1-5-18:session:7", "S-1-5-18", HelperKey{WindowsSessionID: 7, Role: "system"})
	if !errors.Is(err, errHelperKeyNotDesired) {
		t.Fatalf("err=%v, want errHelperKeyNotDesired", err)
	}
}
```

Also add:

- `TestReservationIsInvisibleUntilCommit`: `Sessions()` and `HasHelperForWinSessionRole` remain empty after reserve, then expose exactly one session after `SetSessionKey` and commit.
- `TestReleaseReservationAfterAcceptedWriteFailure`: release removes both logical and identity quota reservations without evicting an existing session.
- `TestTwentySystemSIDsAcrossWindowsSessionsHaveIndependentAdmission`: the same LocalSystem SID in sessions 1-20 receives twenty distinct identity buckets, while six reservations in one bucket hit the existing five-connection limit.
- `TestUnixAndNonLifecycleRolesBypassWindowsLogicalReservation`: Unix, assist, watchdog, and backup paths retain the current registration behavior.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd agent && go test -race ./internal/sessionbroker -run 'TestAdmissionIdentityKey|TestReserveWindowsHelper|TestReservation|TestTwentySystem|TestUnixAndNonLifecycle' -count=1`

Expected: FAIL because the reservation types, composite identity, and logical-key maps do not exist.

- [ ] **Step 3: Add the session-aware identity and typed duplicate error**

```go
package sessionbroker

import (
	"errors"
	"fmt"
)

type AuthenticatedHelperKey struct {
	PeerSID string
	HelperKey
}

type helperAuthReservation struct {
	id          uint64
	authKey     AuthenticatedHelperKey
	identityKey string
	victim      *Session
}

var (
	errDuplicateHelperKey = errors.New("helper already registered for Windows session and role")
	errHelperKeyNotDesired = errors.New("helper Windows session and role are not currently eligible")
)

func admissionIdentityKey(base string, peerSession uint32, goos string) string {
	if goos != "windows" {
		return base
	}
	return fmt.Sprintf("windows:%s:session:%d", base, peerSession)
}

func isWindowsLifecycleRole(goos, role string) bool {
	return goos == "windows" && (role == ipc.HelperRoleSystem || role == ipc.HelperRoleUser)
}
```

Under `b.mu`, `reserveWindowsHelper` must (1) require the copied desired-key snapshot, (2) reject a live `helperByKey` owner even when its SID differs, (3) allow replacement only when `Session.IsClosed()` or its kernel-bound peer handle proves it exited, (4) reserve both the `AuthenticatedHelperKey` and identity quota without publishing a session, and (5) remember any idle quota victim without removing it. `commitWindowsHelper` validates the reservation, desired snapshot, and victim staleness/idle threshold again; if any changed, it releases and fails without eviction. Otherwise it removes the reserved victim, inserts into `sessions`, `byIdentity`, `helperByAuthKey`, and `helperByKey`, then publishes once. `releaseWindowsHelper` only removes pending reservation/quota state. Victim `Close` and observer callbacks run after unlocking.

Initialize all maps and the monotonically increasing reservation ID in `New`. `UpdateDesiredHelperKeys` copies the caller's map and invalidates reservations whose role key is no longer desired. Delete logical map entries only when their stored session pointer equals the session being removed.

In the existing Windows `reconcile`, compute the complete desired map first and call `UpdateDesiredHelperKeys` before checking broker connections or spawning. This makes the admission change deployable in the same commit; there is no intermediate build where every Windows helper is permanently rejected because eligibility was never published.

- [ ] **Step 4: Move peer-session derivation before admission and make registration authoritative**

In `handleConnection`, immediately after kernel credentials:

```go
verifiedWinSessionID := peerWinSessionID(creds.PID)
identityKey := admissionIdentityKey(creds.IdentityKey(), verifiedWinSessionID, b.goos)
```

Only for Windows `system`/`user`, reserve after all credential, executable, protocol, role, and peer/claim checks. Then send the accepted auth response, install the derived HMAC key with `conn.SetSessionKey`, construct the `Session`, and commit it. Defer reservation release until commit succeeds. If commit fails because shutdown or eligibility changed after acceptance, close the authenticated connection without publishing it. Live duplicates and undesired keys receive permanent rejection so surplus or terminally ineligible scheduled helpers exit instead of reconnecting forever. Unix and every other role keep the existing accepted-response/key-install/registration path unchanged.

- [ ] **Step 5: Run broker tests with the race detector**

Run: `cd agent && go test -race ./internal/sessionbroker -run 'TestAdmission|TestReserveWindowsHelper|TestReservation|TestTwentySystem|TestUnixAndNonLifecycle|TestAdmit|TestIdentity' -count=1`

Expected: PASS with no race report.

- [ ] **Step 6: Commit admission and logical dedup**

```bash
git add agent/internal/sessionbroker/broker.go agent/internal/sessionbroker/broker_windows.go agent/internal/sessionbroker/broker_admission.go agent/internal/sessionbroker/broker_admission_test.go agent/internal/sessionbroker/lifecycle.go
git commit -m "fix(agent): scope helper admission to Windows sessions"
```

---

### Task 3: RDP-safe user authorization without weakening generic routing

**Files:**
- Modify: `agent/internal/sessionbroker/broker.go:1504-1583,1836-1879`
- Modify: `agent/internal/sessionbroker/console_session_gate_test.go:19-156`
- Modify: `agent/internal/sessionbroker/broker_test.go:74-99,166-221`

**Interfaces:**
- Consumes: kernel `verifiedWinSessionID`, authenticated `AuthRequest.WinSessionID`, and `HelperKey`.
- Produces: `roleIdentityRejection(role, sid string, uid uint32, peer, claimed, console, goos string)`.
- Preserves: `PreferredRunAsUserSession()` console-only behavior.
- Preserves: `SessionForUser` and `LaunchProcessViaUserHelperForSession` targeted routing.

- [ ] **Step 1: Replace the user-role table expectations with RDP-safe cases**

```go
tests := []struct {
	name, role, sid, peer, claimed, console, wantReason string
	wantReject bool
}{
	{"RDP user matching kernel session", ipc.HelperRoleUser, nonSystemSID, "7", "7", "1", "", false},
	{"RDP user session mismatch", ipc.HelperRoleUser, nonSystemSID, "7", "8", "1", "user role session claim does not match peer token", true},
	{"RDP user unknown peer session", ipc.HelperRoleUser, nonSystemSID, "0", "7", "1", "user role requires an interactive peer session", true},
	{"SYSTEM cannot claim user", ipc.HelperRoleUser, systemSID, "7", "7", "1", "user role requires non-SYSTEM identity", true},
	{"non-SYSTEM cannot claim system", ipc.HelperRoleSystem, nonSystemSID, "7", "7", "1", "system role requires SYSTEM identity", true},
	{"SYSTEM matching RDP session", ipc.HelperRoleSystem, systemSID, "7", "7", "1", "", false},
	{"assist remains console bound", ipc.HelperRoleAssist, nonSystemSID, "7", "7", "1", "assist role requires the active console session", true},
}
```

Call the revised gate with both peer and claimed session values. Retain the existing Unix test.

- [ ] **Step 2: Run the table and verify the old gate fails**

Run: `cd agent && go test -race ./internal/sessionbroker -run 'TestRoleIdentityRejection' -count=1`

Expected: FAIL because user role is still console-bound and the function lacks `claimed`.

- [ ] **Step 3: Implement the peer/claim equality gate**

```go
func roleIdentityRejection(role, sid string, uid uint32, peer, claimed, console, goos string) (string, bool) {
	if goos == "windows" {
		switch {
		case role == ipc.HelperRoleSystem && sid != systemSID:
			return "system role requires SYSTEM identity", true
		case role == ipc.HelperRoleUser && sid == systemSID:
			return "user role requires non-SYSTEM identity", true
		case role == ipc.HelperRoleAssist && sid == systemSID:
			return "assist role requires non-SYSTEM identity", true
		case role == ipc.HelperRoleWatchdog && sid != systemSID:
			return "watchdog role requires SYSTEM identity", true
		}
		if role == ipc.HelperRoleUser || role == ipc.HelperRoleSystem {
			if peer == "" || peer == "0" {
				return role + " role requires an interactive peer session", true
			}
			if peer != claimed {
				return role + " role session claim does not match peer token", true
			}
		}
		if role == ipc.HelperRoleAssist && (console == "" || console == "0" || peer != console) {
			return "assist role requires the active console session", true
		}
		return "", false
	}
	if (role == ipc.HelperRoleWatchdog || role == ipc.HelperRoleSystem) && uid != 0 {
		return role + " role requires root identity", true
	}
	return "", false
}
```

Use the authenticated numeric claim converted to decimal. Reject mismatch rather than warning and silently substituting the kernel value.

- [ ] **Step 4: Lock in the generic-versus-targeted routing boundary**

Add `TestPreferredRunAsUserSessionIgnoresRDPHelper`, `TestSessionForUserSelectsRDPHelper`, and `TestLaunchProcessViaUserHelperForSessionTargetsMatchingRDPHelper`. The first expects only the physical-console session; the latter two expect the authenticated session-7 helper.

- [ ] **Step 5: Run authorization and routing tests**

Run: `cd agent && go test -race ./internal/sessionbroker -run 'TestRoleIdentityRejection|TestPreferredRunAsUserSession|TestSessionForUser|TestLaunchProcessViaUserHelperForSession' -count=1`

Expected: PASS with generic console safety and targeted RDP routing both covered.

- [ ] **Step 6: Commit RDP authorization**

```bash
git add agent/internal/sessionbroker/broker.go agent/internal/sessionbroker/console_session_gate_test.go agent/internal/sessionbroker/broker_test.go
git commit -m "fix(agent): authenticate user helpers in matching RDP sessions"
```

---

### Task 4: Process-aware lifecycle registry and deterministic cleanup

**Files:**
- Create: `agent/internal/sessionbroker/lifecycle_core.go`
- Create: `agent/internal/sessionbroker/lifecycle_registry.go`
- Create: `agent/internal/sessionbroker/lifecycle_registry_test.go`
- Create: `agent/internal/sessionbroker/peer_process_windows.go`
- Create: `agent/internal/sessionbroker/peer_process_other.go`
- Create: `agent/internal/sessionbroker/peer_process_windows_test.go`
- Modify: `agent/internal/sessionbroker/lifecycle.go:20-392`
- Modify: `agent/internal/sessionbroker/lifecycle_stub.go`
- Modify: `agent/internal/sessionbroker/broker.go:247-454,1264-1702`
- Modify: `agent/internal/sessionbroker/session.go:30-115`
- Modify: `agent/internal/heartbeat/heartbeat.go:820-870,1092-1118`
- Modify: `agent/internal/heartbeat/heartbeat_test.go`

**Interfaces:**
- Consumes: `HelperKey` and broker logical-key registration.
- Produces: `helperProcess`, `helperSpawner`, `trackedHelper`, and `helperState`.
- Produces: idempotent `HelperLifecycleManager.Stop()` and `stopKey(HelperKey)`.
- Produces: lifecycle-specific broker observer registration without replacing heartbeat callbacks.
- Produces: a kernel-bound peer process handle for every authenticated Windows helper, including scheduled helpers outside the Job Object.
- Produces: synchronous shutdown order `broker stop accepting/pre-auth wait -> lifecycle terminate/reap -> broker session close -> remaining heartbeat shutdown`.

- [ ] **Step 1: Write fake-process tests for the accumulation and race cases**

```go
func TestReconcileDoesNotRespawnWhilePreAuthProcessLives(t *testing.T) {
	proc := newFakeHelperProcess(4100)
	spawner := &fakeHelperSpawner{processes: []helperProcess{proc}}
	m := newLifecycleHarness(t, []DetectedSession{{Session: "7", State: "active", Type: "rdp"}}, spawner)

	m.reconcile()
	m.reconcile()

	if got := spawner.SpawnCount(HelperKey{WindowsSessionID: 7, Role: "system"}); got != 1 {
		t.Fatalf("system spawn count = %d, want 1", got)
	}
}

func TestStaleExitCannotClearReplacement(t *testing.T) {
	oldProc := newFakeHelperProcess(4100)
	newProc := newFakeHelperProcess(4200)
	m := newLifecycleHarness(t, nil, &fakeHelperSpawner{})
	key := HelperKey{WindowsSessionID: 7, Role: "system"}
	oldGeneration := m.registry.attach(key, oldProc, "breeze-user-helper.exe", "system-helper")
	// The old generation has already transitioned out of the one-process slot;
	// its watcher is only late delivering the exit notification.
	oldProc.markExited(0)
	m.registry.detach(key, oldGeneration)
	m.registry.attach(key, newProc, "breeze-user-helper.exe", "system-helper")
	m.registry.noteExit(key, oldGeneration, 0)
	if got := m.registry.processID(key); got != 4200 {
		t.Fatalf("replacement PID = %d, want 4200", got)
	}
}

func TestStopSessionTerminatesBothRoles(t *testing.T) {
	m := newLifecycleHarness(t, nil, &fakeHelperSpawner{})
	m.registry.attach(HelperKey{WindowsSessionID: 7, Role: "system"}, newFakeHelperProcess(1), "helper", "system-helper")
	m.registry.attach(HelperKey{WindowsSessionID: 7, Role: "user"}, newFakeHelperProcess(2), "helper", "user-helper")
	m.stopSession(7)
	if got := m.registry.len(); got != 0 {
		t.Fatalf("registry len = %d, want 0", got)
	}
}
```

The fake process implements deterministic `Alive`, `Terminate`, `Wait`, and idempotent `Close`; the fake spawner counts by `HelperKey` and never calls Windows APIs. `detach` requires the matching generation to be stopping or observably non-live and leaves its watcher owning the process handle, so the stale-exit test proves exit before installing the replacement. Add `TestConcurrentReconcileStopAndExitOwnsHandleOnce` to assert one wait, one close, and no duplicate spawn under concurrent reconcile, stop, and exit delivery.

- [ ] **Step 2: Run the registry tests and verify missing harness failures**

Run: `cd agent && go test -race ./internal/sessionbroker -run 'TestReconcileDoesNotRespawn|TestStaleExit|TestStopSessionTerminates' -count=1`

Expected: FAIL because the process registry and injected spawner do not exist.

- [ ] **Step 3: Add lifecycle interfaces and generation-safe state**

```go
type helperProcess interface {
	ProcessID() uint32
	ExecutablePath() string
	Alive() bool
	Terminate() error
	Wait() (int, error)
	Close() error
}

type helperSpawner interface {
	Spawn(HelperKey) (helperProcess, error)
	Close() error
}

type ownedPeerProcess interface {
	ProcessID() uint32
	Alive() (bool, error)
	Terminate() error
	Close() error
}

type helperState string

const (
	helperStarting  helperState = "starting"
	helperConnected helperState = "connected"
	helperStopping  helperState = "stopping"
	helperExited    helperState = "exited"
)

type trackedHelper struct {
	key            HelperKey
	process        helperProcess
	generation     uint64
	state          helperState
	launchedAt     time.Time
	retryCount     int
	lastFailure    time.Time
	fatalExitUntil time.Time
	executablePath string
	commandMode    string
	done           chan struct{}
	exitCode       int
}
```

Move the registry/reconcile engine into host-neutral `lifecycle_core.go`; keep WTS/SCM event translation in build-tagged `lifecycle.go`. Reserve a `starting` entry under the manager lock before spawning. Attach a returned process only if the same generation is still current. Exactly one watcher owns `Wait` and process-handle `Close`; it records the exit code, closes `done`, and updates the registry only when its generation is still current. Stop paths wait on `done`, call idempotent `Terminate` after the graceful deadline, and finally close the Job Object for any survivor—they never race the watcher by closing its process handle. After closing the job, `Stop` performs one final bounded wait for all watcher `done` channels and logs any unreaped handle instead of blocking service shutdown indefinitely.

- [ ] **Step 4: Refactor reconciliation, SCM events, and shutdown**

Make reconciliation operate on `map[HelperKey]bool` and publish an immutable copy through `Broker.UpdateDesiredHelperKeys` before spawning. If an entry has an alive process, suppress spawn even when no broker session authenticated. On logoff/terminate stop both keys and publish the reduced desired set before closing sessions. On disconnect stop user, retain system, publish, and reconcile. `Stop` first publishes an empty desired set, swaps the registry into stopping state, requests graceful close, waits a bounded grace, terminates survivors, and closes the spawner/job owner.

After the existing credential/PID/session/executable verification succeeds during Windows authentication, open the peer PID once with query, synchronize, and terminate rights and store that handle in a session-owned `ownedPeerProcessRef`. This handle—not a later PID lookup—is the ownership proof for scheduled helpers. The ref has explicit `active -> termination-claimed -> consumed` states. `Broker.TerminateHelperKey`, while holding `b.mu` and before removing the matching logical owner, calls the ref's non-blocking `claimTermination`; it then removes ownership, releases `b.mu`, and the sole claim token performs `Terminate` followed by `Close`. No Windows call occurs under `b.mu`. Ordinary `Session.Close` and unexpected-disconnect cleanup route through the broker's same ownership-removal critical section before calling ref `close`; if termination is already claimed, `close` leaves the handle for the claim token, otherwise it consumes the active handle exactly once. Authentication rollback (which was never published as a logical owner) closes its ref directly. This ordering prevents an ordinary close from stealing a handle after terminal cleanup has selected the session, while still releasing every handle on ordinary disconnect and broker-wide close. Add `TestSessionCloseReleasesOwnedPeerProcessOnce`, `TestUnexpectedDisconnectReleasesOwnedPeerProcess`, and `TestConcurrentTerminateAndSessionCloseTerminatesAndConsumesPeerHandleOnce`; use a barrier after terminal claim and require exactly one `Terminate` and one `Close`, not merely one consumption. Lifecycle logoff/disconnect and shutdown call `TerminateHelperKey` as well as stopping any proactively tracked process. A helper rejected because its key is undesired receives a permanent rejection and exits before entering its reconnect loop.

Add a lifecycle observer API to `Broker` rather than overwriting `SetSessionAuthenticatedHandler` or `SetSessionClosedHandler`, which heartbeat already owns:

```go
type sessionLifecycleObserver struct {
	authenticated func(*Session)
	closed        func(*Session)
}

func (b *Broker) AddSessionLifecycleObserver(authenticated, closed func(*Session)) (remove func())
```

Store observers by generated ID under `b.mu`; return an idempotent remover. Copy callbacks while locked and invoke them after unlocking. On authentication, mark the matching tracked generation `connected`; on close, mark it non-connected only when the broker session pointer is still the logical-key owner. Process liveness—not a close callback—remains authoritative for whether reconciliation may spawn a replacement.

Retain the manager and its completion channel on `Heartbeat` instead of discarding the goroutine local. Add `Broker.StopAcceptingAndWait(context.Context) error`, backed by an accept/auth-handler wait group and a set of raw accepted connections registered before authentication. Close the listener and every still-pre-auth connection before waiting, but retain authenticated sessions and their peer handles for lifecycle termination; never hold `b.mu` while closing or waiting. `Heartbeat.Stop` supplies a bounded shutdown context, calls `StopAcceptingAndWait`, calls and awaits `HelperLifecycleManager.Stop` (which terminates logical helper sessions through their handles), then calls `Broker.Close` for remaining non-lifecycle sessions before completing existing teardown. Add `TestBrokerStopAcceptingAndWaitUnblocksStalledPreAuthConnection` and `TestHeartbeatStopOrdersBrokerBeforeLifecycleAndWaitsForReap` with injected ordered fakes.

- [ ] **Step 5: Run registry tests under race detection**

Run: `cd agent && go test -race ./internal/sessionbroker ./internal/heartbeat -run 'TestReconcile|TestStaleExit|TestStopSession|TestDisconnect|TestLifecycleStop|TestConcurrent|TestHeartbeatStopOrders|TestSessionClose|TestUnexpectedDisconnect' -count=1`

Expected: PASS with exactly one spawn under concurrent reconcile/SCM events and no race report.

- [ ] **Step 6: Commit lifecycle ownership**

```bash
git add agent/internal/sessionbroker/lifecycle_core.go agent/internal/sessionbroker/lifecycle_registry.go agent/internal/sessionbroker/lifecycle_registry_test.go agent/internal/sessionbroker/lifecycle.go agent/internal/sessionbroker/lifecycle_stub.go agent/internal/sessionbroker/peer_process_windows.go agent/internal/sessionbroker/peer_process_other.go agent/internal/sessionbroker/peer_process_windows_test.go agent/internal/sessionbroker/broker.go agent/internal/sessionbroker/session.go agent/internal/heartbeat/heartbeat.go agent/internal/heartbeat/heartbeat_test.go
git commit -m "fix(agent): own helper processes by session and role"
```

---

### Task 5: Kill-on-close Job Object and suspended helper creation

**Files:**
- Create: `agent/internal/sessionbroker/helper_job_windows.go`
- Create: `agent/internal/sessionbroker/helper_job_windows_test.go`
- Modify: `agent/internal/sessionbroker/spawner_windows.go:21-228`
- Modify: `agent/internal/sessionbroker/spawner_stub.go:16-25`

**Interfaces:**
- Consumes: `helperSpawner` and `helperProcess` from Task 4.
- Produces: `helperJob.Assign(windows.Handle) error` and `helperJob.Close() error`.
- Produces: `windowsHelperSpawner{job, closing}` as the single owner that serializes spawn/assign/resume against close.
- Produces: process methods on `SpawnedHelper`.

- [ ] **Step 1: Write native Windows Job Object behavior tests**

```go
//go:build windows

func TestClosingHelperJobTerminatesAssignedProcess(t *testing.T) {
	job, err := newHelperJob()
	if err != nil {
		t.Fatal(err)
	}
	proc := startSuspendedTestProcess(t)
	defer proc.Close()
	if err := job.Assign(proc.Handle); err != nil {
		t.Fatal(err)
	}
	resumeTestProcess(t, proc.Thread)
	if err := job.Close(); err != nil {
		t.Fatal(err)
	}
	if event, err := windows.WaitForSingleObject(proc.Handle, 5_000); err != nil || event != windows.WAIT_OBJECT_0 {
		t.Fatalf("process survived job close: event=%d err=%v", event, err)
	}
}

func TestSpawnedHelperTerminateIsIdempotent(t *testing.T) {
	proc := startSuspendedTestProcess(t)
	helper := &SpawnedHelper{PID: proc.PID, Handle: proc.Handle, BinaryPath: proc.Path}
	if err := helper.Terminate(); err != nil {
		t.Fatal(err)
	}
	if err := helper.Terminate(); err != nil {
		t.Fatal(err)
	}
}
```

- [ ] **Step 2: Run on Windows and verify missing-symbol failures**

Run on Windows: `cd agent && go test -race ./internal/sessionbroker -run 'TestClosingHelperJob|TestSpawnedHelperTerminate' -count=1`

Expected: FAIL because `newHelperJob`, `Assign`, and `Terminate` do not exist.

- [ ] **Step 3: Implement the Job Object wrapper**

```go
//go:build windows

type helperJob struct {
	mu     sync.Mutex
	handle windows.Handle
}

func newHelperJob() (*helperJob, error) {
	h, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, fmt.Errorf("CreateJobObject: %w", err)
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(h, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		windows.CloseHandle(h)
		return nil, fmt.Errorf("SetInformationJobObject: %w", err)
	}
	return &helperJob{handle: h}, nil
}

func (j *helperJob) Assign(process windows.Handle) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.handle == 0 {
		return errors.New("helper job is closed")
	}
	return windows.AssignProcessToJobObject(j.handle, process)
}

func (j *helperJob) Close() error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.handle == 0 {
		return nil
	}
	err := windows.CloseHandle(j.handle)
	j.handle = 0
	return err
}
```

- [ ] **Step 4: Create helpers suspended, assign, then resume**

`windowsHelperSpawner.Spawn` holds its mutex from the closing check through process creation, job assignment, and thread resume; `Close` holds the same mutex while setting `closing` and closing the job. Both SYSTEM-token and user-token spawn paths use:

```go
creationFlags := uint32(windows.CREATE_SUSPENDED | windows.CREATE_NO_WINDOW | windows.CREATE_UNICODE_ENVIRONMENT)
if err := windows.CreateProcessAsUser(token, nil, cmdLine, nil, nil, false, creationFlags, env, cwd, &si, &pi); err != nil {
	return nil, err
}
cleanup := true
defer func() {
	if cleanup {
		_ = windows.TerminateProcess(pi.Process, 1)
		_ = windows.CloseHandle(pi.Thread)
		_ = windows.CloseHandle(pi.Process)
	}
}()
if err := s.job.Assign(pi.Process); err != nil {
	return nil, fmt.Errorf("assign helper to job: %w", err)
}
if _, err := windows.ResumeThread(pi.Thread); err != nil {
	return nil, fmt.Errorf("resume helper: %w", err)
}
_ = windows.CloseHandle(pi.Thread)
cleanup = false
return &SpawnedHelper{PID: pi.ProcessId, Handle: pi.Process, BinaryPath: exePath}, nil
```

If job assignment fails, the helper is still suspended and is terminated before any user code runs.

- [ ] **Step 5: Verify native behavior, cross-compilation, and races**

Run on Windows: `cd agent && go test -race ./internal/sessionbroker -count=1`

Run on non-Windows: `cd agent && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go test -c -o /tmp/sessionbroker.test.exe ./internal/sessionbroker`

Expected: native tests PASS; cross-compilation produces `/tmp/sessionbroker.test.exe`.

- [ ] **Step 6: Commit Job Object ownership**

```bash
git add agent/internal/sessionbroker/helper_job_windows.go agent/internal/sessionbroker/helper_job_windows_test.go agent/internal/sessionbroker/spawner_windows.go agent/internal/sessionbroker/spawner_stub.go
git commit -m "fix(agent): contain Windows helpers in a kill-on-close job"
```

---

### Task 6: Multi-session integration coverage and Windows CI

**Files:**
- Create: `agent/internal/sessionbroker/rds_lifecycle_integration_test.go`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes all prior RDS helper interfaces.
- Produces a required Windows test invocation for `internal/sessionbroker`.

- [ ] **Step 1: Add a fake 20-session convergence test**

```go
func TestRDSReconcileConvergesWithoutAccumulation(t *testing.T) {
	sessions := make([]DetectedSession, 0, 20)
	for id := 1; id <= 20; id++ {
		sessions = append(sessions, DetectedSession{Session: strconv.Itoa(id), State: "active", Type: "rdp"})
	}
	spawner := newCountingHelperSpawner()
	m := newLifecycleHarness(t, sessions, spawner)
	for i := 0; i < 10; i++ {
		m.reconcile()
	}
	if got := spawner.TotalSpawnCount(); got != 40 {
		t.Fatalf("spawned %d helpers, want 40", got)
	}
	for _, key := range spawner.Keys() {
		if got := spawner.SpawnCount(key); got != 1 {
			t.Fatalf("%s spawned %d times, want 1", key, got)
		}
	}
}
```

Add `TestRDSBrokerAdmissionAndLifecycleConvergeTwentySessions`: publish the 40 desired role keys, reserve/complete authenticated SYSTEM sessions for the same LocalSystem SID in Windows sessions 1-20, and assert all 20 commit through distinct composite identity buckets. Run reconciliation ten times; it must retain those 20 broker sessions, spawn exactly one user helper per active session, and spawn no replacement SYSTEM helpers. A paired same-session subtest reserves six pre-auth identity slots and requires the sixth to hit the existing five-connection bound.

- [ ] **Step 2: Run the integration test with the race detector**

Run: `cd agent && go test -race ./internal/sessionbroker -run 'TestRDS(Reconcile|BrokerAdmission)' -count=10`

Expected: PASS on all ten repetitions: the process-only case owns exactly 40 processes, and the broker-integrated case retains 20 authenticated SYSTEM sessions plus exactly 20 spawned user processes.

- [ ] **Step 3: Add Windows CI execution**

Add this required job next to `test-agent`:

```yaml
  test-agent-windows:
    name: Test Agent (Windows)
    runs-on: windows-latest
    needs: [lint]
    timeout-minutes: 20
    steps:
      - name: Checkout
        uses: actions/checkout@v7

      - name: Setup Go
        uses: actions/setup-go@v6
        with:
          go-version: ${{ env.GO_VERSION }}
          cache-dependency-path: agent/go.sum

      - name: Download Go dependencies
        working-directory: agent
        run: go mod download

      - name: Run Windows Go tests
        working-directory: agent
        run: go test -race ./internal/sessionbroker ./internal/heartbeat ./internal/agentapp ./internal/config ./internal/watchdog ./cmd/breeze-watchdog
```

Do not replace the existing Ubuntu `test-agent` job; Windows execution covers build-tagged runtime tests. Add `test-agent-windows` to `ci-success.needs`, expose it as `TEST_AGENT_WINDOWS_RESULT`, and require that value to equal `success` in the summary shell condition.

- [ ] **Step 4: Run the complete agent suite**

Run: `cd agent && go test -race ./...`

Expected: PASS with no race report.

- [ ] **Step 5: Commit integration coverage**

```bash
git add agent/internal/sessionbroker/rds_lifecycle_integration_test.go .github/workflows/ci.yml
git commit -m "test(agent): cover RDS helper convergence on Windows"
```

## Plan Completion Gate

- One composite admission bucket exists per SID and Windows session.
- One authenticated helper exists per `HelperKey`.
- A live pre-auth helper prevents another spawn.
- User helpers authenticate in their own RDP sessions; generic `runAs=user` stays console-bound.
- Logoff, disconnect, service stop, and agent crash have deterministic cleanup behavior.
- Every proactively spawned helper is assigned to the Job Object before it runs.
- `cd agent && go test -race ./...` passes.
- Native Windows build-tagged tests run in CI.
