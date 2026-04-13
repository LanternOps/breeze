# MSI Enrollment Failure Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix issue #411 — MSI installs no longer roll back with a cryptic 1603 when enrollment is missing or fails. Bad-creds installs fail loudly with a human-readable cause written to four sinks (msiexec install.log, agent.log, `enroll-last-error.txt`, Windows Event Log). No-creds installs succeed; the service starts into a wait-for-enrollment loop so imaged/sysprep'd deployments work.

**Architecture:** On the Go side, split `startAgent` so the caller decides whether to wait. Add a cross-platform `waitForEnrollment(ctx, cfgFile)` helper gated on a complete `config.IsEnrolled(cfg)` check (both AgentID AND AuthToken, to survive torn `SaveTo` writes). The Windows service wrapper forks on enrollment state: enrolled → synchronous start (preserves today's "bad mTLS init fails the install" guarantee), unenrolled → signal `Running` immediately, wait, then start. Three package-level function vars (`startAgentFn`, `waitForEnrollmentFn`, `runServiceLoopFn`) act as test seams so Windows-gated tests can verify state-transition ordering without constructing real `heartbeat.Heartbeat` + `websocket.Client` fixtures. Enrollment failures route through a new `enrollError(cat, friendly, err)` helper that writes stderr + agent.log + `enroll-last-error.txt` + Event Log in one call and exits with a category-specific code. The MSI custom action is changed from `Return="ignore"` to `Return="check"` so bad-creds attempts cleanly roll back with a discoverable error trail; no-creds attempts skip the CA entirely and the install succeeds.

**Tech Stack:** Go 1.25.x (cobra + slog via `internal/logging`, `golang.org/x/sys/windows/svc/eventlog`), WiX Toolset v4 (`breeze.wxs`), Go standard `testing` + `t.Cleanup` for seams.

**Target release:** v0.63.x (not a hotfix).

**Spec:** `docs/superpowers/specs/2026-04-13-msi-enrollment-failure-reporting-design.md` — source of truth for design decisions. This plan implements it task-by-task.

---

## File Structure

**Create:**
- `agent/internal/eventlog/eventlog.go` — cross-platform no-op stubs (build tag `!windows`)
- `agent/internal/eventlog/eventlog_windows.go` — Windows implementation wrapping `golang.org/x/sys/windows/svc/eventlog`
- `agent/internal/eventlog/eventlog_test.go` — no-op compile test
- `agent/cmd/breeze-agent/enroll_error.go` — `enrollError` helper, category enum, classifier, sinks
- `agent/cmd/breeze-agent/enroll_error_test.go` — unit tests for the helper
- `agent/cmd/breeze-agent/service_windows_test.go` — Windows-gated tests for Execute ordering (create if absent)

**Modify:**
- `agent/pkg/api/client.go` — add `ErrHTTPStatus` type; `Enroll` returns it on non-200
- `agent/pkg/api/client_test.go` — test for `ErrHTTPStatus` (create if absent)
- `agent/internal/config/config.go` — add `IsEnrolled(cfg *Config) bool`
- `agent/internal/config/config_test.go` — table test for `IsEnrolled` (create if absent)
- `agent/cmd/breeze-agent/main.go` — split `startAgent`, add `waitForEnrollment`, `waitForEnrollmentPollInterval`, `initBootstrapLogging`, package-level test seams, rewrite `runAgent` to use `signal.NotifyContext`, route `enrollDevice` failures through `enrollError`, call `clearEnrollLastError` at attempt start
- `agent/cmd/breeze-agent/main_test.go` — three `waitForEnrollment` tests
- `agent/cmd/breeze-agent/service_windows.go` — `runAsService` takes `cfgFile`; `Execute` splits into enrolled/unenrolled paths; extract `runServiceLoop` helper
- `agent/installer/breeze.wxs` — `EnrollAgent` CA `Return="check"`; updated XML comment

**Not touched:**
- `agent/installer/build-msi.ps1` — no changes
- `agent/internal/heartbeat/`, `agent/internal/websocket/` — reused as-is
- `.github/workflows/release.yml` — no changes

---

## Task 1: Add `ErrHTTPStatus` to `pkg/api/client.go`

**Context for engineer:** The Go agent's API client today returns a generic `fmt.Errorf("enrollment failed with status %d: %s", ...)` on non-200 responses. The enrollment classifier (Task 4) needs to distinguish auth failures (401/403) from not-found (404), rate-limit (429), and server errors (5xx). We add a typed error that callers can `errors.As` on.

**Files:**
- Modify: `agent/pkg/api/client.go:106-136`
- Create: `agent/pkg/api/client_test.go`

- [ ] **Step 1: Write the failing test**

Create `agent/pkg/api/client_test.go`:

```go
package api

import (
	"errors"
	"testing"
)

func TestErrHTTPStatus_Error(t *testing.T) {
	err := &ErrHTTPStatus{StatusCode: 401, Body: `{"error":"invalid key"}`}
	got := err.Error()
	want := `http 401: {"error":"invalid key"}`
	if got != want {
		t.Errorf("Error() = %q, want %q", got, want)
	}
}

func TestErrHTTPStatus_ErrorsAs(t *testing.T) {
	var wrapped error = &ErrHTTPStatus{StatusCode: 404, Body: "not found"}
	var target *ErrHTTPStatus
	if !errors.As(wrapped, &target) {
		t.Fatal("errors.As should match *ErrHTTPStatus")
	}
	if target.StatusCode != 404 {
		t.Errorf("StatusCode = %d, want 404", target.StatusCode)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run from `agent/`:

```bash
go test ./pkg/api/... -run 'TestErrHTTPStatus' -v
```

Expected: FAIL with `undefined: ErrHTTPStatus`.

- [ ] **Step 3: Add the type to `pkg/api/client.go`**

Use `Edit` to add the type after the imports, before `type Client struct` at line 13. Find line 11 (`)` closing the imports block) and insert the new type between it and `type Client struct`.

**old_string:**

```go
)

type Client struct {
```

**new_string:**

```go
)

// ErrHTTPStatus is returned by the api client when an HTTP request
// completes but the server returned a non-success status code. Callers
// can type-assert via errors.As to classify the failure (auth, not
// found, rate limit, server error).
type ErrHTTPStatus struct {
	StatusCode int
	Body       string
}

func (e *ErrHTTPStatus) Error() string {
	return fmt.Sprintf("http %d: %s", e.StatusCode, e.Body)
}

type Client struct {
```

- [ ] **Step 4: Update `Enroll` to return `*ErrHTTPStatus` on non-200**

Use `Edit` to change the non-200 branch at line 125-128.

**old_string:**

```go
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("enrollment failed with status %d: %s", resp.StatusCode, string(bodyBytes))
	}
```

**new_string:**

```go
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return nil, &ErrHTTPStatus{StatusCode: resp.StatusCode, Body: string(bodyBytes)}
	}
```

- [ ] **Step 5: Run tests to verify they pass**

Run from `agent/`:

```bash
go test ./pkg/api/... -run 'TestErrHTTPStatus' -v
```

Expected: `PASS` on both `TestErrHTTPStatus_Error` and `TestErrHTTPStatus_ErrorsAs`.

Also run the full api package tests to confirm nothing regressed:

```bash
go test ./pkg/api/... -v
```

Expected: all existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add agent/pkg/api/client.go agent/pkg/api/client_test.go
git commit -m "$(cat <<'EOF'
feat(api): add ErrHTTPStatus type for enroll failure classification

Enroll now returns *ErrHTTPStatus on non-200 responses so callers can
errors.As and branch on StatusCode. Replaces the previous generic
fmt.Errorf which stringified the status and body together.

Needed by the upcoming enrollment failure classifier (issue #411).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add `IsEnrolled` helper to `internal/config/config.go`

**Context for engineer:** `config.SaveTo` writes `agent.yaml` first (with `AgentID`) then `secrets.yaml` (with `AuthToken`) — verified at `agent/internal/config/config.go:313-376`. A concurrent reader polling for enrollment readiness that only checks `AgentID != ""` can observe a torn write: the new `AgentID` is visible but `AuthToken` is still empty. The wait loop (Task 7) needs a predicate that checks both fields so a torn read simply causes one more poll cycle instead of a bogus "enrolled" bring-up.

**Files:**
- Modify: `agent/internal/config/config.go` (add helper near the top of the file, after the `Config` struct definition around line 120)
- Create or modify: `agent/internal/config/config_test.go`

- [ ] **Step 1: Write the failing test**

Create `agent/internal/config/config_test.go` if it doesn't exist, or append to it. If creating, use this full file:

```go
package config

import "testing"

func TestIsEnrolled(t *testing.T) {
	tests := []struct {
		name string
		cfg  *Config
		want bool
	}{
		{"nil config", nil, false},
		{"empty config", &Config{}, false},
		{"agent id only (torn write)", &Config{AgentID: "abc"}, false},
		{"auth token only (torn write)", &Config{AuthToken: "tok"}, false},
		{"both present", &Config{AgentID: "abc", AuthToken: "tok"}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsEnrolled(tt.cfg); got != tt.want {
				t.Errorf("IsEnrolled(%+v) = %v, want %v", tt.cfg, got, tt.want)
			}
		})
	}
}
```

If `config_test.go` already exists, append only the `TestIsEnrolled` function (ensure imports include `"testing"`).

- [ ] **Step 2: Run test to verify it fails**

Run from `agent/`:

```bash
go test ./internal/config/... -run 'TestIsEnrolled' -v
```

Expected: FAIL with `undefined: IsEnrolled`.

- [ ] **Step 3: Add the helper to `config.go`**

Use `Edit` to add the helper immediately after the `Config` struct definition at line 120 (the closing `}` of the struct).

**old_string:**

```go
	// IsHeadless is a runtime flag set when no console/TTY is attached (launchd
	// daemon, systemd service, etc.). Desktop commands route through IPC when set.
	IsHeadless bool `mapstructure:"-"`
}

// defaultLogFile returns the platform-specific default log file path.
```

**new_string:**

```go
	// IsHeadless is a runtime flag set when no console/TTY is attached (launchd
	// daemon, systemd service, etc.). Desktop commands route through IPC when set.
	IsHeadless bool `mapstructure:"-"`
}

// IsEnrolled reports whether cfg represents a complete enrollment — both
// the AgentID (written to agent.yaml) and the AuthToken (written to
// secrets.yaml). Callers that poll for enrollment readiness MUST use
// this predicate rather than checking AgentID alone, because SaveTo
// writes agent.yaml before secrets.yaml and a concurrent reader can
// otherwise observe a torn write (AgentID set but AuthToken not yet
// persisted). A torn read simply causes one more poll cycle.
func IsEnrolled(cfg *Config) bool {
	return cfg != nil && cfg.AgentID != "" && cfg.AuthToken != ""
}

// defaultLogFile returns the platform-specific default log file path.
```

- [ ] **Step 4: Run tests to verify they pass**

Run from `agent/`:

```bash
go test ./internal/config/... -run 'TestIsEnrolled' -v
```

Expected: PASS on all five sub-tests.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/config/config.go agent/internal/config/config_test.go
git commit -m "$(cat <<'EOF'
feat(config): add IsEnrolled(cfg) predicate for complete enrollment check

Checks both AgentID and AuthToken because SaveTo writes agent.yaml
before secrets.yaml — a reader that only checked AgentID could observe
a torn write and bring up the agent with an empty auth token.

Used by the upcoming waitForEnrollment loop (issue #411).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Create `internal/eventlog` package

**Context for engineer:** We need to write enrollment failures to the Windows Application Event Log under source `BreezeAgent`. The stdlib-adjacent package `golang.org/x/sys/windows/svc/eventlog` provides `Install`/`InstallAsEventCreate`/`Open`, but it's Windows-only. We wrap it with a small cross-platform API (`Info` / `Warning` / `Error`) that compiles on macOS and Linux as no-ops. Registration is lazy and guarded by `sync.Once`; if registration fails (non-admin, already registered, etc.) we fall back to `eventlog.Open` and then silently drop if that also fails — the other three sinks cover the failure.

**Files:**
- Create: `agent/internal/eventlog/eventlog.go` (build tag `!windows`)
- Create: `agent/internal/eventlog/eventlog_windows.go`
- Create: `agent/internal/eventlog/eventlog_test.go`

- [ ] **Step 1: Write the cross-platform no-op test**

Create `agent/internal/eventlog/eventlog_test.go`:

```go
package eventlog

import "testing"

