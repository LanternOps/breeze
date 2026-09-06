package executor

import (
	"errors"
	"reflect"
	"testing"
	"time"
)

// fakeJobPrimitives records the Win32 call order so the containment sequence is
// asserted on EVERY platform, not only on the Windows CI job. That matters
// here: internal/heartbeat is on the Windows job's known-red exclusion list
// (#2523), so this contract deliberately lives in internal/executor and carries
// no build tag.
type fakeJobPrimitives struct {
	order      *[]string
	limitFlags uint32
	createErr  error
	jobErr     error
	limitErr   error
	clearErr   error
	assignErr  error
	resumeErr  error
	terminated bool
	closed     bool
}

func (f *fakeJobPrimitives) CreateProcessSuspended(spec launchSpec) (suspendedProcess, error) {
	*f.order = append(*f.order, "CreateProcess(CREATE_SUSPENDED|CREATE_NO_WINDOW)")
	if f.createErr != nil {
		return suspendedProcess{}, f.createErr
	}
	return suspendedProcess{pid: 4242}, nil
}

func (f *fakeJobPrimitives) CreateJob() (jobHandle, error) {
	*f.order = append(*f.order, "CreateJobObjectW")
	if f.jobErr != nil {
		return jobHandle{}, f.jobErr
	}
	return jobHandle{handle: 0xB0B}, nil
}

func (f *fakeJobPrimitives) SetJobLimits(job jobHandle, flags uint32) error {
	if flags == 0 {
		*f.order = append(*f.order, "SetInformationJobObject(clear)")
		f.limitFlags = flags
		return f.clearErr
	}
	*f.order = append(*f.order, "SetInformationJobObject(KILL_ON_JOB_CLOSE)")
	f.limitFlags = flags
	return f.limitErr
}

func (f *fakeJobPrimitives) AssignProcess(job jobHandle, process suspendedProcess) error {
	*f.order = append(*f.order, "AssignProcessToJobObject")
	return f.assignErr
}

func (f *fakeJobPrimitives) Resume(process suspendedProcess) error {
	*f.order = append(*f.order, "ResumeThread")
	return f.resumeErr
}

func (f *fakeJobPrimitives) TerminateJob(job jobHandle) error {
	*f.order = append(*f.order, "TerminateJobObject")
	f.terminated = true
	return nil
}

func (f *fakeJobPrimitives) CloseJob(job jobHandle) error {
	*f.order = append(*f.order, "CloseHandle(job)")
	f.closed = true
	return nil
}

func newFakeLaunch(t *testing.T, fake *fakeJobPrimitives) *runningExecution {
	t.Helper()
	running := newRunningExecution(time.Now(), ScriptTypePowerShell)
	if err := launchContained(fake, launchSpec{Path: "powershell.exe"}, running); err != nil {
		t.Fatalf("launchContained: %v", err)
	}
	return running
}

func contains(order []string, want string) bool {
	for _, entry := range order {
		if entry == want {
			return true
		}
	}
	return false
}

func last(order []string) string {
	if len(order) == 0 {
		return ""
	}
	return order[len(order)-1]
}

func TestScriptIsOwnedByANonEscapableJobBeforeResume(t *testing.T) {
	var order []string
	fake := &fakeJobPrimitives{order: &order}
	running := newFakeLaunch(t, fake)

	want := []string{
		"CreateProcess(CREATE_SUSPENDED|CREATE_NO_WINDOW)",
		"CreateJobObjectW",
		"SetInformationJobObject(KILL_ON_JOB_CLOSE)",
		"AssignProcessToJobObject",
		"ResumeThread",
	}
	if !reflect.DeepEqual(order, want) {
		t.Fatalf("order = %v, want %v", order, want)
	}
	if !running.isContained() {
		t.Fatal("contained = false after a successful assignment")
	}
	if fake.limitFlags != jobObjectLimitKillOnJobClose {
		t.Fatalf("limitFlags = %#x, want KILL_ON_JOB_CLOSE (%#x)", fake.limitFlags, jobObjectLimitKillOnJobClose)
	}
}

