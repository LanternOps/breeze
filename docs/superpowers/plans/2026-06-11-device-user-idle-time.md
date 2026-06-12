# Device User Idle Time Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Go agent measures real per-session user input idle time and the device detail overview shows it as a "User Idle" stat.

**Architecture:** The agent's existing session detector gains platform-specific idle measurement (Windows `WTSSessionInfoEx.LastInputTime` from the service, macOS `HIDIdleTime` via IOKit cgo, Linux `loginctl IdleSinceHint` best-effort). The collector populates the existing-but-hardcoded `idleMinutes` wire field, now a `*int` so unknown ≠ 0. API/DB plumbing already exists except two one-line route fixes. A new small React component renders the stat in the device detail overview strip.

**Tech Stack:** Go (agent, `golang.org/x/sys/windows`, cgo on darwin), Hono + Drizzle (API), React + Vitest (web).

**Spec:** `docs/superpowers/specs/2026-06-11-device-user-idle-time-design.md`

**Worktree note:** fresh worktrees need `pnpm install`, and pnpm/vitest need Node 22: prefix commands with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`.

**Before Task 1:** create the feature branch — `git checkout -b feat/device-user-idle-time` (all task commits land on it; Task 8 pushes it and opens the PR).

---

### Task 1: Pure idle helpers in sessionbroker (cross-platform, fully testable)

These helpers hold all the parseable/convertible logic so it can be tested on any dev OS (the platform detectors themselves only compile on their own GOOS).

**Files:**
- Create: `agent/internal/sessionbroker/idle.go`
- Create: `agent/internal/sessionbroker/idle_test.go`
- Modify: `agent/internal/sessionbroker/detector.go` (add idle fields to `DetectedSession`)

- [ ] **Step 1: Write the failing tests**

Create `agent/internal/sessionbroker/idle_test.go`:

```go
package sessionbroker

import (
	"testing"
	"time"
)

func TestFiletimeToTime(t *testing.T) {
	tests := []struct {
		name string
		ft   uint64
		want time.Time
	}{
		// Zero FILETIME means "no input recorded" (known console-session quirk);
		// must map to the zero time, never to 1601-01-01.
		{name: "zero_is_zero_time", ft: 0, want: time.Time{}},
		// 116444736000000000 = 100ns intervals between 1601-01-01 and 1970-01-01.
		{name: "unix_epoch", ft: 116444736000000000, want: time.Unix(0, 0).UTC()},
		// One second past the unix epoch (10_000_000 * 100ns = 1s).
		{name: "epoch_plus_1s", ft: 116444736000000000 + 10_000_000, want: time.Unix(1, 0).UTC()},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := filetimeToTime(tt.ft)
			if !got.Equal(tt.want) {
				t.Fatalf("filetimeToTime(%d) = %v, want %v", tt.ft, got, tt.want)
			}
		})
	}
}

func TestIdleSince(t *testing.T) {
	now := time.Date(2026, 6, 11, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name      string
		lastInput time.Time
		wantIdle  time.Duration
		wantKnown bool
	}{
		{name: "zero_last_input_is_unknown", lastInput: time.Time{}, wantIdle: 0, wantKnown: false},
		{name: "23_minutes_ago", lastInput: now.Add(-23 * time.Minute), wantIdle: 23 * time.Minute, wantKnown: true},
		{name: "future_input_clamps_to_zero", lastInput: now.Add(5 * time.Minute), wantIdle: 0, wantKnown: true},
		{name: "exactly_now", lastInput: now, wantIdle: 0, wantKnown: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			idle, known := idleSince(now, tt.lastInput)
			if idle != tt.wantIdle || known != tt.wantKnown {
				t.Fatalf("idleSince() = (%v, %v), want (%v, %v)", idle, known, tt.wantIdle, tt.wantKnown)
			}
		})
	}
}

