//go:build windows

package main

// processAlive is a conservative stub on Windows: recovery-console only
// ever runs on the Linux recovery media (Console.Run refuses to proceed
// without breeze.media=1 on the kernel cmdline), so this path is
// unreachable in production on this platform — this file exists purely so
// `breeze-backup` still cross-compiles for Windows. Always reporting
// "alive" means acquireRecoveryConsoleLock never reclaims a lock here,
// which is the conservative direction if this were ever somehow reached.
var processAlive = func(pid int) bool {
	return true
}
