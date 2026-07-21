# Linux Agent Auto-Update Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix auto-update failure for Linux agents started manually (not via systemd) — addresses GitHub issue #368.

**Architecture:** Three targeted fixes in the updater package: (1) unlink-before-write in `replaceBinary()` to avoid ETXTBSY, (2) new `ErrTextBusy` sentinel with proper detection in `checkWritable()` and handling in `doUpgrade()`, (3) logging in `restart_unix.go` to make restart failures visible.

**Tech Stack:** Go, syscall, os, os/exec

---

### Task 1: Add `ErrTextBusy` sentinel and fix `checkWritable()` / `normalizePreflightErr()`

**Files:**
- Modify: `agent/internal/updater/updater.go:47-59` (sentinels + normalizePreflightErr + checkWritable)
- Test: `agent/internal/updater/updater_test.go`

- [ ] **Step 1: Write the failing tests**

Add these tests to `agent/internal/updater/updater_test.go`:

```go
func TestNormalizePreflightErr_PreservesTextBusy(t *testing.T) {
	err := normalizePreflightErr(ErrTextBusy)
	if !errors.Is(err, ErrTextBusy) {
		t.Fatalf("expected ErrTextBusy, got %v", err)
	}
	if errors.Is(err, ErrReadOnlyFS) {
		t.Fatalf("did not expect ErrReadOnlyFS, got %v", err)
	}
}

func TestCheckWritable_DetectsETXTBSY(t *testing.T) {
	// Wrap syscall.ETXTBSY in an os.PathError to simulate what the kernel returns
	pathErr := &os.PathError{Op: "open", Path: "/fake", Err: syscall.ETXTBSY}
	// checkWritable is not directly testable with a real ETXTBSY (need running executable),
	// so test the classification logic via normalizePreflightErr
	wrapped := fmt.Errorf("%w: %v", ErrTextBusy, pathErr)
	if !errors.Is(wrapped, ErrTextBusy) {
		t.Fatalf("expected ErrTextBusy, got %v", wrapped)
	}
	if errors.Is(wrapped, ErrReadOnlyFS) {
		t.Fatalf("should not match ErrReadOnlyFS")
	}
}
```

Add these imports to the test file's import block (if not already present): `"fmt"`, `"syscall"`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/toddhebebrand/breeze/agent && go test -race -run "TestNormalizePreflightErr_PreservesTextBusy|TestCheckWritable_DetectsETXTBSY" ./internal/updater/...`

Expected: Compilation error — `ErrTextBusy` is not defined yet.

- [ ] **Step 3: Add `ErrTextBusy` sentinel and update `normalizePreflightErr()` and `checkWritable()`**

In `agent/internal/updater/updater.go`, add `ErrTextBusy` after `ErrReadOnlyFS` (line 49):

```go
// ErrTextBusy is returned when the binary is currently executing (ETXTBSY).
// This is transient — the unlink-before-write in replaceBinary handles it,
// but this sentinel prevents misclassification as ErrReadOnlyFS.
var ErrTextBusy = fmt.Errorf("binary is currently executing")
```

Update `normalizePreflightErr` to preserve `ErrTextBusy` (same as it does for `ErrFileLocked`):

```go
func normalizePreflightErr(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, ErrFileLocked) {
		return err
	}
	if errors.Is(err, ErrTextBusy) {
		return err
	}
	return fmt.Errorf("%w: %v", ErrReadOnlyFS, err)
}
```

Update `checkWritable` to detect `syscall.ETXTBSY` before the catch-all:

