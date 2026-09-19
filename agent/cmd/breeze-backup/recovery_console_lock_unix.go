//go:build !windows

package main

import (
	"errors"
	"syscall"
)

// processAlive reports whether pid is a live process on this host, probed
// via signal 0 — a no-op that delivers nothing and only checks
// existence/permission (same pattern as
// agent/internal/helper/stop_if_ours_posix_test.go and
// agent/internal/executor/tree_kill_unix.go). Used by
// acquireRecoveryConsoleLock to decide whether a lock file's recorded
// holder is stale. A var (not a plain func) so tests can substitute a fake
// without needing a real dead/alive PID on hand.
var processAlive = func(pid int) bool {
	if pid <= 0 {
		return false
	}
	switch err := syscall.Kill(pid, 0); {
	case err == nil:
		return true
	case errors.Is(err, syscall.ESRCH):
		return false
	default:
		// EPERM (process exists, owned by someone else) or anything else
		// unexpected: don't reclaim a lock we can't prove is dead.
		return true
	}
}
