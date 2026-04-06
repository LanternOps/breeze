# Session-Aware Breeze Assist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace machine-global Assist lifecycle management with per-session state so each interactive session gets its own config, status, watcher, and spawn/stop lifecycle.

**Architecture:** Keep `helper.Manager` as the external API (stable heartbeat interface). Replace its internals with `map[sessionKey]*sessionState`. A `SessionEnumerator` discovers active sessions via OS APIs. The reconcile loop in `Apply()` starts/stops Assist per session. Platform spawn/stop uses verified PIDs instead of process-name commands.

**Tech Stack:** Go, platform-specific APIs (WTS on Windows, utmpx/w on macOS, loginctl on Linux), YAML config files.

**Spec:** `docs/superpowers/specs/2026-03-30-session-aware-assist-design.md`

---

### Task 1: Process Identity Verification

Extend the existing `processExists()` in `process_check_*.go` with `isOurProcess()` that verifies the executable path matches the helper binary. This prevents PID-reuse misidentification.

**Files:**
- Modify: `agent/internal/helper/process_check_unix.go` (keep `processExists` only)
- Create: `agent/internal/helper/process_check_darwin.go` (`processExePath`, `isOurProcess` via sysctl)
- Create: `agent/internal/helper/process_check_linux.go` (`processExePath`, `isOurProcess` via /proc)
- Modify: `agent/internal/helper/process_check_windows.go` (add `processExePath`, `isOurProcess`)
- Create: `agent/internal/helper/process_check_test.go`

- [ ] **Step 1: Write failing tests for `isOurProcess`**

```go
// agent/internal/helper/process_check_test.go
package helper

import (
	"os"
	"testing"
)

func TestIsOurProcess_CurrentProcess(t *testing.T) {
	// Our own process should match our own executable path
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	pid := os.Getpid()

	if !isOurProcess(pid, exe) {
		t.Errorf("isOurProcess(%d, %q) = false, want true", pid, exe)
	}
}

func TestIsOurProcess_WrongPath(t *testing.T) {
	pid := os.Getpid()
	if isOurProcess(pid, "/nonexistent/binary") {
		t.Errorf("isOurProcess(%d, /nonexistent/binary) = true, want false")
	}
}

func TestIsOurProcess_DeadPID(t *testing.T) {
	// PID 0 is never a user process
	if isOurProcess(0, "/some/binary") {
		t.Error("isOurProcess(0, ...) = true, want false")
	}
}

func TestProcessExePath_CurrentProcess(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	got, err := processExePath(os.Getpid())
	if err != nil {
		t.Fatalf("processExePath: %v", err)
	}
	// Resolve symlinks for comparison (os.Executable may return symlink)
	if got != exe {
		// Try resolving both
		t.Logf("got=%q exe=%q (may differ by symlink resolution)", got, exe)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd agent && go test -race ./internal/helper/ -run TestIsOurProcess -v`
Expected: FAIL — `isOurProcess` and `processExePath` are undefined.

- [ ] **Step 3: Implement `processExePath` and `isOurProcess` — split into platform files**