func TestParseIdleSinceHint(t *testing.T) {
	tests := []struct {
		name   string
		value  string
		want   time.Time
		wantOK bool
	}{
		{name: "empty_is_unknown", value: "", wantOK: false},
		{name: "zero_is_unknown", value: "0", wantOK: false},
		// systemd usually prints the raw dbus value: microseconds since epoch.
		{name: "usec_integer", value: "1781265600000000", want: time.Unix(1781265600, 0).UTC(), wantOK: true},
		// Some loginctl versions print a formatted timestamp instead.
		{name: "formatted_timestamp", value: "Thu 2026-06-11 10:30:00 UTC",
			want: time.Date(2026, 6, 11, 10, 30, 0, 0, time.UTC), wantOK: true},
		{name: "garbage_is_unknown", value: "not-a-time", wantOK: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := parseIdleSinceHint(tt.value)
			if ok != tt.wantOK {
				t.Fatalf("parseIdleSinceHint(%q) ok = %v, want %v", tt.value, ok, tt.wantOK)
			}
			if ok && !got.Equal(tt.want) {
				t.Fatalf("parseIdleSinceHint(%q) = %v, want %v", tt.value, got, tt.want)
			}
		})
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/toddhebebrand/breeze/agent && go test -race ./internal/sessionbroker/ -run 'TestFiletimeToTime|TestIdleSince|TestParseIdleSinceHint' -v`
Expected: FAIL to build — `undefined: filetimeToTime` etc.

- [ ] **Step 3: Implement the helpers**

Create `agent/internal/sessionbroker/idle.go`:

```go
package sessionbroker

import (
	"strconv"
	"strings"
	"time"
)

// filetimeEpochDiff100ns is the number of 100ns intervals between the Windows
// FILETIME epoch (1601-01-01 UTC) and the Unix epoch (1970-01-01 UTC).
const filetimeEpochDiff100ns = 116444736000000000

// filetimeToTime converts a Windows FILETIME value (100ns intervals since
// 1601-01-01 UTC) to a time.Time. A zero FILETIME — which WTSSessionInfoEx
// reports for sessions with no recorded input, notably the physical console on
// some Windows versions — maps to the zero time so callers treat it as
// unknown rather than "idle since 1601".
func filetimeToTime(ft uint64) time.Time {
	if ft == 0 {
		return time.Time{}
	}
	return time.Unix(0, (int64(ft)-filetimeEpochDiff100ns)*100).UTC()
}

// idleSince computes how long a session has been idle given the current wall
// clock and the time of last user input. known=false means no idle data —
// callers must never conflate that with "0 minutes idle".
func idleSince(now, lastInput time.Time) (idle time.Duration, known bool) {
	if lastInput.IsZero() {
		return 0, false
	}
	d := now.Sub(lastInput)
	if d < 0 {
		d = 0
	}
	return d, true
}

// parseIdleSinceHint parses loginctl's IdleSinceHint property, which systemd
// prints either as raw microseconds since the Unix epoch or, in some
// versions, as a formatted timestamp.
func parseIdleSinceHint(value string) (time.Time, bool) {
	value = strings.TrimSpace(value)
	if value == "" || value == "0" {
		return time.Time{}, false
	}
	if usec, err := strconv.ParseUint(value, 10, 64); err == nil {
		return time.Unix(0, int64(usec)*1000).UTC(), true
	}
	if t, err := time.Parse("Mon 2006-01-02 15:04:05 MST", value); err == nil {
		return t, true
	}
	return time.Time{}, false
}
```

In `agent/internal/sessionbroker/detector.go`, extend `DetectedSession` (the `json:"-"` tags keep these off the IPC/helper wire — they only feed the collector in-process):

```go
// DetectedSession is a snapshot of a currently logged-in session.
type DetectedSession struct {
	UID      uint32 `json:"uid"`
	Username string `json:"username"`
	Session  string `json:"session"`
	IsRemote bool   `json:"isRemote"`
	Display  string `json:"display,omitempty"`
	Seat     string `json:"seat,omitempty"`
	State    string `json:"state,omitempty"` // "active", "online", "closing"
	Type     string `json:"type,omitempty"`  // "console", "rdp", "services"

	// IdleFor is how long the session has gone without user input. Only
	// meaningful when IdleKnown is true; platforms that cannot measure input
	// idle (or fail to) leave IdleKnown false.
	IdleFor   time.Duration `json:"-"`
	IdleKnown bool          `json:"-"`
}
```

Add `"time"` to detector.go's imports (currently only `"context"`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/toddhebebrand/breeze/agent && go test -race ./internal/sessionbroker/ -run 'TestFiletimeToTime|TestIdleSince|TestParseIdleSinceHint' -v`
Expected: PASS (all subtests)

- [ ] **Step 5: Commit**

```bash
cd /Users/toddhebebrand/breeze
git add agent/internal/sessionbroker/idle.go agent/internal/sessionbroker/idle_test.go agent/internal/sessionbroker/detector.go
git commit -m "feat(agent): add idle-time helpers and DetectedSession idle fields"
```

---

### Task 2: Windows — read LastInputTime via WTSSessionInfoEx

The agent service runs in Session 0 and cannot call `GetLastInputInfo` (per-session API). `WTSQuerySessionInformationW` with info class `WTSSessionInfoEx` (25) returns a `WTSINFOEX` whose `LastInputTime` is a FILETIME — callable from Session 0 for any session. No unit test (windows-only code; CI runs ubuntu); verified by cross-compile here and on the real Windows device in Task 8.

**Files:**
- Modify: `agent/internal/sessionbroker/detector_windows.go`

- [ ] **Step 1: Add the WTSINFOEX structs and query helper**

In `detector_windows.go`, extend the consts block:

```go
const (
	wtsCurrentServerHandle = 0
	wtsConnectState        = 4 // WTSInfoClass: WTSConnectState
	wtsUserName            = 5
	wtsDomainName          = 7
	wtsClientProtocolType  = 16
	wtsSessionInfoEx       = 25 // WTSInfoClass: WTSSessionInfoEx

	wtsDisconnected = 4 // WTS_CONNECTSTATE_CLASS: WTSDisconnected
)
```

Add below `wtsSessionInfo`:

```go
// wtsInfoExLevel1 mirrors WTSINFOEX_LEVEL1_W from wtsapi32.h. Field order and
// the explicit padding before LogonTime must match the C layout exactly:
// 12 bytes of DWORDs + 72 UTF-16 chars (144 bytes) = 156, padded to 160 so the
// LARGE_INTEGER block is 8-aligned.
type wtsInfoExLevel1 struct {
	SessionID               uint32
	SessionState            int32
	SessionFlags            int32
	WinStationName          [33]uint16
	UserName                [21]uint16
	DomainName              [18]uint16
	_                       [4]byte
	LogonTime               int64
	ConnectTime             int64
	DisconnectTime          int64
	LastInputTime           int64 // FILETIME; 0 = no input recorded
	CurrentTime             int64
	IncomingBytes           uint32
	OutgoingBytes           uint32
	IncomingFrames          uint32
	OutgoingFrames          uint32
	IncomingCompressedBytes uint32
	OutgoingCompressedBytes uint32
}

// wtsInfoEx mirrors WTSINFOEXW: a DWORD level then a union whose only level-1
// member is 8-aligned, so Data sits at offset 8.
type wtsInfoEx struct {
	Level uint32
	_     [4]byte
	Data  wtsInfoExLevel1
}

// querySessionLastInput returns the time of last user input for a session via
// WTSSessionInfoEx. ok=false when the query fails or returns a short/unknown
// payload. A zero LastInputTime yields the zero time (treated as unknown by
// idleSince) — this is the documented console-session quirk.
func (d *windowsDetector) querySessionLastInput(sessionID uint32) (time.Time, bool) {
	var buf *wtsInfoEx
	var bytesReturned uint32

	r1, _, _ := procWTSQuerySessionInfo.Call(
		wtsCurrentServerHandle,
		uintptr(sessionID),
		wtsSessionInfoEx,
		uintptr(unsafe.Pointer(&buf)),
		uintptr(unsafe.Pointer(&bytesReturned)),
	)
	if r1 == 0 || buf == nil {
		return time.Time{}, false
	}
	defer procWTSFreeMemory.Call(uintptr(unsafe.Pointer(buf)))

	if uintptr(bytesReturned) < unsafe.Sizeof(wtsInfoEx{}) || buf.Level != 1 {
		return time.Time{}, false
	}
	return filetimeToTime(uint64(buf.Data.LastInputTime)), true
}
```

- [ ] **Step 2: Wire it into ListSessions**

In `ListSessions`, after the `sessionType` is determined and before the `session := DetectedSession{...}` literal, no change; instead, immediately after the literal (before the sanitize block), add:

```go
		if sessionType != "services" {
			if lastInput, ok := d.querySessionLastInput(info.SessionID); ok {
				session.IdleFor, session.IdleKnown = idleSince(time.Now(), lastInput)
			}
		}
```

- [ ] **Step 3: Cross-compile to verify it builds**

Run: `cd /Users/toddhebebrand/breeze/agent && GOOS=windows GOARCH=amd64 go build ./... && go vet ./internal/sessionbroker/`
Expected: clean build, no vet errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/toddhebebrand/breeze
git add agent/internal/sessionbroker/detector_windows.go
git commit -m "feat(agent): measure Windows session idle via WTSSessionInfoEx LastInputTime"
```

---

### Task 3: macOS — HIDIdleTime via IOKit (cgo path)

System-wide HID idle from the `IOHIDSystem` IORegistry entry, readable by the root daemon without being in the user session. Applied to the console session (the only kind the darwin detector reports). The `!cgo` fallback (`detector_darwin_nocgo.go`) intentionally leaves idle unknown — do not touch it.

**Files:**
- Modify: `agent/internal/sessionbroker/detector_darwin.go`
- Create: `agent/internal/sessionbroker/detector_darwin_idle_test.go`

- [ ] **Step 1: Write the failing test**

Create `agent/internal/sessionbroker/detector_darwin_idle_test.go` (runs on local macOS dev machines; CI is ubuntu so it never runs there):

```go
//go:build darwin && cgo

package sessionbroker

import "testing"

// TestDarwinIdleKnown asserts that when a console user is present, the darwin
// detector reports a known, non-negative idle duration from HIDIdleTime.
func TestDarwinIdleKnown(t *testing.T) {
	sessions, err := NewSessionDetector().ListSessions()
	if err != nil {
		t.Fatalf("ListSessions: %v", err)
	}
	if len(sessions) == 0 {
		t.Skip("no console user logged in")
	}
	s := sessions[0]
	if !s.IdleKnown {
		t.Fatal("expected IdleKnown=true for console session on darwin cgo build")
	}
	if s.IdleFor < 0 {
		t.Fatalf("expected non-negative idle, got %v", s.IdleFor)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/toddhebebrand/breeze/agent && go test -race ./internal/sessionbroker/ -run TestDarwinIdleKnown -v`
Expected: FAIL — `expected IdleKnown=true for console session on darwin cgo build` (or Skip if no console user — if it skips, proceed; the assertion is re-checked in Task 8 manual verification).

- [ ] **Step 3: Implement HIDIdleTime read**

In `detector_darwin.go`, replace the cgo preamble's LDFLAGS line and add the IOKit include + helper:

```c
#cgo LDFLAGS: -framework SystemConfiguration -framework CoreFoundation -framework IOKit
#include <SystemConfiguration/SystemConfiguration.h>
#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/IOKitLib.h>

// getConsoleUser returns the current console user's username and UID.
static int getConsoleUser(char *buf, int bufsize, unsigned int *uid) {
    CFStringRef username = SCDynamicStoreCopyConsoleUser(NULL, (uid_t *)uid, NULL);
    if (username == NULL) return 0;
    Boolean ok = CFStringGetCString(username, buf, bufsize, kCFStringEncodingUTF8);
    CFRelease(username);
    return ok ? 1 : 0;
}

// getHIDIdleNanos reads the system-wide HID idle time (nanoseconds since last
// keyboard/mouse input) from the IOHIDSystem registry entry. Returns 0 on
// failure, 1 on success. Passing 0 as the master port targets the default
// port on all supported macOS versions.
static int getHIDIdleNanos(long long *ns) {
    io_service_t svc = IOServiceGetMatchingService(0, IOServiceMatching("IOHIDSystem"));
    if (!svc) return 0;
    CFTypeRef prop = IORegistryEntryCreateCFProperty(svc, CFSTR("HIDIdleTime"), kCFAllocatorDefault, 0);
    IOObjectRelease(svc);
    if (!prop) return 0;
    int ok = 0;
    if (CFGetTypeID(prop) == CFNumberGetTypeID()) {
        ok = CFNumberGetValue((CFNumberRef)prop, kCFNumberSInt64Type, ns);
    }
    CFRelease(prop);
    return ok;
}
```

In `ListSessions`, after the `session, err := sanitizeDetectedSession(...)` block succeeds and before `return []DetectedSession{session}, nil`, add:

```go
	var idleNs C.longlong
	if C.getHIDIdleNanos(&idleNs) != 0 && idleNs >= 0 {
		session.IdleFor = time.Duration(idleNs)
		session.IdleKnown = true
	}
```

(`time` is already imported in this file.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/toddhebebrand/breeze/agent && go test -race ./internal/sessionbroker/ -run TestDarwinIdleKnown -v`
Expected: PASS (you are logged in at the console of your dev Mac).

- [ ] **Step 5: Commit**

```bash
cd /Users/toddhebebrand/breeze
git add agent/internal/sessionbroker/detector_darwin.go agent/internal/sessionbroker/detector_darwin_idle_test.go
git commit -m "feat(agent): measure macOS console idle via IOHIDSystem HIDIdleTime"
```

---

### Task 4: Linux — loginctl IdleHint/IdleSinceHint (best-effort)

Only reports idle when the desktop environment actively sets `IdleHint=yes`; `IdleHint=no` stays **unknown** (many DEs and all headless sessions never set the hint, so "no" cannot be distinguished from "nobody reports it" — treating it as active would show a false "Active").

**Files:**
- Modify: `agent/internal/sessionbroker/detector_linux.go`

- [ ] **Step 1: Extend the property query and parse**

In `detector_linux.go` `ListSessions`, change the `show-session` property list:

```go
			propOut, propErr := exec.CommandContext(propCtx, "loginctl", "show-session", sessionID,
				"--property=Type,Remote,Display,Seat,State,IdleHint,IdleSinceHint").Output()
```

Above the property scan loop (just after `if propErr == nil {`), declare:

```go
			var idleHint bool
			var idleSinceRaw string
```

Add two cases to the `switch parts[0]` block:

```go
				case "IdleHint":
					idleHint = parts[1] == "yes"
				case "IdleSinceHint":
					idleSinceRaw = parts[1]
```

After the property scan loop's error check (still inside `if propErr == nil`, before the closing brace), add:

```go
			if idleHint {
				if since, ok := parseIdleSinceHint(idleSinceRaw); ok {
					sess.IdleFor, sess.IdleKnown = idleSince(time.Now(), since)
				}
			}
```

- [ ] **Step 2: Cross-compile and run package tests**

Run: `cd /Users/toddhebebrand/breeze/agent && GOOS=linux GOARCH=amd64 go build ./... && go test -race ./internal/sessionbroker/`
Expected: clean build; existing + Task 1 tests PASS (linux detector code itself doesn't compile on darwin — the build check covers it; `parseIdleSinceHint` is covered by Task 1's tests).

- [ ] **Step 3: Commit**

```bash
cd /Users/toddhebebrand/breeze
git add agent/internal/sessionbroker/detector_linux.go
git commit -m "feat(agent): best-effort Linux session idle via loginctl IdleSinceHint"
```

---

### Task 5: Collector — populate IdleMinutes as *int, fix LastActivityAt

`UserSession.IdleMinutes` becomes `*int` so "measured 0" serializes as `0` while "unknown" is omitted (with plain `int`+`omitempty` they're indistinguishable, and old agents' omission must read as unknown). `LastActivityAt` becomes `now − idle` when idle is known instead of always `now`.

**Files:**
- Modify: `agent/internal/collectors/sessions.go`
- Modify: `agent/internal/collectors/sessions_test.go`

- [ ] **Step 1: Write the failing tests**

Append to `agent/internal/collectors/sessions_test.go`:

```go
type fakeDetector struct {
	sessions []sessionbroker.DetectedSession
}

func (f *fakeDetector) ListSessions() ([]sessionbroker.DetectedSession, error) {
	return f.sessions, nil
}

func (f *fakeDetector) WatchSessions(ctx context.Context) <-chan sessionbroker.SessionEvent {
	ch := make(chan sessionbroker.SessionEvent)
	close(ch)
	return ch
}

func TestRefreshSessionsIdleMinutes(t *testing.T) {
	now := time.Date(2026, 6, 11, 12, 0, 0, 0, time.UTC)
	c := &SessionCollector{
		detector: &fakeDetector{sessions: []sessionbroker.DetectedSession{
			{Username: "alice", Session: "2", State: "active", IdleFor: 23 * time.Minute, IdleKnown: true},
			{Username: "bob", Session: "3", State: "active"}, // idle unknown
			{Username: "carol", Session: "4", State: "active", IdleFor: 30 * 24 * time.Hour, IdleKnown: true}, // clamps
		}},
		sessions: make(map[string]UserSession),
	}

	c.refreshSessions(now)

	byUser := make(map[string]UserSession)
	for _, s := range c.sessions {
		byUser[s.Username] = s
	}

	alice := byUser["alice"]
	if alice.IdleMinutes == nil || *alice.IdleMinutes != 23 {
		t.Fatalf("alice IdleMinutes = %v, want 23", alice.IdleMinutes)
	}
	if !alice.LastActivityAt.Equal(now.Add(-23 * time.Minute)) {
		t.Fatalf("alice LastActivityAt = %v, want %v", alice.LastActivityAt, now.Add(-23*time.Minute))
	}

	bob := byUser["bob"]
	if bob.IdleMinutes != nil {
		t.Fatalf("bob IdleMinutes = %v, want nil (unknown)", *bob.IdleMinutes)
	}
	if !bob.LastActivityAt.Equal(now) {
		t.Fatalf("bob LastActivityAt = %v, want %v", bob.LastActivityAt, now)
	}

	carol := byUser["carol"]
	if carol.IdleMinutes == nil || *carol.IdleMinutes != 10080 {
		t.Fatalf("carol IdleMinutes = %v, want 10080 (clamped)", carol.IdleMinutes)
	}
}

func TestUserSessionIdleMinutesJSON(t *testing.T) {
	zero := 0
	withZero, err := json.Marshal(UserSession{Username: "a", SessionType: "console", IdleMinutes: &zero})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(withZero), `"idleMinutes":0`) {
		t.Fatalf("measured-zero idle must serialize explicitly, got %s", withZero)
	}

	unknown, err := json.Marshal(UserSession{Username: "a", SessionType: "console"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(unknown), "idleMinutes") {
		t.Fatalf("unknown idle must be omitted from the wire, got %s", unknown)
	}
}
```

Add to the test file's imports: `"context"`, `"encoding/json"`, `"strings"`, `"time"` (keep existing `"testing"` and `sessionbroker` imports).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/toddhebebrand/breeze/agent && go test -race ./internal/collectors/ -run 'TestRefreshSessionsIdleMinutes|TestUserSessionIdleMinutesJSON' -v`
Expected: FAIL to build — `cannot use &zero (value of type *int) as int value` (field is still `int`).

- [ ] **Step 3: Implement**

In `agent/internal/collectors/sessions.go`:

Change the struct field:

```go
	IdleMinutes             *int      `json:"idleMinutes,omitempty"`
```

Add near the consts:

```go
const maxIdleMinutes = 10080 // submitSessionsSchema caps idleMinutes at 7 days
```

Add a helper (below `refreshSessions`):

```go
// idleFields converts a detected session's idle measurement into the wire
// representation: a nil pointer when unknown (so old agents and unmeasurable
// platforms read as "no data", never "0 minutes"), and a LastActivityAt
// anchored to the actual last input rather than the refresh tick.
func idleFields(detected sessionbroker.DetectedSession, now time.Time) (*int, time.Time) {
	if !detected.IdleKnown {
		return nil, now
	}
	minutes := int(detected.IdleFor / time.Minute)
	if minutes < 0 {
		minutes = 0
	}
	if minutes > maxIdleMinutes {
		minutes = maxIdleMinutes
	}
	return &minutes, now.Add(-detected.IdleFor)
}
```

In `refreshSessions`, replace the session literal:

```go
		idleMinutes, lastActivityAt := idleFields(detected, now)
		next[key] = UserSession{
			Username:       detected.Username,
			SessionType:    inferSessionType(detected),
			SessionID:      detected.Session,
			LoginAt:        loginAt,
			IdleMinutes:    idleMinutes,
			ActivityState:  mapDetectedState(detected.State),
			IsActive:       true,
			LastActivityAt: lastActivityAt,
		}
```

In `applyEvent`'s `SessionLogin` case, drop the `IdleMinutes: 0,` line entirely (nil = unknown until the next refresh measures it):

```go
		c.sessions[key] = UserSession{
			Username:       event.Username,
			SessionType:    sessionType,
			SessionID:      event.Session,
			LoginAt:        loginAt,
			ActivityState:  "active",
			IsActive:       true,
			LastActivityAt: now,
		}
```

- [ ] **Step 4: Run the full agent test suite**

Run: `cd /Users/toddhebebrand/breeze/agent && go test -race ./internal/collectors/ ./internal/sessionbroker/ ./internal/heartbeat/`
Expected: PASS (heartbeat marshals `UserSession` as-is, so the type change is wire-compatible; this run proves nothing else referenced the field as `int`).

- [ ] **Step 5: Commit**

```bash
cd /Users/toddhebebrand/breeze
git add agent/internal/collectors/sessions.go agent/internal/collectors/sessions_test.go
git commit -m "feat(agent): populate session idleMinutes from detector, fix lastActivityAt"
```

---

### Task 6: API — preserve null idleMinutes, expose updatedAt

Two one-line route fixes plus a new route test (the ingestion route currently has none).

**Files:**
- Modify: `apps/api/src/routes/agents/sessions.ts:98,111`
- Modify: `apps/api/src/routes/devices/sessions.ts` (active select)
- Create: `apps/api/src/routes/agents/sessions.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/agents/sessions.test.ts` (mock pattern mirrors `connections.test.ts`; `./helpers` is mocked because the real module pulls in `db` and dozens of schema tables):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const AGENT_ID = 'agent-001';
const DEVICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock('../../db/schema', () => ({
  devices: { id: 'id', agentId: 'agent_id', orgId: 'org_id', hostname: 'hostname' },
  deviceSessions: {
    id: 'id',
    orgId: 'org_id',
    deviceId: 'device_id',
    username: 'username',
    sessionType: 'session_type',
    osSessionId: 'os_session_id',
    loginAt: 'login_at',
    logoutAt: 'logout_at',
    durationSeconds: 'duration_seconds',
    idleMinutes: 'idle_minutes',
    activityState: 'activity_state',
    loginPerformanceSeconds: 'login_performance_seconds',
    isActive: 'is_active',
    lastActivityAt: 'last_activity_at',
    updatedAt: 'updated_at',
  },
}));

vi.mock('../../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
}));

vi.mock('../../services/eventBus', () => ({
  publishEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../middleware/requireAgentRole', () => ({
  requireAgentRole: vi.fn((_c: unknown, next: () => Promise<void>) => next()),
}));

vi.mock('./helpers', () => ({
  sanitizeTimestamp: vi.fn((value: string | undefined) => (value ? new Date(value) : null)),
}));

import { db } from '../../db';
import { sessionsRoutes } from './sessions';

function mockDeviceLookup() {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([{ id: DEVICE_ID, orgId: 'org-1', hostname: 'host-1' }]),
      }),
    }),
  } as any);
}

