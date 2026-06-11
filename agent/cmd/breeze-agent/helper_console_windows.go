//go:build windows

package main

import "syscall"

var procFreeConsole = syscall.NewLazyDLL("kernel32.dll").NewProc("FreeConsole")

// detachHelperConsole detaches the current process from its inherited console.
// The user-helper binary shipped with the MSI is built with -H windowsgui so
// the kernel never allocates a console to begin with — this call is then a
// no-op. The defense-in-depth value kicks in when the legacy console-subsystem
// breeze-agent.exe is invoked with the `user-helper` subcommand (e.g. manual
// CLI usage, or a partially-upgraded install where the new MSI hasn't repointed
// the scheduled task yet): in that path FreeConsole closes the inherited
// console immediately so any visible window collapses within milliseconds of
// process start. FreeConsole on a process without a console is a documented
// no-op, so calling it unconditionally is safe.
//
// FreeConsole's return value is captured so that a failure on the legacy CUI
// fallback path (where success is load-bearing for the no-flash promise) is
// at least observable in logs. A non-zero r1 means success; r1 == 0 means
// the call failed and errno is in e1. We deliberately do not return an error
// because there's no remediation path — but the Warn gives ops a signal if
// every fleet device suddenly starts flashing windows.
func detachHelperConsole() {
	r1, _, e1 := procFreeConsole.Call()
	if r1 == 0 {
		log.Warn("FreeConsole() failed on user-helper entry — inherited console may remain attached",
			"errno", e1.Error(),
		)
	}
}
