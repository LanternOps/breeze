# Windows Agent Instance Guard and Process Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a second full Windows agent from initializing and make service, console, companion-helper, and main-binary-fallback processes unambiguous in diagnostics.

**Architecture:** The full `runAgent` path acquires a no-sharing file handle inside the hardened Breeze ProgramData directory before any mutation or component initialization. A shared startup record classifies each process, while helper path resolution carries explicit fallback provenance instead of inferring it later from Task Manager names.

**Tech Stack:** Go, Windows `CreateFile`, ProgramData DACLs, `golang.org/x/sys/windows`, structured Breeze logging.

## Global Constraints

- The instance guard is the first ownership/mutating action in `runAgent`; only side-effect-free Windows service detection and process-metadata collection may precede it. It is acquired before service-unit reconciliation, config loading, state writes, IPC, heartbeat, or collectors.
- Helper, enrollment, service-management, status, and diagnostic subcommands do not acquire the full-agent guard.
- The lock lives under `config.ConfigDir()`; current directories and temporary directories are forbidden.
- The ProgramData parent and final lock object must not be reparse points.
- Only sharing/lock violations mean another agent owns the lock; access, ACL, metadata, and path failures are security failures and fail closed.
- File contents are diagnostics only. The exclusive live handle is the ownership proof.
- No credential, token, certificate, or tenant secret may enter lock metadata or startup logs.
- Unix behavior remains a no-op guard.
- Design source: `docs/superpowers/specs/agent/2026-07-14-windows-agent-helper-lifecycle-durability-design.md`.
- This document covers process diagnostics and main-agent exclusivity. The RDS lifecycle and watchdog phases are specified in the two sibling plans with the same date prefix.

## File Structure

- Create `agent/internal/agentapp/process_role.go`: startup record and pure launch-mode classification.
- Create `agent/internal/agentapp/process_role_test.go`: all process-role classifications.
- Create `agent/internal/agentapp/process_role_windows.go`: kernel-derived Windows session, parent PID, executable, and creation time.
- Create `agent/internal/agentapp/process_role_other.go`: neutral non-Windows metadata.
- Create `agent/internal/agentapp/main_instance.go`: guard interfaces, typed errors, and exit codes.
- Create `agent/internal/agentapp/main_instance_windows.go`: protected exclusive file-handle implementation.
- Create `agent/internal/agentapp/main_instance_other.go`: no-op guard.
- Create `agent/internal/agentapp/main_instance_windows_test.go`: native lock, stale-file, ACL, and reparse tests.
- Create `agent/internal/agentapp/instance_marker_windows.go`: bootstrap-safe Windows Event Log marker.
- Create `agent/internal/agentapp/instance_marker_other.go`: stderr-only non-Windows marker.
- Modify `agent/internal/eventlog/eventlog_windows.go`: expose error-returning lazy source registration/write for bootstrap markers.
- Modify `agent/internal/eventlog/eventlog.go`: non-Windows error-returning stub.
- Create `agent/internal/eventlog/eventlog_windows_test.go`: missing-source registration and open/write failure tests.
- Modify `agent/internal/config/permissions_windows.go`: prepare and verify the lock parent.
- Modify `agent/internal/config/permissions_windows_test.go`: lock-parent DACL assertions.
- Modify `agent/internal/agentapp/main.go`: early acquisition and structured startup logs.
- Modify `agent/internal/sessionbroker/userhelper_path.go`: typed companion/fallback result.
- Modify `agent/internal/sessionbroker/userhelper_path_windows.go`: carry fallback provenance.
- Modify `agent/internal/sessionbroker/userhelper_path_test.go`: path plus fallback-kind tests.
- Modify `agent/internal/sessionbroker/spawner_windows.go`: include command mode/fallback in `SpawnedHelper` and spawn logs.

---

### Task 1: Pure startup classification and typed helper fallback