The existing `process_check_unix.go` (`//go:build !windows`) must be split into separate darwin and linux files because `processExePath` uses different OS APIs per platform. Keep `processExists` in the shared unix file (or duplicate — it's 6 lines).

**Create `agent/internal/helper/process_check_darwin.go`:**

```go
//go:build darwin

package helper

import (
	"bytes"
	"fmt"
	"path/filepath"
	"syscall"
	"unsafe"
)

// processExePath returns the executable path of the given PID on macOS.
// Uses raw sysctl with KERN_PROCARGS2 MIB (no cgo required).
func processExePath(pid int) (string, error) {
	const (
		ctlKern       = 1  // CTL_KERN
		kernProcargs2 = 49 // KERN_PROCARGS2
	)

	mib := [3]int32{ctlKern, kernProcargs2, int32(pid)}

	// First call: get buffer size
	n := uintptr(0)
	_, _, errno := syscall.Syscall6(
		syscall.SYS___SYSCTL,
		uintptr(unsafe.Pointer(&mib[0])), 3,
		0, uintptr(unsafe.Pointer(&n)),
		0, 0,
	)
	if errno != 0 {
		return "", fmt.Errorf("sysctl size query for pid %d: %w", pid, errno)
	}

	// Second call: read data
	buf := make([]byte, n)
	_, _, errno = syscall.Syscall6(
		syscall.SYS___SYSCTL,
		uintptr(unsafe.Pointer(&mib[0])), 3,
		uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&n)),
		0, 0,
	)
	if errno != 0 {
		return "", fmt.Errorf("sysctl data query for pid %d: %w", pid, errno)
	}

	// Layout: [argc uint32] [exe_path \0] [args \0 ...]
	if n < 8 {
		return "", fmt.Errorf("procargs2 buffer too short: %d bytes", n)
	}
	rest := buf[4:n] // skip argc
	if idx := bytes.IndexByte(rest, 0); idx > 0 {
		return string(rest[:idx]), nil
	}
	return string(rest), nil
}

// isOurProcess returns true only if pid is a running process whose
// executable path matches binaryPath.
func isOurProcess(pid int, binaryPath string) bool {
	if pid <= 0 {
		return false
	}
	exePath, err := processExePath(pid)
	if err != nil {
		return false
	}
	return filepath.Clean(exePath) == filepath.Clean(binaryPath)
}
```

**Create `agent/internal/helper/process_check_linux.go`:**

```go
//go:build linux

package helper

import (
	"fmt"
	"os"
	"path/filepath"
)

// processExePath returns the executable path of the given PID on Linux.
func processExePath(pid int) (string, error) {
	path, err := os.Readlink(fmt.Sprintf("/proc/%d/exe", pid))
	if err != nil {
		return "", fmt.Errorf("readlink /proc/%d/exe: %w", pid, err)
	}
	return path, nil
}

// isOurProcess returns true only if pid is a running process whose
// executable path matches binaryPath.
func isOurProcess(pid int, binaryPath string) bool {
	if pid <= 0 {
		return false
	}
	exePath, err := processExePath(pid)
	if err != nil {
		return false
	}
	return filepath.Clean(exePath) == filepath.Clean(binaryPath)
}
```

**Update `agent/internal/helper/process_check_unix.go`** build tag to only contain `processExists` (shared between darwin and linux):

```go
//go:build !windows

package helper

import (
	"os"
	"syscall"
)

func processExists(pid int) bool {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return proc.Signal(syscall.Signal(0)) == nil
}
```

- [ ] **Step 4: Implement `processExePath` and `isOurProcess` on Windows**

Add to `agent/internal/helper/process_check_windows.go`:

```go
// processExePath returns the executable path of the given PID.
func processExePath(pid int) (string, error) {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return "", fmt.Errorf("OpenProcess(%d): %w", pid, err)
	}
	defer windows.CloseHandle(handle)

	var buf [windows.MAX_PATH]uint16
	size := uint32(len(buf))
	if err := windows.QueryFullProcessImageName(handle, 0, &buf[0], &size); err != nil {
		return "", fmt.Errorf("QueryFullProcessImageName(%d): %w", pid, err)
	}
	return windows.UTF16ToString(buf[:size]), nil
}

// isOurProcess returns true only if pid is a running process whose
// executable path matches binaryPath. Prevents PID-reuse misidentification.
func isOurProcess(pid int, binaryPath string) bool {
	if pid <= 0 {
		return false
	}
	exePath, err := processExePath(pid)
	if err != nil {
		return false
	}
	return strings.EqualFold(filepath.Clean(exePath), filepath.Clean(binaryPath))
}
```

Add necessary imports: `"fmt"`, `"path/filepath"`, `"strings"`.

Note: Windows uses case-insensitive path comparison via `strings.EqualFold`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd agent && go test -race ./internal/helper/ -run TestIsOurProcess -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
cd agent && git add internal/helper/process_check_unix.go internal/helper/process_check_windows.go internal/helper/process_check_test.go
git commit -m "feat(helper): add isOurProcess for PID-verified process identity"
```

---

### Task 2: Session Types and Enumerator Interface

Define `sessionState`, `SessionEnumerator`, `SessionInfo`, and the updated `SpawnFunc` type. Pure data types with path derivation — no platform code yet.

**Files:**
- Create: `agent/internal/helper/session_state.go`
- Create: `agent/internal/helper/session_state_test.go`

- [ ] **Step 1: Write failing tests for session state path derivation**

```go
// agent/internal/helper/session_state_test.go
package helper

import (
	"path/filepath"
	"testing"
)

func TestNewSessionState_PathDerivation(t *testing.T) {
	baseDir := "/Library/Application Support/Breeze"

	state := newSessionState("501", baseDir)

	wantConfig := filepath.Join(baseDir, "sessions", "501", "helper_config.yaml")
	wantStatus := filepath.Join(baseDir, "sessions", "501", "helper_status.yaml")

	if state.configPath != wantConfig {
		t.Errorf("configPath = %q, want %q", state.configPath, wantConfig)
	}
	if state.statusPath != wantStatus {
		t.Errorf("statusPath = %q, want %q", state.statusPath, wantStatus)
	}
	if state.key != "501" {
		t.Errorf("key = %q, want %q", state.key, "501")
	}
}

func TestNewSessionState_WindowsSessionKey(t *testing.T) {
	baseDir := `C:\ProgramData\Breeze`

	state := newSessionState("2", baseDir)

	wantConfig := filepath.Join(baseDir, "sessions", "2", "helper_config.yaml")
	if state.configPath != wantConfig {
		t.Errorf("configPath = %q, want %q", state.configPath, wantConfig)
	}
}

func TestSessionState_ConfigUnchanged(t *testing.T) {
	state := newSessionState("501", "/tmp/breeze")

	cfg := &Config{
		ShowOpenPortal:     true,
		ShowDeviceInfo:     true,
		ShowRequestSupport: false,
		PortalUrl:          "https://portal.example.com",
	}

	// First time: config is nil, so it should be "changed"
	if state.configUnchanged(cfg) {
		t.Error("configUnchanged should be false when lastConfig is nil")
	}

	state.lastConfig = cfg

	// Same config: should be unchanged
	if !state.configUnchanged(cfg) {
		t.Error("configUnchanged should be true for identical config")
	}

	// Different config: should be changed
	cfg2 := &Config{
		ShowOpenPortal:     false,
		ShowDeviceInfo:     true,
		ShowRequestSupport: false,
		PortalUrl:          "https://portal.example.com",
	}
	if state.configUnchanged(cfg2) {
		t.Error("configUnchanged should be false for different config")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd agent && go test -race ./internal/helper/ -run TestNewSessionState -v`
Expected: FAIL — `newSessionState`, `configUnchanged` undefined.

- [ ] **Step 3: Implement session_state.go**

```go
// agent/internal/helper/session_state.go
package helper

import (
	"path/filepath"
	"time"
)

// SessionEnumerator discovers active interactive sessions via OS-level APIs.
// Implementations must NOT depend on broker connections — they use WTS (Windows),
// utmpx (macOS), or loginctl (Linux) to enumerate sessions independently.
type SessionEnumerator interface {
	ActiveSessions() []SessionInfo
}

// SessionInfo describes an interactive session eligible for Assist.
type SessionInfo struct {
	Key      string // WinSessionID (Windows) or UID string (Unix)
	Username string
	Active   bool // connected and interactive (not disconnected/locked)
	UID      uint32 // numeric UID (Unix only, 0 on Windows)
}

// sessionState tracks per-session Assist lifecycle.
type sessionState struct {
	key            string    // session key (WinSessionID or UID)
	configPath     string    // sessions/<key>/helper_config.yaml
	statusPath     string    // sessions/<key>/helper_status.yaml
	lastConfig     *Config   // last-written config (skip redundant writes)
	pid            int       // last known PID (from status file or spawn)
	watcher        *watcher  // per-session liveness monitor
	lastApplied    time.Time // when config was last written
}

// newSessionState creates a sessionState with derived file paths.
func newSessionState(key, baseDir string) *sessionState {
	sessionDir := filepath.Join(baseDir, "sessions", key)
	return &sessionState{
		key:        key,
		configPath: filepath.Join(sessionDir, "helper_config.yaml"),
		statusPath: filepath.Join(sessionDir, "helper_status.yaml"),
	}
}

// configUnchanged returns true if cfg matches the last-written config.
func (s *sessionState) configUnchanged(cfg *Config) bool {
	if s.lastConfig == nil {
		return false
	}
	return s.lastConfig.ShowOpenPortal == cfg.ShowOpenPortal &&
		s.lastConfig.ShowDeviceInfo == cfg.ShowDeviceInfo &&
		s.lastConfig.ShowRequestSupport == cfg.ShowRequestSupport &&
		s.lastConfig.PortalUrl == cfg.PortalUrl &&
		s.lastConfig.DeviceName == cfg.DeviceName &&
		s.lastConfig.DeviceStatus == cfg.DeviceStatus &&
		s.lastConfig.LastCheckin == cfg.LastCheckin
}

// refreshPID reads the status file and updates the cached PID.
func (s *sessionState) refreshPID() {
	status, err := ReadStatus(s.configPath)
	if err != nil {
		return
	}
	s.pid = status.PID
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd agent && go test -race ./internal/helper/ -run TestNewSessionState -v && go test -race ./internal/helper/ -run TestSessionState -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd agent && git add internal/helper/session_state.go internal/helper/session_state_test.go
git commit -m "feat(helper): add sessionState struct and SessionEnumerator interface"
```

---

### Task 3: Platform Session Enumerators

Implement `SessionEnumerator` for each platform using OS-level session discovery.

**Files:**
- Create: `agent/internal/helper/enumerator_darwin.go`
- Create: `agent/internal/helper/enumerator_linux.go`
- Create: `agent/internal/helper/enumerator_windows.go`
- Create: `agent/internal/helper/enumerator_test.go`

- [ ] **Step 1: Write test for enumerator (runs on current platform only)**

```go
// agent/internal/helper/enumerator_test.go
package helper

import (
	"os"
	"runtime"
	"strconv"
	"testing"
)

func TestPlatformEnumerator_ReturnsCurrentUser(t *testing.T) {
	enum := NewPlatformEnumerator()
	sessions := enum.ActiveSessions()

	if len(sessions) == 0 {
		t.Skip("no active sessions detected (headless CI?)")
	}

	if runtime.GOOS == "windows" {
		// On Windows, at least one session with a non-zero key
		for _, s := range sessions {
			if s.Key == "0" {
				t.Error("enumerator should not return Session 0")
			}
		}
	} else {
		// On Unix, our UID should appear
		myUID := strconv.Itoa(os.Getuid())
		found := false
		for _, s := range sessions {
			if s.Key == myUID {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("current user UID %s not found in sessions: %v", myUID, sessions)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test -race ./internal/helper/ -run TestPlatformEnumerator -v`
Expected: FAIL — `NewPlatformEnumerator` undefined.

- [ ] **Step 3: Implement macOS enumerator**

```go
// agent/internal/helper/enumerator_darwin.go
package helper

import (
	"strconv"

	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

type darwinEnumerator struct{}

// NewPlatformEnumerator returns a macOS session enumerator.
func NewPlatformEnumerator() SessionEnumerator {
	return &darwinEnumerator{}
}

// ActiveSessions returns the console GUI user on macOS.
// macOS only has one active GUI (Aqua) session at a time. We use the existing
// sessionbroker.SessionDetector which already handles console user detection
// correctly (via SCDynamicStoreCopyConsoleUser with cgo, or stat /dev/console
// without cgo). This avoids `w -h` which would incorrectly include SSH sessions.
func (e *darwinEnumerator) ActiveSessions() []SessionInfo {
	detector := sessionbroker.NewSessionDetector()
	detected, err := detector.ListSessions()
	if err != nil || len(detected) == 0 {
		return nil
	}

	// macOS detector returns the single console user
	s := detected[0]
	if s.UID == 0 {
		return nil // loginwindow, no real user
	}

	return []SessionInfo{{
		Key:      strconv.FormatUint(uint64(s.UID), 10),
		Username: s.Username,
		Active:   true,
		UID:      s.UID,
	}}
}
```

- [ ] **Step 4: Implement Linux enumerator**

```go
// agent/internal/helper/enumerator_linux.go
//go:build !darwin && !windows

package helper

import (
	"os/exec"
	"os/user"
	"strconv"
	"strings"
)

type linuxEnumerator struct{}

// NewPlatformEnumerator returns a Linux session enumerator.
func NewPlatformEnumerator() SessionEnumerator {
	return &linuxEnumerator{}
}

// ActiveSessions uses `loginctl list-sessions` to find graphical sessions.
func (e *linuxEnumerator) ActiveSessions() []SessionInfo {
	out, err := exec.Command("loginctl", "list-sessions", "--no-legend", "--no-pager").Output()
	if err != nil {
		return nil
	}

	seen := make(map[string]bool)
	var sessions []SessionInfo

	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line == "" {
			continue
		}
		// Format: SESSION UID USER SEAT TTY
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		sessionID := fields[0]
		uidStr := fields[1]
		username := fields[2]

		if seen[uidStr] {
			continue
		}

		// Check session type — only graphical sessions
		typeOut, err := exec.Command("loginctl", "show-session", sessionID, "--property=Type", "--value").Output()
		if err != nil {
			continue
		}
		sessionType := strings.TrimSpace(string(typeOut))
		if sessionType != "x11" && sessionType != "wayland" {
			continue
		}

		// Check session state
		stateOut, err := exec.Command("loginctl", "show-session", sessionID, "--property=State", "--value").Output()
		if err != nil {
			continue
		}
		state := strings.TrimSpace(string(stateOut))
		active := state == "active" || state == "online"

		seen[uidStr] = true
		uid, _ := strconv.ParseUint(uidStr, 10, 32)

		// Verify user exists
		if _, err := user.LookupId(uidStr); err != nil {
			continue
		}

		sessions = append(sessions, SessionInfo{
			Key:      uidStr,
			Username: username,
			Active:   active,
			UID:      uint32(uid),
		})
	}

	return sessions
}
```

- [ ] **Step 5: Implement Windows enumerator**

```go
// agent/internal/helper/enumerator_windows.go
package helper

import (
	"strconv"

	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

type windowsEnumerator struct{}

// NewPlatformEnumerator returns a Windows session enumerator using WTS.
func NewPlatformEnumerator() SessionEnumerator {
	return &windowsEnumerator{}
}

// ActiveSessions uses WTS enumeration to find interactive user sessions.
// Skips Session 0 (services) and inactive sessions.
func (e *windowsEnumerator) ActiveSessions() []SessionInfo {
	detector := sessionbroker.NewSessionDetector()
	wtsSessions, err := detector.ListSessions()
	if err != nil {
		return nil
	}

	var sessions []SessionInfo
	for _, s := range wtsSessions {
		if s.Session == "0" || s.Type == "services" {
			continue
		}
		if s.State != "active" && s.State != "connected" {
			continue
		}
		sessions = append(sessions, SessionInfo{
			Key:      s.Session,
			Username: s.Username,
			Active:   s.State == "active",
		})
	}
	return sessions
}
```

Note: This reuses the existing `sessionbroker.NewSessionDetector()` and `ListSessions()` pattern from `heartbeat.go:270-290`.

- [ ] **Step 6: Run tests**

Run: `cd agent && go test -race ./internal/helper/ -run TestPlatformEnumerator -v`
Expected: PASS (on the current platform; other platforms compile but skip)

- [ ] **Step 7: Commit**

```bash
cd agent && git add internal/helper/enumerator_darwin.go internal/helper/enumerator_linux.go internal/helper/enumerator_windows.go internal/helper/enumerator_test.go
git commit -m "feat(helper): platform session enumerators using OS-level APIs"
```

---

### Task 4: Platform Spawn/Stop Refactor

Replace global `isHelperRunning()`/`stopHelper()` with per-session PID-based operations. Add `--config` flag to spawn commands. The global function pointers (`helperRunningFunc`, `helperStopFunc`) will be removed in the Manager rewrite (Task 6).

**Files:**
- Modify: `agent/internal/helper/install_darwin.go`
- Modify: `agent/internal/helper/install_linux.go`
- Modify: `agent/internal/helper/install_windows.go`

- [ ] **Step 1: Add `stopByPID` and `spawnWithConfig` to macOS**

In `agent/internal/helper/install_darwin.go`, add new functions (keep existing ones for now — they're removed in Task 6):

```go
// stopByPID sends SIGTERM to a specific process.
func stopByPID(pid int) error {
	return syscall.Kill(pid, syscall.SIGTERM)
}

// spawnWithConfig launches the helper as a specific user with --config flag.
// Uses exec.Command with Credential to run as the target UID.
func spawnWithConfig(binaryPath string, sessionKey string, configPath string) error {
	uid, err := strconv.ParseUint(sessionKey, 10, 32)
	if err != nil {
		return fmt.Errorf("invalid UID session key %q: %w", sessionKey, err)
	}

	u, err := user.LookupId(sessionKey)
	if err != nil {
		return fmt.Errorf("lookup user %s: %w", sessionKey, err)
	}
	gid, _ := strconv.ParseUint(u.Gid, 10, 32)

	cmd := exec.Command(binaryPath, "--config", configPath)
	cmd.Dir = filepath.Dir(binaryPath)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Credential: &syscall.Credential{
			Uid: uint32(uid),
			Gid: uint32(gid),
		},
	}
	return cmd.Start()
}
```

Add imports: `"os/user"`, `"path/filepath"`, `"strconv"`, `"syscall"`.

- [ ] **Step 2: Add `stopByPID` and `spawnWithConfig` to Linux**

In `agent/internal/helper/install_linux.go`, add:

```go
// stopByPID sends SIGTERM to a specific process.
func stopByPID(pid int) error {
	return syscall.Kill(pid, syscall.SIGTERM)
}

// spawnWithConfig launches the helper as a specific user with --config flag.
func spawnWithConfig(binaryPath string, sessionKey string, configPath string) error {
	uid, err := strconv.ParseUint(sessionKey, 10, 32)
	if err != nil {
		return fmt.Errorf("invalid UID session key %q: %w", sessionKey, err)
	}

	u, err := user.LookupId(sessionKey)
	if err != nil {
		return fmt.Errorf("lookup user %s: %w", sessionKey, err)
	}
	gid, _ := strconv.ParseUint(u.Gid, 10, 32)

	cmd := exec.Command(binaryPath, "--config", configPath)
	cmd.Dir = filepath.Dir(binaryPath)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Credential: &syscall.Credential{
			Uid: uint32(uid),
			Gid: uint32(gid),
		},
	}
	return cmd.Start()
}
```

Add imports: `"os/user"`, `"path/filepath"`, `"strconv"`, `"syscall"`.

- [ ] **Step 3: Add `stopByPID` and `spawnWithConfig` to Windows**

In `agent/internal/helper/install_windows.go`, add:

```go
// stopByPID terminates a specific process by PID.
func stopByPID(pid int) error {
	handle, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return fmt.Errorf("OpenProcess(%d): %w", pid, err)
	}
	defer windows.CloseHandle(handle)
	return windows.TerminateProcess(handle, 0)
}

// spawnWithConfig launches the helper in a specific Windows session with --config flag.
// Delegates to sessionbroker.SpawnProcessInSession with extra args.
func spawnWithConfig(binaryPath string, sessionKey string, configPath string) error {
	sessionNum, err := strconv.ParseUint(sessionKey, 10, 32)
	if err != nil {
		return fmt.Errorf("invalid session key %q: %w", sessionKey, err)
	}
	// Build full command line with --config argument.
	// Check sessionbroker.SpawnProcessInSession signature:
	// - If it accepts a command line string: pass fullCmd directly
	// - If it only accepts a binary path: modify it to accept variadic args,
	//   or add SpawnProcessInSessionWithArgs(cmdLine string, sessionID uint32)
	// The underlying CreateProcessAsUser uses a command line string, so passing
	// the full command line is the natural approach.
	fullCmd := fmt.Sprintf(`"%s" --config "%s"`, binaryPath, configPath)
	return sessionbroker.SpawnProcessInSessionWithArgs(fullCmd, uint32(sessionNum))
}

Add imports: `"strconv"`, `"golang.org/x/sys/windows"`.

- [ ] **Step 4: Add `removeAutoStart` functions to macOS and Linux**

macOS — add to `install_darwin.go` (Windows already has `removeAutoStart`):

```go
// removeAutoStart removes the LaunchAgent plist.
func removeAutoStart() error {
	uid := consoleUID()
	if uid != "" && uid != "0" {
		_ = exec.Command("launchctl", "bootout", "gui/"+uid, plistPath).Run()
	}
	return os.Remove(plistPath)
}
```

Linux — add to `install_linux.go`:

```go
// removeAutoStart removes the XDG autostart desktop entry.
func removeAutoStart() error {
	return os.Remove(desktopEntryPath)
}
```

- [ ] **Step 5: Verify compilation on current platform**

Run: `cd agent && go build ./internal/helper/`
Expected: Compiles without errors.

- [ ] **Step 6: Commit**

```bash
cd agent && git add internal/helper/install_darwin.go internal/helper/install_linux.go internal/helper/install_windows.go
git commit -m "feat(helper): add per-session spawnWithConfig and stopByPID"
```

---

### Task 5: Manager Rewrite — Reconcile Loop

Replace the Manager's internal global state with per-session state. Keep the external API (`Apply`, `CheckUpdate`, `InstalledVersion`, `Shutdown`) stable. This is the core task.

**Files:**
- Modify: `agent/internal/helper/manager.go`
- Modify: `agent/internal/helper/manager_test.go`

- [ ] **Step 1: Write comprehensive tests for the new reconcile behavior**

Replace `agent/internal/helper/manager_test.go` with:

```go
package helper

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// mockEnumerator is a test helper for SessionEnumerator.
type mockEnumerator struct {
	sessions []SessionInfo
}

func (m *mockEnumerator) ActiveSessions() []SessionInfo { return m.sessions }

func TestApply_EnabledSpawnsPerSession(t *testing.T) {
	tmpDir := t.TempDir()
	spawned := map[string]string{} // sessionKey -> configPath

	mgr := &Manager{
		sessions:  make(map[string]*sessionState),
		binaryPath: "/usr/local/bin/breeze-helper",
		baseDir:    tmpDir,
		sessionEnumerator: &mockEnumerator{
			sessions: []SessionInfo{
				{Key: "501", Username: "alice", Active: true, UID: 501},
				{Key: "502", Username: "bob", Active: true, UID: 502},
			},
		},
		spawnFunc: func(sessionKey, binaryPath string, args ...string) error {
			for i, a := range args {
				if a == "--config" && i+1 < len(args) {
					spawned[sessionKey] = args[i+1]
				}
			}
			return nil
		},
		isOurProcessFunc: func(pid int, bp string) bool { return false },
	}

	mgr.Apply(&Settings{Enabled: true, ShowOpenPortal: true})

	if len(spawned) != 2 {
		t.Fatalf("spawned %d sessions, want 2", len(spawned))
	}
	wantAlice := filepath.Join(tmpDir, "sessions", "501", "helper_config.yaml")
	if spawned["501"] != wantAlice {
		t.Errorf("alice config path = %q, want %q", spawned["501"], wantAlice)
	}
	wantBob := filepath.Join(tmpDir, "sessions", "502", "helper_config.yaml")
	if spawned["502"] != wantBob {
		t.Errorf("bob config path = %q, want %q", spawned["502"], wantBob)
	}

	// Verify config files were written
	if _, err := os.Stat(wantAlice); err != nil {
		t.Errorf("alice config not written: %v", err)
	}
	if _, err := os.Stat(wantBob); err != nil {
		t.Errorf("bob config not written: %v", err)
	}
}

func TestApply_DisabledStopsAllSessions(t *testing.T) {
	tmpDir := t.TempDir()
	stoppedPIDs := map[int]bool{}

	mgr := &Manager{
		sessions: map[string]*sessionState{
			"501": {key: "501", pid: 1234, configPath: filepath.Join(tmpDir, "sessions/501/helper_config.yaml")},
			"502": {key: "502", pid: 5678, configPath: filepath.Join(tmpDir, "sessions/502/helper_config.yaml")},
		},
		binaryPath: "/usr/local/bin/breeze-helper",
		baseDir:    tmpDir,
		sessionEnumerator: &mockEnumerator{
			sessions: []SessionInfo{
				{Key: "501", Username: "alice", Active: true},
				{Key: "502", Username: "bob", Active: true},
			},
		},
		stopByPIDFunc: func(pid int) error {
			stoppedPIDs[pid] = true
			return nil
		},
		isOurProcessFunc: func(pid int, bp string) bool { return true },
	}

	mgr.Apply(&Settings{Enabled: false})

	if !stoppedPIDs[1234] {
		t.Error("session 501 (pid 1234) was not stopped")
	}
	if !stoppedPIDs[5678] {
		t.Error("session 502 (pid 5678) was not stopped")
	}
}

func TestApply_ReapsStaleSession(t *testing.T) {
	tmpDir := t.TempDir()
	stopped := false

	mgr := &Manager{
		sessions: map[string]*sessionState{
			"501": {key: "501", pid: 1234, configPath: filepath.Join(tmpDir, "sessions/501/helper_config.yaml")},
		},
		binaryPath: "/usr/local/bin/breeze-helper",
		baseDir:    tmpDir,
		sessionEnumerator: &mockEnumerator{
			sessions: []SessionInfo{}, // 501 disappeared
		},
		isOurProcessFunc: func(pid int, bp string) bool { return true },
		stopByPIDFunc: func(pid int) error {
			stopped = true
			return nil
		},
	}

	mgr.Apply(&Settings{Enabled: true})

	if !stopped {
		t.Error("stale session 501 was not stopped")
	}
	if _, exists := mgr.sessions["501"]; exists {
		t.Error("stale session 501 not removed from map")
	}
}

func TestApply_SkipsRedundantConfigWrite(t *testing.T) {
	tmpDir := t.TempDir()
	spawnCount := 0

	mgr := &Manager{
		sessions:  make(map[string]*sessionState),
		binaryPath: "/usr/local/bin/breeze-helper",
		baseDir:    tmpDir,
		sessionEnumerator: &mockEnumerator{
			sessions: []SessionInfo{{Key: "501", Username: "alice", Active: true, UID: 501}},
		},
		spawnFunc: func(sk, bp string, args ...string) error {
			spawnCount++
			return nil
		},
		isOurProcessFunc: func(pid int, bp string) bool { return false },
	}

	settings := &Settings{Enabled: true, ShowOpenPortal: true}

	// First Apply: writes config and spawns
	mgr.Apply(settings)
	if spawnCount != 1 {
		t.Fatalf("first Apply: spawnCount = %d, want 1", spawnCount)
	}

	// Verify config was written
	configPath := filepath.Join(tmpDir, "sessions", "501", "helper_config.yaml")
	info1, _ := os.Stat(configPath)
	time.Sleep(10 * time.Millisecond)

	// Second Apply: same settings, process "running" now
	mgr.isOurProcessFunc = func(pid int, bp string) bool { return true }
	mgr.sessions["501"].pid = 9999
	mgr.Apply(settings)

	// Config file should NOT have been rewritten (mod time unchanged)
	info2, _ := os.Stat(configPath)
	if info2.ModTime() != info1.ModTime() {
		t.Error("config was rewritten despite unchanged settings")
	}
}

func TestAllSessionsIdle_BlocksWhenChatActive(t *testing.T) {
	tmpDir := t.TempDir()

	// Write a status file with active chat
	sessionDir := filepath.Join(tmpDir, "sessions", "501")
	os.MkdirAll(sessionDir, 0755)
	statusFile := filepath.Join(sessionDir, "helper_status.yaml")
	os.WriteFile(statusFile, []byte("chat_active: true\nlast_activity: "+time.Now().Format(time.RFC3339)+"\npid: 1234\n"), 0644)

	mgr := &Manager{
		sessions: map[string]*sessionState{
			"501": {key: "501", configPath: filepath.Join(sessionDir, "helper_config.yaml"), statusPath: statusFile},
		},
	}

	if mgr.allSessionsIdle() {
		t.Error("allSessionsIdle = true, want false (chat is active)")
	}
}

func TestAllSessionsIdle_TrueWhenAllIdle(t *testing.T) {
	tmpDir := t.TempDir()
	sessionDir := filepath.Join(tmpDir, "sessions", "501")
	os.MkdirAll(sessionDir, 0755)
	statusFile := filepath.Join(sessionDir, "helper_status.yaml")
	os.WriteFile(statusFile, []byte("chat_active: false\npid: 1234\n"), 0644)

	mgr := &Manager{
		sessions: map[string]*sessionState{
			"501": {key: "501", configPath: filepath.Join(sessionDir, "helper_config.yaml"), statusPath: statusFile},
		},
	}

	if !mgr.allSessionsIdle() {
		t.Error("allSessionsIdle = false, want true (no active chat)")
	}
}
```

Note: The test references `isOurProcessFunc`, `stopByPIDFunc`, and an updated `spawnFunc` type. These are testability hooks that replace the old `helperRunningFunc`/`helperStopFunc` globals. The Manager rewrite in the next step will add these fields. Fix the `TestApply_DisabledStopsAllSessions` test to properly track stopped PIDs (the simplified version above is pseudocode — use a map keyed by PID).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd agent && go test -race ./internal/helper/ -run TestApply -v`
Expected: FAIL — Manager struct doesn't have `sessions`, `sessionEnumerator`, etc.

- [ ] **Step 3: Rewrite Manager internals**

Replace the Manager struct and its methods in `agent/internal/helper/manager.go`. Key changes:

**Replace the Manager struct** (lines 62-74):

```go
type Manager struct {
	mu       sync.Mutex
	sessions map[string]*sessionState

	// Machine-global (unchanged)
	binaryPath           string
	baseDir              string
	serverURL            string
	authToken            *secmem.SecureString
	agentID              string
	ctx                  context.Context
	pendingHelperVersion string

	// Dependencies (injected)
	sessionEnumerator SessionEnumerator
	spawnFunc         func(sessionKey, binaryPath string, args ...string) error

	// Testability hooks (default to real implementations)
	isOurProcessFunc func(pid int, binaryPath string) bool
	stopByPIDFunc    func(pid int) error
}
```

**Update SpawnFunc type** (line 44):

```go
// SpawnFunc launches a helper in the given session with extra CLI args.
type SpawnFunc func(sessionKey string, binaryPath string, args ...string) error
```

**Update Option and WithSpawnFunc** (lines 52-59):

```go
type Option func(*Manager)

func WithSpawnFunc(fn SpawnFunc) Option {
	return func(m *Manager) { m.spawnFunc = fn }
}

func WithSessionEnumerator(e SessionEnumerator) Option {
	return func(m *Manager) { m.sessionEnumerator = e }
}
```

**Update constructor** (lines 77-90):

```go
func New(ctx context.Context, serverURL string, authToken *secmem.SecureString, agentID string, opts ...Option) *Manager {
	m := &Manager{
		ctx:              ctx,
		binaryPath:       defaultBinaryPath(),
		baseDir:          defaultBaseDir(),
		serverURL:        serverURL,
		authToken:        authToken,
		agentID:          agentID,
		sessions:         make(map[string]*sessionState),
		isOurProcessFunc: isOurProcess,
		stopByPIDFunc:    stopByPID,
	}
	for _, opt := range opts {
		opt(m)
	}
	if m.spawnFunc == nil {
		m.spawnFunc = func(sessionKey, binaryPath string, args ...string) error {
			return spawnWithConfig(binaryPath, sessionKey, args[1]) // args = ["--config", path]
		}
	}
	return m
}
```

Add `defaultBaseDir()` — extract from existing `defaultConfigPath()`:

```go
func defaultBaseDir() string {
	switch runtime.GOOS {
	case "darwin":
		return "/Library/Application Support/Breeze"
	case "windows":
		pd := os.Getenv("ProgramData")
		if pd == "" {
			pd = `C:\ProgramData`
		}
		return filepath.Join(pd, "Breeze")
	default:
		return "/etc/breeze"
	}
}
```

**Rewrite Apply** (lines 129-173):

```go
func (m *Manager) Apply(settings *Settings) {
	if settings == nil {
		return
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	if m.sessionEnumerator == nil {
		return
	}

	// 1. Enumerate active sessions
	activeSessions := m.sessionEnumerator.ActiveSessions()
	activeKeys := make(map[string]bool, len(activeSessions))

	// 2. Reconcile each active session
	for _, si := range activeSessions {
		activeKeys[si.Key] = true
		state, exists := m.sessions[si.Key]
		if !exists {
			state = newSessionState(si.Key, m.baseDir)
			m.sessions[si.Key] = state
		}

		if settings.Enabled {
			cfg := settingsToConfig(settings)
			if !state.configUnchanged(cfg) {
				if err := m.writeSessionConfig(state, cfg, si); err != nil {
					log.Error("failed to write per-session config",
						"session", si.Key, "error", err.Error())
					continue
				}
				// If helper is too old for --config, also write the legacy global path
				if !m.helperSupportsConfigFlag() {
					globalPath := filepath.Join(m.baseDir, "helper_config.yaml")
					data, _ := yaml.Marshal(cfg)
					os.WriteFile(globalPath, data, 0644)
				}
			}

			if !m.isInstalled() {
				if err := m.downloadAndInstall(); err != nil {
					log.Error("failed to install breeze assist", "error", err.Error())
					return
				}
			}

			state.refreshPID()
			if err := m.ensureRunningSession(state); err != nil {
				log.Error("failed to start breeze assist",
					"session", si.Key, "error", err.Error())
			} else {
				m.startSessionWatcher(state)
			}
		} else {
			state.refreshPID()
			m.stopSessionWatcher(state)
			if err := m.ensureStoppedSession(state); err != nil {
				log.Error("failed to stop breeze assist",
					"session", si.Key, "error", err.Error())
			}
		}
	}

	// 3. Reap stale sessions
	for key, state := range m.sessions {
		if activeKeys[key] {
			continue
		}
		state.refreshPID()
		m.stopSessionWatcher(state)
		if err := m.ensureStoppedSession(state); err != nil {
			log.Warn("failed to stop stale session",
				"session", key, "error", err.Error())
		}
		delete(m.sessions, key)
	}

	// 4. Apply pending update (machine-global)
	if settings.Enabled {
		m.applyPendingUpdate()
	}
}
```

**Add helper methods:**

```go
func settingsToConfig(s *Settings) *Config {
	return &Config{
		ShowOpenPortal:     s.ShowOpenPortal,
		ShowDeviceInfo:     s.ShowDeviceInfo,
		ShowRequestSupport: s.ShowRequestSupport,
		PortalUrl:          s.PortalUrl,
	}
}

func (m *Manager) writeSessionConfig(state *sessionState, cfg *Config, si SessionInfo) error {
	dir := filepath.Dir(state.configPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("create session dir: %w", err)
	}
	// chown session dir to session user (Unix only)
	if runtime.GOOS != "windows" && si.UID > 0 {
		os.Chown(dir, int(si.UID), -1)
	}

	data, err := yaml.Marshal(cfg)
	if err != nil {
		return fmt.Errorf("marshal config: %w", err)
	}

	tmp := state.configPath + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return fmt.Errorf("write temp config: %w", err)
	}
	if err := os.Rename(tmp, state.configPath); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("rename config: %w", err)
	}

	state.lastConfig = cfg
	state.lastApplied = time.Now()
	return nil
}

// minConfigFlagVersion is the minimum helper version that supports --config.
// Below this version, helpers crash on unknown flags, so we omit --config
// and fall back to writing the legacy global config path.
var minConfigFlagVersion = [3]int{0, 14, 0}

func (m *Manager) ensureRunningSession(state *sessionState) error {
	if state.pid > 0 && m.isOurProcessFunc(state.pid, m.binaryPath) {
		return nil
	}
	if m.helperSupportsConfigFlag() {
		return m.spawnFunc(state.key, m.binaryPath, "--config", state.configPath)
	}
	// Legacy helper: spawn without --config, write global config as fallback
	return m.spawnFunc(state.key, m.binaryPath)
}

func (m *Manager) helperSupportsConfigFlag() bool {
	v := m.installedVersionLocked()
	if v == "" {
		return false // unknown version = assume old, don't risk --config crash
	}
	return semverAtLeast(v, minConfigFlagVersion)
}

// semverAtLeast returns true if version string "X.Y.Z" (with optional prefix/suffix)
// is >= the target [3]int{major, minor, patch}.
func semverAtLeast(version string, target [3]int) bool {
	// Strip leading "v" if present
	v := strings.TrimPrefix(version, "v")
	// Strip pre-release suffix (e.g., "-rc.1")
	if idx := strings.IndexByte(v, '-'); idx >= 0 {
		v = v[:idx]
	}
	parts := strings.SplitN(v, ".", 3)
	if len(parts) < 3 {
		return false
	}
	for i := 0; i < 3; i++ {
		n, err := strconv.Atoi(parts[i])
		if err != nil {
			return false
		}
		if n > target[i] {
			return true
		}
		if n < target[i] {
			return false
		}
	}
	return true // equal
}

func (m *Manager) ensureStoppedSession(state *sessionState) error {
	if state.pid > 0 && m.isOurProcessFunc(state.pid, m.binaryPath) {
		return m.stopByPIDFunc(state.pid)
	}
	return nil
}

func (m *Manager) allSessionsIdle() bool {
	for _, state := range m.sessions {
		status, err := ReadStatus(state.configPath)
		if err != nil {
			continue
		}
		if status.ChatActive && time.Since(status.LastActivity) < idleTimeout {
			return false
		}
	}
	return true
}
```

**Update `InstalledVersion`** to aggregate from per-session status files, and add a mutex-free variant for internal use (called from `Apply` which already holds `mu`):

```go
func (m *Manager) InstalledVersion() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.installedVersionLocked()
}

// installedVersionLocked is the same as InstalledVersion but assumes mu is held.
// Called from Apply/ensureRunningSession where the mutex is already acquired.
func (m *Manager) installedVersionLocked() string {
	for _, state := range m.sessions {
		status, err := ReadStatus(state.configPath)
		if err != nil {
			continue
		}
		if status.Version != "" {
			return status.Version
		}
	}
	return ""
}
```

**Update `applyPendingUpdate`** to gate on `allSessionsIdle()` and stop/restart all sessions:

Update the `IsIdle(m.configPath)` call (line 332) to `m.allSessionsIdle()`. Update the stop/restart logic to iterate `m.sessions`.

**Update `Shutdown`** to stop all session watchers:

```go
func (m *Manager) Shutdown() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, state := range m.sessions {
		m.stopSessionWatcher(state)
	}
}
```

**Add per-session watcher methods:**

```go
func (m *Manager) startSessionWatcher(state *sessionState) {
	if state.watcher != nil {
		return
	}
	w := newSessionWatcher(m.ctx, m, state)
	state.watcher = w
	go w.run()
}

func (m *Manager) stopSessionWatcher(state *sessionState) {
	if state.watcher == nil {
		return
	}
	w := state.watcher
	state.watcher = nil
	// Release mutex before joining to avoid deadlock (watcher acquires mu on tick)
	m.mu.Unlock()
	w.cancel()
	<-w.done
	m.mu.Lock()
}
```

**Remove global state fields** from Manager: `lastEnabled`, `configPath`, `watcher` (single instance).

**Remove global function pointers**: `helperRunningFunc`, `helperStopFunc`. Tests now use `isOurProcessFunc` and `stopByPIDFunc` fields on Manager instead.

- [ ] **Step 4: Update watcher.go for per-session use**

The watcher needs to know which `sessionState` it monitors. Modify `agent/internal/helper/watcher.go`:

```go
type watcher struct {
	ctx    context.Context
	cancel context.CancelFunc
	mgr    *Manager
	state  *sessionState // the session this watcher monitors
	done   chan struct{}
}

func newSessionWatcher(parent context.Context, mgr *Manager, state *sessionState) *watcher {
	ctx, cancel := context.WithCancel(parent)
	return &watcher{
		ctx:    ctx,
		cancel: cancel,
		mgr:    mgr,
		state:  state,
		done:   make(chan struct{}),
	}
}
```

Update the `run()` loop body (currently at lines 50-61) to use `m.state` and `m.mgr.isOurProcessFunc` instead of `helperRunningFunc()`:

```go
// Inside the tick in run():
w.mgr.mu.Lock()
w.state.refreshPID()
if !w.mgr.isOurProcessFunc(w.state.pid, w.mgr.binaryPath) {
	if err := w.mgr.spawnFunc(w.state.key, w.mgr.binaryPath, "--config", w.state.configPath); err != nil {
		failures++
		// ... backoff logic ...
	} else {
		failures = 0
	}
} else {
	failures = 0
}
w.mgr.mu.Unlock()
```

- [ ] **Step 5: Run tests**

Run: `cd agent && go test -race ./internal/helper/ -v`
Expected: PASS

- [ ] **Step 6: Verify compilation across platforms**

Run: `cd agent && GOOS=darwin go build ./internal/helper/ && GOOS=linux go build ./internal/helper/ && GOOS=windows go build ./internal/helper/`
Expected: All three compile.

- [ ] **Step 7: Commit**

```bash
cd agent && git add internal/helper/manager.go internal/helper/manager_test.go internal/helper/watcher.go
git commit -m "feat(helper): replace global state with per-session reconcile loop"
```

---

### Task 6: Session Migration and Autostart Removal

Extend the existing migration logic to handle the transition from global config to per-session layout. Remove autostart artifacts during migration.

**Files:**
- Modify: `agent/internal/helper/migrate.go`
- Modify: `agent/internal/helper/migrate_darwin.go`
- Modify: `agent/internal/helper/migrate_linux.go`
- Modify: `agent/internal/helper/migrate_windows.go`
- Create: `agent/internal/helper/migrate_test.go`

- [ ] **Step 1: Write failing test for session migration detection**

```go
// agent/internal/helper/migrate_test.go
package helper

import (
	"os"
	"path/filepath"
	"testing"
)

func TestNeedsSessionMigration_NoSessionsDir(t *testing.T) {
	tmpDir := t.TempDir()
	mgr := &Manager{baseDir: tmpDir}

	if !mgr.needsSessionMigration() {
		t.Error("needsSessionMigration = false, want true (no sessions/ dir)")
	}
}

func TestNeedsSessionMigration_SessionsDirExists(t *testing.T) {
	tmpDir := t.TempDir()
	os.MkdirAll(filepath.Join(tmpDir, "sessions"), 0755)
	mgr := &Manager{baseDir: tmpDir}

	if mgr.needsSessionMigration() {
		t.Error("needsSessionMigration = true, want false (sessions/ exists)")
	}
}

func TestMigrateToSessions_CreatesLayout(t *testing.T) {
	tmpDir := t.TempDir()

	// Write a global config file
	globalConfig := filepath.Join(tmpDir, "helper_config.yaml")
	os.WriteFile(globalConfig, []byte("show_open_portal: true\nshow_device_info: true\n"), 0644)

	mgr := &Manager{
		baseDir:    tmpDir,
		binaryPath: "/usr/local/bin/breeze-helper",
		sessions:   make(map[string]*sessionState),
		sessionEnumerator: &mockEnumerator{
			sessions: []SessionInfo{
				{Key: "501", Username: "alice", Active: true, UID: 501},
			},
		},
		isOurProcessFunc: func(pid int, bp string) bool { return false },
	}

	mgr.migrateToSessions()

	// Sessions dir should exist
	sessionsDir := filepath.Join(tmpDir, "sessions")
	if _, err := os.Stat(sessionsDir); err != nil {
		t.Fatalf("sessions dir not created: %v", err)
	}

	// Per-session config should exist
	sessionConfig := filepath.Join(sessionsDir, "501", "helper_config.yaml")
	if _, err := os.Stat(sessionConfig); err != nil {
		t.Fatalf("per-session config not created: %v", err)
	}

	// Content should match global config
	data, _ := os.ReadFile(sessionConfig)
	if len(data) == 0 {
		t.Error("per-session config is empty")
	}

	// Global config should still exist (not deleted)
	if _, err := os.Stat(globalConfig); err != nil {
		t.Error("global config was deleted (should be preserved)")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd agent && go test -race ./internal/helper/ -run TestNeedsSession -v && go test -race ./internal/helper/ -run TestMigrate -v`
Expected: FAIL — `needsSessionMigration` and `migrateToSessions` undefined.

- [ ] **Step 3: Implement migration in migrate.go**

Add to `agent/internal/helper/migrate.go`:

```go
// needsSessionMigration returns true if the sessions/ directory doesn't exist yet.
func (m *Manager) needsSessionMigration() bool {
	_, err := os.Stat(filepath.Join(m.baseDir, "sessions"))
	return os.IsNotExist(err)
}

// migrateToSessions performs the one-time migration from global config to
// per-session layout. Called from Apply() under the manager mutex.
func (m *Manager) migrateToSessions() {
	log.Info("migrating to per-session Assist layout")

	// 1. Create sessions/ directory
	sessionsDir := filepath.Join(m.baseDir, "sessions")
	if err := os.MkdirAll(sessionsDir, 0755); err != nil {
		log.Error("failed to create sessions dir", "error", err.Error())
		return
	}

	// 2. Read existing global config (if any)
	globalConfigPath := filepath.Join(m.baseDir, "helper_config.yaml")
	globalConfig, _ := os.ReadFile(globalConfigPath)

	// 3. Create per-session dirs and copy config
	if m.sessionEnumerator != nil {
		for _, si := range m.sessionEnumerator.ActiveSessions() {
			sessionDir := filepath.Join(sessionsDir, si.Key)
			if err := os.MkdirAll(sessionDir, 0755); err != nil {
				log.Warn("failed to create session dir",
					"session", si.Key, "error", err.Error())
				continue
			}
			// chown session dir to session user (Unix)
			if runtime.GOOS != "windows" && si.UID > 0 {
				os.Chown(sessionDir, int(si.UID), -1)
			}
			// Copy global config to per-session path
			if len(globalConfig) > 0 {
				dst := filepath.Join(sessionDir, "helper_config.yaml")
				os.WriteFile(dst, globalConfig, 0644)
			}
		}
	}

	// 4. Remove autostart artifacts
	removeAutoStart()

	// 5. Stop any globally-spawned helper
	// Use old-style stop as a one-time cleanup (process name based)
	stopHelperGlobal()

	log.Info("per-session migration complete")
}

// stopHelperGlobal is a one-time cleanup that kills any globally-spawned helper
// by process name. Only used during migration.
func stopHelperGlobal() {
	// Platform-specific: uses the old pgrep/taskkill approach one last time.
	stopHelperLegacy()
}
```

- [ ] **Step 4: Add `stopHelperLegacy` and update platform migrate files**

In `agent/internal/helper/migrate_darwin.go`, add:

```go
func stopHelperLegacy() {
	uid := consoleUID()
	if uid != "" && uid != "0" {
		_ = exec.Command("launchctl", "bootout", "gui/"+uid, plistPath).Run()
	}
	_ = exec.Command("pkill", "-f", "breeze-helper").Run()
}
```

In `agent/internal/helper/migrate_linux.go`, add:

```go
func stopHelperLegacy() {
	_ = exec.Command("pkill", "-f", "breeze-helper").Run()
}
```

In `agent/internal/helper/migrate_windows.go`, add:

```go
func stopHelperLegacy() {
	_ = exec.Command("taskkill", "/F", "/IM", "breeze-helper.exe").Run()
}
```

- [ ] **Step 5: Call migration from Apply()**

In the rewritten `Apply()` method (from Task 6), add migration check at the top (after nil check, before enumeration):

```go
func (m *Manager) Apply(settings *Settings) {
	if settings == nil {
		return
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	// Legacy name migration (existing)
	m.migrateFromLegacyName()

	// Per-session migration (new)
	if m.needsSessionMigration() {
		m.migrateToSessions()
	}

	// ... rest of reconcile loop ...
}
```

- [ ] **Step 6: Run tests**

Run: `cd agent && go test -race ./internal/helper/ -v`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
cd agent && git add internal/helper/migrate.go internal/helper/migrate_darwin.go internal/helper/migrate_linux.go internal/helper/migrate_windows.go internal/helper/migrate_test.go
git commit -m "feat(helper): add per-session migration with autostart removal"
```

---

### Task 7: Heartbeat Integration

Update `heartbeat.go` to pass a `SessionEnumerator` and adapt the `SpawnFunc` to the new signature.

**Files:**
- Modify: `agent/internal/heartbeat/heartbeat.go`

- [ ] **Step 1: Update the Windows Service helper constructor**

At `heartbeat.go:266-310`, the `WithSpawnFunc` closure currently iterates sessions internally. With the new model, the Manager reconciler handles iteration — the `SpawnFunc` just needs to spawn in one specific session. Replace:

```go
// Windows Service: spawn func targets a specific session
h.helperMgr = helper.New(helperCtx, cfg.ServerURL, ftToken, cfg.AgentID,
	helper.WithSessionEnumerator(helper.NewPlatformEnumerator()),
	helper.WithSpawnFunc(func(sessionKey, binaryPath string, args ...string) error {
		// Try launching via connected user-role helper first
		if h.sessionBroker != nil {
			cmdLine := binaryPath
			for _, a := range args {
				cmdLine += " " + a
			}
			if err := h.sessionBroker.LaunchProcessViaUserHelper(cmdLine); err == nil {
				return nil
			}
		}

		// Fallback: spawn directly in the target session
		sessionNum, err := strconv.ParseUint(sessionKey, 10, 32)
		if err != nil {
			return fmt.Errorf("invalid session key %q: %w", sessionKey, err)
		}
		return sessionbroker.SpawnProcessInSession(binaryPath, uint32(sessionNum))
	}),
)
```

- [ ] **Step 2: Update the macOS/Linux headless helper constructor**

At `heartbeat.go:314-321`:

```go
h.helperMgr = helper.New(helperCtx, cfg.ServerURL, ftToken, cfg.AgentID,
	helper.WithSessionEnumerator(helper.NewPlatformEnumerator()),
	helper.WithSpawnFunc(func(sessionKey, binaryPath string, args ...string) error {
		if h.sessionBroker != nil {
			cmdLine := binaryPath
			for _, a := range args {
				cmdLine += " " + a
			}
			if err := h.sessionBroker.LaunchProcessViaUserHelper(cmdLine); err == nil {
				return nil
			}
		}
		return helper.ErrNoActiveSession
	}),
)
```

- [ ] **Step 3: Update the default (non-service) constructor**

At `heartbeat.go:323`:

```go
h.helperMgr = helper.New(helperCtx, cfg.ServerURL, ftToken, cfg.AgentID,
	helper.WithSessionEnumerator(helper.NewPlatformEnumerator()),
)
```

- [ ] **Step 4: Verify compilation**

Run: `cd agent && go build ./...`
Expected: Compiles without errors.

- [ ] **Step 5: Run all tests**

Run: `cd agent && go test -race ./internal/helper/ -v && go test -race ./internal/heartbeat/ -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
cd agent && git add internal/heartbeat/heartbeat.go
git commit -m "feat(heartbeat): pass SessionEnumerator to helper Manager"
```

---

### Task 8: Clean Up Dead Code

Remove the global function pointers and old platform functions that are no longer called.

**Files:**
- Modify: `agent/internal/helper/manager.go`
- Modify: `agent/internal/helper/install_darwin.go`
- Modify: `agent/internal/helper/install_linux.go`
- Modify: `agent/internal/helper/install_windows.go`

- [ ] **Step 1: Remove `helperRunningFunc` and `helperStopFunc` globals**

In `manager.go`, remove lines 19-22:

```go
// DELETE these:
var helperRunningFunc = isHelperRunning
var helperStopFunc = stopHelper
```

- [ ] **Step 2: Remove old `isHelperRunning()` and `stopHelper()` from platform files**

From `install_darwin.go`, remove `isHelperRunning()` (lines 86-90) and `stopHelper()` (lines 92-98).

From `install_linux.go`, remove `isHelperRunning()` (lines 66-72) and `stopHelper()` (lines 74-76).

From `install_windows.go`, remove `isHelperRunning()` (lines 48-54) and `stopHelper()` (lines 56-58).

- [ ] **Step 3: Remove old `configPath` field and `defaultConfigPath()` from manager**

The Manager no longer uses a single `configPath`. Remove `defaultConfigPath()` (lines 112-125) and the `configPath` field. `ReadStatus` calls in `InstalledVersion` now use per-session `state.configPath`.

- [ ] **Step 4: Remove old `lastEnabled` field**

The `lastEnabled` field is no longer needed — the reconcile loop derives enabled state from `settings.Enabled` on each call.

- [ ] **Step 5: Remove old single-instance `startWatcher`/`stopWatcher`/`watcher` field**

The old `watcher` field on Manager, and the old `startWatcher()` / `stopWatcher()` methods (lines 272-294) are replaced by `startSessionWatcher()` / `stopSessionWatcher()`. Remove the old ones.

- [ ] **Step 6: Remove old `ensureRunning()` and `ensureStopped()`**

These are replaced by `ensureRunningSession(state)` and `ensureStoppedSession(state)`.

- [ ] **Step 7: Run all tests to verify nothing breaks**

Run: `cd agent && go test -race ./internal/helper/ -v && go test -race ./... 2>&1 | head -100`
Expected: PASS (no references to removed functions remaining).

- [ ] **Step 8: Commit**

```bash
cd agent && git add internal/helper/manager.go internal/helper/install_darwin.go internal/helper/install_linux.go internal/helper/install_windows.go
git commit -m "refactor(helper): remove global lifecycle state and process-name operations"
```

---

### Task 9: Integration Test — Multi-Session Reconcile

End-to-end test verifying the full reconcile cycle works with multiple sessions, session appearance/disappearance, and config isolation.

**Files:**
- Create: `agent/internal/helper/reconcile_test.go`

- [ ] **Step 1: Write integration test**

```go
// agent/internal/helper/reconcile_test.go
package helper

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"gopkg.in/yaml.v3"
)

func TestReconcile_FullLifecycle(t *testing.T) {
	tmpDir := t.TempDir()
	var spawns, stops []string

	enum := &mockEnumerator{}

	mgr := &Manager{
		ctx:        context.Background(),
		sessions:   make(map[string]*sessionState),
		binaryPath: "/usr/local/bin/breeze-helper",
		baseDir:    tmpDir,
		sessionEnumerator: enum,
		spawnFunc: func(sk, bp string, args ...string) error {
			spawns = append(spawns, sk)
			// Simulate writing a status file (as the helper would)
			for i, a := range args {
				if a == "--config" && i+1 < len(args) {
					statusPath := filepath.Join(filepath.Dir(args[i+1]), "helper_status.yaml")
					s := Status{PID: 9000 + len(spawns), Version: "0.13.0"}
					data, _ := yaml.Marshal(s)
					os.WriteFile(statusPath, data, 0644)
				}
			}
			return nil
		},
		isOurProcessFunc: func(pid int, bp string) bool {
			return pid >= 9000 // "spawned" PIDs
		},
		stopByPIDFunc: func(pid int) error {
			stops = append(stops, "pid:"+string(rune(pid)))
			return nil
		},
	}

	// Phase 1: One session appears, enabled
	enum.sessions = []SessionInfo{{Key: "501", Username: "alice", Active: true, UID: 501}}
	mgr.Apply(&Settings{Enabled: true, ShowOpenPortal: true})

	if len(spawns) != 1 || spawns[0] != "501" {
		t.Fatalf("phase 1: spawns = %v, want [501]", spawns)
	}

	// Verify config file content
	cfg501 := filepath.Join(tmpDir, "sessions", "501", "helper_config.yaml")
	data, err := os.ReadFile(cfg501)
	if err != nil {
		t.Fatalf("config not written: %v", err)
	}
	var parsed Config
	yaml.Unmarshal(data, &parsed)
	if !parsed.ShowOpenPortal {
		t.Error("ShowOpenPortal not set in config")
	}

	// Phase 2: Second session appears
	spawns = nil
	enum.sessions = []SessionInfo{
		{Key: "501", Username: "alice", Active: true, UID: 501},
		{Key: "502", Username: "bob", Active: true, UID: 502},
	}
	mgr.Apply(&Settings{Enabled: true, ShowOpenPortal: true})

	if len(spawns) != 1 || spawns[0] != "502" {
		t.Fatalf("phase 2: spawns = %v, want [502] (501 already running)", spawns)
	}

	// Phase 3: First session disappears
	stops = nil
	enum.sessions = []SessionInfo{
		{Key: "502", Username: "bob", Active: true, UID: 502},
	}
	mgr.Apply(&Settings{Enabled: true, ShowOpenPortal: true})

	if _, exists := mgr.sessions["501"]; exists {
		t.Error("phase 3: session 501 should be reaped")
	}

	// Phase 4: Disable all
	stops = nil
	mgr.Apply(&Settings{Enabled: false})

	if _, exists := mgr.sessions["502"]; !exists {
		t.Error("phase 4: session 502 should still be in map (active session)")
	}
}
```

- [ ] **Step 2: Run test**

Run: `cd agent && go test -race ./internal/helper/ -run TestReconcile -v`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
cd agent && git add internal/helper/reconcile_test.go
git commit -m "test(helper): integration test for multi-session reconcile lifecycle"
```

---

### Not covered in this plan (separate deliverable)

The **Breeze Helper (Tauri app)** `--config` CLI flag is specified in the design spec but is a separate Rust/React codebase. That work should be planned independently:
- Add `--config <path>` CLI argument parsing to the Tauri app
- If present, use that path for config; derive status path as sibling
- If absent, fall back to legacy global path (existing behavior)
- Write `started_at` timestamp to status file at launch

**Compatibility note:** Many CLIs exit on unknown flags, so passing `--config` to an old helper that doesn't support it will likely crash the launch. The agent must **not** pass `--config` until it confirms the installed helper version supports it. The `ensureRunningSession` method should check `InstalledVersion()` against a minimum version constant (e.g., `minConfigFlagVersion = "0.14.0"`). If the helper is below that version, spawn without `--config` and write config to the legacy global path as a fallback. This version gate is removed once the minimum supported helper version is bumped past the threshold.

---

### Summary of file changes

| File | Action | Task |
|------|--------|------|
| `agent/internal/helper/process_check_unix.go` | Keep `processExists` only, remove build tag overlap | 1 |
| `agent/internal/helper/process_check_darwin.go` | Create — `processExePath` via sysctl, `isOurProcess` | 1 |
| `agent/internal/helper/process_check_linux.go` | Create — `processExePath` via /proc, `isOurProcess` | 1 |
| `agent/internal/helper/process_check_windows.go` | Add `processExePath`, `isOurProcess` | 1 |
| `agent/internal/helper/process_check_test.go` | Create | 1 |
| `agent/internal/helper/session_state.go` | Create | 2 |
| `agent/internal/helper/session_state_test.go` | Create | 2 |
| `agent/internal/helper/enumerator_darwin.go` | Create | 3 |
| `agent/internal/helper/enumerator_linux.go` | Create | 3 |
| `agent/internal/helper/enumerator_windows.go` | Create | 3 |
| `agent/internal/helper/enumerator_test.go` | Create | 3 |
| `agent/internal/helper/install_darwin.go` | Add `stopByPID`, `spawnWithConfig`, `removeAutoStart` | 4 |
| `agent/internal/helper/install_linux.go` | Add `stopByPID`, `spawnWithConfig`, `removeAutoStart` | 4 |
| `agent/internal/helper/install_windows.go` | Add `stopByPID`, `spawnWithConfig` | 4 |
| `agent/internal/helper/manager.go` | Full rewrite of internals | 5 |
| `agent/internal/helper/manager_test.go` | Full rewrite | 5 |
| `agent/internal/helper/watcher.go` | Per-session adaptation | 5 |
| `agent/internal/helper/migrate.go` | Add `needsSessionMigration`, `migrateToSessions` | 6 |
| `agent/internal/helper/migrate_darwin.go` | Add `stopHelperLegacy` | 6 |
| `agent/internal/helper/migrate_linux.go` | Add `stopHelperLegacy` | 6 |
| `agent/internal/helper/migrate_windows.go` | Add `stopHelperLegacy` | 6 |
| `agent/internal/helper/migrate_test.go` | Create | 6 |
| `agent/internal/heartbeat/heartbeat.go` | Update constructor calls | 7 |
| `agent/internal/helper/install_*.go` | Remove dead code | 8 |
| `agent/internal/helper/reconcile_test.go` | Create | 9 |
