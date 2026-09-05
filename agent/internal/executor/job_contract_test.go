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

func TestReleaseContainmentClosesTheJobAfterTheScriptExits(t *testing.T) {
	// Leaving the handle open with KILL_ON_JOB_CLOSE set is the agent-crash
	// backstop while the script runs; leaving it open forever leaks a kernel
	// handle per execution.
	var order []string
	fake := &fakeJobPrimitives{order: &order}
	running := newFakeLaunch(t, fake)

	releaseContainment(running)
	if !fake.closed {
		t.Fatalf("job handle was never released: %v", order)
	}
}

func TestReleaseContainmentIsANoOpWithoutAJob(t *testing.T) {
	// The Unix path never attaches primitives; releaseContainment runs there
	// on every execution.
	releaseContainment(newRunningExecution(time.Now(), ScriptTypeBash))
}
