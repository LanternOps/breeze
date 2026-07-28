//go:build linux || darwin

package helper

import (
	"os/exec"
	"syscall"
	"testing"
	"time"
)

// alive reports whether pid is a live process (signal 0 probes existence
// without delivering a signal).
func alive(pid int) bool {
	return syscall.Kill(pid, 0) == nil
}

// TestStopByPIDIfOurs is the regression guard for #2531: the terminate must be
// gated on an image-path match, so a PID that is NOT our helper is never killed.
// It exercises the identity check against a real, self-owned child process.
func TestStopByPIDIfOurs(t *testing.T) {
	cmd := exec.Command("sleep", "30")
	if err := cmd.Start(); err != nil {
		t.Skipf("cannot start helper child process: %v", err)
	}
	pid := cmd.Process.Pid
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	})

	// The canonical image path for this pid, as the platform reports it. Using
	// it as binaryPath makes the match self-consistent on every OS.
	exePath, err := processExePath(pid)
	if err != nil {
		t.Skipf("processExePath(%d) unavailable on this platform/runner: %v", pid, err)
	}

	// 1. Image path does NOT match -> refuse to terminate (the PID-reuse safety
	//    property: we only ever kill a process we positively identified).
	killed, err := stopByPIDIfOurs(pid, "/nonexistent/breeze-helper")
	if err != nil {
		t.Fatalf("stopByPIDIfOurs(mismatch) returned error: %v", err)
	}
	if killed {
		t.Fatal("stopByPIDIfOurs killed a process whose image path did not match")
	}
	if !alive(pid) {
		t.Fatal("child was terminated despite an image-path mismatch")
	}

	// 2. Image path matches -> terminate.
	killed, err = stopByPIDIfOurs(pid, exePath)
	if err != nil {
		t.Fatalf("stopByPIDIfOurs(match) returned error: %v", err)
	}
	if !killed {
		t.Fatal("stopByPIDIfOurs did not terminate a matching process")
	}
	_, _ = cmd.Process.Wait() // reap
	deadline := time.Now().Add(2 * time.Second)
	for alive(pid) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if alive(pid) {
		t.Fatal("child still alive after stopByPIDIfOurs reported a kill")
	}

	// 3. A non-positive PID is a harmless no-op, never an error.
	if killed, err := stopByPIDIfOurs(0, exePath); killed || err != nil {
		t.Fatalf("stopByPIDIfOurs(0) = (%v, %v), want (false, nil)", killed, err)
	}
}