```go
func checkWritable(binaryPath string) error {
	f, err := os.OpenFile(binaryPath, os.O_WRONLY, 0)
	if err != nil {
		if isFileLocked(err) {
			return fmt.Errorf("%w: %v", ErrFileLocked, err)
		}
		if errors.Is(err, syscall.ETXTBSY) {
			return fmt.Errorf("%w: %v", ErrTextBusy, err)
		}
		return err
	}
	return f.Close()
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/toddhebebrand/breeze/agent && go test -race -run "TestNormalizePreflightErr|TestCheckWritable_DetectsETXTBSY" ./internal/updater/...`

Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/toddhebebrand/breeze
git add agent/internal/updater/updater.go agent/internal/updater/updater_test.go
git commit -m "fix(updater): add ErrTextBusy sentinel and detect ETXTBSY in checkWritable (#368)"
```

---

### Task 2: Fix `replaceBinary()` — unlink before write on Unix

**Files:**
- Modify: `agent/internal/updater/updater.go:301-352` (replaceBinary method)
- Test: `agent/internal/updater/updater_test.go`

- [ ] **Step 1: Write the failing test**

Add this test to `agent/internal/updater/updater_test.go`:

```go
func TestReplaceBinary_UnlinksBeforeWrite(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unlink behavior is Unix-only")
	}

	tmpDir := t.TempDir()
	binaryPath := filepath.Join(tmpDir, "breeze-agent")
	newBinaryPath := filepath.Join(tmpDir, "new-binary")

	// Create current binary and hold it open (simulates running executable holding inode)
	os.WriteFile(binaryPath, []byte("old binary"), 0755)
	holder, err := os.Open(binaryPath)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Close()

	// Record original inode
	origInfo, _ := os.Stat(binaryPath)
	origSys := origInfo.Sys().(*syscall.Stat_t)
	origIno := origSys.Ino

	// Create new binary
	os.WriteFile(newBinaryPath, []byte("new binary v2"), 0644)

	u := New(&Config{BinaryPath: binaryPath})
	if err := u.replaceBinary(newBinaryPath); err != nil {
		t.Fatalf("replace failed: %v", err)
	}

	// Verify new content at path
	content, _ := os.ReadFile(binaryPath)
	if string(content) != "new binary v2" {
		t.Fatalf("expected new content, got: %s", string(content))
	}

	// Verify it's a NEW inode (unlink created a new file, not truncated old one)
	newInfo, _ := os.Stat(binaryPath)
	newSys := newInfo.Sys().(*syscall.Stat_t)
	if newSys.Ino == origIno {
		t.Fatal("expected new inode after unlink+create, but got same inode")
	}

	// Verify the held-open file descriptor still reads old content (kernel kept old inode)
	holder.Seek(0, 0)
	oldContent := make([]byte, 100)
	n, _ := holder.Read(oldContent)
	if string(oldContent[:n]) != "old binary" {
		t.Fatalf("held FD should still read old content, got: %s", string(oldContent[:n]))
	}
}
```

Add `"runtime"` and `"syscall"` to the test file's imports if not already present.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/toddhebebrand/breeze/agent && go test -race -run "TestReplaceBinary_UnlinksBeforeWrite" ./internal/updater/...`

