//go:build !windows

package main

import (
	"context"

	"github.com/breeze-rmm/agent/internal/heartbeat"
)

// startETWLua is a no-op on non-Windows platforms. ETW only exists on
// Windows. The split mirrors startWatchdogSupervisor so main.go can call
// startETWLua unconditionally.
func startETWLua(_ context.Context, _ *heartbeat.Heartbeat) {}
