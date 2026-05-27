//go:build windows

package main

import (
	"context"

	"github.com/breeze-rmm/agent/internal/etwlua"
	"github.com/breeze-rmm/agent/internal/heartbeat"
)

// startETWLua subscribes to Microsoft-Windows-LUA and POSTs uac_intercept
// elevation_requests via hb.SendElevationRequest. Non-fatal on init failure:
// the agent stays up, we just don't get UAC discovery events. Mirrors the
// startWatchdogSupervisor split pattern (watchdog_supervisor_other.go).
func startETWLua(ctx context.Context, hb *heartbeat.Heartbeat) {
	sub, err := etwlua.NewETWSubscriber()
	if err != nil {
		log.Warn("etwlua subscriber init failed; UAC discovery disabled", "error", err.Error())
		return
	}
	go func() {
		if err := etwlua.Start(ctx, sub, hb); err != nil {
			log.Warn("etwlua Start returned error", "error", err.Error())
		}
	}()
}
