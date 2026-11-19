//go:build linux

package heartbeat

import (
	"time"

	"github.com/breeze-rmm/agent/internal/collectors"
	"github.com/breeze-rmm/agent/internal/remote/desktop/x11"
)

// computeDesktopAccess runs an honest capability probe (real connect + auth via
// x11.ProbeCapture, not a mere resolve) and reports capture capability. mode is
// 'user_session' (capturable) or 'unavailable' with a typed reason. Never emits
// 'available' — the API zod mode enum has no .catch and would silently drop the
// whole object on deployed servers. The probe connects and closes once per call
// (~once/60s from the heartbeat), which is cheap enough to run uncached.
//
// A Wayland session stays wayland_unsupported unless desktop_wayland_helper
// is on and a capture-capable helper is already bound to it (#12117); see
// linuxDesktopAccessFromProbe.
func (h *Heartbeat) computeDesktopAccess(_ *collectors.SystemInfo) *DesktopAccessState {
	return linuxDesktopAccessFromProbe(x11.ProbeCapture(), time.Now().UTC(), h.linuxWaylandHelperCanCapture)
}
