//go:build windows

package main

import (
	"context"

	"github.com/breeze-rmm/agent/internal/etwlua"
	"github.com/breeze-rmm/agent/internal/heartbeat"
	"github.com/breeze-rmm/agent/internal/privilege"
)

// startETWLua subscribes to Microsoft-Windows-LUA and POSTs uac_intercept
// elevation_requests via hb.SendElevationRequest. Non-fatal on init failure:
// the agent stays up, we just don't get UAC discovery events. Mirrors the
// startWatchdogSupervisor split pattern (watchdog_supervisor_other.go).
//
// Returns a channel that closes after the subscriber goroutine has exited
// (signalled via ctx.Done() cancellation in shutdownAgent). The channel
// closes immediately if init is skipped or fails — callers can range it
// for join semantics regardless of platform state.
//
// Privilege check runs BEFORE NewETWSubscriber so we never open the
// real-time ETW session for an unprivileged process. The previous order
// could leak both the session and the consumer goroutine when Start
// returned ErrNotPrivileged after NewETWSubscriber had already opened
// the session and spawned `go s.run()` (PR #959 review, blocker 2).
func startETWLua(ctx context.Context, hb *heartbeat.Heartbeat) <-chan struct{} {
	done := make(chan struct{})

	if !privilege.IsRunningAsRoot() {
		log.Info("etwlua disabled: agent not running as Administrator")
		close(done)
		return done
	}

	sub, err := etwlua.NewETWSubscriber()
	if err != nil {
		log.Warn("etwlua subscriber init failed; UAC discovery disabled", "error", err.Error())
		close(done)
		return done
	}
	go func() {
		defer close(done)
		if err := etwlua.Start(ctx, sub, hb); err != nil {
			log.Warn("etwlua Start returned error", "error", err.Error())
		}
	}()
	return done
}