**Files:**
- Create: `agent/internal/agentapp/process_role.go`
- Create: `agent/internal/agentapp/process_role_test.go`
- Modify: `agent/internal/sessionbroker/userhelper_path.go:42-56`
- Modify: `agent/internal/sessionbroker/userhelper_path_windows.go:20-26`
- Modify: `agent/internal/sessionbroker/userhelper_path_test.go:18-85`
- Modify: `agent/internal/sessionbroker/spawner_windows.go:21-228`
- Modify: `agent/internal/sessionbroker/spawner_stub.go:16-37`

**Interfaces:**
- Produces: `ProcessStartup` and `classifyProcess`.
- Produces: `sessionbroker.ResolvedHelperExecutable{Path, MainBinaryFallback}`.
- Consumed by: instance metadata, main/helper startup logs, and `SpawnedHelper`.

- [ ] **Step 1: Write the process-classification table**

```go
package agentapp

import "testing"

func TestClassifyProcess(t *testing.T) {
	tests := []struct {
		name, command, role, exe string
		service                  bool
		wantMode                 string
		wantFallback             bool
	}{
		{"SCM main", "run", "", "breeze-agent.exe", true, "service-run", false},
		{"console main", "run", "", "breeze-agent.exe", false, "console-run", false},
		{"companion user", "user-helper", "user", "breeze-user-helper.exe", false, "user-helper", false},
		{"fallback user", "user-helper", "user", "breeze-agent.exe", false, "user-helper", true},
		{"renamed fallback user", "user-helper", "user", "breeze-agent-0.70.exe", false, "user-helper", true},
		{"companion system", "user-helper", "system", "breeze-user-helper.exe", false, "system-helper", false},
		{"status", "status", "", "breeze-agent.exe", false, "other", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mode, fallback := classifyProcess(tt.command, tt.role, tt.exe, tt.service)
			if mode != tt.wantMode || fallback != tt.wantFallback {
				t.Fatalf("got (%q,%v), want (%q,%v)", mode, fallback, tt.wantMode, tt.wantFallback)
			}
		})
	}
}
```

Extend `userhelper_path_test.go` so the companion case asserts `MainBinaryFallback == false` and the missing-companion case asserts `true`.

- [ ] **Step 2: Run tests and verify missing symbols**

Run: `cd agent && go test -race ./internal/agentapp ./internal/sessionbroker -run 'TestClassifyProcess|TestResolveUserHelperPath' -count=1`

Expected: FAIL because the classifier and typed helper result do not exist.

- [ ] **Step 3: Add the startup record and classifier**

```go
package agentapp

import (
	"path/filepath"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

type ProcessStartup struct {
	Binary             string    `json:"binary"`
	ExecutablePath     string    `json:"executablePath"`
	PID                int       `json:"pid"`
	ParentPID          int       `json:"parentPid"`
	WindowsSessionID   uint32    `json:"windowsSessionId"`
	LaunchMode         string    `json:"launchMode"`
	HelperRole         string    `json:"helperRole,omitempty"`
	LifecycleKey       string    `json:"lifecycleKey,omitempty"`
	CompanionHelper    bool      `json:"companionHelper"`
	MainBinaryFallback bool      `json:"mainBinaryFallback"`
	Version            string    `json:"version"`
	CreatedAt          time.Time `json:"createdAt"`
}

func classifyProcess(command, role, executable string, service bool) (string, bool) {
	base := strings.ToLower(filepath.Base(executable))
	fallback := command == "user-helper" && base != strings.ToLower(sessionbroker.UserHelperBinaryName)
	switch {
	case command == "run" && service:
		return "service-run", false
	case command == "run":
		return "console-run", false
	case command == "user-helper" && role == "system":
		return "system-helper", fallback
	case command == "user-helper" && role == "user":
		return "user-helper", fallback
	default:
		return "other", false
	}
}

func processStartupFields(s ProcessStartup) map[string]any {
	return map[string]any{
		"binary": s.Binary, "executablePath": s.ExecutablePath,
		"pid": s.PID, "parentPid": s.ParentPID,
		"windowsSessionId": s.WindowsSessionID, "launchMode": s.LaunchMode,
		"helperRole": s.HelperRole, "lifecycleKey": s.LifecycleKey,
		"companionHelper": s.CompanionHelper,
		"mainBinaryFallback": s.MainBinaryFallback,
		"version": s.Version, "createdAt": s.CreatedAt,
	}
}
```

