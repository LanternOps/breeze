package executor

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// sleepScript builds a long-running bash script used to hold an execution open
// while a cancel races it.
func sleepScript(id string, seconds int) ScriptExecution {
	return ScriptExecution{
		ID:         id,
		ScriptID:   "script-" + id,
		ScriptType: ScriptTypeBash,
		// A loop of short sleeps rather than one long sleep: bash defers trap
		// handling until the running command returns, so `sleep 600` would
		// swallow SIGTERM for ten minutes and make the graceful-escalation
		// tests below indistinguishable from a hard kill.
		Script:  fmt.Sprintf("for _ in $(seq 1 %d); do sleep 0.1; done\n", seconds*10),
		Timeout: 300,
	}
}

// sigtermTrapScript traps SIGTERM, writes marker, then exits cleanly. If the
// marker exists after a cancel, SIGTERM was genuinely delivered before SIGKILL.
func sigtermTrapScript(id, marker string, seconds int) ScriptExecution {
	s := sleepScript(id, seconds)
	s.Script = fmt.Sprintf("trap 'printf caught > %q; exit 0' TERM\n", marker) + s.Script
	return s
}

// waitForRunning blocks until the executor has an entry for id whose process
// has actually been started.
func waitForRunning(t *testing.T, e *Executor, id string) *runningExecution {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		e.mu.Lock()
		r, ok := e.running[id]
		e.mu.Unlock()
		if ok && r.hasStarted() {
			return r
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("execution %q never reached a started state", id)
	return nil
}

func skipWithoutBash(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("bash-based cancellation tests are Unix-only")
	}
	if _, err := os.Stat("/bin/bash"); err != nil {
		t.Skip("/bin/bash unavailable")
	}
}

func TestCancelBlocksUntilTheProcessIsGone(t *testing.T) {
	skipWithoutBash(t)
	e := newTestExecutor()
	done := make(chan *ScriptResult, 1)
	go func() { r, _ := e.Execute(sleepScript("id-1", 60)); done <- r }()
	waitForRunning(t, e, "id-1")

	outcome, err := e.Cancel("id-1", 0)
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if outcome != CancelTerminated {
		t.Fatalf("outcome = %q, want terminated", outcome)
	}
	// Cancel must not return before the kill is observed: the server's
	// `confirmed` flag is built on this ack.
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Cancel returned terminated while the process was still running")
	}
}

func TestCancelReportsNotFoundForAnUnknownID(t *testing.T) {
	e := newTestExecutor()
	outcome, err := e.Cancel("nope", 5)
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if outcome != CancelNotFound {
		t.Fatalf("outcome = %q, want not_found", outcome)
	}
}

func TestCancelledResultCarriesTheCancellationMarker(t *testing.T) {
	skipWithoutBash(t)
	e := newTestExecutor()
	done := make(chan *ScriptResult, 1)
	go func() { r, _ := e.Execute(sleepScript("id-2", 60)); done <- r }()
	waitForRunning(t, e, "id-2")
	e.SetCancelCommandID("id-2", "cancel-cmd-7")
	if _, err := e.Cancel("id-2", 0); err != nil {
		t.Fatal(err)
	}

	var res *ScriptResult
	select {
	case res = <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("execution never returned a result after cancel")
	}
	// Without this the server cannot tell "we killed it" from "it finished on
	// its own", and OD9-C forces it to preserve the natural outcome.
	if !res.Cancelled {
		t.Fatal("result.Cancelled = false, want true")
	}
	if res.CancelledByCommandID != "cancel-cmd-7" {
		t.Fatalf("CancelledByCommandID = %q, want cancel-cmd-7", res.CancelledByCommandID)
	}
}

func TestGracefulEscalationSendsSIGTERMBeforeSIGKILL(t *testing.T) {
	skipWithoutBash(t)
	marker := filepath.Join(t.TempDir(), "term-marker")
	e := newTestExecutor()
	done := make(chan struct{})
	go func() { defer close(done); _, _ = e.Execute(sigtermTrapScript("id-3", marker, 60)) }()
	waitForRunning(t, e, "id-3")

	outcome, err := e.Cancel("id-3", 5)
	if err != nil {
		t.Fatal(err)
	}
	if outcome != CancelTerminated {
		t.Fatalf("outcome = %q, want terminated", outcome)
	}
	<-done
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("SIGTERM was never delivered before SIGKILL: %v", err)
	}
}

func TestZeroGraceSkipsStraightToKill(t *testing.T) {
	skipWithoutBash(t)
	marker := filepath.Join(t.TempDir(), "term-marker")
	e := newTestExecutor()
	done := make(chan struct{})
	go func() { defer close(done); _, _ = e.Execute(sigtermTrapScript("id-5", marker, 60)) }()
	waitForRunning(t, e, "id-5")

	if _, err := e.Cancel("id-5", 0); err != nil {
		t.Fatal(err)
	}
	<-done
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("graceSeconds=0 still delivered SIGTERM; the trap ran")
	}
}

func TestCancelBeforeRegistrationPreventsTheScriptFromStarting(t *testing.T) {
	skipWithoutBash(t)
	// Execute validates, writes the script file and calls configureRunAs BEFORE
	// inserting into e.running, and WebSocket commands are concurrent. A cancel
	// in that window must not return not_found and let the script start anyway.
	e := newTestExecutor()
	e.reserve("id-4", time.Now(), ScriptTypeBash) // pre-start placeholder, inserted first

	outcome, err := e.Cancel("id-4", 0)
	if err != nil {
		t.Fatal(err)
	}
	if outcome == CancelNotFound {
		t.Fatal("cancel raced Execute's setup and reported not_found")
	}

	res, _ := e.Execute(sleepScript("id-4", 60))
	if !res.Cancelled {
		t.Fatal("script started despite a cancel that arrived first")
	}
}

func TestClampGraceBoundsTheRequestedWindow(t *testing.T) {
	for _, tc := range []struct{ in, want int }{{-1, 0}, {0, 0}, {5, 5}, {30, 30}, {31, 30}, {9999, 30}} {
		if got := clampGrace(tc.in); got != tc.want {
			t.Errorf("clampGrace(%d) = %d, want %d", tc.in, got, tc.want)
		}
	}
}
