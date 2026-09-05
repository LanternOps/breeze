//go:build windows

package executor

import (
	"errors"
	"fmt"
	"os/exec"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// nativeWindowsJobPrimitives is the real Win32 implementation of
// windowsJobPrimitives. The launch ORDER and the degradation policy live in
// job.go so they are exercised by job_contract_test.go on every platform; only
// the syscalls are here.
//
// Precedent for each call: agent/internal/pamlifetime/job_windows.go and
// agent/internal/remote/tools/software_install_process_tree_windows.go.
type nativeWindowsJobPrimitives struct{}

// CreateProcessSuspended starts the command with CREATE_SUSPENDED so the job
// assignment can happen before a single instruction of the script runs.
// Assignment after Start() cannot support a truthful `terminated`: the window
// covers leader exit and child creation.
func (nativeWindowsJobPrimitives) CreateProcessSuspended(spec launchSpec) (suspendedProcess, error) {
	cmd := spec.Cmd
	if cmd == nil {
		return suspendedProcess{}, errors.New("no command to launch")
	}
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	// OR, never assign: hideWindow already set CREATE_NO_WINDOW and
	// overwriting it would pop a console window on every script run.
	cmd.SysProcAttr.CreationFlags |= windows.CREATE_SUSPENDED
	if err := cmd.Start(); err != nil {
		return suspendedProcess{}, err
	}
	return suspendedProcess{pid: cmd.Process.Pid, cmd: cmd}, nil
}

func (nativeWindowsJobPrimitives) CreateJob() (jobHandle, error) {
	handle, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return jobHandle{}, fmt.Errorf("CreateJobObject: %w", err)
	}
	return jobHandle{handle: uintptr(handle), native: handle}, nil
}

func (nativeWindowsJobPrimitives) SetJobLimits(job jobHandle, flags uint32) error {
	handle, err := nativeJobHandle(job)
	if err != nil {
		return err
	}
	return setJobLimitFlags(handle, flags)
}

func setJobLimitFlags(handle windows.Handle, flags uint32) error {
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = flags
	_, err := windows.SetInformationJobObject(
		handle,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	)
	return err
}

// AssignProcess reopens the child by pid — os/exec does not expose its handle —
// and joins it to the job. On an RD Session Host the enclosing session job
// forbids joining a second job and this is denied (#2536); job.go degrades
// rather than failing the script.
func (nativeWindowsJobPrimitives) AssignProcess(job jobHandle, process suspendedProcess) error {
	handle, err := nativeJobHandle(job)
	if err != nil {
		return err
	}
	proc, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(process.pid))
	if err != nil {
		return fmt.Errorf("OpenProcess: %w", err)
	}
	defer func() { _ = windows.CloseHandle(proc) }()
	if err := windows.AssignProcessToJobObject(handle, proc); err != nil {
		return fmt.Errorf("AssignProcessToJobObject: %w", err)
	}
	return nil
}

// Resume releases the suspended process. os/exec closes the primary thread
// handle it got from CreateProcess, so the thread is re-opened by enumerating
// the process's threads — a CREATE_SUSPENDED process has exactly one.
func (nativeWindowsJobPrimitives) Resume(process suspendedProcess) error {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPTHREAD, 0)
	if err != nil {
		return fmt.Errorf("CreateToolhelp32Snapshot: %w", err)
	}
	defer func() { _ = windows.CloseHandle(snapshot) }()

	var entry windows.ThreadEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	if err := windows.Thread32First(snapshot, &entry); err != nil {
		return fmt.Errorf("Thread32First: %w", err)
	}
	resumed := 0
	for {
		if entry.OwnerProcessID == uint32(process.pid) {
			thread, openErr := windows.OpenThread(windows.THREAD_SUSPEND_RESUME, false, entry.ThreadID)
			if openErr == nil {
				count, resumeErr := windows.ResumeThread(thread)
				_ = windows.CloseHandle(thread)
				if resumeErr == nil && count != 0xffffffff {
					resumed++
				}
			}
		}
		if err := windows.Thread32Next(snapshot, &entry); err != nil {
			break
		}
	}
	if resumed == 0 {
		return errors.New("ResumeThread: no thread of the suspended process could be resumed")
	}
	return nil
}

func (nativeWindowsJobPrimitives) TerminateJob(job jobHandle) error {
	handle, err := nativeJobHandle(job)
	if err != nil {
		return err
	}
	if err := windows.TerminateJobObject(handle, 1); err != nil {
		return fmt.Errorf("TerminateJobObject: %w", err)
	}
	return nil
}

// CloseJob is called once the script has exited. Clearing KILL_ON_JOB_CLOSE
// FIRST is what keeps a completed script's legitimately-detached children
// alive: closing the handle with the flag still set would kill exactly the
// descendants the script meant to leave running. If the flag cannot be cleared,
// leak the handle — one kernel handle on a path that should never occur —
// rather than close it and take those children down.
//
// On the cancel and timeout paths TerminateJobObject has already run, so this
// is a no-op beyond releasing the handle.
func (nativeWindowsJobPrimitives) CloseJob(job jobHandle) error {
	handle, err := nativeJobHandle(job)
	if err != nil {
		return err
	}
	if err := setJobLimitFlags(handle, 0); err != nil {
		return fmt.Errorf("clear job kill-on-close (handle retained): %w", err)
	}
	return windows.CloseHandle(handle)
}

func nativeJobHandle(job jobHandle) (windows.Handle, error) {
	if handle, ok := job.native.(windows.Handle); ok && handle != 0 {
		return handle, nil
	}
	if job.handle != 0 {
		return windows.Handle(job.handle), nil
	}
	return 0, errors.New("job object handle is not available")
}

// startContained runs the OD4-B launch sequence for a script.
func startContained(running *runningExecution, cmd *exec.Cmd) error {
	return launchContained(nativeWindowsJobPrimitives{}, launchSpec{Path: cmd.Path, Cmd: cmd}, running)
}

// terminateProcessTree kills the script's whole tree via its Job Object.
func terminateProcessTree(running *runningExecution, graceSeconds int) error {
	return terminateProcessTreeWindows(running, graceSeconds)
}