When constructing `ProcessStartup`, set `CompanionHelper` when `command == "user-helper" && !MainBinaryFallback`; this is derived from the resolved executable, not the caller's claim.

- [ ] **Step 4: Return helper fallback provenance explicitly**

```go
type ResolvedHelperExecutable struct {
	Path               string
	MainBinaryFallback bool
}

func resolveUserHelperPath(agentExe string) (ResolvedHelperExecutable, error) {
	helper := filepath.Join(filepath.Dir(agentExe), UserHelperBinaryName)
	_, err := os.Stat(helper)
	if err == nil {
		return ResolvedHelperExecutable{Path: helper}, nil
	}
	if errors.Is(err, fs.ErrNotExist) {
		return ResolvedHelperExecutable{Path: agentExe, MainBinaryFallback: true}, nil
	}
	return ResolvedHelperExecutable{}, fmt.Errorf("stat %s: %w", helper, err)
}
```

Update both `SpawnHelperInSession` and `SpawnUserHelperInSession` to use `.Path`, and add `MainBinaryFallback bool` to both build-tagged `SpawnedHelper` definitions so the resolver result is retained immediately. Emit the existing missing-helper warning once per agent owner rather than once per reconcile.

- [ ] **Step 5: Run focused tests and commit**

Run: `cd agent && go test -race ./internal/agentapp ./internal/sessionbroker -run 'TestClassifyProcess|TestResolveUserHelperPath|TestUserHelperExePath' -count=1`

Expected: PASS.

```bash
git add agent/internal/agentapp/process_role.go agent/internal/agentapp/process_role_test.go agent/internal/sessionbroker/userhelper_path.go agent/internal/sessionbroker/userhelper_path_windows.go agent/internal/sessionbroker/userhelper_path_test.go agent/internal/sessionbroker/spawner_windows.go agent/internal/sessionbroker/spawner_stub.go
git commit -m "feat(agent): classify process roles and helper fallback"
```

---

### Task 2: Hardened ProgramData lock parent and exclusive Windows guard

**Files:**
- Create: `agent/internal/agentapp/main_instance.go`
- Create: `agent/internal/agentapp/main_instance_windows.go`
- Create: `agent/internal/agentapp/main_instance_other.go`
- Create: `agent/internal/agentapp/main_instance_windows_test.go`
- Modify: `agent/internal/config/permissions_windows.go:22-119`
- Modify: `agent/internal/config/permissions_windows_test.go:20-109`

**Interfaces:**
- Consumes: `ProcessStartup` from Task 1 and `config.ConfigDir()`.
- Produces: `mainAgentGuard`, `acquireMainAgentGuard(ProcessStartup)`, `ErrMainAgentAlreadyRunning`.
- Produces: `config.PrepareMainAgentLockDir() (string, error)`.

- [ ] **Step 1: Write Windows lock ownership tests**

