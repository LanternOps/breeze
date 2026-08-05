//go:build windows

package heartbeat

import (
	"os/exec"
	"syscall"
)

// createNoWindow suppresses the console window of the detached trampoline.
// The last thing a Quick Support session should do is flash a black cmd box
// on the end user's screen. Defined locally rather than pulling in
// x/sys/windows for one constant (same value as windows.CREATE_NO_WINDOW).
const createNoWindow = 0x08000000

// startSupportSelfDelete launches the detached self-delete trampoline:
//
//	cmd /C ping 127.0.0.1 -n 3 >NUL & del /f "<exe>"
//
// The ping is a dependency-free sleep (no PowerShell, no execution policy) —
// a running .exe cannot delete itself, so the trampoline has to outlive this
// process by a couple of seconds.
//
// SysProcAttr.CmdLine is set explicitly instead of passing the script as an
// argument to exec.Command. os/exec would run the script through
// syscall.EscapeArg, which wraps it in quotes and backslash-escapes the inner
// quotes around the path (`\"C:\...\x.exe\"`). cmd.exe does not understand
// backslash-escaped quotes, and its /C "strip the outer quotes" rule only
// applies when the line contains exactly two quote characters — with four it
// tries to execute the whole quoted script as a program name and fails. Any
// path containing a space (C:\Users\John Smith\Downloads\...) needs those
// inner quotes, so the escaped form is not an option: build the command line
// verbatim.
func startSupportSelfDelete(exePath string) error {
	cmd := exec.Command("cmd")
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP | createNoWindow,
		HideWindow:    true,
		CmdLine:       buildSupportSelfDeleteCmdLine(exePath),
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	_ = cmd.Process.Release()
	return nil
}
