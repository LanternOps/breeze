//go:build linux

package heartbeat

import (
	"errors"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors"
	"github.com/breeze-rmm/agent/internal/remote/desktop/x11"
)

// computeDesktopAccess probes the X display resolver and reports capture
// capability. mode is 'user_session' (capturable) or 'unavailable' with a
// typed reason. Never emits 'available' — the API zod mode enum has no .catch
// and would silently drop the whole object on deployed servers.
func (h *Heartbeat) computeDesktopAccess(_ *collectors.SystemInfo) *DesktopAccessState {
	now := time.Now().UTC()
	_, err := x11.SelectX11Target()
	if err == nil {
		return &DesktopAccessState{Mode: "user_session", CheckedAt: now}
	}

	reason := "x11_connect_failed"
	switch {
	case errors.Is(err, x11.ErrWaylandUnsupported):
		reason = "wayland_unsupported"
	case errors.Is(err, x11.ErrNoDisplay):
		reason = "no_display_session"
	}
	return &DesktopAccessState{Mode: "unavailable", Reason: reason, CheckedAt: now}
}