func TestAssignmentDenialFailsClosed(t *testing.T) {
	// On an RD Session Host the enclosing session job forbids joining a second
	// job and AssignProcessToJobObject is DENIED
	// (sessionbroker/spawner_windows.go). Following that precedent we still run
	// the script — refusing would break RDS entirely — but we mark it
	// uncontained so a later cancel can NEVER report `terminated`.
	var order []string
	fake := &fakeJobPrimitives{order: &order, assignErr: errors.New("access is denied")}
	running := newRunningExecution(time.Now(), ScriptTypePowerShell)
	if err := launchContained(fake, launchSpec{Path: "powershell.exe"}, running); err != nil {
		t.Fatalf("launch must degrade, not fail: %v", err)
	}
	if running.isContained() {
		t.Fatal("contained = true after a denied assignment")
	}
	if !contains(order, "ResumeThread") {
		t.Fatalf("the script was never resumed after a denied assignment: %v", order)
	}
}

func TestJobCreationFailureStillRunsTheScriptUncontained(t *testing.T) {
	var order []string
	fake := &fakeJobPrimitives{order: &order, jobErr: errors.New("no job objects available")}
	running := newRunningExecution(time.Now(), ScriptTypePowerShell)
	if err := launchContained(fake, launchSpec{Path: "powershell.exe"}, running); err != nil {
		t.Fatalf("launch must degrade, not fail: %v", err)
	}
	if running.isContained() {
		t.Fatal("contained = true after the job could not be created")
	}
	if contains(order, "AssignProcessToJobObject") {
		t.Fatalf("assigned to a job that was never created: %v", order)
	}
	if !contains(order, "ResumeThread") {
		t.Fatalf("the script was never resumed: %v", order)
	}
}

func TestResumeFailureIsFatal(t *testing.T) {
	// A suspended process that cannot be resumed would hang forever holding
	// the worker; that is the one step launchContained must not degrade past.
	var order []string
	fake := &fakeJobPrimitives{order: &order, resumeErr: errors.New("ResumeThread failed")}
	running := newRunningExecution(time.Now(), ScriptTypePowerShell)
	if err := launchContained(fake, launchSpec{Path: "powershell.exe"}, running); err == nil {
		t.Fatal("launchContained returned nil after ResumeThread failed")
	}
}

func TestTerminateJobObjectIsUsedForTheHardKill(t *testing.T) {
	var order []string
	fake := &fakeJobPrimitives{order: &order}
	running := newFakeLaunch(t, fake)

	if err := terminateProcessTreeWindows(running, 30); err != nil {
		t.Fatal(err)
	}
	// No graceful phase on Windows: GenerateConsoleCtrlEvent needs a shared
	// console and our children are CREATE_NO_WINDOW. graceSeconds is ignored.
	if last(order) != "TerminateJobObject" {
		t.Fatalf("order = %v", order)
	}
	if contains(order, "GenerateConsoleCtrlEvent") {
		t.Fatal("attempted a graceful phase on Windows")
	}
}

func TestReleaseContainmentClearsKillOnCloseBeforeClosingTheHandle(t *testing.T) {
	// This fires on EVERY successful script completion, not just on cancel.
	// Closing the handle with KILL_ON_JOB_CLOSE still set would kill exactly the
	// descendants a completed script legitimately left running (an installer, an
	// updater) — silently, fleet-wide, on green runs.
	var order []string
	fake := &fakeJobPrimitives{order: &order}
	running := newFakeLaunch(t, fake)
	order = order[:0]

	releaseContainment(running)

	want := []string{"SetInformationJobObject(clear)", "CloseHandle(job)"}
	if !reflect.DeepEqual(order, want) {
		t.Fatalf("order = %v, want %v", order, want)
	}
	if fake.limitFlags != 0 {
		t.Fatalf("limitFlags = %#x at close, want 0", fake.limitFlags)
	}
}

func TestReleaseContainmentLeaksTheHandleRatherThanKillDetachedChildren(t *testing.T) {
	// If the flag cannot be cleared, closing anyway would take the script's
	// detached children down. One leaked kernel handle is the cheaper failure.
	var order []string
	fake := &fakeJobPrimitives{order: &order, clearErr: errors.New("access denied")}
	running := newFakeLaunch(t, fake)

	releaseContainment(running)
	if fake.closed {
		t.Fatalf("closed a job whose kill-on-close could not be cleared: %v", order)
	}
}