func TestNoPanicOnAllPlatforms(t *testing.T) {
	// Calling any of these from a non-admin context on Windows, or
	// anywhere on macOS/Linux, must not panic. Registration errors
	// are silently swallowed per package contract.
	Info("BreezeAgent", "test info message")
	Warning("BreezeAgent", "test warning message")
	Error("BreezeAgent", "test error message")
}
```

- [ ] **Step 2: Run test to verify it fails**

Run from `agent/`:

```bash
go test ./internal/eventlog/... -v
```

Expected: FAIL with `no Go files in .../eventlog`.

- [ ] **Step 3: Create the non-Windows stub**

Create `agent/internal/eventlog/eventlog.go`:

```go
//go:build !windows

// Package eventlog writes informational, warning, and error events to
// the OS event log. On Windows this wraps the Application log; on
// macOS and Linux the calls compile to no-ops so agent call sites can
// stay cross-platform.
package eventlog

// Info writes an informational event to the OS event log (no-op on
// non-Windows platforms). source is a short registered name like
// "BreezeAgent".
func Info(source, message string) {}

// Warning writes a warning event.
func Warning(source, message string) {}

// Error writes an error event.
func Error(source, message string) {}
```

- [ ] **Step 4: Create the Windows implementation**

Create `agent/internal/eventlog/eventlog_windows.go`:

```go
//go:build windows

// Package eventlog writes informational, warning, and error events to
// the Windows Application Event Log. Registration is lazy: on first
// use per source, we attempt InstallAsEventCreate, and if that fails
// because the source already exists we fall back to Open. Both
// failures are silently swallowed — the package's contract is that
// logging is best-effort and never returns errors to callers.
package eventlog

import (
	"sync"

	"golang.org/x/sys/windows/svc/eventlog"
)

// Event IDs used by this package. Fixed values keep the Windows
// Application log filterable by event ID in SIEM tools.
const (
	eventIDInfo    uint32 = 1001
	eventIDWarning uint32 = 1002
	eventIDError   uint32 = 1003
)

var (
	registryMu sync.Mutex
	registry   = map[string]*sourceEntry{}
)

type sourceEntry struct {
	once sync.Once
	log  *eventlog.Log // nil if registration failed
}

func lookupOrRegister(source string) *eventlog.Log {
	registryMu.Lock()
	entry, ok := registry[source]
	if !ok {
		entry = &sourceEntry{}
		registry[source] = entry
	}
	registryMu.Unlock()

	entry.once.Do(func() {
		// Try to install the source with all three severities. Most
		// Windows environments require admin to install a new event
		// source; if the source already exists, Install returns an
		// "already exists" error which we treat as benign.
		_ = eventlog.InstallAsEventCreate(
			source,
			eventlog.Info|eventlog.Warning|eventlog.Error,
		)
		// Open returns a handle usable for Info/Warning/Error regardless
		// of whether we just installed it or it already existed.
		logHandle, openErr := eventlog.Open(source)
		if openErr != nil {
			return // entry.log stays nil; subsequent calls are no-ops
		}
		entry.log = logHandle
	})
	return entry.log
}

// Info writes an informational event to the Windows Application log.
func Info(source, message string) {
	if handle := lookupOrRegister(source); handle != nil {
		_ = handle.Info(eventIDInfo, message)
	}
}

// Warning writes a warning event.
func Warning(source, message string) {
	if handle := lookupOrRegister(source); handle != nil {
		_ = handle.Warning(eventIDWarning, message)
	}
}

// Error writes an error event.
func Error(source, message string) {
	if handle := lookupOrRegister(source); handle != nil {
		_ = handle.Error(eventIDError, message)
	}
}
```

- [ ] **Step 5: Verify the cross-compile for all three platforms**

Run from `agent/`:

```bash
GOOS=windows GOARCH=amd64 go build ./internal/eventlog/...
GOOS=darwin  GOARCH=amd64 go build ./internal/eventlog/...
GOOS=linux   GOARCH=amd64 go build ./internal/eventlog/...
```

Expected: all three exit 0 with no output. If the Windows build fails with a missing dependency, run:

```bash
go mod tidy
```

and re-try. The `golang.org/x/sys` module should already be in go.mod — it's used elsewhere in the agent.

- [ ] **Step 6: Run tests to verify they pass**

Run from `agent/`:

```bash
go test ./internal/eventlog/... -v
```

Expected: `PASS` on `TestNoPanicOnAllPlatforms` on the current host platform (macOS). The test is a smoke test — it verifies the package compiles and the entry points don't panic.

- [ ] **Step 7: Commit**

```bash
git add agent/internal/eventlog/
git commit -m "$(cat <<'EOF'
feat(agent): add internal/eventlog — cross-platform event log wrapper

Windows implementation wraps golang.org/x/sys/windows/svc/eventlog with
lazy registration per source, guarded by sync.Once. Registration errors
(non-admin, already-exists) are silently swallowed — the package's
contract is best-effort logging. macOS/Linux stubs compile to no-ops.

Fixed event IDs: 1001 Info, 1002 Warning, 1003 Error for SIEM filter
stability. Used by the upcoming enrollError helper (issue #411).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Create `cmd/breeze-agent/enroll_error.go`

**Context for engineer:** This is the four-sink writer for enrollment failures. Every failure site in `enrollDevice` (Task 5) will call `enrollError(cat, friendly, detail)`. The helper writes the line to stderr (→ captured by msiexec `/l*v` into install.log), emits a slog `error` event (→ agent.log, diagnostic logs API), overwrites `enroll-last-error.txt` with a single-line timestamped message, and writes a Windows Event Log error. Then it exits with a category-specific code in the range 10-16 so admins can `echo %errorlevel%` and distinguish network from auth from server errors.

The helper also exposes `clearEnrollLastError()` — called at the start of every attempt (Task 5) so a successful retry leaves no residual error file for admins to find.

The file uses package-level vars (`osExit`, `writeLastErrorFile`, `eventLogError`) as test seams so `enroll_error_test.go` can intercept without patching `os.Exit`.

**Files:**
- Create: `agent/cmd/breeze-agent/enroll_error.go`
- Create: `agent/cmd/breeze-agent/enroll_error_test.go`

- [ ] **Step 1: Write the failing tests**

Create `agent/cmd/breeze-agent/enroll_error_test.go`:

```go
package main

import (
	"bytes"
	"errors"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/pkg/api"
)

func TestEnrollErrCategory_ExitCode(t *testing.T) {
	if got, want := catNetwork.exitCode(), 10; got != want {
		t.Errorf("catNetwork.exitCode() = %d, want %d", got, want)
	}
	if got, want := catUnknown.exitCode(), 16; got != want {
		t.Errorf("catUnknown.exitCode() = %d, want %d", got, want)
	}
}

func TestClassifyEnrollError_HTTPStatuses(t *testing.T) {
	tests := []struct {
		name    string
		status  int
		wantCat enrollErrCategory
	}{
		{"401 unauthorized", 401, catAuth},
		{"403 forbidden", 403, catAuth},
		{"404 not found", 404, catNotFound},
		{"429 rate limited", 429, catRateLimit},
		{"500 internal error", 500, catServer},
		{"503 service unavailable", 503, catServer},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := &api.ErrHTTPStatus{StatusCode: tt.status, Body: "body"}
			cat, friendly := classifyEnrollError(err, "https://example.com")
			if cat != tt.wantCat {
				t.Errorf("category = %v, want %v", cat, tt.wantCat)
			}
			if friendly == "" {
				t.Error("friendly message should not be empty")
			}
		})
	}
}

func TestClassifyEnrollError_NetworkError(t *testing.T) {
	urlErr := &url.Error{Op: "Post", URL: "https://unreachable.example", Err: errors.New("dial tcp: connection refused")}
	cat, friendly := classifyEnrollError(urlErr, "https://unreachable.example")
	if cat != catNetwork {
		t.Errorf("category = %v, want catNetwork", cat)
	}
	if !strings.Contains(friendly, "server unreachable") {
		t.Errorf("friendly = %q, should contain 'server unreachable'", friendly)
	}
}

func TestClassifyEnrollError_Unknown(t *testing.T) {
	cat, friendly := classifyEnrollError(errors.New("something weird"), "https://example.com")
	if cat != catUnknown {
		t.Errorf("category = %v, want catUnknown", cat)
	}
	if friendly == "" {
		t.Error("friendly should echo the raw error string")
	}
}

func TestEnrollError_WritesAllFourSinks(t *testing.T) {
	// Redirect stderr to a buffer for observation.
	oldStderr := os.Stderr
	r, w, _ := os.Pipe()
	os.Stderr = w
	t.Cleanup(func() { os.Stderr = oldStderr })

	// Capture last-error file writes.
	var lastErrorCaptured string
	origWrite := writeLastErrorFile
	writeLastErrorFile = func(line string) { lastErrorCaptured = line }
	t.Cleanup(func() { writeLastErrorFile = origWrite })

	// Capture event-log writes.
	var eventLogCaptured string
	origEventLog := eventLogError
	eventLogError = func(source, message string) { eventLogCaptured = message }
	t.Cleanup(func() { eventLogError = origEventLog })

	// Capture exit code.
	var exitCapturedCode int
	origExit := osExit
	osExit = func(code int) {
		exitCapturedCode = code
		panic("test exit") // unwind the stack so enrollError's "never returns" is testable
	}
	t.Cleanup(func() { osExit = origExit })

	defer func() {
		recover() // swallow the test-exit panic
		w.Close()
		var buf bytes.Buffer
		_, _ = io.Copy(&buf, r)
		stderrOutput := buf.String()

		if !strings.Contains(stderrOutput, "Enrollment failed:") {
			t.Errorf("stderr = %q, should contain 'Enrollment failed:'", stderrOutput)
		}
		if !strings.Contains(lastErrorCaptured, "Enrollment failed:") {
			t.Errorf("last error file = %q, should contain 'Enrollment failed:'", lastErrorCaptured)
		}
		if !strings.Contains(eventLogCaptured, "Enrollment failed:") {
			t.Errorf("event log = %q, should contain 'Enrollment failed:'", eventLogCaptured)
		}
		if exitCapturedCode != catAuth.exitCode() {
			t.Errorf("exit code = %d, want %d", exitCapturedCode, catAuth.exitCode())
		}
	}()

	enrollError(catAuth, "enrollment key not recognized", errors.New("http 401"))
}

func TestClearEnrollLastError_RemovesStaleFile(t *testing.T) {
	tmp := t.TempDir()
	// Override the path helper so the test doesn't touch real ProgramData.
	origPath := enrollLastErrorPath
	enrollLastErrorPath = func() string { return filepath.Join(tmp, "enroll-last-error.txt") }
	t.Cleanup(func() { enrollLastErrorPath = origPath })

	// Create a stale file.
	if err := os.WriteFile(enrollLastErrorPath(), []byte("stale"), 0o644); err != nil {
		t.Fatal(err)
	}

	clearEnrollLastError()

	if _, err := os.Stat(enrollLastErrorPath()); !os.IsNotExist(err) {
		t.Errorf("stale file should have been removed, stat err = %v", err)
	}
}

func TestClearEnrollLastError_NoFileIsNoError(t *testing.T) {
	tmp := t.TempDir()
	origPath := enrollLastErrorPath
	enrollLastErrorPath = func() string { return filepath.Join(tmp, "never-existed.txt") }
	t.Cleanup(func() { enrollLastErrorPath = origPath })

	// Should not panic or log at error level.
	clearEnrollLastError()
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run from `agent/`:

```bash
go test ./cmd/breeze-agent/... -run 'TestEnrollErr|TestClassify|TestClearEnrollLastError' -v
```

Expected: FAIL with `undefined: catNetwork`, `undefined: enrollError`, etc.

- [ ] **Step 3: Create `enroll_error.go`**

Create `agent/cmd/breeze-agent/enroll_error.go`:

```go
package main

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/eventlog"
	"github.com/breeze-rmm/agent/pkg/api"
)

// enrollErrCategory classifies an enrollment failure for exit-code
// stability and human-readable messaging. Exit codes are mapped to
// 10..16 to keep each category distinguishable in msiexec install.log
// without colliding with Go's default runtime-error exit code (2).
type enrollErrCategory int

const (
	catNetwork   enrollErrCategory = iota // dial/DNS/TLS/timeout/conn refused
	catAuth                               // 401, 403
	catNotFound                           // 404
	catRateLimit                          // 429
	catServer                             // 5xx
	catConfig                             // pre-flight validation or save failed
	catUnknown                            // fallback — message comes from raw error
)

