//go:build !windows

package main

import (
	"context"

	"github.com/breeze-rmm/agent/internal/heartbeat"
)

// startETWLua is a no-op on non-Windows platforms. ETW only exists on
// Windows. The split mirrors startWatchdogSupervisor so main.go can call
// startETWLua unconditionally.
//
// Returns an already-closed channel so the cross-platform shutdown path
// in shutdownAgent (waiting on etwluaDone after etwluaCancel) is a no-op
// here.
func startETWLua(_ context.Context, _ *heartbeat.Heartbeat) <-chan struct{} {
	done := make(chan struct{})
	close(done)
	return done
}