func TestAFailedResumeTerminatesTheJobInsteadOfReleasingIt(t *testing.T) {
	// CreateProcess/CreateJob/SetJobLimits/AssignProcess all succeed and then
	// ResumeThread fails: the process exists, is contained and is suspended, and
	// cmd.Wait is never reached. Releasing containment here would clear
	// KILL_ON_JOB_CLOSE and drop the only handle that could ever kill it,
	// stranding a suspended process no later Cancel can find.
	var order []string
	fake := &fakeJobPrimitives{order: &order, resumeErr: errors.New("ResumeThread failed")}
	running := newRunningExecution(time.Now(), ScriptTypePowerShell)
	if err := launchContained(fake, launchSpec{Path: "powershell.exe"}, running); err == nil {
		t.Fatal("launchContained returned nil after ResumeThread failed")
	}
	order = order[:0]

	abortContainment(running)

	if !fake.terminated {
		t.Fatalf("the suspended process was left alive: %v", order)
	}
	if contains(order, "SetInformationJobObject(clear)") {
		t.Fatalf("cleared kill-on-close while aborting; the orphan would survive: %v", order)
	}
	if !fake.closed {
		t.Fatalf("the job handle was leaked after termination: %v", order)
	}
}

func TestTerminateFallsBackToTheLeaderWhenThereIsNoJob(t *testing.T) {
	// Job creation failed, so there is nothing to terminate. The fallback must
	// not panic on the nil command, and must not pretend it terminated a job.
	var order []string
	fake := &fakeJobPrimitives{order: &order, jobErr: errors.New("no job objects available")}
	running := newRunningExecution(time.Now(), ScriptTypePowerShell)
	if err := launchContained(fake, launchSpec{Path: "powershell.exe"}, running); err != nil {
		t.Fatal(err)
	}
	order = order[:0]

	if err := terminateProcessTreeWindows(running, 0); err != nil {
		t.Fatalf("uncontained terminate returned an error: %v", err)
	}
	if contains(order, "TerminateJobObject") {
		t.Fatalf("terminated a job that was never created: %v", order)
	}
	// releaseContainment must also be inert with no job.
	releaseContainment(running)
	if fake.closed {
		t.Fatal("closed a job that was never created")
	}
}

// gradeCancelOutcome is the fail-closed rule itself. The case it exists for —
// an RD Session Host denying the Job Object assignment — cannot be reproduced
// in any test, and the Unix process-based kill_failed test skips on Windows, so
// this table is the only coverage that executes on every platform.
func TestGradeCancelOutcomeIsFailClosed(t *testing.T) {
	boom := errors.New("kill failed")
	for _, tc := range []struct {
		name      string
		started   bool
		killErr   error
		contained bool
		want      CancelOutcome
	}{
		{"never started", false, nil, false, CancelTerminated},
		{"never started, stale kill error", false, boom, false, CancelTerminated},
		{"contained and killed cleanly", true, nil, true, CancelTerminated},
		{"contained but the kill errored", true, boom, true, CancelKillFailed},
		{"kill succeeded but containment was denied", true, nil, false, CancelKillFailed},
		{"uncontained and the kill errored", true, boom, false, CancelKillFailed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := gradeCancelOutcome(tc.started, tc.killErr, tc.contained); got != tc.want {
				t.Fatalf("gradeCancelOutcome(%v, %v, %v) = %q, want %q", tc.started, tc.killErr, tc.contained, got, tc.want)
			}
		})
	}
}

func TestCancelGivesUpAndReportsKillFailedWhenTerminationIsNeverObserved(t *testing.T) {
	// The give-up branch: a process wedged in uninterruptible I/O never closes
	// `done`. Every other kill_failed test reaches that verdict through
	// !contained, so without this the grace + backstop arithmetic is untested.
	restore := hardKillBackstop
	hardKillBackstop = 150 * time.Millisecond
	t.Cleanup(func() { hardKillBackstop = restore })

	e := newTestExecutor()
	running, preCancelled, duplicate := e.reserve("wedged", time.Now(), ScriptTypeBash)
	if preCancelled || duplicate {
		t.Fatalf("a fresh id reported preCancelled=%v duplicate=%v", preCancelled, duplicate)
	}
	// Look started, but never close done — release is never called.
	running.beginStart(nil, func() {})
	running.markStarted()
	running.attachProcessGroup(1)

	start := time.Now()
	outcome, err := e.Cancel("wedged", "cc-wedged", 0)
	if err != nil {
		t.Fatal(err)
	}
	if outcome != CancelKillFailed {
		t.Fatalf("outcome = %q, want kill_failed when termination is never observed", outcome)
	}
	if elapsed := time.Since(start); elapsed < 100*time.Millisecond {
		t.Fatalf("Cancel returned after %v — it did not actually wait out the backstop", elapsed)
	}
}

func TestReleaseContainmentIsANoOpWithoutAJob(t *testing.T) {
	// The Unix path never attaches primitives; releaseContainment runs there
	// on every execution.
	releaseContainment(newRunningExecution(time.Now(), ScriptTypeBash))
}