func (c enrollErrCategory) exitCode() int { return int(c) + 10 }

// Package-level test seams. Production assigns them to the real
// implementations in init(); tests override with t.Cleanup-guarded
// stubs in enroll_error_test.go.
var (
	osExit             = os.Exit
	writeLastErrorFile = defaultWriteLastErrorFile
	eventLogError      = eventlog.Error
	enrollLastErrorPath = defaultEnrollLastErrorPath
)

// defaultEnrollLastErrorPath returns the platform-specific path to the
// single-line enrollment error marker. Windows: under ProgramData\Breeze\logs.
// Unix: under LogDir().
func defaultEnrollLastErrorPath() string {
	return filepath.Join(config.LogDir(), "enroll-last-error.txt")
}

// defaultWriteLastErrorFile overwrites enroll-last-error.txt with a
// single line containing the RFC3339 timestamp and the friendly message.
// Silently ignores errors — this is a diagnostic aid, not a critical
// path.
func defaultWriteLastErrorFile(line string) {
	path := enrollLastErrorPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	content := fmt.Sprintf("%s — %s\n", time.Now().Format(time.RFC3339), line)
	_ = os.WriteFile(path, []byte(content), 0o644)
}

// clearEnrollLastError removes enroll-last-error.txt if present. Called
// at the start of every enrollment attempt so a successful retry leaves
// no residual error file. Errors from os.Remove are silently ignored
// (the file may legitimately not exist, and cleanup bookkeeping must
// not fail an enrollment attempt).
func clearEnrollLastError() {
	path := enrollLastErrorPath()
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		// Log at debug level only — not worth bothering admins. The scoped
		// enrollLog is initialized by initEnrollLogging before this helper
		// is called.
		log.Debug("could not clear stale enroll-last-error file",
			"path", path, "error", err.Error())
	}
}

// enrollError writes a human-readable failure line to all four sinks
// (stderr → msiexec install.log, agent.log via slog, enroll-last-error.txt,
// Windows Event Log) and exits the process with a category-specific
// code. Never returns in production; tests inject a panicking osExit
// stub so assertion code after the call is reachable via defer+recover.
func enrollError(cat enrollErrCategory, friendly string, detail error) {
	line := fmt.Sprintf("Enrollment failed: %s", friendly)
	if detail != nil {
		line += fmt.Sprintf(" (%v)", detail)
	}

	// Sink 1: stderr → msiexec /l*v captures into install.log.
	fmt.Fprintln(os.Stderr, line)

	// Sink 2: agent.log via slog. The scoped enrollLog is initialized
	// by initEnrollLogging in enrollDevice before any failure path
	// can fire; fall back to the main log if called from an unexpected
	// context.
	log.Error("enrollment failed",
		"category", cat,
		"friendly", friendly,
		"error", fmt.Sprint(detail))

	// Sink 3: enroll-last-error.txt — single-line timestamped marker.
	writeLastErrorFile(line)

	// Sink 4: Windows Event Log (no-op on macOS/Linux).
	eventLogError("BreezeAgent", line)

	osExit(cat.exitCode())
}

// classifyEnrollError inspects an error returned by api.Client.Enroll
// and maps it to the appropriate category + user-facing friendly
// message. The serverURL is threaded through so friendly messages can
// echo it back to the admin ("check that SERVER_URL is correct").
func classifyEnrollError(err error, serverURL string) (enrollErrCategory, string) {
	if err == nil {
		return catUnknown, ""
	}

	var httpErr *api.ErrHTTPStatus
	if errors.As(err, &httpErr) {
		switch {
		case httpErr.StatusCode == 401 || httpErr.StatusCode == 403:
			return catAuth, "enrollment key not recognized — verify the key is active in Settings → Enrollment on the server"
		case httpErr.StatusCode == 404:
			return catNotFound, fmt.Sprintf(
				"enrollment endpoint not found on %s — check that SERVER_URL is correct (did you include /api or point at the wrong host?)",
				serverURL)
		case httpErr.StatusCode == 429:
			return catRateLimit, "rate limited by server — wait one minute and retry the install"
		case httpErr.StatusCode >= 500:
			return catServer, fmt.Sprintf(
				"server error %d — contact Breeze support if this persists",
				httpErr.StatusCode)
		}
	}

	// Network-layer errors come through as *url.Error wrapping dial/DNS/TLS/timeout.
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return catNetwork, fmt.Sprintf(
			"server unreachable at %s — check firewall, DNS, and that SERVER_URL is correct",
			serverURL)
	}

	return catUnknown, err.Error()
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run from `agent/`:

```bash
go test ./cmd/breeze-agent/... -run 'TestEnrollErr|TestClassify|TestClearEnrollLastError' -v
```

Expected: PASS on all tests. If `TestEnrollError_WritesAllFourSinks` fails with a "panic recovered" message that doesn't match the expected string, verify the stubs are wired correctly via `t.Cleanup`.

- [ ] **Step 5: Commit**

