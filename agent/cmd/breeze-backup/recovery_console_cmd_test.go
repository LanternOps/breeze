package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
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

// TestTryCreateRecoveryConsoleLock_NeverObservablyEmpty is the red-first
// regression test for a real bug this review round's first lock fix
// introduced: a bare O_CREATE|O_EXCL followed by a SEPARATE write left a
// window where the lock file existed but was still empty — long enough,
// under the W04b QEMU e2e's real (if slow, TCG-emulated) scheduling, for
// the competing console instance to read that empty content, conclude
// the lock was abandoned mid-write (the SIGKILL case this whole
// stale-reclaim mechanism exists to handle), and reclaim a lock the
// winner was still in the middle of legitimately creating — reproducing
// the exact duplicated-phase progress.json signature (two consoles
// racing) AcquireLock exists to prevent, confirmed on PR #5588's CI run.
// Fix: tryCreateRecoveryConsoleLock now writes the PID to a temp file in
// the same directory first, then publishes it with a single atomic
// os.Link into recoveryConsoleLockPath — no process can ever observe the
// path existing with anything but complete content.
//
// The exact interleaving can't be forced deterministically, so this
// stresses it instead: one goroutine repeatedly creates+releases the
// lock while another polls as fast as it can, failing the instant it
// ever sees the path exist with content that isn't a complete, valid PID.
func TestTryCreateRecoveryConsoleLock_NeverObservablyEmpty(t *testing.T) {
	path := withLockPath(t)

	stop := make(chan struct{})
	var badRead atomic.Bool
	var wg sync.WaitGroup

	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			data, err := os.ReadFile(path)
			if err != nil {
				continue // does not exist right now — fine
			}
			if _, convErr := strconv.Atoi(strings.TrimSpace(string(data))); convErr != nil {
				badRead.Store(true)
				return
			}
		}
	}()

	const attempts = 2000
	for i := 0; i < attempts; i++ {
		release, err := tryCreateRecoveryConsoleLock()
		if err == nil {
			release()
		}
	}

	close(stop)
	wg.Wait()

	if badRead.Load() {
		t.Fatal("a concurrent reader observed the lock file existing with incomplete/invalid content — tryCreateRecoveryConsoleLock is not atomic")
	}

	// No leftover temp files from the publish-by-rename/link mechanism.
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatalf("read lock dir: %v", err)
	}
	for _, e := range entries {
		t.Errorf("leftover file in lock directory: %s", e.Name())
	}
}
