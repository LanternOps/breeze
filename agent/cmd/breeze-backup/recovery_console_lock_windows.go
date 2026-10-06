//go:build windows

package main

// processAlive is a conservative stub on Windows. The WinPE console takes
// no cross-instance lock (D7-NOLOCK — recovery_console_host_windows.go
// leaves consoleHost.AcquireLock nil), so acquireRecoveryConsoleLock is
// unreachable in production on this platform; it stays compiled (and this
// stub with it) because the lock code and its untagged tests are shared.
// Always reporting "alive" means acquireRecoveryConsoleLock never reclaims
// a lock here, which is the conservative direction if this were ever
// somehow reached.
var processAlive = func(pid int) bool {
	return true
}