```go
//go:build windows

func TestMainAgentGuardExclusiveAndReacquirable(t *testing.T) {
	dir := t.TempDir()
	prepareMainAgentLockDirFn = func() (string, error) { return dir, nil }
	t.Cleanup(func() { prepareMainAgentLockDirFn = config.PrepareMainAgentLockDir })
	meta := ProcessStartup{PID: os.Getpid(), LaunchMode: "console-run", CreatedAt: time.Now()}

	first, err := acquireMainAgentGuard(meta)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := acquireMainAgentGuard(meta); !errors.Is(err, ErrMainAgentAlreadyRunning) {
		t.Fatalf("second acquire err=%v, want ErrMainAgentAlreadyRunning", err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	third, err := acquireMainAgentGuard(meta)
	if err != nil {
		t.Fatalf("reacquire after close: %v", err)
	}
	_ = third.Close()
}

func TestStaleLockFileDoesNotBlock(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, mainAgentLockFile), []byte("stale"), 0o600); err != nil {
		t.Fatal(err)
	}
	prepareMainAgentLockDirFn = func() (string, error) { return dir, nil }
	guard, err := acquireMainAgentGuard(ProcessStartup{PID: os.Getpid(), LaunchMode: "console-run"})
	if err != nil {
		t.Fatal(err)
	}
	_ = guard.Close()
}
```

Add `TestPrepareMainAgentLockDirRejectsReparseParent`, `TestPrepareMainAgentLockDirRejectsUntrustedOwner`, `TestPrepareMainAgentLockDirSanitizesUntrustedExistingRunDir`, `TestPrepareMainAgentLockDirDetectsParentSwap`, `TestMainAgentGuardRejectsReparseFinalObject`, and `TestPrepareMainAgentLockDirDACLFailureIsSecurityError`. Introduce narrow Windows security/filesystem seams so these cases are deterministic on GitHub-hosted Windows runners; restore each seam with `t.Cleanup` and do not run those tests in parallel. Every case must return a wrapped security error that does not match `ErrMainAgentAlreadyRunning`.

- [ ] **Step 2: Run on Windows and verify missing symbols**

Run on Windows: `cd agent && go test -race ./internal/agentapp ./internal/config -run 'TestMainAgentGuard|TestStaleLock|TestPrepareMainAgentLockDir' -count=1`

Expected: FAIL because the guard and directory preparation do not exist.

- [ ] **Step 3: Add platform-neutral guard contracts**

```go
package agentapp

import (
	"errors"
	"os"
)

const (
	mainAgentLockFile      = "agent.lock"
	exitAlreadyRunning     = 17
	exitInstanceGuardError = 18
)

var ErrMainAgentAlreadyRunning = errors.New("main agent already running")

type mainAgentGuard interface {
	Close() error
}

var (
	acquireMainAgentGuardFn = acquireMainAgentGuard
	mainAgentExitFn         = os.Exit
)
```

The non-Windows implementation returns an idempotent no-op guard.

- [ ] **Step 4: Prepare and verify the protected parent**

Use a dedicated `filepath.Join(ConfigDir(), "run")` directory with private SDDL:

```go
const (
	windowsConfigDirCreateSDDL = "O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;;FRFX;;;BU)"
	windowsAgentRunDirSDDL     = "O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
)
```

`PrepareMainAgentLockDir` performs this fixed sequence:

1. Open `ConfigDir()` as a directory with `FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_BACKUP_SEMANTICS` and security-write rights; create it only through a Windows `CreateDirectory` call whose security attributes contain `windowsConfigDirCreateSDDL` and a BUILTIN\Administrators owner.
2. Through that handle, reject reparse attributes, set/repair the protected DACL and owner, then verify the owner is LocalSystem or BUILTIN\Administrators. An unprivileged or unknown owner that cannot be replaced is a security failure.
3. Reopen `ConfigDir()` by path and compare volume serial/file index to the original handle. A path swap is a security failure.
4. Atomically create `run` with `windowsAgentRunDirSDDL`. If it exists, open it no-follow, inspect owner/DACL, and repair through the handle. If its original owner was untrusted, treat its contents as hostile: remove the known `agent.lock` before use; failure to remove a held hostile file is a security failure, not a duplicate-agent result.
5. Reopen `run`, compare file identity, re-read owner/DACL/reparse attributes, and return only after proving it is the same trusted private directory.

