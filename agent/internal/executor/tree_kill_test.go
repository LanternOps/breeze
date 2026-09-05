//go:build !windows

package executor

import (
	"fmt"
	"os"
	"testing"
	"time"
)

// grandchildHeartbeatScript backgrounds a subshell that keeps appending to
// beat. The subshell is a child of the script shell and `printf` under it is a
// grandchild, so the file only stops growing when the kill reaches the whole
// process GROUP rather than just the shell leader.
//
// Its stdio is redirected to /dev/null so a surviving background job cannot
// hold the captured stdout/stderr pipes open and make cmd.Wait look blocked for
// reasons unrelated to what this test measures.
func grandchildHeartbeatScript(id, beat string) ScriptExecution {
	s := sleepScript(id, 60)
	s.Script = fmt.Sprintf("(while true; do printf x >> %q; sleep 0.05; done) >/dev/null 2>&1 &\n", beat) + s.Script
	return s
}

func waitForNonEmptyFile(t *testing.T, path string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if info, err := os.Stat(path); err == nil && info.Size() > 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("heartbeat file %q never appeared", path)
}

func fileSize(t *testing.T, path string) int64 {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %q: %v", path, err)
	}
	return info.Size()
}

func TestCancelKillsTheWholeProcessTree(t *testing.T) {
	skipWithoutBash(t)
	beat := t.TempDir() + "/beat"
	e := newTestExecutor()
	go func() { _, _ = e.Execute(grandchildHeartbeatScript("id-t", beat)) }()
	waitForNonEmptyFile(t, beat)

	outcome, err := e.Cancel("id-t", 0)
	if err != nil {
		t.Fatal(err)
	}
	if outcome != CancelTerminated {
		t.Fatalf("outcome = %q, want terminated", outcome)
	}

	before := fileSize(t, beat)
	time.Sleep(500 * time.Millisecond)
	if after := fileSize(t, beat); after != before {
		t.Fatalf("grandchild survived the cancel: process-group kill did not reach it (%d -> %d bytes)", before, after)
	}
}

func TestPgidIsCapturedAtStartNotAtKillTime(t *testing.T) {
	skipWithoutBash(t)
	// After SIGTERM the leader may already be gone; a kill-time Getpgid then
	// fails and the fallback kills a dead leader while children keep running.
	e := newTestExecutor()
	go func() { _, _ = e.Execute(sleepScript("id-p", 60)) }()
	r := waitForRunning(t, e, "id-p")
	if r.processGroup() == 0 {
		t.Fatal("pgid was not captured at Start")
	}
	if _, err := e.Cancel("id-p", 0); err != nil {
		t.Fatal(err)
	}
}

// terminateProcessTreeUnix must not report failure when the group has already
// exited: os/exec folds a non-nil cancel error into cmd.Wait's return AND it
// becomes killErr, which would downgrade a clean kill to kill_failed.
func TestTerminateProcessTreeTreatsAnAlreadyGoneGroupAsSuccess(t *testing.T) {
	if err := terminateProcessTreeUnix(0, nil, 0); err != nil {
		t.Fatalf("no pgid and no process: %v", err)
	}
	// A pgid that cannot exist: PID 0 is the caller's own group, so use a large
	// unlikely one and accept only ESRCH-shaped absence.
	if err := terminateProcessTreeUnix(1<<21, nil, 0); err != nil {
		t.Fatalf("vanished group reported as an error: %v", err)
	}
	if err := terminateProcessTreeUnix(1<<21, nil, 1); err != nil {
		t.Fatalf("vanished group reported as an error during the graceful phase: %v", err)
	}
}
