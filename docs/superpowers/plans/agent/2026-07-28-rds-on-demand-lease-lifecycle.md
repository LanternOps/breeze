# RDS On-Demand Lease Lifecycle Implementation Plan (Plan 2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On RDS-detected Windows hosts the helper lifecycle spawns nothing at rest; helpers are spawned when an operation acquires a lease on a session and reaped when the lease lapses — with typed spawn-wait results, clean exits for undesired logon-task helpers, and the resolved mode reported in the heartbeat.

**Architecture:** Spec section "Architecture" of `docs/superpowers/specs/agent/2026-07-28-rds-per-session-helpers-design.md`. The reconcile tail, spawn registry, backoff/fatal-cooldown, and admission gate are all reused unchanged; what changes is the desired-set *input* (mode-switched: detector-driven vs lease-driven), the SCM handlers (mode-aware lease invalidation), and three new seams: `AcquireLease`/`ReleaseLease`/`RenewLease`, `WaitForHelperReady`, and a `not_desired` auth-reject code that lets logon-task helpers exit 0. Plan 3 wires the consumer paths (RD connect, script targeting, UI); nothing in this plan changes behavior on non-RDS hosts.

**Tech Stack:** Go (agent), Zod/Hono/Drizzle (API heartbeat field), hand-written SQL migration.

## Global Constraints

- Branch: `ToddHebebrand/multiple-user-helpers`. Commit per task with trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- CI runs Go tests on non-Windows: **all new logic goes in build-tag-free files**; `//go:build windows` files get thin wiring only. Note `lifecycle.go` is windows-tagged, `lifecycle_core.go` / `lifecycle_registry.go` / `rds_lifecycle_integration_test.go` are untagged, `lifecycle_test.go` IS windows-tagged.
- Go tests: `cd agent && go test -race ./internal/sessionbroker/...` (plus package under edit). Cross-compile check after agent tasks: `GOOS=windows go build ./... ` from `agent/`.
- **Always-on behavior must be bit-identical.** Every existing sessionbroker test must pass unmodified except where a constructor signature change forces a mechanical call-site update.
- Session state strings: `"active" | "connected" | "disconnected"`; types `"console" | "rdp" | "services"`. `HelperKey{WindowsSessionID uint32, Role ipc.HelperRole}`. Roles: `ipc.HelperRoleSystem` / `ipc.HelperRoleUser`.
- Suite-mask constants: `VER_SUITE_TERMINAL = 0x0010`, `VER_SUITE_SINGLEUSERTS = 0x0100`. RDS host ⇔ `TERMINAL set && SINGLEUSERTS clear`.
- Lease constants: linger after last release `2 * time.Minute`; default per-owner TTL `5 * time.Minute`; max TTL `30 * time.Minute`.
- Migrations: idempotent, no inner `BEGIN;`/`COMMIT;`, filename `2026-07-28-device-helper-lifecycle-mode.sql`, never edit shipped migrations.
- Zod heartbeat schema default-strips unknown keys — a new agent payload field MUST be added to `heartbeatSchema` or the API silently drops it.

---

### Task 1: RDS detection + mode resolution

**Files:**
- Create: `agent/internal/sessionbroker/lifecycle_mode.go`
- Create: `agent/internal/sessionbroker/lifecycle_mode_test.go`
- Create: `agent/internal/sessionbroker/rdsdetect_windows.go`
- Create: `agent/internal/sessionbroker/rdsdetect_stub.go`

**Interfaces:**
- Produces: `type LifecycleMode string` with `LifecycleModeAlwaysOn` (`"always-on"`) and `LifecycleModeOnDemand` (`"on-demand"`); `isRDSSuiteMask(suiteMask uint16) bool`; `resolveLifecycleMode(override string, rdsHost bool) LifecycleMode`; `detectRDSHost() bool` (windows real / stub false).

- [ ] **Step 1: Write the failing test**

Create `agent/internal/sessionbroker/lifecycle_mode_test.go`:

```go
package sessionbroker

import "testing"

func TestIsRDSSuiteMask(t *testing.T) {
	tests := []struct {
		name string
		mask uint16
		want bool
	}{
		{"terminal only (RD Session Host role)", 0x0010, true},
		{"terminal plus other suites", 0x0010 | 0x0002, true},
		{"terminal AND single-user TS (normal workstation)", 0x0010 | 0x0100, false},
		{"single-user TS only", 0x0100, false},
		{"neither bit", 0x0000, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isRDSSuiteMask(tt.mask); got != tt.want {
				t.Errorf("isRDSSuiteMask(%#x) = %v, want %v", tt.mask, got, tt.want)
			}
		})
	}
}

func TestResolveLifecycleMode(t *testing.T) {
	tests := []struct {
		name     string
		override string
		rdsHost  bool
		want     LifecycleMode
	}{
		{"auto on RDS host", "", true, LifecycleModeOnDemand},
		{"auto on workstation", "", false, LifecycleModeAlwaysOn},
		{"explicit auto on RDS host", "auto", true, LifecycleModeOnDemand},
		{"override always-on beats RDS detection", "always-on", true, LifecycleModeAlwaysOn},
		{"override on-demand beats workstation detection", "on-demand", false, LifecycleModeOnDemand},
		{"garbage override falls back to auto", "bogus", true, LifecycleModeOnDemand},
		{"garbage override on workstation", "bogus", false, LifecycleModeAlwaysOn},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := resolveLifecycleMode(tt.override, tt.rdsHost); got != tt.want {
				t.Errorf("resolveLifecycleMode(%q, %v) = %q, want %q", tt.override, tt.rdsHost, got, tt.want)
			}
		})
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test -race ./internal/sessionbroker/ -run 'TestIsRDSSuiteMask|TestResolveLifecycleMode' -v`
Expected: FAIL — `undefined: isRDSSuiteMask`

- [ ] **Step 3: Implement the pure functions**

Create `agent/internal/sessionbroker/lifecycle_mode.go`:

```go
package sessionbroker

// LifecycleMode selects how the helper lifecycle computes its desired set.
// Always-on (the historical behavior, and the only mode off Windows Server)
// spawns helpers proactively for every eligible session. On-demand — the
// default on RD Session Hosts — spawns nothing at rest: helpers exist only
// while an operation holds a lease on their session (see lifecycle_lease.go).
type LifecycleMode string

const (
	LifecycleModeAlwaysOn LifecycleMode = "always-on"
	LifecycleModeOnDemand LifecycleMode = "on-demand"
)

// Windows suite-mask bits (winnt.h). VER_SUITE_TERMINAL alone means the RD
// Session Host role is installed; every modern Windows sets it together with
// VER_SUITE_SINGLEUSERTS for the built-in 2-session remote admin mode, so a
// true multi-session host is TERMINAL && !SINGLEUSERTS.
const (
	verSuiteTerminal     uint16 = 0x0010
	verSuiteSingleUserTS uint16 = 0x0100
)

func isRDSSuiteMask(suiteMask uint16) bool {
	return suiteMask&verSuiteTerminal != 0 && suiteMask&verSuiteSingleUserTS == 0
}

// resolveLifecycleMode maps the config override ("always-on" | "on-demand" |
// "auto" | "") plus the host detection result to the operating mode. Unknown
// override values behave as auto so a typo in a config file degrades to the
// sensible default instead of forcing a mode.
func resolveLifecycleMode(override string, rdsHost bool) LifecycleMode {
	switch override {
	case string(LifecycleModeAlwaysOn):
		return LifecycleModeAlwaysOn
	case string(LifecycleModeOnDemand):
		return LifecycleModeOnDemand
	}
	if rdsHost {
		return LifecycleModeOnDemand
	}
	return LifecycleModeAlwaysOn
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && go test -race ./internal/sessionbroker/ -run 'TestIsRDSSuiteMask|TestResolveLifecycleMode' -v`
Expected: PASS

- [ ] **Step 5: Add the Windows detection + stub**

Create `agent/internal/sessionbroker/rdsdetect_windows.go`:

