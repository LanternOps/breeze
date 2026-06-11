//go:build !windows

package main

import "context"

// startWatchdogSupervisor is a no-op on non-Windows platforms. The watchdog
// supervisor relies on the Windows Service Control Manager; macOS uses
// launchd KeepAlive and Linux uses systemd Restart=always, both of which
// already supervise the watchdog process at the OS level.
//
// This stub exists so startAgent can call startWatchdogSupervisor
// unconditionally without per-OS guards at the call site.
func startWatchdogSupervisor(ctx context.Context) <-chan struct{} {
	done := make(chan struct{})
	close(done)
	return done
}