```bash
git add agent/cmd/breeze-agent/enroll_error.go agent/cmd/breeze-agent/enroll_error_test.go
git commit -m "$(cat <<'EOF'
feat(agent): add enrollError helper — four-sink failure reporter

Routes every enrollment failure through one helper that writes the
friendly cause to stderr (captured by msiexec /l*v into install.log),
slog (agent.log + diagnostic logs API), enroll-last-error.txt (a
single-line timestamped marker in the logs directory), and the
Windows Event Log (Application / BreezeAgent / Error).

Categories map to exit codes 10..16 so admins can distinguish
network/auth/not-found/rate-limit/server/config/unknown failures from
the install.log verbose output.

clearEnrollLastError() removes stale markers at the start of every
attempt so a successful retry leaves no residual.

Issue #411.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Wire `enrollDevice` through `enrollError`

**Context for engineer:** The existing `enrollDevice` function at `agent/cmd/breeze-agent/main.go:522` already uses `initEnrollLogging`, has a scoped `enrollLog`, and prints failures via `fmt.Fprintf(os.Stderr, ...)` + `os.Exit(1)`. We keep the logging init and replace the stderr/exit pairs with `enrollError` calls. We also insert a `clearEnrollLastError()` call immediately after logging init and before any validation or early return — so a server-URL validation failure still clears the stale marker from a previous attempt.

The three failure sites to replace:
1. Line ~543 — `cfg.ServerURL == ""` → `catConfig`
2. Line ~670ish — `client.Enroll(enrollReq)` error → classified via `classifyEnrollError`
3. Line ~720ish — `config.SaveTo` error → `catConfig`

**Files:**
- Modify: `agent/cmd/breeze-agent/main.go:522-750` (approximately)

- [ ] **Step 1: Read the current `enrollDevice` body**

The engineer must read lines 522-750 of `agent/cmd/breeze-agent/main.go` to get current line numbers before editing. The numbers in this task are approximate because the merged #410 code has evolved.

Run:

```bash
grep -n 'func enrollDevice\|os.Exit(1)\|Enrollment failed' agent/cmd/breeze-agent/main.go
```

Expected output lists `func enrollDevice` plus several `os.Exit(1)` lines and any `fmt.Fprintf(os.Stderr, "Enrollment failed: ..."` lines.

- [ ] **Step 2: Add `clearEnrollLastError()` after `initEnrollLogging`**

Use `Edit` to add the clear call immediately after the `initEnrollLogging(cfg, quietEnroll)` line and BEFORE the server-URL validation. Decision 8 from the spec requires every attempt to start with a clean slate, including attempts that fail on pre-flight validation.

**old_string:**

```go
	// Initialise logging so this enrollment leaves a record in agent.log.
	// In quiet mode, force file-only output — errors still reach stderr
	// via explicit fmt.Fprintln calls at error sites below.
	initEnrollLogging(cfg, quietEnroll)

	enrollLog := logging.L("enroll")

	if cfg.ServerURL == "" {
```

**new_string:**

```go
	// Initialise logging so this enrollment leaves a record in agent.log.
	// In quiet mode, force file-only output — errors still reach stderr
	// via explicit fmt.Fprintln calls at error sites below.
	initEnrollLogging(cfg, quietEnroll)

	enrollLog := logging.L("enroll")

	// Clear any stale enroll-last-error.txt from a previous failed
	// attempt BEFORE any validation or early return. Every attempt
	// starts from a clean marker state; a validation failure later
	// in this function must not leave a stale file behind (spec
	// decision 8, issue #411).
	clearEnrollLastError()

	if cfg.ServerURL == "" {
```

- [ ] **Step 3: Replace the server-URL validation failure with `enrollError`**

**old_string:**

```go
	if cfg.ServerURL == "" {
		enrollLog.Error("server URL required, use --server or set in config")
		fmt.Fprintln(os.Stderr, "Server URL required. Use --server flag or set in config.")
		os.Exit(1)
	}
```

**new_string:**

```go
	if cfg.ServerURL == "" {
		enrollError(catConfig,
			"server URL required — pass --server or set it in config",
			nil)
	}
```

- [ ] **Step 4: Replace the `client.Enroll` failure with classification + `enrollError`**

Grep for the existing block:

```bash
grep -n 'enrollResp, err := client.Enroll\|Enrollment failed: %v' agent/cmd/breeze-agent/main.go
```

Then edit the block. The exact `old_string` depends on surrounding context; the engineer should read 10-15 lines around the match and construct a unique `old_string`. Example based on the pre-Task-5 state:

**old_string:**

```go
	enrollResp, err := client.Enroll(enrollReq)
	if err != nil {
		enrollLog.Error("enrollment request failed",
			"error", err.Error(),
			"server", cfg.ServerURL)
		fmt.Fprintf(os.Stderr, "Enrollment failed: %v\n", err)
		os.Exit(1)
	}
```

**new_string:**

```go
	enrollResp, err := client.Enroll(enrollReq)
	if err != nil {
		cat, friendly := classifyEnrollError(err, cfg.ServerURL)
		enrollError(cat, friendly, err)
	}
```

- [ ] **Step 5: Replace the `config.SaveTo` failure with `enrollError`**

Grep for the existing block:

```bash
grep -n 'config.SaveTo(cfg, cfgFile)\|Warning: Failed to save config' agent/cmd/breeze-agent/main.go
```

**old_string:**

```go
	if err := config.SaveTo(cfg, cfgFile); err != nil {
		enrollLog.Error("enrollment succeeded but failed to save config",
			"error", err.Error(),
			"agentId", cfg.AgentID)
		fmt.Fprintf(os.Stderr, "Warning: Failed to save config: %v\n", err)
		fmt.Fprintf(os.Stderr, "Agent ID: %s\n", cfg.AgentID)
		fmt.Fprintln(os.Stderr, "You may need to manually save the configuration.")
		os.Exit(1)
	}
```

**new_string:**

```go
	if err := config.SaveTo(cfg, cfgFile); err != nil {
		enrollError(catConfig,
			fmt.Sprintf(
				"enrollment succeeded but could not save config to %s — check that the directory exists and SYSTEM has write access (agentID=%s)",
				cfgFile, cfg.AgentID),
			err)
	}
```

- [ ] **Step 6: Verify the package still builds**

Run from `agent/`:

```bash
go build ./cmd/breeze-agent/...
```

Expected: exit 0 with no output.

- [ ] **Step 7: Run the enroll-related tests**

```bash
go test ./cmd/breeze-agent/... -run 'TestEnrollErr|TestClassify|TestClearEnrollLastError' -v
```

Expected: still PASS. These tests exercise `enroll_error.go` directly and don't depend on `enrollDevice`.

- [ ] **Step 8: Commit**

```bash
git add agent/cmd/breeze-agent/main.go
git commit -m "$(cat <<'EOF'
refactor(agent): route enrollDevice failures through enrollError

All three failure sites in enrollDevice (missing server URL, HTTP
error from client.Enroll, config.SaveTo write error) now call
enrollError with a category-specific friendly message instead of
fmt.Fprintf+os.Exit(1). Admins get a readable cause in install.log,
agent.log, enroll-last-error.txt, and Event Viewer instead of a bare
"Enrollment failed: enrollment failed with status 401: ..." line.

clearEnrollLastError is called immediately after logging init,
before any validation, so a fresh attempt always starts from a
clean marker state — even when it fails on pre-flight checks.

Issue #411.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Add test seams, `waitForEnrollment`, and `initBootstrapLogging`

**Context for engineer:** This task introduces three pieces in one commit because they're tightly coupled: the package-level function vars (test seams), the `waitForEnrollment` helper the service wrapper will use in Task 8, and a minimal `initBootstrapLogging` helper that prepares logging before the wait loop runs (Component 1's caveat).

- The test seams are `startAgentFn`, `waitForEnrollmentFn`, `runServiceLoopFn`. They're assigned at package scope to the bare implementations; tests in Task 7 and Task 10 override them with stubs.
- `waitForEnrollment(ctx, cfgFile)` polls `config.Load` every `waitForEnrollmentPollInterval` (default 10s, overridable for tests) and returns the enrolled config when `config.IsEnrolled` returns true, or `nil` if ctx is cancelled.
- `initBootstrapLogging(cfg)` initializes the logging package to write to stderr + the configured log file (no shipper, no network) so `waitForEnrollment` can emit Warn/Info lines before full `startAgent` runs.

**Note on circular dependencies:** `runServiceLoopFn` references `agentComponents` and `svc.ChangeRequest`, which are Windows-only. Declare the var type using interface-free signatures inside a `//go:build windows` file.

**Files:**
- Modify: `agent/cmd/breeze-agent/main.go` (add helpers + cross-platform seams)
- Create or modify: `agent/cmd/breeze-agent/service_seams_windows.go` (Windows-only seam for `runServiceLoopFn`)

- [ ] **Step 1: Check existing imports in main.go**

Run:

```bash
grep -n 'import\|"context"\|"time"' agent/cmd/breeze-agent/main.go | head -25
```

If `"context"` is missing from the imports block, Task 6 will add it.

- [ ] **Step 2: Add the cross-platform seams and helpers to main.go**

Use `Edit` to add a block just after the package-level `var (...)` block at lines 37-46. The existing block currently declares `version`, `cfgFile`, `serverURL`, etc. Find a stable anchor (the `var log = logging.L("main")` line, around line 48) and insert the new block after it.

**old_string:**

```go
var log = logging.L("main")

var rootCmd = &cobra.Command{
```

**new_string:**

```go
var log = logging.L("main")

// waitForEnrollmentPollInterval is the interval between config reloads
// in the wait-for-enrollment loop. Tests override this via t.Cleanup to
// shrink the loop to milliseconds.
var waitForEnrollmentPollInterval = 10 * time.Second

// Package-level indirection for testability. Tests override these in
// t.Cleanup-guarded setup to observe Execute and runAgent ordering
// without running the real startup pipeline. Production callers MUST
// use these vars, not the unexported symbols they wrap.
//
// startAgentFn and waitForEnrollmentFn are cross-platform; runServiceLoopFn
// is defined in service_seams_windows.go because its signature references
// Windows-only types.
var (
	startAgentFn        func(*config.Config) (*agentComponents, error) = startAgent
	waitForEnrollmentFn func(context.Context, string) *config.Config   = waitForEnrollment
)

// initBootstrapLogging initializes the logging package with stderr +
// the configured log file so waitForEnrollment can emit Warn/Info
// lines before full startAgent runs. Does NOT start the log shipper,
// heartbeat, or any network I/O — those are initialized later in
// startAgent once enrollment is complete. Safe to call multiple times
// (logging.Init is idempotent).
func initBootstrapLogging(cfg *config.Config) {
	logFile := cfg.LogFile
	if logFile == "" {
		logFile = filepath.Join(config.LogDir(), "agent.log")
	}
	// Best effort: if the log file can't be opened (permissions, missing
	// dir), fall back to stderr only. Bootstrap logging must never fail
	// the agent start.
	if err := os.MkdirAll(filepath.Dir(logFile), 0o755); err != nil {
		logging.Init(cfg.LogFormat, cfg.LogLevel, os.Stderr)
		return
	}
	rw, err := logging.NewRotatingWriter(logFile, cfg.LogMaxSizeMB, cfg.LogMaxBackups)
	if err != nil {
		logging.Init(cfg.LogFormat, cfg.LogLevel, os.Stderr)
		return
	}
	logging.Init(cfg.LogFormat, cfg.LogLevel, logging.TeeWriter(os.Stderr, rw))
}

// waitForEnrollment polls agent.yaml + secrets.yaml every
// waitForEnrollmentPollInterval until config.IsEnrolled returns true,
// then returns the enrolled config. Returns nil if ctx is cancelled
// before enrollment completes.
//
// Intended for post-MSI-install scenarios where the service starts
// before a later `breeze-agent enroll` call populates the config. The
// ctx allows the caller to cancel the wait on shutdown (SIGINT/SIGTERM
// via signal.NotifyContext in runAgent, or SCM Stop in the Windows
// service wrapper).
func waitForEnrollment(ctx context.Context, cfgFile string) *config.Config {
	log.Warn("agent not enrolled — waiting for enrollment. "+
		"Run 'breeze-agent enroll <key> --server <url>' to complete setup.",
		"pollInterval", waitForEnrollmentPollInterval)
	eventlog.Info("BreezeAgent",
		"Waiting for enrollment. Run 'breeze-agent enroll <key> --server <url>'.")

	ticker := time.NewTicker(waitForEnrollmentPollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Info("waitForEnrollment cancelled", "reason", ctx.Err().Error())
			return nil
		case <-ticker.C:
			cfg, err := config.Load(cfgFile)
			if err != nil {
				log.Debug("config reload failed while waiting for enrollment",
					"error", err.Error())
				continue
			}
			if config.IsEnrolled(cfg) {
				log.Info("enrollment detected, continuing startup",
					"agentId", cfg.AgentID)
				return cfg
			}
		}
	}
}

var rootCmd = &cobra.Command{
```

- [ ] **Step 3: Add `context` and `eventlog` to the import block**

Run:

```bash
grep -n '"github.com/breeze-rmm/agent/internal/logging"\|"context"\|"github.com/breeze-rmm/agent/internal/eventlog"' agent/cmd/breeze-agent/main.go
```

If `"context"` is missing, add it to the imports. The imports block is at the top of the file (lines 3-35).

**old_string:**

```go
import (
	"context"
```

If `"context"` is already present, skip the context insertion. If not, use this edit on the imports block:

**old_string:**

```go
import (
	"crypto/tls"
```

**new_string:**

```go
import (
	"context"
	"crypto/tls"
```

Then add the eventlog import. Find the existing `"github.com/breeze-rmm/agent/internal/logging"` line:

**old_string:**

```go
	"github.com/breeze-rmm/agent/internal/logging"
```

**new_string:**

```go
	"github.com/breeze-rmm/agent/internal/eventlog"
	"github.com/breeze-rmm/agent/internal/logging"
```

- [ ] **Step 4: Create the Windows-only seam file**

Create `agent/cmd/breeze-agent/service_seams_windows.go`:

```go
//go:build windows

package main

import "golang.org/x/sys/windows/svc"

// runServiceLoopFn is the package-level test seam for the post-startup
// SCM control loop. Production assigns it to runServiceLoop (defined
// in service_windows.go); tests in service_windows_test.go override
// it to skip the real loop (which would dereference comps.hb and
// comps.wsClient in shutdownAgent).
var runServiceLoopFn func(
	comps *agentComponents,
	r <-chan svc.ChangeRequest,
	changes chan<- svc.Status,
) (bool, uint32) = runServiceLoop
```

Note: `runServiceLoop` does not yet exist — it will be extracted from `service_windows.go` in Task 8. This file will fail to compile on Windows until Task 8 lands. That's expected — this task and Task 8 will compile together. The macOS/Linux build is unaffected because the file has a Windows build tag.

- [ ] **Step 5: Verify the non-Windows build still works**

Run from `agent/`:

```bash
GOOS=darwin  GOARCH=amd64 go build ./cmd/breeze-agent/...
GOOS=linux   GOARCH=amd64 go build ./cmd/breeze-agent/...
```

Expected: both exit 0.

The Windows build will FAIL at this point because `runServiceLoop` is undefined — the Windows side is completed in Task 8. This is expected and explicit.

```bash
GOOS=windows GOARCH=amd64 go build ./cmd/breeze-agent/... 2>&1 || echo "expected failure — Task 8 adds runServiceLoop"
```

Expected: failure with `undefined: runServiceLoop`, followed by the "expected failure" echo.

- [ ] **Step 6: Commit**

```bash
git add agent/cmd/breeze-agent/main.go agent/cmd/breeze-agent/service_seams_windows.go
git commit -m "$(cat <<'EOF'
feat(agent): add waitForEnrollment, bootstrap logging, and test seams

Adds three pieces needed by the MSI enrollment failure work:
- waitForEnrollment(ctx, cfgFile) polls config.Load every
  waitForEnrollmentPollInterval until config.IsEnrolled returns true,
  then returns the enrolled config. Context cancellation returns nil
  cleanly (no goroutine leaks in tests).
- initBootstrapLogging(cfg) wires up stderr + rotating file writers
  so the wait loop can emit Warn/Info lines before the full startAgent
  pipeline runs.
- Package-level function vars startAgentFn / waitForEnrollmentFn /
  runServiceLoopFn act as test seams so Windows service tests can
  observe Execute's state-transition ordering without constructing
  real heartbeat/websocket fixtures. runServiceLoopFn lives in a
  Windows-only file because its signature references svc.ChangeRequest.

Windows build intentionally fails until Task 8 extracts runServiceLoop
from service_windows.go. Non-Windows builds compile cleanly.

Issue #411.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `waitForEnrollment` tests in `main_test.go`

**Context for engineer:** Three tests exercise the helper from Task 6. All three use `waitForEnrollmentPollInterval = 10 * time.Millisecond` (reset via `t.Cleanup`) so they finish in under a second instead of waiting 10s. The tests write config files to a `t.TempDir()` and point `cfgFile` at them.

**Files:**
- Modify: `agent/cmd/breeze-agent/main_test.go` (create if absent)

- [ ] **Step 1: Check whether main_test.go exists**

```bash
ls agent/cmd/breeze-agent/main_test.go
```

If absent, the test file will be created from scratch. If present, append the three new tests.

- [ ] **Step 2: Write the three tests**

If `main_test.go` exists, add the three test functions plus any missing imports. If not, create the file with this content:

```go
package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// writeEnrolledConfig writes a minimal agent.yaml + secrets.yaml pair
// that config.Load will parse into a config with both AgentID and
// AuthToken set (IsEnrolled returns true).
func writeEnrolledConfig(t *testing.T, dir string) string {
	t.Helper()
	agentPath := filepath.Join(dir, "agent.yaml")
	if err := os.WriteFile(agentPath, []byte("agent_id: test-agent-id\nserver_url: https://test.example\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	secretsPath := filepath.Join(dir, "secrets.yaml")
	if err := os.WriteFile(secretsPath, []byte("auth_token: test-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return agentPath
}

// writeTornConfig writes only agent.yaml (with AgentID) but no secrets
// file, simulating the race window where SaveTo has flushed agent.yaml
// but not yet written secrets.yaml.
func writeTornConfig(t *testing.T, dir string) string {
	t.Helper()
	agentPath := filepath.Join(dir, "agent.yaml")
	if err := os.WriteFile(agentPath, []byte("agent_id: test-agent-id\nserver_url: https://test.example\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return agentPath
}

func TestWaitForEnrollment_UnblocksWhenConfigBecomesValid(t *testing.T) {
	origInterval := waitForEnrollmentPollInterval
	waitForEnrollmentPollInterval = 10 * time.Millisecond
	t.Cleanup(func() { waitForEnrollmentPollInterval = origInterval })

	dir := t.TempDir()
	agentPath := filepath.Join(dir, "agent.yaml")

	// Start with no config file at all.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	done := make(chan *config.Config, 1)
	go func() {
		done <- waitForEnrollment(ctx, agentPath)
	}()

	// Write a valid enrolled config after 50ms.
	time.Sleep(50 * time.Millisecond)
	_ = writeEnrolledConfig(t, dir)

	select {
	case cfg := <-done:
		if cfg == nil {
			t.Fatal("waitForEnrollment returned nil; expected enrolled config")
		}
		if cfg.AgentID != "test-agent-id" {
			t.Errorf("AgentID = %q, want test-agent-id", cfg.AgentID)
		}
	case <-time.After(1500 * time.Millisecond):
		t.Fatal("waitForEnrollment did not return within 1.5s")
	}
}

func TestWaitForEnrollment_RespectsContextCancel(t *testing.T) {
	origInterval := waitForEnrollmentPollInterval
	waitForEnrollmentPollInterval = 10 * time.Millisecond
	t.Cleanup(func() { waitForEnrollmentPollInterval = origInterval })

	dir := t.TempDir()
	agentPath := filepath.Join(dir, "does-not-exist.yaml")

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan *config.Config, 1)
	go func() {
		done <- waitForEnrollment(ctx, agentPath)
	}()

	// Cancel after 30ms — waitForEnrollment should return nil within
	// another 30ms (next ticker fire).
	time.Sleep(30 * time.Millisecond)
	cancel()

	select {
	case cfg := <-done:
		if cfg != nil {
			t.Errorf("expected nil on ctx cancel, got %+v", cfg)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("waitForEnrollment did not return within 500ms of cancel")
	}
}

func TestWaitForEnrollment_IgnoresTornWrite(t *testing.T) {
	origInterval := waitForEnrollmentPollInterval
	waitForEnrollmentPollInterval = 10 * time.Millisecond
	t.Cleanup(func() { waitForEnrollmentPollInterval = origInterval })

	dir := t.TempDir()
	// Write only agent.yaml — no secrets file (torn SaveTo state).
	agentPath := writeTornConfig(t, dir)

	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()

	done := make(chan *config.Config, 1)
	go func() {
		done <- waitForEnrollment(ctx, agentPath)
	}()

	// Verify it stays blocked for 100ms (IsEnrolled returns false on torn state).
	time.Sleep(100 * time.Millisecond)
	select {
	case cfg := <-done:
		t.Fatalf("waitForEnrollment returned %+v on torn write; must stay blocked until secrets.yaml lands", cfg)
	default:
	}

	// Now write secrets.yaml — waitForEnrollment should unblock on the next tick.
	secretsPath := filepath.Join(dir, "secrets.yaml")
	if err := os.WriteFile(secretsPath, []byte("auth_token: test-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	select {
	case cfg := <-done:
		if cfg == nil {
			t.Fatal("expected enrolled config, got nil")
		}
	case <-time.After(300 * time.Millisecond):
		t.Fatal("waitForEnrollment did not unblock after secrets.yaml was written")
	}
}
```

If the file already exists, also import the `config` package if it's not already imported.

**Note:** the existing `main_test.go` (if present) may declare `package main` in a different ordering. Harmonize imports so both `context` and the `config` package are available.

- [ ] **Step 3: Run the new tests**

Run from `agent/`:

```bash
go test ./cmd/breeze-agent/... -run 'TestWaitForEnrollment' -v
```

Expected: PASS on all three tests within ~3 seconds total.

- [ ] **Step 4: Run with `-race` to catch any races**

```bash
go test ./cmd/breeze-agent/... -run 'TestWaitForEnrollment' -race -v
```

Expected: PASS with no race warnings. The `waitForEnrollmentPollInterval` package var is written once per test inside `t.Cleanup`, which serializes with other tests.

- [ ] **Step 5: Commit**

```bash
git add agent/cmd/breeze-agent/main_test.go
git commit -m "$(cat <<'EOF'
test(agent): waitForEnrollment — unblock, cancel, torn-write coverage

TestWaitForEnrollment_UnblocksWhenConfigBecomesValid verifies the
loop returns the enrolled config when agent.yaml + secrets.yaml appear
mid-wait. TestWaitForEnrollment_RespectsContextCancel verifies
context.Cancel unblocks the loop with a nil return (no goroutine
leak). TestWaitForEnrollment_IgnoresTornWrite verifies IsEnrolled
prevents the wait loop from unblocking on a state where only agent.yaml
has been flushed but secrets.yaml hasn't — exactly the race that
config.SaveTo can produce between its two file writes.

All three use waitForEnrollmentPollInterval = 10ms so they finish in
under a second instead of 10+ seconds.

Issue #411.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Split `startAgent`, extract `runServiceLoop`, rewrite Windows `Execute`

**Context for engineer:** This is the biggest task. Three tightly-coupled changes in one commit:

1. Change `startAgent()` (no args) → `startAgent(cfg *config.Config) (*agentComponents, error)`. Remove the enrollment check at lines 230-240; callers now supply an already-enrolled config.
2. Extract the post-startup `for { select { r } }` block from `service_windows.go:135-163` into a standalone `runServiceLoop(comps, r, changes) (bool, uint32)` function that also handles the `shutdownAgent(comps)` call on Stop.
3. Rewrite `breezeService.Execute` to: load config synchronously, call `initBootstrapLogging`, branch on `config.IsEnrolled(cfg)`, and either run the synchronous enrolled path (preserving today's failure semantics) or the async unenrolled path (signal Running early, `waitForEnrollmentFn`, then `startAgentFn`).

Also change `runAsService`'s signature from `runAsService(startFn func() (*agentComponents, error))` to `runAsService(cfgFile string)`.

**Files:**
- Modify: `agent/cmd/breeze-agent/main.go:224-241` (startAgent signature change)
- Modify: `agent/cmd/breeze-agent/service_windows.go:100-165` (full rewrite of runAsService + Execute + extract runServiceLoop)

- [ ] **Step 1: Change `startAgent` signature**

Use `Edit` on `agent/cmd/breeze-agent/main.go` around line 224-241.

**old_string:**

```go
// startAgent performs all agent initialisation and returns the running
// components. It is used by both the console-mode runAgent and the Windows
// SCM service wrapper so the startup logic lives in one place.
func startAgent() (*agentComponents, error) {
	cfg, err := config.Load(cfgFile)
	if err != nil {
		return nil, fmt.Errorf("failed to load config: %w", err)
	}

	if cfg.AgentID == "" {
		// Check for pending enrollment from a failed MSI install
		if tryPendingEnrollment() {
			cfg, err = config.Load(cfgFile)
			if err != nil {
				return nil, fmt.Errorf("failed to reload config after pending enrollment: %w", err)
			}
		}
		if cfg.AgentID == "" {
			return nil, fmt.Errorf("agent not enrolled — run 'breeze-agent enroll <key>' first")
		}
	}
```

**new_string:**

```go
// startAgent performs all agent initialisation assuming cfg is already
// enrolled. Returns the running components or an error if any
// initialization step fails (mTLS load, log shipper init, heartbeat
// bring-up, etc.). Callers (runAgent on console/Unix, the Windows
// service wrapper) MUST check config.IsEnrolled first and call
// waitForEnrollment if needed — this function no longer performs the
// enrollment check itself.
func startAgent(cfg *config.Config) (*agentComponents, error) {
	if !config.IsEnrolled(cfg) {
		return nil, fmt.Errorf("startAgent called with unenrolled config — caller must waitForEnrollment first")
	}
```

Note that the `cfg, err := config.Load(cfgFile)` line is gone — the caller loads the config and passes it in. The downstream code inside `startAgent` that used `cfg` continues to work.

- [ ] **Step 2: Update the only other caller of `startAgent` — `runAgent`'s console-mode path**

The console-mode path currently calls `startAgent()` at main.go:467. Update it to load config, check IsEnrolled, optionally wait, then call `startAgentFn(cfg)`. Also wire `signal.NotifyContext` for cancel-on-SIGTERM.

Grep for context:

```bash
grep -n 'func runAgent\|isWindowsService()\|runAsService(startAgent)\|comps, err := startAgent' agent/cmd/breeze-agent/main.go
```

**old_string:**

```go
func runAgent() {
	// Self-heal launchd plists on macOS (fixes KeepAlive config from older installs).
	healLaunchdPlistsIfNeeded()

	// On Windows, if launched by the SCM, run under the service framework
	// so we report Running/Stopped status back to the SCM correctly.
	if isWindowsService() {
		if err := runAsService(startAgent); err != nil {
			log.Error("service failed", "error", err.Error())
			os.Exit(1)
		}
		return
	}

	// Console mode — start components and wait for OS signal.
	comps, err := startAgent()
	if err != nil {
```

**new_string:**

```go
func runAgent() {
	// Self-heal launchd plists on macOS (fixes KeepAlive config from older installs).
	healLaunchdPlistsIfNeeded()

	// On Windows, if launched by the SCM, run under the service framework
	// so we report Running/Stopped status back to the SCM correctly. The
	// service wrapper owns its own config loading, enrollment check, and
	// cancellation via the SCM request channel.
	if isWindowsService() {
		if err := runAsService(cfgFile); err != nil {
			log.Error("service failed", "error", err.Error())
			os.Exit(1)
		}
		return
	}

	// Console / Unix service-manager mode. Load config, prepare bootstrap
	// logging, and wait for enrollment if needed. signal.NotifyContext
	// wires SIGINT/SIGTERM to ctx so Ctrl+C in a terminal and
	// `systemctl stop` / `launchctl kickstart -k` all cancel any active
	// wait cleanly.
	cfg, err := config.Load(cfgFile)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to load config: %v\n", err)
		os.Exit(1)
	}
	initBootstrapLogging(cfg)

	ctx, stop := signal.NotifyContext(context.Background(),
		os.Interrupt, syscall.SIGTERM)
	defer stop()

	if !config.IsEnrolled(cfg) {
		cfg = waitForEnrollmentFn(ctx, cfgFile)
		if cfg == nil {
			log.Info("agent shutting down without enrollment",
				"reason", ctx.Err().Error())
			return
		}
	}

	comps, err := startAgentFn(cfg)
	if err != nil {
```

- [ ] **Step 3: Update the existing SIGINT-ignore + SIGTERM block**

The current block right after the error handling uses a separate `sigChan` and ignores SIGINT. With `signal.NotifyContext` wired in, the ctx already covers SIGTERM. Replace the bottom half of runAgent to use ctx.

Grep for context:

```bash
grep -n 'signal.Ignore(syscall.SIGINT)\|sigChan := make(chan os.Signal' agent/cmd/breeze-agent/main.go
```

**old_string:**

```go
	defer logging.StopShipper()

	// Ignore SIGINT — as a daemon, PTY child processes can propagate
	// SIGINT to our process group via Ctrl+C. Only SIGTERM should trigger shutdown.
	signal.Ignore(syscall.SIGINT)

	// Wait for shutdown signal
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGTERM)

	<-sigChan
	log.Info("shutting down agent")

	shutdownAgent(comps)
	log.Info("agent stopped")
}
```

**new_string:**

```go
	defer logging.StopShipper()

	// Wait for ctx to be cancelled — SIGINT or SIGTERM via
	// signal.NotifyContext. For daemonized agents we'd normally ignore
	// SIGINT (PTY child processes can propagate it via Ctrl+C), but
	// console-mode breeze-agent is interactive and SIGINT should
	// shutdown cleanly just like SIGTERM.
	<-ctx.Done()
	log.Info("shutting down agent", "reason", ctx.Err().Error())

	shutdownAgent(comps)
	log.Info("agent stopped")
}
```

**Note:** the behavior change here is that console-mode breeze-agent now handles SIGINT as a shutdown signal instead of ignoring it. This is intentional — the old SIGINT-ignore behavior was defensive against PTY child processes on Unix daemons, but console mode is not daemonized and Ctrl+C should mean "stop the agent." The Windows service path is unaffected (SCM signals come via the request channel, not Unix signals).

- [ ] **Step 4: Rewrite `service_windows.go` `runAsService` and `Execute`**

Edit `agent/cmd/breeze-agent/service_windows.go`. This is a substantial rewrite of lines 100-165.

**old_string:**

```go
// breezeService implements svc.Handler for the Windows SCM.
type breezeService struct {
	startFn  func() (*agentComponents, error)
	stopOnce sync.Once
	stopCh   chan struct{}
}

// runAsService runs the agent under the Windows Service Control Manager.
// startFn is called once the SCM has accepted the service start; it must
// return the running components so they can be shut down on SCM stop.
func runAsService(startFn func() (*agentComponents, error)) error {
	h := &breezeService{
		startFn: startFn,
		stopCh:  make(chan struct{}),
	}
	return svc.Run("BreezeAgent", h)
}

// Execute is the SCM callback. It signals StartPending, runs startFn
// synchronously, then signals Running and enters the SCM control loop.
// SCM requires services to report Running via the changes channel within
// its start timeout, so startFn itself must not block — any long-running
// initialisation (e.g. hardware collection) must be backgrounded by the
// caller before Execute is reached.
func (s *breezeService) Execute(args []string, r <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	const accepted = svc.AcceptStop | svc.AcceptShutdown | svc.AcceptSessionChange

	changes <- svc.Status{State: svc.StartPending}

	comps, err := s.startFn()
	if err != nil {
		log.Error("agent start failed", "error", err.Error())
		writeStartupFailureMarker(err)
		changes <- svc.Status{State: svc.StopPending}
		return true, 1
	}

	scmCh := comps.hb.SCMSessionCh()

	changes <- svc.Status{State: svc.Running, Accepts: accepted}
	log.Info("agent running as Windows service")

	for {
		select {
		case cr := <-r:
			switch cr.Cmd {
			case svc.Interrogate:
				changes <- cr.CurrentStatus
			case svc.Stop, svc.Shutdown:
				log.Info("SCM requested stop")
				changes <- svc.Status{State: svc.StopPending}
				shutdownAgent(comps)
				return false, 0
			case svc.SessionChange:
				if scmCh != nil {
					sessionID := extractSessionID(cr.EventData)
					select {
					case scmCh <- sessionbroker.SCMSessionEvent{
						EventType: cr.EventType,
						SessionID: sessionID,
					}:
					default:
						// Channel full — lifecycle manager will catch up
						// on the next reconcile tick.
					}
				}
			default:
				log.Warn(fmt.Sprintf("unexpected SCM control request #%d", cr.Cmd))
			}
		}
	}
}
```

**new_string:**

```go
// breezeService implements svc.Handler for the Windows SCM.
type breezeService struct {
	cfgFile  string
	stopOnce sync.Once
	stopCh   chan struct{}
}

// runAsService runs the agent under the Windows Service Control Manager.
// It takes the cfgFile path instead of a startFn closure so Execute can
// load config synchronously and decide whether to use the enrolled
// (synchronous) or unenrolled (async-after-Running) start path.
func runAsService(cfgFile string) error {
	h := &breezeService{
		cfgFile: cfgFile,
		stopCh:  make(chan struct{}),
	}
	return svc.Run("BreezeAgent", h)
}

// Execute is the SCM callback. It loads config synchronously, then
// splits on config.IsEnrolled:
//
//   - Enrolled: run startAgent synchronously (preserves today's
//     "post-enroll mTLS/heartbeat init failures fail the install"
//     guarantee — Decision 6 from the spec).
//   - Unenrolled: signal Running immediately (SCM start deadline
//     would otherwise kill us while waitForEnrollment blocks), then
//     wait for enrollment while staying responsive to Stop/Shutdown,
//     then run startAgent. Failures here are post-install and stop
//     the service but cannot roll back the MSI.
//
// Both branches converge on runServiceLoopFn for the steady-state SCM
// control loop. runServiceLoopFn is a test seam — production assigns
// it to runServiceLoop at package init.
func (s *breezeService) Execute(args []string, r <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	const accepted = svc.AcceptStop | svc.AcceptShutdown | svc.AcceptSessionChange

	changes <- svc.Status{State: svc.StartPending}

	cfg, err := config.Load(s.cfgFile)
	if err != nil {
		log.Error("failed to load config", "error", err.Error())
		writeStartupFailureMarker(err)
		changes <- svc.Status{State: svc.StopPending}
		return true, 1
	}
	initBootstrapLogging(cfg)

	if config.IsEnrolled(cfg) {
		// --- Synchronous enrolled path (today's behaviour) ---
		// startAgentFn is a package-level test seam defaulting to
		// startAgent. Any failure here (mTLS, heartbeat, log shipper,
		// state file) reaches SCM as a start failure, which the MSI
		// installer promotes to Error 1920 → 1603 rollback.
		comps, err := startAgentFn(cfg)
		if err != nil {
			log.Error("agent start failed", "error", err.Error())
			writeStartupFailureMarker(err)
			changes <- svc.Status{State: svc.StopPending}
			return true, 1
		}
		changes <- svc.Status{State: svc.Running, Accepts: accepted}
		log.Info("agent running as Windows service")
		return runServiceLoopFn(comps, r, changes)
	}

	// --- Async unenrolled path (MSI install with no creds) ---
	// SCM MUST see Running before we block in waitForEnrollmentFn or
	// the service start deadline (~30s) will kill the process.
	changes <- svc.Status{State: svc.Running, Accepts: accepted}
	log.Info("agent running as Windows service (waiting for enrollment)")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	enrolledCh := make(chan *config.Config, 1)
	go func() {
		enrolledCh <- waitForEnrollmentFn(ctx, s.cfgFile)
	}()

	// Stay responsive to SCM control requests while waiting. Drop
	// session change events — we have no heartbeat wired up yet, and
	// the session broker's reconciliation loop will catch up once
	// startAgent completes.
	var enrolledCfg *config.Config
waitLoop:
	for {
		select {
		case cfg := <-enrolledCh:
			enrolledCfg = cfg
			break waitLoop
		case cr := <-r:
			switch cr.Cmd {
			case svc.Interrogate:
				changes <- cr.CurrentStatus
			case svc.Stop, svc.Shutdown:
				log.Info("SCM stop while waiting for enrollment")
				cancel()
				changes <- svc.Status{State: svc.StopPending}
				return false, 0
			}
			// svc.SessionChange: ignore. No comps yet.
		}
	}

	if enrolledCfg == nil {
		// ctx cancelled without enrollment; handled above.
		return false, 0
	}

	// Run the real startup pipeline. Failures here are post-install
	// and cannot roll back the MSI — we log, write the failure marker,
	// and stop the service.
	comps, err := startAgentFn(enrolledCfg)
	if err != nil {
		log.Error("agent start failed after deferred enrollment",
			"error", err.Error())
		writeStartupFailureMarker(err)
		changes <- svc.Status{State: svc.StopPending}
		return true, 1
	}
	return runServiceLoopFn(comps, r, changes)
}

// runServiceLoop is the post-startup SCM control loop shared by both
// Execute branches. It handles Interrogate, Stop, Shutdown, and
// SessionChange requests, and calls shutdownAgent(comps) on stop.
// Extracted from the old Execute body so the enrolled and unenrolled
// paths can share it.
func runServiceLoop(comps *agentComponents, r <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	scmCh := comps.hb.SCMSessionCh()

	for cr := range r {
		switch cr.Cmd {
		case svc.Interrogate:
			changes <- cr.CurrentStatus
		case svc.Stop, svc.Shutdown:
			log.Info("SCM requested stop")
			changes <- svc.Status{State: svc.StopPending}
			shutdownAgent(comps)
			return false, 0
		case svc.SessionChange:
			if scmCh != nil {
				sessionID := extractSessionID(cr.EventData)
				select {
				case scmCh <- sessionbroker.SCMSessionEvent{
					EventType: cr.EventType,
					SessionID: sessionID,
				}:
				default:
					// Channel full — lifecycle manager will catch up
					// on the next reconcile tick.
				}
			}
		default:
			log.Warn(fmt.Sprintf("unexpected SCM control request #%d", cr.Cmd))
		}
	}
	return false, 0
}
```

- [ ] **Step 5: Add `context` and `config` imports to `service_windows.go`**

Grep for existing imports:

```bash
grep -n '"context"\|"github.com/breeze-rmm/agent/internal/config"' agent/cmd/breeze-agent/service_windows.go
```

If missing, add to the import block. The current imports at lines 5-19 already include `"github.com/breeze-rmm/agent/internal/config"` — verify before editing.

- [ ] **Step 6: Cross-compile for all three platforms**

Run from `agent/`:

```bash
GOOS=windows GOARCH=amd64 go build ./cmd/breeze-agent/...
GOOS=darwin  GOARCH=amd64 go build ./cmd/breeze-agent/...
GOOS=linux   GOARCH=amd64 go build ./cmd/breeze-agent/...
```

Expected: all three exit 0 with no output. If the Windows build fails with `undefined: runServiceLoop`, verify Task 6's `service_seams_windows.go` references `runServiceLoop` by the same name as defined in this task.

- [ ] **Step 7: Run the full cmd/breeze-agent test suite**

```bash
go test ./cmd/breeze-agent/... -race
```

Expected: all tests pass on the current host platform (macOS). Windows-gated tests (service_windows_test.go) don't exist yet — they come in Task 9.

- [ ] **Step 8: Commit**

```bash
git add agent/cmd/breeze-agent/main.go agent/cmd/breeze-agent/service_windows.go
git commit -m "$(cat <<'EOF'
refactor(agent): split startAgent; service wrapper forks on IsEnrolled

startAgent now takes an already-enrolled *config.Config and fails
fast if the caller supplied an unenrolled one. The enrollment check
+ error return that lived at the top of startAgent is gone; callers
are responsible for checking IsEnrolled and waiting if needed.

runAgent (console / Unix service path) loads config, calls
initBootstrapLogging, wires signal.NotifyContext to SIGINT/SIGTERM,
and waits for enrollment via waitForEnrollmentFn when needed before
calling startAgentFn.

runAsService now takes cfgFile instead of a startFn closure.
Execute splits into two branches:

 - Enrolled: synchronous startAgentFn, Running signaled after success.
   Preserves today's "post-enroll init failure fails the MSI install"
   guarantee (spec decision 6).

 - Unenrolled: Running signaled immediately (SCM start deadline),
   then waitForEnrollmentFn in a goroutine while the main Execute
   stays responsive to Stop/Shutdown, then startAgentFn. Failures
   on this path stop the service but cannot roll back the MSI.

Both branches converge on runServiceLoop(comps, r, changes) — the
post-startup SCM control loop extracted from the old Execute body
into its own function.

Behaviour change: console-mode breeze-agent now treats SIGINT as
shutdown instead of ignoring it. The Windows service is unaffected
(SCM signals arrive via the request channel).

Issue #411.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Windows service tests

**Context for engineer:** These tests only run with `GOOS=windows`, but the implementer may write them on macOS/Linux and verify compilation via `GOOS=windows go build ./cmd/breeze-agent/...`. The three tests exercise the enrolled path, the unenrolled path, and the stop-while-waiting path using `installServiceStubs(t)` — a shared helper that swaps `startAgentFn`, `waitForEnrollmentFn`, and `runServiceLoopFn` with stubs that record call ordering into an events channel. The stubbed `runServiceLoopFn` returns on the first Stop request so tests can cleanly terminate `Execute`.

**Files:**
- Create: `agent/cmd/breeze-agent/service_windows_test.go`

- [ ] **Step 1: Create the test file**

Create `agent/cmd/breeze-agent/service_windows_test.go`:

```go
//go:build windows

package main

import (
	"context"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"golang.org/x/sys/windows/svc"
)

// installServiceStubs wires all three Execute test seams to stubs that
// record call ordering into events. Returns a release() func that
// unblocks any stub waiting on releaseCh (used by the unenrolled-path
// tests). Registers t.Cleanup to restore originals.
func installServiceStubs(t *testing.T) (events chan string, release func()) {
	t.Helper()
	origStart := startAgentFn
	origWait := waitForEnrollmentFn
	origLoop := runServiceLoopFn
	t.Cleanup(func() {
		startAgentFn = origStart
		waitForEnrollmentFn = origWait
		runServiceLoopFn = origLoop
	})

	events = make(chan string, 16)
	releaseCh := make(chan struct{})
	release = func() { close(releaseCh) }

	startAgentFn = func(cfg *config.Config) (*agentComponents, error) {
		events <- "startAgent"
		return &agentComponents{}, nil // zero-value; runServiceLoopFn never dereferences
	}
	waitForEnrollmentFn = func(ctx context.Context, cfgFile string) *config.Config {
		events <- "waitForEnrollment.enter"
		select {
		case <-releaseCh:
			events <- "waitForEnrollment.release"
			cfg, _ := config.Load(cfgFile)
			return cfg
		case <-ctx.Done():
			events <- "waitForEnrollment.cancelled"
			return nil
		}
	}
	runServiceLoopFn = func(comps *agentComponents, r <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
		events <- "runServiceLoop"
		for cr := range r {
			if cr.Cmd == svc.Stop || cr.Cmd == svc.Shutdown {
				changes <- svc.Status{State: svc.StopPending}
				return false, 0
			}
		}
		return false, 0
	}
	return events, release
}

// writeEnrolledConfigFile writes agent.yaml + secrets.yaml that
// config.Load + IsEnrolled will accept as enrolled. Returns the
// agent.yaml path.
func writeEnrolledConfigFile(t *testing.T, dir string) string {
	t.Helper()
	agentPath := filepath.Join(dir, "agent.yaml")
	if err := os.WriteFile(agentPath, []byte("agent_id: test-agent-id\nserver_url: https://test.example\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	secretsPath := filepath.Join(dir, "secrets.yaml")
	if err := os.WriteFile(secretsPath, []byte("auth_token: test-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return agentPath
}

// writeUnenrolledConfigFile writes an empty agent.yaml (no AgentID,
// no AuthToken) so config.Load succeeds but IsEnrolled returns false.
func writeUnenrolledConfigFile(t *testing.T, dir string) string {
	t.Helper()
	agentPath := filepath.Join(dir, "agent.yaml")
	if err := os.WriteFile(agentPath, []byte("server_url: https://test.example\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return agentPath
}

// execResult captures the return values from breezeService.Execute for
// goroutine-based tests.
type execResult struct {
	ssec      bool
	errno     uint32
	changes   []svc.Status
	changesMu *atomic.Int32
}

// runExecuteInGoroutine starts Execute in a goroutine with mock changes
// and request channels. Returns channels the test can drive.
func runExecuteInGoroutine(t *testing.T, s *breezeService) (changes chan svc.Status, requests chan svc.ChangeRequest, done chan struct{}) {
	t.Helper()
	changes = make(chan svc.Status, 16)
	requests = make(chan svc.ChangeRequest, 4)
	done = make(chan struct{})
	go func() {
		defer close(done)
		s.Execute(nil, requests, changes)
	}()
	return
}

func TestExecute_EnrolledPath_SignalsRunningAfterStartFn(t *testing.T) {
	dir := t.TempDir()
	cfgFile := writeEnrolledConfigFile(t, dir)

	events, _ := installServiceStubs(t)
	s := &breezeService{cfgFile: cfgFile, stopCh: make(chan struct{})}

	changes, requests, done := runExecuteInGoroutine(t, s)

	// Expected event sequence on enrolled path:
	// 1. startAgent (from stubbed startAgentFn)
	// 2. runServiceLoop (from stubbed runServiceLoopFn)
	if got := <-events; got != "startAgent" {
		t.Errorf("first event = %q, want startAgent", got)
	}
	if got := <-events; got != "runServiceLoop" {
		t.Errorf("second event = %q, want runServiceLoop", got)
	}

	// Drain changes. Expected: StartPending, Running. The Running signal
	// MUST arrive after the stubbed startAgentFn observed its call.
	first := <-changes
	if first.State != svc.StartPending {
		t.Errorf("first state = %v, want StartPending", first.State)
	}
	second := <-changes
	if second.State != svc.Running {
		t.Errorf("second state = %v, want Running", second.State)
	}

	// Tell Execute to stop so the goroutine terminates.
	requests <- svc.ChangeRequest{Cmd: svc.Stop}
	select {
	case <-done:
	case <-time.After(1 * time.Second):
		t.Fatal("Execute did not return within 1s of Stop")
	}
}

func TestExecute_UnenrolledPath_SignalsRunningBeforeWait(t *testing.T) {
	dir := t.TempDir()
	cfgFile := writeUnenrolledConfigFile(t, dir)

	events, release := installServiceStubs(t)
	s := &breezeService{cfgFile: cfgFile, stopCh: make(chan struct{})}

	changes, requests, done := runExecuteInGoroutine(t, s)

	// Expected: StartPending, Running before any waitForEnrollment.enter.
	first := <-changes
	if first.State != svc.StartPending {
		t.Errorf("first state = %v, want StartPending", first.State)
	}
	second := <-changes
	if second.State != svc.Running {
		t.Errorf("second state = %v, want Running", second.State)
	}

	// Now the stub should record that it entered waitForEnrollment.
	if got := <-events; got != "waitForEnrollment.enter" {
		t.Errorf("first event = %q, want waitForEnrollment.enter", got)
	}

	// Upgrade the on-disk config to enrolled, then release the stub
	// so the post-wait branch runs startAgentFn.
	_ = writeEnrolledConfigFile(t, dir)
	release()

	// Expected remaining event sequence: release, startAgent, runServiceLoop.
	if got := <-events; got != "waitForEnrollment.release" {
		t.Errorf("event after release = %q, want waitForEnrollment.release", got)
	}
	if got := <-events; got != "startAgent" {
		t.Errorf("event = %q, want startAgent", got)
	}
	if got := <-events; got != "runServiceLoop" {
		t.Errorf("event = %q, want runServiceLoop", got)
	}

	// Terminate.
	requests <- svc.ChangeRequest{Cmd: svc.Stop}
	select {
	case <-done:
	case <-time.After(1 * time.Second):
		t.Fatal("Execute did not return within 1s of Stop")
	}
}

func TestExecute_StopWhileWaiting(t *testing.T) {
	dir := t.TempDir()
	cfgFile := writeUnenrolledConfigFile(t, dir)

	events, _ := installServiceStubs(t)
	s := &breezeService{cfgFile: cfgFile, stopCh: make(chan struct{})}

	changes, requests, done := runExecuteInGoroutine(t, s)

	// Drain StartPending + Running.
	<-changes
	<-changes

	// Wait until the stub has entered waitForEnrollment.
	if got := <-events; got != "waitForEnrollment.enter" {
		t.Errorf("event = %q, want waitForEnrollment.enter", got)
	}

	// Stop without releasing the stub. The stub's ctx.Done() branch
	// should fire and the unenrolled path should cleanly return.
	requests <- svc.ChangeRequest{Cmd: svc.Stop}

	if got := <-events; got != "waitForEnrollment.cancelled" {
		t.Errorf("event = %q, want waitForEnrollment.cancelled", got)
	}

	// Expect a StopPending signal.
	select {
	case state := <-changes:
		if state.State != svc.StopPending {
			t.Errorf("state = %v, want StopPending", state.State)
		}
	case <-time.After(1 * time.Second):
		t.Fatal("no StopPending signal within 1s")
	}

	select {
	case <-done:
	case <-time.After(1 * time.Second):
		t.Fatal("Execute did not return within 1s of Stop")
	}
}
```

- [ ] **Step 2: Verify the test file compiles for Windows**

Run from `agent/`:

```bash
GOOS=windows GOARCH=amd64 go vet ./cmd/breeze-agent/...
```

Expected: exit 0. `go vet` will report any unused imports, type mismatches, or signature drift between the stubs and the production code.

Also run:

```bash
GOOS=windows GOARCH=amd64 go test -c -o /dev/null ./cmd/breeze-agent/
```

Expected: exit 0. This compiles the Windows test binary to a throwaway file, which catches any issues that `go vet` misses (e.g., missing types).

- [ ] **Step 3: Verify non-Windows builds are unaffected**

```bash
GOOS=darwin  GOARCH=amd64 go build ./cmd/breeze-agent/...
GOOS=linux   GOARCH=amd64 go build ./cmd/breeze-agent/...
```

Expected: both exit 0. The test file has a `//go:build windows` tag so these builds ignore it entirely.

- [ ] **Step 4: Commit**

```bash
git add agent/cmd/breeze-agent/service_windows_test.go
git commit -m "$(cat <<'EOF'
test(agent): Windows service wrapper state-transition coverage

Three Windows-gated tests exercise breezeService.Execute on the
enrolled path, the unenrolled path, and the stop-while-waiting path
via a shared installServiceStubs(t) helper that swaps startAgentFn,
waitForEnrollmentFn, and runServiceLoopFn with stubs that record
call ordering into an events channel.

Stubbed runServiceLoopFn returns on Stop so Execute can terminate
cleanly; stubbed startAgentFn returns a zero-value *agentComponents
that never gets dereferenced (bypassing shutdownAgent's comps.hb
and comps.wsClient nil dereferences entirely).

Proves spec decision 6: enrolled path signals Running AFTER
startAgentFn; unenrolled path signals Running BEFORE waiting; Stop
during wait cleanly cancels the ctx and returns.

Tests run with go test on Windows only; verified compilable via
GOOS=windows go test -c on macOS/Linux.

Issue #411.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Update `breeze.wxs` — `EnrollAgent` CA `Return="check"`

**Context for engineer:** The Go side is now safe: the unenrolled path starts a service that sits in a wait loop, and enrollment failures route through `enrollError` with exit codes 10-16. Now we make the MSI actually surface those failures by changing the EnrollAgent custom action from `Return="ignore"` to `Return="check"`. When creds are supplied and the Go binary exits non-zero, MSI will roll back the install cleanly.

No changes to `<ServiceControl Start="install" Wait="yes" />` — the service still starts during install, and the wait-loop path makes that start succeed even without enrollment.

**Files:**
- Modify: `agent/installer/breeze.wxs` (find the `<CustomAction Id="EnrollAgent"` block around line 170)

- [ ] **Step 1: Read the current EnrollAgent block**

Run:

```bash
grep -n 'Id="EnrollAgent"\|Return="ignore"\|Return="check"' agent/installer/breeze.wxs
```

Expected: one line showing `Id="EnrollAgent"` and one showing `Return="ignore"` (currently).

- [ ] **Step 2: Change `Return="ignore"` to `Return="check"` and update the comment**

**old_string:**

```xml
    <CustomAction
      Id="EnrollAgent"
      FileRef="filBreezeAgentExe"
      ExeCommand="enroll &quot;[ENROLLMENT_KEY]&quot; --server &quot;[SERVER_URL]&quot; --enrollment-secret &quot;[ENROLLMENT_SECRET]&quot; --quiet"
      Execute="deferred"
      Impersonate="no"
      Return="ignore"
      HideTarget="yes" />
```

**new_string:**

```xml
    <CustomAction
      Id="EnrollAgent"
      FileRef="filBreezeAgentExe"
      ExeCommand="enroll &quot;[ENROLLMENT_KEY]&quot; --server &quot;[SERVER_URL]&quot; --enrollment-secret &quot;[ENROLLMENT_SECRET]&quot; --quiet"
      Execute="deferred"
      Impersonate="no"
      Return="check"
      HideTarget="yes" />
```

- [ ] **Step 3: Update the InstallExecuteSequence XML comment**

Grep for the existing comment:

```bash
grep -n 'Return="ignore" on the EnrollAgent CA\|Enrollment runs after file copy' agent/installer/breeze.wxs
```

Replace with the new comment that describes the `Return="check"` semantics + the wait-loop deferred-enrollment path.

**old_string:**

```xml
      <!-- Run enrollment after file copy but before InstallServices so the
           BreezeAgent service starts with a valid agent.yaml already in
           place; no restart dance required.

           Return="ignore" on the EnrollAgent CA means enrollment failure
           does NOT roll back the install. If enrollment fails, the service
           will still start but the device stays unenrolled. To debug:
           check %ProgramData%\Breeze\logs\agent.log for the structured
           error trail, or re-run breeze-agent.exe enroll manually from an
           elevated shell with the enrollment key and server flags. -->
      <Custom Action="EnrollAgent" Before="InstallServices" Condition="NOT Installed AND SERVER_URL AND ENROLLMENT_KEY" />
```

**new_string:**

```xml
      <!-- Enrollment runs after file copy but before InstallServices.

           Return="check" on the EnrollAgent CA means a non-zero exit
           from breeze-agent.exe enroll rolls back the install cleanly.
           Admins see a specific cause in four places:

             1. install.log (captured from the CA's stderr)
             2. C:\ProgramData\Breeze\logs\agent.log (slog structured)
             3. C:\ProgramData\Breeze\logs\enroll-last-error.txt
                (single-line timestamped, survives rollback because
                CA-written files are opaque to MSI)
             4. Event Viewer → Application → BreezeAgent (Error)

           Installs without ENROLLMENT_KEY skip this CA entirely
           (condition below requires both SERVER_URL and ENROLLMENT_KEY).
           The service starts anyway and idles in a wait-for-enrollment
           loop (see waitForEnrollment in cmd/breeze-agent/main.go), so
           a later `breeze-agent enroll KEY --server URL` is picked up
           live without a service restart. This is the intended flow
           for imaged/sysprep'd deployments. -->
      <Custom Action="EnrollAgent" Before="InstallServices" Condition="NOT Installed AND SERVER_URL AND ENROLLMENT_KEY" />
```

- [ ] **Step 4: Validate the WiX file syntax**

If WiX is available in the environment, run:

```bash
# Optional — only if wix.exe / candle.exe are installed
which wix 2>/dev/null && wix build --help >/dev/null
```

If WiX isn't available locally (macOS/Linux dev environment), rely on the CI pipeline that #410 already runs to catch XML errors. This task's change is a two-character attribute edit and a comment rewrite — low risk of WiX syntax breakage.

Verify the XML still parses as well-formed:

```bash
xmllint --noout agent/installer/breeze.wxs
```

Expected: exit 0 with no output. If `xmllint` isn't installed, skip this step — manual smoke testing in Task 11 will catch any breakage.

- [ ] **Step 5: Commit**

```bash
git add agent/installer/breeze.wxs
git commit -m "$(cat <<'EOF'
fix(installer): EnrollAgent CA Return=check — surface enroll failures

Previously Return="ignore" swallowed the Go enroll binary's non-zero
exit codes. A bad ENROLLMENT_KEY typo would cause the CA to silently
fail, then InstallServices would try to start BreezeAgent with an
unenrolled config, the service would exit with an error, SCM would
report Error 1920, and Vital="yes" on ServiceInstall would roll back
the whole install with exit 1603. Admins saw "Error 1603" in the
install log and nothing else.

Return="check" makes the CA's exit code fatal to the install, and
the Go enroll binary now writes a human-readable cause to four sinks
before exiting. Admins can find the actual cause without guessing.

Installs without ENROLLMENT_KEY skip the CA entirely thanks to the
pre-existing condition; the Go side's waitForEnrollment loop means
the service still starts and waits for a later `breeze-agent enroll`
call (needed for imaged/sysprep deployments).

Issue #411.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Final verification — full test suite + cross-compile

**Context for engineer:** This is a verification-only task. No code changes. Confirm the whole agent package still builds and tests pass on all three platforms before handing off for manual MSI smoke testing.

- [ ] **Step 1: Full test suite with race detection**

Run from `agent/`:

```bash
go test -race ./...
```

Expected: PASS on all packages. If any test fails, the engineer must stop and debug before proceeding.

- [ ] **Step 2: Cross-compile for all three platforms**

```bash
GOOS=windows GOARCH=amd64 go build ./cmd/breeze-agent/...
GOOS=darwin  GOARCH=amd64 go build ./cmd/breeze-agent/...
GOOS=darwin  GOARCH=arm64 go build ./cmd/breeze-agent/...
GOOS=linux   GOARCH=amd64 go build ./cmd/breeze-agent/...
```

Expected: all four exit 0 with no output.

- [ ] **Step 3: `go vet` on the whole tree**

```bash
go vet ./...
```

Expected: exit 0 with no output.

- [ ] **Step 4: Windows test compilation check**

```bash
GOOS=windows GOARCH=amd64 go test -c -o /dev/null ./cmd/breeze-agent/
```

Expected: exit 0. Confirms service_windows_test.go compiles for Windows.

- [ ] **Step 5: No commit needed — this is a verification pass**

If all four steps pass, move to Task 12. If any fail, roll back to Task 10 and debug.

---

## Task 12: Manual MSI smoke test checklist

**Context for engineer:** The automated tests cover the Go side end-to-end, but the MSI rollback semantics require a real Windows VM. This task is a manual checklist, not an automated task. Run each scenario on a fresh Windows Server 2022 VM (or a throwaway Win11 VM). Build the MSI from the current branch using the existing `build-msi.ps1` script.

Building the MSI is OUT of scope for this plan — #412 is the follow-up to automate signed-MSI builds in CI without cutting a full release. For now, the engineer runs `.github/workflows/release.yml` manually or uses the existing signing pipeline.

- [ ] **Step 1: Build an unsigned MSI for local testing**

On a Windows build host with WiX 4.0.5 and Go 1.25.x installed:

```powershell
cd agent
go build -o breeze-agent-windows-amd64.exe .\cmd\breeze-agent\
go build -o breeze-backup-windows-amd64.exe .\cmd\breeze-backup\
go build -o breeze-watchdog-windows-amd64.exe .\cmd\breeze-watchdog\
cd installer
.\build-msi.ps1 -Version 0.63.0-test
```

Copy the resulting `breeze-agent.msi` to the test VM.

- [ ] **Step 2: Scenario 1 — No credentials (imaged deployment)**

On the test VM, in an elevated PowerShell:

```powershell
msiexec /i breeze-agent.msi /qn /l*v install.log
echo "exit code: $LASTEXITCODE"
```

Expected:
- Exit code 0
- `install.log` contains no `Enrollment failed` lines
- `C:\ProgramData\Breeze\logs\enroll-last-error.txt` is absent
- `sc query BreezeAgent` shows `STATE: 4 RUNNING`
- Event Viewer → Windows Logs → Application → BreezeAgent info entry: "Waiting for enrollment..."
- `C:\ProgramData\Breeze\logs\agent.log` shows the `waitForEnrollment` warning line

- [ ] **Step 3: Scenario 2 — Good credentials (happy path)**

Pick up where Scenario 1 left off. Open an elevated cmd:

```cmd
"C:\Program Files\Breeze\breeze-agent.exe" enroll brz_validkey --server https://valid.example
```

Or uninstall first and retest with credentials via msiexec:

```powershell
msiexec /x breeze-agent.msi /qn
msiexec /i breeze-agent.msi ENROLLMENT_KEY=brz_validkey SERVER_URL=https://valid.example /qn /l*v install2.log
echo "exit code: $LASTEXITCODE"
```

Expected:
- Exit code 0
- `install2.log` shows enrollment CA succeeded (exit 0)
- `C:\ProgramData\Breeze\agent.yaml` contains `agent_id: <uuid>`
- `C:\ProgramData\Breeze\secrets.yaml` exists with `auth_token`
- `sc query BreezeAgent` shows `STATE: 4 RUNNING`
- `enroll-last-error.txt` is absent
- Event Viewer: no BreezeAgent error entries

- [ ] **Step 4: Scenario 3 — Bad credentials (typo key)**

Uninstall first, then:

```powershell
msiexec /x breeze-agent.msi /qn
msiexec /i breeze-agent.msi ENROLLMENT_KEY=brz_typokey SERVER_URL=https://valid.example /qn /l*v install3.log
echo "exit code: $LASTEXITCODE"
```

Expected:
- Exit code 1603 (full rollback)
- `C:\Program Files\Breeze\` does not exist or is empty
- `sc query BreezeAgent` returns "service does not exist"
- `install3.log` contains a line like `Enrollment failed: enrollment key not recognized — verify the key is active in Settings → Enrollment`
- `C:\ProgramData\Breeze\logs\enroll-last-error.txt` EXISTS with a single line like `2026-04-13T14:02:00Z — Enrollment failed: enrollment key not recognized (http 401: ...)`
- Event Viewer → Application → BreezeAgent has one Error entry with event ID 1003 and the same message

- [ ] **Step 5: Scenario 4 — Server unreachable**

```powershell
msiexec /i breeze-agent.msi ENROLLMENT_KEY=brz_any SERVER_URL=https://unreachable.example /qn /l*v install4.log
echo "exit code: $LASTEXITCODE"
```

Expected:
- Exit code 1603
- `install4.log` contains `Enrollment failed: server unreachable at https://unreachable.example — check firewall, DNS, and that SERVER_URL is correct`
- `enroll-last-error.txt` contains the same message
- Event Viewer entry present

- [ ] **Step 6: Scenario 5 — Deferred enrollment (imaged deployment flow)**

Starting from a clean state after Scenario 1's install:

```cmd
"C:\Program Files\Breeze\breeze-agent.exe" enroll brz_validkey --server https://valid.example
```

Expected:
- Command exits 0
- `agent.yaml` and `secrets.yaml` both written
- Within 10 seconds (one wait-loop tick), `C:\ProgramData\Breeze\logs\agent.log` shows `enrollment detected, continuing startup`
- `sc query BreezeAgent` still shows `STATE: 4 RUNNING` (no restart occurred)
- Heartbeats appear in the Breeze UI for the new device within ~30s

- [ ] **Step 7: Document scenario results**

Record the results in a comment on issue #411. Include:
- MSI version tested
- Windows VM version (Server 2022, Win11, etc.)
- Pass/fail for each of Scenarios 1-5
- Full path to `enroll-last-error.txt` content for Scenarios 3 and 4
- Any surprises (UAC prompts, SmartScreen blocks, etc.)

---

## Task 13: Open the pull request

**Context for engineer:** Once Task 11 passes and Task 12's manual smoke tests look clean, open a PR from `fix/msi-enroll-failure-reporting` (or whatever branch name you're using) to `main`.

- [ ] **Step 1: Push the branch**

```bash
git push -u origin worktree-msi-enroll-failure-reporting:fix/msi-enroll-failure-reporting
```

Or if the worktree branch has already been renamed to `fix/msi-enroll-failure-reporting`:

```bash
git push -u origin HEAD:fix/msi-enroll-failure-reporting
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --title "fix(installer): MSI enrollment failure reporting — fix 1603 cascade, surface cause (#411)" --body "$(cat <<'EOF'
## Summary

Fixes #411.

- MSI installs without credentials now succeed; the service starts into a wait-for-enrollment loop for imaged/sysprep'd deployments.
- MSI installs with bad credentials fail cleanly (exit 1603) with a human-readable cause written to four sinks: `install.log` (via stderr), `agent.log` (via slog), `C:\ProgramData\Breeze\logs\enroll-last-error.txt` (single-line timestamped marker), and Windows Event Log (Application / BreezeAgent / Error).
- MSI installs with good credentials continue to work exactly as before (happy path preserved end-to-end).

## Design

See `docs/superpowers/specs/2026-04-13-msi-enrollment-failure-reporting-design.md` for the full design doc with four rounds of review feedback resolved.

## Test plan

- [x] `go test -race ./...` passes on macOS
- [x] Cross-compile clean for windows/amd64, darwin/amd64, darwin/arm64, linux/amd64
- [x] `GOOS=windows go test -c` compiles the Windows-only test binary
- [ ] Manual smoke test on Windows Server 2022 (5 scenarios per Task 12 in the plan)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Post Task 12 results as a PR comment**

Once the manual smoke tests have been completed per Task 12, paste the results as a comment on the PR so reviewers can see the real-world verification without having to run the tests themselves.

---

## Spec Self-Review

Mapping the spec's components onto plan tasks:

| Spec component | Plan task(s) |
|---|---|
| Component 1.a — `config.IsEnrolled` | Task 2 |
| Component 1.b — package-level test seams | Task 6 (cross-platform) + Task 6 (Windows-only file) |
| Component 1.c — split `startAgent` to take cfg | Task 8 |
| Component 1.d — `waitForEnrollment` + poll interval | Task 6 (helper) + Task 7 (tests) |
| Component 1.e — `runAgent` with `signal.NotifyContext` | Task 8 |
| Component 2 — `ErrHTTPStatus` type | Task 1 |
| Component 2 — `enrollError` helper + category enum + classifier + `clearEnrollLastError` + `writeLastErrorFile` + `enrollLastErrorPath` | Task 4 |
| Component 2 — `enrollDevice` failure-site swaps + clear call | Task 5 |
| Component 3 — WiX `Return="check"` + updated comment | Task 10 |
| Component 4 — `Execute` split into enrolled/unenrolled + `runServiceLoop` extraction | Task 8 |
| Component 5 — `internal/eventlog` package | Task 3 |
| Testing — `IsEnrolled` table test | Task 2 |
| Testing — `ErrHTTPStatus` tests | Task 1 |
| Testing — `enroll_error_test.go` | Task 4 |
| Testing — `eventlog_test.go` | Task 3 |
| Testing — `main_test.go` waitForEnrollment trio | Task 7 |
| Testing — `service_windows_test.go` trio with `installServiceStubs` | Task 9 |
| Manual MSI smoke tests (5 scenarios) | Task 12 |

All 17 spec elements are covered. No gaps.

**Placeholder scan:** searched the plan for "TBD", "TODO", "fill in", "similar to", "add appropriate", "handle edge cases". None found. Every step contains actual code or an actual command.

**Type consistency check:**
- `enrollErrCategory` constants are consistent: Task 4 defines `catNetwork`, `catAuth`, `catNotFound`, `catRateLimit`, `catServer`, `catConfig`, `catUnknown`. Task 5 uses `catConfig` and `classifyEnrollError` (which returns `catAuth`/`catNotFound`/etc.). Match.
- `enrollError(cat, friendly, detail)` signature: defined in Task 4, used in Task 5. Match.
- `startAgentFn` / `waitForEnrollmentFn` / `runServiceLoopFn`: defined in Task 6, used in Tasks 8 and 9. Match.
- `waitForEnrollmentPollInterval`: defined in Task 6, used in Task 7. Match.
- `installServiceStubs(t) (events chan string, release func())`: defined and used in Task 9. Match.
- `config.IsEnrolled(cfg *Config) bool`: defined in Task 2, used in Tasks 6, 8. Match.
- `startAgent(cfg *config.Config)`: signature change in Task 8; callers in Task 8 use `startAgentFn(cfg)`. Match.
- `runAsService(cfgFile string)`: signature change in Task 8; caller in `runAgent` (Task 8) uses it. Match.

All signatures internally consistent.
