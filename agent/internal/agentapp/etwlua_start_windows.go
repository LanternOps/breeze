//go:build windows

package agentapp

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
	// The heartbeat always runs the PAM flow, even when the user-helper session
	// broker is absent (e.g. an interactive agent with no user-helper): the
	// request is already posted by then, and with no broker the device cannot
	// act on it, so RunPamFlow reports it unable and the server closes it
	// instead of leaving it approvable (#9517). Before #9517 a nil runner here
	// kept etwlua detection-only and the request sat pending until expiry.
	var pam etwlua.PamRunner = hb
	go func() {
		defer close(done)
		if err := etwlua.Start(ctx, sub, hb, pam); err != nil {
			log.Warn("etwlua Start returned error", "error", err.Error())
		}
	}()
	return done
}
