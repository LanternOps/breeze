package heartbeat

import (
	"runtime"

	"github.com/breeze-rmm/agent/internal/helper"
)

// helperSessionLocale is the per-session UI locale source for the Helper
// config (OD1). On Windows it asks the session broker for the UI language the
// user-context helper reported in that session. The SYSTEM agent's own
// language is the machine's, so it is never used here. Other platforms return
// "" until their structured source is wired; the Helper then keeps its OS
// language. It is read at call time because the broker is created after the
// Helper manager.
func (h *Heartbeat) helperSessionLocale(si helper.SessionInfo) string {
	if runtime.GOOS == "windows" && h.sessionBroker != nil {
		return h.sessionBroker.UILocaleInWinSession(si.Key)
	}
	return ""
}