Use `windows.SetSecurityInfo` on handles with `OWNER_SECURITY_INFORMATION|GROUP_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION|PROTECTED_DACL_SECURITY_INFORMATION`; path-based DACL application alone is insufficient. BUILTIN\Users retains read/traverse on `ConfigDir()` but has no access to the private `run` child. Fresh creation must be secure atomically—never `MkdirAll` followed by a DACL.

- [ ] **Step 5: Implement exclusive file acquisition**

```go
func acquireMainAgentGuard(meta ProcessStartup) (mainAgentGuard, error) {
	dir, err := prepareMainAgentLockDirFn()
	if err != nil {
		return nil, fmt.Errorf("prepare instance-lock directory: %w", err)
	}
	path := filepath.Join(dir, mainAgentLockFile)
	path16, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	sa, err := privateLockSecurityAttributes() // non-inheritable; trusted owner + SY/BA-only DACL
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(path16, windows.GENERIC_READ|windows.GENERIC_WRITE|windows.READ_CONTROL|windows.WRITE_DAC|windows.WRITE_OWNER, 0, sa, windows.OPEN_ALWAYS, windows.FILE_ATTRIBUTE_NORMAL|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		if errors.Is(err, windows.ERROR_SHARING_VIOLATION) || errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
			return nil, ErrMainAgentAlreadyRunning
		}
		return nil, fmt.Errorf("open main-agent lock: %w", err)
	}
	f := os.NewFile(uintptr(h), path)
	if f == nil {
		_ = windows.CloseHandle(h)
		return nil, errors.New("wrap main-agent lock handle")
	}
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &info); err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("inspect main-agent lock: %w", err)
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		_ = f.Close()
		return nil, errors.New("refuse reparse-point main-agent lock")
	}
	if err := hardenAndVerifyLockHandle(h); err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("verify main-agent lock security: %w", err)
	}
	if err := f.Truncate(0); err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("truncate main-agent lock metadata: %w", err)
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		_ = f.Close()
		return nil, err
	}
	if err := json.NewEncoder(f).Encode(meta); err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("write main-agent lock metadata: %w", err)
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("flush main-agent lock metadata: %w", err)
	}
	return &fileMainAgentGuard{file: f}, nil
}
```

`hardenAndVerifyLockHandle` requires a LocalSystem/Administrators owner, the protected SY/BA-only DACL, and the same non-reparse handle after security application. `fileMainAgentGuard.Close` swaps its file pointer to nil under a mutex before closing, making repeated calls idempotent. `privateLockSecurityAttributes` sets `InheritHandle=0`.

- [ ] **Step 6: Run native/cross-compile tests and commit**

Run on Windows: `cd agent && go test -race ./internal/agentapp ./internal/config -run 'TestMainAgentGuard|TestStaleLock|TestPrepareMainAgentLockDir' -count=1`

Run elsewhere: `cd agent && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go test -c -o /tmp/agentapp.test.exe ./internal/agentapp`

Expected: native tests PASS; cross-compilation succeeds.

```bash
git add agent/internal/agentapp/main_instance.go agent/internal/agentapp/main_instance_windows.go agent/internal/agentapp/main_instance_other.go agent/internal/agentapp/main_instance_windows_test.go agent/internal/config/permissions_windows.go agent/internal/config/permissions_windows_test.go
git commit -m "fix(agent): enforce one full Windows agent instance"
```

---

### Task 3: Acquire and emit bootstrap-safe failure markers before initialization

**Files:**
- Modify: `agent/internal/agentapp/main.go:910-985`
- Modify: `agent/internal/agentapp/main_test.go`
- Create: `agent/internal/agentapp/process_role_windows.go`
- Create: `agent/internal/agentapp/process_role_other.go`
- Create: `agent/internal/agentapp/instance_marker_windows.go`
- Create: `agent/internal/agentapp/instance_marker_other.go`
- Modify: `agent/internal/eventlog/eventlog_windows.go`
- Modify: `agent/internal/eventlog/eventlog.go`
- Create: `agent/internal/eventlog/eventlog_windows_test.go`

