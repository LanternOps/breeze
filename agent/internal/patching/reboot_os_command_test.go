package patching

import (
	"strings"
	"testing"
	"time"
)

// TestRunRebootCommandKillsAnUnresponsiveShutdown is the liveness guard for the
// osInvoking flag. runOSReboot holds osInvoking for exactly as long as
// execOSReboot runs, and Cancel, Defer and a re-schedule are all refused during
// it — so a shutdown binary that never returns would leave the manager refusing
// every operation forever.
func TestRunRebootCommandKillsAnUnresponsiveShutdown(t *testing.T) {
	prev := osRebootCommandTimeout
	osRebootCommandTimeout = 150 * time.Millisecond
	t.Cleanup(func() { osRebootCommandTimeout = prev })

	start := time.Now()
	err := runRebootCommand("sleep", "30")
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("a command that never returned reported success")
	}
	if !strings.Contains(err.Error(), "killed") {
		t.Errorf("error = %q, want it to say the command was killed", err)
	}
	if elapsed > 5*time.Second {
		t.Errorf("runRebootCommand took %v; the timeout did not fire", elapsed)
	}
}

func TestRunRebootCommandReportsTheCommandLineAndOutput(t *testing.T) {
	err := runRebootCommand("sh", "-c", "echo boom >&2; exit 3")
	if err == nil {
		t.Fatal("a failing command reported success")
	}
	if !strings.Contains(err.Error(), "boom") {
		t.Errorf("error = %q, want it to carry the command's output", err)
	}
	if !strings.Contains(err.Error(), "sh -c") {
		t.Errorf("error = %q, want it to name the command that failed", err)
	}
	if strings.Contains(err.Error(), "killed") {
		t.Errorf("error = %q, want an ordinary failure distinguished from a timeout kill", err)
	}
}

func TestRunRebootCommandSucceeds(t *testing.T) {
	if err := runRebootCommand("true"); err != nil {
		t.Fatalf("runRebootCommand on a successful command: %v", err)
	}
}
