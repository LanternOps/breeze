package executor

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// BeforeLaunch is the #4609 restore-point boundary on the local executor: it
// must run only once every refusal path has passed, exactly once, before the
// process exists, and outside the script's own timeout.

func TestBeforeLaunchNotCalledWhenTheScriptTypeIsRejected(t *testing.T) {
	calls := 0
	_, _ = newTestExecutor().Execute(ScriptExecution{
		ID: "bl-type", ScriptType: "ruby", Script: "puts 1",
		BeforeLaunch: func() { calls++ },
	})
	if calls != 0 {
		t.Fatalf("BeforeLaunch calls = %d, want 0", calls)
	}
}

func TestBeforeLaunchNotCalledWhenValidationRejects(t *testing.T) {
	calls := 0
	_, err := newTestExecutor().Execute(ScriptExecution{
		ID: "bl-danger", ScriptType: ScriptTypeBash, Script: "rm -rf /",
		BeforeLaunch: func() { calls++ },
	})
	if err == nil {
		t.Fatal("expected a validation failure")
	}
	if calls != 0 {
		t.Fatalf("BeforeLaunch calls = %d, want 0", calls)
	}
}

func TestBeforeLaunchNotCalledForAScriptCancelledWhileQueued(t *testing.T) {
	e := newTestExecutor()
	if _, err := e.Cancel("bl-queued", "cancel-1", 0); err != nil {
		t.Fatal(err)
	}
	calls := 0
	res, _ := e.Execute(ScriptExecution{
		ID: "bl-queued", ScriptType: ScriptTypeBash, Script: "echo hi",
		BeforeLaunch: func() { calls++ },
	})
	if calls != 0 {
		t.Fatalf("BeforeLaunch calls = %d, want 0", calls)
	}
	if res == nil || !res.Cancelled {
		t.Fatalf("result = %+v, want the queued-cancel refusal", res)
	}
}

func TestDuplicateExecutionIsTypedAndNeverCallsBeforeLaunch(t *testing.T) {
	e := newTestExecutor()
	// Hold a reservation for the id, as a still-running execution would.
	running, _, _ := e.reserve("bl-dup", time.Now(), ScriptTypeBash)
	defer e.release("bl-dup", running)

	calls := 0
	res, err := e.Execute(ScriptExecution{
		ID: "bl-dup", ScriptType: ScriptTypeBash, Script: "echo hi",
		BeforeLaunch: func() { calls++ },
	})
	var dup *DuplicateExecutionError
	if !errors.As(err, &dup) || dup.ID != "bl-dup" {
		t.Fatalf("err = %v, want a *DuplicateExecutionError for bl-dup", err)
	}
	if err.Error() != "execution bl-dup is already running" || res == nil || res.Error != err.Error() {
		t.Fatalf("message changed: err %q, result %+v", err, res)
	}
	if calls != 0 {
		t.Fatalf("BeforeLaunch calls = %d, want 0", calls)
	}
}

func TestBeforeLaunchRunsOnceBeforeTheProcessStarts(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bash execution test runs on Unix")
	}
	marker := filepath.Join(t.TempDir(), "marker")
	calls := 0
	res, err := newTestExecutor().Execute(ScriptExecution{
		ID: "bl-order", ScriptType: ScriptTypeBash, Timeout: 30,
		Script: "cat " + marker,
		BeforeLaunch: func() {
			calls++
			if err := os.WriteFile(marker, []byte("checkpoint-first"), 0o600); err != nil {
				t.Errorf("write marker: %v", err)
			}
		},
	})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if calls != 1 {
		t.Fatalf("BeforeLaunch calls = %d, want 1", calls)
	}
	if res.ExitCode != 0 || !strings.Contains(res.Stdout, "checkpoint-first") {
		t.Fatalf("the script did not see the hook's effect (exit %d, stdout %q): the hook must finish before the process starts", res.ExitCode, res.Stdout)
	}
}

func TestBeforeLaunchDoesNotConsumeTheScriptTimeout(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bash execution test runs on Unix")
	}
	res, err := newTestExecutor().Execute(ScriptExecution{
		ID: "bl-timeout", ScriptType: ScriptTypeBash, Timeout: 1,
		Script:       "echo done",
		BeforeLaunch: func() { time.Sleep(1500 * time.Millisecond) },
	})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if strings.Contains(res.Error, "timed out") || res.ExitCode != 0 {
		t.Fatalf("result = %+v: a slow hook ate the script's own 1s timeout", res)
	}
}

func TestBeforeLaunchCancelDuringTheHookStopsTheLaunch(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bash execution test runs on Unix")
	}
	e := newTestExecutor()
	ran := filepath.Join(t.TempDir(), "ran")
	res, _ := e.Execute(ScriptExecution{
		ID: "bl-cancel", ScriptType: ScriptTypeBash, Timeout: 30,
		Script: "touch " + ran,
		BeforeLaunch: func() {
			if outcome, err := e.Cancel("bl-cancel", "cancel-2", 0); err != nil || outcome != CancelTerminated {
				t.Errorf("Cancel during setup = %v, %v; want terminated", outcome, err)
			}
		},
	})
	if res == nil || !res.Cancelled {
		t.Fatalf("result = %+v, want cancelled before execution started", res)
	}
	if _, err := os.Stat(ran); err == nil {
		t.Fatal("the script ran after a cancel landed during BeforeLaunch")
	}
}