```go
//go:build windows

package sessionbroker

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	modNtdll          = windows.NewLazySystemDLL("ntdll.dll")
	procRtlGetVersion = modNtdll.NewProc("RtlGetVersion")
)

// rtlOSVersionInfoExW mirrors RTL_OSVERSIONINFOEXW (winternl.h /
// wdm.h). RtlGetVersion is used instead of GetVersionExW because the latter
// lies under compatibility shims; RtlGetVersion always reports the true
// version and suite mask.
type rtlOSVersionInfoExW struct {
	osVersionInfoSize uint32
	majorVersion      uint32
	minorVersion      uint32
	buildNumber       uint32
	platformID        uint32
	csdVersion        [128]uint16
	servicePackMajor  uint16
	servicePackMinor  uint16
	suiteMask         uint16
	productType       byte
	reserved          byte
}

// detectRDSHost reports whether this host has the RD Session Host
// (multi-session Terminal Services) role. Fails closed to false — a failed
// syscall leaves the lifecycle in always-on, the historical behavior.
func detectRDSHost() bool {
	var info rtlOSVersionInfoExW
	info.osVersionInfoSize = uint32(unsafe.Sizeof(info))
	ret, _, _ := procRtlGetVersion.Call(uintptr(unsafe.Pointer(&info)))
	if ret != 0 { // NTSTATUS: 0 == STATUS_SUCCESS
		return false
	}
	return isRDSSuiteMask(info.suiteMask)
}
```

Create `agent/internal/sessionbroker/rdsdetect_stub.go`:

```go
//go:build !windows

package sessionbroker

// detectRDSHost is Windows-only; other platforms have no RDS concept.
func detectRDSHost() bool { return false }
```

- [ ] **Step 6: Verify package tests + Windows cross-compile**

Run: `cd agent && go test -race ./internal/sessionbroker/... && GOOS=windows go build ./internal/sessionbroker/`
Expected: PASS + clean build

- [ ] **Step 7: Commit**

