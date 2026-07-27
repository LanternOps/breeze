//go:build windows

package main

import (
	"os"
	"syscall"

	"golang.org/x/sys/windows"
)

var procGetConsoleWindow = syscall.NewLazyDLL("kernel32.dll").NewProc("GetConsoleWindow")

// hasConsole reports whether the process has an attached console window.
// False when spawned by the agent service, which is the normal case: the
// agent hands the helper its own stdio (sessionbroker/backup.go) and under
// the SCM those handles are NUL. Mirrors agentapp.hasConsole, which is
// unexported.
func hasConsole() bool {
	ret, _, _ := procGetConsoleWindow.Call()
	return ret != 0
}

// redirectStderr points STD_ERROR_HANDLE at the log file so Go runtime panics
// (which write to fd 2) are captured instead of being silently lost to NUL.
// This is the difference between a crashed backup leaving a stack trace and
// leaving nothing at all.
func redirectStderr(f *os.File) {
	if err := windows.SetStdHandle(windows.STD_ERROR_HANDLE, windows.Handle(f.Fd())); err != nil {
		return
	}
	os.Stderr = f
}
