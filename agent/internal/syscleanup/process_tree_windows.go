//go:build windows

package syscleanup

import (
	"context"
	"fmt"
	"os/exec"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// windowsProcessTree owns one Job Object per cleaner run. Descendants of a job
// member join the job automatically, so terminating the job on a deadline
// reaches the real worker — which for cleanmgr.exe under the SYSTEM account is
// never the process we started.
//
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE is the kernel-enforced backstop the
// installer twin uses: the tree cannot outlive the agent if the agent dies
// mid-cleanup. The handle stays protected until drain confirms completion.
type windowsProcessTree struct {
	handle windows.Handle
}

func newProcessTree() processTree {
	handle, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		log.Warn("cleaner job object unavailable; a timeout will terminate the leader only",
			"error", err.Error())
		return &windowsProcessTree{}
	}
	if err := setJobKillOnClose(handle, true); err != nil {
		_ = windows.CloseHandle(handle)
		log.Warn("cleaner job object could not be configured; a timeout will terminate the leader only",
			"error", err.Error())
		return &windowsProcessTree{}
	}
	return &windowsProcessTree{handle: handle}
}

func setJobKillOnClose(handle windows.Handle, kill bool) error {
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

func (t *windowsProcessTree) prepare(*exec.Cmd) {}

func (t *windowsProcessTree) adopt(cmd *exec.Cmd) {
	if t.handle == 0 || cmd.Process == nil {
		return
	}
	// os/exec does not expose the child's handle, so it is reopened by pid.
	process, err := windows.OpenProcess(
		windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
	if err != nil {
		log.Warn("could not open cleaner process for job assignment; a timeout will terminate the leader only",
			"pid", cmd.Process.Pid, "error", err.Error())
		return
	}
	defer func() { _ = windows.CloseHandle(process) }()

	if err := windows.AssignProcessToJobObject(t.handle, process); err != nil {
		// A process already inside a job that forbids breakaway cannot join a
		// second one — the RDS constraint #2536 documents. Degrading costs the
		// tree kill; failing would cost the cleanup itself on every such host.
		log.Warn("cleaner not assigned to job object; a timeout will terminate the leader only",
			"pid", cmd.Process.Pid, "error", err.Error())
	}
}

func (t *windowsProcessTree) kill(*exec.Cmd) {
	if t.handle == 0 {
		return
	}
	if err := windows.TerminateJobObject(t.handle, 1); err != nil {
		log.Warn("failed to terminate cleaner job object after timeout", "error", err.Error())
	}
}

// jobBasicAccountingInformation mirrors JOBOBJECT_BASIC_ACCOUNTING_INFORMATION.
// x/sys exposes the information class but not this structure.
type jobBasicAccountingInformation struct {
	TotalUserTime             int64
	TotalKernelTime           int64
	ThisPeriodTotalUserTime   int64
	ThisPeriodTotalKernelTime int64
	TotalPageFaultCount       uint32
	TotalProcesses            uint32
	ActiveProcesses           uint32
	TotalTerminatedProcesses  uint32
}

func (t *windowsProcessTree) drain(ctx context.Context) error {
	if t.handle == 0 {
		return nil
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		if err := ctx.Err(); err != nil {
			t.kill(nil)
			return err
		}
		var info jobBasicAccountingInformation
		if err := windows.QueryInformationJobObject(t.handle, windows.JobObjectBasicAccountingInformation,
			uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)), nil); err != nil {
			t.kill(nil)
			return fmt.Errorf("query cleaner job accounting: %w", err)
		}
		if info.ActiveProcesses == 0 {
			return nil
		}
		select {
		case <-ctx.Done():
			t.kill(nil)
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

// Keep KILL_ON_JOB_CLOSE as a backstop if draining failed. A successfully
// drained job has no remaining workers to signal.
func (t *windowsProcessTree) release() {
	if t.handle == 0 {
		return
	}
	_ = windows.CloseHandle(t.handle)
	t.handle = 0
}