```bash
git add agent/internal/sessionbroker/lifecycle_mode.go agent/internal/sessionbroker/lifecycle_mode_test.go agent/internal/sessionbroker/rdsdetect_windows.go agent/internal/sessionbroker/rdsdetect_stub.go
git commit -m "feat(agent): RDS host detection and helper lifecycle mode resolution

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Mode plumbing — constructor, config, accessor

**Files:**
- Modify: `agent/internal/sessionbroker/lifecycle_core.go` (struct + constructor, lines ~142-184)
- Modify: `agent/internal/sessionbroker/lifecycle.go:51-61` (windows `NewHelperLifecycleManager`)
- Modify: `agent/internal/sessionbroker/lifecycle_stub.go:8-10` (non-windows `NewHelperLifecycleManager`)
- Modify: `agent/internal/sessionbroker/lifecycle_registry_test.go:525` (call-site arity)
- Modify: `agent/internal/config/config.go:148-150` (new config field)
- Modify: `agent/internal/heartbeat/heartbeat.go` (`helperLifecycleController` interface ~line 163; call site line 1036)
- Test: `agent/internal/sessionbroker/lifecycle_mode_test.go` (append)

**Interfaces:**
- Consumes: `resolveLifecycleMode`, `detectRDSHost` (Task 1).
- Produces: `NewHelperLifecycleManager(broker *Broker, scmCh <-chan SCMSessionEvent, modeOverride string) *HelperLifecycleManager` (both build variants — signature change); manager field `mode LifecycleMode`; `func (m *HelperLifecycleManager) Mode() string`; config field `HelperLifecycleMode string` (`helper_lifecycle_mode`). Later tasks branch on `m.mode`.

- [ ] **Step 1: Write the failing test**

Append to `agent/internal/sessionbroker/lifecycle_mode_test.go`:

```go
func TestManagerModeDefaultsToAlwaysOn(t *testing.T) {
	m := newHelperLifecycleManager(nil, nil, nil, nil)
	if m.mode != LifecycleModeAlwaysOn {
		t.Fatalf("mode = %q, want always-on default", m.mode)
	}
	if m.Mode() != string(LifecycleModeAlwaysOn) {
		t.Fatalf("Mode() = %q, want %q", m.Mode(), LifecycleModeAlwaysOn)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test -race ./internal/sessionbroker/ -run TestManagerModeDefaultsToAlwaysOn -v`
Expected: FAIL — `m.mode undefined`

- [ ] **Step 3: Add the field, default, and accessor**

In `agent/internal/sessionbroker/lifecycle_core.go`:

1. Add to `HelperLifecycleManager` struct (after the `now` field):

```go
	mode LifecycleMode
```

2. In `newHelperLifecycleManager`, add to the struct literal:

```go
		mode: LifecycleModeAlwaysOn,
```

3. Add near `Done()`:

```go
// Mode reports the resolved lifecycle mode ("always-on" | "on-demand") for
// heartbeat reporting and diagnostics.
func (m *HelperLifecycleManager) Mode() string { return string(m.mode) }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && go test -race ./internal/sessionbroker/ -run TestManagerModeDefaultsToAlwaysOn -v`
Expected: PASS

- [ ] **Step 5: Change the exported constructors to take the override**

`agent/internal/sessionbroker/lifecycle.go` — replace `NewHelperLifecycleManager` (lines 51-61):

```go
func NewHelperLifecycleManager(broker *Broker, scmCh <-chan SCMSessionEvent, modeOverride string) *HelperLifecycleManager {
	rdsHost := detectRDSHost()
	mode := resolveLifecycleMode(modeOverride, rdsHost)
	log.Info("helper lifecycle mode resolved", "mode", string(mode), "rdsHost", rdsHost, "override", modeOverride)
	manager, err := buildWindowsHelperLifecycleManager(broker, scmCh, newWindowsHelperSpawner)
	if err != nil {
		// Keep heartbeat startup operational, but disable proactive spawning.
		// Reconciliation will retry on the next agent/service restart, when a
		// fresh Job Object can be created before any helper process exists.
		log.Error("lifecycle: failed to initialize helper Job Object", "error", err.Error())
		manager = newHelperLifecycleManager(broker, NewSessionDetector(), scmCh, nil)
	}
	manager.mode = mode
	return manager
}
```

`agent/internal/sessionbroker/lifecycle_stub.go` — replace the constructor:

```go
func NewHelperLifecycleManager(broker *Broker, scmCh <-chan SCMSessionEvent, modeOverride string) *HelperLifecycleManager {
	m := newHelperLifecycleManager(broker, NewSessionDetector(), scmCh, nil)
	m.mode = resolveLifecycleMode(modeOverride, detectRDSHost())
	return m
}
```

Update the call site `agent/internal/sessionbroker/lifecycle_registry_test.go:525` to pass `""` as the third argument.

- [ ] **Step 6: Config field + heartbeat plumbing**

1. `agent/internal/config/config.go` — extend the user-helper block (lines 148-150):

```go
	// User helper configuration
	UserHelperEnabled bool   `mapstructure:"user_helper_enabled"`
	IPCSocketPath     string `mapstructure:"ipc_socket_path"`
	// HelperLifecycleMode overrides on-demand vs always-on helper spawning:
	// "always-on" | "on-demand" | "auto" (default). Auto resolves to on-demand
	// on RD Session Hosts and always-on everywhere else.
	HelperLifecycleMode string `mapstructure:"helper_lifecycle_mode"`
```

2. `agent/internal/heartbeat/heartbeat.go:1036` — pass it through:

```go
		lifecycle = sessionbroker.NewHelperLifecycleManager(h.sessionBroker, h.scmSessionCh, h.config.HelperLifecycleMode)
```

3. Extend the `helperLifecycleController` interface (heartbeat.go ~line 163, currently `Stop`/`Done` only) with `Mode() string` — the manager already satisfies it after Step 3. If any test fake implements `helperLifecycleController`, add a `Mode() string { return "always-on" }` method to the fake (grep `helperLifecycleController` in `agent/internal/heartbeat/*_test.go`).

- [ ] **Step 7: Run the affected suites + cross-compile**

Run: `cd agent && go test -race ./internal/sessionbroker/... ./internal/heartbeat/... ./internal/config/... && GOOS=windows go build ./...`
Expected: PASS + clean build (the heartbeat suite is slow, ~30s)

- [ ] **Step 8: Commit**

```bash
git add agent/internal/sessionbroker/ agent/internal/config/config.go agent/internal/heartbeat/heartbeat.go
git commit -m "feat(agent): plumb helper lifecycle mode through constructor, config, heartbeat controller

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Lease table

**Files:**
- Create: `agent/internal/sessionbroker/lifecycle_lease.go`
- Create: `agent/internal/sessionbroker/lifecycle_lease_test.go`
- Modify: `agent/internal/sessionbroker/lifecycle_core.go` (manager fields + constructor init + kick channel)

**Interfaces:**
- Consumes: `HelperKey`, `helperRoleDesired`, `DetectedSession`, manager `m.mu`/`m.now`/`m.detector`.
- Produces (consumed by Task 4 and by plan 3's command paths):
  - `func (m *HelperLifecycleManager) AcquireLease(sessionID uint32, role ipc.HelperRole, opID string, ttl time.Duration) error`
  - `func (m *HelperLifecycleManager) RenewLease(sessionID uint32, role ipc.HelperRole, opID string, ttl time.Duration) error`
  - `func (m *HelperLifecycleManager) ReleaseLease(sessionID uint32, role ipc.HelperRole, opID string)`
  - `func (m *HelperLifecycleManager) kickReconcile()` and manager field `kickCh chan struct{}`
  - pure `leasedDesired(leases map[HelperKey]*helperLease, sessions []DetectedSession, now time.Time) (map[HelperKey]bool, []HelperKey)`
  - errors `ErrLeaseSessionNotFound`, `ErrLeaseUnknownOwner`, `ErrLeaseRoleNotSpawnable`
  - constants `leaseLinger = 2 * time.Minute`, `defaultLeaseTTL = 5 * time.Minute`, `maxLeaseTTL = 30 * time.Minute`

- [ ] **Step 1: Write the failing tests**

Create `agent/internal/sessionbroker/lifecycle_lease_test.go`:

```go
package sessionbroker

import (
	"context"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

type stubLeaseDetector struct{ sessions []DetectedSession }

func (d *stubLeaseDetector) ListSessions() ([]DetectedSession, error) { return d.sessions, nil }
func (d *stubLeaseDetector) WatchSessions(ctx context.Context) <-chan SessionEvent {
	ch := make(chan SessionEvent)
	close(ch)
	return ch
}

func activeRDP(id, user string) DetectedSession {
	return DetectedSession{Session: id, Username: user, State: "active", Type: "rdp"}
}

func TestLeasedDesired(t *testing.T) {
	base := time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)
	sysKey := HelperKey{WindowsSessionID: 3, Role: ipc.HelperRoleSystem}
	live := func() *helperLease {
		return &helperLease{key: sysKey, username: "bob", owners: map[string]time.Time{"op1": base.Add(time.Minute)}}
	}

	t.Run("owned lease on live session is desired", func(t *testing.T) {
		desired, expired := leasedDesired(map[HelperKey]*helperLease{sysKey: live()}, []DetectedSession{activeRDP("3", "bob")}, base)
		if !desired[sysKey] || len(expired) != 0 {
			t.Fatalf("desired=%v expired=%v", desired, expired)
		}
	})

	t.Run("session gone expires lease", func(t *testing.T) {
		desired, expired := leasedDesired(map[HelperKey]*helperLease{sysKey: live()}, nil, base)
		if len(desired) != 0 || len(expired) != 1 || expired[0] != sysKey {
			t.Fatalf("desired=%v expired=%v", desired, expired)
		}
	})

	t.Run("session id reused by different user expires lease", func(t *testing.T) {
		desired, expired := leasedDesired(map[HelperKey]*helperLease{sysKey: live()}, []DetectedSession{activeRDP("3", "mallory")}, base)
		if len(desired) != 0 || len(expired) != 1 {
			t.Fatalf("desired=%v expired=%v", desired, expired)
		}
	})

	t.Run("all owners expired starts linger, not expiry", func(t *testing.T) {
		lease := live()
		lease.owners = map[string]time.Time{"op1": base.Add(-time.Second)}
		desired, expired := leasedDesired(map[HelperKey]*helperLease{sysKey: lease}, []DetectedSession{activeRDP("3", "bob")}, base)
		if !desired[sysKey] || len(expired) != 0 {
			t.Fatalf("freshly idle lease must stay desired through linger; desired=%v expired=%v", desired, expired)
		}
		if lease.idleSince.IsZero() {
			t.Fatal("idleSince not stamped when owners emptied")
		}
	})

	t.Run("idle past linger expires", func(t *testing.T) {
		lease := live()
		lease.owners = map[string]time.Time{}
		lease.idleSince = base.Add(-leaseLinger - time.Second)
		_, expired := leasedDesired(map[HelperKey]*helperLease{sysKey: lease}, []DetectedSession{activeRDP("3", "bob")}, base)
		if len(expired) != 1 {
			t.Fatalf("idle-past-linger lease not expired: %v", expired)
		}
	})

	t.Run("re-acquire clears idleSince", func(t *testing.T) {
		lease := live()
		lease.owners = map[string]time.Time{}
		lease.idleSince = base.Add(-time.Minute)
		lease.owners["op2"] = base.Add(time.Minute)
		lease.idleSince = time.Time{} // AcquireLease does this; leasedDesired must then keep it
		desired, _ := leasedDesired(map[HelperKey]*helperLease{sysKey: lease}, []DetectedSession{activeRDP("3", "bob")}, base)
		if !desired[sysKey] {
			t.Fatal("re-acquired lease must be desired")
		}
	})

	t.Run("user role requires active session", func(t *testing.T) {
		userKey := HelperKey{WindowsSessionID: 3, Role: ipc.HelperRoleUser}
		lease := &helperLease{key: userKey, username: "bob", owners: map[string]time.Time{"op1": base.Add(time.Minute)}}
		disconnected := DetectedSession{Session: "3", Username: "bob", State: "disconnected", Type: "rdp"}
		desired, expired := leasedDesired(map[HelperKey]*helperLease{userKey: lease}, []DetectedSession{disconnected}, base)
		if desired[userKey] {
			t.Fatal("user-role helper must not be desired in a disconnected session")
		}
		if len(expired) != 0 {
			t.Fatal("ineligible-but-live session must not expire the lease (it may reconnect)")
		}
	})
}

func TestAcquireRenewReleaseLease(t *testing.T) {
	base := time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)
	det := &stubLeaseDetector{sessions: []DetectedSession{activeRDP("3", "bob")}}
	m := newHelperLifecycleManager(nil, det, nil, nil)
	m.now = func() time.Time { return base }
	sysKey := HelperKey{WindowsSessionID: 3, Role: ipc.HelperRoleSystem}

	if err := m.AcquireLease(3, ipc.HelperRoleSystem, "op1", 0); err != nil {
		t.Fatalf("acquire: %v", err)
	}
	lease := m.leases[sysKey]
	if lease == nil || lease.username != "bob" {
		t.Fatalf("lease not recorded with username: %+v", lease)
	}
	if got := lease.owners["op1"]; !got.Equal(base.Add(defaultLeaseTTL)) {
		t.Fatalf("zero ttl must clamp to default: %v", got)
	}

	if err := m.RenewLease(3, ipc.HelperRoleSystem, "op1", time.Hour); err != nil {
		t.Fatalf("renew: %v", err)
	}
	if got := lease.owners["op1"]; !got.Equal(base.Add(maxLeaseTTL)) {
		t.Fatalf("oversized ttl must clamp to max: %v", got)
	}

	if err := m.RenewLease(3, ipc.HelperRoleSystem, "ghost", time.Minute); err != ErrLeaseUnknownOwner {
		t.Fatalf("renewing unknown owner: got %v", err)
	}
	if err := m.AcquireLease(99, ipc.HelperRoleSystem, "op1", 0); err != ErrLeaseSessionNotFound {
		t.Fatalf("acquire on missing session: got %v", err)
	}
	if err := m.AcquireLease(3, ipc.HelperRoleAssist, "op1", 0); err != ErrLeaseRoleNotSpawnable {
		t.Fatalf("acquire for assist role: got %v", err)
	}

	m.ReleaseLease(3, ipc.HelperRoleSystem, "op1")
	if len(lease.owners) != 0 || lease.idleSince.IsZero() {
		t.Fatalf("release must empty owners and stamp idleSince: %+v", lease)
	}

	// Second acquire on the same key clears idleSince.
	if err := m.AcquireLease(3, ipc.HelperRoleSystem, "op2", 0); err != nil {
		t.Fatalf("re-acquire: %v", err)
	}
	if !m.leases[sysKey].idleSince.IsZero() {
		t.Fatal("re-acquire must clear idleSince")
	}
}

func TestAcquireLeaseKicksReconcile(t *testing.T) {
	det := &stubLeaseDetector{sessions: []DetectedSession{activeRDP("3", "bob")}}
	m := newHelperLifecycleManager(nil, det, nil, nil)
	if err := m.AcquireLease(3, ipc.HelperRoleSystem, "op1", 0); err != nil {
		t.Fatal(err)
	}
	select {
	case <-m.kickCh:
	default:
		t.Fatal("AcquireLease must queue a reconcile kick")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd agent && go test -race ./internal/sessionbroker/ -run 'TestLeasedDesired|TestAcquireRenewReleaseLease|TestAcquireLeaseKicksReconcile' -v`
Expected: FAIL — `undefined: helperLease` etc.

- [ ] **Step 3: Implement**

Create `agent/internal/sessionbroker/lifecycle_lease.go`:

```go
package sessionbroker

import (
	"errors"
	"strconv"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// On-demand mode replaces "spawn a helper for every session" with leases: an
// operation (remote-desktop connection, targeted script) acquires a lease on
// {session, role}, the reconcile loop spawns the helper for leased keys only,
// and the helper is reaped once the last lease reference has been released
// (or expired) for leaseLinger. Leases bind the session's username at acquire
// time — Windows recycles WTS session IDs after logoff, so a lease whose
// session now belongs to a different user is dead, not transferable.
const (
	leaseLinger     = 2 * time.Minute
	defaultLeaseTTL = 5 * time.Minute
	maxLeaseTTL     = 30 * time.Minute
)

var (
	ErrLeaseSessionNotFound  = errors.New("lease target session not found")
	ErrLeaseUnknownOwner     = errors.New("lease owner not found")
	ErrLeaseRoleNotSpawnable = errors.New("lease role is not lifecycle-spawnable")
)

type helperLease struct {
	key      HelperKey
	username string
	// owners maps operation ID -> that owner's expiry. An owner whose expiry
	// passes without renewal is dropped by leasedDesired.
	owners map[string]time.Time
	// idleSince is stamped when owners empties; the lease survives another
	// leaseLinger from that point so back-to-back operations reuse the helper.
	idleSince time.Time
}

func clampLeaseTTL(ttl time.Duration) time.Duration {
	if ttl <= 0 {
		return defaultLeaseTTL
	}
	if ttl > maxLeaseTTL {
		return maxLeaseTTL
	}
	return ttl
}

// AcquireLease records (or extends) a lease for sessionID/role owned by opID.
// The target session must exist in a fresh detector snapshot; its username is
// bound to the lease. Valid in any mode — only on-demand mode's desired set
// consumes leases. ttl<=0 uses defaultLeaseTTL; ttl is capped at maxLeaseTTL.
func (m *HelperLifecycleManager) AcquireLease(sessionID uint32, role ipc.HelperRole, opID string, ttl time.Duration) error {
	if !helperRoleSpawnable(role) {
		return ErrLeaseRoleNotSpawnable
	}
	if m.detector == nil {
		return ErrLeaseSessionNotFound
	}
	sessions, err := m.detector.ListSessions()
	if err != nil {
		return err
	}
	var username string
	found := false
	target := strconv.FormatUint(uint64(sessionID), 10)
	for _, s := range sessions {
		if s.Session == target {
			username = s.Username
			found = true
			break
		}
	}
	if !found {
		return ErrLeaseSessionNotFound
	}

	key := HelperKey{WindowsSessionID: sessionID, Role: role}
	expiry := m.now().Add(clampLeaseTTL(ttl))
	m.mu.Lock()
	lease := m.leases[key]
	if lease == nil || (lease.username != username && username != "" && lease.username != "") {
		// New lease, or the session ID was recycled to a different user —
		// the old lease is not transferable.
		lease = &helperLease{key: key, username: username, owners: make(map[string]time.Time)}
		m.leases[key] = lease
	}
	lease.owners[opID] = expiry
	lease.idleSince = time.Time{}
	m.mu.Unlock()

	log.Info("lease acquired", "helperKey", key.String(), "opID", opID, "user", username)
	m.kickReconcile()
	return nil
}

// RenewLease extends an existing owner's expiry. Unlike AcquireLease it does
// not consult the detector — renewal is on the hot path of a live stream.
func (m *HelperLifecycleManager) RenewLease(sessionID uint32, role ipc.HelperRole, opID string, ttl time.Duration) error {
	key := HelperKey{WindowsSessionID: sessionID, Role: role}
	expiry := m.now().Add(clampLeaseTTL(ttl))
	m.mu.Lock()
	defer m.mu.Unlock()
	lease := m.leases[key]
	if lease == nil {
		return ErrLeaseSessionNotFound
	}
	if _, ok := lease.owners[opID]; !ok {
		return ErrLeaseUnknownOwner
	}
	lease.owners[opID] = expiry
	return nil
}

// ReleaseLease drops one owner's reference. The helper is not stopped here:
// the lease lingers for leaseLinger and the reconcile loop reaps it after.
func (m *HelperLifecycleManager) ReleaseLease(sessionID uint32, role ipc.HelperRole, opID string) {
	key := HelperKey{WindowsSessionID: sessionID, Role: role}
	m.mu.Lock()
	if lease := m.leases[key]; lease != nil {
		delete(lease.owners, opID)
		if len(lease.owners) == 0 && lease.idleSince.IsZero() {
			lease.idleSince = m.now()
		}
	}
	m.mu.Unlock()
	log.Info("lease released", "helperKey", key.String(), "opID", opID)
}

// dropLeases removes every lease for sessionID with one of the given roles.
// Called from the SCM handlers (session logoff/disconnect) — the caller is
// responsible for stopping the helper processes.
func (m *HelperLifecycleManager) dropLeases(sessionID uint32, roles ...ipc.HelperRole) {
	m.mu.Lock()
	for _, role := range roles {
		delete(m.leases, HelperKey{WindowsSessionID: sessionID, Role: role})
	}
	m.mu.Unlock()
}

// kickReconcile nudges the run loop to reconcile now instead of waiting for
// the 30s tick. Non-blocking: a pending kick is as good as two.
func (m *HelperLifecycleManager) kickReconcile() {
	select {
	case m.kickCh <- struct{}{}:
	default:
	}
}

// leasedDesired is the on-demand desired-set: leases intersected with a fresh
// WTS snapshot. Mutates lease.idleSince (stamping when owners empty out) and
// returns keys whose lease is dead (session gone, session-ID reused by a
// different user, or idle past linger) for the caller to delete under m.mu.
// A live-but-ineligible session (e.g. user-role in a disconnected session)
// keeps its lease but is not desired — the session may become active again.
func leasedDesired(leases map[HelperKey]*helperLease, sessions []DetectedSession, now time.Time) (map[HelperKey]bool, []HelperKey) {
	index := make(map[string]DetectedSession, len(sessions))
	for _, s := range sessions {
		index[s.Session] = s
	}
	desired := make(map[HelperKey]bool, len(leases))
	var expired []HelperKey
	for key, lease := range leases {
		sess, ok := index[strconv.FormatUint(uint64(key.WindowsSessionID), 10)]
		if !ok {
			expired = append(expired, key)
			continue
		}
		if lease.username != "" && sess.Username != "" && sess.Username != lease.username {
			expired = append(expired, key)
			continue
		}
		for opID, expiry := range lease.owners {
			if !expiry.After(now) {
				delete(lease.owners, opID)
			}
		}
		if len(lease.owners) == 0 {
			if lease.idleSince.IsZero() {
				lease.idleSince = now
			}
			if now.Sub(lease.idleSince) >= leaseLinger {
				expired = append(expired, key)
				continue
			}
		}
		if helperRoleDesired(sess, key.Role) {
			desired[key] = true
		}
	}
	return desired, expired
}
```

In `agent/internal/sessionbroker/lifecycle_core.go`, add manager fields (after `mode`):

```go
	leases map[HelperKey]*helperLease
	kickCh chan struct{}
```

and constructor init:

```go
		leases: make(map[HelperKey]*helperLease),
		kickCh: make(chan struct{}, 1),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd agent && go test -race ./internal/sessionbroker/ -run 'TestLeasedDesired|TestAcquireRenewReleaseLease|TestAcquireLeaseKicksReconcile' -v`
Expected: PASS

- [ ] **Step 5: Full package + cross-compile, commit**

Run: `cd agent && go test -race ./internal/sessionbroker/... && GOOS=windows go build ./internal/sessionbroker/`

```bash
git add agent/internal/sessionbroker/lifecycle_lease.go agent/internal/sessionbroker/lifecycle_lease_test.go agent/internal/sessionbroker/lifecycle_core.go
git commit -m "feat(agent): lease table for on-demand helper lifecycle

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Mode-switched desired set + mode-aware SCM handling + kick wiring

**Files:**
- Modify: `agent/internal/sessionbroker/lifecycle_core.go` (`Bootstrap` line ~222, `reconcile` line ~240 — introduce `computeDesired`)
- Modify: `agent/internal/sessionbroker/lifecycle.go` (`Start` select loop; `handleSCMEvent`)
- Test: `agent/internal/sessionbroker/lifecycle_lease_test.go` (append)

**Interfaces:**
- Consumes: `leasedDesired`, `dropLeases`, `kickCh` (Task 3); `m.mode` (Task 2).
- Produces: `func (m *HelperLifecycleManager) computeDesired() (map[HelperKey]bool, error)` — the single desired-set entry point used by `Bootstrap` and `reconcile`.

- [ ] **Step 1: Write the failing test**

Append to `agent/internal/sessionbroker/lifecycle_lease_test.go`:

```go
func TestComputeDesiredModeSwitch(t *testing.T) {
	det := &stubLeaseDetector{sessions: []DetectedSession{activeRDP("3", "bob")}}
	sysKey := HelperKey{WindowsSessionID: 3, Role: ipc.HelperRoleSystem}
	userKey := HelperKey{WindowsSessionID: 3, Role: ipc.HelperRoleUser}

	t.Run("always-on ignores leases and desires every eligible session", func(t *testing.T) {
		m := newHelperLifecycleManager(nil, det, nil, nil)
		desired, err := m.computeDesired()
		if err != nil {
			t.Fatal(err)
		}
		if !desired[sysKey] || !desired[userKey] {
			t.Fatalf("always-on must desire both roles: %v", desired)
		}
	})

	t.Run("on-demand with no leases desires nothing", func(t *testing.T) {
		m := newHelperLifecycleManager(nil, det, nil, nil)
		m.mode = LifecycleModeOnDemand
		desired, err := m.computeDesired()
		if err != nil {
			t.Fatal(err)
		}
		if len(desired) != 0 {
			t.Fatalf("on-demand at rest must desire nothing: %v", desired)
		}
	})

	t.Run("on-demand desires exactly the leased key and reaps expired leases", func(t *testing.T) {
		m := newHelperLifecycleManager(nil, det, nil, nil)
		m.mode = LifecycleModeOnDemand
		if err := m.AcquireLease(3, ipc.HelperRoleSystem, "op1", 0); err != nil {
			t.Fatal(err)
		}
		desired, err := m.computeDesired()
		if err != nil {
			t.Fatal(err)
		}
		if !desired[sysKey] || desired[userKey] || len(desired) != 1 {
			t.Fatalf("on-demand must desire exactly the leased key: %v", desired)
		}

		// Session disappears -> lease reaped from the table on next compute.
		det2 := &stubLeaseDetector{}
		m.detector = det2
		desired, err = m.computeDesired()
		if err != nil {
			t.Fatal(err)
		}
		if len(desired) != 0 {
			t.Fatalf("gone session must not be desired: %v", desired)
		}
		m.mu.Lock()
		_, still := m.leases[sysKey]
		m.mu.Unlock()
		if still {
			t.Fatal("expired lease must be deleted from the table")
		}
	})
}

func TestDropLeases(t *testing.T) {
	det := &stubLeaseDetector{sessions: []DetectedSession{activeRDP("3", "bob")}}
	m := newHelperLifecycleManager(nil, det, nil, nil)
	m.mode = LifecycleModeOnDemand
	if err := m.AcquireLease(3, ipc.HelperRoleSystem, "op1", 0); err != nil {
		t.Fatal(err)
	}
	if err := m.AcquireLease(3, ipc.HelperRoleUser, "op1", 0); err != nil {
		t.Fatal(err)
	}
	m.dropLeases(3, ipc.HelperRoleSystem, ipc.HelperRoleUser)
	desired, err := m.computeDesired()
	if err != nil {
		t.Fatal(err)
	}
	if len(desired) != 0 {
		t.Fatalf("dropped leases must leave nothing desired: %v", desired)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd agent && go test -race ./internal/sessionbroker/ -run 'TestComputeDesiredModeSwitch|TestDropLeases' -v`
Expected: FAIL — `undefined: m.computeDesired`

- [ ] **Step 3: Implement `computeDesired` and switch the two callers**

In `agent/internal/sessionbroker/lifecycle_core.go`, add after `detectedDesired`:

```go
// computeDesired is the single desired-set entry point: detector-driven in
// always-on mode (the historical behavior), lease-driven in on-demand mode.
func (m *HelperLifecycleManager) computeDesired() (map[HelperKey]bool, error) {
	if m.mode != LifecycleModeOnDemand {
		return m.detectedDesired()
	}
	if m.detector == nil {
		return map[HelperKey]bool{}, nil
	}
	sessions, err := m.detector.ListSessions()
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	desired, expired := leasedDesired(m.leases, sessions, m.now())
	for _, key := range expired {
		log.Info("lease expired", "helperKey", key.String())
		delete(m.leases, key)
	}
	m.mu.Unlock()
	return desired, nil
}
```

Change the `detectedDesired()` calls in `Bootstrap` (line ~222) and `reconcile` (line ~240) to `computeDesired()`. Everything downstream of the desired map is untouched.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd agent && go test -race ./internal/sessionbroker/ -run 'TestComputeDesiredModeSwitch|TestDropLeases' -v`
Expected: PASS

- [ ] **Step 5: Wire the kick channel and mode-aware SCM handling (thin, windows-tagged)**

In `agent/internal/sessionbroker/lifecycle.go`:

1. Add a case to the `Start` select loop (alongside the ticker case):

```go
		case <-m.kickCh:
			m.reconcile()
```

2. Make `handleSCMEvent` lease-aware — replace the two teardown cases:

```go
	// Session went away but is still logged on. The user helper requires
	// state=="active" so it goes; the SYSTEM helper is retained deliberately
	// in always-on mode (an RDP session keeps running when disconnected). In
	// on-demand mode a disconnected session is no longer shadowable, so its
	// SYSTEM lease dies with the connection.
	case wtsRemoteDisconnect, wtsConsoleDisconnect:
		if m.mode == LifecycleModeOnDemand {
			m.dropLeases(event.SessionID, ipc.HelperRoleSystem)
			m.removeDesired(systemKey)
			m.stopKey(systemKey)
		}
		m.removeDesired(userKey)
		m.stopKey(userKey)
		m.reconcile()
	case wtsSessionLogoff, wtsSessionTerminate:
		if m.mode == LifecycleModeOnDemand {
			m.dropLeases(event.SessionID, ipc.HelperRoleSystem, ipc.HelperRoleUser)
		}
		m.removeDesired(systemKey, userKey)
		m.stopKey(userKey)
		m.stopKey(systemKey)
	}
```

(The logon/connect case is unchanged: `clearFatal` + `reconcile` are harmless in on-demand mode — reconcile just re-evaluates leases.)

- [ ] **Step 6: Full package suite (always-on regression check) + cross-compile**

Run: `cd agent && go test -race ./internal/sessionbroker/... && GOOS=windows go build ./...`
Expected: PASS — in particular the untagged `rds_lifecycle_integration_test.go` (always-on scenarios) must pass unmodified.

- [ ] **Step 7: Commit**

```bash
git add agent/internal/sessionbroker/lifecycle_core.go agent/internal/sessionbroker/lifecycle.go agent/internal/sessionbroker/lifecycle_lease_test.go
git commit -m "feat(agent): mode-switched desired set and lease-aware SCM handling

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Clean exit for not-desired logon-task helpers

On-demand mode publishes an empty desired set at rest, so every logon-scheduled-task helper (`\Breeze\AgentUserHelper`, registered by the installer for every logon) is rejected at admission with `errHelperKeyNotDesired`, `Permanent:true` — and today exits with code 2, which the scheduled task's retry settings re-launch. Give the rejection a machine-readable code and have the helper exit 0 for this specific case: "not currently needed" is success, not failure.

**Files:**
- Modify: `agent/internal/ipc/message.go:200-207` (`AuthResponse` struct)
- Modify: `agent/internal/sessionbroker/broker_admission.go` (new `admissionRejectCode` helper)
- Modify: `agent/internal/sessionbroker/broker.go:2099-2117` (rejection response gains `Code`)
- Modify: `agent/internal/userhelper/client.go:283-285` (carry the code)
- Modify: `agent/internal/agentapp/main.go:1692-1717` (exit 0 on `not_desired`)
- Test: `agent/internal/sessionbroker/broker_admission_test.go` (append), `agent/internal/userhelper/client_test.go` (append if the file exists, else create)

**Interfaces:**
- Produces: `ipc.AuthResponse.Code string` (json `code,omitempty`); `admissionRejectCode(err error) string` returning `"not_desired"` / `"duplicate_key"` / `""`; the helper-side contract: `PermanentRejectError.Code == "not_desired"` → `os.Exit(0)`.

- [ ] **Step 1: Write the failing test**

Append to `agent/internal/sessionbroker/broker_admission_test.go`:

```go
func TestAdmissionRejectCode(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want string
	}{
		{"not desired", errHelperKeyNotDesired, "not_desired"},
		{"wrapped not desired", fmt.Errorf("auth: %w", errHelperKeyNotDesired), "not_desired"},
		{"duplicate key", errDuplicateHelperKey, "duplicate_key"},
		{"other admission error", errMaxConnectionsPerIdentity, ""},
		{"nil", nil, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := admissionRejectCode(tt.err); got != tt.want {
				t.Errorf("admissionRejectCode(%v) = %q, want %q", tt.err, got, tt.want)
			}
		})
	}
}
```

(Add `"fmt"` to the test file's imports if absent.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test -race ./internal/sessionbroker/ -run TestAdmissionRejectCode -v`
Expected: FAIL — `undefined: admissionRejectCode`

- [ ] **Step 3: Implement broker side**

1. `agent/internal/ipc/message.go` — add to `AuthResponse` (after `Permanent`):

```go
	// Code is a machine-readable rejection class for Accepted==false. Known
	// values: "not_desired" (helper key absent from the lifecycle desired set
	// — in on-demand mode this is the NORMAL answer for a logon-task helper
	// and the helper should exit 0), "duplicate_key".
	Code string `json:"code,omitempty"`
```

2. `agent/internal/sessionbroker/broker_admission.go` — add:

```go
// admissionRejectCode maps admission errors to the machine-readable Code sent
// in the auth response, so helpers can distinguish "not currently needed"
// (exit clean, no scheduled-task retry churn) from genuine permanent failures.
func admissionRejectCode(err error) string {
	switch {
	case errors.Is(err, errHelperKeyNotDesired):
		return "not_desired"
	case errors.Is(err, errDuplicateHelperKey):
		return "duplicate_key"
	}
	return ""
}
```

3. `agent/internal/sessionbroker/broker.go:2099-2117` — in the rejection send, add the field:

```go
			_ = conn.SendTyped(env.ID, ipc.TypeAuthResponse, ipc.AuthResponse{
				Accepted:  false,
				Reason:    err.Error(),
				Permanent: errors.Is(err, errDuplicateHelperKey) || errors.Is(err, errHelperKeyNotDesired),
				Code:      admissionRejectCode(err),
			})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && go test -race ./internal/sessionbroker/ -run TestAdmissionRejectCode -v`
Expected: PASS

- [ ] **Step 5: Helper side — carry the code, exit 0 on not_desired**

1. `agent/internal/userhelper/client.go:283-285` — use the server's code when present:

```go
	if !authResp.Accepted {
		if authResp.Permanent {
			code := authResp.Code
			if code == "" {
				code = "auth_rejected"
			}
			return &PermanentRejectError{Code: code, Reason: authResp.Reason}
		}
		return fmt.Errorf("auth rejected: %s", authResp.Reason)
	}
```

2. `agent/internal/agentapp/main.go:1692-1717` — before the existing exit-2 path:

```go
	var permErr *userhelper.PermanentRejectError
	if errors.As(err, &permErr) {
		if permErr.Code == "not_desired" {
			// On-demand lifecycle: this helper's session/role is simply not
			// leased right now. That is the normal state on an RDS host at
			// rest — exit 0 so the logon scheduled task records success and
			// does not retry-loop on every user logon.
			log.Info("helper not currently desired by lifecycle; exiting clean",
				"name", name, "reason", permErr.ReasonOr(err.Error()))
			logging.StopShipper()
			os.Exit(0)
		}
		log.Error("helper permanently rejected, exiting fatal",
			"name", name,
			"code", permErr.CodeOr("unknown"),
			"reason", permErr.ReasonOr(err.Error()),
		)
		logging.StopShipper() // flush before os.Exit tears down goroutines
		os.Exit(2)
	}
```

3. Add a client-side test (append to `agent/internal/userhelper/client_test.go` if it exists, else create with package `userhelper`):

```go
func TestPermanentRejectCodePassthrough(t *testing.T) {
	// The broker's structured Code must survive into PermanentRejectError so
	// main can distinguish "not_desired" (exit 0) from real fatals (exit 2).
	e := &PermanentRejectError{Code: "not_desired", Reason: "helper Windows session and role are not currently eligible"}
	if e.Code != "not_desired" {
		t.Fatal("code lost")
	}
	var target *PermanentRejectError
	if !errors.As(error(e), &target) {
		t.Fatal("errors.As must match PermanentRejectError")
	}
}
```

(If creating the file, imports are `"errors"` and `"testing"`.)

- [ ] **Step 6: Run affected suites + full cross-compile**

Run: `cd agent && go test -race ./internal/sessionbroker/... ./internal/userhelper/... ./internal/ipc/... && GOOS=windows go build ./...`
Expected: PASS + clean build

- [ ] **Step 7: Commit**

```bash
git add agent/internal/ipc/message.go agent/internal/sessionbroker/broker_admission.go agent/internal/sessionbroker/broker_admission_test.go agent/internal/sessionbroker/broker.go agent/internal/userhelper/client.go agent/internal/userhelper/client_test.go agent/internal/agentapp/main.go
git commit -m "feat(agent): machine-readable not_desired auth reject; logon-task helpers exit clean

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: WaitForHelperReady — typed spawn-and-wait

**Files:**
- Create: `agent/internal/sessionbroker/lifecycle_wait.go`
- Create: `agent/internal/sessionbroker/lifecycle_wait_test.go`
- Modify: `agent/internal/sessionbroker/lifecycle_registry.go` (add `diagnose`)
- Modify: `agent/internal/sessionbroker/broker.go` (add `HelperSessionByKey`)
- Modify: `agent/internal/sessionbroker/session.go` (add `CapabilitiesSnapshot`)

**Interfaces:**
- Consumes: registry entry fields (`state`, `fatalExitUntil`, `retryCount`), `maxSpawnRetries`, `helperStartupTimeout`, broker `helperByKey` map, `Session.Capabilities` (+ `s.mu`).
- Produces (plan 3's command paths consume this):

```go
type HelperWaitStatus string
const (
	HelperWaitReady            HelperWaitStatus = "ready"
	HelperWaitFatalCooldown    HelperWaitStatus = "fatal-cooldown"
	HelperWaitRetriesExhausted HelperWaitStatus = "retries-exhausted"
	HelperWaitSessionGone      HelperWaitStatus = "session-gone"
	HelperWaitTimeout          HelperWaitStatus = "timeout"
)
type HelperWaitResult struct {
	Status     HelperWaitStatus
	RetryAfter time.Duration // >0 only for fatal-cooldown
	Session    *Session      // non-nil only for ready
}
func (m *HelperLifecycleManager) WaitForHelperReady(ctx context.Context, key HelperKey) HelperWaitResult
```

- [ ] **Step 1: Write the failing tests**

Create `agent/internal/sessionbroker/lifecycle_wait_test.go`:

```go
package sessionbroker

import (
	"context"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func waitTestManager(t *testing.T, sessions []DetectedSession) *HelperLifecycleManager {
	t.Helper()
	broker := New("wait-"+t.Name(), nil)
	m := newHelperLifecycleManager(broker, &stubLeaseDetector{sessions: sessions}, nil, nil)
	m.mode = LifecycleModeOnDemand
	return m
}

func TestWaitForHelperReady(t *testing.T) {
	base := time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)
	sysKey := HelperKey{WindowsSessionID: 3, Role: ipc.HelperRoleSystem}

	t.Run("ready when broker session has capabilities", func(t *testing.T) {
		m := waitTestManager(t, []DetectedSession{activeRDP("3", "bob")})
		if err := m.AcquireLease(3, ipc.HelperRoleSystem, "op1", 0); err != nil {
			t.Fatal(err)
		}
		sess := &Session{WinSessionID: "3", HelperRole: ipc.HelperRoleSystem, Capabilities: &ipc.Capabilities{CanCapture: true}}
		m.broker.mu.Lock()
		m.broker.helperByKey[sysKey] = sess
		m.broker.mu.Unlock()

		res := m.WaitForHelperReady(context.Background(), sysKey)
		if res.Status != HelperWaitReady || res.Session != sess {
			t.Fatalf("got %+v, want ready with session", res)
		}
	})

	t.Run("session gone when lease missing", func(t *testing.T) {
		m := waitTestManager(t, []DetectedSession{activeRDP("3", "bob")})
		res := m.WaitForHelperReady(context.Background(), sysKey)
		if res.Status != HelperWaitSessionGone {
			t.Fatalf("got %+v, want session-gone", res)
		}
	})

	t.Run("fatal cooldown is surfaced with retry-after", func(t *testing.T) {
		m := waitTestManager(t, []DetectedSession{activeRDP("3", "bob")})
		if err := m.AcquireLease(3, ipc.HelperRoleSystem, "op1", 0); err != nil {
			t.Fatal(err)
		}
		m.registry.mu.Lock()
		m.registry.current[sysKey] = &trackedHelper{key: sysKey, state: helperExited, fatalExitUntil: base.Add(7 * time.Minute)}
		m.registry.mu.Unlock()
		m.now = func() time.Time { return base }

		res := m.WaitForHelperReady(context.Background(), sysKey)
		if res.Status != HelperWaitFatalCooldown {
			t.Fatalf("got %+v, want fatal-cooldown", res)
		}
		if res.RetryAfter != 7*time.Minute {
			t.Fatalf("RetryAfter = %v, want 7m", res.RetryAfter)
		}
	})

	t.Run("retries exhausted is surfaced", func(t *testing.T) {
		m := waitTestManager(t, []DetectedSession{activeRDP("3", "bob")})
		if err := m.AcquireLease(3, ipc.HelperRoleSystem, "op1", 0); err != nil {
			t.Fatal(err)
		}
		m.registry.mu.Lock()
		m.registry.current[sysKey] = &trackedHelper{key: sysKey, state: helperExited, retryCount: maxSpawnRetries}
		m.registry.mu.Unlock()

		res := m.WaitForHelperReady(context.Background(), sysKey)
		if res.Status != HelperWaitRetriesExhausted {
			t.Fatalf("got %+v, want retries-exhausted", res)
		}
	})

	t.Run("context cancel yields timeout", func(t *testing.T) {
		m := waitTestManager(t, []DetectedSession{activeRDP("3", "bob")})
		if err := m.AcquireLease(3, ipc.HelperRoleSystem, "op1", 0); err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
		defer cancel()
		res := m.WaitForHelperReady(ctx, sysKey)
		if res.Status != HelperWaitTimeout {
			t.Fatalf("got %+v, want timeout", res)
		}
	})
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd agent && go test -race ./internal/sessionbroker/ -run TestWaitForHelperReady -v`
Expected: FAIL — `undefined: HelperWaitStatus` etc.

- [ ] **Step 3: Implement**

1. `agent/internal/sessionbroker/lifecycle_registry.go` — add:

```go
// helperDiagnosis is a point-in-time snapshot of why a key's helper might not
// be coming up, for typed spawn-wait reporting.
type helperDiagnosis struct {
	tracked          bool
	state            helperState
	fatalUntil       time.Time
	retriesExhausted bool
}

func (r *helperRegistry) diagnose(key HelperKey, now time.Time) helperDiagnosis {
	r.mu.Lock()
	defer r.mu.Unlock()
	entry := r.current[key]
	if entry == nil {
		return helperDiagnosis{}
	}
	return helperDiagnosis{
		tracked:          true,
		state:            entry.state,
		fatalUntil:       entry.fatalExitUntil,
		retriesExhausted: entry.retryCount >= maxSpawnRetries && entry.state == helperExited,
	}
}
```

2. `agent/internal/sessionbroker/broker.go` — add near `HasHelperKeyOwner` (line ~593):

```go
// HelperSessionByKey returns the authenticated helper session owning key, or
// nil. Used by the lifecycle's spawn-wait to detect readiness.
func (b *Broker) HelperSessionByKey(key HelperKey) *Session {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.helperByKey[key]
}
```

3. `agent/internal/sessionbroker/session.go` — add near `SetCapabilities`:

```go
// CapabilitiesSnapshot returns the last-reported capabilities (nil until the
// helper's post-auth capabilities message arrives).
func (s *Session) CapabilitiesSnapshot() *ipc.Capabilities {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.Capabilities
}
```

4. Create `agent/internal/sessionbroker/lifecycle_wait.go`:

```go
package sessionbroker

import (
	"context"
	"time"
)

type HelperWaitStatus string

const (
	HelperWaitReady            HelperWaitStatus = "ready"
	HelperWaitFatalCooldown    HelperWaitStatus = "fatal-cooldown"
	HelperWaitRetriesExhausted HelperWaitStatus = "retries-exhausted"
	HelperWaitSessionGone      HelperWaitStatus = "session-gone"
	HelperWaitTimeout          HelperWaitStatus = "timeout"
)

// HelperWaitResult is a typed answer for "is the helper for this key up?" —
// callers surface Status to the technician instead of a bare timeout.
type HelperWaitResult struct {
	Status     HelperWaitStatus
	RetryAfter time.Duration // >0 only for fatal-cooldown
	Session    *Session      // non-nil only for ready
}

const helperWaitPollInterval = 200 * time.Millisecond

// WaitForHelperReady blocks until the helper for key is authenticated AND has
// reported capabilities (auth alone is not enough: CanCapture arrives on a
// later message), or until a typed failure is known, or ctx ends. Callers
// bound the wait with their own ctx; helperStartupTimeout is the natural
// budget. In on-demand mode the key must hold a live lease — acquire first.
func (m *HelperLifecycleManager) WaitForHelperReady(ctx context.Context, key HelperKey) HelperWaitResult {
	ticker := time.NewTicker(helperWaitPollInterval)
	defer ticker.Stop()
	for {
		if res, done := m.helperReadyCheck(key); done {
			return res
		}
		select {
		case <-ctx.Done():
			return HelperWaitResult{Status: HelperWaitTimeout}
		case <-ticker.C:
		}
	}
}

func (m *HelperLifecycleManager) helperReadyCheck(key HelperKey) (HelperWaitResult, bool) {
	if m.mode == LifecycleModeOnDemand {
		m.mu.Lock()
		_, leased := m.leases[key]
		m.mu.Unlock()
		if !leased {
			return HelperWaitResult{Status: HelperWaitSessionGone}, true
		}
	}
	if m.broker != nil {
		if sess := m.broker.HelperSessionByKey(key); sess != nil && sess.CapabilitiesSnapshot() != nil {
			return HelperWaitResult{Status: HelperWaitReady, Session: sess}, true
		}
	}
	now := m.now()
	diag := m.registry.diagnose(key, now)
	if diag.tracked {
		if !diag.fatalUntil.IsZero() && now.Before(diag.fatalUntil) {
			return HelperWaitResult{Status: HelperWaitFatalCooldown, RetryAfter: diag.fatalUntil.Sub(now)}, true
		}
		if diag.retriesExhausted {
			return HelperWaitResult{Status: HelperWaitRetriesExhausted}, true
		}
	}
	return HelperWaitResult{}, false
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd agent && go test -race ./internal/sessionbroker/ -run TestWaitForHelperReady -v`
Expected: PASS

- [ ] **Step 5: Full package + cross-compile, commit**

Run: `cd agent && go test -race ./internal/sessionbroker/... && GOOS=windows go build ./...`

```bash
git add agent/internal/sessionbroker/lifecycle_wait.go agent/internal/sessionbroker/lifecycle_wait_test.go agent/internal/sessionbroker/lifecycle_registry.go agent/internal/sessionbroker/broker.go agent/internal/sessionbroker/session.go
git commit -m "feat(agent): typed WaitForHelperReady spawn-wait API

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Heartbeat mode reporting end-to-end

**Files:**
- Modify: `agent/internal/heartbeat/heartbeat.go` (payload struct ~line 120; payload population ~line 3184-3209)
- Modify: `apps/api/src/routes/agents/schemas.ts` (~line 170, inside `heartbeatSchema`)
- Modify: `apps/api/src/routes/agents/heartbeat.ts` (~line 523, the `deviceUpdates` accumulation)
- Modify: `apps/api/src/db/schema/devices.ts` (~line 74)
- Create: `apps/api/migrations/2026-07-28-device-helper-lifecycle-mode.sql`
- Test: `apps/api/src/routes/agents/schemas.test.ts` (append; if no such file exists, add the case to whichever existing test covers `heartbeatSchema` — locate with `grep -rl heartbeatSchema apps/api/src --include='*.test.ts'`)

**Interfaces:**
- Consumes: `h.helperLifecycle` (`helperLifecycleController`, now with `Mode() string` from Task 2).
- Produces: agent JSON field `helperLifecycleMode`; devices column `helper_lifecycle_mode varchar(20)` (nullable — non-Windows/old agents never send it). Plan 3's UI reads this column to decide whether to show session pickers.

- [ ] **Step 1: Agent payload field**

In `agent/internal/heartbeat/heartbeat.go`:

1. Add to `HeartbeatPayload` (after `IsHeadless`):

```go
	// HelperLifecycleMode is the resolved helper spawn mode ("always-on" |
	// "on-demand"); on-demand means the host was detected (or configured) as
	// an RD Session Host and the UI should offer session targeting. Empty
	// when no lifecycle manager runs (non-Windows, non-service).
	HelperLifecycleMode string `json:"helperLifecycleMode,omitempty"`
```

2. In the payload-population block (~line 3184-3209), add:

```go
	h.mu.Lock()
	if h.helperLifecycle != nil {
		payload.HelperLifecycleMode = h.helperLifecycle.Mode()
	}
	h.mu.Unlock()
```

(Match the surrounding code's locking convention — if the block already runs under `h.mu`, drop the explicit Lock/Unlock; read the neighborhood first.)

- [ ] **Step 2: API schema + handler + column**

1. `apps/api/src/routes/agents/schemas.ts` — inside `heartbeatSchema`, after `isHeadless`:

```ts
  helperLifecycleMode: z.enum(['always-on', 'on-demand']).optional().catch(undefined),
```

2. `apps/api/src/db/schema/devices.ts` — after `agentVersion`:

```ts
  // Resolved helper spawn mode reported by the agent ("always-on" |
  // "on-demand"); on-demand marks RD Session Hosts, where the web UI offers
  // per-session targeting. Null for old agents / non-Windows.
  helperLifecycleMode: varchar('helper_lifecycle_mode', { length: 20 }),
```

3. `apps/api/src/routes/agents/heartbeat.ts` — in the `deviceUpdates` accumulation (near the `osVersion` handling, ~line 523):

```ts
  if (data.helperLifecycleMode && data.helperLifecycleMode !== device.helperLifecycleMode) {
    deviceUpdates.helperLifecycleMode = data.helperLifecycleMode;
  }
```

4. Create `apps/api/migrations/2026-07-28-device-helper-lifecycle-mode.sql`:

```sql
-- Resolved helper lifecycle mode reported by agents ("always-on" | "on-demand").
-- On-demand marks RD Session Hosts; the web UI keys session-targeting UX off it.
-- Nullable: old agents and non-Windows devices never report one.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS helper_lifecycle_mode varchar(20);
```

(devices is an existing tenant table — a new nullable column adds no RLS or cascade obligations.)

- [ ] **Step 3: Schema test**

Locate the heartbeat schema tests (`grep -rl "heartbeatSchema" apps/api/src --include='*.test.ts'`) and add:

```ts
it('accepts and passes through helperLifecycleMode', () => {
  const parsed = heartbeatSchema.parse({
    status: 'ok',
    agentVersion: '1.0.0',
    helperLifecycleMode: 'on-demand',
  });
  expect(parsed.helperLifecycleMode).toBe('on-demand');
});

it('drops an invalid helperLifecycleMode instead of failing the heartbeat', () => {
  const parsed = heartbeatSchema.parse({
    status: 'ok',
    agentVersion: '1.0.0',
    helperLifecycleMode: 'bogus',
  });
  expect(parsed.helperLifecycleMode).toBeUndefined();
});
```

(Adjust the minimal required fields to whatever the existing tests in that file use for a valid heartbeat.)

- [ ] **Step 4: Run tests + drift check**

Run: `cd agent && go test -race ./internal/heartbeat/... && GOOS=windows go build ./...`
Run: `pnpm test --filter=@breeze/api -- schemas` (or the specific test file found in Step 3)
Run: `export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm db:check-drift` — if no local Postgres is running, note it in the task report; drift will be validated in CI.
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/internal/heartbeat/heartbeat.go apps/api/src/routes/agents/schemas.ts apps/api/src/routes/agents/heartbeat.ts apps/api/src/db/schema/devices.ts apps/api/migrations/2026-07-28-device-helper-lifecycle-mode.sql
git add -A apps/api/src  # picks up the test file edit
git commit -m "feat(agent,api): report resolved helper lifecycle mode in heartbeat, store on device

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Full agent suite with race detection**

Run: `cd agent && go test -race ./...`
Expected: PASS

- [ ] **Step 2: Cross-compile all platforms**

Run: `cd agent && GOOS=windows go build ./... && GOOS=darwin go build ./... && GOOS=linux go build ./...`
Expected: three clean builds

- [ ] **Step 3: gofmt scoped to touched files**

Run: `cd agent && gofmt -l internal/sessionbroker internal/heartbeat internal/config internal/userhelper internal/ipc internal/agentapp`
Expected: no NEW files listed versus `git diff --name-only` for this plan (pre-existing drift in untouched files is out of scope)

- [ ] **Step 4: API tests for touched surface**

Run: `pnpm test --filter=@breeze/api -- agents` (heartbeat/schema suites)
Expected: PASS

- [ ] **Step 5: Push**

```bash
git status --short   # expect clean
git push
```
