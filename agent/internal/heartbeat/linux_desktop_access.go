package heartbeat

// Linux desktop access decision (#12117 W3), untagged so every host tests it.
// The X11 outcomes are exactly what computeDesktopAccess reported before. A
// Wayland session reports user_session only when the flag is on and a helper
// root lets capture is already bound to the active seat session; otherwise
// it keeps wayland_unsupported. The probe never spawns a helper.

import (
	"errors"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/desktop/x11"
)

// linuxDesktopAccessFromProbe maps x11.ProbeCapture's result to the access
// state. waylandHelperCanCapture is asked only for a Wayland session; nil
// means no helper can answer.
func linuxDesktopAccessFromProbe(err error, now time.Time, waylandHelperCanCapture func() bool) *DesktopAccessState {
	if err == nil {
		return &DesktopAccessState{Mode: "user_session", CheckedAt: now}
	}

	reason := "x11_connect_failed"
	switch {
	case errors.Is(err, x11.ErrWaylandUnsupported):
		if waylandHelperCanCapture != nil && waylandHelperCanCapture() {
			return &DesktopAccessState{Mode: "user_session", CheckedAt: now}
		}
		reason = "wayland_unsupported"
	case errors.Is(err, x11.ErrNoDisplay):
		reason = "no_display_session"
	case errors.Is(err, x11.ErrAuthFailed):
		reason = "x11_auth_failed"
	}
	return &DesktopAccessState{Mode: "unavailable", Reason: reason, CheckedAt: now}
}

// linuxWaylandHelperCanCapture reports whether the active seat session's
// desktop helper is connected and allowed to capture. Only an already bound
// helper counts: answering the heartbeat never starts one. With the flag off
// or no manager it returns false without asking logind.
func (h *Heartbeat) linuxWaylandHelperCanCapture() bool {
	ctrl, on := h.linuxDesktopWaylandHelperOn()
	if !on {
		return false
	}
	active, err := h.linuxActiveSeat()
	if err != nil {
		log.Debug("could not read the active seat session for desktop access", "error", err.Error())
		return false
	}
	if linuxDesktopRoute(true, active, true) != routeHelper {
		return false
	}
	return linuxCapableBoundHelper(ctrl, active.Session) != nil
}
