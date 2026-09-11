package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// withFastLockPolling swaps in a short poll interval for the duration of a
// test, so tests waiting on a live lock don't actually wait
// recoveryConsoleLockPollInterval's real-world value.
func withFastLockPolling(t *testing.T) {
	t.Helper()
	orig := recoveryConsoleLockPollInterval
	recoveryConsoleLockPollInterval = 5 * time.Millisecond
	t.Cleanup(func() { recoveryConsoleLockPollInterval = orig })
}

// withLockPath points recoveryConsoleLockPath at a file under a fresh
// t.TempDir() for the duration of a test, restoring the real
// /run/breeze-recovery-console.lock path afterwards.
func withLockPath(t *testing.T) string {
	t.Helper()
	orig := recoveryConsoleLockPath
	path := filepath.Join(t.TempDir(), "breeze-recovery-console.lock")
	recoveryConsoleLockPath = path
	t.Cleanup(func() { recoveryConsoleLockPath = orig })
	return path
}

// stubProcessAlive overrides the processAlive seam for the duration of a
// test, restoring the real (platform-specific) implementation afterwards.
func stubProcessAlive(t *testing.T, alive func(pid int) bool) {
	t.Helper()
	orig := processAlive
	processAlive = alive
	t.Cleanup(func() { processAlive = orig })
}

// TestAcquireRecoveryConsoleLock_StaleLockWithDeadPIDIsReclaimed is the
// red-first regression test for the code-review finding: a bare
// O_CREATE|O_EXCL lock left behind by a SIGKILLed/OOM-killed instance
// (whose systemd Restart=always brings the SAME unit back up) must not
// wedge the new instance forever. A lock file recording a PID that is no
// longer alive must be reclaimed.
func TestAcquireRecoveryConsoleLock_StaleLockWithDeadPIDIsReclaimed(t *testing.T) {
	path := withLockPath(t)
	withFastLockPolling(t)
	stubProcessAlive(t, func(pid int) bool { return false }) // nothing is alive in this test

	if err := os.WriteFile(path, []byte("999999\n"), 0o600); err != nil {
		t.Fatalf("seed stale lock file: %v", err)
	}

	var out bytes.Buffer
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	release, err := acquireRecoveryConsoleLock(ctx, &out)
	if err != nil {
		t.Fatalf("acquireRecoveryConsoleLock() error = %v, want a reclaimed lock", err)
	}
	if release == nil {
		t.Fatal("release func = nil, want non-nil")
	}
	defer release()

	// The reclaiming instance must have stamped its own PID over the dead
	// one.
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read reclaimed lock: %v", err)
	}
	gotPID, convErr := strconv.Atoi(strings.TrimSpace(string(data)))
	if convErr != nil || gotPID != os.Getpid() {
		t.Errorf("lock file holds %q, want this process's pid %d", string(data), os.Getpid())
	}

	release()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("lock file still exists after release: err = %v", err)
	}
}

// TestAcquireRecoveryConsoleLock_EmptyLockFileIsTreatedAsStale covers the
// SIGKILL-between-O_CREATE-and-write-PID case explicitly: the lock file
// exists but was never stamped with a holder PID at all.
func TestAcquireRecoveryConsoleLock_EmptyLockFileIsTreatedAsStale(t *testing.T) {
	path := withLockPath(t)
	withFastLockPolling(t)
	stubProcessAlive(t, func(pid int) bool {
		t.Fatalf("processAlive should not be consulted for an unreadable pid")
		return true
	})

	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatalf("seed empty lock file: %v", err)
	}

	var out bytes.Buffer
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	release, err := acquireRecoveryConsoleLock(ctx, &out)
	if err != nil {
		t.Fatalf("acquireRecoveryConsoleLock() error = %v, want a reclaimed lock", err)
	}
	defer release()
}

// TestAcquireRecoveryConsoleLock_LiveLockBlocksWithMessage proves a lock
// file recording a genuinely live PID (this test process's own pid — the
// one PID a test can assert liveness of without faking the OS) is NOT
// reclaimed: the caller blocks, polling, and prints the documented waiting
// message exactly once, until ctx is cancelled.
func TestAcquireRecoveryConsoleLock_LiveLockBlocksWithMessage(t *testing.T) {
	path := withLockPath(t)
	withFastLockPolling(t)
	stubProcessAlive(t, func(pid int) bool { return pid == os.Getpid() })

	if err := os.WriteFile(path, []byte(strconv.Itoa(os.Getpid())+"\n"), 0o600); err != nil {
		t.Fatalf("seed live lock file: %v", err)
	}

	var out bytes.Buffer
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	release, err := acquireRecoveryConsoleLock(ctx, &out)
	if err == nil {
		t.Fatal("acquireRecoveryConsoleLock() error = nil, want ctx deadline error (lock is genuinely held)")
	}
	if release != nil {
		t.Error("release func != nil, want nil on a losing/aborted acquisition")
	}

	want := "waiting for the recovery console lock (held by pid " + strconv.Itoa(os.Getpid()) + " on another console)"
	if !strings.Contains(out.String(), want) {
		t.Errorf("output = %q, want it to contain %q", out.String(), want)
	}
	// Printed exactly once, not once per poll tick.
	if n := strings.Count(out.String(), "waiting for the recovery console lock"); n != 1 {
		t.Errorf("waiting message printed %d times, want 1", n)
	}

	// The losing instance must not have touched the still-live lock.
	data, readErr := os.ReadFile(path)
	if readErr != nil {
		t.Fatalf("lock file missing after losing instance gave up: %v", readErr)
	}
	if strings.TrimSpace(string(data)) != strconv.Itoa(os.Getpid()) {
		t.Errorf("lock file contents changed to %q, want untouched", string(data))
	}
}