**Interfaces:**
- Consumes: guard and `ProcessStartup` from Tasks 1-2.
- Produces: `currentProcessStartup(command, role string, service bool) ProcessStartup`.
- Guarantees: duplicate/security failure returns before `reconcileServiceUnitIfNeeded` and `startAgentFn`.
- Produces: `writeInstanceGuardMarker(ProcessStartup, error)` using Windows Event Log before normal logging exists.
- Extends: `agent/internal/eventlog` with `WriteError(source, message string) error`, preserving the existing best-effort `Error` API.

- [ ] **Step 1: Add a test proving guard acquisition is first**

```go
func TestRunAgentDuplicateStopsBeforeInitialization(t *testing.T) {
	origAcquire := acquireMainAgentGuardFn
	origExit := mainAgentExitFn
	origMarker := writeInstanceGuardMarkerFn
	origReconcile := reconcileServiceUnitIfNeededFn
	origStart := startAgentFn
	t.Cleanup(func() {
		acquireMainAgentGuardFn = origAcquire
		mainAgentExitFn = origExit
		writeInstanceGuardMarkerFn = origMarker
		reconcileServiceUnitIfNeededFn = origReconcile
		startAgentFn = origStart
	})

	reconciled, started, markerWritten, exitCode := false, false, false, 0
	acquireMainAgentGuardFn = func(ProcessStartup) (mainAgentGuard, error) { return nil, ErrMainAgentAlreadyRunning }
	writeInstanceGuardMarkerFn = func(ProcessStartup, error) { markerWritten = true }
	mainAgentExitFn = func(code int) { exitCode = code }
	reconcileServiceUnitIfNeededFn = func() { reconciled = true }
	startAgentFn = func(*config.Config) (*agentComponents, error) { started = true; return nil, nil }

	runAgent()
	if exitCode != exitAlreadyRunning || reconciled || started || !markerWritten {
		t.Fatalf("exit=%d reconciled=%v started=%v marker=%v", exitCode, reconciled, started, markerWritten)
	}
}
```

If reconciliation is not currently behind a seam, introduce `reconcileServiceUnitIfNeededFn = reconcileServiceUnitIfNeeded` and use it only in `runAgent`.

- [ ] **Step 2: Run the test and verify it fails**

Run: `cd agent && go test -race ./internal/agentapp -run TestRunAgentDuplicateStopsBeforeInitialization -count=1`

Expected: FAIL because `runAgent` currently reconciles before acquiring a guard.

- [ ] **Step 3: Wire the guard at the first line of `runAgent`**

```go
func runAgent() {
	serviceMode := isWindowsService()
	startup := currentProcessStartup("run", "", serviceMode)
	guard, err := acquireMainAgentGuardFn(startup)
	if err != nil {
		writeInstanceGuardMarkerFn(startup, err)
		if errors.Is(err, ErrMainAgentAlreadyRunning) {
			fmt.Fprintf(os.Stderr, "Breeze main agent is already running (pid=%d session=%d mode=%s)\n", startup.PID, startup.WindowsSessionID, startup.LaunchMode)
			mainAgentExitFn(exitAlreadyRunning)
			return
		}
		fmt.Fprintf(os.Stderr, "Breeze main-agent instance guard failed: %v\n", err)
		mainAgentExitFn(exitInstanceGuardError)
		return
	}
	defer guard.Close()

	reconcileServiceUnitIfNeededFn()
	if serviceMode {
		if err := runAsService(cfgFile); err != nil {
			log.Error("service failed", "error", err.Error())
			mainAgentExitFn(1)
		}
		return
	}
	// Existing console-mode body remains after this point.
}
```

Cache `serviceMode`; do not call `isWindowsService` again for classification.

