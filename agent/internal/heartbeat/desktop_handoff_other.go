//go:build !darwin

package heartbeat

import "github.com/breeze-rmm/agent/internal/sessionbroker"

func (h *Heartbeat) startDarwinDesktopWatcher() {}

func (h *Heartbeat) handleHelperSessionClosed(session *sessionbroker.Session) {
	// A helper session that ends takes its SEC-038 fence seed with it: the
	// successor must be seeded again rather than inheriting the claim.
	if session != nil {
		h.forgetHelperFenceSync(session.SessionID)
	}
}
