//go:build windows

package tools

import (
	"log/slog"
	"os/exec"
	"unsafe"

	"golang.org/x/sys/windows"
)

// windowsInstallerProcessTree owns one Job Object per installer run. Descendants
// of a job member join the job automatically, so terminating the job on a
// timeout reaches the real setup process that the wrapper handed the work to.
//
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE is the same kernel-enforced backstop
// sessionbroker's helper job uses (helper_job_windows.go): it guarantees the
// tree cannot outlive the agent if the agent dies mid-install. It is cleared
// again before the handle is closed on every non-timeout path — see release.
type windowsInstallerProcessTree struct {
	handle windows.Handle
}

func newInstallerProcessTree() installerProcessTree {
	handle, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		slog.Warn("installer job object unavailable; a timeout will terminate the installer only",
			"error", err.Error())
		return &windowsInstallerProcessTree{}
	}
	if err := setInstallerJobKillOnClose(handle, true); err != nil {
		_ = windows.CloseHandle(handle)
		slog.Warn("installer job object could not be configured; a timeout will terminate the installer only",
			"error", err.Error())
		return &windowsInstallerProcessTree{}
	}
	return &windowsInstallerProcessTree{handle: handle}
}

func setInstallerJobKillOnClose(handle windows.Handle, kill bool) error {
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	if kill {
		info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	}
	_, err := windows.SetInformationJobObject(
		handle,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	)
	return err
}

func (t *windowsInstallerProcessTree) prepare(*exec.Cmd) {}

func (t *windowsInstallerProcessTree) adopt(cmd *exec.Cmd) {
	if t.handle == 0 || cmd.Process == nil {
		return
	}
	// os/exec does not expose the child's handle, so it is reopened by pid. The
	// process is running by the time we get here, so a descendant it spawned in
	// that window is outside the job; the wrapper itself is always in it, which
	// is what the timeout path needs.
	process, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
	if err != nil {
		slog.Warn("could not open installer process for job assignment; a timeout will terminate the installer only",
			"pid", cmd.Process.Pid, "error", err.Error())
		return
	}
	defer func() { _ = windows.CloseHandle(process) }()

	if err := windows.AssignProcessToJobObject(t.handle, process); err != nil {
		// A process already inside a job that forbids breakaway cannot join a
		// second one — the constraint sessionbroker's spawner hit on a real RDS
		// host (#2536). Degrading here costs the tree kill on timeout; failing
		// here would cost the install itself, on every such host.
		slog.Warn("installer not assigned to job object; a timeout will terminate the installer only",
			"pid", cmd.Process.Pid, "error", err.Error())
	}
}

func (t *windowsInstallerProcessTree) kill(cmd *exec.Cmd) {
	if t.handle == 0 {
		return
	}
	if err := windows.TerminateJobObject(t.handle, 1); err != nil {
		slog.Warn("failed to terminate installer job object after timeout", "error", err.Error())
	}
	_ = windows.CloseHandle(t.handle)
	t.handle = 0
}

func (t *windowsInstallerProcessTree) release() {
	if t.handle == 0 {
		return
	}
	// Clearing kill-on-close FIRST is what keeps a healthy wrapper install
	// alive: closing the handle with the flag still set would kill exactly the
	// descendants the wrapper legitimately left running, reintroducing the very
	// failure the WaitDelay work fixed. If the flag cannot be cleared, leak the
	// handle — one kernel handle on a path that should never occur — rather than
	// close it and take a good install down with it.
	if err := setInstallerJobKillOnClose(t.handle, false); err != nil {
		slog.Warn("installer job object kill-on-close could not be cleared; retaining the handle so in-flight descendants survive",
			"error", err.Error())
		t.handle = 0
		return
	}
	_ = windows.CloseHandle(t.handle)
	t.handle = 0
}
