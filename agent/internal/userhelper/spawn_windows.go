//go:build windows

package userhelper

import (
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

// hideWindow prevents Windows from allocating a visible console window when the
// user-helper (built with -H windowsgui per agent/Makefile) spawns a
// console-subsystem child like winget.exe, powershell.exe or cmd.exe. Without
// CREATE_NO_WINDOW, the kernel attaches a fresh console to the child because
// the GUI-subsystem parent has none to inherit, which surfaces a "black box"
// on the interactive user desktop. Augments any existing SysProcAttr instead
// of replacing it.
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
