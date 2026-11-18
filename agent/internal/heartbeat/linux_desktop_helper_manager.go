package heartbeat

// Wiring of the Linux per-session desktop helper manager (#12117). It is
// constructed only on Linux with desktop_wayland_helper on; with the flag off
// nothing here runs and the agent behaves as before. In W2 nothing routes a
// desktop session to it yet.

import (
	"context"
	"runtime"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

func linuxDesktopHelperEnabled(goos string, cfg *config.Config) bool {
	return goos == "linux" && cfg != nil && cfg.DesktopWaylandHelper
}

// startLinuxDesktopHelperManager builds the manager and runs it until the
// agent stops. Called from Start after the broker is listening.
func (h *Heartbeat) startLinuxDesktopHelperManager() {
	if !linuxDesktopHelperEnabled(runtime.GOOS, h.config) || h.sessionBroker == nil {
		return
	}
	m, err := sessionbroker.NewLinuxDesktopHelperManagerForHost(h.sessionBroker, sessionbroker.LinuxDesktopHooks{
		OnHelperStopped: h.linuxDesktopHelperStopped,
	})
	if err != nil {
		log.Warn("Linux desktop helper manager unavailable", "error", err.Error())
		return
	}
	h.linuxDesktopHelpers.Store(m)
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		<-h.stopChan
		cancel()
	}()
	go m.Run(ctx)
	log.Info("Linux desktop helper manager started")
}

// linuxDesktopHelperStopped ends, for good, every desktop session a stopped
// Linux desktop helper owned: the session is fenced terminal so no start for
// it can land, its owner is forgotten so the helper can no longer renew its
// lease or relay for it, and the API is told it ended so the viewer side
// closes and its TURN credentials stop being renewed. It does not depend on
// the helper having stopped anything itself.
func (h *Heartbeat) linuxDesktopHelperStopped(s *sessionbroker.Session, reason string) {
	if s == nil {
		return
	}
	var owned []string
	h.desktopOwners.Range(func(key, value any) bool {
		id, okKey := key.(string)
		owner, okVal := value.(string)
		if okKey && okVal && owner == s.SessionID {
			owned = append(owned, id)
		}
		return true
	})
	for _, id := range owned {
		h.desktopStartFence.noteStop(id, desktopStopFenceInput{})
		h.forgetDesktopOwner(id)
		log.Info("ending desktop session hosted by a stopped Linux desktop helper",
			"sessionId", id, "helperSession", s.SessionID, "reason", reason)
		h.sendDesktopDisconnectNotification(id, "desktop helper stopped: "+reason)
	}
}