The Windows marker calls the existing `agent/internal/eventlog` wrapper (imported with an unambiguous alias), not `eventlog.Open` directly. Extend that wrapper with `WriteError(source, message string) error`: on first use it attempts `InstallAsEventCreate` with info/warning/error severities, then opens the source and writes the event; cache both handle and initialization error behind the existing per-source `sync.Once`. Keep `Error` source-compatible by discarding `WriteError`'s result. This makes a fresh installation register `BreezeAgent` before opening it while still handling an already-registered source. `instance_marker_windows.go` writes a structured, secret-free message through `WriteError`; if registration/open/write fails it reports that failure to stderr without touching the untrusted config path. It must not call the existing config-directory startup marker because guard failure may mean that path is untrusted.

Add `TestWriteErrorRegistersMissingSourceBeforeOpen`, `TestWriteErrorAlreadyRegisteredStillOpens`, and `TestWriteErrorReturnsRegistrationOpenFailure` in a Windows-tagged eventlog test using injected install/open/write seams; the missing-source test requires exact `install -> open -> write` order. Add separate agentapp duplicate and security-error tests asserting marker emission, dedicated exit codes, and zero initialization calls; inject `WriteError` there so tests do not depend on host registration.

Implement `currentProcessStartup` once and cache its result for the lifetime of the process:

```go
func currentProcessStartup(command, role string, service bool) ProcessStartup {
	exe, _ := os.Executable()
	meta := currentPlatformProcessMetadata() // kernel session ID, parent PID, and process creation time
	mode, fallback := classifyProcess(command, role, exe, service)
	lifecycleKey := ""
	if meta.WindowsSessionID != 0 && (role == "user" || role == "system") {
		lifecycleKey = fmt.Sprintf("%d-%s", meta.WindowsSessionID, role)
	}
	return ProcessStartup{
		Binary: filepath.Base(exe), ExecutablePath: exe,
		PID: os.Getpid(), ParentPID: meta.ParentPID,
		WindowsSessionID: meta.WindowsSessionID,
		LaunchMode: mode, HelperRole: role, LifecycleKey: lifecycleKey,
		CompanionHelper: command == "user-helper" && !fallback,
		MainBinaryFallback: fallback, Version: version,
		CreatedAt: meta.CreatedAt,
	}
}
```

On Windows, `currentPlatformProcessMetadata` uses `ProcessIdToSessionId`, a Toolhelp parent-PID snapshot, and `GetProcessTimes`; each unavailable diagnostic field is left at its zero value without weakening guard acquisition. The non-Windows file returns parent PID from `os.Getppid`, session zero, and the current time. Metadata collection must never open another process with mutation rights.

- [ ] **Step 4: Run main-agent tests**

Run: `cd agent && go test -race ./internal/eventlog ./internal/agentapp -run 'TestWriteError|TestRunAgent|TestClassifyProcess' -count=1`

Expected: PASS and duplicate/security error tests prove no initialization side effects.

- [ ] **Step 5: Commit startup integration**

```bash
git add agent/internal/agentapp/main.go agent/internal/agentapp/main_test.go agent/internal/agentapp/process_role_windows.go agent/internal/agentapp/process_role_other.go agent/internal/agentapp/instance_marker_windows.go agent/internal/agentapp/instance_marker_other.go agent/internal/eventlog/eventlog_windows.go agent/internal/eventlog/eventlog.go agent/internal/eventlog/eventlog_windows_test.go
git commit -m "fix(agent): acquire Windows instance guard before startup"
```

---

### Task 4: Structured process-role diagnostics

**Files:**
- Modify: `agent/internal/agentapp/main.go:527-610,1426-1555`
- Modify: `agent/internal/sessionbroker/spawner_windows.go:21-228`
- Modify: `agent/internal/sessionbroker/spawner_cmdline_test.go:22-45`
- Modify: `agent/internal/agentapp/main_test.go`

**Interfaces:**
- Consumes: `ProcessStartup`, typed fallback result, and `HelperKey` from the RDS plan.
- Produces one `process startup` event per process and enriched `SpawnedHelper` metadata.

