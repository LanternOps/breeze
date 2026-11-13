//go:build linux

package heartbeat

import (
	"errors"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors"
	"github.com/breeze-rmm/agent/internal/remote/desktop/wayland"
	"github.com/breeze-rmm/agent/internal/remote/desktop/x11"
)

// computeDesktopAccess runs an honest capability probe (real connect + auth via
// x11.ProbeCapture, not a mere resolve) and reports capture capability. mode is
// 'user_session' (capturable) or 'unavailable' with a typed reason. Never emits
// 'available' — the API zod mode enum has no .catch and would silently drop the
// whole object on deployed servers. The probe connects and closes once per call
// (~once/60s from the heartbeat), which is cheap enough to run uncached.
func (h *Heartbeat) computeDesktopAccess(_ *collectors.SystemInfo) *DesktopAccessState {
	now := time.Now().UTC()
	// Wayland is capturable through the portal once the user is logged in.
	// Do not call Start here: that is what shows the share dialog. Connect
	// does that. Reporting user_session is what enables the button. Falling
	// through to the X11 probe would mark this machine wayland_unsupported
	// even though XWayland sockets exist.
	if wayland.IsGraphical() {
		return &DesktopAccessState{Mode: "user_session", CheckedAt: now}
	}
	err := x11.ProbeCapture()
	if err == nil {
		return &DesktopAccessState{Mode: "user_session", CheckedAt: now}
	}

	reason := "x11_connect_failed"
	switch {
	case errors.Is(err, x11.ErrWaylandUnsupported):
		reason = "wayland_unsupported"
	case errors.Is(err, x11.ErrNoDisplay):
		reason = "no_display_session"
	case errors.Is(err, x11.ErrAuthFailed):
		reason = "x11_auth_failed"
	}
	return &DesktopAccessState{Mode: "unavailable", Reason: reason, CheckedAt: now}
}
