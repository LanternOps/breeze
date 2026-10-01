package heartbeat

import (
	"time"

	"github.com/breeze-rmm/agent/internal/config"
)

// Retry bounds for a rotation owed because an older agent left the helper token
// in agent.yaml (see config.HelperTokenRotationOwed). The first attempt runs on
// the first successful heartbeat; failures back off so a persistently refused
// rotation (e.g. a draining tenant) costs one request per six hours at most.
const (
	owedRotationInitialBackoff = 5 * time.Minute
	owedRotationMaxBackoff     = 6 * time.Hour
)

// maybeStartOwedHelperTokenRotation reports whether the caller should start a
// credential rotation now to replace a helper token that was found in
// agent.yaml. The debt lives on disk until a promoted rotation clears it (any
// rotation, server- or agent-initiated), so a failed or skipped attempt is
// simply retried after the backoff, across restarts too.
//
// It never competes with rotation work already underway: while another
// rotation holds tokenRotating, or a staged rotation awaits confirmation (whose
// promotion settles the debt anyway), it defers without consuming an attempt.
func (h *Heartbeat) maybeStartOwedHelperTokenRotation(now time.Time) bool {
	if h.tokenRotating.Load() || h.pendingRotationOnDisk.Load() {
		return false
	}
	if !config.HelperTokenRotationOwed() {
		return false
	}
	h.owedRotationMu.Lock()
	defer h.owedRotationMu.Unlock()
	if now.Before(h.owedRotationNextAttempt) {
		return false
	}
	backoff := h.owedRotationBackoff
	if backoff <= 0 {
		backoff = owedRotationInitialBackoff
	}
	h.owedRotationNextAttempt = now.Add(backoff)
	h.owedRotationBackoff = min(backoff*2, owedRotationMaxBackoff)
	return true
}
