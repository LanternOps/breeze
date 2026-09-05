package executor

import (
	"context"
	"fmt"
	"os"
	"os/exec"
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

	outcome, err := e.Cancel("id-1", "cc-1", 0)
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
	outcome, err := e.Cancel("nope", "cc-nope", 5)
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
	if _, err := e.Cancel("id-2", "cancel-cmd-7", 0); err != nil {
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

	outcome, err := e.Cancel("id-3", "cc-3", 5)
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

	if _, err := e.Cancel("id-5", "cc-5", 0); err != nil {
		t.Fatal(err)
	}
	<-done
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("graceSeconds=0 still delivered SIGTERM; the trap ran")
	}
}

func TestCancelBeforeRegistrationPreventsTheScriptFromStarting(t *testing.T) {
	// Execute validates, writes the script file and calls configureRunAs before
	// the process exists, and WebSocket commands are concurrent. This walks that
	// exact window deterministically: reserve (Execute's first action), a cancel,
	// then the beginStart gate Execute reaches once its setup is done.
	e := newTestExecutor()
	running, preCancelled, duplicate := e.reserve("id-4", time.Now(), ScriptTypeBash)
	if preCancelled || duplicate {
		t.Fatalf("a fresh id reported preCancelled=%v duplicate=%v", preCancelled, duplicate)
	}

	outcome, err := e.Cancel("id-4", "cc-4", 0)
	if err != nil {
		t.Fatal(err)
	}
	if outcome == CancelNotFound {
		t.Fatal("cancel raced Execute's setup and reported not_found")
	}
	// Nothing will ever run, so the only honest answer is a proven stop.
	if outcome != CancelTerminated {
		t.Fatalf("outcome = %q, want terminated for a process that can never start", outcome)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if running.beginStart(exec.CommandContext(ctx, "/bin/sh", "-c", "true"), cancel) {
		t.Fatal("script started despite a cancel that arrived first")
	}
}

func TestCancelReportsKillFailedWhenContainmentWasNeverEstablished(t *testing.T) {
	skipWithoutBash(t)
	// The fail-closed rule: on Windows an RDS session job can deny the Job
	// Object assignment, so the script runs but its children are not ours to
	// kill. A cancel must never claim `terminated` in that state, even when the
	// leader itself dies cleanly.
	e := newTestExecutor()
	done := make(chan *ScriptResult, 1)
	go func() { r, _ := e.Execute(sleepScript("id-6", 60)); done <- r }()
	r := waitForRunning(t, e, "id-6")

	r.mu.Lock()
	r.contained = false
	r.mu.Unlock()

	outcome, err := e.Cancel("id-6", "cc-6", 0)
	if err != nil {
		t.Fatal(err)
	}
	if outcome != CancelKillFailed {
		t.Fatalf("outcome = %q, want kill_failed for an uncontained execution", outcome)
	}
	<-done
}

func TestDuplicateExecuteCannotUnblockACancelOnTheOriginal(t *testing.T) {
	skipWithoutBash(t)
	// The server can redeliver a command id (the dedup window is 2 minutes but a
	// script may run for an hour). A second Execute must NOT adopt the first
	// one's reservation: it would close the shared done channel when IT
	// finished, unblocking a Cancel that is waiting on the ORIGINAL process and
	// letting it report `terminated` while that process is still running.
	e := newTestExecutor()
	first := make(chan *ScriptResult, 1)
	go func() { r, _ := e.Execute(sleepScript("dup-1", 60)); first <- r }()
	waitForRunning(t, e, "dup-1")

	dup, err := e.Execute(sleepScript("dup-1", 60))
	if err == nil {
		t.Fatal("a duplicate Execute for a running id was accepted")
	}
	if dup == nil || dup.ExitCode != -1 {
		t.Fatalf("duplicate result = %+v, want a failure result", dup)
	}

	// The original must still be running and still cancellable.
	select {
	case r := <-first:
		t.Fatalf("the duplicate terminated the original execution: %+v", r)
	default:
	}
	if outcome, cancelErr := e.Cancel("dup-1", "cc-dup", 0); cancelErr != nil || outcome != CancelTerminated {
		t.Fatalf("Cancel on the original = (%q, %v), want terminated", outcome, cancelErr)
	}
	<-first
}

func TestCancelStopsAScriptThatIsStillQueuedInTheWorkerPool(t *testing.T) {
	skipWithoutBash(t)
	// The bypass lane makes the CANCEL jump the pool, but the script it targets
	// can still be sitting in that queue behind another script — the pool floors
	// at 1 worker, so this is the ordinary case, not an edge. Execute has not run
	// yet, so the executor has never heard of the id. Answering a bare not_found
	// and forgetting would let that script start minutes later exactly as if no
	// cancel had ever been issued.
	e := newTestExecutor()

	outcome, err := e.Cancel("queued-1", "cc-q1", 0)
	if err != nil {
		t.Fatal(err)
	}
	// Honest: we cannot tell a queued script from an id this device never had,
	// so the ANSWER stays not_found. The refusal below carries the marker, which
	// is what closes the execution on the server.
	if outcome != CancelNotFound {
		t.Fatalf("outcome = %q, want not_found for an execution we have not seen", outcome)
	}

	// The pool frees up and the script is finally dispatched.
	res, err := e.Execute(sleepScript("queued-1", 60))
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if !res.Cancelled {
		t.Fatal("a script cancelled while queued ran anyway")
	}
	if res.ExitCode != -1 {
		t.Fatalf("ExitCode = %d, want -1 for a script that never ran", res.ExitCode)
	}
	if e.GetRunningCount() != 0 {
		t.Fatalf("running count = %d after the refusal, want 0", e.GetRunningCount())
	}
}

func TestARefusalRecordNamesTheCancelCommandAndIsNotReportedAsRunning(t *testing.T) {
	e := newTestExecutor()
	if _, err := e.Cancel("queued-2", "cc-queued", 0); err != nil {
		t.Fatal(err)
	}

	// script_list_running must not invent a phantom execution.
	if got := e.ListRunning(); len(got) != 0 {
		t.Fatalf("ListRunning reported a phantom execution: %v", got)
	}
	if got := e.GetRunningCount(); got != 0 {
		t.Fatalf("GetRunningCount = %d, want 0", got)
	}

	res, _ := e.Execute(sleepScript("queued-2", 60))
	if res.CancelledByCommandID != "cc-queued" {
		t.Fatalf("CancelledByCommandID = %q, want cc-queued", res.CancelledByCommandID)
	}
}

func TestARefusalRecordIsReapedSoItCannotBlockALaterExecutionForever(t *testing.T) {
	restore := cancelRefusalTTL
	cancelRefusalTTL = 50 * time.Millisecond
	t.Cleanup(func() { cancelRefusalTTL = restore })

	e := newTestExecutor()
	if _, err := e.Cancel("queued-3", "cc-q3", 0); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(5 * time.Second)
	for {
		e.mu.Lock()
		_, present := e.running["queued-3"]
		e.mu.Unlock()
		if !present {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the refusal record was never reaped; a command id could be blocked forever")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestClampGraceBoundsTheRequestedWindow(t *testing.T) {
	for _, tc := range []struct{ in, want int }{{-1, 0}, {0, 0}, {5, 5}, {30, 30}, {31, 30}, {9999, 30}} {
		if got := clampGrace(tc.in); got != tc.want {
			t.Errorf("clampGrace(%d) = %d, want %d", tc.in, got, tc.want)
		}
	}
}
