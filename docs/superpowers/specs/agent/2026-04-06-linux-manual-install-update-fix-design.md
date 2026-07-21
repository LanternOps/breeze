# Linux Agent Auto-Update Fix for Manual Installs

**Issue**: LanternOps/breeze#368
**Date**: 2026-04-06

## Problem

A Linux agent started manually (not via systemd) fails to auto-update. The agent stays on the old version with no clear error.

### Root Causes

1. **ETXTBSY**: `replaceBinary()` uses `os.Create()` which truncates the running executable's inode. Linux returns `ETXTBSY` ("text file busy") when opening a running executable for writing.

2. **ETXTBSY misclassified**: `checkWritable()` wraps `ETXTBSY` as `ErrReadOnlyFS`, which causes `doUpgrade()` to permanently disable auto-update — the wrong response to a transient condition.

3. **Silent restart failures**: `restart_unix.go` has no logger. `restartSystemd()` and `restartLaunchd()` discard stderr. All three fallback steps fail without any log output.

## Design

### 1. Fix `replaceBinary()` — unlink before write

**File**: `agent/internal/updater/updater.go`, `replaceBinary()` method

On Unix (non-Windows), unlink the existing binary before creating the new file:

```go
if runtime.GOOS != "windows" {
    os.Remove(u.config.BinaryPath) // unlink old inode; kernel keeps it alive for running process
}
dst, err := os.Create(u.config.BinaryPath) // creates new inode at same path
```

This is the standard pattern used by package managers. The kernel maintains the old inode's refcount for the running process's memory-mapped text segment. The new file at the same path gets a fresh inode with the new binary content.

The Windows path already handles this via rename-first (line 306-311) and is unchanged.

### 2. Add `ErrTextBusy` sentinel

**File**: `agent/internal/updater/updater.go`

Add a new sentinel error:

```go
var ErrTextBusy = fmt.Errorf("binary is currently executing")
```

Update `checkWritable()` to detect `syscall.ETXTBSY`:

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

With the unlink fix in `replaceBinary()`, the `checkWritable()` preflight should no longer hit ETXTBSY (since it opens without truncating, which may or may not trigger ETXTBSY depending on kernel). But as defense-in-depth, having the sentinel prevents ETXTBSY from ever being misclassified as read-only FS.

### 3. Handle `ErrTextBusy` in `doUpgrade()`

**File**: `agent/internal/heartbeat/heartbeat.go`, `doUpgrade()` method

Add a case after the `ErrFileLocked` check:

```go
if errors.Is(err, updater.ErrTextBusy) {
    log.Warn("update deferred: binary is executing, will retry", "targetVersion", targetVersion, "error", err.Error())
    return
}
```

This treats ETXTBSY as transient (retry next heartbeat) rather than permanent (disable auto-update).

### 4. Add logging to `restart_unix.go`

**File**: `agent/internal/updater/restart_unix.go`

- The package-level `var log` is already declared in `updater.go` (same package) — no new declaration needed
- Use `cmd.CombinedOutput()` instead of `cmd.Run()` to capture stderr
- Log each restart attempt and its outcome
- When falling through to `restartExec()`, log a warning that no service manager was detected

```go
func restartSystemd() error {
    out, err := exec.Command("systemctl", "restart", "breeze-agent").CombinedOutput()
    if err != nil {
        log.Debug("systemd restart failed", "error", err.Error(), "output", string(out))
        return err
    }
    log.Info("restarted via systemd")
    return nil
}
```

Similar for `restartLaunchd()`.

In `Restart()`, add a warning before the `restartExec()` fallback:

```go
log.Warn("no service manager available, falling back to exec — agent will not auto-restart on crash")
return restartExec()
```

## Files Changed

| File | Change |
|------|--------|
| `agent/internal/updater/updater.go` | Add `ErrTextBusy`, unlink before write in `replaceBinary()`, detect ETXTBSY in `checkWritable()` |
| `agent/internal/updater/restart_unix.go` | Add logger, capture stderr, log each fallback step |
| `agent/internal/heartbeat/heartbeat.go` | Handle `ErrTextBusy` as transient in `doUpgrade()` |

## Testing

- **Unit test**: `replaceBinary()` on a file that simulates a running executable (create file, open for read to hold inode, call replaceBinary, verify new content)
- **Unit test**: `checkWritable()` returns `ErrTextBusy` when given `ETXTBSY` error
- **Manual test**: Start agent manually on Linux, trigger update via heartbeat, verify update completes and agent restarts on new version
- **Existing tests**: Run `go test -race ./internal/updater/...` to verify no regressions

## Non-Goals

- Daemonizing the manually-started agent (changes process model expectations)
- Atomic rename-based swap (unlink+create is sufficient given existing backup/rollback)
- Changing Windows or macOS update paths (not affected by this bug)