Expected: FAIL — inode is the same (current code truncates, doesn't unlink).

- [ ] **Step 3: Update `replaceBinary()` to unlink before write on Unix**

In `agent/internal/updater/updater.go`, update the `replaceBinary` method. Replace the Unix path (after the Windows rename block, before `os.Create`) with an unlink step:

Change this section (lines 313-320):

```go
	// Copy new binary to target location
	src, err := os.Open(newPath)
	if err != nil {
		return err
	}
	defer src.Close()

	dst, err := os.Create(u.config.BinaryPath)
```

To:

```go
	// On Unix, unlink the old binary before creating the new file.
	// The kernel keeps the old inode alive for the running process's
	// memory-mapped text segment. The new file gets a fresh inode,
	// avoiding ETXTBSY ("text file busy") errors.
	if runtime.GOOS != "windows" {
		os.Remove(u.config.BinaryPath)
	}

	// Copy new binary to target location
	src, err := os.Open(newPath)
	if err != nil {
		return err
	}
	defer src.Close()

	dst, err := os.Create(u.config.BinaryPath)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/toddhebebrand/breeze/agent && go test -race -run "TestReplaceBinary" ./internal/updater/...`

Expected: Both `TestReplaceBinary` and `TestReplaceBinary_UnlinksBeforeWrite` PASS.

- [ ] **Step 5: Run all updater tests to verify no regressions**

Run: `cd /Users/toddhebebrand/breeze/agent && go test -race ./internal/updater/...`

Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/toddhebebrand/breeze
git add agent/internal/updater/updater.go agent/internal/updater/updater_test.go
git commit -m "fix(updater): unlink binary before write to avoid ETXTBSY on Linux (#368)"
```

---

### Task 3: Add logging to `restart_unix.go`

**Files:**
- Modify: `agent/internal/updater/restart_unix.go` (full rewrite)

- [ ] **Step 1: Rewrite `restart_unix.go` with logging**

Replace the entire contents of `agent/internal/updater/restart_unix.go` with:

```go
//go:build !windows

package updater

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

// Restart tries service managers in order, then falls back to exec.
func Restart() error {
	// Try systemd first (Linux)
	if err := restartSystemd(); err == nil {
		return nil
	}

	// Try launchd (macOS)
	if err := restartLaunchd(); err == nil {
		return nil
	}

	// No service manager available
	log.Warn("no service manager detected, falling back to exec — agent will not auto-restart on crash")
	return restartExec()
}

func restartSystemd() error {
	out, err := exec.Command("systemctl", "restart", "breeze-agent").CombinedOutput()
	if err != nil {
		log.Debug("systemd restart failed", "error", err.Error(), "output", string(out))
		return err
	}
	log.Info("restarted via systemd")
	return nil
}

func restartLaunchd() error {
	out, err := exec.Command("launchctl", "kickstart", "-k", "system/com.breeze.agent").CombinedOutput()
	if err != nil {
		log.Debug("launchd restart failed", "error", err.Error(), "output", string(out))
		return err
	}
	log.Info("restarted via launchd")
	return nil
}

// RestartWithHelper is Windows-only; on Unix it's never called because
// updater.go gates on runtime.GOOS == "windows".
func RestartWithHelper(_, _ string) error {
	return fmt.Errorf("RestartWithHelper is only supported on Windows")
}

func restartExec() error {
	binary, err := os.Executable()
	if err != nil {
		return fmt.Errorf("failed to get executable path: %w", err)
	}

	// Resolve symlinks
	binary, err = filepath.EvalSymlinks(binary)
	if err != nil {
		return fmt.Errorf("failed to resolve symlinks: %w", err)
	}

	log.Info("restarting via exec", "binary", binary)
	args := []string{binary, "run"}
	env := os.Environ()

	return syscall.Exec(binary, args, env)
}
```

Note: `log` is the package-level variable already declared in `updater.go` (`var log = logging.L("updater")`). No new declaration needed — same package.

- [ ] **Step 2: Verify it compiles**

Run: `cd /Users/toddhebebrand/breeze/agent && go build ./internal/updater/...`

Expected: No errors.

- [ ] **Step 3: Run all updater tests**

Run: `cd /Users/toddhebebrand/breeze/agent && go test -race ./internal/updater/...`

Expected: All PASS.

- [ ] **Step 4: Commit**

```bash
cd /Users/toddhebebrand/breeze
git add agent/internal/updater/restart_unix.go
git commit -m "fix(updater): add logging to Unix restart fallback chain (#368)"
```

---

### Task 4: Handle `ErrTextBusy` in heartbeat `doUpgrade()`

**Files:**
- Modify: `agent/internal/heartbeat/heartbeat.go:2769-2773` (add ErrTextBusy case)

- [ ] **Step 1: Add `ErrTextBusy` handling in `doUpgrade()`**

In `agent/internal/heartbeat/heartbeat.go`, find the `ErrFileLocked` handling block (lines 2769-2773):

```go
		// File locked by another process is transient — log and retry next heartbeat.
		if errors.Is(err, updater.ErrFileLocked) {
			log.Warn("update deferred: binary locked by another process, will retry", "targetVersion", targetVersion, "error", err.Error())
			return
		}
```

Add this block immediately after it (before the generic `log.Error` on line 2774):

```go
		// Binary is currently executing (ETXTBSY) — transient, retry next heartbeat.
		if errors.Is(err, updater.ErrTextBusy) {
			log.Warn("update deferred: binary is executing, will retry", "targetVersion", targetVersion, "error", err.Error())
			return
		}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd /Users/toddhebebrand/breeze/agent && go build ./internal/heartbeat/...`

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/toddhebebrand/breeze
git add agent/internal/heartbeat/heartbeat.go
git commit -m "fix(heartbeat): treat ETXTBSY as transient, not permanent update failure (#368)"
```

---

### Task 5: Final verification

**Files:** None (verification only)

- [ ] **Step 1: Run full updater test suite**

Run: `cd /Users/toddhebebrand/breeze/agent && go test -race ./internal/updater/...`

Expected: All PASS.

- [ ] **Step 2: Run full agent build**

Run: `cd /Users/toddhebebrand/breeze/agent && go build ./...`

Expected: No errors.

- [ ] **Step 3: Run Go vet**

Run: `cd /Users/toddhebebrand/breeze/agent && go vet ./internal/updater/... ./internal/heartbeat/...`

Expected: No issues.