describe('PUT /agents/:id/sessions', () => {
  let app: Hono;
  let insertedValues: any[];

  beforeEach(() => {
    vi.clearAllMocks();
    insertedValues = [];
    app = new Hono();
    app.route('/agents', sessionsRoutes);

    vi.mocked(db.transaction).mockImplementation(async (fn: any) => {
      const tx = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]), // no existing active sessions
          }),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockImplementation((vals: any) => {
            insertedValues.push(vals);
            return Promise.resolve(undefined);
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      };
      return fn(tx);
    });
  });

  it('stores null idleMinutes when the agent omits it (unknown ≠ 0)', async () => {
    mockDeviceLookup();

    const res = await app.request(`/agents/${AGENT_ID}/sessions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessions: [{ username: 'alice', sessionType: 'console', isActive: true }],
        events: [],
      }),
    });

    expect(res.status).toBe(200);
    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0].idleMinutes).toBeNull();
  });

  it('stores explicit idleMinutes 0 as 0 (measured active)', async () => {
    mockDeviceLookup();

    const res = await app.request(`/agents/${AGENT_ID}/sessions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessions: [{ username: 'alice', sessionType: 'console', isActive: true, idleMinutes: 0 }],
        events: [],
      }),
    });

    expect(res.status).toBe(200);
    expect(insertedValues).toHaveLength(1);
    expect(insertedValues[0].idleMinutes).toBe(0);
  });

  it('stores measured idleMinutes as provided', async () => {
    mockDeviceLookup();

    const res = await app.request(`/agents/${AGENT_ID}/sessions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessions: [{ username: 'alice', sessionType: 'console', isActive: true, idleMinutes: 23 }],
        events: [],
      }),
    });

    expect(res.status).toBe(200);
    expect(insertedValues[0].idleMinutes).toBe(23);
  });
});
```

(The handler ends with `return c.json({ success: true, ... })` — HTTP 200 — and calls `writeAuditEvent` unconditionally plus `publishEvent` only for login/logout events, so the mocks above are exactly sufficient with an empty `events` array.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/agents/sessions.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: FAIL — first test asserts `idleMinutes` to be null but receives `0` (the `?? 0` coercion). Tests 2 and 3 PASS.

- [ ] **Step 3: Fix the routes**

In `apps/api/src/routes/agents/sessions.ts`, both the insert (line ~98) and update (line ~111) blocks:

```typescript
          idleMinutes: session.idleMinutes ?? null,
```

In `apps/api/src/routes/devices/sessions.ts`, the `/:id/sessions/active` select (after `lastActivityAt`):

```typescript
        lastActivityAt: deviceSessions.lastActivityAt,
        updatedAt: deviceSessions.updatedAt,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/toddhebebrand/breeze/apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/agents/sessions.test.ts src/routes/devices/core.permissions.test.ts --pool=forks --poolOptions.forks.singleFork=true`
Expected: PASS (core.permissions covers the devices sessions routes' auth and catches select-shape breakage). Note: do NOT run the full API suite to judge this change — it has known parallel-run flakiness; affected files single-fork is the verification standard, CI is the arbiter.

- [ ] **Step 5: Commit**

```bash
cd /Users/toddhebebrand/breeze
git add apps/api/src/routes/agents/sessions.ts apps/api/src/routes/agents/sessions.test.ts apps/api/src/routes/devices/sessions.ts
git commit -m "fix(api): preserve null idleMinutes on session ingest, expose updatedAt on active sessions"
```

---

### Task 7: Web — User Idle stat on device detail overview

A small self-contained component with exported pure helpers (testable without DOM fixtures), rendered in the overview stat strip next to Logged-in User.

**Files:**
- Create: `apps/web/src/components/devices/DeviceUserIdleStat.tsx`
- Create: `apps/web/src/components/devices/DeviceUserIdleStat.test.tsx`
- Modify: `apps/web/src/components/devices/DeviceDetails.tsx` (import + one render line)

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/devices/DeviceUserIdleStat.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import DeviceUserIdleStat, { selectIdleSession, formatIdle, type ActiveSession } from './DeviceUserIdleStat';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

import { fetchWithAuth } from '../../stores/auth';

function session(overrides: Partial<ActiveSession>): ActiveSession {
  return {
    id: 's-1',
    username: 'alice',
    sessionType: 'console',
    osSessionId: '2',
    loginAt: '2026-06-11T08:00:00Z',
    idleMinutes: null,
    activityState: 'active',
    lastActivityAt: null,
    updatedAt: '2026-06-11T12:00:00Z',
    ...overrides,
  };
}

describe('selectIdleSession', () => {
  it('returns null for no sessions', () => {
    expect(selectIdleSession([])).toBeNull();
  });

  it('prefers the console session over less-idle remote sessions', () => {
    const console_ = session({ id: 'c', sessionType: 'console', idleMinutes: 60 });
    const rdp = session({ id: 'r', sessionType: 'rdp', idleMinutes: 1 });
    expect(selectIdleSession([rdp, console_])?.id).toBe('c');
  });

  it('falls back to the least-idle session when no console session exists', () => {
    const a = session({ id: 'a', sessionType: 'rdp', idleMinutes: 45 });
    const b = session({ id: 'b', sessionType: 'ssh', idleMinutes: 5 });
    expect(selectIdleSession([a, b])?.id).toBe('b');
  });
});

describe('formatIdle', () => {
  it('shows em dash for no session', () => {
    expect(formatIdle(null)).toBe('—');
  });

  it('shows Locked for locked sessions regardless of idle', () => {
    expect(formatIdle(session({ activityState: 'locked', idleMinutes: 42 }))).toBe('Locked');
  });

  it('shows em dash when idle is unknown', () => {
    expect(formatIdle(session({ idleMinutes: null }))).toBe('—');
  });

  it('shows Active for under a minute', () => {
    expect(formatIdle(session({ idleMinutes: 0 }))).toBe('Active');
  });

  it('formats minutes', () => {
    expect(formatIdle(session({ idleMinutes: 23 }))).toBe('23m');
  });

  it('formats hours and minutes', () => {
    expect(formatIdle(session({ idleMinutes: 65 }))).toBe('1h 5m');
  });
});

describe('DeviceUserIdleStat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the idle duration from the active sessions endpoint', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { activeUsers: [session({ idleMinutes: 23 })], count: 1 } }),
    } as Response);

    render(<DeviceUserIdleStat deviceId="dev-1" />);

    await waitFor(() => expect(screen.getByText('23m')).toBeTruthy());
    expect(vi.mocked(fetchWithAuth)).toHaveBeenCalledWith('/devices/dev-1/sessions/active');
  });

  it('renders em dash when the fetch fails', async () => {
    vi.mocked(fetchWithAuth).mockRejectedValue(new Error('network'));

    render(<DeviceUserIdleStat deviceId="dev-1" />);

    await waitFor(() => expect(screen.getByText('—')).toBeTruthy());
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/toddhebebrand/breeze/apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/devices/DeviceUserIdleStat.test.tsx`
Expected: FAIL — cannot resolve `./DeviceUserIdleStat`.

- [ ] **Step 3: Implement the component**

Create `apps/web/src/components/devices/DeviceUserIdleStat.tsx`:

```tsx
import { useState, useEffect } from 'react';
import { Timer } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

export type ActiveSession = {
  id: string;
  username: string;
  sessionType: 'console' | 'rdp' | 'ssh' | 'other' | null;
  osSessionId: string | null;
  loginAt: string | null;
  idleMinutes: number | null;
  activityState: 'active' | 'idle' | 'locked' | 'away' | 'disconnected' | null;
  lastActivityAt: string | null;
  updatedAt: string | null;
};

// The session that best represents "the user at this device": the console
// session when present, otherwise the least-idle active session.
export function selectIdleSession(sessions: ActiveSession[]): ActiveSession | null {
  if (sessions.length === 0) return null;
  const consoleSession = sessions.find((s) => s.sessionType === 'console');
  if (consoleSession) return consoleSession;
  return [...sessions].sort(
    (a, b) => (a.idleMinutes ?? Number.POSITIVE_INFINITY) - (b.idleMinutes ?? Number.POSITIVE_INFINITY)
  )[0];
}

export function formatIdle(session: ActiveSession | null): string {
  if (!session) return '—';
  if (session.activityState === 'locked') return 'Locked';
  if (session.idleMinutes === null || session.idleMinutes === undefined) return '—';
  if (session.idleMinutes < 1) return 'Active';
  const hours = Math.floor(session.idleMinutes / 60);
  const minutes = session.idleMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function tooltip(sessions: ActiveSession[]): string | undefined {
  if (sessions.length === 0) return undefined;
  const lines = sessions.map(
    (s) => `${s.username} (${s.sessionType ?? 'unknown'}): ${formatIdle(s)}`
  );
  const updatedAt = sessions
    .map((s) => s.updatedAt)
    .filter(Boolean)
    .sort()
    .pop();
  if (updatedAt) {
    const d = new Date(updatedAt);
    if (!isNaN(d.getTime())) {
      lines.push(`As of ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
    }
  }
  return lines.join('\n');
}

type DeviceUserIdleStatProps = {
  deviceId: string;
};

export default function DeviceUserIdleStat({ deviceId }: DeviceUserIdleStatProps) {
  const [sessions, setSessions] = useState<ActiveSession[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithAuth(`/devices/${deviceId}/sessions/active`);
        if (!res.ok) return;
        const body = await res.json();
        if (!cancelled) setSessions(body?.data?.activeUsers ?? []);
      } catch {
        // Read-only stat: on failure leave the em-dash placeholder.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deviceId]);

  const selected = selectIdleSession(sessions);

  return (
    <div>
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Timer className="h-3.5 w-3.5" />
        User Idle
      </div>
      <p className="mt-1 text-lg font-semibold" title={tooltip(sessions)}>
        {formatIdle(selected)}
      </p>
    </div>
  );
}
```

In `apps/web/src/components/devices/DeviceDetails.tsx`:

Add to the component imports (after the `DeviceWarrantyCard` import):

```tsx
import DeviceUserIdleStat from './DeviceUserIdleStat';
```

In the overview stat strip, after the Logged-in User `<div>...</div>` block (the one ending with `{device.lastUser || '—'}</p>` around line 290), add:

```tsx
              <DeviceUserIdleStat deviceId={device.id} />
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/toddhebebrand/breeze/apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/devices/DeviceUserIdleStat.test.tsx`
Expected: PASS (all tests).

- [ ] **Step 5: Type-check the web app**

Run: `cd /Users/toddhebebrand/breeze/apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit`
Expected: no new errors (compare against a pre-change run if anything appears).

- [ ] **Step 6: Commit**

```bash
cd /Users/toddhebebrand/breeze
git add apps/web/src/components/devices/DeviceUserIdleStat.tsx apps/web/src/components/devices/DeviceUserIdleStat.test.tsx apps/web/src/components/devices/DeviceDetails.tsx
git commit -m "feat(web): show user idle time on device detail overview"
```

---

### Task 8: Verification, Windows risk checkpoint, PR

- [ ] **Step 1: Full agent test run + cross-compiles**

```bash
cd /Users/toddhebebrand/breeze/agent
go test -race ./...
GOOS=windows GOARCH=amd64 go build ./...
GOOS=linux GOARCH=amd64 go build ./...
CGO_ENABLED=0 go build ./...   # exercises the darwin nocgo detector path
```
Expected: all PASS / clean builds.

- [ ] **Step 2: Affected web/API tests once more, single-fork**

```bash
cd /Users/toddhebebrand/breeze
(cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/routes/agents/sessions.test.ts --pool=forks --poolOptions.forks.singleFork=true)
(cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/devices/DeviceUserIdleStat.test.tsx)
```
Expected: PASS. (Do not gate on a full local API suite run — known parallel flakiness; CI is the arbiter.)

- [ ] **Step 3: Windows console-session risk checkpoint (spec's single platform risk)**

Build and push the agent to the e2e Windows device (`E2E_WINDOWS_DEVICE_ID` in `.env`), let one session refresh elapse (≤5 min), then check the stored value from local Postgres:

```bash
docker exec -i breeze-postgres psql -U breeze -d breeze -c \
  "SELECT username, session_type, idle_minutes, activity_state, last_activity_at, updated_at \
   FROM device_sessions WHERE is_active = true ORDER BY updated_at DESC LIMIT 5;"
```

Expected: the Windows console session row has non-null `idle_minutes` that increases while the device is untouched. **If `idle_minutes` stays null for the console session**, the WTS `LastInputTime` quirk is real on this hardware — record the finding in the spec and file the helper-IPC fallback as a follow-up issue; the feature still ships (UI shows "—" for affected sessions, real values for RDP/macOS/Linux-with-DE).

Also verify the UI: open the device detail page for the Windows device and for the macOS device, confirm the "User Idle" stat shows a real duration (macOS should work via HIDIdleTime), goes to "Active" right after wiggling the mouse (after the next 5-minute refresh), and shows "Locked" when the machine is locked.

- [ ] **Step 4: Create the PR**

```bash
cd /Users/toddhebebrand/breeze
git checkout -b feat/device-user-idle-time   # if not already on a branch — do this BEFORE Task 1 ideally
git push -u origin feat/device-user-idle-time
gh pr create --title "feat: show real user idle time on device detail" --body "$(cat <<'EOF'
**What:** Device detail overview now shows a "User Idle" stat next to Logged-in User, backed by real agent-side idle measurement.

**Why:** Session tracking shipped the `idleMinutes` plumbing end-to-end in Feb 2026, but the agent hardcoded it to 0 and no UI displayed it.

**How:**
- Agent: Windows `WTSSessionInfoEx.LastInputTime` (callable from Session 0), macOS `HIDIdleTime` via IOKit, Linux `loginctl IdleSinceHint` best-effort; `UserSession.IdleMinutes` is now `*int` so unknown ≠ 0
- API: `?? 0` → `?? null` on session ingest (2 lines), `updatedAt` added to the active-sessions response (1 line)
- Web: new `DeviceUserIdleStat` component in the overview stat strip

Spec: `docs/superpowers/specs/2026-06-11-device-user-idle-time-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Note: requires an agent release to produce real data in production; old agents render as "—".
