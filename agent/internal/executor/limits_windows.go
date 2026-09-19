//go:build windows

package executor

import (
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

// setProcessGroup is a no-op on Windows: process-tree containment is a Job
// Object, established at launch time by startContained/launchContained
// (job.go, job_windows.go) rather than by a SysProcAttr flag. #3525 replaced
// the previous "deferred to a future enhancement" no-op — a PowerShell script
// that started msiexec used to leave it running on both the cancel AND the
// timeout path.
func setProcessGroup(cmd *exec.Cmd) {}

// hideWindow prevents the spawned shell (powershell.exe, cmd.exe, etc.) from
// allocating a visible console window when the user-helper (linked
// -H windowsgui) executes a user-context script. Without CREATE_NO_WINDOW the
// kernel attaches a fresh console to console-subsystem children.
func hideWindow(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
	cmd.SysProcAttr.CreationFlags |= windows.CREATE_NO_WINDOW
}