- [ ] **Step 1: Add pure field-map tests**

```go
func TestProcessStartupFieldsContainRoleEvidenceOnly(t *testing.T) {
	startup := ProcessStartup{
		Binary: "breeze-agent.exe", ExecutablePath: `C:\Program Files\Breeze\breeze-agent.exe`,
		PID: 42, ParentPID: 4, WindowsSessionID: 7, LaunchMode: "user-helper",
		HelperRole: "user", LifecycleKey: "7-user", MainBinaryFallback: true,
		Version: "0.70.0", CreatedAt: time.Unix(100, 0),
	}
	fields := processStartupFields(startup)
	for _, key := range []string{"pid", "parentPid", "windowsSessionId", "launchMode", "helperRole", "lifecycleKey", "mainBinaryFallback"} {
		if _, ok := fields[key]; !ok {
			t.Fatalf("missing field %q", key)
		}
	}
	for _, forbidden := range []string{"authToken", "helperAuthToken", "mtlsKey"} {
		if _, ok := fields[forbidden]; ok {
			t.Fatalf("forbidden field %q", forbidden)
		}
	}
}
```

- [ ] **Step 2: Implement and wire one startup event per process**

After bootstrap logging is available, log the cached `ProcessStartup` record. Replace the existing `starting agent` and `starting helper` field sets with `processStartupFields`; do not duplicate the event later in `startAgent`.

Inside a helper process, build the startup record from the actual current executable plus the kernel-derived Windows session and authenticated role; `currentProcessStartup` computes `LifecycleKey`, companion mode, and fallback mode without trusting a claimed session. Separately, the parent agent's spawn event uses the typed `ResolvedHelperExecutable` retained in `SpawnedHelper`, so support sees the same fallback provenance even if the child exits before logging.

Extend `SpawnedHelper` with:

```go
type SpawnedHelper struct {
	PID                uint32
	Handle             windows.Handle
	BinaryPath         string
	CommandMode        string
	Role               string
	WindowsSessionID   uint32
	MainBinaryFallback bool
}
```

Populate all fields from the actual resolved executable and explicit spawn role.

- [ ] **Step 3: Run focused diagnostics/fallback tests**

Run: `cd agent && go test -race ./internal/agentapp ./internal/sessionbroker -run 'TestProcessStartup|TestClassifyProcess|TestResolveUserHelperPath|TestBuildUserHelperCmdLine' -count=1`

Expected: PASS.

- [ ] **Step 4: Perform Windows manual classification verification**

On a Windows test endpoint:

```powershell
Get-CimInstance Win32_Process |
  Where-Object Name -in @('breeze-agent.exe','breeze-user-helper.exe') |
  Select-Object ProcessId,ParentProcessId,SessionId,Name,CommandLine
```

Verify logs label the SCM PID as `service-run`, an elevated second `run` exits with code 17, companion helpers identify their session/role, and `breeze-agent.exe user-helper` is labeled `mainBinaryFallback=true` without being blocked by the guard.

- [ ] **Step 5: Run the full agent suite and commit**

Run: `cd agent && go test -race ./...`

Expected: PASS with no race report.

```bash
git add agent/internal/agentapp/main.go agent/internal/agentapp/main_test.go agent/internal/sessionbroker/spawner_windows.go agent/internal/sessionbroker/spawner_cmdline_test.go
git commit -m "feat(agent): report Windows process roles and fallback mode"
```

## Plan Completion Gate

- A second full `run` invocation exits before any mutation or component initialization.
- A stale lock file without a live exclusive handle does not block startup.
- Reparse/ACL/open failures fail closed and are not mislabeled as duplicates.
- Helper/admin commands never acquire the main-agent lock.
- Logs distinguish `service-run`, `console-run`, `user-helper`, `system-helper`, and fallback mode.
- Main helper processes never overwrite main-agent state.
- Native Windows tests and `cd agent && go test -race ./...` pass.
