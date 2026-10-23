//go:build !windows

package executor

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
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
	// Cancel as soon as the grandchild is alive — deliberately NOT after
	// waitForRunning, so this keeps probing the natural Start->attach race
	// that the window test below pins open on purpose.
	waitForNonEmptyFile(t, beat)
	e.mu.Lock()
	r := e.running["id-t"]
	e.mu.Unlock()
	if r == nil {
		t.Fatal("no running entry for id-t")
	}

	outcome, err := e.Cancel("id-t", "cc-t", 0)
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
	waitForGroupGone(t, r.processGroup()) // attached before done closed
}

// waitForGroupGone polls until no process is left in group pgid. It is the
// direct proof the heartbeat check approximates: kill(-pgid, 0) only returns
// ESRCH once every member, grandchildren included, has exited and been reaped.
func waitForGroupGone(t *testing.T, pgid int) {
	t.Helper()
	if pgid <= 0 {
		// kill(0, 0) would probe the TEST's own group and never report ESRCH.
		t.Fatalf("no process group captured (pgid=%d)", pgid)
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(-pgid, 0); errors.Is(err, syscall.ESRCH) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("process group %d still has members 10s after the cancel returned", pgid)
}

// waitForZombie polls until pid has exited but is not yet reaped. Only cmd.Wait
// reaps the script leader, so a zombie leader proves the cancel callback's kill
// has already run.
func waitForZombie(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		out, err := exec.Command("ps", "-o", "stat=", "-p", fmt.Sprint(pid)).Output()
		if err == nil && strings.HasPrefix(strings.TrimSpace(string(out)), "Z") {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("leader %d was never killed by the cancel callback", pid)
}

// #9815: os/exec starts its context watchdog INSIDE cmd.Start, so a cancel can
// fire cmd.Cancel after the process (and its own process group) exists but
// before startContained has attached the pgid. That kill used to reach the
// leader only: the backgrounded subshell kept running, and the cancel graded
// itself kill_failed. The seam holds that window open deterministically; in CI
// it was hit naturally under -race on a loaded macOS runner.
func TestCancelInTheWindowBeforePgidAttachStillKillsTheWholeTree(t *testing.T) {
	skipWithoutBash(t)
	beat := t.TempDir() + "/beat"

	started := make(chan int, 1)
	release := make(chan struct{})
	afterStartHook = func(cmd *exec.Cmd) {
		started <- cmd.Process.Pid
		<-release
	}
	t.Cleanup(func() { afterStartHook = nil })

	e := newTestExecutor()
	execDone := make(chan struct{})
	go func() {
		defer close(execDone)
		_, _ = e.Execute(grandchildHeartbeatScript("id-w", beat))
	}()

	var pid int
	select {
	case pid = <-started:
	case <-time.After(10 * time.Second):
		t.Fatal("process never started")
	}
	// Whatever the outcome, never leak a heartbeat loop past the test.
	t.Cleanup(func() { _ = syscall.Kill(-pid, syscall.SIGKILL) })
	waitForNonEmptyFile(t, beat) // the grandchild is alive inside the window

	type cancelResult struct {
		outcome CancelOutcome
		err     error
	}
	cancelled := make(chan cancelResult, 1)
	go func() {
		o, err := e.Cancel("id-w", "cc-w", 0)
		cancelled <- cancelResult{o, err}
	}()
	waitForZombie(t, pid) // the cancel callback has run while the pgid was unattached
	close(release)

	var res cancelResult
	select {
	case res = <-cancelled:
	case <-time.After(20 * time.Second):
		t.Fatal("cancel never returned")
	}
	<-execDone
	if res.err != nil {
		t.Fatal(res.err)
	}

	before := fileSize(t, beat)
	time.Sleep(500 * time.Millisecond)
	if after := fileSize(t, beat); after != before {
		t.Fatalf("grandchild survived a cancel that landed before the pgid was attached (%d -> %d bytes)", before, after)
	}
	waitForGroupGone(t, pid)
	if res.outcome != CancelTerminated {
		t.Fatalf("outcome = %q, want terminated", res.outcome)
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
	if _, err := e.Cancel("id-p", "cc-p", 0); err != nil {
		t.Fatal(err)
	}
}

func TestAKillBeforeThePgidWasCapturedCannotClaimContainment(t *testing.T) {
	// os/exec starts its context watchdog inside cmd.Start, so a cancel really
	// can fire in the window between Start returning and attachProcessGroup.
	// That kill reaches the leader only; if attachProcessGroup could then set
	// contained=true, the very cancel that already ran would grade `terminated`
	// while group members survived.
	r := newRunningExecution(time.Now(), ScriptTypeBash)

	if err := terminateProcessTree(r, 0); err != nil { // pgid still 0
		t.Fatalf("terminate with no pgid and no process: %v", err)
	}
	r.attachProcessGroup(4242) // the racing capture lands a moment later

	if r.isContained() {
		t.Fatal("containment was re-established after a leader-only kill had already run")
	}
	if got := gradeCancelOutcome(true, nil, r.isContained()); got != CancelKillFailed {
		t.Fatalf("outcome = %q, want kill_failed", got)
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

// ownProcessGroup must only ever name a group the command provably leads: a
// wrong pgid would either miss the tree or, worse, signal an unrelated group.
func TestOwnProcessGroupRequiresAStartedOwnGroupLeader(t *testing.T) {
	started := &os.Process{Pid: 4242}
	cases := []struct {
		name string
		cmd  *exec.Cmd
		want int
	}{
		{"nil command", nil, 0},
		{"not started", &exec.Cmd{SysProcAttr: &syscall.SysProcAttr{Setpgid: true}}, 0},
		{"no SysProcAttr", &exec.Cmd{Process: started}, 0},
		{"no Setpgid", &exec.Cmd{Process: started, SysProcAttr: &syscall.SysProcAttr{}}, 0},
		{"joins another group", &exec.Cmd{Process: started, SysProcAttr: &syscall.SysProcAttr{Setpgid: true, Pgid: 7}}, 0},
		{"leads its own group", &exec.Cmd{Process: started, SysProcAttr: &syscall.SysProcAttr{Setpgid: true}}, 4242},
	}
	for _, tc := range cases {
		if got := ownProcessGroup(tc.cmd); got != tc.want {
			t.Errorf("%s: ownProcessGroup = %d, want %d", tc.name, got, tc.want)
		}
	}

	// And the configuration Execute really uses must qualify.
	cmd := exec.Command("/bin/true")
	setProcessGroup(cmd)
	cmd.Process = started
	if got := ownProcessGroup(cmd); got != 4242 {
		t.Fatalf("setProcessGroup's configuration not recognised as group-leading: got %d", got)
	}
}
