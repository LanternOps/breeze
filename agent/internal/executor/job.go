package executor

import (
	"errors"
	"os/exec"
)

// This file carries the PORTABLE half of Windows Job Object containment
// (#3525, spec OD4-B): the primitive interface, the launch sequence and the
// hard-kill. It deliberately has no build tag so the call-order contract test
// (job_contract_test.go) runs in the Linux `test-agent` job too — the Windows
// CI job is a much thinner safety net (`internal/heartbeat` is on its known-red
// exclusion list, #2523, which is why this lives in internal/executor).
//
// The native syscalls live in job_windows.go; on every other platform the
// primitives are never constructed and containment is the process group
// instead (tree_kill_unix.go).

// jobObjectLimitKillOnJobClose is JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. With it
// set, closing the last handle to the job terminates every process still in it,
// so an agent crash cannot strand a script's children.
const jobObjectLimitKillOnJobClose uint32 = 0x00002000

// jobHandle is an opaque Windows Job Object handle. The zero value means "no
// job" — checked with valid().
type jobHandle struct {
	handle uintptr
	native any
}

func (j jobHandle) valid() bool { return j.handle != 0 || j.native != nil }

// suspendedProcess is a process created with CREATE_SUSPENDED that has not been
// resumed yet. It exists only between CreateProcessSuspended and Resume.
type suspendedProcess struct {
	pid    int
	cmd    *exec.Cmd
	native any
}

// launchSpec describes the process launchContained should create. Cmd carries
// the fully configured *exec.Cmd (env, dirs, pipes, CREATE_NO_WINDOW); Path is
// kept separately so the contract test can exercise the ordering without a real
// command.
type launchSpec struct {
	Path string
	Cmd  *exec.Cmd
}

// windowsJobPrimitives is the Win32 surface launchContained needs. Faked in
// job_contract_test.go, implemented natively in job_windows.go.
type windowsJobPrimitives interface {
	CreateProcessSuspended(spec launchSpec) (suspendedProcess, error)
	CreateJob() (jobHandle, error)
	SetJobLimits(job jobHandle, flags uint32) error
	AssignProcess(job jobHandle, process suspendedProcess) error
	Resume(process suspendedProcess) error
	TerminateJob(job jobHandle) error
	// SetJobLimits doubles as the clear: releaseContainment calls it with 0
	// before CloseJob, and that ORDER is the whole point (see releaseContainment).
	CloseJob(job jobHandle) error
}

// launchContained implements OD4-B: CREATE_SUSPENDED -> CreateJobObject ->
// KILL_ON_JOB_CLOSE -> AssignProcessToJobObject -> ResumeThread, recording the
// result on running.
//
// Assignment AFTER Start() cannot support a truthful `terminated`: the window
// covers the timeout path, cancellation, leader exit and child creation. And on
// an RD Session Host the enclosing session job forbids joining a second job, so
// AssignProcessToJobObject is denied outright
// (sessionbroker/spawner_windows.go). Following that precedent we still run the
// script — refusing would break RDS entirely — but leave contained=false so a
// later cancel can never claim the tree is gone.
//
// A Resume failure IS fatal: the process would sit suspended forever.
func launchContained(p windowsJobPrimitives, spec launchSpec, running *runningExecution) error {
	if p == nil {
		return errors.New("no Windows job primitives available")
	}

	process, err := p.CreateProcessSuspended(spec)
	if err != nil {
		return err
	}

	contained := false
	job, err := p.CreateJob()
	if err != nil {
		log.Warn("could not create job object for script containment; children may survive a cancel", "error", err.Error())
	} else if limitErr := p.SetJobLimits(job, jobObjectLimitKillOnJobClose); limitErr != nil {
		log.Warn("could not set job object limits for script containment", "error", limitErr.Error())
	} else if assignErr := p.AssignProcess(job, process); assignErr != nil {
		// Expected on RDS. Degrade, do not fail.
		log.Warn("job object assignment denied; script runs uncontained", "error", assignErr.Error())
	} else {
		contained = true
	}

	running.attachJob(p, job, process, contained)

	if err := p.Resume(process); err != nil {
		return err
	}
	return nil
}

// releaseContainment drops the Job Object once the script has exited. It is a
// no-op on Unix, where the process group needs no teardown.
//
// KILL_ON_JOB_CLOSE is cleared FIRST, and that order is the entire point:
// closing the handle with the flag still set would kill exactly the descendants
// a normally-completed script legitimately left running (an installer, an
// updater). This fires on EVERY successful completion, not only on cancel, so
// getting the order wrong would silently kill customer processes fleet-wide on
// green runs. Same precedent and same reasoning as
// remote/tools/software_install_process_tree_windows.go's release().
//
// If the flag cannot be cleared we LEAK the handle rather than close it — one
// kernel handle on a path that should never occur, versus taking those
// descendants down.
func releaseContainment(running *runningExecution) {
	primitives, job, _ := running.containment()
	if primitives == nil || !job.valid() {
		return
	}
	if err := primitives.SetJobLimits(job, 0); err != nil {
		log.Warn("could not clear job kill-on-close; retaining the handle so any detached children survive",
			"error", err.Error())
		return
	}
	if err := primitives.CloseJob(job); err != nil {
		log.Warn("could not release script job object", "error", err.Error())
	}
}

// abortContainment is releaseContainment's counterpart for a start that FAILED
// after the process already existed.
//
// The Windows case it exists for: CreateProcessSuspended, CreateJob,
// SetJobLimits and AssignProcess all succeed and then ResumeThread fails. The
// process is created, contained and suspended — it has not run an instruction
// and never will. releaseContainment would clear KILL_ON_JOB_CLOSE and drop the
// only handle that could ever kill it, stranding a suspended process that no
// later Cancel can find (Execute's release() has already forgotten the id).
// Terminate, then close with the flag intact.
func abortContainment(running *runningExecution) {
	primitives, job, cmd := running.containment()
	if primitives != nil && job.valid() {
		if err := primitives.TerminateJob(job); err != nil {
			log.Error("could not terminate the job object of a process that never started",
				"error", err.Error())
		}
		if err := primitives.CloseJob(job); err != nil {
			log.Warn("could not close the job object of a process that never started",
				"error", err.Error())
		}
		return
	}
	// Uncontained, or Unix (where a failed cmd.Start leaves no process at all).
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}

// terminateProcessTreeWindows is the hard kill for a contained script.
//
// There is no graceful phase on Windows: GenerateConsoleCtrlEvent needs a
// shared console and our children are launched CREATE_NO_WINDOW, so
// graceSeconds is deliberately ignored rather than silently waited out.
func terminateProcessTreeWindows(running *runningExecution, _ int) error {
	primitives, job, cmd := running.containment()
	if primitives != nil && job.valid() {
		return primitives.TerminateJob(job)
	}
	// Uncontained (assignment denied, or job creation failed): the best we can
	// do is kill the leader. contained is already false, so the caller will
	// report kill_failed rather than terminated.
	if cmd != nil && cmd.Process != nil {
		return cmd.Process.Kill()
	}
	return nil
}
